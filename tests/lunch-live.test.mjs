import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fetchOfficialLunch, loadCurrentLunch} from '../lunch-live.mjs';
import {verifyLunch} from '../lunch-client.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/lunch-official.json', import.meta.url), 'utf8'));
const published = JSON.parse(await readFile(new URL('../data/lunch/status.json', import.meta.url), 'utf8'));
const body = await readFile(new URL('../data/lunch/boai.json', import.meta.url), 'utf8');
const schoolSlug = 'boai', schoolId = '323609', schoolName = '臺北市信義區博愛國小';
const NOW = new Date('2026-11-17T15:00:00Z');
const options = {schoolSlug, schoolId, schoolName, now: () => NOW};
function storage() {
  const entries = new Map();
  return {entries, async open(name) { return {
    async match(key) { const raw = entries.get(name + key); return raw ? new Response(raw) : undefined; },
    async put(key, response) { entries.set(name + key, await response.text()); },
  }; }};
}
function api({empty = false, fail = false, corrupt = false, latency = 0} = {}) {
  const calls = []; let active = 0, peak = 0;
  return {calls, get peak() { return peak; }, async fetcher(url, settings) {
    calls.push({url, settings});
    const parsed = new URL(url);
    if (parsed.origin !== 'https://fatraceschool.k12ea.gov.tw') {
      return new Response(parsed.pathname.endsWith('/status.json') ? JSON.stringify(published) : body);
    }
    assert.equal(settings.credentials, 'omit');
    assert.equal(settings.referrerPolicy, 'no-referrer');
    assert.deepEqual(settings.headers, {Accept: 'application/json'});
    active++; peak = Math.max(active, peak);
    if (latency) await new Promise(resolve => setTimeout(resolve, latency));
    active--;
    if (fail) return new Response('forbidden', {status: 403});
    let value;
    if (parsed.pathname === '/offered/meal') {
      value = structuredClone(fixture.meals);
      value.data.forEach(meal => { meal.MenuDate = parsed.searchParams.get('period').replaceAll('-', '/'); });
      if (empty) value.data = [];
    } else if (parsed.pathname === '/dish') {
      value = structuredClone(fixture.dishes);
      if (corrupt) value.data[0].KitchenId = 99999;
    } else {
      value = parsed.searchParams.get('DishId') === String(fixture.ingredients.data[0].DishId)
        ? fixture.ingredients : {result: 1, data: []};
    }
    return new Response(JSON.stringify(value));
  }};
}

test('official public API records normalize to a fully verified school snapshot with at most three concurrent calls', async () => {
  const server = api({latency: 1});
  const bundle = await fetchOfficialLunch({...options, fetcher: server.fetcher});
  const {snapshot} = await verifyLunch(bundle.manifest, bundle.raw, schoolSlug, schoolId);
  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.providers[0].dishes.length, 6);
  assert.equal(snapshot.providers[0].seasonings.length, 1);
  assert.equal(snapshot.providers[0].seasonings[0].type, null);
  assert.equal(snapshot.providers[0].dishes[0].ingredients[0].origin, '臺灣');
  assert.equal(snapshot.providers[0].dishes[0].ingredients[0].name, fixture.ingredients.data[0].IngredientName);
  assert.ok(server.peak <= 3);
  assert.ok(server.calls.every(call => !new URL(call.url).pathname.startsWith('/dish/pic/')));
});

test('fresh official menus are cached for 30 minutes and the Taiwan date boundary forces a new query', async () => {
  const store = storage(), server = api(); let clock = new Date(NOW);
  const args = {...options, baseURL: 'https://app.test/live-current/', storage: store, fetcher: server.fetcher, now: () => clock};
  const first = await loadCurrentLunch(args);
  assert.equal(first.origin, 'official'); assert.equal(first.mode, 'network');
  const count = server.calls.length;
  clock = new Date(NOW.getTime() + 60_000);
  const reused = await loadCurrentLunch(args);
  assert.equal(reused.mode, 'recent'); assert.equal(server.calls.length, count);
  clock = new Date('2026-11-17T16:01:00Z');
  const tomorrow = await loadCurrentLunch(args);
  assert.equal(tomorrow.snapshot.mealDate, '2026-11-18');
  assert.ok(server.calls.length > count);
  assert.equal(store.entries.size, 1);
});

