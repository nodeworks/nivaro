import knex from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shortAnswer } from '../../../services/ai-conversation-card.js'
import {
  answerVisibleTo,
  applyConversationSearch,
  clearVisibilityCache,
  exportFileName,
  flattenRow,
  historyFromView,
  messagesForViewer,
  rowsFromToolResult,
  titleFromQuestion,
  toCsv
} from '../../../services/ai-conversations.js'
import { hashToolResult, TOOL_RESULT_MODEL_CHARS } from '../../../services/ai-result-hash.js'

const alice = { id: 'AAAAAAAA-0000-0000-0000-000000000001' } as never
const bob = { id: 'bbbbbbbb-0000-0000-0000-000000000002' } as never

const rowsA = {
  data: [
    { id: 1, name: 'North' },
    { id: 2, name: 'South' }
  ]
}
const rowsB = { data: [{ id: 1, name: 'North' }] }

function answer(trace: unknown[], id = 1) {
  return { id, author: 'aaaaaaaa-0000-0000-0000-000000000001', trace: JSON.stringify(trace) }
}

describe('answerVisibleTo — the sharing rule (#1809)', () => {
  beforeEach(() => clearVisibilityCache())

  it('the author always reads their answer, without a replay (ids compare case-blind)', async () => {
    const replay = vi.fn()
    expect(await answerVisibleTo(alice, answer([]), replay)).toBe(true)
    expect(replay).not.toHaveBeenCalled()
  })

  it('another person reads it only when every call replays to the same fingerprint', async () => {
    const trace = [
      {
        tool: 'query_items',
        input: { collection: 'zones' },
        summary: '2 rows',
        result_hash: hashToolResult(rowsA)
      }
    ]
    expect(await answerVisibleTo(bob, answer(trace, 1), async () => ({ result: rowsA }))).toBe(true)
    // Bob's narrower access returns fewer rows → withheld.
    expect(await answerVisibleTo(bob, answer(trace, 2), async () => ({ result: rowsB }))).toBe(
      false
    )
  })

  it('a tool outside the replay list, a missing fingerprint or a failing replay keeps it private', async () => {
    const ok = async () => ({ result: rowsA })
    expect(
      await answerVisibleTo(
        bob,
        answer([{ tool: 'propose_action', input: {}, summary: 'x' }], 3),
        ok
      )
    ).toBe(false)
    expect(
      await answerVisibleTo(bob, answer([{ tool: 'query_items', input: {}, summary: 'x' }], 4), ok)
    ).toBe(false)
    const boom = async () => {
      throw new Error('forbidden')
    }
    const trace = [
      { tool: 'aggregate', input: {}, summary: 'x', result_hash: hashToolResult(rowsA) }
    ]
    expect(await answerVisibleTo(bob, answer(trace, 5), boom)).toBe(false)
  })

  it('D1: an answer with no tool calls is never shown to anyone but its author', async () => {
    const replay = vi.fn()
    expect(await answerVisibleTo(bob, answer([], 6), replay)).toBe(false)
    expect(await answerVisibleTo(bob, { id: 66, author: 'x', trace: null }, replay)).toBe(false)
    expect(replay).not.toHaveBeenCalled()
  })

  it('D6: a call that errored makes the answer private (error text may carry SQL)', async () => {
    const replay = vi.fn(async () => ({ result: rowsA }))
    const trace = [
      { tool: 'aggregate', input: {}, summary: 'x', result_hash: hashToolResult(rowsA) },
      { tool: 'query_items', input: {}, summary: 'error: Invalid column name salary' }
    ]
    expect(await answerVisibleTo(bob, answer(trace, 61), replay)).toBe(false)
    expect(replay).not.toHaveBeenCalled()
  })

  it('D7: saved SQL and proposals are never replayed — the answer stays private', async () => {
    const replay = vi.fn(async () => ({ result: rowsA }))
    for (const tool of ['run_custom_query', 'propose_action']) {
      const trace = [{ tool, input: { id: 1 }, summary: 'x', result_hash: hashToolResult(rowsA) }]
      expect(await answerVisibleTo(bob, answer(trace, tool.length), replay)).toBe(false)
    }
    expect(replay).not.toHaveBeenCalled()
  })

  it('tools from the merged features keep an answer private (default: not shareable)', async () => {
    const replay = vi.fn(async () => ({ result: rowsA }))
    const tools = [
      'propose_plan',
      'my_watches',
      'past_state',
      'search_docs',
      'explain_owners',
      'who_can_act',
      'explain_person_access',
      'explain_access',
      'my_tasks',
      'traffic_snapshot'
    ]
    for (const [i, tool] of tools.entries()) {
      const trace = [{ tool, input: {}, summary: 'x', result_hash: hashToolResult(rowsA) }]
      expect(await answerVisibleTo(bob, answer(trace, 900 + i), replay)).toBe(false)
    }
    expect(replay).not.toHaveBeenCalled()
  })

  it('D7: a request spends at most its replay budget; the rest is withheld, not cached', async () => {
    const replay = vi.fn(async () => ({ result: rowsA }))
    const trace = [
      { tool: 'aggregate', input: {}, summary: 'x', result_hash: hashToolResult(rowsA) },
      { tool: 'aggregate', input: {}, summary: 'y', result_hash: hashToolResult(rowsA) }
    ]
    const budget = { left: 3 }
    expect(await answerVisibleTo(bob, answer(trace, 71), replay, budget)).toBe(true)
    expect(await answerVisibleTo(bob, answer(trace, 72), replay, budget)).toBe(false)
    expect(replay).toHaveBeenCalledTimes(2)
    // A fresh request with budget left decides it properly.
    expect(await answerVisibleTo(bob, answer(trace, 72), replay, { left: 10 })).toBe(true)
  })

  it('caches the verdict per message and viewer', async () => {
    const trace = [
      { tool: 'aggregate', input: {}, summary: 'x', result_hash: hashToolResult(rowsA) }
    ]
    const replay = vi.fn(async () => ({ result: rowsA }))
    await answerVisibleTo(bob, answer(trace, 7), replay)
    await answerVisibleTo(bob, answer(trace, 7), replay)
    expect(replay).toHaveBeenCalledTimes(1)
  })
})

