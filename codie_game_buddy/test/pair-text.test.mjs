import assert from 'node:assert/strict';
import test from 'node:test';
import { PAIR } from 'codie-host';
import { translatorFor } from '../src/main/i18n.mjs';
import { pairText } from '../src/shared/pair-text.mjs';

// agentd's own codes and the device codes it passes through (clt01 user_config_gin.go).
const CODES = [...Object.values(PAIR), 'INVALID_CODE', 'PAIRING_CODE_EXPIRED', 'PAIRING_CODE_USED', 'PAIRING_SOURCE_MISMATCH',
  'PAIRING_REQUEST_RATE_LIMITED', 'PAIRING_SOURCE_NOT_ALLOWED', 'PAIRING_SESSION_CREATE_FAILED', 'LOCAL_SECRET_INIT_FAILED'];

test('every pairing code codie-host answers has words in both languages', () => {
  for (const locale of ['en', 'zh-CN']) {
    const t = translatorFor(locale);
    for (const code of CODES) {
      const said = pairText(t, { ok: false, code, deviceName: 'Desk' });
      assert.notEqual(said, t('pair.result.unknown', { code }), `${locale} ${code}`);
      assert.doesNotMatch(said, /pair\.result|\{name\}/, `${locale} ${code}`);
    }
  }
});

test('the device name goes in; an unknown code or a failed call names what happened', () => {
  const t = translatorFor('en');
  assert.match(pairText(t, { ok: true, code: 'PAIR_STARTED', deviceName: 'Desk' }), /Desk/);
  assert.match(pairText(t, { ok: true, code: 'PAIRED', deviceName: 'Desk' }), /Desk/);
  assert.equal(pairText(t, { ok: false, code: 'NEW_DEVICE_CODE' }), t('pair.result.unknown', { code: 'NEW_DEVICE_CODE' }));
  assert.equal(pairText(t, { error: 'fetch failed', code: '' }), t('pair.result.unknown', { code: 'fetch failed' }));
});
