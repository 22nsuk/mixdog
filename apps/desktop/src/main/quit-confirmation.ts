// Quitting Mixdog never stops an agent turn — the daemon finishes it — but it
// does take down what lives in this process: keep-awake, Browser Use, Computer
// Use and turn notifications. The quit asks only when that interrupts work.
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';

/** An inspection that misses this deadline counts as work in progress: a
 *  needless question is cheaper than a silent interruption. */
export const QUIT_INSPECTION_DEADLINE_MS = 2_000;

export interface QuitConfirmationOptions {
  /** Resolves true while any agent is working. */
  inspect(): Promise<boolean>;
  /** A native box without an owner window, so it works while the window is hidden. */
  show(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  nativeT(key: string): string;
  deadlineMs?: number;
}

export interface QuitConfirmation {
  /** True when the quit may proceed. Repeated requests join the open decision. */
  confirm(): Promise<boolean>;
}

function workInProgress(inspect: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), deadlineMs);
    inspect().then(
      (working) => {
        clearTimeout(timer);
        resolve(working);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      }
    );
  });
}

export function createQuitConfirmation(options: QuitConfirmationOptions): QuitConfirmation {
  const { nativeT } = options;
  let pending: Promise<boolean> | null = null;
  async function decide(): Promise<boolean> {
    if (!(await workInProgress(options.inspect, options.deadlineMs ?? QUIT_INSPECTION_DEADLINE_MS))) return true;
    const { response } = await options.show({
      type: 'warning',
      title: 'Mixdog',
      message: nativeT('Quit Mixdog while agents are working?'),
      detail: nativeT(
        'Agents keep working in the background, but keep-awake, Browser Use, and Computer Use stop until Mixdog is opened again.'
      ),
      buttons: [nativeT('Quit Mixdog'), nativeT('Cancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return response === 0;
  }
  return {
    confirm() {
      pending ??= decide()
        .catch(() => true)
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
