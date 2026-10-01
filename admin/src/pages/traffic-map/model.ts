import {
  type Filters,
  type Kind,
  LANE_ORDER,
  type Lane,
  SLOT,
  type SnapshotEntity,
  type TrafficEventWire,
  type TrafficFrame,
  type TrafficSnapshot,
  type TrafficSource
} from './types'

export const RING = 900
const SLOTS = 6
export const TICKER_CAP = 80
/** Server tap with exact per entity × caller counts (#1095). */
export const ENTITY_CALLERS_TAP = 'entity-callers'
/** #1154: per-workspace entity / caller / edge counts (the whole map scoped to a workspace). */
export const WORKSPACE_SCOPE_TAP = 'workspace-scope'
/** #1163: the app (x-nivaro-app) each caller uses most. */
export const CALLER_APPS_TAP = 'caller-apps'
/** #1100: events kept for rewinding the ticker (newest first). */
const EVENT_LOG_CAP = 1500

export function defaultFilters(): Filters {
  return {
    // Every lane shows by default, System and Sockets included (`other` has no chip).
    types: new Set<Lane>(LANE_ORDER.filter((l) => l !== 'other')),
    kinds: new Set<Kind>(['read', 'create', 'update', 'delete', 'error']),
    caller: '',
    win: 60
  }
}
/** The callers the filter narrows to: one caller, a group (#1133 caller kind), or null = all. */
export function callerSet(f: Filters): Set<string> | null {
  return f.caller ? new Set([f.caller]) : f.callers?.length ? new Set(f.callers) : null
}
export function applyFilters(
  f: Filters,
  e: { lane: Lane; kind?: Kind; caller?: string; extra?: Record<string, unknown> }
): boolean {
  if (!f.types.has(e.lane)) return false
  if (e.kind && !f.kinds.has(e.kind)) return false
  const cs = callerSet(f)
  if (cs && e.caller && !cs.has(e.caller)) return false
  // #1154: an event the server could not place in a workspace never shows under one
  if (f.workspace && e.extra?.ws !== f.workspace) return false
  return true
}
export function laneOf(key: string): Lane {
  return key.slice(0, key.indexOf('/')) as Lane
}

class Ring {
  counts: Float64Array
  p95 = 0
  last: number
  touched: number
  constructor(
    sec: number,
    private slots = SLOTS
  ) {
    this.last = sec
    this.touched = sec
    this.counts = new Float64Array(RING * slots)
  }
  catchUp(sec: number): void {
    if (sec <= this.last) return
    const gap = Math.min(sec - this.last, RING)
    for (let i = 1; i <= gap; i++) {
      const idx = ((this.last + i) % RING) * this.slots
      this.counts.fill(0, idx, idx + this.slots)
    }
    this.last = sec
  }
  add(sec: number, slots: number[]): void {
    if (sec <= this.last - RING) return // older than the ring holds
    this.catchUp(sec)
    if (sec > this.touched) this.touched = sec
    const base = (sec % RING) * this.slots
    for (let k = 0; k < this.slots && k < slots.length; k++) this.counts[base + k] += slots[k]
  }
  /** Frames carry complete per-second totals, so applying one SETS its second (idempotent). */
  set(sec: number, slots: number[]): void {
    if (sec <= this.last - RING) return
    this.catchUp(sec)
    if (sec > this.touched) this.touched = sec
    const base = (sec % RING) * this.slots
    for (let k = 0; k < this.slots; k++) this.counts[base + k] = slots[k] ?? 0
  }
  sum(sec: number, win: number): number[] {
    this.catchUp(sec)
    const out = new Array<number>(this.slots).fill(0)
    for (let i = 0; i < win; i++) {
      // a second the ring no longer holds (its slot now carries a newer one) reads as zero
      if (sec - i <= this.last - RING) break
      const base = ((((sec - i) % RING) + RING) % RING) * this.slots
      for (let k = 0; k < this.slots; k++) out[k] += this.counts[base + k]
    }
    return out
  }
  series(sec: number, win: number, points: number): number[] {
    this.catchUp(sec)
    const per = win / points
    const out = new Array<number>(points).fill(0)
    for (let i = 0; i < win; i++) {
      const s = sec - win + 1 + i
      if (s <= this.last - RING) continue
      const base = (((s % RING) + RING) % RING) * this.slots
      out[Math.min(points - 1, Math.floor(i / per))] += this.counts[base + SLOT.req]
    }
    return out
  }
}

