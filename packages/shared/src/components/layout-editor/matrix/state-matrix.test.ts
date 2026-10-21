import { describe, expect, it } from 'vitest'
import { newPlacement, type PlacementRow } from '../../../lib/layout-ops'
import {
  cellChange,
  everyStateOps,
  everyStateValue,
  type MatrixState,
  type MatrixTransition,
  requirementChanges,
  stateCell,
  withStateLock
} from './state-matrix'

const draft: MatrixState = { id: 's1', key: 'draft', label: 'Draft' }
const review: MatrixState = { id: 's2', key: 'review', label: 'Review' }
const done: MatrixState = { id: 's3', key: 'done', label: 'Done' }

const row = (patch: Partial<PlacementRow> = {}): PlacementRow => ({
  ...newPlacement('total', 'main'),
  ...patch
})

const moves: MatrixTransition[] = [
  { id: 't1', label: 'Submit', from_state: 's1', requirements: null },
  { id: 't2', label: 'Approve', from_state: 's2', requirements: null },
  { id: 't3', label: 'Send back', from_state: 's2', requirements: null }
]

describe('every state', () => {
  it('reads the strongest flag', () => {
    expect(everyStateValue(row())).toBe('normal')
    expect(everyStateValue(row({ overrides: { required: true, readonly: true } }))).toBe('readonly')
    expect(everyStateValue(row({ overrides: '{"hidden":true}' }))).toBe('hidden')
  })

  it('sets one flag and clears the others, keeping other overrides', () => {
    const r = row({ overrides: { label: 'Sum', readonly: true } })
    const [op] = everyStateOps(r, 'required')
    expect(op).toEqual({
      op: 'update_placement',
      at: { field: 'total', group_key: 'main' },
      patch: { overrides: { label: 'Sum', required: true } }
    })
    expect(everyStateOps(row(), 'normal')).toEqual([])
    const [clear] = everyStateOps(row({ overrides: { hidden: true } }), 'normal')
    expect(clear).toMatchObject({ patch: { overrides: null } })
  })
})

describe('locks', () => {
  it('adds the state to the pipeline condition or creates one', () => {
    expect(withStateLock(row(), 'p1', 'draft', true)).toEqual([
      { type: 'pipeline_state', pipeline_id: 'p1', state_keys: ['draft'] }
    ])
    const r = row({
      lock_conditions: JSON.stringify([
        { type: 'role', role_ids: ['R'] },
        { type: 'pipeline_state', pipeline_id: 'p1', state_keys: ['review'] }
      ])
    })
    expect(withStateLock(r, 'p1', 'draft', true)[1]).toEqual({
      type: 'pipeline_state',
      pipeline_id: 'p1',
      state_keys: ['review', 'draft']
    })
  })

  it('unlocking drops a condition it empties and keeps the rest', () => {
    const r = row({
      lock_conditions: JSON.stringify([
        { type: 'role', role_ids: ['R'] },
        { type: 'pipeline_state', state_keys: ['draft'] }
      ])
    })
    expect(withStateLock(r, 'p1', 'draft', false)).toEqual([{ type: 'role', role_ids: ['R'] }])
  })
})

