import type { HypothesisRule } from './catalog.js'
import type { ChaosRun, ChaosRunEvent, Verdict } from './runs.js'

/**
 * The run report's maths (#2849): pure functions over one run and its events — the verdict
 * header, one series per sampler split before / during / after the fault with its baseline
 * band, the markers drawn on the charts, time to detect, time to fix and time to recover.
 * No I/O here (the route adds names and the errors people saw), so the numbers are tested
 * with fixture events.
 *
 * Event shapes are read tolerantly: the steady-state watcher (#2828) writes
 * `sample {s: {key: value}, breach?: {sampler, value, op, limit}}` (flat breach fields are
 * read too), the scribe (#2853) writes `note {text?, mark?}` with marks noticed / found_cause /
 * fixed / declared (blind mode's Declare incident, #2854), alert tagging (#2847) writes
 * `alert {label|title|rule, source?, severity?}`, readiness snapshots (#1773) write
 * `readiness {status|verdict, score?, failing?}`.
 */

export type Phase = 'before' | 'during' | 'after'

export interface Band {
  lo: number
  hi: number
  mean: number | null
}

export interface SeriesPoint {
  /** ms since epoch */
  t: number
  v: number | null
  phase: Phase
}

export interface SamplerSeries {
  key: string
  rule: HypothesisRule | null
  band: Band | null
  points: SeriesPoint[]
  /** A sample of this sampler crossed its rule while the fault ran. */
  breached: boolean
}

export type MarkerKind =
  | 'armed'
  | 'disarmed'
  | 'stop'
  | 'abort'
  | 'alert'
  | 'note'
  | 'declared'
  | 'readiness'
  | 'step'

export interface Marker {
  t: number
  kind: MarkerKind
  label: string
}

export interface Breach {
  sampler: string
  value: number | null
  op: string | null
  limit: number | null
}

export interface ReportAlert {
  at: string
  label: string
  source: string | null
  severity: string | null
  /** Seconds after the fault was armed (null when it fired before). */
  after_s: number | null
}

export interface ReportNote {
  at: string
  actor: string | null
  mark: string | null
  text: string
  after_s: number | null
}

export interface ReportReadiness {
  at: string
  status: string
  score: number | null
  failing: string[]
}

export type RecoveryState = 'recovered' | 'not_recovered' | 'no_data'

export interface RunReport {
  run_id: string
  status: ChaosRun['status']
  verdict: Verdict | null
  /** The sampler that broke the hypothesis (verdict broke / aborted), when one did. */
  broke_by: Breach | null
  armed_at: string | null
  disarmed_at: string | null
  series: SamplerSeries[]
  markers: Marker[]
  alerts: ReportAlert[]
  notes: ReportNote[]
  readiness: ReportReadiness[]
  /** Seconds from arm to the first alert / noticed / declared mark. */
  ttd_s: number | null
  ttd_source: 'alert' | 'noticed' | 'declared' | 'recorded' | null
  /** Seconds from arm to the first "fixed" mark. */
  ttf_s: number | null
  /** Seconds from disarm until every watched sampler was back inside its baseline band. */
  ttr_s: number | null
  ttr_state: RecoveryState
}

// ─── Reading events ───────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/** The sampler values one `sample` event carries. */
export function sampleValues(data: Record<string, unknown>): Record<string, number | null> {
  const raw = (data.s ?? data.samples ?? data.values) as Record<string, unknown> | undefined
  const out: Record<string, number | null> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) out[k] = num(v)
  }
  return out
}

/** The breach one `sample` event reports (nested or flat), else null. */
export function sampleBreach(data: Record<string, unknown>): Breach | null {
  const b = data.breach
  if (b && typeof b === 'object') {
    const o = b as Record<string, unknown>
    const sampler = str(o.sampler)
    if (sampler) return { sampler, value: num(o.value), op: str(o.op), limit: num(o.limit) }
  }
  if (b === true || (b == null && str(data.sampler) && data.limit != null)) {
    const sampler = str(data.sampler)
    if (sampler)
      return { sampler, value: num(data.value), op: str(data.op), limit: num(data.limit) }
  }
  return null
}

