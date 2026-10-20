import '../../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Only execution and the platform-specific invocation plan are scripted.
// The tool's hoist, output rendering, artifact cleanup and cache invalidation
// run together, including the lifecycle promise returned by the runner.
let result;
let invocation;
let teePath;
mock.module('../../shell-command.mjs', {
  namedExports: {
    execShellCommand: async (input) => {
      invocation = input;
      return result;
    },
    stripAnsi: (text) => text,
  },
});
mock.module('./command-preflight.mjs', {
  namedExports: {
    prepareShellCommand: ({ command }) => ({ command, analysisCommand: command, resolvedSpec: { shellType: 'posix' } }),
  },
});
mock.module('./invocation-plan.mjs', {
  namedExports: {
    planShellInvocation: async ({ command }) => ({ wrappedCommand: command, teePlan: teePath ? { teePath } : null }),
  },
});

const { executeBashTool } = await import('../bash-tool.mjs');
const { renderCompletedResult } = await import('./completed-result.mjs');
const { normalizeToolEnvelope } = await import('../../../session/tool-envelope.mjs');
const { registerCacheInvalidationListener } = await import('../cache-layers.mjs');

const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const held of [false, true]) {
  test(`foreground artifacts and caches follow ${held ? 'tree settlement after a reported failure' : 'an ordinary completion'}`, async (t) => {
    let finish;
    const settled = held ? new Promise((resolve) => { finish = resolve; }) : null;
    result = { stdout: '', stderr: '', exitCode: held ? null : 0, killed: held, settled };
    teePath = null;
    let invalidations = 0;
    const unsubscribe = registerCacheInvalidationListener(() => { invalidations += 1; });
    t.after(unsubscribe);
    await executeBashTool({ command: 'node -e "console.log(1)"' }, process.cwd());
    const scriptPath = /^node "([^"]+)"$/.exec(invocation.command)?.[1];
    assert.ok(scriptPath, 'the actual inline transport created a script file');
    t.after(() => rmSync(scriptPath, { force: true }));
    assert.equal(existsSync(scriptPath), held, 'a live tree can still read the hoisted script');
    assert.equal(invalidations, 1, 'the immediate result invalidates earlier reads');
    if (held) {
      assert.equal(readFileSync(scriptPath, 'utf8'), 'console.log(1)');
      finish();
      await flush();
      assert.equal(existsSync(scriptPath), false, 'the final process exit releases the script');
      assert.equal(invalidations, 2, 'reads cached before the last mutation are invalidated again');
    }
  });
}

test('a foreground failure reads the tee diagnostic without deleting a live producer capture', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-tee-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'producer.log');
  // Windows PowerShell capture still needs the existing BOM-aware decoding.
  writeFileSync(file, Buffer.from('\uFEFFproducer diagnostic\n', 'utf16le'));
  let finish;
  const settled = new Promise((resolve) => { finish = resolve; });
  const rendered = normalizeToolEnvelope(renderCompletedResult({
    result: { exitCode: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '', settled },
    command: 'node producer.js | Select-String missing',
    analysisCommand: 'node producer.js | Select-String missing',
    stdout: '',
    stderr: '',
    teePlan: { teePath: file },
  }));
  assert.match(rendered.result, /producer diagnostic/);
  assert.equal(existsSync(file), true, 'rendering a failure is not proof the producer stopped');
  finish();
  await flush();
  assert.equal(existsSync(file), false);
});

test('a queued command keeps its tee until its run settles, without a native job id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-queued-tee-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  teePath = join(dir, 'producer.log');
  writeFileSync(teePath, 'queued producer output');
  let finish;
  const settled = new Promise((resolve) => { finish = resolve; });
  result = { stdout: '', stderr: '', exitCode: null, backgrounded: true, settled };
  await executeBashTool({ command: 'node producer.js' }, process.cwd());
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(existsSync(teePath), true, 'the untracked-job fallback must not override the known run lifetime');
  finish();
  await flush();
  assert.equal(existsSync(teePath), false);
});

test('host exit does not delete an artifact whose tracked tree is still running', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-artifact-host-exit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'live-command.cjs');
  writeFileSync(file, 'console.log(1)');
  const jobsModule = new URL('../shell-jobs.mjs', import.meta.url).href;
  const artifactsModule = new URL('./transport-artifacts.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import { mock } from 'node:test';
    mock.module(${JSON.stringify(jobsModule)}, { namedExports: {
      isShellJobRunning: () => true,
      subscribeShellJobSettled: () => () => {},
    } });
    const { cleanupArtifactOnTaskSettled } = await import(${JSON.stringify(artifactsModule)});
    cleanupArtifactOnTaskSettled(${JSON.stringify(file)}, 'job_still_running');
    process.exit(0);
  `], { timeout: 10_000, stdio: 'pipe' });
  assert.equal(existsSync(file), true, 'the host exit does not prove the command tree ended');
});
