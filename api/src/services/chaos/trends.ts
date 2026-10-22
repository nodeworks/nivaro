import type { FaultDefinition } from './catalog.js'
import { type ClaimView, isVerdictRun, runTime } from './claims.js'
import { MATRIX_DEPENDENCIES, placeRun } from './matrix.js'
import type { RunFigures } from './report.js'
import type { ChaosRun } from './runs.js'

/**
 * Chaos trends (#2859): time to detect and time to recover per month and quarter, drills per
 * day (the calendar heatmap), verdicts per dependency per month and the claims never proven.
 * Pure: the route hands in the runs, each run's cached figures and the claim views. Dates are
 * Eastern calendar dates (the people running drills work in ET).
 */

const TZ = 'America/New_York'
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

/** `YYYY-MM-DD` in Eastern time. */
export const etDay = (t: number): string => dayFmt.format(new Date(t))
export const etMonth = (t: number): string => etDay(t).slice(0, 7)
export const etQuarter = (t: number): string => {
  const [y, m] = etMonth(t).split('-').map(Number)
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`
}

export function median(vals: number[]): number | null {
  if (!vals.length) return null
  const s = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10
}

export function percentile(vals: number[], p: number): number | null {
  if (!vals.length) return null
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}

export interface PeriodTrend {
  period: string
  runs: number
  held: number
  broke: number
  aborted: number
  ttd_median_s: number | null
  ttd_n: number
  ttr_median_s: number | null
  ttr_n: number
}

export interface Trends {
  months: PeriodTrend[]
  quarters: PeriodTrend[]
  days: Array<{ date: string; runs: number; broke: number }>
  dependencies: Array<{
    dependency: string
    label: string
    months: Array<{ period: string; held: number; broke: number; aborted: number }>
  }>
  never_proven: Array<{ key: string; statement: string; area: string; provable: boolean }>
  /** The RTO/RPO feed: GET /api/chaos/trends serves it; the Telemetry page's Recovery panel (#2802, services/recovery/status.ts) judges it against the RTO. */
  recovery: {
    window_days: number
    ttr_median_s: number | null
    ttr_p90_s: number | null
    ttd_median_s: number | null
    not_recovered: number
    runs: number
  }
  /** Runs whose timings were not computed yet (filled on later reads). */
  pending: number
}

function periodTrends(
  runs: ChaosRun[],
  figures: Map<string, RunFigures>,
  keyOf: (t: number) => string,
  periods: string[]
): PeriodTrend[] {
  const by = new Map<string, { runs: ChaosRun[] }>()
  for (const p of periods) by.set(p, { runs: [] })
  for (const r of runs) by.get(keyOf(runTime(r)))?.runs.push(r)
  return periods.map((period) => {
    const list = by.get(period)?.runs ?? []
    const ttd = list.map((r) => figures.get(r.id)?.ttd_s).filter((v): v is number => v != null)
    const ttr = list.map((r) => figures.get(r.id)?.ttr_s).filter((v): v is number => v != null)
    return {
      period,
      runs: list.length,
      held: list.filter((r) => r.verdict === 'held').length,
      broke: list.filter((r) => r.verdict === 'broke').length,
      aborted: list.filter((r) => r.verdict === 'aborted').length,
      ttd_median_s: median(ttd),
      ttd_n: ttd.length,
      ttr_median_s: median(ttr),
      ttr_n: ttr.length
    }
  })
}

/** The last `n` Eastern months, oldest first, ending with the month of `now`. */
export function lastMonths(n: number, now = Date.now()): string[] {
  const [y, m] = etMonth(now).split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const idx = y * 12 + (m - 1) - i
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`)
  }
  return out
}

export function buildTrends(input: {
  runs: ChaosRun[]
  figures: Map<string, RunFigures>
  claims: ClaimView[]
  catalog: FaultDefinition[]
  months?: number
  now?: number
}): Trends {
  const now = input.now ?? Date.now()
  const nMonths = Math.min(36, Math.max(1, input.months ?? 12))
  const months = lastMonths(nMonths, now)
  const first = months[0]
  const runs = input.runs.filter((r) => isVerdictRun(r) && etMonth(runTime(r)) >= first)
  const quarters = [
    ...new Set(months.map((m) => etQuarter(new Date(`${m}-15T12:00:00Z`).getTime())))
  ]

  const dayCounts = new Map<string, { runs: number; broke: number }>()
  for (const r of runs) {
    const d = etDay(runTime(r))
    const c = dayCounts.get(d) ?? { runs: 0, broke: 0 }
    c.runs++
    if (r.verdict !== 'held') c.broke++
    dayCounts.set(d, c)
  }

  const defs = new Map(input.catalog.map((f) => [f.key, f]))
  const deps = MATRIX_DEPENDENCIES.map((d) => {
    const per = new Map(months.map((m) => [m, { held: 0, broke: 0, aborted: 0 }]))
    for (const r of runs) {
      if (!placeRun(r, defs.get(r.fault_key as string)).some((p) => p.dependency === d.id)) continue
      const slot = per.get(etMonth(runTime(r)))
      if (!slot || !r.verdict) continue
      slot[r.verdict]++
    }
    return {
      dependency: d.id,
      label: d.label,
      months: months.map((period) => ({
        period,
        ...(per.get(period) ?? { held: 0, broke: 0, aborted: 0 })
      }))
    }
  })

  const windowDays = 90
  const recent = runs.filter((r) => now - runTime(r) <= windowDays * 86_400_000)
  const ttr = recent
    .map((r) => input.figures.get(r.id)?.ttr_s)
    .filter((v): v is number => v != null)
  const ttd = recent
    .map((r) => input.figures.get(r.id)?.ttd_s)
    .filter((v): v is number => v != null)

  return {
    months: periodTrends(runs, input.figures, etMonth, months),
    quarters: periodTrends(runs, input.figures, etQuarter, quarters),
    days: [...dayCounts.entries()]
      .map(([date, c]) => ({ date, ...c }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    dependencies: deps,
    never_proven: input.claims
      .filter((c) => c.status === 'never')
      .map((c) => ({ key: c.key, statement: c.statement, area: c.area, provable: c.provable })),
    recovery: {
      window_days: windowDays,
      ttr_median_s: median(ttr),
      ttr_p90_s: percentile(ttr, 90),
      ttd_median_s: median(ttd),
      not_recovered: recent.filter((r) => input.figures.get(r.id)?.ttr_state === 'not_recovered')
        .length,
      runs: recent.length
    },
    pending: runs.filter((r) => !input.figures.has(r.id)).length
  }
}
