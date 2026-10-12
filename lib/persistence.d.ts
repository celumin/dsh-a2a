/**
 * A2A contextId → DSH session_id 映射持久化。
 *
 * 与 dsh-feishu-bot 的 ChatSessionStore 同一模式：映射落盘后，
 * dsh web 重启 / 插件重载，同一 A2A contextId 会先尝试 agents.resume()
 * 恢复原会话，对话上下文得以延续（而不是每次重启都变成新用户）。
 *
 * @module dsh-a2a/persistence
 */
/** 映射文件默认位置：$DSH_HOME/a2a/context-sessions.json（DSH_HOME 缺省 ~/.dsh）。 */
export declare function defaultStorePath(): string;
/** contextId → session_id 的持久化映射（文件读写，原子替换）。 */
export declare class ContextSessionStore {
    private readonly path;
    private data;
    private constructor();
    /** 加载（文件不存在/损坏则视为空映射）。 */
    static load(path?: string): ContextSessionStore;
    get(contextId: string): string | undefined;
    set(contextId: string, sessionId: string): void;
    delete(contextId: string): void;
    private save;
}
//# sourceMappingURL=persistence.d.ts.map