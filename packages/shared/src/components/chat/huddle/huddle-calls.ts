/**
 * Calls (#2843, #2844) — the browser side of ringing, as a small module store
 * beside huddle-store.ts: incoming calls (for the app-level toast layer) and
 * the people I am ringing from the huddle I am in (for the stage). The
 * transport is the host's realtime adapter; nothing here imports socket.io.
 *
 * Server → me: `huddle:ring` {room, from, name, at, scheduled?} (someone is
 * calling), `huddle:ring-cancel` {room, reason} (they hung up / it timed out),
 * `huddle:ringing` {room, users} (people I rang), `huddle:ring-result`
 * {room, user, name, accept, reason?}. Me → server: `huddle:ring-answer`
 * {room, accept}, `huddle:ring-cancel` {room}, `huddle:invite` {room, users}.
 */

import { watchRingRefused } from './huddle-ring-refused'
import type { HuddleTransport } from './huddle-store'

/** A toast closes on its own after this long — the server's "No answer" line follows. */
export const INCOMING_TTL_MS = 30_000

export interface IncomingCall {
  room: string
  from: string
  name: string | null
  at: number
  /** A scheduled huddle starting (#2860). */
  scheduled: number | null
}

export interface RingingPerson {
  id: string
  name: string | null
  state: 'ringing' | 'accepted' | 'declined' | 'timeout'
}

export interface CallsState {
  incoming: IncomingCall[]
  /** Per room: who I am ringing right now. */
  outgoing: Record<string, RingingPerson[]>
}

const EMPTY: CallsState = { incoming: [], outgoing: {} }

/** Pure: a new ring replaces an older one from the same room. */
export function addIncoming(list: IncomingCall[], call: IncomingCall): IncomingCall[] {
  return [...list.filter((c) => c.room !== call.room), call]
}

/** Pure: drop toasts older than the TTL (the caller's timer ran out). */
export function pruneIncoming(list: IncomingCall[], now = Date.now()): IncomingCall[] {
  return list.filter((c) => now - c.at < INCOMING_TTL_MS)
}

/** Pure: apply an answer to the ringing list of one room. */
export function applyResult(
  list: RingingPerson[],
  r: { user: string; name: string | null; accept: boolean; reason?: string }
): RingingPerson[] {
  const id = r.user.toUpperCase()
  const state: RingingPerson['state'] = r.accept
    ? 'accepted'
    : r.reason === 'timeout'
      ? 'timeout'
      : 'declined'
  const found = list.some((p) => p.id.toUpperCase() === id)
  return found
    ? list.map((p) => (p.id.toUpperCase() === id ? { ...p, name: p.name ?? r.name, state } : p))
    : [...list, { id: r.user, name: r.name, state }]
}

type Listener = () => void

class HuddleCallsStore {
  private state: CallsState = EMPTY
  private listeners = new Set<Listener>()
  private transport: HuddleTransport | null = null
  private offs: Array<() => void> = []
  private sweep: ReturnType<typeof setInterval> | null = null
  /** Answered results fade from the stage after a moment. */
  private fades = new Map<string, ReturnType<typeof setTimeout>>()

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => this.state
  private set(patch: Partial<CallsState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  attach(transport: HuddleTransport) {
    if (this.transport === transport) return
    for (const off of this.offs) off()
    this.transport = transport
    this.offs = [
      transport.on('huddle:ring', (p: Partial<IncomingCall>) => {
        if (typeof p?.room !== 'string' || typeof p.from !== 'string') return
        this.set({
          incoming: addIncoming(this.state.incoming, {
            room: p.room,
            from: p.from,
            name: p.name ?? null,
            at: Date.now(),
            scheduled: typeof p.scheduled === 'number' ? p.scheduled : null
          })
        })
        this.startSweep()
      }),
      transport.on('huddle:ring-cancel', (p: { room?: string }) => {
        if (typeof p?.room !== 'string') return
        this.set({ incoming: this.state.incoming.filter((c) => c.room !== p.room) })
      }),
      transport.on('huddle:ringing', (p: { room?: string; users?: RingingPerson[] }) => {
        if (typeof p?.room !== 'string' || !Array.isArray(p.users)) return
        const cur = this.state.outgoing[p.room] ?? []
        const next = [...cur]
        for (const u of p.users) {
          if (!u?.id) continue
          const i = next.findIndex((x) => x.id.toUpperCase() === u.id.toUpperCase())
          const row = { id: u.id, name: u.name ?? null, state: 'ringing' as const }
          if (i >= 0) next[i] = row
          else next.push(row)
        }
        this.set({ outgoing: { ...this.state.outgoing, [p.room]: next } })
      }),
      transport.on(
        'huddle:ring-result',
        (p: {
          room?: string
          user?: string
          name?: string | null
          accept?: boolean
          reason?: string
        }) => {
          if (typeof p?.room !== 'string' || typeof p.user !== 'string') return
          const list = applyResult(this.state.outgoing[p.room] ?? [], {
            user: p.user,
            name: p.name ?? null,
            accept: !!p.accept,
            reason: p.reason
          })
          this.set({ outgoing: { ...this.state.outgoing, [p.room]: list } })
          this.fadeLater(p.room, p.user)
        }
      ),
      // A ring the server would not place says so (security review finding 1).
      watchRingRefused(transport)
    ]
  }

  private fadeLater(room: string, user: string) {
    const key = `${room}|${user.toUpperCase()}`
    const prev = this.fades.get(key)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.fades.delete(key)
      const list = (this.state.outgoing[room] ?? []).filter(
        (p) => p.id.toUpperCase() !== user.toUpperCase() || p.state === 'ringing'
      )
      this.set({ outgoing: { ...this.state.outgoing, [room]: list } })
    }, 6000)
    this.fades.set(key, t)
  }

  private startSweep() {
    if (this.sweep) return
    this.sweep = setInterval(() => {
      const pruned = pruneIncoming(this.state.incoming)
      if (pruned.length !== this.state.incoming.length) this.set({ incoming: pruned })
      if (!pruned.length && this.sweep) {
        clearInterval(this.sweep)
        this.sweep = null
      }
    }, 1000)
  }

  /** Accept or decline an incoming call; the toast goes either way. */
  answer(room: string, accept: boolean) {
    this.set({ incoming: this.state.incoming.filter((c) => c.room !== room) })
    this.transport?.emit('huddle:ring-answer', { room, accept })
  }

  /** Stop ringing everyone I rang in this room. */
  cancel(room: string) {
    this.transport?.emit('huddle:ring-cancel', { room })
    const { [room]: _gone, ...rest } = this.state.outgoing
    this.set({ outgoing: rest })
  }

  /** Ring more people into the huddle I am in (#2844). */
  invite(room: string, users: string[]) {
    if (!users.length) return
    this.transport?.emit('huddle:invite', { room, users })
  }

  /** The stage left the room: forget its ringing list (the server hung up for us). */
  clearOutgoing(room: string) {
    if (!this.state.outgoing[room]) return
    const { [room]: _gone, ...rest } = this.state.outgoing
    this.set({ outgoing: rest })
  }
}

export const huddleCalls = new HuddleCallsStore()
