import { describe, expect, it, vi } from 'vitest'

// Army 9 b06 INFO: the instance read still offered Send Back to Levels 3/4
// that a $5,000 request had skipped by threshold (the panel hid them).

const skip = vi.hoisted(() => ({
  evaluateSkipCriteriaDetailed: vi.fn(),
  fetchPipelineRecord: vi.fn(async () => ({ requisition_amount: 5000 }))
}))
vi.mock('../../../db/index.js', () => ({ db: {} }))
vi.mock('../../../services/workflow-transitions.js', () => ({
  evaluateSkipCriteriaDetailed: skip.evaluateSkipCriteriaDetailed
}))
vi.mock('../../../services/pipeline-subject.js', () => ({
  fetchPipelineRecord: skip.fetchPipelineRecord
}))

import {
  canSkip,
  isSendBackMove,
  skippedSendBackTargets,
  withoutSkippedSendBacks
} from '../../../services/send-back-skips.js'

const states = [
  { id: 'START', sort: 1, is_initial: true },
  { id: 'L1', sort: 2 },
  { id: 'L2', sort: 3 },
  { id: 'L3', sort: 4 },
  { id: 'L4', sort: 5 },
  { id: 'L5', sort: 6 },
  { id: 'DONE', sort: 9, is_terminal: 1 }
]
const moves = [
  { id: 'b-start', to_state: 'START' },
  { id: 'b-l2', to_state: 'L2' },
  { id: 'b-l3', to_state: 'L3' },
  { id: 'b-l4', to_state: 'l4' },
  { id: 'fwd', to_state: 'DONE' },
  { id: 'uncancel', to_state: 'L3', to_previous: true }
]

describe('send-back-skips (pure)', () => {
  it('a send back sorts before the current step; to_previous never counts', () => {
    expect(isSendBackMove({ to_state: 'L3' }, states, 'L5')).toBe(true)
    expect(isSendBackMove({ to_state: 'DONE' }, states, 'L5')).toBe(false)
    expect(isSendBackMove({ to_state: 'L5' }, states, 'L5')).toBe(false)
    expect(isSendBackMove({ to_state: 'L3', to_previous: true }, states, 'L5')).toBe(false)
    expect(isSendBackMove({ to_state: 'L3' }, states, null)).toBe(false)
  })
  it('initial and terminal steps never skip', () => {
    expect(canSkip(states[0])).toBe(false)
    expect(canSkip(states[6])).toBe(false)
    expect(canSkip(states[3])).toBe(true)
    expect(canSkip(undefined)).toBe(false)
  })
  it('drops send backs to skipped steps only (ids compared case-blind)', () => {
    const out = withoutSkippedSendBacks(
      moves,
      states,
      'L5',
      new Map([
        ['L3', ['below 20,000']],
        ['L4', ['below 50,000']]
      ])
    )
    expect(out.map((m) => m.id)).toEqual(['b-start', 'b-l2', 'fwd', 'uncancel'])
    expect(withoutSkippedSendBacks(moves, states, 'L5', null)).toBe(moves)
  })
})

describe('skippedSendBackTargets', () => {
  it('judges each send-back target once, never initial/forward/to_previous ones', async () => {
    skip.evaluateSkipCriteriaDetailed.mockReset()
    skip.evaluateSkipCriteriaDetailed.mockImplementation(async (id: string) =>
      id === 'L3'
        ? { skipped: true, reasons: ['amount (5,000) is below 20,000'] }
        : id === 'L4'
          ? { skipped: true, reasons: ['amount (5,000) is below 50,000'] }
          : { skipped: false, reasons: [] }
    )
    const out = await skippedSendBackTargets({
      moves: [...moves, { id: 'b-l3-again', to_state: 'L3' }],
      states,
      currentStateId: 'L5',
      instanceId: 'I',
      collection: 'workflows',
      item: '1',
      database: {} as any
    })
    expect([...out.entries()]).toEqual([
      ['L3', ['amount (5,000) is below 20,000']],
      ['L4', ['amount (5,000) is below 50,000']]
    ])
    const judged = skip.evaluateSkipCriteriaDetailed.mock.calls.map((c) => c[0]).sort()
    expect(judged).toEqual(['L2', 'L3', 'L4'])
    expect(skip.fetchPipelineRecord).toHaveBeenCalledTimes(1)
  })
  it('reads nothing when no send back is on offer', async () => {
    skip.evaluateSkipCriteriaDetailed.mockReset()
    skip.fetchPipelineRecord.mockClear()
    const out = await skippedSendBackTargets({
      moves: [{ to_state: 'DONE' }],
      states,
      currentStateId: 'L5',
      instanceId: 'I',
      collection: 'workflows',
      item: '1',
      database: {} as any
    })
    expect(out.size).toBe(0)
    expect(skip.fetchPipelineRecord).not.toHaveBeenCalled()
  })
})
