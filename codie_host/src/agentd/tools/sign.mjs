import crypto from 'node:crypto';

// clt01 LocalAuthGuard request signature (src/framework/auth/sign.go):
// HMAC-SHA256(secret, method|path|timestamp|nonce|payloadMode|bodyHash|userId).
// A client credential also sends its id as X-Local-Session-Id.

export const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex');
export const EMPTY_BODY_HASH = sha256Hex('');

function sign({ method, path, payloadMode, bodyHash, credential, now }) {
  const timestamp = String(Math.floor(now / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = [method, path, timestamp, nonce, payloadMode, bodyHash, credential.userId].join('|');
  const sig = crypto.createHmac('sha256', credential.secret).update(canonical).digest('hex');
  return { sig, timestamp, nonce };
}

// Multipart bodies are not hashed: clt01 takes this literal (local_auth.go).
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function headersFor({ method, path, payloadMode, bodyHash, credential, now }) {
  const { sig, timestamp, nonce } = sign({ method, path, payloadMode, bodyHash, credential, now });
  const headers = {
    'X-Local-Sig': sig,
    'X-Local-Nonce': nonce,
    'X-Local-Timestamp': timestamp,
    'X-Local-Payload-Mode': payloadMode,
    'X-Local-Body-Hash': bodyHash,
    'X-Local-User-Id': credential.userId,
  };
  if (credential.id) headers['X-Local-Session-Id'] = credential.id;
  return headers;
}

// credential: { secret, userId, id? } — id is set for a client credential.
export function signedHeaders(method, path, bodyText, credential, now = Date.now()) {
  return headersFor({ method, path, payloadMode: 'json', bodyHash: sha256Hex(bodyText ?? ''), credential, now });
}

export function signedMultipartHeaders(method, path, credential, now = Date.now()) {
  return headersFor({ method, path, payloadMode: 'multipart', bodyHash: UNSIGNED_PAYLOAD, credential, now });
}

// WebSocket upgrades carry the signature in the query (ws_channel_gin.go):
// GET, the real path, payload mode "empty" and the empty-body hash.
export function signedWsQuery(path, credential, now = Date.now()) {
  const { sig, timestamp, nonce } = sign({
    method: 'GET', path, payloadMode: 'empty', bodyHash: EMPTY_BODY_HASH, credential, now,
  });
  const query = new URLSearchParams({
    sig, timestamp, nonce, payload_mode: 'empty', body_hash: EMPTY_BODY_HASH, user_id: credential.userId,
  });
  if (credential.id) query.set('session_id', credential.id);
  return query;
}

// The device's side of the trust: agentd signs every call, but anything at a
// device's address could answer one. A device proves it holds the
// credential by answering a fresh random challenge with
// HMAC-SHA256(secret, codie-device-proof|v1|<context>|<challenge>), where
// context is ws:<integration id> for a tool-integration socket's `ready`
// and http for GET DEVICE_PROOF_PATH?challenge=… .
export const DEVICE_PROOF_PATH = '/v1/api/data/user/device-proof';
export const PROOF_CONTEXT_HTTP = 'http';
export const proofContextWs = integrationId => `ws:${integrationId}`;

export const newChallenge = () => crypto.randomBytes(16).toString('hex');

export function deviceProof(credential, context, challenge) {
  return crypto.createHmac('sha256', credential.secret).update(['codie-device-proof', 'v1', context, challenge].join('|')).digest('hex');
}

export function proofMatches(credential, context, challenge, proof) {
  if (typeof proof !== 'string') return false;
  const want = Buffer.from(deviceProof(credential, context, challenge));
  const got = Buffer.from(proof);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
