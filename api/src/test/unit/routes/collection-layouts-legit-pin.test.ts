import { beforeEach, describe, expect, it, vi } from 'vitest'

// Table-aware db mock: each table's `.first()` answers from `rows`.
const rows = vi.hoisted(() => ({
  layout: undefined as Record<string, unknown> | undefined,
  registered: true,
  record: undefined as Record<string, unknown> | undefined,
  recordSelect: [] as unknown[]
}))

vi.mock('../../../db/index.js', () => {
  const d = vi.fn((table: string) => {
    const q: Record<string, unknown> = {}
    q.where = (arg: unknown) => {
      if (typeof arg === 'function') (arg as (b: unknown) => void)(q)
      return q
    }
    q.orWhereNull = () => q
    q.select = (cols: unknown) => {
      if (table === 'orders') rows.recordSelect.push(cols)
      return q
    }
    q.first = () => {
      if (table === 'nivaro_collection_layouts') return Promise.resolve(rows.layout)
      if (table === 'nivaro_collections')
        return Promise.resolve(rows.registered ? { collection: 'orders' } : undefined)
      return Promise.resolve(rows.record)
    }
    return q
  })
  return { db: d }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

import { legitimatePinForRecord } from '../../../routes/collection-layouts.js'

const opts = { collection: 'orders', slug: 'unit-order', item: '7', role: 'R1' }

beforeEach(() => {
  rows.layout = undefined
  rows.registered = true
  rows.record = undefined
  rows.recordSelect = []
})

describe('legitimatePinForRecord — a ?layout= pin that may decide a grant', () => {
  it('returns nothing for an unknown slug', async () => {
    expect(await legitimatePinForRecord(opts)).toBeNull()
  })

  it('refuses a form restricted to other roles', async () => {
    rows.layout = { id: 1, conditions: JSON.stringify({ role_ids: ['R2'] }) }
    expect(await legitimatePinForRecord(opts)).toBeNull()
  })

  it('accepts a role-allowed form without record rules', async () => {
    rows.layout = { id: 1, conditions: JSON.stringify({ role_ids: ['r1'] }) }
    expect(await legitimatePinForRecord(opts)).toBe(rows.layout)
  })

  it('refuses a form whose record rules do not match this record', async () => {
    rows.layout = {
      id: 1,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }])
    }
    rows.record = { id: 7, workflow_type: 1 }
    expect(await legitimatePinForRecord(opts)).toBeNull()
    // Only the columns the rules name are read.
    expect(rows.recordSelect[0]).toEqual(['id', 'workflow_type'])
  })

  it('accepts a form whose record rules match this record', async () => {
    rows.layout = {
      id: 1,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }])
    }
    rows.record = { id: 7, workflow_type: '2' }
    expect(await legitimatePinForRecord(opts)).toBe(rows.layout)
  })

  it('refuses a ruled form when the record or collection is unknown', async () => {
    rows.layout = {
      id: 1,
      record_conditions: JSON.stringify([{ field: 'workflow_type', op: 'eq', value: 2 }])
    }
    expect(await legitimatePinForRecord(opts)).toBeNull()
    rows.record = { id: 7, workflow_type: 2 }
    rows.registered = false
    expect(await legitimatePinForRecord(opts)).toBeNull()
  })
})
