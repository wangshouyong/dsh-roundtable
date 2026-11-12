import {
  applyDecision,
  canSpeak,
  createRuntimeState,
  expireIfStale,
  finishSpeaking,
  resolveWait,
  type AgentRuntimeState,
} from './agent-state.ts'
import { decideNext } from './arbiter-bridge.ts'
import { generateAvatar } from './avatar.ts'
import { createId } from './ids.ts'
import { repairDerivedThreadTitles } from './persist.ts'
import { eligiblePersonaIds, parseMentions, shouldEnterReview } from './floor.ts'
import {
  appendThreadMemory,
  catalogFor,
  identityText,
  refreshThreadSummary,
  speechLeaksOtherThread,
  threadMemories,
  userGlobals,
  wakeKey,
  windowMessages,
} from './memory.ts'
import { resolveToolFilter } from './tools.ts'
import { DEFAULT_PROACTIVE_LIMITS, proactiveEligibility, type ProactiveLimits } from './proactive.ts'
import { defaultChair, MockSpeaker, type ConsensusCurator } from './runtime.ts'
import { buildConsensusState, isTransientClaim, type ConsensusDraft, type ConsensusFact } from './consensus.ts'
import { buildThreadDigest } from './summary.ts'
import { splitSummaryBudget, SUMMARY_DIRECTORY_SHARE } from './chapter-tree.ts'
import { groupBudgetForThread, type GroupBudgetPolicy } from './context-budget.ts'
import { appendMetric } from './metrics.ts'
import { buildRoleState } from './role-state.ts'
import {
  factsFromMessages,
  projectFactsFromList,
  type ExtractedFact,
  type FactExtractor,
} from './facts.ts'
import type {
  Activity,
  ChairSelector,
  Fact,
  FactKind,
  FloorDecision,
  ImState,
  MemoryEntry,
  Message,
  MessageAttachment,
  TurnStepTrace,
  MetricEntry,
  PendingFactOp,
  Persona,
  RetrievalMode,
  SpeakResult,
  Speaker,
  StalePolicy,
  Thread,
  ThreadKind,
} from './types.ts'
import { type FileSink, memorySink, summaryRelPath } from './workspace.ts'
import {
  canRestoreHistory,
  cloneJson,
  sanitizeThreadSnapshot,
  trashHistoryDetail,
  trashPersonaDetail,
  trashThreadDetail,
  type ClearHistoryPlan,
  type DeletePersonaPlan,
  type DeleteThreadPlan,
  type RestorePersonaResult,
  type TrashPayload,
  type TrashPersonaMembership,
} from './trash.ts'

const HOUR = 60 * 60 * 1000

export class ImService {
  readonly state: ImState
  constructor(
    private readonly speaker: Speaker = new MockSpeaker(),
    private readonly chair: ChairSelector = defaultChair(),
    initial?: Partial<ImState>,
    private readonly files: FileSink = memorySink(),
  ) {
    this.state = {
      personas: initial?.personas ?? [],
      threads: initial?.threads ?? [],
      memories: initial?.memories ?? [],
      wakeExcerpts: initial?.wakeExcerpts ?? {},
      pendingRecall: initial?.pendingRecall ?? null,
      lastProactiveAt: initial?.lastProactiveAt ?? {},
    }
  }

  /** 角色运行时状态：只在内存、带 TTL，不落盘（崩溃留下的 thinking 自动过期）。 */
  private readonly agentStates = new Map<string, AgentRuntimeState>()
  /** 正在生成共识的群：防止 UI 自动触发和轮末自动触发重复调用 curator。 */
  private readonly consensusInFlight = new Set<string>()
  /** 正在跑事实抽取的群：界面据此显示“抽取中”，而不是误以为任务板空白。 */
  private readonly extractionInFlight = new Set<string>()

  /** 异步事实抽取完成时通知界面（重新渲染 + 触发落盘）。 */
  onAsyncChange?: () => void

  /** 生成期间出现新消息时的处理策略：重算一次（默认）/ 标注旧版本 / 丢弃。 */
  stalePolicy: StalePolicy = 'regenerate'

  /** 按需检索档位：off / shadow（默认，只记录不进 prompt）/ on。 */
  retrievalMode: RetrievalMode = 'shadow'

  /** 引用句柄协议档位（Phase 1）：off / shadow（默认，只写回执）/ on（注入）。 */
  memoryContextMode: 'off' | 'shadow' | 'on' = 'shadow'

  /**
   * 群级预算输入（A-1/A-2：客户端注入，prompt 组装与 L1 摘要生成用同一份）。
   * 不注入时摘要预算回退到旧的静态口径（`DEFAULT_SUMMARY_TOTAL_CHARS`，digest 份额 = 旧 8000）。
   */
  groupBudgetPolicy?: GroupBudgetPolicy
  /** 章节目录占 summary 预算的比例（默认 40%）。 */
  summaryChapterShare: number = SUMMARY_DIRECTORY_SHARE

  /**
   * 共识状态开关（默认开）：每轮事实抽取之后自动跑 curator，生成 thread.consensusState。
   * 只有 `localStorage dsh-im:consensus='off'` 才关闭（回滚开关，不需要用户默认点）。
   */
  consensusEnabled = true

  /** 主动私聊的全局限制（档位数值在 proactive.ts 的预设里；这里可覆盖）。 */
  proactiveLimits: ProactiveLimits = { ...DEFAULT_PROACTIVE_LIMITS }

  snapshot(): ImState {
    return structuredClone(this.state)
  }

  /** 当前群的有效事实（用户在任务板归档的已排除，异步抽取的也合并进来）。 */
  factsFor(threadId: string): Fact[] {
    return this.localFacts(this.requireThread(threadId))
  }

  /** 任务板：把一条事实归档（写 retract，下一次保存落成事件）。 */
  completeFact(threadId: string, factId: string): void {
    const thread = this.requireThread(threadId)
    const fact = this.factsFor(threadId).find((item) => item.factId === factId)
    if (!fact) return
    thread.retractedFactIds = [...new Set([...(thread.retractedFactIds ?? []), factId])]
    this.queueFactOp(thread, {
      op: 'retract',
      factId,
      kind: fact.kind,
      text: fact.text,
      source: 'user',
      at: Date.now(),
    })
    this.pushMessage(thread, {
      kind: 'system',
      authorName: '系统主持',
      text: `已把「${fact.text}」归档，不再作为群事实。`,
    })
    this.refreshDigest(thread)
  }

  /** 客户端可见的事实投影：host 投影 + 覆盖点之后的新消息派生事实 + 本地异步抽取，再去掉本地归档的。 */
  private localFacts(thread: Thread): Fact[] {
    const retracted = new Set(thread.retractedFactIds ?? [])
    const covered = thread.factsUntilSeq ?? 0
    // host 投影已覆盖的消息不再本地重算：否则用户在任务板归档的决定会被消息规则重新拉起来。
    const freshDerived = factsFromMessages(thread.messages).active
      .filter((fact) => (fact.seq ?? 0) > covered)
    const merged = projectFactsFromList([
      ...freshDerived,
      ...(thread.facts ?? []),
      ...(thread.extractedFacts ?? []),
    ]).active
    return retracted.size ? merged.filter((fact) => !retracted.has(fact.factId)) : merged
  }

  private queueFactOp(thread: Thread, op: PendingFactOp): void {
    const list = thread.pendingFactOps ?? (thread.pendingFactOps = [])
    const key = `${op.op}|${op.factId}|${op.text}`
    if (list.some((item) => `${item.op}|${item.factId}|${item.text}` === key)) return
    list.push(op)
    if (list.length > 200) list.splice(0, list.length - 200)
  }

