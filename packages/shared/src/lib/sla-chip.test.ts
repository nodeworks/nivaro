import { describe, expect, it } from 'vitest'
import { slaChip, withinDay } from './sla-chip'

describe('slaChip', () => {
  it('names the breach age and the time to breach', () => {
    expect(slaChip({ status: 'breached', remaining_hours: -50 })).toEqual({
      label: 'breached 2d ago',
      tone: 'alert'
    })
    expect(slaChip({ status: 'warning', remaining_hours: 6 })).toEqual({
      label: 'breaches in 6h',
      tone: 'warn'
    })
    expect(slaChip({ status: 'ok', remaining_hours: 80 })).toEqual({
      label: 'breaches in 3d',
      tone: 'neutral'
    })
    expect(slaChip({ status: null, remaining_hours: null })).toBeNull()
    expect(slaChip(null)).toBeNull()
    expect(slaChip({ status: 'ok', remaining_hours: Number.NaN })).toBeNull()
  })

  it('reports a bare breach when the age is unknown', () => {
    expect(slaChip({ status: 'breached', remaining_hours: null })).toEqual({
      label: 'breached',
      tone: 'alert'
    })
  })

  it('rounds a short breach age to hours with a 1h floor', () => {
    expect(slaChip({ status: 'breached', remaining_hours: -0.2 })).toEqual({
      label: 'breached 1h ago',
      tone: 'alert'
    })
    expect(slaChip({ status: 'breached', remaining_hours: -6 })).toEqual({
      label: 'breached 6h ago',
      tone: 'alert'
    })
  })

  it('handles undefined the same as null', () => {
    expect(slaChip(undefined)).toBeNull()
  })

  it('treats a missing remaining_hours as no chip when not breached', () => {
    expect(slaChip({ status: 'warning', remaining_hours: null })).toBeNull()
  })

  it('warns under the 24h boundary and reads neutral at or past it', () => {
    expect(slaChip({ status: 'warning', remaining_hours: 23.6 })?.tone).toBe('warn')
    expect(slaChip({ status: 'ok', remaining_hours: 24 })?.tone).toBe('neutral')
  })
})

describe('withinDay', () => {
  it('is true only for a non-breached record with remaining hours at or under 24', () => {
    expect(withinDay({ status: 'warning', remaining_hours: 10 })).toBe(true)
    expect(withinDay({ status: 'warning', remaining_hours: 24 })).toBe(true)
    expect(withinDay({ status: 'ok', remaining_hours: 25 })).toBe(false)
    expect(withinDay({ status: 'breached', remaining_hours: 5 })).toBe(false)
    expect(withinDay({ status: 'ok', remaining_hours: null })).toBe(false)
    expect(withinDay(null)).toBe(false)
    expect(withinDay(undefined)).toBe(false)
  })
})
