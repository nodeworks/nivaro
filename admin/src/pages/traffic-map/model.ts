import {
  type Filters,
  type Kind,
  LANE_ORDER,
  type Lane,
  SLOT,
  type SnapshotEntity,
  type TrafficEventWire,
  type TrafficFrame,
  type TrafficSnapshot
} from './types'

export const RING = 900
const SLOTS = 6
export const TICKER_CAP = 80

export function defaultFilters(): Filters {
  return {
    types: new Set<Lane>(LANE_ORDER.filter((l) => l !== 'system' && l !== 'other')),
    kinds: new Set<Kind>(['read', 'create', 'update', 'delete', 'error']),
    caller: '',
    win: 60
  }
}
export function applyFilters(f: Filters, e: { lane: Lane; kind?: Kind; caller?: string }): boolean {
  if (!f.types.has(e.lane)) return false
  if (e.kind && !f.kinds.has(e.kind)) return false
  if (f.caller && e.caller && e.caller !== f.caller) return false
  return true
}
export function laneOf(key: string): Lane {
  return key.slice(0, key.indexOf('/')) as Lane
}

class Ring {
  counts = new Float64Array(RING * SLOTS)
  p95 = 0
  last: number
  constructor(sec: number) {
    this.last = sec
  }
  catchUp(sec: number): void {
    if (sec <= this.last) return
    const gap = Math.min(sec - this.last, RING)
    for (let i = 1; i <= gap; i++) {
      const idx = ((this.last + i) % RING) * SLOTS
      this.counts.fill(0, idx, idx + SLOTS)
    }
    this.last = sec
  }
  add(sec: number, slots: number[]): void {
    this.catchUp(sec)
    const base = (sec % RING) * SLOTS
    for (let k = 0; k < SLOTS && k < slots.length; k++) this.counts[base + k] += slots[k]
  }
  sum(sec: number, win: number): number[] {
    this.catchUp(sec)
    const out = [0, 0, 0, 0, 0, 0]
    for (let i = 0; i < win; i++) {
      const base = ((((sec - i) % RING) + RING) % RING) * SLOTS
      for (let k = 0; k < SLOTS; k++) out[k] += this.counts[base + k]
    }
    return out
  }
  series(sec: number, win: number, points: number): number[] {
    this.catchUp(sec)
    const per = win / points
    const out = new Array<number>(points).fill(0)
    for (let i = 0; i < win; i++) {
      const s = sec - win + 1 + i
      const base = (((s % RING) + RING) % RING) * SLOTS
      out[Math.min(points - 1, Math.floor(i / per))] += this.counts[base + SLOT.req]
    }
    return out
  }
}

export class TrafficModel {
  private entities = new Map<string, Ring>()
  private callers = new Map<string, Ring>()
  private downs = new Map<string, Ring>()
  private meta = new Map<string, SnapshotEntity>()
  private edgeIn = new Map<string, Ring>() // slot 0 = count
  private edgeOut = new Map<string, Ring>()
  private nowSec = Math.floor(Date.now() / 1000)
  events: TrafficEventWire[] = []
  pulses = new Map<string, { kind: Kind; t: number }>()
  flashes = new Map<string, number>()
  instance = ''
  nodeScope = ''
  sockets = 0
  journalSeq: number | null = null
  frameNo = 0
  lastFrameAt = 0
  downLabels = new Map<string, string>()

  get now(): number {
    return this.nowSec
  }

  private ring(map: Map<string, Ring>, key: string): Ring {
    let r = map.get(key)
    if (!r) {
      r = new Ring(this.nowSec)
      map.set(key, r)
    }
    return r
  }

