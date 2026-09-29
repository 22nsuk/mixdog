import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  authArtifactNamesForSandbox,
  copyAuthArtifacts,
  extractSessionId,
  readUnifiedConfig,
} from './bench-sandbox.mjs';

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-sandbox-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('extractSessionId prefers the labelled id, then any sess_ token', () => {
  assert.equal(extractSessionId('sessionId: sess_abc123 other sess_zzz'), 'sess_abc123');
  assert.equal(extractSessionId('noise sess_q9 end'), 'sess_q9');
  assert.equal(extractSessionId('nothing here'), null);
  assert.equal(extractSessionId(undefined), null);
});

test('readUnifiedConfig returns an object, and {} for a missing or non-object file', () => {
  withDir((dir) => {
    assert.deepEqual(readUnifiedConfig(dir), {});
    writeFileSync(join(dir, 'mixdog-config.json'), '{"a":1}');
    assert.deepEqual(readUnifiedConfig(dir), { a: 1 });
    writeFileSync(join(dir, 'mixdog-config.json'), 'null');
    assert.deepEqual(readUnifiedConfig(dir), {});
  });
});

test('auth artifacts: provider files plus every oauth/credentials json in the real dir', () => {
  withDir((real) => {
    writeFileSync(join(real, 'grok-oauth.json'), 'g');
    writeFileSync(join(real, 'extra-credentials.json'), 'c');
    writeFileSync(join(real, 'unrelated.json'), 'u');
    const names = authArtifactNamesForSandbox(real, 'grok-oauth').sort();
    assert.deepEqual(names, ['extra-credentials.json', 'grok-oauth-models.json', 'grok-oauth.json']);
    const sandbox = join(real, 'sandbox');
    mkdirSync(sandbox);
    const { copied, skipped } = copyAuthArtifacts(real, sandbox, 'grok-oauth');
    assert.deepEqual(copied.sort(), ['extra-credentials.json', 'grok-oauth.json']);
    assert.deepEqual(skipped, ['grok-oauth-models.json']);
    assert.equal(readFileSync(join(sandbox, 'grok-oauth.json'), 'utf8'), 'g');
    assert.equal(existsSync(join(sandbox, 'unrelated.json')), false);
  });
});
