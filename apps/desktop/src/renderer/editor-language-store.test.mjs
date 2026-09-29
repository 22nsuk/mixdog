import assert from 'node:assert/strict';
import test from 'node:test';

// No desktop bridge: the store must learn the server state from the editor.
globalThis.window = {};
const { acceptEditorLspState, getEditorCommandCapabilities, setActiveEditorDocument, subscribeEditorLanguageStore } =
  await import('./editor-language-store.ts');

test("a document's own LSP answer enables palette commands without a status broadcast", () => {
  let notified = 0;
  const unsubscribe = subscribeEditorLanguageStore(() => {
    notified += 1;
  });
  setActiveEditorDocument({
    projectPath: 'C:\\demo',
    relPath: 'src/a.ts',
    uri: 'file:///c%3A/demo/src/a.ts',
    languageId: 'typescript',
  });
  assert.equal(getEditorCommandCapabilities().definition, false);

  const state = {
    available: true,
    status: 'ready',
    server: 'TypeScript Language Server',
    capabilities: { definition: true, references: true, rename: true, formatting: true },
  };
  acceptEditorLspState('C:\\demo', 'src\\a.ts', 'typescript', state);
  assert.equal(getEditorCommandCapabilities().definition, true);
  assert.equal(getEditorCommandCapabilities().formatting, true);

  // Every sync repeats the answer; an unchanged state publishes nothing.
  const published = notified;
  acceptEditorLspState('C:\\demo', 'src/a.ts', 'typescript', { ...state, capabilities: { ...state.capabilities } });
  assert.equal(notified, published);

  acceptEditorLspState('C:\\demo', 'src/a.ts', 'typescript', { ...state, available: false, status: 'stopped' });
  assert.equal(getEditorCommandCapabilities().definition, false);
  unsubscribe();
});
