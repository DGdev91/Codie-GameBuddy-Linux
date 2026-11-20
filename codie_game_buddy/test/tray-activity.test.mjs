import assert from 'node:assert/strict';
import test from 'node:test';
import { trayActivity } from '../src/main/tray-icon.mjs';

test('the tray returns to idle after processing or playback completes', () => {
  for (const phase of ['capturing', 'analyzing', 'responding']) {
    assert.equal(trayActivity('ready', phase), 'commentary');
  }
  for (const phase of ['cooldown', 'unchanged', 'no-game', 'off', 'failed', 'no-frame', 'window-changed', 'queued']) {
    assert.equal(trayActivity('ready', phase), 'idle');
  }
});

test('a disconnected or unpaired device never looks as though it is commenting', () => {
  for (const state of ['connecting', 'offline', 'pending', 'not-paired']) {
    assert.equal(trayActivity(state, 'responding'), 'idle');
  }
});
