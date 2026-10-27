/**
 * A2A 版本协商与响应归一（v1.0 ProtoJSON ↔ v0.3 内部模型）。
 *
 * 设计依据：docs/superpowers/specs/2026-10-24-round2.5-protocol-alignment-design.md §3.4–§3.6。
 * 本模块零依赖，全部为纯函数，便于单测。
 *
 * @module dsh-a2a/compat
 */
import type { A2aMessage, A2aTask, AgentCard, TaskState } from './protocol.ts';
/** 线上协议版本（只有大版本差异会改变方法名与报文形状）。 */
export type WireVersion = 'v1.0' | 'v0.3';
/** 方法表：v1.0 用 PascalCase，v0.3 用 `resource/action`。 */
export interface MethodTable {
    readonly send: string;
    readonly stream: string;
    readonly getTask: string;
    readonly cancel: string;
}
export declare function methodsFor(version: WireVersion): MethodTable;
/** 请求头 `X-A2A-Version` 的值：固定"主.次"，不写补丁号。 */
export declare function versionHeader(version: WireVersion): '1.0' | '0.3';
/**
 * 从卡片读版本声明：JSONRPC 接口条目的 `protocolVersion` 优先，其次
 * `protocolVersions[]` 首个，再次顶层 `protocolVersion`。
 * 无可用声明（缺失、`2.0`、无法解析）→ undefined。
 */
export declare function versionOf(card: AgentCard): WireVersion | undefined;
/**
 * 协商结果：卡片缺失或没有可用声明都落到 v0.3（后者是 §3.4.2 的默认版本，
 * 前者是 §3.4.3 的降级）。两条规则触发条件不同，但结论一致。
 */
export declare function negotiateVersion(card: AgentCard | undefined): WireVersion;
/**
 * 状态归一：v1.0 的 `TASK_STATE_*` → 内部小写值；`UNSPECIFIED` 与任何不认识的
 * 值映射为 `unknown`，并把原值留在 `rawState`（不当作终态）。
 */
export declare function normalizeState(raw: unknown): {
    state: TaskState;
    rawState?: string;
};
/**
 * part 的类型：有 `kind` 用它；v1.0 的 ProtoJSON 没有 `kind`，按成员名判别
 * （`text` / `data` / `url`|`file`）。
 */
export declare function partKind(part: Record<string, unknown>): 'text' | 'data' | 'file' | undefined;
/**
 * 内部 message → 该 wire 版本的 message 对象（JSON-RPC `params.message`）。
 *
 * - v0.3：与 0.5.0 的构造逐字段相同（`kind:'message'`、role 小写、part 带 `kind`）。
 * - v1.0：role 用 `ROLE_*`，message 与 part 都去掉 `kind`，part 用成员形态；
 *   file part 只写 `{file}`，不产生 `url`。
 * 两版都随行 `messageId` / `metadata` / `contextId` / `taskId`。
 */
export declare function wireMessageFor(version: WireVersion, message: A2aMessage): Record<string, unknown>;
/** v0.3 裸 Task / v1.0 `{ task }` → 内部 Task（状态与 parts 归一）。 */
export declare function normalizeTask(raw: unknown): A2aTask;
/** `GetTask` / `CancelTask` 的结果：裸 Task 或 `{ task }`。 */
export declare function normalizeTaskResult(raw: unknown): A2aTask;
/**
 * `SendMessage` 的结果：`{ task }` / `{ msg }` / 裸 Task / 裸 Message。
 * Message 形态包成完结 Task（沿用旧行为），保证上层只处理 Task。
 */
export declare function normalizeSendResult(raw: unknown, contextId: string): A2aTask;
/**
 * 网关错误码 → 是否鼓励重试。`-32005`（环路）/ `-32006`（注入被拒）不可重试；
 * `-32003`（上游不可用）可重试；其他不表态（两个字段都省略）。
 */
export declare function classifyError(code: number): {
    retryable?: boolean;
};
//# sourceMappingURL=compat.d.ts.map