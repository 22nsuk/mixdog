import { createRoot } from 'react-dom/client';
import { runTranscriptMotionProbe } from './transcript-motion';

export async function runFrame() {
  const root = createRoot(document.getElementById('root')!);
  try {
    return await runTranscriptMotionProbe(root);
  } finally {
    root.unmount();
  }
}

// The iframe has the real Vite Markdown worker, but no preload bridge or
// application state. The desktop's read-only contextBridge is never replaced.
export async function runDevTranscriptMotionProbe() {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;inset:0;width:1000px;height:720px;z-index:2147483647;border:0';
  const moduleUrl = import.meta.url;
  let timer = 0;
  let receive: (event: MessageEvent) => void;
  const result = new Promise<Awaited<ReturnType<typeof runFrame>>>((resolve, reject) => {
    receive = (event) => {
      if (event.source !== iframe.contentWindow || event.data?.type !== 'transcript-motion-result') return;
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.report);
    };
    window.addEventListener('message', receive);
    timer = window.setTimeout(() => reject(new Error('Dev motion probe timed out')), 120_000);
  });
  iframe.srcdoc = `<!doctype html><html><head>
    <base href="${location.origin}/">
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/desktop.css">
    </head><body><div id="root"></div><script type="module">
    import '/process-shim';
    import { injectIntoGlobalHook } from '/@react-refresh';
    injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    try {
      await import('/bootstrap-styles.ts');
      await import('/i18n.ts').then(module => module.initUiLanguage());
      const { runFrame } = await import(${JSON.stringify(moduleUrl)});
      const report = await runFrame();
      parent.postMessage({ type: 'transcript-motion-result', report }, ${JSON.stringify(location.origin)});
    } catch (error) {
      parent.postMessage({ type: 'transcript-motion-result', error: String(error.stack || error) }, ${JSON.stringify(location.origin)});
    }
    </script></body></html>`;
  document.body.append(iframe);
  try {
    return await result;
  } finally {
    window.clearTimeout(timer);
    window.removeEventListener('message', receive!);
    iframe.remove();
  }
}
