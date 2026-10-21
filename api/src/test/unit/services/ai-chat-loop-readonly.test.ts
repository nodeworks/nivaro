import { describe, expect, it, vi } from 'vitest'

// #2456 — a read-only run is never OFFERED a tool that could change data, takes
// its own round budget, and reports each finished call through onTrace (#2739).

const executed = vi.hoisted(() => [] as string[])
vi.mock('../../../services/ai-chat.js', () => ({
  MAX_ROUNDS: 12,
  CHAT_TOOLS: [
    { name: 'query_items', input_schema: { type: 'object' } },
    { name: 'aggregate', input_schema: { type: 'object' } },
    { name: 'propose_action', input_schema: { type: 'object' } },
    { name: 'propose_plan', input_schema: { type: 'object' } },
    { name: 'run_custom_query', input_schema: { type: 'object' } }
  ],
  executeChatTool: async (_u: unknown, name: string) => {
    executed.push(name)
    return { result: { total: 1 }, summary: '1 row(s)' }
  },
  buildWrapUpMessages: (c: unknown) => c
}))

const { runChatLoop } = await import('../../../services/ai-chat-loop.js')

function client(script: Array<{ tool?: string; text?: string }>) {
  const seen: Array<{ tools?: Array<{ name: string }> }> = []
  let i = 0
  return {
    seen,
    messages: {
      create: async (params: { tools?: Array<{ name: string }> }) => {
        seen.push(params)
        const step = script[Math.min(i++, script.length - 1)]
        return step.tool
          ? {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: `t${i}`, name: step.tool, input: {} }]
            }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: step.text ?? 'done' }] }
      }
    }
  }
}

describe('runChatLoop readOnly', () => {
  it('offers only the replayable reads and refuses anything else the model names', async () => {
    executed.length = 0
    const c = client([{ tool: 'propose_plan' }, { tool: 'query_items' }, { text: 'answer' }])
    const traced: string[] = []
    const out = await runChatLoop({
      client: c as never,
      model: 'm',
      system: 's',
      user: { id: 'U' } as never,
      convo: [{ role: 'user', content: 'q' }],
      readOnly: true,
      onTrace: (e) => traced.push(`${e.tool}:${e.summary.startsWith('error:') ? 'err' : 'ok'}`)
    })
    expect(c.seen[0].tools?.map((t) => t.name)).toEqual(['query_items', 'aggregate'])
    expect(executed).toEqual(['query_items'])
    expect(traced).toEqual(['propose_plan:err', 'query_items:ok'])
    expect(out.text).toBe('answer')
    expect(out.plans).toEqual([])
  })

  it('maxRounds caps the tool rounds before the wrap-up', async () => {
    const c = client([{ tool: 'query_items' }])
    const out = await runChatLoop({
      client: c as never,
      model: 'm',
      system: 's',
      user: { id: 'U' } as never,
      convo: [{ role: 'user', content: 'q' }],
      maxRounds: 3
    })
    expect(out.truncated).toBe(true)
    expect(out.rounds).toBe(3)
    // 3 tool rounds + the wrap-up call
    expect(c.seen).toHaveLength(4)
    expect(c.seen[0].tools?.map((t) => t.name)).toContain('propose_plan')
  })
})
