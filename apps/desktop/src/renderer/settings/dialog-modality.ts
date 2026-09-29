// Modal-dialog plumbing shared by the settings dialog and the onboarding wizard.

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** True while a portaled combobox menu inside `dialog` is open and owns Escape. */
export function portaledMenuOpen(dialog: HTMLElement | null): boolean {
  return Array.from(
    dialog?.querySelectorAll<HTMLElement>('[role="combobox"][aria-expanded="true"][aria-controls]') || []
  ).some((trigger) => {
    const menu = document.getElementById(trigger.getAttribute('aria-controls') || '');
    return menu?.matches('.mx-menu[role="listbox"]');
  });
}

/** Makes every body child that `isBackground` accepts inert (the toast region stays live); returns the restore. */
export function inertBackground(isBackground: (element: HTMLElement) => boolean): () => void {
  const background = Array.from(document.body.children)
    .filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && !element.matches('.mx-toast-region') && isBackground(element)
    )
    .map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
  for (const { element } of background) {
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  }
  return () => {
    for (const { element, inert, ariaHidden } of background) {
      element.inert = inert;
      if (ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
    }
  };
}

/** Wraps Tab / Shift+Tab inside `root`; `controls` is its tab order. */
export function trapTab(event: KeyboardEvent, root: HTMLElement, controls: HTMLElement[]): void {
  if (!controls.length) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}
