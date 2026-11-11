import { beforeEach, describe, expect, it, vi } from 'vitest'

// Admin "Move to state": one record, a reason, no transition actions; a
// terminal target completes the instance, any other reopens it; auto rules
// re-run afterwards.

const store = {
  instance: null as null | Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  history: [] as Array<Record<string, unknown>>
}
const STATES = [
  { id: 'S-PO', key: 'waiting_on_po', label: 'Waiting on PO', is_terminal: false },
  { id: 'S-DONE', key: 'completed', label: 'Completed', is_terminal: true },
  {
    id: 'S-FUS',
    key: 'waiting_on_oracle_submission',
    label: 'Waiting on Fusion Submission',
    is_terminal: 0
  }
]

function table(name: string) {
  const q: Record<string, any> = {}
  q.where = () => q
  q.first = async () => (name === 'nivaro_workflow_instances' ? store.instance : undefined)
  q.select = async () => (name === 'nivaro_workflow_states' ? STATES : [])
  q.update = async (patch: Record<string, unknown>) => {
    store.updates.push(patch)
    if (store.instance) Object.assign(store.instance, patch)
    return 1
  }
  q.insert = (row: Record<string, unknown>) => {
    store.history.push(row)
    return { returning: async () => [{ id: 77 }] }
  }
  return q
}

vi.mock('../../../db/index.js', () => ({
  db: Object.assign(vi.fn(table), {
    transaction: async (fn: (trx: unknown) => Promise<void>) => fn(table),
    raw: () => ''
  })
}))
vi.mock('../../../services/chain-columns.js', () => ({ chainFields: async () => ({}) }))
vi.mock('../../../services/note-authorship.js', () => ({
  originFields: async () => ({ origin: 'person' })
}))
const runAuto = vi.fn(async () => {})
const syncState = vi.fn(async () => {})
vi.mock('../../../services/workflow-transitions.js', () => ({
  runAutoTransitions: runAuto,
  syncStateField: syncState
}))
vi.mock('../../../services/queue-materialization.js', () => ({
  syncMaterializedQueueItem: async () => {}
}))
vi.mock('../../../services/record-events.js', () => ({
  announceRecordAspect: () => {},
  announceAddendumChange: async () => {}
}))

import {
  MoveStateError,
  moveRecordToState,
  validateMoveReason
} from '../../../services/pipeline-move-state.js'

const base = {
  collection: 'nivaro_addendums',
  item: 'A1',
  reason: 'Completed too early',
  userId: 'admin-1'
}

beforeEach(() => {
  store.instance = { id: 'I1', template: 'T1', current_state: 'S-DONE', completed_at: new Date() }
  store.updates = []
  store.history = []
  runAuto.mockClear()
  runAuto.mockImplementation(async () => {})
})

describe('moveRecordToState', () => {
  it('reopens a completed record in the chosen state and records who and why', async () => {
    const r = await moveRecordToState({ ...base, toState: 'waiting_on_po' })
    expect(store.updates[0]).toEqual({ current_state: 'S-PO', completed_at: null })
    expect(store.history[0]).toMatchObject({
      instance: 'I1',
      from_state: 'S-DONE',
      to_state: 'S-PO',
      transition: null,
      user: 'admin-1',
      comment: 'Moved by an administrator: Completed too early',
      origin: 'person'
    })
    expect(r).toMatchObject({
      from: { key: 'completed' },
      to: { key: 'waiting_on_po' },
      ended: null,
      history_id: 77
    })
    expect(syncState).toHaveBeenCalledWith(
      'nivaro_addendums',
      'A1',
      expect.objectContaining({ key: 'waiting_on_po' })
    )
    expect(runAuto).toHaveBeenCalledWith('nivaro_addendums', 'A1')
  })

  it('completes the instance when the target is terminal, and runs no auto rules', async () => {
    store.instance!.current_state = 'S-PO'
    store.instance!.completed_at = null
    await moveRecordToState({ ...base, toState: 'S-DONE' })
    expect(store.updates[0].current_state).toBe('S-DONE')
    expect(store.updates[0].completed_at).toBeInstanceOf(Date)
    expect(runAuto).not.toHaveBeenCalled()
  })

  it('says where an auto rule took it next', async () => {
    runAuto.mockImplementation(async () => {
      store.instance!.current_state = 'S-DONE'
    })
    const r = await moveRecordToState({ ...base, toState: 'S-PO' })
    expect(r.ended).toEqual({ id: 'S-DONE', key: 'completed', label: 'Completed' })
  })

  it('refuses a state outside the pipeline, the current state, a missing pipeline and no reason', async () => {
    await expect(moveRecordToState({ ...base, toState: 'nope' })).rejects.toMatchObject({
      status: 400
    })
    await expect(moveRecordToState({ ...base, toState: 'completed' })).rejects.toThrow(
      /already in Completed/
    )
    store.instance = null
    await expect(moveRecordToState({ ...base, toState: 'S-PO' })).rejects.toMatchObject({
      status: 404
    })
    expect(() => validateMoveReason('  ok ')).toThrow(MoveStateError)
    expect(store.history).toHaveLength(0)
  })
})
