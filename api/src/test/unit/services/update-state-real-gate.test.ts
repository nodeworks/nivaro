import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real thing, end to end inside the API (review round 3): updateOne with `$state` goes
// through the REAL plan, the REAL judge and the REAL manualTransitionRefusal +
// evaluateTransitionRequirements — only the database, the owner lookup below the gate and
// the move itself (runRecordTransition, covered on its own) are stand-ins.

const st = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; row: Record<string, unknown> }>,
  record: {} as Record<string, unknown>,
  transition: {} as Record<string, unknown>,
  owner: vi.fn(),
  run: vi.fn()
}))

const STATES = [
  { id: 'S-MGR', key: 'manager_approval', label: 'Manager Approval', sort: 2, template: 'T' },
  { id: 'S-CAN', key: 'canceled', label: 'Canceled', sort: 9, template: 'T' }
]
const COLS = ['id', 'name', 'cancel_reason']

vi.mock('../../../db/index.js', () => {
  const rowsOf = (table: string): Array<Record<string, unknown>> => {
    if (table === 'workflows') return [st.record]
    if (table === 'nivaro_workflow_bindings')
      return [{ collection: 'workflows', template: 'T', state_field: null }]
    if (table === 'nivaro_workflow_states') return STATES
    if (table === 'nivaro_workflow_transitions') return [st.transition]
    return []
  }
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rowsOf(table)).then(res, rej)
        if (prop === 'first') return () => Promise.resolve(rowsOf(table)[0])
        if (prop === 'select') return () => chain(table)
        if (prop === 'columnInfo')
          return async () =>
            table === 'workflows' ? Object.fromEntries(COLS.map((c) => [c, {}])) : {}
        if (prop === 'update')
          return (row: Record<string, unknown>) => {
            st.updates.push({ table, row })
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
                ? COLS.map((COLUMN_NAME) => ({ COLUMN_NAME }))
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
      ? COLS.map((field) => ({ collection: c, field, type: field === 'id' ? 'integer' : 'string' }))
      : []
  ),
  getRelations: vi.fn(async () => [])
}))
vi.mock('../../../hooks/registry.js', () => ({
  hooks: { trigger: vi.fn(async () => {}), before: vi.fn(), after: vi.fn() }
}))
vi.mock('../../../services/instance-guard.js', async (orig) => ({
  ...(await orig<object>()),
  assertInstanceAccess: vi.fn(async () => {})
}))
vi.mock('../../../services/branch-instances.js', async (orig) => ({
  ...(await orig<object>()),
  findRecordInstance: vi.fn(async () => ({
    id: 'I-1',
    collection: 'workflows',
    item: '7',
    template: 'T',
    current_state: 'S-MGR',
    completed_at: null
  }))
}))
vi.mock('../../../services/edit-lock.js', async (orig) => ({
  ...(await orig<object>()),
  adminOnlyTransitionsFor: vi.fn(async () => new Set<string>()),
  adminOnlyStateOf: vi.fn(async () => null)
}))
vi.mock('../../../services/record-access.js', async (orig) => ({
  ...(await orig<object>()),
  checkTransitionOwner: st.owner
}))
vi.mock('../../../services/record-transition.js', async (orig) => ({
  ...(await orig<object>()),
  runRecordTransition: st.run
}))

import { type CreateOutcome, updateOne } from '../../../services/items.js'
import type { UpdateStateRefusal } from '../../../services/update-state.js'

const user = { id: 'U-CLERK', role: 'R-CLERK' } as never
const CANCEL = {
  id: 'T-CANCEL',
  template: 'T',
  label: 'Cancel Workflow',
  from_state: 'S-MGR',
  to_state: 'S-CAN',
  required_roles: null,
  auto_trigger: false,
  sort: 0
}
const recordWrites = () => st.updates.filter((u) => u.table === 'workflows')

beforeEach(() => {
  st.updates = []
  st.record = { id: 7, name: 'old', cancel_reason: null }
  st.transition = { ...CANCEL }
  st.owner.mockReset().mockResolvedValue({ allowed: true, message: '' })
  st.run.mockReset().mockResolvedValue({
    status: 200,
    body: { data: { new_state: { key: 'canceled', label: 'Canceled' } } }
  })
})

describe('updateOne + $state through the real judge and manual-move gate', () => {
  it('owner-only move by a non-owner: refused with the gate’s code, NOTHING written', async () => {
    st.transition = { ...CANCEL, require_owner: true }
    st.owner.mockResolvedValue({
      allowed: false,
      message: 'Only the owner of Manager Approval can make this move.'
    })
    const err = (await updateOne(
      user,
      'workflows',
      7,
      { name: 'new', $state: 'canceled' },
      undefined,
      undefined,
      { callerPayload: true, acceptStateMove: true }
    ).catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('TRANSITION_OWNER_REQUIRED')
    expect(err.message).toBe('Only the owner of Manager Approval can make this move.')
    expect(st.owner).toHaveBeenCalledWith(
      expect.objectContaining({ user, collection: 'workflows', item: '7', instanceId: 'I-1' })
    )
    expect(recordWrites()).toHaveLength(0)
    expect(st.run).not.toHaveBeenCalled()
  })

  it('a requirement the same update fills is met (judged on the pending values), then moved', async () => {
    st.transition = {
      ...CANCEL,
      requirements: JSON.stringify([
        { type: 'record_fields', title: 'Cancel reason', fields: ['cancel_reason'] }
      ])
    }
    const outcome: CreateOutcome = {}
    await updateOne(
      user,
      'workflows',
      7,
      { cancel_reason: 'Duplicate request', $state: 'canceled' },
      undefined,
      undefined,
      { callerPayload: true, acceptStateMove: true, outcome }
    )
    expect(recordWrites()[0].row).toMatchObject({ cancel_reason: 'Duplicate request' })
    expect(st.run).toHaveBeenCalledWith(expect.objectContaining({ transitionId: 'T-CANCEL' }))
    expect(outcome.state).toMatchObject({ result: 'moved', moved: true })
  })

  it('the same requirement without the value: 422 TRANSITION_REQUIREMENTS, nothing written', async () => {
    st.transition = {
      ...CANCEL,
      requirements: JSON.stringify([
        { type: 'record_fields', title: 'Cancel reason', fields: ['cancel_reason'] }
      ])
    }
    const err = (await updateOne(
      user,
      'workflows',
      7,
      { name: 'new', $state: 'canceled' },
      undefined,
      undefined,
      { callerPayload: true, acceptStateMove: true }
    ).catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(422)
    expect(err.code).toBe('TRANSITION_REQUIREMENTS')
    expect(err.message).toContain('Cancel reason')
    expect(recordWrites()).toHaveLength(0)
  })

  it('lines added in the same request: a child_fields requirement waits for the post-write judgment', async () => {
    // Submit needs lines; the record has none yet and the update adds them. Judged before
    // the write, child rows would read as missing — so that check is left to the move.
    st.transition = {
      ...CANCEL,
      requirements: JSON.stringify([
        {
          type: 'child_fields',
          collection: 'workflow_lines',
          fk_field: 'workflow',
          fields: ['qty'],
          title: 'Lines'
        }
      ])
    }
    const outcome: CreateOutcome = {}
    await updateOne(
      user,
      'workflows',
      7,
      { name: 'new', lines: { create: [{ qty: 2 }] }, $state: 'canceled' },
      undefined,
      undefined,
      { callerPayload: true, acceptStateMove: true, outcome }
    )
    expect(recordWrites()).toHaveLength(1)
    expect(st.run).toHaveBeenCalledTimes(1)
    expect(outcome.state?.result).toBe('moved')
  })
})
