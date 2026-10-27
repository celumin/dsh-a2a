# 评审：0.6.0 出站报文按版本切换 + 0.5.0 遗留修复（设计 spec v2）

- **评审对象**：`docs/superpowers/specs/2026-10-26-client-v1-outbound-and-v1-followups-design.md`（定稿 v2）
- **对照**：`docs/superpowers/plans/2026-10-26-client-v1-outbound-and-v1-followups.md`、`docs/requirements.md` R8、`docs/superpowers/specs/2026-10-25-server-v1-aliases-design.md`（0.5.0）
- **证据基线**：工作区 `@celumin/dsh-a2a@0.5.0`（`package.json`），`git log` HEAD `cd82893`；只读评审，验证性运行在 `/tmp` 副本上进行
- **提示词**：`docs/prompts/2026-10-26-review-spec-prompt-ruling-sufficiency.md`

**结论：需修 10 处再进计划（4×P1 / 6×P2）。**

主方向（R8 出站切形状、单一方法名真值、测试内联 strict proxy）是对的，裁定也都选得对；问题集中在三类：**plan 里的断言与同一份 plan 的实现规则互斥**、**"非法输入不抛"这条公开承诺只覆盖了三个形状**、**push 配置族在 v0.3 侧的两个等价名没有交代**。

---

## P1

[P1] §2 目标 M3 承诺"`toV1Task` 对非法输入不抛"，§3.4 只兜住 3 个形状，照做仍会抛 TypeError（§2 / §3.4 / §4 矩阵 13–14）
位置：spec §2 目标（M3）与 §3.4 ↔ `src/protocol.ts:541-563`（`toV1Task`）、`:502-510`（`v1TaskState`）、`:512-522`（`v1Part`）；plan Task 5 Step 3
问题：在 `/tmp` 副本上直接跑 `lib/protocol.js`，以下输入全部抛异常或产出非法值：`{kind:'task',id:'t',contextId:'c'}`（缺 `status`）→ `TypeError: reading 'state'`；`status:null` → 同；`history:'x'` → `task.history.map is not a function`；`artifacts:[{}]` → `reading 'map'`。§3.4 只定义了"state 非法""part 非对象/未知 kind""message.parts 非数组"三种，矩阵 13–14 也只测这三种；一个善意实现者按 TDD 走完矩阵就会认为 M3 达成，而 `toV1Task` 是 `./protocol` 的公开导出（`package.json` `exports`），JS 调用方传结构错误的 task 仍会崩。requirements.md 最终会把"M3 toV1Task 兜底"记为已完成。
建议：要么把 §2 那句话改窄成"**M3 覆盖 §3.4 列出的三种非法形状**，其余结构错误（task/status 缺失、history/artifact.parts 非数组）仍抛"，并在 §4 加一行断言 `toV1Task({kind:'task',id:'t',contextId:'c'})` 的期望（抛或返回 `{..., status:{state:'TASK_STATE_UNSPECIFIED'}}`，二选一写死）；要么把 §3.4 扩到 `status`、`history`、`artifact.parts` 三个入口并补对应断言。

