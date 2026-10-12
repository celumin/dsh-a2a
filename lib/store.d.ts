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
import type { A2aMessage, A2aTask, Artifact, Part, TaskEvent, TaskState } from './protocol.ts';
export interface TaskController {
    readonly taskId: string;
    readonly contextId: string;
    /** 当前状态（只读快照）。 */
    readonly state: TaskState;
    readonly final: boolean;
    /** 是否已被客户端取消（runner 应在安全点检查并尽快返回）。 */
    readonly canceled: boolean;
    /** 更新任务状态并广播 status-update 事件；终态自动带 final=true。 */
    updateStatus(state: TaskState, message?: A2aMessage): void;
    /** 追加产物并广播 artifact-update 事件；返回带 id 的 Artifact。 */
    addArtifact(parts: readonly Part[], options?: {
        name?: string;
        description?: string;
        lastChunk?: boolean;
    }): Artifact;
    /** 把一条消息记入任务 history（user/agent 对话留痕）。 */
    recordHistory(message: A2aMessage): void;
}
export declare class StoredTask {
    readonly id: string;
    readonly contextId: string;
    readonly createdAt: number;
    private status;
    private artifacts;
    private history;
    private events;
    private subscribers;
    private canceledFlag;
    constructor(contextId: string);
    get state(): TaskState;
    get final(): boolean;
    get canceled(): boolean;
    get lastActivityAt(): number;
    /** wire 形态快照（tasks/get、message/send 返回值）。 */
    snapshot(): A2aTask;
    /** 事件缓冲回放（resubscribe 用）。 */
    bufferedEvents(): readonly TaskEvent[];
    /** 订阅实时事件；返回退订函数。 */
    subscribe(listener: (event: TaskEvent) => void): () => void;
    /** 更新状态（非法迁移会被拒绝并返回 false：终态后不允许再迁移）。 */
    tryUpdateStatus(state: TaskState, message?: A2aMessage): boolean;
    /** 标记取消请求（runner 可感知）；真正的 canceled 状态迁移由 cancel() 驱动。 */
    requestCancel(): void;
    appendArtifact(artifact: Artifact): void;
    pushHistory(message: A2aMessage): void;
    /** 广播事件：写缓冲 + 通知订阅者。 */
    emit(event: TaskEvent): void;
}
export declare class TaskStore {
    private tasks;
    create(contextId: string): StoredTask;
    get(id: string): StoredTask | undefined;
    /** 按创建时间列任务（调试用）。 */
    list(): StoredTask[];
    /**
     * 取消任务：
     * - 不存在 → 'not-found'；
     * - 已终态 → 'not-cancelable'；
     * - 其余：置取消请求标志、广播 canceled（final），返回 'canceled'。
     *   runner 侧应在安全点检查 canceled 标志提前退出。
     */
    cancel(id: string): 'canceled' | 'not-found' | 'not-cancelable';
    /**
     * TTL 回收：
     * - 已完结任务超过 ttl 移除；
     * - 非终态任务超过 ttl 视为卡死：广播 failed(final) 后移除。
     * 返回移除的任务数。
     */
    gc(ttlMs: number): number;
    /** 超过容量上限时淘汰最旧的已完结任务。 */
    private evictIfNeeded;
}
/**
 * 把任务包装成 runner 使用的控制器：状态迁移即广播，产物追加即广播。
 * 终态后的任何更新静默忽略（runner 竞态兜底，不抛错）。
 */
export declare function controllerFor(task: StoredTask): TaskController;
//# sourceMappingURL=store.d.ts.map