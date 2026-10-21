import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveEvent } from '../../lib/live'
import { useMyUserId } from '../../lib/presence-signals'
import { useOptionalRealtime } from '../../lib/realtime'

/**
 * Live presence in the layout editor (#2651): who else has this layout open
 * and what each has selected. Rides the `layout:<id>` live-operations topic
 * (administrators only, tenant-scoped on the server): `ops:join` adds this
 * socket to the viewer list, `ops:signal {kind: 'select', target}` sets what
 * it has selected, and every change comes back as the whole list
 * (`ops:changed {topic, viewers}`) — a late joiner gets everyone's selection
 * with its first list. Ids, names and target keys only. Without a host
 * realtime adapter the hook is inert (nobody shows).
 */

export interface LayoutPeer {
  id: string
  name: string
  /** The design target key they have selected (targetKey), or null. */
  selected: string | null
  tone: PeerTone
}

export interface PeerTone {
  /** Outline on the node they selected. */
  outline: string
  /** Avatar / tag fill, light and dark. */
  chip: string
}

// Not cyan (that is this admin's own selection) and not the preview tag tones.
const TONES: PeerTone[] = [
  {
    outline: 'outline-fuchsia-500 dark:outline-fuchsia-400',
    chip: 'bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-300 dark:bg-fuchsia-500/20 dark:text-fuchsia-200 dark:ring-fuchsia-500/40'
  },
  {
    outline: 'outline-orange-500 dark:outline-orange-400',
    chip: 'bg-orange-100 text-orange-800 ring-orange-300 dark:bg-orange-500/20 dark:text-orange-200 dark:ring-orange-500/40'
  },
  {
    outline: 'outline-indigo-500 dark:outline-indigo-400',
    chip: 'bg-indigo-100 text-indigo-800 ring-indigo-300 dark:bg-indigo-500/20 dark:text-indigo-200 dark:ring-indigo-500/40'
  },
  {
    outline: 'outline-lime-600 dark:outline-lime-400',
    chip: 'bg-lime-100 text-lime-800 ring-lime-300 dark:bg-lime-500/20 dark:text-lime-200 dark:ring-lime-500/40'
  },
  {
    outline: 'outline-rose-500 dark:outline-rose-400',
    chip: 'bg-rose-100 text-rose-800 ring-rose-300 dark:bg-rose-500/20 dark:text-rose-200 dark:ring-rose-500/40'
  },
  {
    outline: 'outline-teal-600 dark:outline-teal-400',
    chip: 'bg-teal-100 text-teal-800 ring-teal-300 dark:bg-teal-500/20 dark:text-teal-200 dark:ring-teal-500/40'
  }
]

/** The same person gets the same colour on every screen. */
export function peerTone(id: string): PeerTone {
  let h = 0
  for (const ch of id.toUpperCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TONES[h % TONES.length]
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''
  return (first + last).toUpperCase()
}

/** The viewers list of an `ops:changed` payload as peers (everyone but `me`). */
export function peersFrom(viewers: unknown, me: string | null): LayoutPeer[] {
  if (!Array.isArray(viewers)) return []
  const mine = me?.toUpperCase() ?? null
  const out: LayoutPeer[] = []
  for (const v of viewers as Array<{ id?: unknown; name?: unknown; selected?: unknown }>) {
    if (typeof v?.id !== 'string' || !v.id) continue
    if (mine && v.id.toUpperCase() === mine) continue
    out.push({
      id: v.id,
      name: typeof v.name === 'string' && v.name ? v.name : 'Someone',
      selected: typeof v.selected === 'string' ? v.selected : null,
      tone: peerTone(v.id)
    })
  }
  return out
}

/** Peers by the node they have selected (targetKey → peers). */
export function peersByTarget(peers: LayoutPeer[]): Map<string, LayoutPeer[]> {
  const m = new Map<string, LayoutPeer[]>()
  for (const p of peers) {
    if (!p.selected) continue
    const list = m.get(p.selected)
    if (list) list.push(p)
    else m.set(p.selected, [p])
  }
  return m
}

const SELECT_DEBOUNCE_MS = 150

/**
 * Join `layout:<id>` while the editor shows that layout and tell the others
 * what is selected (`selectedKey`, a targetKey or null). Returns the others.
 */
export function useLayoutPresence(layoutId: number | null, selectedKey: string | null) {
  const realtime = useOptionalRealtime()
  const me = useMyUserId()
  const topic = layoutId != null && layoutId > 0 ? `layout:${layoutId}` : null
  const [viewers, setViewers] = useState<unknown>([])
  const selectedRef = useRef(selectedKey)
  selectedRef.current = selectedKey

  useEffect(() => {
    setViewers([])
    if (!realtime || !topic) return
    realtime.emit('ops:join', { topic })
    return () => realtime.emit('ops:leave', { topic })
  }, [realtime, topic])

  useLiveEvent(
    'ops:changed',
    (p) => {
      if (Array.isArray(p?.viewers)) setViewers(p.viewers)
    },
    { enabled: !!realtime && !!topic, includeOwn: true, match: (p) => p?.topic === topic }
  )

  // What is selected, a beat after it settles (a drag-select burst is one signal).
  useEffect(() => {
    if (!realtime || !topic) return
    const t = setTimeout(() => {
      realtime.emit('ops:signal', {
        topic,
        kind: 'select',
        state: selectedKey ? 'start' : 'stop',
        target: selectedKey
      })
    }, SELECT_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [realtime, topic, selectedKey])

  // After a reconnect the server knows this socket afresh (no selection): say it again,
  // once the join has gone back in.
  useEffect(() => {
    if (!realtime?.onStatus || !topic) return
    let was = realtime.status?.().state ?? 'live'
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = realtime.onStatus((s) => {
      if (s.state === 'live' && was !== 'live' && selectedRef.current) {
        clearTimeout(timer)
        timer = setTimeout(() => {
          realtime.emit('ops:signal', {
            topic,
            kind: 'select',
            state: 'start',
            target: selectedRef.current
          })
        }, 1500)
      }
      was = s.state
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [realtime, topic])

  return useMemo(() => peersFrom(viewers, me), [viewers, me])
}
