import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { sanitizeThreadSnapshot } from '../src/core/trash.ts'
import type { Message, Speaker, Thread } from '../src/core/types.ts'

const speaker: Speaker = {
  async complete() {
    return { text: '收到' }
  },
}

function setup() {
  const im = new ImService(speaker)
  const pm = im.createPersona({
    name: '产品经理',
    avatar: '产',
    personality: '直接',
    duties: ['需求'],
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'review',
  })
  const qa = im.createPersona({
    name: '测试',
    avatar: '测',
    personality: '稳',
    duties: ['质量'],
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'review',
  })
  const dev = im.createPersona({
    name: '开发',
    avatar: '开',
    personality: '快',
    duties: ['实现'],
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'review',
  })
  const group = im.createGroup('评审组', [pm.id, qa.id, dev.id], 'D:/ws')
  const dm = im.openDm(pm.id, 'D:/ws')
  const triad = im.createTriad([qa.id, dev.id], 'D:/ws')
  return { im, pm, qa, dev, group, dm, triad }
}

let seqSeed = 0
function push(thread: Thread, authorName: string, text: string, kind: Message['kind'] = 'user'): Message {
  seqSeed += 1
  const seq = thread.messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0) + 1
  const message: Message = {
    id: `m_${seqSeed}`,
    threadId: thread.id,
    seq,
    kind,
    authorName,
    text,
    createdAt: seqSeed * 1000,
  }
  thread.messages.push(message)
  thread.updatedAt = message.createdAt
  return message
}

function threadMemory(threadId: string, text: string) {
  return { id: `mem_${threadId}_${text}`, scope: 'thread' as const, threadId, text, createdAt: 1 }
}

describe('删除会话 / 解散群（软删除）', () => {
  it('会话从 state 移除，返回带消息的快照；只清掉它自己的记忆/唤醒/跨场召回', () => {
    const { im, pm, group, dm } = setup()
    push(group, '你', '开始评审')
    push(group, pm.name, '我看下')
    push(dm, '你', '单独聊')
    im.state.memories.push(
      threadMemory(group.id, '群记忆'),
      threadMemory(dm.id, '私聊记忆'),
      { id: 'mem_global', scope: 'user_global', text: '全局记忆', createdAt: 1 },
    )
    im.state.wakeExcerpts[`${pm.id}:${group.id}`] = ['摘要 A']
    im.state.wakeExcerpts[`${pm.id}:${dm.id}`] = ['摘要 B']
    im.state.pendingRecall = { threadId: group.id, personaId: pm.id, targetThreadId: dm.id }

    const plan = im.deleteThread(group.id)

    expect(plan.label).toBe('评审组')
    expect(plan.detail).toContain('群 · 2 条消息 · 4 人')
    expect(plan.snapshot.id).toBe(group.id)
    expect(plan.snapshot.messages).toHaveLength(2)
    expect(im.state.threads.some((thread) => thread.id === group.id)).toBe(false)
    expect(() => im.requireThread(group.id)).toThrow(/thread not found/)
    expect(im.state.memories.map((memory) => memory.id)).toEqual([threadMemory(dm.id, '私聊记忆').id, 'mem_global'])
    expect(im.state.wakeExcerpts[`${pm.id}:${group.id}`]).toBeUndefined()
    expect(im.state.wakeExcerpts[`${pm.id}:${dm.id}`]).toEqual(['摘要 B'])
    expect(im.state.pendingRecall).toBeNull()
    expect(im.state.threads.some((thread) => thread.id === dm.id)).toBe(true)
  })

  it('不存在的会话直接报错；快照剥离瞬时状态（不把本轮/待落盘队列带进回收站）', () => {
    const { im, pm, group } = setup()
    push(group, '你', '开始')
    group.speakingPersonaId = pm.id
    group.blocked = { personaId: pm.id, name: pm.name, message: '失败', at: 1 }
    group.floorDecisions = [{ personaId: pm.id, action: 'speak', reason: '点名', at: 1 }]
    group.pendingMetrics = [{ at: 1, kind: 'llm_call', value: 1 }]
    group.pendingFactOps = [{ op: 'retract', factId: 'f1', kind: 'fact', text: 'x', source: 'user', at: 1 }]
    group.extractedFacts = []
    group.retractedFactIds = ['f1']
    group.unread = 3

    const plan = im.deleteThread(group.id)
    const snapshot = plan.snapshot
    expect(snapshot.speakingPersonaId).toBeUndefined()
    expect(snapshot.blocked).toBeUndefined()
    expect(snapshot.floorDecisions).toBeUndefined()
    expect(snapshot.pendingMetrics).toBeUndefined()
    expect(snapshot.pendingFactOps).toBeUndefined()
    expect(snapshot.retractedFactIds).toBeUndefined()
    expect(snapshot.unread).toBe(0)
    expect(snapshot.roundMode).toBe('idle')
    expect(snapshot.messages).toHaveLength(1)
    expect(() => im.deleteThread('t_missing')).toThrow(/thread not found/)
  })
})

