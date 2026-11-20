import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DEVICE_PROOF_PATH, PROOF_CONTEXT_HTTP, deviceProof, proofContextWs } from '../../../src/agentd/tools/sign.mjs';

// A minimal clt01 for tests: signed tool-integrations HTTP routes, the
// /v1/ws/tool-integrations/<id>/executor WebSocket (signatures verified like sign.go), and
// the active slot plus tts/utterances (spoken texts land in `utterances`),
// the character route and image chat turns (`turns`; `setChat` shapes the
// answer or blocks admission).
// and agent/results (task answers and the agent's own words land in
// `agentResults`); `spoken` lists both in the order they arrived.
// It answers device-proof challenges (sign.mjs deviceProof); an `impostor`
// is a LAN host without the credential: it takes any signature and cannot
// answer a challenge.
export async function startFakeDevice({ credential, slot = 2, impostor = false }) {
  const integrations = new Map();
  const utterances = [];
  const agentResults = [];
  const spoken = [];
  const state = { active: 'Idle' };
  const turns = [];
  const chat = { block: null, assistantText: 'Nice jump!', pollsToFinish: 2 };
  const deny = { status: 0, code: '' };
  const lag = { put: 0 };
  const results = [];
  const sockets = new Map();
  const hmac = s => crypto.createHmac('sha256', credential.secret).update(s).digest('hex');

  // Like clt01: the signature covers the decoded URL.Path.
  const prover = impostor ? { secret: 'not-the-credential' } : credential;
  const verify = (method, path, h) => {
    if (impostor) return true;
    const canonical = [method, decodeURIComponent(path), h.timestamp, h.nonce, h.payloadMode, h.bodyHash, h.userId].join('|');
    return h.sessionId === credential.id && h.userId === credential.userId && h.sig === hmac(canonical);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const path = req.url.split('?')[0];
      const h = req.headers;
      const ok = verify(req.method, path, {
        sig: h['x-local-sig'], nonce: h['x-local-nonce'], timestamp: h['x-local-timestamp'],
        payloadMode: h['x-local-payload-mode'], bodyHash: h['x-local-body-hash'], userId: h['x-local-user-id'], sessionId: h['x-local-session-id'],
      });
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!ok) return reply(401, { success: false, code: 'INVALID_SIGNATURE' });
      if (deny.status) return reply(deny.status, { success: false, code: deny.code });
      if (req.method === 'GET' && path === DEVICE_PROOF_PATH) {
        const challenge = new URL(req.url, 'http://x').searchParams.get('challenge') ?? '';
        return reply(200, { success: true, data: { proof: deviceProof(prover, PROOF_CONTEXT_HTTP, challenge) } });
      }
      if (req.method === 'GET' && path === '/v1/api/data/user/ai/backend') return reply(200, { success: true, data: { active_state: state.active } });
      if (req.method === 'GET' && path === '/v1/api/data/user/slot') return reply(200, { success: true, data: { slot_number: slot } });
      if (req.method === 'GET' && path === '/v1/api/data/user/character') return reply(200, { success: true, data: { name: 'Codie' } });
      if (req.method === 'POST' && path === '/v1/api/data/user/chat/turns') {
        // Like local_auth.go: multipart is signed over the literal UNSIGNED-PAYLOAD.
        if (h['x-local-payload-mode'] !== 'multipart' || h['x-local-body-hash'] !== 'UNSIGNED-PAYLOAD') return reply(401, { success: false, code: 'INVALID_SIGNATURE' });
        if (chat.block) return reply(409, { success: false, code: chat.block, message: 'Chat API admission blocked.' });
        const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': h['content-type'] } }).formData();
        const request = JSON.parse(form.get('request'));
        if (request.slot !== slot) return reply(409, { success: false, code: 'SLOT_MISMATCH' });
        const file = form.get('image');
        const turn = { turn_id: `turn-${turns.length + 1}`, request, image: Buffer.from(await file.arrayBuffer()), imageType: file.type, polls: 0 };
        turns.push(turn);
        return reply(200, { success: true, data: { turn_id: turn.turn_id, state: 'thinking', assistant_text: '', error: null } });
      }
      const turnPath = path.match(/^\/v1\/api\/data\/user\/chat\/turns\/([^/]+)$/);
      if (req.method === 'GET' && turnPath) {
        const turn = turns.find(t => t.turn_id === turnPath[1]);
        if (!turn) return reply(404, { success: false, code: 'TURN_NOT_FOUND' });
        turn.polls++;
        const done = turn.polls >= chat.pollsToFinish;
        return reply(200, { success: true, data: { turn_id: turn.turn_id, state: done ? 'completed' : 'thinking', assistant_text: done ? chat.assistantText : '', error: null } });
      }
      if (req.method === 'POST' && path === '/v1/api/data/user/agent/results') {
        const { text } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        agentResults.push(text);
        spoken.push(text);
        return reply(202, { success: true });
      }
      if (req.method === 'POST' && path === '/v1/api/data/user/tts/utterances') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.slot !== slot) return reply(409, { success: false, code: 'SLOT_MISMATCH' });
        utterances.push(body.text);
        spoken.push(body.text);
        return reply(202, { success: true, data: { utterance_id: body.request_id, state: 'queued' } });
      }
      const m = path.match(/^\/v1\/api\/data\/user\/tool-integrations\/([0-9a-f-]+)$/);
      if (!m) return reply(404, { success: false, code: 'NOT_FOUND' });
      const id = m[1];
      const current = integrations.get(id);
      if (req.method === 'GET') return current ? reply(200, { success: true, data: current }) : reply(404, { success: false, code: 'NOT_FOUND' });
      if (req.method === 'PUT') {
        if (lag.put) await new Promise(r => setTimeout(r, lag.put));
        const latest = integrations.get(id); // the integration as it is once the delayed PUT lands
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!['v1', 'v2'].includes(body.protocol_version)) return reply(400, { success: false, code: 'UNSUPPORTED_PROTOCOL_VERSION' });
        if (body.expected_revision !== (latest?.revision ?? 0)) return reply(409, { success: false, code: 'INTEGRATION_REVISION_CONFLICT' });
        const next = { integration_id: id, name: body.name, enabled: body.enabled, tools: body.tools, revision: (latest?.revision ?? 0) + 1 };
        integrations.set(id, next);
        sockets.get(id)?.close();
        return reply(latest ? 200 : 201, { success: true, data: next });
      }
      if (req.method === 'DELETE') { integrations.delete(id); res.writeHead(204); return res.end(); }
      return reply(405, { success: false });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/v1\/ws\/tool-integrations\/([0-9a-f-]+)\/executor$/);
    const q = url.searchParams;
    const ok = m && integrations.has(m[1]) && verify('GET', url.pathname, {
      sig: q.get('sig'), nonce: q.get('nonce'), timestamp: q.get('timestamp'), payloadMode: q.get('payload_mode'),
      bodyHash: q.get('body_hash'), userId: q.get('user_id'), sessionId: q.get('session_id'),
    });
    if (!ok) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const id = m[1];
      sockets.set(id, ws);
      ws.on('message', raw => results.push(JSON.parse(String(raw))));
      const proof = deviceProof(prover, proofContextWs(id), q.get('challenge') ?? '');
      ws.send(JSON.stringify({ type: 'ready', data: { protocol_version: 'v1', integration_id: id, revision: integrations.get(id).revision, proof } }));
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    integrations,
    results,
    utterances,
    agentResults,
    spoken,
    turns,
    setChat: patch => { Object.assign(chat, patch); },
    // Every signed request answers with this status and code until cleared with null.
    setDeny: (status, code = '') => { Object.assign(deny, { status: status ?? 0, code }); },
    // Catalog PUTs take effect (and answer) only after `ms`.
    setPutDelay: ms => { lag.put = ms; },
    setActiveState: v => { state.active = v; },
    invoke(id, data) { sockets.get(id).send(JSON.stringify({ type: 'invoke', data })); },
    connected: id => sockets.get(id)?.readyState === 1,
    close: () => new Promise(r => { for (const ws of sockets.values()) ws.terminate(); wss.close(); server.close(r); }),
  };
}
