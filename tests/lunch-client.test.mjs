import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadLunch, verifyLunch, lunchHash, lunchCacheName, lunchSourceURL, validMealDate} from '../lunch-client.mjs';
import {taipeiDay} from '../format.mjs';
import {lunchPresentation, renderLunch} from '../lunch-ui.mjs';

const baseURL = 'https://example.test/japs-school-news/';
const schoolSlug = 'renai', schoolId = '333605';
const options = {baseURL, schoolSlug, schoolId};
const published = JSON.parse(await readFile(new URL('../data/lunch/status.json', import.meta.url), 'utf8'));
const bodies = Object.fromEntries(await Promise.all(Object.keys(published.schools).map(async slug => [slug, await readFile(new URL(`../data/lunch/${slug}.json`, import.meta.url), 'utf8')])));
const now = new Date('2026-11-17T12:00:00Z');
const clone = value => structuredClone(value);
function storage() {
  const entries = new Map();
  return {entries, failWrites: false, async open(name) {
    const owner = this;
    return {async match(key) { const value = entries.get(name + key); return value === undefined ? undefined : new Response(value); },
      async put(key, value) { if (owner.failWrites) throw new Error('quota'); entries.set(name + key, await value.text()); }};
  }};
}
function server(manifest = published, body = bodies.renai) {
  const calls = [];
  return {calls, async fetcher(url) {
    calls.push(url);
    return new Response(new URL(url).pathname.endsWith('/status.json') ? JSON.stringify(manifest) : body);
  }};
}
const offline = async () => { throw new TypeError('offline'); };

test('all five Python byte hashes and school identities are verified by the browser client', async () => {
  for (const [slug, raw] of Object.entries(bodies)) {
    assert.equal(await lunchHash(raw), published.schools[slug].snapshot.sha256);
    const result = await verifyLunch(published, raw, slug, published.schools[slug].schoolId);
    assert.equal(result.snapshot.schoolSlug, slug);
    assert.deepEqual(Object.keys(result.manifest.schools), [slug]);
  }
});

test('opening lunch fetches only the status and selected school, never food photos or other school bodies', async () => {
  const online = server(), store = storage();
  const result = await loadLunch({...options, fetcher: online.fetcher, storage: store});
  assert.equal(result.mode, 'network');
  assert.equal(result.snapshot.providers.length, 3);
  assert.deepEqual(online.calls.map(url => new URL(url).pathname), ['/japs-school-news/data/lunch/status.json', '/japs-school-news/data/lunch/renai.json']);
  assert.equal(store.entries.size, 1);
  assert.equal(new URL(online.calls[1]).searchParams.get('v'), published.schools.renai.snapshot.sha256);
  const cached = await loadLunch({...options, fetcher: offline, storage: store});
  assert.equal(cached.mode, 'cached');
  assert.deepEqual(cached.snapshot, result.snapshot);
});

test('unchanged content reuses the body while adopting new incomplete-update metadata', async () => {
  const store = storage();
  await loadLunch({...options, storage: store, fetcher: server().fetcher});
  const latest = clone(published);
  latest.checkedAt = '2026-11-17T12:00:00+00:00';
  Object.assign(latest.schools.renai, {status: 'partial', errors: [{scope: 'ingredient', code: 'connection-error', message: 'timeout', providerName: '供餐商', dishName: '白飯'}]});
  const online = server(latest);
  const result = await loadLunch({...options, storage: store, fetcher: online.fetcher});
  assert.equal(online.calls.length, 1);
  assert.equal(result.entry.status, 'partial');
  assert.equal(result.snapshot.fetchedAt, published.schools.renai.lastSuccessAt);
});

test('a deployment hash mismatch retries once then falls back without overwriting the good cache', async () => {
  const store = storage();
  await loadLunch({...options, storage: store, fetcher: server().fetcher});
  const saved = [...store.entries.values()][0];
  const changed = clone(published);
  changed.schools.renai.snapshot.sha256 = '0'.repeat(64);
  const online = server(changed);
  const result = await loadLunch({...options, storage: store, fetcher: online.fetcher});
  assert.equal(result.mode, 'cached');
  assert.equal(online.calls.length, 4);
  assert.equal([...store.entries.values()][0], saved);
});

test('a transient deployment race succeeds on the second status read', async () => {
  let reads = 0;
  const wrong = clone(published);
  wrong.schools.renai.snapshot.sha256 = '0'.repeat(64);
  const result = await loadLunch({...options, storage: storage(), fetcher: async url => {
    if (new URL(url).pathname.endsWith('/status.json')) return new Response(JSON.stringify(++reads === 1 ? wrong : published));
    return new Response(bodies.renai);
  }});
  assert.equal(reads, 2);
  assert.equal(result.mode, 'network');
});

test('manifest paths, identities, dates and photo URLs cannot redirect or mix another school', async () => {
  for (const change of [m => { m.schools.renai.snapshot.path = 'https://evil.test/private'; },
    m => { m.schools.renai.schoolId = '323609'; }, m => { m.requestedDate = '2026-02-30'; }]) {
    const manifest = clone(published); change(manifest);
    const online = server(manifest);
    await assert.rejects(loadLunch({...options, fetcher: online.fetcher, storage: storage()}));
    assert.equal(online.calls.length, 1);
  }
  for (const change of [s => { s.schoolSlug = 'boai'; }, s => { s.schoolId = '323609'; },
    s => { s.sourceUrl = 'javascript:bad()'; }, s => { s.providers[0].dishes[0].photoUrl = 'https://evil.test/photo'; }]) {
    const snapshot = JSON.parse(bodies.renai); change(snapshot);
    const raw = JSON.stringify(snapshot), manifest = clone(published);
    manifest.schools.renai.snapshot.sha256 = await lunchHash(raw);
    await assert.rejects(verifyLunch(manifest, raw, schoolSlug, schoolId));
  }
});

