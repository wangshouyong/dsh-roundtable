# dsh-roundtable · 专家团队

> DSH（DeepSeek Harness）插件：把多个角色拉进同一个群或私聊，让它们各自带着人设、岗位和工具协作。
> 模型与调用全部走宿主 `ctx.llm`（或原生 session），插件不直连任何网关、不保存任何密钥。

`版本 0.2.0` · `Node ≥ 20` · `MIT` · **可用版本（0.x：接口与数据格式可能小幅调整）**

> 名称说明：仓库与品牌名为 **dsh-roundtable**；npm 包名是带 scope 的 `@dabuliu_wsy/dsh-im`，**插件 id 与数据目录仍是 `dsh-im`**（`.dsh-im/`、`DSH_IM_*` 环境变量），以兼容现有数据和已装配置。

## 这是什么

在 DSH 侧栏出现的「专家团队」面板：新建角色（人设 / 岗位 / 模型 / 工具白名单）、拉群、私聊、`@` 点名、看任务板。

它不是"多开几个对话框"：角色发言要过发言权仲裁，上下文按摘要 / 事实 / 共识分层投喂，每次发言留下可核验的回执与指标，角色调工具的过程能看到执行轨迹。

## 界面

> 截图来自开发预览与测试群（内存假模型 / 测试角色），仅作界面示意。

**群聊**：三栏布局——左会话列表，中聊天流（按日期分组的消息，用户消息靠右，底部是等待发言与输入框），右栏按 Tab 切换成员 / 任务板 / 候选 / 执行。

![群聊界面](docs/screenshots/group-chat.png)

**私聊**：单角色小窗，右侧显示角色资料（人设 / 职责 / 模型 / 可用工具 / 活跃度 / 禁言 / 主动私聊开关）。

![私聊界面](docs/screenshots/dm.png)

**角色编辑**：人设、岗位、模型（只能选 DSH 已配置的模型）、可用工具（内置能力 + 宿主来源组 / 单工具授权）、头像（预设或本地上传）。

![角色编辑](docs/screenshots/persona-editor.png)

**深色模式**：主题跟随 DSH 的**有效主题**（读宿主投影，不猜系统设置）；面板与 portal 浮层一起切换。

![深色模式](docs/screenshots/dark-mode.png)

## 功能

