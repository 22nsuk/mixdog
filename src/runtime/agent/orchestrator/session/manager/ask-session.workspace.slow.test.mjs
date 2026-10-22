import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { cleanupTempDirs, makeRepo, tempDir } from '../../../../shared/worktrees/test-support.mjs';
import { samePath } from '../../../../shared/worktrees/paths.mjs';

// Real ask/queue/admission and filesystem boundaries with a fake provider.
// Inject queued input after the real commit so publish, not mid-turn steering,
// owns its drain. Keep deferred saves in this process's disposable profile and
// make release retries deterministic: the next admission, not the heal timer.
process.env.MIXDOG_DATA_DIR = tempDir('mixdog-ask-workspace-');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_ADMISSION_HEAL_MS = '60000';
let afterCommit = () => {};
const settle = await import('./ask-turn-settle.mjs');
mock.module('./ask-turn-settle.mjs', {
  namedExports: {
    ...settle,
    commitAskTurn: async (input) => {
      const result = await settle.commitAskTurn(input);
      afterCommit(input);
      return result;
    },
  },
});
const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { deleteSession, loadSession } = await import('../store.mjs');
const { enqueuePendingMessage, settlePendingMessageWrites } = await import('./pending-messages.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
const { SessionClosedError } = await import('./session-errors.mjs');
const { abortSessionTurn } = await import('./session-close.mjs');
const { tryAdmitWorkspaceActivity } = await import('../../../../shared/worktrees/activity-gate.mjs');
process.on('exit', cleanupTempDirs);

async function withWorkspaceAsk(t, run, { diagnosticFailure = false } = {}) {
  const repo = makeRepo();
  const ledger = join(repo, '.git', 'mixdog-workspace-admission.json');
  const mirror = `${ledger}.management`;
  const sends = [];
  const warnings = [];
  let reply = async () => ({ content: 'answer', usage: { inputTokens: 1, outputTokens: 1 } });
  let failuresLeft = 0;
  let faults = 0;
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (failuresLeft > 0 && samePath(to, mirror) && JSON.parse(readFileSync(from, 'utf8')).leases.length === 0) {
      failuresLeft -= 1;
      faults += 1;
      throw Object.assign(new Error('injected mirror release failure'), { code: 'EIO' });
    }
    return rename(from, to, ...args);
  });
  syncBuiltinESMExports();
  const stderr = process.stderr.write;
  const log = t.mock.method(process.stderr, 'write', function (chunk, ...args) {
    if (String(chunk).includes('[agent-ask] workspace lease release pending')) {
      warnings.push(String(chunk));
      if (diagnosticFailure) throw new Error('diagnostic sink unavailable');
      return true;
    }
    return stderr.call(this, chunk, ...args);
  });
  const providerName = 'ask-workspace-release-test';
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages, _model, _tools, opts) {
      sends.push(messages.map(({ role, content }) => ({ role, content })));
      return reply(messages, opts);
    },
  };
  let session;
  try {
    await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
      session = createSession({
        provider: providerName,
        model: 'fake-model',
        cwd: repo,
        owner: 'agent',
        parentSessionId: 'sess_workspace_parent',
        skipSkills: true,
        schemaAllowedTools: modelToolSchemaAllowlist('headless'),
        workflow: { id: 'headless', delegatesAgents: false },
      });
      await run({
        session,
        sends,
        warnings,
        ask: (prompt, opts = {}) => askSession(session.id, prompt, null, null, null, null, opts),
        setReply: (fn) => {
          reply = fn;
        },
        afterCommit: (fn) => {
          afterCommit = fn;
        },
        failReleases: (count) => {
          failuresLeft = count;
        },
        faultCount: () => faults,
        leases: () => [ledger, mirror].map((path) => JSON.parse(readFileSync(path, 'utf8')).leases),
      });
    });
  } finally {
    afterCommit = () => {};
    fault.mock.restore();
    syncBuiltinESMExports();
    log.mock.restore();
    // Finish any pending release even if a regression assertion failed.
    const leave = tryAdmitWorkspaceActivity('fixture-cleanup', repo);
    assert.ok(leave);
    leave();
    await settlePendingMessageWrites({ throwOnTimeout: true });
    if (session) deleteSession(session.id, { deferSummaryUpdate: true });
    await settlePendingMessageWrites({ throwOnTimeout: true });
  }
}

