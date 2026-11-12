/**
 * M2.1 原生 session（实验开关，默认关）：
 * 一个“角色 × 群”一个 DSH 原生 agent 会话，而不是每轮临时调 `/complete`。
 *
 * 用到的宿主能力（都可缺省，缺省时本模块不可用、插件回退 ctx.llm）：
 * - `ctx.agents.create({ sessionId, meta:{cwd}, agentOptions:{provider,model} })` → `{ agent, dispose }`
 * - `agent.followup(message)` + `agent.whenIdle()` + `agent.session.deriveMessages()`
 * - `ctx.workspaceRegistry.archiveSession(sessionId)`：会话不进行侧栏
 *
 * 说明：交接文档写的是“一角色一原生 session”，这里按“角色 × 群”做隔离——
 * 同一个角色在不同群共用一个原生会话会把 A 群上下文带进 B 群，违反串台约束。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { stableHash } from '../core/receipt.ts'
import type { NativeFrame, NativeFrameLine } from '../core/types.ts'
import {
  BUILTIN_TOOL_GROUPS,
  discoverToolGroups,
  effectiveHostTools,
  inheritedToolIds,
  nativeCapabilityGap,
  personaHostToolDenial,
  pluginToolsForAllow,
  PLUGIN_TOOL_NAMES,
  toolLabel,
  type DiscoveredToolGroup,
  type ToolGroupDecl,
} from '../core/tools.ts'
import { executePersonaTool, personaToolDefinition, traceToolStep } from './persona-tools.ts'
import { createToolCallBudget, toolCallLimitFromEnv, type ToolCallBudget } from './tool-call-budget.ts'
import { createTurnToolCache, type TurnToolCache } from './tool-cache.ts'
import type { TurnStepTrace } from '../core/types.ts'

export interface NativeMessageBlock {
  type: string
  text?: string
}

export interface NativeMessage {
  role?: string
  content?: unknown
}

/**
 * 一次 followup 必须给“完整”的 user Message（id + role + content + source）。
 * DSH 的 `agent.followup` 只把传入对象原样塞进 inbox，下一轮再原样写成
 * `user/message`，**不会补 role/id**。缺 role 时 `session.deriveMessages()`
 * 会返回无角色消息，deepseek-account 适配器 serialize 里
 * `previous?.role === wireRole`（两边都是 undefined）成立后读 `previous.content`
 * 抛 TypeError，被适配器包成 `{code:'TRANSPORT'}`，llm-retry 再退避重试 5 次
 * （约 15s），最后表现为 NATIVE_EMPTY。参考 DSH 自带调用方：全部用
 * `createUserMessage(...)` 的完整消息，不是文档示例里的 {content, source} 简写。
 */
export interface NativeUserMessage {
  id: string
  role: 'user'
  content: NativeMessageBlock[]
  source: { kind: 'user' }
}

export interface NativeAgent {
  followup(message: NativeUserMessage): void
  whenIdle(): Promise<void>
  cancel?(cause?: unknown): void
  session: {
    id: string
    deriveMessages(): NativeMessage[]
  }
  status?: string
}

export interface NativeAgentHandle {
  agent: NativeAgent
  dispose(): Promise<void>
}

export interface NativeAgentCreateOptions {
  sessionId: string
  meta?: { cwd?: string }
  agentOptions?: { provider?: string; model?: string; maxTokens?: number; reasoningEffort?: string }
  setup?: (agentCtx: unknown, agent: NativeAgent) => unknown
}

export interface NativeAgentsApi {
  create(options: NativeAgentCreateOptions): Promise<NativeAgentHandle>
  /** 进程重启后会话 id 还在时，加载持久化会话而不是再 create。 */
  resume?(options: NativeAgentCreateOptions): Promise<NativeAgentHandle>
}

export interface NativeWorkspaceApi {
  archiveSession?: (sessionId: string, options?: { stopActivity?: boolean }) => Promise<unknown>
}

export interface NativeBridgeInput {
  /** 会话归属：同一 key 复用同一个原生 session。 */
  sessionKey: string
  provider: string
  model: string
  cwd?: string
  /** 静态前缀（现有 buildSystem 输出）。有 systemPrompt 时只在 setup 注册一次。 */
  system?: string
  /** 回退用；有 frame 且 systemPrompt 可用时不再整段投喂。 */
  prompt: string
  /** 增量帧。没有时保持旧行为：整段投喂 system + prompt。 */
  frame?: NativeFrame
  /** 角色勾选的能力集，映射成宿主只读工具白名单。 */
  toolAllow?: string[]
  /** 当前角色名。自己的发言不投喂，避免和会话历史里的 assistant 重复。 */
  personaName?: string
  /** 诊断：off 不跑 setup；sections 只注册段；restrict 只收窄；bcdp/mcp 只留一个工具。 */
  setupMode?: 'all' | 'off' | 'sections' | 'restrict' | 'bcdp' | 'mcp'
  /** 诊断：替换 im- 前缀的 sessionId。 */
  sessionIdOverride?: string
  maxTokens?: number
  reasoningEffort?: string
  /** 这条会话对应的群。工具按这个群的目录护栏执行。 */
  threadId?: string
  /** 本轮群级预算（热区 windowChars）：记忆工具的多跳展开按它的 15% 限总字数。 */
  memoryBudgetChars?: number
  /** 单轮工具调用上限（默认 12，`DSH_IM_MAX_TOOL_CALLS` 可调）。 */
  maxToolCalls?: number
}

/** 原生一轮的工具调用统计（回执/metrics 用）。 */
export interface NativeToolStats {
  toolCalls: number
  toolExecuted: number
  toolBudgetExhausted: boolean
  toolCallLimit: number
}

export interface NativeChecks {
  promptSection: boolean
  toolRestricted: boolean
  /** agent 作用域的 pre-execute 硬白名单已装上（P0 的越权边界）。 */
  guard: boolean
  allow: string[]
}

/** 宿主 tools 服务的探测面：只判断能力是否可覆盖，不在这里调用业务方法。 */
export interface HostToolsProbe {
  register?: unknown
  guard?: unknown
  restrict?: unknown
  schemas?: unknown
}

