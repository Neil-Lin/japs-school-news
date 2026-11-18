#!/usr/bin/env node
// Byte budgets are deterministic. Node timings are recorded separately, never used as phone speed claims.
import {readFile, writeFile, mkdir, appendFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
const read = path => readFile(new URL('../' + path, import.meta.url));
const config = JSON.parse(await read('config.json'));
const manifest = JSON.parse(await read('assets-manifest.json'));
const assetNames = Object.keys(manifest.assets);
const sizes = await Promise.all(assetNames.map(async name => {
  const body = await read(manifest.assets[name]);
  return {name, bytes: body.length, gzipBytes: gzipSync(body).length};
}));
const shell = {bytes: sizes.reduce((n, x) => n + x.bytes, 0), gzipBytes: sizes.reduce((n, x) => n + x.gzipBytes, 0), requests: sizes.length};
const precacheNames = [...manifest.pages, ...Object.values(manifest.assets), 'manifest.json', ...manifest.publicFiles.filter(name => name.startsWith('assets/'))];
const precacheSizes = await Promise.all(precacheNames.map(async name => (await read(name)).length));
const precache = {bytes: precacheSizes.reduce((sum, value) => sum + value, 0), requests: precacheNames.length};
const schools = [];
for (const meta of Object.values(config.schoolMeta)) {
  const body = await read(`data/schools/${meta.slug}.json`);
  const payload = JSON.parse(body);
  schools.push({slug: meta.slug, articles: payload.articles.length, bytes: body.length, gzipBytes: gzipSync(body).length});
}
const report = {shell, precache, schools, assets: sizes};
await mkdir('reports', {recursive: true});
await writeFile('reports/performance-budget.json', JSON.stringify(report, null, 2) + '\n');
if (process.argv.includes('--record')) {
  await mkdir('maintenance', {recursive: true});
  await writeFile('maintenance/performance-baseline.json', JSON.stringify(report, null, 2) + '\n');
  console.log('Recorded a byte baseline; review changes before accepting a new baseline.');
} else {
  const baseline = JSON.parse(await read('maintenance/performance-baseline.json'));
  const failures = [];
  if (shell.gzipBytes > baseline.shell.gzipBytes * 1.15 + 1024) failures.push('Compressed app shell grew more than 15% + 1 KiB.');
  if (shell.requests > baseline.shell.requests + 1) failures.push('App shell added more than one request.');
  if (precache.bytes > baseline.precache.bytes * 1.15 + 1024) failures.push('Offline shell grew more than 15% + 1 KiB.');
  for (const school of schools) {
    const old = baseline.schools.find(s => s.slug === school.slug);
    // Permit archive growth proportional to article count, plus 20% headroom.
    if (!old || school.gzipBytes > (old.gzipBytes / Math.max(1, old.articles)) * school.articles * 1.2 + 16384) failures.push(`${school.slug}: bytes per article exceeded budget.`);
    if (school.gzipBytes > 2_000_000 || school.bytes > 10_000_000) failures.push(`${school.slug}: absolute data limit exceeded.`);
  }
  const markdown = `## Performance budget\n\nJS/CSS: ${shell.gzipBytes} gzip bytes / ${shell.requests} files. Offline shell: ${precache.bytes} uncompressed bytes / ${precache.requests} files (all school pages and images). Gzip values are projections, not measured transfer sizes.\n\n${schools.map(s => `- ${s.slug}: ${s.gzipBytes} gzip bytes / ${s.articles} articles`).join('\n')}\n\n${failures.length ? failures.join('\n') : 'All byte budgets passed.'}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  if (failures.length) process.exitCode = 1;
}
