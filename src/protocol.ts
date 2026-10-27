/**
 * A2A（Agent2Agent）协议类型与纯函数工具：消息/任务/事件结构、
 * JSON-RPC 2.0 信封、错误码、Agent Card 构造与参数校验。
 *
 * 本模块零依赖（不 import DSH / cordis / node API 之外的任何包），
 * 服务器、客户端、冒烟测试共用，保证三端看到同一份 wire 契约。
 *
 * 兼容性：以 A2A 0.3.x（`kind` 判别字段、`/.well-known/agent-card.json`、
 * `protocolVersion`、`A2A-Version` 头）为准实现，同时兼容 0.2.x 客户端
 * （旧 `/.well-known/agent.json` 路径、camelCase 方法名一致）。
 *
 * @module dsh-a2a/protocol
 */

import { randomUUID } from 'node:crypto'

// ── 常量 ────────────────────────────────────────────────────────────────

/** 本实现宣告/应答的 A2A 协议版本。 */
export const PROTOCOL_VERSION = '0.3.0'

/** Agent Card 的 0.3.x 标准路径。 */
export const CARD_PATH = '/.well-known/agent-card.json'
/** Agent Card 的 0.2.x 旧路径（同时保留，兼容旧客户端）。 */
export const CARD_LEGACY_PATH = '/.well-known/agent.json'

// ── 消息部件（Parts）──────────────────────────────────────────────────

export interface TextPart {
  readonly kind: 'text'
  readonly text: string
  readonly metadata?: Record<string, unknown>
}

export interface DataPart {
  readonly kind: 'data'
  readonly data: Record<string, unknown>
  readonly metadata?: Record<string, unknown>
}

export interface FilePart {
  readonly kind: 'file'
  readonly file: {
    /** base64 编码的字节（与 uri 二选一）。 */
    readonly bytes?: string
    readonly uri?: string
    readonly mimeType?: string
    readonly name?: string
  }
  readonly metadata?: Record<string, unknown>
}

export type Part = TextPart | DataPart | FilePart

// ── 消息 / 产物（Message / Artifact）──────────────────────────────────

export type MessageRole = 'user' | 'agent'

export interface A2aMessage {
  readonly kind: 'message'
  readonly role: MessageRole
  readonly parts: readonly Part[]
  readonly messageId: string
  readonly taskId?: string
  readonly contextId?: string
  readonly metadata?: Record<string, unknown>
}

export interface Artifact {
  readonly kind: 'artifact'
  readonly artifactId: string
  readonly name?: string
  readonly description?: string
  readonly parts: readonly Part[]
  readonly metadata?: Record<string, unknown>
}

// ── 任务（Task）───────────────────────────────────────────────────────

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  /** v1.0 的 `TASK_STATE_AUTH_REQUIRED`：等待授权，不是终态。 */
  | 'auth-required'
  /** v1.0 的 `TASK_STATE_UNSPECIFIED` 或客户端不认识的枚举：不是终态。 */
  | 'unknown'

/** 终态集合：再收到任何状态迁移都是协议错误。 */
export const TERMINAL_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
]

export interface TaskStatus {
  readonly state: TaskState
  readonly message?: A2aMessage
  /** RFC 3339 时间戳。 */
  readonly timestamp: string
  /** 归一时保留的原始状态值（仅 `state === 'unknown'` 时存在）。 */
  readonly rawState?: string
}

export interface A2aTask {
  readonly kind: 'task'
  readonly id: string
  readonly contextId: string
  readonly status: TaskStatus
  readonly artifacts?: readonly Artifact[]
  readonly history?: readonly A2aMessage[]
  readonly metadata?: Record<string, unknown>
}

// ── 流事件（SSE events）──────────────────────────────────────────────

export interface TaskStatusUpdateEvent {
  readonly kind: 'status-update'
  readonly taskId: string
  readonly contextId: string
  readonly status: TaskStatus
  /** true = 本任务不再产生后续事件。 */
  readonly final: boolean
}

