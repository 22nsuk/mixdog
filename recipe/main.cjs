const { app, BrowserWindow, session } = require('electron');
const { join } = require('node:path');
const { writeFileSync } = require('node:fs');
const directory = process.argv[2];
const output = process.argv[3];
const variant = process.argv[4];
app.setPath('userData', join(directory, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async () => {
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const forbidden = !details.url.startsWith('file:') && !details.url.startsWith('data:') && !details.url.startsWith('devtools:');
    if (forbidden) blocked.push(details.url);
    callback({ cancel: forbidden });
  });
  const win = new BrowserWindow({ width: 800, height: 860, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', (event) => { if (event.level >= 3) errors.push(event.message); });
  const timer = setTimeout(() => { console.error('Capture deadline exceeded'); app.exit(2); }, 30_000);
  try {
    for (const scenario of ['saved', 'edit']) {
      await win.loadFile(join(directory, 'index.html'), { query: { scenario } });
      const report = await win.webContents.executeJavaScript('window.runCapture()');
      const image = await win.webContents.capturePage();
      const expectedPercent = scenario === 'edit' ? 100 : variant === 'before' ? 30 : 75;
      const expectedApply = scenario === 'edit' && variant === 'after';
      if (report.sliderPercent !== expectedPercent || report.applyPresent !== expectedApply || (expectedApply && report.applyDisabled) || errors.length || blocked.length) {
        throw new Error(`Unexpected capture result: ${JSON.stringify({ variant, report, errors, blocked })}`);
      }
      writeFileSync(join(output, `${variant}-${scenario}.png`), image.toPNG());
      writeFileSync(join(output, `${variant}-${scenario}.json`), JSON.stringify({ variant, ...report, errors, blockedNetworkRequests: blocked }, null, 2));
      console.log(JSON.stringify({ variant, scenario, percent: report.sliderPercent, heading: report.contextHeading, apply: report.applyPresent, errors, blocked }));
    }
    clearTimeout(timer); app.exit(0);
  } catch(error) { clearTimeout(timer); console.error(error.stack); app.exit(1); }
});
