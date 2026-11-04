// Contract test for the pending-tag scans (POST /gst-tags/pending and
// /amount-tags/pending): bundles worker/index.ts with esbuild and drives it
// against an in-memory R2 that counts storage calls. The scans must read
// metadata from list({ include: ['customMetadata'] }) without a head() per
// object, follow short pages up to the scan limit, fall back to head() when a
// runtime ignores `include`, and keep their filtering and output.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { buildSync } = require('esbuild');

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-tags-test-'));
const manifestStub = path.join(outdir, 'manifest.js');
fs.writeFileSync(manifestStub, 'export default "{}";');
buildSync({
  entryPoints: [path.join(__dirname, '..', 'worker', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(outdir, 'worker.cjs'),
  alias: { __STATIC_CONTENT_MANIFEST: manifestStub },
  logLevel: 'silent',
});
const worker = require(path.join(outdir, 'worker.cjs')).default;

// Every vision call fails, so each candidate shows up as a `failed` result
// and nothing is tagged; the results then name exactly the scanned candidates.
global.fetch = async () => new Response(JSON.stringify({ error: { message: 'provider down' } }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
});

function memoryKv() {
  const store = new Map();
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list() { return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true }; },
  };
}

// pageCap: R2 may return fewer objects than `limit` when metadata is included.
// ignoreInclude: a runtime that never returns customMetadata from list().
function fakeR2(objects, { pageCap = 1000, ignoreInclude = false } = {}) {
  const calls = { list: 0, head: 0, get: 0, put: 0 };
  const view = (key, withMetadata) => {
    const o = objects.get(key);
    return {
      key,
      etag: String(o.version),
      size: o.body.length,
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: o.type },
      customMetadata: withMetadata ? { ...o.meta } : undefined,
    };
  };
  return {
    calls,
    async list(opts = {}) {
      calls.list += 1;
      const keys = [...objects.keys()].sort().filter((k) => !opts.prefix || k.startsWith(opts.prefix));
      const withMetadata = !ignoreInclude && (opts.include || []).includes('customMetadata');
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const limit = Math.min(opts.limit ?? 1000, 1000, withMetadata ? pageCap : 1000);
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((k) => view(k, withMetadata)),
        truncated,
        cursor: truncated ? String(start + limit) : undefined,
        delimitedPrefixes: [],
      };
    },
    async head(key) {
      calls.head += 1;
      return objects.has(key) ? view(key, true) : null;
    },
    async get(key) {
      calls.get += 1;
      if (!objects.has(key)) return null;
      const o = objects.get(key);
      return { ...view(key, true), async arrayBuffer() { return new TextEncoder().encode(o.body).buffer; } };
    },
    async put(key, body, opts = {}) {
      calls.put += 1;
      const prev = objects.get(key);
      if (opts.onlyIf?.etagMatches !== undefined && String(prev?.version) !== opts.onlyIf.etagMatches) return null;
      objects.set(key, {
        body: prev?.body ?? '',
        version: (prev?.version ?? 0) + 1,
        type: opts.httpMetadata?.contentType || 'image/png',
        meta: { ...(opts.customMetadata || {}) },
      });
      return view(key, true);
    },
    async delete(key) { objects.delete(key); },
  };
}

// Receipts cycle through: pushed to Xero; GST-tagged and linked; untagged;
// linked only; amount-tagged as missing. Internal keys ('__' sorts after the
// date-prefixed receipt keys) count towards the scan window but are never
// candidates.
const VARIANTS = [
  { xeroInvoiceId: 'inv-1' },
  { taggedGstShown: 'true', linkedClaimIds: '["c1"]' },
  {},
  { linkedClaimIds: '["c2"]' },
  { taggedStatus: 'missing', taggedGstShown: 'false' },
];
function bucket(count) {
  const objects = new Map();
  objects.set('__invoice_edits/receipt.json', { body: '{}', version: 1, type: 'application/json', meta: {} });
  objects.set('__oauth/state', { body: '{}', version: 1, type: 'application/json', meta: {} });
  for (let i = 0; i < count; i += 1) {
    const key = `2026-01-01_000000_${String(i).padStart(5, '0')}_r.png`;
    objects.set(key, { body: 'img', version: 1, type: 'image/png', meta: { ...VARIANTS[i % VARIANTS.length] } });
  }
  return objects;
}

// Expected candidates, written from the documented rules rather than the code.
const receiptKeys = (objects, scanWindow) => [...objects.keys()].sort().slice(0, scanWindow)
  .filter((k) => !k.startsWith('__'));
const gstEligible = (objects, scanWindow) => receiptKeys(objects, scanWindow)
  .filter((k) => !objects.get(k).meta.xeroInvoiceId && objects.get(k).meta.taggedGstShown === undefined);
