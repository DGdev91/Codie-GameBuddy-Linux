import { conversationPrompt } from './prompt.mjs';
import { matchAllowList } from './trigger.mjs';

// What the user says to Codie while their game is in front is game talk
// (spec §4.3). A conversation the user starts on the device is the device's
// own turn, which game_buddy never sees; so while Commentary is on and a
// listed game is in front, the device is handed the game's screen and how to
// answer every PUSH_MS, and uses them for the voice conversations of the next
// TTL_MS. Away from the game the device is told to forget them.

export const PUSH_MS = 1000;
// Several pushes long, so one that fails or is slow leaves no gap.
export const TTL_MS = 20_000;
// codie-host passes on at most 1 MiB of JSON per device API call: the base64
// of this, with the text, fits.
const MAX_IMAGE_BYTES = 700 * 1024;

export function createContextFeed({ capture, host, settings, locale = () => 'en', gameInfo = { get: () => null }, log = () => {} }) {
  let given = false; // the device may still hold a context
  let failure = null; // the last push's error code, logged when it changes

  let stopped = false;
  let running = Promise.resolve();

  async function clear() {
    if (!given) return 'none';
    const r = await host.clearContext();
    if (r.ok) given = false;
    return r.ok ? 'cleared' : r.kind;
  }

  async function tick() {
    const s = settings();
    const win = s.commentaryEnabled ? await capture.foreground() : null;
    const game = win ? matchAllowList(win, s.allowList) : null;
    if (stopped || !game) return clear();
    const image = await capture.captureJpeg(win.id, MAX_IMAGE_BYTES);
    if (!image) return clear();
    const current = settings();
    const foreground = await capture.foreground();
    const active = foreground && matchAllowList(foreground, current.allowList);
    if (stopped || !current.commentaryEnabled || foreground?.id !== win.id || active?.name !== game.name) return clear();
    const lang = locale();
    const text = conversationPrompt(game.name, lang, gameInfo.get({ name: game.name, locale: lang }), { ...(game.persona && { persona: game.persona }) });
    given = true; // A timed-out request may still have reached the device.
    const r = await host.setContext({ image, text, ttlMs: TTL_MS });
    const code = r.ok ? null : r.error?.code ?? r.kind;
    if (code !== failure) log(r.ok ? 'context: given' : ['context:', r.kind, r.error?.code, r.error?.message].filter(Boolean).join(' '));
    failure = code;
    if (r.ok) given = true;
    if (stopped || !settings().commentaryEnabled) return clear();
    return r.ok ? 'given' : r.kind;
  }

  function enqueue(fn) {
    const result = running.then(fn);
    running = result.catch(() => {});
    return result;
  }
  return {
    tick: () => enqueue(tick),
    refresh: () => enqueue(tick),
    stop() { stopped = true; return enqueue(clear); },
  };
}
