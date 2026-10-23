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

test('PowerShell sort options are reads while redirects, callbacks and external wrappers still mutate', async (t) => {
  const dir = workDir(t);
  const options = { shellType: 'powershell' };
  for (const command of [
    'echo beta,alpha | sort -Property Length',
    'echo beta,alpha | SORT -PROPERTY Length',
    'echo beta,alpha | sort -Top 1',
    'echo beta,alpha | sort -Bottom 1',
    'echo beta,alpha | sort -OutVariable sorted',
    'echo beta,alpha | sort -ov sorted',
    'sort -InputObject beta -Property Length',
    'echo beta,alpha | sort -Property Length # { records }',
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir, options)).mutationMode, 'none', command);
  }
  const redirected = await analyzeShellCommandEffects(
    'echo beta,alpha | sort -Property Length > sorted.txt', dir, options
  );
  assert.equal(redirected.mutationMode, 'paths');
  assert.deepEqual(redirected.paths, [join(dir, 'sorted.txt')]);
  for (const command of [
    'echo beta,alpha | sort -Property { node key.cjs $_ }',
    'echo beta,alpha | sort -Property @{ Expression = { node key.cjs $_ } }',
    'env sort -o out.txt input.txt',
    'command sort -o out.txt input.txt',
    'sudo sort -ro out.txt input.txt > capture.txt',
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir, options)).mutationMode, 'global', command);
  }
});

