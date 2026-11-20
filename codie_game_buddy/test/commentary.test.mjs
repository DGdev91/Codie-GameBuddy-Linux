import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommentary } from '../src/main/commentary.mjs';
import { createTurnLock } from '../src/main/turn-lock.mjs';

const GAME = { id: 7, path: 'C:\\Games\\game.exe', owner: 'Game', title: 'Game - Level 1' };
const BROWSER = { id: 8, path: 'C:\\Apps\\chrome.exe', owner: 'Chrome', title: 'Bank' };
const BIG = (1n << 20n) - 1n; // 20 bits from 0n

function setup({ win = GAME, hash = 0n, outcome = { ok: true } } = {}) {
  const state = {
    win, hash, outcome, outcomes: [], locale: 'en', info: null, infoAsked: [], lines: [], ocrCalls: [], onScreen: [], described: [],
    wiki: null, wikiAsked: [], tip: null, tipAsked: [], used: [], clock: 100_000, random: 0, sent: [], captured: [], logs: [], onCapture: () => {},
  };
  const settings = { commentaryEnabled: true, guideTips: true, allowList: [{ process: 'game.exe', name: 'Test Game' }], cooldownMs: 60000, changeThreshold: 12 };
  const capture = {
    foreground: async () => state.win,
    sampleHash: async () => state.hash,
    captureJpeg: async id => { state.captured.push(id); state.onCapture(); return Buffer.from([0xff, 0xd8, 0xff]); },
  };
  const host = { chatTurn: async req => { state.sent.push(req); return state.outcomes.shift() ?? state.outcome; } };
  const lock = createTurnLock();
  const gameInfo = { get: ({ name, locale }) => { state.infoAsked.push([name, locale]); return state.info; } };
  const ocr = { read: async (image, locale) => { state.ocrCalls.push([image, locale]); return state.lines; } };
  const screenTerms = { describe: (lines, info) => { state.described.push([lines, info]); return state.onScreen; } };
  const guides = {
    wikiFor: (game, locale) => { state.wikiAsked.push([game.name, locale]); return state.wiki; },
    tipFor: (lines, wiki) => { state.tipAsked.push([lines, wiki]); return state.tip; },
    used: tip => state.used.push(tip),
  };
  state.statuses = [];
  const c = createCommentary({ onStatus: value => state.statuses.push(value), capture, host, lock, settings: () => settings, locale: () => state.locale, gameInfo, ocr, screenTerms, guides, now: () => state.clock, random: () => state.random, log: line => state.logs.push(line) });
  return { c, state, settings, lock };
}

test('an allowed game in front gets a comment with the game name, spoken on the device', async () => {
  const { c, state } = setup();
  assert.equal(await c.tick(), 'sent');
  assert.deepEqual(state.captured, [7]);
  assert.equal(state.sent[0].speech, 'device');
  assert.match(state.sent[0].text, /Test Game/);
  assert.ok(Buffer.isBuffer(state.sent[0].image));
});

test('the prompt is in the language game_buddy is set to at send time', async () => {
  const { c, state } = setup();
  state.locale = 'zh-CN';
  assert.equal(await c.tick(), 'sent');
  assert.match(state.sent[0].text, /Speak only Simplified Chinese/);
});

test('an allowed game gets its looked-up background; an unlisted window from the hotkey does not', async () => {
  const { c, state } = setup();
  state.info = { source: 'Wikipedia', text: 'A world of rings.' };
  assert.equal(await c.tick(), 'sent');
  assert.deepEqual(state.infoAsked, [['Test Game', 'en']]);
  assert.match(state.sent[0].text, /From Wikipedia: A world of rings\./);
  state.win = BROWSER;
  await c.hotkey();
  assert.equal(state.infoAsked.length, 1);
  assert.doesNotMatch(state.sent[1].text, /A world of rings/);
  assert.equal(state.ocrCalls.length, 0); // no glossary, no OCR
});

