# 评审（第三轮）：0.6.0 出站报文按版本切换 + 0.5.0 遗留修复（设计 spec v5）

- **评审对象**：`docs/superpowers/specs/2026-10-26-client-v1-outbound-and-v1-followups-design.md`（定稿 v5）
- **对照**：`docs/superpowers/plans/2026-10-26-client-v1-outbound-and-v1-followups.md`（v5 同步）、`docs/requirements.md` R8、前两轮评审报告
- **证据基线**：HEAD `74c426a`；`v0.5.0` = `e1a1b18`（`git ls-remote --tags fork`）、npm `latest` = 0.5.0（`npm view`），两条均实测
- **提示词**：`docs/prompts/2026-10-26-review-spec-prompt-ruling-sufficiency.md`

**结论：可以进计划（0×P1；4×P2，均为文档/提交清单的一致性小修，建议在 Task 4/5/7 里顺手改，不必再开一轮评审）。**

v5 把上轮 4 条全部修对了，而且修法本身可执行：M6 的 fixture 换成"必抛错 runner → `failed` + `agentNote`"后，`status.message` 的线上形状与归一断言终于对得上；基线声明改回 0.5.0；`PUSH_CONFIG_METHOD_NAMES` 补了双向不变量；§3.4 的容器规则补了输入/期望。剩下的 4 条都不影响"照着写会不会返工"——其中 1 条是验收矩阵里的一句期望与 §3.4 相反，另外 3 条是计划/文案的陈旧数字与清单遗漏。

---

## 上一轮 4 条处置核对

| 上轮 | 问题 | 处置 | 结论 |
| --- | --- | --- | --- |
| P1-1 | M6 用例的 `NEED_INPUT` 不产 `status.message` | 改用必抛错 runner（`failed` + `agentNote`），矩阵 19 与用例同步 | 已解决。核对路径：`executeTurn` catch → `updateStatus('failed', agentNote)` → `toV1Task` 输出 `{role:'ROLE_AGENT', parts:[{text}]}` → M6 归一回 `agent`/`kind:'message'`/`kind:'text'`；断言可达 |
| P1-2 | 写"0.6.0 已发布"但不发布 | 基线改为 0.5.0（已发布；0.6.0 待人工发布），并写明发布后回填 | 已解决 |
| P2-1 | `PUSH_CONFIG_METHOD_NAMES` 无守卫 | §3.3 加第 6 条不变量；compat 断言 4 个 v1 名字、smoke 断言 `RPC_ROUTES` 双向 | 已解决。两侧断言我逐项核过：排序后都是 `Create/Delete/Get/ListTaskPushNotificationConfig(s)` 四个；v0.3 四个前缀名不参与 `V1_METHOD_NAMES` 交集 |
| P2-2 | §3.4 三条容器规则无断言 | 矩阵 13 拆细 + 新增 13b + 结构性用例补 4 组输入/期望 | 已解决，但新写的 13 里有一句与 §3.4 相反（见本轮 P2-1） |

---

## P2

[P2] 矩阵 13 说 `artifacts:[{}]` 的 artifact 会被省略，§3.4 的规则却说对象就保留（§4 矩阵 13 ↔ §3.4）
位置：spec §4 矩阵 13（`...:271`）↔ spec §3.4"数组与容器"（"artifact 非对象 → 省略该项；`artifact.parts` 非数组 → `[]`"）、plan Task 5 Step 3
问题：`{}` 是对象，按 §3.4/plan 应保留为 `{parts:[]}`（`parts` 非数组 → `[]`），只是没有 `artifactId`；矩阵 13 却写"该 artifact 被省略"。plan 的结构性用例只断言 `status.state` 与"没有 history"，两种实现都能过，所以这条验收行没有任何断言支撑，谁都不会发现它和设计相反。一个把矩阵当检查单的人会以为实现错了，随后可能给 `toV1Task` 加一条"没有 artifactId 就丢弃"的规则——那是一条 §3.4 未授权的行为。
建议：二选一并写死——(a) 把矩阵 13 改成 "`artifacts:[{}]` → `artifacts:[{parts:[]}]`（对象保留，`parts` 非数组当空）"；(b) 若确实想丢弃无 id 的 artifact，就在 §3.4 写成"artifact 非对象**或没有 `artifactId`** → 省略该项"，并在结构性用例里补 `assert.deepEqual(out.artifacts, [])`。两者都别只留在矩阵里。

[P2] plan 的 `checkVersionHeader` 实现指令仍是"`raw = x.join(',')` / `String(x)`"，与 spec 新写的"先看 `x`，再看 `a`"不一致（§3.5 ↔ plan Task 5 Step 3）
位置：spec §3.5（`...:199`，"`raw` 取**导致拒绝的那个头**（先看 `x`，再看 `a`）"）↔ plan Task 5 Step 3（`plan:575`）；用例只有 `checkVersionHeader(['1.0','2.0'], undefined)`（`plan:576`）
问题：`checkVersionHeader('', ['2.0'])` 在 spec 下应得 `{ok:false, raw:'2.0'}`，按 plan 的指令会得 `{ok:false, raw:'undefined'}`（`String(x)` 而 `x` 是空串）。数组头在 Node 里实际不可达（重复头会被 join 成字符串），所以不会有真实故障，但这正是这条规则存在的目的——消掉实现者各自猜文案的空间；现在 spec 与 plan 各说一套，且没有用例覆盖 `a` 侧。
建议：把 plan Step 3 改成"`undefined` → 没带；非字符串 → `ok:false`，`raw` 取导致拒绝的那个头（先 `x` 后 `a`）"；用例补一条 `assert.deepEqual(checkVersionHeader('', ['2.0']), { ok: false, raw: '2.0' })`。

