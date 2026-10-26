# dsh-a2a 0.6.0 实施计划（出站报文按版本切换 + 0.5.0 遗留修复）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 出站 message 形状跟随协商版本（v1.0 → ProtoJSON 形状，v0.3 逐字节不变），并用严格验收对象证明；同时修掉 0.5.0 终审遗留的 M1–M5。

**Architecture:** 版本适配仍是纯函数：`compat.ts` 新增 `wireMessageFor(version, message)`，`client.ts` 的 `send`/`sendStream` 两处字面量改为调用它，`sendStream` 在 v1.0 上提前报错。服务端做三处收敛：v1 方法名真值收敛为 `protocol.ts` 的 `V1_METHOD_NAMES`/`V1_ALIASES` + `server.ts` 路由表（含 push-notification-config 家族）；版本门抽成纯函数 `checkVersionHeader(x, a)`；`toV1Task` 加运行期兜底。strict v1 验收对象是**测试内联 proxy**（校验 v1 形状后才转发给真实 0.5.0 服务端），不进生产代码。

**Tech Stack:** TypeScript 5.9（ESM）、Node ≥20、`node:assert` 手写测试、`node:http`（测试内联严格 proxy）、零新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-26-client-v1-outbound-and-v1-followups-design.md`（定稿 v2）

## Global Constraints

- 不新增依赖；`protocol.ts` / `compat.ts` 保持零依赖（只 import 类型与 node 内置）。
- **v0.3 线上字节不变**：无 `message.metadata` 时，`message/send` / `message/stream` 的请求体与 0.5.0 逐字段一致（matrix 3/5）。
- v1.0 出站 message：`role` 用 `ROLE_USER`/`ROLE_AGENT`，message 与 part **都没有 `kind`**，part 用成员形态（`{text}`/`{data}`/`{file}`），file 不产生 `url`。
- 方法名、`X-A2A-Version` 头、`{id}` 参数的现有规则不变；`message/stream` 的 SSE 行为与帧形状不变。
- 不做 `SendStreamingMessage` 实现；`ListTasks`/`SubscribeToTask`/`GetExtendedAgentCard` 仍 `-32601`（头 `1.0`）；4 个 `*TaskPushNotificationConfig(s)` 仍是 `-32003`（头 `1.0`）。
- `toV1Task` 对合法输入的输出逐字段不变（0.5.0 已发布行为不回退）；非法输入不抛、不产生 `null`/缺 `state`。
- 每次 `tsc` 重建的 `lib/` 与 `src/` 一起提交（仓库跟踪构建产物）。
- 版本 `0.6.0`；**不执行 npm publish**（人的决定）。

## Review Focus

1. 严格 v1.0 对端（拒收任何多余 `kind`）收到的请求体里，**message 层与 part 层都没有 `kind`**，且 role 是 `ROLE_*`。
2. v0.3 对端不回归：`message/send` 与 `message/stream` 的请求体在"无 metadata"时与 0.5.0 逐字段一致（含 `kind`、小写 role、part 的 `kind`）。
3. 切形状时不顺带丢字段：`messageId` / `contextId` / `taskId` / `metadata` 在 v1 与 v0.3 两版都随行。
4. `toV1Task` 是公开导出：JS 调用方传非法 `state`、未知 part kind、非对象 part 时，不抛异常、不产出 `parts:[null]`、status 一定有 `state`。
5. v1 方法名真值不漂移：`V1_ALIASES`、路由表、`wireVersionFor` 三者一致；未实现/不支持的 v1 名字 `-32601` / `-32003` 时头都是 `1.0`，v0.3 名字仍是 `0.3.0`。

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
- Produces: `send`/`sendStream` 的 `params.message` 形状随版本；v1.0 的 `sendStream` 抛 `A2aRpcError(-32601, /v1\.0 streaming is not supported/)`

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
    await assert.rejects(() => c.sendStream('x', () => {}), /v1\.0 streaming is not supported/)
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
- Modify: `src/server.ts:363-390`（`dispatch` 改表）
- Test: `tests/compat.mjs`、`tests/smoke.mjs`（Round 2.6 块内新增三条）

**Interfaces:**
- Produces: `export const V1_METHOD_NAMES: readonly string[]`（11 个）、`export const V1_ALIASES: ReadonlySet<string>`（3 个）
- Produces: `isV1Method` / `wireVersionFor` 签名不变；`V1_METHODS` / `V1_WIRE_METHODS` 删除（无外部引用，已 grep）
- Consumes: `handleSend`/`handleGetTask`/`handleCancel`（签名不变）

- [ ] **Step 1: 写失败测试**

`tests/compat.mjs`（替换现有 `isV1Method / wireVersionFor` 用例；数量不变）：

```js
import { V1_METHOD_NAMES, V1_ALIASES, isV1Method, wireVersionFor } from '../lib/protocol.js'

