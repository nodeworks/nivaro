import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fluent knex-shaped recorder: every builder method chains and records its
// arguments; `first()` hands the recorded calls to the test's resolver.
type Call = { method: string; args: unknown[] }
type Resolver = (table: string, calls: Call[]) => unknown
let resolver: Resolver = () => undefined
const dbMock = vi.fn((table: string) => {
  const calls: Call[] = []
  const chain: Record<string, unknown> = {}
  for (const m of ['leftJoin', 'select', 'where', 'orderBy', 'max']) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args })
      return chain
    }
  }
  chain.first = () => Promise.resolve(resolver(table, calls))
  return chain
})
let columnPresent = true

vi.mock('../../../db/index.js', () => ({ db: (table: string) => dbMock(table) }))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: vi.fn(async () => columnPresent)
}))

import {
  changedFields,
  pickSnapshotRevision,
  snapshotRevisionFor
} from '../../../services/notification-snapshot.js'

beforeEach(() => {
  resolver = () => undefined
  columnPresent = true
  dbMock.mockClear()
})

describe('changedFields', () => {
  it('names only the keys that really moved', () => {
    const snapshot = { name: 'A', amount: '10.00', vendor: 3, note: null, updated_at: 'x' }
    const current = { name: 'B', amount: 10, vendor: 4, note: '', updated_at: 'y' }
    expect(changedFields(snapshot, current)).toEqual(['name', 'vendor'])
  })
  it('a bit and its boolean, a decimal string and its number, are the same value', () => {
    expect(changedFields({ flag: 1, qty: '2.5000' }, { flag: true, qty: 2.5 })).toEqual([])
    expect(changedFields({ flag: 0, code: '007' }, { flag: true, code: '7' })).toEqual([
      'flag',
      'code'
    ])
  })
  it('judges only keys present on the current row and ignores the stamps + id', () => {
    const snapshot = { id: 1, secret: 'was', date_updated: 'a', title: 't' }
    const current = { id: 2, date_updated: 'b', title: 't' }
    expect(changedFields(snapshot, current)).toEqual([])
  })
  it('compares dates by instant, whatever the type', () => {
    const at = new Date('2026-10-01T12:00:00.000Z')
    expect(changedFields({ due: at.toISOString() }, { due: at })).toEqual([])
    expect(changedFields({ due: at.toISOString() }, { due: new Date(at.getTime() + 1) })).toEqual([
      'due'
    ])
  })
  it('a key the snapshot never had counts as changed when it holds a value now', () => {
    expect(changedFields({}, { extra: 'v' })).toEqual(['extra'])
    expect(changedFields({}, { extra: null })).toEqual([])
  })
})

describe('pickSnapshotRevision', () => {
  const whereOf = (calls: Call[]) => calls.filter((c) => c.method === 'where')

  it('returns the stamped revision when it still exists', async () => {
    resolver = (_table, calls) => {
      const byId = whereOf(calls).find((c) => c.args[0] === 'r.id')
      if (byId?.args[1] === 77)
        return { id: 77, data: JSON.stringify({ name: 'then' }), timestamp: 'T1' }
      return undefined
    }
    const hit = await pickSnapshotRevision({
      collection: 'workflows',
      item: '42',
      revisionId: 77,
      before: '2026-10-01T00:00:00.000Z'
    })
    expect(hit).toEqual({ revision_id: 77, at: 'T1', data: { name: 'then' } })
  })

  it('falls back to the newest revision at or before the timestamp when the stamp is gone', async () => {
    const seen: Call[][] = []
    resolver = (_table, calls) => {
      seen.push(calls)
      const byId = whereOf(calls).find((c) => c.args[0] === 'r.id')
      if (byId) return undefined // purged
      return { id: 50, data: JSON.stringify({ name: 'older' }), timestamp: 'T0' }
    }
    const hit = await pickSnapshotRevision({
      collection: 'workflows',
      item: '42',
      revisionId: 77,
      before: '2026-10-01T00:00:00.000Z'
    })
    expect(hit?.revision_id).toBe(50)
    expect(hit?.data).toEqual({ name: 'older' })
    const fallback = seen[1]
    const ts = whereOf(fallback).find((c) => c.args[0] === 'a.timestamp')
    expect(ts?.args[1]).toBe('<=')
    expect((ts?.args[2] as Date).toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(fallback.find((c) => c.method === 'orderBy')?.args).toEqual(['r.id', 'desc'])
  })

  it('answers null with no stamp and no revision before the time', async () => {
    resolver = () => undefined
    expect(
      await pickSnapshotRevision({
        collection: 'workflows',
        item: '42',
        revisionId: null,
        before: '2026-10-01T00:00:00.000Z'
      })
    ).toBeNull()
    expect(dbMock).toHaveBeenCalledTimes(1)
  })

  it('never falls back without a usable timestamp', async () => {
    resolver = () => ({ id: 1, data: '{}', timestamp: null })
    expect(
      await pickSnapshotRevision({ collection: 'w', item: '1', revisionId: null, before: null })
    ).toBeNull()
    expect(dbMock).not.toHaveBeenCalled()
  })
})

describe('snapshotRevisionFor', () => {
  it('stamps the newest revision id of a record target', async () => {
    resolver = () => ({ latest: '91' })
    expect(await snapshotRevisionFor({ kind: 'record', collection: 'workflows', id: 42 })).toBe(91)
  })
  it('stamps nothing for non-record targets, system collections, or a tenant without the column', async () => {
    resolver = () => ({ latest: 91 })
    expect(await snapshotRevisionFor({ kind: 'task', collection: 'workflows', id: 42 })).toBeNull()
    expect(
      await snapshotRevisionFor({ kind: 'record', collection: 'nivaro_tasks', id: 1 })
    ).toBeNull()
    expect(await snapshotRevisionFor(null)).toBeNull()
    columnPresent = false
    expect(
      await snapshotRevisionFor({ kind: 'record', collection: 'workflows', id: 42 })
    ).toBeNull()
  })
})
