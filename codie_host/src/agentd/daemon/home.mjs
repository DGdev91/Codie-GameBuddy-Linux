import os from 'node:os';
import path from 'node:path';

// One data dir shared by the Claude Code and Codex plugins.
export function codieHome() {
  return process.env.CODIE_HOME || path.join(os.homedir(), '.codie');
}
