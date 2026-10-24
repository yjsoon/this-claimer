import {
  API_BASE,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  AMOUNT_TAG_COOLDOWN_MS,
  RECEIPT_DATE_RE,
  CLAIM_FILTER_KEY,
  DEFAULT_CLAIM_FILTERS,
  REJECTED_MATCHES_KEY,
  MATCH_REVIEW_COLLAPSED_KEY,
} from './lib/constants.js';
import {
  authHeaders,
  showPasswordPrompt,
  clearAuthToken,
  showStatus,
  escapeHtml,
  formatDateForLocale,
  formatCurrencyAmount,
} from './lib/core.js';
import {
  receiptsData,
  claimsData,
  claimsDataBackend,
  claimsLoadErrorMessage,
  setReceiptsData,
  setClaimsData,
  setClaimsLoadErrorMessage,
} from './lib/state.js';
import {
  parseDateOnly,
  getReceiptMatchDate,
  getLinkedClaimIds,
  getReadyClaimId,
  isReadyOnlyClaimId,
  getReceiptDisplayName,
  getLinkedClaimJumpLabel,
  formatLinkedPairReceiptAmount,
  formatReceiptDateLabel,
  getComparableReceiptAmounts,
  scoreReceiptClaimMatch,
  buildMatchSuggestions,
  describeMatchReason,
  makeSuggestionPairId,
} from './lib/match.js';
import { openPreview } from './lib/preview.js?v=20260914-preview-review';
import { getAiStatus, isClaudeConfigured, loadAiSettings } from './ai.js?v=20261015-ai';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const receiptList = document.getElementById('receiptList');
const countSpan = document.getElementById('count');
const refreshBtn = document.getElementById('refreshBtn');
const findMatchesBtn = document.getElementById('findMatchesBtn');
const matchReviewSection = document.getElementById('matchReviewSection');
const matchReviewList = document.getElementById('matchReviewList');
const matchReviewCount = document.getElementById('matchReviewCount');
const matchReviewToggle = document.getElementById('matchReviewToggle');
const matchReviewBody = document.getElementById('matchReviewBody');
const acceptAllClearBtn = document.getElementById('acceptAllClearBtn');
const clearDismissedMatchesBtn = document.getElementById('clearDismissedMatchesBtn');
const todoList = document.getElementById('todoList');
const todoCount = document.getElementById('todoCount');
const claimsBackendSelect = document.getElementById('claimsBackend');
const claimFilterInput = document.getElementById('claimFilterInput');
const claimFilterPills = document.getElementById('claimFilterPills');
const claimFilterClear = document.getElementById('claimFilterClear');

// Linking elements
const linkingDock = document.getElementById('linkingDock');
const linkingContextText = document.getElementById('linkingContextText');
const linkingContextPreview = document.getElementById('linkingContextPreview');
const actionBar = document.getElementById('actionBar');
const actionText = document.getElementById('actionText');
const confirmSelection = document.getElementById('confirmSelection');
const markReadySelection = document.getElementById('markReadySelection');
const cancelSelection = document.getElementById('cancelSelection');
const tabBtns = document.querySelectorAll('.tab-btn');
const receiptsColumn = document.getElementById('receiptsColumn');
const claimsColumn = document.getElementById('claimsColumn');
const receiptBadge = document.getElementById('receiptBadge');
const claimBadge = document.getElementById('claimBadge');
const linkedList = document.getElementById('linkedList');
const linkedCount = document.getElementById('linkedCount');
const invoicesNavBadge = document.getElementById('invoicesNavBadge');

// Linking state
let sourceReceiptKey = null;
let sourceClaimId = null;
let selectedReceiptKeys = new Set();
let selectedClaimIds = new Set();
let linkingSource = null; // 'receipt' | 'claim'
let amountTaggingInFlight = false;
let lastAmountTagAttempt = 0;
let claimsRequestId = 0;
// Starts true: claims always load after receipts, so the upload zone must not
// judge "nothing outstanding" against an empty claims list before that.
let claimsLoadInFlight = true;
let matchReviewCollapsed = loadMatchReviewCollapsed();
const CLAIMS_BACKEND_KEY = 'claim_manager_backend';

export function getClaimsBackend() {
  return claimsBackendSelect?.value === 'ynab' ? 'ynab' : 'howmuch';
}

if (claimsBackendSelect) {
  claimsBackendSelect.value = localStorage.getItem(CLAIMS_BACKEND_KEY) === 'ynab' ? 'ynab' : 'howmuch';
  claimsBackendSelect.addEventListener('change', async () => {
    const backend = getClaimsBackend();
    localStorage.setItem(CLAIMS_BACKEND_KEY, backend);
    claimsLoadInFlight = true;
    setClaimsLoadErrorMessage('');
    setClaimsData([]);
    clearSelection();
    matchSuggestions = [];
    claudeMatches = [];
    renderMatchReview();
    renderOutstandingClaims();
    renderLinkedPairs();
    updateUploadZoneCompact();
    window.dispatchEvent(new CustomEvent('claims-backend-change', { detail: { backend, loaded: false } }));
    await loadYnabTodos();
    if (backend === getClaimsBackend() && claimsDataBackend === backend) {
      window.dispatchEvent(new CustomEvent('claims-backend-change', { detail: { backend, loaded: true } }));
    }
  });
}
let matchSuggestions = [];
// Pairs Claude suggested ({ claimId, receiptKey, confidence, reason }); kept
// across rebuilds until linked, dismissed, or the backend changes.
let claudeMatches = [];
let claudeMatchInFlight = false;
let matchSuggestionRefreshTimer = null;
let matchAcceptInFlight = false;
let rejectedMatchPairs = loadRejectedMatchPairs();
let receiptsLoadSucceeded = false;

let claimFilterState = {
  text: '',
  quickFilters: [],
};

function loadRejectedMatchPairs() {
  try {
    const stored = JSON.parse(localStorage.getItem(REJECTED_MATCHES_KEY) || '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === 'string' && id.includes('::')) : []);
  } catch {
    return new Set();
  }
}

function saveRejectedMatchPairs() {
  try {
    localStorage.setItem(REJECTED_MATCHES_KEY, JSON.stringify(Array.from(rejectedMatchPairs)));
  } catch (error) {
    console.warn('Rejected match preferences could not be saved:', error);
  }
}

function loadMatchReviewCollapsed() {
  try {
    return localStorage.getItem(MATCH_REVIEW_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function setMatchReviewCollapsed(collapsed) {
  matchReviewCollapsed = Boolean(collapsed);
  try {
    localStorage.setItem(MATCH_REVIEW_COLLAPSED_KEY, String(matchReviewCollapsed));
  } catch (error) {
    console.warn('Match review preference could not be saved:', error);
  }
  applyMatchReviewCollapsed();
}

function applyMatchReviewCollapsed() {
  if (!matchReviewSection || !matchReviewBody || !matchReviewToggle) return;
  matchReviewSection.classList.toggle('is-collapsed', matchReviewCollapsed);
  matchReviewBody.hidden = matchReviewCollapsed;
  matchReviewToggle.setAttribute('aria-expanded', matchReviewCollapsed ? 'false' : 'true');
}


// Validate file before upload
function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return `${file.name}: exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`;
  }

  const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  const mimeType = (file.type || '').toLowerCase().split(';')[0].trim();
  if (ext && !ALLOWED_EXTENSIONS.includes(ext)) {
    return `${file.name}: invalid type (${ext})`;
  }

  if (!ext && !ALLOWED_MIME_TYPES.includes(mimeType)) {
    return `${file.name}: invalid type (${ext || mimeType || 'unknown type'})`;
  }

  return null; // Valid
}

// Upload a single file
async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE}/upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Upload failed');
  }

  return response.json();
}

// Truncate error list for display
function formatErrors(errors, max = 3) {
  if (errors.length <= max) return errors.join(', ');
  return errors.slice(0, max).join(', ') + ` ... and ${errors.length - max} more`;
}

// Upload files in parallel with pre-validation
async function uploadFiles(files) {
  if (files.length === 0) return;

  // Single-pass validation
  const validated = Array.from(files).map((file) => ({
    file,
    error: validateFile(file),
  }));

  const validFiles = validated.filter((v) => !v.error).map((v) => v.file);
  const validationErrors = validated.filter((v) => v.error).map((v) => v.error);

  if (validFiles.length === 0) {
    showStatus('error', formatErrors(validationErrors));
    return;
  }

  const skippedCount = validationErrors.length;
  showStatus('uploading', `Uploading ${validFiles.length} file(s)...`);

  const results = await Promise.allSettled(validFiles.map(uploadFile));

  const successCount = results.filter((r) => r.status === 'fulfilled').length;
  const failures = results.filter((r) => r.status === 'rejected');

  if (failures.length === 0 && skippedCount === 0) {
    showStatus('success', `Uploaded ${successCount} receipt(s)`);
  } else if (failures.length === 0) {
    showStatus('success', `Uploaded ${successCount}, skipped ${skippedCount} invalid`);
  } else {
    const errorMsgs = failures.map((r) => r.reason.message);
    showStatus('error', `${successCount} uploaded, ${failures.length} failed: ${formatErrors(errorMsgs)}`);
  }

  // Refresh list after upload
  loadReceipts();
}

