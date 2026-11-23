import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Notification, app, desktopCapturer, nativeImage, session } from 'electron';
import dbus from 'dbus-next';

// Linux (Wayland, or X11) stand-ins for what Windows gives game_buddy
// through get-windows, desktopCapturer window thumbnails, Windows.Media.Ocr
// and tray balloons. capture.mjs, main.mjs and tray.mjs call in here.

// The hotkey goes through the GlobalShortcuts portal (Wayland has no global grabs).
app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

export const notify = text => new Notification({ title: 'Codie Game Buddy', body: text }).show();

// ---- Windows ------------------------------------------------------------
// Wayland has no common way to ask which window is in front, so each
// compositor that has one is asked its own way (below). Elsewhere (GNOME,
// COSMIC, ...) X11 through XWayland sees the windows of Wine/Proton and most
// other games; a native Wayland window in front reads as no window, so
// commentary pauses. Every backend gives { active, windows } of
// { id, pid, title, cls }.

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 2000, maxBuffer: 16 << 20 }, (e, out) => (e ? reject(e) : resolve(out)));
});
const json = async (cmd, args) => JSON.parse(await run(cmd, args));

async function hyprland() {
  const [a, clients] = await Promise.all([json('hyprctl', ['-j', 'activewindow']), json('hyprctl', ['-j', 'clients'])]);
  const pick = c => ({ id: c.address, pid: c.pid, title: c.title, cls: c.class });
  return { active: a?.address ? pick(a) : null, windows: clients.map(pick) };
}

async function sway() {
  const all = [];
  const walk = n => {
    if (n.pid && (n.type === 'con' || n.type === 'floating_con')) all.push(n);
    for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) walk(c);
  };
  walk(await json('swaymsg', ['-t', 'get_tree']));
  const pick = n => ({ id: String(n.id), pid: n.pid, title: n.name ?? '', cls: n.app_id ?? n.window_properties?.class ?? '' });
  const focused = all.find(n => n.focused);
  return { active: focused ? pick(focused) : null, windows: all.map(pick) };
}

async function niri() {
  const [a, windows] = await Promise.all([json('niri', ['msg', '--json', 'focused-window']), json('niri', ['msg', '--json', 'windows'])]);
  const pick = w => ({ id: String(w.id), pid: w.pid, title: w.title ?? '', cls: w.app_id ?? '' });
  return { active: a ? pick(a) : null, windows: windows.map(pick) };
}

