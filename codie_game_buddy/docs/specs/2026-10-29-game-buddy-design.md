# codie_game_buddy design

Date: 2026-10-29. Status: approved in brainstorming, pending spec review.

## 1. Goal

A Windows tray app that keeps the player company through a Codie device:

- **Commentary**: while a game is in the foreground, Codie looks at the game window now and then and says a line or two about it (a joke, a cheer), in its own character and voice.
- **Questions**: the player asks Codie by voice ("how do I get past this part?"); Codie's model calls a tool that looks at the game window, and Codie answers in the same turn.

It is a standalone program: it needs no Claude Code or Codex, only codie-host (`codie_host` repo, spec `codie_host/docs/specs/2026-10-26-codie-host-design.md`, decision D3).

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| G1 | Electron tray app, Windows first; macOS later | Node main process can use the codie-host SDK directly; one code base for a later macOS build |
| G2 | Both commentary and questions | User choice |
| G3 | Commentary trigger: sample every few seconds, send only on a large frame change after a cooldown; a global hotkey sends at once | Every send is one cloud vision call plus Codie speaking; a fixed interval talks over menus and idle screens |
| G4 | Capture only the foreground window, and only when its process is on the user's game allow list (the hotkey skips the list) | Keeps browsers, chat apps and other private windows off the cloud |
| G5 | Questions use a **synchronous nested turn**: the `look_at_game` tool sends the screenshot to the device's `chat/turns` (`image_text`, `speech: none`) and returns `assistant_text` as its result | One turn, no vision API key on the computer, reuses the device's cloud vision. Feasibility is unproven, so a spike (phase 0) comes first |
| G6 | All device access goes through codie-host IPC with game_buddy's own client token and scope | codie-host D1/D11: only the daemon holds a device credential |
| G7 | Follow codie_host conventions: ESM `.mjs`, kebab-case file names, English only in code and docs (the UI translation tables in `src/locales/` are the one exception, §4.3), `node:test` | Company project; workspace `CLAUDE.md` |

## 3. Architecture

```
codie_game_buddy (Electron, Windows)
 ├ main process
 │  ├ capture/     foreground window + allow list, window frames (desktopCapturer)
 │  ├ trigger/     sampling, dHash change detection, cooldown, hotkey (pure logic)
 │  ├ commentary/  screenshot + commentary prompt → host.chatTurn(speech: device)
 │  ├ tools/       ext.* look_at_game → host.chatTurn(speech: none) → result
 │  ├ host/        thin wrapper over the codie-host SDK (ToolClient, device routes)
 │  └ settings/    load, validate, save settings.json
 └ renderer        settings window: pairing, allow list, switches, cooldown, hotkey
        │ IPC 127.0.0.1, per-client token + scope
        ▼
 codie-agentd (codie_host) ── HTTP, client credential ──▶ Codie device (clt01)
```

### 3.1 Phases

| Phase | Where | Work | User-visible result |
|---|---|---|---|
| 0 | device + throwaway script | Spike for G5 (§7) | A written answer: nested turn works or not, with latency |
| 1 | codie_host | Device routes and SDK methods (§6) | game_buddy can make Codie look at an image and talk |
| 2 | game_buddy | Tray app, settings, pairing, commentary (§4) | Start an allowed game → Codie comments on it |
| 3 | game_buddy | `look_at_game` tool (§5), shaped by the spike | Ask Codie about the game and get an answer |

Phases 0 and 1 run in parallel; phase 2 needs phase 1; phase 3 needs phases 0 and 1. Each phase gets its own implementation plan.

## 4. Commentary

### 4.1 Loop

Runs in the main process every `sampleMs` (default 3000):

