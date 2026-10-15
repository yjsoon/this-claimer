import { config } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env'), quiet: true });

const AMOUNT_TOLERANCE = 0.01;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface YnabTodo {
  id: string;
  date: string;
  amount: number;
  payee: string;
  description: string;
}

interface ReceiptSummary {
  key: string;
  originalName?: string;
  uploaded: string;
  receiptDate?: string;
  receiptDateSource?: string;
  detectedReceiptDate?: string;
  taggedAmount?: number;
  taggedCurrency?: string;
  taggedAmountSgdApprox?: number;
  taggedAmountSgdApproxPlus325?: number;
}

interface AgentReport {
  summary: {
    missingReceiptClaimCount: number;
    unlinkedReceiptCount: number;
  };
  missingReceiptClaims: YnabTodo[];
  unlinkedReceipts: ReceiptSummary[];
}

interface Args {
  apply: boolean;
  backend: 'howmuch' | 'ynab';
  sinceDate?: string;
  nearDays: number;
  allowUploadDate: boolean;
}

interface Candidate {
  claim: YnabTodo;
  receipt: ReceiptSummary;
  receiptDate: string;
  dateSource: string;
  amount: number;
  amountKind: string;
  dayDiff: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    // Preserve the existing claims-skill workflow, which still submits and
    // cleans up against YNAB. The web app defaults to HowMuch independently.
    backend: 'ynab',
    nearDays: 0,
    allowUploadDate: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--backend') {
      const value = argv[++i];
      if (value !== 'howmuch' && value !== 'ynab') throw new Error('--backend must be howmuch or ynab');
      args.backend = value;
    } else if (arg.startsWith('--backend=')) {
      const value = arg.slice('--backend='.length);
      if (value !== 'howmuch' && value !== 'ynab') throw new Error('--backend must be howmuch or ynab');
      args.backend = value;
    } else if (arg === '--allow-upload-date') {
      args.allowUploadDate = true;
    } else if (arg === '--since-date') {
      const value = argv[++i];
      if (!value) throw new Error('--since-date requires a value (YYYY-MM-DD)');
      args.sinceDate = value;
    } else if (arg.startsWith('--since-date=')) {
      args.sinceDate = arg.slice('--since-date='.length);
    } else if (arg === '--near-days') {
      args.nearDays = parseInteger(argv[++i], '--near-days');
    } else if (arg.startsWith('--near-days=')) {
      args.nearDays = parseInteger(arg.slice('--near-days='.length), '--near-days');
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.sinceDate && !ISO_DATE_RE.test(args.sinceDate)) {
    throw new Error('--since-date must be YYYY-MM-DD');
  }
  if (args.nearDays < 0) {
    throw new Error('--near-days must be 0 or greater');
  }

  return args;
}

function parseInteger(value: string | undefined, name: string): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: npm run link:matches -- [options]

Find clear one-to-one matches between unlinked TODO claims and unlinked receipts.
Dry-run is the default. Add --apply to write receipt link metadata.

Options:
  --apply              Link clear matches via PATCH /receipt/:key/link
  --backend NAME       Claims backend: ynab (default) or howmuch
  --since-date DATE    Fetch TODOs since DATE (YYYY-MM-DD)
  --near-days N        Allow dates within N days; default 0 for exact date only
  --allow-upload-date  Use upload date when no manual/AI receipt date exists
