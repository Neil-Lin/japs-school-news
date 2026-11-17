import {prepareSchoolData, hydrateSchoolData, validateSchoolData, schoolName} from './school-data.mjs';

// Versioned, coherent snapshots: metadata can change without redownloading article bodies.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export async function digest(value) {
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function snapshotCacheName(baseURL, format = 2) {
  return 'school-news:' + new URL('./', baseURL).pathname + ':snapshot-v' + format;
}

async function verify(config, data, version) {
  if (!config || !Array.isArray(config.schools) || !Array.isArray(config.sources)
    || !config.categoryIds || !data || !Array.isArray(data.articles)) throw new Error('資料格式不完整');
  if (data.articles.some(article => !article || typeof article.title !== 'string'
    || !Array.isArray(article.schools) || !config.categoryIds[article.source])) throw new Error('公告與設定不相容');
  if (version.schemaVersion === 2) {
    if (data.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(version.dataVersion || '')
      || !/^[a-f0-9]{64}$/.test(version.configVersion || '')
      || !Array.isArray(version.sourceStatus) || !Array.isArray(version.errors)
      || !Number.isFinite(Date.parse(version.updatedAt))) throw new Error('版本格式無效');
    const [articlesHash, configHash] = await Promise.all([digest(data.articles), digest(config)]);
    if (articlesHash !== version.dataVersion || configHash !== version.configVersion) throw new Error('資料版本不一致');
  } else if (version.schemaVersion !== undefined || !version.updatedAt || data.updatedAt !== version.updatedAt) {
    throw new Error('資料版本不一致');
  }
}

function combine(config, data, version) {
  const metadata = version.schemaVersion === 2 ? {
    schemaVersion: version.schemaVersion,
    updatedAt: version.updatedAt,
    lastSuccessfulAt: version.lastSuccessfulAt,
    sourceStatus: version.sourceStatus,
    errors: version.errors,
  } : {};
  return {config, data: {...data, ...metadata}};
}

async function loadArchiveSnapshot({
  baseURL, fetcher = fetch, storage = globalThis.caches, timeoutMs = 8000,
  now = () => new Date().toISOString(),
} = {}) {
  const root = new URL('./', baseURL);
  const snapshotKey = new URL('data/offline-snapshot', root).href;
  let cache;
  let saved;
  try {
    cache = await storage?.open(snapshotCacheName(root.href));
    const response = await cache?.match(snapshotKey);
    if (response) {
      const candidate = await response.json();
      await verify(candidate.config, candidate.data, candidate.version);
      saved = candidate;
    }
  } catch {
    // Storage may be denied, full, or contain a corrupt entry. Online reads still work.
  }

  async function fetchJSON(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(new URL(path, root).href, {cache: 'no-cache', signal: controller.signal});
      if (!response.ok) throw new Error('資料請求失敗（' + response.status + '）');
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  let failure;
  // Retry once for a manifest/body race during deployment, never retry indefinitely.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const version = await fetchJSON('data/version.json');
      const modern = version.schemaVersion === 2;
      const sameData = saved && modern && saved.version.schemaVersion === 2 && version.dataVersion === saved.version.dataVersion;
      const sameConfig = saved && modern && saved.version.schemaVersion === 2 && version.configVersion === saved.version.configVersion;
      const [config, data] = await Promise.all([
        sameConfig ? saved.config : fetchJSON('config.json' + (modern ? '?v=' + encodeURIComponent(version.configVersion || '') : '')),
        sameData ? saved.data : fetchJSON('data/articles.json?v=' + encodeURIComponent(version.dataVersion || version.updatedAt || '')),
      ]);
      await verify(config, data, version);
      const bundle = {...combine(config, data, version), version, savedAt: now()};
      let cacheAvailable = false;
      if (cache) {
        try {
          // One key, one complete bundle. A failed write leaves the previous snapshot intact.
          await cache.put(snapshotKey, new Response(JSON.stringify(bundle), {headers: {'Content-Type': 'application/json'}}));
          cacheAvailable = true;
        } catch {
          // A quota failure must not turn a valid online response into a loading failure.
        }
      }
      return {...combine(config, data, version), mode: 'network', cacheAvailable, savedAt: bundle.savedAt};
    } catch (error) {
      failure = error;
      // Network failures already have a fallback; reserve the retry for version races.
      if (error.name === 'AbortError' || !String(error.message).includes('版本')) break;
    }
  }
  if (saved) {
    return {...combine(saved.config, saved.data, saved.version), mode: 'cached', cacheAvailable: true,
      savedAt: saved.savedAt, failure: failure?.message || '連線失敗'};
  }
  throw failure || new Error('沒有可用的離線資料');
}

