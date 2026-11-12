import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { createImApi, type DshAttachmentStore } from './im-api.ts'
import type { LlmService } from './dsh-llm.ts'
import {
  createNativeRuntime,
  nativeTtlMs,
  type HostToolsProbe,
  type NativeAgentsApi,
  type NativeWorkspaceApi,
} from './agent-session.ts'
import { BUILTIN_TOOL_GROUPS, schemaToolNames, toolGroupCatalog, type ToolGroupCatalog, type ToolGroupDecl } from '../core/tools.ts'
import { setLogSink } from '../core/log.ts'

export const name = 'dsh-im'
export const inject = ['llm', 'agents', 'workspaceRegistry', 'attachments']

type DshCtx = {
  inject?: (deps: string[], fn: (sub: DshCtx) => void) => void
  effect?: (fn: () => (() => void) | void, label?: string) => void
  get?: (name: string) => unknown
  workspaceRegistry?: {
    list?: () => { id?: string; path?: string; title?: string }[]
    get?: (id: string) => { path?: string; title?: string } | undefined
    create?: (path: string, title?: string) => Promise<{ id?: string; path?: string; title?: string } | undefined> | { id?: string; path?: string; title?: string } | undefined
    archiveSession?: (sessionId: string, options?: { stopActivity?: boolean }) => Promise<unknown>
  }
  agents?: NativeAgentsApi
  webServer?: {
    register: (row: {
      kind: string
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
    }) => () => void
  }
  webRuntime?: { trustedHosts?: string[] }
  logger?: { info?: (m: string) => void; warn?: (m: string) => void }
  llm?: LlmService
  /** DSH 附件存储（宿主可能没挂载；没挂载时图片只存本地、模型看不到内容）。 */
  attachments?: DshAttachmentStore
  /** 宿主 tools 服务（能力探测用；agent 作用域才可执行，这里只读方法形状）。 */
  tools?: HostToolsProbe
  /** 可选的「用过的数据根」记忆文件路径（默认 ~/.dsh-im/known-roots.json）。 */
  rootsFile?: string
}

const MAX_BODY = 2 * 1024 * 1024
const MAX_UPLOAD_BODY = 25 * 1024 * 1024
/**
 * 回收站写入要带一份完整会话快照（消息 + 附件元数据），比普通 state 上限放宽。
 * 仍是同源本地请求；上限存在的意义是挡住异常大包，不是权限边界。
 */
const MAX_TRASH_BODY = 8 * 1024 * 1024

function readBodyLimited(req: IncomingMessage, limit: number, tooLarge: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error(tooLarge), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return readBodyLimited(req, MAX_BODY, 'request body too large')
}

function readTrashBody(req: IncomingMessage): Promise<string> {
  return readBodyLimited(req, MAX_TRASH_BODY, '回收站快照太大')
}

/** 附件上传专用：原始字节，上限 25MB。 */
function readRawBody(req: IncomingMessage, limit = MAX_UPLOAD_BODY): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('附件太大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = typeof body === 'string' ? body : JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(json)
}

function workspacePath(ctx: DshCtx): string {
  try {
    const list = ctx.workspaceRegistry?.list?.() ?? []
    const first = list.find((w) => w.path)?.path
    if (first) return first
  } catch {
    // 没有工作区时落到进程 cwd。
  }
  return process.cwd()
}

/** 宿主可能没挂载附件服务：先按 Cordis 服务取，再退回字段；都没有就返回 undefined。 */
function dshAttachmentStore(ctx: DshCtx): DshAttachmentStore | undefined {
  try {
    const fromService = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
    if (fromService) return fromService as DshAttachmentStore
  } catch {
    // 没有该服务时 get 可能抛错，忽略。
  }
  return ctx.attachments
}

/** DSH 原生工作区列表（给“关联工作区”下拉用；新工作区在 DSH 里添加后刷新面板即可）。 */
export function workspaceOptions(ctx: DshCtx): { title: string; path: string }[] {
  try {
    const list = ctx.workspaceRegistry?.list?.() ?? []
    return list
      .filter((item): item is { path: string; title?: string } => Boolean(item.path))
      .map((item) => ({ title: item.title?.trim() || item.path, path: item.path }))
  } catch {
    return []
  }
}