[P1] plan Task 5 的兜底测试与它自己的 `v1Part` 规则互斥，按字面实现永远绿不了（§3.4 / §4 矩阵 14）
位置：spec §3.4 ↔ plan Task 5 Step 1（`docs/superpowers/plans/2026-10-26-...md:412-416`）与 Step 3（`:476`）
问题：Step 3 写"`v1Part`：非对象 / **kind 非 text|data|file → undefined**"，Step 1 却断言 `parts:[{kind:'video',text:'x'}, null, {text:'ok'}]` → `[{text:'ok'}]`。字面实现下 `{text:'ok'}` 没有 `kind`，也落进"kind 非三型"→ 被过滤，得到 `[]`，断言失败；反过来若改用成员判别保留它（像 `compat.partKind` 那样），`{kind:'video',text:'x'}` 又有 `text` 成员，会被保留成 `{text:'x'}`，断言同样失败。能同时满足断言的规则只有"**显式 kind 未知 → 丢弃；缺 kind → 按成员判别**"，而 spec §3.4、矩阵 14、plan Step 3 都没写这条。执行者到 Step 4 会面对一个不可能变绿的用例，只能自己发明规则或改用例迁就实现——这正是 plan 自己禁止的"改用例迁就实现"。
建议：在 §3.4 写死这条二分规则（"`part.kind` 存在但不是 text/data/file → 省略；`part.kind` 缺失 → 按 text/data/file 成员判别，判不出再省略"），矩阵 14 补一行"缺少 kind 的 `{text:'ok'}` → `[{text:'ok'}]`"；或者保留"只认 kind"的简单规则，把 fixture 改成 `{kind:'text',text:'ok'}`（期望 `[{text:'ok'}]`），并删掉无 kind 的那一项。

[P1] push 配置族的 v0.3 等价名只写了 set/get，`/list`、`/delete` 没有交代——实现者补齐就会悄悄改掉已发布的 v0.3 行为（§3.3 / §6）
位置：spec §3.3（路由表与"与 v0.3 的两个等价名共用同一个分支"）↔ `src/server.ts:381-382`（只处理 set/get）、`src/server.ts:16`（注释写 `tasks/pushNotificationConfig/*` → -32003）、`src/en…` 无；`tests/smoke.mjs:483-486`（只测 set）
问题：0.6.0 把 4 个 v1 push 名字都映射到 `pushConfig` → `-32003`，但表里 v0.3 侧只有 `set`/`get`；A2A 0.3 的 push 配置方法集还有 `/list` 与 `/delete`（`server.ts:16` 的 `*` 注释也是这么承诺的），它们今天走 default → `-32601`。于是同一个能力：v1 客户端拿 `-32003` + `1.0`，v0.3 客户端拿 `-32601` + `0.3.0`。一个读着"与 v0.3 等价名共用同一分支"的实现者，看到这个不对称会顺手把 `/list`、`/delete` 加进 `RPC_ROUTES`（两行，看起来就是修 bug），而这就把已发布行为从 `-32601` 改成了 `-32003`——§6 风险表只登记了"4 个 v1 名字从 -32601 变 -32003"，没有登记 v0.3 侧的变化。反向选择（保持 `-32601`）则和"共用同一分支"的说法自相矛盾，文档没给依据。
建议：§3.3 明确写"v0.3 的 `tasks/pushNotificationConfig/list` / `/delete` 本轮**不进**表，仍 `-32601`；理由：不扩大 v0.3 线上行为变化（要改就单独登记为 0.6.0 行为变化并补矩阵行）"；同时修正 `src/server.ts:16` 的 `*` 注释，并在矩阵 8 后加一行断言 `tasks/pushNotificationConfig/list` 的期望码。

[P1] R8 的验收含"同时回归 Pi/Hermes 两条宽容链路"，矩阵里没有对应行、Task 6 却直接把 R8 标成已完成（§5 / §4 / §4 矩阵 17）
位置：spec §5（"真实 Pi/Hermes 联调仍是人工/第三会话步骤（写进 §4 验收与 README）"）、§4 矩阵 ↔ `docs/requirements.md:169`（R8 验收）、`:170`（状态）、plan Task 6 Step 2
问题：requirements.md 的 R8 验收原文是"以 0.5.0 服务端的 v1.0 模式（或独立严格 fixture）为对端，断言请求体形状；**同时回归 Pi/Hermes 两条宽容链路**"。矩阵 1–17 只覆盖仓库内等价物（36 个 fixture/回环用例），§5 把真实联调推给"人工/第三会话步骤，写进 §4 与 README"，但 §4 没有这一行、Task 6 的 README 改动清单也没有这一项，而 Task 6 Step 2 会写 `状态：已完成（0.6.0）`。结果是"完成"的证据里缺了需求原文的一半，且事后无法区分"跑过并通过"与"没跑"。仓库内 v0.3 capture 确实是宽容链路的等价物（v0.3 请求体不变），但它证明不了"对方接受新的 v1 形状"这一半。
建议：在 §4 加一行"18 | 真实 Pi/Hermes 各一次 `a2a_send`（卡片/端点写进 README 联调记录）| 成功 + 对端回包形状记录"，并在 Task 6 Step 1 明确 README 要落一条带日期的联调记录；若本轮不做真实联调，则 Task 6 只把 R8 标成"已完成（0.6.0，仓库内验收；真实 Pi/Hermes 待联调）"，不要写"已完成"。

