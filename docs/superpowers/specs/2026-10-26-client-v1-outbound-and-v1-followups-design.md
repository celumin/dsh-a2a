# dsh-a2a 0.6.0 设计：出站报文按版本切换（R8）+ 0.5.0 遗留修复

> 状态：定稿 v2（builder-check 后修订）
> 日期：2026-10-26
> 范围：dsh-a2a 0.6.0
> 需求来源：`docs/requirements.md` R8（0.6.0 候选）；0.5.0 分支终审的 deferred minors
> 关联：`docs/superpowers/specs/2026-10-25-server-v1-aliases-design.md`（0.5.0，已发布）、`docs/debug/A2A_pi_agent_communication.md`（真实 v1.0 wire 抓包）

## 1. 背景

**R8（主需求）**：0.4.0/0.5.0 的出站 `message/send` / `SendMessage` 请求体**恒为 v0.3 形状**——`role:"user"`、`kind:"message"`、`parts[].kind`。Pi / Hermes 宽容，严格 ProtoJSON v1.0 服务端会以 `-32602` 拒绝；0.4.0 时没有严格验收对象，所以一直押后。0.5.0 已发布，服务端 v1.0 入口（`SendMessage` + `ROLE_USER` + 无 `kind` 的 part）可当**严格 fixture**，前置满足。

**0.5.0 终审遗留（随 0.6.0 一并修）**，按评审编号：

| # | 遗留 | 影响 |
|---|---|---|
| M1 | `ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` 等**真实 v1.0 方法名**未实现时 `-32601` 的响应头是 `0.3.0` | v1 客户端看到版本不匹配而不是"方法不支持" |
| M2 | v1 方法名真值三处重复：`V1_METHODS`、`V1_WIRE_METHODS`、`server.ts` 的 `switch` 字面量；`isV1Method` 生产路径未用 | 加别名时改漏一处 → 头对但分发 `-32601`，或反之 |
| M3 | `toV1Task` / `v1Part` / `v1TaskState` 无运行期兜底 | `toV1Task` 是公开导出；JS 调用方传非法 state 会得到**没有 `state` 的 status**，未知 kind 会得到 `parts:[null]` |
| M4 | 请求带 `message.metadata` 时，v0.3 `message/send` 响应的 `history[]` 多出 `metadata` 字段 | 0.5.0 已按 spec 裁定为"原样透传"；缺的是**钉死行为的测试 + 文档**，不是改行为 |
| M5 | `X-A2A-Version: ""`（空值）→ 400，文案 `unsupported A2A version （本服务器 0.3.0）` | 空头应等价于"没带"，当前把客户端笔误变成难懂的 400 |

## 2. 目标与非目标

**目标**

- 出站 message 形状**按协商版本**：v1.0 → `role:"ROLE_USER"`、无 `kind`（message 与 part 都没有）、part 用成员形态；v0.3 → 与 0.5.0 逐字段一致。
- 用**严格验收对象**证明改对：0.5.0 服务端 + 一个"只接受 v1 形状、否则 `-32602`"的 strict proxy，端到端跑通 `SendMessage`；同时用 capture 断言线上字节。
- 回归 v0.3 链路（`message/send`、`tasks/get`、`tasks/cancel`、SSE）与"宽容 v1"链路（现有捕获）：字节与行为都不变。
- M1/M2：v1 方法名**单一真值表**（含 push-notification-config 家族）；响应头按方法名判 `1.0`——未实现的 `-32601`、推送配置 `-32003`。
- M3：`toV1Task` 对非法输入**不抛、不出 `null`/缺字段**。
- M5：空/纯空白 `X-A2A-Version` 视为"没带"。
- M4：不改行为，补测试与 README 说明。

**非目标**

- 不做 `SendStreamingMessage` / v1 SSE 帧；`message/stream` 行为与形状不变。
- 不做 `ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` 的**实现**（仍 `-32601`，只是响应头改对）。
- 不实现推送通知：v1.0 的 `CreateTaskPushNotificationConfig` / `GetTaskPushNotificationConfig` / `ListTaskPushNotificationConfigs` / `DeleteTaskPushNotificationConfig` 映射到现有 `-32003`（`PUSH_NOTIFICATION_NOT_SUPPORTED`）分支，不新建实现。
- 不改响应解析（0.4.0 已完成 v1 响应归一）。
- 不做 `metadata.kind` 的异步语义（`request`/`result` 仍是透传标记）。
- 不切默认版本，不改版本协商顺序，不加"强制 v0.3 出站"的配置开关（回滚方式 = 降级包版本；见 §6）。
- 不动 `0.5.0` 已发布的 npm 版本（新版本号 `0.6.0`）。

