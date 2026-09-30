export interface ComputerUseOverlayControls {
  stop(sessionIds: string[]): Promise<void>;
  /** Continue the task paused at `generation`; a newer pause makes it stale. */
  resume?(generation: number): Promise<void>;
  /** Pause input without ending the task when the control surface is lost. */
  pause?(): Promise<void>;
  /** Quiet seconds after which an ordinary input pause resumes; 0 is manual. */
  configureIdleResume?(seconds: number): void;
}

export type ComputerOverlayControlError = '' | 'cleanup' | 'stop' | 'failed';

/** A control the host never hears back from must not latch the pill: the
 *  request is released before the overlay's own wait ends, so the next press —
 *  including Stop and the emergency shortcut — is accepted instead of joining
 *  a request that never settles. */
const CONTROL_DEADLINE_MS = 15_000;

function withControlDeadline(work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  // The deadline may win the race; the abandoned work keeps its own handler so
  // a later rejection is not unhandled.
  work.catch(() => {});
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('computer_control_timeout')), CONTROL_DEADLINE_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

type OverlayAction = 'stop' | 'pause' | 'resume';

/** Trusted overlay only: never exported as a model/bridge command. The pill
 *  offers Stop, plus Resume while paused; Pause belongs to a lost control
 *  surface alone. A failure outlives the takeover generation Stop itself
 *  advances, or the user would see nothing. */
export function createComputerOverlayController(controls: ComputerUseOverlayControls, changed: () => void) {
  let busy = false;
  let error: ComputerOverlayControlError = '';
  let pending: object | undefined;
  let stopping: Promise<void> | undefined;
  const run = async (action: OverlayAction, sessionIds: string[], generation: number): Promise<void> => {
    // Pause and Resume wait for a running control; Stop is never refused,
    // because it is the user's way out.
    if (busy && action !== 'stop') return;
    const request = {};
    pending = request;
    busy = true;
    error = '';
    changed();
    try {
      if (action === 'pause') {
        if (!controls.pause) throw new Error('Pause unavailable');
        await withControlDeadline(controls.pause());
      } else if (action === 'resume') {
        if (!controls.resume) throw new Error('Resume unavailable');
        await withControlDeadline(controls.resume(generation));
      } else await withControlDeadline(controls.stop(sessionIds));
    } catch (reason) {
      if (pending !== request) return;
      const message = String((reason as Error)?.message || '');
      error = 'failed';
      if (/computer_(cleanup_pending|abort_cleanup_unconfirmed|background_cleanup_unconfirmed)/.test(message)) {
        error = 'cleanup';
      } else if (/computer_stop_unconfirmed/.test(message)) error = 'stop';
    } finally {
      if (pending === request) {
        pending = undefined;
        busy = false;
        changed();
      }
    }
  };
  return {
    state() {
      return { busy, error };
    },
    invoke(action: OverlayAction, sessionIds: string[], generation = 0): Promise<void> {
      if (action !== 'stop') return run(action, sessionIds, generation);
      // A repeated press joins the same stop; it must not advance the takeover
      // generation while the original cleanup is still confirming that generation.
      stopping ??= run(action, sessionIds, generation).finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
  };
}
