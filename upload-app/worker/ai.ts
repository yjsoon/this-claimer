// AI provider keys and settings, plus the Claude (Anthropic API) calls.
//
// Keys can be pasted into the app's Settings > AI section (stored in KV, never
// returned to the browser) or set as Worker secrets. A key saved in the app
// wins over the secret, so keys can be rotated without a redeploy; removing it
// falls back to the secret again.
import Anthropic from '@anthropic-ai/sdk';

export const AI_PROVIDERS = ['anthropic', 'minimax', 'gemini'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

export interface AiEnv {
  APP_SETTINGS?: KVNamespace;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  VISION_PROVIDER?: string;
  CLAUDE_MODEL?: string;
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  minimax: 'MiniMax',
  gemini: 'Gemini',
};

const ENV_KEY_NAMES: Record<AiProvider, 'ANTHROPIC_API_KEY' | 'MINIMAX_API_KEY' | 'GEMINI_API_KEY'> = {
  anthropic: 'ANTHROPIC_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const SETTINGS_KEY = 'ai_settings';

interface StoredSettings {
  keys?: Partial<Record<AiProvider, string>>;
  visionProvider?: AiProvider;
  claudeModel?: string;
}

function isProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

async function loadSettings(env: AiEnv): Promise<StoredSettings> {
  if (!env.APP_SETTINGS) return {};
  const raw = await env.APP_SETTINGS.get(SETTINGS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as StoredSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// --- Resolving the effective env ----------------------------------------------

const resolvedEnvs = new WeakSet<object>();

// Returns env with the app-saved keys and choices laid over the Worker
// secrets/vars. Bindings are reached through the prototype, so the result is
// a drop-in replacement for env. Calling it again on its own result is free.
export async function withAiSettings<E extends AiEnv>(env: E): Promise<E> {
  if (resolvedEnvs.has(env)) return env;
  const settings = await loadSettings(env);
  const keys = settings.keys || {};
  const overlay = Object.create(env) as E;
  overlay.ANTHROPIC_API_KEY = keys.anthropic || env.ANTHROPIC_API_KEY;
  overlay.MINIMAX_API_KEY = keys.minimax || env.MINIMAX_API_KEY;
  overlay.GEMINI_API_KEY = keys.gemini || env.GEMINI_API_KEY;
  overlay.VISION_PROVIDER = settings.visionProvider || env.VISION_PROVIDER;
  overlay.CLAUDE_MODEL = settings.claudeModel || env.CLAUDE_MODEL;
  resolvedEnvs.add(overlay);
  return overlay;
}

// --- Settings API -------------------------------------------------------------

export interface AiSettingsStatus {
  providers: Array<{
    id: AiProvider;
    label: string;
    configured: boolean;
    source: 'app' | 'secret' | null;
    hint: string | null;
    secretAvailable: boolean;
  }>;
  visionProvider: AiProvider;
  claudeModel: string;
  claudeModels: typeof CLAUDE_MODELS;
}

function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}

// Mirrors the auto choice in worker/index.ts: the VISION_PROVIDER var, else
// MiniMax when it has a key (covered by the coding plan), else Claude, else Gemini.
export function preferredVisionProvider(env: AiEnv): AiProvider {
  const configured = (env.VISION_PROVIDER || '').toLowerCase();
  if (isProvider(configured)) return configured;
  if (env.MINIMAX_API_KEY) return 'minimax';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'gemini';
}

export function claudeModel(env: AiEnv): string {
  const model = env.CLAUDE_MODEL || '';
  return CLAUDE_MODELS.some((m) => m.id === model) ? model : DEFAULT_CLAUDE_MODEL;
}

export async function getSettingsStatus(env: AiEnv): Promise<AiSettingsStatus> {
  const settings = await loadSettings(env);
  const keys = settings.keys || {};
  const resolved = await withAiSettings(env);
  return {
    providers: AI_PROVIDERS.map((id) => {
      const appKey = keys[id];
      const secretKey = env[ENV_KEY_NAMES[id]];
      const active = appKey || secretKey;
      return {
        id,
        label: PROVIDER_LABELS[id],
        configured: Boolean(active),
        source: appKey ? 'app' : secretKey ? 'secret' : null,
        hint: active ? keyHint(active) : null,
        secretAvailable: Boolean(secretKey),
      };
    }),
    visionProvider: preferredVisionProvider(resolved),
    claudeModel: claudeModel(resolved),
    claudeModels: CLAUDE_MODELS,
  };
}

export class AiSettingsInputError extends Error {}

export interface AiSettingsUpdate {
  // A string saves that provider's key; null removes the app-saved key.
  keys?: Partial<Record<string, string | null>>;
  visionProvider?: unknown;
  claudeModel?: unknown;
}

export async function saveSettings(env: AiEnv, update: AiSettingsUpdate): Promise<void> {
  if (!env.APP_SETTINGS) throw new Error('APP_SETTINGS KV binding is missing.');
  const settings = await loadSettings(env);
  const keys = { ...(settings.keys || {}) };

  for (const [provider, value] of Object.entries(update.keys || {})) {
    if (!isProvider(provider)) throw new AiSettingsInputError(`Unknown AI provider: ${provider}`);
    if (value === null) {
      delete keys[provider];
      continue;
    }
    const key = typeof value === 'string' ? value.trim() : '';
    await checkKey(provider, key);
    keys[provider] = key;
  }

  if (update.visionProvider !== undefined) {
    if (!isProvider(update.visionProvider)) throw new AiSettingsInputError('Unknown receipt reading provider.');
    settings.visionProvider = update.visionProvider;
  }
  if (update.claudeModel !== undefined) {
    if (!CLAUDE_MODELS.some((m) => m.id === update.claudeModel)) throw new AiSettingsInputError('Unknown Claude model.');
    settings.claudeModel = update.claudeModel as string;
  }

  settings.keys = keys;
  await env.APP_SETTINGS.put(SETTINGS_KEY, JSON.stringify(settings));
}

// Shape check, then a cheap authenticated call where the provider has one, so
// a mistyped key fails here rather than on the next receipt.
async function checkKey(provider: AiProvider, key: string): Promise<void> {
  if (key.length < 20 || /\s/.test(key)) {
    throw new AiSettingsInputError(`That does not look like a ${PROVIDER_LABELS[provider]} API key.`);
  }

  if (provider === 'anthropic') {
    if (!key.startsWith('sk-ant-')) {
      throw new AiSettingsInputError('That does not look like an Anthropic API key (it starts with sk-ant-).');
    }
    try {
      await new Anthropic({ apiKey: key, maxRetries: 0 }).models.list({ limit: 1 });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new AiSettingsInputError('Anthropic rejected that key. Check it and try again.');
      }
      // Anything else (rate limit, outage) says nothing about the key; save it.
    }
    return;
  }

  if (provider === 'gemini') {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`
    ).catch(() => null);
    if (response && [400, 401, 403].includes(response.status)) {
      throw new AiSettingsInputError('Google rejected that Gemini key. Check it and try again.');
    }
  }
  // MiniMax has no cheap key check; the next receipt will tell.
}

// --- Claude calls -------------------------------------------------------------

function claudeClient(env: AiEnv): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
}

// Image types Claude accepts; PDFs go in as document blocks. HEIC is not
// supported and goes to Gemini.
export const CLAUDE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function claudeSupports(mimeType: string): boolean {
  return CLAUDE_IMAGE_MIMES.includes(mimeType) || mimeType === 'application/pdf';
}

async function claudeJson(
  env: AiEnv,
  content: Anthropic.Beta.BetaContentBlockParam[],
  schema: Record<string, unknown>,
  options: { effort: 'low' | 'medium' | 'high'; maxTokens: number }
): Promise<{ text: string; model: string }> {
  const client = claudeClient(env);
  const model = claudeModel(env);
  const response = await client.beta.messages.create({
    model,
    max_tokens: options.maxTokens,
    // On a policy decline, re-run on the model's default fallback; models
    // without fallbacks just run alone.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: options.effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request (${response.stop_details?.category || 'no category'})`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Claude response was cut off');
  }
  const text = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
  if (!text) throw new Error('Claude response did not contain text output');
  return { text, model: response.model || model };
}

export async function callClaudeWithFile(
  env: AiEnv,
  prompt: string,
  schema: Record<string, unknown>,
  fileBuffer: ArrayBuffer,
  mimeType: string,
  toBase64: (buffer: ArrayBuffer) => string
): Promise<{ text: string; model: string }> {
  const data = toBase64(fileBuffer);
  const fileBlock: Anthropic.Beta.BetaContentBlockParam =
    mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data,
          },
        };
  return claudeJson(env, [fileBlock, { type: 'text', text: prompt }], schema, { effort: 'low', maxTokens: 4096 });
}

