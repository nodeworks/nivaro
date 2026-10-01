// api/src/services/traffic-cluster.ts
/**
 * Traffic Map across every API process (#1098). Each node's aggregator stays per process; this
 * relay makes them one view:
 *
 *  - a node with watchers in a store's room announces it over Redis every 2 s; a node that heard
 *    an announcement in the last 5 s keeps building frames for that store and publishes them,
 *    and every node with local watchers re-emits the other nodes' frames to its own sockets.
 *    No watcher anywhere = no announcement = nothing published (idle clusters stay silent).
 *  - a snapshot request is answered by every node; the requester merges them (traffic-merge.ts).
 *
 * One pub/sub channel (`<REDIS_CHANNEL_PREFIX>nvr:traffic-map`), a duplicated connection for the
 * subscription. Messages carry the store id, so tenants (#1132) stay apart.
 */
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import {
  type FrameWire,
  setTrafficCluster,
  TRAFFIC_MAP_EVENT,
  type TrafficSnapshot,
  trafficRoomFor
} from './traffic-map.js'
import { withTrafficStore } from './traffic-taps.js'

export const ANNOUNCE_EVERY_MS = 2000
export const WATCH_TTL_MS = 5000
export const SNAPSHOT_TIMEOUT_MS = 900

interface IoLike {
  sockets: { adapter: { rooms: Map<string, Set<string>> } }
  local?: { to(room: string): { emit(ev: string, payload: unknown): void } }
  to(room: string): { emit(ev: string, payload: unknown): void }
}

export type ClusterMessage =
  | { t: 'watch'; node: string; store: string }
  | { t: 'frame'; node: string; store: string; frame: FrameWire }
  | { t: 'snap-req'; id: string; node: string; store: string; window: number }
  | { t: 'snap-res'; id: string; to: string; node: string; snapshot: TrafficSnapshot }

export interface ClusterPeers {
  /** Node ids believed alive (the instance roster); the requester waits for these. */
  list(): Promise<string[]>
}

interface Pending {
  store: string
  got: Map<string, TrafficSnapshot>
  expect: Set<string>
  done: (v: Map<string, TrafficSnapshot>) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The relay's state machine, transport-free so it can be tested: `publish` sends a message,
 * `receive` handles one.
 */
export class TrafficClusterRelay {
  private remote = new Map<string, number>() // store → watched until (ms)
  private lastAnnounce = new Map<string, number>()
  private pending = new Map<string, Pending>()
  constructor(
    readonly node: string,
    private send: (m: ClusterMessage) => void,
    private io: () => IoLike | null,
    private snapshotOf: (window: number) => TrafficSnapshot,
    private peers: ClusterPeers,
    private now: () => number = () => Date.now()
  ) {}

  announce(store: string): void {
    const t = this.now()
    if (t - (this.lastAnnounce.get(store) ?? Number.NEGATIVE_INFINITY) < ANNOUNCE_EVERY_MS) return
    this.lastAnnounce.set(store, t)
    this.send({ t: 'watch', node: this.node, store })
  }
  watched(store: string): boolean {
    return (this.remote.get(store) ?? 0) > this.now()
  }
  publish(store: string, frame: FrameWire): void {
    this.send({ t: 'frame', node: this.node, store, frame })
  }

  receive(m: ClusterMessage): void {
    if (!m || typeof m !== 'object' || m.node === this.node) return
    if (m.t === 'watch') {
      this.remote.set(m.store, this.now() + WATCH_TTL_MS)
    } else if (m.t === 'frame') {
      const io = this.io()
      const room = trafficRoomFor(m.store)
      if (io && (io.sockets?.adapter?.rooms?.get(room)?.size ?? 0) > 0)
        (io.local ?? io).to(room).emit(TRAFFIC_MAP_EVENT, m.frame)
    } else if (m.t === 'snap-req') {
      const w = Number(m.window)
      if (w !== 60 && w !== 300 && w !== 900) return
      let snapshot: TrafficSnapshot
      try {
        snapshot = withTrafficStore(m.store, () => this.snapshotOf(w))
      } catch {
        return
      }
      this.send({ t: 'snap-res', id: m.id, to: m.node, node: this.node, snapshot })
    } else if (m.t === 'snap-res') {
      if (m.to !== this.node) return
      const p = this.pending.get(m.id)
      if (!p) return
      p.got.set(m.node, m.snapshot)
      if ([...p.expect].every((n) => p.got.has(n))) this.finish(m.id)
    }
  }

  private finish(id: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.done(p.got)
  }

  /**
   * Every node's snapshot of `store` (this node's included), keyed by node id. Waits for the
   * nodes the roster lists, at most `timeoutMs` — a node that does not answer is left out.
   */
  async collect(
    store: string,
    window: number,
    timeoutMs = SNAPSHOT_TIMEOUT_MS
  ): Promise<Map<string, TrafficSnapshot>> {
    const local = withTrafficStore(store, () => this.snapshotOf(window))
    const peers = (await this.peers.list().catch(() => [])).filter((n) => n !== this.node)
    const got = new Map<string, TrafficSnapshot>([[this.node, local]])
    if (peers.length === 0) return got
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id), timeoutMs)
      timer.unref?.()
      this.pending.set(id, { store, got, expect: new Set(peers), done: resolve, timer })
      this.send({ t: 'snap-req', id, node: this.node, store, window })
    })
  }
}

let relay: TrafficClusterRelay | null = null
export function trafficClusterRelay(): TrafficClusterRelay | null {
  return relay
}

/** Start the relay on this process (no-op when already running). Returns a stop function. */
export async function startTrafficCluster(
  redis: Redis,
  opts: {
    node: string
    io: () => IoLike | null
    snapshotOf: (window: number) => TrafficSnapshot
    peers: ClusterPeers
  }
): Promise<() => Promise<void>> {
  if (relay) return async () => {}
  const channel = `${process.env.REDIS_CHANNEL_PREFIX ?? ''}nvr:traffic-map`
  const sub = redis.duplicate()
  const send = (m: ClusterMessage) => {
    redis.publish(channel, JSON.stringify(m)).catch(() => {})
  }
  const r = new TrafficClusterRelay(opts.node, send, opts.io, opts.snapshotOf, opts.peers)
  sub.on('message', (ch: string, raw: string) => {
    if (ch !== channel) return
    try {
      r.receive(JSON.parse(raw) as ClusterMessage)
    } catch {
      /* a malformed message never affects the map */
    }
  })
  sub.on('error', () => {})
  await sub.subscribe(channel)
  relay = r
  setTrafficCluster(r)
  return async () => {
    setTrafficCluster(null)
    relay = null
    await sub.quit().catch(() => {})
  }
}
