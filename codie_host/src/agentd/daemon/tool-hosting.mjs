import WebSocket from 'ws';
import { ClientError, ClientRegistry } from '../tools/clients.mjs';
import { DeviceClient } from '../tools/device-client.mjs';
import { integrationId } from '../tools/integration-id.mjs';
import { ToolLink } from '../tools/tool-link.mjs';
import { HttpError } from './ipc.mjs';

export const NOT_PAIRED = 'No Codie device with a client credential is paired; pair one again (its firmware must support client credentials).';

export const hasClientCredential = r => Boolean(r?.credentialId && r.credentialSecret && r.userId);

// The paired device tool hosting and the client device routes talk to: the
// tools device (settings.json `toolsDevice`, set by pairing and `codie tools
// device`) while it holds a client credential, else the first pairing that
// does, else null.
export function toolDevice(store) {
  const able = store.listPairings().filter(hasClientCredential);
  const chosen = store.readSettings().toolsDevice;
  return able.find(r => r.deviceId === chosen) ?? able[0] ?? null;
}

// The tools device for `codie status` / `codie tools device`, and the chosen
// one when the fallback overrides it (it lost its credential or was unpaired).
export function toolsDeviceStatus(store) {
  const toolsDevice = toolDevice(store)?.deviceId ?? null;
  const chosen = store.readSettings().toolsDevice ?? null;
  return chosen && chosen !== toolsDevice ? { toolsDevice, chosen } : { toolsDevice };
}

// An install from before `toolsDevice` keeps the device it used (the first
// credentialed pairing) as its choice, so no later change to the pairings
// decides it again.
export function pinToolsDevice(store) {
  if (store.readSettings().toolsDevice) return;
  const record = toolDevice(store);
  if (record) store.updateSettings({ toolsDevice: record.deviceId });
}

// Whether a link made for `a` would still reach the device as `b` describes it.
const sameTarget = (a, b) => ['deviceId', 'host', 'port', 'credentialId', 'credentialSecret', 'userId'].every(k => a[k] === b[k]);

const asHttp = e => (e instanceof ClientError ? new HttpError(e.status, e.message, e.code) : e);
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { throw asHttp(e); } };

