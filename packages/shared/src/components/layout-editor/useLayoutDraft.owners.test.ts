import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type LayoutBundle,
  type LayoutOp,
  newPlacement,
  type PlacementRow
} from '../../lib/layout-ops'
import { OWNERS_FIELD, VIRTUAL_OWNERS_ID } from '../../lib/owners-header-tile'
import { LayoutDraftEngine } from './useLayoutDraft'

// The automatic Owners header tile in the layout editor (Rob 2026-11-13): listed
// like any tile, and hiding / moving it stores it in the layout.

const row = (field: string, group_key: string | null, sort: number, id: number): PlacementRow => ({
  ...newPlacement(field, group_key),
  sort,
  id
})

function stored(): LayoutBundle {
  return {
    layout: { id: 7, collection: 'breakers', name: 'Main', layout_type: 'grouped' },
    groups: [],
    placements: [
      row('status', '__header__', 0, 1),
      row('amount', '__header__', 1, 2),
      row('title', null, 0, 3),
      row('__pipeline__', null, 4, 4)
    ],
    rev: 'r1'
  }
}

function server(start = stored()) {
  let current = start
  let n = 1
  const sent: LayoutOp[][] = []
  const engine = new LayoutDraftEngine(
    {
      send: async (ops) => {
        sent.push(ops)
        current = { ...applyLayoutOps(current, ops), rev: `r${++n}` }
        // The server's rows have ids; the virtual tile's id never reaches it.
        current.placements = current.placements.map((p, i) => ({ ...p, id: p.id ?? 900 + i }))
        return current
      },
      saved: () => {},
      reload: () => {},
      notify: () => {}
    },
    { autosave: false, autoOwnersTile: true }
  )
  engine.receive(start)
  return {
    engine,
    sent,
    get current() {
      return current
    }
  }
}

const header = (b: LayoutBundle | null) =>
  (b?.placements ?? [])
    .filter((p) => p.group_key === '__header__')
    .sort((a, z) => a.sort - z.sort)
    .map((p) => `${p.field}${p.is_visible ? '' : ' (hidden)'}`)

const at = { field: OWNERS_FIELD, group_key: '__header__' }

describe('layout draft: the automatic Owners tile', () => {
  it('is in the draft as the first header tile without anything to save', () => {
    const s = server()
    const view = s.engine.getView()
    expect(header(view.bundle)).toEqual([OWNERS_FIELD, 'status', 'amount'])
    expect(view.bundle?.placements.find((p) => p.field === OWNERS_FIELD)?.id).toBe(
      VIRTUAL_OWNERS_ID
    )
    expect(view.dirty).toBe(false)
  })

  it('hiding it stores the tile, hidden, and the draft keeps it listed', async () => {
    const s = server()
    s.engine.apply([{ op: 'update_placement', at, patch: { is_visible: false } }], {
      label: 'Hide Owners'
    })
    await s.engine.save()
    expect(s.sent[0][0]).toEqual({
      op: 'place',
      field: OWNERS_FIELD,
      group_key: '__header__',
      index: 0
    })
    expect(header(s.current)).toEqual([`${OWNERS_FIELD} (hidden)`, 'status', 'amount'])
    expect(header(s.engine.getView().bundle)).toEqual([
      `${OWNERS_FIELD} (hidden)`,
      'status',
      'amount'
    ])
  })

  it('removing it hides it (a removed tile would only come back by itself)', async () => {
    const s = server()
    s.engine.apply([{ op: 'remove', at }], { label: 'Remove Owners' })
    expect(header(s.engine.getView().bundle)).toEqual([
      `${OWNERS_FIELD} (hidden)`,
      'status',
      'amount'
    ])
    await s.engine.save()
    expect(header(s.current)).toEqual([`${OWNERS_FIELD} (hidden)`, 'status', 'amount'])
  })

  it('reordering the header stores the order the canvas showed', async () => {
    const s = server()
    s.engine.apply(
      [
        {
          op: 'move',
          from: { field: 'amount', group_key: '__header__' },
          to_group_key: '__header__',
          index: 0
        }
      ],
      { label: 'Move header tile' }
    )
    await s.engine.save()
    expect(header(s.current)).toEqual(['amount', OWNERS_FIELD, 'status'])
    expect(header(s.engine.getView().bundle)).toEqual(['amount', OWNERS_FIELD, 'status'])
  })

  it('a save that never touches the header leaves the layout without the row', async () => {
    const s = server()
    s.engine.apply([{ op: 'layout_update', patch: { tab_mode: 'steps' } }], { label: 'Steps' })
    await s.engine.save()
    expect(s.sent[0]).toEqual([{ op: 'layout_update', patch: { tab_mode: 'steps' } }])
    expect(s.current.placements.some((p) => p.field === OWNERS_FIELD)).toBe(false)
    // …and the draft still lists the automatic tile.
    expect(header(s.engine.getView().bundle)[0]).toBe(OWNERS_FIELD)
  })
})
