#!/usr/bin/env node
// Builds the installer and publishes it to the update feed.
//
//   node scripts/release.mjs                  OneDev feed (package.json build.publish): build, then push
//                                              latest.yml, the installer and its blockmap to the releases repo
//   node scripts/release.mjs --github <o/r>   build for a GitHub releases feed instead; nothing is uploaded
//
// Bump "version" in package.json, commit and push first: installed apps only
// take a higher version, and the app and codie_host must be clean and pushed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRawFeed, staleInstallers } from './release-feed.mjs';
import { unpublishedSource } from './release-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { version } = pkg;
const installer = pkg.build.nsis.artifactName.replace('${version}', version);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status}`})`);
}
const git = (args, cwd, env) => run('git', args, { cwd, env: { ...process.env, ...env } });

function build(extra = []) {
  const sources = [[ROOT, pkg.build.productName], [fs.realpathSync(path.join(ROOT, 'node_modules/codie-host')), 'codie-host']];
  for (const [dir, name] of sources) {
    const problem = unpublishedSource(dir, name);
    if (problem) throw new Error(`${problem}: a release is built only from pushed commits`);
  }
  run(process.execPath, [path.join(ROOT, 'node_modules/electron-builder/cli.js'), '--win', 'nsis', '--x64', '--publish', 'never', ...extra], { cwd: ROOT });
}

function releaseToOneDev() {
  const feed = parseRawFeed(pkg.build.publish.url);
  // Installers go to Git LFS (the repo's .gitattributes): without git-lfs they would be committed whole.
  if (spawnSync('git', ['lfs', 'version']).status !== 0) throw new Error('install Git LFS first (git lfs install)');
  build();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-releases-'));
  try {
    // Older installers are LFS objects: check out their pointers only.
    git(['clone', '--depth', '1', '--branch', feed.branch, feed.repo, dir], ROOT, { GIT_LFS_SKIP_SMUDGE: '1' });
    const out = path.join(dir, feed.folder);
    fs.mkdirSync(out, { recursive: true });
    if (fs.readdirSync(out).includes(installer)) throw new Error(`${installer} is already published: bump the version`);
    // Older blockmaps stay: an update downloads only the changed blocks against them.
    for (const old of staleInstallers(fs.readdirSync(out))) fs.rmSync(path.join(out, old));
    for (const f of ['latest.yml', installer, `${installer}.blockmap`]) fs.copyFileSync(path.join(ROOT, 'dist', f), path.join(out, f));
    git(['add', '-A'], dir);
    git(['commit', '-m', `release: ${feed.folder} ${version}`], dir);
    git(['push', 'origin', `HEAD:${feed.branch}`], dir);
    console.log(`[release] ${pkg.build.productName} ${version} is live at ${feed.url}/latest.yml`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function buildForGitHub(ownerRepo) {
  const [owner, repo] = ownerRepo?.split('/') ?? [];
  if (!owner || !repo) throw new Error('usage: release.mjs --github <owner>/<repo>');
  build([`-c.publish.provider=github`, `-c.publish.owner=${owner}`, `-c.publish.repo=${repo}`, '-c.publish.url=']);
  console.log(`[release] built for github.com/${owner}/${repo}: upload dist/latest.yml, dist/${installer} and its .blockmap to release v${version}`);
}

try {
  if (process.argv[2] === '--github') buildForGitHub(process.argv[3]);
  else releaseToOneDev();
} catch (e) {
  console.error(`[release] ${e.message}`);
  process.exit(1);
}