for (const diagnosticFailure of [false, true]) {
  test(`mirror release failure preserves a completed worker result (diagnosticFailure=${diagnosticFailure})`, async (t) => {
    await withWorkspaceAsk(
      t,
      async ({ session, ask, sends, warnings, failReleases, faultCount, leases }) => {
        failReleases(1);
        const terminal = [];
        const result = await ask('first', { onTerminalResult: (value) => terminal.push(value) });
        assert.equal(faultCount(), 1, 'the release mirror write failed after admission');
        assert.equal(result.content, 'answer');
        assert.deepEqual(
          terminal.map((value) => value.content),
          ['answer']
        );
        assert.equal(loadSession(session.id).messages.at(-1).content, 'answer');
        assert.deepEqual(
          leases().map((entries) => entries.length),
          [0, 1]
        );
        assert.equal(warnings.length, 1, 'cleanup failure remains observable without rejecting the turn');
        assert.match(warnings[0], /WORKTREE_BUSY_JOBS/);
        assert.equal((await ask('next')).content, 'answer');
        assert.equal(sends.length, 2, 'the session lock and next admission are usable');
        assert.deepEqual(leases(), [[], []], 'the completed lease is retired, not resurrected');
      },
      { diagnosticFailure }
    );
  });
}

for (const failureMode of ['none', 'once', 'persistent']) {
  test(`follow-up input survives mirror release failure (${failureMode})`, async (t) => {
    await withWorkspaceAsk(
      t,
      async ({ session, ask, sends, warnings, setReply, afterCommit, failReleases, faultCount, leases }) => {
        afterCommit(() => {
          if (sends.length === 1) enqueuePendingMessage(session.id, 'queued follow-up');
        });
        setReply(async () => {
          return {
            content: sends.length === 1 ? 'first answer' : 'follow-up answer',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        });
        failReleases(failureMode === 'persistent' ? Infinity : failureMode === 'once' ? 1 : 0);
        if (failureMode === 'persistent') {
          // The completed turn still hands its drained entries to the queue.
          // A real failure to admit the next turn must release them for retry.
          await assert.rejects(ask('first'), { code: 'WORKTREE_BUSY_JOBS' });
          assert.equal(sends.length, 1, 'no follow-up provider call was admitted');
          assert.equal(loadSession(session.id).messages.at(-1).content, 'first answer');
          failReleases(0);
          assert.equal((await ask(''))?.content, 'follow-up answer', 'the unstarted follow-up is requeued');
        } else {
          assert.equal((await ask('first')).content, 'follow-up answer');
        }
        assert.equal(faultCount() > 0, failureMode !== 'none');
        assert.equal(warnings.length, failureMode === 'none' ? 0 : 1);
        assert.equal(sends.length, 2);
        assert.match(String(sends[1].findLast((message) => message.role === 'user').content), /queued follow-up/);
        assert.deepEqual(
          loadSession(session.id)
            .messages.filter((message) => message.role === 'assistant')
            .map((message) => message.content),
          ['first answer', 'follow-up answer']
        );
        await settlePendingMessageWrites({ throwOnTimeout: true });
        assert.equal(await ask(''), undefined, 'no drained input is replayed after success');
        assert.equal(sends.length, 2);
        assert.deepEqual(leases(), [[], []]);
      }
    );
  });
}

for (const outcome of ['provider-error', 'cancel']) {
  test(`mirror release failure does not replace the worker's ${outcome}`, async (t) => {
    await withWorkspaceAsk(t, async ({ session, ask, setReply, failReleases, faultCount, warnings }) => {
      const failure = Object.assign(new Error('provider exploded'), { httpStatus: 400 });
      setReply(async (_messages, opts) => {
        if (outcome === 'provider-error') throw failure;
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          abortSessionTurn(session.id, 'user-cancel');
        });
      });
      failReleases(1);
      await assert.rejects(ask('first'), (error) => {
        if (outcome === 'provider-error') assert.equal(error, failure);
        else assert.ok(error instanceof SessionClosedError);
        return true;
      });
      assert.equal(faultCount(), 1);
      assert.equal(warnings.length, 1);
      setReply(async () => ({ content: 'recovered' }));
      assert.equal((await ask('after failure')).content, 'recovered');
    });
  });
}
