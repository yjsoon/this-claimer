// Gmail receipt import panel on the Claims page: link Gmail accounts, see
// when each was last checked, and trigger a scan. The worker also scans on a
// schedule (see worker/gmail.ts), so this panel is mostly for setup.
import { API_BASE } from './lib/constants.js';
import { authHeaders, escapeHtml, showStatus } from './lib/core.js';

const section = document.getElementById('gmailSection');
const toggleBtn = document.getElementById('gmailToggleBtn');
const alertDot = document.getElementById('gmailAlert');
const countEl = document.getElementById('gmailCount');
const accountList = document.getElementById('gmailAccountList');
const intro = document.getElementById('gmailIntro');
const connectBtn = document.getElementById('gmailConnectBtn');
const scanBtn = document.getElementById('gmailScanBtn');
const setupForm = document.getElementById('gmailSetup');
const redirectEl = document.getElementById('gmailRedirectUri');
const copyRedirectBtn = document.getElementById('gmailCopyRedirect');
const clientIdInput = document.getElementById('gmailClientId');
const clientSecretInput = document.getElementById('gmailClientSecret');
const setupSaveBtn = document.getElementById('gmailSetupSave');
const setupCancelBtn = document.getElementById('gmailSetupCancel');
const setupNote = document.getElementById('gmailSetupNote');
const clientInfo = document.getElementById('gmailClientInfo');

const LINK_ERRORS = {
  access_denied: "Gmail wasn't linked. You cancelled or didn't allow access.",
  expired: 'The Gmail sign-in took too long. Try linking again.',
  failed: "Couldn't link Gmail. Try again.",
};

let onImported = () => {};
let scanning = false;
let openedForAttention = false;
let editingClient = false;
let lastStatus = null;

export function setOnGmailImported(fn) {
  onImported = fn;
}

