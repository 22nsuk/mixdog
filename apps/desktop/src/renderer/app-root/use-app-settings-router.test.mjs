import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppSettingsRouter } from './use-app-settings-router.ts';

test('useAppSettingsRouter handles openSettings and UI requests routing', async () => {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
    actEnvironment: false,
  });
  globalThis.window.mixdogDesktop = {
    getRemoteAccessInfo: async () => null,
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let settingsOpen = false;
  let settingsSection = null;

  let hookResult = null;
  function TestHarness() {
    hookResult = useAppSettingsRouter({
      workbenchSideLayout: { sideOf: () => 'left' },
      setExtensionsSection: () => {},
      setSettingsOpen: (open) => {
        settingsOpen = open;
      },
      setCommandSurface: () => {},
      mountSidebarPanel: () => {},
      trackSidebarPanelModule: () => {},
      paneSideDocks: { open: () => {} },
      focusedLeafIdRef: { current: 'leaf-1' },
      setActiveSideViews: () => {},
      applySidebarOpen: () => {},
      setProjectsSection: () => {},
      openProjects: () => {},
      setSettingsSection: (s) => {
        settingsSection = s;
      },
      uiOpenRequest: null,
      sessionId: 's1',
      openConversationCommandSurface: () => {},
      setupUiRequest: null,
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });

  assert.notEqual(hookResult, null);
  assert.equal(typeof hookResult.openSettings, 'function');

  // Open general settings
  await act(async () => {
    hookResult.openSettings('theme');
  });
  assert.equal(settingsOpen, true);
  assert.equal(settingsSection, 'theme');

  await act(async () => {
    root.unmount();
  });
});
