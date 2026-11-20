import assert from 'node:assert/strict';
import test from 'node:test';
import { LANGUAGES, MESSAGES, resolveLocale, translatorFor } from '../src/main/i18n.mjs';
import { translator } from '../src/shared/translate.mjs';

test('"system" follows the app locale: any Chinese is zh-CN, anything else English', () => {
  assert.equal(resolveLocale('system', 'zh-CN'), 'zh-CN');
  assert.equal(resolveLocale('system', 'zh-TW'), 'zh-CN');
  assert.equal(resolveLocale('system', 'zh'), 'zh-CN');
  assert.equal(resolveLocale('system', 'en-US'), 'en');
  assert.equal(resolveLocale('system', 'ja'), 'en');
  assert.equal(resolveLocale('system', ''), 'en');
});

test('a chosen language wins over the app locale', () => {
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
});

test('every language but "system" has a message table', () => {
  assert.deepEqual(LANGUAGES, ['system', 'en', 'zh-CN']);
  assert.deepEqual(Object.keys(MESSAGES).sort(), ['en', 'zh-CN']);
});

test('both tables have the same keys and the same placeholders', () => {
  const placeholders = s => (s.match(/\{\w+\}/g) ?? []).sort();
  assert.deepEqual(Object.keys(MESSAGES['zh-CN']).sort(), Object.keys(MESSAGES.en).sort());
  for (const key of Object.keys(MESSAGES.en)) {
    assert.deepEqual(placeholders(MESSAGES['zh-CN'][key]), placeholders(MESSAGES.en[key]), key);
  }
});

test('the translator fills placeholders and falls back to the key', () => {
  const t = translator({ hello: 'Hello {name}, {name}!' });
  assert.equal(t('hello', { name: 'Codie' }), 'Hello Codie, Codie!');
  assert.equal(t('hello'), 'Hello {name}, {name}!');
  assert.equal(t('missing'), 'missing');
});

test('translatorFor picks the table for the locale', () => {
  assert.equal(translatorFor('en')('save.done'), 'Saved.');
  assert.equal(translatorFor('zh-CN')('save.done'), '已保存。');
});