async function fetchAllReceipts() {
  const receipts = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({ limit: '1000' });
    if (cursor) params.set('cursor', cursor);

    const response = await fetch(`${API_BASE}/list?${params.toString()}`, {
      headers: authHeaders(),
    });

    if (response.status === 401) {
      showPasswordPrompt();
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to load receipts (${response.status})`);
    }

    const data = await response.json();
    receipts.push(...(Array.isArray(data.receipts) ? data.receipts : []));
    cursor = data.hasMore ? data.cursor : null;
  } while (cursor);

  return receipts;
}

// Load receipt list
export async function loadReceipts() {
  receiptsLoadSucceeded = false;
  // First load: show that something is happening rather than an empty column.
  if (receiptsData.length === 0 && !receiptList.querySelector('li')) {
    receiptList.innerHTML = '<li class="loading-state"><span class="spinner"></span> Loading...</li>';
  }
  try {
    const receipts = await fetchAllReceipts();
    if (!receipts) {
      scheduleMatchSuggestionRefresh();
      return;
    }

    // Sort: unlinked first, then linked.
    // Unlinked receipts use effective receipt date (manual/AI/upload fallback) descending.
    setReceiptsData(receipts.sort((a, b) => {
      const aLinked = getLinkedClaimIds(a).length > 0;
      const bLinked = getLinkedClaimIds(b).length > 0;
      if (aLinked !== bLinked) return aLinked ? 1 : -1;

      if (!aLinked && !bLinked) {
        const aDate = getReceiptMatchDate(a).date;
        const bDate = getReceiptMatchDate(b).date;
        const aTime = aDate ? aDate.getTime() : 0;
        const bTime = bDate ? bDate.getTime() : 0;
        if (aTime !== bTime) return bTime - aTime;
      }

      return new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime();
    }));
    receiptsLoadSucceeded = true;

    const outstandingReceipts = receiptsData.filter((receipt) => getLinkedClaimIds(receipt).length === 0);
    countSpan.textContent = `(${outstandingReceipts.length})`;
    receiptBadge.textContent = outstandingReceipts.length || '';

    if (outstandingReceipts.length === 0) {
      receiptList.innerHTML = '<li class="empty-state">No outstanding receipts</li>';
      if (!claimsLoadInFlight && !claimsLoadErrorMessage) renderOutstandingClaims();
      applyLinkingHighlights();
      renderLinkedPairs();
      updateUploadZoneCompact();
      triggerPendingAmountTagging();
      scheduleMatchSuggestionRefresh();
      return;
    }

    receiptList.innerHTML = outstandingReceipts
      .map(r => {
        const dateDisplay = formatReceiptDateLabel(r);
        const name = getReceiptDisplayName(r);
        const parsedTaggedAmount = Number(r.taggedAmount);
        const taggedAmount = Number.isFinite(parsedTaggedAmount) ? parsedTaggedAmount : null;
        const currencyLabel = (r.taggedCurrency || '').toUpperCase();
        const parsedFxApprox = Number(r.taggedAmountSgdApprox);
        const taggedSgdApprox = Number.isFinite(parsedFxApprox) ? parsedFxApprox : null;
        const parsedFxApproxPlus = Number(r.taggedAmountSgdApproxPlus325);
        const taggedSgdApproxPlus325 = Number.isFinite(parsedFxApproxPlus) ? parsedFxApproxPlus : null;
        const vendor = (r.taggedVendor || '').trim();
        const purpose = (r.taggedPurpose || '').trim();
        const titleLabel = vendor && purpose ? `${vendor} - ${purpose}` : (vendor || purpose);
        const sgdLabel = taggedSgdApprox !== null
          ? `S$${taggedSgdApprox.toFixed(2)}${taggedSgdApproxPlus325 !== null ? ` (S$${taggedSgdApproxPlus325.toFixed(2)})` : ''}`
          : '';

        const primaryAmountBadge = taggedAmount !== null
          ? r.taggedCurrency === 'USD'
            ? sgdLabel
              ? `<span class="receipt-sgd-tag">${sgdLabel}</span>`
              : '<span class="receipt-ai-tag pending">SGD pending</span>'
            : `<span class="receipt-sgd-tag">${escapeHtml(formatCurrencyAmount(currencyLabel, taggedAmount))}</span>`
          : r.taggedStatus === 'missing'
            ? '<span class="receipt-ai-tag missing">No total</span>'
            : r.taggedStatus === 'error'
              ? `<span class="receipt-ai-tag error" title="${escapeHtml(r.taggedError || 'Tagging failed')}">Failed</span>`
              : '<span class="receipt-ai-tag pending">Pending</span>';

        const usdUnderName = r.taggedCurrency === 'USD' && taggedAmount !== null
          ? `<span class="receipt-usd-tag">${escapeHtml(formatCurrencyAmount('USD', taggedAmount))}</span>`
          : '';
        // Lead with what the receipt is for; the filename stays visible beneath
        // so a specific PDF can still be found.
        const primaryTitle = titleLabel || name;
        const titleUnderName = titleLabel
          ? `<span class="receipt-title-tag">${escapeHtml(name)}</span>`
          : '';
        // Gmail imports link back to their email; the chip sits beside the
        // filename so these rows stay the same height as manual uploads.
        const gmailLink = r.source === 'gmail' && r.gmailAccount && r.gmailMessageId
          ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(r.gmailAccount)}#all/${encodeURIComponent(r.gmailMessageId)}`
          : '';
        const gmailTag = r.source !== 'gmail'
          ? ''
          : gmailLink
            ? `<a class="receipt-source-tag" target="_blank" rel="noopener" href="${gmailLink}" title="${escapeHtml(`${r.gmailAccount}${r.gmailSubject ? `: ${r.gmailSubject}` : ''}`)}" aria-label="Open the original email in Gmail (${escapeHtml(r.gmailAccount)}), opens in a new tab">Gmail<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg></a>`
            : '<span class="receipt-source-tag">Gmail</span>';
        const subLine = titleUnderName || gmailTag
          ? `<span class="receipt-sub">${titleUnderName}${gmailTag}</span>`
          : '';
        const linkBtnIcon = `<svg class="icon-link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
            <svg class="icon-preview" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>`;
        const deleteBtnIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <line x1="10" y1="11" x2="10" y2="17"/>
              <line x1="14" y1="11" x2="14" y2="17"/>
            </svg>`;
        return `
          <li data-key="${escapeHtml(r.key)}" data-name="${escapeHtml(name)}"
              data-linked="">
            <span class="select-indicator receipt-selector" aria-hidden="true">
              <span class="checkmark">✓</span>
            </span>
            <div class="receipt-info">
              <span class="receipt-name">${escapeHtml(primaryTitle)}</span>
              ${subLine}
              ${usdUnderName}
            </div>
            <div class="receipt-actions">
              <div class="receipt-meta">
                <span class="receipt-date ${dateDisplay.className}" title="${escapeHtml(dateDisplay.title)}">${dateDisplay.text}</span>
                ${primaryAmountBadge}
              </div>
              <button class="link-btn" title="Link to claim" aria-label="Link to claim">
                ${linkBtnIcon}
              </button>
              <button class="delete-btn" title="Delete receipt">
                ${deleteBtnIcon}
              </button>
            </div>
          </li>
        `;
      })
      .join('');

    // Attach click handlers
    receiptList.querySelectorAll('li[data-key]').forEach(li => {
      li.addEventListener('click', (e) => handleReceiptClick(e, li));
      li.querySelector('.receipt-date').addEventListener('click', (e) => handleDateOverrideClick(e, li));
      li.querySelector('.link-btn').addEventListener('click', (e) => handleLinkBtnClick(e, li));
      li.querySelector('.delete-btn').addEventListener('click', (e) => handleDeleteBtnClick(e, li));
      li.querySelector('.receipt-source-tag')?.addEventListener('click', (e) => e.stopPropagation());
    });

    // Which claims are outstanding depends on receipt links, so re-render that
    // list whenever receipts change and claims are already loaded (covers a
    // parallel load where receipts finish last, and receipt-only refreshes).
    if (!claimsLoadInFlight && !claimsLoadErrorMessage) renderOutstandingClaims();
    applyLinkingHighlights();
    renderLinkedPairs();
    updateUploadZoneCompact();
    triggerPendingAmountTagging();
    scheduleMatchSuggestionRefresh();
  } catch (err) {
    console.error('Failed to load receipts:', err);
    receiptList.innerHTML = '<li class="empty-state">Failed to load receipts</li>';
    scheduleMatchSuggestionRefresh();
  }
}

async function triggerPendingAmountTagging() {
  if (amountTaggingInFlight) return;
  if (Date.now() - lastAmountTagAttempt < AMOUNT_TAG_COOLDOWN_MS) return;

  const needsTagging = receiptsData.some((receipt) => getLinkedClaimIds(receipt).length === 0 && !receipt.taggedStatus);
  if (!needsTagging) return;

  amountTaggingInFlight = true;
  lastAmountTagAttempt = Date.now();

  try {
    const response = await fetch(`${API_BASE}/amount-tags/pending?limit=3`, {
      method: 'POST',
      headers: authHeaders(),
    });

    if (!response.ok || response.status === 401) {
      return;
    }

    const result = await response.json().catch(() => null);
    if (result && result.tagged > 0) {
      await loadReceipts();
    }
  } catch (error) {
    console.warn('Amount tagging trigger failed:', error);
  } finally {
    amountTaggingInFlight = false;
  }
}


function normaliseFilterTerm(term) {
  return String(term || '').trim().toLowerCase();
}

function loadClaimFilterState() {
  try {
    const stored = JSON.parse(localStorage.getItem(CLAIM_FILTER_KEY) || '{}');
    return {
      text: typeof stored.text === 'string' ? stored.text : '',
      quickFilters: Array.isArray(stored.quickFilters)
        ? stored.quickFilters.filter((term) => typeof term === 'string' && term.trim())
        : [],
    };
  } catch {
    return { text: '', quickFilters: [] };
  }
}

function saveClaimFilterState() {
  try {
    localStorage.setItem(CLAIM_FILTER_KEY, JSON.stringify(claimFilterState));
  } catch (error) {
    console.warn('Claim filter preferences could not be saved:', error);
  }
}

function getManualClaimFilterTerms() {
  return claimFilterState.text
    .split(/[,;\n]+/)
    .map(normaliseFilterTerm)
    .filter(Boolean);
}

function getClaimFilterTerms() {
  const quickTerms = claimFilterState.quickFilters.map(normaliseFilterTerm).filter(Boolean);
  return Array.from(new Set([...getManualClaimFilterTerms(), ...quickTerms]));
}

function getClaimSearchText(claim) {
  return [
    claim.description,
    claim.payee,
    claim.accountName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function claimMatchesHideFilter(claim, terms) {
  if (terms.length === 0) return false;
  const text = getClaimSearchText(claim);
  return terms.some((term) => {
    if (term === 'transfer') {
      return /^\s*transfer\s*:/i.test(claim.payee || '');
    }
    return text.includes(term);
  });
}

function renderClaimFilterControls() {
  if (!claimFilterInput || !claimFilterPills || !claimFilterClear) return;

  if (document.activeElement !== claimFilterInput && claimFilterInput.value !== claimFilterState.text) {
    claimFilterInput.value = claimFilterState.text;
  }
  const activeQuickFilters = new Set(claimFilterState.quickFilters.map(normaliseFilterTerm));
  claimFilterPills.innerHTML = DEFAULT_CLAIM_FILTERS.map((term) => {
    const isActive = activeQuickFilters.has(normaliseFilterTerm(term));
    return `
      <button
        class="claim-filter-pill${isActive ? ' active' : ''}"
        type="button"
        data-filter="${escapeHtml(term)}"
        aria-pressed="${isActive ? 'true' : 'false'}"
      >${escapeHtml(term)}</button>
    `;
  }).join('');

  const hasFilters = claimFilterState.text.trim() || claimFilterState.quickFilters.length > 0;
  claimFilterClear.hidden = !hasFilters;
}

function pruneClaimSelectionToVisibleClaims(visibleClaims) {
  const visibleClaimIds = new Set(visibleClaims.map((claim) => claim.id));

  if (linkingSource === 'receipt') {
    selectedClaimIds = new Set(
      Array.from(selectedClaimIds).filter((claimId) => visibleClaimIds.has(claimId))
    );
  }

  if (linkingSource === 'claim' && sourceClaimId && !visibleClaimIds.has(sourceClaimId)) {
    linkingSource = null;
    sourceClaimId = null;
    selectedClaimIds.clear();
    selectedReceiptKeys.clear();
  }
}

function renderClaimLoadError(message) {
  todoList.innerHTML = `<li class="empty-state">${escapeHtml(message)}</li>`;
  todoCount.textContent = '(error)';
  claimBadge.textContent = '';
}

let onClaimsLoadError = () => {};
export function setOnClaimsLoadError(fn) { onClaimsLoadError = fn; }

function resetClaimsAfterLoadFailure(message) {
  setClaimsLoadErrorMessage(message || 'Failed to load claims');
  setClaimsData([]);
  clearSelection();
  matchSuggestions = [];
  renderMatchReview();
  renderClaimLoadError(claimsLoadErrorMessage);
  linkedCount.textContent = '(error)';
  linkedList.innerHTML = '<li class="empty-state">Claims unavailable</li>';
  onClaimsLoadError();
}

function countReadyToClaimPairs() {
  if (claimsLoadErrorMessage) return 0;
  let count = 0;
  receiptsData.forEach((receipt) => {
    count += getActiveReadyClaimIds(receipt).length;
  });
  return count;
}

function updateInvoicesNavBadge() {
  if (!invoicesNavBadge) return;
  const count = countReadyToClaimPairs();
  if (count > 0) {
    invoicesNavBadge.textContent = String(count);
    invoicesNavBadge.hidden = false;
  } else {
    invoicesNavBadge.hidden = true;
  }
}

function renderLinkedPairs() {
  if (claimsLoadErrorMessage) {
    linkedCount.textContent = '(error)';
    linkedList.innerHTML = '<li class="empty-state">Claims unavailable</li>';
    updateInvoicesNavBadge();
    return;
  }

  const claimsById = new Map(claimsData.map((claim) => [claim.id, claim]));
  const linkedPairs = [];

  receiptsData.forEach((receipt) => {
    getActiveReadyClaimIds(receipt).forEach((claimId, index) => {
      if (!isReadyOnlyClaimId(claimId) && receiptClaimsBackend(receipt) !== claimsDataBackend) return;
      linkedPairs.push({
        receipt,
        claimId,
        index,
        claim: claimsById.get(claimId) || null,
      });
    });
  });

  linkedPairs.sort((a, b) => {
    const aClaimDate = parseDateOnly(a.claim?.date);
    const bClaimDate = parseDateOnly(b.claim?.date);
    const aReceiptDate = getReceiptMatchDate(a.receipt).date;
    const bReceiptDate = getReceiptMatchDate(b.receipt).date;
    const aDate = aClaimDate || aReceiptDate || new Date(0);
    const bDate = bClaimDate || bReceiptDate || new Date(0);
    return bDate.getTime() - aDate.getTime();
  });

  linkedCount.textContent = `(${linkedPairs.length})`;
  updateInvoicesNavBadge();

  if (linkedPairs.length === 0) {
    linkedList.innerHTML = '<li class="empty-state">No linked claim-receipt pairs yet</li>';
    return;
  }

  linkedList.innerHTML = linkedPairs
    .map((pair) => {
      const { receipt, claim, claimId, index } = pair;
      const isReadyOnly = isReadyOnlyClaimId(claimId);
      const claimTitle = claim
        ? (claim.description || claim.payee || getLinkedClaimJumpLabel(receipt, claimId, index))
        : getLinkedClaimJumpLabel(receipt, claimId, index);
      const claimSub = claim
        ? (claim.payee || (claim.accountName || 'Unknown account'))
        : isReadyOnly
          ? 'No claim linked'
          : 'Claim details unavailable';
      const claimDate = claim
        ? formatDateForLocale(parseDateOnly(claim.date) || new Date(claim.date))
        : isReadyOnly
          ? formatReceiptDateLabel(receipt).text.replace(/^(Manual|AI) /, '')
          : 'Unknown date';
      const claimAmount = claim && Number.isFinite(Number(claim.amount))
        ? formatClaimAmount(Number(claim.amount))
        : isReadyOnly
          ? getReceiptAmountLabel(receipt) || 'Amount pending'
          : 'Unknown amount';

      const receiptName = getReceiptDisplayName(receipt);
      const receiptTitle = [receipt.taggedVendor, receipt.taggedPurpose]
        .filter((part) => typeof part === 'string' && part.trim())
        .map((part) => part.trim())
        .join(' - ');
      const receiptDateInfo = formatReceiptDateLabel(receipt);
      const receiptAmount = formatLinkedPairReceiptAmount(receipt);

      return `
        <li class="linked-pair-item" data-receipt-key="${escapeHtml(receipt.key)}" data-claim-id="${escapeHtml(claimId)}">
          <div class="linked-pair-side linked-pair-claim">
            <span class="linked-pair-title">${escapeHtml(claimTitle)}</span>
            <span class="linked-pair-sub">${escapeHtml(claimSub)}</span>
            <span class="linked-pair-meta">${escapeHtml(claimDate)} · ${claim?.needsConfirmation ? ESTIMATE_MARK_HTML : ''}${escapeHtml(claimAmount)}</span>
          </div>
          <div class="linked-pair-connector" aria-hidden="true">${isReadyOnly ? '✓' : '↔'}</div>
          <button type="button" class="linked-pair-side linked-pair-receipt"
              data-receipt-key="${escapeHtml(receipt.key)}"
              data-receipt-name="${escapeHtml(receiptName)}"
              title="Preview receipt">
            <span class="linked-pair-title">${escapeHtml(receiptTitle || receiptName)}</span>
            <span class="linked-pair-sub">${escapeHtml(receiptTitle ? receiptName : 'Receipt')}</span>
            <span class="linked-pair-meta">${escapeHtml(receiptDateInfo.text)} · ${escapeHtml(receiptAmount)}</span>
          </button>
          <button type="button" class="linked-pair-unlink"
              data-receipt-key="${escapeHtml(receipt.key)}"
              data-claim-id="${escapeHtml(claimId)}">Unlink</button>
        </li>
      `;
    })
    .join('');

  linkedList.querySelectorAll('.linked-pair-receipt').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const key = btn.dataset.receiptKey;
      const name = btn.dataset.receiptName;
      if (!key || !name) return;
      openPreview(key, name);
    });
  });

  linkedList.querySelectorAll('.linked-pair-unlink').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const receiptKey = btn.dataset.receiptKey;
      const claimId = btn.dataset.claimId;
      if (!receiptKey || !claimId) return;

      const receipt = receiptsData.find((item) => item.key === receiptKey);
      const backend = receipt ? receiptClaimsBackend(receipt) : getClaimsBackend();
      const linkedCountForReceipt = receipt ? getLinkedClaimIds(receipt).length : 1;
      const confirmation = linkedCountForReceipt > 1
        ? `This receipt is linked to ${linkedCountForReceipt} claims. Unlink only this pair?`
        : 'Unlink this claim-receipt pair?';

      if (!window.confirm(confirmation)) return;
      await unlinkClaimFromReceipt(receiptKey, claimId, backend);
    });
  });
}

function getActiveReadyClaimIds(receipt) {
  return receipt.xeroInvoiceId ? [] : getLinkedClaimIds(receipt);
}

// Linking, unlinking, deleting or re-dating a receipt only changes receipt
// metadata, so re-render the claim-side views from the claims already loaded
// instead of fetching them from the backend again.
function refreshClaimViews() {
  if (claimsLoadErrorMessage) return;
  renderOutstandingClaims();
  renderLinkedPairs();
  updateUploadZoneCompact();
  scheduleMatchSuggestionRefresh();
}


function clearMatchDecorations(root) {
  root.querySelectorAll('.match-badge').forEach((badge) => badge.remove());
  root.querySelectorAll('.match-best, .match-amount, .match-date, .match-date-near').forEach((item) => {
    item.classList.remove('match-best', 'match-amount', 'match-date', 'match-date-near');
  });
}

function appendMatchBadge(li, label, listType) {
  if (!label) return;
  const badge = document.createElement('span');
  badge.className = 'match-badge';
  badge.textContent = label;
  const container = listType === 'receipt'
    ? li.querySelector('.receipt-meta')
    : li.querySelector('.todo-meta');
  if (container) {
    container.appendChild(badge);
  }
}

function getReceiptAmountLabel(receipt) {
  const parsed = Number(receipt.taggedAmount);
  const currency = (receipt.taggedCurrency || 'SGD').toUpperCase();
  if (receipt.taggedCurrency === 'USD' && Number.isFinite(Number(receipt.taggedAmountSgdApprox))) {
    return `S$${Number(receipt.taggedAmountSgdApprox).toFixed(2)}`;
  }
  if (Number.isFinite(parsed)) {
    return formatCurrencyAmount(currency, parsed);
  }
  return '';
}

// HowMuch "To confirm": the claim amount is still an estimate.
const ESTIMATE_MARK_HTML = '<span class="estimate-mark" role="img" aria-label="Estimated amount, to confirm in HowMuch" title="Estimated amount, to confirm in HowMuch">≈</span>';

function formatClaimAmount(amount) {
  return formatCurrencyAmount('SGD', Number(amount));
}

function updateUploadZoneCompact() {
  if (!dropzone) return;
  // Stay compact until both lists have settled, so the zone doesn't flash
  // big → small while data is still loading.
  if (claimsLoadInFlight || !receiptsLoadSucceeded) return;
  const outstandingClaims = claimsLoadErrorMessage ? 0 : getOutstandingClaims().length;
  const outstandingReceipts = receiptsData.filter((receipt) => getLinkedClaimIds(receipt).length === 0).length;
  const readyPairs = countReadyToClaimPairs();
  const compact = outstandingClaims > 0 || outstandingReceipts > 0 || readyPairs > 0;
  dropzone.classList.toggle('is-compact', compact);
}

function scheduleMatchSuggestionRefresh() {
  if (matchSuggestionRefreshTimer) {
    clearTimeout(matchSuggestionRefreshTimer);
  }
  matchSuggestionRefreshTimer = setTimeout(() => {
    matchSuggestionRefreshTimer = null;
    refreshMatchSuggestions({ announce: false });
  }, 150);
}

function pruneRejectedMatchPairs() {
  const validClaimIds = new Set(claimsData.map((claim) => claim.id));
  const unlinkedReceiptKeys = new Set(
    receiptsData
      .filter((receipt) => getLinkedClaimIds(receipt).length === 0)
      .map((receipt) => receipt.key)
  );
  let changed = false;
  for (const pairId of Array.from(rejectedMatchPairs)) {
    const separator = pairId.indexOf('::');
    if (separator <= 0) {
      rejectedMatchPairs.delete(pairId);
      changed = true;
      continue;
    }
    const claimId = pairId.slice(0, separator);
    const receiptKey = pairId.slice(separator + 2);
    if (!validClaimIds.has(claimId) || !unlinkedReceiptKeys.has(receiptKey)) {
      rejectedMatchPairs.delete(pairId);
      changed = true;
    }
  }
  if (changed) saveRejectedMatchPairs();
}

function dropSuggestionsCollidingWith(claimId, receiptKey) {
  matchSuggestions = matchSuggestions.filter((item) => {
    if (item.claim.id === claimId) return false;
    if (item.receipt.key === receiptKey) return false;
    return !item.alternatives.some((alt) => alt.receipt.key === receiptKey);
  });
}

function refreshMatchSuggestions({ announce = false } = {}) {
  if (!matchReviewSection || !matchReviewList) return;

  if (!receiptsLoadSucceeded) {
    matchSuggestions = [];
    renderMatchReview();
    return;
  }

  if (claimsLoadErrorMessage || claimsData.length === 0) {
    matchSuggestions = [];
    renderMatchReview();
    if (announce) {
      showStatus('error', claimsLoadErrorMessage || 'No claims loaded yet');
    }
    return;
  }

  pruneRejectedMatchPairs();

  const filterTerms = getClaimFilterTerms();
  matchSuggestions = buildMatchSuggestions(claimsData, receiptsData, {
    nearDays: 0,
    allowUploadDate: false,
    rejectedPairs: rejectedMatchPairs,
  })
    .filter((suggestion) => !claimMatchesHideFilter(suggestion.claim, filterTerms));
  mergeClaudeSuggestions(filterTerms);
  renderMatchReview();

  if (!announce) return;

  const clearCount = matchSuggestions.filter((item) => item.kind === 'clear').length;
  const ambiguousCount = matchSuggestions.length - clearCount;
  if (matchSuggestions.length === 0) {
    showStatus('success', rejectedMatchPairs.size > 0
      ? 'No matches to review (some were dismissed)'
      : 'No matches found');
    return;
  }
  showStatus(
    'success',
    `Found ${matchSuggestions.length} suggestion${matchSuggestions.length === 1 ? '' : 's'}` +
      ` (${clearCount} clear, ${ambiguousCount} ambiguous)`
  );
}

// Claude's picks sit after the rule-based ones. A clear rule match always
// wins; for a claim the rules found ambiguous, Claude's pick replaces the guess.
function mergeClaudeSuggestions(filterTerms) {
  if (claudeMatches.length === 0) return;
  const outstanding = new Map(getOutstandingClaims().map((claim) => [claim.id, claim]));
  const unlinked = new Map(
    receiptsData.filter((receipt) => getLinkedClaimIds(receipt).length === 0).map((receipt) => [receipt.key, receipt])
  );
  const clear = matchSuggestions.filter((item) => item.kind === 'clear');
  const clearClaimIds = new Set(clear.map((item) => item.claim.id));
  const clearReceiptKeys = new Set(clear.map((item) => item.receipt.key));

  const additions = [];
  const pairedClaims = new Set();
  const pairedReceipts = new Set();
  claudeMatches = claudeMatches.filter((match) => {
    const claim = outstanding.get(match.claimId);
    const receipt = unlinked.get(match.receiptKey);
    if (!claim || !receipt) return false;
    const id = makeSuggestionPairId(claim.id, receipt.key);
    if (rejectedMatchPairs.has(id)) return false;
    if (pairedClaims.has(claim.id) || pairedReceipts.has(receipt.key)) return false;
    pairedClaims.add(claim.id);
    pairedReceipts.add(receipt.key);
    if (clearClaimIds.has(claim.id) || clearReceiptKeys.has(receipt.key)) return true;
    if (claimMatchesHideFilter(claim, filterTerms)) return true;
    additions.push({
      id,
      kind: 'claude',
      claim,
      receipt,
      reason: match.reason,
      confidence: match.confidence,
      alternatives: [],
    });
    return true;
  });
  if (additions.length === 0) return;

  const claudeClaimIds = new Set(additions.map((item) => item.claim.id));
  const claudeReceiptKeys = new Set(additions.map((item) => item.receipt.key));
  matchSuggestions = matchSuggestions
    .filter((item) => item.kind === 'clear' || (!claudeClaimIds.has(item.claim.id) && !claudeReceiptKeys.has(item.receipt.key)))
    .concat(additions);
}

function claudeMatchPayload() {
  const clear = matchSuggestions.filter((item) => item.kind === 'clear');
  const clearClaimIds = new Set(clear.map((item) => item.claim.id));
  const clearReceiptKeys = new Set(clear.map((item) => item.receipt.key));
  const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

  const claims = getOutstandingClaims()
    .filter((claim) => !clearClaimIds.has(claim.id) && !claimMatchesHideFilter(claim, getClaimFilterTerms()))
    .map((claim) => ({
      id: claim.id,
      date: claim.date,
      amount: Number(claim.amount),
      payee: claim.payee,
      description: claim.description,
    }))
    .filter((claim) => Number.isFinite(claim.amount))
    .sort(byDateDesc)
    .slice(0, 150);

  const receipts = receiptsData
    .filter((receipt) => getLinkedClaimIds(receipt).length === 0 && !clearReceiptKeys.has(receipt.key))
    .map((receipt) => {
      const { date } = getReceiptMatchDate(receipt);
      const amount = Number(receipt.taggedAmount);
      const sgd = Number(receipt.taggedAmountSgdApprox);
      return {
        key: receipt.key,
        filename: getReceiptDisplayName(receipt),
        uploaded: receipt.uploaded,
        receiptDate: receipt.receiptDate || receipt.detectedReceiptDate || undefined,
        amount: Number.isFinite(amount) ? amount : undefined,
        currency: receipt.taggedCurrency || undefined,
        amountSgdApprox: Number.isFinite(sgd) ? sgd : undefined,
        vendor: receipt.taggedVendor || undefined,
        purpose: receipt.taggedPurpose || undefined,
        date: date ? date.toISOString().slice(0, 10) : '',
      };
    })
    .sort(byDateDesc)
    .slice(0, 250)
    .map(({ date, ...receipt }) => receipt);

  return { claims, receipts };
}

function setFindMatchesBusy(busy, label = 'Asking Claude…') {
  if (!findMatchesBtn) return;
  findMatchesBtn.disabled = busy;
  findMatchesBtn.textContent = busy ? label : 'Find matches';
}

function ruleMatchSummary() {
  const clearCount = matchSuggestions.filter((item) => item.kind === 'clear').length;
  const ambiguousCount = matchSuggestions.filter((item) => item.kind === 'ambiguous').length;
  return clearCount || ambiguousCount ? `${clearCount} clear, ${ambiguousCount} ambiguous` : '';
}

// Find matches runs the exact rules; with a Claude key set it then asks
// Claude about whatever the rules left unpaired.
async function findMatches() {
  if (claudeMatchInFlight) return;
  // AI settings may still be loading (or have failed) right after sign-in;
  // check before deciding Claude isn't set up.
  if (!getAiStatus()) {
    claudeMatchInFlight = true;
    setFindMatchesBusy(true, 'Finding matches…');
    try {
      await loadAiSettings();
    } finally {
      claudeMatchInFlight = false;
      setFindMatchesBusy(false);
    }
    if (!getAiStatus()) {
      refreshMatchSuggestions({ announce: false });
      showStatus('error', "Couldn't check the AI settings, so only exact matches are shown. Try again.");
      return;
    }
  }
  if (!isClaudeConfigured()) {
    refreshMatchSuggestions({ announce: true });
    return;
  }
  if (!receiptsLoadSucceeded || claimsLoadErrorMessage || claimsData.length === 0) {
    refreshMatchSuggestions({ announce: true });
    return;
  }
  refreshMatchSuggestions({ announce: false });
  const payload = claudeMatchPayload();
  if (payload.claims.length === 0 || payload.receipts.length === 0) {
    refreshMatchSuggestions({ announce: true });
    return;
  }

  claudeMatchInFlight = true;
  setFindMatchesBusy(true);
  showStatus('uploading', `Asking Claude about ${payload.claims.length} unmatched claim${payload.claims.length === 1 ? '' : 's'}…`);
  try {
    const res = await fetch(`${API_BASE}/ai/match`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // Pairs the user already dismissed are dropped before they can displace anything.
    const matches = (Array.isArray(data.matches) ? data.matches : [])
      .filter((m) => !rejectedMatchPairs.has(makeSuggestionPairId(m.claimId, m.receiptKey)));
    // Older picks give way to this run's on either side, so each claim and
    // each receipt still appears in at most one Claude pair.
    const freshClaims = new Set(matches.map((m) => m.claimId));
    const freshReceipts = new Set(matches.map((m) => m.receiptKey));
    claudeMatches = claudeMatches
      .filter((m) => !freshClaims.has(m.claimId) && !freshReceipts.has(m.receiptKey))
      .concat(matches);
    setMatchReviewCollapsed(false);
    refreshMatchSuggestions({ announce: false });
    const fromClaude = matchSuggestions.filter((item) => item.kind === 'claude').length;
    const parts = [ruleMatchSummary(), fromClaude ? `${fromClaude} from Claude` : ''].filter(Boolean);
    showStatus('success', parts.length
      ? `Found ${matchSuggestions.length} suggestion${matchSuggestions.length === 1 ? '' : 's'} (${parts.join(', ')})`
      : 'No matches found');
  } catch (err) {
    refreshMatchSuggestions({ announce: false });
    const reason = err instanceof Error && !/^HTTP /.test(err.message) ? err.message : "Claude couldn't be reached.";
    showStatus('error', `${reason} Showing exact matches only.`);
  } finally {
    claudeMatchInFlight = false;
    setFindMatchesBusy(false);
  }
}

function renderMatchReview() {
  if (!matchReviewSection || !matchReviewList || !matchReviewCount) return;

  applyMatchReviewCollapsed();
  const clearCount = matchSuggestions.filter((item) => item.kind === 'clear').length;
  matchReviewCount.textContent = `(${matchSuggestions.length})`;
  if (acceptAllClearBtn) {
    acceptAllClearBtn.hidden = clearCount === 0;
    acceptAllClearBtn.textContent = clearCount > 0 ? `Accept all clear (${clearCount})` : 'Accept all clear';
    acceptAllClearBtn.disabled = matchAcceptInFlight || clearCount === 0;
  }
  if (clearDismissedMatchesBtn) {
    clearDismissedMatchesBtn.hidden = rejectedMatchPairs.size === 0;
  }

  const showSection = matchSuggestions.length > 0 || rejectedMatchPairs.size > 0;
  matchReviewSection.hidden = !showSection;

  if (matchSuggestions.length === 0) {
    matchReviewList.innerHTML = rejectedMatchPairs.size > 0
      ? '<li class="empty-state">No suggestions right now. Clear dismissed to restore skipped matches.</li>'
      : '';
    return;
  }
  matchReviewList.innerHTML = matchSuggestions.map((suggestion) => {
    const claimDate = formatDateForLocale(parseDateOnly(suggestion.claim.date) || new Date(suggestion.claim.date));
    const claimLabel = (suggestion.claim.description || suggestion.claim.payee || 'Claim').trim();
    const receiptName = getReceiptDisplayName(suggestion.receipt);
    const isClaude = suggestion.kind === 'claude';
    const reason = isClaude ? suggestion.reason || 'Suggested by Claude' : describeMatchReason(suggestion);
    const altCount = suggestion.alternatives.length;
    const chipClass = isClaude ? 'claude' : (suggestion.kind === 'clear' ? 'clear' : 'ambiguous');
    const chipLabel = isClaude
      ? 'Claude'
      : suggestion.kind === 'clear'
        ? 'Clear'
        : (altCount > 0 ? `Best of ${altCount + 1}` : 'Ambiguous');
    const altNote = altCount > 0
      ? `<p class="match-review-alt">${altCount} other receipt${altCount === 1 ? ' also matches' : 's also match'} — use Change to pick</p>`
      : (suggestion.kind === 'ambiguous'
        ? '<p class="match-review-alt">Also matches other claims — confirm carefully</p>'
        : '');

    return `
      <li class="match-review-item is-${escapeHtml(suggestion.kind)}" data-suggestion-id="${escapeHtml(suggestion.id)}">
        <div class="match-review-claim">
          <span>${escapeHtml(claimLabel)}</span>
          <span>${escapeHtml(claimDate)}</span>
          <span>${escapeHtml(formatClaimAmount(suggestion.claim.amount))}</span>
        </div>
        <span class="match-review-arrow" aria-hidden="true">suggested receipt</span>
        <div class="match-review-receipt">
          <span>${escapeHtml(receiptName)}</span>
        </div>
        <div class="match-review-meta">
          <span class="match-review-chip ${chipClass}">${chipLabel}</span>
          <span class="match-review-reason">${escapeHtml(reason)}</span>
        </div>
        ${altNote}
        <div class="match-review-row-actions">
          <button type="button" class="btn-secondary btn-compact match-preview-btn" aria-label="Preview receipt for ${escapeHtml(claimLabel)}">Preview</button>
          <button type="button" class="btn-primary btn-compact match-accept-btn" aria-label="Accept match for ${escapeHtml(claimLabel)}" ${matchAcceptInFlight ? 'disabled' : ''}>Accept</button>
          <button type="button" class="btn-danger-quiet btn-compact match-reject-btn" aria-label="Reject match for ${escapeHtml(claimLabel)}" ${matchAcceptInFlight ? 'disabled' : ''}>Reject</button>
          <button type="button" class="btn-secondary btn-compact match-change-btn" aria-label="Change receipt for ${escapeHtml(claimLabel)}" ${matchAcceptInFlight ? 'disabled' : ''}>Change…</button>
        </div>
      </li>
    `;
  }).join('');

  matchReviewList.querySelectorAll('.match-review-item').forEach((li) => {
    const suggestionId = li.dataset.suggestionId;
    const suggestion = matchSuggestions.find((item) => item.id === suggestionId);
    if (!suggestion) return;

    li.querySelector('.match-preview-btn')?.addEventListener('click', (event) => {
      event.stopPropagation();
      openPreview(suggestion.receipt.key, getReceiptDisplayName(suggestion.receipt));
    });
    li.querySelector('.match-accept-btn')?.addEventListener('click', (event) => {
      event.stopPropagation();
      acceptMatchSuggestion(suggestion);
    });
    li.querySelector('.match-reject-btn')?.addEventListener('click', (event) => {
      event.stopPropagation();
      rejectMatchSuggestion(suggestion);
    });
    li.querySelector('.match-change-btn')?.addEventListener('click', (event) => {
      event.stopPropagation();
      changeMatchSuggestion(suggestion);
    });
  });
}

async function acceptMatchSuggestion(suggestion) {
  if (!suggestion || matchAcceptInFlight) return;
  matchAcceptInFlight = true;
  renderMatchReview();
  showStatus('uploading', 'Linking match...');

  try {
    const result = await patchReceiptLink(suggestion.receipt.key, suggestion.claim);
    if (!result.ok) {
      showStatus('error', result.error || 'Failed to link match');
      return;
    }

    clearSelection();
    dropSuggestionsCollidingWith(suggestion.claim.id, suggestion.receipt.key);
    renderMatchReview();
    showStatus('success', 'Match linked');
    await loadReceipts();
    refreshClaimViews();
    refreshMatchSuggestions({ announce: false });
  } finally {
    matchAcceptInFlight = false;
    renderMatchReview();
  }
}

function rejectMatchSuggestion(suggestion) {
  if (!suggestion || matchAcceptInFlight) return;
  // Dismiss only this pair so the next-ranked receipt can surface on rebuild.
  rejectedMatchPairs.add(suggestion.id);
  saveRejectedMatchPairs();
  refreshMatchSuggestions({ announce: false });
  showStatus('success', 'Suggestion dismissed');
}

function changeMatchSuggestion(suggestion) {
  if (!suggestion || matchAcceptInFlight) return;
  const candidateKeys = [
    suggestion.receipt.key,
    ...suggestion.alternatives.map((alt) => alt.receipt.key),
  ];
  startClaimLinkFlow(suggestion.claim.id);
  selectedReceiptKeys = new Set([suggestion.receipt.key]);
  applyLinkingHighlights();

  // Candidates share a date, and the list is date-sorted, so they already sit
  // together; scroll the suggested one into view rather than reordering the list.
  if (receiptList && candidateKeys.length > 0) {
    const target = receiptList.querySelector(`li[data-key="${CSS.escape(suggestion.receipt.key)}"]`);
    if (target && window.innerWidth > 700) {
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  if (window.innerWidth <= 700) {
    switchTab('receipts');
    scrollTabToggleIntoView();
  }
}

async function acceptAllClearSuggestions() {
  const clearSuggestions = matchSuggestions.filter((item) => item.kind === 'clear');
  if (clearSuggestions.length === 0 || matchAcceptInFlight) return;

  const confirmed = window.confirm(
    `Link ${clearSuggestions.length} clear match${clearSuggestions.length === 1 ? '' : 'es'} now?`
  );
  if (!confirmed) return;

  matchAcceptInFlight = true;
  renderMatchReview();
  showStatus('uploading', `Linking ${clearSuggestions.length} clear match${clearSuggestions.length === 1 ? '' : 'es'}...`);

  try {
    const results = await Promise.all(
      clearSuggestions.map((suggestion) => patchReceiptLink(suggestion.receipt.key, suggestion.claim))
    );
    const successCount = results.filter((result) => result.ok).length;
    const failCount = results.length - successCount;

    clearSelection();
    if (failCount === 0) {
      showStatus('success', `Linked ${successCount} clear match${successCount === 1 ? '' : 'es'}`);
    } else {
      showStatus('error', `Linked ${successCount}, failed ${failCount}`);
    }

    await loadReceipts();
    refreshClaimViews();
    refreshMatchSuggestions({ announce: false });
  } finally {
    matchAcceptInFlight = false;
    renderMatchReview();
  }
}

function updateLinkingContext() {
  if (!linkingDock || !linkingContextText) return;

  if (!linkingSource) {
    linkingDock.hidden = true;
    return;
  }

  if (linkingSource === 'receipt' && sourceReceiptKey) {
    const receipt = receiptsData.find((r) => r.key === sourceReceiptKey);
    if (!receipt) {
      linkingDock.hidden = true;
      return;
    }
    const name = getReceiptDisplayName(receipt);
    const amount = getReceiptAmountLabel(receipt);
    const dateInfo = getReceiptMatchDate(receipt);
    const dateStr = dateInfo.date ? formatDateForLocale(dateInfo.date) : '';
    linkingContextText.textContent = `Linking receipt: ${[name, amount, dateStr].filter(Boolean).join(' · ')}`;
    if (linkingContextPreview) {
      linkingContextPreview.hidden = false;
      linkingContextPreview.onclick = () => openPreview(receipt.key, name);
    }
    linkingDock.hidden = false;
    return;
  }

  if (linkingSource === 'claim' && sourceClaimId) {
    const claim = claimsData.find((c) => c.id === sourceClaimId);
    if (!claim) {
      linkingDock.hidden = true;
      return;
    }
    const dateStr = formatDateForLocale(parseDateOnly(claim.date) || new Date(claim.date));
    const claimLabel = (claim.description || claim.payee || 'Claim').trim();
    linkingContextText.textContent = `Linking claim: ${[claimLabel, formatCurrencyAmount('SGD', Number(claim.amount)), dateStr].filter(Boolean).join(' · ')}`;
    if (linkingContextPreview) linkingContextPreview.hidden = true;
    linkingDock.hidden = false;
    return;
  }

  linkingDock.hidden = true;
}

function updateActionBar() {
  if (!linkingSource) {
    if (linkingDock) linkingDock.hidden = true;
    actionBar.classList.remove('visible');
    confirmSelection.hidden = true;
    confirmSelection.disabled = true;
    markReadySelection.hidden = true;
    markReadySelection.disabled = true;
    return;
  }

  updateLinkingContext();
  actionBar.classList.add('visible');

  if (linkingSource === 'receipt') {
    const selectionCount = selectedClaimIds.size;
    if (selectionCount === 0) {
      actionText.textContent = 'Tick the claim this receipt belongs to, or mark it ready to claim without one';
      confirmSelection.hidden = true;
      confirmSelection.disabled = true;
      markReadySelection.textContent = 'Mark ready';
      markReadySelection.hidden = false;
      markReadySelection.disabled = false;
      return;
    }

    actionText.textContent = `${selectionCount} claim${selectionCount === 1 ? '' : 's'} selected`;
    confirmSelection.textContent = `Link ${selectionCount} claim${selectionCount === 1 ? '' : 's'}`;
    confirmSelection.hidden = false;
    confirmSelection.disabled = false;
    markReadySelection.hidden = true;
    markReadySelection.disabled = true;
    return;
  }

  markReadySelection.hidden = true;
  markReadySelection.disabled = true;

  const selectionCount = selectedReceiptKeys.size;
  if (selectionCount === 0) {
    actionText.textContent = 'Tick the receipt(s) for this claim';
    confirmSelection.hidden = true;
    confirmSelection.disabled = true;
    return;
  }

  actionText.textContent = `${selectionCount} receipt${selectionCount === 1 ? '' : 's'} selected`;
  confirmSelection.textContent = `Link ${selectionCount} receipt${selectionCount === 1 ? '' : 's'}`;
  confirmSelection.hidden = false;
  confirmSelection.disabled = false;
}

function applyLinkingHighlights() {
  if (sourceClaimId && !claimsData.some((claim) => claim.id === sourceClaimId)) {
    sourceClaimId = null;
  }

  if (sourceReceiptKey && !receiptsData.some((receipt) => receipt.key === sourceReceiptKey)) {
    sourceReceiptKey = null;
  }

  selectedReceiptKeys = new Set(
    Array.from(selectedReceiptKeys).filter((key) => receiptsData.some((receipt) => receipt.key === key))
  );
  selectedClaimIds = new Set(
    Array.from(selectedClaimIds).filter((claimId) => claimsData.some((claim) => claim.id === claimId))
  );

  if (linkingSource === 'receipt') {
    selectedReceiptKeys = sourceReceiptKey ? new Set([sourceReceiptKey]) : new Set();
    if (!sourceReceiptKey) {
      linkingSource = null;
    }
  }

  if (linkingSource === 'claim') {
    selectedClaimIds.clear();
    if (!sourceClaimId) {
      linkingSource = null;
    }
  }

  if (!linkingSource) {
    selectedReceiptKeys.clear();
    selectedClaimIds.clear();
  }

  if (!linkingSource) {
    document.body.classList.remove('selecting');
  } else {
    document.body.classList.add('selecting');
  }

  updateActionBar();
  clearMatchDecorations(receiptList);
  clearMatchDecorations(todoList);

  receiptList.querySelectorAll('li[data-key]').forEach((li) => {
    const key = li.dataset.key;
    const pickingForClaim = linkingSource === 'claim';
    const isChecked = pickingForClaim && selectedReceiptKeys.has(key);
    const isSource = linkingSource === 'receipt' && sourceReceiptKey === key;
    li.classList.remove('selected');
    li.classList.toggle('show-selector', pickingForClaim);
    li.classList.toggle('checked', isChecked);
    li.classList.toggle('source-selected', isSource);
    const linkBtn = li.querySelector('.link-btn');
    if (linkBtn) {
      const label = pickingForClaim ? 'Preview receipt' : 'Link to claim';
      linkBtn.title = label;
      linkBtn.setAttribute('aria-label', label);
    }
  });

  todoList.querySelectorAll('.todo-item[data-claim-id]').forEach((li) => {
    const claimId = li.dataset.claimId;
    const isChecked = linkingSource === 'receipt' && selectedClaimIds.has(claimId);
    const isSource = linkingSource === 'claim' && sourceClaimId === claimId;
    li.classList.remove('selected');
    li.classList.toggle('show-selector', linkingSource === 'receipt');
    li.classList.toggle('checked', isChecked);
    li.classList.toggle('source-selected', isSource);
  });

  if (linkingSource === 'claim' && sourceClaimId) {
    const selectedClaim = claimsData.find((claim) => claim.id === sourceClaimId);
    if (!selectedClaim) return;

    receiptList.querySelectorAll('li[data-key]').forEach((li) => {
      const receipt = receiptsData.find((item) => item.key === li.dataset.key);
      if (!receipt) return;
      const match = scoreReceiptClaimMatch(receipt, selectedClaim);
      if (!match.className) return;
      li.classList.add(match.className);
      appendMatchBadge(li, match.label, 'receipt');
    });
  }

  if (linkingSource === 'receipt' && sourceReceiptKey) {
    const selectedReceipt = receiptsData.find((receipt) => receipt.key === sourceReceiptKey);
    if (!selectedReceipt) return;

    todoList.querySelectorAll('.todo-item[data-claim-id]').forEach((li) => {
      const claim = claimsData.find((item) => item.id === li.dataset.claimId);
      if (!claim) return;
      const match = scoreReceiptClaimMatch(selectedReceipt, claim);
      if (!match.className) return;
      li.classList.add(match.className);
      appendMatchBadge(li, match.label, 'claim');
    });
  }
}

// Event listeners
fileInput.addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = ''; // Reset for re-upload
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  uploadFiles(e.dataTransfer.files);
});

// Load TODO claims from the selected financial backend.
export async function loadYnabTodos() {
  const requestId = ++claimsRequestId;
  const backend = getClaimsBackend();
  claimsLoadInFlight = true;
  // Keep the current list on screen while refreshing; only show the spinner
  // when there is nothing to show yet (first load, backend switch, error).
  const hasRenderedClaims = Boolean(todoList.querySelector('.todo-item'));
  if (hasRenderedClaims) {
    todoList.setAttribute('aria-busy', 'true');
  } else {
    todoList.innerHTML = '<li class="loading-state"><span class="spinner"></span> Loading...</li>';
  }

  try {
    const response = await fetch(`${API_BASE}/ynab/todos?backend=${encodeURIComponent(backend)}`, {
      headers: authHeaders(),
    });

    const data = await response.json().catch(() => null);
    if (requestId !== claimsRequestId || backend !== getClaimsBackend()) return;
    claimsLoadInFlight = false;
    todoList.removeAttribute('aria-busy');

    if (response.status === 401 && (!data || data.error === 'Unauthorized')) {
      clearAuthToken();
      resetClaimsAfterLoadFailure('Authentication required');
      showPasswordPrompt();
      return;
    }

    if (!data) {
      throw new Error(`Failed to fetch claims (${response.status})`);
    }

    if (data.error) {
      resetClaimsAfterLoadFailure(`Error: ${data.error}`);
      return;
    }

    if (data.backend !== backend) {
      throw new Error(`Claims backend mismatch: requested ${backend}, received ${data.backend || 'unknown'}`);
    }

    setClaimsLoadErrorMessage('');
    setClaimsData(data.todos.sort((a, b) => new Date(b.date) - new Date(a.date)), backend);
    renderOutstandingClaims();
    renderLinkedPairs();
    updateUploadZoneCompact();
    scheduleMatchSuggestionRefresh();
  } catch (err) {
    if (requestId !== claimsRequestId || backend !== getClaimsBackend()) return;
    claimsLoadInFlight = false;
    todoList.removeAttribute('aria-busy');
    console.error('Failed to load claims:', err);
    resetClaimsAfterLoadFailure('Failed to load claims');
  }
}

function getOutstandingClaims() {
  const linkedReceiptsByClaimId = new Map();
  receiptsData.forEach((receipt) => {
    if (receiptClaimsBackend(receipt) !== claimsDataBackend) return;
    const linkedClaimIds = getLinkedClaimIds(receipt);
    linkedClaimIds.forEach((linkedClaimId) => {
      const linkedReceipts = linkedReceiptsByClaimId.get(linkedClaimId) || [];
      linkedReceipts.push(receipt);
      linkedReceiptsByClaimId.set(linkedClaimId, linkedReceipts);
    });
  });

  return claimsData.filter((claim) => !linkedReceiptsByClaimId.has(claim.id));
}

function receiptClaimsBackend(receipt) {
  if (receipt?.linkedClaimsBackend === 'howmuch' || receipt?.linkedClaimsBackend === 'ynab') {
    return receipt.linkedClaimsBackend;
  }
  return getLinkedClaimIds(receipt).some((id) => !isReadyOnlyClaimId(id)) ? 'ynab' : null;
}

function renderOutstandingClaims() {
  renderClaimFilterControls();

  if (claimsLoadErrorMessage) {
    renderClaimLoadError(claimsLoadErrorMessage);
    applyLinkingHighlights();
    return;
  }

  const outstandingClaims = getOutstandingClaims();
  const filterTerms = getClaimFilterTerms();
  const visibleClaims = outstandingClaims.filter((claim) => !claimMatchesHideFilter(claim, filterTerms));
  pruneClaimSelectionToVisibleClaims(visibleClaims);

  todoCount.textContent = filterTerms.length > 0
    ? `(${visibleClaims.length} of ${outstandingClaims.length})`
    : `(${outstandingClaims.length})`;
  claimBadge.textContent = filterTerms.length > 0 && outstandingClaims.length > 0
    ? `${visibleClaims.length}/${outstandingClaims.length}`
    : outstandingClaims.length || '';

  if (outstandingClaims.length === 0) {
    todoList.innerHTML = '<li class="empty-state">No outstanding claims</li>';
    applyLinkingHighlights();
    return;
  }

  if (visibleClaims.length === 0) {
    todoList.innerHTML = '<li class="empty-state">No outstanding claims match the current filters</li>';
    applyLinkingHighlights();
    return;
  }

  // The account line only earns its space when claims come from more than one account.
  const distinctAccounts = new Set(visibleClaims.map((t) => (t.accountName || '').trim() || 'Unknown account'));
  const showAccount = distinctAccounts.size > 1;
  todoList.innerHTML = visibleClaims
    .map((t) => {
      const accountName = (t.accountName || '').trim();
      const accountLabel = accountName || 'Unknown account';
      const accountLine = showAccount ? `<span class="todo-account">${escapeHtml(accountLabel)}</span>` : '';
      const linkBtnIcon = `<svg class="icon-link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>`;
      return `
        <li class="todo-item${t.needsConfirmation ? ' todo-item-estimate' : ''}" data-claim-id="${escapeHtml(t.id)}"
            data-amount="${t.amount}" data-description="${escapeHtml(t.description)}"
            data-date="${t.date}">
          <span class="select-indicator claim-selector" aria-hidden="true">
            <span class="checkmark">✓</span>
          </span>
          <div class="todo-content">
            <span class="todo-payee">${escapeHtml(t.description)}</span>
            <span class="todo-desc">${escapeHtml(t.payee)}</span>
            ${accountLine}
          </div>
          <div class="todo-actions">
            <div class="todo-meta">
              <span class="todo-date">${formatDateForLocale(parseDateOnly(t.date) || new Date(t.date))}</span>
              <span class="todo-amount">${t.needsConfirmation ? ESTIMATE_MARK_HTML : ''}${escapeHtml(formatClaimAmount(t.amount))}</span>
            </div>
            <button class="link-btn claim-link-btn" title="Link receipts to this claim" aria-label="Link receipts to this claim">
              ${linkBtnIcon}
            </button>
          </div>
        </li>
      `;
    })
    .join('');

  // Attach click handlers for linking
  todoList.querySelectorAll('.todo-item[data-claim-id]').forEach(li => {
    li.addEventListener('click', (e) => handleClaimClick(e, li));
    li.querySelector('.claim-link-btn').addEventListener('click', (e) => handleClaimLinkBtnClick(e, li));
  });
  applyLinkingHighlights();
}

