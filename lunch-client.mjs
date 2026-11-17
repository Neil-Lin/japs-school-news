// Lunch data is loaded independently of announcements, only when requested.
const OFFICIAL = 'https://fatraceschool.k12ea.gov.tw';
const complete = new Set(['available', 'no-record']);
const attempts = new Set([...complete, 'partial', 'error']);
const isText = value => value == null || (typeof value === 'string' && value.length <= 2000);
const hasText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
const id = value => typeof value === 'string' && /^[0-9]{1,100}$/.test(value);
const stamp = value => typeof value === 'string' && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const optionalStamp = value => value == null || stamp(value);

function require(value, message = '午餐資料格式不完整') {
  if (!value) throw new Error(message);
}

export function validMealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(value + 'T12:00:00Z');
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

export function taipeiDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function lunchSourceURL(schoolId, day) {
  require(id(schoolId) && validMealDate(day));
  return `${OFFICIAL}/frontend/search.html?school=${schoolId}&period=${day}`;
}

export function lunchCacheName(baseURL) {
  return 'school-news:' + new URL('./', baseURL).pathname + ':lunch-v1';
}

export async function lunchHash(raw) {
  const bytes = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function versionError() {
  const error = new Error('午餐資料版本不一致');
  error.code = 'lunch-version';
  return error;
}

function selectedStatus(manifest, slug, schoolId) {
  require(manifest?.schemaVersion === 1 && validMealDate(manifest.requestedDate) && stamp(manifest.checkedAt));
  const entry = manifest.schools?.[slug];
  require(entry && entry.schoolId === schoolId && attempts.has(entry.status) && Array.isArray(entry.errors) && entry.errors.length <= 2100);
  require(Boolean(entry.errors.length) === ['partial', 'error'].includes(entry.status));
  for (const error of entry.errors) {
    require(error && ['meal', 'dish', 'ingredient'].includes(error.scope) && hasText(error.code) && hasText(error.message));
    for (const key of ['batchId', 'dishId', 'providerName', 'dishName']) require(isText(error[key]));
  }
  const ref = entry.snapshot;
  if (ref == null) {
    require(!complete.has(entry.status) && entry.lastSuccessAt == null);
  } else {
    require(ref.path === `${slug}.json` && /^[a-f0-9]{64}$/.test(ref.sha256) && validMealDate(ref.mealDate)
      && ref.mealDate <= manifest.requestedDate && stamp(ref.fetchedAt) && ref.fetchedAt === entry.lastSuccessAt
      && Date.parse(ref.fetchedAt) <= Date.parse(manifest.checkedAt) && complete.has(ref.status));
    if (complete.has(entry.status)) require(entry.status === ref.status && ref.mealDate === manifest.requestedDate && ref.fetchedAt === manifest.checkedAt);
  }
  // Cache only the selected school's status, never another school's body.
  return {schemaVersion: 1, requestedDate: manifest.requestedDate, checkedAt: manifest.checkedAt, schools: {[slug]: entry}};
}

export async function verifyLunch(manifest, raw, slug, schoolId) {
  const selected = selectedStatus(manifest, slug, schoolId);
  const ref = selected.schools[slug].snapshot;
  if (!ref) {
    require(raw == null);
    return {manifest: selected, snapshot: null};
  }
  require(typeof raw === 'string' && new TextEncoder().encode(raw).length <= 2_000_000);
  if (await lunchHash(raw) !== ref.sha256) throw versionError();
  const snapshot = JSON.parse(raw);
  require(snapshot.schemaVersion === 1 && snapshot.schoolSlug === slug && snapshot.schoolId === schoolId && hasText(snapshot.schoolName)
    && snapshot.mealDate === ref.mealDate && snapshot.fetchedAt === ref.fetchedAt && snapshot.status === ref.status
    && snapshot.sourceUrl === lunchSourceURL(schoolId, ref.mealDate) && Array.isArray(snapshot.providers) && snapshot.providers.length <= 20
    && Boolean(snapshot.providers.length) === (snapshot.status === 'available'));
  const batches = new Set();
  for (const provider of snapshot.providers) {
    require(provider && id(provider.batchId) && !batches.has(provider.batchId) && id(provider.kitchenId)
      && hasText(provider.name) && optionalStamp(provider.uploadedAt) && Array.isArray(provider.dishes) && provider.dishes.length > 0
      && provider.dishes.length <= 100 && Array.isArray(provider.seasonings) && provider.seasonings.length <= 100);
    batches.add(provider.batchId);
    const records = new Set();
    for (const [seasoning, dishes] of [[false, provider.dishes], [true, provider.seasonings]]) {
      for (const dish of dishes) {
        require(dish && id(dish.id) && !records.has(dish.id) && hasText(dish.dishId) && dish.dishId.length <= 100 && hasText(dish.name)
          && (dish.name === '調味料') === seasoning && isText(dish.type) && optionalStamp(dish.updatedAt)
          && (dish.order == null || (Number.isSafeInteger(dish.order) && dish.order >= 0 && dish.order <= 10000))
          && dish.photoUrl === (/^[0-9]+$/.test(dish.dishId) ? `${OFFICIAL}/dish/pic/${dish.dishId}` : null)
          && Array.isArray(dish.ingredients) && dish.ingredients.length <= 2000);
        records.add(dish.id);
        const ingredients = new Set();
        for (const item of dish.ingredients) {
          require(item && id(item.id) && !ingredients.has(item.id) && hasText(item.name) && isText(item.manufacturer)
            && isText(item.origin) && isText(item.supplier) && optionalStamp(item.stockDate) && Array.isArray(item.certifications) && item.certifications.length <= 30);
          ingredients.add(item.id);
          for (const cert of item.certifications) require(cert && isText(cert.name) && isText(cert.id));
        }
        const registered = dish.ingredients.filter(item => item.stockDate).length;
        const status = !registered ? 'not-registered' : registered === dish.ingredients.length ? 'registered' : 'partial';
        require(dish.ingredientStatus === status);
      }
    }
  }
  return {manifest: selected, snapshot};
}

export async function loadLunch({baseURL, schoolSlug: slug, schoolId, fetcher = fetch,
  storage = globalThis.caches, timeoutMs = 8000, signal} = {}) {
  require(typeof slug === 'string' && /^[a-z][a-z0-9-]*$/.test(slug) && id(schoolId), '午餐學校設定不完整');
  const root = new URL('./', baseURL);
  const cacheKey = new URL(`data/lunch/offline/${slug}`, root).href;
  const checkCancelled = () => { if (signal?.aborted) throw new DOMException('已取消', 'AbortError'); };
  let cache, saved;
  try {
    cache = await storage?.open(lunchCacheName(root.href));
    const response = await cache?.match(cacheKey);
    if (response) {
      const candidate = await response.json();
      await verifyLunch(candidate.manifest, candidate.raw, slug, schoolId);
      saved = candidate;
    }
  } catch {
    // A corrupt or unavailable cache never prevents online reading.
  }
  async function request(path) {
    checkCancelled();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    const timer = setTimeout(cancel, timeoutMs);
    try {
      const response = await fetcher(new URL(path, root).href, {cache: 'no-cache', signal: controller.signal});
      if (!response.ok) {
        const error = new Error('午餐資料請求失敗');
        error.status = response.status;
        throw error;
      }
      const raw = await response.text();
      require(new TextEncoder().encode(raw).length <= 2_000_000, '午餐資料超出大小限制');
      return raw;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      checkCancelled();
      const manifest = selectedStatus(JSON.parse(await request('data/lunch/status.json')), slug, schoolId);
      const ref = manifest.schools[slug].snapshot;
      if (!ref && saved?.raw) throw new Error('網站尚無本校完整午餐資料，保留已儲存的菜單');
      let raw = null;
      if (ref) {
        const reuse = saved?.manifest.schools[slug].snapshot?.sha256 === ref.sha256;
        try {
          raw = reuse ? saved.raw : await request(`data/lunch/${slug}.json?v=${ref.sha256}`);
        } catch (error) {
          if (error.status === 404) throw versionError();
          throw error;
        }
      }
      const verified = await verifyLunch(manifest, raw, slug, schoolId);
      checkCancelled();
      let cacheAvailable = false;
      if (cache) {
        try {
          await cache.put(cacheKey, new Response(JSON.stringify({manifest, raw}), {headers: {'Content-Type': 'application/json'}}));
          cacheAvailable = true;
        } catch {
          // Failed writes leave the previous coherent snapshot available.
        }
      }
      return {...verified, entry: manifest.schools[slug], mode: 'network', cacheAvailable};
    } catch (error) {
      checkCancelled();
      failure = error;
      if (error.code !== 'lunch-version') break;
    }
  }
  if (saved) {
    const verified = await verifyLunch(saved.manifest, saved.raw, slug, schoolId);
    return {...verified, entry: saved.manifest.schools[slug], mode: 'cached', cacheAvailable: true, failure: failure?.message};
  }
  throw failure || new Error('尚無可用的午餐資料');
}
