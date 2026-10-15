# Route diagnostics

In the desktop or remote web app, open `/context` and expand **Model · Details**.
It is a read-only view of bounded runtime evidence; opening it does not make a
model request, change settings, or read diagnostic logs.

## Reading the report

**Current** shows the active session's route, or the draft route before a
session exists. **History** shows the latest user turn's preparation, frozen
after the concurrent user-turn preparation and Auto judgment settle, beside
the actual effort configuration and before the preflight checkpoint. The
existing post-wait fallback effort semantics and early transport prewarm are
unchanged. Its timestamp is the start of that turn, not the capture time.
A later model/effort change does not rewrite that record. Receipt-less skill,
recovery and notification messages do not hide the recorded turn. A runtime
turn with its own receipt owns its preparation, including `runtime-prompt`.
A genuine unrecorded user request or a compaction summary ends the search.
A copied transcript
from another session, an older unrecorded turn, or history removed by compaction
is unavailable, not reconstructed from today's settings.

`preparedEffort` is the effort prepared for the turn. `recordedEffort` is the
newest effort-configuration marker within that same turn, from its user message
or a tool-result step. Neither is a capture of the provider's final wire payload
or evidence that a provider accepted the setting. The report explicitly says
`runtime-prepared-not-provider-confirmed`: it does not assert successful
execution, provider-side model identity, billed service tier, or acceptance of
an effort update after a provider retry. An unknown value is an em dash.

The Auto section records the mode (`on`, `observe`, `off`), its source
(`environment`, `built-in`, or `unavailable`), and the selection or skip reason.
`selectedEffort` can differ from `preparedEffort` in observe mode. `effortChanged`
means the turn preparation overrode the configured effort; false does not mean
the judge was never used (it may have selected the same effort).

| Reason | Meaning |
| --- | --- |
| `selected` | The judge selected an effort in on mode. |
| `observe-only` | The judge ran, but its selection was not applied. |
| `master-off` | The effective master/environment setting is off. |
| `configuration-unavailable` | Reading that setting failed; the runtime kept its existing off fallback. |
| `route-off` | This route opted out of Auto. |
| `runtime-prompt` | This is a runtime-injected turn, not a user/agent brief. |
| `empty-or-tagged-prompt` | There is no eligible request text. |
| `unsupported-route` | This provider/model route does not currently accept Auto effort. |
| `judge-unavailable` | The judge could not provide probabilities; its bounded status is shown separately. |
| `outside-auto-range` | The selected fixed effort is outside Auto's adjustable range. |

Judge states distinguish `unsupported`, `installing`, `model-missing`,
`warming`, `busy`, `timeout`, `load-error`, and `worker-exited`. Other failure
text becomes `other`; file paths and raw loader error bodies are not copied.

`autoEffortSource` describes only the field observed on the session/route:
`recorded-field` or `implicit-default` (an absent flag defaults on). It does
**not** claim to recover the original explicit-input/model-setting/preset
precedence chain. Other fields likewise show observed route values, not
reconstructed configuration ancestry.

The Connection section's `routeAutoEffort` reports whether the current host
advertises per-route Auto control. This is not the master switch and does not
mean the local judge is installed or running. Older hosts leave diagnostics
unavailable while their existing context report continues to work.

## Data and compatibility boundaries

Only known scalar fields are retained: provider/model identifiers, configured
and prepared effort, Fast, Auto, context window and recognized service tier.
The context window follows `selectedContextWindow || contextWindow`, matching
turn preparation for both drafts and sessions. The tier is the configured
`modelParameters.serviceTier`; even with Fast off it is not proof of a sent or
billed tier.
Arbitrary model parameters, prompts, tool results, credentials, probabilities,
and raw errors are excluded. Technical field/reason identifiers stay stable;
the surrounding headings use the existing localized UI.

The small version-1 receipt lives in the user message's metadata and follows
the existing session serialization/checkpoint path. There is no separate log,
background polling or unbounded collection. Ordinary context gauges and entry
preview requests do not carry the receipt. Explicit inspector requests compute
it outside the token-status cache and the client checks the session id/version
before displaying it. Unsupported future shapes remain unavailable.

Route selection parameters are projected only after the sending connection's
handshake and view-sync waits. A cold or reconnecting client must not strip an
explicit Auto opt-out merely because capability flags have not arrived yet;
a host that does not advertise support still never receives `autoEffort`.
Closing a connection rejects an RPC waiting on its view sync. Model selection,
inheritance and continuation calls are not silently replayed on a replacement
host. New-task submission retains its existing stable-ID recovery and projects
the route again on each attempt. A new call made while reconnecting uses the
replacement host's capability. The current strict host validator and legacy
omission semantics are unchanged.

## Selection boundaries

This follow-up extracts the diagnostic and selection-boundary work from fork
PR #27 / upstream PR #65 onto v1.2.2. It does not restore the older model-switch
implementation or its confirmation dialog. Current in-place switching,
transcript boundaries, pre-switch compaction, quota escape and serialized
optimistic choices remain the owning behavior.

An addressed choice binds to the durable session id before provider discovery.
After discovery the runtime rechecks that id and refuses a model change if a
turn started. Settings persistence, metadata normalization and live application
then run without another asynchronous wait between them. Refreshing the object
for the same durable id is allowed; replacing or removing the session is not.
Same-model effort/Fast tuning and an unaddressed next-session preference retain
their existing behavior. The session surface rechecks identity and busy state
before compaction, recomputes the source model after preceding queued choices,
and does not roll an older preview back onto a different session.

The host's existing preset listing adds a concrete `selection`, resolved with
normal saved-model-setting precedence. Only fields accepted by the current
model-selection validator cross that boundary. Both live and draft `/model`
choices use it, replacing rather than merging old per-model preferences.
A draft never modifies a live session. A host without preset-resolution data
returns an explicit compatibility error instead of inventing a provider or
silently losing preset tuning. No new RPC or authority is introduced.

## Regression checks

The owning tests cover the bounded contract, live/history separation,
serialization and canonical-reader round trips, actual turn preparation,
context cache and preview boundaries, the rendered disclosure, and the real
remote shim with E2EE framing. The remote matrix covers Auto omitted/false/true,
Fast/parameters/context percentage, select/inherit/continue/restored drafts,
cold handshakes, interruption during view sync, fresh calls during reconnect
with and without view sync, and optional diagnostic data.
Schedule/webhook editors share the tested `+noauto` capability gate. The legacy
selection field list is pinned to v1.1.2 (`22d55fe1`); this is a contract test,
not a claim to have launched every old packaged application or physical phone.

Additional checks exercise the actual route API with delayed discovery and
zero-write assertions for replaced/deleted/busy sessions, current compaction
and queue behavior, exact token-window normalization, parallel turn preparation,
and tuned preset selection through real IPC validation and encrypted remote
framing. Controlled peers and fake providers are not live-backend or installed
application verification.
