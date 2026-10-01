// api/src/services/traffic-taps/db-time.ts
/**
 * #1174 — interactive vs background database time. Who the database spent its time on over the
 * window: people (session requests), integrations (token / API-key requests), and the work no
 * person waits on — cron jobs, imports, flows, anything else outside a request.
 *
 * Request time comes from the request trace's query accounting (requestMeasure().sqlMs, read
 * once at onResponse). Background time is measured here: a knex `query` listener that times
 * every statement run OUTSIDE a request, attributed by the traffic source (traffic-source.ts —
 * the cron manager, the import worker and flows set it). A flow a request sets off is counted
 * with the request (it ran inside it).
 *
 * The heaviest cron job of the window gets a suggestion: the hour of the day the API is
 * quietest (7 days of nivaro_api_logs, by the job's time zone) when the job runs in a busier one.
 *
 * frame (every 5 s): { people, integrations, cron, import, flow, other } ms over the last minute.
 * snapshot: DbTimeSplit for the window.
 */
import { _staticDb, db, dbRead } from '../../db/index.js'
import { getApp } from '../io-holder.js'
import { currentTraceCaller, requestMeasure } from '../request-trace.js'
import { MinuteCounter } from '../traffic-ring.js'
import { currentTrafficSource } from '../traffic-source.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { MinuteSlots } from './minute-slots.js'

export const DB_TIME_TAP = 'db-time'
export const DB_TIME_CATEGORIES = [
  'people',
  'integrations',
  'cron',
  'import',
  'flow',
  'other'
] as const
export type DbTimeCategory = (typeof DB_TIME_CATEGORIES)[number]
const SLOT: Record<DbTimeCategory, number> = {
  people: 0,
  integrations: 1,
  cron: 2,
  import: 3,
  flow: 4,
  other: 5
}
/** Statements awaiting their answer; bounded so a leak can never grow without limit. */
const PENDING_CAP = 5000

/** The bucket a request lands in by how it authenticated. Pure. */
export function requestCategory(authMethod: string | null | undefined): DbTimeCategory {
  if (authMethod === 'token' || authMethod === 'api_key' || authMethod === 'key_sim')
    return 'integrations'
  if (authMethod === 'session' || authMethod === 'masquerade') return 'people'
  return 'other'
}

interface State {
  slots: MinuteSlots
  /** DB ms per cron job id. */
  crons: MinuteCounter
}
const state = (): State =>
  tapState<State>(DB_TIME_TAP, () => ({ slots: new MinuteSlots(6), crons: new MinuteCounter(200) }))

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// ── background statements (outside a request) ────────────────────────────────
interface Pending {
  at: number
  cat: DbTimeCategory
  cron: string | null
}
const pending = new Map<string, Pending>()
const attached = new WeakSet<object>()

interface KnexQueryEvent {
  __knexQueryUid?: string
}

/** Attach the background-statement timer to a knex client (once per client). */
export function attachBackgroundTiming(client: {
  on: (ev: string, fn: (...a: unknown[]) => void) => unknown
}): void {
  if (attached.has(client)) return
  attached.add(client)
  client.on('query', (q: unknown) => {
    try {
      // Inside a request: the request's own accounting counts it at onResponse.
      if (currentTraceCaller() !== null) return
      const uid = (q as KnexQueryEvent).__knexQueryUid
      if (!uid) return
      if (pending.size >= PENDING_CAP) pending.clear()
      const src = currentTrafficSource()
      const cat: DbTimeCategory =
        src?.kind === 'cron'
          ? 'cron'
          : src?.kind === 'import'
            ? 'import'
            : src?.kind === 'flow'
              ? 'flow'
              : 'other'
      pending.set(uid, {
        at: performance.now(),
        cat,
        cron: src?.kind === 'cron' ? src.id.slice(src.id.indexOf(':') + 1) : null
      })
    } catch {
      /* never */
    }
  })
  const settle = (q: unknown) => {
    try {
      const uid = (q as KnexQueryEvent).__knexQueryUid
      if (!uid) return
      const p = pending.get(uid)
      if (!p) return
      pending.delete(uid)
      const ms = performance.now() - p.at
      noteBackground(p.cat, ms, p.cron)
    } catch {
      /* never */
    }
  }
  client.on('query-response', (_res: unknown, q: unknown) => settle(q))
  client.on('query-error', (_err: unknown, q: unknown) => settle(q))
}

