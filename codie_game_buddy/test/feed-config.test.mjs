import assert from 'node:assert/strict';
import test from 'node:test';
import { cookieHeaders, feedBaseUrl, onFeedSite } from '../src/main/feed-config.mjs';

test('a generic feed gives its base URL, without a trailing slash', () => {
  const yml = 'provider: generic\nurl: https://git.service.code27.cn/codie/releases/~raw/main/game-buddy/\nupdaterCacheDirName: codie-game-buddy-updater\n';
  assert.equal(feedBaseUrl(yml), 'https://git.service.code27.cn/codie/releases/~raw/main/game-buddy');
});

test('a GitHub feed needs no sign-in', () => {
  assert.equal(feedBaseUrl('owner: CODE27Official\nrepo: some-app\nprovider: github\n'), null);
});

test('cookies become one Cookie header; none, no header', () => {
  assert.deepEqual(cookieHeaders([{ name: 'JSESSIONID', value: 'a1' }, { name: 'rememberMe', value: 'b2' }]), { Cookie: 'JSESSIONID=a1; rememberMe=b2' });
  assert.deepEqual(cookieHeaders([]), {});
});

test('only pages on the feed\'s own site count as on it', () => {
  const base = 'https://git.service.code27.cn/codie/releases/~raw/main/game-buddy';
  assert.equal(onFeedSite('https://git.service.code27.cn/~login', base), true);
  assert.equal(onFeedSite('https://evil.example/git.service.code27.cn', base), false);
  assert.equal(onFeedSite('http://git.service.code27.cn/~login', base), false);
  assert.equal(onFeedSite('https://git.service.code27.cn.evil.example/', base), false);
  assert.equal(onFeedSite('not a url', base), false);
});
