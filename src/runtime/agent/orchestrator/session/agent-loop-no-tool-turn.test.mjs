// Behavioral coverage for the no-tool-turn recovery ladders and the assistant
// echo payloads, driven through the public agentLoop entry point (see
// ./loop/no-tool-turn.mjs and ./loop/assistant-commit.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentLoop } from './agent-loop.mjs';
import { setInternalToolsProvider } from '../internal-tools.mjs';

const MAX_OUTPUT_EXHAUSTED_NOTICE =
  '[mixdog-runtime] The model hit its output limit and the response stayed truncated after 3 recovery attempts.';

function leadSession(extra = {}) {
  return {
    id: 'no-tool-turn-test',
    owner: 'cli',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
    ...extra,
  };
}

// Replays `script` per send; the last entry repeats for every further send so a
// runaway guard can be observed without hardcoding the cap in the fixture.
// `escalated` (number|null) is what the provider offers as a higher one-shot
// max_tokens; `state.requests` records what each send was asked for.
function scriptedProvider(script, { escalated = null } = {}) {
  const state = { sends: 0, requests: [] };
  return {
    state,
    escalatedMaxTokens: () => escalated,
    async send(messages, _model, _tools, sendOpts) {
      state.requests.push({ override: sendOpts?.maxOutputTokensOverride, messageCount: messages.length });
      state.sends += 1;
      const entry = script[Math.min(state.sends, script.length) - 1];
      return typeof entry === 'function' ? entry(state.sends) : entry;
    },
  };
}

function run(provider, messages, { tools = [], cwd = process.cwd(), ...opts } = {}) {
  return agentLoop(provider, messages, 'fake-model', tools, null, cwd, {
    session: leadSession(),
    sessionId: 'no-tool-turn-test',
    ...opts,
  });
}

function toolFixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-output-progress-'));
  const sessionId = `output-progress-${randomUUID()}`;
  const file = join(cwd, 'file.txt');
  writeFileSync(file, 'ORIGINAL\n');
  const tools = [
    { name: 'read', annotations: { readOnlyHint: true } },
    { name: 'shell' },
    { name: 'Bash' },
    { name: 'session' },
  ];
  const dispose = setInternalToolsProvider({
    scopeId: sessionId,
    tools: [{ name: 'session' }],
    executor: async () => 'Session ready.',
  });
  t.after(() => {
    dispose();
    rmSync(cwd, { recursive: true, force: true });
  });
  return {
    file,
    options: { tools, cwd, sessionId, session: leadSession({ id: sessionId, mcpScopeId: sessionId, cwd }) },
  };
}

function toolTurn(name, args, id = 'progress-tool') {
  return { content: '', toolCalls: [{ id, name, arguments: args }], stopReason: 'tool_calls' };
}

async function runToolAfterOutputCut(fx, name, args) {
  const messages = [{ role: 'user', content: 'perform the task and explain' }];
  const provider = scriptedProvider([emptyCut, emptyCut, toolTurn(name, args), emptyCut], { escalated: 128_000 });
  const result = await run(provider, messages, fx.options);
  const completed = messages.find((message) => message.toolCallId === 'progress-tool');
  assert.equal(completed?.toolKind, 'normal');
  return { provider, messages, result, completed };
}

function assertToolRecovery({ provider, messages, result }, resetsRecovery) {
  assert.equal(provider.state.sends, resetsRecovery ? 8 : 6);
  assert.equal(provider.state.requests.filter((request) => request.override === 128_000).length, resetsRecovery ? 2 : 1);
  assert.deepEqual(
    messages.filter((message) => message.meta?.source === 'max-output-recovery').map((message) => message.meta.attempt),
    resetsRecovery ? [1, 1, 2, 3] : [1, 2, 3]
  );
  assert.equal(result.terminationReason, 'truncated');
}

