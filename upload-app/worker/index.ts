import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
// @ts-ignore
import manifestJSON from '__STATIC_CONTENT_MANIFEST';
import * as xero from './xero';
import * as gmail from './gmail';
import * as ai from './ai';
import { verifyAccess, safeEqual } from './access';
import { PDFDocument } from 'pdf-lib';
import { INVOICE_EDITS_PREFIX, listInvoiceEditKeys, readInvoiceEdits, invoiceEditsResponse, type InvoiceEdits } from './invoice-edits';
import { OAUTH_PREFIX, beginOAuth, consumeOAuth } from './oauth-state';

function isInternalKey(key: string): boolean {
  return key.startsWith(INVOICE_EDITS_PREFIX) || key.startsWith(OAUTH_PREFIX);
}

const assetManifest = JSON.parse(manifestJSON);

// Upload constraints
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.pdf'];
const ALLOWED_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'application/x-pdf': '.pdf',
};
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const DEFAULT_AMOUNT_TAG_BATCH = 3;
const MAX_AMOUNT_TAG_BATCH = 8;
const DEFAULT_GST_TAG_BATCH = 3;
const MAX_GST_TAG_BATCH = 8;
const MINIMAX_VLM_URL = 'https://api.minimax.io/v1/coding_plan/vlm';
// The MiniMax coding-plan VLM endpoint only accepts images; PDFs and HEIC go
// to Gemini instead.
const MINIMAX_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const RECEIPT_METADATA_CONCURRENCY = 25;
const FX_API_BASE = 'https://api.frankfurter.dev/v1';
const USD_SURCHARGE_RATE = 0.0325;
const FX_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Magic byte signatures for file type validation
// Each entry is [offset, bytes[]] to check
const MAGIC_BYTES: Record<string, { offset: number; bytes: number[] }> = {
  'image/jpeg': { offset: 0, bytes: [0xff, 0xd8, 0xff] },
  'image/jpg': { offset: 0, bytes: [0xff, 0xd8, 0xff] },
  'image/png': { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/gif': { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  'image/webp': { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  'application/pdf': { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  'image/heic': { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ftyp at offset 4
  'image/heif': { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ftyp at offset 4
};

// Validate file magic bytes
function validateMagicBytes(buffer: ArrayBuffer, mimeType: string): boolean {
  const sig = MAGIC_BYTES[mimeType];
  if (!sig) return false;

  const bytes = new Uint8Array(buffer.slice(0, 12));
  if (!sig.bytes.every((b, i) => bytes[sig.offset + i] === b)) return false;
  const brand = String.fromCharCode(...bytes.slice(8, 12));
  if (mimeType === 'image/webp') return brand === 'WEBP';
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
  }
  return true;
}

// Validate file extension
function getExtension(filename: string): string {
  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : '';
}

function normaliseMimeType(mimeType: string): string {
  return mimeType.toLowerCase().split(';')[0].trim();
}

function getUploadExtension(filename: string, mimeType: string): string {
  const ext = getExtension(filename);
  if (ALLOWED_EXTENSIONS.includes(ext)) return ext;
  if (ext) return '';
  return ALLOWED_MIME_EXTENSIONS[normaliseMimeType(mimeType)] || '';
}

function buildStorageFilename(filename: string, inferredExt: string): string {
  if (getExtension(filename)) return filename;

  const trimmed = filename.trim();
  const base = trimmed.length > 0 ? trimmed : 'receipt';
  return `${base}${inferredExt}`;
}

interface Env {
  RECEIPTS: R2Bucket;
  __STATIC_CONTENT: KVNamespace;
  AUTH_PASSWORD: string;
  YNAB_API_KEY: string;
  YNAB_BUDGET_ID: string;
  HOWMUCH_PAT?: string;
  HOWMUCH_PLAN_ID?: string;
  HOWMUCH_API_URL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  // Receipt vision tagging (amount extraction + GST detection) and smart
  // matching (see worker/ai.ts). VISION_PROVIDER picks the first provider to
  // try ('minimax' | 'anthropic' | 'gemini'); the others with keys are the
  // fallbacks. Keys and choices saved in the app's Settings > AI (APP_SETTINGS
  // KV) win over these secrets/vars.
  MINIMAX_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  VISION_PROVIDER?: string;
  APP_SETTINGS?: KVNamespace;
  CORS_ORIGIN?: string; // Optional: lock CORS to specific origin
  // Cloudflare Access (see worker/access.ts). When both are set, every request
  // must carry a valid Access JWT for this application.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Limits wrong-password attempts per client IP (wrangler.toml [[ratelimits]]).
  AUTH_RATE_LIMITER?: RateLimit;
  // Xero integration (see worker/xero.ts). Client id/secret are secrets;
  // XERO_TOKENS stores the rotating refresh token.
  XERO_TOKENS: KVNamespace;
  XERO_CLIENT_ID: string;
  XERO_CLIENT_SECRET: string;
  XERO_SCOPES?: string;
  XERO_INPUT_TAXTYPE?: string;
  // Gmail receipt import (see worker/gmail.ts). GOOGLE_CLIENT_ID/SECRET and
  // CF_BROWSER_RENDERING_TOKEN are secrets; GMAIL_STATE holds linked accounts.
  GMAIL_STATE: KVNamespace;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GMAIL_RECEIPT_QUERY?: string;
  GMAIL_INITIAL_LOOKBACK_DAYS?: string;
  CF_ACCOUNT_ID?: string;
  CF_BROWSER_RENDERING_TOKEN?: string;
}

interface YnabTransaction {
  id: string;
  date: string;
  amount: number;
  account_name: string | null;
  payee_name: string | null;
  memo: string | null;
  category_name?: string | null;
  transfer_transaction_id: string | null;
  subtransactions?: YnabSubtransaction[];
}

interface YnabSubtransaction {
  id: string;
  transaction_id: string;
  amount: number;
  memo: string | null;
  payee_name?: string | null;
  category_name?: string | null;
}

interface YnabTodo {
  id: string;
  date: string;
  payee: string;
  amount: number;
  description: string;
  accountName: string;
  categoryName?: string;
  source: 'transaction' | 'subtransaction';
  parentTransactionId?: string;
  sourceUrl?: string;
}

type ClaimsBackend = 'howmuch' | 'ynab';

interface ClaimsBackendConfig {
  apiUrl: string;
  token: string;
  planId: string;
}

interface GeminiAmountResult {
  amount: number | null;
  confidence: number;
  currency: string;
  receiptDate: string | null;
  receiptDateConfidence: number;
  vendor: string | null;
  purpose: string | null;
  model: string;
}

interface AmountTagResult {
  key: string;
  status: 'tagged' | 'skipped' | 'failed';
  amount?: number;
  reason?: string;
}

interface GstDetectionResult {
  gstShown: boolean;
  gstAmount: number | null;
  confidence: number;
  source: ai.AiProvider;
}

interface GstTagResult {
  key: string;
  status: 'tagged' | 'skipped' | 'failed';
  gstShown?: boolean;
  gstAmount?: number | null;
  source?: string;
  reason?: string;
}

interface FxRateResult {
  rate: number;
  dateUsed: string;
}

interface LinkedClaimPayload {
  id: string;
  description: string;
  amount?: number;
  date?: string;
}

interface PushLineItem {
  receiptKey: string;
  ynabClaimId?: string | null;
  claimSource?: 'transaction' | 'subtransaction' | null;
  claimDescription?: string | null;
  claimsBackend?: ClaimsBackend;
  date: string;
  description: string;
  accountCode: string;
  taxType: string;
  currency?: string;
  amount: number;
}

interface ReceiptSummary {
  key: string;
  size: number;
  uploaded: string;
  storageUploaded: string;
  originalName?: string;
  source?: string;
  gmailAccount?: string;
  gmailMessageId?: string;
  gmailSubject?: string;
  linkedClaimId?: string;
  linkedClaimIds: string[];
  linkedClaimsBackend?: ClaimsBackend;
  linkedClaimDescription?: string;
  receiptDate?: string;
  receiptDateSource?: string;
  detectedReceiptDate?: string;
  detectedReceiptDateConfidence?: number;
  taggedAmount?: number;
  taggedCurrency?: string;
  taggedConfidence?: number;
  taggedVendor?: string;
  taggedPurpose?: string;
  taggedStatus?: string;
  taggedModel?: string;
  taggedAt?: string;
  taggedError?: string;
  taggedFxStatus?: string;
  taggedFxError?: string;
  taggedFxBaseDate?: string;
  taggedFxDateUsed?: string;
  taggedFxRateUsdSgd?: number;
  taggedAmountSgdApprox?: number;
  taggedAmountSgdApproxPlus325?: number;
  taggedGstShown?: boolean;
  taggedGstAmount?: number;
  taggedGstConfidence?: number;
  taggedGstSource?: string;
  invoiceEdits?: InvoiceEdits;
  // Set once the linked YNAB claim has been marked claimed for this bill.
  xeroInvoiceId?: string;
  invoicedAt?: string;
  // Portal leftover from a push attempt. Not proof a bill exists in Xero.
  xeroPendingInvoiceId?: string;
  xeroPendingInvoiceNumber?: string;
  xeroPendingAt?: string;
  xeroPendingClaimsBackend?: ClaimsBackend;
}

interface ReceiptListResult {
  receipts: ReceiptSummary[];
  cursor: string | null;
  hasMore: boolean;
  timings: {
    listMs: number;
    metadataMs: number;
    headFallbacks: number;
  };
}

// Server-Timing lets the browser's Network → Timing panel show where a slow
// request spent its time (R2 vs the claims backend) without any extra tooling.
function serverTimingHeader(entries: Array<{ name: string; ms: number; desc?: string }>): string {
  return entries
    .map(({ name, ms, desc }) => `${name};dur=${Math.round(ms)}${desc ? `;desc="${desc.replace(/"/g, "'")}"` : ''}`)
    .join(', ');
}

class ClaimsBackendApiError extends Error {
  status: number;
  details: string;

  constructor(backend: ClaimsBackend, status: number, details: string) {
    super(`${backend === 'howmuch' ? 'HowMuch' : 'YNAB'} API error`);
    this.status = status;
    this.details = details;
  }
}

class ClaimsBackendInputError extends Error {}

