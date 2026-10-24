import { beforeEach, describe, expect, it, vi } from 'vitest'

// A batch update judges validation rules exactly as updateOne does: only the
// fields each row's patch sends (plus a gte_field / lte_field partner of one),
// with the stored row as context. A legacy row that already breaks a rule in
// a field nobody touched never fails an unrelated edit.

const COLS = ['id', 'note', 'qty', 'reason', 'on_hold', 'service_start_date', 'service_end_date']
const state = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  writes: [] as string[]
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(table === 'workflows' ? [state.stored] : []).then(res, rej)
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(table), {
    get(_t, prop) {
      if (prop === 'raw')
        return async (sql: string) => {
          if (/sys\.columns/i.test(sql))
            return COLS.map((name) => ({
              name,
              type_name: name === 'id' || name === 'qty' ? 'int' : 'nvarchar',
              max_length: 200,
              precision: 0,
              scale: 0,
              is_identity: name === 'id',
              is_computed: false
            }))
          if (/^\s*UPDATE/i.test(sql)) state.writes.push(sql)
          return []
        }
      return () => chain('raw')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})
vi.mock('../../../services/collections.js', () => ({
  getFields: async () => [
    { field: 'note' },
    { field: 'qty', validation_rules: JSON.stringify([{ type: 'min', value: 5 }]) },
    {
      field: 'reason',
      validation_rules: JSON.stringify([
        { type: 'required_if', field: 'on_hold', op: 'eq', value: true }
      ])
    },
    { field: 'service_start_date' },
    {
      field: 'service_end_date',
      validation_rules: JSON.stringify([{ type: 'gte_field', field: 'service_start_date' }])
    }
  ]
}))
vi.mock('../../../extensions/validators.js', () => ({
  validatorRegistry: { has: () => false, run: () => null }
}))
vi.mock('../../../services/items.js', () => ({ applyWriteComputedFields: async () => {} }))
vi.mock('../../../hooks/activity.js', () => ({ auditLevelOf: async () => 'none' }))
vi.mock('../../../services/note-authorship.js', () => ({
  originFields: async () => ({}),
  originForWrite: () => null
}))
vi.mock('../../../services/chain-columns.js', () => ({ chainFields: async () => ({}) }))
vi.mock('../../../services/rollups.js', () => ({
  getRollupContributors: async () => [],
  recalcRollupsForParent: async () => {}
}))
vi.mock('../../../services/raw-write-announcer.js', () => ({ announceRawWrites: async () => {} }))
vi.mock('../../../services/auto-ids.js', () => ({ autoIdFieldsFor: async () => [] }))
vi.mock('../../../services/encryption.js', () => ({ getEncryptedFields: async () => [] }))
vi.mock('../../../services/permissions.js', () => ({
  can: async () => true,
  getAllowedFields: async () => null,
  getRowFilter: async () => null
}))

import { batchUpdate } from '../../../services/batch-writes.js'

const user = { id: 'U-1', role: 'R' } as never

describe('batchUpdate validation', () => {
  beforeEach(() => {
    state.writes = []
    // Breaks min on qty, required_if on reason and gte_field on the end date.
    state.stored = {
      id: 7,
      note: null,
      qty: 1,
      reason: null,
      on_hold: 'true',
      service_start_date: '2026-05-01',
      service_end_date: '2020-01-01'
    }
  })

  it('lets an unrelated patch through on a legacy row that breaks other rules', async () => {
    const out = await batchUpdate('workflows', [{ id: 7, patch: { note: 'hi' } }], { user })
    expect(out.failures).toEqual([])
    expect(out.done).toBe(1)
  })

  it('still judges the field it sends, and a cross-field partner against the stored other', async () => {
    const out = await batchUpdate(
      'workflows',
      [
        { id: 7, patch: { qty: 2 } },
        { id: 7, patch: { service_start_date: '2026-07-01', service_end_date: '2026-06-01' } }
      ],
      { user }
    )
    expect(out.done).toBe(0)
    expect(out.failures[0]).toMatch(/qty must be at least 5/)
    expect(out.failures[1]).toMatch(/on or after/)
  })
})
