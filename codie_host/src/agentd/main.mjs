// codie-agentd: the one process that owns the Codie device link for every
// Claude Code / Codex session. Spawned detached by a session (ensure.mjs);
// stdio is ignored, so everything goes to <home>/agentd.log.
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { codieHome } from './daemon/home.mjs';
import { startAgentd } from './daemon/agentd-core.mjs';
import { ClaudeBackground } from './daemon/claude-background.mjs';
import { CodexQueue } from './daemon/codex-queue.mjs';

const LOG_MAX_BYTES = 5 * 1024 * 1024;

export async function runAgentd() {
  const home = codieHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const logPath = path.join(home, 'agentd.log');
  // One generation of rotation, at startup: agentd.log → agentd.log.1.
  try {
    if (fs.statSync(logPath).size > LOG_MAX_BYTES) fs.renameSync(logPath, `${logPath}.1`);
  } catch { /* no log yet */ }
  const out = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  out.on('error', () => {}); // a lost log line must never crash agentd
  // util.format: printf-style like console, Errors with stacks, cycles safe.
  const log = (...a) => { if (!out.writableEnded) out.write(`${new Date().toISOString()} ${format(...a)}\n`); };
  console.log = console.info = console.warn = console.error = console.debug = log; // bonjour & friends
  process.on('uncaughtException', e => log('uncaughtException', e));
  process.on('unhandledRejection', e => log('unhandledRejection', e));
  try {
    const a = await startAgentd({ home, log, exit: () => out.end(() => process.exit(0)),
      codexQueue: new CodexQueue(), claudeBackground: new ClaudeBackground({ home }) });
    process.on('SIGTERM', () => a.shutdown().catch(log));
    process.on('SIGINT', () => a.shutdown().catch(log));
    log(`agentd ready, pid ${process.pid}`);
  } catch (e) {
    log('agentd failed to start', e);
    // Let the stream flush the reason before exiting.
    out.end(() => process.exit(1));
  }
}
