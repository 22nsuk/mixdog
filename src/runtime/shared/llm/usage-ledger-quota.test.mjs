import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { quotaWindowSpanMs } from './usage-ledger-quota.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A five-hour window that opened at 13:00 and resets at 18:00.
const opened = new Date(2026, 8, 30, 13).getTime();
const resetAt = opened + 5 * HOUR;
const at = (hours, minutes = 0) => opened + hours * HOUR + minutes * MINUTE;

function store(t) {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  return ledger;
}
const reading = (ts, usedPct, extra = {}) => ({
  provider: 'anthropic-oauth',
  account: 'default',
  label: '5H',
  ts,
  usedPct,
  resetAt,
  ...extra,
});
// Unpriced models: the meter is split by tokens, which keeps shares exact.
const request = (ts, model, extra = {}) =>
  makeUsageRecord({
    ts,
    provider: 'anthropic-oauth',
    model,
    sessionId: 'session-a',
    sourceType: 'lead',
    inputTokens: 1000,
    outputTokens: 100,
    account: 'default',
    ...extra,
  });
const byModel = (history) => Object.fromEntries(history.models.map((row) => [row.model, row.consumed]));

test('a repeated reading extends its row and a drifting reset stays one window', (t) => {
  const ledger = store(t);
  ledger.recordQuota([reading(at(0, 30), 10), reading(at(0, 35), 10)]);
  ledger.recordQuota([reading(at(1), 20, { resetAt: resetAt + 30_000 }), reading(at(0, 50), 15)]);
  const rows = ledger.db.prepare('SELECT ts,seen_until,used_pct,reset_at FROM quota_samples ORDER BY ts').all();
  assert.deepEqual(
    rows.map((row) => [row.ts, row.seen_until, row.used_pct, row.reset_at]),
    [
      [at(0, 30), at(0, 35), 10, resetAt],
      [at(1), at(1), 20, resetAt],
    ],
    'the late 13:50 reading is ignored and the 30 s reset drift keeps the first reset'
  );
  assert.equal(quotaWindowSpanMs('7D Opus'), 7 * 24 * HOUR);
  assert.equal(quotaWindowSpanMs('M'), null);
});

test('the open window splits each rise over the requests behind it and forecasts the pace', async (t) => {
  const ledger = store(t);
  ledger.record([
    request(at(0, 10), 'model-a'),
    request(at(0, 40), 'model-a'),
    request(at(0, 50), 'model-b', { inputTokens: 3200 }),
    request(at(3, 30), 'model-b'),
    // Another account of the same subscription moves its own meter only.
    request(at(3, 40), 'model-a', { account: 'work', inputTokens: 90_000 }),
  ]);
  ledger.recordQuota([reading(at(0, 30), 10), reading(at(0, 35), 10)]);
  ledger.recordQuota([reading(at(1), 20)]);
  ledger.recordQuota([reading(at(2), 25)]);
  ledger.recordQuota([reading(at(3, 48), 40), reading(at(3, 48), 70, { account: 'work' })]);
  const history = await ledger.quotaHistoryAsync({ now: at(3, 48) });

  assert.deepEqual(history.selection, { provider: 'anthropic-oauth', account: 'default', label: '5H' });
  assert.deepEqual(
    history.subscriptions.map((row) => row.account),
    ['default', 'work']
  );
  assert.equal(history.period.fromMs, opened);
  assert.equal(history.period.toMs, resetAt);
  assert.equal(history.focus.usedPct, 40);
  assert.equal(history.focus.current, true);
  // 10 % before 13:30 is model-a's; 13:30→14:00 splits 1,100 : 3,300 tokens;
  // 14:00→15:00 had no Mixdog request; 15:00→16:48 is model-b's.
  assert.deepEqual(byModel(history), { 'model-a': 12.5, 'model-b': 22.5 });
  assert.equal(history.outside, 5);
  assert.equal(history.summary.consumed, 40);
  // The last hour rose from 31.7 % to 40 %: about 8.3 % an hour runs out after the reset.
  assert.equal(history.forecast.exhaustAt, null);
  assert.equal(history.forecast.ratePerHour, 8.33);
  assert.equal(history.forecast.atResetPct, 50);
  assert.equal(history.slotMs, 30 * MINUTE);
  assert.equal(history.slots.length, 10);
  // The unattributed 5 % spreads over the hour it rose in.
  assert.deepEqual(
    history.slots.filter((slot) => slot.outside > 0).map((slot) => [slot.fromMs, slot.outside]),
    [
      [at(1), 2.5],
      [at(1, 30), 2.5],
    ]
  );
  assert.equal(history.points[0][0], opened, 'the path opens at zero when the window opened');
  const listed = await ledger.quotaWindowsAsync({ now: at(3, 48) });
  assert.deepEqual(
    listed.windows.map((row) => row.current),
    [true]
  );
  assert.equal(listed.windows[0].peak, 40);
  assert.equal(listed.windows[0].tokens, history.totals.tokens, 'a listed window adds up what its own view does');
});

