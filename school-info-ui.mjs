import {safeURL} from './news-core.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

export function openingAnnouncements(articles, website, now = Date.now()) {
  const host = new URL(website).hostname;
  return articles.filter(article => {
    const url = safeURL(article.url);
    const published = Date.parse(article.published);
    return url && new URL(url).hostname === host && Number.isFinite(published)
      && published <= now && now - published <= 90 * 86400000
      && /校園|操場|球場|遊戲場/.test(article.title) && /開放|封閉|施工/.test(article.title);
  }).sort((a, b) => Date.parse(b.published) - Date.parse(a.published)).slice(0, 3);
}

export function showOpeningAnnouncements(articles, website) {
  const node = document.querySelector('#schoolOpeningNotices');
  if (!node) return;
  const notices = openingAnnouncements(articles, website);
  node.hidden = !notices.length;
  const fmt = new Intl.DateTimeFormat('zh-TW', {year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Taipei'});
  node.innerHTML = `<h4>近期場地相關公告</h4><p>依公告日期排列，請點原文確認適用日期與範圍。</p><ul>${notices.map(item => `<li><a href="${esc(safeURL(item.url))}" target="_blank" rel="noopener">${esc(item.title)}<span class="sr-only">（另開分頁）</span></a><time datetime="${esc(item.published)}">${esc(fmt.format(new Date(item.published)))}</time></li>`).join('')}</ul>`;
}

export function setupSchoolInfoDialog() {
  const trigger = document.querySelector('#schoolInfoOpen');
  const dialog = document.querySelector('#schoolInfoDialog');
  if (!trigger || trigger.hidden || !dialog) return;
  const close = document.querySelector('#schoolInfoClose');
  const historyKey = '__schoolNewsInfo';
  const school = document.body.dataset.school;
  let position, bodyStyles, openedURL, pendingPop, restoration;

  function releaseHistory() {
    if (restoration !== undefined) setTimeout(() => {
      if (!dialog.open) {
        history.scrollRestoration = restoration;
        restoration = undefined;
      }
    }, 0);
  }

  function restorePosition() {
    const saved = position;
    document.body.getBoundingClientRect();
    window.scrollTo(saved.x, saved.y);
    setTimeout(() => { if (!dialog.open) window.scrollTo(saved.x, saved.y); }, 0);
  }

  function closeDialog() {
    if (!dialog.open) return;
    dialog.close();
    trigger.setAttribute('aria-expanded', 'false');
    for (const [key, value] of Object.entries(bodyStyles)) document.body.style[key] = value;
    restorePosition();
    trigger.focus({preventScroll: true});
  }

  function requestClose() {
    if (!dialog.open) return;
    if (history.state?.[historyKey] === school) {
      pendingPop = openedURL;
      history.back();
    } else releaseHistory();
    closeDialog();
  }

  function openDialog(fromHistory = false) {
    if (dialog.open || pendingPop || document.querySelector('dialog[open]')) return;
    position = {x: window.scrollX, y: window.scrollY};
    openedURL = location.href;
    restoration ??= history.scrollRestoration;
    history.scrollRestoration = 'manual';
    if (!fromHistory) history.pushState({...history.state, [historyKey]: school}, '', openedURL);
    const keys = ['position', 'top', 'left', 'width', 'overflow', 'paddingRight'];
    bodyStyles = Object.fromEntries(keys.map(key => [key, document.body.style[key]]));
    const gap = window.innerWidth - document.documentElement.clientWidth;
    if (gap > 0) document.body.style.paddingRight = (parseFloat(getComputedStyle(document.body).paddingRight) + gap) + 'px';
    Object.assign(document.body.style, {position: 'fixed', top: -position.y + 'px', left: -position.x + 'px', width: '100%', overflow: 'hidden'});
    dialog.showModal();
    dialog.querySelector('.lunch-scroll').scrollTop = 0;
    close.focus({preventScroll: true});
    trigger.setAttribute('aria-expanded', 'true');
  }

  trigger.addEventListener('click', () => openDialog());
  close.addEventListener('click', requestClose);
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('button:not([disabled]), a[href], summary')].filter(node => {
      const collapsed = node.closest('details:not([open])');
      return node.getClientRects().length && (!collapsed || node === collapsed.querySelector('summary'));
    });
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
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose();
  });
  window.addEventListener('popstate', event => {
    if (pendingPop) {
      const sameURL = location.href === pendingPop;
      pendingPop = undefined;
      if (sameURL) restorePosition();
      releaseHistory();
      if (sameURL) event.stopImmediatePropagation();
    } else if (dialog.open && event.state?.[historyKey] !== school) {
      const sameURL = location.href === openedURL;
      closeDialog();
      releaseHistory();
      if (sameURL) event.stopImmediatePropagation();
    } else if (!dialog.open && event.state?.[historyKey] === school) {
      openDialog(true);
      event.stopImmediatePropagation();
    }
  });
  window.addEventListener('pagehide', () => { closeDialog(); releaseHistory(); });
  if (history.state?.[historyKey] === school) openDialog(true);
}
