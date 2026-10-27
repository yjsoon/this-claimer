// Xero REST integration for Cloudflare Workers.
//
// The official `xero-node` SDK does not run in the Workers runtime, so this
// talks to Xero over raw `fetch` + Web Crypto only. It implements the standard
// OAuth 2.0 Authorization Code flow, persists the (rotating) refresh token in a
// KV namespace, and exposes a small authed-fetch wrapper plus helpers for
// creating ACCPAY (bill) drafts and uploading receipt attachments.
//
// Reference for conventions (token/credentials shape, SG GST): the local
// `xero/` project's `.claude/skills/xero-quote/lib/xero-client.ts`.

export interface XeroEnv {
  XERO_TOKENS: KVNamespace;
  XERO_CLIENT_ID: string;
  XERO_CLIENT_SECRET: string;
  XERO_SCOPES?: string;
  XERO_INPUT_TAXTYPE?: string;
}

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

// accounting.transactions: create bills. accounting.contacts: find/create the
// "Soon Yin Jie" contact. accounting.attachments: upload receipts.
// accounting.settings.read: read TaxRates + Accounts to populate the editor.
const DEFAULT_SCOPES =
  'openid profile email accounting.transactions accounting.contacts accounting.attachments accounting.settings.read offline_access';

const TOKENS_KEY = 'xero_auth';
const EXPIRY_BUFFER_SECONDS = 300;

export interface XeroTokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
}

export interface XeroAuth {
  tokenSet: XeroTokenSet;
  tenantId: string;
  tenantName?: string;
  updatedAt: string;
}

// In-isolate cache so a refresh is immediately visible to later calls in the
// same request without waiting on KV's eventual consistency.
let cachedAuth: XeroAuth | null | undefined;

function scopes(env: XeroEnv): string {
  return env.XERO_SCOPES || DEFAULT_SCOPES;
}

function basicAuth(env: XeroEnv): string {
  return btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
}

// Callback URL is derived from the request origin so the same code works on
// receipts.soon.sg and on a local `wrangler dev` host — both must be registered
// as redirect URIs on the Xero app.
export function redirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/xero/callback`;
}

async function loadAuth(env: XeroEnv): Promise<XeroAuth | null> {
  if (!env.XERO_TOKENS) return null; // KV binding not configured on this deployment
  if (cachedAuth !== undefined) return cachedAuth;
  const raw = await env.XERO_TOKENS.get(TOKENS_KEY);
  if (!raw) {
    cachedAuth = null;
    return cachedAuth;
  }
  try {
    cachedAuth = JSON.parse(raw) as XeroAuth;
  } catch {
    // Corrupted token blob — treat as disconnected and clear it so the user can reconnect.
    cachedAuth = null;
    await env.XERO_TOKENS.delete(TOKENS_KEY);
  }
  return cachedAuth;
}

async function saveAuth(env: XeroEnv, auth: XeroAuth): Promise<void> {
  cachedAuth = auth;
  await env.XERO_TOKENS.put(TOKENS_KEY, JSON.stringify(auth));
}

export async function clearAuth(env: XeroEnv): Promise<void> {
  cachedAuth = null;
  if (!env.XERO_TOKENS) return; // not configured — nothing to clear
  await env.XERO_TOKENS.delete(TOKENS_KEY);
}

// --- OAuth: connect ---------------------------------------------------------

export function buildAuthorizeUrl(env: XeroEnv, requestUrl: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.XERO_CLIENT_ID,
    redirect_uri: redirectUri(requestUrl),
    scope: scopes(env),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function tokenRequest(env: XeroEnv, body: Record<string, string>): Promise<XeroTokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(env)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(`Xero token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in?: number };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 1800),
  };
}

async function pickTenant(accessToken: string): Promise<{ tenantId: string; tenantName?: string }> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Xero /connections ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const conns = (await res.json()) as Array<{ tenantId: string; tenantName?: string; tenantType?: string }>;
  const orgs = conns.filter((c) => c.tenantType === 'ORGANISATION');
  const chosen = orgs[0] || conns[0];
  if (!chosen) throw new Error('No Xero organisation is connected to this app.');
  return { tenantId: chosen.tenantId, tenantName: chosen.tenantName };
}

export async function exchangeCode(env: XeroEnv, requestUrl: string, code: string): Promise<XeroAuth> {
  const tokenSet = await tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(requestUrl),
  });
  const { tenantId, tenantName } = await pickTenant(tokenSet.access_token);
  const auth: XeroAuth = { tokenSet, tenantId, tenantName, updatedAt: new Date().toISOString() };
  await saveAuth(env, auth);
  return auth;
}

// --- OAuth: token lifecycle -------------------------------------------------

