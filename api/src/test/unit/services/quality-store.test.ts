import { describe, expect, it } from 'vitest'
import { decodeRows, encodeRows, totalsOf } from '../../../services/quality/store.js'

describe('quality store helpers', () => {
  it('round-trips rows through gzip', () => {
    const rows = [{ key: 'a', values: { v: 1, s: 'x', n: null } }]
    expect(decodeRows(encodeRows(rows as never))).toEqual(rows)
  })
  it('latestRunForTarget returns the newest run of the target only', async () => {
    const { createTestDb } = await import('@nivaro/extension-kit')
    const { latestRunForTarget } = await import('../../../services/quality/store.js')
    const db = createTestDb({
      tables: {
        nivaro_quality_runs: [
          { id: 'A', target: 'T', status: 'done', started_at: new Date('2026-10-01') },
          { id: 'B', target: 'T', status: 'error', started_at: new Date('2026-10-02') },
          { id: 'C', target: 'U', status: 'done', started_at: new Date('2026-10-03') }
        ]
      }
    })
    expect(await latestRunForTarget(db as never, 'T')).toEqual({ id: 'B', status: 'error' })
    expect(await latestRunForTarget(db as never, 'V')).toBeNull()
  })
  it('totals statuses', () => {
    expect(totalsOf(['green', 'red', 'red', 'error'])).toEqual({
      green: 1,
      amber: 0,
      red: 2,
      error: 1
    })
  })
})

describe('quality store tables', () => {
  async function fresh(tables: Record<string, Record<string, unknown>[]> = {}) {
    const { createTestDb } = await import('@nivaro/extension-kit')
    return createTestDb({
      tables: {
        nivaro_quality_runs: [],
        nivaro_quality_rows: [],
        nivaro_quality_results: [],
        nivaro_quality_known: [],
        ...tables
      }
    }) as never
  }

  it('saves, replaces and loads a side', async () => {
    const s = await import('../../../services/quality/store.js')
    const db = await fresh()
    await s.saveSide(db, 'R', 'c.one', 'baseline', {
      rows: [{ key: 'k', values: { v: 1 } }],
      durationMs: 10
    })
    await s.saveSide(db, 'R', 'c.one', 'baseline', {
      rows: [{ key: 'k', values: { v: 2 } }],
      durationMs: 11
    })
    expect(await s.loadSide(db, 'R', 'c.one', 'baseline')).toEqual({
      rows: [{ key: 'k', values: { v: 2 } }],
      error: null
    })
    await s.saveSide(db, 'R', 'c.one', 'current', { error: 'boom', durationMs: 5 })
    expect(await s.loadSide(db, 'R', 'c.one', 'current')).toEqual({ rows: null, error: 'boom' })
    expect(await s.loadSide(db, 'R', 'c.two', 'baseline')).toEqual({ rows: null, error: null })
  })

  it('stores at most 500 rows on the result, all of them on the diff side', async () => {
    const s = await import('../../../services/quality/store.js')
    const { diffRows } = await import('../../../services/quality/diff.js')
    const db = await fresh()
    const base = Array.from({ length: 600 }, (_, i) => ({ key: `k${i}`, values: { v: 1 } }))
    const cur = base.map((r) => ({ ...r, values: { v: 2 } }))
    const diff = diffRows({}, base, cur, [])
    await s.saveDiff(db, 'R', 'c.one', diff.rows)
    await s.saveResult(
      db,
      'R',
      { id: 'c.one', area: 'counts', label: 'One', description: 'd', tolerance: { abs: 1 } },
      { diff, durationMs: 3 }
    )
    const results = await (db as any)('nivaro_quality_results').select('*')
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('red')
    expect(results[0].tolerance).toBe('{"abs":1}')
    expect(JSON.parse(results[0].rows)).toHaveLength(500)
    expect((await s.loadDiff(db, 'R', 'c.one'))?.length).toBe(600)
  })

  it('rediffs from stored sides with known differences and built-in reasons', async () => {
    const s = await import('../../../services/quality/store.js')
    const { diffRows } = await import('../../../services/quality/diff.js')
    const db = await fresh({ nivaro_quality_runs: [{ id: 'R', target: 'T', status: 'done' }] })
    const base = [
      { key: 'a', values: { v: 1 } },
      { key: 'b', values: { v: 1 } },
      { key: 'c', values: { v: 1 } }
    ]
    const cur = [
      { key: 'a', values: { v: 2 } },
      { key: 'b', values: { v: 2 } },
      { key: 'c', values: { v: 1 } }
    ]
    const check = { expected: (b: { key: string } | null) => (b?.key === 'a' ? 'by design' : null) }
    const diff = diffRows(check as never, base, cur, [])
    expect(diff.status).toBe('red')
    await s.saveSide(db, 'R', 'x.y', 'baseline', { rows: base, durationMs: 1 })
    await s.saveSide(db, 'R', 'x.y', 'current', { rows: cur, durationMs: 1 })
    await s.saveDiff(db, 'R', 'x.y', diff.rows)
    await s.saveResult(
      db,
      'R',
      { id: 'x.y', area: 'counts', label: 'X', description: '' },
      { diff, durationMs: 7 }
    )
    await (db as any)('nivaro_quality_known').insert({
      id: 9,
      check_id: 'x.y',
      match: '{"key":"b"}',
      reason: 'known b'
    })
    await s.rediffRun(db, 'R')
    const [res] = await (db as any)('nivaro_quality_results').select('*')
    expect(res.status).toBe('amber')
    expect(res.duration_ms).toBe(7)
    const rows = await s.loadDiff(db, 'R', 'x.y')
    expect(rows?.find((r) => r.key === 'a')?.reason).toBe('by design')
    expect(rows?.find((r) => r.key === 'b')).toMatchObject({ known_id: 9, reason: 'known b' })
    const [run] = await (db as any)('nivaro_quality_runs').select('*')
    expect(JSON.parse(run.totals)).toEqual({ green: 0, amber: 1, red: 0, error: 0 })
  })

  it('prunes all but the newest runs of a target', async () => {
    const s = await import('../../../services/quality/store.js')
    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: `R${i}`,
      target: 'T',
      status: 'done',
      started_at: new Date(2026, 9, i + 1)
    }))
    const db = await fresh({
      nivaro_quality_runs: [
        ...runs,
        { id: 'U', target: 'U', status: 'done', started_at: new Date(2020, 0, 1) }
      ],
      nivaro_quality_rows: [{ run: 'R0', check_id: 'c', side: 'baseline' }]
    })
    expect(await s.pruneRuns(db, 'T', 3)).toBe(2)
    const left = (await (db as any)('nivaro_quality_runs').pluck('id')).sort()
    expect(left).toEqual(['R2', 'R3', 'R4', 'U'])
    expect(await (db as any)('nivaro_quality_rows').select('*')).toEqual([])
  })

  it('counts idle runs for known entries that matched nothing', async () => {
    const s = await import('../../../services/quality/store.js')
    const db = await fresh({
      nivaro_quality_known: [
        { id: 1, check_id: 'a.b', match: '{}', reason: 'r', idle_runs: 2, matched_count: 0 },
        { id: 2, check_id: 'other', match: '{}', reason: 'r', idle_runs: 0, matched_count: 0 }
      ]
    })
    await s.recordKnownHits(db, 'R', ['a.b'], new Map())
    const rows = await (db as any)('nivaro_quality_known').orderBy('id').select('*')
    expect(rows.map((r: { idle_runs: number }) => r.idle_runs)).toEqual([3, 0])
  })
})