test('max-output ladder resumes three times, then seals the aggregate with the exhausted notice', async () => {
  const messages = [{ role: 'user', content: 'write' }];
  const surfaced = [];
  const provider = scriptedProvider([(send) => ({ content: `part${send}`, toolCalls: [], stopReason: 'length' })]);
  const result = await run(provider, messages, { onAssistantText: (text) => surfaced.push(text) });
  assert.equal(provider.state.sends, 4);
  assert.equal(result.maxOutputRecoveryAttempts, 3);
  assert.equal(result.historyContent, `part4\n\n${MAX_OUTPUT_EXHAUSTED_NOTICE}`);
  assert.equal(result.content, `part1part2part3part4\n\n${MAX_OUTPUT_EXHAUSTED_NOTICE}`);
  assert.equal(result.terminationReason, 'truncated');
  assert.deepEqual(surfaced, ['part1', 'part2', 'part3', 'part4']);
  const resumePrompts = messages.filter((message) => message.meta?.source === 'max-output-recovery');
  assert.deepEqual(
    resumePrompts.map((message) => message.meta.attempt),
    [1, 2, 3]
  );
});

test('a recovered max-output turn keeps every partial in the caller aggregate but not in history', async () => {
  const messages = [{ role: 'user', content: 'write' }];
  const provider = scriptedProvider([
    { content: 'part1', toolCalls: [], stopReason: 'length' },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 2);
  assert.equal(result.content, 'part1done');
  assert.equal(result.historyContent, 'done');
  assert.equal(result.maxOutputRecoveryAttempts, 1);
  assert.equal(messages.filter((message) => message.meta?.source === 'max-output-recovery').length, 1);
});

const emptyCut = { content: '', toolCalls: [], stopReason: 'max_tokens' };

test('an empty max_tokens turn escalates once with no nudge, then resumes three times at normal max_tokens', async () => {
  const messages = [{ role: 'user', content: 'think hard' }];
  const provider = scriptedProvider([emptyCut], { escalated: 128_000 });
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 5);
  const { requests } = provider.state;
  assert.deepEqual(
    requests.map((request) => request.override),
    [undefined, 128_000, undefined, undefined, undefined]
  );
  // The escalated re-send carries the same transcript: no message was added.
  assert.equal(requests[1].messageCount, requests[0].messageCount);
  // Every later send differs from its predecessor (a resume prompt each time).
  assert.deepEqual(
    requests.slice(2).map((request) => request.messageCount),
    [requests[0].messageCount + 1, requests[0].messageCount + 2, requests[0].messageCount + 3]
  );
  const prompts = messages.filter((message) => message.meta?.source === 'max-output-recovery');
  assert.equal(prompts.length, 3);
  assert.match(prompts[0].content, /Output token limit hit/);
  assert.match(prompts[0].content, /smaller pieces/);
  assert.equal(
    messages.some((message) => String(message.content).includes('Empty truncated continuation')),
    false
  );
  // Exhaustion ends the turn with a visible notice, not a silent stop.
  assert.equal(result.terminationReason, 'truncated');
  assert.equal(result.content, MAX_OUTPUT_EXHAUSTED_NOTICE);
  assert.equal(result.maxOutputRecoveryAttempts, 3);
});

test('no escalation is attempted when the provider has no higher limit', async () => {
  const messages = [{ role: 'user', content: 'think hard' }];
  const provider = scriptedProvider([emptyCut], { escalated: null });
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 4);
  assert.deepEqual(
    provider.state.requests.map((request) => request.override),
    [undefined, undefined, undefined, undefined]
  );
  assert.deepEqual(
    provider.state.requests.map((request) => request.messageCount),
    [1, 2, 3, 4]
  );
  assert.equal(result.terminationReason, 'truncated');
  assert.equal(result.content, MAX_OUTPUT_EXHAUSTED_NOTICE);
});

test('a truncated turn with text follows the same rule: escalate without keeping the partial, then resume', async () => {
  const messages = [{ role: 'user', content: 'write' }];
  const provider = scriptedProvider(
    [
      { content: 'part1', toolCalls: [], stopReason: 'max_tokens' },
      { content: 'part2', toolCalls: [], stopReason: 'max_tokens' },
      { content: 'done', toolCalls: [], stopReason: 'end_turn' },
    ],
    { escalated: 128_000 }
  );
  const result = await run(provider, messages);
  assert.deepEqual(
    provider.state.requests.map((request) => [request.override, request.messageCount]),
    [
      [undefined, 1],
      [128_000, 1],
      [undefined, 3],
    ]
  );
  assert.equal(result.content, 'part2done');
  assert.equal(result.historyContent, 'done');
  assert.equal(result.terminationReason, undefined);
});

