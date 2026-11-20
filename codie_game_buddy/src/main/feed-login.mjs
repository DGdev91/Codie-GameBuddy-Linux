import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, session } from 'electron';
import { cookieHeaders, feedBaseUrl, onFeedSite } from './feed-config.mjs';

// Sign-in for an update feed behind a login (OneDev): the user signs in to
// the site in a window of its own session, whose cookies then go with the
// update requests. Kept across restarts ("remember me" on the sign-in page).

const PARTITION = 'persist:update-feed';

export function createFeedLogin({ title, log = () => {} }) {
  let base = null;
  try {
    base = feedBaseUrl(fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'));
  } catch (e) {
    log(`update: no app-update.yml (${e.code ?? e.message})`); // not a packaged build
  }
  const ses = () => session.fromPartition(PARTITION);
  const signedIn = async () => (await ses().fetch(`${base}/latest.yml`, { cache: 'no-store' })).ok;
  let open = null;

  return {
    headers: async () => (base ? cookieHeaders(await ses().cookies.get({ url: base })) : {}),

    // Resolves true once the feed answers, false when the user closes the window.
    login() {
      if (!base) return Promise.resolve(false);
      if (open) {
        open.win.focus();
        return open.done;
      }
      const win = new BrowserWindow({ width: 960, height: 760, title: title(), autoHideMenuBar: true, webPreferences: { partition: PARTITION } });
      const done = new Promise(resolve => {
        win.webContents.on('did-finish-load', async () => {
          try {
            if (!(await signedIn())) return;
          } catch {
            return;
          }
          resolve(true);
          if (!win.isDestroyed()) win.close();
        });
        win.on('closed', () => {
          open = null;
          resolve(false);
        });
      });
      win.on('page-title-updated', e => e.preventDefault());
      // Off the feed's site nothing loads here: not a link, a redirect or a popup.
      win.webContents.setWindowOpenHandler(({ url }) => {
        log(`update: sign-in window refused a popup to ${url.split(/[?#]/)[0]}`);
        return { action: 'deny' };
      });
      const stay = (e, url) => {
        if (onFeedSite(url, base)) return;
        e.preventDefault();
        log(`update: sign-in window refused to leave for ${url.split(/[?#]/)[0]}`);
      };
      win.webContents.on('will-navigate', stay);
      win.webContents.on('will-redirect', stay);
      win.loadURL(new URL(base).origin);
      open = { win, done };
      return done;
    },
  };
}
