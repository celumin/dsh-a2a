/**
 * A2A 任务存储与 SSE 事件中枢。
 *
 * 职责：
 * - 维护每个任务的当前状态（Task wire 形态可随时快照给 tasks/get）；
 * - 把每次状态迁移 / 产物追加包装成 A2A 流事件，写入任务事件缓冲，
 *   并实时推送给全部在线订阅者（message/stream、tasks/resubscribe）；
 * - tasks/resubscribe 需要的事件回放：缓冲按序保留（含 final 事件）；
 * - canceled 状态迁移：只允许发生在非终态任务上（对齐规范
 *   TaskNotCancelable 语义）；
 * - TTL 回收：已完结任务到期移除；卡死的非终态任务到期强制 failed。
 *
 * 本模块零 DSH 依赖，可独立单测。
 *
 * @module dsh-a2a/store
 */

import { randomUUID } from 'node:crypto'
import type {
  A2aMessage,
  A2aTask,
  Artifact,
  Part,
  TaskEvent,
  TaskState,
  TaskStatus,
} from './protocol.ts'
import { isTerminalState, nowTimestamp } from './protocol.ts'

/** 事件缓冲上限（防超长任务把内存吃爆；够 resubscribe 回放用）。 */
const MAX_BUFFERED_EVENTS = 500

/** 单任务最大 history 消息条数（stateTransitionHistory 能力对应的上限）。 */
const MAX_HISTORY = 200

/** 内存中保留的最大任务数（超出时优先淘汰最旧的已完结任务）。 */
const MAX_TASKS = 1000

export interface TaskController {
  readonly taskId: string
  readonly contextId: string
  /** 当前状态（只读快照）。 */
  readonly state: TaskState
  readonly final: boolean
  /** 是否已被客户端取消（runner 应在安全点检查并尽快返回）。 */
  readonly canceled: boolean
  /** 更新任务状态并广播 status-update 事件；终态自动带 final=true。 */
  updateStatus(state: TaskState, message?: A2aMessage): void
  /** 追加产物并广播 artifact-update 事件；返回带 id 的 Artifact。 */
  addArtifact(parts: readonly Part[], options?: { name?: string; description?: string; lastChunk?: boolean }): Artifact
  /** 把一条消息记入任务 history（user/agent 对话留痕）。 */
  recordHistory(message: A2aMessage): void
}

export class StoredTask {
  readonly id: string
  readonly contextId: string
  readonly createdAt: number
  private status: TaskStatus
  private artifacts: Artifact[] = []
  private history: A2aMessage[] = []
  private events: TaskEvent[] = []
  private subscribers = new Set<(event: TaskEvent) => void>()
  private canceledFlag = false

  constructor(contextId: string) {
    this.id = randomUUID()
    this.contextId = contextId
    this.createdAt = Date.now()
    this.status = { state: 'submitted', timestamp: nowTimestamp() }
  }

  get state(): TaskState {
    return this.status.state
  }

  get final(): boolean {
    return isTerminalState(this.status.state)
  }

  get canceled(): boolean {
    return this.canceledFlag
  }

  get lastActivityAt(): number {
    return Date.parse(this.status.timestamp)
  }

  /** wire 形态快照（tasks/get、message/send 返回值）。 */
  snapshot(): A2aTask {
    return {
      kind: 'task',
      id: this.id,
      contextId: this.contextId,
      status: this.status,
      ...(this.artifacts.length > 0 ? { artifacts: [...this.artifacts] } : {}),
      ...(this.history.length > 0 ? { history: [...this.history] } : {}),
    }
  }

  /** 事件缓冲回放（resubscribe 用）。 */
  bufferedEvents(): readonly TaskEvent[] {
    return [...this.events]
  }

  /** 订阅实时事件；返回退订函数。 */
  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /** 更新状态（非法迁移会被拒绝并返回 false：终态后不允许再迁移）。 */
  tryUpdateStatus(state: TaskState, message?: A2aMessage): boolean {
    if (this.final) return false
    this.status = { state, ...(message !== undefined ? { message } : {}), timestamp: nowTimestamp() }
    return true
  }

  /** 标记取消请求（runner 可感知）；真正的 canceled 状态迁移由 cancel() 驱动。 */
  requestCancel(): void {
    this.canceledFlag = true
  }

  appendArtifact(artifact: Artifact): void {
    this.artifacts.push(artifact)
  }

  pushHistory(message: A2aMessage): void {
    this.history.push(message)
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY)
  }

  /** 广播事件：写缓冲 + 通知订阅者。 */
  emit(event: TaskEvent): void {
    this.events.push(event)
    if (this.events.length > MAX_BUFFERED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS)
    }
    for (const listener of [...this.subscribers]) {
      try {
        listener(event)
      } catch {
        // 订阅者异常不影响广播。
      }
    }
  }
}

export class TaskStore {
  private tasks = new Map<string, StoredTask>()

