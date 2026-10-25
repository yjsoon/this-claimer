// Separate JSON objects, not receipt metadata: AI re-tagging and metadata
// rewrites cannot erase manual edits. R2 conditional puts provide atomic CAS.
export const INVOICE_EDITS_PREFIX = '__invoice_edits/';

export interface InvoiceEdits {
  revision: string | null;
  lines: Record<string, Record<string, unknown>>;
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
  return object ? object.json<InvoiceEdits>() : { revision: null, lines: {} };
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
  const current: InvoiceEdits = object ? await object.json() : { revision: null, lines: {} };
  if (body.revision !== current.revision) return json({ error: 'Invoice edits changed. Refresh before retrying.', ...current }, 409);
  const lineId = `${body.backend}::${body.claimId}`;
  const patch = body.patch as Record<string, unknown> | null;
  const edits = patch === null ? {} : { ...current.lines[lineId], ...patch };
  if (patch && Object.keys(patch).some(field => !field.startsWith('review')) && !Object.prototype.hasOwnProperty.call(patch, 'reviewed')) {
    Object.assign(edits, { reviewed: false, reviewedSnapshot: null, reviewedSourceSnapshot: null });
  }
  const next: InvoiceEdits = {
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
