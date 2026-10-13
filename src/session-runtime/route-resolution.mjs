// Route resolution against the live runtime record: pick a model for a
// model-less first turn and refresh the route's effort / Fast / context
// fields from provider metadata.
import { ensureProviderEnabled } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { runAbortable, throwIfAborted } from '../runtime/shared/abort-race.mjs';
import { resolveRouteMetadataState } from './route-state.mjs';

export function createRouteResolution({ rt, collectProviderModels, ensureProvidersReady, lookupModelMeta }) {
  function routeHasModel() {
    return !!clean(rt.route?.model);
  }

  function requireModelRoute() {
    if (routeHasModel()) return;
    throw new Error('No model configured. Open /providers to sign in, then /model to choose a model.');
  }

  async function resolveMissingRouteModelForFirstTurn(signal = null) {
    if (routeHasModel()) return rt.route;
    const models = await runAbortable(signal, () => collectProviderModels());
    throwIfAborted(signal);
    const picked = models[0] || null;
    if (!picked) {
      throw new Error('No provider models available. Open /providers to sign in, then /model to choose a model.');
    }
    rt.route = {
      ...rt.route,
      provider: picked.provider,
      model: picked.id,
      preset: null,
    };
    return rt.route;
  }

  async function refreshRouteEffort(modelMetaOverride = null, expectedRoute = null, signal = null) {
    const targetRoute = expectedRoute || rt.route;
    await runAbortable(signal, () => ensureProvidersReady(ensureProviderEnabled(rt.config, targetRoute.provider)));
    const modelMeta =
      modelMetaOverride || (await runAbortable(signal, () => lookupModelMeta(targetRoute.provider, targetRoute.model)));
    throwIfAborted(signal);
    // A rapid second resume/model change can replace the route while provider
    // metadata is loading. Never let the older completion overwrite it.
    if (expectedRoute && rt.route !== expectedRoute) return null;
    rt.route = resolveRouteMetadataState(rt.config, targetRoute, modelMeta);
    return rt.route;
  }

  return { routeHasModel, requireModelRoute, resolveMissingRouteModelForFirstTurn, refreshRouteEffort };
}
