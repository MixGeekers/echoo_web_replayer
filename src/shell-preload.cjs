const { contextBridge, ipcRenderer } = require('electron');
const methods = ['getState', 'getTimeline', 'getEvent', 'navigate', 'back', 'forward', 'reload', 'home', 'startSession', 'pauseSession', 'resumeSession', 'stopSession', 'snapshot', 'exportSession', 'cancelExport', 'revealExport'];
const api = Object.fromEntries(methods.map(name => [name, input => ipcRenderer.invoke(`collector:${name}`, input)]));
api.setBrowserBounds = bounds => ipcRenderer.send('collector:setBrowserBounds', bounds);
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
api.onState = callback => subscribe('collector:state', callback);
api.onEvent = callback => subscribe('collector:event', callback);
api.onError = callback => subscribe('collector:error', callback);
api.onExportProgress = callback => subscribe('collector:exportProgress', callback);
contextBridge.exposeInMainWorld('collector', api);
