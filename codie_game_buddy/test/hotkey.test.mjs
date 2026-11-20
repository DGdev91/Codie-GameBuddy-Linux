import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHotkey } from '../src/main/hotkey.mjs';

function fakeShortcut({ taken = [], invalid = [] } = {}) {
  return {
    registered: new Map(),
    unregisterAll() { this.registered.clear(); },
    register(acc, fn) {
      if (invalid.includes(acc)) throw new TypeError(`conversion failure: ${acc}`);
      if (taken.includes(acc)) return false;
      this.registered.set(acc, fn);
      return true;
    },
  };
}

test('a free accelerator is registered and replaces the previous one', () => {
  const s = fakeShortcut();
  assert.equal(registerHotkey(s, 'Ctrl+Alt+G', () => {}), null);
  assert.equal(registerHotkey(s, 'Ctrl+Alt+H', () => {}), null);
  assert.deepEqual([...s.registered.keys()], ['Ctrl+Alt+H']);
});

test('taken and invalid accelerators are reported as message keys', () => {
  assert.equal(registerHotkey(fakeShortcut({ taken: ['F1'] }), 'F1', () => {}), 'hotkey.taken');
  assert.equal(registerHotkey(fakeShortcut({ invalid: ['Nope+'] }), 'Nope+', () => {}), 'hotkey.invalid');
});
