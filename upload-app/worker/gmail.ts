// Gmail receipt import for Cloudflare Workers.
//
// Links one or more Gmail accounts over Google OAuth 2.0 (read-only scope),
// stores their refresh tokens in KV, and scans each inbox on a schedule for
// receipt emails. Two kinds of receipt are picked up:
//
//   - attachments: PDF or image attachments on emails that look like receipts
//     or invoices (GMAIL_RECEIPT_QUERY overrides the default search).
//   - rendered HTML: ride receipts that only exist as an email body (Grab,
//     Gojek), printed to PDF through Cloudflare Browser Rendering. Skipped
//     unless CF_BROWSER_RENDERING_TOKEN is set.
//
// The module never writes to Gmail. It remembers which messages it has
// already looked at (per account) so a message is imported at most once, and
// hands each file to the caller's `importFile` callback, which stores it in R2
// exactly like a manual upload.

export interface GmailEnv {
  GMAIL_STATE: KVNamespace;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GMAIL_RECEIPT_QUERY?: string;
  GMAIL_INITIAL_LOOKBACK_DAYS?: string;
  CF_ACCOUNT_ID?: string;
  CF_BROWSER_RENDERING_TOKEN?: string;
}

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const ACCOUNTS_KEY = 'gmail_accounts';
const LOCK_KEY = 'gmail_scan_lock';
const EXPIRY_BUFFER_SECONDS = 120;
const MAX_SEEN_IDS = 1500;
// Messages fetched in full per account per scan. Anything beyond waits for the
// next run (the scan cursor only moves forward once a query is drained).
const MAX_MESSAGES_PER_ACCOUNT = 25;
const LIST_PAGE_SIZE = 50;
// Re-scan a little before the last completed scan so mail that arrived
// mid-scan, or with a skewed Date header, is not missed. Seen ids dedupe it.
const SCAN_OVERLAP_SECONDS = 2 * 24 * 60 * 60;
const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Smaller images are almost always logos or signature graphics.
const MIN_IMAGE_BYTES = 30 * 1024;

export const DEFAULT_RECEIPT_QUERY =
  'has:attachment {filename:pdf filename:jpg filename:jpeg filename:png} ' +
  '{receipt invoice "tax invoice" "payment confirmation" "payment received" "order confirmation" "your order" billing} ' +
  '-in:sent -in:chats -in:drafts';

const PDF_MIME = 'application/pdf';
const IMAGE_MIMES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/webp': '.webp',
};

export interface GmailAccount {
  email: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number; // unix seconds
  connectedAt: string;
  // Unix seconds at which the last scan that drained every query started.
  lastCompleteScanAt?: number;
  lastScanAt?: string;
  lastScanSummary?: string;
  lastScanError?: string;
  // Set when Google rejected the stored refresh token (revoked, expired, or
  // password changed); the account must be linked again.
  needsReconnect?: boolean;
  seenIds: string[];
}

export interface GmailAccountStatus {
  email: string;
  connectedAt: string;
  lastScanAt?: string;
  lastScanSummary?: string;
  lastScanError?: string;
  needsReconnect?: boolean;
}

export interface GmailStatus {
  configured: boolean;
  clientSource?: 'secret' | 'app';
  clientId?: string;
  redirectUri: string;
  htmlReceipts: boolean;
  query: string;
  accounts: GmailAccountStatus[];
}

