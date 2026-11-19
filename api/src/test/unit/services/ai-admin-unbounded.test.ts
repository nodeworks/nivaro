import { beforeEach, describe, expect, it, vi } from 'vitest'

// Ask AI for administrators on their own session (Rob 2026-11-18): no record limit on
// proposals, every change runs as a background plan whose writes are kept for undo.
// Pinned here without a database: who qualifies, the 200 cap for everyone else, the
// chunked write with progress / Stop / undo capture, and undo itself (update, create,
// delete, conflicts, overwrite, background).

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
function chain(table: string): Record<string, unknown> {
  const filters: Array<(r: Row) => boolean> = []
  const all = () => {
    if (!tables[table]) tables[table] = []
    return tables[table]
  }
  const rows = () => all().filter((r) => filters.every((f) => f(r)))
  const c: Record<string, unknown> = {}
  c.where = (a: unknown, b?: unknown, v?: unknown) => {
    if (a && typeof a === 'object') {
      const o = a as Row
      filters.push((r) => Object.entries(o).every(([k, x]) => String(r[k]) === String(x)))
    } else if (typeof a === 'string' && v !== undefined)
      filters.push((r) => (b === '>=' ? new Date(String(r[a])) >= (v as Date) : true))
    else if (typeof a === 'string') filters.push((r) => String(r[a]) === String(b))
    return c
  }
  c.whereIn = (k: string, vals: unknown[]) => {
    const s = new Set(vals.map(String))
    filters.push((r) => s.has(String(r[k])))
    return c
  }
  for (const m of ['orderBy', 'limit', 'select', 'whereNull']) c[m] = () => c
  c.modify = (fn: (q: unknown) => void) => {
    fn(c)
    return c
  }
  c.first = async () => [...rows()].reverse()[0]
  c.update = async (v: Row) => {
    const rs = rows()
    for (const r of rs) Object.assign(r, v)
    return rs.length
  }
  c.insert = async (v: Row | Row[]) => {
    for (const x of Array.isArray(v) ? v : [v]) all().push({ id: all().length + 1, ...x })
  }
  // biome-ignore lint/suspicious/noThenProperty: a knex query builder is awaitable
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows()).then(res, rej)
  c.catch = (rej: (e: unknown) => unknown) => Promise.resolve(rows()).catch(rej)
  return c
}
vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => chain(t)) }))
const emitted: Row[] = []
vi.mock('../../../services/io-holder.js', () => ({
  getApp: () => ({
    io: { to: () => ({ emit: (_e: string, p: Row) => emitted.push(p) }) },
    log: { error: vi.fn(), warn: vi.fn() }
  })
}))
const logActivity = vi.fn(async (..._a: unknown[]) => 1)
vi.mock('../../../services/activity.js', () => ({
  logActivity: (...a: unknown[]) => logActivity(...a)
}))
const notifyUser = vi.fn(async (..._a: unknown[]) => ({}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: (...a: unknown[]) => notifyUser(...a)
}))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'http://admin.test' }))
const isAdminRole = vi.fn(async (_r?: unknown) => true)
vi.mock('../../../services/user-scopes.js', () => ({
  isAdminRole: (r: unknown) => isAdminRole(r),
  getUserScopeEnforcement: vi.fn(async () => ({ deny: false, filters: [] }))
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  isAdminRole: (r: unknown) => isAdminRole(r),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/ai-field-info.js', () => ({
  localizeFilterDates: async (_u: unknown, _c: string, f: unknown) => f
}))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: async (_w: unknown, fn: () => Promise<unknown>) => fn()
}))
vi.mock('../../../services/ai-link-labels.js', () => ({
  linkLabelsAsUser: async (_u: unknown, m: Map<string, Set<string>>) => {
    const out: Record<string, string> = {}
    for (const [c, ids] of m) for (const id of ids) out[`${c}:${id}`] = `Unit ${id}`
    return out
  }
}))

