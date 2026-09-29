// System blocks carry their own cache tier; anything else is the default tier.
const SYSTEM_CACHE_TIERS = new Set(['tier3', 'env']);
const systemCacheTier = (cacheTier) => (SYSTEM_CACHE_TIERS.has(cacheTier) ? cacheTier : 'system');

/** Non-empty system messages as `{ text, tier }` block items; a non-array yields none. */
export function systemBlockItems(systemMsgs) {
  const items = [];
  for (const m of Array.isArray(systemMsgs) ? systemMsgs : []) {
    const text = typeof m?.content === 'string' ? m.content.trim() : '';
    if (text) items.push({ text, tier: systemCacheTier(m?.cacheTier) });
  }
  return items;
}
/** cacheTier:'env' (volatile session/project environment) is never marked —
 *  it rides the messages-tail breakpoint; a null TTL leaves the block uncached. */
export const systemBlockTtl = (tier, { tier3Ttl, systemTtl }) =>
  ({ tier3: tier3Ttl, env: null, system: systemTtl })[tier];
