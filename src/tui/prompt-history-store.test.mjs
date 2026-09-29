import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-prompt-history-'));
const { writeRetryDelayMs } = await import('./prompt-history-store.mjs');

test('a failing history flush backs off exponentially and caps instead of retrying every window', () => {
  const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(writeRetryDelayMs);
  assert.deepEqual(delays.slice(0, 3), [500, 1000, 2000]);
  for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i] >= delays[i - 1], 'never shrinks');
  assert.equal(delays.at(-1), 30_000);
  assert.ok(delays.every((delay) => delay <= 30_000));
});
