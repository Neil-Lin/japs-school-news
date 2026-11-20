import {setupDialog} from './dialog-controller.mjs';
import {safeURL} from './news-core.mjs';
import {esc, taipeiFormat} from './format.mjs';
import {reviewState} from './news-health.mjs';


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
  const fmt = taipeiFormat('zh-TW', {year: 'numeric', month: 'numeric', day: 'numeric'});
  node.innerHTML = `<h4>近期場地相關公告</h4><p>依公告日期排列，請點原文確認適用日期與範圍。</p><ul>${notices.map(item => `<li><a href="${esc(safeURL(item.url))}" target="_blank" rel="noopener">${esc(item.title)}<span class="sr-only">（另開分頁）</span></a><time datetime="${esc(item.published)}">${esc(fmt.format(new Date(item.published)))}</time></li>`).join('')}</ul>`;
}

export function setupSchoolInfoDialog() {
  const trigger = document.querySelector('#schoolInfoOpen');
  const dialog = document.querySelector('#schoolInfoDialog');
  if (!trigger || trigger.hidden || !dialog) return;
  const updateReviews = () => {
    let overdue = false;
    for (const node of dialog.querySelectorAll('[data-review-date]')) {
      const state = reviewState(node.dataset.reviewDate, Date.now(), Number(node.dataset.reviewDays));
      node.querySelector('[data-review-status]').textContent = state.overdue ? '・待重新查核' : '';
      overdue ||= state.overdue;
    }
    dialog.querySelector('[data-review-summary]').textContent = overdue ? '・有資料待重新查核' : '';
  };
  updateReviews();
  setupDialog({trigger, dialog, close: document.querySelector('#schoolInfoClose'),
    historyKey: '__schoolNewsInfo', school: document.body.dataset.school, onOpen: updateReviews});
}
