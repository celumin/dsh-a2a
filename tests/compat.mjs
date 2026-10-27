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
import {
  parseMessageSendParams,
  toV1Task,
  V1_METHOD_NAMES,
  V1_ALIASES,
  PUSH_CONFIG_METHOD_NAMES,
  isV1Method,
  wireVersionFor,
  checkVersionHeader,
} from '../lib/protocol.js'
import {
  versionOf,
  negotiateVersion,
  methodsFor,
  versionHeader,
  normalizeState,
  partKind,
  normalizeSendResult,
  normalizeTaskResult,
  wireMessageFor,
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

// ── 出站报文形状（R8）────────────────────────────────────────────────

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

test('wireMessageFor：v1.0 省略未知 kind 的 part（不产出 null）', () => {
  const out = wireMessageFor('v1.0', {
    kind: 'message', role: 'user', messageId: 'm4',
    parts: [{ kind: 'video', text: 'x' }, { kind: 'text', text: 'ok' }],
  })
  assert.deepEqual(out.parts, [{ text: 'ok' }])
  assert.equal(JSON.stringify(out.parts).includes('null'), false)
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

// ── 错误分类 ───────────────────────────────────────────────────────────

test('classifyError：策略拒绝不可重试', () => {
  assert.deepEqual(classifyError(-32005), { retryable: false })
  assert.deepEqual(classifyError(-32006), { retryable: false })
})

test('classifyError：上游不可用可重试', () => {
  assert.deepEqual(classifyError(-32003), { retryable: true })
})

test('classifyError：-32003 按方法消歧（push 配置不可重试）', () => {
  assert.deepEqual(classifyError(-32003), { retryable: true })
  assert.deepEqual(classifyError(-32003, 'message/send'), { retryable: true })
  assert.deepEqual(classifyError(-32003, 'CreateTaskPushNotificationConfig'), { retryable: false })
  assert.deepEqual(classifyError(-32003, 'tasks/pushNotificationConfig/set'), { retryable: false })
  assert.deepEqual(classifyError(-32005, 'CreateTaskPushNotificationConfig'), { retryable: false })
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

// ── 汇总 ───────────────────────────────────────────────────────────────

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

test('toV1Task：显式 kind 但缺载荷 / 载荷类型不符 → 省略该 part', () => {
  const out = toV1Task({
    kind: 'task', id: 't1', contextId: 'c1', status: { state: 'completed' },
    history: [{
      role: 'user', messageId: 'm',
      parts: [
        { kind: 'text' }, { kind: 'text', text: 42 },
        { kind: 'data' }, { kind: 'data', data: [] },
        { kind: 'file' }, { kind: 'file', file: 'x' },
        { kind: 'text', text: 'ok' },
      ],
    }],
  })
  assert.deepEqual(out.history[0].parts, [{ text: 'ok' }])
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

// ── 汇总 ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
