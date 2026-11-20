import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store, writeJsonAtomic } from '../store.mjs';
import { TaskTable } from '../tasks.mjs';
import { Mdns } from '../mdns.mjs';
import * as clt01Module from '../clt01.mjs';
import { pidAlive, pidCwd } from '../ancestry.mjs';
import { codieHome } from './home.mjs';
import { AGENTD_VERSION } from './version.mjs';
import { Router } from './router.mjs';
import { AgentApp, HOSTS } from './agent-app.mjs';
import { createIpcServer, HttpError } from './ipc.mjs';
import { Dispatcher } from './dispatch.mjs';
import { createToolHosting, pinToolsDevice, toolsDeviceStatus } from './tool-hosting.mjs';
import { createHostRefresh } from './host-refresh.mjs';
import { DeviceClient, deviceHoldsCredential } from '../tools/device-client.mjs';
import { createClientDeviceRoutes } from './client-device-routes.mjs';
import { AgentsHost } from './agents-host.mjs';
import { toSpokenSummary } from '../summary.mjs';
import { CodexLifecycle } from './codex-lifecycle.mjs';
import { AGENTD_GONE } from '../texts.mjs';

export const MAX_EVENTS_WAIT_MS = 25_000;
const MDNS_CLOSE_CAP_MS = 300;

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// A positive integer from the environment, else the default.
const envInt = (v, dflt) => { const n = Number(v); return v && Number.isInteger(n) && n > 0 ? n : dflt; };

// Resolves within `ms` whether or not `p` settles (rejections are swallowed).
async function capped(p, ms) {
  let t;
  await Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => { t = setTimeout(r, ms); })]);
  clearTimeout(t);
}

