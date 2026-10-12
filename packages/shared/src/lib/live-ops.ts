import { useEffect, useRef, useState } from 'react'
import { useLiveEvent } from './live'
import { useOptionalRealtime } from './realtime'

/**
 * Live operations pages — Readiness, Issues, Support desk, Team workload, My
 * Work, Delegation console, Broadcast receipts.
 *
 * The server pokes a topic room (`ops:changed {topic}`) when something the page
 * shows moved; the page refetches through its own permission-checked query. A
 * few admin-only topics carry detail (`readiness` carries the finished report,
 * `issue:<id>` an occurrence). The pokes are coalesced server-side, so a burst
 * is one refetch, and a page keeps a slow safety poll for a missed event.
 *
 *   useLiveOps('support', () => qc.invalidateQueries({ queryKey: ['support'] }))
 *   useLiveOps('issue:42', (d) => d.occurrence && addRow(d.occurrence))
 *
 * Without a host RealtimeAdapter the hook is inert (the page keeps polling).
 * Hosts re-send `ops:join` after a reconnect (admin's socket does).
 */
export interface LiveOpsOptions {
  /** Coalesce a burst on the client too (default 300ms; the LAST payload wins). */
  debounceMs?: number
  enabled?: boolean
}

export function useLiveOps(
  topic: string | null | undefined,
  onEvent: (detail: Record<string, any>) => void,
  opts: LiveOpsOptions = {}
): void {
  const realtime = useOptionalRealtime()
  const enabled = opts.enabled !== false && !!topic
  useEffect(() => {
    if (!realtime || !enabled || !topic) return
    realtime.emit('ops:join', { topic })
    return () => realtime.emit('ops:leave', { topic })
  }, [realtime, enabled, topic])
  useLiveEvent(
    'ops:changed',
    (p) => {
      onEvent(p ?? {})
    },
    {
      enabled,
      debounceMs: opts.debounceMs ?? 300,
      includeOwn: true,
      match: (p) => p?.topic === topic
    }
  )
}

/**
 * Ids that appeared in `ids` since the last render (not on first load), kept
 * for `ms` — what a "short highlight on new rows" reads. Ids already there on
 * mount never flash.
 */
export function useFreshIds(ids: Array<string | number> | undefined, ms = 4000): Set<string> {
  const prev = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  const key = (ids ?? []).map(String).join('\u0000')
  useEffect(() => {
    const cur = new Set(key ? key.split('\u0000') : [])
    const before = prev.current
    prev.current = cur
    if (!before || before.size === 0) return
    const added = [...cur].filter((id) => !before.has(id))
    if (added.length === 0) return
    setFresh((f) => new Set([...f, ...added]))
    // Not cleared on re-run: a later change must not strand an earlier highlight.
    setTimeout(
      () =>
        setFresh((f) => {
          const n = new Set(f)
          for (const id of added) n.delete(id)
          return n
        }),
      ms
    )
  }, [key, ms])
  return fresh
}
