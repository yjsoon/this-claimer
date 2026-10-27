import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { htmlToText, MAX_RECEIPT_HTML } from '../shared/receipt-html';

type Provider = 'grab' | 'gojek';

interface SearchThread {
  id: string;
  date?: string;
  from?: string;
  subject?: string;
  labels?: string[];
  messageCount?: number;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

interface ThreadGetResult {
  thread: {
    id: string;
    messages: GmailMessage[];
  };
}

interface ReceiptDetails {
  receiptId: string;
  idLabel: 'bookingId' | 'orderId';
  date: string;
  amount: string;
}

interface ProviderConfig {
  query: string;
  isReceipt: (text: string) => boolean;
  extractDetails: (text: string) => ReceiptDetails;
}

interface Options {
  account: string;
  provider: Provider;
  query?: string;
  threadId?: string;
  out?: string;
  max: number;
  open: boolean;
  keepHtml: boolean;
  sinceLastExported: boolean;
  labelExported: boolean;
}

const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

const PROVIDERS: Record<Provider, ProviderConfig> = {
  grab: {
    query: 'from:grab subject:"Your Grab E-Receipt" newer_than:30d',
    isReceipt: isGrabRideReceipt,
    extractDetails: extractGrabDetails,
  },
  gojek: {
    query: '"Your trip with Gojek" newer_than:30d',
    isReceipt: (text) => /Order ID:\s*RB-/i.test(text) && /Thanks for ordering Gojek/i.test(text) && /Total paid\s+S\$/i.test(text),
    extractDetails: extractGojekDetails,
  },
};

function usage(): never {
  console.error(`Usage:
  npm run export:ride -- --provider <grab|gojek> [options]
  npm run export:grab -- [options]
  npm run export:gojek -- [options]

Options:
  --provider <name>      Receipt provider: grab or gojek (default: grab)
  --account <email>      Gmail account in gog (default: yjsoon@gmail.com)
  --query <gmail-query>  Gmail search query for receipt threads
  --thread <thread-id>   Export a specific Gmail thread ID
  --out <path>           Output PDF path (default: ~/Downloads/provider_DATE_AMOUNT.pdf)
  --max <n>              Threads to inspect when searching (default: 10)
  --since-last-exported  Start after the newest provider receipt labelled "exported"
  --label-exported       Add Gmail label "exported" to the exported thread after PDF render
  --open                 Open the generated PDF
  --keep-html            Keep decoded HTML path in output

Examples:
  npm run export:ride -- --provider grab --query 'from:grab subject:"Your Grab E-Receipt" newer_than:30d'
  npm run export:ride -- --provider gojek --query '"Your trip with Gojek" newer_than:60d'
  npm run export:gojek -- --since-last-exported --label-exported
  npm run export:gojek -- --thread 19e90d2360cdcb0a
`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    account: 'yjsoon@gmail.com',
    provider: 'grab',
    max: 10,
    open: false,
    keepHtml: false,
    sinceLastExported: false,
    labelExported: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--provider':
        opts.provider = parseProvider(requireValue(argv, ++i, arg));
        break;
      case '--account':
        opts.account = requireValue(argv, ++i, arg);
        break;
      case '--query':
        opts.query = requireValue(argv, ++i, arg);
        break;
      case '--thread':
        opts.threadId = requireValue(argv, ++i, arg);
        break;
      case '--out':
        opts.out = requireValue(argv, ++i, arg);
        break;
      case '--max':
        opts.max = Number.parseInt(requireValue(argv, ++i, arg), 10);
        if (!Number.isFinite(opts.max) || opts.max < 1) usage();
        break;
      case '--since-last-exported':
        opts.sinceLastExported = true;
        break;
      case '--label-exported':
        opts.labelExported = true;
        break;
      case '--open':
        opts.open = true;
        break;
      case '--keep-html':
        opts.keepHtml = true;
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        usage();
    }
  }

  return opts;
}

function parseProvider(value: string): Provider {
  if (value === 'grab' || value === 'gojek') return value;
  console.error(`Unsupported provider: ${value}`);
  usage();
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    console.error(`Missing value for ${flag}`);
    usage();
  }
  return value;
}

