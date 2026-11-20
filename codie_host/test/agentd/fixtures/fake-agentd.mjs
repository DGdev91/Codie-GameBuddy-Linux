// Stand-in for codie-agentd in ensure.test.mjs: writes <CODIE_HOME>/agentd.json
// and answers GET /status and POST /shutdown, nothing else. FAKE_VERSION sets
// the reported version, FAKE_DELAY_MS delays writing agentd.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { writeJsonAtomic } from '../../../src/agentd/store.mjs';

const home = process.env.CODIE_HOME;
const version = Number(process.env.FAKE_VERSION || 1);
const delayMs = Number(process.env.FAKE_DELAY_MS || 0);
const file = path.join(home, 'agentd.json');
const token = crypto.randomBytes(8).toString('hex');

const server = http.createServer((req, res) => {
  const reply = (status, json) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
  if (req.method === 'GET' && req.url === '/status') return reply(200, { version, pid: process.pid });
  if (req.method === 'POST' && req.url === '/shutdown') {
    reply(200, { ok: true });
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
    } catch { /* already gone */ }
    setImmediate(() => process.exit(0));
    return;
  }
  reply(404, { error: 'not found' });
});

// Never outlive the test run, even if the test that spawned us failed.
setTimeout(() => process.exit(0), 30_000);

server.listen(0, '127.0.0.1', () => {
  setTimeout(() => {
    writeJsonAtomic(file, { port: server.address().port, token, pid: process.pid, version, cwd: process.cwd() });
  }, delayMs);
});
