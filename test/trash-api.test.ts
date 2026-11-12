import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createImApi } from '../src/host/im-api.ts'
import type { Thread } from '../src/core/types.ts'

function snapshot(id: string, title = '方案评审组'): Thread {
  return {
    id,
    kind: 'group',
    title,
    topic: title,
    shortSummary: '',
    memberIds: [],
    members: [],
    projectRoot: 'D:/ws',
    messages: [],
    unread: 0,
    roundMode: 'idle',
    createdAt: 1,
    updatedAt: 1,
  }
}

async function setup(options: { native?: { forget: (filter: { personaId?: string; threadId?: string }) => Promise<number> } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dshim-trash-api-'))
  const api = createImApi({
    projectRoot: () => root,
    llm: () => undefined,
    workspaces: () => [{ path: root }],
    ...(options.native
      ? { native: () => ({ status: () => ({ enabled: true }), complete: async () => ({ text: '' }), forget: options.native!.forget }) }
      : {}),
  })
  return { root, api }
}

describe('回收站 API（/api/im/trash 背后的方法）', () => {
  it('标准闭环：add → list → restore → purge', async () => {
    const { root, api } = await setup()
    expect(await api.trashList(root)).toEqual({ entries: [] })

    const added = await api.trashAdd({
      projectRoot: root,
      kind: 'thread',
      label: '方案评审组',
      detail: '群 · 3 条消息',
      threadIds: ['t1'],
      payload: { thread: snapshot('t1') },
    })
    expect(added.entry.id).toMatch(/^tr_/)

    const listed = await api.trashList(root)
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0]).toMatchObject({ kind: 'thread', label: '方案评审组', threadIds: ['t1'] })

    const restored = await api.trashRestore({ projectRoot: root, id: added.entry.id })
    expect(restored.meta.id).toBe(added.entry.id)
    expect(restored.payload.thread?.id).toBe('t1')
    expect((await api.trashList(root)).entries).toEqual([])

    const purged = await api.trashPurge({ projectRoot: root })
    expect(purged).toEqual({ purged: 0, failed: [] })
  })

  it('label/detail 截断（防止把整段聊天塞进清单标题）', async () => {
    const { root, api } = await setup()
    const added = await api.trashAdd({
      projectRoot: root,
      kind: 'history',
      label: 'x'.repeat(500),
      detail: 'd'.repeat(500),
      threadIds: ['t1'],
      payload: { thread: snapshot('t1') },
      replaceOnRestore: true,
    })
    expect(added.entry.label.length).toBeLessThanOrEqual(121)
    expect(added.entry.label.endsWith('…')).toBe(true)
    expect(added.entry.detail.length).toBeLessThanOrEqual(241)
    expect(added.entry.detail.endsWith('…')).toBe(true)
  })

  it('参数校验：未知类型 / 缺快照 / 缺 id / 未注册数据根', async () => {
    const { root, api } = await setup()
    await expect(api.trashAdd({ projectRoot: root, kind: 'nope', payload: { thread: snapshot('t1') } }))
      .rejects.toMatchObject({ status: 400 })
    await expect(api.trashAdd({ projectRoot: root, kind: 'persona', payload: {} }))
      .rejects.toMatchObject({ status: 400 })
    await expect(api.trashAdd({ projectRoot: root, kind: 'thread', threadIds: ['../evil'], payload: { thread: snapshot('t1') } }))
      .rejects.toMatchObject({ status: 400 })
    await expect(api.trashRestore({ projectRoot: root, id: '  ' })).rejects.toMatchObject({ status: 400 })
    await expect(api.trashRestore({ projectRoot: root, id: 'bad id' })).rejects.toMatchObject({ status: 400 })
    await expect(api.trashList('D:/not-registered-root')).rejects.toMatchObject({ status: 400 })
  })

  it('native-forget：必须指定 personaId 或 threadId；有 bridge 时透传并返回释放条数', async () => {
    const noBridge = await setup()
    await expect(noBridge.api.nativeForget({})).rejects.toMatchObject({ status: 400 })
    expect(await noBridge.api.nativeForget({ threadId: 't1' })).toEqual({ disposed: 0 })

    const forget = vi.fn(async () => 2)
    const withBridge = await setup({ native: { forget } })
    expect(await withBridge.api.nativeForget({ personaId: 'p1', threadId: 't1' })).toEqual({ disposed: 2 })
    expect(forget).toHaveBeenCalledWith({ personaId: 'p1', threadId: 't1' })
    forget.mockResolvedValueOnce(0)
    expect(await withBridge.api.nativeForget({ personaId: 'p9' })).toEqual({ disposed: 0 })
    expect(forget).toHaveBeenLastCalledWith({ personaId: 'p9' })
  })
})
