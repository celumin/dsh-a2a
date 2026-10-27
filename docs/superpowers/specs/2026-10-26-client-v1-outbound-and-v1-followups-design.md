# dsh-a2a 0.6.0 设计：出站报文按版本切换（R8）+ 0.5.0 遗留修复

> 状态：定稿 v5（第二轮 spec review 吸收后修订）
> 日期：2026-10-26（v4/v5：2026-10-27）
> 范围：dsh-a2a 0.6.0
> 需求来源：`docs/requirements.md` R8（0.6.0 候选）；0.5.0 分支终审的 deferred minors
> 关联：`docs/superpowers/specs/2026-10-25-server-v1-aliases-design.md`（0.5.0，已发布）、`docs/debug/A2A_pi_agent_communication.md`（真实 v1.0 wire 抓包）
> 证据基线：`@celumin/dsh-a2a@0.5.0` 已发布 = tag `v0.5.0` @ `e1a1b18`（npm dist-tag `latest`；用 `git ls-remote --tags fork` 核对，clone 的本地 tag 可能不同步）；本轮改动起点 `cd82893`。
> 评审报告：第一轮 `docs/superpowers/reviews/specs/2026-10-26-client-v1-outbound-and-v1-followups-review.md`（4×P1 / 6×P2；v3 吸收全部 10 条，v4 再吸收两条越界发现 M6/M7）；第二轮 `docs/superpowers/reviews/specs/2026-10-27-client-v1-outbound-and-v1-followups-review-r2.md`（2×P1 / 2×P2；v5 吸收）。评审报告在 spec 冻结后随仓库提交。

## 1. 背景

**R8（主需求）**：0.4.0/0.5.0 的出站 `message/send` / `SendMessage` 请求体**恒为 v0.3 形状**——`role:"user"`、`kind:"message"`、`parts[].kind`。Pi / Hermes 宽容，严格 ProtoJSON v1.0 服务端会以 `-32602` 拒绝；0.4.0 时没有严格验收对象，所以一直押后。0.5.0 已发布（tag `v0.5.0` @ `e1a1b18`），服务端 v1.0 入口（`SendMessage` + `ROLE_USER` + 无 `kind` 的 part）可当**严格 fixture**，前置满足。

**0.5.0 终审遗留 + spec review 的越界发现（均随 0.6.0 一并修）**，按评审编号：

| # | 遗留 | 影响 |
|---|---|---|
| M1 | `ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` 等**真实 v1.0 方法名**未实现时 `-32601` 的响应头是 `0.3.0` | v1 客户端看到版本不匹配而不是"方法不支持" |
| M2 | v1 方法名真值三处重复：`V1_METHODS`、`V1_WIRE_METHODS`、`server.ts` 的 `switch` 字面量；`isV1Method` 生产路径未用 | 加别名时改漏一处 → 头对但分发 `-32601`，或反之 |
| M3 | `toV1Task` / `v1Part` / `v1TaskState` 无运行期兜底 | `toV1Task` 是公开导出；JS 调用方传非法 state 会得到**没有 `state` 的 status**，未知 kind 会得到 `parts:[null]`，缺 `status` / `history` 非数组则直接抛 `TypeError` |
| M4 | 请求带 `message.metadata` 时，v0.3 `message/send` 响应的 `history[]` 多出 `metadata` 字段 | 0.5.0 已按 spec 裁定为"原样透传"；缺的是**钉死行为的测试 + 文档**，不是改行为 |
| M5 | `X-A2A-Version: ""`（空值）→ 400，文案 `unsupported A2A version （本服务器 0.3.0）` | 空头应等价于"没带"，当前把客户端笔误变成难懂的 400 |
| M6 | `normalizeTask` 只归一 `status.state` 与 artifact parts；v1 响应的 `status.message` / `history[]` 仍是 `ROLE_*`、part 无 `kind`（spec review 越界发现 #2） | 客户端返回的 Task 里 role 大小写混用、part 形状与内部模型不一致；0.6.0 让 v1 成为严格对端的正式路径后更明显 |
| M7 | `-32003` 双语义：网关用它表示"上游不可用"（`classifyError` → 可重试），本服务端用同一码表示 `PUSH_NOTIFICATION_NOT_SUPPORTED`（spec review 越界发现 #3） | 客户端可能建议对"不支持推送"重试；本包工具虽不发 push 方法，但分类 API 是错的 |

