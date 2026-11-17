import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {digest, loadSnapshot, snapshotCacheName} from '../data-client.mjs';

const baseURL = 'https://example.test/japs-school-news/';
const config = {schools: ['仁愛國小'], sources: [{id: 'renai-news', name: '一般消息'}], categoryIds: {'一般消息': 'news'}};
function data(title = '公告') {
  return {schemaVersion: 2, updatedAt: '2026-11-16T00:00:00Z', lastSuccessfulAt: '2026-11-16T00:00:00Z',
    articles: [{id: 'r:1', sourceId: 'renai-news', source: '一般消息', schools: ['仁愛國小'], title}],
    sourceStatus: [{id: 'renai-news', name: '一般消息', status: 'ok'}], errors: []};
}
async function version(payload = data(), settings = config) {
  return {schemaVersion: 2, dataVersion: await digest(payload.articles), configVersion: await digest(settings),
    updatedAt: payload.updatedAt, lastSuccessfulAt: payload.lastSuccessfulAt, sourceStatus: payload.sourceStatus, errors: payload.errors};
}
function storage() {
  const entries = new Map();
  return {entries, failWrites: false, async open(name) {
    const owner = this;
    return {
      async match(key) { const text = entries.get(name + key); return text === undefined ? undefined : new Response(text); },
      async put(key, response) { if (owner.failWrites) throw new Error('quota'); entries.set(name + key, await response.text()); },
    };
  }};
}
function server(settings, payload, manifest) {
  const calls = [];
  return {calls, fetcher: async url => {
    calls.push(new URL(url).pathname);
    const path = new URL(url).pathname;
    const value = path.endsWith('/version.json') ? manifest : path.endsWith('/config.json') ? settings : payload;
    return new Response(JSON.stringify(value));
  }};
}
const offline = async () => { throw new TypeError('network offline'); };

test('published Python hashes agree with browser canonical JSON for real config and all articles', async () => {
  const [settings, payload, manifest] = await Promise.all(['config.json', 'data/articles.json', 'data/version.json'].map(async path => JSON.parse(await readFile(new URL('../' + path, import.meta.url)))));
  assert.equal(await digest(settings), manifest.configVersion);
  assert.equal(await digest(payload.articles), manifest.dataVersion);
});

test('online snapshot survives fully offline reload with the matching config and metadata', async () => {
  const store = storage(); const payload = data(); const manifest = await version(payload);
  const online = server(config, payload, manifest);
  const fresh = await loadSnapshot({baseURL, storage: store, fetcher: online.fetcher});
  assert.equal(fresh.mode, 'network'); assert.equal(fresh.cacheAvailable, true);
  const cached = await loadSnapshot({baseURL, storage: store, fetcher: offline});
  assert.equal(cached.mode, 'cached'); assert.deepEqual(cached.data, fresh.data); assert.deepEqual(cached.config, config);
  assert.equal(store.entries.size, 1);
});

test('unchanged article/config hashes fetch only the manifest and adopt new attempt/error metadata', async () => {
  const store = storage(); const payload = data(); const old = await version(payload);
  await loadSnapshot({baseURL, storage: store, fetcher: server(config, payload, old).fetcher});
  const latest = {...old, updatedAt: '2026-11-16T06:00:00Z', sourceStatus: [{id: 'renai-news', name: '一般消息', status: 'error'}], errors: [{sourceId: 'renai-news', error: 'timeout'}]};
  const online = server(config, payload, latest);
  const result = await loadSnapshot({baseURL, storage: store, fetcher: online.fetcher});
  assert.deepEqual(online.calls, ['/japs-school-news/data/version.json']);
  assert.equal(result.data.updatedAt, latest.updatedAt);
  assert.equal(result.data.sourceStatus[0].status, 'error');
  assert.equal(store.entries.size, 1);
});

