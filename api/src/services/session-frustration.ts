import { db } from '../db/index.js'
import { chunkArray } from './db-batch.js'
import { normalizeScreenPath } from './traffic-client-facts.js'

/**
 * Frustration score (#1388): how rough one working session was, 0–100.
 *
 * A session is one journey session (nivaro_admin_journeys.session_id — a
 * browser tab's socket session) on one UTC day; its window runs from its
 * first page to the end of its last. Six components, each counted inside
 * that window for that person:
 *
 *  rage_clicks      RUM 'rage' events (3+ clicks on one element within 600ms).
 *  dead_clicks      RUM 'dead' / 'dead_click' events (#1314 — a click that
 *                   changed nothing). Zero on an instance whose collector does
 *                   not send them.
 *  client_errors    Client error reports they raised (nivaro_issues,
 *                   source 'client'), placed by first or last sighting.
 *  loops            Back-and-forth: pages A → B → A → B within LOOP_WINDOW_MS
 *                   (exact paths, query strings dropped; a list → record 1 →
 *                   list → record 2 walk is browsing, not a loop).
 *  slow_actions     Their API calls slower than that route's p95 (method +
 *                   route pattern, from the same window's calls, at least
 *                   P95_MIN_SAMPLES of them) and at least SLOW_FLOOR_MS.
 *  abandoned_forms  A record form left without a save: a new-record route
 *                   (/collections/<c>/new) held NEW_FORM_MIN_MS, or an
 *                   existing record held EDIT_FORM_MIN_MS, with no non-GET
 *                   request to that collection / item while it was open.
 *                   A step whose length is unknown never counts.
 *
 * score = 100 × (1 − e^(−Σ weight × min(count, COMPONENT_CAP) / scale)).
 * The exponential saturates: one client error is noticeable (≈ 27 with the
 * defaults), a handful of signals together approach 100, and no single
 * runaway component can say more than its cap. Weights and scale live in
 * nivaro_settings.frustration_weights (JSON; NULL = DEFAULT_WEIGHTS).
 *
 * The nightly job rescores the last SCORE_DAYS UTC days (so a session that
 * ran over midnight, or a late RUM beacon, is picked up the next night) and
 * keeps SCORE_RETENTION_DAYS of scores. Reads are admin-only.
 */

export const COMPONENTS = [
  'rage_clicks',
  'dead_clicks',
  'client_errors',
  'loops',
  'slow_actions',
  'abandoned_forms'
] as const
export type Component = (typeof COMPONENTS)[number]

export type Weights = Record<Component, number> & { scale: number }

export const DEFAULT_WEIGHTS: Weights = {
  rage_clicks: 6,
  dead_clicks: 3,
  client_errors: 8,
  loops: 3,
  slow_actions: 2,
  abandoned_forms: 5,
  scale: 25
}

export const COMPONENT_CAP = 10
export const LOOP_WINDOW_MS = 120_000
export const P95_MIN_SAMPLES = 20
export const SLOW_FLOOR_MS = 1_000
export const NEW_FORM_MIN_MS = 10_000
export const EDIT_FORM_MIN_MS = 60_000
/** A step with no duration lasts until the next step of its session, at most this long. */
export const STEP_GAP_MAX_MS = 30 * 60_000
/** Clock slack either side of the session for client-side signals. */
export const SLACK_MS = 5_000
export const SCORE_DAYS = 2
export const SCORE_RETENTION_DAYS = 90
const JOURNEY_CAP = 100_000
const LOG_CAP = 300_000
const SIGNAL_CAP = 100_000
const INSERT_CHUNK = 100

