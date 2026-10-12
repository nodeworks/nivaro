import { useQuery } from '@tanstack/react-query'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ItemEditAuthContext, useOptionalNivaroClient } from '../context'
import { get } from './commands'
import { useLiveEvent } from './live'
import { useOptionalRealtime } from './realtime'

/**
 * Live "who is doing what" signals on a record, a support ticket or an issue — names only,
 * never content, sent only to people already admitted to the same room (the record read gate,
 * the ticket gate):
 *
 *   note        "Beth is writing a note"          (#1721, record rooms)
 *   transition  "Kim is approving"                 (#1722, record rooms)
 *   reply       "Kim is replying"                  (#2026, ticket pages)
 *   viewers     "Kim is looking at this"           (#1882, ticket and issue pages)
 *
 * A signal is a heartbeat, not a toggle: the sender repeats it while it is true and the
 * receiver lets it lapse after SIGNAL_TTL_MS, so a closed tab or a dropped connection never
 * leaves a stale "is typing" behind. A host with a separate record-room socket (the admin)
 * relays through `nvr:record-signal-out` and `relayLiveEvent('record:signal')`.
 */

export type RecordSignalKind = 'note' | 'transition'

/** Receivers drop a signal this long after the last heartbeat. */
export const SIGNAL_TTL_MS = 7_000
/** Senders repeat an active signal at this interval. */
export const SIGNAL_BEAT_MS = 4_000

export interface SignalPerson {
  id: string
  name: string
}

export interface SignalPayload {
  kind?: string
  state?: string
  user?: SignalPerson | null
}

/** user id (upper-cased) → who and until when. */
export type SignalPeers = Map<string, { name: string; until: number }>

/** Fold one incoming signal into the peers (pure — returns a new map). */
export function applySignal(
  peers: SignalPeers,
  payload: SignalPayload,
  now: number,
  selfId?: string | null
): SignalPeers {
  const user = payload.user
  if (!user?.id) return peers
  const id = String(user.id).toUpperCase()
  if (selfId && id === selfId.toUpperCase()) return peers
  const next = new Map(peers)
  if (payload.state === 'stop') next.delete(id)
  else next.set(id, { name: String(user.name || 'Someone'), until: now + SIGNAL_TTL_MS })
  return next
}

/** Drop lapsed peers (pure). */
export function expirePeers(peers: SignalPeers, now: number): SignalPeers {
  let changed = false
  const next = new Map(peers)
  for (const [id, p] of peers)
    if (p.until <= now) {
      next.delete(id)
      changed = true
    }
  return changed ? next : peers
}

export function peerNames(peers: SignalPeers): string[] {
  return [...peers.values()].map((p) => p.name)
}

