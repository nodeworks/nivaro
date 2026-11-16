import { beforeEach, describe, expect, it, vi } from 'vitest'

// Create a record in a chosen pipeline step (2026-11-16): the gate that runs
// before the row is written. Rob: "we need to be able to create a workflow in a
// certain state in one mutation" (LinX).

const db = vi.hoisted(() => ({
  binding: null as Record<string, unknown> | null,
  states: [] as Array<Record<string, unknown>>,
  stateWheres: [] as unknown[],
  columns: new Set(['start_state_roles', 'start_state_allowed'])
}))
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const wheres: Array<Record<string, unknown>> = []
    const ors: Array<Record<string, unknown>> = []
    const c: Record<string, unknown> = {}
    c.where = (w: unknown) => {
      if (typeof w === 'function') {
        const b = {
          where: (x: Record<string, unknown>) => {
            ors.push(x)
            return b
          },
          orWhere: (x: Record<string, unknown>) => {
            ors.push(x)
            return b
          }
        }
        ;(w as (b: unknown) => void)(b)
      } else wheres.push(w as Record<string, unknown>)
      return c
    }
    c.first = async (...cols: string[]) => {
      if (table === 'nivaro_workflow_bindings') {
        if (!db.binding) return undefined
        // Only the columns asked for (the reader probes the migration-531 ones).
        return Object.fromEntries(cols.map((k) => [k, db.binding?.[k]]))
      }
      db.stateWheres.push({ wheres, ors })
      const all = Object.assign({}, ...wheres) as Record<string, unknown>
      return db.states.find(
        (s) =>
          s.template === all.template &&
          (ors.length
            ? ors.some((o) => Object.entries(o).every(([k, v]) => s[k] === v))
            : Object.entries(all).every(([k, v]) => s[k] === v))
      )
    }
    return c
  }
}))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: async (_t: string, col: string) => db.columns.has(col)
}))
vi.mock('../../../services/permissions.js', () => ({
  isAdminRole: vi.fn(async (u: { role?: string }) => u.role === 'ADMIN')
}))

import {
  normalizeStartState,
  parseIdList,
  resolveStartState,
  START_STATE_KEY,
  START_STATE_SOFT_KEY,
  StartStateRefusal,
  startedRecordState,
  startStateRefusalFor,
  takeStartState,
  takeStartStateSoft
} from '../../../services/start-state.js'

const MANAGER_ROLE = '8F0C1C3A-1111-4222-8333-944455556666'
const UUID_STATE = '0b6a2f9e-1d1c-4c1e-9a55-7c1f9d3a2b10'
const person = (role = 'R-REQ') => ({ id: 'U-1', role }) as never
const req = (isAdmin: boolean, extra: Record<string, unknown> = {}) =>
  ({ isAdmin, authMethod: 'session', ...extra }) as never

beforeEach(() => {
  db.columns = new Set(['start_state_roles', 'start_state_allowed'])
  db.stateWheres = []
  db.binding = {
    template: 'T-WF',
    state_field: null,
    start_state_roles: JSON.stringify([MANAGER_ROLE.toLowerCase()]),
    start_state_allowed: null
  }
  db.states = [
    {
      id: 'S-START',
      template: 'T-WF',
      key: 'started',
      label: 'Started',
      is_initial: true,
      is_terminal: false
    },
    {
      id: UUID_STATE,
      template: 'T-WF',
      key: 'waiting_on_manager_approval',
      label: 'Waiting on Manager Approval',
      is_initial: false,
      is_terminal: false,
      color: '#0af'
    },
    { id: 'S-DONE', template: 'T-WF', key: 'complete', label: 'Complete', is_terminal: 1 }
  ]
})

describe('payload keys', () => {
  it('takes $start_state (and the soft marker) off the payload — never a column', () => {
    const p: Record<string, unknown> = {
      name: 'x',
      [START_STATE_KEY]: 'complete',
      [START_STATE_SOFT_KEY]: true
    }
    expect(takeStartState(p)).toBe('complete')
    expect(p).toEqual({ name: 'x' })
    expect(takeStartState({ name: 'y' })).toBeUndefined()
  })

  it('reads a hook’s soft marker', () => {
    const p: Record<string, unknown> = { [START_STATE_SOFT_KEY]: true }
    expect(takeStartStateSoft(p)).toBe(true)
    expect(p).toEqual({})
    expect(takeStartStateSoft({})).toBe(false)
  })

  it('normalizes key, id and {key}/{id} shapes; blank is none', () => {
    expect(normalizeStartState(' review ')).toBe('review')
    expect(normalizeStartState(7)).toBe('7')
    expect(normalizeStartState({ key: 'review' })).toBe('review')
    expect(normalizeStartState({ id: UUID_STATE })).toBe(UUID_STATE)
    expect(normalizeStartState('')).toBeNull()
    expect(normalizeStartState(null)).toBeNull()
    expect(() => normalizeStartState(true)).toThrow(StartStateRefusal)
    expect(() => normalizeStartState('x'.repeat(101))).toThrow(StartStateRefusal)
  })

  it('parses the binding lists from JSON, a comma list or an array', () => {
    expect(parseIdList('["a","b","a"]')).toEqual(['a', 'b'])
    expect(parseIdList('a, b')).toEqual(['a', 'b'])
    expect(parseIdList(['x', '', null])).toEqual(['x'])
    expect(parseIdList(null)).toEqual([])
    expect(parseIdList('{"a":1}')).toEqual([])
  })
})

