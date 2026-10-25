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

// ── 汇总 ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
