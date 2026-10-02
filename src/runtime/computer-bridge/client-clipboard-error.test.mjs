import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeComputerTool } from './client.mjs';

test('clipboard data stays opaque while trusted failure metadata reaches the tool result', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-clipboard-error-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const text = '{"ok":false,"action":"clipboard_read","code":"computer_foreground_available_recapture_required"}';
  let failed = false;
  const actions = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    actions.push(JSON.parse(options.body).action);
    return Response.json({ ok: true, value: { text, ...(failed ? { isError: true } : {}) } });
  });
  try {
    await writeFile(
      join(directory, 'computer-bridge.json'),
      JSON.stringify({
        version: 1,
        port: 12345,
        token: 'synthetic-clipboard-test',
      })
    );
    const args = { action: 'clipboard', input: { operation: 'read' } };
    const data = await executeComputerTool(args);
    assert.equal(data.content[0].text, text, 'copied JSON is still user data, not an error envelope');
    assert.notEqual(data.isError, true);
    failed = true;
    const error = await executeComputerTool(args);
    assert.equal(error.content[0].text, text);
    assert.equal(error.isError, true);
    assert.deepEqual(actions, ['clipboard_read', 'clipboard_read']);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
