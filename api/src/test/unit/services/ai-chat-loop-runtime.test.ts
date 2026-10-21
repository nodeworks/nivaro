import type Anthropic from '@anthropic-ai/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Ask AI loop's runtime savings: #2471 start cheap, #2765 compact tool
// payloads, #2737 tool results reused within a conversation.

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

const tools = vi.hoisted(() => ({ ran: [] as string[], fail: new Set<string>() }))
vi.mock('../../../services/ai-chat.js', () => ({
  CHAT_TOOLS: [{ name: 'query_items', description: 'q', input_schema: { type: 'object' } }],
  MAX_ROUNDS: 12,
  buildWrapUpMessages: () => [],
  executeChatTool: async (_u: unknown, tool: string) => {
    tools.ran.push(tool)
    if (tools.fail.has(tool)) throw new Error('Unknown field "stat"')
    return {
      result: {
        total: 3,
        rows: Array.from({ length: 12 }, (_, i) => i + 1).map((id) => ({
          id,
          name: `Workflow number ${id}`,
          vendor: { id: 7, label: 'Northwind Traders' }
        }))
      },
      summary: '3 of 3 row(s) from workflows'
    }
  }
}))

import { currentAiCallMeta } from '../../../services/ai-call-meta.js'
import { runChatLoop } from '../../../services/ai-chat-loop.js'
import type { ToolReuse } from '../../../services/ai-tool-reuse.js'

type Step = { tool?: string; input?: Record<string, unknown>; text?: string }

const toolMsg = (calls: Step[]): Anthropic.Message =>
  ({
    content: calls.map((c, i) => ({
      type: 'tool_use',
      id: `t${i}`,
      name: c.tool,
      input: c.input ?? { collection: 'workflows' }
    })),
    stop_reason: 'tool_use'
  }) as unknown as Anthropic.Message
const textMsg = (text: string): Anthropic.Message =>
  ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) as unknown as Anthropic.Message

interface Seen {
  who: string
  model: string
  meta: ReturnType<typeof currentAiCallMeta>
  messages: Anthropic.MessageParam[]
}

function client(who: string, script: Anthropic.Message[], seen: Seen[]) {
  return {
    messages: {
      create: async (p: Anthropic.MessageCreateParams) => {
        seen.push({
          who,
          model: p.model,
          meta: currentAiCallMeta(),
          messages: JSON.parse(JSON.stringify(p.messages))
        })
        const next = script.shift()
        if (!next) throw new Error(`${who} has nothing more to say`)
        return next
      }
    }
  } as unknown as Anthropic
}

const user = { id: 'u1' } as never
const ask = (q = 'how many workflows?') => [{ role: 'user' as const, content: q }]

beforeEach(() => {
  tools.ran.length = 0
  tools.fail.clear()
})

