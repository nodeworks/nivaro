import { describe, expect, it } from 'vitest'
import {
  BlockError,
  blockFields,
  extractForm,
  extractSection,
  freshKey,
  mapBlock,
  parseBlock,
  planBlock
} from '../../../services/layout-blocks.js'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../../services/layout-ops-apply.js'

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

function source(): LayoutBundle {
  return {
    layout: { id: 1, collection: 'orders', layout_type: 'grouped', tab_mode: 'steps', name: 'A' },
    groups: [
      g('address', 0, {
        icon: 'home',
        summary_fields: JSON.stringify(['street', { field: 'city', label: 'Town' }, 'zip']),
        visible_when: JSON.stringify([{ field: 'kind', op: 'eq', value: 'x' }])
      }),
      g('tabs', 1, { type: 'container' }),
      g('t1', 0, { type: 'tab', parent_key: 'tabs' }),
      g('t2', 1, { type: 'tab', parent_key: 'tabs' }),
      ungroupedGroup(2)
    ],
    placements: [
      p('street', 'address', 0, { label_override: 'Street line' }),
      p('city', 'address', 1, { col_span: 6, lock_conditions: '[{"field":"kind"}]' }),
      p('zip', 'address', 2),
      p('notes', 't1', 0),
      p('owner', 't2', 0),
      p('loose', null, 0),
      p('__comments__', null, 3),
      p('title', '__header__', 0)
    ],
    rev: 'r1'
  }
}

function emptyTarget(collection = 'orders'): LayoutBundle {
  return {
    layout: { id: 2, collection, layout_type: 'grouped' },
    groups: [ungroupedGroup(0)],
    placements: [],
    rev: 'r2'
  }
}

describe('extractSection', () => {
  it('copies one section with its fields and settings, by field name', () => {
    const b = extractSection(source(), 'address')
    expect(b.kind).toBe('section')
    expect(b.groups).toEqual([
      expect.objectContaining({ key: 'address', parent_key: null, type: 'section' })
    ])
    expect(b.groups[0].patch.icon).toBe('home')
    expect(b.groups[0].patch).not.toHaveProperty('label')
    expect(b.placements.map((x) => x.field)).toEqual(['street', 'city', 'zip'])
    expect(b.placements[0].patch.label_override).toBe('Street line')
    expect(JSON.stringify(b)).not.toContain('"id"')
  })

  it('a container carries its tabs and their fields; a lone tab becomes a section', () => {
    const c = extractSection(source(), 'tabs')
    expect(c.groups.map((x) => [x.key, x.parent_key, x.type])).toEqual([
      ['tabs', null, 'container'],
      ['t1', 'tabs', 'tab'],
      ['t2', 'tabs', 'tab']
    ])
    expect(blockFields(c)).toEqual(['notes', 'owner'])
    const t = extractSection(source(), 't2')
    expect(t.groups).toEqual([expect.objectContaining({ key: 't2', parent_key: null })])
    expect(t.groups[0].type).toBe('section')
  })

  it('refuses the Ungrouped zone and unknown keys', () => {
    expect(() => extractSection(source(), '__ungrouped__')).toThrow(BlockError)
    expect(() => extractSection(source(), 'nope')).toThrow(BlockError)
  })
})

describe('planBlock', () => {
  it('lands a section on another layout under a fresh key, applying cleanly', () => {
    const target = emptyTarget()
    target.groups.push(g('address', 0))
    target.placements.push(p('zip', 'address', 0))
    const plan = planBlock(extractSection(source(), 'address'), target)
    expect(plan.keys).toEqual({ address: 'address_2' })
    expect(plan.already).toEqual(['zip'])
    const after = applyLayoutOps(target, plan.ops)
    expect(after.groups.find((x) => x.key === 'address_2')?.icon).toBe('home')
    expect(after.placements.filter((x) => x.group_key === 'address_2').map((x) => x.field)).toEqual(
      ['street', 'city']
    )
  })

  it('a whole form round-trips through extractForm → planBlock on an empty layout', () => {
    const src = source()
    const block = parseBlock(JSON.stringify(extractForm(src)))
    expect(block).not.toBeNull()
    const plan = planBlock(block!, emptyTarget(), { settings: true })
    const after = applyLayoutOps(emptyTarget(), plan.ops)
    const shape = (b: LayoutBundle) => ({
      groups: b.groups.map((x) => [x.key, x.parent_key, x.type, x.sort]),
      placements: b.placements.map((x) => [x.field, x.group_key, x.sort])
    })
    expect(shape(after)).toEqual(shape(applyLayoutOps(src, [])))
    expect(after.layout.tab_mode).toBe('steps')
  })

  it('places a section block at a chosen top-level index', () => {
    const target = emptyTarget()
    target.groups.push(g('a', 0), g('b', 1))
    const plan = planBlock(extractSection(source(), 'address'), target, { index: 1 })
    const after = applyLayoutOps(target, plan.ops)
    const top = after.groups
      .filter((x) => x.parent_key === null && x.key !== '__ungrouped__')
      .sort((x, y) => x.sort - y.sort)
    expect(top.map((x) => x.key)).toEqual(['a', 'address', 'b'])
  })

  it('freshKey never hands out a taken or reserved key', () => {
    const taken = new Set(['x', 'x_2'])
    expect(freshKey('x', taken)).toBe('x_3')
    expect(freshKey('__y', taken)).toBe('y')
  })
})

describe('mapBlock', () => {
  it('renames fields, leaves unmapped ones out and keeps slot cards', () => {
    const block = extractForm(source())
    const names: Record<string, string> = { street: 'line1', city: 'town', notes: 'notes' }
    const m = mapBlock(block, (f) => names[f] ?? null, true)
    expect(m.unmapped.sort()).toEqual(['loose', 'owner', 'title', 'zip'])
    expect(blockFields(m.block)).toEqual(['line1', 'town', 'notes'])
    expect(m.block.placements.some((x) => x.field === '__comments__')).toBe(true)
    const addr = m.block.groups.find((x) => x.key === 'address')!
    expect(JSON.parse(addr.patch.summary_fields as string)).toEqual([
      'line1',
      { field: 'town', label: 'Town' }
    ])
    // Across collections, settings written in the source's own field terms go.
    expect(addr.patch.visible_when).toBeNull()
    expect(m.dropped.sort()).toEqual(['lock_conditions', 'visible_when'])
  })

  it('within one collection keeps every setting', () => {
    const m = mapBlock(extractSection(source(), 'address'), (f) => f, false)
    expect(m.dropped).toEqual([])
    expect(m.block.groups[0].patch.visible_when).toContain('kind')
  })
})

describe('parseBlock', () => {
  it('refuses anything malformed', () => {
    expect(parseBlock('nope')).toBeNull()
    expect(parseBlock({ kind: 'other', groups: [], placements: [], top: [] })).toBeNull()
    expect(parseBlock({ kind: 'section', groups: [{}], placements: [], top: [] })).toBeNull()
  })

  it('drops unknown settings keys', () => {
    const b = parseBlock({
      kind: 'section',
      groups: [{ key: 'a', label: 'A', type: 'section', patch: { icon: 'x', evil: 1 } }],
      placements: [{ field: 'f', group_key: 'a', patch: { col_span: 6, id: 9 } }],
      top: [{ group: 'a' }]
    })
    expect(b?.groups[0].patch).toEqual({ icon: 'x' })
    expect(b?.placements[0].patch).toEqual({ col_span: 6 })
  })
})