## 3. 设计

### 3.1 出站 message 序列化（纯函数）

新增 `src/compat.ts`（与版本适配同处，零依赖）：

```ts
/** 内部 message → 该 wire 版本的 message 对象（JSON-RPC params.message）。 */
export function wireMessageFor(
  version: WireVersion,
  message: A2aMessage,
): Record<string, unknown>
```

- v0.3：`{kind:'message', role, parts, messageId, metadata?, contextId?, taskId?}`，**与 0.5.0 现有构造逐字段相同**（`parts` 保留 `kind`）。
- v1.0：`{role:'ROLE_USER'|'ROLE_AGENT', parts:[{text}|{data}|{file}], messageId, metadata?, contextId?, taskId?}`；message 与 part 都**没有 `kind`**；file part 只写 `{uri|bytes,mimeType,name}`，不产生 `url`。
- 两版都保留 `metadata`（v1 `Message` 有该字段；Hermes 抓包里就带 `{"kind":"request"}`）与 `contextId` / `taskId` / `messageId`。
- 位置：`compat.ts`；`protocol.ts` 的 `toV1Task` 负责**入站/响应**方向，两个方向不互相 import，避免环。

### 3.2 client 接线

`send()` 与 `sendStream()` 各有一份重复的 message 字面量（`src/client.ts:300-310`、`:349-359`）。两处都改为：

```ts
const message: A2aMessage = {
  kind: 'message', role: 'user', parts: [{ kind: 'text', text }], messageId,
  metadata: this.messageMetadata(options?.kind),
  ...(options?.contextId !== undefined ? { contextId: options.contextId } : {}),
}
// rpc params
{ message: wireMessageFor(version, message) }
```

- 方法名、`X-A2A-Version` 头、`{id}` 参数（`getTask`/`cancelTask`）**都不改**——0.4.0 已按版本选好。
- `sendStream` 仍只在 v0.3 被自动选中（`src/client.ts:452`）；直接调用时也按版本序列化。
- **新增显式守卫**：协商到 v1.0 时 `sendStream` 在发请求**之前**抛 `A2aRpcError(-32601, 'v1.0 streaming is not supported（SendStreamingMessage）')`。理由：对真实 v1.0 服务端，`SendStreamingMessage` 会成功并回 `{statusUpdate}`/`{artifactUpdate}` 帧，而现有解析器只认 `event.kind`（v0.3 帧），结果是**默默返回空事件数组**——比明确报错更糟。对 0.5.0 服务端两者都是 `-32601`，语义一致。

### 3.3 v1 方法名单一真值（M1 + M2）

`src/protocol.ts`：

```ts
/** A2A 1.0 的方法名全集（含本服务端未实现/不支持的）：响应头按它判 1.0。 */
export const V1_METHOD_NAMES: readonly string[] = [
  'SendMessage', 'SendStreamingMessage', 'GetTask', 'ListTasks', 'CancelTask',
  'SubscribeToTask', 'GetExtendedAgentCard',
  'CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig',
]
/** 其中真正有别名分发的三个（push 配置族走 -32003，不是别名）。 */
export const V1_ALIASES: ReadonlySet<string> = new Set(['SendMessage', 'GetTask', 'CancelTask'])
export function isV1Method(method: string): boolean  // V1_ALIASES
export function wireVersionFor(method: string): '1.0' | '0.3.0'  // V1_METHOD_NAMES
```

push-notification-config 家族在 `dispatch` 里与 v0.3 的两个等价名**共用同一个分支**：返回 `-32003` + `'本 A2A 服务器不支持推送通知'`，只是响应头是 `1.0`（v1 名字）。这既修了 M1 对这 4 个真名字的洞，又不引入新能力。

`src/server.ts` 的 `dispatch` 改为**表**，不再有第三份字面量：

```ts
private static readonly RPC_ROUTES: Record<string, { handler: 'send' | 'getTask' | 'cancel' | 'pushConfig'; v1: boolean }> = {
  'message/send': { handler: 'send', v1: false },
  SendMessage:    { handler: 'send', v1: true },
  'tasks/get':    { handler: 'getTask', v1: false },
  GetTask:        { handler: 'getTask', v1: true },
  'tasks/cancel': { handler: 'cancel', v1: false },
  CancelTask:     { handler: 'cancel', v1: true },
  'tasks/pushNotificationConfig/set': { handler: 'pushConfig', v1: false },
  'tasks/pushNotificationConfig/get': { handler: 'pushConfig', v1: false },
  CreateTaskPushNotificationConfig: { handler: 'pushConfig', v1: true },
  GetTaskPushNotificationConfig:    { handler: 'pushConfig', v1: true },
  ListTaskPushNotificationConfigs:  { handler: 'pushConfig', v1: true },
  DeleteTaskPushNotificationConfig: { handler: 'pushConfig', v1: true },
}
```

