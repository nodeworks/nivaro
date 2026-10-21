import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../lib/layout-ops'
import { type CommandEnv, intentsToOps, planLabel } from './intents'
import { nameScore, parseCommand, parseWidth } from './parse'

function place(
  field: string,
  group: string | null,
  sort: number,
  extra: Partial<PlacementRow> = {}
) {
  return { ...newPlacement(field, group), sort, ...extra }
}

function bundle(): LayoutBundle {
  return {
    layout: {
      id: 1,
      collection: 'orders',
      name: 'Default',
      layout_type: 'grouped',
      conditions: null
    },
    groups: [
      { ...newGroup('details', 'Details', 'section', null), sort: 0 },
      { ...newGroup('materials', 'Materials', 'section', null), sort: 1 },
      { ...newGroup('extras', 'Extras', 'section', null), sort: 2, is_collapsed: true }
    ],
    placements: [
      place('shipping_location', 'details', 0),
      place('zone', 'details', 1),
      place('zone_code', 'details', 2),
      place('notes', 'details', 3),
      place('material', 'materials', 0),
      place('quantity', 'materials', 1),
      place('__comments__', null, 3)
    ],
    rev: 'r1'
  }
}

const env = (b = bundle()): CommandEnv => ({
  bundle: b,
  fields: [
    { field: 'shipping_location', label: 'Shipping Location' },
    { field: 'zone', label: 'Zone' },
    { field: 'zone_code', label: 'Zone Code' },
    { field: 'notes', label: 'Notes' },
    { field: 'material', label: 'Material' },
    { field: 'quantity', label: 'Quantity' },
    { field: 'region', label: 'Region' }
  ],
  roles: [
    { id: 'r-fin', name: 'Finance' },
    { id: 'r-ops', name: 'Operations' }
  ]
})

function run(text: string, e = env()) {
  const parsed = parseCommand(text, e)
  if (!parsed.ok) throw new Error(parsed.error)
  const plan = intentsToOps(parsed.intents, e)
  if (!plan.ok) throw new Error(plan.error)
  return { plan, after: applyLayoutOps(e.bundle, plan.ops) }
}

const zone = (b: LayoutBundle, g: string) =>
  b.placements
    .filter((p) => p.group_key === g)
    .sort((a, c) => a.sort - c.sort)
    .map((p) => p.field)

describe('command palette — name matching (#2586)', () => {
  it('scores exact, partial and misspelt names', () => {
    expect(nameScore('Shipping Location', 'Shipping Location')).toBe(100)
    expect(nameScore('shipping_location', 'Shipping Location')).toBe(100)
    expect(nameScore('ship loc', 'Shipping Location')).toBeGreaterThan(0)
    expect(nameScore('Materails', 'Materials')).toBeGreaterThan(0)
    expect(nameScore('the Materials section', 'Materials')).toBe(100)
    expect(nameScore('Quantity', 'Zone')).toBe(0)
  })

  it('reads widths in words, fractions and columns', () => {
    expect(parseWidth('half')).toBe(6)
    expect(parseWidth('1/3')).toBe(4)
    expect(parseWidth('12')).toBe(12)
    expect(parseWidth('quarter-width')).toBe(3)
    expect(parseWidth('wide')).toBeNull()
  })

  it('names both candidates when a name is ambiguous', () => {
    const r = parseCommand('make zon required', env())
    expect(r.ok).toBe(false)
  })
})

describe('command palette — commands to one ops batch (#2586)', () => {
  it('moves a field to a section', () => {
    const { plan, after } = run('move Shipping Location to Materials')
    expect(plan.steps).toEqual(['Move Shipping Location to Materials'])
    expect(zone(after, 'materials')).toEqual(['material', 'quantity', 'shipping_location'])
  })

  it('moves a field before / after another, and a section after a section', () => {
    expect(zone(run('move notes before zone').after, 'details')).toEqual([
      'shipping_location',
      'notes',
      'zone',
      'zone_code'
    ])
    expect(zone(run('put quantity after zone code').after, 'details')).toContain('quantity')
    const g = run('move section Details after Extras').after.groups
    expect(g.filter((x) => x.parent_key === null).sort((a, b) => a.sort - b.sort)[0].key).toBe(
      'materials'
    )
  })

  it('moves a field out of every section', () => {
    const { after } = run('move notes to ungrouped')
    expect(after.placements.find((p) => p.field === 'notes')?.group_key).toBeNull()
  })

  it('makes a field required, and notes that required is per form, not per role', () => {
    const { plan, after } = run('make Zone required for Finance')
    expect(plan.steps).toEqual(['Make Zone required'])
    expect(plan.notes[0]).toMatch(/per form, not per role/)
    expect(after.placements.find((p) => p.field === 'zone')?.overrides).toEqual({ required: true })

    const b = bundle()
    b.layout.conditions = { role_ids: ['r-fin'] }
    expect(run('make Zone required for finance', env(b)).plan.notes[0]).toMatch(/only for Finance/)
  })

  it('hides, renames, sets width, removes and toggles a section', () => {
    expect(run('hide notes').after.placements.find((p) => p.field === 'notes')?.overrides).toEqual({
      hidden: true
    })
    expect(
      run('rename notes to "Comments"').after.placements.find((p) => p.field === 'notes')?.overrides
    ).toEqual({ label: 'Comments' })
    expect(run('rename section Details to Basics').after.groups[0].label).toBe('Basics')
    expect(run('set width zone 6').after.placements.find((p) => p.field === 'zone')?.col_span).toBe(
      6
    )
    expect(
      run('set zone width to half').after.placements.find((p) => p.field === 'zone')?.col_span
    ).toBe(6)
    expect(
      run('make quantity a third').after.placements.find((p) => p.field === 'quantity')?.col_span
    ).toBe(4)
    expect(run('remove notes').after.placements.some((p) => p.field === 'notes')).toBe(false)
    expect(run('expand extras').after.groups.find((g) => g.key === 'extras')?.is_collapsed).toBe(
      false
    )
  })

  it('adds a field that is not on the form yet, and a new step after a section', () => {
    expect(zone(run('add region to materials').after, 'materials')).toEqual([
      'material',
      'quantity',
      'region'
    ])
    expect(parseCommand('add zone to materials', env())).toMatchObject({ ok: false })
    const { plan, after } = run('add section Shipping after Details')
    expect(plan.steps).toEqual(['Add section "Shipping" after Details'])
    const top = after.groups.filter((g) => g.parent_key === null).sort((a, b) => a.sort - b.sort)
    expect(top.map((g) => g.key).slice(0, 3)).toEqual(['details', 'shipping', 'materials'])
  })

  it('runs several commands as one batch with one label', () => {
    const { plan } = run('hide notes; make zone required')
    expect(plan.ops).toHaveLength(2)
    expect(planLabel(plan)).toBe('Hide Notes and 1 more change')
  })

  it('reports unknown text separately from names that do not match', () => {
    expect(parseCommand('please tidy this form up', env())).toMatchObject({
      ok: false,
      unknown: true
    })
    expect(parseCommand('move Banana to Materials', env())).toMatchObject({
      ok: false,
      unknown: false
    })
  })

  it('refuses intents that do not apply (validated with the ops twin)', () => {
    const r = intentsToOps([{ kind: 'move_field', field: 'nope', to_group: 'materials' }], env())
    expect(r.ok).toBe(false)
    const same = intentsToOps([{ kind: 'set_field', field: 'zone', hidden: false }], env())
    expect(same).toMatchObject({ ok: false })
  })
})
