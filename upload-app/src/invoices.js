import { API_BASE, INVOICES_PATH } from './lib/constants.js';
import {
  authHeaders,
  getAuthToken,
  showPasswordPrompt,
  showStatus,
  escapeHtml,
  formatCurrencyAmount,
} from './lib/core.js';
import { receiptsData, claimsData, claimsDataBackend, claimsLoadErrorMessage } from './lib/state.js';
import {
  getLinkedClaimIds,
  getReceiptMatchDate,
  isReadyOnlyClaimId,
  getReceiptDisplayName,
  getComparableReceiptAmounts,
} from './lib/match.js';
import { openPreview } from './lib/preview.js?v=20260914-preview-review';
import { clearSelection, getClaimsBackend, loadReceipts, loadYnabTodos } from './claims.js?v=20261015-settings';

const claimsView = document.getElementById('claimsView');
const navClaims = document.getElementById('navClaims');
const navInvoices = document.getElementById('navInvoices');
const invoicesView = document.getElementById('invoicesView');
const xeroStatusEls = document.querySelectorAll('[data-xero-status]');
const invoicesRefreshBtn = document.getElementById('invoicesRefreshBtn');
const detectGstBtn = document.getElementById('detectGstBtn');
const invoicesSectionsEl = document.getElementById('invoicesSections');
const invoicesEmpty = document.getElementById('invoicesEmpty');
const invoicesLoadingEl = document.getElementById('invoicesLoading');

const INVOICE_BUCKETS = ['gst', 'nongst', 'transport'];
const BUCKET_HEADING = {
  gst: 'GST',
  nongst: 'Non-GST',
  transport: 'Transport',
};
const BUCKET_LABEL = { gst: 'GST', nongst: 'Non-GST', transport: 'Transport' };
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const INVOICE_SECTIONS_KEY = 'claim_manager_invoice_sections';
const INVOICE_SORTS_KEY = 'claim_manager_invoice_sorts';
const INVOICE_LAST_PUSH_KEY = 'claim_manager_invoice_last_push';
const INVOICE_PUSH_HISTORY_KEY = 'claim_manager_invoice_push_history';
const INVOICE_SORT_OPTIONS = [
  { value: 'account-date', label: 'Account, then date' },
  { value: 'date-asc', label: 'Date oldest first' },
  { value: 'date-desc', label: 'Date newest first' },
  { value: 'amount-desc', label: 'Amount high to low' },
  { value: 'amount-asc', label: 'Amount low to high' },
  { value: 'description-asc', label: 'Description A-Z' },
];
const EYE_ICON = '<svg class="inv-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

let invoiceLines = [];
let invoicesActive = false;
let invoicesLoading = false;
let invoiceLoadingRequests = 0;
let xeroConnected = false;
let xeroAccounts = null;
let xeroTaxTypes = null;
let activeInvoiceEditCell = null;
let invoiceRenderGeneration = 0;
let pdfLibModule = null;
let activeReceiptPdfUrl = null;
const RECEIPT_PDF_PAGE_WIDTH = 800;
const RECEIPT_JPEG_QUALITY = 0.5;
const XERO_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const TRANSPORT_CODES = ['451', '452'];
const ALLOWED_TAX_TYPES = ['NRINPUT', 'INPUTY24', 'OPINPUT'];
const FALLBACK_TAX_TYPES = [
  { taxType: 'NRINPUT', name: 'Purchases from Non-GST Registered Suppliers' },
  { taxType: 'INPUTY24', name: 'Standard-Rated Purchases' },
  { taxType: 'OPINPUT', name: 'Out Of Scope Purchases' },
];
const FALLBACK_ACCOUNTS = [
  { code: '463', name: 'Computer Software' },
  { code: '320', name: 'Cost of Sales' },
  { code: '464', name: 'Computer Hardware & Accessories' },
  { code: '460', name: 'Books, Magazines, Journals' },
  { code: '451', name: 'Local Public Transport (incl Taxi)' },
  { code: '452', name: 'Overseas Transport' },
  { code: '467', name: 'Telephone & Internet' },
];
// Best-effort default account from the payee/description. Always editable.
const ACCOUNT_HINTS = [
  { code: '451', re: /\b(grab|gojek|gocar|taxi|cab|comfort|cdg|ez-?link|simplygo|mrt|\bbus\b|transport|\bride\b|fare|tada|ryde)\b/i },
  { code: '464', re: /\b(hardware|cable|adapter|charger|keyboard|mouse|monitor|\bcase\b|ipad|laptop|ssd|usb|dongle|battery|webcam)\b/i },
  { code: '460', re: /\b(book|books|magazine|journal|ebook)\b/i },
  { code: '467', re: /\b(phone|mobile|telco|singtel|starhub|\bm1\b|internet|broadband|data plan|\bsim\b)\b/i },
  { code: '463', re: /\b(subscription|software|saas|\bapp\b|\bai\b|\bapi\b|github|openai|chatgpt|claude|anthropic|lovable|figma|notion|adobe|cloud|domain|hosting)\b/i },
];
const INVOICE_EMPTY_TEXT = 'No ready-to-claim items. Mark receipts ready or link them to claims first.';
const INVOICE_CLAIMS_UNAVAILABLE_TEXT = 'Claims unavailable. Refresh claims before creating Xero bills.';

function invoiceAccounts() {
  const accounts = xeroAccounts && xeroAccounts.length ? xeroAccounts : FALLBACK_ACCOUNTS;
  return [...accounts].sort((a, b) => (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    || a.code.localeCompare(b.code, undefined, { numeric: true })
  ));
}

function invoiceTaxTypes() {
  const merged = new Map();
  FALLBACK_TAX_TYPES.forEach((tax) => merged.set(tax.taxType, tax));
  (xeroTaxTypes || []).forEach((tax) => {
    if (ALLOWED_TAX_TYPES.includes(tax.taxType)) merged.set(tax.taxType, tax);
  });
  return ALLOWED_TAX_TYPES.map((taxType) => merged.get(taxType)).filter(Boolean);
}

function guessAccountCode(text) {
  const hay = (text || '').toLowerCase();
  for (const hint of ACCOUNT_HINTS) {
    if (hint.re.test(hay)) return hint.code;
  }
  return '463';
}

// Input tax code: GST shown -> standard-rated; USD with no GST -> out of scope;
// SGD with no GST -> non-GST-registered supplier.
function deriveTaxType(line) {
  if (ALLOWED_TAX_TYPES.includes(line.taxType)) return line.taxType;
  if (line.gstShown) return 'INPUTY24';
  const currency = (line.currency || 'SGD').toUpperCase();
  return currency !== 'SGD' && currency !== 'UNKNOWN' ? 'OPINPUT' : 'NRINPUT';
}

function nonGstTaxType(line) {
  const currency = (line.currency || 'SGD').toUpperCase();
  return currency !== 'SGD' && currency !== 'UNKNOWN' ? 'OPINPUT' : 'NRINPUT';
}

function lineBucket(line) {
  if (TRANSPORT_CODES.includes(line.accountCode)) return 'transport';
  return deriveTaxType(line) === 'INPUTY24' ? 'gst' : 'nongst';
}

function getLineSection(line) {
  return line.section || lineBucket(line);
}

function normaliseLineForSection(line) {
  const section = getLineSection(line);
  if (section === 'gst') {
    line.gstShown = true;
    line.taxType = 'INPUTY24';
    if (TRANSPORT_CODES.includes(line.accountCode)) line.accountCode = '463';
  } else if (section === 'transport') {
    if (!TRANSPORT_CODES.includes(line.accountCode)) line.accountCode = '451';
    line.gstShown = false;
    if (deriveTaxType(line) === 'INPUTY24') line.taxType = nonGstTaxType(line);
  } else {
    line.gstShown = false;
    if (deriveTaxType(line) === 'INPUTY24') line.taxType = nonGstTaxType(line);
    if (TRANSPORT_CODES.includes(line.accountCode)) line.accountCode = '463';
  }
}

function setLineSection(line, section) {
  line.section = section;
  normaliseLineForSection(line);
  saveInvoiceEdit(line.id, {
    section: line.section,
    gstShown: line.gstShown,
    taxType: line.taxType,
    accountCode: line.accountCode,
  });
  reaffirmLineReviewAfterEdit(line);
}

function defaultForeignCurrencyRemark(receipt) {
  const currency = (receipt.taggedCurrency || 'SGD').toUpperCase();
  if (currency === 'SGD') return '';
  const amount = Number(receipt.taggedAmount);
  if (!Number.isFinite(amount)) return '';
  return formatCurrencyAmount(currency, amount);
}

function loadSectionCollapsedState() {
  try {
    return JSON.parse(localStorage.getItem(INVOICE_SECTIONS_KEY) || '{}') || {};
  } catch (_err) {
    return {};
  }
}

function saveSectionCollapsed(bucket, collapsed) {
  const state = loadSectionCollapsedState();
  state[bucket] = collapsed;
  try {
    localStorage.setItem(INVOICE_SECTIONS_KEY, JSON.stringify(state));
  } catch (_err) {
    /* ignore */
  }
}

function loadInvoiceSortState() {
  try {
    return JSON.parse(localStorage.getItem(INVOICE_SORTS_KEY) || '{}') || {};
  } catch (_err) {
    return {};
  }
}

function invoiceSortForBucket(bucket) {
  const state = loadInvoiceSortState();
  return INVOICE_SORT_OPTIONS.some((option) => option.value === state[bucket])
    ? state[bucket]
    : 'account-date';
}

function saveInvoiceSort(bucket, sort) {
  const state = loadInvoiceSortState();
  state[bucket] = sort;
  try {
    localStorage.setItem(INVOICE_SORTS_KEY, JSON.stringify(state));
  } catch (_err) {
    /* ignore */
  }
}

function setInvoicesLoading(loading) {
  invoicesLoading = loading;
  updateInvoicesVisibility();
}

function updateInvoicesVisibility() {
  // Keep rendered sections on screen (dimmed) while refreshing; the loading
  // box only replaces the content when there is nothing to show yet.
  const hasRenderedSections = Boolean(invoicesSectionsEl?.querySelector('.invoice-section'));
  const showLoadingBox = invoicesLoading && !hasRenderedSections;
  if (invoicesLoadingEl) invoicesLoadingEl.hidden = !showLoadingBox;
  if (invoicesSectionsEl) {
    invoicesSectionsEl.hidden = showLoadingBox;
    if (invoicesLoading && hasRenderedSections) invoicesSectionsEl.setAttribute('aria-busy', 'true');
    else invoicesSectionsEl.removeAttribute('aria-busy');
  }
  if (invoicesEmpty) invoicesEmpty.hidden = invoicesLoading || invoiceLines.length > 0;
}

// Build the editable model from the currently loaded ready-to-claim data:
// receipts with a non-empty linkedClaimIds, joined to their YNAB claim.
// --- Persisted manual edits (survive refresh / tab toggle / reload) ---------
const INVOICE_EDITS_KEY = 'claim_manager_invoice_edits';

