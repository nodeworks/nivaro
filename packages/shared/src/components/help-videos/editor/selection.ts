import {
  EDIT_LIMITS,
  HOLD_OUTSIDE_NOTE,
  itemsOf,
  LIST_KEYS,
  type ListKey,
  newId,
  segmentIndexAt,
  sortedList,
  withList
} from '../edits'
import type { VideoEdits } from '../types'

// What is selected in the editor, and the pure maths of acting on several
// pieces at once (#1543): marquee hit-testing, moving a group with the whole
// group clamped to the recording, aligning edges to the playhead, nudging,
// duplicating and deleting. Every operation returns new edits (one undo
// step) or the reason it was refused, with the edits unchanged. Kept pieces
// (the cuts lane) are never part of a group: they are positional.

export type SelectedItem = { lane: ListKey; id: string }
export type Selection =
  | { lane: 'cuts'; index: number }
  | SelectedItem
  | { lane: 'multi'; items: SelectedItem[] }
  | null

/** One frame at 30 fps: what an arrow key nudges a selection by. */
export const NUDGE_FRAME_MS = 33
export const NUDGE_SECOND_MS = 1000

type Timed = { id: string; start_ms?: number; end_ms?: number; at_ms?: number }
export type Change = { edits: VideoEdits; refused?: string }

const same = (a: SelectedItem, b: SelectedItem) => a.lane === b.lane && a.id === b.id

/** The items a selection holds (a kept piece or nothing: none). */
export function selectedItems(sel: Selection): SelectedItem[] {
  if (!sel || sel.lane === 'cuts') return []
  if (sel.lane === 'multi') return sel.items
  return [sel]
}
export function isItemSelected(sel: Selection, lane: ListKey, id: string): boolean {
  return selectedItems(sel).some((x) => x.lane === lane && x.id === id)
}
/** A selection of these items: none, one, or a group (duplicates dropped). */
export function selectionOf(items: SelectedItem[]): Selection {
  const unique: SelectedItem[] = []
  for (const it of items) if (!unique.some((u) => same(u, it))) unique.push(it)
  if (!unique.length) return null
  if (unique.length === 1) return unique[0]
  return { lane: 'multi', items: unique }
}
/** Shift / ⌘-click: the item joins the selection, or leaves it. A kept piece
 *  selected before is let go (pieces never group). */
export function toggleItem(sel: Selection, item: SelectedItem): Selection {
  const cur = selectedItems(sel)
  return selectionOf(
    cur.some((x) => same(x, item)) ? cur.filter((x) => !same(x, item)) : [...cur, item]
  )
}
/** The selection without items that no longer exist. */
export function pruneSelection(e: VideoEdits, sel: Selection): Selection {
  if (!sel || sel.lane === 'cuts') return sel
  const items = selectedItems(sel).filter((it) =>
    (itemsOf(e, it.lane) as Timed[]).some((x) => x.id === it.id)
  )
  const next = selectionOf(items)
  return items.length === selectedItems(sel).length ? sel : next
}

/** An item's span on the timeline (a chapter or hold is a moment). */
export function spanOf(x: Timed): { start_ms: number; end_ms: number } {
  const start = x.start_ms ?? x.at_ms ?? 0
  return { start_ms: start, end_ms: x.end_ms ?? start }
}
function find(e: VideoEdits, it: SelectedItem): Timed | undefined {
  return (itemsOf(e, it.lane) as Timed[]).find((x) => x.id === it.id)
}
/** The items that exist, with their current copies. */
function resolve(e: VideoEdits, items: SelectedItem[]): Array<{ lane: ListKey; item: Timed }> {
  const out: Array<{ lane: ListKey; item: Timed }> = []
  for (const it of items) {
    const item = find(e, it)
    if (item) out.push({ lane: it.lane, item })
  }
  return out
}
/** Where a group starts and ends (source time), or null when it is empty. */
export function selectionBounds(
  e: VideoEdits,
  items: SelectedItem[]
): { start_ms: number; end_ms: number } | null {
  const spans = resolve(e, items).map(({ item }) => spanOf(item))
  if (!spans.length) return null
  return {
    start_ms: Math.min(...spans.map((s) => s.start_ms)),
    end_ms: Math.max(...spans.map((s) => s.end_ms))
  }
}

