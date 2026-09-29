/** The visible slot a persistent surface (terminal, browser) should follow: the
 *  foreground active slot, else the first active one. */
export function preferredSurfaceSlot<Slot extends { active: boolean; foreground: boolean }>(
  slots: ReadonlyMap<HTMLDivElement, Slot>
): [HTMLDivElement, Slot] | null {
  const active = [...slots].filter(([, slot]) => slot.active);
  return active.find(([, slot]) => slot.foreground) ?? active[0] ?? null;
}
