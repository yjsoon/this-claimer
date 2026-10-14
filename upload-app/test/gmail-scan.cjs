// Contract test for worker/gmail.ts: bundles the module with esbuild and runs
// a scan against a fake Gmail API and an in-memory KV.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { buildSync } = require('esbuild');

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-test-')), 'gmail.cjs');
buildSync({
  entryPoints: [path.join(__dirname, '..', 'worker', 'gmail.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent',
});
const gmail = require(outfile);

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

const PDF = '%PDF-1.4 fake receipt';
const BIG_IMAGE = 'x'.repeat(40 * 1024);
const grabHtml = '<html><body><p>Booking ID: A-12345</p><p>Picked up on 3 October 2026</p><p>Total Paid SGD 18.40</p></body></html>';
const grabFoodHtml = '<html><body><p>GrabFood</p><p>Booking ID: A-999</p><p>Picked up on 3 October 2026</p><p>Total Paid SGD 30.00</p></body></html>';

const messages = {
  m1: {
    id: 'm1',
    payload: {
      headers: [{ name: 'Subject', value: 'Your receipt from Example Pte Ltd' }],
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<p>Thanks</p>') } },
        { mimeType: 'application/pdf', filename: 'receipt-1.pdf', body: { attachmentId: 'a1', size: 2000 } },
        // inline logo: skipped
        { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline; filename=logo.png' }], body: { attachmentId: 'a2', size: 50000 } },
        // tiny attached image: skipped
        { mimeType: 'image/png', filename: 'icon.png', body: { attachmentId: 'a3', size: 2000 } },
        // photographed receipt: imported
        { mimeType: 'image/jpeg', filename: 'photo.jpg', headers: [{ name: 'Content-Disposition', value: 'attachment; filename=photo.jpg' }], body: { attachmentId: 'a4', size: 41000 } },
      ],
    },
  },
  m2: { id: 'm2', payload: { headers: [{ name: 'Subject', value: 'Invoice' }], parts: [{ mimeType: 'application/zip', filename: 'x.zip', body: { attachmentId: 'z', size: 10 } }] } },
  g1: { id: 'g1', payload: { headers: [{ name: 'Subject', value: 'Your Grab E-Receipt' }], mimeType: 'text/html', body: { data: b64url(grabHtml) } } },
  g2: { id: 'g2', payload: { headers: [{ name: 'Subject', value: 'Your Grab E-Receipt' }], mimeType: 'text/html', body: { data: b64url(grabFoodHtml) } } },
};
const attachments = { a1: PDF, a4: BIG_IMAGE };

const calls = [];
let revokeNext = false;
let failTokenNext = false;
global.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  calls.push(`${init.method || 'GET'} ${url.host}${url.pathname}`);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
    const body = new URLSearchParams(init.body);
    if (body.get('grant_type') === 'authorization_code') {
      return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    }
    if (failTokenNext) {
      failTokenNext = false;
      return json({ error: 'server_error' }, 503);
    }
    if (revokeNext) {
      revokeNext = false;
      return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
    }
    return json({ access_token: 'at-2', expires_in: 3600 });
  }
  if (url.host === 'gmail.googleapis.com') {
    assert.match(init.headers.Authorization, /^Bearer at-/);
    const p = url.pathname.replace('/gmail/v1/users/me', '');
    if (p === '/profile') return json({ emailAddress: 'Someone@Example.com' });
    if (p === '/messages') {
      const q = url.searchParams.get('q');
      assert.match(q, /after:\d+/);
      if (q.includes('from:grab')) return json({ messages: [{ id: 'g1' }, { id: 'g2' }] });
      if (q.includes('Gojek')) return json({});
      return json({ messages: [{ id: 'm1' }, { id: 'm2' }] });
    }
    const att = p.match(/^\/messages\/(\w+)\/attachments\/(\w+)$/);
    if (att) return json({ data: b64url(attachments[att[2]]) });
    const msg = p.match(/^\/messages\/(\w+)$/);
    if (msg) return json(messages[msg[1]]);
  }
  if (url.host === 'api.cloudflare.com' && url.pathname.endsWith('/browser-rendering/pdf')) {
    assert.equal(init.headers.Authorization, 'Bearer br-token');
    assert.match(JSON.parse(init.body).html, /Booking ID: A-12345/);
    return new Response('%PDF-1.7 rendered', { headers: { 'Content-Type': 'application/pdf' } });
  }
  throw new Error(`unexpected fetch ${url}`);
};