export interface NativeBridge {
  status(): {
    enabled: boolean
    reason?: string
    checks?: NativeChecks
    /** read/search/write/check 由插件工具覆盖；宿主来源组数量由 toolGroups 反映。 */
    capabilities?: { read: boolean; search: boolean; write: boolean; check: boolean }
    hostToolGroups?: number
  }
  complete(input: NativeBridgeInput): Promise<{ text: string; trace?: TurnStepTrace[]; toolStats?: NativeToolStats }>
  debug?(): NativeDebugInfo
  /**
   * 删除会话 / 删除角色 / 清空聊天记录后，释放匹配的原生会话。
   * 不释放的话，被删掉的历史还留在宿主的 agent 会话内存里，模型仍可能"记得"。
   */
  forget?(filter: { personaId?: string; threadId?: string }): Promise<number>
}

export interface NativeAgentSessionsOptions {
  agents: () => NativeAgentsApi | undefined
  workspace?: () => NativeWorkspaceApi | undefined
  logger?: { warn?: (message: string) => void }
  /** 空闲多久后释放原生会话。不传则读 DSH_IM_NATIVE_TTL_MS，再默认 30 分钟。 */
  ttlMs?: number
  now?: () => number
  /** 提供之后，setup 会把插件工具 register 进 agent，不再把勾选当成能力缺口。 */
  executeTool?: (call: {
    name: string
    args: Record<string, unknown>
    projectRoot: string
    threadId: string
    /** 谁在调用（记忆可见性用；原生会话 setup 时已知）。 */
    personaId?: string
    /** 本轮群级预算（热区 windowChars）：记忆工具多跳展开按它的 15% 限总字数。 */
    budgetChars?: number
    cache: TurnToolCache
  }) => Promise<string>
  /** 宿主 tools 服务探测：缺 register/guard 时原生模式整体不可用（诚实回退，不半残运行）。 */
  hostTools?: () => HostToolsProbe | undefined
  /** 工具来源组声明（配置覆盖/追加出厂声明）。 */
  toolGroups?: ToolGroupDecl[]
}

interface Entry {
  handle: NativeAgentHandle
  sessionId: string
  lastUsedAt: number
  /** setup 里监听到的 agent/request-error，空回复时带出来便于诊断。 */
  lastError?: string
  /** agent/status 时间戳，用来看 16 秒卡在哪。 */
  statusLog: string[]
  /** 已投喂到的最大 seq。下一轮只喂比它新的行。 */
  lastDeliveredSeq: number
  /** 本 entry 的 setup 成功注册系统提示词的次数（正常为 1）。 */
  setupCalls: number
  /** 每轮实际 followup 的字符数。 */
  feedChars: number[]
  /** 实际传给 restrict 的 allow；空数组表示没有收窄。 */
  allow: string[]
  /** setup 时 tools.schemas 看到的工具名。 */
  schemas: string[]
  /** 最近一轮的 toolAllow：guard 闭包读它，保证中途改勾选能生效。 */
  toolAllow?: string[]
  /** 宿主没有 systemPrompt：每轮退回整段投喂，不走增量。 */
  fullFeed: boolean
  /** 插件工具注册状态。setup 和后续轮次共用。 */
  mount?: ToolMount
}

interface ToolMount {
  tools?: ToolsService
  scope?: unknown
  disposers: Map<string, () => unknown>
  projectRoot: string
  threadId: string
  /** 谁在调用（记忆可见性用；从 sessionKey/personaId 推）。 */
  personaId?: string
  /** 本轮群级预算（热区 windowChars）：记忆工具多跳展开的额度来源。 */
  budgetChars?: number
  cache: TurnToolCache
  steps: TurnStepTrace[]
  covered: string[]
  visible?: string[]
  prompt?: PromptService
  factsDispose?: () => void
  factsText?: string
  /** 来源组声明（配置 + 出厂）。 */
  declared: ToolGroupDecl[]
  /** 当前宿主工具来源组（发现结果，guard 报错文案/调试用）。 */
  groups: DiscoveredToolGroup[]
  /** 当前授权下真正生效的宿主工具（可见性收窄的依据）。 */
  hostGranted: string[]
  /** hostGranted 的签名：变了就要重建会话（工具可见性不能原地放宽）。 */
  hostSignature: string
  /** 本轮群级预算（热区 windowChars）：记忆工具多跳展开的额度来源。 */
  memoryBudgetChars?: number
  /** 单轮工具调用预算（每轮重置；到上限后拒绝执行并让 agent 直接作答）。 */
  toolBudget?: ToolCallBudget
  /** 本轮实际执行（非拒绝）的插件工具次数。 */
  toolExecuted?: number
}

export interface NativeDebugSession {
  sessionKey: string
  sessionId: string
  lastError?: string
  roles: string[]
  lastText: string
  setupCalls: number
  lastDeliveredSeq: number
  feedChars: number[]
  allow: string[]
  schemas: string[]
  /** 当前授权下真正生效的宿主工具（来源组/单工具）。 */
  hostGranted?: string[]
  /** 发现到的来源组 id（浏览器/MCP server/其他）。 */
  toolGroups?: string[]
  toolAllow?: string[]
}

export interface NativeDebugInfo {
  sessions: NativeDebugSession[]
}

const DEFAULT_NATIVE_TTL_MS = 30 * 60 * 1000

/** 读 DSH_IM_NATIVE_TTL_MS；非法或未设置时用 30 分钟。 */
export function nativeTtlMs(raw = process.env.DSH_IM_NATIVE_TTL_MS): number {
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return DEFAULT_NATIVE_TTL_MS
}

/**
 * 角色能力集不再映射成宿主工具名。
 * 读/搜索/写/跑检查要等插件工具注册进 agent 之后才走原生；在那之前客户端直接回退。
 * 空数组表示不调用 restrict。越权拦截靠 guard。
 * DSH_IM_NATIVE_TOOL_ALLOW 非空时整表覆盖，只给排查用；guard 仍会拒绝名单以外的工具。
 */
export function resolveNativeToolAllow(toolAllow?: string[]): string[] {
  void toolAllow
  const env = process.env.DSH_IM_NATIVE_TOOL_ALLOW
  if (env && env.trim()) return env.split(',').map((item) => item.trim()).filter(Boolean)
  return []
}

/** 插件工具需要的角色能力。list_dir 单独处理：读或搜索都能用。 */
const PLUGIN_TOOL_CAPABILITY: Partial<Record<(typeof PLUGIN_TOOL_NAMES)[number], 'read' | 'search' | 'write' | 'check'>> = {
  read_file: 'read',
  search_files: 'search',
  write_file: 'write',
  run_check: 'check',
}