const FRAME_BUFFER = 5
const FRAME_EXT_LOG = 30
const PRUNE_EVERY = 60

type Totals = {
  req: number
  read: number
  create: number
  update: number
  delete: number
  error: number
  p50: number
  p95: number
  outbound_req: number
  outbound_error: number
}

export class TrafficModel {
  private entities = new Map<string, Ring>()
  private callers = new Map<string, Ring>()
  private downs = new Map<string, Ring>()
  private meta = new Map<string, SnapshotEntity>()
  private edgeIn = new Map<string, Ring>() // 1 slot: count
  private edgeOut = new Map<string, Ring>()
  private nowSec = Math.floor(Date.now() / 1000)
  private snapSec = Number.NEGATIVE_INFINITY
  private recent: Array<{ sec: number; f: TrafficFrame }> = []
  private seenFrames: string[] = []
  private framesSince = 0
  private frameCount = 0
  /** caller -> entity key -> last frame second a live event from that caller touched it. */
  private callerSeen = new Map<string, Map<string, number>>()
  /** #1095: entity key -> caller -> exact per-second counts (the entity-callers tap). */
  private entityCallers = new Map<string, Map<string, Ring>>()
  /** `${entityKey}\u0000${caller}` -> newest p95. */
  private callerP95 = new Map<string, number>()
  /** The server sends exact entity × caller counts (else the caller filter is approximate). */
  exactCallers = false
  snapshotTotals: TrafficSnapshot['totals'] | null = null
  snapshotWindow = 60
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
  /** Snapshot down-row kind per id ('db', 'partner', 'channel', 'ai', 'webhook'…). */
  downKinds = new Map<string, string>()
  /** Server tap figures of the newest applied frame, by tap id ({} when it carried none). */
  frameExt: Record<string, unknown> = {}
  /** The newest FRAME_EXT_LOG frames' tap figures, oldest first; `seq` counts applied frames,
   *  so a reader that renders less often than frames arrive can catch up on what it missed. */
  frameExtLog: Array<{ seq: number; sec: number; ext: Record<string, unknown> }> = []
  private frameSeq = 0
  /** Server tap figures of the last snapshot, by tap id. Per-entity ones: entityMeta(k).ext. */
  snapshotExt: Record<string, unknown> = {}
  /** Non-request sources of the last snapshot. */
  sources: TrafficSource[] = []
  /** #1154: workspace -> entity key / caller / `caller>lane` -> per-second counts. */
  private wsEntities = new Map<string, Map<string, Ring>>()
  private wsCallers = new Map<string, Map<string, Ring>>()
  private wsEdgeIn = new Map<string, Map<string, Ring>>()
  /** #1163: caller -> the app it uses most (x-nivaro-app). */
  callerApps = new Map<string, string>()
  /** #1100: the newest EVENT_LOG_CAP events (newest first), for rewinding the ticker. */
  eventLog: TrafficEventWire[] = []
  /** #1100: the second being viewed while rewound; null = live (the newest second). */
  private viewSec: number | null = null

  /** The newest second the model holds (live). */
  get now(): number {
    return this.nowSec
  }
  /** The second every read is anchored on: the live second, or the rewound one (#1100). */
  get at(): number {
    if (this.viewSec === null) return this.nowSec
    return Math.min(this.nowSec, Math.max(this.nowSec - RING + 60, this.viewSec))
  }
  /** True while a past second is being viewed. */
  get rewound(): boolean {
    return this.viewSec !== null && this.at < this.nowSec
  }
  /** #1100: view the map as of `sec` (null = live). Clamped to what the ring holds. */
  setView(sec: number | null): void {
    this.viewSec = sec === null || !Number.isFinite(sec) ? null : Math.floor(sec)
  }
  /** The seconds a window of `win` can be rewound over: [oldest, newest]. */
  rewindRange(win: number): { min: number; max: number } {
    return { min: this.nowSec - RING + Math.max(60, win), max: this.nowSec }
  }

