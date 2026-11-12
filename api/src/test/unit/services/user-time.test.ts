import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { timeInstructions, utcOffsetLabel } from '../../../services/user-time.js'

// On production (Nov 9, a week after the clocks went back) the assistant
// turned 04:56 UTC into "12:56 AM" — the summer offset — and listed a record
// from the evening before under "today". The prompt now says the offset.
describe('utcOffsetLabel', () => {
  it('is the offset in force on that day, not the zone’s other one', () => {
    expect(utcOffsetLabel('America/New_York', new Date('2026-11-09T23:27:00Z'))).toBe('UTC-05:00')
    expect(utcOffsetLabel('America/New_York', new Date('2026-07-01T12:00:00Z'))).toBe('UTC-04:00')
  })

  it('handles zones ahead of UTC, half hours and UTC itself', () => {
    const at = new Date('2026-11-09T23:27:00Z')
    expect(utcOffsetLabel('Asia/Kolkata', at)).toBe('UTC+05:30')
    expect(utcOffsetLabel('Europe/Berlin', at)).toBe('UTC+01:00')
    expect(utcOffsetLabel('UTC', at)).toBe('UTC+00:00')
  })
})

describe('timeInstructions', () => {
  it('tells the assistant the person’s time and the offset to convert with', () => {
    const text = timeInstructions('America/New_York', new Date('2026-11-09T23:27:00Z'))
    expect(text).toContain('Mon, Nov 9 at 6:27 PM EST')
    expect(text).toContain('UTC-05:00')
    expect(text).toContain('which day')
  })
})
