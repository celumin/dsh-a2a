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
import type { A2aTask, AgentCard, TaskEvent } from './protocol.ts';
import { type EndpointDecision } from './endpoint.ts';
export { matchesAllowlist } from './endpoint.ts';
export interface A2aClientOptions {
    /** 远端 agent 基地址（Agent Card 所在站点的根，或直接给 JSON-RPC 地址）。 */
    baseUrl: string;
    /** Bearer 令牌（远端启用鉴权时）。 */
    bearerToken?: string;
    /** 单次 HTTP 请求 / 轮询总超时（ms，默认 120s）。 */
    timeoutMs?: number;
    /**
     * 本端 peer 名：写入出站消息 `metadata.from`，供对端把回话路由回来。
     * 未配置（或为空串）时不携带 `from`，回退为旧行为。
     */
    peerName?: string;
    /** 目标白名单（同一份也用于卡片端点的路径作用域）。默认 `['*']`。 */
    allowPatterns?: readonly string[];
    /** 跨源卡片端点的白名单：完整 URL 前缀，默认 `[]`（全拒），`*` 不生效。 */
    cardEndpointPatterns?: readonly string[];
    /** 诊断日志（WARN 只含 origin 与原因码，不含 path/query）。 */
    logger?: (level: 'warn' | 'info', message: string, fields?: Record<string, string>) => void;
    /** 注入 fetch（测试用）；默认全局 fetch。 */
    fetchImpl?: typeof fetch;
}
/**
 * 出站消息的 `metadata.kind`：
 * - `message` 仅入库/通知（默认，兼容旧行为）；
 * - `request` 触发对端处理并等待结果；
 * - `result` 回执/结果投递。
 */
export type A2aOutboundKind = 'message' | 'request' | 'result';
/** JSON-RPC 远端返回的错误。 */
export declare class A2aRpcError extends Error {
    readonly code: number;
    readonly data?: unknown | undefined;
    readonly method?: string | undefined;
    constructor(code: number, message: string, data?: unknown | undefined, method?: string | undefined);
}
/** 轮询到总预算仍未结束：携带最后状态，便于模型判断是 agent 卡住还是客户端不认识状态。 */
export declare class A2aTimeoutError extends A2aRpcError {
    constructor(message: string);
}
export declare class A2aClient {
    private readonly options;
    private target;
    private cardState;
    constructor(options: A2aClientOptions);
    /**
     * 构造出站消息的 metadata：始终带 `kind`（默认 message），
     * 配置了本端 peerName 时附带 `from`（对端据此路由回话）。
     */
    private messageMetadata;
    private rpcHeaders;
    /**
     * 是否允许把 Bearer 发往该端点：卡片端点已经过 `decideEndpoint` 授权
     * （同源过路径作用域、跨源过 `clientCardEndpointPatterns`）；回退端点则要求
     * 仍在目标白名单内。
     */
    private endpointAuthorized;
    /** 一次调用的总预算：发现 / RPC / 轮询共用同一个 deadline。 */
    private deadline;
    /**
     * 发一次 JSON-RPC：端点与方法由卡片协商结果决定；`deadline` 由调用方传入，
     * 让发现 / 调用 / 轮询共享同一份预算。
     */
    private rpc;
    private targetInfo;
    private fetchFn;
    private warn;
    /** 卡片 GET 的头：不带版本头；`Authorization` 仅在候选落在白名单作用域内时携带。 */
    private cardHeaders;
    /**
     * 卡片发现 + 端点决策（实例内缓存，不抛错）。
     * - 候选按 `cardCandidates` 顺序尝试，不跟随重定向；
     * - 每个候选的超时 `min(5s, 剩余预算)`；
     * - 全部失败 → 返回 `source: 'input'` 的决策，并记一条不含 path 的 WARN。
     */
    ensureCard(forceRefresh?: boolean): Promise<{
        card?: AgentCard;
        decision: EndpointDecision;
    }>;
    /** 端点决策（发现失败时返回输入路径，不抛错）。 */
    endpoint(): Promise<EndpointDecision>;
    /** 拉取远端 Agent Card（带实例缓存）；全部候选失败时抛错。 */
    card(forceRefresh?: boolean): Promise<AgentCard>;
    /**
     * message/send：同步拿终态。
     * - 对端直接返回完结任务 → 即刻返回；
     * - 对端返回未完结任务 → tasks/get 轮询（pollMs 间隔）直到终态/超时。
     * - 对端返回裸 Message（非任务型 agent）→ 包装成 completed Task 形态。
     */
    send(text: string, options?: {
        contextId?: string;
        pollMs?: number;
        onEvent?: (event: TaskEvent) => void;
        /** 出站 metadata.kind（默认 message）。 */
        kind?: A2aOutboundKind;
    }): Promise<A2aTask>;
    /**
     * message/stream：SSE 消费直到 final 事件；返回收到的全部事件。
     * 对端不支持流式（HTTP 非 SSE）时回退 send()。
     */
    sendStream(text: string, onEvent: (event: TaskEvent) => void, options?: {
        contextId?: string;
        /** 出站 metadata.kind（默认 message）。 */
        kind?: A2aOutboundKind;
    }): Promise<TaskEvent[]>;
    getTask(taskId: string, deadline?: number): Promise<A2aTask>;
    cancelTask(taskId: string): Promise<A2aTask>;
    /** 便捷：send() + 提取 artifact 文本（工具层使用）。 */
    sendForText(text: string, options?: {
        contextId?: string;
        pollMs?: number;
        preferStream?: boolean;
        onEvent?: (event: TaskEvent) => void;
        /** 出站 metadata.kind（默认 message）。 */
        kind?: A2aOutboundKind;
    }): Promise<{
        task: A2aTask;
        text: string;
    }>;
}
//# sourceMappingURL=client.d.ts.map