import { beforeEach, describe, expect, it, vi } from 'vitest'

// canUpdateItem: the item-level gates updateOne applies before writing,
// usable by routes that change something about a record without writing it.

// Any query-builder call chains; `.first()` answers the row for the table and
// every where() is recorded so the row filter's presence can be checked.
const rec = vi.hoisted(() => ({
  row: { id: 7 } as Record<string, unknown> | undefined,
  wheres: [] as unknown[][]
}))
vi.mock('../../../db/index.js', () => {
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve([]).then(res, rej)
        if (prop === 'first') return () => Promise.resolve(rec.row)
        if (prop === 'where')
          return (...args: unknown[]) => {
            rec.wheres.push(args)
            return chain()
          }
        return () => chain()
      },
      apply: () => chain()
    })
  const db = new Proxy(() => chain(), {
    get(_t, prop) {
      if (prop === 'raw') return (sql: string) => ({ sql, toString: () => sql })
      return () => chain()
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})

const perm = vi.hoisted(() => ({
  canUpdate: true,
  tree: null as boolean | null,
  rowFilter: null as unknown[] | null,
  appliedFilter: false
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => false),
  can: vi.fn(async (_u: unknown, action: string) => action === 'update' && perm.canUpdate),
  getRowFilter: vi.fn(async () => perm.rowFilter),
  applyRowFilter: vi.fn(() => {
    perm.appliedFilter = true
  })
}))
vi.mock('../../../services/tree-permissions.js', async (orig) => ({
  ...(await orig<object>()),
  getTreePermission: vi.fn(async () => perm.tree)
}))

import { canUpdateItem } from '../../../services/items.js'

const user = { id: 'U1', role: 'R1' } as never

beforeEach(() => {
  rec.row = { id: 7 }
  rec.wheres = []
  perm.canUpdate = true
  perm.tree = null
  perm.rowFilter = null
  perm.appliedFilter = false
})

describe('canUpdateItem', () => {
  it('allows a record the update policy covers', async () => {
    expect(await canUpdateItem(user, 'orders', '7')).toBe(true)
  })

  it('refuses when the role may not update the collection', async () => {
    perm.canUpdate = false
    expect(await canUpdateItem(user, 'orders', '7')).toBe(false)
  })

  it('refuses an explicit tree deny on the item', async () => {
    perm.tree = false
    expect(await canUpdateItem(user, 'orders', '7')).toBe(false)
  })

  it("refuses a record outside the update policy's row filter", async () => {
    perm.rowFilter = [{ field: 'owner', op: 'eq', value: '$CURRENT_USER' }]
    rec.row = undefined
    expect(await canUpdateItem(user, 'orders', '7')).toBe(false)
    expect(perm.appliedFilter).toBe(true)
  })

  it('refuses system tables for non-admins and blank ids', async () => {
    expect(await canUpdateItem(user, 'nivaro_users', '7')).toBe(false)
    expect(await canUpdateItem(user, 'orders', '')).toBe(false)
  })
})