const nullable = (type: string) => ({ anyOf: [{ type }, { type: 'null' }] });

export const AMOUNT_SCHEMA = {
  type: 'object',
  properties: {
    amount: nullable('number'),
    currency: { type: 'string' },
    confidence: { type: 'number' },
    receiptDate: nullable('string'),
    receiptDateConfidence: { type: 'number' },
    vendor: nullable('string'),
    purpose: nullable('string'),
  },
  required: ['amount', 'currency', 'confidence', 'receiptDate', 'receiptDateConfidence', 'vendor', 'purpose'],
  additionalProperties: false,
};

export const GST_SCHEMA = {
  type: 'object',
  properties: {
    gstShown: { type: 'boolean' },
    gstAmount: nullable('number'),
    confidence: { type: 'number' },
  },
  required: ['gstShown', 'gstAmount', 'confidence'],
  additionalProperties: false,
};

// --- Smart matching -----------------------------------------------------------

export interface MatchClaim {
  id: string;
  date: string;
  amount: number;
  payee?: string;
  description?: string;
}

export interface MatchReceipt {
  key: string;
  filename?: string;
  uploaded?: string;
  receiptDate?: string;
  amount?: number;
  currency?: string;
  amountSgdApprox?: number;
  vendor?: string;
  purpose?: string;
}

