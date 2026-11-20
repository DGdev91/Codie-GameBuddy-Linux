import crypto from 'node:crypto';

// The integration name agentd publishes ask_agent / cancel_task under; no
// registered client may take it (it would share that integration's id).
export const AGENTS_CLIENT = 'agents';

// One stable integration per (device, client) (spec §6.2): the same client
// on the same device always updates the same clt01 integration.
export function integrationId(deviceId, clientName) {
  const hex = crypto.createHash('sha256').update(`codie-host|${deviceId}|${clientName}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
