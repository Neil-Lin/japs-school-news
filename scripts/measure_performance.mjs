#!/usr/bin/env node
// Reproducible local data metrics, not a substitute for real-device LCP measurements.
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {mergeArticles, searchText, filterArticles, defaultSelection} from '../news-core.mjs';
import {hydrateSchoolData} from '../school-data.mjs';

const project = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, project));
const [settingsBytes, archiveBytes, manifestBytes] = await Promise.all(['config.json', 'data/articles.json', 'data/version.json'].map(read));
const config = JSON.parse(settingsBytes);
const version = JSON.parse(manifestBytes);
const oldManifest = {...version}; delete oldManifest.schools; delete oldManifest.schoolDataSchemaVersion;
const oldManifestBytes = Buffer.from(JSON.stringify(oldManifest, null, 2) + '\n');
const p = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)];
const time = fn => { const begin = performance.now(); fn(); return performance.now() - begin; };
const report = {runtime: process.version, notes: 'File bytes and gzip projections. Timing = local Node JSON parsing/data preparation/filtering; excludes hashing, network and DOM rendering.',
  archive: {bytes: archiveBytes.length, gzipBytes: gzipSync(archiveBytes).length}, schools: []};
for (const school of config.schools) {
  const slug = config.schoolMeta[school].slug;
  const body = await read(`data/schools/${slug}.json`);
  const prepareBefore = () => mergeArticles(JSON.parse(archiveBytes).articles).filter(article => article.schools.includes(school)).map(article => ({...article, searchText: searchText(article)}));
  const prepareAfter = () => hydrateSchoolData(config, JSON.parse(body), version).articles.map(article => ({...article, searchText: searchText(article)}));
  prepareBefore(); prepareAfter();
  const before = []; const after = [];
  for (let i = 0; i < 15; i++) { before.push(time(prepareBefore)); after.push(time(prepareAfter)); }
  const articles = prepareAfter();
  const categories = [...new Set(articles.flatMap(article => article.sources))].map(name => ({name, id: config.categoryIds[name]}));
  const state = {selected: defaultSelection(categories), query: '', page: 1};
  const terms = ['', '新生', '家長', 'pdf', 'AI', articles.at(-1)?.title || '公告'];
  const search = [];
  for (let i = 0; i < 120; i++) { state.query = terms[i % terms.length]; search.push(time(() => filterArticles(articles, state, categories))); }
  const baselineFirst = archiveBytes.length + settingsBytes.length + oldManifestBytes.length;
  const first = body.length + settingsBytes.length + manifestBytes.length;
  const baselineGzip = gzipSync(archiveBytes).length + gzipSync(settingsBytes).length + gzipSync(oldManifestBytes).length;
  const firstGzip = gzipSync(body).length + gzipSync(settingsBytes).length + gzipSync(manifestBytes).length;
  report.schools.push({school, slug, articles: articles.length, bytes: body.length, gzipBytes: gzipSync(body).length,
    firstDataBytes: first, firstDataGzipBytes: firstGzip, firstDataReductionPercent: (1 - first / baselineFirst) * 100,
    firstDataGzipReductionPercent: (1 - firstGzip / baselineGzip) * 100,
    prepareBeforeMedianMs: p(before, .5), prepareAfterMedianMs: p(after, .5), filterP95Ms: p(search, .95)});
}
console.log(JSON.stringify(report, null, 2));