refreshBtn.addEventListener('click', async () => {
  await Promise.all([loadReceipts(), loadYnabTodos()]);
});

if (findMatchesBtn) {
  findMatchesBtn.addEventListener('click', () => {
    findMatches();
  });
}

if (acceptAllClearBtn) {
  acceptAllClearBtn.addEventListener('click', () => {
    acceptAllClearSuggestions();
  });
}

if (clearDismissedMatchesBtn) {
  clearDismissedMatchesBtn.addEventListener('click', () => {
    rejectedMatchPairs = new Set();
    saveRejectedMatchPairs();
    refreshMatchSuggestions({ announce: true });
  });
}

if (matchReviewToggle) {
  matchReviewToggle.addEventListener('click', () => {
    setMatchReviewCollapsed(!matchReviewCollapsed);
  });
}

if (claimFilterInput) {
  claimFilterState = loadClaimFilterState();
  renderClaimFilterControls();

  claimFilterInput.addEventListener('input', () => {
    claimFilterState.text = claimFilterInput.value;
    saveClaimFilterState();
    renderOutstandingClaims();
    scheduleMatchSuggestionRefresh();
  });
}

if (claimFilterPills) {
  claimFilterPills.addEventListener('click', (event) => {
    const button = event.target.closest('.claim-filter-pill');
    if (!button) return;
    const filter = button.dataset.filter || '';
    const normalisedFilter = normaliseFilterTerm(filter);
    const activeQuickFilters = new Set(claimFilterState.quickFilters.map(normaliseFilterTerm));
    if (activeQuickFilters.has(normalisedFilter)) {
      claimFilterState.quickFilters = claimFilterState.quickFilters
        .filter((term) => normaliseFilterTerm(term) !== normalisedFilter);
    } else {
      claimFilterState.quickFilters = [...claimFilterState.quickFilters, filter];
    }
    saveClaimFilterState();
    renderOutstandingClaims();
    scheduleMatchSuggestionRefresh();
    Array.from(claimFilterPills.querySelectorAll('.claim-filter-pill'))
      .find((pill) => pill.dataset.filter === filter)
      ?.focus();
  });
}

