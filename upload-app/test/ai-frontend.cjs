// Browser test for the AI section of the Settings dialog and Claude-assisted Find matches, against a
// mocked API. Set SCREENSHOT_DIR to also save screenshots.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..', 'src');
const port = 8790;
const shots = process.env.SCREENSHOT_DIR;
const mime = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript' };

const server = http.createServer((req, res) => {
  let pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(root, pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const todos = [
  { id: 'c-clear', date: '2026-10-01', payee: 'Kopitiam', description: 'Team coffee', amount: 10, accountName: 'Work' },
  { id: 'c-grab', date: '2026-10-03', payee: 'GRAB*RIDES', description: 'Ride to client', amount: 42.8, accountName: 'Work' },
  { id: 'c-openai', date: '2026-10-05', payee: 'OPENAI *CHATGPT', description: 'ChatGPT', amount: 34.6, accountName: 'Work' },
];

function receipts() {
  return [
    { key: 'r-clear.pdf', originalName: 'kopitiam.pdf', uploaded: '2026-10-01T00:00:00Z', linkedClaimIds: [], taggedAmount: 10, taggedCurrency: 'SGD', detectedReceiptDate: '2026-10-01' },
    { key: 'r-grab.pdf', originalName: 'grab_2026-10-01_42.80.pdf', uploaded: '2026-10-04T00:00:00Z', linkedClaimIds: [], taggedAmount: 42.8, taggedCurrency: 'SGD', taggedVendor: 'Grab', detectedReceiptDate: '2026-10-01' },
    { key: 'r-openai.pdf', originalName: 'Receipt-2231.pdf', uploaded: '2026-10-06T00:00:00Z', linkedClaimIds: [], taggedAmount: 25, taggedCurrency: 'USD', taggedAmountSgdApprox: 33.51, taggedVendor: 'OpenAI', detectedReceiptDate: '2026-10-05' },
  ];
}

function settingsStatus(state) {
  const provider = (id, label) => {
    const app = state.keys[id];
    const secret = id === 'gemini' ? 'secret-gemini-0000' : null;
    const active = app || secret;
    return { id, label, configured: Boolean(active), source: app ? 'app' : secret ? 'secret' : null, hint: active ? `…${active.slice(-4)}` : null, secretAvailable: Boolean(secret) };
  };
  return {
    providers: [provider('anthropic', 'Claude (Anthropic)'), provider('minimax', 'MiniMax'), provider('gemini', 'Gemini')],
    visionProvider: state.visionProvider,
    claudeModel: state.claudeModel,
    claudeModels: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ],
  };
}

async function run(browser, { viewport, colorScheme, name, full }) {
  const state = { keys: {}, visionProvider: 'minimax', claudeModel: 'claude-opus-5-5' };
  const puts = [];
  const matchRequests = [];
  const linkRequests = [];
  let receiptData = receipts();
  let settingsGets = 0;
  let swapNextMatch = false;

  const page = await browser.newPage({ viewport, colorScheme });
  await page.addInitScript(() => {
    localStorage.setItem('claim_manager_auth', 'test');
    localStorage.setItem('claim_manager_remember', 'true');
    localStorage.setItem('claim_manager_backend', 'ynab');
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/list') return route.fulfill({ json: { receipts: receiptData, hasMore: false } });
    if (url.pathname === '/ynab/todos') return route.fulfill({ json: { todos, backend: 'ynab' } });
    if (url.pathname === '/xero/status') return route.fulfill({ json: { connected: true, tenantName: 'Test Xero' } });
    if (url.pathname === '/gmail/status') return route.fulfill({ json: { configured: false, accounts: [] } });
    if (url.pathname === '/ai/settings' && request.method() === 'GET') {
      settingsGets += 1;
      // The first load fails, as if the request raced sign-in; Find matches must retry it.
      if (settingsGets === 1) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      return route.fulfill({ json: settingsStatus(state) });
    }
    if (url.pathname === '/ai/settings' && request.method() === 'PUT') {
      const body = JSON.parse(request.postData() || '{}');
      puts.push(body);
      if (body.keys?.anthropic === 'sk-ant-wrong') return route.fulfill({ status: 400, json: { error: 'Anthropic rejected that key. Check it and try again.' } });
      Object.entries(body.keys || {}).forEach(([id, value]) => {
        if (value === null) delete state.keys[id];
        else state.keys[id] = value;
      });
      if (body.visionProvider) state.visionProvider = body.visionProvider;
      if (body.claudeModel) state.claudeModel = body.claudeModel;
      return route.fulfill({ json: settingsStatus(state) });
    }
    if (url.pathname === '/ai/match') {
      const body = JSON.parse(request.postData() || '{}');
      matchRequests.push(body);
      if (swapNextMatch) {
        swapNextMatch = false;
        return route.fulfill({
          json: { model: 'claude-opus-5-5', matches: [{ claimId: 'c-openai', receiptKey: 'r-grab.pdf', confidence: 0.6, reason: 'Swapped pick' }] },
        });
      }
      return route.fulfill({
        json: {
          model: 'claude-opus-5-5',
          matches: [
            { claimId: 'c-grab', receiptKey: 'r-grab.pdf', confidence: 0.85, reason: 'Same $42.80 Grab ride; receipt dated 2 days before the charge' },
            { claimId: 'c-openai', receiptKey: 'r-openai.pdf', confidence: 0.8, reason: 'USD 25 ChatGPT receipt ≈ S$34.60 with the card FX fee' },
          ],
        },
      });
    }
    if (url.pathname.endsWith('/link') && request.method() === 'PATCH') {
      const key = decodeURIComponent(url.pathname.slice('/receipt/'.length, -'/link'.length));
      const body = JSON.parse(request.postData() || '{}');
      linkRequests.push({ key, body });
      receiptData = receiptData.map((r) => (r.key === key ? { ...r, linkedClaimIds: body.linkedClaims.map((c) => c.id), linkedClaimsBackend: 'ynab' } : r));
      return route.fulfill({ json: { success: true } });
    }
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ status: 404, body: '' });
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  const findMatches = page.getByRole('button', { name: 'Find matches' });
  await findMatches.click();
  await page.getByText('Found 1 suggestion (1 clear, 0 ambiguous)').waitFor();
  assert.equal(settingsGets, 2, 'Find matches reloads AI settings that failed to load');
  assert.equal(matchRequests.length, 0, 'Find matches must not call Claude without a Claude key');

  // Settings dialog: add a Claude key (a rejected one first).
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.waitFor();
  await dialog.getByText('Worker secret · …0000').waitFor();
  await dialog.locator('#aiSettingsSection').scrollIntoViewIfNeeded();
  if (shots) await page.screenshot({ path: path.join(shots, `${name}-settings.png`) });
  await dialog.getByRole('button', { name: 'Add Claude (Anthropic) key' }).click();
  const keyInput = dialog.getByLabel('Claude (Anthropic) API key');
  await keyInput.fill('sk-ant-wrong');
  await keyInput.press('Enter');
  await dialog.getByText('Anthropic rejected that key').waitFor();
  assert.equal(await dialog.isVisible(), true, 'Enter in the key field must not close the dialog');
  await keyInput.fill('sk-ant-api03-test-key-abcd');
  await dialog.getByRole('button', { name: 'Save Claude (Anthropic) key' }).click();
  await dialog.getByText('Saved here · …abcd').waitFor();
  if (shots) await page.screenshot({ path: path.join(shots, `${name}-settings-saved.png`) });
  await dialog.getByLabel('Read receipts with').selectOption('anthropic');
  await dialog.getByText('Receipts will be read with Claude (Anthropic) first.').waitFor();
  assert.deepEqual(puts.at(-1), { visionProvider: 'anthropic' });

  if (full) {
    await dialog.getByLabel('Claude model').selectOption('claude-sonnet-5-5');
    await dialog.getByText('Claude will use Claude Sonnet 5.5.').waitFor();
    page.once('dialog', (d) => d.accept());
    await dialog.getByRole('button', { name: 'Remove Claude (Anthropic) key' }).click();
    await dialog.getByText('Removed the Claude (Anthropic) key.').waitFor();
    await dialog.getByRole('button', { name: 'Add Claude (Anthropic) key' }).click();
    await dialog.getByLabel('Claude (Anthropic) API key').fill('sk-ant-api03-test-key-abcd');
    await dialog.getByRole('button', { name: 'Save Claude (Anthropic) key' }).click();
    await dialog.getByText('Saved here · …abcd').waitFor();
  }
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  assert.equal(await dialog.isVisible(), false);

  // With a Claude key, Find matches also asks Claude, sending only the claims
  // and receipts the rules leave unmatched.
  await findMatches.click();
  const review = page.locator('#matchReviewList');
  await review.locator('.match-review-chip.claude').first().waitFor();
  const payload = matchRequests.at(-1);
  assert.deepEqual(payload.claims.map((c) => c.id).sort(), ['c-grab', 'c-openai']);
  assert.deepEqual(payload.receipts.map((r) => r.key).sort(), ['r-grab.pdf', 'r-openai.pdf']);
  assert.equal(await review.locator('.match-review-chip.claude').count(), 2);
  assert.equal(await review.locator('.match-review-chip.clear').count(), 1);
  await review.getByText('USD 25 ChatGPT receipt').waitFor();
  await page.getByText('Found 3 suggestions (1 clear, 0 ambiguous, 2 from Claude)').waitFor();
  if (shots) await page.screenshot({ path: path.join(shots, `${name}-matches.png`), fullPage: true });

  if (full) {
    // A later run that gives a receipt to another claim drops the older pick
    // for that receipt, so pairs stay one-to-one; the next run restores them.
    swapNextMatch = true;
    await findMatches.click();
    await review.getByText('Swapped pick').waitFor();
    assert.equal(await review.locator('.match-review-chip.claude').count(), 1);
    await findMatches.click();
    await review.getByText('USD 25 ChatGPT receipt').waitFor();
    assert.equal(await review.locator('.match-review-chip.claude').count(), 2);

    // Accept one Claude pick; dismiss the other.
    await page.getByRole('button', { name: 'Accept match for Ride to client' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#matchReviewList .match-review-chip.claude').length === 1);
    assert.deepEqual(linkRequests.map((r) => r.key), ['r-grab.pdf']);
    await page.getByRole('button', { name: 'Reject match for ChatGPT' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#matchReviewList .match-review-chip.claude').length === 0);
  }

  // The key typed in never comes back from the server in this mock, and the
  // page never stores it.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  assert.ok(!stored.includes('sk-ant-api03'), 'keys must not be kept in browser storage');
  await page.close();
}

async function main() {
  await new Promise((resolve) => server.listen(port, resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    await run(browser, { viewport: { width: 1280, height: 860 }, colorScheme: 'light', name: 'desktop', full: true });
    await run(browser, { viewport: { width: 1280, height: 860 }, colorScheme: 'dark', name: 'desktop-dark' });
    await run(browser, { viewport: { width: 390, height: 844 }, colorScheme: 'light', name: 'mobile' });
    console.log('AI settings + Claude matching browser test passed');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