export interface TaskArtifactUpdateEvent {
  readonly kind: 'artifact-update'
  readonly taskId: string
  readonly contextId: string
  readonly artifact: Artifact
  readonly append?: boolean
  readonly lastChunk?: boolean
  readonly metadata?: Record<string, unknown>
}

export type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent

// ── Agent Card ────────────────────────────────────────────────────────

export interface AgentSkill {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly inputModes?: readonly string[]
  readonly outputModes?: readonly string[]
}

export interface AgentCapabilities {
  readonly streaming: boolean
  readonly pushNotifications: boolean
  readonly stateTransitionHistory: boolean
}

/** A2A v1.0 卡片接口声明（`supportedInterfaces[]`）。 */
export interface AgentInterface {
  readonly url: string
  readonly protocolBinding?: string
  readonly protocolVersion?: string
}

export interface AgentCard {
  readonly name: string
  readonly description?: string
  /** 顶层服务地址；v1.0 实现（如 pi-a2a）可能只给 `supportedInterfaces`。 */
  readonly url?: string
  /**
   * A2A v1.0 的接口列表形态：部分实现（如 pi-a2a）只给
   * `supportedInterfaces[].url`，不写顶层 `url`。客户端解析时兼容两种形态。
   */
  readonly supportedInterfaces?: readonly AgentInterface[]
  readonly version: string
  /** 单数形态；v1.0 实现可能只给 `protocolVersions[]`。 */
  readonly protocolVersion?: string
  /** v1.0 复数形态（可含多个版本）。 */
  readonly protocolVersions?: readonly string[]
  readonly preferredTransport: 'JSONRPC'
  readonly capabilities: AgentCapabilities
  readonly defaultInputModes: readonly string[]
  readonly defaultOutputModes: readonly string[]
  readonly skills: readonly AgentSkill[]
  readonly provider?: {
    readonly organization: string
    readonly url?: string
  }
  readonly securitySchemes?: Record<string, {
    readonly type: string
    readonly scheme?: string
    readonly bearerFormat?: string
  }>
  readonly security?: readonly Record<string, readonly string[]>[]
  /** 扩展字段：本插件的运行模式（对人类诊断有用，客户端应忽略）。 */
  readonly 'x-dsh-a2a'?: Record<string, unknown>
}

/** Agent Card 构造入参（secret 已解析后的形态）。 */
export interface CardOptions {
  name: string
  description?: string
  /** 客户端回连本 agent 的 JSON-RPC 绝对地址。 */
  url: string
  /** agent 自身版本（非协议版本）。 */
  version: string
  skills?: readonly AgentSkill[]
  /** 配置了 bearer 鉴权时提供 token，卡片将宣告 bearerAuth 方案。 */
  bearerToken?: string
  providerOrganization?: string
  extra?: Record<string, unknown>
}

export function buildAgentCard(options: CardOptions): AgentCard {
  const card: AgentCard = {
    name: options.name,
    ...(options.description !== undefined ? { description: options.description } : {}),
    url: options.url,
    version: options.version,
    protocolVersion: PROTOCOL_VERSION,
    // Round 2.6 spec §3.5：补发复数形态，供网关 presenter 如实呈现；单数
    // 保留，且仍只宣告 0.3.0（服务端 v1 能力不完整，不 overclaim）。
    protocolVersions: [PROTOCOL_VERSION],
    preferredTransport: 'JSONRPC',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: options.skills && options.skills.length > 0
      ? [...options.skills]
      : [{
          id: 'dsh-agent',
          name: 'DeepSeek Harness Agent',
          description: '通过 A2A 协议与 DeepSeek Harness（DSH）agent 会话交互：发送指令、获得执行结果文本。',
          tags: ['dsh', 'deepseek', 'harness', 'automation'],
        }],
    ...(options.providerOrganization
      ? { provider: { organization: options.providerOrganization } }
      : {}),
    ...(options.bearerToken
      ? {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT-or-opaque' },
          },
          security: [{ bearerAuth: [] }],
        }
      : { security: [] }),
    ...(options.extra !== undefined ? { 'x-dsh-a2a': options.extra } : {}),
  }
  return card
}