[P2] Task 7 的提交清单不含 `docs/superpowers/reviews/`，spec 头部"评审报告随仓库提交"的承诺没有执行者（§3.7 / plan Task 7 Step 5）
位置：spec 头部（"评审报告：…（前两轮）；评审报告在 spec 冻结后随仓库提交"）↔ plan Task 7 Step 5（`plan:757` 的 `git add` 只有 README/requirements/0.5.0 spec/package.json/lib）
问题：两轮评审报告现在仍是未跟踪文件（`git status` → `?? docs/superpowers/reviews/`）。按现计划执行到 Task 7，提交完的仓库里 spec 头部仍指向两个不存在的文件——clone 下来的下一个人看到的是悬空引用，而 spec 自己刚承诺要提交它们。
建议：Task 7 Step 5 的 `git add` 加上 `docs/superpowers/reviews/`（两轮报告一起），或在 Step 3 前单独一条 `docs: commit spec review reports` 提交。

[P2] §5 仍写"跑 §3.3 的 5 条不变量"，§3.3 已经是 6 条（§5 ↔ §3.3）
位置：spec §5 测试计划（`...:285`）↔ spec §3.3 末尾的不变量清单（第 6 条是 `PUSH_CONFIG_METHOD_NAMES`）
问题：plan 的 compat + smoke 用例已经把 6 条都写了，所以不影响执行；但测试计划的数字是执行者用来对照"该跑几条"的，5 与 6 不一致时，最坏情况是有人按 §5 只核对前 5 条、漏掉 M7 新加的那条守卫。
建议：把 §5 的"5 条"改成"6 条"，并顺手在括号里点出第 6 条是 push 集合不变量。

---

## 裁定审计表

（裁定 1–6 与 v4 相同，v5 只更新了 1、2 的文本并补了 M6 fixture；逐条复核如下）

| 裁定 | 结论正确? | 理由充分? | 缺什么（反事实 / 相邻概念区分） |
| --- | --- | --- | --- |
| §7#1 push 配置族 ∈ `V1_METHOD_NAMES`、∉ `V1_ALIASES`；v0.3 `/list` `/delete` 不进表 | 是 | 是 | 双向反事实都在（不纳入则 M1 漏 4 个；补进表是未登记的 v0.3 行为变化），"判头集合 / 分发集合 / v0.3 行为面"三个概念分开写。v5 又把"不进表"落成了矩阵 8c + 用例 + 第 6 条不变量，理由不再依赖措辞 |
| §7#2 空 X 回落 A；非字符串头 `ok:false`、`raw` 取导致拒绝的头 | 是 | 是 | 反事实在（空 X 压制 A 会让 `2.0` 静默通过），数组文案规则也补成了"先 x 后 a"。只剩 plan 未同步（P2-2），不是理由不足 |
| §7#3 v1 `sendStream` 抛 `-32601` | 是 | 是 | 两条反事实都在（不抛 → 静默空数组；用 `-1` → 被判可重试并诱发重试），用例钉了 `e.code` |
| §7#4 M3 覆盖 §3.4 全部结构性畸形 | 是 | 是 | "只兜字段畸形则缺 status 仍抛"的反事实明确，代价（把调用方 bug 变成空任务）登记进 §6。v5 补齐了容器断言，但矩阵 13 自己引入了 artifacts 那处不一致（本轮 P2-1） |
| §7#5 M6 归一 `status.message` + `history[]`，未知 role 原样保留 | 是 | 是 | 两个相邻概念的取舍都有理由（只补 role → parts 仍无 kind；猜 role 会掩盖对端 bug）。fixture 修正后，这条裁定第一次有了真正可达的端到端证据 |
| §7#6 M7 按方法消歧、不改数值/服务端 | 是 | 是 | 两侧代价都写了（改数值破坏协议、不表态丢掉 R5 建议）；v5 补的不变量把它和 `RPC_ROUTES` 绑在一起，`PUSH_CONFIG_METHOD_NAMES` 不再是孤立真值 |

---

## 越界发现

1. `src/client.ts` 的 `sendStream` 非 SSE 回退分支把 `payload.result as A2aTask` 直接当内部 Task 用，不经过 `normalizeTask`（`src/client.ts:391-395`）——今天被 v1 守卫挡着，碰不到 v1 响应，但它是 M6 唯一没覆盖的响应入口；若将来做 v1 SSE，这里会漏归一。
2. `docs/requirements.md:193` 的映射行只写"同步"，没给新文案（R8 那格是改成"0.6.0 候选"还是"进行中（0.6.0）"）；Task 7 执行时会各自猜一个，建议在 plan 里给一句期望值。

---

## 我没能确认的

1. **真实 Pi/Hermes 会不会接受新的 v1 形状**：仓库内没有近期抓包；矩阵 18 已把它列为待执行的人工项，本轮无法替它下结论。
2. **严格 ProtoJSON 是否还有额外要求**（`status.timestamp` 为 `{seconds,nanos}`、Struct 形态等）：§6 已承认为联调发现项，仓库内没有真实严格对端的抓包可核对。
