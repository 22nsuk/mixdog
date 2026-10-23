import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { analyzeShellCommandEffects, preflightShellLargeFileProbe } from './shell-analysis.mjs';
import { resolveShellFor } from './shell-runtime.mjs';

function workDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-effects-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('path mutators and redirects report the paths they write', async (t) => {
  const dir = workDir(t);
  for (const [command, file] of [
    ['touch a.txt', 'a.txt'],
    ['echo hi > out.txt', 'out.txt'],
    ['echo hi | tee log.txt', 'log.txt'],
    ['cp a.txt b.txt', 'b.txt'],
  ]) {
    const effects = await analyzeShellCommandEffects(command, dir);
    assert.equal(effects.mutationMode, 'paths', command);
    assert.ok(effects.paths.includes(join(dir, file)), `${command}: ${JSON.stringify(effects.paths)}`);
  }
});

test('a mutator without resolvable path arguments is a global mutation', async (t) => {
  const effects = await analyzeShellCommandEffects('rm', workDir(t));
  assert.equal(effects.mutationMode, 'global');
});

test('grep -A/-B/-C values are option values, not the pattern', async (t) => {
  const dir = workDir(t);
  // A large file named like the pattern: probing it as a target would block.
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(64 * 1024));
  writeFileSync(join(dir, 'small.txt'), 'x\n');
  for (const flag of ['-A', '-B', '-C']) {
    assert.equal(await preflightShellLargeFileProbe(`grep ${flag} 5 big.txt small.txt`, dir), null, flag);
  }
  // The large file as a real target is still probed.
  const blocked = await preflightShellLargeFileProbe('grep -A 5 needle big.txt', dir);
  assert.equal(blocked?.path, join(dir, 'big.txt'));
});

test('read-only commands and cd leave nothing mutated', async (t) => {
  const dir = workDir(t);
  const effects = await analyzeShellCommandEffects('cat a.txt', dir);
  assert.deepEqual(effects, { mutationMode: 'none', paths: [], finalCwd: dir });
});

test('find with -delete/-exec*/-ok*/-fprint* and mutating awk programs are not read-only', async (t) => {
  const dir = workDir(t);
  for (const command of [
    'find . -name "*.tmp" -delete',
    'find . -name x -exec rm {} \\;',
    'find . -name x -execdir rm {} +',
    'find . -name x -ok rm {} \\;',
    'find . -fprint out.txt',
    'awk \'BEGIN { system("rm a.txt") }\' a.txt',
    'awk \'{ print > "out.txt" }\' a.txt',
    'awk \'{ print | "sh" }\' a.txt',
    'gawk \'{ print >> "out.txt" }\' a.txt',
    'powershell -Command "find . -delete"',
    'bash -c "awk \'{ print > \\"o\\" }\' a.txt"',
  ]) {
    const effects = await analyzeShellCommandEffects(command, dir);
    assert.notEqual(effects.mutationMode, 'none', command);
  }
});

test('plain find and awk stay read-only', async (t) => {
  const dir = workDir(t);
  for (const command of ['find . -name "*.js"', "awk '{ print $1 }' a.txt", "awk -F, '{ print $2 }' a.txt"]) {
    const effects = await analyzeShellCommandEffects(command, dir);
    assert.equal(effects.mutationMode, 'none', command);
  }
});

test('sort output options are mutations, including in a redirected stage', async (t) => {
  const dir = workDir(t);
  for (const command of [
    'sort -o out.txt input.txt',
    'sort -oout.txt input.txt',
    'sort -ro out.txt input.txt',
    'sort --output out.txt input.txt',
    'sort --output=out.txt input.txt',
    'sort -o out.txt input.txt > capture.txt',
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir)).mutationMode, 'global', command);
  }
});

test('Git writes cannot inherit a read-only command classification', async (t) => {
  const dir = workDir(t);
  for (const command of [
    'git diff --output=changes.patch -- file.txt',
    'git diff --output changes.patch -- file.txt',
    'git show --output=changes.patch HEAD',
    'git log -p --output=changes.patch',
    'git diff --output=changes.patch -- file.txt > capture.txt',
    'git remote add local ../other',
    'git remote set-url local ../other',
    'git remote remove local',
    'git branch new-branch',
    'git branch -a -D old-branch',
    'git status; git remote add local ../other',
    'git remote add local ../other > capture.txt',
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir)).mutationMode, 'global', command);
  }
});

