// Asks the app shell to open the /doctor dialog. A separate module so the
// settings bundle can raise it without pulling in the lazy dialog chunk.
export const OPEN_DOCTOR_EVENT = 'mixdog:open-doctor';

export function requestOpenDoctor(): void {
  window.dispatchEvent(new CustomEvent(OPEN_DOCTOR_EVENT));
}
