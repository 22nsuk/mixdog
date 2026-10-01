import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionHost } from './session-host.ts';

const OWN_PID = 4242;
const OTHER_PID = 7777;

async function fixture(t) {
  // Jobs per owning host process; the runtime answers only for the pid asked.
  let byPid = {};
  const requestedPids = [];
  const row = (sessionId) => ({ tag: sessionId, sessionId, status: 'running', stage: 'idle' });
  const host = await SessionHost.create(
    { userDataPath: '.', resourcesPath: '.', appPath: '.', packaged: false },
    {
      async attachSessionClient() {
        return { async close() {} };
      },
      async loadProjects() {
        return {};
      },
      async loadSessionStore() {
        return { listStoredAgentWorkers: () => [row('a'), row('b'), row('c')] };
      },
      async loadStatuslineSegments() {
        return {
          shellJobsStatus: (options) => {
            requestedPids.push(options?.clientHostPid);
            const sessions = byPid[options?.clientHostPid] ?? {};
            return {
              count: Object.values(sessions).reduce((sum, bucket) => sum + bucket.count, 0),
              jobs: [],
              sessions,
            };
          },
        };
      },
      async executeCodeGraphTool() {
        return {};
      },
    }
  );
  t.after(() => host.dispose());
  const waiters = new Set();
  host.publication.subscribeAgentPool((rows) => {
    for (const waiter of [...waiters]) waiter(rows);
  });
  host.trackShellJobsEngineState({ clientHostPid: OWN_PID, busy: true });
  return {
    host,
    requestedPids,
    set(next) {
      byPid = next;
    },
    /** Resolves on the first published pool satisfying `predicate`; bounded. */
    nextPool(predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('agent pool publication timed out'));
        }, timeoutMs);
        const waiter = (rows) => {
          if (!predicate(rows)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(rows);
        };
        waiters.add(waiter);
      });
    },
  };
}

const job = (taskId) => ({ taskId, command: 'x', cwd: '.', startedAt: 1 });
const countOf = (rows, sessionId) => rows.find((r) => r.sessionId === sessionId)?.shellJobCount;

test('agent pool rows carry only this host process and session shell counts, and clear when jobs finish', async (t) => {
  const f = await fixture(t);
  const started = f.nextPool((rows) => countOf(rows, 'a') === 2);
  f.set({
    [OWN_PID]: { a: { count: 2, jobs: [job('1'), job('2')] } },
    // Another host process's jobs, including one for a session this pool lists.
    [OTHER_PID]: { b: { count: 5, jobs: [job('9')] }, foreign: { count: 1, jobs: [job('8')] } },
  });
  await started;
  assert.ok(f.requestedPids.length > 0);
  assert.ok(f.requestedPids.every((pid) => pid === OWN_PID));
  const rows = await f.host.listAgentPool();
  assert.deepEqual(
    rows.map((r) => [r.sessionId, r.shellJobCount, r.status]),
    [
      ['a', 2, 'running'],
      ['b', 0, 'running'],
      ['c', 0, 'running'],
    ]
  );

  const cleared = f.nextPool((published) => countOf(published, 'a') === 0);
  f.set({ [OTHER_PID]: { b: { count: 5, jobs: [job('9')] } } });
  await cleared;
  assert.ok((await f.host.listAgentPool()).every((r) => r.shellJobCount === 0));
});
