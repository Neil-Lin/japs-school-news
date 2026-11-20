#!/usr/bin/env node
// Screenshot every school page and both dialogs with a fixed clock and an intercepted lunch API.
// Usage: node tests/visual/capture.mjs <outDir> [--dist <builtSiteDir>]   (default dist: ./dist)
import {chromium, webkit, devices} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdir, readFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';

const args = process.argv.slice(2);
const out = args[0];
const dist = resolve(args.includes('--dist') ? args[args.indexOf('--dist') + 1] : 'dist');
if (!out) throw new Error('usage: capture.mjs <outDir> [--dist <dir>]');
await mkdir(out, {recursive: true});

const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain'};
const server = createServer(async (request, response) => {
  let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = join(dist, path);
  if (!file.startsWith(dist)) return response.writeHead(403).end();
  try {
    const body = await readFile(file);
    response.writeHead(200, {'content-type': TYPES[extname(file)] || 'application/octet-stream'}).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const fixture = JSON.parse(await readFile(new URL('../fixtures/lunch-official.json', import.meta.url)));
const config = JSON.parse(await readFile(join(dist, 'config.json')));
const slugs = ['', ...config.schools.map(school => config.schoolMeta[school].slug)];

try {
  for (const [name, type, options] of [
    ['desktop', chromium, {viewport: {width: 1280, height: 900}}],
    ['mobile', webkit, devices['iPhone 13']],
  ]) {
    const browser = await type.launch();
    const context = await browser.newContext({...options, serviceWorkers: 'block'});
    await context.addInitScript(() => {
      const fixed = Date.parse('2026-11-20T10:00:00+08:00');
      const RealDate = Date;
      window.Date = class extends RealDate {
        constructor(...values) { super(...(values.length ? values : [fixed])); }
        static now() { return fixed; }
      };
    });
    await context.route('https://fatraceschool.k12ea.gov.tw/**', async route => {
      const url = new URL(route.request().url());
      let value;
      if (url.pathname === '/offered/meal') {
        value = structuredClone(fixture.meals);
        Object.assign(value.data[0], {SchoolId: 333605, SchoolCode: '333605', SchoolName: '臺北市大安區仁愛國小',
          MenuDate: url.searchParams.get('period').replaceAll('-', '/')});
      } else if (url.pathname === '/dish') value = fixture.dishes;
      else if (url.pathname === '/ingredient') {
        value = {...fixture.ingredients, data: fixture.ingredients.data.filter(row => String(row.DishId) === url.searchParams.get('DishId'))};
      }
      if (!value) return route.abort();
      await route.fulfill({json: value, headers: {'access-control-allow-origin': '*'}});
    });
    const page = await context.newPage();
    for (const slug of slugs) {
      await page.goto(`${base}/${slug ? slug + '/' : ''}`);
      await page.locator('#feed .card').first().waitFor();
      await page.screenshot({path: `${out}/${name}-${slug || 'root'}.png`, fullPage: true});
    }
    await page.goto(`${base}/renai/?q=${encodeURIComponent('家長')}`);
    await page.locator('#feed .card').first().waitFor();
    await page.screenshot({path: `${out}/${name}-renai-search.png`});
    await page.locator('#schoolInfoOpen').click();
    await page.locator('#schoolInfoDialog').waitFor();
    await page.screenshot({path: `${out}/${name}-renai-info.png`});
    await page.keyboard.press('Escape');
    await page.locator('#lunchOpen').click();
    await page.locator('#lunchContent .lunch-dish').first().waitFor();
    await page.locator('#lunchContent .lunch-dish summary').first().click();
    await page.screenshot({path: `${out}/${name}-renai-lunch.png`});
    await browser.close();
  }
} finally {
  server.close();
}
console.log(`Screenshots written to ${out}`);
