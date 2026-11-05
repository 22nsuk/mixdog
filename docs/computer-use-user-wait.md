# Computer Use user wait and quiet resume

> **Current overlay behavior.** The pill has three states — working (Stop),
> paused (Resume and Stop), or gone. Resume continues the paused generation,
> recovering a latched cleanup first; the quiet-interval auto-resume below still
> applies to ordinary input pauses. Stop closes the pill with the press and
> cancels the task, which reports the stop as a failure. A cleanup Stop could
> not confirm, or a failed cleanup no paused task is waiting on, never keeps the
> pill on screen: the next input command retries that recovery once and returns
> its reason if it still fails. Overlay details in the later sections that
> predate this (a Stop-only pill, a pill held up by failed cleanup) are history.

## Contract

- `computer({ action: "wait_for_user", input: { timeout_ms: 60000 } })`
  observes control availability, without input, window capture, or an execution
  queue slot. Its status is `resumed`, `timeout`, or `cancelled`.
- Only `resumed` permits a **new capture**. No interrupted input is replayed.
  A timeout is not permission to send input. Each wait is bounded at 120 seconds;
  duplicate session waits and excess waiters are refused.
- Ordinary input interruptions and manual pause retain requests that have not
  started. Requests keep their per-session order and admission limits. They
  wait outside the desktop lane and the active-operation drain, so cleanup and
  Resume cannot deadlock behind the paused queue. Stop and caller cancellation
  cancel the queued requests, including when pause cleanup is still running.
- After Resume, queued reads run against current state. A queued mutation returns
  a fresh target observation with `computer_resume_recapture_required`; the agent
  reviews it and issues a new action rather than replaying old coordinates,
  refs, or a partially executed input. Queue preservation is not input replay.
- Ordinary `user_input_active` interruptions can resume after five continuous
  quiet seconds. The saved host preference supports 1–60 seconds, or manual
  (0), independently of window/action authorization. The minimal overlay does
  not display a time selector.
- New input, a held key/button, replacement observation, or a changed setting
  resets the quiet period. Cleanup must finish first. The final input sequence
  is checked again after the resume barrier.
- Explicit stop, authorization/environment changes, unknown input observation,
  and failed input cleanup never use the idle path. Existing authorization,
  target freshness and foreground guards still apply to subsequent commands.
- Native sampling returns only readiness, generation/sequence, elapsed idle time
  and a held-input boolean. It does not return keys, text, coordinates or pixels.

## Overlay and execution boundaries

The overlay uses a dedicated sandboxed preload and per-WebContents IPC, rather
than custom-scheme navigation. The handler validates its owning main frame,
action, generation and payload. Requests receive acknowledgements. The visible
surface distinguishes "Mixdog 사용 중", "사용자 조작 중" and "확인 필요", and
shows the guidance line (quiet-resume countdown, cleanup state, request
failure) on the pill itself. Two controls exist: Stop is always present;
Resume appears only while the user holds control. There is no pause button:
touching the mouse or keyboard already hands control to the user. Stop cancels
the queued work, ends the owning agent turns, and is the recovery path for a
latched cleanup failure: it waits for every input worker to exit, releases any
owned input, and only that evidence clears the barrier. A rejected Stop is
reported on the pill even though Stop moves the takeover generation. The
`user_pause` takeover remains as an internal safety pause when the control
renderer is lost. Ctrl+Alt+Esc remains an emergency Stop.

The user waiter and parked command requests live outside the active operations
that Resume drains. Old frame/target state is invalidated before control
availability is published. A fresh observation, not the old action, follows.

## References and limits

Local `cua` human completion adapter/server informed the request-state and
bounded-wait separation; they do not themselves implement idle-based consent.
No reference code was copied. Existing Cua/Hermes transport uncertainty and
no-replay principles remain in effect.

The installed overlay was reported to ignore Resume. Source changes alone are
not evidence of an installed fix. A hidden isolated Electron test checks the
actual preload/IPC route without touching user windows. Native compilation and
boundary tests do not establish real multi-monitor hook reliability, nor do
they complete the pending Notepad/Calculator/Excel live acceptance checks.

No deployment or app restart is part of this change.

## Queue-preserving pause revision

The fixed-caption/single-button surface is superseded by distinct status
text and a separate Stop button. The hidden Electron fixture checks both
languages, all status/detail layouts, and real pause/resume/Stop preload IPC
without showing a window. Queue tests cover FIFO preservation, native
interruption, foreground-lane cleanup, fresh-target handoff and cancellation.
Deployment and installed-app pointer acceptance remain separate approvals.
