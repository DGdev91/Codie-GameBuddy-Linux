import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalLanguage, resolveVoiceLanguage, sentences, voiceLanguageLine } from '../../src/agentd/locales.mjs';

test('canonicalLanguage accepts language tags and rejects anything else', () => {
  assert.equal(canonicalLanguage('zh-cn'), 'zh-CN');
  assert.equal(canonicalLanguage('en'), 'en');
  assert.equal(canonicalLanguage('not a tag'), null);
  assert.equal(canonicalLanguage(''), null);
  assert.equal(canonicalLanguage('system'), null);
  assert.equal(canonicalLanguage(42), null);
});

test('resolveVoiceLanguage follows the system unless a valid tag is set', () => {
  assert.equal(resolveVoiceLanguage(undefined, 'zh-CN'), 'zh-CN');
  assert.equal(resolveVoiceLanguage('system', 'en-US'), 'en-US');
  assert.equal(resolveVoiceLanguage('ja', 'zh-CN'), 'ja');
  assert.equal(resolveVoiceLanguage('???', 'zh-CN'), 'zh-CN', 'a broken setting falls back to the system');
  assert.equal(resolveVoiceLanguage(undefined, '???'), 'en', 'an unreadable system locale falls back to English');
});

test('sentences speak Chinese for zh-* and English for everything else', () => {
  assert.equal(sentences('en-US').reminder('Claude Code'), 'Claude Code on the computer needs you to take a look.');
  assert.equal(sentences('ja').reminder('Codex'), 'Codex on the computer needs you to take a look.');
  assert.match(sentences('zh-CN').reminder('Codex'), /^电脑上的 Codex/);
  assert.match(sentences('zh-Hant-TW').approval('Claude Code', 'Remove node_modules'), /Claude Code.*Remove node_modules/);
  assert.equal(sentences('en').approval('Claude Code', 'Remove node_modules'), 'Claude Code on the computer needs your approval: Remove node_modules');
});

test('voiceLanguageLine names the language for the agent', () => {
  assert.equal(voiceLanguageLine('zh-CN'), 'The Codie voice language is Chinese (China), zh-CN: write codie_notify messages in it.');
  assert.equal(voiceLanguageLine('en'), 'The Codie voice language is English, en: write codie_notify messages in it.');
});
