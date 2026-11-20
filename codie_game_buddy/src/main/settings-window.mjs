import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ipcMain } from 'electron';

// The settings window (spec §4.3) and the IPC it uses.

const HERE = path.dirname(fileURLToPath(import.meta.url));
let win = null;

// Host calls answer { error, code } instead of rejecting into the renderer.
const hostCall = fn => async (event, ...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    return { error: e?.message ?? String(e), code: e?.code ?? '' };
  }
};

export function registerSettingsIpc({ getView, save, listGames, gameGuides, host }) {
  ipcMain.handle('settings:get', () => getView());
  ipcMain.handle('settings:save', (event, raw) => save(raw));
  ipcMain.handle('games:list', () => listGames());
  ipcMain.handle('games:guides', (event, games) => gameGuides(games));
  ipcMain.handle('devices:list', hostCall(() => host.devices()));
  ipcMain.handle('pair:begin', hostCall(id => host.pairBegin(id)));
  ipcMain.handle('pair:confirm', hostCall((id, code) => host.pairConfirm(id, code)));
  ipcMain.handle('pair:cancel', hostCall(id => host.pairCancel(id)));
}

export function openSettingsWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }
  win = new BrowserWindow({
    width: 560,
    height: 760,
    title: 'Codie Game Buddy',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(HERE, '..', 'renderer', 'settings.html'));
  return win;
}

export function pushView(view) {
  win?.webContents.send('view', view);
}

// Settings changed outside the window (a tray toggle): only those keys.
export function pushSettings(settings) {
  win?.webContents.send('settings', settings);
}