test('POSIX sort output options still classify actual file writes as mutations', async (t) => {
  const bash = resolveShellFor('bash');
  if (!bash) return t.skip('requires Bash or Git Bash');
  const dir = workDir(t);
  writeFileSync(join(dir, 'input.txt'), 'beta\nalpha\n');
  for (const [command, expected] of [
    ['sort -o out.txt input.txt', 'alpha\nbeta'],
    ['sort -ro out.txt input.txt', 'beta\nalpha'],
  ]) {
    execFileSync(bash.shell, ['-s'], { input: command, cwd: dir, timeout: 10_000, windowsHide: true });
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8').trim(), expected);
    assert.equal((await analyzeShellCommandEffects(command, dir, { shellType: 'posix' })).mutationMode, 'global');
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

for (const [shellType, command, mode] of [
  ['powershell', String.raw`ls ".\"`, 'none'],
  ['powershell', String.raw`ls '.\'`, 'none'],
  ['powershell', "echo 'don''t # literal'", 'none'],
  ['powershell', 'echo `"literal`"', 'none'],
  ['powershell', 'echo “quoted # literal”', 'none'],
  ['powershell', 'echo ‘quoted # literal’', 'none'],
  ['powershell', String.raw`echo \ # ignored; echo changed > out.txt`, 'none'],
  ['posix', String.raw`echo \ # literal; echo changed > out.txt`, 'paths'],
  ['powershell', 'echo "word"# ignored; echo changed > out.txt', 'none'],
  ['posix', 'echo "word"# literal; echo changed > out.txt', 'paths'],
  ['powershell', "echo 'don''t # literal'; echo changed > out.txt", 'paths'],
  ['powershell', 'echo `"# literal`"; echo changed > out.txt', 'paths'],
  ['powershell', 'echo “quoted # literal”; echo changed > out.txt', 'paths'],
  ['powershell', 'echo ‘quoted # literal’; echo changed > out.txt', 'paths'],
  ['powershell', 'echo word"quoted"#tag; echo changed > out.txt', 'paths'],
  ['powershell', "echo word'quoted'#tag; echo changed > out.txt", 'paths'],
  ['powershell', 'echo --flag="quoted"#tag; echo changed > out.txt', 'paths'],
  ['powershell', 'echo FIRST`\r\necho changed > out.txt', 'global'],
  ['powershell', 'echo `\r\nchanged > out.txt', 'paths'],
  ['powershell', 'echo 1 <# ignored #>; echo changed > out.txt', 'global'],
  ['powershell', "echo @'\n# literal\n'@; echo changed > out.txt", 'global'],
  ['posix', String.raw`echo $'don\'t # literal'; echo changed > out.txt`, 'paths'],
  ['posix', String.raw`echo $'hello\n'`, 'none'],
  ['posix', String.raw`echo $'don\'t # literal'`, 'none'],
  ['posix', String.raw`echo pre$'a b'post`, 'none'],
  ['posix', String.raw`echo $'$(touch should-not-exist) # ; >'`, 'none'],
  ['posix', String.raw`echo changed > $'out\x2etxt'`, 'paths'],
  ['posix', String.raw`sort $'\055o' out.txt input.txt`, 'global'],
  ['posix', String.raw`sort $'\x2do' out.txt input.txt`, 'global'],
  ['posix', 'echo observed & echo changed > out.txt', 'paths'],
  ['posix', 'cat <<EOF\n# literal\nEOF\necho changed > out.txt', 'global'],
  ...['powershell', 'posix'].flatMap((shellType) => [
    [shellType, 'echo ">" out.txt', 'none'],
    [shellType, 'echo "tee" out.txt', 'none'],
    [shellType, 'echo "literal; # text"', 'none'],
    [shellType, 'cd "$PWD"; pwd', 'none'],
    [shellType, 'cd "$PWD"; echo changed > out.txt', 'global'],
  ]),
]) {
  test(`effect lexing agrees with native ${shellType}: ${JSON.stringify(command)}`, async (t) => {
    const spec = resolveShellFor(shellType === 'powershell' ? 'powershell' : 'bash');
    if (!spec) return t.skip(`requires ${shellType}`);
    const dir = workDir(t);
    writeFileSync(join(dir, 'input.txt'), 'changed\n');
    // Bash reads stdin so Windows argv quoting cannot change backslashes.
    const args = shellType === 'powershell' ? [...spec.shellArgs, command] : ['-s'];
    execFileSync(spec.shell, args, {
      input: shellType === 'powershell' ? undefined : command,
      cwd: dir, timeout: 10_000, windowsHide: true,
    });
    const writes = mode !== 'none';
    assert.equal(existsSync(join(dir, 'out.txt')), writes, 'native file effect');
    assert.equal(existsSync(join(dir, 'should-not-exist')), false);
    if (writes) assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8').trim(), 'changed');
    const effects = await analyzeShellCommandEffects(command, dir, spec);
    assert.equal(effects.mutationMode, mode);
    assert.deepEqual(effects.paths, mode === 'paths' ? [join(dir, 'out.txt')] : []);
  });
}

test('redirects do not narrow an unknown script to its stdout file', async (t) => {
  const dir = workDir(t);
  for (const shellType of ['powershell', 'posix']) {
    const effects = await analyzeShellCommandEffects('node build.cjs > log.txt', dir, { shellType });
    assert.equal(effects.mutationMode, 'global');
  }
});

test('unsupported ANSI-C byte and control encodings stay conservative', async (t) => {
  const dir = workDir(t);
  for (const command of [
    String.raw`echo $'\0'`, String.raw`echo $'\400'`, String.raw`echo $'\xff'`,
    String.raw`echo $'\cA'`, String.raw`echo $'\uD800'`, String.raw`echo $'\U00110000'`,
    String.raw`sort $'\u002do' out.txt input.txt`, String.raw`sort $'\x{2d}o' out.txt input.txt`,
  ]) {
    assert.equal((await analyzeShellCommandEffects(command, dir, { shellType: 'posix' })).mutationMode, 'global');
  }
});

test('a generic POSIX fallback cannot assume Bash ANSI-C quoting', async (t) => {
  const dir = workDir(t);
  const spec = { shellType: 'posix', shell: '/bin/sh' };
  assert.equal((await analyzeShellCommandEffects(String.raw`echo changed > $'out\x2etxt'`, dir, spec)).mutationMode, 'global');
  assert.equal((await analyzeShellCommandEffects('echo observed', dir, spec)).mutationMode, 'none');
});
