import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import electron from 'electron';
import { computerSourceEsbuildPlugin } from '../../../../scripts/computer-source-assets.mjs';

// Reuse immutable bundles across rendering modes, not Electron profiles or processes.
const bundles = new Map();
function bundledSource(relativePath, plugins = []) {
  if (!bundles.has(relativePath)) {
    bundles.set(
      relativePath,
      build({
        entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        plugins,
        write: false,
      }).then(({ outputFiles }) => outputFiles[0].contents)
    );
  }
  return bundles.get(relativePath);
}

async function runFixture(name, softwareRendering) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-overlay-ipc-'));
  try {
    const [main, preload] = await Promise.all([
      // The installed app's pill face must still travel inside the bundle.
      bundledSource(`./test-fixtures/${name}.ts`, [computerSourceEsbuildPlugin()]),
      bundledSource('../../../preload/computer-overlay.ts'),
    ]);
    await Promise.all([mkdir(join(directory, 'main')), mkdir(join(directory, 'preload'))]);
    await Promise.all([
      writeFile(join(directory, 'main/index.cjs'), main),
      writeFile(join(directory, 'preload/computer-overlay.js'), preload),
    ]);
    const env = {
      ...process.env,
      OVERLAY_TEST_DIRECTORY: directory,
      OVERLAY_SOFTWARE_RENDERING: softwareRendering ? '1' : '0',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = await promisify(execFile)(electron, [join(directory, 'main/index.cjs')], {
      // A loaded hosted runner needs seconds for the native click's cold Add-Type alone, so
      // this budget bounds a hung fixture only, never a slow-but-healthy one.
      env,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    }).catch((error) => error);
    const stdout = String(run.stdout ?? ''),
      stderr = String(run.stderr ?? '');
    // Electron can exit 0 without a result (its default quit-on-last-window-close outruns the
    // fixture, a renderer hangs, the run is killed on timeout); only stderr explains which.
    const evidence = `\n--- ${name} stdout ---\n${stdout.slice(-4000)}\n--- ${name} stderr ---\n${stderr.slice(-8000)}`;
    assert.ok(!(run instanceof Error), `fixture ${name} failed: ${String(run.message).split('\n')[0]}${evidence}`);
    const marker = stdout.split('OVERLAY_RESULT ')[1];
    assert.ok(marker, `fixture ${name} exited ${run.code ?? 0} without an OVERLAY_RESULT marker${evidence}`);
    return {
      result: JSON.parse(marker.split('\n')[0]),
      clickMode: /OVERLAY_CLICK_MODE (\S+)/.exec(stderr)?.[1] ?? '',
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The overlay belongs to Computer Use, which ships on Windows only; the Linux CI lanes also have no display server.
for (const softwareRendering of [false, true]) {
  const rendering = softwareRendering ? 'software' : 'GPU';
  test(`the sandboxed Stop control preserves native hit-testing, non-activation, preload IPC and its own face (${rendering})`, {
    timeout: 45000,
    skip: process.platform !== 'win32' && 'Windows only',
  }, async () => {
    const { result, clickMode } = await runFixture('electron-resume', softwareRendering);
    assert.equal(result.stopped, 4);
    assert.equal(result.paused, 0);
    assert.equal(result.visible, false);
    assert.equal(result.font.covered, true);
    // The native click must have run; a locked desktop session can only weaken its hit test.
    assert.ok(['desktop-hit-test', 'locked-session'].includes(clickMode), `native click mode ${clickMode}`);
    console.log('overlay IPC evidence', { ...result, clickMode });
  });

  test(`a frozen real renderer is retired and its replacement stays paused until its native Stop (${rendering})`, {
    timeout: 45000,
    skip: process.platform !== 'win32' && 'Windows only',
  }, async () => {
    const { result, clickMode } = await runFixture('electron-recovery', softwareRendering);
    assert.deepEqual(result, { retired: true, visible: true, inputBlocked: false, stopped: 1 });
    assert.ok(['desktop-hit-test', 'locked-session'].includes(clickMode), `native click mode ${clickMode}`);
    console.log('overlay renderer recovery evidence', { ...result, clickMode });
  });
}
