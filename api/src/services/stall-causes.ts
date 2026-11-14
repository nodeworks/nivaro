// api/src/services/stall-causes.ts
/**
 * What froze the server: the requests running on a process while its event loop stalled
 * (production 2026-11-13 — "Server freezes" fired and the cause, GET resolve-paths on Unit Types
 * taking 40–63 s, took manual digging through the logs).
 *
 * Capture (every API process): the runtime monitor's 500 ms drift sampler hands each lag sample
 * to ops-signals, which hands it here. A sample of CAPTURE_MS or more is a stall that just ended:
 * window ≈ [now − lag, now]. Its candidates are the requests still in flight (traffic-inflight)
 * plus any of 500 ms+ that finished in the last few seconds; each is scored by how much of the
 * stall its own run covers (requests that arrive during a stall are not even read until it ends,
 * so they score ~0), whether it was running code rather than waiting on the database when the
 * stall began, and how recently its last statement answered before it (a request that loads rows
 * and then works through them synchronously answers its last statement right before the stall).
 * The top TOP_CULPRITS are kept with route TEMPLATE, collection, person id, screen pattern and
 * request id — never a query string, body or SQL text. Culprits still running are updated with
 * their final duration when they finish.
 *
 * The records ride the process's ops-signals summary in Redis (30 s beat, plus a publish a few
 * seconds after each stall), so the `event_loop` monitor — which runs on ONE process — names the
 * cause from the process that stalled. Names (people, collections) are resolved when the alert
 * is built, never stored here.
 *
 * Off in cloud mode, like the in-flight list and the signals: one process serves many tenants
 * and a culprit from one tenant must never be named to another.
 */
import {
  type InflightStallRaw,
  inflightStallCandidates,
  setInflightEndListener
} from './traffic-inflight.js'

/** A lag sample at least this long is captured as a stall. */
export const CAPTURE_MS = 500
export const TOP_CULPRITS = 5
/** Stall records are kept (and published) this long. */
export const STALL_KEEP_MS = 10 * 60_000
const MAX_STALLS = 30
/** Finished requests stay candidates this long (the sampler runs right after a stall ends). */
const FINISHED_KEEP_MS = 15_000
const FINISHED_CAP = 200
/** A culprit covering at least this share of the stall is "most likely". */
export const LIKELY_SHARE = 0.8

export interface StallCulprit {
  /** Request id (= trace id; joins the API log row and the slow-trace ring). */
  id: string
  method: string
  /** Route template, e.g. `/api/items/:collection/resolve-paths`. */
  route: string
  collection: string | null
  user_id: string | null
  app: string | null
  /** Screen pattern the client sent (`/collections/deployment_part_types`), never ids. */
  page: string | null
  /** Epoch ms. */
  started_at: number
  /** Whole duration when finished, else the age at the last update. */
  ms: number
  running: boolean
  /** Share of the stall the request's own run covers, 0–1. */
  share: number
  /** Waiting on a database statement when the stall began (true), running code (false), unknown (null). */
  waiting_sql: boolean | null
  score: number
}

export interface StallRecord {
  /** Epoch ms the stall ended (the sample that saw it). */
  at: number
  /** How long the loop was blocked. */
  ms: number
  culprits: StallCulprit[]
}

// ─── Pure scoring ─────────────────────────────────────────────────────────────

/**
 * Rank the requests that overlapped a stall [stallStart, stallEnd] (pure). Requests with no
 * overlap are dropped; the top `top` come back best first.
 */
