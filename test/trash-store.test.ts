import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addTrashEntry,
  entryDir,
  listTrash,
  purgeTrash,
  restoreTrashEntry,
  trashRoot,
} from '../src/host/trash-store.ts'
import { groupDir } from '../src/host/event-store.ts'
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

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dshim-trash-'))
}

async function seedGroup(root: string, threadId: string, body = '{"seq":1}\n'): Promise<string> {
  const dir = groupDir(root, threadId)
  await mkdir(join(dir, 'attachments'), { recursive: true })
  await writeFile(join(dir, 'events.jsonl'), body)
  await writeFile(join(dir, 'attachments', 'a.png'), Buffer.alloc(32))
  return dir
}

async function pathMissing(path: string): Promise<boolean> {
  return stat(path).then(() => false, () => true)
}

describe('回收站存储：add / list / restore / purge', () => {
  it('移入回收站：数据目录搬走、manifest 落盘、清单可读、bytes 有值', async () => {
    const root = await tempRoot()
    const dir = await seedGroup(root, 't1')
    const entry = await addTrashEntry(root, {
      kind: 'thread',
      label: '方案评审组',
      detail: '群 · 3 条消息',
      threadIds: ['t1'],
      payload: { thread: snapshot('t1') },
    })

    expect(entry.id).toMatch(/^tr_[0-9a-z]{12}$/)
    expect(entry.kind).toBe('thread')
    expect(entry.label).toBe('方案评审组')
    expect(entry.detail).toBe('群 · 3 条消息')
    expect(entry.threadIds).toEqual(['t1'])
    expect(entry.bytes).toBeGreaterThan(32)
    expect(entry.restorable).toBe(true)
    expect(await pathMissing(dir)).toBe(true)
    expect(await stat(join(entryDir(root, entry.id), 'data', 't1', 'events.jsonl'))).toBeTruthy()

    const listed = await listTrash(root)
    expect(listed.map((item) => item.id)).toEqual([entry.id])
    expect(listed[0]).toMatchObject({ kind: 'thread', label: '方案评审组', threadIds: ['t1'] })

    const manifest = JSON.parse(await readFile(join(entryDir(root, entry.id), 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe(1)
    expect(manifest.meta.id).toBe(entry.id)
    expect(manifest.payload.thread.id).toBe('t1')
  })

  it('恢复：数据目录搬回原位置、返回快照、条目删除', async () => {
    const root = await tempRoot()
    const dir = await seedGroup(root, 't1')
    const entry = await addTrashEntry(root, {
      kind: 'thread',
      threadIds: ['t1'],
      payload: { thread: snapshot('t1') },
    })

    const restored = await restoreTrashEntry(root, entry.id)
    expect(restored.meta.id).toBe(entry.id)
    expect(restored.payload.thread?.id).toBe('t1')
    expect(restored.payload.thread?.title).toBe('方案评审组')
    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":1}\n')
    expect(await pathMissing(entryDir(root, entry.id))).toBe(true)
    expect(await listTrash(root)).toEqual([])
  })

  it('会话目录本来就不存在时也能建档恢复（只靠 payload 快照）', async () => {
    const root = await tempRoot()
    const entry = await addTrashEntry(root, {
      kind: 'thread',
      threadIds: ['t_missing'],
      payload: { thread: snapshot('t_missing', '不存在的会话') },
    })
    expect(entry.bytes).toBe(0)
    const restored = await restoreTrashEntry(root, entry.id)
    expect(restored.payload.thread?.title).toBe('不存在的会话')
    expect(await pathMissing(groupDir(root, 't_missing'))).toBe(true)
  })

  it('角色条目：多个会话目录一起搬、一起恢复；成员位置快照原样返回', async () => {
    const root = await tempRoot()
    const dmDir = await seedGroup(root, 't_dm')
    const triadDir = await seedGroup(root, 't_triad')
    const entry = await addTrashEntry(root, {
      kind: 'persona',
      label: '产品经理',
      threadIds: ['t_dm', 't_triad'],
      payload: {
        persona: { id: 'p1', name: '产品经理', avatar: '产', personality: 'x', duties: [], origin: 'mine', model: 'm', proactiveDm: false, defaultActivity: 'review' },
        memberships: [{ threadId: 't_group', index: 1, activity: 'muted' }],
        threads: [snapshot('t_dm', '产品经理'), snapshot('t_triad', '产品经理、测试')],
      },
    })
    expect(entry.threadIds).toEqual(['t_dm', 't_triad'])
    expect(await pathMissing(dmDir)).toBe(true)
    expect(await pathMissing(triadDir)).toBe(true)

    const restored = await restoreTrashEntry(root, entry.id)
    expect(restored.payload.persona?.name).toBe('产品经理')
    expect(restored.payload.memberships).toEqual([{ threadId: 't_group', index: 1, activity: 'muted' }])
    expect(await readFile(join(dmDir, 'events.jsonl'), 'utf8')).toBe('{"seq":1}\n')
    expect(await readFile(join(triadDir, 'events.jsonl'), 'utf8')).toBe('{"seq":1}\n')
  })

  it('清空聊天记录条目：replaceOnRestore 允许覆盖清空后重建的空目录', async () => {
    const root = await tempRoot()
    const dir = await seedGroup(root, 't1', '{"seq":1}\n{"seq":2}\n')
    const entry = await addTrashEntry(root, {
      kind: 'history',
      threadIds: ['t1'],
      payload: { thread: snapshot('t1') },
      replaceOnRestore: true,
    })
    // 清空后 saveState 会重建一个只有派生数据、没有旧消息的目录。
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'facts.json'), '[]')

    await restoreTrashEntry(root, entry.id)
    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":1}\n{"seq":2}\n')
    expect(await pathMissing(join(dir, 'facts.json'))).toBe(true)
  })

  it('普通条目恢复时不覆盖已有数据目录：409，且条目保留', async () => {
    const root = await tempRoot()
    const dir = await seedGroup(root, 't1')
    const entry = await addTrashEntry(root, {
      kind: 'thread',
      threadIds: ['t1'],
      payload: { thread: snapshot('t1') },
    })
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'new.txt'), 'new')

    await expect(restoreTrashEntry(root, entry.id)).rejects.toMatchObject({ status: 409 })
    expect(await listTrash(root)).toHaveLength(1)
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('new')
  })

  it('彻底删除：单条 / 清空回收站；无效 id 拒绝', async () => {
    const root = await tempRoot()
    await seedGroup(root, 't1')
    await seedGroup(root, 't2')
    const one = await addTrashEntry(root, { kind: 'thread', threadIds: ['t1'], payload: { thread: snapshot('t1') } })
    const two = await addTrashEntry(root, { kind: 'thread', threadIds: ['t2'], payload: { thread: snapshot('t2') } })
    expect(await listTrash(root)).toHaveLength(2)

    await purgeTrash(root, one.id)
    expect((await listTrash(root)).map((item) => item.id)).toEqual([two.id])
    expect(await pathMissing(entryDir(root, one.id))).toBe(true)

    const all = await purgeTrash(root)
    expect(all).toEqual({ purged: 1, failed: [] })
    expect(await listTrash(root)).toEqual([])
    expect(await pathMissing(trashRoot(root))).toBe(false) // 目录保留即可，条目没了
    await expect(purgeTrash(root, '../evil')).rejects.toMatchObject({ status: 400 })
  })

  it('非法 threadId / 缺快照 / 未知类型一律 400，不留半份目录', async () => {
    const root = await tempRoot()
    await expect(addTrashEntry(root, {
      kind: 'thread',
      threadIds: ['../../evil'],
      payload: { thread: snapshot('../../evil') },
    })).rejects.toMatchObject({ status: 400 })

    await expect(addTrashEntry(root, { kind: 'thread', threadIds: [] })).rejects.toMatchObject({ status: 400 })
    await expect(addTrashEntry(root, { kind: 'persona', payload: {} })).rejects.toMatchObject({ status: 400 })
    await expect(addTrashEntry(root, { kind: 'nope' as never, payload: { thread: snapshot('t1') } }))
      .rejects.toMatchObject({ status: 400 })
    expect(await listTrash(root)).toEqual([])
  })

  it('坏 manifest 的条目被跳过并记日志，不影响其它条目', async () => {
    const root = await tempRoot()
    const good = await addTrashEntry(root, { kind: 'thread', threadIds: [], payload: { thread: snapshot('t1') } })
    const broken = entryDir(root, 'tr_broken0001')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'manifest.json'), '{不是 json')

    const listed = await listTrash(root)
    expect(listed.map((item) => item.id)).toEqual([good.id])
  })

  it('恢复不存在的 id 返回 404', async () => {
    const root = await tempRoot()
    await expect(restoreTrashEntry(root, 'tr_notfound01')).rejects.toMatchObject({ status: 404 })
  })
})
