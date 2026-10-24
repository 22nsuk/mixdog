import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { __cursorModelInternals } from '../../../../src/runtime/agent/orchestrator/providers/cursor.mjs';
import { resolveRouteContextState } from '../../../../src/runtime/agent/orchestrator/runtime-core/route-context-state.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement', 'Event', 'KeyboardEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
window.HTMLElement.prototype.scrollIntoView = () => {};
window.mixdogDesktop = {
  async invokeCapability() {
    return { value: { autoEffort: { enabled: false, supported: false } } };
  },
};
after(restore);

const { createRoot } = await import('react-dom/client');
const { ModelRouteEditor } = await import('./ModelRouteEditor.tsx');
const { RouteChainEditor } = await import('./RouteChainEditor.tsx');

const opus = {
  provider: 'cursor-oauth',
  model: 'claude-opus-5-5',
  display: 'Claude Opus 5.5',
  contextWindow: 300_000,
  maxContextWindow: 1_000_000,
  effortOptions: ['high', 'medium'].map((value) => ({ value, label: value })),
  fastCapable: true,
  fastEfforts: ['high', 'medium'],
  defaultModelParameters: { context: '300k', thinking: 'true' },
  modelParameterOptions: [
    {
      id: 'context',
      label: 'Context',
      options: [
        { value: '300k', label: '300K' },
        { value: '1m', label: '1M' },
      ],
    },
    { id: 'thinking', label: 'Thinking', options: [{ value: 'true', label: 'On' }] },
  ],
};
const primary = { provider: 'openai', model: 'primary', effort: 'high' };
const primaryModel = { ...primary, display: 'Primary', effortOptions: [], fastCapable: false };
const route = {
  provider: opus.provider,
  model: opus.model,
  effort: 'high',
  fast: true,
  modelParameters: { context: '300k', thinking: 'true' },
  contextPercent: 30,
};

async function mount(t, { value = route, model = opus, chain = false, composerParity = true } = {}) {
  const changes = [];
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const onChange = (next) => changes.push(next);
  await act(async () =>
    root.render(
      chain
        ? React.createElement(RouteChainEditor, {
            route: { ...primary, fallbacks: [value] },
            models: [primaryModel, model],
            composerParity,
            disabled: false,
            label: 'Agent route',
            onChange,
          })
        : React.createElement(ModelRouteEditor, {
            value,
            models: [model],
            composerParity,
            onChange,
          })
    )
  );
  const triggers = host.querySelectorAll('.model-trigger');
  await act(async () => triggers[chain ? 1 : 0].click());
  return changes;
}

async function openPane(label) {
  const row = [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find((node) =>
    node.textContent.startsWith(label)
  );
  assert.ok(row, `${label} is available`);
  await act(async () => row.click());
}

async function changeContext(percent) {
  await openPane('Context');
  const slider = document.querySelector('input[type="range"][aria-label="Context"]');
  assert.ok(slider);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(slider, String(percent));
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () =>
    slider.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
  );
}

for (const chain of [false, true]) {
  for (const [percent, tokens, context] of [
    [100, 1_000_000, '1m'],
    [30, 300_000, '300k'],
  ]) {
    test(`${chain ? 'fallback' : 'primary'} context slider saves ${context} without a hidden context parameter`, async (t) => {
      const value = {
        ...route,
        contextPercent: percent === 100 ? 30 : 100,
        modelParameters: { context: percent === 100 ? '300k' : '1m', thinking: 'true' },
      };
      const changes = await mount(t, { value, chain });
      await changeContext(percent);
      assert.equal(changes.length, 1);
      const selection = chain ? changes[0].fallbacks[0] : changes[0];
      if (chain) {
        const { fallbacks, ...unchangedPrimary } = changes[0];
        assert.deepEqual(unchangedPrimary, primary);
        assert.equal(fallbacks.length, 1);
      }
      assert.equal(selection.contextPercent, percent);
      assert.deepEqual(selection.modelParameters, { thinking: 'true' });
      assert.equal(selection.effort, 'high');
      assert.equal(selection.fast, true);
      assert.equal('context' in value.modelParameters, true, 'editing does not mutate the original route');

      // Exercise the existing route-to-provider boundary without calling Cursor.
      const state = resolveRouteContextState(selection, opus);
      assert.equal(state.selectedContextWindow, tokens);
      const group = {
        id: opus.model,
        contextWindow: opus.contextWindow,
        supportsMaxMode: true,
        supportsNonMaxMode: true,
        effortParameterId: 'effort',
        definitions: [
          { id: 'context' },
          { id: 'thinking' },
          { id: 'effort', values: [{ value: 'high' }] },
          { id: 'fast' },
        ],
        variants: [
          {
            parameters: { context: '300k', thinking: 'true', effort: 'high', fast: 'true' },
            maxMode: false,
            defaultNonMax: true,
          },
          {
            parameters: { context: '1m', thinking: 'true', effort: 'high', fast: 'true' },
            maxMode: true,
            defaultMax: true,
          },
        ],
      };
      const selected = __cursorModelInternals.selectParameterizedCursorVariant(
        group,
        { baseId: opus.model },
        { ...selection, selectedContextWindow: state.selectedContextWindow }
      );
      assert.deepEqual(Object.fromEntries(selected.parameters.map(({ id, value }) => [id, value])), {
        context,
        thinking: 'true',
        effort: 'high',
        fast: 'true',
      });
      assert.equal(selected.maxMode, percent === 100);
    });
  }
}

test('editing effort repairs a slider route without discarding its exact token selection', async (t) => {
  const changes = await mount(t, { value: { ...route, contextPercent: 80, contextTokens: 750_000 } });
  await openPane('Reasoning effort');
  const medium = [...document.querySelectorAll('.route-sheet-option')].find((node) => node.textContent === 'medium');
  assert.ok(medium);
  await act(async () => medium.click());
  assert.equal(changes.length, 1);
  assert.equal(changes[0].contextPercent, 80);
  assert.equal(changes[0].contextTokens, 750_000);
  assert.equal(changes[0].effort, 'medium');
  assert.deepEqual(changes[0].modelParameters, { thinking: 'true' });
});

test('a context-only model emits an empty parameter map so an old context is cleared', async (t) => {
  const changes = await mount(t, {
    model: { ...opus, modelParameterOptions: opus.modelParameterOptions.slice(0, 1) },
    value: { ...route, modelParameters: { context: '300k' } },
  });
  await changeContext(100);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].contextPercent, 100);
  assert.deepEqual(changes[0].modelParameters, {});
});

for (const [name, composerParity, model] of [
  ['without composer parity', false, opus],
  ['without context-window metadata', true, { ...opus, contextWindow: 0, maxContextWindow: 0 }],
]) {
  test(`an explicit context parameter remains selectable ${name}`, async (t) => {
    const changes = await mount(t, { composerParity, model });
    await openPane('Context');
    assert.equal(document.querySelector('input[type="range"][aria-label="Context"]'), null);
    const oneMillion = [...document.querySelectorAll('.route-sheet-option')].find(
      (node) => node.textContent === '1M'
    );
    assert.ok(oneMillion);
    await act(async () => oneMillion.click());
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0].modelParameters, { context: '1m', thinking: 'true' });
  });
}
