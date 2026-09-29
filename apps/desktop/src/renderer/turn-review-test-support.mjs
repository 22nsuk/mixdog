// One jsdom window for the TurnReviewBar tests: installed as the globals React
// reads, torn down (unmount, close, previous globals restored) when the test ends.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

/** `desktop` becomes `window.mixdogDesktop`; `navigator` overrides the jsdom one. */
export function installReviewDom(t, { desktop = {}, navigator } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://mixdog.test/',
    pretendToBeVisual: true,
  });
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', ...(navigator ? ['navigator'] : [])];
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  if (navigator) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.mixdogDesktop = desktop;
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { dom, root };
}
