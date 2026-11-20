import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unpublishedSource } from '../scripts/release-source.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

// A clone of a bare remote with one pushed commit.
function pushedClone(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'clone', '-q', remote, work);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'a');
  git(work, 'push', '-q', 'origin', 'HEAD');
  return work;
}

test('a clean tree on a pushed commit can be released', t => {
  assert.equal(unpublishedSource(pushedClone(t), 'codie-host'), null);
});

test('uncommitted changes, untracked files included, block a release', t => {
  const work = pushedClone(t);
  fs.writeFileSync(path.join(work, 'b.txt'), 'b');
  assert.match(unpublishedSource(work, 'codie-host'), /^codie-host has uncommitted changes/);
});

test('a commit no remote branch contains blocks a release', t => {
  const work = pushedClone(t);
  fs.writeFileSync(path.join(work, 'a.txt'), 'changed');
  git(work, 'commit', '-qam', 'local only');
  assert.match(unpublishedSource(work, 'codie-host'), /^codie-host [0-9a-f]+ is not pushed/);
});
