// Real Worker routes, in-memory R2 and fake Xero/claims APIs: never writes accounting data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { buildSync } = require('esbuild');
global.crypto = webcrypto;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xero-subsets-'));
buildSync({ entryPoints: [path.join(__dirname, '../worker/index.ts')], bundle: true, platform: 'node', format: 'cjs',
  outfile: path.join(dir, 'worker.cjs'), logLevel: 'silent',
  external: ['__STATIC_CONTENT_MANIFEST'],
});
// Wrangler's virtual asset manifest is irrelevant to these API-only requests.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === '__STATIC_CONTENT_MANIFEST' ? '{}' : originalLoad.call(this, name, ...args); };
const worker = require(path.join(dir, 'worker.cjs')).default;
Module._load = originalLoad;
const objects = new Map();
let etag = 0;
const bucket = {
  async get(key) { const value = objects.get(key); return value ? { ...value, json: async () => JSON.parse(value.body), arrayBuffer: async () => Buffer.from(value.body) } : null; },
  async head(key) { return objects.has(key) ? { customMetadata: {} } : null; },
  async put(key, body, options = {}) {
    const prior = objects.get(key);
    if (options.onlyIf?.etagMatches && prior?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && prior) return null;
    const value = { body: String(body), etag: String(++etag), customMetadata: options.customMetadata || {} };
    objects.set(key, value); return value;
  },
};
const bills = new Map();
const calls = [];
const attachmentCalls = [];
let loseBillResponse = false;
let failAttachment = false;
global.fetch = async (url, init) => {
  if (url.startsWith('https://api.xero.com/')) {
    if (url.includes('/Attachments/')) {
      attachmentCalls.push(url);
      return new Response('', { status: failAttachment ? 500 : 200 });
    }
    assert.ok(url.endsWith('/Invoices?summarizeErrors=false'), `unexpected Xero URL ${url}`);
    const body = JSON.parse(init.body);
    calls.push(body);
    const key = new Headers(init.headers).get('Idempotency-Key');
    assert.ok(key, 'real Xero requests must carry an idempotency key');
    if (!bills.has(key)) bills.set(key, { InvoiceID: `bill-${bills.size + 1}`, InvoiceNumber: `DRAFT-${bills.size + 1}` });
    if (loseBillResponse) { loseBillResponse = false; throw new Error('Connection lost after creating bill'); }
    return Response.json({ Invoices: [bills.get(key)] });
  }
  assert.ok(url.includes('/transactions'), `unexpected claims URL ${url}`);
  const { transactions } = JSON.parse(init.body);
  return Response.json({ data: { transactions, transaction_ids: transactions.map(t => t.id) } });
};
const env = { AUTH_PASSWORD: 'test', RECEIPTS: bucket, HOWMUCH_PAT: 'test', HOWMUCH_PLAN_ID: 'test',
  XERO_TOKENS: { async get() { return JSON.stringify({ tenantId: 'test', tokenSet: { access_token: 'fake', expires_at: Date.now() / 1000 + 3600 } }); } },
};
async function api(route, body, method = 'POST') {
  const response = await worker.fetch(new Request(`https://example.test${route}`, { method,
    headers: { 'X-Auth-Token': 'test', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }), env, { waitUntil() {} });
  return { status: response.status, data: await response.json() };
}
const line = (id, amount) => ({ receiptKey: 'shared.pdf', ynabClaimId: id, claimsBackend: 'howmuch',
  date: '2026-10-01', description: id, claimDescription: id, claimSource: 'transaction', accountCode: '320', taxType: 'NRINPUT', amount });
const pdf = { name: 'receipts.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4\nfixture').toString('base64') };
const push = (lines, reference = 'Selected', extra = {}) => api('/xero/invoices/push', { bucket: 'gst', backend: 'howmuch', reference, lineItems: lines, receiptPdf: pdf, ...extra });
const edits = () => api('/receipt/shared.pdf/invoice-edits', undefined, 'GET');
async function main() {
  await bucket.put('shared.pdf', '%PDF-1.4');
  assert.equal((await push([])).status, 400);
  assert.equal(calls.length, 0);
  const first = await push([line('one', 10.90)]);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(calls[0].Status, 'DRAFT');
  assert.equal(calls[0].LineAmountTypes, 'Inclusive');
  assert.deepEqual(calls[0].LineItems, [{ Description: 'one', AccountCode: '320', TaxType: 'INPUTY24', UnitAmount: 10.90, Quantity: 1 }]);
  assert.ok(attachmentCalls[0].includes(`/${first.data.invoiceID}/Attachments/receipts.pdf`));
  let state = (await edits()).data;
  assert.equal(state.xero['howmuch::one'].invoiceID, first.data.invoiceID);
  assert.equal(state.xero['howmuch::two'], undefined, 'unchecked sibling has no pushed state');
  assert.equal((await push([line('one', 10.90)])).data.invoiceID, first.data.invoiceID);
  assert.equal(calls.length, 1, 'a known bill is reused without relying on Xero idempotency cache lifetime');
  assert.equal(bills.size, 1, 'an exact repeat must not create a second draft');
  assert.equal((await push([line('one', 10.90), line('two', 21.80)])).status, 409, 'overlapping subsets must not duplicate a pushed line');
  const second = await push([line('two', 21.80)], 'Later');
  assert.equal(second.status, 200);
  assert.notEqual(second.data.invoiceID, first.data.invoiceID);
  assert.equal(bills.size, 2);
  const claimed = await api('/xero/invoices/mark-claimed', { invoiceID: first.data.invoiceID, backend: 'howmuch', lineItems: [line('one', 10.90)] });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  state = (await edits()).data;
  assert.ok(state.xero['howmuch::one'].claimedAt);
  assert.equal(state.xero['howmuch::two'].claimedAt, undefined, 'claiming one line must not claim its sibling');
  assert.equal(objects.get('shared.pdf').customMetadata.xeroInvoiceId, undefined, 'partial claiming must not hide the whole receipt');
  // Resetting manual edits cannot erase accounting ownership.
  const reset = await api('/receipt/shared.pdf/invoice-edits', { backend: 'howmuch', claimId: 'one', revision: state.revision, patch: null }, 'PATCH');
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data.xero, state.xero);
  const beforeConflict = calls.length;
  assert.equal((await push([line('three', 32.70)], 'Stale', { invoiceRevisions: { 'shared.pdf': null } })).status, 409);
  assert.equal(calls.length, beforeConflict, 'stale edit revision must fail before reaching Xero');
  const wrongBill = await api('/xero/invoices/mark-claimed', { invoiceID: second.data.invoiceID, backend: 'howmuch', lineItems: [line('one', 10.90)] });
  assert.equal(wrongBill.status, 409, 'a line must not be claimed against a sibling bill');
  assert.equal((await push([line('duplicate', 1), line('duplicate', 1)])).status, 400);
  loseBillResponse = true;
  assert.equal((await push([line('lost', 4.36)], 'Lost response')).status, 502);
  const afterLost = bills.size;
  assert.equal((await push([line('lost', 4.36)], 'Changed reference')).status, 409);
  const recovered = await push([line('lost', 4.36)], 'Lost response');
  assert.equal(recovered.status, 200);
  assert.equal(bills.size, afterLost, 'unknown-outcome retry must use the original idempotency key');
  failAttachment = true;
  const unattached = await push([line('attachment', 5.45)], 'Attachment retry');
  assert.equal(unattached.status, 200);
  assert.equal(unattached.data.allAttached, false);
  failAttachment = false;
  const reattached = await push([line('attachment', 5.45)], 'Attachment retry');
  assert.equal(reattached.data.invoiceID, unattached.data.invoiceID);
  assert.equal(reattached.data.allAttached, true);
  const raced = await Promise.all([push([line('race', 6.54)], 'Race A'), push([line('race', 6.54)], 'Race B')]);
  assert.deepEqual(raced.map(result => result.status).sort(), [200, 409], 'overlapping concurrent pushes must have one winner');
  loseBillResponse = true;
  assert.equal((await push([line('expired', 7.63)], 'Expired')).status, 502);
  const object = objects.get('__invoice_edits/shared.pdf');
  const expiredState = JSON.parse(object.body);
  expiredState.xero['howmuch::expired'].reservedAt = Date.now() - 6 * 60 * 1000;
  await bucket.put('__invoice_edits/shared.pdf', JSON.stringify(expiredState));
  const beforeExpired = calls.length;
  assert.equal((await push([line('expired', 7.63)], 'Expired')).status, 409);
  assert.equal(calls.length, beforeExpired, 'an expired unknown outcome must never reach Xero again');
  await bucket.put('ready.pdf', '%PDF-1.4');
  const ready = { ...line('unused', 8.72), receiptKey: 'ready.pdf', ynabClaimId: null, claimsBackend: 'ynab' };
  const readyBill = await push([ready], 'Ready only');
  assert.equal(readyBill.status, 200);
  const readyClaimed = await api('/xero/invoices/mark-claimed', { invoiceID: readyBill.data.invoiceID, backend: 'howmuch', lineItems: [ready] });
  assert.equal(readyClaimed.status, 200);
  assert.ok((await api('/receipt/ready.pdf/invoice-edits', undefined, 'GET')).data.xero['ynab::receipt-ready:ready.pdf'].claimedAt);
  console.log('Xero subsets passed (empty, partial, DRAFT/inclusive tax, repeat, overlap/concurrency, subsequent, per-line claimed, reset, stale revision, lost response/expiry, attachments)');
}
main().finally(() => fs.rmSync(dir, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