  /** Replace every ring from the snapshot (reconnect / visibility return / window change). */
  applySnapshot(snap: TrafficSnapshot): void {
    const sec = Math.floor(new Date(snap.at).getTime() / 1000)
    this.nowSec = sec
    this.entities.clear()
    this.callers.clear()
    this.downs.clear()
    this.meta.clear()
    this.edgeIn.clear()
    this.edgeOut.clear()
    this.instance = snap.instance
    this.nodeScope = snap.node_scope
    this.sockets = snap.sockets.count
    this.journalSeq = snap.journal_seq
    this.frameNo = snap.frame
    const win = snap.window_s
    const per = win / 60
    for (const e of snap.entities) {
      const r = this.ring(this.entities, e.key)
      r.p95 = e.p95
      this.meta.set(e.key, e)
      const tot = e.req || 1
      // spread each series bucket evenly over its seconds; kinds follow the window's mix
      const mix = [1, e.read / tot, e.create / tot, e.update / tot, e.delete / tot, e.error / tot]
      for (let b = 0; b < e.series.length; b++) {
        const perSec = e.series[b] / per
        for (let s = 0; s < per; s++) {
          const at = sec - win + 1 + Math.floor(b * per) + s
          r.add(
            at,
            mix.map((m) => m * perSec)
          )
        }
      }
      for (const [d, n] of Object.entries(e.down))
        this.ring(this.edgeOut, `${e.lane}>${d}`).add(sec, [n])
      for (const c of e.callers) this.ring(this.edgeIn, `${c.key}>${e.lane}`).add(sec, [c.n])
    }
    for (const c of snap.callers)
      this.ring(this.callers, c.key).add(sec, [c.req, 0, 0, 0, 0, c.error])
    for (const d of snap.down) {
      const r = this.ring(this.downs, d.id)
      r.add(sec, [d.req, 0, 0, 0, 0, d.error])
      r.p95 = d.p95
      this.downLabels.set(d.id, d.label)
    }
  }

  applyFrame(f: TrafficFrame): void {
    const sec = Math.floor(new Date(f.at).getTime() / 1000)
    if (sec > this.nowSec) this.nowSec = sec
    this.frameNo = f.frame
    this.lastFrameAt = Date.now()
    this.sockets = f.sockets
    if (f.journal_seq != null) this.journalSeq = f.journal_seq
    this.instance = f.instance || this.instance
    for (const [key, v] of Object.entries(f.entities)) {
      const r = this.ring(this.entities, key)
      r.add(sec, v.slice(0, 6))
      if (v[6]) r.p95 = v[6]
      const m = this.meta.get(key)
      if (m) m.p95 = v[6] ?? m.p95
      if (v[SLOT.error] > 0) this.flashes.set(key, Date.now())
    }
    for (const [key, v] of Object.entries(f.callers))
      this.ring(this.callers, key).add(sec, [v[0], 0, 0, 0, 0, v[1]])
    for (const [key, v] of Object.entries(f.down)) {
      const r = this.ring(this.downs, key)
      r.add(sec, [v[0], 0, 0, 0, 0, v[1]])
      if (v[2]) r.p95 = v[2]
    }
    for (const [key, n] of Object.entries(f.edges_in)) this.ring(this.edgeIn, key).add(sec, [n])
    for (const [key, n] of Object.entries(f.edges_out)) this.ring(this.edgeOut, key).add(sec, [n])
    for (const ev of f.events) {
      const key = `${ev.lane}/${ev.entity}`
      if (ev.kind === 'create' || ev.kind === 'update' || ev.kind === 'delete') {
        this.pulses.set(key, { kind: ev.kind, t: Date.now() })
        const m = this.meta.get(key)
        if (m && ev.record) {
          m.recent_writes = [
            {
              at: f.at,
              action: ev.kind,
              record: ev.record,
              fields: ev.fields ?? [],
              caller: ev.caller,
              via: ev.via ?? 'other'
            },
            ...m.recent_writes
          ].slice(0, 12)
        }
      } else if (ev.kind === 'error') {
        const m = this.meta.get(key)
        if (m)
          m.recent_errors = [
            {
              at: f.at,
              status: ev.status ?? 0,
              code: ev.code ?? null,
              route: ev.route,
              caller: ev.caller,
              record: ev.record ?? null
            },
            ...m.recent_errors
          ].slice(0, 12)
      }
    }
    if (f.events.length) {
      const sorted = f.events.slice().sort((a, b) => b.t - a.t)
      this.events = [...sorted, ...this.events].slice(0, TICKER_CAP)
    }
  }

