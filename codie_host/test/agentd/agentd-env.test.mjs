import assert from 'node:assert/strict';
import test from 'node:test';
import { agentdEnv } from '../../src/agentd/daemon/ensure.mjs';

test('agentd runs as plain Node when the host process is Electron', () => {
  assert.equal(agentdEnv('/h', {}, { node: '24.21.0', electron: '44.7.2' }).ELECTRON_RUN_AS_NODE, '1');
  assert.equal(agentdEnv('/h', {}, { node: '24.21.0' }).ELECTRON_RUN_AS_NODE, undefined);
});

test('agentd env sets CODIE_HOME and drops Claude Code variables', () => {
  const env = agentdEnv('/h', { PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '9', CLAUDE_PID: '3' }, { node: '24.21.0' });
  assert.deepEqual(env, { PATH: 'p', CODIE_HOME: '/h' });
});
