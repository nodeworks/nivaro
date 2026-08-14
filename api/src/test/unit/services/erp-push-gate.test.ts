import { describe, expect, it } from 'vitest'
import { changeSignature, shouldPush } from '../../../services/erp-push-gate.js'

const RECORD = { efp_state: 'approved', requisition_id: 'REQ-1', po_number: null, nested: { a: 1 } }

describe('changeSignature', () => {
  it('is null when nothing is watched — the caller treats that as "cannot compare"', () => {
    expect(changeSignature(RECORD, undefined)).toBeNull()
    expect(changeSignature(RECORD, [])).toBeNull()
  })

  it('is stable regardless of field order', () => {
    expect(changeSignature(RECORD, ['efp_state', 'requisition_id'])).toBe(
      changeSignature(RECORD, ['requisition_id', 'efp_state'])
    )
  })

  it('changes when a watched value changes, and not when an unwatched one does', () => {
    const base = changeSignature(RECORD, ['efp_state'])
    expect(changeSignature({ ...RECORD, efp_state: 'rejected' }, ['efp_state'])).not.toBe(base)
    expect(changeSignature({ ...RECORD, requisition_id: 'REQ-2' }, ['efp_state'])).toBe(base)
  })

  it('treats null and undefined as the same absence', () => {
    expect(changeSignature({ po_number: null }, ['po_number'])).toBe(
      changeSignature({}, ['po_number'])
    )
  })

  it('reads dotted paths', () => {
    expect(changeSignature(RECORD, ['nested.a'])).not.toBe(changeSignature({ nested: { a: 2 } }, ['nested.a']))
  })
})

describe('shouldPush', () => {
  const sig = 'aaa'
  it('pushes on every transition when unconfigured (historical behaviour)', () => {
    expect(shouldPush({ pushWhen: undefined, stateChanged: true, signature: null, lastSignature: null })).toBe(true)
  })

  it('state_change alone pushes on the state change', () => {
    expect(
      shouldPush({ pushWhen: { state_change: true }, stateChanged: true, signature: null, lastSignature: null })
    ).toBe(true)
  })

  it('fields-only suppresses a transition that changed nothing watched', () => {
    expect(
      shouldPush({
        pushWhen: { state_change: false, fields: ['po_number'] },
        stateChanged: true,
        signature: sig,
        lastSignature: sig
      })
    ).toBe(false)
  })

  it('fields-only pushes when a watched value differs from the last push', () => {
    expect(
      shouldPush({
        pushWhen: { state_change: false, fields: ['po_number'] },
        stateChanged: true,
        signature: 'bbb',
        lastSignature: sig
      })
    ).toBe(true)
  })

  it('pushes when there is nothing to compare against — a first push is never suppressed', () => {
    expect(
      shouldPush({
        pushWhen: { state_change: false, fields: ['po_number'] },
        stateChanged: true,
        signature: sig,
        lastSignature: null
      })
    ).toBe(true)
  })

  it('both configured: the state change fires even when the fields match', () => {
    expect(
      shouldPush({
        pushWhen: { state_change: true, fields: ['po_number'] },
        stateChanged: true,
        signature: sig,
        lastSignature: sig
      })
    ).toBe(true)
  })
})