function loadInvoiceEdits() {
  try {
    return JSON.parse(localStorage.getItem(INVOICE_EDITS_KEY) || '{}') || {};
  } catch (_err) {
    return {};
  }
}

function writeInvoiceEdits(store) {
  try {
    localStorage.setItem(INVOICE_EDITS_KEY, JSON.stringify(store));
  } catch (_err) {
    /* ignore storage quota / availability errors */
  }
}

function saveInvoiceEdit(lineId, patch) {
  const store = loadInvoiceEdits();
  const line = invoiceLines.find((item) => item.id === lineId);
  store[lineId] = {
    ...(store[lineId] || {}),
    ...(line?.claimsBackend ? { claimsBackend: line.claimsBackend } : {}),
    ...patch,
  };
  writeInvoiceEdits(store);
}

function saveLastPushResult(data, warnings, payload) {
  try {
    localStorage.setItem(INVOICE_LAST_PUSH_KEY, JSON.stringify({
      data,
      warnings,
      payload,
      savedAt: new Date().toISOString(),
    }));
    rememberPushedInvoice(data, payload);
  } catch (_err) {
    /* ignore storage quota / availability errors */
  }
}

function loadLastPushResult() {
  try {
    return JSON.parse(localStorage.getItem(INVOICE_LAST_PUSH_KEY) || 'null');
  } catch (_err) {
    return null;
  }
}

function clearLastPushResult() {
  try {
    localStorage.removeItem(INVOICE_LAST_PUSH_KEY);
  } catch (_err) {
    /* ignore storage quota / availability errors */
  }
}

function loadPushHistory() {
  try {
    return JSON.parse(localStorage.getItem(INVOICE_PUSH_HISTORY_KEY) || '{}') || {};
  } catch (_err) {
    return {};
  }
}

function legacyLineItemKey(item) {
  return `${item.receiptKey || ''}::${item.ynabClaimId || ''}`;
}

function pushHistoryEntryForItem(item) {
  const byLine = loadPushHistory().byLine || {};
  const current = byLine[lineItemKey(item)];
  if (current) return current;
  const backend = item?.claimsBackend === 'howmuch' ? 'howmuch' : 'ynab';
  return backend === 'ynab' ? byLine[legacyLineItemKey(item)] : undefined;
}

function writePushHistory(history) {
  try {
    localStorage.setItem(INVOICE_PUSH_HISTORY_KEY, JSON.stringify(history));
  } catch (_err) {
    /* ignore storage quota / availability errors */
  }
}

function rememberPushedInvoice(data, payload) {
  if (!data?.invoiceID || !payload?.lineItems?.length) return;
  const history = loadPushHistory();
  const byLine = history.byLine || {};
  const savedAt = new Date().toISOString();
  payload.lineItems.forEach((item) => {
    byLine[lineItemKey(item)] = {
      invoiceID: data.invoiceID,
      invoiceNumber: data.invoiceNumber || '',
      claimsBackend: item.claimsBackend || payload.backend || '',
      bucket: payload.bucket || '',
      reference: payload.reference || '',
      savedAt,
    };
  });
  writePushHistory({ byLine });
}

function rememberedInvoiceIDForItem(item) {
  // Only a push remembered in this browser counts. Receipt xeroPending*
  // stamps are leftover portal metadata and are not proof a bill exists.
  const entry = pushHistoryEntryForItem(item);
  return typeof entry?.invoiceID === 'string' ? entry.invoiceID : '';
}

function rememberedClaimsBackendForItem(item) {
  if (item?.claimsBackend === 'howmuch' || item?.claimsBackend === 'ynab') return item.claimsBackend;
  const backend = pushHistoryEntryForItem(item)?.claimsBackend;
  return backend === 'ynab' ? 'ynab' : backend === 'howmuch' ? 'howmuch' : getClaimsBackend();
}

function lineReviewSnapshot(line) {
  return {
    amount: Number(line.amount || 0).toFixed(2),
    date: line.date || '',
    description: line.description || '',
    accountCode: line.accountCode || '',
    taxType: deriveTaxType(line),
    remark: line.remark || '',
    section: getLineSection(line),
  };
}

function lineSourceSnapshot(line) {
  return {
    amount: Number(line.amount || 0).toFixed(2),
    date: line.date || '',
    description: line.description || '',
  };
}

function sourceSnapshotsMatch(current, saved) {
  if (!saved) return false;
  return current.amount === saved.amount
    && current.date === saved.date
    && current.description === saved.description;
}