## 2. 目标与非目标

**目标**

- 出站 message 形状**按协商版本**：v1.0 → `role:"ROLE_USER"`、无 `kind`（message 与 part 都没有）、part 用成员形态；v0.3 → 与 0.5.0 逐字段一致。
- 用**严格验收对象**证明改对：0.5.0 服务端 + 一个"只接受 v1 形状、否则 `-32602`"的 strict proxy，端到端跑通 `SendMessage`；同时用 capture 断言线上字节。
- 回归 v0.3 链路（`message/send`、`tasks/get`、`tasks/cancel`、SSE）：字节与行为都不变。
- M1/M2：v1 方法名**单一真值表**（含 push-notification-config 家族）；响应头按方法名判 `1.0`——未实现的 `-32601`、推送配置 `-32003`。
- M3：`toV1Task` 对非法输入**不抛、不出 `null`/缺 `state`**，覆盖 §3.4 列出的**全部**形状（task/status 非对象、state 非法、`history`/`artifacts`/`parts` 非数组、part 畸形）。
- M5：空/纯空白 `X-A2A-Version` 视为"没带"。
- M4：不改行为，补测试与 README 说明。
- M6：v1 响应的 `status.message` / `history[]` 归一成内部形状（小写 role、part 带 `kind`、message 带 `kind:'message'`），合法输入幂等。
- M7：`-32003` 按**方法**消歧——push 配置方法不可重试，其余保持"上游不可用可重试"；`A2aRpcError` 携带方法名让分类有据。

**非目标**

- 不做 `SendStreamingMessage` / v1 SSE 帧；`message/stream` 行为与形状不变。
- 不做 `ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` 的**实现**（仍 `-32601`，只是响应头改对）。
- 不实现推送通知：v1.0 的 `CreateTaskPushNotificationConfig` / `GetTaskPushNotificationConfig` / `ListTaskPushNotificationConfigs` / `DeleteTaskPushNotificationConfig` 映射到现有 `-32003`（`PUSH_NOTIFICATION_NOT_SUPPORTED`）分支，不新建实现。
- **不扩大 v0.3 的行为面**：`tasks/pushNotificationConfig/list` / `/delete` 今天走 default → `-32601`，本轮**不进路由表**（见 §3.3）。
- 不改响应解析的其它部分（状态归一、artifact parts 归一已由 0.4.0 完成；本轮只补 M6 的 message 归一）。
- 不改 `-32003` 的数值或服务端语义（协议里它就是 `PUSH_NOTIFICATION_NOT_SUPPORTED`；冲突在客户端分类侧解决）。
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
- **新增显式守卫**：协商到 v1.0 时 `sendStream` 在发请求**之前**抛 `A2aRpcError(-32601, 'v1.0 streaming is not supported（SendStreamingMessage）')`。
  - **不抛会怎样**（这是选它的理由，不是补充说明）：真实 v1.0 服务端会**成功**接受 `SendStreamingMessage` 并回 `{statusUpdate}` / `{artifactUpdate}` 帧；现有解析器只认 v0.3 的 `event.kind`，会把这些帧全部跳过 → **不报错、返回空事件数组**。调用方看到"流结束了但什么都没发生"，既拿不到错误码也拿不到事件，比一个明确的 `-32601` 难排查得多。所以宁可提前失败，也不做"宽容地返回空数组"。
  - **为什么是 `-32601` 而不是本地错误码 `-1`**：`classifyError(-1)` 返回 `{retryable:true}`（`src/compat.ts:213-217`），工具层会把 `retryable` 交给模型，模型会对一个必然失败的调用反复重试；`-32601` 在 `classifyError` 里不表态，且与对端"`SendStreamingMessage` 未实现"的错误码一致。
  - 对 0.5.0 服务端两种做法都是 `-32601`，语义一致；`sendForText` 的自动选路不变（v1 从不选流式）。

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
/**
 * 其中真正有**别名分发**的三个。push 配置族 4 个名字**不在**这个集合：
 * 它们只借 v1 名字的响应头，处理仍走 pushConfig 分支（-32003）。
 */