function formatWhen(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

function accountDetail(a) {
  if (a.needsReconnect) {
    return { error: true, text: 'Sign-in expired. Reconnect to keep importing.' };
  }
  if (a.lastScanError) {
    return { error: true, text: "Last check failed. Try Scan now; if it keeps failing, reconnect." };
  }
  if (!a.lastScanAt) {
    return { error: false, text: 'Not checked yet. First check within 4 hours, or use Scan now.' };
  }
  const summary = a.lastScanSummary ? ` · ${a.lastScanSummary}` : '';
  return { error: false, text: `Last checked ${formatWhen(a.lastScanAt)}${summary}` };
}

function renderAccount(a) {
  const detail = accountDetail(a);
  const email = escapeHtml(a.email);
  const reconnect = detail.error
    ? `<button type="button" class="btn-secondary btn-compact gmail-reconnect-btn" aria-label="Reconnect ${email}">Reconnect</button>`
    : '';
  return `
    <li class="gmail-account${detail.error ? ' is-error' : ''}" data-email="${email}">
      <div class="gmail-account-info">
        <span class="gmail-account-email">${email}</span>
        <span class="gmail-account-meta"${a.lastScanError ? ` title="${escapeHtml(a.lastScanError)}"` : ''}>${
          detail.error ? '<span class="visually-hidden">Error: </span>' : ''
        }${escapeHtml(detail.text)}</span>
      </div>
      <div class="gmail-account-actions">
        ${reconnect}
        <button type="button" class="btn-danger-quiet btn-compact gmail-remove-btn" aria-label="Remove ${email}">Remove</button>
      </div>
    </li>`;
}

function renderSetup(data) {
  // The form shows when no client is set yet, or when "Change" was clicked
  // for a client saved from the app (Worker-secret clients are changed there).
  const showForm = !data.configured || editingClient;
  setupForm.hidden = !showForm;
  redirectEl.textContent = data.redirectUri || `${location.origin}/gmail/callback`;
  setupCancelBtn.hidden = !data.configured;
  setupNote.hidden = !(data.configured && (data.accounts || []).length);
  if (showForm && !clientIdInput.value && data.clientSource === 'app') clientIdInput.value = data.clientId || '';

  if (data.configured && data.clientSource === 'app' && !editingClient) {
    clientInfo.hidden = false;
    clientInfo.innerHTML = `Google client <code>${escapeHtml(shortClientId(data.clientId))}</code> · <button type="button" class="link-button" id="gmailChangeClient">Change</button>`;
    document.getElementById('gmailChangeClient').addEventListener('click', () => {
      editingClient = true;
      renderStatus(lastStatus);
      clientIdInput.focus();
    });
  } else {
    clientInfo.hidden = true;
    clientInfo.innerHTML = '';
  }
}

function shortClientId(id = '') {
  const prefix = id.replace(/\.apps\.googleusercontent\.com$/, '');
  return prefix.length > 16 ? `${prefix.slice(0, 12)}…` : prefix;
}

function renderStatus(data) {
  lastStatus = data;
  renderSetup(data);
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const needsAttention = accounts.some((a) => a.needsReconnect || a.lastScanError);

  if (!data.configured) {
    intro.textContent = 'Gmail import needs a Google sign-in client. Set one up once, then link your Gmail accounts.';
  } else if (data.htmlReceipts) {
    intro.textContent = 'Receipts in your linked Gmail accounts are imported every 4 hours, including Grab and Gojek ride receipts.';
  } else {
    intro.textContent = "Receipt attachments in your linked Gmail accounts are imported every 4 hours. Grab and Gojek ride receipts aren't imported yet.";
  }

  connectBtn.hidden = !data.configured || editingClient;
  scanBtn.hidden = !data.configured || editingClient || accounts.length === 0;
  connectBtn.disabled = scanning;
  scanBtn.disabled = scanning;
  countEl.textContent = accounts.length ? `(${accounts.length})` : '';
  alertDot.hidden = !needsAttention;
  toggleBtn.classList.toggle('needs-attention', needsAttention);

  if (!data.configured) {
    accountList.innerHTML = '';
  } else if (!accounts.length) {
    accountList.innerHTML = '<li class="gmail-empty">No accounts linked yet. Link a Gmail account to start importing receipts.</li>';
  } else {
    accountList.innerHTML = accounts.map(renderAccount).join('');
  }

  accountList.querySelectorAll('.gmail-remove-btn').forEach((btn) => {
    btn.disabled = scanning;
    btn.addEventListener('click', () => removeAccount(btn.closest('li').dataset.email));
  });
  accountList.querySelectorAll('.gmail-reconnect-btn').forEach((btn) => {
    btn.disabled = scanning;
    btn.addEventListener('click', connect);
  });

  // A broken account should not go unnoticed behind a closed panel.
  if (needsAttention && !openedForAttention) {
    openedForAttention = true;
    setOpen(true);
  }
}

export async function loadGmailStatus() {
  try {
    const res = await fetch(`${API_BASE}/gmail/status`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderStatus(await res.json());
  } catch (_err) {
    intro.textContent = "Couldn't load Gmail accounts. Refresh to try again.";
    connectBtn.disabled = true;
    scanBtn.disabled = true;
  }
}

async function saveClient(event) {
  event.preventDefault();
  setupSaveBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/gmail/client`, {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientIdInput.value, clientSecret: clientSecretInput.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    editingClient = false;
    clientSecretInput.value = '';
    clientIdInput.value = '';
    showStatus('success', 'Saved. Now link a Gmail account.');
    await loadGmailStatus();
    connectBtn.focus();
  } catch (err) {
    showStatus('error', err instanceof Error && !/^HTTP /.test(err.message) ? err.message : "Couldn't save. Try again.");
  } finally {
    setupSaveBtn.disabled = false;
  }
}

async function copyRedirect() {
  try {
    await navigator.clipboard.writeText(redirectEl.textContent);
    copyRedirectBtn.textContent = 'Copied';
    setTimeout(() => {
      copyRedirectBtn.textContent = 'Copy';
    }, 1500);
  } catch (_err) {
    showStatus('error', "Couldn't copy. Select the address and copy it instead.");
  }
}

async function connect() {
  try {
    const res = await fetch(`${API_BASE}/gmail/connect`, { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.authorizeUrl) throw new Error(data.error || `HTTP ${res.status}`);
    window.location.href = data.authorizeUrl;
  } catch (err) {
    console.error('Gmail connect failed', err);
    showStatus('error', "Couldn't open Google sign-in. Try again.");
  }
}

async function removeAccount(email) {
  if (!email || !confirm(`Stop importing receipts from ${email}? Receipts already imported will stay.`)) return;
  try {
    const res = await fetch(`${API_BASE}/gmail/disconnect`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showStatus('success', `Removed ${email}. Receipts already imported are kept.`);
  } catch (_err) {
    showStatus('error', `Couldn't remove ${email}. Try again.`);
  }
  await loadGmailStatus();
  connectBtn.focus();
}

function scanMessage(data) {
  if (data.skipped === 'scan_in_progress') return ['success', 'A scan is already running. Try again in a minute.'];
  if (data.skipped) return ['error', 'No Gmail accounts to scan.'];

  const accounts = data.accounts || [];
  const imported = accounts.reduce((sum, a) => sum + a.imported.length, 0);
  const brokenAccounts = accounts.filter((a) => a.failed).length;
  const retries = accounts.filter((a) => !a.failed).reduce((sum, a) => sum + a.errors.length, 0);

  let text = imported
    ? `Imported ${imported} receipt${imported === 1 ? '' : 's'}.`
    : 'Scan finished. No new receipts.';
  if (brokenAccounts) text += ` ${brokenAccounts} account${brokenAccounts === 1 ? ' needs' : 's need'} attention.`;
  if (retries) text += ` ${retries} email${retries === 1 ? " couldn't" : "s couldn't"} be read and will be retried.`;
  return [brokenAccounts ? 'error' : 'success', text];
}

async function scanNow() {
  scanning = true;
  scanBtn.textContent = 'Scanning…';
  section.setAttribute('aria-busy', 'true');
  [scanBtn, connectBtn, ...accountList.querySelectorAll('button')].forEach((btn) => {
    btn.disabled = true;
  });
  showStatus('uploading', 'Scanning Gmail…');
  try {
    const res = await fetch(`${API_BASE}/gmail/scan`, { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const [type, text] = scanMessage(data);
    showStatus(type, text);
    if (data.accounts?.some((a) => a.imported.length)) onImported();
  } catch (err) {
    console.error('Gmail scan failed', err);
    showStatus('error', "Gmail scan failed. Try again.");
  } finally {
    scanning = false;
    scanBtn.textContent = 'Scan now';
    section.removeAttribute('aria-busy');
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
  setupForm.addEventListener('submit', saveClient);
  copyRedirectBtn.addEventListener('click', copyRedirect);
  setupCancelBtn.addEventListener('click', () => {
    editingClient = false;
    clientSecretInput.value = '';
    clientIdInput.value = '';
    if (lastStatus) renderStatus(lastStatus);
  });

  // Back from Google's consent screen: open the panel, report, tidy the URL.
  const params = new URLSearchParams(location.search);
  const linked = params.get('gmail');
  const linkError = params.get('gmailError');
  if (linked || linkError) {
    setOpen(true);
    if (linked) {
      showStatus('success', `Linked ${linked}. New receipts will appear after the next check, or use Scan now.`);
    } else {
      showStatus('error', LINK_ERRORS[linkError] || LINK_ERRORS.failed);
    }
    params.delete('gmail');
    params.delete('gmailError');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  }
}
