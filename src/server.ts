/**
 * A2A HTTP 服务器：把 TaskStore + 任意 TaskRunner 暴露为标准 A2A 端点。
 *
 * 端点（默认 http://host:port/）：
 * - `GET  /.well-known/agent-card.json`（0.3.x）与 `/.well-known/agent.json`
 *   （0.2.x 兼容）：返回 Agent Card；
 * - `POST /` JSON-RPC 2.0：
 *   - `message/send`        同步执行一轮，返回完结后的 Task；
 *   - `SendMessage` / `GetTask` / `CancelTask`：v1.0 别名，入站归一后走同一
 *                             handler，响应形状换成 v1（`{task}` / 裸 v1 Task）；
 *   - `message/stream`      SSE 流：status-update / artifact-update 实时推送；
 *   - `tasks/get`           查询任务快照；
 *   - `tasks/cancel`        取消进行中的任务；
 *   - `tasks/resubscribe`   SSE 回放缓冲事件并继续实时跟随；
 *   - `agent/authenticatedExtendedCard`（启用鉴权时）返回扩展卡片；
 *   - `tasks/pushNotificationConfig/set|get` → -32003（未实现推送通知）。
 *
 * 传输细节：
 * - 所有响应带 `A2A-Version` 头；RPC 响应的值跟随**请求方法名**的 wire
 *   版本（v1 方法 1.0，其余 0.3.0），卡片/admin/404 固定 0.3.0；请求带
 *   `X-A2A-Version`/`A2A-Version` 且主版本不是 0/1 时返回 400；
 * - 可选 Bearer 鉴权（card 中同步宣告 securitySchemes）；
 * - CORS 放开（浏览器端 A2A 客户端直连调试场景）；
 * - 单轮执行有 turnTimeoutMs 上限，超时任务置 failed；
 * - 已完结任务由 TaskStore 按 TTL 回收。
 *
 * 本模块零 DSH 依赖：TaskRunner 是唯一扩展点（bridge.ts 提供
 * echo/llm/agent 三种实现）。
 *
 * @module dsh-a2a/server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type {
  A2aMessage,
  AgentCard,
  JsonRpcRequest,
  JsonRpcResponse,
} from './protocol.ts'
import {
  A2A_ERRORS,
  CARD_LEGACY_PATH,
  CARD_PATH,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  jsonrpcError,
  jsonrpcResult,
  parseJsonRpcRequest,
  parseMessageSendParams,
  toV1Task,
  wireVersionFor,
} from './protocol.ts'
import type { StoredTask, TaskController } from './store.ts'
import { TaskStore, controllerFor } from './store.ts'

/** 请求体上限（A2A 消息含 base64 文件时可能较大）。 */
const MAX_BODY_BYTES = 10 * 1024 * 1024

/** SSE 心跳间隔（注释行，维持代理/负载均衡不断连）。 */
const SSE_HEARTBEAT_MS = 15_000

/**
 * JSON-RPC 路由真值表（0.6.0 spec §3.3）：v0.3 名字与 v1.0 名字共用同一
 * handler；`v1` 决定出站包装形状。v0.3 的 push `/list` `/delete` **刻意
 * 不在表里**——它们从未实现，今天走 default → -32601，加进来会变成 -32003。
 * 导出是为了让测试枚举真值，不是公开 API。
 */
export interface RpcRoute {
  readonly handler: 'send' | 'getTask' | 'cancel' | 'pushConfig'
  readonly v1: boolean
}

export const RPC_ROUTES: Readonly<Record<string, RpcRoute>> = {
  'message/send': { handler: 'send', v1: false },
  SendMessage: { handler: 'send', v1: true },
  'tasks/get': { handler: 'getTask', v1: false },
  GetTask: { handler: 'getTask', v1: true },
  'tasks/cancel': { handler: 'cancel', v1: false },
  CancelTask: { handler: 'cancel', v1: true },
  'tasks/pushNotificationConfig/set': { handler: 'pushConfig', v1: false },
  'tasks/pushNotificationConfig/get': { handler: 'pushConfig', v1: false },
  CreateTaskPushNotificationConfig: { handler: 'pushConfig', v1: true },
  GetTaskPushNotificationConfig: { handler: 'pushConfig', v1: true },
  ListTaskPushNotificationConfigs: { handler: 'pushConfig', v1: true },
  DeleteTaskPushNotificationConfig: { handler: 'pushConfig', v1: true },
}

