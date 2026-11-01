import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-explore-oauth-only-'));
const overrides = {
  MIXDOG_HOME: dir,
  MIXDOG_DATA_DIR: dir,
  ANTHROPIC_OAUTH_CREDENTIALS_PATH: join(dir, 'anthropic.json'),
  MIXDOG_PATCH_NATIVE_PREWARM: '0',
};
const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, overrides);
test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});
writeFileSync(
  overrides.ANTHROPIC_OAUTH_CREDENTIALS_PATH,
  JSON.stringify({ claudeAiOauth: { accessToken: 'token', scopes: ['user:inference'], expiresAt: 0 } })
);
const route = { provider: 'anthropic-oauth', model: 'claude-test' };
writeFileSync(
  join(dir, 'mixdog-config.json'),
  JSON.stringify({ defaultsVersion: 2, agent: { agents: { explore: route }, enabledAgents: ['explore'] } })
);

const { loadConfig } = await import('../agent/orchestrator/config.mjs');
const { _withRegisteredProviderForTestAsync, getProvider } = await import(
  '../agent/orchestrator/providers/registry.mjs'
);
const { runExplore } = await import('./tool.mjs');

test('Explore uses its configured live OAuth model through the default secrets-less initialization path', async () => {
  const config = loadConfig({ secrets: false });
  assert.ok(Object.values(config.providers).every((entry) => !entry.enabled));
  assert.equal(config.providers['anthropic-oauth'].credentialProbeUnavailable, true);
  const requests = [];
  // Only the network boundary is fake; config loading, registry initialization,
  // route lookup and the explorer loop use their production paths.
  const live = {
    name: 'anthropic-oauth',
    async send(messages, model) {
      requests.push({ messages, model });
      return { content: 'OAuth answer', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  await _withRegisteredProviderForTestAsync('anthropic-oauth', live, async () => {
    const result = await runExplore({ query: 'where is the entry?' }, { cwd: dir });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(result.content[0].text, 'OAuth answer');
    assert.equal(getProvider('anthropic-oauth'), live);
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, route.model);
  assert.equal(requests[0].messages.find((message) => message.role === 'user').content, 'where is the entry?');
});