- 未命中 → 现状 `-32601`；`agent/authenticatedExtendedCard`、`tasks/resubscribe` 保持各自分支。
- 测试兜住一致性：`V1_ALIASES ⊆ V1_METHOD_NAMES`；`RPC_ROUTES` 的每个 `v1:true` 键 ∈ `V1_METHOD_NAMES`；`V1_ALIASES` 的每个名字在 `RPC_ROUTES` 里的 handler 不是 `pushConfig`；`V1_ALIASES` 的三个名字 `isV1Method === true`，其余 v1 名字为 `false`。

### 3.4 `toV1Task` 运行期兜底（M3）

- `v1TaskState`：`unknown` 之外、不在映射表的 state（JS 调用方传 `"bogus"`）→ `TASK_STATE_UNSPECIFIED`；缺失 state 同此。
- `v1Part` / part 列表：part 不是对象或 `kind` 无法识别 → **该 part 从输出中省略**（绝不出现 `null`）；`message.parts` 不是数组 → `[]`。
- `v1Message`：`message` 不是对象 → 返回 `{}`（不抛）。
- 合法输入输出**逐字段不变**（0.5.0 已发布行为不回退）。

### 3.5 版本头（M5）

`handleRpc` 的版本门按"**先挑值、再校验**"两步，抽成纯函数 `checkVersionHeader(x, a)`：

1. 取值：`x = X-A2A-Version.trim()`，`a = A2A-Version.trim()`；**空串等价于没带**。
2. 选择：非空 `x` 用它；否则非空 `a` 用它；都空 → 无头，按 0.3 继续。
3. 校验：选中的值 `split('.')[0]` 必须是 `0` 或 `1`，否则 400（文案含原始值）。

由此确定的两条边界：`X:'' + A:2.0` → 400（空 X 等于没带，回落到 A）；`A:''`（无 X）→ 200 + `0.3.0`。

### 3.6 v0.3 metadata 行为钉死（M4）

**不改行为**。补两条测试 + README 一句：

- 请求**不带** `message.metadata` 时，v0.3 `message/send` 的响应体与 0.5.0 逐字段一致（用同一夹具对比，不断言整对象字节，断言 `history[]` 每项无 `metadata` 键、`status`、`artifacts` 结构一致）。
- 请求**带** `message.metadata` 时，`history[]` 对应项保留同一 `metadata`（spec §3.3 的裁定），v1 与 v0.3 一致。

### 3.7 版本与文档

- `package.json` → `0.6.0`；`lib/` 由 `npm run prepack` 重建并提交。
- README：§四 新增"出站报文随协商版本切换"（v1.0/v0.3 对照表 + 回退方式）；§六 已知限制删掉"出站仍是 v0.3 形状"，改成"卡片宣称 1.0 但只接受 v0.3 形状的对端会 `-32602`，回退 0.5.0"；§五 的服务端小节补一句 v1 名字的响应头规则（含未实现方法）。
- `docs/requirements.md`：R8 状态 → `已完成（0.6.0）`，验收证据写进条目；M1–M5 作为"0.5.0 遗留修复"在 R8 条目下加一行引用（不新开 R 编号，避免编号漂移）。

## 4. 验收矩阵

