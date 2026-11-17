import { beforeEach, describe, expect, it, vi } from 'vitest'

// Update guards in updateOne (EFP prod 2026-11-17, workflow 372787). One PATCH sent
// `divisions: {create: [3], delete: [3]}` (Zone 2 removed and picked again); the items
// service skipped the add (the link existed) and then ran the removal, so the save took
// the Zone off and the Zone-scoped writer lost the record. Harness from
// items-update-rehearsal.test.ts: any query-builder call chains, `.first()` answers
// `rec.row`, updates are counted.
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
  getRelations: vi.fn(async () => [
    {
      id: 1,
      many_collection: 'workflows_divisions',
      many_field: 'workflows_id',
      one_collection: 'workflows',
      one_field: 'divisions',
      junction_field: 'divisions_id'
    },
    {
      id: 2,
      many_collection: 'workflows_divisions',
      many_field: 'divisions_id',
      one_collection: 'divisions',
      one_field: null,
      junction_field: 'workflows_id'
    }
  ])
}))
vi.mock('../../../services/physical-tables.js', async (orig) => ({
  ...(await orig<object>()),
  liveRelations: vi.fn(async (rels: unknown[]) => rels)
}))
const guard = vi.hoisted(() => ({
  seen: [] as Array<Record<string, unknown>>,
  refuse: null as Error | null
}))
vi.mock('../../../services/update-guards.js', () => ({
  assertUpdateKeepsRecord: vi.fn(async (input: Record<string, unknown>) => {
    guard.seen.push(input)
    if (guard.refuse) throw guard.refuse
  })
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

import { updateOne } from '../../../services/items.js'

const eric = { id: 'U-ERIC', role: 'MEMBER' } as never
const asCaller = { isAdmin: false } as never

beforeEach(() => {
  rec.row = { id: 372787, name: 'CM27-81228', notes: 'Kept', amount: 5 }
  rec.updates = 0
  rec.rolledBack = 0
  scope.restricted = false
  lock.refuse = false
  guard.seen = []
  guard.refuse = null
})

describe('updateOne alias links + update guards', () => {
  it('a Zone removed and picked again in one body is no removal', async () => {
    await updateOne(
      eric,
      'workflows',
      '372787',
      { divisions: { create: [3], delete: [3] } },
      asCaller,
      undefined,
      { callerPayload: true }
    )
    expect(guard.seen).toHaveLength(1)
    const writes = guard.seen[0].linkWrites as Array<Record<string, unknown>>
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ field: 'divisions', links: [{ id: 3 }], removals: [] })
  })

  it('a real replace keeps its removal', async () => {
    await updateOne(
      eric,
      'workflows',
      '372787',
      { divisions: { create: [4], delete: [3] } },
      asCaller,
      undefined,
      { callerPayload: true }
    )
    const writes = guard.seen[0].linkWrites as Array<Record<string, unknown>>
    expect(writes[0]).toMatchObject({ links: [{ id: 4 }], removals: [{ id: 3 }] })
  })

  it('a guard refusal stores nothing: no UPDATE, no link writes', async () => {
    guard.refuse = Object.assign(new Error('Pick a Zone'), {
      statusCode: 422,
      code: 'OUT_OF_SCOPE'
    })
    await expect(
      updateOne(
        eric,
        'workflows',
        '372787',
        { name: 'New name', divisions: { delete: [3] } },
        asCaller,
        undefined,
        { callerPayload: true }
      )
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(rec.updates).toBe(0)
  })

  it('internal writes (no caller payload) are not judged', async () => {
    await updateOne(eric, 'workflows', '372787', { name: 'x' }, asCaller)
    expect(guard.seen).toHaveLength(0)
  })
})
