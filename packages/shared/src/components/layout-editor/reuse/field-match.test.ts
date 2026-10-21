import { describe, expect, it } from 'vitest'
import { matchNames, parseFieldList, squash, suggestFieldMap } from './field-match'
import { isFilled, recordSeedFields } from './seed'

const fields = [
  { field: 'title', label: 'Title' },
  { field: 'unit_price', label: 'Unit price' },
  { field: 'vendor_id', label: 'Vendor' },
  { field: 'po_number', label: 'PO number' },
  { field: 'description', label: 'Description' }
]

describe('parseFieldList', () => {
  it('reads one per line, commas, tabs and a CSV header; quotes and repeats dropped', () => {
    expect(parseFieldList('Title\nVendor\r\n\nTitle')).toEqual(['Title', 'Vendor'])
    expect(parseFieldList('"title","unit_price";vendor\tpo')).toEqual([
      'title',
      'unit_price',
      'vendor',
      'po'
    ])
    expect(parseFieldList('﻿a, b')).toEqual(['a', 'b'])
  })
})

describe('matchNames', () => {
  it('matches by name, by the same words, by label and by close spelling, in list order', () => {
    const m = matchNames(['title', 'Unit Price', 'Vendor', 'descripton', 'nope'], fields)
    expect(m.map((x) => [x.input, x.field, x.how])).toEqual([
      ['title', 'title', 'exact'],
      ['Unit Price', 'unit_price', 'same'],
      ['Vendor', 'vendor_id', 'label'],
      ['descripton', 'description', 'close'],
      ['nope', null, null]
    ])
  })

  it('never hands one field out twice, and skips excluded ones', () => {
    const m = matchNames(['title', 'Title'], fields)
    expect(m[1].field).toBeNull()
    expect(matchNames(['title'], fields, ['title'])[0].field).toBeNull()
  })

  it('squash ignores case, spaces, underscores and dashes', () => {
    expect(squash('Unit-Price ')).toBe(squash('unit_price'))
  })
})

describe('suggestFieldMap', () => {
  it('maps only the fields the target lacks', () => {
    const map = suggestFieldMap(
      ['title', 'UnitPrice', { field: 'supplier', label: 'Vendor' }, 'zzz'],
      fields
    )
    expect(map).toEqual({ UnitPrice: 'unit_price', supplier: 'vendor_id', zzz: null })
  })
})

describe('recordSeedFields', () => {
  it('keeps the fields a record has filled in, in field order, without system or hidden ones', () => {
    const record = {
      id: 9,
      title: 'A',
      amount: 0,
      notes: '  ',
      tags: [],
      flag: false,
      secret: 'x',
      date_created: '2026-01-01'
    }
    const list = [
      { field: 'id' },
      { field: 'title' },
      { field: 'amount' },
      { field: 'notes' },
      { field: 'tags' },
      { field: 'flag' },
      { field: 'secret', hidden: true },
      { field: 'divider', type: 'alias', interface: 'presentation-divider' },
      { field: 'date_created' }
    ]
    expect(recordSeedFields(record, list)).toEqual(['title', 'amount', 'flag'])
    expect(isFilled({})).toBe(false)
  })
})
