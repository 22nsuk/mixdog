/** Hidden/offscreen compositors only paint the current viewport, even when CDP
 * allocates a document-sized image. Stitch actual viewport pixels, preserving
 * layout, emulation, zoom and the original scroll position. */
import { nativeImage, type WebContents } from 'electron';
import type { BrowserCdpPort } from './cdp';
import { browserRenderCheckpoint } from './render-checkpoint';
import { boundedFullPageRect, type BrowserScreenshotOptions, type BrowserScreenshotRect } from './screenshot-policy';
import { BrowserScreenshotRestoreError, captureViewportImage, encodeImage } from './screenshot-engines';

interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
}

export async function captureTiledDocument(
  cdp: BrowserCdpPort,
  guest: WebContents,
  rect: BrowserScreenshotRect,
  options: BrowserScreenshotOptions,
  timeoutMs: number,
  viewportTimeoutMs: number,
  signal?: AbortSignal
) {
  const deadline = performance.now() + timeoutMs;
  const windowObject = await cdp.call<{ result?: { objectId?: string } }>(
    guest,
    'Runtime.evaluate',
    { expression: 'window', returnByValue: false },
    signal
  );
  const objectId = windowObject.result?.objectId;
  if (!objectId) throw new Error('full-page capture could not bind its document');
  const viewport = async (position: { x: number; y: number } | null, readSignal?: AbortSignal) => {
    const response = await cdp.call<{ result?: { value?: Viewport }; exceptionDetails?: unknown }>(
      guest,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `async function(position) {
          if (position) this.scrollTo({left:position.x,top:position.y,behavior:'instant'});
          await ${browserRenderCheckpoint(false)};
          const root = this.document.documentElement;
          // innerWidth/Height round CSS pixels; the visual viewport retains
          // fractions at zoom levels such as 75%. Include scrollbar gutters.
          return {x:this.scrollX,y:this.scrollY,
            width:this.visualViewport.width + this.innerWidth - root.clientWidth,
            height:this.visualViewport.height + this.innerHeight - root.clientHeight,
            clientWidth:root.clientWidth,clientHeight:root.clientHeight};
        }`,
        arguments: [{ value: position }],
        awaitPromise: true,
        returnByValue: true,
      },
      readSignal
    );
    if (response.exceptionDetails || !response.result?.value) {
      throw new Error('full-page capture lost its document viewport');
    }
    return response.result.value;
  };
  const capture = () => {
    signal?.throwIfAborted();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('full-page capture timed out');
    guest.invalidate();
    return captureViewportImage(guest, Math.min(remaining, viewportTimeoutMs), signal);
  };
  let original: Viewport | undefined;
  const failures: unknown[] = [];
  try {
    original = await viewport(null, signal);
    const firstView = await viewport({ x: rect.x, y: rect.y }, signal);
    const firstImage = await capture();
    const firstSize = firstImage.getSize();
    if (firstView.width <= 0 || firstView.height <= 0 || firstSize.width <= 0 || firstSize.height <= 0) {
      throw new Error('full-page capture has no viewport pixels');
    }
    const scaleX = firstSize.width / firstView.width;
    const scaleY = firstSize.height / firstView.height;
    // Chromium reports fractional CSS viewport sizes as float32. Round the
    // raster extent so its representation error cannot invent an extra row.
    const { width, height } = boundedFullPageRect({
      width: Math.round(rect.width * scaleX),
      height: Math.round(rect.height * scaleY),
    });
    const stepX = Math.floor(firstView.clientWidth * scaleX);
    const stepY = Math.floor(firstView.clientHeight * scaleY);
    if (stepX <= 0 || stepY <= 0) throw new Error('full-page capture has no scrollable viewport');
    const bitmap = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const first = x === 0 && y === 0;
        const view = first ? firstView : await viewport({ x: rect.x + x / scaleX, y: rect.y + y / scaleY }, signal);
        const image = first ? firstImage : await capture();
        const size = image.getSize();
        const sx = x - Math.round((view.x - rect.x) * scaleX);
        const sy = y - Math.round((view.y - rect.y) * scaleY);
        const tileWidth = Math.min(stepX, width - x);
        const tileHeight = Math.min(stepY, height - y);
        if (
          size.width !== firstSize.width ||
          size.height !== firstSize.height ||
          sx < 0 ||
          sy < 0 ||
          sx + tileWidth > size.width ||
          sy + tileHeight > size.height
        ) {
          throw new Error(
            'full-page capture cannot cover the requested document without missing pixels: ' +
              JSON.stringify({ rect, firstView, view, firstSize, size, x, y, sx, sy, tileWidth, tileHeight })
          );
        }
        const pixels = image.toBitmap();
        for (let row = 0; row < tileHeight; row++) {
          const start = ((sy + row) * size.width + sx) * 4;
          pixels.copy(bitmap, ((y + row) * width + x) * 4, start, start + tileWidth * 4);
        }
      }
    }
    const result = encodeImage(nativeImage.createFromBitmap(bitmap, { width, height }), options);
    if (!result) throw new Error('full-page capture exceeded the image budget');
    return result;
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    try {
      if (original) await viewport({ x: original.x, y: original.y });
      await cdp.call(guest, 'Runtime.releaseObject', { objectId });
    } catch (error) {
      failures.push(error);
      throw new BrowserScreenshotRestoreError('scroll', failures);
    }
  }
}
