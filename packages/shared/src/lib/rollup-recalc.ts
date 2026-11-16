import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { parseRollupSources } from '../components/item-edit/live-rollups'
import { useLiveRecordEvent } from './live'
import { onWriteCommand } from './own-writes'

/**
 * "Updating…" on totals (realtime round 7, item 9).
 *
 * A record's rollup totals (and the computed fields that read them) are re-derived by the
 * server after its lines change (api services/rollups.ts). Until that recalculation and the
 * re-read after it land, the figure on screen is the OLD one — and it must never look final.
 * This hook says which of the record's fields are recalculating right now:
 *
 * - this tab writes a line of the record (any write to a child collection a rollup reads that
 *   names this record as its parent — `?parent_collection=&parent_id=`, as the form and its
 *   line grids send): the totals it feeds are pending from the moment the write is sent until
 *   the record's own re-read after the LAST such write has landed;
 * - someone else's big nested save runs on the record: the server's `record:recalc
 *   {phase: 'start' | 'done', fields}` (record room only, names only) holds them pending until
 *   `done` and the re-read after it.
 *
 * The record is re-read ONCE per burst, as the viewer (the item query is invalidated), so a
 * total whose figure did not move still settles. A safety timeout clears anything left after
 * RECALC_MAX_MS. `landed` names the fields that just settled, for one quiet fade (the CSS
 * drops it in Calm, and under reduced motion).
 */

export const RECALC_MAX_MS = 15_000
/** How long after the last write ends before the record is re-read (lets a rollup event win). */
export const RECALC_REREAD_MS = 350
export const RECALC_LANDED_MS = 1400

export interface RecalcFieldLike {
  field: string
  computed_type?: string | null
  computed_formula?: unknown
}

/**
 * Child collection → the fields of this record a write to it re-derives: each rollup reading
 * that collection, plus computed fields whose formula reads one of those rollups (one hop).
 */
export function recalcFeeds(fields: readonly RecalcFieldLike[] | null | undefined) {
  const out = new Map<string, Set<string>>()
  const list = fields ?? []
  for (const f of list) {
    if (f.computed_type !== 'rollup' || !f.computed_formula) continue
    for (const src of parseRollupSources(f.computed_formula)) {
      const set = out.get(src.related_collection) ?? new Set<string>()
      set.add(f.field)
      out.set(src.related_collection, set)
    }
  }
  // Computed fields read a rollup either as a Liquid token (`{{total}}`) or in an expression
  // (`item.requisition_amount - item.forecast_total`). Follow readers of readers too (Forecast
  // Summary reads Left to Forecast's inputs) until nothing new joins — a figure derived from a
  // recalculating total is stale too and must never look final.
  const reads = (formula: string, name: string) =>
    formula.includes(`{{${name}}}`) || new RegExp(`\\bitem\\.${name}\\b`).test(formula)
  for (const set of out.values()) {
    for (let grew = true; grew; ) {
      grew = false
      for (const f of list) {
        if (f.computed_type === 'rollup' || set.has(f.field) || !f.computed_formula) continue
        const formula =
          typeof f.computed_formula === 'string'
            ? f.computed_formula
            : JSON.stringify(f.computed_formula)
        if ([...set].some((r) => reads(formula, r))) {
          set.add(f.field)
          grew = true
        }
      }
    }
  }
  return out
}

/**
 * A write path → the child collection it writes and the parent it names, or null.
 * `/items/<c>`, `/items/<c>/<id>`, `/items/<c>/batch|bulk`, each with
 * `?parent_collection=…&parent_id=…`.
 */