test('a failed tool call does not reopen the output escalation or recovery budget', async () => {
  const provider = scriptedProvider(
    [
      emptyCut,
      emptyCut,
      { content: '', toolCalls: [{ id: 'c1', name: 'definitely_missing_no_tool_turn_tool', arguments: {} }] },
      emptyCut,
    ],
    { escalated: 128_000 }
  );
  const messages = [{ role: 'user', content: 'go' }];
  const result = await run(provider, messages);
  // The failed call used the first resume; later cuts consume the two
  // remaining resumes rather than receiving another escalation and ladder.
  assert.equal(provider.state.sends, 6);
  assert.deepEqual(
    provider.state.requests.map((request) => request.override),
    [undefined, 128_000, undefined, undefined, undefined, undefined]
  );
  assert.deepEqual(
    messages.filter((message) => message.meta?.source === 'max-output-recovery').map((message) => message.meta.attempt),
    [1, 2, 3]
  );
  assert.equal(result.terminationReason, 'truncated');
});

for (const { label, name, args, resetsRecovery } of [
  { label: 'a known read-only shell', name: 'shell', args: { command: 'echo observed' }, resetsRecovery: false },
  { label: 'a read-only Bash adapter call', name: 'Bash', args: { command: 'echo observed' }, resetsRecovery: false },
  { label: 'a successful metadata tool', name: 'session', args: {}, resetsRecovery: false },
  { label: 'a mutating shell', name: 'shell', args: { command: 'echo changed > changed.txt' }, resetsRecovery: true },
  {
    label: 'a mutating Bash adapter call',
    name: 'Bash',
    args: { command: 'echo changed > changed.txt' },
    resetsRecovery: true,
  },
  {
    label: 'a shell script with unknown effects',
    name: 'shell',
    args: { command: 'node -e "process.stdout.write(\'observed\')"' },
    resetsRecovery: true,
  },
]) {
  test(`${label} ${resetsRecovery ? 'reopens' : 'preserves'} the output recovery budget`, async (t) => {
    const fx = toolFixture(t);
    assertToolRecovery(await runToolAfterOutputCut(fx, name, args), resetsRecovery);
  });
}

