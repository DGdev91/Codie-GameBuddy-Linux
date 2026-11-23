import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS, loadSettings, saveSettings, validateSettings } from '../src/main/settings.mjs';

const tmpFile = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-buddy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'settings.json');
};

test('defaults match the spec', () => {
  assert.deepEqual({ ...DEFAULTS }, {
    commentaryEnabled: true, allowList: [], sampleMs: 3000, cooldownMs: 60000, changeThreshold: 12, hotkey: 'Ctrl+Alt+G', language: 'system', avoidInterrupting: true, chattyMode: false, guideTips: true, fastMode: true, saveToHistory: false,
  });
});

test('valid values are kept, invalid ones fall back and are reported', () => {
  const { settings, errors } = validateSettings({
    commentaryEnabled: false, sampleMs: 500, cooldownMs: 90000, changeThreshold: 64.5, hotkey: '', language: 'xx', avoidInterrupting: 'yes', chattyMode: 1,
    allowList: [{ process: 'Game.exe', name: 'My Game', extra: 1 }],
  });
  assert.deepEqual(settings, {
    commentaryEnabled: false, allowList: [{ process: 'Game.exe', name: 'My Game' }], sampleMs: 3000, cooldownMs: 90000, changeThreshold: 12, hotkey: 'Ctrl+Alt+G', language: 'system', avoidInterrupting: true, chattyMode: false, guideTips: true, fastMode: true, saveToHistory: false,
  });
  assert.deepEqual(errors.sort(), ['avoidInterrupting', 'changeThreshold', 'chattyMode', 'hotkey', 'language', 'sampleMs']);
});

test('chatty mode is a boolean', () => {
  assert.equal(validateSettings({ chattyMode: true }).settings.chattyMode, true);
  assert.deepEqual(validateSettings({ chattyMode: 'on' }).errors, ['chattyMode']);
});

test('language is system or a language Codie speaks', () => {
  assert.equal(validateSettings({ language: 'it' }).settings.language, 'it');
  assert.equal(validateSettings({ language: 'zh-CN' }).settings.language, 'zh-CN');
  assert.equal(validateSettings({ language: 'en' }).settings.language, 'en');
  assert.deepEqual(validateSettings({ language: 'zh' }).errors, ['language']);
});

test('the allow list needs exe names, names, and no duplicates', () => {
  const bad = list => validateSettings({ allowList: list }).errors;
  if (process.platform !== 'linux') assert.deepEqual(bad([{ process: 'game', name: 'x' }]), ['allowList']);
  assert.deepEqual(bad([{ process: 'a/b.exe', name: 'x' }]), ['allowList']);
  assert.deepEqual(bad([{ process: 'g.exe', name: '' }]), ['allowList']);
  assert.deepEqual(bad([{ process: 'g.exe', name: 'a' }, { process: 'G.EXE', name: 'A' }]), ['allowList']);
  assert.deepEqual(bad('nope'), ['allowList']);
  assert.deepEqual(bad([{ process: 'g.exe', name: 'G' }]), []);
});

test('a missing file is a first run; a broken file is reported', t => {
  const file = tmpFile(t);
  assert.deepEqual(loadSettings(file), { settings: { ...DEFAULTS }, errors: [], firstRun: true });
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(loadSettings(file), { settings: { ...DEFAULTS }, errors: ['file'], firstRun: false });
});

test('save writes valid settings and refuses invalid ones', t => {
  const file = tmpFile(t);
  const ok = saveSettings(file, { ...DEFAULTS, cooldownMs: 120000 });
  assert.equal(ok.saved, true);
  assert.equal(loadSettings(file).settings.cooldownMs, 120000);
  const refused = saveSettings(file, { ...DEFAULTS, cooldownMs: 5 });
  assert.deepEqual([refused.saved, refused.errors], [false, ['cooldownMs']]);
  assert.equal(loadSettings(file).settings.cooldownMs, 120000);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('reading the counters first is kept per game, only where the user chose it', () => {
  const game = { process: 'Game.exe', name: 'My Game' };
  const list = allowList => validateSettings({ allowList });
  assert.deepEqual(list([game]).settings.allowList, [game]);
  assert.deepEqual(list([{ ...game, readCounters: false }]).settings.allowList, [{ ...game, readCounters: false }]);
  assert.deepEqual(list([{ ...game, readCounters: 1 }]).errors, ['allowList']);
  // The switch that covered every game is gone: an old file's value is dropped.
  assert.equal('readCounters' in validateSettings({ readCounters: true }).settings, false);
});

test('games may share a program; a game switched off is kept, and on is the default left out', () => {
  const list = v => validateSettings({ allowList: v });
  assert.deepEqual(list([{ process: 'chrome.exe', name: 'A', off: true }, { process: 'Chrome.exe', name: 'B', off: false }]).settings.allowList,
    [{ process: 'chrome.exe', name: 'A', off: true }, { process: 'Chrome.exe', name: 'B' }]);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', off: 'yes' }]).errors, ['allowList']);
});

test('guide tips are a boolean, on by default', () => {
  assert.equal(validateSettings({}).settings.guideTips, true);
  assert.equal(validateSettings({ guideTips: false }).settings.guideTips, false);
  assert.deepEqual(validateSettings({ guideTips: 'no' }).errors, ['guideTips']);
});

test("a game's genre and guide wiki address are kept when valid; the defaults are left out", () => {
  const list = allowList => validateSettings({ allowList });
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', genre: 'moba', guideWiki: ' https://lol.fandom.com/wiki/Annie ' }]).settings.allowList,
    [{ process: 'g.exe', name: 'G', genre: 'moba', guideWiki: 'https://lol.fandom.com/wiki/Annie' }]);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', genre: 'auto', guideWiki: '' }]).settings.allowList, [{ process: 'g.exe', name: 'G' }]);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', genre: 'racing' }]).errors, ['allowList']);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', guideWiki: 'http://lol.fandom.com/' }]).errors, ['allowList']);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', guideWiki: 'lol wiki' }]).errors, ['allowList']);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', guideWiki: `https://x.org/${'a'.repeat(300)}` }]).errors, ['allowList']);
});

test("a game's character is kept trimmed, left out when empty and refused when too long", () => {
  const list = allowList => validateSettings({ allowList });
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', persona: ' Play Paimon.\nCall the player Traveler. ' }]).settings.allowList,
    [{ process: 'g.exe', name: 'G', persona: 'Play Paimon.\nCall the player Traveler.' }]);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', persona: '  ' }]).settings.allowList, [{ process: 'g.exe', name: 'G' }]);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', persona: 'a'.repeat(601) }]).errors, []);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', persona: 'a'.repeat(4001) }]).errors, ['allowList']);
  assert.deepEqual(list([{ process: 'g.exe', name: 'G', persona: 7 }]).errors, ['allowList']);
});


test('fast mode defaults on for existing settings and accepts only booleans', () => {
  assert.equal(validateSettings({}).settings.fastMode, true);
  assert.equal(validateSettings({ fastMode: false }).settings.fastMode, false);
  assert.deepEqual(validateSettings({ fastMode: 'on' }).errors, ['fastMode']);
  assert.equal(validateSettings({ saveToHistory: true }).settings.saveToHistory, true);
  assert.deepEqual(validateSettings({ saveToHistory: 'on' }).errors, ['saveToHistory']);
});
