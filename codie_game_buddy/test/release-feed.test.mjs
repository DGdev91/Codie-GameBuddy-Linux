import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseRawFeed, staleInstallers } from '../scripts/release-feed.mjs';

test('the feed URL names the releases repo, branch and folder', () => {
  assert.deepEqual(parseRawFeed('https://git.service.code27.cn/codie/releases/~raw/main/game-buddy/'), {
    url: 'https://git.service.code27.cn/codie/releases/~raw/main/game-buddy',
    repo: 'https://git.service.code27.cn/codie/releases', branch: 'main', folder: 'game-buddy',
  });
});

test('package.json publishes to the game-buddy folder of codie/releases', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.build.publish.provider, 'generic');
  // OneDev answers one byte range per request, not multipart/byteranges.
  assert.equal(pkg.build.publish.useMultipleRangeRequest, false);
  assert.equal(parseRawFeed(pkg.build.publish.url).folder, 'game-buddy');
});

test('anything else is refused', () => {
  assert.throws(() => parseRawFeed('https://github.com/CODE27Official/x/releases'), /not a OneDev raw folder/);
  assert.throws(() => parseRawFeed(undefined), /not a OneDev raw folder/);
});

test('a release replaces the old installers and keeps their blockmaps', () => {
  assert.deepEqual(staleInstallers(['latest.yml', 'A-0.1.0.exe', 'A-0.1.0.exe.blockmap']), ['A-0.1.0.exe']);
});
