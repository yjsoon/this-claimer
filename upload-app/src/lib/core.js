import {
  API_BASE,
  AUTH_KEY,
  REMEMBER_KEY,
  THEME_KEY,
  THEME_CYCLE,
  THEME_LABELS,
  THEME_ICONS,
} from './constants.js';

const status = document.getElementById('status');
const authOverlay = document.getElementById('authOverlay');
const passwordInput = document.getElementById('passwordInput');
const rememberMe = document.getElementById('rememberMe');
const themeToggle = document.getElementById('themeToggle');

let onAuthSuccess = () => {};

export function setOnAuthSuccess(fn) {
  onAuthSuccess = fn;
}

export function getAuthToken() {
  return localStorage.getItem(AUTH_KEY) || sessionStorage.getItem(AUTH_KEY);
}

export function setAuthToken(token, remember) {
  if (remember) {
    localStorage.setItem(AUTH_KEY, token);
    localStorage.setItem(REMEMBER_KEY, 'true');
  } else {
    sessionStorage.setItem(AUTH_KEY, token);
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(REMEMBER_KEY);
  }
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(AUTH_KEY);
}

function shouldRemember() {
  return localStorage.getItem(REMEMBER_KEY) === 'true';
}

export function getThemePreference() {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
}

function resolveTheme(preference) {
  if (preference === 'auto') {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return preference;
}

function updateThemeToggleUi(preference) {
  if (!themeToggle) return;
  const label = THEME_LABELS[preference] || 'System';
  themeToggle.innerHTML = THEME_ICONS[preference] || THEME_ICONS.auto;
  themeToggle.setAttribute('aria-label', `Colour theme: ${label}. Click to change.`);
  themeToggle.setAttribute('title', `${label} theme`);
}

function applyTheme(preference) {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.body.dataset.theme = resolved;
  updateThemeToggleUi(preference);
}

function cycleTheme() {
  const current = getThemePreference();
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

export function authHeaders() {
  const token = getAuthToken();
  return token ? { 'X-Auth-Token': token } : {};
}

export function showPasswordPrompt() {
  authOverlay.style.display = 'flex';
  rememberMe.checked = shouldRemember();
  passwordInput.focus();
}

export function hidePasswordPrompt() {
  authOverlay.style.display = 'none';
}

export async function checkAuth() {
  const token = getAuthToken();
  if (!token) {
    showPasswordPrompt();
    return false;
  }

  try {
    // Cheapest authenticated call: one receipt, not the default page of 100.
    const response = await fetch(`${API_BASE}/list?limit=1`, {
      headers: authHeaders(),
    });
    if (response.status === 401 || response.status === 429) {
      clearAuthToken();
      showPasswordPrompt();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function handlePasswordSubmit() {
  const password = passwordInput.value.trim();
  if (!password) return;

  setAuthToken(password, rememberMe.checked);

  try {
    const response = await fetch(`${API_BASE}/list?limit=1`, {
      headers: authHeaders(),
    });
    if (response.status === 401 || response.status === 429) {
      clearAuthToken();
      showStatus('error', response.status === 429 ? 'Too many attempts. Try again in a few minutes.' : 'Invalid password');
      passwordInput.value = '';
      return;
    }
    hidePasswordPrompt();
    onAuthSuccess();
  } catch {
    showStatus('error', 'Connection failed');
  }
}

let statusHideTimer = null;

export function showStatus(type, message) {
  // A stale success timer must not hide a newer message.
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  status.className = `status ${type}`;
  status.textContent = message;

  if (type === 'success') {
    statusHideTimer = setTimeout(() => {
      statusHideTimer = null;
      status.className = 'status';
    }, 3000);
  }
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "14 Sep 2026": unambiguous day-first form regardless of the browser locale.
export function formatDateForLocale(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatCurrencyAmount(currency, amount) {
  if (!Number.isFinite(amount)) return '';
  if (currency === 'SGD') return `S$${amount.toFixed(2)}`;
  if (currency) return `${currency} ${amount.toFixed(2)}`;
  return amount.toFixed(2);
}

export function initTheme() {
  if (themeToggle) {
    themeToggle.addEventListener('click', cycleTheme);
  }
  applyTheme(getThemePreference());
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getThemePreference() === 'auto') applyTheme('auto');
    });
  }
}

export function initAuthUi() {
  const authSubmit = document.getElementById('authSubmit');
  authSubmit.addEventListener('click', handlePasswordSubmit);
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handlePasswordSubmit();
  });
}