function snapshotsMatch(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

// Re-apply saved manual edits onto freshly-built lines. Keep edits for lines
// outside the current backend/load snapshot so asynchronous refreshes cannot
// discard review state from another ledger.
function applySavedInvoiceEdits(lines) {
  const store = loadInvoiceEdits();
  lines.forEach((line) => {
    const legacyId = legacyLineItemKey(line);
    const legacySaved = line.claimsBackend === 'ynab' ? store[legacyId] : undefined;
    if (!store[line.id] && legacySaved) {
      store[line.id] = { ...legacySaved, claimsBackend: 'ynab' };
      delete store[legacyId];
    }
    const saved = store[line.id];
    const sourceSnapshot = lineSourceSnapshot(line);
    line.sourceSnapshot = sourceSnapshot;
    if (saved) {
      const { claimsBackend: _savedBackend, ...savedEdits } = saved;
      Object.assign(line, savedEdits);
    }
    if (saved && line.claimsBackend) store[line.id].claimsBackend = line.claimsBackend;
    const before = JSON.stringify({
      section: line.section,
      gstShown: line.gstShown,
      taxType: line.taxType,
      accountCode: line.accountCode,
    });
    normaliseLineForSection(line);
    const after = JSON.stringify({
      section: line.section,
      gstShown: line.gstShown,
      taxType: line.taxType,
      accountCode: line.accountCode,
    });
    if (saved && before !== after) {
      store[line.id] = {
        ...saved,
        section: line.section,
        gstShown: line.gstShown,
        taxType: line.taxType,
        accountCode: line.accountCode,
      };
    }
    if (!saved || line.reviewed !== true) return;

    const effectiveSnapshot = lineReviewSnapshot(line);
    const missingReviewSnapshot = !saved.reviewedSnapshot || !saved.reviewedSourceSnapshot;
    const sourceChanged = !sourceSnapshotsMatch(sourceSnapshot, saved.reviewedSourceSnapshot);
    const effectiveChanged = !snapshotsMatch(effectiveSnapshot, saved.reviewedSnapshot);
    if (missingReviewSnapshot || sourceChanged || effectiveChanged) {
      store[line.id] = {
        ...saved,
        reviewed: false,
        reviewedSnapshot: null,
        reviewedSourceSnapshot: null,
        reviewInvalidated: true,
      };
      Object.assign(line, store[line.id]);
    }
  });
  writeInvoiceEdits(store);
}

function buildInvoiceLines() {
  if (claimsLoadErrorMessage || claimsDataBackend !== getClaimsBackend()) {
    invoiceLines = [];
    return;
  }

  const claimsById = new Map(claimsData.map((claim) => [claim.id, claim]));
  const lines = [];

  receiptsData.forEach((receipt) => {
    if (receipt.xeroInvoiceId) return; // already billed
    getLinkedClaimIds(receipt).forEach((claimId) => {
      const claim = claimsById.get(claimId) || null;
      const isReadyOnly = isReadyOnlyClaimId(claimId);
      const linkedBackend = receipt.linkedClaimsBackend || 'ynab';
      if (!isReadyOnly && linkedBackend !== claimsDataBackend) return;
      if (!claim && !isReadyOnly) return;
      const matchDate = getReceiptMatchDate(receipt).date;
      const date = (claim && claim.date) || (matchDate ? matchDate.toISOString().slice(0, 10) : '');
      const payee = (claim && claim.payee) || receipt.taggedVendor || 'Unknown payee';
      const description = (claim && claim.description) || receipt.taggedPurpose || getReceiptDisplayName(receipt);
      const currency = (receipt.taggedCurrency || 'SGD').toUpperCase();

      // SGD is the source of truth: prefer the YNAB claim amount, else the
      // receipt's SGD approximation, else the tagged amount.
      let amount = NaN;
      if (claim && Number.isFinite(Number(claim.amount))) {
        amount = Number(claim.amount);
      } else {
        const comparables = getComparableReceiptAmounts(receipt);
        const pref = comparables.find((c) => c.kind === 'fx-plus')
          || comparables.find((c) => c.kind === 'fx')
          || comparables[0];
        if (pref) amount = pref.value;
      }

      const claimsBackend = linkedBackend === 'howmuch' ? 'howmuch' : 'ynab';
      lines.push({
        id: `${claimsBackend}::${receipt.key}::${claimId}`,
        receiptKey: receipt.key,
        receiptName: getReceiptDisplayName(receipt),
        ynabClaimId: isReadyOnly ? null : claimId,
        claimSource: claim?.source || null,
        claimDescription: claim?.description || null,
        claimsBackend,
        sourceUrl: claimsBackend === 'howmuch' ? (claim?.sourceUrl || '') : '',
        xeroPendingInvoiceId: receipt.xeroPendingInvoiceId || '',
        xeroPendingInvoiceNumber: receipt.xeroPendingInvoiceNumber || '',
        // Default excluded when there's no usable amount yet, so we never push $0.00.
        include: Number.isFinite(amount) && amount > 0,
        date,
        payee,
        description,
        currency,
        amount: Number.isFinite(amount) ? Number(amount) : 0,
        accountCode: guessAccountCode(`${payee} ${description}`),
        gstShown: receipt.taggedGstShown === true,
        taxType: deriveTaxType({
          gstShown: receipt.taggedGstShown === true,
          currency,
        }),
        remark: defaultForeignCurrencyRemark(receipt),
      });
      lines[lines.length - 1].sourceSnapshot = lineReviewSnapshot(lines[lines.length - 1]);
    });
  });

  lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  applySavedInvoiceEdits(lines);
  invoiceLines = lines;
}

export function renderInvoiceClaimLoadError() {
  invoiceLines = [];
  if (invoicesSectionsEl) invoicesSectionsEl.innerHTML = '';
  if (invoicesEmpty) invoicesEmpty.textContent = INVOICE_CLAIMS_UNAVAILABLE_TEXT;
  if (invoiceLoadingRequests === 0) setInvoicesLoading(false);
  else updateInvoicesVisibility();
}

function accountLabel(code, accounts) {
  const match = accounts.find((a) => a.code === code);
  return match ? `${match.name} - ${match.code}` : code;
}

function taxTypeLabel(taxType, taxTypes = invoiceTaxTypes()) {
  const match = taxTypes.find((t) => t.taxType === taxType);
  return match ? `${match.taxType} - ${match.name}` : taxType;
}

// Short names for the table cell; the full Xero name stays in the tooltip and
// the dropdown.
const TAX_TYPE_SHORT_NAME = {
  INPUTY24: 'Standard-rated',
  NRINPUT: 'Non-GST supplier',
  OPINPUT: 'Out of scope',
};

function taxTypeCellHtml(taxType, taxTypes = invoiceTaxTypes()) {
  const short = TAX_TYPE_SHORT_NAME[taxType] || '';
  const full = taxTypeLabel(taxType, taxTypes);
  return `<span class="inv-cell-text" title="${escapeHtml(full)}"><span class="inv-tax-code">${escapeHtml(taxType)}</span>${short ? `<span class="inv-tax-name">${escapeHtml(short)}</span>` : ''}</span>`;
}

function isLineReviewed(line) {
  return line.reviewed === true;
}

function bucketReviewState(bucket) {
  const pushable = pushableBucketLines(bucket);
  const reviewedCount = pushable.filter(isLineReviewed).length;
  return {
    pushable,
    reviewedCount,
    allReviewed: pushable.length > 0 && reviewedCount === pushable.length,
  };
}

function invoicePushNote(bucket) {
  const { pushable, reviewedCount, allReviewed } = bucketReviewState(bucket);
  if (pushable.length === 0) return '';
  if (allReviewed) return 'HowMuch/YNAB stay TODO until you mark checked lines claimed.';
  return `Review every line before pushing (${reviewedCount}/${pushable.length} reviewed).`;
}

function invoiceSectionMeta(bucket, lines, total) {
  const { pushable, reviewedCount } = bucketReviewState(bucket);
  const amount = `S$${total.toFixed(2)}`;
  if (pushable.length === 0) return `${lines.length} items · ${amount}`;
  if (pushable.length === lines.length) {
    return `${pushable.length} bill lines · ${amount} · ${reviewedCount}/${pushable.length} reviewed`;
  }
  return `${lines.length} items · ${pushable.length} will push · ${amount} · ${reviewedCount}/${pushable.length} reviewed`;
}

function invoicePeriodLabel(lines) {
  const dates = lines
    .map((line) => String(line?.date || ''))
    .filter((date) => /^\d{4}-\d{2}/.test(date))
    .sort();
  if (!dates.length) return '';
  const start = dates[0];
  const end = dates[dates.length - 1];
  const monthName = (iso) => MONTH_SHORT[Number(iso.slice(5, 7)) - 1] || iso.slice(5, 7);
  const startYear = start.slice(0, 4);
  const endYear = end.slice(0, 4);
  if (startYear === endYear && start.slice(5, 7) === end.slice(5, 7)) {
    return `${monthName(start)}-${monthName(end)} ${startYear}`;
  }
  if (startYear === endYear) return `${monthName(start)}-${monthName(end)} ${startYear}`;
  return `${monthName(start)} ${startYear}-${monthName(end)} ${endYear}`;
}

function defaultDraftReference(bucket, lines = []) {
  const period = invoicePeriodLabel(lines);
  const label = BUCKET_LABEL[bucket];
  return period ? `${label} - YJ ${period}` : label;
}

function invoiceSectionStatusHtml() {
  return 'Payee <strong>Soon Yin Jie</strong> · amounts are tax-inclusive SGD';
}

function hasLeftoverDraftStamp(line) {
  return Boolean(line?.xeroPendingInvoiceId || line?.xeroPendingInvoiceNumber);
}

function leftoverDraftStampKeys(lines) {
  return [...new Set(lines.filter(hasLeftoverDraftStamp).map((line) => line.receiptKey).filter(Boolean))];
}

function setLineReviewed(line, reviewed, btn) {
  line.reviewed = reviewed;
  line.reviewInvalidated = false;
  saveInvoiceEdit(line.id, {
    reviewed,
    reviewedSnapshot: reviewed ? lineReviewSnapshot(line) : null,
    reviewedSourceSnapshot: reviewed ? (line.sourceSnapshot || lineReviewSnapshot(line)) : null,
    reviewInvalidated: false,
  });
  if (btn) {
    btn.classList.toggle('is-reviewed', reviewed);
    btn.setAttribute('aria-pressed', reviewed ? 'true' : 'false');
    btn.setAttribute(
      'aria-label',
      reviewed ? 'Marked reviewed — tap to unmark' : 'Mark line as reviewed after checking receipt',
    );
  }
  const row = btn?.closest('tr[data-id]');
  if (row) {
    row.classList.toggle('inv-row-reviewed', reviewed);
    if (reviewed) {
      row.classList.remove('inv-row-stale');
      const note = row.nextElementSibling;
      if (note?.classList.contains('inv-row-note')) note.remove();
    }
  }
  updateSectionHeaders();
}

// The user just changed this line by hand, so it is still reviewed: refresh the
// stored snapshot so the reload-time "data changed underneath you" check keeps
// matching. Only source data changing on its own should untick a line.
function reaffirmLineReviewAfterEdit(line, contextEl) {
  if (!isLineReviewed(line)) return;
  const tr = contextEl?.closest?.('tr[data-id]');
  const btn = tr?.querySelector('.inv-review-btn');
  setLineReviewed(line, true, btn);
}

function renderInvoiceStaleNoteRow() {
  return `
    <tr class="inv-row-note">
      <td colspan="8">
        <span class="inv-review-stale">Receipt or claim data changed since this line was reviewed — check it and tick again.</span>
      </td>
    </tr>`;
}

function invoiceMemoHtml(line) {
  return escapeHtml(line.description || '—');
}

function invoiceRemarkHtml(line) {
  return `<span class="inv-detail-label">Remark:</span> ${escapeHtml(line.remark || '—')}`;
}

function invoiceMemoRemarkHtml(line) {
  return `
    <div class="inv-description-stack">
      <div class="inv-cell-editable inv-description-memo" data-field="description" title="Double-click memo to edit">${invoiceMemoHtml(line)}</div>
      <div class="inv-cell-editable inv-description-remark" data-field="remark" title="Double-click remark to edit">${invoiceRemarkHtml(line)}</div>
    </div>`;
}

function invoiceSourceLabel(line) {
  if (!line.ynabClaimId) return 'Receipt only';
  return line.claimsBackend === 'howmuch' ? 'HowMuch' : 'YNAB';
}

function invoiceSourceHtml(line) {
  const label = invoiceSourceLabel(line);
  if (!line.sourceUrl) return `<span class="inv-source-label">${label}</span>`;
  return `<a class="inv-source-label inv-source-link" href="${escapeHtml(line.sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${label} transaction">${label}</a>`;
}

function renderInvoiceLineRow(line, accounts) {
  const section = getLineSection(line);
  const reviewed = isLineReviewed(line);
  const invalidated = line.reviewInvalidated === true;
  return `
    <tr data-id="${escapeHtml(line.id)}" class="${reviewed ? 'inv-row-reviewed' : ''}${invalidated ? ' inv-row-stale' : ''}">
      <td class="col-actions" data-label="Actions">
        <div class="inv-action-stack">
          <div class="inv-row-actions">
            <button type="button" class="inv-preview-btn" title="Preview receipt" aria-label="Preview receipt">${EYE_ICON}</button>
            <button type="button" class="inv-review-btn${reviewed ? ' is-reviewed' : ''}"
                aria-pressed="${reviewed ? 'true' : 'false'}"
                aria-label="${reviewed ? 'Marked reviewed — tap to unmark' : 'Mark line as reviewed after checking receipt'}">
              <span class="inv-review-check" aria-hidden="true">✓</span>
            </button>
            <button type="button" class="inv-unlink-btn" title="Unlink from invoice list" aria-label="Unlink from invoice list">⛔</button>
          </div>
          ${invoiceSourceHtml(line)}
        </div>
      </td>
      <td class="inv-cell-editable inv-cell-date" data-label="Date" data-field="date" data-input="text" title="Tap to edit"><span class="inv-cell-text">${escapeHtml(line.date || '—')}</span></td>
      <td class="inv-cell-payee" data-label="Payee"><span class="inv-description-payee">${escapeHtml(line.payee || 'Unknown payee')}</span></td>
      <td class="inv-cell-memo" data-label="Memo">${invoiceMemoRemarkHtml(line)}</td>
      <td class="inv-cell-editable inv-cell-account" data-label="Account" data-field="accountCode" data-input="select" title="Tap to edit"><span class="inv-cell-text">${escapeHtml(accountLabel(line.accountCode, accounts))}</span></td>
      <td class="inv-cell-editable inv-cell-type" data-label="Type" data-field="section" data-input="type" title="Tap to edit"><span class="inv-cell-text">${escapeHtml(BUCKET_LABEL[section])}</span></td>
      <td class="inv-cell-editable inv-cell-tax" data-label="Tax" data-field="taxType" data-input="select" title="Tap to edit">${taxTypeCellHtml(deriveTaxType(line))}</td>
      <td class="num inv-cell-editable inv-cell-amount" data-label="Amount" data-field="amount" data-input="text" title="Tap to edit"><span class="inv-cell-text">S$${Number(line.amount).toFixed(2)}</span></td>
    </tr>${invalidated ? renderInvoiceStaleNoteRow() : ''}`;
}

function renderInvoiceSortOptions(bucket) {
  const selected = invoiceSortForBucket(bucket);
  return INVOICE_SORT_OPTIONS
    .map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === selected ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
}

function renderInvoiceSection(bucket, lines, accounts) {
  const total = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const collapsed = Boolean(loadSectionCollapsedState()[bucket]);
  const rowsHtml = lines.map((line) => renderInvoiceLineRow(line, accounts)).join('');
  const { pushable, allReviewed } = bucketReviewState(bucket);
  const checkedCount = pushable.filter(isLineReviewed).length;
  const noteClass = pushable.length > 0 && !allReviewed ? 'invoice-doc-note invoice-doc-note-warn' : 'invoice-doc-note';
  const stampKeys = leftoverDraftStampKeys(lines);
  const stampBtn = stampKeys.length
    ? `<button type="button" class="btn-secondary invoice-clear-stamps-btn" data-bucket="${bucket}">Clear stale draft stamps</button>`
    : '';
  const pushActions = pushable.length > 0
    ? `<button type="button" class="btn-primary invoice-push-btn" data-bucket="${bucket}" ${allReviewed ? '' : 'disabled'}>Push to Xero (draft)</button>
          <button type="button" class="btn-secondary invoice-download-btn" data-bucket="${bucket}">Download receipts PDF</button>
          <button type="button" class="btn-secondary invoice-claim-checked-btn" data-bucket="${bucket}" ${checkedCount ? '' : 'disabled'}>Mark checked as claimed</button>
          <span class="${noteClass}">${escapeHtml(invoicePushNote(bucket))}</span>`
    : '';
  const actionsHtml = (pushActions || stampBtn)
    ? `<div class="invoice-doc-actions">
          ${pushActions}
          ${stampBtn}
        </div>`
    : '';
  return `
    <details class="invoice-section invoice-section-${bucket}" data-bucket="${bucket}" ${collapsed ? '' : 'open'}>
      <summary class="invoice-section-header">
        <span class="invoice-section-title">${BUCKET_HEADING[bucket]}</span>
        <span class="invoice-section-meta" aria-live="polite">${invoiceSectionMeta(bucket, lines, total)}</span>
      </summary>
      <div class="invoice-section-body">
        <p class="invoice-doc-sub">${invoiceSectionStatusHtml()}</p>
        <div class="invoice-section-tools">
          <label class="invoice-sort-label">
            <span>Sort</span>
            <select class="invoice-sort-select" data-sort-bucket="${bucket}">
              ${renderInvoiceSortOptions(bucket)}
            </select>
          </label>
        </div>
        <div class="invoice-section-table-wrap">
          <table class="invoice-doc-table">
            <thead>
              <tr>
                <th class="col-actions">Actions</th>
                <th class="col-date">Date</th>
                <th class="col-payee">Payee</th>
                <th class="col-memo">Memo</th>
                <th class="col-account">Account</th>
                <th class="col-type">Type</th>
                <th class="col-tax">Tax</th>
                <th class="col-amount num">Amount</th>
              </tr>
            </thead>
            <tbody>${rowsHtml || `<tr><td colspan="8" class="empty-state">No ${BUCKET_LABEL[bucket]} items yet.</td></tr>`}</tbody>
            <tfoot>
              <tr>
                <td></td>
                <td colspan="6" class="num"><strong>Total</strong></td>
                <td class="num"><strong>S$${total.toFixed(2)}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div class="invoice-section-status" role="status" aria-live="polite"></div>
        ${actionsHtml}
      </div>
    </details>`;
}

function closeActiveInvoiceEdit({ commit = false } = {}) {
  if (!activeInvoiceEditCell) return;
  if (commit && activeInvoiceEditCell._commitEdit) {
    activeInvoiceEditCell._commitEdit();
  } else if (activeInvoiceEditCell._cancelEdit) {
    activeInvoiceEditCell._cancelEdit();
  }
}

function commitActiveInvoiceEdit() {
  closeActiveInvoiceEdit({ commit: true });
}

function attachTextEditCell(cell, line, field, {
  inputType = 'text', inputAttrs = '', format, parse, displayHtml, editOnDoubleClick = false,
}) {
  const renderDisplay = () => {
    cell.classList.remove('is-editing');
    if (displayHtml) {
      cell.innerHTML = displayHtml(line);
      cell.onclick = editOnDoubleClick ? null : () => startEdit();
      cell.ondblclick = editOnDoubleClick ? () => startEdit() : null;
      return;
    }
    const value = format ? format(line[field]) : (line[field] ?? '');
    const text = String(value ?? '').trim();
    // An empty value still needs something to tap on.
    cell.innerHTML = `<span class="inv-cell-text">${escapeHtml(text || '—')}</span>`;
    cell.onclick = () => startEdit();
  };

  const startEdit = () => {
    if (cell.classList.contains('is-editing')) return;
    closeActiveInvoiceEdit({ commit: true });
    activeInvoiceEditCell = cell;
    cell.classList.add('is-editing');
    const original = line[field];
    const editValue = inputType === 'number' ? Number(original).toFixed(2) : (original ?? '');
    cell.innerHTML = `
      <div class="inv-edit-wrap">
        <input type="${inputType}" class="inv-edit-input" value="${escapeHtml(String(editValue))}" ${inputAttrs}>
        <div class="inv-edit-actions">
          <button type="button" class="inv-edit-confirm" title="Save">Save</button>
          <button type="button" class="inv-edit-cancel" title="Cancel">✕</button>
        </div>
      </div>`;
    const input = cell.querySelector('.inv-edit-input');
    input.focus();
    if (inputType !== 'date') input.select();

    const commit = () => {
      const parsed = parse ? parse(input.value) : input.value;
      const changed = parsed !== original;
      line[field] = parsed;
      saveInvoiceEdit(line.id, { [field]: parsed });
      if (changed) reaffirmLineReviewAfterEdit(line, cell);
      activeInvoiceEditCell = null;
      renderDisplay();
      updateSectionHeaders();
    };

    const cancel = () => {
      line[field] = original;
      activeInvoiceEditCell = null;
      renderDisplay();
    };
    cell._cancelEdit = cancel;
    cell._commitEdit = commit;

    cell.querySelector('.inv-edit-confirm').addEventListener('click', (e) => {
      e.stopPropagation();
      commit();
    });
    cell.querySelector('.inv-edit-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      cancel();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (cell.classList.contains('is-editing') && !cell.contains(document.activeElement)) commit();
      }, 0);
    });
  };

  renderDisplay();
}

