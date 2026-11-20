import assert from 'node:assert/strict';
import test from 'node:test';
import { TURN_WAIT_MAX_MS } from '../../sdk/index.mjs';
import { CHAT_TURNS_PATH, MAX_IMAGE_BYTES, parseTurnRequest, runChatTurn } from '../../src/agentd/tools/chat-turns.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const b64 = buf => buf.toString('base64');

const codeOf = fn => { try { fn(); } catch (e) { return [e.status, e.code]; } return null; };

test('parseTurnRequest accepts JPEG and PNG with defaults', () => {
  const r = parseTurnRequest({ image: b64(JPEG), text: '  look  ' });
  assert.deepEqual([r.type, r.text, r.speech, r.waitMs], ['image/jpeg', 'look', 'device', 30_000]);
  assert.ok(r.image.equals(JPEG));
  assert.equal(parseTurnRequest({ image: b64(PNG), speech: 'none', wait_ms: 999_999 }).waitMs, TURN_WAIT_MAX_MS);
  assert.equal(parseTurnRequest({ image: b64(PNG) }).type, 'image/png');
});

test('a client may wait up to 3 minutes, so a long spoken turn is heard to its end', () => {
  assert.equal(TURN_WAIT_MAX_MS, 180_000);
  assert.equal(parseTurnRequest({ image: b64(JPEG), wait_ms: TURN_WAIT_MAX_MS }).waitMs, TURN_WAIT_MAX_MS);
});

test('parseTurnRequest refuses bad input', () => {
  assert.deepEqual(codeOf(() => parseTurnRequest({})), [400, 'INVALID_ARGUMENT']);
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(Buffer.from('GIF89a')) })), [400, 'INVALID_ARGUMENT']);
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(JPEG), speech: 'client' })), [400, 'INVALID_ARGUMENT']);
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(JPEG), text: 'x'.repeat(16_001) })), [400, 'INVALID_ARGUMENT']);
  const big = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(big) })), [413, 'IMAGE_TOO_LARGE']);
});

function fakeDevice({ finishAfter = 2, slot = 3 } = {}) {
  const calls = [];
  let polls = 0;
  return {
    calls,
    async request(method, path) {
      calls.push([method, path]);
      if (path === '/v1/api/data/user/slot') return { slot_number: slot };
      polls++;
      return polls >= finishAfter
        ? { turn_id: 't1', state: 'completed', assistant_text: 'Nice jump!', error: null }
        : { turn_id: 't1', state: 'thinking', assistant_text: '' };
    },
    async postForm(path, form) {
      calls.push(['FORM', path, JSON.parse(form.get('request')), form.get('image')]);
      return { turn_id: 't1', state: 'thinking', assistant_text: '' };
    },
  };
}

test('runChatTurn posts on the active slot and polls to a final state', async () => {
  const device = fakeDevice();
  const req = parseTurnRequest({ image: b64(JPEG), text: 'what now?', speech: 'none' });
  const r = await runChatTurn(device, req, { pollMs: 1 });
  assert.deepEqual(r, { turn_id: 't1', state: 'completed', assistant_text: 'Nice jump!', error: null });
  const [, path, request, image] = device.calls[1];
  assert.equal(path, CHAT_TURNS_PATH);
  assert.equal(request.slot, 3);
  assert.match(request.request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(request.input, { type: 'image_text', text: 'what now?' });
  assert.deepEqual(request.output, { speech: 'none' });
  assert.equal(image.type, 'image/jpeg');
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(JPEG));
  assert.deepEqual(device.calls.slice(2).map(c => c[1]), [`${CHAT_TURNS_PATH}/t1`, `${CHAT_TURNS_PATH}/t1`]);
});

test('runChatTurn omits empty text and returns the last state when wait runs out', async () => {
  const device = fakeDevice({ finishAfter: Infinity });
  let clock = 0;
  const req = parseTurnRequest({ image: b64(JPEG), wait_ms: 100 });
  const r = await runChatTurn(device, req, { pollMs: 1, now: () => (clock += 40) });
  assert.equal(r.state, 'thinking');
  assert.deepEqual(device.calls[1][2].input, { type: 'image_text' });
});

test('parseTurnRequest takes interrupt as a boolean, true by default', () => {
  assert.equal(parseTurnRequest({ image: b64(JPEG) }).interrupt, true);
  assert.equal(parseTurnRequest({ image: b64(JPEG), interrupt: false }).interrupt, false);
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(JPEG), interrupt: 'no' })), [400, 'INVALID_ARGUMENT']);
});

// Older device firmware rejects unknown request fields: send interrupt only when it is false.
test('runChatTurn sends interrupt only when it is false', async () => {
  const device = fakeDevice();
  await runChatTurn(device, parseTurnRequest({ image: b64(JPEG) }), { pollMs: 1 });
  assert.equal('interrupt' in device.calls[1][2], false);
  const quiet = fakeDevice();
  await runChatTurn(quiet, parseTurnRequest({ image: b64(JPEG), interrupt: false }), { pollMs: 1 });
  assert.equal(quiet.calls[1][2].interrupt, false);
});

test('parseTurnRequest takes retention full, chat or none, full by default', () => {
  assert.equal(parseTurnRequest({ image: b64(JPEG) }).retention, 'full');
  assert.equal(parseTurnRequest({ image: b64(JPEG), retention: 'none' }).retention, 'none');
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(JPEG), retention: 'some' })), [400, 'INVALID_ARGUMENT']);
});

test('parseTurnRequest takes tools all or none, all by default', () => {
  assert.equal(parseTurnRequest({ image: b64(JPEG) }).tools, 'all');
  assert.equal(parseTurnRequest({ image: b64(JPEG), tools: 'none' }).tools, 'none');
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(JPEG), tools: 'some' })), [400, 'INVALID_ARGUMENT']);
});

test('runChatTurn sends tools only when it is none', async () => {
  const device = fakeDevice();
  await runChatTurn(device, parseTurnRequest({ image: b64(JPEG) }), { pollMs: 1 });
  assert.equal('tools' in device.calls[1][2], false);
  const bare = fakeDevice();
  await runChatTurn(bare, parseTurnRequest({ image: b64(JPEG), tools: 'none' }), { pollMs: 1 });
  assert.equal(bare.calls[1][2].tools, 'none');
});

// Older device firmware rejects unknown request fields: send retention only off its default.
test('runChatTurn sends retention only when it is not full', async () => {
  const device = fakeDevice();
  await runChatTurn(device, parseTurnRequest({ image: b64(JPEG), retention: 'full' }), { pollMs: 1 });
  assert.equal('retention' in device.calls[1][2], false);
  const quiet = fakeDevice();
  await runChatTurn(quiet, parseTurnRequest({ image: b64(JPEG), retention: 'none' }), { pollMs: 1 });
  assert.equal(quiet.calls[1][2].retention, 'none');
});
