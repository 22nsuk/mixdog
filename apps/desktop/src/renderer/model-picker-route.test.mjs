import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useAppSettingsRouter } from './app-root/use-app-settings-router.ts';
import { createSlashExecutor } from './composer-slash-executor.ts';
import { OPEN_MODEL_PICKER_EVENT } from './model-picker-event.ts';

async function setup(run) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });
  globalThis.window.mixdogDesktop = {};
  globalThis.CustomEvent = dom.window.CustomEvent;
  const calls = { settingsOpen: [], sidebar: [], pickerRequests: 0 };
  let router;
  function Harness() {
    router = useAppSettingsRouter({
      workbenchSideLayout: { sideOf: () => 'left' },
      setExtensionsSection() {},
      setSettingsOpen: (open) => calls.settingsOpen.push(open),
      setCommandSurface() {},
      mountSidebarPanel: (name) => calls.sidebar.push(name),
      trackSidebarPanelModule() {},
      paneSideDocks: { open() {} },
      focusedLeafIdRef: { current: 'leaf' },
      setActiveSideViews() {},
      applySidebarOpen() {},
      setSettingsSection() {},
      uiOpenRequest: null,
      sessionId: 's',
      openConversationCommandSurface() {},
      setupUiRequest: null,
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await run({ calls, openSettings: router.openSettings, window: dom.window });
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

const opened = (calls) => calls.settingsOpen.includes(true);

test("openSettings('model') opens the picker via a handling listener, never Settings", async () => {
  await setup(async ({ calls, openSettings, window }) => {
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, (event) => {
      calls.pickerRequests += 1;
      event.preventDefault();
    });
    openSettings('model');
    assert.equal(calls.pickerRequests, 1);
    assert.equal(opened(calls), false);
    assert.deepEqual(calls.sidebar, []);
  });
});

test("openSettings('model') without a listener opens Workflows, not Settings", async () => {
  await setup(async ({ calls, openSettings }) => {
    openSettings('model');
    assert.equal(opened(calls), false);
    assert.deepEqual(calls.sidebar, ['workflows']);
  });
});

test('/effort and /model without an argument follow the picker path', async () => {
  await setup(async ({ calls, openSettings, window }) => {
    const execute = createSlashExecutor({
      turnBusy: false,
      setAttachmentError() {},
      clearNotice() {},
      onOpenSettings: openSettings,
    });
    await execute('/effort');
    assert.deepEqual(calls.sidebar, ['workflows']);
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, (event) => {
      calls.pickerRequests += 1;
      event.preventDefault();
    });
    await execute('/effort');
    await execute('/model');
    assert.equal(calls.pickerRequests, 2);
    assert.equal(opened(calls), false);
    assert.deepEqual(calls.sidebar, ['workflows']);
  });
});
