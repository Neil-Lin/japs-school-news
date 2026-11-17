import {lunchSourceURL, taipeiDay} from './lunch-client.mjs';
import {loadCurrentLunch} from './lunch-live.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const timeFormat = new Intl.DateTimeFormat('zh-TW', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei'});
const dateFormat = new Intl.DateTimeFormat('zh-TW', {year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Taipei'});
const fmtTime = value => value ? timeFormat.format(new Date(value)) : '未提供';
const fmtDay = value => dateFormat.format(new Date(value + 'T12:00:00+08:00'));

export function lunchPresentation(bundle, now = new Date()) {
  const {snapshot, entry, manifest, mode} = bundle;
  const today = taipeiDay(now);
  const notices = [];
  if (bundle.officialUnavailable) notices.push('目前無法取得官方最新資料，顯示最近一次完整資料。');
  else if (mode === 'cached') notices.push('目前無法取得最新資料，顯示此裝置上次儲存的菜單。');
  if (snapshot && snapshot.mealDate !== today) notices.push(`目前顯示 ${fmtDay(snapshot.mealDate)} 的資料，請留意供餐日期。`);
  if (now.getTime() - Date.parse(manifest.checkedAt) > 24 * 60 * 60 * 1000) notices.push('午餐資料已超過 24 小時未檢查，最新內容請至官方確認。');
  if (entry.status === 'partial') notices.push(snapshot ? '本次更新不完整，目前保留上次完整菜單。' : '本次午餐資料尚未完整取得。');
  if (entry.status === 'error') notices.push(snapshot ? '最近一次更新未成功，目前保留上次完整菜單。' : '目前暫時無法取得午餐資料。');
  const dishes = snapshot?.providers.reduce((sum, provider) => sum + provider.dishes.length, 0) || 0;
  return {notices, dishes, date: snapshot?.mealDate || manifest.requestedDate,
    summary: snapshot?.status === 'available' ? `${snapshot.providers.length} 家供餐單位・${dishes} 道菜`
      : snapshot?.status === 'no-record' ? (snapshot.mealDate === today ? '今日尚無菜單資料' : '此日期尚無菜單資料') : '午餐資料暫時無法取得'};
}

function renderIngredient(item) {
  const certifications = item.certifications.filter(cert => cert.name).map(cert => cert.name + (cert.id ? `（${cert.id}）` : ''));
  return `<li class="lunch-ingredient"><strong>${esc(item.name)}</strong>
    <dl><div><dt>產地</dt><dd>${esc(item.origin || '未提供')}</dd></div>
      <div><dt>製造商</dt><dd>${esc(item.manufacturer || '未提供')}</dd></div>
      <div><dt>供應商</dt><dd>${esc(item.supplier || '未提供')}</dd></div></dl>
    ${!item.stockDate ? '<p class="lunch-registration">進貨資訊尚未登錄</p>' : ''}
    ${certifications.length ? `<p class="lunch-certification">來源登錄驗證：${esc(certifications.join('、'))}</p>` : ''}</li>`;
}

function renderDish(dish, seasoning = false) {
  return `<li><details class="lunch-dish${seasoning ? ' lunch-seasoning' : ''}">
    <summary><span class="lunch-dish-title">${dish.type ? `<span class="lunch-type">${esc(dish.type)}</span>` : ''}<strong>${esc(dish.name)}</strong></span><span class="lunch-disclosure"><span class="lunch-detail-closed">${seasoning ? '調味料明細' : '食材明細'}</span><span class="lunch-detail-open">收合明細</span><span class="lunch-chevron" aria-hidden="true"></span></span></summary>
    <div class="lunch-dish-body">
      ${dish.ingredientStatus === 'partial' ? '<p class="lunch-registration">部分食材尚未登錄進貨資訊。</p>' : ''}
      ${dish.ingredients.length ? `<ul class="lunch-ingredients">${dish.ingredients.map(renderIngredient).join('')}</ul>` : '<p class="lunch-empty-detail">此菜色尚無食材登錄資料，可至官方確認。</p>'}
    </div></details></li>`;
}

export function renderLunch(bundle, now = new Date()) {
  const {snapshot, entry, manifest} = bundle;
  const view = lunchPresentation(bundle, now);
  const issues = entry.errors.map(error => `${error.providerName || '供餐資料'}${error.dishName ? '・' + error.dishName : ''}：${error.scope === 'ingredient' ? '食材明細未取得' : error.scope === 'dish' ? '菜色資料未取得' : '供餐資料未取得'}`);
  return `<div class="lunch-overview"><p class="lunch-label">供餐日期</p><h3>${esc(fmtDay(view.date))}</h3>
      <p class="lunch-count">${esc(view.summary)}</p>
      <p class="lunch-timestamp">${bundle.origin === 'official' ? '官方資料讀取' : '最近檢查'} <time datetime="${esc(manifest.checkedAt)}">${esc(fmtTime(manifest.checkedAt))}</time>${snapshot && bundle.origin !== 'official' ? `・本站資料更新 <time datetime="${esc(snapshot.fetchedAt)}">${esc(fmtTime(snapshot.fetchedAt))}</time>` : ''}</p></div>
    ${view.notices.length ? `<aside class="lunch-notices" aria-label="午餐資料提醒">${view.notices.map(note => `<p>${esc(note)}</p>`).join('')}
      ${issues.length ? `<details class="lunch-issues"><summary>查看缺少的資料（${issues.length}）</summary><ul>${issues.map(issue => `<li>${esc(issue)}</li>`).join('')}</ul></details>` : ''}</aside>` : ''}
    ${snapshot?.status === 'available' ? `<p class="lunch-guide">依供餐單位分組，點開菜色查看食材、產地與供應商。</p>
      ${snapshot.providers.map((provider, index) => `<section class="lunch-provider" aria-labelledby="lunchProvider${index}">
        <div class="lunch-provider-heading"><h4 id="lunchProvider${index}">${esc(provider.name)}</h4><p>官方上傳 ${esc(fmtTime(provider.uploadedAt))}</p></div>
        <ul class="lunch-dishes">${provider.dishes.map(dish => renderDish(dish)).join('')}</ul>
        ${provider.seasonings.length ? `<ul class="lunch-dishes lunch-seasonings">${provider.seasonings.map(dish => renderDish(dish, true)).join('')}</ul>` : ''}
      </section>`).join('')}` : `<div class="lunch-empty"><p>可稍後重新讀取，或前往官方查看登錄情況。</p><button type="button" class="lunch-retry" data-lunch-retry>重新讀取</button></div>`}`;
}

export function setupLunchDialog() {
  const trigger = document.querySelector('#lunchOpen');
  const dialog = document.querySelector('#lunchDialog');
  const schoolSlug = document.body.dataset.school;
  const schoolId = document.body.dataset.lunchSchoolId;
  const schoolName = document.body.dataset.lunchSchoolName;
  if (!trigger || !dialog || !schoolId) return;
  const content = dialog.querySelector('#lunchContent');
  const status = dialog.querySelector('#lunchStatus');
  const source = dialog.querySelector('#lunchSource');
  const close = dialog.querySelector('#lunchClose');
  let controller, serial = 0, scroll, bodyStyles, restoreFocus, openedURL, pendingPop;
  let restoration;
  const historyKey = '__schoolNewsLunch';

  function releaseHistory() {
    if (restoration !== undefined) setTimeout(() => {
      if (!dialog.open) {
        history.scrollRestoration = restoration;
        restoration = undefined;
      }
    }, 0);
  }

  function restorePosition() {
    const position = scroll;
    // Commit the change from a fixed body before restoring page coordinates.
    document.body.getBoundingClientRect();
    window.scrollTo(position.x, position.y);
    // A history traversal may apply its own persisted scroll after popstate.
    setTimeout(() => {
      if (!dialog.open) window.scrollTo(position.x, position.y);
    }, 0);
  }

  function closeDialog() {
    if (!dialog.open) return;
    serial++;
    controller?.abort();
    dialog.close();
    trigger.setAttribute('aria-expanded', 'false');
    for (const [key, value] of Object.entries(bodyStyles)) document.body.style[key] = value;
    restorePosition();
    if (restoreFocus?.isConnected) restoreFocus.focus({preventScroll: true});
  }

  function requestClose() {
    if (!dialog.open) return;
    if (history.state?.[historyKey] === schoolSlug) {
      pendingPop = openedURL;
      history.back();
    } else releaseHistory();
    closeDialog();
  }

  async function readLunch() {
    controller?.abort();
    controller = new AbortController();
    const current = ++serial;
    content.innerHTML = '';
    content.setAttribute('aria-busy', 'true');
    status.classList.remove('sr-only');
    status.textContent = '正在讀取本校午餐資料…';
    source.href = lunchSourceURL(schoolId, taipeiDay());
    dialog.querySelector('.lunch-scroll').scrollTop = 0;
    try {
      const bundle = await loadCurrentLunch({baseURL: document.baseURI, schoolSlug, schoolId, schoolName, signal: controller.signal});
      if (!dialog.open || current !== serial) return;
      content.innerHTML = renderLunch(bundle);
      source.href = bundle.snapshot?.sourceUrl || lunchSourceURL(schoolId, bundle.manifest.requestedDate);
      const view = lunchPresentation(bundle);
      status.classList.add('sr-only');
      status.textContent = bundle.snapshot?.status === 'available' ? `已載入 ${view.dishes} 道菜。${view.notices.length ? '請留意下方資料提醒。' : ''}` : view.summary;
    } catch (error) {
      if (!dialog.open || current !== serial) return;
      status.textContent = '暫時無法載入午餐資料';
      content.innerHTML = '<div class="lunch-empty"><p>目前無法取得午餐，且此裝置尚無可用的本校儲存資料。</p><p>請確認網路後重試，或前往官方查看。</p><button type="button" class="lunch-retry" data-lunch-retry>重新讀取</button></div>';
    } finally {
      if (current === serial) content.removeAttribute('aria-busy');
    }
  }

  function openDialog(fromHistory = false) {
    if (dialog.open || pendingPop) return;
    if (typeof dialog.showModal !== 'function') {
      window.open(lunchSourceURL(schoolId, taipeiDay()), '_blank', 'noopener');
      return;
    }
    // Safari does not always focus a button on pointer activation.
    restoreFocus = trigger;
    scroll = {x: window.scrollX, y: window.scrollY};
    openedURL = location.href;
    restoration ??= history.scrollRestoration;
    history.scrollRestoration = 'manual';
    if (!fromHistory) history.pushState({...history.state, [historyKey]: schoolSlug}, '', openedURL);
    const keys = ['position', 'top', 'left', 'width', 'overflow', 'paddingRight'];
    bodyStyles = Object.fromEntries(keys.map(key => [key, document.body.style[key]]));
    const gap = window.innerWidth - document.documentElement.clientWidth;
    if (gap > 0) document.body.style.paddingRight = (parseFloat(getComputedStyle(document.body).paddingRight) + gap) + 'px';
    Object.assign(document.body.style, {position: 'fixed', top: -scroll.y + 'px', left: -scroll.x + 'px', width: '100%', overflow: 'hidden'});
    dialog.showModal();
    close.focus({preventScroll: true});
    trigger.setAttribute('aria-expanded', 'true');
    readLunch();
  }

  trigger.addEventListener('click', () => openDialog());
  close.addEventListener('click', requestClose);
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('button:not([disabled]), a[href], summary, [tabindex="0"]')]
      .filter(node => node.getClientRects().length);
    const first = targets[0], last = targets.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus({preventScroll: true});
    }
  });
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-lunch-retry]')) readLunch();
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose();
    }
  });
  // Registered before the announcement popstate handler: closing this layer
  // consumes only its own history entry, leaving announcement DOM/state intact.
  window.addEventListener('popstate', event => {
    if (pendingPop) {
      const sameURL = location.href === pendingPop;
      pendingPop = undefined;
      if (sameURL) restorePosition();
      releaseHistory();
      if (sameURL) event.stopImmediatePropagation();
    } else if (dialog.open && event.state?.[historyKey] !== schoolSlug) {
      const sameURL = location.href === openedURL;
      closeDialog();
      releaseHistory();
      if (sameURL) event.stopImmediatePropagation();
    } else if (!dialog.open && event.state?.[historyKey] === schoolSlug) {
      openDialog(true);
      event.stopImmediatePropagation();
    }
  });
  window.addEventListener('pagehide', () => { closeDialog(); releaseHistory(); });
  if (history.state?.[historyKey] === schoolSlug) openDialog(true);
}
