import type { TrafficFrame } from './node-merge'

/**
 * Post-mortem 3.1 — `traffic-map:batch` (api services/traffic-map-batch.ts): one emit per second
 * with every API process's frames since the last one. A frame leaves out the fields and tap
 * figures that equal the same process's previous frame and names them in `same` / `ext_same`;
 * each event carries only what differs from the event before it (`_x` = fields to drop).
 */
export type FrameDeltaWire = Partial<TrafficFrame> &
  Pick<TrafficFrame, 'at' | 'frame' | 'events'> & {
    same?: string[]
    ext_same?: string[]
  }
export interface FrameBatchWire {
  v: 2
  /** Every frame complete: forget what was kept per process. */
  key?: true
  frames: FrameDeltaWire[]
}

/** Events back in full: each packed one is the previous event with its own fields on top. */
export function unpackEvents(packed: unknown[]): TrafficFrame['events'] {
  let prev: Record<string, unknown> | null = null
  return (packed ?? []).map((p) => {
    const { _x, ...own } = (p ?? {}) as Record<string, unknown> & { _x?: unknown }
    const e: Record<string, unknown> = prev ? { ...prev, ...own } : own
    if (Array.isArray(_x)) for (const k of _x) delete e[String(k)]
    prev = e
    return e
  }) as unknown as TrafficFrame['events']
}

export const TRAFFIC_MAP_BATCH_EVENT = 'traffic-map:batch'
export const TRAFFIC_MAP_RESYNC_EVENT = 'traffic-map:resync'

/**
 * Rebuilds whole frames from a batch, keeping each process's last frame as the base for the
 * next delta. Decode EVERY batch (paused or not) — the server's base is what it sent, so a
 * skipped batch would leave this one copying older values.
 */
export class BatchDecoder {
  private last = new Map<string, TrafficFrame>()

  reset(): void {
    this.last.clear()
  }

  /** `missing` = a delta named a field this page has no base for: ask for a key batch. */
  decode(batch: FrameBatchWire): { frames: TrafficFrame[]; missing: boolean } {
    if (batch.key) this.last.clear()
    let missing = false
    const frames: TrafficFrame[] = []
    for (const d of batch.frames ?? []) {
      const nodeKey = d.node ?? ''
      const base = this.last.get(nodeKey) as Record<string, unknown> | undefined
      const { same, ext_same: extSame, ...rest } = d
      const f = { ...rest } as Record<string, unknown>
      f.events = unpackEvents((d.events ?? []) as unknown[])
      for (const k of same ?? []) {
        if (base && base[k] !== undefined) f[k] = base[k]
        else missing = true
      }
      const ext: Record<string, unknown> = { ...(d.ext ?? {}) }
      const baseExt = base?.ext as Record<string, unknown> | undefined
      for (const id of extSame ?? []) {
        if (baseExt && baseExt[id] !== undefined) ext[id] = baseExt[id]
        else missing = true
      }
      if (Object.keys(ext).length) f.ext = ext
      else delete f.ext
      // Whatever a base never gave keeps the frame readable (the model reads these plainly).
      f.v ??= 1
      f.window_s ??= 1
      f.instance ??= ''
      f.node_scope ??= ''
      f.entities ??= {}
      f.callers ??= {}
      f.down ??= {}
      f.edges_in ??= {}
      f.edges_out ??= {}
      f.sockets ??= 0
      f.journal_seq ??= null
      const frame = f as unknown as TrafficFrame
      this.last.set(nodeKey, frame)
      frames.push(frame)
    }
    return { frames, missing }
  }
}