describe('messagesForViewer — earlier answers gate later ones (D2)', () => {
  beforeEach(() => clearVisibilityCache())
  const A = 'aaaaaaaa-0000-0000-0000-000000000001'
  const B = 'bbbbbbbb-0000-0000-0000-000000000002'
  const clean = [
    { tool: 'aggregate', input: { n: 1 }, summary: 'x', result_hash: hashToolResult(rowsA) }
  ]
  const leaky = [
    { tool: 'query_items', input: { n: 2 }, summary: 'x', result_hash: hashToolResult(rowsA) }
  ]
  const msg = (id: number, role: 'user' | 'assistant', author: string, trace?: unknown[]) => ({
    id,
    conversation_id: 'c',
    role,
    author,
    content: `m${id}`,
    trace: trace ? JSON.stringify(trace) : null,
    proposals: null,
    meta: null,
    created_at: new Date(0)
  })
  // Bob's replay: the `n: 2` query returns fewer rows for him (hidden); `n: 1` is clean.
  const replay = async (_u: unknown, _t: string, input: Record<string, unknown>) => ({
    result: input.n === 2 ? rowsB : rowsA
  })

  it('a clean answer after a hidden one stays hidden; the viewer’s own answers stay readable', async () => {
    const view = await messagesForViewer(
      bob,
      [
        msg(1, 'user', A),
        msg(2, 'assistant', A, leaky), // salaries — hidden from Bob
        msg(3, 'user', A),
        msg(4, 'assistant', A, clean), // "put that in a list" with a clean call — still hidden
        msg(5, 'user', B),
        msg(6, 'assistant', B, clean) // Bob's own
      ],
      replay
    )
    expect(view.map((m) => [m.id, m.visible])).toEqual([
      ['1', true],
      ['2', false],
      ['3', true],
      ['4', false],
      ['5', true],
      ['6', true]
    ])
    expect(view[3].content).toBe('')
  })

  it('every answer clean → every answer readable', async () => {
    const view = await messagesForViewer(
      bob,
      [
        msg(11, 'user', A),
        msg(12, 'assistant', A, clean),
        msg(13, 'user', A),
        msg(14, 'assistant', A, clean)
      ],
      replay
    )
    expect(view.every((m) => m.visible)).toBe(true)
  })
})