/** 任务 runner 入参：controller 驱动状态机，message 为本轮用户消息。 */
export interface RunnerInput {
  readonly controller: TaskController
  readonly message: A2aMessage
  /** 本任务已积累的全部消息（含本次 user 消息，按时间序）。 */
  readonly history: readonly A2aMessage[]
}

/** 任务执行器：实现方负责调用 controller 推进状态并产出 artifact。 */
export interface A2aRunner {
  run(input: RunnerInput): Promise<void>
}

/** 最小日志接口（cordis logger 满足之；测试可用静默实现）。 */
export interface A2aLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export const silentLogger: A2aLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface A2aServerOptions {
  host: string
  port: number
  /** 写入 Agent Card 的绝对 URL（公网部署时与监听地址不同）。 */
  publicUrl: string
  card: AgentCard
  runner: A2aRunner
  logger?: A2aLogger
  /** Bearer 令牌；不配置则不鉴权。 */
  bearerToken?: string
  /** 单轮执行上限（ms）；默认 10 分钟。 */
  turnTimeoutMs?: number
  /** 已完结任务保留时长（ms）；默认 1 小时。 */
  taskTtlMs?: number
  /** 运维面板展示的运行模式（agent/llm/echo）；仅用于 /admin/status 展示。 */
  mode?: string
}

interface SseSession {
  write(response: JsonRpcResponse): void
  close(): void
}

export class A2aServer {
  private readonly store = new TaskStore()
  private readonly http: Server
  private readonly logger: A2aLogger
  private readonly turnTimeoutMs: number
  private readonly taskTtlMs: number
  private readonly sseSessions = new Set<SseSession>()
  private gcTimer: ReturnType<typeof setInterval> | undefined
  private started = false

