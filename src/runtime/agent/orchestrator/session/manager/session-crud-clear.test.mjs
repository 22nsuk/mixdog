import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-clear-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_HOME = root;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(join(root, 'sessions'));
writeFileSync(join(root, 'mixdog-config.json'), JSON.stringify({ agent: { instructionFiles: 'agents' } }));
delete process.env.MIXDOG_BOOT_INSTRUCTION_FILES;
const { deleteSession, drainSessionStore, evictLiveSession, loadSession, saveSessionAsync } =
  await import('../store.mjs');
const { SUMMARY_PREFIX } = await import('../compact.mjs');
const { clearSessionMessages } = await import('./session-crud.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');
const { createSession, resumeSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
const { buildShellSpawnEnv } = await import('../../tools/builtin/bash-tool/spawn-env.mjs');
const { sessionScratchDir } = await import('../../../../shared/session-scratch.mjs');
const { closeSessionSearch } = await import('../../../../session-search/session-search-ingest.mjs');
const { settleTurnCheckpointWrites } = await import('./turn-checkpoint.mjs');
const { applyPendingWorkspaceReroot } = await import('./prompt-utils.mjs');
const { recordContextUsageSnapshot } = await import('../loop/compact-policy.mjs');

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
});

// Real turns also queue cache/store writes. Keep their data directory pinned
// until exit, then remove it after the store's own exit drain.
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const storedSessions = () =>
  readdirSync(join(root, 'sessions'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(root, 'sessions', name), 'utf8')));

async function plantSession(id, messages) {
  const session = {
    id,
    provider: 'openai',
    model: 'gpt-test',
    cwd: root,
    messages,
    generation: 0,
    closed: false,
    totalInputTokens: 120,
    lastContextTokens: 77,
    providerState: { responseId: 'r1' },
    _providerPrefixGuardState: { prefix: 3 },
  };
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return session;
}

test('a plain clear keeps the system layer, resets accounting and forks the outgoing transcript', async () => {
  const id = `sess_clear_plain_${process.pid}_${Date.now()}`;
  const transcript = [
    { role: 'system', content: 'memory layer' },
    { role: 'user', content: 'hello there' },
    { role: 'assistant', content: 'hi' },
  ];
  await plantSession(id, transcript);

  const cleared = await clearSessionMessages(id);
  assert.equal(cleared.id, id);
  assert.deepEqual(cleared.messages, [{ role: 'system', content: 'memory layer' }]);
  assert.equal(cleared.totalInputTokens, 0);
  assert.equal(cleared.lastContextTokens, 0);
  assert.equal(cleared.providerState, undefined);
  assert.equal('_providerPrefixGuardState' in cleared, false);
  assert.equal(cleared.compaction.lastStage, 'auto_clear');
  assert.equal(cleared.compaction.lastClearCompactError, null);
  assert.ok(cleared.compaction.lastClearAt > 0);

  drainSessionStore();
  const fork = storedSessions().find((s) => s.id !== id && s.messages?.length === 3);
  assert.ok(fork, 'the outgoing transcript is forked into a resumable session');
  assert.deepEqual(
    fork.messages.map((m) => m.content),
    transcript.map((m) => m.content)
  );
  assert.equal(fork.closed, false);
  assert.equal(fork.totalInputTokens, 0);
});

test('a clear that carries a compact summary forward keeps it and does not fork', async () => {
  const id = `sess_clear_summary_${process.pid}_${Date.now()}`;
  const before = storedSessions().length;
  await plantSession(id, [
    { role: 'system', content: 'memory layer' },
    { role: 'user', content: `${SUMMARY_PREFIX} earlier work summary` },
  ]);

  const cleared = await clearSessionMessages(id, { compact: true, keepCompactSummary: true });
  assert.deepEqual(
    cleared.messages.map((m) => m.role),
    ['system', 'user']
  );
  assert.match(cleared.messages[1].content, /earlier work summary/);
  drainSessionStore();
  assert.equal(storedSessions().length, before + 1, 'no fork for a summary-only transcript');
});