const fxRateCache = new Map<string, { value: FxRateResult; expiresAt: number }>();

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function parseMetadataNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitiseLabel(value: string | null | undefined, maxLength = 80): string | null {
  if (!value) return null;
  const cleaned = value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s&.,'()\-\/]/g, '')
    .slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

function parseLinkedClaimIds(
  linkedClaimIdsValue: string | undefined,
  linkedClaimIdValue: string | undefined
): string[] {
  const parsed: string[] = [];

  if (linkedClaimIdsValue) {
    try {
      const json = JSON.parse(linkedClaimIdsValue);
      if (Array.isArray(json)) {
        json.forEach((value) => {
          if (typeof value === 'string' && value.trim().length > 0) {
            parsed.push(value.trim());
          }
        });
      }
    } catch {
      // Ignore malformed legacy metadata and fall back to single-link field.
    }
  }

  if (linkedClaimIdValue && linkedClaimIdValue.trim().length > 0) {
    parsed.unshift(linkedClaimIdValue.trim());
  }

  return Array.from(new Set(parsed));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseConfidence(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '0'));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function extractIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (ISO_DATE_RE.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function getDateFromIsoDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  if (ISO_DATE_RE.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 180);
}

function getDefaultYnabSinceDate(): string {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  return sixMonthsAgo.toISOString().split('T')[0];
}

function parseTodoDescription(memo: string | null | undefined): string | null {
  if (!memo) return null;
  const todoPattern = /^TODO[:\s]/i;
  if (!todoPattern.test(memo)) return null;
  const description = memo.replace(/^TODO[:\s]\s*/i, '').trim();
  return description || 'Claim';
}

function toYnabTodoFromTransaction(transaction: YnabTransaction): YnabTodo | null {
  const description = parseTodoDescription(transaction.memo);
  if (!description) return null;

  // For transfers, only keep the outflow side to avoid duplicate TODOs.
  if (transaction.transfer_transaction_id && transaction.amount >= 0) {
    return null;
  }

  return {
    id: transaction.id,
    date: transaction.date,
    payee: transaction.payee_name || 'Unknown',
    amount: Math.abs(transaction.amount) / 1000,
    description,
    accountName: transaction.account_name || 'Unknown account',
    categoryName: transaction.category_name || undefined,
    source: 'transaction',
  };
}

function toYnabTodoFromSubtransaction(parent: YnabTransaction, subtransaction: YnabSubtransaction): YnabTodo | null {
  const description = parseTodoDescription(subtransaction.memo);
  if (!description) return null;

  return {
    id: subtransaction.id,
    date: parent.date,
    payee: subtransaction.payee_name || parent.payee_name || 'Unknown',
    amount: Math.abs(subtransaction.amount) / 1000,
    description,
    accountName: parent.account_name || 'Unknown account',
    categoryName: subtransaction.category_name || parent.category_name || undefined,
    source: 'subtransaction',
    parentTransactionId: parent.id,
  };
}

function sortYnabTodos(todos: YnabTodo[]): YnabTodo[] {
  return todos.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function howMuchTransactionUrl(config: ClaimsBackendConfig, todo: YnabTodo): string {
  const url = new URL('/transactions', config.apiUrl);
  url.searchParams.set('plan', config.planId);
  url.searchParams.set('transaction', todo.parentTransactionId || todo.id);
  if (todo.parentTransactionId) url.searchParams.set('subtransaction', todo.id);
  return url.toString();
}

function parseExplicitClaimsBackend(value: unknown): ClaimsBackend {
  if (value === 'howmuch' || value === 'ynab') return value;
  throw new ClaimsBackendInputError(`Unsupported claims backend: ${String(value)}`);
}

function parseClaimsBackend(value: unknown): ClaimsBackend {
  if (value === null || value === undefined) return 'howmuch';
  return parseExplicitClaimsBackend(value);
}

function parseMutationBackend(value: unknown): ClaimsBackend {
  if (value === undefined) return 'ynab';
  return parseExplicitClaimsBackend(value);
}

function claimsBackendConfig(env: Env, backend: ClaimsBackend): ClaimsBackendConfig {
  if (backend === 'ynab') {
    if (!env.YNAB_API_KEY || !env.YNAB_BUDGET_ID) throw new Error('YNAB backend is not configured.');
    return {
      apiUrl: 'https://api.ynab.com/v1',
      token: env.YNAB_API_KEY,
      planId: env.YNAB_BUDGET_ID,
    };
  }

  const planId = env.HOWMUCH_PLAN_ID || env.YNAB_BUDGET_ID;
  if (!env.HOWMUCH_PAT || !planId) {
    throw new Error('HowMuch backend is not configured (HOWMUCH_PAT and a plan ID are required).');
  }
  return {
    apiUrl: (env.HOWMUCH_API_URL || 'https://howmuch.tk.sg/v1').replace(/\/+$/, ''),
    token: env.HOWMUCH_PAT,
    planId,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

async function fetchYnabTodos(
  env: Env,
  sinceDate = getDefaultYnabSinceDate(),
  backend: ClaimsBackend = 'howmuch'
): Promise<YnabTodo[]> {
  const config = claimsBackendConfig(env, backend);
  let transactions: YnabTransaction[] = [];
  let settled = false;

  for (let attempt = 0; attempt < 2 && !settled; attempt += 1) {
    transactions = [];
    let offset = 0;
    let serverKnowledge: number | undefined;
    let knowledgeChanged = false;

    do {
      const query = new URLSearchParams({ since_date: sinceDate });
      if (backend === 'howmuch') {
        query.set('limit', '250');
        query.set('offset', String(offset));
      }
      const response = await fetch(
        `${config.apiUrl}/plans/${encodeURIComponent(config.planId)}/transactions?${query}`,
        { headers: { Authorization: `Bearer ${config.token}` } }
      );
      if (!response.ok) {
        throw new ClaimsBackendApiError(backend, response.status, await response.text());
      }

      const body = (await response.json()) as {
        data: {
          transactions: YnabTransaction[];
          has_more?: boolean;
          next_offset?: number | null;
          server_knowledge?: number;
        };
      };
      if (backend === 'howmuch' && serverKnowledge !== undefined && body.data.server_knowledge !== serverKnowledge) {
        knowledgeChanged = true;
        break;
      }
      serverKnowledge = body.data.server_knowledge;
      transactions.push(...body.data.transactions);
      if (backend !== 'howmuch' || !body.data.has_more || body.data.next_offset == null) break;
      if (body.data.next_offset <= offset) throw new Error('HowMuch returned an invalid transaction page cursor.');
      offset = body.data.next_offset;
    } while (true);

    settled = !knowledgeChanged;
  }

  if (!settled) throw new Error('HowMuch transactions changed repeatedly while loading; please retry.');

  const todos: YnabTodo[] = [];

  transactions.forEach((transaction) => {
    const subtransactionTodos: YnabTodo[] = [];
    (transaction.subtransactions || []).forEach((subtransaction) => {
      const subtransactionTodo = toYnabTodoFromSubtransaction(transaction, subtransaction);
      if (subtransactionTodo) subtransactionTodos.push(subtransactionTodo);
    });

    const todo = toYnabTodoFromTransaction(transaction);
    if (todo && subtransactionTodos.length === 0) {
      todos.push(todo);
    }
    todos.push(...subtransactionTodos);
  });

  if (backend === 'howmuch') {
    todos.forEach((todo) => {
      todo.sourceUrl = howMuchTransactionUrl(config, todo);
    });
  }

  return sortYnabTodos(todos);
}

async function listReceiptSummaries(
  env: Env,
  options: { limit?: number; cursor?: string } = {},
  invoiceEditKeys?: ReadonlySet<string>
): Promise<ReceiptListResult> {
  const limit = Math.min(Math.max(options.limit || 100, 1), 1000);
  // Ask R2 to return custom metadata inline so a page load is one list call
  // rather than one head() per receipt. R2 may shorten a page to fit the
  // response size; the cursor loop in the client picks up the remainder.
  const listStarted = Date.now();
  const editKeys = invoiceEditKeys ?? await listInvoiceEditKeys(env.RECEIPTS);
  const listed = await env.RECEIPTS.list({ limit, cursor: options.cursor, include: ['customMetadata'] });
  const listMs = Date.now() - listStarted;
  const metadataStarted = Date.now();
  let headFallbacks = 0;

  const receipts = await mapWithConcurrency(
    listed.objects.filter(obj => !isInternalKey(obj.key)),
    RECEIPT_METADATA_CONCURRENCY,
    async (obj): Promise<ReceiptSummary> => {
      // Fall back to head() only if the runtime ignored `include`.
      let metadata = obj.customMetadata;
      if (!metadata) {
        headFallbacks += 1;
        metadata = (await env.RECEIPTS.head(obj.key))?.customMetadata ?? {};
      }
      const linkedClaimIds = parseLinkedClaimIds(metadata.linkedClaimIds, metadata.linkedClaimId);
      const primaryLinkedClaimId = linkedClaimIds[0];
      return {
        key: obj.key,
        size: obj.size,
        // Keep original upload time stable even when metadata is updated.
        uploaded: metadata.uploadedAt || obj.uploaded.toISOString(),
        storageUploaded: obj.uploaded.toISOString(),
        originalName: metadata.originalName,
        source: metadata.source,
        gmailAccount: metadata.gmailAccount,
        gmailMessageId: metadata.gmailMessageId,
        gmailSubject: metadata.gmailSubject,
        linkedClaimId: primaryLinkedClaimId,
        linkedClaimIds,
        linkedClaimsBackend:
          metadata.linkedClaimsBackend === 'howmuch' ? 'howmuch'
            : metadata.linkedClaimsBackend === 'ynab' ? 'ynab'
              : linkedClaimIds.length > 0 ? 'ynab' : undefined,
        linkedClaimDescription: metadata.linkedClaimDescription,
        receiptDate: metadata.receiptDate,
        receiptDateSource: metadata.receiptDateSource,
        detectedReceiptDate: metadata.detectedReceiptDate,
        detectedReceiptDateConfidence: parseMetadataNumber(metadata.detectedReceiptDateConfidence),
        taggedAmount: parseMetadataNumber(metadata.taggedAmount),
        taggedCurrency: metadata.taggedCurrency,
        taggedConfidence: parseMetadataNumber(metadata.taggedConfidence),
        taggedVendor: metadata.taggedVendor,
        taggedPurpose: metadata.taggedPurpose,
        taggedStatus: metadata.taggedStatus,
        taggedModel: metadata.taggedModel,
        taggedAt: metadata.taggedAt,
        taggedError: metadata.taggedError,
        taggedFxStatus: metadata.taggedFxStatus,
        taggedFxError: metadata.taggedFxError,
        taggedFxBaseDate: metadata.taggedFxBaseDate,
        taggedFxDateUsed: metadata.taggedFxDateUsed,
        taggedFxRateUsdSgd: parseMetadataNumber(metadata.taggedFxRateUsdSgd),
        taggedAmountSgdApprox: parseMetadataNumber(metadata.taggedAmountSgdApprox),
        taggedAmountSgdApproxPlus325: parseMetadataNumber(metadata.taggedAmountSgdApproxPlus325),
        taggedGstShown:
          metadata.taggedGstShown === 'true' ? true : metadata.taggedGstShown === 'false' ? false : undefined,
        taggedGstAmount: parseMetadataNumber(metadata.taggedGstAmount),
        taggedGstConfidence: parseMetadataNumber(metadata.taggedGstConfidence),
        taggedGstSource: metadata.taggedGstSource,
        invoiceEdits: editKeys.has(INVOICE_EDITS_PREFIX + obj.key)
          ? await readInvoiceEdits(env.RECEIPTS, obj.key) : { revision: null, lines: {} },
        xeroInvoiceId: metadata.xeroInvoiceId,
        invoicedAt: metadata.invoicedAt,
        xeroPendingInvoiceId: metadata.xeroPendingInvoiceId,
        xeroPendingInvoiceNumber: metadata.xeroPendingInvoiceNumber,
        xeroPendingAt: metadata.xeroPendingAt,
        xeroPendingClaimsBackend:
          metadata.xeroPendingClaimsBackend === 'ynab' ? 'ynab'
            : metadata.xeroPendingClaimsBackend === 'howmuch' ? 'howmuch'
              : undefined,
      };
    }
  );

  return {
    receipts,
    cursor: listed.truncated ? listed.cursor || null : null,
    hasMore: listed.truncated,
    timings: { listMs, metadataMs: Date.now() - metadataStarted, headFallbacks },
  };
}

async function listAllReceiptSummaries(env: Env, maxReceipts = 5000): Promise<{
  receipts: ReceiptSummary[];
  truncated: boolean;
}> {
  const receipts: ReceiptSummary[] = [];
  const invoiceEditKeys = await listInvoiceEditKeys(env.RECEIPTS);
  let cursor: string | undefined;
  let hasMore = false;

  do {
    const page = await listReceiptSummaries(env, {
      limit: Math.min(1000, maxReceipts - receipts.length),
      cursor,
    }, invoiceEditKeys);
    receipts.push(...page.receipts);
    cursor = page.cursor || undefined;
    hasMore = page.hasMore;
  } while (cursor && receipts.length < maxReceipts);

  return {
    receipts,
    truncated: hasMore && receipts.length >= maxReceipts,
  };
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatGmailDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function buildReceiptSearchHints(todo: YnabTodo): {
  payee: string;
  description: string;
  amount: number;
  dateWindow: { from: string; to: string } | null;
  gmailQuery: string;
} {
  const parsedDate = extractIsoDate(todo.date);
  const date = parsedDate ? new Date(`${parsedDate}T00:00:00Z`) : null;
  const dateWindow = date
    ? {
        from: addDays(date, -3).toISOString().slice(0, 10),
        to: addDays(date, 4).toISOString().slice(0, 10),
      }
    : null;

  const queryParts = [todo.payee, todo.description]
    .map((part) => part.trim())
    .filter((part) => part && part !== 'Unknown')
    .map((part) => `"${part.replace(/"/g, '')}"`);

  if (date) {
    queryParts.push(`after:${formatGmailDate(addDays(date, -3))}`);
    queryParts.push(`before:${formatGmailDate(addDays(date, 4))}`);
  }

  return {
    payee: todo.payee,
    description: todo.description,
    amount: todo.amount,
    dateWindow,
    gmailQuery: queryParts.join(' '),
  };
}

function parseGeminiJson(
  rawText: string
): {
  amount: number | null;
  confidence: number;
  currency: string;
  receiptDate: string | null;
  receiptDateConfidence: number;
  vendor: string | null;
  purpose: string | null;
} | null {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fencedMatch?.[1]?.trim() || trimmed;

  try {
    const parsed = JSON.parse(jsonText) as {
      amount?: number | string | null;
      confidence?: number | string;
      currency?: string;
      receiptDate?: string | null;
      receiptDateConfidence?: number | string;
      vendor?: string | null;
      purpose?: string | null;
    };

    let amount: number | null = null;
    if (parsed.amount !== null && parsed.amount !== undefined && parsed.amount !== '') {
      const parsedAmount = typeof parsed.amount === 'number' ? parsed.amount : Number.parseFloat(String(parsed.amount));
      if (Number.isFinite(parsedAmount) && parsedAmount >= 0) {
        amount = Math.round(parsedAmount * 100) / 100;
      }
    }

    const confidence = parseConfidence(parsed.confidence);
    const currency = String(parsed.currency || 'UNKNOWN').toUpperCase().slice(0, 12);
    const receiptDate = extractIsoDate(parsed.receiptDate);
    const receiptDateConfidence = parseConfidence(parsed.receiptDateConfidence);
    const vendor = sanitiseLabel(parsed.vendor, 60);
    const purpose = sanitiseLabel(parsed.purpose, 100);

    return { amount, confidence, currency, receiptDate, receiptDateConfidence, vendor, purpose };
  } catch {
    return null;
  }
}

async function getUsdSgdRate(date: string): Promise<FxRateResult> {
  const cached = fxRateCache.get(date);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const response = await fetch(`${FX_API_BASE}/${encodeURIComponent(date)}?base=USD&symbols=SGD`);
  if (!response.ok) {
    const details = (await response.text()).slice(0, 180);
    throw new Error(`FX API ${response.status}: ${details}`);
  }

  const payload = (await response.json()) as {
    date?: string;
    rates?: Record<string, number>;
  };
  const rate = payload.rates?.SGD;
  const dateUsed = extractIsoDate(payload.date) || date;

  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('FX API returned invalid SGD rate');
  }

  const safeRate = Number(rate);
  const result = { rate: safeRate, dateUsed };
  fxRateCache.set(date, {
    value: result,
    expiresAt: Date.now() + FX_CACHE_TTL_MS,
  });
  return result;
}

async function patchReceiptMetadata(
  env: Env,
  key: string,
  metadataPatch: Record<string, string | undefined>,
  expectedClaimsBackend?: ClaimsBackend
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await env.RECEIPTS.get(key);
    if (!existing) return false;

    const content = await existing.arrayBuffer();
    const mergedMetadata: Record<string, string> = {
      ...(existing.customMetadata || {}),
    };
    const currentClaimsBackend = mergedMetadata.linkedClaimsBackend === 'howmuch' ? 'howmuch' : 'ynab';
    if (expectedClaimsBackend && currentClaimsBackend !== expectedClaimsBackend) {
      throw new ClaimsBackendInputError('Receipt link belongs to a different claims backend.');
    }

    Object.entries(metadataPatch).forEach(([metaKey, value]) => {
      if (value === undefined) {
        delete mergedMetadata[metaKey];
        return;
      }
      mergedMetadata[metaKey] = value;
    });

    const updated = await env.RECEIPTS.put(key, content, {
      onlyIf: { etagMatches: existing.etag },
      httpMetadata: existing.httpMetadata,
      customMetadata: mergedMetadata,
    });
    if (updated) return true;
  }

  throw new Error(`Receipt metadata changed concurrently: ${key}`);
}

async function callGeminiWithFile(
  env: Env,
  prompt: string,
  fileBuffer: ArrayBuffer,
  mimeType: string
): Promise<{ text: string; model: string }> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY');
  }

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType || 'application/octet-stream',
                  data: toBase64(fileBuffer),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!geminiResponse.ok) {
    const details = (await geminiResponse.text()).slice(0, 300);
    throw new Error(`Gemini API ${geminiResponse.status}: ${details}`);
  }

  const payload = (await geminiResponse.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const textOutput = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim();

  if (!textOutput) {
    throw new Error('Gemini response did not contain text output');
  }

  return { text: textOutput, model };
}

const AMOUNT_PROMPT = [
  'Extract the final payable total amount, receipt date, vendor, and purpose from this receipt.',
  'Return strict JSON only with this schema:',
  '{"amount": number|null, "currency": "ISO-4217-or-UNKNOWN", "confidence": number, "receiptDate": "YYYY-MM-DD"|null, "receiptDateConfidence": number, "vendor": string|null, "purpose": string|null}',
  'Rules:',
  '- amount must be the final charged total, no currency symbols.',
  '- use null if the amount is unreadable or ambiguous.',
  '- receiptDate should be purchase/transaction date in YYYY-MM-DD.',
  '- use null for receiptDate if date is unreadable/ambiguous.',
  '- vendor should be merchant/vendor name only.',
  '- purpose should be a short label (2-6 words) for what this expense is for.',
  '- confidence must be between 0 and 1.',
  '- receiptDateConfidence must be between 0 and 1.',
].join('\n');

async function extractAmountWithGemini(env: Env, fileBuffer: ArrayBuffer, mimeType: string): Promise<GeminiAmountResult> {
  const { text, model } = await callGeminiWithFile(env, AMOUNT_PROMPT, fileBuffer, mimeType);

  const parsed = parseGeminiJson(text);
  if (!parsed) {
    throw new Error('Gemini response was not valid JSON');
  }

  return {
    ...parsed,
    model,
  };
}

async function extractAmountWithMiniMax(env: Env, fileBuffer: ArrayBuffer, mimeType: string): Promise<GeminiAmountResult> {
  const text = await callMiniMaxVlm(env, AMOUNT_PROMPT, fileBuffer, mimeType);

  const parsed = parseGeminiJson(text);
  if (!parsed) {
    throw new Error('MiniMax VLM amount response was not valid JSON');
  }

  return {
    ...parsed,
    model: 'minimax-vlm',
  };
}

async function extractAmountWithClaude(env: Env, fileBuffer: ArrayBuffer, mimeType: string): Promise<GeminiAmountResult> {
  const { text, model } = await ai.callClaudeWithFile(env, AMOUNT_PROMPT, ai.AMOUNT_SCHEMA, fileBuffer, mimeType, toBase64);

  const parsed = parseGeminiJson(text);
  if (!parsed) {
    throw new Error('Claude amount response was not valid JSON');
  }

  return {
    ...parsed,
    model,
  };
}

// Provider-aware amount extraction: the preferred provider first, then any
// other provider with a key that can read this file type.
async function extractReceiptAmount(env: Env, fileBuffer: ArrayBuffer, mimeType: string): Promise<GeminiAmountResult> {
  return runVisionChain(env, mimeType, 'Amount extraction', {
    minimax: () => extractAmountWithMiniMax(env, fileBuffer, mimeType),
    anthropic: () => extractAmountWithClaude(env, fileBuffer, mimeType),
    gemini: () => extractAmountWithGemini(env, fileBuffer, mimeType),
  });
}

const GST_PROMPT = [
  'Determine whether this receipt shows an explicit GST (Singapore Goods & Services Tax) line item.',
  'Return strict JSON only with this schema:',
  '{"gstShown": boolean, "gstAmount": number|null, "confidence": number}',
  'Rules:',
  '- gstShown must be true ONLY if an explicit GST amount or GST line is printed on the receipt.',
  '- Never infer GST from the vendor, location, or total; if no GST breakdown is printed, gstShown is false.',
  '- gstAmount is the printed GST amount with no currency symbols, null if none is shown.',
  '- confidence must be between 0 and 1.',
].join('\n');

function parseGstJson(rawText: string): { gstShown: boolean; gstAmount: number | null; confidence: number } | null {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fencedMatch?.[1]?.trim() || trimmed;

  try {
    const parsed = JSON.parse(jsonText) as {
      gstShown?: boolean | string;
      gstAmount?: number | string | null;
      confidence?: number | string;
    };

    const gstShown = parsed.gstShown === true || parsed.gstShown === 'true';

    let gstAmount: number | null = null;
    if (parsed.gstAmount !== null && parsed.gstAmount !== undefined && parsed.gstAmount !== '') {
      const parsedAmount =
        typeof parsed.gstAmount === 'number' ? parsed.gstAmount : Number.parseFloat(String(parsed.gstAmount));
      if (Number.isFinite(parsedAmount) && parsedAmount >= 0) {
        gstAmount = Math.round(parsedAmount * 100) / 100;
      }
    }

    return { gstShown, gstAmount, confidence: parseConfidence(parsed.confidence) };
  } catch {
    return null;
  }
}

async function callMiniMaxVlm(env: Env, prompt: string, fileBuffer: ArrayBuffer, mimeType: string): Promise<string> {
  if (!env.MINIMAX_API_KEY) {
    throw new Error('Missing MINIMAX_API_KEY');
  }

  const response = await fetch(MINIMAX_VLM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      prompt,
      image_url: `data:${mimeType};base64,${toBase64(fileBuffer)}`,
    }),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 300);
    throw new Error(`MiniMax VLM ${response.status}: ${details}`);
  }

  const payload = (await response.json()) as {
    content?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };

  if (payload.base_resp && payload.base_resp.status_code !== 0) {
    throw new Error(`MiniMax VLM error ${payload.base_resp.status_code}: ${payload.base_resp.status_msg || 'unknown'}`);
  }

  if (!payload.content) {
    throw new Error('MiniMax VLM response did not contain content');
  }

  return payload.content;
}

