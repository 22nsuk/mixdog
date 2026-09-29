// Side-effect module: import FIRST in tests that touch the read-snapshot store.
// Points the Mixdog data dir at a per-run temp dir before snapshot-store.mjs
// resolves SNAPSHOT_DIR at module load, so tests never write to the real one.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.MIXDOG_TEST_DATA_DIR_OWNED) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-test-data-'));
  process.env.MIXDOG_DATA_DIR = dir;
  process.env.MIXDOG_TEST_DATA_DIR_OWNED = '1';
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}
