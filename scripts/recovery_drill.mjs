#!/usr/bin/env node
// Exercise a known prior release's reader against current data without checking out or changing the working tree.
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdtemp, rm, mkdir, appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const project = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, project));
const {revision} = JSON.parse(await read('maintenance/recovery-baseline.json'));
assert.match(revision, /^[a-f0-9]{40}$/);
const temp = await mkdtemp(join(tmpdir(), 'school-recovery-'));
const entries = new Map();
const storage = {async open(name) {return {
  async match(key) {const body = entries.get(name + key); return body ? new Response(body) : undefined;},
  async put(key, response) {entries.set(name + key, await response.text());},
};}};
try {
  for (const name of ['data-client.mjs', 'school-data.mjs', 'news-core.mjs']) {
    const body = execFileSync('git', ['show', `${revision}:${name}`], {cwd: project, maxBuffer: 2_000_000});
    await writeFile(join(temp, name), body);
  }
  const {loadSnapshot} = await import(pathToFileURL(join(temp, 'data-client.mjs')));
  const config = JSON.parse(await read('config.json'));
  const files = new Map(await Promise.all(['config.json', 'data/version.json', 'data/articles.json', ...Object.values(config.schoolMeta).map(meta => `data/schools/${meta.slug}.json`)].map(async name => [name, await read(name)])));
  const fetcher = async url => {
    const name = new URL(url).pathname.replace('/japs-school-news/', '');
    assert(files.has(name), 'Unexpected request: ' + name);
    return new Response(files.get(name));
  };
  const schools = [];
  for (const [school, meta] of Object.entries(config.schoolMeta)) {
    const options = {baseURL: 'https://example.test/japs-school-news/', schoolSlug: meta.slug, storage};
    const online = await loadSnapshot({...options, fetcher});
    const offline = await loadSnapshot({...options, fetcher: async () => {throw new TypeError('Recovery drill offline');}});
    assert.equal(online.mode, 'network');
    assert.equal(offline.mode, 'cached');
    assert(online.data.articles.length > 0);
    assert.deepEqual(offline.data, online.data);
    assert(online.data.articles.every(article => article.schools.includes(school)));
    schools.push({slug: meta.slug, articles: online.data.articles.length, online: true, offline: true});
  }
  await mkdir('reports', {recursive: true});
  await writeFile('reports/recovery-drill.json', JSON.stringify({readerRevision: revision, schools, publicDataModified: false}, null, 2) + '\n');
  const message = `## Recovery compatibility drill\n\nReader ${revision} read the current online and cached data for all ${schools.length} schools. No production state was changed.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
  console.log(message);
} finally {await rm(temp, {recursive: true, force: true});}
