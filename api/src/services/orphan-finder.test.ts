import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: {}, resolveDb: () => ({}) }))
vi.mock('./job-runs.js', () => ({ startJobRun: vi.fn() }))

import { StatementCancelled } from './bounded-sql.js'
import { type CheckResult, runSweepLoop, type SweepState, sweepStore } from './orphan-finder.js'
import type { OrphanCheck } from './orphan-finder-logic.js'

const check = (key: string): OrphanCheck => ({
  key,
  kind: 'm2o',
  child: 'a',
  fk: 'b_id',
  field: 'b_id',
  parent: 'b',
  parent_key: 'id',
  child_pk: 'id',
  fk_nullable: true,
  enforced: false,
  compare: 'plain',
  text_fk: false,
  referenced_by: [],
  other_leg: null
})

const fresh = (total: number): SweepState => ({
  id: 'sw_test',
  status: 'running',
  by: 'U1',
  started_at: 1,
  finished_at: null,
  total,
  done: 0,
  current: null,
  results: {}
})

describe('runSweepLoop', () => {
  it('scans every check, saves after each and keeps going past a failed one', async () => {
    const saves: number[] = []
    const store = {
      save: async (s: SweepState) => {
        saves.push(s.done)
      },
      cancelled: async () => false
    }
    const inspect = async (c: OrphanCheck): Promise<CheckResult> => {
      if (c.key === 'slow') throw new StatementCancelled('timeout')
      if (c.key === 'bad') throw new Error('Invalid column name')
      return { key: c.key, orphans: c.key === 'x' ? 3 : 0, samples: [], ms: 5, at: 2 }
    }
    const end = await runSweepLoop({
      state: fresh(4),
      checks: [check('x'), check('slow'), check('bad'), check('y')],
      store,
      inspect
    })
    expect(end.status).toBe('done')
    expect(end.done).toBe(4)
    expect(end.results.x.orphans).toBe(3)
    expect(end.results.slow).toMatchObject({ orphans: null, error: 'Took too long; skipped' })
    // A driver message never reaches the page.
    expect(end.results.bad.error).toBe('Could not be read')
    expect(end.current).toBeNull()
    expect(end.finished_at).not.toBeNull()
    expect(saves.length).toBe(5)
  })

  it('stops between checks when cancelled', async () => {
    let calls = 0
    const end = await runSweepLoop({
      state: fresh(3),
      checks: [check('a'), check('b'), check('c')],
      store: { save: async () => {}, cancelled: async () => calls >= 1 },
      inspect: async (c) => {
        calls++
        return { key: c.key, orphans: 0, samples: [], ms: 1, at: 1 }
      }
    })
    expect(end.status).toBe('cancelled')
    expect(end.done).toBe(1)
  })
})

describe('sweepStore without Redis', () => {
  it('holds one lease per tenant and keeps the last state', async () => {
    const store = sweepStore(null)
    expect(await store.claim('one')).toBe(true)
    expect(await store.claim('two')).toBe(false)
    await store.release('two') // not the holder: no effect
    expect(await store.claim('three')).toBe(false)
    await store.release('one')
    expect(await store.claim('three')).toBe(true)
    await store.release('three')

    await store.save(fresh(2))
    expect((await store.load())?.id).toBe('sw_test')
    expect(await store.cancelled('sw_test')).toBe(false)
    await store.cancel('sw_test')
    expect(await store.cancelled('sw_test')).toBe(true)
  })

  it('uses Redis NX for the lease when it is there', async () => {
    const kv = new Map<string, string>()
    const redis = {
      get: async (k: string) => kv.get(k) ?? null,
      setex: async (k: string, _t: number, v: string) => kv.set(k, v),
      set: async (...a: Array<string | number>) => {
        const [k, v] = [String(a[0]), String(a[1])]
        if (a.includes('NX') && kv.has(k)) return null
        kv.set(k, v)
        return 'OK'
      },
      del: async (k: string) => kv.delete(k)
    }
    const a = sweepStore(redis)
    expect(await a.claim('r1')).toBe(true)
    expect(await sweepStore(redis).claim('r2')).toBe(false)
    await a.release('r1')
    expect(await sweepStore(redis).claim('r2')).toBe(true)
  })
})
