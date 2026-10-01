import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionHostPublication } from './session-host-publication.ts';

function publication() {
  return new SessionHostPublication({
    isDisposed: () => false,
    controlSessionId: () => '',
    setControlSessionId() {},
    visibleSessionIds: () => new Set(),
    async readSession(sessionId) {
      return { sessionId, items: [], queued: [] };
    },
    snapshotWithShellJobs: (_id, snapshot) => snapshot,
    trackShellJobsEngineState() {},
    onShellPublished() {},
  });
}

const row = (id, extra = {}) => ({ id, title: id, shellJobCount: 0, ...extra });

const catalogs = [
  ['sessions', 'subscribeSessions', 'publishSessions'],
  ['agents', 'subscribeAgentPool', 'publishAgents'],
];

for (const [name, subscribe, publish] of catalogs) {
  test(`${name}: identical, cloned and key-reordered lists are suppressed; empty list publishes first`, () => {
    const host = publication();
    const seen = [];
    host[subscribe]((list) => seen.push(list));
    host[publish]([]);
    host[publish]([]);
    assert.equal(seen.length, 1);
    const list = [row('a', { owner: { id: 'x', tags: [1, 2] } }), row('b')];
    host[publish](list);
    host[publish](structuredClone(list));
    host[publish]([
      { shellJobCount: 0, title: 'a', owner: { tags: [1, 2], id: 'x' }, id: 'a' },
      { title: 'b', id: 'b', shellJobCount: 0 },
    ]);
    assert.equal(seen.length, 2);
  });

  test(`${name}: real changes are delivered immediately`, () => {
    const host = publication();
    const seen = [];
    host[subscribe]((list) => seen.push(list));
    const base = [row('a', { nested: { n: 1 } }), row('b')];
    host[publish](base);
    host[publish]([base[1], base[0]]); // order
    host[publish]([base[1], { ...base[0], stage: 'run' }]); // field added
    host[publish]([base[1], row('a', { nested: { n: 1 } })]); // field removed
    host[publish]([base[1], row('a', { nested: { n: 2 } })]); // nested change
    host[publish]([base[1], row('a', { nested: { n: 2 }, shellJobCount: 3 })]); // shell count
    assert.equal(seen.length, 6);
  });

  test(`${name}: in-place mutation of a published list is a change`, () => {
    const host = publication();
    const seen = [];
    host[subscribe]((list) => seen.push(list.length));
    const list = [row('a')];
    host[publish](list);
    list[0].shellJobCount = 2;
    host[publish](list);
    list.push(row('b'));
    host[publish](list);
    assert.deepEqual(seen, [1, 1, 2]);
  });

  test(`${name}: new and re-subscribed listeners receive the next publication; no eager delivery`, () => {
    const host = publication();
    const a = [];
    const b = [];
    host[subscribe]((list) => a.push(list));
    host[publish]([row('a')]);
    const offB = host[subscribe]((list) => b.push(list));
    assert.equal(b.length, 0);
    host[publish]([row('a')]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    offB();
    host[publish]([row('a')]);
    const again = [];
    const listener = (list) => again.push(list);
    host[subscribe](listener)();
    host[subscribe](listener);
    host[publish]([row('a')]);
    assert.equal(again.length, 1);
    assert.equal(b.length, 1);
  });

  test(`${name}: clearListeners resets baselines`, () => {
    const host = publication();
    const listener = [];
    const fn = (list) => listener.push(list);
    host[subscribe](fn);
    host[publish]([row('a')]);
    host.clearListeners();
    host[publish]([row('a')]);
    assert.equal(listener.length, 1);
    host[subscribe](fn);
    host[publish]([row('a')]);
    assert.equal(listener.length, 2);
  });

  test(`${name}: a failed listener retries without redelivering to successful listeners`, () => {
    const host = publication();
    const seen = [];
    let calls = 0;
    host[subscribe](() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    host[subscribe]((list) => seen.push(list));
    host[publish]([row('a')]);
    host[publish]([row('a')]);
    host[publish]([row('a')]);
    assert.equal(calls, 2);
    assert.equal(seen.length, 1);
  });

  test(`${name}: unchanged reentrant publication still supersedes an older outer list`, () => {
    const host = publication();
    const seen = [];
    let restore = false;
    host[subscribe](() => {
      if (restore) {
        restore = false;
        host[publish]([row('latest')]);
        throw new Error('outer delivery failed after publishing newer data');
      }
    });
    host[subscribe]((list) => seen.push(list.map((entry) => entry.id).join()));
    host[publish]([row('latest')]);
    restore = true;
    host[publish]([row('older')]);
    host[publish]([row('latest')]);
    assert.deepEqual(seen, ['latest']);
  });

  test(`${name}: reentrant publication delivers newest data and never stale data afterwards`, () => {
    const host = publication();
    const first = [];
    const second = [];
    let nested = false;
    host[subscribe]((list) => {
      first.push(list.map((r) => r.id).join());
      if (!nested) {
        nested = true;
        host[publish]([row('v2')]);
      }
    });
    host[subscribe]((list) => second.push(list.map((r) => r.id).join()));
    host[publish]([row('v1')]);
    assert.deepEqual(first, ['v1', 'v2']);
    assert.deepEqual(second, ['v2']);
    host[publish]([row('v2')]);
    assert.equal(first.length, 2);
    assert.equal(second.length, 1);
  });
}

test('sessions and agents keep independent baselines', () => {
  const host = publication();
  const sessions = [];
  const agents = [];
  host.subscribeSessions((list) => sessions.push(list));
  host.subscribeAgentPool((list) => agents.push(list));
  host.publishSessions([row('a')]);
  host.publishAgents([row('a')]);
  host.publishSessions([row('a')]);
  host.publishAgents([row('a')]);
  assert.equal(sessions.length, 1);
  assert.equal(agents.length, 1);
});