test('a game with a glossary has its frame read for names, from a tick or the hotkey', async () => {
  const { c, state } = setup();
  state.info = { source: 'Wikipedia', text: 'A world of rings.', terms: [['Malenia', 'Malenia']] };
  state.lines = ['Malenia'];
  state.onScreen = [{ name: 'Malenia', text: 'A demigod.' }];
  assert.equal(await c.tick(), 'sent');
  assert.deepEqual(state.ocrCalls, [[state.sent[0].image, 'en']]);
  assert.deepEqual(state.described, [[['Malenia'], state.info]]);
  assert.match(state.sent[0].text, /Names on screen in this screenshot, with notes from Wikipedia:\nMalenia: A demigod\.<\/on_screen>/);
  assert.equal(await c.hotkey(), 'sent');
  assert.equal(state.ocrCalls.length, 2);
  state.win = BROWSER;
  await c.hotkey();
  assert.equal(state.ocrCalls.length, 2); // not on the allow list: no glossary
});

const WIKI = { source: 'Elden Ring Wiki', api: 'https://eldenring.fandom.com/api.php', terms: [['Margit, the Fell Omen', 'Margit, the Fell Omen']] };
const TIP = { name: 'Margit, the Fell Omen', title: 'Margit, the Fell Omen', source: 'Elden Ring Wiki', text: 'Dodge the delayed slam.' };

