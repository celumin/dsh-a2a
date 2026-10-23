# 调查与验证：@celumin/dsh-a2a 在 web / tui profile 下的支持情况 与 `dsh.client` 段的作用

> 调查日期：2026-10-23 · 2026-10-24 追加“TUI 下修改配置的最省事路径”（三次修订：初稿 → 机制修订 → 实测验证）· 分支 `publish/celumin-scope` · 未修改任何源码
>
> 验证环境：dsh CLI `0.2.1-rc.2` · `@deepseek-harness-tui/dsh-tui` `0.16.1` · `@celumin/dsh-a2a` `0.3.1`（npm 已发布包与本地仓库各测一遍）· Node `v24.21.0` · Linux。安装测试都在 `/tmp` 下的临时 `DSH_HOME` 里进行，未改动真实的 `~/.dsh/profiles/tui`。

## 结论（已验证版）

1. **同一个包可以同时支持 web 和 tui profile。** 宿主半（`lib/index.js`：A2A HTTP 服务、`a2a_*` 工具、agent 会话）与 profile 类型无关；浏览器半（`client/client.js`）只在 web 前端加载。

2. **`dsh.client` 段不是安装门控，对 tui-only profile 是惰性的。** tui-only profile 根本不挂载 `@deepseek-ai/dsh-client-modules`（该行只由 `@deepseek-ai/dsh-web-app` 的 bundle patch 插入），所以不会扫描、不会校验 `dsh.client`，更不会因此装不上或启动失败。

3. **真正决定“安装/成为 profile 层”的门控是另外三件事：**
   - `package.json` 的 **`dsh.bundle`**：没有它，`dsh plugin add` 只当普通依赖安装并警告“not a profile layer”；
   - **`evaluatePluginCompatibility`**：`engines.dsh`，否则所有 `@deepseek-ai/dsh-*` peer 必须匹配运行时版本；不匹配会拒绝安装（需 exact-version 豁免）；
   - **pnpm 安装本身**（网络、store 权限、build scripts 等）。
   `@celumin/dsh-a2a` 的 `dsh.bundle` 存在，peer 范围（`>=0.1.0-rc.5` 等）也满足 `0.2.1-rc.2`，因此安装通过。

4. **`dsh.client` 段是 web 浏览器半（A2A 运维面板）的必要声明，不能删。** 删掉后 web 服务端照常运行，但面板条目不会进入 `__DSH_BOOT__`，页面不报错、只是不渲染。注意：这张卡不是 `cordis.patch.yml` 的配置表单，详见下文“TUI 下修改配置的最省事路径”。

5. **“tui 安装失败”在本机无法复现。** 用真实 tui profile 的副本执行 `dsh plugin --profile tui add @celumin/dsh-a2a` 成功，`dsh.profile.bundles` 自动追加，`--dump-config` 出现 `a2a` 行，启动后 `127.0.0.1:7310` 正常监听。若原环境确有失败，优先按本文末尾的排查路径看 pnpm 日志、其它插件兼容性和 pnpm 权限，而不是 `dsh.client`。

6. **同一台机器“同时运行”两个 profile 需要额外配置。** 默认都监听 `127.0.0.1:7310`，后启动的会 `EADDRINUSE`（插件只记日志，不阻断加载）；两个进程还共用 `$DSH_HOME/a2a/context-sessions.json`。给其中一个改 `port`/`publicUrl`，并注意并发写映射。

7. **修改配置不需要 TUI settings UI；直接编辑 profile 的 `a2a` 行是最省事路径。** 真正的配置在 profile 的 `cordis.patch.yml` 用户层（不是 `dsh.client`，也不是 web 面板的 base/token）；TUI `/settings` 编辑和 TUI 运维面板只是可选的 UI 增强。详见下文“TUI 下修改配置的最省事路径”。

## 实测验证

