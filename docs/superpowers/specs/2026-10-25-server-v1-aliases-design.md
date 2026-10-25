# dsh-a2a 0.5.0 设计：服务端 v1.0 别名、入站归一与响应形状

> 状态：草案 v2（builder-check 后修订）
> 日期：2026-10-25
> 范围：dsh-a2a 0.5.0（服务端兼容层）
> 证据来源：`a2a-fleet/docs/debug/2026-10-25-round2.5-dsh-hermes-pi-gateway-integration.md`、`docs/debug/A2A_pi_agent_communication.md`
> 关联：`a2a-way` Round 2.6 spec（`a2a-way/docs/superpowers/specs/2026-10-25-gateway-version-and-depth-design.md`）

## 1. 背景

0.4.0 让**出站客户端**按卡片协商 v1.0/v0.3；**服务端**仍只认 v0.3：

- `server.ts:277-286`：`X-A2A-Version` 的 major 必须等于 `0`，否则 HTTP 400。
- `server.ts:355-373` 的 `dispatch()`：只匹配 `message/send` / `tasks/get` / `tasks/cancel` / `agent/authenticatedExtendedCard`。
- `parseMessageSendParams`（`protocol.ts:366-390`）：**只接受** `role: "user"|"agent"` 与带小写 `kind` 的 part。
- 卡片只发单数 `protocolVersion: "0.3.0"`，不发复数。

builder-check 纠正了初稿的一个重要假设：**光加方法别名不够**。真实 v1.0 客户端的请求体是

```json
{"method":"SendMessage","params":{"message":{"role":"ROLE_USER","parts":[{"text":"…"}],"metadata":{"kind":"request"}}}}
```

（`docs/debug/A2A_pi_agent_communication.md:105-125`，Hermes 的实际 wire 形状）。`parseMessageSendParams` 会以 `-32602` 拒绝它。所以"忽略卡片、硬发 `SendMessage`"的客户端即使过了方法名，也过不了入站校验。**入站归一必须与别名同轮交付**，否则矩阵里的 headline 用例是空的。

## 2. 目标与非目标

**目标**

- 版本头接受 major `0` 与 `1`；其他 major 仍 400。
- `dispatch()` 接受 `SendMessage` / `GetTask` / `CancelTask` 别名。
- **入站报文双形状**：`role` 接受 `ROLE_USER`/`ROLE_AGENT`；part 缺 `kind` 时按成员判别；v0.3 形状继续接受。内部模型不变（小写 role + 带 kind 的 part）。
- 响应形状按**请求方法名**分支：`SendMessage` → `{task: <v1 Task>}`；`message/send` → 裸 v0.3 Task；`GetTask`/`CancelTask` → 裸 v1 Task；`tasks/get`/`tasks/cancel` → 裸 v0.3 Task。
- v1 Task：状态 `TASK_STATE_*`（含 `AUTH_REQUIRED`/`UNSPECIFIED`）、part 去 `kind`、role `ROLE_*`、去掉 `kind` 判别字段、**去掉内部字段 `rawState`**。
- 响应头 `A2A-Version` 跟随**方法的 wire 版本**（v1 方法 → `1.0`，其余 → `0.3.0`），只作用于 RPC 响应。
- 卡片补发 `protocolVersions: ["0.3.0"]`（保留单数），供网关如实呈现。

**非目标**

- 不做 `SendStreamingMessage` / v1.0 SSE 帧（`{statusUpdate}`/`{artifactUpdate}`）；调用返回 `-32601`。
- 不做 `ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` 别名。
- 不在卡片里宣告 `1.0`（服务端能力不完整，不 overclaim）。
- **出站报文按版本切换不在本轮**：前置是严格 v1.0 验收对象（本轮完成后本服务端的 v1.0 模式可当 fixture，见 §7）。
- 不改 `message/stream` 的 SSE 事件形状。

## 3. 设计

### 3.1 版本头

