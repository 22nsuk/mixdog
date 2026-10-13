/**
 * set-route.mjs — select the main route: resolve and validate the request,
 * adopt it into config, then decide how the current session follows it
 * (untouched, tuned, recreated, or updated in place when empty).
 */
import { clean, hasOwn } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  ensureProviderEnabled,
  findPreset,
  modelMetaLooksResolved,
  validateRequestedModelSelector,
} from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { getModelMetadataSync } from '../../runtime/agent/orchestrator/providers/model-catalog.mjs';
import { workflowPresetId } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { resolveRouteContextState, resolveRouteMetadataState, selectionFastCapable } from '../route-state.mjs';
import { writeStatuslineRoute } from '../statusline-route.mjs';
import {
  sessionHasRouteHistory,
  sessionRouteCommitted,
  shouldRecreateEmptySessionForRouteChange,
} from '../../runtime/agent/orchestrator/runtime-core/session-route-policy.mjs';
import { rebuildDeferredToolSurfaceForProvider } from '../../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';

/** The request, completed from the live route where the caller left gaps. */
function completeRequest(deps, next) {
  const { getConfig, getRoute } = deps;
  const requested = { ...(next || {}) };
  validateRequestedModelSelector(getConfig(), requested);
  if (requested.effort === undefined && !requested.provider && !requested.model && hasOwn(getRoute(), 'effort')) {
    requested.effort = getRoute().effort;
  }
  if (!requested.provider && requested.model && !findPreset(getConfig(), requested.model)) {
    requested.provider = getRoute().provider;
  }
  return requested;
}

async function resolveSelectedRoute(deps, next) {
  const { getConfig, resolveRoute, ensureProvidersReady, lookupModelMeta } = deps;
  const providerExplicitlyRequested = clean(next?.provider) !== '';
  const selectedRoute = resolveRoute(getConfig(), completeRequest(deps, next));
  await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
  const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
  if (
    !providerExplicitlyRequested &&
    !selectedRoute.preset &&
    !modelMetaLooksResolved(modelMeta) &&
    !getModelMetadataSync(selectedRoute.model, selectedRoute.provider)
  ) {
    throw new Error(`unknown model: ${selectedRoute.provider}/${selectedRoute.model}`);
  }
  const fastCapable = selectionFastCapable(
    selectedRoute.provider,
    modelMeta,
    selectedRoute.effort,
    selectedRoute.modelParameters
  );
  const contextState = resolveRouteContextState(selectedRoute, modelMeta);
  // An exact selection is saved clamped, and not at all when it is the
  // default window; an unknown window keeps it as requested.
  const contextTokens =
    contextState.contextDefaultPercent === undefined ? selectedRoute.contextTokens : contextState.contextTokens;
  const { contextTokens: requestedTokens, ...routeFields } = selectedRoute;
  // Tokens that land on the default window select the default, whatever
  // percent travelled with them.
  const tokensAtDefault = requestedTokens && !contextTokens && contextState.contextDefaultPercent !== undefined;
  return {
    selectedRoute: {
      ...routeFields,
      ...(tokensAtDefault ? { contextPercent: contextState.contextDefaultPercent } : {}),
      fast: fastCapable ? selectedRoute.fast === true : false,
      // Lets the saved model settings tell a chosen window from the default.
      contextDefaultPercent: contextState.contextDefaultPercent,
      ...(contextTokens ? { contextTokens } : {}),
    },
    fastCapable,
    modelMeta,
  };
}

/** Close the empty session and materialize a fresh one for the new provider. */
async function recreateEmptySession(deps) {
  const { getSession, setSession, mgr, statusRoutes, createCurrentSession, invalidatePreSessionToolSurface } = deps;
  // If the boot create is still finishing SessionStart/deferred-surface
  // work, drain that promise first. Otherwise createCurrentSession()
  // would return the old in-flight promise after we tombstone/null the
  // session, racing the intended rebuild for the new provider.
  await createCurrentSession('model-switch-empty-drain');
  const emptySession = getSession();
  if (!emptySession?.id || sessionHasRouteHistory(emptySession)) return;
  statusRoutes?.clearGatewaySessionRoute?.(emptySession.id);
  mgr.closeSession?.(emptySession.id, 'cli-model-switch-empty', { tombstone: true });
  setSession(null);
  invalidatePreSessionToolSurface?.();
  await createCurrentSession('model-switch-empty');
}

/** Rewrite the addressed idle session to the route it was asked to run on. */
function updateSessionInPlace(deps, session, updateOptions) {
  const { getRoute, getSession, setSession, mgr, statusRoutes } = deps;
  const route = getRoute();
  const fields = {
    provider: route.provider,
    model: route.model,
    fast: route.fast === true,
    autoEffort: route.autoEffort !== false,
    effort: route.effectiveEffort || null,
    modelParameters: route.modelParameters || {},
    contextPercent: route.contextPercent,
    contextTokens: route.contextTokens || null,
    selectedContextWindow: route.selectedContextWindow || null,
  };
  const updated = mgr.updateSessionRoute?.(session.id, fields, updateOptions);
  if (updated) setSession(updated);
  else Object.assign(session, fields);
  rebuildDeferredToolSurfaceForProvider(getSession(), route.provider);
  writeStatuslineRoute(statusRoutes, getSession(), route);
}