async function detectGstWithMiniMax(env: Env, fileBuffer: ArrayBuffer, mimeType: string): Promise<GstDetectionResult> {
  const text = await callMiniMaxVlm(env, GST_PROMPT, fileBuffer, mimeType);

  const parsed = parseGstJson(text);
  if (!parsed) {
    throw new Error('MiniMax VLM response was not valid JSON');
  }

  return { ...parsed, source: 'minimax' };
}

async function detectGstWithGemini(env: Env, fileBuffer: ArrayBuffer, mimeType: string): Promise<GstDetectionResult> {
  const { text } = await callGeminiWithFile(env, GST_PROMPT, fileBuffer, mimeType);

  const parsed = parseGstJson(text);
  if (!parsed) {
    throw new Error('Gemini GST response was not valid JSON');
  }

  return { ...parsed, source: 'gemini' };
}

async function detectGstWithClaude(env: Env, fileBuffer: ArrayBuffer, mimeType: string): Promise<GstDetectionResult> {
  const { text } = await ai.callClaudeWithFile(env, GST_PROMPT, ai.GST_SCHEMA, fileBuffer, mimeType, toBase64);

  const parsed = parseGstJson(text);
  if (!parsed) {
    throw new Error('Claude GST response was not valid JSON');
  }

  return { ...parsed, source: 'anthropic' };
}

// Fallback order after the preferred provider. MiniMax is covered by the
// coding-plan subscription, so it goes first when it can read the file.
const VISION_FALLBACK_ORDER: ai.AiProvider[] = ['minimax', 'anthropic', 'gemini'];

function visionKey(env: Env, provider: ai.AiProvider): string | undefined {
  if (provider === 'minimax') return env.MINIMAX_API_KEY;
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY;
  return env.GEMINI_API_KEY;
}

function visionSupports(provider: ai.AiProvider, mimeType: string): boolean {
  if (provider === 'minimax') return MINIMAX_IMAGE_MIMES.includes(mimeType);
  if (provider === 'anthropic') return ai.claudeSupports(mimeType);
  return true; // Gemini reads images, PDFs and HEIC
}

function hasVisionKey(env: Env): boolean {
  return VISION_FALLBACK_ORDER.some((provider) => Boolean(visionKey(env, provider)));
}

function visionProviders(env: Env, mimeType: string): ai.AiProvider[] {
  const preferred = ai.preferredVisionProvider(env);
  return [preferred, ...VISION_FALLBACK_ORDER.filter((p) => p !== preferred)].filter(
    (provider) => Boolean(visionKey(env, provider)) && visionSupports(provider, mimeType)
  );
}

async function runVisionChain<T>(
  env: Env,
  mimeType: string,
  task: string,
  run: Record<ai.AiProvider, () => Promise<T>>
): Promise<T> {
  const providers = visionProviders(env, mimeType);
  if (providers.length === 0) {
    throw new Error(`No AI provider with a key can read ${mimeType || 'this file type'}`);
  }
  const errors: string[] = [];
  for (const provider of providers) {
    try {
      return await run[provider]();
    } catch (error) {
      errors.push(`${provider}: ${cleanError(error).slice(0, 80)}`);
    }
  }
  throw new Error(`${task} failed. ${errors.join('; ')}`);
}

async function detectReceiptGst(env: Env, fileBuffer: ArrayBuffer, mimeType: string): Promise<GstDetectionResult> {
  return runVisionChain(env, mimeType, 'GST detection', {
    minimax: () => detectGstWithMiniMax(env, fileBuffer, mimeType),
    anthropic: () => detectGstWithClaude(env, fileBuffer, mimeType),
    gemini: () => detectGstWithGemini(env, fileBuffer, mimeType),
  });
}

function buildGstMetadataPatch(gst: GstDetectionResult): Record<string, string | undefined> {
  return {
    taggedGstShown: String(gst.gstShown),
    taggedGstAmount: gst.gstAmount !== null ? gst.gstAmount.toFixed(2) : undefined,
    taggedGstConfidence: gst.confidence.toFixed(2),
    taggedGstSource: gst.source,
    taggedGstAt: new Date().toISOString(),
    taggedGstError: undefined,
  };
}

async function tagReceiptGst(env: Env, key: string, options: { force?: boolean } = {}): Promise<GstTagResult> {
  env = await ai.withAiSettings(env);
  const object = await env.RECEIPTS.get(key);
  if (!object) {
    return { key, status: 'failed', reason: 'receipt_not_found' };
  }

  const metadata = object.customMetadata || {};
  if (!options.force && metadata.taggedGstShown !== undefined) {
    return { key, status: 'skipped', reason: 'already_tagged' };
  }

  const fileBuffer = await object.arrayBuffer();
  const mimeType = object.httpMetadata?.contentType || 'application/octet-stream';

  try {
    const gst = await detectReceiptGst(env, fileBuffer, mimeType);
    await patchReceiptMetadata(env, key, buildGstMetadataPatch(gst));
    return { key, status: 'tagged', gstShown: gst.gstShown, gstAmount: gst.gstAmount, source: gst.source };
  } catch (error) {
    const reason = cleanError(error);
    await patchReceiptMetadata(env, key, { taggedGstError: reason });
    return { key, status: 'failed', reason };
  }
}

// Backfill GST tags for receipts uploaded before GST detection existed. Unlike
// amount tagging, linked receipts are included — they are exactly the
// ready-to-claim items the Invoices tab needs GST verdicts for. Receipts
// already pushed to Xero are skipped.
async function tagPendingGst(env: Env, limit: number): Promise<{
  requested: number;
  processed: number;
  tagged: number;
  skipped: number;
  failed: number;
  remaining: number;
  results: GstTagResult[];
}> {
  env = await ai.withAiSettings(env);
  const listed = await env.RECEIPTS.list({ limit: 1000 });
  const candidateKeys: string[] = [];
  let remaining = 0;

  for (const object of listed.objects) {
    if (isInternalKey(object.key)) continue;
    const head = await env.RECEIPTS.head(object.key);
    const metadata = head?.customMetadata || {};
    if (metadata.xeroInvoiceId) continue;
    if (metadata.taggedGstShown !== undefined) continue;
    remaining += 1;
    if (candidateKeys.length < limit) candidateKeys.push(object.key);
  }

  const results: GstTagResult[] = [];
  for (const key of candidateKeys) {
    // Sequential to keep within provider rate limits.
    const result = await tagReceiptGst(env, key);
    results.push(result);
  }

  return {
    requested: limit,
    processed: results.length,
    tagged: results.filter((r) => r.status === 'tagged').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    remaining: remaining - results.filter((r) => r.status === 'tagged').length,
    results,
  };
}

