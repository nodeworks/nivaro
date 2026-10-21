import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get, post } from './commands'
import { useLiveEvent } from './live'
import {
  type SignalPerson,
  useMyUserId,
  useRecordSignalPeers,
  useRecordSignalWhile
} from './presence-signals'
import { useOptionalRealtime, useRealtimeStatus } from './realtime'

/**
 * Presence hooks for headless frontends (#2487, #2486), over the host's realtime adapter —
 * the socket the host already holds (`createSocketRealtime`, or the shared worker's facade).
 * Without an adapter every hook is inert and returns nothing, like the live hooks.
 *
 *   usePresence('orders', id)        → { viewers }              who else has this record open
 *   useFieldFocus('orders', id)      → { editing, focus, blur } the field (or grid cell) each
 *                                                               person is in, and your own
 *   useTyping('orders', id)          → { typing, setTyping }    "Beth is writing a note"
 *   useRowPresence('orders', ids)    → { [id]: { ids, count } } who has each list row open
 *
 * All of it is names-only and server-gated: the record room admits only people who may open
 * the record (the read gate), `presence:rows` carries user ids and the names come from
 * `GET /presence/people`, which answers only with people the viewer may see.
 *
 * The admin's own record page keeps `useRecordPresence` (its record room rides a tab-local
 * socket when the shared worker is off); these hooks need an adapter whose `emit` reaches a
 * socket this tab owns, which `createSocketRealtime` and the worker facade both give.
 */

export interface RecordPresence {
  /** The OTHER people with this record open right now. */
  viewers: SignalPerson[]
}

/** Re-send a join after every reconnect: a reconnect is a new server socket with no rooms. */
function useRejoin(fn: () => void, enabled: boolean): void {
  const status = useRealtimeStatus()
  const wasDown = useRef(false)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!enabled) return
    if (status?.state === 'reconnecting') wasDown.current = true
    else if (wasDown.current) {
      wasDown.current = false
      fnRef.current()
    }
  }, [status?.state, enabled])
}

/** Who else is viewing one record (joins its room; names only). */
export function usePresence(
  collection: string | null | undefined,
  item: string | number | null | undefined
): RecordPresence {
  const realtime = useOptionalRealtime()
  const me = useMyUserId()
  const id = item == null ? '' : String(item)
  const enabled = !!realtime && !!collection && !!id && id !== 'new'
  const [viewers, setViewers] = useState<SignalPerson[]>([])
  const join = useCallback(() => {
    if (enabled) realtime?.emit('record:join', { collection, item: id })
  }, [realtime, collection, id, enabled])
  useEffect(() => {
    setViewers([])
    if (!enabled) return
    join()
    return () => realtime?.emit('record:leave', { collection, item: id })
  }, [realtime, collection, id, enabled, join])
  useRejoin(join, enabled)
  useLiveEvent(
    'record:viewers',
    (p) => {
      if (Array.isArray(p?.viewers)) setViewers(p.viewers as SignalPerson[])
    },
    {
      enabled,
      includeOwn: true,
      // An older server names no record: accept, as the hosts' own hooks do.
      match: (p) =>
        p?.collection == null || p?.item == null
          ? true
          : p.collection === collection && String(p.item) === id
    }
  )
  const others = useMemo(
    () => viewers.filter((v) => !me || String(v.id).toUpperCase() !== me.toUpperCase()),
    [viewers, me]
  )
  return { viewers: others }
}

export interface FieldFocus {
  /** field name (or `row:<collection>:<id>` / `cell:<collection>:<row>:<field>`) → who is in it. */
  editing: Record<string, SignalPerson>
  /** Tell the record's other viewers you are in this field. */
  focus: (field: string) => void
  /** …and that you left it. */
  blur: (field: string) => void
}

export interface FieldFocusOptions {
  /**
   * Watch the document for focus moving between `[data-field]` wrappers (what the shared
   * form renders around every field) and send focus/blur yourself. Off by default: a host
   * that already relays focus (the admin) must not send it twice.
   */
  capture?: boolean
}

