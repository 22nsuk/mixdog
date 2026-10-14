import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { DelegationObservations } from './DelegationObservations.tsx';
import { ContextBody } from './ContextBody.tsx';
import { t } from './i18n.ts';

const job = (id, mode, patch = {}) => ({
  task_id: id,
  type: 'spawn',
  tag: '<script>unsafe</script>',
  agent: 'worker',
  provider: 'p',
  model: 'm',
  startedAt: '2026-10-14T00:00:00.000Z',
  delegation: {
    version: 1,
    callerSessionId: 'lead',
    mode,
    phase: 'finished',
    outcome: 'completed',
    queueWaitMs: 0,
    preparationMs: 10,
    elapsedMs: 1200,
    inputTokens: null,
    outputTokens: 0,
    toolCalls: 2,
    ...patch,
  },
});
const doc = (jobs) =>
  new JSDOM(renderToStaticMarkup(React.createElement(DelegationObservations, { jobs, sessionId: 'lead' }))).window
    .document;

test('read-only context observations show all modes, outcomes and unknown usage without unsafe markup', () => {
  const document = doc([
    job('a', 'focused'),
    job('b', 'balanced', { outcome: 'failed' }),
    job('c', 'swarm', { outcome: 'partial' }),
  ]);
  assert.equal(document.querySelectorAll('article').length, 3);
  assert.equal(document.querySelectorAll('script').length, 0);
  assert.equal(document.querySelectorAll('input,select').length, 0);
  for (const label of ['Assisted', 'Collaborative', 'Swarm', 'Failed', 'Partial handoff'])
    assert.ok(document.body.textContent.includes(t(label)));
  const figures = [...document.querySelector('dl').querySelectorAll('div')].map((node) => [
    node.querySelector('dt').textContent,
    node.querySelector('dd').textContent,
  ]);
  assert.deepEqual(
    figures.find(([label]) => label === t('Input')),
    [t('Input'), '—']
  );
  assert.deepEqual(
    figures.find(([label]) => label === t('Output')),
    [t('Output'), '0']
  );
});

test('no history/old hosts are explained and legacy jobs are not mislabeled by the current mode', () => {
  assert.ok(doc(undefined).body.textContent.includes(t('Observation data unavailable.')));
  assert.ok(doc([]).body.textContent.includes(t('No observed jobs in this snapshot.')));
  const document = doc([{ task_id: 'old' }, job('unknown', null)]);
  assert.ok(document.body.textContent.includes(t('Unknown')));
  assert.equal(document.querySelectorAll('article').length, 1);
  assert.ok(document.body.textContent.includes(t('Jobs without observation data: {{total}}.', { total: 1 })));
});

test('context body wires the session-scoped snapshot and does not show sibling measurements', () => {
  const html = renderToStaticMarkup(
    React.createElement(ContextBody, {
      status: {},
      snapshot: {
        sessionId: 'lead',
        agentJobs: [job('own', 'focused'), job('other', 'swarm', { callerSessionId: 'other' })],
      },
    })
  );
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll('[data-task-id="own"]').length, 1);
  assert.equal(document.querySelectorAll('[data-task-id="other"]').length, 0);
});

test('long histories are paged rather than mounting every retained job', () => {
  const document = doc(Array.from({ length: 80 }, (_, i) => job(String(i), 'swarm')));
  assert.equal(document.querySelectorAll('article').length, 25);
  assert.equal(document.querySelector('button').textContent, t('Show more'));
  assert.equal(document.querySelector('details').hasAttribute('open'), false);
});

test('show more expands history, and changing the displayed session resets its page', async () => {
  const dom = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const root = createRoot(document.getElementById('root'));
  const jobs = Array.from({ length: 60 }, (_, i) => job(String(i), 'swarm'));
  try {
    await act(async () =>
      root.render(React.createElement(ContextBody, { status: {}, snapshot: { sessionId: 'lead', agentJobs: jobs } }))
    );
    assert.equal(document.querySelectorAll('.delegation-observation').length, 25);
    await act(async () => document.querySelector('.delegation-observations-more button').click());
    assert.equal(document.querySelectorAll('.delegation-observation').length, 50);
    const otherJobs = jobs.map((job) => ({ ...job, delegation: { ...job.delegation, callerSessionId: 'other' } }));
    await act(async () =>
      root.render(
        React.createElement(ContextBody, { status: {}, snapshot: { sessionId: 'other', agentJobs: otherJobs } })
      )
    );
    assert.equal(document.querySelectorAll('.delegation-observation').length, 25);
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});