// The units table and its revision witness, as the plan's own reads see them.
const units = new Map<string, Row>()
const revs = new Map<string, number>()
let nextRev = 100
vi.mock('../../../services/ai-plan-made.js', () => ({
  readRaw: async (_c: string, ids: string[]) =>
    new Map(ids.filter((id) => units.has(id)).map((id) => [id, { ...units.get(id)! }])),
  latestRevisionIds: async (_c: string, ids: string[]) =>
    new Map(ids.filter((id) => revs.has(id)).map((id) => [id, revs.get(id)!]))
}))
vi.mock('../../../services/db-batch.js', () => ({
  selectInChunks: async (ids: string[]) =>
    ids.filter((id) => units.has(id)).map((id) => ({ ...units.get(id)! }))
}))
const readItems = vi.fn()
const updateOne = vi.fn(async (_u: unknown, _c: string, id: string, data: Row) => {
  units.set(String(id), { ...(units.get(String(id)) ?? { id }), ...data })
  revs.set(String(id), nextRev++)
  return {}
})
const deleteOne = vi.fn(async (_u: unknown, _c: string, id: string) => {
  units.delete(String(id))
  revs.delete(String(id))
})
let createdSeq = 9000
const createOne = vi.fn(async (_u: unknown, _c: string, data: Row) => {
  const id = String(createdSeq++)
  units.set(id, { id, ...data })
  revs.set(id, nextRev++)
  return { id }
})
vi.mock('../../../services/items.js', () => ({
  readItems: (...a: unknown[]) => readItems(...a),
  updateOne: (...a: unknown[]) => updateOne(...(a as [unknown, string, string, Row])),
  deleteOne: (...a: unknown[]) => deleteOne(...(a as [unknown, string, string])),
  createOne: (...a: unknown[]) => createOne(...(a as [unknown, string, Row]))
}))
const restoreTrashRow = vi.fn(async (_u: unknown, trashId: number) => {
  const t = tables.nivaro_trash.find((r) => Number(r.id) === trashId)!
  const data = JSON.parse(String(t.data)) as Row
  units.set(String(t.item_id), data)
  revs.set(String(t.item_id), nextRev++)
  return { item_id: String(t.item_id) }
})
vi.mock('../../../services/trash.js', () => ({
  restoreTrashRow: (...a: unknown[]) => restoreTrashRow(...(a as [unknown, number]))
}))

// The undo store (migration 537), in memory.
let storeReady = true
const undoRows: Row[] = []
vi.mock('../../../services/ai-undo-store.js', () => ({
  INLINE_UNDO_CAP: 500,
  UNDO_RETENTION_DAYS: 30,
  undoStoreReady: async () => storeReady,
  undoExpiresAt: () => null,
  writeUndoRecords: async (planId: string, stepId: string, rows: Row[]) => {
    for (const r of rows)
      undoRows.push({ row_id: undoRows.length + 1, plan_id: planId, step_id: stepId, ...r })
  },
  readUndoRecords: async (
    planId: string,
    stepId: string,
    o: { afterRowId?: number; limit?: number; notUndone?: boolean } = {}
  ) =>
    undoRows
      .filter(
        (r) =>
          r.plan_id === planId &&
          r.step_id === stepId &&
          Number(r.row_id) > (o.afterRowId ?? 0) &&
          (!o.notUndone || r.undo_status == null)
      )
      .slice(0, o.limit ?? 500)
      .map((r) => ({
        row_id: r.row_id,
        id: String(r.item),
        collection: r.collection,
        op: r.op,
        before: r.before ?? {},
        after: r.after ?? {},
        rev: r.rev ?? null,
        ...(r.op === 'create' ? { created: true } : {}),
        ...(r.op === 'delete' ? { deleted: true } : {}),
        ...(r.undo_status === 'undone' ? { undone: true } : {}),
        ...(r.undo_status === 'redacted' ? { redacted: true } : {}),
        undo_status: r.undo_status ?? null,
        undo_note: null,
        created_at: null
      })),
  countUndoRecords: async (planId: string, stepId: string) => {
    const mine = undoRows.filter((r) => r.plan_id === planId && r.step_id === stepId)
    const undone = mine.filter((r) => r.undo_status === 'undone').length
    const redacted = mine.filter((r) => r.undo_status === 'redacted').length
    return {
      total: mine.length,
      undone,
      redacted,
      pending: mine.filter((r) => r.undo_status == null).length
    }
  },
  markUndoRows: async (ids: number[], status: string) => {
    for (const r of undoRows) if (ids.includes(Number(r.row_id))) r.undo_status = status
  },
  reopenUndoRows: async (planId: string, stepId: string) => {
    for (const r of undoRows)
      if (
        r.plan_id === planId &&
        r.step_id === stepId &&
        (r.undo_status === 'skipped' || r.undo_status === 'failed')
      )
        r.undo_status = null
  }
}))

