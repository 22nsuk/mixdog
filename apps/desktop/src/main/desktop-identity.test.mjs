import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { desktopIdentity } from './desktop-identity.ts';

test('installed Mixdog retains its registered product identity; dev/probes cannot collide', () => {
  assert.deepEqual(desktopIdentity('installed'), { appId: 'io.mixdog.desktop', name: 'Mixdog' });
  const identities = ['installed', 'development', 'probe'].map(desktopIdentity);
  assert.equal(new Set(identities.map((identity) => identity.appId)).size, 3);
  assert.equal(new Set(identities.map((identity) => identity.name)).size, 3);
  assert.equal(desktopIdentity('development').name, 'Mixdog Dev');
  assert.equal(desktopIdentity('probe').name, 'Mixdog Notification Test');
});

test('the native probe rejects a production identity override before launching Electron', async () => {
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('../../scripts/notification-probe.mjs', import.meta.url)), '--app-id=io.mixdog.desktop'],
      { timeout: 10_000 }
    ),
    (error) => {
      assert.match(error.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
      return true;
    }
  );
});
