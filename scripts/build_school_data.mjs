#!/usr/bin/env node
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {mergeArticles} from '../news-core.mjs';
import {packSchoolData, validateSchoolData} from '../school-data.mjs';

function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');

export function buildSchoolArtifacts(config, data) {
  const merged = mergeArticles(data.articles);
  const artifacts = new Map();
  const schools = {};
  for (const name of config.schools) {
    const slug = config.schoolMeta?.[name]?.slug;
    const payload = packSchoolData(config, merged, slug);
    validateSchoolData(config, payload, slug);
    artifacts.set(slug, payload);
    schools[slug] = {school: name, path: `data/schools/${slug}.json`, dataVersion: hash(payload.articles), articleCount: payload.articles.length};
  }
  return {artifacts, schools};
}

async function main() {
  const [configPath, dataPath, versionPath, directory] = process.argv.slice(2);
  if (!directory) throw new Error('Usage: node build_school_data.mjs CONFIG DATA VERSION OUTPUT_DIRECTORY');
  const [config, data, version] = await Promise.all([configPath, dataPath, versionPath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const {artifacts, schools} = buildSchoolArtifacts(config, data);
  await mkdir(join(directory, 'schools'), {recursive: true});
  for (const [slug, payload] of artifacts) await writeFile(join(directory, 'schools', slug + '.json'), JSON.stringify(payload) + '\n');
  await writeFile(versionPath, JSON.stringify({...version, schoolDataSchemaVersion: 1, schools}, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
