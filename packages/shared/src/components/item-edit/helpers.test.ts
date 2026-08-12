import { describe, expect, it } from 'vitest'
import { toLocalDatetime } from './helpers'

// toLocalDatetime feeds <input type="datetime-local"> in FieldRenderer, and the
// write path inverts it with `new Date(e.target.value).toISOString()`.
//
// ⚠ KNOWN DEFECT (characterised here, not fixed): despite its name the function
// returns UTC — `new Date(v).toISOString().slice(0,16)`. A datetime-local input
// interprets its `value` as LOCAL time, so a stored instant is displayed shifted
// by the viewer's UTC offset, and every save walks the stored value forward by
// that offset. Two no-op saves in US Eastern move a date into the next day.
//
// These tests pin current behaviour so the drift is documented and any fix
// fails loudly here. Fixing it means formatting local parts
// (getFullYear/getMonth/getDate/getHours/getMinutes) instead of toISOString().

describe('toLocalDatetime', () => {
  it('returns empty string for empty input', () => {
    expect(toLocalDatetime(null)).toBe('')
    expect(toLocalDatetime(undefined)).toBe('')
    expect(toLocalDatetime('')).toBe('')
  })

  it('returns empty string rather than throwing on an unparseable value', () => {
    expect(toLocalDatetime('not a date')).toBe('')
  })

  it('truncates to minute precision, the granularity datetime-local accepts', () => {
    expect(toLocalDatetime('2026-08-04T18:30:45.123Z')).toBe('2026-08-04T18:30')
  })

  it('DEFECT: emits the UTC wall-clock, not the local one', () => {
    // The correct output for a datetime-local input is the LOCAL rendering of
    // the instant. Current output is the UTC rendering.
    const iso = '2026-08-04T18:00:00.000Z'
    const d = new Date(iso)

    expect(toLocalDatetime(iso)).toBe('2026-08-04T18:00')
    expect(toLocalDatetime(iso)).toBe(d.toISOString().slice(0, 16))

    // Whenever the runner is not on UTC, that disagrees with local time.
    if (d.getTimezoneOffset() !== 0) {
      const pad = (n: number) => String(n).padStart(2, '0')
      const localRendering = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
        d.getDate()
      )}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      expect(toLocalDatetime(iso)).not.toBe(localRendering)
    }
  })

  it('DEFECT: a no-op edit round-trip walks the stored instant forward by the UTC offset', () => {
    // Mirrors FieldRenderer exactly: display via toLocalDatetime, write back via
    // new Date(inputValue).toISOString().
    const writeBack = (shown: string) => new Date(shown).toISOString()

    const original = '2026-08-04T18:00:00.000Z'
    const afterOneSave = writeBack(toLocalDatetime(original))
    const offsetMs = new Date(original).getTimezoneOffset() * 60_000

    expect(new Date(afterOneSave).getTime() - new Date(original).getTime()).toBe(offsetMs)

    // Repeated edits compound; west of UTC this eventually crosses a day boundary.
    const afterTwoSaves = writeBack(toLocalDatetime(afterOneSave))
    expect(new Date(afterTwoSaves).getTime() - new Date(original).getTime()).toBe(offsetMs * 2)
  })

  it('is stable only when the runner is on UTC', () => {
    const original = '2026-08-04T18:00:00.000Z'
    const roundTripped = new Date(toLocalDatetime(original)).toISOString()
    const onUtc = new Date(original).getTimezoneOffset() === 0

    expect(roundTripped === original).toBe(onUtc)
  })
})