describe('applyConversationSearch (D3)', () => {
  it('matches questions and the viewer’s own answers only', () => {
    const k = knex({ client: 'mssql' })
    const q = applyConversationSearch(
      k,
      k('nivaro_ai_conversations as c').select('c.*'),
      'salary',
      'VIEWER-1'
    ).toSQL()
    expect(q.sql).toContain('[m].[role] = ?')
    expect(q.sql).toContain('or [m].[author] = ?')
    expect(q.bindings).toEqual(expect.arrayContaining(['%salary%', 'user', 'VIEWER-1']))
  })
})

describe('hashToolResult', () => {
  it('only fingerprints what the model saw', () => {
    const big = 'x'.repeat(TOOL_RESULT_MODEL_CHARS + 10)
    expect(hashToolResult({ v: big })).toBe(hashToolResult({ v: `${big}more` }))
    expect(hashToolResult(rowsA)).not.toBe(hashToolResult(rowsB))
  })
})

describe('historyFromView', () => {
  it('hides answers the viewer may not read behind a placeholder and folds failed turns', () => {
    const h = historyFromView([
      { role: 'assistant', content: 'orphan', visible: true },
      { role: 'user', content: 'Q1', visible: true },
      { role: 'assistant', content: 'secret', visible: false },
      { role: 'user', content: 'Q2', visible: true },
      { role: 'user', content: 'Q3', visible: true },
      { role: 'assistant', content: 'A3', visible: true },
      { role: 'user', content: 'pending', visible: true }
    ])
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(h[1].content).not.toContain('secret')
    expect(h[1].content).toContain('not shown to you')
    expect(h[2].content).toBe('Q2\n\nQ3')
  })
})

describe('export helpers (#1841)', () => {
  it('finds the rows in a tool result and flattens labelled relations', () => {
    expect(rowsFromToolResult(rowsA)).toHaveLength(2)
    expect(rowsFromToolResult([{ a: 1 }])).toEqual([{ a: 1 }])
    expect(rowsFromToolResult({ count: 12 })).toEqual([{ count: 12 }])
    expect(rowsFromToolResult({ groups: [{ vendor: { id: 7, label: 'Acme' }, n: 3 }] })).toEqual([
      { vendor: 'Acme', n: 3 }
    ])
    expect(rowsFromToolResult('text')).toEqual([])
    expect(flattenRow({ tags: ['a', 'b'] })).toEqual({ tags: '["a","b"]' })
  })

  it('names the file after the question and time', () => {
    const at = new Date(2026, 9, 12, 14, 30)
    expect(exportFileName('Open purchase orders by vendor?', at)).toBe(
      'open-purchase-orders-by-vendor-2026-10-12-1430'
    )
    expect(exportFileName('???', at)).toBe('ask-ai-answer-2026-10-12-1430')
  })

  it('writes CSV with every column, numbers as numbers and formula-safe text', () => {
    const csv = toCsv([{ a: -5, b: '=SUM(A1)' }, { c: 'x,y' }])
    const [head, r1, r2] = csv.split('\r\n')
    expect(head).toBe('"a","b","c"')
    expect(r1).toBe('-5,"\'=SUM(A1)",""')
    expect(r2).toBe('"","","x,y"')
  })
})

describe('titles and cards', () => {
  it('titles a conversation from its first question', () => {
    expect(titleFromQuestion('  How many\n open POs?  ')).toBe('How many open POs?')
    expect(titleFromQuestion('')).toBe('New conversation')
    expect(titleFromQuestion('q'.repeat(200))).toHaveLength(80)
  })

  it('cuts an answer to plain text for a chat card', () => {
    const md = '**12** open.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n```chart\n{}\n```\nSee [PO-1](/x).'
    expect(shortAnswer(md)).toBe('12 open. See PO-1.')
    expect(shortAnswer('w'.repeat(300), 50)).toHaveLength(50)
  })
})
