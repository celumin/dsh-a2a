/**
 * A2A 版本协商与响应归一（v1.0 ProtoJSON ↔ v0.3 内部模型）。
 *
 * 设计依据：docs/superpowers/specs/2026-10-24-round2.5-protocol-alignment-design.md §3.4–§3.6。
 * 本模块零依赖，全部为纯函数，便于单测。
 *
 * @module dsh-a2a/compat
 */
const METHODS = {
    'v1.0': { send: 'SendMessage', stream: 'SendStreamingMessage', getTask: 'GetTask', cancel: 'CancelTask' },
    'v0.3': { send: 'message/send', stream: 'message/stream', getTask: 'tasks/get', cancel: 'tasks/cancel' },
};
export function methodsFor(version) {
    return METHODS[version];
}
/** 请求头 `X-A2A-Version` 的值：固定"主.次"，不写补丁号。 */
export function versionHeader(version) {
    return version === 'v1.0' ? '1.0' : '0.3';
}
/**
 * 从卡片读版本声明：JSONRPC 接口条目的 `protocolVersion` 优先，其次
 * `protocolVersions[]` 首个，再次顶层 `protocolVersion`。
 * 无可用声明（缺失、`2.0`、无法解析）→ undefined。
 */
export function versionOf(card) {
    const interfaces = card.supportedInterfaces ?? [];
    const jsonrpc = interfaces.find((entry) => String(entry.protocolBinding ?? '').toUpperCase() === 'JSONRPC');
    const candidates = [
        jsonrpc?.protocolVersion,
        card.protocolVersions?.[0],
        card.protocolVersion,
    ];
    for (const raw of candidates) {
        const parsed = parseMajor(raw);
        if (parsed !== undefined)
            return parsed;
    }
    return undefined;
}
/**
 * 协商结果：卡片缺失或没有可用声明都落到 v0.3（后者是 §3.4.2 的默认版本，
 * 前者是 §3.4.3 的降级）。两条规则触发条件不同，但结论一致。
 */
export function negotiateVersion(card) {
    if (card === undefined)
        return 'v0.3';
    return versionOf(card) ?? 'v0.3';
}
function parseMajor(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const text = raw.trim().replace(/^[vV]/, '');
    const match = /^(\d+)(?:\.\d+)*$/.exec(text);
    if (match === null)
        return undefined;
    const major = Number(match[1]);
    if (major === 1)
        return 'v1.0';
    if (major === 0)
        return 'v0.3';
    return undefined;
}
// ── 状态映射 ───────────────────────────────────────────────────────────
const INTERNAL_STATES = [
    'submitted',
    'working',
    'input-required',
    'completed',
    'failed',
    'canceled',
    'rejected',
    'auth-required',
    'unknown',
];
/**
 * 状态归一：v1.0 的 `TASK_STATE_*` → 内部小写值；`UNSPECIFIED` 与任何不认识的
 * 值映射为 `unknown`，并把原值留在 `rawState`（不当作终态）。
 */
export function normalizeState(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '')
        return { state: 'unknown', rawState: String(raw) };
    if (INTERNAL_STATES.includes(text)) {
        return { state: text };
    }
    if (text.startsWith('TASK_STATE_')) {
        const suffix = text.slice('TASK_STATE_'.length).toLowerCase().replace(/_/g, '-');
        if (INTERNAL_STATES.includes(suffix) && suffix !== 'unknown') {
            return { state: suffix };
        }
    }
    return { state: 'unknown', rawState: text };
}
// ── part 判别 ──────────────────────────────────────────────────────────
/**
 * part 的类型：有 `kind` 用它；v1.0 的 ProtoJSON 没有 `kind`，按成员名判别
 * （`text` / `data` / `url`|`file`）。
 */
export function partKind(part) {
    const explicit = part['kind'];
    if (explicit === 'text' || explicit === 'data' || explicit === 'file')
        return explicit;
    if (typeof part['text'] === 'string')
        return 'text';
    if (part['data'] !== undefined)
        return 'data';
    if (part['url'] !== undefined || part['file'] !== undefined)
        return 'file';
    return undefined;
}
function normalizePart(part) {
    if (part === null || typeof part !== 'object')
        return part;
    const record = part;
    if (typeof record['kind'] === 'string')
        return part;
    const kind = partKind(record);
    return (kind === undefined ? part : { ...record, kind });
}
// ── 响应归一 ───────────────────────────────────────────────────────────
/** v0.3 裸 Task / v1.0 `{ task }` → 内部 Task（状态与 parts 归一）。 */
export function normalizeTask(raw) {
    if (raw === null || typeof raw !== 'object') {
        throw new Error('invalid A2A task response');
    }
    const record = raw;
    const task = record['task'] !== undefined && typeof record['task'] === 'object'
        ? record['task']
        : record;
    const status = (task['status'] ?? {});
    const normalized = normalizeState(status['state']);
    const rawArtifacts = task['artifacts'];
    const artifacts = Array.isArray(rawArtifacts)
        ? rawArtifacts.map((artifact) => ({
            ...artifact,
            parts: Array.isArray(artifact['parts'])
                ? artifact['parts'].map(normalizePart)
                : [],
        }))
        : undefined;
    return {
        ...task,
        kind: 'task',
        status: {
            ...status,
            state: normalized.state,
            ...(normalized.rawState !== undefined ? { rawState: normalized.rawState } : {}),
        },
        ...(artifacts !== undefined ? { artifacts } : {}),
    };
}
/** `GetTask` / `CancelTask` 的结果：裸 Task 或 `{ task }`。 */
export function normalizeTaskResult(raw) {
    return normalizeTask(raw);
}
/**
 * `SendMessage` 的结果：`{ task }` / `{ msg }` / 裸 Task / 裸 Message。
 * Message 形态包成完结 Task（沿用旧行为），保证上层只处理 Task。
 */
export function normalizeSendResult(raw, contextId) {
    if (raw === null || typeof raw !== 'object') {
        throw new Error('invalid A2A send response');
    }
    const record = raw;
    if (record['task'] !== undefined)
        return normalizeTask(record);
    if (record['msg'] !== undefined)
        return messageToTask(record['msg'], contextId);
    if (record['status'] !== undefined)
        return normalizeTask(record);
    if (record['parts'] !== undefined)
        return messageToTask(record, contextId);
    throw new Error('invalid A2A send response: missing task/msg');
}
function messageToTask(raw, contextId) {
    const message = (raw ?? {});
    const parts = Array.isArray(message.parts) ? message.parts.map(normalizePart) : [];
    const text = parts
        .filter((part) => partKind(part) === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
    return {
        kind: 'task',
        id: 'inline',
        contextId,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        artifacts: text === '' ? [] : [{ kind: 'artifact', artifactId: 'inline', parts }],
    };
}
// ── 错误分类 ───────────────────────────────────────────────────────────
/**
 * 网关错误码 → 是否鼓励重试。`-32005`（环路）/ `-32006`（注入被拒）不可重试；
 * `-32003`（上游不可用）可重试；其他不表态（两个字段都省略）。
 */
export function classifyError(code) {
    if (code === -32005 || code === -32006)
        return { retryable: false };
    if (code === -32003)
        return { retryable: true };
    // -1 是客户端侧统一码：传输错误、超时、重定向、HTTP 状态。这些都可以重试。
    if (code === -1)
        return { retryable: true };
    return {};
}
//# sourceMappingURL=compat.js.map