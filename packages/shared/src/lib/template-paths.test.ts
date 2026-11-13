import { describe, expect, it } from 'vitest'
import { recordHeadingText } from '../components/ItemEditForm'
import { applyDisplayTemplate } from '../components/item-edit/helpers'
import { templateRelationPaths, withLinkedFields } from './template-paths'

// Rob 2026-11-13: a category record's heading read "Categories (no number)". Its template is
// "{{core_category.name}} - {{sub_category.name}}" and the record read carries only the ids.
const TPL = '{{core_category.name}} - {{sub_category.name}}'
const row = { id: 246, core_category: 9, sub_category: 1 }

describe('record heading through linked fields', () => {
  it('ids alone fall back to "(no number)" — the reported bug', () => {
    expect(recordHeadingText(applyDisplayTemplate(TPL, row), row, 'Categories')).toBe(
      'Categories (no number)'
    )
  })

  it('with the linked records read in, the heading is the template', () => {
    const linked = {
      id: 246,
      core_category: { name: 'BUILDINGS/LAND' },
      sub_category: { name: 'Labor' }
    }
    const merged = withLinkedFields(row, linked)
    expect(recordHeadingText(applyDisplayTemplate(TPL, merged), row, 'Categories')).toBe(
      'BUILDINGS/LAND - Labor'
    )
    expect(templateRelationPaths(TPL)).toEqual(['core_category.name', 'sub_category.name'])
  })

  it('a link the read did not expand keeps the record value', () => {
    expect(withLinkedFields(row, { id: 246, core_category: 9 })).toEqual(row)
    expect(withLinkedFields(row, null)).toEqual(row)
  })
})
