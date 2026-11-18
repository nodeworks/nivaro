import { beforeEach, describe, expect, it, vi } from 'vitest'

// Realtime gaps R1 + security review (2026-11-17): a record-grid total the server sums
// (`_sum_into`) is accepted only for a page grid's configured total, only where the caller
// may write it and every month, and it is judged by the edit lock, section/row locks and
// validation like any other written field — never written after them.

const rec = vi.hoisted(() => ({
  row: { id: 7, january: 1, february: 20, total: 21 } as Record<string, unknown>,
  revisions: [] as Array<{ id: number; delta: string | null; data: string | null }>,
  pages: [] as Array<{ layout: string }>,
  updateAllowed: null as string[] | null,
  sectionLocked: [] as string[]
}))
vi.mock('../../../db/index.js', () => {
  const rowsOf = (table: string) =>
    table === 'nivaro_revisions' ? rec.revisions : table === 'nivaro_pages' ? rec.pages : []
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rowsOf(table)).then(res, rej)
        if (prop === 'first') return () => Promise.resolve(rec.row)
        if (prop === 'columnInfo')
          return () => Promise.resolve({ id: {}, january: {}, february: {}, total: {}, status: {} })
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
  getAllowedFields: vi.fn(async (_u: unknown, phase: string) =>
    phase === 'update' || phase === 'create' ? rec.updateAllowed : null
  ),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/tree-permissions.js', async (orig) => ({
  ...(await orig<object>()),
  getTreePermission: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c, collision_detection: true })),
  getFields: vi.fn(async () =>
    ['january', 'february', 'total', 'status'].map((field) => ({
      field,
      type: 'decimal',
      interface: 'input',
      special: null,
      readonly: false
    }))
  ),
  getRelations: vi.fn(async () => [])
}))
// What the edit lock is asked to judge.
const seen = vi.hoisted(() => ({ lockPayload: null as Record<string, unknown> | null }))
const REACHED = vi.hoisted(() => new Error('reached'))
vi.mock('../../../services/edit-lock.js', async (orig) => ({
  ...(await orig<object>()),
  assertNotEditLocked: vi.fn(
    async (_u: unknown, _c: unknown, w: { payload: Record<string, unknown> }) => {
      seen.lockPayload = { ...w.payload }
      if (rec.sectionLocked.length === 0) throw REACHED
    }
  )
}))
vi.mock('../../../services/section-locks.js', async (orig) => ({
  ...(await orig<object>()),
  applySectionLocks: vi.fn(async (_c: string, payload: Record<string, unknown>) => {
    const dropped = rec.sectionLocked.filter((f) => f in payload)
    for (const f of dropped) delete payload[f]
    return dropped
  })
}))
const validated = vi.hoisted(() => ({ payload: null as Record<string, unknown> | null }))
vi.mock('../../../services/validation-rules.js', async (orig) => ({
  ...(await orig<object>()),
  enforceValidationRules: vi.fn(async (_c: string, payload: Record<string, unknown>) => {
    validated.payload = { ...payload }
    throw REACHED
  })
}))
vi.mock('../../../middleware/workspace.js', async (orig) => ({
  ...(await orig<object>()),
  fetchDefaultWorkspaceId: vi.fn(async () => 'WS-DEFAULT')
}))

import { updateOne } from '../../../services/items.js'
import { clearGridTotalsCache } from '../../../services/sum-into.js'

const rob = { id: 'U-ROB', role: 'PLANNER' } as never
const asCaller = { isAdmin: false } as never
const GRID = JSON.stringify({
  columns: 12,
  widgets: [
    {
      id: 'g',
      type: 'record-grid',
      config: { collection: 'fc', computed_total_field: 'total', month_sets: [{ suffix: '' }] }
    }
  ]
})
const SUM = { field: 'total', of: ['january', 'february'] }

beforeEach(() => {
  rec.row = { id: 7, january: 1, february: 20, total: 21 }
  rec.revisions = []
  rec.pages = [{ layout: GRID }]
  rec.updateAllowed = null
  rec.sectionLocked = []
  seen.lockPayload = null
  validated.payload = null
  clearGridTotalsCache()
})

const run = (body: Record<string, unknown>) =>
  updateOne(rob, 'fc', '7', body, asCaller, undefined, { callerPayload: true })

describe('_sum_into', () => {
  it("sums the stored row + this write into the grid's total, judged by the edit lock", async () => {
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
  })

  it("refuses a target that is not the grid's computed total", async () => {
    await expect(
      run({ january: 5, _sum_into: { field: 'status', of: ['january', 'february'] } })
    ).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
    // no grid configured for the collection at all
    rec.pages = []
    clearGridTotalsCache()
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
  })

  it('respects field-level write permission (the total and every month)', async () => {
    rec.updateAllowed = ['january', 'february'] // total not writable
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
    rec.updateAllowed = ['january', 'total'] // a month it sums is not writable
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
  })

  it('on a section-locked total field is stripped (and never put back)', async () => {
    rec.sectionLocked = ['total']
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
    expect(validated.payload).toEqual({ january: 5 })
  })

  it('is kept out of the mid-air check: a newer save of other months and the total is no conflict', async () => {
    rec.revisions = [{ id: 9002, delta: JSON.stringify({ february: 20, total: 21 }), data: null }]
    await expect(run({ january: 5, _sum_into: SUM, _base_revision: 9001 })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
  })
})
