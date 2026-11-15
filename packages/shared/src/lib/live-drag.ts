import type { NivaroClient } from '@nivaro/sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { withRowBaseRevision } from '../components/item-edit/line-midair'
import { get, patch } from './commands'
import { useLiveEvent } from './live'
import { useActorNames, writerOf } from './live-list'
import { useRowPresence } from './presence-hooks'
import { useOptionalRealtime } from './realtime'
import { midairCollisionOf } from './record-outbox'

/**
 * Live drags on calendars and Gantt charts (realtime round 9, item 17).
 *
 * While a person drags an entry, everyone else looking at the same view (same collection, same
 * date field(s)) sees a ghost of it — the entry's own label from THEIR read, a dashed outline on
 * the day it is over, and the dragger's name. The socket carries ids, the view and days only
 * (api services/drag-relay.ts), passed on only to people who watch that record's row (the
 * record read gate) — so nobody learns of a record they cannot read.
 *
 * The drop is an ordinary PATCH with the revision the drag started from (`_base_revision`, the
 * server's mid-air check). When someone else moved it meanwhile, the drop is not lost and does
 * not silently win: the view asks "Beth just moved this to Dec 4 — Keep Beth's / Use yours",
 * with the newer position read back as the viewer.
 *
 * Ghosts are presence: quiet in Calm and Off (lib/live-preference.ts), never animated with
 * reduced motion. A ghost nobody refreshes for GHOST_STALE_MS (a closed tab) disappears.
 */

// ── Days ──────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD` of a local Date. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A stored date / datetime → the local day it falls on (date-only values are never shifted). */
export function dayOf(value: unknown): string | null {
  if (value == null || value === '') return null
  const s = String(value)
  const m = DATE_ONLY.exec(s.slice(0, 10))
  if (m && (s.length === 10 || /^\d{4}-\d{2}-\d{2}[ T]00:00(:00)?(\.0+)?$/.test(s)))
    return s.slice(0, 10)
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : dayKey(d)
}

/** The local Date of a `YYYY-MM-DD` day (midnight, local). */
export function dateOfDay(day: string): Date {
  const m = DATE_ONLY.exec(day)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(Number.NaN)
}

/** Add whole days to a `YYYY-MM-DD` day. */
export function addDays(day: string, n: number): string {
  const d = dateOfDay(day)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}

/** Whole days from `a` to `b` (both `YYYY-MM-DD`). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateOfDay(b).getTime() - dateOfDay(a).getTime()) / 86_400_000)
}

/**
 * The value to store when a date field's value moves to `day`: a date field takes the day; a
 * datetime keeps its time of day (local) on the new day.
 */
export function valueOnDay(old: unknown, day: string, type?: string | null): string {
  const t = String(type ?? '').toLowerCase()
  const s = old == null ? '' : String(old)
  if (t === 'date' || !s || DATE_ONLY.test(s)) return day
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return day
  const target = dateOfDay(day)
  d.setFullYear(target.getFullYear(), target.getMonth(), target.getDate())
  return d.toISOString()
}

/** "Dec 4" (with the year when it is not this year). */
export function dayLabel(day: string, now = new Date()): string {
  const d = dateOfDay(day)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
  })
}

/** "Beth just moved Pump check to Dec 4" / "… to Dec 1 – Dec 9" (`what` defaults to "this"). */
export function clashSentence(
  who: string | null,
  from: string | null,
  to?: string | null,
  what = 'this'
): string {
  const name = who || 'Someone'
  if (!from) return `${name} just changed ${what}`
  return to && to !== from
    ? `${name} just moved ${what} to ${dayLabel(from)} – ${dayLabel(to)}`
    : `${name} just moved ${what} to ${dayLabel(from)}`
}

// ── Ghosts ────────────────────────────────────────────────────────────────

export interface DragGhost {
  item: string
  userId: string
  /** Calendar: the day it is over. Gantt: start/end days. */
  at?: string
  start?: string
  end?: string
  /** 'end' = dropped: kept a moment until the record's own change arrives. */
  phase: 'move' | 'end'
  seen: number
}

/** A ghost with no news for this long is gone (its tab closed mid-drag). */
export const GHOST_STALE_MS = 6000
/** A dropped ghost stays this long, until the record's own update redraws the entry. */
export const GHOST_DROPPED_MS = 2500

/** Pure: the ghost map after one `record:drag` message for this view. */
export function applyDragMessage(
  ghosts: Map<string, DragGhost>,
  msg: Record<string, unknown> | null | undefined,
  view: string,
  now: number
): Map<string, DragGhost> {
  if (!msg || msg.view !== view || msg.item == null || typeof msg.user_id !== 'string')
    return ghosts
  const item = String(msg.item)
  const next = new Map(ghosts)
  if (msg.phase === 'cancel') {
    next.delete(item)
    return next
  }
  if (msg.phase !== 'move' && msg.phase !== 'end') return ghosts
  next.set(item, {
    item,
    userId: msg.user_id,
    at: typeof msg.at === 'string' ? msg.at : undefined,
    start: typeof msg.start === 'string' ? msg.start : undefined,
    end: typeof msg.end === 'string' ? msg.end : undefined,
    phase: msg.phase,
    seen: now
  })
  return next
}

