import { describe, expect, it } from 'vitest'
import { cbvDerivedTouched, isCbvDerivedQuery } from './CollectionBrowserView'

// C4 (realtime gaps 2026-11-17): a live row patch left alias / dotted columns (project.region)
// and the at-risk tint on their old values.
describe('isCbvDerivedQuery', () => {
  it('names the resolved-path and at-risk reads of this collection only', () => {
    expect(
      isCbvDerivedQuery('workflows', ['cbv-resolved', 'workflows', '1,2', 'project.region'])
    ).toBe(true)
    expect(isCbvDerivedQuery('workflows', ['cbv-risk', 'workflows', '1,2'])).toBe(true)
    expect(isCbvDerivedQuery('workflows', ['cbv-risk', 'invoices', '1,2'])).toBe(false)
    expect(isCbvDerivedQuery('workflows', ['cbv-items', 'workflows'])).toBe(false)
  })
})

describe('cbvDerivedTouched (B5 review: skip re-reads no input moved)', () => {
  const inputs = { resolved: new Set(['project']), risk: new Set(['due_date']) }
  it('re-reads resolved paths only when the link they start from changed', () => {
    expect(cbvDerivedTouched(['project'], inputs)).toEqual({ resolved: true, risk: false })
    expect(cbvDerivedTouched(['notes'], inputs)).toEqual({ resolved: false, risk: false })
  })
  it('re-reads the tint only when a field a rule reads changed', () => {
    expect(cbvDerivedTouched(['due_date', 'notes'], inputs)).toEqual({
      resolved: false,
      risk: true
    })
  })
  it('an event naming no fields may have moved anything (if anything is on screen)', () => {
    expect(cbvDerivedTouched(undefined, inputs)).toEqual({ resolved: true, risk: true })
    expect(cbvDerivedTouched([], { resolved: new Set(), risk: new Set() })).toEqual({
      resolved: false,
      risk: false
    })
  })
  it('narrows the query predicate to one read', () => {
    expect(isCbvDerivedQuery('w', ['cbv-risk', 'w', '1'], 'cbv-resolved')).toBe(false)
    expect(isCbvDerivedQuery('w', ['cbv-risk', 'w', '1'], 'cbv-risk')).toBe(true)
  })
})
