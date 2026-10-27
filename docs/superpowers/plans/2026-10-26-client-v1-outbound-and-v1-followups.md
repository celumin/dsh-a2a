# dsh-a2a 0.6.0 实施计划（R8 出站按版本切换 + 遗留修复 M1–M7）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 出站 message 形状跟随协商版本（v1.0 → ProtoJSON 形状，v0.3 逐字节不变），并用严格验收对象证明；同时修掉 0.5.0 终审遗留与 spec review 越界项（M1–M7）。

**Architecture:** 版本适配仍是纯函数：`compat.ts` 新增 `wireMessageFor(version, message)`，`client.ts` 的 `send`/`sendStream` 两处字面量改为调用它，`sendStream` 在 v1.0 上提前报错。服务端收敛真值：`protocol.ts` 的 `V1_METHOD_NAMES`/`V1_ALIASES`/`PUSH_CONFIG_METHOD_NAMES` + `server.ts` 的**导出**路由表；版本门抽成 `checkVersionHeader(x, a)`；`toV1Task` 加结构性兜底；`compat.ts` 补 v1 响应 message 归一（M6）与 `-32003` 按方法消歧（M7，`A2aRpcError` 携带 `method`）。strict v1 验收对象是**测试内联 proxy**（校验 v1 形状后才转发给真实 0.5.0 服务端），不进生产代码。

**Tech Stack:** TypeScript 5.9（ESM）、Node ≥20、`node:assert` 手写测试、`node:http`（测试内联严格 proxy）、零新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-26-client-v1-outbound-and-v1-followups-design.md`（定稿 v6，三轮 spec review 后冻结）

## Global Constraints

- 不新增依赖；`protocol.ts` / `compat.ts` 保持零依赖（只 import 类型与 node 内置）。
- **v0.3 线上字节与行为不变**：无 `message.metadata` 时，`message/send` / `message/stream` 的请求体与 0.5.0 逐字段一致；v0.3 `tasks/pushNotificationConfig/list` / `/delete` **仍是 `-32601`**（不进路由表）。
- v1.0 出站 message：`role` 用 `ROLE_USER`/`ROLE_AGENT`，message 与 part **都没有 `kind`**，part 用成员形态（`{text}`/`{data}`/`{file}`），file 不产生 `url`。
- 方法名、`X-A2A-Version` 头、`{id}` 参数的现有规则不变；`message/stream` 的 SSE 行为与帧形状不变。
- 不做 `SendStreamingMessage` 实现；`ListTasks`/`SubscribeToTask`/`GetExtendedAgentCard` 仍 `-32601`（头 `1.0`）；4 个 `*TaskPushNotificationConfig(s)` 仍是 `-32003`（头 `1.0`）。
- `sendStream` 在协商到 v1.0 时抛 **`A2aRpcError(-32601, 'v1.0 streaming is not supported（SendStreamingMessage）')`**——码值必须是 `-32601`（`-1` 会被 `classifyError` 标成可重试）。
- `toV1Task` 对合法输入的输出逐字段不变（0.5.0 已发布行为不回退）；§3.4 列出的全部结构性非法输入不抛、不产生 `null`/缺 `state`。
- 每次 `tsc` 重建的 `lib/` 与 `src/` 一起提交（仓库跟踪构建产物）。
- **M6**：v1 响应的 `status.message` / `history[]` 归一成内部形状（role 小写、part 带 `kind`、message 带 `kind:'message'`），v0.3 输入幂等；未知 role 原样保留。
- **M7**：`classifyError(code, method?)` 对 push 配置方法的 `-32003` 返回 `{retryable:false}`，其余 `-32003` 保持 `{retryable:true}`；`A2aRpcError` 携带 `method`。
- 版本 `0.6.0`；**不执行 npm publish**（人的决定）；R8 在真实 Pi/Hermes 联调前**不标"已完成"**。

## Review Focus

1. 严格 v1.0 对端（拒收任何多余 `kind`）收到的请求体里，**message 层与 part 层都没有 `kind`**，且 role 是 `ROLE_*`。
2. v0.3 对端不回归：`message/send` 与 `message/stream` 的请求体在"无 metadata"时与 0.5.0 逐字段一致；`tasks/pushNotificationConfig/list` / `/delete` 仍是 `-32601`。
3. 切形状时不顺带丢字段：`messageId` / `contextId` / `taskId` / `metadata` 在 v1 与 v0.3 两版都随行。
4. `toV1Task` 是公开导出：`state:'bogus'`、缺 `status`、`status:null`、`history:'x'`、`artifacts:[{}]`、未知 `kind`、缺 `kind`、非对象 part 都不抛、不产 `null`、status 一定有 `state`。
5. v1 方法名真值不漂移：`V1_ALIASES`、导出的 `RPC_ROUTES`、`wireVersionFor` 三者一致；未实现/不支持的 v1 名字 `-32601` / `-32003` 时头都是 `1.0`，v0.3 名字仍是 `0.3.0`；`sendStream` 的错误码是 `-32601`。
6. v1 响应的 message 归一：`history[]` 与 `status.message` 的 role/part 是内部形状，v0.3 响应逐字段不变（幂等）；`-32003` 在 push 配置方法上不可重试、在其它方法上仍是"上游不可用可重试"。

---

### Task 1: `wireMessageFor` 纯函数

**Files:**
- Modify: `src/compat.ts`（新增导出，放在 `normalizePart` 之后的"响应归一"之前）
- Test: `tests/compat.mjs`

**Interfaces:**
- Produces: `export function wireMessageFor(version: WireVersion, message: A2aMessage): Record<string, unknown>`
- Consumes: `WireVersion`（已有）、`A2aMessage`/`Part`（`./protocol.ts` 类型）

- [ ] **Step 1: 写失败测试**（`tests/compat.mjs`，新增小节"出站报文形状（R8）"）

```js
import { wireMessageFor } from '../lib/compat.js'

