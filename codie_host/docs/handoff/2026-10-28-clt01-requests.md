# 交给 clt01 负责人：ext.* 接入电脑 Agent 的真机问题与修改建议

## 当前状态（2026-10-29 晚）：全部合入并上线，真机命中率 4/5

问题 1–5 的修复都已合入三个仓库的 master，云端已部署（云端负责人确认）。

| 仓库 | PR（OneDev） | 状态 | 内容 |
|---|---|---|---|
| clt01_embed_backend | #189（PR A） | 已合入 master | 问题 1–4 的修复，外加下面第 5、6 项 |
| ct01-grpc | #18 | 已合入 master | PR B 协议：LLM 消息支持原生工具调用与结果（`e803b18`） |
| ct01-ai-ability | #8 | 已合入 master，**已部署** | PR B 云端：校验、映射、三种 provider |
| clt01_embed_backend | #191（PR B） | 已合入 master（`2408612b2`） | PR B 客户端：同轮回注与跨轮回放；子模块 ct01-grpc 指向 `e803b18` |

- #190 是 PR B 第一次提交，目标分支设成了 PR A 的分支 `feat/ext-tools-async-results`，合并时没有改成 master，所以没进 master。#191 是重提，内容相同。
- 上线顺序曾经是硬约束：旧云端不认识 `ROLE_TOOL`，会把工具结果当成用户消息，丢掉 tool_calls；只带调用、没有文字的 assistant 消息会被判为 INVALID_ARGUMENT。现在云端已部署，这个约束不再存在。

### 真机验证（YGKJ，固件 261029161 = clt01 master `2408612b2`，云端部署后）

每轮先开新话题，再依次提问：

| # | 提问 | 调用 `ask_agent` | 交出后模型说的话 |
|---|---|---|---|
| 1 | C 盘还剩多少空间 | ✅ | "已经交给电脑了，正在处理中" |
| 2 | D 盘还剩多少空间 | ✅ | "已经让电脑去检查了" |
| 3 | 桌面上有几个文件（第一次） | ❌ | "电脑正在数"，但没有调用 |
| 4 | 桌面上有几个文件（第二次） | ✅ | "电脑已经在帮你数了" |
| 5 | 运行内存用了多少 | ✅ | "电脑已经在查了" |

- 对比：PR B 之前 5 次只有 2 次调用，失败的都是"嘴上说交给电脑、实际没调用"；PR B 之后 5 次有 4 次调用。
- 交出后都没有再编结果。部署前测过一次，D 盘那题模型自己编了"1.83T，剩 1.60T"：旧云端把"已受理"当成了用户消息。部署后没有再出现。
- 结果补播生效：结果出声前被下一次提问抢占时，日志出现"结果出声前被新对话抢占，重新入队"，之后正常补播。
- 账本迁移 `v1.1.3/008` 在设备上已执行。

### 还没解决的问题

1. **仍有约 1/5 的"只说不调"**（上面第 3 题）。那一轮回放了 2 轮历史，但日志没记录回放了几对"调用 + 结果"，分不清是回放缺失还是模型偶发。要查的话，可以在 `[PromptAssembly]` 日志里加一项"回放的调用对数"。暂不处理。
2. **跨轮回放有窗口限制**：只回放 30 分钟内、最多 3 条外部结果。超出窗口后，"已经交给电脑了"这类回复在历史里只剩文字，仍可能教模型只说不调。治本做法是工具轮的 assistant 聊天记录带上本轮调用（聊天记录已有 metadata 字段），组装历史时按"文字 + 调用 + 结果"回放。暂不处理。
3. **电脑结果在历史里是一条 assistant 消息**：`agent/results` 只带文字，没有关联当初的调用。部署后没有观察到编造，暂不处理；如果再出现，治本做法是 codie_host 回传结果时带上调用 id，clt01 把结果记到那次调用的工具结果里。
4. **"电脑现在几点了"按设备时间回答**：YGKJ 的时区比北京时间晚 15 小时，模型用设备的 `local_time` 回答，不调用工具。按用户决定保持现状。
5. **云端 TTS 断流**：测试期间多次出现 `stream terminated by RST_STREAM with error code: INTERNAL_ERROR` 和 `TTS audio has invalid ordering`，一句话播到一半就断。请云端负责人排查。