test('offline schools, damaged caches, and other path scopes cannot reuse the wrong school data', async () => {
  const store = storage();
  await loadLunch({...options, storage: store, fetcher: server().fetcher});
  await assert.rejects(loadLunch({...options, schoolSlug: 'boai', schoolId: '323609', storage: store, fetcher: offline}));
  await assert.rejects(loadLunch({...options, baseURL: 'https://example.test/other/', storage: store, fetcher: offline}));
  const [key, value] = [...store.entries][0], damaged = JSON.parse(value);
  damaged.raw = '{}'; store.entries.set(key, JSON.stringify(damaged));
  await assert.rejects(loadLunch({...options, storage: store, fetcher: offline}));
  assert.notEqual(lunchCacheName(baseURL), lunchCacheName('https://example.test/other/'));
});

test('denied storage and quota errors allow online reading and preserve the previous good record', async () => {
  const denied = {async open() { throw new Error('denied'); }};
  assert.equal((await loadLunch({...options, storage: denied, fetcher: server().fetcher})).mode, 'network');
  const store = storage();
  await loadLunch({...options, storage: store, fetcher: server().fetcher});
  const saved = [...store.entries.values()][0]; store.failWrites = true;
  assert.equal((await loadLunch({...options, storage: store, fetcher: server().fetcher})).cacheAvailable, false);
  assert.equal([...store.entries.values()][0], saved);
});

test('timeout uses a verified cached menu, while an explicit close cancellation rejects promptly', async () => {
  const store = storage();
  await loadLunch({...options, storage: store, fetcher: server().fetcher});
  const hanging = async (_url, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), {once: true});
  });
  assert.equal((await loadLunch({...options, storage: store, fetcher: hanging, timeoutMs: 5})).mode, 'cached');
  await assert.rejects(loadLunch({...options, storage: storage(), fetcher: hanging, timeoutMs: 5}), {name: 'AbortError'});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadLunch({...options, storage: store, fetcher: offline, signal: controller.signal}), {name: 'AbortError'});
});

test('no-snapshot status does not fetch a body, and no-record is distinct from an error', async () => {
  const manifest = clone(published);
  Object.assign(manifest.schools.renai, {snapshot: null, lastSuccessAt: null, status: 'error', errors: [{scope: 'meal', code: 'connection-error', message: 'timeout'}]});
  const online = server(manifest);
  const unavailable = await loadLunch({...options, storage: storage(), fetcher: online.fetcher});
  assert.equal(unavailable.snapshot, null); assert.equal(online.calls.length, 1);
  const store = storage();
  await loadLunch({...options, storage: store, fetcher: server().fetcher});
  const before = [...store.entries.values()][0];
  const retained = await loadLunch({...options, storage: store, fetcher: server(manifest).fetcher});
  assert.equal(retained.mode, 'cached');
  assert.equal(retained.snapshot.status, 'available');
  assert.equal([...store.entries.values()][0], before);
  const snapshot = JSON.parse(bodies.renai);
  Object.assign(snapshot, {status: 'no-record', providers: []});
  const raw = JSON.stringify(snapshot), empty = clone(published);
  empty.schools.renai.status = 'no-record';
  Object.assign(empty.schools.renai.snapshot, {status: 'no-record', sha256: await lunchHash(raw)});
  const result = await loadLunch({...options, storage: storage(), fetcher: server(empty, raw).fetcher});
  assert.equal(result.snapshot.status, 'no-record');
  assert.equal(lunchPresentation(result, now).summary, '今日尚無菜單資料');
});

test('old dates, old checks and cached mode are visible without relabelling the meal date', async () => {
  const bundle = await loadLunch({...options, storage: storage(), fetcher: server().fetcher});
  const view = lunchPresentation({...bundle, mode: 'cached'}, new Date('2026-11-19T12:00:00Z'));
  assert.equal(view.date, '2026-11-17');
  assert.equal(view.notices.length, 3);
  assert.match(view.notices.join(' '), /2026年11月17日/);
  assert.equal(taipeiDay(new Date('2026-11-16T18:00:00Z')), '2026-11-17');
  assert.equal(validMealDate('2026-02-30'), false);
  assert.equal(lunchSourceURL(schoolId, view.date), 'https://fatraceschool.k12ea.gov.tw/frontend/search.html?school=333605&period=2026-11-17');
});

test('meal rendering keeps provider groups, ingredient provenance, seasoning, and escaped source text', async () => {
  const bundle = await loadLunch({...options, storage: storage(), fetcher: server().fetcher});
  const html = renderLunch(bundle, now);
  assert.equal((html.match(/class="lunch-provider"/g) || []).length, 3);
  assert.match(html, /來源登錄驗證/); assert.match(html, /<dt>產地<\/dt>/);
  assert.match(html, /<dt>製造商<\/dt>/); assert.match(html, /<dt>供應商<\/dt>/);
  assert.match(html, /調味料明細/); assert.doesNotMatch(html, /<img/);
  const unsafe = clone(bundle);
  unsafe.snapshot.providers[0].name = '<img src=x onerror=alert(1)>';
  unsafe.snapshot.providers[0].dishes[0].ingredients[0].supplier = '<script>alert(1)</script>';
  const escaped = renderLunch(unsafe, now);
  assert.doesNotMatch(escaped, /<img|<script>/);
  assert.match(escaped, /&lt;img/); assert.match(escaped, /&lt;script&gt;/);
});
