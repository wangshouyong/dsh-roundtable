# 设计说明（DESIGN）

> 目标：在 DSH（DeepSeek Harness）里提供一块「专家团队」面板——多个角色各带人设、岗位、模型与工具，在群聊/私聊里协作，并且留下可核验的记录。
>
> 本文只写稳定的设计约束；具体进度与待办不放这里。

## 1. 边界

- **只做 DSH 插件**：模型目录与调用只走宿主 `ctx.llm`（或原生 session），插件不直连任何模型网关、不保存密钥、不读宿主配置文件之外的凭据。
- **不引入私有协议**：群数据落在工作区的 `.dsh-im/` 下，纯 JSON / JSONL，可读可迁移。
- **没有 shell**：角色的执行能力限定在内置四类（读文件 / 搜索 / 写群目录 / 跑检查）+ 记忆检索，宿主第三方工具必须被显式授权。

## 2. 三层结构

```
src/core/    领域层：纯函数与状态机（群、发言权、事实、共识、摘要、检索、记忆、回执、指标）
src/host/    DSH Host 入口：/api/im 路由、ctx.llm 调用、原生 session、工具执行、落盘
src/client/  客户端 UI：三栏 IM、角色编辑器、模型选择器、样式作用域
src/dsh/     面板挂载入口（侧栏 + main）
src/dev/     开发预览（vite + 内存假模型，不联网）
```

约束：`src/core` 不 import 任何 `@deepseek-ai/*`，可脱离宿主单测；宿主能力只从 `src/host` 进入。

## 3. 数据模型与落盘

数据按 DSH 工作区隔离，位于 `<工作区>/.dsh-im/`：

| 路径 | 内容 |
| --- | --- |
| `state.json` | 角色、会话、消息、事实投影（当前读路径） |
| `groups/<threadId>/events.jsonl` | 只追加的事件日志（群事件的事实源方向） |
| `groups/<threadId>/facts.json` | 事实物化投影 |
| `groups/<threadId>/receipts.jsonl` | 每次发言的 intent / outcome 回执 |
| `groups/<threadId>/metrics.jsonl` | 指标 |
| `groups/<threadId>/sync.json` | 摘要 / 事实推进边界 |
| `groups/<threadId>/index.json` | 记忆索引投影（默认诊断模式不落盘） |
| `groups/<threadId>/attachments/` | 本群附件 |
| `groups/<threadId>/纪要/` | 角色写的群工作区文档 |
| `calibration-samples.jsonl` | token 校准样本（usage 实测） |

**可见性边界**：角色只能读写自己群的 `groups/<threadId>/`；`.dsh-im` 其余内容（`state.json`、别的群）对角色禁读。

## 4. 发言与上下文

- **发言权仲裁**（确定性规则）：点名独占 > 回复对象 > 职责命中 > 活跃度补位；`wait` 只停本轮，不插话；默认串行地板。
- **上下文分层**：固定前缀（人设 + 岗位 + 规则 + 身份约束）→ 群级摘要 → 你的状态快照 → 相关历史 → 最近窗口 → 当前消息。
- **摘要**：L1 旧消息压缩 + L2 不可压缩事实；窗口按摘要边界裁剪。
- **事实与共识**：规则 + LLM 双路抽取事实（哈希幂等、supersede / retract、归档不复活）；共识层由 curator 生成并带生命周期状态，prompt 只注入仍然有效的条目。
- **记忆层**：索引投影（派生字段，不复制正文）+ claim 弱状态（active / superseded / raw）+ 可见性谓词表；模型侧用 `memory_search` / `memory_expand` 句柄协议按需展开。默认 shadow（只写回执，不改行为）。
- **预算**：按模型 `contextWindow` 分配；群级按最小成员窗口统一压；token 预算用 usage 实测校准（默认影子）。

## 5. 工具与授权

- 内置能力（插件自己注册的工具，与宿主工具层无关）：`read` / `search` / `write` / `check` / `memory`。
- 宿主第三方工具（浏览器、MCP 等）按「来源组 + 单工具」显式授权，默认不授予；`tools.guard` 硬白名单，未授权一律拒绝。契约见 [`TOOL-GRANTS.md`](TOOL-GRANTS.md)。
- `run_check`：只跑本仓 `vitest` / `tsc`，参数白名单、不经 shell、60s 超时，并发与排队有上限。

## 6. 传输：原生 session 与 ctx.llm

- 默认优先**原生 session**（每个「角色 × 群」一个 DSH 会话）：角色能真实调工具、保留自己的会话记忆；空闲 30 分钟释放；授权可见性变化时重建会话。
- 宿主缺 `ctx.agents` / `tools.register` / `tools.guard` 任一能力时，**整体回退** `ctx.llm`（插件工具在插件侧执行），不会半残运行；回退时界面明确提示宿主工具不可用。

## 7. 可观测与可复现

- 每次发言写两阶段回执（intent / outcome）：模型与参数、窗口序号、摘要边界、事实版本、提示词 hash、`basedOnSeq`。
- 指标落在 `metrics.jsonl`；`npm test` 含黄金回放，行为变化必须显式更新基线。
- 失败 turn 可导出最小复现包（事件区间 + prompt + 回执）。

## 8. 测试策略

- `core` 纯函数单测（数量最多）· `host` 集成测试 · `client` 组件测试 · 黄金回放 · 记忆层 fixture ground truth · 活体测试（默认 skip，需要本机 DSH）。
- 门禁：`npm run gate`（typecheck → test → build → 打包内容校验），CI 跑同一串。

## 9. 删除与回收站（软删除）

- 口径：群解散 / 删除会话 / 删除角色 / 清空聊天记录都是**软删除**——状态从 `state.json` 移除，数据目录从 `.dsh-im/groups/<threadId>/` 移到 `.dsh-im/trash/<trashId>/`（`manifest.json` 存元数据 + 恢复快照，`data/` 存原目录），面板可恢复或彻底删除。
- 顺序契约：删除会话/角色先落盘 state、再把目录移入回收站；清空聊天记录相反（先把含旧事件的目录整体移走，再落盘，避免事件重写把回收站里的原始数据冲掉）。任何一步失败都回滚内存状态。
- 删除角色是彻底连带：私聊/三人小窗整条进回收站；群只移除成员并留系统记录；恢复时按原下标放回成员并保留活跃度。快照清洗会剥离本轮瞬时状态与待落盘队列，恢复不会重复写事件。
- 回收站不自动清理（用户明确点「彻底删除 / 清空回收站」才物理删除）；「清空聊天记录」的条目只在会话仍为空时可恢复。

## 10. 群文件与角色资料面板

- 群工作区 = `<数据根>/.dsh-im/groups/<threadId>/`（群数据与群产物同目录，不另建产物区）。角色 `write_file`、汇总、附件、检查日志都落在这里。
- 群文件面板只读：`GET /api/im/group-files`（目录列表）与 `GET /api/im/group-file`（原始字节）。路径围栏在群工作区内，拒绝绝对路径 / `..` / 隐藏文件；顶层内部账本（events/facts/metrics/receipts 等）不展示也不可读；列表 500 条、单文件读取 50MB 上限。
- 入口：群右栏「文件」Tab；DM 用顶栏「…」→「会话文件」弹窗；窄窗与群信息弹窗同步。文本/图片内联预览，其他文件「打开原文件」。
- 角色资料侧栏可从标题头像、消息流角色头像、成员卡三处打开/切换；DM 关闭资料后从标题头像重开。
