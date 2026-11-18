import { describe, expect, it } from 'vitest'
import { touchesOnScreen } from './MyWorkView'

// R7 (realtime gaps 2026-11-17): "Updates available — refresh" appeared for any write in a
// collection the person owns records in (busy workflows: about every 30 s). Now only writes to
// records on screen (or bulk writes) refresh the page.
describe('touchesOnScreen', () => {
  const onScreen = new Set(['workflows:12', 'invoices:7'])
  it('a write to a record on screen counts', () => {
    expect(touchesOnScreen({ collection: 'workflows', item: 12 }, onScreen)).toBe(true)
    expect(
      touchesOnScreen(
        { collection: 'invoices', item: null, coalesced: true, items: [3, 7] },
        onScreen
      )
    ).toBe(true)
  })
  it('a write to another record of the same collection does not', () => {
    expect(touchesOnScreen({ collection: 'workflows', item: 99 }, onScreen)).toBe(false)
    expect(
      touchesOnScreen(
        { collection: 'workflows', item: null, coalesced: true, items: [1, 2] },
        onScreen
      )
    ).toBe(false)
  })
  it('a bulk or too-many write may have touched anything', () => {
    expect(touchesOnScreen({ collection: 'workflows', item: '*' }, onScreen)).toBe(true)
    expect(
      touchesOnScreen(
        { collection: 'workflows', item: null, coalesced: true, many: true },
        onScreen
      )
    ).toBe(true)
  })
})
