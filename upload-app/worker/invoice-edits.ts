// Separate JSON objects, not receipt metadata: AI re-tagging and metadata
// rewrites cannot erase manual edits. R2 conditional puts provide atomic CAS.
export const INVOICE_EDITS_PREFIX = '__invoice_edits/';

export interface InvoiceEdits {
  revision: string | null;
  lines: Record<string, Record<string, unknown>>;
  xero?: Record<string, { pushKey: string; reservedAt?: number; invoiceID?: string; invoiceNumber?: string; claimedAt?: string }>;
}

export class InvoiceXeroConflict extends Error {}

export interface InvoiceXeroBill { invoiceID: string; invoiceNumber: string; url: string }

export async function rememberInvoiceXeroBill(bucket: R2Bucket, pushKey: string, bill: InvoiceXeroBill): Promise<void> {
  await bucket.put(`${INVOICE_EDITS_PREFIX}__xero_push/${pushKey}`, JSON.stringify(bill), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function hydrateInvoiceXero(bucket: R2Bucket, current: InvoiceEdits): Promise<InvoiceEdits> {
  const bills = new Map<string, Promise<InvoiceXeroBill | null>>();
  for (const state of Object.values(current.xero || {})) {
    if (state.invoiceID) continue;
    if (!bills.has(state.pushKey)) bills.set(state.pushKey, bucket.get(`${INVOICE_EDITS_PREFIX}__xero_push/${state.pushKey}`)
      .then(object => object ? object.json<InvoiceXeroBill>() : null));
    const bill = await bills.get(state.pushKey);
    if (bill) Object.assign(state, { invoiceID: bill.invoiceID, invoiceNumber: bill.invoiceNumber });
  }
  return current;
}

// Identical in-flight requests must not share reservations: otherwise one
// failed acquisition could release ownership while its twin creates the bill.
export async function lockInvoiceXeroPush(bucket: R2Bucket, pushKey: string): Promise<() => Promise<void>> {
  const key = `${INVOICE_EDITS_PREFIX}__xero_lock/${pushKey}`;
  const locked = await bucket.put(key, 'active', { onlyIf: { etagDoesNotMatch: '*' } });
  if (!locked) throw new InvoiceXeroConflict('This exact Xero push is already running. Wait for its result before retrying.');
  return async () => { await bucket.delete(key); };
}

export async function releaseInvoiceXero(
  bucket: R2Bucket, key: string, lineIds: string[], pushKey: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const object = await bucket.get(INVOICE_EDITS_PREFIX + key);
    if (!object) return;
    const current = await object.json<InvoiceEdits>();
    const states = { ...current.xero };
    const releasable = lineIds.filter(id => states[id]?.pushKey === pushKey && !states[id]?.invoiceID);
    if (!releasable.length) return;
    releasable.forEach(id => { delete states[id]; });
    const written = await bucket.put(INVOICE_EDITS_PREFIX + key, JSON.stringify({
      ...current, revision: crypto.randomUUID(), xero: states,
    }), { onlyIf: { etagMatches: object.etag }, httpMetadata: { contentType: 'application/json' } });
    if (written) return;
  }
  throw new InvoiceXeroConflict('Could not release failed push reservations. Refresh and reconcile before retrying.');
}

export function assertInvoiceXero(
  current: InvoiceEdits, lineIds: string[], pushKey: string,
  result?: { invoiceID: string }, revision?: string | null,
): void {
  for (const id of lineIds) {
    const state = current.xero?.[id];
    if (state && (state.pushKey !== pushKey || (result && state.invoiceID && state.invoiceID !== result.invoiceID))) {
      throw new InvoiceXeroConflict('A selected line already belongs to another Xero push. Refresh before retrying.');
    }
    // Xero retains keys for six minutes. Never risk creating a duplicate after
    // an unknown outcome has outlived that window (leave a one-minute margin).
    if (!result && state && !state.invoiceID && Date.now() - (state.reservedAt || 0) > 5 * 60 * 1000) {
      throw new InvoiceXeroConflict('Xero push outcome is unknown and its safe retry window expired. Check Xero before reconciling this line; do not push it again.');
    }
  }
  if (!result && revision !== undefined && revision !== current.revision
    && !lineIds.every(id => current.xero?.[id]?.pushKey === pushKey)) {
    throw new InvoiceXeroConflict('Invoice edits changed. Refresh and review before pushing.');
  }
}

// Server-owned, per-line accounting state shares the receipt's atomic CAS boundary
// with edits. A reserved line may only retry the identical Xero idempotency key.
export async function updateInvoiceXero(
  bucket: R2Bucket, key: string, lineIds: string[], pushKey: string,
  result?: { invoiceID: string; invoiceNumber?: string; claimedAt?: string },
  revision?: string | null,
): Promise<string[]> {
  const storageKey = INVOICE_EDITS_PREFIX + key;
  for (let attempt = 0; attempt < 4; attempt++) {
    const object = await bucket.get(storageKey);
    const current = await hydrateInvoiceXero(bucket, object ? await object.json<InvoiceEdits>() : { revision: null, lines: {} });
    assertInvoiceXero(current, lineIds, pushKey, result, revision);
    const states = { ...current.xero };
    for (const id of lineIds) states[id] = { reservedAt: Date.now(), ...states[id], pushKey, ...result };
    const written = await bucket.put(storageKey, JSON.stringify({
      ...current, revision: crypto.randomUUID(), xero: states,
    }), {
      onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    });
    if (written) return lineIds.filter(id => !current.xero?.[id]);
  }
  throw new InvoiceXeroConflict('Invoice state changed concurrently. Refresh before retrying.');
}

export async function listInvoiceEditKeys(bucket: R2Bucket): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: INVOICE_EDITS_PREFIX, cursor });
    page.objects.forEach(object => keys.add(object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function readInvoiceEdits(bucket: R2Bucket, key: string): Promise<InvoiceEdits> {
  const object = await bucket.get(INVOICE_EDITS_PREFIX + key);
  return hydrateInvoiceXero(bucket, object ? await object.json<InvoiceEdits>() : { revision: null, lines: {} });
}

function validPatch(patch: unknown): patch is Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
  return Object.entries(patch).every(([field, value]) => {
    switch (field) {
      case 'section': return typeof value === 'string' && ['gst', 'nongst', 'transport'].includes(value);
      case 'taxType': return typeof value === 'string' && ['INPUTY24', 'NRINPUT', 'OPINPUT'].includes(value);
      case 'gstShown': case 'include': case 'reviewed': case 'reviewInvalidated': return typeof value === 'boolean';
      case 'amount': return typeof value === 'number' && Number.isFinite(value) && value >= 0;
      case 'date': return typeof value === 'string' && (value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value));
      case 'accountCode': return typeof value === 'string' && /^\d{1,10}$/.test(value);
      case 'description': case 'remark': return typeof value === 'string' && value.length <= 10000;
      case 'reviewedSnapshot': case 'reviewedSourceSnapshot':
        return value === null || (typeof value === 'object' && !Array.isArray(value)
          && Object.entries(value as Record<string, unknown>).every(([name, entry]) =>
            ['amount', 'date', 'description', 'accountCode', 'taxType', 'remark', 'section', 'sourceAccount'].includes(name)
            && typeof entry === 'string' && entry.length <= 10000));
      default: return false;
    }
  });
}