---

## P2

[P2] §3.3 承诺的四条一致性断言，plan 只落了 compat 的两条；`RPC_ROUTES` 相关两条既没测试也没导出（§3.3）
位置：spec §3.3 末尾（`...:134`）↔ plan Task 4 Step 1（只有 `V1_METHOD_NAMES/V1_ALIASES` 的 compat 用例）、`src/server.ts:363-390`（改成 `private static readonly RPC_ROUTES`）
问题：spec 要求兜住 `V1_ALIASES ⊆ V1_METHOD_NAMES`、每个 `v1:true` 路由键 ∈ `V1_METHOD_NAMES`、`V1_ALIASES` 的路由 handler 不是 `pushConfig`、其余 v1 名字 `isV1Method === false`。plan 只写了第一组的一半和第四条；没有任何用例遍历 `RPC_ROUTES`，而它是 `private static`（测试得靠运行时访问 `A2aServer.RPC_ROUTES` 才拿得到）。M2 要解决的正是"三处真值漂移"，现在真值仍有三处（`V1_METHOD_NAMES` / `V1_ALIASES` / `RPC_ROUTES.v1`），唯一能挡住"新增一条 `v1:true` 但名字不在 `V1_METHOD_NAMES`"的断言没落地。行为侧用例能覆盖现有条目，但覆盖不了"以后加错一行"。
建议：把 `RPC_ROUTES` 导出（或加 `export function v1RouteNames()`），在 compat 里补三条断言：`for (const a of V1_ALIASES) assert(V1_METHOD_NAMES.includes(a))`；`for (const [m,r] of Object.entries(RPC_ROUTES)) if (r.v1) assert(V1_METHOD_NAMES.includes(m))`；`for (const [m,r] of Object.entries(RPC_ROUTES)) if (r.handler === 'pushConfig') assert.equal(r.v1, V1_METHOD_NAMES.includes(m))`。

[P2] M5 的边界没写全：矩阵 12 的"文案不变"与 §3.5 的"文案含原始值"互斥，非字符串头的 `raw` 也没有定义（§3.5 / §4 矩阵 12）
位置：spec §3.5（3 步规则）与 §4 矩阵 12 ↔ plan Task 5 Step 1（`checkVersionHeader` 断言）、`src/server.ts:283-292`
问题：(a) `X:'' + A:2.0` 这一行，选中值从今天的 `''` 变成了 `'2.0'`，按 §3.5"文案含原始值"必然输出 `unsupported A2A version 2.0…`，与矩阵 12 的"文案不变"直接矛盾；smoke 用例只断言 400、不断言文案，所以两种读法都能"通过"。(b) `checkVersionHeader(x: unknown, a: unknown)` 允许 `string[]`（Node 的 `IncomingHttpHeaders` 类型），plan 的用例 `[['1.0'], undefined]` 要求 `ok:false`，但返回类型写的是 `{ok:false, raw:string}`——数组时 `raw` 填什么没规定，实现者会各自猜 `String(x)` / `JSON.stringify(x)`，400 文案随之不同。（顺带：plan:470 担心"undici 把空头丢掉导致用例不失败"，实测 node fetch 会把 `X-A2A-Version: ''` 原样发出、服务器看到空串，这条可以按真 RED/GREEN 处理。）
建议：把矩阵 12 的"文案不变"改成"400，错误体含**选中的**值（`X:''+A:2.0` → 含 `2.0`）"，并给 smoke 用例加 `assert.match(await response.text(), /2\.0/)`；§3.5 补一句"非字符串（数组）头 → `ok:false`，`raw` 用 `Array.isArray(x) ? x.join(',') : String(x)`"。

