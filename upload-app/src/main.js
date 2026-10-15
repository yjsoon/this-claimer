import { initTheme, initAuthUi, checkAuth, hidePasswordPrompt, setOnAuthSuccess } from './lib/core.js';
import { initPreview } from './lib/preview.js?v=20260914-preview-review';
import { initWebMcp } from './webmcp.js';
import {
  initClaims,
  loadReceipts,
  loadYnabTodos,
  setOnClaimsLoadError,
} from './claims.js?v=20261015-gmail';
import { initGmail, loadGmailStatus, setOnGmailImported } from './gmail.js?v=20261015-gmail';
import {
  initInvoices,
  showInvoicesView,
  isInvoicesPath,
  navigateToMode,
  renderInvoiceClaimLoadError,
  renderInvoicesFromLoadedData,
} from './invoices.js?v=20261015-gmail';

initTheme();
initPreview();
initAuthUi();
initClaims();
initInvoices();
initGmail();
setOnGmailImported(() => loadReceipts());
setOnClaimsLoadError(renderInvoiceClaimLoadError);
void initWebMcp();

// Receipts and claims come from different backends, so fetch them together.
async function loadEverything() {
  await Promise.all([loadReceipts(), loadYnabTodos(), loadGmailStatus()]);
}

setOnAuthSuccess(async () => {
  await loadEverything();
  if (isInvoicesPath()) renderInvoicesFromLoadedData();
});

// Shows the right view (and, for Invoices, starts the Xero status check) once;
// the data render below happens after the loads finish.
showInvoicesView(isInvoicesPath(), { refresh: false });

async function init() {
  if (await checkAuth()) {
    hidePasswordPrompt();
    await loadEverything();
    const xeroJustConnected = new URLSearchParams(location.search).get('xero') === 'connected';
    if (xeroJustConnected) {
      navigateToMode(true, { replace: true, refresh: false });
      renderInvoicesFromLoadedData();
    } else if (isInvoicesPath()) {
      // Data is already loaded; render from it instead of fetching it all again.
      renderInvoicesFromLoadedData();
    }
  }
}

init();
