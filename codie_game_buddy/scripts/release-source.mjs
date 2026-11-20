// What a release may be built from: an installer must be rebuildable from
// what is on the remote, so every source tree packed into it (the app and the
// codie-host it links with file:../codie_host) must be clean and pushed.
import { spawnSync } from 'node:child_process';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}

// Why the tree at `dir` cannot go into a release, or null when it can.
export function unpublishedSource(dir, name) {
  if (git(dir, ['status', '--porcelain'])) return `${name} has uncommitted changes (${dir})`;
  git(dir, ['fetch', '--quiet', 'origin']);
  if (!git(dir, ['branch', '-r', '--contains', 'HEAD'])) {
    return `${name} ${git(dir, ['rev-parse', '--short', 'HEAD'])} is not pushed (${dir})`;
  }
  return null;
}
