import { randomUUID } from 'node:crypto';
import { ClientError } from './clients.mjs';

// Image + text chat turns on the device (clt01 chat_turn_gin.go): one
// multipart POST on the active slot, then polling until a final state.

export const CHAT_TURNS_PATH = '/v1/api/data/user/chat/turns';
export const MAX_IMAGE_BYTES = 1 << 20; // clt01 refuses larger attachments
const MAX_TEXT_CHARS = 16_000;
const DEFAULT_WAIT_MS = 30_000;
// Long enough for a spoken turn to be heard to its end (a client that wants
// that asks for it); also the most a turn the device never ends is waited on.
export const MAX_WAIT_MS = 180_000;
const POLL_MS = 300;
const FINAL = new Set(['completed', 'failed', 'cancelled']);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// How much of the turn the device keeps (clt01 chat_turn_gin.go): 'full' keeps it
// in chat history and its context maintenance (state, summary, memory, diary);
// 'chat' keeps the history only; 'none' keeps nothing, the reply is only in
// assistant_text.
const RETENTIONS = new Set(['full', 'chat', 'none']);
// Whether the device's model may call tools in the turn: 'all' offers the
// device's tools and the ext.* tools online, 'none' offers no tool at all.
const TOOLS = new Set(['all', 'none']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const invalid = message => new ClientError(400, 'INVALID_ARGUMENT', message);

function imageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  return null;
}

// The IPC body → a validated request. The client compresses: the daemon
// does not re-encode images.
export function parseTurnRequest(body) {
  const speech = body?.speech ?? 'device';
  if (speech !== 'device' && speech !== 'none') throw invalid('speech must be device or none');
  const interrupt = body?.interrupt ?? true;
  if (typeof interrupt !== 'boolean') throw invalid('interrupt must be true or false');
  const retention = body?.retention ?? 'full';
  if (!RETENTIONS.has(retention)) throw invalid('retention must be full, chat or none');
  const tools = body?.tools ?? 'all';
  if (!TOOLS.has(tools)) throw invalid('tools must be all or none');
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if ([...text].length > MAX_TEXT_CHARS) throw invalid(`text must not exceed ${MAX_TEXT_CHARS} characters`);
  if (typeof body?.image !== 'string' || !body.image) throw invalid('image must be a base64 JPEG or PNG');
  const image = Buffer.from(body.image, 'base64');
  const type = imageType(image);
  if (!type) throw invalid('image must be a base64 JPEG or PNG');
  if (image.length > MAX_IMAGE_BYTES) throw new ClientError(413, 'IMAGE_TOO_LARGE', 'image must not exceed 1 MiB; compress it first');
  const waitMs = Math.min(Math.max(Number(body?.wait_ms ?? DEFAULT_WAIT_MS) || 0, 0), MAX_WAIT_MS);
  return { image, type, text, speech, interrupt, retention, tools, waitMs };
}

const view = s => ({ turn_id: s?.turn_id ?? '', state: s?.state ?? '', assistant_text: s?.assistant_text ?? '', error: s?.error ?? null });

export async function runChatTurn(device, req, { signal, now = Date.now, pollMs = POLL_MS } = {}) {
  const slot = (await device.request('GET', '/v1/api/data/user/slot'))?.slot_number;
  const input = req.text ? { type: 'image_text', text: req.text } : { type: 'image_text' };
  const form = new FormData();
  // interrupt: false lets the device refuse the turn (DEVICE_BUSY) instead of ending
  // the user's conversation. It, retention and tools are sent only off their defaults:
  // older firmware rejects unknown fields.
  const request = {
    request_id: randomUUID(), slot, input, output: { speech: req.speech },
    ...(req.interrupt === false && { interrupt: false }),
    ...(req.retention !== 'full' && { retention: req.retention }),
    ...(req.tools !== 'all' && { tools: req.tools }),
  };
  form.set('request', JSON.stringify(request));
  form.set('image', new Blob([req.image], { type: req.type }), req.type === 'image/png' ? 'screen.png' : 'screen.jpg');
  let snap = await device.postForm(CHAT_TURNS_PATH, form);
  const deadline = now() + req.waitMs;
  while (!FINAL.has(snap?.state) && now() < deadline && !signal?.aborted) {
    await sleep(pollMs);
    snap = await device.request('GET', `${CHAT_TURNS_PATH}/${encodeURIComponent(snap.turn_id)}`);
  }
  return view(snap);
}
