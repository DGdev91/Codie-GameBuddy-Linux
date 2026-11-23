import { GENRES, countersByGenre } from '../shared/genres.mjs';
import { pairText } from '../shared/pair-text.mjs';
import { translator } from '../shared/translate.mjs';

// The settings page: talks to the main process only through window.buddy.
const $ = id => document.getElementById(id);
const api = window.buddy;
// While a game's guide wiki is being looked up, its state is asked again.
const GUIDE_POLL_MS = 2000;
const GUIDE_POLLS = 30;
const AUTO_GENRE = 'auto';
const MAX_WIKI_URL = 300;
const MAX_PERSONA = 4000;
// The length a character is asked to stay within; longer ones are kept.
const SUGGESTED_PERSONA = 600;
let games = [];
// { source, looking, genre } per game, as games is ordered (main guides.mjs).
let guideStatus = [];
let guideRound = 0;
let guidePoll = null;
let pairingId = null;
let savedHotkey = '';
let t = translator({});

const text = (el, value) => { el.textContent = value; };
const seconds = ms => String(Math.round(ms / 1000));
const millis = id => Number($(id).value) * 1000;

// `strings`: the message table of the UI language, sent by the main process.
function localize(strings) {
  t = translator(strings);
  for (const el of document.querySelectorAll('[data-i18n]')) text(el, t(el.dataset.i18n));
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  renderGames();
  renderHint();
}

// The basic options only name the hotkey; changing it is an advanced option.
const renderHint = () => text($('hotkey-hint'), t('commentary.hotkey-hint', { hotkey: savedHotkey }));

// Every field that can be invalid is an advanced option: show the user where.
const openAdvanced = () => { $('advanced').open = true; };

function li(label, button) {
  const item = document.createElement('li');
  const span = document.createElement('span');
  text(span, label);
  item.append(span);
  if (button) item.append(button);
  return item;
}

// `state` colours the dot (the tray icon's colour).
function showState({ state, stateText, errorText = '' }) {
  $('status').dataset.state = state;
  text($('status'), stateText);
  text($('last-error'), errorText);
}

// `error`: the save did not happen as asked.
function saveStatus(value, error = false) {
  $('save-status').dataset.kind = error ? 'error' : '';
  text($('save-status'), value);
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  text(b, label);
  b.addEventListener('click', onClick);
  return b;
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  text(o, label);
  return o;
}

// The game with `patch` applied; an unset genre, wiki address or character is
// left out.
function updateGame(i, patch) {
  games = games.map((g, j) => (j === i
    ? Object.fromEntries(Object.entries({ ...g, ...patch }).filter(([, v]) => v !== undefined && v !== ''))
    : g));
}

// "Automatic" names the genre the game's background gave, once it is known.
const autoGenreLabel = status => (status?.genre
  ? t('genre.auto-detected', { genre: t(`genre.${status.genre}`) })
  : t('genre.auto'));

function guideText(status) {
  if (!status) return '';
  if (status.source) return t('games.guide-found', { source: status.source });
  return t(status.looking ? 'games.guide-looking' : 'games.guide-none');
}

function genreField(g, i) {
  const label = document.createElement('label');
  label.className = 'field';
  const caption = document.createElement('span');
  text(caption, t('games.genre'));
  const select = document.createElement('select');
  select.className = 'genre';
  select.replaceChildren(option(AUTO_GENRE, autoGenreLabel(guideStatus[i])), ...GENRES.map(genre => option(genre, t(`genre.${genre}`))));
  select.value = g.genre ?? AUTO_GENRE;
  select.addEventListener('change', () => {
    updateGame(i, { genre: select.value === AUTO_GENRE ? undefined : select.value });
    renderGames(); // the counters switch follows the type
  });
  label.append(caption, select);
  return label;
}

function wikiField(g, i) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'guide-wiki';
  input.maxLength = MAX_WIKI_URL;
  input.placeholder = t('games.wiki-placeholder');
  input.value = g.guideWiki ?? '';
  input.addEventListener('change', () => {
    updateGame(i, { guideWiki: input.value.trim() || undefined });
    refreshGuides();
  });
  return input;
}

