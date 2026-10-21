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
import { restorablePieces, restorePieceOps, summarizeOps } from './restore-piece'

const group = (key: string, sort: number, extra: Partial<GroupRow> = {}): GroupRow => ({
  ...newGroup(key, key[0].toUpperCase() + key.slice(1), 'section', null),
  sort,
  ...extra
})
const placed = (
  field: string,
  groupKey: string | null,
  sort: number,
  extra: Partial<PlacementRow> = {}
): PlacementRow => ({ ...newPlacement(field, groupKey), sort, ...extra })
const bundle = (groups: GroupRow[], placements: PlacementRow[], layout = {}): LayoutBundle => ({
  layout: { id: 1, collection: 'orders', name: 'Main', layout_type: 'grouped', ...layout },
  groups: [...groups, ungroupedGroup(groups.length)],
  placements,
  rev: 'r'
})
const fieldsIn = (b: LayoutBundle, key: string | null) =>
  b.placements
    .filter((p) => p.group_key === key)
    .sort((a, c) => a.sort - c.sort)
    .map((p) => p.field)
const at = (b: LayoutBundle, field: string, key: string | null) =>
  b.placements.find((p) => p.field === field && p.group_key === key)

// The version: Main [title, status, notes] + Money [amount, tax].
const version = bundle(
  [group('main', 0, { label: 'Basics' }), group('money', 1, { is_collapsed: true })],
  [
    placed('title', 'main', 0, { col_span: 12 }),
    placed('status', 'main', 1),
    placed('notes', 'main', 2),
    placed('amount', 'money', 0, { label_override: 'Total' }),
    placed('tax', 'money', 1)
  ]
)

describe('restorePieceOps — a field', () => {
  it('brings back the settings of a field still in place', () => {
    const current = bundle(
      [group('main', 0), group('money', 1)],
      [placed('title', 'main', 0), placed('amount', 'money', 0, { label_override: 'Total' })]
    )
    const ops = restorePieceOps(current, version, {
      kind: 'field',
      field: 'title',
      group_key: 'main'
    })
    expect(ops).toEqual([
      { op: 'update_placement', at: { field: 'title', group_key: 'main' }, patch: { col_span: 12 } }
    ])
    expect(
      restorePieceOps(current, version, { kind: 'field', field: 'amount', group_key: 'money' })
    ).toEqual([])
  })

  it('places a removed field back in its section with its settings, at the version’s spot', () => {
    const current = bundle(
      [group('main', 0), group('money', 1)],
      [placed('title', 'main', 0), placed('notes', 'main', 1), placed('amount', 'money', 0)]
    )
    const ops = restorePieceOps(current, version, {
      kind: 'field',
      field: 'status',
      group_key: 'main'
    })
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ op: 'place', field: 'status', group_key: 'main', index: 1 })
    const after = applyLayoutOps(current, ops)
    expect(fieldsIn(after, 'main')).toEqual(['title', 'status', 'notes'])
  })

  it('moves a field back from another section and restores its settings', () => {
    const current = bundle(
      [group('main', 0), group('money', 1)],
      [placed('title', 'main', 0), placed('amount', 'main', 1), placed('tax', 'money', 0)]
    )
    const ops = restorePieceOps(current, version, {
      kind: 'field',
      field: 'amount',
      group_key: 'money'
    })
    expect(ops.map((o) => o.op)).toEqual(['move', 'update_placement'])
    const after = applyLayoutOps(current, ops)
    expect(fieldsIn(after, 'money')).toEqual(['amount', 'tax'])
    expect(at(after, 'amount', 'money')?.label_override).toBe('Total')
    expect(summarizeOps(ops, { kind: 'field', field: 'amount', group_key: 'money' })).toBe(
      'Moves back · 1 setting'
    )
  })

  it('says so when the field’s section is gone', () => {
    const current = bundle([group('main', 0)], [placed('title', 'main', 0)])
    expect(() =>
      restorePieceOps(current, version, { kind: 'field', field: 'tax', group_key: 'money' })
    ).toThrow(/section “Money” is not on the form/)
  })
})