test('wireMessageFor：v1.0 去 kind、role 用 ROLE_*、part 用成员形态', () => {
  const out = wireMessageFor('v1.0', {
    kind: 'message', role: 'user', messageId: 'm1',
    parts: [{ kind: 'text', text: 'hi' }],
    metadata: { kind: 'request' }, contextId: 'c1', taskId: 't1',
  })
  assert.deepEqual(out, {
    role: 'ROLE_USER',
    parts: [{ text: 'hi' }],
    messageId: 'm1',
    metadata: { kind: 'request' },
    contextId: 'c1',
    taskId: 't1',
  })
})

test('wireMessageFor：v1.0 的 data / file part 与 agent role', () => {
  const out = wireMessageFor('v1.0', {
    kind: 'message', role: 'agent', messageId: 'm2',
    parts: [{ kind: 'data', data: { a: 1 } }, { kind: 'file', file: { uri: 'file://x', mimeType: 'text/plain', name: 'x.txt' } }],
  })
  assert.equal(out.role, 'ROLE_AGENT')
  assert.deepEqual(out.parts[0], { data: { a: 1 } })
  assert.deepEqual(out.parts[1], { file: { uri: 'file://x', mimeType: 'text/plain', name: 'x.txt' } })
  assert.equal('url' in out.parts[1].file, false)
  assert.equal('kind' in out, false)
})

test('wireMessageFor：v0.3 与 0.5.0 的构造逐字段相同', () => {
  const out = wireMessageFor('v0.3', {
    kind: 'message', role: 'user', messageId: 'm3', parts: [{ kind: 'text', text: 'hi' }],
    metadata: { kind: 'message' },
  })
  assert.deepEqual(out, {
    kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm3',
    metadata: { kind: 'message' },
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL（`SyntaxError: ... does not provide an export named 'wireMessageFor'`）

- [ ] **Step 3: 实现**

`compat.ts`：v0.3 返回 `{kind:'message', role, parts, messageId, metadata?, contextId?, taskId?}`（与现状逐字段相同）；v1.0 同字段但 `role: message.role === 'user' ? 'ROLE_USER' : 'ROLE_AGENT'`、`parts: message.parts.map(p => p.kind === 'text' ? {text:p.text} : p.kind === 'data' ? {data:p.data} : {file:p.file})`；part 的 `metadata` 若存在一并保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（smoke 68 + compat 54）

- [ ] **Step 5: 提交**

```bash
git add src/compat.ts tests/compat.mjs lib
git commit -m "feat(compat): build outbound messages for the negotiated wire version"
```

---

### Task 2: client 接线 + v1 流式守卫 + 线上字节断言

**Files:**
- Modify: `src/client.ts:289-310`（`send`）、`src/client.ts:337-370`（`sendStream`）
- Test: `tests/smoke.mjs:844-880`（"v1.0 用 SendMessage"/"v0.3 用 message/send"）、`tests/smoke.mjs:576`（`sendStream` metadata 用例）

**Interfaces:**
- Consumes: `wireMessageFor`（Task 1）、`A2aRpcError`（已有）、`A2aMessage`
- Produces: `send`/`sendStream` 的 `params.message` 形状随版本；v1.0 的 `sendStream` 抛 `A2aRpcError`（`code === -32601`，message 含 `v1.0 streaming is not supported`）

- [ ] **Step 1: 加强/新增失败断言**

在 "A2aClient：v1.0 用 SendMessage、版本头 1.0、解包 {task}" 里（`agent.calls[0]` 之后）加：

```js
const body = agent.calls[0].params.message
assert.equal('kind' in body, false)
assert.equal(body.role, 'ROLE_USER')
assert.deepEqual(body.parts, [{ text: 'hi' }])
assert.equal('kind' in body.parts[0], false)
```

在 "A2aClient：v0.3 用 message/send、版本头 0.3" 里加：

```js
const body = agent.calls[0].params.message
assert.equal(body.kind, 'message')
assert.equal(body.role, 'user')
assert.equal(body.parts[0].kind, 'text')
```

在 "A2aClient.sendStream：metadata 携带 from/kind" 里（`fake.messages[0]` 之后）加：

```js
assert.equal(fake.messages[0].params.message.kind, 'message')
assert.equal(fake.messages[0].params.message.role, 'user')
assert.equal(fake.messages[0].params.message.parts[0].kind, 'text')
```

新增用例（Round 2.5 版本协商块内）：

```js
await test('A2aClient：v1.0 的 sendStream 提前报错，不发请求', async () => {
  const agent = await startAgent({ ...v10Card, capabilities: { streaming: true } }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(rpcResult(req, completedV10)))
  })
  try {
    const c = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
    await assert.rejects(
      () => c.sendStream('x', () => {}),
      (e) => e.code === -32601 && /v1\.0 streaming is not supported/.test(e.message),
    )
    assert.equal(agent.calls.length, 0)
  } finally {
    await agent.close()
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— v1.0 请求体仍带 `kind`/role 是 `user`；`sendStream` 用例收到对端的同步 result 而不是拒绝

- [ ] **Step 3: 接线**

`send()` 与 `sendStream()` 共用同一段构造：

```ts
const message: A2aMessage = {
  kind: 'message', role: 'user', parts: [{ kind: 'text', text }], messageId,
  metadata: this.messageMetadata(options?.kind),
  ...(options?.contextId !== undefined ? { contextId: options.contextId } : {}),
}
```

- `send`：`this.rpc<unknown>(methodsFor(version).send, { message: wireMessageFor(version, message) }, deadline)`
- `sendStream`：`JSON.stringify({ jsonrpc:'2.0', id, method: methodsFor(version).stream, params: { message: wireMessageFor(version, message) } })`
- `sendStream` 在算出 `version` 后、发请求前：`if (version === 'v1.0') throw new A2aRpcError(-32601, 'v1.0 streaming is not supported（SendStreamingMessage）')`
  - **不要"宽容化"这个守卫**：真实 v1 服务端会成功回 v1 帧（`{statusUpdate}`/`{artifactUpdate}`），而解析器只认 v0.3 的 `event.kind`，会把它们全跳过 → 静默返回空事件数组（既无错误也无事件）。
  - **码值不要改成 `-1`**：`classifyError(-1)` → `{retryable:true}`，工具层会建议重试一个必然失败的调用；`-32601` 不表态，且与对端未实现该方法的错误码一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（smoke 69 + compat 54；SSE 用例仍绿）

- [ ] **Step 5: 提交**

```bash
git add src/client.ts tests/smoke.mjs lib
git commit -m "feat(client): send the negotiated message shape and guard v1 streaming"
```

---

### Task 3: strict v1 验收对象（测试内联 proxy）

**Files:**
- Test: `tests/smoke.mjs`（新增 helper `startStrictV1(serverUrl)`，放在 `startAgent` 之后；一条 Round 2.6 用例）

**Interfaces:**
- Consumes: 真实 `A2aServer` 的地址（`startServer().url`）、`A2aClient`
- Produces: `async function startStrictV1(serverUrl)` → `{ origin, get validated(), violations, close() }`

- [ ] **Step 1: 写 helper 与失败用例**

```js
async function startStrictV1(serverUrl) {
  const violations = []
  let validated = 0
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        name: 'strict-v1', version: '1.0.0',
        capabilities: { streaming: false }, skills: [],
        supportedInterfaces: [{ url: `http://127.0.0.1:${server.address().port}/`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      }))
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      const parsed = JSON.parse(body)
      const m = parsed?.params?.message ?? {}
      if (m.role !== 'ROLE_USER' && m.role !== 'ROLE_AGENT') violations.push('role')
      if ('kind' in m) violations.push('message.kind')
      if (!Array.isArray(m.parts) || m.parts.length === 0) violations.push('parts')
      for (const p of m.parts ?? []) {
        if ('kind' in p) violations.push('part.kind')
        if (['text', 'data', 'file'].filter((k) => k in p).length !== 1) violations.push('part.members')
      }
      if (violations.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32602, message: 'strict v1: invalid params' } }))
        return
      }
      validated += 1
      const forwarded = await fetch(serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      const text = await forwarded.text()
      res.writeHead(forwarded.status, { 'Content-Type': 'application/json' })
      res.end(text)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    get validated() { return validated },
    violations,
    close: () => new Promise((r) => server.close(r)),
  }
}

