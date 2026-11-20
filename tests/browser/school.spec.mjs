import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {taipeiDay} from '../../format.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/lunch-official.json', import.meta.url)));
const versionFixture = JSON.parse(await readFile(new URL('../../data/version.json', import.meta.url)));
test.beforeEach(async ({context}) => {
  // All external calls are intercepted. The suite never queries the official API.
  await context.route('https://fatraceschool.k12ea.gov.tw/**', async route => {
    const url = new URL(route.request().url());
    let value;
    if (url.pathname === '/offered/meal') {
      value = structuredClone(fixture.meals);
      Object.assign(value.data[0], {SchoolId: 333605, SchoolCode: '333605', SchoolName: '臺北市大安區仁愛國小', MenuDate: url.searchParams.get('period').replaceAll('-', '/')});
    } else if (url.pathname === '/dish') value = fixture.dishes;
    else if (url.pathname === '/ingredient') value = {...fixture.ingredients, data: fixture.ingredients.data.filter(row => String(row.DishId) === url.searchParams.get('DishId'))};
    if (!value) return route.abort();
    await route.fulfill({json: value, headers: {'access-control-allow-origin': '*'}});
  });
});

async function ready(page) {
  await page.goto('/renai/');
  await expect(page.locator('#feed .card').first()).toBeVisible();
}

test('parent defaults, search and shared URL survive reload', async ({page}) => {
  await ready(page);
  await page.getByRole('button', {name: '下一頁', exact: true}).click();
  await expect(page.locator('#resultStatus')).toContainText('第 2/');
  await page.reload();
  await expect(page.locator('#resultStatus')).toContainText('第 2/');
  for (const id of ['education-department', 'training']) await expect(page.locator(`#filters input[value="${id}"]`)).not.toBeChecked();
  await page.locator('#search').fill('家長');
  await expect(page).toHaveURL(/q=/);
  const status = await page.locator('#resultStatus').textContent();
  await page.reload();
  await expect(page.locator('#search')).toHaveValue('家長');
  await expect(page.locator('#resultStatus')).toHaveText(status);
  await page.locator('#filters input[value="training"]').check();
  await expect(page.locator('#filters input[value="training"]')).toBeChecked();
});