### 电脑端（codie_host）同期改动

- 已合入 codie_host main，并以子模块形式接入插件仓库 codie-plugin-for-agents（main）；两个仓库都加了 OneDev CI。
- 任务结果走 `agent/results`；提醒仍走 `tts/utterances`，不进聊天记录；ext.* 路径的回复去掉了 "The computer finished:" 前缀。
- 工具连接加了静默检测：设备每 20 秒发一次 ping，60 秒收不到任何消息就断开并重新发布目录。此前设备重启后电脑端停留在半开连接上，设备上的 ext.* 工具会静默消失，模型只能回答"我看不到你的电脑"。

## 2026-10-29 更新：按下列问题写成的代码（已全部合入，见上）

| 仓库 | 分支 | 提交 | 内容 |
|---|---|---|---|
| clt01_embed_backend | `feat/ext-tools-async-results`（基于 origin/master `32b71af73`） | `895c04311` `56d5bb455` `d12616ea4` `4bda7c41a` `15c861357` `6cb2f75c1` | PR A：问题 1–4 的修复，真机已验证 |
| ct01-grpc | `feat/llm-native-tool-messages`（基于 `0990221`） | `e803b18` | PR B 协议：LLM 消息支持原生工具调用与结果 |
| ct01-ai-ability | `feat/llm-native-tool-messages`（rebase 到 master `da564281`） | `cd61865d` | PR B 云端：校验、映射、三种 provider |
| clt01_embed_backend | `feat/native-tool-messages`（基于 PR A） | `556272912` `977253d9e` | PR B 客户端：同轮回注与跨轮回放 |

### PR A：clt01 `feat/ext-tools-async-results`

1. `fix(ai): 无工具时不发送 tool_policy`：修复问题 1，`cloude2e/llm.go` 只在有工具时带 ToolPolicy。
2. `feat(externaltools)`：修复问题 3 和 4。
   - 目录协议 v2 新增 `completion: "async"`，受理成功后由 clt01 设置 `finish_after_reply`，外部返回数据仍不能控制生命周期。
   - 上游名改为 `ext_<id 前 8 位>_<name>`，同一用户内冲突时拒绝发布（`INTEGRATION_ID_CONFLICT`）。
3. `feat(engine)`：修复问题 2，新增 `POST /v1/api/data/user/agent/results`。
   - 引擎空闲才播，按到达顺序排队，不打断对话。
   - 先以 assistant 身份写入聊天记录，再用角色音色朗读。
4. `fix(devicetools)`：选择规则加一句"没在本条回复里调用工具，就不要声称在做"。`PolicyVersion` 不变，因为云端按 `v2` 精确匹配。
5. `fix(devicetools): 以当前声明的工具判断能力，不沿用历史中的做不到`：电脑离线期间模型说过"我看不到你的电脑"，恢复后会照搬这句话继续拒绝。
6. `fix(engine): 外部任务结果出声前被抢占时重新排队播报`：结果交给 TTS 后、出声前（状态尚未进入 Talking），用户按键开始新一轮，结果原本会被直接丢弃；现在放回队首，下次空闲重播，只落库一次。已出声后被打断视为用户主动打断，不重播。

真机（YGKJ，261028220 / 261029122 / 261029144）验证结果：
- 只调一次 `ask_agent`，没有 `tool_choice` 报错；
- 结果等设备空闲后才播，并写入了聊天记录；
- codie_host 已经适配：协议协商 v2、老固件自动降级 v1，结果优先走 `agent/results`。

### PR B：原生工具消息（新问题 5）

**问题 5（P1）**：模型约一半时候只说"让我帮你问问电脑"，却不调用 `ask_agent`。
- 真机 5 次只调用了 2 次，失败的几次链路本身正常，是模型没发出调用。
- 根因：整条链路只有文字消息。
  - 同一轮的工具结果被写成 developer 文本，云端把它并入 system prompt。
  - 历史里只保存回复文字，外部结果也以 assistant 文字的形式回放。
  - 模型从没见过"说"和"调"同时出现，于是学着只说不调。