async function tagReceiptAmount(env: Env, key: string, options: { force?: boolean } = {}): Promise<AmountTagResult> {
  env = await ai.withAiSettings(env);
  if (!hasVisionKey(env)) {
    return { key, status: 'skipped', reason: 'missing_vision_api_key' };
  }

  const object = await env.RECEIPTS.get(key);
  if (!object) {
    return { key, status: 'failed', reason: 'receipt_not_found' };
  }

  const metadata = object.customMetadata || {};
  const linkedClaimIds = parseLinkedClaimIds(metadata.linkedClaimIds, metadata.linkedClaimId);
  if (linkedClaimIds.length > 0) {
    return { key, status: 'skipped', reason: 'already_linked' };
  }
  if (!options.force && (metadata.taggedStatus === 'ok' || metadata.taggedStatus === 'missing')) {
    return { key, status: 'skipped', reason: 'already_tagged' };
  }

  const fileBuffer = await object.arrayBuffer();
  const mimeType = object.httpMetadata?.contentType || 'application/octet-stream';

  try {
    const extracted = await extractReceiptAmount(env, fileBuffer, mimeType);

    // GST detection rides along but must never fail the amount tagging.
    let gst: GstDetectionResult | null = null;
    let gstError: string | undefined;
    try {
      gst = await detectReceiptGst(env, fileBuffer, mimeType);
    } catch (error) {
      gstError = cleanError(error);
    }

    const status = extracted.amount === null ? 'missing' : 'ok';
    const detectedReceiptDate = extracted.receiptDate;
    const hasManualDateOverride = metadata.receiptDateSource === 'manual' && !!metadata.receiptDate;

    const nextReceiptDate = hasManualDateOverride
      ? metadata.receiptDate
      : detectedReceiptDate || metadata.receiptDate;
    const nextReceiptDateSource = hasManualDateOverride ? 'manual' : nextReceiptDate ? 'ai' : undefined;

    const fxBaseDate =
      nextReceiptDate || getDateFromIsoDateTime(metadata.uploadedAt) || new Date().toISOString().slice(0, 10);

    let fxStatus: string | undefined;
    let fxDateUsed: string | undefined;
    let fxRate: string | undefined;
    let fxApprox: string | undefined;
    let fxApproxPlus325: string | undefined;
    let fxError: string | undefined;

    if (extracted.amount !== null && extracted.currency === 'USD') {
      try {
        const fx = await getUsdSgdRate(fxBaseDate);
        const sgdApprox = roundMoney(extracted.amount * fx.rate);
        const sgdApproxWithFee = roundMoney(sgdApprox * (1 + USD_SURCHARGE_RATE));
        fxStatus = 'ok';
        fxDateUsed = fx.dateUsed;
        fxRate = fx.rate.toFixed(6);
        fxApprox = sgdApprox.toFixed(2);
        fxApproxPlus325 = sgdApproxWithFee.toFixed(2);
      } catch (error) {
        fxStatus = 'error';
        fxError = cleanError(error);
      }
    } else if (extracted.amount !== null) {
      fxStatus = 'not_usd';
    }

    await patchReceiptMetadata(env, key, {
      taggedStatus: status,
      taggedAmount: extracted.amount === null ? undefined : extracted.amount.toFixed(2),
      taggedCurrency: extracted.currency,
      taggedConfidence: extracted.confidence.toFixed(2),
      detectedReceiptDate: detectedReceiptDate || undefined,
      detectedReceiptDateConfidence: extracted.receiptDateConfidence.toFixed(2),
      receiptDate: nextReceiptDate || undefined,
      receiptDateSource: nextReceiptDateSource,
      taggedVendor: extracted.vendor || undefined,
      taggedPurpose: extracted.purpose || undefined,
      taggedModel: extracted.model,
      taggedAt: new Date().toISOString(),
      taggedFxBaseDate: extracted.amount === null ? undefined : fxBaseDate,
      taggedFxDateUsed: fxDateUsed,
      taggedFxRateUsdSgd: fxRate,
      taggedFxStatus: fxStatus,
      taggedFxError: fxError,
      taggedAmountSgdApprox: fxApprox,
      taggedAmountSgdApproxPlus325: fxApproxPlus325,
      // Omit (rather than undefined-delete) GST fields when detection failed,
      // so an earlier successful GST tag survives a forced amount re-tag.
      ...(gst ? buildGstMetadataPatch(gst) : { taggedGstError: gstError }),
      taggedError: undefined,
    });

    if (extracted.amount === null) {
      return { key, status: 'skipped', reason: 'amount_not_found' };
    }

    return {
      key,
      status: 'tagged',
      amount: extracted.amount,
    };
  } catch (error) {
    const reason = cleanError(error);
    await patchReceiptMetadata(env, key, {
      taggedStatus: 'error',
      taggedAt: new Date().toISOString(),
      taggedFxStatus: 'error',
      taggedFxError: reason,
      taggedAmountSgdApprox: undefined,
      taggedAmountSgdApproxPlus325: undefined,
      taggedFxRateUsdSgd: undefined,
      taggedFxDateUsed: undefined,
      taggedFxBaseDate: undefined,
      taggedError: reason,
    });
    return { key, status: 'failed', reason };
  }
}

async function tagPendingReceipts(env: Env, limit: number): Promise<{
  requested: number;
  processed: number;
  tagged: number;
  skipped: number;
  failed: number;
  results: AmountTagResult[];
}> {
  env = await ai.withAiSettings(env);
  const scanLimit = Math.min(Math.max(limit * 4, limit), 200);
  const listed = await env.RECEIPTS.list({ limit: scanLimit });
  const candidateKeys: string[] = [];

  for (const object of listed.objects) {
    if (isInternalKey(object.key)) continue;
    const head = await env.RECEIPTS.head(object.key);
    const metadata = head?.customMetadata || {};
    const linkedClaimIds = parseLinkedClaimIds(metadata.linkedClaimIds, metadata.linkedClaimId);
    if (linkedClaimIds.length > 0) continue;
    if (metadata.taggedStatus === 'ok' || metadata.taggedStatus === 'missing') continue;
    candidateKeys.push(object.key);
    if (candidateKeys.length >= limit) break;
  }

  const results: AmountTagResult[] = [];
  for (const key of candidateKeys) {
    // Process sequentially to avoid hitting Gemini rate limits.
    const result = await tagReceiptAmount(env, key);
    results.push(result);
  }

  return {
    requested: limit,
    processed: results.length,
    tagged: results.filter((r) => r.status === 'tagged').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
}

// Generate timestamped filename with UUID to prevent collisions
function generateKey(filename: string): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '');
  const uuid = crypto.randomUUID().slice(0, 8); // Short UUID suffix
  const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${date}_${time}_${uuid}_${safeName}`;
}

// Build CORS headers - same-origin by default, configurable via CORS_ORIGIN env var
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const selfOrigin = new URL(request.url).origin;
  const allowedOrigin = env.CORS_ORIGIN || selfOrigin;

  // Allow if: no Origin header (CLI/curl), or origin matches allowed origin
  const effectiveOrigin = !origin ? '*' : origin === allowedOrigin ? origin : '';

  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
    Vary: 'Origin', // Prevent caches from serving wrong CORS headers
  };
}

// Validate auth token
function validateAuth(request: Request, env: Env): boolean {
  const token = request.headers.get('X-Auth-Token');
  if (!token || !env.AUTH_PASSWORD) return false;
  return safeEqual(token, env.AUTH_PASSWORD);
}

// Wrong-password limiting. Failed attempts go through the rate limiter
// binding; once an IP trips it, a short lockout in KV makes even the right
// password fail for that IP, so a guesser can't spot a hit by its status code.
const AUTH_LOCKOUT_SECONDS = 300;

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function authLockedOut(request: Request, env: Env): Promise<boolean> {
  if (!env.AUTH_RATE_LIMITER || !env.APP_SETTINGS) return false;
  try {
    return (await env.APP_SETTINGS.get(`auth_lockout:${clientIp(request)}`)) !== null;
  } catch {
    return false;
  }
}

// Records a wrong password; true when this IP is now over the limit. Requests
// with no password at all (a page loading before sign-in) aren't guesses.
async function recordAuthFailure(request: Request, env: Env): Promise<boolean> {
  if (!env.AUTH_RATE_LIMITER || !request.headers.get('X-Auth-Token')) return false;
  const ip = clientIp(request);
  try {
    const { success } = await env.AUTH_RATE_LIMITER.limit({ key: `auth:${ip}` });
    if (success) return false;
    // Write the lockout once per window, not on every further attempt.
    if (env.APP_SETTINGS && (await env.APP_SETTINGS.get(`auth_lockout:${ip}`)) === null) {
      await env.APP_SETTINGS.put(`auth_lockout:${ip}`, '1', { expirationTtl: AUTH_LOCKOUT_SECONDS });
    }
    return true;
  } catch {
    return false;
  }
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      const raw = rest.join('=');
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw; // tolerate a malformed cookie value rather than throwing
      }
    }
  }
  return null;
}

// --- Xero claim-bill push: attachment building + YNAB cleanup --------------

const XERO_ATTACH_MAX_BYTES = 25 * 1024 * 1024;
const XERO_ATTACH_MAX_COUNT = 10;
const COMBINED_PDF_CHUNK_BYTES = Math.floor(22 * 1024 * 1024);
const EMBEDDABLE_MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);

const EXT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif',
};
const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/heic': '.heic', 'image/heif': '.heif',
};

function sanitiseFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9 _.-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function singaporeToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date());
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  if (!year || !month || !day) return date;
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

function parsePushLineItems(raw: unknown): PushLineItem[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new ClaimsBackendInputError(`Invalid invoice line ${index + 1}.`);
    }
    const line = value as Record<string, unknown>;
    const amount = line.amount;
    if (
      typeof line.receiptKey !== 'string' || !line.receiptKey.trim() ||
      typeof line.description !== 'string' || !line.description.trim() ||
      typeof line.accountCode !== 'string' || !line.accountCode.trim() ||
      typeof line.taxType !== 'string' || !line.taxType.trim() ||
      typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0
    ) {
      throw new ClaimsBackendInputError(
        `Invalid invoice line ${index + 1}: receipt, description, positive amount, account and tax code are required.`
      );
    }
    if (
      line.ynabClaimId !== undefined && line.ynabClaimId !== null &&
      typeof line.ynabClaimId !== 'string'
    ) {
      throw new ClaimsBackendInputError(`Invalid claim ID on invoice line ${index + 1}.`);
    }
    if (
      line.claimSource !== undefined && line.claimSource !== null &&
      line.claimSource !== 'transaction' && line.claimSource !== 'subtransaction'
    ) {
      throw new ClaimsBackendInputError(`Invalid claim source on invoice line ${index + 1}.`);
    }
    if (line.date !== undefined && typeof line.date !== 'string') {
      throw new ClaimsBackendInputError(`Invalid date on invoice line ${index + 1}.`);
    }
    if (line.claimDescription !== undefined && line.claimDescription !== null && typeof line.claimDescription !== 'string') {
      throw new ClaimsBackendInputError(`Invalid claim description on invoice line ${index + 1}.`);
    }
    if (line.currency !== undefined && typeof line.currency !== 'string') {
      throw new ClaimsBackendInputError(`Invalid currency on invoice line ${index + 1}.`);
    }

    return {
      receiptKey: line.receiptKey,
      ynabClaimId: typeof line.ynabClaimId === 'string' ? line.ynabClaimId : null,
      claimSource:
        line.claimSource === 'transaction' || line.claimSource === 'subtransaction' ? line.claimSource : null,
      claimDescription: typeof line.claimDescription === 'string' ? line.claimDescription.trim() : null,
      claimsBackend:
        line.claimsBackend === undefined ? undefined : parseExplicitClaimsBackend(line.claimsBackend),
      date: typeof line.date === 'string' ? line.date : '',
      description: line.description.trim(),
      accountCode: line.accountCode.trim(),
      taxType: line.taxType.trim(),
      currency: typeof line.currency === 'string' ? line.currency : undefined,
      amount,
    };
  });
}

function resolveMutationBackend(value: unknown, lineItems: PushLineItem[]): ClaimsBackend {
  const claimLines = lineItems.filter((line) => line.ynabClaimId);
  if (value === undefined) {
    if (claimLines.some((line) => line.claimsBackend !== undefined)) {
      throw new ClaimsBackendInputError('Request backend is required when line-item backend provenance is present.');
    }
    return 'ynab';
  }

  const bodyBackend = parseExplicitClaimsBackend(value);
  if (claimLines.some((line) => line.claimsBackend === undefined)) {
    throw new ClaimsBackendInputError('Every claim-bearing line must include backend provenance.');
  }
  const lineBackends = Array.from(new Set(claimLines.map((line) => line.claimsBackend)));
  if (lineBackends.length > 1) {
    throw new ClaimsBackendInputError('Line items from different claims backends cannot be processed together.');
  }
  if (lineBackends.length === 1 && lineBackends[0] !== bodyBackend) {
    throw new ClaimsBackendInputError('Line-item backend does not match the request backend.');
  }
  return lineBackends[0] || bodyBackend;
}

function nonGstTaxTypeForCurrency(currency?: string): string {
  const normalized = (currency || 'SGD').toUpperCase();
  return normalized !== 'SGD' && normalized !== 'UNKNOWN' ? 'OPINPUT' : 'NRINPUT';
}

function taxTypeForBucket(bucket: string | undefined, line: PushLineItem): string {
  if (bucket === 'gst') return 'INPUTY24';
  if ((bucket === 'nongst' || bucket === 'transport') && line.taxType === 'INPUTY24') {
    return nonGstTaxTypeForCurrency(line.currency);
  }
  return line.taxType;
}

interface ReceiptFile {
  key: string;
  name: string;
  bytes: ArrayBuffer;
  mime: string;
}

async function loadReceiptFile(env: Env, key: string, label: string): Promise<ReceiptFile | null> {
  const obj = await env.RECEIPTS.get(key);
  if (!obj) return null;
  const bytes = await obj.arrayBuffer();
  // Strip any MIME parameters (e.g. "image/jpeg; charset=binary") before comparison.
  const rawMime = obj.httpMetadata?.contentType || EXT_MIME[getExtension(key)] || 'application/octet-stream';
  const mime = rawMime.split(';')[0].trim().toLowerCase();
  const ext = MIME_EXT[mime] || getExtension(key) || '';
  const base = sanitiseFileName(label).slice(0, 80) || sanitiseFileName(key) || 'receipt';
  return { key, name: `${base}${ext}`, bytes, mime };
}

async function buildCombinedPdf(files: ReceiptFile[]): Promise<{ bytes: Uint8Array; skipped: string[] }> {
  const doc = await PDFDocument.create();
  const skipped: string[] = [];
  for (const f of files) {
    try {
      if (f.mime === 'application/pdf') {
        const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true });
        const pages = await doc.copyPages(src, src.getPageIndices());
        pages.forEach((p) => doc.addPage(p));
      } else if (f.mime === 'image/png') {
        const img = await doc.embedPng(f.bytes);
        doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      } else if (f.mime === 'image/jpeg' || f.mime === 'image/jpg') {
        const img = await doc.embedJpg(f.bytes);
        doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
    } catch (_err) {
      skipped.push(f.name);
    }
  }
  return { bytes: await doc.save(), skipped };
}

interface AttachmentUpload {
  name: string;
  bytes: ArrayBuffer | Uint8Array;
  mime: string;
}

interface BrowserReceiptPdfUpload {
  name?: unknown;
  mime?: unknown;
  byteLength?: unknown;
  base64?: unknown;
  warnings?: unknown;
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uploadFromBrowserReceiptPdf(raw: unknown): { upload?: AttachmentUpload; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { warnings };
  const pdf = raw as BrowserReceiptPdfUpload;
  const mime = typeof pdf.mime === 'string' ? normaliseMimeType(pdf.mime) : '';
  const base64 = typeof pdf.base64 === 'string' ? pdf.base64 : '';
  const clientWarnings = Array.isArray(pdf.warnings)
    ? pdf.warnings.filter((w): w is string => typeof w === 'string' && w.trim().length > 0).map((w) => w.trim())
    : [];
  warnings.push(...clientWarnings);

  if (mime !== 'application/pdf' || !base64) {
    warnings.push('Optimised receipts PDF was missing or not a PDF; using server attachment fallback.');
    return { warnings };
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Bytes(base64);
  } catch (_err) {
    warnings.push('Could not decode optimised receipts PDF; using server attachment fallback.');
    return { warnings };
  }

  if (bytes.byteLength === 0) {
    warnings.push('Optimised receipts PDF was empty; using server attachment fallback.');
    return { warnings };
  }
  if (bytes.byteLength > XERO_ATTACH_MAX_BYTES) {
    warnings.push(`Optimised receipts PDF is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB, above Xero's 25 MB attachment limit; using server attachment fallback.`);
    return { warnings };
  }

  const requestedName = typeof pdf.name === 'string' ? sanitiseFileName(pdf.name) : '';
  const name = requestedName.toLowerCase().endsWith('.pdf')
    ? requestedName
    : `${requestedName || 'receipts'}.pdf`;
  return { upload: { name, bytes, mime: 'application/pdf' }, warnings };
}