// De-duplicate concurrent refreshes — refresh tokens rotate, so parallel
// refreshes (e.g. the Promise.all in /xero/meta) would invalidate each other.
let refreshInFlight: Promise<XeroAuth> | null = null;

async function refreshAuth(env: XeroEnv, failedAccessToken?: string): Promise<XeroAuth> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async (): Promise<XeroAuth> => {
    const current = await loadAuth(env);
    if (!current) throw new Error('Xero is not connected.');
    // If another caller already refreshed past the token that just failed, reuse it.
    if (failedAccessToken && current.tokenSet.access_token !== failedAccessToken) {
      return current;
    }
    const tokenSet = await tokenRequest(env, {
      grant_type: 'refresh_token',
      refresh_token: current.tokenSet.refresh_token,
    });
    const refreshed: XeroAuth = { ...current, tokenSet, updatedAt: new Date().toISOString() };
    await saveAuth(env, refreshed);
    return refreshed;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// Loads stored auth and refreshes proactively when the access token is within
// EXPIRY_BUFFER_SECONDS of expiry. Call once up front for a batch of requests.
export async function getValidAuth(env: XeroEnv): Promise<XeroAuth> {
  if (!env.XERO_TOKENS) {
    throw new Error('Xero is not configured on this deployment (the XERO_TOKENS KV binding is missing — see setup).');
  }
  const auth = await loadAuth(env);
  if (!auth) {
    throw new Error('Xero is not connected. Open the Invoices tab and click "Connect Xero".');
  }
  const now = Math.floor(Date.now() / 1000);
  if (now < auth.tokenSet.expires_at - EXPIRY_BUFFER_SECONDS) return auth;
  return refreshAuth(env, auth.tokenSet.access_token);
}

export interface XeroStatus {
  connected: boolean;
  tenantName?: string;
  updatedAt?: string;
}

export async function getStatus(env: XeroEnv): Promise<XeroStatus> {
  const auth = await loadAuth(env);
  if (!auth) return { connected: false };
  return { connected: true, tenantName: auth.tenantName, updatedAt: auth.updatedAt };
}

// --- Authed fetch wrapper ---------------------------------------------------

export interface XeroFetchInit extends Omit<RequestInit, 'body'> {
  body?: BodyInit;
}

// Calls the Xero API with auth + tenant headers. Retries once on 401 (force
// refresh) and honours 429 Retry-After. `path` is relative to API_BASE unless
// it starts with http.
export async function xeroFetch(env: XeroEnv, path: string, init: XeroFetchInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const auth = await getValidAuth(env);

  const attempt = (accessToken: string, tenantId: string): Promise<Response> =>
    fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });

  let res = await attempt(auth.tokenSet.access_token, auth.tenantId);

  if (res.status === 401) {
    // Use the refreshed auth's tenant too, in case it changed since the first attempt.
    const refreshed = await refreshAuth(env, auth.tokenSet.access_token);
    res = await attempt(refreshed.tokenSet.access_token, refreshed.tenantId);
  }

  // Basic 429 handling: respect Retry-After once (Xero limit: 60/min, 5 concurrent).
  if (res.status === 429) {
    // Retry-After may be missing or an HTTP-date; fall back to 5s when not a finite number.
    const parsed = Number(res.headers.get('Retry-After'));
    const retryAfter = Number.isFinite(parsed) ? parsed : 5;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 30) * 1000));
    const current = await getValidAuth(env);
    res = await attempt(current.tokenSet.access_token, current.tenantId);
  }

  return res;
}

// --- Metadata: tax rates + expense accounts (for the editor dropdowns) ------

export interface XeroTaxRate {
  taxType: string;
  name: string;
  rate: number;
}

export interface XeroAccount {
  code: string;
  name: string;
  type: string;
  taxType?: string;
}

export async function getTaxRates(env: XeroEnv): Promise<XeroTaxRate[]> {
  const res = await xeroFetch(env, '/TaxRates');
  if (!res.ok) throw new Error(`Xero /TaxRates ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    TaxRates?: Array<{ Name?: string; TaxType?: string; Status?: string; EffectiveRate?: number }>;
  };
  return (data.TaxRates || [])
    .filter((r) => r.TaxType && (r.Status || 'ACTIVE') === 'ACTIVE')
    .map((r) => ({ taxType: r.TaxType as string, name: r.Name || (r.TaxType as string), rate: r.EffectiveRate || 0 }));
}

export async function getExpenseAccounts(env: XeroEnv): Promise<XeroAccount[]> {
  // Fetch all accounts and filter by Class in code — robust regardless of which
  // fields the Accounts `where` clause supports, and Class=="EXPENSE" correctly
  // includes Cost of Sales (Type DIRECTCOSTS), which Type=="EXPENSE" would miss.
  const res = await xeroFetch(env, '/Accounts');
  if (!res.ok) throw new Error(`Xero /Accounts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    Accounts?: Array<{ Code?: string; Name?: string; Type?: string; Class?: string; TaxType?: string; Status?: string }>;
  };
  return (data.Accounts || [])
    .filter((a) => a.Code && (a.Status || 'ACTIVE') === 'ACTIVE' && (a.Class || '').toUpperCase() === 'EXPENSE')
    .map((a) => ({ code: a.Code as string, name: a.Name || '', type: a.Type || '', taxType: a.TaxType }));
}

