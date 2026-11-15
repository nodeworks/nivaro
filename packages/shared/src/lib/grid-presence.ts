import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createCellAnnouncer, cursorColor, markRemoteCell } from './grid-cursors'
import { useLiveEvent } from './live'
import { useLivePreference } from './live-preference'
import { useMyUserId } from './presence-signals'
import { useOptionalRealtime, useRealtimeStatus } from './realtime'

/**
 * Who is editing on a budget / planning page (realtime round 8, item 22) — the client half of
 * api services/grid-presence.ts. A grid that edits many records at once (the forecast
 * worksheet, an allocation matrix, a browse-then-edit record grid) calls
 *
 *   const { editors } = useGridPresence({ page, collection, items, containerRef })
 *
 * and renders `<GridPresenceLine editors={editors} … />` near its toolbar. Cells that should
 * carry the cursor wear `data-grid-cell={gridPresenceCell(item, field)}`:
 *   - focus moving between those cells inside `containerRef` is announced (throttled by the
 *     grid cursor announcer: only the cell the person stops on; a heartbeat while they stay);
 *   - someone else's cell is outlined in their colour with their name on hover (the same
 *     `markRemoteCell` the record grids use, so admin and efp-new CSS already style it).
 *
 * The server admits a watcher to a record's grid room only after the record read gate passes
 * as that watcher, and a sender only for records they may read — so the line never names a row
 * the viewer cannot open. Names, ids, a page key and a cell name only; never values.
 * Calm / Off: nothing shown (the event is quieted, marks are cleared); the person's own cursor
 * is still announced so others keep seeing them, as with record presence.
 */

/** Must match api services/grid-presence.ts. */
export const GRID_HEARTBEAT_MS = 20_000
export const GRID_MARK_TTL_MS = 50_000
/** Records one page watches at most (the server allows 400 per socket). */
export const GRID_WATCH_LIMIT = 300

export interface GridEditor {
  userId: string
  name: string
  item: string
  field: string | null
  page: string
  at: number
  color: string
}

const CELL_PREFIX = 'pg|'

/** The `data-grid-cell` value of a presence-tracked cell. */
export function gridPresenceCell(item: string | number, field: string): string {
  return `${CELL_PREFIX}${item}|${field}`
}

export function parseGridPresenceCell(
  v: string | null | undefined
): { item: string; field: string } | null {
  if (!v?.startsWith(CELL_PREFIX)) return null
  const rest = v.slice(CELL_PREFIX.length)
  const i = rest.indexOf('|')
  if (i <= 0 || i === rest.length - 1) return null
  return { item: rest.slice(0, i), field: rest.slice(i + 1) }
}

interface EditingPayload {
  collection?: unknown
  item?: unknown
  field?: unknown
  page?: unknown
  state?: unknown
  user?: { id?: unknown; name?: unknown } | null
}

/** Fold one `grid:editing` into the book (keyed by person + page; pure). */
export function foldGridEditing(
  prev: ReadonlyMap<string, GridEditor>,
  p: EditingPayload,
  me: string | null,
  now: number
): Map<string, GridEditor> {
  const next = new Map(prev)
  const uid = p?.user?.id == null ? '' : String(p.user.id)
  if (!uid || typeof p.page !== 'string' || p.item == null) return next
  if (me && uid.toUpperCase() === me.toUpperCase()) return next
  const key = `${uid.toUpperCase()}|${p.page}`
  if (p.state === 'end') {
    const cur = next.get(key)
    if (cur && cur.item === String(p.item)) next.delete(key)
    return next
  }
  next.set(key, {
    userId: uid,
    name: typeof p.user?.name === 'string' && p.user.name ? p.user.name : 'Someone',
    item: String(p.item),
    field: typeof p.field === 'string' ? p.field : null,
    page: p.page,
    at: now,
    color: cursorColor(uid)
  })
  return next
}

/** The marks still fresh, by name (stable order for the line). */
export function freshGridEditors(
  book: ReadonlyMap<string, GridEditor>,
  now: number,
  ttl = GRID_MARK_TTL_MS
): GridEditor[] {
  return [...book.values()]
    .filter((e) => now - e.at <= ttl)
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId))
}

export interface GridPresenceOptions {
  /** Which page this is (`forecast-worksheet`, `matrix:allocations`…); only the same page's
   *  marks show. Letters, digits and `_.:-`, up to 64. */
  page: string
  /** The collection of the records each row stands for — the read gate is that record's. */
  collection: string | null | undefined
  /** The records on screen. */
  items: Array<string | number>
  /** The grid: focus inside it is announced and others' cells are outlined inside it. */
  containerRef?: RefObject<HTMLElement | null>
  enabled?: boolean
}

export interface GridPresence {
  /** The OTHER people editing on this page now (empty in Calm / Off). */
  editors: GridEditor[]
}

const EMPTY: GridEditor[] = []

