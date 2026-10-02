// A document authored from HTML keeps that HTML beside it (`<file>.mixdog-source.html`), and `author` with no script
// rebuilds the file from it. An edit made to the file itself — a `batch` on the session — is not in that HTML, so
// the next rebuild drops it without a word: a deck's spacing fixed by moving shapes came back the moment the deck
// was authored again from its source. The session remembers which HTML it was built from and how many edits have
// landed since; a batch says so when it changes the file, and the next author says what it replaced.

/** Records the HTML a session's file was just authored from; edits counted from here. */
export function markAuthoredFromHtml(session, sourcePath) {
  if (!session) return;
  session.htmlSource = sourcePath || null;
  session.htmlSourceEdits = 0;
}

/** After a batch: counts the edits that landed and returns the notice for the batch result, or null. */
export function noteBatchAgainstHtml(session, batch) {
  if (!session?.htmlSource) return null;
  const changed = Number(batch?.changeSummary?.changed) || 0;
  if (!changed) return null;
  session.htmlSourceEdits = (Number(session.htmlSourceEdits) || 0) + changed;
  return {
    path: session.htmlSource,
    current: false,
    editsSinceAuthor: session.htmlSourceEdits,
    note: `These edits changed the file, not ${session.htmlSource}. author with no script rebuilds the file from that HTML and drops them: make the same change in the HTML too, or keep finishing this file with batch.`,
  };
}

/** Before a re-author replaces the file: what the previous session had edited past its HTML, or null. */
export function editsReplacedByAuthor(previous) {
  const count = Number(previous?.htmlSourceEdits) || 0;
  if (!count) return null;
  return {
    count,
    note: `${count} edit${count === 1 ? '' : 's'} made with batch since the last author ${count === 1 ? 'was' : 'were'} in the replaced file, not in the HTML; the new file does not carry ${count === 1 ? 'it' : 'them'}. Check that the HTML now holds the same fixes.`,
  };
}
