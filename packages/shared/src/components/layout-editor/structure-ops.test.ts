import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../lib/layout-ops'
import type { DesignTarget } from './design-context'
import { fieldZones, zoneItems } from './field-zones'
import { altArrowMove } from './keyboard-move'
import {
  convertChoices,
  copyRulesPlan,
  duplicateBlocked,
  duplicatePlan,
  fieldPinBlocked,
  fieldPinPlan,
  findHits,
  isPinned,
  isPlacementPinned,
  pinLocked,
  pinPlan,
  replacePlan,
  rulesOf,
  ruleTargets,
  type StructurePlan,
  unwrapPlan,
  withPin,
  wrapPlan
} from './structure-ops'
import { inverseOps } from './useLayoutDraft'

// #2623 duplicate, #2624 wrap/unwrap, #2625 convert, #2628 pin, #2643 copy rules, #2630 replace.

const place = (
  field: string,
  group: string | null,
  sort: number,
  over: Partial<PlacementRow> = {}
) => ({ ...newPlacement(field, group), sort, ...over })

const grp = (
  key: string,
  label: string,
  type: string,
  parent: string | null,
  sort: number,
  over: Partial<GroupRow> = {}
): GroupRow => ({ ...newGroup(key, label, type, parent), sort, ...over })

function bundle(): LayoutBundle {
  return {
    layout: { id: 1, collection: 'orders', name: 'Form', layout_type: 'grouped' },
    groups: [
      grp('main', 'Oracle details', 'section', null, 0, {
        hidden_for_roles: '["r1"]',
        is_collapsed: true
      }),
      grp('tabs', 'Details', 'container', null, 1, { tab_mode: 'tabs' }),
      grp('t1', 'Billing', 'tab', 'tabs', 0, { visible_when: '[{"field":"x","op":"eq"}]' }),
      grp('t2', 'Shipping', 'tab', 'tabs', 1),
      grp('note', 'Note', 'content', null, 2, { content: 'Ask Oracle first' }),
      ungroupedGroup(3)
    ],
    placements: [
      place('a', 'main', 0, { col_span: 6, overrides: { label: 'Oracle number', required: true } }),
      place('b', 'main', 1, { label_override: 'oracle ref' }),
      place('e', 't1', 0),
      place('f', 't2', 0, { overrides: { note: 'From Oracle' } }),
      place('u', null, 0),
      place('__comments__', null, 4)
    ],
    rev: 'r'
  }
}

const f = (field: string, group_key: string | null): DesignTarget => ({
  kind: 'field',
  field,
  group_key
})
const g = (key: string): DesignTarget => ({ kind: 'group', key })

const ok = (p: StructurePlan) => {
  if (!p.ok) throw new Error(`refused: ${p.reason}`)
  return p
}
const applied = (b: LayoutBundle, p: StructurePlan) => applyLayoutOps(b, ok(p).ops)
const top = (b: LayoutBundle) =>
  b.groups
    .filter((x) => x.parent_key === null)
    .sort((a, c) => a.sort - c.sort)
    .map((x) => x.key)
const kids = (b: LayoutBundle, key: string) =>
  b.groups
    .filter((x) => x.parent_key === key)
    .sort((a, c) => a.sort - c.sort)
    .map((x) => x.key)
const fields = (b: LayoutBundle, zone: string | null) => zoneItems(b, zone).map((p) => p.field)
const group = (b: LayoutBundle, key: string) => b.groups.find((x) => x.key === key) as GroupRow

/** Undo brings the bundle back: the inverse of the batch restores every row. */
function roundTrips(b: LayoutBundle, p: StructurePlan) {
  const plan = ok(p)
  const next = applyLayoutOps(b, plan.ops)
  const back = applyLayoutOps(next, inverseOps(b, plan.ops))
  const strip = (x: LayoutBundle) => ({
    groups: x.groups.map(({ id: _i, ...r }) => r),
    placements: x.placements.map(({ id: _i, ...r }) => r)
  })
  expect(strip(back)).toEqual(strip(applyLayoutOps(b, [])))
}

