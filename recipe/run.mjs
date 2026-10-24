import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const repo = resolve(process.argv[2]);
const recipe = dirname(fileURLToPath(import.meta.url));
const output = dirname(recipe);
const require = createRequire(join(repo, 'apps/desktop/package.json'));
const { build } = require('esbuild');
const electron = require('electron');
const renderer = join(repo, 'apps/desktop/src/renderer').replaceAll('\\', '/');
const baseline = execFileSync('git', ['show', 'd141c52f61daf767cb2bad98d49f867c5b77282a:apps/desktop/src/renderer/AgentProfilePane.tsx'], { cwd: repo, encoding: 'utf8' });
const needle = "    ...(route.autoEffort === false ? { autoEffort: false } : {}),";
if (!baseline.includes(needle)) throw new Error('Source insertion anchor missing');
const addition = "\n    ...(typeof route.contextPercent === 'number' ? { contextPercent: route.contextPercent } : {}),\n    ...(typeof route.contextTokens === 'number' ? { contextTokens: route.contextTokens } : {}),";
const entry = (await readFile(join(recipe, 'entry.tsx'), 'utf8')).replaceAll('__RENDERER__', renderer);
const sourceHashes = {};
for (const variant of ['before', 'after']) {
  const source = variant === 'before' ? baseline : baseline.replace(needle, needle + addition);
  sourceHashes[variant] = createHash('sha256').update(source).digest('hex');
  const runtime = join(output, 'runtime', variant);
  await mkdir(runtime, { recursive: true });
  await build({
    stdin: { contents: entry, sourcefile: 'issue224-entry.tsx', resolveDir: join(repo, 'apps/desktop'), loader: 'tsx' },
    outfile: join(runtime, 'fixture.js'), bundle: true, format: 'esm', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}', 'process.platform': JSON.stringify(process.platform) },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    logLevel: 'warning',
    plugins: [{ name: 'real-editor-workers', setup(builder) {
      builder.onResolve({ filter: /\?worker$/ }, async args => {
        const source = require.resolve(args.path.replace(/\?worker$/, ''), { paths: [dirname(args.importer)] });
        const filename = createHash('sha256').update(source).digest('hex').slice(0, 12) + '.js';
        await build({ entryPoints: [source], outfile: join(runtime, filename), bundle: true, format: 'iife', logLevel: 'warning' });
        return { path: filename, namespace: 'local-worker' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'local-worker' }, args => ({ contents: `export default class LocalEditorWorker extends Worker { constructor() { super(new URL(${JSON.stringify('./' + args.path)}, import.meta.url)); } }`, loader: 'js' }));
    } }, { name: 'issue224-agent-profile-source', setup(build) {
      build.onLoad({ filter: /[\\/]AgentProfilePane\.tsx$/ }, args => ({ contents: source, loader: 'tsx', resolveDir: dirname(args.path) }));
    } }],
  });
  await writeFile(join(runtime, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(recipe, 'main.cjs'), runtime, output, variant], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Electron capture exited ${code}`)));
  });
}
await writeFile(join(output, 'capture-provenance.json'), JSON.stringify({ baseline: 'd141c52f61daf767cb2bad98d49f867c5b77282a', sourcePath: 'apps/desktop/src/renderer/AgentProfilePane.tsx', sourceHashes, afterPatch: addition, capturedAt: new Date().toISOString() }, null, 2));
