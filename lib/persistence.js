/**
 * A2A contextId → DSH session_id 映射持久化。
 *
 * 与 dsh-feishu-bot 的 ChatSessionStore 同一模式：映射落盘后，
 * dsh web 重启 / 插件重载，同一 A2A contextId 会先尝试 agents.resume()
 * 恢复原会话，对话上下文得以延续（而不是每次重启都变成新用户）。
 *
 * @module dsh-a2a/persistence
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
/** 映射文件默认位置：$DSH_HOME/a2a/context-sessions.json（DSH_HOME 缺省 ~/.dsh）。 */
export function defaultStorePath() {
    const home = process.env.DSH_HOME ?? join(os.homedir(), '.dsh');
    return join(home, 'a2a', 'context-sessions.json');
}
/** contextId → session_id 的持久化映射（文件读写，原子替换）。 */
export class ContextSessionStore {
    path;
    data = new Map();
    constructor(path, initial) {
        this.path = path;
        for (const [contextId, sessionId] of Object.entries(initial)) {
            this.data.set(contextId, sessionId);
        }
    }
    /** 加载（文件不存在/损坏则视为空映射）。 */
    static load(path = defaultStorePath()) {
        try {
            if (existsSync(path)) {
                const raw = JSON.parse(readFileSync(path, 'utf8'));
                return new ContextSessionStore(path, raw);
            }
        }
        catch (error) {
            // 损坏时忽略并重建（不阻断插件运行）。
            void error;
        }
        return new ContextSessionStore(path, {});
    }
    get(contextId) {
        return this.data.get(contextId);
    }
    set(contextId, sessionId) {
        this.data.set(contextId, sessionId);
        this.save();
    }
    delete(contextId) {
        if (this.data.delete(contextId))
            this.save();
    }
    save() {
        try {
            mkdirSync(join(this.path, '..'), { recursive: true });
            const tmp = `${this.path}.tmp`;
            writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2), 'utf8');
            renameSync(tmp, this.path);
        }
        catch (error) {
            // 持久化失败不影响功能（下次消息会新建会话），静默降级。
            void error;
        }
    }
}
//# sourceMappingURL=persistence.js.map