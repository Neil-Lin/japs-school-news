import {loadLunch, verifyLunch, lunchSourceURL, lunchCacheName} from './lunch-client.mjs';
import {sha256Hex, taipeiDay, withDeadline} from './format.mjs';

const ROOT = 'https://fatraceschool.k12ea.gov.tw';
const recent = new Map();
const failedAt = new Map();
const assert = value => { if (!value) throw new Error('官方午餐資料不完整或對應不符'); };
const text = value => { assert(value == null || typeof value === 'string'); return value?.trim() || null; };
const id = value => {
  if (Number.isSafeInteger(value) && value > 0) value = String(value);
  assert(typeof value === 'string' && value.length > 0 && value.length <= 100);
  return value;
};

async function mapLimited(items, action) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(3, items.length)}, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await action(items[index]);
    }
  }));
  return result;
}

export async function fetchOfficialLunch({schoolSlug, schoolId, schoolName, fetcher = fetch,
  signal, timeoutMs = 8000, now = () => new Date()} = {}) {
  assert(typeof schoolSlug === 'string' && /^[a-z][a-z0-9-]*$/.test(schoolSlug)
    && typeof schoolId === 'string' && /^[0-9]+$/.test(schoolId) && typeof schoolName === 'string' && schoolName.trim());
  const day = taipeiDay(now());
  return withDeadline({timeoutMs, signal}, async deadline => {
    let requests = 0;
    async function get(path, params, limit) {
      if (deadline.aborted) throw new DOMException('已取消', 'AbortError');
      assert(++requests <= 150);
      const response = await fetcher(ROOT + path + '?' + new URLSearchParams(params), {
        cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer', signal: deadline,
        headers: {Accept: 'application/json'},
      });
      if (!response.ok) throw new Error('官方午餐查詢暫時無法取得（' + response.status + '）');
      if (response.url) assert(new URL(response.url).origin === ROOT && new URL(response.url).pathname === path);
      const raw = await response.text();
      assert(new TextEncoder().encode(raw).length <= 2_000_000);
      const value = JSON.parse(raw);
      assert(value?.result === 1 && Array.isArray(value.data) && value.data.length <= limit
        && value.data.every(row => row && typeof row === 'object' && !Array.isArray(row)));
      return value.data;
    }
    const meals = await get('/offered/meal', {KitchenId: 'all', MenuType: '1', period: day, SchoolId: schoolId}, 20);
    for (const meal of meals) assert(id(meal.SchoolId) === schoolId && meal.SchoolName === schoolName
      && meal.MenuDate?.replaceAll('/', '-') === day && meal.MenuType === 1);
    const providers = await mapLimited(meals, async meal => {
      const batchId = id(meal.BatchDataId), kitchenId = id(meal.KitchenId);
      const rows = await get('/dish', {BatchDataId: batchId}, 100);
      assert(rows.some(row => row.DishName !== '調味料'));
      const dishes = rows.map(row => {
        assert(id(row.BatchDataId) === batchId && id(row.KitchenId) === kitchenId);
        const dishId = id(row.DishId);
        return {id: id(row.DishBatchDataId), dishId, name: text(row.DishName), type: text(row.DishType),
          order: row.DishOrder ?? null, updatedAt: text(row.UpdateDateTime),
          photoUrl: /^[0-9]+$/.test(dishId) ? ROOT + '/dish/pic/' + dishId : null};
      });
      return {batchId, kitchenId, name: text(meal.KitchenName), uploadedAt: text(meal.UploadDateTime),
        dishes: dishes.filter(d => d.name !== '調味料'), seasonings: dishes.filter(d => d.name === '調味料')};
    });
    const jobs = providers.flatMap(provider => [...provider.dishes, ...provider.seasonings].map(dish => ({provider, dish})));
    await mapLimited(jobs, async ({provider, dish}) => {
      const rows = await get('/ingredient', {BatchDataId: provider.batchId, DishId: dish.dishId}, 2000);
      dish.ingredients = rows.map(row => {
        assert(id(row.BatchDataId) === provider.batchId && id(row.DishId) === dish.dishId);
        const certifications = row.Certification || [];
        assert(Array.isArray(certifications));
        let origin = text(row.IngredientSourceNameList);
        if (!origin) {
          const origins = row.IngredientSource || [];
          assert(Array.isArray(origins));
          origin = origins.map(item => text(item?.name)).filter(Boolean).join('、') || null;
        }
        return {id: id(row.IngredientBatchId), name: text(row.IngredientName),
          manufacturer: text(row.Manufacturer), origin, supplier: text(row.SupplierName), stockDate: text(row.StockDate),
          certifications: certifications.map(cert => ({name: text(cert?.SourceCertification), id: text(cert?.CertificationId)}))};
      });
      const registered = dish.ingredients.filter(item => item.stockDate).length;
      dish.ingredientStatus = !registered ? 'not-registered' : registered === dish.ingredients.length ? 'registered' : 'partial';
    });
    for (const provider of providers) for (const group of [provider.dishes, provider.seasonings]) {
      group.sort((a, b) => (a.order ?? 10001) - (b.order ?? 10001) || a.id.localeCompare(b.id));
    }
    providers.sort((a, b) => a.kitchenId.localeCompare(b.kitchenId) || a.batchId.localeCompare(b.batchId));
    const fetchedAt = now().toISOString(), status = providers.length ? 'available' : 'no-record';
    const snapshot = {schemaVersion: 1, schoolSlug, schoolId, schoolName, mealDate: day, fetchedAt,
      status, sourceUrl: lunchSourceURL(schoolId, day), providers};
    const raw = JSON.stringify(snapshot);
    const entry = {schoolId, status, errors: [], lastSuccessAt: fetchedAt, snapshot: {
      path: schoolSlug + '.json', sha256: await sha256Hex(raw), mealDate: day, fetchedAt, status}};
    const manifest = {schemaVersion: 1, requestedDate: day, checkedAt: fetchedAt, schools: {[schoolSlug]: entry}};
    await verifyLunch(manifest, raw, schoolSlug, schoolId);
    if (deadline.aborted) throw new DOMException('已取消', 'AbortError');
    return {manifest, raw};
  });
}

