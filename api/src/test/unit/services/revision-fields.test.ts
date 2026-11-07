import { beforeEach, describe, expect, it, vi } from 'vitest'

// H2 (security audit 2026-10-27): a record's history shows only the fields
// the reader's read policy lists — snapshots, deltas and the child snapshot an
// o2m activity row carries.

const perms = vi.hoisted(() => ({
  fields: {} as Record<string, string[] | null>,
  readable: new Set<string>()
}))
vi.mock('../../../services/permissions.js', () => ({
  getAllowedFields: vi.fn(async (_u: unknown, _a: string, c: string) => perms.fields[c] ?? null),
  can: vi.fn(async (_u: unknown, _a: string, c: string) => perms.readable.has(c))
}))

import {
  isO2mActivity,
  keepReadable,
  parseO2mComment,
  pickFields,
  readableFieldSet,
  revisionsForReader
} from '../../../services/revision-fields.js'

const user = { id: 'U1', role: 'R1' } as never

beforeEach(() => {
  perms.fields = {}
  perms.readable = new Set(['orders', 'order_lines'])
})

describe('readableFieldSet / pickFields', () => {
  it('is no cut for an admin role or a "*" policy', async () => {
    perms.fields.orders = null
    expect(await readableFieldSet(user, 'orders')).toBeNull()
    perms.fields.orders = ['*']
    expect(await readableFieldSet(user, 'orders')).toBeNull()
  })

  it('keeps id plus the listed fields', async () => {
    perms.fields.orders = ['status']
    const set = await readableFieldSet(user, 'orders')
    expect(pickFields({ id: 1, status: 'open', salary: 9 }, set)).toEqual({ id: 1, status: 'open' })
    expect(keepReadable(['status', 'salary'], set)).toEqual(['status'])
    expect(pickFields(null, set)).toBeNull()
  })
})

