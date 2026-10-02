const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('translator', {
  openChromeSettings: () => ipcRenderer.invoke('openChromeSettings'),
  settings: () => ipcRenderer.invoke('settings'),
  languages: server => ipcRenderer.invoke('languages', server),
  start: settings => ipcRenderer.invoke('start', settings),
  stop: () => ipcRenderer.invoke('stop'),
  onStatus: callback => ipcRenderer.on('status', (_event, data) => callback(data)),
});