test('a guide wiki has the frame read once, and a tip from it goes into the prompt', async () => {
  const { c, state } = setup();
  state.outcome = { ok: true, turn: { assistant_text: 'Dodge the delayed slam.' } };
  state.info = { source: 'Wikipedia', text: 'An action role-playing game.', terms: [['Malenia', 'Malenia']] };
  state.wiki = WIKI;
  state.lines = ['Margit, the Fell Omen'];
  state.tip = TIP;
  assert.equal(await c.tick(), 'sent');
  assert.deepEqual(state.wikiAsked, [['Test Game', 'en']]);
  assert.equal(state.ocrCalls.length, 1); // both glossaries share one OCR pass
  assert.deepEqual(state.tipAsked, [[['Margit, the Fell Omen'], WIKI]]);
  assert.match(state.sent[0].text, /<tip_notes>From Elden Ring Wiki's page on Margit, the Fell Omen: Dodge the delayed slam\.<\/tip_notes>/);
  assert.match(state.sent[0].text, /dangerous attacks/); // action, from the background
  assert.deepEqual(state.used, [TIP]);
});

test('a guide wiki alone is enough to read the frame', async () => {
  const { c, state } = setup();
  state.wiki = WIKI;
  assert.equal(await c.tick(), 'sent');
  assert.equal(state.ocrCalls.length, 1);
  assert.equal(state.described.length, 0); // no background glossary
});

test("the game's own genre shapes the tip; a turn that fails does not use the tip up", async () => {
  const { c, state, settings } = setup({ outcome: { ok: false, kind: 'offline' } });
  settings.allowList = [{ process: 'game.exe', name: 'Test Game', genre: 'card' }];
  state.info = { source: 'Wikipedia', text: 'An action role-playing game.' };
  state.wiki = WIKI;
  state.tip = TIP;
  assert.equal(await c.tick(), 'offline');
  assert.match(state.sent[0].text, /this card or relic/);
  assert.deepEqual(state.used, []);
});

test('with guide tips off no guide is looked up and no tip is given', async () => {
  const { c, state, settings } = setup();
  settings.guideTips = false;
  state.wiki = WIKI;
  state.tip = TIP;
  assert.equal(await c.tick(), 'sent');
  assert.deepEqual([state.wikiAsked.length, state.ocrCalls.length, state.tipAsked.length], [0, 0, 0]);
  assert.doesNotMatch(state.sent[0].text, /A tip you can pass on/);
});

test('an unlisted window from the hotkey gets no guide', async () => {
  const { c, state } = setup({ win: BROWSER });
  state.wiki = WIKI;
  assert.equal(await c.hotkey(), 'sent');
  assert.equal(state.wikiAsked.length, 0);
});

test('other windows, disabled commentary and a busy lock send nothing', async () => {
  const { c, state, settings, lock } = setup({ win: BROWSER });
  assert.equal(await c.tick(), 'no-game');
  state.win = null;
  assert.equal(await c.tick(), 'no-game');
  state.win = GAME;
  settings.commentaryEnabled = false;
  assert.equal(await c.tick(), 'skip');
  settings.commentaryEnabled = true;
  let release;
  const held = lock.run(() => new Promise(r => { release = r; }));
  assert.equal(await c.tick(), 'skip');
  release();
  await held;
  assert.equal(state.sent.length, 0);
});

test('the same scene stays quiet until it changes and the cooldown passed', async () => {
  const { c, state } = setup();
  assert.equal(await c.tick(), 'sent');
  state.clock += 10_000;
  state.hash = BIG;
  assert.equal(await c.tick(), 'unchanged'); // changed, cooldown not passed
  state.clock += 60_000;
  state.hash = 0n;
  assert.equal(await c.tick(), 'unchanged'); // cooldown passed, same scene
  state.hash = BIG;
  assert.equal(await c.tick(), 'sent');
  assert.equal(state.sent.length, 2);
});

test('a blocked device drops the frame, which is logged, and the next try waits one cooldown', async () => {
  const blocked = { ok: false, kind: 'blocked', error: { code: 'AMBIENT_MODE_BLOCKED', message: 'Chat API admission blocked.' } };
  const { c, state } = setup({ outcome: blocked });
  assert.equal(await c.tick(), 'blocked');
  assert.deepEqual(state.logs, ['commentary: blocked AMBIENT_MODE_BLOCKED Chat API admission blocked.']);
  state.outcome = { ok: true };
  state.clock += 10_000;
  assert.equal(await c.tick(), 'unchanged'); // same scene: lastSentHash did not move
  state.hash = BIG;
  assert.equal(await c.tick(), 'unchanged'); // changed, cooldown not passed
  state.clock += 60_000;
  assert.equal(await c.tick(), 'sent');
  assert.equal(state.sent.length, 2);
});

test('a failed turn logs its error code', async () => {
  const { c, state } = setup({ outcome: { ok: false, kind: 'error', error: { code: 'CONVERSATION_FAILED', message: 'boom' } } });
  assert.equal(await c.tick(), 'error');
  assert.deepEqual(state.logs, ['commentary: error CONVERSATION_FAILED boom']);
});

test('commentary turned off while the frame is captured drops it; the hotkey still sends', async () => {
  const { c, state, settings } = setup();
  state.onCapture = () => { settings.commentaryEnabled = false; };
  assert.equal(await c.tick(), 'skip');
  assert.deepEqual([state.captured.length, state.sent.length], [1, 0]);
  assert.equal(await c.hotkey(), 'sent');
});

test('after stop a frame being captured is dropped, from a tick or the hotkey', async () => {
  const { c, state } = setup();
  state.onCapture = () => c.stop();
  assert.equal(await c.tick(), 'skip');
  assert.equal(await c.hotkey(), 'skip');
  assert.deepEqual([state.captured.length, state.sent.length], [1, 0]);
});

test('an offline device is not retried on every tick, only once per cooldown', async () => {
  const { c, state } = setup({ outcome: { ok: false, kind: 'offline' } });
  assert.equal(await c.tick(), 'offline');
  state.clock += 10_000;
  state.hash = BIG;
  assert.equal(await c.tick(), 'unchanged'); // a failed turn waits one cooldown
  state.clock += 60_000;
  state.outcome = { ok: true };
  assert.equal(await c.tick(), 'sent'); // the device is back
});

test('a hotkey send restarts the cooldown', async () => {
  const { c, state } = setup();
  assert.equal(await c.hotkey(), 'sent');
  state.clock += 10_000;
  state.hash = BIG;
  assert.equal(await c.tick(), 'unchanged');
});

test('no sample or no capture sends nothing', async () => {
  const { c, state } = setup({ hash: null });
  assert.equal(await c.tick(), 'no-frame');
  const capture = { foreground: async () => GAME, sampleHash: async () => 0n, captureJpeg: async () => null };
  const settings = () => ({ commentaryEnabled: true, allowList: [{ process: 'game.exe', name: 'G' }], cooldownMs: 60000, changeThreshold: 12 });
  const none = createCommentary({ capture, host: { chatTurn: async () => assert.fail('no turn') }, lock: createTurnLock(), settings, now: () => 0 });
  assert.equal(await none.tick(), 'no-frame');
  assert.equal(state.sent.length, 0);
});

test('the hotkey sends the window in front at once, allowed or not, after a turn in flight', async () => {
  const { c, state, lock } = setup({ win: BROWSER });
  let release;
  const held = lock.run(() => new Promise(r => { release = r; }));
  const pressed = c.hotkey();
  await new Promise(r => setImmediate(r));
  assert.equal(state.sent.length, 0);
  release();
  await held;
  assert.equal(await pressed, 'sent');
  assert.match(state.sent[0].text, /Bank/);
  assert.equal(await c.hotkey(), 'sent'); // no cooldown for the hotkey
  state.win = null;
  assert.equal(await c.hotkey(), 'no-window');
});

test('commentary does not interrupt a conversation unless allowed; the hotkey always may', async () => {
  const { c, state, settings } = setup();
  settings.avoidInterrupting = true;
  await c.tick();
  assert.equal(state.sent[0].interrupt, false);
  settings.avoidInterrupting = false;
  state.clock += 60_000;
  state.hash = BIG;
  await c.tick();
  assert.equal(state.sent[1].interrupt, true);
  settings.avoidInterrupting = true;
  await c.hotkey();
  assert.equal(state.sent[2].interrupt, true);
});

test('no remark, ticked or asked for, stays in the device history or memory', async () => {
  const { c, state } = setup();
  await c.tick();
  await c.hotkey();
  assert.deepEqual(state.sent.map(r => r.retention), ['none', 'none']);
});

test('no remark, ticked or asked for, offers the model any tool', async () => {
  const { c, state } = setup();
  await c.tick();
  await c.hotkey();
  assert.deepEqual(state.sent.map(r => r.tools), ['none', 'none']);
});

const SAID = { ok: true, turn: { state: 'completed', assistant_text: 'Go!' } };

test('chatty mode talks on right after a turn, same scene or not, and never interrupts a conversation', async () => {
  const { c, state, settings } = setup({ outcome: SAID });
  settings.chattyMode = true;
  settings.avoidInterrupting = false;
  assert.equal(await c.tick(), 'sent');
  assert.equal(await c.tick(), 'sent'); // same scene, no time passed
  assert.deepEqual(state.sent.map(r => r.interrupt), [false, false]);
  assert.doesNotMatch(state.sent[0].text, /right after your last remark/); // nothing came before it
  assert.match(state.sent[1].text, /right after your last remark/);
  assert.equal(await c.hotkey(), 'sent');
  assert.equal(state.sent[2].interrupt, true); // the user asked
  assert.doesNotMatch(state.sent[2].text, /right after your last remark/);
});

test('chatty mode retries on the next tick after a conversation, and waits one cooldown after other failures', async () => {
  const { c, state, settings } = setup({ outcome: { ok: false, kind: 'blocked', error: { code: 'DEVICE_BUSY', message: 'busy' } } });
  settings.chattyMode = true;
  assert.equal(await c.tick(), 'blocked');
  state.outcome = { ok: false, kind: 'blocked', error: { code: 'AMBIENT_MODE_BLOCKED', message: 'ambient' } };
  assert.equal(await c.tick(), 'blocked'); // after a conversation: no cooldown
  state.outcome = { ok: true };
  state.clock += 10_000;
  assert.equal(await c.tick(), 'unchanged'); // after ambient mode: one cooldown
  state.clock += 60_000;
  assert.equal(await c.tick(), 'sent');
});

test('in chatty mode a remark the user cut off by talking to Codie is followed up on the next tick', async () => {
  const { c, state, settings } = setup({ outcome: { ok: false, kind: 'error', error: { code: 'DEVICE_INTERRUPTED', message: 'Conversation interrupted (wakeup).' } } });
  settings.chattyMode = true;
  assert.equal(await c.tick(), 'error');
  state.outcome = { ok: true };
  assert.equal(await c.tick(), 'sent');
});

test("Codie's last five remarks go into the next prompt, newest first; failed turns add none", async () => {
  const { c, state } = setup();
  for (const said of ['one.', 'two.', 'three.', 'four.', 'five.', 'six.']) {
    state.outcome = { ok: true, turn: { state: 'completed', assistant_text: ` ${said}\n` } };
    await c.hotkey();
  }
  state.outcome = { ok: false, kind: 'error', turn: { state: 'failed', assistant_text: 'lost.' }, error: { code: 'CONVERSATION_FAILED' } };
  await c.hotkey();
  await c.hotkey();
  assert.match(state.sent.at(-1).text, /Your last remarks, newest first:\n1\) six\.\n2\) five\.\n3\) four\.\n4\) three\.\n5\) two\.<\/last_remarks>/);
  assert.doesNotMatch(state.sent.at(-1).text, /\) one\.|lost\./);
  assert.doesNotMatch(state.sent[0].text, /Your last remarks/);
});

