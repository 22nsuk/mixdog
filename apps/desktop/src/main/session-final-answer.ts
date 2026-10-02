import type { SessionSnapshot } from '../shared/contract';

export interface SessionFinalAnswer {
  id: string | number;
  at: number;
  status: 'done' | 'failed' | 'cancelled';
  text: string;
}

/** A completed turn owns its answer by ID. A late/incomplete projection is
 *  pending, not permission to substitute a preview or an earlier answer. */
export function sessionFinalAnswer(snapshot: SessionSnapshot, startedAt: number): SessionFinalAnswer | null {
  if (!snapshot || snapshot.busy || snapshot.streamingTail || !Number.isFinite(startedAt)) return null;
  const items = snapshot.items ?? [];
  let doneIndex = items.length - 1;
  while (doneIndex >= 0 && items[doneIndex].kind !== 'turndone') doneIndex -= 1;
  if (doneIndex < 0) return null;
  const done = items[doneIndex];
  if (done.id == null || typeof done.at !== 'number' || done.at < startedAt) return null;
  // A newer prompt can arrive before the next busy roster does.
  if (items.slice(doneIndex + 1).some((item) => item.kind === 'user' || item.kind === 'assistant')) return null;
  if (done.status === 'failed' || done.status === 'cancelled') {
    return { id: done.id, at: done.at, status: done.status, text: '' };
  }
  if (done.status !== 'done' || done.finalAssistantId == null) return null;
  let answerIndex = doneIndex - 1;
  while (
    answerIndex >= 0 &&
    (items[answerIndex].id !== done.finalAssistantId || items[answerIndex].kind !== 'assistant')
  )
    answerIndex -= 1;
  if (answerIndex < 0) return null;
  if (items.slice(answerIndex + 1, doneIndex).some((item) => item.kind === 'turndone')) return null;
  const answer = items[answerIndex];
  if (answer.streaming === true || typeof answer.text !== 'string' || !answer.text.trim()) return null;
  return { id: done.id, at: done.at, status: 'done', text: answer.text };
}
