/**
 * 回收站存储（host 侧）：`<数据根>/.dsh-im/trash/`。
 *
 * 布局（一个回收站条目一个目录，**manifest 就是唯一真源**，不再维护 index.json）：
 * ```
 * .dsh-im/trash/<trashId>/
 *   manifest.json          { version, meta, payload, replaceOnRestore }
 *   data/<threadId>/...    被删/被清空会话的数据目录（events/facts/attachments/产物）
 * ```
 * 为什么不用 index：条目数很少（一个用户手动删除的量级），扫目录读 manifest 足够快，
 * 少一个会跟目录不同步的索引文件；manifest 写入仍是原子写，读到半截 JSON 的概率可忽略，
 * 万一真的坏了就 **跳过并记日志**（不把整页回收站弄崩，但也不静默当它不存在）。
 *
 * 恢复是「先搬目录、再删条目」；搬一半失败会把已搬的移回去（不留下半恢复状态）。
 * 清空聊天记录用 `replaceOnRestore=true`：清空后 saveState 会重建一个空目录，恢复时要覆盖它。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { assertSafeThreadId } from '../core/workspace.ts'
import { TRASH_KINDS, type TrashEntryMeta, type TrashKind, type TrashPayload } from '../core/trash.ts'
import { logWarn } from '../core/log.ts'
import { groupDir } from './event-store.ts'
import { writeFileAtomic } from './fs-atomic.ts'

const TRASH_ID_PATTERN = /^tr_[0-9a-z]{6,40}$/
const MAX_LABEL = 120
const MAX_DETAIL = 240

interface TrashManifest {
  version: 1
  meta: TrashEntryMeta
  payload: TrashPayload
  /** 恢复时允许覆盖已存在的数据目录（仅「清空聊天记录」条目）。 */
  replaceOnRestore: boolean
}

export interface TrashAddInput {
  kind: TrashKind
  label?: string
  detail?: string
  threadIds?: string[]
  payload?: TrashPayload
  replaceOnRestore?: boolean
}

function error400(message: string): Error {
  return Object.assign(new Error(message), { status: 400 })
}

function error404(message: string): Error {
  return Object.assign(new Error(message), { status: 404 })
}

function error409(message: string): Error {
  return Object.assign(new Error(message), { status: 409 })
}

/** 同一个数据根的回收站操作串行：并发删除/恢复不会互相搬同一个目录。 */
const chains = new Map<string, Promise<unknown>>()

function queueKey(root: string): string {
  const normalized = root.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function serialized<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = queueKey(root)
  const previous = chains.get(key) ?? Promise.resolve()
  const next = previous.then(run, run)
  chains.set(key, next.then(() => undefined, () => undefined))
  return next
}

export function trashRoot(root: string): string {
  return join(root, '.dsh-im', 'trash')
}

export function assertSafeTrashId(id: string): void {
  if (!TRASH_ID_PATTERN.test(id)) throw error400('denied: invalid trash id')
}

export function entryDir(root: string, id: string): string {
  assertSafeTrashId(id)
  return join(trashRoot(root), id)
}

function manifestPath(root: string, id: string): string {
  return join(entryDir(root, id), 'manifest.json')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function sumDirSize(dir: string): Promise<number> {
  let total = 0
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await sumDirSize(full)
      continue
    }
    try {
      total += (await stat(full)).size
    } catch {
      // 单个文件 stat 失败不影响整体报告（bytes 是展示用，不是安全边界）。
    }
  }
  return total
}

