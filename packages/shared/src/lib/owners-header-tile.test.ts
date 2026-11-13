import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type LayoutBundle,
  type LayoutOp,
  newPlacement,
  type PlacementRow
} from './layout-ops'
import {
  materializeOwnersOps,
  OWNERS_FIELD,
  ownersHeaderTile,
  rewriteOwnersRemove,
  VIRTUAL_OWNERS_ID,
  withAutoOwnersTile
} from './owners-header-tile'

const row = (
  field: string,
  group_key: string | null,
  sort: number,
  id: number,
  extra: Partial<PlacementRow> = {}
): PlacementRow => ({ ...newPlacement(field, group_key), sort, id, ...extra })

function bundle(placements: PlacementRow[], layoutType: string | null = 'grouped'): LayoutBundle {
  return {
    layout: { id: 7, collection: 'breakers', name: 'Main', layout_type: layoutType },
    groups: [],
    placements,
    rev: 'r1'
  }
}

const base = (): PlacementRow[] => [
  row('status', '__header__', 0, 1),
  row('amount', '__header__', 1, 2),
  row('title', null, 0, 3),
  row('__pipeline__', null, 4, 4)
]

describe('ownersHeaderTile (record page)', () => {
  const live = { showPipeline: true, isNew: false, design: false }
  const pipeline = { field: '__pipeline__', group_key: null, is_visible: true }

  it('adds the tile on a record whose form shows the pipeline and whose pipeline has owners', () => {
    expect(ownersHeaderTile({ ...live, assignments: [pipeline], ownersConfigured: true })).toEqual({
      show: true,
      auto: true
    })
  })

  it('skips the automatic tile when the pipeline has no owner setup at all', () => {
    expect(ownersHeaderTile({ ...live, assignments: [pipeline], ownersConfigured: false })).toEqual(
      { show: false, auto: false }
    )
  })

  it('waits for the pipeline answer before adding the automatic tile', () => {
    expect(
      ownersHeaderTile({ ...live, assignments: [pipeline], ownersConfigured: null }).show
    ).toBe(false)
  })

  it('never adds it to a new record, without the pipeline, or when the pipeline slot is hidden', () => {
    expect(
      ownersHeaderTile({ ...live, isNew: true, assignments: [pipeline], ownersConfigured: true })
        .show
    ).toBe(false)
    expect(
      ownersHeaderTile({
        ...live,
        showPipeline: false,
        assignments: [pipeline],
        ownersConfigured: true
      }).show
    ).toBe(false)
    expect(
      ownersHeaderTile({
        ...live,
        assignments: [{ ...pipeline, is_visible: 0 }],
        ownersConfigured: true
      }).show
    ).toBe(false)
  })

  it('a hidden Owners header placement stops the automatic tile', () => {
    expect(
      ownersHeaderTile({
        ...live,
        assignments: [
          pipeline,
          { field: OWNERS_FIELD, group_key: '__header__', is_visible: false }
        ],
        ownersConfigured: true
      })
    ).toEqual({ show: false, auto: false })
  })

  it('a visible Owners header placement is an ordinary tile', () => {
    expect(
      ownersHeaderTile({
        ...live,
        assignments: [pipeline, { field: OWNERS_FIELD, group_key: '__header__', is_visible: 1 }],
        ownersConfigured: true
      })
    ).toEqual({ show: true, auto: false })
    // No owner setup: nothing to show, even when placed.
    expect(
      ownersHeaderTile({
        ...live,
        assignments: [pipeline, { field: OWNERS_FIELD, group_key: '__header__', is_visible: 1 }],
        ownersConfigured: false
      }).show
    ).toBe(false)
  })

  it('Owners shown as a page panel still gets the header tile (Rob 2026-10-26)', () => {
    expect(
      ownersHeaderTile({
        ...live,
        assignments: [{ field: OWNERS_FIELD, group_key: null, is_visible: true }],
        ownersConfigured: true
      })
    ).toEqual({ show: true, auto: true })
  })

  it('the design canvas shows a placed tile whatever the owner setup', () => {
    expect(
      ownersHeaderTile({
        ...live,
        design: true,
        assignments: [pipeline, { field: OWNERS_FIELD, group_key: '__header__', is_visible: true }],
        ownersConfigured: false
      }).show
    ).toBe(true)
  })
})