describe('duplicate in place (#2623)', () => {
  it('copies a section after itself with its settings and its fields’ settings', () => {
    const b = bundle()
    const plan = ok(duplicatePlan(b, g('main')))
    const next = applyLayoutOps(b, plan.ops)
    expect(top(next).slice(0, 2)).toEqual(['main', 'main_copy'])
    const copy = group(next, 'main_copy')
    expect(copy.label).toBe('Oracle details (copy)')
    expect(copy.hidden_for_roles).toBe('["r1"]')
    expect(copy.is_collapsed).toBe(true)
    expect(fields(next, 'main_copy')).toEqual(['a', 'b'])
    const a = next.placements.find((p) => p.field === 'a' && p.group_key === 'main_copy')
    expect(a?.col_span).toBe(6)
    expect(a?.overrides).toEqual({ label: 'Oracle number', required: true })
    expect(plan.notes[0]).toMatch(/2 fields now show in both/)
    expect(plan.select).toEqual(g('main_copy'))
    roundTrips(b, plan)
  })

  it('a holder brings its tabs and their fields; keys stay unique', () => {
    const b = bundle()
    const once = applied(b, duplicatePlan(b, g('tabs')))
    expect(kids(once, 'tabs_copy')).toEqual(['t1_copy', 't2_copy'])
    expect(fields(once, 't2_copy')).toEqual(['f'])
    const twice = applied(once, duplicatePlan(once, g('tabs')))
    expect(kids(twice, 'tabs_copy_2')).toEqual(['t1_copy_2', 't2_copy_2'])
  })

  it('the copy is never pinned', () => {
    const b = bundle()
    const pinned = applied(b, pinPlan(b, 'main', true))
    const next = applied(pinned, duplicatePlan(pinned, g('main')))
    expect(isPinned(group(next, 'main'))).toBe(true)
    expect(isPinned(group(next, 'main_copy'))).toBe(false)
  })

  it('a field, a page card or a header tile says why it cannot be duplicated', () => {
    const b = bundle()
    expect(duplicateBlocked(b, f('a', 'main'))).toMatch(/once per section/)
    expect(duplicateBlocked(b, { kind: 'slot', field: '__comments__', group_key: null })).toMatch(
      /once on a form/
    )
    expect(duplicateBlocked(b, { kind: 'header', field: 'a' })).toMatch(/header/)
    expect(duplicateBlocked(b, g('__ungrouped__'))).toMatch(/not a section/)
    expect(duplicateBlocked(b, g('parent_only'))).toMatch(/parent form/)
    expect(duplicatePlan(b, f('a', 'main')).ok).toBe(false)
  })
})

describe('wrap and unwrap (#2624)', () => {
  it('wraps fields from two places into a new section after the first one’s section', () => {
    const b = bundle()
    const plan = ok(wrapPlan(b, [f('u', null), f('b', 'main')]))
    const next = applyLayoutOps(b, plan.ops)
    expect(top(next).slice(0, 2)).toEqual(['main', 'section'])
    expect(fields(next, 'section')).toEqual(['b', 'u'])
    expect(fields(next, 'main')).toEqual(['a'])
    expect(plan.label).toBe('Wrap 2 fields in a new section')
    roundTrips(b, plan)
  })

  it('fields in a tab get a new tab beside it (a section cannot sit in a holder)', () => {
    const b = bundle()
    const next = applied(b, wrapPlan(b, [f('e', 't1')]))
    expect(kids(next, 'tabs')).toEqual(['t1', 'tab', 't2'])
    expect(group(next, 'tab').type).toBe('tab')
    expect(fields(next, 'tab')).toEqual(['e'])
  })

  it('needs a field selected', () => {
    expect(wrapPlan(bundle(), [g('main')]).ok).toBe(false)
  })

  it('unwrap keeps the fields where they were when Ungrouped is empty', () => {
    const b = bundle()
    b.placements = b.placements.filter((p) => p.field !== 'u')
    const plan = ok(unwrapPlan(b, 'main'))
    const next = applyLayoutOps(b, plan.ops)
    expect(top(next)[0]).toBe('__ungrouped__')
    expect(fields(next, null)).toEqual(['a', 'b'])
    expect(next.groups.some((x) => x.key === 'main')).toBe(false)
    roundTrips(b, plan)
  })

  it('unwrap appends to Ungrouped otherwise, and refuses a holder', () => {
    const b = bundle()
    const plan = ok(unwrapPlan(b, 't1'))
    expect(fields(applyLayoutOps(b, plan.ops), null)).toEqual(['u', 'e'])
    expect(plan.notes[0]).toMatch(/end of Ungrouped/)
    expect(unwrapPlan(b, 'tabs')).toMatchObject({ ok: false })
  })
})

