/**
 * TaskRunner 的 DSH 实现：把一条 A2A 消息翻译成 DSH 侧的一轮执行。
 *
 * 三种模式（config.mode）：
 * - `echo`  回显文本（验证 A2A 链路）；
 * - `llm`   `ctx.llm` 直接生成回复（自包含轻量模式，不建 agent 会话）；
 * - `agent` 转交给 DSH agent 会话（默认）：每个 A2A contextId 对应一个
 *           持久 agent 会话（可跨任务续答、可落盘跨重启恢复），回复文本
 *           以 artifact 返回。
 *
 * agent 模式复用 dsh-feishu-bot 的会话管理经验：
 * - 配置 agentId > contextId 绑定的自动会话（resume 持久映射 > 新建）；
 * - 新建时挂 preset（agentPresets）与工作目录；
 * - 回复文本从会话日志按 seq 收集（snapshotEvents/events 双兼容）；
 * - running 中收到新消息走 steer（下一 step 边界消费）。
 *
 * @module dsh-a2a/bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { A2aRunner } from './server.ts';
import type { ContextSessionStore } from './persistence.ts';
/** 桥接配置（index.ts Config 的子集）。 */
export interface BridgeConfig {
    mode: 'echo' | 'llm' | 'agent';
    provider?: string;
    model?: string;
    systemPrompt?: string;
    maxHistory?: number;
    agentId?: string;
    agentPreset?: string;
    workspace?: string;
    persistSessions?: boolean;
}
export declare function createRunner(ctx: Context, config: BridgeConfig, store?: ContextSessionStore): A2aRunner;
//# sourceMappingURL=bridge.d.ts.map