/** "Beth", "Beth and Kim", "Beth, Kim and 2 others" — the subject of a presence sentence. */
export function whoText(names: string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? '' : 's'}`
}

/** "Beth is writing a note", "Beth and Kim are approving". */
export function signalSentence(names: string[], verbPhrase: string): string | null {
  const who = whoText(names)
  if (!who) return null
  return `${who} ${names.length === 1 ? 'is' : 'are'} ${verbPhrase}`
}

/** The signed-in person's id: the host's auth context when it gives one, else `/users/me`. */
export function useMyUserId(): string | null {
  const { userId } = useContext(ItemEditAuthContext)
  const client = useOptionalNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-my-user-id'],
    queryFn: () =>
      client!
        .request<{ data: { id?: string } }>(get('/users/me'))
        .then((r) => (r.data?.id ? String(r.data.id) : null)),
    enabled: !userId && !!client,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })
  return userId || data || null
}

/** Re-render when the soonest peer lapses. */
function usePeerClock(
  peers: SignalPeers,
  setPeers: (f: (p: SignalPeers) => SignalPeers) => void
): void {
  useEffect(() => {
    if (peers.size === 0) return
    const t = setInterval(() => setPeers((p) => expirePeers(p, Date.now())), 1000)
    return () => clearInterval(t)
  }, [peers.size, setPeers])
}

// ── Record rooms ────────────────────────────────────────────────────────────

/** Names of the OTHER people currently signalling `kind` on this record. */
export function useRecordSignalPeers(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  kind: RecordSignalKind
): string[] {
  const me = useMyUserId()
  const [peers, setPeers] = useState<SignalPeers>(() => new Map())
  const id = item == null ? '' : String(item)
  // A different record (or kind) starts with nobody signalling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the reset triggers
  useEffect(() => {
    setPeers(new Map())
  }, [collection, id, kind])
  useLiveEvent(
    'record:signal',
    (p) => {
      if (p?.kind !== kind) return
      setPeers((prev) => applySignal(prev, p, Date.now(), me))
    },
    {
      enabled: !!collection && !!id,
      includeOwn: true,
      match: (p) => p?.collection === collection && String(p?.item) === id
    }
  )
  usePeerClock(peers, setPeers)
  return peerNames(peers)
}

/** Send a record signal through the host's record-room socket(s). */
export function useRecordSignalSender(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  kind: RecordSignalKind
): (state: 'start' | 'stop') => void {
  const realtime = useOptionalRealtime()
  const id = item == null ? '' : String(item)
  return useCallback(
    (state) => {
      if (!collection || !id || id === 'new') return
      const payload = { collection, item: id, kind, state }
      realtime?.emit('record:signal', payload)
      if (typeof window !== 'undefined')
        window.dispatchEvent(new CustomEvent('nvr:record-signal-out', { detail: payload }))
    },
    [realtime, collection, id, kind]
  )
}

/**
 * While `active`, tell the record's other viewers (start now, then every SIGNAL_BEAT_MS);
 * `stop` when it ends or the component goes away.
 */
export function useRecordSignalWhile(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  kind: RecordSignalKind,
  active: boolean
): void {
  const send = useRecordSignalSender(collection, item, kind)
  useEffect(() => {
    if (!active) return
    send('start')
    const t = setInterval(() => send('start'), SIGNAL_BEAT_MS)
    return () => {
      clearInterval(t)
      send('stop')
    }
  }, [active, send])
}

// ── Ticket and issue pages ──────────────────────────────────────────────────

export interface TopicPresence {
  /** The other people on this page right now. */
  viewers: SignalPerson[]
  /** Names of the other people replying right now. */
  replying: string[]
  /** Tell the others you are (or stopped) replying. Call on every keystroke burst; it throttles. */
  signalReplying: (active: boolean) => void
}

/**
 * Presence on one ticket (`ticket:<id>`) or issue (`issue-view:<id>`) page. Joining is gated
 * server-side (a ticket only admits people who can open it). Without a host realtime adapter
 * the hook is inert.
 */
export function useTopicPresence(
  topic: string | null | undefined,
  selfId?: string | null
): TopicPresence {
  const realtime = useOptionalRealtime()
  const known = useMyUserId()
  const me = selfId || known
  const [viewers, setViewers] = useState<SignalPerson[]>([])
  const [peers, setPeers] = useState<SignalPeers>(() => new Map())
  const lastSent = useRef(0)
  useEffect(() => {
    setViewers([])
    setPeers(new Map())
    if (!realtime || !topic) return
    realtime.emit('ops:join', { topic })
    return () => realtime.emit('ops:leave', { topic })
  }, [realtime, topic])
  useLiveEvent(
    'ops:changed',
    (p) => {
      if (Array.isArray(p?.viewers)) setViewers(p.viewers as SignalPerson[])
      if (p?.signal?.kind === 'reply')
        setPeers((prev) => applySignal(prev, p.signal, Date.now(), me))
    },
    { enabled: !!realtime && !!topic, includeOwn: true, match: (p) => p?.topic === topic }
  )
  usePeerClock(peers, setPeers)
  const signalReplying = useCallback(
    (active: boolean) => {
      if (!realtime || !topic) return
      const now = Date.now()
      if (active && now - lastSent.current < 2_500) return
      lastSent.current = active ? now : 0
      realtime.emit('ops:signal', { topic, kind: 'reply', state: active ? 'start' : 'stop' })
    },
    [realtime, topic]
  )
  const others = viewers.filter((v) => !me || String(v.id).toUpperCase() !== me.toUpperCase())
  return { viewers: others, replying: peerNames(peers), signalReplying }
}