  private applyExtractedFacts(thread: Thread, extracted: ExtractedFact[]): void {
    if (extracted.length === 0 || !this.state.threads.includes(thread)) return
    const retracted = new Set(thread.retractedFactIds ?? [])
    const baseSeq = (thread.messages.at(-1)?.seq ?? thread.messages.length) + 1
    const facts: Fact[] = extracted
      .filter((item) => !retracted.has(item.fact.factId))
      .map((item, index) => ({
      factId: item.fact.factId,
      kind: item.fact.factKind as FactKind,
      text: item.text,
      ...(item.fact.owner === undefined ? {} : { owner: item.fact.owner }),
      source: 'extractor' as const,
      confidence: item.fact.confidence ?? 0.5,
      seq: baseSeq + index,
      at: item.at,
      ...(item.fact.sourceMessageId === undefined ? {} : { sourceMessageId: item.fact.sourceMessageId }),
      ...(item.fact.sourceMessageSeq === undefined ? {} : { sourceMessageSeq: item.fact.sourceMessageSeq }),
    }))
    thread.extractedFacts = projectFactsFromList([...(thread.extractedFacts ?? []), ...facts]).active
    for (const fact of facts) {
      this.queueFactOp(thread, {
        op: 'assert',
        factId: fact.factId,
        kind: fact.kind,
        text: fact.text,
        source: 'extractor',
        ...(fact.owner === undefined ? {} : { owner: fact.owner }),
        ...(fact.sourceMessageId === undefined ? {} : { sourceMessageId: fact.sourceMessageId }),
        ...(fact.sourceMessageSeq === undefined ? {} : { sourceMessageSeq: fact.sourceMessageSeq }),
        at: fact.at,
      })
    }
    this.refreshDigest(thread)
    this.onAsyncChange?.()
  }

