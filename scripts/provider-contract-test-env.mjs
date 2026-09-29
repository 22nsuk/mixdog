// Import this FIRST in provider-contract-test.mjs. Runtime modules resolve the
// data dir (and the config file under it) once, at load, so the isolated dir
// must exist before any of them is imported; setting it later leaves the
// developer's real config — including Settings → Developer options — in play.
//
// Usage snapshots persist to <data dir>/gateway-oauth-usage-cache.json. Without
// an isolated data dir these fixtures wrote provider rows into the developer's
// real cache, where a fake model id could later win a provider fallback lookup.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROVIDER_CONTRACT_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-provider-contract-'));
process.env.MIXDOG_DATA_DIR = PROVIDER_CONTRACT_DATA_DIR;
process.on('exit', () => {
  try {
    rmSync(PROVIDER_CONTRACT_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* a still-open handle leaves it for the OS temp cleanup */
  }
});