// Prepares receipt attachments within Xero's caps (25 MB each, 10 per bill).
// Within caps -> individual named files; otherwise merge embeddable receipts
// into chunked combined PDFs and warn about anything that can't be attached.
async function buildClaimAttachments(
  env: Env,
  lineItems: PushLineItem[],
  bucketLabel: string
): Promise<{ uploads: AttachmentUpload[]; warnings: string[] }> {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const files: ReceiptFile[] = [];

  for (const li of lineItems) {
    if (!li.receiptKey || seen.has(li.receiptKey)) continue;
    seen.add(li.receiptKey);
    const file = await loadReceiptFile(env, li.receiptKey, `${li.date || ''} ${li.description || ''}`);
    if (!file) {
      warnings.push(`Receipt not found, skipped: ${li.receiptKey}`);
      continue;
    }
    files.push(file);
  }

  // Only PDF/JPG/PNG can be attached — uploaded raw when within caps, or merged
  // into a combined PDF otherwise. Anything else (HEIC/HEIF/WEBP/GIF/TIFF), or any
  // file over the 25 MB per-attachment cap, is flagged up front for manual upload.
  const supported: ReceiptFile[] = [];
  for (const f of files) {
    if (!EMBEDDABLE_MIME.has(f.mime)) {
      warnings.push(`Not attachable (${f.mime}); re-upload as PDF/JPG/PNG: ${f.name}`);
    } else if (f.bytes.byteLength > XERO_ATTACH_MAX_BYTES) {
      warnings.push(`Too large to attach (${(f.bytes.byteLength / (1024 * 1024)).toFixed(1)} MB > 25 MB); attach manually: ${f.name}`);
    } else {
      supported.push(f);
    }
  }

  // Within the count cap: attach individually with logical names (all are <=25 MB).
  if (supported.length <= XERO_ATTACH_MAX_COUNT) {
    return { uploads: supported.map((f) => ({ name: f.name, bytes: f.bytes, mime: f.mime })), warnings };
  }

  // Otherwise merge into chunked combined PDFs (all remaining files are embeddable).
  const groups: ReceiptFile[][] = [];
  let current: ReceiptFile[] = [];
  let currentBytes = 0;
  for (const f of supported) {
    if (current.length > 0 && currentBytes + f.bytes.byteLength > COMBINED_PDF_CHUNK_BYTES) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(f);
    currentBytes += f.bytes.byteLength;
  }
  if (current.length > 0) groups.push(current);

  const uploads: AttachmentUpload[] = [];
  for (let i = 0; i < groups.length; i++) {
    const { bytes: pdf, skipped } = await buildCombinedPdf(groups[i]);
    for (const s of skipped) warnings.push(`Could not embed ${s} into the combined PDF; attach it manually.`);
    if (pdf.byteLength > XERO_ATTACH_MAX_BYTES) {
      warnings.push(`Combined receipts PDF ${i + 1} exceeds 25 MB; attach those receipts manually.`);
      continue;
    }
    const name = groups.length === 1
      ? `${bucketLabel} receipts.pdf`
      : `${bucketLabel} receipts ${i + 1} of ${groups.length}.pdf`;
    uploads.push({ name, bytes: pdf, mime: 'application/pdf' });
  }

  if (uploads.length > XERO_ATTACH_MAX_COUNT) {
    warnings.push(`More than ${XERO_ATTACH_MAX_COUNT} attachments; only the first ${XERO_ATTACH_MAX_COUNT} were uploaded.`);
    uploads.length = XERO_ATTACH_MAX_COUNT;
  }
  return { uploads, warnings };
}

async function buildClaimReceiptPdf(
  env: Env,
  lineItems: PushLineItem[],
  bucketLabel: string
): Promise<{ name: string; bytes: Uint8Array; warnings: string[] }> {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const files: ReceiptFile[] = [];

  for (const li of lineItems) {
    if (!li.receiptKey || seen.has(li.receiptKey)) continue;
    seen.add(li.receiptKey);
    const file = await loadReceiptFile(env, li.receiptKey, `${li.date || ''} ${li.description || ''}`);
    if (!file) {
      warnings.push(`Receipt not found, skipped: ${li.receiptKey}`);
      continue;
    }
    if (!EMBEDDABLE_MIME.has(file.mime)) {
      warnings.push(`Not included (${file.mime}); download/upload separately: ${file.name}`);
      continue;
    }
    files.push(file);
  }

  if (files.length === 0) {
    throw new Error('No PDF/JPG/PNG receipts are available to compile.');
  }

  const { bytes, skipped } = await buildCombinedPdf(files);
  for (const s of skipped) warnings.push(`Could not embed ${s} into the combined PDF.`);
  if (bytes.byteLength === 0) throw new Error('The compiled receipts PDF was empty.');

  return {
    name: `${bucketLabel} receipts.pdf`,
    bytes,
    warnings,
  };
}

type YnabClaimResult = { status: 'claimed' | 'skipped' | 'failed'; detail?: string };
type ClaimLine = PushLineItem & { ynabClaimId: string };

const HOWMUCH_UPDATE_BATCH_SIZE = 100;

async function readYnabError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { detail?: string; name?: string; id?: string } };
    const detail = parsed.error?.detail || parsed.error?.name || parsed.error?.id;
    if (detail) return detail;
  } catch (_err) {
    /* fall back to raw text */
  }
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

async function markHowMuchClaimed(
  env: Env,
  claims: ClaimLine[],
  claimedDate = singaporeToday()
): Promise<Array<{ id: string; status: string; detail?: string }>> {
  const results = new Map<string, YnabClaimResult>();
  const pending = claims.filter((claim) => {
    if (claim.claimSource === 'subtransaction' || claim.ynabClaimId.includes('_st_')) {
      results.set(claim.ynabClaimId, { status: 'skipped', detail: 'Subtransactions must be updated manually.' });
      return false;
    }
    if (!claim.claimDescription) {
      results.set(claim.ynabClaimId, { status: 'failed', detail: 'Original claim description is missing; refresh and retry.' });
      return false;
    }
    return true;
  });
  if (pending.length === 0) {
    return claims.map((claim) => ({ id: claim.ynabClaimId, ...results.get(claim.ynabClaimId)! }));
  }
  const config = claimsBackendConfig(env, 'howmuch');

  for (let offset = 0; offset < pending.length; offset += HOWMUCH_UPDATE_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + HOWMUCH_UPDATE_BATCH_SIZE);
    const updates = batch.map((claim) => ({
      id: claim.ynabClaimId,
      memo: `CLAIMED - ${claimedDate}: ${claim.claimDescription}`,
    }));

    try {
      const response = await fetch(`${config.apiUrl}/plans/${encodeURIComponent(config.planId)}/transactions`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: updates }),
      });
      if (!response.ok) {
        const detail = await readYnabError(response);
        batch.forEach((claim) => results.set(claim.ynabClaimId, { status: 'failed', detail }));
        break;
      }

      const body = (await response.json()) as {
        data?: { transactions?: Array<{ id?: string; memo?: string | null }> };
      };
      const returned = new Map((body.data?.transactions || []).map((transaction) => [transaction.id, transaction.memo]));
      batch.forEach((claim, index) => {
        const update = updates[index];
        results.set(
          claim.ynabClaimId,
          returned.get(claim.ynabClaimId) === update.memo
            ? { status: 'claimed' }
            : { status: 'failed', detail: 'HowMuch did not confirm the requested memo update.' }
        );
      });
      if (batch.some((claim) => results.get(claim.ynabClaimId)?.status === 'failed')) break;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      batch.forEach((claim) => results.set(claim.ynabClaimId, { status: 'failed', detail }));
      break;
    }
  }

  pending.forEach((claim) => {
    if (!results.has(claim.ynabClaimId)) {
      results.set(claim.ynabClaimId, { status: 'failed', detail: 'Not attempted after a HowMuch batch update failed.' });
    }
  });
  return claims.map((claim) => ({ id: claim.ynabClaimId, ...results.get(claim.ynabClaimId)! }));
}

// Flip a transaction memo from "TODO: ..." to "CLAIMED - YYYY-MM-DD: ...".
async function markYnabClaimed(
  env: Env,
  transactionId: string,
  claimedDate = singaporeToday(),
  backend: ClaimsBackend = 'howmuch',
  source: 'transaction' | 'subtransaction' | null = null
): Promise<YnabClaimResult> {
  if (source === 'subtransaction' || transactionId.includes('_st_')) {
    return { status: 'skipped', detail: 'Subtransactions must be updated manually.' };
  }
  try {
    const config = claimsBackendConfig(env, backend);
    const base = `${config.apiUrl}/plans/${encodeURIComponent(config.planId)}/transactions/${encodeURIComponent(transactionId)}`;
    const authHeaders = { Authorization: `Bearer ${config.token}` };
    const getRes = await fetch(base, { headers: authHeaders });
    if (!getRes.ok) return { status: 'failed', detail: await readYnabError(getRes) };
    const getData = (await getRes.json()) as { data?: { transaction?: { memo?: string | null } } };
    const memo = getData.data?.transaction?.memo || '';
    if (/^\s*CLAIMED\b/i.test(memo)) return { status: 'claimed' }; // already done
    const newMemo = /^\s*TODO:?/i.test(memo)
      ? memo.replace(/^\s*TODO:?\s*/i, `CLAIMED - ${claimedDate}: `)
      : `CLAIMED - ${claimedDate}: ${memo}`.trim();
    const putRes = await fetch(base, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: { memo: newMemo } }),
    });
    return putRes.ok ? { status: 'claimed' } : { status: 'failed', detail: await readYnabError(putRes) };
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

