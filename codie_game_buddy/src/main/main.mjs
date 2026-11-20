import path from 'node:path';
import { app, globalShortcut, net } from 'electron';
import electronUpdater from 'electron-updater';
import * as capture from './capture.mjs';
import { createCommentary } from './commentary.mjs';
import { createContextFeed, PUSH_MS } from './context-feed.mjs';
import { stopDaemon } from './daemon-stop.mjs';
import { createFeedLogin } from './feed-login.mjs';
import { lookupGameInfo, lookupTerm } from './game-info.mjs';
import { lookupGuideNotes } from './guide-notes.mjs';
import { lookupGuideWiki } from './guide-wiki.mjs';
import { createGuides } from './guides.mjs';
import { createHost } from './host.mjs';
import { throttleByHost } from './host-throttle.mjs';
import { registerHotkey } from './hotkey.mjs';
import { createLookupCache } from './lookup-cache.mjs';
import { createOcr } from './ocr.mjs';
import { createScreenTerms } from './screen-terms.mjs';
import { openSettingsWindow, pushSettings, pushView, registerSettingsIpc } from './settings-window.mjs';
import { loadSettings, MAX_GAMES, saveSettings } from './settings.mjs';
import { MESSAGES, resolveLocale, translatorFor } from './i18n.mjs';
import { createTray } from './tray.mjs';
import { nextTickMs } from './trigger.mjs';
import { createTurnLock } from './turn-lock.mjs';
import { createUpdater, updateMenuItem } from './updater.mjs';

// Codie Game Buddy: a tray app that lets Codie comment on the game in front.

const UPDATE_FIRST_CHECK_MS = 15_000;
const UPDATE_EVERY_MS = 6 * 3600_000;

const log = line => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

