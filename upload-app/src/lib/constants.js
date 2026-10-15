export const API_BASE = ''; // Same origin when deployed, or set to worker URL for dev
export const AUTH_KEY = 'claim_manager_auth';
export const REMEMBER_KEY = 'claim_manager_remember';
export const THEME_KEY = 'claim_manager_theme';
export const THEME_CYCLE = ['light', 'dark', 'auto'];
export const THEME_LABELS = { light: 'Light', dark: 'Dark', auto: 'System' };
export const THEME_ICONS = {
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
};
export const CLAIM_FILTER_KEY = 'claim_manager_claim_filter';
export const REJECTED_MATCHES_KEY = 'claim_manager_rejected_matches';
export const MATCH_REVIEW_COLLAPSED_KEY = 'claim_manager_match_review_collapsed';

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.pdf'];
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/x-pdf',
];
export const AMOUNT_TAG_COOLDOWN_MS = 20000;
export const AMOUNT_MATCH_TOLERANCE = 0.01;
export const DATE_NEAR_THRESHOLD_DAYS = 2;
export const RECEIPT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const READY_CLAIM_ID_PREFIX = 'receipt-ready:';
export const DEFAULT_CLAIM_FILTERS = [
  'Update with actual',
  'MYR',
  'USD',
  'Transfer',
];

export const INVOICES_PATH = '/invoices';