// Assembles codie-agentd: tool hosting (the device link for voice tasks and
// tool clients), mDNS discovery, the session Router and AgentApp, and the
// loopback IPC sessions and tool clients talk to. Everything is injectable
// for tests; `exit` runs once at the end of shutdown().
export async function startAgentd({
  home = codieHome(), mdns: injectedMdns, clt01 = clt01Module,
  idleExitMs = envInt(process.env.CODIE_AGENTD_IDLE_MS, 600_000), version = AGENTD_VERSION,
  log = console.error, exit = () => process.exit(0),
  upkeepMs = envInt(process.env.CODIE_AGENTD_UPKEEP_MS, 30_000), // env: for process-level tests only
  livenessMs = 5_000, // how often sessions' processes are checked (router.reap)
  routerOptions = {}, // e.g. deliveryMs / pickupMs, for tests
  // Background dispatch backends. Off unless passed: only agentd.mjs (the real
  // daemon) wires the real ones, so a test can never drive the user's Codex or
  // spawn Claude.
  codexQueue = null, claudeBackground = null, dispatchOptions = {},
  toolHostingOptions = {}, // e.g. WebSocketImpl / fetchImpl, for tests
  hostRefreshOptions = {}, // e.g. now / gapMs, for tests
  clientSweepMs = 15_000, // how often tool clients that stopped polling are dropped
} = {}) {
  const store = new Store(home);
  pinToolsDevice(store);

  const tasks = new TaskTable({ onEnd: t => router.onTaskEnded(t) });
  let app = null;
  let router = null;
  let mdns = injectedMdns ?? null;
  let stopping = false;

  // ensure.mjs replaces an older agentd by asking it to shut down. When that
  // never reaches it, both serve the same device and keep kicking each other's
  // tool integration off. agentd.json names the agentd in charge: one it no
  // longer names, while that one lives, has been replaced and leaves.
  const agentdPath = path.join(home, 'agentd.json');
  const replacedBy = () => {
    const pid = readJson(agentdPath)?.pid;
    return Number.isInteger(pid) && pid !== process.pid && pidAlive(pid) ? pid : null;
  };

  // Once replaced, status.json belongs to the agentd that took over: the
  // kicked-off device link must not rewrite it before liveness notices.
  const writeStatus = () => {
    if (!app || stopping || replacedBy()) return;
    try {
      store.writeStatus({ ...app.statusSnapshot(), mode: 'active', sessionPid: process.pid, sessions: router.size, updatedAt: Date.now() });
    } catch (e) { log('status write failed', e); }
  };

  // A device link or call whose device's address failed marks the device
  // and asks for a host refresh (host-refresh.mjs): a device that moved gets
  // its new address in its pairing, and the links follow.
  const reach = { onUnreachable: (id, e) => hosts.unreachable(id, e), onReachable: id => hosts.reachable(id) };
  const hosting = createToolHosting({ store, log, ...reach, ...toolHostingOptions });

  // Idle = no sessions and no tool clients, continuously since `idleSince`
  // (startup counts).
  let idleSince = Date.now();
  const noteSessions = () => {
    if (router.size || hosting.registry.size) idleSince = null;
    else idleSince ??= Date.now();
  };

  // A device hands voice tasks over through ask_agent on tool hosting.
  const link = new AgentsHost({ store, tasks, ...reach, log, ...toolHostingOptions,
    onMessage: e => router.onDeviceMessage(e),
    onCancel: async e => {
      if (!e.threadId && router.get(tasks.get(e.taskId)?.holder?.sessionId)?.host === 'codex') {
        throw new Error('Cannot identify the Codex turn. Stop it on the computer and enable Codie hooks.');
      }
      await dispatcher.cancel(e);
      router.onDeviceCancel(e);
    },
    onChange: writeStatus,
    refuse: () => router.refuse(),
  });
  // Without channel or listening, an open Codex thread takes the task, else
  // a background Claude session (settings.json codexQueue / claudeBackground).
  const dispatcher = new Dispatcher({
    tasks, link, log,
    routingState: { get: id => store.lastCodexThread(id), set: (id, thread) => store.rememberCodexThread(id, thread) },
    codex: codexQueue,
    claude: claudeBackground,
    settings: () => store.readSettings(),
    hasCodexSession: () => router.hasHost('codex'),
    claudeCwd: () => router.latestCwd('claude'),
    spoken: t => toSpokenSummary(t),
    ...dispatchOptions,
  });
  router = new Router({ link, tasks, background: e => dispatcher.take(e), canBackground: () => dispatcher.available(),
    ...routerOptions, onChange: () => { noteSessions(); writeStatus(); } });

  const onPairingsChanged = () => { link.pruneUnpaired(); hosting.sync(); writeStatus(); };
  const hosts = createHostRefresh({
    store, discover: ms => mdns.discover(ms), onChanged: onPairingsChanged, log,
    verify: (record, d) => deviceHoldsCredential(d.host, d.port, DeviceClient.forPairing(record).credential),
    ...hostRefreshOptions,
  });

  app = new AgentApp({
    store, tasks, link, router, dispatcher, version,
    discover: ms => mdns.discover(ms), clt01, onPairingsChanged, forgetDevice: hosting.forget, repairRequired: id => hosts.refused(id),
  });
  const codexLifecycle = new CodexLifecycle({ tasks, link, app, store });
  if (codexQueue) codexQueue.knownThreads = () => codexLifecycle.openThreads();

  const sess = id => {
    const s = router.touch(id);
    if (!s) throw new HttpError(404, 'unknown session');
    return s;
  };

  const routes = {
    'GET /status': () => ({ version, pid: process.pid, sessions: router.size, ...app.statusSnapshot(),
      ...toolsDeviceStatus(store), clients: hosting.registry.list() }),
    'POST /sessions': async body => {
      if (stopping) throw new HttpError(503, 'agentd is shutting down');
      if (!Object.hasOwn(HOSTS, body?.host)) throw new HttpError(400, 'host must be claude or codex');
      // A pid that is already gone (or never was) is not stored: reap() would
      // drop the session at once.
      const pid = (v, what) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) return null;
        if (pidAlive(n)) return n;
        log(`session registered with a ${what} (${n}) that is not running; not tracking it`);
        return null;
      };
      const mcpPid = pid(body.mcpPid, 'mcpPid');
      // An older client sends no cwd: its MCP server runs in the project directory.
      const cwd = typeof body.cwd === 'string' && path.isAbsolute(body.cwd) ? body.cwd
        : body.cwd === undefined && body.host === 'claude' ? await pidCwd(mcpPid) : null;
      const s = router.register({ host: body.host, channel: body.channel === true, inbox: body.inbox === true,
        sessionPid: pid(body.sessionPid, 'sessionPid'), mcpPid, cwd });
      if (s.host === 'codex') dispatcher.refresh(); // its open thread can take tasks right away
      return { sessionId: s.id };
    },
    // Closing an unknown (expired) session is not an error: it is gone.
    'POST /sessions/:id/close': (body, { params }) => ({ ok: router.unregister(params.id) }),
    'POST /sessions/:id/events': async (body, { params, signal }) => {
      sess(params.id);
      const waitMs = Math.min(Math.max(Number(body?.waitMs) || 0, 0), MAX_EVENTS_WAIT_MS);
      return { events: await router.nextEvents(params.id, waitMs, signal) };
    },
    'POST /sessions/:id/delivered': (body, { params }) => {
      sess(params.id);
      return { claimed: router.confirmDelivery(params.id, body?.taskId, body?.ok !== false) };
    },
    // The session saw the user interrupt it: free the device(s) it holds.
    // An unknown (expired) session holds nothing.
    'POST /sessions/:id/interrupted': (body, { params }) => {
      const ids = Array.isArray(body?.taskIds) ? body.taskIds : [];
      const released = router.interrupt(params.id, ids);
      return released === null ? { ok: false } : { ok: true, released };
    },
    'POST /sessions/:id/tools/:name': (body, { params, signal }) =>
      app.callTool(params.name, body?.args ?? {}, { session: sess(params.id), signal }),
    'POST /hooks/:route': (body, { params }) => {
      if (body?.host === 'codex') {
        const result = codexLifecycle.handle(params.route, body);
        dispatcher.refresh();
        return result;
      }
      const handler = { stop: 'onStopHook', 'stop-failure': 'onStopFailureHook', notification: 'onNotificationHook', ask: 'onAskHook', permission: 'onPermissionHook' }[params.route];
      if (!handler) throw new HttpError(404, 'unknown hook');
      const s = router.sessionForPids(body?.pids, body?.host);
      if (!s) return {};
      router.active(s.id); // the session the user just used gets the next channel push
      app[handler](body, app.ctxFor(s));
      return {};
    },
    // The device tools without a session (the `codie` command line).
    'POST /tools/:name': (body, { params, signal }) => app.callTool(params.name, body?.args ?? {}, { signal }),
    ...hosting.routes,
    ...createClientDeviceRoutes({ store, app, registry: hosting.registry, log, fetchImpl: toolHostingOptions.fetchImpl, hosts }),
    'POST /shutdown': () => { setImmediate(() => shutdown().catch(e => log('shutdown failed', e))); return { ok: true }; },
  };

  const token = crypto.randomBytes(24).toString('hex');
  const ipc = createIpcServer({ token, routes, resolveClient: hosting.resolveClient });
  let ipcPort;
  try {
    mdns ??= new Mdns();
    await new Promise((resolve, reject) => {
      ipc.once('error', reject);
      ipc.listen(0, '127.0.0.1', () => { ipc.off('error', reject); resolve(); });
    });
    ipc.on('error', e => log('ipc', e?.message ?? e));
    ipcPort = ipc.address().port;
    writeJsonAtomic(agentdPath, { port: ipcPort, token, pid: process.pid, version });
  } catch (e) {
    // Free mDNS before failing.
    await capped(mdns?.close(), MDNS_CLOSE_CAP_MS);
    if (ipc.listening) ipc.close();
    throw e;
  }

  link.sync();
  fs.watchFile(store.pairingPath, { interval: 2000 }, onPairingsChanged);
  const upkeep = setInterval(() => {
    try {
      if (tasks.sweep().length) writeStatus();
      link.expireAccepted(); // announces ACCEPTED_TIMEOUT, ends them
      router.expire();
    } catch (e) {
      log('upkeep failed', e);
    } finally {
      noteSessions();
      if (!stopping && idleSince !== null && Date.now() - idleSince >= idleExitMs) {
        log(`no sessions for ${Math.round((Date.now() - idleSince) / 1000)}s; exiting`);
        shutdown().catch(e => log('shutdown failed', e));
      }
    }
  }, upkeepMs);
  upkeep.unref();
  // A session whose process died (killed terminal, crash) never says close:
  // free its tasks within seconds, not after SESSION_TTL_MS.
  const liveness = setInterval(() => {
    const other = stopping ? null : replacedBy();
    if (other) {
      log(`agentd.json names pid ${other}: another agentd took over; exiting`);
      shutdown({ replaced: true }).catch(e => log('shutdown failed', e));
      return;
    }
    try { router.reap(); } catch (e) { log('liveness check failed', e); }
    dispatcher.refresh().catch(e => log('dispatch refresh failed', e?.message ?? e));
  }, livenessMs);
  liveness.unref();
  const clientSweep = setInterval(() => {
    try { hosting.registry.sweep(); } catch (e) { log('client sweep failed', e); }
  }, clientSweepMs);
  clientSweep.unref();
  writeStatus();

  let stopped = null;
  // `replaced`: status.json belongs to the agentd that took over.
  function shutdown({ replaced = false } = {}) {
    // Every step is guarded on its own: whatever fails, exit() still runs.
    const step = (what, fn) => { try { return fn(); } catch (e) { log(`shutdown: ${what} failed`, e); } };
    stopped ??= (async () => {
      stopping = true; // refuses new sessions, mutes writeStatus
      try {
        clearInterval(upkeep);
        clearInterval(liveness);
        clearInterval(clientSweep);
        step('unwatch', () => fs.unwatchFile(store.pairingPath, onPairingsChanged));
        step('task errors', () => { for (const t of tasks.pending()) link.sendError(t.taskId, AGENTD_GONE); });
        step('sessions', () => { for (const id of [...router.sessions.keys()]) router.unregister(id); }); // wakes long polls
        step('clients', () => hosting.close());
        if (!replaced) step('status', () => store.writeStatus({ mode: 'stopped', online: 0, paired: store.listPairings().length, sessions: 0, updatedAt: Date.now() }));
        // Capped so it never blocks exit long.
        await capped(step('mdns', () => mdns.close()), MDNS_CLOSE_CAP_MS);
        step('link', () => link.close());
        await capped(new Promise(r => { ipc.close(() => r()); ipc.closeAllConnections(); }), 1000);
        step('agentd.json', () => {
          if (readJson(agentdPath)?.pid === process.pid) fs.unlinkSync(agentdPath);
        });
        log('agentd stopped');
      } catch (e) {
        log('shutdown failed', e);
      } finally {
        exit();
      }
    })();
    return stopped;
  }

  log(`agentd v${version} listening: ipc 127.0.0.1:${ipcPort}`);
  return { ipcPort, token, router, app, store, hosting, hosts, shutdown };
}