  private nested(outer: Map<string, Map<string, Ring>>, a: string, b: string, slots = SLOTS) {
    let inner = outer.get(a)
    if (!inner) {
      inner = new Map()
      outer.set(a, inner)
    }
    return this.ring(inner, b, slots)
  }

  private ring(map: Map<string, Ring>, key: string, slots = SLOTS): Ring {
    let r = map.get(key)
    if (!r) {
      r = new Ring(this.nowSec, slots)
      map.set(key, r)
    }
    return r
  }

  /** Spread `total` (per slot) evenly over each of the window's seconds. */
  private spread(r: Ring, sec: number, win: number, total: number[]): void {
    const per = total.map((n) => n / win)
    for (let i = 0; i < win; i++) r.add(sec - win + 1 + i, per)
  }

  /** Replace every ring from the snapshot (reconnect / visibility return / window change). */
  applySnapshot(snap: TrafficSnapshot): void {
    const sec = Math.floor(new Date(snap.at).getTime() / 1000)
    this.nowSec = sec
    this.snapSec = sec
    this.entities.clear()
    this.callers.clear()
    this.downs.clear()
    this.meta.clear()
    this.edgeIn.clear()
    this.edgeOut.clear()
    this.callerSeen.clear()
    this.entityCallers.clear()
    this.callerP95.clear()
    this.wsEntities.clear()
    this.wsCallers.clear()
    this.wsEdgeIn.clear()
    this.callerApps = new Map(
      Object.entries((snap.ext?.[CALLER_APPS_TAP] as Record<string, string> | undefined) ?? {})
    )
    this.exactCallers = snap.entities.some((e) => e.ext?.[ENTITY_CALLERS_TAP] !== undefined)
    this.framesSince = 0
    this.snapshotTotals = snap.totals
    this.snapshotWindow = snap.window_s
    this.instance = snap.instance
    this.nodeScope = snap.node_scope
    this.sockets = snap.sockets.count
    this.journalSeq = snap.journal_seq
    this.frameNo = snap.frame
    this.snapshotExt = snap.ext ?? {}
    this.sources = snap.sources ?? []
    const win = snap.window_s
    for (const e of snap.entities) {
      const r = this.ring(this.entities, e.key)
      r.p95 = e.p95
      // copy: live frames mutate meta, and the caller's (react-query cached) snapshot must stay intact
      this.meta.set(e.key, {
        ...e,
        recent_writes: [...e.recent_writes],
        recent_errors: [...e.recent_errors]
      })
      // every kind total is spread by the series' shape (evenly when the series is empty),
      // so a write-only entity with req === 0 still seeds its create/update/delete/error counts
      const sTot = e.series.reduce((a, b) => a + b, 0)
      const len = e.series.length || 1
      const totals = [e.req, e.read, e.create, e.update, e.delete, e.error]
      const byCaller = Object.entries(
        (e.ext?.[ENTITY_CALLERS_TAP] as Record<string, number[]> | undefined) ?? {}
      )
      const byWs = Object.entries(
        (e.ext?.[WORKSPACE_SCOPE_TAP] as Record<string, number[]> | undefined) ?? {}
      )
      for (let i = 0; i < win; i++) {
        const w =
          sTot > 0
            ? e.series[Math.min(len - 1, Math.floor((i * len) / win))] / ((win / len) * sTot)
            : 1 / win
        r.add(
          sec - win + 1 + i,
          totals.map((n) => n * w)
        )
        // each caller's window total takes the entity's shape (frames make it exact from here)
        for (const [caller, v] of byCaller)
          this.callerRing(e.key, caller).add(
            sec - win + 1 + i,
            v.slice(0, 6).map((n) => n * w)
          )
        for (const [ws, v] of byWs)
          this.nested(this.wsEntities, ws, e.key).add(
            sec - win + 1 + i,
            v.slice(0, 6).map((n) => n * w)
          )
      }
      for (const [caller, v] of byCaller)
        if (v[6]) this.callerP95.set(`${e.key}\u0000${caller}`, v[6])
      for (const [d, n] of Object.entries(e.down))
        this.spread(this.ring(this.edgeOut, `${e.lane}>${d}`, 1), sec, win, [n])
      for (const c of e.callers)
        this.spread(this.ring(this.edgeIn, `${c.key}>${e.lane}`, 1), sec, win, [c.n])
    }
    for (const c of snap.callers)
      this.spread(this.ring(this.callers, c.key), sec, win, [c.req, 0, 0, 0, 0, c.error])
    const ws = snap.ext?.[WORKSPACE_SCOPE_TAP] as
      | { c?: Record<string, Record<string, number[]>>; i?: Record<string, Record<string, number>> }
      | undefined
    for (const [w, byCaller] of Object.entries(ws?.c ?? {}))
      for (const [c, v] of Object.entries(byCaller))
        this.spread(this.nested(this.wsCallers, w, c), sec, win, [v[0], 0, 0, 0, 0, v[1] ?? 0])
    for (const [w, byEdge] of Object.entries(ws?.i ?? {}))
      for (const [k, n] of Object.entries(byEdge))
        this.spread(this.nested(this.wsEdgeIn, w, k, 1), sec, win, [n])
    for (const d of snap.down) {
      const r = this.ring(this.downs, d.id)
      this.spread(r, sec, win, [d.req, 0, 0, 0, 0, d.error])
      r.p95 = d.p95
      this.downLabels.set(d.id, d.label)
      this.downKinds.set(d.id, d.kind)
    }
    // frames that arrived before the snapshot but are newer than it survive the replacement
    for (const { sec: fs, f } of this.recent) if (fs > sec) this.applyFrameData(f, fs)
  }

