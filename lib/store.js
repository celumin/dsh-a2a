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
import { randomUUID } from 'node:crypto';
import { isTerminalState, nowTimestamp } from "./protocol.js";
/** 事件缓冲上限（防超长任务把内存吃爆；够 resubscribe 回放用）。 */
const MAX_BUFFERED_EVENTS = 500;
/** 单任务最大 history 消息条数（stateTransitionHistory 能力对应的上限）。 */
const MAX_HISTORY = 200;
/** 内存中保留的最大任务数（超出时优先淘汰最旧的已完结任务）。 */
const MAX_TASKS = 1000;
export class StoredTask {
    id;
    contextId;
    createdAt;
    status;
    artifacts = [];
    history = [];
    events = [];
    subscribers = new Set();
    canceledFlag = false;
    constructor(contextId) {
        this.id = randomUUID();
        this.contextId = contextId;
        this.createdAt = Date.now();
        this.status = { state: 'submitted', timestamp: nowTimestamp() };
    }
    get state() {
        return this.status.state;
    }
    get final() {
        return isTerminalState(this.status.state);
    }
    get canceled() {
        return this.canceledFlag;
    }
    get lastActivityAt() {
        return Date.parse(this.status.timestamp);
    }
    /** wire 形态快照（tasks/get、message/send 返回值）。 */
    snapshot() {
        return {
            kind: 'task',
            id: this.id,
            contextId: this.contextId,
            status: this.status,
            ...(this.artifacts.length > 0 ? { artifacts: [...this.artifacts] } : {}),
            ...(this.history.length > 0 ? { history: [...this.history] } : {}),
        };
    }
    /** 事件缓冲回放（resubscribe 用）。 */
    bufferedEvents() {
        return [...this.events];
    }
    /** 订阅实时事件；返回退订函数。 */
    subscribe(listener) {
        this.subscribers.add(listener);
        return () => {
            this.subscribers.delete(listener);
        };
    }
    /** 更新状态（非法迁移会被拒绝并返回 false：终态后不允许再迁移）。 */
    tryUpdateStatus(state, message) {
        if (this.final)
            return false;
        this.status = { state, ...(message !== undefined ? { message } : {}), timestamp: nowTimestamp() };
        return true;
    }
    /** 标记取消请求（runner 可感知）；真正的 canceled 状态迁移由 cancel() 驱动。 */
    requestCancel() {
        this.canceledFlag = true;
    }
    appendArtifact(artifact) {
        this.artifacts.push(artifact);
    }
    pushHistory(message) {
        this.history.push(message);
        if (this.history.length > MAX_HISTORY)
            this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    /** 广播事件：写缓冲 + 通知订阅者。 */
    emit(event) {
        this.events.push(event);
        if (this.events.length > MAX_BUFFERED_EVENTS) {
            this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
        }
        for (const listener of [...this.subscribers]) {
            try {
                listener(event);
            }
            catch {
                // 订阅者异常不影响广播。
            }
        }
    }
}
export class TaskStore {
    tasks = new Map();
    create(contextId) {
        const task = new StoredTask(contextId);
        this.tasks.set(task.id, task);
        this.evictIfNeeded();
        return task;
    }
    get(id) {
        return this.tasks.get(id);
    }
    /** 按创建时间列任务（调试用）。 */
    list() {
        return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
    }
    /**
     * 取消任务：
     * - 不存在 → 'not-found'；
     * - 已终态 → 'not-cancelable'；
     * - 其余：置取消请求标志、广播 canceled（final），返回 'canceled'。
     *   runner 侧应在安全点检查 canceled 标志提前退出。
     */
    cancel(id) {
        const task = this.tasks.get(id);
        if (!task)
            return 'not-found';
        if (task.final)
            return 'not-cancelable';
        task.requestCancel();
        const status = { state: 'canceled', timestamp: nowTimestamp() };
        // 状态对象与事件保持一致：下一次 snapshot() 反映 canceled。
        task.tryUpdateStatus('canceled');
        task.emit({
            kind: 'status-update',
            taskId: task.id,
            contextId: task.contextId,
            status,
            final: true,
        });
        return 'canceled';
    }
    /**
     * TTL 回收：
     * - 已完结任务超过 ttl 移除；
     * - 非终态任务超过 ttl 视为卡死：广播 failed(final) 后移除。
     * 返回移除的任务数。
     */
    gc(ttlMs) {
        const now = Date.now();
        let removed = 0;
        for (const task of [...this.tasks.values()]) {
            if (now - task.lastActivityAt < ttlMs)
                continue;
            if (!task.final) {
                task.emit({
                    kind: 'status-update',
                    taskId: task.id,
                    contextId: task.contextId,
                    status: { state: 'failed', timestamp: nowTimestamp() },
                    final: true,
                });
            }
            this.tasks.delete(task.id);
            removed += 1;
        }
        return removed;
    }
    /** 超过容量上限时淘汰最旧的已完结任务。 */
    evictIfNeeded() {
        if (this.tasks.size <= MAX_TASKS)
            return;
        const finals = this.list().filter((t) => t.final);
        for (const task of finals) {
            if (this.tasks.size <= MAX_TASKS)
                break;
            this.tasks.delete(task.id);
        }
    }
}
/**
 * 把任务包装成 runner 使用的控制器：状态迁移即广播，产物追加即广播。
 * 终态后的任何更新静默忽略（runner 竞态兜底，不抛错）。
 */
export function controllerFor(task) {
    const controller = {
        taskId: task.id,
        contextId: task.contextId,
        get state() {
            return task.state;
        },
        get final() {
            return task.final;
        },
        get canceled() {
            return task.canceled;
        },
        updateStatus(state, message) {
            if (task.final)
                return;
            const status = { state, ...(message !== undefined ? { message } : {}), timestamp: nowTimestamp() };
            // input-required 视为「本轮流式终点」：事件 final=true 关闭 SSE，
            // 任务本身仍是非终态，可凭 taskId 续答或取消。
            const final = isTerminalState(state) || state === 'input-required';
            task.emit({
                kind: 'status-update',
                taskId: task.id,
                contextId: task.contextId,
                status,
                final,
            });
            // emit 之后统一迁移内部状态，保证事件与快照一致。
            task.tryUpdateStatus(state, message);
        },
        addArtifact(parts, options) {
            const artifact = {
                kind: 'artifact',
                artifactId: randomUUID(),
                ...(options?.name !== undefined ? { name: options.name } : {}),
                ...(options?.description !== undefined ? { description: options.description } : {}),
                parts: [...parts],
            };
            task.appendArtifact(artifact);
            task.emit({
                kind: 'artifact-update',
                taskId: task.id,
                contextId: task.contextId,
                artifact,
                ...(options?.lastChunk !== undefined ? { lastChunk: options.lastChunk } : {}),
            });
            return artifact;
        },
        recordHistory(message) {
            task.pushHistory(message);
        },
    };
    return controller;
}
//# sourceMappingURL=store.js.map