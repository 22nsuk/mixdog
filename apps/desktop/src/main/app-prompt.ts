// Main-process confirmations drawn in the app's own dialog (user: 이거 팝업
// 우리 테마로 좀 바꾸고). The renderer acknowledges a prompt the moment it
// receives it; a hidden, loading or unresponsive window gets the native box
// instead, so a quit or a close is never left waiting on a missing dialog.
import { randomUUID } from 'node:crypto';

import type { BrowserWindow, IpcMain, IpcMainEvent, MessageBoxOptions, MessageBoxReturnValue } from 'electron';

import { DESKTOP_IPC, type DesktopAppPrompt } from '../shared/contract';

/** Time the renderer has to acknowledge before the native box takes over. */
export const APP_PROMPT_ACK_MS = 1_500;

export interface AppPromptOptions {
  getWindow(): BrowserWindow | null;
  ipcMain: Pick<IpcMain, 'on'>;
  fallback(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  ackMs?: number;
}

export interface AppPrompt {
  /** A two-button message box (confirm first, cancel second), or three
   *  (confirm, alternate, cancel), answered in the app when it can be and
   *  natively otherwise. */
  show(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
}

interface Pending {
  window: BrowserWindow;
  acknowledge(): void;
  settle(state: 'confirm' | 'alternate' | 'cancel'): void;
}

export function createAppPrompt(options: AppPromptOptions): AppPrompt {
  const pending = new Map<string, Pending>();
  options.ipcMain.on(DESKTOP_IPC.appPromptAnswer, (event: IpcMainEvent, id: unknown, state: unknown) => {
    const entry = typeof id === 'string' ? pending.get(id) : undefined;
    if (!entry || event.sender !== entry.window.webContents) return;
    if (state === 'shown') {
      entry.acknowledge();
      return;
    }
    entry.settle(state === 'confirm' || state === 'alternate' ? state : 'cancel');
  });

  return {
    show(box) {
      const window = options.getWindow();
      const buttons = box.buttons ?? [];
      if (
        !window ||
        window.isDestroyed() ||
        !window.isVisible() ||
        window.webContents.isLoading() ||
        window.webContents.isCrashed() ||
        (buttons.length !== 2 && buttons.length !== 3)
      ) {
        return options.fallback(box);
      }
      const alternate = buttons.length === 3;
      const cancelId = box.cancelId ?? buttons.length - 1;
      const id = randomUUID();
      const prompt: DesktopAppPrompt = {
        id,
        title: box.message,
        description: box.detail ?? '',
        confirmLabel: buttons[0],
        danger: box.type === 'warning',
        ...(alternate ? { alternateLabel: buttons[1] } : {}),
      };
      return new Promise<MessageBoxReturnValue>((resolve, reject) => {
        let ackTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          pending.delete(id);
          clearTimeout(ackTimer);
          window.removeListener('closed', onClosed);
        };
        const settle = (state: 'confirm' | 'alternate' | 'cancel') => {
          finish();
          const response = state === 'confirm' ? 0 : state === 'alternate' && alternate ? 1 : cancelId;
          resolve({ response, checkboxChecked: false });
        };
        const onClosed = () => settle('cancel');
        ackTimer = setTimeout(() => {
          finish();
          options.fallback(box).then(resolve, reject);
        }, options.ackMs ?? APP_PROMPT_ACK_MS);
        window.once('closed', onClosed);
        pending.set(id, { window, acknowledge: () => clearTimeout(ackTimer), settle });
        window.webContents.send(DESKTOP_IPC.appPrompt, prompt);
      });
    },
  };
}
