/**
 * 纯函数单测：endpoint（target 归一 / 卡片候选 / 端点授权）与 compat
 * （版本协商 / 方法表 / 响应归一 / 错误分类）。
 *
 * 不依赖网络与 DSH；直接 import 编译产物 lib/。
 * 运行：node tests/compat.mjs（失败非零退出）。
 */

import { strict as assert } from 'node:assert'
import {
  normalizeTarget,
  cardCandidates,
  decideEndpoint,
  matchesCardEndpointAllowlist,
} from '../lib/endpoint.js'
import { parseMessageSendParams, toV1Task, isV1Method, wireVersionFor } from '../lib/protocol.js'
import {
  versionOf,
  negotiateVersion,
  methodsFor,
  versionHeader,
  normalizeState,
  partKind,
  normalizeSendResult,
  normalizeTaskResult,
  classifyError,
} from '../lib/compat.js'

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL  ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

// ── normalizeTarget ────────────────────────────────────────────────────

test('normalizeTarget：路径基址去尾斜杠', () => {
  assert.deepEqual(normalizeTarget('http://h:1/a2a/x/'), { origin: 'http://h:1', path: '/a2a/x' })
})

test('normalizeTarget：卡片 URL 按 /.well-known 后缀剥离', () => {
  const t = normalizeTarget('http://h:1/a2a/x/.well-known/agent-card.json')
  assert.equal(t.origin, 'http://h:1')
  assert.equal(t.path, '/a2a/x')
  assert.equal(t.givenCardUrl, 'http://h:1/a2a/x/.well-known/agent-card.json')
})

test('normalizeTarget：根路径', () => {
  assert.deepEqual(normalizeTarget('http://h:1'), { origin: 'http://h:1', path: '' })
})

test('normalizeTarget：query 报错', () => {
  assert.throws(() => normalizeTarget('http://h:1/a?x=1'), /query or fragment/)
})

test('normalizeTarget：fragment 报错', () => {
  assert.throws(() => normalizeTarget('http://h:1/a#frag'), /query or fragment/)
})

// ── cardCandidates ─────────────────────────────────────────────────────

test('cardCandidates：根目标只有两条，且都在根', () => {
  const list = cardCandidates({ origin: 'http://h:1', path: '' })
  assert.deepEqual(list, [
    'http://h:1/.well-known/agent-card.json',
    'http://h:1/.well-known/agent.json',
  ])
})

test('cardCandidates：路径目标保留 base path，不生成 origin 根候选', () => {
  const list = cardCandidates({ origin: 'http://h:1', path: '/a2a/x' })
  assert.equal(list.length, 2)
  assert.deepEqual(list, [
    'http://h:1/a2a/x/.well-known/agent-card.json',
    'http://h:1/a2a/x/.well-known/agent.json',
  ])
})

test('cardCandidates：给定卡片 URL 优先', () => {
  const t = normalizeTarget('http://h:1/a2a/x/.well-known/agent.json')
  const list = cardCandidates(t)
  assert.equal(list[0], 'http://h:1/a2a/x/.well-known/agent.json')
  assert.equal(list.length, 2)
})

// ── decideEndpoint ─────────────────────────────────────────────────────

const target = { origin: 'http://h:1', path: '/a2a/x' }

test('decideEndpoint：同源且在 P1 内 → 采用卡片端点', () => {
  const d = decideEndpoint({
    target,
    cardEndpoint: 'http://h:1/a2a/x',
    allowPatterns: ['*'],
    cardEndpointPatterns: [],
  })
  assert.deepEqual(d, { url: 'http://h:1/a2a/x', source: 'card' })
})

test('decideEndpoint：同源但路径越界 → 回退输入路径', () => {
  const d = decideEndpoint({
    target: { origin: 'http://h:1', path: '/tenantA' },
    cardEndpoint: 'http://h:1/tenantB/admin',
    allowPatterns: ['http://h:1/tenantA'],
    cardEndpointPatterns: [],
  })
  assert.equal(d.source, 'input')
  assert.equal(d.warn, 'outside-allowlist')
  assert.equal(d.url, 'http://h:1/tenantA')
})

