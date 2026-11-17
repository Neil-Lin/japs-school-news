import {
  articleLabel, articleTarget, defaultSelection, filterArticles, isDefaultExcluded,
  mergeArticles, normalize, pageOf, readState, safeURL, searchExcerpt, searchText,
  sourcesOf, stateURL, originalLinks,
} from './news-core.mjs';
import {loadSnapshot} from './data-client.mjs';
import {setupLunchDialog} from './lunch-ui.mjs';
import {setupSchoolInfoDialog, showOpeningAnnouncements} from './school-info-ui.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]
));
const dateFormatter = new Intl.DateTimeFormat('zh-TW', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei',
});
const shortFormatter = new Intl.DateTimeFormat('zh-TW', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei',
});
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});
const fmt = (value, formatter = dateFormatter) => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? formatter.format(date) : '時間未提供';
};
const highlight = (text, query) => {
  const value = String(text || '');
  const term = normalize(query);
  const index = term ? value.toLocaleLowerCase('zh-TW').indexOf(term) : -1;
  if (index < 0) return esc(value);
  return esc(value.slice(0, index)) + '<mark>' + esc(value.slice(index, index + term.length))
    + '</mark>' + esc(value.slice(index + term.length));
};

if ('serviceWorker' in navigator && (location.protocol === 'https:'
  || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI), {
      scope: new URL('./', document.baseURI).pathname,
    }).catch(error => console.warn('PWA service worker registration failed', error));
  });
}

const loadData = () => loadSnapshot({baseURL: document.baseURI, schoolSlug: document.body.dataset.school});
let uiController;

function showDataState({data, mode, cacheAvailable}) {
  const node = document.querySelector('#cacheStatus');
  const stale = Date.now() - Date.parse(data.updatedAt) > 24 * 60 * 60 * 1000;
  const notes = [];
  if (mode === 'cached') notes.push('無法取得最新資料，目前顯示上次成功的公告。');
  if (stale) notes.push('來源超過 24 小時未檢查，公告可能尚未更新。');
  if (mode !== 'cached' && !cacheAvailable) notes.push('這次資料無法儲存供離線閱讀，請保持網路連線。');
  node.textContent = notes.join(' ');
  node.hidden = !notes.length;
  return {stale};
}

function setSchoolHeader(config, activeSchool) {
  const {schools, schoolMeta} = config;
  const root = new URL('./', document.baseURI);
  document.querySelector('#schoolSwitch').innerHTML = schools.map(school => (
    `<a class="school-tab ${school === activeSchool ? 'active' : ''}" href="${esc(new URL(schoolMeta[school].slug + '/', root).href)}" ${school === activeSchool ? 'aria-current="page"' : ''}>${esc(school)}</a>`
  )).join('');
  document.querySelector('#schoolTitle').innerHTML = esc(activeSchool) + ' <em>消息牆</em>';
  const official = document.querySelector('#officialSite');
  official.href = safeURL(schoolMeta[activeSchool].site);
  official.setAttribute('aria-label', activeSchool + '官方網站（另開分頁）');
}

