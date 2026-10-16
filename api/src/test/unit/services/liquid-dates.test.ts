import { Liquid } from 'liquidjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let setting: string | null = null
vi.mock('../../../db/index.js', () => ({
  db: () => ({ first: async () => ({ default_timezone: setting }) })
}))

// Fresh module per case: the zone is cached for 60s.
async function render(tpl: string, scope: Record<string, unknown> = {}): Promise<string> {
  vi.resetModules()
  const { useZonedDates } = await import('../../../services/liquid-dates.js')
  return useZonedDates(new Liquid()).parseAndRender(tpl, scope)
}

const FMT = "{{ v | date: '%b %-d, %Y at %-I:%M %p' }}"

describe('zoned liquid date filter', () => {
  beforeEach(() => {
    setting = null
  })

  it('formats a UTC timestamp in Eastern when no instance zone is set', async () => {
    // 13:20 UTC = 9:20 AM EDT — the email that read "1:20 PM".
    expect(await render(FMT, { v: '2026-10-16T13:20:34.000Z' })).toBe('Oct 16, 2026 at 9:20 AM')
    expect(await render(FMT, { v: new Date('2026-10-16T13:20:34Z') })).toBe(
      'Oct 16, 2026 at 9:20 AM'
    )
  })

  it('keeps an evening timestamp on its Eastern day', async () => {
    expect(await render("{{ v | date: '%b %-d' }}", { v: '2026-10-17T02:30:00Z' })).toBe('Oct 16')
  })

  it('uses nivaro_settings.default_timezone when set', async () => {
    setting = 'America/Chicago'
    expect(await render(FMT, { v: '2026-10-16T13:20:34.000Z' })).toBe('Oct 16, 2026 at 8:20 AM')
  })

  it('falls back to Eastern on an invalid zone', async () => {
    setting = 'Not/AZone'
    expect(await render(FMT, { v: '2026-10-16T13:20:34.000Z' })).toBe('Oct 16, 2026 at 9:20 AM')
  })

  it('never shifts a calendar date to the previous day', async () => {
    const day = "{{ v | date: '%Y-%m-%d' }}"
    expect(await render(day, { v: '2026-10-16' })).toBe('2026-10-16')
    expect(await render(day, { v: '2026-10-16T00:00:00.000Z' })).toBe('2026-10-16')
    // SQL `date` columns arrive as a Date at UTC midnight.
    expect(await render(day, { v: new Date(Date.UTC(2026, 9, 16)) })).toBe('2026-10-16')
  })

  it('honours an explicit zone argument', async () => {
    expect(
      await render("{{ v | date: '%-I:%M %p', 'Europe/London' }}", {
        v: '2026-10-16T13:20:34.000Z'
      })
    ).toBe('2:20 PM')
  })

  it("renders 'now' and chains into other filters", async () => {
    const out = await render("{{ 'now' | date: '%Y-%m-%d' | append: '!' }}")
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}!$/)
  })
})

describe('days from today in the instance zone', () => {
  it('counts Eastern days whatever the process zone', async () => {
    vi.resetModules()
    const { daysFromToday, zonedDay } = await import('../../../services/liquid-dates.js')
    const ET = 'America/New_York'
    // 9:30 PM EDT Oct 16 — already Oct 17 in UTC.
    const now = new Date('2026-10-17T01:30:00Z')
    expect(daysFromToday('2026-10-16', ET, now)).toBe(0)
    expect(daysFromToday('2026-10-17', ET, now)).toBe(1)
    expect(daysFromToday(new Date(Date.UTC(2026, 9, 16)), ET, now)).toBe(0)
    expect(daysFromToday('2026-10-17T02:00:00Z', ET, now)).toBe(0)
    expect(daysFromToday('2026-10-01', ET, now)).toBe(-15)
    expect(daysFromToday('', ET, now)).toBeNull()
    expect(daysFromToday('soon', ET, now)).toBeNull()
    expect(zonedDay('2026-10-16 23:30:00', ET)).toBe('2026-10-16')
  })

  it('currentTimezone answers Eastern before the first read and the setting after', async () => {
    vi.resetModules()
    setting = 'America/Denver'
    const { currentTimezone, instanceTimezone } = await import('../../../services/liquid-dates.js')
    expect(currentTimezone()).toBe('America/New_York')
    await instanceTimezone()
    expect(currentTimezone()).toBe('America/Denver')
  })
})
