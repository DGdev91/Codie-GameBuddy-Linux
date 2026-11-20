import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { validateTools } from '../../src/agentd/tools/catalog.mjs';
import { integrationId } from '../../src/agentd/tools/integration-id.mjs';
import { allowsApiPath, normalizeScope, scopeCovers } from '../../src/agentd/tools/scope.mjs';
import { EMPTY_BODY_HASH, UNSIGNED_PAYLOAD, sha256Hex, signedHeaders, signedMultipartHeaders, signedWsQuery } from '../../src/agentd/tools/sign.mjs';

const cred = { id: 'cred-1', secret: 's3cret', userId: 'u1' };
const hmac = s => crypto.createHmac('sha256', cred.secret).update(s).digest('hex');

test('signed headers follow clt01 canonical string and carry the credential id', () => {
  const h = signedHeaders('PUT', '/v1/api/x', '{"a":1}', cred, 1_700_000_000_000);
  assert.equal(h['X-Local-Timestamp'], '1700000000');
  assert.equal(h['X-Local-Body-Hash'], sha256Hex('{"a":1}'));
  assert.equal(h['X-Local-Session-Id'], 'cred-1');
  const canonical = ['PUT', '/v1/api/x', '1700000000', h['X-Local-Nonce'], 'json', h['X-Local-Body-Hash'], 'u1'].join('|');
  assert.equal(h['X-Local-Sig'], hmac(canonical));
});

test('multipart headers sign the literal UNSIGNED-PAYLOAD', () => {
  const h = signedMultipartHeaders('POST', '/v1/api/data/user/chat/turns', cred, 1_700_000_000_000);
  assert.equal(h['X-Local-Payload-Mode'], 'multipart');
  assert.equal(h['X-Local-Body-Hash'], UNSIGNED_PAYLOAD);
  assert.equal(h['X-Local-Session-Id'], 'cred-1');
  assert.equal(h['content-type'], undefined);
  const canonical = ['POST', '/v1/api/data/user/chat/turns', '1700000000', h['X-Local-Nonce'], 'multipart', UNSIGNED_PAYLOAD, 'u1'].join('|');
  assert.equal(h['X-Local-Sig'], hmac(canonical));
});

test('master credential sends no session id', () => {
  assert.equal(signedHeaders('GET', '/p', '', { secret: 'm', userId: 'u' })['X-Local-Session-Id'], undefined);
});

test('websocket query signs GET with the empty payload mode', () => {
  const q = signedWsQuery('/v1/ws/tool-integrations/abc', cred, 1_700_000_000_000);
  assert.equal(q.get('payload_mode'), 'empty');
  assert.equal(q.get('body_hash'), EMPTY_BODY_HASH);
  assert.equal(q.get('session_id'), 'cred-1');
  const canonical = ['GET', '/v1/ws/tool-integrations/abc', q.get('timestamp'), q.get('nonce'), 'empty', EMPTY_BODY_HASH, 'u1'].join('|');
  assert.equal(q.get('sig'), hmac(canonical));
});

test('integration id is a stable lowercase UUID per device and client', () => {
  const a = integrationId('dev', 'lights');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, integrationId('dev', 'lights'));
  assert.notEqual(a, integrationId('dev', 'other'));
  assert.notEqual(a, integrationId('dev2', 'lights'));
});

test('scope rejects admin, auth and tool-integration paths', () => {
  assert.throws(() => normalizeScope({ api: ['/v1/api/admin/'] }), /reserved/);
  assert.throws(() => normalizeScope({ api: ['/v1/api/auth/x'] }), /reserved/);
  assert.throws(() => normalizeScope({ api: ['/v1/api/data/user/tool-integrations'] }), /reserved/);
  assert.throws(() => normalizeScope({ api: ['/v1/api/data/'] }), /reserved/);
  assert.throws(() => normalizeScope({ api: ['/other'] }), /not a \/v1\/api/);
  assert.deepEqual(normalizeScope(undefined), { tools: false, pair: false, api: [] });
});

test('scope coverage and path checks', () => {
  const granted = normalizeScope({ tools: true, api: ['/v1/api/data/user/character'] });
  assert.ok(scopeCovers(granted, normalizeScope({ tools: true })));
  assert.ok(scopeCovers(granted, normalizeScope({ api: ['/v1/api/data/user/character/1'] })));
  assert.ok(!scopeCovers(normalizeScope({}), normalizeScope({ tools: true })));
  assert.ok(!scopeCovers(granted, normalizeScope({ api: ['/v1/api/data/user/memo'] })));
  assert.ok(allowsApiPath(granted, '/v1/api/data/user/character'));
  assert.ok(!allowsApiPath(granted, '/v1/api/admin/install'));
});