// ── JSON-RPC 2.0 ──────────────────────────────────────────────────────

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result: unknown
}

export interface JsonRpcErrorBody {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly error: JsonRpcErrorBody
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

/** JSON-RPC 标准错误码。 */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

/** A2A 规范定义的服务端错误码。 */
export const A2A_ERRORS = {
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
} as const

export function jsonrpcResult(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

export function jsonrpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

/** 解析并校验单个（非批量）JSON-RPC 请求；失败返回错误字符串。 */
export function parseJsonRpcRequest(raw: unknown): { ok: true; request: JsonRpcRequest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '请求必须是单个 JSON-RPC 对象（A2A 不支持批量请求）' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.jsonrpc !== '2.0') {
    return { ok: false, error: 'jsonrpc 字段必须为 "2.0"' }
  }
  if (typeof obj.method !== 'string' || obj.method.length === 0) {
    return { ok: false, error: 'method 必须是非空字符串' }
  }
  const id = obj.id
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return { ok: false, error: 'id 必须是 string / number / null' }
  }
  return {
    ok: true,
    request: {
      jsonrpc: '2.0',
      id: (id ?? null) as string | number | null,
      method: obj.method,
      ...(obj.params !== undefined ? { params: obj.params } : {}),
    },
  }
}

// ── message/send、message/stream 参数 ────────────────────────────────

export interface MessageSendParams {
  readonly message: A2aMessage
  readonly configuration?: {
    readonly blocking?: boolean
    readonly acceptedOutputModes?: readonly string[]
  }
}

/**
 * v0.3 / v1.0 两种 role 形态归一：v1.0 用 ROLE_USER / ROLE_AGENT，v0.3 已是
 * 小写；其它值（含 ROLE_BOT）返回 undefined 交给调用方报 -32602。
 */
function normalizeRole(raw: unknown): 'user' | 'agent' | undefined {
  if (raw === 'user' || raw === 'ROLE_USER') return 'user'
  if (raw === 'agent' || raw === 'ROLE_AGENT') return 'agent'
  return undefined
}

/**
 * v0.3 / v1.0 两种 part 形态归一（spec §3.3）：有 kind 走 v0.3 分支；无 kind
 * 时按成员判别（text:string / data:object / file:{uri|bytes}）。判不出或
 * 形态不合法返回 undefined，调用方保持原有的 -32602 文案。
 */
function normalizePart(raw: unknown): Part | undefined {
  const part = raw as Record<string, unknown>
  // part 级 metadata（v1 客户端会带）与 message 级一样原样保留；形态不合法
  // 就当作没给，绝不因此丢掉 part。
  const metadata = part.metadata !== null && typeof part.metadata === 'object' && !Array.isArray(part.metadata)
    ? { metadata: part.metadata as Record<string, unknown> }
    : {}
  const kind = part.kind ?? (
    typeof part.text === 'string'
      ? 'text'
      : part.data !== null && typeof part.data === 'object' && !Array.isArray(part.data)
        ? 'data'
        : part.file !== null && typeof part.file === 'object'
          ? 'file'
          : undefined
  )
  if (kind === 'text' && typeof part.text === 'string') {
    return { kind: 'text', text: part.text, ...metadata }
  }
  if (kind === 'data' && part.data !== null && typeof part.data === 'object' && !Array.isArray(part.data)) {
    return { kind: 'data', data: part.data as Record<string, unknown>, ...metadata }
  }
  if (
    kind === 'file' && part.file !== null && typeof part.file === 'object'
    && (typeof (part.file as Record<string, unknown>).uri === 'string'
      || typeof (part.file as Record<string, unknown>).bytes === 'string')
  ) {
    return { kind: 'file', file: part.file as FilePart['file'], ...metadata }
  }
  return undefined
}

/**
 * 解析 message/send、message/stream 的 params；补齐缺失的 messageId /
 * contextId（服务端生成），并校验 parts 形态。失败返回给客户端的错误文本。
 */
