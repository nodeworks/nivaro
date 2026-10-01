import type { TrafficFrame as WireFrame } from '../types'

/** A frame with the process id the emitter stamps (#1098). */
export type TrafficFrame = WireFrame & { node?: string }

/**
 * #1098 — frames from several API processes. Each node's frame carries complete per-second
 * totals for that node, so a combined frame for a second is the sum over the nodes that sent one
 * (latency: the worst node). Pure; NodeFeed (nodes.tsx) decides when to merge.
 */
export function mergeFrames(frames: TrafficFrame[], frameNo: number): TrafficFrame {
  if (frames.length === 1) return { ...frames[0], frame: frameNo }
  const first = frames[0]
  const entities: Record<string, number[]> = {}
  const callers: Record<string, number[]> = {}
  const down: Record<string, number[]> = {}
  const edgesIn: Record<string, number> = {}
  const edgesOut: Record<string, number> = {}
  const sumInto = (
    target: Record<string, number[]>,
    src: Record<string, number[]>,
    maxAt: number
  ) => {
    for (const [k, v] of Object.entries(src ?? {})) {
      const cur = target[k]
      if (!cur) {
        target[k] = v.slice()
        continue
      }
      for (let i = 0; i < v.length; i++) {
        cur[i] = i === maxAt ? Math.max(cur[i] ?? 0, v[i] ?? 0) : (cur[i] ?? 0) + (v[i] ?? 0)
      }
    }
  }
  for (const f of frames) {
    sumInto(entities, f.entities, 6) // [req, read, create, update, delete, error, p95]
    sumInto(callers, f.callers, -1) // [req, error]
    sumInto(down, f.down, 2) // [req, error, p95]
    for (const [k, n] of Object.entries(f.edges_in ?? {})) edgesIn[k] = (edgesIn[k] ?? 0) + n
    for (const [k, n] of Object.entries(f.edges_out ?? {})) edgesOut[k] = (edgesOut[k] ?? 0) + n
  }
  const events = frames.flatMap((f) => f.events ?? []).sort((a, b) => a.t - b.t)
  const dropped = frames.reduce((a, f) => a + (f.events_dropped ?? 0), 0)
  const seqs = frames.map((f) => f.journal_seq).filter((s): s is number => s != null)
  const out: TrafficFrame = {
    ...first,
    frame: frameNo,
    node: 'all',
    node_scope: `all ${frames.length} API processes`,
    entities,
    callers,
    down,
    edges_in: edgesIn,
    edges_out: edgesOut,
    events,
    sockets: frames.reduce((a, f) => a + (f.sockets ?? 0), 0),
    journal_seq: seqs.length ? Math.max(...seqs) : null
  }
  if (dropped) out.events_dropped = dropped
  else delete out.events_dropped
  const ext = frames.find((f) => f.ext && Object.keys(f.ext).length)?.ext
  if (ext) out.ext = ext
  else delete out.ext
  return out
}

export type NodeScope = { mode: 'all' } | { mode: 'node'; node: string }