function attachAccountEditCell(cell, line, accounts) {
  const renderDisplay = () => {
    cell.classList.remove('is-editing');
    cell.innerHTML = `<span class="inv-cell-text">${escapeHtml(accountLabel(line.accountCode, accounts))}</span>`;
    cell.onclick = () => startEdit();
  };

  const startEdit = () => {
    if (cell.classList.contains('is-editing')) return;
    closeActiveInvoiceEdit({ commit: true });
    activeInvoiceEditCell = cell;
    cell.classList.add('is-editing');
    const options = accounts
      .map((a) => `<option value="${escapeHtml(a.code)}" ${a.code === line.accountCode ? 'selected' : ''}>${escapeHtml(accountLabel(a.code, accounts))}</option>`)
      .join('');
    cell.innerHTML = `<select class="inv-edit-select">${options}</select>`;
    const select = cell.querySelector('.inv-edit-select');
    select.focus();
    const originalCode = line.accountCode;
    const commit = () => {
      const nextCode = select.value;
      const prevSection = getLineSection(line);
      const changed = nextCode !== originalCode;
      line.accountCode = nextCode;
      saveInvoiceEdit(line.id, { accountCode: line.accountCode });
      activeInvoiceEditCell = null;
      if (TRANSPORT_CODES.includes(line.accountCode) && getLineSection(line) !== 'transport') {
        setLineSection(line, 'transport');
        renderInvoiceEditor();
        return;
      }
      if (line.section === 'transport' && !TRANSPORT_CODES.includes(line.accountCode)) {
        line.section = lineBucket(line);
        saveInvoiceEdit(line.id, { section: line.section, accountCode: line.accountCode });
        reaffirmLineReviewAfterEdit(line);
        renderInvoiceEditor();
        return;
      }
      if (changed) reaffirmLineReviewAfterEdit(line, cell);
      renderDisplay();
      if (getLineSection(line) !== prevSection) renderInvoiceEditor();
      else updateSectionHeaders();
    };
    cell._cancelEdit = () => {
      activeInvoiceEditCell = null;
      renderDisplay();
    };
    cell._commitEdit = commit;
    select.addEventListener('change', commit);
    select.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (cell.classList.contains('is-editing')) commit();
      }, 0);
    });
    select.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cell._cancelEdit();
      }
    });
  };

  renderDisplay();
}

function attachTaxTypeEditCell(cell, line) {
  const taxTypes = invoiceTaxTypes();
  const renderDisplay = () => {
    cell.classList.remove('is-editing');
    cell.innerHTML = taxTypeCellHtml(deriveTaxType(line), taxTypes);
    cell.onclick = () => startEdit();
  };

  const startEdit = () => {
    if (cell.classList.contains('is-editing')) return;
    closeActiveInvoiceEdit({ commit: true });
    activeInvoiceEditCell = cell;
    cell.classList.add('is-editing');
    const current = deriveTaxType(line);
    const options = taxTypes
      .map((t) => `<option value="${escapeHtml(t.taxType)}" ${t.taxType === current ? 'selected' : ''}>${escapeHtml(taxTypeLabel(t.taxType, taxTypes))}</option>`)
      .join('');
    cell.innerHTML = `<select class="inv-edit-select">${options}</select>`;
    const select = cell.querySelector('.inv-edit-select');
    select.focus();
    const commit = () => {
      const next = select.value;
      const prevSection = getLineSection(line);
      const changed = next !== current;
      line.taxType = next;
      line.gstShown = next === 'INPUTY24';
      saveInvoiceEdit(line.id, { taxType: line.taxType, gstShown: line.gstShown });
      activeInvoiceEditCell = null;
      if (getLineSection(line) !== lineBucket(line)) {
        line.section = lineBucket(line);
        saveInvoiceEdit(line.id, { section: line.section });
      }
      if (changed) reaffirmLineReviewAfterEdit(line, cell);
      if (getLineSection(line) !== prevSection) renderInvoiceEditor();
      else renderDisplay();
      updateSectionHeaders();
    };
    cell._cancelEdit = () => {
      activeInvoiceEditCell = null;
      renderDisplay();
    };
    cell._commitEdit = commit;
    select.addEventListener('change', commit);
    select.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (cell.classList.contains('is-editing')) commit();
      }, 0);
    });
    select.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cell._cancelEdit();
      }
    });
  };

  renderDisplay();
}

function attachTypeEditCell(cell, line) {
  const renderDisplay = () => {
    cell.classList.remove('is-editing');
    cell.innerHTML = `<span class="inv-cell-text">${escapeHtml(BUCKET_LABEL[getLineSection(line)])}</span>`;
    cell.onclick = () => startEdit();
  };

  const startEdit = () => {
    if (cell.classList.contains('is-editing')) return;
    closeActiveInvoiceEdit({ commit: true });
    activeInvoiceEditCell = cell;
    cell.classList.add('is-editing');
    const current = getLineSection(line);
    const options = INVOICE_BUCKETS
      .map((b) => `<option value="${b}" ${b === current ? 'selected' : ''}>${escapeHtml(BUCKET_LABEL[b])}</option>`)
      .join('');
    cell.innerHTML = `<select class="inv-edit-select">${options}</select>`;
    const select = cell.querySelector('.inv-edit-select');
    select.focus();
    const commit = () => {
      const next = select.value;
      activeInvoiceEditCell = null;
      if (next !== getLineSection(line)) {
        setLineSection(line, next);
        renderInvoiceEditor();
      } else {
        renderDisplay();
      }
    };
    cell._cancelEdit = () => {
      activeInvoiceEditCell = null;
      renderDisplay();
    };
    cell._commitEdit = commit;
    select.addEventListener('change', commit);
    select.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (cell.classList.contains('is-editing')) commit();
      }, 0);
    });
    select.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cell._cancelEdit();
      }
    });
  };

  renderDisplay();
}

