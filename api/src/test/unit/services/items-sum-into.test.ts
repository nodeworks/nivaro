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
  readAllowed: null as string[] | null,
  sectionLocked: [] as string[],
  rowLocked: [] as string[],
  /** The edit lock ends the run (REACHED); off = run on to validation. */
  stopAtLock: true,
  crConfig: null as string | null,
  pagesFail: false
}))
vi.mock('../../../db/index.js', () => {
  const rowsOf = (table: string) => {
    if (table === 'nivaro_pages' && rec.pagesFail) return Promise.reject(new Error('timeout'))
    return Promise.resolve(
      table === 'nivaro_revisions' ? rec.revisions : table === 'nivaro_pages' ? rec.pages : []
    )
  }
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            rowsOf(table).then(res, rej)
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
    phase === 'update' || phase === 'create'
      ? rec.updateAllowed
      : phase === 'read'
        ? rec.readAllowed
        : null
  ),
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
    collision_detection: true,
    change_reason_config: rec.crConfig
  })),
  getFields: vi.fn(async () =>
    [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
      'total',
      'status'
    ].map((field) => ({
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
      if (rec.stopAtLock) throw REACHED
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
vi.mock('../../../services/row-rules-autofill.js', async (orig) => ({
  ...(await orig<object>()),
  applyRowLocksOnWrite: vi.fn(async (_c: string, payload: Record<string, unknown>) => {
    for (const f of rec.rowLocked) delete payload[f]
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
import { clearGridTotalsCache, clearGridTotalsFor } from '../../../services/sum-into.js'

const rob = { id: 'U-ROB', role: 'PLANNER' } as never
const asCaller = { isAdmin: false } as never
const asAdmin = { isAdmin: true } as never
const M = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]
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
const SUM = { field: 'total', of: M }

beforeEach(() => {
  rec.row = { id: 7, january: 1, february: 20, total: 21 }
  rec.revisions = []
  rec.pages = [{ layout: GRID }]
  rec.updateAllowed = null
  rec.readAllowed = null
  rec.sectionLocked = []
  rec.rowLocked = []
  rec.stopAtLock = true
  rec.crConfig = null
  rec.pagesFail = false
  seen.lockPayload = null
  validated.payload = null
  clearGridTotalsCache()
})

const run = (body: Record<string, unknown>, req: never = asCaller) =>
  updateOne(rob, 'fc', '7', body, req, undefined, { callerPayload: true })

describe('_sum_into', () => {
  it("sums the stored row + this write into the grid's total, judged by the edit lock", async () => {
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
  })

  it("refuses a target that is not the grid's computed total", async () => {
    await expect(run({ january: 5, _sum_into: { field: 'status', of: M } })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
    // no grid configured for the collection at all
    rec.pages = []
    clearGridTotalsCache()
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
  })

  it('respects field-level write permission (the total and every month)', async () => {
    rec.updateAllowed = [...M] // total not writable
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
    rec.updateAllowed = [...M.filter((m) => m !== 'february'), 'total'] // a month it sums
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
  })

  it('is dropped when an of-field is writable but not readable', async () => {
    rec.updateAllowed = [...M, 'total']
    rec.readAllowed = [...M.filter((m) => m !== 'february'), 'total'] // february hidden
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
    rec.readAllowed = [...M, 'total']
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
  })

  it('on a section-locked total field is stripped (and never put back)', async () => {
    rec.sectionLocked = ['total']
    rec.stopAtLock = false
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
    expect(validated.payload).toEqual({ january: 5 })
  })

  it('is kept out of the mid-air check: a newer save of other months and the total is no conflict', async () => {
    rec.revisions = [{ id: 9002, delta: JSON.stringify({ february: 20, total: 21 }), data: null }]
    await expect(run({ january: 5, _sum_into: SUM, _base_revision: 9001 })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
  })

  it('a subset of the grid months is not its total', async () => {
    await expect(
      run({ january: 5, _sum_into: { field: 'total', of: ['january', 'february'] } })
    ).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
  })

  it('a client-sent total is dropped when _sum_into is rejected', async () => {
    await expect(
      run({ january: 5, total: 999, _sum_into: { field: 'total', of: ['january'] } })
    ).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
  })

  it('the change reason judges the total like any written field', async () => {
    rec.crConfig = JSON.stringify({ fields: ['total'], reasons: ['Re-plan'] })
    rec.stopAtLock = false
    const err = (await run({ january: 5, _sum_into: SUM }).catch((e) => e)) as {
      code?: string
      violations?: { fields_changed?: string[] }
    }
    expect(err.code).toBe('CHANGE_REASON_REQUIRED')
    expect(err.violations?.fields_changed).toEqual(['total'])
  })

  it('row locks strip the total, or a month (the total then sums what is really written)', async () => {
    rec.stopAtLock = false
    rec.rowLocked = ['total']
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(validated.payload).toEqual({ january: 5 })
    rec.rowLocked = ['january']
    await expect(run({ january: 5, february: 30, _sum_into: SUM })).rejects.toBe(REACHED)
    // january stays its stored 1: 1 + 30
    expect(validated.payload).toEqual({ february: 30, total: 31 })
  })

  it('admins skip the field-list checks', async () => {
    rec.updateAllowed = ['january'] // would refuse a non-admin
    rec.readAllowed = ['january']
    await expect(run({ january: 5, _sum_into: SUM }, asAdmin)).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
  })

  it('a failed page read is not cached as "no grids"', async () => {
    rec.pagesFail = true
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 })
    rec.pagesFail = false // the next write asks again, within the minute
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
  })

  it('a page save clears the grid totals: a new grid total is accepted at once', async () => {
    rec.pages = []
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5 }) // no grid yet (cached)
    rec.pages = [{ layout: GRID }] // the page is saved with the grid...
    clearGridTotalsFor() // ...and the pages route clears this tenant's totals
    await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
    expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
  })

  it('a refusal from a cache older than 5 s re-reads once (a page saved on another process)', async () => {
    const t0 = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    try {
      rec.pages = []
      await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
      rec.pages = [{ layout: GRID }]
      // still fresh: refused from the cache
      await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
      expect(seen.lockPayload).toEqual({ january: 5 })
      now.mockReturnValue(t0 + 6_000)
      await expect(run({ january: 5, _sum_into: SUM })).rejects.toBe(REACHED)
      expect(seen.lockPayload).toEqual({ january: 5, total: 25 })
    } finally {
      now.mockRestore()
    }
  })
})
