import { describe, expect, it } from 'vitest'
import {
  type AnswerInput,
  aggregateTools,
  isEmptySummary,
  isErrorSummary,
  saysNone,
  toolTimes
} from '../../../services/ai-tool-reliability.js'

const ans = (o: Partial<AnswerInput>): AnswerInput => ({
  request_id: 'r1',
  at: '2026-10-21T10:00:00.000Z',
  steps: [],
  answer: '',
  rounds: null,
  ...o
})

describe('tool reliability board (#2733)', () => {
  it('reads empty and error summaries from the trace wording', () => {
    expect(isErrorSummary('error: Unknown field')).toBe(true)
    expect(isEmptySummary('0 of 0 row(s) from projects')).toBe(true)
    expect(isEmptySummary('0 semantic hit(s) in invoices (12 indexed)')).toBe(true)
    expect(isEmptySummary('3 of 40 row(s) from projects')).toBe(false)
    expect(isEmptySummary('sum(amount) = 0')).toBe(false)
    expect(isEmptySummary('error: boom')).toBe(false)
  })

  it('spots an answer that opens by saying there is nothing', () => {
    expect(saysNone('There are no open invoices for that vendor.')).toBe(true)
    expect(saysNone('Here are the 12 invoices that match.')).toBe(false)
  })

  it('counts a retry after an error as a wasted round, and whether it recovered', () => {
    const rows = aggregateTools([
      ans({
        steps: [
          { tool: 'query_items', summary: 'error: Unknown field x' },
          { tool: 'query_items', summary: '5 of 5 row(s) from projects' }
        ],
        rounds: 3
      }),
      ans({
        request_id: 'r2',
        steps: [
          { tool: 'query_items', summary: 'error: Unknown field y' },
          { tool: 'query_items', summary: 'error: Unknown field z' }
        ],
        rounds: 4
      })
    ])
    const q = rows.find((r) => r.tool === 'query_items')!
    expect(q.calls).toBe(4)
    expect(q.errors).toBe(3)
    expect(q.retries).toBe(2)
    expect(q.recovered).toBe(1)
    expect(q.avg_rounds).toBe(3.5)
    expect(q.failures).toHaveLength(3)
    expect(q.flags.join(' ')).toContain('recovers by retrying')
  })

  it('flags a tool whose zero rows the answer then reads as none', () => {
    const one = (id: string) =>
      ans({
        request_id: id,
        steps: [{ tool: 'query_items', summary: '0 of 0 row(s) from invoices' }],
        answer: 'There are no invoices over $1M.'
      })
    const rows = aggregateTools([one('a'), one('b')])
    expect(rows[0].empty).toBe(2)
    expect(rows[0].read_as_none).toBe(2)
    expect(rows[0].flags.join(' ')).toContain('too narrow')
  })

  it('keeps the slowest runs per tool', () => {
    const rows = aggregateTools([
      ans({
        steps: [{ tool: 'aggregate', summary: 'ok' }],
        tool_ms: [{ tool: 'aggregate', ms: 900 }]
      }),
      ans({
        request_id: 'r2',
        steps: [{ tool: 'aggregate', summary: 'ok' }],
        tool_ms: [{ tool: 'aggregate', ms: 100 }]
      })
    ])
    expect(rows[0].avg_ms).toBe(500)
    expect(rows[0].slowest[0]).toMatchObject({ ms: 900, request_id: 'r1' })
  })

  it('works out tool time from the gap between rounds', () => {
    const t0 = new Date('2026-10-21T10:00:00.000Z').getTime()
    const calls = [
      {
        request_id: 'r',
        created_at: new Date(t0),
        latency_ms: 1000,
        response: JSON.stringify([
          { type: 'tool_use', id: '1', name: 'a', input: {} },
          { type: 'tool_use', id: '2', name: 'b', input: {} }
        ])
      },
      { request_id: 'r', created_at: new Date(t0 + 3000), latency_ms: 800, response: '[]' }
    ]
    expect(toolTimes(calls)).toEqual([
      { tool: 'a', ms: 1000 },
      { tool: 'b', ms: 1000 }
    ])
    // a round that finished after the next began (clock skew) is ignored
    expect(toolTimes([{ ...calls[0], latency_ms: 9000 }, calls[1]])).toEqual([])
  })
})