function clip(text: string | undefined, limit: number): string {
  const value = (text ?? '').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readManifest(root: string, id: string): Promise<TrashManifest> {
  let raw: string
  try {
    raw = await readFile(manifestPath(root, id), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error404('回收站里没有这条记录（可能已被彻底删除或已恢复）')
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('回收站记录损坏（manifest.json 不是合法 JSON）'), { status: 500 })
  }
  if (!isRecord(parsed) || !isRecord(parsed.meta) || typeof parsed.meta.id !== 'string') {
    throw Object.assign(new Error('回收站记录损坏（缺少 meta 字段）'), { status: 500 })
  }
  const meta = parsed.meta as unknown as TrashEntryMeta
  return {
    version: 1,
    meta,
    payload: isRecord(parsed.payload) ? parsed.payload as TrashPayload : {},
    replaceOnRestore: parsed.replaceOnRestore === true,
  }
}

function validateInput(input: TrashAddInput): {
  kind: TrashKind
  threadIds: string[]
  payload: TrashPayload
  label: string
  detail: string
  replaceOnRestore: boolean
} {
  const kind = input.kind
  if (!TRASH_KINDS.includes(kind as TrashKind)) throw error400(`未知的回收站类型：${String(kind)}`)
  const threadIds = [...new Set(input.threadIds ?? [])]
  for (const threadId of threadIds) assertSafeThreadId(threadId)
  const payload = isRecord(input.payload) ? input.payload as TrashPayload : {}
  if (kind === 'persona') {
    if (!isRecord(payload.persona) || typeof payload.persona.id !== 'string') {
      throw error400('删除角色的回收站记录必须带 persona 快照')
    }
  } else if (!isRecord(payload.thread) || typeof payload.thread.id !== 'string') {
    throw error400('删除会话/清空记录的回收站记录必须带 thread 快照')
  }
  const fallbackLabel = kind === 'persona'
    ? String((payload.persona as { name?: unknown }).name ?? '角色')
    : String((payload.thread as { title?: unknown }).title ?? '会话')
  return {
    kind,
    threadIds,
    payload,
    label: clip(input.label ?? fallbackLabel, MAX_LABEL) || fallbackLabel,
    detail: clip(input.detail, MAX_DETAIL),
    replaceOnRestore: input.replaceOnRestore === true,
  }
}

/** 列出回收站（deletedAt 倒序）。坏条目跳过并写 warn 日志——不静默，也不整页崩。 */
export async function listTrash(root: string): Promise<TrashEntryMeta[]> {
  let names: string[]
  try {
    names = (await readdir(trashRoot(root), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && TRASH_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries: TrashEntryMeta[] = []
  for (const id of names) {
    try {
      const manifest = await readManifest(root, id)
      entries.push(manifest.meta)
    } catch (error) {
      logWarn('[dsh-im] 回收站条目读取失败，已跳过', { id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return entries.sort((left, right) => right.deletedAt - left.deletedAt)
}

/** 把会话数据目录移进回收站并写 manifest；任何一步失败都回滚，不留半份数据。 */
export function addTrashEntry(root: string, input: TrashAddInput): Promise<TrashEntryMeta> {
  return serialized(root, async () => {
    const { kind, threadIds, payload, label, detail, replaceOnRestore } = validateInput(input)
    const id = `tr_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const dir = entryDir(root, id)
    const dataDir = join(dir, 'data')
    await mkdir(dataDir, { recursive: true })

    const moved: { from: string; to: string }[] = []
    try {
      for (const threadId of threadIds) {
        const from = groupDir(root, threadId)
        if (!(await exists(from))) continue
        const to = join(dataDir, threadId)
        await rename(from, to)
        moved.push({ from, to })
      }
    } catch (error) {
      // 回滚已经搬走的目录，再把空条目删掉。
      for (const item of moved.reverse()) {
        await rename(item.to, item.from).catch(() => undefined)
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw Object.assign(new Error(`移入回收站失败：${error instanceof Error ? error.message : String(error)}`), { status: 500 })
    }

    const meta: TrashEntryMeta = {
      id,
      kind,
      label,
      detail,
      deletedAt: Date.now(),
      threadIds,
      bytes: await sumDirSize(dataDir),
      restorable: true,
    }
    const manifest: TrashManifest = { version: 1, meta, payload, replaceOnRestore }
    try {
      await writeFileAtomic(manifestPath(root, id), JSON.stringify(manifest, null, 2))
    } catch (error) {
      for (const item of moved.reverse()) {
        await rename(item.to, item.from).catch(() => undefined)
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return meta
  })
}

/**
 * 恢复一条回收站记录：数据目录搬回原位置 + 删掉回收站条目 + 返回快照。
 * 搬目录失败会回滚已搬的部分。
 */
export function restoreTrashEntry(root: string, id: string): Promise<{ meta: TrashEntryMeta; payload: TrashPayload }> {
  return serialized(root, async () => {
    assertSafeTrashId(id)
    const manifest = await readManifest(root, id)
    const dataDir = join(entryDir(root, id), 'data')
    const moved: { from: string; to: string }[] = []
    try {
      for (const threadId of manifest.meta.threadIds) {
        const from = join(dataDir, threadId)
        if (!(await exists(from))) continue
        const to = groupDir(root, threadId)
        if (await exists(to)) {
          if (!manifest.replaceOnRestore) {
            throw error409(`会话数据目录已经存在，不能直接恢复：${threadId}（可先删除这个会话再恢复）`)
          }
          await rm(to, { recursive: true, force: true })
        }
        await rename(from, to)
        moved.push({ from, to })
      }
    } catch (error) {
      for (const item of moved.reverse()) {
        await rename(item.to, item.from).catch(() => undefined)
      }
      throw error
    }
    await rm(entryDir(root, id), { recursive: true, force: true }).catch((error: unknown) => {
      logWarn('[dsh-im] 恢复后清理回收站条目失败（数据已恢复）', {
        id,
        reason: error instanceof Error ? error.message : String(error),
      })
    })
    return { meta: manifest.meta, payload: manifest.payload }
  })
}

/**
 * 彻底删除：给 id 删一条；不传 id 清空回收站。
 * 单条删除失败会记进 failed（不吞），清空时只处理回收站目录下的合法条目。
 */
export function purgeTrash(root: string, id?: string): Promise<{ purged: number; failed: string[] }> {
  return serialized(root, async () => {
    if (id) {
      assertSafeTrashId(id)
      await rm(entryDir(root, id), { recursive: true, force: true })
      return { purged: 1, failed: [] }
    }
    let names: string[]
    try {
      names = (await readdir(trashRoot(root), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && TRASH_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { purged: 0, failed: [] }
      throw error
    }
    let purged = 0
    const failed: string[] = []
    for (const name of names) {
      try {
        await rm(join(trashRoot(root), name), { recursive: true, force: true })
        purged += 1
      } catch {
        failed.push(name)
      }
    }
    return { purged, failed }
  })
}
