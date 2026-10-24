# `docs/requirements.md`（dsh-a2a fork 包）

> 位置：`https://github.com/celumin/dsh-a2a.git` 的 `dsh-a2a/docs/requirements.md`
> 本文件汇总 dsh-a2a fork 包的改进需求。每条需求标注来源、现状、期望、验收、状态与前置。
> 上游：`https://github.com/zyfgood/dsh-a2a.git`；fork：`https://github.com/celumin/dsh-a2a.git`
> 当前基线：`@celumin/dsh-a2a@0.3.1`（npm 已发布）；下一个交付：`0.4.0`（Round 2.5，自维护线）
> 验证环境：dsh CLI `0.2.1-rc.2` · `@deepseek-harness-tui/dsh-tui` `0.16.1` · Node `v24.21.0` · Linux
> 最后更新：2026-10-24（第二次修订：复核源码后纠正 R1 根因——不是探测顺序，而是客户端 URL 规范化 + method 名写死；`agent.json` 别名整项取消；R5 明确为"把不可重试变成模型可见"。第一次修订依据 `2026-10-23-tui-profile-install-investigation.md`，R2 由"待评估"改为"已验证无需修复"）

## 状态图例

- **待评估**：根因未定位，或需求边界未定
- **待实现**：需求明确，未开始
- **进行中**
- **已完成**（标注版本）
- **已关闭**：调查后确认无需修改（标注结论依据）
- **已拒绝**（标注理由）

## 需求列表

---

### R1：A2A 协议版本对齐（URL 规范化 + method 协商 + v1.0 报文适配）

- **来源**：`a2a-way` 联调记录 2026-10-22 §8.3；`docs/ROADMAP.md` Round 2.5；2026-10-24 源码复核纠正
- **现状（2026-10-24 纠正）**：`a2a_send` 对网关不可用，**根因不是探测顺序**——`A2aClient.card()` 自 v0.1.0 起就是 `agent-card.json` 优先、`agent.json` 回退。真实缺陷四处，都在客户端：
  1. **卡片 URL 丢失 base path**：`normalize()` 的 `cardUrl` 是 `origin + wellKnown`。target 为 `http://gw:9090/a2a/pi-gw-agent` 时实际请求 `http://gw:9090/.well-known/agent-card.json`；网关只在 `/a2a/{id}/.well-known/agent-card.json` 挂载（且是唯一免鉴权路径），两个候选都在 origin 根 404。
  2. **RPC URL 多一个尾斜杠**：`rpcUrl` 为 `path + '/'`，实际发出 `POST /a2a/{id}/`；网关注册的是 `POST /a2a/{agentID}`（chi，无 `RedirectSlashes` 中间件），匹配不上。
  3. **method 名写死**：`send` / `sendStream` 固定 `message/send` / `message/stream`；A2A v1.0 的方法名是 `SendMessage` / `GetTask` / `CancelTask`，Pi 只认 v1.0 命名，故 `-32601`。
  4. **报文形状只认 v0.3**：v1.0 是 ProtoJSON——`SendMessage` 返回 `{ "task": {...} }`、状态是 `TASK_STATE_*`、part 用成员名判别（`{ text }`，无 `kind`）。客户端把结果强转 `A2aTask` 并在首跳读 `status.state`，会 TypeError 或永不到终态；网关原样透传上游响应体，故经网关**必然**命中。
