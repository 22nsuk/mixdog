import '../../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  _shellJobRecordWritesSettledForTest,
  adoptShellWorkspaceAdmission,
  completeShellJobRecord,
  publishShellJobRecord,
  readShellJobRecord,
  releaseShellJobWorkspace,
  retireShellJobRecord,
} from './shell-job-records.mjs';
import {
  finishWorkspaceActivity,
  holdWorkspaceActivity,
  tryAdmitWorkspaceActivity,
} from '../../../../../shared/worktrees/activity-gate.mjs';
import { admissionWriteFault } from '../../../../../shared/worktrees/admission-fault-fixture.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../../shared/worktrees/test-support.mjs';
import { handOverLease } from '../../lib/shell-run-background/promote-job.mjs';

process.env.MIXDOG_ADMISSION_HEAL_MS = '60000';
after(cleanupTempDirs);

test('promotion retains the admitted background owner when foreground release fails', async (t) => {
  const repo = makeRepo();
  const fault = admissionWriteFault(t, repo);
  const jobId = 'job_promoted_release';
  const foreground = tryAdmitWorkspaceActivity(jobId, repo, { kind: 'command' });
  let resourceReleased = false;
  const run = {
    workspaceAdmission: foreground,
    resourceLease: {
      release: async () => {
        resourceReleased = true;
      },
    },
  };
  try {
    // Promotion has already admitted the background owner before the handoff.
    publishShellJobRecord({ jobId, pid: process.pid, cwd: repo, command: 'long-lived command' });
    await _shellJobRecordWritesSettledForTest(jobId);
    fault.arm();
    await handOverLease(run);
    assert.equal(resourceReleased, true);
    assert.equal(run.workspaceAdmission, null);
    assert.ok(fault.count > 0);
    fault.stop();
    assert.throws(() => holdWorkspaceActivity([repo]), { details: { reason: 'folder-in-use' } });
    assert.equal(await completeShellJobRecord(jobId, { status: 'completed', exitCode: 0 }), true);
    holdWorkspaceActivity([repo])();
    fault.assertEmpty();
  } finally {
    fault.stop();
    finishWorkspaceActivity(foreground);
    retireShellJobRecord(jobId);
    await _shellJobRecordWritesSettledForTest(jobId);
  }
});

for (const copy of ['primary', 'mirror']) {
  for (const end of ['complete', 'retire', 'survivor release']) {
    test(`all shell leases finish on ${end} after ${copy} release failure`, async (t) => {
      const repo = makeRepo();
      const fault = admissionWriteFault(t, repo, copy);
      const jobId = `job_release_${copy}_${end.replaceAll(' ', '_')}`;
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const exited = once(child, 'exit');
      const leaveRuntime = tryAdmitWorkspaceActivity(jobId, repo, { kind: 'command' });
      const unrelated = tryAdmitWorkspaceActivity('unrelated-live-turn', repo);
      try {
        publishShellJobRecord({ jobId, pid: child.pid, cwd: repo, command: 'test child' });
        adoptShellWorkspaceAdmission(jobId, leaveRuntime);
        await _shellJobRecordWritesSettledForTest(jobId);
        child.kill();
        await exited;
        fault.arm();
        if (end === 'complete') {
          assert.equal(await completeShellJobRecord(jobId, { status: 'completed', exitCode: 0 }), true);
          assert.equal((await readShellJobRecord(jobId)).terminal, true);
          assert.equal(
            existsSync(join(process.env.MIXDOG_DATA_DIR, 'shell-jobs', `${jobId}.owner-${process.pid}`)),
            false
          );
        } else if (end === 'retire') {
          retireShellJobRecord(jobId);
          await _shellJobRecordWritesSettledForTest(jobId);
          assert.equal(await readShellJobRecord(jobId), null);
        } else {
          releaseShellJobWorkspace(jobId);
        }
        assert.ok(fault.count > 0, 'the real atomic admission write failed');
        fault.stop();
        // Retrying a pending release cannot remove another live owner's lease.
        assert.throws(() => holdWorkspaceActivity([repo]), { details: { reason: 'folder-in-use' } });
        unrelated();
        // The next mutation must finish EVERY stopped command token, even the
        // runtime-PID token whose process is still alive and cannot be pruned.
        holdWorkspaceActivity([repo])();
        fault.assertEmpty();
      } finally {
        fault.stop();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        finishWorkspaceActivity(leaveRuntime, unrelated);
        releaseShellJobWorkspace(jobId);
        retireShellJobRecord(jobId);
        await _shellJobRecordWritesSettledForTest(jobId);
      }
    });
  }
}
