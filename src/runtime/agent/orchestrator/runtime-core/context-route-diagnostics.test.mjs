import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextStatus } from './context-status.mjs';
import { captureRouteDiagnostics } from '../../../shared/route-diagnostics.mjs';

function fixture() {
  const session = {
    id: 'diagnostic-session', provider: 'openai', model: 'test', effort: 'high',
    contextWindow: 10000, tools: [], messages: [],
  };
  const receipt = captureRouteDiagnostics(session, {
    at: 1700000000000, turnEffort: 'medium',
    decision: { mode: 'on', source: 'built-in', reason: 'selected', selectedEffort: 'medium', applied: true },
  });
  session.messages.push({ role: 'user', content: 'question', meta: { routeDiagnostics: receipt } });
  const api = createContextStatus({
    getSession: () => session, getRoute: () => session,
    getCurrentCwd: () => process.cwd(), getMode: () => 'default',
  });
  return { session, api, receipt };
}

test('ordinary context polls stay unchanged; inspection adds fresh route evidence outside the token cache', () => {
  const { session, api, receipt } = fixture();
  const ordinary = api.contextStatus();
  assert.equal(Object.hasOwn(ordinary, 'routeDiagnostics'), false);
  const first = api.contextStatus({ inspect: true });
  assert.equal(first.routeDiagnostics.lastTurn.preparedEffort, 'medium');
  session.autoEffort = false;
  const second = api.contextStatus({ inspect: true });
  assert.equal(second.routeDiagnostics.current.autoEffort, false);
  assert.equal(second.routeDiagnostics.lastTurn.configured.autoEffort, true);
  assert.equal(first.routeDiagnostics.current.autoEffort, true, 'old response is not mutated');
  assert.equal(receipt.configured.autoEffort, true);
  assert.equal(second.usedTokens, first.usedTokens);
  assert.equal(Object.hasOwn(api.contextStatus(), 'routeDiagnostics'), false);
});

test('a new unrecorded live turn cannot borrow diagnostics from the previous turn', () => {
  const { session, api } = fixture();
  api.contextStatus({ inspect: true });
  session.liveTurnMessages = [...session.messages, { role: 'user', content: 'new request' }];
  assert.equal(api.contextStatus({ inspect: true }).routeDiagnostics.lastTurn, null);
});

test('an entry preview never receives a current-route receipt beside a retained context revision', () => {
  const { api } = fixture();
  const status = api.contextStatus({ inspect: true });
  const entry = status.inspection.entries[0];
  assert.ok(entry, 'fixture has an inspectable message');
  const preview = api.contextStatus({ inspect: true, entryId: entry.id, revision: status.inspection.revision });
  assert.equal(Object.hasOwn(preview, 'routeDiagnostics'), false);
});

test('a draft has current route data but never fabricates a past execution', () => {
  const api = createContextStatus({
    getSession: () => null,
    getRoute: () => ({ provider: 'openai', model: 'test', effort: 'high', autoEffort: false, contextWindow: 10000 }),
    getCurrentCwd: () => process.cwd(), getMode: () => 'default',
  });
  const status = api.contextStatus({ inspect: true });
  assert.equal(status.routeDiagnostics.currentSource, 'route');
  assert.equal(status.routeDiagnostics.current.autoEffort, false);
  assert.equal(status.routeDiagnostics.lastTurn, null);
});