export function parseMessageSendParams(raw: unknown): { ok: true; params: MessageSendParams } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'params 必须是对象' }
  }
  const obj = raw as Record<string, unknown>
  const messageRaw = obj.message
  if (messageRaw === null || typeof messageRaw !== 'object') {
    return { ok: false, error: 'params.message 必须是对象' }
  }
  const m = messageRaw as Record<string, unknown>
  const role = normalizeRole(m.role)
  if (role === undefined) {
    return { ok: false, error: 'message.role 必须是 "user" 或 "agent"' }
  }
  if (!Array.isArray(m.parts) || m.parts.length === 0) {
    return { ok: false, error: 'message.parts 必须是非空数组' }
  }
  const parts: Part[] = []
  for (const p of m.parts) {
    if (p === null || typeof p !== 'object') {
      return { ok: false, error: 'message.parts[] 的每一项必须是对象' }
    }
    const part = normalizePart(p)
    if (part === undefined) {
      return { ok: false, error: 'message.parts[] 含不支持的 part（kind 必须是 text/data/file 且形态合法）' }
    }
    parts.push(part)
  }
  const messageId = typeof m.messageId === 'string' && m.messageId.length > 0 ? m.messageId : randomUUID()
  const contextId = typeof m.contextId === 'string' && m.contextId.length > 0 ? m.contextId : undefined
  const taskId = typeof m.taskId === 'string' && m.taskId.length > 0 ? m.taskId : undefined
  const metadata = m.metadata !== null && typeof m.metadata === 'object' && !Array.isArray(m.metadata)
    ? (m.metadata as Record<string, unknown>)
    : undefined
  const message: A2aMessage = {
    kind: 'message',
    role,
    parts,
    messageId,
    // v1.0 客户端把 kind/from 等放在 message.metadata：原样透传（Round 2.6
    // spec §3.3），否则上游/历史里会丢。
    ...(metadata !== undefined ? { metadata } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    // contextId 未提供时由服务器补（见 server.ts：同一缺省上下文 = 无状态）。
    ...(contextId !== undefined ? { contextId } : {}),
  }
  return { ok: true, params: { message, ...(obj.configuration !== undefined ? { configuration: obj.configuration as MessageSendParams['configuration'] } : {}) } }
}

// ── v1.0 兼容（Round 2.6 spec §3.2/§3.4）──────────────────────────────

/**
 * A2A 1.0 的方法名全集（含本服务端未实现/不支持的）：响应头按它判 1.0。
 * 名字来源是本仓库内的权威表（0.6.0 设计 spec §3.3）：增删名字必须同步
 * 该节、本文件与验收矩阵。
 */
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

/**
 * 请求方法名是否属于 v1.0 别名集合（决定是否走别名分发，不决定响应头）。
 * 公开 API（spec §3.3）；服务端分发以 `RPC_ROUTES.v1` 为准。
 */
export function isV1Method(method: string): boolean {
  return V1_ALIASES.has(method)
}

/**
 * 推送通知配置方法全集（v0.3 的 4 个前缀名 + v1 的 4 个名字）：错误分类用它
 * 消歧 `-32003`（push 能力不支持 ≠ 上游不可用可重试）。
 */
export const PUSH_CONFIG_METHOD_NAMES: readonly string[] = [
  'tasks/pushNotificationConfig/set',
  'tasks/pushNotificationConfig/get',
  'tasks/pushNotificationConfig/list',
  'tasks/pushNotificationConfig/delete',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
]

/** 该方法名是否属于推送通知配置家族。 */
export function isPushConfigMethod(method: string | undefined): boolean {
  return method !== undefined && PUSH_CONFIG_METHOD_NAMES.includes(method)
}

/**
 * 该方法名对应的 wire 版本：v1.0 名字全集 → '1.0'，其余（message/send、
 * message/stream、tasks/*、resubscribe）→ '0.3.0'。响应头 A2A-Version 用它，
 * 与请求头无关（方法名决定形状与版本，spec §3.3）。
 */
export function wireVersionFor(method: string): '1.0' | '0.3.0' {
  return V1_METHOD_NAMES.includes(method) ? '1.0' : '0.3.0'
}