- **群聊与私聊**：建群 / 邀请 / 关联工作区；DM；`@` 点名；模型回复里自带的"某某："前缀会兜底剥离；附件（图片 ≤8MB、文件 ≤20MB，可粘贴/拖拽）。
- **发言权仲裁**：点名独占 > 回复对象 > 职责命中 > 活跃度补位；`wait` 只停本轮、不插话；默认串行地板（并发发言关闭）。
- **上下文与记忆**：分层摘要（L1 旧消息压缩 + L2 不可压缩事实）、窗口预算按模型 `contextWindow` 分配（群级按最小成员窗口统一压）、角色状态快照（承诺 / 待办 / 决定 / 立场）、按需检索（默认 shadow：算但不进 prompt）。
- **可寻址记忆层**：消息索引投影（派生字段，不复制正文）+ claim 弱状态（active / superseded / raw）+ 可见性谓词表；模型侧有 `memory_search` / `memory_expand` 两个记忆工具（只返回句柄，正文按需展开，两者同权）；默认 shadow，需显式开启才注入 prompt。
- **事实与共识**：规则 + LLM 双路抽取事实、哈希幂等、supersede / retract、任务板归档不复活；共识层自动生成并带生命周期状态，prompt 只注入仍然有效的条目。
- **删除与回收站（软删除）**：群可解散、会话可删除、角色可删除、聊天记录可清空；删除的东西**不物理销毁**，而是移进 `<数据根>/.dsh-im/trash/`，面板左栏「回收站」可恢复或彻底删除。删角色会连带删除它的私聊/三人小窗、并记下群成员位置（恢复时放回原位）；清空聊天记录保留会话外壳。删除或清空后会释放对应原生会话，被删历史不再留在宿主 agent 内存里。
- **群文件与产物**：群右栏「文件」Tab（DM 用顶栏「…」→「会话文件」）只读浏览群工作区——角色写的文件、`本轮汇总.md`、附件；可进子目录，文本/图片内联预览，其他文件「打开原文件」。内部账本（events/facts/receipts 等）和隐藏目录不展示。角色头像（标题栏与消息流）可点开/切换右侧角色资料，关掉后点标题头像随时重开。
- **工具与能力**：内置五能力 `read` / `search` / `write` / `check` / `memory`（**没有 shell**）；宿主第三方工具（浏览器、MCP 等）按「来源组 + 单工具」显式授权，默认不授予、未授权一律硬拒绝；`run_check` 只跑本仓 vitest / tsc，参数白名单、不经 shell、60s 超时、并发与排队有上限。
- **原生 session（默认开）**：每个「角色 × 群」一个 DSH 原生会话，角色因此能真实调工具、保留自己的会话记忆；授权或工具可见性变化时重建会话；空闲 30 分钟释放。宿主缺 `ctx.agents` / `tools.register` / `tools.guard` 任一能力时**整体回退** `ctx.llm`，不会半残运行。
- **可观测**：执行轨迹（工具步骤与结果摘要）、两阶段回执（intent / outcome + 规范化双 hash + `basedOnSeq`）、`metrics.jsonl` 指标、失败 turn 可导出的复现包、黄金回放测试。
- **稳定性**：模型调用 120s 超时并透出失败码、`Origin` 同源校验、请求体 2MB 上限、坏 `state.json` 清洗、数据根发现与失败可见（加载 / 保存失败明确报错，而不是把错误吞成"空团队"）；角色模型调用失败时，中断状态条**固定在顶部**（不顶掉聊天滚动位置），可选「已修好重试 / 移除它继续 / 暂停本轮」。
- **界面**：三栏 IM（左会话 / 中聊天 / 右栏成员·任务板·候选·执行）、深色模式自动跟随 DSH 有效主题（读宿主投影，不猜系统设置）、`@` 高亮、按日期分组的消息时间、角色头像（预设 / 上传）、窄窗降级；插件 CSS 全部作用域到 `.dsh-im-root`，不污染宿主样式。

## 安装

> 普通用户直接用 **方式四（npm，一条命令）**；想改代码/排查问题用 **方式一（源码）**。

### 方式一：从源码接入（最稳；开发与排查用）

```sh
git clone https://github.com/wangshouyong/dsh-roundtable.git
cd dsh-roundtable
npm install
npm run build
dsh plugin --profile desktop add ./
dsh --profile desktop
```

重启后侧栏出现「专家团队」。新建角色时选 **DSH 设置里已经配好的模型**（和输入框旁的选择器同一份目录）。

开发调试：

```sh
npm run dev     # 开发预览：内置内存假模型，不联网（默认 5173 端口）
npm test        # 单测
npm run gate    # 提交前门禁：typecheck + 测试 + build + 打包内容校验
```

### 方式二：从 Release 包安装

