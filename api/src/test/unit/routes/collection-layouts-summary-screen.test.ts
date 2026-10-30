import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { pickSummaryLayout } from '../../../routes/collection-layouts.js'

// Candidates arrive in the route's order: is_active desc, sort asc.
const desktop = {
  id: 86,
  name: 'Summary',
  layout_type: 'summary',
  is_active: true,
  conditions: null
}
const phone = {
  id: 107,
  name: 'Summary (phone)',
  layout_type: 'summary',
  is_active: true,
  conditions: { phone_of: 86 }
}
const tablet = {
  id: 108,
  name: 'Summary (tablet)',
  layout_type: 'summary',
  is_active: true,
  conditions: JSON.stringify({ tablet_of: 86 })
}

describe('pickSummaryLayout (#2715 phone version of a Summary layout)', () => {
  it('a desktop never gets a screen version, even one sorted first', () => {
    expect(pickSummaryLayout([phone, desktop], 'r1', false, null)?.id).toBe(86)
  })

  it('a phone gets the phone version of the desktop summary', () => {
    expect(pickSummaryLayout([desktop, phone, tablet], 'r1', false, 'phone')?.id).toBe(107)
  })

  it('a phone without a phone version gets the tablet version', () => {
    expect(pickSummaryLayout([desktop, tablet], 'r1', false, 'phone')?.id).toBe(108)
  })

  it('a tablet gets only the tablet version', () => {
    expect(pickSummaryLayout([desktop, phone], 'r1', false, 'tablet')?.id).toBe(86)
  })

  it('an inactive phone version is not used', () => {
    expect(
      pickSummaryLayout([desktop, { ...phone, is_active: false }], 'r1', false, 'phone')?.id
    ).toBe(86)
  })

  it('a phone version the role may not open falls back to the desktop summary', () => {
    const locked = { ...phone, conditions: { phone_of: 86, role_ids: ['other'] } }
    expect(pickSummaryLayout([desktop, locked], 'r1', false, 'phone')?.id).toBe(86)
  })

  it('no summary the role may open = null', () => {
    const roleOnly = { ...desktop, conditions: { role_ids: ['other'] } }
    expect(pickSummaryLayout([roleOnly], 'r1', false, 'phone')).toBeNull()
  })
})
