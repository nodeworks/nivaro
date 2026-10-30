import { describe, expect, it } from 'vitest'
import {
  cellWidth,
  formSkeletonFromLayout,
  gridRows,
  shapeForField,
  skeletonColumnsFrom
} from './skeleton-shapes'

describe('skeleton shapes (#3229)', () => {
  it('maps field types to cell shapes', () => {
    expect(shapeForField('integer')).toBe('number')
    expect(shapeForField('datetime')).toBe('date')
    expect(shapeForField('boolean')).toBe('bool')
    expect(shapeForField('string', 'select-dropdown')).toBe('badge')
    expect(shapeForField('uuid', 'select-dropdown-m2o-user')).toBe('avatar')
    expect(shapeForField('string')).toBe('text')
  })

  it('widths are deterministic per cell', () => {
    expect(cellWidth('text', 3, 2)).toBe(cellWidth('text', 3, 2))
    expect(cellWidth('date', 0, 0)).toMatch(/^\d+px$/)
    expect(cellWidth('avatar', 4, 1)).toBe('20px')
  })

  it('builds columns from the list columns and fields, keeping resized widths', () => {
    const cols = skeletonColumnsFrom(
      ['name', 'amount', 'project.name'],
      [
        { field: 'name', type: 'string' },
        { field: 'amount', type: 'decimal' },
        { field: 'project', type: 'integer', interface: 'select-dropdown-m2o' }
      ],
      { name: 220 }
    )
    expect(cols.map((c) => c.shape)).toEqual(['text', 'number', 'badge'])
    expect(cols[0].width).toBe(220)
  })
})

describe('formSkeletonFromLayout', () => {
  const layout = {
    ungrouped_sort: null,
    groups: [
      { id: 1, key: 'main', label: 'Main', type: 'section', sort: 1 },
      { id: 2, key: 'money', label: 'Money', type: 'section', sort: 2 },
      {
        id: 3,
        key: 'later',
        label: 'Only new',
        type: 'section',
        sort: 3,
        visibility_mode: 'new_only'
      }
    ],
    assignments: [
      { field: 'name', group_key: 'main', sort: 1, col_span: 6, is_visible: true },
      { field: 'code', group_key: 'main', sort: 2, col_span: 6, is_visible: 1 },
      { field: 'hidden', group_key: 'main', sort: 3, col_span: 6, is_visible: 0 },
      { field: 'lines', group_key: 'money', sort: 1, col_span: null, is_visible: true },
      { field: '__comments__', group_key: 'money', sort: 2, col_span: 12, is_visible: true },
      { field: 'x', group_key: 'later', sort: 1, is_visible: true }
    ]
  }

  it('paints the real sections and spans of an existing record', () => {
    const plan = formSkeletonFromLayout(layout)
    expect(plan?.tabs).toEqual([])
    expect(plan?.sections.map((s) => s.label)).toEqual(['Main', 'Money'])
    expect(plan?.sections[0].fields.map((f) => f.span)).toEqual([6, 6])
    expect(plan?.sections[1].fields[1]).toEqual({ key: '__comments__', span: 12, tall: true })
  })

  it('a new record also gets new-only sections', () => {
    expect(formSkeletonFromLayout(layout, { isNew: true })?.sections).toHaveLength(3)
  })

  it('tabs: the strip lists every tab; only the first tab paints', () => {
    const plan = formSkeletonFromLayout({
      groups: [
        { id: 10, key: 't1', label: 'Details', type: 'tab', sort: 1 },
        { id: 11, key: 't2', label: 'History', type: 'tab', sort: 2 },
        { id: 12, key: 's1', label: 'Basics', type: 'section', sort: 1, container_id: 10 },
        { id: 13, key: 's2', label: 'Elsewhere', type: 'section', sort: 1, container_id: 11 }
      ],
      assignments: [
        { field: 'a', group_key: 's1', sort: 1, is_visible: true },
        { field: 'b', group_key: 's2', sort: 1, is_visible: true }
      ]
    })
    expect(plan?.tabs).toEqual(['Details', 'History'])
    expect(plan?.sections.map((s) => s.label)).toEqual(['Basics'])
  })

  it('no layout = null; grid rows count wraps', () => {
    expect(formSkeletonFromLayout(null)).toBeNull()
    expect(
      gridRows([
        { key: 'a', span: 6 },
        { key: 'b', span: 6 },
        { key: 'c', span: 12 },
        { key: 'd', span: 4 }
      ])
    ).toBe(3)
  })
})
