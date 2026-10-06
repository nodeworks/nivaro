import { describe, expect, it } from 'vitest'
import {
  hoursText,
  pickOverride,
  type SlaOverrideRow,
  validateOverrideInput
} from '../../../services/sla-overrides.js'

const ENTERED = new Date('2026-10-01T12:00:00.000Z')
const INSTANCE = 'ABCDEF01-0000-0000-0000-000000000001'

function row(over: Partial<SlaOverrideRow> = {}): SlaOverrideRow {
  return {
    id: 1,
    collection: 'workflows',
    item: '42',
    state_key: 'review',
    instance_id: INSTANCE,
    entered_at: ENTERED,
    duration_hours: 48,
    rule_duration_hours: 24,
    reason: 'Waiting on vendor quote',
    set_by: null,
    set_at: new Date('2026-10-02T09:00:00.000Z'),
    cleared_at: null,
    ...over
  }
}

const episode = { instanceId: INSTANCE.toLowerCase(), stateKey: 'review', enteredAt: ENTERED }

describe('pickOverride', () => {
  it('applies to the matching episode (instance id compared case-insensitively)', () => {
    expect(pickOverride([row()], episode)?.duration_hours).toBe(48)
  })

  it('tolerates the datetime rounding of the stored entry moment', () => {
    const rounded = new Date(ENTERED.getTime() + 3)
    expect(pickOverride([row({ entered_at: rounded })], episode)).not.toBeNull()
  })

  it('does not apply after the record re-enters the state (a new episode)', () => {
    const reentered = { ...episode, enteredAt: new Date(ENTERED.getTime() + 3_600_000) }
    expect(pickOverride([row()], reentered)).toBeNull()
  })

  it('does not apply in another state or another instance', () => {
    expect(pickOverride([row()], { ...episode, stateKey: 'approve' })).toBeNull()
    expect(pickOverride([row()], { ...episode, instanceId: 'other' })).toBeNull()
    expect(pickOverride([row()], { ...episode, stateKey: null })).toBeNull()
  })

  it('ignores cleared overrides and picks the newest active one', () => {
    const older = row({ id: 1, duration_hours: 30, set_at: new Date('2026-10-02T08:00:00Z') })
    const cleared = row({ id: 2, duration_hours: 99, cleared_at: new Date() })
    const newer = row({ id: 3, duration_hours: 12, set_at: new Date('2026-10-02T10:00:00Z') })
    expect(pickOverride([older, cleared, newer], episode)?.id).toBe(3)
    expect(pickOverride([cleared], episode)).toBeNull()
    expect(pickOverride(undefined, episode)).toBeNull()
  })

  it('skips a non-positive duration', () => {
    expect(pickOverride([row({ duration_hours: 0 })], episode)).toBeNull()
  })
})

describe('validateOverrideInput', () => {
  it('requires positive hours and a reason', () => {
    expect(validateOverrideInput({ duration_hours: 0, reason: 'x' })).toHaveProperty('error')
    expect(validateOverrideInput({ duration_hours: 'abc', reason: 'x' })).toHaveProperty('error')
    expect(validateOverrideInput({ duration_hours: 10, reason: '   ' })).toHaveProperty('error')
    expect(validateOverrideInput({ duration_hours: 9000, reason: 'x' })).toHaveProperty('error')
    expect(validateOverrideInput({ duration_hours: '36.456', reason: ' late PO ' })).toEqual({
      hours: 36.46,
      reason: 'late PO'
    })
  })
})

describe('hoursText', () => {
  it('reads hours and whole days', () => {
    expect(hoursText(24)).toBe('24h')
    expect(hoursText(1.5)).toBe('1.5h')
    expect(hoursText(72)).toBe('3d')
    expect(hoursText(76)).toBe('3d 4h')
  })
})
