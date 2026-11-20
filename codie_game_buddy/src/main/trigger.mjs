import path from 'node:path';
import { hamming } from './dhash.mjs';

// When commentary sends a frame (spec §4.1 steps 1 and 3).

// The allow-list entry for a window, by its exe file name (case-insensitive).
// Several games may share a program (a browser, a launcher): the one that is
// not switched off is the game that program is showing.
export function matchAllowList(win, allowList) {
  const exe = path.win32.basename(win?.path ?? '').toLowerCase();
  if (!exe) return null;
  return allowList.find(g => !g.off && g.process.toLowerCase() === exe) ?? null;
}

// `last`: how the last turn went: 'sent', 'silent' (sent, but Codie said
// nothing), 'busy' (the user was talking to Codie) or 'failed'; null before
// the first.
export function shouldSend({ hash, lastSentHash, now, lastSentAt, last = null, settings }) {
  // Chatty mode talks on: no change check, and a cooldown only after a turn
  // that failed for another reason than a conversation.
  if (settings.chattyMode && (last === 'sent' || last === 'busy')) return true;
  if (now - lastSentAt < settings.cooldownMs) return false;
  return settings.chattyMode || lastSentHash === null || hamming(hash, lastSentHash) >= settings.changeThreshold;
}

// How long the loop waits after a tick (`result`: what tick() returned):
// chatty mode goes on at once after a sent turn, as Codie has just finished
// speaking.
export function nextTickMs(result, settings) {
  return settings.chattyMode && result === 'sent' ? 0 : settings.sampleMs;
}
