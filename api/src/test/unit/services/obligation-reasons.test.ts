import { describe, expect, it } from 'vitest'
import { outcomeForSubmission } from '../../../services/erp-submission-status.js'
import { skipReason } from '../../../services/integration-obligations.js'

describe('skipReason', () => {
  it('names the guard rule that refused', () => {
    expect(skipReason('guard', 'is_on_hold = true')).toBe('guard unmet: is_on_hold = true')
  })

  it('names the empty context gate', () => {
    expect(skipReason('skip_when_empty', 'partner_link')).toBe(
      'skip_when_empty: partner_link empty'
    )
  })

  it('names every reference that was checked and unset', () => {
    expect(skipReason('skip_unless_any', 'context.partner_link.0.ref, record.partner_ref')).toBe(
      'skip_unless_any: none of context.partner_link.0.ref, record.partner_ref is set'
    )
  })

  it('says why push_when refused', () => {
    expect(skipReason('push_when', 'payload unchanged since submission 1234')).toBe(
      'push_when: payload unchanged since submission 1234'
    )
  })

  it('names the missing configuration', () => {
    expect(skipReason('not_configured', 'endpoint_path')).toBe(
      'not configured: endpoint_path missing on the action'
    )
  })

  it('reports a flow halt with the op that stopped it', () => {
    expect(skipReason('flow_condition', 'Check PO linked')).toBe(
      'flow condition rejected at "Check PO linked"'
    )
  })

  it('falls back to the raw detail for an unknown kind', () => {
    expect(skipReason('something_else' as never, 'because')).toBe('something_else: because')
  })

  it('never returns an unbounded string', () => {
    expect(skipReason('guard', 'x'.repeat(900)).length).toBeLessThanOrEqual(500)
  })
})

describe('outcomeForSubmission', () => {
  it('closes the obligation only on an explicit acceptance', () => {
    expect(outcomeForSubmission('accepted')).toBe('sent')
  })

  it('reopens it as failed on a rejection or a failure', () => {
    expect(outcomeForSubmission('rejected')).toBe('failed')
    expect(outcomeForSubmission('failed')).toBe('failed')
  })

  it('leaves a 2xx awaiting acknowledgement as pending, never sent', () => {
    expect(outcomeForSubmission('pending')).toBe('pending')
    expect(outcomeForSubmission('submitted')).toBe('pending')
  })
})