export function nativeToolAllowDenial(name: string, toolAllow?: string[]): string | undefined {
  // undefined 的语义是“继承主会话全部能力”，显式化，不靠隐式放行。
  const allowed = toolAllow ?? inheritedToolIds()
  if (name === 'list_dir') {
    if (allowed.includes('read') || allowed.includes('search')) return undefined
    return '专家角色没有「read」或「search」能力，不能使用 list_dir'
  }
  const capability = PLUGIN_TOOL_CAPABILITY[name as (typeof PLUGIN_TOOL_NAMES)[number]]
  if (!capability || allowed.includes(capability)) return undefined
  return `专家角色没有「${capability}」能力，不能使用宿主工具 ${name}`
}

function knownGlobalTools(message: string): string[] {
  const marker = 'known global tools: '
  const at = message.indexOf(marker)
  if (at < 0) return []
  const rest = message.slice(at + marker.length).trim()
  if (!rest || rest.startsWith('(none)')) return []
  return rest.split(',').map((item) => item.trim()).filter(Boolean)
}

function capsFromToolNames(names: string[]): string[] {
  const caps: string[] = []
  if (names.includes('read_file')) caps.push('read')
  if (names.includes('search_files')) caps.push('search')
  if (names.includes('write_file')) caps.push('write')
  if (names.includes('run_check')) caps.push('check')
  return caps
}

/**
 * 角色能力集里，宿主上真实存在的同名工具。
 * 对不上就返回空，不偷偷换成浏览器或 MCP 工具。
 * 空数组表示不调用 restrict。越权拦截靠 guard，不靠这份名单。
 */
export function pickNativeAllow(wanted: string[], schemas: string[]): string[] {
  if (!schemas.length) return wanted
  const known = new Set(schemas)
  return wanted.filter((name) => known.has(name))
}

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-im' } as const
/** followup 用 user 才会被循环当成一轮提示词领走。plugin 来源进队但不打开步骤，whenIdle 立刻返回，messages 保持 0。 */
const TURN_SOURCE = { kind: 'user' } as const

function withTimeout<T>(task: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout() } catch { /* ignore */ }
      reject(Object.assign(new Error(`原生会话 ${Math.round(ms / 1000)}s 未完成（可能在等审批）`), { code: 'NATIVE_TIMEOUT' }))
    }, ms)
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export function nativeSessionId(sessionKey: string): string {
  const digest = stableHash(sessionKey).split(':').at(-1) ?? '0'
  return `im-${digest}`
}

/**
 * 从原生会话消息里只取**正文** block（type='text'）。
 * DSH 的 assistant content 会同时带 ReasoningBlock {type:'reasoning', text}（思维链），
 * 之前这里“凡是有 text 字段就拼”把思维链也当回复落库/显示了；现在只认 type==='text'。
 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const record = block as { type?: unknown; text?: unknown }
      if (record.type !== 'text') return ''
      return typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

export function dumpNativeDiag(line: string): void {
  try {
    const causeLog = process.env.DSH_IM_NATIVE_CAUSE_LOG?.trim()
    if (!causeLog) return
    mkdirSync(dirname(causeLog), { recursive: true })
    appendFileSync(causeLog, line + '\n', 'utf8')
  } catch {
    // 诊断文件写失败不影响主路径。
  }
}

export function describeFailure(error: unknown, depth = 0): unknown {
  if (depth > 3 || error == null) return error == null ? undefined : String(error)
  if (typeof error !== 'object') return String(error)
  const item = error as {
    name?: string
    code?: unknown
    message?: string
    stack?: string
    cause?: unknown
    failure?: unknown
  }
  const stack = typeof item.stack === 'string' ? item.stack.split('\n').slice(0, 5) : undefined
  return {
    name: item.name,
    code: item.code,
    message: item.message,
    ...(stack ? { stack } : {}),
    ...(item.cause !== undefined ? { cause: describeFailure(item.cause, depth + 1) } : {}),
    ...(item.failure !== undefined ? { failure: describeFailure(item.failure, depth + 1) } : {}),
  }
}

function errorChain(payload: unknown): string {
  const record = payload as { error?: unknown; message?: string } | undefined
  const target = record?.error ?? payload
  try {
    return JSON.stringify(describeFailure(target))
  } catch {
    return record?.message ?? String(payload)
  }
}

function summarizeEvent(payload: unknown): string {
  try { return JSON.stringify(payload).slice(0, 180) } catch { return String(payload).slice(0, 180) }
}

function safeMessageCount(agent: NativeAgent): number {
  try { return agent.session.deriveMessages().length } catch { return -1 }
}

/** 取会话里最后一条 assistant 文本（原生会话的回复来源）。 */
export function lastAssistantText(messages: readonly NativeMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = messageText(message.content).trim()
    if (text) return text
  }
  return ''
}

/** 这一轮里宿主自己执行的工具（浏览器、画图）。插件工具已经在 execute 里记过，这里跳过。 */
export function hostToolSteps(messages: readonly NativeMessage[]): TurnStepTrace[] {
  const pending: { name: string; args: unknown }[] = []
  const steps: TurnStepTrace[] = []
  for (const message of messages) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const record = block as { type?: string; name?: string; arguments?: unknown }
      if (record.type === 'tool-call' && typeof record.name === 'string') {
        pending.push({ name: record.name, args: record.arguments })
      }
    }
    if (message?.role !== 'tool' || !pending.length) continue
    const call = pending.shift()
    if (!call || (PLUGIN_TOOL_NAMES as readonly string[]).includes(call.name)) continue
    const text = messageText(message.content)
    const started = Date.now()
    const denied = /不能使用|没有授予|没有「/.test(text) || /^Error[:：]/.test(text.trim())
    steps.push(traceToolStep(steps.length + 1, call.name, call.args, text, !denied, started))
  }
  return steps
}

function scopedService(ctx: unknown, name: string): unknown {
  if (!ctx || typeof ctx !== 'object') return undefined
  const bag = ctx as { get?: (service: string) => unknown }
  try {
    const viaGet = typeof bag.get === 'function' ? bag.get(name) : undefined
    if (viaGet) return viaGet
  } catch {
    // 这个作用域没有该服务。
  }
  const direct = (ctx as Record<string, unknown>)[name]
  return direct === undefined ? undefined : direct
}