改动：
- **ct01-grpc**
  - `LLMMessage` 新增 `ROLE_TOOL`、`tool_calls`（`LLMToolCall`，使用上游名）和 `tool_call_id`；
  - `LlmMessageHistory` 新增 `tool_calls` 和 `tool_call_id`。
- **ct01-ai-ability**
  - 校验调用和结果一一配对，并且结果要出现在下一条 user/assistant 之前；
  - 以工具结果结尾时不追加用户消息；
  - 三种 provider 的映射：Chat Completions 映射为 tool_calls + role=tool；Ollama 映射为 tool_calls + tool_name；Responses 映射为 function_call / function_call_output。
- **clt01**
  - 只有公司云适配器声明支持原生工具消息，其他适配器行为不变；
  - 同一轮回注时，先放模型本轮的文字和调用，再逐个调用回结果；
  - 账本加 `arguments_json` 列（迁移 `v1.1.3/008`）；
  - 历史里的外部结果改为按"调用 + 结果"回放；没有参数或工具已不再声明时，保留原来的文字。

验证：
- 三个仓库的单元测试都已补充并通过；clt01 外部工具集成测试 `TestExternalToolsSignedHTTPWSAndSharedExecution` 已断言账本保存了参数。
- 真机结果见文首"真机验证"。
- 已知与本改动无关的失败：
  - clt01 `TestRealtimeIdleDeadlineWaitsForWholeTurnAndRejectsStaleTimers`：本次改动前就失败，疑似 Windows 时钟问题，未在干净基线上单独验证；
  - ct01-ai-ability `grpc_handlers/v2` 的 `TestE2EContextMaintenanceRejectsDuplicateRequest`：在没有改动的 checkout 上同样超时。

后续可以跟进：openai/anthropic/gemini 适配器也可以支持原生工具消息；内置工具（非 ext.*）的跨轮回放目前仍然没有。

---

日期：2026-10-28
提出方：codie_host（电脑端守护进程，原插件 agentd 迁入）
对象：clt01_embed_backend 负责人（并抄送 ct01-ai-ability 一条）

## 背景

- `9c2899064 refactor(agent): 退役设备端 Codie Agent Service` 之后，电脑能力只能经 tool-integrations 接入。codie_host 为每台设备发布一个外部工具集 `agents`（`ask_agent`、`cancel_task`），由电脑上的 Claude Code / Codex 会话执行。
- `dd3db218c fix(ai): 外部工具向所有模型开放` 让公司云模型也能用 ext.*，这一点真机已验证生效。
- 测试设备：YGKJ2511921S00043，刷入 origin/master `6cb04ca1e` 编译的 1.6.0（versionCode 261028210，ygkj 平台签名）。对话后端 `local_harness`，LLM 走公司云。
- 测试语句："帮我看看电脑的C盘还剩多少空间"，共 5 轮。
  - 已跑通：模型调用 `ext.….ask_agent` → codie_host 把任务交给电脑会话 → 结果回到设备。
  - 体验上仍不可用，原因见下面 4 个问题。前两个是阻断项。

| # | 问题 | 级别 | 涉及代码 |
|---|---|---|---|
| 1 | 工具阶段结束那一轮带 `tool_choice=auto` 却没有工具，公司云报错，整轮失败 | P0 | `ai/provider/cloude2e/llm.go:146`、`ai/harness/runner.go:306-317` |
| 2 | 退役后没有"异步结果回传"入口；结果不进聊天记录，模型以为任务永远在处理中 | P0 | 已删除的 `interf/engine/handle_device_announce.go`、`HandleAgentResultTTS` |
| 3 | 外部工具无法声明"受理后结束工具阶段"，模型在同一轮里反复调用 | P1 | `externaltools/manager.go:342`、`devicetools/policy.go` `ResultInstruction` |
| 4 | 外部工具上游名 `ext_<32位hex>_<name>` 太长，模型抄错，报 undeclared tool | P1 | `externaltools/catalog.go:70` |

---

## 1. P0：最后一轮 `tool_choice=auto` 但 tools 为空

**现象**（设备 GoLog）