export function childWriteOf(
  path: string
): { collection: string; parentCollection: string; parentId: string } | null {
  const [p, qs] = path.split('?')
  if (!qs) return null
  const m = /^\/items\/([A-Za-z_][A-Za-z0-9_]*)(?:\/[^/?#]+)?$/.exec(p)
  if (!m) return null
  const q = new URLSearchParams(qs)
  const parentCollection = q.get('parent_collection')
  const parentId = q.get('parent_id')
  if (!parentCollection || !parentId) return null
  return { collection: m[1], parentCollection, parentId }
}

export interface RecalcState {
  /** Fields recalculating now — shown dimmed with "Updating…". */
  pending: ReadonlySet<string>
  /** Fields that just settled (for one fade); cleared after RECALC_LANDED_MS. */
  landed: ReadonlySet<string>
}

const EMPTY: ReadonlySet<string> = new Set()

export function useRollupRecalc(opts: {
  collection: string
  itemId: string | number | null | undefined
  fields: readonly RecalcFieldLike[] | null | undefined
  /** The record query's dataUpdatedAt — a re-read after the burst settles the fields. */
  dataUpdatedAt: number
  /** The record's own query key (re-read once per burst). */
  queryKey: readonly unknown[]
  enabled?: boolean
}): RecalcState {
  const { collection, fields, dataUpdatedAt, enabled = true } = opts
  const id = opts.itemId == null || opts.itemId === 'new' ? null : String(opts.itemId)
  const qc = useQueryClient()
  const feeds = useMemo(() => recalcFeeds(fields), [fields])
  const known = useMemo(() => {
    const s = new Set<string>()
    for (const set of feeds.values()) for (const f of set) s.add(f)
    return s
  }, [feeds])
  const [pending, setPending] = useState<ReadonlySet<string>>(EMPTY)
  const [landed, setLanded] = useState<ReadonlySet<string>>(EMPTY)
  const st = useRef({
    inflight: 0,
    serverOpen: false,
    /** When the burst's last write / the server's `done` ended: a re-read after it settles. */
    endedAt: 0,
    fields: new Set<string>()
  })
  const keyRef = useRef(opts.queryKey)
  keyRef.current = opts.queryKey
  const timers = useRef<{
    reread?: ReturnType<typeof setTimeout>
    max?: ReturnType<typeof setTimeout>
    landed?: ReturnType<typeof setTimeout>
  }>({})
  const active = enabled && !!id && known.size > 0

  const clear = (pulse: boolean) => {
    const s = st.current
    const done = new Set(s.fields)
    s.fields.clear()
    s.inflight = 0
    s.serverOpen = false
    s.endedAt = 0
    if (timers.current.max) clearTimeout(timers.current.max)
    if (timers.current.reread) clearTimeout(timers.current.reread)
    setPending(EMPTY)
    if (pulse && done.size > 0) {
      setLanded(done)
      if (timers.current.landed) clearTimeout(timers.current.landed)
      timers.current.landed = setTimeout(() => setLanded(EMPTY), RECALC_LANDED_MS)
    }
  }
  const clearRef = useRef(clear)
  clearRef.current = clear

  const mark = (names: Iterable<string>) => {
    const s = st.current
    let added = false
    for (const n of names)
      if (known.has(n) && !s.fields.has(n)) {
        s.fields.add(n)
        added = true
      }
    s.endedAt = 0
    if (timers.current.reread) clearTimeout(timers.current.reread)
    if (added) setPending(new Set(s.fields))
    if (timers.current.max) clearTimeout(timers.current.max)
    timers.current.max = setTimeout(() => clearRef.current(false), RECALC_MAX_MS)
  }
  const markRef = useRef(mark)
  markRef.current = mark

  const maybeEnd = () => {
    const s = st.current
    if (s.fields.size === 0 || s.inflight > 0 || s.serverOpen) return
    s.endedAt = Date.now()
    if (timers.current.reread) clearTimeout(timers.current.reread)
    // One re-read as the viewer: settles a total whose figure did not move too.
    timers.current.reread = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: keyRef.current as unknown[] })
    }, RECALC_REREAD_MS)
  }
  const maybeEndRef = useRef(maybeEnd)
  maybeEndRef.current = maybeEnd

  // This tab's own line writes.
  useEffect(() => {
    if (!active) return
    return onWriteCommand((n) => {
      const w = childWriteOf(n.path)
      if (!w || w.parentCollection !== collection || w.parentId !== id) return
      const names = feeds.get(w.collection)
      if (!names) return
      const s = st.current
      if (n.phase === 'start') {
        s.inflight++
        markRef.current(names)
      } else {
        s.inflight = Math.max(0, s.inflight - 1)
        maybeEndRef.current()
      }
    })
  }, [active, collection, id, feeds])

  // Someone's nested save on this record (server notice, names only).
  useLiveRecordEvent(
    'record:recalc',
    collection,
    id,
    (p: { phase?: string; fields?: unknown }) => {
      const names = Array.isArray(p?.fields) ? (p.fields as unknown[]).map(String) : []
      const s = st.current
      if (p?.phase === 'start') {
        const mine = names.filter((n) => known.has(n))
        // Computed fields reading a pending rollup re-derive with it.
        for (const set of feeds.values())
          if (mine.some((n) => set.has(n))) for (const f of set) mine.push(f)
        if (mine.length === 0) return
        s.serverOpen = true
        markRef.current(mine)
      } else if (p?.phase === 'done') {
        s.serverOpen = false
        maybeEndRef.current()
      }
    },
    { includeOwn: true, enabled: active }
  )

  // The re-read after the burst landed: the figures on screen are final now.
  useEffect(() => {
    const s = st.current
    if (s.endedAt > 0 && dataUpdatedAt >= s.endedAt) clearRef.current(true)
  }, [dataUpdatedAt])

  // A different record (or the page leaving) starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on identity only
  useEffect(() => {
    const t = timers.current
    return () => {
      for (const k of ['reread', 'max', 'landed'] as const) if (t[k]) clearTimeout(t[k])
      st.current = { inflight: 0, serverOpen: false, endedAt: 0, fields: new Set() }
      setPending(EMPTY)
      setLanded(EMPTY)
    }
  }, [collection, id])

  return { pending: active ? pending : EMPTY, landed: active ? landed : EMPTY }
}