  entityKeys(): string[] {
    return [...this.entities.keys()]
  }
  entitySum(key: string, win: number): number[] {
    const r = this.entities.get(key)
    return r ? r.sum(this.nowSec, win).map(Math.round) : [0, 0, 0, 0, 0, 0]
  }
  entitySeries(key: string, win: number, points: number): number[] {
    const r = this.entities.get(key)
    return r ? r.series(this.nowSec, win, points) : new Array<number>(points).fill(0)
  }
  entityMeta(key: string): SnapshotEntity | null {
    return this.meta.get(key) ?? null
  }
  entityP95(key: string): number {
    return this.entities.get(key)?.p95 ?? 0
  }
  callerSum(key: string, win: number): [number, number] {
    const s = this.callers.get(key)?.sum(this.nowSec, win) ?? [0, 0, 0, 0, 0, 0]
    return [Math.round(s[0]), Math.round(s[5])]
  }
  callerKeys(): string[] {
    return [...this.callers.keys()]
  }
  downSum(id: string, win: number): [number, number, number] {
    const r = this.downs.get(id)
    const s = r?.sum(this.nowSec, win) ?? [0, 0, 0, 0, 0, 0]
    return [Math.round(s[0]), Math.round(s[5]), r?.p95 ?? 0]
  }
  downIds(): string[] {
    return [...this.downs.keys()]
  }

  edges(win: number, f: Filters): { in: Map<string, number>; out: Map<string, number> } {
    const inn = new Map<string, number>()
    const out = new Map<string, number>()
    for (const [key, r] of this.edgeIn) {
      const [caller, lane] = key.split('>') as [string, Lane]
      if (!f.types.has(lane) || (f.caller && caller !== f.caller)) continue
      const n = r.sum(this.nowSec, win)[0]
      if (n > 0) inn.set(key, n / win)
    }
    for (const [key, r] of this.edgeOut) {
      const lane = key.slice(0, key.indexOf('>')) as Lane
      if (!f.types.has(lane)) continue
      const n = r.sum(this.nowSec, win)[0]
      if (n > 0) out.set(key, n / win)
    }
    return { in: inn, out }
  }

  private filteredSum(key: string, win: number, f: Filters): number[] {
    const s = this.entitySum(key, win)
    const kinds: Kind[] = ['read', 'create', 'update', 'delete', 'error']
    const out = [0, 0, 0, 0, 0, 0]
    for (let k = 1; k <= 5; k++) if (f.kinds.has(kinds[k - 1])) out[k] = s[k]
    out[0] = f.kinds.size === 5 ? s[0] : out[1] + out[2] + out[3] + out[4] + out[5]
    return out
  }

  totals(
    win: number,
    f: Filters
  ): {
    req: number
    read: number
    create: number
    update: number
    delete: number
    error: number
    p95: number
    outbound_req: number
    outbound_error: number
  } {
    const t = [0, 0, 0, 0, 0, 0]
    let p95 = 0
    for (const key of this.entities.keys()) {
      const lane = laneOf(key)
      // lane `other` is never drawn but always counted in totals (R24)
      if (lane !== 'other' && !f.types.has(lane)) continue
      const s = this.filteredSum(key, win, f)
      for (let k = 0; k < 6; k++) t[k] += s[k]
      p95 = Math.max(p95, this.entityP95(key))
    }
    let outbound = 0
    let outboundErr = 0
    for (const id of this.downs.keys()) {
      if (!id.startsWith('ext:')) continue
      const [r, e] = this.downSum(id, win)
      outbound += r
      outboundErr += e
    }
    return {
      req: t[0],
      read: t[1],
      create: t[2],
      update: t[3],
      delete: t[4],
      error: t[5],
      p95,
      outbound_req: outbound,
      outbound_error: outboundErr
    }
  }

  hot(
    win: number,
    f: Filters,
    n: number
  ): Array<{
    key: string
    lane: Lane
    entity: string
    rps: number
    wpm: number
    p95: number
    errPct: number
    series: number[]
  }> {
    const rows: Array<{
      key: string
      lane: Lane
      entity: string
      rps: number
      wpm: number
      p95: number
      errPct: number
      series: number[]
    }> = []
    for (const key of this.entities.keys()) {
      const lane = laneOf(key)
      if (!f.types.has(lane)) continue
      const s = this.filteredSum(key, win, f)
      const total = s[0]
      if (total <= 0) continue
      const w60 = this.entitySum(key, 60)
      rows.push({
        key,
        lane,
        entity: key.slice(key.indexOf('/') + 1),
        rps: total / win,
        wpm: w60[2] + w60[3] + w60[4],
        p95: this.entityP95(key),
        errPct: total ? (100 * s[5]) / total : 0,
        series: this.entitySeries(key, 60, 24)
      })
    }
    return rows.sort((a, b) => b.rps - a.rps).slice(0, n)
  }

  visibleEvents(f: Filters): TrafficEventWire[] {
    return this.events.filter((e) =>
      applyFilters(f, { lane: e.lane, kind: e.kind, caller: e.caller })
    )
  }
}