test('mismatched deployment retries once then uses the last coherent snapshot without overwriting it', async () => {
  const store = storage(); const old = data();
  await loadSnapshot({baseURL, storage: store, fetcher: server(config, old, await version(old)).fetcher});
  const saved = [...store.entries.values()][0];
  const expected = data('新公告'); const wrong = data('另一版資料');
  const online = server(config, wrong, await version(expected));
  const fallback = await loadSnapshot({baseURL, storage: store, fetcher: online.fetcher});
  assert.equal(fallback.mode, 'cached'); assert.equal(fallback.data.articles[0].title, '公告');
  assert.equal(online.calls.filter(path => path.endsWith('/version.json')).length, 2);
  assert.equal([...store.entries.values()][0], saved);
});

test('a transient version/body race succeeds on its single retry', async () => {
  const one = data('舊公告'); const two = data('新公告'); const v1 = await version(one); const v2 = await version(two);
  let manifests = 0;
  const fetcher = async url => {
    const path = new URL(url).pathname;
    const value = path.endsWith('/version.json') ? (++manifests === 1 ? v1 : v2) : path.endsWith('/config.json') ? config : two;
    return new Response(JSON.stringify(value));
  };
  const result = await loadSnapshot({baseURL, storage: storage(), fetcher});
  assert.equal(result.mode, 'network'); assert.equal(result.data.articles[0].title, '新公告'); assert.equal(manifests, 2);
});

test('request timeout aborts and falls back without an unbounded wait', async () => {
  const store = storage(); const payload = data();
  await loadSnapshot({baseURL, storage: store, fetcher: server(config, payload, await version(payload)).fetcher});
  const hanging = async (_url, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), {once: true});
  });
  const result = await loadSnapshot({baseURL, storage: store, fetcher: hanging, timeoutMs: 5});
  assert.equal(result.mode, 'cached');
});

test('quota failure keeps online reading available and does not erase the previous bundle', async () => {
  const store = storage(); const old = data();
  await loadSnapshot({baseURL, storage: store, fetcher: server(config, old, await version(old)).fetcher});
  const before = [...store.entries.values()][0]; store.failWrites = true;
  const latest = data('新公告');
  const result = await loadSnapshot({baseURL, storage: store, fetcher: server(config, latest, await version(latest)).fetcher});
  assert.equal(result.mode, 'network'); assert.equal(result.cacheAvailable, false); assert.equal(result.data.articles[0].title, '新公告');
  assert.equal([...store.entries.values()][0], before);
});

test('denied cache storage still permits network reads; uncached offline reports a load failure', async () => {
  const denied = {async open() { throw new Error('storage denied'); }};
  const payload = data();
  assert.equal((await loadSnapshot({baseURL, storage: denied, fetcher: server(config, payload, await version(payload)).fetcher})).mode, 'network');
  await assert.rejects(loadSnapshot({baseURL, storage: storage(), fetcher: offline}), /network offline/);
});

test('a corrupt cached bundle is rejected rather than shown offline', async () => {
  const store = storage(); const payload = data();
  await loadSnapshot({baseURL, storage: store, fetcher: server(config, payload, await version(payload)).fetcher});
  const [key, text] = [...store.entries][0]; const corrupt = JSON.parse(text); corrupt.data.articles[0].title = 'corrupt'; store.entries.set(key, JSON.stringify(corrupt));
  await assert.rejects(loadSnapshot({baseURL, storage: store, fetcher: offline}), /network offline/);
});

test('legacy timestamp-only publications remain readable during rollout', async () => {
  const old = {...data()}; delete old.schemaVersion;
  const manifest = {updatedAt: old.updatedAt};
  const store = storage();
  assert.equal((await loadSnapshot({baseURL, storage: store, fetcher: server(config, old, manifest).fetcher})).mode, 'network');
  assert.equal((await loadSnapshot({baseURL, storage: store, fetcher: offline})).mode, 'cached');
});

test('snapshot cache scope prevents collisions between installations on the same origin', () => {
  assert.notEqual(snapshotCacheName('https://example.test/site-a/'), snapshotCacheName('https://example.test/site-b/'));
});
