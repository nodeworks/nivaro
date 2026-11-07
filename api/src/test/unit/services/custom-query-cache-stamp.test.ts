import { describe, expect, it } from 'vitest'
import { customQueryCacheKey, customQuerySqlStamp } from '../../../services/custom-query-cache.js'

// Army 6 M15: a rewritten query must never be answered from an entry the old
// SQL computed (report-query-fixes rewrote rpt-* SQL while 12-h entries kept
// serving the old numbers).
describe('custom query cache key carries the SQL stamp', () => {
  const def = { sql_text: 'EXEC spend :year', scope_params: null }

  it('same SQL + params → same key', () => {
    expect(customQueryCacheKey('s', { year: 2026 }, def)).toBe(
      customQueryCacheKey('s', { year: 2026 }, { ...def })
    )
  })

  it('a rewritten SQL text or scope declaration → a different key', () => {
    const k = customQueryCacheKey('s', { year: 2026 }, def)
    expect(
      customQueryCacheKey('s', { year: 2026 }, { ...def, sql_text: 'EXEC spend2 :year' })
    ).not.toBe(k)
    expect(
      customQueryCacheKey(
        's',
        { year: 2026 },
        { ...def, scope_params: '{"year":{"dimension":"y"}}' }
      )
    ).not.toBe(k)
  })

  it('keeps the cq:<slug>: prefix the slug bust scans for', () => {
    const k = customQueryCacheKey('rpt-spend', { year: 2026 }, def)
    expect(k.startsWith('cq:rpt-spend:')).toBe(true)
    expect(k).toBe(`cq:rpt-spend:${customQuerySqlStamp(def)}:{"year":2026}`)
    expect(customQuerySqlStamp(def)).toMatch(/^[0-9a-f]{10}$/)
  })
})