describe('convert container type (#2625)', () => {
  const choice = (b: LayoutBundle, key: string, to: string) =>
    convertChoices(b, key).find((c) => c.to === to)?.plan as StructurePlan

  it('a section becomes a tab in a new holder in its place, keeping its fields', () => {
    const b = bundle()
    const plan = ok(choice(b, 'main', 'tab'))
    const next = applyLayoutOps(b, plan.ops)
    expect(top(next)[0]).toBe('tabs_2')
    expect(group(next, 'tabs_2').tab_mode).toBe('tabs')
    expect(kids(next, 'tabs_2')).toEqual(['main'])
    expect(fields(next, 'main')).toEqual(['a', 'b'])
    expect(plan.notes.join(' ')).toMatch(/Starts collapsed/)
    roundTrips(b, plan)
  })

  it('a section just below a matching holder joins it', () => {
    const b = bundle()
    group(b, 'main').sort = 1.5
    const next = applied(b, choice(b, 'main', 'tab'))
    expect(kids(next, 'tabs')).toEqual(['t1', 't2', 'main'])
  })

  it('one tab becoming a step turns all its siblings into steps (a holder shows one way)', () => {
    const b = bundle()
    const plan = ok(choice(b, 't1', 'step'))
    expect(plan.notes[0]).toMatch(/All 2 tabs of Details become steps/)
    expect(group(applyLayoutOps(b, plan.ops), 'tabs').tab_mode).toBe('steps')
  })

  it('a step becomes a section below its holder; an emptied holder goes', () => {
    const b = bundle()
    const plan = ok(choice(b, 't1', 'section'))
    const next = applyLayoutOps(b, plan.ops)
    expect(top(next).slice(0, 3)).toEqual(['main', 'tabs', 't1'])
    expect(group(next, 't1').type).toBe('section')
    expect(fields(next, 't1')).toEqual(['e'])
    expect(plan.notes.join(' ')).toMatch(/Only when/)
    const all = ok(choice(b, 'tabs', 'sections'))
    const flat = applyLayoutOps(b, all.ops)
    expect(top(flat).slice(0, 3)).toEqual(['main', 't1', 't2'])
    expect(flat.groups.some((x) => x.key === 'tabs')).toBe(false)
    roundTrips(b, all)
  })

  it('tabs at the top of the form switch with the form’s setting', () => {
    const b = bundle()
    b.groups.push(grp('top', 'Top', 'tab', null, 6))
    const plan = ok(choice(b, 'top', 'step'))
    expect(plan.ops).toEqual([{ op: 'layout_update', patch: { tab_mode: 'steps' } }])
  })

  it('record info and text blocks do not convert', () => {
    expect(convertChoices(bundle(), 'note')).toEqual([])
  })
})

describe('pin a section (#2628)', () => {
  it('stores an editor-only flag beside the swap settings', () => {
    const swap = '{"enabled":true,"primary_field":"a","alternate_fields":[]}'
    const on = withPin(swap, true) as string
    expect(JSON.parse(on)).toMatchObject({ enabled: true, editor_pinned: true })
    expect(JSON.parse(withPin(on, false) as string)).toEqual(JSON.parse(swap))
    expect(withPin(withPin(null, true), false)).toBeNull()
  })

  it('locks the section, its fields and a holder’s tabs against drag and drop', () => {
    const b = bundle()
    const next = applied(b, pinPlan(b, 'tabs', true))
    expect(pinLocked(next, g('tabs'))).toBe(true)
    expect(pinLocked(next, g('t1'))).toBe(true)
    expect(pinLocked(next, f('e', 't1'))).toBe(true)
    expect(pinLocked(next, f('a', 'main'))).toBe(false)
    expect(pinPlan(next, 'tabs', true).ok).toBe(false)
  })

  it('Alt+arrow neither moves a pinned section’s fields nor moves fields into it', () => {
    const b = bundle()
    const next = applied(b, pinPlan(b, 't1', true))
    expect(altArrowMove(next, f('e', 't1'), 'down')).toBeNull()
    expect(altArrowMove(next, g('t1'), 'right')).toBeNull()
    const m = altArrowMove(next, f('b', 'main'), 'right')
    expect(m?.next).toEqual(f('b', 't2'))
    expect(fieldZones(next).some((z) => z.key === 't1')).toBe(true)
  })
})