export async function invoiceEditsResponse(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (key.startsWith(INVOICE_EDITS_PREFIX) || !(await bucket.head(key))) {
    return json({ error: 'Receipt not found' }, 404);
  }
  if (request.method === 'GET') return json(await readInvoiceEdits(bucket, key));
  let body;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body || typeof body.backend !== 'string' || !['ynab', 'howmuch'].includes(body.backend)
    || typeof body.claimId !== 'string' || !body.claimId.trim() || body.claimId.length > 1000
    || !(body.revision === null || typeof body.revision === 'string')
    || !(body.patch === null || validPatch(body.patch))
    || JSON.stringify(body).length > 32000) {
    return json({ error: 'Expected backend, claimId, revision and a valid invoice patch (or null to reset)' }, 400);
  }
  const storageKey = INVOICE_EDITS_PREFIX + key;
  const object = await bucket.get(storageKey);
  const current = await hydrateInvoiceXero(bucket, object ? await object.json<InvoiceEdits>() : { revision: null, lines: {} });
  if (body.revision !== current.revision) return json({ error: 'Invoice edits changed. Refresh before retrying.', ...current }, 409);
  const lineId = `${body.backend}::${body.claimId}`;
  const patch = body.patch as Record<string, unknown> | null;
  const edits = patch === null ? {} : { ...current.lines[lineId], ...patch };
  if (patch && Object.keys(patch).some(field => !field.startsWith('review')) && !Object.prototype.hasOwnProperty.call(patch, 'reviewed')) {
    Object.assign(edits, { reviewed: false, reviewedSnapshot: null, reviewedSourceSnapshot: null });
  }
  const next: InvoiceEdits = {
    ...current,
    revision: crypto.randomUUID(),
    // An empty entry is a reset tombstone: old localStorage must not resurrect it.
    lines: { ...current.lines, [lineId]: edits },
  };
  const written = await bucket.put(storageKey, JSON.stringify(next), {
    onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  if (!written) return json({ error: 'Invoice edits changed. Refresh before retrying.', ...await readInvoiceEdits(bucket, key) }, 409);
  return json(next);
}
