import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  articleLabel, articleTarget, defaultSelection, filterArticles, isDefaultExcluded, mergeArticles,
  pageOf, readState, searchExcerpt, stateURL,
} from '../news-core.mjs';

const categories = [
  {id: 'general', name: '一般消息'},
  {id: 'parents', name: '親職資訊'},
  {id: 'education', name: '教育局消息'},
];
const articles = [
  {title: '入學', source: '一般消息', summary: '報名時間'},
  {title: '講座', source: '親職資訊', summary: '新生家長說明會'},
  {title: '局端', source: '教育局消息'},
  {title: '跨分類', sources: ['一般消息', '教育局消息']},
  {title: '附件', source: '親職資訊', attachments: [{name: '新生申請.pdf', url: 'https://example.com/file'}]},
];

test('default excludes education-only articles, retaining selected cross-category articles', () => {
  const state = readState('', categories);
  assert.deepEqual([...state.selected], ['general', 'parents']);
  assert.deepEqual(filterArticles(articles, state, categories).map(item => item.title), ['入學', '講座', '跨分類', '附件']);
});

test('teacher training defaults off while parent categories and cross-category articles remain visible', () => {
  const groups = [...categories, {id: 'training', name: '研習資訊'},
    {id: 'teacher-activities', name: '教師研習及活動'}, {id: 'activities', name: '活動資訊'}];
  const records = [...articles, {title: '教師研習', source: '研習資訊'},
    {title: '教師活動', source: '教師研習及活動'}, {title: '親職研習', sources: ['研習資訊', '親職資訊']},
    {title: '親子活動', source: '活動資訊'}];
  const state = readState('', groups);
  assert.deepEqual([...state.selected], ['general', 'parents', 'activities']);
  const titles = filterArticles(records, state, groups).map(article => article.title);
  assert.ok(titles.includes('親職研習'));
  assert.ok(titles.includes('親子活動'));
  assert.ok(!titles.includes('教師研習'));
  assert.ok(!titles.includes('教師活動'));
  const explicit = readState('?categories=training,teacher-activities', groups);
  assert.deepEqual(filterArticles(records, explicit, groups).map(article => article.title), ['教師研習', '教師活動', '親職研習']);
  assert.deepEqual(readState(stateURL('https://school.test/', explicit, groups).search, groups).selected, explicit.selected);
  assert.equal(stateURL('https://school.test/', state, groups).search, '');
  assert.deepEqual(defaultSelection([{id: 'training', name: '教師增能課程'},
    {id: 'teacher-activities', name: '教師活動改名'}]), new Set());
});

test('multiple categories use union, then intersect with summary and attachment search', () => {
  const state = {selected: new Set(['general', 'parents']), query: '新生', page: 1};
  assert.deepEqual(filterArticles(articles, state, categories).map(item => item.title), ['講座', '附件']);
  state.selected = new Set(['general']);
  assert.equal(filterArticles(articles, state, categories).length, 0);
});

test('none is an explicit empty selection; all includes education', () => {
  const none = readState('?categories=', categories);
  assert.equal(filterArticles(articles, none, categories).length, 0);
  const all = readState('?categories=general,parents,education', categories);
  assert.equal(filterArticles(articles, all, categories).length, articles.length);
});

test('URL round-trips multiselect, Chinese query, page, project path and unrelated parameters', () => {
  const state = {selected: new Set(['education', 'parents']), query: '新生 家長', page: 3};
  const url = stateURL('https://example.com/japs-school-news/renai/?ref=shared#results', state, categories);
  assert.equal(url.pathname, '/japs-school-news/renai/');
  assert.equal(url.searchParams.get('ref'), 'shared');
  assert.equal(url.hash, '#results');
  const restored = readState(url.search, categories);
  assert.deepEqual([...restored.selected], ['parents', 'education']);
  assert.equal(restored.query, state.query);
  assert.equal(restored.page, state.page);
});

test('default URL remains clean and an empty selection survives reload', () => {
  const state = {selected: defaultSelection(categories), query: '', page: 1};
  const url = stateURL('https://example.com/renai/?categories=education&q=old&page=3', state, categories);
  assert.equal(url.search, '');
  state.selected.clear();
  const emptyURL = stateURL(url.href, state, categories);
  assert.equal(emptyURL.search, '?categories=');
  assert.equal(readState(emptyURL.search, categories).selected.size, 0);
});

test('untrusted URL values cannot create unknown category state or invalid pages', () => {
  for (const page of ['-1', '1.5', 'Infinity', 'NaN', '9007199254740992']) {
    const state = readState(`?categories=parents,unknown&page=${page}`, categories);
    assert.deepEqual([...state.selected], ['parents']);
    assert.equal(state.page, 1);
  }
});

test('pagination clamps out-of-range restored pages and shows the last article', () => {
  const list = Array.from({length: 49}, (_, id) => ({id}));
  const result = pageOf(list, 999);
  assert.equal(result.page, 3);
  assert.equal(result.totalPages, 3);
  assert.deepEqual(result.items, [{id: 48}]);
  assert.deepEqual(pageOf([], 10), {page: 1, totalPages: 1, items: []});
});

