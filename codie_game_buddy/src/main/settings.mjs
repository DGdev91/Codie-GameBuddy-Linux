import fs from 'node:fs';
import path from 'node:path';
import { GENRES } from '../shared/genres.mjs';
import { LANGUAGES } from './i18n.mjs';

// User settings (spec §4.3), kept in settings.json under userData.

export const DEFAULTS = Object.freeze({
  commentaryEnabled: true,
  allowList: Object.freeze([]),
  sampleMs: 3000,
  cooldownMs: 60000,
  changeThreshold: 12,
  hotkey: 'Ctrl+Alt+G',
  language: 'system',
  avoidInterrupting: true,
  chattyMode: false,
  guideTips: true,
  fastMode: true,
  saveToHistory: false,
});

const RANGES = Object.freeze({ sampleMs: [1000, 30000], cooldownMs: [15000, 600000], changeThreshold: [1, 64] });
// Linux also takes native programs, which have no .exe.
const EXE_NAME = process.platform === 'linux' ? /^[^\\/:*?"<>|]+$/ : /^[^\\/:*?"<>|]+\.exe$/i;
export const MAX_GAMES = 100;
const MAX_NAME = 80;
const MAX_HOTKEY = 64;
const MAX_WIKI_URL = 300;
// A character is asked to stay within 600 characters (the settings page
// counts them) but is only refused past this: a whole turn's text may not
// exceed 16,000 characters (codie-host chat turns), and the prompt needs the rest.
export const MAX_PERSONA = 4000;
const AUTO_GENRE = 'auto';

const inRange = ([lo, hi]) => v => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);

// A game's genre: one of GENRES, or 'auto' (null) for the one its background
// names; undefined when invalid.
const genreOf = v => (v === undefined || v === AUTO_GENRE ? null : GENRES.includes(v) ? v : undefined);

// A game's guide wiki address: an https URL, or '' for the one found by the
// game's name; undefined when invalid.
function wikiUrlOf(v) {
  if (v === undefined) return '';
  if (typeof v !== 'string') return undefined;
  const url = v.trim();
  if (!url) return '';
  if (url.length > MAX_WIKI_URL) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

// The character Codie plays while commenting on a game, in the user's own
// words: '' for Codie itself; undefined when invalid.
function personaOf(v) {
  if (v === undefined) return '';
  if (typeof v !== 'string') return undefined;
  const persona = v.trim();
  return persona.length > MAX_PERSONA ? undefined : persona;
}

// The list as { process, name, genre?, guideWiki?, persona?, readCounters?, off? }
// entries (the defaults left out), or undefined when any entry is invalid.
// `readCounters` is set only where the user chose against the genre's default
// (shared/genres.mjs readsCounters). Games may
// share a program; of those, the first not switched off is the one commented
// on (trigger.mjs), and `off: true` keeps the others for later.
function normalizeAllowList(v) {
  if (!Array.isArray(v) || v.length > MAX_GAMES) return undefined;
  const seen = new Set();
  const out = [];
  for (const g of v) {
    const process = typeof g?.process === 'string' ? g.process.trim() : '';
    const name = typeof g?.name === 'string' ? g.name.trim() : '';
    const genre = genreOf(g?.genre);
    const guideWiki = wikiUrlOf(g?.guideWiki);
    const persona = personaOf(g?.persona);
    const key = `${process.toLowerCase()}\n${name.toLowerCase()}`;
    if (!EXE_NAME.test(process) || !name || name.length > MAX_NAME || seen.has(key)) return undefined;
    if (genre === undefined || guideWiki === undefined || persona === undefined) return undefined;
    if (g.off !== undefined && typeof g.off !== 'boolean') return undefined;
    if (g.readCounters !== undefined && typeof g.readCounters !== 'boolean') return undefined;
    seen.add(key);
    out.push({ process, name, ...(genre ? { genre } : {}), ...(guideWiki ? { guideWiki } : {}), ...(persona ? { persona } : {}), ...(g.readCounters !== undefined ? { readCounters: g.readCounters } : {}), ...(g.off ? { off: true } : {}) });
  }
  return out;
}

const NORMALIZERS = {
  commentaryEnabled: v => (typeof v === 'boolean' ? v : undefined),
  allowList: normalizeAllowList,
  sampleMs: inRange(RANGES.sampleMs),
  cooldownMs: inRange(RANGES.cooldownMs),
  changeThreshold: inRange(RANGES.changeThreshold),
  hotkey: v => (typeof v === 'string' && v.trim() && v.length <= MAX_HOTKEY ? v.trim() : undefined),
  language: v => (LANGUAGES.includes(v) ? v : undefined),
  avoidInterrupting: v => (typeof v === 'boolean' ? v : undefined),
  chattyMode: v => (typeof v === 'boolean' ? v : undefined),
  guideTips: v => (typeof v === 'boolean' ? v : undefined),
  fastMode: v => (typeof v === 'boolean' ? v : undefined),
  saveToHistory: v => (typeof v === 'boolean' ? v : undefined),
};

// Every invalid value falls back to its default and is named in `errors`.
export function validateSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const settings = {};
  for (const [key, normalize] of Object.entries(NORMALIZERS)) {
    const value = src[key] === undefined ? undefined : normalize(src[key]);
    if (src[key] !== undefined && value === undefined) errors.push(key);
    settings[key] = value === undefined ? DEFAULTS[key] : value;
  }
  return { settings, errors };
}

export function loadSettings(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { settings: { ...DEFAULTS }, errors: e.code === 'ENOENT' ? [] : ['file'], firstRun: e.code === 'ENOENT' };
  }
  return { ...validateSettings(raw), firstRun: false };
}

// Writes only fully valid settings, atomically.
export function saveSettings(file, raw) {
  const { settings, errors } = validateSettings(raw);
  if (errors.length) return { settings, errors, saved: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { settings, errors, saved: true };
}