- **期望**：
  - **探测**：保持 `agent-card.json` 优先；target 只提供 `agent.json` 时回退（现状已有，作为回归项保留）。
  - **URL**：`cardUrl` 保留 base path（`{origin}{path}{wellKnown}`）；`rpcUrl` 不追加尾斜杠（path 为空时才落到 `/`）；RPC 端点以卡片服务地址为准（网关给 `{base}/a2a/{id}`、Pi 给 `/rpc`）；"卡片 URL / 同源根地址 / 带 `a2a/{id}` 的代理地址"三种输入都正确。卡片 URL 必须与 target **同源**，跨源拒绝且不发送 Bearer，错误文案 `card endpoint origin mismatch` 不回显卡片 URL。
  - **method 协商**：优先 `supportedInterfaces[]` 中 `protocolBinding=JSONRPC` 条目的 `protocolVersion`，其次顶层 `protocolVersions[]`，再次顶层 `protocolVersion`；`1.x` → `SendMessage` / `GetTask` / `CancelTask`；`0.x` → `message/send` / `message/stream` / `tasks/get` / `tasks/cancel`。**卡片在、无版本声明 → 默认 v0.3**；**取不到卡片 → 降级（输入路径 + v0.3）**——两条触发条件不同，必须分开测。`GetTask` 的 params 统一 `{ id }`（不按版本分支），`CancelTask` 按版本分支；`X-A2A-Version` 跟协商结果（`1.0` / `0.3`）；v1.0 一律走同步，即使卡片声明 `streaming: true`。
  - **报文适配**：只做四件——`SendMessage` 的 `{task}`/`{msg}` 解包、`TASK_STATE_*` → 内部小写状态（未知值不当作终态）、part 缺 `kind` 时按成员判别、`GetTask` 的 `{id}`。适配边界限定在 `A2aClient` 收发边界，内部模型不变；**不做** v1.0 流式事件（`SendStreamingMessage` / `{statusUpdate}` / `{artifactUpdate}`）。
  - 不在网关侧做 method 名转换（网关 method-agnostic）。
- **验收**：
  1. 使用 fork 后的包，`a2a_send` 经网关完成全链路（`kind=request` + 轮询拿到 artifact），无需 DSH agent 手工拼 URL 或改方法名。
  2. 对只提供 `agent.json` 的 target，回退路径仍能发现（兼容性不回归）。
  3. 对明确声明 v0.3 的 target（dsh-a2a 自身 server 即此形态），仍走 `message/send`，裸 Task 解析正确。
  4. 对结论为 v1.0 的 target：`{task}` 可解包、`TASK_STATE_*` 归一为内部状态、part 无 `kind` 时仍能取到文本。
  5. 无卡片 target 走降级路径；卡片在但无版本声明走默认 v0.3——两条分别有用例。
- **状态**：待实现（根因已复核纠正；2026-10-25 范围扩到报文适配）
- **前置**：无
- **备注**：
  - **网关侧的 `agent.json` 别名整项取消（2026-10-24 决）**。老客户端请求的是 origin 根路径，那里没有 agent id，别名对故障模式无效；正确路径是升级到 `0.4.0`。结论登记进 delta spec 偏离清单，形态为"评估过、不做"。
  - **默认值纠正**：早期版本写"卡片未声明 → 默认 v1.0（`message/send`）"是把 `message/send` 误当成 v1.0 方法名的笔误；真实对应是 v1.0 → `SendMessage`。默认值改为 **v0.3**。
  - **已知网关约束（本轮不修）**：网关的 `supportedInterfaces[].protocolVersion` 恒为 `1.0`，与顶层 `protocolVersions` 可能矛盾；客户端按接口条目优先，故经网关一律按 v1.0 调用上游。

---

### R2：profile 双支持（web + tui）

