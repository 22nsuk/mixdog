import { AsyncLocalStorage } from 'node:async_hooks';

// The selected route owns accounting identity, not an inner transport adapter.
const context = new AsyncLocalStorage();
export const withUsageContext = (identity, send) => context.run(identity, send);
export const currentUsageContext = () => context.getStore();
// Each wire attempt stamps the tier it actually sent on its own send's
// context object, so the last attempt (the one that produced the usage) wins
// and concurrent sends never observe each other's tier.
export const noteRequestServiceTier = (tier) => {
  const identity = context.getStore();
  if (identity) identity.requestServiceTier = tier || '';
};
// A provider-local retry abandons an attempt the provider still billed; the
// enclosing send records it alongside its own final usage.
export const noteAbandonedUsage = (usage, model) => {
  const identity = context.getStore();
  if (identity && usage) (identity.abandonedUsage ||= []).push({ usage, model });
};
