import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../../fake-sql.js'

// #16/#17 — purgeActivityRows: the one delete path for nivaro_activity. Legal holds, rows a
// revision points at and the trail head stay; deleted sealed rows leave bridges.

const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)

const state = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  candidates: [] as Array<Record<string, unknown>>,
  served: false
}))

vi.mock('../../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../../fake-sql.js')
  const fake = makeFakeDb((q) => {
    state.ran.push(q)
    if (q.sql.includes('next_seq'))
      return [
        { id: 1, next_seq: 2 },
        { id: 2, next_seq: 3 }
      ]
    if (q.method === 'select' && q.sql.includes('nivaro_activity_seal_bridges')) return []
    if (q.method === 'select' && q.sql.includes('[seal_seq] in'))
      return [
        { id: 2, seal_seq: 2 },
        { id: 3, seal_seq: 3 }
      ]
    if (q.method === 'select' && q.sql.includes('nivaro_legal_holds')) {
      if (state.served) return []
      state.served = true
      return state.candidates
    }
    if (q.method === 'del') return 2
    if (q.method === 'insert') return []
    return []
  })
  const db = new Proxy(fake, {
    get(target, prop, receiver) {
      if (prop === 'transaction') return async (fn: (trx: unknown) => Promise<unknown>) => fn(fake)
      return Reflect.get(target, prop, receiver)
    }
  })
  return { db }
})
vi.mock('../../../../services/activity-trail/store.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return {
    ...orig,
    trailReady: vi.fn(async () => true),
    readHead: vi.fn(async () => ({ seq: 10, hash: 'f'.repeat(64), id: 10, at: null }))
  }
})
vi.mock('../../../../services/legal-holds.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return { ...orig, legalHoldsReady: vi.fn(async () => true) }
})

import { purgeActivityRows } from '../../../../services/activity-trail/purge.js'

beforeEach(() => {
  state.ran = []
  state.served = false
  state.candidates = [
    { id: 1, seal_seq: 1, seal_hash: H1 },
    { id: 2, seal_seq: 2, seal_hash: `${H2}  ` }
  ]
})

describe('purgeActivityRows', () => {
  it('skips held records, rows a revision points at, and the head', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z')
    await purgeActivityRows((q) => {
      void q.where('timestamp', '<', cutoff)
    })
    const pick = state.ran.find((q) => q.sql.includes('nivaro_legal_holds'))!
    expect(pick.sql).toMatch(/not exists \(select 1 from \[nivaro_legal_holds\] as \[lh\]/i)
    expect(pick.sql).toMatch(/\[lh\]\.\[released_at\] is null/i)
    expect(pick.sql).toMatch(/lh\.collection = \[nivaro_activity\]\.\[collection\]/i)
    expect(pick.sql).toMatch(/lh\.item_id = \[nivaro_activity\]\.\[item\]/i)
    expect(pick.sql).toMatch(/not exists \(select 1 from \[nivaro_revisions\] as \[pr\]/i)
    expect(pick.sql).toMatch(/\[seal_seq\] is null or \[nivaro_activity\]\.\[seal_seq\] < @p/i)
    expect(pick.bindings).toContain(10)
  })

  it('bridges the surviving successor, then deletes', async () => {
    const r = await purgeActivityRows(() => {})
    expect(r).toMatchObject({ deleted: 2, bridged: 1 })
    const ins = state.ran.find(
      (q) => q.method === 'insert' && q.sql.includes('nivaro_activity_seal_bridges')
    )!
    // row 3 sat right after deleted row 2: it keeps 2's (trimmed) hash
    expect(ins.bindings).toEqual(expect.arrayContaining([3, H2, 2]))
    const dels = state.ran.filter((q) => q.method === 'del')
    expect(dels.map((d) => d.sql.match(/delete from \[(\w+)\]/i)?.[1])).toEqual([
      'nivaro_activity_seal_bridges',
      'nivaro_activity'
    ])
    expect(dels[1].bindings).toEqual([1, 2])
    // the delete comes after the bridge insert
    expect(state.ran.indexOf(ins)).toBeLessThan(state.ran.indexOf(dels[1]))
  })

  it('a dry run deletes nothing', async () => {
    const r = await purgeActivityRows(() => {}, { dryRun: true })
    expect(r.would_delete).toBe(2)
    expect(state.ran.some((q) => q.method === 'del' || q.method === 'insert')).toBe(false)
  })
})
