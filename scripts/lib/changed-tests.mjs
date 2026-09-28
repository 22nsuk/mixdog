// `--changed`: the test files whose relative references reach a file that
// differs from HEAD (tracked edits and untracked files). The graph is read from
// source text — `import … from`, `export … from`, `import()`, `require()` and
// `new URL(…, import.meta.url)` with a './' or '../' path — so an asset a module
// finds another way (a path joined at run time, a skill's markdown) is not an
// edge; those changed files are reported back as unreached so the caller can
// add a path filter for them.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';

// A module names what it loads by a relative path in four ways: a static or
// re-exporting import, a dynamic import(), require(), and a file URL resolved
// against import.meta.url (a spawned worker, a fixture script, a PowerShell source).
const RELATIVE_IMPORT =
  /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s+[^'"()]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const SUFFIXES = ['', '.mjs', '.js', '.ts', '.tsx', '.mts', '.cjs', '/index.mjs', '/index.js', '/index.ts'];
const SOURCE = /\.(?:mjs|cjs|js|ts|tsx|mts)$/;

const toPosix = (path) => path.replaceAll('\\', '/');

function gitLines(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Paths relative to cwd that differ from HEAD, plus untracked ones. */
export function changedFiles(cwd = process.cwd()) {
  const tracked = gitLines(['diff', '--name-only', '--relative', 'HEAD'], cwd);
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard'], cwd);
  return [...new Set([...tracked, ...untracked].map(toPosix))].sort();
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The module a relative specifier names, relative to cwd, or '' when no file
// answers it (a generated or missing module is simply not an edge).
function resolveImport(cwd, fromFile, specifier) {
  const base = join(cwd, dirname(fromFile), specifier);
  for (const suffix of SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (isFile(candidate)) return toPosix(relative(cwd, candidate));
  }
  return '';
}

export function createImportGraph(cwd = process.cwd()) {
  const edges = new Map();
  return (file) => {
    if (edges.has(file)) return edges.get(file);
    let text = '';
    if (SOURCE.test(file) && existsSync(join(cwd, file))) text = readFileSync(join(cwd, file), 'utf8');
    const targets = new Set();
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const target = resolveImport(cwd, file, match[1]);
      if (target) targets.add(posix.normalize(target));
    }
    const list = [...targets];
    edges.set(file, list);
    return list;
  };
}

/**
 * The test files that reach a changed file through static imports, and the
 * changed files no selected or unselected test reaches.
 */
export function selectChangedTests(testFiles, changed, cwd = process.cwd(), importsOf = createImportGraph(cwd)) {
  const changedSet = new Set(changed.map(toPosix));
  // Every module the tests import, with who imports it: reachability then runs
  // backwards from the changed files, which stays exact through import cycles.
  const seen = new Set();
  const importers = new Map();
  const stack = testFiles.map(toPosix);
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const target of importsOf(file)) {
      if (!importers.has(target)) importers.set(target, []);
      importers.get(target).push(file);
      if (!seen.has(target)) stack.push(target);
    }
  }
  const affected = new Set();
  const queue = [...changedSet].filter((file) => seen.has(file));
  while (queue.length) {
    const file = queue.pop();
    if (affected.has(file)) continue;
    affected.add(file);
    queue.push(...(importers.get(file) || []));
  }
  const selected = testFiles.filter((file) => affected.has(toPosix(file)));
  const unreached = [...changedSet].filter((file) => !seen.has(file) && existsSync(join(cwd, file)));
  return { selected, unreached };
}
