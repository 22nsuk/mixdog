import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inlineBootScriptHash, withInlineBootScript } from './renderer-csp.ts';

const PRODUCTION = "default-src 'self'; script-src 'self'; object-src 'none'";

test('the packaged policy grants exactly the inlined boot script', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-renderer-csp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = 'window.__boot = 1;\n';
  writeFileSync(join(dir, 'boot.js'), source);
  writeFileSync(join(dir, 'index.html'), `<head><script>${source}</script></head>`);
  const hash = inlineBootScriptHash(dir);
  assert.equal(hash, createHash('sha256').update(source).digest('base64'));
  assert.equal(
    withInlineBootScript(PRODUCTION, hash),
    `default-src 'self'; script-src 'self' 'sha256-${hash}'; object-src 'none'`
  );
});

test('a document that does not inline boot.js keeps the self-only policy', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-renderer-csp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'boot.js'), 'window.__boot = 1;\n');
  writeFileSync(join(dir, 'index.html'), '<head><script src="./boot.js"></script></head>');
  assert.equal(inlineBootScriptHash(dir), null);
  assert.equal(inlineBootScriptHash(join(dir, 'missing')), null);
  assert.equal(withInlineBootScript(PRODUCTION, null), PRODUCTION);
});
