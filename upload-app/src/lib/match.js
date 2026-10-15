import {
  RECEIPT_DATE_RE,
  AMOUNT_MATCH_TOLERANCE,
  DATE_NEAR_THRESHOLD_DAYS,
  READY_CLAIM_ID_PREFIX,
} from './constants.js';
import { claimsData } from './state.js';
import { formatDateForLocale, formatCurrencyAmount } from './core.js';

export function parseDateOnly(value) {
  if (!value) return null;
  const normalised = RECEIPT_DATE_RE.test(value) ? `${value}T00:00:00Z` : value;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

export function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs(dateA.getTime() - dateB.getTime()) / msPerDay);
}

export function getReceiptMatchDate(receipt) {
  const explicitDate = parseDateOnly(receipt.receiptDate);
  if (explicitDate) {
    return {
      date: explicitDate,
      source: receipt.receiptDateSource || 'manual',
    };
  }

  const detectedDate = parseDateOnly(receipt.detectedReceiptDate);
  if (detectedDate) {
    return {
      date: detectedDate,
      source: 'ai',
    };
  }

  const uploadedDate = parseDateOnly(receipt.uploaded);
  if (uploadedDate) {
    return {
      date: uploadedDate,
      source: 'upload',
    };
  }

  return { date: null, source: null };
}

export function getLinkedClaimIds(receipt) {
  if (Array.isArray(receipt.linkedClaimIds)) {
    return receipt.linkedClaimIds.filter((claimId) => typeof claimId === 'string' && claimId.length > 0);
  }
  if (typeof receipt.linkedClaimId === 'string' && receipt.linkedClaimId.length > 0) {
    return [receipt.linkedClaimId];
  }
  return [];
}

export function getReadyClaimId(receipt) {
  return `${READY_CLAIM_ID_PREFIX}${receipt.key}`;
}

export function isReadyOnlyClaimId(claimId) {
  return typeof claimId === 'string' && claimId.startsWith(READY_CLAIM_ID_PREFIX);
}

export function getReceiptDisplayName(receipt) {
  const key = typeof receipt.key === 'string' ? receipt.key : '';
  const originalName = typeof receipt.originalName === 'string' ? receipt.originalName.trim() : '';
  if (originalName) return originalName;
  const keyWithoutPrefix = key.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}_/, '');
  return keyWithoutPrefix || key || 'Receipt';
}

export function getLinkedClaimJumpLabel(receipt, claimId, index = 0) {
  if (isReadyOnlyClaimId(claimId)) {
    return 'Receipt ready';
  }

  const linkedClaim = claimsData.find((claim) => claim.id === claimId);
  if (linkedClaim) {
    const description = (linkedClaim.description || '').trim();
    if (description) return description;
    const payee = (linkedClaim.payee || '').trim();
    if (payee) return payee;
  }

  const linkedClaimIds = getLinkedClaimIds(receipt);
  const fallbackDescription = (receipt.linkedClaimDescription || '').trim();
  if (fallbackDescription && linkedClaimIds.length === 1) {
    return fallbackDescription;
  }

  const shortId = typeof claimId === 'string' && claimId.length >= 6
    ? claimId.slice(-6)
    : `${index + 1}`;
  return `Claim ${shortId}`;
}

export function formatLinkedPairReceiptAmount(receipt) {
  const taggedAmount = Number(receipt.taggedAmount);
  if (!Number.isFinite(taggedAmount)) return 'Amount pending';

  const currency = (receipt.taggedCurrency || '').toUpperCase();
  if (currency !== 'USD') {
    return formatCurrencyAmount(currency, taggedAmount);
  }

  const fxApproxPlus = Number(receipt.taggedAmountSgdApproxPlus325);
  const fxApprox = Number(receipt.taggedAmountSgdApprox);
  if (Number.isFinite(fxApproxPlus)) {
    return `${formatCurrencyAmount('USD', taggedAmount)} (~S$${fxApproxPlus.toFixed(2)})`;
  }
  if (Number.isFinite(fxApprox)) {
    return `${formatCurrencyAmount('USD', taggedAmount)} (~S$${fxApprox.toFixed(2)})`;
  }
  return formatCurrencyAmount('USD', taggedAmount);
}

export function formatReceiptDateLabel(receipt) {
  const matchDate = getReceiptMatchDate(receipt);
  if (!matchDate.date) {
    return { text: 'Unknown date', className: '', title: 'No date available' };
  }

  const formatted = formatDateForLocale(matchDate.date);
  if (matchDate.source === 'manual') {
    return {
      text: `Manual ${formatted}`,
      className: 'receipt-date-manual',
      title: 'Manually overridden receipt date',
    };
  }
  if (matchDate.source === 'ai') {
    return {
      text: formatted,
      className: 'receipt-date-ai',
      title: 'AI detected receipt date',
    };
  }

  return { text: formatted, className: '', title: 'Upload date fallback' };
}

