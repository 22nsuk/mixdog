import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';
import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

// --native runs the native pane presentation checks (MIXDOG_BROWSER_NATIVE_VIEW)
// against the same fixture shell instead of the pixel-surface isolation suite.
const native = process.argv.includes('--native');

await withTempWorkspace(
  'mixdog-browser-input-isolation-',
  async (directory) => {
    const output = join(directory, 'input-isolation.mjs');
    const log = join(directory, 'result.log');
    await Promise.all([
      build({
        entryPoints: [
          fileURLToPath(new URL('../src/renderer/test-support/browser-input-isolation.tsx', import.meta.url)),
        ],
        outfile: join(directory, 'fixture-renderer.js'),
        bundle: true,
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'warning',
      }),
      build({
        entryPoints: [
          fileURLToPath(new URL('../src/main/browser/test-fixtures/input-surface-preload.ts', import.meta.url)),
        ],
        outfile: join(directory, 'fixture-preload.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        logLevel: 'warning',
      }),
    ]);
    await bundleElectronEntry({
      entry: new URL(
        native ? '../src/main/browser/native-view.integration.ts' : '../src/main/browser/input-isolation.integration.ts',
        import.meta.url
      ),
      outfile: output,
      plugins: [computerSourceEsbuildPlugin()],
      external: ['electron', 'ws'],
    });
    const env = electronProcessEnv({
      MIXDOG_INPUT_ISOLATION_DIRECTORY: directory,
      MIXDOG_INPUT_ISOLATION_LOG: log,
      // The pixel-surface suite must not inherit a developer's native toggle.
      MIXDOG_BROWSER_NATIVE_VIEW: native ? '1' : '0',
    });
    const child = spawnElectron(output, { env, args: process.argv.slice(2) });
    const code = await waitForChildExit(child, {
      timeoutMs: 120_000,
      onTimeout: 'kill',
      rejectOnSignal: false,
      fallbackCode: null,
    });
    const result = await readFile(log, 'utf8');
    process.stdout.write(result);
    const passed = native ? 'native view passed' : 'input isolation passed';
    if (code !== 0 || !result.includes(passed)) {
      throw new Error(`browser ${native ? 'native view' : 'input isolation'} failed (exit ${code})`);
    }
  },
  { maxRetries: 10, retryDelay: 100 }
);
