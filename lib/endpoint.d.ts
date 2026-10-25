/**
 * 出站端点解析：target 归一、卡片候选、RPC 端点授权。
 *
 * 本模块零依赖（只用全局 `URL`），可被 client / tools / 测试共用。
 * 设计依据：docs/superpowers/specs/2026-10-24-round2.5-protocol-alignment-design.md §3.1–§3.3。
 *
 * @module dsh-a2a/endpoint
 */
import type { AgentCard } from './protocol.ts';
/** 归一后的 target：站点源 + 路径基址（尾斜杠已去）。 */
export interface NormalizedTarget {
    readonly origin: string;
    readonly path: string;
    /** 用户直接给了卡片 URL 时保留原样，作为第一候选。 */
    readonly givenCardUrl?: string;
}
/** 卡片端点被弃用的原因（只用于 WARN，不含 URL）。 */
export type EndpointWarning = 'cross-origin-ignored' | 'outside-allowlist' | 'cross-origin-allowed';
export interface EndpointDecision {
    readonly url: string;
    readonly source: 'card' | 'input';
    readonly warn?: EndpointWarning;
}
/**
 * 把用户给的 target 归一为 `{origin, path}`。
 * - 含 query / fragment → 报错（JSON-RPC 端点不应带查询串）。
 * - 以 `/.well-known/agent[-card].json` 结尾 → 识别为卡片 URL，剥离后缀得到路径基址。
 */
export declare function normalizeTarget(baseUrl: string): NormalizedTarget;
/**
 * 卡片发现候选（最多 2 条，按序）：
 * 1. 用户给的卡片 URL（若有），否则 `{base}/.well-known/agent-card.json`；
 * 2. `{base}/.well-known/agent.json`（0.2 兼容）。
 *
 * 不生成 origin 根候选：路径基址的 origin 根可能挂着无关应用，带 Bearer 去打会泄漏 token。
 */
export declare function cardCandidates(target: NormalizedTarget): string[];
/** 输入路径（不加尾斜杠；根为 `/`）。 */
export declare function inputEndpoint(target: NormalizedTarget): string;
/**
 * 从卡片解析 RPC 服务端点：JSONRPC 接口条目优先，其次顶层 `url`；相对 URL 以卡片 URL 为基准。
 * 解析不出时返回 undefined（调用方回退输入路径）。
 */
export declare function resolveCardEndpoint(card: AgentCard, cardUrl: string): string | undefined;
/**
 * 端点授权：同源端点还要过 `allowPatterns` 的路径作用域；跨源端点必须命中
 * `cardEndpointPatterns`（完整 URL 前缀）。不通过一律回退输入路径，不发送 Bearer 到被弃用的端点。
 */
export declare function decideEndpoint(input: {
    readonly target: NormalizedTarget;
    readonly cardEndpoint?: string;
    readonly allowPatterns: readonly string[];
    readonly cardEndpointPatterns: readonly string[];
}): EndpointDecision;
/**
 * 跨源卡片端点的白名单：**完整 URL 前缀**，scheme/host/port 精确，path 按边界匹配。
 * `*` 不生效——跨源放行必须是运维的显式选择。
 */
export declare function matchesCardEndpointAllowlist(patterns: readonly string[], target: string): boolean;
/**
 * 目标白名单（`clientAllowPatterns`）：
 * - `'*'` 全放开；
 * - URL 形式（`https://a2a.example.com/`、`http://10.0.0.5:7310/`）按
 *   host + port + 路径前缀匹配；hostname 支持 `*.example.com` 通配子域；
 * - `'*:7310'` 任意主机的指定端口。
 *
 * 语义与历史实现保持一致（tests/smoke.mjs 有回归用例）。
 */
export declare function matchesAllowlist(patterns: readonly string[], target: string): boolean;
//# sourceMappingURL=endpoint.d.ts.map