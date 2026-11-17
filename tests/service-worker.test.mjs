import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
function runtime({network = async () => new Response('online')} = {}) {
  const root = 'https://example.test/japs-school-news/';
  const cacheMaps = new Map();
  const keyOf = key => typeof key === 'string' ? key : key.url;
  const storage = {
    async keys() { return [...cacheMaps.keys()]; },
    async delete(name) { return cacheMaps.delete(name); },
    async open(name) {
      if (!cacheMaps.has(name)) cacheMaps.set(name, new Map());
      const entries = cacheMaps.get(name);
      return {
        async keys() { return [...entries.keys()].map(url => new Request(url)); },
        async delete(key) { return entries.delete(keyOf(key)); },
        async match(key) { return entries.get(keyOf(key))?.clone(); },
        async put(key, value) { entries.set(keyOf(key), value.clone()); },
        async addAll(paths) { for (const path of paths) entries.set(typeof path === 'string' ? new URL(path, root).href : path.url, new Response('shell')); },
      };
    },
  };
  const handlers = {};
  let claimed = false;
  vm.runInNewContext(source, {self: {registration: {scope: root}, skipWaiting: async () => {}, clients: {claim: async () => { claimed = true; }}, addEventListener: (event, handler) => { handlers[event] = handler; }}, caches: storage, fetch: network, URL, Request, Response, AbortController, setTimeout, clearTimeout});
  return {root, handlers, storage, cacheMaps, get claimed() { return claimed; }};
}
async function lifecycle(app, name) {
  let promise;
  app.handlers[name]({waitUntil(value) { promise = value; }});
  await promise;
}
function request(app, path, mode = 'navigate') {
  let response;
  app.handlers.fetch({request: {url: new URL(path, app.root).href, method: 'GET', mode}, respondWith(value) { response = value; }});
  return response;
}

test('activation removes only scoped/owned legacy entries, preserving another application and snapshots', async () => {
  const app = runtime();
  const own = 'school-news:/japs-school-news/:';
  await app.storage.open(own + 'shell-old');
  await app.storage.open(own + 'snapshot-v2');
  await app.storage.open(own + 'snapshot-v3');
  await app.storage.open('unrelated-app-cache');
  await app.storage.open('school-news:/other-site/:shell-v1');
  const legacy = await app.storage.open('school-news-data-v1');
  await legacy.put(app.root + 'data/version.json?refresh=123', new Response('own'));
  await legacy.put('https://example.test/other-site/data/version.json', new Response('other'));
  await lifecycle(app, 'activate');
  assert.equal(app.claimed, true);
  assert.equal(app.cacheMaps.has(own + 'shell-old'), false);
  assert.equal(app.cacheMaps.has(own + 'snapshot-v2'), true);
  assert.equal(app.cacheMaps.has(own + 'snapshot-v3'), true);
  assert.equal(app.cacheMaps.has('unrelated-app-cache'), true);
  assert.equal(app.cacheMaps.has('school-news:/other-site/:shell-v1'), true);
  assert.equal((await legacy.keys()).length, 1);
  assert.equal((await legacy.keys())[0].url, 'https://example.test/other-site/data/version.json');
});

test('all school shells are available offline and query strings do not create extra navigation keys', async () => {
  const app = runtime({network: async () => { throw new TypeError('offline'); }});
  await lifecycle(app, 'install');
  for (const path of ['./', './renai/?q=新生&page=2', './jianan/', './dunhua/', './boai/', './guangfu/']) {
    const result = await request(app, path);
    assert.equal(result.ok, true, path);
    assert.equal(await result.text(), 'shell');
  }
  assert.equal((await request(app, './renai/index.html?categories=')).ok, true);
});

test('data/config and unrelated same-origin requests are delegated to the verified snapshot client', () => {
  const app = runtime();
  assert.equal(request(app, './data/version.json', 'cors'), undefined);
  assert.equal(request(app, './data/articles.json?v=test', 'cors'), undefined);
  assert.equal(request(app, './config.json?v=test', 'cors'), undefined);
  assert.equal(request(app, 'https://example.test/other-site/app.js', 'cors'), undefined);
});
