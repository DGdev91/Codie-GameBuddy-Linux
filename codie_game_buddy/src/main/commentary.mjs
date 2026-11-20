import { createRemarkMemory } from './remark-memory.mjs';
import { nextAngle } from './angles.mjs';
import { readsCounters } from '../shared/genres.mjs';
import { genreOf } from './genre.mjs';
import { commentaryPrompt, countersPrompt, parseCounters } from './prompt.mjs';
import { matchAllowList, shouldSend } from './trigger.mjs';

// Failures that mean the user is talking to Codie: the device refused the
// turn (DEVICE_BUSY) or the user cut it off (DEVICE_INTERRUPTED, clt01).
const CONVERSATION = new Set(['DEVICE_BUSY', 'DEVICE_INTERRUPTED']);
// How many of Codie's last remarks the prompt quotes so it says something new.
const RECENT_REMARKS = 5;

// The commentary loop (spec §4.1): which frame to send and when. Capture,
// the codie-host link and the clock are injected. `locale()` is game_buddy's
// resolved language, read per turn so a language change applies to the next
// comment. `gameInfo.get({ name, locale })` is the background of a game on
// the allow list (game-info.mjs, cached by lookup-cache.mjs), or null. A game
// whose background has a glossary, or that has a guide wiki (`guides`,
// guides.mjs; only with the guideTips setting), has its frame read once by
// `ocr` (ocr.mjs); the text names the glossary terms on screen
// (`screenTerms`, screen-terms.mjs) and picks a guide tip. A ticked remark
// without a tip takes an angle (angles.mjs) away from the last ones'; the
// hotkey asks for Codie's take on the moment instead.
const NO_GUIDES = { wikiFor: () => null, tipFor: () => null, used: () => {} };