  private applyFrameData(f: TrafficFrame, sec: number): void {
    if (sec > this.nowSec) this.nowSec = sec
    for (const [key, v] of Object.entries(f.entities)) {
      const r = this.ring(this.entities, key)
      r.set(sec, v.slice(0, 6))
      if (v[6]) {
        r.p95 = v[6]
        const m = this.meta.get(key)
        if (m) m.p95 = v[6]
      }
    }
    for (const [key, v] of Object.entries(f.callers))
      this.ring(this.callers, key).set(sec, [v[0], 0, 0, 0, 0, v[1]])
    for (const [key, v] of Object.entries(f.down)) {
      const r = this.ring(this.downs, key)
      r.set(sec, [v[0], 0, 0, 0, 0, v[1]])
      if (v[2]) r.p95 = v[2]
    }
    for (const [key, label] of Object.entries(f.down_labels ?? {})) this.downLabels.set(key, label)
    const ec = f.ext?.[ENTITY_CALLERS_TAP] as Record<string, Record<string, number[]>> | undefined
    if (ec) {
      this.exactCallers = true
      for (const [key, byCaller] of Object.entries(ec))
        for (const [caller, v] of Object.entries(byCaller)) {
          this.callerRing(key, caller).set(sec, v.slice(0, 6))
          if (v[6]) this.callerP95.set(`${key}\u0000${caller}`, v[6])
        }
    }
    const ws = f.ext?.[WORKSPACE_SCOPE_TAP] as
      | {
          e?: Record<string, Record<string, number[]>>
          c?: Record<string, Record<string, number[]>>
          i?: Record<string, Record<string, number>>
        }
      | undefined
    if (ws) {
      for (const [w, byKey] of Object.entries(ws.e ?? {}))
        for (const [k, v] of Object.entries(byKey))
          this.nested(this.wsEntities, w, k).set(sec, v.slice(0, 6))
      for (const [w, byCaller] of Object.entries(ws.c ?? {}))
        for (const [c, v] of Object.entries(byCaller))
          this.nested(this.wsCallers, w, c).set(sec, [v[0], 0, 0, 0, 0, v[1] ?? 0])
      for (const [w, byEdge] of Object.entries(ws.i ?? {}))
        for (const [k, n] of Object.entries(byEdge))
          this.nested(this.wsEdgeIn, w, k, 1).set(sec, [n])
    }
    const apps = f.ext?.[CALLER_APPS_TAP] as Record<string, string> | undefined
    if (apps) for (const [c, a] of Object.entries(apps)) this.callerApps.set(c, a)
    for (const [key, n] of Object.entries(f.edges_in)) this.ring(this.edgeIn, key, 1).set(sec, [n])
    for (const [key, n] of Object.entries(f.edges_out))
      this.ring(this.edgeOut, key, 1).set(sec, [n])
  }

