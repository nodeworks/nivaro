import { describe, expect, it } from 'vitest'
import { staleBannerMode, touchedEditsDiffer } from './stale-banner'

const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

describe('stale-record banner (army6 L44)', () => {
  it('a clean form takes the newer record: no "may overwrite theirs"', () => {
    expect(staleBannerMode({ dirty: false, editsDiffer: false })).toBe('auto-refresh')
    // Touched earlier but saved / settled since: still clean.
    expect(staleBannerMode({ dirty: false, editsDiffer: true })).toBe('auto-refresh')
  })

  it('warns about overwriting only while an edited field differs from the latest value', () => {
    expect(staleBannerMode({ dirty: true, editsDiffer: true })).toBe('review')
    expect(staleBannerMode({ dirty: true, editsDiffer: false })).toBe('refresh')
  })

  it('compares the edited fields with the latest record', () => {
    const latest = { description: 'S1 B2', title: 'T' }
    // Picked Theirs: the edited field now holds their value.
    expect(touchedEditsDiffer(['description'], { ...latest }, latest, eq)).toBe(false)
    expect(
      touchedEditsDiffer(['description'], { ...latest, description: 'mine' }, latest, eq)
    ).toBe(true)
    // Not read yet: every edit counts.
    expect(touchedEditsDiffer(['description'], latest, undefined, eq)).toBe(true)
    // Internal keys never count; nothing touched = nothing differs.
    expect(touchedEditsDiffer(['__flush'], { __flush: 1 }, latest, eq)).toBe(false)
    expect(touchedEditsDiffer([], { description: 'x' }, latest, eq)).toBe(false)
  })
})