/** Persist a fully prepared route; do not yield between the idle check and live apply. */
function adoptRoute(deps, persist, prepared, options) {
  const {
    getConfig,
    getRoute,
    setRouteState,
    resolveRoute,
    refreshStatuslineUsageSnapshot,
    scheduleStatuslineUsageRefresh,
  } = deps;
  const { selectedRoute, fastCapable, modelMeta } = prepared;
  const session = deps.getSession();
  const changesSessionModel =
    session && (session.provider !== selectedRoute.provider || session.model !== selectedRoute.model);
  if (
    options?.applyToCurrentSession === true &&
    changesSessionModel &&
    (deps.getActiveTurnCount?.() > 0 || session.liveTurnMessages?.length > 0)
  ) {
    throw new Error('Cannot change the session model while a turn is running.');
  }
  persist.saveRouteModelSettings(selectedRoute, fastCapable);
  // An heir opening on its source's model is not a main-model choice.
  const leadRoute = persist.persistAdoptedModelSettings(selectedRoute, {
    keepMainModel: options?.keepMainModel === true,
  });
  setRouteState(
    resolveRouteMetadataState(
      getConfig(),
      resolveRoute(getConfig(), leadRoute ? { model: workflowPresetId('lead') } : selectedRoute),
      modelMeta
    )
  );
  refreshStatuslineUsageSnapshot(getRoute());
  scheduleStatuslineUsageRefresh();
}

/**
 * Quota-exhaustion escape hatch: apply `next` to the addressed, ESTABLISHED
 * session in place. The caller (session API) has already proven the latest
 * settled turn failed on quota and that nothing is running. Starts no turn;
 * the next turn's auto-compaction fits history to the new window.
 */
export function createContinueSessionInModel(deps, persist) {
  const { getSession, invalidateContextStatusCache } = deps;
  return async function continueSessionInModel(sessionId, next) {
    let session = getSession();
    if (!sessionId || !session?.id || session.id !== sessionId) {
      throw new Error(`session ${sessionId || ''} is not the active session`);
    }
    const prepared = await resolveSelectedRoute(deps, next);
    session = getSession();
    if (!session?.id || session.id !== sessionId) {
      throw new Error(`session ${sessionId} is not the active session`);
    }
    adoptRoute(deps, persist, prepared, { applyToCurrentSession: true });
    updateSessionInPlace(deps, session, { crossProvider: true });
    invalidateContextStatusCache();
    return true;
  };
}

export function createSetRoute(deps, persist) {
  const { getRoute, getSession, invalidateContextStatusCache, createCurrentSession } = deps;

  return async function setRoute(next, options = {}) {
    // A bare selection is for a new/inherited session. Explicit live apply
    // also permits moving an idle conversation in place after confirmation.
    const applyToCurrentSession = options?.applyToCurrentSession === true;
    const requestedSessionId = applyToCurrentSession ? getSession()?.id : null;
    const prepared = await resolveSelectedRoute(deps, next);
    // Provider discovery may yield while another session becomes current. A
    // confirmed request belongs to the original conversation, not its replacement.
    if (requestedSessionId && getSession()?.id !== requestedSessionId) {
      throw new Error(`session ${requestedSessionId} is not the active session`);
    }
    adoptRoute(deps, persist, prepared, options);
    const session = getSession();
    // Model/provider changes default to next-session-only for a session the
    // user has already talked in or compacted (provider-keyed prompt cache). But
    // a current session with no model reply, no compaction summary and no
    // in-flight first turn — empty, or holding only refused prompts — has no
    // cache to protect, so /model takes effect live: route + statusline
    // update immediately. Only a truly empty session is recreated below.
    const currentSessionEmpty = !!session && !sessionRouteCommitted(session);
    if (!currentSessionEmpty) {
      if (applyToCurrentSession && session) {
        const route = getRoute();
        if (session.provider !== route.provider || session.model !== route.model) {
          updateSessionInPlace(deps, session, { crossProvider: true });
          invalidateContextStatusCache();
        } else {
          // Same-model effort/Fast tuning keeps its context and cache.
          persist.applySessionTuning();
        }
      }
      return getRoute();
    }
    // An addressed runtime keeps its durable id: the empty session is updated
    // in place, never closed and replaced by a freshly minted one.
    if (
      !deps.getAddressedSessionId?.() &&
      shouldRecreateEmptySessionForRouteChange(session, applyToCurrentSession) &&
      session?.id &&
      typeof createCurrentSession === 'function'
    ) {
      await recreateEmptySession(deps);
      invalidateContextStatusCache();
      return getRoute();
    }
    if (session) {
      // An explicitly addressed daemon/desktop mutation must keep that
      // durable address. The caller asked to apply this route to THIS empty
      // session, so update it in place instead of closing A and silently
      // materializing B before the first prompt.
      updateSessionInPlace(deps, session);
      invalidateContextStatusCache();
    }
    return getRoute();
  };
}