/** Exported for tests. */
export function noteBackground(
  cat: DbTimeCategory,
  ms: number,
  cron: string | null,
  sec = nowSec()
): void {
  if (process.env.CLOUD_META_DB_URL || !(ms > 0)) return
  const st = state()
  st.slots.add(sec, SLOT[cat], ms)
  if (cron) st.crons.bump(cron, sec, Math.round(ms))
}

/** Time background statements on both pools (the route plugin calls it once at boot). */
export function startDbTimeTiming(): void {
  if (process.env.CLOUD_META_DB_URL) return
  try {
    for (const k of [_staticDb, dbRead]) {
      const client = (k as unknown as { client?: { on?: unknown } } | undefined)?.client
      if (client && typeof client.on === 'function')
        attachBackgroundTiming(client as Parameters<typeof attachBackgroundTiming>[0])
    }
  } catch {
    /* no pools (tests) */
  }
}

// ── the split ─────────────────────────────────────────────────────────────────
export interface DbTimeSplit {
  window_s: number
  total_ms: number
  /** ms per category. */
  ms: Record<DbTimeCategory, number>
  /** Share of total per category (0..1). */
  share: Record<DbTimeCategory, number>
  /** People's share — the interactive part. */
  interactive: number
  /** Cron + import + flow + other — no person waits on it. */
  background: number
  heaviest_cron: { id: string; ms: number } | null
}

export function dbTimeSplit(windowS: number, sec: number): DbTimeSplit {
  const st = state()
  const v = st.slots.sum(windowS, sec)
  const ms = {} as Record<DbTimeCategory, number>
  const share = {} as Record<DbTimeCategory, number>
  let total = 0
  for (const c of DB_TIME_CATEGORIES) {
    ms[c] = Math.round(v[SLOT[c]])
    total += ms[c]
  }
  for (const c of DB_TIME_CATEGORIES)
    share[c] = total > 0 ? Math.round((ms[c] / total) * 1000) / 1000 : 0
  const top = st.crons.top(windowS, sec, 1)[0]
  return {
    window_s: windowS,
    total_ms: total,
    ms,
    share,
    interactive: share.people,
    background: Math.round((share.cron + share.import + share.flow + share.other) * 1000) / 1000,
    heaviest_cron: top && top[1] > 0 ? { id: top[0], ms: top[1] } : null
  }
}

const tap: TrafficTap = {
  id: DB_TIME_TAP,
  onRequest(c) {
    const m = requestMeasure(c.ev.req)
    if (!m || !(m.sqlMs > 0)) return
    state().slots.add(
      c.sec,
      SLOT[requestCategory(c.ev.authMethod)],
      Math.min(m.sqlMs, c.ev.latencyMs)
    )
  },
  frame(sec) {
    if (sec % 5 !== 0) return undefined
    const s = dbTimeSplit(60, sec)
    return s.total_ms > 0 ? s.ms : undefined
  },
  snapshot(windowS, sec) {
    const s = dbTimeSplit(windowS, sec)
    return s.total_ms > 0 ? s : undefined
  },
  sweep(sec) {
    state().crons.sweep(sec)
  }
}
registerTrafficTap(tap)

// ── a quieter slot for the heaviest cron ──────────────────────────────────────
export interface SlotSuggestion {
  job: string
  zone: string
  expression: string
  /** Hours (0–23, job zone) the job fires in over the next day. */
  fires_at: number[]
  /** Average requests per hour (7 days) in the busiest hour it fires. */
  current_load: number
  /** The quietest hour of the day and its load. */
  quiet_hour: number
  quiet_load: number
  /** True when moving would help; false = it already runs in a quiet hour, or runs too often. */
  move: boolean
  reason: string
}

/**
 * Pure: given requests per hour-of-day (job zone, 24 values) and the hours a job fires, the
 * quietest hour and whether moving there is worth it (the job's busiest firing hour carries more
 * than 1.5× the quietest hour's load plus a floor of 10 requests an hour).
 */
