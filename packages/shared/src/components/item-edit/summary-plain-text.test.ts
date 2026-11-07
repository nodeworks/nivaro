import { describe, expect, it } from 'vitest'
import { isSamePick } from './RelationCombobox'
import { o2mItemRelation, o2mRowLabel, summaryPlainText } from './SummaryPanel'
import type { CMSRelation } from './types'

// Army 2026-11-05 (a02-9): a plain MWF ID `<b>x</b>` read literally on the
// form but `x` in the Summary rail.
describe('summaryPlainText', () => {
  it('leaves a plain text field to show exactly what was typed', () => {
    expect(summaryPlainText('<b>x</b>', 'input')).toBeNull()
    expect(summaryPlainText('A & B "quoted"', 'input')).toBeNull()
    expect(summaryPlainText('<b>x</b>', '')).toBeNull()
  })

  it('flattens a rich-text field to its words', () => {
    expect(summaryPlainText('<p>Hello <b>there</b></p>', 'input-rich-text-html')).toBe(
      'Hello there'
    )
  })

  it('still reads a legacy EditorJS blob as words in any field', () => {
    const blob = JSON.stringify({ blocks: [{ type: 'paragraph', data: { text: 'Old note' } }] })
    expect(summaryPlainText(blob, 'input')).toBe('Old note')
  })

  it('is null for a non-string value', () => {
    expect(summaryPlainText(5, 'input')).toBeNull()
    expect(summaryPlainText(null, 'input-rich-text-html')).toBeNull()
  })
})

// Army 2026-11-05 (a01-11): re-picking the selected Project Type cleared the
// Sub Type it had filled.
describe('isSamePick', () => {
  it('is the current value whatever its id type', () => {
    expect(isSamePick(2, 2)).toBe(true)
    expect(isSamePick('2', 2)).toBe(true)
    expect(isSamePick(2, '2')).toBe(true)
  })
  it('is never a pick into or from an empty field, or a different option', () => {
    expect(isSamePick(null, 2)).toBe(false)
    expect(isSamePick('', 2)).toBe(false)
    expect(isSamePick(undefined, 2)).toBe(false)
    expect(isSamePick(2, null)).toBe(false)
    expect(isSamePick(2, 3)).toBe(false)
  })
})

// army6 M49: an IR's Summary listed Materials as "#163069 $9,430.54".
describe('Summary child rows never show a row id', () => {
  it('a row with no template label or usual name has no label (the caller names it)', () => {
    expect(o2mRowLabel({ id: 163069, cifa: 311239, total: 9430.54 }, null)).toBeNull()
    expect(o2mRowLabel({ id: 1, description: 'Rack' }, null)).toBe('Rack')
  })
  it('the item a line is about: a usual item field, never the parent FK or a person', () => {
    const rels = [
      {
        many_collection: 'inventory_request_materials',
        many_field: 'inventory_request',
        one_collection: 'inventory_request'
      },
      {
        many_collection: 'inventory_request_materials',
        many_field: 'user_created',
        one_collection: 'nivaro_users'
      },
      {
        many_collection: 'inventory_request_materials',
        many_field: 'warehouse',
        one_collection: 'warehouses'
      },
      {
        many_collection: 'inventory_request_materials',
        many_field: 'cifa',
        one_collection: 'cifa_items'
      }
    ] as CMSRelation[]
    expect(o2mItemRelation(rels, 'inventory_request_materials', 'inventory_request')).toEqual({
      field: 'cifa',
      collection: 'cifa_items'
    })
    expect(
      o2mItemRelation(rels.slice(0, 3), 'inventory_request_materials', 'inventory_request')
    ).toEqual({
      field: 'warehouse',
      collection: 'warehouses'
    })
    expect(
      o2mItemRelation(rels.slice(0, 2), 'inventory_request_materials', 'inventory_request')
    ).toBeNull()
  })
})
