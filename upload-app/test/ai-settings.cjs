// Contract test for worker/ai.ts: bundles the module with esbuild and checks
// key storage/precedence, key validation and Claude match suggestions against
// a fake Anthropic API and an in-memory KV.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { buildSync } = require('esbuild');

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-test-')), 'ai.cjs');
buildSync({
  entryPoints: [path.join(__dirname, '..', 'worker', 'ai.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent',
});
const ai = require(outfile);

function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

const GOOD_KEY = 'sk-ant-api03-good-key-0000000000000000';
const BAD_KEY = 'sk-ant-api03-bad-key-11111111111111111';
const requests = [];
let messageReply = null;

global.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
  const body = init.body ? JSON.parse(init.body) : null;
  requests.push({ url, headers, body });
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  if (url.includes('api.anthropic.com/v1/models')) {
    return headers.get('x-api-key') === GOOD_KEY
      ? json(200, { data: [{ id: 'claude-opus-5-5', type: 'model' }], has_more: false, first_id: null, last_id: null })
      : json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  }
  if (url.includes('api.anthropic.com/v1/messages')) {
    return json(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: body.model,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(messageReply) }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  }
  if (url.includes('generativelanguage.googleapis.com')) {
    return json(url.includes('key=good-gemini') ? 200 : 400, {});
  }
  throw new Error(`unexpected fetch ${url}`);
};

async function main() {
  const kv = memoryKv();
  const env = { APP_SETTINGS: kv, GEMINI_API_KEY: 'secret-gemini-key-000000000000', VISION_PROVIDER: 'minimax' };

  // Nothing saved: secrets and vars show through.
  let status = await ai.getSettingsStatus(env);
  const byId = (s) => Object.fromEntries(s.providers.map((p) => [p.id, p]));
  assert.equal(byId(status).gemini.source, 'secret');
  assert.equal(byId(status).gemini.hint, '…0000');
  assert.equal(byId(status).anthropic.configured, false);
  assert.equal(status.visionProvider, 'minimax');
  assert.equal(status.claudeModel, 'claude-opus-5-5');
  assert.ok(!JSON.stringify(status).includes('secret-gemini-key'), 'status must never carry a key');

  // Bad keys are refused and not stored.
  await assert.rejects(ai.saveSettings(env, { keys: { anthropic: 'not-a-key' } }), ai.AiSettingsInputError);
  await assert.rejects(ai.saveSettings(env, { keys: { anthropic: BAD_KEY } }), /rejected/);
  await assert.rejects(ai.saveSettings(env, { keys: { gemini: 'bad-gemini-key-0000000000' } }), /rejected/);
  await assert.rejects(ai.saveSettings(env, { keys: { openai: GOOD_KEY } }), /Unknown AI provider/);
  await assert.rejects(ai.saveSettings(env, { visionProvider: 'openai' }), ai.AiSettingsInputError);
  await assert.rejects(ai.saveSettings(env, { claudeModel: 'gpt-5' }), ai.AiSettingsInputError);
  assert.equal(kv.store.size, 0);

  // A good key is stored and wins over the secret; choices override vars.
  await ai.saveSettings(env, { keys: { anthropic: GOOD_KEY, gemini: 'good-gemini-key-000000000000' } });
  await ai.saveSettings(env, { visionProvider: 'anthropic', claudeModel: 'claude-sonnet-5-5' });
  status = await ai.getSettingsStatus(env);
  assert.equal(byId(status).anthropic.source, 'app');
  assert.equal(byId(status).gemini.source, 'app');
  assert.equal(byId(status).gemini.secretAvailable, true);
  assert.equal(status.visionProvider, 'anthropic');
  assert.equal(status.claudeModel, 'claude-sonnet-5-5');

  const resolved = await ai.withAiSettings(env);
  assert.equal(resolved.ANTHROPIC_API_KEY, GOOD_KEY);
  assert.equal(resolved.GEMINI_API_KEY, 'good-gemini-key-000000000000');
  assert.equal(resolved.VISION_PROVIDER, 'anthropic');
  assert.equal(resolved.APP_SETTINGS, kv, 'bindings stay reachable');
  assert.equal(await ai.withAiSettings(resolved), resolved, 'resolving twice is free');

  // Removing the app key falls back to the secret.
  await ai.saveSettings(env, { keys: { gemini: null } });
  assert.equal((await ai.withAiSettings(env)).GEMINI_API_KEY, 'secret-gemini-key-000000000000');

  // Claude match suggestions: short ids map back, pairs stay one-to-one, and
  // unknown ids are dropped.
  messageReply = {
    matches: [
      { claim: 'c1', receipt: 'r2', confidence: 0.9, reason: 'Same $42.80 on 3 Oct; Grab receipt' },
      { claim: 'c2', receipt: 'r2', confidence: 0.6, reason: 'Duplicate receipt' },
      { claim: 'c9', receipt: 'r1', confidence: 0.6, reason: 'Unknown claim' },
      { claim: 'c2', receipt: 'r1', confidence: 1.4, reason: 'USD 25 at about 3.25% card fee' },
    ],
  };
  const result = await ai.suggestMatches(
    resolved,
    [
      { id: 'howmuch-1', date: '2026-10-03', amount: 42.8, payee: 'GRAB*RIDES' },
      { id: 'howmuch-2', date: '2026-10-05', amount: 34.6, payee: 'OPENAI' },
    ],
    [
      { key: '2026-10-05_120000_abcd1234_invoice.pdf', amount: 25, currency: 'USD', amountSgdApprox: 33.5 },
      { key: '2026-10-03_090000_ef567890_grab.pdf', amount: 42.8, vendor: 'Grab' },
    ]
  );
  assert.deepEqual(result.matches, [
    { claimId: 'howmuch-1', receiptKey: '2026-10-03_090000_ef567890_grab.pdf', confidence: 0.9, reason: 'Same $42.80 on 3 Oct; Grab receipt' },
    { claimId: 'howmuch-2', receiptKey: '2026-10-05_120000_abcd1234_invoice.pdf', confidence: 1, reason: 'USD 25 at about 3.25% card fee' },
  ]);
  assert.equal(result.model, 'claude-sonnet-5-5');

  const call = requests.filter((r) => r.url.includes('/v1/messages')).pop();
  assert.equal(call.headers.get('x-api-key'), GOOD_KEY);
  assert.match(call.headers.get('anthropic-beta') || '', /server-side-fallback-2026-07-01/);
  assert.equal(call.body.fallbacks, 'default');
  assert.equal(call.body.output_config.format.type, 'json_schema');
  const prompt = call.body.messages[0].content[0].text;
  assert.ok(prompt.includes('c1: date=2026-10-03 amount=42.80 payee="GRAB*RIDES"'));
  assert.ok(prompt.includes('sgd_approx=33.50'));
  assert.ok(!prompt.includes('abcd1234'), 'long keys stay out of the prompt');

  // Receipt reading: PDFs go in as document blocks, images as image blocks.
  messageReply = { amount: 12.5, currency: 'SGD', confidence: 0.9, receiptDate: '2026-10-01', receiptDateConfidence: 0.9, vendor: 'Shop', purpose: 'Lunch' };
  const pdf = new TextEncoder().encode('%PDF-1.4').buffer;
  const toBase64 = (buffer) => Buffer.from(buffer).toString('base64');
  await ai.callClaudeWithFile(resolved, 'prompt', ai.AMOUNT_SCHEMA, pdf, 'application/pdf', toBase64);
  let content = requests.filter((r) => r.url.includes('/v1/messages')).pop().body.messages[0].content;
  assert.equal(content[0].type, 'document');
  await ai.callClaudeWithFile(resolved, 'prompt', ai.GST_SCHEMA, pdf, 'image/png', toBase64);
  content = requests.filter((r) => r.url.includes('/v1/messages')).pop().body.messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(ai.claudeSupports('image/heic'), false);

  console.log('AI settings contract passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
