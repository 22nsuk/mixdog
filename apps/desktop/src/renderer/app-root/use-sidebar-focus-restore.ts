import { useEffect } from 'react';

/** When the sidebar closes around focused content, hand focus back to its rail button. */
export function useSidebarFocusRestore(sidebarOpen: boolean) {
  useEffect(() => {
    if (sidebarOpen) return;
    const sidebar = document.getElementById('session-sidebar');
    if (sidebar?.contains(document.activeElement)) {
      document.querySelector<HTMLButtonElement>('.activity-rail [data-side-view="sessions"]')?.focus();
    }
  }, [sidebarOpen]);
}