/**
 * 通过 DSH 注册表创建工作区。
 * 必须保留 `this`（DSH 的 create 内部会用到 this.enqueueOperation 等），
 * 所以不能把 create 拆出来单独调用——否则报 `Cannot read properties of undefined (reading 'enqueueOperation')`。
 */
export function createWorkspaceViaRegistry(
  registry: {
    create?: (path: string, title?: string) => Promise<{ id?: string; path?: string; title?: string } | undefined> | { id?: string; path?: string; title?: string } | undefined
  } | undefined,
  path: string,
  title?: string,
): Promise<{ id?: string; path?: string; title?: string } | undefined> | { id?: string; path?: string; title?: string } | undefined {
  if (!registry?.create) throw Object.assign(new Error('当前 DSH 不支持从插件创建工作区'), { status: 400 })
  return registry.create.call(registry, path, title)
}
/** 文件夹浏览器：只列目录（不读文件内容），用于“添加工作区…”选文件夹。 */
export async function browseFolders(rawPath?: string): Promise<{
  path: string
  parent: string
  entries: { name: string; path: string }[]
}> {
  const target = (rawPath ?? '').trim()
  if (!target) {
    if (process.platform !== 'win32') {
      const entries = await listDirs('/')
      return { path: '/', parent: '', entries }
    }
    const entries: { name: string; path: string }[] = []
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`
      if (existsSync(root)) entries.push({ name: root, path: root })
    }
    return { path: '', parent: '', entries }
  }
  if (!isAbsolute(target)) throw Object.assign(new Error('必须是绝对路径'), { status: 400 })
  const entries = await listDirs(target)
  const root = parse(target).root
  const parent = target === root ? '' : dirname(target)
  return { path: target, parent, entries }
}

async function listDirs(path: string): Promise<{ name: string; path: string }[]> {
  const rows = await readdir(path, { withFileTypes: true })
  return rows
    .filter((row) => row.isDirectory())
    .map((row) => ({ name: row.name, path: join(path, row.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

function mountImRoutes(
  wctx: DshCtx,
  host: DshCtx,
  native: { bridge?: import('./agent-session.ts').NativeBridge },
  tooling: {
    probe: () => HostToolsProbe | undefined
    catalog: () => ToolGroupCatalog
  },
) {
  const api = createImApi({
    projectRoot: () => workspacePath(host),
    llm: () => host.llm,
    attachments: () => dshAttachmentStore(host),
    native: () => native.bridge,
    workspaces: () => workspaceOptions(host),
    hostTools: tooling.probe,
    toolGroups: tooling.catalog,
    rootsFile: () => host.rootsFile,
  })
  // 预热「用过的数据根」白名单：挂载后首个请求就能认回 DSH 注册表外的历史数据根。
  void api.loadKnownRoots()
  const logger = host.logger ?? wctx.logger
  // 插件自己的日志统一走 core/log.ts：宿主有 logger 时跟着宿主走，不再直接打 console。
  if (logger) {
    setLogSink({
      info: (message) => logger.info?.(message),
      warn: (message, detail) => logger.warn?.(
        detail === undefined ? message : `${message} ${typeof detail === 'string' ? detail : String(detail)}`,
      ),
      debug: (message) => logger.info?.(message),
    })
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // 防跨站：只接受同源页面发起的请求。
    const origin = req.headers.origin
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) {
          send(res, 403, { error: 'forbidden origin' })
          return
        }
      } catch {
        send(res, 403, { error: 'forbidden origin' })
        return
      }
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/$/, '') || '/'
    try {
      if (path.endsWith('/state') && req.method === 'GET') {
        // 状态跟随“当前面板/活动工作区”：客户端带 ?projectRoot= 时读写那个工作区的 .dsh-im。
        const state = await api.getState(url.searchParams.get('projectRoot') ?? undefined)
        if (!state) {
          send(res, 404, { error: 'empty' })
          return
        }
        send(res, 200, state)
        return
      }
      if (path.endsWith('/state') && req.method === 'PUT') {
        send(res, 200, await api.putState(
          await readBody(req),
          url.searchParams.get('projectRoot') ?? undefined,
        ))
        return
      }
      if (path.endsWith('/models') && req.method === 'GET') {
        send(res, 200, await api.models())
        return
      }
      // ── 回收站（软删除） ────────────────────────────────────────────────
      if (path.endsWith('/trash') && req.method === 'GET') {
        send(res, 200, await api.trashList(url.searchParams.get('projectRoot') ?? undefined))
        return
      }
      if (path.endsWith('/trash/add') && req.method === 'POST') {
        send(res, 200, await api.trashAdd(JSON.parse(await readTrashBody(req))))
        return
      }
      if (path.endsWith('/trash/restore') && req.method === 'POST') {
        send(res, 200, await api.trashRestore(JSON.parse(await readBody(req))))
        return
      }
      if (path.endsWith('/trash/purge') && req.method === 'POST') {
        send(res, 200, await api.trashPurge(JSON.parse(await readBody(req))))
        return
      }
      // 删除/清空后释放对应的原生会话（被删历史不能继续留在宿主内存里）。
      if (path.endsWith('/native-forget') && req.method === 'POST') {
        send(res, 200, await api.nativeForget(JSON.parse(await readBody(req))))
        return
      }
      // 群工作区文件（只读）：列表 + 原始文件字节（面板「文件」Tab 用）。
      if (path.endsWith('/group-files') && req.method === 'GET') {
        send(res, 200, await api.groupFiles({
          threadId: url.searchParams.get('threadId') ?? undefined,
          projectRoot: url.searchParams.get('projectRoot') ?? undefined,
          path: url.searchParams.get('path') ?? undefined,
        }))
        return
      }
      if (path.endsWith('/group-file') && req.method === 'GET') {
        const file = await api.groupFile({
          threadId: url.searchParams.get('threadId') ?? undefined,
          projectRoot: url.searchParams.get('projectRoot') ?? undefined,
          path: url.searchParams.get('path') ?? undefined,
        })
        res.writeHead(200, {
          'content-type': file.mediaType,
          'content-length': String(file.bytes.byteLength),
          'cache-control': 'no-store',
        })
        res.end(file.bytes)
        return
      }
      // 数据根体检（只读）：面板据此在加载失败时列出「哪个根里还有数据」。
      if (path.endsWith('/roots') && req.method === 'GET') {
        send(res, 200, await api.stateRoots())
        return
      }

      if (path.endsWith('/preflight') && req.method === 'POST') {
        send(res, 200, await api.preflight(JSON.parse(await readBody(req))))
        return
      }
      // 注意：/native-complete 要排在 /complete 之前（endsWith 会命中）。
      if (path.endsWith('/llm-probe') && req.method === 'POST') {
        send(res, 200, await api.llmProbe(JSON.parse(await readBody(req))))
        return
      }
      if (path.endsWith('/native-complete') && req.method === 'POST') {
        send(res, 200, await api.nativeComplete(JSON.parse(await readBody(req))))
        return
      }
      if (path.endsWith('/native-status') && req.method === 'GET') {
        send(res, 200, api.nativeStatus())
        return
      }
      if (path.endsWith('/tool-groups') && req.method === 'GET') {
        send(res, 200, api.toolGroups())
        return
      }
      if (path.endsWith('/native-debug') && req.method === 'GET') {
        send(res, 200, api.nativeDebug())
        return
      }
      // Phase 0：宿主能力探测（tokenizer / usage / embeddings），只读。
      if (path.endsWith('/capabilities') && req.method === 'GET') {
        send(res, 200, api.capabilities())
        return
      }
      // Phase 1b：chars/token 校准（面板启动读取，用于 token 预算换算）。
      if (path.endsWith('/calibration') && req.method === 'GET') {
        send(res, 200, await api.tokenCalibration(url.searchParams.get('projectRoot') ?? undefined))
        return
      }
      // Phase 0：记忆索引预览（默认不落盘），用于验证派生索引与弱状态。
      if (path.endsWith('/memory-index') && req.method === 'GET') {
        send(res, 200, await api.memoryIndex({
          threadId: url.searchParams.get('threadId') ?? undefined,
          projectRoot: url.searchParams.get('projectRoot') ?? undefined,
          persist: url.searchParams.get('persist') === '1',
        }))
        return
      }
      if (path.endsWith('/complete') && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        send(res, 200, await api.complete(body))
        return
      }
      if (path.endsWith('/file') && req.method === 'POST') {
        send(res, 200, await api.writeFile(JSON.parse(await readBody(req))))
        return
      }
      if (path.endsWith('/workspaces') && req.method === 'GET') {
        send(res, 200, workspaceOptions(host))
        return
      }
      if (path.endsWith('/workspaces') && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { path?: string; title?: string }
        const target = (body.path ?? '').trim()
        if (!target || !isAbsolute(target)) {
          throw Object.assign(new Error('path 必须是绝对路径'), { status: 400 })
        }
        if (!host.workspaceRegistry?.create) {
          throw Object.assign(new Error('当前 DSH 不支持从插件创建工作区'), { status: 400 })
        }
        const created = await createWorkspaceViaRegistry(host.workspaceRegistry, target, body.title?.trim() || undefined)
        send(res, 200, { workspaces: workspaceOptions(host), path: created?.path ?? target })
        return
      }
      if (path.endsWith('/upload') && req.method === 'POST') {
        const bytes = await readRawBody(req)
        send(res, 200, await api.uploadAttachment({
          threadId: url.searchParams.get('threadId') ?? undefined,
          projectRoot: url.searchParams.get('projectRoot') ?? undefined,
          name: url.searchParams.get('name') ?? undefined,
          mediaType: url.searchParams.get('mediaType') ?? undefined,
          data: bytes,
        }))
        return
      }
      if (path.endsWith('/attachment-gc') && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        send(res, 200, await api.attachmentGc(body))
        return
      }
      if (path.endsWith('/attachment') && req.method === 'GET') {
        const file = await api.attachmentFile({
          threadId: url.searchParams.get('threadId') ?? undefined,
          file: url.searchParams.get('file') ?? undefined,
          projectRoot: url.searchParams.get('projectRoot') ?? undefined,
        })
        res.writeHead(200, {
          'content-type': file.mediaType,
          'content-length': String(file.bytes.byteLength),
          'cache-control': 'private, max-age=31536000, immutable',
        })
        res.end(file.bytes)
        return
      }
      if (path.endsWith('/fs') && req.method === 'GET') {
        send(res, 200, await browseFolders(url.searchParams.get('path') ?? undefined))
        return
      }
      if (path.endsWith('/workspace') && req.method === 'GET') {
        send(res, 200, await api.workspace(url.searchParams.get('projectRoot') ?? undefined))
        return
      }
      send(res, 404, { error: 'not found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = (err as { status?: number }).status ?? 500
      send(res, status, { error: message })
    }
  }

  const dispose = wctx.webServer?.register({
    kind: 'prefix',
    path: '/api/im',
    handler,
  })
  logger?.info?.('[dsh-im] /api/im mounted; models and calls go through ctx.llm')
  return () => dispose?.()
}

/** dsh-im 插件配置。目前只有工具来源组声明（追加/覆盖出厂声明）。 */
export interface DshImConfig {
  toolGroups?: ToolGroupDecl[]
}

/** 配置声明只做形状校验：非法项直接报错，不静默吞掉。 */
export function resolveConfiguredToolGroups(config?: DshImConfig): ToolGroupDecl[] {
  const raw = config?.toolGroups
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('dsh-im config.toolGroups 必须是数组')
  return raw.map((item, index) => {
    const at = `dsh-im config.toolGroups[${index}]`
    if (!item || typeof item !== 'object') throw new Error(`${at} 必须是对象`)
    const id = (item as ToolGroupDecl).id
    const label = (item as ToolGroupDecl).label
    if (typeof id !== 'string' || !id.trim()) throw new Error(`${at}.id 必须是非空字符串`)
    if (typeof label !== 'string' || !label.trim()) throw new Error(`${at}.label 必须是非空字符串`)
    if ((BUILTIN_TOOL_GROUPS as ToolGroupDecl[]).some((builtin) => builtin.id === id)) {
      throw new Error(`${at}.id "${id}" 与出厂来源组重名`)
    }
    const match = (item as ToolGroupDecl).match
    if (match !== undefined) {
      if (!match || typeof match !== 'object') throw new Error(`${at}.match 必须是对象`)
      for (const key of ['names', 'prefixes', 'mcpServers'] as const) {
        const value = match[key]
        if (value === undefined) continue
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
          throw new Error(`${at}.match.${key} 必须是非空字符串数组`)
        }
      }
    }
    return { id: id.trim(), label: label.trim(), ...(match ? { match: { ...match } } : {}) }
  })
}

/** 宿主 tools 服务探测（只读形状）。 */
function hostToolsProbe(ctx: DshCtx): HostToolsProbe | undefined {
  try {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
    return tools as HostToolsProbe | undefined
  } catch {
    return undefined
  }
}

/** 宿主全局（host-plane）工具名；来源组发现与会话重建判定共用。 */
function hostPlaneToolNames(probe: () => HostToolsProbe | undefined): string[] {
  try {
    const tools = probe()
    if (!tools || typeof tools.schemas !== 'function') return []
    return schemaToolNames((tools.schemas as () => unknown)())
  } catch {
    return []
  }
}

export function apply(ctx: DshCtx, config?: DshImConfig): void {
  ctx.effect?.(() => {
    let disposeWeb: (() => void) | undefined
    const configuredGroups = resolveConfiguredToolGroups(config)
    const declaredGroups: ToolGroupDecl[] = [...BUILTIN_TOOL_GROUPS, ...configuredGroups]
    const host: DshCtx = {
      get llm() {
        return ctx.llm ?? (typeof ctx.get === 'function' ? ctx.get('llm') as LlmService : undefined)
      },
      get workspaceRegistry() {
        return ctx.workspaceRegistry
      },
      get agents() {
        // 可选依赖：优先 ctx.get（Cordis 允许未 inject 的服务这样取），再退回属性。
        try {
          const fromGet = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
          if (fromGet) return fromGet as NativeAgentsApi
        } catch {
          // 没有该服务。
        }
        return (ctx as DshCtx & { agents?: NativeAgentsApi }).agents
      },
      get tools() {
        return hostToolsProbe(ctx)
      },
      logger: ctx.logger,
    }
    try {
      const got = typeof ctx.get === 'function' ? ctx.get('attachments') : ctx.attachments
      const saveImagesType = got == null ? 'undefined' : typeof (got as { saveImages?: unknown }).saveImages
      ctx.logger?.warn?.(`[dsh-im] attachments typeof=${got == null ? 'undefined' : typeof got} typeofSaveImages=${saveImagesType}`)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-im] attachments get failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const native = createNativeRuntime({
      // 默认挂上。DSH_IM_NATIVE_SESSION=0 才整段关掉，给排查用。开不开由面板开关决定。
      enabled: process.env.DSH_IM_NATIVE_SESSION !== '0',
      ttlMs: nativeTtlMs(),
      agents: () => host.agents,
      workspace: () => host.workspaceRegistry as NativeWorkspaceApi | undefined,
      logger: ctx.logger,
      hostTools: () => hostToolsProbe(ctx),
      toolGroups: configuredGroups,
    })
    const tooling = {
      probe: () => hostToolsProbe(ctx),
      catalog: () => toolGroupCatalog(hostPlaneToolNames(() => hostToolsProbe(ctx)), declaredGroups),
    }
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['workspaceRegistry'], (reg) => {
          Object.defineProperty(host, 'workspaceRegistry', {
            configurable: true,
            get: () => reg.workspaceRegistry ?? ctx.workspaceRegistry,
          })
        })
      } catch {
        // 没有工作区注册表时用进程 cwd。
      }
      try {
        ctx.inject(['webServer', 'webRuntime'], (wctx) => {
          disposeWeb = mountImRoutes(wctx, host, native, tooling)
        })
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-im] web UI not mounted: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return () => {
      disposeWeb?.()
      void native.disposeAll()
    }
  }, 'dsh-im web')
}