[P2] `sendStream` 守卫只钉了 message、没钉 `error.code`，而"为什么是 -32601 而不是 -1"没有论证——后者会被判为可重试（§3.2 / §7 裁定 3）
位置：spec §3.2 守卫与 §7 裁定 3 ↔ plan Task 2 Step 1（`assert.rejects(..., /v1\.0 streaming is not supported/)`）、`src/compat.ts:213-217`（`classifyError(-1) → {retryable:true}`）、`src/tools.ts:57`
问题：裁定 3 的反事实很充分（v1 帧被跳过 → 静默空数组），但只论证了"抛 vs 不抛"，没论证码值。客户端侧错误惯例是 `-1`（传输/本地错误），`A2aRpcError(-1, …)` 会被 `classifyError(-1)` 判成 `retryable:true`，工具层把 `retryable` 交给模型，模型会对一个必然失败的调用反复重试；`-32601` 落进 `classifyError` 的 `{}`（不表态）。这是选 `-32601` 的真实理由，但文档没写。plan 的用例只 `assert.rejects(..., /v1\.0 streaming is not supported/)`，不检查 `error.code`，所以实现者改成 `-1`（"客户端错误码应该是 -1"）或用例全绿。
建议：在 §3.2 补一句反事实"用 `-1` 会被 `classifyError` 标成 `retryable:true`，工具层会建议重试一个必然失败的调用；`-32601` 不表态，也让错误码与对端的 `SendStreamingMessage` → `-32601` 对齐"，并把用例改成 `assert.rejects(..., (e) => e.code === -32601 && /v1\.0 streaming/.test(e.message))`。

[P2] Task 6 的 README 清单漏了 §五 的两处旧断言，改完会同时存在"出站仍是 v0.3"和"出站随版本切换"（§3.7）
位置：spec §3.7（README 改动只有 §四/§五补一句/§六第 1 条）↔ `README.md:279`、`:300`
问题：`README:279` 写"出站客户端行为不变（仍是 v0.3 形状，见 §六第一条）"，`:300` 写"0.5.0 的 v1.0 入口……**可用于** 0.6.0 出站报文按版本切换……让 0.4.0 客户端指向它"。Task 6 只改 §六首条与 §四新增小节，这两句会留着：同一篇 README 里 §四说"出站按协商版本切 v1 形状"、§五说"出站行为不变（仍是 v0.3）"，读者无从判断哪个是当前行为；`:300` 还会把已发布能力写成未来计划。
建议：§3.7 的 README 清单加两条：`README:279` 的"出站客户端行为不变（仍是 v0.3 形状）"改为"出站形状随协商版本切换（0.6.0，见 §四）"；`README:300` 整段从"可用于"改成"0.5.0/0.6.0 起该入口即 strict fixture 的生产侧，回归用例是 tests/smoke.mjs 的 strict proxy 用例"。

