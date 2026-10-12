import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { RouteDiagnostics } from './RouteDiagnostics.tsx';
import { captureRouteDiagnostics } from '../../../../src/runtime/shared/route-diagnostics.mjs';
import { inspectRouteDiagnostics } from '../../../../src/runtime/agent/orchestrator/runtime-core/route-diagnostics.mjs';
import { t } from './i18n.ts';

function fixture() {
  const session = { id: 's1', provider: 'custom-test', model: 'old-model', effort: 'high', autoEffort: true };
  const receipt = captureRouteDiagnostics(session, { at: 1700000000000, turnEffort: 'high',
    decision: { mode: 'observe', source: 'environment', reason: 'observe-only', selectedEffort: 'low', applied: false } });
  session.model = 'new-model';
  session.autoEffort = false;
  session.messages = [{ role: 'user', content: 'secret-prompt', meta: { routeDiagnostics: receipt } }];
  return inspectRouteDiagnostics(session);
}
const render = (props) => JSDOM.fragment(renderToStaticMarkup(React.createElement(RouteDiagnostics, { sessionId: 's1', ...props })));

test('the disclosure separates current route, recorded turn, observation and host support', () => {
  const dom = render({ value: fixture(), routeAutoEffort: false });
  assert.equal(dom.querySelector('details').hasAttribute('open'), false);
  assert.ok(dom.querySelector('summary'));
  const sections = [...dom.querySelectorAll('section')];
  assert.match(sections[0].textContent, /new-model/);
  assert.doesNotMatch(sections[0].textContent, /old-model/);
  assert.match(sections[1].textContent, /old-model/);
  assert.doesNotMatch(sections[1].textContent, /new-model/);
  assert.match(dom.textContent, /runtime-prepared-not-provider-confirmed/);
  assert.match(dom.textContent, /observe-only/);
  assert.ok(dom.textContent.includes(t('Unavailable')));
  assert.doesNotMatch(dom.textContent, /secret-prompt/);
});

for (const [name, value] of [
  ['old host', undefined], ['future host', { ...fixture(), version: 2 }],
  ['different session', { ...fixture(), sessionId: 's2' }], ['malformed', { version: 1, current: [] }],
]) {
  test(`${name} is unavailable, never guessed from an older response`, () => {
    const dom = render({ value });
    assert.match(dom.textContent, /route-diagnostics-unavailable/);
    assert.doesNotMatch(dom.textContent, /old-model|new-model|observe-only/);
  });
}

test('unknown reasons, parameters, injected markup and raw errors never enter the report', () => {
  const data = fixture();
  data.apiKey = 'secret-key';
  data.current.modelParameters = { authorization: 'secret-key' };
  data.lastTurn.auto.reason = 'secret-key';
  data.lastTurn.auto.judge = 'raw-error-body';
  data.current.model = '<img src=x onerror=alert(1)>';
  const dom = render({ value: data });
  assert.equal(dom.querySelector('img'), null);
  assert.doesNotMatch(dom.textContent, /secret-key|raw-error-body/);
});

test('loading a different session hides the old diagnostic disclosure', () => {
  assert.equal(renderToStaticMarkup(React.createElement(RouteDiagnostics, { value: fixture(), sessionId: 's1', loading: true })), '');
});