  applyFrame(f: TrafficFrame): void {
    const sec = Math.floor(new Date(f.at).getTime() / 1000)
    if (sec < this.snapSec) return // the snapshot already covers that second
    const id = `${sec}|${f.frame}`
    if (this.seenFrames.includes(id)) return // duplicate delivery
    this.seenFrames.push(id)
    if (this.seenFrames.length > 20) this.seenFrames.shift()
    this.recent.push({ sec, f })
    if (this.recent.length > FRAME_BUFFER) this.recent.shift()
    this.framesSince++
    this.frameNo = f.frame
    this.lastFrameAt = Date.now()
    this.sockets = f.sockets
    if (f.journal_seq != null) this.journalSeq = f.journal_seq
    this.instance = f.instance || this.instance
    this.frameExt = f.ext ?? {}
    this.frameSeq++
    if (f.ext) {
      this.frameExtLog.push({ seq: this.frameSeq, sec, ext: f.ext })
      if (this.frameExtLog.length > FRAME_EXT_LOG) this.frameExtLog.shift()
    }
    this.applyFrameData(f, sec)
    for (const [key, v] of Object.entries(f.entities))
      if (v[SLOT.error] > 0) this.flashes.set(key, Date.now())
    for (const ev of f.events) {
      const key = `${ev.lane}/${ev.entity}`
      let seen = this.callerSeen.get(ev.caller)
      if (!seen) {
        seen = new Map()
        this.callerSeen.set(ev.caller, seen)
      }
      seen.set(key, sec)
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
      this.eventLog = [...sorted, ...this.eventLog].slice(0, EVENT_LOG_CAP)
    }
    if (++this.frameCount % PRUNE_EVERY === 0) this.prune()
  }

  /** Drop everything idle for a full ring length so a long session cannot grow without bound. */
  private prune(): void {
    const cutoff = this.nowSec - RING
    for (const map of [this.entities, this.callers, this.downs, this.edgeIn, this.edgeOut])
      for (const [k, r] of map) if (r.touched <= cutoff) map.delete(k)
    for (const k of [...this.meta.keys()]) if (!this.entities.has(k)) this.meta.delete(k)
    const nowMs = Date.now()
    for (const [k, v] of this.pulses) if (nowMs - v.t >= RING * 1000) this.pulses.delete(k)
    for (const [k, t] of this.flashes) if (nowMs - t >= RING * 1000) this.flashes.delete(k)
    for (const [c, seen] of this.callerSeen) {
      for (const [k, s] of seen) if (s <= cutoff) seen.delete(k)
      if (!seen.size) this.callerSeen.delete(c)
    }
    for (const outer of [this.wsEntities, this.wsCallers, this.wsEdgeIn])
      for (const [w, inner] of outer) {
        for (const [k, r] of inner) if (r.touched <= cutoff) inner.delete(k)
        if (!inner.size) outer.delete(w)
      }
    const oldest = cutoff * 1000
    if (this.eventLog.length && this.eventLog[this.eventLog.length - 1].t < oldest)
      this.eventLog = this.eventLog.filter((e) => e.t >= oldest)
    for (const [k, byCaller] of this.entityCallers) {
      for (const [c, r] of byCaller)
        if (r.touched <= cutoff) {
          byCaller.delete(c)
          this.callerP95.delete(`${k}\u0000${c}`)
        }
      if (!byCaller.size) this.entityCallers.delete(k)
    }
  }

