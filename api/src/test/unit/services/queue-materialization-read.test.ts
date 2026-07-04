import { describe, expect, it } from 'vitest'
import { requiresLiveResolveFallback } from '../../../services/queue-materialization-read.js'

describe('requiresLiveResolveFallback', () => {
  it('returns true when sort references an extra field', () => {
    expect(requiresLiveResolveFallback('extra.owner.name', {})).toBe(true)
  })

  it('returns true when a column filter key references an extra field', () => {
    expect(requiresLiveResolveFallback('', { 'extra.priority': 'High' })).toBe(true)
  })

  it('returns true when filters include sla_status', () => {
    expect(requiresLiveResolveFallback('', { sla_status: 'breached' })).toBe(true)
  })

  it('returns true when filters include aging_hours', () => {
    expect(requiresLiveResolveFallback('', { aging_hours: { min: 1, max: 10 } })).toBe(true)
  })

  it('returns true when sort is owners', () => {
    expect(requiresLiveResolveFallback('owners', {})).toBe(true)
  })

  it('returns true when sort is -owners (descending)', () => {
    expect(requiresLiveResolveFallback('-owners', {})).toBe(true)
  })

  it('returns false when neither sort nor filters reference any fallback-triggering field', () => {
    expect(requiresLiveResolveFallback('-aging_hours', { state: 'review' })).toBe(false)
  })

  it('returns false for empty sort and filters', () => {
    expect(requiresLiveResolveFallback('', {})).toBe(false)
  })
})
