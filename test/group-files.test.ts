import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listGroupFiles, readGroupFile } from '../src/host/group-files.ts'
import { groupDir } from '../src/host/event-store.ts'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dshim-files-'))
  const dir = groupDir(root, 't1')
  await mkdir(join(dir, '交付稿'), { recursive: true })
  await mkdir(join(dir, '交付稿', '草稿'), { recursive: true })
  await mkdir(join(dir, 'attachments'), { recursive: true })
  await mkdir(join(dir, '.cache', 'checks'), { recursive: true })
  // 内部账本：不应出现在「文件」里。
  for (const name of ['events.jsonl', 'facts.json', 'metrics.jsonl', 'receipts.jsonl', 'sync.json', 'lease.json', 'index.json', 'watch.json']) {
    await writeFile(join(dir, name), '{}', 'utf8')
  }
  await writeFile(join(dir, '本轮汇总.md'), '# 本轮汇总\n\n结论：可以上。\n', 'utf8')
  await writeFile(join(dir, '交付稿', '说明.md'), '交付说明', 'utf8')
  await writeFile(join(dir, '交付稿', '草稿', 'v1.txt'), '草稿 v1', 'utf8')
  await writeFile(join(dir, 'attachments', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))
  await writeFile(join(dir, '.cache', 'checks', 'run.log'), 'log', 'utf8')
  return { root, dir }
}

describe('群工作区文件（只读浏览）', () => {
  it('根目录：隐藏内部账本与 .cache，目录在前、文件在后，带大小/时间/mediaType', async () => {
    const { root } = await setup()
    const listing = await listGroupFiles(root, 't1')
    expect(listing.exists).toBe(true)
    expect(listing.path).toBe('')
    expect(listing.parent).toBe('')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['交付稿', 'attachments', '本轮汇总.md'])
    expect(listing.entries.map((entry) => entry.kind)).toEqual(['dir', 'dir', 'file'])
    const summary = listing.entries.find((entry) => entry.name === '本轮汇总.md')
    expect(summary?.bytes).toBeGreaterThan(0)
    expect(summary?.mediaType).toBe('text/plain')
    expect(summary?.modifiedAt).toBeGreaterThan(0)
    expect(listing.entries.some((entry) => entry.name === 'events.jsonl')).toBe(false)
    expect(listing.entries.some((entry) => entry.name === 'facts.json')).toBe(false)
    expect(listing.entries.some((entry) => entry.name === '.cache')).toBe(false)
  })

  it('子目录：路径/父目录正确，递归可见角色写的产物', async () => {
    const { root } = await setup()
    const draft = await listGroupFiles(root, 't1', '交付稿')
    expect(draft.path).toBe('交付稿')
    expect(draft.parent).toBe('')
    expect(draft.entries.map((entry) => entry.name)).toEqual(['草稿', '说明.md'])

    const nested = await listGroupFiles(root, 't1', '交付稿\\草稿')
    expect(nested.path).toBe('交付稿/草稿')
    expect(nested.parent).toBe('交付稿')
    expect(nested.entries.map((entry) => entry.name)).toEqual(['v1.txt'])

    const attachments = await listGroupFiles(root, 't1', 'attachments')
    expect(attachments.entries[0]).toMatchObject({ name: 'shot.png', kind: 'file', mediaType: 'image/png' })
  })

  it('读文本/图片：内容与 mediaType 正确', async () => {
    const { root } = await setup()
    const text = await readGroupFile(root, 't1', '本轮汇总.md')
    expect(text.name).toBe('本轮汇总.md')
    expect(text.mediaType).toBe('text/plain')
    expect(text.bytes.toString('utf8')).toContain('结论：可以上。')

    const image = await readGroupFile(root, 't1', 'attachments/shot.png')
    expect(image.mediaType).toBe('image/png')
    expect(image.bytes.length).toBe(10)
  })

  it('群目录不存在：exists=false（空态，不报错）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-files-empty-'))
    const listing = await listGroupFiles(root, 't_missing')
    expect(listing.exists).toBe(false)
    expect(listing.entries).toEqual([])
    await expect(readGroupFile(root, 't_missing', 'a.md')).rejects.toMatchObject({ status: 404 })
  })

  it('路径围栏：拒绝绝对路径 / .. / 隐藏文件 / 内部账本 / 目录穿越', async () => {
    const { root } = await setup()
    for (const bad of ['../state.json', '交付稿/../../events.jsonl', '/etc/passwd', 'C:\\Windows\\win.ini', '.cache/checks/run.log', 'events.jsonl', 'facts.json']) {
      await expect(listGroupFiles(root, 't1', bad)).rejects.toMatchObject({ status: 400 })
    }
    for (const bad of ['../state.json', '.cache/checks/run.log', 'events.jsonl', '']) {
      await expect(readGroupFile(root, 't1', bad)).rejects.toMatchObject({ status: 400 })
    }
    // 非法 threadId 同样拒绝（不拼进路径）。
    await expect(listGroupFiles(root, '../evil')).rejects.toThrow(/threadId/)
  })

  it('目录条目超过上限时截断并标记（不静默）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-files-many-'))
    const dir = groupDir(root, 't_big')
    await mkdir(dir, { recursive: true })
    await Promise.all(Array.from({ length: 510 }, (_, index) =>
      writeFile(join(dir, `f-${String(index).padStart(4, '0')}.txt`), 'x', 'utf8')))
    const listing = await listGroupFiles(root, 't_big')
    expect(listing.entries).toHaveLength(500)
    expect(listing.truncated).toBe(true)
  })
})