describe('startStateRefusalFor', () => {
  const state = { key: 'review', label: 'Review' }
  const base = { isAdmin: false, viewAs: false, role: 'R1', roles: [], allowed: [] }
  it('lets an administrator start anywhere', () => {
    expect(startStateRefusalFor({ ...base, isAdmin: true }, 'workflows', state)).toBeNull()
  })
  it('refuses a role the binding does not list', () => {
    expect(startStateRefusalFor(base, 'workflows', state)?.code).toBe('START_STATE_FORBIDDEN')
  })
  it('lets a listed role start in any step when no steps are listed', () => {
    expect(startStateRefusalFor({ ...base, roles: ['r1'] }, 'workflows', state)).toBeNull()
  })
  it('holds a listed role to the listed steps', () => {
    const p = { ...base, roles: ['R1'], allowed: ['approved'] }
    const r = startStateRefusalFor(p, 'workflows', state)
    expect(r?.code).toBe('START_STATE_STEP_FORBIDDEN')
    expect(r?.statusCode).toBe(403)
    expect(startStateRefusalFor({ ...p, allowed: ['review'] }, 'workflows', state)).toBeNull()
  })
  it('never under View-as for a non-administrator, even with the role', () => {
    const r = startStateRefusalFor({ ...base, roles: ['R1'], viewAs: true }, 'workflows', state)
    expect(r?.code).toBe('START_STATE_VIEW_AS')
    expect(startStateRefusalFor({ ...base, isAdmin: true, viewAs: true }, 'w', state)).toBeNull()
  })
})

describe('resolveStartState', () => {
  it('resolves the key on the bound template for an allowed role', async () => {
    const t = await resolveStartState({
      user: person(MANAGER_ROLE),
      req: req(false),
      collection: 'workflows',
      value: 'waiting_on_manager_approval'
    })
    expect(t.template).toBe('T-WF')
    expect(t.state).toMatchObject({
      id: UUID_STATE,
      key: 'waiting_on_manager_approval',
      label: 'Waiting on Manager Approval',
      is_initial: false,
      is_terminal: false
    })
  })

  it('accepts the state id too (uuid only — the id column is a uniqueidentifier)', async () => {
    const t = await resolveStartState({
      user: person(),
      req: req(true),
      collection: 'workflows',
      value: UUID_STATE
    })
    expect(t.state.key).toBe('waiting_on_manager_approval')
    // A non-uuid value never reaches the id column.
    await resolveStartState({
      user: person(),
      req: req(true),
      collection: 'workflows',
      value: 'complete'
    })
    const last = db.stateWheres.at(-1) as { ors: unknown[] }
    expect(last.ors).toEqual([])
  })

  it('refuses an unbound collection with 422', async () => {
    db.binding = null
    const err = await resolveStartState({
      user: person(),
      req: req(true),
      collection: 'notes',
      value: 'x'
    }).catch((e) => e)
    expect(err).toBeInstanceOf(StartStateRefusal)
    expect(err.statusCode).toBe(422)
    expect(err.code).toBe('START_STATE_NOT_BOUND')
  })

  it('refuses a step that is not in the bound template with 422', async () => {
    const err = await resolveStartState({
      user: person(),
      req: req(true),
      collection: 'workflows',
      value: 'nope'
    }).catch((e) => e)
    expect(err.statusCode).toBe(422)
    expect(err.code).toBe('START_STATE_UNKNOWN')
    expect(err.message).toContain('"nope"')
  })

  it('refuses a non-admin whose role is not allowed with 403', async () => {
    const err = await resolveStartState({
      user: person('R-OTHER'),
      req: req(false),
      collection: 'workflows',
      value: 'complete'
    }).catch((e) => e)
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('START_STATE_FORBIDDEN')
  })

  it('refuses View-as for a non-admin even when the role is allowed', async () => {
    const err = await resolveStartState({
      user: person(MANAGER_ROLE),
      req: req(false, { authMethod: 'masquerade', masqueradeAdminId: 'U-ADMIN' }),
      collection: 'workflows',
      value: 'complete'
    }).catch((e) => e)
    expect(err.code).toBe('START_STATE_VIEW_AS')
  })

  it('an unmigrated database answers "administrators only"', async () => {
    db.columns = new Set()
    const err = await resolveStartState({
      user: person(MANAGER_ROLE),
      req: req(false),
      collection: 'workflows',
      value: 'complete'
    }).catch((e) => e)
    expect(err.code).toBe('START_STATE_FORBIDDEN')
  })

  it('judges admin from the role when there is no request', async () => {
    const t = await resolveStartState({
      user: person('ADMIN'),
      collection: 'workflows',
      value: 'complete'
    })
    expect(t.state.is_terminal).toBe(true)
  })
})

describe('startedRecordState', () => {
  it('is the $state of the started record, null until the instance exists', () => {
    const run = {
      template: 'T',
      stateField: null,
      state: {
        id: 'S',
        key: 'k',
        label: 'K',
        external_label: null,
        color: null,
        is_initial: false,
        is_terminal: false
      }
    }
    expect(startedRecordState(run)).toBeNull()
    const at = new Date('2026-11-16T15:00:00Z')
    expect(startedRecordState({ ...run, instanceId: 'I', startedAt: at })).toEqual({
      key: 'k',
      label: 'K',
      external_label: null,
      color: null,
      is_terminal: false,
      entered_at: at.toISOString(),
      instance_id: 'I'
    })
  })
})