function schoolEntry(version, slug) {
  const entry = version.schools?.[slug];
  if (version.schemaVersion !== 2 || version.schoolDataSchemaVersion !== 1 || !entry
    || entry.path !== `data/schools/${slug}.json` || !/^[a-f0-9]{64}$/.test(entry.dataVersion || '')
    || !Number.isSafeInteger(entry.articleCount) || entry.articleCount < 0) throw new Error('分校版本資料不完整');
  return entry;
}

async function verifySchool(bundle, slug) {
  const {config, data, version} = bundle;
  const entry = schoolEntry(version, slug);
  if (bundle.schoolSlug !== slug || entry.school !== schoolName(config, slug)
    || entry.articleCount !== data.articles?.length || !Number.isFinite(Date.parse(version.updatedAt))) throw new Error('分校版本不一致');
  validateSchoolData(config, data, slug);
  const [bodyHash, configHash] = await Promise.all([digest(data.articles), digest(config)]);
  if (entry.dataVersion !== bodyHash || version.configVersion !== configHash) throw new Error('分校資料版本不一致');
}

async function derivedVersion(config, wire, sourceVersion, raw) {
  const metadata = combine(config, raw, sourceVersion).data;
  const slug = config.schoolMeta[wire.school].slug;
  return {
    ...sourceVersion, schemaVersion: 2,
    dataVersion: sourceVersion.dataVersion || await digest(raw.articles),
    configVersion: sourceVersion.configVersion || await digest(config),
    updatedAt: metadata.updatedAt, lastSuccessfulAt: metadata.lastSuccessfulAt || metadata.updatedAt,
    sourceStatus: metadata.sourceStatus || [], errors: metadata.errors || [],
    schoolDataSchemaVersion: 1,
    schools: {[slug]: {school: wire.school, path: `data/schools/${slug}.json`, dataVersion: await digest(wire.articles), articleCount: wire.articles.length}},
  };
}

