# dsh-a2a（@celumin fork）0.5.0

DSH（DeepSeek Harness）的 **A2A（Agent2Agent）协议**插件：既把 DSH agent 暴露为标准 A2A 服务器，也让任意 DSH agent 通过 `a2a_*` 工具呼叫远端 A2A agent。

> 本仓库是 [zyfgood/dsh-a2a](https://github.com/zyfgood/dsh-a2a) 的 fork，发布为 `@celumin/dsh-a2a`。
> **0.4.0 起走自维护线**：协议对齐与出站能力明显强于上游 `0.3.x`，语义上不再等同上游版本；fork 点与改动见文末「版本与 fork」。

零运行时依赖（纯 Node ≥20 stdlib + 全局 `fetch`），与 [dsh-feishu-bot](https://github.com/zyfgood/dsh-feishu-bot) 同一插件体系。

---

## 0. 0.4.0 相对 0.3.x 的改进

### 出站：终于能打通 v1.0 目标

0.3.x 的 `a2a_send` 对「网关 + v1.0 agent」这条链路不可用，表现是 404 / `-32601` / 拿到结果却解析失败。0.4.0 修的是四处**客户端缺陷**：

| 缺陷 | 0.3.x 的行为 | 0.4.0 的行为 |
|---|---|---|
| 卡片 URL 丢 base path | 目标 `http://gw:9090/a2a/x` 却去请求 `http://gw:9090/.well-known/...` | 保留 base path，按 `{base}/.well-known/agent-card.json` 探测 |
| RPC URL 多尾斜杠 | `POST /a2a/x/` 打不中 `POST /a2a/x` | 不追加尾斜杠 |
| method 名写死 | 永远发 `message/send`/`message/stream` | 按卡片协商：v1.0 → `SendMessage`/`GetTask`/`CancelTask`；v0.3 → `message/send` 等 |
| 只认 v0.3 响应形状 | v1.0 的 `{task}`、`TASK_STATE_*`、无 `kind` 的 part 解析失败 | 解包 `{task}`/`{msg}`、状态归一、part 按成员判别 |

### 错误对模型可见

`a2a_send` / `a2a_task_status` / `a2a_cancel` 失败时输出 `error_code` 与 `retryable`：

- `-32005`（call depth exceeded）/ `-32006`（outbound credential unavailable / outbound target mismatch）→ `retryable=false`
- `-32003`（上游不可用）→ `retryable=true`
- 4xx 响应体是 JSON-RPC error 时保留原始错误码；传输层/超时统一 `-1`
- 超时不再返回空 detail，而是 `轮询超时：最后一次看到的状态是 …, task_id=…`

### 端点选择有明确的授权规则

- RPC 端点以**卡片里的服务地址**为准（网关给 `{base}/a2a/{id}`，pi-a2a 给 `/rpc`），客户端不再自己猜路径。
- **同源**端点还要过 `clientAllowPatterns` 的**路径作用域**：`/tenantA` 的白名单不会被卡片引到 `/tenantB`。
- **跨源**端点默认忽略并回退到输入路径（不是拒绝调用），只有新增的 `clientCardEndpointPatterns`（完整 URL 前缀、默认空、`*` 不生效）显式放行才采用并携带 Bearer。
- 诊断 WARN 只记录 origin 与原因码，不回显卡片 URL。

### 更稳的网络行为

- 卡片与 RPC 都**不跟随重定向**（`redirect: 'manual'`），避免 POST 变 GET / 凭证越界。
- 发现、调用、轮询共用一份总预算；单次卡片请求上限 5s。
- 卡片发现失败时**降级**（输入路径 + v0.3），错误 detail 同时给 `RPC 失败：…；卡片发现失败：…`。
- `input-required` / `auth-required` / 未知状态立即返回，不空转到超时；未知状态会保留原始枚举值。

### 双 profile：tui 与 web 都能装

**同一个包同时支持 tui 与 web profile**，无需额外配置：

```bash
dsh plugin --profile tui add @celumin/dsh-a2a
dsh plugin --profile web add @celumin/dsh-a2a
```

- 宿主半（A2A 服务器 + `a2a_*` 工具 + agent 会话）与 profile 类型无关；浏览器半只在 web 前端加载。
- 两个 profile **同时运行**时改其中一个的 `port`（例如 web 7310、tui 7311），否则 `EADDRINUSE`；两者还共用 `$DSH_HOME/a2a/context-sessions.json`，新会话写入可能互相覆盖。
- 不要删 `dsh.client` 段：它是 web 运维面板的加载声明（删掉后 web 服务照常跑，但面板不渲染）。

### 其它

- 新增配置 `clientCardEndpointPatterns`；`clientAllowPatterns` 语义保持不变。
- `a2a_discover` 返回 `negotiated_version` 与 `rpc_endpoint`，并同时识别 `security` 与 `securitySchemes`。
- 文档补齐：`cordis.patch.yml` 的正确写法、web/tui 双示例、名字一致性、已知限制。

---

## 一、安装

```bash
# npm（推荐；bundle patch 自动挂载）
dsh plugin --profile <tui|web> add @celumin/dsh-a2a

# 或 GitHub（无 npm 凭据时）
dsh plugin --profile <tui|web> add github:celumin/dsh-a2a#v0.5.0

# 或本地路径
dsh plugin --profile <tui|web> add file:/path/to/dsh-a2a
```

> npm 裸名 `dsh-a2a` 是另一个无关项目（TtTRz/dsh-a2a），本 fork 在 `@celumin` scope 下，安装时请带 scope。

重启 profile 后生效，默认监听 `127.0.0.1:7310`。`lib/` 预构建产物随包发布，安装即用。

安装后确认：

```bash
dsh --profile tui --dump-config | grep -n a2a   # 应出现 id: a2a 行
```

排查安装失败：先看 `pnpm.log`，再看**其它插件**的 peer 兼容性拒绝，再看 pnpm 权限问题（`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`），最后才看 `dsh.client`（它只影响 web 浏览器半）。

---

## 二、快速验证

```bash
# 1) Agent Card（0.3 路径）
curl http://127.0.0.1:7310/.well-known/agent-card.json

# 2) 发一条消息（同步）
curl -X POST http://127.0.0.1:7310/ -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "kind": "message",
      "role": "user",
      "parts": [{"kind": "text", "text": "你好，介绍一下你自己"}],
      "messageId": "m-1",
      "contextId": "ctx-demo"
    }
  }
}'
```

返回的 `result` 是 A2A Task：`status.state === "completed"`，回复文本在 `artifacts[0].parts[0].text`。同一 `contextId` 再次调用会复用同一个 DSH agent 会话（多轮记忆）。

流式：

```bash
curl -N -X POST http://127.0.0.1:7310/ \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" -d '{
  "jsonrpc": "2.0", "id": 2, "method": "message/stream",
  "params": {"message": {"kind": "message", "role": "user",
    "parts": [{"kind": "text", "text": "流式演示"}], "messageId": "m-2", "contextId": "ctx-demo"}}
}'
```

SSE 依次推送 `status-update(working)` → `artifact-update` → `status-update(completed, final=true)` 后自然收流。

---

## 三、配置

配置入口是 **profile 的 `cordis.patch.yml`** 里追加/修改 `id: a2a` 条目；**不要**改包内 `cordis.patch.yml`（会被更新覆盖），也不要改 `cordis.yml`（空根入口）。

> 旧文档里的 `a2a.json` 写法**已过时**：新版是扁平 schema、不读文件，入口只有 `cordis.patch.yml`。
> patch 是**整体替换** `config`，不是深合并——想保留的配置一次写全。

**web profile 示例**（可结合浏览器面板使用）：

```yaml
- id: a2a
  name: '@celumin/dsh-a2a'
  config:
    port: 7310
    mode: agent
    peerName: dsh-agent-lenovo
    bearerToken: env:A2A_TOKEN
    publicUrl: http://192.168.10.10:7310
```

**tui profile 示例**（显式指定模型，避免回退到宿主默认模型）：

```yaml
- id: a2a
  name: '@celumin/dsh-a2a'
  config:
    port: 7311
    mode: agent
    provider: agnes-ai
    model: agnes-3.0-flash
    peerName: dsh-agent-lenovo
    bearerToken: env:A2A_TOKEN
    tools: true
    clientAllowPatterns:
      - http://127.0.0.1:9090
      - http://192.168.10.224:38845   # 按 host/port/路径前缀匹配，不支持 CIDR
```

- 密钥用 `env:A2A_TOKEN` 形式，不要把明文 token 写进 patch。
- web 运维面板的 base URL / Bearer 存在浏览器 `localStorage`/`sessionStorage`，**不写进 profile 的 `a2a` 行**。
- 改 `port` / `mode` / `provider` 请编辑 `cordis.patch.yml`，然后重启 profile。

### 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址；公网暴露改 `0.0.0.0` 并配合鉴权 |
| `port` | `7310` | 监听端口（`0` = 系统分配） |
| `publicUrl` | 按监听地址推导 | 写入 Agent Card 的 `url`；反代/TLS 部署时必须配置为外部可达地址 |
| `bearerToken` | 无 | Bearer 鉴权令牌，支持 `env:VAR`；配置后卡片宣告 `bearerAuth` |
| `agentName` / `agentDescription` / `agentVersion` | `DSH Agent` / … | Agent Card 元信息 |
| `peerName` | 同 `agentName` | 本端 peer 名：出站消息写入 `metadata.from`，供对端把回话路由回来 |
| `skills` | 内置一条 dsh-agent 技能 | Agent Card 技能清单 |
| `mode` | `agent` | 入站处理模式：`agent` / `llm` / `echo`（见下） |
| `provider` / `model` | — | 模型来源：`llm` 模式直答，`agent` 模式创建会话时写入；tui 下建议显式配置 |
| `systemPrompt` / `maxHistory` | — | `llm` 模式参数（`ctx.llm` 直答，短期记忆按 `maxHistory`） |
| `agentId` | 自动 | `agent` 模式：固定复用 `ctx.agents` 中某会话；不配置则按 contextId 自动创建 |
| `agentPreset` | GUI 默认预设 | 自动创建会话的 preset（决定 agent 可用的工具集） |
| `workspace` | `process.cwd()` | 自动创建会话的工作目录 |
| `persistSessions` | `true` | contextId → 会话映射落盘（`$DSH_HOME/a2a/`），重启后自动恢复上下文 |
| `turnTimeoutMs` | `600000` | 单轮执行上限，超时任务置 `failed` |
| `taskTtlMs` | `3600000` | 已完结任务内存保留时长（之后 TTL 回收） |
| `tools` | `true` | 是否注册 `a2a_*` 出站工具 |
| `clientAllowPatterns` | `['*']` | 目标白名单：`'*'`、`https://a2a.example.com/`、`https://*.example.com/`、`'*:7310'`；同时约束**同源**卡片端点的路径作用域 |
| `clientCardEndpointPatterns` | `[]` | **跨源**卡片端点白名单：完整 URL 前缀（`https://other/rpc`），默认全拒，`*` 不生效 |
| `clientTimeoutMs` | `120000` | 单次调用总预算：发现 + RPC + 轮询共用 |

### 三种入站模式

- **`agent`（默认）**：每个 A2A `contextId` 对应一个持久 DSH agent 会话（完整工具/技能/工作目录），跨任务续答；映射可落盘跨重启恢复。会话忙时新消息走 `steer`（下一 step 边界消费）。
- **`llm`**：`ctx.llm` 直答（不建 agent 会话，短期记忆按 `maxHistory`）。
- **`echo`**：回显原文，验证链路。

### 名字一致性（配了却永不命中，通常是这里）

三处名字必须一致，网关**不做**名字映射：

| 位置 | 写什么 | 例子 |
|---|---|---|
| 本端 `peerName` | 出站 `metadata.from` 的值 | `dsh-agent-lenovo` |
| 网关的 `A2A_AUTH_TOKENS` | `caller:token` 里的 caller | `dsh-agent-lenovo:<token>` |
| 网关的 `A2A_AGENT_OUTBOUND_AUTH` | 五段格式的第一段 caller | `dsh-agent-lenovo:pi-gw-agent:Authorization:pi-gw:…` |
| 未来 mDNS 广播的 `name` | 与其他位置一致 | `dsh-agent-lenovo` |

不一致的表现是「配置看起来对，但永远不命中 / 永远 `-32006`」。

> 网关的 `A2A_AGENT_OUTBOUND_AUTH` 里 `token_ref` 是**环境变量名**，它的值是该 header 的**完整值**——`Authorization` 要写成 `Bearer test`（不是裸 `test`）。

---

## 四、出站：agent 调用远端 A2A

插件默认注册 4 个模型工具（`tools: false` 关闭）：

| 工具 | v1.0 方法 | v0.3 方法 | 用途 |
|---|---|---|---|
| `a2a_discover` | `GET /.well-known/agent-card.json` | 同 | 拉卡片；返回 `negotiated_version`、`rpc_endpoint`、鉴权需求 |
| `a2a_send` | `SendMessage` | `message/send` | 发消息并等待结果；`kind`（`message`/`request`/`result`，默认 `message`） |
| `a2a_task_status` | `GetTask` | `tasks/get` | 查询任务状态 |
| `a2a_cancel` | `CancelTask` | `tasks/cancel` | 取消任务 |

### target 怎么给

`target` 只接受三种形态：

1. **origin 根**：`http://127.0.0.1:7310`
2. **路径基址**：`http://gw:9090/a2a/pi-gw-agent`
3. **卡片 URL**：`http://gw:9090/a2a/pi-gw-agent/.well-known/agent-card.json`（自动剥离后缀）

**不要把卡片里的「服务 URL」（如 pi-a2a 的 `/rpc`）当 target**——它和「路径基址」无法区分，会探测失败并降级。

**调 pi-a2a 的前置条件**：它广告的是 `http://<lanIp>:<port>/rpc`。target 必须用**同一个 host**（例如 `http://192.168.10.224:38845`）；用 `127.0.0.1` 访问而卡片写的是 LAN IP 会被判为跨源并回退。要么对齐 host，要么把该端点加进 `clientCardEndpointPatterns`。

### 版本协商与流式

- 版本来源（同一 JSONRPC 接口条目）：`supportedInterfaces[].protocolVersion` → `protocolVersions[]` → `protocolVersion`。
- 没有可用声明（含卡片取不到）→ **默认 v0.3**（v1.0 的卡片有强制标记，缺失通常意味着旧实现）。
- `X-A2A-Version` 随协商结果发 `1.0` / `0.3`；卡片 GET 不带版本头。
- **流式只对 v0.3 且 `streaming:true` 启用**；v1.0 一律同步（`SendStreamingMessage` 本轮不实现）。
- `GetTask` / `CancelTask` 都发 `params.id`（0.3 规范即 `id`）。

### 出站报文形状（0.6.0）

出站 `params.message` 的形状由**卡片协商结果**唯一决定，没有单独开关：

| 协商版本 | `params.message` 形状 |
|---|---|
| v1.0 | `role:"ROLE_USER"`；message 与 part **都没有 `kind`**；`parts:[{text}]` / `[{data}]` / `[{file:{uri\|bytes,mimeType,name}}]`；随行 `messageId` / `metadata` / `contextId` / `taskId` |
| v0.3 | 与 0.5.0 逐字段相同：`kind:"message"`、`role:"user"`、`parts:[{kind:"text",...}]` |

- 严格 ProtoJSON v1.0 对端用「0.5.0 服务端 + 测试内联 strict proxy」验收：proxy 只放行 v1 形状（否则 `-32602`），通过后转发给真实服务端；用例名 `Round 2.6：严格 v1 对端（0.5.0 服务端 + strict proxy）接受出站形状`。
- 卡片**错标 1.0**、实际只吃 v0.3 形状的对端会收到 `-32602`；回退方式：`dsh plugin add @celumin/dsh-a2a@0.5.0`。
- `sendStream` 在 v1.0 上立即抛 `A2aRpcError(-32601, 'v1.0 streaming is not supported（SendStreamingMessage）')`，**不发请求**（v1 的 `{statusUpdate}` / `{artifactUpdate}` 帧本包不解析）。

### 错误码与重试

| `error_code` | `retryable` | 含义 |
|---|---|---|
| `-32005` | `false` | 网关环路保护（call depth exceeded） |
| `-32006` | `false` | 出站凭据不可用 / 目标不匹配 |
| `-32003` | `true` | 上游不可用 |
| `-1` | `true` | 传输层错误 / 超时 / 重定向 / HTTP 状态 |
| 其他 | 省略 | 按原错误码处理 |

插件**不会自动重试**；`retryable` 只是给模型的建议。`-32003` 且 `kind=request` 时重发可能产生重复副作用，请先确认 task 状态。

### 调用示例

> 用 `a2a_send` 呼叫 `http://192.168.10.224:38845`，`kind=request`，问它有哪些技能，把结果汇总给我。

对「消息投递型」agent（如 pi-a2a）请用 `kind=request`：`kind=message` 只入库、不触发处理，会得到空洞的成功。

---

## 五、服务端：v1.0 兼容（0.5.0 新增）

服务端现在同时接受 **v1.0 与 v0.3 两种入站形状**，响应形状按**请求方法名**决定；出站形状随协商版本切换（0.6.0，见 §四）。

**方法别名**（未知方法仍 `-32601`）：

| v1.0 方法 | 等价 v0.3 方法 | `result` 形状 |
|---|---|---|
| `SendMessage` | `message/send` | `{task: <v1 Task>}` |
| `GetTask` | `tasks/get` | 裸 v1 Task |
| `CancelTask` | `tasks/cancel` | 裸 v1 Task |
| `message/send` / `tasks/get` / `tasks/cancel` | — | 裸 v0.3 Task（不变） |

**入站双形状（所有入口，不只别名）**：`role` 接受 `ROLE_USER`/`ROLE_AGENT`（归一成 `user`/`agent`）与原来的小写值；part 缺 `kind` 时按成员判别（`text:string` / `data:object` / `file:{uri|bytes}`），判不出仍是 `-32602`（文案不变）。`message.metadata` 原样透传。

**v1 Task 形状**：状态用 `TASK_STATE_*`（含 `AUTH_REQUIRED` / `UNSPECIFIED`；`unknown` 的合法 `rawState` 原样输出）、part 去 `kind`、role 用 `ROLE_*`、丢弃内部字段 `rawState`；file part 输出 `{file:{uri|bytes,mimeType,name}}`，**不产生 `url`**。

**响应头 `A2A-Version` 跟随方法**：v1.0 名字（含只回 `-32601` 的 `SendStreamingMessage`）→ `1.0`，其余 → `0.3.0`；卡片 GET、`/admin/*`、404 仍固定 `0.3.0`。请求头 `X-A2A-Version` 主版本接受 `0` 与 `1`（其他仍 HTTP 400），`X-A2A-Version` 优先于 `A2A-Version`；空 / 纯空白头等价于没带。

未实现的 v1.0 名字（`ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` / `SendStreamingMessage`）回 `-32601` 时响应头是 `1.0`；push 配置族（`CreateTaskPushNotificationConfig` / `GetTaskPushNotificationConfig` / `ListTaskPushNotificationConfigs` / `DeleteTaskPushNotificationConfig`）仍是 `-32003`、头也是 `1.0`；v0.3 的 `tasks/pushNotificationConfig/list` / `/delete` 仍 `-32601`（头 `0.3.0`，本轮刻意不进路由表）。

**卡片**：单数 `protocolVersion: "0.3.0"` 保留，新增复数 `protocolVersions: ["0.3.0"]`；**不宣告 1.0**（服务端能力不完整，不 overclaim）。

**不做**：`SendStreamingMessage` / v1 SSE 帧（`{statusUpdate}` / `{artifactUpdate}`）→ 仍 `-32601`；`message/stream` 的事件形状不变；`ListTasks` / `SubscribeToTask` / `GetExtendedAgentCard` 不做别名。

**与出站 R8 的关系**：0.5.0 的 v1.0 入口（非流式）即 strict fixture 的**生产侧**：测试内联 proxy 校验出站形状后把原始请求转发给它；回归用例是 `tests/smoke.mjs` 的 strict proxy 用例。

---

## 六、已知限制

- **出站形状随协商版本切换（0.6.0）**：v1.0 对端收到 `ROLE_USER`、无 `kind` 的 message/part；v0.3 对端字节不变。卡片错标 1.0 但只吃 v0.3 形状的对端会收到 `-32602`（回退 0.5.0）。v0.3 `message/send` 响应保留请求里的 `message.metadata`（0.5.0 起的有意行为）。
- **不做 v1.0 流式事件**（`SendStreamingMessage` / `{statusUpdate}` / `{artifactUpdate}`）。
- **服务端永远不会产出 `unknown` / `rawState`**：v0.3 内部状态机只有固定枚举，`toV1Task` 的 `TASK_STATE_UNSPECIFIED` / `rawState` 映射是防御性的（只由纯函数单测覆盖）；`auth-required` 是唯一能在真实服务器上出现的非 0.3 枚举状态。
- **网关 2.6 之前的卡片接口条目恒为 1.0**：旧网关把 `supportedInterfaces[].protocolVersion` 固定写成 `1.0`，把 v0.3 上游挂在它后面会被用 `SendMessage` 调用。a2a-way Round 2.6 起接口版本如实呈现（fleet 内 `feat/round2.6`），旧网关仍是这个问题。
- 网关的 `POST /a2a/name/{agentName}` 路由没有卡片端点，只能走降级 v0.3。
- **网关 2.6 之前**的深度闸只识别 `message/send` / `message/stream`，v1.0 的 `SendMessage` 不经过闸；a2a-way Round 2.6 起 `SendMessage` / `SendStreamingMessage` 也过闸（POST 与 GET 载体）。
- 卡片发现**不做**进程级缓存：每次 `a2a_send` 重新发现（1–2 次 GET）。短 TTL 缓存列为后续候选。

---

## 七、升级（0.3.x → 0.5.0）

- 直接换版本即可；配置 schema 向后兼容，新增 `clientCardEndpointPatterns`（默认 `[]`，不配置时行为不变）。
- 行为变化（有意为之）：跨源卡片端点现在默认被忽略并回退；同源端点受 `clientAllowPatterns` 路径约束；`-32601` 不再静默换名重发；超时抛结构化错误。
- 仍在使用 `a2a.json` 的旧配置请改到 `cordis.patch.yml`。
- **0.4.0 → 0.5.0**：客户端行为不变；服务端新增 v1.0 入站与方法别名（§五），旧 v0.3 客户端无感。
- 回退到 0.3.x：`dsh plugin --profile <name> add @celumin/dsh-a2a@0.3.1`。

---

## 八、开发

```bash
pnpm verify       # 本地 typecheck（shims/ 提供 @deepseek-ai 结构类型）
pnpm test         # 核心构建 + smoke（80）+ compat 纯函数单测（59）
pnpm build:local  # 本地全量构建 lib/（shims 类型校验）
pnpm build        # 宿主环境全量构建（需要真实 @deepseek-ai/* 类型）
npm run prepack   # 发布前构建（tsconfig.emit.json + shims）
```

> 本机独立检出时，`pnpm build` 可能因宿主注入的 `@deepseek-ai/*` 类型版本差异而报错（`bridge.ts` / `ContentBlock`），发布用 `npm run prepack`；这不影响 `npm test` 与运行。

代码结构：

```
src/
├── index.ts       插件入口：Config schema + apply()
├── protocol.ts    A2A 类型 / JSON-RPC / Agent Card（纯函数，零依赖）
├── endpoint.ts    target 归一 / 卡片候选 / 端点授权（纯函数，零依赖）
├── compat.ts      版本协商 / 方法表 / 响应归一 / 错误分类（纯函数，零依赖）
├── store.ts       任务存储 + SSE 事件中枢（事件缓冲、订阅、TTL）
├── server.ts      HTTP 服务器：card / message/send / message/stream(SSE) / tasks/* / admin/*
├── bridge.ts      DSH 桥接：echo / llm / agent 三种 TaskRunner
├── client.ts      出站 A2A 客户端（发现 → 协商 → 收发 → 轮询）
├── tools.ts       a2a_* 模型工具注册
└── persistence.ts contextId → 会话映射落盘
client/
└── client.js      浏览器半：A2A 运维面板（免构建 ModuleLoader 工厂，react 为宿主 external）
```

设计说明：

- `protocol` / `endpoint` / `compat` / `store` / `server` 不依赖任何 DSH 包，可独立构建与测试；DSH 桥接收敛在 `bridge.ts` / `tools.ts` / `index.ts`。
- **agent 模式必须有模型**：agent-loop 不自动兜底 provider/model，缺失时每轮立即报错（表现为「无文本输出」）。改 profile 默认模型后，新建的 A2A 会话即生效（已存在的会话沿用原模型，删 `$DSH_HOME/a2a/context-sessions.json` 对应条目可重建）。
- 任务 id 参数：入站同时接受 `params.id` 与旧约定 `params.taskId`；出站统一发规范写法 `id`。
- 出站元数据：`message.metadata` 恒带 `kind`，配置 `peerName` 后附带 `from`。
- 卡片解析兼容：顶层 `url` 与 v1.0 的 `supportedInterfaces[].url` 两种形态。
- `input-required` 事件带 `final=true` 关闭当轮 SSE，但任务保持非终态，可凭 `taskId` 续答。
- `tasks/cancel` 立即广播 `canceled(final=true)`；agent 模式下正在运行的一轮会在 500ms 轮询粒度感知退出。
- 不支持的协议面按规范返回明确错误码：push notification `-32003`、批量 JSON-RPC `-32600`。

---

## 九、mDNS 发现（建议，未来版本）

- **发现目标**：网关优先，P2P 降级。同时发现网关和目标 agent 时，默认经网关转发。
- **P2P 降级条件**：网关不可达，或显式配置 `MDNS_P2P_ONLY=true`。P2P 不经过网关审计，日志与 UI 必须标明。
- **TXT 字段**：只放 `proto`/`cardUrl`/`caps`/`ver`/`discoveryVer`，**不放 workspace 名、secret、任何凭据**。
- **发现层不做鉴权**：TXT 可伪造，候选必须拉 AgentCard + 过 allowlist 才信任。
- **不抄 pi-a2a 的 `wsh` 互认模型**：TXT 里放 workspace hash 做发现层鉴权，与 A2A 草案「发现层不可信」原则冲突。

---

## 十、与 DSH 内置能力的关系

| 需求 | 用什么 |
|---|---|
| 程序化驱动 DSH agent（进程外） | 内置 ACP（`dsh-acp`） |
| 挂载外部工具/资源 | 内置 MCP 客户端 |
| 跨 agent 生态互操作（Google ADK / A2A SDK / pi-a2a / 网关） | **本插件** |

---

## 十一、版本与 fork

- **上游**：`https://github.com/zyfgood/dsh-a2a`（fork 点见 `git log` 的初始提交）。
- **本 fork**：`https://github.com/celumin/dsh-a2a`，npm `@celumin/dsh-a2a`。
- **0.4.0 改动**：R1（URL 规范化 + method 协商 + v1.0 响应适配）、R5（错误码可见）、R4/R6（配置与名字一致性文档）、端点授权；详见 `docs/requirements.md`。
- **0.5.0 改动**：服务端 v1.0 兼容（方法别名、入站双形状、按方法返回形状与版本头、卡片复数）；R8（出站按版本切换形状）仍押后到 0.6.0。
- **升级策略**：自维护线按需发布；上游若修复同类问题，优先评估切回上游。

## License

MIT