test('no summary still opens the article; unsafe URLs fall back to a source page', () => {
  assert.equal(articleTarget({url: 'https://example.com/article', summary: '', siteUrl: 'https://example.com'}), 'https://example.com/article');
  assert.equal(articleLabel({url: 'https://example.com/article'}), '閱讀公告');
  assert.equal(articleTarget({url: 'javascript:alert(1)', sourceUrl: 'https://example.com/feed', siteUrl: 'https://example.com'}), 'https://example.com/feed');
  assert.equal(articleLabel({url: 'javascript:alert(1)'}), '前往來源網站查看');
  assert.equal(articleTarget({url: 'data:text/html,test'}), '');
});

test('summary excerpt exposes why a hidden-body match appears, including fullwidth input', () => {
  assert.ok(searchExcerpt('前文'.repeat(70) + '新生家長說明會' + '後文'.repeat(100), '新生').includes('新生家長說明會'));
  assert.equal(searchExcerpt('沒有關鍵字', '新生'), '');
  assert.ok(searchExcerpt('ＡＩ新生課程', 'AI').includes('AI'));
});

test('real data: every school has default results and education/teacher training remain opt-in', async () => {
  const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
  const data = JSON.parse(await readFile(new URL('../data/articles.json', import.meta.url)));
  const ids = Object.values(config.categoryIds);
  assert.equal(new Set(ids).size, ids.length);
  for (const source of config.sources) assert.match(config.categoryIds[source.name], /^[a-z0-9-]+$/);
  const merged = mergeArticles(data.articles);
  for (const school of config.schools) {
    const visible = merged.filter(article => article.schools.includes(school));
    const groups = [...new Set(visible.flatMap(article => article.sources))].map(name => ({id: config.categoryIds[name], name}));
    const state = readState('', groups);
    const results = filterArticles(visible, state, groups);
    for (const group of groups) if (isDefaultExcluded(group)) assert.equal(state.selected.has(group.id), false, school + ': ' + group.name);
    assert.ok(results.length > 0, school);
    const selectedNames = new Set(groups.filter(group => state.selected.has(group.id)).map(group => group.name));
    assert.ok(results.every(article => article.sources.some(name => selectedNames.has(name))), school);
    assert.ok(results.length < visible.length, school);
  }
});

test('same title with different documents stays separate; merges sort by published instants', () => {
  const records = [
    {id: 'r:1', title: '每月公告', schools: ['仁愛國小'], source: '一般消息', url: 'https://example.com/doc/1', published: '2026-11-16T01:00:00+08:00'},
    {id: 'r:2', title: '每月公告', schools: ['仁愛國小'], source: '一般消息', url: 'https://example.com/doc/2', published: '2026-11-15T20:00:00Z'},
  ];
  const merged = mergeArticles(records);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'r:2');
});

test('same NSS document in multiple categories retains all links and unions attachments', () => {
  const prefix = 'https://school.test/nss/main/freeze/section/';
  const id = '6af6b6fe72cbb241fab082d6';
  const records = [
    {id: 'r:a', sourceId: 'r-general', source: '一般消息', schools: ['仁愛國小'], title: '公告', url: prefix + 'a/' + id + '?vector=private&static=false', published: '2026-11-14T00:00:00Z', attachments: ['計畫.pdf', '同名.pdf']},
    {id: 'r:b', sourceId: 'r-parent', source: '親職資訊', schools: ['仁愛國小'], title: '轉知：公告', url: prefix + 'b/' + id, published: '2026-11-15T00:00:00Z', attachments: [{name: '計畫.pdf', url: 'https://school.test/a.pdf'}, {name: '同名.pdf', url: 'https://school.test/b.pdf'}, {name: '同名.pdf', url: 'https://school.test/c.pdf'}]},
  ];
  const original = structuredClone(records);
  const [merged] = mergeArticles(records);
  assert.equal(mergeArticles(records).length, 1);
  assert.deepEqual(merged.sources, ['一般消息', '親職資訊']);
  assert.equal(merged.origins.length, 2);
  assert.equal(merged.attachments.length, 3);
  assert.equal(merged.published, '2026-11-15T00:00:00Z');
  assert.deepEqual(records, original);
});

test('GUIDs without URLs are scoped to their source; different schools stay separate', () => {
  const base = {title: '公告', guid: '1', schools: ['仁愛國小'], published: '2026-11-15T00:00:00Z'};
  assert.equal(mergeArticles([{...base, sourceId: 'r-general'}, {...base, sourceId: 'r-parent'}]).length, 2);
  assert.equal(mergeArticles([{...base, url: 'https://example.com/doc/1'}, {...base, schools: ['博愛國小'], url: 'https://example.com/doc/1'}]).length, 2);
  assert.equal(mergeArticles([{...base, sourceId: 'r-general'}, {...base, sourceId: 'r-general', summary: '較完整內文'}]).length, 1);
});

test('canonical article URL ignores query order and trackers but keeps identity parameters', () => {
  const base = {title: '公告', schools: ['仁愛國小']};
  assert.equal(mergeArticles([{...base, url: 'https://example.com/news?s=1&n=2&utm_source=share#top'}, {...base, url: 'https://example.com/news?n=2&s=1'}]).length, 1);
  assert.equal(mergeArticles([{...base, url: 'https://example.com/news?s=1'}, {...base, url: 'https://example.com/news?s=2'}]).length, 2);
});
