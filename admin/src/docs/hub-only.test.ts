import { describe, expect, it } from 'vitest'
import { HUB_DOC_GROUP, navSections, navWithoutHub } from './index'

// The Nivaro Hub's docs (Hub mode only) live in their own nav group, and a regular install's Docs
// page (no `hub` server feature) shows none of them.

describe('Hub docs', () => {
  it('every hub-* section sits in the Hub group', () => {
    for (const g of navSections) {
      for (const s of g.items) {
        if (s.id.startsWith('hub-')) expect(g.id).toBe(HUB_DOC_GROUP)
      }
    }
    const hub = navSections.find((g) => g.id === HUB_DOC_GROUP)
    expect(hub?.label).toContain('Hub mode only')
    expect(hub?.items.map((s) => s.id)).toContain('hub-api')
  })

  it('a regular install sees no Hub section', () => {
    const plain = navWithoutHub(navSections)
    const ids = plain.flatMap((g) => g.items.map((s) => s.id))
    expect(ids.some((id) => id.startsWith('hub-'))).toBe(false)
    expect(ids).not.toContain('sdk-hub')
    expect(ids).toContain('sdk-setup')
  })
})
