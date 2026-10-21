import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useOptionalRealtime } from '../../../lib/realtime'

/**
 * Live huddle badges (#2851) — the browser side. A host with a realtime adapter asks the
 * server to watch (`huddle:live-watch`); the server answers THIS socket with the huddles
 * the signed-in person may see (`huddle:live`) and afterwards sends a payload-free
 * `huddle:live-poke` whenever something changes, which makes us ask again. Room keys of
 * rooms the person cannot see never arrive.
 */

export interface LiveHuddle {
  room: string
  label: string
  count: number
  /** User ids of the people in it. */
  users: string[]
}

interface Transport {
  on(event: string, cb: (payload: any) => void): () => void
  emit(event: string, payload?: any): void
}

const NONE: LiveHuddle[] = []
const POKE_DEBOUNCE_MS = 300
const RESYNC_MS = 120_000

class HuddleLiveStore {
  private rooms: LiveHuddle[] = NONE
  private listeners = new Set<() => void>()
  private transport: Transport | null = null
  private offs: Array<() => void> = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private resync: ReturnType<typeof setInterval> | null = null

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    this.syncTimer()
    return () => {
      this.listeners.delete(l)
      this.syncTimer()
    }
  }
  getSnapshot = () => this.rooms

  private syncTimer() {
    if (this.listeners.size && !this.resync) {
      this.resync = setInterval(() => this.watch(), RESYNC_MS)
    } else if (!this.listeners.size && this.resync) {
      clearInterval(this.resync)
      this.resync = null
    }
  }

  private watch() {
    this.transport?.emit('huddle:live-watch', {})
  }

  /** Bind the host's socket adapter once; the same adapter again is a no-op. */
  attach(transport: Transport) {
    if (this.transport === transport) return
    for (const off of this.offs) off()
    this.transport = transport
    this.offs = [
      transport.on('huddle:live', (p: { rooms?: LiveHuddle[] }) => {
        this.rooms = Array.isArray(p?.rooms) ? p.rooms : NONE
        for (const l of this.listeners) l()
      }),
      transport.on('huddle:live-poke', () => {
        if (this.timer) return
        this.timer = setTimeout(() => {
          this.timer = null
          this.watch()
        }, POKE_DEBOUNCE_MS)
      }),
      // Sign-in and every reconnect: the server forgot us, so ask again.
      transport.on('auth:ok', () => this.watch())
    ]
    this.watch()
  }

  /** Test hook. */
  reset() {
    for (const off of this.offs) off()
    this.offs = []
    this.transport = null
    this.rooms = NONE
  }
}

export const huddleLive = new HuddleLiveStore()

/** Pure: lookups over a snapshot. */
export function liveLookups(rooms: LiveHuddle[]) {
  const byRoom = new Map(rooms.map((r) => [r.room, r]))
  return {
    rooms,
    /** People in the room's huddle (0 = none visible). */
    countFor: (room: string | null | undefined) => (room ? (byRoom.get(room)?.count ?? 0) : 0),
    /** The huddle a person is in, if the viewer can see that room. */
    roomOf: (userId: string | null | undefined): LiveHuddle | null => {
      if (!userId) return null
      const id = String(userId).toUpperCase()
      return rooms.find((r) => r.users.some((u) => String(u).toUpperCase() === id)) ?? null
    }
  }
}

/** Which rooms have a huddle running, as far as this person may see. Empty without a socket. */
export function useHuddleLive() {
  const realtime = useOptionalRealtime()
  useEffect(() => {
    if (realtime) huddleLive.attach(realtime)
  }, [realtime])
  const rooms = useSyncExternalStore(huddleLive.subscribe, huddleLive.getSnapshot, () => NONE)
  return useMemo(() => liveLookups(rooms), [rooms])
}
