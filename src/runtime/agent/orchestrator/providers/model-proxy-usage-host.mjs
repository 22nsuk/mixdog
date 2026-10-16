// Desktop-owned, read-only subscription measurements. Only opaque account
// scopes and bounded quota fields cross the SSH boundary, never credentials,
// roster labels, emails, raw responses, or reset-credit offers.
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { providerUsageAccounts } from '../../../../session-runtime/services/provider-admin.mjs';
import { measureOAuthUsageSnapshot } from './oauth-usage.mjs';

let namespace;
function installationScope() {
  namespace ??= updateJsonAtomicSync(
    join(resolvePluginData(), 'model-proxy-usage-owner.json'),
    (old) => ({ id: typeof old?.id === 'string' ? old.id : randomUUID() }),
    { mode: 0o600 }
  ).id;
  return namespace;
}

const DIRECT_USAGE = new Set(['openai-oauth', 'anthropic-oauth', 'grok-oauth']);
const ADAPTER_USAGE = new Set(['cursor-oauth', 'antigravity-oauth', 'muse-code-oauth', 'command-code-oauth']);

export function createModelProxyUsage({
  accounts = providerUsageAccounts,
  owner = installationScope,
  fetchUsage = measureOAuthUsageSnapshot,
} = {}) {
  const readings = new Map();
  function roster(provider) {
    if (!provider.endsWith('-oauth')) return { selectedId: null, scopes: {} };
    const pool = accounts(provider);
    const scopes = {};
    for (const row of pool.accounts) {
      // A roster slot can be reauthenticated with a different login. Require
      // a provider identity rather than guessing ownership from that slot.
      const identity = row.identity;
      if (!identity || !row.authenticated) continue;
      scopes[row.id] = `proxy-${createHash('sha256')
        .update(JSON.stringify([owner(), provider, row.id, identity]))
        .digest('hex')}`;
    }
    return { selectedId: pool.selectedId, scopes };
  }
  return {
    roster,
    async snapshot(provider, instance, { force = false } = {}) {
      if (!DIRECT_USAGE.has(provider) && !ADAPTER_USAGE.has(provider)) return { status: 'unsupported' };
      const { selectedId, scopes } = roster(provider);
      const account = scopes[selectedId];
      if (!account) return { status: 'unavailable' };
      const bound = instance.forAccount?.(selectedId) ?? instance;
      if (!DIRECT_USAGE.has(provider) && typeof bound.getUsageSnapshot !== 'function') {
        return { status: 'unsupported', account };
      }
      let cached = readings.get(account);
      if (!cached || (force && !cached.pending) || Date.now() - cached.at > 60_000) {
        const entry = { at: Date.now(), pending: true, promise: null };
        entry.promise = Promise.resolve()
          .then(() => fetchUsage({ provider, accountId: selectedId }, bound))
          .then(
            (snapshot) => {
              entry.pending = false;
              if (!snapshot && readings.get(account) === entry) readings.delete(account);
              return snapshot;
            },
            (error) => {
              if (readings.get(account) === entry) readings.delete(account);
              throw error;
            }
          );
        readings.set(account, entry);
        // At most 20 accounts per provider; keep this cache bounded across
        // credential replacements even when an app stays open for months.
        if (readings.size > 160) readings.delete(readings.keys().next().value);
        cached = entry;
      }
      const snapshot = await cached.promise;
      // An account edit or replacement while the HTTP request ran retires it.
      const current = roster(provider);
      if (current.selectedId !== selectedId || current.scopes[selectedId] !== account) return { status: 'unavailable' };
      if (!snapshot) return { status: 'unavailable', account };
      const quotaWindows = (snapshot.quotaWindows || []).slice(0, 12).flatMap((window) => {
        if (typeof window.label !== 'string' || !/^[\w .-]{1,40}$/.test(window.label)) return [];
        const out = { label: window.label };
        for (const key of [
          'usedPct',
          'resetAt',
          'usedUsd',
          'limitUsd',
          'remainingUsd',
          'usedCredits',
          'limitCredits',
          'remainingCredits',
        ]) {
          if (typeof window[key] === 'number' && Number.isFinite(window[key]) && window[key] >= 0)
            out[key] = window[key];
        }
        return typeof out.usedPct === 'number' ? [out] : [];
      });
      if (!quotaWindows.length) return { status: 'unsupported', account };
      return {
        status: 'ready',
        account,
        snapshot: {
          provider,
          accountId: account,
          source: 'desktop-oauth',
          cachedAt: snapshot.cachedAt,
          quotaWindows,
        },
      };
    },
  };
}
