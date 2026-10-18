import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../context'
import { get, post } from './commands'
import { useLiveCollection } from './live'
import { loadUserCard } from './user-cards'

/**
 * Shared pieces of the "lists update live" surfaces (collection browser,
 * queues, saved-view pills, calendar / Gantt / map). Transport and batching
 * live in live.ts; this file is what a list does WITH a batch:
 *
 * - `useRowChanges` remembers which rows others just changed (flash + a
 *   "changed by Beth just now" tooltip, plus the "new" mark on a row that
 *   slid in), and `flashRows` plays the fade — Web Animations, so it never
 *   fights the row-enter CSS animation, and reduced motion gets no fade.
 * - `useRowLocks` asks the server which of the visible rows are being edited
 *   right now (the server only answers for rows the viewer can read).
 * - `viewerMatches` is the "does this record belong in this list" question —
 *   answered by a normal `/items` read as the VIEWER with the list's own
 *   conditions plus `id in (…)`, never by the client re-implementing filters.
 */

// ── Row changes (flash + changed-by tooltip + new mark) ───────────────────

export interface RowChange {
  at: number
  /** User id of the writer (null: a system / raw write that named nobody). */
  by: string | null
  kind: 'update' | 'create'
}

const CHANGE_TTL_MS = 60_000
const NEW_TTL_MS = 60_000
const MAX_TRACKED = 400

/** "just now" / "20s ago" / "3 min ago" for the tooltip. */
export function agoLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  return `${Math.round(s / 60)} min ago`
}

/** Tooltip text for a changed row — exported for tests. */
export function changeTitle(change: RowChange, name: string | null, now = Date.now()): string {
  const when = agoLabel(change.at, now)
  const who = name ?? (change.by ? 'someone' : null)
  if (change.kind === 'create') return who ? `New — added by ${who} ${when}` : `New — added ${when}`
  return who ? `Changed by ${who} ${when}` : `Changed ${when}`
}

/** Fade the cells of rows `ids` (matched by `data-row-key`) inside `root`. */
export function flashRows(
  root: ParentNode | null | undefined,
  ids: string[],
  opts: { strong?: boolean } = {}
): void {
  if (!root || ids.length === 0 || typeof window === 'undefined') return
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  } catch {
    /* no matchMedia — flash anyway */
  }
  const tint = opts.strong ? 0.34 : 0.22
  for (const id of ids) {
    const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"')
    const row = root.querySelector(`[data-row-key="${esc}"]`)
    if (!row) continue
    for (const cell of Array.from(row.children)) {
      const el = cell as HTMLElement
      if (typeof el.animate !== 'function') continue
      el.animate(
        [
          { boxShadow: `inset 0 0 0 9999px rgba(0, 206, 255, ${tint})` },
          { boxShadow: 'inset 0 0 0 9999px rgba(0, 206, 255, 0)' }
        ],
        { duration: opts.strong ? 2600 : 1800, easing: 'ease-out' }
      )
    }
  }
}

/** Display name of a user id, from the (authenticated) contact-card route. */
function useActorNames(ids: string[]): Map<string, string> {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [names, setNames] = useState<Map<string, string>>(() => new Map())
  const key = ids.join(',')
  useEffect(() => {
    let live = true
    const wanted = key ? key.split(',') : []
    for (const id of wanted) {
      void qc
        .fetchQuery({
          queryKey: ['live-actor-name', id.toUpperCase()],
          queryFn: () =>
            loadUserCard(client, id).then(
              (d) => [d?.first_name, d?.last_name].filter(Boolean).join(' ') || d?.email || ''
            ),
          staleTime: 10 * 60_000
        })
        .then((name) => {
          if (!live || !name) return
          setNames((prev) => (prev.get(id) === name ? prev : new Map(prev).set(id, name)))
        })
        .catch(() => {})
    }
    return () => {
      live = false
    }
  }, [key, qc, client])
  return names
}

