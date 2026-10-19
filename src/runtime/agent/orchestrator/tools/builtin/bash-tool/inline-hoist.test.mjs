import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cacheGet, cacheSet, invalidateBuiltinResultCache } from '../cache-layers.mjs';
import { tokenizeDirectArgv } from '../shell-direct-exe.mjs';
import { planInlineScriptHoist } from '../shell-analysis.mjs';
import { hoistInlineScript } from './inline-hoist.mjs';

// The shell caller imports the broader tool registry; these tests do not
// need the unrelated patch engine's background download/prewarm.
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { executeBashTool } = await import('../bash-tool.mjs');

test('inline scripts hoisted in the same millisecond keep separate files', (t) => {
  t.mock.method(Date, 'now', () => 1_792_183_386_056);
  const first = hoistInlineScript(`node -e "process.exit(5)"`, 'powershell');
  const second = hoistInlineScript(`node -e "console.log('second')"`, 'powershell');
  t.after(() => {
    for (const path of [first.hoistPath, second.hoistPath]) if (path) rmSync(path, { force: true });
  });
  assert.ok(first.hoistPath && second.hoistPath, 'both commands are hoisted');
  assert.notEqual(first.hoistPath, second.hoistPath);
  assert.equal(readFileSync(first.hoistPath, 'utf8'), 'process.exit(5)');
  assert.equal(readFileSync(second.hoistPath, 'utf8'), "console.log('second')");
});

test('an inline script whose quote the shell would not end there stays inline', (t) => {
  for (const command of [
    // PowerShell `""` is an escaped quote inside a double-quoted string.
    `node -e "console.log('a', ""q"")"`,
    `node -e "console.log(""a"" + ""b"")"`,
    // The closing quote is glued to more argument text.
    `node -e "console.log(1)"suffix`,
    // Trailing arguments: process.argv differs between -e and a file run.
    `node -e "console.log(process.argv.slice(1))" a b`,
    `node -e "console.log(process.argv.length)" -- x`,
  ]) {
    const result = hoistInlineScript(command, 'powershell');
    t.after(() => result.hoistPath && rmSync(result.hoistPath, { force: true }));
    assert.equal(result.hoistPath, null, command);
    assert.equal(result.command, command);
  }
  for (const command of [
    `node -e "console.log(1)" | Out-String`,
    `node -e "console.log(1)"; node -e "console.log(2)"`,
    `node -e "console.log(1)" 2>&1`,
    `node -e "console.log(1)"\nGet-Date`,
    `node -e "console.log(1)"`,
  ]) {
    const result = hoistInlineScript(command, 'powershell');
    t.after(() => result.hoistPath && rmSync(result.hoistPath, { force: true }));
    assert.ok(result.hoistPath, command);
  }
});

test('direct argv keeps a PowerShell doubled quote as a literal quote', () => {
  assert.deepEqual(tokenizeDirectArgv(`node -e "console.log('a', ""q"")"`), ['node', '-e', `console.log('a', "q")`]);
  assert.deepEqual(tokenizeDirectArgv('node -e ""'), ['node', '-e', '']);
});

test('a replacement path containing `$` patterns is inserted verbatim', () => {
  const plan = planInlineScriptHoist(`node -e "console.log(1)"`);
  assert.equal(plan.replace('C:/tmp/$&-$1.cjs'), 'node "C:/tmp/$&-$1.cjs"');
});

test('node -e / --eval / -p run correctly through the shell tool', { skip: process.platform !== 'win32' }, async () => {
  const run = async (command) => {
    const out = await executeBashTool({ command }, process.cwd(), {});
    return String(out?.result ?? out);
  };
  const cases = [
    [`node -e "console.log(1 + 1)"`, '2'],
    [`node --eval "console.log('한글 테스트')"`, '한글 테스트'],
    [`node -p "6 * 7"`, '42'],
    [`node -e "console.log('a', ""q"")"`, 'a q'],
    [`node -e "console.log(1);\nconsole.log('two')"`, 'two'],
    [`node -e "console.log(process.argv.slice(1).join('|'))" a b`, 'a|b'],
    [`node -e 'console.log("$HOME-\`tick\`")'`, '$HOME-`tick`'],
    // PowerShell: a backtick escapes `$` inside double quotes.
    [`node -e "console.log('\`$x')"`, '$x'],
  ];
  for (const [command, expected] of cases) {
    const text = await run(command);
    assert.ok(!text.includes('MODULE_NOT_FOUND'), `${command}\n${text}`);
    assert.ok(text.includes('[exit code: 0]'), `${command}\n${text}`);
    assert.ok(text.includes(expected), `${command}\n${text}`);
  }
});

