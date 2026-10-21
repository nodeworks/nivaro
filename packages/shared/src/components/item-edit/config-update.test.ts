import { describe, expect, it } from 'vitest'
import { configUpdateReaction } from './config-update'

describe('configUpdateReaction (the "This form was changed" banner)', () => {
  it('a push naming this collection shows the banner on a normal record page', () => {
    expect(configUpdateReaction('orders', 'orders', false)).toBe('banner')
  })

  it('design mode re-reads quietly: the canvas already follows the layout', () => {
    expect(configUpdateReaction('orders', 'orders', true)).toBe('refresh')
  })

  it('a push naming no collection re-reads quietly, never a banner', () => {
    expect(configUpdateReaction(undefined, 'orders', false)).toBe('refresh')
    expect(configUpdateReaction(null, 'orders', false)).toBe('refresh')
    expect(configUpdateReaction('', 'orders', false)).toBe('refresh')
  })

  it('a push about another collection leaves this form alone', () => {
    expect(configUpdateReaction('invoices', 'orders', false)).toBe('ignore')
    expect(configUpdateReaction('invoices', 'orders', true)).toBe('ignore')
  })
})

describe('configUpdateReaction while the host has Edit layout open (layoutEditing)', () => {
  it("the admin's own saves (naming this collection) are ignored: no banner, no refetch", () => {
    expect(configUpdateReaction('orders', 'orders', false, true)).toBe('ignore')
  })

  it('a push naming no collection still re-reads quietly', () => {
    expect(configUpdateReaction(undefined, 'orders', false, true)).toBe('refresh')
  })

  it('a push about another collection is still ignored', () => {
    expect(configUpdateReaction('invoices', 'orders', false, true)).toBe('ignore')
  })

  it('defaults to off: the record page outside a layout session still shows the banner', () => {
    expect(configUpdateReaction('orders', 'orders', false)).toBe('banner')
  })
})