| 验证项 | 操作 | 结果 |
|---|---|---|
| tui 安装（npm 包） | 复制真实 tui profile，`dsh plugin --profile tui add @celumin/dsh-a2a` | 成功，`+ @celumin/dsh-a2a 0.3.1`；`dsh.profile.bundles` 自动追加该包 |
| tui 组合 | `dsh --profile tui --dump-config` | 出现 `- id: a2a` / `name: '@celumin/dsh-a2a'` |
| tui 启动 | 启动临时 tui profile | `127.0.0.1:7310` 正常监听；Agent Card 返回 `x-dsh-a2a.mode: "agent"` |
| tui agent 模式 | 向该 profile 发 `message/send` | 成功创建 DSH agent 会话；本轮仅因环境没有 `DEEPSEEK_API_KEY` 返回 failed，错误来自 `llm-deepseek`，不是插件/加载失败 |
| echo 模式 | 另建 base profile，`mode: echo` 启动 | `message/send` 返回 `echo: hello-a2a`，完整 JSON-RPC 链路通过 |
| web 安装 | 临时 web profile，`dsh plugin --profile web add @celumin/dsh-a2a` + `dsh web` | 启动成功；`__DSH_BOOT__` 70 个条目中包含 `@celumin/dsh-a2a` |
| web 浏览器半 | 检查 boot manifest 并拉取模块 | `inject: ["@deepseek-ai/dsh-client-locale"]`；`/plugins/??@celumin/dsh-a2a/client.js` 返回 HTTP 200，内容与仓库 `client/client.js` 一致（仅多一个分号和 sourcemap 注释） |
| 单 profile 混合 | `dsh-base + dsh-tui + dsh-web-app + a2a` 的 `--dump-config` | 213 行，`a2a`、`client-modules`、`dsh-tui` 共存，无组合错误（未做双前端启动验证） |

未覆盖的验证：没有在真实浏览器里点开面板做视觉验证；没有真实 LLM 回复（缺 key）；TUI 因沙箱无法创建 pty，未做交互式界面验证，但 profile 的插件树已挂载、A2A 端口已监听。

## `dsh.client` 段的真实机制（宿主源码证据）

消费者是 `@deepseek-ai/dsh-client-modules`（web profile 的浏览器模块系统）：

- `dsh-client-modules/lib/index.js:733`（roster generator，`resolveMeta`）：

  ```js
  const decl = parseDshClient(packageName, dsh?.client)
  if (decl === void 0 || decl.platform !== "web") {
    this.pkgMeta.set(sourceKey, null)
    return null          // ← 不进入 web 启动清单
  }
  const clientRel = clientExportOf(packageName, pkg.exports)
  if (clientRel === void 0) throw new Error(`... declares dsh.client but exports no "./client" bundle`)
  ```

  即：**只有声明了 `dsh.client` 且 `platform === "web"`、且 exports 里有 `"./client"` 的包，其浏览器半才会被打进 web 前端的 boot manifest**（`window.__DSH_BOOT__` → 模块图 → `window.__ModuleLoader__` 按条目加载）。

- **tui-only profile 不挂载消费者。** `dsh-base` 和 `dsh-tui` 的 `cordis.patch.yml` 都没有 `dsh-client-modules`；只有 `dsh-web-app` 的 patch 插入它。因此 tui 启动时不存在“对带 `dsh.client` 声明包的 roster 扫描”，`platform` 也就无从成为安装/启动门控。malformed 的 `dsh.client` 只会在 web profile 启动时由 `client-modules` 大声报错，不影响 tui-only。

- **`dsh.client.inject` 是浏览器模块图的到达顺序声明，不是 Cordis 服务依赖。** 浏览器侧 `arriveGraphRow` 会先加载 `row.inject` 里列出的包，再加载消费者；它保证例如 `@deepseek-ai/dsh-client-locale` 的浏览器半先到。真正的 `ctx.locale` 服务依赖写在 `client/client.js` 自己的 `inject = ['slots', 'locale']` 里，Cordis 会等待 `locale` 服务。因此删掉 package-level 的 `inject` 大概率不会让面板的 locale 链路失效（web-app 本身一定会加载 locale 模块）；保留它仍然是对的，属于显式依赖和确定性加载顺序，但不要把它说成 locale 的必要条件。