/** Pure: drop stale and settled ghosts. */
export function pruneGhosts(ghosts: Map<string, DragGhost>, now: number): Map<string, DragGhost> {
  let changed = false
  const next = new Map<string, DragGhost>()
  for (const [k, g] of ghosts) {
    const ttl = g.phase === 'end' ? GHOST_DROPPED_MS : GHOST_STALE_MS
    if (now - g.seen > ttl) changed = true
    else next.set(k, g)
  }
  return changed ? next : ghosts
}

export type DragPosition = { at: string } | { start: string; end: string }

export interface LiveDrag {
  /** Others' drags in this view, by item id. */
  ghosts: Map<string, DragGhost>
  /** Display names of the people dragging. */
  names: Map<string, string>
  /** Tell others where my drag is (sent only when the day changes). */
  move: (item: string, pos: DragPosition) => void
  /** My drag ended: dropped at `pos`, or cancelled (no pos). */
  finish: (item: string, pos?: DragPosition) => void
}

/**
 * One calendar's / Gantt's live drags. `view` = `calendar:<field>` or `gantt:<start>,<end>`;
 * `items` = the record ids drawn (≤ 150 are watched — the server caps watches per socket).
 */
export function useLiveDrag(opts: {
  collection: string
  view: string
  items: string[]
  enabled?: boolean
}): LiveDrag {
  const realtime = useOptionalRealtime()
  const enabled = opts.enabled !== false && !!opts.collection
  const watchKey = opts.items.slice(0, 150).join('\u0001')
  const watched = useMemo(
    () =>
      watchKey
        ? watchKey.split('\u0001').map((item) => ({ collection: opts.collection, item }))
        : [],
    [opts.collection, watchKey]
  )
  // Watching the rows is what lets the server pass drags on (and judge who may see them).
  useRowPresence(watched, { enabled, pollMs: 0 })
  const [ghosts, setGhosts] = useState<Map<string, DragGhost>>(() => new Map())
  const viewRef = useRef(opts.view)
  viewRef.current = opts.view
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view starts with no ghosts
  useEffect(() => {
    setGhosts(new Map())
  }, [opts.view, opts.collection])
  useLiveEvent(
    'record:drag',
    (p) => {
      if (p?.collection !== opts.collection) return
      setGhosts((g) => applyDragMessage(g, p, viewRef.current, Date.now()))
    },
    { enabled }
  )
  useEffect(() => {
    if (ghosts.size === 0) return
    const t = setInterval(() => setGhosts((g) => pruneGhosts(g, Date.now())), 1000)
    return () => clearInterval(t)
  }, [ghosts.size])
  const names = useActorNames([...new Set([...ghosts.values()].map((g) => g.userId))])

  const lastSentRef = useRef<string>('')
  const send = useCallback(
    (item: string, phase: 'move' | 'end' | 'cancel', pos?: DragPosition) => {
      if (!realtime || !enabled) return
      const sig = `${item}|${phase}|${JSON.stringify(pos ?? null)}`
      if (phase === 'move' && sig === lastSentRef.current) return
      lastSentRef.current = sig
      realtime.emit('record:drag', {
        collection: opts.collection,
        item,
        view: viewRef.current,
        phase,
        ...(pos ?? {})
      })
    },
    [realtime, enabled, opts.collection]
  )
  const move = useCallback((item: string, pos: DragPosition) => send(item, 'move', pos), [send])
  const finish = useCallback(
    (item: string, pos?: DragPosition) => {
      send(item, pos ? 'end' : 'cancel', pos)
      lastSentRef.current = ''
    },
    [send]
  )
  return { ghosts, names, move, finish }
}

// ── Drops that never silently overwrite ──────────────────────────────────

/** The record's newest revision now — the base a drag starts from (null = none / unknown). */
export async function dragBaseRevision(
  client: Pick<NivaroClient, 'request'>,
  collection: string,
  id: string
): Promise<number | null> {
  try {
    const r = await client.request<{ data: Record<string, number | null> }>(
      get('/revisions/latest', { collection, items: id })
    )
    const v = r?.data?.[id]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

export type DropResult =
  | { ok: true }
  | {
      ok: false
      /** The record as the newer save left it, read as this person (null = could not read). */
      current: Record<string, unknown> | null
      /** The newest revision: "Use yours" saves against it. */
      latest: number
    }

/**
 * Save a drop: `body` (the moved date fields) with the drag's base revision. A newer save by
 * someone else to the same fields answers a clash with the record re-read as this person; any
 * other error is thrown (the caller says it through toastError).
 */
export async function saveDrop(
  client: Pick<NivaroClient, 'request'>,
  collection: string,
  id: string,
  body: Record<string, unknown>,
  base: number | null
): Promise<DropResult> {
  try {
    await client.request(patch(`/items/${collection}/${id}`, withRowBaseRevision(body, base)))
    return { ok: true }
  } catch (err) {
    const coll = midairCollisionOf(err)
    if (!coll) throw err
    const current = await client
      .request<{ data?: Record<string, unknown> | null }>(get(`/items/${collection}/${id}`))
      .then((r) => r?.data ?? null)
      .catch(() => null)
    return { ok: false, current, latest: coll.latest }
  }
}

/** Who made the newer save, from the viewer's own read (null = unknown). */
export function clashWriter(current: Record<string, unknown> | null): string | null {
  return writerOf(current)
}