/** The lanes a vertical range crosses, given the lanes in order with their
 *  heights (the timeline's layout). The cuts lane holds no items. */
export function lanesBetween(
  rows: Array<{ key: 'cuts' | ListKey; height: number }>,
  y0: number,
  y1: number
): ListKey[] {
  const [a, b] = y0 <= y1 ? [y0, y1] : [y1, y0]
  const out: ListKey[] = []
  let top = 0
  for (const r of rows) {
    const bottom = top + r.height
    if (r.key !== 'cuts' && a < bottom && b > top) out.push(r.key)
    top = bottom
  }
  return out
}
/** The items on these lanes that overlap a time range (marquee hit-test). */
export function marqueeItems(
  e: VideoEdits,
  t0: number,
  t1: number,
  lanes: ListKey[]
): SelectedItem[] {
  const [a, b] = t0 <= t1 ? [t0, t1] : [t1, t0]
  const out: SelectedItem[] = []
  for (const lane of LIST_KEYS) {
    if (!lanes.includes(lane)) continue
    for (const x of itemsOf(e, lane) as Timed[]) {
      const s = spanOf(x)
      if (s.start_ms <= b && s.end_ms >= a) out.push({ lane, id: x.id })
    }
  }
  return out
}

/** The edits with every selected item replaced by `fn`'s copy, each lane
 *  back in its stored order. */
function mapItems(
  e: VideoEdits,
  items: SelectedItem[],
  fn: (lane: ListKey, item: Timed) => Timed
): VideoEdits {
  let next = e
  for (const lane of LIST_KEYS) {
    const ids = new Set(items.filter((it) => it.lane === lane).map((it) => it.id))
    if (!ids.size) continue
    const list = (itemsOf(next, lane) as Timed[]).map((x) => (ids.has(x.id) ? fn(lane, x) : x))
    next = withList(next, lane, sortedList(lane, list))
  }
  return next
}
/** What the server would drop or refuse in a changed group: zooms that
 *  overlap, holds outside every kept piece. */
function check(e: VideoEdits, touched: SelectedItem[]): string | undefined {
  const zooms = e.zooms
  for (let i = 0; i < zooms.length; i++) {
    for (let j = i + 1; j < zooms.length; j++) {
      if (zooms[i].start_ms < zooms[j].end_ms && zooms[j].start_ms < zooms[i].end_ms)
        return 'Zooms can’t overlap. Move it clear of the other zoom.'
    }
  }
  for (const it of touched) {
    if (it.lane !== 'holds') continue
    const h = find(e, it)
    if (h && segmentIndexAt(e, h.at_ms ?? 0) < 0) return HOLD_OUTSIDE_NOTE
  }
  return undefined
}
const moved = (x: Timed, d: number): Timed => {
  const out = { ...x }
  if (out.at_ms !== undefined) out.at_ms = Math.round(out.at_ms + d)
  if (out.start_ms !== undefined) out.start_ms = Math.round(out.start_ms + d)
  if (out.end_ms !== undefined) out.end_ms = Math.round(out.end_ms + d)
  return out
}

/** The group moved together by `deltaMs`, as far as the recording allows:
 *  the earliest item stops at 0 and the latest at the end, and the rest keep
 *  their distances. Refused when a zoom would land on another zoom or a
 *  hold would leave the kept pieces. */
export function moveItems(
  e: VideoEdits,
  items: SelectedItem[],
  deltaMs: number,
  sourceMs: number
): Change {
  const bounds = selectionBounds(e, items)
  if (!bounds) return { edits: e }
  const d = Math.round(Math.max(-bounds.start_ms, Math.min(sourceMs - bounds.end_ms, deltaMs)))
  if (!d) return { edits: e }
  const next = mapItems(e, items, (_lane, x) => moved(x, d))
  const refused = check(next, items)
  return refused ? { edits: e, refused } : { edits: next }
}

