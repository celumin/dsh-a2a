/**
 * dsh-a2a 冒烟测试（端到端，零 DSH 依赖）。
 *
 * 直接驱动编译产物 lib/（先 `tsc -p tsconfig.test.json` 构建核心）：
 * 起真实 A2A 服务器（echo/门控/input-required 三种假 runner），
 * 用原生 fetch + A2aClient 回环验证：
 *   1. Agent Card（0.3 / 0.2 双路径、字段、鉴权宣告）
 *   2. 版本协商头（A2A-Version 应答 / X-A2A-Version 主版本冲突拒绝）
 *   3. message/send（同步完结、contextId 生成与按 context 记忆）
 *   4. message/stream（SSE 事件序列 working→artifact→final、流自然关闭）
 *   5. tasks/get（命中 / 未命中 -32001）
 *   6. tasks/cancel（进行中可取消 / 已完结 -32002 / 不存在 -32001）
 *   7. input-required 暂停 + taskId 续答（多轮）
 *   8. tasks/resubscribe（缓冲回放 + 实时跟随）
 *   9. JSON-RPC 错误（未知方法 -32601、坏参数 -32602、解析错误 -32700）
 *  10. Bearer 鉴权（401/通过、卡片 securitySchemes）
 *  11. A2aClient 回环（card 发现、sendForText 流式与同步两条路径）
 *  12. matchesAllowlist 白名单纯函数
 *
 * 运行：node tests/smoke.mjs（失败非零退出）。
 */

import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { A2aServer, RPC_ROUTES, silentLogger } from '../lib/server.js'
import { buildAgentCard, V1_METHOD_NAMES, V1_ALIASES, PUSH_CONFIG_METHOD_NAMES, isV1Method } from '../lib/protocol.js'
import { A2aClient, A2aTimeoutError, matchesAllowlist } from '../lib/client.js'

// ── 测试基础设施 ────────────────────────────────────────────────────────

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL  ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

function textOf(task) {
  const out = []
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts) {
      if (part.kind === 'text') out.push(part.text)
    }
  }
  return out.join('\n').trim()
}

/** echo runner：按 contextId 计数（验证上下文复用），支持关键字控制行为。 */
function echoRunner() {
  const counters = new Map()
  const gates = new Map() // taskId -> release
  return {
    async run({ controller, message }) {
      const text = message.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('')
      controller.updateStatus('working')
      if (text === 'NEED_INPUT') {
        controller.addArtifact([{ kind: 'text', text: '请补充：要反转的文本是？' }])
        controller.updateStatus('input-required')
        return
      }
      if (text.startsWith('ANSWER:')) {
        const source = message.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('')
        controller.addArtifact([{ kind: 'text', text: `结果：${source.slice(7).split('').reverse().join('')}` }])
        controller.updateStatus('completed')
        return
      }
      if (text === 'GATE') {
        // 挂起直到 release(taskId) 被调用；期间可被 tasks/cancel 打断。
        await new Promise((resolve) => gates.set(controller.taskId, resolve))
        if (controller.canceled) return
        controller.addArtifact([{ kind: 'text', text: 'gated done' }])
        controller.updateStatus('completed')
        return
      }
      const n = (counters.get(message.contextId) ?? 0) + 1
      counters.set(message.contextId, n)
      controller.addArtifact([{ kind: 'text', text: `echo: ${text} (#${n})` }])
      controller.updateStatus('completed')
    },
    release(taskId) {
      const resolve = gates.get(taskId)
      if (resolve !== undefined) {
        gates.delete(taskId)
        resolve()
      }
    },
  }
}

async function startServer(options = {}) {
  const runner = options.runner ?? echoRunner()
  const server = new A2aServer({
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0/',
    card: options.card ?? buildAgentCard({
      name: 'Smoke Agent',
      description: '冒烟测试',
      url: 'http://127.0.0.1/',
      version: '9.9.9',
      ...(options.bearerToken !== undefined ? { bearerToken: options.bearerToken } : {}),
    }),
    runner,
    logger: silentLogger,
    turnTimeoutMs: 5000,
    taskTtlMs: 600_000,
    ...(options.bearerToken !== undefined ? { bearerToken: options.bearerToken } : {}),
  })
  await server.start()
  return { server, url: server.address, runner }
}

function rpcId() {
  return Math.random().toString(36).slice(2, 10)
}

async function post(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: response.status, response }
}

/** post + 解析 JSON 响应（测试主体大量使用）。 */
async function postJson(url, body, headers = {}) {
  const { response } = await post(url, body, headers)
  return response.json()
}

function messageSendParams(text, extra = {}) {
  return {
    message: {
      kind: 'message',
      role: 'user',
      parts: [{ kind: 'text', text }],
      messageId: `m-${rpcId()}`,
      ...extra,
    },
  }
}

/** 手工解析 SSE 流（不经过 A2aClient，先验证原始 wire 格式）。 */
async function collectSse(response, onEvent) {
  const events = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data === '') continue
      const payload = JSON.parse(data)
      if ('error' in payload) throw new Error(`SSE 内 JSON-RPC 错误: ${JSON.stringify(payload.error)}`)
      events.push(payload.result)
      onEvent?.(payload.result)
    }
  }
  return events
}

/**
 * 捕获出站 JSON-RPC 请求体的最小假服务器：
 * - POST 到根路径 → 记录解析后的 body，按 handler 返回 result；
 * - GET 卡片路径 → 返回 setCard 提供的卡片。
 * 用于断言 A2aClient 实际发出的 message.metadata 与卡片解析行为。
 */