for (const name of ['shell', 'Bash']) {
  test(`${name} restores output recovery after a build inside an echo expression`, async (t) => {
    const fx = toolFixture(t);
    writeFileSync(
      join(fx.options.cwd, 'build.cjs'),
      "require('node:fs').writeFileSync('built.txt', 'BUILT'); console.log('build complete');"
    );
    const command = process.platform === 'win32' ? 'echo (node build.cjs)' : 'echo "$(node build.cjs)"';
    const execution = await runToolAfterOutputCut(fx, name, { command });
    // The real shell, analysis, telemetry and batch completion all run; only
    // the provider's output-limit responses are scripted.
    assert.match(execution.completed.content, /build complete/);
    assert.equal(readFileSync(join(fx.options.cwd, 'built.txt'), 'utf8'), 'BUILT');
    assertToolRecovery(execution, true);
  });

  for (const { kind, sort, output = /alpha\r?\nbeta/, callback = false, redirected = false } of [
    { kind: 'plain', sort: 'Sort-Object' },
    { kind: 'callback', sort: 'Sort-Object -Property { node key.cjs $_ }', callback: true },
    { kind: 'commented', sort: 'Sort-Object # { records }' },
    { kind: 'alias property', sort: 'sort -Property Length', output: /beta\r?\nalpha/ },
    { kind: 'alias top', sort: 'sort -Top 1', output: /(?:^|\n)alpha\r?\n/ },
    { kind: 'alias callback', sort: 'sort -Property { node key.cjs $_ }', callback: true },
    { kind: 'alias redirect', sort: 'sort -Property Length > sorted.txt', output: /beta\r?\nalpha/, redirected: true },
  ]) {
    test(`${name} ${callback || redirected ? 'restores' : 'preserves'} output recovery after ${kind} PowerShell sorting`, {
      skip: process.platform !== 'win32' && 'requires the native PowerShell shell path',
    }, async (t) => {
      const fx = toolFixture(t);
      writeFileSync(
        join(fx.options.cwd, 'key.cjs'),
        "require('node:fs').appendFileSync('key-cache.txt', process.argv[2] + '\\n'); console.log(process.argv[2]);"
      );
      const command = `echo beta,alpha | ${sort}`;
      const execution = await runToolAfterOutputCut(fx, name, { command });
      const sortedFile = join(fx.options.cwd, 'sorted.txt');
      assert.equal(existsSync(sortedFile), redirected);
      assert.match(redirected ? readFileSync(sortedFile, 'utf8') : execution.completed.content, output);
      const cacheFile = join(fx.options.cwd, 'key-cache.txt');
      assert.equal(existsSync(cacheFile), callback);
      if (callback) {
        const keys = readFileSync(cacheFile, 'utf8');
        assert.match(keys, /alpha/);
        assert.match(keys, /beta/);
      }
      assertToolRecovery(execution, callback || redirected);
    });
  }

  for (const outputFile of [false, true]) {
    test(`${name} ${outputFile ? 'restores' : 'preserves'} output recovery after git diff ${outputFile ? 'with' : 'without'} --output`, async (t) => {
      const fx = toolFixture(t);
      // No commit, hooks or remotes: diff the working file against a fresh index.
      execFileSync('git', ['init', '--quiet'], { cwd: fx.options.cwd });
      execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '--', 'file.txt'], { cwd: fx.options.cwd });
      writeFileSync(fx.file, 'UPDATED\n');
      const command = `git diff --no-ext-diff --no-textconv${outputFile ? ' --output=changes.patch' : ''} -- file.txt`;
      const execution = await runToolAfterOutputCut(fx, name, { command });
      const patchFile = join(fx.options.cwd, 'changes.patch');
      assert.equal(existsSync(patchFile), outputFile);
      const patch = outputFile ? readFileSync(patchFile, 'utf8') : execution.completed.content;
      assert.match(patch, /-ORIGINAL/);
      assert.match(patch, /\+UPDATED/);
      assertToolRecovery(execution, outputFile);
    });
  }

  test(`${name} restores output recovery after Git config changes without the Git tool`, async (t) => {
    const fx = toolFixture(t);
    assert.equal(fx.options.tools.some((tool) => tool.name === 'git'), false);
    execFileSync('git', ['init', '--quiet'], { cwd: fx.options.cwd });
    const execution = await runToolAfterOutputCut(fx, name, { command: 'git remote add local ../other' });
    assert.equal(
      execFileSync('git', ['config', '--local', '--get', 'remote.local.url'], { cwd: fx.options.cwd, encoding: 'utf8' }).trim(),
      '../other'
    );
    assertToolRecovery(execution, true);
  });

  for (const options of ['--show-current', '-vv', '--contains HEAD', '--format="%(refname:short)"']) {
    test(`${name} preserves output recovery after Git branch query ${options}`, async (t) => {
      const fx = toolFixture(t);
      execFileSync('git', ['init', '--quiet', '--initial-branch=main', '--template='], { cwd: fx.options.cwd });
      execFileSync('git', [
        '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'core.hooksPath=.git/no-hooks', '-c', 'commit.gpgsign=false',
        'commit', '--allow-empty', '--quiet', '-m', 'initial',
      ], { cwd: fx.options.cwd });
      const execution = await runToolAfterOutputCut(fx, name, { command: `git branch ${options}` });
      assert.match(execution.completed.content, /main/);
      assertToolRecovery(execution, false);
    });
  }

  for (const [command, writes] of [
    [String.raw`echo \ #tag; echo changed > changed.txt`, true],
    [String.raw`echo \\ #tag; echo ignored > changed.txt`, false],
  ]) {
    test(`${name} respects Bash comment boundaries in output recovery (${writes})`, {
      skip: process.platform === 'win32' && 'requires the native POSIX default shell path',
    }, async (t) => {
      const fx = toolFixture(t);
      const execution = await runToolAfterOutputCut(fx, name, { command });
      const file = join(fx.options.cwd, 'changed.txt');
      assert.equal(existsSync(file), writes);
      if (writes) assert.equal(readFileSync(file, 'utf8').trim(), 'changed');
      assertToolRecovery(execution, writes);
    });
  }
}