[P2] 0.5.0 spec §3.1 的响应头表与 0.6.0 §3.3 相反，仓库里会并存两套规范；§3.6 的"spec §3.3"也是跨版本悬空引用（§3.3 / §3.6）
位置：spec §3.3 ↔ `docs/superpowers/specs/2026-10-25-server-v1-aliases-design.md:55-56`（"SendMessage/GetTask/CancelTask → 1.0；**其他** → 0.3.0"）；spec §3.6（`...:158`，"spec §3.3 的裁定"）
问题：0.5.0 spec 明确写"其他（message/send、message/stream、tasks/*、resubscribe）→ 0.3.0"，0.6.0 把 11 个名字（含 ListTasks/push 族）改成 1.0；0.6.0 §3.7 的文档清单只改 requirements/README，没有说明 0.5.0 spec 的这条被取代。两份 spec 都在 `docs/superpowers/specs/` 下、都被 0.6.0 当作"关联/前置"引用，后来者按 0.5.0 §3.1 实现就会把 M1 改回去。同理 §3.6 的"（spec §3.3 的裁定）"指的本是 0.5.0 spec §3.3（入站归一），本轮 spec 自己的 §3.3 是方法名表。
建议：在 0.5.0 spec §3.1 表头加一行"0.6.0 起由 `2026-10-26-...-design.md` §3.3 取代（v1 名字全集 11 个，push 配置族也在内）"，或至少在 0.6.0 §3.7 的文档清单里加这条；把 §3.6 的引用改成"0.5.0 spec §3.3"。

[P2] requirements.md 的基线行没跟着 0.6.0 更新，R8 标完成后文档自相矛盾（§3.7 / 需求条目状态）
位置：spec §3.7（requirements.md 只改 R8 条目）↔ `docs/requirements.md:6`（"当前基线 0.3.1；下一个交付 0.4.0"）与 `:164-172`（R8）
问题：Task 6 把 R8 写成"已完成（0.6.0）"、`package.json` 升到 0.6.0，但文件头仍说基线是 `0.3.1`、下一个交付是 `0.4.0`。同一份需求文档里"下一个交付 0.4.0"和"R8 已完成（0.6.0）"并存，`R7` 映射表也还写"0.4.0 明确不做"。这是评审提示词第 5 类（版本号/发布步骤与需求状态不一致），且修改成本一行。
建议：Task 6 Step 2 追加"基线行改为 `@celumin/dsh-a2a@0.6.0`（npm 已发布）/ 下一个交付 `0.7.0`（待定）"，并同步 `:193` 的 R8 行说明。

---

## 裁定审计表

| 裁定 | 结论正确? | 理由充分? | 缺什么（反事实 / 相邻概念区分） |
| --- | --- | --- | --- |
| §7#1 push 配置族 ∈ `V1_METHOD_NAMES`、∉ `V1_ALIASES`，走 `pushConfig` → `-32003` + 头 `1.0` | 是 | 部分 | 反向理由（不纳入则 M1 漏 4 个；加进 ALIASES = 实现推送）很硬，也明确区分了"判头集合"与"分发集合"。缺的是"有 v0.3 等价名"（set/get）与"只在 v1 存在"（List/Delete）的区别，导致 v0.3 侧 `/list`、`/delete` 无交代 → P1-3 |
| §7#2 空 X 等价没带、回落 A；`A:2.0` → 400；`A:""` → 200 | 是 | 是 | 反事实明确（空 X 压制 A 会让 `2.0` 静默通过），"空 vs 没带"与"X vs A"两个相邻概念都分开了。未定义：非字符串头（数组）的 `raw` 与 400 文案 → P2-2 |
| §7#3 真实 v1 服务端上 `sendStream` 发请求前抛 `-32601` | 是 | 部分 | "抛 vs 不抛"的反事实是全文最好的一条（v1 帧被静默跳过 → 既无错误也无事件）。缺"为何是 -32601 而非 -1"的反事实（`classifyError(-1)` → `retryable:true`，会诱发重试）→ P2-3 |
| §3.4 未知 kind / 非对象 part → 从输出省略（绝不出现 `null`） | 是 | 否 | 只给了"`null` 更糟"，没有"抛错 vs 省略"的反事实；也没区分"畸形输入"与"未来协议新增 part 类型"（内部模型只有三型，实际只可能来自 JS 调用方，影响低）。真正的漏洞是"缺 kind 的 part 走哪条规则"没定义 → P1-1 |
| §3.4 `v1Message` 入参非对象 → `{}` | 可疑 | 否 | 没说不省略 `status.message` 的理由。`{}` 不是合法 v1 Message（无 `role`/`parts`），只是把"缺字段"换成了"另一种非法形状"；省略更干净。影响仅限 JS 调用方，不单列条目 |
| §3.6 M4 不改行为、只补两条测试 + README 一句 | 是 | 是 | 依据是 0.5.0 spec §3.3 的既有裁定与已发布字节，反事实清楚（改行为 = 破 0.5.0）。用例前提已核对成立：`prepareTask` 把请求 message 原样放进 history（`src/server.ts:406-427`），无 metadata 时 history 项确实没有该键 |
| §2/§6 不切默认版本、不加"强制 v0.3 出站"开关，回滚 = 降包版本 | 是 | 是 | 反事实明确（两套形状分叉成两套线上行为），回退路径可执行（`dsh plugin add @celumin/dsh-a2a@0.5.0`），并区分了"配置开关"与"版本回退" |
| §5 strict proxy 只存在于 tests，不进生产代码 | 是 | 是（自明） | 生产侧无此需求；proxy 校验 role/kind/part 成员，恰好覆盖 R8 的期望形状；不影响公开 API |

