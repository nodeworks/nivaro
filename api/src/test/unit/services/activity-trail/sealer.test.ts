import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalRow,
  GENESIS_HASH,
  sealHash
} from '../../../../services/activity-trail/canonical.js'
import type { FakeQuery } from '../../../fake-sql.js'

// #16 — the sealer: unsealed rows (READPAST) chained to the head in one CASE UPDATE per batch;
// a batch that does not touch exactly its rows is rolled back and the tick stops.

const state = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  unsealed: [] as Array<Record<string, unknown>>,
  updateCount: null as number | null,
  served: false
}))

vi.mock('../../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../../fake-sql.js')
  const fake = makeFakeDb((q) => {
    state.ran.push(q)
    if (q.method === 'first') return undefined // empty chain: genesis head
    if (q.method === 'select' && q.sql.includes('READPAST')) {
      if (state.served) return []
      state.served = true
      return state.unsealed
    }
    if (q.method === 'update') return state.updateCount ?? state.unsealed.length
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
vi.mock('../../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../../services/activity-trail/store.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return { ...orig, trailReady: vi.fn(async () => true) }
})

import { sealPending } from '../../../../services/activity-trail/sealer.js'

beforeEach(() => {
  state.ran = []
  state.served = false
  state.updateCount = null
  state.unsealed = [
    { id: 5, action: 'create', timestamp: new Date('2026-10-29T00:00:00Z'), comment: 'a' },
    { id: 6, action: 'update', timestamp: new Date('2026-10-29T00:00:01Z'), comment: 'b' }
  ]
})

describe('sealPending', () => {
  it('chains rows to the head with one CASE update', async () => {
    const r = await sealPending()
    expect(r).toMatchObject({ sealed: 2, head_seq: 2, more: false })
    const read = state.ran.find((q) => q.sql.includes('READPAST'))!
    expect(read.sql).toMatch(/\[seal_hash\] is null order by \[id\] asc/i)
    const upd = state.ran.find((q) => q.method === 'update')!
    const h5 = sealHash(GENESIS_HASH, canonicalRow(state.unsealed[0], 1))
    const h6 = sealHash(h5, canonicalRow(state.unsealed[1], 1))
    expect(upd.sql).toContain(`WHEN 5 THEN '${h5}'`)
    expect(upd.sql).toContain(`WHEN 6 THEN '${h6}'`)
    expect(upd.sql).toContain('WHEN 5 THEN 1 WHEN 6 THEN 2')
    expect(upd.sql).toMatch(/\[seal_hash\] is null/i)
  })

  it('stops (and reports more) when the update does not touch every row', async () => {
    state.updateCount = 1
    const r = await sealPending()
    expect(r).toMatchObject({ sealed: 0, more: true })
  })
})
