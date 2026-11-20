import { ClientError } from '../tools/clients.mjs';
import { CHAT_TURNS_PATH, parseTurnRequest, runChatTurn } from '../tools/chat-turns.mjs';
import { DeviceClient, DeviceError, addressFailed, isCredentialRejected } from '../tools/device-client.mjs';
import { allowsApiPath } from '../tools/scope.mjs';
import { HttpError } from './ipc.mjs';
import { NOT_PAIRED, toolDevice } from './tool-hosting.mjs';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const CHAT_TURN_MAX_BYTES = 2 << 20; // base64 of a 1 MiB image plus text

const SCAN_MS = 3000;
const PAIRING_CODE = /^\d{6}$/;
// A pairing outcome as the client routes answer it (govee_buddy spec §4.1):
// `code` for the program to word itself; `message` the agent wording, for logs
// and for callers from before the codes.
const outcomeBody = (app, o, extra = {}) => ({
  ok: o.ok, code: o.code, ...(o.deviceName ? { deviceName: o.deviceName } : {}), ...extra, message: app.pairing.text(o),
});

const fail = (status, code, message) => new HttpError(status, message, code);

// Any failure → the IPC error a client sees (spec §7).
function asHttp(e) {
  if (e instanceof HttpError) return e;
  if (e instanceof ClientError) return fail(e.status, e.code, e.message);
  if (e instanceof DeviceError) {
    if (isCredentialRejected(e)) {
      return fail(409, 'REPAIR_REQUIRED', 'the device refused this computer\'s credential; pair the device again');
    }
    // Any other 401 stays a device error: as an IPC 401 the SDK would read it as its own token being bad.
    const status = e.status >= 400 && e.status !== 401 ? e.status : 502;
    return fail(status, e.code || 'DEVICE_ERROR', e.message);
  }
  return fail(503, 'DEVICE_OFFLINE', `the device did not answer: ${e?.message ?? e}`);
}

const clientRoute = (handler, extra = {}) => ({
  client: true,
  ...extra,
  handler: async (body, ctx) => { try { return await handler(body, ctx); } catch (e) { throw asHttp(e); } },
});

function approved(client) {
  if (client.status !== 'approved') throw fail(403, 'APPROVAL_PENDING', `run: codie clients approve ${client.name}`);
}

// A client that asked for pairing may pair before it is approved: typing the
// code from the device screen is the user's approval (see pair/confirm).
function mayPair(client) {
  if (!client.scope.pair) throw fail(403, 'SCOPE_DENIED', 'this client did not request pairing');
}

function deviceIdOf(body) {
  const id = body?.device_id;
  if (typeof id !== 'string' || !id) throw fail(400, 'INVALID_ARGUMENT', 'device_id is required');
  return id;
}

function within(client, path) {
  approved(client);
  if (!allowsApiPath(client.scope, path)) throw fail(403, 'SCOPE_DENIED', `${path} is outside this client's scope`);
}