export function getComparableReceiptAmounts(receipt) {
  const baseAmount = Number(receipt.taggedAmount);
  const fxAmount = Number(receipt.taggedAmountSgdApprox);
  const fxAmountPlus325 = Number(receipt.taggedAmountSgdApproxPlus325);
  const values = [];

  if (Number.isFinite(baseAmount)) {
    values.push({ value: baseAmount, kind: 'base' });
  }
  if (Number.isFinite(fxAmount)) {
    values.push({ value: fxAmount, kind: 'fx' });
  }
  if (Number.isFinite(fxAmountPlus325)) {
    values.push({ value: fxAmountPlus325, kind: 'fx-plus' });
  }

  return values;
}

export function scoreReceiptClaimMatch(receipt, claim) {
  const claimAmount = Number(claim.amount);
  const hasClaimAmount = Number.isFinite(claimAmount);
  const comparableAmounts = getComparableReceiptAmounts(receipt);
  const matchedAmount = hasClaimAmount
    ? comparableAmounts.find((candidate) => Math.abs(claimAmount - candidate.value) <= AMOUNT_MATCH_TOLERANCE)
    : null;
  const amountMatch = Boolean(matchedAmount);

  const claimDate = parseDateOnly(claim.date);
  const receiptDateInfo = getReceiptMatchDate(receipt);
  const dayDiff = daysBetween(claimDate, receiptDateInfo.date);
  const isExactDate = dayDiff === 0;
  const isNearDate = dayDiff !== null && dayDiff >= 1 && dayDiff <= DATE_NEAR_THRESHOLD_DAYS;

  // A receipt with no detected date falls back to its upload date, which is a
  // much weaker signal; say so rather than presenting it as a real date match.
  const dateSuffix = receiptDateInfo.source === 'upload' ? ' (upload date)' : '';

  if (amountMatch && (isExactDate || isNearDate)) {
    return {
      className: 'match-best',
      label: matchedAmount && matchedAmount.kind.startsWith('fx') ? 'Best FX match' : 'Best match',
    };
  }
  if (amountMatch) {
    return {
      className: 'match-amount',
      label: matchedAmount && matchedAmount.kind.startsWith('fx') ? 'FX amount match' : 'Amount match',
    };
  }
  if (isExactDate) {
    return { className: 'match-date', label: `Date match${dateSuffix}` };
  }
  if (isNearDate) {
    return { className: 'match-date-near', label: `Near date${dateSuffix}` };
  }
  return { className: '', label: '' };
}

/** Suggestion matching uses manual/AI dates only unless allowUploadDate is set (matches CLI). */
export function getSuggestionReceiptDate(receipt, { allowUploadDate = false } = {}) {
  const explicitDate = parseDateOnly(receipt.receiptDate);
  if (explicitDate) {
    return {
      date: explicitDate,
      source: receipt.receiptDateSource || 'manual',
    };
  }

  const detectedDate = parseDateOnly(receipt.detectedReceiptDate);
  if (detectedDate) {
    return {
      date: detectedDate,
      source: 'ai',
    };
  }

  if (allowUploadDate) {
    const uploadedDate = parseDateOnly(receipt.uploaded);
    if (uploadedDate) {
      return {
        date: uploadedDate,
        source: 'upload',
      };
    }
  }

  return { date: null, source: null };
}

