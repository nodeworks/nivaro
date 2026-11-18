import { describe, expect, it } from 'vitest'
import { ccQueryParams } from './api'

// R9 (realtime gaps 2026-11-17): every rewind scrub re-keyed (and blanked) panels whose answer
// is live-only, like Needs attention.
describe('ccQueryParams', () => {
  const at = Date.UTC(2026, 10, 17, 14, 0)
  it('a board read carries region and the rewind', () => {
    expect(ccQueryParams({ region: 'east', at }, { tz: 'UTC' })).toEqual({
      tz: 'UTC',
      region: 'east',
      at: new Date(at).toISOString()
    })
  })
  it('a live-only read never carries the rewind (same key whatever the time bar says)', () => {
    const live = ccQueryParams({ region: 'east', at }, undefined, { live: true })
    expect(live).toEqual({ region: 'east' })
    expect(ccQueryParams({ region: 'east', at: null }, undefined, { live: true })).toEqual(live)
  })
  it('lenses off: only the read’s own params, plus the wallboard token', () => {
    expect(
      ccQueryParams({ region: 'east', at, kiosk: 'k1' }, { id: 3 }, { lenses: false })
    ).toEqual({ id: 3, kiosk: 'k1' })
  })
})
