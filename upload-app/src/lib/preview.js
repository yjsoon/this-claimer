import { API_BASE } from './constants.js';
import { authHeaders } from './core.js';

const previewOverlay = document.getElementById('previewOverlay');
const previewBackdrop = previewOverlay.querySelector('.preview-backdrop');
const previewClose = document.getElementById('previewClose');
const previewFilename = document.getElementById('previewFilename');
const previewImage = document.getElementById('previewImage');
const previewPdf = document.getElementById('previewPdf');
const previewSpinner = document.getElementById('previewSpinner');
const previewReview = document.getElementById('previewReview');
const previewReviewBtn = document.getElementById('previewReviewBtn');
const previewPrevious = document.getElementById('previewPrevious');
const previewNext = document.getElementById('previewNext');
const previewAmountInput = document.getElementById('previewAmountInput');
let previewReviewAction = null;
let previewNavigateAction = null;
let previewAmountAction = null;
let previewAmountValue = 0;
let previewReviewed = false;
let previewRequest = 0;

function commitPreviewAmount() {
  if (!previewAmountAction) return true;
  if (!previewAmountInput.reportValidity()) return false;
  const amount = previewAmountInput.valueAsNumber;
  if (amount !== previewAmountValue) {
    previewAmountAction(amount);
    previewAmountValue = amount;
  }
  previewAmountInput.value = previewAmountValue.toFixed(2);
  return true;
}

function updatePreviewReview(reviewed) {
  previewReviewed = reviewed;
  previewReviewBtn.setAttribute('aria-pressed', String(reviewed));
  previewReviewBtn.title = `${reviewed ? 'Reviewed' : 'Not reviewed'} · Enter to toggle · ←/→ to navigate`;
}

function clearPreviewMedia() {
  for (const media of [previewImage, previewPdf]) {
    media.onload = null;
    if (media.src.startsWith('blob:')) URL.revokeObjectURL(media.src);
    media.removeAttribute('src');
    media.classList.remove('visible');
  }
}

export async function openPreview(key, displayName, { amount = 0, onAmountChange = null, reviewed = false, onReview = null, onNavigate = null, hasPrevious = false, hasNext = false } = {}) {
  const request = ++previewRequest;
  clearPreviewMedia();
  previewFilename.textContent = displayName;
  previewSpinner.classList.add('loading');
  previewReviewAction = typeof onReview === 'function' ? onReview : null;
  previewNavigateAction = typeof onNavigate === 'function' ? onNavigate : null;
  previewPrevious.hidden = previewNext.hidden = !previewNavigateAction;
  previewPrevious.disabled = !hasPrevious;
  previewNext.disabled = !hasNext;
  previewOverlay.classList.toggle('has-navigation', Boolean(previewNavigateAction));
  previewAmountAction = typeof onAmountChange === 'function' ? onAmountChange : null;
  previewAmountValue = amount;
  previewAmountInput.value = amount.toFixed(2);
  updatePreviewReview(reviewed);
  previewReview.hidden = !previewReviewAction;
  previewOverlay.classList.toggle('has-review-action', Boolean(previewReviewAction));
  previewOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  // Keep keyboard input in the dialog rather than on the invoice row or PDF viewer.
  previewClose.focus({ preventScroll: true });

  const url = `${API_BASE}/receipt/${encodeURIComponent(key)}`;
  const isPdf = key.toLowerCase().endsWith('.pdf');

  try {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error('Failed to load');

    let blob = await response.blob();
    if (isPdf) {
      // Existing uploads may have untrusted HTTP metadata. Never navigate an
      // iframe to HTML (including a PDF/HTML polyglot served as text/html).
      if (await blob.slice(0, 5).text() !== '%PDF-') throw new Error('Invalid PDF');
      blob = new Blob([blob], { type: 'application/pdf' });
    }
    if (request !== previewRequest) return;
    const blobUrl = URL.createObjectURL(blob);

    if (isPdf) {
      previewPdf.src = blobUrl;
      previewPdf.onload = () => {
        if (request !== previewRequest) return;
        previewSpinner.classList.remove('loading');
        previewPdf.classList.add('visible');
      };
    } else {
      previewImage.src = blobUrl;
      previewImage.onload = () => {
        if (request !== previewRequest) return;
        previewSpinner.classList.remove('loading');
        previewImage.classList.add('visible');
      };
    }
  } catch (err) {
    if (request !== previewRequest) return;
    previewSpinner.classList.remove('loading');
    previewFilename.textContent = `${displayName} (failed to load)`;
    console.error('Preview failed:', err);
  }
}

export function closePreview() {
  const request = ++previewRequest;
  previewOverlay.classList.remove('active');
  previewOverlay.classList.remove('has-review-action');
  previewSpinner.classList.remove('loading');
  document.body.style.overflow = '';
  previewReviewAction = null;
  previewNavigateAction = null;
  previewAmountAction = null;
  previewReview.hidden = true;
  setTimeout(() => {
    if (request === previewRequest) clearPreviewMedia();
  }, 250);
}

export function initPreview() {
  previewClose.addEventListener('click', closePreview);
  previewBackdrop.addEventListener('click', closePreview);
  for (const [button, direction] of [[previewPrevious, -1], [previewNext, 1]]) {
    button.addEventListener('click', (e) => {
      if (e.detail > 1 || !commitPreviewAmount()) return;
      previewNavigateAction?.(direction);
    });
  }
  previewAmountInput.addEventListener('change', commitPreviewAmount);
  previewAmountInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') previewAmountInput.value = previewAmountValue.toFixed(2);
    if (e.key === 'Escape' || commitPreviewAmount()) previewClose.focus({ preventScroll: true });
  });
  previewReviewBtn.addEventListener('click', (e) => {
    if (!previewReviewAction || e.detail > 1 || !commitPreviewAmount()) return;
    previewReviewAction(true);
    if (!previewNavigateAction?.(1)) closePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (!previewOverlay.classList.contains('active')) return;
    if (e.key === 'Escape') {
      closePreview();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Enter' && e.target.closest('.preview-nav')) return;
    if (e.key === 'Enter' && previewReviewAction) {
      e.preventDefault();
      if (e.repeat || !commitPreviewAmount()) return;
      previewReviewAction(!previewReviewed);
      updatePreviewReview(!previewReviewed);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && previewNavigateAction) {
      e.preventDefault();
      if (commitPreviewAmount()) previewNavigateAction(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });
}
