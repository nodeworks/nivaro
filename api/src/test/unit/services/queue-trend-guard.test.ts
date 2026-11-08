import { describe, expect, it } from 'vitest'
import {
  accessSignature,
  publicByState,
  queueDefinitionHash,
  SNAPSHOT_DEF_KEY,
  snapshotMatchesDefinition,
  stateAdmitted
} from '../../../services/queue-trend-guard.js'

const src = (over: Record<string, unknown> = {}) => ({
  type: 'collection' as never,
  collection: 'inventory_request',
  filters: null,
  state_values: JSON.stringify([
    'started',
    'completed',
    'canceled',
    'warehouse_submission',
    'order_submission'
  ]),
  state_mode: 'exclude' as const,
  sla_filter: null,
  ...over
})

describe('queue trend guard (army 11 Q1-1 / Q2-7)', () => {
  it('a state the queue no longer admits breaks an old (fingerprint-less) snapshot', () => {
    const today = [src()]
    // IR worklist: yesterday's snapshot still counted 694 Order Submission rows.
    const old = { order_submission: 694, engineering_review: 213, finance_review: 1 }
    expect(snapshotMatchesDefinition(old, today, queueDefinitionHash(today))).toBe(false)
    const fine = { engineering_review: 213, finance_review: 1, none: 0 }
    expect(snapshotMatchesDefinition(fine, today, queueDefinitionHash(today))).toBe(true)
    // A state with a zero count does not break it.
    expect(
      snapshotMatchesDefinition(
        { order_submission: 0, finance_review: 1 },
        today,
        queueDefinitionHash(today)
      )
    ).toBe(true)
  })

  it('a fingerprinted snapshot must match the current definition exactly', () => {
    const before = [src({ state_values: JSON.stringify(['started']) })]
    const after = [src()]
    const snap = { finance_review: 1, [SNAPSHOT_DEF_KEY]: queueDefinitionHash(before) }
    expect(snapshotMatchesDefinition(snap, after, queueDefinitionHash(after))).toBe(false)
    expect(snapshotMatchesDefinition(snap, before, queueDefinitionHash(before))).toBe(true)
  })

  it('the fingerprint ignores source order and state-list order', () => {
    const a = [src({ collection: 'a' }), src({ collection: 'b', state_values: '["x","y"]' })]
    const b = [src({ collection: 'b', state_values: '["y","x"]' }), src({ collection: 'a' })]
    expect(queueDefinitionHash(a)).toBe(queueDefinitionHash(b))
    expect(queueDefinitionHash(a)).not.toBe(queueDefinitionHash([src({ collection: 'a' })]))
  })

  it('include / exclude / no list', () => {
    expect(stateAdmitted([src({ state_mode: 'include', state_values: '["l1"]' })], 'l1')).toBe(true)
    expect(stateAdmitted([src({ state_mode: 'include', state_values: '["l1"]' })], 'l2')).toBe(
      false
    )
    expect(stateAdmitted([src({ state_values: null })], 'anything')).toBe(true)
    expect(stateAdmitted([src()], 'order_submission')).toBe(false)
    // Any source that admits it is enough.
    expect(stateAdmitted([src(), src({ state_values: null })], 'order_submission')).toBe(true)
  })

  it('the fingerprint never reaches a client', () => {
    expect(publicByState({ a: 2, [SNAPSHOT_DEF_KEY]: 'abc' })).toEqual({ a: 2 })
  })

  it('access signatures compare by value, not order', () => {
    const cj = accessSignature([{ dimension: 'division', values: [1, 2, 3] }])
    expect(accessSignature([{ dimension: 'division', values: ['3', '2', '1'] }])).toBe(cj)
    expect(accessSignature([])).toBe('[]')
    expect(cj).not.toBe('[]')
  })
})