test('records made before accounts were recorded belong to the account in use when recording began', async (t) => {
  const ledger = store(t);
  ledger.record([
    // Written before records named an account.
    request(at(0, 10), 'model-a', { account: '' }),
    request(at(0, 20), 'model-a'),
    request(at(0, 40), 'model-b', { account: 'work' }),
  ]);
  ledger.recordQuota([reading(at(0, 50), 10), reading(at(0, 50), 10, { account: 'work' })]);
  const first = await ledger.quotaHistoryAsync({ now: at(1), account: 'default' });
  assert.equal(first.totals.turns, 2, 'the first account named keeps the older records');
  const other = await ledger.quotaHistoryAsync({ now: at(1), account: 'work' });
  assert.deepEqual(byModel(other), { 'model-b': 10 }, 'another account never counts them');
  assert.equal(other.totals.turns, 1);
});

test('windows reset, page and add up over a period', async (t) => {
  const ledger = store(t);
  const nextReset = resetAt + 5 * HOUR;
  ledger.record([request(at(0, 20), 'model-a'), request(at(5, 40), 'model-a')]);
  ledger.recordQuota([reading(at(0, 30), 10)]);
  ledger.recordQuota([reading(at(3), 100)]);
  ledger.recordQuota([reading(at(5, 45), 5, { resetAt: nextReset })]);
  const now = at(6);
  const latest = await ledger.quotaHistoryAsync({ now });
  assert.equal(latest.period.fromMs, resetAt, 'the second window opened when the first reset');
  assert.equal(latest.period.nextAnchor, null);
  const listed = await ledger.quotaWindowsAsync({ now });
  assert.deepEqual([listed.total, listed.pageCount], [2, 1]);
  assert.equal(listed.windows[1].exhaustedAt, at(3));
  assert.equal(listed.windows[1].peak, 100);

  const earlier = await ledger.quotaHistoryAsync({ now, anchor: latest.period.previousAnchor });
  assert.equal(earlier.period.toMs, resetAt);
  assert.equal(earlier.focus.current, false);
  assert.equal(earlier.focus.exhaustedAt, at(3));
  assert.equal(earlier.forecast, null);
  assert.deepEqual(earlier.points.slice(-2), [
    [resetAt, 100, 2],
    [resetAt, 0, 1],
  ]);

  const day = await ledger.quotaHistoryAsync({ now, view: 'hour', fromMs: now - 24 * HOUR, toMs: now });
  assert.equal(day.summary.maxedOut, 1);
  assert.equal(day.summary.consumed, 105);
  assert.deepEqual(
    day.peaks.map((row) => [row.peak, row.peakAt]),
    [
      [100, at(3)],
      [5, at(5, 45)],
    ]
  );
});

test('the window history pages newest first, each page reading its own windows', async (t) => {
  const ledger = store(t);
  // Twelve five-hour windows back to back, the n-th read once at n %.
  for (let index = 0; index < 12; index += 1) {
    const reset = resetAt + index * 5 * HOUR;
    ledger.recordQuota([reading(reset - 4 * HOUR, index + 1, { resetAt: reset })]);
  }
  ledger.record([request(at(0, 20), 'model-a')]);
  const now = resetAt + 11 * 5 * HOUR - HOUR;
  const first = await ledger.quotaWindowsAsync({ now });
  assert.deepEqual([first.page, first.pageCount, first.total], [0, 2, 12]);
  assert.deepEqual(
    first.windows.map((row) => row.peak),
    [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]
  );
  assert.equal(first.windows[0].current, true);
  const last = await ledger.quotaWindowsAsync({ now, page: 1 });
  assert.deepEqual(
    last.windows.map((row) => row.peak),
    [2, 1]
  );
  assert.equal(last.windows[1].tokens, 1100, 'the oldest window counts the request behind it');
  assert.equal((await ledger.quotaWindowsAsync({ now, page: 9 })).page, 1, 'a page past the end is the last');
});

