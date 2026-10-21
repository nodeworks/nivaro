import { describe, expect, it } from 'vitest'
import { answerCode, type CodeAccess, jsLiteral } from '../../../services/ai-answer-code.js'

// #2766 — an answer's reads as SDK / REST code, never naming what the reader cannot see.

const ORIGIN = 'https://nivaro.example.com'

function access(over: Partial<{ hidden: string[]; cols: string[]; queries: string[] }> = {}) {
  const hidden = new Set(over.hidden ?? [])
  const cols = new Set(over.cols ?? ['invoices'])
  const queries = new Set(over.queries ?? [])
  const a: CodeAccess = {
    collection: async (c) => cols.has(c),
    path: async (_c, path) => !hidden.has(path[0]),
    savedQuery: async (slug) => queries.has(slug)
  }
  return a
}

const agg = (input: Record<string, unknown>, summary = 'count by vendor: 4 group(s)') => ({
  tool: 'aggregate',
  input: { collection: 'invoices', ...input },
  summary
})

describe('answerCode (#2766)', () => {
  it('a grouped count becomes aggregateItems + the REST aggregate request', async () => {
    const { snippets } = await answerCode(
      [agg({ op: 'count', group_by: 'vendor', filter: { status: { _eq: 'waiting' } } })],
      ORIGIN,
      access()
    )
    expect(snippets).toHaveLength(1)
    const s = snippets[0]
    expect(s.title).toBe('Count invoices by vendor')
    expect(s.sdk).toContain("aggregateItems('invoices', {")
    expect(s.sdk).toContain("groupBy: ['vendor']")
    expect(s.sdk).toContain('countAll: true')
    expect(s.sdk).toContain("sort: ['-countAll']")
    expect(s.sdk).toContain("createNivaro('https://nivaro.example.com'")
    expect(s.rest).toMatch(/^GET https:\/\/nivaro\.example\.com\/api\/items\/invoices\/aggregate\?/)
    expect(s.rest).toContain(
      `filter=${encodeURIComponent(JSON.stringify({ status: { _eq: 'waiting' } }))}`
    )
    expect(s.rest).toContain('groupBy=vendor')
    expect(s.curl).toContain('Authorization: Bearer $NIVARO_TOKEN')
    expect(s.omitted).toBe(0)
  })

  it('a condition on a field the reader cannot see is left out, value and all', async () => {
    const { snippets } = await answerCode(
      [
        agg({
          op: 'sum',
          field: 'amount',
          filter: { _and: [{ status: { _eq: 'open' } }, { salary: { _gt: 90000 } }] }
        })
      ],
      ORIGIN,
      access({ hidden: ['salary'] })
    )
    const s = snippets[0]
    expect(s.sdk).not.toContain('salary')
    expect(s.sdk).not.toContain('90000')
    expect(s.rest).not.toContain('salary')
    expect(s.omitted).toBe(1)
    expect(s.sdk).toContain("sum: ['amount']")
  })

  it('a read whose figure or grouping is a hidden field is skipped whole', async () => {
    const out = await answerCode(
      [agg({ op: 'sum', field: 'salary' }), agg({ op: 'count', group_by: 'salary' })],
      ORIGIN,
      access({ hidden: ['salary'] })
    )
    expect(out.snippets).toEqual([])
    expect(out.skipped).toBe(2)
  })

  it('an unreadable collection, an errored call and a tool with no API twin give no code', async () => {
    const out = await answerCode(
      [
        { tool: 'query_items', input: { collection: 'payroll' }, summary: '2 row(s)' },
        { tool: 'query_items', input: { collection: 'invoices' }, summary: 'error: bad field' },
        { tool: 'propose_plan', input: { title: 'x' }, summary: 'plan' }
      ],
      ORIGIN,
      access()
    )
    expect(out.snippets).toEqual([])
    expect(out.skipped).toBe(1)
  })

  it('query_items keeps only readable columns and sorts', async () => {
    const { snippets } = await answerCode(
      [
        {
          tool: 'query_items',
          input: {
            collection: 'invoices',
            fields: ['id', 'vendor.name', 'salary'],
            sort: ['-salary', '-created_at'],
            search: 'acme',
            limit: 500
          },
          summary: '3 of 3 row(s)'
        }
      ],
      ORIGIN,
      access({ hidden: ['salary'] })
    )
    const s = snippets[0]
    expect(s.sdk).toContain("fields: ['id', 'vendor.name']")
    expect(s.sdk).toContain("sort: ['-created_at']")
    expect(s.sdk).toContain('limit: 200')
    expect(s.omitted).toBe(2)
  })

  it('a saved query appears only when the reader may run it', async () => {
    const trace = [
      {
        tool: 'run_custom_query',
        input: { slug: 'aging', params: { days: 30 } },
        summary: 'aging: 5 row(s)'
      }
    ]
    expect((await answerCode(trace, ORIGIN, access())).snippets).toEqual([])
    const { snippets } = await answerCode(trace, ORIGIN, access({ queries: ['aging'] }))
    expect(snippets[0].sdk).toContain("executeCustomQuery('aging', {\n  days: 30\n})")
    expect(snippets[0].rest).toContain(
      'POST https://nivaro.example.com/api/custom-queries/aging/execute'
    )
  })

  it('a repeated read is shown once', async () => {
    const e = agg({ op: 'count', group_by: 'vendor' })
    const { snippets } = await answerCode([e, e], ORIGIN, access())
    expect(snippets).toHaveLength(1)
  })
})

describe('jsLiteral', () => {
  it('writes single-quoted, escaped literals and quotes keys that need it', () => {
    expect(jsLiteral({ name: "O'Neil", $state: { _in: ['a'] } })).toBe(
      "{\n  name: 'O\\'Neil',\n  '$state': {\n    _in: ['a']\n  }\n}"
    )
  })
})
