# dsh-a2a 0.5.0 实施计划（服务端 v1.0 别名）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH 的 A2A 服务端接受 v1.0 方法名与 v1.0 请求体，并按请求方法返回对应形状的响应；卡片补发复数版本供网关如实呈现。

**Architecture:** 纯逻辑进 `src/protocol.ts`（入站归一、`toV1Task`、`isV1Method`/`wireVersionFor`），`src/server.ts` 只做路由、版本头与包装选择。内部模型（`A2aTask`/`A2aMessage`/`Part`）不变，变换只发生在入站解析与出站序列化边界。

**Tech Stack:** TypeScript 5.9（ESM）、Node ≥20、`node:assert` 手写测试、零新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-25-server-v1-aliases-design.md`（定稿 v2）

## Global Constraints

- 内部模型不变：入站归一后仍是 `{kind, role:'user'|'agent', parts:[{kind,...}]}`。
- 响应形状**按请求方法名**；响应头 `A2A-Version` 跟随方法的 wire 版本（v1 方法 → `1.0`，其余 → `0.3.0`）。
- 版本头接受 major `0`/`1`；其他仍 400。`X-A2A-Version` 优先于 `A2A-Version`。
- 卡片仍声明 `protocolVersion: "0.3.0"`，新增 `protocolVersions: ["0.3.0"]`；不宣告 1.0。
- 不做 `SendStreamingMessage` / v1 SSE 帧；`message/stream` 行为不变。
- `rawState` 绝不上线；file part 不产生 `url` 字段。
- 不新增依赖；`protocol.ts` 保持零依赖。

## Review Focus

1. 真实 v1 请求体（`ROLE_USER` + `[{text}]`）必须被接受，而不是 `-32602`。
2. 畸形 part（无 kind 且无 text/data/file）仍必须 `-32602`。
3. `SendMessage` 返回 `{task}` 且状态是 `TASK_STATE_*`、part 无 `kind`、role `ROLE_AGENT`。
4. `message/send` 的字节形状与现状一致（裸 Task、小写状态、带 `kind`）。
5. `message/stream` 配 `X-A2A-Version:1.0` 时响应头必须是 `0.3.0`，帧仍是 v0.3。
6. `unknown` 状态：`rawState` 匹配 `^TASK_STATE_` 时原样输出，否则 `TASK_STATE_UNSPECIFIED`；输出无 `rawState` 字段。
7. 0.4.0 客户端指向 0.5.0 服务端时不回归（卡片复数 `["0.3.0"]` → v0.3 → `message/send`）。

---

### Task 1: 入站双形状解析

**Files:**
- Modify: `src/protocol.ts:356-400`（`parseMessageSendParams`）
- Test: `tests/compat.mjs`

**Interfaces:**
- Produces: `parseMessageSendParams(raw: unknown)` 签名不变，返回的 `params.message.role` 必为 `'user'|'agent'`、`parts[].kind` 必有值。

- [ ] **Step 1: 写失败测试**（`tests/compat.mjs`）
  - `role:"ROLE_USER"` + `parts:[{text:"hi"}]` → `ok:true`，内部 `role==='user'`、`parts[0].kind==='text'`
  - `role:"ROLE_AGENT"` → `role==='agent'`
  - `parts:[{data:{a:1}}]` → `kind==='data'`；`parts:[{file:{uri:"x"}}]` → `kind==='file'`
  - `role:"ROLE_BOT"` → `ok:false`
  - `parts:[{}]` → `ok:false`（文案含 `不支持的 part`）
  - 既有 v0.3 形状回归：`role:"user"` + `{kind:"text",text}` → 通过

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `ROLE_USER` 被拒（`message.role 必须是 "user" 或 "agent"`）

- [ ] **Step 3: 实现**
  - `role`：`ROLE_USER|user` → `user`；`ROLE_AGENT|agent` → `agent`；其他错误。
  - part：若 `kind` 存在走现有三分支；否则按成员判别（`text: string` / `data: object` / `file: {uri|bytes}`），判不出用现有"含不支持的 part"文案报错。
  - `metadata`、`messageId`、`contextId`、`taskId` 逻辑不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: smoke 57/57 + compat 全绿（新增用例计入）

- [ ] **Step 5: 提交**

```bash
git add src/protocol.ts tests/compat.mjs
git commit -m "feat(server): accept v1.0 request bodies (ROLE_* and kindless parts)"
```

---

### Task 2: `toV1Task` 响应变换

**Files:**
- Modify: `src/protocol.ts`（新增导出）
- Test: `tests/compat.mjs`

**Interfaces:**
- Produces: `toV1Task(task: A2aTask): Record<string, unknown>`
- Produces: `isV1Method(method: string): boolean`、`wireVersionFor(method: string): '1.0' | '0.3.0'`

- [ ] **Step 1: 写失败测试**
  - 7 个常规状态 → `TASK_STATE_*`；`auth-required` → `TASK_STATE_AUTH_REQUIRED`
  - `unknown` + `rawState:"TASK_STATE_FUTURE"` → `TASK_STATE_FUTURE`；`rawState:"weird"` → `TASK_STATE_UNSPECIFIED`
  - 输出对象无 `rawState`、无 `kind`
  - `parts`：text → `{text}`；data → `{data}`；file → `{file:{uri}}`
  - `status.message.role:"agent"` → `ROLE_AGENT`
  - `isV1Method('SendMessage')===true`、`('message/send')===false`；`wireVersionFor('GetTask')==='1.0'`、`('tasks/get')==='0.3.0'`

- [ ] **Step 2: 跑测试确认失败** — `npm test`（`toV1Task` 未导出）

- [ ] **Step 3: 实现**（纯函数，放 `protocol.ts`）
  - 状态映射表 + `rawState` 规则；递归变换 `status.message` 与 `history`。
  - 去 `kind`：task / artifact / message。
  - part 按 kind 转成员形态；file 保留 `{uri|bytes,mimeType,name}`。
  - `isV1Method` 白名单 `{SendMessage, GetTask, CancelTask}`；`wireVersionFor` 据此返回。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交** `feat(protocol): v1 task serialization and method wire-version helpers`

---

### Task 3: 服务端接线（版本头 / 别名 / 包装 / 卡片）

**Files:**
- Modify: `src/server.ts`（`handleRpc` 版本门、`dispatch`、`handleSend`/`handleGetTask`/`handleCancel`）
- Modify: `src/protocol.ts`（`buildAgentCard` 增加 `protocolVersions: [PROTOCOL_VERSION]`）
- Test: `tests/smoke.mjs`（新增 Round 2.6 用例块）

**Interfaces:**
- Consumes: `isV1Method` / `wireVersionFor` / `toV1Task` / `parseMessageSendParams`
- Produces: 三个 handler 增加 `v1: boolean` 参数（默认 false）

- [ ] **Step 1: 写失败测试**（smoke）
  - 起服务器后逐条断言：
    - `message/send`（无头）→ 裸 Task、小写状态、part 带 `kind`；头 `0.3.0`
    - `SendMessage`（`1.0`，`ROLE_USER`+kindless）→ `result.task`、`TASK_STATE_COMPLETED`、part 无 `kind`、role `ROLE_AGENT`；头 `1.0`
    - `SendMessage`（无头，v0.3 形状）→ 同 v1 结果；头 `1.0`
    - `GetTask` / `CancelTask`（`1.0`）→ 裸 v1 Task
    - `message/stream`（`1.0`）→ 事件仍是 v0.3 形状；头 `0.3.0`
    - `SendStreamingMessage`（`1.0`）→ `-32601`；头 `1.0`
    - 任意（`2.0`）→ HTTP 400
    - 卡片 GET：含 `protocolVersions:["0.3.0"]`，头仍 `0.3.0`

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL（`SendMessage` → `-32601`；`X-A2A-Version:1.0` → HTTP 400）

- [ ] **Step 3: 实现**
  - `handleRpc` 版本门：允许 major `0`/`1`（无头按 0）；解析出方法后设置 `A2A-Version: wireVersionFor(method)`（覆盖 `setCommonHeaders` 的默认值；卡片/admin/404 保持 `0.3.0`）。
  - `dispatch`：`case 'SendMessage': return this.handleSend(request, true)`；`GetTask`/`CancelTask` 同理 `v1=true`；v0.3 分支传 `false`。
  - `handleSend(request, v1)`：结果 `v1 ? {task: toV1Task(task)} : task.snapshot()`。
  - `handleGetTask` / `handleCancel`：`v1 ? toV1Task(snapshot) : snapshot`。
  - `buildAgentCard`：加 `protocolVersions: [PROTOCOL_VERSION]`。

- [ ] **Step 4: 跑测试确认通过**（含既有 smoke 回归）

- [ ] **Step 5: 提交** `feat(server): v1 method aliases, method-shaped responses and dual-shape version header`

---

### Task 4: 文档、版本与发布准备

**Files:**
- Modify: `README.md`
- Modify: `package.json`（`version: 0.5.0`）

- [ ] **Step 1: README**
  - 新增"服务端 v1.0 兼容"小节：别名、入站双形状、响应形状按方法、响应头规则；
  - 已知限制：不做 v1 流式、卡片不宣告 1.0；
  - 与出站 R8 的关系：本版本可作为严格 fixture。

- [ ] **Step 2: 版本与构建**
  - `package.json` → `0.5.0`；
  - Run: `npm run prepack`（生成 `lib/`）。

- [ ] **Step 3: 全量验证**

Run: `npm test && npm run verify`
Expected: smoke 全绿（含新增用例）、compat 全绿、verify 通过。

- [ ] **Step 4: 提交**

```bash
git add README.md package.json lib
git commit -m "docs: 0.5.0 server v1.0 compatibility"
```