describe('pin a single field (#3203)', () => {
  it('stores the flag in the placement’s overrides, other keys kept; undo restores', () => {
    const b = bundle()
    const plan = ok(fieldPinPlan(b, f('a', 'main'), true))
    expect(plan.label).toBe('Pin A')
    const next = applyLayoutOps(b, plan.ops)
    const row = next.placements.find((p) => p.field === 'a' && p.group_key === 'main')
    expect(row?.overrides).toEqual({ label: 'Oracle number', required: true, editor_pinned: true })
    expect(isPlacementPinned(row)).toBe(true)
    expect(fieldPinPlan(next, f('a', 'main'), true).ok).toBe(false)
    const off = applyLayoutOps(next, ok(fieldPinPlan(next, f('a', 'main'), false)).ops)
    expect(off.placements.find((p) => p.field === 'a')?.overrides).toEqual({
      label: 'Oracle number',
      required: true
    })
    roundTrips(b, plan)
  })

  it('a pinned field neither drags nor takes drops; its section still does', () => {
    const b = bundle()
    const next = applied(b, fieldPinPlan(b, f('a', 'main'), true))
    expect(pinLocked(next, f('a', 'main'))).toBe(true)
    expect(pinLocked(next, f('b', 'main'))).toBe(false)
    expect(pinLocked(next, g('main'))).toBe(false)
  })

  it('Alt+arrow neither moves a pinned field nor swaps a neighbour past it', () => {
    const b = bundle()
    const next = applied(b, fieldPinPlan(b, f('a', 'main'), true))
    expect(altArrowMove(next, f('a', 'main'), 'down')).toBeNull()
    expect(altArrowMove(next, f('b', 'main'), 'up')).toBeNull()
    // Moving to another section is not a swap.
    expect(altArrowMove(next, f('b', 'main'), 'right')?.next).toEqual(f('b', 't1'))
  })

  it('a duplicated section’s copies are never pinned', () => {
    const b = bundle()
    const next = applied(b, fieldPinPlan(b, f('a', 'main'), true))
    const dup = applyLayoutOps(next, ok(duplicatePlan(next, g('main'))).ops)
    const copy = dup.placements.find((p) => p.field === 'a' && p.group_key === 'main_copy')
    expect(isPlacementPinned(copy)).toBe(false)
    expect(copy?.overrides).toEqual({ label: 'Oracle number', required: true })
  })

  it('needs a field this form owns', () => {
    const b = bundle()
    expect(fieldPinBlocked(b, g('main'))).toBe('Select a field first')
    expect(fieldPinBlocked(b, f('zz', 'main'))).toMatch(/parent form/)
  })
})

describe('copy rules to other sections (#2643)', () => {
  it('offers role rules on sections and step conditions on tabs', () => {
    const b = bundle()
    expect(rulesOf(group(b, 'main'))).toEqual(['hidden_for_roles', 'locked_for_roles'])
    expect(rulesOf(group(b, 't1'))).toContain('visible_when')
    expect(ruleTargets(b, 'main').map((x) => x.key)).toEqual(['t1', 't2'])
  })

  it('pastes onto several sections as one batch, skipping step rules on sections', () => {
    const b = bundle()
    const plan = ok(copyRulesPlan(b, 't1', ['t2', 'main'], ['visible_when', 'hidden_for_roles']))
    const next = applyLayoutOps(b, plan.ops)
    expect(group(next, 't2').visible_when).toBe(group(b, 't1').visible_when)
    expect(group(next, 'main').hidden_for_roles).toBeNull()
    expect(group(next, 'main').visible_when).toBeNull()
    expect(plan.notes.join(' ')).toMatch(/Step conditions skipped on 1 section/)
    roundTrips(b, plan)
  })

  it('nothing to change is refused', () => {
    const b = bundle()
    expect(copyRulesPlan(b, 't2', ['t2'], ['locked_for_roles']).ok).toBe(false)
  })
})

describe('find and replace in labels (#2630)', () => {
  const globals = [
    { field: 'e', label: 'Oracle line', note: null },
    { field: 'u', label: 'Unrelated', note: 'oracle sync' }
  ]

  it('finds section names, text blocks, labels and help text, case-insensitive', () => {
    const hits = findHits(bundle(), 'oracle', 'Fusion', { globals })
    expect(hits.map((h) => h.kind)).toEqual([
      'group_label',
      'text_block',
      'label',
      'label_override',
      'field_label',
      'help',
      'field_help'
    ])
    expect(hits.find((h) => h.kind === 'label_override')?.after).toBe('Fusion ref')
    expect(findHits(bundle(), 'ORACLE', 'Fusion', { matchCase: true, globals })).toHaveLength(0)
  })

  it('applies the chosen hits as one batch; a collection label becomes this form’s own', () => {
    const b = bundle()
    const hits = findHits(b, 'Oracle', '$& Fusion', { globals })
    const plan = ok(replacePlan(b, hits))
    const next = applyLayoutOps(b, plan.ops)
    expect(group(next, 'main').label).toBe('$& Fusion details')
    expect(group(next, 'note').content).toBe('Ask $& Fusion first')
    const pl = (field: string) => next.placements.find((p) => p.field === field)
    expect(pl('a')?.overrides).toEqual({ label: '$& Fusion number', required: true })
    expect(pl('e')?.overrides).toEqual({ label: '$& Fusion line' })
    expect(pl('u')?.overrides).toEqual({ note: '$& Fusion sync' })
    expect(plan.ops.filter((o) => o.op === 'update_placement')).toHaveLength(5)
    roundTrips(b, plan)
  })
})