await test('Round 2.6：严格 v1 对端（0.5.0 服务端 + strict proxy）接受出站形状', async () => {
  const strict = await startStrictV1(rpc)   // rpc = openServer.url
  try {
    const client = new A2aClient({ baseUrl: strict.origin, timeoutMs: 5000 })
    const { task, text } = await client.sendForText('strict v1', { preferStream: false })
    assert.equal(strict.violations.length, 0, `strict 违约：${strict.violations.join(',')}`)
    assert.equal(strict.validated, 1)
    assert.equal(task.status.state, 'completed')
    assert.match(text, /^echo: strict v1/)
  } finally {
    await strict.close()
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL（`strict.violations` 含 `message.kind`/`part.kind`/`role`，客户端抛 `-32602`）

- [ ] **Step 3: 不改生产代码**

Task 1/2 已实现。若仍 FAIL，按 systematic-debugging 查 `wireMessageFor` 或接线，不要改用例迁就实现。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（smoke 70 + compat 54；既有 A2aClient 回环仍在 v0.3 链路上通过）

- [ ] **Step 5: 提交**

```bash
git add tests/smoke.mjs
git commit -m "test: accept the v1.0 outbound shape against a strict fixture"
```

---

### Task 4: v1 方法名单一真值 + push 配置家族 + 响应头（M1/M2）

**Files:**
- Modify: `src/protocol.ts:456-490`（`V1_METHODS`/`V1_WIRE_METHODS`/`isV1Method`/`wireVersionFor`）
- Modify: `src/server.ts`（`dispatch` 改表；路由表**导出**；`:16` 的 `/*` 注释改成 `set|get`）
- Test: `tests/compat.mjs`、`tests/smoke.mjs`（Round 2.6 块内新增四条）

**Interfaces:**
- Produces: `export const V1_METHOD_NAMES: readonly string[]`（11 个）、`export const V1_ALIASES: ReadonlySet<string>`（3 个）
- Produces: `export const PUSH_CONFIG_METHOD_NAMES: readonly string[]`（8 个：v0.3 `set|get|list|delete` + 4 个 v1 名字）、`export function isPushConfigMethod(method: string | undefined): boolean`（Task 6 的 M7 用它）
- Produces: `export interface RpcRoute`、`export const RPC_ROUTES: Readonly<Record<string, RpcRoute>>`（server.ts，供测试枚举）
- Produces: `isV1Method` / `wireVersionFor` 签名不变；`V1_METHODS` / `V1_WIRE_METHODS` 删除（无外部引用，已 grep）
- Consumes: `handleSend`/`handleGetTask`/`handleCancel`（签名不变）

- [ ] **Step 1: 写失败测试**

`tests/compat.mjs`（替换现有 `isV1Method / wireVersionFor` 用例；数量不变）：

```js
import { V1_METHOD_NAMES, V1_ALIASES, PUSH_CONFIG_METHOD_NAMES, isV1Method, wireVersionFor } from '../lib/protocol.js'

test('v1 方法名：全集判 1.0，别名集合只含三个，push 集合不越界', () => {
  for (const m of V1_METHOD_NAMES) assert.equal(wireVersionFor(m), '1.0', m)
  assert.equal(V1_METHOD_NAMES.length, 11)
  for (const m of ['message/send', 'message/stream', 'tasks/get', 'tasks/cancel', 'tasks/resubscribe', 'agent/authenticatedExtendedCard', 'CustomThing']) {
    assert.equal(wireVersionFor(m), '0.3.0', m)
  }
  assert.deepEqual([...V1_ALIASES].sort(), ['CancelTask', 'GetTask', 'SendMessage'])
  for (const alias of V1_ALIASES) assert.equal(isV1Method(alias), true, alias)
  for (const name of V1_METHOD_NAMES.filter((m) => !V1_ALIASES.has(m))) assert.equal(isV1Method(name), false, name)

  // push 集合三分法：v0.3 前缀名判 0.3.0，v1 名必须同时在 V1_METHOD_NAMES 里；4 个 v1 push 名是交集。
  assert.equal(PUSH_CONFIG_METHOD_NAMES.length, 8)
  for (const m of PUSH_CONFIG_METHOD_NAMES) {
    if (m.startsWith('tasks/pushNotificationConfig/')) assert.equal(wireVersionFor(m), '0.3.0', m)
    else assert.equal(V1_METHOD_NAMES.includes(m), true, m)
  }
  assert.deepEqual(
    PUSH_CONFIG_METHOD_NAMES.filter((m) => V1_METHOD_NAMES.includes(m)).sort(),
    ['CreateTaskPushNotificationConfig', 'DeleteTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs'],
  )
})
```

`tests/smoke.mjs`（Round 2.6 块）：

```js
import { RPC_ROUTES, A2aServer } from '../lib/server.js'   // A2aServer 已导入，补 RPC_ROUTES

await test('Round 2.6：未实现的 v1 名字 -32601 但响应头是 1.0', async () => {
  for (const method of ['ListTasks', 'SubscribeToTask', 'GetExtendedAgentCard', 'SendStreamingMessage']) {
    const { response } = await post(rpc, { jsonrpc: '2.0', id: 1, method }, { 'X-A2A-Version': '1.0' })
    const payload = await response.json()
    assert.equal(response.headers.get('a2a-version'), '1.0', method)
    assert.equal(payload.error.code, -32601, method)
  }
})

await test('Round 2.6：push 配置家族（v1 名字）仍是 -32003 + 1.0 头', async () => {
  for (const method of [
    'CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig',
    'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig',
  ]) {
    const { response } = await post(rpc, { jsonrpc: '2.0', id: 1, method, params: {} }, { 'X-A2A-Version': '1.0' })
    const payload = await response.json()
    assert.equal(response.headers.get('a2a-version'), '1.0', method)
    assert.equal(payload.error.code, -32003, method)
  }
})

await test('Round 2.6：v0.3 名字仍是 0.3.0 头；/list /delete 仍 -32601', async () => {
  for (const method of ['message/send', 'tasks/get', 'tasks/pushNotificationConfig/set', 'tasks/pushNotificationConfig/get']) {
    const { response } = await post(rpc, { jsonrpc: '2.0', id: 1, method, params: {} })
    assert.equal(response.headers.get('a2a-version'), '0.3.0', method)
  }
  for (const method of ['tasks/pushNotificationConfig/list', 'tasks/pushNotificationConfig/delete']) {
    const { response } = await post(rpc, { jsonrpc: '2.0', id: 1, method, params: {} })
    const payload = await response.json()
    assert.equal(response.headers.get('a2a-version'), '0.3.0', method)
    assert.equal(payload.error.code, -32601, method)   // 不进表：保持已发布行为
  }
})

await test('Round 2.6：RPC_ROUTES 与 v1 名字集合不漂移', () => {
  for (const alias of V1_ALIASES) {
    assert.equal(V1_METHOD_NAMES.includes(alias), true, alias)
    assert.equal(isV1Method(alias), true, alias)
    assert.notEqual(RPC_ROUTES[alias].handler, 'pushConfig', alias)
  }
  for (const [method, route] of Object.entries(RPC_ROUTES)) {
    if (route.v1) assert.equal(V1_METHOD_NAMES.includes(method), true, method)
    if (route.handler === 'pushConfig') assert.equal(route.v1, V1_METHOD_NAMES.includes(method), method)
  }
  for (const name of V1_METHOD_NAMES.filter((m) => !V1_ALIASES.has(m))) {
    assert.equal(isV1Method(name), false, name)
  }
  // push 集合与路由表互相兜底：每个 pushConfig 路由键都在 PUSH_CONFIG_METHOD_NAMES 里；
  // 表里 v1 的 pushConfig 键正好是"push 集合 ∩ V1 名字"（以后加名字必须三处一起改）。
  for (const [method, route] of Object.entries(RPC_ROUTES)) {
    if (route.handler === 'pushConfig') assert.equal(PUSH_CONFIG_METHOD_NAMES.includes(method), true, method)
  }
  assert.deepEqual(
    Object.entries(RPC_ROUTES).filter(([, r]) => r.handler === 'pushConfig' && r.v1).map(([m]) => m).sort(),
    PUSH_CONFIG_METHOD_NAMES.filter((m) => V1_METHOD_NAMES.includes(m)).sort(),
  )
})
```

测试文件顶部补 `import { V1_METHOD_NAMES, V1_ALIASES, PUSH_CONFIG_METHOD_NAMES, isV1Method } from '../lib/protocol.js'`（若尚未导入）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: compat FAIL（`V1_METHOD_NAMES` 未导出）；smoke 第一条 FAIL（`ListTasks` 头是 `0.3.0`）、第二条 FAIL（`-32601` 而非 `-32003`）、第四条 FAIL（`RPC_ROUTES` 未导出）

- [ ] **Step 3: 实现**

`protocol.ts`：`V1_METHOD_NAMES`（11 个，见 spec §3.3）+ `V1_ALIASES`（三个）替换旧常量；`wireVersionFor` 用 `includes`；新增 `PUSH_CONFIG_METHOD_NAMES`（8 个）与 `isPushConfigMethod`（`PUSH_CONFIG_METHOD_NAMES.includes`）。

`server.ts`：
- 模块级 `export interface RpcRoute` + `export const RPC_ROUTES`（12 条，见 spec §3.3）；`dispatch` 先查表再走 `agent/authenticatedExtendedCard`、`tasks/resubscribe`、default `-32601`；
- `pushConfig` 分支返回 `jsonrpcError(..., A2A_ERRORS.PUSH_NOTIFICATION_NOT_SUPPORTED, '本 A2A 服务器不支持推送通知')`；
- `:16` 的模块注释 `tasks/pushNotificationConfig/*` 改成 `tasks/pushNotificationConfig/set|get`；
- **不要把 `tasks/pushNotificationConfig/list` / `/delete` 加进表**：它们今天是 `-32601`，加进来会把未实现变成"不支持推送"（未登记的 v0.3 行为变化）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（smoke 74 + compat 54）

- [ ] **Step 5: 提交**

```bash
git add src/protocol.ts src/server.ts tests/compat.mjs tests/smoke.mjs lib
git commit -m "fix(server): single v1 method-name table incl. push-config family and 1.0 headers"
```

---

### Task 5: `toV1Task` 兜底 + 版本门纯函数 + metadata 钉死（M3/M4/M5）

**Files:**
- Modify: `src/protocol.ts:500-575`（`v1TaskState`/`v1Part`/`v1Message`/`toV1Task`；新增 `checkVersionHeader`）
- Modify: `src/server.ts:283-292`（版本门改用 `checkVersionHeader`）
- Test: `tests/compat.mjs`、`tests/smoke.mjs`（Round 2.6 块）

**Interfaces:**
- Consumes: `toV1Task(task: A2aTask): Record<string, unknown>` 签名不变
- Produces: `export function checkVersionHeader(x: unknown, a: unknown): { ok: true } | { ok: false; raw: string }`
- Produces: 非法输入下 `status.state` 恒存在、`parts` 无 `null`（规则见 spec §3.4）

- [ ] **Step 1: 写失败测试**

`tests/compat.mjs`（从 `../lib/protocol.js` 补导入 `checkVersionHeader`）：

```js
test('toV1Task：结构性非法输入不抛、不产 null、status 有 state', () => {
  const bogusState = toV1Task({
    kind: 'task', id: 't1', contextId: 'c1',
    status: { state: 'bogus', timestamp: '2026-01-01T00:00:00Z' },
  })
  assert.equal(bogusState.status.state, 'TASK_STATE_UNSPECIFIED')
  assert.equal('rawState' in bogusState.status, false)

  for (const junk of [
    { kind: 'task', id: 't2', contextId: 'c2' },            // 缺 status
    { kind: 'task', id: 't3', contextId: 'c3', status: null },
    { kind: 'task', id: 't4', contextId: 'c4', status: {}, history: 'x' },
    { kind: 'task', id: 't5', contextId: 'c5', status: {}, artifacts: [{}] },
    null,
  ]) {
    const out = toV1Task(junk)
    assert.equal(out.status.state, 'TASK_STATE_UNSPECIFIED')
    assert.equal('history' in out && Array.isArray(out.history), false)
  }

  // §3.4 的三条容器规则，各有精确期望（不是"省略或为空"这种两可写法）。
  const badMsg = toV1Task({ kind: 'task', id: 't6', contextId: 'c6', status: { state: 'completed', message: 'nope' } })
  assert.equal('message' in badMsg.status, false)

  const badMsgParts = toV1Task({
    kind: 'task', id: 't7', contextId: 'c7', status: { state: 'completed' },
    history: [{ role: 'user', messageId: 'm', parts: 'x' }],
  })
  assert.deepEqual(badMsgParts.history[0].parts, [])

  const badArtifactParts = toV1Task({
    kind: 'task', id: 't8', contextId: 'c8', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', parts: 'x' }],
  })
  assert.deepEqual(badArtifactParts.artifacts[0].parts, [])

  // `{}` 是对象：保留为 {parts:[]}，不因为没有 artifactId 就丢弃（§3.4）。
  const emptyArtifact = toV1Task({
    kind: 'task', id: 't9', contextId: 'c9', status: { state: 'completed' }, artifacts: [{}],
  })
  assert.deepEqual(emptyArtifact.artifacts, [{ parts: [] }])
})

test('toV1Task：part 二分支（显式未知 kind 省略；缺 kind 按成员判别）', () => {
  const out = toV1Task({
    kind: 'task', id: 't1', contextId: 'c1', status: { state: 'completed', timestamp: '2026-01-01T00:00:00Z' },
    history: [{
      kind: 'message', role: 'user', messageId: 'm1',
      parts: [{ kind: 'video', text: 'x' }, null, { text: 'ok' }, { data: { a: 1 } }],
    }],
  })
  assert.deepEqual(out.history[0].parts, [{ text: 'ok' }, { data: { a: 1 } }])
})

test('checkVersionHeader：空头等价没带，非空 X 优先，其余主版本拒绝', () => {
  for (const [x, a] of [[undefined, undefined], ['', undefined], ['   ', '0.3'], ['1.0', '2.0'], [undefined, '0.3']]) {
    assert.equal(checkVersionHeader(x, a).ok, true, `${x} / ${a}`)
  }
  // 空 X 不压制 A：回落到 A 再拒绝；raw 是选中的值。
  assert.deepEqual(checkVersionHeader('', '2.0'), { ok: false, raw: '2.0' })
  for (const [x, a] of [['2.0', undefined], [undefined, '2.0'], ['v1.0', undefined]]) {
    assert.equal(checkVersionHeader(x, a).ok, false, `${x} / ${a}`)
  }
  // 非字符串头：非法，raw 取导致拒绝的那个头（先 x 后 a）。
  assert.deepEqual(checkVersionHeader(['1.0', '2.0'], undefined), { ok: false, raw: '1.0,2.0' })
  assert.deepEqual(checkVersionHeader('', ['2.0']), { ok: false, raw: '2.0' })
})
```

`tests/smoke.mjs`（Round 2.6 块）：

```js
await test('Round 2.6：空 / 纯空白版本头等价于没带（200 + 0.3.0）', async () => {
  const cases = [{ 'X-A2A-Version': '' }, { 'X-A2A-Version': '   ' }, { 'A2A-Version': '' }]
  for (const headers of cases) {
    const { status, response } = await post(rpc, {
      jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('empty header'),
    }, headers)
    assert.equal(status, 200, JSON.stringify(headers))
    assert.equal(response.headers.get('a2a-version'), '0.3.0')
  }
})

await test('Round 2.6：空 X 不压制 A（A:2.0 → 400，文案含 2.0）', async () => {
  const { status, response } = await post(rpc, {
    jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('precedence'),
  }, { 'X-A2A-Version': '', 'A2A-Version': '2.0' })
  assert.equal(status, 400)
  assert.match(await response.text(), /2\.0/)
})

await test('Round 2.6：v0.3 响应 metadata 钉死（无则无、有则留）', async () => {
  const plain = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('no metadata') })
  assert.equal(plain.result.history.some((m) => 'metadata' in m), false)

  const withMeta = await postJson(rpc, {
    jsonrpc: '2.0', id: 2, method: 'message/send',
    params: messageSendParams('with metadata', { metadata: { kind: 'request', from: 'tester' } }),
  })
  assert.deepEqual(withMeta.result.history[0].metadata, { kind: 'request', from: 'tester' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: compat FAIL（`checkVersionHeader` 未导出；缺 `status` / `status:null` / `history:'x'` / `artifacts:[{}]` / `null` 抛 `TypeError`；`parts` 里 `{text:'ok'}` 被误过滤）；smoke 空头用例 FAIL（400）、`A:2.0` 用例 FAIL（文案是空值）、metadata 用例 PASS（先钉住）

- [ ] **Step 3: 实现**

`protocol.ts`（规则写死在 spec §3.4，不要只实现矩阵里的例子）：
- `v1TaskState`：state 缺失/非法/不在映射表 → `'TASK_STATE_UNSPECIFIED'`；
- `status` 非对象 → 输出 `{state:'TASK_STATE_UNSPECIFIED'}`（不写 `timestamp`）；
- `v1Part` 返回 `Record<string, unknown> | undefined`，**二分支**：显式 `kind` 不在三型 → `undefined`；缺 `kind` → 按成员判别（`text: string` / `data: object` 非数组 / `file: object` 含 `uri|bytes`），判不出 → `undefined`；
- 容器：`message.parts` 非数组 → `[]`；`history`/`artifacts` 非数组 → 省略；artifact 非对象 → 省略；`artifact.parts` 非数组 → `[]`；
- message 非对象 → 省略该 message（`status.message` 省略、history 项省略）；
- artifact 不是对象 → 省略该项；是对象 → 保留，**`artifactId` 缺失时不写该键**（`...(artifactId !== undefined ? {artifactId} : {})`），`parts` 非数组 → `[]`；
- task 非对象 → `{status:{state:'TASK_STATE_UNSPECIFIED'}}`；
- `checkVersionHeader(x, a)`：按 spec §3.5 三步；`undefined` → 没带；非字符串 → `ok:false`、**`raw` 取导致拒绝的那个头（先 `x` 后 `a`）**：`Array.isArray(v) ? v.join(',') : String(v)`。

`server.ts`：`res.setHeader('A2A-Version', wireVersionFor(method))` 之前用 `const gate = checkVersionHeader(req.headers['x-a2a-version'], req.headers['a2a-version'])`，`gate.ok === false` → 400（文案用 `gate.raw`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（smoke 77 + compat 57）

- [ ] **Step 5: 提交**

```bash
git add src/protocol.ts src/server.ts tests/compat.mjs tests/smoke.mjs lib
git commit -m "fix(protocol): structural fallbacks, version-gate helper and metadata pin"
```

---

### Task 6: v1 响应 message 归一 + `-32003` 消歧（M6/M7）

**Files:**
- Modify: `src/compat.ts`（`normalizeMessage` + `normalizeTask` 应用；`classifyError` 加 `method` 参数）
- Modify: `src/client.ts`（`A2aRpcError` 第 4 个可选参 `method`；`rpc()` 与 `sendStream` 的 JSON-RPC 错误带上方法名；`sendStream` 非 SSE 回退改用 `normalizeTask`）
- Modify: `src/tools.ts`（`failure()` 传 `error.method`；`retryable` 描述补一句）
- Test: `tests/compat.mjs`、`tests/smoke.mjs`

**Interfaces:**
- Produces: `export function classifyError(code: number, method?: string): { retryable?: boolean }`
- Produces: `class A2aRpcError { constructor(code: number, message: string, data?: unknown, method?: string) }`
- Consumes: `PUSH_CONFIG_METHOD_NAMES` / `isPushConfigMethod`（Task 4）、`normalizePart`（已有）

- [ ] **Step 1: 写失败测试**

`tests/compat.mjs`：

```js
test('normalizeTaskResult：v1 message 归一（role/kind/parts），v0.3 幂等', () => {
  const v1 = normalizeTaskResult({
    id: 't1', contextId: 'c1',
    status: {
      state: 'TASK_STATE_INPUT_REQUIRED', timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'ROLE_AGENT', parts: [{ text: 'need' }], messageId: 'm0' },
    },
    history: [{ role: 'ROLE_USER', parts: [{ text: 'q' }], messageId: 'm1' }],
  })
  assert.equal(v1.status.message.role, 'agent')
  assert.equal(v1.status.message.kind, 'message')
  assert.deepEqual(v1.status.message.parts, [{ kind: 'text', text: 'need' }])
  assert.equal(v1.history[0].role, 'user')
  assert.equal(v1.history[0].kind, 'message')
  assert.equal(v1.history[0].parts[0].kind, 'text')

  const v03 = normalizeTaskResult({
    kind: 'task', id: 't2', contextId: 'c2',
    status: { state: 'completed', timestamp: '2026-01-01T00:00:00Z' },
    history: [{ kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'q' }], messageId: 'm' }],
  })
  assert.deepEqual(v03.history[0], {
    kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'q' }], messageId: 'm',
  })
})

