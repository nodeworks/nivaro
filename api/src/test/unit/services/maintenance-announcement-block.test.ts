import { describe, expect, it, vi } from 'vitest'

// Hub phase 6 parked wave (T9): the maintenance row of GET /api/announcements/active tells hosts
// how to present the freeze. Under the Hub's STRICT maintenance (a move) nobody is exempt, so the
// block carries `strict: true` and hosts show administrators the full page too, instead of the
// strip they get under an ordinary freeze (where they can still save).

vi.mock('../../../services/maintenance-live.js', () => ({
  observeMaintenance: () => {},
  recheckMaintenanceSoon: () => {}
}))

const {
  maintenanceBlock,
  MAINTENANCE_DEFAULT_MESSAGE,
  MAINTENANCE_EXPLAINER,
  MAINTENANCE_PAGE_EXPLAINER
} = await import('../../../services/security.js')

describe('maintenanceBlock', () => {
  it('a strict (Hub) freeze says strict, with the page explainer', () => {
    const b = maintenanceBlock({
      display: 'page',
      until: null,
      message: ' This app is moving to a new home. ',
      strict: true
    })
    expect(b).toEqual({
      display: 'page',
      until: null,
      headline: 'This app is moving to a new home.',
      explainer: MAINTENANCE_PAGE_EXPLAINER,
      strict: true
    })
  })

  it('an ordinary freeze carries no strict key (the shape older hosts know, unchanged)', () => {
    const b = maintenanceBlock({
      display: 'banner',
      until: '2026-11-22T20:00:00.000Z',
      message: null
    })
    expect(b).toEqual({
      display: 'banner',
      until: '2026-11-22T20:00:00.000Z',
      headline: MAINTENANCE_DEFAULT_MESSAGE,
      explainer: MAINTENANCE_EXPLAINER
    })
    expect('strict' in b).toBe(false)
  })
})