- `external` / `immediately` 是可选字段；同类插件常同时声明 `platform: "web"` 与 locale/connection 等 inject，这是官方约定，不是残留。

## 删掉 `dsh.client` 段的后果

**web profile 能正常构建/运行吗？** 能——服务端（`lib/index.js` 的 A2A HTTP 服务）完全不受影响，照常监听 7310、照常处理 JSON-RPC。

**但 web 运维面板会消失。** 本包的 `client/client.js` 是 web 端的「A2A 运维面板」，注册两个座位：

- `plugins.bundle.config`：Plugins 页里 dsh-a2a bundle 的卡片（实际渲染运维面板）；
- `settings.plugins.tab`：设置 Plugins 分区的独立「A2A」运维标签页。

面板内容（服务器状态 / 实时任务板 / 远端 agent 目录）全在这份浏览器半代码里。删掉 `dsh.client` 段后它不会被加载——web 界面上 A2A 相关的运维入口就没有了（页面不报错，只是不渲染）。实测也确认：保留声明时，web 的 `__DSH_BOOT__` 里能看到 `@celumin/dsh-a2a` 条目，且浏览器模块由 web server 正常返回。

需要强调：这是**运维面板**，不是插件配置表单。它的 base URL / Bearer token 存在浏览器的 `localStorage` / `sessionStorage`，不会写 profile 的 `a2a` 行；要改 `port` / `mode` / `provider` 等，请编辑 `cordis.patch.yml`（见“TUI 下修改配置的最省事路径”）。

## 插件运行时与 web profile 无关

- 插件内置的 HTTP 服务器（`src/server.ts`，Node 原生 `createServer`，默认 `127.0.0.1:7310`）是插件自己起的进程内服务，与 web profile 无关，tui 下实测能跑（echo 与 agent 模式都验证过）。
- `peerDependencies` 都是核心包（cordis / dsh-agent / dsh-llm / dsh-session / dsh-tools / schemastery）。注意：tui profile 的 `node_modules` 里不一定物理安装它们，dsh 启动时会用安装目录的 runtime resolution 提供；`pnpm peers check` 报 `missing peer @deepseek-ai/...` 是正常现象，不要把这条警告当成 tui 安装失败。
- `src/bridge.ts:377` 回退 `ctx.agentDefaultModel`，代码已优雅处理缺失（提示显式配置 `provider`/`model`，见 `bridge.ts:294`）。但 tui 下有一个细节：`ctx.agentDefaultModel` 来自 `dsh-base`（默认 `deepseek-official/deepseek-flash`），TUI 的 `/model` 选择另存于 `~/.dsh-tui/model.json`，两者不一定同步。因此 A2A 自动创建的会话可能使用 base 默认模型，而不是 TUI 当前模型。**建议在插件配置里显式写 `provider`/`model`**；缺 API key 时会得到明确的 failed 任务，不会静默成功。

## TUI 下修改配置的最省事路径（推荐）

**结论：直接改 profile 的 `a2a` 行即可；不需要 TUI settings section，也不需要 web 面板。**

### 改哪里

- 改 profile 的用户层：`~/.dsh/profiles/<name>/cordis.patch.yml`（tui 默认 `~/.dsh/profiles/tui/cordis.patch.yml`）。
- 不要改 `~/.dsh/profiles/tui/node_modules/@celumin/dsh-a2a/cordis.patch.yml`——它是包自带的 bundle 默认层，`dsh plugin`/npm 更新会覆盖。
- 不要改 `~/.dsh/profiles/tui/cordis.yml`——它只是空的根入口列表，文件里也写明“Edit cordis.patch.yml, not this file”。
- 组合顺序是 bundle 层 → profile 的 `cordis.patch.yml` → `--patch` overlay，所以用户层最后应用，能覆盖 bundle 插入的 `a2a` 行。

