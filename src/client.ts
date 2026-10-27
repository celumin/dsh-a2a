/**
 * 出站 A2A 客户端：让 DSH（或任意 Node 程序）调用远端 A2A agent。
 *
 * 能力：
 * - `card()`          拉取远端 Agent Card（0.3 路径优先，0.2 路径兜底）；
 * - `send()`          message/send 同步调用；对端返回未完结任务时自动
 *                     按 tasks/get 轮询直到终态（或超时）；
 * - `sendStream()`    message/stream SSE 消费（对端支持流式时的首选）；
 * - `getTask()`       tasks/get；
 * - `cancelTask()`    tasks/cancel。
 *
 * 全部基于全局 fetch（Node ≥20），无第三方依赖。
 *
 * @module dsh-a2a/client
 */

import type {
  A2aMessage,
  A2aTask,
  AgentCard,
  Artifact,
  JsonRpcResponse,
  TaskEvent,
} from './protocol.ts'
import {
  decideEndpoint,
  cardCandidates,
  normalizeTarget,
  resolveCardEndpoint,
  matchesAllowlist,
  type EndpointDecision,
  type NormalizedTarget,
} from './endpoint.ts'
import {
  methodsFor,
  negotiateVersion,
  normalizeSendResult,
  normalizeTask,
  normalizeTaskResult,
  versionHeader,
  wireMessageFor,
  type WireVersion,
} from './compat.ts'

export { matchesAllowlist } from './endpoint.ts'

export interface A2aClientOptions {
  /** 远端 agent 基地址（Agent Card 所在站点的根，或直接给 JSON-RPC 地址）。 */
  baseUrl: string
  /** Bearer 令牌（远端启用鉴权时）。 */
  bearerToken?: string
  /** 单次 HTTP 请求 / 轮询总超时（ms，默认 120s）。 */
  timeoutMs?: number
  /**
   * 本端 peer 名：写入出站消息 `metadata.from`，供对端把回话路由回来。
   * 未配置（或为空串）时不携带 `from`，回退为旧行为。
   */
  peerName?: string
  /** 目标白名单（同一份也用于卡片端点的路径作用域）。默认 `['*']`。 */
  allowPatterns?: readonly string[]
  /** 跨源卡片端点的白名单：完整 URL 前缀，默认 `[]`（全拒），`*` 不生效。 */
  cardEndpointPatterns?: readonly string[]
  /** 诊断日志（WARN 只含 origin 与原因码，不含 path/query）。 */
  logger?: (level: 'warn' | 'info', message: string, fields?: Record<string, string>) => void
  /** 注入 fetch（测试用）；默认全局 fetch。 */
  fetchImpl?: typeof fetch
}

/**
 * 出站消息的 `metadata.kind`：
 * - `message` 仅入库/通知（默认，兼容旧行为）；
 * - `request` 触发对端处理并等待结果；
 * - `result` 回执/结果投递。
 */
export type A2aOutboundKind = 'message' | 'request' | 'result'

/** JSON-RPC 远端返回的错误。 */
export class A2aRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly method?: string,
  ) {
    super(`远端 A2A 返回错误 ${code}: ${message}`)
    this.name = 'A2aRpcError'
  }
}

/** 轮询到总预算仍未结束：携带最后状态，便于模型判断是 agent 卡住还是客户端不认识状态。 */
export class A2aTimeoutError extends A2aRpcError {
  constructor(message: string) {
    super(-1, message)
    this.name = 'A2aTimeoutError'
  }
}

export class A2aClient {
  private target: NormalizedTarget | undefined
  private cardState: { card?: AgentCard; decision: EndpointDecision } | undefined

  constructor(private readonly options: A2aClientOptions) {}

  /**
   * 构造出站消息的 metadata：始终带 `kind`（默认 message），
   * 配置了本端 peerName 时附带 `from`（对端据此路由回话）。
   */
  private messageMetadata(kind: A2aOutboundKind = 'message'): Record<string, unknown> {
    const peerName = this.options.peerName
    return {
      kind,
      ...(peerName !== undefined && peerName !== '' ? { from: peerName } : {}),
    }
  }

