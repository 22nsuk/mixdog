import type { BrowserWindow } from 'electron';

/** Renderer expression resolving to the sidebar row of `id`: the session list
 *  arrives asynchronously after boot, so the row is awaited, not assumed. */
export function waitForProbeSessionRow(id: string, missing: string): string {
  return `await (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = document.querySelector('[data-session-id="${id}"]');
      if (row instanceof HTMLElement) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(${JSON.stringify(missing)});
  })()`;
}

export async function clickProbeSession(window: BrowserWindow, id: string, waitMs: number): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    const row = ${waitForProbeSessionRow(id, `Missing switch probe row: ${id}`)};
    row.click();
    await new Promise((resolve) => setTimeout(resolve, ${waitMs}));
    return true;
  })()`);
}

export const COLLECT_SWITCH_FRAMES_SCRIPT = `(() => {
  cancelAnimationFrame(window.__switchProbe.raf);
  return window.__switchProbe.frames;
})()`;
