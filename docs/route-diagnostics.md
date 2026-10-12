# Route diagnostics

In the desktop or remote web app, open `/context` and expand **Model · Details**.
It is a read-only view of bounded runtime evidence; opening it does not make a
model request, change settings, or read diagnostic logs.

## Reading the report

**Current** shows the active session's route, or the draft route before a
session exists. **History** shows the latest user turn's preparation, frozen
before its preflight checkpoint. Its timestamp is the start of that turn.
A later model/effort change does not rewrite that record. A copied transcript
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
The current strict host validator and legacy omission semantics are unchanged.

## Regression checks

The owning tests cover the bounded contract, live/history separation,
serialization and canonical-reader round trips, actual turn preparation,
context cache and preview boundaries, the rendered disclosure, and the real
remote shim with E2EE framing. The remote matrix covers Auto omitted/false/true,
Fast/parameters/context percentage, select/inherit/continue/restored drafts,
cold handshakes, reconnection during view sync, and optional diagnostic data.
Schedule/webhook editors share the tested `+noauto` capability gate. The legacy
selection field list is pinned to v1.1.2 (`22d55fe1`); this is a contract test,
not a claim to have launched every old packaged application or physical phone.