test('classifyError：-32003 按方法消歧（push 配置不可重试）', () => {
  assert.deepEqual(classifyError(-32003), { retryable: true })
  assert.deepEqual(classifyError(-32003, 'message/send'), { retryable: true })
  assert.deepEqual(classifyError(-32003, 'CreateTaskPushNotificationConfig'), { retryable: false })
  assert.deepEqual(classifyError(-32003, 'tasks/pushNotificationConfig/set'), { retryable: false })
  assert.deepEqual(classifyError(-32005, 'CreateTaskPushNotificationConfig'), { retryable: false })
})
```

`tests/smoke.mjs`（Round 2.6 块）：

```js
await test('Round 2.6：v1 响应 history/status.message 归一成内部形状', async () => {
  // status.message 只在 failed/timeout 由服务器写入（agentNote）；input-required 分支
  // 只写 artifact，所以这里必须用"必然抛错"的 runner，否则 status.message 是 undefined。
  const failing = await startServer({ runner: { async run() { throw new Error('boom') } } })
  const strict = await startStrictV1(failing.url)
  try {
    const client = new A2aClient({ baseUrl: strict.origin, timeoutMs: 5000 })
    const { task } = await client.sendForText('boom')
    assert.equal(task.status.state, 'failed')
    assert.equal(task.status.message.role, 'agent')
    assert.equal(task.status.message.kind, 'message')
    assert.equal(task.status.message.parts[0].kind, 'text')
    assert.equal(task.history[0].role, 'user')
    assert.equal(task.history[0].kind, 'message')
    assert.equal(task.history[0].parts[0].kind, 'text')
  } finally {
    await strict.close()
    await failing.server.stop()
  }
})

