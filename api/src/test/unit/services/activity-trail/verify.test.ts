import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalRow, GENESIS_HASH } from '../../../../services/activity-trail/canonical.js'
import { computeSeals } from '../../../../services/activity-trail/chain.js'
import type { FakeQuery } from '../../../fake-sql.js'

// #16 — runTrailVerify over a database: walks from the newest good checkpoint, records a
// checkpoint row with the result, the first mismatching entry and where the chain ends.

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({
  rows: [] as Row[],
  checkpoint: undefined as Row | undefined,
  maxCheckpointSeq: null as number | null,
  inserted: [] as Row[],
  ran: [] as FakeQuery[]
}))

vi.mock('../../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      state.ran.push(q)
      const sql = q.sql
      if (sql.includes('nivaro_activity_seals')) {
        if (q.method === 'insert') {
          state.inserted.push(Object.fromEntries(q.bindings.map((b, i) => [i, b])))
          return [{ id: 7 }]
        }
        if (sql.includes('max(')) return { m: state.maxCheckpointSeq }
        if (q.method === 'first') return state.checkpoint
        return []
      }
      if (sql.includes('nivaro_activity_seal_bridges')) return []
      if (q.method === 'first' && sql.includes('order by [seal_seq] desc')) {
        const sealed = state.rows.filter((r) => r.seal_seq != null)
        return sealed[sealed.length - 1]
      }
      if (q.method === 'select' && sql.includes('[seal_seq] >')) {
        const [top, after, through] = q.bindings as number[]
        return state.rows
          .filter((r) => (r.seal_seq as number) > after && (r.seal_seq as number) <= through)
          .slice(0, top)
          .map((r) => ({ ...r }))
      }
      return []
    })
  }
})
vi.mock('../../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../../services/activity-trail/store.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return { ...orig, trailReady: vi.fn(async () => true) }
})

import { runTrailVerify } from '../../../../services/activity-trail/verify.js'

function seed(n: number): void {
  const raw: Row[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
    action: 'update',
    user: null,
    collection: 'articles',
    item: String(i % 3),
    comment: `c${i + 1}`
  }))
  const seals = computeSeals({ seq: 0, hash: GENESIS_HASH }, raw, 1)
  state.rows = raw.map((r, i) => ({
    ...r,
    seal_seq: seals[i].seq,
    seal_hash: seals[i].hash,
    seal_version: 1
  }))
}

beforeEach(() => {
  state.rows = []
  state.checkpoint = undefined
  state.maxCheckpointSeq = null
  state.inserted = []
  state.ran = []
})

describe('runTrailVerify', () => {
  it('records an intact checkpoint at the head', async () => {
    seed(25)
    const r = await runTrailVerify({ kind: 'manual' })
    expect(r).toMatchObject({ ok: true, rows: 25, last_seq: 25, from_seq: 0, truncated: false })
    expect(r.checkpoint_id).toBe(7)
    const insert = state.ran.find((q) => q.method === 'insert')!
    expect(insert.sql).toMatch(/insert into \[nivaro_activity_seals\]/)
    expect(insert.bindings).toContain(state.rows[24].seal_hash)
  })

  it('records the first mismatching entry', async () => {
    seed(25)
    state.rows[9].comment = 'changed'
    const r = await runTrailVerify({ kind: 'manual' })
    expect(r.ok).toBe(false)
    expect(r.mismatches[0]).toEqual({ id: 10, seq: 10, reason: 'changed' })
    const insert = state.ran.find((q) => q.method === 'insert')!
    expect(insert.bindings).toContain('This entry was changed after it was sealed')
  })

  it('restarts from the newest good checkpoint (rows below it may be gone)', async () => {
    seed(25)
    const cp = state.rows[19]
    state.checkpoint = {
      id: 3,
      last_seq: 20,
      last_hash: `${cp.seal_hash}`,
      last_id: 20,
      last_row_at: cp.timestamp,
      verified_ok: true
    }
    state.maxCheckpointSeq = 20
    state.rows = state.rows.slice(20) // retention purged 1–20
    const r = await runTrailVerify({ kind: 'daily' })
    expect(r).toMatchObject({ ok: true, from_seq: 20, rows: 5, last_seq: 25 })
  })

  it('flags a chain shorter than an earlier check reached', async () => {
    seed(10)
    state.maxCheckpointSeq = 40
    const r = await runTrailVerify({ kind: 'full' })
    expect(r.truncated).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('the canonical text the walk hashes is the stored row (sanity)', () => {
    seed(1)
    expect(canonicalRow(state.rows[0], 1)).toContain('"comment":"c1"')
  })
})
