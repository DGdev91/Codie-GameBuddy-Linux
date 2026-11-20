import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';

// Walks parent pids via `ps` (macOS/Linux). On Windows we don't walk and
// return []: hookPids adds CLAUDE_PID instead.
export function ancestorPids(start = process.ppid, maxDepth = 16) {
  if (process.platform === 'win32') return [];
  const chain = [];
  let pid = start;
  while (pid > 1 && chain.length < maxDepth) {
    chain.push(pid);
    try {
      pid = parseInt(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10);
    } catch { break; }
  }
  return chain;
}

// The pids a hook reports to agentd. Claude Code sets CLAUDE_PID (its own
// pid, the sessionPid its MCP servers register) in a hook's environment;
// between them sits a shell, so on Windows it is the only pid that matches.
export function hookPids({ env = process.env, chain = ancestorPids() } = {}) {
  const claude = Number(env.CLAUDE_PID);
  return Number.isInteger(claude) && claude > 0 && !chain.includes(claude) ? [...chain, claude] : chain;
}

// A hook on Windows that knows no pid (a Claude Code without CLAUDE_PID)
// matches every session, so agentd falls back to the most recently active one.
export function belongsToSession(chain, sessionPid, { platform = process.platform } = {}) {
  if (platform === 'win32' && !chain?.length) return true;
  return Array.isArray(chain) && chain.includes(sessionPid);
}

// Signal 0 probes existence: ESRCH → gone, EPERM → alive (other user).
export function pidAlive(pid, { kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

// A process's working directory, or null (unknown pid, or Windows). For
// sessions whose client predates the `cwd` field of POST /sessions.
// Async: agentd calls it while serving IPC.
export async function pidCwd(pid, { platform = process.platform, run = lsofOut, readlink = fs.promises.readlink } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') return await readlink(`/proc/${pid}/cwd`);
    if (platform === 'darwin') {
      const out = String(await run(['-a', '-p', String(pid), '-d', 'cwd', '-Fn']));
      const line = out.split('\n').find(l => l.startsWith('n/'));
      return line ? line.slice(1) : null;
    }
  } catch { /* gone, or no lsof */ }
  return null;
}

const lsofOut = args => new Promise((resolve, reject) => {
  execFile('lsof', args, { encoding: 'utf8', timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

// status.json outlives a crashed server; only trust it while its session lives.
export function isLiveStatus(s) {
  return s?.mode === 'active' && pidAlive(s.sessionPid);
}