test('in chatty mode a turn that said nothing waits one cooldown, so a silent device is not sent turn after turn', async () => {
  const { c, state, settings } = setup({ outcome: { ok: true, turn: { state: 'completed', assistant_text: '' } } });
  settings.chattyMode = true;
  assert.equal(await c.tick(), 'sent');
  assert.equal(await c.tick(), 'unchanged');
  state.clock += 60_000;
  assert.equal(await c.tick(), 'sent');
});

test('the last remarks quoted are those on the same game; other windows neither get nor add any', async () => {
  const { c, state, settings } = setup({ outcome: SAID });
  settings.allowList = [...settings.allowList, { process: 'other.exe', name: 'Other Game' }];
  await c.hotkey();
  state.win = BROWSER;
  state.outcome = { ok: true, turn: { state: 'completed', assistant_text: 'About the bank.' } };
  await c.hotkey();
  assert.doesNotMatch(state.sent[1].text, /Your last remarks/);
  state.win = GAME;
  await c.hotkey();
  assert.match(state.sent[2].text, /Your last remarks, newest first:\n1\) Go!<\/last_remarks>/);
  state.win = { id: 9, path: 'C:\\Games\\other.exe', owner: 'Other', title: 'Other' };
  await c.hotkey();
  assert.doesNotMatch(state.sent[3].text, /Your last remarks/);
});

