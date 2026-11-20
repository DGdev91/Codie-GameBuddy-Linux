import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupGuideNotes, pickTipNotes, wikiSections, TIP_MAX } from '../src/main/guide-notes.mjs';

const EDIT = '<span class="mw-editsection"><span class="mw-editsection-bracket">[</span><a href="/e">编辑</a><span class="mw-editsection-bracket">]</span></span>';
const h = (level, text) => `<h${level}><span class="mw-headline">${text}</span>${EDIT}</h${level}>`;

// BWIKI-style: the boss's name is the first heading, the guide a subsection.
const BOSS = `<div class="mw-parser-output">${h(2, '<big>“恶兆妖鬼”玛尔基特</big>')}
<p><a href="/f" class="image"><img alt="m.png" src="m.png" width="10" /></a><br />玛尔基特是史东薇尔城门口的Boss。<br /></p>
${h(3, '战利品：')}<p><b>6000卢恩</b></p>
${h(3, '玛尔基特的战斗指南')}<p>他会趁你补血时扔飞刀&amp;挥金色大锤<sup class="reference">[1]</sup>。</p>
${h(4, '二阶段')}<p>闪避后&nbsp;反击。</p>
${h(2, '画廊')}<p>攻略图</p></div>`;

test('the page is split into sections by headings, edit links dropped, entities decoded', () => {
  const sections = wikiSections(BOSS);
  assert.deepEqual(sections.map(s => [s.level, s.heading]), [[1, ''], [2, '“恶兆妖鬼”玛尔基特'], [3, '战利品：'], [3, '玛尔基特的战斗指南'], [4, '二阶段'], [2, '画廊']]);
  assert.equal(sections[3].text, '他会趁你补血时扔飞刀&挥金色大锤。');
  assert.equal(sections[4].text, '闪避后 反击。');
});

test('the tip notes are the guide sections and their subsections, each with its heading, nothing else', () => {
  assert.equal(pickTipNotes(BOSS), '玛尔基特的战斗指南: 他会趁你补血时扔飞刀&挥金色大锤。 二阶段: 闪避后 反击。');
});

test('strategy and phases come before the fight overview, and moves last; dialogue never', () => {
  // Fandom-style: the fight's sections under one "Boss Fight" heading.
  const html = `<div class="mw-parser-output"><p>Margit is a boss.</p>${h(2, 'Encounters')}<p>He waits at the castle gate.</p>
${h(2, 'Boss Fight')}<p>HP 4174, weak to bleed.</p>${h(3, 'Moveset')}<p>Delayed cane slam, then a dagger throw.</p>
${h(3, 'Phase 1')}<p>Stay close and punish after his combos.</p>${h(3, 'Environment')}<p>A narrow bridge with chasms.</p>
${h(2, 'Dialogue')}<p>Foul Tarnished, in search of the Elden Ring.</p></div>`;
  assert.equal(pickTipNotes(html), 'Phase 1: Stay close and punish after his combos. Boss Fight: HP 4174, weak to bleed. Environment: A narrow bridge with chasms. Moveset: Delayed cane slam, then a dagger throw.');
});

test('newer MediaWiki headings wrapped in a mw-heading div are found too', () => {
  const html = '<div class="mw-parser-output"><p>A demigod.</p><div class="mw-heading mw-heading2"><h2 id="Strategy">Strategy</h2><span class="mw-editsection">[edit]</span></div><p>Dodge his delayed slam, then punish.</p></div>';
  assert.equal(pickTipNotes(html), 'Strategy: Dodge his delayed slam, then punish.');
});

test('a page without a guide section gives its first text that is not trivia or a gallery', () => {
  const html = '<div class="mw-parser-output"><h2>Gallery</h2><p>Lots of pictures here.</p><h2>Description</h2><p>Your first attack each combat deals 8 additional damage.</p></div>';
  assert.equal(pickTipNotes(html), 'Your first attack each combat deals 8 additional damage.');
});

test('story, ending, trivia and skins are never picked, even when titled like a guide, nor anything under them', () => {
  const html = '<div class="mw-parser-output"><p>A boss of the castle gate.</p><h2>剧情攻略</h2><p>最后他会背叛你，结局是这样的。</p><h3>第二阶段</h3><p>他其实是你的父亲，最后会死去。</p><h2>Trivia/Tips</h2><p>Fun facts that are not tips at all.</p></div>';
  assert.equal(pickTipNotes(html), 'A boss of the castle gate.');
});

test('contents boxes, scripts, styles, references and video link lists are dropped', () => {
  const html = `<div class="mw-parser-output"><div id="toc" class="toc"><ul><li><span class="toctext">1 打法攻略</span></li></ul></div><style>.x{color:red}</style><script>var a = 1 < 2;</script>
${h(2, '打法攻略')}<ul><li>B站：<a class="external text" href="https://b23.tv/x">【百足虫】速杀打法</a> - 验证码233， 2024-10-04.</li></ul>
${h(2, '招式')}<p>蜷身翻滚后会扑击，侧闪即可。</p><ol class="references"><li>来源</li></ol></div>`;
  assert.equal(pickTipNotes(html), '招式: 蜷身翻滚后会扑击，侧闪即可。');
});

test('long notes are cut to TIP_MAX characters; a page with no text gives nothing', () => {
  const html = `<div class="mw-parser-output"><h2>技巧</h2><p>${'快'.repeat(2000)}</p></div>`;
  const notes = pickTipNotes(html);
  assert.equal([...notes].length, TIP_MAX);
  assert.match(notes, /…$/);
  assert.equal(pickTipNotes(''), '');
  assert.equal(pickTipNotes('<div class="mw-parser-output"><h2>技巧</h2><p>短</p></div>'), '');
});

test('lookupGuideNotes asks the wiki for the rendered page and returns its tip notes', async () => {
  const calls = [];
  const fetch = async url => {
    calls.push(new URL(url));
    return { ok: true, json: async () => ({ parse: { title: '玛尔基特', text: BOSS } }) };
  };
  assert.deepEqual(await lookupGuideNotes({ api: 'https://wiki.biligame.com/eldenring/api.php', title: '玛尔基特', fetch }), { text: '玛尔基特的战斗指南: 他会趁你补血时扔飞刀&挥金色大锤。 二阶段: 闪避后 反击。' });
  const p = calls[0].searchParams;
  assert.equal(calls[0].pathname, '/eldenring/api.php');
  assert.deepEqual([p.get('action'), p.get('page'), p.get('prop'), p.get('redirects')], ['parse', '玛尔基特', 'text', '1']);
});

test('a page with no tip text gives null', async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ parse: { title: 'X', text: '<div class="mw-parser-output"></div>' } }) });
  assert.equal(await lookupGuideNotes({ api: 'https://x.fandom.com/api.php', title: 'X', fetch }), null);
});