const amountEligible = (objects, scanWindow) => receiptKeys(objects, scanWindow).filter((k) => {
  const meta = objects.get(k).meta;
  return !meta.linkedClaimIds && meta.taggedStatus !== 'ok' && meta.taggedStatus !== 'missing';
});

async function call(route, objects, r2Options, RECEIPTS = fakeR2(objects, r2Options)) {
  const env = {
    RECEIPTS,
    APP_SETTINGS: memoryKv(),
    XERO_TOKENS: memoryKv(),
    GMAIL_STATE: memoryKv(),
    AUTH_PASSWORD: 'test-auth',
    GEMINI_API_KEY: 'test-gemini',
    VISION_PROVIDER: 'gemini',
  };
  const response = await worker.fetch(
    new Request(`http://localhost${route}`, { method: 'POST', headers: { 'X-Auth-Token': 'test-auth' } }),
    env,
    { waitUntil() {}, passThroughOnException() {} }
  );
  assert.equal(response.status, 200, route);
  return { body: await response.json(), calls: RECEIPTS.calls };
}

function assertGst(body, objects, scanWindow, limit) {
  const eligible = gstEligible(objects, scanWindow);
  const expected = eligible.slice(0, limit);
  assert.deepEqual(body.results.map((r) => r.key), expected);
  assert.ok(body.results.every((r) => r.status === 'failed'));
  assert.equal(body.requested, limit);
  assert.equal(body.processed, expected.length);
  assert.equal(body.failed, expected.length);
  assert.equal(body.tagged, 0);
  assert.equal(body.remaining, eligible.length);
}

function assertAmount(body, objects, scanWindow, limit) {
  const expected = amountEligible(objects, scanWindow).slice(0, limit);
  assert.deepEqual(body.results.map((r) => r.key), expected);
  assert.ok(body.results.every((r) => r.status === 'failed'));
  assert.equal(body.processed, expected.length);
}

async function main() {
  // Metadata inline: one list, no per-object head().
  {
    const objects = bucket(1000);
    const gst = await call('/gst-tags/pending?limit=8', objects);
    assertGst(gst.body, objects, 1000, 8);
    assert.equal(gst.calls.list, 1);
    assert.equal(gst.calls.head, 0);

    const amountObjects = bucket(1000);
    const amount = await call('/amount-tags/pending?limit=3', amountObjects);
    assertAmount(amount.body, amountObjects, 12, 3);
    assert.equal(amount.calls.list, 1);
    assert.equal(amount.calls.head, 0);
  }

  // Scan window covers the internal keys: they are listed but never tagged.
  {
    const objects = bucket(10);
    const gst = await call('/gst-tags/pending?limit=8', objects);
    assertGst(gst.body, objects, 1000, 8);
    const amount = await call('/amount-tags/pending?limit=8', objects);
    assertAmount(amount.body, objects, 32, 8);
  }

  // Short pages: follow the cursor up to the scan window, and no further, even
  // though eligible receipts exist past it.
  {
    const objects = bucket(2500);
    const gst = await call('/gst-tags/pending?limit=8', objects, { pageCap: 300 });
    assertGst(gst.body, objects, 1000, 8);
    assert.ok(gstEligible(objects, 2501).length > gstEligible(objects, 1000).length);
    assert.equal(gst.calls.head, 0);

    const amountObjects = bucket(2500);
    const amount = await call('/amount-tags/pending?limit=3', amountObjects, { pageCap: 5 });
    assertAmount(amount.body, amountObjects, 12, 3);
    assert.equal(amount.calls.head, 0);
  }

  // Runtime ignores `include`: same output, via one head() per listed object.
  {
    const objects = bucket(1000);
    const gst = await call('/gst-tags/pending?limit=8', objects, { ignoreInclude: true });
    assertGst(gst.body, objects, 1000, 8);
    assert.equal(gst.calls.list, 1);
    assert.equal(gst.calls.head, 1000);

    const amountObjects = bucket(1000);
    const amount = await call('/amount-tags/pending?limit=3', amountObjects, { ignoreInclude: true });
    assertAmount(amount.body, amountObjects, 12, 3);
    assert.equal(amount.calls.head, 12);
  }

  // A receipt deleted or tagged after the scan listed it is re-checked by the
  // per-receipt tagger (fresh get) instead of trusting the listed metadata.
  {
    const objects = bucket(20);
    const [deletedKey, taggedKey] = gstEligible(objects, 21);
    const racing = fakeR2(objects);
    const list = racing.list;
    racing.list = async (opts) => {
      const listed = await list(opts);
      objects.delete(deletedKey);
      objects.get(taggedKey).meta.taggedGstShown = 'true';
      return listed;
    };
    const { body } = await call('/gst-tags/pending?limit=2', objects, undefined, racing);
    assert.deepEqual(body.results, [
      { key: deletedKey, status: 'failed', reason: 'receipt_not_found' },
      { key: taggedKey, status: 'skipped', reason: 'already_tagged' },
    ]);
  }

  console.log('pending-tag scan tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
