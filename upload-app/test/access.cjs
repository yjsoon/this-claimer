// Contract test for worker/access.ts: bundles the module with esbuild and
// checks Cloudflare Access JWT verification against a fake certs endpoint
// signed with a locally generated RSA key.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const { buildSync } = require('esbuild');

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'access-test-')), 'access.cjs');
buildSync({
  entryPoints: [path.join(__dirname, '..', 'worker', 'access.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent',
});
const access = require(outfile);

const TEAM = 'example.cloudflareaccess.com';
const ISS = `https://${TEAM}`;
const AUD = 'aud-tag-123';
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const encodeJson = (value) => b64url(Buffer.from(JSON.stringify(value)));

let certFetches = 0;
let publishedKeys = [];
global.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  assert.equal(url, `${ISS}/cdn-cgi/access/certs`);
  certFetches += 1;
  return new Response(JSON.stringify({ keys: publishedKeys }), { headers: { 'content-type': 'application/json' } });
};

async function newKey(kid) {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e } };
}

async function sign(key, claims, headerOverrides = {}) {
  const header = encodeJson({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...headerOverrides });
  const payload = encodeJson(claims);
  const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, Buffer.from(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = (extra = {}) => ({ aud: [AUD], iss: ISS, exp: now() + 600, iat: now(), email: 'me@example.com', ...extra });
const req = (headers = {}) => new Request('https://receipts.yourdomain.com/list', { headers });

(async () => {
  const keyA = await newKey('key-a');
  const keyB = await newKey('key-b');
  const stranger = await newKey('key-a'); // same kid, different key
  publishedKeys = [keyA.jwk];

  // Not configured: nothing is enforced.
  assert.deepEqual(await access.verifyAccess(req(), {}), { enforced: false });
  assert.deepEqual(await access.verifyAccess(req(), { ACCESS_TEAM_DOMAIN: TEAM }), { enforced: false });

  // Valid browser session via header and via cookie.
  const token = await sign(keyA, goodClaims());
  assert.deepEqual(await access.verifyAccess(req({ 'Cf-Access-Jwt-Assertion': token }), env), {
    enforced: true,
    ok: true,
    identity: 'me@example.com',
  });
  const viaCookie = await access.verifyAccess(req({ Cookie: `theme=dark; CF_Authorization=${token}` }), env);
  assert.equal(viaCookie.ok, true);

  // Service token identity; team domain given as a full URL.
  const service = await sign(keyA, goodClaims({ email: undefined, common_name: 'abc.access' }));
  const serviceResult = await access.verifyAccess(req({ 'Cf-Access-Jwt-Assertion': service }), {
    ...env,
    ACCESS_TEAM_DOMAIN: `${ISS}/`,
  });
  assert.equal(serviceResult.identity, 'abc.access');

  const rejects = async (headers, reason) => {
    const result = await access.verifyAccess(req(headers), env);
    assert.equal(result.enforced, true);
    assert.equal(result.ok, false, `expected rejection: ${reason}`);
    assert.equal(result.reason, reason);
  };
  await rejects({}, 'missing Access token');
  await rejects({ 'Cf-Access-Jwt-Assertion': 'not-a-jwt' }, 'malformed Access token');
  await rejects({ 'Cf-Access-Jwt-Assertion': await sign(stranger, goodClaims()) }, 'bad Access token signature');
  await rejects({ 'Cf-Access-Jwt-Assertion': await sign(keyA, goodClaims({ aud: ['other'] })) }, 'Access token is for another application');
  await rejects({ 'Cf-Access-Jwt-Assertion': await sign(keyA, goodClaims({ iss: 'https://evil.cloudflareaccess.com' })) }, 'Access token from another team');
  await rejects({ 'Cf-Access-Jwt-Assertion': await sign(keyA, goodClaims({ exp: now() - 3600 })) }, 'expired Access token');
  await rejects({ 'Cf-Access-Jwt-Assertion': await sign(keyA, goodClaims({ nbf: now() + 3600 })) }, 'Access token not yet valid');
  await rejects({ 'Cf-Access-Jwt-Assertion': await sign(keyA, goodClaims(), { alg: 'none' }) }, 'unsupported Access token');

  // Key rotation: an unknown kid triggers one refetch, then succeeds.
  publishedKeys = [keyA.jwk, keyB.jwk];
  const before = certFetches;
  const rotated = await access.verifyAccess(req({ 'Cf-Access-Jwt-Assertion': await sign(keyB, goodClaims()) }), env);
  assert.equal(rotated.ok, true);
  assert.equal(certFetches, before + 1);

  // Cached keys are reused for known kids.
  const cachedBefore = certFetches;
  await access.verifyAccess(req({ 'Cf-Access-Jwt-Assertion': token }), env);
  assert.equal(certFetches, cachedBefore);

  // Unknown kid even after refetch.
  await rejects({ 'Cf-Access-Jwt-Assertion': await sign(await newKey('key-z'), goodClaims()) }, 'unknown Access signing key');

  // Password comparison.
  assert.equal(access.safeEqual('hunter2', 'hunter2'), true);
  assert.equal(access.safeEqual('hunter2', 'hunter3'), false);
  assert.equal(access.safeEqual('hunter2', 'hunter22'), false);
  assert.equal(access.safeEqual('', 'x'), false);

  console.log('access tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
