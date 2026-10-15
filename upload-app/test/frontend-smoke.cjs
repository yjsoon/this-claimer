const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..', 'src');
const port = 8789;
const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
};

const receiptsPageOne = [
  {
    key: 'receipt-1.pdf',
    originalName: 'Receipt One.pdf',
    uploaded: '2026-06-24T00:00:00Z',
    linkedClaimIds: [],
    taggedAmount: 12.34,
    taggedCurrency: 'SGD',
    taggedVendor: 'Vendor A',
    taggedPurpose: 'Software',
    taggedGstShown: false,
    detectedReceiptDate: '2026-06-24',
  },
  {
    key: 'receipt-2.pdf',
    originalName: 'Invoice Line.pdf',
    uploaded: '2026-06-25T00:00:00Z',
    linkedClaimIds: ['claim-1'],
    linkedClaimsBackend: 'howmuch',
    taggedAmount: 50,
    taggedCurrency: 'MYR',
    taggedAmountSgdApprox: 15,
    taggedVendor: 'Vendor B',
    taggedPurpose: 'Subscription',
    taggedGstShown: false,
    xeroPendingInvoiceId: 'pending-bill-1',
    xeroPendingInvoiceNumber: 'DRAFT-1',
    xeroPendingClaimsBackend: 'howmuch',
  },
];

const receiptsPageTwo = [
  {
    key: 'receipt-3.pdf',
    originalName: 'Paged Receipt.pdf',
    uploaded: '2026-06-26T00:00:00Z',
    linkedClaimIds: [],
    taggedAmount: 7,
    taggedCurrency: 'SGD',
    taggedVendor: 'Vendor C',
    taggedPurpose: 'Tooling',
    taggedGstShown: false,
  },
  {
    key: 'receipt-4.pdf',
    originalName: 'Already Claimed.pdf',
    uploaded: '2026-06-27T00:00:00Z',
    linkedClaimIds: ['claim-archived'],
    taggedAmount: 20,
    taggedCurrency: 'SGD',
    taggedVendor: 'Vendor D',
    taggedPurpose: 'Archived claim',
    taggedGstShown: false,
    xeroInvoiceId: 'xero-invoice-1',
  },
];

const todos = [
  {
    id: 'claim-1',
    date: '2026-06-25',
    payee: 'Vendor B',
    description: 'Subscription',
    amount: 15,
    accountName: 'Work Refundables',
    sourceUrl: 'https://howmuch.example/transactions?plan=plan-1&transaction=claim-1',
  },
  {
    id: 'claim-2',
    date: '2026-06-24',
    payee: 'Vendor A',
    description: 'Software',
    amount: 12.34,
    accountName: 'Work Refundables',
  },
  {
    id: 'claim-hidden-transfer',
    date: '2026-06-24',
    payee: 'Transfer: Work Refundables',
    description: 'Transfer duplicate',
    amount: 12.34,
    accountName: 'Work Refundables',
  },
];

