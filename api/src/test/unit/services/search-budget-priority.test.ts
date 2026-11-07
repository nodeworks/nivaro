import { describe, expect, it, vi } from 'vitest'

// Army 7 b16 N1: a project number ("201943") answered nothing 2 of 3 times on a quiet
// staging. The extra kinds (notes, files) took every slot of the search while the record
// half was still planning; the exact-id seek queued behind their scans and the deadline
// cut it. Exact seeks now jump the queue, may use one reserved slot, and run to a floor
// past the deadline; the cheapest record statements ask for a slot first.

const calls = vi.hoisted(() => ({
  started: [] as string[],
  /** ms each statement takes, by its sql (default 20). */
  took: {} as Record<string, number>
}))

vi.mock('../../../services/bounded-sql.js', async (orig) => {
  const real = await orig<typeof import('../../../services/bounded-sql.js')>()
  return {
    ...real,
    boundedRaw: vi.fn(
      (sql: string, _b: unknown, opts: { timeoutMs: number; signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          calls.started.push(sql)
          const ms = calls.took[sql] ?? 20
          const cut = () => reject(new real.StatementCancelled('timeout'))
          if (opts.signal?.aborted) return cut()
          const t = setTimeout(() => resolve([{ c: 'x', id: sql }]), ms)
          const limit = setTimeout(() => {
            clearTimeout(t)
            cut()
          }, opts.timeoutMs)
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            clearTimeout(limit)
            cut()
          })
        })
    )
  }
})

import { cheapestFirst } from '../../../routes/global-search.js'
import { SearchBudget } from '../../../services/search-budget.js'

const reset = () => {
  calls.started = []
  calls.took = {}
}

describe('SearchBudget priority and the reserved slot', () => {
  it('a queued higher-priority statement gets the next free slot first', async () => {
    reset()
    const b = new SearchBudget(2_000, 2)
    for (const s of ['scan1', 'scan2']) calls.took[s] = 60
    const parts = [
      b.query('scan1', []),
      b.query('scan2', []),
      b.query('files', []), // priority 0, queued first
      b.query('records', [], { priority: 1 }) // queued later, served first
    ]
    await Promise.all(parts)
    expect(calls.started.slice(2)).toEqual(['records', 'files'])
    b.finish()
  })

  it('an exact seek takes the reserved slot while every normal slot is busy', async () => {
    reset()
    const b = new SearchBudget(2_000, 2)
    calls.took = { scan1: 300, scan2: 300, scan3: 300 }
    const scans = ['scan1', 'scan2', 'scan3'].map((s) => b.query(s, []))
    const t = Date.now()
    const seek = await b.runQuery('exact', 'seek', [], {
      priority: 2,
      reserved: true,
      floorMs: 800
    })
    expect(seek).toEqual([{ c: 'x', id: 'seek' }])
    expect(Date.now() - t).toBeLessThan(200) // did not wait behind the scans
    expect(calls.started).not.toContain('scan3') // the cap held for normal statements
    await Promise.all(scans)
    b.finish()
  })

  it('never runs more than concurrency + 1 statements, the extra only reserved', async () => {
    reset()
    const b = new SearchBudget(2_000, 2)
    let peak = 0
    const watch = setInterval(() => {
      peak = Math.max(peak, b.running())
    }, 2)
    for (const s of ['a', 'b', 'c', 'd', 'e']) calls.took[s] = 40
    await Promise.all([
      ...['a', 'b', 'c', 'd'].map((s) => b.query(s, [])),
      b.runQuery('exact', 'e', [], { reserved: true, priority: 2, floorMs: 500 })
    ])
    clearInterval(watch)
    expect(peak).toBeLessThanOrEqual(3)
    b.finish()
  })
})

describe('SearchBudget floor (an exact seek that started late is not cut)', () => {
  it('a floored part runs past the deadline; an unfloored one is cut', async () => {
    reset()
    const b = new SearchBudget(30, 4)
    calls.took = { late: 120, seek: 120 }
    const [cut, kept] = await Promise.all([
      b.runQuery('records', 'late', []),
      b.runQuery('exact', 'seek', [], { floorMs: 800, reserved: true, priority: 2 })
    ])
    expect(cut).toEqual([])
    expect(b.timedOut.has('records')).toBe(true)
    expect(kept).toEqual([{ c: 'x', id: 'seek' }])
    expect(b.timedOut.has('exact')).toBe(false)
    b.finish()
  })

  it('a floored part asked for after the deadline still runs', async () => {
    reset()
    const b = new SearchBudget(0, 4)
    await new Promise((r) => setTimeout(r, 5))
    expect(b.expired()).toBe(true)
    const out = await b.runQuery('exact', 'seek', [], { floorMs: 500 })
    expect(out).toHaveLength(1)
    b.finish()
  })

  it('the floor ends at its own limit, and finish() stops it at once', async () => {
    reset()
    const b = new SearchBudget(10, 4)
    calls.took = { slow: 5_000, slower: 5_000 }
    const t = Date.now()
    expect(await b.runQuery('exact', 'slow', [], { floorMs: 60 })).toEqual([])
    expect(Date.now() - t).toBeLessThan(1_000)
    expect(b.timedOut.has('exact')).toBe(true)

    const b2 = new SearchBudget(10, 4)
    const p = b2.runQuery('exact', 'slower', [], { floorMs: 5_000 })
    setTimeout(() => b2.finish(), 20)
    const t2 = Date.now()
    expect(await p).toEqual([])
    expect(Date.now() - t2).toBeLessThan(1_000)
    b.finish()
  })

  it('a waiter cut at the deadline leaves the queue (no slot is handed to it)', async () => {
    reset()
    const b = new SearchBudget(40, 1)
    calls.took = { hog: 200 }
    const hog = b.run('hog', [], () => b.query('hog', []))
    const waiting = b.run('queued', [], () => b.query('queued', []))
    expect(await waiting).toEqual([])
    expect(b.timedOut.has('queued')).toBe(true)
    await hog
    expect(calls.started).not.toContain('queued')
    b.finish()
  })
})

describe('cheapestFirst — the order record statements ask for a slot', () => {
  it('the packed small tables first, then big tables smallest first', () => {
    const g = (rows: number[]) => rows.map((r, i) => ({ collection: `t${r}_${i}`, rows: r }))
    const ordered = cheapestFirst([g([400_000]), g([90_000]), g([800, 12_000]), g([25_000])])
    expect(ordered.map((x) => x.map((a) => a.rows))).toEqual([
      [800, 12_000],
      [25_000],
      [90_000],
      [400_000]
    ])
  })
})
