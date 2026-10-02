// One-time repair for an Electron probe that registered the installed AUMID.
// Run explicitly with Electron, not Node. No app restart or notification send.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { app, shell } from 'electron';

async function main() {
  assert.equal(process.platform, 'win32', 'This repair is Windows-only.');
  await app.whenReady();
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const electronLink = join(programs, 'Electron.lnk');
  const mixdogLink = join(programs, 'Mixdog.lnk');
  const installedExe = join(process.env.LOCALAPPDATA, 'Programs', 'mixdog-desktop', 'Mixdog.exe');
  const icon = join(process.env.LOCALAPPDATA, 'Programs', 'mixdog-desktop', 'resources', 'mixdog.ico');
  const electron = shell.readShortcutLink(electronLink);
  const mixdog = shell.readShortcutLink(mixdogLink);
  const canonical = (path) => normalize(path).toLowerCase();
  // Refuse to touch a different installation, a link already repaired, or a
  // user's unrelated shortcut. Only the observed collision is repairable here.
  assert.equal(canonical(electron.target), canonical(process.execPath));
  assert.equal(electron.appUserModelId, 'io.mixdog.desktop');
  assert.equal(canonical(mixdog.target), canonical(installedExe));
  assert.equal(mixdog.appUserModelId, 'io.mixdog.desktop');
  assert.equal((await stat(icon)).isFile(), true);
  const backup = await mkdtemp(join(app.getPath('temp'), 'mixdog-notification-identity-backup-'));
  await copyFile(electronLink, join(backup, 'Electron.lnk'));
  await copyFile(mixdogLink, join(backup, 'Mixdog.lnk'));
  console.log(JSON.stringify({ backup, electronLink, mixdogLink }));
  assert.equal(
    shell.writeShortcutLink(electronLink, 'update', {
      appUserModelId: 'electron.app.Electron',
    }),
    true
  );
  assert.equal(shell.writeShortcutLink(mixdogLink, 'update', { icon, iconIndex: 0 }), true);
  const repairedElectron = shell.readShortcutLink(electronLink);
  const repairedMixdog = shell.readShortcutLink(mixdogLink);
  assert.equal(repairedElectron.appUserModelId, 'electron.app.Electron');
  assert.equal(repairedMixdog.appUserModelId, 'io.mixdog.desktop');
  assert.equal(canonical(repairedMixdog.target), canonical(installedExe));
  assert.equal(canonical(repairedMixdog.icon), canonical(icon));
  console.log(JSON.stringify({ result: 'repaired', electron: repairedElectron, mixdog: repairedMixdog }));
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
