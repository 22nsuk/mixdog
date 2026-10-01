/** Only the trusted desktop renderer may use media or write text to the clipboard. */
export function desktopPermissionAllowed(permission: string, sender: unknown, trustedSender: unknown): boolean {
  return (
    (permission === 'media' || permission === 'clipboard-sanitized-write') &&
    trustedSender != null &&
    sender === trustedSender
  );
}