if (claimFilterClear) {
  claimFilterClear.addEventListener('click', () => {
    claimFilterState = { text: '', quickFilters: [] };
    saveClaimFilterState();
    renderOutstandingClaims();
    scheduleMatchSuggestionRefresh();
    claimFilterInput?.focus();
  });
}


// ===== Receipt-Claim Linking =====

// Handle receipt click - preview by default, toggle target selection while linking from claim
function handleReceiptClick(e, li) {
  if (
    e.target.closest('.link-btn') ||
    e.target.closest('.delete-btn') ||
    e.target.closest('.date-btn') ||
    e.target.closest('.receipt-date')
  ) return;

  const key = li.dataset.key;
  const name = li.dataset.name;

  if (linkingSource === 'claim' && sourceClaimId) {
    if (selectedReceiptKeys.has(key)) {
      selectedReceiptKeys.delete(key);
    } else {
      selectedReceiptKeys.add(key);
    }
    applyLinkingHighlights();
    return;
  }

  openPreview(key, name);
}

async function handleDateOverrideClick(e, li) {
  e.stopPropagation();
  const receiptKey = li.dataset.key;
  const receipt = receiptsData.find((item) => item.key === receiptKey);
  if (!receipt) return;

  const suggestedValue =
    receipt.receiptDateSource === 'manual'
      ? receipt.receiptDate || ''
      : receipt.receiptDate || receipt.detectedReceiptDate || '';
  const entered = window.prompt('Set receipt date (YYYY-MM-DD). Leave empty to clear manual override.', suggestedValue);
  if (entered === null) return;

  const nextValue = entered.trim();
  if (nextValue && !RECEIPT_DATE_RE.test(nextValue)) {
    showStatus('error', 'Date must be in YYYY-MM-DD format');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/receipt/${encodeURIComponent(receiptKey)}/receipt-date`, {
      method: 'PATCH',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receiptDate: nextValue || null,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showStatus('error', data.error || 'Failed to update receipt date');
      return;
    }

    showStatus('success', nextValue ? 'Receipt date updated' : 'Manual date override cleared');
    loadReceipts().then(refreshClaimViews);
  } catch (error) {
    console.error('Date override failed:', error);
    showStatus('error', 'Failed to update receipt date');
  }
}

// Handle receipt link button click
function handleLinkBtnClick(e, li) {
  e.stopPropagation();
  const key = li.dataset.key;
  const isLinked = li.dataset.linked;

  if (isLinked) {
    if (confirm('Unlink this receipt from its claim?')) {
      unlinkReceipt(key);
    }
    return;
  }

  // While picking receipts for a claim the row itself toggles selection, so
  // this button becomes the way to look at the receipt before ticking it.
  if (linkingSource === 'claim' && sourceClaimId) {
    openPreview(key, li.dataset.name);
    return;
  }

  startReceiptLinkFlow(key);
}

async function handleDeleteBtnClick(e, li) {
  e.stopPropagation();
  const key = li.dataset.key;
  const isLinked = Boolean(li.dataset.linked);
  const prompt = isLinked
    ? 'Delete this linked receipt? The link will be removed too.'
    : 'Delete this receipt?';

  if (!confirm(prompt)) return;
  await deleteReceipt(key);
}

function handleClaimLinkBtnClick(e, li) {
  e.stopPropagation();
  const claimId = li.dataset.claimId;

  if (linkingSource === 'receipt' && sourceReceiptKey) {
    if (selectedClaimIds.has(claimId)) {
      selectedClaimIds.delete(claimId);
    } else {
      selectedClaimIds.add(claimId);
    }
    applyLinkingHighlights();
    return;
  }

  startClaimLinkFlow(claimId);
}

// Handle claim click: toggle target selection while linking from a receipt,
// otherwise start linking from this claim (the row is the big tap target).
function handleClaimClick(e, li) {
  if (e.target.closest('.claim-link-btn')) return;
  const claimId = li.dataset.claimId;
  if (linkingSource === 'receipt' && sourceReceiptKey) {
    if (selectedClaimIds.has(claimId)) {
      selectedClaimIds.delete(claimId);
    } else {
      selectedClaimIds.add(claimId);
    }
    applyLinkingHighlights();
    return;
  }
  if (linkingSource === 'claim' && sourceClaimId === claimId) return;
  startClaimLinkFlow(claimId);
}

// Step 1 from receipt side: pick source receipt, then choose claim target(s)
function startReceiptLinkFlow(key) {
  linkingSource = 'receipt';
  sourceReceiptKey = key;
  sourceClaimId = null;
  selectedClaimIds.clear();
  selectedReceiptKeys = new Set([key]);
  document.body.classList.add('selecting');
  applyLinkingHighlights();

  if (window.innerWidth <= 700) {
    switchTab('claims');
    scrollTabToggleIntoView();
  }
}

// Step 1 from claim side: pick source claim, then choose receipt target(s)
function startClaimLinkFlow(claimId) {
  linkingSource = 'claim';
  sourceClaimId = claimId;
  sourceReceiptKey = null;
  selectedReceiptKeys.clear();
  selectedClaimIds.clear();
  document.body.classList.add('selecting');
  applyLinkingHighlights();

  if (window.innerWidth <= 700) {
    switchTab('receipts');
    scrollTabToggleIntoView();
  }
}

// Clear all link selections
export function clearSelection() {
  linkingSource = null;
  sourceReceiptKey = null;
  sourceClaimId = null;
  selectedReceiptKeys.clear();
  selectedClaimIds.clear();
  document.body.classList.remove('selecting');
  applyLinkingHighlights();
}

// Cancel from the user's side: drop the selection and, on mobile, go back to
// the tab the flow started from.
function cancelLinking() {
  if (!linkingSource) return;
  const returnTab = linkingSource === 'receipt' ? 'receipts' : 'claims';
  clearSelection();
  if (window.innerWidth <= 700) {
    switchTab(returnTab);
  }
}

async function patchReceiptLink(receiptKey, claim) {
  return patchReceiptLinks(receiptKey, [claim]);
}

async function patchReceiptLinks(
  receiptKey,
  claims,
  backend = getClaimsBackend(),
  expectedClaimsBackend = undefined,
) {
  try {
    const response = await fetch(`${API_BASE}/receipt/${encodeURIComponent(receiptKey)}/link`, {
      method: 'PATCH',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        backend,
        ...(expectedClaimsBackend ? { expectedClaimsBackend } : {}),
        linkedClaims: claims.map((claim) => ({
          id: claim.id,
          description: claim.description,
          amount: claim.amount,
          date: claim.date,
        })),
      }),
    });

    if (response.ok) {
      return { ok: true };
    }

    const data = await response.json().catch(() => ({}));
    return { ok: false, error: data.error || 'Failed to link' };
  } catch (err) {
    console.error('Link failed:', err);
    return { ok: false, error: 'Failed to link receipt' };
  }
}

async function linkSelectedReceiptsToClaim() {
  if (linkingSource !== 'claim' || !sourceClaimId || selectedReceiptKeys.size === 0) {
    return;
  }

  const claimId = sourceClaimId;
  const claim = claimsData.find((item) => item.id === claimId);
  if (!claim) {
    showStatus('error', 'Selected claim not found');
    return;
  }

  const receiptKeys = Array.from(selectedReceiptKeys);
  showStatus('uploading', `Linking ${receiptKeys.length} receipt(s)...`);

  const results = await Promise.all(receiptKeys.map((key) => patchReceiptLink(key, claim)));
  const successCount = results.filter((result) => result.ok).length;
  const failedResults = results.filter((result) => !result.ok);

  if (failedResults.length === 0) {
    showStatus('success', `Linked ${successCount} receipt(s)`);
  } else {
    const errorSummary = failedResults
      .slice(0, 2)
      .map((result) => result.error)
      .join(', ');
    showStatus(
      'error',
      `Linked ${successCount}, failed ${failedResults.length}${errorSummary ? `: ${errorSummary}` : ''}`
    );
  }

  clearSelection();
  loadReceipts().then(refreshClaimViews);
}

async function linkSourceReceiptToClaim() {
  if (linkingSource !== 'receipt' || !sourceReceiptKey || selectedClaimIds.size === 0) {
    return;
  }

  const claims = Array.from(selectedClaimIds)
    .map((claimId) => claimsData.find((item) => item.id === claimId))
    .filter(Boolean);
  if (claims.length === 0) {
    showStatus('error', 'Selected claim not found');
    return;
  }

  showStatus('uploading', `Linking ${claims.length} claim(s)...`);
  const result = await patchReceiptLinks(sourceReceiptKey, claims);

  if (result.ok) {
    showStatus('success', `Linked ${claims.length} claim(s)`);
  } else {
    showStatus('error', result.error || 'Failed to link');
  }

  clearSelection();
  loadReceipts().then(refreshClaimViews);
}

function buildReadyClaimPayload(receipt) {
  const receiptName = getReceiptDisplayName(receipt);
  const title = [receipt.taggedVendor, receipt.taggedPurpose]
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim())
    .join(' - ');
  const dateInfo = getReceiptMatchDate(receipt);
  const comparableAmounts = getComparableReceiptAmounts(receipt);
  const preferredAmount = comparableAmounts.find((amount) => amount.kind === 'fx-plus') ||
    comparableAmounts.find((amount) => amount.kind === 'fx') ||
    comparableAmounts[0];

  return {
    id: getReadyClaimId(receipt),
    description: title || receiptName || 'Receipt ready',
    amount: preferredAmount?.value,
    date: dateInfo.date ? dateInfo.date.toISOString().slice(0, 10) : undefined,
  };
}

async function markSourceReceiptReady() {
  if (linkingSource !== 'receipt' || !sourceReceiptKey || selectedClaimIds.size > 0) {
    return;
  }

  const receipt = receiptsData.find((item) => item.key === sourceReceiptKey);
  if (!receipt) {
    showStatus('error', 'Selected receipt not found');
    return;
  }

  showStatus('uploading', 'Marking receipt ready...');
  const result = await patchReceiptLink(sourceReceiptKey, buildReadyClaimPayload(receipt));

  if (result.ok) {
    showStatus('success', 'Receipt marked ready');
  } else {
    showStatus('error', result.error || 'Failed to mark ready');
  }

  clearSelection();
  loadReceipts().then(refreshClaimViews);
}

function handleConfirmSelection() {
  if (linkingSource === 'claim') {
    linkSelectedReceiptsToClaim();
    return;
  }
  if (linkingSource === 'receipt') {
    linkSourceReceiptToClaim();
  }
}

async function deleteReceipt(receiptKey) {
  try {
    const response = await fetch(`${API_BASE}/receipt/${encodeURIComponent(receiptKey)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });

    if (response.ok) {
      selectedReceiptKeys.delete(receiptKey);
      if (sourceReceiptKey === receiptKey) {
        clearSelection();
      }
      showStatus('success', 'Receipt deleted');
      loadReceipts().then(refreshClaimViews);
      return;
    }

    const data = await response.json().catch(() => ({}));
    showStatus('error', data.error || 'Failed to delete receipt');
  } catch (err) {
    console.error('Delete failed:', err);
    showStatus('error', 'Failed to delete receipt');
  }
}