/** v0.3 状态 → v1.0 ProtoJSON 枚举（`auth-required` 也在此表；unknown 单列）。 */
const V1_TASK_STATES: Record<Exclude<TaskState, 'unknown'>, string> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  rejected: 'TASK_STATE_REJECTED',
  'auth-required': 'TASK_STATE_AUTH_REQUIRED',
}

/** JSON 对象（排除 null 与数组）：兜底判据统一用它。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** v1.0 状态串（spec §3.4）：合法映射才转换；unknown 保留合法 rawState；其余 UNSPECIFIED。 */
function v1TaskState(status: Record<string, unknown>): string {
  const state = status['state']
  if (state === 'unknown') {
    const rawState = status['rawState']
    return typeof rawState === 'string' && /^TASK_STATE_/.test(rawState) ? rawState : 'TASK_STATE_UNSPECIFIED'
  }
  if (typeof state === 'string' && Object.prototype.hasOwnProperty.call(V1_TASK_STATES, state)) {
    return V1_TASK_STATES[state as Exclude<TaskState, 'unknown'>]
  }
  return 'TASK_STATE_UNSPECIFIED'
}

/**
 * v1.0 part：去掉判别字段 `kind`，只留成员形态（file 不产生 url）。
 * 二分规则（spec §3.4）：显式 kind 不是三型 → 省略（不按成员反推）；
 * 缺 kind → 按成员判别（text 字符串 / data 对象非数组 / file 含 uri|bytes）；
 * 判不出、或 part 不是对象 → undefined。
 */
function v1Part(part: unknown): Record<string, unknown> | undefined {
  if (!isRecord(part)) return undefined
  const metadata = part['metadata'] !== undefined ? { metadata: part['metadata'] } : {}
  if ('kind' in part) {
    switch (part['kind']) {
      case 'text':
        return typeof part['text'] === 'string' ? { text: part['text'], ...metadata } : undefined
      case 'data':
        return isRecord(part['data']) ? { data: part['data'], ...metadata } : undefined
      case 'file': {
        const file = part['file']
        return isRecord(file) ? { file, ...metadata } : undefined
      }
      default:
        return undefined
    }
  }
  if (typeof part['text'] === 'string') return { text: part['text'], ...metadata }
  if (isRecord(part['data'])) return { data: part['data'], ...metadata }
  const file = part['file']
  if (isRecord(file) && ('uri' in file || 'bytes' in file)) return { file, ...metadata }
  return undefined
}

/** v1.0 message：role 用枚举名，parts 去 kind，其余字段原样；非对象 → undefined。 */
function v1Message(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) return undefined
  return {
    role: message['role'] === 'user' ? 'ROLE_USER' : 'ROLE_AGENT',
    parts: Array.isArray(message['parts'])
      ? message['parts'].map(v1Part).filter((part): part is Record<string, unknown> => part !== undefined)
      : [],
    messageId: message['messageId'],
    ...(message['taskId'] !== undefined ? { taskId: message['taskId'] } : {}),
    ...(message['contextId'] !== undefined ? { contextId: message['contextId'] } : {}),
    ...(message['metadata'] !== undefined ? { metadata: message['metadata'] } : {}),
  }
}

/** v1.0 status：非对象 → 只有 UNSPECIFIED state（不编造 timestamp）；message 非对象 → 省略。 */
function v1Status(status: unknown): Record<string, unknown> {
  if (!isRecord(status)) return { state: 'TASK_STATE_UNSPECIFIED' }
  const message = v1Message(status['message'])
  return {
    state: v1TaskState(status),
    ...(status['timestamp'] !== undefined ? { timestamp: status['timestamp'] } : {}),
    ...(message !== undefined ? { message } : {}),
  }
}

/**
 * 把内部 Task 快照序列化成 v1.0 形状（spec §3.4）：去 `kind`、状态用
 * `TASK_STATE_*`、role 用 `ROLE_*`、part 去 kind、丢弃内部字段 `rawState`。
 * 只做形状变换，不改 id/contextId/timestamp/artifactId/metadata。
 *
 * 公开导出：对非 task 形状做结构性兜底——不抛、不产 `null`、`status` 定有
 * `state`（规则见 spec §3.4）。合法输入输出逐字段不变。
 */
