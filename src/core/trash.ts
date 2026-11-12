/**
 * 软删除（回收站）契约：纯类型 + 纯函数。
 *
 * **这里不能 import node:fs**（`src/core` 会被打进客户端 bundle）。
 * 物理目录搬运在 `src/host/trash-store.ts`；状态变更在 `src/core/im.ts`。
 *
 * 删除口径（已和用户确认）：
 * - 「删除会话 / 解散群」：会话从 state 移除，数据目录移到 `<根>/.dsh-im/trash/<id>/data/<threadId>/`；
 * - 「清空聊天记录」：会话保留，消息/任务板/共识/轨迹/附件移到回收站，之后还能恢复；
 * - 「删除角色」：角色从通讯录移除；它的私聊/三人小窗会话一起删除；群内只移除成员、群历史保留。
 *
 * 快照（payload）随 trash manifest 落盘，恢复时不需要再读 state.json ——
 * 删除那一刻的数据就是恢复后的数据，不靠"重建猜测"。
 */
import type { Activity, MemoryEntry, Persona, Thread, ThreadKind } from './types.ts'

export const TRASH_KINDS = ['thread', 'persona', 'history'] as const
export type TrashKind = (typeof TRASH_KINDS)[number]

export const TRASH_KIND_LABEL: Record<TrashKind, string> = {
  thread: '会话',
  persona: '角色',
  history: '聊天记录',
}

/** 回收站清单项（跨 host/client 共用；host 落 manifest，客户端只读这份元数据）。 */
export interface TrashEntryMeta {
  id: string
  kind: TrashKind
  /** 列表主标题：群名 / 角色名 / 会话名。 */
  label: string
  /** 副标题：类型 + 规模（如「群 · 12 条消息 · 4 人」）。 */
  detail: string
  deletedAt: number
  /** 已经移到回收站的数据目录（threadId）；角色记录里是被连带删除的会话。 */
  threadIds: string[]
  /** 数据目录字节数（0 = 没有目录或统计失败）。 */
  bytes: number
  restorable: boolean
}

/** 删除角色时，该角色在某个群里的成员位置（恢复时放回原位、恢复活跃度）。 */
export interface TrashPersonaMembership {
  threadId: string
  /** 删除时在 memberIds 里的下标。 */
  index: number
  activity: Activity
}

/** 恢复一条回收站记录所需的全部状态快照。 */
export interface TrashPayload {
  /** kind=thread / history：被删 / 被清空前的会话快照（含消息）。 */
  thread?: Thread
  /** kind=persona：被连带删除的私聊 / 三人小窗快照。 */
  threads?: Thread[]
  /** kind=persona：被删除的角色。 */
  persona?: Persona
  /** kind=persona：该角色原本在哪些群、什么位置。 */
  memberships?: TrashPersonaMembership[]
  /** 被删除/清空会话时一并清理的线程级记忆（恢复时还原）。 */
  memories?: MemoryEntry[]
  /** 被删除/清空会话时一并清理的唤醒摘要（key = `personaId:threadId`）。 */
  wakeExcerpts?: Record<string, string[]>
}

/** ImService.deleteThread 的结果：删完的内存状态 + 交给 host 回收站的快照。 */
export interface DeleteThreadPlan {
  threadId: string
  label: string
  detail: string
  snapshot: Thread
}

/** ImService.clearThreadHistory 的结果。 */
export interface ClearHistoryPlan {
  threadId: string
  label: string
  detail: string
  snapshot: Thread
  memories: MemoryEntry[]
  wakeExcerpts: Record<string, string[]>
}

/** ImService.deletePersona 的结果。 */
export interface DeletePersonaPlan {
  persona: Persona
  label: string
  detail: string
  /** 被连带删除的私聊 / 三人小窗快照。 */
  threads: Thread[]
  memberships: TrashPersonaMembership[]
  memories: MemoryEntry[]
  wakeExcerpts: Record<string, string[]>
}

/** ImService.restorePersona 的结果；部分会话/群可能已不存在，必须如实回报。 */
export interface RestorePersonaResult {
  persona: Persona
  threads: Thread[]
  skippedThreadIds: string[]
  skippedMembershipThreadIds: string[]
}

/** 深拷贝：快照必须与内存对象脱钩，否则删除后拖动状态会污染回收站里的数据。 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 生成可安全落盘的会话快照。
 *
 * 去掉的字段都是「运行时瞬时态」或「待落盘队列」：
 * - speakingPersonaId / nextHint / blocked / floorDecisions：本轮状态，恢复后重新开始更合理；
 * - pendingMetrics / pendingFactOps / extractedFacts / retractedFactIds：删除前已经落过盘，
 *   留在快照里会在恢复后重复写事件/指标；
 * - unread：恢复后应该是未读 0（用户主动恢复，不该再弹红点）。
 */
export function sanitizeThreadSnapshot(thread: Thread): Thread {
  const snapshot = cloneJson(thread)
  delete snapshot.speakingPersonaId
  delete snapshot.nextHint
  delete snapshot.blocked
  delete snapshot.floorDecisions
  delete snapshot.pendingMetrics
  delete snapshot.pendingFactOps
  delete snapshot.extractedFacts
  delete snapshot.retractedFactIds
  snapshot.unread = 0
  snapshot.roundMode = 'idle'
  return snapshot
}

export function threadKindLabel(kind: ThreadKind): string {
  return kind === 'group' ? '群' : kind === 'triad' ? '三人小窗' : '私聊'
}

/** 回收站副标题：类型 + 消息数 + 群/小窗人数。 */
export function trashThreadDetail(thread: Thread): string {
  const people = thread.kind === 'group' ? ` · ${thread.memberIds.length + 1} 人` : ''
  return `${threadKindLabel(thread.kind)} · ${thread.messages.length} 条消息${people}`
}

/** 清空记录后的副标题：写明清掉多少条，方便用户在回收站里认出来。 */
export function trashHistoryDetail(snapshot: Thread): string {
  return `聊天记录 · ${snapshot.messages.length} 条消息`
}

/** 删除角色的副标题：几个会话 + 几个群受影响。 */
export function trashPersonaDetail(
  _persona: Persona,
  threads: readonly Thread[],
  memberships: readonly TrashPersonaMembership[],
): string {
  const parts = [threads.length ? `${threads.length} 个会话一起删除` : '没有私聊会话']
  if (memberships.length) parts.push(`从 ${memberships.length} 个群移除`)
  return parts.join(' · ')
}

/** 清空记录只有在「会话清空后没有新消息」时才能恢复（否则恢复会覆盖新记录）。 */
export function canRestoreHistory(thread: Thread): boolean {
  return thread.messages.length === 0
}
