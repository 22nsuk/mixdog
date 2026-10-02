// Never silently evaluate a probe in a blank helper window or an ambiguous page.
export function selectDomTarget(targets, url = '') {
  const candidates = targets.filter(
    (target) =>
      target.type === 'page' &&
      target.webSocketDebuggerUrl &&
      (url ? target.url === url : target.url && target.url !== 'about:blank')
  );
  if (candidates.length === 0) throw new Error('No matching debuggable page target found.');
  if (candidates.length !== 1) {
    throw new Error('Multiple debuggable pages match; specify a unique --url=<page-url>.');
  }
  return candidates[0];
}
