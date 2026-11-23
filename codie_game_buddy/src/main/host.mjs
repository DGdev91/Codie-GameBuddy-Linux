import { TURN_WAIT_MAX_MS, createConnection } from 'codie-host';

// game_buddy's link to codie-host (spec §6): codie-host's connection
// (registration, approval, state, pairing) plus the chat turns of commentary.

export { classify } from 'codie-host';

export const CLIENT_NAME = 'game-buddy';
const CONTEXT_PATH = '/v1/api/data/user/conversation/context';
// GET system: the device's settings, ai_language among them (the language Codie talks in).
const SYSTEM_PATH = '/v1/api/data/user/system';
const LANGUAGE_RETRY_MS = 60_000;
export const SCOPE = Object.freeze({ tools: true, pair: true, api: Object.freeze(['/v1/api/data/user/chat/turns', CONTEXT_PATH, SYSTEM_PATH]) });

// A turn the device would not take now (busy in a conversation, screen off,
// ambient mode) that failed when it was to start.
const BLOCKED = new Set(['DEVICE_BUSY', 'DEVICE_BLOCKED', 'AMBIENT_MODE_BLOCKED']);

export function createHost({ log = () => {}, onState = () => {}, client, watchMs, serveRetryMs } = {}) {
  // No tools until phase 3: serve() only keeps the registration alive.
  const conn = createConnection({ name: CLIENT_NAME, scope: SCOPE, log, onState, client, watchMs, serveRetryMs });
  let language = null;
  let languageAt = -Infinity;

  return {
    get state() { return conn.state; },
    start: signal => conn.start(signal),

    // `interrupt: false`: a device busy in a conversation fails the turn (DEVICE_BUSY).
    // `retention`: how much of the turn the device keeps (full, chat or none).
    // `tools`: whether the device's model may call its tools in the turn (all or none).
    // Waits as long as codie-host allows, so a spoken turn has been heard; one
    // still going after that (the device never ended it) is taken as heard.
    async chatTurn({ image, text, speech = 'device', interrupt = true, retention = 'full', tools = 'all' } = {}) {
      try {
        const turn = await conn.client.chatTurn({ image, text, speech, interrupt, retention, tools, waitMs: TURN_WAIT_MAX_MS });
        if (turn.state === 'failed' || turn.state === 'cancelled') {
          return { ok: false, kind: BLOCKED.has(turn.error?.code) ? 'blocked' : 'error', turn, error: turn.error };
        }
        conn.noteReady();
        return { ok: true, turn };
      } catch (error) {
        return { ok: false, kind: conn.noteError(error), error };
      }
    },

    // What the user is looking at and how to answer them, for the voice
    // conversations the device starts within `ttlMs` (context-feed.mjs).
    async setContext({ image, text, ttlMs }) {
      try {
        await conn.client.api('PUT', CONTEXT_PATH, { image_base64: Buffer.from(image).toString('base64'), text, ttl_ms: ttlMs });
        return { ok: true };
      } catch (error) {
        return { ok: false, kind: conn.noteError(error), error };
      }
    },
    async clearContext() {
      try {
        await conn.client.api('DELETE', CONTEXT_PATH);
        return { ok: true };
      } catch (error) {
        return { ok: false, kind: conn.noteError(error), error };
      }
    },

    // The language set on the device for Codie (a tag such as 'it' or
    // 'zh-TW'), read once; a failed read is tried again at most once a
    // minute. null until the device says.
    async language() {
      if (language === null && Date.now() - languageAt > LANGUAGE_RETRY_MS) {
        languageAt = Date.now();
        try {
          language = (await conn.client.api('GET', SYSTEM_PATH))?.ai_language || null;
        } catch { /* tried again later */ }
      }
      return language;
    },

    devices: () => conn.devices(),
    pairBegin: id => conn.pairBegin(id),
    pairConfirm: (id, code) => conn.pairConfirm(id, code),
    pairCancel: id => conn.pairCancel(id),
    close: () => conn.close(),
  };
}