describe('restorePieceOps — a section', () => {
  it('recreates a removed section with its settings and fields, in the version’s order', () => {
    const current = bundle(
      [group('main', 0)],
      [placed('title', 'main', 0), placed('tax', 'main', 1)]
    )
    const piece = { kind: 'group', key: 'money' } as const
    const ops = restorePieceOps(current, version, piece)
    expect(ops[0]).toMatchObject({
      op: 'group_create',
      key: 'money',
      group_type: 'section',
      parent_key: null,
      index: 1,
      patch: { is_collapsed: true }
    })
    const after = applyLayoutOps(current, ops)
    expect(after.groups.find((g) => g.key === 'money')?.is_collapsed).toBe(true)
    expect(fieldsIn(after, 'money')).toEqual(['amount', 'tax'])
    // `tax` left Main for Money: the version had it there.
    expect(fieldsIn(after, 'main')).toEqual(['title'])
    expect(at(after, 'amount', 'money')?.label_override).toBe('Total')
    expect(summarizeOps(ops, piece)).toBe('Back on the form · 1 field back · 1 field moved in')
  })

  it('restores an existing section exactly: settings, strays removed, order', () => {
    const current = bundle(
      [group('main', 0), group('money', 1)],
      [
        placed('notes', 'main', 0),
        placed('title', 'main', 1),
        placed('owner', 'main', 2),
        placed('status', 'main', 3),
        placed('amount', 'money', 0, { label_override: 'Total' }),
        placed('tax', 'money', 1)
      ]
    )
    const piece = { kind: 'group', key: 'main' } as const
    const ops = restorePieceOps(current, version, piece)
    const after = applyLayoutOps(current, ops)
    expect(after.groups.find((g) => g.key === 'main')?.label).toBe('Basics')
    expect(fieldsIn(after, 'main')).toEqual(['title', 'status', 'notes'])
    expect(at(after, 'title', 'main')?.col_span).toBe(12)
    expect(at(after, 'owner', 'main')).toBeUndefined()
    // Money untouched.
    expect(fieldsIn(after, 'money')).toEqual(['amount', 'tax'])
    expect(summarizeOps(ops, piece)).toBe('1 section setting · 1 field removed · 1 field setting')
  })

  it('a section that already matches needs no ops', () => {
    expect(restorePieceOps(version, version, { kind: 'group', key: 'money' })).toEqual([])
  })

  it('brings a container back with its tabs', () => {
    const v = bundle(
      [
        { ...newGroup('box', 'Box', 'container', null), sort: 0 },
        { ...newGroup('t1', 'One', 'tab', 'box'), sort: 0 },
        { ...newGroup('t2', 'Two', 'tab', 'box'), sort: 1 }
      ],
      [placed('title', 't1', 0), placed('notes', 't2', 0)]
    )
    const current = bundle([], [placed('title', null, 0), placed('notes', null, 1)])
    const ops = restorePieceOps(current, v, { kind: 'group', key: 'box' })
    const after = applyLayoutOps(current, ops)
    expect(after.groups.map((g) => [g.key, g.parent_key])).toEqual(
      expect.arrayContaining([
        ['box', null],
        ['t1', 'box'],
        ['t2', 'box']
      ])
    )
    expect(fieldsIn(after, 't1')).toEqual(['title'])
    expect(fieldsIn(after, 't2')).toEqual(['notes'])
    expect(summarizeOps(ops, { kind: 'group', key: 'box' })).toBe(
      'Back on the form · 2 tabs · 2 fields moved in'
    )
  })
})

describe('restorablePieces', () => {
  it('lists only what differs, sections first, with labels and where', () => {
    const current = bundle(
      [group('main', 0, { label: 'Basics' })],
      [
        placed('title', 'main', 0, { col_span: 12 }),
        placed('status', 'main', 1),
        placed('notes', 'main', 2)
      ]
    )
    const pieces = restorablePieces(current, version, (f) => f.toUpperCase())
    expect(pieces.map((p) => p.label)).toEqual(['Money', 'AMOUNT', 'TAX'])
    expect(pieces[0]).toMatchObject({ piece: { kind: 'group', key: 'money' }, where: null })
    expect(pieces[0].summary).toBe('Back on the form · 2 fields back')
    expect(pieces[1]).toMatchObject({
      where: 'in Money',
      error: expect.stringMatching(/restore the section/)
    })
    expect(pieces[1].ops).toEqual([])
  })

  it('is empty when the version matches the form', () => {
    expect(restorablePieces(version, version)).toEqual([])
  })

  it('names slot cards plainly', () => {
    const v = bundle(
      [group('main', 0)],
      [placed('title', 'main', 0), placed('__comments__', null, 1)]
    )
    const current = bundle([group('main', 0)], [placed('title', 'main', 0)])
    const pieces = restorablePieces(current, v)
    expect(pieces).toHaveLength(1)
    expect(pieces[0].label).not.toBe('__comments__')
    expect(pieces[0].piece).toEqual({ kind: 'field', field: '__comments__', group_key: null })
    expect(
      applyLayoutOps(current, pieces[0].ops).placements.some((p) => p.field === '__comments__')
    ).toBe(true)
  })
})
