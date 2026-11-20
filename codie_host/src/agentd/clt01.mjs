import { readJson } from './tools/device-client.mjs';

export { issueClientCredential } from './tools/device-client.mjs';

// clt01 pairing endpoints (unsigned, on clt01's LocalAuthGuard bypass list).
// pair/confirm returns the device master secret (local_secret): used once to
// issue this computer's client credential, never stored.
const TIMEOUT_MS = 10_000;

// Resolves to the parsed JSON body (or null); throws on HTTP or business failure.
async function send(method, host, port, path, body) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`http://${host}:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: json,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const parsed = await readJson(res);
  if (!res.ok || parsed?.success === false) {
    const err = new Error(parsed?.message || parsed?.error || `HTTP ${res.status}`);
    if (parsed?.code !== undefined) err.code = parsed.code;
    throw err;
  }
  return parsed;
}

async function post(host, port, path, body) {
  const data = (await send('POST', host, port, path, body))?.data;
  if (!data || typeof data !== 'object') throw new Error(`${path}: malformed response`);
  return data;
}

export async function pairRequest(host, port) {
  const d = await post(host, port, '/v1/api/auth/pair/request', {});
  if (typeof d.challenge_id !== 'string' || typeof d.expires_at_ms !== 'number') throw new Error('pair/request: malformed response');
  return { challengeId: d.challenge_id, expiresAtMs: d.expires_at_ms };
}

export async function pairConfirm(host, port, challengeId, pairingCode) {
  const d = await post(host, port, '/v1/api/auth/pair/confirm', { challenge_id: challengeId, pairing_code: pairingCode });
  if (typeof d.local_secret !== 'string' || !d.local_secret) throw new Error('pair/confirm: malformed response');
  return {
    deviceId: typeof d.device_id === 'string' ? d.device_id : '',
    name: typeof d.name === 'string' ? d.name : '',
    localSecret: d.local_secret,
  };
}

// Best-effort: lets the device drop its on-screen code early.
export async function pairCancel(host, port, challengeId) {
  try { await post(host, port, '/v1/api/auth/pair/cancel', { challenge_id: challengeId }); } catch { /* ignore */ }
}

// The identity signed calls use: pair/confirm's local_secret plus the
// device's user_id (bootstrap). Throws when either is missing.
export async function deviceAuth(host, port, localSecret) {
  if (!localSecret) throw new Error('missing local_secret');
  let userId;
  try {
    userId = (await send('GET', host, port, '/v1/api/auth/bootstrap'))?.data?.user_id;
  } catch (e) {
    throw new Error(`bootstrap: ${e?.message ?? e}`, { cause: e });
  }
  if (typeof userId !== 'string' || !userId) {
    throw Object.assign(new Error('bootstrap: device not signed in (no user_id)'), { code: 'DEVICE_NOT_SIGNED_IN' });
  }
  return { secret: localSecret, userId };
}