// What a client does on the device beyond tool hosting (spec §6.4): device
// API calls within its scope, image chat turns, and scanning / pairing
// devices with the pair permission, on the device tool hosting uses. Every
// forwarded call is logged with the client name. A call that finds the
// device's address failed (`addressFailed`) tells `hosts.unreachable`, which
// may look for a new one; the call itself is not retried. A call that went
// through tells `hosts.reachable`.
export function createClientDeviceRoutes({ store, app, registry, fetchImpl = fetch, log = () => {}, hosts = { unreachable() {}, reachable() {} } }) {
  // The handler gets `device()`: the tools device's client, for this call.
  const deviceRoute = (handler, extra) => clientRoute(async (body, ctx) => {
    let record = null;
    const device = () => {
      record = toolDevice(store);
      if (!record) throw fail(409, 'NOT_PAIRED', NOT_PAIRED);
      return DeviceClient.forPairing(record, fetchImpl);
    };
    try {
      const result = await handler(body, ctx, device);
      if (record) hosts.reachable(record.deviceId);
      return result;
    } catch (e) {
      if (record && addressFailed(e)) hosts.unreachable(record.deviceId, e);
      throw e;
    }
  }, extra);

  return {
    'POST /clients/:id/api': deviceRoute(async (body, { client }, device) => {
      const method = String(body?.method ?? '').toUpperCase();
      const path = body?.path;
      if (!METHODS.has(method)) throw fail(400, 'INVALID_ARGUMENT', 'method must be GET, POST, PUT, PATCH or DELETE');
      if (typeof path !== 'string' || !path.startsWith('/v1/api/')) {
        throw fail(400, 'INVALID_ARGUMENT', 'path must be a /v1/api/ path');
      }
      const bare = path.split('?')[0];
      if (bare.includes('..')) throw fail(400, 'INVALID_ARGUMENT', 'path must be a /v1/api/ path');
      // The device verifies the signature over the decoded path while the
      // daemon signs the raw one, so a percent-encoded path never verifies
      // and could only hide a traversal from the scope check.
      if (bare.includes('%')) throw fail(400, 'INVALID_ARGUMENT', 'path must not contain percent-encoding');
      // fetch resolves dot segments (also percent-encoded ones) in the URL; a
      // path that changes under that is not the path the scope was checked on.
      if (new URL(path, 'http://device').pathname !== bare) {
        throw fail(400, 'INVALID_ARGUMENT', 'path must be a normalized /v1/api/ path');
      }
      within(client, bare);
      log(`[clients] ${client.name} ${method} ${bare}`);
      return { data: await device().request(method, path, body.body) };
    }),
    'POST /clients/:id/chat-turns': deviceRoute(async (body, { client, signal }, device) => {
      within(client, CHAT_TURNS_PATH);
      const req = parseTurnRequest(body);
      log(`[clients] ${client.name} chat turn (${req.image.length} bytes, speech ${req.speech})`);
      return runChatTurn(device(), req, { signal });
    }, { maxBytes: CHAT_TURN_MAX_BYTES }),
    'GET /clients/:id/devices': clientRoute(async (body, { client }) => {
      mayPair(client);
      return { found: await app.pairing.scan(SCAN_MS), paired: app.statusSnapshot().devices };
    }),
    'POST /clients/:id/pair/begin': clientRoute(async (body, { client }) => {
      mayPair(client);
      return outcomeBody(app, await app.pairing.begin(deviceIdOf(body)));
    }),
    // toolsReady: this confirm stored a new client credential, which also makes
    // the device the one the client routes act on (toolDevice).
    'POST /clients/:id/pair/confirm': clientRoute(async (body, { client }) => {
      mayPair(client);
      const deviceId = deviceIdOf(body);
      if (typeof body?.code !== 'string' || !PAIRING_CODE.test(body.code.trim())) throw fail(400, 'INVALID_ARGUMENT', 'code must be the 6 digits on the device screen');
      const credentialOf = () => store.listPairings().find(r => r.deviceId === deviceId)?.credentialId;
      const before = credentialOf();
      const toolsBefore = toolDevice(store)?.deviceId ?? null;
      log(`[clients] ${client.name} pairs ${deviceId}`);
      const o = await app.pairing.confirm(deviceId, body.code.trim());
      const after = credentialOf();
      const toolsAfter = toolDevice(store)?.deviceId ?? null;
      // Pairing sets the tools device for every client, not only this one.
      if (toolsAfter !== toolsBefore) log(`[clients] ${client.name} paired ${toolsAfter}; tools now go to it (was ${toolsBefore ?? 'none'})`);
      const toolsReady = Boolean(after) && after !== before && toolsAfter === deviceId;
      // The user read the code off the device and typed it into this client:
      // that approves the scope it asked for, as `codie clients approve` would.
      if ((o.ok || toolsReady) && client.status !== 'approved') {
        registry.approve(client.name);
        log(`[clients] ${client.name} approved by pairing ${deviceId}`);
      }
      if (!o.ok) log(`[clients] ${client.name} pairing ${deviceId} failed: ${o.code}`);
      return outcomeBody(app, o, { toolsReady });
    }),
    'POST /clients/:id/pair/cancel': clientRoute(async (body, { client }) => {
      mayPair(client);
      return outcomeBody(app, await app.pairing.cancel(deviceIdOf(body)));
    }),
  };
}
