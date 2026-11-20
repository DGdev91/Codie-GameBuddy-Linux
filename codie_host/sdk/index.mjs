import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codieHome } from '../src/agentd/daemon/home.mjs';
import { ensureAgentd } from '../src/agentd/daemon/ensure.mjs';

export { codieHome };
// The outcome codes of pairBegin / pairConfirm / pairCancel.
export { PAIR } from '../src/agentd/pairing.mjs';
export { validateTools } from '../src/agentd/tools/catalog.mjs';
// The longest chatTurn `waitMs` codie-agentd honours.
export { MAX_WAIT_MS as TURN_WAIT_MAX_MS } from '../src/agentd/tools/chat-turns.mjs';

// Client SDK for local programs (spec §6): starts codie-agentd when it is not
// running, registers this program, publishes its tools, answers calls from
// Codie's model, and reaches the device (API calls, image chat turns,
// pairing) within its scope.

const AGENTD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'codie-agentd.mjs');
const POLL_WAIT_MS = 25_000;
const PAIR_CONFIRM_MS = 60_000; // confirm, bootstrap and credential issue, up to 10s each
const SCAN_TIMEOUT_MS = 15_000;
const API_TIMEOUT_MS = 15_000; // beyond the device's own 10 s call deadline
const TURN_SLACK_MS = 15_000; // upload and polling beyond the turn's own wait
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class HostError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// A tool handler throws this to report a failure with a stable code.
export class ToolFailure extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// A tool handler returns clarify(data) when it needs the user to choose.
export const clarify = data => ({ __clarify: true, data });

async function ipc(daemon, method, route, body, token, signal) {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new HostError(res.status, parsed?.code ?? 'ERROR', parsed?.error);
  return parsed;
}

// Returns { port, token } of the running codie-agentd, starting one if needed.
export function ensureDaemon(home = codieHome()) {
  return ensureAgentd({ home, agentdPath: AGENTD });
}

export class ToolClient {
  #registering = null;

  constructor({ name, scope, home = codieHome(), log = () => {} }) {
    this.name = name;
    this.scope = scope;
    this.home = home;
    this.log = log;
    this.tools = null;
    this.daemon = null;
    this.id = null;
    this.token = null;
    this.status = null;
  }

