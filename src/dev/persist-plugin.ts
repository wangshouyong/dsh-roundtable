import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { createPreviewLlm } from './fake-llm.ts'
import { createImApi } from '../host/im-api.ts'
import { toolGroupCatalog } from '../core/tools.ts'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = typeof body === 'string' ? body : JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(json)
}

/** 仅 `npm run dev`：用内存假模型跑界面，不连网关、不读密钥。正式插件只走 DSH 的 `ctx.llm`。 */
export function imPersistPlugin(projectRoot = process.env.DSH_IM_DEV_ROOT ?? process.cwd()): Plugin {
  const previewLlm = createPreviewLlm()
  // dev 预览没有宿主 tools 服务：给一份样例来源组，让角色编辑器的“组可展开/单工具勾选”可测。
  const toolCatalog = toolGroupCatalog([
    'bcdp_help',
    'bcdp_status',
    'bcdp_snapshot',
    'mcp__magpie-image__generate_image',
    'mcp__demo__ping',
    'send_message',
  ])
  const api = createImApi({
    projectRoot: () => projectRoot,
    llm: () => previewLlm,
    toolGroups: () => toolCatalog,
    // dev 预览让 `?root=` 指定的绝对路径也能通过回收站/状态接口的根白名单。
    workspaces: () => [{ path: projectRoot }],
  })
  return {
    name: 'im-persist',
    configureServer(server) {
      const route = async (
        req: IncomingMessage,
        res: ServerResponse,
        next: () => void,
        run: () => Promise<void>,
      ) => {
        try {
          await run()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const status = (err as { status?: number }).status ?? 500
          send(res, status, { error: message })
        }
      }
      server.middlewares.use('/api/im/state', (req, res, next) => route(req, res, next, async () => {
        if (req.method === 'GET') {
          const state = await api.getState()
          if (!state) {
            send(res, 404, { error: 'empty' })
            return
          }
          send(res, 200, state)
          return
        }
        if (req.method === 'PUT') {
          send(res, 200, await api.putState(await readBody(req)))
          return
        }
        next()
      }))
      server.middlewares.use('/api/im/models', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'GET') {
          next()
          return
        }
        send(res, 200, await api.models())
      }))
      server.middlewares.use('/api/im/complete', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'POST') {
          next()
          return
        }
        send(res, 200, await api.complete(JSON.parse(await readBody(req))))
      }))
      server.middlewares.use('/api/im/file', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'POST') {
          next()
          return
        }
        send(res, 200, await api.writeFile(JSON.parse(await readBody(req))))
      }))
      server.middlewares.use('/api/im/workspace', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'GET') {
          next()
          return
        }
        send(res, 200, api.workspace())
      }))
      // 与宿主一致：动态工具目录 + 原生状态（dev 没有 ctx.agents，native-status=false）。
      server.middlewares.use('/api/im/tool-groups', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'GET') {
          next()
          return
        }
        send(res, 200, api.toolGroups())
      }))
      server.middlewares.use('/api/im/native-status', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'GET') {
          next()
          return
        }
        // dev 预览没有 ctx.agents：直接给出准确原因，别复用宿主的“开关关闭”文案。
        send(res, 200, { enabled: false, reason: 'dev 预览没有 ctx.agents，原生会话不可用（走内存假模型）' })
      }))
      server.middlewares.use('/api/im/preflight', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'POST') {
          next()
          return
        }
        send(res, 200, await api.preflight(JSON.parse(await readBody(req))))
      }))
      // 回收站（dev 预览与真实宿主同一套实现，只是没有 ctx.agents，native-forget 直接返回 0）。
      server.middlewares.use('/api/im/trash/add', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'POST') {
          next()
          return
        }
        send(res, 200, await api.trashAdd(JSON.parse(await readBody(req))))
      }))
      server.middlewares.use('/api/im/trash/restore', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'POST') {
          next()
          return
        }
        send(res, 200, await api.trashRestore(JSON.parse(await readBody(req))))
      }))
      server.middlewares.use('/api/im/trash/purge', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'POST') {
          next()
          return
        }
        send(res, 200, await api.trashPurge(JSON.parse(await readBody(req))))
      }))
      server.middlewares.use('/api/im/trash', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'GET') {
          next()
          return
        }
        // 挂载点后面的 query 仍在 req.url 上；路径已由挂载前缀吃掉。
        send(res, 200, await api.trashList())
      }))
      server.middlewares.use('/api/im/native-forget', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'POST') {
          next()
          return
        }
        const body = JSON.parse(await readBody(req)) as { personaId?: string; threadId?: string }
        if (!body.personaId?.trim() && !body.threadId?.trim()) {
          send(res, 400, { error: 'personaId 或 threadId 必填' })
          return
        }
        // dev 没有原生会话：如实返回 0（客户端 fire-and-forget，不挡删除流程）。
        send(res, 200, { disposed: 0 })
      }))
      // 群工作区文件（只读）：与真实宿主同一套 host 实现。
      server.middlewares.use('/api/im/group-files', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'GET') {
          next()
          return
        }
        const query = new URL(req.url ?? '/', 'http://local').searchParams
        send(res, 200, await api.groupFiles({
          threadId: query.get('threadId') ?? undefined,
          path: query.get('path') ?? undefined,
        }))
      }))
      server.middlewares.use('/api/im/group-file', (req, res, next) => route(req, res, next, async () => {
        if (req.method !== 'GET') {
          next()
          return
        }
        const query = new URL(req.url ?? '/', 'http://local').searchParams
        const file = await api.groupFile({
          threadId: query.get('threadId') ?? undefined,
          path: query.get('path') ?? undefined,
        })
        res.statusCode = 200
        res.setHeader('content-type', file.mediaType)
        res.setHeader('content-length', String(file.bytes.byteLength))
        res.setHeader('cache-control', 'no-store')
        res.end(file.bytes)
      }))
    },
  }
}
