import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobStarter } from './services/agent-tool/spawn-flow/job-start.mjs';
import { cleanupBackgroundTasks } from '../runtime/shared/background-tasks.mjs';

import { executeInternalTool } from '../runtime/agent/orchestrator/internal-tools.mjs';
import {
  AUTOMATION_TOOL_SCOPE,
  deliverAutomationCompletion,
  registerAutomationAgentTool,
  runAutomationTurns,
} from './automation-agents.mjs';

for (const mode of ['focused', 'balanced', 'swarm']) {
  for (const operation of ['spawn', 'send']) {
    test(`automation ${operation} preserves the caller's ${mode} mode in the job`, async (t) => {
      const start = createJobStarter({
        mgr: {},
        notifyStatusChange() {},
        notifySessionCompletion: () => true,
        admission: {
          acquire: async () => ({ release: async () => {} }),
          runWithLease: (_lease, run) => run(),
        },
      });
      let job;
      t.after(() => cleanupBackgroundTasks({ surface: 'agent', force: true }));
      t.after(
        registerAutomationAgentTool(async (args, context) => {
          job = start(args.type, {}, async () => ({ content: 'fixture' }), context);
          await job.promise;
          return 'fixture';
        })
      );
      await executeInternalTool(
        'agent',
        { type: operation, orchestrationMode: 'none' },
        {
          scopeId: AUTOMATION_TOOL_SCOPE,
          callerSessionId: 'automation-fixture',
          orchestrationMode: mode,
        }
      );
      assert.equal(job.meta.delegation.callerSessionId, 'automation-fixture');
      assert.equal(job.meta.delegation.mode, mode);
      assert.equal(job.status, 'completed');
    });
  }
}

test('an automation run turns each delegated agent result into its next turn', async (t) => {
  const controlCalls = [];
  t.after(
    registerAutomationAgentTool(async (args, context) => {
      controlCalls.push({ args, context });
      return 'agent task: task-1\nstatus: running';
    })
  );
  const turns = [];
  const result = await runAutomationTurns(
    'sess-auto',
    async () => {
      turns.push('first');
      // The model delegates through the automation scope during its first turn.
      await executeInternalTool(
        'agent',
        { type: 'spawn', agent: 'worker', prompt: 'do it' },
        { scopeId: AUTOMATION_TOOL_SCOPE, callerSessionId: 'sess-auto', callerCwd: '/project' }
      );
      // The header-only preview is taken but does not start a turn; the body does.
      setTimeout(() => {
        assert.equal(
          deliverAutomationCompletion('sess-auto', 'preview', {
            execution_id: 'task-1',
            model_visible: false,
          }),
          true
        );
        assert.equal(
          deliverAutomationCompletion('sess-auto', 'worker done', { execution_id: 'task-1' }),
          true
        );
      }, 5);
      return { content: 'delegated' };
    },
    async (completions, askOpts) => {
      turns.push(completions);
      // Worker results are the runtime reporting, never a user skill selection.
      assert.deepEqual(askOpts, { promptSource: 'task-notification' });
      return { content: 'final answer' };
    }
  );
  assert.deepEqual(turns, ['first', 'worker done']);
  assert.equal(result.content, 'final answer');
  assert.equal(controlCalls[0].context.callerSessionId, 'sess-auto');
  assert.equal(controlCalls[0].context.callerCwd, '/project');
  // The run is over: later completions belong to no automation.
  assert.equal(deliverAutomationCompletion('sess-auto', 'late', { execution_id: 'task-1' }), false);
});

test('a run without delegation ends after its first turn, and a silent agent times out', async (t) => {
  let turns = 0;
  const plain = await runAutomationTurns(
    'sess-plain',
    async () => ({ content: 'only' }),
    async () => {
      turns++;
    }
  );
  assert.equal(plain.content, 'only');
  assert.equal(turns, 0);

  t.after(registerAutomationAgentTool(async () => 'agent task: task-9\nstatus: running'));
  const silent = await runAutomationTurns(
    'sess-silent',
    async () => {
      await executeInternalTool(
        'agent',
        { type: 'spawn' },
        { scopeId: AUTOMATION_TOOL_SCOPE, callerSessionId: 'sess-silent' }
      );
      return { content: 'waiting' };
    },
    async () => ({ content: 'never' }),
    { waitMs: 20 }
  );
  assert.equal(silent.content, 'waiting');
  // A completion for a task this run never started is not its business.
  assert.equal(deliverAutomationCompletion('sess-other', 'x', { execution_id: 'task-9' }), false);
});