  create(contextId: string): StoredTask {
    const task = new StoredTask(contextId)
    this.tasks.set(task.id, task)
    this.evictIfNeeded()
    return task
  }

  get(id: string): StoredTask | undefined {
    return this.tasks.get(id)
  }

  /** 按创建时间倒序列任务（运维面板用）。 */
  list(): StoredTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 运维面板用的任务摘要（不含 parts 大对象，倒序、限条数）。 */
  listSummaries(limit: number): Array<{
    id: string
    contextId: string
    state: TaskState
    createdAt: number
    lastActivityAt: number
    artifacts: number
    history: number
  }> {
    return this.list().slice(0, Math.max(1, Math.min(limit, 200))).map((task) => {
      const snapshot = task.snapshot()
      return {
        id: task.id,
        contextId: task.contextId,
        state: task.state,
        createdAt: task.createdAt,
        lastActivityAt: task.lastActivityAt,
        artifacts: snapshot.artifacts?.length ?? 0,
        history: snapshot.history?.length ?? 0,
      }
    })
  }

  /**
   * 取消任务：
   * - 不存在 → 'not-found'；
   * - 已终态 → 'not-cancelable'；
   * - 其余：置取消请求标志、广播 canceled（final），返回 'canceled'。
   *   runner 侧应在安全点检查 canceled 标志提前退出。
   */
  cancel(id: string): 'canceled' | 'not-found' | 'not-cancelable' {
    const task = this.tasks.get(id)
    if (!task) return 'not-found'
    if (task.final) return 'not-cancelable'
    task.requestCancel()
    const status: TaskStatus = { state: 'canceled', timestamp: nowTimestamp() }
    // 状态对象与事件保持一致：下一次 snapshot() 反映 canceled。
    task.tryUpdateStatus('canceled')
    task.emit({
      kind: 'status-update',
      taskId: task.id,
      contextId: task.contextId,
      status,
      final: true,
    })
    return 'canceled'
  }

  /**
   * TTL 回收：
   * - 已完结任务超过 ttl 移除；
   * - 非终态任务超过 ttl 视为卡死：广播 failed(final) 后移除。
   * 返回移除的任务数。
   */
  gc(ttlMs: number): number {
    const now = Date.now()
    let removed = 0
    for (const task of [...this.tasks.values()]) {
      if (now - task.lastActivityAt < ttlMs) continue
      if (!task.final) {
        task.emit({
          kind: 'status-update',
          taskId: task.id,
          contextId: task.contextId,
          status: { state: 'failed', timestamp: nowTimestamp() },
          final: true,
        })
      }
      this.tasks.delete(task.id)
      removed += 1
    }
    return removed
  }

  /** 超过容量上限时淘汰最旧的已完结任务。 */
  private evictIfNeeded(): void {
    if (this.tasks.size <= MAX_TASKS) return
    const finals = this.list().filter((t) => t.final)
    for (const task of finals) {
      if (this.tasks.size <= MAX_TASKS) break
      this.tasks.delete(task.id)
    }
  }
}

/**
 * 把任务包装成 runner 使用的控制器：状态迁移即广播，产物追加即广播。
 * 终态后的任何更新静默忽略（runner 竞态兜底，不抛错）。
 */
export function controllerFor(task: StoredTask): TaskController {
  const controller: TaskController = {
    taskId: task.id,
    contextId: task.contextId,
    get state(): TaskState {
      return task.state
    },
    get final(): boolean {
      return task.final
    },
    get canceled(): boolean {
      return task.canceled
    },
    updateStatus(state: TaskState, message?: A2aMessage): void {
      if (task.final) return
      const status: TaskStatus = { state, ...(message !== undefined ? { message } : {}), timestamp: nowTimestamp() }
      // input-required 视为「本轮流式终点」：事件 final=true 关闭 SSE，
      // 任务本身仍是非终态，可凭 taskId 续答或取消。
      const final = isTerminalState(state) || state === 'input-required'
      task.emit({
        kind: 'status-update',
        taskId: task.id,
        contextId: task.contextId,
        status,
        final,
      })
      // emit 之后统一迁移内部状态，保证事件与快照一致。
      task.tryUpdateStatus(state, message)
    },
    addArtifact(parts, options): Artifact {
      const artifact: Artifact = {
        kind: 'artifact',
        artifactId: randomUUID(),
        ...(options?.name !== undefined ? { name: options.name } : {}),
        ...(options?.description !== undefined ? { description: options.description } : {}),
        parts: [...parts],
      }
      task.appendArtifact(artifact)
      task.emit({
        kind: 'artifact-update',
        taskId: task.id,
        contextId: task.contextId,
        artifact,
        ...(options?.lastChunk !== undefined ? { lastChunk: options.lastChunk } : {}),
      })
      return artifact
    },
    recordHistory(message: A2aMessage): void {
      task.pushHistory(message)
    },
  }
  return controller
}
