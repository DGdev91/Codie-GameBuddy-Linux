// App updates: electron-updater checks the feed written into app-update.yml
// at build time (package.json build.publish), downloads a newer installer and
// installs it when the user asks. A feed that needs a sign-in (OneDev) gets
// one through `feed`; one that does not (GitHub releases) never shows it.
//
// view.status: idle | checking | latest | downloading | ready | login | error

const isAuthError = e => e?.statusCode === 401 || e?.statusCode === 403;

// The tray menu entry for `view`: its label, and 'check', 'install' or null
// (nothing to do while a check or download runs).
export function updateMenuItem(view, t, current) {
  switch (view.status) {
    case 'checking': return { label: t('tray.update.checking'), action: null };
    case 'downloading': return { label: t('tray.update.downloading', { version: view.version, percent: view.percent }), action: null };
    case 'ready': return { label: t('tray.update.ready', { version: view.version }), action: 'install' };
    case 'login': return { label: t('tray.update.login'), action: 'check' };
    default: return { label: t('tray.update.check', { current }), action: 'check' };
  }
}

export function createUpdater({ autoUpdater, feed, stopDaemon, log = () => {}, notify = () => {}, onChange = () => {} }) {
  let view = { status: 'idle' };
  let running = null;
  const set = next => {
    view = next;
    onChange(view);
    return view;
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // install only when the user picks it, after codie-agentd stopped
  // electron-updater emits 'error' before it rejects; an EventEmitter without
  // an 'error' listener would throw it again.
  autoUpdater.on('error', () => {});
  // OneDev answers 401 with a Basic-auth challenge. Unanswered, Electron
  // aborts the request (net::ERR_ABORTED); declined, the 401 comes through
  // and the check asks for a sign-in.
  autoUpdater.on('login', (authInfo, callback) => callback());
  autoUpdater.on('download-progress', p => {
    if (view.status === 'downloading') set({ ...view, percent: Math.floor(p.percent) });
  });

  async function attempt() {
    autoUpdater.requestHeaders = await feed.headers();
    const r = await autoUpdater.checkForUpdates();
    if (!r?.isUpdateAvailable) return { status: 'latest' };
    const { version } = r.updateInfo;
    set({ status: 'downloading', version, percent: 0 });
    await r.downloadPromise;
    return { status: 'ready', version };
  }

  async function run(interactive) {
    set({ status: 'checking' });
    try {
      return finish(await attempt(), interactive);
    } catch (e) {
      if (!isAuthError(e)) return failed(e, interactive);
      log(`update: the feed wants a sign-in (${e.statusCode})`);
      if (!interactive || !(await feed.login())) return set({ status: 'login' });
    }
    try {
      return finish(await attempt(), interactive);
    } catch (e) {
      return isAuthError(e) ? set({ status: 'login' }) : failed(e, interactive);
    }
  }

  function finish(next, interactive) {
    if (next.status === 'ready') {
      log(`update: ${next.version} downloaded`);
      notify('ready', next.version);
    } else if (interactive) {
      notify('latest');
    }
    return set(next);
  }

  function failed(e, interactive) {
    const error = e?.message?.split('\n')[0] ?? String(e);
    log(`update: ${error}`);
    if (interactive) notify('error', error);
    return set({ status: 'error', error });
  }

  return {
    get view() { return view; },

    // `interactive`: the user asked, so a sign-in window may open and the
    // outcome is notified even when there is nothing new.
    check({ interactive = false } = {}) {
      if (running) return running;
      if (view.status === 'ready') return Promise.resolve(view);
      running = run(interactive).finally(() => { running = null; });
      return running;
    },

    // The installer closes every process of this exe, codie-agentd included
    // (it runs on this app's Electron); stopping it first lets it say goodbye
    // to the device. Its sessions start a new one when they next need it.
    async install() {
      if (view.status !== 'ready') return;
      try {
        await stopDaemon();
      } catch (e) {
        log(`update: codie-agentd did not stop (${e?.message ?? e}); the installer closes it`);
      }
      autoUpdater.quitAndInstall(true, true);
    },
  };
}
