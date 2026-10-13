import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-route-replay-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));
const { drainSessionStore, saveSessionAsync, loadSession } = await import('../store.mjs');
const { updateSessionRoute } = await import('./session-lifecycle.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

const replayAssistant = () => ({
  role: 'assistant',
  content: 'answer',
  providerReplay: { items: [{ type: 'reasoning' }] },
  reasoning: 'r',
  thinkingBlocks: [{ type: 'thinking' }],
  assistantBlocks: [{ type: 'text', text: 'answer' }],
  reasoningItems: [{ id: 'rs_1' }],
  reasoningContent: 'thoughts',
  providerMetadata: { gemini: { thoughtParts: [{ thought: true }] } },
});

// The route save is fire-and-forget; wait until it has landed on disk.
async function persisted(id) {
  const file = join(root, 'sessions', `${id}.json`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      if (stored.model === 'gpt-x') return stored;
    } catch {
      // Not written yet (or mid-write): poll again.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('route update was never persisted');
}

async function plant(id, extra = {}) {
  await saveSessionAsync(
    {
      id,
      provider: 'anthropic-oauth',
      model: 'claude-x',
      cwd: root,
      messages: [{ role: 'user', content: 'hi' }, replayAssistant()],
      generation: 0,
      closed: false,
      ...extra,
    },
    { expectedGeneration: 0 }
  );
}

test('a cross-provider route change strips every provider replay field', async () => {
  const id = `sess_replay_cross_${process.pid}`;
  await plant(id);
  updateSessionRoute(id, { provider: 'openai-oauth', model: 'gpt-x' }, { crossProvider: true });
  const assistant = loadSession(id).messages[1];
  assert.deepEqual(assistant, { role: 'assistant', content: 'answer' });
  assert.deepEqual((await persisted(id)).messages[1], { role: 'assistant', content: 'answer' });
});

test('an ordinary route change keeps provider replay fields', async () => {
  const id = `sess_replay_plain_${process.pid}`;
  await plant(id);
  updateSessionRoute(id, { provider: 'openai-oauth', model: 'gpt-x' });
  assert.ok(loadSession(id).messages[1].assistantBlocks);
  assert.ok((await persisted(id)).messages[1].assistantBlocks);
});

test('explicit same-provider model continuation keeps history and resets replay and usage baselines', async () => {
  const id = `sess_replay_model_${process.pid}`;
  await plant(id, {
    providerState: { continuation: 'old-model' },
    lastInputTokens: 900,
    lastOutputTokens: 120,
    lastCachedReadTokens: 800,
    lastCacheWriteTokens: 100,
    lastContextTokens: 900,
  });
  const updated = updateSessionRoute(id, { provider: 'anthropic-oauth', model: 'gpt-x' }, { crossProvider: true });
  assert.equal(updated.id, id);
  assert.equal(updated.provider, 'anthropic-oauth');
  assert.equal(updated.model, 'gpt-x');
  assert.deepEqual(updated.messages[0], { role: 'user', content: 'hi' });
  assert.deepEqual(updated.messages[1], { role: 'assistant', content: 'answer' });
  assert.equal(updated.providerState, undefined);
  for (const field of [
    'lastInputTokens', 'lastOutputTokens', 'lastCachedReadTokens', 'lastCacheWriteTokens', 'lastContextTokens',
  ]) assert.equal(updated[field], 0, field);
  const saved = await persisted(id);
  assert.equal(saved.provider, updated.provider);
  assert.deepEqual(saved.messages[1], { role: 'assistant', content: 'answer' });
});


test('live route diagnostics retain their historical receipt through replay cleanup and disk persistence', async () => {
  const { captureRouteDiagnostics } = await import('../../../../shared/route-diagnostics.mjs');
  const { inspectRouteDiagnostics } = await import('../../runtime-core/route-diagnostics.mjs');
  const id = `sess_replay_diagnostics_${process.pid}`;
  const receipt = captureRouteDiagnostics({ id, provider: 'anthropic-oauth', model: 'claude-x',
    effort: 'high', autoEffort: false, contextWindow: 128_000 }, { turnEffort: 'high', at: 1700000000000 });
  const user = { role: 'user', content: 'keep this request', meta: { routeDiagnostics: receipt } };
  await plant(id, { messages: [user, replayAssistant()] });
  const updated = updateSessionRoute(id, { provider: 'openai-oauth', model: 'gpt-x', effort: 'low',
    autoEffort: false, contextTokens: 333_333, selectedContextWindow: 333_333 }, { crossProvider: true });
  for (const session of [updated, await persisted(id)]) {
    assert.deepEqual(session.messages[0], user);
    assert.deepEqual(session.messages[1], { role: 'assistant', content: 'answer' });
    const diagnostics = inspectRouteDiagnostics(session);
    assert.equal(diagnostics.current.model, 'gpt-x');
    assert.equal(diagnostics.current.contextWindow, 333_333);
    assert.equal(diagnostics.lastTurn.configured.model, 'claude-x');
    assert.equal(diagnostics.lastTurn.configured.contextWindow, 128_000);
    assert.equal(diagnostics.lastTurn.preparedEffort, 'high');
  }
});