/** Frames in the per-node / combined toggle: buffer per second, merge when every live node sent. */
export class NodeFeed {
  scope: NodeScope = { mode: 'all' }
  /** This page's own API process (from the snapshot). */
  self = ''
  /** Nodes the current snapshot covered (1 = this node only). */
  snapshotNodes = 1
  private seen = new Map<string, number>() // node → last frame (ms)
  private pending = new Map<number, { frames: Map<string, TrafficFrame>; flushed: Set<string> }>()
  private seq = 0
  private listeners = new Set<() => void>()
  private reseeders = new Set<() => void>()
  private lastReseed = 0
  timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private now: () => number = () => Date.now(),
    /** How long a node stays "live" after its last frame. */
    readonly liveMs = 10_000,
    /** How long to wait for the other nodes' frames of one second. */
    readonly waitMs = 1500
  ) {}

  /** Live nodes, this one first. */
  nodes(): string[] {
    const t = this.now()
    const live = [...this.seen].filter(([, at]) => t - at <= this.liveMs).map(([n]) => n)
    if (this.self && !live.includes(this.self)) live.push(this.self)
    return live.sort((a, b) => (a === this.self ? -1 : b === this.self ? 1 : a.localeCompare(b)))
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  /** The page reloads its snapshot when this fires (scope change, a node appearing). */
  onReseed(fn: () => void): () => void {
    this.reseeders.add(fn)
    return () => this.reseeders.delete(fn)
  }
  private changed(): void {
    for (const fn of this.listeners) fn()
  }
  private reseed(): void {
    this.lastReseed = this.now()
    for (const fn of this.reseeders) fn()
  }

  setScope(scope: NodeScope): void {
    this.scope = scope
    this.pending.clear()
    this.changed()
    this.reseed()
  }

  /** Remember what the snapshot covered (call after every snapshot load). */
  noteSnapshot(snap: object, nodes = 1): void {
    const node = (snap as { node?: unknown }).node
    if (typeof node === 'string' && node && node !== 'all') this.self = node
    this.snapshotNodes = nodes
  }

  /** The snapshot URL for the current scope. */
  snapshotUrl(win: number): string {
    if (this.scope.mode === 'node' && this.scope.node !== this.self && this.self)
      return `/traffic-map/cluster-snapshot?window=${win}&node=${encodeURIComponent(this.scope.node)}`
    if (this.scope.mode === 'all' && this.nodes().length > 1)
      return `/traffic-map/cluster-snapshot?window=${win}`
    return `/traffic-map/snapshot?window=${win}`
  }

  /** A frame from the socket: apply it (or the merged frame it completes) through `apply`. */
  accept(f: TrafficFrame, apply: (f: TrafficFrame) => void): void {
    const node = f.node ?? (this.self || 'self')
    const before = this.nodes().length
    this.seen.set(node, this.now())
    const after = this.nodes().length
    if (after !== before) this.changed()
    if (this.scope.mode === 'node') {
      if (node === this.scope.node || (!f.node && this.scope.node === this.self)) apply(f)
      return
    }
    // A node joined while the snapshot covered fewer: re-seed so its history is in.
    if (after > this.snapshotNodes && this.now() - this.lastReseed > 10_000) this.reseed()
    if (after <= 1) {
      apply(f)
      return
    }
    const sec = Math.floor(new Date(f.at).getTime() / 1000)
    let b = this.pending.get(sec)
    if (!b) {
      b = { frames: new Map(), flushed: new Set() }
      this.pending.set(sec, b)
    }
    b.frames.set(node, f)
    if (b.flushed.size) {
      // A late node for an already-applied second: re-apply the fuller sum (frames SET their
      // second), with only the late node's events.
      const merged = mergeFrames([...b.frames.values()], ++this.seq)
      apply({ ...merged, events: f.events ?? [], events_dropped: f.events_dropped })
      b.flushed.add(node)
      return
    }
    const live = new Set(this.nodes())
    if ([...live].every((n) => b.frames.has(n))) this.flush(sec, apply)
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        for (const s of [...this.pending.keys()]) {
          const p = this.pending.get(s)
          if (p && !p.flushed.size) this.flush(s, apply)
        }
      }, this.waitMs)
    }
    // Forget seconds far behind (late frames past this are dropped).
    for (const s of [...this.pending.keys()]) if (s < sec - 10) this.pending.delete(s)
  }

  private flush(sec: number, apply: (f: TrafficFrame) => void): void {
    const b = this.pending.get(sec)
    if (!b || b.flushed.size) return
    apply(mergeFrames([...b.frames.values()], ++this.seq))
    for (const n of b.frames.keys()) b.flushed.add(n)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }
}

/** One feed per page load (the toolbar control and the page share it). */
export const nodeFeed = new NodeFeed()
