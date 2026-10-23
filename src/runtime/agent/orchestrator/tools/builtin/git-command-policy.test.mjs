import assert from 'node:assert/strict';
import test from 'node:test';
import { _isGitMutationTool, _isMutationTool } from '../../session/loop/tool-classify.mjs';
import { gitCommandMutates } from './git-command-policy.mjs';

test('git mutation policy is shared by orchestration and evidence projection', () => {
  for (const command of ['git status', 'git log -5', 'git fsck --full', 'git clean -n', 'git config get user.name']) {
    assert.equal(gitCommandMutates({ command }), false, command);
    assert.equal(_isMutationTool('git', { command }), false, command);
    assert.equal(_isGitMutationTool('git', { command }), false, command);
  }
  for (const command of [
    'git add --all',
    'git commit -m test',
    'git prune --expire=now',
    'git reflog delete HEAD@{1}',
    'git fsck --lost-found',
    'git config --unset user.name',
    'git config unset user.name',
  ]) {
    assert.equal(gitCommandMutates({ command }), true, command);
    assert.equal(_isMutationTool('git', { command }), true, command);
    assert.equal(_isGitMutationTool('git', { command }), true, command);
  }
  assert.equal(gitCommandMutates({ command: 'git status && git clean -fd' }), true);
  const stage = { action: 'stage', diff_id: 'diff_test', change_ids: ['chg_test'] };
  assert.equal(gitCommandMutates(stage), true);
  assert.equal(_isMutationTool('git', stage), true);
  assert.equal(_isGitMutationTool('git', stage), true);
  assert.equal(gitCommandMutates({ ...stage, command: 'git status' }), true);
  assert.equal(gitCommandMutates(JSON.stringify(stage)), true);
  assert.equal(_isMutationTool('apply_patch', {}), true);
});

test('Git distinguishes output options from paths without losing positional mutations', () => {
  for (const command of ['git diff -- --output=filename.txt', 'git remote -v', 'git branch --list']) {
    assert.equal(gitCommandMutates({ command }), false, command);
  }
  for (const command of [
    'git diff --output=changes.patch -- file.txt',
    'git remote add local ../other',
    'git remote add -- local ../other',
    'git branch -- new-branch',
  ]) {
    assert.equal(gitCommandMutates({ command }), true, command);
  }
});

test('Git branch queries preserve read-only policy without hiding branch writes', () => {
  for (const command of [
    'git branch --show-current', 'git branch -v', 'git branch -vv', 'git branch -avv',
    'git branch --contains HEAD', 'git branch --no-contains=HEAD',
    'git branch --merged HEAD', 'git branch --no-merged', 'git branch --points-at HEAD',
    'git branch --format="%(refname:short)"', 'git branch --format "%(refname:short)"',
    'git branch --sort=-committerdate', 'git branch --sort refname --color=never',
    'git branch --list -- "feature/*"', 'git branch --no-abbrev --verbose',
  ]) {
    assert.equal(gitCommandMutates({ command }), false, command);
    assert.equal(_isMutationTool('git', { command }), false, command);
    assert.equal(_isGitMutationTool('git', { command }), false, command);
  }
  for (const command of [
    'git branch -v new-branch', 'git branch --format="%(refname:short)" new-branch',
    'git branch --sort refname new-branch', 'git branch -- new-branch',
    'git branch -vd old-branch', 'git branch -rD origin/old-branch',
    'git branch -v -m renamed', 'git branch --track=direct new-branch',
    'git branch --list --set-upstream-to=main topic',
    'git branch --list --unknown-option',
  ]) {
    assert.equal(gitCommandMutates({ command }), true, command);
    assert.equal(_isMutationTool('git', { command }), true, command);
    assert.equal(_isGitMutationTool('git', { command }), true, command);
  }
});
