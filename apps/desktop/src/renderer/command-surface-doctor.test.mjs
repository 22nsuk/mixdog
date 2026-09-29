import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { DoctorBody, doctorReport } from './command-surface-doctor.tsx';

const result = {
  summary: { ok: 1, warn: 1, fail: 1 },
  checks: [
    { id: 'mixdog', label: 'mixdog', level: 'ok', detail: 'v1.0.0 · up to date' },
    { id: 'mcp', label: 'mcp', level: 'warn', detail: '0/1 connected', fix: { command: '/mcp' } },
    { id: 'node', label: 'node', level: 'fail', detail: 'v20.0.0', fix: { hint: 'install Node.js ^22.19.0' } },
  ],
};

test('doctor report parsing puts problems first and rejects non-reports', () => {
  const report = doctorReport(result);
  assert.deepEqual(
    report.checks.map((check) => [check.id, check.level]),
    [
      ['node', 'fail'],
      ['mcp', 'warn'],
      ['mixdog', 'ok'],
    ]
  );
  assert.deepEqual(report.summary, { ok: 1, warn: 1, fail: 1 });
  assert.equal(doctorReport('old text report'), null);
  assert.equal(doctorReport(undefined), null);
  assert.deepEqual(doctorReport({ busy: true }).busy, true);
});

test('doctor dialog shows the verdict, per-check fixes, busy state and re-run', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  const opened = [];
  let reruns = 0;
  const render = (value, running = false) =>
    act(async () => {
      root.render(
        React.createElement(DoctorBody, {
          value,
          running,
          onRerun: () => {
            reruns += 1;
          },
          onOpenSettings: (section) => opened.push(section),
        })
      );
    });
  try {
    await render(result);
    assert.equal(container.querySelector('.doctor-surface-summary').dataset.level, 'fail');
    const rows = [...container.querySelectorAll('.doctor-check')];
    assert.deepEqual(
      rows.map((row) => row.dataset.level),
      ['fail', 'warn', 'ok']
    );
    assert.match(rows[0].textContent, /install Node\.js \^22\.19\.0/);
    assert.equal(rows[0].querySelector('.doctor-check-fix'), null);
    assert.equal(rows[2].querySelector('.doctor-check-fix'), null);
    await act(async () => rows[1].querySelector('.doctor-check-fix').click());
    assert.deepEqual(opened, ['mcp']);
    await act(async () => container.querySelector('.doctor-surface-actions button').click());
    assert.equal(reruns, 1);

    await render(result, true);
    assert.equal(container.querySelector('.doctor-surface-actions button').disabled, true);

    await render({ busy: true });
    assert.equal(container.querySelector('.doctor-check'), null);
    assert.match(container.textContent, /Another command is running/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
