import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real provider response -> askSession loop -> spawn/send terminal hook ->
// session job projection. Provider responses and UI notifications are fixtures;
// usage normalization must not be mocked, or missing usage looks unknown here.
const root = mkdtempSync(join(tmpdir(), 'mixdog-delegation-runtime-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const fixture = join(root, 'fixture.txt');
writeFileSync(fixture, 'delegation fixture');
const { createSession } = await import(
  '../../../runtime/agent/orchestrator/session/manager/session-lifecycle.mjs'
);
const { askSession } = await import('../../../runtime/agent/orchestrator/session/manager/ask-session.mjs');
const { deleteSession } = await import('../../../runtime/agent/orchestrator/session/store.mjs');
const { _withRegisteredProviderForTestAsync } = await import(
  '../../../runtime/agent/orchestrator/providers/registry.mjs'
);
const { createSpawnFlow } = await import('./spawn-flow.mjs');
const { createSendFlow } = await import('./send-flow.mjs');
const { createJobRender } = await import('./job-views/job-render.mjs');
const { delegationObservations } = await import('../../../ui/delegation-observations.mjs');
const { getBackgroundTask, cleanupBackgroundTasks } = await import(
  '../../../runtime/shared/background-tasks.mjs'
);
// The store drains deferred writes on exit; remove our directory after it.
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
});

const cases = [
  ['missing usage', [undefined], null, null],
  ['output only', [{ outputTokens: 7 }], null, 7],
  ['input only', [{ inputTokens: 9 }], 9, null],
  ['measured zero', [{ inputTokens: 0, outputTokens: 0 }], 0, 0],
  [
    'all calls measured',
    [
      { inputTokens: 10, outputTokens: 2 },
      { inputTokens: 20, outputTokens: 3 },
    ],
    30,
    5,
  ],
  ['later input missing', [{ inputTokens: 10, outputTokens: 2 }, { outputTokens: 3 }], null, 5],
  ['earlier output missing', [{ inputTokens: 10 }, { inputTokens: 20, outputTokens: 3 }], 30, null],
  [
    'unmeasured call between measured calls',
    [{ inputTokens: 10, outputTokens: 2 }, undefined, { inputTokens: 20, outputTokens: 3 }],
    null,
    null,
  ],
];

for (const operation of ['spawn', 'send']) {
  for (const [name, usages, inputTokens, outputTokens] of cases) {
    test(`${operation}: real turn preserves ${name}`, async () => {
      let sends = 0;
      const providerName = 'delegation-runtime-fixture';
      await _withRegisteredProviderForTestAsync(
        providerName,
        {
          name: providerName,
          contextWindow: 128000,
          async send(messages) {
            if (sends > 0)
              assert.match(
                JSON.stringify(messages),
                /delegation fixture/,
                'the real read tool returned fixture bytes'
              );
            const usage = usages[sends++];
            assert.ok(sends <= usages.length, 'unexpected extra provider call');
            return {
              content: sends === usages.length ? 'fixture answer' : '',
              ...(usage ? { usage } : {}),
              toolCalls:
                sends < usages.length
                  ? [{ id: `read-${sends}`, name: 'read', arguments: { path: fixture } }]
                  : [],
            };
          },
        },
        async () => {
          const session = createSession({
            provider: providerName,
            model: 'fixture',
            cwd: root,
            skipSkills: true,
            schemaAllowedTools: ['read'],
            workflow: { id: 'headless', delegatesAgents: false },
          });
          // Worker transcripts are not ordinary-session search ingestion. Keep
          // this a real worker so these tests never start a search database.
          session.visibility = 'agent-only';
          const mgr = { getSession: () => session, askSession, closeSession() {} };
          const registry = {
            tagForSession: () => 'fixture',
            upsertWorkerSessionDeferred() {},
            scheduleReap() {},
          };
          const flow = createSpawnFlow({
            mgr,
            ...registry,
            emitSubagentEvent() {},
            notifyStatusChange() {},
            notifySessionCompletion: () => true,
            createTurnReviewCollector: () => ({ onToolResult() {}, complete() {} }),
          });
          const views = createJobRender({
            progress: { sessionProgressExtras: () => ({}), jobWorkerSnapshot: () => ({}) },
          });
          const context = { callerSessionId: 'lead-fixture', orchestrationMode: 'focused' };
          try {
            let job;
            if (operation === 'spawn') {
              job = flow.startJob(
                'spawn',
                { sessionId: session.id },
                (job, owner) =>
                  flow.runSpawn(
                    {
                      args: {},
                      tag: 'fixture',
                      session,
                      agent: 'worker',
                      preset: { provider: providerName, model: 'fixture' },
                      presetName: 'worker',
                      prompt: 'read the fixture and answer',
                      watchdogPolicy: null,
                    },
                    owner,
                    job
                  ),
                context
              );
            } else {
              const send = createSendFlow({
                mgr,
                defaultCwd: root,
                canUseSessionSurface: () => false,
                registry,
                spawnFlow: flow,
                views: { ...views, isSessionBusy: () => false },
              });
              const ack = await send.dispatchToExistingSession(
                { args: {}, session, sessionId: session.id, prompt: 'read the fixture and answer' },
                context
              );
              job = getBackgroundTask(/agent task: (\S+)/.exec(ack)[1]);
            }
            await job.promise;
            assert.equal(job.status, 'completed', job.error);
            assert.equal(job.result.content, 'fixture answer');
            assert.equal(sends, usages.length);
            const wire = JSON.parse(JSON.stringify(views.listJobs(context)));
            const [observed] = delegationObservations(wire, context.callerSessionId).rows;
            assert.equal(observed.inputTokens, inputTokens);
            assert.equal(observed.outputTokens, outputTokens);
            assert.equal(observed.toolCalls, usages.length - 1);
            assert.equal(observed.outcome, 'completed');
            assert.equal(job.result.usage, undefined, 'handoff contract stays unchanged');
          } finally {
            cleanupBackgroundTasks({ surface: 'agent', force: true });
            deleteSession(session.id, { deferSummaryUpdate: true });
          }
        }
      );
    });
  }
}