function attachInvoiceRowEditors(tr, line, accounts) {
  const reviewBtn = tr.querySelector('.inv-review-btn');
  if (reviewBtn) {
    reviewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setLineReviewed(line, !isLineReviewed(line), reviewBtn);
    });
  }
  attachTextEditCell(tr.querySelector('[data-field="date"]'), line, 'date', { inputType: 'date' });
  attachTextEditCell(tr.querySelector('[data-field="description"]'), line, 'description', {
    inputType: 'text',
    displayHtml: invoiceMemoHtml,
    editOnDoubleClick: true,
  });
  attachTextEditCell(tr.querySelector('[data-field="remark"]'), line, 'remark', {
    inputType: 'text',
    displayHtml: invoiceRemarkHtml,
    editOnDoubleClick: true,
  });
  attachAccountEditCell(tr.querySelector('[data-field="accountCode"]'), line, accounts);
  attachTypeEditCell(tr.querySelector('[data-field="section"]'), line);
  attachTaxTypeEditCell(tr.querySelector('[data-field="taxType"]'), line);
  attachTextEditCell(tr.querySelector('[data-field="amount"]'), line, 'amount', {
    inputType: 'number',
    inputAttrs: 'step="0.01" min="0"',
    format: (v) => `S$${Number(v).toFixed(2)}`,
    parse: (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    },
  });
  tr.querySelector('.inv-preview-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    commitActiveInvoiceEdit();
    openPreview(line.receiptKey, line.receiptName, {
      amount: formatCurrencyAmount('SGD', Number(line.amount)),
      onReview: () => setLineReviewed(line, true, reviewBtn),
    });
  });
  const unlinkBtn = tr.querySelector('.inv-unlink-btn');
  if (unlinkBtn) {
    unlinkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const proceed = window.confirm(`Unlink ${line.receiptName || line.description || 'this receipt'} from the invoice list?`);
      if (!proceed) return;
      unlinkInvoiceLine(line, unlinkBtn);
    });
  }
}

async function unlinkInvoiceLine(line, btn) {
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  try {
    const res = await fetch(`${API_BASE}/receipt/${encodeURIComponent(line.receiptKey)}/link`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    showStatus('success', `Unlinked ${line.receiptName || line.description || 'receipt'} from the invoice list.`);
    await refreshInvoicesView({ showLoading: false, reloadClaims: false });
  } catch (err) {
    showStatus('error', `Could not unlink receipt: ${err instanceof Error ? err.message : String(err)}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || '⛔';
    }
  }
}

async function clearLeftoverDraftStamps(bucket, btn) {
  const keys = leftoverDraftStampKeys(bucketLines(bucket));
  if (keys.length === 0) {
    showStatus('error', `No leftover draft stamps in ${BUCKET_LABEL[bucket]}.`);
    return;
  }
  const proceed = window.confirm(
    `Clear leftover draft stamps from ${keys.length} ${BUCKET_LABEL[bucket]} receipt${keys.length === 1 ? '' : 's'}? ` +
    'This only removes portal metadata (xeroPending*). It does not delete receipts or mark anything claimed.',
  );
  if (!proceed) return;

  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Clearing...';
  }
  try {
    const failures = [];
    for (const key of keys) {
      const res = await fetch(`${API_BASE}/receipt/${encodeURIComponent(key)}/xero-pending`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        failures.push(`${key}: ${data.error || `HTTP ${res.status}`}`);
      }
    }
    if (failures.length) {
      showStatus('error', `Cleared with issues: ${failures.slice(0, 2).join(' ')}`);
    } else {
      showStatus('success', `Cleared leftover draft stamps from ${keys.length} receipt${keys.length === 1 ? '' : 's'}.`);
    }
    await refreshInvoicesView({ showLoading: false, reloadClaims: false });
  } catch (err) {
    showStatus('error', `Could not clear draft stamps: ${err instanceof Error ? err.message : String(err)}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || 'Clear stale draft stamps';
    }
  }
}

function updateSectionHeaders() {
  if (!invoicesSectionsEl) return;
  INVOICE_BUCKETS.forEach((bucket) => {
    const section = invoicesSectionsEl.querySelector(`.invoice-section[data-bucket="${bucket}"]`);
    if (!section) return;
    const lines = sortBucketLines(bucketLines(bucket), bucket);
    const total = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
    const { pushable, allReviewed } = bucketReviewState(bucket);
    const meta = section.querySelector('.invoice-section-meta');
    if (meta) meta.textContent = invoiceSectionMeta(bucket, lines, total);
    const pushBtn = section.querySelector('.invoice-push-btn');
    if (pushBtn) pushBtn.disabled = pushable.length === 0 || !allReviewed;
    const claimBtn = section.querySelector('.invoice-claim-checked-btn');
    if (claimBtn) claimBtn.disabled = pushable.filter(isLineReviewed).length === 0;
    const note = section.querySelector('.invoice-doc-note');
    if (note) {
      note.textContent = invoicePushNote(bucket);
      note.classList.toggle('invoice-doc-note-warn', pushable.length > 0 && !allReviewed);
    }
    const totalCell = section.querySelector('tfoot tr td.num + td.num strong');
    if (totalCell) totalCell.textContent = `S$${total.toFixed(2)}`;
  });
}

function bindInvoiceSectionEvents() {
  if (!invoicesSectionsEl) return;
  invoicesSectionsEl.querySelectorAll('.invoice-section').forEach((section) => {
    const bucket = section.dataset.bucket;
    section.addEventListener('toggle', () => {
      saveSectionCollapsed(bucket, !section.open);
    });
    const pushBtn = section.querySelector('.invoice-push-btn');
    if (pushBtn) {
      pushBtn.addEventListener('click', () => pushInvoice(bucket, pushBtn));
    }
    const downloadBtn = section.querySelector('.invoice-download-btn');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => downloadBucketReceiptsPdf(bucket, downloadBtn));
    }
    const claimBtn = section.querySelector('.invoice-claim-checked-btn');
    if (claimBtn) {
      claimBtn.addEventListener('click', () => markCheckedSectionClaimed(bucket, claimBtn));
    }
    const clearStampsBtn = section.querySelector('.invoice-clear-stamps-btn');
    if (clearStampsBtn) {
      clearStampsBtn.addEventListener('click', () => clearLeftoverDraftStamps(bucket, clearStampsBtn));
    }
    const sortSelect = section.querySelector('.invoice-sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        saveInvoiceSort(bucket, sortSelect.value);
        renderInvoiceEditor();
      });
    }
    const tbody = section.querySelector('tbody');
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      const line = invoiceLines.find((l) => l.id === tr.dataset.id);
      if (line) attachInvoiceRowEditors(tr, line, invoiceAccounts());
    });
  });
}

function renderInvoiceEditor() {
  if (claimsLoadErrorMessage) {
    renderInvoiceClaimLoadError();
    return;
  }

  commitActiveInvoiceEdit();

  const accounts = invoiceAccounts();
  const generation = ++invoiceRenderGeneration;
  if (invoicesEmpty) invoicesEmpty.textContent = INVOICE_EMPTY_TEXT;
  updateInvoicesVisibility();

  if (!invoicesSectionsEl) return;

  if (invoiceLines.length === 0) {
    invoicesSectionsEl.innerHTML = '';
    return;
  }

  invoicesSectionsEl.innerHTML = INVOICE_BUCKETS
    .map((bucket) => renderInvoiceSection(bucket, sortBucketLines(bucketLines(bucket), bucket), accounts))
    .join('');

  if (generation !== invoiceRenderGeneration) return;
  bindInvoiceSectionEvents();
  restoreLastPushResult();
}

function renderInvoiceEditorDeferred() {
  const generation = ++invoiceRenderGeneration;
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (generation === invoiceRenderGeneration) renderInvoiceEditor();
        resolve();
      }, 0);
    });
  });
}

// Rebuild and render the editor from data that is already loaded (page init,
// auth success), so the Invoices tab doesn't fetch everything a second time.
export function renderInvoicesFromLoadedData() {
  buildInvoiceLines();
  renderInvoiceEditor();
  setInvoicesLoading(false);
}

// reloadClaims: false when the action only touched receipt metadata (unlink,
// GST detection, push) — claim memos only change on "mark claimed".
async function refreshInvoicesView({ showLoading = true, reloadClaims = true } = {}) {
  commitActiveInvoiceEdit();
  if (showLoading) {
    invoiceLoadingRequests += 1;
    setInvoicesLoading(true);
  }
  try {
    await Promise.all([loadReceipts(), reloadClaims ? loadYnabTodos() : Promise.resolve()]);
    buildInvoiceLines();
    await renderInvoiceEditorDeferred();
  } finally {
    if (showLoading) {
      invoiceLoadingRequests = Math.max(0, invoiceLoadingRequests - 1);
      if (invoiceLoadingRequests === 0) setInvoicesLoading(false);
    }
  }
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
}

function compareDate(a, b, direction = 'asc') {
  const cmp = compareText(a.date, b.date) || compareText(a.description, b.description);
  return direction === 'desc' ? -cmp : cmp;
}

function compareAmount(a, b, direction = 'desc') {
  const cmp = (Number(a.amount) || 0) - (Number(b.amount) || 0);
  if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
  return compareDate(a, b, 'asc');
}

function sortBucketLines(lines, bucket) {
  const sort = invoiceSortForBucket(bucket);
  return lines.slice().sort((a, b) => {
    if (sort === 'date-asc') return compareDate(a, b, 'asc');
    if (sort === 'date-desc') return compareDate(a, b, 'desc');
    if (sort === 'amount-desc') return compareAmount(a, b, 'desc');
    if (sort === 'amount-asc') return compareAmount(a, b, 'asc');
    if (sort === 'description-asc') return compareText(a.description, b.description) || compareDate(a, b, 'asc');
    if (a.accountCode !== b.accountCode) return compareText(a.accountCode, b.accountCode);
    return compareDate(a, b, 'asc');
  });
}

function bucketLines(bucket) {
  return invoiceLines.filter((l) => l.include && getLineSection(l) === bucket);
}

function pushableBucketLines(bucket) {
  return sortBucketLines(bucketLines(bucket), bucket).filter((l) => (Number(l.amount) || 0) > 0);
}

// YNAB transfer transactions carry a payee like "Transfer : Work Refundables",
// which is internal noise — don't append it (or the date) to the line.
function isTransferPayee(payee) {
  return /^\s*transfer\s*:/i.test(payee || '');
}

function lineToDescription(line) {
  const hasRealPayee = line.payee && !isTransferPayee(line.payee);
  const base = hasRealPayee ? `${line.description} — ${line.payee} (${line.date})` : line.description;
  return line.remark ? `${base} — ${line.remark}` : base;
}

function formatReceiptPageReference(ref) {
  if (!ref || !Number.isFinite(ref.start) || !Number.isFinite(ref.end)) return '';
  return ref.start === ref.end ? `Receipt: p. ${ref.start}` : `Receipt: pp. ${ref.start}-${ref.end}`;
}

function lineRemarkSuffix(line) {
  const remark = String(line.remark || '').trim();
  return remark ? `Remark: ${remark}` : '';
}

function lineToDescriptionWithPageRef(line, pageRefs) {
  const hasRealPayee = line.payee && !isTransferPayee(line.payee);
  const base = hasRealPayee ? `${line.description} — ${line.payee} (${line.date})` : line.description;
  const suffixes = [lineRemarkSuffix(line), formatReceiptPageReference(pageRefs?.get?.(line.receiptKey))].filter(Boolean);
  return suffixes.length ? `${base} — ${suffixes.join(' — ')}` : base;
}

