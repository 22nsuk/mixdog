import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionHost } from './session-host.ts';
import { SessionHostLifecycle } from './session-host-lifecycle.ts';
import { createSessionControl } from '../../../../src/standalone/daemon-session-control.mjs';

async function fixture(t, close, rooms = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-session-host-lifecycle-'));
  await writeFile(join(root, 'agent-rooms.json'), JSON.stringify({ rooms }));
  const host = await SessionHost.create(
    {
      userDataPath: root,
      resourcesPath: root,
      appPath: root,
      packaged: false,
    },
    {
      attachSessionClient: async () => ({
        list: async () => ({ sessions: [] }),
        close,
      }),
      loadProjects: async () => ({}),
      loadSessionStore: async () => ({}),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  t.after(async () => {
    // A test may deliberately leave a failed metadata flush as the terminal
    // result. The assertions below own that rejection; cleanup still runs.
    await host.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { host, root };
}

test('every overlapping host disposal waits for the same attachment cleanup', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let closes = 0;
  const { host } = await fixture(t, async () => {
    closes++;
    entered.resolve();
    await release.promise;
  });
  const first = host.dispose();
  await entered.promise;
  let secondFinished = false;
  const second = host.dispose().then(() => {
    secondFinished = true;
  });
  try {
    await Promise.resolve();
    assert.equal(secondFinished, false);
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  assert.equal(closes, 1);
});

test('failed metadata flushing cannot prevent host attachment cleanup', async (t) => {
  let closes = 0;
  const { host, root } = await fixture(t, async () => {
    closes++;
  });
  t.mock.method(console, 'error', () => {});
  await host.listSessions();
  await mkdir(join(root, 'desktop-session-metadata.json'));
  await assert.rejects(host.markSessionRead('session-a', 2, false));
  await assert.rejects(host.dispose());
  assert.equal(closes, 1);
});

test('a real session host registers its stored rooms for the tool and unregisters before closing', async (t) => {
  const { host } = await fixture(t, async () => {}, {
    release1: { id: 'release1', name: 'Release', members: ['reviewer'], cursors: {} },
  });
  const execute = createSessionControl({
    getSessionService: () => ({ abortSession: () => assert.fail('must not abort the room-log actor') }),
  });
  const cancel = { action: 'cancel', session_id: 'sess_room_release1' };
  const context = { callerSessionId: 'caller' };
  assert.deepEqual(await execute(cancel, context), { sessionId: cancel.session_id, aborted: false });
  await assert.rejects(execute({ ...cancel, session_id: 'sess_room_missing1' }, context), /controller is unavailable/);
  const closed = host.dispose();
  await assert.rejects(execute(cancel, context), /controller is unavailable/);
  await closed;
});

test('room member submissions preserve the bot hop alongside device metadata; a UI turn starts fresh', async () => {
  const requests = [];
  const lifecycle = new SessionHostLifecycle({
    publication: { projections: new Map() },
    client: {
      submit: async (args) => {
        requests.push(args);
        return { accepted: true };
      },
    },
    openHints: () => ({}),
    callOptions: () => ({}),
    applySessionResult: () => {},
  });
  const member = 'sess_rmem_release1_reviewer';
  assert.equal(await lifecycle.submitToSession(member, 'bot request', { id: 'bot', device: 'Main PC' }, 3), true);
  assert.deepEqual(requests[0].options.transcriptMeta, { device: 'Main PC', hop: 3 });
  assert.equal(await lifecycle.submitToSession(member, 'user request', { id: 'user', device: 'Phone' }), true);
  assert.deepEqual(requests[1].options.transcriptMeta, { device: 'Phone' });
});