  /**
   * 每轮结束后异步抽一次事实（有 LLM 通道才跑）：不阻塞回复，失败静默。
   * 短招呼（<6 字且非评审）不抽，避免每句都多一次调用。
   */
  private scheduleFactExtraction(thread: Thread): Promise<void> {
    const extractor = this.speaker as Speaker & Partial<FactExtractor>
    if (typeof extractor.extractFacts !== 'function') return Promise.resolve()
    const persona = thread.memberIds
      .map((id) => this.state.personas.find((item) => item.id === id))
      .find((item): item is Persona => Boolean(item?.model))
    if (!persona) return Promise.resolve()
    const recent = thread.messages.filter((message) => message.kind !== 'system')
    if (recent.length < 2) return Promise.resolve()
    const lastUser = [...recent].reverse().find((message) => message.kind === 'user')
    if (!lastUser) return Promise.resolve()
    if (lastUser.text.trim().length < 6 && thread.roundMode !== 'review') return Promise.resolve()
    const startedAt = Date.now()
    this.extractionInFlight.add(thread.id)
    return Promise.resolve()
      .then(() => extractor.extractFacts!({ thread, messages: recent.slice(-12), persona }))
      .then((facts) => {
        this.recordMetric(thread, {
          at: Date.now(),
          kind: 'extraction',
          value: Date.now() - startedAt,
          fields: { ok: true, facts: facts.length },
        })
        this.applyExtractedFacts(thread, facts)
      })
      .catch((err) => {
        this.recordMetric(thread, {
          at: Date.now(),
          kind: 'extraction',
          value: Date.now() - startedAt,
          fields: { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 120) },
        })
      })
      .finally(() => {
        this.extractionInFlight.delete(thread.id)
        this.onAsyncChange?.()
      })
  }

  /** 事实抽取是否在跑（任务板显示“抽取中”）。 */
  extractionPending(threadId: string): boolean {
    return this.extractionInFlight.has(threadId)
  }

  /** 共识整理是否在跑（任务板显示“整理中”）。 */
  consensusPending(threadId: string): boolean {
    return this.consensusInFlight.has(threadId)
  }

  /**
   * 每轮事实抽取之后跑一次 curator → consensus builder，产出 thread.consensusState。
   * `force=true` 供任务板“生成本轮共识”按钮使用（开关关闭时不自动跑，显式点击才跑）。
   *
   * 能力/环境自述由本层先按确定性规则摘出来，直接进 D 栏归档，不交给模型判断：
   * 这样即使 curator 犯错，也不会把“我没有 shell”写进 A/B/C 变成长期约束。
   */
  private scheduleConsensus(thread: Thread, force = false): void {
    if (!this.consensusEnabled && !force) return
    if (this.consensusInFlight.has(thread.id)) return
    const curator = this.speaker as Speaker & Partial<ConsensusCurator>
    const facts: ConsensusFact[] = this.factsFor(thread.id).map((fact) => ({
      factId: fact.factId,
      eventSeq: fact.seq,
      kind: fact.kind,
      owner: fact.owner ?? '',
      text: fact.text,
      ...(fact.sourceMessageId === undefined ? {} : { sourceMessageId: fact.sourceMessageId }),
      ...(fact.sourceMessageSeq === undefined ? {} : { sourceMessageSeq: fact.sourceMessageSeq }),
    }))
    if (facts.length === 0) return
    this.consensusInFlight.add(thread.id)
    const mode = facts.some((fact) => !fact.sourceMessageId) ? 'legacy' : 'new'
    const isUserOwned = (owner: string): boolean => owner === '用户' || owner === '你'
    const transient = facts.filter((fact) => !isUserOwned(fact.owner) && isTransientClaim(fact.text))
    const transientIds = new Set(transient.map((fact) => fact.factId))
    const curatable = facts.filter((fact) => !transientIds.has(fact.factId))
    const persona = thread.memberIds
      .map((id) => this.state.personas.find((item) => item.id === id))
      .find((item): item is Persona => Boolean(item?.model))
    const startedAt = Date.now()

    const finalize = (base: ConsensusDraft): void => {
      try {
      const covered = new Set(base.clusters.flatMap((cluster) => cluster.factIds))
      const usedKeys = new Set([
        ...base.clusters.map((cluster) => cluster.key),
        ...(base.derived ?? []).map((cluster) => cluster.key),
      ])
      const autoClusters = transient
        .filter((fact) => !covered.has(fact.factId))
        .map((fact, index) => {
          let key = `auto-D${index + 1}`
          while (usedKeys.has(key)) key += '_'
          usedKeys.add(key)
          return {
            key,
            lane: 'D' as const,
            kind: '能力自述',
            status: 'archived' as const,
            factIds: [fact.factId],
            text: fact.text,
          }
        })
      const draft: ConsensusDraft = {
        clusters: [...base.clusters, ...autoClusters],
        ...(base.derived ? { derived: base.derived } : {}),
      }
      const built = buildConsensusState(facts, draft, {
        mode,
        knownMessageIds: thread.messages.map((message) => message.id),
      })
      if (!built.ok || !built.state) {
        throw new Error('consensus 契约不通过：' + built.errors.slice(0, 3).join('；'))
      }
      if (!this.state.threads.includes(thread)) return
      thread.consensusState = built.state
      thread.consensusError = undefined
      this.recordMetric(thread, {
        at: Date.now(),
        kind: 'consensus',
        value: Date.now() - startedAt,
        fields: {
          ok: true,
          mode,
          facts: built.state.metrics.facts,
          clusters: built.state.metrics.clusters,
          archived: built.state.metrics.archivedFacts,
          autoArchived: autoClusters.length,
          version: built.state.version,
        },
      })
      this.onAsyncChange?.()
      } finally {
        this.consensusInFlight.delete(thread.id)
      }
    }

    if (curatable.length === 0) {
      try {
        finalize({ clusters: [], derived: [] })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        thread.consensusError = message
        this.recordMetric(thread, {
          at: Date.now(),
          kind: 'consensus',
          value: Date.now() - startedAt,
          fields: { ok: false, mode, error: message.slice(0, 160) },
        })
        this.consensusInFlight.delete(thread.id)
      }
      return
    }
    if (!persona || typeof curator.curate !== 'function') {
      this.consensusInFlight.delete(thread.id)
      return
    }
    void Promise.resolve()
      .then(() => curator.curate!({
        threadId: thread.id,
        threadTitle: thread.title,
        projectRoot: thread.projectRoot,
        facts: curatable,
        persona,
      }))
      .then(finalize)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        thread.consensusError = message
        this.recordMetric(thread, {
          at: Date.now(),
          kind: 'consensus',
          value: Date.now() - startedAt,
          fields: { ok: false, mode, error: message.slice(0, 160) },
        })
        this.consensusInFlight.delete(thread.id)
      })
  }

  /**
   * 界面自动触发：当前群有事实、但没有共识状态（或共识落后于最新消息）时生成一次。
   * 不需要用户点任何按钮；同一群并发去重，失败只留下 consensusError 供界面提示。
   */
  ensureConsensus(threadId: string): void {
    if (!this.consensusEnabled) return
    let thread: Thread
    try {
      thread = this.requireThread(threadId)
    } catch {
      return
    }
    if (this.consensusInFlight.has(threadId)) return
    const facts = this.factsFor(threadId)
    if (facts.length === 0) return
    const state = thread.consensusState
    if (state) {
      // 用“事实序号”判断是否落后，而不是最后一条消息序号：
      // 回复消息不进 facts，用消息序号必判落后 → 每次 state 更新都重复 curate。
      const maxFactSeq = facts.reduce((max, fact) => Math.max(max, fact.seq), 0)
      const maxRefFactSeq = Math.max(
        0,
        ...state.clusters.flatMap((cluster) => cluster.refs.map((ref) => ref.factEventSeq)),
        ...state.derived.flatMap((cluster) => cluster.refs.map((ref) => ref.factEventSeq)),
      )
      if (maxRefFactSeq >= maxFactSeq) return
    }
    this.scheduleConsensus(thread, true)
  }

  /** 任务板按钮：手动生成/刷新本轮共识（显式动作，不受自动开关限制）。 */
  refreshConsensus(threadId: string): void {
    this.scheduleConsensus(this.requireThread(threadId), true)
  }

  /** 只读一份运行时状态（界面/调试用；不参与落盘）。 */
  runtimeStates(): AgentRuntimeState[] {
    return [...this.agentStates.values()].map((state) => ({ ...state }))
  }

  runtimeState(personaId: string): AgentRuntimeState | undefined {
    const state = this.agentStates.get(personaId)
    return state ? { ...state } : undefined
  }

  private stateOf(personaId: string, now: number): AgentRuntimeState {
    const current = this.agentStates.get(personaId) ?? createRuntimeState(personaId, now)
    const fresh = expireIfStale(current, now)
    if (fresh !== current || !this.agentStates.has(personaId)) this.agentStates.set(personaId, fresh)
    return fresh
  }

  private setAgentState(personaId: string, next: AgentRuntimeState): void {
    this.agentStates.set(personaId, next)
  }

  private setAgentIdle(personaId: string, now: number): void {
    const current = this.stateOf(personaId, now)
    this.setAgentState(personaId, { ...current, status: 'idle', since: now, waitingOn: undefined })
  }

  /** 发言完成：本人回 idle 并记冷却；正在等他的角色解除等待。 */
  private settleSpeak(personaId: string, now: number): void {
    this.setAgentState(personaId, finishSpeaking(this.stateOf(personaId, now), now))
    for (const [id, state] of this.agentStates) {
      if (id === personaId) continue
      const next = resolveWait(state, personaId, now)
      if (next !== state) this.setAgentState(id, next)
    }
  }

  private recordFloorDecision(
    thread: Thread,
    personaId: string,
    action: FloorDecision['action'],
    reason: string,
    at = Date.now(),
  ): void {
    const list = thread.floorDecisions ?? (thread.floorDecisions = [])
    list.push({ personaId, action, reason, at })
    if (list.length > 50) list.splice(0, list.length - 50)
  }

  /** 每轮结束刷新分层摘要投影：L1 旧消息压缩 + L2 事实/决策/待办，并推进窗口边界。 */
  private refreshDigest(thread: Thread): void {
    const before = thread.summaryState?.version
    // A-2：摘要块预算贯通——L1 生成器与冷区章节目录共用群级 summary 预算（目录:摘要=40:60）。
    // 没有注入预算输入时用静态回退：总 13333 → digest 8000（= 旧 L1_CHAR_BUDGET），行为不变。
    const groupBudget = this.groupBudgetPolicy ? groupBudgetForThread(thread, this.groupBudgetPolicy) : undefined
    const summaryTotal = groupBudget?.summaryChars ?? Math.round(8000 / (1 - this.summaryChapterShare))
    const split = splitSummaryBudget(summaryTotal, { chapterShare: this.summaryChapterShare })
    const digest = buildThreadDigest(thread, thread.summaryState, {
      facts: this.localFacts(thread),
      charBudget: split.digestChars,
    })
    thread.summaryState = digest
    thread.summaryUntilSeq = digest.untilSeq
    if (digest.version !== before) {
      this.recordMetric(thread, {
        at: Date.now(),
        kind: 'summary',
        value: digest.untilSeq,
        fields: { l1Chars: digest.l1.length, l2Count: digest.l2.length, factsVersion: digest.factsVersion },
      })
    }
  }

  private nameOf(personaId: string): string {
    return this.state.personas.find((persona) => persona.id === personaId)?.name ?? personaId
  }

  /** 当前最后一条消息 seq（没有 seq 的老消息按 0 算）。 */
  private lastMessageSeq(thread: Thread): number {
    return thread.messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0)
  }

  private recordMetric(thread: Thread, entry: MetricEntry): void {
    thread.pendingMetrics = appendMetric(thread.pendingMetrics, entry)
  }

  /** 每轮结束记一次地板指标（speak/wait/pass 计数）。 */
  private recordFloorMetric(thread: Thread): void {
    const decisions = thread.floorDecisions ?? []
    const counts = { speak: 0, wait: 0, pass: 0 }
    for (const decision of decisions) counts[decision.action] += 1
    this.recordMetric(thread, {
      at: Date.now(),
      kind: 'floor_round',
      value: decisions.length,
      fields: { ...counts },
    })
  }

  createPersona(input: Omit<Persona, 'id' | 'origin' | 'model'> & { id?: string; origin?: Persona['origin']; model: string }): Persona {
    const name = input.name.trim()
    const model = input.model.trim()
    if (!name) throw new Error('角色名不能为空')
    if (!model) throw new Error('角色必须绑定模型')
    const tools = resolveToolFilter({ toolAllow: input.toolAllow, toolDeny: input.toolDeny })
    const persona: Persona = {
      id: input.id ?? createId('p'),
      name,
      post: input.post?.trim() || undefined,
      avatar: input.avatar || name.slice(0, 1),
      avatarUrl: input.avatarUrl || generateAvatar(name),
      personality: input.personality,
      duties: input.duties,
      origin: input.origin ?? 'mine',
      provider: input.provider,
      model,
      toolAllow: tools.toolAllow,
      toolDeny: tools.toolDeny,
      proactiveDm: input.proactiveDm ?? false,
      proactiveLevel: input.proactiveLevel ?? 'standard',
      defaultActivity: input.defaultActivity ?? 'review',
    }
    this.state.personas.push(persona)
    return persona
  }

  updatePersona(id: string, patch: Partial<Persona>): Persona {
    const p = this.requirePersona(id)
    if (patch.model !== undefined && !patch.model.trim()) throw new Error('角色必须绑定模型')
    const previousName = p.name
    const next: Partial<Persona> = { ...patch }
    if (patch.toolAllow || patch.toolDeny) {
      Object.assign(next, resolveToolFilter({
        toolAllow: patch.toolAllow ?? (patch.toolDeny ? undefined : p.toolAllow),
        toolDeny: patch.toolDeny,
      }))
    }
    Object.assign(p, next, { id: p.id })
    if (patch.name !== undefined && p.name !== previousName) {
      // DM 标题、以及没被用户改过名的三人小窗标题，都从角色名派生：改名后整体重建一遍。
      repairDerivedThreadTitles(this.state)
    }
    return p
  }

  listPersonas(): Persona[] {
    return this.state.personas
  }

  /** 用户明确说“私聊/小窗”且只点了一个人时，返回该角色。 */
  private privateChatTarget(thread: Thread, text: string, mentioned: readonly string[]): Persona | undefined {
    if (thread.kind === 'dm') return undefined
    if (!/私聊|私信|单独聊|单独说|小窗|私下|密聊|悄悄话/.test(text)) return undefined
    const ids = mentioned.length
      ? [...new Set(mentioned)]
      : this.personasIn(thread).filter((persona) => text.includes(persona.name)).map((persona) => persona.id)
    const inThread = ids.filter((id) => thread.memberIds.includes(id))
    return inThread.length === 1 ? this.requirePersona(inThread[0]) : undefined
  }

  /** 改群的“关联项目”目录（角色读/搜/run_check 的根目录）。 */
  setThreadProjectRoot(threadId: string, projectRoot: string): Thread {
    const thread = this.requireThread(threadId)
    const next = projectRoot.trim()
    if (!next) throw new Error('关联项目不能为空')
    if (next === thread.projectRoot) return thread
    thread.projectRoot = next
    this.pushMessage(thread, {
      kind: 'system',
      authorName: '系统主持',
      text: `关联项目已改为：${next}`,
    })
    return thread
  }

  openDm(personaId: string, projectRoot: string): Thread {
    const existing = this.state.threads.find(
      (t) => t.kind === 'dm' && t.memberIds.length === 1 && t.memberIds[0] === personaId,
    )
    if (existing) return existing
    const p = this.requirePersona(personaId)
    return this.createThread({
      kind: 'dm',
      title: p.name,
      memberIds: [personaId],
      projectRoot,
    })
  }

  createTriad(personaIds: [string, string], projectRoot: string): Thread {
    const [a, b] = personaIds.map((id) => this.requirePersona(id))
    return this.createThread({
      kind: 'triad',
      title: `${a.name}、${b.name}`,
      memberIds: [a.id, b.id],
      projectRoot,
    })
  }

  /** 建群：群名由用户填，留空退回「新群」（UI 的占位也是这个，保证标题永不为空）。 */
  createGroup(title: string, memberIds: string[], projectRoot: string): Thread {
    const name = title.trim() || '新群'
    return this.createThread({ kind: 'group', title: name, memberIds, projectRoot })
  }

  /**
   * 改会话名：群（名字本来就是用户起的）与三人小窗（默认标题由角色名派生，改名后置
   * `titleCustom` 锁定，之后角色改名不再覆盖）。DM 标题永远从角色名派生，不允许手改。
   */
  setThreadTitle(threadId: string, title: string): Thread {
    const thread = this.requireThread(threadId)
    if (thread.kind === 'dm') throw new Error('私聊标题跟着角色名走，不能改名（要改就改角色名）')
    const name = title.trim()
    if (!name) throw new Error('名称不能为空')
    if (name === thread.title) return thread
    thread.title = name
    if (thread.kind === 'triad') thread.titleCustom = true
    return thread
  }

  setActivity(threadId: string, personaId: string, activity: Activity): void {
    const m = this.requireThread(threadId).members.find((x) => x.personaId === personaId)
    if (m) m.activity = activity
  }

  // ── 软删除 / 清空 / 恢复（回收站） ─────────────────────────────────────
  //
  // 这一层只改**内存状态**并返回快照计划；物理目录搬运由 host 的回收站负责
  // （`src/host/trash-store.ts` + `/api/im/trash/*`）。调用方（面板）顺序：
  //   1) 调这里的删除方法拿到计划；2) 立即落盘 state；3) 再调 host 把它移入回收站。
  // 任何一步失败都要用对应 restore* 方法回滚内存状态，不能半删。

  /** 删除会话 / 解散群：会话从 state 移除，返回回收站快照。 */
  deleteThread(threadId: string): DeleteThreadPlan {
    const thread = this.requireThread(threadId)
    const snapshot = sanitizeThreadSnapshot(thread)
    this.state.threads = this.state.threads.filter((item) => item.id !== threadId)
    this.dropThreadReferences(threadId)
    return {
      threadId,
      label: thread.title,
      detail: trashThreadDetail(thread),
      snapshot,
    }
  }

  /**
   * 清空聊天记录：会话外壳（标题/成员/关联工作区/自定义小窗名）保留，
   * 消息、事实、共识、摘要、执行轨迹、附件、线程记忆全部清掉；旧数据由 host 移入回收站。
   */
  clearThreadHistory(threadId: string): ClearHistoryPlan {
    const thread = this.requireThread(threadId)
    const snapshot = sanitizeThreadSnapshot(thread)
    const memories = this.state.memories
      .filter((memory) => memory.scope === 'thread' && memory.threadId === threadId)
      .map((memory) => cloneJson(memory))
    const wakeExcerpts: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(this.state.wakeExcerpts)) {
      if (key.endsWith(`:${threadId}`)) wakeExcerpts[key] = [...value]
    }
    thread.messages = []
    thread.topic = thread.title
    thread.shortSummary = ''
    thread.summaryState = undefined
    thread.summaryUntilSeq = 0
    thread.facts = []
    thread.factsVersion = undefined
    thread.factsUntilSeq = 0
    thread.consensusState = undefined
    thread.consensusError = undefined
    thread.traces = []
    thread.floorDecisions = []
    thread.blocked = undefined
    thread.speakingPersonaId = undefined
    thread.nextHint = undefined
    thread.roundMode = 'idle'
    thread.unread = 0
    thread.updatedAt = Date.now()
    this.dropThreadReferences(threadId)
    return {
      threadId,
      label: thread.title,
      detail: trashHistoryDetail(snapshot),
      snapshot,
      memories,
      wakeExcerpts,
    }
  }

  /**
   * 删除角色（彻底连带口径）：
   * - 角色从通讯录移除；
   * - 它的私聊（dm）与三人小窗（triad）整个会话一起进回收站；
   * - 群里只移除成员：群历史保留，写一条系统记录说明谁被移出；
   * - 线程记忆 / 唤醒摘要 / pendingRecall / 运行时状态 / 主动私聊节流一起清理。
   */
  deletePersona(personaId: string): DeletePersonaPlan {
    const persona = this.requirePersona(personaId)
    const deletedIds = new Set(
      this.state.threads
        .filter((thread) => thread.kind !== 'group' && thread.memberIds.includes(personaId))
        .map((thread) => thread.id),
    )
    const threads = this.state.threads
      .filter((thread) => deletedIds.has(thread.id))
      .map((thread) => sanitizeThreadSnapshot(thread))
    const memberships: TrashPersonaMembership[] = []
    for (const thread of this.state.threads) {
      if (thread.kind !== 'group' || !thread.memberIds.includes(personaId)) continue
      memberships.push({
        threadId: thread.id,
        index: thread.memberIds.indexOf(personaId),
        activity: this.memberOf(thread, personaId)?.activity ?? persona.defaultActivity,
      })
    }
    const memories = this.state.memories
      .filter((memory) => memory.scope === 'thread' && memory.threadId !== undefined && deletedIds.has(memory.threadId))
      .map((memory) => cloneJson(memory))
    const wakeExcerpts: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(this.state.wakeExcerpts)) {
      if (key.startsWith(`${personaId}:`) || [...deletedIds].some((id) => key.endsWith(`:${id}`))) {
        wakeExcerpts[key] = [...value]
      }
    }

    this.state.personas = this.state.personas.filter((item) => item.id !== personaId)
    this.state.threads = this.state.threads.filter((thread) => !deletedIds.has(thread.id))
    for (const id of deletedIds) this.dropThreadReferences(id)

    // 群：只移除成员，并留一条历史记录（不然群里会"凭空少一个人"）。
    const now = Date.now()
    for (const thread of this.state.threads) {
      if (thread.kind !== 'group') continue
      const index = thread.memberIds.indexOf(personaId)
      if (index < 0) continue
      thread.memberIds.splice(index, 1)
      thread.members = thread.members.filter((member) => member.personaId !== personaId)
      if (thread.speakingPersonaId === personaId) thread.speakingPersonaId = undefined
      if (thread.blocked?.personaId === personaId) thread.blocked = undefined
      this.pushMessage(thread, {
        kind: 'system',
        authorName: '系统主持',
        text: `角色「${persona.name}」已被删除，已移出本群。`,
      }, now)
    }

    // 角色级运行时状态 / 主动私聊节流 / 唤醒摘要。
    this.agentStates.delete(personaId)
    delete this.state.lastProactiveAt[personaId]
    for (const key of Object.keys(this.state.wakeExcerpts)) {
      if (key.startsWith(`${personaId}:`)) delete this.state.wakeExcerpts[key]
    }
    const recall = this.state.pendingRecall
    if (recall && (
      recall.personaId === personaId
      || deletedIds.has(recall.threadId)
      || deletedIds.has(recall.targetThreadId)
    )) {
      this.state.pendingRecall = null
    }

    return {
      persona: cloneJson(persona),
      label: persona.name,
      detail: trashPersonaDetail(persona, threads, memberships),
      threads,
      memberships,
      memories,
      wakeExcerpts,
    }
  }

  /**
   * 恢复会话（回收站 → 列表）。
   * - 同 id 会话已在列表：拒绝（说明已经恢复过）；
   * - DM / 三人小窗里的角色已被删掉：拒绝并提示先恢复角色（否则恢复出一个没有成员的空壳）；
   * - 群里有成员已不存在：保留会话、移除失效成员并写系统记录（不静默丢成员关系）。
   */
  restoreThread(snapshot: Thread): Thread {
    if (this.state.threads.some((thread) => thread.id === snapshot.id)) {
      throw new Error('回收站里的这个会话已经恢复过了')
    }
    const thread = cloneJson(snapshot)
    const missing = thread.memberIds.filter((id) => !this.state.personas.some((persona) => persona.id === id))
    if (missing.length && thread.kind !== 'group') {
      throw new Error('会话里的角色已被删除，恢复不了；请先到回收站恢复角色，再恢复这个会话')
    }
    thread.memberIds = thread.memberIds.filter((id) => !missing.includes(id))
    thread.members = thread.members.filter((member) => !missing.includes(member.personaId))
    thread.speakingPersonaId = undefined
    thread.blocked = undefined
    thread.floorDecisions = []
    thread.unread = 0
    thread.roundMode = 'idle'
    thread.updatedAt = Date.now()
    if (missing.length) {
      this.pushMessage(thread, {
        kind: 'system',
        authorName: '系统主持',
        text: '恢复会话时移除了已不存在的角色。',
      })
    }
    this.state.threads.push(thread)
    return thread
  }

  /**
   * 恢复「清空聊天记录」：把快照里的消息/事实/共识/摘要/轨迹写回**同一个会话**。
   * 只有当前会话一条消息都没有时才允许（否则恢复会盖掉清空后新聊的内容）。
   */
  restoreThreadHistory(
    snapshot: Thread,
    extras?: Pick<TrashPayload, 'memories' | 'wakeExcerpts'>,
  ): Thread {
    const thread = this.requireThread(snapshot.id)
    if (!canRestoreHistory(thread)) {
      throw new Error('这个会话清空后又有新消息，不能直接恢复；可先删除会话再恢复，或放弃这条回收站记录')
    }
    const restored = cloneJson(snapshot)
    thread.messages = restored.messages
    thread.topic = restored.topic
    thread.shortSummary = restored.shortSummary
    thread.summaryState = restored.summaryState
    thread.summaryUntilSeq = restored.summaryUntilSeq
    thread.facts = restored.facts
    thread.factsVersion = restored.factsVersion
    thread.factsUntilSeq = restored.factsUntilSeq
    thread.consensusState = restored.consensusState
    thread.consensusError = undefined
    thread.traces = restored.traces
    thread.blocked = undefined
    thread.speakingPersonaId = undefined
    thread.nextHint = undefined
    thread.floorDecisions = []
    thread.roundMode = 'idle'
    thread.unread = 0
    thread.updatedAt = Date.now()
    for (const memory of extras?.memories ?? []) {
      if (!this.state.memories.some((item) => item.id === memory.id)) this.state.memories.push(cloneJson(memory))
    }
    for (const [key, value] of Object.entries(extras?.wakeExcerpts ?? {})) {
      if (!this.state.wakeExcerpts[key]) this.state.wakeExcerpts[key] = [...value]
    }
    return thread
  }

  /**
   * 恢复角色：角色 + 被连带删除的会话 + 群成员位置 + 记忆/唤醒摘要一起还原。
   * 如果某个会话/群在角色删除后又被删掉，跳过并如实回报（不假装全部恢复）。
   */
  restorePersona(payload: Pick<TrashPayload, 'persona' | 'threads' | 'memberships' | 'memories' | 'wakeExcerpts'>): RestorePersonaResult {
    const source = payload.persona
    if (!source) throw new Error('回收站记录里没有角色数据，不能恢复')
    if (this.state.personas.some((persona) => persona.id === source.id)) {
      throw new Error('这个角色已经恢复过了')
    }
    const persona = cloneJson(source)
    this.state.personas.push(persona)

    const restoredThreads: Thread[] = []
    const skippedThreadIds: string[] = []
    for (const snapshot of payload.threads ?? []) {
      if (this.state.threads.some((thread) => thread.id === snapshot.id)) {
        skippedThreadIds.push(snapshot.id)
        continue
      }
      const others = snapshot.memberIds.filter((id) => id !== persona.id)
      if (others.some((id) => !this.state.personas.some((item) => item.id === id))) {
        skippedThreadIds.push(snapshot.id)
        continue
      }
      const thread = cloneJson(snapshot)
      thread.speakingPersonaId = undefined
      thread.blocked = undefined
      thread.floorDecisions = []
      thread.roundMode = 'idle'
      thread.unread = 0
      thread.updatedAt = Date.now()
      this.state.threads.push(thread)
      restoredThreads.push(thread)
    }

    const skippedMembershipThreadIds: string[] = []
    for (const membership of payload.memberships ?? []) {
      const thread = this.state.threads.find((item) => item.id === membership.threadId)
      if (!thread || thread.kind !== 'group') {
        skippedMembershipThreadIds.push(membership.threadId)
        continue
      }
      if (thread.memberIds.includes(persona.id)) continue
      const index = Math.max(0, Math.min(membership.index, thread.memberIds.length))
      thread.memberIds.splice(index, 0, persona.id)
      thread.members.splice(index, 0, {
        personaId: persona.id,
        activity: membership.activity ?? persona.defaultActivity,
        completedRound: false,
        passedRound: false,
      })
      this.pushMessage(thread, {
        kind: 'system',
        authorName: '系统主持',
        text: `角色「${persona.name}」已从回收站恢复，重新加入本群。`,
      })
    }

    for (const memory of payload.memories ?? []) {
      if (!this.state.memories.some((item) => item.id === memory.id)) this.state.memories.push(cloneJson(memory))
    }
    for (const [key, value] of Object.entries(payload.wakeExcerpts ?? {})) {
      if (!this.state.wakeExcerpts[key]) this.state.wakeExcerpts[key] = [...value]
    }
    repairDerivedThreadTitles(this.state)
    return { persona, threads: restoredThreads, skippedThreadIds, skippedMembershipThreadIds }
  }

  /** 删掉一个会话后，把只属于它的引用（线程记忆 / 唤醒摘要 / 跨场召回）清干净。 */
  private dropThreadReferences(threadId: string): void {
    this.state.memories = this.state.memories.filter(
      (memory) => !(memory.scope === 'thread' && memory.threadId === threadId),
    )
    for (const key of Object.keys(this.state.wakeExcerpts)) {
      if (key.endsWith(`:${threadId}`)) delete this.state.wakeExcerpts[key]
    }
    const recall = this.state.pendingRecall
    if (recall && (recall.threadId === threadId || recall.targetThreadId === threadId)) {
      this.state.pendingRecall = null
    }
  }

  /** 客户端 UI：自动打开私聊时切到那个小窗。 */
  onDmOpened?: (threadId: string) => void

  async sendUser(
    threadId: string,
    text: string,
    opts?: { startReview?: boolean; excludePersonaIds?: string[]; attachments?: MessageAttachment[] },
  ): Promise<Thread> {
    const thread = this.requireThread(threadId)
    this.abortSpeaking(thread, '已被打断')
    this.resetRound(thread)
    thread.speakingPersonaId = undefined
    thread.nextHint = undefined
    const msg = this.pushMessage(thread, {
      kind: 'user',
      authorName: '你',
      text,
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
    })
    const mentioned = parseMentions(text, this.personasIn(thread))
    // 用户明确要求“私聊/小窗”时，不再在群里排队发言，直接开小窗并让被点的人在小窗里回复。
    const dmTarget = this.privateChatTarget(thread, text, mentioned)
    if (dmTarget) {
      thread.unread = 0
      this.pushMessage(thread, {
        kind: 'system',
        authorName: '系统主持',
        text: `已为你打开和「${dmTarget.name}」的私聊，接下来的话在小窗里说。`,
      })
      this.refreshDigest(thread)
      this.recordFloorMetric(thread)
      refreshThreadSummary(thread)
      const dm = this.openDm(dmTarget.id, thread.projectRoot)
      const replied = await this.sendUser(dm.id, text, opts?.attachments?.length ? { attachments: opts.attachments } : undefined)
      dm.unread = 0
      this.onDmOpened?.(dm.id)
      return replied
    }
    if (shouldEnterReview(text, Boolean(opts?.startReview))) {
      thread.roundMode = 'review'
      this.resetRound(thread)
      this.pushMessage(thread, {
        kind: 'system',
        authorName: '系统主持',
        text: '本轮开始。',
      })
    }
    // 开始前体检/token 失败时点“本轮移除”的成员：这一轮不参与（只影响本轮）。
    for (const personaId of opts?.excludePersonaIds ?? []) {
      const member = this.memberOf(thread, personaId)
      if (member) {
        member.completedRound = true
        member.passedRound = false
      }
    }
    thread.unread = 0
    await this.advanceFloor(thread, mentioned, msg.id)
    this.refreshDigest(thread)
    this.recordFloorMetric(thread)
    refreshThreadSummary(thread)
    const extraction = this.scheduleFactExtraction(thread)
    if (this.consensusEnabled) void extraction.then(() => this.scheduleConsensus(thread))
    return thread
  }

  async confirmRecall(allow: boolean): Promise<Thread | null> {
    const pending = this.state.pendingRecall
    if (!pending) return null
    this.state.pendingRecall = null
    const thread = this.requireThread(pending.threadId)
    if (!allow) {
      this.pushMessage(thread, {
        kind: 'system',
        authorName: '系统主持',
        text: '已拒绝跨场召回，不拉另一场正文。',
      })
      return thread
    }
    const target = this.requireThread(pending.targetThreadId)
    this.pushMessage(thread, {
      kind: 'system',
      authorName: '系统主持',
      text: `来自「${target.title}」，先当参考：${target.shortSummary || target.topic}`,
    })
    return thread
  }

  pauseRound(threadId: string): void {
    const thread = this.requireThread(threadId)
    thread.roundMode = 'idle'
    thread.speakingPersonaId = undefined
    thread.nextHint = undefined
    this.pushMessage(thread, {
      kind: 'system',
      authorName: '系统主持',
      text: '已全员暂停。',
    })
  }

  async requestSummary(threadId: string): Promise<string> {
    const thread = this.requireThread(threadId)
    const body = this.buildSummary(thread)
    const dest = await this.files.writeThreadFile(thread.projectRoot, thread.id, summaryRelPath(), body)
    this.pushMessage(thread, {
      kind: 'system',
      authorName: '系统主持',
      text: `详细去重汇总已写入 ${dest}。回到干活台让主 Agent 读这个文件即可。另一场文档请自行粘贴。`,
    })
    this.state.memories.push(appendThreadMemory(this.state.memories, thread.id, `汇总：${body.slice(0, 200)}`))
    thread.roundMode = 'idle'
    return dest
  }

  private createThread(input: {
    kind: ThreadKind
    title: string
    memberIds: string[]
    projectRoot: string
  }): Thread {
    const projectRoot = input.projectRoot.trim()
    if (!projectRoot) throw new Error('关联项目不能为空')
    for (const id of input.memberIds) this.requirePersona(id)
    const now = Date.now()
    const thread: Thread = {
      id: createId('t'),
      kind: input.kind,
      title: input.title,
      topic: input.title,
      shortSummary: '',
      memberIds: input.memberIds,
      members: input.memberIds.map((personaId) => ({
        personaId,
        activity: this.requirePersona(personaId).defaultActivity,
        completedRound: false,
        passedRound: false,
      })),
      projectRoot,
      messages: [],
      unread: 0,
      roundMode: 'idle',
      createdAt: now,
      updatedAt: now,
    }
    this.state.threads.push(thread)
    return thread
  }

  /**
   * 发言权仲裁地板：
   * 资格门（谁能进候选，含点名独占）→ 仲裁器决定 speak/wait/pass → 执行。
   * 决策写进 `thread.floorDecisions`（随 state.json 落盘，事件类型下一步补）。
   */
  private async advanceFloor(thread: Thread, mentionedIds: string[], wakeMessageId?: string): Promise<void> {
    const max = 8
    // 用户点名时只让被点名的人发言；没点名才走资格门。
    const pinMentions = mentionedIds.length > 0
    const spokenIds: string[] = []
    let spoken = 0
    while (spoken < max) {
      const now = Date.now()
      const ids = pinMentions
        ? thread.members.map((m) => m.personaId).filter((id) => mentionedIds.includes(id))
        : eligiblePersonaIds(thread, mentionedIds)
      const candidates = ids.map((id) => this.requirePersona(id))
      if (candidates.length === 0) {
        this.recordFloorDecision(thread, '', 'pass', '本轮没有可发言的角色（已答/弃权/资格之外）', now)
        if (thread.roundMode === 'review' && thread.members.every((m) => m.completedRound || m.passedRound)) {
          await this.requestSummary(thread.id)
        }
        thread.speakingPersonaId = undefined
        thread.nextHint = undefined
        return
      }
      const states: Record<string, AgentRuntimeState> = {}
      for (const candidate of candidates) states[candidate.id] = this.stateOf(candidate.id, now)
      const latest = thread.messages.at(-1)?.text ?? ''
      let pick: { personaId: string; focus: string }
      if (candidates.length === 1) {
        // 唯一候选没必要过仲裁器，但“正在处理”时要等他，不能硬插话。
        const only = candidates[0]
        const gate = canSpeak(states[only.id] ?? createRuntimeState(only.id, now), now)
        if (!gate.ok) {
          this.recordFloorDecision(
            thread,
            only.id,
            'wait',
            `${only.name} 正在处理（${gate.reason ?? '忙'}）`,
            now,
          )
          thread.speakingPersonaId = undefined
          thread.nextHint = only.name
          return
        }
        const mentioned = pinMentions && mentionedIds.includes(only.id)
        this.recordFloorDecision(thread, only.id, 'speak', `${mentioned ? '被点名' : '唯一候选'}：${only.name}`, now)
        pick = { personaId: only.id, focus: this.focusFor(only, candidates, latest, pinMentions) }
      } else {
        const decision = decideNext({
          latestText: latest,
          mentionedIds,
          members: candidates.map((candidate) => {
            const member = this.memberOf(thread, candidate.id)
            return {
              personaId: candidate.id,
              name: candidate.name,
              duties: candidate.duties,
              activity: member?.activity ?? candidate.defaultActivity,
              answered: Boolean(member?.completedRound || member?.passedRound),
            }
          }),
          states,
          spokenIds,
          now,
        })
        if (decision.action === 'wait') {
          this.recordFloorDecision(thread, decision.personaId ?? '', 'wait', decision.reason, now)
          thread.speakingPersonaId = undefined
          thread.nextHint = decision.waitingOn ? this.nameOf(decision.waitingOn) : undefined
          return
        }
        if (decision.action === 'pass' || !decision.personaId) {
          this.recordFloorDecision(thread, decision.personaId ?? '', 'pass', decision.reason, now)
          if (thread.roundMode === 'review' && thread.members.every((m) => m.completedRound || m.passedRound)) {
            await this.requestSummary(thread.id)
          }
          thread.speakingPersonaId = undefined
          thread.nextHint = undefined
          return
        }
        this.recordFloorDecision(thread, decision.personaId, 'speak', decision.reason, now)
        const chosen = this.requirePersona(decision.personaId)
        pick = { personaId: chosen.id, focus: this.focusFor(chosen, candidates, latest, pinMentions) }
      }
      const persona = this.requirePersona(pick.personaId)
      this.setAgentState(persona.id, applyDecision(this.stateOf(persona.id, now), 'speak', Date.now()))
      thread.speakingPersonaId = persona.id
      const next = candidates.find((c) => c.id !== persona.id)
      thread.nextHint = next ? next.name : undefined
      const visible = this.visibleFor(thread, persona, wakeMessageId)
      const decisionsAtStart = thread.floorDecisions
      const memberNames = thread.memberIds.map((id) => this.requirePersona(id).name)
      let result: SpeakResult | undefined
      let staleFlag = false
      let attempts = 0
      while (true) {
        const turnVisible = attempts === 0 ? visible : this.visibleFor(thread, persona, wakeMessageId)
        const agentState = this.stateOf(persona.id, Date.now())
        const roleState = buildRoleState({
          personaName: persona.name,
          facts: this.localFacts(thread),
          ...(agentState.waitingOn ? { waitingOn: this.nameOf(agentState.waitingOn) } : {}),
          lastSeq: this.lastMessageSeq(thread),
        })
        try {
          result = await this.speaker.complete({
            persona,
            thread,
            focus: pick.focus,
            visibleMessages: turnVisible,
            identity: identityText(persona),
            userGlobal: userGlobals(this.state.memories).map((m) => m.text),
            threadMemory: this.memoryTexts(persona, thread),
            catalog: catalogFor(persona.id, this.state.threads),
            roleState,
            memberNames,
            retrievalMode: this.retrievalMode,
            memoryContextMode: this.memoryContextMode,
          })
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          const code = /^([A-Z][A-Z0-9_]{2,}):/.exec(detail)?.[1]
          this.setAgentIdle(persona.id, Date.now())
          thread.blocked = {
            personaId: persona.id,
            name: persona.name,
            ...(code ? { code } : {}),
            message: detail,
            at: Date.now(),
          }
          this.pushMessage(thread, {
            kind: 'system',
            authorName: '系统主持',
            text: `${persona.name}（模型 ${persona.model}）调用失败：${detail}。本轮已暂停，等你决定继续还是移除它；不会用假回复顶上。`,
          })
          thread.speakingPersonaId = undefined
          thread.nextHint = undefined
          return
        }
        // 因果校验：生成期间有新消息 → 回复基于旧视图。
        const currentSeq = this.lastMessageSeq(thread)
        const basedOnSeq = result.basedOnSeq
        if (typeof basedOnSeq !== 'number' || currentSeq <= basedOnSeq) break
        // 生成期间用户又发了消息（resetRound 换了决策数组）：旧回复一律丢弃，不能污染新一轮。
        const aborted = thread.floorDecisions !== decisionsAtStart
        const policy = aborted ? 'drop' : this.stalePolicy
        const lag = currentSeq - basedOnSeq
        if (!aborted && policy === 'regenerate' && attempts < 1) {
          attempts += 1
          this.recordMetric(thread, {
            at: Date.now(),
            kind: 'stale',
            value: lag,
            fields: { action: 'regenerate', personaId: persona.id, basedOnSeq, currentSeq },
          })
          continue
        }
        this.recordMetric(thread, {
          at: Date.now(),
          kind: 'stale',
          value: lag,
          fields: { action: aborted ? 'aborted' : policy, personaId: persona.id, basedOnSeq, currentSeq },
        })
        if (policy === 'drop') {
          const dropped = thread.members.find((m) => m.personaId === persona.id)
          if (dropped) dropped.completedRound = true
          this.setAgentIdle(persona.id, Date.now())
          result = undefined
          if (!aborted) {
            this.pushMessage(thread, {
              kind: 'system',
              authorName: '系统主持',
              text: `${persona.name} 的回复基于旧版本（生成期间有更新的消息），已丢弃。`,
            })
          }
          break
        }
        staleFlag = true
        break
      }
      if (!result) {
        // 旧版本回复被丢弃：如果期间已经开了新一轮，旧一轮直接让位。
        if (thread.floorDecisions !== decisionsAtStart) return
        thread.speakingPersonaId = undefined
        thread.nextHint = undefined
        spoken += 1
        mentionedIds = mentionedIds.filter((id) => id !== persona.id)
        continue
      }
      const member = thread.members.find((m) => m.personaId === persona.id)
      if (this.blockForeignLeak(thread, persona, result.text)) {
        if (member) member.completedRound = true
        this.settleSpeak(persona.id, Date.now())
        spokenIds.push(persona.id)
        if (result.proposeRecallThreadId) {
          this.noteRecall(thread.id, persona.id, result.proposeRecallThreadId)
          thread.speakingPersonaId = undefined
          return
        }
        spoken += 1
        mentionedIds = mentionedIds.filter((id) => id !== persona.id)
        continue
      }
      if (member) {
        member.completedRound = !result.pass
        member.passedRound = Boolean(result.pass)
      }
      const spokenMessage = this.pushMessage(thread, {
        kind: 'persona',
        authorId: persona.id,
        authorName: persona.name,
        text: result.text,
        pass: result.pass,
        ...(staleFlag ? { stale: true } : {}),
        ...(typeof result.basedOnSeq === 'number' ? { basedOnSeq: result.basedOnSeq } : {}),
        windowReply: this.memberOf(thread, persona.id)?.activity === 'muted',
      })
      if (result.trace?.length) this.recordTrace(thread, persona, result.trace, spokenMessage.id)
      if (result.pass) {
        this.setAgentState(persona.id, applyDecision(this.stateOf(persona.id, Date.now()), 'pass', Date.now()))
        this.pushMessage(thread, {
          kind: 'system',
          authorName: '系统主持',
          text: `${persona.name} 本轮弃权（只代表自己没增量）。`,
        })
      } else {
        this.settleSpeak(persona.id, Date.now())
      }
      spokenIds.push(persona.id)
      if (result.proposeRecallThreadId) {
        this.noteRecall(thread.id, persona.id, result.proposeRecallThreadId)
        thread.speakingPersonaId = undefined
        return
      }
      this.maybeRemember(thread, persona, result.text)
      await this.maybeProactive(thread, persona, result.text)
      spoken += 1
      mentionedIds = mentionedIds.filter((id) => id !== persona.id)
      if (pinMentions) {
        if (mentionedIds.length === 0) {
          thread.speakingPersonaId = undefined
          return
        }
        continue
      }
      if (thread.roundMode !== 'review' && mentionedIds.length === 0 && this.memberOf(thread, persona.id)?.activity !== 'high') {
        thread.speakingPersonaId = undefined
        return
      }
    }
  }

  /**
   * 发言焦点仍由椅子按职责决定（人物选择已交给仲裁器，这里只算 focus）。
   */
  private focusFor(persona: Persona, candidates: Persona[], latestText: string, pinMentions: boolean): string {
    const mentioned = pinMentions && candidates.some((candidate) => candidate.id === persona.id)
    const pick = this.chair.pickNext({
      candidates: [persona],
      dutiesLeft: candidates.flatMap((candidate) => candidate.duties),
      latestText,
      mentionedIds: mentioned ? [persona.id] : [],
    })
    return pick?.focus || persona.duties[0] || '增量补充'
  }

  /**
   * 解除中断：skip = 本轮移除该角色继续；retry = 已修好，重试本轮。
   */
  /** 开始前体检不通过：把指定成员从本轮候选移除（只影响本轮，不踢出群）。 */
  excludeFromRound(threadId: string, personaIds: string[]): void {
    const thread = this.state.threads.find((item) => item.id === threadId)
    if (!thread) throw new Error('群不存在')
    const names: string[] = []
    for (const personaId of personaIds) {
      const member = thread.members.find((item) => item.personaId === personaId)
      if (!member) continue
      member.completedRound = true
      member.passedRound = false
      names.push(this.state.personas.find((persona) => persona.id === personaId)?.name ?? personaId)
    }
    if (names.length) {
      this.pushMessage(thread, {
        kind: 'system',
        authorName: '系统主持',
        text: `本轮已移除 ${names.join('、')}（开始前体检不通过）。`,
      })
    }
  }

  async resolveBlocked(threadId: string, action: 'skip' | 'retry'): Promise<void> {
    const thread = this.state.threads.find((item) => item.id === threadId)
    if (!thread) throw new Error('群不存在')
    const blocked = thread.blocked
    if (!blocked) return
    thread.blocked = undefined
    if (action === 'skip') {
      const member = thread.members.find((item) => item.personaId === blocked.personaId)
      if (member) member.completedRound = true
      this.pushMessage(thread, {
        kind: 'system',
        authorName: '系统主持',
        text: `本轮已移除 ${blocked.name}（${blocked.message}），继续。`,
      })
    } else {
      this.pushMessage(thread, {
        kind: 'system',
        authorName: '系统主持',
        text: `${blocked.name} 已恢复，重试本轮。`,
      })
    }
    await this.advanceFloor(thread, [])
    this.refreshDigest(thread)
    this.recordFloorMetric(thread)
  }

  private noteRecall(threadId: string, personaId: string, targetThreadId: string): void {
    if (!this.state.threads.some((t) => t.id === targetThreadId)) return
    this.state.pendingRecall = { threadId, personaId, targetThreadId }
  }

  private blockForeignLeak(thread: Thread, persona: Persona, text: string): boolean {
    const leaked = speechLeaksOtherThread(text, this.otherThreadBodies(thread.id), this.allowedSpeech(thread, persona.id))
    if (!leaked) return false
    this.pushMessage(thread, {
      kind: 'system',
      authorName: '系统主持',
      text: `${persona.name} 的回复含另一场正文，未同意前已整段拦住。`,
    })
    return true
  }

  private otherThreadBodies(threadId: string): string[] {
    const out: string[] = []
    for (const t of this.state.threads) {
      if (t.id === threadId) continue
      for (const m of t.messages) {
        if (m.kind === 'system') continue
        out.push(m.text)
      }
    }
    for (const m of this.state.memories) {
      if (m.scope === 'thread' && m.threadId && m.threadId !== threadId) out.push(m.text)
    }
    return out
  }

  private allowedSpeech(thread: Thread, personaId: string): string[] {
    const local = [
      ...thread.messages.map((m) => m.text),
      ...threadMemories(this.state.memories, thread.id).map((m) => m.text),
    ]
    const catalog = catalogFor(personaId, this.state.threads)
      .filter((c) => c.threadId !== thread.id)
      .flatMap((c) => [c.title, c.topic, c.shortSummary])
    return [...local, ...catalog]
  }

  private visibleFor(thread: Thread, persona: Persona, wakeMessageId?: string): Message[] {
    const member = this.memberOf(thread, persona.id)
    if (member?.activity === 'muted') {
      const around = wakeMessageId ?? thread.messages.at(-1)?.id
      const windowed = around ? windowMessages(thread.messages, around, 6) : thread.messages.slice(-6)
      const key = wakeKey(persona.id, thread.id)
      const old = this.state.wakeExcerpts[key] ?? []
      const excerpt = windowed.map((m) => `${m.authorName}: ${m.text}`).join('\n')
      this.state.wakeExcerpts[key] = [...old.slice(-5), excerpt]
      return windowed
    }
    return thread.messages
  }

  private memoryTexts(persona: Persona, thread: Thread): string[] {
    const own = threadMemories(this.state.memories, thread.id).map((m) => m.text)
    const member = this.memberOf(thread, persona.id)
    if (member?.activity === 'muted') {
      const wakes = this.state.wakeExcerpts[wakeKey(persona.id, thread.id)] ?? []
      return [...wakes, ...own]
    }
    return own
  }

  /** 记录一轮执行轨迹（最多保留最近 40 轮，steps 截断）。 */
  private recordTrace(thread: Thread, persona: Persona, steps: TurnStepTrace[], messageId?: string): void {
    const first = steps[0]?.at ?? Date.now()
    const last = steps[steps.length - 1]?.at ?? first
    thread.traces = [
      ...(thread.traces ?? []),
      {
        id: createId('tr'),
        personaId: persona.id,
        personaName: persona.name,
        ...(messageId ? { messageId } : {}),
        at: first,
        ms: Math.max(0, last - first),
        steps: steps.slice(0, 40),
      },
    ].slice(-40)
  }

  private maybeRemember(thread: Thread, persona: Persona, text: string): void {
    if (text.length < 8) return
    this.state.memories.push(
      appendThreadMemory(this.state.memories, thread.id, `${persona.name}：${text.slice(0, 120)}`),
    )
  }

  private async maybeProactive(thread: Thread, persona: Persona, lastText: string): Promise<void> {
    if (!persona.proactiveDm) return
    if (!/不宜公开|私下| discreet|薪资|人事/.test(lastText) && !/私下/.test(lastText)) return
    const last = this.state.lastProactiveAt[persona.id] ?? 0
    if (Date.now() - last < HOUR) return
    if (thread.roundMode === 'review') return
    const dm = this.openDm(persona.id, thread.projectRoot)
    this.pushMessage(dm, {
      kind: 'persona',
      authorId: persona.id,
      authorName: persona.name,
      text: `有一点不宜在「${thread.title}」里公开：${lastText.slice(0, 80)}`,
      proactive: true,
    })
    dm.unread += 1
    this.state.lastProactiveAt[persona.id] = Date.now()
  }

  /**
   * 客户端定时器调用：挑一个可触发的角色，生成一条主动私聊（一次 tick 最多一条）。
   * 判定是纯函数（proactive.ts），这里只负责生成/投递/计数；失败静默，不影响主流程。
   */
  async tickProactive(now = Date.now()): Promise<{ fired: boolean; personaId?: string; reason: string }> {
    for (const persona of this.state.personas) {
      if (!persona.proactiveDm) continue
      const verdict = proactiveEligibility({
        persona,
        now,
        threads: this.state.threads,
        agentStatus: this.stateOf(persona.id, now).status,
        limits: this.proactiveLimits,
      })
      if (!verdict.ok) continue
      const group = this.state.threads.find(
        (thread) => thread.kind === 'group' && thread.memberIds.includes(persona.id),
      )
      const dm = this.openDm(persona.id, group?.projectRoot ?? this.defaultProjectRoot())
      const roleState = group
        ? buildRoleState({
          personaName: persona.name,
          facts: this.localFacts(group),
          lastSeq: group.messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0),
        })
        : undefined
      try {
        const result = await this.speaker.complete({
          persona,
          thread: dm,
          focus: '主动私聊',
          visibleMessages: dm.messages,
          identity: identityText(persona),
          userGlobal: userGlobals(this.state.memories).map((entry) => entry.text),
          threadMemory: this.memoryTexts(persona, dm),
          catalog: catalogFor(persona.id, this.state.threads),
          memberNames: [persona.name],
          proactive: true,
          ...(roleState ? { roleState } : {}),
        })
        const text = result.text.trim()
        if (!text || result.pass) return { fired: false, personaId: persona.id, reason: 'empty' }
        this.pushMessage(dm, {
          kind: 'persona',
          authorId: persona.id,
          authorName: persona.name,
          text,
          proactive: true,
        }, now)
        dm.unread += 1
        this.state.lastProactiveAt[persona.id] = now
        return { fired: true, personaId: persona.id, reason: 'ok' }
      } catch {
        // 主动私聊失败不打扰用户（也不进中断卡），下一轮再试。
        return { fired: false, personaId: persona.id, reason: 'error' }
      }
    }
    return { fired: false, reason: 'none-eligible' }
  }

  private defaultProjectRoot(): string {
    return this.state.threads.find((thread) => thread.projectRoot)?.projectRoot ?? '.'
  }

  private abortSpeaking(thread: Thread, label: string): void {
    const last = [...thread.messages].reverse().find((m) => m.kind === 'persona' && !m.pass)
    if (thread.speakingPersonaId && last && !last.interrupted) {
      last.interrupted = true
      last.text = `${last.text}\n（${label}）`
    }
    thread.speakingPersonaId = undefined
    for (const m of thread.members) {
      if (!m.completedRound && !m.passedRound) continue
    }
    const speaking = thread.members.find((m) => m.personaId && !m.completedRound)
    if (speaking) {
      speaking.completedRound = false
      speaking.passedRound = false
    }
  }

  private resetRound(thread: Thread): void {
    const now = Date.now()
    for (const m of thread.members) {
      m.completedRound = false
      m.passedRound = false
      // 新一轮开始：弃权/等待/冷却清零；正在生成的不动（等它自己回 idle 或 TTL 过期）。
      const current = this.agentStates.get(m.personaId)
      if (!current || current.status === 'thinking') continue
      this.agentStates.set(m.personaId, {
        ...current,
        status: 'idle',
        since: now,
        waitingOn: undefined,
        lastSpokeAt: undefined,
      })
    }
    thread.floorDecisions = []
  }

  private buildSummary(thread: Thread): string {
    const lines = thread.messages
      .filter((m) => m.kind === 'persona' && !m.pass)
      .map((m) => `- ${m.authorName}：${m.text}`)
    return [
      `# ${thread.title} 本轮汇总`,
      '',
      `主题：${thread.topic}`,
      '',
      '## 观点（已去重合并同发言人）',
      ...lines,
      '',
      '## 建议',
      '不改已有源码；产物仅写在本目录。回到干活台让主 Agent 阅读本文件。',
      '',
    ].join('\n')
  }

  private pushMessage(
    thread: Thread,
    partial: Omit<Message, 'id' | 'threadId' | 'createdAt'>,
    at = Date.now(),
  ): Message {
    const seq = thread.messages.reduce(
      (max, message) => Math.max(max, message.seq ?? 0),
      thread.messages.length,
    ) + 1
    const msg: Message = {
      id: createId('m'),
      threadId: thread.id,
      seq,
      createdAt: at,
      ...partial,
    }
    thread.messages.push(msg)
    thread.updatedAt = msg.createdAt
    return msg
  }

  private personasIn(thread: Thread): Persona[] {
    return thread.memberIds.map((id) => this.requirePersona(id))
  }

  private memberOf(thread: Thread, personaId: string) {
    return thread.members.find((m) => m.personaId === personaId)
  }

  private requirePersona(id: string): Persona {
    const p = this.state.personas.find((x) => x.id === id)
    if (!p) throw new Error(`persona not found: ${id}`)
    return p
  }

  requireThread(id: string): Thread {
    const t = this.state.threads.find((x) => x.id === id)
    if (!t) throw new Error(`thread not found: ${id}`)
    return t
  }

  addMemory(entry: MemoryEntry): void {
    this.state.memories.push(entry)
  }
}
