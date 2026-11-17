import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSnapshot, digest, snapshotCacheName} from '../data-client.mjs';
import {buildSchoolArtifacts} from '../scripts/build_school_data.mjs';

const root = 'https://example.test/news/';
const config = {
  schools: ['仁愛國小', '博愛國小'], schoolMeta: {'仁愛國小': {slug: 'renai', site: 'https://r.test'}, '博愛國小': {slug: 'boai', site: 'https://b.test'}},
  categoryIds: {'一般消息': 'general', '教育局消息': 'education'},
  sources: [
    {id: 'r-general', name: '一般消息', school: '仁愛國小', url: 'https://r.test/feed'},
    {id: 'b-general', name: '一般消息', school: '博愛國小', url: 'https://b.test/feed'},
    {id: 'shared-education', name: '教育局消息', schools: ['仁愛國小', '博愛國小'], url: 'https://edu.test/feed'},
  ],
};
function rawData(boaiTitle = '博愛公告') {
  const metadata = {updatedAt: '2026-11-16T00:00:00Z', lastSuccessfulAt: '2026-11-16T00:00:00Z',
    errors: [], sourceStatus: config.sources.map(source => ({id: source.id, name: source.name, status: 'ok', schools: source.schools || [source.school]}))};
  return {...metadata, schemaVersion: 2, articles: config.sources.map((source, index) => ({
    id: source.id + ':1', sourceId: source.id, source: source.name, guid: 'doc-1', title: index === 0 ? '仁愛公告' : index === 1 ? boaiTitle : '教育局公告',
    published: '2026-11-15T00:00:00Z', schools: source.schools || [source.school], summary: '全年公告摘要',
    url: new URL('doc/1', source.url).href, siteUrl: new URL(source.url).origin, sourceUrl: source.url, attachments: ['計畫.pdf'],
  }))};
}
async function publication(raw = rawData(), settings = config) {
  const {artifacts, schools} = buildSchoolArtifacts(settings, raw);
  const archiveVersion = {schemaVersion: 2, dataVersion: await digest(raw.articles), configVersion: await digest(settings),
    updatedAt: raw.updatedAt, lastSuccessfulAt: raw.lastSuccessfulAt, sourceStatus: raw.sourceStatus, errors: raw.errors};
  return {raw, config: settings, archiveVersion, version: {...archiveVersion, schoolDataSchemaVersion: 1, schools}, artifacts};
}
function memoryStorage() {
  const maps = new Map();
  return {maps, failWrites: false,
    async keys() { return [...maps.keys()]; },
    async delete(name) { return maps.delete(name); },
    async open(name) {
      if (!maps.has(name)) maps.set(name, new Map());
      const entries = maps.get(name); const storage = this;
      const keyOf = key => typeof key === 'string' ? key : key.url;
      return {
        async match(key) { const value = entries.get(keyOf(key)); return value === undefined ? undefined : new Response(value); },
        async put(key, response) { if (storage.failWrites) throw new Error('quota'); entries.set(keyOf(key), await response.text()); },
        async keys() { return [...entries.keys()].map(url => new Request(url)); },
        async delete(key) { return entries.delete(keyOf(key)); },
      };
    },
  };
}
function server(pub) {
  const calls = [];
  return {calls, fetcher: async url => {
    const path = new URL(url).pathname; calls.push(path);
    let value;
    if (path.endsWith('/version.json')) value = pub.version;
    else if (path.endsWith('/config.json')) value = pub.config;
    else if (path.endsWith('/articles.json')) value = pub.raw;
    else { const slug = path.match(/\/schools\/([^/]+)\.json$/)?.[1]; value = pub.artifacts.get(slug); }
    return value === undefined ? new Response('missing', {status: 404}) : new Response(JSON.stringify(value));
  }};
}
const offline = async () => { throw new TypeError('offline'); };
const load = (slug, storage, fetcher, extra = {}) => loadSnapshot({baseURL: root, schoolSlug: slug, storage, fetcher, ...extra});

