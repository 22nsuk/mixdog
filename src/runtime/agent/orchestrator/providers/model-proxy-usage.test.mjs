import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previous = process.env.MIXDOG_DATA_DIR;
const directory = mkdtempSync(join(tmpdir(), 'mixdog-proxy-usage-'));
process.env.MIXDOG_DATA_DIR = directory;
const previousLedger = process.env.MIXDOG_USAGE_LEDGER_PATH;
process.env.MIXDOG_USAGE_LEDGER_PATH = join(directory, 'ledger.sqlite');
const { createModelProxyUsage } = await import('./model-proxy-usage-host.mjs');
const { readRemoteOAuthUsage } = await import('./model-proxy-usage.mjs');
const { ModelProxyChannel, installModelProxyChannel, encodeModelProxyWire } = await import('./model-proxy-channel.mjs');
const { fetchOAuthUsageSnapshot, readCachedOAuthUsageSnapshot } = await import('./oauth-usage.mjs');
const { createUsageStatsApi } = await import('../../../../session-runtime/usage-stats-api.mjs');
const { getUsageLedger, closeUsageLedgers, makeUsageRecord } = await import('../../../shared/llm/usage-ledger.mjs');
const { accountProviderSend } = await import('../../../shared/llm/usage-accounting.mjs');
const { ModelProxyProvider } = await import('./model-proxy-provider.mjs');

after(async () => {
  await closeUsageLedgers();
  if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previous;
  if (previousLedger === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
  else process.env.MIXDOG_USAGE_LEDGER_PATH = previousLedger;
  rmSync(directory, { recursive: true, force: true });
});

function fixture(owner = 'desktop-one') {
  const state = { identity: 'person-a@example.com', selectedId: 'default', measuredAt: Date.now() - 1000, gate: null };
  const calls = [];
  const usage = createModelProxyUsage({
    owner: () => owner,
    accounts: () => ({
      selectedId: state.selectedId,
      accounts: [
        { id: 'default', identity: state.identity, authenticated: true },
        { id: '11111111-1111-1111-1111-111111111111', identity: 'other@example.com', authenticated: true },
      ],
    }),
    fetchUsage: async (route, provider) => {
      calls.push({ route, provider });
      await state.gate;
      return {
        cachedAt: state.measuredAt,
        raw: { access_token: 'SECRET' },
        email: state.identity,
        resetCredits: { availableCredits: ['private-offer'] },
        quotaWindows: [{ label: '5H', usedPct: 38, resetAt: state.measuredAt + 3600000, secret: 'SECRET' }],
      };
    },
  });
  const provider = { forAccount: (id) => ({ id, getUsageSnapshot() {} }) };
  return { usage, state, provider, calls };
}

test('desktop usage preserves observation time and isolates identities without exporting personal data', async () => {
  const f = fixture();
  const a = await f.usage.snapshot('openai-oauth', f.provider);
  assert.equal(a.status, 'ready');
  assert.equal(a.snapshot.cachedAt, f.state.measuredAt);
  assert.deepEqual(Object.keys(a.snapshot).sort(), ['accountId', 'cachedAt', 'provider', 'quotaWindows', 'source']);
  assert.equal(JSON.stringify(a).includes('SECRET'), false);
  assert.equal(JSON.stringify(a).includes('@'), false);
  assert.equal(f.calls[0].provider.id, 'default');
  assert.deepEqual(await f.usage.snapshot('openai-oauth', f.provider), a);
  assert.equal(f.calls.length, 1, 'cache rereads do not poll the provider');
  f.state.identity = 'replacement@example.com';
  const b = await f.usage.snapshot('openai-oauth', f.provider, { force: true });
  assert.notEqual(a.account, b.account, 'replacing a default credential changes its scope');
  assert.equal(f.calls.length, 2);
  const other = fixture('desktop-two');
  assert.notEqual((await other.usage.snapshot('openai-oauth', other.provider)).account, a.account);
  assert.equal((await f.usage.snapshot('cursor-oauth', f.provider)).status, 'ready');
  assert.equal((await f.usage.snapshot('mimo-oauth', f.provider)).status, 'unsupported');
  f.state.identity = null;
  assert.equal((await f.usage.snapshot('openai-oauth', f.provider)).status, 'unavailable');
  const anonymous = createModelProxyUsage({
    owner: () => 'desktop',
    accounts: () => ({
      selectedId: '11111111-1111-1111-1111-111111111111',
      accounts: [{ id: '11111111-1111-1111-1111-111111111111', authenticated: true }],
    }),
  });
  assert.equal(
    (await anonymous.snapshot('openai-oauth', f.provider)).status,
    'unavailable',
    'a named roster slot without provider identity is not proof of account ownership'
  );
});

test('a credential change during a desktop quota fetch retires its answer', async () => {
  const f = fixture();
  const gate = Promise.withResolvers();
  f.state.gate = gate.promise;
  const reading = f.usage.snapshot('openai-oauth', f.provider);
  f.state.selectedId = '11111111-1111-1111-1111-111111111111';
  gate.resolve();
  assert.deepEqual(await reading, { status: 'unavailable' });
});

test('desktop quota polling uses the real OAuth normalizers without forwarding auth or recording locally', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, method: options?.method || 'GET' });
    return Response.json(
      url.includes('reset-credits')
        ? {}
        : {
            rate_limit: { primary_window: { used_percent: 42, reset_at: Math.floor(Date.now() / 1000) + 3600 } },
          }
    );
  });
  const usage = createModelProxyUsage({
    owner: () => 'real-path',
    accounts: () => ({
      selectedId: 'default',
      accounts: [{ id: 'default', identity: 'private-subject', authenticated: true }],
    }),
  });
  const openai = await usage.snapshot('openai-oauth', {
    ensureAuth: async () => ({ accessToken: 'fake-secret', accountId: 'private-account' }),
  });
  assert.equal(openai.status, 'ready');
  assert.equal(openai.snapshot.quotaWindows[0].usedPct, 42);
  assert.equal(JSON.stringify(openai).includes('private'), false);
  assert.equal(JSON.stringify(openai).includes('fake-secret'), false);
  assert.ok(requests.every((row) => row.method === 'GET'));
  assert.equal(requests.length, 2, 'quota and reset-credit reads only; no redemption');
  const cursor = await usage.snapshot('cursor-oauth', {
    getUsageSnapshot: async () => ({
      quotaWindows: [{ label: 'Month', usedPct: 12, resetAt: Date.now() + 3600000 }],
    }),
  });
  assert.equal(cursor.status, 'ready');
  assert.equal(cursor.snapshot.quotaWindows[0].usedPct, 12);
});

