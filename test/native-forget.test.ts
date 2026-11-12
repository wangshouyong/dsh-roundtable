import { describe, expect, it } from 'vitest'
import {
  createNativeRuntime,
  NativeAgentSessions,
  type NativeAgentHandle,
  type NativeAgentsApi,
  type NativeMessage,
} from '../src/host/agent-session.ts'

function fakeAgents() {
  const created: string[] = []
  const disposed: string[] = []
  const agents: NativeAgentsApi = {
    async create(input) {
      created.push(input.sessionId)
      const messages: NativeMessage[] = []
      const handle: NativeAgentHandle = {
        agent: {
          followup(message) {
            messages.push({ role: 'user', content: message.content })
            messages.push({ role: 'assistant', content: [{ type: 'text', text: '好' }] })
          },
          async whenIdle() {},
          session: { id: input.sessionId, deriveMessages: () => messages },
        },
        async dispose() {
          disposed.push(input.sessionId)
        },
      }
      return handle
    },
  }
  return { agents, created, disposed }
}

async function openSessions() {
  const fake = fakeAgents()
  const sessions = new NativeAgentSessions({ agents: () => fake.agents })
  for (const sessionKey of ['p1:t1', 'p1:t2', 'p2:t1']) {
    await sessions.complete({ sessionKey, provider: 'x', model: 'm', prompt: 'hi' })
  }
  expect(sessions.liveSessionIds()).toHaveLength(3)
  return { fake, sessions }
}

describe('原生会话 forget（删除/清空后不把死数据留在宿主内存）', () => {
  it('按角色释放：p1 的两个会话被释放并 dispose，p2 留着', async () => {
    const { fake, sessions } = await openSessions()
    const disposed = await sessions.forget({ personaId: 'p1' })
    expect(disposed).toBe(2)
    expect(fake.disposed).toHaveLength(2)
    expect(sessions.liveSessionIds()).toHaveLength(1)

    // 再释放同一个角色是幂等的：0，不重复 dispose。
    expect(await sessions.forget({ personaId: 'p1' })).toBe(0)
    expect(fake.disposed).toHaveLength(2)
  })

  it('按群释放 + 组合条件；空过滤条件不释放任何东西', async () => {
    const { fake, sessions } = await openSessions()
    expect(await sessions.forget({})).toBe(0)
    expect(await sessions.forget({ threadId: 't1' })).toBe(2)
    expect(fake.disposed).toHaveLength(2)
    expect(sessions.liveSessionIds()).toHaveLength(1)

    // personaId + threadId 必须同时匹配（此时只剩 p1:t2，命中后释放）。
    expect(await sessions.forget({ personaId: 'p1', threadId: 't2' })).toBe(1)
    expect(sessions.liveSessionIds()).toEqual([])
  })

  it('createNativeRuntime 的 bridge 暴露 forget；没匹配时返回 0', async () => {
    const fake = fakeAgents()
    const runtime = createNativeRuntime({ enabled: true, agents: () => fake.agents })
    expect(typeof runtime.bridge?.forget).toBe('function')
    expect(await runtime.bridge!.forget!({ personaId: 'nobody' })).toBe(0)
    await runtime.disposeAll()
  })
})