for (const changed of [false, true]) {
  const label = changed ? 'a fresh read result reopens' : 'a repeated read receipt preserves';
  test(`${label} the output recovery budget`, async (t) => {
    const fx = toolFixture(t);
    const messages = [{ role: 'user', content: 'inspect' }];
    const args = { file_path: fx.file };
    const provider = scriptedProvider(
      [
        toolTurn('read', args, 'read-seed'),
        emptyCut,
        emptyCut,
        () => {
          if (changed) writeFileSync(fx.file, 'NEW EVIDENCE\n');
          return toolTurn('read', args, 'read-after-cut');
        },
        emptyCut,
      ],
      { escalated: 128_000 }
    );
    const result = await run(provider, messages, fx.options);
    assert.equal(
      messages.find((message) => message.toolCallId === 'read-after-cut')?.toolKind,
      changed ? 'normal' : 'skipped'
    );
    assert.equal(provider.state.sends, changed ? 9 : 7);
    assert.equal(provider.state.requests.filter((request) => request.override === 128_000).length, changed ? 2 : 1);
    assert.deepEqual(
      messages.filter((message) => message.meta?.source === 'max-output-recovery').map((message) => message.meta.attempt),
      changed ? [1, 1, 2, 3] : [1, 2, 3]
    );
    assert.equal(result.terminationReason, 'truncated');
  });
}

test('normal text continuation still reopens the output recovery budget', async () => {
  const provider = scriptedProvider(
    [emptyCut, emptyCut, { content: 'Continuing the answer.', toolCalls: [], endTurn: false }, emptyCut],
    { escalated: 128_000 }
  );
  const result = await run(provider, [{ role: 'user', content: 'go' }]);
  assert.equal(provider.state.sends, 8);
  assert.equal(provider.state.requests.filter((request) => request.override === 128_000).length, 2);
  assert.equal(result.providerContinuations, 1);
  assert.equal(result.terminationReason, 'truncated');
});

test('new user input after a read-only tool batch reopens the output recovery budget', async (t) => {
  const fx = toolFixture(t);
  const messages = [{ role: 'user', content: 'go' }];
  const pending = [];
  const steered = [];
  const provider = scriptedProvider(
    [
      emptyCut,
      emptyCut,
      () => {
        pending.push({ id: 'new-requirement', content: 'Include the new requirement in your answer.' });
        return toolTurn('shell', { command: 'echo observed' });
      },
      emptyCut,
    ],
    { escalated: 128_000 }
  );
  const result = await run(provider, messages, {
    ...fx.options,
    drainSteering: (_sessionId, options) => {
      steered.push(options.stage);
      return pending.splice(0);
    },
  });
  assert.ok(steered.includes('pre-send'));
  const injected = messages.find((message) => message.meta?.source === 'steering');
  assert.deepEqual(injected?.meta.submissionIds, ['new-requirement']);
  assert.equal(provider.state.sends, 8);
  assert.equal(provider.state.requests.filter((request) => request.override === 128_000).length, 2);
  assert.deepEqual(
    messages.filter((message) => message.meta?.source === 'max-output-recovery').map((message) => message.meta.attempt),
    [1, 1, 2, 3]
  );
  assert.equal(result.terminationReason, 'truncated');
});

