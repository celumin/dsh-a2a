/**
 * 本地 typecheck 用的 @deepseek-ai/* 结构化类型声明（subset shim）。
 *
 * 背景：本仓库的 node_modules 中 @deepseek-ai/* 为宿主（dsh web）
 * 注入的 peer 依赖，独立检出时不可解析。这些声明按 dsh-feishu-bot
 * 对真实内核的用法整理，形状与真实 .d.ts 兼容，仅供 `pnpm verify`
 * （tsconfig.local.json）使用；正式构建（tsconfig.json）与运行时使用
 * 宿主里的真实包，不读取本文件。
 */

declare module '@deepseek-ai/cordis' {
  export interface CordisLogger {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  export interface Context {
    get(name: string): any
    logger: CordisLogger
    effect(dispose: () => void | (() => void)): () => void
  }
}

declare module '@deepseek-ai/schemastery' {
  /** schemastery 的默认导出是「类即 Schema」：既可静态调用构造 schema，也可作类型注解。 */
  declare class z<T> {
    private readonly __schema_of?: T
    description(text: string): z<T>
    default(value: T): z<T>
    required(): z<T>
    min(value: number): z<T>
    max(value: number): z<T>
    static object<T>(shape: Record<string, unknown>): z<T>
    static string(): z<string>
    static number(): z<number>
    static boolean(): z<boolean>
    static array<T>(item?: z<T>): z<T[]>
    static union<T extends readonly (string | number | boolean)[]>(options: T): z<T[number]>
  }
  export default z
}

declare module '@deepseek-ai/dsh-llm' {
  export interface LlmMessage {
    role: 'user' | 'assistant'
    content: Array<{ type: string; text?: string }>
    [key: string]: unknown
  }
  export type FinishReason =
    | { kind: 'error'; failure: { message: string } }
    | { kind: 'stop'; stopReason?: string }
    | { kind: 'length' }
  export type StreamChunk =
    | { type: 'text-delta'; text: string }
    | { type: 'finish'; reason: FinishReason }
  export interface LlmRuntime {
    stream(request: {
      provider: string
      model: string
      messages: readonly LlmMessage[]
      system?: string
    }): AsyncIterable<StreamChunk>
    listProviders?(): Array<{ id: string; [key: string]: unknown }>
    listModels?(provider: string): Promise<Array<{ id: string; [key: string]: unknown }>>
    resolveCallConfig?(request: { provider: string; model: string }): Promise<unknown>
  }
  export type Message = LlmMessage
  export function createUserMessage(init: {
    content: Array<{ type: 'text'; text: string }>
    source: { kind: string; [key: string]: unknown }
  }): Message
  export function createAssistantMessage(init: {
    content: Array<{ type: 'text'; text: string }>
    source: { [key: string]: unknown }
  }): Message
}

declare module '@deepseek-ai/dsh-session' {
  export type SessionId = string & { readonly __sessionIdBrand: unique symbol }
  export function SessionId(id: string): SessionId
  export interface SessionEvent {
    seq: number
    type: string
    data?: unknown
    [key: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-agent' {
  import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
  export interface Agent {
    id: SessionId
    status: string
    session?: unknown
    steer(message: unknown): void
    followup(message: unknown): void
    whenIdle(): Promise<void>
    interrupt?(): void
  }
  export interface AgentHandle {
    agent: Agent
  }
  export interface AgentCreateOptions {
    sessionId?: SessionId
    meta?: Record<string, unknown>
    agentOptions?: Record<string, unknown>
    setup?: (agentCtx: unknown) => Promise<void>
  }
  export interface AgentRegistry {
    get(id: SessionId): Agent | undefined
    create(options: AgentCreateOptions): Promise<AgentHandle>
    resume?(options: {
      resumeSessionId: SessionId
      agentOptions?: Record<string, unknown>
      setup?: (agentCtx: unknown) => Promise<void>
    }): Promise<AgentHandle>
    roots?(): Agent[]
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export interface ToolDefinition<Args = any, Output = any> {
    name: string
    description: string
    parameters: Record<string, unknown>
    output?: {
      schema?: Record<string, unknown>
      render?: (args: Args, value: Output) => Array<{ type: string; text: string }>
    }
    execute(args: Args): Promise<Output>
  }
  export type AnyToolDefinition = ToolDefinition<any, any>
  export function defineTool<Args = any, Output = any>(
    definition: ToolDefinition<Args, Output>,
  ): AnyToolDefinition
}