function buildLinkedClaimPayload(receipt, claimId, index) {
  const claim = claimsData.find((item) => item.id === claimId);
  const fallbackDescription = getLinkedClaimJumpLabel(receipt, claimId, index);
  const description = (claim?.description || claim?.payee || fallbackDescription || '').trim();

  return {
    id: claimId,
    description,
    amount: claim && Number.isFinite(Number(claim.amount)) ? Number(claim.amount) : undefined,
    date: claim?.date || undefined,
  };
}

async function unlinkClaimFromReceipt(receiptKey, claimId, backend) {
  const receipt = receiptsData.find((item) => item.key === receiptKey);
  if (!receipt) {
    showStatus('error', 'Linked receipt not found');
    return;
  }

  const existingClaimIds = getLinkedClaimIds(receipt);
  if (!existingClaimIds.includes(claimId)) {
    showStatus('error', 'Linked claim not found');
    return;
  }

  const remainingClaimIds = existingClaimIds.filter((id) => id !== claimId);
  if (remainingClaimIds.length === 0) {
    await unlinkReceipt(receiptKey, backend);
    return;
  }

  const remainingClaims = remainingClaimIds.map((id, index) => buildLinkedClaimPayload(receipt, id, index));
  showStatus('uploading', 'Updating linked claims...');
  const result = await patchReceiptLinks(receiptKey, remainingClaims, backend, backend);
  if (!result.ok) {
    showStatus('error', result.error || 'Failed to unlink pair');
    return;
  }

  clearSelection();
  showStatus('success', 'Unlinked claim-receipt pair');
  loadReceipts().then(refreshClaimViews);
}

