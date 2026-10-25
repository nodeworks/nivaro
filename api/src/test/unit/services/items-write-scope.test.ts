import { beforeEach, describe, expect, it, vi } from 'vitest'

// Writes answer to the same User Scopes, field lists and read-only flags as
// reads (army v3, 2026-10-25): a Zone-scoped approver could PATCH and DELETE
// any workflow by id, name themselves its creator, and read a hidden
// forecast's whole row through a natural-key dry run.

// Any query-builder call chains. `.first()` answers the row the test set:
// `.first('id')` (the natural-key match) answers `rec.keyRow`, a bare
// `.first()` (record reads) answers `rec.row`. Updates/deletes are recorded.
const rec = vi.hoisted(() => ({
  row: { id: 7 } as Record<string, unknown> | undefined,
  keyRow: undefined as Record<string, unknown> | undefined,
  updates: 0,
  deletes: 0,
  offsets: [] as unknown[]
}))
vi.mock('../../../db/index.js', () => {
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve([]).then(res, rej)
        if (prop === 'first')
          return (...args: unknown[]) => Promise.resolve(args.length ? rec.keyRow : rec.row)
        if (prop === 'columnInfo') return () => Promise.resolve({ id: {}, name: {}, creator: {} })
        if (prop === 'update')
          return () => {
            rec.updates++
            return Promise.resolve(1)
          }
        if (prop === 'delete')
          return () => {
            rec.deletes++
            return Promise.resolve(1)
          }
        if (prop === 'offset')
          return (n: unknown) => {
            rec.offsets.push(n)
            return chain()
          }
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain()
      },
      apply: () => chain()
    })
  const db = new Proxy(() => chain(), {
    get(_t, prop) {
      if (prop === 'raw') return (sql: string) => ({ sql, toString: () => sql })
      if (prop === 'transaction') return async (fn: (t: unknown) => unknown) => fn(db)
      return () => chain()
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})

const scope = vi.hoisted(() => ({ restricted: false, applied: 0 }))
vi.mock('../../../services/user-scopes.js', async (orig) => ({
  ...(await orig<object>()),
  getUserScopeEnforcement: vi.fn(async () =>
    scope.restricted
      ? { filters: [{ hops: [], ids: [1, 2, 3] }], deny: false }
      : { filters: [], deny: false }
  ),
  applyScopeEnforcement: vi.fn((_q: unknown, _c: string, e: { filters: unknown[] }) => {
    if (e.filters.length > 0) scope.applied++
  }),
  applyUserScopesToQuery: vi.fn(async () => {
    if (scope.restricted) scope.applied++
  })
}))

const perm = vi.hoisted(() => ({ fields: null as string[] | null }))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => false),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => perm.fields),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/tree-permissions.js', async (orig) => ({
  ...(await orig<object>()),
  getTreePermission: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({
    collection: c,
    upsert_keys: c === 'forecasts' ? '["workflow","year"]' : null
  })),
  getFields: vi.fn(async () => [
    { field: 'creator', type: 'uuid', special: ['user-created'], readonly: false },
    { field: 'changed', type: 'datetime', special: ['date-updated'], readonly: false },
    { field: 'workflow_state', type: 'string', special: null, readonly: true },
    { field: 'name', type: 'string', interface: 'input', special: null, readonly: false },
    { field: 'notes', type: 'text', interface: 'input-multiline', special: null, readonly: false },
    { field: 'amount', type: 'decimal', special: null, readonly: false }
  ]),
  getRelations: vi.fn(async () => [])
}))
// Reaching the edit lock means every gate before it let the write through;
// it stops the run there so the test needs no hooks, rules or revisions.
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

// File links: workflows_files.directus_files_id points at the files table;
// file F-HIDDEN is attached only to a record the caller cannot open.
vi.mock('../../../services/file-usage.js', async (orig) => ({
  ...(await orig<object>()),
  getFileRefColumns: vi.fn(async () => [{ table: 'workflows_files', column: 'directus_files_id' }])
}))
vi.mock('../../../services/file-access.js', async (orig) => ({
  ...(await orig<object>()),
  readableFileIdList: vi.fn(
    async (ids: string[]) =>
      new Set(ids.filter((id) => id !== 'F-HIDDEN').map((id) => id.toLowerCase()))
  )
}))