export function makeSuggestionPairId(claimId, receiptKey) {
  return `${claimId}::${receiptKey}`;
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function amountKindRank(kind) {
  if (kind === 'base') return 0;
  if (kind === 'fx') return 1;
  if (kind === 'fx-plus') return 2;
  return 3;
}

function compareMatchCandidates(a, b) {
  if (a.dayDiff !== b.dayDiff) return a.dayDiff - b.dayDiff;
  const kindDiff = amountKindRank(a.amountKind) - amountKindRank(b.amountKind);
  if (kindDiff !== 0) return kindDiff;
  return Math.abs(a.amount - a.claim.amount) - Math.abs(b.amount - b.claim.amount);
}

export function findMatchCandidates(claims, receipts, options = {}) {
  const nearDays = Number.isFinite(Number(options.nearDays)) ? Number(options.nearDays) : 0;
  const allowUploadDate = Boolean(options.allowUploadDate);
  const candidates = [];

  for (const claim of claims) {
    const claimDate = parseDateOnly(claim.date);
    const claimAmount = Number(claim.amount);
    if (!claimDate || !Number.isFinite(claimAmount)) continue;

    for (const receipt of receipts) {
      const receiptDateInfo = getSuggestionReceiptDate(receipt, { allowUploadDate });
      if (!receiptDateInfo.date) continue;

      const dayDiff = daysBetween(claimDate, receiptDateInfo.date);
      if (dayDiff === null || dayDiff > nearDays) continue;

      const matchedAmount = getComparableReceiptAmounts(receipt).find((candidate) => (
        Math.abs(claimAmount - candidate.value) <= AMOUNT_MATCH_TOLERANCE
      ));
      if (!matchedAmount) continue;

      candidates.push({
        claim,
        receipt,
        receiptDate: formatIsoDate(receiptDateInfo.date),
        dateSource: receiptDateInfo.source,
        amount: matchedAmount.value,
        amountKind: matchedAmount.kind,
        dayDiff,
      });
    }
  }

  return candidates;
}

export function partitionClearAmbiguousCandidates(candidates) {
  const byClaim = new Map();
  const byReceipt = new Map();

  for (const candidate of candidates) {
    byClaim.set(candidate.claim.id, [...(byClaim.get(candidate.claim.id) || []), candidate]);
    byReceipt.set(candidate.receipt.key, [...(byReceipt.get(candidate.receipt.key) || []), candidate]);
  }

  const clear = candidates.filter((candidate) => (
    (byClaim.get(candidate.claim.id) || []).length === 1 &&
    (byReceipt.get(candidate.receipt.key) || []).length === 1
  ));
  const ambiguous = candidates.filter((candidate) => !clear.includes(candidate));

  return { clear, ambiguous, byClaim };
}

/**
 * Build claim-first match suggestions for the Match Review queue.
 * Clear = unique one-to-one. Ambiguous = one row per claim with ranked alternatives.
 */
export function buildMatchSuggestions(claims, receipts, options = {}) {
  const rejectedPairs = options.rejectedPairs instanceof Set
    ? options.rejectedPairs
    : new Set(Array.isArray(options.rejectedPairs) ? options.rejectedPairs : []);

  const linkedClaimIds = new Set();
  receipts.forEach((receipt) => {
    getLinkedClaimIds(receipt).forEach((claimId) => linkedClaimIds.add(claimId));
  });

  const outstandingClaims = claims.filter((claim) => !linkedClaimIds.has(claim.id));
  const unlinkedReceipts = receipts.filter((receipt) => getLinkedClaimIds(receipt).length === 0);

  const candidates = findMatchCandidates(outstandingClaims, unlinkedReceipts, options)
    .filter((candidate) => !rejectedPairs.has(makeSuggestionPairId(candidate.claim.id, candidate.receipt.key)));

  const { clear, ambiguous, byClaim } = partitionClearAmbiguousCandidates(candidates);
  const suggestions = [];

  clear.forEach((candidate) => {
    suggestions.push({
      id: makeSuggestionPairId(candidate.claim.id, candidate.receipt.key),
      kind: 'clear',
      claim: candidate.claim,
      receipt: candidate.receipt,
      receiptDate: candidate.receiptDate,
      dateSource: candidate.dateSource,
      amount: candidate.amount,
      amountKind: candidate.amountKind,
      dayDiff: candidate.dayDiff,
      alternatives: [],
    });
  });

  const clearClaimIds = new Set(clear.map((candidate) => candidate.claim.id));
  // When several claims tie on the same receipts, spread the primaries so two
  // rows don't both suggest the same file.
  const usedPrimaryReceiptKeys = new Set();
  for (const [claimId, claimCandidates] of byClaim.entries()) {
    if (clearClaimIds.has(claimId)) continue;
    const ranked = [...claimCandidates].sort(compareMatchCandidates);
    if (ranked.length === 0) continue;
    const primary = ranked.find((candidate) => !usedPrimaryReceiptKeys.has(candidate.receipt.key)) || ranked[0];
    usedPrimaryReceiptKeys.add(primary.receipt.key);
    suggestions.push({
      id: makeSuggestionPairId(primary.claim.id, primary.receipt.key),
      kind: 'ambiguous',
      claim: primary.claim,
      receipt: primary.receipt,
      receiptDate: primary.receiptDate,
      dateSource: primary.dateSource,
      amount: primary.amount,
      amountKind: primary.amountKind,
      dayDiff: primary.dayDiff,
      alternatives: ranked.filter((candidate) => candidate !== primary).map((candidate) => ({
        receipt: candidate.receipt,
        receiptDate: candidate.receiptDate,
        dateSource: candidate.dateSource,
        amount: candidate.amount,
        amountKind: candidate.amountKind,
        dayDiff: candidate.dayDiff,
      })),
    });
  }

  suggestions.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'clear' ? -1 : 1;
    const aTime = parseDateOnly(a.claim.date)?.getTime() || 0;
    const bTime = parseDateOnly(b.claim.date)?.getTime() || 0;
    if (aTime !== bTime) return bTime - aTime;
    return (a.claim.description || '').localeCompare(b.claim.description || '');
  });

  return suggestions;
}

export function describeMatchReason(suggestion) {
  const currency = (suggestion.receipt?.taggedCurrency || '').toUpperCase();
  let amountLabel;
  if (suggestion.amountKind === 'fx' || suggestion.amountKind === 'fx-plus') {
    amountLabel = `FX ≈ S$${Number(suggestion.amount).toFixed(2)}`;
  } else if (currency && currency !== 'SGD') {
    amountLabel = `${currency} ${Number(suggestion.amount).toFixed(2)}`;
  } else {
    amountLabel = `S$${Number(suggestion.amount).toFixed(2)}`;
  }

  if (suggestion.dayDiff === 0) {
    return `${amountLabel} · same day`;
  }
  if (suggestion.dayDiff === 1) {
    return `${amountLabel} · 1 day apart`;
  }
  return `${amountLabel} · ${suggestion.dayDiff} days apart`;
}
