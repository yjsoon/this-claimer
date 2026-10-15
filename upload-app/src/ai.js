// AI settings dialog: paste or remove provider keys (Claude, MiniMax,
// Gemini), pick which one reads receipts first, and pick the Claude model.
// Keys go to the worker (see worker/ai.ts) and are never sent back; the
// dialog only ever sees whether a key is set and its last four characters.
import { API_BASE } from './lib/constants.js';
import { authHeaders, escapeHtml } from './lib/core.js';

const openBtn = document.getElementById('aiSettingsBtn');
const dialog = document.getElementById('aiDialog');
const closeBtn = document.getElementById('aiDialogClose');
const providerList = document.getElementById('aiProviderList');
const visionSelect = document.getElementById('aiVisionProvider');
const modelSelect = document.getElementById('aiClaudeModel');
const messageEl = document.getElementById('aiDialogMessage');

const KEY_PLACEHOLDERS = {
  anthropic: 'sk-ant-…',
  minimax: 'sk-cp-…',
  gemini: 'AIza…',
};

const KEY_LINKS = {
  anthropic: 'https://platform.claude.com/settings/keys',
  gemini: 'https://aistudio.google.com/apikey',
};

let status = null;
let editing = null; // provider id whose key form is open
let busy = false;
const listeners = new Set();

export function getAiStatus() {
  return status;
}

export function isClaudeConfigured() {
  return Boolean(status?.providers?.some((p) => p.id === 'anthropic' && p.configured));
}

export function onAiStatusChange(fn) {
  listeners.add(fn);
}

function setStatus(next) {
  status = next;
  render();
  listeners.forEach((fn) => fn(status));
}

function setMessage(type, text) {
  messageEl.textContent = text || '';
  messageEl.className = `ai-dialog-message${type ? ` is-${type}` : ''}`;
}

function sourceText(p) {
  if (p.source === 'app') return `Saved here · ${p.hint}`;
  if (p.source === 'secret') return `Worker secret · ${p.hint}`;
  return 'Not set';
}

function renderProvider(p) {
  const id = escapeHtml(p.id);
  const label = escapeHtml(p.label);
  const isEditing = editing === p.id;
  const link = KEY_LINKS[p.id]
    ? ` <a href="${KEY_LINKS[p.id]}" target="_blank" rel="noopener">Get a key</a>`
    : '';
  const actions = isEditing
    ? ''
    : `<div class="ai-provider-actions">
        <button type="button" class="btn-secondary btn-compact ai-edit-btn" aria-label="${p.configured ? 'Replace' : 'Add'} ${label} key">${p.configured ? 'Replace' : 'Add key'}</button>
        ${p.source === 'app' ? `<button type="button" class="btn-danger-quiet btn-compact ai-remove-btn" aria-label="Remove ${label} key">Remove</button>` : ''}
      </div>`;
  const form = isEditing
    ? `<form class="ai-key-form">
        <input class="gmail-input ai-key-input" type="password" autocomplete="off" spellcheck="false"
          aria-label="${label} API key" placeholder="${escapeHtml(KEY_PLACEHOLDERS[p.id] || '')}" required>
        <button type="submit" class="btn-primary btn-compact">Save</button>
        <button type="button" class="btn-secondary btn-compact ai-cancel-btn">Cancel</button>
      </form>`
    : '';
  return `
    <li class="ai-provider" data-provider="${id}">
      <div class="ai-provider-row">
        <div class="ai-provider-info">
          <span class="ai-provider-name">${label}</span>
          <span class="ai-provider-meta${p.configured ? '' : ' is-unset'}">${escapeHtml(sourceText(p))}${link}</span>
        </div>
        ${actions}
      </div>
      ${form}
    </li>`;
}

function renderSelects() {
  const providers = status?.providers || [];
  visionSelect.innerHTML = providers
    .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === status.visionProvider ? 'selected' : ''}>${escapeHtml(p.label)}${p.configured ? '' : ' (no key)'}</option>`)
    .join('');
  modelSelect.innerHTML = (status?.claudeModels || [])
    .map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === status.claudeModel ? 'selected' : ''}>${escapeHtml(m.label)}</option>`)
    .join('');
  visionSelect.disabled = busy || !providers.length;
  modelSelect.disabled = busy || !providers.length;
}

