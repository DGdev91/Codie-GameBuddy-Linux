# Codie Game Buddy

A Windows tray app that keeps you company through a Codie device: while a game on your list is in front, Codie looks at it now and then and says a line or two in its own voice. Press the hotkey (default `Ctrl+Alt+G`) to make it look right away.

Design: [docs/specs/2026-10-29-game-buddy-design.md](docs/specs/2026-10-29-game-buddy-design.md). User guide (English / Simplified Chinese, Markdown and PDF): [docs/user-guide/](docs/user-guide/).

## Requirements

- Windows 10/11 x64, Node.js 20+.
- `codie_host` checked out next to this repo (`../codie_host`): game_buddy talks to the Codie device only through its daemon, codie-agentd. It needs agentd 31 (client device routes, approval by pairing; current clt01 firmware only) and the Electron spawn fix (`agentdEnv` sets `ELECTRON_RUN_AS_NODE`).
- A Codie device on the same network, with firmware that issues client credentials.

## Run

```bash
npm install
npm start
```

If `npm start` reports that Electron failed to install, the binary download was skipped or blocked; fetch it from a mirror:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

First run:

1. The settings window opens and the tray icon is yellow. In **Codie device**, scan, pick your Codie, and type the 6-digit code shown on its screen. Typing the code also approves game_buddy (hosting tools, image chat turns, pairing), so pair here even if this computer paired the Codie before. The tray turns green. (`node ../codie_host/bin/codie.mjs clients approve game-buddy` approves it without pairing.)
2. In **Games**, add your games (pick a running one, or type its exe name), then **Save**.

Play: with an allowed game in front, Codie comments when the scene changes and the cooldown has passed. Switching to another program pauses it. The tray menu turns commentary off; **Settings…** (or double-clicking the tray icon) reopens the settings window.

For each game on your list, game_buddy looks up a short background (world, story, characters) on Moegirlpedia or Wikipedia, in the app's language, so Codie can talk about the game, not only the screen; only the game's name is sent, and the result is cached in `game-info.json` in the settings folder. A new game gets its background from its second comment on.

Guide tips (on by default, spec §4.1.4): game_buddy also finds the game's guide wiki (the bilibili BWIKI in Chinese, a Fandom or wiki.gg in English, or the address pasted under the game in settings) and, when a page name from it is on screen, gives Codie that page's strategy notes to pass on as one short tip, shaped by the game's genre. Only the game's name and the matched page names are sent; results are cached in `guide-wikis.json` and `guide-notes.json`.

When the wiki lists the game's characters and places, game_buddy also reads the text on each frame with Windows' built-in OCR (the OCR language of the app's language must be installed in Windows) and tells Codie who or what the names on screen are. The screen text stays on your computer; only the page names of matched characters go to the wiki, cached in `game-terms.json`.

Games in exclusive full-screen mode may capture as a black frame; use borderless or windowed mode.

If no codie-agentd is running, game_buddy starts one with its own Electron binary in Node mode, and the daemon keeps running after the app quits (Claude Code and Codex sessions share it). Stop it (`node ../codie_host/bin/codie.mjs stop`) before reinstalling or upgrading Electron here, or the locked `electron.exe` fails the install.

## Develop

```bash
npm test             # unit tests (node:test)
npx playwright test  # settings window E2E
npm run dist         # Windows installer: dist/CodieGameBuddySetup-<version>.exe
```

`npm run dist` builds an unsigned one-click NSIS installer with `codie_host` bundled (without its docs and spike). asar is off: codie-agentd is started from the installed exe in Node mode and the OCR helper runs in PowerShell, so both need real files. If the NSIS download from GitHub is blocked, set `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.

`GAME_BUDDY_HOME` moves the settings folder and `CODIE_HOME` the daemon's folder, for a clean test run; a test daemon in its own `CODIE_HOME` never touches your real one. The on-device checklist is [docs/manual-checklist.md](docs/manual-checklist.md).

## Updates and releases

The installed app checks for updates 15 s after it starts and then every 6 hours, or when you pick **Check for updates** in the tray menu. A newer version downloads in the background; **Restart to update** in the tray menu stops codie-agentd, installs it silently and starts the app again. The first sign-in happens from the tray: the feed is on the internal OneDev, so the app opens its sign-in page (tick "remember me" to stay signed in).

To publish a version: bump `version` in `package.json`, commit, then `npm run release`. It builds the installer and pushes `latest.yml`, the installer (Git LFS) and its blockmap to `game-buddy/` of [codie/releases](https://git.service.code27.cn/codie/releases), where installed apps find it. The feed is `build.publish` in `package.json`; electron-builder writes it into the app's `app-update.yml`, so no code names it. For a public feed on GitHub releases, `node scripts/release.mjs --github <owner>/<repo>` builds the same installer pointed at that repo and uploads nothing; installed apps move over once one last OneDev release is built that way. Installs from before updates existed (0.1.0) need this version installed by hand once.


The tray and Settings show the current game and whether Game Buddy is capturing,
analyzing, generating or playing a comment, waiting for the cooldown or a scene
change, or unable to capture. The last commentary error remains visible there.
The device reports generation and playback as one operation, so the app does not
show separate playback progress.

The hotkey acknowledges the request with a Windows notification and captures a
fresh frame when the current turn finishes. Switching foreground windows cancels
the queued request. Repeated presses
while that request is pending do not queue more comments. Context removal is
retried when it fails; stopping the app allows up to two seconds to clear it,
and the device context expires after 20 seconds if the device cannot be reached.


Version 0.1.13 asks for one sentence per comment (at most 25 Chinese characters
or 15 English words). This is a model instruction, not a hard speech cutoff.
Fast commentary is on by default, including for existing settings: it skips the
separate resource-reading turn and avoids quoting exact HUD amounts. Disable it
to restore each game's number-reading setting. Voice-conversation screenshots
are refreshed with a target interval of one second, without overlapping uploads;
slow capture or upload can still make the actual interval longer. These changes
have not yet been timed on a physical device. Cloud generation and device audio
buffering still contribute to the delay.


Commentary compares new observations by meaning against up to 30 previous
remarks per game (at most 3,000 characters, held in memory for up to 20 games).
Switching games preserves those records until eviction or app exit. A general
appraisal cannot be repeated by changing adjectives; returning to a subject
requires a genuinely new, visible detail rather than generic praise of another
part. With nothing useful to add, the model is asked to return no text; silent
turns wait the normal cooldown and do not consume a guide tip. This uses the
existing vision request and does not add a separate LLM check. These are model
instructions, so semantic repetition still needs evaluation in actual play.


The tray switches between a controller with sound waves while capturing,
analyzing, generating or playing commentary, and a resting moon while idle,
waiting for a scene change/cooldown, or paused. The corner dot independently
shows connection state (green ready, yellow pairing, grey offline/connecting).
The active icon includes generation time because the device call does not
expose a separate playback-start event to Game Buddy.
