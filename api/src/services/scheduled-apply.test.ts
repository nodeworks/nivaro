import { beforeEach, describe, expect, it, vi } from 'vitest'

// A small in-memory table store standing in for knex: where({..}), where(col, op, v), orderBy,
// limit, select, first, update (returns the number of rows changed — the claim's CAS).
const store = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  browserConfig: null as unknown
}))

vi.mock('../db/index.js', () => {
  const builder = (table: string) => {
    const preds: Array<(r: Record<string, unknown>) => boolean> = []
    let lim = Infinity
    const rows = () => (store.tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
    const cmp = (a: unknown, b: unknown) => {
      const x = a instanceof Date ? a.getTime() : new Date(String(a)).getTime()
      const y = b instanceof Date ? b.getTime() : new Date(String(b)).getTime()
      return x - y
    }
    const q: Record<string, unknown> = {
      where(a: unknown, op?: string, v?: unknown) {
        if (typeof a === 'object' && a) {
          for (const [k, val] of Object.entries(a as Record<string, unknown>))
            preds.push((r) => String(r[k]) === String(val))
        } else if (op === '<=') preds.push((r) => cmp(r[a as string], v) <= 0)
        else if (op === '<') preds.push((r) => r[a as string] != null && cmp(r[a as string], v) < 0)
        return q
      },
      orderBy: () => q,
      limit(n: number) {
        lim = n
        return q
      },
      select: async () => rows().slice(0, lim),
      first: async () => rows()[0],
      update: async (patch: Record<string, unknown>) => {
        const hit = rows()
        for (const r of hit) Object.assign(r, patch)
        return hit.length
      },
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(rows().slice(0, lim)).then(res, rej)
    }
    return q
  }
  return { db: vi.fn((t: string) => builder(t)) }
})
vi.mock('./activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('./record-events.js', () => ({ announceRecordAspect: vi.fn() }))
vi.mock('./collections.js', () => ({
  getCollection: vi.fn(async () => ({ browser_config: store.browserConfig })),
  getFields: vi.fn(async () => [
    {
      field: 'status',
      label: 'Status',
      options: { choices: [{ text: 'Closed', value: 'closed' }] }
    }
  ])
}))

import {
  type ApplyDeps,
  conflictReason,
  decodeMeta,
  encodeMeta,
  readMeta,
  runScheduledChanges,
  sameValue
} from './scheduled-apply.js'

const NOW = new Date('2026-11-15T17:00:00.000Z')
function deps(over: Partial<ApplyDeps> = {}) {
  const notes: Array<{ subject: string; message: string }> = []
  const writes: Array<Record<string, unknown>> = []
  const d: ApplyDeps = {
    execute: vi.fn(async (_req, change, changes) => {
      // The real one writes as the scheduler through the items service.
      const row = store.tables.orders.find((r) => String(r.id) === String(change.item_id))
      if (row) Object.assign(row, changes)
      writes.push(changes)
      return { ok: true as const }
    }),
    notify: vi.fn(async (_u, o) => {
      notes.push(o)
    }),
    label: vi.fn(async () => 'ORD-7'),
    now: () => NOW,
    ...over
  }
  return { d, notes, writes }
}
const change = (over: Record<string, unknown> = {}) => ({
  id: 'C1',
  collection: 'orders',
  item_id: '7',
  change_type: 'field_update',
  changes: '{"status":"closed"}',
  scheduled_at: new Date('2026-11-15T16:59:00.000Z'),
  status: 'pending',
  executed_at: null,
  error_message: null,
  created_by: 'U5',
  apply_meta: encodeMeta({ v: 1, at: { status: 'open' } }),
  ...over
})

beforeEach(() => {
  store.browserConfig = null
  store.tables = { nivaro_scheduled_changes: [change()], orders: [{ id: 7, status: 'open' }] }
})

describe('runScheduledChanges', () => {
  it('applies a due change as the scheduler, keeps the undo, tells them', async () => {
    const { d, notes, writes } = deps()
    const r = await runScheduledChanges(null, d)
    expect(r).toMatchObject({ applied: 1, failed: 0 })
    expect(writes).toEqual([{ status: 'closed' }])
    const row = store.tables.nivaro_scheduled_changes[0]
    expect(row.status).toBe('executed')
    const meta = decodeMeta(row.apply_meta)
    expect(meta.before).toEqual({ status: 'open' })
    expect(meta.applied_by).toBe('schedule')
    expect(Date.parse(meta.undo_until as string)).toBe(NOW.getTime() + 24 * 3600_000)
    expect(notes[0].subject).toBe('Applied: Status → Closed on ORD-7')
  })

  it('leaves a change that is not due yet', async () => {
    store.tables.nivaro_scheduled_changes[0].scheduled_at = new Date('2026-11-15T18:00:00Z')
    const { d } = deps()
    expect(await runScheduledChanges(null, d)).toMatchObject({ applied: 0 })
    expect(store.tables.nivaro_scheduled_changes[0].status).toBe('pending')
  })

  it('marks it failed with the reason when the scheduler may no longer change the record', async () => {
    const { d, notes } = deps({
      execute: vi.fn(async () => ({
        ok: false as const,
        status: 403,
        error: 'You do not have permission to change this record'
      }))
    })
    const r = await runScheduledChanges(null, d)
    expect(r).toMatchObject({ applied: 0, failed: 1 })
    const row = store.tables.nivaro_scheduled_changes[0]
    expect(row.status).toBe('failed')
    expect(row.error_message).toBe('You do not have permission to change this record')
    expect(store.tables.orders[0].status).toBe('open')
    expect(notes[0].subject).toBe('Not applied: Status → Closed on ORD-7')
  })

  it('fails instead of overwriting a field someone else moved after it was scheduled', async () => {
    store.tables.orders[0].status = 'on_hold'
    const { d, writes } = deps()
    const r = await runScheduledChanges(null, d)
    expect(r.failed).toBe(1)
    expect(writes).toHaveLength(0)
    expect(store.tables.nivaro_scheduled_changes[0].error_message).toBe(
      'Status was changed by someone else after this was scheduled'
    )
  })

  it('applies a change only once when two runs race for it', async () => {
    const a = deps()
    const b = deps()
    const [ra, rb] = await Promise.all([
      runScheduledChanges(null, a.d),
      runScheduledChanges(null, b.d)
    ])
    expect(ra.applied + rb.applied).toBe(1)
    expect(a.writes.length + b.writes.length).toBe(1)
  })

  it('waits for an administrator where the collection turned it off', async () => {
    store.browserConfig = { scheduled_auto_apply: false }
    const { d, writes } = deps()
    expect(await runScheduledChanges(null, d)).toMatchObject({ applied: 0, skipped: 1 })
    expect(writes).toHaveLength(0)
    expect(store.tables.nivaro_scheduled_changes[0].status).toBe('pending')
  })

  it('tries again next minute while someone has the record open for editing', async () => {
    const { d } = deps({
      execute: vi.fn(async () => ({
        ok: false as const,
        status: 409,
        error: 'Beth is editing this record',
        extra: { code: 'RECORD_LOCKED' }
      }))
    })
    expect(await runScheduledChanges(null, d)).toMatchObject({ waiting: 1, failed: 0 })
    expect(store.tables.nivaro_scheduled_changes[0].status).toBe('pending')
  })

  it('fails a claim left behind by a process that stopped mid-apply', async () => {
    store.tables.nivaro_scheduled_changes[0].status = 'applying'
    store.tables.nivaro_scheduled_changes[0].executed_at = new Date(NOW.getTime() - 20 * 60_000)
    const { d } = deps()
    await runScheduledChanges(null, d)
    expect(store.tables.nivaro_scheduled_changes[0].status).toBe('failed')
  })
})

describe('pure parts', () => {
  it('compares stored values loosely', () => {
    expect(sameValue('12.50', 12.5)).toBe(true)
    expect(sameValue(null, '')).toBe(true)
    expect(sameValue(new Date('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00.000Z')).toBe(true)
    expect(sameValue('open', 'closed')).toBe(false)
  })
  it('judges only fields with a snapshot', () => {
    const label = (k: string) => k
    expect(conflictReason({ a: 1 }, undefined, { a: 5 }, label)).toBeNull()
    expect(conflictReason({ a: 1 }, { a: 0 }, { a: 1 }, label)).toBeNull()
    expect(conflictReason({ a: 1 }, { a: 0 }, { a: 2 }, label)).toMatch(/^a was changed/)
  })
  it('keeps large bookkeeping whole (apply_meta has no size cap)', () => {
    const big = { v: 1 as const, at: { x: 'y'.repeat(3000) }, before: { x: 'z'.repeat(3000) } }
    const back = decodeMeta(encodeMeta(big))
    expect(back.at).toEqual(big.at)
    expect(back.before).toEqual(big.before)
    expect(decodeMeta('not json')).toEqual({ v: 1 })
  })
  it('reads rows from before migration 528 out of the old column', () => {
    const legacy = JSON.stringify({ v: 1, at: { status: 'open' } })
    expect(readMeta({ apply_meta: null, inngest_event_id: legacy }).at).toEqual({ status: 'open' })
    const now = encodeMeta({ v: 1, applied_by: 'schedule' })
    expect(readMeta({ apply_meta: now, inngest_event_id: legacy }).applied_by).toBe('schedule')
    expect(readMeta(null)).toEqual({ v: 1 })
  })
})