function start(bundle) {
  const {config, data, mode} = bundle;
  uiController?.abort();
  uiController = new AbortController();
  const on = (target, name, handler) => target.addEventListener(name, handler, {signal: uiController.signal});
  const schoolMeta = config.schoolMeta || {};
  const schools = config.schools || Object.keys(schoolMeta);
  const activeSchool = schools.find(school => location.pathname.split('/').includes(schoolMeta[school]?.slug)) || schools[0];
  const articles = (data.premerged ? data.articles : mergeArticles(data.articles || []))
    .filter(article => (article.schools || ['仁愛國小']).includes(activeSchool))
    .map(article => ({...article, searchText: searchText(article)}));
  const groups = [...new Set([
    ...config.sources.filter(source => source.school === activeSchool || source.schools?.includes(activeSchool)).map(source => source.name),
    ...articles.flatMap(sourcesOf),
  ])];
  const categories = groups.map(name => ({name, id: config.categoryIds[name]}));
  if (categories.some(category => !category.id)) throw new Error('缺少分類識別碼');

  const search = document.querySelector('#search');
  const filters = document.querySelector('#filters');
  const feed = document.querySelector('#feed');
  const pagination = document.querySelector('#pagination');
  const resultHeading = document.querySelector('#resultHeading');
  const resultStatus = document.querySelector('#resultStatus');
  const filterSummary = document.querySelector('#filterSummary');
  const clearSearch = document.querySelector('#clearSearch');
  const refresh = document.querySelector('#refreshData');
  const today = dayFormatter.format(new Date());
  const todayCount = articles.filter(article => article.published && !Number.isNaN(Date.parse(article.published))
    && dayFormatter.format(new Date(article.published)) === today).length;
  document.querySelector('#updated').textContent = data.updatedAt
    ? '最近檢查 ' + fmt(data.updatedAt, shortFormatter) + '・今日新增 ' + todayCount + ' 筆' : '尚未更新';
  const statuses = (data.sourceStatus || []).filter(item => !item.schools || item.schools.includes(activeSchool));
  const issues = statuses.filter(item => item.status !== 'ok');
  document.querySelector('#sourceStatus').textContent = issues.length
    ? '部分來源需要注意：' + issues.map(item => item.name).join('、') : '本校所有來源最近更新正常';
  document.querySelector('#sourceDetails').innerHTML = statuses.map(item => (
    `<li><strong>${esc(item.name)}</strong>・${item.status === 'error' ? '更新失敗' : item.status === 'warning' ? '有警告' : '正常'}<br>
      最近成功：${item.lastSuccessfulAt ? esc(fmt(item.lastSuccessfulAt)) : '尚無成功紀錄'}
      ${item.error ? `<p>${esc(item.error)}</p>` : ''}
      ${(item.warnings || []).map(warning => `<p>${esc(warning)}</p>`).join('')}</li>`
  )).join('');
  const {stale} = showDataState(bundle);
  const hint = document.querySelector('#statusHint');
  hint.textContent = mode === 'cached' ? '使用上次資料' : stale ? '資料待更新' : issues.length ? '部分來源異常' : '更新詳情';
  hint.classList.toggle('warning', mode === 'cached' || stale || issues.length > 0);

  setSchoolHeader(config, activeSchool);
  showOpeningAnnouncements(articles, schoolMeta[activeSchool].site);

  filters.innerHTML = [{id: '__all', name: '全部'}, ...categories].map(category => (
    `<label class="filter"><input type="checkbox" value="${esc(category.id)}"><span>${esc(category.name)}</span></label>`
  )).join('');
  const allCheckbox = filters.querySelector('input[value="__all"]');
  let state = readState(location.search, categories);
  let editingSearch = false;
  search.value = state.query;

  function renderAttachments(article) {
    const items = (article.attachments || []).filter(Boolean).map(item => {
      const name = typeof item === 'string' ? item : item.name;
      const url = typeof item === 'object' && safeURL(item.url);
      return url
        ? `<a class="attachment" href="${esc(url)}" target="_blank" rel="noopener">附件：${highlight(name, state.query)}<span class="sr-only">（另開分頁）</span></a>`
        : `<span class="attachment">附件：${highlight(name, state.query)}</span>`;
    });
    if (!items.length) return '';
    return '<div class="attachments">' + items.slice(0, 2).join('') + (items.length > 2
      ? `<details class="more-attachments"><summary>還有 ${items.length - 2} 個附件</summary>${items.slice(2).join('')}</details>` : '') + '</div>';
  }

  function renderOriginalLinks(article) {
    const links = originalLinks(article);
    if (links.length < 2) return '';
    return `<details class="original-links"><summary>各來源原文（${links.length}）</summary>${links.map(link => (
      `<a class="attachment" href="${esc(link.url)}" target="_blank" rel="noopener">${esc(link.sources.join('、') || '原文')}<span class="sr-only">（另開分頁）</span></a>`
    )).join('')}</details>`;
  }

  function renderArticle(article) {
    const target = articleTarget(article);
    const title = highlight(article.title, state.query);
    const excerpt = searchExcerpt(article.summary, state.query);
    return `<article class="card">
      <div class="meta"><span class="badges">${sourcesOf(article).map(source => `<span class="tag">${highlight(source, state.query)}</span>`).join('')}</span><time ${article.published ? `datetime="${esc(article.published)}"` : ''}>${esc(fmt(article.published))}</time></div>
      <h3>${target ? `<a href="${esc(target)}" target="_blank" rel="noopener">${title}<span class="sr-only">（另開分頁）</span></a>` : title}</h3>
      ${excerpt ? `<p class="summary match-excerpt">${highlight(excerpt, state.query)}</p>` : ''}
      ${target ? `<a class="read" href="${esc(target)}" target="_blank" rel="noopener" aria-label="${esc(articleLabel(article) + '：' + article.title + '（另開分頁）')}">${articleLabel(article)} <span aria-hidden="true">↗</span></a>` : '<p class="summary">來源未提供原文連結。</p>'}
      ${renderAttachments(article)}
      ${renderOriginalLinks(article)}
    </article>`;
  }

  function paint() {
    const list = filterArticles(articles, state, categories);
    const {page, totalPages, items} = pageOf(list, state.page);
    state.page = page;
    for (const input of filters.querySelectorAll('input')) {
      input.checked = input === allCheckbox ? state.selected.size === categories.length : state.selected.has(input.value);
      input.closest('.filter').classList.toggle('active', input.checked);
    }
    allCheckbox.indeterminate = state.selected.size > 0 && state.selected.size < categories.length;
    const omitted = categories.filter(category => isDefaultExcluded(category) && !state.selected.has(category.id));
    filterSummary.textContent = state.selected.size === categories.length ? '已選全部分類'
      : `已選 ${state.selected.size}/${categories.length} 類${omitted.length ? '・未含' + omitted.map(category => category.name).join('、') : ''}`;
    const message = !state.selected.size ? '請至少選擇一個分類。' : '目前沒有符合條件的消息。';
    feed.innerHTML = items.length ? items.map(renderArticle).join('')
      : `<div class="empty"><p>${message}</p><button type="button" class="text-button" data-reset>清除搜尋並恢復預設</button></div>`;
    resultStatus.textContent = `${state.query ? `「${state.query}」・` : ''}共 ${list.length} 筆${list.length ? `・第 ${page}/${totalPages} 頁` : ''}`;
    clearSearch.hidden = !search.value;
    const start = Math.min(Math.max(1, page - 2), Math.max(1, totalPages - 4));
    const end = Math.min(totalPages, start + 4);
    pagination.innerHTML = list.length ? `<span class="pagination-total">共 ${totalPages} 頁 ${list.length} 筆</span>
      <button type="button" class="page-nav" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>上一頁</button>
      ${Array.from({length: end - start + 1}, (_, index) => start + index).map(number => `<button type="button" class="page-number ${number === page ? 'active' : ''}" data-page="${number}" aria-label="第 ${number} 頁" ${number === page ? 'aria-current="page"' : ''}>${number}</button>`).join('')}
      <button type="button" class="page-nav" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>下一頁</button>` : '';
  }

  function saveURL(mode = 'push') {
    const url = stateURL(location.href, state, categories);
    if (url.href !== location.href) history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
    const skipURL = new URL(location.href);
    skipURL.hash = 'main';
    document.querySelector('.skip-link').href = skipURL.href;
  }

  function change(mode = 'push') {
    paint();
    saveURL(mode);
  }

  function reset() {
    state = {selected: defaultSelection(categories), query: '', page: 1};
    search.value = '';
    editingSearch = false;
    change();
  }

  on(filters, 'change', event => {
    const input = event.target;
    if (input === allCheckbox) state.selected = input.checked ? new Set(categories.map(category => category.id)) : new Set();
    else if (input.checked) state.selected.add(input.value);
    else state.selected.delete(input.value);
    state.page = 1;
    editingSearch = false;
    change();
  });
  const updateSearch = () => {
    const query = search.value.trim();
    if (query === state.query) {
      clearSearch.hidden = !search.value;
      return;
    }
    state.query = query;
    state.page = 1;
    change(editingSearch ? 'replace' : 'push');
    editingSearch = true;
  };
  on(search, 'input', event => {
    if (!event.isComposing) updateSearch();
  });
  on(search, 'compositionend', updateSearch);
  on(search, 'blur', () => { editingSearch = false; });
  on(clearSearch, 'click', () => {
    search.value = '';
    editingSearch = false;
    updateSearch();
    search.focus();
  });
  on(document.querySelector('#resetFilters'), 'click', reset);
  on(feed, 'click', event => {
    if (event.target.closest('[data-reset]')) {
      reset();
      search.focus();
    }
  });
  on(pagination, 'click', event => {
    const button = event.target.closest('button[data-page]');
    if (!button || button.disabled) return;
    state.page = Number(button.dataset.page);
    editingSearch = false;
    change();
    resultHeading.focus({preventScroll: true});
    document.querySelector('#results').scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start',
    });
  });
  on(window, 'popstate', () => {
    state = readState(location.search, categories);
    search.value = state.query;
    editingSearch = false;
    change('replace');
  });
  on(refresh, 'click', async () => {
    saveURL('replace');
    refresh.disabled = true;
    refresh.textContent = '檢查中…';
    try {
      const next = await loadData();
      if (next.mode === 'network') start(next);
      else {
        showDataState({...bundle, mode: 'cached'});
        hint.textContent = '使用上次資料';
      }
    } catch {
      showDataState({...bundle, mode: 'cached'});
      hint.textContent = '使用上次資料';
    } finally {
      refresh.disabled = false;
      refresh.textContent = '檢查最新資料';
    }
  });
  change('replace');
}

function showError(error) {
  console.error(error);
  if (error.config && error.schoolSlug) {
    const school = error.config.schools.find(name => error.config.schoolMeta?.[name]?.slug === error.schoolSlug);
    if (school) setSchoolHeader(error.config, school);
  }
  document.querySelector('#search').disabled = true;
  document.querySelector('#resetFilters').disabled = true;
  document.querySelector('#updated').textContent = '暫時無法取得更新資料';
  document.querySelector('#statusHint').textContent = '載入失敗';
  document.querySelector('#sourceStatus').textContent = '請確認網路連線後重試。';
  document.querySelector('#resultStatus').textContent = '公告載入失敗';
  const message = error.code === 'school-data-unavailable' ? error.message : '暫時無法載入消息資料，請稍後再試。';
  document.querySelector('#feed').innerHTML = '<div class="empty"><p>' + esc(message) + '</p><button type="button" id="retryLoad" class="text-button">重新載入</button></div>';
  document.querySelector('#retryLoad').onclick = () => location.reload();
}

setupLunchDialog();
setupSchoolInfoDialog();
loadData().then(start).catch(showError);
