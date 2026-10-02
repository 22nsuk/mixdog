/** Windows resolves notification branding through the shortcut's AUMID.
 * Sharing the installed ID with electron.exe lets a probe replace Mixdog's
 * sender name/icon in the shell cache, even with an isolated userData path. */
const IDENTITIES = {
  installed: { appId: 'io.mixdog.desktop', name: 'Mixdog' },
  development: { appId: 'io.mixdog.desktop.dev', name: 'Mixdog Dev' },
  probe: { appId: 'io.mixdog.desktop.notification-probe', name: 'Mixdog Notification Test' },
} as const;

export function desktopIdentity(edition: keyof typeof IDENTITIES) {
  return IDENTITIES[edition];
}
