// A turn keeps its outer prompt id for Undo/Reapply and every submission in
// a queued batch for recovery. Both identities must survive the runtime
// callback bridge and persistence without depending on prompt text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { persistedUserTranscriptMetadata } from '../../runtime/shared/transcript-metadata.mjs';
import { attachAssistantTranscriptCompletion } from '../../runtime/agent/orchestrator/session/manager/ask-turn-settle.mjs';
import { createAskCallbacks } from '../../session-runtime/turn/turn-run/ask-callbacks.mjs';
import { createAskTranscriptMeta } from '../../runtime/agent/orchestrator/session/manager/ask-session.mjs';
import { buildUserTurn } from '../../runtime/agent/orchestrator/session/manager/ask-turn-prepare.mjs';
import { _sessionForDisk } from '../../runtime/agent/orchestrator/session/store/serialize.mjs';
import { restoreTranscriptItems } from './session-api-ext.mjs';
import { applyTurnRouteMetadata, createRunTurn, turnDoneItem } from './turn.mjs';
import { turnOptionsForBatch } from './session-flow/drain.mjs';
import { mergePromptContents } from './queue-helpers.mjs';

test('admitted route updates shared stream metadata and submitted rows without replacing identity', () => {
  const transcriptMeta = { at: 10, messageId: 'message-1', provider: 'old', modelId: 'old', agent: 'Lead' };
  const routeMeta = { provider: 'old', modelId: 'old', agent: 'Lead' };
  const patches = [];
  applyTurnRouteMetadata(
    {
      turn: { transcriptMeta, routeMeta, submittedIds: ['prompt-1'] },
      patchItem: (id, patch) => patches.push({ id, patch }),
    },
    { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }
  );
  assert.equal(transcriptMeta.modelId, 'deepseek/deepseek-v4.1-flash');
  assert.equal(routeMeta.modelId, transcriptMeta.modelId);
  assert.equal(routeMeta.provider, 'openrouter');
  assert.equal(transcriptMeta.messageId, 'message-1');
  assert.equal(transcriptMeta.at, 10);
  assert.equal(transcriptMeta.agent, 'Lead');
  assert.equal(patches[0].id, 'prompt-1');
  assert.equal(patches[0].patch.modelId, transcriptMeta.modelId);
});

test('the runtime stamps the outer prompt id onto the caller transcript metadata in place', () => {
  const { askCallbacks } = createAskCallbacks({
    transcript: { appendAssistantText() {} },
    notifyFnForSession: () => null,
    scheduleSearchRuntimeWarmup: null,
    hooks: { emit() {} },
  });
  const meta = { at: 10, model: 'm' };
  const turn = { snapshot: { promise: null }, timing: {}, signal: null };
  const callbacks = askCallbacks(turn, { id: 's' }, { id: ' prompt-1 ', transcriptMeta: meta });
  assert.equal(callbacks.transcriptMeta, meta, 'the same object: the stream stamps assistantAt on it');
  assert.equal(meta.checkpointId, 'prompt-1');
  const unstamped = askCallbacks(turn, { id: 's' }, { transcriptMeta: { at: 1 } });
  assert.equal(Object.hasOwn(unstamped.transcriptMeta, 'checkpointId'), false);
});

async function runStoredBatch(batch) {
  const session = { id: 'submission-receipts', contextWindow: 128000, messages: [] };
  const state = { items: [], stats: { turns: 0, inputTokens: 0, outputTokens: 0 } };
  const { askCallbacks } = createAskCallbacks({
    transcript: { appendAssistantText() {} },
    notifyFnForSession: () => null,
    scheduleSearchRuntimeWarmup: null,
    hooks: { emit() {} },
  });
  let runtimeOptions;
  const runtime = {
    id: session.id,
    session,
    async ask(prompt, options) {
      runtimeOptions = options;
      const callbacks = askCallbacks({ snapshot: {}, timing: {}, signal: null }, session, options);
      const transcript = createAskTranscriptMeta(callbacks.transcriptMeta);
      const { userTurnMessage } = await buildUserTurn({ session, prompt, transcriptMeta: transcript.user });
      session.messages.push(userTurnMessage);
      return { result: { content: '' }, session };
    },
  };
  let seq = 0;
  const runTurn = createRunTurn({
    runtime,
    flags: { leadTurnEpoch: 0 },
    pending: [],
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `item-${++seq}`,
    itemIndexById: new Map(),
    pushItem: (item) => state.items.push(item),
    tuiDebug() {},
    syncContextStats() {},
    flushToolResults() {},
    denyAllToolApprovals() {},
    clearActiveToolSummary() {},
    flushDeferredExecutionPendingResumeKick() {},
    routeState: () => ({}),
    agentStatusState: () => ({}),
    pendingTaskWaitWake: () => false,
    drainPendingSteering: () => [],
  });
  const status = await runTurn(
    mergePromptContents(batch),
    turnOptionsForBatch(batch, { commitSteeringQueueEntries() {} })
  );
  assert.equal(status, 'done');
  const stored = JSON.parse(JSON.stringify(_sessionForDisk(session)));
  return { runtimeOptions, stored };
}

test('all queued submission ids reach the stored user turn through runtime ask', async () => {
  const { runtimeOptions, stored } = await runStoredBatch([
    { id: 'submit-a', text: 'continue', content: 'continue', submittedAt: 10 },
    { id: 'submit-b', text: 'continue', content: 'continue', submittedAt: 20 },
  ]);
  assert.deepEqual(runtimeOptions.submittedIds, ['submit-a', 'submit-b']);
  assert.equal(stored.messages.length, 1, 'the batch is still one user turn');
  assert.deepEqual(stored.messages[0].meta.transcript.submissionIds, ['submit-a', 'submit-b']);
  assert.equal(stored.messages[0].meta.transcript.checkpointId, 'submit-a', 'Undo/Reapply keeps the outer prompt id');
  assert.equal(Object.hasOwn(stored.messages[0].meta.transcript, 'attachments'), false);
});