/** The recorder's uploads, the RUM beacon and presence pings are not actions. */
const NOISE = [/\/session-recordings(\/|$)/, /\/rum\/?$/, /\/presence(\/|$)/, /\/socket\.io\//]
const isNoise = (path: string) => NOISE.some((r) => r.test(path))

const up = (v: unknown) => String(v ?? '').toUpperCase()
const ms = (v: unknown): number | null => {
  if (v == null) return null
  const n = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(n) ? n : null
}
const bare = (p: string) => String(p ?? '').split(/[?#]/)[0]

// ─── Weights ────────────────────────────────────────────────────────────────

/** Settings JSON → weights; unknown keys drop, bad values fall back to the default. */
export function parseWeights(raw: unknown): Weights {
  let obj: Record<string, unknown> = {}
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw)
      if (v && typeof v === 'object' && !Array.isArray(v)) obj = v as Record<string, unknown>
    } catch {
      /* defaults */
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>
  }
  const out = { ...DEFAULT_WEIGHTS }
  for (const k of COMPONENTS) {
    const n = Number(obj[k])
    if (obj[k] != null && Number.isFinite(n) && n >= 0 && n <= 100) out[k] = n
  }
  const s = Number(obj.scale)
  if (obj.scale != null && Number.isFinite(s) && s >= 1 && s <= 1000) out.scale = s
  return out
}

/** A weights patch from the editor: every key known and in range, or an error. */
export function validateWeights(input: unknown): Weights | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'weights must be an object' }
  }
  const obj = input as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if (k !== 'scale' && !(COMPONENTS as readonly string[]).includes(k)) {
      return { error: `unknown weight: ${k}` }
    }
    const n = Number(obj[k])
    if (!Number.isFinite(n) || typeof obj[k] === 'boolean' || obj[k] === '' || obj[k] === null) {
      return { error: `${k} must be a number` }
    }
    if (k === 'scale' ? n < 1 || n > 1000 : n < 0 || n > 100) {
      return { error: k === 'scale' ? 'scale must be 1–1000' : `${k} must be 0–100` }
    }
  }
  return parseWeights(obj)
}

export async function loadWeights(): Promise<Weights> {
  try {
    const row = await db('nivaro_settings').where({ id: 1 }).first('frustration_weights')
    return parseWeights(row?.frustration_weights)
  } catch {
    return { ...DEFAULT_WEIGHTS }
  }
}

// ─── Scoring (pure) ─────────────────────────────────────────────────────────

export type Counts = Record<Component, number>

export interface ScoreDetail {
  score: number
  counts: Counts
  /** Points each component added to the raw sum (after its cap). */
  points: Record<Component, number>
}

export function emptyCounts(): Counts {
  return {
    rage_clicks: 0,
    dead_clicks: 0,
    client_errors: 0,
    loops: 0,
    slow_actions: 0,
    abandoned_forms: 0
  }
}

export function scoreCounts(counts: Counts, weights: Weights = DEFAULT_WEIGHTS): ScoreDetail {
  const points = emptyCounts()
  let raw = 0
  for (const k of COMPONENTS) {
    points[k] = weights[k] * Math.min(Math.max(0, counts[k] || 0), COMPONENT_CAP)
    raw += points[k]
  }
  const score = Math.round(100 * (1 - Math.exp(-raw / Math.max(1, weights.scale))))
  return { score: Math.min(100, Math.max(0, score)), counts, points }
}

export interface JourneyRow {
  session_id: string
  user: string
  path: string
  entered_at: Date | string
  duration_seconds: number | null
}

export interface Step {
  path: string
  start: number
  end: number
  /** False when neither a duration nor a following step says how long it lasted. */
  known: boolean
}

export interface Session {
  session_id: string
  user: string
  day: string
  start: number
  end: number
  steps: Step[]
}

