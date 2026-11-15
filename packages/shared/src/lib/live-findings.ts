import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'
import { type LiveBatch, useLiveCollection } from './live'
import { writerOf } from './live-list'

/**
 * "Finding resolved live" (realtime program 2026-11-14, item 15).
 *
 * A board of findings (Data Integrity sweeps, orphans, inactive people, a "ready to send"
 * board…) goes stale the moment someone fixes a record. This hook turns a finding whose record
 * was just fixed into a calm "Fixed by Beth" state in place — it does not remove the row (the
 * list would shift under the pointer); the next refresh drops it.
 *
 * What it does, per burst of `collection:update` events (default debounce 1 s):
 *   1. picks the findings whose record the events named (a bulk write that named nobody picks
 *      every finding on the page, capped at `maxPerRun`);
 *   2. asks the board's own `recheck(refs)` — a read as the VIEWER that returns the keys that
 *      no longer have a finding (the board decides what "fixed" means: a conformance
 *      re-check, an orphan re-test, a re-listing);
 *   3. marks those keys resolved, with who saved the record last when the viewer may read
 *      `user_updated`.
 * A record that breaks again (a later recheck says it still has the finding) loses its mark.
 *
 * Wiring a board: pass `findings` as `{key, collection, itemId}` (the key is whatever the row
 * is keyed by), render `resolved.get(key)` as a `<FindingFixedMark>` and dim the row. See
 * ConformanceView and the orphan finder for the two shapes (one finding per row; one record
 * with several findings).
 */

export interface FindingRef {
  /** The row's own key (unique on the board). */
  key: string
  collection: string
  /** The record the finding is about. */
  itemId: string
}

export interface ResolvedMark {
  at: number
  /** User id that saved the record last (null: unknown or not readable). */
  by: string | null
}

const norm = (id: unknown) => String(id).toUpperCase()

/**
 * Findings a batch of events may have changed. `'*'` (a bulk write that named no record) picks
 * every finding of that collection, up to `max`.
 */
export function findingsTouchedBy(
  findings: FindingRef[],
  batch: LiveBatch,
  max = 40
): FindingRef[] {
  if (batch.aspectsOnly) return []
  const named = new Set<string>()
  const bulkCollections = new Set<string>()
  for (const ev of batch.events) {
    const c = String(ev.collection)
    if (ev.item === '*') bulkCollections.add(c)
    else named.add(`${c}:${norm(ev.item)}`)
  }
  const out: FindingRef[] = []
  const seen = new Set<string>()
  for (const f of findings) {
    if (seen.has(f.key)) continue
    if (named.has(`${f.collection}:${norm(f.itemId)}`) || bulkCollections.has(f.collection)) {
      seen.add(f.key)
      out.push(f)
      if (out.length >= max) break
    }
  }
  return out
}

/** The calm label: "Fixed by Beth", "Fixed by you", or just "Fixed" when nobody can be named. */
export function resolvedLabel(
  mark: ResolvedMark,
  name: string | null | undefined,
  selfId?: string | null
): string {
  if (!mark.by) return 'Fixed'
  if (selfId && norm(mark.by) === norm(selfId)) return 'Fixed by you'
  const n = (name ?? '').trim()
  return n ? `Fixed by ${n}` : 'Fixed'
}

export interface ResolvedFindingsOptions {
  findings: FindingRef[]
  /** The board's own re-check, as the viewer: the keys (of `refs`) that no longer have a finding. */
  recheck: (refs: FindingRef[]) => Promise<string[]>
  enabled?: boolean
  /** Most findings re-checked in one go. */
  maxPerRun?: number
  /** Who saved the record last; default reads `user_updated` through the viewer's own read. */
  lookupWriter?: (ref: FindingRef) => Promise<string | null>
}

export function useResolvedFindings(opts: ResolvedFindingsOptions): {
  resolved: ReadonlyMap<string, ResolvedMark>
} {
  const { findings, enabled = true, maxPerRun = 40 } = opts
  const client = useOptionalNivaroClient()
  const [resolved, setResolved] = useState<ReadonlyMap<string, ResolvedMark>>(() => new Map())
  const optsRef = useRef(opts)
  optsRef.current = opts
  const findingsRef = useRef(findings)
  findingsRef.current = findings
  const clientRef = useRef(client)
  clientRef.current = client
  const alive = useRef(true)
  const queue = useRef<FindingRef[]>([])
  const running = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // The board refreshed: marks for rows that are no longer on it go.
  const keysKey = findings.map((f) => f.key).join('\u0000')
  // biome-ignore lint/correctness/useExhaustiveDependencies: keysKey stands for the findings' keys
  useEffect(() => {
    const keys = new Set(findingsRef.current.map((f) => f.key))
    setResolved((prev) => {
      let dropped = false
      const next = new Map<string, ResolvedMark>()
      for (const [k, v] of prev) {
        if (keys.has(k)) next.set(k, v)
        else dropped = true
      }
      return dropped ? next : prev
    })
  }, [keysKey])

  const lookup = useCallback(async (ref: FindingRef): Promise<string | null> => {
    const o = optsRef.current
    if (o.lookupWriter) return o.lookupWriter(ref).catch(() => null)
    const c = clientRef.current
    if (!c) return null
    try {
      const res = await c.request<{ data: Record<string, unknown> | null }>(
        get(`/items/${encodeURIComponent(ref.collection)}/${encodeURIComponent(ref.itemId)}`, {
          fields: 'user_updated'
        })
      )
      return writerOf(res.data)
    } catch {
      return null
    }
  }, [])

  const drain = useCallback(async () => {
    if (running.current) return
    running.current = true
    try {
      while (queue.current.length > 0 && alive.current) {
        const refs = queue.current.splice(0, optsRef.current.maxPerRun ?? 40)
        let fixed: string[] = []
        try {
          fixed = await optsRef.current.recheck(refs)
        } catch {
          continue // keep what is shown; the next write asks again
        }
        if (!alive.current) return
        const fixedSet = new Set(fixed)
        const writers = new Map<string, string | null>()
        await Promise.all(
          refs
            .filter((r) => fixedSet.has(r.key))
            .slice(0, 12)
            .map(async (r) => writers.set(r.key, await lookup(r)))
        )
        if (!alive.current) return
        setResolved((prev) => {
          const next = new Map(prev)
          for (const r of refs) {
            if (fixedSet.has(r.key)) {
              next.set(r.key, prev.get(r.key) ?? { at: Date.now(), by: writers.get(r.key) ?? null })
            } else next.delete(r.key)
          }
          return next
        })
      }
    } finally {
      running.current = false
    }
  }, [lookup])

  const collectionsKey = [...new Set(findings.map((f) => f.collection))].sort().join(',')
  useLiveCollection(
    collectionsKey ? collectionsKey.split(',') : null,
    (batch) => {
      const refs = findingsTouchedBy(findingsRef.current, batch, maxPerRun)
      if (refs.length === 0) return
      const queued = new Set(queue.current.map((r) => r.key))
      for (const r of refs) if (!queued.has(r.key)) queue.current.push(r)
      void drain()
    },
    {
      debounceMs: 1000,
      includeOwn: true,
      enabled: enabled && collectionsKey !== '',
      focusable: true
    }
  )

  return useMemo(() => ({ resolved }), [resolved])
}
