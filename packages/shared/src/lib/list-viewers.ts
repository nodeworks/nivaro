import { useContext, useEffect, useState } from 'react'
import { ItemEditAuthContext } from '../context'
import { useLiveEvent } from './live'
import { useOptionalRealtime } from './realtime'

/**
 * "Beth and 2 others are viewing this list" — ADMINISTRATORS ONLY (api
 * services/list-viewer-topics.ts).
 *
 * Every open list / queue worklist joins its viewer topic (`list-view:<collection>`,
 * `queue-view:<id>`) through the ordinary reference-counted `ops:join`, so the server can
 * count the person. The names come back as `ops:changed {topic, viewers}` — and the server
 * only lets administrators into the room that carries them, so for anyone else this hook
 * simply never hears anything and returns []. Nothing about this is decided in the browser.
 */

export interface ListViewer {
  id: string
  name: string
}

export function listViewTopic(kind: 'list' | 'queue', id: string | number): string {
  return `${kind === 'list' ? 'list-view' : 'queue-view'}:${id}`
}

/** The other people (never me) the server says have this list open. Exported for tests. */
export function othersFrom(viewers: unknown, selfId: string): ListViewer[] {
  if (!Array.isArray(viewers)) return []
  const me = selfId.toUpperCase()
  const seen = new Set<string>()
  const out: ListViewer[] = []
  for (const v of viewers as Array<Partial<ListViewer>>) {
    if (!v || typeof v.id !== 'string' || typeof v.name !== 'string') continue
    const key = v.id.toUpperCase()
    if (key === me || seen.has(key)) continue
    seen.add(key)
    out.push({ id: v.id, name: v.name })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Who else has this list open (empty for non-administrators — the server sends them nothing). */
export function useListViewers(
  kind: 'list' | 'queue',
  id: string | number | null | undefined,
  enabled = true
): ListViewer[] {
  const realtime = useOptionalRealtime()
  const { userId } = useContext(ItemEditAuthContext)
  const [viewers, setViewers] = useState<ListViewer[]>([])
  const topic = id == null || id === '' ? null : listViewTopic(kind, id)

  // Names arrive through the adapter (and the window relay hosts forward events on).
  useLiveEvent(
    'ops:changed',
    (p: { viewers?: unknown }) => setViewers(othersFrom(p.viewers, userId ?? '')),
    {
      enabled: !!topic && enabled,
      includeOwn: true,
      match: (p) => p?.topic === topic && p != null && 'viewers' in p
    }
  )

  useEffect(() => {
    setViewers([])
    if (!realtime || !topic || !enabled) return
    try {
      realtime.emit('ops:join', { topic })
    } catch {
      /* presence must never break the list */
    }
    return () => {
      try {
        realtime.emit('ops:leave', { topic })
      } catch {
        /* ignore */
      }
    }
  }, [realtime, topic, enabled])

  return viewers
}

/** "Beth is viewing", "Beth and Ana are viewing", "Beth and 2 others are viewing". */
export function viewersSentence(viewers: ListViewer[]): string {
  const first = (n: string) => n.split(/\s+/)[0] || n
  if (viewers.length === 0) return ''
  if (viewers.length === 1) return `${first(viewers[0].name)} is viewing this too`
  if (viewers.length === 2)
    return `${first(viewers[0].name)} and ${first(viewers[1].name)} are viewing this too`
  return `${first(viewers[0].name)} and ${viewers.length - 1} others are viewing this too`
}