test('a script that loads a package stays inline, where the working directory resolves it', (t) => {
  for (const command of [
    `node -e "const p = require('puppeteer-core'); console.log(p)"`,
    `node -e "console.log(require('electron/package.json').version)"`,
    `node --input-type=module -e "import { chromium } from 'playwright'; console.log(chromium)"`,
    `node -e "import('ws').then(console.log)"`,
    `node -e "console.log(require.resolve('typescript'))"`,
    `node -e "const name = 'typescript'; console.log(require(name).version)"`,
  ]) {
    const result = hoistInlineScript(command, 'powershell');
    t.after(() => result.hoistPath && rmSync(result.hoistPath, { force: true }));
    assert.equal(result.hoistPath, null, command);
    assert.equal(result.command, command);
  }
  const builtin = hoistInlineScript(
    `node -e "const fs = require('node:fs'); require('os'); console.log(fs)"`,
    'powershell'
  );
  t.after(() => builtin.hoistPath && rmSync(builtin.hoistPath, { force: true }));
  assert.ok(builtin.hoistPath, 'Node builtins resolve the same from any directory');
});

test('a foreground failure retains its hoisted script and refreshes reads when cleanup settles', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-hoist-lifecycle-'));
  const changed = join(root, 'output.txt');
  writeFileSync(changed, 'before execution');
  const completion = Promise.withResolvers();
  let hoistPath = null;
  t.after(async () => {
    completion.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    if (hoistPath) rmSync(hoistPath, { force: true });
    rmSync(root, { recursive: true, force: true });
    invalidateBuiltinResultCache();
  });

  // No process executes in this caller test. Keep platform snapshot/bootstrap
  // setup outside its execution seam while still passing the real hoisted file.
  t.mock.module('./invocation-plan.mjs', {
    namedExports: {
      async planShellInvocation({ command, resolvedSpec }) {
        return { execShell: resolvedSpec.shell, wrappedCommand: command, spawnEnv: process.env };
      },
    },
  });
  const shellCommand = await import('../../shell-command.mjs');
  t.mock.module('../../shell-command.mjs', {
    namedExports: {
      ...shellCommand,
      async execShellCommand(input) {
        hoistPath = input.command.match(/"([^"\n]*mixdog-inline-[^"\n]+\.cjs)"/)?.[1] || null;
        assert.ok(hoistPath, 'the real inline hoist reached shell execution');
        assert.ok(existsSync(hoistPath));
        return {
          stdout: '',
          stderr: 'fixture startup wiring failed after the child was created',
          exitCode: 1,
          killed: true,
          failurePhase: 'tool',
          failureReason: 'spawn failed',
          backgrounded: false,
          settled: completion.promise,
        };
      },
    },
  });
  // The original import above still serves the real shell cases. Only this
  // caller instance receives the controlled early-result/late-cleanup seam;
  // its hoist, artifact removal, effects and read caches remain real.
  const { executeBashTool: executeDeferredShell } = await import('../bash-tool.mjs?foreground-cleanup-lifecycle');
  const key = `foreground-hoist-${process.pid}`;
  invalidateBuiltinResultCache();
  cacheSet(key, 'before execution', { paths: [changed] });
  const result = await executeDeferredShell(
    { command: `node -e "require('node:fs').writeFileSync('output.txt', 'partial')"` },
    root
  );
  assert.match(String(result?.result ?? result), /fixture startup wiring failed/);
  assert.equal(cacheGet(key), null, 'the early result invalidates pre-command reads');

  // A caller can read partial effects while failed-startup cleanup is still
  // running. That read must be invalidated again at actual termination.
  writeFileSync(changed, 'partial');
  cacheSet(key, readFileSync(changed, 'utf8'), { paths: [changed] });
  const before = { scriptExists: existsSync(hoistPath), cached: cacheGet(key) };
  writeFileSync(changed, 'final effects');
  completion.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const after = { scriptExists: existsSync(hoistPath), cached: cacheGet(key) };
  assert.deepEqual(
    { before, after },
    { before: { scriptExists: true, cached: 'partial' }, after: { scriptExists: false, cached: null } }
  );
});
