import { toolsForAllow } from '../core/tool-schema.ts'
import { normalizeToolAllow, parseGrant, type ToolGroupCatalog } from '../core/tools.ts'
import { parseState } from '../core/persist.ts'
import { logWarn } from '../core/log.ts'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertSafeThreadId,
  loadState,
  nodeSink,
  readGroupBuffer,
  writeGroupBuffer,
  saveState,
} from '../core/workspace-node.ts'
import { completeDshChat, listDshModels, modelContextWindow, type LlmService, type TokenUsage } from './dsh-llm.ts'
import type { MessageAttachment, ModelContentPart, NativeFrame, TurnStepTrace } from '../core/types.ts'
import { preflightMembers } from './preflight.ts'
import { appendIntent, appendOutcome } from './receipt-store.ts'
import { createIntent } from '../core/receipt.ts'
import { executePersonaTool } from './persona-tools.ts'
import { parseCatalogModelId, resolveModelBinding } from './models.ts'
import { appendMetrics } from './metrics-store.ts'
import { gcAttachments, MIN_GC_AGE_MS } from './attachment-gc.ts'
import { createTurnToolCache } from './tool-cache.ts'
import { describeFailure, dumpNativeDiag, type NativeBridge } from './agent-session.ts'
import { defaultRootsFile, listStateRoots, readKnownRoots, recordKnownRoot } from './state-roots.ts'
import { detectHostCapabilities, usageKeysInChunk, type HostCapabilityReport } from './capabilities.ts'
import type { MemoryContextReceipt } from '../core/memory-context.ts'
import {
  budgetViewOf,
  groupBudgetForThread,
  groupBudgetSignature,
  groupEntriesForThread,
  type BudgetChangedEvent,
  type ContextBudgetReceipt,
} from '../core/context-budget.ts'
import { appendCalibrationSample, readCalibrationSamples } from './calibration-samples-store.ts'
import { buildSample } from '../core/calibration-samples.ts'
import { buildCalibrationReport } from '../core/calibrator.ts'
import { planBudget } from '../core/budget-plan.ts'
import { buildMemoryIndex } from './memory-index.ts'
import { addTrashEntry, listTrash, purgeTrash, restoreTrashEntry } from './trash-store.ts'
import { listGroupFiles, readGroupFile, type GroupFileListing } from './group-files.ts'
import { mediaTypeFor, isTextLike } from './media-type.ts'
import type { TrashEntryMeta, TrashKind, TrashPayload } from '../core/trash.ts'

/** DSH 附件存储（ctx.attachments）的最小接口面：我们只用「存文件/存图片」两种。 */
export interface DshAttachmentStore {
  saveFile?: (input: { data: Uint8Array; name?: string }) => Promise<{ attachmentId: string; name?: string; bytes?: number }>
  saveImages?: (inputs: { data: Uint8Array; mediaType: string; name?: string }[]) => Promise<{
    attachmentId: string
    name?: string
    bytes?: number
    width?: number
    height?: number
    mediaType?: string
  }[]>
}

