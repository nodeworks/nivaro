import { beforeEach, describe, expect, it, vi } from 'vitest'

// Update rehearsal (#3222, update_item dry_run): every gate an update runs, the UPDATE tried
// inside a transaction that is rolled back, and the before/after diff as the caller reads it.
// Harness from items-write-scope.test.ts: any query-builder call chains, `.first()` answers
// `rec.row`, updates and rollbacks are counted.
const rec = vi.hoisted(() => ({
  row: { id: 7 } as Record<string, unknown> | undefined,
  updates: 0,
  rolledBack: 0
}))
vi.mock('../../../db/index.js', () => {
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve([]).then(res, rej)
        if (prop === 'first')
          return (...args: unknown[]) => Promise.resolve(args.length ? undefined : rec.row)
        if (prop === 'columnInfo')
          return () => Promise.resolve({ id: {}, name: {}, notes: {}, amount: {} })
        if (prop === 'update')
          return () => {
            rec.updates++
            return Promise.resolve(1)
          }
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain()
      },
      apply: () => chain()
    })
  const db = new Proxy(() => chain(), {
    get(_t, prop) {
      if (prop === 'raw')
        return (sql: string) =>
          // The column lookups answer the test table's columns; any other raw is a fragment.
          /information_schema\.columns/i.test(sql)
            ? Object.assign(
                Promise.resolve(
                  ['id', 'name', 'notes', 'amount'].map((c) => ({
                    COLUMN_NAME: c,
                    DATA_TYPE: c === 'amount' ? 'decimal' : c === 'id' ? 'int' : 'nvarchar'
                  }))
                ),
                { sql, toString: () => sql }
              )
            : { sql, toString: () => sql }
      if (prop === 'transaction')
        return async (fn?: (t: unknown) => unknown) =>
          fn
            ? fn(db)
            : Object.assign(() => chain(), {
                rollback: async () => {
                  rec.rolledBack++
                }
              })
      return () => chain()
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})

const scope = vi.hoisted(() => ({ restricted: false }))
vi.mock('../../../services/user-scopes.js', async (orig) => ({
  ...(await orig<object>()),
  getUserScopeEnforcement: vi.fn(async () =>
    scope.restricted
      ? { filters: [{ hops: [], ids: [1, 2, 3] }], deny: false }
      : { filters: [], deny: false }
  ),
  applyScopeEnforcement: vi.fn(),
  applyUserScopesToQuery: vi.fn(async () => {})
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => false),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/tree-permissions.js', async (orig) => ({
  ...(await orig<object>()),
  getTreePermission: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c, upsert_keys: null })),
  getFields: vi.fn(async () => [
    { field: 'name', type: 'string', interface: 'input', special: null, readonly: false },
    { field: 'notes', type: 'text', interface: 'input-multiline', special: null, readonly: false },
    { field: 'amount', type: 'decimal', special: null, readonly: false }
  ]),
  getRelations: vi.fn(async () => [])
}))
const lock = vi.hoisted(() => ({ refuse: false }))
vi.mock('../../../services/edit-lock.js', async (orig) => ({
  ...(await orig<object>()),
  assertNotEditLocked: vi.fn(async () => {
    if (lock.refuse)
      throw Object.assign(new Error('Waiting on Sam'), { statusCode: 409, code: 'EDIT_LOCKED' })
  })
}))
vi.mock('../../../middleware/workspace.js', async (orig) => ({
  ...(await orig<object>()),
  fetchDefaultWorkspaceId: vi.fn(async () => 'WS-DEFAULT')
}))

import { ItemNotFoundError, rehearseUpdate } from '../../../services/items.js'

const paul = { id: 'U-PAUL', role: 'APPROVER' } as never
const asCaller = { isAdmin: false } as never

beforeEach(() => {
  rec.row = { id: 7, name: 'Old name', notes: 'Kept', amount: 5 }
  rec.updates = 0
  rec.rolledBack = 0
  scope.restricted = false
  lock.refuse = false
})

describe('rehearseUpdate', () => {
  it('answers the before/after diff, tries the UPDATE and rolls it back', async () => {
    const report = await rehearseUpdate(
      paul,
      'workflows',
      '7',
      { name: 'New name', notes: 'Kept' },
      asCaller
    )
    expect(report).toMatchObject({ dry_run: true, ok: true, would: 'update', id: '7' })
    expect(report.changes).toContainEqual({ field: 'name', from: 'Old name', to: 'New name' })
    expect(report.unchanged).toContain('notes')
    expect(report.notes.join(' ')).toMatch(/Nothing was saved/)
    // Tried once, inside the transaction that was rolled back — never for real.
    expect(rec.updates).toBe(1)
    expect(rec.rolledBack).toBe(1)
  })

  it('a refusal comes back as the report, nothing tried', async () => {
    lock.refuse = true
    const report = await rehearseUpdate(paul, 'workflows', '7', { name: 'x' }, asCaller)
    expect(report).toMatchObject({ ok: false, status: 409, code: 'EDIT_LOCKED', would: null })
    expect(rec.updates).toBe(0)
  })

  it('a record outside the caller scope is a 404, as for a real update', async () => {
    scope.restricted = true
    rec.row = undefined
    await expect(
      rehearseUpdate(paul, 'workflows', '372797', { name: 'x' }, asCaller)
    ).rejects.toBeInstanceOf(ItemNotFoundError)
    expect(rec.updates).toBe(0)
  })
})
