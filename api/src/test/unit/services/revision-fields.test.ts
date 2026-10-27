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
  keepReadable,
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

  it("cuts an o2m row's child snapshot to the CHILD collection's fields", async () => {
    perms.fields.orders = null
    perms.fields.order_lines = ['qty']
    const comment = JSON.stringify({
      child_collection: 'order_lines',
      child_id: '5',
      snapshot: { id: 5, qty: 2, unit_cost: 40 }
    })
    const [row] = await revisionsForReader(user, 'orders', [
      { action: 'o2m-update', data: null, delta: null, comment }
    ])
    expect(JSON.parse(String(row.comment)).snapshot).toEqual({ id: 5, qty: 2 })
  })

  it('drops the child snapshot when the child collection is not readable', async () => {
    perms.readable.delete('order_lines')
    const comment = JSON.stringify({
      child_collection: 'order_lines',
      child_id: '5',
      snapshot: { id: 5, unit_cost: 40 }
    })
    const [row] = await revisionsForReader(user, 'orders', [
      { action: 'o2m-create', data: null, delta: null, comment }
    ])
    expect(JSON.parse(String(row.comment))).toEqual({
      child_collection: 'order_lines',
      child_id: '5'
    })
  })

  it('leaves a full reader unchanged', async () => {
    const rev = { action: 'update', data: { id: 1, salary: 5 }, delta: { salary: 5 }, comment: 'x' }
    expect(await revisionsForReader(user, 'orders', [rev])).toEqual([rev])
  })
})
