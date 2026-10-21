import { describe, expect, it } from 'vitest'
import { heldSummary, holdPreferenceOn } from './huddle-hold'
import {
  buildIcs,
  defaultStart,
  formatStartsIn,
  type HuddleScheduleCardData,
  huddleRefOf,
  outlookComposeUrl,
  schedulePhase,
  stripHuddleRef
} from './huddle-schedule'

const card: HuddleScheduleCardData = {
  id: 7,
  room: 'ch:ops',
  title: 'Sprint review; Q4, part 1',
  starts_at: '2026-10-23T15:00:00.000Z',
  ends_at: '2026-10-23T15:30:00.000Z',
  duration_min: 30,
  status: 'scheduled',
  organizer: { id: 'U1', name: 'Rob Lee' },
  invitees: [{ id: 'U2', name: 'Amy' }],
  live: false,
  can_cancel: true
}

describe('marker', () => {
  it('reads and strips [huddle:<id>]', () => {
    expect(huddleRefOf('Scheduled a huddle [huddle:12]')).toBe(12)
    expect(huddleRefOf('plain text')).toBeNull()
    expect(stripHuddleRef('Scheduled a huddle [huddle:12]')).toBe('Scheduled a huddle')
  })
})

describe('schedulePhase + formatStartsIn', () => {
  const start = Date.parse(card.starts_at)
  it('walks upcoming → soon → live → ended; cancelled wins', () => {
    expect(schedulePhase(card, start - 60 * 60_000)).toBe('upcoming')
    expect(schedulePhase(card, start - 10 * 60_000)).toBe('soon')
    expect(schedulePhase(card, start)).toBe('live')
    expect(schedulePhase(card, start + 30 * 60_000)).toBe('ended')
    expect(schedulePhase({ ...card, status: 'cancelled' }, start)).toBe('cancelled')
  })
  it('says how far off the start is', () => {
    expect(formatStartsIn(card.starts_at, start - 10_000)).toBe('now')
    expect(formatStartsIn(card.starts_at, start - 12 * 60_000)).toBe('in 12 min')
    expect(formatStartsIn(card.starts_at, start - 90 * 60_000)).toBe('in 1 h 30 min')
    expect(formatStartsIn(card.starts_at, start - 2 * 86_400_000)).toBe('in 2 days')
  })
})

describe('calendar', () => {
  it('builds a valid .ics with escaped text, the alarm and the room link', () => {
    const ics = buildIcs(
      card,
      'https://app.example/chat?room=ch%3Aops',
      new Date('2026-10-22T00:00:00Z')
    )
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('DTSTART:20261023T150000Z')
    expect(ics).toContain('DTEND:20261023T153000Z')
    expect(ics).toContain('SUMMARY:Huddle: Sprint review\\; Q4\\, part 1')
    expect(ics).toContain('TRIGGER:-PT5M')
    expect(ics).toContain('URL:https://app.example/chat?room=ch%3Aops')
    expect(ics).toContain('UID:nivaro-huddle-7@ch-ops')
  })
  it('pre-fills the Outlook compose link', () => {
    const u = new URL(outlookComposeUrl(card, null))
    expect(u.origin).toBe('https://outlook.office.com')
    expect(u.searchParams.get('subject')).toBe('Huddle: Sprint review; Q4, part 1')
    expect(u.searchParams.get('startdt')).toBe('2026-10-23T15:00:00.000Z')
  })
  it('defaults the start to the next quarter hour at least 15 minutes out', () => {
    const d = defaultStart(new Date('2026-10-22T14:03:00'))
    expect(d.getMinutes() % 15).toBe(0)
    expect(d.getTime() - Date.parse('2026-10-22T14:03:00')).toBeGreaterThanOrEqual(15 * 60_000)
  })
})

describe('hold', () => {
  it('is on unless switched off; summarises what was held', () => {
    expect(holdPreferenceOn({})).toBe(true)
    expect(holdPreferenceOn({ huddle_hold_notifications: false })).toBe(false)
    expect(heldSummary([])).toBeNull()
    expect(
      heldSummary([
        { kind: 'notification', title: 'a', at: 1 },
        { kind: 'chat', title: 'b', at: 2 },
        { kind: 'chat', title: 'c', at: 3 }
      ])
    ).toBe('1 notification and 2 chat messages arrived during your huddle')
  })
})