```text
allowedMajors = {"0", "1"}
请求头 major ∈ allowedMajors → 继续；否则 400（文案不变）
无请求头 → 视为 0
响应头 A2A-Version = 方法的 wire 版本：
  SendMessage / GetTask / CancelTask → "1.0"
  其他（message/send、message/stream、tasks/*、resubscribe）→ "0.3.0"
```

- 只对 **RPC 响应**这样设置；卡片 GET 与 `/admin/*`、404 仍固定 `0.3.0`（现状）。
- 两个头同时出现时沿用现有优先级：`X-A2A-Version` 优先于 `A2A-Version`。
- 头与方法名冲突时**方法名决定形状与响应头**（`message/send` 配 `1.0` → v0.3 形状 + `0.3.0` 响应头）。

### 3.2 dispatch 别名

| v1.0 方法 | 映射到 | 说明 |
|---|---|---|
| `SendMessage` | `handleSend` | 入站归一后与 `message/send` 共用 handler |
| `GetTask` | `handleGetTask` | `taskIdParam` 已优先 `params.id` |
| `CancelTask` | `handleCancel` | 同上 |

未知方法仍 `-32601`。

### 3.3 入站归一（关键）

扩展 `parseMessageSendParams`（`protocol.ts`），对**所有入口**双形状接受（不仅 alias；v0.3 调用方发 v1 形状也无害）：

- `role`：`ROLE_USER` → `user`；`ROLE_AGENT` → `agent`；已是 `user`/`agent` 原样；其他仍 `-32602`。
- `parts[]`：有 `kind` 走现状校验；**无 `kind`** 时按成员判别：
  - 有 `text: string` → text；有 `data: object` → data；有 `file: object`（`uri` 或 `bytes`）→ file。
  - 都不满足 → 仍 `-32602`（错误文案保持现有的"含不支持的 part"）。
- `metadata` 原样透传（`kind`/`from` 等不丢）。
- `configuration` 接受但忽略（现状）。
- `messageId`/`contextId`/`taskId` 缺省补齐逻辑不变。

内部仍是 `{kind, role, parts:[{kind,...}], messageId, ...}`，上层 handler / store / bridge 零改动。

### 3.4 响应形状（按请求方法名）

`protocol.ts` 新增纯函数 `toV1Task(task: A2aTask): unknown`：

- 删除对象上的 `kind`（task / artifact / message）。
- `status.state`：
  - 7 个常规值 → `TASK_STATE_SUBMITTED|WORKING|INPUT_REQUIRED|COMPLETED|FAILED|CANCELED|REJECTED`
  - `auth-required` → `TASK_STATE_AUTH_REQUIRED`
  - `unknown` → `rawState`（若匹配 `^TASK_STATE_`），否则 `TASK_STATE_UNSPECIFIED`
- **丢弃 `rawState`**（内部字段不上线）。
- `parts[]`：`{kind:"text",text}` → `{text}`；`{kind:"data",data}` → `{data}`；
  `{kind:"file",file:{uri|bytes,mimeType,name}}` → `{file:{uri|bytes,mimeType,name}}`（内部 FilePart 与 v1 同形，只去 `kind`；**不产生 `url`**）。
- `role`：`user` → `ROLE_USER`；`agent` → `ROLE_AGENT`。
- `status.message` 与 `history[]` 同样变换；`id`/`contextId`/`timestamp`/`artifactId`/`metadata` 原样。

包装：

| 请求方法 | `result` |
|---|---|
| `SendMessage` | `{ task: toV1Task(task) }` |
| `GetTask` / `CancelTask` | `toV1Task(task)` |
| `message/send` / `tasks/get` / `tasks/cancel` | 现状（裸 v0.3 Task） |

错误响应不因版本改变。

### 3.5 卡片

`buildAgentCard` 增加 `protocolVersions: [PROTOCOL_VERSION]`（当前 `["0.3.0"]`），单数保留。目的：网关 Round 2.6 的 presenter 即使不读单数也能取到正确复数；注册方直接提交服务端卡片时不再"恒 1.0"。

## 4. 验收矩阵