const mode = await import('../../../services/ai-admin-mode.js')
const actions = await import('../../../services/ai-actions.js')
const steps = await import('../../../services/ai-plan-steps.js')
const bulk = await import('../../../services/ai-bulk-run.js')
const plans = await import('../../../services/ai-plans.js')
const undo = await import('../../../services/ai-plan-undo.js')

const admin = { id: 'A1', role: 'ADMIN' } as never
const member = { id: 'M1', role: 'MEMBER' } as never

/** readItems answering `n` matching ids, a page at a time (keyset), as the list read does. */
function matching(n: number) {
  readItems.mockImplementation(async (_u: unknown, _c: string, q: Row) => {
    const limit = Number(q.limit ?? 25)
    if (q.after !== undefined) {
      const start = q.after === 'start' ? 0 : Number(String(q.after).slice(1))
      const data = Array.from({ length: Math.max(0, Math.min(limit, n - start)) }, (_, i) => ({
        id: String(start + i + 1)
      }))
      return { data, next_cursor: start + data.length < n ? `c${start + data.length}` : null }
    }
    if (q.filter && (q.filter as Row).id) {
      const ids = (((q.filter as Row).id as Row)._in as string[]) ?? []
      return { data: ids.map((id) => ({ id })) }
    }
    return {
      data: Array.from({ length: Math.min(limit, n) }, (_, i) => ({
        id: String(i + 1),
        name: `U${i + 1}`
      }))
    }
  })
}

function seedUnits(n: number, zone = 'Zone 1') {
  for (let i = 1; i <= n; i++) {
    units.set(String(i), { id: String(i), zone })
    revs.set(String(i), i)
  }
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.nivaro_fields = [
    { collection: 'units', field: 'zone' },
    { collection: 'units', field: 'name' }
  ]
  units.clear()
  revs.clear()
  undoRows.length = 0
  emitted.length = 0
  storeReady = true
  nextRev = 100
  readItems.mockReset()
  updateOne.mockClear()
  deleteOne.mockClear()
  createOne.mockClear()
  restoreTrashRow.mockClear()
  logActivity.mockClear()
  isAdminRole.mockImplementation(async (r?: unknown) => r === 'ADMIN')
})

