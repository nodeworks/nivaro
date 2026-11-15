import { describe, expect, it } from 'vitest'
import { headingFieldNames, headingLinksKey, ownBatchFillsHeading } from './live-title'

describe('live title (rt3 #15)', () => {
  it('reads the template’s top-level fields', () => {
    expect(headingFieldNames('{{po_number}} - {{project.name}}')).toEqual(['po_number', 'project'])
    expect(headingFieldNames(null)).toEqual([])
  })

  it('an own-looking event naming an EMPTY heading field is not this tab’s echo: re-read', () => {
    const batch = { own: true, deleted: false, changedFields: ['po_number'] }
    expect(ownBatchFillsHeading(batch, ['po_number'], { po_number: null })).toBe(true)
    expect(ownBatchFillsHeading(batch, ['po_number'], { po_number: '' })).toBe(true)
  })

  it('an echo of the person’s own heading edit (value already on screen) is skipped', () => {
    const batch = { own: true, deleted: false, changedFields: ['title'] }
    expect(ownBatchFillsHeading(batch, ['title'], { title: 'Pumps' })).toBe(false)
  })

  it('a create echo (no field names) re-reads only while a heading field is empty', () => {
    const batch = { own: true, deleted: false, changedFields: null }
    expect(ownBatchFillsHeading(batch, ['number', 'title'], { number: null, title: 'x' })).toBe(
      true
    )
    expect(ownBatchFillsHeading(batch, ['number'], { number: 'N-1' })).toBe(false)
  })

  it('fields outside the heading never trigger a read', () => {
    const batch = { own: true, deleted: false, changedFields: ['amount'] }
    expect(ownBatchFillsHeading(batch, ['number'], { number: null })).toBe(false)
  })

  it('the heading-links key changes when a link the template reads changes', () => {
    const a = headingLinksKey('categories', '5', ['core_category.name'], { core_category: 3 })
    const b = headingLinksKey('categories', '5', ['core_category.name'], { core_category: 4 })
    expect(a).not.toEqual(b)
    expect(a.slice(0, 3)).toEqual(['item-heading-links', 'categories', '5'])
  })
})