// --- Gmail receipt import -----------------------------------------------------

// Stores one file found by the Gmail scan the same way POST /upload does, and
// queues amount/GST tagging for it.
function gmailImporter(env: Env, ctx: ExecutionContext): gmail.ImportFile {
  return async (file) => {
    if (file.bytes.byteLength > MAX_FILE_SIZE) return { error: 'file too large' };
    const mimeType = normaliseMimeType(file.mimeType);
    const ext = getUploadExtension(file.filename, mimeType) || MIME_EXT[mimeType] || '';
    if (!ext) return { error: 'unsupported file type' };
    if (!validateMagicBytes(file.bytes, mimeType)) return { error: 'content does not match its type' };

    const key = generateKey(buildStorageFilename(file.filename, ext));
    const subject = sanitiseLabel(file.subject, 80);
    await env.RECEIPTS.put(key, file.bytes, {
      httpMetadata: { contentType: mimeType || EXT_MIME[ext] || 'application/octet-stream' },
      customMetadata: {
        originalName: file.filename,
        uploadedAt: new Date().toISOString(),
        source: 'gmail',
        gmailAccount: file.account,
        gmailMessageId: file.messageId,
        // R2 caps custom metadata at 2 KB in total, so keep this short.
        ...(subject ? { gmailSubject: subject } : {}),
      },
    });
    ctx.waitUntil(tagReceiptAmount(env, key));
    return { key };
  };
}