/** Which field or grid cell each co-viewer is editing, and a way to announce your own. */
export function useFieldFocus(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  opts: FieldFocusOptions = {}
): FieldFocus {
  const realtime = useOptionalRealtime()
  const me = useMyUserId()
  const id = item == null ? '' : String(item)
  const enabled = !!realtime && !!collection && !!id && id !== 'new'
  const [editing, setEditing] = useState<Record<string, SignalPerson>>({})
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different record starts empty
  useEffect(() => setEditing({}), [collection, id])
  useLiveEvent(
    'field:editing',
    (p) => {
      if (typeof p?.field !== 'string') return
      setEditing((prev) => {
        const next = { ...prev }
        const user = p.user as SignalPerson | null | undefined
        if (user && (!me || String(user.id).toUpperCase() !== me.toUpperCase()))
          next[p.field] = user
        else delete next[p.field]
        return next
      })
    },
    {
      enabled,
      includeOwn: true,
      match: (p) =>
        p?.collection == null || p?.item == null
          ? true
          : p.collection === collection && String(p.item) === id
    }
  )
  const focus = useCallback(
    (field: string) => {
      if (enabled && field) realtime?.emit('field:focus', { field, collection, item: id })
    },
    [realtime, collection, id, enabled]
  )
  const blur = useCallback(
    (field: string) => {
      if (enabled && field) realtime?.emit('field:blur', { field, collection, item: id })
    },
    [realtime, collection, id, enabled]
  )
  useEffect(() => {
    if (!enabled || !opts.capture || typeof document === 'undefined') return
    const fieldOf = (e: Event) =>
      (e.target as HTMLElement | null)?.closest?.('[data-field]')?.getAttribute('data-field')
    const onIn = (e: Event) => {
      const f = fieldOf(e)
      if (f) focus(f)
    }
    const onOut = (e: Event) => {
      const f = fieldOf(e)
      if (f) blur(f)
    }
    document.addEventListener('focusin', onIn)
    document.addEventListener('focusout', onOut)
    return () => {
      document.removeEventListener('focusin', onIn)
      document.removeEventListener('focusout', onOut)
    }
  }, [enabled, opts.capture, focus, blur])
  return { editing, focus, blur }
}

export interface Typing {
  /** Names of the other people writing a note on this record right now. */
  typing: string[]
  /** Call with true while the person types (it repeats the heartbeat), false when they stop. */
  setTyping: (active: boolean) => void
}

/** "Beth is writing a note" on a record's comment thread, both directions. */
export function useTyping(
  collection: string | null | undefined,
  item: string | number | null | undefined
): Typing {
  const typing = useRecordSignalPeers(collection, item, 'note')
  const [active, setActive] = useState(false)
  useRecordSignalWhile(collection, item, 'note', active)
  // A keystroke burst that stops without an explicit false lapses on its own.
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setTyping = useCallback((on: boolean) => {
    if (stopTimer.current) clearTimeout(stopTimer.current)
    stopTimer.current = null
    setActive(on)
    if (on) stopTimer.current = setTimeout(() => setActive(false), 6_000)
  }, [])
  useEffect(
    () => () => {
      if (stopTimer.current) clearTimeout(stopTimer.current)
    },
    []
  )
  return { typing, setTyping }
}

// ── List rows (#2486) ───────────────────────────────────────────────────────

export interface RowViewers {
  /** The OTHER people with the row open whom the viewer may see (names resolvable). */
  ids: string[]
  /** Everyone else with it open, visible or not (the count the chip shows). */
  count: number
}

export interface RowRef {
  collection: string
  item: string | number
}

export interface RowPresenceOptions {
  enabled?: boolean
  /** Without a realtime adapter, poll counts this often (0 = never). Default 30 000. */
  pollMs?: number
}

const EMPTY_ROWS: Record<string, RowViewers> = {}

export function rowPresenceKey(collection: string, item: string | number): string {
  return `${collection}:${item}`
}

/** Only the ids the viewer may see as people (`/presence/people`'s visibility rule). */
function useVisiblePeople(ids: string[]): Set<string> | null {
  const client = useOptionalNivaroClient()
  const key = [...new Set(ids.map((i) => i.toUpperCase()))].sort().join(',')
  const { data } = useQuery({
    queryKey: ['presence-visible-people', key],
    queryFn: () =>
      client!
        .request<{ data: Array<{ user_id: string }> }>(
          get(`/presence/people?ids=${encodeURIComponent(key.split(',').slice(0, 100).join(','))}`)
        )
        .then((r) => new Set((r.data ?? []).map((p) => String(p.user_id).toUpperCase())))
        .catch(() => new Set<string>()),
    enabled: !!client && key.length > 0,
    staleTime: 5 * 60_000
  })
  return key.length === 0 ? null : (data ?? null)
}

/** Group row keys by collection for the watch messages (100 items each). */
function groupRows(keys: Iterable<string>): Array<{ collection: string; items: string[] }> {
  const by = new Map<string, string[]>()
  for (const key of keys) {
    const i = key.indexOf(':')
    if (i <= 0) continue
    const c = key.slice(0, i)
    const list = by.get(c) ?? []
    list.push(key.slice(i + 1))
    by.set(c, list)
  }
  const out: Array<{ collection: string; items: string[] }> = []
  for (const [collection, items] of by)
    for (let i = 0; i < items.length; i += 100)
      out.push({ collection, items: items.slice(i, i + 100) })
  return out
}

