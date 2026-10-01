// Closing the window can hide it instead of quitting: the page, the Browser
// and Computer Use hosts, keep-awake and turn notifications all stay alive,
// and reopening shows the same document. Windows and Linux get a tray icon as
// the way back; macOS keeps its Dock icon. Settings choose hide to tray (the
// default) or quit; closing never asks (user: 옵션에서 트레이로. 진짜종료
// 두개 디폴트는 트레이로).

export interface BackgroundWindowOptions {
  /** The runInBackground setting: true hides to the tray, false quits. */
  enabled(): boolean;
  /** An approved quit, installer restart or relaunch: closes go through. */
  quitting(): boolean;
}

export interface BackgroundWindow {
  /** The window's `close` listener: prevents the close and hides instead. */
  onClose(event: { preventDefault(): void }, hide: () => void): void;
}

export function createBackgroundWindow(options: BackgroundWindowOptions): BackgroundWindow {
  return {
    onClose(event, hide) {
      if (options.quitting() || !options.enabled()) return;
      event.preventDefault();
      hide();
    },
  };
}