test('PowerShell callbacks cannot inherit the outer command\'s read-only classification', async (t) => {
  const dir = workDir(t);
  for (const command of [
    'echo beta,alpha | Sort-Object -Property { node key.cjs $_ }',
    'echo beta,alpha | Sort-Object -Property @{ Expression = { node key.cjs $_ } }',
    'echo beta,alpha | Sort-Object -Property { node key.cjs $_ } > sorted.txt',
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir)).mutationMode, 'global', command);
  }
});

test('plain Git reads, PowerShell sorting and quoted callbacks remain read-only', async (t) => {
  const dir = workDir(t);
  for (const command of [
    'git status --short',
    'git diff -- file.txt',
    'git diff --output-indicator-new=x -- file.txt',
    'git diff -- --output=filename.txt',
    'git show --stat HEAD',
    'git log -1',
    'git branch --list',
    'git branch --show-current',
    'git branch -vv',
    'git branch --contains HEAD',
    'git branch --format="%(refname:short)"',
    'git remote -v',
    'git remote get-url local',
    'echo beta,alpha | Sort-Object',
    'echo beta,alpha | Sort-Object -Property Length',
    'echo \'{ node key.cjs $_ }\'',
    'echo "{ literal }"',
    'echo ${HOME}',
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir)).mutationMode, 'none', command);
  }
});

test('comments do not contribute execution, mutation options or redirects', async (t) => {
  const dir = workDir(t);
  for (const command of [
    'echo beta,alpha | Sort-Object # { records }',
    'echo observed # $(node build.cjs) `node build.cjs` > ignored.txt',
    '# an unmatched quote: \' {\necho observed',
    'git diff -- file.txt # --output=ignored.patch',
    'git remote -v # add local ../other',
    'echo "quoted # text" # { records }',
    "echo 'quoted # text' # { records }",
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir)).mutationMode, 'none', command);
  }
  const redirected = await analyzeShellCommandEffects('echo observed > out.txt # { records }', dir);
  assert.equal(redirected.mutationMode, 'paths');
  assert.deepEqual(redirected.paths, [join(dir, 'out.txt')]);
});

test('comments do not hide live mutations or nested execution', async (t) => {
  const dir = workDir(t);
  for (const command of [
    'echo observed # { records }\ngit remote add local ../other',
    'echo observed # ignored\nnode build.cjs',
    'echo "# $(node build.cjs)"',
    "echo '# literal'; git remote add local ../other",
    'echo word#literal; git remote add local ../other',
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir)).mutationMode, 'global', command);
  }
});

for (const [prefix, writes] of [
  [String.raw`echo \ #tag`, true],
  [String.raw`echo \;#tag`, true],
  [String.raw`echo \|#tag`, true],
  [String.raw`echo \&#tag`, true],
  [String.raw`echo \\ #tag`, false],
  ['echo word\\\n#tag', true],
  ['echo \\\n#tag', false],
]) {
  test(`Bash comment boundaries preserve escaped tokens: ${JSON.stringify(prefix)}`, async (t) => {
    const bash = resolveShellFor('bash');
    if (!bash) return t.skip('requires Bash or Git Bash');
    const dir = workDir(t);
    const command = `${prefix}; echo changed > out.txt`;
    // Feed the script unchanged; Windows argv quoting can consume backslashes.
    execFileSync(bash.shell, ['-s'], { input: command, cwd: dir, timeout: 10_000, windowsHide: true });
    assert.equal(existsSync(join(dir, 'out.txt')), writes);
    if (writes) assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8').trim(), 'changed');
    const effects = await analyzeShellCommandEffects(command, dir);
    assert.equal(effects.mutationMode, writes ? 'paths' : 'none');
    assert.deepEqual(effects.paths, writes ? [join(dir, 'out.txt')] : []);
  });
}

test('nested shell execution cannot inherit the outer command\'s read-only classification', async (t) => {
  const dir = workDir(t);
  for (const command of [
    'echo "$(node build.cjs)"',
    'echo `node build.cjs`',
    'echo (node build.cjs)',
    'echo $(node build.cjs)',
    'cat <(node build.cjs)',
    'cd "$(node build.cjs)"',
    'echo "$(node build.cjs)" > capture.txt',
    'echo (node build.cjs) > capture.txt',
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir)).mutationMode, 'global', command);
  }
});

test('literal shell syntax and sort without output options remain read-only', async (t) => {
  const dir = workDir(t);
  for (const command of [
    'echo \'$(node build.cjs)\'',
    'echo \'`node build.cjs`\'',
    'echo "(literal)"',
    'sort -r input.txt',
    'sort -- -output.txt',
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir)).mutationMode, 'none', command);
  }
});
