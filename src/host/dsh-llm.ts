import { toolsForAllow } from '../core/tool-schema.ts'
import type { ModelContentPart, TurnStepTrace } from '../core/types.ts'
import { catalogModelId, type ModelOption } from './models.ts'
import { createToolCallBudget, toolCallLimitFromEnv } from './tool-call-budget.ts'

type StreamChunk = {
  type?: string
  text?: string
  /** block-start 的块类型：text / reasoning / tool-call…… */
  blockType?: string
  block?: { type?: string; text?: string; id?: string; name?: string; arguments?: string }
  reason?: { kind?: string; failure?: { message?: string; code?: string }; usage?: UsageLike }
  usage?: UsageLike
  meta?: { usage?: UsageLike }
}

/** 宿主流里出现的用量字段（字段名不统一，两套命名都收）。 */
export type UsageLike = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  promptTokens?: number
  completionTokens?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  /** 推理/缓存明细（不同厂商命名不同）。 */
  reasoningTokens?: number
  reasoning_tokens?: number
  cachedTokens?: number
  cached_tokens?: number
  completionTokensDetails?: { reasoningTokens?: number; reasoning_tokens?: number }
  promptTokensDetails?: { cachedTokens?: number; cached_tokens?: number }
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** 推理 token（是 output 的子集，不是可加项）。 */
  reasoningTokens?: number
  /** 命中缓存的 input token（成本口径用；inputTokens 是否含它由 provider 语义决定）。 */
  cachedTokens?: number
}

/** 从 finish chunk 里取用量；取不到返回 undefined（不编造 0）。 */
export function usageInChunk(chunk: StreamChunk | undefined): TokenUsage | undefined {
  const raw = chunk?.usage ?? chunk?.reason?.usage ?? chunk?.meta?.usage
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw.inputTokens ?? raw.promptTokens ?? raw.input_tokens
  const output = raw.outputTokens ?? raw.completionTokens ?? raw.output_tokens
  const total = raw.totalTokens ?? raw.total_tokens
  const reasoning = raw.reasoningTokens ?? raw.reasoning_tokens
    ?? raw.completionTokensDetails?.reasoningTokens ?? raw.completionTokensDetails?.reasoning_tokens
  const cached = raw.cachedTokens ?? raw.cached_tokens
    ?? raw.promptTokensDetails?.cachedTokens ?? raw.promptTokensDetails?.cached_tokens
  const usage: TokenUsage = {}
  if (typeof input === 'number' && Number.isFinite(input)) usage.inputTokens = input
  if (typeof output === 'number' && Number.isFinite(output)) usage.outputTokens = output
  if (typeof total === 'number' && Number.isFinite(total)) usage.totalTokens = total
  if (typeof reasoning === 'number' && Number.isFinite(reasoning)) usage.reasoningTokens = reasoning
  if (typeof cached === 'number' && Number.isFinite(cached)) usage.cachedTokens = cached
  return usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens === undefined
    ? undefined
    : usage
}