function sectionStatusEl(bucket) {
  return invoicesSectionsEl?.querySelector(`.invoice-section[data-bucket="${bucket}"] .invoice-section-status`) || null;
}

function lineTaxTypeForPush(line, bucket) {
  if (bucket === 'gst' || getLineSection(line) === 'gst') return 'INPUTY24';
  if (deriveTaxType(line) === 'INPUTY24') return nonGstTaxType(line);
  return deriveTaxType(line);
}

function pushPayloadForLines(bucket, reference, lines, pageRefs = null) {
  const claimBackends = [...new Set(lines.filter((line) => line.ynabClaimId).map((line) => line.claimsBackend))];
  if (claimBackends.length > 1 || claimBackends.some((backend) => backend !== 'howmuch' && backend !== 'ynab')) {
    throw new Error('Invoice lines must come from one known claims backend.');
  }
  const backend = claimBackends[0] || getClaimsBackend();
  return {
    bucket,
    reference,
    backend,
    lineItems: lines.map((l) => ({
      receiptKey: l.receiptKey,
      ynabClaimId: l.ynabClaimId,
      claimSource: l.claimSource || null,
      claimDescription: l.claimDescription || null,
      claimsBackend: l.claimsBackend || backend,
      date: l.date,
      description: lineToDescriptionWithPageRef(l, pageRefs),
      accountCode: l.accountCode,
      taxType: lineTaxTypeForPush(l, bucket),
      currency: l.currency,
      amount: Number(l.amount),
    })),
  };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearReceiptPdfLinks() {
  document.querySelectorAll('.invoice-save-pdf-link').forEach((link) => link.remove());
  if (activeReceiptPdfUrl) {
    URL.revokeObjectURL(activeReceiptPdfUrl);
    activeReceiptPdfUrl = null;
  }
}

function showReceiptPdfLink(blob, filename, btn) {
  clearReceiptPdfLinks();
  activeReceiptPdfUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = activeReceiptPdfUrl;
  link.download = filename;
  link.className = 'btn-secondary invoice-save-pdf-link';
  link.textContent = 'Save PDF';
  link.setAttribute('role', 'button');
  link.setAttribute('aria-label', `Save ${filename}`);
  const actions = btn?.closest?.('.invoice-doc-actions, .invoice-result-actions');
  if (actions) {
    btn.insertAdjacentElement('afterend', link);
  } else {
    document.body.appendChild(link);
  }
  return link;
}

function safeReceiptBundleName(payload) {
  const safeBucket = BUCKET_LABEL[payload.bucket] || 'Claims';
  const safeReference = (payload.reference || `${safeBucket} receipts`).replace(/[^a-z0-9 _.-]/gi, ' ').replace(/\s+/g, ' ').trim();
  return `${safeReference || safeBucket} receipts.pdf`;
}

function receiptFilenameFromKey(key, index) {
  const fallback = `receipt-${String(index + 1).padStart(2, '0')}`;
  const raw = decodeURIComponent(String(key || '')).split('/').pop() || fallback;
  return raw.replace(/[^a-z0-9 _.,@()\\-]/gi, '_') || fallback;
}

function uniquePayloadReceiptKeys(payload) {
  const seen = new Set();
  const keys = [];
  (payload.lineItems || []).forEach((line) => {
    if (!line.receiptKey || seen.has(line.receiptKey)) return;
    seen.add(line.receiptKey);
    keys.push(line.receiptKey);
  });
  return keys;
}

async function downloadOriginalReceipts(payload) {
  const keys = uniquePayloadReceiptKeys(payload);
  let downloaded = 0;
  const failures = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const res = await fetch(`${API_BASE}/receipt/${encodeURIComponent(key)}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      downloadBlob(blob, receiptFilenameFromKey(key, i));
      downloaded += 1;
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    } catch (err) {
      failures.push(`${receiptFilenameFromKey(key, i)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (downloaded > 0 && failures.length === 0) {
    showStatus('success', `Downloaded ${downloaded} original receipt file(s).`);
  } else if (downloaded > 0) {
    showStatus('error', `Downloaded ${downloaded}; ${failures.length} failed: ${failures.slice(0, 2).join(', ')}`);
  } else {
    throw new Error(failures.slice(0, 2).join(', ') || 'No receipts downloaded');
  }
}

async function loadPdfLib() {
  if (!pdfLibModule) {
    pdfLibModule = await import('./lib/pdf-lib.esm.min.js');
  }
  return pdfLibModule;
}

function isEmbeddableReceiptMime(mime) {
  return mime === 'application/pdf'
    || mime === 'image/jpeg'
    || mime === 'image/jpg'
    || mime === 'image/png';
}

function isImageReceiptMime(mime) {
  return mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/png';
}

async function decodeReceiptImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (_err) {
      // Fall through to the HTMLImageElement path below.
    }
  }

  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image receipt'));
    };
    image.src = url;
  });
}

async function canvasToJpegBytes(canvas) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('Could not encode receipt as JPEG'));
    }, 'image/jpeg', RECEIPT_JPEG_QUALITY);
  });
  return await blob.arrayBuffer();
}

async function processReceiptImage(bytes, mime) {
  const image = await decodeReceiptImage(bytes, mime);
  const sourceWidth = image.width || image.naturalWidth;
  const sourceHeight = image.height || image.naturalHeight;
  const landscape = sourceWidth > sourceHeight;
  const rotatedWidth = landscape ? sourceHeight : sourceWidth;
  const rotatedHeight = landscape ? sourceWidth : sourceHeight;
  const targetWidth = RECEIPT_PDF_PAGE_WIDTH;
  const targetHeight = Math.max(1, Math.round((rotatedHeight / rotatedWidth) * targetWidth));
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas is unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (landscape) {
    ctx.translate(targetWidth, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(image, 0, 0, targetHeight, targetWidth);
  } else {
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
  }

  if (typeof image.close === 'function') image.close();
  return {
    bytes: await canvasToJpegBytes(canvas),
    width: targetWidth,
    height: targetHeight,
  };
}

async function receiptPdfPageCount(PDFDocument, receipt) {
  const { bytes, mime } = receipt;
  if (mime === 'application/pdf') {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return src.getPageCount();
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/png') return 1;
  return 0;
}

async function buildReceiptPdfPlan(payload, { statusPrefix = 'Reading receipt pages' } = {}) {
  const { PDFDocument } = await loadPdfLib();
  const keys = uniquePayloadReceiptKeys(payload);
  const entries = [];
  const warnings = [];
  let nextPage = 1;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const name = receiptFilenameFromKey(key, i);
    showStatus('uploading', `${statusPrefix} (${i + 1}/${keys.length})...`);
    try {
      const res = await fetch(`${API_BASE}/receipt/${encodeURIComponent(key)}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const mime = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (!isEmbeddableReceiptMime(mime)) {
        warnings.push(`Skipped unsupported receipt type (${mime}): ${name}`);
        entries.push({ key, name, mime, bytes, pageCount: 0, pageStart: null, pageEnd: null });
        continue;
      }
      const pageCount = await receiptPdfPageCount(PDFDocument, { bytes, mime });
      if (pageCount <= 0) {
        warnings.push(`Could not find any pages in ${name}`);
        entries.push({ key, name, mime, bytes, pageCount: 0, pageStart: null, pageEnd: null });
        continue;
      }
      const pageStart = nextPage;
      const pageEnd = nextPage + pageCount - 1;
      nextPage = pageEnd + 1;
      entries.push({ key, name, mime, bytes, pageCount, pageStart, pageEnd });
    } catch (err) {
      warnings.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      entries.push({ key, name, mime: '', bytes: null, pageCount: 0, pageStart: null, pageEnd: null });
    }
  }

  const pageRefs = new Map();
  entries.forEach((entry) => {
    if (entry.pageStart && entry.pageEnd) {
      pageRefs.set(entry.key, { start: entry.pageStart, end: entry.pageEnd });
    }
  });

  return {
    entries,
    pageRefs,
    warnings,
    included: entries.filter((entry) => entry.pageCount > 0).length,
    totalPages: nextPage - 1,
  };
}

async function appendPdfReceiptToPdf(PDFDocument, degrees, doc, receipt) {
  const src = await PDFDocument.load(receipt.bytes, { ignoreEncryption: true });
  const pages = await doc.embedPdf(receipt.bytes, src.getPageIndices());
  pages.forEach((embeddedPage) => {
    const { width, height } = embeddedPage;
    const landscape = width > height;
    if (landscape) {
      const scale = RECEIPT_PDF_PAGE_WIDTH / height;
      const pageHeight = Math.max(1, width * scale);
      const page = doc.addPage([RECEIPT_PDF_PAGE_WIDTH, pageHeight]);
      page.drawPage(embeddedPage, {
        x: RECEIPT_PDF_PAGE_WIDTH,
        y: 0,
        width: width * scale,
        height: height * scale,
        rotate: degrees(90),
      });
      return;
    }

    const scale = RECEIPT_PDF_PAGE_WIDTH / width;
    const pageHeight = Math.max(1, height * scale);
    const page = doc.addPage([RECEIPT_PDF_PAGE_WIDTH, pageHeight]);
    page.drawPage(embeddedPage, {
      x: 0,
      y: 0,
      width: RECEIPT_PDF_PAGE_WIDTH,
      height: pageHeight,
    });
  });
}

async function appendImageReceiptToPdf(PDFDocument, doc, receipt) {
  const processed = await processReceiptImage(receipt.bytes, receipt.mime);
  const image = await doc.embedJpg(processed.bytes);
  doc.addPage([processed.width, processed.height]).drawImage(image, {
    x: 0,
    y: 0,
    width: processed.width,
    height: processed.height,
  });
}

async function appendReceiptToPdf(PDFDocument, degrees, doc, receipt, warnings) {
  const { bytes, mime, name } = receipt;
  try {
    if (mime === 'application/pdf') {
      await appendPdfReceiptToPdf(PDFDocument, degrees, doc, receipt);
      return;
    }
    if (isImageReceiptMime(mime)) {
      await appendImageReceiptToPdf(PDFDocument, doc, receipt);
      return;
    }
    warnings.push(`Skipped unsupported receipt type (${mime}): ${name}`);
  } catch (err) {
    warnings.push(`Could not include ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function compileReceiptPlanToPdf(plan) {
  const { PDFDocument, degrees } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const warnings = [...plan.warnings];
  let included = 0;

  for (let i = 0; i < plan.entries.length; i++) {
    const entry = plan.entries[i];
    if (!entry.pageCount || !entry.bytes) continue;
    showStatus('uploading', `Writing receipts PDF (${i + 1}/${plan.entries.length})...`);
    const beforeCount = doc.getPageCount();
    await appendReceiptToPdf(PDFDocument, degrees, doc, entry, warnings);
    if (doc.getPageCount() > beforeCount) included += 1;
  }

  if (included === 0) {
    throw new Error(warnings.slice(0, 2).join(', ') || 'No receipts could be compiled');
  }

  const pdfBytes = await doc.save();
  return {
    blob: new Blob([pdfBytes], { type: 'application/pdf' }),
    included,
    skipped: plan.entries.length - included,
    warnings,
    pageRefs: plan.pageRefs,
    totalPages: doc.getPageCount(),
  };
}

async function compileReceiptsPdfInBrowser(payload, plan = null) {
  const receiptPlan = plan || await buildReceiptPdfPlan(payload, { statusPrefix: 'Building receipts PDF' });
  return await compileReceiptPlanToPdf(receiptPlan);
}

async function blobToBase64(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read PDF'));
    reader.readAsDataURL(blob);
  });
  return dataUrl.split(',')[1] || '';
}

async function receiptPdfUploadPayload(blob, filename, warnings) {
  if (blob.size > XERO_ATTACHMENT_MAX_BYTES) {
    throw new Error(`Optimised receipts PDF is ${(blob.size / (1024 * 1024)).toFixed(1)} MB, above Xero's 25 MB attachment limit`);
  }
  return {
    name: filename,
    mime: 'application/pdf',
    byteLength: blob.size,
    base64: await blobToBase64(blob),
    warnings,
  };
}

async function downloadReceiptsPdf(payload, btn) {
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Building PDF...';
  }
  try {
    const compiled = await compileReceiptsPdfInBrowser(payload);
    const filename = safeReceiptBundleName(payload);
    const saveLink = showReceiptPdfLink(compiled.blob, filename, btn);
    downloadBlob(compiled.blob, filename);
    if (compiled.warnings.length) {
      showStatus('error', `PDF ready with ${compiled.included} receipt(s); ${compiled.skipped} skipped. If it did not save automatically, click Save PDF. ${compiled.warnings.slice(0, 2).join(', ')}`);
    } else {
      showStatus('success', `PDF ready with ${compiled.included} receipt(s). If it did not save automatically, click Save PDF.`);
    }
    saveLink.focus({ preventScroll: true });
  } catch (err) {
    showStatus('uploading', `Could not build one PDF in the browser (${err instanceof Error ? err.message : String(err)}). Downloading original receipts instead...`);
    await downloadOriginalReceipts(payload);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || 'Download receipts PDF';
    }
  }
}

function lineItemKey(item) {
  const backend = item?.claimsBackend === 'ynab' ? 'ynab' : item?.claimsBackend === 'howmuch' ? 'howmuch' : '';
  return `${backend}::${legacyLineItemKey(item)}`;
}

function checkedClaimLineItems(bucket, payload) {
  const checkedKeys = new Set(
    pushableBucketLines(bucket)
      .filter(isLineReviewed)
      .map((line) => lineItemKey(line)),
  );
  return (payload.lineItems || []).filter((item) => checkedKeys.has(lineItemKey(item)));
}

async function submitClaimed(invoiceID, lineItems) {
  const backends = [...new Set(lineItems.filter((item) => item.ynabClaimId).map(rememberedClaimsBackendForItem))];
  if (backends.length > 1) throw new Error('Cannot mark claims from different backends together.');
  const backend = backends[0] || getClaimsBackend();
  const claimsById = new Map(claimsData.map((claim) => [claim.id, claim]));
  const attributedLineItems = lineItems.map((item) => ({
    ...item,
    claimsBackend: item.ynabClaimId ? rememberedClaimsBackendForItem(item) : undefined,
    claimDescription: item.ynabClaimId
      ? claimsById.get(item.ynabClaimId)?.description || item.claimDescription
      : undefined,
  }));
  const res = await fetch(`${API_BASE}/xero/invoices/mark-claimed`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceID, lineItems: attributedLineItems, backend }),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok || result.error) {
    const details = (result.claimedYnab || [])
      .filter((r) => r.status !== 'claimed' && r.detail)
      .map((r) => r.detail)
      .slice(0, 2)
      .join(' ');
    throw new Error([result.error || `HTTP ${res.status}`, details].filter(Boolean).join(' '));
  }
  return result;
}

