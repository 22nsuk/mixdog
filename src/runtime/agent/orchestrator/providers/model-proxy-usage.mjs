// Daemon-side OAuth reads do not consult its credential files or local OAuth
// caches. The desktop cache owns freshness; reconnects retire pending replies.
import { getModelProxyChannel, ModelProxyUnavailableError } from './model-proxy-channel.mjs';
import { loadModelProxyProviderConfig } from './model-proxy-provider.mjs';
import { recordQuotaReadings } from './lib/quota-readings.mjs';

const isProxyUsageAccount = (value) => typeof value === 'string' && /^proxy-[a-f0-9]{64}$/.test(value);
const pending = new WeakMap();

export async function readRemoteOAuthUsage(provider, { force = false, channel = getModelProxyChannel() } = {}) {
  if (!channel.connected) return { status: 'unavailable' };
  const generation = channel.generation;
  let requests = pending.get(channel);
  if (!requests || requests.generation !== generation) {
    requests = { generation, reads: new Map() };
    pending.set(channel, requests);
  }
  const key = `${provider}:${force}`;
  if (requests.reads.has(key)) return requests.reads.get(key);
  const task = (async () => {
    try {
      const reply = await channel.request(
        { method: 'oauthUsage', provider, force },
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!channel.connected || channel.generation !== generation)
        throw new ModelProxyUnavailableError('connection changed');
      if (!['ready', 'unsupported', 'unavailable'].includes(reply?.status)) return { status: 'unavailable' };
      if (reply.status === 'unsupported') return { status: 'unsupported' };
      if (!isProxyUsageAccount(reply.account)) return { status: 'unavailable' };
      if (reply.status !== 'ready') return { status: reply.status, account: reply.account };
      const snapshot = reply.snapshot;
      if (
        !snapshot ||
        snapshot.accountId !== reply.account ||
        snapshot.provider !== provider ||
        !Number.isFinite(snapshot.cachedAt) ||
        !Array.isArray(snapshot.quotaWindows)
      )
        return { status: 'unavailable' };
      // Re-reading a desktop cache is not a new measurement. The ledger
      // de-duplicates the original observation timestamp, including restarts.
      if (!(await recordQuotaReadings(provider, reply.account, snapshot, () => {}, snapshot.cachedAt))) {
        return { status: 'unavailable', account: reply.account };
      }
      if (!channel.connected || channel.generation !== generation) return { status: 'unavailable' };
      return reply;
    } catch {
      return { status: 'unavailable' };
    }
  })().finally(() => {
    if (requests.reads.get(key) === task) requests.reads.delete(key);
  });
  requests.reads.set(key, task);
  return task;
}

export async function remoteQuotaScope({ channel = getModelProxyChannel(), provider = '' } = {}) {
  const generation = channel.generation;
  try {
    if (!channel.connected) throw new Error('desktop disconnected');
    const config = await loadModelProxyProviderConfig({ channel, force: true, waitMs: 1000 });
    const providers = Object.keys(config).filter(
      (id) => id.endsWith('-oauth') && config[id]?.enabled && (!provider || id === provider)
    );
    const readings = await Promise.all(providers.map(async (id) => [id, await readRemoteOAuthUsage(id, { channel })]));
    if (!channel.connected || channel.generation !== generation) throw new Error('connection changed');
    const scopes = Object.fromEntries(
      readings.filter(([, row]) => row.status === 'ready').map(([id, row]) => [id, row.account])
    );
    const status = readings.some(([, row]) => row.status === 'unavailable')
      ? 'unavailable'
      : Object.keys(scopes).length
        ? 'ready'
        : providers.length
          ? 'unsupported'
          : 'not-configured';
    return { scopes, status, current: () => channel.connected && channel.generation === generation };
  } catch {
    return { scopes: {}, status: 'unavailable', current: () => false };
  }
}
