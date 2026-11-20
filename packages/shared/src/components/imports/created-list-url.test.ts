import { describe, expect, it } from 'vitest'
import { createdListUrl } from './CollectionImportPanel'

describe("an import's View the created records link", () => {
  it('is the admin list shape when the host maps nothing', () => {
    expect(createdListUrl({}, 'cifa_items', ['58983', '58984'])).toBe(
      '/collections/cifa_items?ids=58983%2C58984'
    )
  })
  it("goes through the host's consoleUrl (efp-new lists at /records)", () => {
    const nav = { consoleUrl: (p: string) => p.replace('/collections/', '/records/') }
    expect(createdListUrl(nav, 'cifa_items', ['1'])).toBe('/records/cifa_items?ids=1')
  })
  it('a host with no list page hides it (null)', () => {
    expect(createdListUrl({ consoleUrl: () => null }, 'cifa_items', ['1'])).toBeNull()
  })
})
