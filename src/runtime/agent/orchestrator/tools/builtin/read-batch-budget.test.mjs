import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeBuiltinTool } from '../builtin.mjs';

const lines = (n, tag) => `${Array.from({ length: n }, (_, i) => `${tag}${i + 1} ${'x'.repeat(24)}`).join('\n')}\n`;

test('a large file in a batch of small files is returned whole when the sum fits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-read-budget-'));
  try {
    await writeFile(join(root, 'big.txt'), lines(480, 'B')); // ~14 KB
    for (const n of ['a', 'b', 'c']) await writeFile(join(root, `${n}.txt`), lines(170, n.toUpperCase())); // ~5 KB
    const out = await executeBuiltinTool(
      'read',
      { file_path: ['big.txt', 'a.txt', 'b.txt', 'c.txt'].map((file_path) => ({ file_path })) },
      root
    );
    assert.match(out, /\bB480 /);
    assert.match(out, /\bC170 /);
    assert.doesNotMatch(out, /output truncated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a batch exceeding the budget still truncates and the marker shows the file size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-read-budget-'));
  try {
    const names = ['a', 'b', 'c', 'd'];
    for (const n of names) await writeFile(join(root, `${n}.txt`), lines(1000, n.toUpperCase())); // ~28 KB each
    const out = await executeBuiltinTool(
      'read',
      { file_path: names.map((n) => ({ file_path: `${n}.txt` })) },
      root
    );
    assert.match(out, /output truncated at \d+ KB of a \d+ KB file; pass offset:\d+ to continue/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