export type LlmService = {
  listProviders?: () => { id?: string; name?: string }[] | string[]
  listConfigurableProviders?: () => { provider?: string; displayName?: string }[]
  listModels?: (provider: string) => Promise<{ id?: string; name?: string; provider?: string }[]>
  stream?: (options: Record<string, unknown>) => AsyncIterable<StreamChunk>
  /** 宿主模型能力查询：真实签名是 `resolveModelInfo(provider, model, signal?)`（async）。 */
  resolveModelInfo?: (
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<{ context?: { contextWindow?: number } } & Record<string, unknown>>
}

const CONTEXT_WINDOW_KEYS = [
  'contextWindow',
  'context_window',
  'maxInputTokens',
  'max_input_tokens',
  'contextLength',
  'context_length',
] as const

function contextWindowOf(info: unknown): number | undefined {
  if (!info || typeof info !== 'object') return undefined
  const record = info as Record<string, unknown>
  // 真实 DSH 的形状：{ context: { contextWindow } }；其余键名是防御性兜底。
  const context = record.context
  if (context && typeof context === 'object') {
    const value = (context as { contextWindow?: unknown }).contextWindow
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  for (const key of CONTEXT_WINDOW_KEYS) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  const nested = record.modelInfo ?? record.info ?? record.capabilities
  if (nested && nested !== info) return contextWindowOf(nested)
  return undefined
}

/**
 * 模型上下文窗口：只按宿主真实签名 `resolveModelInfo(provider, model)` 调用并吞掉失败。
 *
 * 注意：传错参数形状会让宿主适配器查不到路由（NO_ADAPTER），而它返回的是 Promise，
 * 不 await 会变成未处理的 rejection（Electron 主进程会直接弹“应用无法启动”）。
 * 所以这里必须 `await` + try/catch，失败一律回 undefined（走默认预算）。
 */
export async function modelContextWindow(
  llm: LlmService | undefined,
  provider: string,
  model: string,
): Promise<number | undefined> {
  const resolver = llm?.resolveModelInfo
  if (!llm || typeof resolver !== 'function') return undefined
  try {
    return contextWindowOf(await resolver.call(llm, provider, model))
  } catch {
    return undefined
  }
}

/**
 * 后台结构化调用（事实抽取 / 共识整理）用的“最低推理档”。
 * 模型能力由宿主 resolveModelInfo 暴露（reasoning.efforts[].id）；取 advertised 里最低/最快的那个，
 * 查不到就不传（保持 provider 默认），绝不猜一个可能非法的 effort id。
 */
const fastEffortCache = new Map<string, string | undefined>()

export async function resolveFastReasoningEffort(
  llm: LlmService | undefined,
  provider: string,
  model: string,
): Promise<string | undefined> {
  const key = `${provider}::${model}`
  if (fastEffortCache.has(key)) return fastEffortCache.get(key)
  const resolver = llm?.resolveModelInfo
  if (!llm || typeof resolver !== 'function') {
    fastEffortCache.set(key, undefined)
    return undefined
  }
  try {
    const info = await resolver.call(llm, provider, model) as {
      reasoning?: { efforts?: { id?: unknown }[]; defaultEffort?: unknown }
    } & Record<string, unknown>
    const ids = (info.reasoning?.efforts ?? [])
      .map((effort) => effort?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    const rank = (id: string): number => (
      /^(minimal|low|none|off|fast)$/i.test(id) ? 0
        : /^(medium|mid)$/i.test(id) ? 1
          : /^(high|max)$/i.test(id) ? 2 : 3
    )
    const picked = [...ids].sort((left, right) => rank(left) - rank(right))[0]
    fastEffortCache.set(key, picked)
    return picked
  } catch {
    fastEffortCache.set(key, undefined)
    return undefined
  }
}

function providerId(row: { id?: string; name?: string } | string): string {
  if (typeof row === 'string') return row
  return row.id || row.name || ''
}

function providerLabel(row: { id?: string; name?: string } | string): string {
  if (typeof row === 'string') return row
  return row.name || row.id || ''
}

function callList<T>(fn: ((this: LlmService) => T) | undefined, llm: LlmService): T | undefined {
  if (typeof fn !== 'function') return undefined
  return fn.call(llm)
}

/** 与 DSH 模型选择器一致：账号、官方排最前，其余保持目录顺序。 */
const PROVIDER_ORDER = ['deepseek-account', 'deepseek-official']

function providerRank(route: string): number {
  const index = PROVIDER_ORDER.indexOf(route)
  return index === -1 ? PROVIDER_ORDER.length : index
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 宿主 DSH 的模型目录，和 GUI 的模型选择器同源：
 * 遍历 `listProviders()`，每个路由用 `listModels()` 取目录。
 * 目录读不出来的提供方也保留一行（`ready: false`），由界面显示为不可选。
 */
export async function listDshModels(llm: LlmService): Promise<ModelOption[]> {
  const providers = callList(llm.listProviders, llm) ?? []
  const out: ModelOption[] = []
  for (const row of providers) {
    const route = providerId(row)
    if (!route) continue
    const group = providerLabel(row) || route
    try {
      const models = (await llm.listModels?.call(llm, route)) ?? []
      for (const model of models) {
        const modelId = model.id?.trim()
        if (!modelId) continue
        const contextWindow = await modelContextWindow(llm, route, modelId)
        out.push({
          id: catalogModelId(route, modelId),
          label: model.name?.trim() || modelId,
          provider: group,
          route,
          modelId,
          ready: true,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        })
      }
    } catch (error) {
      out.push({
        id: catalogModelId(route, ''),
        label: group,
        provider: group,
        route,
        modelId: '',
        ready: false,
        note: errorMessage(error),
      })
    }
  }
  return out
    .map((option, index) => ({ option, index }))
    .sort((a, b) => (
      providerRank(a.option.route ?? '') - providerRank(b.option.route ?? '')
      || a.index - b.index
    ))
    .map((entry) => entry.option)
}

function userTurn(content: string | ModelContentPart[]) {
  return {
    role: 'user' as const,
    content: typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content,
  }
}

function contentText(content: string | ModelContentPart[]): string {
  if (typeof content === 'string') return content
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

/** trace 只存单行预览，避免把整份文件内容塞进 state.json。 */
function previewForTrace(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function assistantTurn(provider: string, model: string, content: unknown[]) {
  return {
    id: crypto.randomUUID(),
    role: 'assistant' as const,
    content,
    source: { kind: 'model' as const, provider, model },
  }
}

function toolTurn(callId: string, text: string, isError = false) {
  return {
    id: crypto.randomUUID(),
    role: 'tool' as const,
    toolCallId: callId,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'tool' as const, callId },
    isError,
  }
}

/** 一次工具循环的真实统计（trace/metrics 用；数字全部来自执行，不是估算）。 */
export interface TurnToolStats {
  /** 模型请求的工具调用次数（被重复抑制/超限拒绝的也算，防止换参数绕过预算）。 */
  toolCalls: number
  /** 真正执行了工具的调用次数（≤ toolCalls）。 */
  toolExecuted: number
  /** 工具循环轮数。 */
  toolRounds: number
  /** 命中重复抑制（同一工具同参）的次数。 */
  dedupedRepeats: number
  /** 是否因工具调用上限被强制收尾。 */
  toolBudgetExhausted: boolean
  /** 本轮的调用上限（回执里可对照）。 */
  toolCallLimit: number
}

export async function completeDshChat(input: {
  llm: LlmService
  provider: string
  model: string
  system: string
  messages: { role: 'user' | 'assistant' | 'system'; content: string | ModelContentPart[] }[]
  toolAllow?: string[]
  onTool?: (name: string, args: Record<string, unknown>) => Promise<string>
  /** 硬顶（默认 50，仅防死循环）；可用 DSH_IM_MAX_TOOL_ROUNDS 调。 */
  maxToolRounds?: number
  /** 单轮工具调用上限（默认 12，`DSH_IM_MAX_TOOL_CALLS` 可调）。 */
  maxToolCalls?: number
  /** 总时长预算（默认 240s，仅防挂死）；可用 DSH_IM_TURN_BUDGET_MS 调。 */
  timeBudgetMs?: number
  /** 注入时钟（默认 `Date.now`）。仅测试用来消除“预算按真实时间判定”的不确定性；生产不传。 */
  now?: () => number
  /** 每一步执行的回调（回执/成员行为时间线用；只传截断预览）。 */
  onStep?: (step: TurnStepTrace) => void
  /** 工具循环统计回调（host 写 trace/metrics：toolCalls / toolBudgetExhausted）。 */
  onTurnStats?: (stats: TurnToolStats) => void
  /** 调用用途：后台抽取/整理用最低推理档，避免 20s+ 的思维链开销。 */
  purpose?: 'reply' | 'extract' | 'curate'
  /** 流里观察到 usage 时回调（Phase 1b：写指标 + 校准 chars/token 系数）。 */
  onUsage?: (usage: TokenUsage) => void
}): Promise<string> {
  if (!input.llm.stream) throw new Error('DSH LLM 服务没有 stream')
  // 宿主 DSH 的原生循环没有轮次预算（要限流得自己挂 agent/turn-stopping）。
  // 这里是我们手写的简化工具循环，所以护栏改成三道，而不是一个很低的轮数上限：
  // 1) 总时长预算（默认 240s）：调研再深也不会把地板挂死；
  // 2) 重复调用熔断：同一工具 + 同一参数反复调用 3 次 → 强制只用已有信息作答；
  // 3) 硬顶 50 轮：只防“每次换参数无限循环”的死循环，正常调研远达不到。
  const envRounds = Number(process.env.DSH_IM_MAX_TOOL_ROUNDS)
  const ceiling = input.maxToolRounds
    ?? (Number.isFinite(envRounds) && envRounds > 0 ? Math.floor(envRounds) : 50)
  const envBudget = Number(process.env.DSH_IM_TURN_BUDGET_MS)
  const budgetMs = input.timeBudgetMs
    ?? (Number.isFinite(envBudget) && envBudget > 0 ? Math.floor(envBudget) : 240_000)
  const now = input.now ?? Date.now
  const startedAt = now()
  // 宿主 DSH 的 ToolSchema 形状就是 { name, description, parameters }。
  const tools = toolsForAllow(input.toolAllow)
  const history: unknown[] = []
  const dialogue = input.messages.filter((m) => m.role !== 'system' && contentText(m.content).trim())
  if (dialogue.length) {
    for (const turn of dialogue) {
      if (turn.role === 'user') history.push(userTurn(turn.content))
      else history.push(assistantTurn(input.provider, input.model, [{ type: 'text', text: contentText(turn.content) }]))
    }
  } else {
    history.push(userTurn('请发言。'))
  }

  const callCounts = new Map<string, number>()
  // 单轮工具调用预算：模型请求一次算一次（含被抑制的重复/超限拒绝），到上限强制作答。
  const toolBudget = createToolCallBudget(input.maxToolCalls ?? toolCallLimitFromEnv())
  const toolStats: TurnToolStats = {
    toolCalls: 0,
    toolExecuted: 0,
    toolRounds: 0,
    dedupedRepeats: 0,
    toolBudgetExhausted: false,
    toolCallLimit: toolBudget.limit,
  }
  // 后台抽取/整理：用模型 advertised 的最低推理档；reply 保持默认。
  const fastEffort = input.purpose === 'extract' || input.purpose === 'curate'
    ? await resolveFastReasoningEffort(input.llm, input.provider, input.model)
    : undefined
  let forceAnswer = false
  for (let round = 0; ; round++) {
    toolStats.toolRounds = round + 1
    const elapsed = now() - startedAt
    const lastChance = forceAnswer || round >= ceiling || elapsed >= budgetMs
    const remaining = Math.max(15_000, budgetMs - elapsed)
    const signal = AbortSignal.timeout(Math.min(120_000, remaining))
    const textParts: string[] = []
    const toolCalls: { id: string; name: string; arguments: string }[] = []
    let finishKind = 'stop'
    let failure = ''
    // DSH 的流可能同时有 text 与 reasoning 两类 block；reasoning（思维链）不能当回复落库。
    let currentBlockType = ''
    // 最后一次机会不再给工具，并把“直接用已有信息回答”写进系统提示：宁可给答案，不要弹中断卡。
    const system = lastChance
      ? `${input.system}\n\n[系统提示] 工具使用已到上限（轮次/时长/重复调用），请只根据目前已经看到的信息直接作答，不要再调用工具。`
      : input.system
    for await (const chunk of input.llm.stream!.call(input.llm, {
      provider: input.provider,
      model: input.model,
      system,
      messages: history,
      tools: lastChance ? undefined : (tools.length ? tools : undefined),
      ...(fastEffort ? { reasoningEffort: fastEffort } : {}),
      signal,
    })) {
      if (chunk.type === 'block-start') currentBlockType = chunk.blockType ?? ''
      if (chunk.type === 'text-delta' && chunk.text && currentBlockType !== 'reasoning') textParts.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text) {
        if (!textParts.length) textParts.push(chunk.block.text)
      }
      if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call' && chunk.block.name) {
        toolCalls.push({
          id: chunk.block.id || crypto.randomUUID(),
          name: chunk.block.name,
          arguments: chunk.block.arguments || '{}',
        })
      }
      // usage 可能出现在任意 chunk（实测：/llm-probe 扫全流才看到，finish 里不一定有）。
      const streamUsage = usageInChunk(chunk)
      if (streamUsage) input.onUsage?.(streamUsage)
      if (chunk.type === 'finish') {
        finishKind = chunk.reason?.kind || 'stop'
        if (finishKind === 'error' || finishKind === 'aborted') {
          failure = [chunk.reason?.failure?.code, chunk.reason?.failure?.message].filter(Boolean).join(': ') || finishKind
        }
      }
    }
    if (failure) throw new Error(failure)
    const text = textParts.join('').trim()
    if ((finishKind === 'tool-calls' || toolCalls.length) && input.onTool && !lastChance) {
      history.push(assistantTurn(
        input.provider,
        input.model,
        toolCalls.map((call) => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })),
      ))
      let repeated = false
      for (const call of toolCalls) {
        const startedAt = Date.now()
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
        } catch {
          args = {}
        }
        const stepBase = {
          step: 0,
          kind: 'tool' as const,
          name: call.name,
          args: previewForTrace(call.arguments),
          at: startedAt,
        }
        // ① 单轮硬上限：超限不再执行，喂回"直接作答"，并强制收尾。
        const grant = toolBudget.tryReserve()
        toolStats.toolCalls = toolBudget.used()
        if (!grant.ok) {
          toolStats.toolBudgetExhausted = true
          history.push(toolTurn(call.id, grant.message, true))
          input.onStep?.({ ...stepBase, result: previewForTrace(grant.message), ok: false, ms: Date.now() - startedAt })
          continue
        }
        // ② 重复调用熔断：同样的工具 + 同样的参数不会产生新信息，喂回去让模型收尾。
        const key = `${call.name}|${String(call.arguments ?? '{}').trim()}`
        const count = (callCounts.get(key) ?? 0) + 1
        callCounts.set(key, count)
        if (count >= 3) {
          const text = `同一工具（${call.name}）用相同参数已经重复调用 ${count} 次，结果不会再变化。请停止调用工具，直接用已有信息回答。`
          toolStats.dedupedRepeats += 1
          history.push(toolTurn(call.id, text, true))
          input.onStep?.({ ...stepBase, result: previewForTrace(text), ok: false, ms: Date.now() - startedAt })
          repeated = true
          continue
        }
        try {
          const result = await input.onTool(call.name, args)
          toolStats.toolExecuted += 1
          history.push(toolTurn(call.id, result))
          input.onStep?.({ ...stepBase, result: previewForTrace(result), ok: true, ms: Date.now() - startedAt })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          history.push(toolTurn(call.id, message, true))
          input.onStep?.({ ...stepBase, result: previewForTrace(message), ok: false, ms: Date.now() - startedAt })
        }
      }
      if (repeated) forceAnswer = true
      if (toolStats.toolBudgetExhausted) forceAnswer = true
      continue
    }
    if (!text) {
      throw new Error(lastChance
        ? '工具使用到上限后模型仍未给出文字回复'
        : '模型返回空内容')
    }
    input.onTurnStats?.({ ...toolStats })
    input.onStep?.({
      step: 0,
      kind: 'reply',
      result: previewForTrace(text),
      ok: true,
      at: Date.now(),
      ms: Date.now() - startedAt,
      toolCalls: toolStats.toolCalls,
      toolExecuted: toolStats.toolExecuted,
      toolBudgetExhausted: toolStats.toolBudgetExhausted,
    })
    return text
  }
}
