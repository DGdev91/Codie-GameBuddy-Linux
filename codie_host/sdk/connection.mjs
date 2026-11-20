import { HostError, ToolClient } from './index.mjs';

// A local program's link to codie-agentd as one state (govee_buddy spec §4.2):
// the registration kept alive, approval followed, pairing, and its tools.
// Ported from codie_game_buddy's host.mjs.

const WATCH_MS = 2000; // approval shows in client.status, which serve() refreshes
const SERVE_RETRY_MS = 5000; // delay before serve() is started again after it fails

// The device would not take the request now (busy in a conversation, screen
// off, ambient mode).
const BLOCKED = new Set(['DEVICE_BUSY', 'DEVICE_BLOCKED', 'AMBIENT_MODE_BLOCKED']);

// What a failed call means for the program's state.
export function classify(error) {
  if (!(error instanceof HostError)) return 'offline'; // codie-agentd did not answer
  if (BLOCKED.has(error.code)) return 'blocked';
  switch (error.code) {
    case 'APPROVAL_PENDING': return 'pending';
    case 'NOT_PAIRED':
    case 'REPAIR_REQUIRED': return 'not-paired';
    case 'DEVICE_OFFLINE': return 'offline';
    default: return 'error';
  }
}

// The LAN scan and the pairings as one list: every device found, then the
// paired ones the scan missed.
export function mergeDevices({ found = [], paired = [] }) {
  const pairedIds = new Set(paired.map(d => d.deviceId));
  const foundIds = new Set(found.map(d => d.deviceId));
  return [
    ...found.map(d => ({
      deviceId: d.deviceId, name: d.name || d.deviceId, host: d.host, paired: pairedIds.has(d.deviceId), found: true, online: Boolean(d.online),
    })),
    ...paired.filter(d => !foundIds.has(d.deviceId)).map(d => ({
      deviceId: d.deviceId, name: d.name || d.deviceId, host: '', paired: true, found: false, online: Boolean(d.online),
    })),
  ];
}

export function createConnection({
  name, scope, tools = null, handlers = {}, log = () => {}, onState = () => {},
  client = new ToolClient({ name, scope, log }), watchMs = WATCH_MS, serveRetryMs = SERVE_RETRY_MS,
}) {
  if (tools) client.setTools(tools);
  let state = 'connecting';
  let checking = false;
  let seenStatus; // client.status as of the last refresh
  let watch = null;
  const stop = new AbortController();

  const set = next => {
    if (next === state) return;
    state = next;
    onState(next);
  };
  // Blocked requests and other one-off errors leave the state as it is.
  const noteError = e => {
    const kind = classify(e);
    if (kind !== 'blocked' && kind !== 'error') set(kind);
    return kind;
  };

  async function refresh() {
    if (checking) return;
    checking = true;
    seenStatus = client.status;
    try {
      if (client.status == null) { set('offline'); return; } // never registered
      if (client.status !== 'approved') { set('pending'); return; }
      // A pairing the device refused (repairRequired) has to be made again.
      const { paired } = await client.devices();
      set(paired.some(d => !d.repairRequired) ? 'ready' : 'not-paired');
    } catch (e) {
      noteError(e);
    } finally {
      checking = false;
    }
  }

  // serve() keeps the registration alive and answers tool calls; start it
  // again whenever it fails.
  async function keepServing() {
    while (!stop.signal.aborted) {
      try {
        await client.serve(handlers, { signal: stop.signal });
        return;
      } catch (e) {
        log(`codie-host: ${e?.message ?? e}`);
        await new Promise(resolve => {
          const timer = setTimeout(resolve, serveRetryMs);
          stop.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    }
  }

  const close = async () => {
    stop.abort();
    clearInterval(watch);
    await client.close();
  };

  return {
    get state() { return state; },
    client,

    // Never rejects: a daemon that is not there yet shows as offline.
    async start(signal) {
      try {
        await client.connect();
      } catch (e) {
        noteError(e);
      }
      keepServing();
      await refresh();
      // Call outcomes and pairConfirm decide the other state changes; the
      // watcher only follows registration and approval.
      watch = setInterval(() => {
        if (client.status !== seenStatus) refresh();
      }, watchMs);
      signal.addEventListener('abort', () => { stop.abort(); clearInterval(watch); }, { once: true });
    },

    // null once published or kept for serve(); the error when the publish
    // failed (serve() publishes the kept catalog after a reconnect).
    async setTools(next) {
      try {
        await client.publishTools(next);
        return null;
      } catch (e) {
        noteError(e);
        log(`codie-host: tools not published: ${e?.message ?? e}`);
        return e;
      }
    },

    devices: async () => mergeDevices(await client.devices()),
    pairBegin: id => client.pairBegin(id),
    async pairConfirm(id, code) {
      const r = await client.pairConfirm(id, code);
      if (r.toolsReady) set('ready');
      return r;
    },
    pairCancel: id => client.pairCancel(id),
    noteReady: () => set('ready'),
    noteError,
    close,
  };
}
