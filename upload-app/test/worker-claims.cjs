const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForWorker(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with code ${child.exitCode}`);
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('wrangler did not become ready');
}

function lineItem(id, description) {
  return {
    receiptKey: `${id}.pdf`,
    ynabClaimId: id,
    claimSource: 'transaction',
    claimDescription: description,
    claimsBackend: 'howmuch',
    date: '2026-09-15',
    description: `Edited Xero description for ${description}`,
    accountCode: '463',
    taxType: 'NRINPUT',
    amount: 10,
  };
}

async function markClaimed(workerUrl, lineItems) {
  const response = await fetch(`${workerUrl}/xero/invoices/mark-claimed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': 'test-auth' },
    body: JSON.stringify({ invoiceID: 'invoice-1', backend: 'howmuch', lineItems }),
  });
  return { response, body: await response.json() };
}

async function main() {
  const requests = [];
  let responseMode = 'success';
  let serverVersion = 'old';
  const claimedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date());
  const howMuch = http.createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      let value = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { value += chunk; });
      request.on('end', () => resolve(value ? JSON.parse(value) : null));
    });
    requests.push({ method: request.method, url: request.url, body });

    if (request.method !== 'PATCH' || !request.url.endsWith('/transactions')) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { detail: 'Expected collection PATCH' } }));
      return;
    }

    // Two HowMuch versions: one before the claim field, which stores the
    // CLAIMED memo and returns no claim fields, and one with it, which moves
    // the CLAIMED word into claim_status and claimed_on and keeps the rest of
    // the memo.
    const transactions = body.transactions.map((transaction, index) => {
      const mismatch = responseMode.endsWith('mismatch') && index === 1;
      if (serverVersion === 'old') {
        return { id: transaction.id, memo: mismatch ? 'TODO: unchanged' : transaction.memo };
      }
      const claimed = /^CLAIMED - (\d{4}-\d{2}-\d{2}): (.*)$/.exec(transaction.memo);
      return mismatch
        ? { id: transaction.id, memo: claimed[2], claim_status: 'to_claim', claimed_on: null }
        : { id: transaction.id, memo: claimed[2], claim_status: transaction.claim_status, claimed_on: transaction.claimed_on };
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: {
      transaction_ids: transactions.map((transaction) => transaction.id),
      transactions,
      server_knowledge: 1,
    } }));
  });

  const howMuchPort = await listen(howMuch);
  const workerPort = await unusedPort();
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  const wrangler = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--port', String(workerPort),
    // Fresh local state each run, so a lockout left by the password-limit
    // check below can't leak into the next run.
    '--persist-to', fs.mkdtempSync(path.join(os.tmpdir(), 'worker-claims-')),
    '--var', 'AUTH_PASSWORD:test-auth',
    '--var', 'HOWMUCH_PAT:test-pat',
    '--var', 'HOWMUCH_PLAN_ID:test-plan',
    '--var', `HOWMUCH_API_URL:http://127.0.0.1:${howMuchPort}/v1`,
  ], { cwd: `${__dirname}/..`, stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    await waitForWorker(workerUrl, wrangler);

    // AI settings and Claude matching hold and spend provider keys, so they
    // must sit behind the app password like every other API route.
    for (const [method, route, body] of [
      ['GET', '/ai/settings'],
      ['PUT', '/ai/settings', { keys: { anthropic: null } }],
      ['POST', '/ai/match', { claims: [], receipts: [] }],
    ]) {
      const init = { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) };
      const anonymous = await fetch(`${workerUrl}${route}`, init);
      assert.equal(anonymous.status, 401, `${method} ${route} must require X-Auth-Token`);
      const wrongToken = await fetch(`${workerUrl}${route}`, { ...init, headers: { ...init.headers, 'X-Auth-Token': 'wrong' } });
      assert.equal(wrongToken.status, 401, `${method} ${route} must reject a wrong token`);
    }
    const authed = await fetch(`${workerUrl}/ai/settings`, { headers: { 'X-Auth-Token': 'test-auth' } });
    assert.equal(authed.status, 200);
    assert.equal((await authed.json()).providers.length, 3);
    const lines = [lineItem('claim-1', 'First claim'), lineItem('claim-2', 'Second claim')];
    const success = await markClaimed(workerUrl, lines);
    assert.equal(success.response.status, 200, JSON.stringify(success.body));
    assert.equal(requests.length, 1, 'HowMuch claims should use one upstream request');
    assert.equal(requests[0].method, 'PATCH');
    // One body serves both HowMuch versions: the CLAIMED memo for the old one,
    // the claim fields for the new one.
    assert.deepEqual(requests[0].body, {
      transactions: [
        { id: 'claim-1', memo: `CLAIMED - ${claimedDate}: First claim`, claim_status: 'claimed', claimed_on: claimedDate },
        { id: 'claim-2', memo: `CLAIMED - ${claimedDate}: Second claim`, claim_status: 'claimed', claimed_on: claimedDate },
      ],
    });
    assert.deepEqual(success.body.claimedYnab, [
      { id: 'claim-1', status: 'claimed' },
      { id: 'claim-2', status: 'claimed' },
    ]);

    requests.length = 0;
    responseMode = 'mismatch';
    const mismatch = await markClaimed(workerUrl, lines);
    assert.equal(mismatch.response.status, 502);
    assert.deepEqual(mismatch.body.taggedReceipts, [], 'unverified claims must prevent receipt tagging');
    assert.equal(mismatch.body.claimedYnab[1].status, 'failed');

    // HowMuch with the claim field: the stored memo no longer carries CLAIMED,
    // so the claim is confirmed by its fields.
    serverVersion = 'new';
    requests.length = 0;
    responseMode = 'success';
    const fieldSuccess = await markClaimed(workerUrl, [lineItem('claim-4', 'Fourth claim'), lineItem('claim-5', 'Fifth claim')]);
    assert.equal(fieldSuccess.response.status, 200, JSON.stringify(fieldSuccess.body));
    assert.deepEqual(fieldSuccess.body.claimedYnab, [
      { id: 'claim-4', status: 'claimed' },
      { id: 'claim-5', status: 'claimed' },
    ]);
    requests.length = 0;
    responseMode = 'field-mismatch';
    const fieldMismatch = await markClaimed(workerUrl, [lineItem('claim-6', 'Sixth claim'), lineItem('claim-7', 'Seventh claim')]);
    assert.equal(fieldMismatch.response.status, 502);
    assert.equal(fieldMismatch.body.claimedYnab[1].status, 'failed', 'a row still to claim is not claimed');
    serverVersion = 'old';

    requests.length = 0;
    const missingDescriptionLine = lineItem('claim-3', 'Original claim');
    delete missingDescriptionLine.claimDescription;
    const missingDescription = await markClaimed(workerUrl, [missingDescriptionLine]);
    assert.equal(missingDescription.response.status, 502);
    assert.equal(requests.length, 0, 'editable Xero descriptions must not be used as claim memos');
    assert.deepEqual(missingDescription.body.taggedReceipts, []);

    // Wrong passwords: 10 a minute per IP, then that IP is locked out, even
    // with the right password. Requests with no password don't count. Runs
    // last because the lockout outlives the test's remaining requests.
    for (let i = 0; i < 15; i += 1) {
      assert.equal((await fetch(`${workerUrl}/list?limit=1`)).status, 401);
    }
    assert.equal((await fetch(`${workerUrl}/list?limit=1`, { headers: { 'X-Auth-Token': 'test-auth' } })).status, 200);
    // Three wrong tokens were already spent on the AI route checks above. The
    // limiter's window is fixed, so allow for a reset partway through.
    let wrongBeforeLimit = 0;
    for (; wrongBeforeLimit < 25; wrongBeforeLimit += 1) {
      const response = await fetch(`${workerUrl}/list?limit=1`, { headers: { 'X-Auth-Token': `wrong-${wrongBeforeLimit}` } });
      if (response.status === 429) break;
      assert.equal(response.status, 401);
    }
    assert.ok(wrongBeforeLimit >= 7 && wrongBeforeLimit < 25, `limited after ${wrongBeforeLimit} more wrong passwords`);
    const lockedOut = await fetch(`${workerUrl}/list?limit=1`, { headers: { 'X-Auth-Token': 'test-auth' } });
    assert.equal(lockedOut.status, 429, 'the right password must not get through during a lockout');
    // Wrong passwords stay 429 for the whole lockout, not just the limiter's
    // window, or the right one would stand out as the only 429.
    const lockedWrong = await fetch(`${workerUrl}/list?limit=1`, { headers: { 'X-Auth-Token': 'still-wrong' } });
    assert.equal(lockedWrong.status, 429);
  } finally {
    if (wrangler.exitCode === null) {
      wrangler.kill('SIGTERM');
      await new Promise((resolve) => wrangler.once('exit', resolve));
    }
    await new Promise((resolve) => howMuch.close(resolve));
  }

  console.log('Worker HowMuch batch claim contract passed (and AI routes require auth, wrong passwords are limited)');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