  private callerRing(key: string, caller: string): Ring {
    let byCaller = this.entityCallers.get(key)
    if (!byCaller) {
      byCaller = new Map()
      this.entityCallers.set(key, byCaller)
    }
    return this.ring(byCaller, caller)
  }

  /** #1095: exact [req, read, create, update, delete, error] of one caller on one entity. */
  entityCallerSum(key: string, caller: string, win: number): number[] {
    const r = this.entityCallers.get(key)?.get(caller)
    return r ? r.sum(this.at, win).map(Math.round) : [0, 0, 0, 0, 0, 0]
  }
  entityCallerSeries(key: string, caller: string, win: number, points: number): number[] {
    const r = this.entityCallers.get(key)?.get(caller)
    return r ? r.series(this.at, win, points) : new Array<number>(points).fill(0)
  }
  entityCallerP95(key: string, caller: string): number {
    return this.callerP95.get(`${key}\u0000${caller}`) ?? 0
  }
  /** Callers with traffic on the entity in the window, busiest first (exact data only). */
  entityCallerKeys(key: string, win: number): Array<{ key: string; n: number }> {
    const byCaller = this.entityCallers.get(key)
    if (!byCaller) return []
    const out: Array<{ key: string; n: number }> = []
    for (const [c, r] of byCaller) {
      const s = r.sum(this.at, win)
      const n = s[0] + s[2] + s[3] + s[4]
      if (n > 0.5) out.push({ key: c, n: Math.round(n) })
    }
    return out.sort((a, b) => b.n - a.n)
  }

  entityKeys(): string[] {
    return [...this.entities.keys()]
  }
  entitySum(key: string, win: number): number[] {
    const r = this.entities.get(key)
    return r ? r.sum(this.at, win).map(Math.round) : [0, 0, 0, 0, 0, 0]
  }
  entitySeries(key: string, win: number, points: number): number[] {
    const r = this.entities.get(key)
    return r ? r.series(this.at, win, points) : new Array<number>(points).fill(0)
  }
  entityMeta(key: string): SnapshotEntity | null {
    return this.meta.get(key) ?? null
  }
  entityP95(key: string): number {
    return this.entities.get(key)?.p95 ?? 0
  }
  callerSum(key: string, win: number): [number, number] {
    const s = this.callers.get(key)?.sum(this.at, win) ?? [0, 0, 0, 0, 0, 0]
    return [Math.round(s[0]), Math.round(s[5])]
  }
  callerKeys(): string[] {
    return [...this.callers.keys()]
  }
  downSum(id: string, win: number): [number, number, number] {
    const r = this.downs.get(id)
    const s = r?.sum(this.at, win) ?? [0, 0, 0, 0, 0, 0]
    return [Math.round(s[0]), Math.round(s[5]), r?.p95 ?? 0]
  }
  downIds(): string[] {
    return [...this.downs.keys()]
  }

  /** #1154: one workspace's [req, read, create, update, delete, error] on an entity. */
  workspaceEntitySum(ws: string, key: string, win: number): number[] {
    const r = this.wsEntities.get(ws)?.get(key)
    return r ? r.sum(this.at, win).map(Math.round) : [0, 0, 0, 0, 0, 0]
  }
  /** #1154: workspaces the model holds per-workspace counts for. */
  workspaceIds(): string[] {
    return [...this.wsEntities.keys()]
  }

  edges(win: number, f: Filters): { in: Map<string, number>; out: Map<string, number> } {
    const inn = new Map<string, number>()
    const out = new Map<string, number>()
    const cs = callerSet(f)
    const wsEdges = f.workspace ? this.wsEdgeIn.get(f.workspace) : null
    for (const [key, r] of f.workspace ? (wsEdges ?? new Map<string, Ring>()) : this.edgeIn) {
      const cut = key.lastIndexOf('>')
      const caller = key.slice(0, cut)
      const lane = key.slice(cut + 1) as Lane
      if (!f.types.has(lane) || (cs && !cs.has(caller))) continue
      const n = r.sum(this.at, win)[0]
      if (n > 0) inn.set(key, n / win)
    }
    // #1154: a lane's downstream edges keep the workspace's share of that lane (approximate:
    // the downstream calls themselves carry no workspace)
    const laneShare = f.workspace ? this.workspaceLaneShare(f.workspace, win) : null
    for (const [key, r] of this.edgeOut) {
      const lane = key.slice(0, key.indexOf('>')) as Lane
      if (!f.types.has(lane)) continue
      const share = laneShare ? (laneShare.get(lane) ?? 0) : 1
      const n = r.sum(this.at, win)[0] * share
      if (n > 0) out.set(key, n / win)
    }
    return { in: inn, out }
  }