describe('清空聊天记录：会话保留、数据进回收站、可恢复', () => {
  function seedHistory(thread: Thread, owner: string) {
    push(thread, '你', '第一句')
    push(thread, owner, '第二句')
    thread.facts = [{ factId: 'f1', kind: 'decision', text: '周三上线', source: 'user', confidence: 1, seq: 1, at: 1 }]
    thread.factsVersion = 'facts-v1:x'
    thread.factsUntilSeq = 2
    thread.summaryState = { version: 'summary-v1', untilSeq: 2, l1: '摘要', l2: ['结论'], factsVersion: 'facts-v1:x', at: 1 }
    thread.summaryUntilSeq = 2
    thread.consensusState = { version: 'consensus-v1', at: 1, lanes: [], updatedUntilSeq: 2 } as unknown as Thread['consensusState']
    thread.traces = [{ id: 'tr1', personaId: 'p', personaName: '人', at: 1, ms: 1, steps: [] }]
    thread.blocked = { personaId: 'p', name: '人', message: '失败', at: 1 }
    thread.speakingPersonaId = 'p'
    thread.floorDecisions = [{ personaId: 'p', action: 'speak', reason: 'x', at: 1 }]
    thread.unread = 2
  }

  it('清空后会话还在，消息/事实/共识/摘要/轨迹/附件相关状态全部归零', () => {
    const { im, pm, group } = setup()
    seedHistory(group, pm.name)
    im.state.memories.push(threadMemory(group.id, '群记忆'))
    im.state.wakeExcerpts[`${pm.id}:${group.id}`] = ['摘要']

    const plan = im.clearThreadHistory(group.id)

    expect(plan.detail).toBe('聊天记录 · 2 条消息')
    expect(plan.snapshot.messages).toHaveLength(2)
    const thread = im.requireThread(group.id)
    expect(thread.title).toBe('评审组')
    expect(thread.memberIds).toEqual([pm.id, im.state.personas[1].id, im.state.personas[2].id])
    expect(thread.messages).toEqual([])
    expect(thread.facts).toEqual([])
    expect(thread.factsVersion).toBeUndefined()
    expect(thread.factsUntilSeq).toBe(0)
    expect(thread.summaryState).toBeUndefined()
    expect(thread.summaryUntilSeq).toBe(0)
    expect(thread.consensusState).toBeUndefined()
    expect(thread.traces).toEqual([])
    expect(thread.blocked).toBeUndefined()
    expect(thread.speakingPersonaId).toBeUndefined()
    expect(thread.floorDecisions).toEqual([])
    expect(thread.unread).toBe(0)
    expect(thread.roundMode).toBe('idle')
    expect(thread.topic).toBe(thread.title)
    expect(im.state.memories.some((memory) => memory.threadId === group.id)).toBe(false)
    expect(im.state.wakeExcerpts[`${pm.id}:${group.id}`]).toBeUndefined()
    expect(plan.memories.map((memory) => memory.threadId)).toEqual([group.id])
    expect(plan.wakeExcerpts[`${pm.id}:${group.id}`]).toEqual(['摘要'])
  })

  it('恢复历史：消息/事实/摘要/轨迹/记忆都回来；清空后又有新消息时拒绝恢复', () => {
    const { im, pm, group } = setup()
    seedHistory(group, pm.name)
    im.state.memories.push(threadMemory(group.id, '群记忆'))
    const plan = im.clearThreadHistory(group.id)

    const restored = im.restoreThreadHistory(plan.snapshot, plan)
    expect(restored.messages).toHaveLength(2)
    expect(restored.facts?.[0]?.text).toBe('周三上线')
    expect(restored.summaryState?.untilSeq).toBe(2)
    expect(restored.traces).toHaveLength(1)
    expect(im.state.memories.some((memory) => memory.text === '群记忆')).toBe(true)

    push(group, '你', '清空后又聊了一句')
    expect(() => im.restoreThreadHistory(plan.snapshot, plan)).toThrow(/清空后又有新消息/)
  })
})

