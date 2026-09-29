import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after } from 'node:test';

// The conversions below are pure; only the module's Monaco import is browser-bound.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './monaco-setup') {
      return next(new URL('./test-fixtures/editor-opening-deps.mjs', import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});
after(() => hooks.deregister());

const { markupText, projectRelativePath } = await import('./editor-lsp-conversion.ts');

test('a language-tagged marked string becomes a fenced code block', () => {
  assert.equal(markupText({ language: 'ts', value: 'let a = 1;' }), '```ts\nlet a = 1;\n```');
  assert.equal(markupText({ kind: 'markdown', value: '**doc**' }), '**doc**');
  assert.equal(markupText('plain'), 'plain');
  assert.equal(markupText([{ language: 'ts', value: 'f()' }, 'note']), '```ts\nf()\n```\n\nnote');
  assert.equal(markupText(null), '');
});

test('project-relative paths ignore case and separators and exclude the project root itself', () => {
  assert.equal(projectRelativePath('C:\\Demo\\src\\a.ts', 'c:/demo/'), 'src/a.ts');
  assert.equal(projectRelativePath('/c:/demo/src/a.ts', 'C:/Demo'), 'src/a.ts');
  assert.equal(projectRelativePath('C:/demo', 'C:/demo'), null);
  assert.equal(projectRelativePath('C:/demo-other/a.ts', 'C:/demo'), null);
  assert.equal(projectRelativePath('D:/x/a.ts', 'C:/demo'), null);
});
