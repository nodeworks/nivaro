import { describe, expect, it, vi } from 'vitest'

// The blackout-date cache is per tenant: cloud tenants share this module, and one tenant's
// blackout days must never move another tenant's next open day.

const state = vi.hoisted(() => ({
  tenant: '',
  dates: { a: ['2026-10-26'], b: [] as string[] } as Record<string, string[]>,
  reads: 0
}))

vi.mock('./tenant-rooms.js', () => ({ currentTenantKey: () => state.tenant }))
vi.mock('../db/index.js', () => ({
  db: vi.fn(() => ({
    select: async () => {
      state.reads++
      return (state.dates[state.tenant] ?? []).map((date) => ({ date }))
    }
  }))
}))

import { nextOpenDay } from './payload-filters.js'

describe('nextOpenDay blackout cache', () => {
  it('keeps each tenant’s blackout dates apart', async () => {
    state.tenant = 'a'
    // Saturday → Monday is a blackout for tenant a → Tuesday.
    expect(await nextOpenDay('2026-10-24')).toBe('2026-10-27')
    state.tenant = 'b'
    expect(await nextOpenDay('2026-10-24')).toBe('2026-10-26')
    // Both cached now: no further reads for either tenant.
    const reads = state.reads
    state.tenant = 'a'
    expect(await nextOpenDay('2026-10-24')).toBe('2026-10-27')
    expect(state.reads).toBe(reads)
  })
})
