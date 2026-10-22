// Real atomic-write failure at the admission persistence boundary. Arm only
// after admission, so the operation is allowed to run before cleanup fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { samePath } from './paths.mjs';

export function admissionWriteFault(t, repo, copy = 'mirror') {
  const ledger = join(repo, '.git', 'mixdog-workspace-admission.json');
  const mirror = `${ledger}.management`;
  const target = copy === 'primary' ? ledger : mirror;
  const rename = fs.renameSync;
  let remaining = 0;
  let count = 0;
  const fault = t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (remaining > 0 && samePath(to, target)) {
      remaining -= 1;
      count += 1;
      throw Object.assign(new Error(`injected ${copy} admission write failure`), { code: 'EIO' });
    }
    return rename(from, to, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    fault.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    arm: (attempts = Infinity) => {
      remaining = attempts;
    },
    stop: () => {
      remaining = 0;
    },
    get count() {
      return count;
    },
    assertEmpty() {
      for (const file of [ledger, mirror]) assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).leases, []);
    },
  };
}
