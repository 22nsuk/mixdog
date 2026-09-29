import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
});

const { useProjectEntryRename } = await import('./use-project-entry-rename.ts');
const { navigationKey } = await import('../text-format.ts');

const project = 'C:\\work\\demo';
const file = (rel) => ({ kind: 'file', project, rel });

async function mountRename(t, { leaves, dirty = [] }) {
  const renamed = [];
  const promoted = [];
  const registered = [];
  window.mixdogDesktop = {
    renameProjectEntry: async (...args) => {
      renamed.push(args);
    },
  };
  let rename = null;
  function Harness() {
    rename = useProjectEntryRename({
      paneWorkspace: {
        leaves,
        promoteInLeaf: (leafId, selection, replaceKey) => promoted.push([leafId, selection.rel, replaceKey]),
      },
      dirtyFileKeys: new Set(dirty.map(navigationKey)),
      registerWorkspaceSelection: (selection, title, replaceKey) => registered.push([selection.rel, title, replaceKey]),
    });
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  });
  return { rename: (...args) => rename(...args), renamed, promoted, registered };
}

test('renaming an open file retargets its tab to the new name', async (t) => {
  const view = await mountRename(t, {
    leaves: [{ id: 'left', tabs: [file('src/a.ts'), file('src/b.ts'), { kind: 'new', draftId: 'd' }] }],
  });
  await view.rename(project, 'src/a.ts', 'c.ts');
  assert.deepEqual(view.renamed, [[project, 'src/a.ts', 'c.ts']]);
  assert.deepEqual(view.promoted, [['left', 'src/c.ts', navigationKey(file('src/a.ts'))]]);
  assert.deepEqual(view.registered, [['src/c.ts', 'c.ts', navigationKey(file('src/a.ts'))]]);
});

test('renaming a folder moves every open tab inside it, in every pane', async (t) => {
  const view = await mountRename(t, {
    leaves: [
      { id: 'left', tabs: [file('src/x/a.ts'), file('src/xy.ts')] },
      // Another spelling of the same project path still matches.
      { id: 'right', tabs: [{ kind: 'file', project: 'c:/work/demo/', rel: 'src/x/y/b.ts' }] },
    ],
  });
  await view.rename(project, 'src/x', 'z');
  assert.deepEqual(
    view.promoted.map(([leafId, rel]) => [leafId, rel]),
    [
      ['left', 'src/z/a.ts'],
      ['right', 'src/z/y/b.ts'],
    ]
  );
});

test('a path with unsaved edits is refused before anything moves on disk', async (t) => {
  const view = await mountRename(t, {
    leaves: [{ id: 'left', tabs: [file('src/a.ts')] }],
    dirty: [file('src/a.ts')],
  });
  await assert.rejects(view.rename(project, 'src', 'lib'), /a\.ts/);
  assert.deepEqual(view.renamed, []);
  assert.deepEqual(view.promoted, []);
});
