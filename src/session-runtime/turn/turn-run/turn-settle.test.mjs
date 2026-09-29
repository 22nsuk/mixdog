import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnSettlement } from './turn-settle.mjs';

function errorTypeFor(message) {
  const dispatched = [];
  const { reportTurnError } = createTurnSettlement({
    getSession: () => ({ id: 's' }),
    hooks: { emit() {}, dispatch: (name, payload) => dispatched.push([name, payload]) },
    hookCommonPayload: (payload) => payload,
  });
  reportTurnError({ startedAt: Date.now() }, new Error(message));
  return dispatched[0][1].error_type;
}

test('StopFailure error types match status codes only as whole tokens', () => {
  assert.equal(errorTypeFor('context of 1500 tokens exceeded'), 'unknown');
  assert.equal(errorTypeFor('id 14290 not found'), 'unknown');
  assert.equal(errorTypeFor('HTTP 503 service unavailable'), 'server_error');
  assert.equal(errorTypeFor('status 429'), 'rate_limit');
  assert.equal(errorTypeFor('status 401'), 'authentication_failed');
});