### patch 语义：整体替换 `config`

DSH 的 patch 是 `target[key] = value`，不是深合并。只写：

```yaml
- id: a2a
  config:
    port: 7311
```

会把 bundle 默认的 `{ port: 7310, mode: agent }` 整个替换成 `{ port: 7311 }`。`mode` 的 schema 默认值也是 `agent`，所以看起来没坏；但如果你之前配过 `bearerToken`、`provider`、`agentPreset` 等，它们会被一起丢掉。

**建议把想保留的配置一次写全**，或从仓库的 `cordis.patch.example.yml` / 当前 `--dump-config` 的输出复制完整配置再改。

### 示例

```yaml
# ~/.dsh/profiles/tui/cordis.patch.yml
- id: a2a
  name: '@celumin/dsh-a2a'
  config:
    host: 127.0.0.1
    port: 7311
    mode: agent
    provider: deepseek-official
    model: deepseek-v4-flash
    persistSessions: true
    tools: true
    # bearerToken: 'env:A2A_TOKEN'
```

未写的键走 schema 默认值；`name` 可选，写上可以在包名不匹配时得到明确警告。

### 生效与验证

```bash
# 只检查 patch 组合，不启动；不会验证 schemastery schema
dsh --profile tui --dump-config | grep -A20 "id: a2a"
```

然后在 TUI 里 `/restart`，或退出后重新 `dsh tui`。`port`/`host` 需要重新 bind，`mode`/`provider`/`model` 需要重建 runner；不要依赖自动热加载。

启动后验证：

```bash
curl http://127.0.0.1:7311/.well-known/agent-card.json
```

### 注意事项

- `--dump-config` 只验证 patch 组合，不验证 Config schema；真正的 schema 校验发生在启动时。
- 密钥用 `env:A2A_TOKEN` 形式，不要把明文 token 写进 patch。
- 如果 web 和 tui 两个 profile 同时跑，给其中一个换 `port`，否则抢 7310。
- 这就是“手动编辑 profile 行”的方案核心；TUI `/settings` 编辑和 TUI 运维面板只是可选的 UI 增强，不是改配置的必要条件。
- 如果以后确实要在 TUI `/settings` 里编辑，需要 `ctx.tuiSettingsSections.register(...)`，并让对应 Config 字段变成 `volatile`；当前插件未实现。

## 同时运行 web 和 tui profile 的注意事项

- **端口冲突**：两个 profile 各有一个 A2A server，默认都绑定 `127.0.0.1:7310`。后启动的 `server.start()` 会 reject，`src/index.ts` 只记录错误日志，不阻断插件加载；但入站 A2A 只会到先启动的那个实例。要同时提供服务，给其中一个配置不同的 `port`（必要时同步 `publicUrl`）。
- **持久化映射共享**：`src/persistence.ts` 的 `ContextSessionStore` 固定使用 `$DSH_HOME/a2a/context-sessions.json`，当前没有配置项可改路径。两个 profile 进程会读写同一份文件，新会话写入可能互相覆盖。若要严格隔离，需使用不同的 `DSH_HOME`，或只让一个 profile 启用 agent 模式的入站服务。
- **单 profile 混合 web+tui**：dsh-tui 的 patch 自带 mixed Web+TUI 的自禁用逻辑，组合层可以同时挂 `dsh-web-app` 和 `dsh-tui`（本次 213 行组合验证通过），但未启动双前端做端到端验证。若只是要“两边都能用”，分别安装到两个 profile 更简单。

## tui 安装失败排查结论（原待办）

实际在真实 tui profile 的副本上执行：

```bash
DSH_HOME=/tmp/<temp> dsh plugin --profile tui add @celumin/dsh-a2a
```

