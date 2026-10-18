// api/src/services/traffic-partner-contract.ts
/**
 * Partner contract figures (#2150): the response time and availability a partner agreed to, kept
 * on the external API (inside its existing `outbound_contract` JSON as `agreed`), judged against
 * what its calls actually did — per hour, with breaches marked, and month to date as an
 * attainment figure. Pure maths here; the route reads `nivaro_outbound_log` (31-day retention).
 */

export interface AgreedTargets {
  /** The 95th-percentile response time the partner committed to, in ms. */
  p95_ms: number | null
  /** The share of calls that must get a non-5xx answer, in percent. */
  uptime_pct: number | null
}

/** Calls an hour needs before it can breach anything (a single slow call is not a pattern). */
export const MIN_CALLS_PER_HOUR = 3
const HOUR = 3_600_000

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw as Record<string, unknown>
  try {
    const v = JSON.parse(String(raw))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The agreed figures out of an `outbound_contract` value (text or object); null when none. */
export function readAgreed(contract: unknown): AgreedTargets | null {
  const a = parseJson(parseJson(contract)?.agreed)
  if (!a) return null
  const p95 = Number(a.p95_ms)
  const up = Number(a.uptime_pct)
  const t: AgreedTargets = {
    p95_ms: Number.isFinite(p95) && p95 > 0 ? p95 : null,
    uptime_pct: Number.isFinite(up) && up > 0 && up <= 100 ? up : null
  }
  return t.p95_ms == null && t.uptime_pct == null ? null : t
}

/** Validate a PATCH value: null clears; otherwise p95 1–600000 ms and uptime 1–100 %. */
export function validateAgreed(
  v: unknown
): { ok: true; value: AgreedTargets | null } | { ok: false; error: string } {
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'object' || Array.isArray(v))
    return { ok: false, error: 'agreed_targets must be an object or null' }
  const o = v as Record<string, unknown>
  const num = (x: unknown) => (x == null || x === '' ? null : Number(x))
  const p95 = num(o.p95_ms)
  const up = num(o.uptime_pct)
  if (p95 != null && (!Number.isFinite(p95) || p95 < 1 || p95 > 600_000))
    return { ok: false, error: 'p95_ms must be 1–600000' }
  if (up != null && (!Number.isFinite(up) || up < 1 || up > 100))
    return { ok: false, error: 'uptime_pct must be 1–100' }
  if (p95 == null && up == null) return { ok: true, value: null }
  return { ok: true, value: { p95_ms: p95 == null ? null : Math.round(p95), uptime_pct: up } }
}

/** The new `outbound_contract` text: the existing JSON with `agreed` set (or removed). */
export function withAgreed(existing: unknown, agreed: AgreedTargets | null): string | null {
  const base = { ...(parseJson(existing) ?? {}) }
  if (agreed) base.agreed = agreed
  else delete base.agreed
  return Object.keys(base).length ? JSON.stringify(base) : null
}

/** Nearest-rank percentile of unsorted numbers (null when empty). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}

export interface CallRow {
  /** Epoch ms. */
  at: number
  status: number | null
  ms: number | null
}

export interface HourPoint {
  /** Start of the hour, ISO. */
  t: string
  req: number
  p95: number | null
  avail_pct: number | null
  /** Judged against the targets: null when the hour had too few calls or no targets. */
  breach: 'latency' | 'availability' | 'both' | null
  judged: boolean
}

export interface Attainment {
  targets: AgreedTargets
  month_start: string
  calls: number
  p95_ms: number | null
  avail_pct: number | null
  latency_met: boolean | null
  uptime_met: boolean | null
  hours_judged: number
  hours_breached: number
  /** Share of judged hours inside both agreed figures. */
  attainment_pct: number | null
  /** The last 24 hours, hour by hour (the breach marks). */
  series: HourPoint[]
  truncated: boolean
}

/** A call counts as available when the partner answered and did not fail server-side. */
export function answered(status: number | null): boolean {
  return status != null && status < 500
}

export function monthStartUtc(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function judge(
  rows: readonly CallRow[],
  targets: AgreedTargets
): { p95: number | null; avail: number | null; breach: HourPoint['breach'] } {
  const ms = rows.filter((r) => r.ms != null).map((r) => r.ms as number)
  const p95 = percentile(ms, 95)
  const avail = rows.length
    ? (rows.filter((r) => answered(r.status)).length / rows.length) * 100
    : null
  const slow = targets.p95_ms != null && p95 != null && p95 > targets.p95_ms
  const down = targets.uptime_pct != null && avail != null && avail < targets.uptime_pct
  return {
    p95,
    avail,
    breach: slow && down ? 'both' : slow ? 'latency' : down ? 'availability' : null
  }
}

/** Month-to-date attainment and the last 24 hours' breach series for one partner. */
export function attainment(
  rows: readonly CallRow[],
  targets: AgreedTargets,
  now = Date.now(),
  truncated = false
): Attainment {
  const monthStart = monthStartUtc(now)
  const month = rows.filter((r) => r.at >= monthStart)
  const byHour = new Map<number, CallRow[]>()
  for (const r of month) {
    const h = Math.floor(r.at / HOUR)
    const list = byHour.get(h)
    if (list) list.push(r)
    else byHour.set(h, [r])
  }
  let judged = 0
  let breached = 0
  for (const list of byHour.values()) {
    if (list.length < MIN_CALLS_PER_HOUR) continue
    judged++
    if (judge(list, targets).breach) breached++
  }
  const overall = judge(month, targets)
  const nowHour = Math.floor(now / HOUR)
  const series: HourPoint[] = []
  for (let h = nowHour - 23; h <= nowHour; h++) {
    const list = byHour.get(h) ?? rows.filter((r) => Math.floor(r.at / HOUR) === h)
    const enough = list.length >= MIN_CALLS_PER_HOUR
    const j = judge(list, targets)
    series.push({
      t: new Date(h * HOUR).toISOString(),
      req: list.length,
      p95: j.p95,
      avail_pct: j.avail,
      breach: enough ? j.breach : null,
      judged: enough
    })
  }
  return {
    targets,
    month_start: new Date(monthStart).toISOString(),
    calls: month.length,
    p95_ms: overall.p95,
    avail_pct: overall.avail,
    latency_met:
      targets.p95_ms != null && overall.p95 != null ? overall.p95 <= targets.p95_ms : null,
    uptime_met:
      targets.uptime_pct != null && overall.avail != null
        ? overall.avail >= targets.uptime_pct
        : null,
    hours_judged: judged,
    hours_breached: breached,
    attainment_pct: judged ? Math.round(((judged - breached) / judged) * 1000) / 10 : null,
    series,
    truncated
  }
}
