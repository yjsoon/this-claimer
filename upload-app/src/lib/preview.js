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

export async function openPreview(key, displayName, { amount = '', onReview = null } = {}) {
  previewFilename.textContent = displayName;
  previewImage.classList.remove('visible');
  previewPdf.classList.remove('visible');
  previewSpinner.classList.add('loading');
  previewReviewAction = typeof onReview === 'function' ? onReview : null;
  previewAmount.textContent = amount;
  previewReview.hidden = !previewReviewAction;
  previewOverlay.classList.toggle('has-review-action', Boolean(previewReviewAction));
  previewOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';

  const url = `${API_BASE}/receipt/${encodeURIComponent(key)}`;
  const isPdf = key.toLowerCase().endsWith('.pdf');

  try {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error('Failed to load');

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    if (isPdf) {
      previewPdf.src = blobUrl;
      previewPdf.onload = () => {
        previewSpinner.classList.remove('loading');
        previewPdf.classList.add('visible');
      };
    } else {
      previewImage.src = blobUrl;
      previewImage.onload = () => {
        previewSpinner.classList.remove('loading');
        previewImage.classList.add('visible');
      };
    }
  } catch (err) {
    previewSpinner.classList.remove('loading');
    previewFilename.textContent = `${displayName} (failed to load)`;
    console.error('Preview failed:', err);
  }
}

function closePreview() {
  previewOverlay.classList.remove('active');
  previewOverlay.classList.remove('has-review-action');
  document.body.style.overflow = '';
  previewReviewAction = null;
  previewReview.hidden = true;
  setTimeout(() => {
    if (previewImage.src.startsWith('blob:')) URL.revokeObjectURL(previewImage.src);
    if (previewPdf.src.startsWith('blob:')) URL.revokeObjectURL(previewPdf.src);
    previewImage.src = '';
    previewPdf.src = '';
    previewImage.classList.remove('visible');
    previewPdf.classList.remove('visible');
  }, 250);
}

export function initPreview() {
  previewClose.addEventListener('click', closePreview);
  previewBackdrop.addEventListener('click', closePreview);
  previewReviewBtn.addEventListener('click', () => {
    if (!previewReviewAction) return;
    previewReviewAction();
    closePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && previewOverlay.classList.contains('active')) {
      closePreview();
    }
  });
}