  private workspaceLaneShare(ws: string, win: number): Map<Lane, number> {
    const all = new Map<Lane, number>()
    const mine = new Map<Lane, number>()
    for (const key of this.entities.keys()) {
      const lane = laneOf(key)
      all.set(lane, (all.get(lane) ?? 0) + this.entitySum(key, win)[0])
      mine.set(lane, (mine.get(lane) ?? 0) + this.workspaceEntitySum(ws, key, win)[0])
    }
    const out = new Map<Lane, number>()
    for (const [lane, n] of all) out.set(lane, n > 0 ? Math.min(1, (mine.get(lane) ?? 0) / n) : 0)
    return out
  }

  /** Counts behind every filtered figure: a workspace's, the filtered callers', or the entity's. */
  private baseSum(key: string, win: number, f: Filters): number[] {
    if (f.workspace) return this.workspaceEntitySum(f.workspace, key, win)
    const cs = callerSet(f)
    if (cs && this.exactCallers) {
      const out = [0, 0, 0, 0, 0, 0]
      for (const c of cs) {
        const s = this.entityCallerSum(key, c, win)
        for (let k = 0; k < 6; k++) out[k] += s[k]
      }
      return out
    }
    return this.entitySum(key, win)
  }
  private baseSeries(key: string, win: number, points: number, f: Filters): number[] {
    if (f.workspace) {
      const r = this.wsEntities.get(f.workspace)?.get(key)
      return r ? r.series(this.at, win, points) : new Array<number>(points).fill(0)
    }
    const cs = callerSet(f)
    if (cs && this.exactCallers) {
      const out = new Array<number>(points).fill(0)
      for (const c of cs) {
        const s = this.entityCallerSeries(key, c, win, points)
        for (let i = 0; i < points; i++) out[i] += s[i] ?? 0
      }
      return out
    }
    return this.entitySeries(key, win, points)
  }

  private filteredSum(key: string, win: number, f: Filters): number[] {
    // #1095: with a caller filter and exact data, only those callers' share of the entity
    // #1154: with a workspace, only that workspace's share
    const s = this.baseSum(key, win, f)
    const kinds: Kind[] = ['read', 'create', 'update', 'delete', 'error']
    const out = [0, 0, 0, 0, 0, 0]
    for (let k = 1; k <= 5; k++) if (f.kinds.has(kinds[k - 1])) out[k] = s[k]
    // with a kind deselected `req` is a proxy: the sum of the selected kind slots
    out[0] = f.kinds.size === 5 ? s[0] : out[1] + out[2] + out[3] + out[4] + out[5]
    return out
  }

  /**
   * Entity passes the caller filter? Exact when the server sends entity × caller counts (#1095);
   * otherwise APPROXIMATE: the entity's snapshot top-callers include the caller, or a live event
   * from that caller touched it inside the window.
   */
  private callerTouches(caller: string, key: string, win: number): boolean {
    if (this.exactCallers) return this.entityCallerSum(key, caller, win).some((n) => n > 0)
    if (this.meta.get(key)?.callers.some((c) => c.key === caller)) return true
    const s = this.callerSeen.get(caller)?.get(key)
    return s !== undefined && s > this.at - win
  }
  private callersTouch(cs: Set<string> | null, key: string, win: number): boolean {
    if (!cs) return true
    for (const c of cs) if (this.callerTouches(c, key, win)) return true
    return false
  }
  private singleCaller(f: Filters): string | null {
    const cs = callerSet(f)
    return cs && cs.size === 1 ? [...cs][0] : null
  }

