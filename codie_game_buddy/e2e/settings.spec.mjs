import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

// The settings window against a fresh userData and a fresh codie-agentd.

let home;

test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'game-buddy-e2e-'));
});

async function stopDaemon() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'codie', 'agentd.json'), 'utf8'));
    await fetch(`http://127.0.0.1:${info.port}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } });
  } catch { /* the daemon never started */ }
}

// On Windows the detached daemon inherits Electron's stdio pipes, so
// app.close() only returns once the daemon is gone: stop it first.
async function closeApp(app) {
  // The daemon is spawned shortly after launch: wait for it, or it would outlive the stop.
  for (let i = 0; i < 100 && !fs.existsSync(path.join(home, 'codie', 'agentd.json')); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await stopDaemon();
  await app.close();
}

test.afterEach(async () => {
  await stopDaemon();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// `lang`: the app locale the "system" language follows (Electron's --lang).
const launch = (lang = 'en-US') => electron.launch({
  args: ['.', `--lang=${lang}`],
  env: { ...process.env, GAME_BUDDY_HOME: path.join(home, 'app'), CODIE_HOME: path.join(home, 'codie') },
});

test('first run opens settings; saved values persist', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#cooldown')).toHaveValue('60');
    await expect(page.locator('#status')).toContainText(/pair|codie-host/i);
    await expect(page.locator('#hotkey-hint')).toContainText('Ctrl+Alt+G');
    await expect(page.locator('#games-empty')).toBeVisible();
    await expect(page.locator('#avoid-interrupting')).toBeChecked();
    await expect(page.locator('#fast-mode')).toBeChecked();
    await page.locator('.switch', { has: page.locator('#fast-mode') }).click();
    await expect(page.locator('#fast-mode')).not.toBeChecked();
    await expect(page.locator('#chatty')).not.toBeChecked();
    await expect(page.locator('#chatty-hint')).toContainText('cloud');
    await page.locator('.switch', { has: page.locator('#chatty') }).click(); // the drawn switch, as a user clicks it

    await expect(page.locator('#cooldown')).toBeHidden(); // advanced options start folded
    await page.locator('#advanced summary').click();
    await page.locator('#cooldown').fill('90');
    await page.locator('#manual-process').fill('game.exe');
    await page.locator('#manual-name').fill('Test Game');
    await page.locator('#manual-add').click();
    await expect(page.locator('#games li')).toHaveCount(1);
    await page.locator('#manual-process').fill('game.exe');
    await page.locator('#manual-name').fill('Other Game');
    await page.locator('#manual-add').click();
    await expect(page.locator('#games li.game')).toHaveCount(2);
    await expect(page.locator('#games li.game.off')).toContainText('Test Game (game.exe)');
    await page.locator('#games li.game.off .game-on').click();
    await expect(page.locator('#games li.game.off')).toContainText('Other Game (game.exe)');
    await page.locator('#games li.game.off button').click();
    await expect(page.locator('#games li')).toHaveCount(1);
    await expect(page.locator('#games-empty')).toBeHidden();
    await expect(page.locator('#guide-tips')).toBeChecked();
    await expect(page.locator('#games li .guide-status')).toContainText(/guide wiki|Guide tips/);
    // Reading the numbers first follows the game's type until the user chooses.
    await expect(page.locator('#games li .read-counters input')).not.toBeChecked();
    await page.locator('#games li select.genre').selectOption('strategy');
    await expect(page.locator('#games li .read-counters input')).toBeChecked();
    await page.locator('#games li select.genre').selectOption('card');
    await expect(page.locator('#games li .read-counters input')).not.toBeChecked();
    await page.locator('#games li .read-counters').click();
    await expect(page.locator('#games li textarea.persona')).toBeHidden();
    await page.locator('#games li details.persona-box summary').click();
    await page.locator('#games li textarea.persona').fill('x'.repeat(601));
    await expect(page.locator('#games li .persona-count')).toHaveText('601 characters (suggested: 600 or fewer)');
    await expect(page.locator('#games li .persona-count')).toHaveClass(/over/);
    await page.locator('#games li textarea.persona').fill('Play Paimon.');
    await expect(page.locator('#games li .persona-count')).toHaveText('12 characters (suggested: 600 or fewer)');
    await expect(page.locator('#games li .persona-count')).not.toHaveClass(/over/);
    await page.locator('#save').click();
    await expect(page.locator('#save-status')).toHaveText('Saved.');

    await page.reload();
    await expect(page.locator('#fast-mode')).not.toBeChecked();
    await expect(page.locator('#cooldown')).toHaveValue('90');
    await expect(page.locator('#chatty')).toBeChecked();
    await expect(page.locator('#games li')).toContainText('Test Game (game.exe)');
    await expect(page.locator('#games li select.genre')).toHaveValue('card');
    await expect(page.locator('#games li textarea.persona')).toHaveValue('Play Paimon.');
    await expect(page.locator('#games li textarea.persona')).toBeHidden();
    await expect(page.locator('#games li .persona-state')).toHaveText('set');
    await expect(page.locator('#games li .read-counters input')).toBeChecked();
  } finally {
    await closeApp(app);
  }
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'app', 'settings.json'), 'utf8'));
  expect(saved.fastMode).toBe(false);
  expect(saved.cooldownMs).toBe(90000);
  expect(saved.allowList).toEqual([{ process: 'game.exe', name: 'Test Game', genre: 'card', persona: 'Play Paimon.', readCounters: true }]);
  expect(saved.guideTips).toBe(true);
  expect(saved.avoidInterrupting).toBe(true);
  expect(saved.chattyMode).toBe(true);
});

test('invalid values are refused, nothing is written, and the advanced options open', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator('#advanced summary').click();
    await page.locator('#cooldown').fill('5');
    await page.locator('#advanced summary').click(); // folded again before saving
    await page.locator('#save').click();
    await expect(page.locator('#save-status')).toContainText('cooldownMs');
    await expect(page.locator('#cooldown')).toBeVisible();
  } finally {
    await closeApp(app);
  }
  expect(fs.existsSync(path.join(home, 'app', 'settings.json'))).toBe(false);
});

test('a tray toggle reaches the open window, so Save cannot undo it', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#enabled')).toBeChecked();
    // The tray cannot be clicked; send what main sends after a successful toggle.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('settings', { commentaryEnabled: false, chattyMode: true });
    });
    await expect(page.locator('#enabled')).not.toBeChecked();
    await expect(page.locator('#chatty')).toBeChecked();
  } finally {
    await closeApp(app);
  }
});

test('a tray toggle sets only its own checkbox, so an unsaved edit of the other stays', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#chatty')).not.toBeChecked();
    await page.locator('.switch', { has: page.locator('#chatty') }).click(); // not saved
    // What main sends after the tray toggles Commentary off.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('settings', { commentaryEnabled: false });
    });
    await expect(page.locator('#enabled')).not.toBeChecked();
    await expect(page.locator('#chatty')).toBeChecked();
  } finally {
    await closeApp(app);
  }
});

test('a failed write is shown to the user', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#cooldown')).toHaveValue('60');
    // A directory where the file belongs makes the final rename fail.
    fs.mkdirSync(path.join(home, 'app', 'settings.json'), { recursive: true });
    await page.locator('#save').click();
    await expect(page.locator('#save-status')).toContainText('Not saved:');
  } finally {
    await closeApp(app);
  }
});

test('the page follows a Chinese locale and switches language on Save', async () => {
  const app = await launch('zh-CN');
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#save')).toHaveText('保存');
    await expect(page.locator('#status')).toContainText(/配对|codie-host/);

    await page.locator('#language').selectOption('en');
    await page.locator('#save').click();
    await expect(page.locator('#save-status')).toHaveText('Saved.');
    await expect(page.locator('#save')).toHaveText('Save');
    await expect(page.locator('#status')).toContainText(/pair|codie-host/i);
  } finally {
    await closeApp(app);
  }
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'app', 'settings.json'), 'utf8'));
  expect(saved.language).toBe('en');
});

test('a long window title does not push the game buttons out of the window', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => window.buddy.listGames()); // let the page's own list arrive first
    await page.locator('#running').evaluate(select => {
      const option = document.createElement('option');
      option.textContent = 'A very long window title '.repeat(20);
      select.prepend(option);
      select.selectedIndex = 0;
    });
    const box = await page.locator('#running-add').boundingBox();
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  } finally {
    await closeApp(app);
  }
});

test('pairing answers are worded from their codes in the UI language', async () => {
  const app = await launch('zh-CN');
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#cooldown')).toHaveValue('60');
    // No device on the test network: answer the settings IPC as codie-host would.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('devices:list');
      ipcMain.handle('devices:list', () => [
        { deviceId: 'D1', name: 'Desk', host: '10.0.0.2', paired: false, found: true, online: false },
        { deviceId: 'D2', name: 'Living room', host: '10.0.0.3', paired: true, found: true, online: true },
        { deviceId: 'D3', name: 'Offline device', host: '10.0.0.4', paired: true, found: false, online: false },
      ]);
      ipcMain.removeHandler('pair:begin');
      ipcMain.handle('pair:begin', () => ({ ok: false, code: 'DEVICE_UNREACHABLE', message: 'Failed: fetch failed' }));
    });
    await page.locator('#scan').click();
    await expect(page.locator('#devices li > span')).toHaveText(['10.0.0.2', '10.0.0.3', '10.0.0.4']);
    await expect(page.locator('#devices li button')).toHaveCount(2);
    await page.locator('#devices li button').first().click();
    await expect(page.locator('#pair-status')).toHaveText('Codie 没有响应。请确认它已开机，并和这台电脑连着同一个网络。');
  } finally {
    await closeApp(app);
  }
});


test('activity and the last failure update visibly without replacing settings', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#status')).toContainText('Pair your Codie');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('view', {
        state: 'ready', stateText: 'Test Game: generating or playing commentary',
        errorText: 'Last error: DEVICE_BUSY',
      });
    });
    await expect(page.locator('#status')).toHaveText('Test Game: generating or playing commentary');
    await expect(page.locator('#last-error')).toHaveText('Last error: DEVICE_BUSY');
    await expect(page.locator('#enabled')).toBeChecked();
    await page.screenshot({ path: 'dist/activity-status.png', fullPage: true });
  } finally {
    await closeApp(app);
  }
});
