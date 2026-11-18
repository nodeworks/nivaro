import { beforeEach, describe, expect, it, vi } from 'vitest'

// updateOne + a named step (services/update-state.ts, 2026-11-18): the move is judged
// BEFORE anything is written, on the values the update will store; a refusal writes
// nothing (fields included); an allowed move runs after the fields are saved; a move
// that then fails leaves the fields saved and says so.

const rec = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; row: unknown }>,
  order: [] as string[]
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(table === 'workflows' ? [{ id: 373049 }] : []).then(res, rej)
        if (prop === 'columnInfo')
          return async () =>
            table === 'workflows'
              ? Object.fromEntries(['id', 'name', 'cancel_reason'].map((c) => [c, {}]))
              : {}
        if (prop === 'first')
          return () =>
            Promise.resolve(
              table === 'workflows' ? { id: 373049, name: 'old', cancel_reason: null } : undefined
            )
        if (prop === 'update')
          return (row: unknown) => {
            rec.updates.push({ table, row })
            rec.order.push(`update:${table}`)
            return chain(table)
          }
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(table), {
    get(_t, prop) {
      if (prop === 'raw')
        return (sql: string, bindings?: unknown[]) =>
          Object.assign(
            Promise.resolve(
              /information_schema\.columns/.test(sql) && bindings?.[0] === 'workflows'
                ? ['id', 'name', 'cancel_reason'].map((COLUMN_NAME) => ({ COLUMN_NAME }))
                : []
            ),
            { sql, toString: () => sql }
          )
      if (prop === 'transaction')
        return async () => Object.assign((t: string) => chain(t), { rollback: async () => {} })
      return () => chain('raw')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => false),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c })),
  getFields: vi.fn(async (c: string) =>
    c === 'workflows'
      ? ['id', 'name', 'cancel_reason'].map((field) => ({
          collection: c,
          field,
          type: field === 'id' ? 'integer' : 'string'
        }))
      : []
  ),
  getRelations: vi.fn(async () => [])
}))
vi.mock('../../../hooks/registry.js', () => ({
  hooks: {
    trigger: vi.fn(async (timing: string) => {
      rec.order.push(`hooks:${timing}`)
    }),
    before: vi.fn(),
    after: vi.fn()
  }
}))

const st = vi.hoisted(() => ({
  plan: vi.fn(),
  judge: vi.fn(),
  run: vi.fn()
}))
vi.mock('../../../services/update-state.js', async (orig) => {
  const real = await orig<typeof import('../../../services/update-state.js')>()
  return {
    ...real,
    planStateMove: st.plan,
    judgeStateMove: st.judge,
    runStateMove: st.run
  }
})

import { type CreateOutcome, updateOne } from '../../../services/items.js'
import { UpdateStateRefusal } from '../../../services/update-state.js'

const user = { id: 'U-LINX', role: 'R-INT' } as never
const TARGET = { id: 'S-CAN', key: 'canceled', label: 'Canceled' }
const CANCEL = { id: 'T-CANCEL', label: 'Cancel Workflow', from_state: null, required_roles: null }
const planOf = (noop = false) => ({
  collection: 'workflows',
  item: '373049',
  value: 'canceled',
  instance: { id: 'I-1', template: 'T', current_state: 'S-MGR', completed_at: null },
  current: { id: 'S-MGR', key: 'manager_approval', label: 'Manager Approval' },
  target: TARGET,
  noop,
  candidates: noop ? [] : [CANCEL]
})
const MOVED = {
  moved: true,
  target: { key: 'canceled', label: 'Canceled' },
  from: { key: 'manager_approval', label: 'Manager Approval' },
  to: { key: 'canceled', label: 'Canceled' },
  transition: { id: 'T-CANCEL', label: 'Cancel Workflow' }
}

const recordUpdates = () => rec.updates.filter((u) => u.table === 'workflows')

beforeEach(() => {
  rec.updates = []
  rec.order = []
  st.plan.mockReset().mockImplementation(async () => planOf())
  st.judge.mockReset().mockImplementation(async () => {
    rec.order.push('judge')
    return CANCEL
  })
  st.run.mockReset().mockImplementation(async () => {
    rec.order.push('run')
    return MOVED
  })
})

