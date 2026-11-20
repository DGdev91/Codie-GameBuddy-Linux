# Phase 0 spike: nested chat turn inside an ext.* tool call

Spec: [§7](../specs/2026-10-29-game-buddy-design.md). Run 2026-10-29 on device `YGKJ2511921S00043` (clt01 `com.clt01.control` 1.6.0, versionCode 261029161, company cloud conversation model, slot 1), codie_host agentd v28. Throwaway client `spike-look` registered one tool whose handler posts `chat/turns` `image_text` `speech: none` with a fixed Sekiro screenshot (1280×800 JPEG, 83 550 bytes) and waits up to 17 s.

## Verdict: FAIL

Option A (a synchronous nested `chat/turns` while the outer voice turn waits in its tool stage) does not work on this firmware. Phase 3 returns to brainstorming with the blocking points below.

| # | Question | Result |
|---|---|---|
| 1 | Nested turn admitted during the outer tool stage? | Accepted (`200`, `state: queued`) but **not run**: it waits until the outer tool call has closed |
| 2 | Nested turn finishes, outer turn finishes with the result? | **No.** The outer tool call closes with `EXTERNAL_TOOL_RESULT_UNKNOWN` after ~17 s; then the queued turn starts and finalizes the outer voice session as `interrupted` |
| 3 | Tool latency < 15 s on five tries | Not reachable: the nested turn cannot run inside the tool window (one forced try; tries 2–5 not run, the failure is structural) |
| 4 | Nested turn in chat history? | **Yes**: saved as an image-text turn in slot 1 (`[ChatHistory] Saving image-text turn`) |

## Timeline of the forced try (device log, UTC)

| Time | Event |
|---|---|
| 12:53:30.7 | ASR: "你调用 see computer screen 这个工具看看我这局打的怎么样…" |
| 12:53:52.0 | Model calls `ext.<id>.see_computer_screen` (after speaking a preamble) |
| 12:54:01.6 | Call dispatched to the computer (~9.6 s after the model's call; the preamble was playing) |
| 12:54:01.8 | Handler posts the nested `chat/turns`; device queues it |
| 12:54:18.9 | Outer call closed: `EXTERNAL_TOOL_RESULT_UNKNOWN`, `success=false`, `can_continue=false` |
| 12:54:18.9 | Queued API turn starts: `完整收口当前前台会话: reason=api_turn_start`; outer voice session `outcome=interrupted` |
| 12:54:18.9 | Nested turn runs as `SESSION_MODE_TEXT_CHAT` with **all 45 tools**; its model calls `see_computer_screen` again (recursion) |
| 12:54:21.3 | The second nested turn preempts the first (`EXTERNAL_TOOL_DEADLINE`); the handler's first wait ends `queued` → TIMEOUT |
| 12:54:27.2 | Second nested turn completes; tool budget refuses a third call; the answer misidentifies the game as Final Fantasy VII |

## Other findings

1. **The model does not pick the tool on its own.** Four voice tries with three descriptions (`look_at_game` ×2, `see_computer_screen` ×1, the last one stating "your camera does not show it; never describe their game without calling it"): no call. Every voice turn carries the device's own camera photo (`images=1`, 256×192); the model answers from it and, in the last two tries, invented gameplay ("站位太靠前", "60 分"). Only an explicit "call the see computer screen tool" triggered a call. The same device called `ext.*.ask_agent` seven times earlier that day, so function calling itself works.
2. **API chat turns carry every tool.** `chat/turns` runs as `SESSION_MODE_TEXT_CHAT` with the full tool set, so a commentary or analysis turn can call ext tools, including the tool that started it. This also affects phase 2 commentary turns whenever other ext tools (e.g. `ask_agent`) are online.
3. **codie_host hosts tools on the first paired device with a client credential** (`toolDevice()`), with no way to choose, and keeps a stale host after the device's IP changes. On this PC the tools went to `SC272629FG000911`, not the device in use; the spike had to use an isolated `CODIE_HOME` holding only this device. Needs a codie_host fix before game_buddy relies on tools.
4. **codie_host's catalog pre-check misses clt01's rule that every object schema sets `additionalProperties: false`**; the device's reason is lost and the publish only logs `INVALID_ARGUMENT`.
5. Environment noise during the run, unrelated to the spike: an IP conflict on the device's address cut its internet for ~45 min (fixed by giving the device a new IP); company-cloud TTS streams ended with `RST_STREAM INTERNAL_ERROR` on several turns, so some replies were not heard.

## Requests for the clt01 owner

0. **Highest priority, found during the phase 2 on-device run (2026-10-29 13:57 UTC):** a voice turn fails once a few image chat turns are in the slot's history. The prompt assembler sends the device's camera photo plus every historical image (`[PromptAssembly] … images=4`), and company cloud rejects the request: `llm_request images exceeds limit 3`, `outcome=failed`. So after game_buddy has commented three times, the user can no longer talk to Codie. Fix in the prompt assembly: cap the images per request to the provider's limit, keeping the newest.
1. A way for a tool handler to get a one-shot image analysis that does not enter the foreground conversation queue: no preemption of the running turn, no chat history, no tools (e.g. a `chat/turns` option, or a separate vision endpoint).
2. API chat turns without tools (at least an opt-out), so they cannot recurse into ext tools.
3. Tool selection when the device's camera photo is attached: the model treats it as seeing the computer screen and fabricates instead of calling a declared screen tool.

## Alternative for phase 3 (to brainstorm)

An async tool (`completion: 'async'`, as `ask_agent` uses): the handler answers "accepted" at once, so the outer turn ends normally; once the device is idle, game_buddy posts `chat/turns` `image_text` `speech: 'device'` with the user's question and the screenshot, and Codie speaks the answer in its own voice — the same path phase 2 commentary already uses. It still depends on finding 1 (the model must call the tool) and finding 2 (the answer turn must not recurse).