describe('who counts as an administrator on their own session', () => {
  const req = (over: Row) =>
    ({ user: { id: 'A1', role: 'ADMIN' }, isAdmin: true, authMethod: 'session', ...over }) as never
  it('a session admin qualifies; View-as, keys, tokens, OAuth, MCP and machines do not', () => {
    expect(mode.aiAdminUnboundedRequest(req({}))).toBe(true)
    expect(
      mode.aiAdminUnboundedRequest(req({ authMethod: 'masquerade', masqueradeAdminId: 'A9' }))
    ).toBe(false)
    expect(mode.aiAdminUnboundedRequest(req({ masqueradeAdminId: 'A9' }))).toBe(false)
    expect(mode.aiAdminUnboundedRequest(req({ authMethod: 'api_key', apiKeyId: 4 }))).toBe(false)
    expect(mode.aiAdminUnboundedRequest(req({ authMethod: 'key_sim' }))).toBe(false)
    expect(mode.aiAdminUnboundedRequest(req({ authMethod: 'token' }))).toBe(false)
    expect(mode.aiAdminUnboundedRequest(req({ authMethod: 'oauth' }))).toBe(false)
    expect(mode.aiAdminUnboundedRequest(req({ authMethod: 'device' }))).toBe(false)
    expect(mode.aiAdminUnboundedRequest(req({ mcpInner: true }))).toBe(false)
    expect(mode.aiAdminUnboundedRequest(req({ isAdmin: false }))).toBe(false)
    expect(
      mode.aiAdminUnboundedRequest(
        req({ user: { id: 'S1', role: 'ADMIN', account_kind: 'service' } })
      )
    ).toBe(false)
  })

  it('marks a copy — never the request user — and the mark cannot come from data', () => {
    const user = { id: 'A1', role: 'ADMIN' } as never
    const marked = mode.aiUserFor({ user, isAdmin: true, authMethod: 'session' } as never)
    expect(mode.isAiAdminUnbounded(marked)).toBe(true)
    expect(mode.isAiAdminUnbounded(user)).toBe(false)
    expect(mode.isAiAdminUnbounded({ ...(marked as object) } as never)).toBe(true)
    expect(mode.isAiAdminUnbounded(JSON.parse(JSON.stringify(marked)))).toBe(false)
    expect(
      mode.isAiAdminUnbounded({ id: 'A1', ai_admin_unbounded: true, unbounded: true } as never)
    ).toBe(false)
  })
})

describe('proposals: the 200 cap', () => {
  it('an administrator on their own session proposes all 62,283 matching records', async () => {
    matching(62_283)
    const built = await actions.buildAction(mode.withAiAdminUnbounded(admin), {
      action_type: 'bulk_update',
      collection: 'units',
      filter: { zone: { _eq: 'Zone 1' } },
      changes: { zone: 'EAST' }
    })
    expect(built.preview.count).toBe(62_283)
    expect((built.payload.ids as string[]).length).toBe(62_283)
    expect(built.preview.sample[0]).toEqual({ id: '1', label: 'Unit 1' })
    expect(built.preview.changes).toEqual({ zone: 'EAST' })
    // Read as the administrator, a keyset page of ids at a time.
    const q = readItems.mock.calls[0][2] as Row
    expect(q).toMatchObject({ fields: ['id'], limit: 1000, after: 'start', count: false })
  })

  it('everyone else — and an administrator who is not on their own session — keeps 200', async () => {
    matching(250)
    for (const who of [member, admin]) {
      await expect(
        actions.buildAction(who, {
          action_type: 'bulk_update',
          collection: 'units',
          filter: {},
          changes: { zone: 'EAST' }
        })
      ).rejects.toThrow(/more than 200 records/)
    }
    matching(150)
    const ok = await actions.buildAction(member, {
      action_type: 'bulk_update',
      collection: 'units',
      filter: {},
      changes: { zone: 'EAST' }
    })
    expect(ok.preview.count).toBe(150)
  })

  it('deleting and multi-create are for the unbounded administrator only', async () => {
    matching(3)
    await expect(
      actions.buildAction(admin, { action_type: 'bulk_delete', collection: 'units', filter: {} })
    ).rejects.toThrow(/administrators signed in as themselves/)
    await expect(
      actions.buildAction(member, {
        action_type: 'create_records',
        collection: 'units',
        records: [{ zone: 'A' }]
      })
    ).rejects.toThrow(/administrators signed in as themselves/)
    const del = await actions.buildAction(mode.withAiAdminUnbounded(admin), {
      action_type: 'bulk_delete',
      collection: 'units',
      filter: {}
    })
    expect(del.payload).toEqual({ ids: ['1', '2', '3'] })
  })

  it('a plan proposed by the unbounded administrator only runs for that caller', async () => {
    matching(300)
    tables.nivaro_ai_proposals = []
    const plan = await plans.proposePlan(mode.withAiAdminUnbounded(admin), {
      steps: [{ kind: 'bulk_update', collection: 'units', filter: {}, changes: { zone: 'EAST' } }]
    })
    expect(plan.title).toBe('Update 300 units records')
    expect(plan.admin_unbounded).toBe(true)
    await expect(plans.runPlan(admin, plan.plan_id)).rejects.toThrow(
      /administrator signed in as themselves/
    )
  })
})

