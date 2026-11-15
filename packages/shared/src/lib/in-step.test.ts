import { describe, expect, it } from 'vitest'
import {
  enteredAtFromHistory,
  forStepText,
  inStepSpan,
  inStepText,
  queueServerSort
} from './in-step'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

describe('in-step text', () => {
  it('reads days and hours, hours and minutes', () => {
    expect(inStepText('Finance', ago(3 * 1440 + 4 * 60 + 10), NOW)).toBe('Finance · 3 d 4 h')
    expect(inStepText('Review', ago(90), NOW)).toBe('Review · 1 h 30 m')
    expect(inStepText(null, ago(5), NOW)).toBe('5 m')
    expect(forStepText(ago(0.5), NOW)).toBe('for under a minute')
  })

  it('says nothing without an entry time and never reads negative', () => {
    expect(inStepText('Finance', null, NOW)).toBeNull()
    expect(forStepText('not a date', NOW)).toBeNull()
    expect(inStepSpan(new Date(NOW + 120_000).toISOString(), NOW)).toBe('under a minute')
  })

  it('moves on with the clock (the shared beat)', () => {
    const entered = ago(59)
    expect(forStepText(entered, NOW)).toBe('for 59 m')
    expect(forStepText(entered, NOW + 60_000)).toBe('for 1 h')
  })
})

describe('enteredAtFromHistory', () => {
  const history = [
    { to_state: 'S2', timestamp: ago(10) },
    { to_state: 's1', timestamp: ago(500) },
    { to_state: 'S1', timestamp: ago(50) }
  ]
  it('takes the newest row into the current step (any id case)', () => {
    expect(enteredAtFromHistory('S1', history)).toBe(ago(50))
  })
  it('falls back to the instance start, else nothing', () => {
    expect(enteredAtFromHistory('S9', history, ago(900))).toBe(ago(900))
    expect(enteredAtFromHistory('S9', history)).toBeNull()
    expect(enteredAtFromHistory(null, history, ago(900))).toBeNull()
  })
})

describe('queueServerSort', () => {
  it('sorts In step as Aging and Last State Change the other way round', () => {
    expect(queueServerSort('in_step')).toBe('aging_hours')
    expect(queueServerSort('-in_step')).toBe('-aging_hours')
    expect(queueServerSort('state_entered')).toBe('-aging_hours')
    expect(queueServerSort('-state_entered')).toBe('aging_hours')
    expect(queueServerSort('-priority')).toBe('-priority')
  })
})