- **来源**：2026-10-23 讨论；调查文档 `2026-10-23-tui-profile-install-investigation.md`（三次修订，实测验证版）
- **现状**：**已确认同一个包可同时支持 web 和 tui profile，无需修改代码。** 调查结论：
  - 宿主半（`lib/index.js`：A2A HTTP 服务、`a2a_*` 工具、agent 会话）与 profile 类型无关；浏览器半（`client/client.js`）只在 web 前端加载。
  - `dsh.client` 段**不是安装门控**，对 tui-only profile 是惰性的——tui-only profile 根本不挂载 `@deepseek-ai/dsh-client-modules`，不会扫描、不会校验 `dsh.client`。
  - 真正决定“安装/成为 profile 层”的是 `dsh.bundle`、`evaluatePluginCompatibility`（`engines.dsh` / peer 范围）、pnpm 安装本身。本包三者均满足。
  - 用真实 tui profile 副本实测 `dsh plugin --profile tui add @celumin/dsh-a2a` **成功**；`dsh.profile.bundles` 自动追加；`--dump-config` 出现 `a2a` 行；启动后 `127.0.0.1:7310` 正常监听；`message/send` 链路通过（echo 模式实测）。
  - 真实环境里出现过的安装失败是**其它插件的 peer 兼容性拒绝**（`installation rejected: Plugin @argszero/cordis-plugin-subagent-wait@0.1.1 is incompatible`）或 **pnpm 权限问题**（`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`），与本包的 `dsh.client` 无关。
- **结论**：**R2 关闭，无需修改。** 原“只能 web profile”的判断被实测推翻。
- **仍需记录的运维约束**（不是代码需求，写进 README）：
  1. **不要删 `dsh.client` 段**：它是 web 运维面板的加载声明；删掉后 web 服务端照常运行，但面板不渲染（页面不报错）。
  2. **tui 下显式配置 `provider`/`model`**：`src/bridge.ts:377` 回退 `ctx.agentDefaultModel`（来自 `dsh-base`，默认 `deepseek-official/deepseek-flash`），TUI 的 `/model` 选择另存于 `~/.dsh-tui/model.json`，两者不一定同步。A2A 自动创建的会话可能用 base 默认模型而非 TUI 当前模型。缺 API key 时得到明确的 failed 任务，不会静默成功。
  3. **改配置直接编辑 `~/.dsh/profiles/<name>/cordis.patch.yml` 的 `a2a` 行**，不要改包内 `cordis.patch.yml`（会被更新覆盖），不要改 `cordis.yml`（空根入口）。patch 是整体替换 `config`，不是深合并——想保留的配置一次写全。
  4. **web + tui 同时运行**：给其中一个换 `port`（如 web 7310、tui 7311），否则 `EADDRINUSE`（插件只记日志，不阻断加载，但入站 A2A 只到先启动的实例）；两个进程共用 `$DSH_HOME/a2a/context-sessions.json`，新会话写入可能互相覆盖。
  5. **安装失败排查顺序**：先拿 `pnpm.log`，再看其它插件的兼容性拒绝，再看 pnpm 权限，最后才看 `dsh.client`（它只影响 web 浏览器半）。
- **状态**：已关闭（实测验证；无需修改代码）
- **备注**：若未来真的需要在 TUI `/settings` 里编辑配置，需要 `ctx.tuiSettingsSections.register(...)` + `volatile` Config，属于额外功能，不是 R2 的范围。

---

### R3：mDNS 发现（网关优先，P2P 降级）

- **来源**：2026-10-23 讨论；`docs/ROADMAP.md` Round 7；`a2a-way` 的 `fix_a2a_way.md` P5
- **期望**：
  - **发现目标**：网关优先，P2P 降级。同时发现网关和目标 agent 时，默认经网关转发（保留鉴权、路由、审计）。
  - **P2P 降级条件**：网关不可达，或显式配置 `MDNS_P2P_ONLY=true`。P2P 不经过网关审计，日志与 UI 必须标明。
  - **TXT 字段**：只放 `proto`/`cardUrl`/`caps`/`ver`/`discoveryVer`，**不放 workspace 名、secret、任何凭据**。
  - **发现层不做鉴权**：TXT 可伪造，候选必须拉 AgentCard + 过 allowlist 才信任。
  - **抄 pi-a2a 的工程细节**：健康探测兜底、`down` 事件不删 peer、地址选择过滤虚拟网卡 + 同网段优先、同机 presence 兜底、实例名带 pid 后缀。
  - **不抄 pi-a2a 的 `wsh` 互认模型**：在 TXT 里放 workspace hash 做发现层鉴权，与 A2A 草案“发现层不可信”原则冲突。
