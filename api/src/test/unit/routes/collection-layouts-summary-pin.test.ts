import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { summaryForOf } from '../../../services/layout-resolve-rules.js'
import { pickSummaryLayoutTraced } from '../../../services/summary-pick.js'

const base = { layout_type: 'summary', is_active: true }
const def = { ...base, id: 86, name: 'Summary', conditions: null }
const pinned = (id: number, forms: number[], extra: Record<string, unknown> = {}) => ({
  ...base,
  id,
  name: `Summary ${id}`,
  is_active: false,
  conditions: { summary_for: forms, ...extra }
})

describe('summaryForOf', () => {
  it('keeps positive integers, deduped, in order', () => {
    expect(summaryForOf({ summary_for: [3, '4', 3, -1, 'x'] })).toEqual([3, 4])
  })
  it('reads a JSON string', () => {
    expect(summaryForOf(JSON.stringify({ summary_for: [5] }))).toEqual([5])
  })
  it('is empty for null, {} or a non-array', () => {
    expect(summaryForOf(null)).toEqual([])
    expect(summaryForOf({})).toEqual([])
    expect(summaryForOf({ summary_for: 7 })).toEqual([])
  })
})

describe('pickSummaryLayoutTraced (Summary per record form)', () => {
  it('a pinned Summary wins over the default', () => {
    const r = pickSummaryLayoutTraced([def, pinned(90, [10])], 'r1', false, null, 10)
    expect(r.row?.id).toBe(90)
    expect(r.reason).toBe('pinned')
  })
  it('an unpinned form gets the default', () => {
    const r = pickSummaryLayoutTraced([def, pinned(90, [10])], 'r1', false, null, 11)
    expect(r.row?.id).toBe(86)
    expect(r.reason).toBe('default')
  })
  it('without for_layout the default answers', () => {
    const r = pickSummaryLayoutTraced([def, pinned(90, [10])], 'r1', false, null)
    expect(r.row?.id).toBe(86)
    expect(r.reason).toBe('default')
  })
  it('an inactive Summary pinned elsewhere is not a default', () => {
    const r = pickSummaryLayoutTraced([pinned(90, [10])], 'r1', false, null, 11)
    expect(r.row).toBeNull()
    expect(r.reason).toBeNull()
  })
  it('a role-blocked pin falls to the default', () => {
    const blocked = pinned(90, [10], { role_ids: ['other'] })
    const r = pickSummaryLayoutTraced([def, blocked], 'r1', false, null, 10)
    expect(r.row?.id).toBe(86)
    expect(r.reason).toBe('default')
  })
  it('two pins on one form: the first wins', () => {
    const r = pickSummaryLayoutTraced([pinned(91, [10]), pinned(92, [10])], 'r1', false, null, 10)
    expect(r.row?.id).toBe(91)
  })
  it('a stale pin (form gone) is ignored: the default answers', () => {
    const r = pickSummaryLayoutTraced([def, pinned(90, [999])], 'r1', false, null, 10)
    expect(r.row?.id).toBe(86)
    expect(r.reason).toBe('default')
  })
  it("a pinned Summary's phone version swaps in on a phone", () => {
    const phone = {
      ...base,
      id: 95,
      name: 'Pinned phone',
      conditions: { phone_of: 90 }
    }
    const r = pickSummaryLayoutTraced([def, pinned(90, [10]), phone], 'r1', false, 'phone', 10)
    expect(r.row?.id).toBe(95)
    expect(r.reason).toBe('pinned')
  })
})
