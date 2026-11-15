import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: {} }))

import {
  impactBody,
  impactFingerprint,
  impactSubject,
  newSinceLastLook,
  noteCatalogChange,
  parseCatalogSource,
  priceDiffers,
  type RecordImpact,
  resetCatalogImpactCache,
  simpleParentMatch
} from '../../../services/catalog-impact.js'

const relations = [
  {
    many_collection: 'request_lines',
    many_field: 'request',
    one_collection: 'requests',
    one_field: 'lines'
  },
  { many_collection: 'request_lines', many_field: 'item', one_collection: 'parts', one_field: null }
]

const mode = {
  item_field: 'item',
  section_by: 'category.name',
  qty_field: 'quantity',
  copy_fields: { price: 'price', description: 'description', unit_cost: 'cost' },
  compute_fields: { total: '{{price}} * {{quantity}}' },
  field_formats: { price: 'currency', unit_cost: 'currency', total: 'currency' },
  related_columns: [
    {
      key: 'on_hand',
      collection: 'stock',
      item_field: 'part',
      value_field: 'on_hand',
      match: { warehouse: '$parent.warehouse' }
    }
  ]
}

describe('parseCatalogSource (rt6 #19)', () => {
  it('reads lines, catalog, the money the catalog fills and the stock column', () => {
    const src = parseCatalogSource('requests', 'lines', mode, relations)
    expect(src).toEqual({
      parent: 'requests',
      field: 'lines',
      lines: 'request_lines',
      fk: 'request',
      itemField: 'item',
      catalog: 'parts',
      qtyField: 'quantity',
      prices: [
        { line: 'price', catalog: 'price' },
        { line: 'unit_cost', catalog: 'cost' }
      ],
      stock: {
        collection: 'stock',
        itemField: 'part',
        valueField: 'on_hand',
        matchField: 'warehouse',
        parentField: 'warehouse',
        sum: false
      }
    })
  })

  it('a computed total is never a price; a stock column with a complex match is skipped', () => {
    const src = parseCatalogSource(
      'requests',
      'lines',
      {
        ...mode,
        copy_fields: { total: 'price' },
        related_columns: [
          {
            key: 'on_hand',
            collection: 'stock',
            item_field: 'part',
            value_field: 'on_hand',
            match: { warehouse: { regions: { _some: { id: { _eq: '$parent.region' } } } } }
          }
        ]
      },
      relations
    )
    expect(src).toBeNull()
  })

  it('not a catalog field / no relation: null', () => {
    expect(parseCatalogSource('requests', 'lines', null, relations)).toBeNull()
    expect(parseCatalogSource('requests', 'other', mode, relations)).toBeNull()
    expect(
      parseCatalogSource('requests', 'lines', { ...mode, item_field: 'x; drop' }, relations)
    ).toBeNull()
  })

  it('simpleParentMatch: one token, bare or {_eq}', () => {
    expect(simpleParentMatch({ warehouse: '$parent.warehouse' })).toEqual({
      matchField: 'warehouse',
      parentField: 'warehouse'
    })
    expect(simpleParentMatch({ site: { _eq: '$parent.site_id' } })).toEqual({
      matchField: 'site',
      parentField: 'site_id'
    })
    expect(simpleParentMatch({ a: '$parent.a', b: '$parent.b' })).toBeNull()
    expect(simpleParentMatch({ a: 'fixed' })).toBeNull()
  })
})

describe('impact words', () => {
  it('priceDiffers mirrors the line note (both priced, a cent or more)', () => {
    expect(priceDiffers(398, 412)).toBe(true)
    expect(priceDiffers('398.00', '398.004')).toBe(false)
    expect(priceDiffers(0, 412)).toBe(false)
    expect(priceDiffers(398, null)).toBe(false)
  })

  it('a short title that survives truncation', () => {
    expect(impactSubject({ records: 3 })).toBe('Catalog update affects 3 of your records')
    expect(impactSubject({ records: 1 })).toBe('Catalog update affects 1 of your records')
  })

  it('the body: one plain line per kind of change', () => {
    expect(impactBody({ priceLines: 14, shortLines: 3, placeField: 'supporting_warehouse' })).toBe(
      '14 lines have a new price. Each keeps its old price until you choose the new one on the record.\n' +
        '3 lines ask for more than is in stock at the supporting warehouse.'
    )
    expect(impactBody({ priceLines: 1, shortLines: 0 })).toBe(
      '1 line has a new price. It keeps its old price until you choose the new one on the record.'
    )
    expect(impactBody({ priceLines: 0, shortLines: 1, placeField: 'site_id' })).toBe(
      '1 line asks for more than is in stock at the site.'
    )
  })

  it('the fingerprint is the same for the same findings in any order, and moves with a price', () => {
    const a: RecordImpact = {
      parent: 'requests',
      record: '7',
      priceLines: new Set(['1']),
      shortLines: new Set(),
      marks: ['1:p0:412']
    }
    const b: RecordImpact = { ...a, record: '8', marks: ['2:p0:10'] }
    expect(impactFingerprint([a, b])).toBe(impactFingerprint([b, a]))
    expect(impactFingerprint([a, b])).not.toBe(
      impactFingerprint([{ ...a, marks: ['1:p0:415'] }, b])
    )
  })
})

describe('newSinceLastLook', () => {
  const r: RecordImpact = {
    parent: 'requests',
    record: '7',
    priceLines: new Set(['1', '2']),
    shortLines: new Set(['3']),
    marks: ['7|1|p0=412', '7|2|p0=50', '7|3|s=2']
  }

  it('no last look: the first pass only sets it', () => {
    expect(newSinceLastLook([r], null)).toEqual([])
  })

  it('only lines that newly differ, or differ by another amount', () => {
    const before = new Map([
      ['', ''],
      ['7|1|p0', '412'],
      ['7|2|p0', '45'],
      ['7|3|s', '2']
    ])
    const out = newSinceLastLook([r], before)
    expect(out).toHaveLength(1)
    expect([...out[0].priceLines]).toEqual(['2'])
    expect(out[0].shortLines.size).toBe(0)
    expect(out[0].marks).toEqual(['7|2|p0=50'])
    expect(
      newSinceLastLook([r], new Map(r.marks.map((m) => m.split('=') as [string, string])))
    ).toEqual([])
    // A stock line that was fine before.
    expect([...newSinceLastLook([r], new Map([['', '']]))[0].shortLines]).toEqual(['3'])
  })
})

describe('noteCatalogChange', () => {
  afterEach(() => resetCatalogImpactCache())

  it('never throws, and skips system tables', () => {
    vi.useFakeTimers()
    expect(() => noteCatalogChange('nivaro_users', ['1'])).not.toThrow()
    expect(() => noteCatalogChange('bad name', ['1'])).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