在 [Releases](https://github.com/wangshouyong/dsh-roundtable/releases) 下载对应版本的构建包（含 `dist/`、`lib/client.js`、`cordis.patch.yml`、`dsh-plugin.json`），解压后：

```sh
dsh plugin --profile desktop add <解压后的目录>
```

### 方式三：直接用 git 地址安装（需要一步 allowBuilds）

```sh
dsh plugin --profile desktop add git+https://github.com/wangshouyong/dsh-roundtable.git
```

首次会失败并打印 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`：pnpm 默认不允许 git 包执行构建脚本，
而本插件要靠 `prepare` / `prepack` 构建 `dist/` 与 `lib/client.js`。

把报错里那一行 key 原样加到 **profile** 的 `pnpm-workspace.yaml`（例如 `~/.dsh/profiles/desktop/pnpm-workspace.yaml`）再重跑：

```yaml
allowBuilds:
  'dsh-im@https://codeload.github.com/wangshouyong/dsh-roundtable/tar.gz/<commit-hash>': true
```

这条 key 里的 commit 哈希要跟报错里的一致（换版本会变）。如果你不想碰 pnpm 配置，用方式一或方式二。

### 方式四：从 npm 安装（最省事，普通用户推荐）

```sh
dsh plugin --profile desktop add @dabuliu_wsy/dsh-im
```

npm 包名是 `@dabuliu_wsy/dsh-im`（scope 必填），插件 id 与数据目录仍是 `dsh-im`。
版本 **0.2.0** 已发布（[npm 页面](https://www.npmjs.com/package/@dabuliu_wsy/dsh-im)）；
每次发布前会跑 `npm run gate` + `npm run verify:pack`（产物齐全、无开发材料、manifest 与版本一致）。

## 配置

- **模型**：全部来自 DSH 设置里已配置的 provider / model；插件不写死地址、密钥或网关，也不换组——解析不到就报错让你重选。
- **工具授权**：角色编辑器里按「内置能力 → 宿主来源组 → 单工具」勾选；默认全不授予。契约见 [`docs/TOOL-GRANTS.md`](docs/TOOL-GRANTS.md)。
- **数据根**：面板标题旁「工作区」下拉可切换 / 注册工作区；数据按 DSH 工作区分别存放（见下节）。
- **环境变量**（全部可选）：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_IM_NATIVE_SESSION` | 开 | 设 `0` 整段关闭原生 session，退回 `ctx.llm` |
| `DSH_IM_NATIVE_TTL_MS` | 30 分钟 | 原生会话空闲多久释放 |
| `DSH_IM_NATIVE_PROVIDER` | 空 | 覆盖原生 session 的 provider（排查用） |
| `DSH_IM_NATIVE_TOOL_ALLOW` | 空 | 整表覆盖工具授权（仅排查；guard 仍拒绝名单外工具） |
| `DSH_IM_NATIVE_ARCHIVE` | 空 | 设 `live` 时用 `stopActivity:false` 试归档 |
| `DSH_IM_TURN_BUDGET_MS` | 240000 | 单轮工具循环总时长预算（防挂死） |
| `DSH_IM_MAX_TOOL_ROUNDS` | 50 | 单轮工具循环硬顶（仅防死循环） |
| `DSH_IM_ROOTS_FILE` | `~/.dsh-im/known-roots.json` | "用过的数据根"清单文件 |
| `DSH_IM_DEV_ROOT` | 进程 cwd | dev 预览的 state 根 |
| `DSH_IM_CALIBRATION_MODE` | 影子（只观测） | 设 `calibrated` 才把 usage 校准系数用于预算换算 |

- **实验开关（浏览器控制台，刷新生效）**：`localStorage['dsh-im:retrieval']`（`off` / `shadow` / `on`）控制按需检索是否进 prompt；`localStorage['dsh-im:memory']` 控制记忆层句柄是否注入。两者默认 `shadow`，只写回执、不改行为。

## 数据与隐私

数据按 DSH 工作区存放，位于 `<工作区>/.dsh-im/`：

```
.dsh-im/
├ state.json                  角色、会话、消息、事实投影（当前读路径）
├ calibration-samples.jsonl   token 校准样本（每轮实测 usage，用于把 token 预算换算成字符预算）
└ groups/<threadId>/          每个群 / 私聊一个目录
  ├ events.jsonl              只追加的事件日志（"唯一事实源"的演进方向）
  ├ facts.json                事实物化投影
  ├ receipts.jsonl            每次发言的 intent / outcome 回执
  ├ metrics.jsonl             指标（llm_call / stale / floor_round / extraction / summary 等）
  ├ sync.json                 摘要 / 事实推进边界
  ├ index.json                记忆索引投影（默认诊断模式不落盘，开启后才有）
  ├ attachments/              本群附件
  └ 纪要/                      角色写进群工作区的文档（纪要 / 草案 / 验收标准）
```

- 角色只能读写自己群的 `groups/<threadId>/`；`.dsh-im` 其余内容（`state.json`、别的群）对角色**禁读**。
- 插件自身不收集遥测、不直连模型网关（源码中没有外部 API 地址或密钥）。
- **注意**：群消息会进入该角色模型的上下文；如果给角色授权了第三方 MCP / 浏览器工具，相关内容会交给对应工具处理，是否合规需自行评估。

## 开发与测试

- **提交前门禁**：`npm run gate`（= `typecheck` → `test` → `build` → `verify:tarball`），一条命令跑完；CI 在 GitHub Actions `windows-latest` 上跑同一串（`.github/workflows/ci.yml`）。
- **发布包校验**：`npm run verify:pack`（`prepublishOnly` 会自动跑）——断言运行时产物齐全、发布包里没有开发材料、`dsh-plugin.json` 与 `package.json` 版本一致。
- **测试分层**：`src/core` 纯函数单测 · `src/host` 集成测试 · `src/client` 组件测试 · 黄金回放（行为变化要显式更新 GOLDEN）· 记忆层 fixture ground truth（`test/fixtures/memory/`）· 活体测试（默认 `skip`，需要 DSH 正在运行）。
- **架构约束**：`src/core` 不 import 任何 `@deepseek-ai/*`，可脱离宿主单测；宿主能力只从 `src/host` 进入。
- **代码地图**：

```
src/core/     领域层（群 / 仲裁 / 事实 / 共识 / 摘要 / 检索 / 记忆 / 回执 / 指标，纯函数为主）
src/host/     DSH Host 入口（/api/im 路由、ctx.llm、原生 session、工具执行、记忆索引）
src/client/   客户端 UI（三栏 IM、模型选择器、角色编辑器、头像、样式作用域）
src/dsh/      面板挂载入口
src/dev/      开发预览（vite + 内存假模型）
scripts/      构建与校验脚本
```

## 项目状态与已知限制（如实）

- **当前版本 `v0.2.0`**（tag + [Release 附件](https://github.com/wangshouyong/dsh-roundtable/releases)）：核心功能完成，`npm run gate`（typecheck → 单测 → build → 打包内容校验）与 GitHub Actions 全绿。
- **0.x 语义**：接口、数据格式与 UI 仍可能小幅调整；破坏性变更会写进 Release 说明，不静默改契约。
- **原生 session 是默认路径，但仍是需要门禁守着的链路**：依赖宿主提供 `ctx.agents` + `tools.register` / `tools.guard`；缺能力时整体回退 `ctx.llm`。它不是"稳定 API"，宿主升级后可能要跟着改。
- **实验特性默认 shadow**：按需检索、记忆层句柄注入、token 校准都先只观测（写进回执/样本），要显式开开关才改变行为。
- **记忆层仍在推进**：索引、claim、可见性、句柄协议、search/expand 工具已落地，但注入默认关闭。
- **并发发言默认关闭**（串行地板）。
- **回收站是软的、不自动清理**：删除/清空的会话、角色、聊天记录会留在 `<数据根>/.dsh-im/trash/`，只有用户点「彻底删除 / 清空回收站」才物理删除（不静默删数据）。「清空聊天记录」的条目只能在会话仍为空时恢复。
- **群文件面板只读、不实时监听**：不能改/删群文件（由角色写、由会话删除/清空清理）；不显示隐藏目录与内部账本；列表 500 条 / 文本预览 20 万字符上限；文件变化要点刷新按钮。
- **host 路由改动需要重启 DSH**：`/api/im/trash*`、`/api/im/native-forget`、`/api/im/group-files*` 是新增路由，升级后需重启一次 DSH；只刷新面板会收到「请重启 DSH」的明确提示。
- 目前只在 **Windows 上的 DSH Desktop** 实测通过，其它平台未验证。
- **没有遥测 / 崩溃上报**：排查依赖本机 `metrics.jsonl`、`receipts.jsonl` 和宿主日志。
- 单测全绿 ≠ 所有模型、所有平台都验证过；活体测试默认跳过，需要单独跑。
- 设计约束见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 关于开发方式（如实说明）

本项目是 **AI 辅助开发**：代码、测试与文档由作者与 AI 编程助手（DeepSeek Harness 会话）协作产出，架构取舍、验收标准与最终发布决定由作者负责。仓库不把 AI 协作包装成"完全手写"。

## 文档

- [`docs/DESIGN.md`](docs/DESIGN.md)：架构、模块边界、数据模型与关键设计约束
- [`docs/TOOL-GRANTS.md`](docs/TOOL-GRANTS.md)：工具授权契约（来源组 / 单工具 / 记忆可见性）
- [`LICENSE`](LICENSE)：MIT

## 许可证

[MIT](LICENSE)
