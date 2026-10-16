import { Liquid } from 'liquidjs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/integration-remediation.js', () => ({
  classifyError: vi.fn(() => 'unknown')
}))

import { dayInZone, useZonedDates } from '../../../services/liquid-dates.js'
import {
  addCalendarDays,
  calendarDay,
  registerPayloadFilters
} from '../../../services/workflow-actions.js'

// The db mock throws on the settings read, so the instance zone is the Eastern fallback.
const engine = new Liquid({ strictFilters: false, strictVariables: false })
registerPayloadFilters(engine)
useZonedDates(engine)
const render = (tpl: string, scope: Record<string, unknown> = {}) =>
  engine.parseAndRender(tpl, scope)

describe('payload template filters — pad_start', () => {
  it('left-pads a short numeric string to the requested width', async () => {
    expect(await render("{{ v | pad_start: 9, '0' }}", { v: '106416' })).toBe('000106416')
  })

  it('defaults the fill character to 0', async () => {
    expect(await render('{{ v | pad_start: 9 }}', { v: '106416' })).toBe('000106416')
  })

  it('returns already-wide input unchanged', async () => {
    expect(await render('{{ v | pad_start: 9 }}', { v: '000106416' })).toBe('000106416')
    expect(await render('{{ v | pad_start: 9 }}', { v: 'abcdefghij' })).toBe('abcdefghij')
  })

  it('renders a missing value as an empty string, never a padded "null"', async () => {
    expect(await render('{{ v | pad_start: 9 }}', {})).toBe('')
    expect(await render('{{ v | pad_start: 9 }}', { v: null })).toBe('')
  })

  it('pads numbers and trims whitespace before measuring', async () => {
    expect(await render('{{ v | pad_start: 5 }}', { v: 42 })).toBe('00042')
    expect(await render('{{ v | pad_start: 5 }}', { v: '  42 ' })).toBe('00042')
  })

  it('uses only the first character of a multi-character fill', async () => {
    expect(await render("{{ v | pad_start: 3, 'xy' }}", { v: '7' })).toBe('xx7')
  })

  it('leaves the value alone when the width is not a number', async () => {
    expect(await render("{{ v | pad_start: 'nine' }}", { v: '7' })).toBe('7')
  })
})

describe('calendar days', () => {
  it('keeps a date-only value as the day it names', () => {
    expect(calendarDay('2026-10-31')).toBe('2026-10-31')
    expect(addCalendarDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addCalendarDays('2026-10-25', 14)).toBe('2026-11-08')
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('reads a timestamp as the day it falls on here, and nothing as today', () => {
    const evening = new Date(2026, 8, 27, 19, 30)
    expect(calendarDay(undefined, evening)).toBe('2026-09-27')
    expect(calendarDay(evening)).toBe('2026-09-27')
    expect(calendarDay('not a date')).toBeNull()
  })

  it('counts days in the zone it is given, whatever the process zone', () => {
    // 9:30 PM EDT on Sep 27 is already Sep 28 in UTC.
    const lateEvening = new Date('2026-09-28T01:30:00Z')
    const ET = 'America/New_York'
    expect(calendarDay(undefined, lateEvening, ET)).toBe('2026-09-27')
    expect(calendarDay(lateEvening, new Date(), ET)).toBe('2026-09-27')
    expect(calendarDay('2026-09-28T01:30:00.000Z', new Date(), ET)).toBe('2026-09-27')
    // Calendar dates keep their day: date-only, UTC midnight (SQL `date`), naive.
    expect(calendarDay('2026-10-16', new Date(), ET)).toBe('2026-10-16')
    expect(calendarDay(new Date(Date.UTC(2026, 9, 16)), new Date(), ET)).toBe('2026-10-16')
    expect(calendarDay('2026-10-16T00:00:00', new Date(), ET)).toBe('2026-10-16')
    expect(calendarDay('2026-10-16 23:30:00', new Date(), ET)).toBe('2026-10-16')
  })
})

describe('payload day filters count Eastern days', () => {
  it('add_days / iso_date / at_least_days_out read an evening timestamp as its Eastern day', async () => {
    const v = '2026-09-28T01:30:00.000Z' // Sep 27, 9:30 PM EDT
    expect(await render('{{ v | add_days: 1 }}', { v })).toBe('2026-09-28')
    expect(await render('{{ v | iso_date }}', { v })).toBe('2026-09-27')
    expect(await render('{{ v | at_least_days_out: 0 }}', { v: '2099-01-01T01:30:00Z' })).toBe(
      '2098-12-31'
    )
  })

  it('iso_date keeps a SQL date and renders nothing for nothing', async () => {
    expect(await render('{{ v | iso_date }}', { v: new Date(Date.UTC(2026, 9, 16)) })).toBe(
      '2026-10-16'
    )
    expect(await render('{{ v | iso_date }}', { v: '' })).toBe('')
    expect(await render('{{ v | iso_date }}', { v: 'junk' })).toBe('')
  })
})

describe('payload template filters — the pre-existing set still registers', () => {
  it('jsonify renders a missing value as null and strings quoted', async () => {
    expect(await render('{{ v | jsonify }}', {})).toBe('null')
    expect(await render('{{ v | jsonify }}', { v: 'a"b' })).toBe('"a\\"b"')
  })

  it('add_days on a missing variable counts from today', async () => {
    // Sixty days on the calendar from today's Eastern date, whatever the hour,
    // the process zone, or a daylight-saving change in between.
    const iso = addCalendarDays(dayInZone(new Date(), 'America/New_York'), 60)
    expect(await render('{{ missing | add_days: 60 }}')).toBe(iso)
    // The idiom for "today + N" in a template: LiquidJS's `nil` literal hands a
    // filter an internal Nil object (not null), so `{{ nil | add_days: 60 }}`
    // renders EMPTY — start from `'now' | date` instead.
    expect(await render("{{ 'now' | date: '%Y-%m-%d' | add_days: 60 }}")).toBe(iso)
    expect(await render('{{ nil | add_days: 60 }}')).toBe('')
  })
})
