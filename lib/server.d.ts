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
import type { A2aMessage, AgentCard } from './protocol.ts';
import type { TaskController } from './store.ts';
/**
 * JSON-RPC 路由真值表（0.6.0 spec §3.3）：v0.3 名字与 v1.0 名字共用同一
 * handler；`v1` 决定出站包装形状，由 `wireVersionFor` 派生（不手写布尔）。
 * v0.3 的 push `/list` `/delete` **刻意不在表里**——它们从未实现，今天走
 * default → -32601，加进来会变成 -32003。
 * 导出是为了让测试枚举真值，不是公开 API。
 * @internal
 */
export interface RpcRoute {
    readonly handler: 'send' | 'getTask' | 'cancel' | 'pushConfig';
    readonly v1: boolean;
}
/** @internal 测试据此枚举方法名真值，生产分发也用它。 */
export declare const RPC_ROUTES: Readonly<Record<string, RpcRoute>>;
/** 任务 runner 入参：controller 驱动状态机，message 为本轮用户消息。 */
export interface RunnerInput {
    readonly controller: TaskController;
    readonly message: A2aMessage;
    /** 本任务已积累的全部消息（含本次 user 消息，按时间序）。 */
    readonly history: readonly A2aMessage[];
}
/** 任务执行器：实现方负责调用 controller 推进状态并产出 artifact。 */
export interface A2aRunner {
    run(input: RunnerInput): Promise<void>;
}
/** 最小日志接口（cordis logger 满足之；测试可用静默实现）。 */
export interface A2aLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
export declare const silentLogger: A2aLogger;
export interface A2aServerOptions {
    host: string;
    port: number;
    /** 写入 Agent Card 的绝对 URL（公网部署时与监听地址不同）。 */
    publicUrl: string;
    card: AgentCard;
    runner: A2aRunner;
    logger?: A2aLogger;
    /** Bearer 令牌；不配置则不鉴权。 */
    bearerToken?: string;
    /** 单轮执行上限（ms）；默认 10 分钟。 */
    turnTimeoutMs?: number;
    /** 已完结任务保留时长（ms）；默认 1 小时。 */
    taskTtlMs?: number;
    /** 运维面板展示的运行模式（agent/llm/echo）；仅用于 /admin/status 展示。 */
    mode?: string;
}
export declare class A2aServer {
    private readonly options;
    private readonly store;
    private readonly http;
    private readonly logger;
    private readonly turnTimeoutMs;
    private readonly taskTtlMs;
    private readonly sseSessions;
    private gcTimer;
    private started;
    constructor(options: A2aServerOptions);
    /** 实际监听端口（port=0 时为系统分配值）。 */
    get address(): string;
    start(): Promise<void>;
    stop(): Promise<void>;
    private handle;
    /** POST 目标路径：'/' 以及 publicUrl 指定的路径（公网反代常见 /a2a 前缀）。 */
    private isRpcPath;
    private setCommonHeaders;
    private corsHeaders;
    private serveCard;
    /** /admin/status 与 /admin/tasks：运维面板数据源（Bearer 门禁同 RPC）。 */
    private serveAdmin;
    private handleRpc;
    private checkAuth;
    private readBody;
    /** 非流式方法的统一分发。 */
    private dispatch;
    private handleSend;
    /**
     * 解析/创建任务：
     * - 无 taskId：新任务（缺省 contextId 时生成）；
     * - 有 taskId：必须是存在的 input-required 任务（多轮续答）；
     *   否则 TaskNotFound / UnsupportedOperation。
     */
    private prepareTask;
    /** 执行一轮：working → runner → 补终态；覆盖取消/超时/异常。 */
    private executeTurn;
    /** 造一条 role=agent 的状态说明消息（放入 status.message，供客户端展示）。 */
    private agentNote;
    private handleGetTask;
    private handleCancel;
    /**
     * 任务 id 参数：A2A 规范（0.3）用 `params.id`，部分客户端与本插件旧约定
     * 用 `params.taskId`——两者都接受，优先规范写法。
     */
    private taskIdParam;
    private stringParam;
    private handleStream;
    private handleResubscribe;
    private openSse;
}
//# sourceMappingURL=server.d.ts.map