// The character Codie plays while commenting on this game: folded away until
// the user opens it, with the heading saying whether one is set.
function personaField(g, i) {
  const box = document.createElement('details');
  box.className = 'persona-box';
  const summary = document.createElement('summary');
  const state = document.createElement('span');
  state.className = 'note persona-state';
  const input = document.createElement('textarea');
  input.className = 'persona';
  input.rows = 8;
  input.maxLength = MAX_PERSONA;
  input.placeholder = t('games.persona-placeholder');
  input.value = g.persona ?? '';
  const count = document.createElement('p');
  count.className = 'note persona-count';
  const showState = () => text(state, t(input.value.trim() ? 'games.persona-set' : 'games.persona-unset'));
  const showCount = () => {
    const length = input.value.trim().length;
    text(count, t('games.persona-count', { count: length, suggested: SUGGESTED_PERSONA }));
    count.classList.toggle('over', length > SUGGESTED_PERSONA);
  };
  input.addEventListener('input', showCount);
  input.addEventListener('change', () => {
    updateGame(i, { persona: input.value.trim() || undefined });
    showState();
  });
  showState();
  showCount();
  summary.append(t('games.persona'), state);
  box.append(summary, input, count);
  return box;
}

// Whether the game's resources are read before each remark: as its type has
// it, until the user chooses otherwise; a choice that agrees with the type
// is not kept, so it goes on following the type.
function countersField(g, i) {
  const byGenre = countersByGenre(g.genre ?? guideStatus[i]?.genre ?? 'other');
  const label = document.createElement('label');
  label.className = 'switch read-counters';
  label.title = t('games.read-counters-hint');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = g.readCounters ?? byGenre;
  input.addEventListener('change', () => updateGame(i, { readCounters: input.checked === byGenre ? undefined : input.checked }));
  const track = document.createElement('span');
  track.className = 'track';
  const caption = document.createElement('span');
  text(caption, t('games.read-counters'));
  label.append(input, track, caption);
  return label;
}

// Switches game `i` on and the other games of its program off: a program
// shows one game at a time.
function activate(i) {
  const exe = games[i].process.toLowerCase();
  games = games.map((g, j) => {
    if (g.process.toLowerCase() !== exe) return g;
    const { off: _, ...on } = g;
    return j === i ? on : { ...on, off: true };
  });
}

// Whether the game is the one commented on for its program.
function onSwitch(g, i) {
  const label = document.createElement('label');
  label.className = 'switch game-on';
  label.title = t('games.on');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !g.off;
  input.addEventListener('change', () => {
    if (input.checked) activate(i);
    else updateGame(i, { off: true });
    renderGames();
  });
  const track = document.createElement('span');
  track.className = 'track';
  label.append(input, track);
  return label;
}

function gameRow(g, i) {
  const item = li(`${g.name} (${g.process})`, button(t('games.remove'), () => {
    games = games.filter((_, j) => j !== i);
    guideStatus = guideStatus.filter((_, j) => j !== i);
    renderGames();
    refreshGuides();
  }));
  item.classList.add('game');
  item.classList.toggle('off', Boolean(g.off));
  item.prepend(onSwitch(g, i));
  const guide = document.createElement('div');
  guide.className = 'game-guide';
  const status = document.createElement('p');
  status.className = 'note guide-status';
  text(status, guideText(guideStatus[i]));
  guide.append(genreField(g, i), wikiField(g, i), status, countersField(g, i), personaField(g, i));
  item.append(guide);
  return item;
}

function renderGames() {
  $('games-empty').hidden = games.length > 0;
  $('games').replaceChildren(...games.map(gameRow));
}

// Guide states change in place, so a poll never takes the focus from a field.
function renderGuideStatus() {
  $('games').querySelectorAll('li.game').forEach((item, i) => {
    text(item.querySelector('.guide-status'), guideText(guideStatus[i]));
    text(item.querySelector('select.genre option'), autoGenreLabel(guideStatus[i]));
  });
}

// Asks the main process for every game's guide wiki state, and again while
// one is still being looked up; a newer refresh supersedes an older one.
async function refreshGuides(polls = GUIDE_POLLS) {
  clearTimeout(guidePoll);
  const round = ++guideRound;
  let status;
  try {
    status = await api.gameGuides(games);
  } catch {
    return; // the states stay as they were
  }
  if (round !== guideRound) return;
  guideStatus = status;
  renderGuideStatus();
  if (polls > 0 && status.some(s => s.looking)) guidePoll = setTimeout(() => refreshGuides(polls - 1), GUIDE_POLL_MS);
}

// A game added to a program that already has games becomes the one commented
// on; the others stay on the list, switched off.
function addGame(process, name) {
  const same = g => g.process.toLowerCase() === process.toLowerCase() && g.name.toLowerCase() === name.toLowerCase();
  if (!process || !name || games.some(same)) return;
  games = [...games, { process, name }];
  activate(games.length - 1);
  renderGames();
  refreshGuides();
}

