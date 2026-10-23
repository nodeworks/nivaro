// api/src/services/traffic-map-batch.ts
/**
 * Batched Traffic Map frames (post-mortem 2026-10-23, item 3.1). On the demo the
 * `watch:traffic-map` room sent 189 broadcasts/min and 913 KB/min to ONE viewer: one frame per
 * API process per second (this node's plus every relayed one), each repeating its envelope, the
 * down labels and the tap figures that hold state rather than this second's counts.
 *
 * A page that joins with `admin:join { room: 'traffic-map', frames: 'batch' }` instead gets ONE
 * `traffic-map:batch` per emitter tick (~1 s) carrying every frame since the last one (this
 * node's and the ones the cluster relay brought), where
 *  - a sticky field (STICKY) or a tap figure equal to the same node's previous frame is left out
 *    and named in `same` / `ext_same`; the page copies it from that node's frame before;
 *  - at most BATCH_EVENTS_CAP ticker events ride along (errors and writes first; the rest are
 *    counted in `events_dropped`, as the per-frame cap already does), each one carrying only the
 *    fields that differ from the event before it in the same frame (`_x` names a field the
 *    previous one had and this one has not) — a burst of one route repeats nearly everything.
 * A key batch (every field in full) goes out when a socket joins, when a page asks for one
 * (`traffic-map:resync`, after it met a delta it has no base for) and every KEY_EVERY_S.
 *
 * Sockets that joined without the flag (an older page build) keep the per-frame
 * `traffic-map:frame` events, so either side can be the newer one. State is per store, which
 * is per tenant in cloud mode (the room name carries the store).
 */
import type { FrameWire, TrafficEventWire } from './traffic-map.js'

export const TRAFFIC_MAP_BATCH_EVENT = 'traffic-map:batch'
export const TRAFFIC_MAP_RESYNC_EVENT = 'traffic-map:resync'
/** Ticker events per batch (the per-frame cap is per process; a batch holds every process). */
export const BATCH_EVENTS_CAP = 40
/** A key batch at least this often, so a page that lost its base heals without asking. */
export const KEY_EVERY_S = 30
/** Resync requests closer together than this share one key batch. */
export const RESYNC_MIN_GAP_MS = 2000
/** Relayed frames held for the next tick at most (a stalled tick must not grow it unbounded). */
export const QUEUE_CAP = 60
/** Frame fields that describe the node, not the second: sent when they change. */
export const STICKY = ['v', 'instance', 'node_scope', 'window_s', 'down_labels'] as const

/** One frame in a batch: a FrameWire whose unchanged sticky fields / tap figures are left out. */
export type FrameDeltaWire = Partial<FrameWire> &
  Pick<FrameWire, 'at' | 'frame' | 'events'> & {
    /** Sticky fields equal to this node's previous frame (copy them from there). */
    same?: string[]
    /** Tap ids whose figure equals this node's previous frame (copy them from there). */
    ext_same?: string[]
  }
export interface FrameBatchWire {
  v: 2
  /** Every frame complete: the page may drop what it kept per node. */
  key?: true
  frames: FrameDeltaWire[]
}

interface NodeBase {
  sticky: Map<string, string>
  ext: Map<string, string>
}