test('an idle meter stays one row, and the subscription whose meter moved opens first', async (t) => {
  const ledger = store(t);
  // An idle window reads 0 % against a reset that moves with the clock.
  const idle = (ts) => ({
    provider: 'openai-oauth',
    account: 'default',
    label: '5H',
    ts,
    usedPct: 0,
    resetAt: ts + 5 * HOUR,
  });
  ledger.recordQuota([idle(at(0))]);
  ledger.recordQuota([reading(at(0, 30), 10)]);
  ledger.recordQuota([idle(at(1))]);
  ledger.recordQuota([idle(at(2))]);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) AS n FROM quota_samples WHERE provider='openai-oauth'").get().n, 1);
  const history = await ledger.quotaHistoryAsync({ now: at(2) });
  assert.equal(history.selection.provider, 'anthropic-oauth', 'measured last is not moved last');
  const codex = await ledger.quotaHistoryAsync({ now: at(2), provider: 'openai-oauth' });
  assert.equal(codex.period, null, 'an idle meter opened no window');
});

test('a subscription opens on its weekly window unless another was asked for', async (t) => {
  const ledger = store(t);
  const week = resetAt + 5 * 24 * HOUR;
  ledger.recordQuota([reading(at(0, 30), 10), reading(at(0, 30), 20, { label: '7D Opus', resetAt: week })]);
  ledger.recordQuota([reading(at(0, 30), 30, { label: '7D', resetAt: week })]);
  const opened = await ledger.quotaHistoryAsync({ now: at(1) });
  assert.deepEqual(opened.subscriptions[0].windows, ['5H', '7D', '7D Opus']);
  assert.equal(opened.selection.label, '7D');
  assert.equal((await ledger.quotaHistoryAsync({ now: at(1), label: '5H' })).selection.label, '5H');
});

test('a monthly window opens one calendar month before its reset', async (t) => {
  const ledger = store(t);
  const reset = new Date(2026, 9, 15).getTime();
  ledger.recordQuota([
    { provider: 'opencode-go', account: 'default', label: 'M', ts: at(0), usedPct: 12, resetAt: reset },
  ]);
  const history = await ledger.quotaHistoryAsync({ now: at(1) });
  assert.equal(history.period.fromMs, new Date(2026, 8, 15).getTime());
  assert.equal(history.focus.paced, true);
});

test('a file ledger records readings and reads history on its worker', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-quota-worker-'));
  const ledger = new UsageLedger(join(dir, 'ledger.sqlite'));
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  ledger.record([request(at(0, 20), 'model-a')]);
  await ledger.recordQuotaQueued([reading(at(0, 30), 10)]);
  const history = await ledger.quotaHistoryAsync({ now: at(1) });
  assert.deepEqual(byModel(history), { 'model-a': 10 });
  assert.equal(history.focus.usedPct, 10);
});

test('the statistics API names accounts and pages by view', async (t) => {
  const ledger = store(t);
  ledger.record([request(at(0, 20), 'model-a')]);
  ledger.recordQuota([reading(at(0, 30), 10)]);
  t.mock.method(Date, 'now', () => at(1));
  const api = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {},
    accountPool: () => ({ accounts: [{ id: 'default', label: 'Personal' }] }),
  });
  const history = await api.getQuotaHistory({});
  assert.equal(history.subscriptions[0].accountLabel, 'Personal');
  assert.deepEqual(
    history.models.map((row) => [row.model, row.consumed]),
    [['model-a', 10]]
  );
  const week = await api.getQuotaHistory({ view: '7d' });
  assert.equal(week.period.view, '7d');
  assert.equal(week.period.days, 7);
  assert.equal(week.summary.consumed, 10);
  const table = await api.getQuotaHistory({ page: 0 });
  assert.equal(table.selection.label, '5H');
  assert.deepEqual(
    table.windows.map((row) => row.peak),
    [10]
  );
  const empty = createUsageStatsApi({ ledger: () => store(t), importHistory: async () => {} });
  assert.equal((await empty.getQuotaHistory({})).selection, null);
  assert.equal((await empty.getQuotaHistory({ page: 0 })).total, 0);
});
