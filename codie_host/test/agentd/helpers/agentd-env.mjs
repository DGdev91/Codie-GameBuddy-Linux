// For tests that spawn a real session server (src/ or dist/server.mjs): it
// spawns a real, detached codie-agentd. isolatedAgentdEnv() points it at a
// temp CODIE_HOME (no real pairings); stopAgentd() ends it.
// The temp dirs are removed when the test file finishes.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs = [];
const tmp = prefix => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
after(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

export async function isolatedAgentdEnv() {
  const home = tmp('codie-home-');
  return {
    home,
    env: {
      CODIE_HOME: home,
      // Never the real Claude / Codex records of the session running the tests.
      CLAUDE_PROJECT_DIR: '',
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_CONFIG_DIR: tmp('codie-claude-config-'),
      CODEX_HOME: tmp('codie-codex-home-'),
    },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readInfo = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'agentd.json'), 'utf8')); } catch { return null; } };

// Asks the agentd of `home` to shut down (POST /shutdown), killing it if it
// is still alive after `waitMs`. A session may have exited before its agentd
// wrote agentd.json, so once a spawn was attempted (agentd.log exists) this
// waits for the file first.
export async function stopAgentd(home, { waitMs = 5000 } = {}) {
  const deadline = Date.now() + waitMs;
  let info = readInfo(home);
  while (!info && fs.existsSync(path.join(home, 'agentd.log')) && Date.now() < deadline) {
    await sleep(50);
    info = readInfo(home);
  }
  if (!info?.pid) return;
  try {
    await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      method: 'POST', headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1000),
    });
  } catch { /* fall back to a kill below */ }
  while (alive(info.pid) && Date.now() < deadline) await sleep(50);
  if (alive(info.pid)) try { process.kill(info.pid, 'SIGKILL'); } catch { /* gone */ }
}