test('decideEndpoint：跨源 + P2 为空 → 忽略并回退', () => {
  const d = decideEndpoint({
    target,
    cardEndpoint: 'http://other:2/rpc',
    allowPatterns: ['*'],
    cardEndpointPatterns: [],
  })
  assert.equal(d.source, 'input')
  assert.equal(d.warn, 'cross-origin-ignored')
  assert.equal(d.url, 'http://h:1/a2a/x')
})

test('decideEndpoint：跨源 + P2 显式放行 → 采用并标记', () => {
  const d = decideEndpoint({
    target,
    cardEndpoint: 'http://other:2/rpc',
    allowPatterns: ['*'],
    cardEndpointPatterns: ['http://other:2/rpc'],
  })
  assert.equal(d.source, 'card')
  assert.equal(d.warn, 'cross-origin-allowed')
  assert.equal(d.url, 'http://other:2/rpc')
})

test('decideEndpoint：无卡片端点 → 输入路径', () => {
  const d = decideEndpoint({
    target,
    allowPatterns: ['*'],
    cardEndpointPatterns: [],
  })
  assert.deepEqual(d, { url: 'http://h:1/a2a/x', source: 'input' })
})

test('decideEndpoint：卡片端点尾部斜杠被修剪（根除外）', () => {
  const d = decideEndpoint({
    target,
    cardEndpoint: 'http://h:1/a2a/x/',
    allowPatterns: ['*'],
    cardEndpointPatterns: [],
  })
  assert.equal(d.url, 'http://h:1/a2a/x')
})

// ── matchesCardEndpointAllowlist ───────────────────────────────────────

test('matchesCardEndpointAllowlist：* 不生效', () => {
  assert.equal(matchesCardEndpointAllowlist(['*'], 'https://other/rpc'), false)
})

test('matchesCardEndpointAllowlist：完整 URL 前缀，host/port 精确', () => {
  assert.equal(matchesCardEndpointAllowlist(['https://other/rpc'], 'https://other/rpc'), true)
  assert.equal(matchesCardEndpointAllowlist(['https://other/rpc'], 'https://other/rpc/v2'), true)
  assert.equal(matchesCardEndpointAllowlist(['https://other/rpc'], 'https://other/rpcx'), false)
  assert.equal(matchesCardEndpointAllowlist(['https://other/rpc'], 'https://other:8443/rpc'), false)
  assert.equal(matchesCardEndpointAllowlist(['https://other/rpc'], 'http://other/rpc'), false)
})

// ── 版本协商与方法表 ───────────────────────────────────────────────────

