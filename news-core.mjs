export const PAGE_SIZE = 24;
export const EXCLUDED_CATEGORY = '教育局消息';

export const sourcesOf = article => (article.sources || [article.source]).filter(Boolean);
export const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-TW').trim();
export const defaultSelection = categories => new Set(
  categories.filter(category => category.name !== EXCLUDED_CATEGORY).map(category => category.id),
);

export function readState(search, categories) {
  const params = new URLSearchParams(search);
  const known = new Set(categories.map(category => category.id));
  const selected = params.has('categories')
    ? new Set(params.get('categories').split(',').filter(id => known.has(id)))
    : defaultSelection(categories);
  const requestedPage = Number(params.get('page'));
  return {
    selected,
    query: (params.get('q') || '').trim(),
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
  };
}

export function stateURL(href, state, categories) {
  const url = new URL(href);
  const selected = categories.filter(category => state.selected.has(category.id)).map(category => category.id);
  const defaults = [...defaultSelection(categories)];
  if (selected.join(',') === defaults.join(',')) url.searchParams.delete('categories');
  else url.searchParams.set('categories', selected.join(','));
  if (state.query.trim()) url.searchParams.set('q', state.query.trim());
  else url.searchParams.delete('q');
  if (state.page > 1) url.searchParams.set('page', state.page);
  else url.searchParams.delete('page');
  return url;
}

export function searchText(article) {
  return normalize([
    article.title, article.summary, ...sourcesOf(article),
    ...(article.attachments || []).map(item => typeof item === 'string' ? item : item.name),
  ].filter(Boolean).join(' '));
}

export function filterArticles(articles, state, categories) {
  const names = new Set(categories.filter(category => state.selected.has(category.id)).map(category => category.name));
  const query = normalize(state.query);
  return articles.filter(article => sourcesOf(article).some(source => names.has(source))
    && (!query || (article.searchText || searchText(article)).includes(query)));
}

export function pageOf(articles, requestedPage) {
  const totalPages = Math.max(1, Math.ceil(articles.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  return {page, totalPages, items: articles.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)};
}

export function safeURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export const articleTarget = article => safeURL(article.url) || safeURL(article.sourceUrl) || safeURL(article.siteUrl);
export const articleLabel = article => safeURL(article.url) ? '閱讀公告' : '前往來源網站查看';

export function searchExcerpt(summary, query) {
  const text = String(summary || '').normalize('NFKC');
  const term = normalize(query);
  const index = normalize(text).indexOf(term);
  if (!term || index < 0) return '';
  const start = Math.max(0, index - 35);
  const end = Math.min(text.length, Math.max(start + 140, index + term.length));
  return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// Compare identities within a school's scope; never merge on a title alone.
export function canonicalArticleURL(value) {
  const safe = safeURL(value);
  if (!safe) return '';
  const url = new URL(safe);
  url.hash = '';
  const nss = url.pathname.match(/\/nss\/main\/freeze\/.*\/([a-f0-9]{24})\/?$/i);
  if (nss) return url.origin + '/nss/article/' + nss[1].toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

function guidOf(article) {
  if (article.guid !== undefined) return article.guid;
  const legacy = (article.id || '').split(':').slice(2).join(':');
  return legacy && legacy !== article.title ? legacy : '';
}

export function articleIdentity(article, index = 0) {
  const scope = [...(article.schools || ['仁愛國小'])].sort().join('|');
  const url = canonicalArticleURL(article.url);
  // A real article URL is safer than inconsistent feed GUIDs.
  if (url) return JSON.stringify([scope, 'url', url]);
  const guid = guidOf(article);
  if (guid) {
    return JSON.stringify([scope, 'guid', article.sourceId || article.sourceUrl || article.source, guid]);
  }
  return JSON.stringify([scope, 'record', article.sourceId || article.source, article.id || index]);
}

export function mergeAttachments(values) {
  const merged = new Map();
  for (const item of values.filter(Boolean)) {
    const name = typeof item === 'string' ? item : item.name;
    if (!name) continue;
    const url = typeof item === 'object' ? safeURL(item.url) : '';
    const blankKey = JSON.stringify([name, '']);
    if (url) merged.delete(blankKey);
    else if ([...merged.values()].some(existing => typeof existing === 'object' && existing.name === name && safeURL(existing.url))) continue;
    merged.set(JSON.stringify([name, url]), typeof item === 'object' ? {...item} : item);
  }
  return [...merged.values()];
}

export function originalLinks(article) {
  const links = new Map();
  for (const origin of article.origins || [article]) {
    const url = safeURL(origin.url);
    if (!url) continue;
    if (!links.has(url)) links.set(url, {url, sources: []});
    const item = links.get(url);
    item.sources = [...new Set([...item.sources, ...sourcesOf(origin)])];
  }
  return [...links.values()];
}

export function mergeArticles(articles) {
  const merged = new Map();
  articles.forEach((article, index) => {
    const key = articleIdentity(article, index);
    const origins = article.origins || [{
      id: article.id, sourceId: article.sourceId, source: article.source,
      sourceUrl: article.sourceUrl, siteUrl: article.siteUrl, url: article.url,
      attachments: mergeAttachments(article.attachments || []),
    }];
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {...article, schools: [...(article.schools || ['仁愛國小'])], sources: [...sourcesOf(article)],
        attachments: mergeAttachments(article.attachments || []), origins: [...origins]});
      return;
    }
    current.sources = [...new Set([...current.sources, ...sourcesOf(article)])];
    current.origins.push(...origins);
    current.attachments = mergeAttachments([...current.attachments, ...(article.attachments || [])]);
    if ((article.summary || '').length > (current.summary || '').length) current.summary = article.summary;
    if ((Date.parse(article.published) || 0) > (Date.parse(current.published) || 0)) {
      current.published = article.published;
      if (safeURL(article.url)) current.url = article.url;
    }
  });
  return [...merged.values()].sort((left, right) => (
    (Date.parse(right.published) || 0) - (Date.parse(left.published) || 0)
    || String(left.id || '').localeCompare(String(right.id || ''))
  ));
}
