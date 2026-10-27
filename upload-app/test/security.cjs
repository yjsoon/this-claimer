// Exercise the public Worker boundary without contacting providers or live storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { build } = require('esbuild');
global.crypto = webcrypto;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claimer-security-'));
  await build({
    entryPoints: [path.join(__dirname, '../worker/index.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: path.join(dir, 'worker.cjs'),
    plugins: [{ name: 'manifest', setup(b) {
      b.onResolve({ filter: /^__STATIC_CONTENT_MANIFEST$/ }, () => ({ path: 'manifest', namespace: 'test' }));
      b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export default "{}"' }));
    } }],
  });
  const worker = require(path.join(dir, 'worker.cjs')).default;
  const objects = new Map();
  let version = 0;
  const bucket = {
    async get(key) {
      const obj = objects.get(key);
      return obj ? { ...obj, json: async () => JSON.parse(obj.body) } : null;
    },
    async put(key, body, options = {}) {
      if (options.onlyIf?.etagMatches && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      const obj = { key, body, etag: String(++version), uploaded: new Date(), size: 16, customMetadata: options.customMetadata || {} };
      objects.set(key, obj);
      return obj;
    },
    async list({ prefix = '' } = {}) {
      return { objects: [...objects.values()].filter(o => o.key.startsWith(prefix)), truncated: false };
    },
  };
  const kv = { async get() { return null; }, async put() {}, async delete() {} };
  const env = {
    AUTH_PASSWORD: 'test-only', RECEIPTS: bucket,
    XERO_TOKENS: kv, GMAIL_STATE: kv,
    XERO_CLIENT_ID: 'test', XERO_CLIENT_SECRET: 'test',
    GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test',
  };
  const pending = [];
  const request = (route, init = {}, authed = false) => worker.fetch(new Request(`https://receipts.example${route}`, {
    ...init, headers: { ...(authed ? { 'X-Auth-Token': 'test-only' } : {}), ...init.headers },
  }), env, { waitUntil(p) { pending.push(p); } });
  let exchanges = 0;
  global.fetch = async () => { exchanges++; return new Response('{}', { status: 503 }); };
  const callback = (provider, state, cookie = state, code = 'test-code') => request(
    `/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: `${provider}_oauth_state=${cookie}` } });
  for (const provider of ['gmail', 'xero']) {
    await callback(provider, 'forged');
    assert.equal(exchanges, 0, `${provider}: caller-chosen matching state/cookie must not redeem a code`);
    assert.equal((await request(`/${provider}/connect`, { method: 'POST' })).status, 401);
    const begin = async () => {
      const res = await request(`/${provider}/connect`, { method: 'POST' }, true);
      assert.equal(res.status, 200);
      return new URL((await res.json()).authorizeUrl).searchParams.get('state');
    };
    const old = await begin();
    const current = await begin();
    await callback(provider, old);
    await callback(provider, current, 'other-browser');
    await callback(provider === 'gmail' ? 'xero' : 'gmail', current);
    assert.equal(exchanges, 0, 'superseded, browser-mismatched and cross-provider states fail closed');
    await Promise.all([callback(provider, current), callback(provider, current)]);
    assert.equal(exchanges, 1, 'one concurrent callback may redeem an authorized transaction');
    await callback(provider, current, current, 'different-code');
    assert.equal(exchanges, 1, 'failed exchange still consumes state');
    exchanges = 0;
    const expired = await begin();
    const now = Date.now;
    Date.now = () => now() + 601000;
    try { await callback(provider, expired); } finally { Date.now = now; }
    assert.equal(exchanges, 0, 'expired state cannot redeem a code');
  }
  const upload = (name, type, bytes) => {
    const body = new FormData();
    body.append('file', new Blob([bytes], { type }), name);
    return request('/upload', { method: 'POST', body }, true);
  };
  for (const [name, type, bytes] of [
    ['receipt.pdf', 'text/html', '<script>parent.pwned=1</script>'],
    ['receipt.pdf', '', '<html>active</html>'],
    ['receipt.pdf', 'image/png', new Uint8Array([137,80,78,71,13,10,26,10])],
    ['receipt.webp', 'image/webp', 'RIFFnot a webp'],
    ['receipt.heic', 'image/heic', '\0\0\0\x18ftypmp42'],
  ]) assert.equal((await upload(name, type, bytes)).status, 400, `${name} / ${type} must reject mismatched content`);
  for (const [name, type] of [['receipt.pdf', 'application/pdf'], ['receipt.pdf', ''], ['blob', 'application/pdf'], ['receipt.pdf', 'application/x-pdf']]) {
    const response = await upload(name, type, '%PDF-1.4\n%%EOF');
    assert.equal(response.status, 200, `valid PDF upload ${name} / ${type}`);
  }
  const list = await (await request('/list', {}, true)).json();
  assert.ok(list.receipts.every(r => !r.key.startsWith('__oauth/')), 'OAuth records must not appear as receipts');
  assert.equal((await request('/receipt/__oauth%2Fgmail', {}, true)).status, 404);
  await Promise.allSettled(pending);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Security contracts passed: OAuth forgery/replay/races/expiry; upload types; private records');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