/** Journey rows → sessions, one per (session_id, UTC day), steps in order. */
export function buildSessions(rows: JourneyRow[]): Session[] {
  const groups = new Map<
    string,
    Array<{ path: string; at: number; dur: number | null; user: string; sid: string }>
  >()
  for (const r of rows) {
    const at = ms(r.entered_at)
    if (at == null || !r.session_id) continue
    const day = new Date(at).toISOString().slice(0, 10)
    const key = `${r.session_id}\u0001${day}`
    const list = groups.get(key) ?? []
    list.push({
      path: String(r.path ?? ''),
      at,
      dur: r.duration_seconds == null ? null : Number(r.duration_seconds),
      user: String(r.user),
      sid: String(r.session_id)
    })
    groups.set(key, list)
  }
  const out: Session[] = []
  for (const [key, list] of groups) {
    list.sort((a, b) => a.at - b.at)
    const steps: Step[] = list.map((s, i) => {
      const next = list[i + 1]?.at
      if (s.dur != null && Number.isFinite(s.dur)) {
        return { path: s.path, start: s.at, end: s.at + Math.max(0, s.dur) * 1000, known: true }
      }
      if (next != null && next - s.at <= STEP_GAP_MAX_MS) {
        return { path: s.path, start: s.at, end: next, known: true }
      }
      return { path: s.path, start: s.at, end: s.at + 60_000, known: false }
    })
    out.push({
      session_id: list[0].sid,
      user: list[0].user,
      day: key.split('\u0001')[1],
      start: steps[0].start,
      end: Math.max(...steps.map((s) => s.end)),
      steps
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * A → B → A → B within the window, counted without overlap. Consecutive
 * steps on the same path (a query-string change) are one step.
 */
export function countLoops(steps: Step[], windowMs = LOOP_WINDOW_MS): number {
  const seq: Array<{ p: string; t: number }> = []
  for (const s of steps) {
    const p = bare(s.path)
    if (seq.length > 0 && seq[seq.length - 1].p === p) continue
    seq.push({ p, t: s.start })
  }
  let loops = 0
  for (let i = 0; i + 3 < seq.length; ) {
    const [a, b, c, d] = [seq[i], seq[i + 1], seq[i + 2], seq[i + 3]]
    if (a.p === c.p && b.p === d.p && a.p !== b.p && d.t - a.t <= windowMs) {
      loops++
      i += 3
    } else {
      i++
    }
  }
  return loops
}

export interface Write {
  at: number
  method: string
  path: string
}

const RECORD_ROUTE = /^\/collections\/([^/]+)\/([^/]+)\/?$/
const NOT_A_RECORD = new Set(['classic', 's'])

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Record forms held long enough with no write to that collection / item while open. */
export function abandonedForms(
  steps: Step[],
  writes: Write[]
): { count: number; routes: string[] } {
  const routes: string[] = []
  for (const s of steps) {
    if (!s.known) continue
    const m = RECORD_ROUTE.exec(bare(s.path))
    if (!m || NOT_A_RECORD.has(m[2])) continue
    const collection = decode(m[1])
    const item = decode(m[2])
    const isNew = item === 'new' || item === '+'
    if (s.end - s.start < (isNew ? NEW_FORM_MIN_MS : EDIT_FORM_MIN_MS)) continue
    const saved = writes.some((w) => {
      if (w.at < s.start || w.at > s.end + SLACK_MS) return false
      const p = decode(bare(w.path))
      const i = p.indexOf(`/items/${collection}`)
      if (i < 0) return false
      const rest = p.slice(i + `/items/${collection}`.length)
      return rest === '' || rest === '/' || (rest.startsWith('/') && (isNew || rest.includes(item)))
    })
    if (!saved) routes.push(`/collections/${collection}/${isNew ? 'new' : ':id'}`)
  }
  return { count: routes.length, routes }
}

export interface ApiCall {
  user: string
  at: number
  method: string
  path: string
  latency_ms: number
}

export const callKey = (method: string, path: string) =>
  `${String(method).toUpperCase()} ${normalizeScreenPath(bare(path)) ?? bare(path)}`

/** p95 latency per method + route pattern, for routes with enough samples. */
export function routeP95(calls: ApiCall[], minSamples = P95_MIN_SAMPLES): Map<string, number> {
  const by = new Map<string, number[]>()
  for (const c of calls) {
    if (!Number.isFinite(c.latency_ms)) continue
    const k = callKey(c.method, c.path)
    const list = by.get(k) ?? []
    list.push(c.latency_ms)
    by.set(k, list)
  }
  const out = new Map<string, number>()
  for (const [k, list] of by) {
    if (list.length < minSamples) continue
    list.sort((a, b) => a - b)
    out.set(k, list[Math.min(list.length - 1, Math.ceil(list.length * 0.95) - 1)])
  }
  return out
}

export function isSlow(call: ApiCall, p95: Map<string, number>): boolean {
  const limit = p95.get(callKey(call.method, call.path))
  return limit != null && call.latency_ms > limit && call.latency_ms >= SLOW_FLOOR_MS
}

/** The route pattern a session spent the most time on. */
export function topRoute(steps: Step[]): string | null {
  const time = new Map<string, number>()
  for (const s of steps) {
    const p = normalizeScreenPath(bare(s.path))
    if (!p) continue
    time.set(p, (time.get(p) ?? 0) + Math.max(1, s.end - s.start))
  }
  let best: string | null = null
  let bestT = -1
  for (const [p, t] of time) {
    if (t > bestT) {
      best = p
      bestT = t
    }
  }
  return best
}

export interface Signal {
  user: string
  at: number
}

export interface RecordingSpan {
  id: string
  user: string
  start: number
  end: number
}

/** The recording overlapping the session the most, or null. */
export function overlappingRecording(s: Session, recordings: RecordingSpan[]): string | null {
  let best: string | null = null
  let bestOverlap = 0
  for (const r of recordings) {
    if (up(r.user) !== up(s.user)) continue
    const overlap = Math.min(r.end, s.end) - Math.max(r.start, s.start)
    if (overlap > bestOverlap) {
      best = r.id
      bestOverlap = overlap
    }
  }
  return best
}

export interface ScoredSession extends ScoreDetail {
  session: Session
  top_route: string | null
  recording_id: string | null
  abandoned_routes: string[]
}

/**
 * Score every session from the signals. A signal belongs to the person's
 * first session whose window (± SLACK_MS) holds it, so two open tabs do not
 * count one error twice.
 */
export function scoreSessions(
  sessions: Session[],
  input: {
    rage: Signal[]
    dead: Signal[]
    errors: Signal[]
    calls: ApiCall[]
    recordings: RecordingSpan[]
  },
  weights: Weights = DEFAULT_WEIGHTS
): ScoredSession[] {
  const byUser = new Map<string, Session[]>()
  for (const s of sessions) {
    const list = byUser.get(up(s.user)) ?? []
    list.push(s)
    byUser.set(up(s.user), list)
  }
  for (const list of byUser.values()) list.sort((a, b) => a.start - b.start)
  const owner = (user: string, at: number): Session | null =>
    byUser.get(up(user))?.find((s) => at >= s.start - SLACK_MS && at <= s.end + SLACK_MS) ?? null

  const counts = new Map<Session, Counts>()
  const writes = new Map<Session, Write[]>()
  for (const s of sessions) {
    counts.set(s, emptyCounts())
    writes.set(s, [])
  }
  const bump = (list: Signal[], k: Component) => {
    for (const sig of list) {
      const s = owner(sig.user, sig.at)
      if (s) (counts.get(s) as Counts)[k]++
    }
  }
  bump(input.rage, 'rage_clicks')
  bump(input.dead, 'dead_clicks')
  bump(input.errors, 'client_errors')

  const p95 = routeP95(input.calls)
  for (const c of input.calls) {
    if (isNoise(c.path)) continue
    const s = owner(c.user, c.at)
    if (!s) continue
    if (isSlow(c, p95)) (counts.get(s) as Counts).slow_actions++
    const m = String(c.method).toUpperCase()
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
      ;(writes.get(s) as Write[]).push({ at: c.at, method: m, path: c.path })
    }
  }

  return sessions.map((s) => {
    const c = counts.get(s) as Counts
    c.loops = countLoops(s.steps)
    const ab = abandonedForms(s.steps, writes.get(s) as Write[])
    c.abandoned_forms = ab.count
    return {
      ...scoreCounts(c, weights),
      session: s,
      top_route: topRoute(s.steps),
      recording_id: overlappingRecording(s, input.recordings),
      abandoned_routes: ab.routes
    }
  })
}

// ─── The nightly job ────────────────────────────────────────────────────────

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)

async function inUsers<T>(users: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (const chunk of chunkArray(users, 500)) out.push(...(await read(chunk)))
  return out
}

/** Every source read on its own; a missing table loses that component, not the run. */
async function safe<T>(p: () => Promise<T[]>): Promise<T[]> {
  try {
    return await p()
  } catch {
    return []
  }
}

export async function runFrustrationScoring(
  opts: { now?: Date; days?: number } = {}
): Promise<string> {
  const now = opts.now ?? new Date()
  const days = Math.max(1, opts.days ?? SCORE_DAYS)
  const todayStart = Date.parse(`${utcDay(now.getTime())}T00:00:00Z`)
  const from = new Date(todayStart - (days - 1) * 86_400_000)
  const to = now
  const dayList = Array.from({ length: days }, (_, i) => utcDay(from.getTime() + i * 86_400_000))
  const lo = new Date(from.getTime() - SLACK_MS)
  const hi = new Date(to.getTime() + SLACK_MS)

  const journeys = (await db('nivaro_admin_journeys')
    .where('entered_at', '>=', from)
    .where('entered_at', '<', to)
    .orderBy('entered_at', 'asc')
    .limit(JOURNEY_CAP)
    .select('session_id', 'user', 'path', 'entered_at', 'duration_seconds')) as JourneyRow[]
  const sessions = buildSessions(journeys)
  const users = [...new Set(sessions.map((s) => String(s.user)))]

  const [rum, issues, logs, recs] = users.length
    ? await Promise.all([
        safe(
          () =>
            db('nivaro_rum_events')
              .whereIn('kind', ['rage', 'dead', 'dead_click'])
              .whereNotNull('user')
              .where('created_at', '>=', lo)
              .where('created_at', '<=', hi)
              .limit(SIGNAL_CAP)
              .select('user', 'kind', 'created_at') as Promise<
              Array<{ user: string; kind: string; created_at: Date | string }>
            >
        ),
        safe(
          () =>
            db('nivaro_issues')
              .where('source', 'client')
              .whereNotNull('raised_by')
              .where((w) =>
                w.whereBetween('created_at', [lo, hi]).orWhereBetween('last_seen_at', [lo, hi])
              )
              .limit(SIGNAL_CAP)
              .select('raised_by', 'created_at', 'last_seen_at') as Promise<
              Array<{
                raised_by: string
                created_at: Date | string | null
                last_seen_at: Date | string | null
              }>
            >
        ),
        safe(() =>
          inUsers(
            users,
            (chunk) =>
              db('nivaro_api_logs')
                .whereIn('user', chunk)
                .where('created_at', '>=', lo)
                .where('created_at', '<=', hi)
                .limit(LOG_CAP)
                .select('user', 'method', 'path', 'latency_ms', 'created_at') as Promise<
                Array<{
                  user: string
                  method: string
                  path: string
                  latency_ms: number
                  created_at: Date | string
                }>
              >
          )
        ),
        safe(() =>
          inUsers(
            users,
            (chunk) =>
              db('nivaro_session_recordings')
                .whereIn('user', chunk)
                .where('started_at', '<', hi)
                .where((w) =>
                  w
                    .where('started_at', '>=', lo)
                    .orWhere('ended_at', '>=', lo)
                    .orWhere('last_event_at', '>=', lo)
                )
                .select('id', 'user', 'started_at', 'ended_at', 'last_event_at') as Promise<
                Array<{
                  id: string
                  user: string
                  started_at: Date | string
                  ended_at: Date | string | null
                  last_event_at: Date | string | null
                }>
              >
          )
        )
      ])
    : [[], [], [], []]

  const inWindow = (t: number | null) => t != null && t >= lo.getTime() && t <= hi.getTime()
  const signals = (kinds: string[]) =>
    rum
      .filter((r) => kinds.includes(r.kind))
      .map((r) => ({ user: String(r.user), at: ms(r.created_at) as number }))
      .filter((s) => Number.isFinite(s.at))
  const scored = scoreSessions(
    sessions,
    {
      rage: signals(['rage']),
      dead: signals(['dead', 'dead_click']),
      errors: issues
        .map((i) => {
          const c = ms(i.created_at)
          const l = ms(i.last_seen_at)
          return { user: String(i.raised_by), at: (inWindow(c) ? c : l) as number }
        })
        .filter((s) => s.at != null),
      calls: logs
        .map((l) => ({
          user: String(l.user),
          at: ms(l.created_at) as number,
          method: String(l.method ?? 'GET'),
          path: String(l.path ?? ''),
          latency_ms: Number(l.latency_ms)
        }))
        .filter((c) => Number.isFinite(c.at)),
      recordings: recs
        .map((r) => {
          const start = ms(r.started_at) as number
          return {
            id: String(r.id),
            user: String(r.user),
            start,
            end: ms(r.ended_at) ?? ms(r.last_event_at) ?? start
          }
        })
        .filter((r) => Number.isFinite(r.start))
    },
    await loadWeights()
  )

  const rows = scored.map((s) => ({
    session_id: s.session.session_id.slice(0, 64),
    user: s.session.user,
    day: s.session.day,
    session_start: new Date(s.session.start),
    session_end: new Date(s.session.end),
    score: s.score,
    components: JSON.stringify({
      counts: s.counts,
      points: s.points,
      ...(s.abandoned_routes.length ? { abandoned_routes: s.abandoned_routes.slice(0, 10) } : {})
    }),
    top_route: s.top_route ? s.top_route.slice(0, 140) : null,
    recording_id: s.recording_id,
    computed_at: now
  }))

  await db.transaction(async (trx) => {
    await trx('nivaro_session_scores').whereIn('day', dayList).delete()
    for (const chunk of chunkArray(rows, INSERT_CHUNK)) {
      await trx('nivaro_session_scores').insert(chunk)
    }
  })
  await db('nivaro_session_scores')
    .where('day', '<', utcDay(todayStart - SCORE_RETENTION_DAYS * 86_400_000))
    .delete()
    .catch(() => 0)

  const flagged = rows.filter((r) => r.score > 0).length
  return `${rows.length} session(s) scored over ${dayList.join(', ')} (${flagged} above zero)${
    journeys.length >= JOURNEY_CAP ? `; journey rows capped at ${JOURNEY_CAP}` : ''
  }`
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export interface ScoreRow {
  session_id: string
  user: string
  user_name: string | null
  day: string
  session_start: string | null
  session_end: string | null
  score: number
  components: { counts?: Partial<Counts>; points?: Partial<Counts>; abandoned_routes?: string[] }
  top_route: string | null
  recording_id: string | null
}

const iso = (v: unknown) => {
  const t = ms(v)
  return t == null ? null : new Date(t).toISOString()
}

function parseComponents(raw: unknown): ScoreRow['components'] {
  if (typeof raw !== 'string') return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** Drop recording links whose recording has expired since scoring. */
async function liveRecordings(ids: string[]): Promise<Set<string>> {
  const live = new Set<string>()
  for (const chunk of chunkArray([...new Set(ids)], 500)) {
    const rows = (await db('nivaro_session_recordings')
      .whereIn('id', chunk)
      .select('id')) as Array<{
      id: string
    }>
    for (const r of rows) live.add(up(r.id))
  }
  return live
}

export async function readWorstSessions(q: {
  from: string
  to: string
  limit: number
  minScore: number
}): Promise<ScoreRow[]> {
  const rows = (await db('nivaro_session_scores as s')
    .leftJoin('nivaro_users as u', 'u.id', 's.user')
    .where('s.day', '>=', q.from)
    .where('s.day', '<=', q.to)
    .where('s.score', '>=', q.minScore)
    .orderBy('s.score', 'desc')
    .orderBy('s.session_start', 'desc')
    .limit(q.limit)
    .select(
      's.session_id',
      's.user',
      's.day',
      's.session_start',
      's.session_end',
      's.score',
      's.components',
      's.top_route',
      's.recording_id',
      db.raw(
        "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name"
      )
    )) as Array<Record<string, unknown>>
  const live = await liveRecordings(
    rows.map((r) => r.recording_id).filter((v): v is string => typeof v === 'string' && !!v)
  )
  return rows.map((r) => ({
    session_id: String(r.session_id),
    user: String(r.user),
    user_name: (r.user_name as string) || null,
    day: String(r.day),
    session_start: iso(r.session_start),
    session_end: iso(r.session_end),
    score: Number(r.score) || 0,
    components: parseComponents(r.components),
    top_route: (r.top_route as string) ?? null,
    recording_id:
      typeof r.recording_id === 'string' && live.has(up(r.recording_id)) ? r.recording_id : null
  }))
}

/**
 * The person's frustration for one day of the Day view: the worst session
 * overlapping the window and how many were scored. Null when none was.
 */
export async function frustrationForDay(
  userId: string,
  start: Date,
  end: Date
): Promise<{
  score: number
  sessions: number
  worst: Omit<ScoreRow, 'user' | 'user_name'>
} | null> {
  const rows = (await db('nivaro_session_scores')
    .where('user', userId)
    .where('session_start', '<', end)
    .where('session_end', '>=', start)
    .orderBy('score', 'desc')
    .limit(200)
    .select(
      'session_id',
      'day',
      'session_start',
      'session_end',
      'score',
      'components',
      'top_route',
      'recording_id'
    )) as Array<Record<string, unknown>>
  if (rows.length === 0) return null
  const w = rows[0]
  const live =
    typeof w.recording_id === 'string' && w.recording_id
      ? await liveRecordings([w.recording_id])
      : new Set<string>()
  return {
    score: Number(w.score) || 0,
    sessions: rows.length,
    worst: {
      session_id: String(w.session_id),
      day: String(w.day),
      session_start: iso(w.session_start),
      session_end: iso(w.session_end),
      score: Number(w.score) || 0,
      components: parseComponents(w.components),
      top_route: (w.top_route as string) ?? null,
      recording_id:
        typeof w.recording_id === 'string' && live.has(up(w.recording_id)) ? w.recording_id : null
    }
  }
}