describe('withAutoOwnersTile (layout editor)', () => {
  it('lists the automatic Owners tile first in the header strip, marked virtual', () => {
    const b = withAutoOwnersTile(bundle(base()))
    const header = b.placements
      .filter((p) => p.group_key === '__header__')
      .sort((a, z) => a.sort - z.sort)
    expect(header.map((p) => p.field)).toEqual([OWNERS_FIELD, 'status', 'amount'])
    expect(header[0].id).toBe(VIRTUAL_OWNERS_ID)
    expect(header[0].is_visible).toBe(true)
  })

  it('lists it beside an Owners page panel too (a header twin of the panel)', () => {
    const panel = withAutoOwnersTile(bundle([...base(), row(OWNERS_FIELD, null, 6, 9)]))
    expect(
      panel.placements.filter((p) => p.field === OWNERS_FIELD).map((p) => p.group_key)
    ).toEqual(expect.arrayContaining([null, '__header__']))
  })

  it('leaves a layout alone that already has an Owners tile, has no visible pipeline, or is not a record form', () => {
    const placed = bundle([...base(), row(OWNERS_FIELD, '__header__', 5, 9, { is_visible: false })])
    expect(withAutoOwnersTile(placed)).toBe(placed)
    const noPipeline = bundle(base().filter((p) => p.field !== '__pipeline__'))
    expect(withAutoOwnersTile(noPipeline)).toBe(noPipeline)
    const hiddenPipeline = bundle(
      base().map((p) => (p.field === '__pipeline__' ? { ...p, is_visible: false } : p))
    )
    expect(withAutoOwnersTile(hiddenPipeline)).toBe(hiddenPipeline)
    const detail = bundle(base(), 'detail')
    expect(withAutoOwnersTile(detail)).toBe(detail)
  })
})

describe('materializeOwnersOps (save)', () => {
  const server = () => withAutoOwnersTile(bundle(base()))
  const at = { field: OWNERS_FIELD, group_key: '__header__' }

  it('gives the virtual tile its row before an op that touches it', () => {
    const hide: LayoutOp = { op: 'update_placement', at, patch: { is_visible: false } }
    const sent = materializeOwnersOps(server(), [hide])
    expect(sent[0]).toEqual({ op: 'place', field: OWNERS_FIELD, group_key: '__header__', index: 0 })
    expect(sent[1]).toEqual(hide)
    // What the server ends up with: the hidden tile, stored.
    const stored = applyLayoutOps(bundle(base()), sent)
    expect(stored.placements.find((p) => p.field === OWNERS_FIELD)?.is_visible).toBe(false)
  })

  it('keeps header indexes right when another tile moves past it', () => {
    const move: LayoutOp = {
      op: 'move',
      from: { field: 'amount', group_key: '__header__' },
      to_group_key: '__header__',
      index: 0
    }
    const local = applyLayoutOps(server(), [move])
    const stored = applyLayoutOps(bundle(base()), materializeOwnersOps(server(), [move]))
    const order = (b: LayoutBundle) =>
      b.placements
        .filter((p) => p.group_key === '__header__')
        .sort((a, z) => a.sort - z.sort)
        .map((p) => p.field)
    expect(order(stored)).toEqual(order(local))
    expect(order(stored)).toEqual(['amount', OWNERS_FIELD, 'status'])
  })

  it('sends ops that never touch the header as they are', () => {
    const ops: LayoutOp[] = [{ op: 'layout_update', patch: { tab_mode: 'steps' } }]
    expect(materializeOwnersOps(server(), ops)).toBe(ops)
  })

  it('does nothing once the tile has a stored row', () => {
    const real = bundle([...base(), row(OWNERS_FIELD, '__header__', -1, 9)])
    const ops: LayoutOp[] = [{ op: 'update_placement', at, patch: { is_visible: false } }]
    expect(materializeOwnersOps(real, ops)).toBe(ops)
  })
})

describe('rewriteOwnersRemove', () => {
  const at = { field: OWNERS_FIELD, group_key: '__header__' }

  it('turns removing the Owners tile into hiding it (a removed tile would come back by itself)', () => {
    const draft = withAutoOwnersTile(bundle(base()))
    expect(rewriteOwnersRemove(draft, [{ op: 'remove', at }])).toEqual([
      { op: 'update_placement', at, patch: { is_visible: false } }
    ])
  })

  it('removes it for real when the form shows no pipeline', () => {
    const draft = bundle([row('status', '__header__', 0, 1), row(OWNERS_FIELD, '__header__', 1, 2)])
    const ops: LayoutOp[] = [{ op: 'remove', at }]
    expect(rewriteOwnersRemove(draft, ops)).toBe(ops)
  })
})
