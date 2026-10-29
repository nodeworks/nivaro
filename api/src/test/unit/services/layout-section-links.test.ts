import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { schema: {} }) }))

import { extractSection, mapBlock } from '../../../services/layout-blocks.js'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../../services/layout-ops-apply.js'
import {
  isLinkedRootKey,
  linkedRootKey,
  linkInSync,
  planLinkedReplace,
  rebaseEdited,
  reconcileLinks,
  sectionSignature,
  withRootKey
} from '../../../services/layout-section-links.js'

const g = (key: string, sort: number, extra: Partial<GroupRow> = {}): GroupRow => ({
  ...newGroup(key, key.toUpperCase(), 'section', null),
  sort,
  ...extra
})
const p = (
  field: string,
  group_key: string | null,
  sort: number,
  extra: Partial<PlacementRow> = {}
): PlacementRow => ({ ...newPlacement(field, group_key), sort, ...extra })

/** The library's own form: an Address section with three fields. */
function library(): LayoutBundle {
  return {
    layout: { id: 1, collection: 'orders', layout_type: 'grouped', name: 'Library form' },
    groups: [g('address', 0, { icon: 'home', visible_when: '[{"field":"kind"}]' })],
    placements: [
      p('street', 'address', 0, { label_override: 'Street line' }),
      p('city', 'address', 1, { col_span: 6 }),
      p('zip', 'address', 2)
    ],
    rev: 'r1'
  }
}

const ROOT = 'lib7_ab12cd34'

/** A form with the linked copy between two sections, plus a slot card. */
function form(): LayoutBundle {
  return {
    layout: { id: 2, collection: 'orders', layout_type: 'grouped', name: 'Order' },
    groups: [
      g('basics', 0),
      g(ROOT, 1, { label: 'ADDRESS', icon: 'home', visible_when: '[{"field":"kind"}]' }),
      g('more', 3),
      ungroupedGroup(4)
    ],
    placements: [
      p('title', 'basics', 0),
      p('street', ROOT, 0, { label_override: 'Street line' }),
      p('city', ROOT, 1, { col_span: 6 }),
      p('zip', ROOT, 2),
      p('__comments__', null, 2),
      p('notes', 'more', 0)
    ],
    rev: 'r2'
  }
}

const libBlock = () => extractSection(library(), 'address')

describe('linked root keys', () => {
  it('are unique per placement and recognisable', () => {
    const a = linkedRootKey(7)
    const b = linkedRootKey(7)
    expect(a).not.toBe(b)
    expect(isLinkedRootKey(a)).toBe(true)
    expect(isLinkedRootKey('address')).toBe(false)
    expect(isLinkedRootKey('lib7_')).toBe(false)
  })

  it('withRootKey renames the root and what sits in it, children keep their keys', () => {
    const tabs = {
      ...library(),
      groups: [g('box', 0, { type: 'container' }), g('t1', 0, { type: 'tab', parent_key: 'box' })],
      placements: [p('street', 't1', 0)]
    }
    const b = withRootKey(extractSection(tabs, 'box'), ROOT)
    expect(b.top).toEqual([{ group: ROOT }])
    expect(b.groups.map((x) => [x.key, x.parent_key])).toEqual([
      [ROOT, null],
      ['t1', ROOT]
    ])
  })
})