function show({ settings, errors = [], state, stateText, errorText, strings }) {
  $('enabled').checked = settings.commentaryEnabled;
  $('chatty').checked = settings.chattyMode;
  $('fast-mode').checked = settings.fastMode;
  $('save-to-history').checked = settings.saveToHistory;
  $('guide-tips').checked = settings.guideTips;
  $('avoid-interrupting').checked = settings.avoidInterrupting;
  $('sample').value = seconds(settings.sampleMs);
  $('cooldown').value = seconds(settings.cooldownMs);
  $('threshold').value = String(settings.changeThreshold);
  $('hotkey').value = settings.hotkey;
  $('language').value = settings.language;
  savedHotkey = settings.hotkey;
  games = settings.allowList;
  guideStatus = [];
  localize(strings);
  refreshGuides();
  showState({ state, stateText, errorText });
  saveStatus(errors.length ? t('save.invalid-file', { fields: errors.join(', ') }) : '', errors.length > 0);
  if (errors.length) openAdvanced();
}

async function refreshRunning() {
  const list = await api.listGames();
  $('running').replaceChildren(...list.map(g => {
    const o = document.createElement('option');
    o.value = JSON.stringify(g);
    text(o, `${g.name} (${g.process})`);
    return o;
  }));
}

async function save() {
  let r;
  try {
    r = await api.saveSettings({
      commentaryEnabled: $('enabled').checked,
      sampleMs: millis('sample'),
      cooldownMs: millis('cooldown'),
      changeThreshold: Number($('threshold').value),
      hotkey: $('hotkey').value,
      language: $('language').value,
      avoidInterrupting: $('avoid-interrupting').checked,
      chattyMode: $('chatty').checked,
      fastMode: $('fast-mode').checked,
      saveToHistory: $('save-to-history').checked,
      guideTips: $('guide-tips').checked,
      allowList: games,
    });
  } catch (e) {
    saveStatus(t('save.failed', { error: e?.message ?? e }), true);
    return;
  }
  if (r.saved) savedHotkey = r.settings.hotkey;
  localize(r.strings);
  if (r.saved) refreshGuides(); // a new language looks the guides up in it
  if (r.saveError) saveStatus(t('save.failed', { error: r.saveError }), true);
  else if (!r.saved) saveStatus(t('save.invalid', { fields: r.errors.join(', ') }), true);
  else if (r.hotkeyError) saveStatus(t('save.done-hotkey-error', { error: r.hotkeyError }), true);
  else saveStatus(t('save.done'));
  if ((!r.saved && !r.saveError) || r.hotkeyError) openAdvanced();
}

// The device list comes merged from codie-host: found devices first, then
// paired ones the scan missed.
async function scan() {
  text($('pair-status'), t('device.scanning'));
  const r = await api.listDevices();
  if (r.error) { text($('pair-status'), pairText(t, r)); return; }
  $('devices').replaceChildren(...r.map(d => (d.found
    ? li(d.host, button(t('device.pair'), () => begin(d.deviceId)))
    : li(d.host))));
  text($('pair-status'), r.length ? '' : t('device.none'));
}

async function begin(id) {
  const r = await api.pairBegin(id);
  text($('pair-status'), pairText(t, r));
  if (r.ok) { pairingId = id; $('pairing').hidden = false; $('code').value = ''; $('code').focus(); }
}

async function confirm() {
  const code = $('code').value.trim();
  if (!/^\d{6}$/.test(code)) { text($('pair-status'), t('pair.code-format')); return; }
  text($('pair-status'), t('device.pairing'));
  const r = await api.pairConfirm(pairingId, code);
  const said = pairText(t, r);
  text($('pair-status'), r.toolsReady ? t('device.ready', { message: said }) : said);
  if (r.ok || r.toolsReady) { pairingId = null; $('pairing').hidden = true; }
}

async function cancel() {
  if (pairingId) await api.pairCancel(pairingId);
  pairingId = null;
  $('pairing').hidden = true;
  text($('pair-status'), t('device.pair-cancelled'));
}

$('save').addEventListener('click', save);
$('manual-add').addEventListener('click', () => {
  addGame($('manual-process').value.trim(), $('manual-name').value.trim());
  $('manual-process').value = '';
  $('manual-name').value = '';
});
$('running-refresh').addEventListener('click', refreshRunning);
$('running-add').addEventListener('click', () => {
  if (!$('running').value) return;
  const g = JSON.parse($('running').value);
  addGame(g.process, g.name);
});
$('scan').addEventListener('click', scan);
$('confirm').addEventListener('click', confirm);
$('cancel').addEventListener('click', cancel);
api.onView(showState);
// A tray toggle changed commentary or chatty mode (only the setting it
// changed is sent): keep that checkbox in step so Save cannot undo it.
const TRAY_SWITCHES = { commentaryEnabled: 'enabled', chattyMode: 'chatty' };
api.onSettings(changed => {
  for (const [key, id] of Object.entries(TRAY_SWITCHES)) {
    if (key in changed) $(id).checked = changed[key];
  }
});

show(await api.getSettings());
refreshRunning();
