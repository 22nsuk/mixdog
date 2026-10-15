import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProviderAdmissionScheduler,
  wrapProviderAdmission,
} from '../../agent/orchestrator/providers/admission-scheduler.mjs';
import { withTaskRun } from './task-usage-context.mjs';
import { getUsageLedger, closeUsageLedgers } from './usage-ledger.mjs';

test('a queued provider call retains its own task when another task releases the admission slot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-task-admission-'));
  const old = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = join(dir, 'ledger.sqlite');
  const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
  t.after(async () => {
    scheduler.shutdown();
    await getUsageLedger().settleWrites();
    closeUsageLedgers();
    if (old === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = old;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const firstEntered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const provider = wrapProviderAdmission(
    {
      async send([n]) {
        if (n === 10) {
          firstEntered.resolve();
          await release.promise;
        }
        return { content: 'done', usage: { inputTokens: n, outputTokens: 1 } };
      },
    },
    'task-queued-fixture',
    scheduler
  );
  const run = (id, n) =>
    withTaskRun({ id, sessionId: id, source: 'prompt', startedAt: Date.now() }, () =>
      provider.send([n], 'fixture', [], { sessionId: id })
    );
  const first = run('a', 10);
  await firstEntered.promise;
  const second = run('b', 20);
  try {
    const deadline = Date.now() + 5000;
    while (![...scheduler.lanes.values()].some((lane) => lane.queue.length === 1)) {
      assert.ok(Date.now() < deadline, 'second request must enter the actual admission queue');
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    release.resolve();
  }
  await Promise.all([first, second]);
  assert.equal((await getUsageLedger().taskUsageAsync('a')).tasks[0].totals.input, 10);
  assert.equal((await getUsageLedger().taskUsageAsync('b')).tasks[0].totals.input, 20);
});