---

## 越界发现

1. `src/server.ts:16` 的模块注释声称 `tasks/pushNotificationConfig/*` → `-32003`，实际 dispatch 只有 `set`/`get`（`src/server.ts:381-382`）——注释先于实现许诺了四个方法（P1-3 的根）。
2. `normalizeTask`（`src/compat.ts:138-168`）只归一 `status.state` 与 part 的 `kind`，没有回译 `role`：v1 响应的 `history[].role` 仍是 `ROLE_AGENT`，`A2aClient.send()` 返回的 Task 里会同时出现小写 `user` 与大写 `ROLE_AGENT`。0.4.0 的"v1 响应归一"并不完整。
3. `classifyError(-32003)` 返回 `retryable:true`（`src/compat.ts:213-217`，注释"上游不可用"），而本服务端把同一个码定义为 `PUSH_NOTIFICATION_NOT_SUPPORTED`（`src/protocol.ts:297-303`）并用于 push 配置族——同一错误码两种语义，客户端会建议对"不支持推送"重试。

---

## 我没能确认的

1. **"0.5.0 已发布"找不到仓库证据**：`git tag` 只有 `v0.2.1`；`package.json` 是 0.5.0 且 `lib/` 是构建产物，但无法从仓库确认 npm 上的 0.5.0 对应哪个 commit，也找不到"0.5.0 分支终审"产生 M1–M5 的原文（`docs/superpowers/reviews/` 此前不存在，只有本轮新建的 `reviews/specs/`）。R8 的前置（严格 v1 入口存在）在代码层面成立，不影响本轮实现，但"已发布基线 = 某提交"无法证实。
2. **11 个 v1 方法名与 4 个 push 名字的官方性**：仓库里没有 A2A v1 proto/规范副本，我按 a2a v1 proto 的方法集核对（`ListTasks`/`SubscribeToTask`/`GetExtendedAgentCard`/`*TaskPushNotificationConfig(s)`）。如果这张表要长期维护，建议 §3.3 写明来源（proto 文件与版本），否则下一个人只能靠记忆增删。
3. **"只切 message 形状"能否过真实严格 ProtoJSON 服务端**：§6 已承认可能还要求 `timestamp` 为 `{seconds,nanos}`、Struct 形态等；仓库内没有真实严格对端的抓包（`docs/debug/A2A_pi_agent_communication.md` 是历史记录且端口/token 已过时），无法确认。属联调发现项，不算本轮缺陷。
4. **真实 Pi/Hermes 当前接受哪种形状**：仓库内没有它们近期的 wire 抓包，所以 P1-4 只能按"验收未执行/未记录"判，无法判断真实对端会不会接受新的 v1 形状；需要联调才能关掉这一项。