function checkedCurrentPayload(bucket) {
  const lines = pushableBucketLines(bucket).filter(isLineReviewed);
  return pushPayloadForLines(bucket, defaultDraftReference(bucket, lines), lines);
}

function groupedLineItemsByInvoice(lineItems) {
  const groups = new Map();
  const missing = [];
  lineItems.forEach((item) => {
    const invoiceID = rememberedInvoiceIDForItem(item);
    if (!invoiceID) {
      missing.push(item);
      return;
    }
    if (!groups.has(invoiceID)) groups.set(invoiceID, []);
    groups.get(invoiceID).push(item);
  });
  return { groups, missing };
}

async function markLineItemGroupsClaimed(groups, bucket) {
  let claimedDate = '';
  let failedYnab = 0;
  let skippedYnab = 0;
  let failedReceipts = 0;
  const failureDetails = [];
  let count = 0;
  for (const [invoiceID, lineItems] of groups.entries()) {
    const result = await submitClaimed(invoiceID, lineItems);
    claimedDate = result.claimedDate || claimedDate;
    failedYnab += (result.claimedYnab || []).filter((r) => r.status === 'failed').length;
    skippedYnab += (result.claimedYnab || []).filter((r) => r.status === 'skipped').length;
    failedReceipts += (result.taggedReceipts || []).filter((r) => String(r.status || '').startsWith('failed')).length;
    failureDetails.push(
      ...(result.claimedYnab || [])
        .filter((r) => r.status !== 'claimed' && r.detail)
        .map((r) => r.detail),
    );
    count += lineItems.length;
  }
  if (failedYnab || failedReceipts) {
    const detail = failureDetails.length ? ` ${failureDetails.slice(0, 2).join(' ')}` : '';
    showStatus('error', `Marked with issues: ${failedReceipts} receipt tag failure(s), ${failedYnab} backend failure(s), ${skippedYnab} skipped.${detail}`);
  } else {
    showStatus('success', `Marked ${count} checked ${BUCKET_LABEL[bucket]} item${count === 1 ? '' : 's'} claimed${claimedDate ? ` for ${claimedDate}` : ''}${skippedYnab ? ` (${skippedYnab} subtransaction(s) skipped)` : ''}.`);
  }
}

async function markCheckedLineItemsClaimed(bucket, lineItems, btn, { payload = null, invoiceID = '' } = {}) {
  if (lineItems.length === 0) {
    showStatus('error', `No checked ${BUCKET_LABEL[bucket]} lines to mark claimed.`);
    return;
  }
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Marking...';
  }
  try {
    const { groups, missing } = invoiceID
      ? { groups: new Map([[invoiceID, lineItems]]), missing: [] }
      : groupedLineItemsByInvoice(lineItems);
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} checked ${BUCKET_LABEL[bucket]} item${missing.length === 1 ? '' : 's'} do not have a remembered bill from a push in this browser. Push first, or use the draft-created action, before marking claimed.`,
      );
    }
    await markLineItemGroupsClaimed(groups, bucket);
    if (payload && lineItems.length >= (payload.lineItems || []).length) clearLastPushResult();
    await refreshInvoicesView({ showLoading: false });
    if (btn) btn.textContent = 'Marked checked';
  } catch (err) {
    showStatus('error', `Could not mark claimed: ${err instanceof Error ? err.message : String(err)}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || 'Mark checked as claimed';
    }
  }
}

async function markCheckedClaimed(data, payload, bucket, btn) {
  const lineItems = checkedClaimLineItems(bucket, payload);
  await markCheckedLineItemsClaimed(bucket, lineItems, btn, {
    payload,
    invoiceID: data.invoiceID || '',
  });
}

async function markCheckedSectionClaimed(bucket, btn) {
  const payload = checkedCurrentPayload(bucket);
  await markCheckedLineItemsClaimed(bucket, payload.lineItems, btn, { payload });
}

function bindPushResultActions(bucket, data, payload) {
  const container = sectionStatusEl(bucket);
  if (!container) return;
  const downloadBtn = container.querySelector('[data-action="download-receipts-pdf"]');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => downloadReceiptsPdf(payload, downloadBtn));
  }
  const markBtn = container.querySelector('[data-action="mark-checked-claimed"]');
  if (markBtn) {
    markBtn.addEventListener('click', () => markCheckedClaimed(data, payload, bucket, markBtn));
  }
}