/** A scribe mark, normalised: 'noticed' | 'found_cause' | 'fixed' | 'declared' | other | null. */
export function noteMark(data: Record<string, unknown>): string | null {
  const raw = str(data.mark) ?? str(data.preset) ?? str(data.tag)
  if (!raw) return null
  const m = raw.toLowerCase().replace(/[\s-]+/g, '_')
  if (m === 'found' || m === 'cause' || m === 'found_the_cause') return 'found_cause'
  if (m === 'declare' || m === 'declared_incident' || m === 'incident') return 'declared'
  if (m === 'notice' || m === 'detected') return 'noticed'
  if (m === 'fix' || m === 'resolved') return 'fixed'
  return m.slice(0, 40)
}

const MARK_LABEL: Record<string, string> = {
  noticed: 'Noticed',
  found_cause: 'Found the cause',
  fixed: 'Fixed',
  declared: 'Incident declared'
}

export function markLabel(mark: string | null): string | null {
  if (!mark) return null
  return MARK_LABEL[mark] ?? mark.replace(/_/g, ' ')
}

function alertLabel(data: Record<string, unknown>): string {
  return (
    str(data.label) ??
    str(data.title) ??
    str(data.rule) ??
    str(data.name) ??
    str(data.message) ??
    'Alert'
  ).slice(0, 200)
}

/**
 * The baseline band of one sampler. Reads `run.baseline` in any of the shapes a watcher may
 * store (`{samplers: {k: {...}}}`, `{k: {...}}`, `{s: {k: n}}`, `{k: n}`) with min/max, p5/p95
 * or mean ± 2 sd; otherwise the samples taken before the fault was armed; otherwise null.
 */
