import { describe, expect, it } from 'vitest'
import { reachWarning } from '../../../services/delegate-visibility.js'
import { actNowSummary } from '../../../services/who-can-act.js'

// Why? / "who can act now" named the record's creator (listed only by the
// binding's fallback field) as someone who can act on Engineering Review,
// while the owner-only gate correctly refused them (army 2026-10-25).

const person = (name: string, over: Record<string, unknown> = {}) => ({
  id: name,
  name,
  available: true,
  unavailable_reason: null,
  online: null,
  stands_in_for: [],
  ...over
})

describe('actNowSummary', () => {
  it('never lists a fallback-only person among those who can act', () => {
    const s = actNowSummary('Engineering Review', [
      person('Brian Celestine'),
      person('William Lavallee'),
      person('David Jarosz', { queue_only: true })
    ])
    expect(s).toContain('Brian Celestine and William Lavallee can act on Engineering Review now.')
    expect(s).toContain('David Jarosz has it in their queue but cannot approve it.')
  })

  it('says nobody can approve when only the fallback person is listed', () => {
    const s = actNowSummary('Engineering Review', [person('David Jarosz', { queue_only: true })])
    expect(s).toMatch(/^Nobody can approve Engineering Review/)
  })

  it('keeps the plain answer when everyone is an assigned owner', () => {
    expect(actNowSummary('Level 1', [person('Lindsey')])).toBe('Lindsey can act on Level 1 now.')
  })
})

describe('reachWarning (out-of-office delegate)', () => {
  it('warns when the delegate cannot open any inherited approval', () => {
    expect(reachWarning({ owned: 12, hidden: 12 }, 'Howard Hebert')).toMatch(
      /Howard Hebert cannot open any of the 12 records/
    )
  })
  it('names the share a delegate cannot open', () => {
    expect(reachWarning({ owned: 12, hidden: 5 }, 'Howard')).toMatch(/cannot open 5 of the 12/)
  })
  it('is silent when the delegate can open everything', () => {
    expect(reachWarning({ owned: 12, hidden: 0 }, 'Lindsey')).toBeNull()
  })
})
