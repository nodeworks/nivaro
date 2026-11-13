/**
 * The Owners tile in a record's header strip.
 *
 * Owners are in the header of every record with a workflow (Rob 2026-10-26):
 * a form that shows the pipeline or Owners panel and has no Owners HEADER
 * placement gets the tile automatically, first. Since 2026-11-13 it is an
 * ordinary header tile in the layout editor — listed, reorderable, hideable:
 *
 * - The editor's draft carries the automatic tile as a virtual placement
 *   (`withAutoOwnersTile`, id VIRTUAL_OWNERS_ID) so the outline, the canvas,
 *   drops and the inspector all treat it like a stored tile.
 * - The first save that touches the header strip gives it its stored row
 *   (`materializeOwnersOps`), at the spot it was drawn, so header indexes the
 *   editor computed against the draft mean the same on the server.
 * - Hiding stores the row with is_visible false, which stops the automatic
 *   tile. Removing it is hiding it (`rewriteOwnersRemove`): a removed row
 *   would only bring the automatic tile back.
 * - The record page skips the AUTOMATIC tile when the record's pipeline has
 *   no owner setup at all (no owner groups, no owner dimensions, no fallback
 *   field, nobody added by hand — `owners_configured` on GET
 *   /pipelines/instance/:collection/:item).
 */
import {
  applyLayoutOps,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  newPlacement,
  type PlacementKey
} from './layout-ops'

export const OWNERS_FIELD = '__owners__'
/** The id the editor gives the automatic tile until a save stores its row. */
export const VIRTUAL_OWNERS_ID = -1

interface Row {
  field: string
  group_key?: string | null
  is_visible?: boolean | number | null
}

const visible = (r: Row) => !(r.is_visible === 0 || r.is_visible === false)
const isHeaderOwners = (r: Row) => r.field === OWNERS_FIELD && r.group_key === HEADER_GROUP_KEY

/** The form shows the workflow (the pipeline or the Owners panel) and has no Owners header tile. */
export function ownersAutoQualifies(rows: readonly Row[]): boolean {
  if (rows.some(isHeaderOwners)) return false
  return rows.some(
    (r) =>
      (r.field === '__pipeline__' || r.field === OWNERS_FIELD) &&
      r.group_key !== HEADER_GROUP_KEY &&
      visible(r)
  )
}

export interface OwnersTileInput {
  /** The form's assignments (the active layout's placements). */
  assignments: readonly Row[]
  /** The record page shows a pipeline at all (showPipeline). */
  showPipeline: boolean
  isNew: boolean
  /**
   * The record's pipeline has some owner setup: true / false from the
   * pipeline answer, null while it has not answered. A server that predates
   * the field answers without it — the caller passes true then.
   */
  ownersConfigured: boolean | null
  /** The layout editor's canvas: a placed tile shows whatever the owner setup. */
  design: boolean
}

/** Whether the header shows the Owners tile, and whether it is the automatic one. */
export function ownersHeaderTile(input: OwnersTileInput): { show: boolean; auto: boolean } {
  const placed = input.assignments.find(isHeaderOwners)
  if (placed) {
    const show = visible(placed) && (input.design || input.ownersConfigured !== false)
    return { show, auto: false }
  }
  const auto =
    input.showPipeline &&
    !input.isNew &&
    ownersAutoQualifies(input.assignments) &&
    (input.design || input.ownersConfigured === true)
  return { show: auto, auto }
}

const isRecordForm = (b: LayoutBundle) => {
  const t = b.layout.layout_type
  return t == null || t === 'grouped'
}

const headerZone = (b: LayoutBundle) =>
  b.placements.filter((p) => p.group_key === HEADER_GROUP_KEY).sort((a, z) => a.sort - z.sort)

/** The editor's draft with the automatic Owners tile as a placement (first in the header). */
export function withAutoOwnersTile(bundle: LayoutBundle): LayoutBundle {
  if (!isRecordForm(bundle) || !ownersAutoQualifies(bundle.placements)) return bundle
  const first = headerZone(bundle)[0]?.sort ?? 0
  const tile = {
    ...newPlacement(OWNERS_FIELD, HEADER_GROUP_KEY),
    id: VIRTUAL_OWNERS_ID,
    sort: first - 1
  }
  // A no-op op renumbers the zone, as every draft the editor holds is.
  return applyLayoutOps({ ...bundle, placements: [...bundle.placements, tile] }, [
    { op: 'layout_update', patch: {} }
  ])
}

const touchesHeader = (op: LayoutOp): boolean => {
  const keyed = (k: PlacementKey | undefined) =>
    !!k && (k.group_key === HEADER_GROUP_KEY || k.field === OWNERS_FIELD)
  switch (op.op) {
    case 'place':
      return op.group_key === HEADER_GROUP_KEY
    case 'move':
      return keyed(op.from) || op.to_group_key === HEADER_GROUP_KEY
    case 'update_placement':
    case 'remove':
      return keyed(op.at)
    default:
      return false
  }
}

/**
 * Ops for the server: while `server` (the draft's base) holds the virtual
 * tile, a batch that touches the header strip first stores the tile's row
 * where it is drawn.
 */
export function materializeOwnersOps(server: LayoutBundle, ops: LayoutOp[]): LayoutOp[] {
  const zone = headerZone(server)
  const index = zone.findIndex((p) => isHeaderOwners(p) && p.id === VIRTUAL_OWNERS_ID)
  if (index < 0 || !ops.some(touchesHeader)) return ops
  return [{ op: 'place', field: OWNERS_FIELD, group_key: HEADER_GROUP_KEY, index }, ...ops]
}

/** Removing the Owners tile from a form that shows the workflow hides it instead. */
export function rewriteOwnersRemove(draft: LayoutBundle, ops: LayoutOp[]): LayoutOp[] {
  const others = draft.placements.filter((p) => !isHeaderOwners(p))
  if (!ops.some((o) => o.op === 'remove' && isHeaderOwners(o.at)) || !ownersAutoQualifies(others))
    return ops
  return ops.map((o) =>
    o.op === 'remove' && isHeaderOwners(o.at)
      ? { op: 'update_placement', at: o.at, patch: { is_visible: false } }
      : o
  )
}