function runGog(args: string[]): string {
  return execFileSync('gog', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function searchThreads(opts: Options, query: string): SearchThread[] {
  const raw = runGog([
    '--account',
    opts.account,
    'gmail',
    'search',
    query,
    '--max',
    String(opts.max),
    '--json',
  ]);
  const parsed = JSON.parse(raw);
  return parsed.threads ?? [];
}

function getThread(account: string, threadId: string): ThreadGetResult {
  const raw = runGog(['--account', account, 'gmail', 'thread', 'get', threadId, '--json']);
  return JSON.parse(raw);
}

function addExportedLabel(account: string, threadId: string): void {
  runGog(['--account', account, 'gmail', 'thread', 'modify', threadId, '--add', 'exported', '--json']);
}

function findHtmlPart(part?: GmailPart): string | null {
  if (!part) return null;
  if (part.mimeType === 'text/html' && part.body?.data) {
    if (part.body.data.length > Math.ceil(MAX_RECEIPT_HTML / 3) * 4) return null;
    const html = decodeBase64Url(part.body.data);
    return html.length <= MAX_RECEIPT_HTML ? html : null;
  }
  for (const child of part.parts ?? []) {
    const html = findHtmlPart(child);
    if (html) return html;
  }
  return null;
}

function decodeBase64Url(data: string): string {
  const padded = data + '='.repeat((4 - (data.length % 4)) % 4);
  return Buffer.from(padded, 'base64url').toString('utf8');
}

function isGrabRideReceipt(text: string): boolean {
  if (/\bGrab\s*Food\b|\bGrabFood\b/i.test(text)) return false;
  return /Booking ID:\s*A-/i.test(text) && /Picked up on/i.test(text) && /Total Paid/i.test(text);
}

function extractGrabDetails(text: string): ReceiptDetails {
  const receiptId = text.match(/Booking ID:\s*([A-Z0-9-]+)/i)?.[1] ?? 'unknown-booking';
  const amount = text.match(/Total Paid\s+SGD\s*([0-9]+(?:\.[0-9]{2})?)/i)?.[1]
    ?? text.match(/Total Paid\s+([0-9]+(?:\.[0-9]{2})?)/i)?.[1]
    ?? 'unknown';
  const pickedUp = text.match(/Picked up on\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  const date = pickedUp ? formatDateParts(pickedUp[3], pickedUp[2], pickedUp[1]) : 'unknown-date';
  return { receiptId, idLabel: 'bookingId', amount, date };
}

function extractGojekDetails(text: string): ReceiptDetails {
  const receiptId = text.match(/Order ID:\s*([A-Z0-9-]+)/i)?.[1] ?? 'unknown-order';
  const amount = text.match(/Total paid\s+S\$\s*([0-9]+(?:\.[0-9]{2})?)/i)?.[1]
    ?? text.match(/Total payment\s+S\$\s*([0-9]+(?:\.[0-9]{2})?)/i)?.[1]
    ?? 'unknown';
  const headerDate = text.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  const pickedUp = text.match(/Picked up on\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  const dateMatch = headerDate ?? pickedUp;
  const date = dateMatch ? formatDateParts(dateMatch[3], dateMatch[2], dateMatch[1]) : 'unknown-date';
  return { receiptId, idLabel: 'orderId', amount, date };
}

function formatDateParts(year: string, month: string, day: string): string {
  return `${year}-${MONTHS[month.toLowerCase()] ?? '01'}-${day.padStart(2, '0')}`;
}

function defaultOutputPath(provider: Provider, date: string, amount: string): string {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is not set');
  return resolve(home, 'Downloads', `${provider}_${date}_${amount}.pdf`);
}

function gmailDateForSearch(timestampMs: number): string {
  const date = new Date(timestampMs);
  date.setUTCDate(date.getUTCDate() - 1);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function findLatestExportedReceiptTimestamp(opts: Options, provider: ProviderConfig, baseQuery: string): number | null {
  const labelledThreads = searchThreads(opts, `${baseQuery} label:exported`);
  let latest: number | null = null;

  for (const candidate of labelledThreads) {
    const thread = getThread(opts.account, candidate.id);
    for (const message of thread.thread.messages) {
      const html = findHtmlPart(message.payload);
      if (!html) continue;
      const text = htmlToText(html);
      if (!provider.isReceipt(text)) continue;

      const timestamp = Number(message.internalDate ?? 0);
      if (timestamp > 0 && (latest === null || timestamp > latest)) {
        latest = timestamp;
      }
    }
  }

  return latest;
}

export async function renderPdf(htmlPath: string, pdfPath: string) {
  mkdirSync(dirname(pdfPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 900, height: 1200 }, deviceScaleFactor: 1,
      javaScriptEnabled: false, serviceWorkers: 'block',
    });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    // No file:// origin or remote assets; inline/data images still render.
    await page.setContent(readFileSync(htmlPath, 'utf8'), { waitUntil: 'load', timeout: 30000 });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const provider = PROVIDERS[opts.provider];
  const baseQuery = opts.query ?? provider.query;
  const exportedCutoff = opts.sinceLastExported && !opts.threadId
    ? findLatestExportedReceiptTimestamp(opts, provider, baseQuery)
    : null;
  const query = exportedCutoff
    ? `${baseQuery} -label:exported after:${gmailDateForSearch(exportedCutoff)}`
    : opts.sinceLastExported && !opts.threadId
      ? `${baseQuery} -label:exported`
      : baseQuery;
  const candidates = opts.threadId ? [{ id: opts.threadId }] : searchThreads(opts, query);
  if (!candidates.length) {
    if (opts.sinceLastExported && !opts.threadId) {
      console.log(JSON.stringify({
        provider: opts.provider,
        account: opts.account,
        status: 'no_new_receipts',
        query,
        sinceLastExported: opts.sinceLastExported,
        exportedCutoff: exportedCutoff ? new Date(exportedCutoff).toISOString() : null,
      }, null, 2));
      return;
    }
    throw new Error(`No ${opts.provider} receipt threads found for query: ${query}`);
  }

  let selected: { threadId: string; messageId: string; html: string; text: string } | null = null;
  let threadFallback: { threadId: string; messageId: string; html: string; text: string } | null = null;

  for (const candidate of candidates) {
    const thread = getThread(opts.account, candidate.id);
    const messages = [...thread.thread.messages].sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0));
    for (const message of messages) {
      const html = findHtmlPart(message.payload);
      if (!html) continue;
      const text = htmlToText(html);
      const timestamp = Number(message.internalDate ?? 0);
      if (exportedCutoff && timestamp > 0 && timestamp <= exportedCutoff) {
        continue;
      }
      if (provider.isReceipt(text)) {
        selected = { threadId: candidate.id, messageId: message.id, html, text };
        break;
      }
      if (opts.threadId && !threadFallback) {
        threadFallback = { threadId: candidate.id, messageId: message.id, html, text };
      }
    }
    if (selected) break;
  }

  selected ??= threadFallback;

  if (!selected) {
    if (opts.sinceLastExported && !opts.threadId) {
      console.log(JSON.stringify({
        provider: opts.provider,
        account: opts.account,
        status: 'no_new_receipts',
        query,
        sinceLastExported: opts.sinceLastExported,
        exportedCutoff: exportedCutoff ? new Date(exportedCutoff).toISOString() : null,
      }, null, 2));
      return;
    }
    throw new Error(`No ride-style ${opts.provider} receipt HTML found. Try --thread with a known receipt thread.`);
  }

  const details = provider.extractDetails(selected.text);
  const htmlPath = resolve(tmpdir(), `claim-manager-${opts.provider}-${selected.threadId}.html`);
  const pdfPath = opts.out ? resolve(opts.out) : defaultOutputPath(opts.provider, details.date, details.amount);

  writeFileSync(htmlPath, selected.html, 'utf8');
  await renderPdf(htmlPath, pdfPath);

  if (!existsSync(pdfPath) || statSync(pdfPath).size < 10_000) {
    throw new Error(`PDF render failed or output is too small: ${pdfPath}`);
  }

  if (opts.labelExported) {
    addExportedLabel(opts.account, selected.threadId);
  }

  console.log(JSON.stringify({
    provider: opts.provider,
    account: opts.account,
    threadId: selected.threadId,
    messageId: selected.messageId,
    [details.idLabel]: details.receiptId,
    date: details.date,
    amount: details.amount,
    pdfPath,
    htmlPath: opts.keepHtml ? htmlPath : basename(htmlPath),
    size: statSync(pdfPath).size,
    sinceLastExported: opts.sinceLastExported,
    exportedCutoff: exportedCutoff ? new Date(exportedCutoff).toISOString() : null,
    labelExported: opts.labelExported,
  }, null, 2));

  if (opts.open) {
    execFileSync('open', [pdfPath], { stdio: 'ignore' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