export interface RowChanges {
  /** Record that rows `ids` changed (call from the live handler). Returns nothing. */
  note: (ids: string[], by: string | null, kind?: RowChange['kind']) => void
  /** Tooltip for a row someone else just changed, or undefined. */
  titleFor: (id: string) => string | undefined
  /** True for a row that slid in as new a moment ago. */
  isNew: (id: string) => boolean
  /** Drop a row's mark (e.g. it left the list). */
  forget: (ids: string[]) => void
  /** Put on the element that CONTAINS the rows: flashes run inside it. */
  rootRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Remembers recent changes by others for a list. `note` is safe to call from a
 * socket callback; the fade plays after the next paint so the row is there.
 */
export function useRowChanges(): RowChanges {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const changesRef = useRef(new Map<string, RowChange>())
  const [, setTick] = useState(0)
  const flashQueue = useRef<{ ids: string[]; strong: boolean }[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [actorIds, setActorIds] = useState<string[]>([])
  const names = useActorNames(actorIds)

  const prune = useCallback(() => {
    const now = Date.now()
    let changed = false
    for (const [id, c] of changesRef.current) {
      if (now - c.at > (c.kind === 'create' ? NEW_TTL_MS : CHANGE_TTL_MS)) {
        changesRef.current.delete(id)
        changed = true
      }
    }
    if (changed) setTick((n) => n + 1)
    if (changesRef.current.size > 0) timer.current = setTimeout(prune, 10_000)
    else timer.current = null
  }, [])

  const note = useCallback(
    (ids: string[], by: string | null, kind: RowChange['kind'] = 'update') => {
      const at = Date.now()
      for (const id of ids) {
        if (id === '*') continue
        changesRef.current.set(id, { at, by, kind })
      }
      if (changesRef.current.size > MAX_TRACKED) {
        const drop = [...changesRef.current.keys()].slice(0, changesRef.current.size - MAX_TRACKED)
        for (const k of drop) changesRef.current.delete(k)
      }
      flashQueue.current.push({ ids: ids.filter((i) => i !== '*'), strong: kind === 'create' })
      if (by) setActorIds((prev) => (prev.includes(by) ? prev : [...prev, by].slice(-30)))
      setTick((n) => n + 1)
      if (!timer.current) timer.current = setTimeout(prune, 10_000)
    },
    [prune]
  )

  // Play queued fades once React has painted the (possibly new) rows.
  useEffect(() => {
    if (flashQueue.current.length === 0) return
    const queued = flashQueue.current
    flashQueue.current = []
    const raf = requestAnimationFrame(() => {
      for (const q of queued) flashRows(rootRef.current ?? document, q.ids, { strong: q.strong })
    })
    return () => cancelAnimationFrame(raf)
  })

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const titleFor = useCallback(
    (id: string) => {
      const c = changesRef.current.get(id)
      if (!c) return undefined
      const direct = c.by ? (names.get(c.by) ?? null) : null
      return changeTitle(c, direct)
    },
    // names changing re-renders the list; tooltips are read at render time
    [names]
  )
  const isNew = useCallback((id: string) => changesRef.current.get(id)?.kind === 'create', [])
  const forget = useCallback((ids: string[]) => {
    for (const id of ids) changesRef.current.delete(id)
  }, [])

  return useMemo(
    () => ({ note, titleFor, isNew, forget, rootRef }),
    [note, titleFor, isNew, forget]
  )
}

// ── Edit locks on rows ────────────────────────────────────────────────────

export interface RowLock {
  locked_by: string
  locked_by_name: string | null
  is_mine: boolean
}

/**
 * Who is editing which of `ids` right now. `refreshKey` bumps re-ask (a `$lock`
 * notice arrived). Collections with locking off, or rows the viewer cannot
 * read, simply produce no entries.
 */
export function useRowLocks(
  collection: string | null | undefined,
  ids: string[],
  refreshKey = 0
): Map<string, RowLock> {
  const client = useNivaroClient()
  const idsKey = ids.slice(0, 200).join(',')
  const { data } = useQuery({
    queryKey: ['live-row-locks', collection, idsKey, refreshKey],
    queryFn: () =>
      client
        .request<{ data: Array<RowLock & { item: string }> }>(
          post(`/item-locks/${encodeURIComponent(String(collection))}/active`, {
            ids: idsKey.split(',')
          })
        )
        .then((r) => r.data ?? [])
        .catch(() => [] as Array<RowLock & { item: string }>),
    enabled: !!collection && idsKey !== '' && !String(collection).startsWith('nivaro_'),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
    retry: false
  })
  return useMemo(() => {
    const m = new Map<string, RowLock>()
    for (const l of data ?? []) m.set(String(l.item), l)
    return m
  }, [data])
}

/**
 * Locks for rows from several collections (a queue): one ask per collection,
 * keyed `${collection}:${id}` in the result.
 */
export function useRowLocksByCollection(
  rows: Array<{ collection: string; id: string }>,
  refreshKey = 0
): Map<string, RowLock> {
  const client = useNivaroClient()
  const byCollection = new Map<string, string[]>()
  for (const r of rows) {
    if (r.collection.startsWith('nivaro_')) continue
    const list = byCollection.get(r.collection) ?? []
    if (list.length < 200) list.push(r.id)
    byCollection.set(r.collection, list)
  }
  const entries = [...byCollection.entries()].slice(0, 12)
  const results = useQueries({
    queries: entries.map(([collection, ids]) => ({
      queryKey: ['live-row-locks', collection, ids.join(','), refreshKey],
      queryFn: () =>
        client
          .request<{ data: Array<RowLock & { item: string }> }>(
            post(`/item-locks/${encodeURIComponent(collection)}/active`, { ids })
          )
          .then((r) => r.data ?? [])
          .catch(() => [] as Array<RowLock & { item: string }>),
      staleTime: 15_000,
      placeholderData: (prev: Array<RowLock & { item: string }> | undefined) => prev,
      retry: false
    }))
  })
  const stamp = results.map((r) => r.dataUpdatedAt).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stamp string is the dependency (useQueries results are a fresh array each render)
  return useMemo(() => {
    const m = new Map<string, RowLock>()
    results.forEach((r, i) => {
      for (const l of r.data ?? []) m.set(`${entries[i][0]}:${l.item}`, l)
    })
    return m
  }, [stamp])
}

/** "Beth is editing" for a lock icon's tooltip. */
export function lockLabel(lock: RowLock): string {
  if (lock.is_mine) return 'You are editing this'
  return `${lock.locked_by_name ?? 'Someone'} is editing this`
}

// ── Does a record belong in this list? (as the viewer) ────────────────────

export interface LiveCondition {
  path: string[]
  op: string
  value: unknown
}

/**
 * Of `ids`, which does the VIEWER's own read of `collection` return under the
 * list's `conditions` (a compiled JSON string, or undefined for none) and
 * `search`? Answered by the server through the normal items route, so row
 * filters, User Scopes and field policies apply exactly as for the list.
 * Returns the matching rows (default columns) keyed by id.
 */
export async function viewerMatches(
  client: ReturnType<typeof useNivaroClient>,
  collection: string,
  ids: string[],
  conditions: string | undefined,
  search?: string
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  const asked = [...new Set(ids)].filter((i) => i && i !== '*').slice(0, 100)
  if (asked.length === 0) return out
  let base: unknown[] = []
  try {
    base = conditions ? (JSON.parse(conditions) as unknown[]) : []
  } catch {
    base = []
  }
  const all = [...base, { path: ['id'], op: '_in', value: asked }]
  const res = await client.request<{ data: Array<Record<string, unknown>> }>(
    get(`/items/${collection}`, {
      limit: asked.length,
      conditions: JSON.stringify(all),
      ...(search ? { search } : {})
    })
  )
  for (const row of res.data ?? []) out.set(String(row.id), row)
  return out
}

/** Top-level field names a compiled conditions string reads (for "could this change newly match?"). */
export function conditionFields(conditions: string | undefined): Set<string> {
  const out = new Set<string>()
  if (!conditions) return out
  const walk = (c: unknown) => {
    if (!c || typeof c !== 'object') return
    const o = c as { path?: unknown; or?: unknown; and?: unknown }
    if (Array.isArray(o.path) && typeof o.path[0] === 'string') out.add(o.path[0])
    for (const k of [o.or, o.and]) if (Array.isArray(k)) k.forEach(walk)
  }
  try {
    const parsed = JSON.parse(conditions)
    if (Array.isArray(parsed)) parsed.forEach(walk)
  } catch {
    /* unparseable — no known fields */
  }
  return out
}

/**
 * Can this batch have changed whether a record matches the list's filter?
 * An event with no field names (a create, a bulk write) might; an update only
 * if it touched a field the conditions read.
 */
export function mayAffectMatch(
  event: { action?: string; changed_fields?: string[] },
  fields: Set<string>
): boolean {
  if (event.action === 'create' || event.action === 'delete') return true
  const changed = event.changed_fields
  if (!changed || changed.length === 0) return true
  if (changed.every((f) => f.startsWith('$'))) return false
  if (fields.size === 0) return false
  return changed.some((f) => fields.has(f))
}

// ── Query-backed views (calendar, Gantt, map) ─────────────────────────────

/**
 * Keep a query-backed view current: when other people add, move or
 * reschedule records of `collection`, refetch `keys` quietly (the old data
 * stays on screen until the new arrives — nothing flashes or jumps). Bursts
 * coalesce; aspect-only notices (comments, locks…) never refetch a view that
 * draws columns; focus mode holds the feed back like every other list.
 */
export function useLiveQueryRefresh(
  collection: string | null | undefined,
  keys: unknown[][],
  opts: { debounceMs?: number; enabled?: boolean } = {}
): void {
  const qc = useQueryClient()
  const keysRef = useRef(keys)
  keysRef.current = keys
  useLiveCollection(
    collection,
    (batch) => {
      if (batch.aspectsOnly) return
      for (const k of keysRef.current) void qc.invalidateQueries({ queryKey: k })
    },
    { debounceMs: opts.debounceMs ?? 600, enabled: opts.enabled, focusable: true }
  )
}

/**
 * Who last wrote a row, from the viewer's OWN permission-checked read of it
 * (`user_updated`, present only when the collection has it and the viewer may
 * read that field). The live event itself never names the writer.
 */
export function writerOf(row: Record<string, unknown> | undefined | null): string | null {
  const v = row?.user_updated
  if (typeof v === 'string' && v) return v
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string')
    return (v as { id: string }).id
  return null
}
