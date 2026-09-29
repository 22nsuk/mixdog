import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppEditorState } from './use-app-editor-state.ts';

test('useAppEditorState manages dirty file keys and editor save handles', async () => {
  const { dom } = installTestDom(null, {
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  });

  let pinnedKey = '';
  const paneWorkspace = {
    leaves: [],
    pinTabByKey: (key) => {
      pinnedKey = key;
    },
  };

  let hookResult = null;
  function TestHarness() {
    hookResult = useAppEditorState({
      paneWorkspace,
      startupFocusedPaneSelection: null,
      bottomPanel: { open: false, tab: 'problems', setOpen: () => {}, setTab: () => {} },
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });

  assert.notEqual(hookResult, null);
  assert.equal(hookResult.dirtyFileKeys.size, 0);

  // Mark file dirty
  await act(async () => {
    hookResult.handleFileDirty('file-1', true);
  });
  assert.equal(hookResult.dirtyFileKeys.has('file-1'), true);
  assert.equal(pinnedKey, 'file-1');

  // Register save handle
  const saveFn = async () => {};
  hookResult.registerEditorSaveHandle('file-1', saveFn);
  assert.equal(hookResult.editorSaveHandles.current.get('file-1'), saveFn);

  // A pane that unmounts after another took the same file over releases only
  // its own handle: the live owner stays saveable.
  const nextOwner = { save: async () => true, discard: async () => {} };
  hookResult.registerEditorSaveHandle('file-1', nextOwner);
  hookResult.registerEditorSaveHandle('file-1', null, saveFn);
  assert.equal(hookResult.editorSaveHandles.current.get('file-1'), nextOwner);
  hookResult.registerEditorSaveHandle('file-1', null, nextOwner);
  assert.equal(hookResult.editorSaveHandles.current.has('file-1'), false);
  hookResult.registerEditorSaveHandle('file-1', saveFn);

  // Unmark dirty
  await act(async () => {
    hookResult.handleFileDirty('file-1', false);
  });
  assert.equal(hookResult.dirtyFileKeys.has('file-1'), false);

  await act(async () => {
    root.unmount();
  });
});
