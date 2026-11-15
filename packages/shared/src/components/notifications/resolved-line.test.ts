import { afterEach, describe, expect, it } from 'vitest'
import { setDisplayTimezone } from '../../lib/utils'
import { foldItems, resolvedLabel } from './resolved-line'

// rt4-notify items 1 + 4: the settled row's calm line and the folded updates list.

describe('resolvedLabel', () => {
  afterEach(() => setDisplayTimezone(null))

  it('"Approved by Beth · 10:42 AM" — the clock alone today', () => {
    setDisplayTimezone('America/New_York')
    const label = resolvedLabel(
      {
        on: 'approval',
        by: 'b',
        by_name: 'Beth',
        at: '2026-11-14T15:42:00Z',
        text: 'Approved by Beth'
      },
      new Date('2026-11-14T20:00:00Z')
    )
    expect(label).toBe('Approved by Beth · 10:42 AM')
  })

  it('another day carries the date', () => {
    setDisplayTimezone('America/New_York')
    const label = resolvedLabel(
      {
        on: 'step',
        by: 'b',
        by_name: 'Beth',
        at: '2026-11-12T15:42:00Z',
        text: "Moved to PUB'd by Beth"
      },
      new Date('2026-11-14T20:00:00Z')
    )
    expect(label).toBe("Moved to PUB'd by Beth · Nov 12, 10:42 AM")
  })

  it('nothing settled = no line', () => {
    expect(resolvedLabel(null)).toBeNull()
  })
})

describe('foldItems', () => {
  it('lists folded updates newest first, only when there are several', () => {
    const items = [
      { subject: 'a', message: null, at: '2026-11-14T10:00:00Z', sender: null, category: null },
      { subject: 'b', message: null, at: '2026-11-14T11:00:00Z', sender: null, category: null }
    ]
    expect(foldItems({ count: 2, items }).map((i) => i.subject)).toEqual(['b', 'a'])
    expect(foldItems({ count: 1, items: items.slice(0, 1) })).toEqual([])
    expect(foldItems(null)).toEqual([])
  })
})
