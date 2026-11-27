import { describe, expect, it } from 'vitest'
import {
  PROVIDER_CATEGORIES,
  providerCategoryOf
} from '../../../services/hub/providers/categories.js'
import { CORE_PROVIDERS } from '../../../services/hub/providers/index.js'

describe('provider groups', () => {
  it('places every core provider in a known group other than Other', () => {
    const known = new Set(PROVIDER_CATEGORIES.map((c) => c.key))
    const loose = CORE_PROVIDERS.map((p) => [p.key, providerCategoryOf(p)] as const).filter(
      ([, c]) => !known.has(c) || c === 'other'
    )
    expect(loose, 'add the provider to CORE_CATEGORY in providers/categories.ts').toEqual([])
  })

  it("an adapter's own group wins; a bad key falls back", () => {
    expect(providerCategoryOf({ key: 'github', category: 'ai' })).toBe('ai')
    expect(providerCategoryOf({ key: 'my-erp', category: 'erp' })).toBe('erp')
    expect(providerCategoryOf({ key: 'my-erp', category: 'Not A Key!' })).toBe('other')
    expect(providerCategoryOf({ key: 'my-erp' })).toBe('other')
  })

  it('lists Other last', () => {
    expect(PROVIDER_CATEGORIES.at(-1)?.key).toBe('other')
  })
})