const SUBJECT = { moment: /React to what is happening right now/, world: /Share one thing from the background notes/, player: /Talk about how the player is doing in what they just pulled off/, mood: /Say how this scene strikes you/ };
const angleOf = text => Object.keys(SUBJECT).find(a => SUBJECT[a].test(text)) ?? null;

test('ticked remarks move from angle to angle: none takes one of the last two', async () => {
  const { c, state, settings } = setup({ outcome: SAID });
  settings.chattyMode = true;
  state.info = { source: 'Wikipedia', text: 'A world of rings.' };
  for (const random of [0, 0, 0, 0.999, 0.999, 0.5, 0]) {
    state.random = random;
    assert.equal(await c.tick(), 'sent');
  }
  const taken = state.sent.map(r => angleOf(r.text));
  assert.deepEqual(taken, ['moment', 'world', 'player', 'mood', 'world', 'player', 'moment']);
});

test("the game's genre gives the remarks its sides of play", async () => {
  const { c, state, settings } = setup({ outcome: SAID });
  settings.chattyMode = true;
  settings.allowList = [{ process: 'game.exe', name: 'Test Game', genre: 'strategy', readCounters: false }];
  for (const random of [0.3, 0.3, 0.3]) {
    state.random = random;
    assert.equal(await c.tick(), 'sent');
  }
  assert.match(state.sent[0].text, /how the player is doing in their army/);
  assert.match(state.sent[1].text, /how the player is doing in their economy/);
  assert.match(state.sent[2].text, /how the player is doing in how they handle their units/);
});

test('a game without a looked-up background gets no world angle', async () => {
  const { c, state, settings } = setup({ outcome: SAID });
  settings.chattyMode = true;
  for (let i = 0; i < 6; i++) assert.equal(await c.tick(), 'sent');
  assert.ok(!state.sent.map(r => angleOf(r.text)).includes('world'));
});