/** Every selected item's start edge (or end edge) put at `toMs`, each
 *  keeping its length and staying inside the recording. A chapter or hold
 *  goes to the moment itself. */
export function alignItems(
  e: VideoEdits,
  items: SelectedItem[],
  edge: 'start' | 'end',
  toMs: number,
  sourceMs: number
): Change {
  const to = Math.round(Math.max(0, Math.min(sourceMs, toMs)))
  const next = mapItems(e, items, (_lane, x) => {
    const s = spanOf(x)
    const len = s.end_ms - s.start_ms
    const start = edge === 'start' ? Math.min(to, sourceMs - len) : Math.max(0, to - len)
    return moved(x, start - s.start_ms)
  })
  if (next === e) return { edits: e }
  const refused = check(next, items)
  return refused ? { edits: e, refused } : { edits: next }
}

/** Copies of the selection placed right after it (the copies keep their
 *  distances and start where the group ends; a group of moments is put one
 *  second on). The copies become the selection. Refused when there is no
 *  room before the end of the recording, a copied zoom would overlap, or a
 *  list would pass its cap. */
export function duplicateItems(
  e: VideoEdits,
  items: SelectedItem[],
  sourceMs: number
): Change & { selection: Selection } {
  const found = resolve(e, items)
  const bounds = selectionBounds(e, items)
  if (!found.length || !bounds) return { edits: e, selection: null }
  const offset = Math.max(NUDGE_SECOND_MS, bounds.end_ms - bounds.start_ms)
  if (bounds.end_ms + offset > sourceMs)
    return {
      edits: e,
      refused: 'No room for a copy before the end of the recording',
      selection: null
    }
  let next = e
  const copies: SelectedItem[] = []
  for (const lane of LIST_KEYS) {
    const mine = found.filter((f) => f.lane === lane)
    if (!mine.length) continue
    const list = itemsOf(next, lane) as Timed[]
    if (list.length + mine.length > EDIT_LIMITS[lane])
      return {
        edits: e,
        refused: `There can be at most ${EDIT_LIMITS[lane]} of these`,
        selection: null
      }
    const added = mine.map(({ item }) => ({ ...moved(item, offset), id: newId() }))
    for (const a of added) copies.push({ lane, id: a.id })
    next = withList(next, lane, sortedList(lane, [...list, ...added]))
  }
  const refused = check(next, copies)
  return refused
    ? { edits: e, refused, selection: null }
    : { edits: next, selection: selectionOf(copies) }
}

/** The edits without the selected items. */
export function deleteItems(e: VideoEdits, items: SelectedItem[]): VideoEdits {
  let next = e
  for (const lane of LIST_KEYS) {
    const ids = new Set(items.filter((it) => it.lane === lane).map((it) => it.id))
    if (!ids.size) continue
    next = withList(
      next,
      lane,
      (itemsOf(next, lane) as Timed[]).filter((x) => !ids.has(x.id))
    )
  }
  return next
}

const LANE_NOUNS: Record<ListKey, [string, string]> = {
  chapters: ['chapter', 'chapters'],
  annotations: ['callout', 'callouts'],
  zooms: ['zoom', 'zooms'],
  blurs: ['blur', 'blurs'],
  captions: ['caption', 'captions'],
  holds: ['hold', 'holds']
}
/** "2 callouts, 1 zoom and 1 chapter": what a group holds, lane by lane. */
export function describeItems(items: SelectedItem[]): string {
  const parts: string[] = []
  for (const lane of LIST_KEYS) {
    const n = items.filter((it) => it.lane === lane).length
    if (n) parts.push(`${n} ${LANE_NOUNS[lane][n === 1 ? 0 : 1]}`)
  }
  if (parts.length <= 1) return parts[0] ?? 'nothing'
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}