await test('Round 2.6：sendStream 的非 SSE 回退也走 normalizeTask', async () => {
  const agent = await startAgent({ ...v03Card, capabilities: { streaming: true } }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(rpcResult(req, {
      task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: 'ok' }] }] },
    })))
  })
  try {
    const c = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
    const events = await c.sendStream('x', () => {})
    assert.equal(events[events.length - 1].status.state, 'completed')
  } finally {
    await agent.close()
  }
})

await test('Round 2.6：JSON-RPC 错误对象携带方法名', async () => {
  const agent = await startAgent(v10Card, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32003, message: 'push not supported' } }))
  })
  try {
    const c = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
    await assert.rejects(
      () => c.sendForText('x'),
      (e) => e.code === -32003 && e.method === 'SendMessage',
    )
  } finally {
    await agent.close()
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: compat FAIL（v1 `history[0].role` 仍是 `ROLE_USER`、`kind` 为 `undefined`；`classifyError(-32003, push)` 仍 `true`）；smoke **三条** FAIL（`status.message.role === 'ROLE_AGENT'`、回退事件的 state 仍是 `TASK_STATE_COMPLETED`、`err.method === undefined`）

- [ ] **Step 3: 实现**

`compat.ts` 的 `classifyError`（规则见 spec §3.9）从 protocol 引入 `isPushConfigMethod`（常量与函数在 Task 4 已建；protocol 不 import compat，无环），并把 doc 注释从"`-32003`（上游不可用）可重试"改成"`-32003` 按方法消歧：push 配置不可重试，其余可重试"。

`compat.ts`：新增内部 `normalizeMessage(raw)`（规则见 spec §3.8）：
- 非对象 → `undefined`；
- `role`：`ROLE_USER`/`user` → `user`、`ROLE_AGENT`/`agent` → `agent`、其它原样（cast 保留）；
- `parts`：`Array.isArray ? map(normalizePart).filter(非对象丢弃) : []`；
- 返回 `{ ...raw, kind: 'message', role, parts }`。
`normalizeTask`：`status.message` 存在 → 用 `normalizeMessage` 归一（`undefined` 则删掉该键）；`history` 数组 → `map(normalizeMessage).filter(Boolean)`；`history` 非数组 → 保持现状。

`client.ts`：`A2aRpcError` 构造器加第 4 个可选参 `method`；`rpc()` 里两处 JSON-RPC 错误抛出（`rpcError !== undefined`）带 `method`；`sendStream` 两处 JSON-RPC 错误带 `methodsFor(version).stream`；`sendStream` 的非 SSE 回退分支把 `payload.result as A2aTask` 改成 `normalizeTask(payload.result)`（`normalizeTask` 从 compat 引入）。

`tools.ts`：`failure(error)` 用 `classifyError(error.code, error.method)`；`retryable` 描述改成「是否鼓励重试：`-32005`/`-32006` 为 false；`-32003` 对 push 配置方法为 false，其余为 true」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（smoke 80 + compat 59）

- [ ] **Step 5: 提交**

```bash
git add src/compat.ts src/client.ts src/tools.ts tests/compat.mjs tests/smoke.mjs lib
git commit -m "fix(compat): normalize v1 response messages and disambiguate -32003 by method"
```

---

### Task 7: 文档、版本与发布准备

**Files:**
- Modify: `README.md`（§四 新增"出站报文随版本切换"；§五 服务端小节补 v1 名字响应头；`README:279`、`:300` 的旧断言；§六 已知限制第 1 条 + metadata 一句）
- Modify: `docs/requirements.md`（基线行、R8 状态与验收证据、`:193` 映射行）
- Modify: `docs/superpowers/specs/2026-10-25-server-v1-aliases-design.md`（§3.1 加一行取代注记，保留原文）
- Modify: `package.json`（`version: 0.6.0`）

**Interfaces:**
- Consumes: 前 6 个 task 的产物（只写文档，不改代码接口）
- Produces: `README` / `requirements.md` / 0.5.0 spec 注记 / `package.json:0.6.0` / 重建的 `lib/`

- [ ] **Step 1: README**

- §四 新增小节「出站报文形状（0.6.0）」：v1.0 对端收到 `role:"ROLE_USER"`、无 `kind`、`parts:[{text}]`；v0.3 对端与 0.5.0 逐字段相同；形状只由卡片协商结果决定（没有开关）；错标 1.0 的对端会 `-32602`，回退 `@celumin/dsh-a2a@0.5.0`；`sendStream` 在 v1.0 上立即 `-32601`。
- §五 服务端小节：补"未实现的 v1.0 名字（`ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` / `SendStreamingMessage`）`-32601` 时头是 `1.0`；push 配置族仍是 `-32003`、头也是 `1.0`；v0.3 的 `/list` `/delete` 仍 `-32601`"。
- **§五（现有 `:279`）**："出站客户端行为不变（仍是 v0.3 形状…）" → "出站形状随协商版本切换（0.6.0，见 §四）"。
- **§五（现有 `:300`）**："0.5.0 的 v1.0 入口…**可用于** 0.6.0…" → "该入口即 strict fixture 的生产侧；回归用例是 `tests/smoke.mjs` 的 strict proxy 用例"。
- §六 已知限制第 1 条：改为"出站形状随协商版本切换（0.6.0）；卡片错标 1.0 但只吃 v0.3 形状的对端会 `-32602`"，并补一句"v0.3 `message/send` 响应保留请求里的 `message.metadata`（0.5.0 起的有意行为）"。
- **不要预先写联调结果**：README 的 Pi/Hermes 联调小节留到矩阵 18 真正执行时再补；本次只写"待联调"。

- [ ] **Step 2: requirements.md + 0.5.0 spec**

- 基线行（`:6`）：`@celumin/dsh-a2a@0.5.0`（npm 已发布；0.6.0 已构建、**待人工发布**）/ 下一个交付 `0.6.0`——**发布前不要写"0.6.0 已发布"**（本计划不执行 npm publish；真发布后再回填基线行）；
- R8 状态：`进行中（0.6.0：实现与仓库内验收完成；真实 Pi/Hermes 联调待执行，见设计 spec §4 矩阵 18）`——**不要**写"已完成"；
- R8 追加 `- **验收证据**：`（strict proxy 用例名、capture 断言、`npm test` 计数）与 `- **遗留修复（随 0.6.0）**：M1–M7（M1–M5 来自 0.5.0 终审，M6–M7 来自 0.6.0 spec review）`；
- `:193` 映射行同步，文案 `—（进行中，0.6.0）`（**不要**写"已完成"）；
- 0.5.0 spec §3.1 表头下加取代注记（见设计 spec §3.7）；
- 三份评审报告已随 spec v6 提交（`docs/superpowers/reviews/specs/`），本 task 不需要再 add。

- [ ] **Step 3: 版本与构建**

`package.json` → `0.6.0`；Run: `npm run prepack`。

- [ ] **Step 4: 全量验证**

Run: `npm test && npm run verify`
Expected: smoke 80 + compat 59、verify 通过。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/requirements.md docs/superpowers/specs/2026-10-25-server-v1-aliases-design.md package.json lib
git commit -m "docs: 0.6.0 outbound v1.0 message shape"
```