for (const firstHasMetadata of [false, true]) {
  test(`batched attachment records survive stored transcript restore (first metadata=${firstHasMetadata})`, async () => {
    const attachment = (id, kind, name, mimeType) => ({ id, attachmentRef: id, kind, name, mimeType, size: 20 });
    const pdf = attachment('a'.repeat(64), 'file', 'spec.pdf', 'application/pdf');
    const pasted = attachment('b'.repeat(64), 'text', 'context.txt', 'text/plain');
    const firstMeta = firstHasMetadata ? { device: 'Desktop', attachments: [pdf] } : undefined;
    const batch = [
      { id: 'submit-a', text: 'continue', content: 'continue', submittedAt: 10, transcriptMeta: firstMeta },
      {
        id: 'submit-b',
        text: 'continue',
        content: 'continue',
        submittedAt: 20,
        transcriptMeta: { device: 'Phone', attachments: [pdf, pasted] },
      },
    ];
    const before = JSON.stringify(batch);
    const { stored } = await runStoredBatch(batch);
    const [row] = restoreTranscriptItems(stored.messages, { sessionId: stored.id });
    assert.equal(row.kind, 'user');
    assert.deepEqual(row.attachments, [pdf, pasted], 'every original remains linked by id after reload');
    assert.equal(
      row.device,
      firstHasMetadata ? 'Desktop' : undefined,
      'other metadata remains owned by the first entry'
    );
    assert.deepEqual(stored.messages[0].meta.transcript.submissionIds, ['submit-a', 'submit-b']);
    assert.equal(JSON.stringify(batch), before, 'merging does not mutate either accepted submission');
  });
}

test('stored submission receipts keep only distinct nonempty ids without inventing legacy identity', () => {
  const meta = { at: 1, submissionIds: [' submit-a ', '', null, 7, 'submit-b', 'submit-a'] };
  const stored = persistedUserTranscriptMetadata(meta);
  assert.deepEqual(stored.submissionIds, ['submit-a', 'submit-b']);
  meta.submissionIds.push('later');
  assert.deepEqual(stored.submissionIds, ['submit-a', 'submit-b'], 'stored metadata owns its receipt list');
  for (const submissionIds of [undefined, [], [null, '', ' '], 'submit-a']) {
    assert.equal(Object.hasOwn(persistedUserTranscriptMetadata({ at: 1, submissionIds }), 'submissionIds'), false);
  }
});

test('checkpointId survives user persistence, completion persistence and restore', () => {
  const raw = { at: 10, model: 'Model', provider: 'p', checkpointId: 'prompt-1', completionVerb: 'Baked' };
  const messages = [
    { role: 'user', content: 'Change it.', meta: { transcript: persistedUserTranscriptMetadata(raw) } },
    { role: 'assistant', content: 'Changed.', meta: { transcript: { at: 20, model: 'Model' } } },
  ];
  assert.equal(messages[0].meta.transcript.checkpointId, 'prompt-1');
  assert.equal(
    attachAssistantTranscriptCompletion(
      messages,
      { status: 'done', verb: raw.completionVerb, elapsedMs: 5, checkpointId: raw.checkpointId },
      raw.at
    ),
    true
  );
  assert.equal(messages[1].meta.transcript.completion.checkpointId, 'prompt-1');
  const items = restoreTranscriptItems(JSON.parse(JSON.stringify(messages)), { sessionId: 'identity' });
  const user = items.find((item) => item.kind === 'user');
  const done = items.find((item) => item.kind === 'turndone');
  assert.equal(user.checkpointId, 'prompt-1');
  assert.equal(done.checkpointId, 'prompt-1');
  assert.equal(
    Object.hasOwn(
      items.find((item) => item.kind === 'assistant'),
      'checkpointId'
    ),
    false
  );
});

test('legacy records without a checkpoint restore without inventing one', () => {
  const messages = [
    { role: 'user', content: 'Old.', meta: { transcript: persistedUserTranscriptMetadata({ at: 1 }) } },
    {
      role: 'assistant',
      content: 'Old answer.',
      meta: { transcript: { at: 2, completion: { status: 'done', verb: 'Baked', elapsedMs: 1 } } },
    },
  ];
  const items = restoreTranscriptItems(messages, { sessionId: 'legacy' });
  for (const item of items) assert.equal(Object.hasOwn(item, 'checkpointId'), false);
});

test('the live turndone row carries the outer prompt id', () => {
  let nextId = 0;
  const ctx = (submittedIds) => ({
    turn: {
      startedAt: Date.now(),
      submittedIds,
      cancelled: false,
      failed: false,
      finishedNormally: true,
      completionVerb: 'Baked',
      routeMeta: {},
    },
    stream: {
      currentAssistantId: null,
      thinkingStartedAt: 0,
      accumulatedThinkingMs: 0,
      assistantText: '',
      currentAssistantText: '',
      thinkingText: '',
    },
    cards: { toolCards: [] },
    getState: () => ({ spinner: null }),
    nextId: () => ++nextId,
  });
  assert.equal(turnDoneItem(ctx(['prompt-7'])).checkpointId, 'prompt-7');
  assert.equal(Object.hasOwn(turnDoneItem(ctx([])), 'checkpointId'), false);
});
