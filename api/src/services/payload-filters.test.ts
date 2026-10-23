import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({
  db: vi.fn((table: string) => ({
    select: async () => (table === 'nivaro_blackout_dates' ? [] : []),
    first: async () => undefined
  }))
}))

import {
  addDays,
  atLeastDaysOut,
  editorText,
  isoDate,
  jsonify,
  nextOpenDay,
  padStart,
  payloadLiquid
} from './payload-filters.js'

describe('payload-filters', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T16:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('pad_start pads to 9 with zeros', () => {
    expect(padStart('123', 9, '0')).toBe('000000123')
    expect(padStart(null, 9, '0')).toBe('')
  })

  it('at_least_days_out lifts a near date', () => {
    expect(atLeastDaysOut('2026-10-23', 7)).toBe('2026-10-29')
    expect(atLeastDaysOut('2026-12-01', 7)).toBe('2026-12-01')
    expect(atLeastDaysOut(null, 7)).toBe('2026-10-29')
  })

  it('add_days counts calendar days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
  })

  it('next_open_day skips a weekend', async () => {
    expect(await nextOpenDay('2026-10-24')).toBe('2026-10-26')
  })

  it('editor_text flattens EditorJS blocks', () => {
    const doc = JSON.stringify({
      blocks: [{ data: { text: 'Hello <b>there</b>' } }, { data: { text: 'bye' } }]
    })
    expect(editorText(doc)).toBe('Hello there bye')
  })

  it('iso_date and jsonify', () => {
    expect(isoDate('2026-10-22')).toBe('2026-10-22')
    expect(isoDate('')).toBeNull()
    expect(jsonify(undefined)).toBe('null')
  })

  it('payloadLiquid is a shared engine with the filters', async () => {
    expect(payloadLiquid()).toBe(payloadLiquid())
    expect(await payloadLiquid().parseAndRender("{{ v | pad_start: 5, '0' }}", { v: '7' })).toBe(
      '00007'
    )
  })
})