function optionalText(value: unknown, max = 120): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function optionalIsoDate(value: unknown): string | undefined {
  return (typeof value === 'string' && extractIsoDate(value)) || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMatchClaims(value: unknown): ai.MatchClaim[] {
  if (!Array.isArray(value)) return [];
  const claims: ai.MatchClaim[] = [];
  for (const item of value.slice(0, ai.MAX_MATCH_CLAIMS)) {
    const raw = (item || {}) as Record<string, unknown>;
    const id = optionalText(raw.id, 200);
    const date = optionalIsoDate(raw.date);
    const amount = optionalNumber(raw.amount);
    if (!id || !date || amount === undefined) continue;
    claims.push({ id, date, amount, payee: optionalText(raw.payee), description: optionalText(raw.description) });
  }
  return claims;
}

function parseMatchReceipts(value: unknown): ai.MatchReceipt[] {
  if (!Array.isArray(value)) return [];
  const receipts: ai.MatchReceipt[] = [];
  for (const item of value.slice(0, ai.MAX_MATCH_RECEIPTS)) {
    const raw = (item || {}) as Record<string, unknown>;
    const key = optionalText(raw.key, 500);
    if (!key) continue;
    receipts.push({
      key,
      filename: optionalText(raw.filename),
      uploaded: optionalIsoDate(raw.uploaded),
      receiptDate: optionalIsoDate(raw.receiptDate),
      amount: optionalNumber(raw.amount),
      currency: optionalText(raw.currency, 12),
      amountSgdApprox: optionalNumber(raw.amountSgdApprox),
      vendor: optionalText(raw.vendor),
      purpose: optionalText(raw.purpose),
    });
  }
  return receipts;
}

function jsonResponse(body: unknown, corsHeaders: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const result = await gmail.scanAll(env, gmailImporter(env, ctx));
    for (const account of result.accounts) {
      console.log(
        `gmail scan ${account.email}: ${account.imported.length} imported, ${account.checked} checked` +
          (account.errors.length ? `, errors: ${account.errors.join('; ')}` : '')
      );
    }
    if (result.skipped) console.log(`gmail scan skipped: ${result.skipped}`);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = getCorsHeaders(request, env);

    // Cloudflare Access gate. Covers static pages, the API and the OAuth
    // callbacks alike: the callbacks are browser redirects, so they arrive with
    // the Access session cookie of the signed-in browser.
    const access = await verifyAccess(request, env);
    if (access.enforced && !access.ok) {
      console.warn(`access denied ${request.method} ${path}: ${access.reason}`);
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Block cross-origin requests from disallowed origins
    const origin = request.headers.get('Origin');
    if (origin && corsHeaders['Access-Control-Allow-Origin'] === '') {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Check auth for API routes. /xero/* and /gmail/* are gated too, EXCEPT their /callback,
    // which require a server-issued, atomically consumed OAuth transaction.
    // (/xero/connect is a header-authed POST so the auth token never lands in a URL.)
    const isApiRoute =
      ['/upload', '/list', '/receipt/', '/ynab/', '/amount-tags/', '/gst-tags/', '/agent/', '/ai/'].some(
        (route) => path === route || path.startsWith(route)
      ) ||
      (path.startsWith('/xero/') && path !== '/xero/callback') ||
      (path.startsWith('/gmail/') && path !== '/gmail/callback');

    if (isApiRoute) {
      const authed = validateAuth(request, env);
      // A locked-out IP gets 429 for every password, right or wrong, so the
      // status code never tells a guesser which one was right.
      const limited =
        (request.headers.has('X-Auth-Token') && (await authLockedOut(request, env))) ||
        (!authed && (await recordAuthFailure(request, env)));
      if (limited) {
        return new Response(JSON.stringify({ error: 'Too many attempts. Try again in a few minutes.' }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(AUTH_LOCKOUT_SECONDS) },
        });
      }
      if (!authed) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    try {
      // API routes
      // Sidecars are internal records, never receipt downloads or tag targets.
      if (path.startsWith('/receipt/') && isInternalKey(decodeURIComponent(path.slice('/receipt/'.length)))) {
        return Response.json({ error: 'Receipt not found' }, { status: 404, headers: corsHeaders });
      }
      if (path.startsWith('/receipt/') && path.endsWith('/invoice-edits')
        && ['GET', 'PATCH'].includes(request.method)) {
        const key = decodeURIComponent(path.slice('/receipt/'.length, -'/invoice-edits'.length));
        const response = await invoiceEditsResponse(request, env.RECEIPTS, key);
        return new Response(response.body, {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      // POST /upload - Upload a receipt
      if (path === '/upload' && request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
          return new Response(JSON.stringify({ error: 'No file provided' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Validate file size
        if (file.size > MAX_FILE_SIZE) {
          return new Response(
            JSON.stringify({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Validate file extension, falling back to browser-provided MIME for
        // mobile uploads that arrive as extensionless "image" or "blob" files.
        const ext = getUploadExtension(file.name, file.type);
        if (!ext) {
          return new Response(
            JSON.stringify({
              error: `Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
            }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const storageFilename = buildStorageFilename(file.name, ext);
        const key = generateKey(storageFilename);
        const arrayBuffer = await file.arrayBuffer();

        // Store a canonical supported MIME, never a caller-supplied active type.
        // Empty/octet-stream MIME is common on mobile; still validate by extension.
        const mimeType = EXT_MIME[ext];
        const suppliedMime = normaliseMimeType(file.type);
        const suppliedExt = ALLOWED_MIME_EXTENSIONS[suppliedMime];
        if ((suppliedMime && suppliedMime !== 'application/octet-stream' && EXT_MIME[suppliedExt] !== mimeType)
          || !validateMagicBytes(arrayBuffer, mimeType)) {
          return new Response(
            JSON.stringify({ error: 'File content does not match declared type' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        await env.RECEIPTS.put(key, arrayBuffer, {
          httpMetadata: {
            contentType: mimeType || EXT_MIME[ext] || 'application/octet-stream',
          },
          customMetadata: {
            originalName: file.name,
            uploadedAt: new Date().toISOString(),
          },
        });

        // Tag amount in background for newly uploaded receipts.
        ctx.waitUntil(tagReceiptAmount(env, key));

        return new Response(JSON.stringify({ success: true, key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /list - List receipts with optional pagination
      if (path === '/list' && request.method === 'GET') {
        const limitParam = parseInt(url.searchParams.get('limit') || '100', 10);
        const limit = Math.min(Math.max(isNaN(limitParam) ? 100 : limitParam, 1), 1000);
        const cursor = url.searchParams.get('cursor') || undefined;

        const result = await listReceiptSummaries(env, { limit, cursor });

        return new Response(
          JSON.stringify({
            receipts: result.receipts,
            cursor: result.cursor,
            hasMore: result.hasMore,
          }),
          {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Server-Timing': serverTimingHeader([
                { name: 'r2-list', ms: result.timings.listMs, desc: `${result.receipts.length} receipts` },
                {
                  name: 'r2-metadata',
                  ms: result.timings.metadataMs,
                  desc: result.timings.headFallbacks ? `${result.timings.headFallbacks} head() fallbacks` : 'inline',
                },
              ]),
            },
          }
        );
      }

      // POST /amount-tags/pending - Tag a batch of untagged, unlinked pending receipts
      if (path === '/amount-tags/pending' && request.method === 'POST') {
        if (!hasVisionKey(await ai.withAiSettings(env))) {
          return new Response(JSON.stringify({ error: 'No AI key is set. Add one under Settings > AI.' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const requestedLimit = parseInt(url.searchParams.get('limit') || String(DEFAULT_AMOUNT_TAG_BATCH), 10);
        const limit = Math.min(
          Math.max(Number.isNaN(requestedLimit) ? DEFAULT_AMOUNT_TAG_BATCH : requestedLimit, 1),
          MAX_AMOUNT_TAG_BATCH
        );

        const result = await tagPendingReceipts(env, limit);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /gst-tags/pending - Detect GST for a batch of receipts that have
      // no GST verdict yet (includes linked/ready-to-claim receipts; skips
      // anything already pushed to Xero). Used to backfill existing receipts.
      if (path === '/gst-tags/pending' && request.method === 'POST') {
        if (!hasVisionKey(await ai.withAiSettings(env))) {
          return new Response(JSON.stringify({ error: 'No AI key is set. Add one under Settings > AI.' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const requestedLimit = parseInt(url.searchParams.get('limit') || String(DEFAULT_GST_TAG_BATCH), 10);
        const limit = Math.min(
          Math.max(Number.isNaN(requestedLimit) ? DEFAULT_GST_TAG_BATCH : requestedLimit, 1),
          MAX_GST_TAG_BATCH
        );

        const result = await tagPendingGst(env, limit);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /receipt/:key/tag-gst - Re-run GST detection for one receipt
      if (path.startsWith('/receipt/') && path.endsWith('/tag-gst') && request.method === 'POST') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/tag-gst', ''));
        const result = await tagReceiptGst(env, key, { force: true });
        const statusCode = result.status === 'failed' ? 500 : 200;

        return new Response(JSON.stringify(result), {
          status: statusCode,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /receipt/:key/tag-amount - Tag amount for one receipt
      if (path.startsWith('/receipt/') && path.endsWith('/tag-amount') && request.method === 'POST') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/tag-amount', ''));
        const result = await tagReceiptAmount(env, key, { force: true });
        const statusCode = result.status === 'failed' ? 500 : 200;

        return new Response(JSON.stringify(result), {
          status: statusCode,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // PATCH /receipt/:key/xero-pending - drop leftover draft-push stamps only.
      // Never deletes the receipt object. Never marks claims CLAIMED.
      if (path.startsWith('/receipt/') && path.endsWith('/xero-pending') && request.method === 'PATCH') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/xero-pending', ''));
        const body = (await request.json().catch(() => ({}))) as { clear?: unknown };
        if (body.clear !== true) {
          return new Response(JSON.stringify({ error: 'Pass { "clear": true } to drop leftover draft stamps.' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const updated = await patchReceiptMetadata(env, key, {
          xeroPendingInvoiceId: undefined,
          xeroPendingInvoiceNumber: undefined,
          xeroPendingAt: undefined,
          xeroPendingClaimsBackend: undefined,
        });
        if (!updated) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, key, cleared: ['xeroPendingInvoiceId', 'xeroPendingInvoiceNumber', 'xeroPendingAt', 'xeroPendingClaimsBackend'] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // PATCH /receipt/:key/receipt-date - Manually override receipt date
      if (path.startsWith('/receipt/') && path.endsWith('/receipt-date') && request.method === 'PATCH') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/receipt-date', ''));
        const body = (await request.json()) as { receiptDate?: string | null };
        const manualDate = body.receiptDate ? extractIsoDate(body.receiptDate) : null;

        if (body.receiptDate && !manualDate) {
          return new Response(JSON.stringify({ error: 'receiptDate must be YYYY-MM-DD' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const head = await env.RECEIPTS.head(key);
        if (!head) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const detectedDate = extractIsoDate(head.customMetadata?.detectedReceiptDate);
        const fallbackDate = detectedDate || undefined;
        const fallbackSource = detectedDate ? 'ai' : undefined;

        const updated = await patchReceiptMetadata(env, key, {
          receiptDate: manualDate || fallbackDate,
          receiptDateSource: manualDate ? 'manual' : fallbackSource,
        });
        if (!updated) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({
            success: true,
            key,
            receiptDate: manualDate || fallbackDate || null,
            receiptDateSource: manualDate ? 'manual' : fallbackSource || null,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /receipt/:key - Download a receipt
      if (path.startsWith('/receipt/') && request.method === 'GET') {
        const key = decodeURIComponent(path.replace('/receipt/', ''));
        const object = await env.RECEIPTS.get(key);

        if (!object) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const headers = new Headers(corsHeaders);
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('Content-Disposition', `inline; filename="${key}"`);

        return new Response(object.body, { headers });
      }

      // DELETE /receipt/:key - Delete a receipt
      if (path.startsWith('/receipt/') && request.method === 'DELETE' && !path.endsWith('/link')) {
        const key = decodeURIComponent(path.replace('/receipt/', ''));
        await env.RECEIPTS.delete(key);

        return new Response(JSON.stringify({ success: true, deleted: key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // PATCH /receipt/:key/link - Link a receipt to a YNAB claim
      if (path.startsWith('/receipt/') && path.endsWith('/link') && request.method === 'PATCH') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/link', ''));
        const body = (await request.json()) as {
          backend?: unknown;
          expectedClaimsBackend?: unknown;
          linkedClaimId?: string;
          linkedClaimDescription?: string;
          linkedClaimAmount?: number;
          linkedClaimDate?: string;
          linkedClaims?: LinkedClaimPayload[];
        };
        const backend = parseMutationBackend(body.backend);
        const expectedClaimsBackend = body.expectedClaimsBackend === undefined
          ? undefined
          : parseExplicitClaimsBackend(body.expectedClaimsBackend);
        if (expectedClaimsBackend && expectedClaimsBackend !== backend) {
          throw new ClaimsBackendInputError('Expected claims backend must match the link backend.');
        }

        const linkedClaims = Array.isArray(body.linkedClaims) && body.linkedClaims.length > 0
          ? body.linkedClaims
          : body.linkedClaimId && body.linkedClaimDescription
            ? [
                {
                  id: body.linkedClaimId,
                  description: body.linkedClaimDescription,
                  amount: body.linkedClaimAmount,
                  date: body.linkedClaimDate,
                },
              ]
            : [];

        const normalisedClaims = linkedClaims
          .map((claim) => ({
            id: String(claim.id || '').trim(),
            description: String(claim.description || '').trim(),
            amount: Number.isFinite(claim.amount) ? Number(claim.amount) : undefined,
            date: extractIsoDate(claim.date || undefined) || undefined,
          }))
          .filter((claim) => claim.id && claim.description);

        if (normalisedClaims.length === 0) {
          return new Response(JSON.stringify({ error: 'At least one claim is required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const dedupedClaims = Array.from(
          new Map(normalisedClaims.map((claim) => [claim.id, claim])).values()
        );
        const primaryClaim = dedupedClaims[0];
        const linkedClaimDescription = dedupedClaims.length === 1
          ? primaryClaim.description
          : `${dedupedClaims.length} claims linked`;

        const updated = await patchReceiptMetadata(env, key, {
          linkedClaimId: primaryClaim.id,
          linkedClaimIds: JSON.stringify(dedupedClaims.map((claim) => claim.id)),
          linkedClaimDescription,
          linkedClaimAmount:
            typeof primaryClaim.amount === 'number' ? String(primaryClaim.amount) : undefined,
          linkedClaimDate: primaryClaim.date,
          linkedClaimsBackend: backend,
        }, expectedClaimsBackend);
        if (!updated) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // DELETE /receipt/:key/link - Unlink a receipt from a claim
      if (path.startsWith('/receipt/') && path.endsWith('/link') && request.method === 'DELETE') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/link', ''));
        const backend = parseMutationBackend(
          url.searchParams.has('backend') ? url.searchParams.get('backend') : undefined
        );

        const updated = await patchReceiptMetadata(env, key, {
          linkedClaimId: undefined,
          linkedClaimIds: undefined,
          linkedClaimDescription: undefined,
          linkedClaimAmount: undefined,
          linkedClaimDate: undefined,
          linkedClaimsBackend: undefined,
        }, backend);
        if (!updated) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /ynab/todos - Fetch pending claims from HowMuch (default) or YNAB.
      if (path === '/ynab/todos' && request.method === 'GET') {
        try {
          const sinceDate = extractIsoDate(url.searchParams.get('since_date')) || getDefaultYnabSinceDate();
          const backend = parseClaimsBackend(url.searchParams.get('backend'));
          const upstreamStarted = Date.now();
          const todos = await fetchYnabTodos(env, sinceDate, backend);
          const upstreamMs = Date.now() - upstreamStarted;

          return new Response(JSON.stringify({ todos, backend }), {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Server-Timing': serverTimingHeader([
                { name: 'claims-upstream', ms: upstreamMs, desc: `${backend} since ${sinceDate}, ${todos.length} todos` },
              ]),
            },
          });
        } catch (error) {
          if (error instanceof ClaimsBackendApiError) {
            return new Response(JSON.stringify({ error: error.message, details: error.details }), {
              status: error.status,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const message = error instanceof Error ? error.message : 'Failed to fetch claims data';
          return new Response(JSON.stringify({ error: message }), {
            status: error instanceof ClaimsBackendInputError ? 400 : 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /agent/unclaimed-expenditures - Agent-friendly report of TODO claims without linked receipts
      if (path === '/agent/unclaimed-expenditures' && request.method === 'GET') {
        try {
          const sinceDate = extractIsoDate(url.searchParams.get('since_date')) || getDefaultYnabSinceDate();
          const backend = parseClaimsBackend(url.searchParams.get('backend'));
          const [todos, receiptResult] = await Promise.all([
            fetchYnabTodos(env, sinceDate, backend),
            listAllReceiptSummaries(env),
          ]);

          const linkedReceiptsByClaimId = new Map<string, ReceiptSummary[]>();
          receiptResult.receipts.forEach((receipt) => {
            if (receipt.linkedClaimsBackend !== backend) return;
            receipt.linkedClaimIds.forEach((claimId) => {
              const linkedReceipts = linkedReceiptsByClaimId.get(claimId) || [];
              linkedReceipts.push(receipt);
              linkedReceiptsByClaimId.set(claimId, linkedReceipts);
            });
          });

          const missingReceiptClaims = todos
            .filter((todo) => !linkedReceiptsByClaimId.has(todo.id))
            .map((todo) => ({
              ...todo,
              receiptSearchHints: buildReceiptSearchHints(todo),
            }));
          const linkedClaims = todos
            .filter((todo) => linkedReceiptsByClaimId.has(todo.id))
            .map((todo) => ({
              ...todo,
              linkedReceipts: linkedReceiptsByClaimId.get(todo.id) || [],
            }));
          const unlinkedReceipts = receiptResult.receipts.filter((receipt) => receipt.linkedClaimIds.length === 0);

          return new Response(
            JSON.stringify({
              generatedAt: new Date().toISOString(),
              sinceDate,
              backend,
              summary: {
                todoClaimCount: todos.length,
                missingReceiptClaimCount: missingReceiptClaims.length,
                linkedClaimCount: linkedClaims.length,
                unlinkedReceiptCount: unlinkedReceipts.length,
                receiptScanTruncated: receiptResult.truncated,
              },
              missingReceiptClaims,
              linkedClaims,
              unlinkedReceipts,
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        } catch (error) {
          if (error instanceof ClaimsBackendApiError) {
            return new Response(JSON.stringify({ error: error.message, details: error.details }), {
              status: error.status,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const message = error instanceof Error ? error.message : 'Failed to build agent claim report';
          return new Response(JSON.stringify({ error: message }), {
            status: error instanceof ClaimsBackendInputError ? 400 : 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // --- Gmail receipt import ---------------------------------------------

      // POST /gmail/connect - begin linking a Gmail account. Same pattern as
      // /xero/connect: header-authed, CSRF state in an HttpOnly cookie.
      if (path === '/gmail/connect' && request.method === 'POST') {
        if (!(await gmail.isConfigured(env))) {
          return jsonResponse(
            { error: 'Gmail import is not set up yet. Add the Google client ID and secret in the Gmail panel first.' },
            corsHeaders,
            503
          );
        }
        const state = await beginOAuth(env.RECEIPTS, 'gmail', url.origin);
        const secure = url.protocol === 'https:' ? '; Secure' : '';
        return new Response(JSON.stringify({ authorizeUrl: await gmail.buildAuthorizeUrl(env, request.url, state) }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Set-Cookie': `gmail_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`,
          },
        });
      }

      // GET /gmail/callback - Google redirects here after consent.
      if (path === '/gmail/callback' && request.method === 'GET') {
        const noLeak = { ...corsHeaders, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
        const oauthError = url.searchParams.get('error');
        // Failures land back in the app with a short code the UI explains,
        // rather than on a bare error page.
        const backToApp = (query: string) =>
          new Response(null, {
            status: 302,
            headers: {
              ...noLeak,
              Location: `${url.origin}/?${query}`,
              'Set-Cookie': 'gmail_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
            },
          });
        if (oauthError) {
          return backToApp(`gmailError=${oauthError === 'access_denied' ? 'access_denied' : 'failed'}`);
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const cookieState = parseCookie(request.headers.get('Cookie'), 'gmail_oauth_state');
        if (!code || !state || !cookieState
          || !(await consumeOAuth(env.RECEIPTS, 'gmail', url.origin, state, cookieState))) {
          return backToApp('gmailError=expired');
        }
        let email: string;
        try {
          email = await gmail.exchangeCode(env, request.url, code);
        } catch (err) {
          console.log(`gmail link failed: ${err instanceof Error ? err.message : String(err)}`);
          return backToApp('gmailError=failed');
        }
        return backToApp(`gmail=${encodeURIComponent(email)}`);
      }

      // GET /gmail/status - linked accounts and their last scan
      if (path === '/gmail/status' && request.method === 'GET') {
        return jsonResponse(await gmail.getStatus(env, request.url), corsHeaders);
      }

      // PUT /gmail/client { clientId, clientSecret } - save the Google OAuth
      // client from the app (ignored when the Worker secrets are set).
      // DELETE /gmail/client - forget it.
      if (path === '/gmail/client' && request.method === 'PUT') {
        const body = (await request.json().catch(() => ({}))) as { clientId?: unknown; clientSecret?: unknown };
        try {
          await gmail.saveClient(
            env,
            typeof body.clientId === 'string' ? body.clientId : '',
            typeof body.clientSecret === 'string' ? body.clientSecret : ''
          );
        } catch (err) {
          if (err instanceof gmail.GmailClientInputError) {
            return jsonResponse({ error: err.message }, corsHeaders, 400);
          }
          throw err;
        }
        return jsonResponse({ success: true }, corsHeaders);
      }
      if (path === '/gmail/client' && request.method === 'DELETE') {
        await gmail.clearClient(env);
        return jsonResponse({ success: true }, corsHeaders);
      }

      // GET /ai/settings - which AI keys are set (never the keys themselves),
      // the receipt-reading provider and the Claude model.
      if (path === '/ai/settings' && request.method === 'GET') {
        return jsonResponse(await ai.getSettingsStatus(env), corsHeaders);
      }

      // PUT /ai/settings { keys?: { anthropic?: string|null, ... },
      // visionProvider?, claudeModel? } - null removes an app-saved key.
      if (path === '/ai/settings' && request.method === 'PUT') {
        const body = (await request.json().catch(() => ({}))) as ai.AiSettingsUpdate;
        const keys = body.keys && typeof body.keys === 'object' ? body.keys : undefined;
        try {
          await ai.saveSettings(env, { keys, visionProvider: body.visionProvider, claudeModel: body.claudeModel });
        } catch (err) {
          if (err instanceof ai.AiSettingsInputError) {
            return jsonResponse({ error: err.message }, corsHeaders, 400);
          }
          throw err;
        }
        return jsonResponse(await ai.getSettingsStatus(env), corsHeaders);
      }

      // POST /ai/match { claims: [...], receipts: [...] } - ask Claude to pair
      // outstanding claims with unlinked receipts. Suggestions only; nothing
      // is linked until the user accepts one.
      if (path === '/ai/match' && request.method === 'POST') {
        const aiEnv = await ai.withAiSettings(env);
        if (!aiEnv.ANTHROPIC_API_KEY) {
          return jsonResponse({ error: 'Add a Claude API key under Settings > AI first.' }, corsHeaders, 400);
        }
        const body = (await request.json().catch(() => ({}))) as { claims?: unknown; receipts?: unknown };
        const claims = parseMatchClaims(body.claims);
        const receipts = parseMatchReceipts(body.receipts);
        if (claims.length === 0 || receipts.length === 0) {
          return jsonResponse({ matches: [], model: null }, corsHeaders);
        }
        try {
          return jsonResponse(await ai.suggestMatches(aiEnv, claims, receipts), corsHeaders);
        } catch (err) {
          console.log(`ai match failed: ${cleanError(err)}`);
          return jsonResponse({ error: `Claude couldn't suggest matches: ${cleanError(err)}` }, corsHeaders, 502);
        }
      }

      // POST /gmail/disconnect { email } - unlink one account
      if (path === '/gmail/disconnect' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { email?: unknown };
        const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
        if (!email) return jsonResponse({ error: 'email is required' }, corsHeaders, 400);
        const removed = await gmail.removeAccount(env, email);
        return jsonResponse({ success: removed }, corsHeaders, removed ? 200 : 404);
      }

      // POST /gmail/scan[?email=] - scan linked accounts now (the cron does
      // the same on a schedule)
      if (path === '/gmail/scan' && request.method === 'POST') {
        const only = url.searchParams.get('email')?.toLowerCase() || undefined;
        return jsonResponse(await gmail.scanAll(env, gmailImporter(env, ctx), only), corsHeaders);
      }

      // --- Xero integration ---------------------------------------------

      // POST /xero/connect - begin the OAuth flow. Header-authed (X-Auth-Token,
      // via the API-route gate); returns the authorize URL for the SPA to
      // navigate to. R2 binds the callback to an authorized initiation, and an
      // HttpOnly cookie binds it to the browser. The auth token stays out of URLs.
      if (path === '/xero/connect' && request.method === 'POST') {
        if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET || !env.XERO_TOKENS) {
          return new Response(
            JSON.stringify({
              error:
                'Xero is not configured on this deployment (needs the XERO_CLIENT_ID/XERO_CLIENT_SECRET secrets and the XERO_TOKENS KV binding — see setup).',
            }),
            { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const state = await beginOAuth(env.RECEIPTS, 'xero', url.origin);
        const authorizeUrl = xero.buildAuthorizeUrl(env, request.url, state);
        const secure = url.protocol === 'https:' ? '; Secure' : '';
        return new Response(JSON.stringify({ authorizeUrl }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Set-Cookie': `xero_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`,
          },
        });
      }

      // GET /xero/callback - consumes the transaction issued by /xero/connect.
      if (path === '/xero/callback' && request.method === 'GET') {
        // The callback URL carries the one-time OAuth code — keep it out of
        // caches and referrers.
        const noLeak = { ...corsHeaders, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          return new Response(`Xero authorisation failed: ${oauthError}`, { status: 400, headers: noLeak });
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const cookieState = parseCookie(request.headers.get('Cookie'), 'xero_oauth_state');
        if (!code || !state || !cookieState
          || !(await consumeOAuth(env.RECEIPTS, 'xero', url.origin, state, cookieState))) {
          return new Response('Invalid or expired authorisation state.', { status: 400, headers: noLeak });
        }
        try {
          await xero.exchangeCode(env, request.url, code);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Xero token exchange failed';
          return new Response(message, { status: 502, headers: noLeak });
        }
        return new Response(null, {
          status: 302,
          headers: {
            ...noLeak,
            Location: `${url.origin}/invoices?xero=connected`,
            'Set-Cookie': 'xero_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
          },
        });
      }

      // GET /xero/status - connection status for the UI
      if (path === '/xero/status' && request.method === 'GET') {
        return new Response(JSON.stringify(await xero.getStatus(env)), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /xero/disconnect - forget stored tokens
      if (path === '/xero/disconnect' && request.method === 'POST') {
        await xero.clearAuth(env);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /xero/meta - tax rates + expense accounts for the editor dropdowns
      if (path === '/xero/meta' && request.method === 'GET') {
        try {
          const [taxRates, accounts] = await Promise.all([xero.getTaxRates(env), xero.getExpenseAccounts(env)]);
          return new Response(JSON.stringify({ taxRates, accounts }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to load Xero metadata';
          return new Response(JSON.stringify({ error: message }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // POST /xero/invoices/receipts-pdf - compile selected receipts into one PDF
      // for manual upload in Xero when direct attachment upload is unsuitable.
      if (path === '/xero/invoices/receipts-pdf' && request.method === 'POST') {
        try {
          const body = (await request.json()) as {
            bucket?: string;
            lineItems?: PushLineItem[];
          };
          const lineItems = parsePushLineItems(body.lineItems);
          if (lineItems.length === 0) {
            return new Response(JSON.stringify({ error: 'No valid line items to compile' }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const bucketLabel = body.bucket === 'gst' ? 'GST' : body.bucket === 'transport' ? 'Transport' : 'Non-GST';
          const compiled = await buildClaimReceiptPdf(env, lineItems, `${bucketLabel} ${singaporeToday()}`);
          const headers = new Headers(corsHeaders);
          headers.set('Content-Type', 'application/pdf');
          headers.set('Content-Disposition', `attachment; filename="${compiled.name}"`);
          if (compiled.warnings.length) {
            headers.set('X-Receipt-Warnings', compiled.warnings.slice(0, 10).join(' | ').replace(/[^\x20-\x7E]/g, '?'));
          }
          const bodyBytes = new ArrayBuffer(compiled.bytes.byteLength);
          new Uint8Array(bodyBytes).set(compiled.bytes);
          return new Response(bodyBytes, { headers });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to compile receipts PDF';
          return new Response(JSON.stringify({ error: message }), {
            status: err instanceof ClaimsBackendInputError ? 400 : 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // POST /xero/invoices/mark-claimed - after the draft bill and receipts
      // have been reviewed, tag receipts as invoiced and flip linked claim TODOs.
      if (path === '/xero/invoices/mark-claimed' && request.method === 'POST') {
        try {
          const body = (await request.json()) as {
            invoiceID?: string;
            lineItems?: PushLineItem[];
            backend?: unknown;
          };
          const invoiceID = typeof body.invoiceID === 'string' ? body.invoiceID : '';
          const lineItems = parsePushLineItems(body.lineItems);
          if (!invoiceID || lineItems.length === 0) {
            return new Response(JSON.stringify({ error: 'invoiceID and at least one line item are required' }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const backend = resolveMutationBackend(body.backend, lineItems);

          const claimedDate = singaporeToday();
          const claims = Array.from(
            new Map(
              lineItems
                .filter((line): line is ClaimLine => Boolean(line.ynabClaimId))
                .map((line) => [line.ynabClaimId, line])
            ).values()
          );
          let claimedYnab: Array<{ id: string; status: string; detail?: string }>;
          if (backend === 'howmuch') {
            claimedYnab = await markHowMuchClaimed(env, claims, claimedDate);
          } else {
            claimedYnab = [];
            for (const claim of claims) {
              const result = await markYnabClaimed(env, claim.ynabClaimId, claimedDate, backend, claim.claimSource || null);
              claimedYnab.push({ id: claim.ynabClaimId, ...result });
            }
          }

          const ynabIssues = claimedYnab.filter((item) => item.status === 'failed');
          if (ynabIssues.length > 0) {
            return new Response(
              JSON.stringify({
                error: `${backend === 'howmuch' ? 'HowMuch' : 'YNAB'} update failed; receipts were not marked invoiced.`,
                claimedDate,
                taggedReceipts: [],
                claimedYnab,
              }),
              { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }

          const invoicedAt = new Date().toISOString();
          const uniqueKeys = Array.from(new Set(lineItems.map((l) => l.receiptKey)));
          const taggedReceipts: Array<{ key: string; status: string }> = [];
          for (const key of uniqueKeys) {
            try {
              await patchReceiptMetadata(env, key, {
                xeroInvoiceId: invoiceID,
                invoicedAt,
                xeroPendingInvoiceId: undefined,
                xeroPendingInvoiceNumber: undefined,
                xeroPendingAt: undefined,
                xeroPendingClaimsBackend: undefined,
              });
              taggedReceipts.push({ key, status: 'tagged' });
            } catch (err) {
              taggedReceipts.push({ key, status: `failed: ${cleanError(err)}` });
            }
          }

          return new Response(
            JSON.stringify({ success: true, backend, claimedDate, taggedReceipts, claimedYnab }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to mark claims as claimed';
          return new Response(JSON.stringify({ error: message }), {
            status: err instanceof ClaimsBackendInputError ? 400 : 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // POST /xero/invoices/push - create a DRAFT bill and attempt to attach
      // receipts. YNAB/receipt state is changed only by /mark-claimed.
      if (path === '/xero/invoices/push' && request.method === 'POST') {
        try {
          const body = (await request.json()) as {
            bucket?: string;
            reference?: string;
            lineItems?: PushLineItem[];
            receiptPdf?: unknown;
            backend?: unknown;
          };
          const lineItems = parsePushLineItems(body.lineItems).map((l) => ({
            ...l,
            taxType: taxTypeForBucket(body.bucket, l),
          }));
          if (lineItems.length === 0) {
            return new Response(JSON.stringify({ error: 'No valid line items to invoice (each needs a positive amount, account and tax code)' }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const backend = resolveMutationBackend(body.backend, lineItems);

          const bucketLabel = body.bucket === 'gst' ? 'GST' : body.bucket === 'transport' ? 'Transport' : 'Non-GST';
          // Fallback bill name is the bucket only — avoid a trailing "claims",
          // which reads like already reimbursed. HowMuch/YNAB stay TODO until /mark-claimed.
          // Bill date in Singapore time — toISOString() is UTC and would backdate
          // the bill by a day when pushing between 00:00 and 07:59 SGT.
          const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date());
          const dueDate = addCalendarDays(today, 30);
          // Deterministic key over the full line shape (sorted, order-independent):
          // an identical re-push dedupes, but editing account/tax/description/amount
          // produces a new key so edits aren't silently swallowed by Xero.
          const lineKeys = lineItems
            .map((l) => `${l.receiptKey}:${Number(l.amount).toFixed(2)}:${l.accountCode}:${l.taxType}:${l.description}`)
            .sort();
          const idem = await xero.idempotencyKey(['claim-bill', backend, body.bucket || '', body.reference || '', ...lineKeys]);

          const bill = await xero.createBill(env, {
            contactName: 'Soon Yin Jie',
            date: today,
            dueDate,
            reference: body.reference || bucketLabel,
            idempotencyKey: idem,
            lineItems: lineItems.map((l) => ({
              description: l.description,
              accountCode: l.accountCode,
              taxType: l.taxType,
              amount: Number(l.amount),
            })),
          });

          // Attach receipts serially (Xero allows 5 concurrent; serial is safe).
          const browserPdf = uploadFromBrowserReceiptPdf(body.receiptPdf);
          let uploads: AttachmentUpload[];
          let warnings: string[];
          if (browserPdf.upload) {
            uploads = [browserPdf.upload];
            warnings = browserPdf.warnings;
          } else {
            const fallback = await buildClaimAttachments(env, lineItems, `${bucketLabel} ${today}`);
            uploads = fallback.uploads;
            warnings = [...browserPdf.warnings, ...fallback.warnings];
          }
          const attachments: Array<{ name: string; status: string }> = [];
          for (const up of uploads) {
            try {
              await xero.attachToInvoice(env, bill.invoiceID, up.name, up.bytes, up.mime);
              attachments.push({ name: up.name, status: 'attached' });
            } catch (err) {
              attachments.push({ name: up.name, status: `failed: ${err instanceof Error ? err.message : 'error'}` });
            }
          }

          // "Fully attached" means buildClaimAttachments dropped nothing
          // (unattachable type, missing, oversize, embed/merge failure all add a
          // warning) AND every upload succeeded.
          const failedUploads = attachments.filter((a) => a.status !== 'attached');
          const allAttached = warnings.length === 0 && failedUploads.length === 0;

          if (!allAttached) {
            warnings.push(
              'Not every receipt was attached through the Xero API. Download the compiled receipts PDF and upload it manually in Xero before marking everything claimed.'
            );
          }

          const pendingAt = new Date().toISOString();
          const pendingReceiptFailures: string[] = [];
          const uniqueReceiptKeys = Array.from(new Set(lineItems.map((line) => line.receiptKey)));
          for (const key of uniqueReceiptKeys) {
            try {
              await patchReceiptMetadata(env, key, {
                xeroPendingInvoiceId: bill.invoiceID,
                xeroPendingInvoiceNumber: bill.invoiceNumber,
                xeroPendingAt: pendingAt,
                xeroPendingClaimsBackend: backend,
              });
            } catch (err) {
              pendingReceiptFailures.push(`${key}: ${cleanError(err)}`);
            }
          }
          if (pendingReceiptFailures.length > 0) {
            warnings.push(
              `Draft bill was created, but ${pendingReceiptFailures.length} receipt(s) could not remember the Xero bill id. Keep this result box open before marking claimed.`
            );
          }

          return new Response(
            JSON.stringify({
              invoiceID: bill.invoiceID,
              invoiceNumber: bill.invoiceNumber,
              backend,
              url: bill.url,
              allAttached,
              attachments,
              warnings,
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to push invoice to Xero';
          return new Response(JSON.stringify({ error: message }), {
            status: err instanceof ClaimsBackendInputError ? 400 : 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Serve static assets for all other routes
      const spaPaths = new Set(['/invoices']);
      const assetResponse = await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        {
          ASSET_NAMESPACE: env.__STATIC_CONTENT,
          ASSET_MANIFEST: assetManifest,
          mapRequestToAsset: (req) => {
            const assetUrl = new URL(req.url);
            let assetPath = assetUrl.pathname;
            if (assetPath.length > 1 && assetPath.endsWith('/')) {
              assetPath = assetPath.slice(0, -1);
            }
            if (assetPath === '/' || spaPaths.has(assetPath)) {
              assetUrl.pathname = '/index.html';
              return new Request(assetUrl.toString(), req);
            }
            return req;
          },
        }
      );
      const headers = new Headers(assetResponse.headers);
      // Revalidate on every visit (ETag → 304) instead of re-downloading the
      // whole module graph; a deploy still shows up immediately.
      headers.set('Cache-Control', 'no-cache');
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    } catch (error) {
      // If asset not found, return 404
      if (error instanceof Error && error.message.includes('could not find')) {
        return new Response('Not found', { status: 404 });
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: error instanceof ClaimsBackendInputError ? 400 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