// X11 by xprop: the active X window, if it is a client (with a Wayland
// window in front it is XWayland's own, which has no pid).
const xprop = args => run('xprop', args).catch(() => '');
async function xwayland() {
  const root = await xprop(['-root', '_NET_ACTIVE_WINDOW', '_NET_CLIENT_LIST_STACKING']);
  const ids = line => (/^_NET_CLIENT_LIST_STACKING.*#(.*)$/m.exec(line)?.[1].match(/0x[0-9a-f]+/gi) ?? []);
  const activeId = /^_NET_ACTIVE_WINDOW.*#\s*(0x[0-9a-f]+)/mi.exec(root)?.[1];
  const windows = (await Promise.all(ids(root).map(async id => {
    const p = await xprop(['-id', id, '_NET_WM_PID', 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME']);
    const pid = Number(/_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(p)?.[1]);
    const title = /WM_NAME\([A-Z_]+\) = "(.*)"/.exec(p)?.[1] ?? '';
    const cls = /WM_CLASS\(STRING\) = .*"(.*)"/.exec(p)?.[1] ?? '';
    return cls ? { id, pid, title, cls } : null;
  }))).filter(Boolean);
  const active = windows.find(w => activeId && Number(w.id) === Number(activeId)) ?? null;
  return { active, windows };
}

// ---- KWin: KWin answers window questions only to its scripts, so each query loads a
// one-shot script that calls back over D-Bus with the windows as JSON.

const IFACE = 'org.codie.GameBuddy';
const QUERY_TIMEOUT_MS = 2000;
const SCRIPT = (service, n) => `
const pick = w => ({ id: String(w.internalId), pid: w.pid, title: w.caption, cls: String(w.resourceClass) });
const a = workspace.activeWindow;
callDBus(${JSON.stringify(service)}, '/', '${IFACE}', 'Report', JSON.stringify({ n: ${n},
  active: a ? pick(a) : null,
  windows: workspace.windowList().filter(w => w.normalWindow && !w.skipTaskbar).map(pick) }));
`;

let bus = null;
let nextQuery = 1;
const answers = new Map();

class Sink extends dbus.interface.Interface {
  Report(json) {
    try {
      const r = JSON.parse(json);
      answers.get(r.n)?.(r);
    } catch { /* not ours */ }
  }
}
Sink.configureMembers({ methods: { Report: { inSignature: 's', outSignature: '' } } });

// Explicit messages: KWin overloads loadScript, which dbus-next proxies cannot pick.
async function kwin(objectPath, iface, member, signature = '', body = []) {
  if (!bus) {
    // unix:socket= makes dbus-next use Node's own socket: its optional native
    // usocket (unix:path=) calls util.isError, gone from Electron's Node 24.
    const address = process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${process.getuid()}/bus`;
    bus = dbus.sessionBus({ busAddress: address.replace(/unix:path=/g, 'unix:socket=') });
    bus.export('/', new Sink(IFACE));
  }
  const reply = await bus.call(new dbus.Message({ destination: 'org.kde.KWin', path: objectPath, interface: iface, member, signature, body }));
  return reply.body[0];
}

// Wine and Proton games are matched by their Windows exe, as on Windows;
// native programs by their executable's file name.
function exePath(pid) {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const exe = args.find(a => /\.exe$/i.test(a));
    if (exe) return exe;
  } catch { /* gone */ }
  try { return fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); } catch { return ''; }
}

// Without a pid (some X programs), the class names the program (Wine's is the exe).
const toWindow = w => (w ? { id: w.id, path: (w.pid && exePath(w.pid)) || w.cls, owner: w.cls, title: w.title ?? '' } : null);

async function kwinQuery() {
  const n = nextQuery++;
  const plugin = `codie-game-buddy-${process.pid}-${n}`;
  const file = path.join(os.tmpdir(), `${plugin}.js`);
  await kwin('/Scripting', 'org.kde.kwin.Scripting', 'isScriptLoaded', 's', [plugin]); // connects the bus
  fs.writeFileSync(file, SCRIPT(bus.name, n));
  try {
    const answer = new Promise((resolve, reject) => {
      answers.set(n, resolve);
      setTimeout(() => reject(new Error('KWin did not answer')), QUERY_TIMEOUT_MS);
    });
    const id = await kwin('/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', [file, plugin]);
    await kwin(`/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run');
    return await answer;
  } finally {
    answers.delete(n);
    fs.rmSync(file, { force: true });
    await kwin('/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [plugin]).catch(() => {});
  }
}

const env = process.env;
export const windowBackend = env.CODIE_WINDOW_BACKEND || (/KDE/i.test(env.XDG_CURRENT_DESKTOP ?? '') ? 'kwin'
  : env.HYPRLAND_INSTANCE_SIGNATURE ? 'hyprland' : env.SWAYSOCK ? 'sway' : env.NIRI_SOCKET ? 'niri' : 'xwayland');
const BACKENDS = { kwin: kwinQuery, hyprland, sway, niri, xwayland };
// A compositor tool that is missing or fails falls back to XWayland.
const query = () => BACKENDS[windowBackend]().catch(() => xwayland());

export const activeWindow = async () => toWindow((await query()).active);
export const openWindows = async () => (await query()).windows.map(toWindow);

// ---- Frames, from the ScreenCast portal ---------------------------------
// The user picks a screen (or a window) in the portal once per run; a hidden
// page keeps that PipeWire stream open and hands out its latest frame.
// ponytail: the whole picked screen is sent, not cropped to the game window;
// fine for full-screen games. Crop by KWin's frameGeometry if windowed play matters.
// ponytail: the pick lasts one run. Electron's persistMode/restoreToken (newer
// than 44) would keep it across runs.

const PAGE = fileURLToPath(new URL('./linux-capture.html', import.meta.url));
const ASK_AGAIN_MS = 5 * 60_000; // after the picker is cancelled or sharing stopped
let page = null;
let starting = null;
let refusedAt = -Infinity;

function capturePage() {
  if (page && !page.isDestroyed()) return page;
  const ses = session.fromPartition('linux-capture');
  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then(([source]) => callback(source ? { video: source } : {}), () => callback({}));
  });
  page = new BrowserWindow({ show: false, webPreferences: { session: ses, backgroundThrottling: false, sandbox: true } });
  page.loadFile(PAGE);
  return page;
}

async function stream() {
  const p = capturePage();
  if (p.webContents.isLoading()) await new Promise(r => p.webContents.once('did-finish-load', r));
  if (await p.webContents.executeJavaScript('live')) return p;
  if (Date.now() - refusedAt < ASK_AGAIN_MS) return null;
  starting ??= p.webContents.executeJavaScript('start()', true)
    .then(() => p, () => { refusedAt = Date.now(); return null; })
    .finally(() => { starting = null; });
  return starting;
}

// The latest frame, fitted inside `size` (aspect kept), or null.
export async function thumbnail(size) {
  const p = await stream();
  const url = p && await p.webContents.executeJavaScript(`grab(${size.width}, ${size.height})`);
  return url ? nativeImage.createFromDataURL(url) : null;
}

// ---- OCR, by Tesseract --------------------------------------------------
// Same contract as ocr.mjs: read() never fails, [] on any trouble.

const TESSERACT_LANGUAGE = { 'zh-CN': 'chi_sim', en: 'eng' };

export function createOcr({ timeoutMs = 3000, log = () => {} } = {}) {
  const reported = new Set();
  const report = m => { if (!reported.has(m)) { reported.add(m); log(`ocr: ${m}`); } };
  return {
    read(image, locale) {
      return new Promise(resolve => {
        const lang = TESSERACT_LANGUAGE[locale] ?? TESSERACT_LANGUAGE.en;
        const child = spawn('tesseract', ['stdin', 'stdout', '-l', lang], { timeout: timeoutMs });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8').on('data', c => { out += c; });
        child.stderr.setEncoding('utf8').on('data', c => { err += c; });
        child.on('error', e => { report(e.message); resolve([]); });
        child.on('close', code => {
          if (code !== 0) report(err.trim().split('\n')[0] || `tesseract exited ${code}`);
          resolve(code === 0 ? out.split('\n').map(l => l.trim()).filter(Boolean) : []);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(image);
      });
    },
    stop() {},
  };
}
