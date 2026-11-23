#!/usr/bin/env node
// Builds the Linux AppImage and publishes it as a GitHub release, which is
// also the update feed of the installed AppImages (electron-updater reads
// latest-linux.yml from the latest release).
//
//   npm run release:linux                   build, then create release v<version>
//   npm run release:linux -- --no-upload    build only (dist/)
//
// The repository is the feed in package.json build.linux.publish.
// Uploading needs GITHUB_TOKEN (contents: write on the repo), or a signed-in `gh`.
// Commit and push the port first: a release is built only from pushed commits.
// Installed apps update only to a higher version than their own.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpublishedSource } from './release-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { version } = pkg;
const tag = `v${version}`;
const appImage = pkg.build.linux.artifactName.replace('${version}', version);
const API = 'https://api.github.com';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status}`})`);
  return r;
}

function build() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code's terminal
  run(process.execPath, [path.join(ROOT, 'node_modules/electron-builder/cli.js'), '--linux', 'AppImage', '--x64', '--publish', 'never'], { cwd: ROOT, env });
  const file = path.join(ROOT, 'dist', appImage);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${sum}  ${appImage}\n`);
  return [appImage, `${appImage}.sha256`, 'latest-linux.yml'].map(f => path.join(ROOT, 'dist', f));
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new Error('set GITHUB_TOKEN (or sign in with gh) to upload');
}

async function github(url, { method = 'GET', body, type = 'application/json', auth }) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json', 'content-type': type, 'x-github-api-version': '2022-11-28' },
    body: type === 'application/json' && body ? JSON.stringify(body) : body,
  });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${method} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 404 ? null : res.json();
}

async function publish(owner, repo, files) {
  const auth = token();
  if (await github(`/repos/${owner}/${repo}/releases/tags/${tag}`, { auth })) throw new Error(`${tag} is already released: bump the version`);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const release = await github(`/repos/${owner}/${repo}/releases`, {
    method: 'POST', auth,
    body: { tag_name: tag, target_commitish: commit, name: `${pkg.build.productName} ${version} (Linux)`, body: `AppImage x86_64. Checksum: \`${path.basename(files[1])}\`.` },
  });
  for (const file of files) {
    const name = path.basename(file);
    console.log(`[release] uploading ${name}`);
    const url = release.upload_url.replace(/\{.*\}$/, `?name=${encodeURIComponent(name)}`);
    await github(url, { method: 'POST', auth, type: 'application/octet-stream', body: fs.readFileSync(file) });
  }
  console.log(`[release] ${release.html_url}`);
}

try {
  const { owner, repo } = pkg.build.linux.publish;
  const upload = !process.argv.includes('--no-upload');
  if (upload) {
    // The port keeps codie_game_buddy and codie_host in one repository.
    const problem = unpublishedSource(path.dirname(ROOT), 'the Linux port');
    if (problem) throw new Error(`${problem}: a release is built only from pushed commits`);
  }
  const files = build();
  if (upload) await publish(owner, repo, files);
  else console.log(`[release] built ${files.map(f => path.relative(ROOT, f)).join(', ')}; nothing uploaded`);
} catch (e) {
  console.error(`[release] ${e.message}`);
  process.exit(1);
}
