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
import { randomUUID } from 'node:crypto';
import { createAssistantMessage, createUserMessage, } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { describeNonTextParts, extractText } from "./protocol.js";
export function createRunner(ctx, config, store) {
    const states = new Map();
    const llmHistories = new Map();
    return {
        async run(input) {
            const { controller, message } = input;
            const rawText = extractText(message.parts);
            const nonText = message.parts.filter((p) => p.kind !== 'text').length;
            if (rawText === '' && nonText === 0) {
                controller.updateStatus('failed', agentNote(message, '消息不包含任何内容'));
                return;
            }
            // llm/agent 模式当前只消费文本：非文本 part 以说明形式转告（不静默丢弃）。
            const text = rawText === ''
                ? '（用户只发送了非文本内容，已忽略：' + describeNonTextParts(message.parts).join('、') + '）'
                : nonText > 0
                    ? rawText + '\n（附带的非文本内容已忽略：' + describeNonTextParts(message.parts).join('、') + '）'
                    : rawText;
            if (config.mode === 'echo') {
                await runEcho(controller, message, text);
                return;
            }
            if (config.mode === 'llm') {
                await runLlm(ctx, config, llmHistories, controller, message, text);
                return;
            }
            await runAgent(ctx, config, states, store, controller, message, text);
        },
    };
}
// ── echo 模式 ──────────────────────────────────────────────────────────
async function runEcho(controller, message, text) {
    const reply = `echo: ${text}`;
    controller.addArtifact([{ kind: 'text', text: reply }], { name: 'echo' });
    controller.recordHistory({
        kind: 'message',
        role: 'agent',
        parts: [{ kind: 'text', text: reply }],
        messageId: randomUUID(),
        taskId: message.taskId,
        contextId: message.contextId,
    });
    controller.updateStatus('completed');
}
// ── llm 模式 ──────────────────────────────────────────────────────────
async function runLlm(ctx, config, histories, controller, message, text) {
    const llm = ctx.get('llm');
    if (!llm) {
        controller.updateStatus('failed', agentNote(message, '当前环境未加载 ctx.llm，无法以 llm 模式回复'));
        return;
    }
    if (!config.provider || !config.model) {
        controller.updateStatus('failed', agentNote(message, '插件未配置 provider/model，无法以 llm 模式回复'));
        return;
    }
    // server.prepareTask 总会补 contextId；类型上仍做兜底。
    const contextId = message.contextId ?? 'anonymous';
    const userMessage = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    const prior = histories.get(contextId) ?? [];
    const messages = [...prior, userMessage];
    let reply = '';
    let failed = false;
    try {
        const stream = llm.stream({
            provider: config.provider,
            model: config.model,
            messages,
            system: config.systemPrompt,
        });
        for await (const chunk of stream) {
            if (controller.canceled)
                return; // cancel() 已广播终态
            if (chunk.type === 'text-delta') {
                reply += chunk.text;
            }
            else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
                failed = true;
                reply = `模型调用失败：${chunk.reason.failure.message}`;
            }
        }
    }
    catch (error) {
        failed = true;
        reply = `模型调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
    if (controller.canceled)
        return;
    if (!failed && reply.trim() !== '') {
        const assistantMessage = createAssistantMessage({
            content: [{ type: 'text', text: reply.trim() }],
            source: { provider: config.provider, model: config.model },
        });
        const max = config.maxHistory ?? 20;
        const kept = trimHistory([...messages, assistantMessage], max);
        histories.set(contextId, kept);
    }
    controller.addArtifact([{ kind: 'text', text: reply.trim() || '（模型未返回任何内容）' }], { name: 'reply' });
    controller.recordHistory({
        kind: 'message',
        role: 'agent',
        parts: [{ kind: 'text', text: reply.trim() || '（模型未返回任何内容）' }],
        messageId: randomUUID(),
        taskId: message.taskId,
        contextId: message.contextId,
    });
    controller.updateStatus(failed ? 'failed' : 'completed');
}
function trimHistory(messages, max) {
    if (max <= 0)
        return [];
    const kept = messages.slice(-max);
    // 偶数边界：保留的第一条应是 user 消息，避免 assistant 开头的残缺历史。
    return kept.length > 0 && kept[0].role === 'assistant' ? kept.slice(1) : [...kept];
}
async function runAgent(ctx, config, states, store, controller, message, text) {
    const agents = ctx.get('agents');
    if (!agents) {
        controller.updateStatus('failed', agentNote(message, '当前环境未加载 ctx.agents，无法使用 agent 模式'));
        return;
    }
    const resolved = await resolveAgent({ ctx, config, states, store }, agents, message.contextId ?? 'anonymous');
    if (!resolved.ok) {
        controller.updateStatus('failed', agentNote(message, resolved.message));
        return;
    }
    const agent = resolved.agent;
    if (agents.get(agent.id) !== agent) {
        controller.updateStatus('failed', agentNote(message, 'agent 会话已被销毁，请重试以新建会话'));
        return;
    }
    const userMessage = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    const seqBefore = lastSessionSeq(agent);
    if (agent.status === 'running') {
        // 会话忙：steer 进下一 step 边界；本轮任务以收到的 steer 回应作答。
        agent.steer(userMessage);
    }
    else {
        agent.followup(userMessage);
    }
    await waitIdleOrCanceled(agent, controller);
    if (controller.canceled) {
        // 尽力中断运行中的会话（内核支持时）。
        const maybe = agent;
        if (agent.status === 'running' && typeof maybe.interrupt === 'function') {
            try {
                maybe.interrupt();
            }
            catch {
                // 中断失败不影响 canceled 终态。
            }
        }
        return;
    }
    const reply = collectAssistantText(readSessionEvents(agent), seqBefore);
    const finalText = reply.trim() !== '' ? reply.trim() : '（本轮 agent 未产生文本输出）';
    controller.addArtifact([{ kind: 'text', text: finalText }], { name: 'dsh-agent-reply' });
    controller.recordHistory({
        kind: 'message',
        role: 'agent',
        parts: [{ kind: 'text', text: finalText }],
        messageId: randomUUID(),
        taskId: message.taskId,
        contextId: message.contextId,
    });
    controller.updateStatus('completed');
}
/** 解析 contextId 对应的 agent：配置 agentId > 自动会话（resume 落盘映射 > 新建）。 */
async function resolveAgent(deps, agents, contextId) {
    const { ctx, config, states, store } = deps;
    // 1) 配置固定 agentId
    if (config.agentId) {
        const agent = agents.get(SessionId(config.agentId));
        if (!agent)
            return { ok: false, message: `未找到配置的 agent 会话 ${config.agentId}` };
        return { ok: true, agent };
    }
    // 2) 进程内既有自动会话
    const state = states.get(contextId);
    if (state?.auto && agents.get(state.auto.agent.id) === state.auto.agent) {
        return { ok: true, agent: state.auto.agent };
    }
    if (state)
        state.auto = undefined;
    const agentOptions = config.provider && config.model
        ? { provider: config.provider, model: config.model }
        : undefined;
    const setup = buildSetup(ctx, config);
    // 3) 持久化映射：重启/插件重载后恢复同一 DSH 会话，延续上下文
    if (config.persistSessions !== false && store && typeof agents.resume === 'function') {
        const sessionId = store.get(contextId);
        if (sessionId) {
            const live = agents.get(SessionId(sessionId));
            if (live) {
                states.set(contextId, { auto: { agent: live } });
                ctx.logger.info(`a2a: 复用已在线会话 ${sessionId}（context ${contextId}）`);
                return { ok: true, agent: live };
            }
            try {
                const handle = await agents.resume({
                    resumeSessionId: SessionId(sessionId),
                    ...(agentOptions ? { agentOptions } : {}),
                    setup,
                });
                states.set(contextId, { auto: handle });
                ctx.logger.info(`a2a: 恢复会话 ${sessionId} 成功（context ${contextId}）`);
                return { ok: true, agent: handle.agent };
            }
            catch (error) {
                ctx.logger.warn(`a2a: 恢复会话 ${sessionId} 失败，将新建会话`, error);
                store.delete(contextId);
            }
        }
    }
    // 4) 新建专属会话
    try {
        let agentPreset;
        const agentPresets = ctx.get('agentPresets');
        if (agentPresets) {
            try {
                const resolved = await agentPresets.resolve(config.agentPreset ?? agentPresets.defaultId);
                agentPreset = resolved.id;
            }
            catch (error) {
                ctx.logger.warn('a2a: 解析 agent preset 失败，agent 将使用全局工具运行', error);
            }
        }
        const handle = await agents.create({
            sessionId: SessionId(`a2a-${contextId}-${randomUUID().slice(0, 8)}`),
            meta: {
                cwd: config.workspace ?? process.cwd(),
                ...(agentPreset ? { agentPreset } : {}),
            },
            ...(agentOptions ? { agentOptions } : {}),
            setup,
        });
        states.set(contextId, { auto: handle });
        if (config.persistSessions !== false && store) {
            store.set(contextId, handle.agent.id);
        }
        ctx.logger.info(`a2a: 为 context ${contextId} 创建专属 DSH agent（session ${handle.agent.id}）`);
        return { ok: true, agent: handle.agent };
    }
    catch (error) {
        ctx.logger.error('a2a: 创建 DSH agent 失败', error);
        return { ok: false, message: '创建 DSH agent 会话失败，请查看 dsh 日志' };
    }
}
/** 新建/恢复会话时挂载 preset（与 GUI 新建会话同机制）。 */
function buildSetup(ctx, config) {
    return async (agentCtx) => {
        const agentPresets = ctx.get('agentPresets');
        if (!agentPresets)
            return;
        try {
            const resolved = await agentPresets.resolve(config.agentPreset ?? agentPresets.defaultId);
            await agentPresets.mount(agentCtx, resolved.id);
        }
        catch (error) {
            ctx.logger.warn('a2a: 挂载 agent preset 失败，agent 将使用全局工具运行', error);
        }
    };
}
/** whenIdle 与取消轮询赛跑（500ms 粒度感知 tasks/cancel）。 */
async function waitIdleOrCanceled(agent, controller) {
    const idle = agent.whenIdle();
    for (;;) {
        const winner = await Promise.race([
            idle.then(() => 'idle'),
            new Promise((resolve) => {
                const timer = setTimeout(() => resolve('tick'), 500);
                timer.unref?.();
            }),
        ]);
        if (winner === 'idle')
            return;
        if (controller.canceled)
            return;
    }
}
function readSessionEvents(agent) {
    const session = agent.session;
    if (!session)
        return [];
    return typeof session.snapshotEvents === 'function'
        ? session.snapshotEvents()
        : (session.events ?? []);
}
function lastSessionSeq(agent) {
    const events = readSessionEvents(agent);
    return events.length > 0 ? events[events.length - 1].seq : 0;
}
/** 收集会话日志中某 seq 之后新增的 assistant 可见文本。 */
function collectAssistantText(events, afterSeq) {
    const parts = [];
    for (const event of events) {
        if ((event.seq ?? 0) <= afterSeq)
            continue;
        const typed = event;
        if (typed.type !== 'assistant/message')
            continue;
        const text = (typed.data?.message?.content ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
            .trim();
        if (text !== '')
            parts.push(text);
    }
    return parts.join('\n').trim();
}
/** 造一条 role=agent 的状态说明消息。 */
function agentNote(message, text) {
    return {
        kind: 'message',
        role: 'agent',
        parts: [{ kind: 'text', text }],
        messageId: randomUUID(),
        taskId: message.taskId,
        contextId: message.contextId,
    };
}
//# sourceMappingURL=bridge.js.map