function render() {
  if (!providerList) return;
  if (!status) {
    providerList.innerHTML = '<li class="ai-provider-empty">Couldn\'t load AI settings. Close and try again.</li>';
    renderSelects();
    return;
  }
  providerList.innerHTML = status.providers.map(renderProvider).join('');
  renderSelects();

  providerList.querySelectorAll('.ai-provider').forEach((li) => {
    const provider = li.dataset.provider;
    li.querySelector('.ai-edit-btn')?.addEventListener('click', () => {
      editing = provider;
      setMessage('', '');
      render();
      providerList.querySelector('.ai-key-input')?.focus();
    });
    li.querySelector('.ai-remove-btn')?.addEventListener('click', () => removeKey(provider));
    li.querySelector('.ai-cancel-btn')?.addEventListener('click', () => {
      editing = null;
      render();
    });
    li.querySelector('.ai-key-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      saveKey(provider, li.querySelector('.ai-key-input').value);
    });
  });
  providerList.querySelectorAll('button, input').forEach((el) => {
    el.disabled = busy;
  });
}

async function putSettings(body) {
  const res = await fetch(`${API_BASE}/ai/settings`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function errorText(err) {
  return err instanceof Error && !/^HTTP /.test(err.message) ? err.message : "Couldn't save. Try again.";
}

function labelFor(provider) {
  return status?.providers?.find((p) => p.id === provider)?.label || provider;
}

async function saveKey(provider, value) {
  if (busy) return;
  busy = true;
  setMessage('', `Checking the ${labelFor(provider)} key…`);
  render();
  try {
    const next = await putSettings({ keys: { [provider]: value } });
    editing = null;
    busy = false;
    setStatus(next);
    setMessage('success', `Saved the ${labelFor(provider)} key.`);
  } catch (err) {
    busy = false;
    render();
    setMessage('error', errorText(err));
    providerList.querySelector('.ai-key-input')?.focus();
  }
}

async function removeKey(provider) {
  const p = status?.providers?.find((item) => item.id === provider);
  if (busy || !p) return;
  const fallback = p.secretAvailable ? ' The Worker secret will be used instead.' : '';
  if (!confirm(`Remove the ${p.label} key saved here?${fallback}`)) return;
  busy = true;
  render();
  try {
    const next = await putSettings({ keys: { [provider]: null } });
    busy = false;
    setStatus(next);
    setMessage('success', `Removed the ${p.label} key.${fallback}`);
  } catch (err) {
    busy = false;
    render();
    setMessage('error', errorText(err));
  }
}

async function saveChoice(body, doneText) {
  busy = true;
  render();
  try {
    const next = await putSettings(body);
    busy = false;
    setStatus(next);
    setMessage('success', doneText);
  } catch (err) {
    busy = false;
    render();
    setMessage('error', errorText(err));
  }
}

export async function loadAiSettings() {
  try {
    const res = await fetch(`${API_BASE}/ai/settings`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(await res.json());
  } catch (_err) {
    setStatus(null);
  }
}

export function initAiSettings() {
  if (!openBtn || !dialog) return;
  openBtn.addEventListener('click', () => {
    editing = null;
    setMessage('', '');
    render();
    dialog.showModal();
    void loadAiSettings();
  });
  closeBtn.addEventListener('click', () => dialog.close());
  // Click on the backdrop closes, like Escape does.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  visionSelect.addEventListener('change', () => {
    const label = labelFor(visionSelect.value);
    saveChoice({ visionProvider: visionSelect.value }, `Receipts will be read with ${label} first.`);
  });
  modelSelect.addEventListener('change', () => {
    const label = modelSelect.selectedOptions[0]?.textContent || modelSelect.value;
    saveChoice({ claudeModel: modelSelect.value }, `Claude will use ${label}.`);
  });
}
