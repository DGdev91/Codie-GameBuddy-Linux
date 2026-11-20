import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpcServer, HttpError } from '../../src/agentd/daemon/ipc.mjs';

const TOKEN = 'secret-token';

async function withServer(routes, fn, opts) {
  const server = createIpcServer({ token: TOKEN, routes, ...opts });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = p => `http://127.0.0.1:${server.address().port}${p}`;
  const call = (method, p, { body, token = TOKEN, signal } = {}) => fetch(url(p), {
    method,
    body,
    signal,
    headers: token == null ? {} : { authorization: `Bearer ${token}` },
  });
  try { await fn(call); } finally { server.closeAllConnections(); server.close(); }
}

test('matches path params and passes the parsed body', () => withServer({
  'POST /sessions/:id/tools/:name': async (body, { params }) => ({ params, body }),
}, async call => {
  const r = await call('POST', '/sessions/s%201/tools/codie_reply', { body: '{"a":1}' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { params: { id: 's 1', name: 'codie_reply' }, body: { a: 1 } });
}));

test('GET /status returns JSON; an empty body is {}', () => withServer({
  'GET /status': async body => ({ ok: true, body }),
  'POST /empty': async body => ({ body }),
}, async call => {
  const r = await call('GET', '/status');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, body: {} });
  assert.deepEqual(await (await call('POST', '/empty')).json(), { body: {} });
}));

test('a handler returning undefined → {}', () => withServer({ 'POST /x': async () => {} }, async call => {
  const r = await call('POST', '/x', { body: '{}' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {});
}));

test('wrong or missing token → 401, handler not called', async () => {
  let called = 0;
  await withServer({ 'GET /status': async () => { called++; return {}; } }, async call => {
    assert.equal((await call('GET', '/status', { token: 'nope' })).status, 401);
    assert.equal((await call('GET', '/status', { token: TOKEN + 'x' })).status, 401);
    assert.equal((await call('GET', '/status', { token: null })).status, 401);
  });
  assert.equal(called, 0);
});

test('unknown path or wrong method → 404', () => withServer({ 'GET /status': async () => ({}) }, async call => {
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('POST', '/status', { body: '{}' })).status, 404);
  assert.equal((await call('GET', '/status/extra')).status, 404);
}));

test('body over the cap → 413', () => withServer({ 'POST /x': async () => ({}) }, async call => {
  const r = await call('POST', '/x', { body: JSON.stringify({ x: 'y'.repeat(200) }) });
  assert.equal(r.status, 413);
}, { maxBytes: 100 }));

test('a route can raise its own body cap', () => withServer({
  'POST /big': { maxBytes: 1000, handler: async body => ({ n: body.x.length }) },
  'POST /small': async () => ({}),
}, async call => {
  const body = JSON.stringify({ x: 'y'.repeat(200) });
  const big = await call('POST', '/big', { body });
  assert.equal(big.status, 200);
  assert.deepEqual(await big.json(), { n: 200 });
  assert.equal((await call('POST', '/small', { body })).status, 413);
}, { maxBytes: 100 }));

test('non-JSON body → 400', () => withServer({ 'POST /x': async () => ({}) }, async call => {
  assert.equal((await call('POST', '/x', { body: 'nope' })).status, 400);
}));

test('HttpError sets the status and error text; other errors → 500', () => withServer({
  'POST /known': async () => { throw new HttpError(404, 'unknown session'); },
  'POST /boom': async () => { throw new Error('boom'); },
}, async call => {
  const r = await call('POST', '/known', { body: '{}' });
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'unknown session' });
  assert.equal((await call('POST', '/boom', { body: '{}' })).status, 500);
}));

test('client abort aborts the handler signal', async () => {
  let seen;
  const aborted = new Promise(r => { seen = r; });
  let entered;
  const inHandler = new Promise(r => { entered = r; });
  await withServer({
    'POST /wait': (body, { signal }) => new Promise(resolve => {
      entered();
      signal.addEventListener('abort', () => { seen(signal.aborted); resolve({}); });
    }),
  }, async call => {
    const ac = new AbortController();
    const req = call('POST', '/wait', { body: '{}', signal: ac.signal }).catch(e => e);
    await inHandler;
    ac.abort();
    assert.equal((await req).name, 'AbortError');
    assert.equal(await aborted, true);
  });
});