// Local tool clients (spec §6.1, §6.2): each registers with the agentd token,
// gets its own token, and once the user approved its scope publishes its
// tools as one clt01 external tool integration; calls from Codie's model are
// long-polled and answered through the client routes. Client links follow
// the tools device (`sync()`); `onUnreachable(deviceId, error)` / `onReachable(deviceId)`
// hear whether a link's publish reached its device's address.
export function createToolHosting({ store, log = () => {}, onUnreachable = () => {}, onReachable = () => {},
  WebSocketImpl = WebSocket, fetchImpl = fetch }) {
  const device = () => {
    const record = toolDevice(store);
    if (!record) throw new HttpError(409, NOT_PAIRED, 'NOT_PAIRED');
    return record;
  };

  const targets = new WeakMap(); // ToolLink -> the pairing record it was made for
  const registry = new ClientRegistry({
    store,
    log,
    makeLink: (client, tools, onInvoke) => {
      const record = device();
      const link = new ToolLink({
        device: DeviceClient.forPairing(record, fetchImpl),
        integrationId: integrationId(record.deviceId, client.name),
        name: client.name, tools, onInvoke, log, WebSocketImpl,
        onUnreachable: e => onUnreachable(record.deviceId, e),
        onReachable: () => onReachable(record.deviceId),
      });
      targets.set(link, record);
      return link;
    },
  });

  // Best-effort: the client's integration on a device it no longer uses,
  // once the old link's last publish has landed (a later PUT would recreate
  // it), and not if the tools went back to that device meanwhile.
  const dropIntegration = async (record, name, oldLink) => {
    await oldLink.settled();
    if (toolDevice(store)?.deviceId === record.deviceId) return;
    try {
      await DeviceClient.forPairing(record, fetchImpl)
        .request('DELETE', `/v1/api/data/user/tool-integrations/${integrationId(record.deviceId, name)}`);
    } catch { /* gone, or the device is unreachable */ }
  };

  // Moves every published client to the current tools device: a new link
  // (it republishes the catalog) when the device or its address or
  // credential changed, none without a tools device. An integration left on
  // another device is deleted there; the same device keeps its integration id,
  // so it is only republished.
  function sync() {
    const record = toolDevice(store);
    for (const client of [...registry.clients.values()]) {
      if (!client.tools) continue;
      const old = client.link ? targets.get(client.link) : null;
      if (old && record && sameTarget(old, record)) continue;
      if (!old && !record) continue;
      if (record) log(`[clients] ${client.name} now on ${record.deviceId} (${record.host}:${record.port})`);
      const oldLink = client.link;
      registry.relink(client, Boolean(record));
      if (old && old.deviceId !== record?.deviceId) dropIntegration(old, client.name, oldLink);
    }
  }

  // `codie tools device <id>`: only a pairing with a client credential.
  function setDevice(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId) throw new HttpError(400, 'device_id is required', 'INVALID_ARGUMENT');
    const record = store.listPairings().find(r => r.deviceId === deviceId);
    if (!record) throw new HttpError(404, `device ${deviceId} is not paired; scan and pair it first`, 'NOT_PAIRED');
    if (!hasClientCredential(record)) {
      throw new HttpError(409, `device ${deviceId} has no client credential, so it cannot host tools: its firmware is too old, or pair it again`, 'REPAIR_REQUIRED');
    }
    store.updateSettings({ toolsDevice: deviceId });
    sync();
    return { toolsDevice: deviceId };
  }

  const routes = {
    'GET /tools-device': () => toolsDeviceStatus(store),
    'POST /tools-device': body => setDevice(body?.device_id),
    'GET /clients': () => ({ clients: registry.list() }),
    'POST /clients': guard(body => {
      const c = registry.register(body?.name, body?.scope);
      return { id: c.id, token: c.token, status: c.status };
    }),
    'POST /clients/approve': guard(body => ({ name: body?.name, scope: registry.approve(body?.name) })),
    'POST /clients/revoke': body => {
      for (const c of [...registry.clients.values()]) if (c.name === body?.name) registry.close(c);
      return { revoked: store.revokeClient(body?.name) };
    },
    'GET /clients/:id': {
      client: true,
      handler: (body, { client }) => ({ status: client.status, online: client.link?.online ?? false, tools: client.tools?.map(t => t.name) ?? [] }),
    },
    'PUT /clients/:id/tools': {
      client: true,
      handler: guard(async (body, { client }) => {
        device();
        await registry.setTools(client, body?.tools);
        return { tools: client.tools?.map(t => t.name) ?? [] };
      }),
    },
    'POST /clients/:id/calls': {
      client: true,
      handler: async (body, { client, signal }) => ({ calls: await registry.nextCalls(client, body?.wait_ms, signal) }),
    },
    'POST /clients/:id/calls/:invocation/result': {
      client: true,
      handler: guard((body, { client, params }) => {
        registry.submitResult(client, params.invocation, body);
        return { ok: true };
      }),
    },
    'POST /clients/:id/close': { client: true, handler: (body, { client }) => { registry.close(client); return { ok: true }; } },
  };

  const close = () => { for (const c of [...registry.clients.values()]) registry.close(c); };

  // Best-effort device cleanup when a pairing goes away: the integrations of
  // every approved client and the credential itself.
  async function forget(record) {
    if (!record?.credentialId) return;
    const d = DeviceClient.forPairing(record, fetchImpl);
    for (const name of Object.keys(store.approvedClients())) {
      try { await d.request('DELETE', `/v1/api/data/user/tool-integrations/${integrationId(record.deviceId, name)}`); } catch { /* already gone */ }
    }
    try { await d.request('DELETE', `/v1/api/auth/credentials/${record.credentialId}`); } catch (e) { log('credential revoke failed', e?.message ?? e); }
  }

  return { registry, routes, close, forget, sync, resolveClient: t => registry.byToken(t) };
}
