import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { invalidateBuiltinResultCache } from '../../tools/builtin/cache-layers.mjs';
import {
  clearScopedToolsForSessionPaths,
  scopedCacheGeneration,
  setScopedToolCached,
  tryScopedToolCached,
} from './scoped-cache.mjs';

const root = resolve('virtual-scoped-invalidation');
const req = (sessionId, path, pattern = 'needle') => ({
  sessionId,
  toolName: 'grep',
  cwd: root,
  args: { path, pattern },
});
const put = (spec, content = 'v') => setScopedToolCached({ ...spec, content });
const hit = (spec) => tryScopedToolCached(spec)?.content ?? null;

test.afterEach(() => invalidateBuiltinResultCache());

test('many sessions with duplicate path aliases evict only covering roots', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
  for (const id of ids) {
    put(req(id, 'src'));
    put(req(id, 'docs'));
  }
  const file = resolve(root, 'src/a.ts');
  invalidateBuiltinResultCache([file, file, resolve(root, 'src/../src/a.ts'), `${root}/src/a.ts`]);
  for (const id of ids) {
    assert.equal(hit(req(id, 'src')), null);
    assert.equal(hit(req(id, 'docs')), 'v');
  }
});

test('sibling with shared prefix is retained; ancestor and descendant boundaries hold', () => {
  const src = req('b', 'src');
  const srcExtra = req('b', 'src-extra');
  const deep = req('b', 'src/deep/inner');
  for (const s of [src, srcExtra, deep]) put(s);
  invalidateBuiltinResultCache([resolve(root, 'src/deep')]);
  assert.equal(hit(src), null);
  assert.equal(hit(deep), null);
  assert.equal(hit(srcExtra), 'v');
});

test('root invalidation evicts everything beneath; rename invalidates both paths', () => {
  const a = req('c', 'old');
  const b = req('c', 'new');
  const c = req('c', 'keep');
  for (const s of [a, b, c]) put(s);
  invalidateBuiltinResultCache([resolve(root, 'old/x.ts'), resolve(root, 'new/x.ts')]);
  assert.equal(hit(a), null);
  assert.equal(hit(b), null);
  assert.equal(hit(c), 'v');
  invalidateBuiltinResultCache([root]);
  assert.equal(hit(c), null);
});

test('repeated invalidation drops results inserted between events', () => {
  const spec = req('d', 'src');
  const other = req('d', 'other');
  put(other);
  for (let i = 0; i < 3; i++) {
    put(spec, `r${i}`);
    assert.equal(hit(spec), `r${i}`);
    invalidateBuiltinResultCache([resolve(root, 'src/f.ts')]);
    assert.equal(hit(spec), null);
  }
  assert.equal(hit(other), 'v');
});

test('targeted clear API is per-session and advances generation synchronously', () => {
  const a = req('e1', 'src');
  const b = req('e2', 'src');
  put(a);
  put(b);
  const before = scopedCacheGeneration();
  clearScopedToolsForSessionPaths('e1', ['src/x.ts'], root);
  assert.ok(scopedCacheGeneration() > before);
  assert.equal(hit(a), null);
  assert.equal(hit(b), 'v');
});

test('unresolvable paths fall back to a full clear', () => {
  const a = req('f', 'src');
  const b = req('f', 'docs');
  put(a);
  put(b);
  clearScopedToolsForSessionPaths('f', ['', 42], root);
  assert.equal(hit(a), null);
  assert.equal(hit(b), null);
});

test('replacement and LRU eviction keep later invalidation correct', () => {
  const spec = req('g', 'src');
  put(spec, 'one');
  put(spec, 'two');
  assert.equal(hit(spec), 'two');
  invalidateBuiltinResultCache([resolve(root, 'src/a.ts')]);
  assert.equal(hit(spec), null);
  // LRU overflow must not break later insertions or invalidations.
  for (let i = 0; i < 120; i++) put(req('g', `dir${i}`, `p${i}`));
  assert.equal(hit(req('g', 'dir0', 'p0')), null);
  assert.equal(hit(req('g', 'dir119', 'p119')), 'v');
  invalidateBuiltinResultCache([resolve(root, 'dir119/x')]);
  assert.equal(hit(req('g', 'dir119', 'p119')), null);
  assert.equal(hit(req('g', 'dir118', 'p118')), 'v');
  put(spec, 'fresh');
  assert.equal(hit(spec), 'fresh');
});

test('stale completion started before invalidation is rejected', () => {
  const spec = req('h', 'src');
  const generation = scopedCacheGeneration();
  invalidateBuiltinResultCache([resolve(root, 'src/a.ts')]);
  setScopedToolCached({ ...spec, content: 'stale', generation });
  assert.equal(hit(spec), null);
  setScopedToolCached({ ...spec, content: 'fresh', generation: scopedCacheGeneration() });
  assert.equal(hit(spec), 'fresh');
});
