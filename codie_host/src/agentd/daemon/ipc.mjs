import crypto from 'node:crypto';
import http from 'node:http';

// Thrown by a route handler to answer with `status` and `{ error: message }`
// (plus `code` when given: the stable codes of tool clients, spec §7).
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

// 'POST /sessions/:id/tools/:name' → { method, parts }.
// A route is a handler (needs the agentd token) or { client: true, handler }
// (needs the token of the client named by its :id). `maxBytes` on a route
// object replaces the server's body cap for that route.
function compile(key, route) {
  const [method, path] = key.split(' ');
  const { client = false, maxBytes, handler } = typeof route === 'function' ? { handler: route } : route;
  return { method, parts: path.split('/').slice(1), client, maxBytes, handler };
}

function match(route, method, parts) {
  if (route.method !== method || route.parts.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    const want = route.parts[i];
    if (want.startsWith(':')) params[want.slice(1)] = decodeURIComponent(parts[i]);
    else if (want !== parts[i]) return null;
  }
  return params;
}

function send(res, status, json) {
  if (res.writableEnded || res.destroyed) return;
  const data = JSON.stringify(json);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

// Loopback IPC for agentd: session processes call `routes` with
// `Authorization: Bearer <token>`; tool clients call their own client routes
// with the token `resolveClient(token)` knows them by. A handler gets the JSON
// body ({} for GET or an empty body) and `{ params, signal, client }`;
// `signal` aborts when the caller disconnects, so long polls can return
// early. The caller binds the server.
export function createIpcServer({ token, routes, resolveClient = () => undefined, maxBytes = 1 << 20 }) {
  const table = Object.entries(routes).map(([k, h]) => compile(k, h));
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = header => {
    const got = Buffer.from(header ?? '');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };
  const bearer = header => String(header ?? '').replace(/^Bearer /, '');

  return http.createServer((req, res) => {
    const isAgentd = authorized(req.headers.authorization);
    const client = isAgentd ? undefined : resolveClient(bearer(req.headers.authorization));
    if (!isAgentd && !client) {
      req.resume();
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    const parts = req.url.split('?')[0].split('/').slice(1);
    let route, params;
    try {
      for (const r of table) {
        params = match(r, req.method, parts);
        if (params) { route = r; break; }
      }
    } catch {
      req.resume();
      send(res, 400, { error: 'bad path' });
      return;
    }
    if (!route) {
      req.resume();
      send(res, 404, { error: 'not found' });
      return;
    }
    if (!isAgentd && !(route.client && params.id === client.id)) {
      req.resume();
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    const cap = route.maxBytes ?? maxBytes;
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size <= cap) { chunks.push(c); return; }
      // Over the cap: stop buffering, discard the rest, answer 413.
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.resume();
      send(res, 413, { error: 'body too large' });
    });
    req.on('end', async () => {
      let body = {};
      if (req.method !== 'GET' && size > 0) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
          send(res, 400, { error: 'invalid JSON' });
          return;
        }
      }
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      try {
        send(res, 200, (await route.handler(body, { params, signal: ac.signal, client })) ?? {});
      } catch (e) {
        if (Number.isInteger(e?.status)) {
          send(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
        } else {
          console.error(`[codie] ${req.method} ${req.url}`, e?.message ?? e);
          send(res, 500, { error: 'internal error' });
        }
      }
    });
  });
}
