import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../../src/agentd/daemon/doctor.mjs';

function deps({ host = 'claude', pairings = [], online = [], settings = {}, backend = 'claude', inbox = true, refused = [] } = {}) {
  return {
    host,
    repairRequired: id => refused.includes(id),
    store: { listPairings: () => pairings, readSettings: () => settings },
    link: { onlineDevices: () => online.map(deviceId => ({ deviceId })) },
    router: { describe: () => (host === 'codex' ? 'Codex ×1' : 'Claude Code ×1'), hasInbox: () => inbox },
    session: { host },
    dispatcher: { backend: () => backend },
    version: 9, nodeVersion: '22.1.0',
  };
}

test('doctor reports a push receiver ahead of the fallback Codex backend', async () => {
  const d = deps({ host: 'codex', backend: 'codex' });
  d.router.hasPushReceiver = () => true;
  assert.match(await runDoctor(d), /a Claude Code session that receives tasks automatically \(before Codex or listeners\)/);
});

test('all good: every line is ✅ and the self-test step is given', async () => {
  const out = await runDoctor(deps({ pairings: [{ deviceId: 'd1', name: 'Living room' }], online: ['d1'] }));
  assert.doesNotMatch(out, /❌|⚠️/);
  assert.match(out, /Device "Living room" online/);
  assert.match(out, /codie_notify/);
});

test('missing pieces come with the exact fix', async () => {
  const out = await runDoctor({ ...deps({ pairings: [{ deviceId: 'd1', name: 'Living room' }], online: [], backend: null }), nodeVersion: '18.19.0' });
  assert.match(out, /❌ Node 18\.19\.0/);
  assert.match(out, /❌ Device "Living room" offline[\s\S]*same Wi-Fi/);
  assert.match(out, /⚠️ Device tasks have nowhere to go when no one is listening[\s\S]*Run claude once/);
});

test('a device that refused this computer\'s credential → pair it again', async () => {
  const out = await runDoctor(deps({ pairings: [{ deviceId: 'd1', name: 'Living room' }], online: [], refused: ['d1'] }));
  assert.match(out, /❌ Device "Living room" no longer accepts this computer\n   → [^\n]*pair Codie/);
  assert.doesNotMatch(out, /same Wi-Fi/);
});

test('no devices paired → pair', async () => {
  const out = await runDoctor(deps());
  assert.match(out, /❌ No Codie device is paired yet[\s\S]*pair Codie/);
});

test('only the calling host is looked at: Codex never mentions Claude', async () => {
  const out = await runDoctor(deps({ host: 'codex', backend: null }));
  assert.doesNotMatch(out, /Claude|claude/);
  assert.match(out, /queue tasks into Codex on/);
  assert.match(out, /⚠️ Device tasks have nowhere to go when no one is listening[\s\S]*Codex/);
});

test('Claude Code never mentions Codex', async () => {
  const out = await runDoctor(deps({ backend: null }));
  assert.doesNotMatch(out, /Codex|codex/);
  assert.match(out, /background Claude sessions on/);
});

test("the calling host's switch is reported; switched off, no warning", async () => {
  const claude = await runDoctor(deps({ settings: { codexQueue: false, claudeBackground: false }, backend: null }));
  assert.match(claude, /background Claude sessions off/);
  assert.doesNotMatch(claude, /⚠️/);
  const codex = await runDoctor(deps({ host: 'codex', settings: { codexQueue: false }, backend: null }));
  assert.match(codex, /queue tasks into Codex off/);
  assert.doesNotMatch(codex, /⚠️/);
});

test('a Claude Code session with its inbox monitor takes device tasks by itself', async () => {
  const out = await runDoctor(deps({ pairings: [{ deviceId: 'd1', name: 'Living room' }], online: ['d1'] }));
  assert.match(out, /✅ This Claude Code session receives device tasks automatically/);
});

test('a Claude Code session without its inbox monitor is told why', async () => {
  const out = await runDoctor(deps({ pairings: [{ deviceId: 'd1', name: 'Living room' }], online: ['d1'], inbox: false }));
  assert.match(out, /⚠️ This Claude Code session has not started the Codie inbox[\s\S]*Git Bash/);
});
