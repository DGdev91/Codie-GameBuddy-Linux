const { contextBridge, ipcRenderer } = require('electron');

// The only API the settings page gets.
contextBridge.exposeInMainWorld('buddy', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  listGames: () => ipcRenderer.invoke('games:list'),
  gameGuides: games => ipcRenderer.invoke('games:guides', games),
  listDevices: () => ipcRenderer.invoke('devices:list'),
  pairBegin: id => ipcRenderer.invoke('pair:begin', id),
  pairConfirm: (id, code) => ipcRenderer.invoke('pair:confirm', id, code),
  pairCancel: id => ipcRenderer.invoke('pair:cancel', id),
  onView: fn => ipcRenderer.on('view', (event, view) => fn(view)),
  onSettings: fn => ipcRenderer.on('settings', (event, settings) => fn(settings)),
});
