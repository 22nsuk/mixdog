import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { beginProcessLifecycle, finishProcessLifecycleAsync } from './process-lifecycle.mjs';

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '0']);
  return child.pid;
}

test('boot records dead prior markers through the async lock path, after process-start', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-lifecycle-'));
  try {
    const markerDir = join(directory, 'process-lifecycle.active');
    mkdirSync(markerDir, { recursive: true });
    const pid = deadPid();
    const stale = join(markerDir, `${pid}-old.json`);
    writeFileSync(stale, `${JSON.stringify({ version: 1, pid, token: 'old', processIdentity: null })}\n`);

    const api = beginProcessLifecycle({ directory, configureReports: false });
    const ledger = () => (existsSync(api.ledgerPath) ? readFileSync(api.ledgerPath, 'utf8') : '');

    // process-start is the synchronous try-lock append and comes first; the
    // dead marker's record is deferred off the caller's stack.
    assert.match(ledger(), /"reason":"process-start"/);
    assert.equal(existsSync(stale), true, 'the dead marker is not reaped synchronously');

    for (let i = 0; i < 100 && existsSync(stale); i += 1) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(existsSync(stale), false, 'reaped once its ledger record landed');
    const reasons = ledger()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      reasons.map((entry) => entry.reason),
      ['process-start', 'prior-process-vanished']
    );
    assert.equal(reasons[1].pid, pid);
  } finally {
    await finishProcessLifecycleAsync();
    rmSync(directory, { recursive: true, force: true });
  }
});