async function seedLegacy(storage, pub) {
  const cache = await storage.open(snapshotCacheName(root));
  await cache.put(root + 'data/offline-snapshot', new Response(JSON.stringify({config: pub.config, data: pub.raw, version: pub.archiveVersion, savedAt: pub.raw.updatedAt})));
}

test('cold load downloads exactly the selected school, never the full archive or other school bodies', async () => {
  const pub = await publication(); const storage = memoryStorage(); const online = server(pub);
  const result = await load('renai', storage, online.fetcher);
  assert.deepEqual(online.calls, ['/news/data/version.json', '/news/config.json', '/news/data/schools/renai.json']);
  assert.equal(result.data.premerged, true);
  assert.deepEqual(result.data.articles.map(article => article.title), ['仁愛公告', '教育局公告']);
  assert.equal(result.data.school, '仁愛國小');
});

test('an update to another school reuses the selected body and downloads only the manifest', async () => {
  const storage = memoryStorage(); const first = await publication();
  await load('renai', storage, server(first).fetcher);
  const changed = await publication(rawData('博愛新公告'));
  changed.version.updatedAt = '2026-11-16T06:00:00Z';
  const online = server(changed);
  const result = await load('renai', storage, online.fetcher);
  assert.notEqual(first.version.dataVersion, changed.version.dataVersion);
  assert.deepEqual(online.calls, ['/news/data/version.json']);
  assert.equal(result.data.updatedAt, changed.version.updatedAt);
});

test('configuration-only changes rehydrate sources without downloading unchanged school bodies', async () => {
  const storage = memoryStorage(); const first = await publication();
  await load('renai', storage, server(first).fetcher);
  const settings = structuredClone(config); settings.sources[0].url = 'https://r.test/new-feed';
  const next = await publication(rawData(), settings); const online = server(next);
  const result = await load('renai', storage, online.fetcher);
  assert.deepEqual(online.calls, ['/news/data/version.json', '/news/config.json']);
  assert.equal(result.data.articles[0].sourceUrl, 'https://r.test/new-feed');
});

test('switching schools caches separate coherent results, and both visited schools work offline', async () => {
  const storage = memoryStorage(); const pub = await publication();
  await load('renai', storage, server(pub).fetcher);
  const online = server(pub); await load('boai', storage, online.fetcher);
  assert.ok(online.calls.includes('/news/data/schools/boai.json'));
  assert.ok(!online.calls.includes('/news/data/schools/renai.json'));
  for (const [slug, name] of [['renai', '仁愛國小'], ['boai', '博愛國小']]) {
    const cached = await load(slug, storage, offline);
    assert.equal(cached.mode, 'cached'); assert.equal(cached.data.school, name);
    assert.ok(cached.data.articles.every(article => article.schools.includes(name)));
  }
  assert.equal(storage.maps.get(snapshotCacheName(root, 3)).size, 2);
});

test('unvisited offline schools show a specific error with navigation config, never another school data', async () => {
  const storage = memoryStorage(); const pub = await publication();
  await load('renai', storage, server(pub).fetcher);
  await assert.rejects(load('boai', storage, offline), error => {
    assert.equal(error.code, 'school-data-unavailable'); assert.equal(error.schoolSlug, 'boai');
    assert.deepEqual(error.config, config); assert.match(error.message, /本校離線資料/);
    return true;
  });
});

test('legacy full snapshots migrate offline without losing unvisited schools, and delete only after all replacements exist', async () => {
  const storage = memoryStorage(); const pub = await publication(); await seedLegacy(storage, pub);
  const first = await load('renai', storage, offline);
  assert.equal(first.mode, 'cached'); assert.equal(first.data.articles.length, 2);
  assert.ok(storage.maps.has(snapshotCacheName(root)));
  const second = await load('boai', storage, offline);
  assert.equal(second.data.articles.length, 2);
  assert.ok(!storage.maps.has(snapshotCacheName(root)));
  assert.equal((await load('renai', storage, offline)).data.articles[0].title, '仁愛公告');
});

