// Settings dialog: integrations and one-time setup (Gmail import, Xero, and
// room for more), opened from the gear in the header. Sections register their
// own content; this module owns opening, closing, focus and the attention dot.

const dialog = document.getElementById('settingsDialog');
const openBtn = document.getElementById('settingsBtn');
const closeBtn = document.getElementById('settingsClose');
const alertDot = document.getElementById('settingsAlert');

const attention = new Map();
let onOpen = () => {};
let returnFocusTo = null;

function renderAttention() {
  const needs = [...attention.values()].some(Boolean);
  alertDot.hidden = !needs;
  openBtn.classList.toggle('needs-attention', needs);
  openBtn.setAttribute('aria-label', needs ? 'Settings (needs attention)' : 'Settings');
}

// Each section reports whether it needs the user's attention (for example a
// Gmail account that must be reconnected); the gear shows a dot if any does.
export function setSettingsAttention(key, needsAttention) {
  attention.set(key, Boolean(needsAttention));
  renderAttention();
}

export function isSettingsOpen() {
  return Boolean(dialog?.open);
}

export function openSettings({ focus } = {}) {
  if (!dialog || dialog.open) return;
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : openBtn;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  dialog.scrollTop = 0;
  const target = focus && dialog.querySelector(focus);
  (target || closeBtn).focus({ preventScroll: true });
  onOpen();
}

export function closeSettings() {
  if (!dialog?.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

export function initSettings({ onOpen: openHandler } = {}) {
  if (!dialog || !openBtn) return;
  if (typeof openHandler === 'function') onOpen = openHandler;

  openBtn.addEventListener('click', () => openSettings());
  closeBtn.addEventListener('click', closeSettings);

  // Clicking the backdrop (the dialog element itself, outside its content) closes it.
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) closeSettings();
  });

  // Esc fires cancel then close; either way, hand focus back to where it came from.
  dialog.addEventListener('close', () => {
    const target = returnFocusTo && document.contains(returnFocusTo) ? returnFocusTo : openBtn;
    returnFocusTo = null;
    target.focus({ preventScroll: true });
  });

  renderAttention();
}
