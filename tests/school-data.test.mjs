import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mergeArticles, originalLinks, filterArticles, readState, defaultSelection, pageOf, searchText} from '../news-core.mjs';
import {buildSchoolArtifacts} from '../scripts/build_school_data.mjs';
import {hydrateSchoolData, validateSchoolData} from '../school-data.mjs';
import {digest} from '../data-client.mjs';

const [config, raw, version] = await Promise.all(['config.json', 'data/articles.json', 'data/version.json'].map(async path => JSON.parse(await readFile(new URL('../' + path, import.meta.url)))));
const merged = mergeArticles(raw.articles);
const model = article => ({
  id: article.id, title: article.title, published: article.published, url: article.url,
  summary: article.summary, sources: article.sources, attachments: article.attachments,
  links: originalLinks(article), sourceUrl: article.sourceUrl, siteUrl: article.siteUrl,
  origins: article.origins.map(origin => ({id: origin.id, sourceId: origin.sourceId, source: origin.source, url: origin.url, attachments: origin.attachments})),
});

test('every generated school file exactly preserves the previous display, order, links, and attachments', async () => {
  for (const school of config.schools) {
    const slug = config.schoolMeta[school].slug;
    const wire = JSON.parse(await readFile(new URL(`../data/schools/${slug}.json`, import.meta.url)));
    validateSchoolData(config, wire, slug);
    assert.equal(await digest(wire.articles), version.schools[slug].dataVersion);
    const hydrated = hydrateSchoolData(config, wire, version);
    const expected = merged.filter(article => article.schools.includes(school));
    assert.deepEqual(hydrated.articles.map(model), expected.map(model), school);
    assert.ok(hydrated.articles.every(article => article.schools.length === 1 && article.schools[0] === school));
  }
});

test('default, all, multiselect, yearly search, and final-page results remain identical for every school', async () => {
  for (const school of config.schools) {
    const slug = config.schoolMeta[school].slug;
    const wire = JSON.parse(await readFile(new URL(`../data/schools/${slug}.json`, import.meta.url)));
    const current = hydrateSchoolData(config, wire, version).articles;
    const previous = merged.filter(article => article.schools.includes(school));
    const categories = [...new Set(previous.flatMap(article => article.sources))].map(name => ({name, id: config.categoryIds[name]}));
    const terms = ['', '新生', 'pdf', '家長', 'AI', '國民健康操', '沒有符合的公告XYZ'];
    const earliest = previous.at(-1);
    if (earliest) terms.push(earliest.title);
    for (const selected of [defaultSelection(categories), new Set(categories.map(category => category.id)), new Set(categories.slice(0, 2).map(category => category.id)), new Set()]) {
      for (const query of terms) {
        const state = {selected, query, page: 1};
        const oldResults = filterArticles(previous, state, categories);
        const newResults = filterArticles(current, state, categories);
        assert.deepEqual(newResults.map(article => article.id), oldResults.map(article => article.id), school + query);
        assert.deepEqual(pageOf(newResults, 999).items.map(article => article.id), pageOf(oldResults, 999).items.map(article => article.id));
      }
    }
    assert.deepEqual(current.map(searchText), previous.map(searchText));
  }
});

test('generation is deterministic and does not mutate archival input', () => {
  const before = JSON.stringify(raw);
  const a = buildSchoolArtifacts(config, raw);
  const b = buildSchoolArtifacts(config, raw);
  assert.deepEqual(a.schools, b.schools);
  assert.deepEqual([...a.artifacts], [...b.artifacts]);
  assert.equal(JSON.stringify(raw), before);
});

test('cross-school origins, unsafe URLs, and an incorrect school label are rejected', () => {
  const wire = structuredClone(buildSchoolArtifacts(config, raw).artifacts.get('renai'));
  wire.articles[0].sourceIds[0] = config.sources.find(source => source.school === '博愛國小').id;
  assert.throws(() => validateSchoolData(config, wire, 'renai'), /其他學校|原始來源/);
  const bad = structuredClone(buildSchoolArtifacts(config, raw).artifacts.get('renai'));
  bad.articles[0].url = 'javascript:bad()';
  assert.throws(() => validateSchoolData(config, bad, 'renai'), /欄位/);
  bad.school = '博愛國小';
  assert.throws(() => validateSchoolData(config, bad, 'renai'), /不相容/);
});