`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

function parseDateOnly(value?: string): Date | null {
  if (!value) return null;
  const normalised = ISO_DATE_RE.test(value) ? `${value}T00:00:00Z` : value;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(dateA: Date, dateB: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs(dateA.getTime() - dateB.getTime()) / msPerDay);
}

function getReceiptMatchDate(receipt: ReceiptSummary, allowUploadDate: boolean): { date: Date; source: string } | null {
  const explicitDate = parseDateOnly(receipt.receiptDate);
  if (explicitDate) {
    return { date: explicitDate, source: receipt.receiptDateSource || 'manual' };
  }

  const detectedDate = parseDateOnly(receipt.detectedReceiptDate);
  if (detectedDate) {
    return { date: detectedDate, source: 'ai' };
  }

  if (allowUploadDate) {
    const uploadedDate = parseDateOnly(receipt.uploaded);
    if (uploadedDate) {
      return { date: uploadedDate, source: 'upload' };
    }
  }

  return null;
}

function comparableAmounts(receipt: ReceiptSummary): Array<{ value: number; kind: string }> {
  return [
    { value: Number(receipt.taggedAmount), kind: receipt.taggedCurrency === 'USD' ? 'usd-base' : 'base' },
    { value: Number(receipt.taggedAmountSgdApprox), kind: 'sgd-fx' },
    { value: Number(receipt.taggedAmountSgdApproxPlus325), kind: 'sgd-fx-plus-3.25' },
  ].filter((candidate) => Number.isFinite(candidate.value));
}

function findCandidates(report: AgentReport, args: Args): Candidate[] {
  const candidates: Candidate[] = [];

  for (const claim of report.missingReceiptClaims) {
    const claimDate = parseDateOnly(claim.date);
    const claimAmount = Number(claim.amount);
    if (!claimDate || !Number.isFinite(claimAmount)) continue;

    for (const receipt of report.unlinkedReceipts) {
      const receiptDate = getReceiptMatchDate(receipt, args.allowUploadDate);
      if (!receiptDate) continue;

      const dayDiff = daysBetween(claimDate, receiptDate.date);
      if (dayDiff > args.nearDays) continue;

      const amount = comparableAmounts(receipt).find((candidate) => (
        Math.abs(claimAmount - candidate.value) <= AMOUNT_TOLERANCE
      ));
      if (!amount) continue;

      candidates.push({
        claim,
        receipt,
        receiptDate: formatIsoDate(receiptDate.date),
        dateSource: receiptDate.source,
        amount: amount.value,
        amountKind: amount.kind,
        dayDiff,
      });
    }
  }

  return candidates;
}

function uniqueCandidates(candidates: Candidate[]): { clear: Candidate[]; ambiguous: Candidate[] } {
  const byClaim = new Map<string, Candidate[]>();
  const byReceipt = new Map<string, Candidate[]>();

  for (const candidate of candidates) {
    byClaim.set(candidate.claim.id, [...(byClaim.get(candidate.claim.id) || []), candidate]);
    byReceipt.set(candidate.receipt.key, [...(byReceipt.get(candidate.receipt.key) || []), candidate]);
  }

  const clear = candidates.filter((candidate) => (
    (byClaim.get(candidate.claim.id) || []).length === 1 &&
    (byReceipt.get(candidate.receipt.key) || []).length === 1
  ));
  const ambiguous = candidates.filter((candidate) => !clear.includes(candidate));

  return { clear, ambiguous };
}

function displayName(receipt: ReceiptSummary): string {
  return receipt.originalName || receipt.key;
}

function describe(candidate: Candidate): string {
  const { claim, receipt } = candidate;
  return [
    `${claim.date} $${claim.amount.toFixed(2)} ${claim.description || claim.payee}`,
    `<- ${displayName(receipt)}`,
    `receipt date ${candidate.receiptDate} (${candidate.dateSource})`,
    `amount ${candidate.amount.toFixed(2)} (${candidate.amountKind})`,
  ].join(' ');
}

async function fetchJson<T>(url: string, password: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'X-Auth-Token': password,
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${init?.method || 'GET'} ${url} failed: ${response.status} ${text}`);
  }

  return await response.json() as T;
}

async function linkCandidate(
  baseUrl: string,
  password: string,
  backend: 'howmuch' | 'ynab',
  candidate: Candidate
): Promise<void> {
  await fetchJson<{ success: boolean }>(
    `${baseUrl}/receipt/${encodeURIComponent(candidate.receipt.key)}/link`,
    password,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backend,
        linkedClaims: [{
          id: candidate.claim.id,
          description: candidate.claim.description,
          amount: candidate.claim.amount,
          date: candidate.claim.date,
        }],
      }),
    }
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = requiredEnv('R2_WORKER_URL').replace(/\/+$/, '');
  const password = requiredEnv('R2_PASSWORD');
  const reportUrl = new URL(`${baseUrl}/agent/unclaimed-expenditures`);
  reportUrl.searchParams.set('backend', args.backend);
  if (args.sinceDate) {
    reportUrl.searchParams.set('since_date', args.sinceDate);
  }

  const report = await fetchJson<AgentReport>(reportUrl.toString(), password);
  const candidates = findCandidates(report, args);
  const { clear, ambiguous } = uniqueCandidates(candidates);

  console.log(`Claims missing receipts: ${report.summary.missingReceiptClaimCount}`);
  console.log(`Unlinked receipts: ${report.summary.unlinkedReceiptCount}`);
  console.log(`Clear matches: ${clear.length}`);
  console.log(`Ambiguous matches skipped: ${ambiguous.length}`);

  console.log('\nClear matches to verify:');
  if (clear.length === 0) {
    console.log('(none)');
  } else {
    clear.forEach((candidate, index) => {
      console.log(`${index + 1}. ${describe(candidate)}`);
    });
  }

  console.log('\nAmbiguous matches to decide:');
  if (ambiguous.length === 0) {
    console.log('(none)');
  } else {
    ambiguous.slice(0, 20).forEach((candidate, index) => {
      console.log(`${index + 1}. ${describe(candidate)}`);
    });
    if (ambiguous.length > 20) {
      console.log(`... ${ambiguous.length - 20} more`);
    }
  }

  if (!args.apply) {
    console.log('\nDry run only. Re-run with --apply to link the clear matches.');
    return;
  }

  for (const candidate of clear) {
    await linkCandidate(baseUrl, password, args.backend, candidate);
    console.log(`Linked: ${describe(candidate)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