export function rankCulprits(
  cands: InflightStallRaw[],
  stallStart: number,
  stallEnd: number,
  top = TOP_CULPRITS
): StallCulprit[] {
  const len = Math.max(1, stallEnd - stallStart)
  const seen = new Set<string>()
  const out: StallCulprit[] = []
  for (const c of cands) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    const end = c.endedAt ?? stallEnd
    const overlap = Math.min(end, stallEnd) - Math.max(c.startedAt, stallStart)
    if (overlap <= 0) continue
    const share = Math.min(1, overlap / len)
    const waiting = c.endedAt == null ? c.sqlSince != null && c.sqlSince <= stallStart : null
    const justActive =
      c.lastSettle != null && c.lastSettle <= stallStart + 50 && stallStart - c.lastSettle <= 2000
    const ms = Math.max(0, (c.endedAt ?? stallEnd) - c.startedAt)
    const score =
      share * 100 + (waiting === false ? 20 : 0) + (justActive ? 15 : 0) + Math.min(10, ms / 10_000)
    out.push({
      id: c.id,
      method: c.method,
      route: c.route,
      collection: c.collection,
      user_id: c.userId,
      app: c.app,
      page: c.page,
      started_at: c.startedAt,
      ms,
      running: c.endedAt == null,
      share: Math.round(share * 100) / 100,
      waiting_sql: waiting,
      score: Math.round(score * 10) / 10
    })
  }
  return out.sort((a, b) => b.score - a.score || b.ms - a.ms).slice(0, top)
}

// ─── One process's book ───────────────────────────────────────────────────────

/** A class so tests can drive one "process" with fake candidates and a fake clock. */
export class StallBook {
  private stalls: StallRecord[] = []
  private finished: InflightStallRaw[] = []

  constructor(private readonly inflight: () => InflightStallRaw[]) {}

  /** A finished request of 500 ms+ (traffic-inflight's end listener). */
  noteEnded(raw: InflightStallRaw): void {
    const at = raw.endedAt ?? Date.now()
    this.finished.push(raw)
    if (this.finished.length > FINISHED_CAP)
      this.finished.splice(0, this.finished.length - FINISHED_CAP)
    // A culprit that was still running when its stall was captured: its final duration.
    for (const s of this.stalls)
      for (const c of s.culprits)
        if (c.running && c.id === raw.id) {
          c.running = false
          c.ms = Math.max(c.ms, at - c.started_at)
        }
  }

  /** A lag sample. Returns the stall record when one was captured. */
  noteLag(lag: number, now: number = Date.now()): StallRecord | null {
    if (!Number.isFinite(lag) || lag < CAPTURE_MS) return null
    const stallStart = now - lag
    const recentDone = this.finished.filter((f) => (f.endedAt ?? 0) >= now - FINISHED_KEEP_MS)
    this.finished = recentDone
    let cands: InflightStallRaw[] = []
    try {
      cands = this.inflight()
    } catch {
      cands = []
    }
    const rec: StallRecord = {
      at: now,
      ms: Math.round(lag),
      culprits: rankCulprits([...cands, ...recentDone], stallStart, now)
    }
    this.stalls.push(rec)
    this.prune(now)
    return rec
  }

  private prune(now: number): void {
    this.stalls = this.stalls.filter((s) => now - s.at <= STALL_KEEP_MS)
    if (this.stalls.length > MAX_STALLS) this.stalls = this.stalls.slice(-MAX_STALLS)
  }

  /** The kept stalls, newest last; running culprits carry their age now. */
  list(now: number = Date.now()): StallRecord[] {
    this.prune(now)
    return this.stalls.map((s) => ({
      ...s,
      culprits: s.culprits.map((c) =>
        c.running ? { ...c, ms: Math.max(c.ms, now - c.started_at) } : { ...c }
      )
    }))
  }
}

// ─── This process ─────────────────────────────────────────────────────────────

let book: StallBook | null = null
let onCaptured: (() => void) | null = null

/** Boot (ops-signals): start attributing stalls on this process. Never in cloud mode. */
export function startStallCauses(captured?: () => void): void {
  if (process.env.CLOUD_META_DB_URL || book) return
  book = new StallBook(() => inflightStallCandidates())
  onCaptured = captured ?? null
  setInflightEndListener((raw) => book?.noteEnded(raw))
}

/** Every lag sample (ops-signals → here). */
export function noteStallSample(lag: number, at: number = Date.now()): void {
  if (!book) return
  try {
    if (book.noteLag(lag, at) && onCaptured) onCaptured()
  } catch {
    /* attribution never affects the sampler */
  }
}

/** This process's recent stalls (published with the ops signals). */
export function recentStalls(now: number = Date.now()): StallRecord[] {
  return book ? book.list(now) : []
}

/** Tests only. */
export function _resetStallCausesForTests(): void {
  book = null
  onCaptured = null
  setInflightEndListener(null)
}
