// The TUI steering mirror and the runtime/manager pending-message spool share
// one per-session shard layout (session-pending/<key>.json). These tests pin
// that the one-time migration of the legacy global file is lossless for
// foreign rows — including the handoffAt/handoffPid parking stamp that lets
// accepted user input survive an owner crash — that a TUI operation touches
// only its own shard, and that sessions never contend on a shared lock.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-tui-steering-persist-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  appendTuiSteeringPersist,
  readTuiSteeringPersist,
  dropTuiSteeringPersist,
  flushTuiSteeringPersist,
} = await import('./tui-steering-persist.mjs');
const { attachmentsForIntake, materializePromptSubmission, hydratePastedAttachments, hydrateRestorableFileParts } =
  await import('../../runtime/attachments/store.mjs');

const spoolPath = join(dataDir, 'session-pending-messages.json');
const legacyPath = spoolPath;
const shardPath = (key) => join(dataDir, 'session-pending', `${key}.json`);
const readShard = (key) => JSON.parse(readFileSync(shardPath(key), 'utf8'));

// Older than the TUI restore TTL (30m) and than the runtime orphan window, so
// the pre-fix orphan sweep would have reaped this whole bucket.
const OLD_AT = Date.now() - 10 * 24 * 60 * 60 * 1000;
// Runtime-shaped rows: a parked structured row (handoffAt/handoffPid +
// content array + options) and a completion-notification row.
const foreignRows = [
  {
    id: 'pm_structured_1',
    content: [
      { type: 'text', text: 'look at this shot' },
      { type: 'image', data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png' },
    ],
    text: 'look at this shot',
    enqueuedAt: OLD_AT,
    handoffAt: OLD_AT,
    handoffPid: 4242,
    options: { mode: 'user', priority: 'next', displayText: 'look at this shot' },
  },
  {
    id: 'pm_notification_2',
    message: 'agent task finished',
    enqueuedAt: OLD_AT,
    notificationKind: 'completion_notification',
    executionId: 'exec_7',
  },
];

writeFileSync(
  spoolPath,
  `${JSON.stringify(
    {
      version: 1,
      updatedAt: OLD_AT,
      sessions: {
        sess_runtime_owner: foreignRows,
        tui_staleother: [{ id: 'ts_old', text: 'old steering', at: OLD_AT }],
      },
      sessionTouchedAt: { sess_runtime_owner: OLD_AT, tui_staleother: OLD_AT },
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);

test.after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});

test('a TUI steering append migrates the legacy spool and leaves foreign rows lossless', async () => {
  await appendTuiSteeringPersist('leadsessionone', { text: 'steer me' });
  await flushTuiSteeringPersist();

  // The legacy global file is kept as a renamed backup, never left in place.
  assert.equal(existsSync(legacyPath), false);
  assert.equal(
    readdirSync(dataDir).some((name) => name.startsWith('session-pending-messages.json.migrated-')),
    true
  );

  // Every field of every foreign row survives migration and the TUI write untouched.
  const foreign = readShard('sess_runtime_owner');
  assert.deepEqual(foreign.sessions.sess_runtime_owner, foreignRows);
  // A foreign session's touch stamp is carried, never refreshed by our write.
  assert.equal(foreign.sessionTouchedAt.sess_runtime_owner, OLD_AT);

  // The steering bucket lives in its own shard.
  const steering = readShard('tui_leadsessionone').sessions.tui_leadsessionone;
  assert.equal(Array.isArray(steering), true);
  assert.equal(steering.length, 1);
  assert.equal(steering[0].text, 'steer me');
});

test('restore reads retain their own shard until commit and leave other shards untouched', async () => {
  const foreignBefore = readFileSync(shardPath('sess_runtime_owner'), 'utf8');
  const restored = await readTuiSteeringPersist('leadsessionone');
  assert.deepEqual(
    restored.map((row) => row.text),
    ['steer me']
  );

  assert.equal(existsSync(shardPath('tui_leadsessionone')), true);
  assert.deepEqual(await readTuiSteeringPersist('leadsessionone'), restored);
  await dropTuiSteeringPersist('leadsessionone', restored);
  assert.equal(existsSync(shardPath('tui_leadsessionone')), false);
  assert.equal(readFileSync(shardPath('sess_runtime_owner'), 'utf8'), foreignBefore);
  // Reading one lead does not age or clear another lead's bucket.
  assert.equal(existsSync(shardPath('tui_staleother')), true);
});

test('a queued submission keeps its reference payload and options through later writes and repeated restore', async () => {
  const displayText = 'Review [Pasted text #7 +2 lines] [Image #3: shot.png] [PDF #4: note.pdf]';
  const pastedText = 'original queued context\n'.repeat(50);
  const imageData = Buffer.from('queued image original bytes').toString('base64');
  const pdfData = Buffer.from('%PDF-1.4 queued document original').toString('base64');
  const intake = materializePromptSubmission(
    [
      { type: 'text', text: displayText },
      { type: 'image', data: imageData, mimeType: 'image/png' },
      { type: 'file', data: pdfData, mimeType: 'application/pdf', filename: 'note.pdf' },
    ],
    {
      pastedImages: { 3: { id: 3, type: 'image', filename: 'shot.png', mediaType: 'image/png' } },
      pastedTexts: { 7: { id: 7, text: pastedText, source: 'paste', filename: 'context.txt' } },
    }
  );
  const entry = {
    id: 'rich-submission',
    submittedAt: Date.now() - 100,
    text: displayText,
    content: intake.prompt,
    pastedImages: intake.options.pastedImages,
    pastedTexts: intake.options.pastedTexts,
    transcriptMeta: {
      messageId: 'msg_rich_submission',
      device: 'paired device',
      attachments: attachmentsForIntake(intake.prompt, intake.options),
    },
    mode: 'prompt',
    priority: 'later',
    context: 'queued context',
    skipSlashCommands: true,
    suppressDisplay: true,
    retryFailedTurn: true,
    retryTurnId: 'turn_retry',
    retryAttemptId: 'attempt_retry',
    onCommitted() {},
  };
  const { id: expectedSubmissionId, ...expected } = JSON.parse(JSON.stringify(entry));
  const appended = appendTuiSteeringPersist('richlead', entry);
  // A queued write owns the submitted snapshot even while its lock is pending.
  entry.content[0].text = 'changed after append';
  entry.pastedTexts[7].filename = 'changed.txt';
  entry.transcriptMeta.attachments[0].name = 'changed name';
  assert.equal(await appended, true);
  const later = { id: 'later-submission', text: 'later', content: 'later' };
  await appendTuiSteeringPersist('richlead', later);
  await dropTuiSteeringPersist('richlead', [later]);

  const serialized = readFileSync(shardPath('tui_richlead'), 'utf8');
  assert.equal(serialized.includes(JSON.stringify(pastedText).slice(1, -1)), false);
  assert.equal(serialized.includes(imageData), false);
  assert.equal(serialized.includes(pdfData), false);
  assert.equal(serialized.includes('onCommitted'), false);
  const restored = await readTuiSteeringPersist('richlead');
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0], {
    ...expected,
    steeringPersistId: entry.steeringPersistId,
    submissionId: expectedSubmissionId,
  });
  assert.deepEqual(await readTuiSteeringPersist('richlead'), restored);
  const hydrated = hydratePastedAttachments(restored[0].pastedImages, restored[0].pastedTexts);
  assert.equal(hydrated.pastedImages[3].content, imageData);
  assert.equal(hydrated.pastedTexts[7].text, pastedText);
  assert.deepEqual(hydrateRestorableFileParts(restored[0].content), [
    { type: 'file', data: pdfData, mimeType: 'application/pdf', filename: 'note.pdf' },
  ]);
  await dropTuiSteeringPersist('richlead', restored);
  assert.deepEqual(await readTuiSteeringPersist('richlead'), []);
});

test('legacy rows get stable restore identities under the lock without refreshing their age', async () => {
  const key = 'tui_legacyread';
  const touched = Date.now() - 5 * 60 * 1000;
  writeFileSync(
    shardPath(key),
    JSON.stringify({
      version: 1,
      updatedAt: touched,
      sessions: { [key]: ['same text', { text: 'same text' }] },
      sessionTouchedAt: { [key]: touched },
    })
  );
  const [first, second] = await Promise.all([
    readTuiSteeringPersist('legacyread'),
    readTuiSteeringPersist('legacyread'),
  ]);
  assert.equal(first.length, 2);
  assert.deepEqual(second, first);
  assert.notEqual(first[0].steeringPersistId, first[1].steeringPersistId);
  for (const row of first) {
    assert.match(row.steeringPersistId, /^ts_/);
    assert.equal(Object.hasOwn(row, 'content'), false, 'legacy text is not invented as the original content');
    assert.equal(row.submissionId, null);
  }
  const persisted = readShard(key);
  assert.equal(persisted.sessionTouchedAt[key], touched);
  assert.equal(persisted.sessions[key].some((row) => Object.hasOwn(row, 'at')), false);

  await dropTuiSteeringPersist('legacyread', [first[0]]);
  assert.deepEqual(await readTuiSteeringPersist('legacyread'), [first[1]]);
  const aged = readShard(key);
  aged.sessionTouchedAt[key] = Date.now() - 31 * 60 * 1000;
  writeFileSync(shardPath(key), JSON.stringify(aged));
  assert.deepEqual(await readTuiSteeringPersist('legacyread'), []);
  assert.equal(existsSync(shardPath(key)), false);
});

test('restore retains fresh unreadable attachment references and removes only stale rows', async () => {
  const now = Date.now();
  const key = 'tui_refread';
  const content = [{ type: 'image', attachmentRef: 'a'.repeat(64), sizeBytes: 42, mimeType: 'image/png' }];
  writeFileSync(
    shardPath(key),
    JSON.stringify({
      version: 1,
      updatedAt: now,
      sessions: {
        [key]: [
          { id: 'ts_stale', text: 'stale', at: now - 31 * 60 * 1000 },
          { id: 'ts_fresh', text: '[Image]', content, at: now, submissionId: 'fresh' },
        ],
      },
      sessionTouchedAt: { [key]: now },
    })
  );
  const restored = await readTuiSteeringPersist('refread');
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].content, content, 'startup does not read or drop attachment blobs');
  assert.deepEqual(readShard(key).sessions[key].map((row) => row.id), ['ts_fresh']);
  await dropTuiSteeringPersist('refread', restored);
});

test('steering operations of different sessions never contend on one lock', async () => {
  const held = `${shardPath('tui_blockedlead')}.lock`;
  mkdirSync(join(dataDir, 'session-pending'), { recursive: true });
  // A live holder (our pid, foreign token) on one session's shard lock.
  writeFileSync(held, `${process.pid} ${Date.now()} deadbeefdeadbeefdeadbeef\n`, 'utf8');
  try {
    const startedAt = Date.now();
    await appendTuiSteeringPersist('freelead', { text: 'unblocked' });
    await flushTuiSteeringPersist();
    assert.ok(Date.now() - startedAt < 1500);
    assert.equal(readShard('tui_freelead').sessions.tui_freelead[0].text, 'unblocked');
  } finally {
    rmSync(held, { force: true });
  }
});
