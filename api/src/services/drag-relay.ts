/**
 * Live drags on calendars and Gantt charts (realtime round 9, item 17).
 *
 * While someone drags a calendar entry or a Gantt bar, everyone else looking at that view sees
 * a ghost of it moving. The dragging tab sends `record:drag` (throttled on the client to one
 * message per day crossed); the server passes it on to the record's row-watch room
 * (`rows:<record room>`, services/presence-rows.ts) — the sockets that watch that record's row,
 * which they could only join after the record read gate judged them (role, row filters, User
 * Scopes). A drag is passed on only when:
 *  - the dragging socket itself watches that row (it may read the record), and
 *  - its person may update the collection (`can(update)`, once per collection per socket).
 * The payload is ids and positions only: collection, item, the view (which date fields), the
 * phase and the day(s) the ghost sits on, plus the dragger's user id (presence, like
 * `presence:rows`). No field values. The drop itself is an ordinary PATCH through the items
 * service, guarded by the mid-air check (`_base_revision`), so two drops never silently
 * overwrite each other.
 */

export type DragPhase = 'move' | 'end' | 'cancel'

export interface DragMessage {
  collection: string
  item: string
  /** `calendar:<field>` or `gantt:<start>,<end>` — a viewer draws ghosts only for its own view. */
  view: string
  phase: DragPhase
  /** Calendar: the day the entry is over. Gantt: the bar's start and end days. */
  at?: string
  start?: string
  end?: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const VIEW =
  /^(calendar:[A-Za-z_][A-Za-z0-9_]{0,63}|gantt:[A-Za-z_][A-Za-z0-9_]{0,63},[A-Za-z_][A-Za-z0-9_]{0,63})$/

/** A clean drag message, or null (anything malformed is dropped silently). */
export function parseDragMessage(raw: unknown): DragMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const collection = r.collection
  if (typeof collection !== 'string' || !NAME.test(collection)) return null
  if (/^nivaro_|^directus_/i.test(collection)) return null
  const itemRaw = r.item
  if (itemRaw == null || (typeof itemRaw !== 'string' && typeof itemRaw !== 'number')) return null
  const item = String(itemRaw).trim()
  if (!item || item.length > 64) return null
  if (typeof r.view !== 'string' || !VIEW.test(r.view)) return null
  const phase = r.phase
  if (phase !== 'move' && phase !== 'end' && phase !== 'cancel') return null
  const out: DragMessage = { collection, item, view: r.view, phase }
  if (phase === 'cancel') return out
  const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : undefined)
  if (r.view.startsWith('calendar:')) {
    const at = day(r.at)
    if (!at) return null
    out.at = at
  } else {
    const start = day(r.start)
    const end = day(r.end)
    if (!start || !end || end < start) return null
    out.start = start
    out.end = end
  }
  return out
}

/** Least time between two passed-on moves of one record from one socket. */
export const DRAG_MOVE_MIN_MS = 60

/**
 * Per socket: lets a record's `move` messages through at most once per `minMs`; `end` and
 * `cancel` always pass (the ghost must never be left hanging). Remembers ≤ 50 records.
 */
export function createDragThrottle(minMs = DRAG_MOVE_MIN_MS) {
  const last = new Map<string, number>()
  return (key: string, phase: DragPhase, now: number): boolean => {
    if (phase !== 'move') {
      last.delete(key)
      return true
    }
    const at = last.get(key)
    if (at != null && now - at < minMs) return false
    if (!last.has(key) && last.size >= 50) {
      const oldest = last.keys().next().value
      if (oldest !== undefined) last.delete(oldest)
    }
    last.set(key, now)
    return true
  }
}
