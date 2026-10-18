// api/src/services/traffic-taps/business-heat.ts
/**
 * Traffic Map tap `business-heat` (#2207) — which part of the business the traffic is ABOUT.
 *
 * Single-record reads and writes are attributed to the User Scope dimension values the record
 * belongs to (its zone, region, project type…): the tap queues the record ref, and a flush (at
 * most every FLUSH_MS, while someone watches the map) resolves the queued refs in one batched read
 * per dimension × collection through resolveRecordDimensionIds, then bumps per-minute counters
 * keyed by dimension and target id. Only dimension NAMES and target ids are kept; the route turns
 * ids into the dimension's display labels. No record values are held.
 *
 * Bounded: the queue holds QUEUE_CAP refs (more are dropped and counted), the counters hold
 * KEY_CAP keys, and nothing is queued unless the map was watched in the last WATCH_GRACE_MS.
 * Self-hosted only (a cloud tenant store attributes nothing). List reads are not attributed:
 * a list has no single record to resolve.
 */
import { getTenantId } from '../../db/tenant-context.js'
import {
  MinuteCounter,
  registerTrafficTap,
  type TapRequestCtx,
  type TapWriteCtx,
  tapState
} from '../traffic-taps.js'
import { listScopeDimensions, resolveRecordDimensionIds, scopeHopsFor } from '../user-scopes.js'
import { laneOfCollection, recordOfRequestPath } from './hot-records.js'

export const BUSINESS_HEAT_TAP = 'business-heat'
const QUEUE_CAP = 200
const KEY_CAP = 150
const FLUSH_MS = 5_000
const WATCH_GRACE_MS = 30_000
const SEP = '\u0001'

interface Ref {
  collection: string
  id: string
  write: boolean
  sec: number
}
interface State {
  queue: Ref[]
  counts: MinuteCounter
  lastFrameAt: number
  lastFlushAt: number
  flushing: boolean
  dropped: number
  attributed: number
}
const state = () =>
  tapState<State>(BUSINESS_HEAT_TAP, () => ({
    queue: [],
    counts: new MinuteCounter(KEY_CAP),
    lastFrameAt: 0,
    lastFlushAt: 0,
    flushing: false,
    dropped: 0,
    attributed: 0
  }))

const heatKey = (dimension: string, id: string, write: boolean) =>
  `${dimension}${SEP}${id}${SEP}${write ? 'w' : 'r'}`

/** Queue one ref; false when dropped (nobody watching, or the queue is full). */
export function queueRef(s: State, ref: Ref, now = Date.now()): boolean {
  if (now - s.lastFrameAt > WATCH_GRACE_MS) return false
  if (s.queue.length >= QUEUE_CAP) {
    s.dropped++
    return false
  }
  s.queue.push(ref)
  return true
}

/** Group queued refs by collection (ids de-duplicated, writes kept apart from reads). */
export function groupRefs(
  refs: Ref[]
): Map<string, { reads: Map<string, number>; writes: Map<string, number> }> {
  const out = new Map<string, { reads: Map<string, number>; writes: Map<string, number> }>()
  for (const r of refs) {
    let g = out.get(r.collection)
    if (!g) {
      g = { reads: new Map(), writes: new Map() }
      out.set(r.collection, g)
    }
    const m = r.write ? g.writes : g.reads
    m.set(r.id, (m.get(r.id) ?? 0) + 1)
  }
  return out
}

async function flush(s: State): Promise<void> {
  if (s.flushing) return
  s.flushing = true
  try {
    const batch = s.queue.splice(0, QUEUE_CAP)
    if (batch.length === 0) return
    const sec = Math.floor(Date.now() / 1000)
    const dims = await listScopeDimensions()
    if (dims.length === 0) return
    for (const [collection, g] of groupRefs(batch)) {
      const ids = [...new Set([...g.reads.keys(), ...g.writes.keys()])]
      for (const dim of dims) {
        const hops = await scopeHopsFor(dim, collection)
        if (!hops) continue
        const by = await resolveRecordDimensionIds(collection, ids, hops)
        for (const [rid, targets] of by) {
          for (const t of targets) {
            const reads = g.reads.get(rid) ?? 0
            const writes = g.writes.get(rid) ?? 0
            if (reads) s.counts.bump(heatKey(dim.name, t, false), sec, reads)
            if (writes) s.counts.bump(heatKey(dim.name, t, true), sec, writes)
            s.attributed += reads + writes
          }
        }
      }
    }
  } catch {
    /* attribution is best-effort; never touch a request */
  } finally {
    s.flushing = false
    s.lastFlushAt = Date.now()
  }
}

function maybeFlush(s: State): void {
  if (s.flushing || s.queue.length === 0) return
  if (Date.now() - s.lastFlushAt < FLUSH_MS && s.queue.length < QUEUE_CAP / 2) return
  void flush(s)
}

export interface HeatRow {
  dimension: string
  id: string
  reads: number
  writes: number
}

/** Heat per dimension value over the window, hottest first. */
export function heatRows(
  s: Pick<State, 'counts'>,
  windowS: number,
  sec: number,
  limit = 40
): HeatRow[] {
  const by = new Map<string, HeatRow>()
  for (const [key, n] of s.counts.top(windowS, sec, KEY_CAP)) {
    const [dimension, id, kind] = key.split(SEP)
    if (!dimension || id == null) continue
    const k = `${dimension}${SEP}${id}`
    const row = by.get(k) ?? { dimension, id, reads: 0, writes: 0 }
    if (kind === 'w') row.writes += n
    else row.reads += n
    by.set(k, row)
  }
  return [...by.values()]
    .sort((a, b) => b.reads + b.writes * 3 - (a.reads + a.writes * 3) || a.id.localeCompare(b.id))
    .slice(0, limit)
}

registerTrafficTap({
  id: BUSINESS_HEAT_TAP,
  onRequest(c: TapRequestCtx) {
    if (getTenantId()) return
    const s = state()
    if (c.ev.method !== 'GET' || c.ev.status >= 400) return
    const rec = recordOfRequestPath(c.ev.path)
    if (!rec || rec.lock || laneOfCollection(rec.collection) !== 'items') return
    if (queueRef(s, { collection: rec.collection, id: rec.id, write: false, sec: c.sec }))
      maybeFlush(s)
  },
  onWrite(c: TapWriteCtx) {
    if (getTenantId()) return
    const s = state()
    if (laneOfCollection(c.ev.collection) !== 'items') return
    if (
      queueRef(s, { collection: c.ev.collection, id: String(c.ev.item), write: true, sec: c.sec })
    )
      maybeFlush(s)
  },
  frame() {
    // The map is being watched: attribution is worth its reads for the next WATCH_GRACE_MS.
    state().lastFrameAt = Date.now()
    return undefined
  },
  snapshot(windowS, sec) {
    const s = state()
    s.lastFrameAt = Date.now()
    return { rows: heatRows(s, windowS, sec), dropped: s.dropped, attributed: s.attributed }
  },
  sweep(sec) {
    state().counts.sweep(sec)
  },
  reset() {
    /* tapState was cleared with it */
  }
})