1. **Foreground**: read the foreground window's process name (`get-windows` npm package; Electron has no such API). Skip the tick when commentary is off, the process is not on the allow list, or a turn is in flight.
2. **Sample**: capture that window as a 64×36 thumbnail (`desktopCapturer.getSources({ types: ['window'], thumbnailSize })`, matched by window id) and compute a 64-bit dHash.
3. **Decide** (pure function `shouldSend({ hash, lastSentHash, now, lastSentAt, settings })`): send when the Hamming distance to the last sent frame is ≥ `changeThreshold` (default 12) and `now - lastSentAt ≥ cooldownMs` (default 60000).
4. **Send**: capture the window again at 1280 px wide, encode JPEG (≤ 1 MiB, lower quality until it fits), call `host.chatTurn({ image, text, speech: 'device', interrupt })`. `interrupt` is false when `avoidInterrupting` is on (the default): a device busy in a conversation then fails the turn with `DEVICE_BUSY` instead of ending the conversation (clt01 `interrupt` request field; without it every turn ends the conversation in progress). The hotkey always sends `interrupt: true`: the user asked. The text is the commentary prompt (§4.1.5), with the game's display name, the language (game_buddy's resolved locale: the language setting, or Windows when it follows the system, read per turn) and, for a game on the allow list, its looked-up background (§4.1.1), the glossary names read on the screenshot with their notes (§4.1.2) and a guide tip from its wiki (§4.1.4). The prompt says the screenshot is a few seconds old (about 10 s pass from capture to speech, measured 2026-11-03). Character and voice come from the device's current character.
5. `host.chatTurn` waits as long as codie-host allows (`waitMs: TURN_WAIT_MAX_MS`, 180 s since agentd 36), so a spoken comment has been heard when it resolves; with the 30 s default a remark over 30 s ended the wait early and the next one was refused as busy. A turn still going after 180 s is taken as heard: clt01 puts no time limit on a turn, and one whose end never comes (a lost playback receipt) must not hold the turn lock. Needs codie_host agentd 36. On success record `lastSentHash`, `lastSentAt` and the remark.

### 4.1.1 Game background

`game-info.mjs` looks the allow-list display name up per language: zh-CN tries Moegirlpedia (`zh.moegirl.org.cn`, reachable from mainland China) then zh.wikipedia, en tries en.wikipedia. Per source: MediaWiki `opensearch` for up to 3 titles (Moegirlpedia refuses anonymous `list=search`), then `prop=extracts` as plain text; the first article whose text mentions a game wins. The background is the intro plus the first top-level section titled like background, world, story or setting (never one titled ending), at most 600 characters. Requests go through Electron `net.fetch` (system proxy), 8 s timeout each.

The same lookup builds the game's **glossary**: of the templates the article uses (`prop=templates`), the navboxes whose name starts like the game's title (`Template:影之刃系列` for 影之刃零, not `Template:中国电子游戏作品`), at most 4; their links (`prop=links`) are the names of people, places and events, disambiguation suffixes dropped, at most 400. The game, the series and names shorter than 2 CJK or 4 Latin characters are left out. A failed glossary keeps the background. Moegirlpedia refuses anonymous `list=categorymembers`, `action=parse` and revision content, so navboxes are the way in; some games load theirs another way (原神 yields one name).

`lookup-cache.mjs` caches results in `game-info.json` under userData, keyed by language and lower-cased name. A turn never waits on it: a game with nothing cached starts a lookup in the background and gets its background from a later turn. A miss or network failure is cached too and retried after 24 h. The prompt names the source.

### 4.1.2 Names on screen

For a game whose background has a glossary, the frame being sent is OCR'd first, by Windows' built-in OCR (`Windows.Media.Ocr`, the OCR language of game_buddy's locale: `zh-Hans-CN` or `en-US`). `ocr.mjs` runs `ocr-helper.ps1` in one resident Windows PowerShell 5.1 process (PowerShell 7 cannot load WinRT types), started on the first frame, the script passed with `-EncodedCommand` so it can be read out of an asar; requests are `<id> <language tag> <base64 JPEG>` lines on stdin, answers JSON lines on stdout. OCR takes about 50–100 ms per 1280 px frame (the helper's first start about 300 ms); a missing OCR language, an error, no answer within 3 s or a dead helper give no text and the turn goes on without names. Measured on 影之刃零 video frames: subtitles came out 50–90 % right per line and the speaker name 玉儿 matched on about half the frames; OCR on a full-resolution capture was 6× slower and no better, so OCR uses the 1280 px frame.

`screen-terms.mjs` matches the text against the glossary, letters and digits only: names of 3 or more characters anywhere, a 2-character name only on a line of its own (a speaker label, give or take 2 characters of OCR noise), since many are everyday words too (黑神话：悟空 has 不能). A name inside a longer matched one does not count again. Each matched name's page is described by its intro and profile section (at most 200 characters), looked up in the background and cached in `game-terms.json`; a page with no text (玉儿) gives no description. Up to 3 described names, in screen order, go into the prompt with their notes. The hotkey does the same for a game on the allow list. OCR text stays on the computer; only page titles of matched names go to the wiki.

### 4.1.3 Chatty mode

