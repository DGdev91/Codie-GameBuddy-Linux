# Codie voice language and spoken proposals

Date: 2026-11-02
Status: implemented 2026-11-02 (agentd 32, plugins 0.8.0), verified on a device

## 1. Goal

Today, when an agent needs the user, Codie plays one fixed English sentence
("Claude Code on the computer needs you to take a look."), sent through
`tts/utterances`, which the device model rephrases in its own words and
language. Two changes:

1. **Voice language.** Codie speaks in the computer's system language by
   default; the user can switch it.
2. **Spoken proposals.** When the agent asks the user to decide (an
   AskUserQuestion dialog, a reply that ends on a question, a permission
   prompt), Codie says what is being asked. For choices, it also says which
   option the agent recommends and why; when the options are fixes for a
   problem, which fix the root cause and which only work around the symptom.

Out of scope: answering AskUserQuestion by voice (a PreToolUse hook could
supply `updatedInput.answers` later); Codex permission prompts (the Codex
plugin has no hook for them).

## 2. Decisions

- **D1. The agent writes the proposal.** It holds the code and conversation
  context; the device model does not. Codie reads the agent's text verbatim.
- **D2. Full detail by default, brief on demand.** Full detail reads session
  content aloud in the room (the old design avoided that on purpose); brief
  mode restores the fixed reminder.
- **D3. System language = the computer's.** `Intl.DateTimeFormat().resolvedOptions().locale`
  in agentd's process (on Windows, the user's regional format).
- **D4. Fixed sentences are localized** in a zh/en table in codie-host; any
  other language falls back to English. This is an approved exception to the
  plugin repo's English-only rule (the table is bundled into both dists).
- **D5. Task answers are unchanged.** `codie_reply` still speaks the language
  the user spoke to the device; the setting governs only what Codie says
  unprompted (reminders and proposals).

## 3. Settings

`~/.codie/settings.json` gains two keys next to `remindMode`:

| Key | Values | Default |
|---|---|---|
| `remindDetail` | `full` / `brief` | `full` |
| `voiceLanguage` | `system` or a BCP 47 tag (`zh-CN`, `en`, `ja`, …) | `system` |

`voiceLanguage(settings, systemLocale)` resolves `system` to the system
locale; an explicit tag is canonicalized with `Intl.getCanonicalLocales`.
Unknown or invalid stored values resolve as `system`.

`codie_remind_mode` gains optional `detail` and `language` arguments (an
invalid tag is rejected with an error). Called with no arguments, it shows all
three settings; `codie_status` shows them too. The `/codie:remind` skill
documents the new arguments.

## 4. Localized sentences (`src/agentd/locales.mjs`)

```js
sentences(language) → { reminder: { claude, codex }, approval: (host, action) => string }
```

A language starting with `zh` picks the Chinese table, anything else picks
English. `REMINDER` and `HOSTS[*].reminder` in `agent-app.mjs` come from the
table instead of literals. Fixed sentences keep the `tts/utterances` path.

## 5. The agent learns the language

The MCP server instructions are fixed at the MCP handshake, so each session
builds them at startup. Before creating the `Server`, `runSession` reads
`settings.json` and appends one line, for example:

`Codie speaks Chinese (China) (zh-CN): write codie_notify messages in it.`

(The language name comes from `Intl.DisplayNames(['en'], { type: 'language' })`.)
Switching the language through `codie_remind_mode` tells the calling session
in the result. Other open sessions use the new language after a restart.

## 6. `codie_notify(message)`

- New optional `message` (string). In `full` mode, a non-empty message is
  clamped to the device limit (200 runes) and sent verbatim via
  `agent/results`. The device records it in its chat history, so the user can
  ask Codie about it later. Otherwise (brief mode or no message), the
  localized fixed reminder is sent as today.
- `AgentsHost` gains a verbatim announce: every online device, same `quietMs`
  skip, through the `agent/results` path. It marks the device as having just
  spoken, so a later reminder cannot cut it off.
- `lastSpokenAt` is set as today, so the existing dedup windows apply
  (`TURN_END_DEDUP_MS` 30 s, `REMIND_DEDUP_MS` 120 s).

Instructions added for the agent (Claude wording; Codex drops AskUserQuestion):

> When you need the user to decide something (before calling AskUserQuestion,
> or when your reply will end with a question to them), first call
> codie_notify with message: a spoken summary in the Codie voice language,
> under 200 characters, no code, file paths or markdown. Say what you are
> asking, the options, and which one you recommend and why. Only when the
> options are different ways to fix a problem, also say which fixes the root
> cause and which only works around the symptom. If there is nothing to
> choose, briefly say what you need from the user.

## 7. Hooks (Claude plugin `hooks/hooks.json`)

Both new hooks run `stop-hook.mjs <route>`, which prints nothing and exits 0,
so the dialogs behave as before. `agentd-core` maps the new routes to `App`
handlers.

| Hook | Route | agentd |
|---|---|---|
| `PreToolUse`, matcher `AskUserQuestion` | `ask` | `onAskHook`: if Codie spoke within `TURN_END_DEDUP_MS` (the agent's own notify), skip; otherwise play the fixed reminder. |
| `PermissionRequest` | `permission` | `onPermissionHook`: remember `{ tool: tool_name, action: tool_input.description }` for the session, for 2 minutes. |
| `Notification` `permission_prompt` (existing) | `notification` | In `full` mode, with a remembered permission for the session: speak `approval(host, action ?? tool)` and forget it. Otherwise, the fixed reminder as today. |

`Stop` and `idle_prompt` keep their logic and use the localized reminder.
Permission prompts carry no root-cause/symptom analysis: while the dialog
waits, the agent cannot speak, so Codie can only say what it wants to do.

## 8. Compatibility and release

- New arguments and routes are additive, so older session clients keep
  working. Bump `AGENTD_VERSION`.
- Plugin repo: Claude `hooks.json`, both plugins' startup instructions, the
  `/codie:remind` skill, a CLAUDE.md note on the locale-table exception, the
  submodule moved to the new codie-host commit, both dists rebuilt, and the
  plugin version raised to 0.8.0 in all four places.

## 9. Testing

- codie-host unit tests:
  - language resolution (system, explicit, invalid) and table choice;
  - `codie_notify` in full mode with a message (agent/results) and in brief
    mode or without one (fixed reminder);
  - `codie_remind_mode` with `detail` and `language`, including an invalid tag;
  - `ask` route dedup after a notify, and fallback without one;
  - `permission` → `permission_prompt` speaks the action once, and expires.
- Plugin tests: `hooks.json` routes, and instructions that carry the
  resolved language. Compare Windows runs against a clean baseline (known
  POSIX failures).
- On a real device: the user runs the manual steps (Chinese system, switch
  to English, brief mode, AskUserQuestion, a text question, a permission
  prompt).
