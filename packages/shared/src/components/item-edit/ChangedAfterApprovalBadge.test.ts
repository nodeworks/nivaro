import { describe, expect, it } from 'vitest'
import { approvalBadgeStates, normalizeSummaryModeRules } from '../../lib/summary-mode'
import { approvalValueText } from './ChangedAfterApprovalBadge'

describe('approvalBadgeStates (twin of api approvalChangesConfigOf)', () => {
  const lock = { edit_lock: { states: [], children: [], admin_only: { states: ['approved'] } } }
  it('on by default with the post-approval lock, off with false, named states without one', () => {
    expect(approvalBadgeStates(normalizeSummaryModeRules(lock))).toEqual(['approved'])
    expect(
      approvalBadgeStates(normalizeSummaryModeRules({ ...lock, changed_after_approval: false }))
    ).toBeNull()
    expect(approvalBadgeStates(normalizeSummaryModeRules({}))).toBeNull()
    expect(
      approvalBadgeStates(
        normalizeSummaryModeRules({ changed_after_approval: { states: ['done'] } })
      )
    ).toEqual(['done'])
  })
  it('a Form UX save keeps the key', () => {
    expect(
      normalizeSummaryModeRules({ changed_after_approval: false }).changed_after_approval
    ).toBe(false)
  })
})

describe('approvalValueText', () => {
  it('reads values the way people do', () => {
    expect(approvalValueText(null)).toBe('Empty')
    expect(approvalValueText(true)).toBe('Yes')
    expect(approvalValueText(1500.5)).toBe('1,500.5')
    expect(approvalValueText('2026-11-15', null, 'date')).toBe('Nov 15, 2026')
    expect(approvalValueText(4, 'Acme Supply')).toBe('Acme Supply')
    expect(approvalValueText('x'.repeat(100)).length).toBe(78)
  })
})
