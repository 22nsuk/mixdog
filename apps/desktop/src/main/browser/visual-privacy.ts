/** Agent-only visual output checks. User presentation and historical frames
 * stay untouched; an unsafe new capture is discarded before publication. */
import type { WebContents } from 'electron';
import { BROWSER_DOCUMENT_ROOTS, browserDocumentChanged, type createBrowserDocuments } from './documents';
import type { BrowserGuestStateStore } from './guest-state';

export type BrowserVisualPrivacy = (guest: WebContents, signal?: AbortSignal) => Promise<() => Promise<void>>;

const VISIBLE_PLAIN_VALUES = `(() => {
  const values = [];
  for (const root of (${BROWSER_DOCUMENT_ROOTS})()) {
    for (const field of root.querySelectorAll('input,textarea')) {
      if (field.type === 'password' || !field.getClientRects().length) continue;
      const style = getComputedStyle(field);
      if (style.visibility === 'hidden' || style.visibility === 'collapse') continue;
      values.push(String(field.value || ''));
    }
  }
  return values;
})()`;

export function createBrowserVisualPrivacy(host: {
  state: Pick<BrowserGuestStateStore, 'peek'>;
  documents: Pick<ReturnType<typeof createBrowserDocuments>, 'pageText' | 'collect' | 'revision'>;
}): BrowserVisualPrivacy {
  const secretsFor = (guest: WebContents) => [...(host.state.peek(guest)?.sensitiveValues || [])].filter(Boolean);
  const withheld = () =>
    new Error(
      'Visual output withheld to protect a registered credential. Use a semantic snapshot or read; no image or PDF was returned.'
    );
  return async (guest, signal) => {
    const secrets = secretsFor(guest);
    const unchangedSecrets = () => {
      const current = secretsFor(guest);
      return current.length === secrets.length && current.every((value) => secrets.includes(value));
    };
    if (!secrets.length) {
      return async () => {
        if (!unchangedSecrets()) throw withheld();
      };
    }
    const checkText = async () => {
      const text = await host.documents.pageText(guest, signal);
      const values = (await host.documents.collect<string[]>(guest, VISIBLE_PLAIN_VALUES, signal)).flat();
      if (secrets.some((secret) => text.includes(secret) || values.some((value) => value.includes(secret)))) {
        throw withheld();
      }
    };
    const before = await host.documents.revision(guest, signal);
    await checkText();
    return async () => {
      if (!unchangedSecrets()) throw withheld();
      await checkText();
      const after = await host.documents.revision(guest, signal);
      if (browserDocumentChanged(before, after, { includeScroll: true }) !== false) throw withheld();
    };
  };
}