test('official 403 is not retried and falls back to the published verified snapshot with an explicit notice flag', async () => {
  const server = api({fail: true});
  const result = await loadCurrentLunch({...options, baseURL: 'https://app.test/live-denied/', storage: storage(), fetcher: server.fetcher});
  assert.equal(result.origin, 'published'); assert.equal(result.officialUnavailable, true);
  assert.equal(result.snapshot.schoolId, schoolId);
  assert.equal(server.calls.filter(call => new URL(call.url).origin.includes('fatraceschool')).length, 1);
  assert.equal(server.calls.length, 3);
});

test('failed or empty refreshes preserve a newer complete official cache instead of an older publication', async () => {
  for (const kind of ['fail', 'empty']) {
    const store = storage(); let clock = new Date(NOW);
    const args = {...options, baseURL: `https://app.test/live-retain-${kind}/`, storage: store, now: () => clock};
    const fresh = await loadCurrentLunch({...args, fetcher: api().fetcher});
    const direct = [...store.entries].find(([key]) => key.includes('/direct/'))[1];
    clock = new Date(NOW.getTime() + 31 * 60_000);
    const retained = await loadCurrentLunch({...args, fetcher: api({[kind]: true}).fetcher});
    assert.equal(retained.origin, 'official'); assert.equal(retained.mode, 'cached');
    assert.equal(retained.officialUnavailable, true);
    assert.deepEqual(retained.snapshot, fresh.snapshot);
    assert.equal([...store.entries].find(([key]) => key.includes('/direct/'))[1], direct);
  }
});

test('a legitimate empty response is no-record and is rechecked after five minutes', async () => {
  const server = api({empty: true}), store = storage(); let clock = new Date(NOW);
  const args = {...options, baseURL: 'https://app.test/live-empty/', storage: store, fetcher: server.fetcher, now: () => clock};
  const empty = await loadCurrentLunch(args);
  assert.equal(empty.snapshot.status, 'no-record'); assert.equal(server.calls.length, 1);
  clock = new Date(NOW.getTime() + 6 * 60_000);
  await loadCurrentLunch(args);
  assert.equal(server.calls.length, 2);
});

test('mismatched provider records are rejected and cannot publish a partial official snapshot', async () => {
  const server = api({corrupt: true});
  await assert.rejects(fetchOfficialLunch({...options, fetcher: server.fetcher}));
  const result = await loadCurrentLunch({...options, baseURL: 'https://app.test/live-corrupt/', storage: storage(), fetcher: server.fetcher});
  assert.equal(result.origin, 'published'); assert.equal(result.officialUnavailable, true);
});

test('the whole official query has a bounded timeout, and closing cancels without starting a fallback query', async () => {
  const hanging = async (_url, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), {once: true});
  });
  await assert.rejects(fetchOfficialLunch({...options, fetcher: hanging, timeoutMs: 5}), {name: 'AbortError'});
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(loadCurrentLunch({...options, baseURL: 'https://app.test/live-abort/', storage: storage(),
    signal: controller.signal, fetcher: async () => { calls++; throw new Error('must not fetch'); }}), {name: 'AbortError'});
  assert.equal(calls, 0);
});

test('cache storage denial still allows direct official reading', async () => {
  const denied = {async open() { throw new Error('denied'); }};
  const result = await loadCurrentLunch({...options, baseURL: 'https://app.test/live-no-storage/', storage: denied, fetcher: api().fetcher});
  assert.equal(result.origin, 'official'); assert.equal(result.cacheAvailable, false);
});
