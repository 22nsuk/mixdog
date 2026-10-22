// Runtime → the desktop host's group-room controller. The log session never
// runs a model turn: only the controller may start or stop its members.
// Like session-sidebar-host.mjs, the daemon and its desktop bundle share this
// registry through a global symbol, including during an in-place update.

const HOSTS_KEY = Symbol.for('mixdog.agentRoomHosts.v1');

function hosts() {
  globalThis[HOSTS_KEY] ??= [];
  return globalThis[HOSTS_KEY];
}

/** Register one controller; unregistering it never removes another host. */
export function registerAgentRoomHost(host) {
  const entry = { host, sending: new Map() };
  hosts().push(entry);
  return () => {
    const list = hosts();
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
}

async function ownerOf(sessionId) {
  // Load records before choosing. Running state is checked afterwards, since
  // another request may have started an exchange while those reads waited.
  const registered = hosts().slice();
  const matches = await Promise.all(registered.map((entry) => entry.host.hasRoom(sessionId)));
  const owners = registered.filter((entry, index) => matches[index] && hosts().includes(entry));
  const active = owners.filter((entry) => entry.sending.has(sessionId) || entry.host.isRunning(sessionId));
  if (active.length > 1) throw new Error('session: group room has multiple active hosts');
  const owner = active[0] ?? owners.at(-1);
  if (!owner) throw new Error('session: group room controller is unavailable; open the group in the desktop app');
  return owner;
}

/**
 * Accept one message through the room engine, never the room-log actor.
 * @param {string} sessionId
 * @param {unknown} prompt
 * @param {import('./agent-room-host.mjs').AgentRoomMessageSource} source
 */
export async function sendAgentRoomMessage(sessionId, prompt, source = {}) {
  const entry = await ownerOf(sessionId);
  // A host owns the intake too: a newly attached host must not start another
  // exchange while this one's append/save has not yet returned.
  const pending = entry.sending.get(sessionId) ?? new Set();
  entry.sending.set(sessionId, pending);
  const sent = Promise.resolve().then(() => entry.host.send(sessionId, prompt, source));
  pending.add(sent);
  try {
    return await sent;
  } finally {
    pending.delete(sent);
    if (!pending.size) entry.sending.delete(sessionId);
  }
}

/** Stop the controller that owns the exchange, including its queued request. */
export async function stopAgentRoom(sessionId) {
  const entry = await ownerOf(sessionId);
  const pending = [...(entry.sending.get(sessionId) ?? [])];
  const aborted = entry.host.stop(sessionId);
  if (!pending.length) return aborted;
  // A send that entered first may still be appending its request. Stop after
  // that intake settles too, without delaying cancellation of a current member.
  await Promise.allSettled(pending);
  return entry.host.stop(sessionId) || aborted;
}