test('archiveAs keeps the outgoing transcript under that id, durable before the wipe', async () => {
  const id = 'sess_home_github-watcher';
  const archiveAs = `sess_${process.pid}_${Date.now()}_archive`;
  const transcript = [
    { role: 'system', content: 'memory layer' },
    { role: 'user', content: 'watch the repo' },
    { role: 'assistant', content: 'on it' },
  ];
  await plantSession(id, transcript);
  const cleared = await clearSessionMessages(id, { archiveAs, compact: true });
  assert.equal(cleared.id, id, 'the home keeps its fixed id');
  assert.deepEqual(cleared.messages, [{ role: 'system', content: 'memory layer' }]);
  const archived = storedSessions().find((s) => s.id === archiveAs);
  assert.ok(archived, 'the copy is on disk when the clear returns');
  assert.deepEqual(
    archived.messages.map((m) => m.content),
    transcript.map((m) => m.content),
    'the whole transcript, never compacted first'
  );
  // The id must be fresh: an existing session, a home id or junk refuses.
  await plantSession(id, transcript);
  for (const bad of [archiveAs, 'sess_home_lead', '../x', id]) {
    await assert.rejects(clearSessionMessages(id, { archiveAs: bad }), /archiveAs|already exists/);
  }
  assert.equal(storedSessions().find((s) => s.id === id).messages.length, 3, 'a refused clear wipes nothing');
});

test('fork: false clears without a copy; an archiveAs clear still keeps one', async () => {
  const id = `sess_clear_nofork_${process.pid}_${Date.now()}`;
  const before = storedSessions().length;
  await plantSession(id, [
    { role: 'system', content: 'memory layer' },
    { role: 'user', content: 'room turn' },
    { role: 'assistant', content: 'said' },
  ]);
  const cleared = await clearSessionMessages(id, { fork: false });
  assert.deepEqual(cleared.messages, [{ role: 'system', content: 'memory layer' }]);
  drainSessionStore();
  assert.equal(storedSessions().length, before + 1, 'no fork beside the cleared session');

  await plantSession(id, [{ role: 'user', content: 'again' }]);
  const archiveAs = `sess_${process.pid}_${Date.now()}_nofork_archive`;
  await clearSessionMessages(id, { fork: false, archiveAs });
  assert.ok(
    storedSessions().find((s) => s.id === archiveAs),
    'archiveAs wins over fork: false'
  );
});

test('clear refuses unknown and closed sessions', async () => {
  assert.equal(await clearSessionMessages('sess_clear_missing'), false);
  const id = `sess_clear_closed_${process.pid}_${Date.now()}`;
  const session = await plantSession(id, [{ role: 'user', content: 'x' }]);
  session.closed = true;
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  assert.equal(await clearSessionMessages(id), false);
});

async function withScratchSession(t, run) {
  const cwd = mkdtempSync(join(root, 'project-'));
  const instructionPath = join(cwd, 'AGENTS.md');
  writeFileSync(instructionPath, 'Preserve the inherited project rule.\n');
  const ids = [];
  t.after(async () => {
    for (const id of ids) {
      await closeSessionSearch(id);
      await settleTurnCheckpointWrites(id);
      deleteSession(id, { deferSummaryUpdate: true });
    }
  });
  const providerName = 'clear-scratch-test';
  const sends = [];
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages) {
      sends.push(structuredClone(messages));
      return { content: 'continued', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const session = createSession({
      provider: providerName,
      model: 'fake-model',
      cwd,
      skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'),
      workflow: { id: 'headless', delegatesAgents: false },
    });
    ids.push(session.id);
    const sourceScratch = sessionScratchDir(session.id);
    const historicalText = `The previous output was saved in ${sourceScratch}.`;
    const thinking = { type: 'thinking', thinking: 'Earlier reasoning.', signature: `Sig${'A'.repeat(600)}` };
    session.messages.push(
      { role: 'user', content: historicalText },
      {
        role: 'assistant',
        content: 'Here is the plan.',
        thinkingBlocks: [thinking],
        providerReplay: {
          version: 1,
          provider: 'anthropic',
          items: [thinking, { type: 'text', text: 'Here is the plan.' }],
        },
      }
    );
    session.providerState = { responseId: 'earlier-response' };
    session.contextPressureBaselineTokens = 77;
    recordContextUsageSnapshot(session, { triggerTokens: 100000 }, { messages: session.messages, usedTokens: 77 });
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    const core = session.bp3CoreContext;
    assert.ok(core.includes('Preserve the inherited project rule.'));
    writeFileSync(instructionPath, 'A later disk edit must not replace inherited instructions.\n');
    await run({ session, sourceScratch, historicalText, core, sends, ids });
  });
}

