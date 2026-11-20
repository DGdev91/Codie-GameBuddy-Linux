import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuides, TIP_REPEAT_MS } from '../src/main/guides.mjs';

const WIKI = { source: 'Elden Ring Wiki', api: 'https://eldenring.fandom.com/api.php', terms: [['Margit, the Fell Omen', 'Margit, the Fell Omen'], ['Godrick', 'Godrick the Grafted']] };

// Fake lookup caches: `values` by key, `settledKeys` marks lookups that have finished.
function cache(keyOf, values = {}, settledKeys = new Set()) {
  const asked = [];
  return {
    asked,
    values,
    settledKeys,
    get: args => { asked.push(args); return values[keyOf(args)] ?? null; },
    settled: args => settledKeys.has(keyOf(args)) || keyOf(args) in values,
  };
}

function setup() {
  const state = { clock: 1_000_000, logs: [] };
  const gameInfo = cache(({ name, locale }) => `${locale}:${name}`);
  const guideWikis = cache(({ name, locale, url }) => `${locale}:${name}:${url}`);
  const guideNotes = cache(({ api, title }) => `${api}:${title}`);
  const guides = createGuides({ gameInfo, guideWikis, guideNotes, now: () => state.clock, log: line => state.logs.push(line) });
  return { guides, state, gameInfo, guideWikis, guideNotes };
}

const GAME = { process: 'eldenring.exe', name: 'ELDEN RING' };

test('the guide wiki is looked up once the game background has an answer, with its title', () => {
  const { guides, gameInfo, guideWikis } = setup();
  assert.equal(guides.wikiFor(GAME, 'en'), null);
  assert.equal(guideWikis.asked.length, 0); // the background is still being looked up
  gameInfo.values['en:ELDEN RING'] = { source: 'Wikipedia', title: 'Elden Ring', text: 'An action role-playing game.' };
  guideWikis.values['en:ELDEN RING:'] = WIKI;
  assert.equal(guides.wikiFor(GAME, 'en'), WIKI);
  assert.deepEqual(guideWikis.asked, [{ name: 'ELDEN RING', locale: 'en', url: '', title: 'Elden Ring' }]);
});

test('a game with no background still gets a guide lookup by its name', () => {
  const { guides, gameInfo, guideWikis } = setup();
  gameInfo.settledKeys.add('en:ELDEN RING');
  guides.wikiFor(GAME, 'en');
  assert.deepEqual(guideWikis.asked, [{ name: 'ELDEN RING', locale: 'en', url: '', title: null }]);
});

test("a game's own wiki address is looked up at once", () => {
  const { guides, guideWikis } = setup();
  guides.wikiFor({ ...GAME, guideWiki: 'https://eldenring.fandom.com/wiki/Elden_Ring_Wiki' }, 'zh-CN');
  assert.deepEqual(guideWikis.asked, [{ name: 'ELDEN RING', locale: 'zh-CN', url: 'https://eldenring.fandom.com/wiki/Elden_Ring_Wiki', title: null }]);
});

test('the tip is the first name on screen whose page has notes', () => {
  const { guides, guideNotes, state } = setup();
  guideNotes.values[`${WIKI.api}:Godrick the Grafted`] = { text: 'Dodge the axe sweep.' };
  const tip = guides.tipFor(['Margit, the Fell Omen', 'GODRICK'], WIKI);
  assert.deepEqual(tip, { name: 'Godrick', title: 'Godrick the Grafted', source: 'Elden Ring Wiki', text: 'Dodge the axe sweep.' });
  assert.deepEqual(guideNotes.asked.map(a => a.title), ['Margit, the Fell Omen', 'Godrick the Grafted']);
  assert.deepEqual(state.logs, ['guide tip: Godrick']);
  assert.equal(guides.tipFor(['nothing here'], WIKI), null);
});

test('a page whose tip was given is not offered again for TIP_REPEAT_MS', () => {
  const { guides, guideNotes, state } = setup();
  guideNotes.values[`${WIKI.api}:Godrick the Grafted`] = { text: 'Dodge the axe sweep.' };
  const tip = guides.tipFor(['Godrick'], WIKI);
  assert.ok(guides.tipFor(['Godrick'], WIKI)); // offered, but not given yet
  guides.used(tip);
  state.clock += TIP_REPEAT_MS - 1;
  assert.equal(guides.tipFor(['Godrick'], WIKI), null);
  state.clock += 1;
  assert.ok(guides.tipFor(['Godrick'], WIKI));
});

test('status tells the settings window the source, whether it is still looking, and the detected genre', () => {
  const { guides, gameInfo, guideWikis } = setup();
  assert.deepEqual(guides.status(GAME, 'en'), { source: null, looking: true, genre: null });
  gameInfo.values['en:ELDEN RING'] = { source: 'Wikipedia', title: 'Elden Ring', text: 'An action role-playing game.' };
  assert.deepEqual(guides.status(GAME, 'en'), { source: null, looking: true, genre: 'action' });
  guideWikis.values['en:ELDEN RING:'] = WIKI;
  assert.deepEqual(guides.status(GAME, 'en'), { source: 'Elden Ring Wiki', looking: false, genre: 'action' });
  guideWikis.settledKeys.add('en:Other:');
  gameInfo.settledKeys.add('en:Other');
  assert.deepEqual(guides.status({ process: 'o.exe', name: 'Other' }, 'en'), { source: null, looking: false, genre: null });
});
