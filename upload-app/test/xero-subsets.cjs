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
let afterPut = null;
let failOwnershipKey = '';
let raceOwnershipKey = '';
let failLockRelease = false;
const bucket = {
  async get(key) { const value = objects.get(key); return value ? { ...value, json: async () => JSON.parse(value.body), arrayBuffer: async () => Buffer.from(value.body) } : null; },
  async head(key) { return objects.has(key) ? { customMetadata: {} } : null; },
  async put(key, body, options = {}) {
    if (failLockRelease && key.startsWith('__invoice_edits/__xero_lock/') && JSON.parse(String(body)).owner === '') {
      failLockRelease = false;
      throw new Error('Transient lock release failure');
    }
    if (key === raceOwnershipKey && Object.values(JSON.parse(String(body)).xero || {}).some(state => state.invoiceID)) {
      raceOwnershipKey = '';
      const current = JSON.parse(objects.get(key).body);
      current.lines['howmuch::c'] = { remark: 'Concurrent manual edit' };
      objects.set(key, { ...objects.get(key), body: JSON.stringify(current), etag: String(++etag) });
      return null;
    }
    if (key === failOwnershipKey && Object.values(JSON.parse(String(body)).xero || {}).some(state => state.invoiceID)) {
      throw new Error('Receipt ownership storage unavailable');
    }
    const prior = objects.get(key);
    if (options.onlyIf?.etagMatches && prior?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && prior) return null;
    const value = { body: String(body), etag: String(++etag), customMetadata: options.customMetadata || {} };
    objects.set(key, value);
    if (afterPut) await afterPut(key, value);
    return value;
  },
  async delete(key) {
    if (failLockRelease && key.startsWith('__invoice_edits/__xero_lock/')) {
      failLockRelease = false;
      throw new Error('Transient lock release failure');
    }
    objects.delete(key);
  },
};
const bills = new Map();
const calls = [];
const attachmentCalls = [];
let loseBillResponse = false;
let failAttachment = false;
let rejectNextBill = false;
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
    if (rejectNextBill) {
      rejectNextBill = false;
      return Response.json({ ErrorNumber: 10, Type: 'ValidationException', Message: 'Account is archived' }, { status: 400 });
    }
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
  rejectNextBill = true;
  const rejectedLine = line('rejected', 9.81);
  assert.equal((await push([rejectedLine], 'Correctable')).status, 502);
  const corrected = await push([{ ...rejectedLine, accountCode: '463' }], 'Correctable');
  assert.equal(corrected.status, 200, 'definitive validation rejection must permit a corrected retry');

  await bucket.put('a.pdf', '%PDF-1.4');
  await bucket.put('b.pdf', '%PDF-1.4');
  const a = { ...line('a', 11), receiptKey: 'a.pdf' };
  const b = { ...line('b', 22), receiptKey: 'b.pdf' };
  let releaseA, acquiredA;
  const aGate = new Promise(resolve => { releaseA = resolve; });
  const aAcquired = new Promise(resolve => { acquiredA = resolve; });
  afterPut = async key => {
    if (key === '__invoice_edits/a.pdf') { afterPut = null; acquiredA(); await aGate; }
  };
  const ab = push([a, b], 'A and B');
  await aAcquired;
  const duplicateAB = await push([a, b], 'A and B');
  assert.equal(duplicateAB.status, 409, 'an identical in-flight push must not share releasable reservations');
  const bWinner = await push([b], 'B wins');
  assert.equal(bWinner.status, 200);
  releaseA();
  assert.equal((await ab).status, 409);
  assert.equal((await push([a], 'A later')).status, 200, 'failed multi-receipt acquisition must release A without a bill');

  await bucket.put('c.pdf', '%PDF-1.4');
  await bucket.put('d.pdf', '%PDF-1.4');
  const c = { ...line('c', 13), receiptKey: 'c.pdf' };
  const d = { ...line('d', 27), receiptKey: 'd.pdf' };
  raceOwnershipKey = '__invoice_edits/c.pdf';
  failOwnershipKey = '__invoice_edits/d.pdf';
  const partialWrite = await push([c, d], 'Ownership recovery');
  assert.equal(partialWrite.status, 200, 'a created draft must remain visible even if one receipt ownership write fails');
  const cState = JSON.parse(objects.get('__invoice_edits/c.pdf').body);
  assert.equal(cState.xero['howmuch::c'].invoiceID, partialWrite.data.invoiceID, 'post-create ownership CAS must retry');
  assert.equal(cState.lines['howmuch::c'].remark, 'Concurrent manual edit', 'CAS retry must retain concurrent edits');
  const dState = (await api('/receipt/d.pdf/invoice-edits', undefined, 'GET')).data;
  assert.equal(dState.xero['howmuch::d'].invoiceID, partialWrite.data.invoiceID, 'fresh clients recover ownership from the push ledger');
  assert.equal((await push([d], 'Must not duplicate')).status, 409);
  failOwnershipKey = '';
  const beforeRecovery = calls.length;
  assert.equal((await push([c, d], 'Ownership recovery')).data.invoiceID, partialWrite.data.invoiceID);
  assert.equal(calls.length, beforeRecovery, 'partial ownership persistence must not cause another create');
  assert.equal((await api('/xero/invoices/mark-claimed', { invoiceID: partialWrite.data.invoiceID, backend: 'howmuch', lineItems: [d] })).status, 200);

  async function expireLockFor(receiptKey, claimId) {
    const state = (await api(`/receipt/${receiptKey}/invoice-edits`, undefined, 'GET')).data;
    const lockKey = `__invoice_edits/__xero_lock/${state.xero[`howmuch::${claimId}`].pushKey}`;
    const lock = JSON.parse(objects.get(lockKey).body);
    await bucket.put(lockKey, JSON.stringify({ ...lock, expiresAt: Date.now() - 1 }));
    return lockKey;
  }
  failLockRelease = true;
  loseBillResponse = true;
  assert.equal((await push([line('unlock-lost', 14)], 'Unlock lost')).status, 502, 'cleanup must preserve the original unknown-outcome response');
  const beforeUnlockRecovery = bills.size;
  assert.equal((await push([line('unlock-lost', 14)], 'Unlock lost')).status, 409, 'a live lease must exclude a twin');
  await expireLockFor('shared.pdf', 'unlock-lost');
  assert.equal((await push([line('unlock-lost', 14)], 'Unlock lost')).status, 200, 'failed cleanup must not permanently block exact retry');
  assert.equal(bills.size, beforeUnlockRecovery);
  failLockRelease = true;
  const successfulUnlockFailure = await push([line('unlock-success', 15)], 'Unlock success');
  assert.equal(successfulUnlockFailure.status, 200, 'cleanup must not overwrite a successful draft result');
  await expireLockFor('shared.pdf', 'unlock-success');
  assert.equal((await push([line('unlock-success', 15)], 'Unlock success')).data.invoiceID, successfulUnlockFailure.data.invoiceID);

  await bucket.put('abandoned.pdf', '%PDF-1.4');
  const abandonedLine = { ...line('abandoned', 16), receiptKey: 'abandoned.pdf' };
  let releaseOld, oldAcquired, releaseNew, newAcquired;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const oldReady = new Promise(resolve => { oldAcquired = resolve; });
  const newGate = new Promise(resolve => { releaseNew = resolve; });
  const newReady = new Promise(resolve => { newAcquired = resolve; });
  afterPut = async key => {
    if (key === '__invoice_edits/abandoned.pdf') { afterPut = null; oldAcquired(); await oldGate; }
  };
  const abandoned = push([abandonedLine], 'Abandoned');
  await oldReady;
  const lockKey = await expireLockFor('abandoned.pdf', 'abandoned');
  afterPut = async key => {
    if (key === '__invoice_edits/abandoned.pdf') { afterPut = null; newAcquired(); await newGate; }
  };
  const successor = push([abandonedLine], 'Abandoned');
  await newReady;
  const successorOwner = JSON.parse(objects.get(lockKey).body).owner;
  releaseOld();
  assert.equal((await abandoned).status, 409, 'superseded acquisition must be fenced before Xero');
  assert.equal(JSON.parse(objects.get(lockKey).body).owner, successorOwner, 'old finally must not unlock its successor');
  assert.equal(JSON.parse(objects.get('__invoice_edits/abandoned.pdf').body).xero['howmuch::abandoned'].pushOwner, successorOwner, 'old cleanup must not erase adopted reservations');
  const beforeSuccessor = calls.length;
  releaseNew();
  assert.equal((await successor).status, 200);
  assert.equal(calls.length, beforeSuccessor + 1, 'only the surviving owner may start creating');
  console.log('Xero subsets passed (empty, partial, DRAFT/inclusive tax, repeat, overlap/concurrency, subsequent, per-line claimed, reset, stale revision, lost response/expiry, attachments)');
}
main().finally(() => fs.rmSync(dir, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