const server = http.createServer((req, res) => {
  let pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/' || pathname === '/invoices' || pathname === '/invoices/') {
    pathname = '/index.html';
  }

  const file = path.join(root, pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

async function main() {
  await new Promise((resolve) => server.listen(port, resolve));
  const browser = await chromium.launch({ headless: true });
  let uploadCount = 0;
  const markClaimRequests = [];
  const linkRequests = [];
  const pendingClearRequests = [];
  const receiptDeletes = [];
  const invoiceUnlinkRequests = [];
  const todoBackends = [];

  async function setupMockApi(page, mockState = {}) {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const isAuthed = route.request().headers()['x-auth-token'] === 'test';

      if (url.pathname === '/list') {
        if (!isAuthed) return route.fulfill({ status: 401, json: { error: 'unauthorised' } });
        if (mockState.failReceiptList) return route.fulfill({ status: 500, json: { error: 'list unavailable' } });
        const cursor = url.searchParams.get('cursor');
        const body = cursor === 'page-2'
          ? { receipts: receiptsPageTwo, hasMore: false }
          : { receipts: receiptsPageOne, hasMore: true, cursor: 'page-2' };
        return route.fulfill({ json: body });
      }

      if (url.pathname === '/upload') {
        uploadCount += 1;
        return route.fulfill({ json: { success: true, key: 'blob.png' } });
      }

      if (url.pathname === '/ynab/todos') {
        const backend = url.searchParams.get('backend');
        todoBackends.push(backend);
        if (mockState.delayedBackend === backend) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const responseTodos = mockState.labelByBackend
          ? todos.map((todo) => ({ ...todo, description: `${backend}: ${todo.description}` }))
          : todos;
        return route.fulfill({ json: { todos: responseTodos, backend } });
      }
      if (url.pathname.startsWith('/receipt/') && route.request().method() === 'DELETE' && !url.pathname.endsWith('/link')) {
        receiptDeletes.push(url.pathname);
        return route.fulfill({ status: 500, json: { error: 'must not delete receipt files' } });
      }
      if (url.pathname.startsWith('/receipt/') && url.pathname.endsWith('/link') && route.request().method() === 'DELETE') {
        invoiceUnlinkRequests.push(url.pathname);
        return route.fulfill({ json: { success: true } });
      }
      if (url.pathname.startsWith('/receipt/') && url.pathname.endsWith('/xero-pending') && route.request().method() === 'PATCH') {
        const key = decodeURIComponent(url.pathname.slice('/receipt/'.length, -'/xero-pending'.length));
        const body = JSON.parse(route.request().postData() || '{}');
        pendingClearRequests.push({ key, body });
        const receipt = [...receiptsPageOne, ...receiptsPageTwo].find((item) => item.key === key);
        if (receipt && body.clear === true) {
          delete receipt.xeroPendingInvoiceId;
          delete receipt.xeroPendingInvoiceNumber;
          delete receipt.xeroPendingClaimsBackend;
        }
        return route.fulfill({ json: { success: true, key, cleared: ['xeroPendingInvoiceId', 'xeroPendingInvoiceNumber', 'xeroPendingAt', 'xeroPendingClaimsBackend'] } });
      }
      if (url.pathname.startsWith('/receipt/') && url.pathname.endsWith('/link') && route.request().method() === 'PATCH') {
        const key = decodeURIComponent(url.pathname.slice('/receipt/'.length, -'/link'.length));
        const body = JSON.parse(route.request().postData() || '{}');
        const linkedIds = Array.isArray(body.linkedClaims)
          ? body.linkedClaims.map((claim) => claim.id).filter(Boolean)
          : [];
        const receipt = [...receiptsPageOne, ...receiptsPageTwo].find((item) => item.key === key);
        if (receipt) {
          receipt.linkedClaimIds = linkedIds;
          receipt.linkedClaimId = linkedIds[0] || undefined;
          receipt.linkedClaimsBackend = body.backend;
        }
        linkRequests.push({ key, linkedIds, backend: body.backend });
        return route.fulfill({ json: { success: true } });
      }
      if (url.pathname === '/ai/settings') {
        return route.fulfill({ json: { providers: [], visionProvider: 'minimax', claudeModel: 'claude-opus-5-5', claudeModels: [] } });
      }
      if (url.pathname === '/xero/status') return route.fulfill({ json: { connected: true, tenantName: 'Test Xero' } });
      if (url.pathname === '/xero/meta') {
        return route.fulfill({
          json: {
            accounts: [
              { code: '999', name: 'Zulu Expenses' },
              { code: '463', name: 'Computer Software' },
              { code: '111', name: 'alpha Expenses' },
            ],
            taxRates: [
              { taxType: 'INPUTY24', name: 'Standard-Rated Purchases' },
              { taxType: 'NONE', name: 'No Tax' },
              { taxType: 'NRINPUT', name: 'Purchases from Non-GST Registered Suppliers' },
              { taxType: 'OPINPUT', name: 'Out Of Scope Purchases' },
            ],
          },
        });
      }
      if (url.pathname === '/xero/invoices/mark-claimed') {
        const body = JSON.parse(route.request().postData() || '{}');
        markClaimRequests.push(body);
        if (mockState.delayMarkClaimed) await new Promise((resolve) => setTimeout(resolve, 100));
        return route.fulfill({
          json: {
            success: true,
            claimedDate: '2026-07-02',
            taggedReceipts: [{ key: 'receipt-2.pdf', status: 'tagged' }],
            claimedYnab: [{ id: 'claim-1', status: 'claimed' }],
          },
        });
      }
      if (url.pathname === '/amount-tags/pending') return route.fulfill({ json: { processed: 0, remaining: 0, tagged: 0 } });
      return route.continue();
    });
  }

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // Exercise both experimental API locations using a registration harness.
  // The rest of this suite runs without WebMCP, covering progressive enhancement.
  for (const apiOwner of ['document', 'navigator']) {
    const toolPage = await browser.newPage();
    await toolPage.addInitScript((owner) => {
      window.registeredTools = {};
      Object.defineProperty(document, 'modelContext', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'modelContext', { value: undefined, configurable: true });
      Object.defineProperty(owner === 'document' ? document : navigator, 'modelContext', {
        value: { registerTool(tool) { window.registeredTools[tool.name] = tool; } },
      });
    }, apiOwner);
    await setupMockApi(toolPage);
    await toolPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await toolPage.waitForFunction(() => Object.keys(window.registeredTools).length === 3);
    assert.equal(await toolPage.getByLabel('Password', { exact: true }).count(), 1);
    assert.equal(await toolPage.getByLabel('Upload receipts', { exact: true }).count(), 1);
    assert.equal(await toolPage.getByTitle('Receipt PDF preview', { exact: true }).count(), 1);
    const call = (name, input) => toolPage.evaluate(async ({ name, input }) => {
      return window.registeredTools[name].execute(input);
    }, { name, input });
    const unpack = (result) => {
      assert.notEqual(result.isError, true, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const requests = [];
    toolPage.on('request', request => requests.push({ method: request.method(), url: new URL(request.url()) }));
    assert.equal((await call('list_receipts', {})).isError, true);
    assert.equal(requests.length, 0, 'logged-out tools must not fetch');
    await toolPage.evaluate(() => sessionStorage.setItem('claim_manager_auth', 'test'));
    for (const invalid of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '2' }, { cursor: 2 }, { extra: true }, { toString: 'x' }]) {
      assert.equal((await call('list_receipts', invalid)).isError, true);
    }
    for (const invalid of [{}, { backend: 'other' }, { backend: 'ynab&write=true' }]) {
      assert.equal((await call('list_pending_claims', invalid)).isError, true);
    }
    assert.equal(requests.length, 0, 'invalid input must not fetch');
    const first = unpack(await call('list_receipts', { limit: 1 }));
    assert.equal(first.receipts[0].key, 'receipt-1.pdf');
    assert.equal(first.nextCursor, 'page-2');
    assert.equal(requests.at(-1).url.searchParams.get('limit'), '1');
    const second = unpack(await call('list_receipts', { limit: 100, cursor: first.nextCursor }));
    assert.equal(second.receipts[0].key, 'receipt-3.pdf');
    assert.equal(second.nextCursor, null);
    assert.equal(requests.at(-1).url.searchParams.get('limit'), '100');
    for (const backend of ['ynab', 'howmuch']) {
      const claims = unpack(await call('list_pending_claims', { backend }));
      assert.equal(claims.backend, backend);
      assert.equal(claims.claims[1].amount, 12.34);
      assert.equal(claims.amountUnit, 'dollars');
      assert.equal(claims.claims.length, 3, 'hidden transfer must not disappear');
    }
    assert.deepEqual(unpack(await call('get_xero_status', {})), { connected: true, tenantName: 'Test Xero' });
    assert(requests.every(request => request.method === 'GET'), 'read tools must never write');
    assert(requests.every(request => ['/list', '/ynab/todos', '/xero/status'].includes(request.url.pathname)));
    const failureRoute = '**/list?*';
    await toolPage.route(failureRoute, route => route.fulfill({ status: 503, body: 'secret-upstream-detail' }));
    const failure = await call('list_receipts', {});
    assert.equal(failure.isError, true);
    assert(!JSON.stringify(failure).includes('secret-upstream-detail'));
    await toolPage.unroute(failureRoute);
    await toolPage.route('**/ynab/todos?*', route => route.fulfill({ json: { backend: 'howmuch', todos: [] } }));
    assert.equal((await call('list_pending_claims', { backend: 'ynab' })).isError, true);
    for (const backend of ['ynab', 'howmuch']) {
      await toolPage.route('**/ynab/todos?*', route => route.fulfill({
        status: 401,
        json: { error: backend === 'ynab' ? 'YNAB API error' : 'HowMuch API error', details: 'private upstream details' },
      }));
      const upstreamFailure = await call('list_pending_claims', { backend });
      assert.equal(upstreamFailure.isError, true);
      assert(!JSON.stringify(upstreamFailure).includes('private upstream details'));
      assert.equal(await toolPage.evaluate(() => sessionStorage.getItem('claim_manager_auth')), 'test',
        'upstream 401 must preserve valid app authentication');
      assert.equal(unpack(await call('list_receipts', {})).receipts[0].key, 'receipt-1.pdf');
    }
    await toolPage.route(failureRoute, route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
    assert.equal((await call('list_receipts', {})).isError, true);
    assert.equal(await toolPage.evaluate(() => sessionStorage.getItem('claim_manager_auth')), null);
    assert.equal(await toolPage.getByLabel('Password', { exact: true }).isVisible(), true);
    await toolPage.close();
  }
  todoBackends.length = 0;
  console.log('WebMCP browser contract passed (both API locations, auth, validation, pagination, backend isolation, read-only requests)');
  const failedSubresources = [];
  page.on('response', (response) => {
    const type = response.request().resourceType();
    if (response.status() >= 400 && ['document', 'script', 'stylesheet'].includes(type)) {
      failedSubresources.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.addInitScript(() => {
    localStorage.setItem('claim_manager_auth', 'test');
    localStorage.setItem('claim_manager_remember', 'true');
    localStorage.setItem('claim_manager_claim_filter', JSON.stringify({
      text: '',
      quickFilters: ['Transfer'],
    }));
  });
  const primaryMockState = {};
  await setupMockApi(page, primaryMockState);

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  if (await page.locator('#claimsBackend').inputValue() !== 'howmuch') {
    throw new Error('HowMuch should be the default claims backend');
  }
  if (todoBackends[0] !== 'howmuch') throw new Error(`expected HowMuch request, got ${todoBackends[0]}`);
  primaryMockState.delayedBackend = 'ynab';
  primaryMockState.labelByBackend = true;
  await page.locator('#claimsBackend').selectOption('ynab');
  if (await page.locator('#matchReviewSection').isVisible()) {
    throw new Error('backend change should immediately invalidate stale match suggestions');
  }
  if (await page.locator('.linked-pair-unlink').count() !== 0) {
    throw new Error('backend change should immediately remove stale unlink actions');
  }
  await page.locator('#claimsBackend').selectOption('howmuch');
  await page.waitForTimeout(250);
  const visibleBackendClaim = await page.locator('#todoList .todo-item[data-claim-id="claim-2"] .todo-payee').textContent();
  if (visibleBackendClaim !== 'howmuch: Software') {
    throw new Error(`stale backend response replaced current claims: ${visibleBackendClaim}`);
  }
  primaryMockState.delayedBackend = null;
  primaryMockState.labelByBackend = false;
  await page.locator('#claimsBackend').selectOption('ynab');
  await page.locator('#claimsBackend').selectOption('howmuch');
  if (!todoBackends.includes('ynab')) throw new Error('backend selector did not request YNAB');
  await page.waitForSelector('#matchReviewSection:not([hidden]) .match-review-item');
  const matchCountText = await page.locator('#matchReviewCount').textContent();
  if (matchCountText !== '(1)') throw new Error(`expected one match suggestion, got ${matchCountText}`);
  const matchKindText = await page.locator('.match-review-item .match-review-chip').textContent();
  if (matchKindText !== 'Ambiguous') {
    throw new Error(`hidden matching claims must still make a suggestion ambiguous, got ${matchKindText}`);
  }
  if (await page.locator('#acceptAllClearBtn').isVisible()) {
    throw new Error('hidden matching claims must prevent bulk acceptance');
  }
  await page.locator('.match-review-item .match-reject-btn').click();
  await page.waitForFunction(() => document.querySelectorAll('#matchReviewList .match-review-item').length === 0);
  await page.locator('#findMatchesBtn').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('No matches'));
  await page.locator('#clearDismissedMatchesBtn').click();
  await page.waitForSelector('#matchReviewSection:not([hidden]) .match-review-item');
  // Leave the suggestion in place for now so invoice counts stay stable; Change opens claim-link flow.
  await page.locator('.match-review-item .match-change-btn').click();
  await page.waitForSelector('#linkingDock:not([hidden])');
  const receiptChecked = await page.locator('#receiptList li[data-key="receipt-1.pdf"]').evaluate((el) => el.classList.contains('checked'));
  if (!receiptChecked) throw new Error('Change should pre-select the suggested receipt');
  await page.locator('#cancelSelection').click();

  await page.locator('.tab-btn[data-tab="receipts"]').click();
  await page.waitForSelector('#receiptList li[data-key="receipt-3.pdf"]', { state: 'attached' });

  const countText = await page.locator('#count').textContent();
  if (countText !== '(2)') throw new Error(`expected paginated receipts to load, got count ${countText}`);
  const readyCountText = await page.locator('#linkedCount').textContent();
  if (readyCountText !== '(1)') throw new Error(`invoiced receipts should not count as ready, got ${readyCountText}`);
  const invoiceBadgeText = await page.locator('#invoicesNavBadge').textContent();
  if (invoiceBadgeText !== '1') throw new Error(`invoice badge should ignore invoiced receipts, got ${invoiceBadgeText}`);
  const invoicedReadyVisible = await page.locator('#linkedList li[data-receipt-key="receipt-4.pdf"]').count();
  if (invoicedReadyVisible !== 0) throw new Error('invoiced receipt should not appear in Ready to Claim');

  const compact = await page.locator('#dropzone').evaluate((el) => el.classList.contains('is-compact'));
  if (!compact) throw new Error('dropzone did not compact with outstanding work');

  await page.locator('#fileInput').setInputFiles({
    name: 'blob',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  await page.waitForFunction(() => document.querySelector('#status')?.classList.contains('success'));
  if (uploadCount !== 1) throw new Error('extensionless image upload was not attempted');

  await page.locator('#fileInput').setInputFiles({
    name: 'receipt.exe',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  await page.waitForFunction(() => document.querySelector('#status')?.classList.contains('error'));
  if (uploadCount !== 1) throw new Error('disallowed extension should fail before upload');

  await page.locator('#receiptList li[data-key="receipt-1.pdf"] .link-btn').click();
  await page.waitForSelector('#linkingDock:not([hidden])');
  await page.locator('#todoList .todo-item[data-claim-id="claim-2"]').click();
  const confirmVisible = await page.locator('#confirmSelection:not([hidden])').isVisible();
  if (!confirmVisible) throw new Error('link confirm button did not become visible');
  await page.locator('#cancelSelection').click();

  await page.locator('#findMatchesBtn').click();
  await page.waitForSelector('#matchReviewSection:not([hidden]) .match-accept-btn');
  await page.locator('.match-review-item .match-accept-btn').click();
  await page.waitForFunction(() => document.querySelector('#matchReviewSection')?.hidden);
  if (linkRequests.length !== 1 || linkRequests[0].key !== 'receipt-1.pdf' || linkRequests[0].linkedIds[0] !== 'claim-2') {
    throw new Error(`expected accept to link receipt-1 to claim-2, got ${JSON.stringify(linkRequests)}`);
  }
  if (linkRequests[0].backend !== 'howmuch') throw new Error('linked receipt should retain HowMuch provenance');

  // Restore unlinked state for invoice tests that expect the original ready set.
  const receiptOne = receiptsPageOne.find((item) => item.key === 'receipt-1.pdf');
  if (receiptOne) {
    receiptOne.linkedClaimIds = [];
    delete receiptOne.linkedClaimId;
  }

  await page.goto(`http://127.0.0.1:${port}/invoices/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  const sectionTitle = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-section-title').textContent();
  if (sectionTitle.trim() !== 'Non-GST') {
    throw new Error(`invoice section title should be the bucket name only, got: ${sectionTitle}`);
  }
  const invoicesCopy = await page.locator('#invoicesView').innerText();
  if (/\bin Xero\b/i.test(invoicesCopy) || /still TODO/i.test(invoicesCopy) || /not yet pushed/i.test(invoicesCopy)) {
    throw new Error(`invoices view must not invent an in-Xero status, got: ${invoicesCopy}`);
  }
  const intro = await page.locator('.invoices-intro').textContent();
  if (!intro.includes('still here, it is not claimed') || !intro.includes('TODO')) {
    throw new Error(`invoice intro should say listed lines are not claimed, got: ${intro}`);
  }
  if (await page.locator('.invoice-section[data-bucket="nongst"] .inv-draft-chip, .invoice-section[data-bucket="nongst"] .inv-ready-chip').count()) {
    throw new Error('pending metadata must not appear as a status chip');
  }
  const meta = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-section-meta').textContent();
  if (!meta.includes('1 bill lines') || !meta.includes('0/1 reviewed') || /in Xero/i.test(meta)) {
    throw new Error(`unexpected invoice meta: ${meta}`);
  }
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.invoice-section[data-bucket="nongst"] .invoice-clear-stamps-btn').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Cleared leftover draft stamps'));
  if (pendingClearRequests.length !== 1 || pendingClearRequests[0].key !== 'receipt-2.pdf' || pendingClearRequests[0].body.clear !== true) {
    throw new Error(`expected one PATCH xero-pending clear, got ${JSON.stringify(pendingClearRequests)}`);
  }
  if (receiptDeletes.length) {
    throw new Error(`must never DELETE receipt files, got ${receiptDeletes.join(', ')}`);
  }
  // The success status is shown before the view refreshes, so wait for the re-render.
  const stampsCleared = await page.waitForFunction(
    () => !document.querySelector('.invoice-section[data-bucket="nongst"] .invoice-clear-stamps-btn'),
    null,
    { timeout: 5000 },
  ).then(() => true, () => false);
  if (!stampsCleared) {
    throw new Error('clear-stamps control should hide after leftover metadata is gone');
  }
  const invoiceReceipt = receiptsPageOne.find((item) => item.key === 'receipt-2.pdf');
  invoiceReceipt.xeroPendingInvoiceId = 'pending-bill-1';
  invoiceReceipt.xeroPendingInvoiceNumber = 'DRAFT-1';
  delete invoiceReceipt.xeroPendingClaimsBackend;
  await page.locator('#invoicesRefreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#invoicesSections')?.getAttribute('aria-busy') !== 'true');
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] .invoice-clear-stamps-btn');
  if (await page.locator('.invoice-section[data-bucket="nongst"] tr[data-id]').count() !== 1) {
    throw new Error('a leftover stamp without xeroPendingClaimsBackend must not hide a HowMuch-linked line');
  }

  const disabledBefore = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled();
  if (!disabledBefore) throw new Error('push should be disabled before review');

  const rowActions = page.locator('.invoice-section[data-bucket="nongst"] .inv-row-actions');
  assert.equal(
    await page.locator('.invoice-section[data-bucket="nongst"] thead th').first().textContent(),
    'Actions',
    'Actions should be the leftmost invoice column',
  );
  assert.equal(
    await page.locator('.invoice-section[data-bucket="nongst"] tbody tr[data-id] td').first().getAttribute('class'),
    'col-actions',
    'row actions should be in the leftmost cell',
  );
  const sourceLink = rowActions.locator('..').locator('.inv-source-link');
  assert.equal(await sourceLink.textContent(), 'HowMuch');
  assert.equal(await sourceLink.getAttribute('href'), 'https://howmuch.example/transactions?plan=plan-1&transaction=claim-1');
  assert.equal(await sourceLink.getAttribute('target'), '_blank');
  assert.equal(
    await page.locator('.invoice-section[data-bucket="nongst"] .inv-description-payee').textContent(),
    'Vendor B',
  );
  assert.equal(
    await page.locator('.invoice-section[data-bucket="nongst"] .inv-description-memo').evaluate((element) => element.closest('td')?.className),
    'inv-cell-memo',
    'Memo should have its own invoice field column',
  );
  assert.equal(
    await page.locator('.invoice-section[data-bucket="nongst"] .inv-description-memo').textContent(),
    'Subscription',
  );
  assert.equal(
    await page.locator('.invoice-section[data-bucket="nongst"] .inv-description-remark').textContent(),
    'Remark: MYR 50.00',
  );
  const memoCell = page.locator('.invoice-section[data-bucket="nongst"] .inv-cell-memo');
  const memoBoundsBeforeEdit = await memoCell.boundingBox();
  await memoCell.locator('.inv-description-memo').click();
  assert.equal(await memoCell.locator('.inv-edit-input').count(), 0, 'single-click should not edit memo');
  await memoCell.locator('.inv-description-memo').dblclick();
  await memoCell.locator('.inv-edit-input').waitFor();
  const memoBoundsDuringEdit = await memoCell.boundingBox();
  assert.ok(
    memoBoundsBeforeEdit && memoBoundsDuringEdit && Math.abs(memoBoundsBeforeEdit.width - memoBoundsDuringEdit.width) <= 1,
    `memo column should remain stable during editing: ${JSON.stringify({ memoBoundsBeforeEdit, memoBoundsDuringEdit })}`,
  );
  await page.keyboard.press('Escape');
  assert.deepEqual(
    await rowActions.locator('button').evaluateAll((buttons) => buttons.map((button) => button.className)),
    ['inv-preview-btn', 'inv-review-btn', 'inv-unlink-btn'],
    'preview, review, and unlink actions should be grouped in that order',
  );
  assert.equal(await rowActions.locator('.inv-unlink-btn').textContent(), '⛔');
  let unlinkConfirmShown = false;
  page.once('dialog', async (dialog) => {
    unlinkConfirmShown = true;
    await dialog.dismiss();
  });
  await rowActions.locator('.inv-unlink-btn').click();
  assert.equal(unlinkConfirmShown, true, 'unlink should require confirmation');
  assert.equal(invoiceUnlinkRequests.length, 0, 'canceling unlink must not send a request');

  const amountCell = page.locator('.invoice-section[data-bucket="nongst"] [data-field="amount"]');
  await amountCell.click();
  await amountCell.locator('input').fill('23.67');
  await rowActions.locator('.inv-preview-btn').click();
  await page.waitForSelector('#previewOverlay.active');
  assert.equal(await page.locator('#previewAmount').textContent(), 'S$23.67', 'preview should commit and show the active amount edit');
  await page.locator('#previewReviewBtn').click();
  await page.waitForSelector('#previewOverlay:not(.active)');
  const disabledAfter = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled();
  if (disabledAfter) throw new Error('preview check should review the line and enable push');

  let defaultBillReference = '';
  page.once('dialog', async (dialog) => {
    defaultBillReference = dialog.defaultValue();
    await dialog.dismiss();
  });
  await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').click();
  assert.equal(defaultBillReference, 'Non-GST - YJ Jun-Jun 2026', 'bill reference should use the claim type and month range');

  invoiceReceipt.linkedClaimsBackend = 'ynab';
  invoiceReceipt.xeroPendingClaimsBackend = 'ynab';
  await page.locator('#claimsBackend').selectOption('ynab');
  await page.locator('#invoicesRefreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#invoicesSections')?.getAttribute('aria-busy') !== 'true');
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  if (!await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled()) {
    throw new Error('saved HowMuch review must not apply to the same receipt and claim IDs in YNAB');
  }
  const persistedBackends = await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem('claim_manager_invoice_edits') || '{}');
    return {
      howmuch: store['howmuch::receipt-2.pdf::claim-1']?.claimsBackend,
      ynab: store['ynab::receipt-2.pdf::claim-1']?.claimsBackend,
    };
  });
  if (persistedBackends.howmuch !== 'howmuch' || persistedBackends.ynab !== undefined) {
    throw new Error(`invoice edit provenance crossed backends: ${JSON.stringify(persistedBackends)}`);
  }
  invoiceReceipt.linkedClaimsBackend = 'howmuch';
  invoiceReceipt.xeroPendingClaimsBackend = 'howmuch';
  await page.locator('#claimsBackend').selectOption('howmuch');
  await page.locator('#invoicesRefreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#invoicesSections')?.getAttribute('aria-busy') !== 'true');
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  if (await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled()) {
    const state = await page.evaluate(() => localStorage.getItem('claim_manager_invoice_edits'));
    const sectionMeta = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-section-meta').textContent();
    throw new Error(`HowMuch review should survive switching to YNAB and back: ${sectionMeta} ${state}`);
  }

  primaryMockState.delayedBackend = 'ynab';
  await page.locator('#claimsBackend').selectOption('ynab');
  if (await page.locator('.invoice-push-btn').count() !== 0) {
    throw new Error('backend change should immediately remove stale invoice actions');
  }
  await page.locator('#claimsBackend').selectOption('howmuch');
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  primaryMockState.delayedBackend = null;

  const accountText = await page.locator('.invoice-section[data-bucket="nongst"] [data-label="Account"] .inv-cell-text').textContent();
  if (accountText !== 'Computer Software - 463') throw new Error(`account label should be name-code, got ${accountText}`);
  await page.locator('.invoice-section[data-bucket="nongst"] [data-label="Account"]').click();
  const accountOptions = await page.locator('.invoice-section[data-bucket="nongst"] .inv-edit-select option').allTextContents();
  assert.deepEqual(accountOptions, [
    'alpha Expenses - 111',
    'Computer Software - 463',
    'Zulu Expenses - 999',
  ], 'invoice account options should be alphabetical by category name');
  await page.keyboard.press('Escape');

  await page.locator('.invoice-section[data-bucket="nongst"] .invoice-claim-checked-btn').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('do not have a remembered bill from a push in this browser'));
  if (markClaimRequests.length !== 0) {
    throw new Error('leftover xeroPending stamps must not be enough to mark claimed');
  }

  await page.evaluate(() => {
    localStorage.setItem('claim_manager_invoice_push_history', JSON.stringify({
      byLine: {
        'howmuch::receipt-2.pdf::claim-1': {
          invoiceID: 'session-bill-1',
          invoiceNumber: 'SESSION-1',
          claimsBackend: 'howmuch',
          bucket: 'nongst',
          savedAt: '2026-09-12T00:00:00Z',
        },
      },
    }));
  });

  primaryMockState.delayMarkClaimed = true;
  await page.locator('.invoice-section[data-bucket="nongst"] .invoice-claim-checked-btn').click();
  await page.locator('#claimsBackend').selectOption('ynab');
  await page.locator('#claimsBackend').selectOption('howmuch');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Marked 1 checked Non-GST item claimed'));
  if (markClaimRequests.length !== 1) throw new Error(`expected one mark-claimed request, got ${markClaimRequests.length}`);
  if (markClaimRequests[0].invoiceID !== 'session-bill-1') {
    throw new Error(`mark claimed should use this browser's remembered push, got ${markClaimRequests[0].invoiceID}`);
  }
  if (markClaimRequests[0].backend !== 'howmuch') {
    throw new Error(`mark claimed should use HowMuch, got ${markClaimRequests[0].backend}`);
  }
  if (markClaimRequests[0].lineItems[0].claimsBackend !== 'howmuch') {
    throw new Error(`mark claimed line should retain HowMuch provenance, got ${markClaimRequests[0].lineItems[0].claimsBackend}`);
  }
  if (markClaimRequests[0].lineItems[0].claimDescription !== 'Subscription') {
    throw new Error(`mark claimed line should retain the original claim description, got ${markClaimRequests[0].lineItems[0].claimDescription}`);
  }
  primaryMockState.delayMarkClaimed = false;

  let taxCell = page.locator('.invoice-section[data-bucket="nongst"] [data-label="Tax"]');
  const taxText = await taxCell.locator('.inv-cell-text').textContent();
  if (!taxText.startsWith('OPINPUT')) throw new Error(`foreign non-GST tax type should be OPINPUT, got ${taxText}`);

  await taxCell.click();
  const taxOptions = await taxCell.locator('select option').evaluateAll((options) => options.map((option) => option.value));
  if (taxOptions.join(',') !== 'NRINPUT,INPUTY24,OPINPUT') {
    throw new Error(`tax type dropdown should only show purchase tax types, got ${taxOptions.join(',')}`);
  }
  await page.keyboard.press('Escape');
  await taxCell.locator('.inv-cell-text').waitFor();

  await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem('claim_manager_invoice_edits') || '{}');
    const entry = store['howmuch::receipt-2.pdf::claim-1'];
    if (!entry) throw new Error('missing persisted invoice review');
    entry.reviewedSourceSnapshot = {
      ...entry.reviewedSourceSnapshot,
      accountCode: '999',
      taxType: 'LEGACYTAX',
      section: 'gst',
    };
    localStorage.setItem('claim_manager_invoice_edits', JSON.stringify(store));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  const metaAfterReload = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-section-meta').textContent();
  if (!metaAfterReload.includes('1/1 reviewed')) {
    throw new Error(`review should survive legacy derived snapshot differences, got ${metaAfterReload}`);
  }
  const disabledAfterReload = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled();
  if (disabledAfterReload) throw new Error('push should remain enabled after legacy derived snapshot differences');

  const sortSelect = page.locator('.invoice-section[data-bucket="nongst"] .invoice-sort-select');
  await sortSelect.selectOption('date-desc');
  const storedSort = await page.evaluate(() => JSON.parse(localStorage.getItem('claim_manager_invoice_sorts') || '{}').nongst);
  if (storedSort !== 'date-desc') throw new Error(`invoice sort choice should persist, got ${storedSort}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  const selectedSort = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-sort-select').inputValue();
  if (selectedSort !== 'date-desc') throw new Error(`invoice sort choice should restore after reload, got ${selectedSort}`);

  taxCell = page.locator('.invoice-section[data-bucket="nongst"] [data-label="Tax"]');
  await taxCell.click();
  await taxCell.locator('select').selectOption('NRINPUT');
  const editedTaxText = await taxCell.locator('.inv-cell-text').textContent();
  if (!editedTaxText.startsWith('NRINPUT')) throw new Error(`tax type should be editable to NRINPUT, got ${editedTaxText}`);

  // A hand edit is the reviewer's own decision: the line stays reviewed, the
  // stored snapshot follows the edit, and that survives a reload.
  const disabledAfterTaxEdit = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled();
  if (disabledAfterTaxEdit) throw new Error('editing the tax type must not untick a reviewed line');
  if (await page.locator('.invoice-section[data-bucket="nongst"] .inv-row-note').count() !== 0) {
    throw new Error('a hand edit must not show the "data changed" notice');
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  if (await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled()) {
    throw new Error('review after a hand edit should survive reload');
  }
  // Source data changing underneath a reviewed line still invalidates it.
  invoiceReceipt.taggedAmount = 51;
  invoiceReceipt.taggedAmountSgdApprox = 16;
  todos.find((todo) => todo.id === 'claim-1').amount = 16;
  await page.locator('#invoicesRefreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#invoicesSections')?.getAttribute('aria-busy') !== 'true');
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  if (await page.locator('.invoice-section[data-bucket="nongst"] .inv-row-note').count() !== 1) {
    throw new Error('a claim amount change should flag the reviewed line');
  }
  if (!await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled()) {
    throw new Error('push should be disabled after source data changed');
  }
  if (failedSubresources.length > 0) throw new Error(`subresource load failures: ${failedSubresources.join(', ')}`);

  const initialLoadingPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await initialLoadingPage.addInitScript(() => {
    localStorage.setItem('claim_manager_auth', 'test');
    localStorage.setItem('claim_manager_remember', 'true');
  });
  await setupMockApi(initialLoadingPage, { delayedBackend: 'howmuch' });
  await initialLoadingPage.goto(`http://127.0.0.1:${port}/invoices`, { waitUntil: 'domcontentloaded' });
  if (!await initialLoadingPage.locator('#invoicesLoading').isVisible()) {
    throw new Error('initial Invoices load should show its loading state');
  }
  if (await initialLoadingPage.locator('#invoicesEmpty').isVisible()) {
    throw new Error('Invoices empty state must stay hidden until initial data finishes loading');
  }
  await initialLoadingPage.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');

  const authPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await setupMockApi(authPage);
  await authPage.goto(`http://127.0.0.1:${port}/invoices`, { waitUntil: 'networkidle' });
  await authPage.locator('#passwordInput').fill('test');
  await authPage.locator('#authSubmit').click();
  await authPage.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');

  const receiptFailurePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await receiptFailurePage.addInitScript(() => {
    localStorage.setItem('claim_manager_auth', 'test');
    localStorage.setItem('claim_manager_remember', 'true');
    localStorage.setItem('claim_manager_rejected_matches', JSON.stringify(['claim-2::receipt-1.pdf']));
  });
  const receiptFailureState = { failReceiptList: false };
  await setupMockApi(receiptFailurePage, receiptFailureState);
  await receiptFailurePage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await receiptFailurePage.waitForSelector('#matchReviewSection:not([hidden]) .match-review-item');
  receiptFailureState.failReceiptList = true;
  await receiptFailurePage.locator('#refreshBtn').click();
  await receiptFailurePage.waitForSelector('#receiptList .empty-state', { state: 'attached' });
  await receiptFailurePage.waitForFunction(() => (
    document.querySelectorAll('#matchReviewList .match-review-item').length === 0
  ));
  await receiptFailurePage.waitForTimeout(250);
  const rejectedAfterListFailure = await receiptFailurePage.evaluate(() => (
    JSON.parse(localStorage.getItem('claim_manager_rejected_matches') || '[]')
  ));
  if (rejectedAfterListFailure.join(',') !== 'claim-2::receipt-1.pdf') {
    throw new Error('failed receipt loads must not erase dismissed matches');
  }

  const desktopPage = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await desktopPage.addInitScript(() => {
    localStorage.setItem('claim_manager_auth', 'test');
    localStorage.setItem('claim_manager_remember', 'true');
  });
  await setupMockApi(desktopPage);
  await desktopPage.goto(`http://127.0.0.1:${port}/invoices`, { waitUntil: 'networkidle' });
  const invoiceContainerWidth = await desktopPage.locator('.container').evaluate((element) => element.getBoundingClientRect().width);
  assert.equal(invoiceContainerWidth, 1240, 'Invoices should use the shared desktop container width');
  const desktopRow = desktopPage.locator('.invoice-section[data-bucket="nongst"] tr[data-id]');
  const rowLayout = () => desktopRow.evaluate((row) => ({
    height: row.getBoundingClientRect().height,
    cells: [...row.children].map((cell) => {
      const { x, width } = cell.getBoundingClientRect();
      return { x, width };
    }),
  }));
  const desktopViewLayout = await rowLayout();
  await desktopRow.locator('.inv-description-memo').dblclick();
  await desktopRow.locator('.inv-edit-input').waitFor();
  const desktopEditLayout = await rowLayout();
  assert.ok(Math.abs(desktopViewLayout.height - desktopEditLayout.height) <= 1, 'Memo editing should not change row height');
  assert.deepEqual(desktopEditLayout.cells, desktopViewLayout.cells, 'Memo editing should not move or resize invoice columns');
  await desktopPage.keyboard.press('Escape');
  await desktopPage.locator('#navClaims').click();
  const claimsContainerWidth = await desktopPage.locator('.container').evaluate((element) => element.getBoundingClientRect().width);
  assert.equal(claimsContainerWidth, 1240, 'Claims should share the same desktop width as Invoices so the layout does not jump between tabs');

  const shortPage = await browser.newPage({ viewport: { width: 568, height: 390 } });
  await shortPage.addInitScript(() => {
    localStorage.setItem('claim_manager_auth', 'test');
    localStorage.setItem('claim_manager_remember', 'true');
  });
  await setupMockApi(shortPage);
  await shortPage.goto(`http://127.0.0.1:${port}/invoices`, { waitUntil: 'networkidle' });
  await shortPage.locator('.invoice-section[data-bucket="nongst"] .inv-preview-btn').click();
  const shortReviewBounds = await shortPage.locator('#previewReviewBtn').boundingBox();
  if (!shortReviewBounds || shortReviewBounds.y < 0 || shortReviewBounds.y + shortReviewBounds.height > 390) {
    throw new Error(`preview review action must fit a short viewport: ${JSON.stringify(shortReviewBounds)}`);
  }
  await shortPage.locator('#previewReviewBtn').click();
  await shortPage.waitForSelector('#previewOverlay:not(.active)');

  const compactPage = await browser.newPage({ viewport: { width: 320, height: 700 } });
  await compactPage.addInitScript(() => {
    localStorage.setItem('claim_manager_auth', 'test');
    localStorage.setItem('claim_manager_remember', 'true');
  });
  await setupMockApi(compactPage);
  await compactPage.goto(`http://127.0.0.1:${port}/invoices`, { waitUntil: 'networkidle' });
  const compactLayout = await compactPage.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: innerWidth,
    themeRight: document.querySelector('#themeToggle')?.getBoundingClientRect().right || Infinity,
    backendVisible: Boolean(document.querySelector('#claimsBackend')?.getBoundingClientRect().width),
  }));
  if (compactLayout.bodyWidth > compactLayout.viewportWidth || compactLayout.themeRight > compactLayout.viewportWidth) {
    throw new Error(`320px header overflowed: ${JSON.stringify(compactLayout)}`);
  }
  if (!compactLayout.backendVisible) throw new Error('backend selector should be visible on compact Invoices view');

  await browser.close();
  server.close();
  console.log('frontend smoke passed');
}

main().catch(async (err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
