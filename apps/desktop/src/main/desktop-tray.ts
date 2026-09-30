// The tray icon is the way back to a window hidden by close-to-background on
// Windows and Linux, and its menu carries an explicit Quit. It exists while
// the setting is on, not only while the window is hidden.
import { Menu, nativeImage, Tray } from 'electron';

import { nativeT } from './native-i18n';

export interface DesktopTrayOptions {
  /** mixdog.ico on Windows (multi-size; the shell picks per DPI), mixdog.png elsewhere. */
  iconPath: string;
  open(): void;
  /** The ordinary quit path, confirmation included. */
  quit(): void;
}

export interface DesktopTray {
  /** Rebuild the tooltip and menu in the current UI language. */
  relabel(): void;
  dispose(): void;
}

// Linux status areas draw icons at about this size and do not scale a large
// bitmap down for every desktop environment.
const LINUX_TRAY_ICON_SIZE = 24;

export function createDesktopTray(options: DesktopTrayOptions): DesktopTray {
  let image = nativeImage.createFromPath(options.iconPath);
  if (process.platform === 'linux') {
    image = image.resize({ width: LINUX_TRAY_ICON_SIZE, height: LINUX_TRAY_ICON_SIZE, quality: 'best' });
  }
  const tray = new Tray(image);
  tray.on('click', () => options.open());
  const relabel = () => {
    tray.setToolTip('Mixdog');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: nativeT('Open Mixdog'), click: () => options.open() },
        { type: 'separator' },
        { label: nativeT('Quit Mixdog'), click: () => options.quit() },
      ])
    );
  };
  relabel();
  return {
    relabel,
    dispose() {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