test('a remark that was not said does not use its angle up', async () => {
  const { c, state, settings } = setup({ outcome: { ok: false, kind: 'offline' } });
  settings.chattyMode = true;
  settings.cooldownMs = 0;
  assert.equal(await c.tick(), 'offline');
  state.outcome = SAID;
  assert.equal(await c.tick(), 'sent');
  assert.deepEqual(state.sent.map(r => angleOf(r.text)), ['moment', 'moment']);
});

test('a remark with a guide tip takes no angle and leaves the angles where they were', async () => {
  const { c, state, settings } = setup({ outcome: SAID });
  settings.chattyMode = true;
  state.info = { source: 'Wikipedia', text: 'A world of rings.' };
  state.wiki = WIKI;
  assert.equal(await c.tick(), 'sent');
  state.tip = TIP;
  assert.equal(await c.tick(), 'sent');
  state.tip = null;
  assert.equal(await c.tick(), 'sent');
  assert.deepEqual(state.sent.map(r => angleOf(r.text)), ['moment', null, 'world']);
  assert.match(state.sent[1].text, /Pass on one short, practical tip/);
});

test("the hotkey asks for Codie's take on the moment; a ticked remark does not", async () => {
  const { c, state } = setup({ outcome: SAID });
  await c.hotkey();
  assert.match(state.sent[0].text, /They just asked you to look at their game\./);
  assert.equal(angleOf(state.sent[0].text), null);
  state.clock += 60_000;
  state.hash = BIG;
  assert.equal(await c.tick(), 'sent');
  assert.doesNotMatch(state.sent[1].text, /asked you to look/);
  assert.equal(angleOf(state.sent[1].text), 'moment');
});

test("a game's character goes into its remarks, on a tick and on the hotkey", async () => {
  const { c, state, settings } = setup();
  settings.allowList = [{ process: 'game.exe', name: 'Test Game', persona: 'Play Paimon.' }];
  assert.equal(await c.tick(), 'sent');
  assert.equal(await c.hotkey(), 'sent');
  assert.equal(state.sent.length, 2);
  for (const sent of state.sent) assert.ok(sent.text.includes('<character>Play Paimon.</character>'));
});

test('a game without a character, and an unlisted window, get no character block', async () => {
  const { c, state } = setup();
  assert.equal(await c.tick(), 'sent');
  state.win = BROWSER;
  assert.equal(await c.hotkey(), 'sent');
  assert.equal(state.sent.length, 2);
  for (const sent of state.sent) assert.ok(!sent.text.includes('Character:'));
});

test('a strategy game has its counters read first: a silent turn lists them and the remark quotes them', async () => {
  const { c, state, settings } = setup();
  settings.allowList[0].genre = 'strategy';
  state.locale = 'zh-CN';
  state.outcomes = [{ ok: true, turn: { assistant_text: '食物=1179\n木材=355\n人口=51/85' } }];
  assert.equal(await c.tick(), 'sent');
  assert.equal(state.sent.length, 2);
  const [read, remark] = state.sent;
  assert.deepEqual([read.speech, read.retention, read.tools], ['none', 'none', 'none']);
  assert.match(read.text, /^List the resources the player has .* in Simplified Chinese\./);
  assert.equal(read.image, remark.image);
  assert.equal(remark.speech, 'device');
  assert.ok(remark.text.includes('<counters>Read off this screenshot just now:\n食物: 1179\n木材: 355\n人口: 51/85</counters>'));
});

test('a counters read the device refuses ends the remark, and waits like a refused remark', async () => {
  const { c, state, settings } = setup();
  settings.allowList[0].readCounters = true;
  state.outcomes = [{ ok: false, kind: 'blocked', error: { code: 'DEVICE_BUSY' } }];
  assert.equal(await c.tick(), 'blocked');
  assert.equal(state.sent.length, 1);
  state.hash = BIG;
  assert.equal(await c.tick(), 'unchanged');
});

test('a game of another genre, or one the user switched it off for, gets the remark alone', async () => {
  const { c, state, settings } = setup();
  assert.equal(await c.tick(), 'sent');
  assert.equal(state.sent.length, 1);
  settings.allowList[0] = { ...settings.allowList[0], genre: 'strategy', readCounters: false };
  state.hash = BIG;
  state.clock += 60_000;
  assert.equal(await c.tick(), 'sent');
  assert.equal(state.sent.length, 2);
});