export function createCommentary({ capture, host, lock, settings, locale = () => 'en', gameInfo = { get: () => null }, ocr = { read: async () => [] }, screenTerms = { describe: () => [] }, guides = NO_GUIDES, now = Date.now, random = Math.random, log = () => {}, onStatus = () => {} }) {
  let lastSentHash = null;
  let lastSentAt = -Infinity;
  let last = null; // how the last turn went, for shouldSend
  const memory = createRemarkMemory();
  let angles = []; // the angles of those remarks that took one, newest first
  let recentFor = null;
  let stopped = false;
  let hotkeyPending = false;
  let currentGame = '';
  const status = (phase, extra = {}) => onStatus({ phase, game: currentGame, ...extra });

  // Any failed turn, blocked included, waits one cooldown before the next
  // try, so a busy or offline device is not sent a frame on every tick
  // (chatty mode tries again on the next tick when the user is talking
  // to Codie); lastSentHash stays as it was.
  function failed(r) {
    lastSentAt = now();
    last = CONVERSATION.has(r.error?.code) ? 'busy' : 'failed';
    status('failed', { error: r.error?.code ?? r.kind });
    log(['commentary:', r.kind, r.error?.code, r.error?.message].filter(Boolean).join(' '));
    return r.kind;
  }

  // `fromTick`: the frame was picked while Commentary was on; the hotkey is
  // exempt from the toggle (spec G4).
  // `game` is the allow-list entry, or null for an unlisted window (hotkey).
  async function send(win, game, hash, fromTick) {
    currentGame = game?.name ?? (win.title || win.owner || '');
    status('capturing');
    const startedAt = now();
    const image = await capture.captureJpeg(win.id);
    const capturedAt = now();
    if (!image) { status('no-frame'); return 'no-frame'; }
    status('analyzing');
    const lang = locale();
    const info = game ? gameInfo.get({ name: game.name, locale: lang }) : null;
    const wiki = game && settings().guideTips ? guides.wikiFor(game, lang) : null;
    const lines = info?.terms?.length || wiki?.terms?.length ? await ocr.read(image, lang) : [];
    const onScreen = info?.terms?.length ? screenTerms.describe(lines, info) : [];
    const tip = wiki ? guides.tipFor(lines, wiki) : null;
    // The capture and OCR take a while: drop the frame if the user turned
    // Commentary off or quit meanwhile.
    if (stopped || (fromTick && !settings().commentaryEnabled)) return 'skip';
    // Commentary leaves a conversation alone unless the user allows it, and
    // chatty mode always does, or the user could not get a word in; the
    // hotkey is the user asking, so it always may interrupt.
    const s = settings();
    const chatty = fromTick && s.chattyMode;
    const interrupt = !fromTick || (!s.avoidInterrupting && !chatty);
    const name = game?.name ?? (win.title || win.owner || 'a game');
    // Remarks are quoted on the game they were made on; an unlisted window
    // (the hotkey) gets and adds none.
    const sameGame = game && game.name === recentFor;
    const remembered = memory.get(game);
    const prior = remembered.slice(0, RECENT_REMARKS);
    const earlier = remembered.slice(RECENT_REMARKS);
    const priorAngles = sameGame ? angles : [];
    const genre = genreOf(game, info);
    const angle = fromTick && !tip ? nextAngle(priorAngles, random, { world: Boolean(info), genre }) : null;
    // The model names an amount right only when it writes every counter out,
    // so the counters are read in a silent turn of their own and quoted in the
    // notes (spec §4.1.6), for a game that has them on screen. A read the
    // device refuses ends the remark the way a refused remark does.
    status('analyzing');
    let counters = [];
    if (!s.fastMode && game && readsCounters(game, genre)) {
      const read = await host.chatTurn({ image, text: countersPrompt(lang), speech: 'none', interrupt, retention: 'none', tools: 'none' });
      if (!read.ok) return failed(read);
      if (stopped || (fromTick && !settings().commentaryEnabled)) return 'skip';
      counters = parseCounters(read.turn?.assistant_text ?? '');
    }
    const text = commentaryPrompt(name, lang, info, onScreen, {
      fastMode: s.fastMode === true, followsOn: chatty && last === 'sent', recent: prior, earlier, tip, genre, asked: !fromTick, ...(angle && { angle }), ...(game?.persona && { persona: game.persona }), ...(counters.length && { counters }),
    });
    // A remark stays out of the device's chat history, memory and diary
    // (retention none): the remarks so far are quoted in the prompt instead.
    // It is one spoken line and nothing else: with tools on offer the model at
    // times handed the screenshot to the user's coding agent (tools none).
    status('responding');
    const sentAt = now();
    const r = await host.chatTurn({ image, text, speech: 'device', interrupt, retention: 'none', tools: 'none' });
    if (!r.ok) return failed(r);
    log(`latency: capture=${capturedAt - startedAt}ms preparation=${sentAt - capturedAt}ms turn=${now() - sentAt}ms total=${now() - startedAt}ms (turn includes generation and playback)`);
    lastSentHash = hash;
    lastSentAt = now();
    const said = (r.turn?.assistant_text ?? '').replace(/\s+/g, ' ').trim();
    // Chatty mode is paced by Codie speaking: a turn that said nothing (the
    // model only called a tool) is not followed at once.
    last = said ? 'sent' : 'silent';
    if (said && game) {
      memory.add(game, said);
      if (tip) guides.used(tip);
      angles = angle ? [angle, ...priorAngles].slice(0, RECENT_REMARKS) : priorAngles;
      recentFor = game.name;
    }
    status('cooldown');
    return 'sent';
  }

  return {
    async tick() {
      const s = settings();
      if (!s.commentaryEnabled) { if (!lock.busy) status('off'); return 'skip'; }
      if (lock.busy || hotkeyPending) return 'skip';
      const win = await capture.foreground();
      const game = win ? matchAllowList(win, s.allowList) : null;
      currentGame = game?.name ?? '';
      if (!game) { status('no-game'); return 'no-game'; }
      const hash = await capture.sampleHash(win.id);
      if (hash === null) { status('no-frame'); return 'no-frame'; }
      if (!shouldSend({ hash, lastSentHash, now: now(), lastSentAt, last, settings: s })) {
        status(now() - lastSentAt < s.cooldownMs ? 'cooldown' : 'unchanged');
        return 'unchanged';
      }
      if (lock.busy || hotkeyPending) return 'skip'; // the hotkey took the device meanwhile
      return lock.run(() => send(win, game, hash, true));
    },

    // The user asked: no allow-list, change or cooldown check.
    async hotkey() {
      if (stopped) return 'skip';
      if (hotkeyPending) return 'coalesced';
      hotkeyPending = true;
      status('queued');
      try {
        const win = await capture.foreground();
        if (!win) { status('no-game'); return 'no-window'; }
        // Capture only when the device is available, so queue time cannot age the frame.
        return await lock.run(async () => {
          if (stopped) return 'skip';
          const active = await capture.foreground();
          if (active?.id !== win.id || active?.path !== win.path) {
            status('window-changed');
            return 'window-changed';
          }
          const currentGame = matchAllowList(active, settings().allowList);
          return send(active, currentGame, null, false);
        });
      } finally {
        hotkeyPending = false;
      }
    },

    // The app is quitting: no new turn starts after this.
    stop() { stopped = true; },
  };
}
