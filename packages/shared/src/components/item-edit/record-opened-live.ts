import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useLiveEvent } from '../../lib/live'
import { useMyUserId } from '../../lib/presence-signals'

/**
 * "Who has opened this record" reads (the owner-opened line, the Viewed-by chip) follow the
 * record's viewers notice (realtime gaps 2026-11-17, minor): someone joining the record room is
 * someone opening it. Listens only — never joins the room itself (the page already has). The
 * view watermark lands a moment after the join, so the re-read waits for the burst to settle.
 */
export const RECORD_OPENED_SETTLE_MS = 3000

/** Whether a `record:viewers` notice is about this record (an older server names none). */
export function viewersNoticeFor(collection: string, item: string) {
  return (p: { collection?: unknown; item?: unknown } | null | undefined): boolean =>
    p?.collection == null || p?.item == null
      ? true
      : p.collection === collection && String(p.item) === item
}

/** The viewer ids a `record:viewers` notice names (uppercased). */
function viewerIds(p: { viewers?: unknown } | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(p?.viewers)) return out
  for (const v of p.viewers as Array<{ id?: unknown; user_id?: unknown }>) {
    const id = v?.id ?? v?.user_id
    if (id != null) out.add(String(id).toUpperCase())
  }
  return out
}

/** Whether this notice brings someone new — not a leave, not the viewer's own join. `seen` is
 *  updated in place. Exported for tests. */
export function bringsNewViewer(
  seen: Set<string>,
  p: { viewers?: unknown } | null | undefined,
  me: string | null
): boolean {
  const now = viewerIds(p)
  const self = me ? me.toUpperCase() : null
  let joined = false
  for (const id of now) if (!seen.has(id) && id !== self) joined = true
  seen.clear()
  for (const id of now) seen.add(id)
  return joined
}

/** Who the hook's own answer already shows as having opened the record, from its cached data:
 *  a viewers list (`[{user_id}]`) names them; an owner-opened answer that still says
 *  "not opened" names nobody; anything else (or no data) is unknown → null. */
export function knownOpeners(data: unknown): Set<string> | null {
  if (Array.isArray(data)) {
    const out = new Set<string>()
    for (const v of data as Array<{ user_id?: unknown; id?: unknown }>) {
      const id = v?.user_id ?? v?.id
      if (id != null) out.add(String(id).toUpperCase())
    }
    return out
  }
  if (data && typeof data === 'object' && (data as { status?: unknown }).status === 'not_opened')
    return new Set()
  return null
}

/** The first notice this listener sees (re-review): it is this person's own join only if it
 *  names nobody the answer on screen does not already show — a listener mounted late must not
 *  take another person's real join for priming. `known` null = cannot tell → priming. */
export function firstNoticeJoins(
  p: { viewers?: unknown } | null | undefined,
  me: string | null,
  known: Set<string> | null
): boolean {
  if (!known) return false
  const self = me ? me.toUpperCase() : null
  for (const id of viewerIds(p)) if (id !== self && !known.has(id)) return true
  return false
}

export function useRefreshOnRecordOpened(
  collection: string,
  item: string,
  queryKey: readonly unknown[],
  enabled = true
): void {
  const qc = useQueryClient()
  const me = useMyUserId()
  const seen = useRef(new Set<string>())
  // A different record starts over.
  const primed = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on record change only
  useEffect(() => {
    seen.current = new Set()
    primed.current = false
  }, [collection, item])
  const pending = useRef(false)
  useLiveEvent(
    'record:viewers',
    (p) => {
      // Joins only: someone leaving, or this person's own join, opened nothing new. The first
      // notice (sent for this person's own join) only says who was already there.
      if (!primed.current) {
        primed.current = true
        const cached = qc.getQueriesData({ queryKey: [...queryKey] })[0]?.[1]
        if (firstNoticeJoins(p, me, knownOpeners(cached))) pending.current = true
        bringsNewViewer(seen.current, p, me)
        return
      }
      if (bringsNewViewer(seen.current, p, me)) pending.current = true
    },
    {
      enabled: enabled && !!collection && !!item,
      includeOwn: true,
      match: viewersNoticeFor(collection, item)
    }
  )
  // The view watermark lands a moment after the join: re-read once the joins settle.
  useLiveEvent(
    'record:viewers',
    () => {
      if (!pending.current) return
      pending.current = false
      void qc.invalidateQueries({ queryKey: [...queryKey] })
    },
    {
      enabled: enabled && !!collection && !!item,
      includeOwn: true,
      debounceMs: RECORD_OPENED_SETTLE_MS,
      match: viewersNoticeFor(collection, item)
    }
  )
}