test('one refusal is retried with a policy reminder and its partial text is preserved', async () => {
  const messages = [{ role: 'user', content: 'ask' }];
  const provider = scriptedProvider([
    { content: 'partial narration', toolCalls: [], stopReason: 'refusal' },
    { content: 'safe answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 2);
  assert.equal(result.content, 'partial narrationsafe answer');
  assert.equal(result.historyContent, 'safe answer');
  assert.equal(result.terminationReason, undefined);
  const recovery = messages.filter((message) => message.meta?.source === 'refusal-recovery');
  assert.equal(recovery.length, 1);
  assert.match(recovery[0].content, /safety classifier/);
});

test('a refusal that survives the retry ends the loop as a refusal termination', async () => {
  const provider = scriptedProvider([{ content: '', toolCalls: [], stopReason: 'refusal' }]);
  const result = await run(provider, [{ role: 'user', content: 'ask' }]);
  assert.equal(provider.state.sends, 2);
  assert.equal(result.terminationReason, 'refusal');
});

test('text-only provider continuations are capped and the last text becomes the final answer', async () => {
  const messages = [{ role: 'user', content: 'go' }];
  const provider = scriptedProvider([{ content: 'seg', toolCalls: [], endTurn: false }]);
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 9);
  assert.equal(result.providerContinuations, 8);
  assert.equal(result.content, 'seg'.repeat(9));
  assert.equal(result.historyContent, 'seg');
  assert.equal(messages.filter((message) => message.role === 'assistant').length, 8);
});

test('empty turns are nudged three times before an explicit empty termination', async () => {
  const messages = [{ role: 'user', content: 'go' }];
  const provider = scriptedProvider([{ content: '', toolCalls: [], stopReason: 'end_turn' }]);
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 4);
  assert.equal(result.terminationReason, 'empty');
  const nudges = messages.filter(
    (message) => typeof message.content === 'string' && message.content.startsWith('[mixdog-runtime] Empty response')
  );
  assert.equal(nudges.length, 3);
  assert.match(nudges[0].content, /\(1\/3\)/);
  assert.match(nudges[2].content, /\(3\/3\)/);
});

test('an executed tool batch reseals the text aggregate and resets the continuation budget', async () => {
  const provider = scriptedProvider([
    { content: 'mid-turn note', toolCalls: [], endTurn: false },
    {
      content: '',
      toolCalls: [{ id: 'c1', name: 'definitely_missing_no_tool_turn_tool', arguments: {} }],
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const result = await run(provider, [{ role: 'user', content: 'go' }]);
  assert.equal(provider.state.sends, 3);
  assert.equal(result.providerContinuations, 1);
  // The UI sealed its row at the tool boundary: the pre-tool segment must not
  // be re-prepended to the terminal answer.
  assert.equal(result.content, 'done');
  assert.equal(result.historyContent, undefined);
});

test('a message sent while the final text streams is read right after it, inside the same turn', async () => {
  const messages = [{ role: 'user', content: 'explain' }];
  const pending = [];
  const steered = [];
  const provider = scriptedProvider([
    () => {
      // The user sends while this text streams: it waits in the host queue.
      pending.push({ id: 'sub-1', content: 'add a one-line summary', submittedAt: Date.now() });
      return { content: 'first answer', toolCalls: [], stopReason: 'end_turn' };
    },
    { content: 'summary added', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const result = await run(provider, messages, {
    drainSteering: (_sessionId, options) => {
      steered.push(options.stage);
      return pending.splice(0);
    },
    onSteerMessage: () => {},
  });
  assert.equal(provider.state.sends, 2, 'one agentLoop call answers both: the turn continued');
  assert.ok(steered.includes('terminal'), 'delivered at the boundary after the streamed message');
  const roles = messages.map((message) => [message.role, message.meta?.source ?? '', message.content]);
  assert.deepEqual(roles.slice(1, 3), [
    ['assistant', '', 'first answer'],
    ['user', 'steering', 'add a one-line summary'],
  ]);
  assert.deepEqual(messages[2].meta.submissionIds, ['sub-1']);
  assert.equal(result.historyContent ?? result.content, 'summary added');
});

test('tool-call and continuation turns echo provider replay payloads under one precedence rule', async () => {
  const thinkingBlocks = [{ type: 'thinking', thinking: 'weigh options', signature: 'sig-1' }];
  const committed = [];
  const provider = scriptedProvider([
    {
      content: '',
      thinkingBlocks,
      assistantBlocks: [
        ...thinkingBlocks,
        { type: 'tool_use', id: 'c1', name: 'definitely_missing_echo_tool', input: {} },
      ],
      toolCalls: [{ id: 'c1', name: 'definitely_missing_echo_tool', arguments: {} }],
    },
    { content: 'mid', toolCalls: [], thinkingBlocks, endTurn: false },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  await run(provider, [{ role: 'user', content: 'go' }], {
    onAssistantMessageCommitted: (message) => committed.push(message),
  });
  assert.equal(provider.state.sends, 3);
  // Tool-call turn: ordered blocks win, so the flattened copy is dropped.
  assert.equal(committed[0].assistantBlocks?.length, 2);
  assert.equal(committed[0].thinkingBlocks, undefined);
  assert.equal(committed[0].toolCalls?.[0]?.name, 'definitely_missing_echo_tool');
  // Continuation turn: no ordered blocks, so the signed thinking replay is
  // stored verbatim for the resumed turn.
  assert.deepEqual(committed[1].thinkingBlocks, thinkingBlocks);
  assert.equal(committed[1].assistantBlocks, undefined);
  assert.equal(committed[1].content, 'mid');
});
