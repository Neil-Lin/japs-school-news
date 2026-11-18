// Owns one modal history layer. Register before the announcement popstate handler.
export function setupDialog({trigger, dialog, close, historyKey, school, onOpen = () => {}, onClose = () => {}, fallback}) {
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
    onClose();
    dialog.close();
    trigger.setAttribute('aria-expanded', 'false');
    for (const [key, value] of Object.entries(bodyStyles)) document.body.style[key] = value;
    restorePosition();
    if (trigger.isConnected) trigger.focus({preventScroll: true});
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
    if (typeof dialog.showModal !== 'function') return fallback?.();
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
    onOpen();
  }

  trigger.addEventListener('click', () => openDialog());
  close.addEventListener('click', requestClose);
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('button:not([disabled]), a[href], summary, [tabindex="0"]')].filter(node => {
      if (!node.getClientRects().length || node.closest('[hidden], [inert]')) return false;
      // WebKit may give hidden details descendants a non-empty client rect.
      for (let parent = node.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
        if (parent.matches('details:not([open])') && !parent.querySelector(':scope > summary')?.contains(node)) return false;
      }
      return getComputedStyle(node).visibility !== 'hidden';
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
