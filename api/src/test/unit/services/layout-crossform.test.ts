import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  type CrossformGroup,
  type CrossformLayout,
  type CrossformPlacement,
  effectiveLabel,
  labelFindings,
  layoutThumb,
  likeContains,
  nearDuplicates,
  rankFieldHit
} from '../../../services/layout-crossform.js'

const layout = (id: number, over: Partial<CrossformLayout> = {}): CrossformLayout => ({
  id,
  name: `Form ${id}`,
  layout_type: 'grouped',
  parent_layout_id: null,
  is_active: false,
  tab_mode: null,
  ...over
})

const place = (
  layout_id: number,
  field: string,
  over: Partial<CrossformPlacement> = {}
): CrossformPlacement => ({
  layout_id,
  field,
  group_key: 'main',
  sort: 0,
  col_span: null,
  is_visible: true,
  label_override: null,
  overrides: null,
  ...over
})

const group = (
  layout_id: number,
  id: number,
  key: string,
  over: Partial<CrossformGroup> = {}
): CrossformGroup => ({
  id,
  layout_id,
  key,
  label: key,
  type: 'section',
  container_id: null,
  sort: id,
  tab_mode: null,
  ...over
})

const labels = new Map([
  ['vendor', 'Vendor'],
  ['amount', 'Amount'],
  ['site', 'Site'],
  ['title', 'Title'],
  ['notes', 'Notes'],
  ['owner', 'Owner']
])

describe('effectiveLabel', () => {
  it('prefers the editor label, then the inline rename, then the field label', () => {
    expect(effectiveLabel({ label_override: null, overrides: null }, 'Vendor')).toBe('Vendor')
    expect(effectiveLabel({ label_override: 'Supplier', overrides: null }, 'Vendor')).toBe(
      'Supplier'
    )
    expect(
      effectiveLabel({ label_override: 'Supplier', overrides: '{"label":"Seller"}' }, 'Vendor')
    ).toBe('Seller')
  })

  it('reads a hidden label as null', () => {
    expect(effectiveLabel({ label_override: null, overrides: { label: '' } }, 'Vendor')).toBeNull()
  })
})

describe('labelFindings', () => {
  it('lists a field shown under different labels, most used label first', () => {
    const out = labelFindings(
      [layout(1), layout(2), layout(3)],
      [
        place(1, 'vendor'),
        place(2, 'vendor'),
        place(3, 'vendor', { overrides: { label: 'Supplier' } }),
        place(1, 'amount'),
        place(2, 'amount')
      ],
      labels
    )
    expect(out).toHaveLength(1)
    expect(out[0].field).toBe('vendor')
    expect(out[0].variants.map((v) => v.label)).toEqual(['Vendor', 'Supplier'])
    expect(out[0].variants[1].layouts).toEqual([{ id: 3, name: 'Form 3' }])
  })

  it('ignores hidden placements, hidden labels, table layouts and page cards', () => {
    const out = labelFindings(
      [layout(1), layout(2), layout(3, { layout_type: 'table' })],
      [
        place(1, 'vendor'),
        place(2, 'vendor', { is_visible: false, label_override: 'X' }),
        place(2, 'amount', { overrides: { label: '' } }),
        place(1, 'amount'),
        place(3, 'vendor', { label_override: 'Vend.' }),
        place(1, '__pipeline__', { group_key: null, label_override: 'Steps' }),
        place(2, '__pipeline__', { group_key: null })
      ],
      labels
    )
    expect(out).toEqual([])
  })
})

describe('nearDuplicates', () => {
  const fields = ['vendor', 'amount', 'site', 'title', 'notes', 'owner']
  const all = (id: number) => fields.map((f, i) => place(id, f, { sort: i }))

  it('pairs forms of the same kind that are 90% or more identical', () => {
    const a = all(1)
    const b = [...all(2), ...[1, 2, 3, 4].map((n) => place(2, `extra${n}`))]
    const many = Array.from({ length: 40 }, (_, i) => `f${i}`)
    const c = many.map((f) => place(3, f))
    const d = [...many.map((f) => place(4, f)), place(4, 'one_more')]
    const out = nearDuplicates(
      [layout(1), layout(2), layout(3), layout(4)],
      [...a, ...b, ...c, ...d],
      labels
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      a: { id: 3 },
      b: { id: 4 },
      identical: 40,
      only_a: 0,
      only_b: 1,
      differing: 0,
      parent_id: 4,
      can_link: true
    })
    expect(out[0].similarity).toBeCloseTo(40 / 41, 3)
  })

  it('counts a differently configured shared field against the pair', () => {
    const a = all(1)
    const b = all(2).map((p) => (p.field === 'vendor' ? { ...p, col_span: 6 } : p))
    const out = nearDuplicates([layout(1), layout(2)], [...a, ...b], labels, 0.8)
    expect(out[0]).toMatchObject({ identical: 5, differing: 1 })
    expect(out[0].similarity).toBeCloseTo(5 / 6, 3)
  })

  it('makes the default form the parent and skips pairs already linked', () => {
    const out = nearDuplicates(
      [layout(1), layout(2, { is_active: true })],
      [...all(1), ...all(2)],
      labels
    )
    expect(out[0].parent_id).toBe(2)
    expect(
      nearDuplicates(
        [layout(1), layout(2, { parent_layout_id: 1 })],
        [...all(1), ...all(2)],
        labels
      )
    ).toEqual([])
  })

  it('cannot link a child that is itself a parent', () => {
    const out = nearDuplicates(
      [
        layout(1, { is_active: true }),
        layout(2),
        layout(9, { parent_layout_id: 2, layout_type: 'summary' })
      ],
      [...all(1), ...all(2)],
      labels
    )
    expect(out[0]).toMatchObject({ parent_id: 1, can_link: false })
  })

  it('never pairs different kinds or tiny forms', () => {
    expect(
      nearDuplicates(
        [layout(1), layout(2, { layout_type: 'summary' })],
        [...all(1), ...all(2)],
        labels
      )
    ).toEqual([])
    expect(
      nearDuplicates([layout(1), layout(2)], [place(1, 'vendor'), place(2, 'vendor')], labels)
    ).toEqual([])
  })
})