```
13:16:56.905 [LocalHarness] 工具结果回注: round=3 ... remaining_calls=0 can_continue=false
13:16:57.574 [E2E-Error] company cloud LLM response failed: ... invalid tool configuration: tool_choice "auto" requires at least one tool
13:16:57.575 SendErrorDisplay code=PROVIDER_ERROR
```

闹钟候选生成（`aiprepare`，`SESSION_MODE_ALARM`，`PromptAssembly tools=0`）也持续报同一个错误：`[AIPrepare] 生成候选文本失败`。

**根因**

- `runner.go:306-317`：`canContinue=false` 时 `tools = nil`，但仍设置 `ToolCallPolicy: optionalSingleToolCallPolicy()`。
- `cloude2e/llm.go:146`：只要 `req.ToolCallPolicy != nil` 就写 `ToolPolicy{Choice: CHOICE_AUTO}`，没有检查 `len(out.Tools)`。
  - 对比 `openai/adapter.go:129`，那里有 `len(payload.Tools) > 0` 的判断。
- 云端 `ct01-ai-ability` 的 `d67be122`（2026-10-28 14:17，chace.y）在 `llm_openai_chat.go:78` 显式拒绝这种组合。在那之前，上游 OpenAI 遇到同样的请求也会返回 400。

**影响**

local_harness + 公司云 LLM 下，凡是工具阶段要结束的轮次都会整轮失败：
- 工具轮数用完；
- 带 `finish_after_reply` 的内置工具，例如导航、换角色、新话题；
- 闹钟候选生成。

**建议**（一行）

```go
// cloude2e/llm.go buildRequest
if req.ToolCallPolicy != nil && len(out.Tools) > 0 {
```

同时建议在 `runner.go` 最后一轮把 `ToolCallPolicy` 置空，并给 cloude2e 补一个"tools 为空时不带 ToolPolicy"的单测。

---

## 2. P0：没有异步结果回传入口（原 C3，现为阻断）

**现象**

电脑任务的结果目前只能用 `POST /v1/api/data/user/tts/utterances` 播报，对话因此出现矛盾。设备聊天记录（`GET /chat/history?slot=1`）如下：

```
13:25:58 assistant  let me hand that over to the computer ...
13:26:14 assistant  I handed that request to the computer too. It's still working on it ...
   （此时结果"C盘约170GB"已用 tts/utterances 念出，但没有写进聊天记录）
13:29:38 assistant  I already asked the computer to check that for you. It's still working on it ...   ← 不再调用 ask_agent
13:30:16 assistant  I already asked the computer ... still working on it ...
```

另外，`tts/utterances` 会通过 `api_turn_start` 收掉当前前台会话，打断 Codie 正在说的回复，日志里是 `Session OnFinalize: source=manual outcome=interrupted`；多条结果之间也会互相打断。

**根因**

`9c2899064` 删掉了原 WS `device.command announce` 的整条链路：
- `handle_device_announce.go`：引擎忙时挂起，回到 Idle 再播；
- `HandleAgentResultTTS`：`SESSION_MODE_AGENT_RESULT_TTS`，云端按角色口吻改写，并写入聊天记录。

现在没有任何入口能"等空闲、按角色口吻播报、并让对话知道任务已完成"。`tts/utterances` 按设计是原样朗读、不写记录（`speech_utterance_gin.go`），不适合用来回传结果。

**建议**

新增一个可用客户端凭据签名访问的接口，行为照搬原 announcer 和 AGENT_RESULT_TTS：

```
POST /v1/api/data/user/agent/results
{ "request_id": "<uuid>", "text": "<≤200 runes>", "ref": "<可选：对应 ask_agent 的 task_id>" }
```

1. 引擎 Idle 时立即播；忙时只保留最新一条，回到 Idle 再播。这就是原 `deviceAnnouncer` 的逻辑。
2. 走 `SESSION_MODE_AGENT_RESULT_TTS`，由云端按角色口吻改写。
3. 以 assistant 身份写入聊天记录，让模型知道之前的任务已有结果。
4. 返回 202，并提供可查询的状态（类似 `tts/utterances/:id`）。

codie_host 的临时做法：播报前轮询 `GET /ai/backend` 的 `active_state` 直到 `Idle`（最多 60 秒），按设备排队后调用 `tts/utterances`；同时在 `ask_agent` 的描述里提醒模型"之前的结果在对话之外播报，新问题要重新调用"。这只能缓解：结果仍然不进聊天记录，也没有按角色口吻改写。