export const V1_ALIASES: ReadonlySet<string> = new Set(['SendMessage', 'GetTask', 'CancelTask'])
export function isV1Method(method: string): boolean  // V1_ALIASES
export function wireVersionFor(method: string): '1.0' | '0.3.0'  // V1_METHOD_NAMES
```

**名字来源**：仓库里没有 A2A v1 proto/规范副本；上表按 A2A 1.0 服务方法集（`SendMessage`、`SendStreamingMessage`、`GetTask`、`ListTasks`、`CancelTask`、`SubscribeToTask`、`GetExtendedAgentCard`、`CreateTaskPushNotificationConfig`、`GetTaskPushNotificationConfig`、`ListTaskPushNotificationConfigs`、`DeleteTaskPushNotificationConfig`）固定，**本节即仓库内的权威表**。增删名字必须同步本节、`src/protocol.ts` 与 §4 矩阵。

push-notification-config 家族在 `dispatch` 里与 v0.3 的两个等价名**共用同一个分支**：返回 `-32003` + `'本 A2A 服务器不支持推送通知'`，只是响应头是 `1.0`（v1 名字）。

**必须区分两个集合**（这是最容易做错的一处）：

- `V1_METHOD_NAMES` 只回答"响应头是 1.0 还是 0.3.0"；
- `V1_ALIASES` 才回答"有没有别名分发"。`isV1Method` 只对 `V1_ALIASES` 为 `true`。

所以 4 个 push 配置名字：**在** `V1_METHOD_NAMES`、**不在** `V1_ALIASES`、`isV1Method === false`、handler 是 `pushConfig`（返回 `-32003`），**不得**给它们加 `SendMessage` 式的别名分发——"实现推送通知"是 spec 的非目标。把它们加进 `V1_ALIASES` 会同时把 `-32003` 变成真实实现或 `-32601`，两种都错。

**v0.3 侧不要顺手补齐**：A2A 0.3 的 push 配置方法集还有 `tasks/pushNotificationConfig/list` / `/delete`，本服务端**从未实现**，今天走 default → `-32601`。本轮**不把它们加进路由表**：

- 保持已发布的 v0.3 线上行为（`-32601`），不把"未实现"悄悄变成"不支持推送"（`-32003`）；
- 若将来要补，单独登记为行为变更并加矩阵行，而不是夹在 0.6.0 里。

`server.ts:16` 的模块注释（写 `tasks/pushNotificationConfig/*` → `-32003`）本轮**顺手改成 `set|get`**，让注释与实现一致。

`src/server.ts` 的 `dispatch` 改为**模块级导出的表**（导出是为了让测试能枚举真值，不是公开 API）：

```ts
export interface RpcRoute {
  readonly handler: 'send' | 'getTask' | 'cancel' | 'pushConfig'
  readonly v1: boolean
}
export const RPC_ROUTES: Readonly<Record<string, RpcRoute>> = {
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
- **用测试兜住真值不漂移**（这是 M2 的验收，不是锦上添花）：在 smoke 里 `import { RPC_ROUTES }`，断言
  1. `V1_ALIASES` 的每个名字 ∈ `V1_METHOD_NAMES`，且 `isV1Method(name) === true`；
  2. `RPC_ROUTES` 里每个 `v1:true` 的键 ∈ `V1_METHOD_NAMES`；
  3. `RPC_ROUTES` 里 `handler === 'pushConfig'` 的键，`v1` 必须是 `V1_METHOD_NAMES.includes(key)`（push 名字 1.0、v0.3 名字 0.3.0）；
  4. `V1_ALIASES` 的名字在 `RPC_ROUTES` 里的 handler 不是 `pushConfig`；
  5. `V1_METHOD_NAMES` 中不属于 `V1_ALIASES` 的名字，`isV1Method === false`；
  6. **`PUSH_CONFIG_METHOD_NAMES`（8 个）与上表一致**：其中 v0.3 前缀名 `wireVersionFor` 为 `0.3.0`、其余必须在 `V1_METHOD_NAMES` 里；`RPC_ROUTES` 的每个 `pushConfig` 键 ∈ `PUSH_CONFIG_METHOD_NAMES`；表里 v1 的 `pushConfig` 键集合 === `PUSH_CONFIG_METHOD_NAMES ∩ V1_METHOD_NAMES`（正好 4 个）。

  第 6 条是 M7 的守卫：`classifyError` 用这张 8 元表判断"是否 push 配置方法"，若将来只改 `V1_METHOD_NAMES`/路由表而漏改它，`-32003` 会重新变成"可重试"，M7 就白修了。

### 3.4 `toV1Task` 运行期兜底（M3）

`toV1Task` 是 `./protocol` 的公开导出，可能被 JS 调用方喂进非 task 形状；本节把兜底范围写死，矩阵 13–14 逐条对应。

- **state**：`unknown` 之外、不在映射表的 state（含缺失、`null`、标量）→ `TASK_STATE_UNSPECIFIED`；`unknown` 分支不变。
- **status**：`task.status` 不是对象（缺失/`null`/标量）→ 输出 `status:{state:'TASK_STATE_UNSPECIFIED'}`，**不写 `timestamp`**（没有来源就不编造）。
- **part**（二分规则，矩阵 14 的前提）：
  - `part.kind` **存在**但不是 `text`/`data`/`file` → 该 part **省略**（不按成员反推，避免把未知类型误读成 text）；
  - `part.kind` **缺失** → 按成员判别：`text: string` / `data: object`（非数组）/ `file: object` 且含 `uri` 或 `bytes`；判不出 → 省略；
  - part 不是对象（`null`/标量）→ 省略。
- **数组与容器**：`message.parts` 非数组 → `[]`；`history` / `artifacts` 非数组 → 省略该字段；artifact 非对象 → 省略该项；`artifact.parts` 非数组 → `[]`。
- **message**：`status.message` 或 `history[]` 里的项不是对象 → **省略该 message**（不返回 `{}`：`{}` 不是合法 v1 Message，只是把"缺字段"换成另一种非法形状）。
- **task 本身不是对象**（`null`/标量）：返回 `{status:{state:'TASK_STATE_UNSPECIFIED'}}` 作为退化骨架——调用方传的不是 task，没有任何字段值得保留。
- **合法输入输出逐字段不变**（0.5.0 已发布行为不回退）。

### 3.5 版本头（M5）

`handleRpc` 的版本门按"**先挑值、再校验**"三步，抽成纯函数：

```ts
export function checkVersionHeader(
  x: unknown,
  a: unknown,
): { ok: true } | { ok: false; raw: string }
```

1. **取值**：`x = trim(X-A2A-Version)`，`a = trim(A2A-Version)`；**空串等价于没带**。
2. **选择**：非空 `x` 用它；否则非空 `a` 用它；都空 → 无头，按 0.3 继续。
3. **校验**：选中值的主版本必须是 `0` 或 `1`，否则 400，错误体为 `unsupported A2A version <选中的值>（本服务器 0.3.0）`。

边界与实现细节：

- `X:'' + A:2.0` → 400，且文案里的值是**选中的 `2.0`**（不是空的 X）；`X:2.0 + A:0.3` → 400（X 优先）；`A:''`（无 X）→ 200 + `0.3.0`。
- **非字符串头**（Node 可能给 `string[]`）：视为非法，`ok:false`；`raw` 取**导致拒绝的那个头**（先看 `x`，再看 `a`）：`Array.isArray(v) ? v.join(',') : String(v)`，避免实现者各自猜 `String([...])` 的格式。

### 3.6 v0.3 metadata 行为钉死（M4）

**不改行为**。补两条测试 + README 一句：

- 请求**不带** `message.metadata` 时，v0.3 `message/send` 的响应体与 0.5.0 逐字段一致（不断言整对象字节；断言 `history[]` 每项无 `metadata` 键、`status` 与 `artifacts` 结构一致）。
- 请求**带** `message.metadata` 时，`history[]` 对应项保留同一 `metadata`（0.5.0 spec §3.3 的裁定），v1 与 v0.3 一致。

### 3.7 版本与文档

- `package.json` → `0.6.0`；`lib/` 由 `npm run prepack` 重建并提交。
- README：
  - §四 新增「出站报文形状（0.6.0）」：v1.0/v0.3 对照表、strict proxy 验收、回退方式（降级 0.5.0）、`sendStream` 在 v1.0 上立即 `-32601`；
  - §五 服务端小节补：未实现的 v1 名字（`ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` / `SendStreamingMessage`）`-32601` 时头 `1.0`；push 配置族（v1 名字）仍 `-32003`、头 `1.0`；
  - **§五（现有 `README:279`）**："出站客户端行为不变（仍是 v0.3 形状…）" → "出站形状随协商版本切换（0.6.0，见 §四）"；
  - **§五（现有 `README:300`）**："0.5.0 的 v1.0 入口…**可用于** 0.6.0…" → "该入口即 strict fixture 的生产侧；回归用例是 `tests/smoke.mjs` 的 strict proxy 用例"；
  - §六 已知限制第 1 条：改为"出站形状随协商版本切换（0.6.0）；卡片错标 1.0 但只吃 v0.3 形状的对端会 `-32602`"，并补一句"v0.3 `message/send` 响应保留请求里的 `message.metadata`（0.5.0 起的有意行为）"。
- `docs/requirements.md`：
  - **基线行**（现 `:6`）改为 `@celumin/dsh-a2a@0.5.0`（npm 已发布；0.6.0 已构建、**待人工发布**）/ 下一个交付 `0.6.0`；**发布前不得写"0.6.0 已发布"**（本计划不执行 npm publish）；
  - R8 状态改成**不虚报**的写法：`进行中（0.6.0：实现与仓库内验收完成；真实 Pi/Hermes 联调待执行，见 §4 矩阵 18）`——需求原文的验收含"回归 Pi/Hermes 两条宽容链路"，仓库内等价物不能替代真实联调；
  - R8 条目补"验收证据"（strict proxy 用例名、capture 断言、`npm test` 计数）与"遗留修复（M1–M7：M1–M5 来自 0.5.0 终审，M6–M7 来自 0.6.0 spec review）"一行；
  - R8 在 `:193` 的映射表行同步改状态。
- **0.5.0 spec 加一行取代注记**（保留原文）：`docs/superpowers/specs/2026-10-25-server-v1-aliases-design.md` §3.1 的表头下加
  "> 0.6.0 更正：本表的响应头规则由 `2026-10-26-client-v1-outbound-and-v1-followups-design.md` §3.3 取代（v1 名字全集 11 个，push 配置族也判 `1.0`）。"
  否则两份 spec 并存会让人按旧表把 M1 改回去。

### 3.8 v1 响应 message 归一（M6）

`src/compat.ts` 新增内部函数 `normalizeMessage(raw): A2aMessage | undefined`，`normalizeTask` 对 `status.message` 与 `history[]` 应用它：

- `role`：`ROLE_USER` / `user` → `user`；`ROLE_AGENT` / `agent` → `agent`；**其它值原样保留**（不认识就不猜，保持证据）。
- `parts`：逐项 `normalizePart`；非对象项（`null`/标量）**丢弃**（不再把 `null` 透传给内部模型）。
- 补 `kind:'message'`（内部模型的判别字段；v1 message 没有它）。
- 其余字段（`messageId` / `taskId` / `contextId` / `metadata`）原样保留。
- 对 v0.3 输入**幂等**：role 已是小写、part 已有 `kind`、message 已有 `kind` → 输出与输入逐字段相同。
- `history` 不是数组时保持现状（不新增字段，也不把 `history:'x'` 变成 `[]`）；`history[]` 里的项不是对象 → 丢弃该项。

### 3.9 `-32003` 双语义消歧（M7）

同一个 `-32003` 在两个生态里含义不同：A2A 协议是 `PUSH_NOTIFICATION_NOT_SUPPORTED`，a2a-way 网关把它复用为"上游不可用"。**不改数值**（协议正确性优先），在客户端分类侧消歧：

```ts
export function classifyError(code: number, method?: string): { retryable?: boolean }

// -32003 + push 配置方法 → { retryable: false }
// -32003 + 其它/未给方法 → { retryable: true }（网关语义，保持 R5 的既有行为）
```

- push 配置方法判定：§3.3 定义的 `PUSH_CONFIG_METHOD_NAMES`（8 个：v0.3 的 `set|get|list|delete` 前缀名 + 4 个 v1 名字），由 `isPushConfigMethod` 提供。
- `A2aRpcError` 增加 `readonly method?: string`（构造器第 4 个可选参数）；`A2aClient.rpc()` 在**收到 JSON-RPC 错误**时带上本次 `method`（传输层 `-1` 不带）；`sendStream` 的 JSON-RPC 错误带 `methodsFor(version).stream`。
- `src/tools.ts` 的 `failure()` 改为 `classifyError(error.code, error.method)`，工具描述里 `retryable` 的说明补一句"push 配置方法的 `-32003` 为 false"。
- **现状不变的部分**：本包工具只发 send/get/cancel，永远不会命中 push 分支，所以工具输出与今天一致；修的是分类 API 与错误对象，让将来接 push 或第三方调用不会拿到"重试一个不支持的能力"的建议。

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
| 8c | v0.3 `tasks/pushNotificationConfig/list` / `/delete` | `-32601` + `0.3.0`（**不进表**，保持已发布行为） |
| 9 | `SendStreamingMessage` | `-32601` + `1.0`（现状保持） |
| 10 | `message/send` / `tasks/get` / `message/stream` | `A2A-Version: 0.3.0`（现状保持） |
| 11 | `X-A2A-Version: ""` / 纯空白；`A2A-Version: ""` | 200 + `0.3.0`（等价无头） |
| 12 | `X:""` + `A:2.0`；`X:2.0`；`A:2.0` | 400，错误体含**选中的值**（`X:''+A:2.0` → 含 `2.0`） |
| 13 | `toV1Task` 的非法输入：`state:'bogus'`；缺 `status`；`status:null`；`history:'x'`；`artifacts:[{}]` | 均不抛；status 有 `state`（`TASK_STATE_UNSPECIFIED`）；`history:'x'` → **省略 `history` 字段**；`artifacts:[{}]` → 该 artifact 被省略 |
| 13b | `status.message:'nope'`；`history[0].parts:'x'`；`artifacts[0].parts:'x'` | 分别：**省略 `status.message`**；`history[0].parts === []`；`artifacts[0].parts === []` |
| 14 | `toV1Task` 的 part 规则 | 显式未知 `kind`（`{kind:'video',text:'x'}`）→ 省略；**缺 `kind`** 的 `{text:'ok'}` → 保留为 `[{text:'ok'}]`；非对象 → 省略 |
| 15 | v0.3 `message/send`（无 metadata） | 响应 `history[]` 无 `metadata` 键（钉死） |
| 16 | v0.3 `message/send`（带 metadata） | `history[]` 保留同一 `metadata`（意图行为） |
| 17 | 全量回归 | 既有 smoke 68 + compat 51 全绿；`npm run verify`；`npm run prepack` |
| 18 | **真实 Pi / Hermes 各一次 `a2a_send`（人工联调，记录写进 README）** | 成功 + 对端回包形状记录；**未执行前 R8 不标"已完成"** |
| 19 | v1 响应（strict proxy → 真实 0.5.0 服务端，用必抛错 runner 让服务器写 `status.message`）的 message 归一 | `state === 'failed'`；`history[0]` 与 `status.message` 的 role 是 `user`/`agent`、part 带 `kind`、message 带 `kind:'message'` |
| 20 | `classifyError(-32003, 'CreateTaskPushNotificationConfig')` / `(-32003)` / `(-32003, 'message/send')` | `{retryable:false}` / `{retryable:true}` / `{retryable:true}` |
| 21 | v1 响应的 JSON-RPC 错误 | `A2aRpcError.method === 'SendMessage'`（错误对象携带方法名，分类据此消歧） |

## 5. 测试计划

- **compat 单测**：矩阵 1–3、13–14（含 13b 的三条容器规则；`wireMessageFor` / `toV1Task` 兜底）、`checkVersionHeader` 的取值/优先级/非字符串拒绝、矩阵 19 的 `normalizeTask` message 归一（含 v0.3 幂等）、矩阵 20 的 `classifyError` 消歧。
- **smoke（真实服务器）**：矩阵 4–7（capture 断言线上字节；strict proxy 端到端；v1 `sendStream` 守卫 + 错误码）、8–12（响应头、push 配置家族、v0.3 `/list` `/delete`、版本门）、15–16（metadata 钉死）、19/21（v1 响应 message 归一 + 错误对象带方法）；**外加真值不漂移**：`import { RPC_ROUTES }` 跑 §3.3 的 5 条不变量。
- **strict fixture**：测试内联的小 proxy（`node:http`）：解析 `SendMessage` 的 `params.message`，若含 `kind`、或 `role` 不以 `ROLE_` 开头、或 part 含 `kind` → 回 `-32602`；否则转发给真实 `A2aServer` 并把响应原样回传；卡片改用 `supportedInterfaces:[{url:<proxy>,protocolVersion:'1.0'}]`。**只存在于 tests，不进生产代码**。
- **回归**：v0.3 链路的仓库内等价物——现有 `v10Card` / `v03Card` capture 用例、A2aClient 回环、`message/stream` SSE 用例。
- **人工联调（矩阵 18）**：真实 Pi / Hermes 各一次 `a2a_send`；结果与回包形状记进 README 的联调小节，未执行则 R8 保持"进行中"。
- **门禁**：`npm test`、`npm run verify`、`npm run prepack`。

## 6. 风险

- **线上字节变化**：只对**卡片声明 1.0** 的对端生效；v0.3 对端逐字节不变。若某对端卡片错标 1.0 却只吃 v0.3 形状 → `-32602`。回退：`dsh plugin add @celumin/dsh-a2a@0.5.0`（无配置开关，避免"两个形状"分叉出两套线上行为）。
- **严格度不止 role/kind**：严格 ProtoJSON 可能还要求时间戳为 `{seconds,nanos}`、Struct 形态等；本轮只切 message 形状（R8 的期望），响应侧仍按成员判别读。若联调发现更多要求，追加到 R8 备注，不在本轮猜。
- **`messageId` 在严格 v1 里是否必填**：保留（v1 `Message` 有该字段，Hermes 抓包省略但接受）；若对端拒绝，属联调发现项。
- **M1 的 1.0 头会改变未实现方法的响应头**：从 `0.3.0` 变 `1.0`，对按头判断版本的老客户端是"更准确"而非破坏；无客户端依赖该头做方法探测（0.4.0 客户端只读卡片）。
- **push 配置族的形态变化**：4 个 v1 名字从 `-32601` 变为 `-32003`（与 v0.3 等价名一致）。依赖"v1 推送配置方法未知"的调用方会看到更精确的错误；没有实现被悄悄加上。v0.3 的 `/list`、`/delete` **不动**，仍 `-32601`。
- **`sendStream` 在 v1.0 上改为立即报错**：直接调用公开 API 的用户从"静默空数组/对端错误"变为结构化 `-32601`；`sendForText` 的自动选路不变（v1 从不选流式）。
- **M5 放宽空头**：空头从 400 变 200 —— 只影响畸形请求，不掩盖真实版本冲突（`2.0` 仍 400）。
- **结构化兜底的代价**：`toV1Task` 对"根本不是 task"的输入返回退化骨架，可能把调用方的 bug 变成静默空任务。取舍：公开导出的序列化器优先"不崩、不产 `null`"，由测试与文档钉死形状；服务端内部调用永远传合法快照，不受影响。

- **v1 响应归一（M6）的边界**：只补 `status.message` / `history[]`；`history` 不是数组时保持现状（不凭空造 `[]`）。未知 role 原样保留，不猜成 `user`/`agent`。
- **`-32003` 消歧（M7）的边界**：只在客户端分类侧按方法名区分；服务端仍按协议返回 `-32003`，网关仍用它表示上游不可用。方法名缺失时保持旧行为（可重试），这是 R5 的既定取舍。

## 7. 执行者裁定（builder-check + spec review 后由实现方拍板，需人确认）

| # | 问题 | 裁定 | 理由 / 反事实 |
|---|---|---|---|
| 1 | push-notification-config 家族算不算 v1 名字？ | **算** `V1_METHOD_NAMES`（11 个之一），**不属于** `V1_ALIASES`；与 v0.3 的 `set`/`get` 共用 `pushConfig` 分支返回 `-32003`、头 `1.0`；v0.3 `/list` `/delete` **不进表**、仍 `-32601` | 不纳入则 M1 对这 4 个仍留 `0.3.0`；但"算 v1 名字"只控制响应头，给它们加别名分发等于实现推送通知（非目标）。v0.3 `/list` `/delete` 今天是 `-32601`，补进表会把"未实现"改成"不支持推送"，是未登记的线上行为变化。 |
| 2 | `X:""` + `A:2.0` / `A:""` / 非字符串头 | 空 X 等于没带 → 回落 A；`A:2.0` → 400（文案含 `2.0`）；`A:""` → 200 + `0.3.0`；`string[]` 头 → `ok:false`，`raw` 用 `','.join` | "先挑值、再校验"同时满足"空头等价没带"和"X 优先"；空 X 压制 A 会让 `2.0` 静默通过。数组不 join 定规则，实现者会各自猜文案。 |
| 3 | 真实 v1 服务端上的 `sendStream` | 发请求前抛 `-32601` | 不抛则 v1 帧被只认 `event.kind` 的解析器全部跳过 → 静默空数组：既无错误也无事件。码值必须是 `-32601` 而不是 `-1`：`classifyError(-1)` → `retryable:true`，会诱导模型重试一个必然失败的调用。 |
| 4 | `toV1Task` 兜底到底覆盖哪些形状？ | 覆盖 §3.4 全部结构性畸形（task/status 非对象、数组非数组、message 非对象、part 二分支）；task 非对象返回退化骨架 | 只兜"字段畸形"会让 `{kind:'task',id,contextId}`（缺 status）仍抛 `TypeError`，与"公开导出不崩"的目标自相矛盾。代价是可能把调用方 bug 变成空任务，用测试与 §3.4 钉死形状。 |
| 5 | M6 归一哪些 message？未知 role 怎么办？ | `status.message` + `history[]`；未知 role 原样保留 | 只补 role 会让 `history[].parts` 仍是"无 kind 的成员形态"，内部消费方按 `kind` 分支会读不到；未知 role 猜成 `user` 会掩盖对端 bug。 |
| 6 | M7 怎么消歧 `-32003`？ | 客户端 `classifyError(code, method?)` + `A2aRpcError.method`；不改数值、不改服务端 | 改数值会破坏 A2A 协议语义与 0.5.0 已发布行为；让 `-32003` "不表态"会丢掉 R5 的"网关上游不可用可重试"建议。方法名是唯一可靠且不破坏两边的区分点。 |

## 8. 工量

约 **1.6 人天**（v4 比 v3 多 0.2：M6 响应归一 + M7 错误消歧）：R8 纯函数 + client 接线 0.3；strict fixture 与字节断言 0.4；M1/M2 与不变量测试 0.2；M3/M5 0.3；M6/M7 0.2；文档与发布准备 0.2。