test('online legacy upgrade needs only a manifest when the saved full snapshot matches school output', async () => {
  const storage = memoryStorage(); const pub = await publication(); await seedLegacy(storage, pub);
  const online = server(pub); const result = await load('renai', storage, online.fetcher);
  assert.equal(result.mode, 'network'); assert.deepEqual(online.calls, ['/news/data/version.json']);
});

test('new frontend can read and cache an older publication with no school manifest during rollout', async () => {
  const storage = memoryStorage(); const pub = await publication(); pub.version = pub.archiveVersion;
  const result = await load('renai', storage, server(pub).fetcher);
  assert.equal(result.mode, 'network'); assert.equal(result.data.school, '仁愛國小');
  assert.equal((await load('renai', storage, offline)).mode, 'cached');
  const online = server(pub); await load('renai', storage, online.fetcher);
  assert.deepEqual(online.calls, ['/news/data/version.json']);
});

test('mixed school version/body retries once then falls back without overwriting the good cache', async () => {
  const storage = memoryStorage(); const pub = await publication(); await load('renai', storage, server(pub).fetcher);
  const before = [...storage.maps.get(snapshotCacheName(root, 3)).values()][0];
  const next = await publication(); next.version.schools.renai.dataVersion = 'a'.repeat(64);
  const online = server(next); const result = await load('renai', storage, online.fetcher);
  assert.equal(result.mode, 'cached');
  assert.equal(online.calls.filter(path => path.endsWith('/version.json')).length, 2);
  assert.equal([...storage.maps.get(snapshotCacheName(root, 3)).values()][0], before);
});

test('a manifest cannot redirect a school fetch outside its configured artifact path', async () => {
  const storage = memoryStorage(); const pub = await publication(); await load('renai', storage, server(pub).fetcher);
  pub.version.schools.renai.path = 'https://other.test/articles.json';
  const online = server(pub); assert.equal((await load('renai', storage, online.fetcher)).mode, 'cached');
  assert.ok(online.calls.every(path => path.endsWith('/version.json')));
});

test('quota failure keeps fresh online results and the prior verified school snapshot', async () => {
  const storage = memoryStorage(); const pub = await publication(); await load('renai', storage, server(pub).fetcher);
  const before = [...storage.maps.get(snapshotCacheName(root, 3)).values()][0]; storage.failWrites = true;
  const raw = rawData(); raw.articles[0].title = '仁愛新公告'; const next = await publication(raw);
  const result = await load('renai', storage, server(next).fetcher);
  assert.equal(result.mode, 'network'); assert.equal(result.cacheAvailable, false); assert.equal(result.data.articles[0].title, '仁愛新公告');
  assert.equal([...storage.maps.get(snapshotCacheName(root, 3)).values()][0], before);
});

test('a corrupt school snapshot cannot be served offline and does not hide another valid navigation config', async () => {
  const storage = memoryStorage(); const pub = await publication();
  await load('renai', storage, server(pub).fetcher); await load('boai', storage, server(pub).fetcher);
  const cache = storage.maps.get(snapshotCacheName(root, 3)); const key = root + 'data/offline-snapshot/renai';
  const corrupt = JSON.parse(cache.get(key)); corrupt.data.articles[0].title = 'corrupt'; cache.set(key, JSON.stringify(corrupt));
  await assert.rejects(load('renai', storage, offline), error => error.code === 'school-data-unavailable' && error.config.schoolMeta['博愛國小'].slug === 'boai');
});

test('per-school network requests time out and use the matching saved snapshot', async () => {
  const storage = memoryStorage(); const pub = await publication(); await load('renai', storage, server(pub).fetcher);
  const hanging = async (_url, {signal}) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), {once: true}));
  assert.equal((await load('renai', storage, hanging, {timeoutMs: 5})).mode, 'cached');
});