- **验收**：
  1. 同时发现网关和目标 agent 时默认走网关；P2P 仅在网关不可达或显式配置时启用。
  2. 未过 AgentCard + allowlist 的候选不注册、不显示为可用。
  3. TXT 不含任何凭据/workspace 标识。
- **状态**：待实现（依赖 `a2a-way` 的 P5 落地；P5 未定稿前不启动）
- **前置**：`a2a-way` Round 7 的“网关广播自身”可用。
- **备注**：具体实现建议写在 fork 包 README；不在 `a2a-fleet` 需求文档中展开。底层协议 RFC 6762/6763 是正式标准，A2A 专用发现约定 `draft-jakab-dawn-agent-discovery-mdns-00` 仍是 Informational I-D。

---

### R4：配置形态文档化

- **来源**：`a2a-way` 联调记录 2026-10-22 §8.2；调查文档 “TUI 下修改配置的最省事路径” 节
- **现状**：新版 dsh-a2a 是扁平 schema、不读文件，配置入口是 profile 的 `cordis.patch.yml` 追加 `id: a2a` 条目；旧文档（含 2026-10-18 记录）的 `a2a.json` 写法已过时。`--dump-config` 只验证 patch 组合，不验证 schema。
- **期望**：
  - README 明确新版配置入口是 `cordis.patch.yml`，标注旧 `a2a.json` 写法已过时。
  - 给出 **web** 与 **tui** 两种 profile 的配置示例（tui 需显式 `provider`/`model`）。
  - 写明 patch 语义是整体替换 `config`（不是深合并），建议一次写全或从 `cordis.patch.example.yml` 复制。
  - 写明密钥用 `env:A2A_TOKEN` 形式，不要把明文 token 写进 patch。
  - 写明 web 运维面板的 base URL / Bearer token 存在浏览器 `localStorage`/`sessionStorage`，不写 profile 的 `a2a` 行；改 `port`/`mode`/`provider` 请编辑 `cordis.patch.yml`。
  - 写明 web + tui 同时运行的端口与持久化冲突（同 R2 的运维约束 4）。
- **验收**：README 按上述结构更新；两种 profile 的示例可直接复制使用；旧 `a2a.json` 的引用处标注“已过时，见 cordis.patch.yml”。
- **状态**：待实现
- **前置**：无（R2 已关闭，tui 示例可直接写）
- **备注**：与 R2 的运维约束共享内容，R4 是“写进 README”，R2 是“确认无需改代码”。

---

### R5：出站 A2A 调用对网关错误码的识别（`-32006` / `-32005` / `-32003`）

- **来源**：`a2a-way` Round 2（出站凭据注入 + 多 principal + 严格所有权）交付；`fix_a2a_way.md` P3 原语 2 与 P2 的五段格式
- **现状**：网关有两类不可重试错误码——`-32005`（`call depth exceeded`，环路）与 `-32006`（`outbound credential unavailable` / `outbound target mismatch`，注入被拒）。客户端本身**没有自动重试**（`sendForText` 流式失败直接抛出，不回落同步），`A2aRpcError` 也已原样保留 `code` 与网关 message。缺的是**模型可见的分类**：工具输出只有 `{ok:false, detail:"远端 A2A 返回错误 -32006: ..."}`，模型无法区分"可重试的上游不可用"与"不可重试的策略拒绝"。
- **期望**：
  - `a2a_send` / `a2a_task_status` 输出增加 `error_code`（number）与 `retryable`（boolean）：`-32005`/`-32006` → `false`；`-32003` → `true`；其他未知码 → 两个字段都缺省。
  - 错误信息原样保留网关的固定 message（`call depth exceeded` / `outbound credential unavailable` / `outbound target mismatch`），不改写、不吞掉。
  - `-32003`（上游不可用）仍按现有可重试策略处理，不得因本轮改动变成"所有网关错误都不重试"。
  - `metadata._a2a_depth` 在出站时递增（若 dsh-a2a 支持携带 metadata），配合网关的环路保护。