describe('revisionsForReader', () => {
  it('cuts every snapshot and delta to the readable fields', async () => {
    perms.fields.orders = ['status']
    const out = await revisionsForReader(user, 'orders', [
      {
        action: 'update',
        data: { id: 1, status: 'closed', salary: 100 },
        delta: { salary: 100 },
        comment: null
      }
    ])
    expect(out[0].data).toEqual({ id: 1, status: 'closed' })
    expect(out[0].delta).toEqual({})
  })

  // Army 6 H1: the o2m comment (child ids, a snapshot with user uuids) never reaches a reader.
  // It becomes a readable summary cut to the CHILD collection's fields.
  const deps = {
    collectionTitle: vi.fn(async (c: string) =>
      c === 'order_lines' ? 'Lines' : c === 'materials' ? 'Materials' : c
    ),
    fieldMeta: vi.fn(async () => ({
      labels: new Map([
        ['qty', 'Quantity'],
        ['owner', 'Owner'],
        ['cifa', 'Item']
      ]),
      hidden: new Set(['changed']),
      m2o: new Map([
        ['owner', 'nivaro_users'],
        ['cifa', 'cifa_items']
      ])
    })),
    recordLabels: vi.fn(async (_u: unknown, refs: Array<{ collection: string; id: string }>) =>
      Object.fromEntries(
        refs.map((r) => [
          `${r.collection}:${r.id}`,
          r.collection === 'cifa_items' ? `CIFA ${r.id}0` : r.id === '5' ? '110140' : 'Lines'
        ])
      )
    ),
    snapshotLabel: vi.fn(async () => 'Line 1'),
    userNames: vi.fn(
      async (ids: string[]) =>
        new Map(
          ids.map((i) => [
            i.toLowerCase(),
            i.startsWith('46A') ? 'Peter Moniz' : 'Kristina Davison'
          ])
        )
    )
  }
  const UUID_A = '46A4897B-3F11-4DAE-BC1D-C2C0517ABBC6'
  const UUID_B = '087389AF-2013-4A66-8C29-7F0E2E1047E5'

  it('an o2m-update becomes "Materials · 110140: Quantity 4 → 5", no comment JSON', async () => {
    perms.fields.orders = null
    perms.fields.order_lines = null
    const comment = JSON.stringify({
      child_collection: 'materials',
      child_id: '5',
      snapshot: { id: 5, qty: 5, user_created: UUID_A },
      changes: { qty: [4, 5], changed: ['2026-11-06T16:00:00Z', '2026-11-06T21:00:00Z'] }
    })
    perms.readable.add('materials')
    const [row] = await revisionsForReader(
      user,
      'orders',
      [{ action: 'o2m-update', data: null, delta: null, comment }],
      deps
    )
    expect(row.comment).toBeNull()
    expect(row.o2m).toEqual({
      verb: 'changed',
      collection: 'materials',
      collection_label: 'Materials',
      row_label: '110140',
      changes: [{ field: 'qty', label: 'Quantity', from: '4', to: '5' }]
    })
    expect(JSON.stringify(row)).not.toMatch(/child_id|46A4897B/)
  })

  it('names people and linked records, never their ids', async () => {
    perms.fields.order_lines = null
    const comment = JSON.stringify({
      child_collection: 'order_lines',
      child_id: '7',
      snapshot: { id: 7 },
      changes: { owner: [UUID_A, UUID_B], cifa: [50047, 50048], note: ['a', UUID_B] }
    })
    const [row] = await revisionsForReader(
      user,
      'orders',
      [{ action: 'o2m-update', data: null, delta: null, comment }],
      deps
    )
    const changes = row.o2m?.changes ?? []
    expect(changes.find((c) => c.field === 'owner')).toMatchObject({
      label: 'Owner',
      from: 'Peter Moniz',
      to: 'Kristina Davison'
    })
    // a plain text field whose new value is a person's uuid shows the name
    expect(changes.find((c) => c.field === 'note')).toMatchObject({
      from: 'a',
      to: 'Kristina Davison'
    })
    expect(changes.find((c) => c.field === 'cifa')).toMatchObject({
      from: 'CIFA 500470',
      to: 'CIFA 500480'
    })
    expect(JSON.stringify(changes)).not.toMatch(/087389AF|46A4897B|50047\b/)
  })

  it("cuts the changes to the CHILD collection's readable fields", async () => {
    perms.fields.orders = null
    perms.fields.order_lines = ['qty']
    const comment = JSON.stringify({
      child_collection: 'order_lines',
      child_id: '5',
      snapshot: { id: 5, qty: 2, unit_cost: 40 },
      changes: { qty: [1, 2], unit_cost: [30, 40] }
    })
    const [row] = await revisionsForReader(
      user,
      'orders',
      [{ action: 'o2m-update', data: null, delta: null, comment }],
      deps
    )
    expect(row.o2m?.changes.map((c) => c.field)).toEqual(['qty'])
  })

  it('an old row without `changes` still reads as a sentence (no JSON)', async () => {
    perms.fields.order_lines = null
    const comment = JSON.stringify({
      child_collection: 'order_lines',
      child_id: '475911',
      snapshot: { id: 475911, creator: UUID_B }
    })
    const [row] = await revisionsForReader(
      user,
      'orders',
      [{ action: 'o2m-create', data: null, delta: null, comment }],
      deps
    )
    expect(row.comment).toBeNull()
    expect(row.o2m).toMatchObject({ verb: 'added', collection_label: 'Lines', changes: [] })
    // the viewer label was only the collection title → the snapshot label stands in
    expect(row.o2m?.row_label).toBe('Line 1')
  })

  it('says only that rows changed when the child collection is not readable', async () => {
    perms.readable.delete('order_lines')
    const comment = JSON.stringify({
      child_collection: 'order_lines',
      child_id: '5',
      snapshot: { id: 5, unit_cost: 40 },
      changes: { unit_cost: [30, 40] }
    })
    const [row] = await revisionsForReader(
      user,
      'orders',
      [{ action: 'o2m-delete', data: null, delta: null, comment }],
      deps
    )
    expect(row.comment).toBeNull()
    expect(row.o2m).toMatchObject({ verb: 'removed', row_label: null, changes: [] })
  })

  it('leaves a full reader unchanged', async () => {
    const rev = { action: 'update', data: { id: 1, salary: 5 }, delta: { salary: 5 }, comment: 'x' }
    expect(await revisionsForReader(user, 'orders', [rev])).toEqual([rev])
  })
})

describe('o2m pointer rows are never notes (H1 / L6)', () => {
  it('recognises the action and the stored JSON shape', () => {
    expect(isO2mActivity('o2m-update', 'anything')).toBe(true)
    expect(isO2mActivity('update', '{"child_collection":"forecasts","child_id":"1"}')).toBe(true)
    expect(isO2mActivity('update', 'Price corrected per vendor quote')).toBe(false)
    expect(isO2mActivity('update', '{"note":"x"}')).toBe(false)
    expect(parseO2mComment('not json {child_collection')).toBeNull()
  })
})