// --- Create bill + attach receipts ------------------------------------------

export interface XeroBillLine {
  description: string;
  accountCode: string;
  taxType: string; // INPUTY24 | NRINPUT | OPINPUT (INPUTY24 is mapped per tenant)
  amount: number; // tax-inclusive SGD
}

export interface XeroBillInput {
  contactName: string;
  date: string; // YYYY-MM-DD
  dueDate?: string; // YYYY-MM-DD
  reference?: string;
  lineItems: XeroBillLine[];
  idempotencyKey?: string;
}

export interface XeroBillResult {
  invoiceID: string;
  invoiceNumber: string;
  url: string;
}

export class XeroBillRejected extends Error {}

export function billEditUrl(invoiceID: string): string {
  return `https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=${encodeURIComponent(invoiceID)}`;
}

function xeroBillInvoiceNumber(reference?: string): string {
  return (reference || '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
}

// Creates a DRAFT ACCPAY (bill). Line amounts are tax-inclusive so Xero
// back-computes GST on standard-rated lines. Contact is matched/created by name.
export async function createBill(env: XeroEnv, bill: XeroBillInput): Promise<XeroBillResult> {
  const inputTaxType = env.XERO_INPUT_TAXTYPE || 'INPUTY24';
  const invoiceNumber = xeroBillInvoiceNumber(bill.reference);
  const body = {
    Type: 'ACCPAY',
    Contact: { Name: bill.contactName },
    Date: bill.date,
    DueDate: bill.dueDate || bill.date,
    Status: 'DRAFT',
    InvoiceNumber: invoiceNumber,
    LineAmountTypes: 'Inclusive',
    LineItems: bill.lineItems.map((l) => ({
      Description: l.description,
      Quantity: 1,
      UnitAmount: Number(l.amount.toFixed(2)),
      AccountCode: l.accountCode,
      // The frontend uses the logical 'INPUTY24'; map to the tenant's actual code.
      TaxType: l.taxType === 'INPUTY24' ? inputTaxType : l.taxType,
    })),
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bill.idempotencyKey) headers['Idempotency-Key'] = bill.idempotencyKey;

  const res = await xeroFetch(env, '/Invoices?summarizeErrors=false', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    let validationRejected = false;
    try { validationRejected = res.status === 400 && JSON.parse(detail).Type === 'ValidationException'; }
    catch { /* An unrecognized response remains an uncertain outcome. */ }
    const message = `Xero create bill ${res.status}: ${detail.slice(0, 400)}`;
    if (validationRejected) throw new XeroBillRejected(message);
    throw new Error(message);
  }
  const data = (await res.json()) as { Invoices?: Array<{
    InvoiceID?: string; InvoiceNumber?: string; StatusAttributeString?: string;
    HasErrors?: boolean; ValidationErrors?: unknown[];
  }> };
  const inv = data.Invoices && data.Invoices[0];
  // summarizeErrors=false reports unsaved invoices inside HTTP 200, and an
  // ERROR can still contain an InvoiceID. Reject before remembering that ID.
  if (inv?.StatusAttributeString === 'ERROR' || inv?.HasErrors === true || inv?.ValidationErrors?.length) {
    throw new XeroBillRejected(`Xero rejected bill validation: ${JSON.stringify(inv.ValidationErrors || []).slice(0, 400)}`);
  }
  if (!inv || !inv.InvoiceID) throw new Error('Xero did not return an invoice id');
  return {
    invoiceID: inv.InvoiceID,
    invoiceNumber: inv.InvoiceNumber || '',
    url: billEditUrl(inv.InvoiceID),
  };
}

// Uploads a single attachment (raw bytes) to an invoice. Xero limits: 25 MB per
// attachment, 10 per document — the caller is responsible for staying within.
export async function attachToInvoice(
  env: XeroEnv,
  invoiceID: string,
  fileName: string,
  bytes: ArrayBuffer | Uint8Array,
  mimeType: string
): Promise<void> {
  const res = await xeroFetch(env, `/Invoices/${invoiceID}/Attachments/${encodeURIComponent(fileName)}`, {
    method: 'POST',
    headers: { 'Content-Type': mimeType },
    body: bytes as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`Xero attach ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// Deterministic idempotency key (<=128 chars) so re-running the same push does
// not create a duplicate bill.
export async function idempotencyKey(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join('|'));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