function renderLine(line: NativeFrameLine): string {
  const head = `[#${line.seq}]`
  if (line.kind === 'system') return `${head}[系统] ${line.text}`
  if (line.kind === 'user') return `${head}[用户 ${line.authorName}] ${line.text}`
  return `${head}[角色 ${line.authorName}] ${line.text}`
}

function factsSectionText(frame: NativeFrame | undefined): string {
  const lines = (frame?.factsL2 ?? []).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return ''
  return [`[不可压缩事实 截止 #${frame?.factsUntilSeq ?? 0}]`, ...lines].join('\n')
}

function rememberFacts(prompt: PromptService, factsText: string): (() => void) | undefined {
  const dispose = prompt.section?.({ name: 'dsh-im:facts-l2', order: 9100, text: factsText })
  return typeof dispose === 'function' ? dispose as () => void : undefined
}

function schemaNames(listed: unknown): string[] {
  if (!Array.isArray(listed)) return []
  return listed.map((item) => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      return (item as { name: string }).name
    }
    return ''
  }).filter(Boolean)
}

interface PromptService {
  section?: (spec: { name: string; order: number; text: string }) => unknown
}

interface ToolsService {
  restrict?: (filter: { allow?: string[]; deny?: string[] }) => unknown
  schemas?: (scope?: unknown) => unknown
  guard?: (guard: (exec: { name?: string }) => string | undefined) => unknown
  register?: (definition: ReturnType<typeof personaToolDefinition>) => unknown
}

export class NativeAgentSessions {
  private readonly sessions = new Map<string, Entry>()
  private readonly ttlMs: number
  private readonly now: () => number
  private lastChecks: NativeChecks | undefined

  constructor(private readonly options: NativeAgentSessionsOptions) {
    this.ttlMs = options.ttlMs ?? nativeTtlMs()
    this.now = options.now ?? Date.now
  }

  status(): {
    enabled: boolean
    reason?: string
    checks?: NativeChecks
    capabilities?: { read: boolean; search: boolean; write: boolean; check: boolean }
    hostToolGroups?: number
  } {
    const agents = this.options.agents()
    if (!agents) return { enabled: false, reason: '宿主没有 ctx.agents' }
    const host = this.options.hostTools?.()
    const registerReady = typeof host?.register === 'function'
    const guardReady = typeof host?.guard === 'function'
    // 缺注册/守卫时不半残运行：能力契约保证不了就整体回退 ctx.llm（诚实降级）。
    if (this.options.executeTool && (!registerReady || !guardReady)) {
      return {
        enabled: false,
        reason: '宿主缺少 agent 作用域的工具注册/守卫（tools.register / tools.guard），原生会话无法保证能力契约；本轮回退 ctx.llm',
      }
    }
    const covered = Boolean(this.options.executeTool) && registerReady
    const capabilities = { read: covered, search: covered, write: covered, check: covered }
    const hostToolGroups = this.discoverHostGroups().length
    if (!this.lastChecks) return { enabled: true, capabilities, hostToolGroups }
    return { enabled: true, checks: this.lastChecks, capabilities, hostToolGroups }
  }

  private declaredGroups(): ToolGroupDecl[] {
    const configured = this.options.toolGroups ?? []
    return configured.length ? [...BUILTIN_TOOL_GROUPS, ...configured] : [...BUILTIN_TOOL_GROUPS]
  }

  /** 宿主全局工具名（host-plane）。来源组发现、会话重建判定共用。 */
  private hostToolNames(): string[] {
    const host = this.options.hostTools?.()
    if (!host || typeof host.schemas !== 'function') {
      try {
        return schemaNames((host?.schemas as (() => unknown) | undefined)?.())
      } catch {
        return []
      }
    }
    try { return schemaNames(host.schemas()) } catch { return [] }
  }

  private discoverHostGroups(): DiscoveredToolGroup[] {
    return discoverToolGroups(this.hostToolNames(), this.declaredGroups())
  }

  /** 当前授权下应当生效的宿主工具 + 签名（签名变化 → 重建会话）。 */
  private desiredHostGrant(input: NativeBridgeInput): { names: string[]; signature: string } {
    const names = effectiveHostTools(this.hostToolNames(), input.toolAllow, this.declaredGroups())
    return { names, signature: JSON.stringify(names) }
  }

