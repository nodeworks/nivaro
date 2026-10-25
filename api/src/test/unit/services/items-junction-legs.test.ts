import { describe, expect, it, vi } from 'vitest'

// A junction's own legs are M2O from the junction (army v3, 2026-10-25): the
// expansion skipped every relation carrying junction_field, but a junction's
// legs carry it as the pairing marker, so `divisions_id.short_name` on
// workflows_divisions came back as the bare id and every Exports join column
// (Zone, Region, Sub Type, PO) was blank.

const rows = vi.hoisted(() => ({
  workflows_divisions: [{ id: 1, workflows_id: 9, divisions_id: 3 }],
  divisions: [{ id: 3, short_name: 'Zone 1' }]
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve((rows as Record<string, unknown[]>)[table] ?? []).then(res, rej)
        if (prop === 'first')
          return () => Promise.resolve(((rows as Record<string, unknown[]>)[table] ?? [])[0])
        if (prop === 'columnInfo')
          return () =>
            Promise.resolve(
              Object.fromEntries(
                Object.keys(((rows as Record<string, unknown[]>)[table] ?? [{}])[0] ?? {}).map(
                  (c) => [c, {}]
                )
              )
            )
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(String(table).split(' ')[0]), {
    get(_t, prop) {
      if (prop === 'raw') return (sql: string) => ({ sql, toString: () => sql })
      return () => chain('raw')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => true),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
const LEGS = vi.hoisted(() => [
  {
    many_collection: 'workflows_divisions',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'divisions',
    junction_field: 'divisions_id'
  },
  {
    many_collection: 'workflows_divisions',
    many_field: 'divisions_id',
    one_collection: 'divisions',
    one_field: null,
    junction_field: 'workflows_id'
  }
])
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c })),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async () => LEGS)
}))
vi.mock('../../../services/physical-tables.js', async (orig) => ({
  ...(await orig<object>()),
  tableIsMissing: vi.fn(async () => false),
  liveRelations: vi.fn(async (r: unknown) => r)
}))

vi.mock('../../../services/tree-permissions.js', async (orig) => ({
  ...(await orig<object>()),
  getTreePermission: vi.fn(async () => null)
}))
vi.mock('../../../services/edit-lock.js', async (orig) => ({
  ...(await orig<object>()),
  assertNotEditLocked: vi.fn(async () => {})
}))
const sent = vi.hoisted(() => [] as Array<{ collection: string; item: unknown; extra: unknown }>)
vi.mock('../../../services/realtime.js', async (orig) => ({
  ...(await orig<object>()),
  broadcastCollectionUpdate: vi.fn(
    (_io: unknown, collection: string, item: unknown, extra: unknown) => {
      sent.push({ collection, item, extra })
    }
  )
}))

import { deleteOne, readOne } from '../../../services/items.js'

describe('junction legs expand like any many-to-one', () => {
  it('divisions_id.short_name on the junction returns the related record', async () => {
    const row = (await readOne(
      { id: 'U-1', role: 'ADMIN' } as never,
      'workflows_divisions',
      1,
      undefined,
      ['workflows_id', 'divisions_id.short_name']
    )) as Record<string, unknown> | null
    expect(row?.divisions_id).toMatchObject({ short_name: 'Zone 1' })
  })
})

describe('a junction row write tells the parent record', () => {
  it('removing a Zone link emits an update of the workflow naming its divisions field', async () => {
    await deleteOne({ id: 'U-1', role: 'ADMIN' } as never, 'workflows_divisions', 1)
    for (let i = 0; i < 20 && !sent.some((e) => e.collection === 'workflows'); i++)
      await new Promise((r) => setTimeout(r, 5))
    expect(sent).toContainEqual({
      collection: 'workflows',
      item: '9',
      extra: { action: 'update', changed_fields: ['divisions'] }
    })
    // The far leg (divisions) is reference data, not a parent: no event for it.
    expect(sent.some((e) => e.collection === 'divisions')).toBe(false)
  })
})