export async function loadCurrentLunch(options = {}) {
  const {baseURL, schoolSlug, schoolId, schoolName, storage = globalThis.caches,
    now = () => new Date(), signal} = options;
  const root = new URL('./', baseURL), key = new URL('data/lunch/direct/' + schoolSlug, root).href;
  let cache, saved = recent.get(key);
  try {
    cache = await storage?.open(lunchCacheName(root.href));
    if (!saved) {
      const response = await cache?.match(key);
      if (response) saved = await response.json();
    }
    if (saved) {
      const verified = await verifyLunch(saved.manifest, saved.raw, schoolSlug, schoolId);
      assert(verified.snapshot?.schoolName === schoolName);
    }
  } catch { saved = undefined; recent.delete(key); }
  const cancelled = () => { if (signal?.aborted) throw new DOMException('已取消', 'AbortError'); };
  cancelled();
  async function result(bundle, mode, extra = {}) {
    const verified = await verifyLunch(bundle.manifest, bundle.raw, schoolSlug, schoolId);
    return {...verified, entry: bundle.manifest.schools[schoolSlug], mode, origin: 'official', cacheAvailable: Boolean(cache), ...extra};
  }
  if (saved) {
    const ref = saved.manifest.schools[schoolSlug].snapshot;
    const age = now().getTime() - Date.parse(ref.fetchedAt);
    const ttl = (ref.status === 'available' ? 30 : 5) * 60 * 1000;
    if (ref.mealDate === taipeiDay(now()) && age >= 0 && age < ttl) return result(saved, 'recent');
  }
  if (now().getTime() - (failedAt.get(key) || 0) > 2 * 60 * 1000) {
    try {
      const next = await fetchOfficialLunch({...options, now});
      cancelled();
      const ref = next.manifest.schools[schoolSlug].snapshot, old = saved?.manifest.schools[schoolSlug].snapshot;
      if (ref.status === 'no-record' && old?.status === 'available' && old.mealDate === ref.mealDate) throw new Error('已登錄菜單後出現空回應');
      recent.set(key, next);
      let stored = false;
      try { if (cache) { await cache.put(key, new Response(JSON.stringify(next))); stored = true; } } catch { /* Keep online reading available. */ }
      failedAt.delete(key);
      return result(next, 'network', {cacheAvailable: stored});
    } catch {
      cancelled();
      failedAt.set(key, now().getTime());
    }
  }
  let published;
  try { published = await loadLunch(options); } catch { cancelled(); }
  cancelled();
  if (saved && (!published?.snapshot || saved.manifest.schools[schoolSlug].snapshot.mealDate > published.snapshot.mealDate
    || (saved.manifest.schools[schoolSlug].snapshot.mealDate === published.snapshot.mealDate
      && Date.parse(saved.manifest.checkedAt) > Date.parse(published.manifest.checkedAt)))) {
    return result(saved, 'cached', {officialUnavailable: true});
  }
  if (published) return {...published, origin: 'published', officialUnavailable: true};
  throw new Error('目前沒有可用的本校午餐資料');
}
