import type { CollectionUpdateEvent } from './realtime'

/**
 * Missed-event detection per room (#2462) and the slow-consumer refetch (#2460), shared by the
 * admin socket and `createSocketRealtime` (portals, @nivaro/react) so both behave the same.
 *
 * Journaled events carry the room they went to (`_room`) and that room's own counter (`_rseq`);
 * a merged burst carries the range it covers (`_rseq_min`…`_rseq`). While connected, a counter
 * that skips means an event for that room never arrived: after a short grace (events from two
 * servers can arrive out of order) the client asks for that room alone (`catchup:room
 * {room, cursor, missed}` — cursor = the global position of the last event it had there) and
 * replays what comes back into the same listeners. The whole-connection catch-up after a
 * reconnect is unchanged; the tracker starts over then.
 *
 * `realtime:stale {rooms}` — the server held this socket's room broadcasts while it was too far
 * behind — turns into the same "refetch" a room gap that cannot be replayed does.
 */

export interface RoomGapRequest {
  room: string
  cursor: number
  missed: number
}

interface RoomState {
  rseq: number
  seq: number
}

interface PendingGap {
  /** Global positions bracketing the gap: replayed events strictly inside are the missing ones. */
  fromSeq: number
  toSeq: number
  missing: Set<number>
  timer: ReturnType<typeof setTimeout> | null
  asked: boolean
}

export interface RoomGapTracker {
  /** Every live event's payload; schedules a room catch-up when a room counter skips. */
  observe(payload: unknown): void
  /** The room catch-up answer → the events to dispatch (or a refetch when it is `full`). */
  replayed(answer: {
    room?: string
    full?: boolean
    events?: Array<{ seq: number; event: string; payload: Record<string, unknown>; rseq?: number }>
  }): void
  /** Forget rooms (all when omitted): a new connection, a room left or joined again. */
  reset(rooms?: string[]): void
  /** Gaps seen since this tracker started (diagnostics). */
  stats(): { gaps: number; missed: number; replayed: number; refetched: number }
}

export interface RoomGapOptions {
  /** Send `catchup:room` for one room. */
  request: (req: RoomGapRequest) => void
  /** Hand one replayed event to the listeners, as if it had arrived live. */
  dispatch: (event: string, payload: Record<string, unknown>) => void
  /** The room could not be replayed: refetch what it shows. */
  refetch: (rooms: string[]) => void
  /** How long to wait for a late event before asking (default 1500 ms). */
  graceMs?: number
}

/** More missing than this in one room is not worth replaying — refetch the room instead. */
const MAX_MISSING = 200

export function createRoomGapTracker(opts: RoomGapOptions): RoomGapTracker {
  const rooms = new Map<string, RoomState>()
  const pending = new Map<string, PendingGap>()
  const counts = { gaps: 0, missed: 0, replayed: 0, refetched: 0 }
  const grace = opts.graceMs ?? 1500

  const settle = (room: string) => {
    const g = pending.get(room)
    if (!g) return
    if (g.timer) clearTimeout(g.timer)
    pending.delete(room)
  }

  const ask = (room: string) => {
    const g = pending.get(room)
    if (!g) return
    g.timer = null
    if (g.missing.size === 0) {
      pending.delete(room)
      return
    }
    g.asked = true
    opts.request({ room, cursor: g.fromSeq, missed: g.missing.size })
  }

  return {
    observe(payload) {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { _room?: unknown; _rseq?: unknown; _rseq_min?: unknown; _seq?: unknown }
      if (typeof p._room !== 'string' || typeof p._rseq !== 'number') return
      const room = p._room
      const hi = p._rseq
      const lo = typeof p._rseq_min === 'number' ? p._rseq_min : hi
      const seq = typeof p._seq === 'number' ? p._seq : 0
      const st = rooms.get(room)
      if (!st) {
        rooms.set(room, { rseq: hi, seq })
        return
      }
      // A late arrival fills its place in a pending gap.
      const g = pending.get(room)
      if (g) for (let r = lo; r <= hi; r++) g.missing.delete(r)
      if (g && g.missing.size === 0 && !g.asked) settle(room)
      if (hi <= st.rseq) {
        // The room's counter restarted (it expires after an idle hour): a new baseline.
        if (hi < st.rseq && lo === 1) rooms.set(room, { rseq: hi, seq })
        return
      }
      if (lo > st.rseq + 1) {
        const from = st.rseq + 1
        const to = lo - 1
        const missed = to - from + 1
        counts.gaps++
        counts.missed += missed
        if (missed > MAX_MISSING) {
          settle(room)
          counts.refetched++
          opts.refetch([room])
        } else {
          const gap = pending.get(room) ?? {
            fromSeq: st.seq,
            toSeq: seq,
            missing: new Set<number>(),
            timer: null,
            asked: false
          }
          for (let r = from; r <= to; r++) gap.missing.add(r)
          gap.toSeq = Math.max(gap.toSeq, seq)
          pending.set(room, gap)
          if (!gap.timer && !gap.asked) gap.timer = setTimeout(() => ask(room), grace)
        }
      }
      rooms.set(room, { rseq: hi, seq: Math.max(st.seq, seq) })
    },
    replayed(answer) {
      const room = answer?.room
      if (typeof room !== 'string') return
      const g = pending.get(room)
      settle(room)
      if (!g) return
      if (answer.full) {
        counts.refetched++
        opts.refetch([room])
        return
      }
      for (const ev of answer.events ?? []) {
        if (typeof ev?.seq !== 'number' || ev.seq <= g.fromSeq) continue
        // Inside the gap by position, or by the room counter when the entry carries one.
        const inside =
          typeof ev.rseq === 'number' ? g.missing.has(ev.rseq) : g.toSeq === 0 || ev.seq < g.toSeq
        if (!inside) continue
        counts.replayed++
        opts.dispatch(ev.event, { ...ev.payload, _seq: ev.seq })
      }
    },
    reset(list) {
      const names = list ?? [...new Set([...rooms.keys(), ...pending.keys()])]
      for (const r of names) {
        settle(r)
        rooms.delete(r)
      }
    },
    stats() {
      return { ...counts }
    }
  }
}

/** A "refresh everything in this collection" notice — what lists already do for a `many` burst. */
export function coarseCollectionUpdate(collection: string): CollectionUpdateEvent {
  return { collection, item: null, items: null, many: true, count: 0, coalesced: true }
}

/**
 * The synthetic events a room refetch hands the live listeners: a collection room gets a
 * `many` burst, a record room an update of that record, a chat room the `touch` notice chat
 * already refetches on. Other rooms (presence, watch, ops) catch up on their next beat; the
 * caller also raises `nvr:realtime-stale` for anything that wants to know.
 */
export function refetchEventsFor(
  rooms: string[]
): Array<{ event: string; payload: Record<string, unknown> }> {
  const out: Array<{ event: string; payload: Record<string, unknown> }> = []
  for (const room of rooms) {
    if (room.startsWith('collection:')) {
      out.push({
        event: 'collection:update',
        payload: coarseCollectionUpdate(room.slice(11)) as unknown as Record<string, unknown>
      })
    } else if (room.startsWith('record:')) {
      const rest = room.slice(7)
      const i = rest.indexOf(':')
      if (i > 0)
        out.push({
          event: 'collection:update',
          payload: { collection: rest.slice(0, i), item: rest.slice(i + 1) }
        })
    } else if (room.startsWith('chat:')) {
      out.push({ event: 'chat:message', payload: { room: room.slice(5), touch: true } })
    }
  }
  return out
}