export interface ImApiDeps {
  projectRoot: () => string
  /**
   * 宿主 DSH 的 `ctx.llm`。
   *
   * 插件不直连任何网关：模型目录、调用、默认模型都由 DSH 提供，
   * 网关（如果有）是 DSH 自己配置的 provider，插件不感知。
   */
  llm: () => LlmService | undefined
  /** 宿主 DSH 的附件存储 `ctx.attachments`（没挂载时图片只存本地、模型看不到内容）。 */
  attachments?: () => DshAttachmentStore | undefined
  /** M2.1 原生 session（实验开关；未启用时返回 undefined，插件回退 ctx.llm）。 */
  native?: () => NativeBridge | undefined
  /** 宿主注册的工作区列表：客户端只能在这些根之间切换，防止任意路径读写。 */
  workspaces?: () => { path?: string }[]
  /** 宿主 tools 服务探测（能力契约保证不了时原生整体回退）。 */
  hostTools?: () => { register?: unknown; guard?: unknown; restrict?: unknown; schemas?: unknown } | undefined
  /** 动态工具来源组目录（内置 4 能力 + 宿主来源组，面板刷新即发现新装工具）。 */
  toolGroups?: () => ToolGroupCatalog
  /** 「用过的数据根」记忆文件（默认 ~/.dsh-im/known-roots.json；测试可注入）。 */
  rootsFile?: () => string | undefined
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_INLINE_TEXT = 20_000

function safeAttachmentName(name: string): string {
  const base = name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').replace(/^\.+/, '')
  if (!base) return 'attachment'
  const dot = base.lastIndexOf('.')
  // 保留扩展名：长文件名只截主体，不能把 .png/.ts 截掉（否则回读 mediaType 会变 octet-stream）。
  if (dot > 0 && dot < base.length - 1) {
    const ext = base.slice(dot, dot + 12)
    return base.slice(0, Math.max(1, 80 - ext.length)) + ext
  }
  return base.slice(0, 80)
}

/** 文本预览：先排除 NUL（二进制），再按 UTF-8 解码并去掉被字节截断留下的替换字符。 */
function inlineTextPreview(data: Uint8Array): string | undefined {
  const head = data.subarray(0, Math.min(data.length, 16 * 1024))
  if (head.includes(0)) return undefined
  const slice = data.subarray(0, Math.min(data.length, MAX_INLINE_TEXT * 4 + 4))
  const truncated = slice.length < data.length
  // 前半段查 NUL 判二进制（取舍：只看前 16KB，大文件后半段可能是二进制）。
  const text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  // 只在本轮确实截断时才剥尾部 U+FFFD；正文本来就有替换字符时不能吞。
  const cleaned = truncated ? text.replace(/\uFFFD+$/, '') : text
  return Array.from(cleaned).slice(0, MAX_INLINE_TEXT).join('')
}

/** 内容嗅探：声明/扩展名说是图片、实际不是时降级为文件（不当安全边界，只做校正常识）。 */
function sniffMediaType(data: Uint8Array): string | undefined {
  const bytes = (offset: number, length: number): string => String.fromCharCode(...data.subarray(offset, offset + length))
  const starts = (...sig: number[]): boolean => sig.every((value, index) => data[index] === value)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (data.length > 11 && bytes(0, 4) === 'RIFF' && bytes(8, 4) === 'WEBP') return 'image/webp'
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'application/zip'
  return undefined
}

let warnedMissingAttachmentStore = false

/** store 为空时可选链不会抛，也不会进 catch。整个进程只警告一次。 */
function warnMissingAttachmentStore(): void {
  if (warnedMissingAttachmentStore) return
  warnedMissingAttachmentStore = true
  logWarn('[dsh-im] ctx.attachments 取不到，图片只能本地预览，模型看不到内容')
}

/** 没有宿主模型服务时的统一错误：明确告诉调用方要去 DSH 里跑。 */
function noLlmService(): Error {
  return Object.assign(new Error('DSH 模型服务未就绪：插件必须在 DSH 宿主里运行'), { status: 503 })
}

export function createImApi(deps: ImApiDeps) {
  /** 根去重键：Windows 大小写不敏感；其它平台保留大小写（大小写敏感盘上是两个真目录）。 */
  /** toolAllow 来自客户端 JSON：数组以外的形状直接 400，非法授权条目也 400（不静默吞）。 */
  const assertToolAllowShape = (value: unknown): void => {
    if (value !== undefined && !Array.isArray(value)) {
      throw Object.assign(new Error('toolAllow 必须是字符串数组'), { status: 400 })
    }
    if (!Array.isArray(value)) return
    const bad = value.filter((entry) => typeof entry !== 'string' || parseGrant(entry) === null)
    if (bad.length) {
      throw Object.assign(new Error(`toolAllow 含非法授权条目：${bad.map((entry) => String(entry)).join('、')}`), { status: 400 })
    }
  }

  const rootKey = (path: string): string => {
    const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  /** 客户端透传的预算快照：结构化、不含正文；形状不对一律丢弃（审计字段不能是可信输入）。 */
  const budgetReceiptOf = (body: unknown): ContextBudgetReceipt | undefined => {
    const value = (body as { budget?: ContextBudgetReceipt }).budget
    if (!value || typeof value !== 'object') return undefined
    const numbers = ['windowChars', 'summaryChars', 'digestChars', 'chapterChars', 'memoryChars', 'tokens', 'ratio'] as const
    for (const key of numbers) {
      const raw = (value as unknown as Record<string, unknown>)[key]
      if (raw === null) continue
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
    }
    if (typeof value.tier !== 'string' || typeof value.signature !== 'string') return undefined
    if (typeof value.source !== 'string' || typeof value.version !== 'string') return undefined
    return value
  }

  /** 客户端透传的预算变更事件：只在显式输入变化时出现；形状不对一律丢弃。 */
  const budgetChangedOf = (body: unknown): BudgetChangedEvent | undefined => {
    const value = (body as { budgetChanged?: BudgetChangedEvent }).budgetChanged
    if (!value || typeof value !== 'object' || !value.from || !value.to) return undefined
    if (typeof value.reason !== 'string') return undefined
    return value
  }

  /** 客户端透传的句柄协议回执：结构化、无正文；形状不对一律丢弃（审计字段不能是可信输入）。 */
  const memoryReceiptOf = (body: unknown): MemoryContextReceipt | undefined => {
    const value = (body as { memoryContext?: MemoryContextReceipt }).memoryContext
    if (!value || typeof value !== 'object') return undefined
    if (!Array.isArray(value.snippetSeqs) || !Array.isArray(value.handleSeqs)) return undefined
    if (!Array.isArray(value.segmentIds) || !Array.isArray(value.backpressure)) return undefined
    return value
  }

  /** 模型窗口缓存：同一 (provider,model) 只向宿主 resolveModelInfo 查一次（含失败缓存，防抖动）。 */
  const modelWindowCache = new Map<string, number | null>()
  async function cachedModelWindow(llm: LlmService, provider: string, model: string): Promise<number | undefined> {
    const key = `${provider}::${model}`
    if (modelWindowCache.has(key)) return modelWindowCache.get(key) ?? undefined
    const window = await modelContextWindow(llm, provider, model)
    modelWindowCache.set(key, window ?? null)
    return window
  }

  /**
   * 本轮工具执行的群级预算（缺陷修复：`/api/im/complete` 直调时请求里没有 budget，
   * 旧逻辑让多跳展开退化成 fallback=600；现在 host 自己从**请求/状态**推导）。
   *
   * 优先级：请求里的 `budget.windowChars`（客户端已算好）> 显式 `memoryBudgetChars/budgetChars`
   * > 从数据根 state + 成员模型窗口现算 > undefined（才允许 fallback，且执行器会显式标注）。
   */
  async function resolveTurnBudget(input: {
    body: {
      budget?: ContextBudgetReceipt
      budgetChanged?: BudgetChangedEvent
      memoryBudgetChars?: number
      budgetChars?: number
      budgetTier?: string
    }
    projectRoot: string
    threadId: string
    llm: LlmService
  }): Promise<{ chars?: number; receipt?: ContextBudgetReceipt }> {
    const receipt = budgetReceiptOf(input.body)
    if (receipt && typeof receipt.windowChars === 'number' && receipt.windowChars > 0) {
      return { chars: receipt.windowChars, receipt }
    }
    const direct = [input.body.memoryBudgetChars, input.body.budgetChars]
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
    if (direct !== undefined) return { chars: direct }
    try {
      const state = await loadState(input.projectRoot)
      const thread = state?.threads.find((item) => item.id === input.threadId)
      if (!state || !thread) return {}
      const personas = new Map(state.personas.map((persona) => [persona.id, persona]))
      const windows = new Map<string, number>()
      await Promise.all([...new Set(thread.members.map((member) => member.personaId))]
        .map(async (personaId) => {
          const persona = personas.get(personaId)
          if (!persona?.model) return
          const parsed = parseCatalogModelId(persona.model, persona.provider)
          if (!parsed?.model) return
          const window = await cachedModelWindow(input.llm, parsed.route || persona.provider || '', parsed.model)
          if (typeof window === 'number' && window > 0) windows.set(personaId, window)
        }))
      const tier = input.body.budgetTier ?? 'standard'
      const policy = {
        tier,
        contextWindowForPersona: (personaId: string) => windows.get(personaId),
        modelForPersona: (personaId: string) => personas.get(personaId)?.model,
      }
      const group = groupBudgetForThread(thread, policy)
      if (!group) return {}
      const entries = groupEntriesForThread(thread, policy)
      return {
        chars: group.windowChars,
        receipt: budgetViewOf(group, { tier, signature: groupBudgetSignature(entries, tier) }),
      }
    } catch {
      // 推导失败只意味着"预算不可得"：执行器会走 fallback 并在输出里显式标注，不是静默降级。
      return {}
    }
  }

  /**
   * 「用过的数据根」缓存（key → 原始路径）。
   *
   * 这是 2026-11-02 P0「团队数据没了」的除根点：以前授权白名单只有 DSH 工作区注册表，
   * DSH 重建/重装工作区表后，数据还在盘上但面板一律 400。现在白名单 =
   * 当前工作区 + 已注册工作区 + 用过的数据根 —— 后者存在 `~/.dsh-im/known-roots.json`，
   * 不随工作区变化。**只收「目录还在、且确实是 dsh-im 数据根（有 .dsh-im/）」的根**：
   * 已删除/从来没写过的路径不进白名单，避免把「数据不在」伪装成「空数据」。
   */
  const knownRoots = new Map<string, string>()
  let knownRootsLoaded = false
  let knownRootsLoading: Promise<void> | undefined
  /** Phase 0：真实流式调用里观察到的 usage 字段路径（没有观察过就是空）。 */
  const observedUsageKeys: string[] = []

  const rootsFileOf = (): string => deps.rootsFile?.() ?? defaultRootsFile()

  async function loadKnownRoots(): Promise<void> {
    if (knownRootsLoaded) return
    knownRootsLoading ??= (async () => {
      try {
        const list = await readKnownRoots(rootsFileOf())
        for (const path of list) {
          const key = rootKey(path)
          if (knownRoots.has(key)) continue
          try {
            await stat(join(path, '.dsh-im'))
            knownRoots.set(key, path)
          } catch {
            // 目录已不存在 / 不是数据根：不进白名单（继续走 400，宁可报错也不静默给空数据）。
          }
        }
      } catch {
        // 记忆文件读不到就当没有历史根：授权退回注册表（不是错误）。
      }
      knownRootsLoaded = true
    })()
    return knownRootsLoading
  }

  /** 成功读写后记住这个根：内存立刻生效（本次会话后续请求可用），落盘异步且不阻塞主流程。 */
  function rememberRoot(root: string): void {
    knownRoots.set(rootKey(root), root)
    void recordKnownRoot(root, rootsFileOf())
  }

  const rootOf = (requested?: string, strict = false) => {
    const fallback = deps.projectRoot()
    const req = requested?.trim()
    if (!req) return fallback
    // 和 GC/读侧共用 rootKey：Windows 折叠大小写，其它平台保留大小写。
    if (rootKey(req) === rootKey(fallback)) return fallback
    const allowed = (deps.workspaces?.() ?? []).map((item) => item.path).filter((path): path is string => Boolean(path))
    const known = knownRoots.get(rootKey(req))
    // 没有注册表时生产宿主不能静默回退；测试/旧宿主可显式豁免由 deps 决定。
    if (allowed.length === 0 && knownRoots.size === 0) {
      if (strict) throw Object.assign(new Error(`没有可用工作区，拒绝根：${req}`), { status: 400 })
      return fallback
    }
    const hit = allowed.find((path) => rootKey(path) === rootKey(req)) ?? known
    if (hit) return hit
    if (strict) {
      const reason = allowed.length === 0 ? '没有可用工作区' : '未注册的工作区根'
      throw Object.assign(new Error(`${reason}：${req}`), { status: 400 })
    }
    return fallback
  }

  /** 模型绑定解析：provider::model 精确匹配；老数据按“角色的提供方”解析；失败让用户重选。 */
  async function resolveBinding(
    llm: LlmService,
    body: { model?: string; provider?: string },
  ): Promise<{ route: string; model: string }> {
    let binding: { route: string; model: string } | null = body.model?.includes('::')
      ? parseCatalogModelId(body.model)
      : null
    if (!binding?.route) {
      const listed = await listDshModels(llm)
      binding = resolveModelBinding(listed, body.model, body.provider)
    }
    if (!binding?.route) {
      throw Object.assign(new Error('请在角色里重新选择 DSH 已配置的模型'), { status: 400 })
    }
    return { route: binding.route, model: binding.model }
  }

  return {
    async getState(projectRoot?: string) {
      await loadKnownRoots()
      const root = rootOf(projectRoot, true)
      const state = await loadState(root)
      if (state) rememberRoot(root)
      return state
    },
    async putState(raw: string, projectRoot?: string) {
      await loadKnownRoots()
      const state = parseState(raw)
      const root = rootOf(projectRoot, true)
      const saved = await saveState(root, state)
      rememberRoot(root)
      // 派生数据（事件/facts/摘要/指标）落盘失败时如实回报，不再让客户端以为「存好了」。
      return saved.warnings.length ? { path: saved.path, warnings: saved.warnings } : { path: saved.path }
    },
    // ── 回收站（软删除）：会话/群数据目录搬进 .dsh-im/trash，客户端只管清单与状态 ──
    async trashList(projectRoot?: string): Promise<{ entries: TrashEntryMeta[] }> {
      await loadKnownRoots()
      const root = rootOf(projectRoot, true)
      return { entries: await listTrash(root) }
    },
    async trashAdd(body: {
      projectRoot?: string
      kind?: string
      label?: string
      detail?: string
      threadIds?: unknown
      payload?: unknown
      replaceOnRestore?: boolean
    }): Promise<{ entry: TrashEntryMeta }> {
      await loadKnownRoots()
      const root = rootOf(body.projectRoot, true)
      const threadIds = Array.isArray(body.threadIds)
        ? body.threadIds.filter((id): id is string => typeof id === 'string')
        : []
      const entry = await addTrashEntry(root, {
        kind: body.kind as TrashKind,
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
        threadIds,
        ...(body.payload && typeof body.payload === 'object' ? { payload: body.payload as TrashPayload } : {}),
        replaceOnRestore: body.replaceOnRestore === true,
      })
      return { entry }
    },
    async trashRestore(body: { projectRoot?: string; id?: unknown }): Promise<{ meta: TrashEntryMeta; payload: TrashPayload }> {
      await loadKnownRoots()
      const root = rootOf(body.projectRoot, true)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) throw Object.assign(new Error('id 必填'), { status: 400 })
      return restoreTrashEntry(root, id)
    },
    async trashPurge(body: { projectRoot?: string; id?: unknown }): Promise<{ purged: number; failed: string[] }> {
      await loadKnownRoots()
      const root = rootOf(body.projectRoot, true)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      return purgeTrash(root, id || undefined)
    },
    /** 删除会话/角色、清空记录后释放对应原生会话（被删历史不能继续留在宿主内存）。 */
    async nativeForget(body: { personaId?: unknown; threadId?: unknown }): Promise<{ disposed: number }> {
      const personaId = typeof body.personaId === 'string' ? body.personaId.trim() : ''
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : ''
      if (!personaId && !threadId) {
        throw Object.assign(new Error('personaId 或 threadId 必填（不接受"全部清空"）'), { status: 400 })
      }
      const bridge = deps.native?.()
      if (!bridge?.forget) return { disposed: 0 }
      const disposed = await bridge.forget({
        ...(personaId ? { personaId } : {}),
        ...(threadId ? { threadId } : {}),
      })
      return { disposed }
    },
    /**
     * 群工作区文件浏览（只读）：路径围栏在 `<根>/.dsh-im/groups/<threadId>/` 内，
     * 内部账本（events/facts/metrics/receipts/...）不展示也不允许读。
     */
    async groupFiles(body: {
      threadId?: unknown
      projectRoot?: string
      path?: unknown
    }): Promise<GroupFileListing> {
      await loadKnownRoots()
      const root = rootOf(body.projectRoot, true)
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : ''
      if (!threadId) throw Object.assign(new Error('threadId 必填'), { status: 400 })
      assertSafeThreadId(threadId)
      return listGroupFiles(root, threadId, typeof body.path === 'string' ? body.path : '')
    },
    /** 读一个群文件（原始字节；面板用 <img>/fetch 展示或下载）。 */
    async groupFile(body: {
      threadId?: unknown
      projectRoot?: string
      path?: unknown
    }): Promise<{ bytes: Buffer; mediaType: string; name: string }> {
      await loadKnownRoots()
      const root = rootOf(body.projectRoot, true)
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : ''
      if (!threadId) throw Object.assign(new Error('threadId 必填'), { status: 400 })
      assertSafeThreadId(threadId)
      const rel = typeof body.path === 'string' ? body.path : ''
      if (!rel.trim()) throw Object.assign(new Error('path 必填'), { status: 400 })
      return readGroupFile(root, threadId, rel)
    },
    /**
     * 数据根发现（只读）：当前根 + DSH 注册工作区 + 以前用过的根，各自有没有数据。
     * 面板加载失败时用它列出「哪个根里还有数据」，而不是静默显示空。
     */
    async stateRoots() {
      const file = deps.rootsFile?.() ?? defaultRootsFile()
      const knownRoots = await readKnownRoots(file)
      return listStateRoots({
        workspaces: deps.workspaces?.() ?? [],
        current: deps.projectRoot(),
        knownRoots,
      })
    },
    /** 上传一个附件：字节落到本群 attachments/，图片/文件再登记到 DSH 附件存储（给模型用）。 */
    async uploadAttachment(body: {
      threadId?: string
      projectRoot?: string
      name?: string
      mediaType?: string
      data?: Uint8Array
    }): Promise<{ attachment: MessageAttachment; url: string; modelVisible: boolean }> {
      const threadId = (body.threadId ?? '').trim()
      const name = (body.name ?? '').trim()
      const data = body.data
      if (!threadId) throw Object.assign(new Error('threadId 必填'), { status: 400 })
      assertSafeThreadId(threadId)
      if (!name) throw Object.assign(new Error('name 必填'), { status: 400 })
      if (!data || data.byteLength === 0) throw Object.assign(new Error('附件是空的'), { status: 400 })
      await loadKnownRoots()
      const projectRoot = rootOf(body.projectRoot, true)
      const declared = mediaTypeFor(name, body.mediaType)
      const sniffed = sniffMediaType(data)
      let kind: MessageAttachment['kind'] = declared.startsWith('image/') ? 'image' : 'file'
      let mediaType = declared
      let downgraded = false
      // 声明是图片但内容不是图片：降级为文件（按 20MB 限流），避免把二进制当图片走 8MB 上限。
      if (kind === 'image' && !sniffed?.startsWith('image/')) {
        kind = 'file'
        mediaType = sniffed ?? 'application/octet-stream'
        downgraded = true
      } else if (kind === 'image' && sniffed) {
        mediaType = sniffed
      }
      const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
      if (data.byteLength > limit) {
        throw Object.assign(new Error(`附件太大（${Math.round(data.byteLength / 1024)}KB，上限 ${Math.round(limit / 1024)}KB）`), { status: 413 })
      }
      const id = 'a_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12)
      const rel = `attachments/${id}_${safeAttachmentName(name)}`
      await writeGroupBuffer(projectRoot, threadId, rel, data)
      const attachment: MessageAttachment = {
        id,
        kind,
        name,
        mediaType,
        bytes: data.byteLength,
        path: rel,
        ...(downgraded ? { downgraded: true } : {}),
      }
      const store = deps.attachments?.()
      // 文本预览与宿主 store 无关：没有 store / store 不支持的文本文件，本地也要能看正文。
      // 降级文件（假 png）媒体类型是 octet-stream，但内容无 NUL 时仍按文本内联。
      const noNul = !data.subarray(0, Math.min(data.length, 16 * 1024)).includes(0)
      const textLike = isTextLike(name, mediaType) || (downgraded && !sniffed && noNul)
      if (kind !== 'image' && textLike) {
        const text = inlineTextPreview(data)
        if (text) attachment.text = text
      }
      if (!store) {
        warnMissingAttachmentStore()
        await appendMetrics(projectRoot, threadId, [{
          at: Date.now(),
          kind: 'attachment_host_save',
          fields: { ok: false, reason: 'no-store', name: name.slice(0, 80), mediaType },
        }]).catch(() => undefined)
      }
      try {
        if (!store) {
          // 本地预览已在上方计算，无需再走宿主 store。
        } else if (kind === 'image' && typeof store.saveImages !== 'function') {
          await appendMetrics(projectRoot, threadId, [{
            at: Date.now(),
            kind: 'attachment_host_save',
            fields: { ok: false, reason: 'no-saveImages', name: name.slice(0, 80), mediaType },
          }]).catch(() => undefined)
        } else if (kind === 'image') {
          const refs = await store.saveImages?.([{ data, mediaType, name }])
          const ref = refs?.[0]
          if (ref?.attachmentId) {
            attachment.attachmentId = ref.attachmentId
            if (typeof ref.width === 'number') attachment.width = ref.width
            if (typeof ref.height === 'number') attachment.height = ref.height
          } else {
            await appendMetrics(projectRoot, threadId, [{
              at: Date.now(),
              kind: 'attachment_host_save',
              fields: { ok: false, reason: 'no-ref', name: name.slice(0, 80), mediaType },
            }]).catch(() => undefined)
          }
        } else if (typeof store.saveFile !== 'function') {
          await appendMetrics(projectRoot, threadId, [{
            at: Date.now(),
            kind: 'attachment_host_save',
            fields: { ok: false, reason: 'no-saveFile', name: name.slice(0, 80), mediaType },
          }]).catch(() => undefined)
        } else {
          const ref = await store.saveFile({ data, name })
          if (ref?.attachmentId) attachment.attachmentId = ref.attachmentId
          else {
            await appendMetrics(projectRoot, threadId, [{
              at: Date.now(),
              kind: 'attachment_host_save',
              fields: { ok: false, reason: 'no-ref', name: name.slice(0, 80), mediaType },
            }]).catch(() => undefined)
          }
        }
      } catch (error) {
        // 宿主附件存储不可用（或纯文本后端不支持某些类型）不影响本地保存与预览；记一条指标便于排查。
        await appendMetrics(projectRoot, threadId, [{
          at: Date.now(),
          kind: 'attachment_host_save',
          fields: {
            ok: false,
            name: name.slice(0, 80),
            mediaType,
            ...(downgraded ? { downgraded: true } : {}),
            error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
          },
        }]).catch(() => undefined)
      }
      attachment.modelVisible = Boolean(attachment.attachmentId)
      const query = new URLSearchParams({ threadId, file: rel })
      return { attachment, url: `/api/im/attachment?${query.toString()}`, modelVisible: attachment.modelVisible }
    },
    /** 读本群 attachments/ 下的附件字节（给界面预览/下载）。 */
    async attachmentFile(body: { threadId?: string; file?: string; projectRoot?: string }) {
      const threadId = (body.threadId ?? '').trim()
      const file = (body.file ?? '').replaceAll('\\', '/').trim()
      if (!threadId || !file) throw Object.assign(new Error('threadId/file 必填'), { status: 400 })
      if (!file.startsWith('attachments/')) {
        throw Object.assign(new Error('只能读 attachments/ 下的附件'), { status: 400 })
      }
      // 不再要求客户端传绝对路径：显式根接受「注册工作区 + 用过的数据根」；没传则在各根里找该群。
      await loadKnownRoots()
      const candidates = body.projectRoot
        ? [rootOf(body.projectRoot, true)]
        : [...new Map([deps.projectRoot(), ...(deps.workspaces?.() ?? []).map((item) => item.path).filter((path): path is string => Boolean(path)), ...knownRoots.values()]
          .map((path) => [rootKey(path), path] as const)).values()]
      let fallbackHit: { bytes: Buffer; mediaType: string } | undefined
      for (const root of candidates) {
        let bytes: Buffer
        try {
          bytes = await readGroupBuffer(root, threadId, file)
        } catch (error) {
          if (error instanceof Error && /invalid threadId/.test(error.message)) {
            throw Object.assign(new Error('threadId 非法'), { status: 400 })
          }
          continue
        }
        const state = await loadState(root).catch(() => null)
        const thread = state?.threads.find((item) => item.id === threadId)
        const recorded = thread?.messages
          .flatMap((message) => message.attachments ?? [])
          .find((attachment) => attachment.path?.replaceAll('\\', '/') === file)?.mediaType
        const sniffed = sniffMediaType(bytes)
        const byPath = mediaTypeFor(file)
        const result = { bytes, mediaType: recorded ?? sniffed ?? (byPath.startsWith('image/') ? 'application/octet-stream' : byPath) }
        // 优先返回 state 里确实有这个 thread 的根，避免跨根同名群读错工作区。
        if (thread) return result
        fallbackHit ??= result
      }
      if (fallbackHit) return fallbackHit
      throw Object.assign(new Error('附件不存在'), { status: 404 })
    },
    /** 附件垃圾回收：默认 dryRun，只报告孤儿；显式 dryRun=false 才删除。 */
    async attachmentGc(body: { threadId?: string; dryRun?: boolean; minAgeMs?: number }) {
      const threadId = (body.threadId ?? '').trim()
      if (!threadId) throw Object.assign(new Error('threadId 必填'), { status: 400 })
      const dryRun = body.dryRun ?? true
      const requestedAge = body.minAgeMs ?? 24 * 60 * 60 * 1000
      // 非 dryRun 必须给足宽限期，防止客户端传 0 直接清空；路径也必须用面板根，不信客户端 projectRoot。
      if (!dryRun && requestedAge < MIN_GC_AGE_MS) {
        throw Object.assign(new Error(`minAgeMs 不能小于 ${MIN_GC_AGE_MS}ms（1h）`), { status: 400 })
      }
      const roots: string[] = []
      const seenRoots = new Set<string>()
      for (const root of [deps.projectRoot(), ...(deps.workspaces?.() ?? []).map((item) => item.path).filter((path): path is string => Boolean(path))]) {
        const key = rootKey(root)
        if (seenRoots.has(key)) continue
        seenRoots.add(key)
        roots.push(root)
      }
      const results: ({ root: string } & Awaited<ReturnType<typeof gcAttachments>>)[] = []
      let lastAbort: unknown
      for (const root of roots) {
        try {
          const result = await gcAttachments(root, threadId, {
            dryRun,
            minAgeMs: Math.max(MIN_GC_AGE_MS, requestedAge),
          })
          results.push({ root, ...result })
        } catch (error) {
          // 该根里没有这个群：继续看下一个注册根；都找不到时再抛。
          if ((error as { code?: string }).code === 'GC_ABORT') lastAbort = error
          else throw error
        }
      }
      if (results.length === 0) throw lastAbort ?? Object.assign(new Error('GC_ABORT：没有可扫描的根'), { code: 'GC_ABORT' })
      const sum = (key: 'scanned' | 'referenced' | 'freed' | 'wouldFree' | 'failed' | 'statFailed' | 'errored' | 'noDir'): number =>
        results.reduce((total, item) => total + item[key], 0)
      return {
        root: results[0]?.root ?? roots[0],
        coveredRoots: results.map((item) => item.root),
        results,
        orphanEntries: results.flatMap((item) => item.orphans.map((path) => ({ root: item.root, path }))),
        scanned: sum('scanned'),
        referenced: sum('referenced'),
        orphans: results.flatMap((item) => item.orphans),
        freed: sum('freed'),
        wouldFree: sum('wouldFree'),
        failed: sum('failed'),
        statFailed: sum('statFailed'),
        errored: sum('errored'),
        noDir: sum('noDir'),
        dryRun,
      }
    },
    async models() {
      const llm = deps.llm()
      if (!llm) throw noLlmService()
      return listDshModels(llm)
    },
    async preflight(body: { threadId?: string; projectRoot?: string }) {
      if (!body.threadId) throw Object.assign(new Error('threadId 必填'), { status: 400 })
      await loadKnownRoots()
      const state = await loadState(rootOf(body.projectRoot, true))
      if (!state) throw Object.assign(new Error('还没有任何群数据'), { status: 404 })
      const thread = state.threads.find((item) => item.id === body.threadId)
      if (!thread) throw Object.assign(new Error('群不存在'), { status: 404 })
      const members = thread.members
        .map((member) => state.personas.find((persona) => persona.id === member.personaId))
        .filter((persona): persona is NonNullable<typeof persona> => Boolean(persona))
        .map((persona) => ({
          personaId: persona.id,
          name: persona.name,
          post: persona.post,
          model: persona.model,
          provider: persona.provider,
        }))
      return preflightMembers(deps.llm(), members)
    },
    async complete(body: {
      model?: string
      provider?: string
      system?: string
      user?: string
      messages?: { role: 'user' | 'assistant' | 'system'; content: string | ModelContentPart[] }[]
      toolAllow?: string[]
      projectRoot?: string
      threadId?: string
      /** 回执：这条回复对应的角色、窗口事件序号、摘要覆盖边界、事实版本。 */
      personaId?: string
      windowSeqs?: number[]
      summaryUntil?: number
      factsVersion?: string
      /** 角色状态快照 hash + 检索审计（回执变厚，用于回放/审计）。 */
      stateSnapshotHash?: string
      retrievalQuery?: {
        topicId: number
        entities: { type: string; value: string }[]
        replyChainRoots: number[]
        params: { retrievalVersion: string; topicSegVersion: string; weights: Record<string, number> }
      }
      retrievalHitIds?: number[]
      retrievalSelectedIds?: number[]
      indexVersion?: string
      /** reply（角色发言）/ extract（异步事实抽取）/ curate（共识整理），指标里区分。 */
      purpose?: 'reply' | 'extract' | 'curate'
      /** A-1 群级预算快照 + 变更事件（客户端组装时算好，回执/指标落盘）。 */
      budget?: ContextBudgetReceipt
      budgetChanged?: BudgetChangedEvent
      /** 工具执行预算覆盖（缺省时 host 从 state + 成员模型窗口推导；见 resolveTurnBudget）。 */
      memoryBudgetChars?: number
      budgetChars?: number
      budgetTier?: string
      /** Phase 1 句柄协议回执（含冷区章节目录审计）。 */
      memoryContext?: MemoryContextReceipt
    }) {
      if (!body.model || (!body.messages?.length && typeof body.user !== 'string')) {
        throw Object.assign(new Error('model 与 messages 必填'), { status: 400 })
      }
      assertToolAllowShape(body.toolAllow)
      await loadKnownRoots()
      const projectRoot = rootOf(body.projectRoot, true)
      const threadId = body.threadId || 'im'
      const llm = deps.llm()
      if (!llm?.stream) throw noLlmService()
      const binding = await resolveBinding(llm, body)
      const toolAllow = normalizeToolAllow(body.toolAllow)
      // 缺陷修复：请求里没带 budget 时（例如直调 /api/im/complete），host 从 state+成员模型窗口推导，
      // 让多跳执行器拿到真实群级预算；推导不到才 fallback（执行器会显式标注）。
      // 只有"本轮可能调工具"时才推导（extract/curate 是后台结构化调用，不需要工具预算）。
      const mayCallTools = toolsForAllow(toolAllow).length > 0
        && body.purpose !== 'extract'
        && body.purpose !== 'curate'
      const turnBudget = mayCallTools
        ? await resolveTurnBudget({ body, projectRoot, threadId, llm })
        : { chars: undefined, receipt: undefined }
      const effectiveBudget = budgetReceiptOf(body) ?? turnBudget.receipt
      const memoryBudgetChars = typeof body.budget?.windowChars === 'number'
        ? body.budget.windowChars
        : turnBudget.chars
      // 同文件/同目录/同关键词在一轮里重复调用：返回“已看过”提示，不再真实读盘。
      const toolCache = createTurnToolCache()
      const onTool = (name: string, args: Record<string, unknown>) => executePersonaTool({
        name,
        args,
        projectRoot,
        threadId,
        ...(body.personaId ? { personaId: body.personaId } : {}),
        ...(memoryBudgetChars === undefined ? {} : { budgetChars: memoryBudgetChars }),
        cache: toolCache,
      })
      // 两阶段回执：调用前记 intent，完成后补 outcome（best-effort，不影响回复）。
      const turnId = crypto.randomUUID()
      const startedAt = Date.now()
      const windowSeqs = (Array.isArray(body.windowSeqs) ? body.windowSeqs : [])
        .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq))
      const hitIds = (Array.isArray(body.retrievalHitIds) ? body.retrievalHitIds : [])
        .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq))
      const selectedIds = (Array.isArray(body.retrievalSelectedIds) ? body.retrievalSelectedIds : [])
        .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq))
      await appendIntent(projectRoot, threadId, createIntent({
        turnId,
        personaId: body.personaId ?? '',
        provider: binding.route,
        model: binding.model,
        windowSeqs,
        summaryUntil: typeof body.summaryUntil === 'number' ? body.summaryUntil : 0,
        systemPrompt: body.system ?? '',
        prompt: JSON.stringify(body.messages ?? []),
        untrusted: Boolean(body.messages?.some((message) => message.role === 'user')),
        ...(body.factsVersion ? { versions: { factsVersion: body.factsVersion } } : {}),
        ...(body.stateSnapshotHash ? { stateSnapshotHash: body.stateSnapshotHash } : {}),
        ...(body.retrievalQuery ? {
          retrieval: {
            query: body.retrievalQuery,
            hitIds,
            selectedIds,
            indexVersion: body.indexVersion ?? '',
          },
        } : {}),
        ...(memoryReceiptOf(body) ? { memoryContext: memoryReceiptOf(body) } : {}),
        ...(effectiveBudget ? { budget: effectiveBudget } : {}),
        ...(budgetChangedOf(body) ? { budgetChanged: budgetChangedOf(body) } : {}),
        at: startedAt,
      })).catch(() => undefined)

      let text: string
      const steps: TurnStepTrace[] = []
      /** Phase 1b：宿主流里观察到的用量（没有就不猜）。 */
      let observedUsage: TokenUsage | undefined
      /** 用于校准 chars/token 的输入字符数：system + 本轮消息正文。 */
      const promptChars = (body.system ?? '').length + (body.messages ?? [{ role: 'user' as const, content: body.user ?? '' }])
        .reduce((sum, message) => sum + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length), 0)
      /** 工具循环统计（toolCalls / toolBudgetExhausted 写进 metrics 与 trace 的 reply 步）。 */
      let toolStats: import('./dsh-llm.ts').TurnToolStats | undefined
      try {
        text = await completeDshChat({
          llm,
          provider: binding.route,
          model: binding.model,
          system: body.system ?? '',
          messages: body.messages ?? [{ role: 'user', content: body.user ?? '' }],
          toolAllow,
          onTool: toolsForAllow(toolAllow).length ? onTool : undefined,
          onStep: (step) => { steps.push({ ...step, step: steps.length + 1 }) },
          onTurnStats: (stats) => { toolStats = stats },
          purpose: body.purpose ?? 'reply',
          onUsage: (usage) => { observedUsage = usage },
        })
      } catch (err) {
        // 失败也要留指标：成功率/失败码在 metrics.jsonl 里能查到。
        await appendMetrics(projectRoot, threadId, [{
          at: startedAt,
          kind: 'llm_call',
          value: Date.now() - startedAt,
          fields: {
            ok: false,
            purpose: body.purpose ?? 'reply',
            provider: binding.route,
            model: binding.model,
            personaId: body.personaId ?? '',
            error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
          },
        }]).catch(() => undefined)
        await appendOutcome(projectRoot, threadId, turnId, {
          ms: Date.now() - startedAt,
          finish: 'error',
        }).catch(() => undefined)
        throw err
      }
      const ms = Date.now() - startedAt
      await Promise.all([
        appendOutcome(projectRoot, threadId, turnId, {
          ms,
          finish: 'stop',
          ...(observedUsage?.inputTokens === undefined ? {} : { tokensIn: observedUsage.inputTokens }),
          ...(observedUsage?.outputTokens === undefined ? {} : { tokensOut: observedUsage.outputTokens }),
        }).catch(() => undefined),
        appendMetrics(projectRoot, threadId, [{
          at: startedAt,
          kind: 'llm_call',
          value: ms,
          fields: {
            ok: true,
            purpose: body.purpose ?? 'reply',
            provider: binding.route,
            model: binding.model,
            personaId: body.personaId ?? '',
            windowCount: windowSeqs.length,
            summaryUntil: typeof body.summaryUntil === 'number' ? body.summaryUntil : 0,
            factsVersion: body.factsVersion ?? '',
            dedupedCalls: toolCache.hits(),
            retrievalHits: hitIds.length,
            retrievalSelected: selectedIds.length,
            hasState: Boolean(body.stateSnapshotHash),
            // 工具循环护栏观测：本轮请求/执行了几次工具、是否因上限被强制收尾。
            ...(toolStats ? {
              toolCalls: toolStats.toolCalls,
              toolExecuted: toolStats.toolExecuted,
              toolRounds: toolStats.toolRounds,
              toolCallLimit: toolStats.toolCallLimit,
              toolBudgetExhausted: toolStats.toolBudgetExhausted,
            } : {}),
            ...(body.indexVersion ? { indexVersion: body.indexVersion } : {}),
            // Phase 1b：用量 + 本次 prompt 字符数（反推 chars/token 系数的原料）。
            ...(observedUsage ? {
              ...(observedUsage.inputTokens === undefined ? {} : { inputTokens: observedUsage.inputTokens }),
              ...(observedUsage.outputTokens === undefined ? {} : { outputTokens: observedUsage.outputTokens }),
              ...(observedUsage.totalTokens === undefined ? {} : { totalTokens: observedUsage.totalTokens }),
              promptChars,
              ...(observedUsage.inputTokens ? { charsPerInputToken: Math.round((promptChars / observedUsage.inputTokens) * 100) / 100 } : {}),
            } : {}),
          },
        }]).catch(() => undefined),
      ])
      // A-1：预算变更事件（只在显式输入变化时出现）单独落一条指标，便于离线对账。
      if (body.budgetChanged) {
        await appendMetrics(projectRoot, threadId, [{
          at: startedAt,
          kind: 'budget_changed',
          value: typeof body.budget?.windowChars === 'number' ? body.budget.windowChars : 0,
          fields: {
            reason: body.budgetChanged.reason,
            fromWindowChars: body.budgetChanged.from.windowChars,
            toWindowChars: body.budgetChanged.to.windowChars,
            fromTokens: body.budgetChanged.from.tokens ?? -1,
            toTokens: body.budgetChanged.to.tokens ?? -1,
            fromTier: body.budgetChanged.from.tier,
            toTier: body.budgetChanged.to.tier,
          },
        }]).catch(() => undefined)
      }
      // L1 计量正确性：整条样本（原始 usage + 口径 + 构成）落 calibration-samples.jsonl，判据可离线复算。
      {
        const messageText = (body.messages ?? [{ role: 'user' as const, content: body.user ?? '' }])
          .map((message) => (typeof message.content === 'string'
            ? message.content
            : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')))
          .join('\n')
        const sample = buildSample({
          at: startedAt,
          provider: binding.route,
          model: binding.model,
          purpose: body.purpose ?? 'reply',
          transport: 'ctx.llm',
          systemText: body.system ?? '',
          messageText,
          toolCalls: steps.filter((step) => step.kind === 'tool').length,
          toolCount: toolsForAllow(toolAllow).length,
          usage: observedUsage ?? {},
        })
        void appendCalibrationSample(projectRoot, sample)
      }
      return { text, ...(steps.length ? { trace: steps } : {}) }
    },
    /**
     * 用 ctx.llm.stream 复刻一次和原生会话相近的请求，把原始异常（含 cause）原样返回。
     * 不经过 agent 循环的 failure 投影。
     */
    async llmProbe(body: {
      model?: string
      provider?: string
      system?: string
      prompt?: string
      maxTokens?: number
      reasoningEffort?: string
      tools?: unknown[]
      /** 循环独有：系统提示更新方式。失败会话里是 in-history。 */
      systemPromptUpdate?: 'in-history' | 'replace'
    }) {
      const llm = deps.llm()
      if (!llm?.stream) return { ok: false, failure: { message: 'llm.stream 不存在' } }
      const started = Date.now()
      const textParts: string[] = []
      let binding: { route: string; model: string } | undefined
      try {
        binding = await resolveBinding(llm, body)
        const stream = llm.stream.call(llm, {
          provider: binding.route,
          model: binding.model,
          system: body.system ?? '你是实测甲。用一句话回答。',
          messages: [{ role: 'user', content: [{ type: 'text', text: body.prompt ?? '只说一个字好' }] }],
          maxTokens: body.maxTokens ?? 256_000,
          reasoningEffort: body.reasoningEffort ?? 'high',
          ...(body.systemPromptUpdate ? { systemPromptUpdate: body.systemPromptUpdate } : {}),
          ...(body.tools ? { tools: body.tools } : {}),
          signal: AbortSignal.timeout(60_000),
        })
        for await (const chunk of stream) {
          // Phase 0 能力探测：记录流里是否带 usage（决定 Phase 1 能否做 token 校准）。
          for (const key of usageKeysInChunk(chunk)) {
            if (!observedUsageKeys.includes(key)) observedUsageKeys.push(key)
          }
          if (chunk?.type === 'text-delta' && chunk.text) textParts.push(chunk.text)
          if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            const failure = chunk.reason?.failure
            throw Object.assign(new Error(failure?.message || chunk.reason?.kind || 'llm finish error'), {
              code: failure?.code,
              cause: failure,
            })
          }
        }
        return { ok: true, ms: Date.now() - started, provider: binding.route, model: binding.model, text: textParts.join('').slice(0, 500) }
      } catch (error) {
        return {
          ok: false,
          ms: Date.now() - started,
          provider: binding?.route,
          model: binding?.model,
          failure: describeFailure(error),
        }
      }
    },
    /** M2.1 原生 session 是否可用（客户端据此选择 transport；默认关）。 */
    nativeStatus() {
      const bridge = deps.native?.()
      if (!bridge) return { enabled: false, reason: '原生会话已关闭（DSH_IM_NATIVE_SESSION=0）' }
      return bridge.status()
    },
    /** 诊断：原生会话当前派生消息（排查空回复用；不含敏感 prompt）。 */
    nativeDebug() {
      const bridge = deps.native?.()
      if (!bridge) return { enabled: false, sessions: [] as unknown[] }
      return { enabled: true, ...(bridge.debug?.() ?? { sessions: [] as unknown[] }) }
    },
    /**
     * Phase 0 宿主能力探测：tokenizer / usage / embeddings 有没有。
     * 只做形状探测 + 已观察到的 usage 字段；不主动发模型调用（那由 /llm-probe 触发）。
     */
    capabilities(): HostCapabilityReport {
      return detectHostCapabilities(deps.llm(), { usageKeys: observedUsageKeys })
    },
    /** Phase 1b：当前数据根的 chars/token 校准（面板启动读取，用于把 token 预算换算成字符预算）。 */
    /**
     * L1/L2/L3 观测：校准样本报告 + 影子决策 + 各桶「若启用」预算。
     * `charsPerToken`（客户端预算实际用的）**只在显式 shadow→calibrated 后才返回**，
     * 其余情况返回空对象 + 完整 shadow 报告（零行为变更）。
     */
    async tokenCalibration(projectRoot?: string) {
      await loadKnownRoots()
      const root = rootOf(projectRoot, true)
      const calibrated = process.env.DSH_IM_CALIBRATION_MODE === 'calibrated'
      const samples = await readCalibrationSamples(root)
      const report = buildCalibrationReport(samples, { allowCalibrated: calibrated })
      const charsPerToken: Record<string, number> = {}
      if (calibrated) {
        for (const bucket of report.buckets) {
          if (bucket.mode !== 'calibrated' || bucket.shadowRatio === undefined) continue
          const modelKey = bucket.bucket.split('::').slice(0, 2).join('::')
          charsPerToken[modelKey] = bucket.shadowRatio
        }
      }
      const buckets = report.buckets.map((bucket) => {
        const plan = planBudget({
          ...(bucket.shadowRatio === undefined ? {} : { ratio: bucket.shadowRatio, ratioSource: 'calibrated' as const }),
          tier: 'standard',
          mode: 'shadow',
        })
        return {
          bucket: bucket.bucket,
          samples: bucket.samples,
          valid: bucket.validSamples,
          invalidShare: bucket.invalidShare,
          prior: bucket.priorRatio,
          median: bucket.medianRatio,
          shadowRatio: bucket.shadowRatio,
          mode: bucket.mode,
          wouldClamp: bucket.wouldClamp,
          reasons: bucket.reasons,
          wouldBeWindowChars: plan.windowChars,
          wouldBeTokens: plan.tokenBudget,
        }
      })
      return {
        mode: calibrated ? 'calibrated' : 'shadow',
        totals: report.totals,
        buckets,
        charsPerToken,
      }
    },
    /**
     * Phase 0 记忆索引预览：构建/增量更新指定群的派生索引，返回统计（默认**不落盘**）。
     * 只读诊断用；`persist:true` 才写 `.dsh-im/groups/<id>/index.json`。
     */
    async memoryIndex(body: { threadId?: string; projectRoot?: string; persist?: boolean }) {
      const threadId = (body.threadId ?? '').trim()
      if (!threadId) throw Object.assign(new Error('threadId 必填'), { status: 400 })
      await loadKnownRoots()
      const root = rootOf(body.projectRoot, true)
      const state = await loadState(root)
      if (!state) throw Object.assign(new Error('还没有任何群数据'), { status: 404 })
      const thread = state.threads.find((item) => item.id === threadId)
      if (!thread) throw Object.assign(new Error('群不存在'), { status: 404 })
      const result = await buildMemoryIndex(root, threadId, {
        ...(thread.consensusState ? { consensus: thread.consensusState } : {}),
        persist: body.persist === true,
      })
      return {
        rebuilt: result.rebuilt,
        reason: result.reason,
        stats: result.index.stats,
        cursor: result.index.cursor,
        sample: result.index.entries.slice(-5),
      }
    },
    /**
     * 动态工具目录：内置 4 能力 + 宿主来源组（浏览器/MCP server/其他）。
     * 面板每次打开/刷新都重新发现，用户新装的工具无需改代码即可出现在角色编辑器里。
     */
    toolGroups() {
      const catalog = deps.toolGroups?.()
      if (!catalog) return { capabilities: [], groups: [], native: false }
      const bridge = deps.native?.()
      return { ...catalog, native: Boolean(bridge?.status().enabled) }
    },
    async nativeComplete(body: {
      sessionKey?: string
      personaId?: string
      model?: string
      provider?: string
      system?: string
      prompt?: string
      messages?: { role?: string; content?: string }[]
      cwd?: string
      projectRoot?: string
      threadId?: string
      windowSeqs?: number[]
      summaryUntil?: number
      factsVersion?: string
      frame?: NativeFrame
      nativeFrame?: NativeFrame
      toolAllow?: string[]
      personaName?: string
      setupMode?: 'all' | 'off' | 'sections' | 'restrict' | 'bcdp' | 'mcp'
      sessionIdOverride?: string
      maxTokens?: number
      reasoningEffort?: string
      /** 单轮工具调用上限（缺省读 DSH_IM_MAX_TOOL_CALLS / 12）。 */
      maxToolCalls?: number
      /** A-1 群级预算快照 + 变更事件（与 ctx.llm 路径同一份回执口径）。 */
      budget?: ContextBudgetReceipt
      budgetChanged?: BudgetChangedEvent
      /** Phase 1 句柄协议回执（含冷区章节目录审计；native 与 ctx.llm 同结构）。 */
      memoryContext?: MemoryContextReceipt
    }) {
      const bridge = deps.native?.()
      if (!bridge || !bridge.status().enabled) {
        throw Object.assign(new Error('原生会话不可用：宿主没有 ctx.agents 或未开启'), { status: 503 })
      }
      const frame = body.frame ?? body.nativeFrame
      const prompt = body.prompt?.trim()
        || (body.messages ?? []).map((message) => String(message.content ?? '')).join('\n\n').trim()
      if (!body.sessionKey?.trim() || (!prompt && !frame)) {
        throw Object.assign(new Error('sessionKey 与 prompt/messages 或 frame 必填'), { status: 400 })
      }
      assertToolAllowShape(body.toolAllow)
      const toolAllow = normalizeToolAllow(body.toolAllow)
      const llm = deps.llm()
      if (!llm) throw noLlmService()
      const binding = await resolveBinding(llm, body)
      const listed = (() => {
        try {
          return (llm.listProviders?.() ?? []).map((row) => (
            typeof row === 'string' ? row : (row.id || row.name || '')
          )).filter(Boolean)
        } catch (error) {
          return [`listProviders failed: ${error instanceof Error ? error.message : String(error)}`]
        }
      })()
      const providerOverride = process.env.DSH_IM_NATIVE_PROVIDER?.trim()
      const agentProvider = providerOverride || binding.route
      dumpNativeDiag(JSON.stringify({
        at: Date.now(),
        route: binding.route,
        model: binding.model,
        agentProvider,
        listProviders: listed,
        routeInList: listed.includes(binding.route),
      }))
      await loadKnownRoots()
      const projectRoot = rootOf(body.projectRoot, true)
      const threadId = body.threadId || 'im'
      const turnId = crypto.randomUUID()
      const startedAt = Date.now()
      const windowSeqs = (Array.isArray(body.windowSeqs) ? body.windowSeqs : [])
        .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq))
      await appendIntent(projectRoot, threadId, createIntent({
        turnId,
        personaId: body.personaId ?? '',
        provider: binding.route,
        model: binding.model,
        windowSeqs,
        summaryUntil: typeof body.summaryUntil === 'number' ? body.summaryUntil : 0,
        systemPrompt: body.system ?? '',
        prompt,
        untrusted: true,
        ...(body.factsVersion ? { versions: { factsVersion: body.factsVersion } } : {}),
        ...(memoryReceiptOf(body) ? { memoryContext: memoryReceiptOf(body) } : {}),
        ...(budgetReceiptOf(body) ? { budget: budgetReceiptOf(body) } : {}),
        ...(budgetChangedOf(body) ? { budgetChanged: budgetChangedOf(body) } : {}),
        at: startedAt,
      })).catch(() => undefined)
      let text: string
      let trace: TurnStepTrace[] | undefined
      let toolStats: import('./agent-session.ts').NativeToolStats | undefined
      try {
        const done = await bridge.complete({
          sessionKey: body.sessionKey,
          provider: agentProvider,
          model: binding.model,
          cwd: body.cwd?.trim() || projectRoot,
          threadId,
          system: body.system ?? '',
          prompt,
          ...(frame ? { frame } : {}),
          ...(toolAllow ? { toolAllow } : {}),
          ...(body.personaName ? { personaName: body.personaName } : {}),
          ...(body.setupMode ? { setupMode: body.setupMode } : {}),
          ...(body.sessionIdOverride ? { sessionIdOverride: body.sessionIdOverride } : {}),
          ...(typeof body.maxTokens === 'number' ? { maxTokens: body.maxTokens } : {}),
          ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
          ...(typeof body.maxToolCalls === 'number' ? { maxToolCalls: body.maxToolCalls } : {}),
          ...(typeof body.budget?.windowChars === 'number' ? { memoryBudgetChars: body.budget.windowChars } : {}),
        })
        text = done.text
        trace = done.trace
        toolStats = done.toolStats
      } catch (err) {
        await Promise.all([
          appendOutcome(projectRoot, threadId, turnId, { ms: Date.now() - startedAt, finish: 'error' }).catch(() => undefined),
          appendMetrics(projectRoot, threadId, [{
            at: startedAt,
            kind: 'llm_call',
            value: Date.now() - startedAt,
            fields: {
              ok: false,
              purpose: 'native',
              provider: binding.route,
              model: binding.model,
              personaId: body.personaId ?? '',
              error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
            },
          }]).catch(() => undefined),
        ])
        throw err
      }
      const ms = Date.now() - startedAt
      await Promise.all([
        appendOutcome(projectRoot, threadId, turnId, { ms, finish: 'stop' }).catch(() => undefined),
        appendMetrics(projectRoot, threadId, [{
          at: startedAt,
          kind: 'llm_call',
          value: ms,
          fields: {
            ok: true,
            purpose: 'native',
            provider: binding.route,
            model: binding.model,
            personaId: body.personaId ?? '',
            windowCount: windowSeqs.length,
            summaryUntil: typeof body.summaryUntil === 'number' ? body.summaryUntil : 0,
            // 工具循环护栏观测（native 与 ctx.llm 同口径）。
            ...(toolStats ? {
              toolCalls: toolStats.toolCalls,
              toolExecuted: toolStats.toolExecuted,
              toolCallLimit: toolStats.toolCallLimit,
              toolBudgetExhausted: toolStats.toolBudgetExhausted,
            } : {}),
          },
        }]).catch(() => undefined),
      ])
      // A-1：native 通道的预算变更事件同样落指标（预算只用于观测，不参与 native usage 校准）。
      if (body.budgetChanged) {
        await appendMetrics(projectRoot, threadId, [{
          at: startedAt,
          kind: 'budget_changed',
          value: typeof body.budget?.windowChars === 'number' ? body.budget.windowChars : 0,
          fields: {
            reason: body.budgetChanged.reason,
            fromWindowChars: body.budgetChanged.from.windowChars,
            toWindowChars: body.budgetChanged.to.windowChars,
            fromTokens: body.budgetChanged.from.tokens ?? -1,
            toTokens: body.budgetChanged.to.tokens ?? -1,
            fromTier: body.budgetChanged.from.tier,
            toTier: body.budgetChanged.to.tier,
            transport: 'native',
          },
        }]).catch(() => undefined)
      }
      return { text, ...(trace?.length ? { trace } : {}), ...(toolStats ? { toolStats } : {}) }
    },
    async writeFile(body: { threadId?: string; relativePath?: string; content?: string; projectRoot?: string }) {
      if (!body.threadId || !body.relativePath || typeof body.content !== 'string') {
        throw Object.assign(new Error('threadId, relativePath, content required'), { status: 400 })
      }
      await loadKnownRoots()
      const path = await nodeSink.writeThreadFile(
        rootOf(body.projectRoot, true),
        body.threadId,
        body.relativePath,
        body.content,
      )
      return { path }
    },
    async workspace(projectRoot?: string) {
      await loadKnownRoots()
      const path = rootOf(projectRoot, true)
      return { path }
    },
    /** 宿主挂载时预热「用过的数据根」缓存，避免首个请求在缓存空的时候被判 400。 */
    loadKnownRoots,
  }
}
