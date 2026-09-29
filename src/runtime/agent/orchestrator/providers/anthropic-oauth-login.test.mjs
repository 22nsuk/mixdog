import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'anthropic-login-'));
process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = join(dir, 'credentials.json');
const { beginOAuthLogin } = await import('./anthropic-oauth-credentials.mjs');

test('a callback request with a bad state is rejected without ending the pending login', async () => {
  let opened = null;
  const login = await beginOAuthLogin({ openBrowserFn: async (url) => (opened = url) });
  for (let i = 0; i < 50 && !opened; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  let settled = false;
  login.waitForCallback.then(() => {
    settled = true;
  });
  try {
    assert.ok(opened, 'the login URL is opened through the injected opener');
    const base = 'http://localhost:54545/callback';
    const wrongState = await fetch(`${base}?code=abc&state=wrong`);
    assert.equal(wrongState.status, 400);
    const noCode = await fetch(`${base}?state=wrong`);
    assert.equal(noCode.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
  } finally {
    login.cancel();
  }
  assert.equal(await login.waitForCallback, null);
});