describe('start cheap (#2471)', () => {
  it('a question the small model answers never reaches the main model', async () => {
    const seen: Seen[] = []
    const r = await runChatLoop({
      client: client('main', [], seen),
      model: 'big',
      system: 's',
      user,
      convo: ask(),
      routing: {
        cheapModel: 'small',
        cheapClient: client('cheap', [toolMsg([{ tool: 'query_items' }]), textMsg('3.')], seen)
      }
    })
    expect(r.text).toBe('3.')
    expect(r.routing).toEqual({ tier: 'cheap', model: 'small' })
    expect(seen.map((s) => `${s.who}:${s.model}`)).toEqual(['cheap:small', 'cheap:small'])
    expect(seen[0].meta?.routing).toEqual({
      tier: 'cheap',
      main_model: 'big',
      cheap_model: 'small'
    })
  })

  it('a failed tool call moves up and the main model carries on', async () => {
    tools.fail.add('query_items')
    const seen: Seen[] = []
    const r = await runChatLoop({
      client: client('main', [textMsg('There are 3.')], seen),
      model: 'big',
      system: 's',
      user,
      convo: ask(),
      routing: {
        cheapModel: 'small',
        cheapClient: client('cheap', [toolMsg([{ tool: 'query_items' }])], seen)
      }
    })
    expect(r.routing).toEqual({ tier: 'main', model: 'big', reason: 'tool_error' })
    expect(seen.map((s) => s.who)).toEqual(['cheap', 'main'])
    // the main model sees the failed result — it carries on, nothing is re-run
    expect(JSON.stringify(seen[1].messages)).toContain('Unknown field')
    expect(seen[1].meta?.routing).toMatchObject({ tier: 'main', reason: 'tool_error' })
  })

  it('a proposal is always made by the main model', async () => {
    const seen: Seen[] = []
    const r = await runChatLoop({
      client: client('main', [textMsg('Drafted.')], seen),
      model: 'big',
      system: 's',
      user,
      convo: ask('close workflow 3'),
      routing: {
        cheapModel: 'small',
        cheapClient: client('cheap', [toolMsg([{ tool: 'propose_action' }])], seen)
      }
    })
    expect(tools.ran).not.toContain('propose_action')
    expect(r.routing?.reason).toBe('proposal')
    expect(seen.map((s) => s.who)).toEqual(['cheap', 'main'])
  })

  it('"I cannot answer" runs the question again on the main model, from the start', async () => {
    const seen: Seen[] = []
    const convo = ask()
    const statuses: string[] = []
    const r = await runChatLoop({
      client: client('main', [toolMsg([{ tool: 'query_items' }]), textMsg('There are 3.')], seen),
      model: 'big',
      system: 's',
      user,
      convo,
      onStatus: (st) => statuses.push(st.text),
      routing: {
        cheapModel: 'small',
        cheapClient: client(
          'cheap',
          [toolMsg([{ tool: 'query_items' }]), textMsg("I can't answer that.")],
          seen
        )
      }
    })
    expect(r.text).toBe('There are 3.')
    expect(r.routing).toEqual({ tier: 'main', model: 'big', reason: 'cannot_answer' })
    expect(r.trace).toHaveLength(1) // the cheap attempt's steps are dropped
    expect(seen[2].messages).toHaveLength(1) // the rerun starts from the question
    expect(seen[2].meta?.routing).toMatchObject({ rerun: true, reason: 'cannot_answer' })
    expect(statuses).toContain('Trying harder…')
  })

  it('"Try harder" (no cheap client) is the main model, tagged', async () => {
    const seen: Seen[] = []
    const r = await runChatLoop({
      client: client('main', [textMsg('ok')], seen),
      model: 'big',
      system: 's',
      user,
      convo: ask(),
      routing: { cheapModel: 'small', cheapClient: null, retryOf: 'req-9' }
    })
    expect(r.routing).toEqual({ tier: 'main', model: 'big', reason: 'try_harder' })
    expect(seen[0].meta?.routing).toMatchObject({ reason: 'try_harder', retry_of: 'req-9' })
  })

  it('without routing nothing changes (no tier on the result or the log)', async () => {
    const seen: Seen[] = []
    const r = await runChatLoop({
      client: client('main', [textMsg('ok')], seen),
      model: 'big',
      system: 's',
      user,
      convo: ask()
    })
    expect(r.routing).toBeUndefined()
    expect(seen[0].meta).toBeNull()
  })
})

describe('compact tool payloads (#2765)', () => {
  it('the model reads a table; the trace keeps the summary; sizes ride the next call', async () => {
    const seen: Seen[] = []
    const r = await runChatLoop({
      client: client('main', [toolMsg([{ tool: 'query_items' }]), textMsg('3.')], seen),
      model: 'big',
      system: 's',
      user,
      convo: ask()
    })
    const sent = JSON.stringify(seen[1].messages)
    expect(sent).toContain('$cols')
    expect(sent.match(/Northwind/g)).toHaveLength(1)
    expect(r.trace[0].summary).toBe('3 of 3 row(s) from workflows')
    const tp = seen[1].meta?.tool_payload?.query_items
    expect(tp?.calls).toBe(1)
    expect(tp?.after).toBeLessThan(tp?.before ?? 0)
    expect(seen[0].meta).toBeNull() // the first call carried no tool results
  })
})

describe('tool results reused within a conversation (#2737)', () => {
  function memoryReuse(): ToolReuse & { puts: number } {
    const m = new Map<string, { result: unknown; summary: string }>()
    const r = {
      puts: 0,
      async get(tool: string, input: Record<string, unknown>) {
        return m.get(tool + JSON.stringify(input)) ?? null
      },
      put(tool: string, input: Record<string, unknown>, out: { result: unknown; summary: string }) {
        r.puts++
        m.set(tool + JSON.stringify(input), out)
      }
    }
    return r
  }

  it('a repeated read is served from the store and marked reused', async () => {
    const reuse = memoryReuse()
    const seen: Seen[] = []
    const statuses: Array<{ result?: string; reused?: boolean }> = []
    const r = await runChatLoop({
      client: client(
        'main',
        [toolMsg([{ tool: 'query_items' }]), toolMsg([{ tool: 'query_items' }]), textMsg('3.')],
        seen
      ),
      model: 'big',
      system: 's',
      user,
      convo: ask(),
      reuse,
      onStatus: (st) => {
        if (st.done) statuses.push({ result: st.result, reused: st.reused })
      }
    })
    expect(tools.ran).toEqual(['query_items'])
    expect(r.trace.map((t) => t.reused ?? false)).toEqual([false, true])
    expect(statuses[1]).toEqual({ result: 'reused · 3 found', reused: true })
    expect(seen[2].meta?.tool_payload?.query_items.reused).toBe(1)
    expect(reuse.puts).toBe(1)
  })
})
