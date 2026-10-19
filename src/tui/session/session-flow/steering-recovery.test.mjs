import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-steering-recovery-flow-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { createSessionFlow } = await import('../session-flow.mjs');
const { createSessionDraftStore } = await import('../draft-store.mjs');
const { createResumeAction } = await import('../session-api/lifecycle/resume.mjs');
const { createAbortAction } = await import('../session-api/intake/abort.mjs');
const { createRunTurn } = await import('../turn.mjs');
const { createAskCallbacks } = await import('../../../session-runtime/turn/turn-run/ask-callbacks.mjs');
const { persistedUserTranscriptMetadata } = await import('../../../runtime/shared/transcript-metadata.mjs');
const { createTurnInterruptionTracker } = await import(
  '../../../runtime/agent/orchestrator/session/manager/turn-interruption.mjs'
);
const { appendTuiSteeringPersist, flushTuiSteeringPersist } = await import('../tui-steering-persist.mjs');
const { materializePromptSubmission, attachmentsForIntake } = await import('../../../runtime/attachments/store.mjs');

test.after(async () => {
  await flushTuiSteeringPersist();
  rmSync(dataDir, { recursive: true, force: true });
});

const tick = () => new Promise(setImmediate);
const shardPath = (id) => join(dataDir, 'session-pending', `tui_${id}.json`);
function diskRows(id) {
  return existsSync(shardPath(id)) ? JSON.parse(readFileSync(shardPath(id), 'utf8')).sessions[`tui_${id}`] : [];
}

function flowFixture(t, id, { messages = [], busy = true } = {}) {
  const flags = {};
  const pending = [];
  const turns = [];
  const runtime = { id, session: { id, messages }, resume: async () => runtime.session };
  let sequence = 0;
  let flow;
  const store = createSessionDraftStore({
    draft: { state: { busy, commandBusy: false, queued: [], items: [], stats: {} } },
    listeners: new Set(),
    isDisposed: () => flags.disposed === true,
    onBusyReleased: () => void flow.drain(),
  });
  const bag = {
    ...store,
    runtime,
    flags,
    pending,
    pendingNotificationKeys: new Set(),
    nextId: () => `generated_${++sequence}`,
    tuiDebug() {},
    pushUserOrSyntheticItem() {},
    flushDeferredExecutionPendingResumeKick() {},
    runTurn: async (content, options) => {
      turns.push({ content, options });
      options.onCommitted?.();
      return 'done';
    },
  };
  flow = createSessionFlow(bag);
  bag.settleClosedQueue = flow.settleClosedQueue;
  t.after(async () => {
    flags.disposed = true;
    clearTimeout(flags.blockedDrainRetryTimer);
    store.disposeEmit();
    await flushTuiSteeringPersist();
  });
  return { ...store, bag, flow, flags, pending, turns, runtime };
}

function storedUserMessage(content, options) {
  const { askCallbacks } = createAskCallbacks({
    transcript: { appendAssistantText() {} },
    notifyFnForSession: () => null,
    hooks: { emit() {} },
  });
  const callbacks = askCallbacks(
    { snapshot: {}, timing: {} },
    {},
    { ...options, transcriptMeta: { ...options.transcriptMeta } }
  );
  return { role: 'user', content, meta: { transcript: persistedUserTranscriptMetadata(callbacks.transcriptMeta) } };
}

