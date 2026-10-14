// Gmail receipt import panel on the Claims page: link Gmail accounts, see
// when each was last scanned, and trigger a scan. The worker also scans on a
// schedule (see worker/gmail.ts), so this panel is mostly for setup.
import { API_BASE } from './lib/constants.js';
import { authHeaders, escapeHtml, showStatus } from './lib/core.js';

const section = document.getElementById('gmailSection');
const toggleBtn = document.getElementById('gmailToggleBtn');
const accountList = document.getElementById('gmailAccountList');
const intro = document.getElementById('gmailIntro');
const connectBtn = document.getElementById('gmailConnectBtn');
const scanBtn = document.getElementById('gmailScanBtn');

let onImported = () => {};

export function setOnGmailImported(fn) {
  onImported = fn;
}

function formatWhen(iso) {
  if (!iso) return 'not scanned yet';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'not scanned yet';
  return `scanned ${date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

function renderStatus(data) {
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  if (!data.configured) {
    intro.textContent = 'Gmail import is not set up on this deployment yet (Google OAuth client secrets are missing).';
  } else {
    intro.textContent = data.htmlReceipts
      ? 'Receipt attachments and Grab/Gojek ride receipts are imported automatically every four hours.'
      : 'Receipt attachments are imported automatically every four hours. Grab/Gojek body-only receipts need Browser Rendering set up.';
  }
  connectBtn.disabled = !data.configured;
  scanBtn.disabled = !data.configured || accounts.length === 0;
  toggleBtn.textContent = accounts.length ? `Gmail (${accounts.length})` : 'Gmail';

  accountList.innerHTML = accounts.length
    ? accounts
        .map((a) => {
          const detail = a.lastScanError
            ? `<span class="gmail-account-error">${escapeHtml(a.lastScanError)}</span>`
            : escapeHtml(a.lastScanSummary || '');
          return `
            <li class="gmail-account" data-email="${escapeHtml(a.email)}">
              <div class="gmail-account-info">
                <span class="gmail-account-email">${escapeHtml(a.email)}</span>
                <span class="gmail-account-meta">${escapeHtml(formatWhen(a.lastScanAt))}${detail ? ` · ${detail}` : ''}</span>
              </div>
              <button type="button" class="link-button gmail-remove-btn">Remove</button>
            </li>`;
        })
        .join('')
    : '<li class="gmail-empty">No Gmail accounts linked.</li>';

  accountList.querySelectorAll('.gmail-remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => removeAccount(btn.closest('li').dataset.email));
  });
}

export async function loadGmailStatus() {
  try {
    const res = await fetch(`${API_BASE}/gmail/status`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderStatus(await res.json());
  } catch (_err) {
    intro.textContent = 'Could not check Gmail status.';
  }
}

async function connect() {
  try {
    const res = await fetch(`${API_BASE}/gmail/connect`, { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.authorizeUrl) throw new Error(data.error || `HTTP ${res.status}`);
    window.location.href = data.authorizeUrl;
  } catch (err) {
    showStatus('error', `Could not start Gmail connect: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function removeAccount(email) {
  if (!email || !confirm(`Stop importing receipts from ${email}? Receipts already imported stay.`)) return;
  await fetch(`${API_BASE}/gmail/disconnect`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  await loadGmailStatus();
}

async function scanNow() {
  scanBtn.disabled = true;
  scanBtn.textContent = 'Scanning…';
  try {
    const res = await fetch(`${API_BASE}/gmail/scan`, { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.skipped === 'scan_in_progress') {
      showStatus('success', 'A Gmail scan is already running. Check back shortly.');
    } else {
      const imported = (data.accounts || []).reduce((sum, a) => sum + a.imported.length, 0);
      const failed = (data.accounts || []).reduce((sum, a) => sum + a.errors.length, 0);
      showStatus(
        failed ? 'error' : 'success',
        `Imported ${imported} receipt${imported === 1 ? '' : 's'} from Gmail${failed ? `, ${failed} failed` : ''}.`
      );
      if (imported) onImported();
    }
  } catch (err) {
    showStatus('error', `Gmail scan failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    scanBtn.textContent = 'Scan now';
    await loadGmailStatus();
  }
}

function setOpen(open) {
  section.hidden = !open;
  toggleBtn.setAttribute('aria-expanded', String(open));
}

export function initGmail() {
  toggleBtn.addEventListener('click', () => setOpen(section.hidden));
  connectBtn.addEventListener('click', connect);
  scanBtn.addEventListener('click', scanNow);

  // Back from Google's consent screen: open the panel and tidy the URL.
  const params = new URLSearchParams(location.search);
  const linked = params.get('gmail');
  if (linked) {
    setOpen(true);
    showStatus('success', `Linked ${linked}. Its receipts will be imported on the next scan.`);
    params.delete('gmail');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  }
}
