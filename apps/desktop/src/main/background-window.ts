// Closing the window can hide it instead of quitting: the page, the Browser
// and Computer Use hosts, keep-awake and turn notifications all stay alive,
// and reopening shows the same document. Windows and Linux get a tray icon as
// the way back; macOS keeps its Dock icon. The first close there asks once —
// hide to the tray or quit — and remembers the answer (user: 닫기 옵션으로
// 바로 닫히기, 트레이로 이렇게 하지 않냐). Dismissing the question decides
// nothing and asks again next time.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';

export interface BackgroundWindowOptions {
  /** The runInBackground setting. */
  enabled(): boolean;
  /** An approved quit, installer restart or relaunch: closes go through. */
  quitting(): boolean;
  /** Present once the first-close question was answered. */
  noticeMarkerPath: string;
  /** "Quit completely": turns runInBackground off and quits. */
  quitInstead(): void;
  showNotice(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  nativeT(key: string): string;
  platform?: NodeJS.Platform;
}

export interface BackgroundWindow {
  /** The window's `close` listener: prevents the close and hides instead. */
  onClose(event: { preventDefault(): void }, hide: () => void): void;
}

export function createBackgroundWindow(options: BackgroundWindowOptions): BackgroundWindow {
  const { nativeT } = options;
  const platform = options.platform ?? process.platform;
  let noticeOpen = false;

  function acknowledged(): boolean {
    return platform === 'darwin' || existsSync(options.noticeMarkerPath);
  }

  async function explainThenHide(hide: () => void): Promise<void> {
    const { response } = await options.showNotice({
      type: 'info',
      title: 'Mixdog',
      message: nativeT('What should closing the window do?'),
      detail: nativeT(
        'Hiding to the tray keeps agents, keep-awake, and Browser Use running; open Mixdog again from the tray icon. Your choice is remembered, and you can change it in Settings.'
      ),
      buttons: [nativeT('Hide to tray'), nativeT('Quit completely'), nativeT('Cancel')],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    // A late answer after a quit started must not hide a closing window.
    if ((response !== 0 && response !== 1) || options.quitting()) return;
    try {
      mkdirSync(dirname(options.noticeMarkerPath), { recursive: true });
      writeFileSync(options.noticeMarkerPath, '');
    } catch (error) {
      console.warn('Mixdog could not record the background notice:', error);
    }
    if (response === 1) options.quitInstead();
    else hide();
  }

  return {
    onClose(event, hide) {
      if (options.quitting() || !options.enabled()) return;
      event.preventDefault();
      if (acknowledged()) {
        hide();
        return;
      }
      if (noticeOpen) return;
      noticeOpen = true;
      void explainThenHide(hide)
        .catch((error: unknown) => {
          console.warn('Mixdog background notice failed:', error);
        })
        .finally(() => {
          noticeOpen = false;
        });
    },
  };
}