import {
  assertLinkedFilesReadable,
  assertStringsFit,
  canUpdateItem,
  columnShapes,
  deleteOne,
  dropComputedColumns,
  dropServerSetFields,
  ItemNotFoundError,
  readItems,
  rehearseCreate,
  trimSingleLineInputs,
  updateOne
} from '../../../services/items.js'

const paul = { id: 'U-PAUL', role: 'APPROVER' } as never
const asCaller = { isAdmin: false } as never
const asAdmin = { isAdmin: true } as never

beforeEach(() => {
  rec.row = { id: 7 }
  rec.keyRow = undefined
  rec.updates = 0
  rec.deletes = 0
  rec.offsets = []
  scope.restricted = false
  scope.applied = 0
  perm.fields = null
})

describe('update and delete honour User Scopes', () => {
  it('a record outside the caller scope is a 404 before any hook or write', async () => {
    scope.restricted = true
    rec.row = undefined
    await expect(
      updateOne(paul, 'workflows', '372797', { considerations: 'x' }, asCaller)
    ).rejects.toBeInstanceOf(ItemNotFoundError)
    await expect(deleteOne(paul, 'workflows', '372798', asCaller)).rejects.toBeInstanceOf(
      ItemNotFoundError
    )
    expect(scope.applied).toBeGreaterThan(0)
    expect(rec.updates + rec.deletes).toBe(0)
  })

  it('a record inside the caller scope goes on to the next gate', async () => {
    scope.restricted = true
    rec.row = { id: 7 }
    await expect(updateOne(paul, 'workflows', '7', { considerations: 'x' }, asCaller)).rejects.toBe(
      REACHED
    )
    await expect(deleteOne(paul, 'workflows', '7', asCaller)).rejects.toBe(REACHED)
  })

  it('an unscoped caller costs no extra read and is not refused', async () => {
    rec.row = undefined
    await expect(updateOne(paul, 'workflows', '7', { x: 1 }, asCaller)).rejects.toBe(REACHED)
    expect(scope.applied).toBe(0)
  })

  it('canUpdateItem applies the scope', async () => {
    scope.restricted = true
    rec.row = undefined
    expect(await canUpdateItem(paul, 'workflows', '372797')).toBe(false)
    rec.row = { id: 7 }
    expect(await canUpdateItem(paul, 'workflows', '7')).toBe(true)
  })
})

describe('server-set fields', () => {
  it('a non-admin cannot name the creator, a stamp or a read-only field', async () => {
    const body: Record<string, unknown> = {
      creator: 'U-JOSELIN',
      changed: '2020-01-01',
      workflow_state: 'approved',
      amount: 5,
      _change_reason: 'kept'
    }
    const dropped = await dropServerSetFields(paul, 'workflows', body, 'update', asCaller, true)
    expect(dropped.sort()).toEqual(['changed', 'creator', 'workflow_state'])
    expect(body).toEqual({ amount: 5, _change_reason: 'kept' })
  })

  it('read-only fields stay for server code that writes them on the caller behalf', async () => {
    const body: Record<string, unknown> = { creator: 'U-X', workflow_state: 'approved' }
    await dropServerSetFields(paul, 'workflows', body, 'update', asCaller, false)
    expect(body).toEqual({ workflow_state: 'approved' })
  })

  it('fields outside the role write list are dropped', async () => {
    perm.fields = ['amount']
    const body: Record<string, unknown> = { amount: 5, name: 'x' }
    await dropServerSetFields(paul, 'workflows', body, 'create', asCaller, true)
    expect(body).toEqual({ amount: 5 })
  })

  it('an admin keeps every field', async () => {
    const body: Record<string, unknown> = { creator: 'U-X', workflow_state: 'approved' }
    expect(await dropServerSetFields(paul, 'workflows', body, 'update', asAdmin, true)).toEqual([])
    expect(body).toEqual({ creator: 'U-X', workflow_state: 'approved' })
  })
})

