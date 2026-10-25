/**
 * 出站端点解析：target 归一、卡片候选、RPC 端点授权。
 *
 * 本模块零依赖（只用全局 `URL`），可被 client / tools / 测试共用。
 * 设计依据：docs/superpowers/specs/2026-10-24-round2.5-protocol-alignment-design.md §3.1–§3.3。
 *
 * @module dsh-a2a/endpoint
 */
const WELL_KNOWN_SUFFIX = /\/(?:\.well-known)\/(?:agent-card|agent)\.json$/;
/**
 * 把用户给的 target 归一为 `{origin, path}`。
 * - 含 query / fragment → 报错（JSON-RPC 端点不应带查询串）。
 * - 以 `/.well-known/agent[-card].json` 结尾 → 识别为卡片 URL，剥离后缀得到路径基址。
 */
export function normalizeTarget(baseUrl) {
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
        throw new Error(`invalid target url: ${baseUrl}`);
    }
    if (url.search !== '' || url.hash !== '') {
        throw new Error(`target must not contain query or fragment: ${baseUrl}`);
    }
    const match = WELL_KNOWN_SUFFIX.exec(url.pathname);
    if (match !== null) {
        const basePath = url.pathname.slice(0, match.index).replace(/\/+$/, '');
        return { origin: url.origin, path: basePath, givenCardUrl: `${url.origin}${url.pathname}` };
    }
    return { origin: url.origin, path: url.pathname.replace(/\/+$/, '') };
}
/**
 * 卡片发现候选（最多 2 条，按序）：
 * 1. 用户给的卡片 URL（若有），否则 `{base}/.well-known/agent-card.json`；
 * 2. `{base}/.well-known/agent.json`（0.2 兼容）。
 *
 * 不生成 origin 根候选：路径基址的 origin 根可能挂着无关应用，带 Bearer 去打会泄漏 token。
 */
export function cardCandidates(target) {
    const base = `${target.origin}${target.path}`;
    const card = `${base}/.well-known/agent-card.json`;
    const legacy = `${base}/.well-known/agent.json`;
    const list = target.givenCardUrl !== undefined
        ? [target.givenCardUrl, target.givenCardUrl.endsWith('/agent.json') ? card : legacy]
        : [card, legacy];
    return Array.from(new Set(list));
}
/** 输入路径（不加尾斜杠；根为 `/`）。 */
export function inputEndpoint(target) {
    return target.path === '' ? `${target.origin}/` : `${target.origin}${target.path}`;
}
/**
 * 从卡片解析 RPC 服务端点：JSONRPC 接口条目优先，其次顶层 `url`；相对 URL 以卡片 URL 为基准。
 * 解析不出时返回 undefined（调用方回退输入路径）。
 */
export function resolveCardEndpoint(card, cardUrl) {
    const interfaces = card.supportedInterfaces ?? [];
    const jsonrpc = interfaces.find((entry) => String(entry.protocolBinding ?? '').toUpperCase() === 'JSONRPC');
    const chosen = jsonrpc?.url !== undefined && jsonrpc.url !== '' ? jsonrpc.url : card.url;
    if (chosen === undefined || chosen === '')
        return undefined;
    try {
        return trimUrl(new URL(chosen, cardUrl).toString());
    }
    catch {
        return undefined;
    }
}
/**
 * 端点授权：同源端点还要过 `allowPatterns` 的路径作用域；跨源端点必须命中
 * `cardEndpointPatterns`（完整 URL 前缀）。不通过一律回退输入路径，不发送 Bearer 到被弃用的端点。
 */
export function decideEndpoint(input) {
    const fallback = { url: inputEndpoint(input.target), source: 'input' };
    const endpoint = input.cardEndpoint;
    if (endpoint === undefined || endpoint === '')
        return fallback;
    let parsed;
    try {
        parsed = new URL(endpoint);
    }
    catch {
        return fallback;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return fallback;
    const trimmed = trimUrl(parsed.toString());
    if (parsed.origin === input.target.origin) {
        if (!matchesAllowlist(input.allowPatterns, trimmed)) {
            return { ...fallback, warn: 'outside-allowlist' };
        }
        return { url: trimmed, source: 'card' };
    }
    if (matchesCardEndpointAllowlist(input.cardEndpointPatterns, trimmed)) {
        return { url: trimmed, source: 'card', warn: 'cross-origin-allowed' };
    }
    return { ...fallback, warn: 'cross-origin-ignored' };
}
/**
 * 跨源卡片端点的白名单：**完整 URL 前缀**，scheme/host/port 精确，path 按边界匹配。
 * `*` 不生效——跨源放行必须是运维的显式选择。
 */
export function matchesCardEndpointAllowlist(patterns, target) {
    let url;
    try {
        url = new URL(target);
    }
    catch {
        return false;
    }
    for (const pattern of patterns) {
        if (pattern === '' || pattern === '*')
            continue;
        let parsed;
        try {
            parsed = new URL(pattern);
        }
        catch {
            continue;
        }
        if (parsed.search !== '' || parsed.hash !== '')
            continue;
        if (parsed.protocol !== url.protocol)
            continue;
        if (parsed.hostname !== url.hostname)
            continue;
        if (parsed.port !== url.port)
            continue;
        const base = parsed.pathname.replace(/\/+$/, '');
        const path = url.pathname.replace(/\/+$/, '');
        if (base === '' || base === '/' || path === base || path.startsWith(`${base}/`))
            return true;
    }
    return false;
}
/**
 * 目标白名单（`clientAllowPatterns`）：
 * - `'*'` 全放开；
 * - URL 形式（`https://a2a.example.com/`、`http://10.0.0.5:7310/`）按
 *   host + port + 路径前缀匹配；hostname 支持 `*.example.com` 通配子域；
 * - `'*:7310'` 任意主机的指定端口。
 *
 * 语义与历史实现保持一致（tests/smoke.mjs 有回归用例）。
 */
export function matchesAllowlist(patterns, target) {
    let url;
    try {
        url = new URL(target);
    }
    catch {
        return false;
    }
    const targetFull = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    for (const pattern of patterns) {
        if (pattern === '*')
            return true;
        // URL 形式：按 host/port/路径前缀精确匹配。
        let parsed;
        try {
            parsed = new URL(pattern);
        }
        catch {
            parsed = undefined;
        }
        if (parsed !== undefined) {
            const hostOk = parsed.hostname.startsWith('*.')
                ? (url.hostname === parsed.hostname.slice(2) || url.hostname.endsWith(`.${parsed.hostname.slice(2)}`))
                : parsed.hostname === url.hostname;
            const portOk = parsed.port === url.port;
            const pathOk = parsed.pathname === '/' || url.pathname.startsWith(parsed.pathname.replace(/\/+$/, ''));
            if (hostOk && portOk && pathOk)
                return true;
            continue;
        }
        if (pattern.startsWith('*.')) {
            // *.example.com 允许任意子域（含裸域）。
            const domain = pattern.slice(2);
            if (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
                return true;
            continue;
        }
        if (pattern.startsWith('*')) {
            // *:7310 → 任意主机的指定端口。
            if (url.port !== '' && pattern === `*:${url.port}`)
                return true;
            continue;
        }
        const normalized = pattern.replace(/\/+$/, '');
        if (url.origin === normalized || targetFull === normalized)
            return true;
    }
    return false;
}
function trimUrl(raw) {
    const url = new URL(raw);
    const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
}
//# sourceMappingURL=endpoint.js.map