// Unlink a receipt from its claim
async function unlinkReceipt(receiptKey, backend = getClaimsBackend()) {
  try {
    const response = await fetch(
      `${API_BASE}/receipt/${encodeURIComponent(receiptKey)}/link?backend=${encodeURIComponent(backend)}`,
      {
        method: 'DELETE',
        headers: authHeaders(),
      },
    );

    if (response.ok) {
      showStatus('success', 'Receipt unlinked');
      loadReceipts().then(refreshClaimViews);
    } else {
      const data = await response.json();
      showStatus('error', data.error || 'Failed to unlink');
    }
  } catch (err) {
    console.error('Unlink failed:', err);
    showStatus('error', 'Failed to unlink receipt');
  }
}

// Cancel selection button
cancelSelection.addEventListener('click', cancelLinking);
confirmSelection.addEventListener('click', handleConfirmSelection);
markReadySelection.addEventListener('click', markSourceReceiptReady);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !linkingSource) return;
  if (document.getElementById('previewOverlay')?.classList.contains('active')) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  cancelLinking();
});

// ===== Mobile Tab Toggle =====

function switchTab(tab) {
  tabBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  receiptsColumn.classList.toggle('active', tab === 'receipts');
  claimsColumn.classList.toggle('active', tab === 'claims');
}

function scrollTabToggleIntoView() {
  requestAnimationFrame(() => {
    // The header is sticky on narrow screens; tell scroll-margin-top how tall it is
    // so the tab toggle lands below it rather than underneath it.
    const header = document.querySelector('.app-header');
    const stickyHeight = header && getComputedStyle(header).position === 'sticky'
      ? header.getBoundingClientRect().height + 8
      : 0;
    document.documentElement.style.setProperty('--sticky-header-height', `${Math.round(stickyHeight)}px`);
    document.querySelector('.tab-toggle')?.scrollIntoView({ block: 'start' });
  });
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
  });
});
export function initClaims() {
  renderMatchReview();
}
