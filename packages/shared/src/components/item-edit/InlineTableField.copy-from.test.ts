import { describe, expect, it } from 'vitest'
import {
  findingFieldLabel,
  OWN_RECORD_WRITES_EVENT,
  ownWritesOf
} from '../panels/RecordIntegrityBanner'
import { dropUnavailableValues } from './InlineTableField'
import type { CMSField } from './types'

// army6 M5: "Copy from…" a Power line onto a CMTS project brought a Category
// the project does not offer; Save took it.
describe('dropUnavailableValues', () => {
  it('drops a copied value this record does not offer and names it', () => {
    const rows = [
      { category: 102, task: 1, quantity: 4 },
      { category: 7, task: 1, quantity: 1 }
    ]
    const available = new Map([
      ['category', new Set(['7'])],
      ['task', new Set(['1'])]
    ])
    const { rows: kept, dropped } = dropUnavailableValues(rows, available)
    expect(kept[0]).toEqual({ task: 1, quantity: 4 })
    expect(kept[1]).toEqual({ category: 7, task: 1, quantity: 1 })
    expect(dropped).toEqual([['category'], []])
  })
  it('a column with no check is left alone; empty values are never dropped', () => {
    const { rows, dropped } = dropUnavailableValues(
      [{ category: 102, cifa: null }],
      new Map([['cifa', new Set<string>()]])
    )
    expect(rows[0]).toEqual({ category: 102, cifa: null })
    expect(dropped).toEqual([[]])
  })
  it('does not change the rows it was given', () => {
    const src = [{ category: 102 }]
    dropUnavailableValues(src, new Map([['category', new Set<string>()]]))
    expect(src[0]).toEqual({ category: 102 })
  })
})

// army6 M5: after a Fix the grid said "changed by others · changed by <me>",
// and the banner heading read the raw "workflow_lines".
describe('integrity banner', () => {
  it('lists the rows a proposal writes (for the grid to stamp as its own)', () => {
    expect(
      ownWritesOf({
        writes: [
          { op: 'update', collection: 'workflow_line_items', item_id: 475915, data: {} },
          { op: 'create', collection: 'workflow_line_items', data: {} }
        ],
        pick: { collection: 'workflow_line_items', item_id: '475916' }
      })
    ).toEqual([
      { collection: 'workflow_line_items', id: '475915' },
      { collection: 'workflow_line_items', id: '475916' }
    ])
    expect(ownWritesOf({})).toEqual([])
    expect(OWN_RECORD_WRITES_EVENT).toBe('nvr:own-record-writes')
  })
  it('names a finding by its field label, never the raw field name', () => {
    const fields = [{ field: 'workflow_lines', label: 'PO / REQ Lines' }] as CMSField[]
    expect(findingFieldLabel('workflow_lines', fields)).toBe('PO / REQ Lines')
    expect(findingFieldLabel('workflow_lines', undefined)).toBe('Workflow Lines')
  })
})
