# On-device checklist (phase 2)

Run before calling commentary done. Needs a paired Codie device (firmware with client credentials) on the same network and one installed game. Record date, device firmware and game for each run.

| # | Do | Expect |
|---|---|---|
| 1 | Start the app with the game on the allow list, tray green | Within one cooldown, Codie says one or two sentences about the game, in its own voice and language |
| 2 | Stay on the same scene (menu, pause screen) for two cooldowns | Codie stays quiet |
| 3 | Move to a clearly different scene after the cooldown | Codie comments again |
| 4 | Press `Ctrl+Alt+G` right after a comment | Codie comments at once (no cooldown), after it finishes speaking |
| 5 | Switch to a browser for two cooldowns | No comment; the log shows no `commentary: sent` |
| 6 | Talk to Codie (or let it speak) while a comment is due | The frame is dropped (`commentary: blocked` in the log); the next comment comes no sooner than one cooldown later |
| 7 | Uncheck Commentary in the tray | The tray says "Commentary is off"; no comments; the hotkey still works |
| 8 | With the settings window open, uncheck Commentary in the tray, then change the cooldown and **Save** in the window | The window's checkbox follows the tray; after Save commentary stays off |
| 9 | Tray → **Settings…**, then minimize the window and double-click the tray icon | The window opens, and comes back from minimized |
| 10 | Settings → **Scan** with the device on, then with it off | The device is listed; with it off, "No Codie found on this network." |
| 11 | Unplug the device's network, then change scenes for two cooldowns | Tray goes grey after the first failed comment; comments resume within a cooldown after it reconnects |
| 12 | Quit from the tray while no comment is being spoken | The app exits; no Codie speech afterwards (a comment already being spoken may finish) |
| 13 | Play for 10 minutes with commentary on | No visible frame-rate drop compared with the app not running |
| 14 | Check **Chatty mode** in the tray, then stay on one scene for two minutes | Codie keeps talking, each remark starting after the last one ends (about 10 s on 2026-11-03); no remark describes the screen or repeats one of the five before it; record the gap between remarks |
| 15 | In chatty mode, talk to Codie, once while it is quiet and once cutting off a remark | Your conversation is not cut off (`commentary: blocked DEVICE_BUSY` or `commentary: error DEVICE_INTERRUPTED` in the log); the remarks resume a few seconds after it ends |
| 16 | In chatty mode, with "Don't interrupt me while I'm talking to Codie" off, talk to Codie | Same as row 15: chatty mode never interrupts |
| 17 | Uncheck **Chatty mode** in the tray | Back to row 2 and 3: the next comment waits for the cooldown and a scene change |
| 18 | Fight in the game | Codie cheers in a few words and names no button, key or control |
| 19 | Get Codie to give a long remark (over 30 s with its voice) in chatty mode | The next remark starts only after it ends: no `commentary: blocked DEVICE_BUSY` right after `commentary: sent` |

Results:

| Date | Firmware | Game | Failed rows | Notes |
|---|---|---|---|---|
