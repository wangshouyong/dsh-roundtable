import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseState } from '../src/core/persist.ts'
import { createImApi } from '../src/host/im-api.ts'

describe('state.json 坏数据清洗', () => {
  it('丢弃坏条目、保留好条目、收敛老工具 id', () => {
    const raw = JSON.stringify({
      personas: [
        { id: 'p1', name: '淇淇', toolAllow: ['read', 'shell'] },
        { id: 'p2' },
        null,
        'x',
      ],
      threads: [{ id: 't1', title: '群' }, { id: 't2' }],
      memories: [{ id: 'm1', text: 'x' }, {}],
      wakeExcerpts: {},
    })
    const state = parseState(raw)
    expect(state.personas.map((p) => p.id)).toEqual(['p1'])
    expect(state.personas[0].toolAllow).toEqual(['read'])
    expect(state.threads.map((t) => t.id)).toEqual(['t1'])
    expect(state.memories.map((m) => m.id)).toEqual(['m1'])
  })

  it('非标准消息 kind 归一：有 authorId → persona，没有 authorId → user（否则我的发言会被排到左边）', () => {
    const raw = JSON.stringify({
      personas: [],
      threads: [{
        id: 't1',
        title: '演示群',
        kind: 'group',
        memberIds: [],
        members: [],
        projectRoot: '.',
        unread: 0,
        roundMode: 'idle',
        createdAt: 0,
        updatedAt: 0,
        // 手工演示数据 / 外部脚本可能写 kind:'text'（真实遇到：演示数据目录）
        messages: [
          { id: 'm1', threadId: 't1', kind: 'text', authorName: '你', text: '我的发言', createdAt: 1 },
          { id: 'm2', threadId: 't1', kind: 'text', authorId: 'p1', authorName: '苏晓', text: '角色发言', createdAt: 2 },
          { id: 'm3', threadId: 't1', kind: 'system', authorName: '系统主持', text: '系统', createdAt: 3 },
          { id: 'm4', threadId: 't1', kind: 'user', authorName: '你', text: '标准 kind 不动', createdAt: 4 },
        ],
      }],
      memories: [],
      wakeExcerpts: {},
    })
    const state = parseState(raw)
    expect(state.threads[0].messages.map((message) => message.kind)).toEqual(['user', 'persona', 'system', 'user'])
    // 幂等：再把归一后的 state 解析一次，kind 不变
    const again = parseState(JSON.stringify(state))
    expect(again.threads[0].messages.map((message) => message.kind)).toEqual(['user', 'persona', 'system', 'user'])
  })

  it('round-trip：含 shell 的 state 经 putState 落盘后，读回只有当前能力', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-state-'))
    const llm = {
      listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
      async listModels() {
        return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
      },
    }
    const api = createImApi({ projectRoot: () => root, llm: () => llm })
    const raw = JSON.stringify({
      personas: [{ id: 'p1', name: '淇淇', proactiveDm: true, toolAllow: ['read', 'shell', 'search'] }],
      threads: [],
      memories: [],
      wakeExcerpts: {},
    })
    await api.putState(raw, root)
    const state = await api.getState(root)
    expect(state?.personas[0].toolAllow).toEqual(['read', 'search'])
    expect(state?.personas[0].proactiveDm).toBe(true)
  })
})