  private rpcHeaders(version: WireVersion, authorized: boolean, extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-A2A-Version': versionHeader(version),
      ...(this.options.bearerToken !== undefined && authorized
        ? { Authorization: `Bearer ${this.options.bearerToken}` }
        : {}),
      ...(extra ?? {}),
    }
  }

  /**
   * 是否允许把 Bearer 发往该端点：卡片端点已经过 `decideEndpoint` 授权
   * （同源过路径作用域、跨源过 `clientCardEndpointPatterns`）；回退端点则要求
   * 仍在目标白名单内。
   */
  private endpointAuthorized(decision: EndpointDecision): boolean {
    if (decision.source === 'card') return true
    return matchesAllowlist(this.options.allowPatterns ?? ['*'], decision.url)
  }

  /** 一次调用的总预算：发现 / RPC / 轮询共用同一个 deadline。 */
  private deadline(): number {
    return Date.now() + (this.options.timeoutMs ?? 120_000)
  }

  /**
   * 发一次 JSON-RPC：端点与方法由卡片协商结果决定；`deadline` 由调用方传入，
   * 让发现 / 调用 / 轮询共享同一份预算。
   */
  private async rpc<T>(method: string, params?: unknown, deadline?: number): Promise<T> {
    const { card, decision } = await this.ensureCard()
    const version = negotiateVersion(card)
    const remaining = Math.max((deadline ?? this.deadline()) - Date.now(), 1)
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      method,
      ...(params !== undefined ? { params } : {}),
    })
    let response: Response
    try {
      response = await this.fetchFn()(decision.url, {
        method: 'POST',
        headers: this.rpcHeaders(version, this.endpointAuthorized(decision)),
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(remaining),
      })
    } catch (error) {
      throw new A2aRpcError(-1, `请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status >= 300 && response.status < 400) {
      throw new A2aRpcError(-1, `redirect not followed: ${response.status}`)
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      const rpcError = rpcErrorOf(parseJson(text))
      if (rpcError !== undefined) throw new A2aRpcError(rpcError.code, rpcError.message, rpcError.data, method)
      throw new A2aRpcError(-1, `HTTP ${response.status} ${truncateBody(text)}`)
    }
    const payload = parseJson(text)
    if (payload === undefined) throw new A2aRpcError(-1, 'invalid JSON-RPC response')
    const rpcError = rpcErrorOf(payload)
    if (rpcError !== undefined) throw new A2aRpcError(rpcError.code, rpcError.message, rpcError.data, method)
    return (payload as { result?: unknown }).result as T
  }

  private targetInfo(): NormalizedTarget {
    this.target ??= normalizeTarget(this.options.baseUrl)
    return this.target
  }

  private fetchFn(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  private warn(message: string, fields?: Record<string, string>): void {
    this.options.logger?.('warn', message, fields)
  }

  /** 卡片 GET 的头：不带版本头；`Authorization` 仅在候选落在白名单作用域内时携带。 */
  private cardHeaders(url: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.options.bearerToken !== undefined && matchesAllowlist(this.options.allowPatterns ?? ['*'], url)) {
      headers.Authorization = `Bearer ${this.options.bearerToken}`
    }
    return headers
  }

  /**
   * 卡片发现 + 端点决策（实例内缓存，不抛错）。
   * - 候选按 `cardCandidates` 顺序尝试，不跟随重定向；
   * - 每个候选的超时 `min(5s, 剩余预算)`；
   * - 全部失败 → 返回 `source: 'input'` 的决策，并记一条不含 path 的 WARN。
   */
  async ensureCard(forceRefresh = false): Promise<{ card?: AgentCard; decision: EndpointDecision }> {
    if (!forceRefresh && this.cardState !== undefined) return this.cardState
    const target = this.targetInfo()
    const deadline = Date.now() + (this.options.timeoutMs ?? 120_000)
    const failures: string[] = []
    for (const candidate of cardCandidates(target)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        failures.push(`${candidate} → budget exhausted`)
        break
      }
      try {
        const response = await this.fetchFn()(candidate, {
          headers: this.cardHeaders(candidate),
          redirect: 'manual',
          signal: AbortSignal.timeout(Math.min(5_000, remaining)),
        })
        if (response.status >= 300 && response.status < 400) {
          failures.push(`${candidate} → redirect ${response.status}`)
          continue
        }
        if (!response.ok) {
          failures.push(`${candidate} → HTTP ${response.status}`)
          continue
        }
        const card = (await response.json()) as AgentCard
        const serviceUrl = resolveCardUrl(card)
        if (serviceUrl === undefined) {
          failures.push(`${candidate} → 卡片缺少 url`)
          continue
        }
        const normalized = serviceUrl === card.url ? card : { ...card, url: serviceUrl }
        const cardEndpoint = resolveCardEndpoint(normalized, candidate)
        const decision = decideEndpoint({
          target,
          ...(cardEndpoint !== undefined ? { cardEndpoint } : {}),
          allowPatterns: this.options.allowPatterns ?? ['*'],
          cardEndpointPatterns: this.options.cardEndpointPatterns ?? [],
        })
        if (decision.warn !== undefined) {
          const fields: Record<string, string> = { target_origin: target.origin, reason: decision.warn }
          if (cardEndpoint !== undefined) fields['card_origin'] = originOf(cardEndpoint)
          this.warn(`card endpoint ${decision.warn}`, fields)
        }
        this.cardState = { card: normalized, decision }
        return this.cardState
      } catch (error) {
        failures.push(`${candidate} → ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const decision = decideEndpoint({
      target,
      allowPatterns: this.options.allowPatterns ?? ['*'],
      cardEndpointPatterns: this.options.cardEndpointPatterns ?? [],
    })
    this.warn('card discovery failed', { target_origin: target.origin, reason: 'not-found' })
    this.cardState = { decision }
    return this.cardState
  }

  /** 端点决策（发现失败时返回输入路径，不抛错）。 */
  async endpoint(): Promise<EndpointDecision> {
    return (await this.ensureCard()).decision
  }

  /** 拉取远端 Agent Card（带实例缓存）；全部候选失败时抛错。 */
  async card(forceRefresh = false): Promise<AgentCard> {
    const state = await this.ensureCard(forceRefresh)
    if (state.card !== undefined) return state.card
    throw new A2aRpcError(
      -1,
      `Agent Card 发现失败：候选均不可用或卡片缺少 url（顶层 url 与 supportedInterfaces[].url 均未提供）`,
    )
  }

  /**
   * message/send：同步拿终态。
   * - 对端直接返回完结任务 → 即刻返回；
   * - 对端返回未完结任务 → tasks/get 轮询（pollMs 间隔）直到终态/超时。
   * - 对端返回裸 Message（非任务型 agent）→ 包装成 completed Task 形态。
   */
  async send(text: string, options?: {
    contextId?: string
    pollMs?: number
    onEvent?: (event: TaskEvent) => void
    /** 出站 metadata.kind（默认 message）。 */
    kind?: A2aOutboundKind
  }): Promise<A2aTask> {
    const deadline = this.deadline()
    const { card } = await this.ensureCard()
    const version = negotiateVersion(card)
    const messageId = crypto.randomUUID()
    const message: A2aMessage = {
      kind: 'message',
      role: 'user',
      parts: [{ kind: 'text', text }],
      messageId,
      metadata: this.messageMetadata(options?.kind),
      ...(options?.contextId !== undefined ? { contextId: options.contextId } : {}),
    }
    const result = await this.rpc<unknown>(methodsFor(version).send, {
      message: wireMessageFor(version, message),
    }, deadline)
    let task = normalizeSendResult(result, options?.contextId ?? 'inline')
    while (!shouldStop(task)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(options?.pollMs ?? 1000, remaining))
      if (Date.now() >= deadline) break
      task = await this.getTask(task.id, deadline)
      options?.onEvent?.({
        kind: 'status-update',
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
        final: shouldStop(task),
      })
    }
    if (!shouldStop(task)) {
      throw new A2aTimeoutError(
        `轮询超时：最后一次看到的状态是 ${stateLabel(task)}，task_id=${task.id}`,
      )
    }
    return task
  }

  /**
   * message/stream：SSE 消费直到 final 事件；返回收到的全部事件。
   * 对端不支持流式（HTTP 非 SSE）时回退 send()。
   */
  async sendStream(text: string, onEvent: (event: TaskEvent) => void, options?: {
    contextId?: string
    /** 出站 metadata.kind（默认 message）。 */
    kind?: A2aOutboundKind
  }): Promise<TaskEvent[]> {
    const deadline = this.deadline()
    const { card, decision } = await this.ensureCard()
    const version = negotiateVersion(card)
    if (version === 'v1.0') {
      // v1.0 的 SendStreamingMessage 这里不做：真实 v1 服务端会回 v1 帧
      // （{statusUpdate}/{artifactUpdate}），而解析器只认 v0.3 的 event.kind，
      // 会静默返回空数组。提前失败，码值与"对端未实现该方法"一致。
      throw new A2aRpcError(-32601, 'v1.0 streaming is not supported（SendStreamingMessage）')
    }
    const messageId = crypto.randomUUID()
    const message: A2aMessage = {
      kind: 'message',
      role: 'user',
      parts: [{ kind: 'text', text }],
      messageId,
      metadata: this.messageMetadata(options?.kind),
      ...(options?.contextId !== undefined ? { contextId: options.contextId } : {}),
    }
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'stream-' + Date.now().toString(36),
      method: methodsFor(version).stream,
      params: {
        message: wireMessageFor(version, message),
      },
    })
    const response = await this.fetchFn()(decision.url, {
      method: 'POST',
      headers: this.rpcHeaders(version, this.endpointAuthorized(decision), { Accept: 'text/event-stream' }),
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
    })
    const contentType = String(response.headers.get('content-type') ?? '')
    if (!response.ok) {
      const text2 = await response.text().catch(() => '')
      throw new A2aRpcError(-1, `HTTP ${response.status} ${text2.slice(0, 200)}`)
    }
    if (!contentType.includes('text/event-stream')) {
      // 对端退化为同步 JSON-RPC 响应：读取任务并按 send() 语义补齐。
      const payload = (await response.json()) as JsonRpcResponse
      if ('error' in payload) {
        throw new A2aRpcError(payload.error.code, payload.error.message, payload.error.data, methodsFor(version).stream)
      }
      const task = normalizeTask(payload.result)
      onEvent({
        kind: 'status-update',
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
        final: true,
      })
      return [buildFinalFromTask(task)]
    }

    const events: TaskEvent[] = []
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('远端未提供响应体流')
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data === '') continue
        const payload = JSON.parse(data) as JsonRpcResponse
        if ('error' in payload) {
          throw new A2aRpcError(payload.error.code, payload.error.message, payload.error.data, methodsFor(version).stream)
        }
        const event = payload.result as TaskEvent
        if (event === null || typeof event !== 'object' || event.kind === undefined) continue
        events.push(event)
        onEvent(event)
        if (event.kind === 'status-update' && event.final) {
          await reader.cancel().catch(() => {})
          return events
        }
      }
    }
    return events
  }

  async getTask(taskId: string, deadline?: number): Promise<A2aTask> {
    const { card } = await this.ensureCard()
    const version = negotiateVersion(card)
    const result = await this.rpc<unknown>(methodsFor(version).getTask, { id: taskId }, deadline)
    return normalizeTaskResult(result)
  }

  async cancelTask(taskId: string): Promise<A2aTask> {
    const { card } = await this.ensureCard()
    const version = negotiateVersion(card)
    const result = await this.rpc<unknown>(methodsFor(version).cancel, { id: taskId })
    return normalizeTaskResult(result)
  }

  /** 便捷：send() + 提取 artifact 文本（工具层使用）。 */
  async sendForText(text: string, options?: {
    contextId?: string
    pollMs?: number
    preferStream?: boolean
    onEvent?: (event: TaskEvent) => void
    /** 出站 metadata.kind（默认 message）。 */
    kind?: A2aOutboundKind
  }): Promise<{ task: A2aTask; text: string }> {
    if (options?.preferStream) {
      const { card } = await this.ensureCard()
      const version = negotiateVersion(card)
      if (card !== undefined && version === 'v0.3' && card.capabilities?.streaming === true) {
        const events = await this.sendStream(text, (e) => options.onEvent?.(e), {
          contextId: options.contextId,
          ...(options.kind !== undefined ? { kind: options.kind } : {}),
        })
        const task = taskFromEvents(events)
        return { task, text: artifactTextFromEvents(events) }
      }
    }
    const task = await this.send(text, options)
    const out: string[] = []
    for (const artifact of task.artifacts ?? []) {
      for (const part of artifact.parts) {
        if (part.kind === 'text') out.push(part.text)
      }
    }
    return { task, text: out.join('\n').trim() }
  }
}