const cardV03 = { name: 'v03', version: '1.0.0', protocolVersion: '0.3.0', capabilities: {}, skills: [] }
const cardV10 = {
  name: 'v10',
  version: '1.0.0',
  supportedInterfaces: [{ url: 'http://h:1/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: {},
  skills: [],
}

test('versionOf：0.3 声明', () => {
  assert.equal(versionOf(cardV03), 'v0.3')
})

test('versionOf：supportedInterfaces 1.0 声明', () => {
  assert.equal(versionOf(cardV10), 'v1.0')
})

test('versionOf：无声明 → undefined', () => {
  assert.equal(versionOf({ name: 'x', version: '1.0.0', capabilities: {}, skills: [] }), undefined)
})

test('versionOf：未知 major → undefined', () => {
  assert.equal(versionOf({ ...cardV03, protocolVersion: '2.0' }), undefined)
})

test('versionOf：单段 1 → v1.0', () => {
  assert.equal(versionOf({ ...cardV03, protocolVersion: '1' }), 'v1.0')
})

test('versionOf：多接口时取 JSONRPC 条目，不跨条拼装', () => {
  const card = {
    name: 'm', version: '1.0.0', capabilities: {}, skills: [],
    supportedInterfaces: [
      { url: 'http://h:1/grpc', protocolBinding: 'GRPC', protocolVersion: '0.3' },
      { url: 'http://h:1/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
  }
  assert.equal(versionOf(card), 'v1.0')
})

test('negotiateVersion：卡片缺失 → 降级 v0.3', () => {
  assert.equal(negotiateVersion(undefined), 'v0.3')
})

test('negotiateVersion：卡片在但无声明 → 默认 v0.3', () => {
  assert.equal(negotiateVersion({ name: 'x', version: '1.0.0', capabilities: {}, skills: [] }), 'v0.3')
})

test('methodsFor：两套方法名', () => {
  assert.deepEqual(methodsFor('v1.0'), {
    send: 'SendMessage', stream: 'SendStreamingMessage', getTask: 'GetTask', cancel: 'CancelTask',
  })
  assert.deepEqual(methodsFor('v0.3'), {
    send: 'message/send', stream: 'message/stream', getTask: 'tasks/get', cancel: 'tasks/cancel',
  })
})

test('versionHeader：主.次', () => {
  assert.equal(versionHeader('v1.0'), '1.0')
  assert.equal(versionHeader('v0.3'), '0.3')
})

// ── 状态映射与 part 判别 ───────────────────────────────────────────────

test('normalizeState：枚举映射', () => {
  assert.deepEqual(normalizeState('TASK_STATE_COMPLETED'), { state: 'completed' })
  assert.deepEqual(normalizeState('TASK_STATE_WORKING'), { state: 'working' })
  assert.deepEqual(normalizeState('TASK_STATE_INPUT_REQUIRED'), { state: 'input-required' })
  assert.deepEqual(normalizeState('TASK_STATE_AUTH_REQUIRED'), { state: 'auth-required' })
})

test('normalizeState：UNSPECIFIED 与未知枚举 → unknown + rawState', () => {
  assert.deepEqual(normalizeState('TASK_STATE_UNSPECIFIED'), { state: 'unknown', rawState: 'TASK_STATE_UNSPECIFIED' })
  assert.deepEqual(normalizeState('TASK_STATE_FUTURE_THING'), { state: 'unknown', rawState: 'TASK_STATE_FUTURE_THING' })
})

test('normalizeState：已是内部值原样返回', () => {
  assert.deepEqual(normalizeState('completed'), { state: 'completed' })
  assert.deepEqual(normalizeState('input-required'), { state: 'input-required' })
})

test('partKind：有 kind 用 kind，无 kind 按成员判别', () => {
  assert.equal(partKind({ kind: 'text', text: 'x' }), 'text')
  assert.equal(partKind({ text: 'x' }), 'text')
  assert.equal(partKind({ data: {} }), 'data')
  assert.equal(partKind({ url: 'u' }), 'file')
  assert.equal(partKind({}), undefined)
})

// ── 响应归一 ───────────────────────────────────────────────────────────

test('normalizeSendResult：{task} 解包', () => {
  const task = normalizeSendResult({ task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED' } } }, 'cx')
  assert.equal(task.id, 't1')
  assert.equal(task.status.state, 'completed')
})

test('normalizeSendResult：{msg} → 完结任务且文本可提取', () => {
  const task = normalizeSendResult({ msg: { parts: [{ text: 'hi' }] } }, 'cx')
  assert.equal(task.status.state, 'completed')
  assert.equal(task.contextId, 'cx')
  assert.equal(task.artifacts[0].parts[0].kind, 'text')
  assert.equal(task.artifacts[0].parts[0].text, 'hi')
})

test('normalizeSendResult：裸 v0.3 task', () => {
  const task = normalizeSendResult({ id: 't2', contextId: 'c2', status: { state: 'working' } }, 'cx')
  assert.equal(task.id, 't2')
  assert.equal(task.status.state, 'working')
})

test('normalizeTaskResult：裸 task 与 {task} 都接受', () => {
  assert.equal(normalizeTaskResult({ id: 'a', contextId: 'c', status: { state: 'completed' } }).id, 'a')
  assert.equal(normalizeTaskResult({ task: { id: 'b', contextId: 'c', status: { state: 'completed' } } }).id, 'b')
})

// ── 错误分类 ───────────────────────────────────────────────────────────

test('classifyError：策略拒绝不可重试', () => {
  assert.deepEqual(classifyError(-32005), { retryable: false })
  assert.deepEqual(classifyError(-32006), { retryable: false })
})

test('classifyError：上游不可用可重试', () => {
  assert.deepEqual(classifyError(-32003), { retryable: true })
})

test('classifyError：传输层/超时（-1）可重试', () => {
  assert.deepEqual(classifyError(-1), { retryable: true })
})

test('classifyError：其他码不表态', () => {
  assert.deepEqual(classifyError(-32601), {})
})

// ── 入站双形状（Round 2.6 spec §3.3） ────────────────────────────────

test('parseMessageSendParams：ROLE_USER + 无 kind 的 text part', () => {
  const r = parseMessageSendParams({ message: { role: 'ROLE_USER', parts: [{ text: 'hi' }] } })
  assert.equal(r.ok, true)
  assert.equal(r.params.message.role, 'user')
  assert.equal(r.params.message.parts[0].kind, 'text')
  assert.equal(r.params.message.parts[0].text, 'hi')
})

test('parseMessageSendParams：ROLE_AGENT → agent', () => {
  const r = parseMessageSendParams({ message: { role: 'ROLE_AGENT', parts: [{ text: 'hi' }] } })
  assert.equal(r.ok, true)
  assert.equal(r.params.message.role, 'agent')
})

test('parseMessageSendParams：无 kind 的 data / file part 按成员判别', () => {
  const data = parseMessageSendParams({ message: { role: 'ROLE_USER', parts: [{ data: { a: 1 } }] } })
  assert.equal(data.ok, true)
  assert.equal(data.params.message.parts[0].kind, 'data')
  assert.deepEqual(data.params.message.parts[0].data, { a: 1 })

  const file = parseMessageSendParams({ message: { role: 'ROLE_USER', parts: [{ file: { uri: 'x' } }] } })
  assert.equal(file.ok, true)
  assert.equal(file.params.message.parts[0].kind, 'file')
  assert.equal(file.params.message.parts[0].file.uri, 'x')
})

test('parseMessageSendParams：未知 ROLE_* 仍拒绝', () => {
  const r = parseMessageSendParams({ message: { role: 'ROLE_BOT', parts: [{ text: 'hi' }] } })
  assert.equal(r.ok, false)
})

test('parseMessageSendParams：判不出形状的 part 仍 -32602', () => {
  const r = parseMessageSendParams({ message: { role: 'ROLE_USER', parts: [{}] } })
  assert.equal(r.ok, false)
  assert.match(r.error, /不支持的 part/)
})

test('parseMessageSendParams：part 级 metadata 原样保留（v1 与 v0.3 两种形态）', () => {
  const kindless = parseMessageSendParams({ message: { role: 'ROLE_USER', parts: [{ text: 'hi', metadata: { x: 1 } }] } })
  assert.equal(kindless.ok, true)
  assert.deepEqual(kindless.params.message.parts[0].metadata, { x: 1 })

  const v03 = parseMessageSendParams({ message: { role: 'user', parts: [{ kind: 'text', text: 'hi', metadata: { y: 2 } }] } })
  assert.equal(v03.ok, true)
  assert.deepEqual(v03.params.message.parts[0].metadata, { y: 2 })

  // 非对象 metadata 不塞进内部模型（形态非法不等于丢弃整个 part）。
  const bad = parseMessageSendParams({ message: { role: 'user', parts: [{ kind: 'text', text: 'hi', metadata: 'nope' }] } })
  assert.equal(bad.ok, true)
  assert.equal('metadata' in bad.params.message.parts[0], false)
})

test('parseMessageSendParams：v0.3 形状回归不变', () => {
  const r = parseMessageSendParams({ message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } })
  assert.equal(r.ok, true)
  assert.equal(r.params.message.role, 'user')
  assert.equal(r.params.message.parts[0].kind, 'text')
})

// ── v1 Task 序列化（Round 2.6 spec §3.4） ─────────────────────────────

function v1Task(state, extraStatus = {}, extraTask = {}) {
  return {
    kind: 'task',
    id: 't1',
    contextId: 'c1',
    status: { state, timestamp: '2026-01-01T00:00:00Z', ...extraStatus },
    ...extraTask,
  }
}

test('toV1Task：7 个常规状态映射为 TASK_STATE_*', () => {
  const want = {
    submitted: 'TASK_STATE_SUBMITTED',
    working: 'TASK_STATE_WORKING',
    'input-required': 'TASK_STATE_INPUT_REQUIRED',
    completed: 'TASK_STATE_COMPLETED',
    failed: 'TASK_STATE_FAILED',
    canceled: 'TASK_STATE_CANCELED',
    rejected: 'TASK_STATE_REJECTED',
    'auth-required': 'TASK_STATE_AUTH_REQUIRED',
  }
  for (const [state, v1] of Object.entries(want)) {
    assert.equal(toV1Task(v1Task(state)).status.state, v1, state)
  }
})

test('toV1Task：unknown 用合法 rawState，否则 UNSPECIFIED，且 rawState 不上线', () => {
  const future = toV1Task(v1Task('unknown', { rawState: 'TASK_STATE_FUTURE' }))
  assert.equal(future.status.state, 'TASK_STATE_FUTURE')
  assert.equal('rawState' in future.status, false)

  const weird = toV1Task(v1Task('unknown', { rawState: 'weird' }))
  assert.equal(weird.status.state, 'TASK_STATE_UNSPECIFIED')
  assert.equal('rawState' in weird.status, false)

  const bare = toV1Task(v1Task('unknown'))
  assert.equal(bare.status.state, 'TASK_STATE_UNSPECIFIED')
})

test('toV1Task：task / artifact / message 都去掉 kind', () => {
  const out = toV1Task(v1Task('completed', {}, {
    artifacts: [{ kind: 'artifact', artifactId: 'a1', parts: [{ kind: 'text', text: 'hi' }] }],
    history: [{ kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'q' }], messageId: 'm1' }],
  }))
  assert.equal('kind' in out, false)
  assert.equal('kind' in out.artifacts[0], false)
  assert.equal('kind' in out.history[0], false)
  assert.equal(out.artifacts[0].artifactId, 'a1')
})

test('toV1Task：part 去 kind 转成员形态（text/data/file，file 不带 url）', () => {
  const out = toV1Task(v1Task('working', {}, {
    history: [{
      kind: 'message',
      role: 'user',
      messageId: 'm1',
      parts: [
        { kind: 'text', text: 'hi' },
        { kind: 'data', data: { a: 1 } },
        { kind: 'file', file: { uri: 'file://x', mimeType: 'text/plain', name: 'x.txt' } },
      ],
    }],
  }))
  const parts = out.history[0].parts
  assert.deepEqual(parts[0], { text: 'hi' })
  assert.deepEqual(parts[1], { data: { a: 1 } })
  assert.deepEqual(parts[2], { file: { uri: 'file://x', mimeType: 'text/plain', name: 'x.txt' } })
  assert.equal('url' in parts[2].file, false)
})

test('toV1Task：role 变大写枚举（status.message 与 history）', () => {
  const out = toV1Task(v1Task('input-required', {
    message: { kind: 'message', role: 'agent', messageId: 'm2', parts: [{ kind: 'text', text: 'need' }] },
  }, {
    history: [{ kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'q' }] }],
  }))
  assert.equal(out.status.message.role, 'ROLE_AGENT')
  assert.equal(out.history[0].role, 'ROLE_USER')
})

test('isV1Method / wireVersionFor：按方法名决定 wire 版本', () => {
  for (const m of ['SendMessage', 'GetTask', 'CancelTask']) {
    assert.equal(isV1Method(m), true, m)
    assert.equal(wireVersionFor(m), '1.0', m)
  }
  for (const m of ['message/send', 'message/stream', 'tasks/get', 'tasks/cancel']) {
    assert.equal(isV1Method(m), false, m)
    assert.equal(wireVersionFor(m), '0.3.0', m)
  }
})

// ── 汇总 ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