describe('natural-key dry run', () => {
  it('never echoes a matched row the caller cannot read', async () => {
    rec.keyRow = { id: 7651015 }
    scope.restricted = true
    rec.row = undefined
    const report = await rehearseCreate(
      paul,
      'forecasts',
      { workflow: 372786, year: 2026 },
      asCaller,
      undefined,
      { callerPayload: true }
    )
    expect(report.ok).toBe(false)
    expect(report.status).toBe(404)
    expect(report.data).toBeNull()
  })

  it('reports the update of a matched row the caller can read', async () => {
    rec.keyRow = { id: 41 }
    rec.row = { id: 41, workflow: 9, year: 2026, total: 3 }
    const report = await rehearseCreate(paul, 'forecasts', { workflow: 9, year: 2026 }, asCaller)
    expect(report.would).toBe('update')
    expect(report.matched_id).toBe(41)
  })
})

describe('text values', () => {
  it('trims single-line inputs only', async () => {
    const body: Record<string, unknown> = { name: '  Vendor X  ', notes: '  keep  ' }
    await trimSingleLineInputs('workflows', body)
    expect(body).toEqual({ name: 'Vendor X', notes: '  keep  ' })
  })

  it('names the field a too-long value belongs to', async () => {
    const shapes = await columnShapes('workflows')
    shapes.set('vendor_contact', { type: 'nvarchar', length: 255 } as never)
    await expect(
      assertStringsFit('workflows', { vendor_contact: 'x'.repeat(300) })
    ).rejects.toMatchObject({ statusCode: 400, field: 'vendor_contact', rule: 'max_length' })
    await expect(
      assertStringsFit('workflows', { vendor_contact: 'x'.repeat(255) })
    ).resolves.toBeUndefined()
  })
})

describe('list paging', () => {
  it('a negative or fractional offset / page reads from the start, never a driver error', async () => {
    for (const q of [{ offset: -5 }, { page: -3 }, { offset: Number.NaN }, { offset: 2.7 }]) {
      rec.offsets = []
      await readItems(paul, 'workflows', { limit: 1, ...q } as never).catch(() => undefined)
      for (const o of rec.offsets) expect(Number(o)).toBeGreaterThanOrEqual(0)
      expect(rec.offsets.every((o) => Number.isInteger(Number(o)))).toBe(true)
    }
  })

  it('a real page still pages', async () => {
    await readItems(paul, 'workflows', { limit: 10, page: 3 } as never).catch(() => undefined)
    expect(rec.offsets).toContain(20)
  })
})

describe('linked files and computed columns', () => {
  it('a non-admin cannot link a file attached to a record they cannot open', async () => {
    const sent = new Set(['workflows_id', 'directus_files_id'])
    await expect(
      assertLinkedFilesReadable(
        'workflows_files',
        { workflows_id: 7, directus_files_id: 'F-HIDDEN' },
        sent,
        { user: { id: 'U-PAUL' }, isAdmin: false } as never
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'FILE_NOT_READABLE' })
  })

  it('a readable file links; an admin links any file', async () => {
    const sent = new Set(['workflows_id', 'directus_files_id'])
    await expect(
      assertLinkedFilesReadable(
        'workflows_files',
        { workflows_id: 7, directus_files_id: 'F-MINE' },
        sent,
        { user: { id: 'U-PAUL' }, isAdmin: false } as never
      )
    ).resolves.toBeUndefined()
    await expect(
      assertLinkedFilesReadable(
        'workflows_files',
        { workflows_id: 7, directus_files_id: 'F-HIDDEN' },
        sent,
        { user: { id: 'U-ADMIN' }, isAdmin: true } as never
      )
    ).resolves.toBeUndefined()
  })

  it('a SQL computed column is never written', async () => {
    const shapes = await columnShapes('workflow_line_items')
    shapes.set('line_total', { type: 'decimal', computed: true } as never)
    shapes.set('price', { type: 'decimal', computed: false } as never)
    const row: Record<string, unknown> = { price: 2, line_total: 8 }
    await dropComputedColumns('workflow_line_items', row)
    expect(row).toEqual({ price: 2 })
  })
})
