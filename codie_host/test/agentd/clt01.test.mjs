import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pairRequest, pairConfirm, pairCancel, deviceAuth } from '../../src/agentd/clt01.mjs';
import { isNetworkError } from '../../src/agentd/tools/device-client.mjs';

function fakeClt01(routes) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* multipart */ }
      calls.push({ method: req.method, path: req.url, headers: req.headers, raw: body, body: parsed });
      const r = routes[req.url];
      res.writeHead(r ? r.status : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r ? r.body : { error: 'nf' }));
    });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, calls, port: srv.address().port })));
}

test('pairRequest returns challengeId', async () => {
  const f = await fakeClt01({ '/v1/api/auth/pair/request': { status: 200, body: { data: { challenge_id: 'c1', expires_at_ms: 9 } } } });
  try {
    assert.deepEqual(await pairRequest('127.0.0.1', f.port), { challengeId: 'c1', expiresAtMs: 9 });
    assert.deepEqual(f.calls[0].body, {});
  } finally { f.srv.close(); }
});

test('pairConfirm sends code and maps fields', async () => {
  const f = await fakeClt01({ '/v1/api/auth/pair/confirm': { status: 200, body: { data: {
    local_secret: 'l', auth_scope: '', challenge_id: 'c1', device_id: 'd', name: 'Living room', version: '1.5.4',
  } } } });
  try {
    const r = await pairConfirm('127.0.0.1', f.port, 'c1', '123456');
    assert.deepEqual(r, { deviceId: 'd', name: 'Living room', localSecret: 'l' });
    assert.deepEqual(f.calls[0].body, { challenge_id: 'c1', pairing_code: '123456' });
  } finally { f.srv.close(); }
});

test('pairConfirm surfaces server error message (wrong code)', async () => {
  const f = await fakeClt01({ '/v1/api/auth/pair/confirm': { status: 400, body: { message: 'Wrong verification code' } } });
  try {
    await assert.rejects(pairConfirm('127.0.0.1', f.port, 'c1', '000000'), /Wrong verification code/);
  } finally { f.srv.close(); }
});

test('pairConfirm rejects a reply without local_secret', async () => {
  const f = await fakeClt01({ '/v1/api/auth/pair/confirm': { status: 200, body: { data: { device_id: 'd', local_secret: '' } } } });
  try {
    await assert.rejects(pairConfirm('127.0.0.1', f.port, 'c1', '1'), /malformed/);
  } finally { f.srv.close(); }
});

test('pairCancel posts challenge id and never throws', async () => {
  const f = await fakeClt01({ '/v1/api/auth/pair/cancel': { status: 200, body: { data: {} } } });
  try {
    await pairCancel('127.0.0.1', f.port, 'c1');
    assert.deepEqual(f.calls[0].body, { challenge_id: 'c1' });
    await pairCancel('127.0.0.1', 1, 'c1'); // unreachable → swallowed
  } finally { f.srv.close(); }
});

test('success:false is a failure and carries err.code', async () => {
  const f = await fakeClt01({ '/v1/api/auth/pair/confirm': { status: 200, body: { success: false, code: 'PAIR_CODE_INVALID', message: 'Wrong verification code', data: {} } } });
  try {
    await assert.rejects(pairConfirm('127.0.0.1', f.port, 'c1', '000000'),
      e => e.code === 'PAIR_CODE_INVALID' && /Wrong verification code/.test(e.message));
  } finally { f.srv.close(); }
});

test('HTTP error carries err.code', async () => {
  const f = await fakeClt01({ '/v1/api/auth/pair/request': { status: 429, body: { code: 'RATE_LIMITED', message: 'slow down' } } });
  try {
    await assert.rejects(pairRequest('127.0.0.1', f.port), e => e.code === 'RATE_LIMITED');
  } finally { f.srv.close(); }
});

test('pairRequest rejects non-numeric expires_at_ms', async () => {
  const f = await fakeClt01({ '/v1/api/auth/pair/request': { status: 200, body: { data: { challenge_id: 'c1', expires_at_ms: '9' } } } });
  try {
    await assert.rejects(pairRequest('127.0.0.1', f.port), /malformed/);
  } finally { f.srv.close(); }
});

const BOOT = '/v1/api/auth/bootstrap';
const boot = { status: 200, body: { success: true, data: { user_id: 'u1' } } };

test('deviceAuth returns the signing identity', async () => {
  const f = await fakeClt01({ [BOOT]: boot });
  try {
    assert.deepEqual(await deviceAuth('127.0.0.1', f.port, 'L'), { secret: 'L', userId: 'u1' });
  } finally { f.srv.close(); }
});

test('deviceAuth refuses a missing local_secret or a logged-out device', async () => {
  await assert.rejects(deviceAuth('127.0.0.1', 1, ''), /local_secret/);
  const f = await fakeClt01({ [BOOT]: { status: 200, body: { success: true, data: {} } } });
  try {
    await assert.rejects(deviceAuth('127.0.0.1', f.port, 'L'), /bootstrap: device not signed in/);
  } finally { f.srv.close(); }
});

test('deviceAuth marks a logged-out device and keeps why bootstrap failed', async () => {
  const f = await fakeClt01({ [BOOT]: { status: 200, body: { success: true, data: {} } } });
  try {
    await assert.rejects(deviceAuth('127.0.0.1', f.port, 'L'), { code: 'DEVICE_NOT_SIGNED_IN' });
  } finally { await new Promise(r => f.srv.close(r)); }
  // The closed port refuses (a low port like 1 is one fetch never dials).
  const e = await deviceAuth('127.0.0.1', f.port, 'L').catch(x => x);
  assert.match(e.message, /^bootstrap: /);
  assert.equal(isNetworkError(e.cause), true);
});