test('pairing is its own permission', () => {
  assert.equal(normalizeScope({ pair: true }).pair, true);
  assert.equal(normalizeScope({ pair: 'yes' }).pair, false);
  const toolsOnly = normalizeScope({ tools: true });
  assert.ok(!scopeCovers(toolsOnly, normalizeScope({ tools: true, pair: true })));
  assert.ok(scopeCovers(normalizeScope({ tools: true, pair: true }), toolsOnly));
  // An approval stored before the flag existed has no pair key.
  assert.ok(!scopeCovers({ tools: true, api: [] }, normalizeScope({ pair: true })));
});

const tool = (over = {}) => ({
  name: 'set_light', version: 'v1', description: 'Set a light.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  result_schema: { type: 'object', properties: {}, additionalProperties: false },
  risk: 'reversible', idempotent: true, confirmation_required: false, ...over,
});

test('catalog validation fills the default timeout and rejects bad tools', () => {
  assert.equal(validateTools([tool()])[0].timeout_ms, 5000);
  assert.throws(() => validateTools([tool({ name: 'Bad-Name' })]), /name/);
  assert.throws(() => validateTools([tool(), tool()]), /repeated/);
  assert.throws(() => validateTools([tool({ risk: 'danger' })]), /risk/);
  assert.throws(() => validateTools([tool({ timeout_ms: 50 })]), /timeout_ms/);
  assert.throws(() => validateTools([tool({ idempotent: undefined })]), /booleans/);
  assert.throws(() => validateTools(Array.from({ length: 17 }, (_, i) => tool({ name: `t${i}` }))), /at most/);
});

test('catalog validation applies clt01 object rules at every level, naming the path', () => {
  const obj = (properties, extra = {}) => ({ type: 'object', properties, additionalProperties: false, ...extra });
  const nested = obj({ color: obj({ r: { type: 'integer' } }, { required: ['r'] }), tags: { type: 'array', items: obj({}) } }, { required: ['color'] });
  assert.equal(validateTools([tool({ parameters: nested, result_schema: nested })]).length, 1);

  const open = { type: 'object', properties: {} };
  assert.throws(() => validateTools([tool({ parameters: open })]), /tools\[0\]\.parameters must set additionalProperties: false/);
  assert.throws(() => validateTools([tool({ parameters: obj({ color: open }) })]), /tools\[0\]\.parameters\.properties\.color must set additionalProperties: false/);
  assert.throws(() => validateTools([tool({ result_schema: obj({ list: { type: 'array', items: open } }) })]), /tools\[0\]\.result_schema\.properties\.list\.items must set additionalProperties: false/);
  assert.throws(() => validateTools([tool({ parameters: obj({ list: { type: 'array' } }) })]), /\.list must declare items/);
  assert.throws(() => validateTools([tool({ parameters: { type: 'object', additionalProperties: false } })]), /parameters must declare properties/);

  assert.throws(() => validateTools([tool({ parameters: obj({}, { required: null }) })]), /parameters\.required must be a list/);
  assert.throws(() => validateTools([tool({ parameters: obj({ a: { type: 'string' } }, { required: ['a', 'a'] }) })]), /required repeats a/);
  assert.throws(() => validateTools([tool({ parameters: obj({}, { required: ['b'] }) })]), /required names b, which is not in properties/);
});

test('a device answer over the size limit is refused, not buffered', async () => {
  const { DeviceClient, MAX_RESPONSE_BYTES } = await import('../../src/agentd/tools/device-client.mjs');
  const huge = new Uint8Array(MAX_RESPONSE_BYTES + 1);
  const fetchImpl = async () => new Response(huge, { status: 200 });
  await assert.rejects(new DeviceClient({ host: 'h', credential: cred, fetchImpl }).request('GET', '/v1/api/x'), { code: 'RESPONSE_TOO_LARGE' });
  const ok = async () => new Response(JSON.stringify({ success: true, data: { a: 1 } }), { status: 200 });
  assert.deepEqual(await new DeviceClient({ host: 'h', credential: cred, fetchImpl: ok }).request('GET', '/v1/api/x'), { a: 1 });
});

test('a device request signs the path without its query string, as clt01 verifies it', async () => {
  const { DeviceClient } = await import('../../src/agentd/tools/device-client.mjs');
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, headers: init.headers }); return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }); };
  await new DeviceClient({ host: 'h', credential: cred, fetchImpl }).request('GET', '/v1/api/data/user/chat/history?slot=1');
  const h = seen[0].headers;
  assert.equal(seen[0].url, 'http://h:8081/v1/api/data/user/chat/history?slot=1');
  const canonical = ['GET', '/v1/api/data/user/chat/history', h['X-Local-Timestamp'], h['X-Local-Nonce'], 'json', h['X-Local-Body-Hash'], cred.userId].join('|');
  assert.equal(h['X-Local-Sig'], hmac(canonical));
});