export interface GmailImportFile {
  account: string;
  messageId: string;
  subject: string;
  filename: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

export type ImportFile = (file: GmailImportFile) => Promise<{ key: string } | { error: string }>;

export interface GmailScanAccountResult {
  email: string;
  // True when the scan could not run at all for this account.
  failed?: boolean;
  checked: number;
  imported: Array<{ key: string; filename: string; subject: string }>;
  errors: string[];
  more: boolean;
}

export interface GmailScanResult {
  skipped?: string;
  accounts: GmailScanAccountResult[];
}

// --- Google OAuth client ------------------------------------------------------

// The OAuth client comes from the GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET Worker
// secrets when set; otherwise from KV, where the Gmail panel saves what the
// user pastes in. The secret is write-only from the app: status never returns it.
const CLIENT_KEY = 'gmail_oauth_client';
const CLIENT_ID_RE = /^[\w.-]+\.apps\.googleusercontent\.com$/;

interface GoogleClient {
  id: string;
  secret: string;
  source: 'secret' | 'app';
}

async function loadClient(env: GmailEnv): Promise<GoogleClient | null> {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, source: 'secret' };
  }
  if (!env.GMAIL_STATE) return null;
  const raw = await env.GMAIL_STATE.get(CLIENT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: string; secret?: string };
    return parsed.id && parsed.secret ? { id: parsed.id, secret: parsed.secret, source: 'app' } : null;
  } catch {
    return null;
  }
}

async function requireClient(env: GmailEnv): Promise<GoogleClient> {
  const client = await loadClient(env);
  if (!client) throw new Error('Gmail import is not set up: no Google OAuth client.');
  return client;
}

export class GmailClientInputError extends Error {}

export async function saveClient(env: GmailEnv, id: string, secret: string): Promise<void> {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    throw new GmailClientInputError('The Google client is set as Worker secrets; change it there instead.');
  }
  const clientId = id.trim();
  const clientSecret = secret.trim();
  if (!CLIENT_ID_RE.test(clientId)) {
    throw new GmailClientInputError('That does not look like a Google client ID (it ends in .apps.googleusercontent.com).');
  }
  if (clientSecret.length < 10 || /\s/.test(clientSecret)) {
    throw new GmailClientInputError('That does not look like a Google client secret.');
  }
  await env.GMAIL_STATE.put(CLIENT_KEY, JSON.stringify({ id: clientId, secret: clientSecret }));
}

export async function clearClient(env: GmailEnv): Promise<void> {
  await env.GMAIL_STATE.delete(CLIENT_KEY);
}

export async function isConfigured(env: GmailEnv): Promise<boolean> {
  return Boolean(env.GMAIL_STATE && (await loadClient(env)));
}

function htmlReceiptsEnabled(env: GmailEnv): boolean {
  return Boolean(env.CF_ACCOUNT_ID && env.CF_BROWSER_RENDERING_TOKEN);
}

function receiptQuery(env: GmailEnv): string {
  return (env.GMAIL_RECEIPT_QUERY || '').trim() || DEFAULT_RECEIPT_QUERY;
}

// --- Account storage -------------------------------------------------------

async function loadAccounts(env: GmailEnv): Promise<GmailAccount[]> {
  if (!env.GMAIL_STATE) return [];
  const raw = await env.GMAIL_STATE.get(ACCOUNTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as GmailAccount[];
    return Array.isArray(parsed) ? parsed.map((a) => ({ ...a, seenIds: a.seenIds || [] })) : [];
  } catch {
    return [];
  }
}

async function saveAccounts(env: GmailEnv, accounts: GmailAccount[]): Promise<void> {
  await env.GMAIL_STATE.put(ACCOUNTS_KEY, JSON.stringify(accounts));
}

// Read-modify-write of a single account, so a long scan does not clobber an
// account connected or removed while it ran.
async function updateAccount(env: GmailEnv, email: string, patch: (account: GmailAccount) => GmailAccount): Promise<void> {
  const accounts = await loadAccounts(env);
  const index = accounts.findIndex((a) => a.email === email);
  if (index === -1) return;
  accounts[index] = patch(accounts[index]);
  await saveAccounts(env, accounts);
}