function showSectionPushResult(bucket, data, warnings, payload, { persist = true, scroll = true } = {}) {
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const failedAttachments = attachments.filter((a) => a.status !== 'attached');
  const attachedCount = attachments.length - failedAttachments.length;
  const resultClass = data.allAttached === false || failedAttachments.length || warnings.length
    ? 'invoice-push-result invoice-push-result-warn'
    : 'invoice-push-result';
  const summary = data.allAttached === false || failedAttachments.length || warnings.length
    ? `Draft created, but ${failedAttachments.length ? `${failedAttachments.length} attachment upload${failedAttachments.length === 1 ? '' : 's'} failed` : 'some receipts need manual attachment'}.`
    : `Draft created with ${attachedCount} receipt${attachedCount === 1 ? '' : 's'} attached.`;
  const xeroUrl = data.invoiceID
    ? `https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=${encodeURIComponent(data.invoiceID)}`
    : data.url || '#';
  const invoiceLabel = data.invoiceNumber ? ` ${data.invoiceNumber}` : '';
  const checkedCount = checkedClaimLineItems(bucket, payload).length;
  const html = `
    <div class="${resultClass}">
      <h3 class="invoice-result-title">Draft bill${escapeHtml(invoiceLabel)} created in Xero</h3>
      <p><strong>${escapeHtml(summary)}</strong></p>
      <div class="invoice-result-actions">
        <a class="btn-primary invoice-result-link" href="${escapeHtml(xeroUrl)}" target="_blank" rel="noopener">Open draft in Xero</a>
        <button type="button" class="btn-secondary" data-action="download-receipts-pdf">Download receipts PDF</button>
        <button type="button" class="btn-primary" data-action="mark-checked-claimed">Mark ${checkedCount || 'checked'} as claimed</button>
      </div>
      ${attachments.length ? `<ul class="attach-list">${attachments.map((a) => `<li>${escapeHtml(a.name)} - ${escapeHtml(a.status)}</li>`).join('')}</ul>` : '<p class="attach-list">No attachments were uploaded.</p>'}
      ${warnings.length ? `<ul class="attach-list">${warnings.map((w) => `<li>Warning: ${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
    </div>`;
  const container = sectionStatusEl(bucket);
  if (!container) return;
  container.innerHTML = html;
  if (persist) saveLastPushResult(data, warnings, payload);
  bindPushResultActions(bucket, data, payload);
  if (scroll) container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function restoreLastPushResult() {
  const saved = loadLastPushResult();
  if (!saved?.data || !saved?.payload) return;
  showSectionPushResult(saved.payload.bucket, saved.data, saved.warnings || [], saved.payload, {
    persist: false,
    scroll: false,
  });
}

async function downloadBucketReceiptsPdf(bucket, btn) {
  commitActiveInvoiceEdit();
  const lines = pushableBucketLines(bucket);
  if (lines.length === 0) {
    showStatus('error', `No ${BUCKET_LABEL[bucket]} lines with an amount above S$0.00 to download.`);
    return;
  }
  lines.forEach(normaliseLineForSection);
  const payload = pushPayloadForLines(bucket, `${BUCKET_LABEL[bucket]} receipts`, lines);
  await downloadReceiptsPdf(payload, btn);
}

function invoicePushSummary(bucket, lines) {
  const total = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const receiptCount = new Set(lines.map((line) => line.receiptKey)).size;
  const lineLabel = lines.length === 1 ? '1 line' : `${lines.length} lines`;
  const receiptLabel = receiptCount === 1 ? '1 receipt' : `${receiptCount} receipts`;
  return [
    `${lineLabel} · S$${total.toFixed(2)} → Soon Yin Jie (${BUCKET_LABEL[bucket]})`,
    `Attempts Xero attachment and prepares a downloadable ${receiptLabel} PDF in this list order; line descriptions include receipt page references.`,
    'TODO memos change in the selected backend only when you click Mark checked as claimed.',
  ].join('\n');
}

async function pushInvoice(bucket, btn) {
  if (claimsLoadErrorMessage) {
    showStatus('error', INVOICE_CLAIMS_UNAVAILABLE_TEXT);
    return;
  }

  commitActiveInvoiceEdit();

  const lines = pushableBucketLines(bucket);
  if (lines.length === 0) {
    showStatus('error', `No ${BUCKET_LABEL[bucket]} lines with an amount above S$0.00 to push.`);
    return;
  }
  const unreviewed = lines.filter((l) => !isLineReviewed(l));
  if (unreviewed.length > 0) {
    showStatus(
      'error',
      `Review all ${BUCKET_LABEL[bucket]} lines before pushing (${lines.length - unreviewed.length}/${lines.length} reviewed).`,
    );
    return;
  }
  if (!xeroConnected) {
    showStatus('error', 'Connect Xero first.');
    return;
  }
  const reference = window.prompt(
    `${invoicePushSummary(bucket, lines)}\n\nReference / note for this bill:`,
    defaultDraftReference(bucket, lines),
  );
  if (reference === null) return;

  btn.disabled = true;
  btn.textContent = 'Pushing…';
  showStatus('uploading', `Creating ${BUCKET_LABEL[bucket]} draft and attaching ${lines.length} receipt(s)...`);
  try {
    lines.forEach(normaliseLineForSection);
    const pagePlanSeed = pushPayloadForLines(bucket, reference, lines);
    btn.textContent = 'Reading pages…';
    const pagePlan = await buildReceiptPdfPlan(pagePlanSeed, {
      statusPrefix: 'Preparing receipt page references',
    });
    btn.textContent = 'Optimising PDF…';
    const compiledReceipts = await compileReceiptsPdfInBrowser(pagePlanSeed, pagePlan);
    const optimisedPdfName = safeReceiptBundleName(pagePlanSeed);
    btn.textContent = 'Pushing…';
    const payload = pushPayloadForLines(bucket, reference, lines, pagePlan.pageRefs);
    try {
      payload.receiptPdf = await receiptPdfUploadPayload(
        compiledReceipts.blob,
        optimisedPdfName,
        compiledReceipts.warnings,
      );
    } catch (pdfErr) {
      payload.receiptPdfWarning = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
    }
    const res = await fetch(`${API_BASE}/xero/invoices/push`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    const warnings = [
      ...(Array.isArray(data.warnings) ? data.warnings : []),
      ...(payload.receiptPdfWarning ? [`Optimised receipt PDF was not sent to Xero: ${payload.receiptPdfWarning}`] : []),
    ];
    const attachedCount = attachments.filter((a) => a.status === 'attached').length;
    if (data.allAttached === false) {
      showStatus('error', `Draft bill ${data.invoiceNumber || ''} created, but not all receipts were attached — items kept in the tab for retry (see notes).`);
    } else {
      showStatus('success', `Created draft bill ${data.invoiceNumber || ''} (${attachedCount} receipts attached).`);
    }
    showSectionPushResult(bucket, data, warnings, payload);

    try {
      await refreshInvoicesView({ showLoading: false, reloadClaims: false });
      showSectionPushResult(bucket, data, warnings, payload);
    } catch (refreshErr) {
      showStatus(
        'error',
        `Draft created, but refreshing the list failed — reload before pushing again: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`,
      );
    }
  } catch (err) {
    showStatus('error', `Push failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Push to Xero (draft)';
  }
}

// Renders into every [data-xero-status] element: the Invoices bar and the
// Xero section of the Settings dialog share the same status and controls.
function renderXeroStatus(html) {
  xeroStatusEls.forEach((el) => {
    el.innerHTML = html;
    el.querySelector('.xero-disconnect-btn')?.addEventListener('click', disconnectXero);
    el.querySelector('.xero-connect-btn')?.addEventListener('click', connectXero);
  });
}

export async function loadXeroStatus() {
  try {
    const res = await fetch(`${API_BASE}/xero/status`, { headers: authHeaders() });
    const data = await res.json();
    xeroConnected = Boolean(data.connected);
    if (xeroConnected) {
      renderXeroStatus(`Connected to <strong>${escapeHtml(data.tenantName || 'Xero')}</strong><button type="button" class="link-button xero-disconnect-btn">disconnect</button>`);
      loadXeroMeta();
    } else {
      renderXeroStatus('Not connected to Xero. <button type="button" class="btn-primary btn-connect xero-connect-btn">Connect Xero</button>');
    }
  } catch (err) {
    xeroStatusEls.forEach((el) => {
      el.textContent = 'Could not check Xero status.';
    });
  }
}

async function loadXeroMeta() {
  try {
    const res = await fetch(`${API_BASE}/xero/meta`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.accounts) && data.accounts.length) {
      xeroAccounts = data.accounts.map((a) => ({ code: a.code, name: a.name }));
    }
    if (Array.isArray(data.taxRates) && data.taxRates.length) {
      xeroTaxTypes = data.taxRates.map((t) => ({ taxType: t.taxType, name: t.name || t.taxType }));
    }
    if (invoicesActive) renderInvoiceEditor();
  } catch (_err) {
    /* keep fallback accounts */
  }
}

async function connectXero() {
  try {
    const res = await fetch(`${API_BASE}/xero/connect`, { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.authorizeUrl) throw new Error(data.error || `HTTP ${res.status}`);
    window.location.href = data.authorizeUrl;
  } catch (err) {
    showStatus('error', `Could not start Xero connect: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function disconnectXero() {
  await fetch(`${API_BASE}/xero/disconnect`, { method: 'POST', headers: authHeaders() });
  await loadXeroStatus();
}

export function isInvoicesPath(pathname = location.pathname) {
  return pathname === INVOICES_PATH || pathname === INVOICES_PATH + '/';
}

function updateModeNav(activeInvoices) {
  if (navClaims) {
    navClaims.classList.toggle('active', !activeInvoices);
    if (!activeInvoices) navClaims.setAttribute('aria-current', 'page');
    else navClaims.removeAttribute('aria-current');
  }
  if (navInvoices) {
    navInvoices.classList.toggle('active', activeInvoices);
    if (activeInvoices) navInvoices.setAttribute('aria-current', 'page');
    else navInvoices.removeAttribute('aria-current');
  }
}

function updateAppTitle(invoices) {
  document.title = invoices ? 'Invoices · Claimer' : 'Claims · Claimer';
}

export function navigateToMode(invoices, { replace = false, refresh = true } = {}) {
  const targetPath = invoices ? INVOICES_PATH : '/';
  const state = { mode: invoices ? 'invoices' : 'claims' };
  if (replace) {
    history.replaceState(state, '', targetPath);
  } else if (location.pathname !== targetPath) {
    history.pushState(state, '', targetPath);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  showInvoicesView(invoices, { refresh });
}

export function showInvoicesView(show, { refresh = true } = {}) {
  if (show) {
    clearSelection();
  }
  invoicesActive = show;
  document.body.classList.toggle('invoices-active', show);
  if (claimsView) claimsView.hidden = show;
  invoicesView.hidden = !show;
  updateModeNav(show);
  updateAppTitle(show);
  if (show) {
    closeActiveInvoiceEdit({ commit: true });
    loadXeroStatus();
    if (refresh && getAuthToken()) {
      refreshInvoicesView({ showLoading: true });
    } else if (!refresh && invoiceLines.length === 0) {
      // The initial route reuses the shared page load rather than fetching a
      // second time. Still show progress until that data is rendered.
      setInvoicesLoading(true);
    }
  } else {
    closeActiveInvoiceEdit({ commit: true });
  }
}

export function initInvoices() {
  window.addEventListener('claims-backend-change', (event) => {
    closeActiveInvoiceEdit({ commit: false });
    invoiceLines = [];
    if (event.detail?.loaded) buildInvoiceLines();
    if (invoicesActive) renderInvoiceEditor();
  });

  document.querySelectorAll('.app-nav-link').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      navigateToMode(link.dataset.mode === 'invoices');
    });
  });

  window.addEventListener('popstate', () => {
    showInvoicesView(isInvoicesPath());
  });
  invoicesRefreshBtn.addEventListener('click', async () => {
    await refreshInvoicesView({ showLoading: true });
    loadXeroStatus();
  });

  detectGstBtn.addEventListener('click', async () => {
    detectGstBtn.disabled = true;
    let tagged = 0;
    let failed = 0;
    try {
      for (let round = 0; round < 30; round++) {
        detectGstBtn.textContent = `Detecting… (${tagged})`;
        const response = await fetch(`${API_BASE}/gst-tags/pending?limit=8`, {
          method: 'POST',
          headers: authHeaders(),
        });
        if (response.status === 401) {
          showPasswordPrompt();
          return;
        }
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `GST tagging failed (${response.status})`);
        }
        const result = await response.json();
        tagged += result.tagged;
        failed += result.failed;
        if (result.remaining <= 0 || result.processed === 0 || result.tagged === 0) break;
      }
      detectGstBtn.textContent = failed ? `Done: ${tagged} tagged, ${failed} failed` : `Done: ${tagged} tagged`;
      await refreshInvoicesView({ showLoading: false, reloadClaims: false });
    } catch (error) {
      detectGstBtn.textContent = 'Detect GST failed';
      console.error('GST detection failed', error);
    } finally {
      detectGstBtn.disabled = false;
      setTimeout(() => { detectGstBtn.textContent = 'Detect GST'; }, 4000);
    }
  });
}