describe('删除角色（彻底连带口径）', () => {
  function seed() {
    const ctx = setup()
    const { im, pm, qa, group, dm } = ctx
    push(group, '你', '开始评审')
    push(group, pm.name, '我的意见')
    push(dm, '你', '单独聊一句')
    im.setActivity(group.id, pm.id, 'muted')
    im.state.memories.push(
      threadMemory(group.id, '群记忆'),
      threadMemory(dm.id, '私聊记忆'),
      { id: 'mem_global', scope: 'user_global', text: '全局记忆', createdAt: 1 },
    )
    im.state.wakeExcerpts[`${pm.id}:${group.id}`] = ['角色摘要']
    im.state.wakeExcerpts[`${qa.id}:${group.id}`] = ['别人摘要']
    im.state.lastProactiveAt[pm.id] = 123
    im.state.pendingRecall = { threadId: group.id, personaId: pm.id, targetThreadId: dm.id }
    ;(im as unknown as { agentStates: Map<string, unknown> }).agentStates.set(pm.id, { personaId: pm.id })
    return ctx
  }

  it('私聊会话一起删除、群只移除成员并留系统记录、角色级引用全部清干净', () => {
    const { im, pm, qa, group, dm, triad } = seed()

    const plan = im.deletePersona(pm.id)

    expect(plan.label).toBe('产品经理')
    expect(plan.detail).toBe('1 个会话一起删除 · 从 1 个群移除')
    expect(plan.threads.map((thread) => thread.id)).toEqual([dm.id])
    expect(plan.threads[0].messages).toHaveLength(1)
    expect(plan.memberships).toEqual([{ threadId: group.id, index: 0, activity: 'muted' }])
    expect(im.state.personas.some((persona) => persona.id === pm.id)).toBe(false)
    expect(im.state.threads.some((thread) => thread.id === dm.id)).toBe(false)
    // 三人小窗里没有这个角色：不受影响。
    expect(im.state.threads.some((thread) => thread.id === triad.id)).toBe(true)

    const groupThread = im.requireThread(group.id)
    expect(groupThread.memberIds).toEqual([qa.id, im.state.personas[1].id])
    expect(groupThread.members.map((member) => member.personaId)).toEqual(groupThread.memberIds)
    expect(groupThread.messages.at(-1)?.text).toContain('角色「产品经理」已被删除，已移出本群')
    expect(groupThread.messages).toHaveLength(3)

    expect(im.state.memories.map((memory) => memory.id).sort()).toEqual(
      ['mem_global', threadMemory(group.id, '群记忆').id].sort(),
    )
    expect(im.state.wakeExcerpts[`${pm.id}:${group.id}`]).toBeUndefined()
    expect(im.state.wakeExcerpts[`${qa.id}:${group.id}`]).toEqual(['别人摘要'])
    expect(im.state.lastProactiveAt[pm.id]).toBeUndefined()
    expect(im.state.pendingRecall).toBeNull()
    expect((im as unknown as { agentStates: Map<string, unknown> }).agentStates.has(pm.id)).toBe(false)
    // 群记忆在删除角色时保留（群还在），私聊记忆随会话删除。
    expect(im.state.memories.some((memory) => memory.id === threadMemory(dm.id, '私聊记忆').id)).toBe(false)
    expect(im.state.memories.some((memory) => memory.id === threadMemory(group.id, '群记忆').id)).toBe(true)
  })

  it('恢复角色：角色/私聊会话/群成员位置/记忆一起还原；重复恢复拒绝', () => {
    const { im, pm, group, dm } = seed()
    const plan = im.deletePersona(pm.id)

    const result = im.restorePersona(plan)
    expect(result.persona.id).toBe(pm.id)
    expect(result.threads.map((thread) => thread.id)).toEqual([dm.id])
    expect(result.skippedThreadIds).toEqual([])
    expect(result.skippedMembershipThreadIds).toEqual([])
    expect(im.state.personas.some((persona) => persona.id === pm.id)).toBe(true)
    expect(im.requireThread(dm.id).messages).toHaveLength(1)
    const groupThread = im.requireThread(group.id)
    expect(groupThread.memberIds[0]).toBe(pm.id)
    expect(groupThread.members[0]).toMatchObject({ personaId: pm.id, activity: 'muted' })
    expect(groupThread.messages.at(-1)?.text).toContain('已从回收站恢复，重新加入本群')
    expect(im.state.memories.some((memory) => memory.id === threadMemory(dm.id, '私聊记忆').id)).toBe(true)
    expect(() => im.restorePersona(plan)).toThrow(/已经恢复过/)
  })

  it('恢复时部分会话/群已不存在：跳过并如实回报，不假装全部恢复', () => {
    const { im, pm, group } = setup()
    const ghost = {
      id: 'p_ghost',
      name: '幽灵角色',
      avatar: '幽',
      personality: '不存在',
      duties: ['协作'],
      origin: 'mine' as const,
      model: 'mock',
      proactiveDm: false,
      defaultActivity: 'review' as const,
    }
    // 会话快照 id 与现有群冲突 → 跳过；成员关系指向不存在的群 → 跳过。
    const ghostDm = { ...im.openDm(pm.id, 'D:/ws'), id: group.id }
    const payload = {
      persona: ghost,
      threads: [ghostDm],
      memberships: [{ threadId: 't_missing_group', index: 0, activity: 'review' as const }],
    }

    const result = im.restorePersona(payload)
    expect(result.threads).toEqual([])
    expect(result.skippedThreadIds).toEqual([group.id])
    expect(result.skippedMembershipThreadIds).toEqual(['t_missing_group'])
    expect(im.state.personas.some((persona) => persona.id === ghost.id)).toBe(true)
  })
})

