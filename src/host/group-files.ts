/**
 * 群工作区文件浏览（面板右栏「文件」Tab / 会话文件弹窗）。
 *
 * 群工作区 = `<数据根>/.dsh-im/groups/<threadId>/`（群数据与群产物同目录，
 * 不另建"产物区"）。角色 `write_file`、`先汇总`、用户附件、`run_check` 日志都落在里面。
 *
 * 这里只做**只读**：
 * - 路径围栏：只允许 threadId 目录内的相对路径，拒绝绝对路径 / `..` / 隐藏文件（`.cache` 等）；
 * - 内部账本（events/facts/metrics/receipts/sync/lease/index/watch）不是"群文件"，不展示、也不允许读；
 * - 单文件读取上限 50MB（面板预览另有文本截断），列表最多 500 条（超出直接截断并在 where 里说明）。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { assertSafeThreadId } from '../core/workspace.ts'
import { groupDir } from './event-store.ts'
import { mediaTypeFor } from './media-type.ts'

/** 群目录里的内部账本文件（仅顶层）：面板不展示，读接口也拒绝。 */
const INTERNAL_FILES = new Set([
  'events.jsonl',
  'facts.json',
  'metrics.jsonl',
  'receipts.jsonl',
  'sync.json',
  'lease.json',
  'index.json',
  'watch.json',
])

const MAX_ENTRIES = 500
const MAX_READ_BYTES = 50 * 1024 * 1024

export interface GroupFileEntry {
  name: string
  /** 相对群工作区的路径（'/'-分隔）。 */
  path: string
  kind: 'file' | 'dir'
  bytes?: number
  modifiedAt?: number
  mediaType?: string
}

export interface GroupFileListing {
  path: string
  parent: string
  entries: GroupFileEntry[]
  /** 群目录不存在时 exists=false（面板显示空态，不报错）。 */
  exists: boolean
  /** 目录条目超过上限时截断的提示。 */
  truncated?: boolean
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 })
}

/** 归一化并校验相对路径：返回以 '/' 分段的数组；空 = 群目录根。 */
function safeSegments(input: string | undefined): string[] {
  const raw = (input ?? '').replaceAll('\\', '/').trim()
  if (!raw || raw === '.') return []
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw badRequest('path 必须是群工作区内的相对路径')
  const segments = raw.split('/').filter((part) => part && part !== '.')
  if (segments.length === 0) return []
  for (const part of segments) {
    if (part === '..') throw badRequest('path 不能包含 ..')
    if (part.startsWith('.')) throw badRequest('不能访问隐藏文件/目录')
  }
  if (segments.length === 1 && INTERNAL_FILES.has(segments[0])) {
    throw badRequest('这是插件内部账本文件，不作为群文件展示')
  }
  return segments
}

function resolveInside(base: string, segments: string[]): string {
  const dir = resolve(base, ...segments)
  const root = resolve(base)
  if (dir !== root && !dir.startsWith(`${root}${sep}`)) throw badRequest('path 越出群工作区')
  return dir
}

/** 列目录（dirs 在前、同类按名称排）。 */
export async function listGroupFiles(
  root: string,
  threadId: string,
  rawPath = '',
): Promise<GroupFileListing> {
  assertSafeThreadId(threadId)
  const segments = safeSegments(rawPath)
  const base = groupDir(root, threadId)
  const dir = resolveInside(base, segments)
  const rel = segments.join('/')
  const parent = segments.length <= 1 ? '' : segments.slice(0, -1).join('/')

  let dirents: { name: string; isDirectory(): boolean; isFile(): boolean }[]
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: rel, parent, entries: [], exists: false }
    }
    throw error
  }

  const entries: GroupFileEntry[] = []
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue
    if (segments.length === 0 && INTERNAL_FILES.has(dirent.name)) continue
    const childPath = segments.length ? `${rel}/${dirent.name}` : dirent.name
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(resolve(dir, dirent.name))
    } catch {
      // 读目录时文件刚好被删/无权限：跳过这一条，不炸整个列表。
      continue
    }
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: childPath, kind: 'dir', modifiedAt: info.mtimeMs })
    } else if (dirent.isFile()) {
      entries.push({
        name: dirent.name,
        path: childPath,
        kind: 'file',
        bytes: info.size,
        modifiedAt: info.mtimeMs,
        mediaType: mediaTypeFor(dirent.name),
      })
    }
    if (entries.length >= MAX_ENTRIES) return { path: rel, parent, entries, exists: true, truncated: true }
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
    return left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true })
  })
  return { path: rel, parent, entries, exists: true }
}

/** 读一个群文件（只读、围栏同上）。 */
export async function readGroupFile(
  root: string,
  threadId: string,
  rawPath: string,
): Promise<{ bytes: Buffer; mediaType: string; name: string }> {
  assertSafeThreadId(threadId)
  const segments = safeSegments(rawPath)
  if (segments.length === 0) throw badRequest('path 必填（要读的文件路径）')
  const base = groupDir(root, threadId)
  const file = resolveInside(base, segments)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw Object.assign(new Error('文件不存在（可能已被删除或改名）'), { status: 404 })
    }
    throw error
  }
  if (!info.isFile()) throw badRequest('path 不是文件')
  if (info.size > MAX_READ_BYTES) {
    throw Object.assign(new Error(`文件太大（${Math.round(info.size / 1024 / 1024)}MB，上限 ${MAX_READ_BYTES / 1024 / 1024}MB）`), { status: 413 })
  }
  const name = segments[segments.length - 1]
  return { bytes: await readFile(file), mediaType: mediaTypeFor(name), name }
}
