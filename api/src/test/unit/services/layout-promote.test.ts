import { describe, expect, it } from 'vitest'
import {
  formChangeTitle,
  formChangeTrailer,
  parseFormChange
} from '../../../services/layout-change-requests.js'
import {
  dependencyNodes,
  extensionDependenciesOf,
  forgetLayoutDependencies,
  referenceImpact,
  registerLayoutDependency
} from '../../../services/layout-dependencies.js'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../../services/layout-ops-apply.js'
import { matchLayout, planLayoutPromotion, sameShape } from '../../../services/layout-promote.js'

const g = (key: string, sort: number, extra: Partial<GroupRow> = {}): GroupRow => ({
  ...newGroup(key, key.toUpperCase(), 'section', null),
  sort,
  ...extra
})
const p = (
  field: string,
  group: string | null,
  sort: number,
  extra: Partial<PlacementRow> = {}
) => ({
  ...newPlacement(field, group),
  sort,
  ...extra
})

function bundle(over: {
  layout?: Record<string, unknown>
  groups?: GroupRow[]
  placements?: PlacementRow[]
  rev?: string
}): LayoutBundle {
  return {
    layout: {
      id: 1,
      collection: 'orders',
      name: 'Main',
      slug: 'main',
      layout_type: 'grouped',
      ...over.layout
    },
    groups: over.groups ?? [],
    placements: over.placements ?? [],
    rev: 'r'
  } as LayoutBundle
}

describe('planLayoutPromotion (#2593)', () => {
  const mine = bundle({
    layout: { id: 7, is_active: true, sort: 3, disable_comments: false },
    groups: [g('main', 0, { id: 70 }), g('old', 1, { id: 71 }), ungroupedGroup(2)],
    placements: [
      p('a', 'main', 0, { id: 1 }),
      p('b', 'main', 1, { id: 2 }),
      p('c', 'old', 0, { id: 3 }),
      p('__comments__', null, 3, { id: 4 })
    ]
  })
  const theirs = bundle({
    layout: { id: 99, is_active: false, sort: 0, disable_comments: true },
    groups: [
      g('main', 1, { id: 500, label: 'Main details' }),
      g('box', 0, { id: 501, type: 'container' }),
      g('t1', 0, { id: 502, type: 'tab', parent_key: 'box' }),
      ungroupedGroup(2)
    ],
    placements: [
      p('b', 'main', 0, { id: 10, col_span: 6 }),
      p('a', 'main', 1, { id: 11 }),
      p('d', 't1', 0, { id: 12, label_override: 'Dee' }),
      p('__comments__', null, 3, { id: 13 })
    ]
  })

  it('makes this copy match the other, keeping default and list order', () => {
    const plan = planLayoutPromotion(mine, theirs)
    const after = applyLayoutOps(mine, plan.ops)
    expect(plan.exact).toBe(true)
    expect(sameShape(after, theirs)).toBe(true)
    expect(after.layout.is_active).toBe(true)
    expect(after.layout.sort).toBe(3)
    expect(after.layout.disable_comments).toBe(true)
    const texts = plan.changes.map((c) => c.text)
    expect(texts).toContain('Remove c from “OLD”')
    expect(texts).toContain('Remove section “OLD”')
    expect(texts).toContain('Add d to “T1”')
    expect(plan.changes.some((c) => c.kind === 'order')).toBe(true)
  })

  it('plans nothing for identical copies', () => {
    const plan = planLayoutPromotion(mine, { ...mine, layout: { ...mine.layout, id: 123 } })
    expect(plan.ops).toEqual([])
    expect(plan.changes).toEqual([])
    expect(plan.exact).toBe(true)
  })

  it('lists skipped settings and does not carry them', () => {
    const t = bundle({ ...theirs, layout: { ...theirs.layout, pdf_template_id: 44 } })
    const plan = planLayoutPromotion(mine, t, { pdf_template_id: 'Not carried: missing' })
    const after = applyLayoutOps(mine, plan.ops)
    expect(after.layout.pdf_template_id).toBeUndefined()
    expect(plan.changes.find((c) => c.target === 'pdf_template_id')?.action).toBe('skip')
    expect(plan.exact).toBe(true)
  })

  it('treats bits and booleans alike', () => {
    const a = bundle({ layout: { disable_tasks: 0 } })
    const b = bundle({ layout: { disable_tasks: false } })
    expect(planLayoutPromotion(a, b).ops).toEqual([])
  })

  it('matches by link name, then by name', () => {
    const cands = [
      { id: 1, name: 'Other', slug: 'main' },
      { id: 2, name: 'Main', slug: null }
    ]
    expect(matchLayout({ name: 'Main', slug: 'MAIN' }, cands)?.id).toBe(1)
    expect(matchLayout({ name: 'main', slug: null }, cands)?.id).toBe(2)
    expect(matchLayout({ name: 'x', slug: 'y' }, cands)).toBeNull()
  })
})

describe('form change requests (#2609)', () => {
  it('round-trips the form + field line', () => {
    const d = `Please move it up\nthanks${formChangeTrailer({ id: 12, name: 'Main\nform' }, { name: 'vendor_id', label: 'Vendor' })}`
    expect(parseFormChange(d)).toEqual({
      message: 'Please move it up\nthanks',
      layout_id: 12,
      layout_name: 'Main form',
      field: 'vendor_id',
      field_label: 'Vendor'
    })
    expect(parseFormChange('just text').layout_id).toBeNull()
    expect(parseFormChange(`x${formChangeTrailer({ id: 3, name: 'A' }, null)}`).field).toBeNull()
  })
  it('titles from the first line', () => {
    expect(formChangeTitle('Hide the notes\nmore')).toBe('Form change: Hide the notes')
    expect(formChangeTitle('x'.repeat(200)).length).toBeLessThan(140)
  })
})

describe('layout dependencies (#2613)', () => {
  it('says which change breaks each reference', () => {
    expect(referenceImpact('queue').breaks).toEqual(['slug', 'type', 'delete'])
    expect(referenceImpact('generated_files').breaks).toEqual(['delete'])
    expect(referenceImpact('share_links').by).toBe('id')
  })
  it('finds extension declarations by id or link name', () => {
    registerLayoutDependency('ext-a', { collection: 'orders', slug: 'Main', label: 'Order email' })
    registerLayoutDependency('ext-a', { collection: 'orders', layout_id: 9, label: 'PDF job' })
    expect(() => registerLayoutDependency('ext-a', { collection: 'orders', label: 'x' })).toThrow()
    const found = extensionDependenciesOf({ id: 9, collection: 'orders', slug: 'main' })
    expect(found.map((d) => d.label)).toEqual(['Order email', 'PDF job'])
    const nodes = dependencyNodes([{ kind: 'queue', id: 'q', label: 'Queue' }], found)
    expect(nodes.map((n) => n.group)).toEqual(['queues', 'extensions', 'extensions'])
    forgetLayoutDependencies('ext-a')
    expect(extensionDependenciesOf({ id: 9, collection: 'orders', slug: 'main' })).toEqual([])
  })
})