describe('the chunked write', () => {
  const ctx = (over: Partial<import('../../../services/ai-plan-steps.js').PlanStepContext> = {}) =>
    ({
      planId: 'P1',
      stepId: 'S1',
      ...over
    }) as import('../../../services/ai-plan-steps.js').PlanStepContext

  it('writes every record through the items service, a chunk at a time, keeping undo data', async () => {
    seedUnits(120)
    const progress: Array<[number, number]> = []
    const out = await bulk.runBulkWrite(
      admin,
      { op: 'update', collection: 'units', ids: [...units.keys()], changes: { zone: 'EAST' } },
      ctx({ progress: (d, t) => void progress.push([d, t]) })
    )
    expect(out.ok).toBe(true)
    expect(out.records_changed).toBe(120)
    expect(updateOne).toHaveBeenCalledTimes(120)
    expect(progress).toEqual([
      [50, 120],
      [100, 120],
      [120, 120]
    ])
    expect(undoRows).toHaveLength(120)
    expect(undoRows[0]).toMatchObject({
      op: 'update',
      item: '1',
      before: { zone: 'Zone 1' },
      after: { zone: 'EAST' }
    })
    expect(out.made).toMatchObject({ store: 'table', count: 120, records: [] })
  })

  it('stops after the chunk in flight when the person presses Stop', async () => {
    seedUnits(120)
    let calls = 0
    const out = await bulk.runBulkWrite(
      admin,
      { op: 'update', collection: 'units', ids: [...units.keys()], changes: { zone: 'EAST' } },
      ctx({ shouldStop: () => calls++ >= 1 })
    )
    expect(out.stopped).toBe(true)
    expect(out.records_changed).toBe(50)
    expect(out.result).toMatchObject({ updated: 50, stopped: true, not_run: 70 })
    expect(undoRows).toHaveLength(50)
  })

  it('never writes more than it could undo on a database behind migration 537', async () => {
    storeReady = false
    seedUnits(501)
    const out = await bulk.runBulkWrite(
      admin,
      { op: 'update', collection: 'units', ids: [...units.keys()], changes: { zone: 'EAST' } },
      ctx()
    )
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/Nothing was changed/)
    expect(updateOne).not.toHaveBeenCalled()
  })

  it('names Ask AI on every activity row of the burst', async () => {
    const { currentActivityScope } = await import('../../../services/activity-scope.js')
    const seen: unknown[] = []
    updateOne.mockImplementationOnce(async () => {
      seen.push(currentActivityScope())
      return {}
    })
    seedUnits(1)
    await bulk.runBulkWrite(
      admin,
      { op: 'update', collection: 'units', ids: ['1'], changes: { zone: 'EAST' } },
      ctx()
    )
    expect(seen[0]).toEqual({
      group_key: 'ai-plan:P1',
      actor: { kind: 'mcp', id: 'ask-ai', name: 'Ask AI', on_behalf_of: 'A1' }
    })
  })
})

