import WebSocket from 'ws';
import { catalogProtocol } from './catalog.mjs';
import { DeviceError, addressFailed, isNetworkError } from './device-client.mjs';
import { newChallenge, proofContextWs, proofMatches, signedWsQuery } from './sign.mjs';

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
// The device pings every 20s and drops a peer silent for 60s; the same
// window here notices a device that rebooted without closing the socket.
const SILENCE_MS = 60_000;
// clt01 sends small JSON frames (an invoke carries one spoken request);
// something larger did not come from it.
const MAX_FRAME_BYTES = 1024 * 1024;

// One clt01 external tool integration for one client (spec §6.2): publish
// the catalog over HTTP, then hold /v1/ws/tool-integrations/<id>/executor, relaying
// `invoke` to the client and its `result` back. Every (re)connect republishes
// first: an identical catalog is a no-op on the device, and a deleted or
// changed integration is restored. `onUnreachable(error)` hears every
// failure of the device's address (refused, timeout, DNS, or our credential
// refused there) and `onReachable()` every publish that went through: the
// owner may look for a new address; the link itself keeps retrying the old one.
export class ToolLink {
  constructor({ device, integrationId, name, tools, onInvoke, onState = () => {}, onUnreachable = () => {}, onReachable = () => {},
    log = () => {}, WebSocketImpl = WebSocket, silenceMs = SILENCE_MS }) {
    this.device = device;
    this.integrationId = integrationId;
    this.name = name;
    this.tools = tools;
    this.onInvoke = onInvoke;
    this.onState = onState;
    this.onUnreachable = onUnreachable;
    this.onReachable = onReachable;
    this.publishing = new Set();
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.silenceMs = silenceMs;
    this.silence = null;
    this.online = false;
    this.revision = 0;
    this.stopped = true;
    this.ws = null;
    this.timer = null;
    this.retryMs = MIN_RETRY_MS;
  }

  get path() { return `/v1/api/data/user/tool-integrations/${this.integrationId}`; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#cycle();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.silence);
    this.ws?.close();
    this.ws = null;
    this.#setOnline(false);
  }

  // A new catalog: the device closes the old connection itself after the
  // update; the close handler reconnects with the new revision. A link
  // stopped meanwhile (moved to another device) owes the caller nothing.
  async updateTools(tools) {
    this.tools = tools;
    if (this.stopped) return;
    try {
      await this.#publish();
    } catch (e) {
      if (!this.stopped) throw e;
    }
  }

  // Resolves once no publish of this link is on its way to the device.
  settled() { return Promise.all([...this.publishing]).then(() => {}); }

  sendResult(invocationId, result) {
    if (!this.online || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: 'result', data: { invocation_id: invocationId, ...result } }));
    return true;
  }

  // Publishes the catalog and tells the owner whether the device's address
  // answered.
  #publish() {
    const run = this.#put().then(() => { if (!this.stopped) this.onReachable(); }, e => {
      if (!this.stopped && addressFailed(e)) this.onUnreachable(e);
      throw e;
    });
    const tracked = run.catch(() => {}).finally(() => this.publishing.delete(tracked));
    this.publishing.add(tracked);
    return run;
  }

  // A revision conflict (someone else published meanwhile) is retried twice.
  async #put() {
    const { tools } = this;
    for (let attempt = 0; attempt < 3; attempt++) {
      let current = 0;
      try {
        current = (await this.device.request('GET', this.path))?.revision ?? 0;
      } catch (e) {
        if (!(e instanceof DeviceError && e.status === 404)) throw e;
      }
      if (this.stopped) return; // no catalog for a device this link left
      try {
        const saved = await this.device.request('PUT', this.path, {
          protocol_version: catalogProtocol(tools), expected_revision: current, name: this.name, enabled: true, tools,
        });
        this.revision = saved?.revision ?? current;
        return;
      } catch (e) {
        if (!(e instanceof DeviceError) || e.code !== 'INTEGRATION_REVISION_CONFLICT' || attempt > 1) throw e;
      }
    }
  }

  async #cycle() {
    if (this.stopped) return;
    try {
      await this.#publish();
      if (this.stopped) return; // stopped (or moved to another device) meanwhile
      this.#connect();
    } catch (e) {
      this.log(`[tools] ${this.name}: publish failed: ${e.code || e.cause?.code || ''} ${e.message}`);
      this.#retry();
    }
  }

  #retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#cycle(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  #connect() {
    const wsPath = `/v1/ws/tool-integrations/${this.integrationId}/executor`;
    // The device answers the challenge in `ready` (sign.mjs deviceProof):
    // until it has, nothing on this socket is believed.
    const challenge = newChallenge();
    const query = signedWsQuery(wsPath, this.device.credential);
    query.set('challenge', challenge);
    const url = `ws://${this.device.host}:${this.device.port}${wsPath}?${query}`;
    const ws = new this.WebSocketImpl(url, { maxPayload: MAX_FRAME_BYTES });
    this.ws = ws;
    this.#heard(ws);
    ws.on('ping', () => this.#heard(ws));
    ws.on('message', raw => { this.#heard(ws); this.#onMessage(ws, raw, challenge); });
    ws.on('unexpected-response', (_req, res) => this.log(`[tools] ${this.name}: upgrade refused with HTTP ${res.statusCode}`));
    ws.on('error', e => {
      this.log(`[tools] ${this.name}: ${e.message}`);
      if (this.ws === ws && isNetworkError(e)) this.onUnreachable(e);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      clearTimeout(this.silence);
      this.ws = null;
      this.#setOnline(false);
      this.#retry();
    });
  }

  #heard(ws) {
    if (this.ws !== ws) return;
    clearTimeout(this.silence);
    this.silence = setTimeout(() => {
      this.log(`[tools] ${this.name}: device silent for ${this.silenceMs}ms, reconnecting`);
      ws.terminate();
    }, this.silenceMs);
    this.silence.unref?.();
  }

  #onMessage(ws, raw, challenge) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const data = msg?.data ?? {};
    if (ws !== this.ws) return;
    if (msg?.type === 'ready') {
      if (!proofMatches(this.device.credential, proofContextWs(this.integrationId), challenge, data.proof)) {
        // Something at the device's address that does not hold our
        // credential: not the paired device, whatever it says.
        this.log(`[tools] ${this.name}: the device at ${this.device.host} did not prove it holds our credential; disconnecting`);
        ws.terminate();
        this.onUnreachable(new DeviceError(401, 'DEVICE_PROOF_MISMATCH', 'the device did not prove it holds the credential'));
        return;
      }
      this.revision = data.revision ?? this.revision;
      this.retryMs = MIN_RETRY_MS;
      this.#setOnline(true);
    } else if (msg?.type === 'invoke' && this.online) {
      this.onInvoke(data);
    } else if (msg?.type === 'error') {
      this.log(`[tools] ${this.name}: device error ${data.code} ${data.invocation_id ?? ''}`);
    }
  }

  #setOnline(online) {
    if (this.online === online) return;
    this.online = online;
    this.log(`[tools] ${this.name}: ${online ? `online (revision ${this.revision})` : 'offline'}`);
    this.onState(online);
  }
}