export async function getStatus(env: GmailEnv, requestUrl: string): Promise<GmailStatus> {
  const accounts = await loadAccounts(env);
  const client = env.GMAIL_STATE ? await loadClient(env) : null;
  return {
    configured: Boolean(client),
    clientSource: client?.source,
    clientId: client?.id,
    redirectUri: redirectUri(requestUrl),
    htmlReceipts: htmlReceiptsEnabled(env),
    query: receiptQuery(env),
    accounts: accounts.map((a) => ({
      email: a.email,
      connectedAt: a.connectedAt,
      lastScanAt: a.lastScanAt,
      lastScanSummary: a.lastScanSummary,
      lastScanError: a.lastScanError,
      needsReconnect: a.needsReconnect,
    })),
  };
}

export async function removeAccount(env: GmailEnv, email: string): Promise<boolean> {
  const accounts = await loadAccounts(env);
  const account = accounts.find((a) => a.email === email);
  if (!account) return false;
  await saveAccounts(env, accounts.filter((a) => a.email !== email));
  // Best effort: revoke the grant so the account's Google security page drops it.
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(account.refreshToken)}`, { method: 'POST' });
  } catch {
    /* already removed locally */
  }
  return true;
}

// --- OAuth -------------------------------------------------------------------

export function redirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/gmail/callback`;
}

export async function buildAuthorizeUrl(env: GmailEnv, requestUrl: string, state: string): Promise<string> {
  const client = await requireClient(env);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.id,
    redirect_uri: redirectUri(requestUrl),
    scope: SCOPE,
    // offline + consent: always return a refresh token, even on a reconnect.
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

class GoogleTokenError extends Error {
  // invalid_grant: the refresh token was revoked or expired.
  readonly revoked: boolean;

  constructor(status: number, body: string) {
    super(`Google token endpoint ${status}: ${body.slice(0, 300)}`);
    this.revoked = status === 400 && body.includes('invalid_grant');
  }
}

async function tokenRequest(env: GmailEnv, body: Record<string, string>): Promise<GoogleTokenResponse> {
  const client = await requireClient(env);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      ...body,
    }).toString(),
  });
  if (!res.ok) {
    throw new GoogleTokenError(res.status, await res.text());
  }
  return (await res.json()) as GoogleTokenResponse;
}

export async function exchangeCode(env: GmailEnv, requestUrl: string, code: string): Promise<string> {
  const token = await tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(requestUrl),
  });
  if (!token.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  }
  if (token.scope && !token.scope.split(' ').includes(SCOPE)) {
    throw new Error('Gmail read access was not granted. Connect again and tick the Gmail permission.');
  }

  const profileRes = await fetch(`${API_BASE}/profile`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profileRes.ok) {
    throw new Error(`Gmail profile ${profileRes.status}: ${(await profileRes.text()).slice(0, 200)}`);
  }
  const profile = (await profileRes.json()) as { emailAddress?: string };
  const email = (profile.emailAddress || '').toLowerCase();
  if (!email) throw new Error('Gmail did not report the account address.');

  const accounts = await loadAccounts(env);
  const existing = accounts.find((a) => a.email === email);
  const next: GmailAccount = {
    // Reconnecting keeps the scan cursor and seen ids, so nothing is re-imported.
    ...(existing || { seenIds: [], connectedAt: new Date().toISOString() }),
    email,
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (token.expires_in || 3600),
    lastScanError: undefined,
    needsReconnect: undefined,
  };
  await saveAccounts(env, [...accounts.filter((a) => a.email !== email), next]);
  return email;
}

async function accessTokenFor(env: GmailEnv, account: GmailAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (account.accessToken && account.expiresAt && now < account.expiresAt - EXPIRY_BUFFER_SECONDS) {
    return account.accessToken;
  }
  const token = await tokenRequest(env, {
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
  });
  account.accessToken = token.access_token;
  account.expiresAt = now + (token.expires_in || 3600);
  if (token.refresh_token) account.refreshToken = token.refresh_token;
  return token.access_token;
}

// --- Gmail API ---------------------------------------------------------------

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart;
}

