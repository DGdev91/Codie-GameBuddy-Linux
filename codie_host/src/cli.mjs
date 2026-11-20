import fs from 'node:fs';
import path from 'node:path';
import { codieHome } from './agentd/daemon/home.mjs';
import { runAgentd } from './agentd/main.mjs';
import { ensureDaemon } from '../sdk/index.mjs';

const USAGE = `codie <command>

  scan                              find Codie devices on the LAN
  pair begin <device_id>            show a pairing code on the device (scan first)
  pair confirm <device_id> <code>   finish pairing with the 6-digit code
  pair cancel <device_id>           abandon the pairing in progress
  unpair <device_id>                forget the device and revoke this computer's credential
  tools device [<device_id>]        show or set the device tools and tool clients use
                                    (a paired device with a client credential)
  status                            agentd, devices, the tools device and connected tools
  clients                           list connected tools
  clients approve <name>            grant a waiting tool its requested scope (tools, device API, pairing)
  clients revoke <name>             forget a tool's approval
  stop                              stop codie-agentd
  daemon                            run codie-agentd in the foreground`;

const print = value => process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);

async function call(agentd, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${agentd.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${agentd.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
  return parsed;
}

// The device tools agentd exposes to sessions, run without one.
async function tool(name, args = {}) {
  const r = await call(await ensureDaemon(), 'POST', `/tools/${name}`, { args });
  const text = r.content?.map(c => c.text).join('\n') ?? '';
  if (r.isError) throw new Error(text);
  return text;
}

async function stop() {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(codieHome(), 'agentd.json'), 'utf8')); } catch { return 'codie-agentd is not running.'; }
  try { await call(info, 'POST', '/shutdown', {}); } catch { return 'codie-agentd is not running.'; }
  return 'codie-agentd is stopping.';
}

export async function main(argv) {
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case 'daemon': return runAgentd();
    case 'scan': return print(await tool('codie_list_devices'));
    case 'pair':
      if (sub === 'begin' && rest[0]) return print(await tool('codie_pair_begin', { device_id: rest[0] }));
      if (sub === 'confirm' && rest[1]) return print(await tool('codie_pair_confirm', { device_id: rest[0], code: rest[1] }));
      if (sub === 'cancel' && rest[0]) return print(await tool('codie_pair_cancel', { device_id: rest[0] }));
      break;
    case 'unpair':
      if (sub) return print(await tool('codie_unpair', { device_id: sub }));
      break;
    case 'tools':
      if (sub === 'device' && rest.length <= 1) {
        const agentd = await ensureDaemon();
        return print(rest[0] ? await call(agentd, 'POST', '/tools-device', { device_id: rest[0] }) : await call(agentd, 'GET', '/tools-device'));
      }
      break;
    case 'status': return print(await call(await ensureDaemon(), 'GET', '/status'));
    case 'clients': {
      const agentd = await ensureDaemon();
      if ((sub === 'approve' || sub === 'revoke') && rest[0]) return print(await call(agentd, 'POST', `/clients/${sub}`, { name: rest[0] }));
      if (!sub) return print(await call(agentd, 'GET', '/clients'));
      break;
    }
    case 'stop': return print(await stop());
    default:
  }
  print(USAGE);
  process.exitCode = 2;
}
