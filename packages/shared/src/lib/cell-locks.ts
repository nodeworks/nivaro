import type { NivaroClient } from '@nivaro/sdk'
import { post } from './commands'
import type { InlineEditorKind } from './list-inline-edit'
import { inlineValueUnchanged } from './list-inline-edit'

/**
 * Editing a list in place with other people (realtime round 6, item 15) — the client half of
 * the soft cell locks (api services/cell-locks.ts) and of the overwrite check.
 *
 * - Opening a cell's editor takes a soft lock on that row + field (30 s lease, beat every
 *   CELL_BEAT_MS); leaving it lets go. Other lists showing the cell mark it with the editor's
 *   name and do not open it. A lock that cannot be taken never stops anyone editing.
 * - Holders are read for the cells on screen in one request per collection, again when a
 *   `$cells` notice names a row on screen (coalesced), as the viewer.
 * - Saving re-reads the field as the viewer; when it changed since the editor opened (and not
 *   to what is being saved), the cell asks: Keep mine / Take theirs.
 */

export const CELL_BEAT_MS = 10_000
/** Notices on screen within this window → one holder read per collection. */
export const CELL_READ_COALESCE_MS = 600
/** Most cells one holder read asks about (the server's cap). */
export const CELL_READ_MAX = 2000

export interface CellCoords {
  collection: string
  id: string | number
  field: string
}

export interface CellHolder {
  id: string
  field: string
  name: string
  since: string
  mine: boolean
}

export function cellHolderKey(collection: string, id: string | number, field: string): string {
  return `${collection}\u0001${String(id).toUpperCase()}\u0001${field}`
}

export async function takeCell(
  client: NivaroClient,
  c: CellCoords,
  beat = false
): Promise<{ ok: true } | { ok: false; holder: { name: string; since: string } }> {
  try {
    const r = await client.request<{ ok: boolean; holder?: { name: string; since: string } }>(
      post('/cell-locks/take', { collection: c.collection, id: String(c.id), field: c.field, beat })
    )
    return r?.ok === false && r.holder ? { ok: false, holder: r.holder } : { ok: true }
  } catch {
    // Soft: a refusal or a lock store that is away never stops the edit.
    return { ok: true }
  }
}

export function releaseCell(client: NivaroClient, c: CellCoords): void {
  void client
    .request(
      post('/cell-locks/release', { collection: c.collection, id: String(c.id), field: c.field })
    )
    .catch(() => {})
}

/** Holders of these cells, keyed by cellHolderKey (others' and the viewer's own). */
export async function readCellHolders(
  client: NivaroClient,
  collection: string,
  cells: Array<{ id: string | number; field: string }>
): Promise<Map<string, CellHolder>> {
  const out = new Map<string, CellHolder>()
  const ids = [...new Set(cells.map((c) => String(c.id)))]
  const fields = [...new Set(cells.map((c) => c.field))]
  if (ids.length === 0 || fields.length === 0) return out
  // Keep each request under the server's cell cap.
  const perReq = Math.max(1, Math.floor(CELL_READ_MAX / fields.length))
  for (let i = 0; i < ids.length; i += perReq) {
    const r = await client.request<{ data: CellHolder[] }>(
      post('/cell-locks/read', { collection, ids: ids.slice(i, i + perReq), fields })
    )
    for (const h of r?.data ?? []) out.set(cellHolderKey(collection, h.id, h.field), h)
  }
  return out
}

/** Same stored value for this editor kind (ids case-blind: GUIDs arrive in both spellings). */
export function sameCellValue(kind: InlineEditorKind, a: unknown, b: unknown): boolean {
  if (kind === 'm2o') {
    if (a == null || a === '' || b == null || b === '') return (a ?? '') === (b ?? '')
    const id = (v: unknown) =>
      String(v && typeof v === 'object' && 'id' in (v as object) ? (v as { id: unknown }).id : v)
    return id(a).toUpperCase() === id(b).toUpperCase()
  }
  if ((a === '' || a == null) && (b === '' || b == null)) return true
  return inlineValueUnchanged(kind, a, b)
}

/**
 * Whether a save would overwrite someone else's change: the field moved since the editor
 * opened (`base`) and not to what is being saved.
 */
export function overwritesOthers(
  kind: InlineEditorKind,
  base: unknown,
  theirs: unknown,
  mine: unknown
): boolean {
  return !sameCellValue(kind, base, theirs) && !sameCellValue(kind, theirs, mine)
}
