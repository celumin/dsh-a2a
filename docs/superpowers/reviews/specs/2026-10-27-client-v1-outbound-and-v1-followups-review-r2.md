# 评审（第二轮）：0.6.0 出站报文按版本切换 + 0.5.0 遗留修复（设计 spec v4）

- **评审对象**：`docs/superpowers/specs/2026-10-26-client-v1-outbound-and-v1-followups-design.md`（定稿 v4）
- **对照**：`docs/superpowers/plans/2026-10-26-client-v1-outbound-and-v1-followups.md`（v4 同步）、`docs/requirements.md` R8、第一轮评审报告
- **证据基线**：HEAD `ccca828`；`git ls-remote --tags fork` → `v0.5.0` = `e1a1b18`；`npm view @celumin/dsh-a2a dist-tags` → `{latest:"0.5.0"}`（两条都实测，基线声明成立）
- **提示词**：`docs/prompts/2026-10-26-review-spec-prompt-ruling-sufficiency.md`

**结论：需修 4 处再进计划（2×P1 / 2×P2）。**

v4 对上轮 10 条（4×P1 / 6×P2）的处置是扎实的：M3 的兜底范围从"三个例子"扩成 §3.4 的完整规则并配了反事实裁定，push 配置族的 v0.3 边界写清楚了，Pi/Hermes 不再虚报完成，§3.3 的五条不变量落到了测试，README/0.5.0 spec/requirements 三处旧说法也排进了任务。剩下的 4 条里，2 条是**新用例本身跑不通/新状态写早了**，2 条是**新引入的规则没有断言**。

---

## 上一轮 10 条处置核对

| 上轮 | 问题 | 处置 | 结论 |
| --- | --- | --- | --- |
| P1-1 | M3 承诺"不抛"但只兜 3 形状 | §3.4 扩到 task/status/容器/message；裁定 4 给了反事实；矩阵 13 | 已解决 |
| P1-2 | Task 5 用例与 `v1Part` 规则互斥 | §3.4 二分支规则 + 矩阵 14 + 用例改成 `[{text:'ok'},{data:{a:1}}]` | 已解决 |
| P1-3 | push 配置族 v0.3 `/list` `/delete` 无交代 | §3.3 明写"不进表、仍 -32601" + 矩阵 8c + 用例 + 裁定 1 + 注释修正 | 已解决 |
| P1-4 | Pi/Hermes 验收无矩阵行却标完成 | 矩阵 18 + R8 改"进行中" + §5 人工联调小节 | 已解决 |
| P2-1 | 4 条一致性断言只落 2 条 | §3.3 五条 + `RPC_ROUTES` 导出 + smoke 用例 | 已解决（M7 又带来一张新表 → 本轮 P2-1） |
| P2-2 | 矩阵 12"文案不变"与 §3.5 互斥、非字符串 `raw` 未定义 | §3.5 raw 规则 + 矩阵 12 + 用例断言文案 | 已解决（残余见裁定审计表） |
| P2-3 | `sendStream` 只钉 message 不钉码值 | §3.2 补"-32601 vs -1"反事实；用例断言 `e.code === -32601` | 已解决 |
| P2-4 | README:279/:300 旧断言 | §3.7 + Task 7 Step 1 两条 | 已解决 |
| P2-5 | 0.5.0 spec 与新 spec 并存两套头规则 | 0.5.0 spec §3.1 加取代注记（已提交） | 已解决 |
| P2-6 | requirements 基线行未更新 | Task 7 Step 2 改了，但改成"0.6.0 已发布" | 半解决 → 本轮 P1-2 |

---

## P1

[P1] M6 的 smoke 用例靠 `NEED_INPUT` 取 `status.message`，但该 runner 分支不写 message——用例在实现正确后仍会 TypeError（§3.8 / §4 矩阵 19）
位置：spec §3.8 与 §4 矩阵 19 ↔ plan Task 6 Step 1 的 smoke 用例、`tests/smoke.mjs:67-71`、`src/store.ts:273-275`
问题：echoRunner 的 `NEED_INPUT` 分支只有 `addArtifact` + `updateStatus('input-required')`，而 `updateStatus(state, message?)` 的 `message` 是可选参数——不传就没有 `status.message`。于是真实服务端返回的 v1 task 是 `{status:{state:'TASK_STATE_INPUT_REQUIRED', timestamp}}`，客户端 M6 归一后 `task.status.message` 仍是 `undefined`，`task.status.message.role` 直接抛 TypeError。plan 的 Step 2"预期失败"写的是"`status.message.role === 'ROLE_AGENT'`"，实际是访问 undefined——这个预期本身就说明 fixture 假设了一个不存在的字段；Step 4 的 PASS 不可达。`task.history[0]` 的断言是能过的（`prepareTask` 会把用户消息推进 history），所以失败会伪装成"归一逻辑没写对"，把执行者引向改实现。
建议：让该用例的 runner 真的产出一条 status.message。最省事是复用 `failed` 路径：`const srv = await startServer({ runner: { async run() { throw new Error('boom') } } })`，`startStrictV1(srv.url)` 后断言 `state === 'failed'`、`status.message.role === 'agent'`、`status.message.kind === 'message'`、`parts[0].kind === 'text'`（对端线上是 `ROLE_AGENT` + 无 kind 的 part，归一是 M6 要证的东西）。若坚持 `input-required`，就单独起一个 runner 调 `controller.updateStatus('input-required', {kind:'message',role:'agent',parts:[{kind:'text',text:'need'}],messageId:'m0'})`，并断言 `state === 'input-required'`。

