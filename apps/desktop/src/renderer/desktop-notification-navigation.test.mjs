import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { focusOpenNotificationSession } from './desktop-notification-navigation.ts';
import { usePushNotificationNavigation } from './use-push-notification-navigation.ts';
import { activateTabInPaneLeaf, findPaneLeaf, paneLeaves } from './pane-layout.ts';
import { installTestDom } from './test-support/test-dom.mjs';

const session = (id) => ({ kind: 'session', id });
const layout = () => ({
  type: 'split',
  direction: 'row',
  ratio: 0.5,
  first: { type: 'leaf', id: 'left', tabs: [session('a')], activeKey: 'session:a' },
  second: { type: 'leaf', id: 'right', tabs: [session('b'), session('c')], activeKey: 'session:c' },
});

test('a desktop notification selects the existing tab in its own pane without adding a tab', () => {
  const workspace = {
    layout: layout(),
    focusedLeafId: 'left',
    activateTab(leafId, key) {
      this.layout = activateTabInPaneLeaf(this.layout, leafId, key);
      this.focusedLeafId = leafId;
    },
  };
  const beforeTabs = paneLeaves(workspace.layout).flatMap((leaf) => leaf.tabs);
  assert.equal(focusOpenNotificationSession(workspace, 'b'), true);
  assert.equal(workspace.focusedLeafId, 'right');
  assert.equal(findPaneLeaf(workspace.layout, 'right').activeKey, 'session:b');
  assert.deepEqual(
    paneLeaves(workspace.layout).flatMap((leaf) => leaf.tabs),
    beforeTabs
  );
});

test('a closed session leaves both the selected pane and its tabs untouched', () => {
  const original = layout();
  const workspace = {
    layout: original,
    activateTab() {
      assert.fail('A closed session must not select or create a tab');
    },
  };
  assert.equal(focusOpenNotificationSession(workspace, 'closed'), false);
  assert.equal(workspace.layout, original);
});

async function harness(t, initial = {}) {
  const { window, root } = installTestDom(t, { expose: ['navigator'], rootId: 'root' });
  const serviceWorker = new window.EventTarget();
  Object.defineProperty(window.navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  let click;
  let subscriptions = 0;
  const opened = [];
  const selected = [];
  window.mixdogDesktop = {
    onNotificationOpenSession(listener) {
      click = listener;
      subscriptions++;
      return () => {
        click = undefined;
      };
    },
  };
  let currentLayout = layout();
  let props = {
    ready: true,
    desktopReady: true,
    openSession: (id) => opened.push(id),
    focusDesktopSession: (id) =>
      focusOpenNotificationSession(
        {
          layout: currentLayout,
          activateTab: (leafId, key) => selected.push([leafId, key]),
        },
        id
      ),
    ...initial,
  };
  function Probe(input) {
    usePushNotificationNavigation(input);
    return null;
  }
  const render = async (patch = {}) => {
    props = { ...props, ...patch };
    await act(async () => root.render(React.createElement(Probe, props)));
  };
  await render();
  return {
    opened,
    selected,
    render,
    subscriptions: () => subscriptions,
    closeTabs: () => {
      currentLayout = { type: 'leaf', id: 'left', tabs: [session('a')], activeKey: 'session:a' };
    },
    click: async (id) => {
      await act(async () => click(id));
    },
    push: async (id) => {
      await act(async () =>
        serviceWorker.dispatchEvent(
          new window.MessageEvent('message', {
            data: { type: 'mixdog:open-session', sessionId: id },
          })
        )
      );
    },
  };
}

test('desktop IPC focuses an open session but never invokes the open-session path', async (t) => {
  const h = await harness(t, { ready: false });
  await h.click('b');
  await h.click('closed');
  assert.deepEqual(h.selected, [['right', 'session:b']]);
  assert.deepEqual(h.opened, []);
});

test('an early desktop click waits for pane restoration, then selects exactly once', async (t) => {
  const h = await harness(t, { desktopReady: false });
  await h.click('b');
  assert.deepEqual(h.selected, []);
  await h.render({ desktopReady: true });
  assert.deepEqual(h.selected, [['right', 'session:b']]);
  await h.render();
  assert.equal(h.selected.length, 1);
  assert.deepEqual(h.opened, []);
});

test('a tab closed before restoration completes is not reopened by a queued click', async (t) => {
  const h = await harness(t, { desktopReady: false });
  await h.click('b');
  h.closeTabs();
  await h.render({ desktopReady: true });
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.opened, []);
});

test('a moved tab uses the latest focus callback without reinstalling the IPC listener', async (t) => {
  const h = await harness(t);
  const focused = [];
  await h.render({ focusDesktopSession: (id) => focused.push(id) });
  await h.click('b');
  assert.deepEqual(focused, ['b']);
  assert.deepEqual(h.selected, []);
  assert.equal(h.subscriptions(), 1);
});

test('phone push still opens its session, including a click received before catalog readiness', async (t) => {
  const h = await harness(t, { ready: false, desktopReady: false });
  await h.push('phone-session');
  assert.deepEqual(h.opened, []);
  await h.render({ ready: true });
  assert.deepEqual(h.opened, ['phone-session']);
  await h.push('another-phone-session');
  assert.deepEqual(h.opened, ['phone-session', 'another-phone-session']);
  assert.deepEqual(h.selected, []);
});