test('basic info closes with Escape and Back, Forward reopens without changing announcement state', async ({page}) => {
  await ready(page);
  await page.locator('#search').fill('家長');
  const url = page.url();
  const feed = await page.locator('#feed').textContent();
  await page.locator('#schoolInfoOpen').click();
  await expect(page.locator('#schoolInfoDialog')).toBeVisible();
  await page.locator('#schoolInfoClose').press('Shift+Tab');
  await expect(page.locator('.school-info-provenance > summary')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#schoolInfoDialog')).not.toBeVisible();
  await expect(page.locator('#schoolInfoOpen')).toBeFocused();
  await expect(page).toHaveURL(url);
  // Wait for the close-button history traversal before opening another layer.
  await expect.poll(() => page.evaluate(() => !!history.state?.__schoolNewsInfo)).toBe(false);
  await page.locator('#schoolInfoOpen').click();
  await page.goBack();
  await expect(page.locator('#schoolInfoDialog')).not.toBeVisible();
  await page.goForward();
  await expect(page.locator('#schoolInfoDialog')).toBeVisible();
  await page.locator('#schoolInfoClose').click();
  await expect(page.locator('#feed')).toHaveText(feed);
  await expect(page.locator('#search')).toHaveValue('家長');
});

test('lunch expands in place and returns focus on close', async ({page}) => {
  await ready(page);
  await page.locator('#lunchOpen').click();
  await expect(page.locator('.lunch-dish').first()).toBeVisible();
  await expect(page.locator('.lunch-provider')).toHaveCount(1);
  await expect(page.locator('.lunch-provider-heading h4')).toHaveText(fixture.meals.data[0].KitchenName);
  await expect(page.locator('.lunch-overview')).toContainText(taipeiDay().split('-')[2].replace(/^0/, '') + '日');
  const first = page.locator('.lunch-dish').first();
  const second = page.locator('.lunch-dish').nth(1);
  const before = await second.boundingBox();
  await first.locator('summary').click();
  await expect(first.locator('.lunch-dish-body')).toBeVisible();
  const after = await second.boundingBox();
  expect(after.x).toBeCloseTo(before.x, 0);
  await page.locator('#lunchClose').click();
  await expect(page.locator('#lunchOpen')).toBeFocused();
});

test('another school response cannot become the current school menu', async ({page, context}) => {
  await ready(page);
  const meals = structuredClone(fixture.meals);
  meals.data[0].MenuDate = taipeiDay().replaceAll('-', '/');
  await context.route('https://fatraceschool.k12ea.gov.tw/offered/meal**', route => route.fulfill({json: meals}));
  await page.locator('#lunchOpen').click();
  await expect(page.locator('#lunchStatus')).not.toHaveText('正在讀取本校午餐資料…');
  await expect(page.locator('#lunchContent')).not.toContainText('統鮮美食');
  await expect(page.locator('.lunch-notices')).toContainText('目前無法取得官方最新資料');
});

test('repaired sources stay normal; failed fetches show concise details without raw errors', async ({page, context}) => {
  const version = structuredClone(versionFixture);
  version.updatedAt = version.lastSuccessfulAt = new Date().toISOString();
  for (const source of version.sourceStatus) Object.assign(source, {status: 'ok', warnings: [], lastSuccessfulAt: version.updatedAt});
  const repaired = version.sourceStatus.find(source => source.schools.includes('仁愛國小'));
  Object.assign(repaired, {status: 'warning', warnings: ['來源 XML 格式異常，已復原完整公告；請檢查來源格式。']});
  await context.route('**/data/version.json', route => route.fulfill({json: version}));
  await ready(page);
  await expect(page.locator('#statusHint')).toHaveText('更新詳情');
  await page.locator('.update-info > summary').click();
  await page.locator('.source-records > summary').click();
  await expect(page.locator('#sourceDetails')).toContainText('正常（來源格式已修復）');
  Object.assign(repaired, {status: 'error', warnings: [], error: 'internal-debug-error', consecutiveFailures: 1});
  version.errors = [{sourceId: repaired.id, error: repaired.error}];
  await page.reload();
  await expect(page.locator('#statusHint')).toHaveText('部分來源待確認');
  await page.locator('.update-info > summary').click();
  await page.locator('.source-records > summary').click();
  await expect(page.locator('#sourceDetails')).toContainText('更新未成功，保留上次資料');
  await expect(page.locator('#sourceDetails')).not.toContainText('internal-debug-error');
});

test('modal locks the background and restores its scroll position on close', async ({page}) => {
  await ready(page);
  await page.evaluate(() => window.scrollTo(0, 100));
  const before = await page.evaluate(() => window.scrollY);
  await page.locator('#schoolInfoOpen').click();
  await expect(page.locator('body')).toHaveCSS('position', 'fixed');
  await page.locator('#schoolInfoDialog .lunch-scroll').evaluate(el => {el.scrollTop = el.scrollHeight;});
  await page.locator('#schoolInfoClose').click();
  await expect(page.locator('body')).not.toHaveCSS('position', 'fixed');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
});

test('record browser announcement and menu waits as a baseline', async ({page}, testInfo) => {
  const newsStart = performance.now();
  await ready(page);
  const newsReadyMs = performance.now() - newsStart;
  const menuStart = performance.now();
  await page.locator('#lunchOpen').click();
  await expect(page.locator('.lunch-dish').first()).toBeVisible();
  const menuReadyMs = performance.now() - menuStart;
  await testInfo.attach('browser-wait-baseline', {body: JSON.stringify({project: testInfo.project.name, newsReadyMs, menuReadyMs,
    note: 'Loopback static server, committed announcement data and stubbed lunch API. Includes automation waits. Mobile emulation is not physical iPhone performance.'}, null, 2), contentType: 'application/json'});
});

test('320px and 390px layouts fit, review dates show without enlarging homepage', async ({page}) => {
  await ready(page);
  for (const width of [320, 390]) {
    await page.setViewportSize({width, height: 844});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#schoolInfoOpen').click();
    const dialog = page.locator('#schoolInfoDialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator('.school-info-provenance > summary').click();
    await expect(page.locator('[data-review-date]')).toHaveCount(2);
    await page.locator('#schoolInfoClose').click();
    await expect.poll(() => page.evaluate(() => !!history.state?.__schoolNewsInfo)).toBe(false);
  }
});

test('review dates become overdue without rebuilding or adding homepage controls', async ({page}) => {
  await ready(page);
  await page.clock.setFixedTime(new Date('2027-01-01T12:00:00+08:00'));
  await page.locator('#schoolInfoOpen').click();
  await expect(page.locator('[data-review-summary]')).toHaveText('・有資料待重新查核');
  await page.locator('.school-info-provenance > summary').click();
  await expect(page.locator('[data-review-status]').first()).toHaveText('・待重新查核');
  await expect(page.locator('[data-review-date] time').first()).toHaveText('2026/11/18');
});

test('an old menu date is rejected even with the correct school identity', async ({page, context}) => {
  await ready(page);
  const meals = structuredClone(fixture.meals);
  Object.assign(meals.data[0], {SchoolId: 333605, SchoolName: '臺北市大安區仁愛國小', MenuDate: '2000/01/01'});
  await context.route('https://fatraceschool.k12ea.gov.tw/offered/meal**', route => route.fulfill({json: meals}));
  await page.locator('#lunchOpen').click();
  await expect(page.locator('#lunchStatus')).not.toHaveText('正在讀取本校午餐資料…');
  await expect(page.locator('.lunch-notices')).toContainText('目前無法取得官方最新資料');
  await expect(page.locator('.lunch-overview')).not.toContainText('2000');
});

test.describe('PWA cache', () => {
  // Only the offline tests enable the worker; routed lunch tests must not bypass fixture interception.
  test.use({serviceWorkers: 'allow'});
  test('offline reload restores coherent saved data and keeps basic information available', async ({page, context}) => {
  await ready(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const headline = await page.locator('#feed .card h3').first().textContent();
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#cacheStatus')).toContainText('上次成功');
  await expect(page.locator('#feed .card h3').first()).toHaveText(headline);
  await page.locator('#schoolInfoOpen').click();
  await expect(page.locator('#schoolInfoDialog')).toContainText('02-27095010');
  });
});