describe('stateCell', () => {
  it('normal, locked, required to leave, required by an any-state move', () => {
    expect(stateCell(row(), draft, moves).value).toBe('normal')
    const locked = row({
      lock_conditions: JSON.stringify([{ type: 'pipeline_state', state_keys: ['draft'] }])
    })
    expect(stateCell(locked, draft, moves).value).toBe('readonly')
    expect(stateCell(locked, review, moves).value).toBe('normal')

    const asked: MatrixTransition[] = [
      {
        ...moves[0],
        requirements: [{ type: 'record_fields', fields: ['total'] }]
      } as MatrixTransition,
      ...moves.slice(1)
    ]
    const cell = stateCell(row(), draft, asked)
    expect(cell.value).toBe('required')
    expect(cell.because).toContain('"Submit"')

    const anyMove: MatrixTransition[] = [
      ...moves,
      {
        id: 't9',
        label: 'Cancel',
        from_state: null,
        requirements: [{ type: 'record_fields', fields: ['total'] }]
      }
    ]
    const any = stateCell(row(), review, anyMove)
    expect(any.value).toBe('required')
    expect(any.options.normal.ok).toBe(false)
  })

  it('optional requirement entries do not make a field required', () => {
    const t: MatrixTransition[] = [
      {
        id: 't1',
        label: 'Submit',
        from_state: 's1',
        requirements: [{ type: 'record_fields', fields: ['total'], optional: true }]
      }
    ]
    expect(stateCell(row(), draft, t).value).toBe('normal')
  })

  it('hidden is never offered per state; every-state values lock the state cells', () => {
    expect(stateCell(row(), draft, moves).options.hidden.ok).toBe(false)
    const hidden = stateCell(row({ overrides: { hidden: true } }), draft, moves)
    expect(hidden.value).toBe('hidden')
    expect(hidden.options.normal.ok).toBe(false)
    expect(hidden.options.readonly.ok).toBe(false)
  })

  it('required needs a move out of the state', () => {
    const cell = stateCell(row(), done, moves)
    expect(cell.options.required).toEqual({
      ok: false,
      why: 'No move leaves Done, so nothing can ask for it here'
    })
  })

  it('flags read-only + required as a conflict', () => {
    const r = row({
      overrides: { required: true },
      lock_conditions: JSON.stringify([{ type: 'pipeline_state', state_keys: ['draft'] }])
    })
    const cell = stateCell(r, draft, moves)
    expect(cell.value).toBe('readonly')
    expect(cell.conflict).toMatch(/nobody can fill it in/)
  })
})

describe('requirementChanges', () => {
  it('joins a plain record_fields entry or adds one, on every move out', () => {
    const t: MatrixTransition[] = [
      {
        id: 't2',
        label: 'Approve',
        from_state: 's2',
        requirements: [
          { type: 'child_fields', collection: 'lines', fk_field: 'po', fields: ['qty'] },
          { type: 'record_fields', fields: ['vendor'] }
        ]
      },
      { id: 't3', label: 'Send back', from_state: 's2', requirements: null }
    ]
    const changes = requirementChanges(t, review, 'total', true)
    expect(changes).toHaveLength(2)
    expect(changes[0].after?.[1]).toEqual({ type: 'record_fields', fields: ['vendor', 'total'] })
    expect(changes[1].after).toEqual([{ type: 'record_fields', fields: ['total'] }])
  })

  it('removing drops emptied entries and the field’s labels', () => {
    const t: MatrixTransition[] = [
      {
        id: 't1',
        label: 'Submit',
        from_state: 's1',
        requirements: [
          { type: 'record_fields', fields: ['total'] },
          {
            type: 'record_fields',
            fields: ['vendor', 'total'],
            labels: { total: 'Sum', vendor: 'V' }
          }
        ]
      }
    ]
    const [c] = requirementChanges(t, draft, 'total', false)
    expect(c.after).toEqual([
      { type: 'record_fields', fields: ['vendor'], labels: { vendor: 'V' } }
    ])
    expect(c.before).toBe(t[0].requirements)
  })
})

describe('cellChange', () => {
  it('read-only locks and stops the moves asking', () => {
    const t: MatrixTransition[] = [
      {
        id: 't1',
        label: 'Submit',
        from_state: 's1',
        requirements: [{ type: 'record_fields', fields: ['total'] }]
      }
    ]
    const change = cellChange(row(), draft, 'p1', t, 'readonly')
    expect(change?.ops[0]).toMatchObject({
      op: 'update_placement',
      patch: {
        lock_conditions: JSON.stringify([
          { type: 'pipeline_state', pipeline_id: 'p1', state_keys: ['draft'] }
        ])
      }
    })
    expect(change?.requirements[0]?.after).toBeNull()
  })

  it('refuses blocked choices and no-ops', () => {
    expect(cellChange(row(), draft, 'p1', moves, 'hidden')).toBeNull()
    expect(cellChange(row(), draft, 'p1', moves, 'normal')).toBeNull()
  })

  it('required on a field required everywhere only unlocks', () => {
    const r = row({
      overrides: { required: true },
      lock_conditions: JSON.stringify([{ type: 'pipeline_state', state_keys: ['draft'] }])
    })
    const change = cellChange(r, draft, 'p1', moves, 'required')
    expect(change?.requirements).toEqual([])
    expect(change?.ops[0]).toMatchObject({ patch: { lock_conditions: null } })
  })
})
