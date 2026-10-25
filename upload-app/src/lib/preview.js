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
const previewAmount = document.getElementById('previewAmount');
const previewReviewBtn = document.getElementById('previewReviewBtn');
let previewReviewAction = null;
let previewNavigateAction = null;
let previewReviewed = false;
let previewRequest = 0;

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

export async function openPreview(key, displayName, { amount = '', reviewed = false, onReview = null, onNavigate = null } = {}) {
  const request = ++previewRequest;
  clearPreviewMedia();
  previewFilename.textContent = displayName;
  previewSpinner.classList.add('loading');
  previewReviewAction = typeof onReview === 'function' ? onReview : null;
  previewNavigateAction = typeof onNavigate === 'function' ? onNavigate : null;
  updatePreviewReview(reviewed);
  previewAmount.textContent = amount;
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

    const blob = await response.blob();
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

function closePreview() {
  const request = ++previewRequest;
  previewOverlay.classList.remove('active');
  previewOverlay.classList.remove('has-review-action');
  previewSpinner.classList.remove('loading');
  document.body.style.overflow = '';
  previewReviewAction = null;
  previewNavigateAction = null;
  previewReview.hidden = true;
  setTimeout(() => {
    if (request === previewRequest) clearPreviewMedia();
  }, 250);
}

export function initPreview() {
  previewClose.addEventListener('click', closePreview);
  previewBackdrop.addEventListener('click', closePreview);
  previewReviewBtn.addEventListener('click', () => {
    if (!previewReviewAction) return;
    previewReviewAction(true);
    closePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (!previewOverlay.classList.contains('active')) return;
    if (e.key === 'Escape') {
      closePreview();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Enter' && previewReviewAction) {
      e.preventDefault();
      if (e.repeat) return;
      previewReviewAction(!previewReviewed);
      updatePreviewReview(!previewReviewed);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && previewNavigateAction) {
      e.preventDefault();
      previewNavigateAction(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });
}