`chattyMode` (default off; a switch in the settings window's basic options and a tray checkbox) makes Codie talk on. A `speech: device` turn completes only once the device has played it (clt01 `chatturn/turn.go`), so after a sent turn the loop ticks again at once (`nextTickMs`) and `shouldSend` skips the change check and the cooldown: Codie comments whether the scene changed or not. Chatty turns always send `interrupt: false`, whatever `avoidInterrupting` says, or the user could not get a word in. When the user is talking to Codie (the turn is refused with `DEVICE_BUSY`, or the user cut it off: cancelled with `DEVICE_INTERRUPTED`) the next tick tries again (`sampleMs`), so the remarks resume a few seconds after the conversation; any other failure waits one cooldown as in §4.2. A sent turn in which Codie said nothing (empty `assistant_text`: the model only called a tool, and the device completes the turn without playback) is not followed at once but waits one cooldown, as speaking is what paces chatty mode. When the last turn was a remark, the prompt adds that this one follows right after it; the last five remarks it quotes (§4.1 step 4) keep a still scene from getting the same remark again. The hotkey is unchanged.

Every commentary turn, chatty or not, also lands in the user's chat with Codie (measured 2026-11-03/04): the device writes three chat history records per remark (the screenshot, the prompt as the user's message, the reply) and shows them in the chat list; Codie's context holds only the last 46 records (`promptChatHistoryFetchLimit`), so about 15 remarks push the user's own conversation out of it, about 4 minutes in chatty mode; and nearly every remark starts a cloud memory extraction that takes the prompt as the user's words, answers with a remark instead of memory actions and fails (0 of 28 in the logs). Chatty mode multiplies this by four or more. game_buddy cannot keep a turn out of the history itself; it already quotes its own last remarks, so it needs no device history. The clt01 owner is asked for a `chat/turns` option that keeps a turn out of the chat history and memory upkeep while still reading them (request 1 of `codie_host/docs/handoff/2026-11-04-clt01-chatty-mode.md`); every commentary turn will send it, and chatty mode is released only once the device has it (user decision 2026-11-04). Built as `retention` (clt01 PR #206, merged 2026-11-05; codie-host agentd 37): every commentary turn, ticked or from the hotkey, sends `retention: "none"`, so the device keeps no history record, screenshot or memory upkeep for it and the reply comes back only in `assistant_text`. Device firmware without it rejects every such turn (INVALID_INPUT), so this build goes only to devices already updated (user decision 2026-11-05).

A commentary turn also reaches the model with every tool of an ordinary chat on offer, the ext.* tools included. Measured 2026-11-12 on YGKJ2511921S00043 (cloud provider): in 5 of 48 turns the model called `ask_agent` to have the user's coding agent "look at the game screen". With no Claude Code or Codex session open the call was refused, and the remark then came out as "that tool did not run" or as an English error sentence; with a session open it would have started a task on the user's computer. A remark is one spoken line and needs no tool, so every commentary turn sends `tools: "none"` (clt01 `chat/turns` option `tools`, codie-host agentd 47): the device declares no tool to the model for that turn. Device firmware without the option rejects every such turn (INVALID_INPUT).

There is still a gap between remarks: the device runs one turn at a time, and a turn sent while one is playing is refused or cuts it off. Measured on YGKJ on 2026-11-03 (26 remarks in a row, device `local_harness`): from the end of one remark to the start of the next, median 12 s, 7.6–22 s. A typical gap: the device reports the turn done about 1.6 s after playback ends; game_buddy's capture, OCR and upload take 0.7–3.2 s; the first LLM sentence 2.2 s; the first TTS audio 2.2 s; the device plays a sentence only once all its audio has arrived, 2 s at first and 5–11 s later in the run. Only the capture is game_buddy's. Closing the gap needs the device to queue a turn behind the one playing, so the next remark is made while this one plays; requested from the clt01 owner (user decision 2026-11-04, `codie_host/docs/handoff/2026-11-04-clt01-chatty-mode.md`), together with playing a sentence while its audio streams in.

### 4.1.4 Guide tips

With `guideTips` on (the default), a game on the allow list gets a tip from its guide wiki when a name from that wiki is on screen: a boss, unit, weapon, hero, card or relic. Tips come only from a source, never from the model's own knowledge, which told the player to press R1 with no such prompt on screen (§4.1); a game without a wiki found keeps plain commentary (user decisions 2026-11-10). A frame with no wiki name on screen (an RTS with nothing selected) gets no tip.

**Finding the wiki** (`guide-wiki.mjs`; cached in `guide-wikis.json` by language, lower-cased name and wiki address, like §4.1.1):

1. The game's own wiki address from the settings: any https page of a MediaWiki. Its `api.php` is tried under the first path segment (BWIKI's `/eldenring/`, a Fandom language's `/zh/`), at the root and under `/w/`; the first that answers `siteinfo` wins. Used in either language.
2. Else in Chinese, the BWIKI the bilibili portal lists for the game. The portal (`wiki.biligame.com/wiki/api.php`) has a page per sub-wiki whose content holds `游戏名=` and `WIKI域名=`; it is searched with `prefixsearch` by the game's name, also without a trailing number or subtitle, and the 游戏名 must equal the background article title or the allow-list name (letters and digits only). The sub-wiki must answer `siteinfo`: closed ones redirect to the portal (星际争霸2, 帝国时代4 and 博德之门3 on 2026-11-10).
3. Else in English, `<slug>.fandom.com` then `<slug>.wiki.gg`, the slug being the name's letters and digits, also without a trailing number or a Roman numeral after a space; the site name must start with the slug, so "control" does not pick the Mind Control Wiki.

