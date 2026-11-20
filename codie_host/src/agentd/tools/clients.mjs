import crypto from 'node:crypto';
import { validateTools } from './catalog.mjs';
import { AGENTS_CLIENT } from './integration-id.mjs';
import { normalizeScope, scopeCovers } from './scope.mjs';

export const CLIENT_TIMEOUT_MS = 90_000;
export const MAX_WAIT_MS = 30_000;
const RESULT_STATUSES = new Set(['succeeded', 'failed', 'needs_clarification']);
const CLIENT_NAME = /^[a-z][a-z0-9-]{1,39}$/;

// Error with an IPC status and a stable code (spec §7).
export class ClientError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const token = () => crypto.randomBytes(24).toString('base64url');

// Local programs registered with the daemon (spec §6.1, §6.2). Each gets its
// own token; a scope beyond what the user approved stays pending until
// `codie clients approve <name>`. Approved scopes persist in clients.json.
export class ClientRegistry {
  constructor({ store, makeLink, log = () => {}, now = Date.now }) {
    this.store = store;
    this.makeLink = makeLink;
    this.log = log;
    this.now = now;
    this.clients = new Map();
  }

  register(name, rawScope) {
    if (typeof name !== 'string' || !CLIENT_NAME.test(name)) {
      throw new ClientError(400, 'INVALID_ARGUMENT', 'name must be 2-40 lowercase letters, digits or dashes, starting with a letter');
    }
    if (name === AGENTS_CLIENT) throw new ClientError(400, 'INVALID_ARGUMENT', `name "${AGENTS_CLIENT}" is reserved for agentd's own integration`);
    let scope;
    try { scope = normalizeScope(rawScope); } catch (e) { throw new ClientError(400, 'INVALID_ARGUMENT', e.message); }
    for (const old of this.clients.values()) if (old.name === name) this.close(old);
    const granted = this.store.approvedClients()[name]?.scope;
    const client = {
      id: crypto.randomUUID(),
      token: token(),
      name,
      scope,
      status: granted && scopeCovers(granted, scope) ? 'approved' : 'pending',
      tools: null,
      link: null,
      queue: [],
      waiters: new Set(),
      lastSeen: this.now(),
    };
    this.clients.set(client.id, client);
    this.log(`[clients] ${name} registered (${client.status})`);
    return client;
  }

  byToken(value) {
    if (typeof value !== 'string') return undefined;
    const got = Buffer.from(value);
    for (const c of this.clients.values()) {
      const want = Buffer.from(c.token);
      if (got.length === want.length && crypto.timingSafeEqual(got, want)) {
        c.lastSeen = this.now();
        return c;
      }
    }
    return undefined;
  }

  list() {
    return [...this.clients.values()].map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      scope: c.scope,
      tools: c.tools?.map(t => t.name) ?? [],
      online: c.link?.online ?? false,
    }));
  }

  approve(name) {
    const matching = [...this.clients.values()].filter(c => c.name === name);
    if (matching.length === 0) throw new ClientError(404, 'NOT_FOUND', `no registered client named ${name}`);
    const scope = matching[matching.length - 1].scope;
    this.store.approveClient(name, scope, this.now());
    for (const c of matching) c.status = 'approved';
    this.log(`[clients] ${name} approved`);
    return scope;
  }

  async setTools(client, rawTools) {
    if (client.status !== 'approved') throw new ClientError(403, 'APPROVAL_PENDING', `run: codie clients approve ${client.name}`);
    if (!client.scope.tools) throw new ClientError(403, 'SCOPE_DENIED', 'this client did not request tool hosting');
    // An empty list withdraws the tools: the device link closes, so clt01
    // stops declaring them; the integration stays for the next catalog.
    if (Array.isArray(rawTools) && rawTools.length === 0) {
      client.tools = null;
      this.relink(client, false);
      return;
    }
    let tools;
    try { tools = validateTools(rawTools); } catch (e) { throw new ClientError(400, 'TOOL_CATALOG_INVALID', e.message); }
    client.tools = tools;
    if (client.link) {
      await client.link.updateTools(tools);
      return;
    }
    this.relink(client);
  }

  // Replaces the client's device link with a new one from makeLink, which
  // republishes its catalog; with `connect` false it is left without one.
  relink(client, connect = true) {
    client.link?.stop();
    client.link = null;
    if (!connect || !client.tools) return;
    client.link = this.makeLink(client, client.tools, call => this.#deliver(client, call));
    client.link.start();
  }

  #deliver(client, call) {
    const item = {
      invocation_id: call.invocation_id,
      name: call.name,
      arguments: call.arguments ?? {},
      deadline_unix_ms: call.deadline_unix_ms ?? this.now() + (call.timeout_ms ?? 5000),
    };
    client.queue.push(item);
    for (const wake of client.waiters) wake();
  }

  // Long poll: resolves with pending calls, or [] after waitMs.
  async nextCalls(client, waitMs, signal) {
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), MAX_WAIT_MS);
    const take = () => {
      const now = this.now();
      const live = client.queue.filter(c => c.deadline_unix_ms > now);
      client.queue = [];
      return live;
    };
    let calls = take();
    if (calls.length || wait === 0) return calls;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); client.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, wait);
      client.waiters.add(done);
      signal?.addEventListener('abort', done);
    });
    client.lastSeen = this.now();
    calls = take();
    return calls;
  }

  submitResult(client, invocationId, body) {
    const status = body?.status;
    if (!RESULT_STATUSES.has(status)) throw new ClientError(400, 'INVALID_ARGUMENT', 'status must be succeeded, failed or needs_clarification');
    const data = body.data ?? {};
    if (typeof data !== 'object' || Array.isArray(data)) throw new ClientError(400, 'INVALID_ARGUMENT', 'data must be an object');
    const result = { status, data };
    if (status === 'failed') {
      if (typeof body.code !== 'string' || !body.code) throw new ClientError(400, 'INVALID_ARGUMENT', 'a failed result needs a code');
      result.code = body.code;
      if (typeof body.message === 'string') result.message = body.message;
    }
    if (!client.link?.sendResult(invocationId, result)) {
      throw new ClientError(409, 'DEVICE_OFFLINE', 'the device connection for this client is down; the call is lost');
    }
  }

  close(client) {
    client.link?.stop();
    for (const wake of client.waiters) wake();
    this.clients.delete(client.id);
    this.log(`[clients] ${client.name} closed`);
  }

  // Drops clients that stopped polling (crashed without closing).
  sweep() {
    const cutoff = this.now() - CLIENT_TIMEOUT_MS;
    for (const c of [...this.clients.values()]) if (c.lastSeen < cutoff && c.waiters.size === 0) this.close(c);
  }

  get size() { return this.clients.size; }
}