/** Delta encoder: remembers, per node, what the last batch said (pure; tests drive it). */
export class BatchEncoder {
  private nodes = new Map<string, NodeBase>()
  reset(): void {
    this.nodes.clear()
  }
  encode(frames: FrameWire[], key: boolean): FrameBatchWire {
    if (key) this.nodes.clear()
    const out: FrameDeltaWire[] = []
    for (const f of frames) {
      const nodeKey = f.node ?? ''
      const base = this.nodes.get(nodeKey)
      const next: NodeBase = { sticky: new Map(), ext: new Map() }
      const d: Record<string, unknown> = {}
      const same: string[] = []
      for (const [k, v] of Object.entries(f)) {
        if (v === undefined || k === 'ext') continue
        if (!(STICKY as readonly string[]).includes(k)) {
          d[k] = k === 'events' ? packEvents(v as TrafficEventWire[]) : v
          continue
        }
        const json = JSON.stringify(v)
        next.sticky.set(k, json)
        if (base?.sticky.get(k) === json) same.push(k)
        else d[k] = v
      }
      if (f.ext) {
        const ext: Record<string, unknown> = {}
        const extSame: string[] = []
        for (const [id, v] of Object.entries(f.ext)) {
          if (v === undefined) continue
          const json = JSON.stringify(v)
          next.ext.set(id, json)
          if (base?.ext.get(id) === json) extSame.push(id)
          else ext[id] = v
        }
        if (Object.keys(ext).length) d.ext = ext
        if (extSame.length) d.ext_same = extSame
      }
      if (same.length) d.same = same
      this.nodes.set(nodeKey, next)
      out.push(d as FrameDeltaWire)
    }
    const batch: FrameBatchWire = { v: 2, frames: out }
    if (key) batch.key = true
    return batch
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A frame's events with each one reduced to what differs from the event before it. */
export function packEvents(events: TrafficEventWire[]): Array<Record<string, unknown>> {
  let prev: Record<string, unknown> | null = null
  return events.map((e) => {
    const cur = e as unknown as Record<string, unknown>
    if (!prev) {
      prev = cur
      return cur
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(cur))
      if (v !== undefined && !sameValue(prev[k], v)) out[k] = v
    const gone: string[] = []
    for (const [k, v] of Object.entries(prev))
      if (v !== undefined && cur[k] === undefined) gone.push(k)
    if (gone.length) out._x = gone
    prev = cur
    return out
  })
}

const PRIORITY: Record<string, number> = { error: 0, create: 1, delete: 2, update: 3, read: 4 }

/**
 * Frames with at most `cap` events between them (errors, then writes, then the oldest reads);
 * each frame's `events_dropped` grows by what it lost. Never mutates the input frames.
 */
export function capBatchEvents(frames: FrameWire[], cap = BATCH_EVENTS_CAP): FrameWire[] {
  let total = 0
  for (const f of frames) total += f.events.length
  if (total <= cap) return frames
  const all: Array<{ i: number; ev: TrafficEventWire }> = []
  frames.forEach((f, i) => {
    for (const ev of f.events) all.push({ i, ev })
  })
  all.sort((a, b) => (PRIORITY[a.ev.kind] ?? 9) - (PRIORITY[b.ev.kind] ?? 9) || a.ev.t - b.ev.t)
  const keep = new Set(all.slice(0, cap).map((x) => x.ev))
  return frames.map((f) => {
    const events = f.events.filter((ev) => keep.has(ev))
    const lost = f.events.length - events.length
    if (!lost) return f
    return { ...f, events, events_dropped: (f.events_dropped ?? 0) + lost }
  })
}

// ── per-store room state ────────────────────────────────────────────────────
interface IoRoomsLike {
  sockets: {
    adapter: { rooms: Map<string, Set<string>> }
    /** socket.io's socket map (absent in test doubles: everyone counts as a per-frame page). */
    sockets?: Map<string, { data?: unknown }>
  }
}
export interface RoomMembers {
  all: number
  batch: string[]
  legacy: string[]
}

/** The room's local sockets, split by whether they asked for batches. */
export function roomMembers(io: IoRoomsLike | null | undefined, room: string): RoomMembers {
  const set = io?.sockets?.adapter?.rooms?.get(room)
  if (!set?.size) return { all: 0, batch: [], legacy: [] }
  const map = io?.sockets?.sockets
  const batch: string[] = []
  const legacy: string[] = []
  for (const sid of set) {
    const data = map?.get(sid)?.data as { trafficMapBatch?: unknown } | undefined
    if (data?.trafficMapBatch === true) batch.push(sid)
    else legacy.push(sid)
  }
  return { all: set.size, batch, legacy }
}

interface StoreBatchState {
  enc: BatchEncoder
  queue: FrameWire[]
  members: Set<string>
  lastKeySec: number
  wantKey: boolean
  lastResyncAt: number
}
const states = new Map<string, StoreBatchState>()

function stateOf(store: string): StoreBatchState {
  let st = states.get(store)
  if (!st) {
    st = {
      enc: new BatchEncoder(),
      queue: [],
      members: new Set(),
      lastKeySec: Number.NEGATIVE_INFINITY,
      wantKey: true,
      lastResyncAt: 0
    }
    states.set(store, st)
  }
  return st
}

/** Stores holding relayed frames for their next batch (the emitter visits them too). */
export function batchStoreIds(): string[] {
  return [...states.keys()]
}

/** No batch page watches the store here any more: forget its queue and delta bases. */
export function dropBatchState(store: string): void {
  states.delete(store)
}

/** A frame the cluster relay brought for a store a batch page watches: hold it for the tick. */
export function queueBatchFrame(store: string, frame: FrameWire): void {
  const st = stateOf(store)
  st.queue.push(frame)
  if (st.queue.length > QUEUE_CAP) st.queue.splice(0, st.queue.length - QUEUE_CAP)
}

/** A page asked for full frames (it met a delta it has no base for). */
export function requestBatchKey(store: string, nowMs = Date.now()): void {
  const st = states.get(store)
  if (!st || nowMs - st.lastResyncAt < RESYNC_MIN_GAP_MS) return
  st.lastResyncAt = nowMs
  st.wantKey = true
}

/**
 * The batch for this tick: this node's frames plus the relayed ones held since the last tick,
 * oldest second first. Null when there is nothing to send. A socket that was not in the room at
 * the last tick (a new page, a tab back from hidden) makes it a key batch.
 */
export function takeBatch(
  store: string,
  batchSockets: string[],
  localFrames: FrameWire[],
  sec: number
): FrameBatchWire | null {
  const st = stateOf(store)
  const frames = [...localFrames, ...st.queue].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.frame - b.frame
  )
  st.queue = []
  const joined = batchSockets.some((sid) => !st.members.has(sid))
  st.members = new Set(batchSockets)
  if (!frames.length) {
    if (joined) st.wantKey = true // the joiner's first batch must still be a key one
    return null
  }
  const key = st.wantKey || joined || sec - st.lastKeySec >= KEY_EVERY_S
  if (key) {
    st.wantKey = false
    st.lastKeySec = sec
  }
  return st.enc.encode(capBatchEvents(frames), key)
}

export function resetTrafficMapBatches(): void {
  states.clear()
}
