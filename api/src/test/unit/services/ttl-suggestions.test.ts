import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  assessWriteSafety,
  buildTtlSuggestions,
  recommend,
  ttlOptions,
  writeCapableIn
} from '../../../services/ttl-suggestions.js'

describe('writeCapableIn', () => {
  it('lets plain reads and temp-table scratch work through', () => {
    expect(writeCapableIn('SELECT id, updated_at FROM t WHERE created_at > @d')).toBeNull()
    expect(writeCapableIn('INSERT INTO #b EXEC rpt_x')).toBeNull()
    expect(writeCapableIn('SELECT a INTO #tmp FROM t; DROP TABLE #tmp')).toBeNull()
    expect(writeCapableIn("SELECT 'delete me' AS note -- update later")).toBeNull()
  })
  it('flags real writes and dynamic SQL', () => {
    expect(writeCapableIn('UPDATE t SET a = 1')).toBe('update')
    expect(writeCapableIn('DELETE FROM t')).toBe('delete')
    expect(writeCapableIn('SELECT a INTO real_table FROM t')).toMatch(/^into/)
    expect(writeCapableIn("EXEC('select 1')")).toMatch(/^exec/)
    expect(writeCapableIn('EXEC sp_executesql @s')).toBe('sp_executesql')
  })
})

describe('assessWriteSafety', () => {
  it('follows EXEC into the procedure and nested procedures', async () => {
    const procs: Record<string, string> = {
      outer_read: 'SELECT 1; EXEC inner_write',
      inner_write: 'UPDATE t SET a = 1',
      pure: 'SELECT * FROM t'
    }
    const read = async (n: string) => procs[n] ?? null
    expect((await assessWriteSafety('EXEC pure', read)).safe).toBe(true)
    const w = await assessWriteSafety('EXEC outer_read', read)
    expect(w.safe).toBe(false)
    expect(w.reason).toContain('inner_write')
  })
  it('treats an unreadable or system procedure as unsafe', async () => {
    expect((await assessWriteSafety('EXEC ghost', async () => null)).safe).toBe(false)
    expect((await assessWriteSafety('EXEC sp_who', async () => 'SELECT 1')).safe).toBe(false)
  })
})

describe('ttlOptions', () => {
  it('saves hits x average run, bounded by one miss per window', () => {
    // 5000 calls/day, 2 s each
    const o = ttlOptions(5000, 2000)
    const five = o.find((x) => x.ttl_seconds === 300)
    expect(five?.hits_per_day).toBe(5000 - 288)
    expect(five?.saved_ms_per_day).toBe((5000 - 288) * 2000)
    expect(five?.staleness).toBe('up to 5 min old')
  })
  it('gives a one-call-a-minute caller no hit at a 60 s TTL', () => {
    expect(ttlOptions(1440, 2000).find((x) => x.ttl_seconds === 60)).toBeUndefined()
  })
  it('drops options that save nothing for rare callers', () => {
    expect(ttlOptions(20, 3000)).toEqual([])
  })
  it('recommends the shortest TTL that earns most of the best saving', () => {
    const o = ttlOptions(2000, 1000)
    expect(recommend(o)?.ttl_seconds).toBe(300)
    expect(recommend([])).toBeNull()
  })
})

describe('buildTtlSuggestions', () => {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const base = {
    id: 1,
    slug: 'slow',
    name: 'Slow',
    sql_text: 'SELECT 1',
    cache_ttl: 0,
    enabled: true,
    stat: { hits: 0, misses: 0, uncached_runs: 4000, avg_exec_ms: 1500 }
  }
  const safe = async () => ({ safe: true, reason: null })
  it('offers a TTL to a slow uncached query', async () => {
    const r = await buildTtlSuggestions([base], since, Date.now(), safe)
    expect(r.suggestions).toHaveLength(1)
    expect(r.suggestions[0].recommended.staleness).toMatch(/old$/)
    expect(r.suggestions[0].low_confidence).toBe(false)
  })
  it('skips cached, fast, disabled, idle and unseen queries', async () => {
    const r = await buildTtlSuggestions(
      [
        { ...base, id: 2, cache_ttl: 300 },
        { ...base, id: 3, stat: { ...base.stat, avg_exec_ms: 100 } },
        { ...base, id: 4, enabled: false },
        { ...base, id: 5, stat: { ...base.stat, uncached_runs: 2 } },
        { ...base, id: 6, stat: null }
      ],
      since,
      Date.now(),
      safe
    )
    expect(r.suggestions).toEqual([])
    expect(r.withheld).toEqual([])
  })
  it('withholds a query that may write, naming why', async () => {
    const r = await buildTtlSuggestions([base], since, Date.now(), async () => ({
      safe: false,
      reason: 'the procedure p contains "update"'
    }))
    expect(r.suggestions).toEqual([])
    expect(r.withheld[0]).toMatchObject({ slug: 'slow', reason: expect.stringContaining('update') })
  })
  it('flags a short observation window as low confidence', async () => {
    const fresh = new Date(Date.now() - 1_800_000).toISOString()
    const r = await buildTtlSuggestions([base], fresh, Date.now(), safe)
    expect(r.suggestions[0].low_confidence).toBe(true)
  })
})