[P1] Task 7 让 requirements.md 写"0.6.0 已发布"，与 Global Constraints 的"不执行 npm publish"直接冲突（§3.7 / plan Global Constraints）
位置：spec §3.7（基线行）↔ `docs/superpowers/plans/...md:24-25`（"版本 `0.6.0`；**不执行 npm publish**（人的决定）"）、plan Task 7 Step 2 / Step 3
问题：执行者到 Task 7 必须二选一——发布（违反约束）或写一条假状态。当前 npm `latest` 实测是 0.5.0，`git ls-remote` 也没有 0.6.0 tag，所以 commit 一落地，"基线：`@celumin/dsh-a2a@0.6.0` 已发布"就是错的。何况同一段里 R8 被要求写成"进行中…真实联调待执行"，读者会得到"0.6.0 已发布、但里面有条需求没完成"的自相矛盾；Task 7 是最后一个任务，没有"发布后回填"的步骤。上一轮我报的是"基线行没更新"，这一轮的修法把一个陈旧状态换成了一个提前状态。
建议：基线行改成 `@celumin/dsh-a2a@0.5.0`（npm 已发布；0.6.0 已构建、待人工发布）/ 下一个交付 `0.6.0`；或把发布拆成 Task 8（人工 `npm publish` 之后再回填基线行），并在 Task 7 明确写"发布前不要写'已发布'"。

---

## P2

[P2] M7 新增的 `PUSH_CONFIG_METHOD_NAMES` 是 4 个 v1 push 名字的第三份拷贝，§3.3 的五条不变量没有一条覆盖它（§3.9 / §3.3）
位置：spec §3.9（"push 配置方法判定"）与 §3.3（不变量清单）↔ plan Task 4 的 invariant 用例、plan Task 6 Step 3（新增 const）
问题：这 4 个 v1 名字现在同时出现在 `V1_METHOD_NAMES`、`RPC_ROUTES`、`PUSH_CONFIG_METHOD_NAMES`；前两者的关系有断言，第三份没有。若将来新增/改名一个 v1 push 方法只改前两处，`classifyError(-32003, 新名字)` 会返回 `retryable:true`——工具层会建议重试一个不支持的能力，正是 M7 要修的毛病；而 Task 6 的 compat 用例只抽查了 `CreateTaskPushNotificationConfig` 和 `tasks/pushNotificationConfig/set` 两个名字，测不出漏项。M2 花了一轮把三处真值收敛成"两集合 + 不变量"，M7 又悄悄加回一张无守卫的表。
建议：在 Task 4 的 invariant 用例里补一条（`PUSH_CONFIG_METHOD_NAMES` 从 `../lib/protocol.js` 导入）：`assert.deepEqual(PUSH_CONFIG_METHOD_NAMES.filter((m) => V1_METHOD_NAMES.includes(m)).sort(), Object.entries(RPC_ROUTES).filter(([, r]) => r.handler === 'pushConfig' && r.v1).map(([m]) => m).sort())`——两边都应是那 4 个 v1 名字；再加一条 `RPC_ROUTES` 里每个 `pushConfig` 键都在 `PUSH_CONFIG_METHOD_NAMES` 里。

[P2] §3.4 新增的"message 非对象 / `message.parts` 非数组 / `artifact.parts` 非数组"三条规则没有任何断言（§3.4 / §4 矩阵 13）
位置：spec §3.4（"数组与容器"与"message"两条 bullet）↔ plan Task 5 Step 1 的结构性用例、矩阵 13
问题：矩阵 13 列的 5 个输入只覆盖了"`history` 非数组"与"artifact 非对象"（`artifacts:[{}]`）；剩下三条——`status.message` 非对象 → 省略该 message、`message.parts` 非数组 → `[]`、`artifact.parts` 非数组 → `[]`——既没有输入也没有期望，写不写都能让 Step 4 变绿。M3 的验收语是"§3.4 列出的**全部**形状不抛"，覆盖率只有 2/5 时这句话不可验收；矩阵 13 里"`history`/`artifacts` 被省略或为空"本身也不是可断言的值（省略与空数组是两种结果）。
建议：在结构性用例里补三组输入/期望：`toV1Task({status:{state:'completed', message:'nope'}})` → `'message' in out.status === false`；`toV1Task({status:{state:'completed'}, history:[{role:'user', messageId:'m', parts:'x'}]})` → `out.history[0].parts` 深等于 `[]`；`toV1Task({status:{state:'completed'}, artifacts:[{artifactId:'a', parts:'x'}]})` → `out.artifacts[0].parts` 深等于 `[]`。同时把矩阵 13 的期望拆成"省略该字段"与"为空数组"两种，别混写。

