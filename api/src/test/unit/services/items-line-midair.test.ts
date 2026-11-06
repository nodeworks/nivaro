import { beforeEach, describe, expect, it, vi } from 'vitest'

// army4 a10-3 (BLOCKER): a stale staged LINE edit overwrote someone else's
// newer save of the same line. The record form now sends `_base_revision` on
// every line PATCH; this proves the server judges a line (a child collection)
// exactly like a header: a newer revision touching a field the PATCH writes
// is a 409 MIDAIR_COLLISION naming that field, a disjoint one merges.

const rec = vi.hoisted(() => ({
  row: { id: 475838, quantity: 104 } as Record<string, unknown> | undefined,
  revisions: [] as Array<{ id: number; delta: string | null; data: string | null }>
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(table === 'nivaro_revisions' ? rec.revisions : []).then(res, rej)
        if (prop === 'first') return () => Promise.resolve(rec.row)
        if (prop === 'columnInfo')
          return () => Promise.resolve({ id: {}, quantity: {}, description: {} })
        if (prop === 'update' || prop === 'delete') return () => Promise.resolve(1)
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(table), {
    get(_t, prop) {
      if (prop === 'raw') return (sql: string) => ({ sql, toString: () => sql })
      if (prop === 'transaction') return async (fn: (t: unknown) => unknown) => fn(db)
      return () => chain('')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})
vi.mock('../../../services/user-scopes.js', async (orig) => ({
  ...(await orig<object>()),
  getUserScopeEnforcement: vi.fn(async () => ({ filters: [], deny: false })),
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
const col = vi.hoisted(() => ({ collision_detection: true as boolean | number }))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({
    collection: c,
    collision_detection: col.collision_detection
  })),
  getFields: vi.fn(async () => [
    { field: 'quantity', type: 'decimal', interface: 'input', special: null, readonly: false },
    { field: 'description', type: 'string', interface: 'input', special: null, readonly: false }
  ]),
  getRelations: vi.fn(async () => [])
}))
// The mid-air check runs before the edit lock: reaching it = no collision.
const REACHED = vi.hoisted(() => new Error('reached the edit lock'))
vi.mock('../../../services/edit-lock.js', async (orig) => ({
  ...(await orig<object>()),
  assertNotEditLocked: vi.fn(async () => {
    throw REACHED
  })
}))
vi.mock('../../../middleware/workspace.js', async (orig) => ({
  ...(await orig<object>()),
  fetchDefaultWorkspaceId: vi.fn(async () => 'WS-DEFAULT')
}))

import { updateOne } from '../../../services/items.js'

const ben = { id: 'U-BEN', role: 'ADMIN' } as never
const asCaller = { isAdmin: false } as never

beforeEach(() => {
  rec.row = { id: 475838, quantity: 104 }
  rec.revisions = []
  col.collision_detection = true
})

describe('a line PATCH with a stale base revision', () => {
  it('is refused (409 MIDAIR_COLLISION) when someone else saved the same field since', async () => {
    // Paul's save of quantity 104 is revision 9002; Ben's staged 103 was based on 9001.
    rec.revisions = [{ id: 9002, delta: JSON.stringify({ quantity: 104 }), data: null }]
    const err = (await updateOne(
      ben,
      'workflow_line_items',
      '475838',
      { quantity: 103, _base_revision: 9001 },
      asCaller
    ).catch((e) => e)) as { statusCode?: number; code?: string; conflicts?: unknown[] }
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('MIDAIR_COLLISION')
    expect(err.conflicts).toEqual([{ field: 'quantity', current_value: 104 }])
  })

  it('goes through when the newer save touched other fields only', async () => {
    rec.revisions = [{ id: 9002, delta: JSON.stringify({ description: 'x' }), data: null }]
    await expect(
      updateOne(
        ben,
        'workflow_line_items',
        '475838',
        { quantity: 103, _base_revision: 9001 },
        asCaller
      )
    ).rejects.toBe(REACHED)
  })

  it('goes through with no base (older clients) or with collision detection off', async () => {
    rec.revisions = [{ id: 9002, delta: JSON.stringify({ quantity: 104 }), data: null }]
    await expect(
      updateOne(ben, 'workflow_line_items', '475838', { quantity: 103 }, asCaller)
    ).rejects.toBe(REACHED)
    col.collision_detection = false
    await expect(
      updateOne(
        ben,
        'workflow_line_items',
        '475838',
        { quantity: 103, _base_revision: 9001 },
        asCaller
      )
    ).rejects.toBe(REACHED)
  })
})
