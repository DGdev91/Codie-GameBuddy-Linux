# Codie Game Buddy: Linux port (Wayland and X11)

A Linux port of CodieGameBuddy 0.1.17. The app logic is the original one: the Linux-specific parts live in
`codie_game_buddy/src/main/linux.mjs` and `linux-capture.html`, and the original files are touched only at a few hook points.

## What differs from Windows

| Feature | Windows (original) | Linux (port) |
|---|---|---|
| Foreground window and window list | `get-windows` | depends on the compositor, see below |
| Game process name | exe basename | Wine/Proton: the `.exe` taken from `/proc/<pid>/cmdline`; native: `/proc/<pid>/exe` |
| Frame capture | `desktopCapturer`, window thumbnail | ScreenCast portal (PipeWire), one stream kept open in a hidden page |
| OCR | Windows.Media.Ocr (PowerShell) | `tesseract` |
| Global hotkey | `globalShortcut` | `globalShortcut` through the GlobalShortcuts portal, or `--look` (see below) |
| Notifications | tray balloon | desktop notification |
| codie_host (daemon) | unchanged | unchanged (it was already cross-platform) |

### Foreground window per desktop

Wayland has no common way to tell which window is in front, so the port uses each compositor's own tool:

| Desktop | How | Sees native Wayland windows |
|---|---|---|
| KDE Plasma 6 | KWin script over D-Bus | yes |
| Hyprland | `hyprctl` | yes |
| Sway | `swaymsg` | yes |
| niri | `niri msg` | yes |
| GNOME, COSMIC, others | `xprop` on XWayland | no |

The XWayland fallback is enough for Wine/Proton games and for most native games, which run under XWayland. With a native
Wayland window in front the result is "no game" and commentary pauses. If the compositor's tool is missing or fails, the port
falls back to XWayland. `CODIE_WINDOW_BACKEND=kwin|hyprland|sway|niri|xwayland` forces the choice.

### Hotkey

The GlobalShortcuts portal exists on KDE, GNOME 48+ and Hyprland. Elsewhere, bind the command `codie-game-buddy --look`
(in development: `npx electron . --look`) to a desktop shortcut. It reaches the running instance and does what the hotkey does.

### Codie's language

Besides English and Simplified Chinese, the "Language" setting offers the other languages Codie speaks (zh-TW, ja, ko, fr, de,
es, it, pt).
- **Follow System:** Codie speaks the language set on the device (`ai_language` from `GET /v1/api/data/user/system`).
  GameBuddy reads it once per session and only in this mode; until it knows it, it uses the interface language.
- **A language picked by hand:** Codie speaks that one.

The interface stays in English or Chinese: languages without a translation show it in English. This change is not
Linux-specific: it touches `i18n.mjs`, `settings.html`, `host.mjs` (with the `/system` scope), `prompt.mjs`, `commentary.mjs`
and `context-feed.mjs`. Because of the wider scope, users who update must approve GameBuddy once more, by pairing again or
with `codie clients approve game-buddy`.

### Comments in the chat history

The "Save comments in chat history" option (off by default) sends commentary turns with `retention: chat`, so Codie can
refer to them in voice chat. The device keeps the whole turn: screenshot, prompt and reply. API 1.6.0 cannot keep the reply
alone (deleting part of a turn deletes all of it). It touches `settings.mjs`, `commentary.mjs` and the settings page.

### Other changes to original files

`capture.mjs`, `main.mjs` (also `--look`), `locales/`, `tray.mjs`, `settings.mjs` (process names without `.exe` are
accepted), the tests, `package.json` (`dbus-next`, `linux` target, `release:linux`). The shebang of the `codie_host` bins
lost its CR (with CRLF they do not run on Linux).

## Requirements

- A desktop with PipeWire and an `xdg-desktop-portal` that provides ScreenCast: `-kde`, `-gnome`, `-hyprland` or `-wlr`
  (the latter shares whole screens only)
- `xprop` (package `xorg-xprop` / `x11-utils`) for the XWayland fallback
- On GNOME, to see the tray icon: the AppIndicator extension. Without it, launching the app again opens the settings
- Node.js 20+
- Optional, for OCR: `tesseract` with `tesseract-data-eng` (`-chi_sim` if the app is in Chinese). Without it commentary
  still works, but Codie does not recognise names of characters and places written on screen

## Running

```bash
cd codie_host && npm ci
cd ../codie_game_buddy && npm ci
node node_modules/electron/install.js   # if npm skipped the Electron download
npm test
env -u ELECTRON_RUN_AS_NODE npx electron scripts/linux-probe.mjs   # tries windows, capture, OCR
env -u ELECTRON_RUN_AS_NODE npm start
```

VS Code's integrated terminal exports `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node, so the app does
not start. Hence `env -u`.

On the first capture the desktop asks which screen (or window) to share. The choice lasts until the app quits. If you
cancel, the app does not ask again for 5 minutes. The first hotkey registration also goes through a desktop confirmation
dialog.

## Releasing (AppImage on GitHub Releases)

The releases of [DGdev91/Codie-GameBuddy-Linux](https://github.com/DGdev91/Codie-GameBuddy-Linux) are also the update
feed (`build.linux.publish` in `package.json`; Windows stays on the original's feed): an installed AppImage finds new
versions in the latest release (`latest-linux.yml`), downloads them and replaces itself.

1. Bump `version` in `codie_game_buddy/package.json` (installed AppImages only take higher versions), then commit and
   push to `origin`.
2. `GITHUB_TOKEN=<token with contents: write> npm run release:linux` (or, with `gh` signed in, no token needed)

The script refuses uncommitted or unpushed sources, and versions already released. It builds
`dist/CodieGameBuddy-<version>-x86_64.AppImage`, computes its SHA256 and creates the `v<version>` release on the current
commit with the AppImage, `.sha256` and `latest-linux.yml`. With `--no-upload` it only builds.

The `codie-agentd` daemon starts from the AppImage's binary and keeps running after the app closes. The AppImage runtime
keeps its filesystem mounted while the daemon is alive, that is, until 10 minutes of inactivity.

## Known limits

- On GNOME and COSMIC native Wayland windows are not recognised (see above).
- The whole picked screen is sent, not cropped to the game window. Fine for full-screen games.
- The screen pick is repeated on every start: Electron 44, the original's version, has no `persistMode`/`restoreToken`.
- The version is the original's: a port-only fix has no number of its own that would not clash with the original's next
  release.

## Taking in a new version of the original

The `upstream` branch holds the original source unchanged, `main` holds the port.

```bash
git checkout upstream
rm -rf codie_game_buddy codie_host
cp -a /path/to/CodieGameBuddySource-X.Y.Z/. .
git add -A && git commit -m "Upstream X.Y.Z" && git tag upstream-X.Y.Z
git checkout main && git merge upstream
```

Conflicts, when there are any, only involve the hook points listed above.
