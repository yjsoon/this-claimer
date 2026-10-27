// R2 provides strongly consistent conditional writes; KV get/delete cannot
// atomically consume a transaction across Worker isolates.
export const OAUTH_PREFIX = '__oauth/';
type Provider = 'gmail' | 'xero';

export async function beginOAuth(bucket: R2Bucket, provider: Provider, origin: string): Promise<string> {
  const state = crypto.randomUUID();
  // Only the newest authorized connect attempt for each provider is valid.
  // Two fixed records bound storage growth without a cleanup job.
  await bucket.put(OAUTH_PREFIX + provider, JSON.stringify({ state, origin, expiresAt: Date.now() + 600000 }));
  return state;
}

export async function consumeOAuth(
  bucket: R2Bucket, provider: Provider, origin: string, state: string, cookie: string,
): Promise<boolean> {
  if (state !== cookie) return false;
  const record = await bucket.get(OAUTH_PREFIX + provider);
  if (!record) return false;
  const transaction = await record.json<{ state?: string; origin?: string; expiresAt?: number }>();
  if (transaction.state !== state || transaction.origin !== origin
    || !transaction.expiresAt || transaction.expiresAt <= Date.now()) return false;
  // Consume before contacting the provider, including on exchange failure.
  return Boolean(await bucket.put(OAUTH_PREFIX + provider, '{}', { onlyIf: { etagMatches: record.etag } }));
}
