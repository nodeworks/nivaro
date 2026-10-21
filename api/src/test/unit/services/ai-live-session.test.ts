import { describe, expect, it } from 'vitest'
import { createLiveMirror } from '../../../services/ai-live-session.js'
import { hashToolResult } from '../../../services/ai-result-hash.js'

// #2739 — a shared thread's live mirror shows another participant the asker's
// steps and answer text only as far as their own access confirms it.

const asker = { id: 'AAAA0000-0000-0000-0000-000000000001', name: 'Ann' }
const bob = { id: 'bbbb0000-0000-0000-0000-000000000002', status: 'active' }
const cara = { id: 'cccc0000-0000-0000-0000-000000000003', status: 'active' }

const rows = { total: 2, rows: [{ id: 1 }, { id: 2 }] }
const entry = (tool = 'query_items', result: unknown = rows) => ({
  tool,
  input: { collection: 'orders' },
  summary: '2 of 2 row(s)',
  result_hash: hashToolResult(result)
})

function mirror(opts: {
  participants?: unknown[]
  replay?: (u: { id: string }) => unknown
  earlierVisible?: (u: { id: string }) => boolean
  hasPageContext?: boolean
}) {
  const sent: Array<{ to: string; payload: Record<string, unknown> }> = []
  const calls = { n: 0 }
  const m = createLiveMirror({
    conversationId: 'c1',
    questionMessageId: '9',
    asker,
    participants: (opts.participants ?? [bob]) as never,
    emit: (to, payload) => sent.push({ to, payload }),
    earlierVisible: async (u) => opts.earlierVisible?.(u as never) ?? true,
    hasPageContext: opts.hasPageContext,
    replay: async (u) => {
      calls.n++
      return { result: opts.replay ? opts.replay(u as never) : rows }
    }
  })
  const kinds = (to: string) => sent.filter((s) => s.to === to).map((s) => String(s.payload.kind))
  const texts = (to: string) =>
    sent.filter((s) => s.to === to && s.payload.kind === 'delta').map((s) => s.payload.text)
  return { m: m!, sent, kinds, texts, calls }
}

describe('createLiveMirror (#2739)', () => {
  it('is null when nobody but the asker is in the thread', () => {
    const m = createLiveMirror({
      conversationId: 'c1',
      questionMessageId: '9',
      asker,
      participants: [{ id: asker.id.toLowerCase() }] as never,
      emit: () => {},
      earlierVisible: async () => true
    })
    expect(m).toBeNull()
  })

  it('text written before any tool call never streams to others', async () => {
    const { m, kinds, texts } = mirror({})
    m.delta('Let me look', 0)
    m.end('answered')
    await m.settled()
    expect(texts(bob.id)).toEqual([])
    expect(kinds(bob.id)).toEqual(['working', 'end'])
  })

  it('a step that replays to the same fingerprint opens the stream for that reader', async () => {
    const { m, kinds, texts, sent } = mirror({})
    m.trace(entry())
    m.delta('There are 2 orders.', 1)
    m.end('answered')
    await m.settled()
    expect(kinds(bob.id)).toEqual(['working', 'step', 'delta', 'end'])
    expect(texts(bob.id)).toEqual(['There are 2 orders.'])
    // ids + names only — the step never carries the tool's input.
    const step = sent.find((s) => s.payload.kind === 'step')!.payload
    expect(step).toMatchObject({ conversation_id: 'c1', message_id: '9', tool: 'query_items' })
    expect(step.input).toBeUndefined()
    expect(step.by).toEqual(asker)
  })

  it('a reader whose replay differs gets "working" only, from then on', async () => {
    const { m, kinds, texts } = mirror({
      participants: [bob, cara],
      replay: (u) => (u.id === cara.id ? { total: 1, rows: [{ id: 1 }] } : rows)
    })
    m.trace(entry())
    m.delta('There are 2 orders.', 1)
    await m.settled()
    expect(texts(bob.id)).toEqual(['There are 2 orders.'])
    expect(texts(cara.id)).toEqual([])
    expect(kinds(cara.id)).not.toContain('step')
  })

  it('a tool outside the replay list closes the stream (saved SQL, plans, tasks)', async () => {
    const { m, texts, kinds } = mirror({})
    m.trace(entry())
    m.trace(entry('run_custom_query'))
    m.delta('From the saved query…', 2)
    await m.settled()
    expect(texts(bob.id)).toEqual([])
    expect(kinds(bob.id).filter((k) => k === 'step')).toHaveLength(1)
  })

  it('an errored call closes it (error text can carry SQL or field names)', async () => {
    const { m, texts } = mirror({})
    m.trace({ tool: 'query_items', input: {}, summary: 'error: Invalid column x' })
    m.delta('Something', 1)
    await m.settled()
    expect(texts(bob.id)).toEqual([])
  })

  it('an earlier answer the reader cannot see keeps the whole answer from them', async () => {
    const { m, texts } = mirror({ earlierVisible: () => false })
    m.trace(entry())
    m.delta('There are 2 orders.', 1)
    await m.settled()
    expect(texts(bob.id)).toEqual([])
  })

  it('a question asked with page context never streams (that context never replays)', async () => {
    const { m, texts, calls } = mirror({ hasPageContext: true })
    m.trace(entry())
    m.delta('About this record…', 1)
    await m.settled()
    expect(texts(bob.id)).toEqual([])
    expect(calls.n).toBe(0)
  })
})
