import { describe, expect, it } from 'vitest'
import { isOutsideWorkingHours, offHoursNote } from './chat-local-time'

// 2026-10-21 is a Wednesday.
const wedNoonUtc = new Date('2026-10-21T12:00:00Z')
const wedLateUtc = new Date('2026-10-21T23:40:00Z')
const sat = new Date('2026-10-24T15:00:00Z')

describe('isOutsideWorkingHours', () => {
  it('is null without a zone', () => {
    expect(isOutsideWorkingHours({ timezone: null }, wedNoonUtc)).toBeNull()
  })
  it('is inside on a weekday afternoon', () => {
    expect(isOutsideWorkingHours({ timezone: 'UTC' }, wedNoonUtc)).toBe(false)
  })
  it('is outside late at night', () => {
    expect(isOutsideWorkingHours({ timezone: 'UTC' }, wedLateUtc)).toBe(true)
  })
  it('treats weekends as outside', () => {
    expect(isOutsideWorkingHours({ timezone: 'UTC' }, sat)).toBe(true)
  })
  it('honours custom hours', () => {
    expect(
      isOutsideWorkingHours(
        { timezone: 'UTC', working_hours: { start: '13:00', end: '21:00' } },
        wedNoonUtc
      )
    ).toBe(true)
  })
  it('reads the peer zone, not the sender zone', () => {
    // 12:00 UTC is 21:00 in Tokyo.
    expect(isOutsideWorkingHours({ timezone: 'Asia/Tokyo' }, wedNoonUtc)).toBe(true)
  })
})

describe('offHoursNote', () => {
  it('names the peer and their time', () => {
    expect(offHoursNote({ timezone: 'UTC' }, 'Ana Lopez', wedLateUtc)).toBe(
      'It is 11:40 PM for Ana, outside their working hours. They will see this when they are back.'
    )
  })
  it('stays quiet inside working hours or with no zone', () => {
    expect(offHoursNote({ timezone: 'UTC' }, 'Ana', wedNoonUtc)).toBeNull()
    expect(offHoursNote({ timezone: null }, 'Ana', wedLateUtc)).toBeNull()
    expect(offHoursNote(null, 'Ana', wedLateUtc)).toBeNull()
  })
})
