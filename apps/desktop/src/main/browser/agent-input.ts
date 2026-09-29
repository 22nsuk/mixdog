/** CDP input from the agent or a paired phone travels the same browser-side
 *  input path as a person's native input on a presented page. While such a
 *  dispatch is in flight, that page's input observers attribute what they see
 *  to it rather than to the person at the keyboard. */
import type { WebContents } from 'electron';

const inFlight = new WeakMap<WebContents, number>();

export async function withAgentInput<T>(guest: WebContents, work: () => Promise<T>): Promise<T> {
  inFlight.set(guest, (inFlight.get(guest) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const remaining = (inFlight.get(guest) ?? 1) - 1;
    if (remaining) inFlight.set(guest, remaining);
    else inFlight.delete(guest);
  }
}

export function agentInputInFlight(guest: WebContents): boolean {
  return inFlight.has(guest);
}