describe('恢复会话前置校验', () => {
  it('角色已删时，私聊/小窗不能单独恢复；群可以恢复但会移除失效成员', () => {
    const { im, pm, qa, group, dm } = setup()
    push(group, '你', '群里说')
    push(dm, '你', '私下说')
    const plan = im.deletePersona(pm.id)
    const dmSnapshot = plan.threads[0]

    expect(() => im.restoreThread(dmSnapshot)).toThrow(/角色已被删除/)

    push(im.requireThread(group.id), '你', '删角色之后又说一句')
    const groupPlan = im.deleteThread(group.id)
    // 先删掉群里剩下的一个角色，让快照里的成员失效。
    im.deletePersona(qa.id)
    const restored = im.restoreThread(groupPlan.snapshot)
    expect(restored.memberIds).not.toContain(qa.id)
    expect(restored.messages.at(-1)?.text).toContain('移除了已不存在的角色')
  })

  it('同一份快照只能恢复一次', () => {
    const { im, group } = setup()
    push(group, '你', '一句')
    const plan = im.deleteThread(group.id)
    im.restoreThread(plan.snapshot)
    expect(() => im.restoreThread(plan.snapshot)).toThrow(/已经恢复过/)
  })
})

describe('sanitizeThreadSnapshot', () => {
  it('快照与内存对象脱钩：改内存不影响快照', () => {
    const { im, group } = setup()
    push(group, '你', '一句')
    const snapshot = sanitizeThreadSnapshot(group)
    push(group, '你', '又一句')
    expect(snapshot.messages).toHaveLength(1)
    expect(group.messages).toHaveLength(2)
  })
})
