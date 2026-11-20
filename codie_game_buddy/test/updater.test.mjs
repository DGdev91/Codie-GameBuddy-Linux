import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { translatorFor } from '../src/main/i18n.mjs';
import { createUpdater, updateMenuItem } from '../src/main/updater.mjs';

const httpError = statusCode => Object.assign(new Error(`${statusCode}`), { statusCode });

// A stand-in for electron-updater's autoUpdater: `results` are what each
// checkForUpdates() call returns or throws, in order.
function fakeAutoUpdater(results) {
  const u = new EventEmitter();
  u.checks = [];
  u.installs = [];
  u.checkForUpdates = async () => {
    u.checks.push({ headers: u.requestHeaders });
    const r = results.shift();
    if (r instanceof Error) {
      u.emit('error', r); // like electron-updater: emitted, then thrown
      throw r;
    }
    return r;
  };
  u.quitAndInstall = (silent, runAfter) => u.installs.push({ silent, runAfter });
  return u;
}

const available = version => ({ isUpdateAvailable: true, updateInfo: { version }, downloadPromise: Promise.resolve([]) });
const latest = { isUpdateAvailable: false, updateInfo: { version: '0.1.0' } };

function setup(results, { loginResult = true, headers = {} } = {}) {
  const autoUpdater = fakeAutoUpdater(results);
  const calls = { login: 0, stop: 0, notes: [], views: [] };
  const feed = { headers: async () => headers, login: async () => { calls.login++; return loginResult; } };
  const updater = createUpdater({
    autoUpdater, feed,
    stopDaemon: async () => { calls.stop++; },
    notify: (kind, version) => calls.notes.push(version ? `${kind}:${version}` : kind),
    onChange: view => calls.views.push(view.status),
  });
  return { autoUpdater, calls, updater };
}

test('installs only on request: no install on quit, no surprise download dialogs', () => {
  const { autoUpdater } = setup([]);
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
});

test('a newer version is downloaded and offered', async () => {
  const { calls, updater } = setup([available('0.1.1')]);
  const view = await updater.check();
  assert.deepEqual(view, { status: 'ready', version: '0.1.1' });
  assert.deepEqual(calls.views, ['checking', 'downloading', 'ready']);
  assert.deepEqual(calls.notes, ['ready:0.1.1']);
});

test('download progress is shown in whole percent', async () => {
  let release;
  const pending = { isUpdateAvailable: true, updateInfo: { version: '0.2.0' }, downloadPromise: new Promise(r => { release = r; }) };
  const { autoUpdater, updater } = setup([pending]);
  const done = updater.check();
  await new Promise(setImmediate);
  autoUpdater.emit('download-progress', { percent: 41.7 });
  assert.deepEqual(updater.view, { status: 'downloading', version: '0.2.0', percent: 41 });
  release([]);
  assert.equal((await done).status, 'ready');
});

test('up to date: only a check the user asked for says so', async () => {
  const quiet = setup([latest]);
  assert.deepEqual(await quiet.updater.check(), { status: 'latest' });
  assert.deepEqual(quiet.calls.notes, []);

  const asked = setup([latest]);
  await asked.updater.check({ interactive: true });
  assert.deepEqual(asked.calls.notes, ['latest']);
});

test('the feed sign-in headers are sent with every check', async () => {
  const { autoUpdater, updater } = setup([latest], { headers: { Cookie: 'a=1' } });
  await updater.check();
  assert.deepEqual(autoUpdater.checks, [{ headers: { Cookie: 'a=1' } }]);
});

test('a feed that wants a sign-in: a background check waits for the user, no window pops up', async () => {
  const { calls, updater } = setup([httpError(401)]);
  assert.deepEqual(await updater.check(), { status: 'login' });
  assert.equal(calls.login, 0);
});

test('a feed that wants a sign-in: a check the user asked for signs in and tries again', async () => {
  const { autoUpdater, calls, updater } = setup([httpError(401), available('0.1.1')]);
  assert.deepEqual(await updater.check({ interactive: true }), { status: 'ready', version: '0.1.1' });
  assert.equal(calls.login, 1);
  assert.equal(autoUpdater.checks.length, 2);
});

test('a sign-in the user closed, or that still gets 403, leaves the check waiting for a sign-in', async () => {
  const closed = setup([httpError(401)], { loginResult: false });
  assert.deepEqual(await closed.updater.check({ interactive: true }), { status: 'login' });

  const refused = setup([httpError(401), httpError(403)]);
  assert.deepEqual(await refused.updater.check({ interactive: true }), { status: 'login' });
});

test('other failures are reported, and only a check the user asked for notifies', async () => {
  const quiet = setup([new Error('net::ERR_NAME_NOT_RESOLVED')]);
  assert.deepEqual(await quiet.updater.check(), { status: 'error', error: 'net::ERR_NAME_NOT_RESOLVED' });
  assert.deepEqual(quiet.calls.notes, []);

  const asked = setup([httpError(404)]);
  await asked.updater.check({ interactive: true });
  assert.deepEqual(asked.calls.notes, ['error:404']);
});

test('checks do not overlap, and a downloaded update is not checked again', async () => {
  const { autoUpdater, updater } = setup([available('0.1.1')]);
  const [a, b] = await Promise.all([updater.check(), updater.check()]);
  assert.equal(a, b);
  await updater.check();
  assert.equal(autoUpdater.checks.length, 1);
});

test('install stops codie-agentd first, then installs silently and restarts the app', async () => {
  const { autoUpdater, calls, updater } = setup([available('0.1.1')]);
  await updater.install();
  assert.deepEqual(autoUpdater.installs, [], 'nothing downloaded yet');
  await updater.check();
  await updater.install();
  assert.equal(calls.stop, 1);
  assert.deepEqual(autoUpdater.installs, [{ silent: true, runAfter: true }]);
});

test('install goes ahead when codie-agentd cannot be stopped: the installer closes it', async () => {
  const autoUpdater = fakeAutoUpdater([available('0.1.1')]);
  const updater = createUpdater({
    autoUpdater, feed: { headers: async () => ({}), login: async () => true },
    stopDaemon: async () => { throw new Error('EPERM'); },
  });
  await updater.check();
  await updater.install();
  assert.equal(autoUpdater.installs.length, 1);
});

test('the tray entry follows the update state', () => {
  const t = translatorFor('en');
  const item = view => updateMenuItem(view, t, '0.1.0');
  assert.deepEqual(item({ status: 'idle' }), { label: 'Check for updates (version 0.1.0)', action: 'check' });
  assert.deepEqual(item({ status: 'error', error: 'x' }), { label: 'Check for updates (version 0.1.0)', action: 'check' });
  assert.deepEqual(item({ status: 'checking' }), { label: 'Checking for updates…', action: null });
  assert.deepEqual(item({ status: 'downloading', version: '0.1.1', percent: 7 }), { label: 'Downloading update 0.1.1: 7%', action: null });
  assert.deepEqual(item({ status: 'ready', version: '0.1.1' }), { label: 'Restart to update to 0.1.1', action: 'install' });
  assert.deepEqual(item({ status: 'login' }), { label: 'Sign in to check for updates…', action: 'check' });
});

test('a Basic-auth challenge is declined, so the feed check fails with its 401 instead of being aborted', () => {
  const { autoUpdater } = setup([]);
  const answers = [];
  autoUpdater.emit('login', { scheme: 'basic', realm: 'OneDev' }, (...args) => answers.push(args));
  assert.deepEqual(answers, [[]]);
});