export function toV1Task(task: A2aTask): Record<string, unknown> {
  if (!isRecord(task)) return { status: { state: 'TASK_STATE_UNSPECIFIED' } }
  const rawArtifacts = task['artifacts']
  const artifacts = Array.isArray(rawArtifacts)
    ? rawArtifacts.filter(isRecord).map((artifact) => ({
        ...(artifact['artifactId'] !== undefined ? { artifactId: artifact['artifactId'] } : {}),
        ...(artifact['name'] !== undefined ? { name: artifact['name'] } : {}),
        ...(artifact['description'] !== undefined ? { description: artifact['description'] } : {}),
        parts: Array.isArray(artifact['parts'])
          ? artifact['parts'].map(v1Part).filter((part): part is Record<string, unknown> => part !== undefined)
          : [],
        ...(artifact['metadata'] !== undefined ? { metadata: artifact['metadata'] } : {}),
      }))
    : undefined
  const rawHistory = task['history']
  const history = Array.isArray(rawHistory)
    ? rawHistory.map(v1Message).filter((message): message is Record<string, unknown> => message !== undefined)
    : undefined
  return {
    id: task['id'],
    contextId: task['contextId'],
    status: v1Status(task['status']),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(history !== undefined ? { history } : {}),
    ...(task['metadata'] !== undefined ? { metadata: task['metadata'] } : {}),
  }
}

/** 版本头的取值结果：没带 / 合法文本 / 非法非字符串（带 raw）。 */
function readVersionHeader(
  value: unknown,
): { kind: 'absent' } | { kind: 'text'; value: string } | { kind: 'invalid'; raw: string } {
  if (value === undefined) return { kind: 'absent' }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? { kind: 'absent' } : { kind: 'text', value: trimmed }
  }
  return { kind: 'invalid', raw: Array.isArray(value) ? value.join(',') : String(value) }
}

/**
 * 版本门（spec §3.5）：先挑值（空串等价没带，非空 X 优先），再校验主版本
 * 只能是 0 或 1。非法非字符串头直接拒绝，`raw` 是导致拒绝的那个头
 * （先看 X，再看 A2A-Version）。
 */
export function checkVersionHeader(
  x: unknown,
  a: unknown,
): { ok: true } | { ok: false; raw: string } {
  const first = readVersionHeader(x)
  if (first.kind === 'invalid') return { ok: false, raw: first.raw }
  const second = first.kind === 'absent' ? readVersionHeader(a) : undefined
  if (second?.kind === 'invalid') return { ok: false, raw: second.raw }
  const chosen = first.kind === 'text' ? first.value : second?.kind === 'text' ? second.value : undefined
  if (chosen === undefined) return { ok: true }
  const major = chosen.split('.')[0]
  return major === '0' || major === '1' ? { ok: true } : { ok: false, raw: chosen }
}

// ── 小工具 ─────────────────────────────────────────────────────────────

/** 提取消息中的全部文本（text part 顺序拼接；无文本 part 返回空串）。 */
export function extractText(parts: readonly Part[]): string {
  let out = ''
  for (const p of parts) {
    if (p.kind === 'text') out += p.text
  }
  return out
}

/** data/file part 的简要描述（用于日志与诊断，不参与正文）。 */
export function describeNonTextParts(parts: readonly Part[]): string[] {
  const out: string[] = []
  for (const p of parts) {
    if (p.kind === 'data') out.push('[data part]')
    else if (p.kind === 'file') out.push(p.file.name ? `[file: ${p.file.name}]` : `[file: ${p.file.uri ?? 'inline'}]`)
  }
  return out
}

/** 当前时间的 RFC 3339 时间戳。 */
export function nowTimestamp(): string {
  return new Date().toISOString()
}

/** 终态判断。 */
export function isTerminalState(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state)
}