/**
 * 解析卡片的服务地址：优先顶层 `url`（0.2/0.3 形态），缺失时回退
 * A2A v1.0 的 `supportedInterfaces[]`（取首个带 url 的接口，优先 JSONRPC）。
 */
function resolveCardUrl(card: AgentCard): string | undefined {
  if (typeof card.url === 'string' && card.url !== '') return card.url
  const interfaces = card.supportedInterfaces
  if (Array.isArray(interfaces)) {
    const usable = interfaces.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.url === 'string' && entry.url !== '')
    const preferred = usable.find((entry) => String(entry.protocolBinding ?? '').toUpperCase() === 'JSONRPC')
    const chosen = preferred ?? usable[0]
    if (chosen !== undefined) return chosen.url
  }
  return undefined
}

const STOP_STATES: readonly string[] = ['completed', 'failed', 'canceled', 'rejected', 'input-required', 'auth-required', 'unknown']

/** 停止轮询：终态，或需要人/授权/未知状态（后三者不是"完成"，但继续轮询也没意义）。 */
function shouldStop(task: A2aTask): boolean {
  return STOP_STATES.includes(task.status.state)
}

/** 展示用状态：未知状态优先显示原始枚举值。 */
function stateLabel(task: A2aTask): string {
  if (task.status.state === 'unknown') return task.status.rawState ?? 'unknown'
  return task.status.state
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function rpcErrorOf(value: unknown): { code: number; message: string; data?: unknown } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const error = (value as { error?: unknown }).error
  if (error === null || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  if (typeof record['code'] !== 'number' || typeof record['message'] !== 'string') return undefined
  return { code: record['code'], message: record['message'], data: record['data'] }
}

function truncateBody(text: string): string {
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildFinalFromTask(task: A2aTask): TaskEvent {
  return {
    kind: 'status-update',
    taskId: task.id,
    contextId: task.contextId,
    status: task.status,
    final: true,
  }
}

/** 从事件序列合成最终任务快照（流式路径没有 tasks/get）。 */
function taskFromEvents(events: TaskEvent[]): A2aTask {
  let taskId = 'unknown'
  let contextId = 'unknown'
  let lastStatus: A2aTask['status'] = { state: 'failed', timestamp: new Date().toISOString() }
  const artifacts: Artifact[] = []
  for (const event of events) {
    if (event.kind === 'status-update') {
      taskId = event.taskId
      contextId = event.contextId
      lastStatus = event.status
    } else {
      taskId = event.taskId
      contextId = event.contextId
      artifacts.push(event.artifact)
    }
  }
  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: lastStatus,
    ...(artifacts.length > 0 ? { artifacts } : {}),
  }
}

/** 从事件序列提取最终产物文本。 */
function artifactTextFromEvents(events: TaskEvent[]): string {
  const out: string[] = []
  for (const event of events) {
    if (event.kind !== 'artifact-update') continue
    for (const part of event.artifact.parts) {
      if (part.kind === 'text') out.push(part.text)
    }
  }
  return out.join('\n').trim()
}

/** 只取站点源，供 WARN 使用（不记录 path/query）。 */
function originOf(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return 'unknown'
  }
}