describe('linkInSync / planLinkedReplace', () => {
  it('a copy matching the library is in sync', () => {
    expect(linkInSync(libBlock(), form(), ROOT)).toBe(true)
  })

  it('a changed library puts the copy behind, and the plan brings it back in place', () => {
    const lib = library()
    lib.groups[0].icon = 'map-pin'
    lib.placements.push(p('country', 'address', 3))
    lib.placements[1] = p('city', 'address', 1, { col_span: 4 })
    const block = extractSection(lib, 'address')
    const target = form()
    expect(linkInSync(block, target, ROOT)).toBe(false)

    const plan = planLinkedReplace(block, target, ROOT)
    const after = applyLayoutOps(target, plan.ops)
    expect(linkInSync(block, after, ROOT)).toBe(true)
    // Same key, same place between Basics and More, slot card and others untouched.
    const top = after.groups.filter((x) => x.parent_key === null).sort((a, b) => a.sort - b.sort)
    expect(top.map((x) => x.key)).toEqual(['basics', ROOT, 'more', '__ungrouped__'])
    const root = after.groups.find((x) => x.key === ROOT)
    expect(root?.icon).toBe('map-pin')
    expect(
      after.placements.filter((x) => x.group_key === ROOT).map((x) => [x.field, x.col_span])
    ).toEqual([
      ['street', null],
      ['city', 4],
      ['zip', null],
      ['country', null]
    ])
    expect(after.placements.some((x) => x.field === '__comments__')).toBe(true)
    expect(after.placements.find((x) => x.field === 'notes')?.group_key).toBe('more')
  })

  it('an edit made on the form (not through the library) reads as a difference', () => {
    const target = form()
    target.placements = target.placements.filter((x) => x.field !== 'zip')
    expect(linkInSync(libBlock(), target, ROOT)).toBe(false)
  })

  it('a field the form shows elsewhere stays there and never reads as a difference', () => {
    const lib = library()
    lib.placements.push(p('title', 'address', 3))
    const block = extractSection(lib, 'address')
    const plan = planLinkedReplace(block, form(), ROOT)
    expect(plan.already).toEqual(['title'])
    const after = applyLayoutOps(form(), plan.ops)
    expect(after.placements.filter((x) => x.field === 'title').map((x) => x.group_key)).toEqual([
      'basics'
    ])
    expect(linkInSync(block, after, ROOT)).toBe(true)
  })

  it('replaces a tabs holder with its tabs, deepest first', () => {
    const lib: LayoutBundle = {
      ...library(),
      groups: [g('box', 0, { type: 'container' }), g('t1', 0, { type: 'tab', parent_key: 'box' })],
      placements: [p('street', 't1', 0)]
    }
    const target: LayoutBundle = {
      ...form(),
      groups: [
        g(ROOT, 0, { type: 'container', label: 'BOX' }),
        g('t1', 0, { type: 'tab', parent_key: ROOT, label: 'T1' }),
        g('t2', 1, { type: 'tab', parent_key: ROOT, label: 'T2' })
      ],
      placements: [p('street', 't1', 0), p('zip', 't2', 0)]
    }
    const block = extractSection(lib, 'box')
    const plan = planLinkedReplace(block, target, ROOT)
    expect(plan.ops.slice(0, 3)).toEqual([
      { op: 'group_remove', key: 't2', placements: 'delete' },
      { op: 'group_remove', key: 't1', placements: 'delete' },
      { op: 'group_remove', key: ROOT, placements: 'delete' }
    ])
    const after = applyLayoutOps(target, plan.ops)
    expect(after.groups.map((x) => [x.key, x.parent_key])).toEqual([
      [ROOT, null],
      ['t1', ROOT]
    ])
    expect(after.placements.map((x) => x.field)).toEqual(['street'])
  })

  it('refuses a section that is not on the form', () => {
    expect(() => planLinkedReplace(libBlock(), form(), 'lib7_gone0000')).toThrow(/not on this form/)
  })

  it('JSON settings compare by meaning, not by spelling', () => {
    const a = extractSection(library(), 'address')
    const lib = library()
    lib.groups[0].visible_when = '[ { "field" : "kind" } ]'
    expect(sectionSignature(extractSection(lib, 'address'))).toBe(sectionSignature(a))
  })
})

describe('rebaseEdited', () => {
  it('on the library collection the edited copy is the new library section', () => {
    const edited = extractSection(form(), ROOT)
    expect(rebaseEdited(edited, libBlock(), false, (f) => f)).toBe(edited)
  })

  it('from another collection: names go back and library-only conditions are kept', () => {
    // The library is on orders; this form is on sites, street → line1.
    const map: Record<string, string> = { street: 'line1', city: 'town', zip: 'zip' }
    const mapped = mapBlock(libBlock(), (f) => map[f] ?? null, true).block
    expect(mapped.groups[0].patch.visible_when).toBeNull()
    const edited = {
      ...mapped,
      placements: [...mapped.placements, { field: 'region', group_key: 'address', patch: {} }]
    }
    const next = rebaseEdited(edited, libBlock(), true, (f) => map[f] ?? null)
    expect(next.placements.map((x) => x.field)).toEqual(['street', 'city', 'zip', 'region'])
    expect(next.groups[0].patch.visible_when).toBe('[{"field":"kind"}]')
  })
})

describe('reconcileLinks', () => {
  const row = (extra: Record<string, unknown>) =>
    ({
      id: 1,
      template_id: 7,
      layout_id: 2,
      group_key: ROOT,
      field_map: null,
      created_by: null,
      created_at: new Date('2026-10-29T10:00:00Z'),
      confirmed_at: null,
      synced_at: null,
      ...extra
    }) as never

  it('keeps an unsaved (pending) link for a while', async () => {
    const now = new Date('2026-10-29T12:00:00Z').getTime()
    const bundle = { ...form(), groups: form().groups.filter((x) => x.key !== ROOT) }
    expect(await reconcileLinks([row({})], bundle, now)).toHaveLength(1)
  })
})