| # | 请求（头） | 请求体 | 期望 result | 期望 `A2A-Version` |
|---|---|---|---|---|
| 1 | `message/send`（无） | v0.3 形状 | 裸 v0.3 Task | `0.3.0` |
| 2 | `message/send`（`1.0`） | v0.3 形状 | 裸 v0.3 Task（方法决定） | `0.3.0` |
| 3 | `SendMessage`（`1.0`） | `ROLE_USER` + `{text}` | `{task}`，`TASK_STATE_COMPLETED`，part 无 `kind`，role `ROLE_AGENT` | `1.0` |
| 4 | `SendMessage`（无） | v0.3 形状 | 同 #3（入站双形状） | `1.0` |
| 5 | `GetTask` / `CancelTask`（`1.0`） | `{id}` | 裸 v1 Task | `1.0` |
| 6 | `tasks/get` / `tasks/cancel`（无） | `{taskId}` 或 `{id}` | 裸 v0.3 Task | `0.3.0` |
| 7 | `message/stream`（`1.0`） | v0.3 形状 | v0.3 SSE 帧（现状） | `0.3.0` |
| 8 | `SendStreamingMessage`（`1.0`） | — | `-32601` | `1.0` |
| 9 | 任意（`2.0`） | — | HTTP 400 | — |
| 10 | 网关→DSH（卡片 0.3.0） | v0.3 形状 | `message/send` 真实回复 | `0.3.0` |
| 11 | 忽略卡片硬发 `SendMessage`（Hermes 形状） | `ROLE_USER` + `{text}` | 真实回复，v1 形状 | `1.0` |
| 12 | `auth-required` / `unknown` 任务快照 | — | `TASK_STATE_AUTH_REQUIRED` / `rawState` 或 `TASK_STATE_UNSPECIFIED`，且无 `rawState` 字段 | — |

## 5. 测试计划

- **单测（`tests/compat.mjs`）**：
  - `parseMessageSendParams` 双形状：`ROLE_USER`、kindless 的 text/data/file、坏形状仍 `-32602`。
  - `toV1Task`：9 个状态 + 未知 + `rawState` 丢弃 + part 三型 + role + 去 `kind`。
- **smoke（`tests/smoke.mjs`）**：起真实服务器跑矩阵 1–9、12；v0.3 用例断言字段与现状一致（不断言整对象字节）。
- **联调**：矩阵 10–11（Hermes 硬发；网关按卡片协商）。
- **回归**：现有 57 条 smoke 全绿（v0.3 行为不变）。

## 6. 风险

- **严格 v1.0 客户端可能要求更多**（`status.timestamp`、`metadata` Struct 形态、`task` 的 ProtoJSON 字段名）。本轮按"成员判别 + 枚举名"实现；缺口在联调中追加。
- **形状分支的退路**：若实现复杂，可退"统一返回 v0.3 形状 + README 写清"，但严格 v1.0 客户端会困惑——本 spec 选按方法分支。
- **入站双形状**放宽了 `message/send` 的输入校验；风险是吞掉本应报错的畸形 part。用 `-32602` 的负向用例兜住。
- 卡片仍声明 0.3：按卡片协商的客户端不会走 v1 路径，这是刻意的。

## 7. 与出站报文切换的关系（R8 候选）

出站按版本切换 ProtoJSON 形状仍押后，前置是**严格 v1.0 验收对象**。本轮完成后，DSH 自身的 v1.0 入口（虽然不含流式）可当 fixture：

1. 起本服务端，按矩阵 #3 发 `SendMessage`，断言请求体形状；
2. 让 0.4.0 客户端指向它，验证出站切换的 RED→GREEN。

对应 `docs/requirements.md` 的 **R8（0.6.0 候选）**。

## 8. 工量

- dispatch 别名 + 版本头：0.2 人天。
- 入站归一：0.4 人天。
- `toV1Task` + 包装：0.5 人天。
- 单测 / smoke / 回归：0.6 人天。
- 合计约 **1.7 人天**（比初稿多 0.5，来自入站归一）。