export interface MatchSuggestion {
  claimId: string;
  receiptKey: string;
  confidence: number;
  reason: string;
}

export const MAX_MATCH_CLAIMS = 150;
export const MAX_MATCH_RECEIPTS = 250;

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          receipt: { type: 'string' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['claim', 'receipt', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};

const MATCH_PROMPT = `You pair expense claims with the receipts that support them.

Each claim is a card or bank transaction waiting to be claimed. Each receipt is an uploaded file; its amount, date, vendor and purpose were read from the file by OCR and can be missing or wrong, and the filename often helps.

Pair a claim with a receipt only when the evidence points to the same purchase:
- Amounts should agree. Claims are in SGD. A foreign-currency receipt (usually USD) can match its SGD approximation, and card charges often add about 3.25% to that; a cent or two of rounding is fine.
- Dates are usually the same day or a few days apart (card posting lag, subscriptions billed a day late). Treat a gap of more than a week as weak evidence.
- The payee and description should plausibly be the same merchant as the receipt's vendor, purpose or filename (statement names are often abbreviated or show a payment processor).
- Each claim gets at most one receipt and each receipt at most one claim.
- Leave a claim out rather than guess. It is fine to return no matches.

Use the ids exactly as given. confidence is 0 to 1. reason is one short plain sentence a person can check, for example "Same $42.80 on 3 Oct; Grab ride receipt".`;

function compactLine(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const text = String(v).slice(0, 120);
      return `${k}=${/^[\w.-]+$/.test(text) ? text : JSON.stringify(text)}`;
    })
    .join(' ');
}

export async function suggestMatches(
  env: AiEnv,
  claims: MatchClaim[],
  receipts: MatchReceipt[]
): Promise<{ matches: MatchSuggestion[]; model: string }> {
  // Short ids save tokens and stop the model from mangling long R2 keys.
  const claimIds = new Map<string, string>();
  const receiptKeys = new Map<string, string>();
  const claimLines = claims.map((claim, i) => {
    const id = `c${i + 1}`;
    claimIds.set(id, claim.id);
    return `${id}: ${compactLine({ date: claim.date, amount: claim.amount.toFixed(2), payee: claim.payee, description: claim.description })}`;
  });
  const receiptLines = receipts.map((receipt, i) => {
    const id = `r${i + 1}`;
    receiptKeys.set(id, receipt.key);
    return `${id}: ${compactLine({
      file: receipt.filename,
      date: receipt.receiptDate,
      uploaded: receipt.uploaded,
      amount: receipt.amount?.toFixed(2),
      currency: receipt.currency,
      sgd_approx: receipt.amountSgdApprox?.toFixed(2),
      vendor: receipt.vendor,
      purpose: receipt.purpose,
    })}`;
  });

  const prompt = `${MATCH_PROMPT}\n\n<claims>\n${claimLines.join('\n')}\n</claims>\n\n<receipts>\n${receiptLines.join('\n')}\n</receipts>`;
  const { text, model } = await claudeJson(env, [{ type: 'text', text: prompt }], MATCH_SCHEMA, {
    effort: 'medium',
    maxTokens: 16000,
  });

  let parsed: { matches?: Array<{ claim?: string; receipt?: string; confidence?: number; reason?: string }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Claude match response was not valid JSON');
  }

  // Keep the pairing one-to-one even if the model slips.
  const usedClaims = new Set<string>();
  const usedReceipts = new Set<string>();
  const matches: MatchSuggestion[] = [];
  for (const item of parsed.matches || []) {
    const claimId = claimIds.get(item.claim || '');
    const receiptKey = receiptKeys.get(item.receipt || '');
    if (!claimId || !receiptKey || usedClaims.has(claimId) || usedReceipts.has(receiptKey)) continue;
    usedClaims.add(claimId);
    usedReceipts.add(receiptKey);
    const confidence = Number(item.confidence);
    matches.push({
      claimId,
      receiptKey,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
      reason: String(item.reason || '').slice(0, 200),
    });
  }
  return { matches, model };
}
