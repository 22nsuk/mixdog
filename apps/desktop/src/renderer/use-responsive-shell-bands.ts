import { useEffect, useState } from 'react';

/** The two shell bands, named once for script. The stylesheets repeat the same
 *  widths as literals (760/761px and 940px) because a media query cannot read
 *  a custom property; keep both sides in step. */
export const NARROW_SHELL_QUERY = '(max-width: 760px)';
export const BOTTOM_SHEET_QUERY = '(max-width: 940px)';

export function useMediaBand(queryText: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(queryText).matches === true);
  useEffect(() => {
    const query = window.matchMedia?.(queryText);
    if (!query) return undefined;
    const onChange = (): void => setMatches(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [queryText]);
  return matches;
}

export function useResponsiveShellBands() {
  const narrowShell = useMediaBand(NARROW_SHELL_QUERY);
  const bottomSheetBand = useMediaBand(BOTTOM_SHEET_QUERY);

  useEffect(() => {
    const root = document.documentElement;
    let settleTimer = 0;
    const onResize = (): void => {
      root.classList.add('mx-window-resizing');
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        root.classList.remove('mx-window-resizing');
        settleTimer = 0;
      }, 180);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(settleTimer);
      root.classList.remove('mx-window-resizing');
    };
  }, []);

  return { narrowShell, bottomSheetBand };
}
