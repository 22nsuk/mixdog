import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  actEnvironment: false,
});
globalThis.requestAnimationFrame = (callback) => {
  callback(0);
  return 1;
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useEditorMountSession } = await import('./use-editor-mount-session.ts');
const { useEditorFileSession } = await import('./use-editor-file-session.ts');

test('editor mount hook wires commands and model binding before publishing ready', async () => {
  const events = [];
  let onMount;
  const model = {
    getValue: () => 'edited',
  };
  const editor = {
    getDomNode: () => null,
    getModel: () => model,
    restoreViewState() {},
    focus: () => events.push('focus'),
  };
  function Harness() {
    const editorRef = useRef(null);
    const editorLayoutObserver = useRef(null);
    const editorLayoutSize = useRef(null);
    const activeRef = useRef(false);
    const focusedRef = useRef(false);
    const savedText = useRef('saved');
    onMount = useEditorMountSession({
      editorRef,
      editorLayoutObserver,
      editorLayoutSize,
      scheduleEditorLayout() {},
      armFonts() {},
      bindModel: (_editor, boundModel) => {
        assert.equal(boundModel, model);
        events.push('bind');
      },
      wireCommands: () => events.push('commands'),
      activeRef,
      focusedRef,
      savedText,
      projectPath: 'C:/Project/demo',
      relPath: 'src/App.tsx',
      viewStateKey: 'C:/Project/demo/src/App.tsx',
      readViewState: () => null,
      markDirty: (dirty) => events.push(`dirty:${dirty}`),
      renderAnsiOutput: (boundModel) => {
        assert.equal(boundModel, model);
        events.push('ansi');
      },
      notifyReady: () => events.push('ready'),
    });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => onMount(editor));
    assert.deepEqual(events, ['commands', 'bind', 'dirty:true', 'ansi', 'ready']);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a hidden file can format, save and back up its retained model without a mounted editor', async () => {
  const writes = [];
  const backups = [];
  let text = 'saved';
  const model = {
    getValue: () => text,
    setValue: (value) => {
      text = value;
    },
  };
  let session;
  let formats = 0;
  window.mixdogDesktop = {
    readProjectFile: async () => ({ content: 'saved', mtimeMs: 1, binary: false, tooLarge: false }),
    writeProjectFile: async (...args) => {
      writes.push(args);
      return { mtimeMs: 2 };
    },
    writeEditorBackup: async (...args) => {
      backups.push(args);
    },
    deleteEditorBackup: async () => {},
  };
  function Harness() {
    const editorRef = useRef(null);
    const modelRef = useRef(model);
    const syncLspRef = useRef(async () => true);
    session = useEditorFileSession({
      editorRef,
      modelRef,
      syncLspRef,
      projectPath: 'C:/Project/demo',
      relPath: 'a.txt',
      active: false,
      editorSettings: { formatOnSave: true },
      formatDocument: async () => {
        formats++;
        text = text.trim();
      },
      notifyReady() {},
      onDirty() {},
    });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    text = ' edited ';
    await act(async () => session.onEditorChange(text));
    await act(async () => assert.equal(await session.save(), true));
    assert.equal(formats, 1);
    assert.deepEqual(writes[0].slice(0, 4), ['C:/Project/demo', 'a.txt', 'edited', 'saved']);
    text = 'unsaved after save';
    await act(async () => session.onEditorChange(text));
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
  assert.equal(backups.at(-1)[2], 'unsaved after save');
  assert.equal(backups.at(-1)[3], 'edited');
});

test('a tab whose file vanished explains it instead of printing ENOENT', async () => {
  let session;
  window.mixdogDesktop = {
    readProjectFile: async (_project, relPath) => {
      throw new Error(`ENOENT: no such file or directory, stat 'C:\\Project\\demo\\${relPath}'`);
    },
  };
  function Harness() {
    const editorRef = useRef(null);
    const syncLspRef = useRef(async () => true);
    session = useEditorFileSession({
      editorRef,
      syncLspRef,
      projectPath: 'C:/Project/demo',
      relPath: 'gone.md',
      active: false,
      editorSettings: { formatOnSave: false },
      notifyReady() {},
      onDirty() {},
    });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    // A first read retries a missing file briefly (a just-created entry).
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    assert.equal(session.load, null);
    assert.equal(session.error, 'File was deleted or renamed on disk.');
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});