export function useGridPresence(opts: GridPresenceOptions): GridPresence {
  const realtime = useOptionalRealtime()
  const status = useRealtimeStatus()
  const me = useMyUserId()
  const live = useLivePreference()
  const { page, collection, containerRef } = opts
  const enabled = opts.enabled !== false && !!realtime && !!collection && !!page
  const itemsKey = useMemo(
    () =>
      [...new Set(opts.items.map(String).filter((s) => s && s !== 'new'))]
        .slice(0, GRID_WATCH_LIMIT)
        .join('\u0001'),
    [opts.items]
  )

  // ── Watch the page's records (diffed; released on unmount) ──────────────
  const held = useRef<Set<string>>(new Set())
  const send = useCallback(
    (event: 'grid:watch' | 'grid:unwatch', items: string[]) => {
      for (let i = 0; i < items.length; i += 100)
        realtime?.emit(event, { collection, items: items.slice(i, i + 100) })
    },
    [realtime, collection]
  )
  useEffect(() => {
    if (!enabled) return
    const want = new Set(itemsKey.split('\u0001').filter(Boolean))
    const add = [...want].filter((k) => !held.current.has(k))
    const drop = [...held.current].filter((k) => !want.has(k))
    held.current = want
    if (add.length) send('grid:watch', add)
    if (drop.length) send('grid:unwatch', drop)
  }, [enabled, itemsKey, send])
  useEffect(() => {
    if (!enabled) return
    return () => {
      if (held.current.size) send('grid:unwatch', [...held.current])
      held.current = new Set()
    }
  }, [enabled, send])
  // A reconnect is a new server socket with no rooms: watch again, say where we are again.
  const wasDown = useRef(false)
  const announcedRef = useRef<{ item: string; field: string } | null>(null)
  useEffect(() => {
    if (!enabled) return
    if (status?.state === 'reconnecting') wasDown.current = true
    else if (wasDown.current) {
      wasDown.current = false
      if (held.current.size) send('grid:watch', [...held.current])
      const a = announcedRef.current
      if (a) realtime?.emit('grid:here', { collection, page, ...a, state: 'start' })
    }
  }, [status?.state, enabled, send, realtime, collection, page])

  // ── Announce our own cell ───────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef?.current
    if (!enabled || !el) return
    const emit = (cell: string, state: 'start' | 'end') => {
      const c = parseGridPresenceCell(cell)
      if (!c) return
      announcedRef.current = state === 'start' ? c : null
      realtime?.emit('grid:here', { collection, page, item: c.item, field: c.field, state })
    }
    const announcer = createCellAnnouncer(emit)
    const cellOf = (t: EventTarget | null): string | null => {
      const v = (t as HTMLElement | null)
        ?.closest?.('[data-grid-cell]')
        ?.getAttribute('data-grid-cell')
      return parseGridPresenceCell(v) ? (v as string) : null
    }
    const onIn = (e: FocusEvent) => {
      const cell = cellOf(e.target)
      if (cell) announcer.focus(cell)
    }
    const onOut = (e: FocusEvent) => {
      const next = e.relatedTarget as HTMLElement | null
      const cell = next && el.contains(next) ? cellOf(next) : null
      if (cell) announcer.focus(cell)
      else announcer.blur()
    }
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    const beat = setInterval(() => {
      const a = announcedRef.current
      if (a) realtime?.emit('grid:here', { collection, page, ...a, state: 'start' })
    }, GRID_HEARTBEAT_MS)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
      clearInterval(beat)
      announcer.flush()
      announcedRef.current = null
    }
  }, [enabled, containerRef, realtime, collection, page])

  // ── Others ─────────────────────────────────────────────────────────────
  const [book, setBook] = useState<Map<string, GridEditor>>(() => new Map())
  const [now, setNow] = useState(() => Date.now())
  // biome-ignore lint/correctness/useExhaustiveDependencies: another page or collection starts empty
  useEffect(() => setBook(new Map()), [page, collection])
  useLiveEvent(
    'grid:editing',
    (p: EditingPayload) => {
      const t = Date.now()
      setBook((prev) => foldGridEditing(prev, p, me, t))
      setNow(t)
    },
    {
      enabled,
      includeOwn: true,
      match: (p) => p?.collection === collection && p?.page === page
    }
  )
  // Marks nobody repeated fade on their own (a lost end, a replica that went away).
  useEffect(() => {
    if (!enabled || book.size === 0) return
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [enabled, book.size])
  const shown = live.normal && enabled
  const editors = useMemo(() => (shown ? freshGridEditors(book, now) : EMPTY), [shown, book, now])

  // ── Outline others' cells ──────────────────────────────────────────────
  // Re-applied after every render of the grid's host (a re-rendered cell drops the class).
  useEffect(() => {
    const el = containerRef?.current
    if (!el || editors.length === 0) return
    const undo: Array<() => void> = []
    for (const e of editors) {
      if (!e.field) continue
      const cell = el.querySelector<HTMLElement>(
        `[data-grid-cell="${cssEscape(gridPresenceCell(e.item, e.field))}"]`
      )
      if (cell) undo.push(markRemoteCell(cell, { id: e.userId, name: e.name }))
    }
    return () => {
      for (const u of undo) u()
    }
  })

  return { editors }
}

/** A page key from parts (`matrix`, a collection, the other scope values): short, stable,
 *  within the server's page-key alphabet. */
export function gridPageKey(kind: string, ...parts: string[]): string {
  let h = 5381
  const s = parts.join('\u0001')
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${kind.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}:${(h >>> 0).toString(36)}`
}

function cssEscape(v: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(v)
  return v.replace(/["\\]/g, '\\$&')
}