---

## 3. P1：外部工具无法结束工具阶段

**现象**

一次提问里，模型对同一请求连调 `ask_agent`。第一次测试调了 3 轮，直到 `remaining_calls=0`，然后又触发了问题 1。

```
13:16:50 工具调用 round=1 ext.….ask_agent → 回注 success=true can_continue=true
13:16:53 工具调用 round=2 ext.….ask_agent → 回注 can_continue=true
13:16:56 工具调用 round=3 ext.….ask_agent → remaining_calls=0
```

**根因**

- `externaltools/manager.go:342` 把外部返回包进 `external_result`，所以 `finish_after_reply` / `end_turn` 不生效。这是有意设计，`manager_test.go` 中有测试 "external data controlled lifecycle"。
- `devicetools/policy.go` 的 `ResultInstruction` 规定 "accepted means admitted" 并要求 "Continue unfinished requested actions"。模型把"已受理、未完成"当成"还要继续做"。
- 原内置 `agent.ask` 依靠 `REQUEST_ACCEPTED` 加 `finish_after_reply` / `end_turn` 结束本轮（`be8026e5c`），退役后外部工具没有对应的能力。

**建议**（保持"外部返回数据不能控制生命周期"的原则）

在工具目录里增加一个声明式字段，由用户批准的目录决定，而不是由每次的返回决定。例如：

```json
{ "name": "ask_agent", ..., "completion": "async" }
```

`completion: "async"` 的工具返回 `succeeded` 时，clt01 自行设置 `FinishAfterReply=true`（等同于原 `agent.ask` 的受理回执）。注意：要先修好问题 1，否则 `finish_after_reply` 那一轮同样会失败。

codie_host 的临时做法：同一 `turn_id` 的重复调用只建一个任务，直接返回第一次的结果；描述里写明"每个请求只调一次"。现在重复调用从 3 次降到 2 次，但仍然多消耗一轮延迟和工具预算。

---

## 4. P1：外部工具上游名过长，模型抄错

**现象**

```
13:31:21 [E2E-Error] ... upstream returned undeclared tool "ext_b991acef9da253269e5ed9d95b35_ask_agent"
```

正确名称是 `ext_b991acef9da253269e929e5ed9d95b35_ask_agent`，模型漏抄了中间的 `929e`。

**根因**

`externaltools/catalog.go:70` 中 `InvocationName = strings.ReplaceAll(BusinessName(id, name), ".", "_")`，也就是 `ext_` 加 32 位 hex 加 `_<name>`，最长 61 个字符。原内置 `agent.ask` 的上游名是 `ask_agent`。

**建议**

给外部工具分配短的、仅在本次请求内有效的上游别名。`provider.MapToolCallNames` 已经按请求维护别名到业务名的映射，`toolNameMapping` 也会检查重复，所以不需要全局唯一。例如：
- `x<k>_<name>`：k 为本次快照内按 integration ID 排序的序号，每个用户最多 8 个；
- 或者 `ext_<id 前 6 位 hex>_<name>`，冲突时加长。

业务名 `ext.<32hex>.<name>` 保持不变，历史记录和权限校验不受影响。

---

## 已完成，供参考

| 项 | 状态 |
|---|---|
| C1 客户端凭据 | 已在 261027161 起提供；真机已签发并用于签名 |
| C2 外部工具开放给所有模型 | `dd3db218c`，真机生效 |
| C4 WS tool-integrations 接受客户端凭据 | 真机生效 |

## 复现方式

1. 设备刷 master（≥ `6cb04ca1e`），LLM 走公司云，对话后端 `local_harness`。
2. 电脑上执行：
   1. `codie scan`
   2. `codie pair begin <id>`
   3. `codie pair confirm <id> <配对码>`
   4. `codie agents tools on <id>`
   5. 再开一个 Claude Code 会话。
3. 对设备说："帮我看看电脑的C盘还剩多少空间"。用 `adb logcat | grep GoLog` 查看 `[LocalHarness] 工具调用` 和 `[E2E-Error]`。
