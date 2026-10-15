// Cloudflare Access verification.
//
// When receipts.soon.sg sits behind a Cloudflare Access application, Access
// signs every request it lets through with a JWT in the Cf-Access-Jwt-Assertion
// header (browser sessions and service tokens alike). Checking that JWT here
// means the Worker refuses anything that didn't come through Access, such as a
// request to a route or hostname the Access policy doesn't cover.
//
// Enforcement is off until both ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, so
// deploying this before the Access application exists changes nothing.

export interface AccessEnv {
  // e.g. "yourteam.cloudflareaccess.com" (a full https:// URL is accepted too)
  ACCESS_TEAM_DOMAIN?: string;
  // The Access application's Application Audience (AUD) tag.
  ACCESS_AUD?: string;
}

export type AccessResult =
  | { enforced: false }
  | { enforced: true; ok: true; identity: string }
  | { enforced: true; ok: false; reason: string };

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const jwksCache = new Map<string, { keys: Map<string, CryptoKey>; expiresAt: number }>();

export function teamOrigin(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

async function fetchKeys(origin: string, forceRefresh: boolean): Promise<Map<string, CryptoKey>> {
  const cached = jwksCache.get(origin);
  if (cached && !forceRefresh && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetch(`${origin}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs request failed (${response.status})`);
  const body = (await response.json()) as { keys?: Jwk[] };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    keys.set(jwk.kid, key);
  }
  jwksCache.set(origin, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

function readToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header.trim();
  // Access also sets this cookie on browser sessions.
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

export async function verifyAccess(request: Request, env: AccessEnv): Promise<AccessResult> {
  const domain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!domain || !aud) return { enforced: false };

  const fail = (reason: string): AccessResult => ({ enforced: true, ok: false, reason });
  const token = readToken(request);
  if (!token) return fail('missing Access token');

  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed Access token');

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return fail('malformed Access token');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return fail('unsupported Access token');

  const origin = teamOrigin(domain);
  let key: CryptoKey | undefined;
  try {
    key = (await fetchKeys(origin, false)).get(header.kid);
    // Access rotates its signing keys; refetch once for an unknown kid.
    if (!key) key = (await fetchKeys(origin, true)).get(header.kid);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Access certs unavailable');
  }
  if (!key) return fail('unknown Access signing key');

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let valid = false;
  try {
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(parts[2]), signed);
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad Access token signature');

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return fail('Access token is for another application');
  if (payload.iss !== origin) return fail('Access token from another team');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < now) {
    return fail('expired Access token');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SECONDS > now) {
    return fail('Access token not yet valid');
  }

  // Browser sessions carry an email; service tokens carry common_name instead.
  const identity =
    (typeof payload.email === 'string' && payload.email) ||
    (typeof payload.common_name === 'string' && payload.common_name) ||
    'unknown';
  return { enforced: true, ok: true, identity };
}

// Constant-time string comparison for the shared app password.
export function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ (right[i % Math.max(right.length, 1)] ?? 0);
  return diff === 0;
}