test('a read that finds no counters leaves the remark as it was', async () => {
  const { c, state, settings } = setup();
  settings.allowList[0].readCounters = true;
  state.outcomes = [{ ok: true, turn: { assistant_text: 'There are no counters on this screen.' } }];
  assert.equal(await c.tick(), 'sent');
  assert.ok(!state.sent[1].text.includes('<counters>'));
});


test('repeated hotkeys capture one fresh frame only after a turn is available', async () => {
  const { c, state, lock } = setup();
  let release;
  const held = lock.run(() => new Promise(resolve => { release = resolve; }));
  const first = c.hotkey();
  const repeats = await Promise.all([c.hotkey(), c.hotkey(), c.hotkey()]);
  assert.deepEqual(repeats, ['coalesced', 'coalesced', 'coalesced']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.captured.length, 0);
  release();
  await held;
  assert.equal(await first, 'sent');
  assert.equal(state.captured.length, 1);
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].text, /Test Game/);
  assert.equal(state.statuses[0].phase, 'queued');
});

test('working status explains waiting, capture, processing and a failed turn', async () => {
  const { c, state } = setup();
  await c.tick();
  assert.ok(state.statuses.some(s => s.phase === 'responding' && s.game === 'Test Game'));
  await c.tick();
  assert.equal(state.statuses.at(-1).phase, 'cooldown');
  state.clock += 60000;
  await c.tick();
  assert.equal(state.statuses.at(-1).phase, 'unchanged');
  state.hash = BIG;
  state.outcome = { ok: false, kind: 'error', error: { code: 'DEVICE_BUSY' } };
  await c.tick();
  assert.equal(state.statuses.at(-1).error, 'DEVICE_BUSY');
  state.win = BROWSER;
  await c.tick();
  assert.equal(state.statuses.at(-1).phase, 'no-game');
});


test('a queued hotkey cancels when the user switches windows', async () => {
  const { c, state, lock } = setup();
  let release;
  const held = lock.run(() => new Promise(resolve => { release = resolve; }));
  const requested = c.hotkey();
  await new Promise(resolve => setImmediate(resolve));
  state.win = BROWSER;
  release();
  await held;
  assert.equal(await requested, 'window-changed');
  assert.equal(state.captured.length, 0);
  assert.equal(state.sent.length, 0);
});

test('fast mode skips number reading even for a game that explicitly enables it', async () => {
  const { c, state, settings } = setup();
  settings.fastMode = true;
  settings.allowList[0].genre = 'strategy';
  settings.allowList[0].readCounters = true;
  await c.tick();
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].speech, 'device');
  assert.match(state.sent[0].text, /Do not quote exact resource amounts/);
});


test('observations older than five remarks survive a switch to another game', async () => {
  const { c, state, settings } = setup();
  const original = { ...settings.allowList[0] };
  state.outcome = { ok: true, turn: { assistant_text: '这套蓝白衣服真好看。' } };
  await c.hotkey();
  for (let i = 0; i < 6; i++) {
    state.outcome = { ok: true, turn: { assistant_text: `New event ${i}` } };
    await c.hotkey();
  }
  settings.allowList[0] = { ...original, name: 'Other Game' };
  await c.hotkey();
  assert.doesNotMatch(state.sent.at(-1).text, /这套蓝白衣服/);
  settings.allowList[0] = original;
  await c.hotkey();
  assert.match(state.sent.at(-1).text, /<earlier_observations>[\s\S]*这套蓝白衣服真好看。/);
  assert.equal(state.sent.length, 9); // No extra summary or duplicate-check calls.
});

test('silence consumes neither the guide tip nor the observation history', async () => {
  const { c, state, settings } = setup();
  settings.chattyMode = true;
  state.wiki = WIKI;
  state.tip = TIP;
  state.outcome = { ok: true, turn: { assistant_text: '   ' } };
  await c.tick();
  assert.deepEqual(state.used, []);
  assert.equal(await c.tick(), 'unchanged');
  state.clock += settings.cooldownMs;
  await c.tick();
  assert.doesNotMatch(state.sent.at(-1).text, /<last_remarks>|<earlier_observations>/);
});
