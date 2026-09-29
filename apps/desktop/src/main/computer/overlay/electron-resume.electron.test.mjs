import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import electron from 'electron';
import { computerSourceEsbuildPlugin } from '../../../../scripts/computer-source-assets.mjs';

async function runFixture(name) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-overlay-ipc-'));
  try {
    await Promise.all([
      build({
        entryPoints: [fileURLToPath(new URL(`./test-fixtures/${name}.ts`, import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        // The fixture runs from a temporary directory, like the installed app,
        // so the pill face must travel inside the bundle.
        plugins: [computerSourceEsbuildPlugin()],
        outfile: join(directory, 'main/index.cjs'),
      }),
      build({
        entryPoints: [fileURLToPath(new URL('../../../preload/computer-overlay.ts', import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        outfile: join(directory, 'preload/computer-overlay.js'),
      }),
    ]);
    const env = { ...process.env, OVERLAY_TEST_DIRECTORY: directory };
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
test('the sandboxed Stop control preserves native hit-testing, non-activation, preload IPC and its own face', {
  timeout: 45000,
  skip: process.platform !== 'win32',
}, async () => {
  const { result, clickMode } = await runFixture('electron-resume');
  assert.equal(result.stopped, 3);
  assert.equal(result.paused, 0);
  assert.equal(result.visible, false);
  assert.equal(result.font.covered, true);
  // The native click must have run; a locked desktop session can only weaken its hit test.
  assert.ok(['desktop-hit-test', 'locked-session'].includes(clickMode), `native click mode ${clickMode}`);
  console.log('overlay IPC evidence', { ...result, clickMode });
});

test('a frozen real renderer is retired and its replacement stays paused until its native Stop', {
  timeout: 45000,
  skip: process.platform !== 'win32',
}, async () => {
  const { result, clickMode } = await runFixture('electron-recovery');
  assert.deepEqual(result, { retired: true, visible: true, inputBlocked: false, stopped: 1 });
  assert.ok(['desktop-hit-test', 'locked-session'].includes(clickMode), `native click mode ${clickMode}`);
  console.log('overlay renderer recovery evidence', { ...result, clickMode });
});