describe('updateOne with a named step', () => {
  it('fields + step: judged first, on the NEW values, then written, then moved', async () => {
    const outcome: CreateOutcome = {}
    await updateOne(
      user,
      'workflows',
      373049,
      { cancel_reason: 'Duplicate', $state: 'canceled', $state_comment: 'per LinX' },
      undefined,
      undefined,
      { callerPayload: true, outcome }
    )
    expect(st.plan).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'workflows', item: 373049, value: 'canceled' })
    )
    const judged = st.judge.mock.calls[0][1] as Record<string, unknown>
    // Requirements / conditions read the record as this update will store it.
    expect(judged.pending).toMatchObject({ cancel_reason: 'Duplicate' })
    expect(judged.comment).toBe('per LinX')
    expect(rec.order.indexOf('judge')).toBeLessThan(rec.order.indexOf('update:workflows'))
    expect(rec.order.indexOf('update:workflows')).toBeLessThan(rec.order.indexOf('run'))
    // The step is never a column.
    expect(recordUpdates()[0].row).toMatchObject({ cancel_reason: 'Duplicate' })
    expect(recordUpdates()[0].row).not.toHaveProperty('$state')
    expect(recordUpdates()[0].row).not.toHaveProperty('$state_comment')
    expect(st.run.mock.calls[0][2]).toMatchObject({ comment: 'per LinX' })
    expect(outcome.state).toEqual(MOVED)
  })

  it('a refused move (owner-only, non-owner) writes NOTHING — fields untouched, no hooks after', async () => {
    st.judge.mockRejectedValue(
      new UpdateStateRefusal(
        403,
        'TRANSITION_OWNER_REQUIRED',
        'Only the owner of Manager Approval can make this move.'
      )
    )
    const err = (await updateOne(
      user,
      'workflows',
      373049,
      { cancel_reason: 'Duplicate', $state: 'canceled' },
      undefined,
      undefined,
      { callerPayload: true }
    ).catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('TRANSITION_OWNER_REQUIRED')
    expect(recordUpdates()).toHaveLength(0)
    expect(rec.order).not.toContain('hooks:after')
    expect(st.run).not.toHaveBeenCalled()
  })

  it('a plan refusal (unknown step) also writes nothing', async () => {
    st.plan.mockRejectedValue(new UpdateStateRefusal(400, 'STATE_UNKNOWN', 'no step "x"'))
    const err = (await updateOne(
      user,
      'workflows',
      373049,
      { name: 'new', $state: 'x' },
      undefined,
      undefined,
      { callerPayload: true }
    ).catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(400)
    expect(recordUpdates()).toHaveLength(0)
  })

  it('a move that fails after the write: the fields stay, the outcome says why', async () => {
    const failed = {
      moved: false,
      target: { key: 'canceled', label: 'Canceled' },
      status: 422,
      error:
        'Cancel Workflow did not go through. The record was not moved (your other changes were saved): Fusion refused',
      fields_saved: true
    }
    st.run.mockResolvedValue(failed)
    const outcome: CreateOutcome = {}
    await updateOne(
      user,
      'workflows',
      373049,
      { name: 'new', $state: 'canceled' },
      undefined,
      undefined,
      { callerPayload: true, outcome }
    )
    expect(recordUpdates()).toHaveLength(1)
    expect(outcome.state).toEqual(failed)
  })

  it('the step it already stands in: no move, no judge, the outcome says already', async () => {
    st.plan.mockResolvedValue(planOf(true))
    const outcome: CreateOutcome = {}
    await updateOne(
      user,
      'workflows',
      373049,
      { name: 'new', $state: 'canceled' },
      undefined,
      undefined,
      { callerPayload: true, outcome }
    )
    expect(st.judge).not.toHaveBeenCalled()
    expect(st.run).not.toHaveBeenCalled()
    expect(recordUpdates()).toHaveLength(1)
    expect(outcome.state).toMatchObject({ moved: false, already: true })
  })

  it('a step alone: no field write and no update hooks — judged, then moved', async () => {
    const outcome: CreateOutcome = {}
    await updateOne(user, 'workflows', 373049, { $state: 'canceled' }, undefined, undefined, {
      callerPayload: true,
      outcome
    })
    expect(recordUpdates()).toHaveLength(0)
    expect(rec.order.filter((o) => o.startsWith('hooks'))).toEqual([])
    expect(rec.order).toEqual(['judge', 'run'])
    expect(st.run.mock.calls[0][2]).toMatchObject({ fieldsWritten: false })
    expect(outcome.state).toEqual(MOVED)
  })

  it('a step alone that the move then refuses is thrown with its own status', async () => {
    st.run.mockResolvedValue({
      moved: false,
      target: { key: 'canceled', label: 'Canceled' },
      status: 422,
      code: 'TRANSITION_REFUSED',
      error: 'Cancel Workflow did not go through. The record was not moved: Fusion refused'
    })
    const err = (await updateOne(
      user,
      'workflows',
      373049,
      { $state: 'canceled' },
      undefined,
      undefined,
      { callerPayload: true }
    ).catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(422)
    expect(err.message).toContain('did not go through')
  })

  it('the GraphQL argument (opts.state) is the same thing', async () => {
    await updateOne(user, 'workflows', 373049, { name: 'new' }, undefined, undefined, {
      callerPayload: true,
      state: 'canceled',
      stateComment: 'per LinX'
    })
    expect(st.plan.mock.calls[0][0]).toMatchObject({ value: 'canceled' })
    expect(st.judge.mock.calls[0][1]).toMatchObject({ comment: 'per LinX' })
  })

  it("only the caller's own write names a step: an internal write's $state is dropped", async () => {
    await updateOne(user, 'workflows', 373049, { name: 'new', $state: 'canceled' })
    expect(st.plan).not.toHaveBeenCalled()
    expect(recordUpdates()[0].row).not.toHaveProperty('$state')
  })

  it('$state echoed back in its READ shape ({key,…}) is not a move', async () => {
    await updateOne(
      user,
      'workflows',
      373049,
      { name: 'new', $state: { key: 'open', label: 'Open' } },
      undefined,
      undefined,
      { callerPayload: true }
    )
    expect(st.plan).not.toHaveBeenCalled()
    expect(recordUpdates()).toHaveLength(1)
  })

  it('a rehearsal (dry run) judges the move and says which transition; no move runs', async () => {
    const report = (await updateOne(
      user,
      'workflows',
      373049,
      { name: 'new', $state: 'canceled' },
      undefined,
      undefined,
      { callerPayload: true, dryRun: true }
    )) as unknown as Record<string, unknown>
    expect(st.judge).toHaveBeenCalled()
    expect(st.run).not.toHaveBeenCalled()
    expect(report.state).toMatchObject({
      would_move: true,
      transition: { id: 'T-CANCEL', label: 'Cancel Workflow' }
    })
  })
})