  constructor(private readonly options: A2aServerOptions) {
    this.logger = options.logger ?? silentLogger
    this.turnTimeoutMs = options.turnTimeoutMs ?? 600_000
    this.taskTtlMs = options.taskTtlMs ?? 3_600_000
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.logger.error('a2a: 处理请求时未捕获异常', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
        }
        res.end(JSON.stringify({ error: 'internal error' }))
      })
    })
  }

  /** 实际监听端口（port=0 时为系统分配值）。 */
  get address(): string {
    const addr = this.http.address()
    if (addr === null || typeof addr === 'string') return this.options.publicUrl
    return `http://${this.options.host === '0.0.0.0' ? '127.0.0.1' : this.options.host}:${addr.port}/`
  }

  async start(): Promise<void> {
    if (this.started) return
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.options.port, this.options.host, () => {
        this.http.off('error', reject)
        resolve()
      })
    })
    this.gcTimer = setInterval(() => {
      const removed = this.store.gc(this.taskTtlMs)
      if (removed > 0) this.logger.debug(`a2a: TTL 回收 ${removed} 个任务`)
    }, Math.min(this.taskTtlMs / 2, 60_000))
    this.gcTimer.unref?.()
    this.started = true
    this.logger.info(`a2a: 服务器已启动 ${this.address}（card url: ${this.options.publicUrl}）`)
  }

  async stop(): Promise<void> {
    if (!this.started) return
    if (this.gcTimer !== undefined) clearInterval(this.gcTimer)
    for (const session of [...this.sseSessions]) session.close()
    await new Promise<void>((resolve, reject) => {
      this.http.close(() => resolve())
      this.http.once('error', reject)
    })
    this.started = false
  }

  // ── 请求路由 ────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCommonHeaders(res)
    const url = new URL(req.url ?? '/', 'http://a2a.local')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.corsHeaders())
      res.end()
      return
    }
    if (req.method === 'GET' && (url.pathname === CARD_PATH || url.pathname === CARD_LEGACY_PATH)) {
      this.serveCard(req, res)
      return
    }
    // 运维端点（与 JSON-RPC 同源鉴权）：状态摘要与最近任务列表，
    // 供浏览器端运维面板（client 半）直接 fetch。
    if (req.method === 'GET' && (url.pathname === '/admin/status' || url.pathname === '/admin/tasks')) {
      this.serveAdmin(req, res, url)
      return
    }
    if (req.method === 'POST' && this.isRpcPath(url.pathname)) {
      await this.handleRpc(req, res)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json', ...this.corsHeaders() })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  /** POST 目标路径：'/' 以及 publicUrl 指定的路径（公网反代常见 /a2a 前缀）。 */
  private isRpcPath(pathname: string): boolean {
    if (pathname === '/') return true
    try {
      return pathname.replace(/\/+$/, '') === new URL(this.options.publicUrl).pathname.replace(/\/+$/, '')
    } catch {
      return false
    }
  }

  private setCommonHeaders(res: ServerResponse): void {
    res.setHeader('A2A-Version', PROTOCOL_VERSION)
    for (const [key, value] of Object.entries(this.corsHeaders())) res.setHeader(key, value)
  }

  private corsHeaders(): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-A2A-Version, A2A-Version',
      'Access-Control-Expose-Headers': 'A2A-Version',
    }
  }

  private serveCard(req: IncomingMessage, res: ServerResponse): void {
    const accept = String(req.headers.accept ?? '')
    const body = accept.includes('text/html')
      ? `<html><body><pre>${JSON.stringify(this.options.card, null, 2)}</pre></body></html>`
      : JSON.stringify(this.options.card, null, 2)
    res.writeHead(200, { 'Content-Type': 'application/json', ...this.corsHeaders() })
    res.end(body)
  }

  /** /admin/status 与 /admin/tasks：运维面板数据源（Bearer 门禁同 RPC）。 */
  private serveAdmin(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.options.bearerToken !== undefined && !this.checkAuth(req)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="a2a"',
        ...this.corsHeaders(),
      })
      res.end(JSON.stringify({ error: 'unauthorized：缺少或错误的 Bearer 令牌' }))
      return
    }
    if (url.pathname === '/admin/status') {
      const summaries = this.store.listSummaries(1000)
      const body = {
        running: this.started,
        mode: this.options.mode ?? 'agent',
        listen: `${this.options.host}:${this.options.port}`,
        publicUrl: this.options.publicUrl,
        rpcUrl: this.address,
        protocolVersion: PROTOCOL_VERSION,
        auth: this.options.bearerToken !== undefined,
        turnTimeoutMs: this.turnTimeoutMs,
        taskTtlMs: this.taskTtlMs,
        tasks: {
          total: summaries.length,
          active: summaries.filter((t) => t.state === 'working' || t.state === 'submitted' || t.state === 'input-required').length,
        },
        card: this.options.card,
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...this.corsHeaders() })
      res.end(JSON.stringify(body, null, 2))
      return
    }
    // /admin/tasks
    const limitParam = Number(url.searchParams.get('limit') ?? '50')
    const limit = Number.isFinite(limitParam) ? Math.floor(limitParam) : 50
    const tasks = this.store.listSummaries(limit)
    res.writeHead(200, { 'Content-Type': 'application/json', ...this.corsHeaders() })
    res.end(JSON.stringify({ tasks }, null, 2))
  }

  // ── JSON-RPC 入口 ───────────────────────────────────────────────────

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 版本协商：主版本不一致直接拒绝（缺头视为同版本，兼容 0.2 客户端）。
    const requestVersion = req.headers['x-a2a-version'] ?? req.headers['a2a-version']
    if (typeof requestVersion === 'string') {
      const requested = requestVersion.split('.')[0]
      // Round 2.6：服务端同时接受 0.x 与 1.x（v1 方法别名 + 入站归一）；
      // 其他主版本仍 400。方法名而不是头决定响应形状（spec §3.1）。
      if (requested !== '0' && requested !== '1') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `unsupported A2A version ${requestVersion}（本服务器 ${PROTOCOL_VERSION}）` }))
        return
      }
    }
    if (this.options.bearerToken !== undefined && !this.checkAuth(req)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="a2a"',
      })
      res.end(JSON.stringify({ error: 'unauthorized：缺少或错误的 Bearer 令牌' }))
      return
    }

    const raw = await this.readBody(req, res)
    if (raw === undefined) return // readBody 已回错
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(null, RPC_ERRORS.PARSE_ERROR, 'JSON 解析失败')))
      return
    }
    const parsedRequest = parseJsonRpcRequest(parsed)
    if (!parsedRequest.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(null, RPC_ERRORS.INVALID_REQUEST, parsedRequest.error)))
      return
    }
    const request = parsedRequest.request
    // 响应头跟随方法的 wire 版本（spec §3.1）：卡片/admin/404 已在入口固定
    // 0.3.0，这里只覆盖 RPC 响应。
    res.setHeader('A2A-Version', wireVersionFor(request.method))
    this.logger.debug(`a2a: JSON-RPC ${request.method} (id=${String(request.id)})`)

    // SSE 方法在 headers 写出前单独处理（成功响应是 text/event-stream）。
    if (request.method === 'message/stream') {
      await this.handleStream(request, res)
      return
    }
    if (request.method === 'tasks/resubscribe') {
      await this.handleResubscribe(request, res)
      return
    }

    const response = await this.dispatch(request)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  }

  private checkAuth(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    return match !== null && match[1].trim() === this.options.bearerToken
  }

  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'request body too large' }))
        return undefined
      }
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /** 非流式方法的统一分发。 */
  private async dispatch(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const route = RPC_ROUTES[request.method]
    if (route !== undefined) {
      switch (route.handler) {
        case 'send':
          return this.handleSend(request, route.v1)
        case 'getTask':
          return this.handleGetTask(request, route.v1)
        case 'cancel':
          return this.handleCancel(request, route.v1)
        case 'pushConfig':
          return jsonrpcError(
            request.id,
            A2A_ERRORS.PUSH_NOTIFICATION_NOT_SUPPORTED,
            '本 A2A 服务器不支持推送通知',
          )
      }
    }
    if (request.method === 'agent/authenticatedExtendedCard') {
      return jsonrpcResult(request.id, this.options.card)
    }
    return jsonrpcError(request.id, RPC_ERRORS.METHOD_NOT_FOUND, `未知方法 ${request.method}`)
  }

  // ── message/send（同步执行）────────────────────────────────────────

  private async handleSend(request: JsonRpcRequest, v1: boolean): Promise<JsonRpcResponse> {
    const parsed = parseMessageSendParams(request.params)
    if (!parsed.ok) {
      return jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, parsed.error)
    }
    const prepared = this.prepareTask(parsed.params.message)
    if (!prepared.ok) {
      return jsonrpcError(request.id, prepared.code, prepared.message)
    }
    const { task, message, history } = prepared
    this.logger.info(`a2a: message/send task=${task.id} context=${task.contextId} turn=${message.messageId}`)
    await this.executeTurn(task, message, history)
    const snapshot = task.snapshot()
    // v1.0 SendMessage 的 result 是 {task}；v0.3 message/send 仍是裸 Task。
    return jsonrpcResult(request.id, v1 ? { task: toV1Task(snapshot) } : snapshot)
  }

  /**
   * 解析/创建任务：
   * - 无 taskId：新任务（缺省 contextId 时生成）；
   * - 有 taskId：必须是存在的 input-required 任务（多轮续答）；
   *   否则 TaskNotFound / UnsupportedOperation。
   */
  private prepareTask(message: A2aMessage):
    | { ok: true; task: StoredTask; message: A2aMessage; history: A2aMessage[] }
    | { ok: false; code: number; message: string } {
    if (message.taskId === undefined) {
      const contextId = message.contextId ?? randomUUID()
      const full: A2aMessage = { ...message, contextId }
      const task = this.store.create(contextId)
      const history: A2aMessage[] = [full]
      task.pushHistory(full)
      return { ok: true, task, message: full, history }
    }
    const task = this.store.get(message.taskId)
    if (!task) {
      return { ok: false, code: A2A_ERRORS.TASK_NOT_FOUND, message: `任务 ${message.taskId} 不存在` }
    }
    if (task.final) {
      return { ok: false, code: A2A_ERRORS.TASK_NOT_FOUND, message: `任务 ${message.taskId} 已完结（${task.state}），请不带 taskId 发起新任务` }
    }
    if (task.state !== 'input-required') {
      return { ok: false, code: A2A_ERRORS.UNSUPPORTED_OPERATION, message: `任务 ${message.taskId} 状态为 ${task.state}，仅 input-required 状态可续答` }
    }
    const full: A2aMessage = { ...message, contextId: task.contextId }
    task.pushHistory(full)
    const history = [...(task.snapshot().history ?? [])]
    return { ok: true, task, message: full, history }
  }

  /** 执行一轮：working → runner → 补终态；覆盖取消/超时/异常。 */
  private async executeTurn(task: StoredTask, message: A2aMessage, history: readonly A2aMessage[]): Promise<void> {
    const controller = controllerFor(task)
    if (controller.canceled) return // 创建即取消的极端竞态
    controller.updateStatus('working')
    try {
      const run = this.options.runner.run({ controller, message, history })
      const timeout = new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), this.turnTimeoutMs)
        timer.unref?.()
      })
      const outcome = await Promise.race([run.then(() => 'done' as const), timeout])
      if (controller.canceled) return // cancel() 已广播终态
      if (outcome === 'timeout') {
        controller.updateStatus('failed', this.agentNote(task, `任务超时（>${this.turnTimeoutMs}ms）被服务器终止`))
        return
      }
      // input-required：runner 主动暂停等待补充输入，保留状态供 taskId 续答。
      if (task.state === 'input-required') return
      if (!controller.final) {
        controller.updateStatus('completed')
      }
    } catch (error) {
      if (controller.canceled || controller.final) return
      const text = error instanceof Error ? error.message : String(error)
      this.logger.warn(`a2a: task ${task.id} 执行失败：${text}`)
      controller.updateStatus('failed', this.agentNote(task, `执行失败：${text}`))
    }
  }

  /** 造一条 role=agent 的状态说明消息（放入 status.message，供客户端展示）。 */
  private agentNote(task: StoredTask, text: string): A2aMessage {
    return {
      kind: 'message',
      role: 'agent',
      parts: [{ kind: 'text', text }],
      messageId: randomUUID(),
      taskId: task.id,
      contextId: task.contextId,
    }
  }

  // ── tasks/get、tasks/cancel ────────────────────────────────────────

  private handleGetTask(request: JsonRpcRequest, v1: boolean): JsonRpcResponse {
    const taskId = this.taskIdParam(request.params)
    if (taskId === undefined) {
      return jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, 'params.id（或 params.taskId）必须是非空字符串')
    }
    const task = this.store.get(taskId)
    if (!task) {
      return jsonrpcError(request.id, A2A_ERRORS.TASK_NOT_FOUND, `任务 ${taskId} 不存在或已过期回收`)
    }
    const snapshot = task.snapshot()
    return jsonrpcResult(request.id, v1 ? toV1Task(snapshot) : snapshot)
  }

  private handleCancel(request: JsonRpcRequest, v1: boolean): JsonRpcResponse {
    const taskId = this.taskIdParam(request.params)
    if (taskId === undefined) {
      return jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, 'params.id（或 params.taskId）必须是非空字符串')
    }
    const result = this.store.cancel(taskId)
    if (result === 'not-found') {
      return jsonrpcError(request.id, A2A_ERRORS.TASK_NOT_FOUND, `任务 ${taskId} 不存在或已过期回收`)
    }
    if (result === 'not-cancelable') {
      return jsonrpcError(request.id, A2A_ERRORS.TASK_NOT_CANCELABLE, `任务 ${taskId} 已完结，无法取消`)
    }
    const snapshot = this.store.get(taskId)?.snapshot() ?? null
    return jsonrpcResult(request.id, v1 && snapshot !== null ? toV1Task(snapshot) : snapshot)
  }

  /**
   * 任务 id 参数：A2A 规范（0.3）用 `params.id`，部分客户端与本插件旧约定
   * 用 `params.taskId`——两者都接受，优先规范写法。
   */
  private taskIdParam(params: unknown): string | undefined {
    return this.stringParam(params, 'id') ?? this.stringParam(params, 'taskId')
  }

  private stringParam(params: unknown, key: string): string | undefined {
    if (params === null || typeof params !== 'object') return undefined
    const value = (params as Record<string, unknown>)[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  // ── SSE（message/stream、tasks/resubscribe）─────────────────────────

  private async handleStream(request: JsonRpcRequest, res: ServerResponse): Promise<void> {
    const parsed = parseMessageSendParams(request.params)
    if (!parsed.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, parsed.error)))
      return
    }
    const prepared = this.prepareTask(parsed.params.message)
    if (!prepared.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(request.id, prepared.code, prepared.message)))
      return
    }
    const { task, message, history } = prepared
    this.logger.info(`a2a: message/stream task=${task.id} context=${task.contextId} turn=${message.messageId}`)

    const session = this.openSse(res)
    // 先订阅再执行：保证 working 事件不丢。
    const unsubscribe = task.subscribe((event) => {
      session.write(jsonrpcResult(request.id, event))
      if (event.kind === 'status-update' && event.final) session.close()
    })
    res.on('close', unsubscribe)
    session.onClose(unsubscribe)
    this.executeTurn(task, message, history).catch((error: unknown) => {
      this.logger.error(`a2a: stream task ${task.id} 执行异常`, error)
      session.close()
    })
  }

  private async handleResubscribe(request: JsonRpcRequest, res: ServerResponse): Promise<void> {
    const taskId = this.taskIdParam(request.params)
    if (taskId === undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(request.id, RPC_ERRORS.INVALID_PARAMS, 'params.id（或 params.taskId）必须是非空字符串')))
      return
    }
    const task = this.store.get(taskId)
    if (!task) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jsonrpcError(request.id, A2A_ERRORS.TASK_NOT_FOUND, `任务 ${taskId} 不存在或已过期回收`)))
      return
    }
    const session = this.openSse(res)
    // 回放缓冲事件（含 final 则回放后收尾）。
    for (const event of task.bufferedEvents()) {
      session.write(jsonrpcResult(request.id, event))
    }
    const alreadyFinal = task.bufferedEvents().some((e) => e.kind === 'status-update' && e.final)
    if (alreadyFinal || task.final) {
      session.close()
      return
    }
    const unsubscribe = task.subscribe((event) => {
      session.write(jsonrpcResult(request.id, event))
      if (event.kind === 'status-update' && event.final) session.close()
    })
    res.on('close', unsubscribe)
    session.onClose(unsubscribe)
  }

  private openSse(res: ServerResponse): SseSession & { onClose(fn: () => void): void } {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    let closed = false
    const closeCallbacks: Array<() => void> = []
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n')
    }, SSE_HEARTBEAT_MS)
    const finish = (): void => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      this.sseSessions.delete(session)
      for (const fn of closeCallbacks) fn()
      res.end()
    }
    const session: SseSession & { onClose(fn: () => void): void } = {
      write: (response: JsonRpcResponse) => {
        if (closed) return
        res.write(`data: ${JSON.stringify(response)}\n\n`)
      },
      close: finish,
      onClose: (fn: () => void) => {
        closeCallbacks.push(fn)
      },
    }
    res.on('close', finish)
    this.sseSessions.add(session)
    return session
  }
}