| # | 场景 | 期望 |
|---|---|---|
| 1 | `wireMessageFor('v1.0', …text…)` | `role:'ROLE_USER'`、无 `kind`（message 与 part）、`parts:[{text}]` |
| 2 | `wireMessageFor('v1.0', …data/file…)` | `[{data}]` / `[{file:{uri\|bytes,mimeType,name}}]`，无 `kind`、无 `url` |
| 3 | `wireMessageFor('v0.3', …)` | 与 0.5.0 构造**逐字段相同**（`kind:'message'`、`role:'user'`、part 带 `kind`） |
| 4 | 0.4.0 客户端 → v1.0 卡片（capture） | method `SendMessage`、头 `1.0`、body **无 `kind`**、`role:'ROLE_USER'` |
| 5 | 客户端 → v0.3 卡片（capture） | method `message/send`、头 `0.3`、body 带 `kind`（回归） |
| 6 | 客户端 → **strict v1 proxy** → 真实 0.5.0 服务端 | `sendForText` 成功；proxy 记录了"v1 形状校验通过"一次 |
| 7 | 客户端 → 真实 0.5.0 服务端（卡片 0.3） | `message/send` + v0.3 形状 + 真实回复（回归） |
| 8 | `ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` | `-32601` + `A2A-Version: 1.0` |
| 8b | 4 个 `*TaskPushNotificationConfig(s)` v1 名字 | `-32003` + `A2A-Version: 1.0` |
| 9 | `SendStreamingMessage` | `-32601` + `1.0`（现状保持） |
| 10 | `message/send` / `tasks/get` / `message/stream` | `A2A-Version: 0.3.0`（现状保持） |
| 11 | `X-A2A-Version: ""` / 纯空白；`A2A-Version: ""` | 200 + `0.3.0`（等价无头） |
| 12 | `X:""` + `A:2.0`；`X:2.0`；`A:2.0` | 400（空 X 不压制 A；文案不变） |
| 13 | `toV1Task({status:{state:'bogus'}})` | `TASK_STATE_UNSPECIFIED`，不抛 |
| 14 | `toV1Task` 含未知 kind / 非对象 part | 该 part 省略，`parts` 无 `null` |
| 15 | v0.3 `message/send`（无 metadata） | 响应 `history[]` 无 `metadata` 键（钉死） |
| 16 | v0.3 `message/send`（带 metadata） | `history[]` 保留同一 `metadata`（意图行为） |
| 17 | 全量回归 | 既有 smoke 68 + compat 51 全绿；`npm run verify`；`npm run prepack` |

## 5. 测试计划

- **compat 单测**：矩阵 1–3、13–14（`wireMessageFor` / `toV1Task` 兜底）、`checkVersionHeader` 的取值/优先级/拒绝。
- **smoke（真实服务器）**：矩阵 4–7（capture 断言线上字节；strict proxy 端到端；v1 `sendStream` 守卫）、8–12（响应头、push 配置家族、版本门）、15–16（metadata 钉死）。
- **strict fixture**：测试内联的小 proxy（`node:http`）：解析 `SendMessage` 的 `params.message`，若含 `kind`、或 `role` 不以 `ROLE_` 开头、或 part 含 `kind` → 回 `-32602`；否则转发给真实 `A2aServer` 并把响应原样回传；卡片改用 `supportedInterfaces:[{url:<proxy>,protocolVersion:'1.0'}]`。**只存在于 tests，不进生产代码**。
- **回归**：Pi/Hermes 宽容链路的仓库内等价物——现有 `v10Card` / `v03Card` capture 用例、A2aClient 回环、`message/stream` SSE 用例。真实 Pi/Hermes 联调仍是人工/第三会话步骤（写进 §4 验收与 README）。
- **门禁**：`npm test`、`npm run verify`、`npm run prepack`。

## 6. 风险

- **线上字节变化**：只对**卡片声明 1.0** 的对端生效；v0.3 对端逐字节不变。若某对端卡片错标 1.0 却只吃 v0.3 形状 → `-32602`。回退：`dsh plugin add @celumin/dsh-a2a@0.5.0`（无配置开关，避免"两个形状"分叉出两套线上行为）。
- **严格度不止 role/kind**：严格 ProtoJSON 可能还要求时间戳为 `{seconds,nanos}`、Struct 形态等；本轮只切 message 形状（R8 的期望），响应侧仍按成员判别读。若联调发现更多要求，追加到 R8 备注，不在本轮猜。
- **`messageId` 在严格 v1 里是否必填**：保留（v1 `Message` 有该字段，Hermes 抓包省略但接受）；若对端拒绝，属联调发现项。
- **M1 的 1.0 头会改变未实现方法的响应头**：从 `0.3.0` 变 `1.0`，对按头判断版本的老客户端是"更准确"而非破坏；无客户端依赖该头做方法探测（0.4.0 客户端只读卡片）。
- **push 配置族的形态变化**：4 个 v1 名字从 `-32601` 变为 `-32003`（与 v0.3 等价名一致）。依赖"v1 推送配置方法未知"的调用方会看到更精确的错误；没有实现被悄悄加上。
- **`sendStream` 在 v1.0 上改为立即报错**：直接调用公开 API 的用户从"静默空数组/对端错误"变为结构化 `-32601`；`sendForText` 的自动选路不变（v1 从不选流式）。
- **M5 放宽空头**：空头从 400 变 200 —— 只影响畸形请求，不掩盖真实版本冲突（`2.0` 仍 400）。

## 7. 工量

约 **1.2 人天**：R8 纯函数 + client 接线 0.3；strict fixture 与字节断言 0.4；M1/M2 0.15；M3/M5 0.2；文档与发布准备 0.15。
