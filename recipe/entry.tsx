import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentProfilePane } from '__RENDERER__/AgentProfilePane';
import '@fontsource-variable/jetbrains-mono';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '__RENDERER__/ui/tokens.css';
import '__RENDERER__/styles.css';
import '__RENDERER__/font-faces.css';
import '__RENDERER__/desktop.css';
import '__RENDERER__/pane-layout.css';
import '__RENDERER__/routines.css';
const query = new URLSearchParams(location.search);
const scenario = query.get('scenario');
const contextModel = {
  provider: 'cursor-oauth', model: 'claude-opus-5-5', display: 'Claude Opus 5.5',
  effortOptions: [{ value: 'high', label: 'High' }], fastCapable: true, fastEfforts: ['high'],
  contextWindow: 300_000, maxContextWindow: 1_000_000,
  defaultModelParameters: { context: '300k' },
  modelParameterOptions: [{ id: 'context', label: 'Context', options: [{ value: '300k', label: '300K' }, { value: '1m', label: '1M' }] }],
};
const definition = {
  id: 'context-fixture', name: 'GitHub watcher', description: 'Summarizes new issues and pull requests.',
  avatar: { kind: 'mascot', species: 'shepherd', accessory: 'collar', expression: 'calm', color: '#5b9bff' },
  route: {
    provider: contextModel.provider, model: contextModel.model, effort: 'high', fast: false,
    modelParameters: { context: '300k' },
    ...(scenario === 'saved' ? { contextPercent: 80, contextTokens: 750_000 } : { contextPercent: 30 }),
  },
  persona: '', body: 'Summarize issues and pull requests.', disabled: false,
};
const calls: unknown[] = [];
const api = {
  invokeCapability: async ({ capability, args }: { capability: string; args: unknown[] }) => {
    calls.push([capability, args]);
    if (capability === 'getAgentDefinition') return { value: definition };
    if (['getAgentConnectors', 'getAgentPermissions', 'getAgentAlwaysAllowedTools'].includes(capability)) return { value: [] };
    throw new Error(`Unexpected API call: ${capability}`);
  },
};
createRoot(document.getElementById('root')!).render(
  <div className="agent-panel" style={{ width: 500, height: 820, margin: '20px auto', border: '1px solid var(--mx-border)', background: 'var(--mx-sheet-surface, var(--mx-bg-deep))' }}>
    <div className="agent-panel-view"><AgentProfilePane sessionId="sess_home_context-fixture" active api={api as never} models={[contextModel]} /></div>
  </div>
);
const waitFor = async (fn: () => unknown) => {
  const end = performance.now() + 10_000;
  while (!fn()) { if (performance.now() > end) throw new Error('Fixture timed out'); await new Promise(requestAnimationFrame); }
};
(window as any).runCapture = async () => {
  await waitFor(() => document.querySelector('.agent-profile .model-trigger'));
  await document.fonts.ready;
  (document.querySelector('.agent-profile .model-trigger') as HTMLButtonElement).click();
  await waitFor(() => [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find(row => row.textContent?.startsWith('Context')));
  ([...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find(row => row.textContent?.startsWith('Context')) as HTMLButtonElement).click();
  await waitFor(() => document.querySelector('input[type="range"][aria-label="Context"]'));
  if (scenario === 'edit') {
    const slider = document.querySelector('input[type="range"][aria-label="Context"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '100');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(requestAnimationFrame);
    slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    await waitFor(() => document.querySelector('.route-context-head strong')?.textContent === '100%');
  }
  await new Promise(resolve => setTimeout(resolve, 350));
  const slider = document.querySelector('input[type="range"][aria-label="Context"]') as HTMLInputElement;
  const apply = document.querySelector('.agent-profile-footer button[type="submit"]') as HTMLButtonElement | null;
  return {
    scenario, storedRoute: definition.route, sliderPercent: Number(slider.value),
    contextHeading: document.querySelector('.route-context-head')?.textContent,
    applyPresent: Boolean(apply), applyDisabled: apply?.disabled ?? null,
    bodyText: document.body.innerText, calls,
  };
};