async function main() {
  const env = {
    GMAIL_STATE: memoryKv(),
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'secret',
    CF_ACCOUNT_ID: 'acct',
    CF_BROWSER_RENDERING_TOKEN: 'br-token',
  };

  const authorizeUrl = new URL(await gmail.buildAuthorizeUrl(env, 'https://receipts.example/gmail/connect', 'state-1'));
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://receipts.example/gmail/callback');
  assert.equal(authorizeUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authorizeUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');

  const email = await gmail.exchangeCode(env, 'https://receipts.example/gmail/callback?code=c', 'c');
  assert.equal(email, 'someone@example.com');

  const imported = [];
  const importFile = async (file) => {
    imported.push(file);
    return { key: `key-${imported.length}` };
  };

  const first = await gmail.scanAll(env, importFile);
  assert.equal(first.accounts.length, 1);
  assert.deepEqual(first.accounts[0].errors, []);
  assert.deepEqual(
    imported.map((f) => [f.filename, f.mimeType, f.messageId]),
    [
      ['receipt-1.pdf', 'application/pdf', 'm1'],
      ['photo.jpg', 'image/jpeg', 'm1'],
      ['grab_2026-10-03_18.40.pdf', 'application/pdf', 'g1'],
    ]
  );
  assert.equal(Buffer.from(imported[0].bytes).toString(), PDF);
  assert.equal(imported[0].subject, 'Your receipt from Example Pte Ltd');
  assert.equal(imported[0].account, 'someone@example.com');

  // A second scan sees nothing new.
  const second = await gmail.scanAll(env, importFile);
  assert.equal(second.accounts[0].checked, 0);
  assert.equal(imported.length, 3);

  const status = await gmail.getStatus(env, 'https://receipts.example/');
  assert.equal(status.accounts.length, 1);
  assert.match(status.accounts[0].lastScanSummary, /0 receipts from 0 new emails/);
  assert.ok(!JSON.stringify(status).includes('rt-1'), 'status must not leak tokens');

  // A held lock skips the scan.
  await env.GMAIL_STATE.put('gmail_scan_lock', 'x');
  assert.equal((await gmail.scanAll(env, importFile)).skipped, 'scan_in_progress');
  await env.GMAIL_STATE.delete('gmail_scan_lock');

  // Without Browser Rendering, body-only receipts are not searched.
  const plainEnv = { ...env, CF_BROWSER_RENDERING_TOKEN: undefined, GMAIL_STATE: memoryKv() };
  await gmail.exchangeCode(plainEnv, 'https://receipts.example/gmail/callback', 'c');
  calls.length = 0;
  await gmail.scanAll(plainEnv, async () => ({ key: 'k' }));
  assert.ok(!calls.some((c) => c.includes('browser-rendering')));

  // A thrown import (e.g. storage outage) leaves the email unseen and holds the
  // scan cursor back, so the next scan retries it.
  const flakyEnv = { ...plainEnv, GMAIL_STATE: memoryKv() };
  await gmail.exchangeCode(flakyEnv, 'https://receipts.example/gmail/callback', 'c');
  let failOnce = true;
  const flaky = await gmail.scanAll(flakyEnv, async () => {
    if (failOnce) {
      failOnce = false;
      throw new Error('R2 unavailable');
    }
    return { key: 'k' };
  });
  assert.equal(flaky.accounts[0].more, true);
  let flakyState = JSON.parse(await flakyEnv.GMAIL_STATE.get('gmail_accounts'))[0];
  assert.equal(flakyState.lastCompleteScanAt, undefined);
  assert.ok(!flakyState.seenIds.includes('m1'));
  const retry = await gmail.scanAll(flakyEnv, async () => ({ key: 'k' }));
  assert.deepEqual(retry.accounts[0].errors, []);
  flakyState = JSON.parse(await flakyEnv.GMAIL_STATE.get('gmail_accounts'))[0];
  assert.ok(flakyState.seenIds.includes('m1'));
  assert.ok(flakyState.lastCompleteScanAt > 0);

  // A revoked refresh token flags the account for reconnecting.
  const revokedEnv = { ...plainEnv, GMAIL_STATE: memoryKv() };
  await gmail.exchangeCode(revokedEnv, 'https://receipts.example/gmail/callback', 'c');
  const stored = JSON.parse(await revokedEnv.GMAIL_STATE.get('gmail_accounts'));
  stored[0].expiresAt = 0;
  await revokedEnv.GMAIL_STATE.put('gmail_accounts', JSON.stringify(stored));
  revokeNext = true;
  const revokedScan = await gmail.scanAll(revokedEnv, async () => ({ key: 'k' }));
  assert.equal(revokedScan.accounts[0].failed, true);
  const revokedStatus = await gmail.getStatus(revokedEnv, 'https://receipts.example/');
  assert.equal(revokedStatus.accounts[0].needsReconnect, true);
  // A later non-revocation failure keeps the reconnect flag.
  const keptState = JSON.parse(await revokedEnv.GMAIL_STATE.get('gmail_accounts'));
  keptState[0].expiresAt = 0;
  await revokedEnv.GMAIL_STATE.put('gmail_accounts', JSON.stringify(keptState));
  failTokenNext = true;
  await gmail.scanAll(revokedEnv, async () => ({ key: 'k' }));
  assert.equal((await gmail.getStatus(revokedEnv, 'https://receipts.example/')).accounts[0].needsReconnect, true);

  // The OAuth client can be saved from the app when no Worker secrets are set.
  const appEnv = { GMAIL_STATE: memoryKv() };
  assert.equal(await gmail.isConfigured(appEnv), false);
  await assert.rejects(gmail.saveClient(appEnv, 'not-a-client-id', 'GOCSPX-abcdefghij'), gmail.GmailClientInputError);
  await gmail.saveClient(appEnv, ' 123-abc.apps.googleusercontent.com ', 'GOCSPX-abcdefghij');
  const appStatus = await gmail.getStatus(appEnv, 'https://receipts.example/x');
  assert.equal(appStatus.configured, true);
  assert.equal(appStatus.clientSource, 'app');
  assert.equal(appStatus.clientId, '123-abc.apps.googleusercontent.com');
  assert.equal(appStatus.redirectUri, 'https://receipts.example/gmail/callback');
  assert.ok(!JSON.stringify(appStatus).includes('GOCSPX'), 'status must not return the client secret');
  const appAuthorize = new URL(await gmail.buildAuthorizeUrl(appEnv, 'https://receipts.example/', 's'));
  assert.equal(appAuthorize.searchParams.get('client_id'), '123-abc.apps.googleusercontent.com');
  await assert.rejects(gmail.saveClient(env, '123-abc.apps.googleusercontent.com', 'GOCSPX-abcdefghij'), gmail.GmailClientInputError);
  await gmail.clearClient(appEnv);
  assert.equal(await gmail.isConfigured(appEnv), false);

  assert.equal(await gmail.removeAccount(env, 'someone@example.com'), true);
  assert.equal((await gmail.getStatus(env, 'https://receipts.example/')).accounts.length, 0);

  console.log('Gmail scan contract passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