---

## 裁定审计表

| 裁定 | 结论正确? | 理由充分? | 缺什么（反事实 / 相邻概念区分） |
| --- | --- | --- | --- |
| §7#1 push 配置族 ∈ `V1_METHOD_NAMES`、∉ `V1_ALIASES`；v0.3 `/list` `/delete` 不进表 | 是 | 是 | 两个方向的反事实都补上了（不纳入则 M1 漏 4 个；补进表是未登记的线上行为变化），"判头集合 vs 分发集合 vs v0.3 行为面"三个概念分得很清。唯一措辞瑕疵：仍说"与 v0.3 的两个等价名共用同一分支"，对 `List`/`Delete` 不成立，但上下文已说明它们不进表，不构成走偏风险 |
| §7#2 空 X 回落 A；非字符串头 `ok:false`、`raw = join(',')` | 是 | 是（基本） | 反事实在（空 X 压制 A 会让 `2.0` 静默通过），数组文案规则也补了。残余：raw 规则只命名了 `x`；若 `a` 是非字符串且 `x` 为空，`String(undefined) = 'undefined'` 会进 400 文案。Node 对重复头默认 join 成字符串、数组实际不可达，故不单列条目——若想彻底闭合，把 raw 表述改成"取**导致拒绝的那个头**" |
| §7#3 v1 `sendStream` 抛 `-32601` | 是 | 是 | 两条反事实都在（不抛 → v1 帧被跳过、静默空数组；用 `-1` → `classifyError` 判可重试、诱发重试），用例也钉了 `e.code` |
| §7#4 M3 覆盖 §3.4 全部结构性畸形；task 非对象返回退化骨架 | 是 | 是 | 反事实明确（只兜字段畸形则"缺 status"仍抛，与公开导出不崩自相矛盾），代价（把调用方 bug 变成空任务）登记进 §6 并由测试钉死形状。见 P2-2：规则全了但断言只覆盖一部分 |
| §7#5 M6 归一 `status.message` + `history[]`，未知 role 原样保留 | 是 | 是 | 两个相邻概念的取舍都给了理由（只补 role → parts 仍无 kind；猜 role 会掩盖对端 bug）。§3.8 没写"`history[]` 项非对象怎么办"（plan 是丢弃），靠 plan 消歧，影响低 |
| §7#6 M7 按方法消歧、不改数值/服务端 | 是 | 是 | 两侧代价都写了（改数值破坏协议与 0.5.0 行为；不表态丢掉 R5 的重试建议），并明确"本包工具不会命中 push 分支"。新表缺不变量 → P2-1 |

---

## 越界发现

1. spec 头部引用的第一轮评审报告仍是未跟踪文件：`git status` 只有 `?? docs/superpowers/reviews/`，提交 `016293a` 只加了链接、报告正文没进 git——别人 clone 下来会看到悬空引用。
2. `src/compat.ts:211-212` 的 `classifyError` doc 注释（"`-32003`（上游不可用）可重试"）在 M7 之后会失真；Task 6 只排了改 `tools.ts` 的 `retryable` 描述，没排这里。与刚修掉的 `src/server.ts:16` 是同一类注释/实现漂移。
3. 本地 clone 没有任何 tag（`git tag` 只有 `v0.2.1`），远端才有 `v0.4.0`/`v0.5.0`；核对"已发布基线"必须先 `git ls-remote --tags`，否则会像我上一轮那样差点误报 `v0.5.0` 不存在。建议在 spec 的基线行旁边注明"用 ls-remote 核对"，避免下一个评审者重犯。

---

## 我没能确认的

1. **真实 Pi/Hermes 会不会接受新的 v1 形状**：仓库内没有它们近期的 wire 抓包；矩阵 18 已把它列为待执行的人工项，本轮无法替它下结论。
2. **严格 ProtoJSON 是否还要求别的**（`status.timestamp` 为 `{seconds,nanos}`、Struct 形态等）：§6 已承认并列为联调发现项；仓库内没有真实严格对端的抓包，无法在本轮确认"只切 message 形状"够不够。
