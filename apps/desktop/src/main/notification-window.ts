import type { BrowserWindow } from 'electron';
import { DESKTOP_IPC } from '../shared/contract-ipc';

/** Shared by ordinary activation and notification clicks; never toggles a
 * visible window closed or leaves a minimized/tray window behind the app. */
export function activateDesktopWindow(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  return true;
}

export function openDesktopNotificationSession(window: BrowserWindow | null, sessionId: string): boolean {
  if (!activateDesktopWindow(window) || !window || window.webContents.isDestroyed()) return false;
  window.webContents.send(DESKTOP_IPC.notificationOpenSession, sessionId);
  return true;
}
