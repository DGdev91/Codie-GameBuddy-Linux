import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// agentd runs under some session's MCP server; a child must not look like
// part of that session (Claude Code refuses to nest, for one, and a project
// directory or sandbox from the spawning session must not leak). A host app
// started from the GUI hands agentd a minimal PATH: add where the CLIs live.
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_PROJECT_DIR|CLAUDE_CODE_.*|CLAUDE_PLUGIN_.*|CODEX_THREAD.*|CODEX_SANDBOX.*)$/;
export function childEnv(env = process.env, home = os.homedir()) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SESSION_VARS.test(k)) out[k] = v;
  if (process.platform !== 'win32') {
    const dirs = (out.PATH ?? '').split(':').filter(Boolean);
    for (const d of [path.join(home, '.local/bin'), path.join(home, '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin']) {
      if (!dirs.includes(d)) dirs.push(d);
    }
    out.PATH = dirs.join(':');
  }
  return out;
}

export function runFile(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 << 20, env: childEnv(), ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