describe('undo', () => {
  const PLAN = '00000000-0000-0000-0000-0000000000a1'
  function putPlan(kind: string, count: number) {
    tables.nivaro_ai_proposals = [
      {
        id: PLAN,
        user: 'A1',
        action_type: 'plan',
        status: 'executed',
        created_at: new Date(),
        executed_at: new Date(),
        payload: JSON.stringify({
          title: 'T',
          admin_unbounded: true,
          steps: [
            {
              id: 'S1',
              n: 1,
              kind,
              title: 'Step',
              input: {},
              payload: { collection: 'units' },
              preview: { summary: 'x', count }
            }
          ],
          state: [{ id: 'S1', status: 'done', records_changed: count, attempts: 1 }],
          made: {
            S1: {
              collection: 'units',
              records: [],
              store: 'table',
              count,
              ran_at: new Date().toISOString()
            }
          }
        })
      }
    ]
  }
  const ctx = { planId: PLAN, stepId: 'S1' }
  const boss = () => mode.withAiAdminUnbounded(admin)

  it('puts updated values back, and reports conflicts until told to overwrite', async () => {
    matching(3)
    seedUnits(3)
    await bulk.runBulkWrite(
      admin,
      { op: 'update', collection: 'units', ids: ['1', '2', '3'], changes: { zone: 'EAST' } },
      ctx
    )
    putPlan('bulk_update', 3)
    // Someone edits unit 2 after the plan ran.
    units.set('2', { id: '2', zone: 'WEST' })
    revs.set('2', 999)
    const check = await undo.undoCheck(boss(), PLAN)
    expect(check.steps[0]).toMatchObject({ revertible: 2, changed: 1, gone: 0, total: 3 })
    expect(check.steps[0].records.find((r) => r.id === '2')).toMatchObject({
      status: 'changed',
      reason: 'edited since the plan ran'
    })
    const first = await undo.undoPlan(boss(), PLAN)
    expect(first).toMatchObject({ undone: 2, skipped: 1, failed: 0 })
    expect(units.get('1')?.zone).toBe('Zone 1')
    expect(units.get('2')?.zone).toBe('WEST')
    const again = await undo.undoPlan(boss(), PLAN, null, { overwrite: true })
    expect(again).toMatchObject({ undone: 1, overwritten: 1 })
    expect(units.get('2')?.zone).toBe('Zone 1')
    await expect(undo.undoPlan(boss(), PLAN)).rejects.toThrow(/Nothing left to undo/)
  })

  it('deletes what the plan created', async () => {
    await bulk.runBulkWrite(
      admin,
      { op: 'create', collection: 'units', records: [{ zone: 'A' }, { zone: 'B' }] },
      ctx
    )
    putPlan('create_records', 2)
    const out = await undo.undoPlan(boss(), PLAN)
    expect(out.undone).toBe(2)
    expect(deleteOne).toHaveBeenCalledTimes(2)
    expect(units.size).toBe(0)
  })

  it('a delete keeps no copy of the row and restores from the trash while it holds it', async () => {
    matching(2)
    seedUnits(2)
    await bulk.runBulkWrite(admin, { op: 'delete', collection: 'units', ids: ['1', '2'] }, ctx)
    expect(units.size).toBe(0)
    // Only a pointer: nothing of the deleted rows sits in the undo store.
    expect(undoRows.map((r) => [r.op, r.before, r.after])).toEqual([
      ['delete', null, null],
      ['delete', null, null]
    ])
    // The trash still holds unit 1; unit 2's trash row is gone (its collection's window
    // ended): that one can no longer come back, and undo says so.
    tables.nivaro_trash = [
      {
        id: 1,
        collection: 'units',
        item_id: '1',
        data: JSON.stringify({ id: '1', zone: 'Zone 1' }),
        deleted_at: new Date()
      }
    ]
    putPlan('bulk_delete', 2)
    const check = await undo.undoCheck(boss(), PLAN)
    expect(check.steps[0]).toMatchObject({ revertible: 1, gone: 1 })
    expect(check.steps[0].records.find((r) => r.id === '2')?.reason).toMatch(
      /no longer in the trash/
    )
    const out = await undo.undoPlan(boss(), PLAN)
    expect(out).toMatchObject({ undone: 1, skipped: 1, failed: 0 })
    expect(restoreTrashRow).toHaveBeenCalledTimes(1)
    expect(units.get('1')).toEqual({ id: '1', zone: 'Zone 1' })
    expect(units.has('2')).toBe(false)
  })

  it('a record whose undo values a redaction removed is never put back', async () => {
    matching(2)
    seedUnits(2)
    await bulk.runBulkWrite(
      admin,
      { op: 'update', collection: 'units', ids: ['1', '2'], changes: { zone: 'EAST' } },
      ctx
    )
    putPlan('bulk_update', 2)
    undoRows[1].undo_status = 'redacted'
    undoRows[1].before = null
    undoRows[1].after = null
    const check = await undo.undoCheck(boss(), PLAN)
    expect(check.steps[0]).toMatchObject({ revertible: 1, gone: 1 })
    expect(check.steps[0].records.find((r) => r.id === '2')?.reason).toMatch(/redaction/)
    const out = await undo.undoPlan(boss(), PLAN)
    expect(out).toMatchObject({ undone: 1, failed: 0 })
    expect(updateOne).toHaveBeenCalledTimes(3) // two plan writes + one undo
    expect(units.get('2')?.zone).toBe('EAST')
    // Nothing is left to undo: the redacted record counts as settled, not pending.
    await expect(undo.undoPlan(boss(), PLAN)).rejects.toThrow(/Nothing left to undo/)
  })

  it('a big undo answers at once and finishes in the background', async () => {
    seedUnits(250)
    await bulk.runBulkWrite(
      admin,
      { op: 'update', collection: 'units', ids: [...units.keys()], changes: { zone: 'EAST' } },
      ctx
    )
    putPlan('bulk_update', 250)
    const out = await undo.undoPlan(boss(), PLAN)
    expect(out).toMatchObject({ running: true, total: 250 })
    await vi.waitFor(() => expect(notifyUser).toHaveBeenCalled())
    expect([...units.values()].every((u) => u.zone === 'Zone 1')).toBe(true)
    const doc = JSON.parse(String(tables.nivaro_ai_proposals[0].payload))
    expect(doc.undo_run).toMatchObject({ status: 'done', undone: 250, total: 250 })
  })

  it('an unbounded plan is undone only by an administrator on their own session', async () => {
    putPlan('bulk_update', 1)
    await expect(undo.undoCheck(admin, PLAN)).rejects.toThrow(/signed in as themselves/)
    await expect(undo.undoCheck(member, PLAN)).rejects.toThrow(/Only administrators/)
  })
})