Without an address the search waits for the game's background lookup to finish, since its article title names the game better than a window title. Requests go through `net.fetch`: Fandom refuses Node's own `fetch` (Cloudflare) but answers Electron's. Measured 2026-11-10 on nine games, one or two per genre: Chinese found all nine portal entries, three of them closed and 炉石传说's nearly empty; English found all nine.

**Guide glossary**: every article title of the wiki (`list=allpages`, namespace 0, no redirects, 500 per request, at most 60 requests), without subpages (`虎先锋/数据`) or the main page, by the glossary rules of §4.1.2 (`game-info.mjs termOf`). BWIKI's firewall (Tencent EdgeOne) answers bursts with HTTP 514 or 567, and after a few hundred requests in an hour blocked every BWIKI request from this computer for a while (2026-11-10, during these measurements). So all guide lookups, of every game and page, share one queue per host whose requests start at least 1 s apart (`host-throttle.mjs`), and a refused request (429 or 5xx) is asked again after 3, 10 and 30 s; a lookup that still fails counts as a miss and is retried after 24 h (§4.1.1). Reading takes 6–52 s per game, once. A glossary from the wiki's categories was tried and dropped: category names differ per wiki, and BWIKI's 艾尔登法环 boss pages carry none.

**Tip notes** (`guide-notes.mjs`; cached in `guide-notes.json` per wiki and page): the page's rendered HTML (`action=parse`; BWIKI has no plain-text extracts), without the contents box, edit links, references, navboxes, galleries, links out and list items holding them (BWIKI's video lists), split into sections by heading (`h2`–`h6`, or a newer MediaWiki's `div.mw-heading`). Sections rank by heading: strategy, tips, weaknesses, resistances and phases first (攻略, 打法, 技巧, 指南, 弱点, 耐性, 阶段, Strategy, Tips, Phase …); the fight, mechanics and synergy next; moves and skills last. A subsection ranks as its section unless its own heading says otherwise. Story, ending, trivia, gallery, skins, changelog, dialogue, references, and anything under them, never count. The ranked sections, best first and each with its heading, are the notes, at most 600 characters; a page without any gives its first other text. Taking only sections titled like a guide was tried and dropped: they exist on 0–70 % of pages, Fandom's Elden Ring puts the fight under Phase 1 and Phase 2, and BWIKI's 打法攻略 is often a list of video links.

**Per frame**: the OCR text (§4.1.2) is read once when either glossary is not empty, and matched against the guide glossary as against the background one. The tip is the first name, in screen order, whose page has notes and whose tip was not given in the last 5 minutes (`TIP_REPEAT_MS`, so a long boss fight gets a tip now and then, not in every remark). A page seen for the first time gets its notes from a later turn on, as in §4.1.2. A tip counts as given once its turn succeeds. The prompt adds "A tip you can pass on, from <wiki>'s page on <name>: <notes>" and asks for one short, practical tip from it, of the genre's kind, using only what the notes say (or none if they say nothing useful now), in a few words during a fight, naming no button, key or control, and nothing past where the player is.

**Genre** (`genre.mjs`): the one set for the game, else the first genre word in its background (动作角色扮演 is action), else `other`. Each asks for its own kind of tip: action (an enemy or place: dangerous attacks, openings, weak points), strategy (using or countering a unit or building), rpg (the quest, place or character), shooter (a weapon, agent or map), moba (a champion or hero, or an item), card (a card or relic and what it works with), other (anything practical). Moegirlpedia calls 英雄联盟 即时战略, so the genre can be set per game.

Real-network check on 2026-11-10, with the OCR text given: 艾尔登法环 (BWIKI 战斗指南), 黑神话：悟空 (四灾耐性, 二阶段), 无畏契约 (技巧), 英雄联盟 (the whole page: its headings are not HTML headings, so the notes start with its breadcrumbs), Elden Ring (Fandom Phase 1) and Slay the Spire (Strategy, Synergy) all gave notes; the prompt stays under 3,000 characters.

Privacy: the game's name goes to the portal or the guessed sites, and only page titles of names matched on screen go to the wiki; the screen text stays on the computer.

### 4.1.5 The commentary prompt

`prompt.mjs` builds the prompt as five labelled blocks: **Situation** (the game, the screenshot, chatty mode's "right after your last remark"), **Notes**, **Task**, **Rules** and **Voice**. The notes are tagged reference material (`<background>`, `<on_screen>`, `<tip_notes>`, `<last_remarks>`, `<worn_words>`), declared not to be instructions; angle brackets are taken out of looked-up text and quoted remarks so they cannot close a tag.

**Only measured rules** (user decision 2026-11-10). Until then the prompt had grown a prohibition for every complaint (never describe the screen, a few punchy words in a fight, no comment on the name, no ending on a hope or a worry, no "keeping you company", a different opening word, nothing of Codie's own preferences, no introducing itself, no moralising); the remarks got stiffer and still repeated themselves, and a run on the device showed the model ignoring most of them anyway. They are gone. What stays has a measured reason: never name a button, key or control (it told the player to press R1, square and triangle with no such prompt on screen, 2026-11-04); no plot twists, ending or anything past where the player is; of the game's world, story and characters only what the notes or the screen show (allowed to draw on what it knew, it made lore up: dragons that were once people, a place name that does not exist, 2026-11-10; user decision the same day); no tool calls (a commentary turn called the computer agent and then said aloud that nobody answered, 2026-11-10); spoken words only, since everything is read aloud; the language; tips only from the tip notes (§4.1.4); and no example line, since Codie copied one. A new rule needs a frame that reproduces the problem in the evaluation below, and must not make the repetition numbers worse.

**Angles** (`angles.mjs`). The model starts every turn from nothing and a scene barely changes between remarks, so the loop, not the model, moves the remarks along: each ticked remark without a tip takes one angle, never one of the last two taken on that game, picked at random among the rest. `moment`: react to what is happening, as a friend on the couch would; `world`: one thing from the background notes about the world, story or characters that ties in with the screen, open only to a game with a looked-up background; play angles: how the player is doing in one side of their game, going by what the screen shows; `mood`: how the scene strikes it. The play angles are the genre's (§4.1.4, `genre.mjs`), so a game is talked about as its kind: strategy has economy, army, unit handling in a fight, base and progress, and the map; action the fight, holding up, and the route; rpg the quest, the character or party, and choices; shooter aim, positioning, and the round; moba the lane, the lead, and team fights and objectives; card the hand, the deck, and the enemy's next move; a game of no known genre has the one general angle (what they pulled off, how they play, where it goes wrong). Before this the genre shaped only the guide tip, and an RTS never heard of its economy or army (user feedback 2026-11-10). A remark with a guide tip passes the tip on instead and leaves the angles where they were. Each remark is one or two short sentences built on one concrete thing on screen or in the notes.

**Not repeating.** The last five remarks on the same allow-list game are quoted (the turns' `assistant_text`, newest first, kept in memory; an unlisted window from the hotkey gets and adds none), with the ask to say something they have not said and to start differently: on a still scene the model once said a remark word for word twice in a row (2026-11-03), and the device history cannot hold the prompts (clt01 drops any history message over 1200 bytes). `worn.mjs` also names up to six pieces of wording that two or more of those remarks share (Latin words of five letters or more; runs of two to eight characters in scripts written without spaces; of two that overlap, the more used), to be done without this time: with the remarks quoted alone, the same address or noun still came back in up to every remark of a run.

**Hotkey.** The user asked, so the prompt says so and asks for Codie's take on the moment in two or three sentences: the one thing on screen that matters most and what it makes of it. No angle; the tip, the last remarks and the worn words apply as above.

**Evaluation** (`scripts/eval-commentary.mjs`, `scripts/eval-metrics.mjs`). `node scripts/eval-commentary.mjs --shots <dir> [--src <dir>] [--rounds 12]` runs the real commentary loop in chatty mode on fixed screenshots (`<dir>/shots.json`), each as a still scene, against the paired device, silently (`speech: none`, `retention: none`); `--src` runs another checkout's loop as the baseline. Per frame it prints the remarks and counts word-for-word duplicates, remarks starting like an earlier one, each remark's bigram similarity to the closest earlier one, and the mean length. game_buddy must be closed (both register as the same client).

Measured 2026-11-10 on YGKJ, three frames (艾尔登法环, 杀戮尖塔, 哈迪斯; 420 px Wikipedia screenshots) of 12 remarks each, old prompt → this one: duplicates 1 → 0; same opening 6 → 3; wording found in a third or more of a frame's remarks 8 pieces → 5; mean length 29–40 → 45–49 characters. Not better: the remarks are longer, hit points are mentioned in 18 of 36 remarks against 10 (the screen is no longer off limits), and the character says "Master" in 5 Chinese remarks against none. The frames are small and few. A second run the same day on four real 1280 px frames of 帝国时代4 (a replay, genre strategy, with the play angles and the notes-only lore rule in), 12 remarks each: the old prompt mostly retold the background notes (朝代 in 7 of one frame's 12 remarks, and 8 of another's 12 took up one subtitle line), while this one spoke of resources, population, army make-up, scouting and unit handling from the screen; wording found in a third or more of a frame's remarks 11 pieces → 7; duplicates none either way; same opening 5 → 7; mean length 41–48 → 46–59 characters. Still open: the model misreads small numbers on the HUD (it said 1,600 gold with 318 on screen), remarks are longer than before, and the form of address drifts (主人, Master, 师傅).

The **hotkey** (default `Ctrl+Alt+G`) captures the current foreground window and sends at once, skipping the allow list, change and cooldown checks; it still waits for a turn in flight.

Only one turn is in flight at a time: commentary, hotkey and `look_at_game` share one lock.

### 4.1.6 Reading the resources first

With `readCounters` on (the default), a remark takes two turns on the same screenshot. The first is silent (`speech: none`, `retention: none`, `tools: none`) and asks the model to list the resources the player has, one per line as `name=number`. Its answer is parsed (`parseCounters`, at most 12 lines of that shape; anything else is dropped) and quoted in the remark's notes as `<counters>`, with a rule to take an amount and what it counts from there. A read the device refuses ends the remark the way a refused remark does (§4.2); a read that names no resource leaves the remark as it was.

Why two turns. Measured 2026-11-13 on YGKJ2511921S00043 (`local_harness`, Qwen `qwen3.7-plus` without thinking, 1280 px frames of Age of Empires IV, the economy angle, 12 remarks each):

| Remark | Resources named right |
|---|---|
| The prompt of §4.1.5 alone | 5 / 12 ("over a thousand wood" for 1179 food) |
| Plus a rule to name an amount by its icon | 8 / 12 |
| Plus a rule to read every counter first and mention two at most | 9 / 12 |
| Plus a rule to read every counter first | 11 / 12, but every remark recites all four amounts |
| Two turns, the amounts quoted in the notes | 12 / 12 (three frames) |

The model reads an amount under the right name only when it writes every one out: the silent turn alone got the four resources right in 48 of 48 on one frame and 12 of 12 across three. The same model and prompt called straight through the provider's API, without the device's character prompt, named them right in 24 of 24 remarks, so a result measured off the device does not carry over.

The read asks for resources only. Asked for every counter on screen, the model also listed population and unit counts under guessed names ("villagers = 1/7"), and 3 of 12 remarks then repeated the guess.

Cost: one more turn per remark, about 2.3 s (median; 4.7 s for both turns with the remark unspoken) and about twice the model usage.

### 4.2 Errors

| Case | Behavior |
|---|---|
| `DEVICE_BUSY`, `DEVICE_BLOCKED`, `AMBIENT_MODE_BLOCKED` (device in a conversation, screen off, ambient mode), at admission or as the failed turn's code | Drop the frame; do not retry it. `lastSentAt` is updated (the next try waits one cooldown), `lastSentHash` is not |
| Daemon not running | The SDK starts it (`ensureDaemon`) |
| Not paired, or client pending approval | Tray icon yellow; the menu says to pair in settings: pairing from game_buddy also approves it (codie_host, 2026-10-30) |
| Device offline, network error | Tray icon grey; the loop keeps running and tries once per cooldown, so it notices the device coming back |
| Any other turn error | Logged with its code; the next try waits one cooldown |

### 4.3 Settings

`app.getPath('userData')/settings.json`, validated on load and save; invalid values fall back to defaults and are reported in the settings window.

| Key | Default | Range |
|---|---|---|
| `commentaryEnabled` | `true` | boolean |
| `allowList` | `[]` | list of `{ process, name }`; a program and name pair appears once |
| `sampleMs` | 3000 | 1000–30000 |
| `cooldownMs` | 60000 | 15000–600000 |
| `changeThreshold` | 12 | 1–64 |
| `hotkey` | `Ctrl+Alt+G` | Electron accelerator |
| `language` | `system` | `system`, `en`, `zh-CN` |
| `avoidInterrupting` | `true` | boolean: commentary does not interrupt a conversation with Codie |
| `chattyMode` | `false` | boolean: chatty mode (§4.1.3) |
| `guideTips` | `true` | boolean: guide tips (§4.1.4) |
| `readCounters` | `true` | boolean: the resources are read in a silent turn before each remark (§4.1.6) |

Several games may share a program (a browser showing a stream, a launcher): an entry with `off: true` stays on the list but is not matched, and a window's game is the first entry of its program that is not off. The settings page keeps one entry per program on: switching one on, or adding a game, switches the program's others off (user decision 2026-11-13).

An allow-list entry may also carry `genre` (one of `action`, `strategy`, `rpg`, `shooter`, `moba`, `card`, `other`; absent means automatic, from the background) and `guideWiki` (an https address of at most 300 characters; absent means found by the game's name), both §4.1.4; the file leaves out the defaults.

**UI language**: the settings window and the tray (menu, tooltip, state text) are in English or Simplified Chinese. `system` follows the app locale (`app.getLocale()`: the Windows display language, or Electron's `--lang`); any Chinese locale gets `zh-CN`, anything else `en`. Saving a new language switches the window and the tray at once. The texts live in `src/locales/<locale>.json`, one table per language with the same keys; the main process sends the active table to the settings page. Text that comes from codie-host (pairing messages, error details) and logs stay as they are, in English.

The settings window also lists paired and discovered devices and runs pairing (begin, enter the 6-digit code, confirm) through §6.

**Layout**: basic options first, in the order a new user needs them: the Codie device (pairing), the games (pick a running program), the commentary switch, the chatty mode switch with a note on its cloud use, the guide tips switch with a note on where tips come from, a line naming the hotkey, and the language. Each game on the list shows its genre (Automatic, naming the genre its background gave once known, or one picked), a field for its guide wiki address, and its guide state: the wiki's name, still looking (asked again every 2 s for up to a minute; the state changes in place, so a field being typed in keeps the focus), or none found with a hint to paste the address. The window asks for the states of the games as listed, saved or not, and asking starts their lookups. The don't-interrupt switch, `sampleMs`, `cooldownMs`, `changeThreshold`, the hotkey itself and adding a game by its exe name sit under a folded **Advanced options**, which opens by itself when settings.json has invalid values, a save is refused, or the hotkey cannot be registered. One Save button below both.

## 5. Questions: the `look_at_game` tool

Published through `ToolClient.setTools` / `serve` (codie-host §6.2).

```
name: look_at_game   version: 1
parameters:    { question: string (1-500 chars) }
result_schema: { game: string, analysis: string }
risk: read, idempotent: true, confirmation_required: false, timeout_ms: 20000
```

Handler:

1. If the foreground process is not on the allow list, throw `ToolFailure('NO_GAME')`; Codie's model then says the player does not seem to be playing.
2. Take the turn lock, capture the window (as §4.1 step 4).
3. `host.chatTurn({ image, text, speech: 'none' })`, where the text asks for a short, concrete, objective answer to the question from the screenshot, without role play.
4. Return `{ game, analysis: assistant_text }`. The outer model passes it on in character.

Errors: a blocked or failed inner turn throws `ToolFailure` with the device's code; a missed deadline throws `ToolFailure('TIMEOUT')`.

Device firmware must include clt01 `dd3db218c` (2026-10-28), which offers `ext.*` tools to every conversation model, company cloud included; older firmware offers them only on custom models. Commentary is unaffected.

If the spike fails, phase 3 stops and returns to brainstorming with the blocking points; they go to the clt01 owner as requests.

## 6. codie_host additions (phase 1)

The device routes of codie-host §6.4, built as client routes. Implemented in the codie_host repo. codie-host IPC lets a client token reach only `/clients/:id/...` (`ipc.mjs`), so the routes live there. The target device is the one tool hosting uses (`toolDevice`: the first pairing with a client credential).

| Route | Behavior |
|---|---|
| `POST /clients/:id/api` | Body `{ method, path, body }`. Forwarded to the device, signed by the daemon; refused unless `path` is within the client's `scope.api` |
| `POST /clients/:id/chat-turns` | Body `{ image (base64 JPEG/PNG ≤ 1 MiB), text, speech: device \| none, wait_ms }`. The daemon reads the active slot, sets a fresh `request_id`, posts multipart to `/v1/api/data/user/chat/turns`, polls the turn until a final state or `wait_ms`, and returns `{ turn_id, state, assistant_text, error }`. An image over 1 MiB is refused (`IMAGE_TOO_LARGE`); the client compresses (game_buddy: Electron `nativeImage`, 1280 px JPEG). The device itself scales to its maximum edge |
| `GET /clients/:id/devices`, `POST /clients/:id/pair/{begin,confirm,cancel}` | Scan and pairing for clients; needs the new scope flag `pair: true`. Today only the `codie pair` command line can pair |

SDK: `ToolClient#api(method, path, body)`, `ToolClient#chatTurn({ image, text, speech, waitMs, signal })`, `ToolClient#devices()`, `ToolClient#pairBegin(deviceId)`, `ToolClient#pairConfirm(deviceId, code)`, `ToolClient#pairCancel(deviceId)`.

game_buddy's scope: `{ tools: true, pair: true, api: ['/v1/api/data/user/chat/turns'] }`.

Since codie_host agentd 34 (2026-11-02, govee_buddy spec §4): `src/main/host.mjs` builds on the SDK's `createConnection` (registration, approval watch, state, pairing) and keeps only the chat turns; the settings page words pairing outcomes from their result codes (`pair.result.<CODE>`, `src/shared/pair-text.mjs`) instead of showing the daemon's message, and lists the SDK's merged device list.

## 7. Spike (phase 0)

Throwaway; results go to `docs/spikes/2026-10-29-nested-turn-results.md`.

On a device whose firmware includes clt01 `dd3db218c` (any model), register a throwaway `ext.*` tool whose handler posts `chat/turns` `image_text` `speech: none` with a fixed screenshot, then trigger the tool by voice. Record:

1. Is the nested turn admitted while the outer turn is in its tool stage, or refused (`DEVICE_BLOCKED`, another code)?
2. Does it finish, and does the outer turn still finish with the result?
3. End-to-end latency of the tool call (must stay well under 20 s).
4. Does the nested turn appear in the slot's chat history, and does it change what the outer turn remembers?

Pass: 1 and 2 yes, 3 under 15 s on five tries. 4 is recorded either way; if it pollutes history, that is a request to the clt01 owner, not a reason to fail.

## 8. Testing

- **Unit** (`node:test`): `shouldSend`, dHash and Hamming distance, allow-list matching, settings validation, the `look_at_game` handler with a fake host, the turn lock; guide tips (§4.1.4) against fake MediaWiki APIs: portal and guessed wiki search, closed and rate-limiting wikis, title paging, section ranking on BWIKI- and Fandom-shaped HTML, genre detection, the repeat window. Decision logic has no Electron imports.
- **Integration**: game_buddy's `host/` against a real codie-agentd and a fake clt01 HTTP server. In codie_host (existing `test/agentd` style): pass-through, scope refusal, refusal of images over 1 MiB, slot lookup, turn polling, client pairing routes.
- **E2E**: Playwright `_electron.launch` smoke test of the settings window (open, edit the allow list, save, reload).
- **Manual on a device** (checklist in the repo): allowed game in front → Codie comments; same scene → silence until it changes and the cooldown passes; hotkey → immediate comment; switch to a browser → no capture; ask a question by voice → answer.

## 9. Out of scope

- macOS build, signing and notarization (Apple Developer ID is open in codie-host §11).
- Game-specific knowledge beyond the wiki background, on-screen names and guide tips (§4.1.1, §4.1.2, §4.1.4): web search for guides (articles, videos) for games without a wiki, tips with no wiki name on screen (general advice from a wiki's beginner pages, unmeasured), tips from the model's own knowledge, reading game memory or APIs.
- Auto-start at login, auto-update, installer polish beyond an unsigned Windows build.
- A remote repository; the repo is local until one is given.


## 2026-11-17: short comments and freshness (0.1.13)

Comments, including hotkey requests, now ask for exactly one sentence, at most
25 Chinese characters or 15 English words, with the point first. This is a model
instruction rather than a hard playback cutoff. Voice answers lead with one
short sentence and expand only when asked.

`fastMode` defaults to true for both new and existing settings. It bypasses the
separate counter-reading turn, even if the per-game readCounters setting is on,
and asks the model not to quote exact resource amounts. Turning it off restores
the per-game behavior. No on-device timing claim is made for this change.

Hotkeys coalesce as before but capture after the existing turn finishes, instead
of holding an old frame. A changed foreground window cancels the pending request.
Conversation context uses a one-second target cadence, subtracting capture and
upload time from the next delay, with no concurrent pushes. A slow request can
still exceed that cadence. Device speech buffering is unchanged.


## 2026-11-17: semantic novelty (0.1.14)

Keep up to 30 remarks per game, bounded by 3,000 text characters and 20 games in
an in-memory LRU. Identity is process basename plus game name, case insensitive.
The newest five still drive wording avoidance; older records go into a separate
quoted reference block. Switching games does not erase their records. Failed,
empty and unlisted-window turns add nothing. Restarting the app clears memory.

Within the existing vision request, ask the model to compare meanings rather
than synonyms, avoid repeating overall appraisals, and ground a further comment
on the same subject in a distinct visible detail and its specific quality or
effect. Do not forbid a whole topic or fabricate details. A new action may merit
a fresh reaction. When no new useful observation is available, permit empty
output and use the existing silent-turn cooldown. Do not mark a guide tip used
on a silent turn. This is generation guidance, not a guaranteed output filter;
no extra model call or pre-playback gate is introduced.
