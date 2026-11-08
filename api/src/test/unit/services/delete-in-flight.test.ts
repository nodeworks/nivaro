import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 11 N12: a Workflow Creator deleted a workflow waiting on Level 1
// approval from the list row menu. A non-admin deletes a pipeline record only
// while it has never left its first step; admins are not bound.

const state = {
  runs: [] as Array<Record<string, unknown>>,
  moved: false
}

vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['leftJoin', 'where', 'whereIn', 'whereNotNull', 'orderBy'])
      c[m] = vi.fn(() => c)
    c.select = vi.fn(async () => (t.startsWith('nivaro_workflow_instances') ? state.runs : []))
    c.first = vi.fn(async () => (state.moved ? { id: 1 } : undefined))
    return c
  })
}))

import {
  assertDeletableByPerson,
  DeleteInFlightError,
  deleteRunState,
  inFlightDeleteMessage
} from '../../../services/delete-in-flight.js'

const run = (over: Partial<Parameters<typeof inFlightDeleteMessage>[0] & object> = {}) => ({
  atFirstStep: true,
  finished: false,
  moved: false,
  stepLabel: 'Started',
  ...over
})

describe('inFlightDeleteMessage', () => {
  it('lets a record with no run, or one never moved off its first step, go', () => {
    expect(inFlightDeleteMessage(null)).toBeNull()
    expect(inFlightDeleteMessage(run())).toBeNull()
  })
  it('refuses a submitted record and names its step', () => {
    const m = inFlightDeleteMessage(
      run({ atFirstStep: false, moved: true, stepLabel: 'Waiting on Level 1 Approval' })
    )
    expect(m).toContain('Waiting on Level 1 Approval')
    expect(m).toContain('Cancel it instead')
  })
  it('refuses a record sent back to its first step (it has been in approval)', () => {
    expect(inFlightDeleteMessage(run({ moved: true }))).toContain('through approval before')
  })
  it('refuses a finished record', () => {
    expect(
      inFlightDeleteMessage(run({ atFirstStep: false, finished: true, stepLabel: 'Canceled' }))
    ).toContain('finished (Canceled)')
  })
})

describe('deleteRunState / assertDeletableByPerson', () => {
  beforeEach(() => {
    state.runs = []
    state.moved = false
  })
  it('no run: null, and a person may delete', async () => {
    expect(await deleteRunState('workflows', 1)).toBeNull()
    await expect(assertDeletableByPerson('workflows', 1, false)).resolves.toBeUndefined()
  })
  it('a Started record never moved: deletable', async () => {
    state.runs = [{ id: 'i1', completed_at: null, is_initial: true, label: 'Started' }]
    await expect(assertDeletableByPerson('workflows', 1, false)).resolves.toBeUndefined()
  })
  it('a record in Level 1 approval: refused for a person, allowed for an admin', async () => {
    state.runs = [
      { id: 'i1', completed_at: null, is_initial: 0, label: 'Waiting on Level 1 Approval' }
    ]
    state.moved = true
    await expect(assertDeletableByPerson('workflows', 1, false)).rejects.toBeInstanceOf(
      DeleteInFlightError
    )
    await expect(assertDeletableByPerson('workflows', 1, true)).resolves.toBeUndefined()
  })
  it('reads the open run before an older finished one', async () => {
    state.runs = [
      { id: 'old', completed_at: new Date(), is_initial: 0, label: 'Canceled' },
      { id: 'new', completed_at: null, is_initial: 1, label: 'Started' }
    ]
    const s = await deleteRunState('workflows', 1)
    expect(s).toMatchObject({ atFirstStep: true, finished: false, stepLabel: 'Started' })
  })
  it('carries the 403 code the clients read', async () => {
    state.runs = [{ id: 'i1', completed_at: new Date(), is_initial: 0, label: 'Completed' }]
    const err = await assertDeletableByPerson('workflows', 1, false).catch((e) => e)
    expect(err).toMatchObject({ statusCode: 403, code: 'DELETE_IN_FLIGHT' })
  })
})
