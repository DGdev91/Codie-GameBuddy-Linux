import { spawn as spawnChild } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { childEnv } from './child-env.mjs';

// The shared Codex app-server daemon's control sockets, newest first.
export function codexDaemonSockets(dir = path.join('/tmp', `codex-daemon-${process.getuid?.() ?? ''}`)) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const socks = [];
  for (const n of names) {
    try { const st = fs.statSync(path.join(dir, n)); if (st.isSocket()) socks.push({ p: path.join(dir, n), t: st.mtimeMs }); } catch { /* gone */ }
  }
  return socks.sort((a, b) => b.t - a.t).map(s => s.p);
}

// `codex app-server proxy` as a socket-like stream: node cannot connect to
// the daemon's AF_UNIX socket on Windows (EACCES), the proxy relays it over
// stdio. Emits connect / data / error / close like net.Socket.
export function codexProxy({ codex = 'codex', spawn = spawnChild } = {}) {
  const s = new EventEmitter();
  const child = spawn(codex, ['app-server', 'proxy'], { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv(), windowsHide: true });
  child.on('spawn', () => s.emit('connect'));
  child.on('error', e => s.emit('error', e));
  child.on('exit', () => s.emit('close'));
  child.stdout.on('data', d => s.emit('data', d));
  s.write = b => child.stdin.write(b);
  s.destroy = () => child.kill();
  return s;
}

// One JSON-RPC session with the daemon (WebSocket over its unix socket, or
// the proxy on Windows): initialize, then each call in order. Resolves to
// their results; rejects on a JSON-RPC error, a closed socket or `timeoutMs`.
// Without `socket`, each daemon socket is tried in turn (a stale one refuses).
export async function codexRpc(calls, { socket, timeoutMs = 5000, platform = process.platform, proxy = codexProxy, sockets = codexDaemonSockets } = {}) {
  if (!socket && platform === 'win32') return rpcOn(() => proxy(), calls, timeoutMs);
  const socks = socket ? [socket] : sockets();
  if (!socks.length) throw new Error('no Codex app-server daemon');
  let last;
  for (const sock of socks) {
    try { return await rpcOn(() => net.connect({ path: sock }), calls, timeoutMs); } catch (e) {
      last = e;
      if (!e.retrySocket) throw e; // never replay an RPC after a successful upgrade
    }
  }
  throw last;
}

function rpcOn(connect, calls, timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = connect();
    const results = [];
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let step = 0; // 0 = initialize, then 1..calls.length
    let partial = []; // a fragmented text message, until its final frame
    let finished = false;
    const finish = (err, v) => {
      if (finished) return;
      finished = true;
      if (err && !upgraded) err.retrySocket = true;
      clearTimeout(timer); c.destroy(); err ? reject(err) : resolve(v);
    };
    const timer = setTimeout(() => finish(new Error('Codex app-server timed out')), timeoutMs);
    const send = obj => {
      const payload = Buffer.from(JSON.stringify(obj));
      const mask = crypto.randomBytes(4);
      let head;
      if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
      else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
      c.write(Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
    };
    const next = () => {
      if (step === 0) { send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'codie-agentd', version: '1' }, capabilities: { experimentalApi: true } } }); return; }
      if (step > calls.length) { finish(null, results); return; }
      const { method, params = {} } = calls[step - 1];
      send({ id: step, method, params });
    };
    const onMessage = m => {
      if (m.id !== step) return; // not ours
      if (m.error) { finish(new Error(m.error.message ?? 'Codex app-server error')); return; }
      if (step === 0) send({ method: 'initialized' });
      else results.push(m.result);
      step++;
      next();
    };
    c.on('connect', () => c.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    c.on('error', e => finish(e));
    c.on('close', () => finish(new Error('Codex app-server closed the connection')));
    c.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        if (!/^HTTP\/1\.1 101/.test(buf.subarray(0, i).toString())) { finish(new Error('Codex app-server refused the upgrade')); return; }
        buf = buf.subarray(i + 4);
        upgraded = true;
        next();
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const fin = (buf[0] & 0x80) !== 0;
        const op = buf[0] & 0x0f;
        const data = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 1 || op === 0) {
          partial.push(data);
          if (!fin) continue;
          const text = Buffer.concat(partial).toString('utf8');
          partial = [];
          let m;
          try { m = JSON.parse(text); } catch { continue; } // not JSON-RPC
          if (m.method === undefined) onMessage(m); // a server request/notification is not our answer
        } else if (op === 8) { finish(new Error('Codex app-server closed the connection')); return; }
      }
    });
  });
}