async function loadSchoolSnapshot({baseURL, schoolSlug: slug, fetcher = fetch, storage = globalThis.caches,
  timeoutMs = 8000, now = () => new Date().toISOString()}) {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw new Error('學校識別碼無效');
  const root = new URL('./', baseURL);
  const keyFor = name => new URL('data/offline-snapshot/' + name, root).href;
  let cache;
  let saved;
  let derived = false;
  try {
    cache = await storage?.open(snapshotCacheName(root.href, 3));
    const response = await cache?.match(keyFor(slug));
    if (response) {
      const candidate = await response.json();
      await verifySchool(candidate, slug);
      saved = candidate;
    }
  } catch {
    // Ignore corrupt/denied storage, then try the legacy bundle or the network.
  }
  if (!saved && storage) {
    try {
      const names = await storage.keys();
      if (names.includes(snapshotCacheName(root.href))) {
        const old = await storage.open(snapshotCacheName(root.href));
        const response = await old.match(new URL('data/offline-snapshot', root).href);
        if (response) {
          const legacy = await response.json();
          await verify(legacy.config, legacy.data, legacy.version);
          const data = prepareSchoolData(legacy.config, legacy.data.articles, slug);
          const candidate = {config: legacy.config, data, schoolSlug: slug, savedAt: legacy.savedAt,
            version: await derivedVersion(legacy.config, data, legacy.version, legacy.data)};
          await verifySchool(candidate, slug);
          saved = candidate;
          derived = true;
        }
      }
    } catch {
      // An unreadable legacy cache is never used as a substitute for verified data.
    }
  }

  async function persist(bundle) {
    if (!cache) return false;
    try {
      await cache.put(keyFor(slug), new Response(JSON.stringify(bundle), {headers: {'Content-Type': 'application/json'}}));
    } catch {
      return false;
    }
    try {
      const slugs = Object.values(bundle.config.schoolMeta).map(meta => meta.slug);
      const allowed = new Set(slugs.map(keyFor));
      for (const request of await cache.keys()) if (!allowed.has(request.url)) await cache.delete(request);
      // Keep the old full bundle until every school's replacement is verified and saved.
      if ((await storage.keys()).includes(snapshotCacheName(root.href))) {
        for (const name of slugs) {
          const response = await cache.match(keyFor(name));
          if (!response) return true;
          await verifySchool(await response.json(), name);
        }
        await storage.delete(snapshotCacheName(root.href));
      }
    } catch {
      // Cleanup failure does not invalidate the newly saved coherent snapshot.
    }
    return true;
  }

  async function fetchJSON(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(new URL(path, root).href, {cache: 'no-cache', signal: controller.signal});
      if (!response.ok) throw new Error('資料請求失敗（' + response.status + '）');
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  let failure;
  let latestConfig;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let version = await fetchJSON('data/version.json');
      const config = saved && version.configVersion === saved.version.configVersion
        ? saved.config : await fetchJSON('config.json' + (version.configVersion ? '?v=' + encodeURIComponent(version.configVersion) : ''));
      if (version.configVersion && await digest(config) !== version.configVersion) throw new Error('設定版本不一致');
      latestConfig = config;
      let data;
      if (version.schoolDataSchemaVersion !== undefined) {
        const entry = schoolEntry(version, slug);
        const reusable = saved && saved.version.schools?.[slug]?.dataVersion === entry.dataVersion;
        data = reusable ? saved.data : await fetchJSON(entry.path + '?v=' + entry.dataVersion);
      } else {
        // A new app can still read old publications while an upgrade is rolling out.
        const reusable = saved && version.dataVersion && version.dataVersion === saved.version.dataVersion;
        if (reusable) {
          data = saved.data;
          version = await derivedVersion(config, data, version, saved.data);
        } else {
          const raw = await fetchJSON('data/articles.json?v=' + encodeURIComponent(version.dataVersion || version.updatedAt || ''));
          await verify(config, raw, version);
          data = prepareSchoolData(config, raw.articles, slug);
          version = await derivedVersion(config, data, version, raw);
        }
      }
      const bundle = {config, data, version, schoolSlug: slug, savedAt: now()};
      await verifySchool(bundle, slug);
      const cacheAvailable = await persist(bundle);
      return {config, data: hydrateSchoolData(config, data, version), schoolSlug: slug,
        mode: 'network', cacheAvailable, savedAt: bundle.savedAt};
    } catch (error) {
      failure = error;
      if (error.name === 'AbortError' || !String(error.message).includes('版本')) break;
    }
  }
  if (saved) {
    if (derived) await persist(saved);
    return {config: saved.config, data: hydrateSchoolData(saved.config, saved.data, saved.version), schoolSlug: slug,
      mode: 'cached', cacheAvailable: true, savedAt: saved.savedAt, failure: failure?.message};
  }
  if (!latestConfig && cache) {
    try {
      for (const request of await cache.keys()) {
        try {
          const response = await cache.match(request);
          const candidate = await response.json();
          await verifySchool(candidate, candidate.schoolSlug);
          latestConfig = candidate.config;
          break;
        } catch {
          // A corrupt school's entry must not hide navigation from another valid entry.
        }
      }
    } catch {
      // No valid configuration is available for navigation.
    }
  }
  const error = new Error('暫時無法載入此校公告，且尚無可用的本校離線資料。請連線後重試。');
  error.code = 'school-data-unavailable';
  error.config = latestConfig;
  error.schoolSlug = slug;
  error.cause = failure;
  throw error;
}

export async function loadSnapshot(options = {}) {
  return options.schoolSlug === undefined ? loadArchiveSnapshot(options) : loadSchoolSnapshot(options);
}
