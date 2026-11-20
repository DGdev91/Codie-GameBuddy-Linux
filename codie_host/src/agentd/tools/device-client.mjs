import { DEVICE_PROOF_PATH, PROOF_CONTEXT_HTTP, newChallenge, proofMatches, signedHeaders, signedMultipartHeaders } from './sign.mjs';

const TIMEOUT_MS = 10_000;

// A device answer that is not 2xx or carries success:false.
export class DeviceError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || '';
  }
}

// Failures that mean the device is not at its address (or not on the
// network): refused, timed out, no route, name not resolved.
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export function isNetworkError(e) {
  if (!e || e instanceof DeviceError) return false;
  if (e.name === 'TimeoutError') return true; // AbortSignal.timeout
  return NETWORK_CODES.has(e.code) || NETWORK_CODES.has(e.cause?.code);
}

// Device 401 codes that mean the stored credential is no longer good there
// (clt01 local_errors.go): revoked, or the device at that address is not the
// one it was issued by.
const CREDENTIAL_REJECTED = new Set(['LOCAL_SESSION_EXPIRED', 'LOCAL_USER_MISMATCH', 'LOCAL_SECRET_MISMATCH']);

export const isCredentialRejected = e => e instanceof DeviceError && e.status === 401 && CREDENTIAL_REJECTED.has(e.code);

// The paired address failed: nothing answers there, or something that does
// not know our credential (another device may have taken the address).
export const addressFailed = e => isNetworkError(e) || isCredentialRejected(e);

// No clt01 JSON answer comes near this; whatever answers at a device's
// address is not trusted to keep its body small.
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// The parsed JSON body, or null when it is not JSON; a body over `max` bytes
// is dropped unread past the limit.
export async function readJson(res, max = MAX_RESPONSE_BYTES) {
  if (!res.body) return null;
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new DeviceError(res.status, 'RESPONSE_TOO_LARGE', `device answer over ${max} bytes`);
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

async function parse(res) {
  if (res.status === 204) return null;
  const parsed = await readJson(res);
  if (!res.ok || parsed?.success === false) {
    throw new DeviceError(res.status, parsed?.code, parsed?.message || parsed?.error);
  }
  return parsed?.data ?? null;
}

async function call(base, method, path, body, credential, fetchImpl) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  // clt01 verifies the signature over URL.Path only (local_auth.go): no query.
  if (credential) Object.assign(headers, signedHeaders(method, path.split('?')[0], text, credential));
  return parse(await fetchImpl(base + path, {
    method,
    headers,
    body: text || undefined,
    redirect: 'error', // a followed redirect would resend the signature to another path
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
}

export const baseUrl = (host, port = 8081) => `http://${host}:${port}`;

// Signed calls on one device with one credential ({ secret, userId, id? }).
export class DeviceClient {
  constructor({ host, port = 8081, credential, fetchImpl = fetch }) {
    this.host = host;
    this.port = port;
    this.base = baseUrl(host, port);
    this.credential = credential;
    this.fetchImpl = fetchImpl;
  }

  // A pairing record that holds a client credential (codie_pair_confirm).
  static forPairing(record, fetchImpl = fetch) {
    return new DeviceClient({ host: record.host, port: record.port, fetchImpl,
      credential: { id: record.credentialId, secret: record.credentialSecret, userId: record.userId } });
  }

  request(method, path, body) {
    return call(this.base, method, path, body, this.credential, this.fetchImpl);
  }

  // multipart/form-data POST (chat turn images); fetch sets the boundary.
  async postForm(path, form) {
    return parse(await this.fetchImpl(this.base + path, {
      method: 'POST',
      headers: signedMultipartHeaders('POST', path, this.credential),
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
  }
}

// POST /v1/api/auth/credentials is master-only (master: { secret, userId });
// a 404 DeviceError means the firmware predates client credentials.
export async function issueClientCredential(host, port, master, label, fetchImpl = fetch) {
  const d = await call(baseUrl(host, port), 'POST', '/v1/api/auth/credentials', { label }, master, fetchImpl);
  if (typeof d?.id !== 'string' || typeof d?.secret !== 'string') throw new Error('credentials: malformed response');
  return { id: d.id, secret: d.secret };
}

// Whether whatever answers at host:port holds `credential` (sign.mjs
// deviceProof): false when it answers wrongly, not at all, or with an error.
export async function deviceHoldsCredential(host, port, credential, fetchImpl = fetch) {
  const challenge = newChallenge();
  try {
    const d = await new DeviceClient({ host, port, credential, fetchImpl }).request('GET', `${DEVICE_PROOF_PATH}?challenge=${challenge}`);
    return proofMatches(credential, PROOF_CONTEXT_HTTP, challenge, d?.proof);
  } catch {
    return false;
  }
}
