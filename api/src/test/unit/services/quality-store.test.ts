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

  async function twoRedChecks() {
    const s = await import('../../../services/quality/store.js')
    const { diffRows } = await import('../../../services/quality/diff.js')
    const db = (await fresh({
      nivaro_quality_runs: [
        { id: 'R', target: 'T', status: 'done', verified_at: new Date('2026-10-06T05:00:00Z') }
      ]
    })) as any
    const base = [{ key: 'k', values: { v: 1 } }]
    const cur = [{ key: 'k', values: { v: 2 } }]
    for (const id of ['a.one', 'b.two']) {
      const diff = diffRows({}, base, cur, [])
      await s.saveSide(db, 'R', id, 'baseline', { rows: base, durationMs: 1 })
      await s.saveSide(db, 'R', id, 'current', { rows: cur, durationMs: 1 })
      await s.saveDiff(db, 'R', id, diff.rows)
      await s.saveResult(
        db,
        'R',
        { id, area: 'counts', label: id, description: '' },
        { diff, durationMs: 1 }
      )
      await db('nivaro_quality_known').insert({
        check_id: id,
        match: '{"key":"k"}',
        reason: 'known'
      })
    }
    await db('nivaro_quality_runs').where({ id: 'R' }).update({ totals: 'before' })
    // Calls the store makes go through this proxy; `onSide(check)` runs when a
    // check's stored side is read — between one check's save and the next.
    let onSide: (check: string) => void = () => {}
    const app = new Proxy(db, {
      apply: (t, _this, args: unknown[]) => {
        const b = t(...args)
        if (args[0] === 'nivaro_quality_rows') {
          const where = b.where
          b.where = (w: Record<string, unknown>) => {
            if (w?.side === 'baseline') onSide(String(w.check_id))
            return where(w)
          }
        }
        return b
      }
    })
    const statusOf = (id: string) =>
      (db.state.tables.nivaro_quality_results as Array<Record<string, unknown>>).find(
        (r) => r.check_id === id
      )?.status
    return { s, db, app, statusOf, setHook: (f: (c: string) => void) => (onSide = f) }
  }

  it('stops a re-diff when the run starts verifying mid-loop', async () => {
    const { s, db, app, statusOf, setHook } = await twoRedChecks()
    setHook((check) => {
      if (check === 'b.two') db.state.tables.nivaro_quality_runs[0].status = 'verifying'
    })
    expect(await s.rediffRun(app, 'R')).toEqual({
      rediffed: false,
      reason: 'the run is being verified'
    })
    expect(statusOf('a.one')).toBe('amber')
    expect(statusOf('b.two')).toBe('red')
    expect((await s.loadDiff(db, 'R', 'b.two'))?.[0].expected).toBe(false)
    expect(db.state.tables.nivaro_quality_runs[0].totals).toBe('before')
  })

  it('stops a re-diff when the run was verified again mid-loop', async () => {
    const { s, db, app, statusOf, setHook } = await twoRedChecks()
    setHook((check) => {
      if (check === 'b.two')
        db.state.tables.nivaro_quality_runs[0].verified_at = new Date('2026-10-06T06:00:00Z')
    })
    expect((await s.rediffRun(app, 'R')).rediffed).toBe(false)
    expect(statusOf('b.two')).toBe('red')
    expect(db.state.tables.nivaro_quality_runs[0].totals).toBe('before')
  })

  it('keeps legacy links on re-diffed rows', async () => {
    const { s, db, app } = await twoRedChecks()
    const stored = (await s.loadDiff(db, 'R', 'a.one')) ?? []
    stored[0].legacy = 'https://legacy/k'
    await s.saveDiff(db, 'R', 'a.one', stored)
    expect((await s.rediffRun(app, 'R')).rediffed).toBe(true)
    const rows = (await s.loadDiff(db, 'R', 'a.one')) ?? []
    expect(rows.find((r) => r.key === stored[0].key)?.legacy).toBe('https://legacy/k')
    expect((await s.loadDiff(db, 'R', 'b.two'))?.[0].legacy).toBeUndefined()
  })

  it('re-diffs every check when nothing moves, and never a run without results', async () => {
    const { s, db, app, statusOf } = await twoRedChecks()
    expect(await s.rediffRun(app, 'R')).toEqual({ rediffed: true })
    expect([statusOf('a.one'), statusOf('b.two')]).toEqual(['amber', 'amber'])
    expect(JSON.parse(db.state.tables.nivaro_quality_runs[0].totals)).toEqual({
      green: 0,
      amber: 2,
      red: 0,
      error: 0
    })
    await db('nivaro_quality_runs').insert({ id: 'E', target: 'T', status: 'captured' })
    expect((await s.rediffRun(app, 'E')).rediffed).toBe(false)
    expect(
      db.state.tables.nivaro_quality_runs.find((r: any) => r.id === 'E').totals
    ).toBeUndefined()
    // A run already verifying is left alone from the start.
    db.state.tables.nivaro_quality_runs[0].status = 'verifying'
    expect((await s.rediffRun(app, 'R')).rediffed).toBe(false)
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

  it('re-validates stored known entries and skips the invalid ones with a log line', async () => {
    const s = await import('../../../services/quality/store.js')
    const db = await fresh({
      nivaro_quality_known: [
        { id: 1, check_id: 'a.b', match: '{"key":"w:*"}', reason: 'ok' },
        { id: 2, check_id: 'a.b', match: '{}', reason: 'empty' },
        { id: 3, check_id: 'a.b', match: '{"key":"*a*b*c*d*e"}', reason: 'too many stars' },
        { id: 4, check_id: 'a.b', match: '{"cluster":{"__proto__":"x"}}', reason: 'proto' },
        { id: 5, check_id: 'a.b', match: 'not json', reason: 'broken' }
      ]
    })
    const logs: string[] = []
    const known = await s.loadKnown(db, (m) => logs.push(m))
    expect(known.map((k) => k.id)).toEqual([1])
    expect(logs).toHaveLength(4)
    expect(logs[0]).toMatch(/known difference 2/)
  })

  it('re-diffs only the listed checks and recomputes the run totals from every result', async () => {
    const { s, db, app, statusOf } = await twoRedChecks()
    expect(await s.rediffRun(app, 'R', { checkIds: ['a.one'] })).toEqual({ rediffed: true })
    expect([statusOf('a.one'), statusOf('b.two')]).toEqual(['amber', 'red'])
    expect(JSON.parse(db.state.tables.nivaro_quality_runs[0].totals)).toEqual({
      green: 0,
      amber: 1,
      red: 1,
      error: 0
    })
  })

  it('treats a run stuck verifying for over two hours as stale', async () => {
    const { s, db, app, statusOf } = await twoRedChecks()
    const run = db.state.tables.nivaro_quality_runs[0]
    run.status = 'verifying'
    run.verify_started_at = new Date(Date.now() - 60 * 60 * 1000)
    expect((await s.rediffRun(app, 'R')).rediffed).toBe(false)
    run.verify_started_at = new Date(Date.now() - 3 * 60 * 60 * 1000)
    expect(await s.rediffRun(app, 'R')).toEqual({ rediffed: true })
    expect(statusOf('a.one')).toBe('amber')
    expect(s.isStaleVerifying({ status: 'done', verify_started_at: null })).toBe(false)
  })

  it('refuses to inflate a stored row list past the size limit', async () => {
    const s = await import('../../../services/quality/store.js')
    const rows = Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, values: { v: i } }))
    const text = s.encodeRows(rows)
    expect(s.decodeRows(text)).toHaveLength(200)
    expect(() => s.decodeRows(text, 100)).toThrow()
    expect(s.MAX_DECODED_BYTES).toBe(256 * 1024 * 1024)
  })
})
