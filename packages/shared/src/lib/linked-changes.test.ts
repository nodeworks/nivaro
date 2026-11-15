import { describe, expect, it } from 'vitest'
import {
  catalogPriceText,
  linePriceChange,
  stockShortText
} from '../components/item-edit/catalog-line-watch'
import {
  agoWords,
  eventMatters,
  linkedChangeSentence,
  shownLabel,
  targetsHit
} from './linked-changes'

const NOW = Date.parse('2026-11-14T16:00:00Z')
const TWO_MIN_AGO = '2026-11-14T15:58:00.000Z'

describe('linked record changed (rt4 #6)', () => {
  const change = (fields: unknown[], kind: 'update' | 'hidden' = 'update') => ({
    label: 'Vendor ABC',
    at: TWO_MIN_AGO,
    by: 'Beth Lee',
    kind,
    fields: fields as never
  })

  it('deactivated', () => {
    expect(
      linkedChangeSentence(
        'Vendor',
        change([{ field: 'active', label: 'Active', type: 'boolean', value: false }]),
        NOW
      )
    ).toBe('Vendor ABC was deactivated 2 min ago by Beth Lee')
  })

  it('hidden from pickers', () => {
    expect(linkedChangeSentence('Vendor', change([], 'hidden'), NOW)).toBe(
      'Vendor ABC was hidden from pickers 2 min ago by Beth Lee'
    )
  })

  it('retired / archived flags', () => {
    expect(
      linkedChangeSentence(
        'Unit',
        change([{ field: 'is_retired', label: 'Retired', type: 'boolean', value: true }]),
        NOW
      )
    ).toBe('Vendor ABC was retired 2 min ago by Beth Lee')
  })

  it('a status set to a choice', () => {
    expect(
      linkedChangeSentence(
        'Project',
        change([{ field: 'status', label: 'Status', type: 'string', value: 'Closed' }]),
        NOW
      )
    ).toBe('Vendor ABC was set to Closed 2 min ago by Beth Lee')
  })

  it('anything else names the fields', () => {
    expect(
      linkedChangeSentence(
        'Vendor',
        change([{ field: 'region', label: 'Region', type: 'integer' }]),
        NOW
      )
    ).toBe('Vendor ABC was changed 2 min ago by Beth Lee (Region)')
  })

  it('nothing known (a write outside the app): the field label', () => {
    expect(linkedChangeSentence('Vendor', null, NOW)).toBe('Vendor is no longer offered here')
  })

  it('a bare number from the server gives way to what the picker shows', () => {
    const hidden = {
      label: '#3663',
      at: TWO_MIN_AGO,
      by: 'Beth Lee',
      kind: 'hidden' as const,
      fields: []
    }
    expect(linkedChangeSentence('Install Location', hidden, NOW, 'gloucester.nj')).toBe(
      'gloucester.nj was hidden from pickers 2 min ago by Beth Lee'
    )
    expect(
      shownLabel([
        [
          ['relation-single'],
          { id: 3663, name: 'gloucester.nj', created: '2021-10-05T20:10:41.447Z' }
        ]
      ])
    ).toBe('gloucester.nj')
    expect(shownLabel([[['x'], null]])).toBeNull()
  })

  it('ago words', () => {
    expect(agoWords(NOW - 10_000, NOW)).toBe('just now')
    expect(agoWords(NOW - 3_600_000 * 3, NOW)).toBe('3 hours ago')
  })

  it('only events that can change a link count; ids compare case-blind', () => {
    expect(eventMatters(['$comments'])).toBe(false)
    expect(eventMatters(['$lock', '$tasks'])).toBe(false)
    expect(eventMatters(['$picker'])).toBe(true)
    expect(eventMatters(['active'])).toBe(true)
    expect(eventMatters(null)).toBe(true)
    const targets = [
      { field: 'vendor', collection: 'vendors', id: 'ab-1' },
      { field: 'project', collection: 'projects', id: '9' }
    ]
    expect(targetsHit(targets, 'vendors', new Set(['AB-1']), false).map((t) => t.field)).toEqual([
      'vendor'
    ])
    expect(targetsHit(targets, 'projects', new Set(['8']), false)).toEqual([])
    expect(targetsHit(targets, 'projects', new Set(['*']), true).map((t) => t.field)).toEqual([
      'project'
    ])
  })
})

describe('line price / stock (rt4 #7)', () => {
  const money = (n: number) => `$${n.toFixed(2)}`

  it('a price change since the line was added', () => {
    const c = linePriceChange('398', 412)
    expect(c).toEqual({ was: 398, now: 412 })
    expect(catalogPriceText(c!, money)).toBe('Catalog price now $412.00 (was $398.00 when added)')
  })

  it('no marker for the same price, an empty price or a catalog with none', () => {
    expect(linePriceChange(398, '398.00')).toBeNull()
    expect(linePriceChange(null, 412)).toBeNull()
    expect(linePriceChange(398, 0)).toBeNull()
    expect(linePriceChange(398, null)).toBeNull()
  })

  it('stock short at the line warehouse', () => {
    expect(stockShortText(3, 5, 'Main Warehouse')).toBe(
      'Only 3 in stock at Main Warehouse (this line needs 5)'
    )
    expect(stockShortText(0, 5, null)).toBe('None in stock (this line needs 5)')
  })
})
