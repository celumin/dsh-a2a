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
import { randomUUID } from 'node:crypto';
// ── 常量 ────────────────────────────────────────────────────────────────
/** 本实现宣告/应答的 A2A 协议版本。 */
export const PROTOCOL_VERSION = '0.3.0';
/** Agent Card 的 0.3.x 标准路径。 */
export const CARD_PATH = '/.well-known/agent-card.json';
/** Agent Card 的 0.2.x 旧路径（同时保留，兼容旧客户端）。 */
export const CARD_LEGACY_PATH = '/.well-known/agent.json';
/** 终态集合：再收到任何状态迁移都是协议错误。 */
export const TERMINAL_STATES = [
    'completed',
    'failed',
    'canceled',
    'rejected',
];
export function buildAgentCard(options) {
    const card = {
        name: options.name,
        ...(options.description !== undefined ? { description: options.description } : {}),
        url: options.url,
        version: options.version,
        protocolVersion: PROTOCOL_VERSION,
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
    };
    return card;
}
/** JSON-RPC 标准错误码。 */
export const RPC_ERRORS = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
};
/** A2A 规范定义的服务端错误码。 */
export const A2A_ERRORS = {
    TASK_NOT_FOUND: -32001,
    TASK_NOT_CANCELABLE: -32002,
    PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
    UNSUPPORTED_OPERATION: -32004,
    CONTENT_TYPE_NOT_SUPPORTED: -32005,
};
export function jsonrpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}
export function jsonrpcError(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
/** 解析并校验单个（非批量）JSON-RPC 请求；失败返回错误字符串。 */
export function parseJsonRpcRequest(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: '请求必须是单个 JSON-RPC 对象（A2A 不支持批量请求）' };
    }
    const obj = raw;
    if (obj.jsonrpc !== '2.0') {
        return { ok: false, error: 'jsonrpc 字段必须为 "2.0"' };
    }
    if (typeof obj.method !== 'string' || obj.method.length === 0) {
        return { ok: false, error: 'method 必须是非空字符串' };
    }
    const id = obj.id;
    if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
        return { ok: false, error: 'id 必须是 string / number / null' };
    }
    return {
        ok: true,
        request: {
            jsonrpc: '2.0',
            id: (id ?? null),
            method: obj.method,
            ...(obj.params !== undefined ? { params: obj.params } : {}),
        },
    };
}
/**
 * v0.3 / v1.0 两种 role 形态归一：v1.0 用 ROLE_USER / ROLE_AGENT，v0.3 已是
 * 小写；其它值（含 ROLE_BOT）返回 undefined 交给调用方报 -32602。
 */
function normalizeRole(raw) {
    if (raw === 'user' || raw === 'ROLE_USER')
        return 'user';
    if (raw === 'agent' || raw === 'ROLE_AGENT')
        return 'agent';
    return undefined;
}
/**
 * v0.3 / v1.0 两种 part 形态归一（spec §3.3）：有 kind 走 v0.3 分支；无 kind
 * 时按成员判别（text:string / data:object / file:{uri|bytes}）。判不出或
 * 形态不合法返回 undefined，调用方保持原有的 -32602 文案。
 */
function normalizePart(raw) {
    const part = raw;
    const kind = part.kind ?? (typeof part.text === 'string'
        ? 'text'
        : part.data !== null && typeof part.data === 'object' && !Array.isArray(part.data)
            ? 'data'
            : part.file !== null && typeof part.file === 'object'
                ? 'file'
                : undefined);
    if (kind === 'text' && typeof part.text === 'string') {
        return { kind: 'text', text: part.text };
    }
    if (kind === 'data' && part.data !== null && typeof part.data === 'object' && !Array.isArray(part.data)) {
        return { kind: 'data', data: part.data };
    }
    if (kind === 'file' && part.file !== null && typeof part.file === 'object'
        && (typeof part.file.uri === 'string'
            || typeof part.file.bytes === 'string')) {
        return { kind: 'file', file: part.file };
    }
    return undefined;
}
/**
 * 解析 message/send、message/stream 的 params；补齐缺失的 messageId /
 * contextId（服务端生成），并校验 parts 形态。失败返回给客户端的错误文本。
 */
export function parseMessageSendParams(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'params 必须是对象' };
    }
    const obj = raw;
    const messageRaw = obj.message;
    if (messageRaw === null || typeof messageRaw !== 'object') {
        return { ok: false, error: 'params.message 必须是对象' };
    }
    const m = messageRaw;
    const role = normalizeRole(m.role);
    if (role === undefined) {
        return { ok: false, error: 'message.role 必须是 "user" 或 "agent"' };
    }
    if (!Array.isArray(m.parts) || m.parts.length === 0) {
        return { ok: false, error: 'message.parts 必须是非空数组' };
    }
    const parts = [];
    for (const p of m.parts) {
        if (p === null || typeof p !== 'object') {
            return { ok: false, error: 'message.parts[] 的每一项必须是对象' };
        }
        const part = normalizePart(p);
        if (part === undefined) {
            return { ok: false, error: 'message.parts[] 含不支持的 part（kind 必须是 text/data/file 且形态合法）' };
        }
        parts.push(part);
    }
    const messageId = typeof m.messageId === 'string' && m.messageId.length > 0 ? m.messageId : randomUUID();
    const contextId = typeof m.contextId === 'string' && m.contextId.length > 0 ? m.contextId : undefined;
    const taskId = typeof m.taskId === 'string' && m.taskId.length > 0 ? m.taskId : undefined;
    const metadata = m.metadata !== null && typeof m.metadata === 'object' && !Array.isArray(m.metadata)
        ? m.metadata
        : undefined;
    const message = {
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
    };
    return { ok: true, params: { message, ...(obj.configuration !== undefined ? { configuration: obj.configuration } : {}) } };
}
// ── 小工具 ─────────────────────────────────────────────────────────────
/** 提取消息中的全部文本（text part 顺序拼接；无文本 part 返回空串）。 */
export function extractText(parts) {
    let out = '';
    for (const p of parts) {
        if (p.kind === 'text')
            out += p.text;
    }
    return out;
}
/** data/file part 的简要描述（用于日志与诊断，不参与正文）。 */
export function describeNonTextParts(parts) {
    const out = [];
    for (const p of parts) {
        if (p.kind === 'data')
            out.push('[data part]');
        else if (p.kind === 'file')
            out.push(p.file.name ? `[file: ${p.file.name}]` : `[file: ${p.file.uri ?? 'inline'}]`);
    }
    return out;
}
/** 当前时间的 RFC 3339 时间戳。 */
export function nowTimestamp() {
    return new Date().toISOString();
}
/** 终态判断。 */
export function isTerminalState(state) {
    return TERMINAL_STATES.includes(state);
}
//# sourceMappingURL=protocol.js.map