/**
 * Who has each of these rows open, keyed `collection:item`: live through the presence room
 * (`presence:watch` → `presence:rows`), a 30 s count poll when the host has no realtime
 * adapter. The viewer's own tabs are left out. Rows may span collections (a queue).
 */
export function useRowPresence(
  rows: RowRef[],
  opts: RowPresenceOptions = {}
): Record<string, RowViewers> {
  const realtime = useOptionalRealtime()
  const client = useOptionalNivaroClient()
  const me = useMyUserId()
  const enabled = opts.enabled !== false && rows.length > 0
  const keysKey = rows
    .filter((r) => r.collection && r.item != null)
    .map((r) => rowPresenceKey(r.collection, r.item))
    .join('\u0001')
  const [raw, setRaw] = useState<Record<string, string[]>>({})
  const [counts, setCounts] = useState<Record<string, number>>({})
  const held = useRef<Set<string>>(new Set())

  const watchAll = useCallback(() => {
    if (!realtime || !enabled) return
    for (const g of groupRows(held.current)) realtime.emit('presence:watch', g)
  }, [realtime, enabled])
  // Watch the page's rows; a change of page watches the new ones and releases the rest.
  useEffect(() => {
    if (!realtime || !enabled) return
    const want = new Set(keysKey.split('\u0001').filter(Boolean))
    const add = [...want].filter((k) => !held.current.has(k))
    const drop = [...held.current].filter((k) => !want.has(k))
    held.current = want
    for (const g of groupRows(add)) realtime.emit('presence:watch', g)
    if (drop.length) {
      for (const g of groupRows(drop)) realtime.emit('presence:unwatch', g)
      setRaw((prev) => {
        const next = { ...prev }
        for (const d of drop) delete next[d]
        return next
      })
    }
  }, [realtime, keysKey, enabled])
  useEffect(() => {
    if (!realtime) return
    return () => {
      if (held.current.size) realtime.emit('presence:unwatch', {})
      held.current = new Set()
      setRaw({})
    }
  }, [realtime])
  useRejoin(watchAll, !!realtime && enabled)
  useLiveEvent(
    'presence:rows',
    (p) => {
      if (!p?.collection || p?.item == null) return
      const key = rowPresenceKey(String(p.collection), String(p.item))
      const ids = (Array.isArray(p.user_ids) ? p.user_ids : []).map(String)
      setRaw((prev) => {
        const next = { ...prev }
        if (ids.length) next[key] = ids
        else delete next[key]
        return next
      })
    },
    { enabled: !!realtime && enabled, includeOwn: true }
  )

  // No adapter: counts only, polled (what the queues did before).
  useEffect(() => {
    if (realtime || !client || !enabled) return
    const pollMs = opts.pollMs ?? 30_000
    const pairs = keysKey
      .split('\u0001')
      .filter(Boolean)
      .slice(0, 100)
      .map((k) => {
        const i = k.indexOf(':')
        return { collection: k.slice(0, i), item_id: k.slice(i + 1) }
      })
    let alive = true
    const load = () => {
      client
        .request<{ data: Record<string, number> }>(post('/presence/record-viewers', { pairs }))
        .then((r) => {
          if (alive) setCounts(r.data ?? {})
        })
        .catch(() => {})
    }
    load()
    const t = pollMs > 0 ? setInterval(load, pollMs) : null
    return () => {
      alive = false
      if (t) clearInterval(t)
    }
  }, [realtime, client, keysKey, enabled, opts.pollMs])

  const allIds = useMemo(() => [...new Set(Object.values(raw).flat())], [raw])
  const visible = useVisiblePeople(allIds)

  return useMemo(() => {
    if (!enabled) return EMPTY_ROWS
    const out: Record<string, RowViewers> = {}
    const meKey = me?.toUpperCase()
    if (realtime) {
      for (const [key, ids] of Object.entries(raw)) {
        const others = ids.filter((i) => i.toUpperCase() !== meKey)
        if (others.length === 0) continue
        out[key] = {
          ids: visible ? others.filter((i) => visible.has(i.toUpperCase())) : [],
          count: others.length
        }
      }
    } else {
      // The poll counts the viewer's own tab too; the chip shows at 2+ like before.
      for (const [key, n] of Object.entries(counts)) if (n > 1) out[key] = { ids: [], count: n - 1 }
    }
    return out
  }, [enabled, realtime, raw, counts, visible, me])
}