describe('step kinds', () => {
  it('registers delete and multi-create for the plan', () => {
    expect(steps.getPlanStepKind('bulk_delete')?.label).toBe('Delete records')
    expect(steps.getPlanStepKind('create_records')?.label).toBe('Create records')
  })
})

describe('a big step inside a plan run', () => {
  it('saves progress with a heartbeat and keeps the undo data off the plan JSON', async () => {
    matching(120)
    seedUnits(120)
    tables.nivaro_ai_proposals = []
    const boss = mode.withAiAdminUnbounded(admin)
    const plan = await plans.proposePlan(boss, {
      steps: [{ kind: 'bulk_update', collection: 'units', filter: {}, changes: { zone: 'EAST' } }]
    })
    const { doc } = await plans.loadPlan(plan.plan_id)
    const view = await plans.executePlan(boss, plan.plan_id, doc, null)
    expect(view.status).toBe('executed')
    expect(view.records_changed).toBe(120)
    const state = doc.state[0]
    expect(state.progress).toEqual({ done: 120, total: 120 })
    expect(state.heartbeat_at).toBeTruthy()
    expect(doc.made?.[doc.steps[0].id]).toMatchObject({ store: 'table', count: 120, records: [] })
    expect(view.made_steps).toEqual([doc.steps[0].id])
    // Live progress went to the person's socket while it ran.
    expect(emitted.some((p) => (p.step as Row | undefined)?.progress)).toBe(true)
    // A long step is not a dead run while its heartbeat is fresh.
    expect(plans.isStaleRun(doc, Date.now() + 60_000)).toBe(false)
  })
})