export function baselineBand(
  baseline: Record<string, unknown> | null | undefined,
  key: string,
  before: number[] = []
): Band | null {
  const b = baseline ?? {}
  const holders = [b.samplers, b.s, b.values, b].filter(
    (h): h is Record<string, unknown> => !!h && typeof h === 'object' && !Array.isArray(h)
  )
  for (const h of holders) {
    const raw = h[key]
    if (raw == null) continue
    const n = num(raw)
    if (n != null) return { lo: n, hi: n, mean: n }
    if (typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const mean = num(o.mean) ?? num(o.avg) ?? num(o.median) ?? num(o.p50)
    const sd = num(o.sd) ?? num(o.stdev) ?? num(o.stddev)
    let lo = num(o.min) ?? num(o.lo) ?? num(o.p5)
    let hi = num(o.max) ?? num(o.hi) ?? num(o.p95)
    if (mean != null && sd != null) {
      lo ??= mean - 2 * sd
      hi ??= mean + 2 * sd
    }
    lo ??= mean
    hi ??= mean
    if (lo != null && hi != null) return { lo: Math.min(lo, hi), hi: Math.max(lo, hi), mean }
  }
  const vals = before.filter((v) => Number.isFinite(v))
  if (vals.length) {
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length
    return { lo: Math.min(...vals), hi: Math.max(...vals), mean }
  }
  return null
}

/** Inside the band, with slack: the rule's tolerance or 10% of the band's scale, whichever is larger. */
export function insideBand(v: number, band: Band, tolerance = 0): boolean {
  const scale = Math.max(Math.abs(band.hi), Math.abs(band.lo), 1)
  const slack = Math.max(tolerance, 0.1 * scale)
  return v >= band.lo - slack && v <= band.hi + slack
}

// ─── The report ───────────────────────────────────────────────────────────────

export function buildRunReport(run: ChaosRun, events: ChaosRunEvent[]): RunReport {
  const sorted = [...events].sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0) || a.id - b.id)
  const armedEv = sorted.find((e) => e.kind === 'armed')
  const endEv = sorted.find((e) => e.kind === 'disarmed' || e.kind === 'stop' || e.kind === 'abort')
  const armedAt = ms(armedEv?.at) ?? ms(run.started_at)
  const disarmedAt = ms(endEv?.at) ?? ms(run.ended_at)
  const sinceArm = (t: number | null): number | null =>
    t != null && armedAt != null && t >= armedAt ? Math.round((t - armedAt) / 1000) : null

  const phaseOf = (t: number, data: Record<string, unknown>): Phase => {
    const p = data.phase
    if (p === 'before' || p === 'during' || p === 'after') return p
    if (armedAt != null && t < armedAt) return 'before'
    if (disarmedAt != null && t > disarmedAt) return 'after'
    return 'during'
  }

  // Series, one per sampler key seen (hypothesis samplers first, in rule order).
  const rules = new Map<string, HypothesisRule>()
  for (const r of run.hypothesis ?? []) if (!rules.has(r.sampler)) rules.set(r.sampler, r)
  const points = new Map<string, SeriesPoint[]>()
  const breachedKeys = new Set<string>()
  let firstBreach: Breach | null = null
  const sampleTimes: Array<{ t: number; phase: Phase; values: Record<string, number | null> }> = []
  for (const e of sorted) {
    if (e.kind !== 'sample') continue
    const t = ms(e.at)
    if (t == null) continue
    const phase = phaseOf(t, e.data)
    const values = sampleValues(e.data)
    sampleTimes.push({ t, phase, values })
    for (const [k, v] of Object.entries(values)) {
      const list = points.get(k) ?? []
      list.push({ t, v, phase })
      points.set(k, list)
    }
    const br = sampleBreach(e.data)
    if (br && phase === 'during') {
      breachedKeys.add(br.sampler)
      firstBreach ??= br
    }
  }
  const keys = [...rules.keys(), ...[...points.keys()].filter((k) => !rules.has(k))]
  const series: SamplerSeries[] = keys.map((key) => {
    const pts = points.get(key) ?? []
    const before = pts.filter((p) => p.phase === 'before' && p.v != null).map((p) => p.v as number)
    return {
      key,
      rule: rules.get(key) ?? null,
      band: baselineBand(run.baseline, key, before),
      points: pts,
      breached: breachedKeys.has(key)
    }
  })

  // The sampler that broke it: the stored verdict detail first, then the first breach seen.
  let brokeBy: Breach | null = null
  if (run.verdict === 'broke' || run.verdict === 'aborted') {
    const d = (run.verdict_detail ?? {}) as Record<string, unknown>
    const list = Array.isArray(d.breaches) ? (d.breaches as Record<string, unknown>[]) : []
    const fromDetail =
      (list[0] ? sampleBreach({ breach: list[0] }) : null) ??
      sampleBreach(d.breach ? { breach: d.breach } : d)
    brokeBy = fromDetail ?? firstBreach
  }

  // Markers, alerts, notes, readiness.
  const markers: Marker[] = []
  const alerts: ReportAlert[] = []
  const notes: ReportNote[] = []
  const readiness: ReportReadiness[] = []
  let ttdAt: number | null = null
  let ttdSource: RunReport['ttd_source'] = null
  let ttfAt: number | null = null
  const detect = (t: number, source: 'alert' | 'noticed' | 'declared') => {
    if (armedAt == null || t < armedAt) return
    if (ttdAt == null || t < ttdAt) {
      ttdAt = t
      ttdSource = source
    }
  }
  for (const e of sorted) {
    const t = ms(e.at)
    if (t == null) continue
    const d = e.data ?? {}
    switch (e.kind) {
      case 'armed':
        markers.push({ t, kind: 'armed', label: 'Fault armed' })
        break
      case 'disarmed':
        markers.push({ t, kind: 'disarmed', label: 'Window ended' })
        break
      case 'stop':
        markers.push({ t, kind: 'stop', label: 'Stopped' })
        break
      case 'abort':
        markers.push({ t, kind: 'abort', label: 'Aborted' })
        break
      case 'alert': {
        const label = alertLabel(d)
        alerts.push({
          at: e.at,
          label,
          source: str(d.source),
          severity: str(d.severity),
          after_s: sinceArm(t)
        })
        markers.push({ t, kind: 'alert', label })
        detect(t, 'alert')
        break
      }
      case 'readiness': {
        const failing = Array.isArray(d.failing)
          ? (d.failing as unknown[]).map((x) =>
              typeof x === 'string' ? x : (str((x as Record<string, unknown>)?.label) ?? '')
            )
          : []
        readiness.push({
          at: e.at,
          status: str(d.status) ?? str(d.verdict) ?? 'recorded',
          score: num(d.score),
          failing: failing.filter(Boolean).slice(0, 20)
        })
        markers.push({ t, kind: 'readiness', label: `Readiness ${str(d.status) ?? ''}`.trim() })
        break
      }
      case 'note':
      case 'step': {
        const mark = noteMark(d)
        const text = str(d.text) ?? str(d.label) ?? markLabel(mark)
        // Bookkeeping notes (refusals, apply failures) are not participants' notes.
        if (!text || d.refusal != null || d.apply_failed != null) break
        if (e.kind === 'step' && !mark) {
          markers.push({ t, kind: 'step', label: text.slice(0, 120) })
          break
        }
        notes.push({
          at: e.at,
          actor: e.actor,
          mark,
          text: text.slice(0, 1000),
          after_s: sinceArm(t)
        })
        markers.push({
          t,
          kind: mark === 'declared' ? 'declared' : 'note',
          label: (markLabel(mark) ?? text).slice(0, 120)
        })
        if (mark === 'noticed' || mark === 'declared') detect(t, mark)
        if (mark === 'fixed' && armedAt != null && t >= armedAt && ttfAt == null) ttfAt = t
        break
      }
      default:
        // A dedicated 'declared' kind, should blind mode add one.
        if ((e.kind as string) === 'declared') {
          markers.push({ t, kind: 'declared', label: 'Incident declared' })
          detect(t, 'declared')
        }
    }
  }

  // Recorded runs (CI, game-day steps) may carry their own timings.
  const vd = (run.verdict_detail ?? {}) as Record<string, unknown>
  let ttd = sinceArm(ttdAt)
  if (ttd == null) {
    const rec = num(vd.ttd_s) ?? num(vd.time_to_detect_s)
    if (rec != null) {
      ttd = rec
      ttdSource = 'recorded'
    }
  }

  // Time to recover: the first sample after disarm where every watched sampler is inside its band.
  const watched = series.filter((s) => s.band && (rules.size === 0 || s.rule))
  let ttr: number | null = null
  let ttrState: RecoveryState = 'no_data'
  const after = sampleTimes.filter((s) => s.phase === 'after')
  if (watched.length && after.length && disarmedAt != null) {
    ttrState = 'not_recovered'
    for (const s of after) {
      const judged = watched.filter((w) => s.values[w.key] != null)
      if (!judged.length) continue
      const ok = judged.every((w) =>
        insideBand(s.values[w.key] as number, w.band as Band, w.rule?.tolerance ?? 0)
      )
      if (ok) {
        ttr = Math.max(0, Math.round((s.t - disarmedAt) / 1000))
        ttrState = 'recovered'
        break
      }
    }
  }
  if (ttr == null) {
    const rec = num(vd.ttr_s) ?? num(vd.time_to_recover_s)
    if (rec != null) {
      ttr = rec
      ttrState = 'recovered'
    }
  }

  return {
    run_id: run.id,
    status: run.status,
    verdict: run.verdict,
    broke_by: brokeBy,
    armed_at: armedAt != null ? new Date(armedAt).toISOString() : null,
    disarmed_at: disarmedAt != null ? new Date(disarmedAt).toISOString() : null,
    series,
    markers,
    alerts,
    notes,
    readiness,
    ttd_s: ttd,
    ttd_source: ttd == null ? null : ttdSource,
    ttf_s: sinceArm(ttfAt),
    ttr_s: ttr,
    ttr_state: ttrState
  }
}

/** The figures trends and the matrix keep per run (cached on `run.meta.report`). */
export interface RunFigures {
  v: 1
  ttd_s: number | null
  ttr_s: number | null
  ttr_state: RecoveryState
  alerts: number
}

export function runFigures(report: RunReport): RunFigures {
  return {
    v: 1,
    ttd_s: report.ttd_s,
    ttr_s: report.ttr_s,
    ttr_state: report.ttr_state,
    alerts: report.alerts.length
  }
}
