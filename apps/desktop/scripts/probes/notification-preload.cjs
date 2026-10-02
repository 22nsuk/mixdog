const { ipcRenderer } = require('electron');

ipcRenderer.on('mixdog:notification-open-session', (_event, sessionId) => {
  document.body.textContent = `열린 세션: ${sessionId}`;
  ipcRenderer.send('notification-probe-opened', sessionId);
});