if (process.env.GAME_BUDDY_HOME) app.setPath('userData', path.resolve(process.env.GAME_BUDDY_HOME));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const loaded = loadSettings(settingsFile);
  if (loaded.errors.length) log(`settings: invalid ${loaded.errors.join(', ')}; using the defaults for them`);
  let settings = loaded.settings;
  let tray = null;
  let timer = null;
  let contextTimer = null;
  let updateTimer = null;
  let activity = { phase: 'no-game', game: '' };
  let lastError = '';
  const report = next => {
    activity = next;
    if (next.error) lastError = next.error;
    tray?.render(view());
    pushView(stateView());
  };
  const ac = new AbortController();

  // The UI language is set by apply(); logs stay in English.
  let locale = 'en';
  let t = translatorFor(locale);
  const logText = translatorFor('en');

  const updater = createUpdater({
    autoUpdater: electronUpdater.autoUpdater,
    feed: createFeedLogin({ title: () => t('update.login-title'), log }),
    stopDaemon,
    log,
    notify: (kind, detail) => tray?.notify(t(`update.notify.${kind}`, { version: detail, error: detail, current: app.getVersion() })),
    onChange: () => tray?.render(view()),
  });
  const view = () => ({
    activityPhase: activity.phase,
    state: host.state, commentaryEnabled: settings.commentaryEnabled, chattyMode: settings.chattyMode,
    update: updateMenuItem(updater.view, t, app.getVersion()), t, ...stateView(),
  });
  const host = createHost({ log, onState: state => { log(`codie-host: ${state}`); tray?.render(view()); pushView(stateView()); } });
  const lock = createTurnLock();
  // net.fetch goes through Chromium, so it follows the system proxy.
  const wikiFetch = (url, init) => net.fetch(url, init);
  const gameInfo = createLookupCache({
    file: path.join(app.getPath('userData'), 'game-info.json'), label: 'game info', log,
    keyOf: ({ name, locale: lang }) => `${lang}:${name.toLowerCase()}`,
    lookup: ({ name, locale: lang }) => lookupGameInfo({ name, locale: lang, fetch: wikiFetch }),
  });
  const termInfo = createLookupCache({
    file: path.join(app.getPath('userData'), 'game-terms.json'), label: 'term', log,
    keyOf: ({ source, title }) => `${source}:${title}`,
    lookup: ({ source, title }) => lookupTerm({ source, title, fetch: wikiFetch }),
  });
  // Guide lookups of every game and page share one queue per wiki host.
  const guideFetch = throttleByHost(wikiFetch);
  const guideWikis = createLookupCache({
    file: path.join(app.getPath('userData'), 'guide-wikis.json'), label: 'guide wiki', log,
    keyOf: ({ name, locale: lang, url }) => `${lang}:${name.toLowerCase()}:${url}`,
    lookup: args => lookupGuideWiki({ ...args, fetch: guideFetch }),
  });
  const guideNotes = createLookupCache({
    file: path.join(app.getPath('userData'), 'guide-notes.json'), label: 'guide notes', log,
    keyOf: ({ api, title }) => `${api}:${title}`,
    lookup: ({ api, title }) => lookupGuideNotes({ api, title, fetch: guideFetch }),
  });
  const guides = createGuides({ gameInfo, guideWikis, guideNotes, log });
  const ocr = createOcr({ log });
  const screenTerms = createScreenTerms({ termInfo, log });
  const commentary = createCommentary({ capture, host, lock, settings: () => settings, locale: () => locale, gameInfo, ocr, screenTerms, guides, log, onStatus: report });

  const contextFeed = createContextFeed({ capture, host, settings: () => settings, locale: () => locale, gameInfo, log });

  // The settings window's games (saved or not), each with its guide wiki
  // state; asking starts the lookups.
  const gameGuides = list => (Array.isArray(list) ? list.slice(0, MAX_GAMES) : []).map(g => (
    typeof g?.name === 'string' && g.name.trim()
      ? guides.status({ name: g.name.trim(), guideWiki: typeof g.guideWiki === 'string' ? g.guideWiki.trim() : '' }, locale)
      : { source: null, looking: false, genre: null }));

  const OWN_EXE = path.win32.basename(process.execPath).toLowerCase();
  // Running windows as allow-list candidates: one per exe, not this app.
  const listGames = async () => {
    const seen = new Set([OWN_EXE]);
    const games = [];
    for (const w of await capture.listWindows()) {
      const exe = path.win32.basename(w.path);
      if (!exe || seen.has(exe.toLowerCase())) continue;
      seen.add(exe.toLowerCase());
      games.push({ process: exe, name: (w.title || w.owner || exe).slice(0, 80) });
    }
    return games;
  };
  // saveSettings writes the file; a filesystem failure is reported, not thrown.
  const trySave = raw => {
    try {
      return saveSettings(settingsFile, raw);
    } catch (e) {
      log(`settings: save failed: ${e?.message ?? e}`);
      return { saved: false, errors: [], saveError: e?.message ?? String(e) };
    }
  };
  const stateView = () => ({
    state: host.state,
    stateText: host.state !== 'ready' ? t(`state.${host.state}`)
      : t(`activity.${!settings.commentaryEnabled && !lock.busy ? 'off' : activity.phase}`, { game: activity.game }),
    errorText: lastError ? t('activity.last-error', { error: lastError }) : '',
  });

  let hotkeyNotified = false;
  const onHotkey = () => {
    if (hotkeyNotified) return;
    hotkeyNotified = true;
    const pending = commentary.hotkey();
    tray?.notify(t('activity.hotkey-received'));
    pending.then(r => log(`hotkey: ${r}`), e => {
      log(`hotkey: ${e?.message ?? e}`);
      report({ ...activity, phase: 'failed', error: e?.message ?? String(e) });
    }).finally(() => { hotkeyNotified = false; });
  };

  // Applies saved settings; returns the translated hotkey error, if any.
  const apply = next => {
    settings = next;
    contextFeed.refresh().catch(e => log(`context: ${e?.message ?? e}`));
    locale = resolveLocale(settings.language, app.getLocale());
    t = translatorFor(locale);
    tray?.render(view());
    pushView(stateView());
    const hotkeyError = registerHotkey(globalShortcut, settings.hotkey, onHotkey);
    if (!hotkeyError) return null;
    log(`hotkey: ${logText(hotkeyError, { accelerator: settings.hotkey })}`);
    return t(hotkeyError, { accelerator: settings.hotkey });
  };

  // A tray checkbox flips one boolean setting; the open settings window is
  // sent that setting only, so an unsaved edit of another stays.
  const toggle = key => () => {
    const r = trySave({ ...settings, [key]: !settings[key] });
    if (r.saved) {
      apply(r.settings);
      pushSettings({ [key]: r.settings[key] });
    } else {
      tray?.render(view()); // the checkbox flipped on click: show the real state
    }
  };

  const loop = async () => {
    let r;
    try {
      r = await commentary.tick();
      if (r === 'sent') log(`commentary: ${r}`); // commentary logs failed turns itself
    } catch (e) {
      log(`commentary: ${e?.message ?? e}`);
      report({ ...activity, phase: 'failed', error: e?.message ?? String(e) });
    } finally {
      if (!ac.signal.aborted) timer = setTimeout(loop, nextTickMs(r, settings));
    }
  };

  // Its own timer: a remark being spoken holds the commentary loop, and that
  // is when the user answers Codie.
  const feedContext = async () => {
    const startedAt = Date.now();
    try {
      await contextFeed.tick();
    } catch (e) {
      log(`context: ${e?.message ?? e}`);
    } finally {
      if (!ac.signal.aborted) contextTimer = setTimeout(feedContext, Math.max(0, PUSH_MS - (Date.now() - startedAt)));
    }
  };

  app.whenReady().then(() => {
    registerSettingsIpc({
      // `strings`: the message table of the UI language, for the page to show.
      getView: () => ({ settings, errors: loaded.errors, ...stateView(), strings: MESSAGES[locale] }),
      save: raw => {
        const r = trySave(raw);
        const hotkeyError = r.saved ? apply(r.settings) : null;
        return { ...r, hotkeyError, strings: MESSAGES[locale] };
      },
      listGames,
      gameGuides,
      host,
    });
    tray = createTray({
      onSettings: openSettingsWindow,
      onToggle: toggle('commentaryEnabled'),
      onChatty: toggle('chattyMode'),
      onUpdate: action => (action === 'install' ? updater.install() : updater.check({ interactive: true })),
      onQuit: () => app.quit(),
    });
    apply(settings);
    host.start(ac.signal);
    loop();
    feedContext();
    const checkUpdates = () => {
      updater.check();
      updateTimer = setTimeout(checkUpdates, UPDATE_EVERY_MS);
    };
    updateTimer = setTimeout(checkUpdates, UPDATE_FIRST_CHECK_MS);
    if (loaded.firstRun) openSettingsWindow();
  });

  app.on('second-instance', () => { if (app.isReady()) openSettingsWindow(); });

  app.on('window-all-closed', () => {}); // the tray keeps running
  let closing = false;
  app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    commentary.stop();
    ac.abort();
    // Give an in-flight push time to finish and delete its context before exit.
    const timeout = new Promise(resolve => setTimeout(resolve, 2000));
    Promise.race([contextFeed.stop().catch(() => {}), timeout]).finally(() => app.quit());
  });
  app.on('will-quit', () => {
    commentary.stop();
    ocr.stop();
    ac.abort();
    clearTimeout(timer);
    clearTimeout(contextTimer);
    clearTimeout(updateTimer);
    globalShortcut.unregisterAll();
    host.close().catch(() => {});
    tray?.destroy();
  });
}