test('SSH OAuth observations, request attribution, history, account switches and reconnects share one scope', async (t) => {
  const beforeMode = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    if (beforeMode === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = beforeMode;
  });
  const channel = new ModelProxyChannel();
  writeFileSync(
    join(directory, 'gateway-oauth-usage-cache.json'),
    JSON.stringify({
      routes: {
        'openai-oauth': { cachedAt: Date.now(), quotaWindows: [{ label: '5H', usedPct: 99 }] },
      },
    })
  );
  assert.equal(
    readCachedOAuthUsageSnapshot({ provider: 'openai-oauth' }, { allowStale: true }),
    null,
    'a stale WSL credential cache never supplies desktop quota'
  );
  t.after(installModelProxyChannel(channel));
  let f = fixture();
  let held = null;
  const attach = () =>
    channel.attachPublisher(({ requests }) => {
      for (const { id } of requests) {
        const claimed = channel.claim(id);
        if (!claimed) continue;
        const call = JSON.parse(claimed.payload);
        void (async () => {
          const value =
            call.method === 'providerConfig'
              ? { ready: true, providers: { 'openai-oauth': { enabled: true } } }
              : await f.usage.snapshot(call.provider, f.provider, { force: call.force });
          if (held && call.method === 'oauthUsage') {
            held.received.resolve();
            await held.release.promise;
          }
          channel.resolve(id, true, encodeModelProxyWire(value));
        })();
      }
    });
  let detach = attach();
  t.after(() => detach());
  const api = createUsageStatsApi({
    accountPool: () => {
      throw new Error('must not read WSL accounts');
    },
  });
  const first = await api.getQuotaHistory();
  assert.equal(first.desktopUsageStatus, 'ready');
  const accountA = first.selection.account;
  assert.equal(first.subscriptions.length, 1);
  const ledger = getUsageLedger();
  ledger.record([
    makeUsageRecord({
      ts: f.state.measuredAt - 100,
      provider: 'openai-oauth',
      model: 'old-unattributed',
      inputTokens: 900,
      outputTokens: 100,
      sessionId: 'legacy',
    }),
  ]);
  assert.equal(
    (await api.getQuotaHistory()).models.some((row) => row.model === 'old-unattributed'),
    false,
    'pre-fix requests without desktop identity must not be reassigned'
  );
  const query = () => ledger.db.prepare('SELECT * FROM quota_samples ORDER BY account').all();
  const original = query();
  assert.equal((await fetchOAuthUsageSnapshot({ provider: 'openai-oauth' }, {})).accountId, accountA);
  assert.deepEqual(query(), original, 'cached measurement must not extend seen_until');

  const proxy = new ModelProxyProvider('openai-oauth', {}, channel);
  await accountProviderSend(
    'openai-oauth',
    proxy,
    async () => ({
      usage: { inputTokens: 9, outputTokens: 3 },
      modelProxyUsageAccount: accountA,
    }),
    'review-model',
    { sessionId: 'remote-request' }
  );
  const recorded = ledger.db
    .prepare(
      "SELECT json_extract(r.signature,'$[8]') AS account FROM usage_events e JOIN usage_routes r ON r.id=e.route JOIN usage_sessions s ON s.id=e.session WHERE s.value='remote-request'"
    )
    .get();
  assert.equal(recorded.account, accountA, 'request belongs to the desktop account, not local default');
  assert.equal(proxy.usageAccountId({}), 'proxy-unattributed');

  f.state.selectedId = '11111111-1111-1111-1111-111111111111';
  f.state.measuredAt += 1;
  const next = await api.getQuotaHistory({ account: accountA });
  const accountB = next.selection.account;
  assert.notEqual(accountB, accountA);
  assert.deepEqual(
    next.subscriptions.map((row) => row.account),
    [accountB]
  );
  assert.equal((await api.getQuotaHistory({ page: 0, account: accountA })).selection.account, accountB);
  assert.equal(query().length, 2, 'old account history is retained, not relabelled');
  f.state.selectedId = 'default';
  assert.equal((await api.getQuotaHistory()).selection.account, accountA);

  held = { received: Promise.withResolvers(), release: Promise.withResolvers() };
  const pending = readRemoteOAuthUsage('openai-oauth', { force: true });
  await held.received.promise;
  detach();
  const offline = await api.getQuotaHistory();
  assert.equal(offline.desktopUsageStatus, 'unavailable');
  assert.deepEqual(offline.subscriptions, []);
  const release = held.release;
  f = fixture('another-desktop');
  held = null;
  detach = attach();
  release.resolve();
  assert.equal((await pending).status, 'unavailable');
  const reconnected = await api.getQuotaHistory();
  assert.notEqual(reconnected.selection.account, accountA);
  assert.notEqual(reconnected.selection.account, accountB);
  assert.equal(reconnected.subscriptions.length, 1);
});