async function resumeAndSend(id, sends) {
  drainSessionStore();
  evictLiveSession(id);
  const resumed = await resumeSession(id, null);
  assert.ok(resumed);
  const beforeSend = structuredClone(resumed);
  await askSession(id, 'Continue the earlier work.', null, null, null, null, {});
  await saveSessionAsync(resumed, { expectedGeneration: resumed.generation });
  assert.equal(sends.length, 1, 'the real turn reaches its first provider.send');
  return { resumed, beforeSend, messages: sends[0] };
}

function assertScratchIdentity(session, messages, sourceScratch) {
  const expected = sessionScratchDir(session.id);
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  assert.ok(system.includes(`- Scratch: ${expected} —`), 'first provider.send advertises the resumed session scratch');
  if (sourceScratch !== expected) {
    assert.ok(
      !system.includes(`- Scratch: ${sourceScratch} —`),
      'the source scratch is not active environment metadata'
    );
  }
  const env = buildShellSpawnEnv(session.cwd, {}, session.id);
  assert.deepEqual([env.TEMP, env.TMP, env.TMPDIR], [expected, expected, expected]);
}

for (const mode of ['plain', 'archiveAs']) {
  test(`${mode} clear persists a new scratch identity through resume and the first provider send`, async (t) => {
    await withScratchSession(t, async ({ session, sourceScratch, historicalText, core, sends, ids }) => {
      const before = new Set(storedSessions().map((s) => s.id));
      const options = mode === 'archiveAs' ? { archiveAs: `sess_scratch_archive_${Date.now()}` } : {};
      if (mode === 'archiveAs') {
        const facts = session.bp3EnvironmentContext.split('\n\n---\n\n')[0];
        const nextCwd = mkdtempSync(join(root, 'archive-project-'));
        session.workspaceReroot = {
          version: 1,
          revision: 2,
          rootCwd: session.cwd,
          seen: { cwd: session.cwd, environmentContext: facts },
          target: { cwd: nextCwd, environmentContext: facts },
        };
        session.cwd = nextCwd;
      }
      const sourcePending = session.workspaceReroot;
      const previousPending = structuredClone(sourcePending);
      await clearSessionMessages(session.id, options);
      assert.deepEqual(sourcePending, previousPending, 'fork repair does not mutate shared source workspace metadata');
      drainSessionStore();
      const archived = storedSessions().find((s) => !before.has(s.id));
      assert.ok(archived, 'the outgoing transcript is persisted under a new id');
      ids.push(archived.id);
      const { beforeSend, messages } = await resumeAndSend(archived.id, sends);
      t.diagnostic(`${mode}: first provider.send reached after persisted archive reload`);
      assertScratchIdentity(beforeSend, messages, sourceScratch);
      assert.ok(archived.bp3EnvironmentContext.includes(`- Scratch: ${sessionScratchDir(archived.id)} —`));
      assert.equal(archived.messages.find((m) => m.role === 'assistant').thinkingBlocks, undefined);
      assert.equal(archived.contextUsageSnapshot, undefined);
      assert.equal(archived.contextPressureBaselineTokens, null);
      assert.equal(beforeSend.bp3CoreContext, core, 'inherited instructions survive disk changes');
      assert.ok(messages.some((m) => m.role === 'user' && m.content === historicalText));
      const previousAnswer = messages.find((m) => m.role === 'assistant' && m.content === 'Here is the plan.');
      assert.ok(previousAnswer, 'the assistant answer survives the prefix change');
      assert.equal(previousAnswer.thinkingBlocks, undefined, 'thinking bound to the old prefix is not replayed');
      assert.deepEqual(previousAnswer.providerReplay?.items, [{ type: 'text', text: 'Here is the plan.' }]);
      assert.ok(loadSession(session.id).bp3EnvironmentContext.includes(`- Scratch: ${sourceScratch} —`));
    });
  });
}