  /** 事实投影变了就换掉 dsh-im:facts-l2。没变不碰，避免每轮重注册。 */
  private refreshFacts(entry: Entry, input: NativeBridgeInput): void {
    const mount = entry.mount
    const prompt = mount?.prompt
    if (!mount || !prompt || typeof prompt.section !== 'function') return
    const next = factsSectionText(input.frame)
    if (next === (mount.factsText ?? '')) return
    try { mount.factsDispose?.() } catch { /* 旧段卸不掉就盖一层 */ }
    mount.factsDispose = undefined
    mount.factsText = next
    if (!next) return
    try {
      mount.factsDispose = rememberFacts(prompt, next)
    } catch (error) {
      this.options.logger?.warn?.(
        `[dsh-im] 更新事实段失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 释放空闲超时的原生会话（惰性清扫，避免定时器常驻）。 */
  sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastUsedAt < this.ttlMs) continue
      this.sessions.delete(key)
      void this.hideFromSidebar(entry.sessionId).finally(() => {
        void entry.handle.dispose().catch(() => undefined)
      })
    }
  }

  /**
   * 按「角色 × 群」释放匹配的原生会话（sessionKey = `personaId:threadId`）。
   * 删除会话 / 删除角色 / 清空聊天记录后调用：被删的历史不能继续留在宿主内存里。
   * 返回释放条数；没匹配到就是 0（不假装做了事）。
   */
  async forget(filter: { personaId?: string; threadId?: string }): Promise<number> {
    const personaId = filter.personaId?.trim()
    const threadId = filter.threadId?.trim()
    if (!personaId && !threadId) return 0
    const matches: { key: string; entry: Entry }[] = []
    for (const [key, entry] of this.sessions) {
      const sep = key.indexOf(':')
      const keyPersona = sep >= 0 ? key.slice(0, sep) : key
      const keyThread = sep >= 0 ? key.slice(sep + 1) : ''
      if (personaId && keyPersona !== personaId) continue
      if (threadId && keyThread !== threadId) continue
      matches.push({ key, entry })
    }
    for (const item of matches) {
      this.sessions.delete(item.key)
      await this.hideFromSidebar(item.entry.sessionId)
      await item.entry.handle.dispose().catch(() => undefined)
    }
    return matches.length
  }

  async complete(input: NativeBridgeInput): Promise<{ text: string; trace?: TurnStepTrace[]; toolStats?: NativeToolStats }> {
    const turnStartedAt = this.now()
    const agents = this.options.agents()
    if (!agents) throw Object.assign(new Error('宿主没有 ctx.agents，原生会话不可用'), { code: 'NATIVE_UNAVAILABLE' })
    this.sweep()
    let fresh = !this.sessions.has(input.sessionKey)
    let resumed = false
    let rebuilt = false
    let entry = this.sessions.get(input.sessionKey)
    // 授权/来源组变了：工具可见性在 agent 创建时固定，不能原地放宽 → 重建会话。
    if (entry?.mount) {
      const desired = this.desiredHostGrant(input)
      if (desired.signature !== entry.mount.hostSignature) {
        this.options.logger?.warn?.(
          `[dsh-im] 原生会话授权/来源组变化，重建 key=${input.sessionKey}（旧授权工具 ${entry.mount.hostGranted.length} 个，新 ${desired.names.length} 个）`,
        )
        this.sessions.delete(input.sessionKey)
        await entry.handle.dispose().catch(() => undefined)
        entry = undefined
        fresh = true
        rebuilt = true
      }
    }
    if (!entry) {
      const forceSessionId = rebuilt ? `${nativeSessionId(input.sessionKey)}-${this.now().toString(36)}` : undefined
      const created = await this.createEntry(agents, input, forceSessionId)
      entry = created.entry
      resumed = created.resumed
      // 以宿主探测结果作为后续比较的规范签名（setup 内部的视图可能更窄）。
      if (entry.mount) entry.mount.hostSignature = this.desiredHostGrant(input).signature
    }
    entry.lastUsedAt = this.now()
    // 授权变更（插件能力勾选）走同步；宿主工具授权变更已在上面的签名比较里重建。
    if (entry.toolAllow && !input.toolAllow) {
      this.options.logger?.warn?.('[dsh-im] 本轮 toolAllow 缺省，原生会话从“已收窄”放宽为“继承全部”')
    }
    entry.toolAllow = input.toolAllow
    this.refreshFacts(entry, input)
    if (entry.mount) {
      entry.mount.projectRoot = input.cwd ?? entry.mount.projectRoot
      entry.mount.threadId = input.threadId ?? entry.mount.threadId
      entry.mount.memoryBudgetChars = input.memoryBudgetChars
      // 每轮重置工具调用预算（缺陷修复：原生路径单轮工具也可能失控）。
      entry.mount.toolBudget = createToolCallBudget(input.maxToolCalls ?? toolCallLimitFromEnv())
      entry.mount.toolExecuted = 0
      entry.mount.cache = createTurnToolCache()
      entry.mount.steps = []
      if (entry.mount.tools && this.options.executeTool) {
        await this.syncPersonaTools(entry.mount, input.toolAllow)
        entry.allow = [...entry.mount.disposers.keys()]
      }
    }
    const fed = this.feedText(entry, input, fresh && !resumed)
    entry.feedChars.push(fed.text.length)
    const handle = entry.handle
    this.options.logger?.warn?.(
      `[dsh-im] native turn key=${input.sessionKey} fresh=${fresh} setupCalls=${entry.setupCalls} feedLines=${fed.lines} feedChars=${fed.text.length} lastSeq=${entry.lastDeliveredSeq} allow=${entry.allow.join(',')}`,
    )
    const beforeCount = safeMessageCount(handle.agent)
    this.options.logger?.warn?.(
      `[dsh-im] native before followup status=${handle.agent.status ?? ''} messages=${beforeCount}`,
    )
    handle.agent.followup({
      // 必须给完整 user message：DSH 的 followup 不会补 role/id（缺 role 会让
      // deepseek 适配器 serialize 崩成 TRANSPORT）。见 NativeUserMessage 注释。
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: fed.text }],
      source: TURN_SOURCE,
    })
    // 原生 agent 可能要等审批/工具，不能让请求无限挂着；超时就取消并报错。
    await withTimeout(handle.agent.whenIdle(), 120_000, () => {
      try { handle.agent.cancel?.('dsh-im native timeout') } catch { /* ignore */ }
    })
    const messages = handle.agent.session.deriveMessages()
    this.options.logger?.warn?.(
      `[dsh-im] native after idle status=${handle.agent.status ?? ''} messages=${messages.length}`,
    )
    const text = lastAssistantText(messages)
    const hostSteps = hostToolSteps(messages.slice(Math.max(0, beforeCount)))
    if (entry.mount) {
      for (const step of hostSteps) {
        entry.mount.steps.push({ ...step, step: entry.mount.steps.length + 1 })
      }
    }
    entry.lastUsedAt = this.now()
    if (!text.trim()) {
      const roles = messages.slice(-6).map((message) => String(message?.role ?? '?')).join(',')
      const detail = entry.lastError ? `；agent 错误：${entry.lastError}` : ''
      const statusDetail = entry.statusLog.length ? `；status：${entry.statusLog.join(' | ')}` : ''
      const empty = new Error(`原生会话返回空内容（session ${entry.sessionId}，messages=${messages.length}，roles=${roles}${detail}${statusDetail}）`)
      dumpNativeDiag(empty.message)
      throw Object.assign(empty, { code: 'NATIVE_EMPTY' })
    }
    const toolStats: NativeToolStats | undefined = entry.mount?.toolBudget
      ? {
        toolCalls: entry.mount.toolBudget.used(),
        toolExecuted: entry.mount.toolExecuted ?? 0,
        toolBudgetExhausted: entry.mount.toolBudget.used() >= entry.mount.toolBudget.limit,
        toolCallLimit: entry.mount.toolBudget.limit,
      }
      : undefined
    if (toolStats && entry.mount) {
      // trace 里明确记一笔：本轮工具调用统计（即使没有宿主工具步骤也要可审计）。
      entry.mount.steps.push({
        step: entry.mount.steps.length + 1,
        kind: 'reply',
        name: 'tool-budget',
        result: `toolCalls=${toolStats.toolCalls} toolExecuted=${toolStats.toolExecuted} toolCallLimit=${toolStats.toolCallLimit} toolBudgetExhausted=${toolStats.toolBudgetExhausted}`,
        ok: !toolStats.toolBudgetExhausted,
        at: Date.now(),
        ms: Date.now() - turnStartedAt,
        toolCalls: toolStats.toolCalls,
        toolExecuted: toolStats.toolExecuted,
        toolBudgetExhausted: toolStats.toolBudgetExhausted,
      })
    }
    return {
      text,
      ...(entry.mount && entry.mount.steps.length ? { trace: [...entry.mount.steps] } : {}),
      ...(toolStats ? { toolStats } : {}),
    }
  }

  /** 诊断：当前原生会话的派生消息角色与最近文本。 */
  debug(): NativeDebugInfo {
    return {
      sessions: [...this.sessions.entries()].map(([sessionKey, entry]) => {
        let roles: string[] = []
        let lastText = ''
        try {
          const messages = entry.handle.agent.session.deriveMessages()
          roles = messages.slice(-8).map((message) => String(message?.role ?? '?'))
          lastText = lastAssistantText(messages).slice(0, 200)
        } catch {
          // debug 尽力而为
        }
        return {
          sessionKey,
          sessionId: entry.sessionId,
          ...(entry.lastError ? { lastError: entry.lastError } : {}),
          roles,
          lastText,
          setupCalls: entry.setupCalls,
          lastDeliveredSeq: entry.lastDeliveredSeq,
          feedChars: [...entry.feedChars],
          allow: [...entry.allow],
          schemas: [...entry.schemas],
          ...(entry.mount ? { hostGranted: [...entry.mount.hostGranted] } : {}),
          ...(entry.mount ? { toolGroups: entry.mount.groups.map((group) => group.id) } : {}),
          ...(entry.toolAllow ? { toolAllow: [...entry.toolAllow] } : {}),
        }
      }),
    }
  }

  /** 按当前授权注册插件工具，并卸掉这次没勾的。宿主工具按来源组授权收窄可见性，guard 再兜一层。 */
  private async syncPersonaTools(mount: ToolMount, toolAllow?: string[]): Promise<void> {
    const executeTool = this.options.executeTool
    if (!executeTool) return
    const tools = mount.tools
    const wanted = pluginToolsForAllow(toolAllow)
    const wantedSet = new Set(wanted)
    for (const [name, dispose] of mount.disposers) {
      if (wantedSet.has(name)) continue
      try { await dispose() } catch { /* 卸不掉时 guard 仍会拒绝 */ }
      mount.disposers.delete(name)
    }
    if (wanted.length && typeof tools?.register !== 'function') {
      const labels = nativeCapabilityGap(toolAllow, []).map(toolLabel).join('、')
      throw Object.assign(new Error(`原生会话还没挂上这些能力：${labels}。本轮应走兼容路径。`), { status: 409 })
    }
    if (tools && !mount.hostSignature) await this.hideHostTools(mount, tools, mount.scope, toolAllow)
    for (const name of wanted) {
      if (mount.disposers.has(name) || !tools?.register) continue
      try {
        const dispose = await tools.register(personaToolDefinition(name, async (args) => {
          const started = Date.now()
          const grant = mount.toolBudget?.tryReserve()
          if (grant && !grant.ok) {
            // 到上限：明确拒绝并让 agent 停止调工具、直接作答（不是静默丢弃）。
            mount.steps.push(traceToolStep(mount.steps.length + 1, name, args, grant.message, false, started))
            this.options.logger?.warn?.(`[dsh-im] native 工具调用到上限：${grant.message}`)
            return grant.message
          }
          const text = await executeTool({
            name,
            args: args ?? {},
            projectRoot: mount.projectRoot,
            threadId: mount.threadId,
            ...(mount.personaId ? { personaId: mount.personaId } : {}),
            ...(mount.memoryBudgetChars === undefined ? {} : { budgetChars: mount.memoryBudgetChars }),
            cache: mount.cache,
          })
          mount.toolExecuted = (mount.toolExecuted ?? 0) + 1
          mount.steps.push(traceToolStep(mount.steps.length + 1, name, args, text, true, started))
          return text
        }))
        mount.disposers.set(name, typeof dispose === 'function' ? dispose as () => unknown : () => undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/already registered/i.test(message)) {
          mount.disposers.set(name, () => undefined)
          continue
        }
        const labels = nativeCapabilityGap(toolAllow, capsFromToolNames([...mount.disposers.keys()])).map(toolLabel).join('、')
        throw Object.assign(
          new Error(`原生会话还没挂上这些能力：${labels || toolLabel(name)}。本轮应走兼容路径。`),
          { status: 409 },
        )
      }
    }
    mount.covered = capsFromToolNames([...mount.disposers.keys()])
    if (typeof tools?.schemas === 'function') {
      try { mount.visible = schemaNames(tools.schemas(mount.scope)) }
      catch { mount.visible = [...mount.disposers.keys()] }
    } else {
      mount.visible = [...mount.disposers.keys()]
    }
  }

  /**
   * 按来源组授权收窄宿主工具可见性：
   * - 被授予的组/单工具保留；
   * - 其余全部 restrict deny（restrict 只挡继承工具，own-scope 注入的工具由 guard 兜）；
   * - 同时记录 hostGranted 签名，授权变化时由 complete() 重建会话。
   */
  private async hideHostTools(
    mount: ToolMount,
    tools: ToolsService,
    scope: unknown,
    toolAllow?: string[],
  ): Promise<void> {
    if (typeof tools.schemas !== 'function' || typeof tools.restrict !== 'function') return
    const read = () => {
      try { return schemaNames(tools.schemas?.(scope)) } catch { return [] }
    }
    const before = read()
    const declared = mount.declared
    const hostBefore = before.filter((name) => !(PLUGIN_TOOL_NAMES as readonly string[]).includes(name))
    const granted = effectiveHostTools(hostBefore, toolAllow, declared)
    const grantedSet = new Set(granted)
    mount.groups = discoverToolGroups(hostBefore, declared)
    mount.hostGranted = granted
    mount.hostSignature = JSON.stringify(granted)
    const hidden = hostBefore.filter((name) => !grantedSet.has(name))
    let errorMessage = ''
    if (hidden.length) {
      try {
        await tools.restrict({ deny: hidden })
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error)
        const known = knownGlobalTools(errorMessage).filter((name) => hidden.includes(name))
        if (known.length) {
          try {
            await tools.restrict({ deny: known })
            errorMessage = ''
          } catch (again) {
            errorMessage = again instanceof Error ? again.message : String(again)
          }
        }
      }
    }
    await Promise.resolve()
    const after = read()
    dumpNativeDiag(JSON.stringify({
      at: Date.now(),
      before: before.length,
      after: after.length,
      granted,
      hiddenCount: hidden.length,
      groups: mount.groups.map((group) => `${group.id}(${group.tools.length})`),
      hostLeft: after.filter((name) => !(PLUGIN_TOOL_NAMES as readonly string[]).includes(name)).slice(0, 12),
      error: errorMessage.slice(0, 500),
    }))
    if (errorMessage) {
      this.options.logger?.warn?.(`[dsh-im] 隐藏未授权宿主工具失败，改由 guard 拒绝：${errorMessage}`)
    }
  }

  /** 有 frame 且系统提示词已注册时只喂增量；否则整段投喂（旧调用 / 宿主没有 systemPrompt）。 */
  private feedText(entry: Entry, input: NativeBridgeInput, fresh: boolean): { text: string; lines: number } {
    const whole = [input.system?.trim(), input.prompt?.trim()].filter(Boolean).join('\n\n')
    const windowLines = input.frame?.windowLines ?? []
    if (!input.frame || entry.fullFeed) return { text: whole, lines: whole ? whole.split('\n').length : 0 }
    const selfName = input.personaName ?? ''
    const unseen = (line: NativeFrameLine) => fresh || line.seq > entry.lastDeliveredSeq
    const notSelf = (line: NativeFrameLine) => line.authorName !== selfName
    const lines = windowLines.filter(notSelf).filter(unseen)
    const current = input.frame.currentLine
    const includeCurrent = Boolean(
      current && notSelf(current) && !lines.some((line) => line.seq === current.seq),
    )
    const memoryBlock = input.frame?.memoryBlock?.trim()
    // 双层窗口：L1 摘要 + 冷区章节目录按"本轮用户文本"追加（只在记忆层 on 时由 runtime 填）。
    const contextBlock = input.frame?.contextBlock?.trim()
    const rendered = [
      ...lines.map(renderLine),
      ...(includeCurrent && current ? [renderLine(current)] : []),
      ...(memoryBlock ? [memoryBlock] : []),
      ...(contextBlock ? [contextBlock] : []),
    ]
    const seqs = lines.map((line) => line.seq)
    if (includeCurrent && current) seqs.push(current.seq)
    if (seqs.length) entry.lastDeliveredSeq = Math.max(entry.lastDeliveredSeq, ...seqs)
    return { text: rendered.join('\n'), lines: rendered.length }
  }

  private async createEntry(
    agents: NativeAgentsApi,
    input: NativeBridgeInput,
    forceSessionId?: string,
  ): Promise<{ entry: Entry; resumed: boolean }> {
    let sessionId = forceSessionId ?? input.sessionIdOverride?.trim() ?? nativeSessionId(input.sessionKey)
    let entry: Entry | undefined
    let setupCalls = 0
    let fullFeed = false
    let allow: string[] = []
    let schemas: string[] = []
    let resumed = false
    let guarded = false
    const declared = this.declaredGroups()
    const mount: ToolMount = {
      disposers: new Map(),
      projectRoot: input.cwd ?? '',
      threadId: input.threadId ?? 'im',
      // 会话归属是「角色×群」：sessionKey = personaId:threadId，缺 personaId 时从这里推。
      ...((input as { personaId?: string; sessionKey?: string }).personaId ?? (input.sessionKey ? String(input.sessionKey).split(':')[0] : '')
        ? { personaId: (input as { personaId?: string }).personaId ?? String(input.sessionKey).split(':')[0] }
        : {}),
      cache: createTurnToolCache(),
      steps: [],
      covered: [],
      declared,
      groups: [],
      hostGranted: [],
      hostSignature: '',
    }
    const setup = async (agentCtx: unknown) => {
        try {
          const ctx = agentCtx as { on?: (event: string, listener: (payload: unknown) => void) => unknown }
          ctx.on?.('agent/status', (payload) => {
          const status = payload && typeof payload === 'object' && 'status' in payload
            ? String((payload as { status?: unknown }).status)
            : summarizeEvent(payload)
          const line = `${Date.now()} ${status}`
          if (entry) entry.statusLog.push(line)
          this.options.logger?.warn?.(`[dsh-im] native agent/status ${line}`)
        })
        ctx.on?.('agent/created', (payload) => {
          this.options.logger?.warn?.(`[dsh-im] native agent/created ${summarizeEvent(payload)}`)
        })
        const remember = (payload: unknown) => {
            if (!entry) return
            entry.lastError = errorChain(payload).slice(0, 4000)
            this.options.logger?.warn?.(`[dsh-im] native agent error ${entry.lastError}`)
          }
        ctx.on?.('agent/request-error', remember)
        ctx.on?.('agent/error', remember)
        } catch {
          // 版本不支持该事件时忽略。
        }
        const mode = input.setupMode ?? 'all'
        const prompt = scopedService(agentCtx, 'systemPrompt') as PromptService | undefined
        const factsText = factsSectionText(input.frame)
        if (mode === 'restrict' || mode === 'bcdp' || mode === 'mcp') {
          // 这一刀不注册段。
        } else if (prompt && typeof prompt.section === 'function') {
          mount.prompt = prompt
          prompt.section({ name: 'dsh-im:persona', order: 9000, text: input.system?.trim() ?? '' })
          mount.factsText = factsText
          if (factsText) mount.factsDispose = rememberFacts(prompt, factsText)
          setupCalls += 1
        } else {
          fullFeed = true
          this.options.logger?.warn?.('[dsh-im] 宿主无 systemPrompt 服务，原生会话退回整段投喂')
        }
        const tools = scopedService(agentCtx, 'tools') as ToolsService | undefined
        if (tools && typeof tools.guard === 'function') {
          tools.guard((exec) => {
            const name = typeof exec?.name === 'string' ? exec.name : ''
            const current = entry ? entry.toolAllow : input.toolAllow
            return personaHostToolDenial(name, current, declared) ?? nativeToolAllowDenial(name, current)
          })
          guarded = true
        }
        if (this.options.executeTool && mode === 'all') {
          mount.tools = tools
          mount.scope = agentCtx
          await this.syncPersonaTools(mount, input.toolAllow)
          allow = [...mount.disposers.keys()]
          schemas = mount.visible ?? allow
        } else {
          const wanted = resolveNativeToolAllow(input.toolAllow)
          if (tools && typeof tools.schemas === 'function') {
            try { schemas = schemaNames(tools.schemas(agentCtx)) } catch { schemas = [] }
          }
          if (mode === 'bcdp') allow = schemas.includes('bcdp_help') || !schemas.length ? ['bcdp_help'] : []
          else if (mode === 'mcp') allow = schemas.includes('read_mcp_resource') || !schemas.length ? ['read_mcp_resource'] : []
          else allow = pickNativeAllow(wanted, schemas)
          if (mode === 'sections') allow = []
          const missing = wanted.filter((name) => schemas.length > 0 && !allow.includes(name))
          if (missing.length) {
            this.options.logger?.warn?.(`[dsh-im] 宿主没有这些工具，已从白名单去掉：${missing.join(',')}；可见：${schemas.join(',')}`)
          }
          if (tools && typeof tools.restrict === 'function' && allow.length) {
            await tools.restrict({ allow })
            if (typeof tools.schemas === 'function') {
              try {
                // schemas(scope) 省略 scope 时是全局视图，看不到这次 restrict。用服务自己的 ctx。
                const scope = (tools as { ctx?: unknown }).ctx ?? agentCtx
                const visible = schemaNames(tools.schemas(scope))
                const narrowed = visible.filter((name) => allow.includes(name))
                if (narrowed.length) schemas = narrowed
              } catch { /* 保留收窄前的名单 */ }
            }
          } else if (!allow.length) {
            this.options.logger?.warn?.('[dsh-im] 原生工具白名单为空，不调用 restrict')
          }
        }
    }
    const mode = input.setupMode ?? 'all'
    const createOptions = {
      sessionId,
      meta: input.cwd ? { cwd: input.cwd } : {},
      agentOptions: {
        provider: input.provider,
        model: input.model,
        ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      },
      ...(mode === 'off' ? {} : { setup }),
    }
    let handle: NativeAgentHandle | undefined
    try {
      handle = await agents.create(createOptions)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/already exists/i.test(message)) throw error
      setupCalls = 0
      fullFeed = false
      allow = []
      schemas = []
      if (typeof agents.resume === 'function') {
        try {
          handle = await agents.resume(createOptions)
          resumed = true
        } catch (resumeError) {
          this.options.logger?.warn?.(`[dsh-im] resume native session failed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`)
        }
      }
      if (!resumed) {
        sessionId = `${nativeSessionId(input.sessionKey)}-${this.now().toString(36)}`
        handle = await agents.create({ ...createOptions, sessionId })
      }
    }
    if (!handle) throw new Error('原生会话没有创建出来')
    // 默认不在 create 后归档：归档写入会把紧接着的第一步收成 blocked。
    // DSH_IM_NATIVE_ARCHIVE=live 时用 stopActivity:false 试「隐藏但不停驱动」。
    if (process.env.DSH_IM_NATIVE_ARCHIVE === 'live') {
      await this.hideFromSidebar(sessionId, false)
    }
    const windowLines = input.frame?.windowLines ?? []
    const priorSeq = resumed && windowLines.length
      ? Math.max(...windowLines.map((line) => line.seq))
      : 0
    entry = {
      handle,
      sessionId,
      lastUsedAt: this.now(),
      lastDeliveredSeq: priorSeq,
      setupCalls,
      feedChars: [],
      statusLog: [],
      allow,
      schemas,
      fullFeed,
      toolAllow: input.toolAllow,
      mount,
    }
    this.lastChecks = {
      promptSection: setupCalls > 0,
      toolRestricted: mount.hostGranted.length > 0 || allow.length > 0,
      guard: guarded,
      allow: [...allow, ...mount.hostGranted.map((name) => `tool:${name}`)],
    }
    this.sessions.set(input.sessionKey, entry)
    return { entry, resumed }
  }

  /** 插件卸载/重载时释放全部原生会话。释放时才归档，避免活会话被归档门禁挡住。 */
  async disposeAll(): Promise<void> {
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(entries.map(async (entry) => {
      await this.hideFromSidebar(entry.sessionId)
      await entry.handle.dispose().catch(() => undefined)
    }))
  }

  private async hideFromSidebar(sessionId: string, stopActivity = false): Promise<void> {
    try {
      const workspace = this.options.workspace?.()
      const archive = workspace?.archiveSession
      if (!archive) return
      await archive.call(workspace, sessionId, { stopActivity })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.logger?.warn?.(`[dsh-im] archive native session failed: ${message}`)
      dumpNativeDiag(JSON.stringify({ at: Date.now(), archive: message, stopActivity, sessionId }))
    }
  }

  /** 测试/调试：当前活着的原生会话。 */
  liveSessionIds(): string[] {
    return [...this.sessions.values()].map((entry) => entry.sessionId)
  }
}

/** host 侧组装：从 ctx 里拿 agents/workspaceRegistry；未启用或宿主缺 agents 时返回 undefined。 */
export function createNativeRuntime(options: {
  agents: () => NativeAgentsApi | undefined
  workspace?: () => NativeWorkspaceApi | undefined
  logger?: { warn?: (message: string) => void }
  enabled: boolean
  ttlMs?: number
  now?: () => number
  /** 宿主 tools 服务探测（能力契约保证不了就整体回退）。 */
  hostTools?: () => HostToolsProbe | undefined
  /** 工具来源组声明（配置追加/覆盖出厂声明）。 */
  toolGroups?: ToolGroupDecl[]
}): { bridge?: NativeBridge; disposeAll: () => Promise<void> } {
  if (!options.enabled) return { disposeAll: async () => undefined }
  const sessions = new NativeAgentSessions({
    agents: options.agents,
    workspace: options.workspace,
    logger: options.logger,
    ttlMs: options.ttlMs ?? nativeTtlMs(),
    now: options.now,
    executeTool: (call) => executePersonaTool(call),
    ...(options.hostTools ? { hostTools: options.hostTools } : {}),
    ...(options.toolGroups ? { toolGroups: options.toolGroups } : {}),
  })
  return {
    bridge: {
      status: () => sessions.status(),
      complete: (input) => sessions.complete(input),
      debug: () => sessions.debug(),
      forget: (filter) => sessions.forget(filter),
    },
    disposeAll: () => sessions.disposeAll(),
  }
}