// `session send` supplies no ID. Exercise its actual intake and item ID
// generator in fresh processes, where the old process-local counter reset.
function submissionAfterRestart(text) {
  const source = `
    import { nextId } from ${JSON.stringify(new URL('../transcript-spill.mjs', import.meta.url).href)};
    import { createSubmissionIntake } from ${JSON.stringify(new URL('../session-api/intake/submission.mjs', import.meta.url).href)};
    const intake = createSubmissionIntake({
      nextId,
      flags: {},
      getState: () => ({ busy: true }),
      enqueue: (content, options) => {
        console.log(JSON.stringify({ content, options }));
        return true;
      },
    });
    await intake.submitAsync(${JSON.stringify(text)});
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
  );
}

test('ID-less submissions from fresh processes survive recovery beside older receipts', async (t) => {
  const id = 'restart_submission_ids';
  const previous = submissionAfterRestart('previous completed input');
  const current = submissionAfterRestart('different unprocessed input');
  const receipt = storedUserMessage(previous.content, {
    id: previous.options.id,
    submittedIds: [previous.options.id],
  });
  const writer = flowFixture(t, id);
  await writer.flow.enqueue(current.content, current.options);
  const recovered = flowFixture(t, id, { messages: [receipt] });
  await recovered.flow.restoreLeadSteeringFromDisk();
  assert.deepEqual(recovered.pending.map((entry) => entry.content), [current.content]);
  assert.notEqual(current.options.id, previous.options.id, 'server IDs must survive a process restart');
  assert.equal(recovered.pending[0].recoveryNeedsReview, false);
  assert.deepEqual(diskRows(id).map((row) => row.submissionId), [current.options.id]);
  await recovered.flow.enqueue(current.content, current.options);
  assert.equal(recovered.pending.length, 1, 'retrying that same ID remains idempotent');
});

test('legacy counter IDs recover as distinct reviewable rows despite colliding receipts', async (t) => {
  const id = 'legacy_counter_ids';
  const messages = [storedUserMessage('old completed input', { id: 'it_1', submittedIds: ['it_1'] })];
  for (const text of ['new first input', 'new second input']) {
    await appendTuiSteeringPersist(id, { id: 'it_1', text, content: text });
  }
  const expectedIds = diskRows(id).map((row) => row.id);
  const first = flowFixture(t, id, { messages, busy: false });
  await first.flow.restoreLeadSteeringFromDisk();
  assert.deepEqual(first.pending.map((entry) => entry.id), expectedIds);
  assert.ok(first.pending.every((entry) => entry.recoveryNeedsReview));
  await first.flow.drain();
  assert.deepEqual(first.turns, [], 'an ambiguous old ID must neither discard nor auto-replay the input');
  assert.equal(first.flow.pendingTaskWaitWake(), false);
  assert.deepEqual(first.flow.drainPendingSteering(), []);
  const second = flowFixture(t, id, { messages, busy: false });
  await second.flow.restoreLeadSteeringFromDisk();
  await second.flow.restoreLeadSteeringFromDisk();
  assert.deepEqual(second.pending.map((entry) => entry.id), expectedIds, 'row identities survive repeated restores');
  assert.equal(second.flow.restoreQueued('', expectedIds[0]).text, 'new first input');
  await flushTuiSteeringPersist();
  assert.deepEqual(diskRows(id).map((row) => row.id), [expectedIds[1]]);
  assert.equal(second.flow.prioritizeQueued(expectedIds[1]).count, 1);
  await tick();
  assert.deepEqual(second.turns.map((turn) => turn.content), ['new second input']);
  await flushTuiSteeringPersist();
  assert.deepEqual(diskRows(id), []);
});

for (const [crossDevice, abortAccepted] of [
  [false, true],
  [true, true],
  [false, false],
]) {
  const scenario = `handoff=${crossDevice}, accepted=${abortAccepted}`;
  test(`recovered input releases its disk row only on draft reclamation (${scenario})`, async (t) => {
    const id = `abort_recovered_${crossDevice}_${abortAccepted}`;
    const text = 'return this input to its author';
    await appendTuiSteeringPersist(id, {
      id: 'cancel_me',
      text,
      content: text,
      transcriptMeta: { device: 'Desktop' },
    });
    await appendTuiSteeringPersist(id, { text: 'unrelated legacy input' });
    const f = flowFixture(t, id);
    await f.flow.restoreLeadSteeringFromDisk();
    let committed = 0;
    f.pending[0].onCommitted = () => {
      committed += 1;
    };
    const started = Promise.withResolvers();
    const settled = Promise.withResolvers();
    let finishProvider;
    f.runtime.ask = async (prompt, options) => {
      f.runtime.session.messages.push(storedUserMessage(prompt, options));
      const tracker = createTurnInterruptionTracker();
      // Stub runtime.ask at the provider boundary; use the actual receipt
      // bridge and interruption tracker on either side of the abort.
      const waiting = new Promise((_, reject) => {
        finishProvider = (reason) => {
          f.runtime.session.messages = tracker.finalize({
            turnOutgoing: f.runtime.session.messages,
            currentUserContent: prompt,
            abortReason: reason,
          }).messages;
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        };
      });
      started.resolve();
      return waiting;
    };
    f.runtime.abort = (reason) => {
      if (!abortAccepted) return false;
      finishProvider(reason);
      return true;
    };
    Object.assign(f.bag, f.flow, {
      itemIndexById: new Map(),
      replaceItems: (items) => items,
      pushItem: (item) => f.set({ items: [...f.getState().items, item] }),
      patchItem() {},
      syncContextStats() {},
      flushToolResults() {},
      denyAllToolApprovals() {},
      clearActiveToolSummary() {},
      routeState: () => ({}),
      agentStatusState: () => ({}),
      onGoalTurnSettled: () => settled.resolve(),
    });
    f.flags.leadTurnEpoch = 0;
    f.bag.runTurn = createRunTurn(f.bag);
    const { abort } = createAbortAction(f.bag);
    t.after(() => finishProvider?.('user-cancel'));
    f.set({ busy: false });
    await started.promise;
    const restored = abort({ device: crossDevice ? 'Phone' : 'Desktop' });
    if (!abortAccepted) {
      assert.equal(restored.aborted, false);
      await flushTuiSteeringPersist();
      assert.equal(diskRows(id).length, 2, 'a refused abort cannot release the in-flight input');
      assert.equal(committed, 0);
      finishProvider('user-cancel');
      await settled.promise;
      return;
    }
    assert.equal(restored.aborted, true);
    if (crossDevice) {
      assert.equal(restored.restoreText, '');
      assert.equal(f.getState().promptRestore.text, text);
      assert.deepEqual(f.getState().promptRestore.ids, ['cancel_me']);
    } else {
      assert.equal(restored.restoreText, text);
      assert.deepEqual(restored.restoredSubmissionIds, ['cancel_me']);
    }
    await settled.promise;
    await flushTuiSteeringPersist();
    assert.equal(committed, 0, 'reclaiming is not a successful delivery callback');
    assert.deepEqual(f.runtime.session.messages, [], 'the real interruption path removed the provisional receipt');
    assert.deepEqual(diskRows(id).map((row) => row.text), ['unrelated legacy input']);
    const restarted = flowFixture(t, id, { messages: f.runtime.session.messages, busy: false });
    await restarted.flow.restoreLeadSteeringFromDisk();
    await restarted.flow.drain();
    assert.deepEqual(restarted.pending.map((entry) => entry.text), ['unrelated legacy input']);
    assert.deepEqual(restarted.turns, [], 'the reclaimed input cannot auto-run after another restart');
  });
}

test('recovery keeps independent identical and substring submissions and removes only exact receipts', async (t) => {
  const id = 'identity_recovery';
  const f = flowFixture(t, id, {
    messages: [
      {
        role: 'user',
        content: '계속해',
        meta: { transcript: { checkpointId: 'old_first', submissionIds: ['old_first', 'old_second'] } },
      },
      { role: 'user', content: '이후에도 계속해 주세요', meta: { submissionIds: ['old_steered'] } },
      { role: 'user', content: 'different old body', meta: { transcript: { checkpointId: 'old_checkpoint' } } },
      { role: 'assistant', content: '계속해', meta: { submissionIds: ['new_repeat'] } },
    ],
  });
  const entries = [
    ['new_repeat', '계속해'],
    ['new_substring', '계속해 주세요'],
    ['old_first', 'rewritten wrapper one'],
    ['old_second', 'rewritten wrapper two'],
    ['old_steered', 'rewritten steering'],
    ['old_checkpoint', 'rewritten old turn'],
    ['new_repeat', '계속해'],
  ];
  for (const [submissionId, text] of entries) {
    await appendTuiSteeringPersist(id, { id: submissionId, text, content: text });
  }
  await f.flow.restoreLeadSteeringFromDisk();
  const expected = ['new_repeat', 'new_substring'];
  assert.deepEqual(f.pending.map((entry) => entry.id), expected);
  assert.deepEqual(diskRows(id).map((row) => row.submissionId), expected);
  f.set({ queued: [] });
  await f.flow.restoreLeadSteeringFromDisk();
  assert.deepEqual(
    f.getState().queued.map((entry) => entry.id),
    expected,
    'resume republishes already-live entries once'
  );
  assert.deepEqual(f.pending.map((entry) => entry.id), expected);
  assert.equal(await f.flow.enqueue('계속해', { id: 'new_repeat', awaitPersistence: true }), true);
  assert.equal(f.pending.length, 2, 'a transport retry of the accepted ID stays idempotent');
});

test('recovery remains durable across another restart until draft reclamation or canonical close', async (t) => {
  const id = 'repeated_recovery';
  for (const submissionId of ['edit_me', 'close_me']) {
    await appendTuiSteeringPersist(id, { id: submissionId, text: submissionId, content: submissionId });
  }
  const first = flowFixture(t, id);
  await first.flow.restoreLeadSteeringFromDisk();
  assert.equal(first.pending.length, 2);
  const second = flowFixture(t, id);
  await second.flow.restoreLeadSteeringFromDisk();
  assert.deepEqual(second.pending.map((entry) => entry.id), ['edit_me', 'close_me']);
  assert.equal(second.flow.restoreQueued('', 'edit_me').text, 'edit_me');
  await flushTuiSteeringPersist();
  assert.deepEqual(diskRows(id).map((row) => row.submissionId), ['close_me']);
  second.flags.admission = 'terminal';
  second.flow.settleClosedQueue();
  await flushTuiSteeringPersist();
  const third = flowFixture(t, id);
  await third.flow.restoreLeadSteeringFromDisk();
  assert.deepEqual(third.pending, []);
  assert.equal(existsSync(shardPath(id)), false);
});

test('legacy recovery waits for explicit action through resume and its real busy-release drain', async (t) => {
  const id = 'legacy_recovery';
  const key = `tui_${id}`;
  const now = Date.now();
  mkdirSync(join(dataDir, 'session-pending'), { recursive: true });
  writeFileSync(
    shardPath(id),
    JSON.stringify({
      version: 1,
      updatedAt: now,
      sessionTouchedAt: { [key]: now },
      sessions: {
        [key]: ['legacy one', { id: 'ts_legacy_two', text: 'legacy two', at: now, submissionId: 'legacy_two' }],
      },
    })
  );
  const f = flowFixture(t, id, { busy: false });
  const api = createResumeAction(
    {
      ...f.bag,
      restoreLeadSteeringFromDisk: f.flow.restoreLeadSteeringFromDisk,
      replaceItems: (items) => items,
      clearToastTimers() {},
      routeState: () => ({}),
      resetStatsAndSyncContext() {},
    },
    { restoreTranscriptItems: () => [] }
  );
  assert.equal(await api.resume(id, { quiet: true }), true);
  await tick();
  assert.deepEqual(f.turns, [], 'releasing the real resume gate cannot execute incomplete legacy input');
  assert.equal(f.pending.length, 2);
  assert.equal(f.flow.hasPendingUserInput(), false);
  assert.equal(f.flow.pendingTaskWaitWake(), false);
  assert.deepEqual(f.flow.drainPendingSteering(), []);
  const restoredIds = f.pending.map((entry) => entry.id);
  await f.flow.restoreLeadSteeringFromDisk();
  assert.deepEqual(f.pending.map((entry) => entry.id), restoredIds);

  await f.flow.enqueue('new explicit input', { id: 'fresh', awaitPersistence: true });
  await tick();
  assert.deepEqual(f.turns.map((turn) => turn.content), ['new explicit input']);
  assert.equal(f.pending.length, 2, 'ordinary new input does not consent to replay the legacy rows');
  assert.equal(f.flow.prioritizeQueued(restoredIds[0]).count, 1);
  await tick();
  assert.deepEqual(f.turns.map((turn) => turn.content), ['new explicit input', 'legacy one']);
  assert.equal(f.flow.restoreQueued('', restoredIds[1]).text, 'legacy two');
  await flushTuiSteeringPersist();
  assert.deepEqual(diskRows(id), []);
});

test('recovered attachments reach steering and return their original bytes to the editor', async (t) => {
  const id = 'attachment_recovery';
  const text = '/literal text [Pasted text #7] [Image #3] [PDF #4: note.pdf]';
  const imageData = Buffer.from('queued image').toString('base64');
  const pdfData = Buffer.from('%PDF-1.4 queued document').toString('base64');
  const pastedText = '붙여넣은 원문을 보존합니다.\n'.repeat(100);
  const intake = materializePromptSubmission(
    [
      { type: 'text', text },
      { type: 'image', data: imageData, mimeType: 'image/png' },
      { type: 'file', data: pdfData, mimeType: 'application/pdf', filename: 'note.pdf' },
    ],
    {
      displayText: text,
      pastedImages: { 3: { id: 3, type: 'image', filename: 'shot.png', mediaType: 'image/png' } },
      pastedTexts: { 7: { id: 7, text: pastedText, filename: 'context.txt' } },
    }
  );
  const transcriptMeta = {
    messageId: 'msg_recovered',
    attachments: attachmentsForIntake(intake.prompt, intake.options),
  };
  const writer = flowFixture(t, id);
  await writer.flow.enqueue(intake.prompt, {
    ...intake.options,
    id: 'rich',
    transcriptMeta,
    skipSlashCommands: true,
    priority: 'later',
    awaitPersistence: true,
  });
  const consumer = flowFixture(t, id);
  await consumer.flow.restoreLeadSteeringFromDisk();
  assert.equal(consumer.pending.length, 1);
  assert.equal(consumer.pending[0].text, text);
  assert.deepEqual(consumer.pending[0].content, intake.prompt);
  assert.equal(consumer.pending[0].priority, 'later');
  assert.equal(consumer.pending[0].skipSlashCommands, true);
  assert.deepEqual(consumer.flow.drainPendingSteering(), [], 'the stored priority is honored');

  // A separate fresh reader represents recovery before this queued input is
  // consumed. Reclaim hydrates from the real blob store, not display text.
  const editor = flowFixture(t, id);
  await editor.flow.restoreLeadSteeringFromDisk();
  const restored = editor.flow.restoreQueued('', 'rich');
  assert.equal(restored.text, text);
  assert.equal(restored.pastedImages[3].content, imageData);
  assert.equal(restored.pastedTexts[7].text, pastedText);
  assert.deepEqual(restored.content, [
    { type: 'file', data: pdfData, mimeType: 'application/pdf', filename: 'note.pdf' },
  ]);
  const steered = consumer.flow.drainPendingSteering({ maxPriority: 'later' });
  assert.equal(steered.length, 1);
  assert.deepEqual(steered[0].content, intake.prompt);
  assert.deepEqual(steered[0].transcriptMeta, transcriptMeta);
  await flushTuiSteeringPersist();
  assert.deepEqual(diskRows(id), []);
});
