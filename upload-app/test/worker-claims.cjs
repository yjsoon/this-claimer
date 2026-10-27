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
  const claimedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date());
  const howMuch = http.createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      let value = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { value += chunk; });
      request.on('end', () => resolve(value ? JSON.parse(value) : null));
    });
    requests.push({ method: request.method, url: request.url, body });

    if (request.method === 'GET' && request.url.includes('/transactions?')) {
      const row = (id, memo, extra = {}) => ({
        id, memo, date: '2026-10-27', amount: -12000,
        account_name: 'Synthetic account', payee_name: 'Synthetic payee',
        transfer_transaction_id: null, ...extra,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: { transactions: [
        row('field', 'Dinner', { claim_status: 'to_claim' }),
        row('empty', null, { claim_status: 'to_claim' }),
        row('legacy', 'TODO: Taxi'),
        row('confirm-legacy', 'TOCHECK TODO: Hotel', { claim_status: null }),
        row('claimed', 'TODO: Stale word', { claim_status: 'claimed',
          subtransactions: [{ id: 'stale-split', memo: 'TODO: Stale split', amount: -12000 }] }),
        row('ordinary', 'Dinner', { claim_status: null }),
        row('transfer-in', 'Dinner', { claim_status: 'to_claim', amount: 12000, transfer_transaction_id: 'out' }),
        row('transfer-out', 'Dinner', { claim_status: 'to_claim', transfer_transaction_id: 'in' }),
        row('split-in', 'Independent claim', { claim_status: 'to_claim', amount: 20000,
          transfer_transaction_id: 'split-parent', parent_transaction_id: 'split-parent' }),
        row('field-split', 'Group dinner', { claim_status: 'to_claim',
          subtransactions: [{ id: 'split', memo: 'TODO: Old part', amount: -5000 }] }),
      ] } }));
      return;
    }

    if (request.method === 'GET' && request.url.includes('/transactions/')) {
      const id = decodeURIComponent(request.url.split('/').pop());
      response.writeHead(responseMode === 'read-error' ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: { transaction: responseMode === 'missing-source' ? undefined : {
        id: responseMode === 'wrong-source' ? 'other' : id,
        memo: id === 'claim-1' ? 'TOCHECK TODO: First claim' : null,
        ...(responseMode === 'legacy' ? {} : { claim_status: 'to_claim' }),
      } } }));
      return;
    }

    if (request.method !== 'PATCH' || !request.url.endsWith('/transactions')) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { detail: 'Expected collection PATCH' } }));
      return;
    }

    const transactions = body.transactions.map((transaction, index) => {
      if (responseMode === 'legacy') return { id: transaction.id, memo: transaction.memo };
      return {
        ...transaction,
        memo: transaction.memo?.replace(/^(?:CLAIMED - \d{4}-\d{2}-\d{2}: |TOCHECK TODO: )/, '') ?? null,
        claim_status: responseMode === 'mismatch' && index === 1 ? 'to_claim' : transaction.claim_status,
        claimed_on: responseMode === 'wrong-date' ? '2000-01-01' : transaction.claimed_on,
      };
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

    // Invoice overrides are shared, versioned independently from receipt bytes
    // and AI tags, and stale browsers/agents cannot overwrite a newer edit.
    const headers = { 'X-Auth-Token': 'test-auth', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.append('file', new Blob(['%PDF-1.4\ninvoice fixture'], { type: 'application/pdf' }), 'foodpanda.pdf');
    const uploaded = await fetch(`${workerUrl}/upload`, {
      method: 'POST', headers: { 'X-Auth-Token': 'test-auth' }, body: form,
    }).then(r => r.json());
    form.set('file', new Blob(['%PDF-1.4\nunedited fixture'], { type: 'application/pdf' }), 'unedited.pdf');
    const unedited = await fetch(`${workerUrl}/upload`, {
      method: 'POST', headers: { 'X-Auth-Token': 'test-auth' }, body: form,
    }).then(r => r.json());
    const editUrl = `${workerUrl}/receipt/${encodeURIComponent(uploaded.key)}/invoice-edits`;
    assert.equal((await fetch(editUrl)).status, 401);
    const initial = await fetch(editUrl, { headers }).then(r => r.json());
    assert.deepEqual(initial, { revision: null, lines: {} });
    const patch = (body) => fetch(editUrl, { method: 'PATCH', headers, body: JSON.stringify(body) });
    const edit = { backend: 'howmuch', claimId: 'foodpanda-claim', revision: null,
      patch: { section: 'nongst', gstShown: false, taxType: 'NRINPUT', description: 'ABC meetup #10', amount: 219.30, date: '' } };
    const firstWriters = await Promise.all([patch(edit), patch(edit)]);
    assert.deepEqual(firstWriters.map(r => r.status).sort(), [200, 409], 'initial creation must also be atomic');
    const created = firstWriters.find(r => r.status === 200);
    const shared = await created.json();
    assert.deepEqual(shared.lines['howmuch::foodpanda-claim'], {
      ...edit.patch, reviewed: false, reviewedSnapshot: null, reviewedSourceSnapshot: null,
    });
    assert.ok(shared.revision);
    assert.deepEqual(await fetch(editUrl, { headers }).then(r => r.json()), shared);
    assert.equal((await patch({ ...edit, patch: { taxType: 'INPUTY24' } })).status, 409);
    const concurrent = await Promise.all([
      patch({ ...edit, revision: shared.revision, patch: { remark: 'browser A' } }),
      patch({ ...edit, revision: shared.revision, patch: { remark: 'agent B' } }),
    ]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
    const latest = await fetch(editUrl, { headers }).then(r => r.json());
    assert.equal(latest.lines['howmuch::foodpanda-claim'].taxType, 'NRINPUT');
    assert.equal((await patch({ ...edit, revision: latest.revision, patch: { taggedGstShown: false } })).status, 400);
    assert.equal((await patch({ ...edit, revision: latest.revision, patch: { section: 'invalid' } })).status, 400);
    assert.equal((await patch({ ...edit, revision: latest.revision, patch: { date: 'tomorrow' } })).status, 400);
    const otherBackend = await patch({ ...edit, revision: latest.revision, backend: 'ynab', patch: { section: 'gst' } });
    assert.equal(otherBackend.status, 200);
    const reset = await patch({ ...edit, revision: (await otherBackend.json()).revision, patch: null });
    const resetData = await reset.json();
    assert.deepEqual(resetData.lines['howmuch::foodpanda-claim'], {}, 'reset retains a tombstone against legacy re-import');
    assert.equal(resetData.lines['ynab::foodpanda-claim'].section, 'gst');
    const listed = await fetch(`${workerUrl}/list`, { headers }).then(r => r.json());
    assert.equal(listed.receipts.length, 2, 'override sidecars must not appear as receipts');
    assert.deepEqual(listed.receipts.find(r => r.key === uploaded.key).invoiceEdits, resetData);
    assert.deepEqual(listed.receipts.find(r => r.key === unedited.key).invoiceEdits, { revision: null, lines: {} });
    const bytes = await fetch(`${workerUrl}/receipt/${encodeURIComponent(uploaded.key)}`, { headers }).then(r => r.text());
    assert.equal(bytes, '%PDF-1.4\ninvoice fixture');
    console.log('Invoice override API passed (CAS, concurrent writers, backend isolation, reset, listing, receipt preservation)');

    const todos = await fetch(`${workerUrl}/ynab/todos`, { headers }).then(r => r.json());
    assert.deepEqual(todos.todos.map(todo => todo.id).sort(),
      ['confirm-legacy', 'empty', 'field', 'field-split', 'legacy', 'split-in', 'transfer-out']);
    assert.equal(todos.todos.find(todo => todo.id === 'field').description, 'Dinner');
    assert.equal(todos.todos.find(todo => todo.id === 'empty').description, 'Claim');
    assert.equal(todos.todos.find(todo => todo.id === 'confirm-legacy').description, 'Hotel');
    requests.length = 0;
    const lines = [lineItem('claim-1', 'First claim'), lineItem('claim-2', 'Second claim')];
    const success = await markClaimed(workerUrl, lines);
    assert.equal(success.response.status, 200, JSON.stringify(success.body));
    const writes = requests.filter(request => request.method === 'PATCH');
    assert.equal(writes.length, 1, 'HowMuch claim updates remain batched');
    assert.deepEqual(writes[0].body, {
      transactions: [
        { id: 'claim-1', claim_status: 'claimed', claimed_on: claimedDate },
        { id: 'claim-2', claim_status: 'claimed', claimed_on: claimedDate },
      ],
    });
    assert.deepEqual(success.body.claimedYnab, [
      { id: 'claim-1', status: 'claimed' },
      { id: 'claim-2', status: 'claimed' },
    ]);

    responseMode = 'legacy';
    const legacy = await markClaimed(workerUrl, lines);
    assert.equal(legacy.response.status, 200, JSON.stringify(legacy.body));
    assert.equal(requests.filter(request => request.method === 'PATCH').at(-1).body.transactions[0].memo,
      `CLAIMED - ${claimedDate}: TOCHECK First claim`, 'old servers retain the estimate marker in the compatibility memo');

    for (const mode of ['read-error', 'missing-source', 'wrong-source']) {
      responseMode = mode;
      requests.length = 0;
      const refused = await markClaimed(workerUrl, lines);
      assert.equal(refused.response.status, 502, mode);
      assert.deepEqual(refused.body.taggedReceipts, [], mode);
      assert.ok(!requests.some(request => request.method === 'PATCH'), mode);
    }

    responseMode = 'wrong-date';
    const wrongDate = await markClaimed(workerUrl, lines);
    assert.equal(wrongDate.response.status, 502);
    assert.deepEqual(wrongDate.body.taggedReceipts, []);

    requests.length = 0;
    responseMode = 'mismatch';
    const mismatch = await markClaimed(workerUrl, lines);
    assert.equal(mismatch.response.status, 502);
    assert.deepEqual(mismatch.body.taggedReceipts, [], 'unverified claims must prevent receipt tagging');
    assert.equal(mismatch.body.claimedYnab[1].status, 'failed');

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
