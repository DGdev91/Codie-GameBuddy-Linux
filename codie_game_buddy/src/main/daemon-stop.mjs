import fs from 'node:fs';
import path from 'node:path';
import { codieHome } from 'codie-host';

// Asks the running codie-agentd to shut down, as `codie stop` does, and waits
// until it has removed its agentd.json (the last step of its shutdown).

const POLL_MS = 100;

export async function stopDaemon({ home = codieHome(), timeoutMs = 5000 } = {}) {
  const file = path.join(home, 'agentd.json');
  let info;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // not running
  }
  await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
    method: 'POST', headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(2000),
  });
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('codie-agentd is still running');
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  return true;
}