describe('layoutThumb', () => {
  it('draws sections with field rows packed by width', () => {
    const thumb = layoutThumb(
      layout(1),
      [group(1, 1, 'main'), group(1, 2, 'notes_s', { type: 'content' })],
      [
        place(1, 'vendor', { col_span: 6, sort: 0 }),
        place(1, 'amount', { col_span: 6, sort: 1 }),
        place(1, 'site', { col_span: 4, sort: 2 }),
        place(1, 'title', { sort: 3 }),
        place(1, 'notes', { sort: 4, is_visible: false })
      ]
    )
    expect(thumb.blocks).toEqual([
      { kind: 'section', label: 'main', rows: [[6, 6], [4], [12]] },
      { kind: 'text', label: 'notes_s', rows: [] }
    ])
    expect(thumb.more).toBe(0)
  })

  it('draws a container as one tabs or steps block with its count', () => {
    const thumb = layoutThumb(
      layout(1),
      [
        group(1, 1, 'holder', { type: 'container', tab_mode: 'steps' }),
        group(1, 2, 's1', { type: 'tab', container_id: 1, sort: 0 }),
        group(1, 3, 's2', { type: 'tab', container_id: 1, sort: 1 })
      ],
      [place(1, 'vendor', { group_key: 's1' }), place(1, 'amount', { group_key: 's2' })]
    )
    expect(thumb.blocks).toEqual([{ kind: 'steps', label: 'holder', count: 2, rows: [[12]] }])
  })

  it('draws old top-level tab groups as the form steps, ungrouped fields and page cards', () => {
    const thumb = layoutThumb(
      layout(1, { tab_mode: 'steps' }),
      [group(1, 1, 's1', { type: 'tab', sort: 0 }), group(1, 2, 's2', { type: 'tab', sort: 1 })],
      [
        place(1, 'vendor', { group_key: 's1' }),
        place(1, 'amount', { group_key: null, sort: 0 }),
        place(1, '__ungrouped_pos__', { group_key: null, sort: 5 }),
        place(1, '__pipeline__', { group_key: null, sort: 9 }),
        place(1, '__comments__', { group_key: null, sort: 10 })
      ]
    )
    expect(thumb.blocks.map((b) => b.kind)).toEqual(['steps', 'section', 'slot'])
    expect(thumb.blocks[0].count).toBe(2)
    expect(thumb.blocks[2].count).toBe(2)
  })

  it('clips long sections and many blocks', () => {
    const groups = Array.from({ length: 8 }, (_, i) => group(1, i + 1, `g${i}`))
    const placements = Array.from({ length: 6 }, (_, i) =>
      place(1, `f${i}`, { group_key: 'g0', sort: i })
    )
    const thumb = layoutThumb(layout(1), groups, placements)
    expect(thumb.blocks).toHaveLength(6)
    expect(thumb.more).toBe(2)
    expect(thumb.blocks[0]).toMatchObject({ rows: [[12], [12], [12], [12]], clipped: 2 })
  })
})

describe('field search helpers', () => {
  it('escapes LIKE wildcards', () => {
    expect(likeContains('a_b%c[d')).toBe('%a\\_b\\%c\\[d%')
  })

  it('ranks exact key, exact label and prefixes first', () => {
    expect(rankFieldHit('vendor', { field: 'vendor', label: 'Vendor' })).toBe(0)
    expect(rankFieldHit('supplier', { field: 'vendor', label: 'Supplier' })).toBe(1)
    expect(rankFieldHit('ven', { field: 'vendor_id', label: 'X' })).toBe(2)
    expect(rankFieldHit('dor', { field: 'vendor', label: 'X' })).toBe(3)
  })
})
