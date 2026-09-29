import { useEffect, useState } from 'react';

/** Wall-clock milliseconds that tick once a second only while `active`, so an
 *  idle surface costs no timers. */
export function useClock(active: boolean): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return clock;
}
