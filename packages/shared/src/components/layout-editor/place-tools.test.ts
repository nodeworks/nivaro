import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type GroupRow,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../lib/layout-ops'
import { gapSpot } from './add-target'
import type { DesignTarget } from './design-context'
import { looksLikeFieldList, matchFieldNames, parseFieldList, placeListPlan } from './field-list'
import { zoneItems } from './field-zones'
import { lookFrom, paintPlan } from './format-painter'
import { CLIP_MARKER, makeClip, parseClip, pastePlan, serializeClip } from './place-clip'
import { putBackPlan, removalsIn, stillRemoved } from './removed-log'
import { revertPlan } from './revert-element'

// #3179 copy/paste, #3181 slash gaps, #3191 recently removed, #3197 revert one,
// #3201 field lists, #3202 format painter.

const place = (
  field: string,
  group: string | null,
  sort: number,
  over: Partial<PlacementRow> = {}
): PlacementRow => ({ ...newPlacement(field, group), sort, ...over })

const grp = (
  key: string,
  label: string,
  type: string,
  parent: string | null,
  sort: number,
  over: Partial<GroupRow> = {}
): GroupRow => ({ ...newGroup(key, label, type, parent), sort, ...over })

function bundle(id = 1): LayoutBundle {
  return {
    layout: {
      id,
      collection: 'orders',
      name: id === 1 ? 'Form' : 'Other form',
      layout_type: 'grouped'
    },
    groups: [
      grp('main', 'Main', 'section', null, 0, { hidden_for_roles: '["r1"]', is_collapsed: true }),
      grp('tabs', 'Details', 'container', null, 1, { tab_mode: 'tabs' }),
      grp('t1', 'Billing', 'tab', 'tabs', 0),
      grp('t2', 'Shipping', 'tab', 'tabs', 1),
      ungroupedGroup(2)
    ],
    placements: [
      place('a', 'main', 0, { col_span: 6, overrides: { label: 'Alpha', required: true } }),
      place('b', 'main', 1, { overrides: { note: 'Bee help', readonly: true } }),
      place('e', 't1', 0),
      place('f', 't2', 0),
      place('u', null, 0),
      place('__comments__', null, 3)
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
const src = { collection: 'orders', layoutId: 1, layoutName: 'Form' }
const known = new Set(['a', 'b', 'e', 'f', 'u', 'x', 'y'])
const clipOf = (m: ReturnType<typeof makeClip>) => {
  if (!m.ok) throw new Error(m.reason)
  return m.clip
}
const ok = <T extends { ok: boolean }>(p: T) => {
  if (!p.ok) throw new Error((p as unknown as { reason: string }).reason)
  return p as Extract<T, { ok: true }>
}

describe('copy and paste (#3179)', () => {
  it('a clip round-trips through text and carries the marker', () => {
    const made = makeClip(bundle(), [f('a', 'main')], src)
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const text = serializeClip(made.clip)
    expect(text).toContain(CLIP_MARKER)
    expect(parseClip(text)).toEqual(made.clip)
    expect(parseClip('a, b, c')).toBeNull()
    expect(parseClip('{"marker":"other"}')).toBeNull()
  })

  it('a field pastes after the selection with every setting', () => {
    const clip = clipOf(makeClip(bundle(), [f('a', 'main')], src))
    const plan = ok(
      pastePlan(bundle(2), clip, {
        collection: 'orders',
        knownFields: known,
        selected: f('e', 't1')
      })
    )
    const after = applyLayoutOps(bundle(2), plan.ops)
    const row = after.placements.find((p) => p.field === 'a' && p.group_key === 't1')
    expect(row?.col_span).toBe(6)
    expect(row?.overrides).toEqual({ label: 'Alpha', required: true })
    expect(zoneItems(after, 't1').map((p) => p.field)).toEqual(['e', 'a'])
    expect(plan.select).toEqual(f('a', 't1'))
    expect(plan.notes).toContain('From Form')
  })

  it('a section pastes with its settings, tabs and fields; a holder brings its tabs', () => {
    const clip = clipOf(makeClip(bundle(), [g('tabs')], src))
    const target = bundle(2)
    target.groups = target.groups.filter((x) => !['tabs', 't1', 't2'].includes(x.key))
    target.placements = target.placements.filter((p) => !['e', 'f'].includes(p.field))
    const plan = ok(
      pastePlan(target, clip, { collection: 'orders', knownFields: known, selected: g('main') })
    )
    const after = applyLayoutOps(target, plan.ops)
    expect(after.groups.find((x) => x.key === 'tabs')?.tab_mode).toBe('tabs')
    expect(after.groups.filter((x) => x.parent_key === 'tabs').map((x) => x.key)).toEqual([
      't1',
      't2'
    ])
    expect(zoneItems(after, 't2').map((p) => p.field)).toEqual(['f'])
  })

  it('pasting a section into the same form keys and labels it as a copy', () => {
    const clip = clipOf(makeClip(bundle(), [g('main')], src))
    const plan = ok(
      pastePlan(bundle(), clip, { collection: 'orders', knownFields: known, selected: g('main') })
    )
    const create = plan.ops[0]
    expect(create).toMatchObject({ op: 'group_create', key: 'main_2', label: 'Main (copy)' })
    expect((create as { patch: { hidden_for_roles: string } }).patch.hidden_for_roles).toBe(
      '["r1"]'
    )
  })

  it('refuses another collection with a clear message', () => {
    const clip = clipOf(makeClip(bundle(), [f('a', 'main')], src))
    const plan = pastePlan(bundle(), clip, {
      collection: 'invoices',
      knownFields: null,
      selected: null
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toMatch(/Orders form.*same collection/)
  })

  it('skips and lists fields the target collection does not have', () => {
    const clip = clipOf(makeClip(bundle(), [f('a', 'main'), f('b', 'main')], src))
    const plan = ok(
      pastePlan(bundle(2), clip, {
        collection: 'orders',
        knownFields: new Set(['b', 'e']),
        selected: f('e', 't1')
      })
    )
    expect(plan.ops).toHaveLength(1)
    expect(plan.skipped).toEqual(['A'])
    expect(plan.notes.join(' ')).toMatch(/Not in this collection, skipped: A/)
  })

  it('a field already in the target section is refused, naming the section', () => {
    const clip = clipOf(makeClip(bundle(), [f('a', 'main')], src))
    const plan = pastePlan(bundle(), clip, {
      collection: 'orders',
      knownFields: known,
      selected: f('b', 'main')
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toMatch(/already in Main/)
  })
})

describe('field lists (#3201)', () => {
  const fields = [
    { field: 'po_number', label: 'PO number' },
    { field: 'vendor', label: 'Vendor' },
    { field: 'status', label: null },
    { field: 'due_date', label: 'Due date' }
  ]

  it('parses lines, commas, bullets and quotes, once each', () => {
    expect(parseFieldList('- PO number\n2. "Vendor", status;status\tdue_date')).toEqual([
      'PO number',
      'Vendor',
      'status',
      'due_date'
    ])
    expect(looksLikeFieldList('vendor, status')).toBe(true)
    expect(looksLikeFieldList('{"a":1}')).toBe(false)
    expect(
      looksLikeFieldList('this is a long sentence that someone pasted from somewhere else ok')
    ).toBe(false)
  })

  it('matches keys, labels and squashed spellings; lists the rest', () => {
    const m = matchFieldNames(['PO-Number', 'vendor', 'Status', 'nope', 'due date'], fields)
    expect(m.matched.map((x) => x.field)).toEqual(['po_number', 'vendor', 'status', 'due_date'])
    expect(m.unmatched).toEqual(['nope'])
  })

  it('places the matched fields in order after the selection, in one batch', () => {
    const b = bundle()
    const plan = placeListPlan(
      b,
      'x\ny\nnope\na',
      [...fields, { field: 'x' }, { field: 'y' }, { field: 'a' }],
      f('a', 'main')
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const after = applyLayoutOps(b, plan.ops)
    expect(zoneItems(after, 'main').map((p) => p.field)).toEqual(['a', 'x', 'y', 'b'])
    expect(plan.unmatched).toEqual(['nope'])
    expect(plan.already).toEqual(['A'])
  })
})

describe('format painter (#3202)', () => {
  it('copies look and rules, keeps the target’s label and help', () => {
    const b = bundle()
    b.placements.push(place('c', 'main', 2, { overrides: { label: 'Sea', note: 'C help' } }))
    const look = lookFrom(b, f('a', 'main'))
    expect(look).not.toBeNull()
    const plan = ok(paintPlan(b, look as never, [f('b', 'main'), f('c', 'main')]))
    const after = applyLayoutOps(b, plan.ops)
    const c = after.placements.find((p) => p.field === 'c')
    expect(c?.col_span).toBe(6)
    expect(c?.overrides).toEqual({ label: 'Sea', note: 'C help', required: true })
    const bb = after.placements.find((p) => p.field === 'b')
    // b's own help stays; its readonly goes (a has none) and required comes.
    expect(bb?.overrides).toEqual({ note: 'Bee help', required: true })
    expect(plan.label).toMatch(/onto 2 fields/)
  })

  it('panels keep their own look; nothing to paint says so', () => {
    const b = bundle()
    const look = lookFrom(b, f('a', 'main')) as never
    const plan = paintPlan(b, look, [{ kind: 'slot', field: '__comments__', group_key: null }])
    expect(plan.ok).toBe(false)
  })
})

describe('revert one element (#3197)', () => {
  it('a field’s settings and place come back as saved; the rest stays', () => {
    const saved = bundle()
    const cur = applyLayoutOps(saved, [
      { op: 'update_placement', at: { field: 'a', group_key: 'main' }, patch: { col_span: 12 } },
      { op: 'move', from: { field: 'a', group_key: 'main' }, to_group_key: 'main', index: 1 },
      { op: 'update_placement', at: { field: 'b', group_key: 'main' }, patch: { col_span: 4 } }
    ])
    const plan = ok(revertPlan(cur, saved, f('a', 'main')))
    const after = applyLayoutOps(cur, plan.ops)
    expect(after.placements.find((p) => p.field === 'a')?.col_span).toBe(6)
    expect(zoneItems(after, 'main').map((p) => p.field)).toEqual(['a', 'b'])
    expect(after.placements.find((p) => p.field === 'b')?.col_span).toBe(4)
  })

  it('a field moved to another section goes back', () => {
    const saved = bundle()
    const cur = applyLayoutOps(saved, [
      { op: 'move', from: { field: 'a', group_key: 'main' }, to_group_key: 't1', index: 0 }
    ])
    const plan = ok(revertPlan(cur, saved, f('a', 't1')))
    const after = applyLayoutOps(cur, plan.ops)
    expect(zoneItems(after, 'main').map((p) => p.field)).toEqual(['a', 'b'])
    expect(plan.select).toEqual(f('a', 'main'))
  })

  it('a field or section added since comes off; a new section’s moved fields go home', () => {
    const saved = bundle()
    const cur = applyLayoutOps(saved, [
      { op: 'place', field: 'x', group_key: 'main', index: 2 },
      {
        op: 'group_create',
        key: 'new',
        label: 'New',
        group_type: 'section',
        parent_key: null,
        index: 1
      },
      { op: 'move', from: { field: 'b', group_key: 'main' }, to_group_key: 'new', index: 0 }
    ])
    const x = ok(revertPlan(cur, saved, f('x', 'main')))
    expect(x.label).toMatch(/^Take X off/)
    const sec = ok(revertPlan(cur, saved, g('new')))
    const after = applyLayoutOps(cur, sec.ops)
    expect(after.groups.some((x) => x.key === 'new')).toBe(false)
    expect(zoneItems(after, 'main').map((p) => p.field)).toEqual(['a', 'b', 'x'])
  })

  it('nothing differs: refused', () => {
    expect(revertPlan(bundle(), bundle(), f('a', 'main')).ok).toBe(false)
  })
})

describe('recently removed (#3191)', () => {
  it('a removed field is logged and put back where it was', () => {
    const before = bundle()
    const ops = [{ op: 'remove', at: { field: 'a', group_key: 'main' } }] as const
    const [entry] = removalsIn(before, [...ops], 'Remove A')
    expect(entry.piece).toEqual({ kind: 'field', field: 'a', group_key: 'main' })
    const now = applyLayoutOps(before, [...ops])
    expect(stillRemoved(now, entry)).toBe(true)
    const plan = ok(putBackPlan(now, entry, null))
    const back = applyLayoutOps(now, plan.ops)
    expect(zoneItems(back, 'main').map((p) => p.field)).toEqual(['a', 'b'])
    expect(back.placements.find((p) => p.field === 'a')?.col_span).toBe(6)
    expect(stillRemoved(back, entry)).toBe(false)
  })

  it('a section removed with its tabs is one entry, and comes back whole', () => {
    const before = bundle()
    const ops = [
      { op: 'group_remove', key: 't1', placements: 'delete' },
      { op: 'group_remove', key: 't2', placements: 'delete' },
      { op: 'group_remove', key: 'tabs', placements: 'delete' }
    ] as never
    const found = removalsIn(before, ops, 'Trash')
    expect(found.map((e) => e.piece)).toEqual([{ kind: 'group', key: 'tabs' }])
    const now = applyLayoutOps(before, ops)
    const back = applyLayoutOps(now, ok(putBackPlan(now, found[0], null)).ops)
    expect(back.groups.filter((x) => x.parent_key === 'tabs').map((x) => x.key)).toEqual([
      't1',
      't2'
    ])
    expect(zoneItems(back, 't1').map((p) => p.field)).toEqual(['e'])
  })

  it('a field whose section is gone goes after the selection instead', () => {
    const before = bundle()
    const [entry] = removalsIn(before, [{ op: 'remove', at: { field: 'e', group_key: 't1' } }], 'x')
    const now = applyLayoutOps(before, [
      { op: 'remove', at: { field: 'e', group_key: 't1' } },
      { op: 'group_remove', key: 't1', placements: 'delete' }
    ])
    const plan = ok(putBackPlan(now, entry, f('a', 'main')))
    expect(plan.notes[0]).toMatch(/section is gone/)
    expect(zoneItems(applyLayoutOps(now, plan.ops), 'main').map((p) => p.field)).toEqual([
      'a',
      'e',
      'b'
    ])
  })

  it('moves are not removals', () => {
    expect(
      removalsIn(
        bundle(),
        [{ op: 'move', from: { field: 'a', group_key: 'main' }, to_group_key: 't1', index: 0 }],
        'x'
      )
    ).toEqual([])
  })
})

describe('slash gaps (#3181)', () => {
  it('before / after a field, the end of a section, a holder’s first tab, beside a panel', () => {
    const b = bundle()
    expect(gapSpot(b, f('b', 'main'), true)).toEqual({ top: false, group_key: 'main', index: 1 })
    expect(gapSpot(b, f('b', 'main'), false)).toEqual({ top: false, group_key: 'main', index: 2 })
    expect(gapSpot(b, g('main'), false)).toEqual({ top: false, group_key: 'main', index: 2 })
    expect(gapSpot(b, g('tabs'), false)).toEqual({ top: false, group_key: 't1', index: 1 })
    expect(gapSpot(b, { kind: 'header', field: 'zz' }, false)).toBeNull()
    const slot = gapSpot(b, { kind: 'slot', field: '__comments__', group_key: null }, false)
    expect(slot?.top).toBe(true)
  })

  it('a header tile gap is in the header strip', () => {
    const b = bundle()
    b.placements.push(place('a', HEADER_GROUP_KEY, 0))
    expect(gapSpot(b, { kind: 'header', field: 'a' }, false)).toEqual({
      top: false,
      group_key: HEADER_GROUP_KEY,
      index: 1
    })
  })
})