async function startCapture(handler) {
  const messages = []
  let card = null
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(card))
        return
      }
      const parsed = JSON.parse(body)
      messages.push(parsed)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: handler(parsed) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  return {
    url,
    messages,
    setCard: (value) => { card = value },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 记录所有请求的极简 HTTP 服务端（用于发现/授权用例）。 */
async function startRaw(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const record = { method: req.method, url: req.url, authorization: req.headers.authorization }
    requests.push(record)
    handler(req, res, record)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 带卡片 + JSON-RPC 的假 agent：记录每次出站调用的 method/params/版本头。 */
async function startAgent(card, onRpc) {
  const calls = []
  const srv = await startRaw((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(typeof card === 'function' ? card() : card))
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push({ method: parsed.method, params: parsed.params, version: req.headers['x-a2a-version'], url: req.url, authorization: req.headers.authorization })
      onRpc(parsed, res)
    })
  })
  return { ...srv, calls }
}

/**
 * 严格 v1.0 验收对端：只有 message/part 的 v1 形状才放行，否则回 -32602；
 * 通过后把原始请求转发给真实 A2aServer（serverUrl），响应原样回传。
 * 只存在于测试，不进生产代码。
 */
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

function completedTask() {
  return {
    kind: 'task',
    id: 'inline',
    contextId: 'inline',
    status: { state: 'completed', timestamp: new Date().toISOString() },
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────

const main = async () => {
  console.log('dsh-a2a 冒烟测试\n')

  const openServer = await startServer()
  const base = openServer.url
  const rpc = base // JSON-RPC 打到站点根

  await test('Agent Card：0.3 标准路径字段完整', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/.well-known/agent-card.json`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)
    const card = await response.json()
    assert.equal(card.name, 'Smoke Agent')
    assert.equal(card.protocolVersion, '0.3.0')
    assert.equal(card.preferredTransport, 'JSONRPC')
    assert.equal(card.capabilities.streaming, true)
    assert.equal(card.capabilities.pushNotifications, false)
    assert.ok(Array.isArray(card.skills) && card.skills.length > 0)
    assert.deepEqual(card.security, [])
  })

  await test('Agent Card：0.2 旧路径兼容', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/.well-known/agent.json`)
    assert.equal(response.status, 200)
    const card = await response.json()
    assert.equal(card.name, 'Smoke Agent')
  })

  await test('版本协商：应答 A2A-Version 头', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/.well-known/agent-card.json`)
    assert.equal(response.headers.get('a2a-version'), '0.3.0')
  })

  await test('版本协商：主版本冲突返回 400', async () => {
    const { status } = await post(rpc, {
      jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('hi'),
    }, { 'X-A2A-Version': '99.0.1' })
    assert.equal(status, 400)
  })

  await test('message/send：同步完结 + contextId 自动生成', async () => {
    const { response } = await post(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('hello') })
    const payload = await response.json()
    assert.ok('result' in payload, `应返回 result: ${JSON.stringify(payload)}`)
    const task = payload.result
    assert.equal(task.kind, 'task')
    assert.equal(task.status.state, 'completed')
    assert.equal(textOf(task), 'echo: hello (#1)')
    assert.ok(typeof task.contextId === 'string' && task.contextId.length > 0)
  })

  await test('message/send：同 contextId 复用 runner 状态', async () => {
    const first = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('a', { contextId: 'ctx-42' }) })
    const second = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'message/send', params: messageSendParams('b', { contextId: 'ctx-42' }) })
    assert.equal(textOf(first.result), 'echo: a (#1)')
    assert.equal(textOf(second.result), 'echo: b (#2)')
    assert.equal(second.result.contextId, 'ctx-42')
  })

  await test('message/stream：SSE 事件序列 working→artifact→final', async () => {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 's1', method: 'message/stream', params: messageSendParams('stream me') }),
    })
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const events = await collectSse(response)
    assert.ok(events.length >= 3, `事件数应 ≥3: ${JSON.stringify(events.map((e) => e.kind))}`)
    assert.equal(events[0].kind, 'status-update')
    assert.equal(events[0].status.state, 'working')
    assert.equal(events[0].final, false)
    const artifactEvent = events.find((e) => e.kind === 'artifact-update')
    assert.ok(artifactEvent !== undefined, '应包含 artifact-update')
    assert.equal(artifactEvent.artifact.parts[0].text, 'echo: stream me (#1)')
    const last = events[events.length - 1]
    assert.equal(last.kind, 'status-update')
    assert.equal(last.status.state, 'completed')
    assert.equal(last.final, true)
  })

  await test('tasks/get：命中', async () => {
    const send = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('x') })
    const got = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: send.result.id } })
    assert.equal(got.result.id, send.result.id)
    assert.equal(got.result.status.state, 'completed')
  })

  await test('tasks/get：未命中 -32001', async () => {
    const got = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 'nope' } })
    assert.equal(got.error.code, -32001)
  })

  await test('任务 id 参数：规范写法 params.id 与 params.taskId 都接受', async () => {
    const send = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('y') })
    const byId = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: send.result.id } })
    assert.equal(byId.result.id, send.result.id)
    const missing = await postJson(rpc, { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: {} })
    assert.equal(missing.error.code, -32602)
    const ghost = await postJson(rpc, { jsonrpc: '2.0', id: 4, method: 'tasks/cancel', params: { id: 'ghost' } })
    assert.equal(ghost.error.code, -32001)
  })

  await test('tasks/cancel：进行中任务可取消', async () => {
    // GATE 任务挂起中；从首个 SSE 事件（working）取 taskId 后取消。
    const events = []
    const gated = (async () => {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'sg', method: 'message/stream', params: messageSendParams('GATE') }),
      })
      await collectSse(response, (e) => events.push(e))
    })()
    for (let i = 0; i < 100 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(events.length > 0, '应收到 working 事件')
    const gateTaskId = events[0].taskId
    const canceled = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { taskId: gateTaskId } })
    assert.equal(canceled.result.status.state, 'canceled')
    await gated
    const last = events[events.length - 1]
    assert.equal(last.kind, 'status-update')
    assert.equal(last.status.state, 'canceled')
    assert.equal(last.final, true)
  })

  await test('tasks/cancel：已完结任务 -32002', async () => {
    const send = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('done') })
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { taskId: send.result.id } })
    assert.equal(res.error.code, -32002)
  })

  await test('tasks/cancel：不存在 -32001', async () => {
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { taskId: 'ghost' } })
    assert.equal(res.error.code, -32001)
  })

  await test('input-required：暂停 + taskId 续答', async () => {
    const first = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('NEED_INPUT', { contextId: 'ctx-multi' }) })
    assert.equal(first.result.status.state, 'input-required')
    assert.equal(textOf(first.result), '请补充：要反转的文本是？')
    const second = await postJson(rpc, {
      jsonrpc: '2.0', id: 2, method: 'message/send',
      params: messageSendParams('ANSWER:abcde', { contextId: 'ctx-multi', taskId: first.result.id }),
    })
    assert.ok('result' in second, JSON.stringify(second))
    assert.equal(second.result.status.state, 'completed')
    // 同一任务的两轮 artifact 会累积：最后一项是续答结果。
    const artifacts = second.result.artifacts
    assert.equal(artifacts[artifacts.length - 1].parts[0].text, '结果：edcba')
    assert.equal(second.result.id, first.result.id, '续答应复用同一任务')
    assert.ok((second.result.history ?? []).length >= 2, 'history 应包含两轮消息')
  })

  await test('续答非法状态：对 completed 任务带 taskId → -32001', async () => {
    const send = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('plain', { contextId: 'ctx-plain' }) })
    const res = await postJson(rpc, {
      jsonrpc: '2.0', id: 2, method: 'message/send',
      params: messageSendParams('again', { contextId: 'ctx-plain', taskId: send.result.id }),
    })
    assert.equal(res.error.code, -32001)
  })

  await test('tasks/resubscribe：缓冲回放 + 实时跟随', async () => {
    const events = []
    const gated = (async () => {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'sr', method: 'message/stream', params: messageSendParams('GATE') }),
      })
      await collectSse(response, (e) => events.push(e))
    })()
    for (let i = 0; i < 100 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const taskId = events[0].taskId
    // 第二条连接 resubscribe：应先回放 working，再实时收到 final。
    const reEvents = []
    const reSub = (async () => {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'rs', method: 'tasks/resubscribe', params: { taskId } }),
      })
      await collectSse(response, (e) => reEvents.push(e))
    })()
    for (let i = 0; i < 100 && reEvents.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(reEvents[0].status.state, 'working', '应回放缓冲的 working 事件')
    openServer.runner.release(taskId)
    await Promise.all([gated, reSub])
    assert.equal(reEvents[reEvents.length - 1].status.state, 'completed')
    assert.equal(reEvents[reEvents.length - 1].final, true)
  })

  await test('JSON-RPC：未知方法 -32601', async () => {
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'magic/wand' })
    assert.equal(res.error.code, -32601)
  })

  await test('JSON-RPC：坏参数 -32602', async () => {
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'robot' } } })
    assert.equal(res.error.code, -32602)
  })

  await test('JSON-RPC：解析错误 -32700', async () => {
    const { response } = await post(rpc, '{not json')
    const payload = await response.json()
    assert.equal(payload.error.code, -32700)
    assert.equal(payload.id, null)
  })

  await test('JSON-RPC：批量请求拒绝 -32600', async () => {
    const { response } = await post(rpc, [{ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} }])
    const payload = await response.json()
    assert.equal(payload.error.code, -32600)
  })

  await test('pushNotificationConfig → -32003', async () => {
    const res = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'tasks/pushNotificationConfig/set', params: {} })
    assert.equal(res.error.code, -32003)
  })

  await test('未知路径 404', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/nope`)
    assert.equal(response.status, 404)
  })

  // ── 运维端点（client 面板数据源）─────────────────────────────────

  await test('/admin/status：状态摘要', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/admin/status`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('a2a-version'), '0.3.0')
    const status = await response.json()
    assert.equal(status.running, true)
    assert.equal(status.mode, 'agent')
    assert.equal(status.protocolVersion, '0.3.0')
    assert.equal(status.auth, false)
    assert.equal(status.card.name, 'Smoke Agent')
    assert.ok(typeof status.tasks.total === 'number')
  })

  await test('/admin/tasks：任务摘要（倒序、限条数、含状态）', async () => {
    const first = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('t1', { contextId: 'ctx-admin' }) })
    const second = await postJson(rpc, { jsonrpc: '2.0', id: 2, method: 'message/send', params: messageSendParams('t2', { contextId: 'ctx-admin' }) })
    const response = await fetch(`${base.replace(/\/$/, '')}/admin/tasks?limit=2`)
    const { tasks } = await response.json()
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0].id, second.result.id, '倒序：最新在前')
    assert.equal(tasks[1].id, first.result.id)
    assert.equal(tasks[0].state, 'completed')
    assert.equal(tasks[0].contextId, 'ctx-admin')
    assert.equal(tasks[0].artifacts, 1)
    // 假 runner 不调 recordHistory：history 只有服务端记录的 user 消息。
    assert.equal(tasks[0].history, 1)
  })

  // ── A2aClient 回环 ────────────────────────────────────────────────

  const client = new A2aClient({ baseUrl: base, timeoutMs: 5000 })

  await test('A2aClient.card：发现远端卡片', async () => {
    const card = await client.card()
    assert.equal(card.name, 'Smoke Agent')
    assert.equal(card.protocolVersion, '0.3.0')
  })

  await test('A2aClient.sendForText：同步路径', async () => {
    const { task, text } = await client.sendForText('sync call', { preferStream: false })
    assert.equal(task.status.state, 'completed')
    assert.match(text, /^echo: sync call \(#\d+\)$/)
  })

  await test('A2aClient.sendForText：流式路径（SSE）', async () => {
    const seen = []
    const { task, text } = await client.sendForText('stream call', {
      preferStream: true,
      contextId: 'ctx-client-stream',
      onEvent: (e) => seen.push(e.kind),
    })
    assert.equal(task.status.state, 'completed')
    assert.match(text, /^echo: stream call \(#1\)$/)
    assert.ok(seen.includes('status-update'), `事件应含 status-update: ${seen}`)
    assert.ok(seen.includes('artifact-update'), `事件应含 artifact-update: ${seen}`)
  })

  await test('A2aClient.send：默认 metadata.kind=message，未配置 peerName 时不含 from', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      const captureClient = new A2aClient({ baseUrl: fake.url, timeoutMs: 5000 })
      await captureClient.send('metadata default')
      const metadata = fake.messages[0].params.message.metadata
      assert.equal(metadata.kind, 'message')
      assert.equal('from' in metadata, false)
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient：peerName 写入 metadata.from，kind 选项透传', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      const captureClient = new A2aClient({ baseUrl: fake.url, peerName: 'dsh-peer', timeoutMs: 5000 })
      await captureClient.send('request it', { kind: 'request' })
      assert.deepEqual(fake.messages[0].params.message.metadata, { kind: 'request', from: 'dsh-peer' })
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient.sendStream：metadata 携带 from/kind', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      const captureClient = new A2aClient({ baseUrl: fake.url, peerName: 'dsh-peer', timeoutMs: 5000 })
      await captureClient.sendStream('stream metadata', () => {}, { kind: 'result' })
      assert.deepEqual(fake.messages[0].params.message.metadata, { kind: 'result', from: 'dsh-peer' })
      assert.equal(fake.messages[0].params.message.kind, 'message')
      assert.equal(fake.messages[0].params.message.role, 'user')
      assert.equal(fake.messages[0].params.message.parts[0].kind, 'text')
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient.card：接受 v1.0 supportedInterfaces 形态（无顶层 url）', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      fake.setCard({
        name: 'v1-peer',
        description: 'v1 card',
        version: '1.0.0',
        supportedInterfaces: [{ url: 'http://127.0.0.1:9999/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: false, pushNotifications: true, stateTransitionHistory: false },
        skills: [],
      })
      const captureClient = new A2aClient({ baseUrl: fake.url, timeoutMs: 5000 })
      const card = await captureClient.card()
      assert.equal(card.url, 'http://127.0.0.1:9999/rpc')
      assert.equal(card.name, 'v1-peer')
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient.card：url 与 supportedInterfaces 都缺失时报明确错误', async () => {
    const fake = await startCapture(() => completedTask())
    try {
      fake.setCard({ name: 'broken', version: '1.0.0' })
      const captureClient = new A2aClient({ baseUrl: fake.url, timeoutMs: 5000 })
      await assert.rejects(() => captureClient.card(), /url|supportedInterfaces/i)
    } finally {
      await fake.close()
    }
  })

  await test('A2aClient.getTask / cancelTask 错误映射', async () => {
    await assert.rejects(() => client.getTask('ghost'), (error) => error.code === -32001)
    await assert.rejects(() => client.cancelTask('ghost'), (error) => error.code === -32001)
  })

  // ── 卡片发现与端点授权（Round 2.5）────────────────────────────────

  await test('A2aClient.card：路径基址命中卡片（网关形态）', async () => {
    const srv = await startRaw((req, res) => {
      if (req.url === '/a2a/x/.well-known/agent-card.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ name: 'path-card', version: '1.0.0', url: '/a2a/x', capabilities: { streaming: false }, skills: [] }))
        return
      }
      res.writeHead(404)
      res.end('')
    })
    try {
      const pathClient = new A2aClient({ baseUrl: `${srv.origin}/a2a/x`, timeoutMs: 5000 })
      const card = await pathClient.card()
      assert.equal(card.name, 'path-card')
      const decision = await pathClient.endpoint()
      assert.equal(decision.source, 'card')
      assert.equal(decision.url, `${srv.origin}/a2a/x`)
    } finally {
      await srv.close()
    }
  })

  await test('A2aClient.card：不跟随重定向', async () => {
    const srv = await startRaw((req, res) => {
      if (req.url === '/a/.well-known/agent-card.json') {
        res.writeHead(302, { Location: '/followed' })
        res.end()
        return
      }
      if (req.url === '/followed') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ name: 'followed' }))
        return
      }
      res.writeHead(404)
      res.end('')
    })
    try {
      const redirectClient = new A2aClient({ baseUrl: `${srv.origin}/a`, timeoutMs: 5000 })
      await assert.rejects(() => redirectClient.card(), /url|supportedInterfaces/i)
      assert.equal(srv.requests.some((record) => record.url === '/followed'), false)
    } finally {
      await srv.close()
    }
  })

  await test('A2aClient：卡片全 404 → 降级输入路径 + WARN 只含 origin', async () => {
    const srv = await startRaw((_req, res) => {
      res.writeHead(404)
      res.end('')
    })
    const logs = []
    try {
      const degraded = new A2aClient({
        baseUrl: `${srv.origin}/a2a/x`,
        timeoutMs: 5000,
        logger: (level, message, fields) => logs.push({ level, message, fields }),
      })
      const decision = await degraded.endpoint()
      assert.equal(decision.source, 'input')
      assert.equal(decision.url, `${srv.origin}/a2a/x`)
      await assert.rejects(() => degraded.card(), /url|supportedInterfaces/i)
      const warning = logs.find((entry) => entry.level === 'warn')
      assert.ok(warning)
      assert.equal(warning.fields.target_origin, srv.origin)
      assert.equal(JSON.stringify(warning.fields).includes('/a2a/x'), false)
    } finally {
      await srv.close()
    }
  })

  await test('A2aClient：跨源卡片端点默认忽略，跨源主机收不到请求', async () => {
    const other = await startRaw((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    const srv = await startRaw((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        name: 'cross',
        version: '1.0.0',
        supportedInterfaces: [{ url: `${other.origin}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: false },
        skills: [],
      }))
    })
    try {
      const crossClient = new A2aClient({ baseUrl: srv.origin, timeoutMs: 5000 })
      const decision = await crossClient.endpoint()
      assert.equal(decision.source, 'input')
      assert.equal(decision.warn, 'cross-origin-ignored')
      assert.equal(other.requests.length, 0)
    } finally {
      await srv.close()
      await other.close()
    }
  })

  await test('A2aClient：跨源端点命中白名单才采用', async () => {
    const other = await startRaw((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    const srv = await startRaw((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        name: 'cross-ok',
        version: '1.0.0',
        supportedInterfaces: [{ url: `${other.origin}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: false },
        skills: [],
      }))
    })
    try {
      const allowed = new A2aClient({
        baseUrl: srv.origin,
        timeoutMs: 5000,
        cardEndpointPatterns: [`${other.origin}/rpc`],
      })
      const decision = await allowed.endpoint()
      assert.equal(decision.source, 'card')
      assert.equal(decision.warn, 'cross-origin-allowed')
      assert.equal(decision.url, `${other.origin}/rpc`)
    } finally {
      await srv.close()
      await other.close()
    }
  })

  await test('A2aClient.card：候选不在白名单作用域时不带 Bearer', async () => {
    const srv = await startRaw((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ name: 'auth', version: '1.0.0', url: '/', capabilities: { streaming: false }, skills: [] }))
    })
    try {
      const outside = new A2aClient({
        baseUrl: srv.origin,
        bearerToken: 'secret',
        allowPatterns: ['http://example.invalid/'],
        timeoutMs: 5000,
      })
      await outside.card()
      assert.equal(srv.requests[0].authorization, undefined)

      srv.requests.length = 0
      const inside = new A2aClient({ baseUrl: srv.origin, bearerToken: 'secret', allowPatterns: ['*'], timeoutMs: 5000 })
      await inside.card()
      assert.equal(srv.requests[0].authorization, 'Bearer secret')
    } finally {
      await srv.close()
    }
  })

  // ── 版本协商与响应适配（Round 2.5）──────────────────────────────

  const v10Card = {
    name: 'v10',
    version: '1.0.0',
    supportedInterfaces: [{ url: '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false },
    skills: [],
  }
  const v03Card = {
    name: 'v03',
    version: '1.0.0',
    protocolVersion: '0.3.0',
    url: '/',
    capabilities: { streaming: false },
    skills: [],
  }
  const rpcResult = (req, result) => ({ jsonrpc: '2.0', id: req.id, result })
  const completedV10 = { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: 'ok' }] }] } }
  const completedV03 = { kind: 'task', id: 't1', contextId: 'c1', status: { state: 'completed', timestamp: new Date().toISOString() } }
  await test('A2aClient：白名单放行的跨源端点仍携带 Bearer', async () => {
    const other = await startAgent(v10Card, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rpcResult(req, completedV10)))
    })
    const srv = await startAgent({
      ...v10Card,
      supportedInterfaces: [{ url: `${other.origin}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rpcResult(req, completedV10)))
    })
    try {
      const crossAllowed = new A2aClient({
        baseUrl: srv.origin,
        bearerToken: 'secret',
        allowPatterns: [`${srv.origin}/`],
        cardEndpointPatterns: [`${other.origin}/rpc`],
        timeoutMs: 5000,
      })
      await crossAllowed.sendForText('hi')
      assert.equal(other.calls[0].authorization, 'Bearer secret')
    } finally {
      await srv.close()
      await other.close()
    }
  })


  await test('A2aClient：v1.0 用 SendMessage、版本头 1.0、解包 {task}', async () => {
    const agent = await startAgent(v10Card, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rpcResult(req, completedV10)))
    })
    try {
      const v10Client = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
      const out = await v10Client.sendForText('hi', { kind: 'request' })
      assert.equal(out.text, 'ok')
      assert.equal(out.task.status.state, 'completed')
      assert.equal(agent.calls[0].method, 'SendMessage')
      assert.equal(agent.calls[0].version, '1.0')
      assert.equal(agent.calls[0].url, '/rpc')
      const body = agent.calls[0].params.message
      assert.equal('kind' in body, false)
      assert.equal(body.role, 'ROLE_USER')
      assert.deepEqual(body.parts, [{ text: 'hi' }])
      assert.equal('kind' in body.parts[0], false)
    } finally {
      await agent.close()
    }
  })

  await test('A2aClient：v0.3 用 message/send、版本头 0.3', async () => {
    const agent = await startAgent(v03Card, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rpcResult(req, completedV03)))
    })
    try {
      const v03Client = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
      await v03Client.sendForText('hi')
      assert.equal(agent.calls[0].method, 'message/send')
      assert.equal(agent.calls[0].version, '0.3')
      const body = agent.calls[0].params.message
      assert.equal(body.kind, 'message')
      assert.equal(body.role, 'user')
      assert.equal(body.parts[0].kind, 'text')
    } finally {
      await agent.close()
    }
  })

  await test('A2aClient：v1.0 即使声明 streaming 也不发流式方法', async () => {
    const agent = await startAgent({ ...v10Card, capabilities: { streaming: true } }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rpcResult(req, completedV10)))
    })
    try {
      const streamClient = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
      await streamClient.sendForText('hi', { preferStream: true })
      assert.deepEqual(agent.calls.map((call) => call.method), ['SendMessage'])
    } finally {
      await agent.close()
    }
  })

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

  await test('A2aClient：无卡片降级 message/send 且保留 metadata.kind', async () => {
    const captured = []
    const srv = await startRaw((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(404)
        res.end('')
        return
      }
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        captured.push(parsed)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rpcResult(parsed, completedV03)))
      })
    })
    try {
      const degraded = new A2aClient({ baseUrl: `${srv.origin}/a2a/x`, timeoutMs: 5000 })
      await degraded.sendForText('hi')
      assert.equal(captured[0].method, 'message/send')
      assert.equal(captured[0].params.message.metadata.kind, 'message')
    } finally {
      await srv.close()
    }
  })

  await test('A2aClient.getTask/cancelTask：按版本发方法名与 {id}', async () => {
    const agent = await startAgent(v10Card, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rpcResult(req, { id: 't9', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } })))
    })
    try {
      const taskClient = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
      await taskClient.getTask('t9')
      await taskClient.cancelTask('t9')
      assert.equal(agent.calls[0].method, 'GetTask')
      assert.deepEqual(agent.calls[0].params, { id: 't9' })
      assert.equal(agent.calls[1].method, 'CancelTask')
      assert.deepEqual(agent.calls[1].params, { id: 't9' })
    } finally {
      await agent.close()
    }
  })

  await test('A2aClient：auth-required 立即返回，不轮询到超时', async () => {
    const agent = await startAgent(v10Card, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rpcResult(req, { task: { id: 't2', contextId: 'c', status: { state: 'TASK_STATE_AUTH_REQUIRED' } } })))
    })
    try {
      const authClient = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
      const started = Date.now()
      const out = await authClient.sendForText('hi')
      assert.equal(out.task.status.state, 'auth-required')
      assert.ok(Date.now() - started < 1500)
      assert.equal(agent.calls.length, 1)
    } finally {
      await agent.close()
    }
  })

  await test('A2aClient：超时 → A2aTimeoutError 含最后状态与 task_id', async () => {
    const agent = await startAgent(v10Card, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rpcResult(req, { task: { id: 't3', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } })))
    })
    try {
      const slowClient = new A2aClient({ baseUrl: agent.origin, timeoutMs: 300 })
      await assert.rejects(
        () => slowClient.sendForText('hi'),
        (error) => error instanceof A2aTimeoutError
          && /最后一次看到的状态/.test(error.message)
          && /task_id=t3/.test(error.message),
      )
    } finally {
      await agent.close()
    }
  })

  await test('A2aClient：4xx + JSON-RPC error body 保留错误码', async () => {
    const agent = await startAgent(v10Card, (req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32006, message: 'outbound target mismatch' } }))
    })
    try {
      const rejectClient = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
      await assert.rejects(
        () => rejectClient.sendForText('hi'),
        (error) => error.code === -32006 && /outbound target mismatch/.test(error.message),
      )
    } finally {
      await agent.close()
    }
  })

  await test('A2aClient：错误响应体截断到 2KB', async () => {
    const agent = await startAgent(v10Card, (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('x'.repeat(10_000))
    })
    try {
      const bigClient = new A2aClient({ baseUrl: agent.origin, timeoutMs: 5000 })
      await assert.rejects(
        () => bigClient.sendForText('hi'),
        (error) => /HTTP 500/.test(error.message) && error.message.length < 2_200,
      )
    } finally {
      await agent.close()
    }
  })

  await test('A2aClient：同源路径越界时 POST 打到 target 路径', async () => {
    const tenantB = await startRaw((_req, res) => {
      res.writeHead(200)
      res.end('{}')
    })
    const srv = await startAgent({ ...v03Card, url: '/tenantB/admin' }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rpcResult(req, completedV03)))
    })
    try {
      const scopedClient = new A2aClient({
        baseUrl: `${srv.origin}/tenantA`,
        allowPatterns: [`${srv.origin}/tenantA`],
        timeoutMs: 5000,
      })
      await scopedClient.sendForText('hi')
      assert.equal(srv.calls[0].url, '/tenantA')
      assert.equal(tenantB.requests.length, 0)
    } finally {
      await srv.close()
      await tenantB.close()
    }
  })

  // ── Round 2.6：服务端 v1.0 别名 / 入站双形状 / 响应形状 / 版本头 ──

  const v1Params = (text, extra = {}) => ({
    message: { role: 'ROLE_USER', parts: [{ text }], messageId: `m-${rpcId()}`, ...extra },
  })

  await test('Round 2.6：message/send 仍是裸 v0.3 Task + 0.3.0 头', async () => {
    const { status, response } = await post(rpc, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('v03 shape') })
    const payload = await response.json()
    assert.equal(status, 200)
    assert.equal(response.headers.get('a2a-version'), '0.3.0')
    assert.equal(payload.result.kind, 'task')
    assert.equal(payload.result.status.state, 'completed')
    assert.equal(payload.result.artifacts[0].parts[0].kind, 'text')
  })

  let v1CompletedId
  await test('Round 2.6：SendMessage + ROLE_USER/无 kind → {task} + TASK_STATE_* + 1.0 头', async () => {
    const { response } = await post(rpc, {
      jsonrpc: '2.0', id: 'v1', method: 'SendMessage', params: v1Params('hi v1'),
    }, { 'X-A2A-Version': '1.0' })
    const payload = await response.json()
    assert.equal(response.headers.get('a2a-version'), '1.0')
    assert.ok(payload.result?.task, `应返回 {task}: ${JSON.stringify(payload)}`)
    const task = payload.result.task
    v1CompletedId = task.id
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED')
    assert.equal('kind' in task, false)
    assert.equal('rawState' in task.status, false)
    assert.equal(task.artifacts[0].parts[0].text, 'echo: hi v1 (#1)')
    assert.equal('kind' in task.artifacts[0].parts[0], false)
    assert.equal(task.history[0].role, 'ROLE_USER')
    assert.equal('kind' in task.history[0], false)
  })

  await test('Round 2.6：SendMessage 的 status.message 用 ROLE_AGENT 且 part 无 kind', async () => {
    // status.message 只在 failed/timeout 时由服务器写入（agentNote），所以用
    // 一个必然抛错的 runner 起第二台服务器。
    const failing = await startServer({ runner: { async run() { throw new Error('boom') } } })
    try {
      const payload = await postJson(failing.url, {
        jsonrpc: '2.0', id: 'v1b', method: 'SendMessage', params: v1Params('fail me'),
      }, { 'X-A2A-Version': '1.0' })
      const task = payload.result.task
      assert.equal(task.status.state, 'TASK_STATE_FAILED')
      assert.equal(task.status.message.role, 'ROLE_AGENT')
      assert.equal('kind' in task.status.message, false)
      assert.equal('kind' in task.status.message.parts[0], false)
    } finally {
      await failing.server.stop()
    }
  })

  await test('Round 2.6：SendMessage 无版本头也接受 v0.3 形状，头仍是 1.0', async () => {
    const { response } = await post(rpc, { jsonrpc: '2.0', id: 2, method: 'SendMessage', params: messageSendParams('no header') })
    const payload = await response.json()
    assert.equal(response.headers.get('a2a-version'), '1.0')
    assert.equal(payload.result.task.status.state, 'TASK_STATE_COMPLETED')
    assert.equal(payload.result.task.artifacts[0].parts[0].text, 'echo: no header (#1)')
  })

  await test('Round 2.6：GetTask 返回裸 v1 Task', async () => {
    const { response } = await post(rpc, {
      jsonrpc: '2.0', id: 3, method: 'GetTask', params: { id: v1CompletedId },
    }, { 'X-A2A-Version': '1.0' })
    const payload = await response.json()
    assert.equal(response.headers.get('a2a-version'), '1.0')
    assert.equal(payload.result.id, v1CompletedId)
    assert.equal(payload.result.status.state, 'TASK_STATE_COMPLETED')
    assert.equal('kind' in payload.result, false)
  })

  await test('Round 2.6：CancelTask 返回裸 v1 Task（TASK_STATE_CANCELED）', async () => {
    const pending = await postJson(rpc, { jsonrpc: '2.0', id: 4, method: 'message/send', params: messageSendParams('NEED_INPUT') })
    const { response } = await post(rpc, {
      jsonrpc: '2.0', id: 5, method: 'CancelTask', params: { id: pending.result.id },
    }, { 'X-A2A-Version': '1.0' })
    const payload = await response.json()
    assert.equal(response.headers.get('a2a-version'), '1.0')
    assert.equal(payload.result.status.state, 'TASK_STATE_CANCELED')
    assert.equal('kind' in payload.result, false)
  })

  await test('Round 2.6：message/stream 配 1.0 头仍是 v0.3 帧 + 0.3.0 头', async () => {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 's-v1', method: 'message/stream', params: messageSendParams('stream v1 header') }),
    })
    assert.equal(response.headers.get('a2a-version'), '0.3.0')
    const events = await collectSse(response)
    assert.equal(events[0].kind, 'status-update')
    assert.equal(events[0].status.state, 'working')
    assert.equal('TASK_STATE_WORKING' === events[0].status.state, false)
  })

  await test('Round 2.6：SendStreamingMessage 仍 -32601，头是 1.0', async () => {
    const { response } = await post(rpc, {
      jsonrpc: '2.0', id: 6, method: 'SendStreamingMessage', params: v1Params('nope'),
    }, { 'X-A2A-Version': '1.0' })
    const payload = await response.json()
    assert.equal(response.headers.get('a2a-version'), '1.0')
    assert.equal(payload.error.code, -32601)
  })

  await test('Round 2.6：版本主号 2.0 仍 HTTP 400', async () => {
    const { status } = await post(rpc, {
      jsonrpc: '2.0', id: 7, method: 'SendMessage', params: v1Params('v2'),
    }, { 'X-A2A-Version': '2.0' })
    assert.equal(status, 400)
  })

  await test('Round 2.6：矩阵 #12 auth-required 快照 → TASK_STATE_AUTH_REQUIRED，无 rawState/kind', async () => {
    // runner 主动停在 auth-required 并挂住，趁 turn 未结束时 GetTask。
    let releaseAuth
    let announce
    const authGate = new Promise((resolve) => { releaseAuth = resolve })
    const taskIdReady = new Promise((resolve) => { announce = resolve })
    const authServer = await startServer({
      runner: {
        async run({ controller }) {
          controller.updateStatus('auth-required')
          announce(controller.taskId)
          await authGate
        },
      },
    })
    try {
      const pending = postJson(authServer.url, {
        jsonrpc: '2.0', id: 'auth', method: 'SendMessage', params: v1Params('need auth'),
      }, { 'X-A2A-Version': '1.0' })
      const taskId = await taskIdReady
      const got = await postJson(authServer.url, {
        jsonrpc: '2.0', id: 'get', method: 'GetTask', params: { id: taskId },
      }, { 'X-A2A-Version': '1.0' })
      assert.equal(got.result.status.state, 'TASK_STATE_AUTH_REQUIRED')
      assert.equal('rawState' in got.result.status, false)
      assert.equal('kind' in got.result, false)
      releaseAuth()
      await pending
    } finally {
      releaseAuth()
      await authServer.server.stop()
    }
  })

  await test('Round 2.6：卡片补发复数 protocolVersions（单数保留）', async () => {
    const response = await fetch(`${base.replace(/\/$/, '')}/.well-known/agent-card.json`)
    assert.equal(response.headers.get('a2a-version'), '0.3.0')
    const card = await response.json()
    assert.equal(card.protocolVersion, '0.3.0')
    assert.deepEqual(card.protocolVersions, ['0.3.0'])
  })

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

  await openServer.server.stop()

  // ── Bearer 鉴权服务器 ─────────────────────────────────────────────

  const authServer = await startServer({ bearerToken: 'secret-token' })
  const authBase = authServer.url
  const authClient = new A2aClient({ baseUrl: authBase, bearerToken: 'secret-token', timeoutMs: 5000 })

  await test('鉴权：无令牌 401', async () => {
    const { status } = await post(authBase, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('hi') })
    assert.equal(status, 401)
  })

  await test('鉴权：错误令牌 401', async () => {
    const { status } = await post(authBase, { jsonrpc: '2.0', id: 1, method: 'message/send', params: messageSendParams('hi') }, { Authorization: 'Bearer wrong' })
    assert.equal(status, 401)
  })

  await test('鉴权：正确令牌通过', async () => {
    const { task, text } = await authClient.sendForText('auth ok', { preferStream: false })
    assert.equal(task.status.state, 'completed')
    assert.match(text, /^echo: auth ok/)
  })

  await test('鉴权：卡片宣告 bearerAuth 方案', async () => {
    const card = await authClient.card()
    assert.ok(card.securitySchemes?.bearerAuth !== undefined)
    assert.deepEqual(card.security, [{ bearerAuth: [] }])
  })

  await test('鉴权：卡片本身公开可读', async () => {
    const response = await fetch(`${authBase.replace(/\/$/, '')}/.well-known/agent-card.json`)
    assert.equal(response.status, 200)
  })

  await test('鉴权：/admin/* 同样受 Bearer 保护', async () => {
    const noAuth = await fetch(`${authBase.replace(/\/$/, '')}/admin/status`)
    assert.equal(noAuth.status, 401)
    const withAuth = await fetch(`${authBase.replace(/\/$/, '')}/admin/status`, { headers: { Authorization: 'Bearer secret-token' } })
    assert.equal(withAuth.status, 200)
    const status = await withAuth.json()
    assert.equal(status.auth, true)
  })

  await authServer.server.stop()

  // ── matchesAllowlist 纯函数 ───────────────────────────────────────

  await test('matchesAllowlist：通配与前缀', () => {
    assert.equal(matchesAllowlist(['*'], 'http://anywhere:1/'), true)
    assert.equal(matchesAllowlist(['http://127.0.0.1:7310/'], 'http://127.0.0.1:7310/'), true)
    assert.equal(matchesAllowlist(['http://127.0.0.1:7310/'], 'http://127.0.0.1:9999/'), false)
    assert.equal(matchesAllowlist(['https://a2a.example.com/'], 'https://a2a.example.com/.well-known/agent-card.json'), true)
    assert.equal(matchesAllowlist(['https://*.example.com/'], 'https://agents.example.com/'), true)
    assert.equal(matchesAllowlist(['https://*.example.com/'], 'https://example.com/'), true)
    assert.equal(matchesAllowlist(['https://*.example.com/'], 'https://evil.net/'), false)
    assert.equal(matchesAllowlist(['*:7310'], 'http://10.0.0.5:7310/'), true)
    assert.equal(matchesAllowlist(['*:7310'], 'http://10.0.0.5:7311/'), false)
    assert.equal(matchesAllowlist([], 'http://any/'), false)
    assert.equal(matchesAllowlist(['*'], 'not a url'), false)
  })

  // ── 汇总 ─────────────────────────────────────────────────────────

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('冒烟测试框架异常', error)
  process.exitCode = 1
})
