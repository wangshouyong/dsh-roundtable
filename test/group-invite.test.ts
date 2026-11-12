import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import type { Speaker } from '../src/core/types.ts'

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
    defaultActivity: 'high',
  })
  const dev = im.createPersona({
    name: '开发',
    avatar: '开',
    personality: '快',
    duties: ['实现'],
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'mention-only',
  })
  const group = im.createGroup('方案评审组', [pm.id, qa.id], 'D:/ws')
  const dm = im.openDm(pm.id, 'D:/ws')
  const triad = im.createTriad([pm.id, qa.id], 'D:/ws')
  return { im, pm, qa, dev, group, dm, triad }
}

describe('邀请成员进群', () => {
  it('邀请不在群里的角色：成员列表/成员状态/系统记录一起更新', () => {
    const { im, dev, group } = setup()
    const before = group.messages.length

    const result = im.addMembers(group.id, [dev.id])

    expect(result.added.map((persona) => persona.id)).toEqual([dev.id])
    expect(result.skipped).toEqual([])
    expect(group.memberIds).toContain(dev.id)
    const member = group.members.find((item) => item.personaId === dev.id)
    expect(member).toMatchObject({ activity: 'mention-only', completedRound: false, passedRound: false })
    expect(group.messages).toHaveLength(before + 1)
    expect(group.messages.at(-1)?.text).toBe('已邀请「开发」加入本群。')
    expect(group.messages.at(-1)?.kind).toBe('system')
  })

  it('已在群里的角色：跳过并如实回报，不重复加成员、不重复写系统记录', () => {
    const { im, pm, group } = setup()
    const beforeMembers = [...group.memberIds]
    const beforeMessages = group.messages.length

    const result = im.addMembers(group.id, [pm.id])

    expect(result.added).toEqual([])
    expect(result.skipped).toEqual([pm.id])
    expect(group.memberIds).toEqual(beforeMembers)
    expect(group.messages).toHaveLength(beforeMessages)
  })

  it('多选去重 + 部分已入群：只加新角色，系统记录只写一次', () => {
    const { im, pm, dev, group } = setup()
    const beforeMessages = group.messages.length

    const result = im.addMembers(group.id, [dev.id, dev.id, pm.id])

    expect(result.added.map((persona) => persona.id)).toEqual([dev.id])
    expect(result.skipped).toEqual([pm.id])
    expect(group.members.filter((item) => item.personaId === dev.id)).toHaveLength(1)
    expect(group.messages.at(-1)?.text).toBe('已邀请「开发」加入本群。')
    expect(group.messages).toHaveLength(beforeMessages + 1)
  })

  it('先校验全部 id 再落状态：有无效角色时整次拒绝，不会加一半', () => {
    const { im, dev, group } = setup()
    const beforeMembers = [...group.memberIds]
    const beforeMessages = group.messages.length

    expect(() => im.addMembers(group.id, [dev.id, 'p_missing'])).toThrow(/persona not found/)
    expect(group.memberIds).toEqual(beforeMembers)
    expect(group.messages).toHaveLength(beforeMessages)
  })

  it('只有群能邀请：私聊 / 三人小窗 / 不存在的会话都拒绝', () => {
    const { im, dev, dm, triad } = setup()
    expect(() => im.addMembers(dm.id, [dev.id])).toThrow(/只有群可以邀请成员/)
    expect(() => im.addMembers(triad.id, [dev.id])).toThrow(/只有群可以邀请成员/)
    expect(() => im.addMembers('t_missing', [dev.id])).toThrow(/thread not found/)
  })

  it('空名单是幂等空操作；邀请后成员关系能落盘读回', () => {
    const { im, dev, group } = setup()
    const beforeMessages = group.messages.length
    expect(im.addMembers(group.id, []).added).toEqual([])
    expect(group.messages).toHaveLength(beforeMessages)

    im.addMembers(group.id, [dev.id])
    const raw = JSON.stringify({ personas: im.state.personas, threads: im.state.threads })
    const reopened = JSON.parse(raw) as { threads: { id: string; memberIds: string[]; members: { personaId: string }[] }[] }
    const saved = reopened.threads.find((thread) => thread.id === group.id)
    expect(saved?.memberIds).toContain(dev.id)
    expect(saved?.members.some((member) => member.personaId === dev.id)).toBe(true)
  })
})
