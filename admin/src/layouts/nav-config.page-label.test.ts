import { describe, expect, it } from 'vitest'
import { pageLabelForPath } from './nav-config'

describe('pageLabelForPath (a11y A11Y-10)', () => {
  it('names the overview only at the root', () => {
    expect(pageLabelForPath('/')).toBe('Overview')
  })

  it('names a collection page by its collection, record pages included', () => {
    expect(pageLabelForPath('/collections/purchase_orders')).toBe('Purchase Orders')
    expect(pageLabelForPath('/collections/workflows/123')).toBe('Workflows')
  })

  it('uses the most specific nav entry for nested pages', () => {
    expect(pageLabelForPath('/my-work')).toBe('My Work')
    expect(pageLabelForPath('/support')).toBe('Support')
  })

  it('does not match a nav entry by bare prefix', () => {
    expect(pageLabelForPath('/my-workshop')).toBeNull()
  })
})