async function gmailFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Gmail ${path.split('?')[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// Ids matching `query`, newest first, stopping once `limit` unseen ids are
// found. `drained` is false when more unseen results may remain.
async function listUnseenIds(
  accessToken: string,
  query: string,
  seen: Set<string>,
  limit: number
): Promise<{ ids: string[]; drained: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: query, maxResults: String(LIST_PAGE_SIZE) });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await gmailFetch<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      accessToken,
      `/messages?${params.toString()}`
    );
    for (const message of page.messages || []) {
      if (seen.has(message.id) || ids.includes(message.id)) continue;
      if (ids.length >= limit) return { ids, drained: false };
      ids.push(message.id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { ids, drained: true };
}

function decodeBase64Url(data: string): Uint8Array {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function header(part: GmailPart | undefined, name: string): string {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value || '';
}

function walkParts(part: GmailPart | undefined, visit: (part: GmailPart) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts || []) walkParts(child, visit);
}

function extensionOf(filename: string): string {
  return (filename.toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0];
}

// Decide whether a MIME part is a receipt file worth importing, and with
// which content type.
function receiptFileType(part: GmailPart): string | null {
  const filename = part.filename || '';
  if (!filename || !part.body?.attachmentId) return null;
  const size = part.body.size || 0;
  if (size > MAX_ATTACHMENT_BYTES) return null;

  const mime = (part.mimeType || '').toLowerCase();
  const ext = extensionOf(filename);
  if (mime === PDF_MIME || ext === '.pdf') return PDF_MIME;

  const imageMime = IMAGE_MIMES[mime]
    ? mime
    : Object.keys(IMAGE_MIMES).find((m) => IMAGE_MIMES[m] === (ext === '.jpeg' ? '.jpg' : ext));
  if (!imageMime) return null;
  // Inline images are logos and banners; a photographed receipt is attached.
  if (/^\s*inline/i.test(header(part, 'Content-Disposition'))) return null;
  if (size < MIN_IMAGE_BYTES) return null;
  return imageMime === 'image/jpg' ? 'image/jpeg' : imageMime;
}

function findHtml(part: GmailPart | undefined): string | null {
  let html: string | null = null;
  walkParts(part, (p) => {
    if (!html && p.mimeType === 'text/html' && p.body?.data) {
      html = new TextDecoder().decode(decodeBase64Url(p.body.data));
    }
  });
  return html;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|td|tr|table|h1|h2|h3)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#36;/g, '$')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

// --- HTML ride receipts ------------------------------------------------------

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

function formatDateParts(year: string, month: string, day: string): string {
  return `${year}-${MONTHS[month.toLowerCase()] ?? '01'}-${day.padStart(2, '0')}`;
}

interface HtmlReceiptRule {
  provider: string;
  query: string;
  isReceipt: (text: string) => boolean;
  details: (text: string) => { date: string; amount: string };
}

// Mirrors scripts/export-ride-receipt.ts so the cron and the local export
// produce the same files. GrabFood is excluded, as it is there.
export const HTML_RECEIPT_RULES: HtmlReceiptRule[] = [
  {
    provider: 'grab',
    query: 'from:grab subject:"Your Grab E-Receipt"',
    isReceipt: (text) =>
      !/\bGrab\s*Food\b|\bGrabFood\b/i.test(text) &&
      /Booking ID:\s*A-/i.test(text) &&
      /Picked up on/i.test(text) &&
      /Total Paid/i.test(text),
    details: (text) => {
      const amount =
        text.match(/Total Paid\s+SGD\s*([0-9]+(?:\.[0-9]{2})?)/i)?.[1] ??
        text.match(/Total Paid\s+([0-9]+(?:\.[0-9]{2})?)/i)?.[1] ??
        'unknown';
      const picked = text.match(/Picked up on\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
      return { amount, date: picked ? formatDateParts(picked[3], picked[2], picked[1]) : 'unknown-date' };
    },
  },
  {
    provider: 'gojek',
    query: '"Your trip with Gojek"',
    isReceipt: (text) =>
      /Order ID:\s*RB-/i.test(text) && /Thanks for ordering Gojek/i.test(text) && /Total paid\s+S\$/i.test(text),
    details: (text) => {
      const amount =
        text.match(/Total paid\s+S\$\s*([0-9]+(?:\.[0-9]{2})?)/i)?.[1] ??
        text.match(/Total payment\s+S\$\s*([0-9]+(?:\.[0-9]{2})?)/i)?.[1] ??
        'unknown';
      const m =
        text.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i) ??
        text.match(/Picked up on\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
      return { amount, date: m ? formatDateParts(m[3], m[2], m[1]) : 'unknown-date' };
    },
  },
];

async function renderHtmlToPdf(env: GmailEnv, html: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/pdf`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_BROWSER_RENDERING_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html,
        gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
        pdfOptions: {
          format: 'a4',
          printBackground: true,
          margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
        },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Browser Rendering ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.arrayBuffer();
}

// --- Scanning ----------------------------------------------------------------

interface ScanContext {
  env: GmailEnv;
  account: GmailAccount;
  accessToken: string;
  importFile: ImportFile;
  result: GmailScanAccountResult;
}

async function importAttachments(ctx: ScanContext, messageId: string): Promise<void> {
  const message = await gmailFetch<GmailMessage>(ctx.accessToken, `/messages/${messageId}?format=full`);
  const subject = header(message.payload, 'Subject');
  const files: GmailPart[] = [];
  walkParts(message.payload, (part) => {
    if (receiptFileType(part)) files.push(part);
  });

  for (const part of files) {
    const mimeType = receiptFileType(part) as string;
    const attachment = await gmailFetch<{ data?: string }>(
      ctx.accessToken,
      `/messages/${messageId}/attachments/${encodeURIComponent(part.body?.attachmentId || '')}`
    );
    if (!attachment.data) continue;
    const bytes = decodeBase64Url(attachment.data);
    const outcome = await ctx.importFile({
      account: ctx.account.email,
      messageId,
      subject,
      filename: part.filename || `gmail-${messageId}${mimeType === PDF_MIME ? '.pdf' : '.jpg'}`,
      mimeType,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });
    if ('key' in outcome) {
      ctx.result.imported.push({ key: outcome.key, filename: part.filename || '', subject });
    } else {
      ctx.result.errors.push(`${part.filename}: ${outcome.error}`);
    }
  }
}

async function importHtmlReceipt(ctx: ScanContext, rule: HtmlReceiptRule, messageId: string): Promise<void> {
  const message = await gmailFetch<GmailMessage>(ctx.accessToken, `/messages/${messageId}?format=full`);
  const html = findHtml(message.payload);
  if (!html) return;
  const text = htmlToText(html);
  if (!rule.isReceipt(text)) return;

  const { date, amount } = rule.details(text);
  const subject = header(message.payload, 'Subject');
  const filename = `${rule.provider}_${date}_${amount}.pdf`;
  const pdf = await renderHtmlToPdf(ctx.env, html);
  const outcome = await ctx.importFile({
    account: ctx.account.email,
    messageId,
    subject,
    filename,
    mimeType: PDF_MIME,
    bytes: pdf,
  });
  if ('key' in outcome) {
    ctx.result.imported.push({ key: outcome.key, filename, subject });
  } else {
    ctx.result.errors.push(`${filename}: ${outcome.error}`);
  }
}

function afterClause(env: GmailEnv, account: GmailAccount): string {
  const lookbackDays = Number.parseInt(env.GMAIL_INITIAL_LOOKBACK_DAYS || '', 10);
  const since = account.lastCompleteScanAt
    ? account.lastCompleteScanAt - SCAN_OVERLAP_SECONDS
    : Math.floor(Date.now() / 1000) - (Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : DEFAULT_LOOKBACK_DAYS) * 86400;
  // Gmail accepts epoch seconds for after:.
  return `after:${since}`;
}

function summarise(result: GmailScanAccountResult): string {
  const receipts = `${result.imported.length} receipt${result.imported.length === 1 ? '' : 's'}`;
  const parts = [`${receipts} from ${result.checked} new email${result.checked === 1 ? '' : 's'}`];
  if (result.more) parts.push('more on the next check');
  if (result.errors.length) parts.push(`${result.errors.length} to retry`);
  return parts.join(', ');
}

async function scanAccount(env: GmailEnv, email: string, importFile: ImportFile): Promise<GmailScanAccountResult> {
  const result: GmailScanAccountResult = { email, checked: 0, imported: [], errors: [], more: false };
  const account = (await loadAccounts(env)).find((a) => a.email === email);
  if (!account) return result;

  const scanStartedAt = Math.floor(Date.now() / 1000);
  const seen = new Set(account.seenIds);
  const newlySeen: string[] = [];
  let fatal: string | undefined;
  let revoked = false;

  try {
    const accessToken = await accessTokenFor(env, account);
    const ctx: ScanContext = { env, account, accessToken, importFile, result };
    const after = afterClause(env, account);
    let budget = MAX_MESSAGES_PER_ACCOUNT;

    const passes: Array<{ query: string; handle: (id: string) => Promise<void> }> = [
      { query: `${receiptQuery(env)} ${after}`, handle: (id) => importAttachments(ctx, id) },
    ];
    if (htmlReceiptsEnabled(env)) {
      for (const rule of HTML_RECEIPT_RULES) {
        passes.push({ query: `${rule.query} ${after}`, handle: (id) => importHtmlReceipt(ctx, rule, id) });
      }
    }

    for (const pass of passes) {
      if (budget <= 0) {
        result.more = true;
        break;
      }
      const { ids, drained } = await listUnseenIds(accessToken, pass.query, seen, budget);
      if (!drained) result.more = true;
      for (const id of ids) {
        budget -= 1;
        result.checked += 1;
        try {
          await pass.handle(id);
          seen.add(id);
          newlySeen.push(id);
        } catch (error) {
          // Leave the id unseen so the next scan retries it.
          result.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error);
    revoked = error instanceof GoogleTokenError && error.revoked;
    result.failed = true;
    result.errors.push(fatal);
  }

  await updateAccount(env, email, (current) => ({
    ...current,
    accessToken: account.accessToken,
    expiresAt: account.expiresAt,
    refreshToken: account.refreshToken,
    seenIds: [...current.seenIds, ...newlySeen].slice(-MAX_SEEN_IDS),
    lastCompleteScanAt: !fatal && !result.more ? scanStartedAt : current.lastCompleteScanAt,
    lastScanAt: new Date().toISOString(),
    lastScanSummary: fatal ? undefined : summarise(result),
    lastScanError: fatal,
    needsReconnect: revoked || undefined,
  }));
  return result;
}

// Scans every linked account (or just `onlyEmail`). A short KV lock keeps the
// cron and a manual "Scan now" from importing the same email twice.
export async function scanAll(env: GmailEnv, importFile: ImportFile, onlyEmail?: string): Promise<GmailScanResult> {
  if (!(await isConfigured(env))) return { skipped: 'not_configured', accounts: [] };
  const accounts = await loadAccounts(env);
  const targets = accounts.filter((a) => !onlyEmail || a.email === onlyEmail);
  if (!targets.length) return { skipped: 'no_accounts', accounts: [] };

  if (await env.GMAIL_STATE.get(LOCK_KEY)) return { skipped: 'scan_in_progress', accounts: [] };
  await env.GMAIL_STATE.put(LOCK_KEY, new Date().toISOString(), { expirationTtl: 300 });
  try {
    const results: GmailScanAccountResult[] = [];
    for (const account of targets) {
      results.push(await scanAccount(env, account.email, importFile));
    }
    return { accounts: results };
  } finally {
    await env.GMAIL_STATE.delete(LOCK_KEY);
  }
}