- **验收**：
  1. 目标网关返回 `-32005` 时，dsh-a2a 不重试，错误信息含 `call depth exceeded`，且输出 `retryable=false`。
  2. 返回 `-32006` 时，不重试，错误信息含网关的固定 message（两种子类之一），且 `retryable=false`。
  3. 返回 `-32003` 时，`retryable=true`，按现有可重试策略处理。
- **状态**：待实现（并入 Round 2.5 范围）
- **前置**：无（`a2a-way` Round 2 已于 2026-10-24 交付，`-32005`/`-32006` 错误码目录稳定）
- **备注**：这条不要求 dsh-a2a 理解 `-32006` 的业务含义（caller/authority 匹配），只要求“不重试 + 保留 message”；排障由网关的 linktest 和 admin 面板负责。并入 Round 2.5 后，fork 包第一个版本即包含此修复。

---

### R6：caller 名与网关 `A2A_PEER_TOKENS` / `A2A_AUTH_TOKENS` 的一致性文档

- **来源**：`a2a-way` Round 2 决策（No.54）；`fix_a2a_way.md` P2 的五段格式
- **现状**：网关的四段/五段格式里 `caller` 必须与 `A2A_PEER_TOKENS`（Hermes 侧）和 `A2A_AUTH_TOKENS`（网关侧）的键一致（如 `pi-gw-agent`）。网关**不做名字映射**。dsh-a2a 的出站工具和 mDNS 广播如果用了不同的名字（如 `dsh-agent` vs `dsh`），会导致“配了但永远不命中”。
- **期望**：
  - README 写清：dsh-a2a 的 `peerName` / mDNS 广播的 `name` / 网关配置的 caller 名必须一致。
  - 给出一个“名字一致性检查”的小节（三个位置各写什么、不一致会怎样）。
  - 如果 dsh-a2a 未来支持 mDNS 广播（R3），广播的 `name` 也要遵循这条。
- **验收**：README 有“名字一致性”小节；示例中三处名字一致。
- **状态**：待实现
- **前置**：无
- **备注**：这是**文档需求**，不是代码需求；网关不做名字映射是刻意的（避免隐式转换带来的调试困难）。

---

## 后续需求

新增需求按 R7、R8…… 追加，保持“来源 / 现状 / 期望 / 验收 / 状态 / 前置 / 备注”字段。

---

## 与 `a2a-fleet` docs/ROADMAP 的映射

| 本文件 | `docs/ROADMAP.md` 轮次    | 说明                                          |
| ------ | ------------------------- | --------------------------------------------- |
| R1     | Round 2.5                 | fork 并发布包的核心范围                       |
| R2     | —                         | 已关闭（实测验证无需修改）；运维约束进 README |
| R3     | Round 7（依赖 P5）        | mDNS 发现，网关 P5 落地后启动                 |
| R4     | Round 2.5（立即可做部分） | 配置文档化，不依赖 R1/R2                      |
| R5     | Round 2.5                 | 识别网关新错误码（`-32005`/`-32006` 不重试），并入 fork 包第一个版本 |
| R6     | Round 2.5（立即可做部分） | 名字一致性文档，与 R4 一起做                  |

**优先级建议**：R1 + R4 + R5 + R6 一起进 Round 2.5（fork 包的第一个版本）；R3 等 `a2a-way` Round 7 落地；R2 已关闭，只在 README 里保留运维约束。

## 维护说明

- 本文件的每条需求在实现后更新状态与版本号，不删除历史条目。
- 若上游（`zyfgood/dsh-a2a`）修复了某条，标注“上游已修复，可切回上游”并保留 fork 的改动记录。
- 需求编号（R1、R2……）不复用；已关闭的保留编号，避免引用漂移。