for (const layout of ['split', 'legacy', 'pending workspace']) {
  test(`resume repairs a stored ${layout} archive before its first provider send`, async (t) => {
    await withScratchSession(t, async ({ session, sourceScratch, historicalText, core, sends, ids }) => {
      // A record written by an older clear copied its parent's generated
      // environment verbatim. Recreate that persisted input, not a new fork.
      const archive = structuredClone(session);
      archive.id = `sess_old_scratch_${layout.replaceAll(' ', '_')}_${Date.now()}`;
      ids.push(archive.id);
      if (layout === 'legacy') {
        const env = archive.messages.find((m) => m.role === 'system' && m.cacheTier === 'env');
        const coreMessage = archive.messages.find((m) => m.role === 'system' && m.cacheTier === 'tier3');
        coreMessage.content = `${core}\n\n---\n\n${env.content}`;
        archive.messages = archive.messages.filter((m) => m !== env);
        archive.bp3EnvSplit = false;
      }
      if (layout === 'pending workspace') {
        archive.cwd = mkdtempSync(join(root, 'next-project-'));
        const facts = session.bp3EnvironmentContext.split('\n\n---\n\n')[0];
        archive.workspaceReroot = {
          version: 1,
          revision: 3,
          rootCwd: session.cwd,
          seen: { cwd: session.cwd, environmentContext: facts },
          target: {
            cwd: archive.cwd,
            environmentContext: facts.replace(session.cwd, archive.cwd),
            instructionFilesContext: 'Instructions for the pending project.',
          },
        };
      }
      const pending = structuredClone(archive.workspaceReroot);
      await saveSessionAsync(archive, { expectedGeneration: archive.generation });
      const { beforeSend, messages } = await resumeAndSend(archive.id, sends);
      assertScratchIdentity(beforeSend, messages, sourceScratch);
      assert.equal(beforeSend.bp3CoreContext, core);
      assert.ok(messages.some((m) => m.role === 'user' && m.content === historicalText));
      assert.equal(beforeSend.messages.find((m) => m.role === 'assistant').thinkingBlocks, undefined);
      assert.equal(beforeSend.providerState, undefined);
      assert.equal(beforeSend.contextUsageSnapshot, undefined);
      assert.equal(beforeSend.contextPressureBaselineTokens, null);
      assert.ok(
        storedSessions()
          .find((s) => s.id === archive.id)
          .bp3EnvironmentContext.includes(`- Scratch: ${sessionScratchDir(archive.id)} —`)
      );
      if (pending) {
        const repaired = beforeSend.workspaceReroot;
        assert.equal(repaired.revision, pending.revision);
        assert.equal(repaired.rootCwd, pending.rootCwd);
        for (const side of ['seen', 'target']) {
          assert.deepEqual(repaired[side], {
            ...pending[side],
            environmentContext: pending[side].environmentContext.replace(sourceScratch, sessionScratchDir(archive.id)),
          });
        }
        assert.ok(messages.some((m) => String(m.content).includes('# Working Folder Changed')));
        assert.equal(applyPendingWorkspaceReroot(beforeSend), true);
        assertScratchIdentity(beforeSend, beforeSend.messages, sourceScratch);
        assert.ok(beforeSend.bp3CoreContext.includes('Instructions for the pending project.'));
      }
    });
  });
}

test('resume leaves an already-correct environment and its bound thinking intact', async (t) => {
  await withScratchSession(t, async ({ session, sourceScratch, core, sends }) => {
    const previousMessages = structuredClone(session.messages);
    const previousEnvironment = session.bp3EnvironmentContext;
    const previousUsage = structuredClone(session.contextUsageSnapshot);
    const { beforeSend, messages } = await resumeAndSend(session.id, sends);
    assertScratchIdentity(beforeSend, messages, sourceScratch);
    assert.equal(beforeSend.bp3CoreContext, core);
    assert.equal(beforeSend.bp3EnvironmentContext, previousEnvironment);
    assert.deepEqual(beforeSend.messages, previousMessages, 'healthy resume does not rewrite the prefix or thinking');
    assert.deepEqual(beforeSend.providerState, { responseId: 'earlier-response' });
    assert.deepEqual(beforeSend.contextUsageSnapshot, previousUsage);
    assert.equal(beforeSend.contextPressureBaselineTokens, 77);
  });
});