  // Concurrent callers share one registration: two racing ones could leave
  // this client holding the token the daemon closed when the second arrived.
  #register() {
    this.#registering ??= this.#registerOnce().finally(() => { this.#registering = null; });
    return this.#registering;
  }

  async #registerOnce() {
    this.daemon = await ensureDaemon(this.home);
    const r = await ipc(this.daemon, 'POST', '/clients', { name: this.name, scope: this.scope }, this.daemon.token);
    Object.assign(this, { id: r.id, token: r.token, status: r.status });
    if (r.status === 'pending') {
      this.log(this.scope?.pair
        ? `Waiting for approval: pair a Codie from this app, or run: codie clients approve ${this.name}`
        : `Waiting for approval. Run: codie clients approve ${this.name}`);
    }
  }

  #call(method, sub, body, signal) {
    return ipc(this.daemon, method, `/clients/${this.id}${sub}`, body, this.token, signal);
  }

  async #waitApproved(signal) {
    while (!signal?.aborted) {
      const s = await this.#call('GET', '');
      if (s.status === 'approved') { this.status = 'approved'; return; }
      await sleep(2000);
    }
  }

  async #publish(signal) {
    await this.#waitApproved(signal);
    if (this.tools && !signal?.aborted) await this.#call('PUT', '/tools', { tools: this.tools });
  }

  async connect() { await this.#register(); }

  setTools(tools) { this.tools = tools; }

  // Replaces the catalog and publishes it now when registered and approved;
  // otherwise serve() publishes it once approved. An empty list withdraws the
  // tools. The caller versions its tools: the device refuses changed content
  // under a version it already has.
  async publishTools(tools) {
    this.tools = tools;
    if (this.id && this.status === 'approved') await this.#call('PUT', '/tools', { tools });
  }

  async #ready() { if (!this.id) await this.#register(); }

  // Device API call within this client's scope: the device's `data`.
  async api(method, path, body) {
    await this.#ready();
    return (await this.#call('POST', '/api', { method, path, body }, AbortSignal.timeout(API_TIMEOUT_MS))).data;
  }

  // One image + text turn on the device. `image` is JPEG or PNG ≤ 1 MiB.
  // Resolves when the turn ends or after `waitMs` (then `state` is not final);
  // `waitMs: TURN_WAIT_MAX_MS` waits for a spoken turn to be heard.
  // `interrupt: false`: a device busy in a conversation fails the turn with
  // DEVICE_BUSY instead of ending that conversation.
  // `retention`: 'full' (default) keeps the turn in chat history and memory,
  // 'chat' in chat history only, 'none' nowhere on the device.
  // `tools`: 'all' (default) lets the device's model call its tools in the
  // turn, 'none' offers it no tool.
  async chatTurn({ image, text = '', speech = 'device', interrupt = true, retention = 'full', tools = 'all', waitMs = 30_000, signal } = {}) {
    await this.#ready();
    const timeout = AbortSignal.timeout(waitMs + TURN_SLACK_MS);
    return this.#call('POST', '/chat-turns', { image: Buffer.from(image).toString('base64'), text, speech, interrupt, retention, tools, wait_ms: waitMs },
      signal ? AbortSignal.any([signal, timeout]) : timeout);
  }

  // Needs scope.pair. `found`: the LAN scan; `paired`: devices paired already.
  async devices() {
    await this.#ready();
    return this.#call('GET', '/devices', undefined, AbortSignal.timeout(SCAN_TIMEOUT_MS));
  }

  async pairBegin(deviceId) {
    await this.#ready();
    return this.#call('POST', '/pair/begin', { device_id: deviceId });
  }

  async pairConfirm(deviceId, code) {
    await this.#ready();
    return this.#call('POST', '/pair/confirm', { device_id: deviceId, code }, AbortSignal.timeout(PAIR_CONFIRM_MS));
  }

  async pairCancel(deviceId) {
    await this.#ready();
    return this.#call('POST', '/pair/cancel', { device_id: deviceId });
  }

  // Answers calls until `signal` aborts. Any IPC failure, also while waiting
  // for approval (a daemon restart or reap loses the record), backs off and
  // registers again: serve() does not reject for it.
  async serve(handlers, { signal } = {}) {
    let failures = 0;
    let joined = false; // registered and published since the last failure
    while (!signal?.aborted) {
      let calls;
      try {
        if (!joined) {
          if (!this.id || failures) await this.#register();
          await this.#publish(signal);
          joined = true;
          continue;
        }
        calls =(await this.#call('POST', '/calls', { wait_ms: POLL_WAIT_MS }, AbortSignal.any([
          ...(signal ? [signal] : []), AbortSignal.timeout(POLL_WAIT_MS + 10_000),
        ]))).calls;
        failures = 0;
      } catch (e) {
        if (signal?.aborted) break;
        failures++;
        joined = false;
        this.log(`codie-host: ${e.code ?? ''} ${e.message}; reconnecting`);
        await sleep(Math.min(1000 * failures, 10_000));
        continue;
      }
      for (const call of calls) this.#answer(handlers, call);
    }
  }

  async #answer(handlers, call) {
    let result;
    try {
      const handler = handlers[call.name];
      if (!handler) throw new ToolFailure('UNKNOWN_TOOL', `no handler for ${call.name}`);
      const out = await handler(call.arguments, call);
      result = out?.__clarify ? { status: 'needs_clarification', data: out.data } : { status: 'succeeded', data: out ?? {} };
    } catch (e) {
      result = { status: 'failed', code: e instanceof ToolFailure ? e.code : 'TOOL_ERROR', message: String(e?.message ?? e).slice(0, 200), data: {} };
    }
    try {
      await this.#call('POST', `/calls/${encodeURIComponent(call.invocation_id)}/result`, result);
    } catch (e) {
      this.log(`codie-host: result for ${call.name} not delivered: ${e.code ?? ''} ${e.message}`);
    }
  }

  async close() {
    if (!this.id) return;
    try { await this.#call('POST', '/close', {}); } catch { /* daemon gone */ }
    this.id = null;
  }
}

export { classify, createConnection, mergeDevices } from './connection.mjs';
