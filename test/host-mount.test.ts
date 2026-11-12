import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/host/index.ts'

interface MountedRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => Promise<void> | void
}

function fakeLlm() {
  return {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
    async listModels() {
      return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
    },
    async *stream() {
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function fakeAgents() {
  return {
    async create() {
      return {
        agent: {
          followup() {},
          async whenIdle() {},
          session: { id: 's', deriveMessages: () => [{ role: 'assistant', content: 'hi' }] },
        },
        async dispose() {},
      }
    },
  }
}

function fakeTools() {
  return {
    register() {},
    guard() {},
    restrict() {},
    schemas() { return [] },
  }
}

function setupCtx(options: { agents?: boolean; forceOff?: boolean; root?: string }) {
  const routes: MountedRoute[] = []
  let dispose: (() => void) | undefined
  let archiveCalls = 0
  const ctx = {
    effect(fn: () => (() => void) | void) {
      dispose = fn() as (() => void) | undefined
    },
    inject(_deps: string[], fn: (sub: Record<string, unknown>) => void) {
      fn({
        workspaceRegistry: {
          archiveSession: async () => { archiveCalls += 1 },
          list: () => (options.root ? [{ path: options.root }] : []),
        },
        webServer: {
          register(row: MountedRoute) {
            routes.push(row)
            return () => undefined
          },
        },
        webRuntime: {},
      })
    },
    get(name: string) {
      if (name === 'llm') return fakeLlm()
      if (name === 'agents' && options.agents) return fakeAgents()
      if (name === 'tools') return fakeTools()
      return undefined
    },
    logger: { info() {}, warn() {} },
  }
  if (options.forceOff) process.env.DSH_IM_NATIVE_SESSION = '0'
  else delete process.env.DSH_IM_NATIVE_SESSION
  apply(ctx)
  return { routes, dispose: () => dispose?.(), archiveCalls: () => archiveCalls }
}

function fakeResponse() {
  const out = { status: 0, body: '', headers: {} as Record<string, string>, bytes: undefined as Uint8Array | undefined }
  return {
    set statusCode(value: number) { out.status = value },
    setHeader(name: string, value: unknown) { out.headers[name.toLowerCase()] = String(value) },
    writeHead(status: number, headers: Record<string, unknown>) {
      out.status = status
      for (const [name, value] of Object.entries(headers)) out.headers[name.toLowerCase()] = String(value)
    },
    end(body: string | Uint8Array) {
      if (typeof body === 'string') {
        out.body = body
      } else {
        out.bytes = body
        out.body = Buffer.from(body).toString('utf8')
      }
    },
    read: () => out,
  }
}

async function get(routes: MountedRoute[], url: string) {
  const route = routes[0]
  const res = fakeResponse()
  await route.handler({ url, method: 'GET', headers: { host: 'localhost' } }, res)
  return { status: res.read().status, body: JSON.parse(res.read().body) }
}

/** 假请求：readBody 依赖 data/end 事件；这里用微任务在同一 tick 内回放。 */
function fakeRequest(input: { url: string; method: string; body?: string; headers?: Record<string, string> }) {
  const listeners: Record<string, ((chunk?: unknown) => void)[]> = {}
  const req = {
    url: input.url,
    method: input.method,
    headers: { host: 'localhost', ...(input.headers ?? {}) },
    on(event: string, handler: (chunk?: unknown) => void) {
      ;(listeners[event] ??= []).push(handler)
      if (event === 'end') {
        queueMicrotask(() => {
          if (input.body !== undefined) for (const item of listeners.data ?? []) item(Buffer.from(input.body))
          for (const item of listeners.end ?? []) item()
        })
      }
      return req
    },
    destroy() {},
  }
  return req
}

async function call(routes: MountedRoute[], input: { url: string; method: string; body?: string }) {
  const res = fakeResponse()
  await routes[0].handler(fakeRequest(input), res)
  const text = res.read().body
  return { status: res.read().status, body: text ? JSON.parse(text) : null }
}

/** 原始字节路由（/group-file）：不 JSON.parse，返回 header 与文本。 */
async function callRaw(routes: MountedRoute[], input: { url: string; method: string }) {
  const res = fakeResponse()
  await routes[0].handler(fakeRequest(input), res)
  const out = res.read()
  return { status: out.status, headers: out.headers, body: out.body, bytes: out.bytes }
}

describe('host 挂载（/api/im 路由 + 原生 session 开关）', () => {
  it('默认有 agents 时 native-status 可用；DSH_IM_NATIVE_SESSION=0 整段关掉', async () => {
    const off = setupCtx({ forceOff: true, agents: true })
    const blocked = await get(off.routes, '/api/im/native-status')
    expect(blocked.body.reason).toContain('DSH_IM_NATIVE_SESSION=0')
    expect(blocked.body.enabled).toBe(false)

    const { routes } = setupCtx({})
    expect(routes[0].path).toBe('/api/im')
    const noAgents = await get(routes, '/api/im/native-status')
    expect(noAgents.body.enabled).toBe(false)
    expect(noAgents.body.reason).toContain('ctx.agents')
  })

  it('有 ctx.agents 且未强制关闭时 native-status=true；卸载会释放原生会话', async () => {
    const { routes, dispose } = setupCtx({ agents: true })
    const status = await get(routes, '/api/im/native-status')
    expect(status).toEqual({
      status: 200,
      body: {
        enabled: true,
        capabilities: { read: true, search: true, write: true, check: true },
        hostToolGroups: 0,
      },
    })
    expect(() => dispose()).not.toThrow()
    delete process.env.DSH_IM_NATIVE_SESSION
  })

  it('路由注册后 404 兜底与 403 跨站校验仍生效', async () => {
    const { routes } = setupCtx({})
    const route = routes[0]
    const forbidden = fakeResponse()
    await route.handler({ url: '/api/im/native-status', method: 'GET', headers: { host: 'a', origin: 'http://b' } }, forbidden)
    expect(forbidden.read().status).toBe(403)
    const missing = fakeResponse()
    await route.handler({ url: '/api/im/nope', method: 'GET', headers: { host: 'localhost' } }, missing)
    expect(missing.read().status).toBe(404)
  })

  it('/api/im/roots 是可用的只读数据根体检（当前根必在列表里）', async () => {
    const { routes } = setupCtx({})
    const res = await get(routes, '/api/im/roots')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThan(0)
    const current = res.body[0]
    expect(typeof current.path).toBe('string')
    expect(current.path.length).toBeGreaterThan(0)
    // 只读体检字段齐全：面板失败页要靠这些字段告诉用户「哪个根里还有数据」。
    for (const key of ['registered', 'hasState', 'personas', 'threads', 'messages']) {
      expect(current).toHaveProperty(key)
    }
  })

  it('回收站路由：GET 清单 / POST add→restore→purge / native-forget 参数校验', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-trash-route-'))
    await mkdir(join(root, '.dsh-im', 'groups', 't1'), { recursive: true })
    await writeFile(join(root, '.dsh-im', 'groups', 't1', 'events.jsonl'), '{"seq":1}\n')
    const { routes } = setupCtx({ root })
    const query = encodeURIComponent(root)

    const empty = await call(routes, { url: `/api/im/trash?projectRoot=${query}`, method: 'GET' })
    expect(empty.status).toBe(200)
    expect(empty.body.entries).toEqual([])

    const added = await call(routes, {
      url: '/api/im/trash/add',
      method: 'POST',
      body: JSON.stringify({
        projectRoot: root,
        kind: 'thread',
        label: '评审组',
        detail: '群 · 1 条消息',
        threadIds: ['t1'],
        payload: { thread: { id: 't1', title: '评审组' } },
      }),
    })
    expect(added.status).toBe(200)
    expect(added.body.entry).toMatchObject({ kind: 'thread', label: '评审组', threadIds: ['t1'] })

    const listed = await call(routes, { url: `/api/im/trash?projectRoot=${query}`, method: 'GET' })
    expect(listed.body.entries).toHaveLength(1)

    const restored = await call(routes, {
      url: '/api/im/trash/restore',
      method: 'POST',
      body: JSON.stringify({ projectRoot: root, id: added.body.entry.id }),
    })
    expect(restored.status).toBe(200)
    expect(restored.body.payload.thread.id).toBe('t1')

    const purged = await call(routes, {
      url: '/api/im/trash/purge',
      method: 'POST',
      body: JSON.stringify({ projectRoot: root }),
    })
    expect(purged.status).toBe(200)
    expect(purged.body).toEqual({ purged: 0, failed: [] })

    const rejected = await call(routes, {
      url: '/api/im/native-forget',
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(rejected.status).toBe(400)

    const withAgents = setupCtx({ root, agents: true })
    const forgotten = await call(withAgents.routes, {
      url: '/api/im/native-forget',
      method: 'POST',
      body: JSON.stringify({ threadId: 't1' }),
    })
    expect(forgotten.status).toBe(200)
    expect(forgotten.body).toEqual({ disposed: 0 })
    delete process.env.DSH_IM_NATIVE_SESSION
  })

  it('群文件路由：列目录（隐藏内部账本）/ 读原文 / 路径围栏 400', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-files-route-'))
    const dir = join(root, '.dsh-im', 'groups', 't1')
    await mkdir(join(dir, '交付稿'), { recursive: true })
    await writeFile(join(dir, 'events.jsonl'), '{"seq":1}\n')
    await writeFile(join(dir, '本轮汇总.md'), '# 汇总\n结论：通过', 'utf8')
    await writeFile(join(dir, '交付稿', '说明.md'), '说明正文', 'utf8')
    const { routes } = setupCtx({ root })
    const query = encodeURIComponent(root)

    const listed = await call(routes, {
      url: `/api/im/group-files?threadId=t1&projectRoot=${query}`,
      method: 'GET',
    })
    expect(listed.status).toBe(200)
    expect(listed.body.entries.map((entry: { name: string }) => entry.name)).toEqual(['交付稿', '本轮汇总.md'])

    const raw = await callRaw(routes, {
      url: `/api/im/group-file?threadId=t1&projectRoot=${query}&path=${encodeURIComponent('本轮汇总.md')}`,
      method: 'GET',
    })
    expect(raw.status).toBe(200)
    expect(raw.headers['content-type']).toBe('text/plain')
    expect(raw.body).toContain('结论：通过')

    const traversal = await call(routes, {
      url: `/api/im/group-files?threadId=t1&projectRoot=${query}&path=${encodeURIComponent('../state.json')}`,
      method: 'GET',
    })
    expect(traversal.status).toBe(400)

    const internal = await call(routes, {
      url: `/api/im/group-files?threadId=t1&projectRoot=${query}&path=${encodeURIComponent('../.dsh-im/state.json')}`,
      method: 'GET',
    })
    expect(internal.status).toBe(400)
  })
})