结果安装成功，`dsh.profile.bundles` 自动加入 `@celumin/dsh-a2a`，启动后 7310 正常监听。因此“tui 装不上”不是由 `dsh.client` 或 tui 的 bundle 栈/roster 扫描造成的。

本次唯一遇到的安装失败是**沙箱环境下的 pnpm 权限问题**，与插件无关：

```text
ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
Failed to open the store operation lock at "pnpm-store-operation-locks":
Permission denied (os error 13)
```

pnpm 需要写 `/run/user/1000` 和 `~/.local/share/pnpm` 的锁/临时目录；在受限沙箱里被拒。把 `XDG_RUNTIME_DIR`、pnpm store 指到可写临时目录后安装成功。

另外，真实 tui profile 的 `.plugin-manager` 日志里有过一次**真正的安装门控拒绝**：

```text
dsh: installation rejected: Plugin @argszero/cordis-plugin-subagent-wait@0.1.1
is incompatible with dsh 0.2.1-rc.2: requirements {...}
```

这类“其它插件的 peer 范围不满足运行时”才是会明确拒绝安装的原因。`@celumin/dsh-a2a` 的 peer 范围满足 `0.2.1-rc.2`，不会触发。

如果失败复现，按这个顺序查：

1. `~/.dsh/profiles/<name>/.plugin-manager/logs/operation-*/pnpm.log` 的具体报错；
2. 是否是**其它已装插件**的兼容性拒绝（`installation rejected: Plugin ... is incompatible`）；
3. pnpm 的 store / `XDG_RUNTIME_DIR` / 网络权限；
4. 包是否真的带 `dsh.bundle`（本包有）；
5. 最后才看 `dsh.client`——它只影响 web 浏览器半，不影响 tui 安装。

## 修复/使用建议

- **只想改配置**：直接编辑 `~/.dsh/profiles/<name>/cordis.patch.yml` 的 `a2a` 行，`/restart` 生效；不需要额外的 TUI UI（见上一节）。
- **不要删 `dsh.client` 段**——它是 web 运维面板的加载声明；对 tui 没有副作用。
- tui 使用 agent 模式时，**显式配置 `provider`/`model`**，不要依赖 TUI 的 `/model` 选择；并确保对应的 API key 可通过 credentials 服务或环境变量提供。
- 若 web/tui 两个 profile 要同时运行，给其中一个换 `port`（如 web 7310、tui 7311），并注意共享的 `$DSH_HOME/a2a/context-sessions.json`。
- 若需要 TUI 内的 A2A 运维面板，需要另做 dsh-tui 的 extension/panel；当前的 `client/client.js` 只是 web 浏览器半，不会在 TUI 中渲染。
- 若确实想在 TUI `/settings` 里编辑配置，需要 `ctx.tuiSettingsSections.register(...)` + volatile Config，属于额外功能，当前未实现。
- 再次遇到安装失败时，先拿 `pnpm.log`，不要先改 `dsh.client`。

## 附：关键宿主路径

- `@deepseek-ai/dsh-client-modules/lib/index.js:733` — web roster 的 `platform === "web"` 过滤。
- `@deepseek-ai/dsh-web-app/cordis.patch.yml` — 插入 `@deepseek-ai/dsh-client-modules`（tui/base 的 patch 没有）。
- `@deepseek-ai/dsh-app-boot/lib/index.js` — `evaluatePluginCompatibility`（`engines.dsh` / `dsh-*` peers）与 `dsh.bundle` 解析。
- `@celumin/dsh-a2a/package.json` — `dsh.bundle.patch`、`dsh.client.platform: "web"`、`exports["./client"]`。
- `@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/settings-sections.d.ts` — TUI `/settings` 的 `ctx.tuiSettingsSections` 接缝；当前 dsh-a2a 未注册，所以不会出现 A2A 分区。
- `@deepseek-ai/dsh-settings/lib/index.js` — 当前 `ctx.settings` 只把 `volatile` Config 字段投影成可编辑表单（`volatileForm`）；这解释了为什么“加一个 section”还不够。