test('v1 方法名：全集判 1.0，别名集合只含三个', () => {
  for (const m of V1_METHOD_NAMES) assert.equal(wireVersionFor(m), '1.0', m)
  assert.equal(V1_METHOD_NAMES.length, 11)
  for (const m of ['message/send', 'message/stream', 'tasks/get', 'tasks/cancel', 'tasks/resubscribe', 'agent/authenticatedExtendedCard', 'CustomThing']) {
    assert.equal(wireVersionFor(m), '0.3.0', m)
  }
  assert.deepEqual([...V1_ALIASES].sort(), ['CancelTask', 'GetTask', 'SendMessage'])
  for (const alias of V1_ALIASES) assert.equal(isV1Method(alias), true, alias)
  for (const name of V1_METHOD_NAMES.filter((m) => !V1_ALIASES.has(m))) assert.equal(isV1Method(name), false, name)
})
```

`tests/smoke.mjs`（Round 2.6 块）：

```js
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

await test('Round 2.6：v0.3 名字仍是 0.3.0 头', async () => {
  for (const method of ['message/send', 'tasks/get', 'tasks/pushNotificationConfig/get']) {
    const { response } = await post(rpc, { jsonrpc: '2.0', id: 1, method, params: {} })
    assert.equal(response.headers.get('a2a-version'), '0.3.0', method)
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: compat FAIL（`V1_METHOD_NAMES` 未导出）；smoke 第一条 FAIL（`ListTasks` 头是 `0.3.0`）、第二条 FAIL（`-32601` 而非 `-32003`）

- [ ] **Step 3: 实现**

`protocol.ts`：`V1_METHOD_NAMES`（11 个，见 spec §3.3）+ `V1_ALIASES`（三个）替换旧常量；`wireVersionFor` 用 `includes`。

`server.ts`：`dispatch` 先查静态 `RPC_ROUTES`（6 个 v0.3/v1 别名 + 6 个 push 配置名字，其中 v0.3 两个 push 名字也在表里），按 `handler` 分发；`pushConfig` 分支返回 `jsonrpcError(..., A2A_ERRORS.PUSH_NOTIFICATION_NOT_SUPPORTED, '本 A2A 服务器不支持推送通知')`；`agent/authenticatedExtendedCard`、`tasks/resubscribe`、default `-32601` 保持原分支。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（smoke 73 + compat 54）

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
- Produces: 非法输入下 `status.state` 恒存在、`parts` 无 `null`

- [ ] **Step 1: 写失败测试**

`tests/compat.mjs`：

```js
test('toV1Task：非法 state / 未知 part kind / 非对象 part 不抛、不产 null', () => {
  const junk = toV1Task({
    kind: 'task', id: 't1', contextId: 'c1',
    status: { state: 'bogus', timestamp: '2026-01-01T00:00:00Z' },
    history: [{ kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'video', text: 'x' }, null, { text: 'ok' }] }],
  })
  assert.equal(junk.status.state, 'TASK_STATE_UNSPECIFIED')
  assert.equal('rawState' in junk.status, false)
  assert.deepEqual(junk.history[0].parts, [{ text: 'ok' }])

  const missing = toV1Task({ kind: 'task', id: 't2', contextId: 'c2', status: {} })
  assert.equal(missing.status.state, 'TASK_STATE_UNSPECIFIED')
})

test('checkVersionHeader：空头等价没带，非空 X 优先，其余主版本拒绝', () => {
  for (const [x, a] of [[undefined, undefined], ['', undefined], ['   ', '0.3'], ['1.0', '2.0'], [undefined, '0.3']]) {
    assert.equal(checkVersionHeader(x, a).ok, true, `${x} / ${a}`)
  }
  // 空 X 不压制 A：回落到 A 再拒绝。
  assert.deepEqual(checkVersionHeader('', '2.0'), { ok: false, raw: '2.0' })
  for (const [x, a] of [['2.0', undefined], [undefined, '2.0'], ['v1.0', undefined], [['1.0'], undefined]]) {
    assert.equal(checkVersionHeader(x, a).ok, false, `${x} / ${a}`)
  }
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

await test('Round 2.6：空 X 不压制 A（A:2.0 → 400）', async () => {
  const { status } = await post(rpc, {
    jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('precedence'),
  }, { 'X-A2A-Version': '', 'A2A-Version': '2.0' })
  assert.equal(status, 400)
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
Expected: compat FAIL（`checkVersionHeader` 未导出；`junk.status.state` 为 `undefined`、history parts 含 `null`）；smoke 空头用例 FAIL（400；若 undici 把空头丢掉则本用例不失败——以 compat 用例为准）；metadata 用例 PASS（先钉住）

- [ ] **Step 3: 实现**

`protocol.ts`：
- `v1TaskState`：`status?.state` 不在 `V1_TASK_STATES` 且不是 `unknown` → `'TASK_STATE_UNSPECIFIED'`；`unknown` 分支不变。
- `v1Part` 返回 `Record<string, unknown> | undefined`：非对象 / kind 非 text|data|file → `undefined`；调用处 `map(...).filter((p) => p !== undefined)`；`v1Message` 的 `parts` 非数组 → `[]`；`v1Message` 的入参非对象 → `{}`。
- `checkVersionHeader(x, a)`：按 spec §3.5 的"先挑值再校验"实现（`undefined` → 没带；非字符串 → 拒绝；`trim()` 空 → 没带；`split('.')[0]` 必须 `0`/`1`）。

`server.ts`：版本门前移到 `res.setHeader('A2A-Version', wireVersionFor(method))` 之前用 `const gate = checkVersionHeader(req.headers['x-a2a-version'], req.headers['a2a-version'])`，`gate.ok === false` → 400（文案用 `gate.raw`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（smoke 76 + compat 56）

- [ ] **Step 5: 提交**

```bash
git add src/protocol.ts src/server.ts tests/compat.mjs tests/smoke.mjs lib
git commit -m "fix(protocol): runtime fallbacks, version-gate helper and metadata pin"
```

---

### Task 6: 文档、版本与发布准备

**Files:**
- Modify: `README.md`（§四 新增"出站报文随版本切换"；§五 服务端小节补 v1 名字响应头；§六 已知限制第 1 条改写 + metadata 一句）
- Modify: `docs/requirements.md`（R8 状态与验收证据；M1–M5 一行）
- Modify: `package.json`（`version: 0.6.0`）

- [ ] **Step 1: README**

- §四 新增小节「出站报文形状（0.6.0）」：v1.0 对端收到 `role:"ROLE_USER"`、无 `kind`、`parts:[{text}]`；v0.3 对端与 0.5.0 逐字段相同；形状只由卡片协商结果决定（没有开关）；错标 1.0 的对端会 `-32602`，回退 `@celumin/dsh-a2a@0.5.0`；`sendStream` 在 v1.0 上立即 `-32601`（不做 v1 SSE）。
- §五 服务端小节：补"未实现的 v1.0 名字（`ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` / `SendStreamingMessage`）`-32601` 时头是 `1.0`；push 配置家族仍是 `-32003`、头也是 `1.0`"。
- §六 已知限制第 1 条：改为"出站形状随协商版本切换（0.6.0）；卡片错标 1.0 但只吃 v0.3 形状的对端会 `-32602`"，再加一句"v0.3 `message/send` 响应保留请求里的 `message.metadata`（0.5.0 起的有意行为）"。

- [ ] **Step 2: requirements.md**

R8：`- **状态**：已完成（0.6.0）`；追加 `- **验收证据**：`（strict proxy 用例名、capture 断言、`npm test` 计数）。加一行 `- **0.5.0 遗留修复（随 0.6.0）**：M1 v1 名字响应头（含 push 配置家族）、M2 方法名真值收敛、M3 toV1Task 兜底、M4 metadata 钉死、M5 版本门纯函数与空头。`

- [ ] **Step 3: 版本与构建**

`package.json` → `0.6.0`；Run: `npm run prepack`。

- [ ] **Step 4: 全量验证**

Run: `npm test && npm run verify`
Expected: smoke 76 + compat 56、verify 通过。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/requirements.md package.json lib
git commit -m "docs: 0.6.0 outbound v1.0 message shape"
```