export function suggestSlot(
  load: number[],
  firesAt: number[]
): { quiet_hour: number; quiet_load: number; current_load: number; move: boolean; reason: string } {
  let quiet = 0
  for (let h = 1; h < 24; h++) if ((load[h] ?? 0) < (load[quiet] ?? 0)) quiet = h
  const quietLoad = Math.round(load[quiet] ?? 0)
  const hours = [...new Set(firesAt)]
  const current = Math.round(Math.max(0, ...hours.map((h) => load[h] ?? 0)))
  if (hours.length === 0)
    return {
      quiet_hour: quiet,
      quiet_load: quietLoad,
      current_load: 0,
      move: false,
      reason: 'It has no run in the next day.'
    }
  if (hours.length >= 12)
    return {
      quiet_hour: quiet,
      quiet_load: quietLoad,
      current_load: current,
      move: false,
      reason: `It runs in ${hours.length} hours of the day — there is no single quieter slot to move it to.`
    }
  if (current > quietLoad * 1.5 + 10)
    return {
      quiet_hour: quiet,
      quiet_load: quietLoad,
      current_load: current,
      move: true,
      reason: `It runs when the API averages ${current} requests an hour; ${String(quiet).padStart(2, '0')}:00 averages ${quietLoad}.`
    }
  return {
    quiet_hour: quiet,
    quiet_load: quietLoad,
    current_load: current,
    move: false,
    reason: 'It already runs in a quiet hour.'
  }
}

/** The hour of the day `d` falls in, in `zone`. */
export function hourIn(d: Date, zone: string): number {
  try {
    const h = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: '2-digit',
      hourCycle: 'h23'
    }).format(d)
    const n = Number.parseInt(h, 10)
    return Number.isFinite(n) ? n % 24 : d.getUTCHours()
  } catch {
    return d.getUTCHours()
  }
}

let loadCache: { at: number; byUtcHour: number[] } | null = null
const LOAD_TTL_MS = 30 * 60_000

/** Average requests per UTC hour of the day over 7 days of the api log (cached 30 min). */
async function loadByUtcHour(): Promise<number[]> {
  if (loadCache && Date.now() - loadCache.at < LOAD_TTL_MS) return loadCache.byUtcHour
  const since = new Date(Date.now() - 7 * 86_400_000)
  const rows = (await db('nivaro_api_logs')
    .where('created_at', '>=', since)
    .groupByRaw('DATEPART(hour, created_at)')
    .select(db.raw('DATEPART(hour, created_at) AS h'), db.raw('COUNT(*) AS n'))
    .catch(() => [])) as Array<{ h: number; n: number }>
  const out = new Array<number>(24).fill(0)
  for (const r of rows) {
    const h = Number(r.h)
    if (h >= 0 && h < 24) out[h] = Number(r.n) / 7
  }
  loadCache = { at: Date.now(), byUtcHour: out }
  return out
}

/** The UTC-hour profile re-indexed by `zone` hour (today's offset). Pure. */
export function profileInZone(byUtcHour: number[], zone: string, today = new Date()): number[] {
  const out = new Array<number>(24).fill(0)
  for (let h = 0; h < 24; h++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), h))
    out[hourIn(d, zone)] += byUtcHour[h] ?? 0
  }
  return out
}

/** The suggestion for the window's heaviest cron job (null without one). */
export async function heaviestCronSuggestion(
  windowS: number,
  sec: number
): Promise<SlotSuggestion | null> {
  const top = dbTimeSplit(windowS, sec).heaviest_cron ?? dbTimeSplit(3600, sec).heaviest_cron
  if (!top) return null
  const app = getApp() as {
    cron?: { list(): Array<{ id: string; expression: string; timezone?: string }> }
  } | null
  const entry = app?.cron?.list().find((e) => e.id === top.id)
  if (!entry) return null
  const zone = entry.timezone || 'UTC'
  const { previewCronRuns } = await import('../../plugins/cron.js')
  const now = Date.now()
  const runs = previewCronRuns(entry.expression, 200, zone).filter(
    (d) => d.getTime() - now <= 86_400_000
  )
  const fires = runs.map((d) => hourIn(d, zone))
  const load = profileInZone(await loadByUtcHour(), zone)
  const s = suggestSlot(load, fires)
  return {
    job: top.id,
    zone,
    expression: entry.expression,
    fires_at: [...new Set(fires)].sort((a, b) => a - b),
    ...s
  }
}