  /** #1129: entity keys a caller (or source) reached in the window, busiest first. */
  callerEntities(caller: string, win: number): string[] {
    const out: Array<[string, number]> = []
    for (const key of this.entities.keys()) {
      if (!this.callerTouches(caller, key, win)) continue
      const n = this.exactCallers ? this.entityCallerSum(key, caller, win)[0] : 1
      out.push([key, n])
    }
    return out.sort((a, b) => b[1] - a[1]).map(([k]) => k)
  }

  /**
   * Window totals. With a caller filter: those callers' exact share of each entity (#1095), or —
   * on a server without entity × caller counts — req/error from the callers' rings. With a
   * workspace (#1154): that workspace's share. p50/p95: the snapshot's real totals while no frame
   * has moved past it (same window, unfiltered, live); afterwards a request-weighted mean of the
   * entities' latest p50/p95 (a live-only approximation).
   */
  totals(win: number, f: Filters): Totals {
    const t = [0, 0, 0, 0, 0, 0]
    let w = 0
    let p50 = 0
    let p95 = 0
    const cs = callerSet(f)
    const one = this.singleCaller(f)
    for (const key of this.entities.keys()) {
      const lane = laneOf(key)
      // lane `other` is never drawn but always counted in totals (R24)
      if (lane !== 'other' && !f.types.has(lane)) continue
      if (cs && !this.callersTouch(cs, key, win)) continue
      const s = this.filteredSum(key, win, f)
      for (let k = 0; k < 6; k++) t[k] += s[k]
      w += s[0]
      p50 += s[0] * (this.meta.get(key)?.p50 ?? 0)
      p95 +=
        s[0] * ((one && this.exactCallers && this.entityCallerP95(key, one)) || this.entityP95(key))
    }
    // without exact entity × caller data, req/error come from the callers' own rings
    if (cs && !this.exactCallers && !f.workspace) {
      t[0] = 0
      t[5] = 0
      for (const c of cs) {
        const [r, e] = this.callerSum(c, win)
        t[0] += r
        t[5] += e
      }
    }
    const snap = this.snapshotTotals
    const useSnap =
      snap &&
      this.framesSince === 0 &&
      win === this.snapshotWindow &&
      !cs &&
      !f.workspace &&
      !this.rewound
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
      p50: useSnap ? snap.p50 : w ? p50 / w : 0,
      p95: useSnap ? snap.p95 : w ? p95 / w : 0,
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
    const cs = callerSet(f)
    const one = this.singleCaller(f)
    for (const key of this.entities.keys()) {
      const lane = laneOf(key)
      if (!f.types.has(lane)) continue
      if (cs && !this.callersTouch(cs, key, win)) continue
      const s = this.filteredSum(key, win, f)
      const total = s[0]
      if (total <= 0) continue
      const w60 = this.baseSum(key, 60, f)
      rows.push({
        key,
        lane,
        entity: key.slice(key.indexOf('/') + 1),
        rps: total / win,
        wpm: w60[2] + w60[3] + w60[4],
        p95: (one && this.exactCallers && this.entityCallerP95(key, one)) || this.entityP95(key),
        errPct: total ? (100 * s[5]) / total : 0,
        series: this.baseSeries(key, 60, 24, f)
      })
    }
    return rows.sort((a, b) => b.rps - a.rps).slice(0, n)
  }

  /** Ticker events: live = the newest TICKER_CAP; rewound (#1100) = the ones up to that second. */
  visibleEvents(f: Filters): TrafficEventWire[] {
    const pass = (e: TrafficEventWire) =>
      applyFilters(f, { lane: e.lane, kind: e.kind, caller: e.caller, extra: e.extra })
    if (!this.rewound) return this.events.filter(pass)
    const until = (this.at + 1) * 1000
    const out: TrafficEventWire[] = []
    for (const e of this.eventLog) {
      if (e.t >= until || !pass(e)) continue
      out.push(e)
      if (out.length >= TICKER_CAP) break
    }
    return out
  }
}
