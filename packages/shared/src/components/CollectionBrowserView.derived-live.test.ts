import { describe, expect, it } from 'vitest'
import { isCbvDerivedQuery } from './CollectionBrowserView'

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
