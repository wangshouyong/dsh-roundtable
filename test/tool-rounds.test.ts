import { afterEach, describe, expect, it } from 'vitest'
import { completeDshChat, type LlmService } from '../src/host/dsh-llm.ts'

type Step = 'tool' | 'text'

/** 假宿主：按脚本决定每一轮是“调工具”还是“给文本”；最后一轮没工具时默认给文本。 */
function scriptedLlm(steps: Step[] | 'always-tool', options: { distinctArgs?: boolean } = {}) {
  const calls: Record<string, unknown>[] = []
  let index = 0
  const llm: LlmService = {
    stream(request: Record<string, unknown>) {
      calls.push(request)
      const hasTools = Array.isArray(request.tools) && request.tools.length > 0
      const step: Step = steps === 'always-tool'
        ? 'tool'
        : steps[Math.min(index, steps.length - 1)]
      index += 1
      const callIndex = index
      async function* chunks() {
        if (step === 'text' || !hasTools) {
          yield { type: 'text-delta', text: `回答${callIndex}` }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const args = options.distinctArgs ? `{"path":"dir${callIndex}"}` : '{"path":"."}'
        yield { type: 'block-end', block: { type: 'tool-call', id: 'c' + callIndex, name: 'list_dir', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
      return chunks()
    },
  }
  return { llm, calls }
}

const base = {
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  system: '你是测试角色',
  messages: [{ role: 'user' as const, content: '查一下项目结构' }],
  toolAllow: ['read'],
}

afterEach(() => {
  delete process.env.DSH_IM_MAX_TOOL_ROUNDS
  delete process.env.DSH_IM_TURN_BUDGET_MS
})

describe('工具循环护栏（不设很低的轮次上限）', () => {
  it('调研 5 轮工具也能正常答完（默认硬顶 50，远高于旧的 4 轮）', async () => {
    const { llm, calls } = scriptedLlm(['tool', 'tool', 'tool', 'tool', 'tool', 'text'], { distinctArgs: true })
    const toolCalls: string[] = []
    const text = await completeDshChat({
      ...base,
      llm,
      onTool: async (name) => { toolCalls.push(name); return '目录里有 a.ts' },
    })
    expect(text).toContain('回答')
    expect(toolCalls).toHaveLength(5)
    expect(calls).toHaveLength(6)
  })

  it('同一工具同一参数反复调 3 次熔断：强制只作答，不再无限循环', async () => {
    const { llm, calls } = scriptedLlm('always-tool')
    let toolRuns = 0
    const text = await completeDshChat({
      ...base,
      llm,
      onTool: async () => { toolRuns += 1; return '结果不变' },
    })
    expect(text).toContain('回答')
    // 前两次真的执行，第三次换成“重复调用”提示并强制收尾 → 第 4 次调用去掉工具拿文本
    expect(toolRuns).toBe(2)
    expect(calls).toHaveLength(4)
    const lastCall = calls.at(-1)!
    expect(lastCall.tools).toBeUndefined()
    expect(String(lastCall.system)).toContain('不要再调用工具')
  })

  it('兜底轮模型还只吐工具调用、没有文本 → 报明确错误', async () => {
    const llm: LlmService = {
      stream() {
        async function* chunks() {
          yield { type: 'block-end', block: { type: 'tool-call', id: 'c', name: 'list_dir', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        }
        return chunks()
      },
    }
    await expect(completeDshChat({
      ...base,
      llm,
      maxToolRounds: 1,
      onTool: async () => '结果',
    })).rejects.toThrow(/仍未给出文字回复/)
  })

  it('硬顶可配置：maxToolRounds=2 → 2 轮工具后兜底；环境变量也能调', async () => {
    const explicit = scriptedLlm('always-tool', { distinctArgs: true })
    await completeDshChat({ ...base, llm: explicit.llm, maxToolRounds: 2, onTool: async () => 'ok' })
    expect(explicit.calls).toHaveLength(3)

    process.env.DSH_IM_MAX_TOOL_ROUNDS = '1'
    const viaEnv = scriptedLlm('always-tool', { distinctArgs: true })
    await completeDshChat({ ...base, llm: viaEnv.llm, onTool: async () => 'ok' })
    expect(viaEnv.calls).toHaveLength(2)
  })

  it('总时长预算生效：超预算后不再调工具，直接兜底作答', async () => {
    const calls: Record<string, unknown>[] = []
    // 预算判定只以注入的 now() 为准，不依赖真实时间/机器负载（并行跑也不会抖）。
    // 时序：轮次 1 进入时 now()=0 < 预算 → 带工具；该轮流式调用“花掉”时间后 now()=10 → 轮次 2 超预算。
    let clock = 0
    let index = 0
    const llm: LlmService = {
      stream(request: Record<string, unknown>) {
        calls.push(request)
        const hasTools = Array.isArray(request.tools) && request.tools.length > 0
        index += 1
        const callIndex = index
        clock = 10
        async function* chunks() {
          if (!hasTools) {
            yield { type: 'text-delta', text: '兜底回答' }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          yield { type: 'block-end', block: { type: 'tool-call', id: 'c' + callIndex, name: 'list_dir', arguments: `{"path":"d${callIndex}"}` } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        }
        return chunks()
      },
    }
    const text = await completeDshChat({
      ...base,
      llm,
      timeBudgetMs: 1,
      now: () => clock,
      onTool: async () => 'ok',
    })
    expect(text).toBe('兜底回答')
    // 第 1 轮正常给工具 → 第 2 轮（超预算、无工具）直接作答
    expect(calls).toHaveLength(2)
    expect(calls[0].tools).toBeDefined()
    expect(calls[1].tools).toBeUndefined()
  })

  it('工具执行抛错不终止整轮：错误作为 tool 结果喂回模型，仍能收尾', async () => {
    const { llm } = scriptedLlm(['tool', 'text'])
    const text = await completeDshChat({
      ...base,
      llm,
      onTool: async () => { throw new Error('读文件失败') },
    })
    expect(text).toContain('回答')
  })
})
