import assert from 'node:assert/strict';
import test from 'node:test';

import { buildShellSpawnEnv } from './bash-tool.mjs';
import { resourceAdmission } from '../../../../shared/resource-admission.mjs';

test('shell child receives the resource-admission shell cap', () => {
  const env = buildShellSpawnEnv('C:\\x', { PATH: '', MIXDOG_SHELL_CONCURRENCY_CAP: '99' });
  assert.equal(env.MIXDOG_SHELL_CONCURRENCY_CAP, String(resourceAdmission.limits.maxShells));
});

test('shell child receives the caller session cwd without mutating the daemon env', () => {
  const base = {
    PATH: process.env.PATH || '',
    MIXDOG_SESSION_CWD: 'C:\\wrong-session',
  };
  const env = buildShellSpawnEnv('C:\\Project\\mixdog', base);
  assert.equal(env.MIXDOG_SESSION_CWD, 'C:\\Project\\mixdog');
  assert.equal(base.MIXDOG_SESSION_CWD, 'C:\\wrong-session');
});
