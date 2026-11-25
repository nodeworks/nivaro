import type { StackRoleName } from '../docker/agent-types.js'
import { isTimeZone, zonedParts } from '../releases/zoned.js'
import { DEFAULT_CAPS, ROLE_MIN } from './shape.js'

/**
 * Nivaro Hub autoscaling rules (one per role of a stack) and the decision a tick makes from the
 * figures. Pure: no I/O, the clock passed in.
 *
 * A rule keeps a role between `min` and `max` replicas. It scales OUT one step when any of its
 * metrics stays above its `out_above` for `sustain` evaluations in a row, and IN one step when
 * every metric with a figure stays below its `in_below` for `sustain_in` evaluations in a row.
 * `in_below` must sit below `out_above` (hysteresis), a change waits `cooldown_out_min` /
 * `cooldown_in_min` after the last one, and there is at most one step every `step_every_min`
 * minutes. A schedule raises the floor inside its window (weekdays 7 AM–7 PM in New York: at
 * least 4 web); outside it the rule scales back in by its metrics as usual. A metric with no
 * figure (an app too old to report it, a read that failed) is never read as zero: it counts for
 * neither direction, and with no figure at all nothing changes.
 */

export type ScaleMetric =
  | 'cpu_pct'
  | 'memory_pct'
  | 'requests_per_min'
  | 'p95_ms'
  | 'heavy_queue'
  | 'import_queue'
  | 'export_queue'

export const METRICS: readonly ScaleMetric[] = [
  'cpu_pct',
  'memory_pct',
  'requests_per_min',
  'p95_ms',
  'heavy_queue',
  'import_queue',
  'export_queue'
]

/** Which metrics mean something for a role (the editor offers only these). */
export const ROLE_METRICS: Readonly<Record<string, readonly ScaleMetric[]>> = {
  web: ['cpu_pct', 'memory_pct', 'requests_per_min', 'p95_ms', 'heavy_queue'],
  realtime: ['cpu_pct', 'memory_pct'],
  importer: ['cpu_pct', 'memory_pct', 'import_queue'],
  exporter: ['cpu_pct', 'memory_pct', 'export_queue']
}

export const METRIC_WORDS: Readonly<Record<ScaleMetric, string>> = {
  cpu_pct: 'CPU (% of the limit)',
  memory_pct: 'memory (% of the limit)',
  requests_per_min: 'requests per minute per replica',
  p95_ms: 'p95 answer time (ms)',
  heavy_queue: 'heavy reads waiting',
  import_queue: 'imports waiting',
  export_queue: 'exports waiting'
}

export interface MetricRule {
  metric: ScaleMetric
  out_above: number
  in_below: number
}

export interface ScaleSchedule {
  /** 0 = Sunday … 6 = Saturday, in `zone`. */
  days: number[]
  /** HH:MM; `to` ≤ `from` wraps past midnight. */
  from: string
  to: string
  zone: string
  /** The floor inside the window. */
  min: number
}

export interface AutoRule {
  enabled: boolean
  min: number
  max: number
  metrics: MetricRule[]
  sustain: number
  sustain_in: number
  cooldown_out_min: number
  cooldown_in_min: number
  step_every_min: number
  step: number
  schedules: ScaleSchedule[]
}

export interface AutoState {
  above: number
  below: number
  /** ISO time of the last change this rule (or a person) made. */
  last_change_at: string | null
  /** ISO times the rule wanted more than `max` (last 24 h, at most one per 10 min). */
  max_hits: string[]
  last_eval_at: string | null
  /** ISO time the app's people were last told the rule keeps hitting its max. */
  max_noticed_at: string | null
  /** The rule paused itself after repeated failed runs (ISO); null = running. */
  paused_at: string | null
  paused_reason: string | null
  /** A person resumed it (ISO): failures before this no longer count. */
  resumed_at: string | null
}

export const EMPTY_STATE: AutoState = {
  above: 0,
  below: 0,
  last_change_at: null,
  max_hits: [],
  last_eval_at: null,
  max_noticed_at: null,
  paused_at: null,
  paused_reason: null,
  resumed_at: null
}

export const RULE_DEFAULTS: Omit<AutoRule, 'min' | 'max' | 'metrics'> = {
  enabled: false,
  sustain: 3,
  sustain_in: 10,
  cooldown_out_min: 5,
  cooldown_in_min: 15,
  step_every_min: 10,
  step: 1,
  schedules: []
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
const isNum = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The largest threshold a metric may carry. */
const METRIC_MAX: Readonly<Record<ScaleMetric, number>> = {
  cpu_pct: 1000,
  memory_pct: 100,
  requests_per_min: 1_000_000,
  p95_ms: 600_000,
  heavy_queue: 100_000,
  import_queue: 100_000,
  export_queue: 100_000
}

export type RuleCheck = { ok: true; rule: AutoRule } | { ok: false; error: string }

/** A rule from a request body, checked; `role` decides the floor and the metrics it may use. */
export function checkRule(raw: unknown, role: StackRoleName): RuleCheck {
  if (!isObj(raw)) return { ok: false, error: 'The rule is an object.' }
  const floor = ROLE_MIN[role] ?? 1
  const fail = (error: string): RuleCheck => ({ ok: false, error })
  const min = raw.min
  const max = raw.max
  if (!isInt(min, floor, DEFAULT_CAPS.max_replicas))
    return fail(`min is a whole number from ${floor} to ${DEFAULT_CAPS.max_replicas}.`)
  if (!isInt(max, min, DEFAULT_CAPS.max_replicas))
    return fail(`max is a whole number from min (${min}) to ${DEFAULT_CAPS.max_replicas}.`)
  const allowed = ROLE_METRICS[role] ?? []
  const metrics: MetricRule[] = []
  const rawMetrics = Array.isArray(raw.metrics) ? raw.metrics : []
  if (rawMetrics.length > allowed.length) return fail('Name each metric once.')
  for (const m of rawMetrics) {
    if (!isObj(m) || typeof m.metric !== 'string' || !allowed.includes(m.metric as ScaleMetric))
      return fail(`A ${role} rule may use ${allowed.map((x) => METRIC_WORDS[x]).join(', ')}.`)
    const metric = m.metric as ScaleMetric
    if (metrics.some((x) => x.metric === metric)) return fail('Name each metric once.')
    const hi = METRIC_MAX[metric]
    if (!isNum(m.out_above, 0, hi) || !isNum(m.in_below, 0, hi))
      return fail(`${METRIC_WORDS[metric]}: thresholds are numbers from 0 to ${hi}.`)
    if (m.in_below >= m.out_above)
      return fail(
        `${METRIC_WORDS[metric]}: scale in below a lower figure than you scale out above (${m.in_below} is not below ${m.out_above}).`
      )
    metrics.push({ metric, out_above: m.out_above, in_below: m.in_below })
  }
  const enabled = raw.enabled === true
  if (enabled && metrics.length === 0 && !(Array.isArray(raw.schedules) && raw.schedules.length))
    return fail('An enabled rule needs a metric or a schedule.')
  const pick = (k: keyof typeof RULE_DEFAULTS, lo: number, hi: number): number | null => {
    const v = raw[k]
    if (v === undefined || v === null) return RULE_DEFAULTS[k] as number
    return isInt(v, lo, hi) ? v : null
  }
  const sustain = pick('sustain', 1, 30)
  const sustainIn = pick('sustain_in', 1, 120)
  const cdOut = pick('cooldown_out_min', 0, 240)
  const cdIn = pick('cooldown_in_min', 0, 1440)
  const every = pick('step_every_min', 1, 1440)
  const step = pick('step', 1, 3)
  if (sustain === null) return fail('sustain is 1–30 evaluations.')
  if (sustainIn === null) return fail('sustain_in is 1–120 evaluations.')
  if (cdOut === null || cdIn === null)
    return fail('Cooldowns are 0–240 (out) and 0–1440 (in) minutes.')
  if (every === null) return fail('step_every_min is 1–1440 minutes.')
  if (step === null) return fail('step is 1–3 replicas.')
  const schedules: ScaleSchedule[] = []
  const rawSchedules = Array.isArray(raw.schedules) ? raw.schedules : []
  if (rawSchedules.length > 7) return fail('At most 7 schedules per role.')
  for (const s of rawSchedules) {
    if (!isObj(s)) return fail('A schedule is an object.')
    const days = Array.isArray(s.days) ? [...new Set(s.days)] : []
    if (!days.length || !days.every((d) => isInt(d, 0, 6)))
      return fail('A schedule names its days, 0 (Sunday) to 6 (Saturday).')
    if (
      typeof s.from !== 'string' ||
      !HHMM.test(s.from) ||
      typeof s.to !== 'string' ||
      !HHMM.test(s.to)
    )
      return fail('A schedule runs from HH:MM to HH:MM.')
    if (s.from === s.to) return fail('A schedule window needs a different start and end.')
    if (!isTimeZone(s.zone)) return fail('A schedule names a time zone (America/New_York).')
    if (!isInt(s.min, min, max))
      return fail(`A schedule's floor is from min (${min}) to max (${max}).`)
    schedules.push({
      days: (days as number[]).sort((a, b) => a - b),
      from: s.from,
      to: s.to,
      zone: s.zone,
      min: s.min
    })
  }
  return {
    ok: true,
    rule: {
      enabled,
      min,
      max,
      metrics,
      sustain,
      sustain_in: sustainIn,
      cooldown_out_min: cdOut,
      cooldown_in_min: cdIn,
      step_every_min: every,
      step,
      schedules
    }
  }
}

/** A stored rule read back (null when it is not one any more). */
export function parseRule(raw: unknown, role: StackRoleName): AutoRule | null {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const r = checkRule(v, role)
  return r.ok ? r.rule : null
}

export function parseState(raw: unknown): AutoState {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return { ...EMPTY_STATE, max_hits: [] }
    }
  }
  if (!isObj(v)) return { ...EMPTY_STATE, max_hits: [] }
  const n = (x: unknown) => (isInt(x, 0, 100_000) ? x : 0)
  const iso = (x: unknown) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? x : null)
  return {
    above: n(v.above),
    below: n(v.below),
    last_change_at: iso(v.last_change_at),
    max_hits: (Array.isArray(v.max_hits) ? v.max_hits : [])
      .map(iso)
      .filter((x): x is string => x !== null)
      .slice(-50),
    last_eval_at: iso(v.last_eval_at),
    max_noticed_at: iso(v.max_noticed_at),
    paused_at: iso(v.paused_at),
    paused_reason: typeof v.paused_reason === 'string' ? v.paused_reason.slice(0, 300) : null,
    resumed_at: iso(v.resumed_at)
  }
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Whether `now` falls in the schedule's window (on the calendar of its zone). */
export function inWindow(s: ScaleSchedule, now: number): boolean {
  const p = zonedParts(now, s.zone)
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  const at = p.hour * 60 + p.minute
  const from = minutesOf(s.from)
  const to = minutesOf(s.to)
  if (from < to) return s.days.includes(weekday) && at >= from && at < to
  // Past midnight: the evening part belongs to its own day, the morning part to the day before.
  if (at >= from) return s.days.includes(weekday)
  if (at < to) return s.days.includes((weekday + 6) % 7)
  return false
}

/** The floor now: the rule's min, the role's own floor and every schedule window it is in. */
export function floorNow(
  rule: AutoRule,
  role: StackRoleName,
  now: number
): {
  min: number
  schedule: ScaleSchedule | null
} {
  let min = Math.max(rule.min, ROLE_MIN[role] ?? 1)
  let schedule: ScaleSchedule | null = null
  for (const s of rule.schedules)
    if (inWindow(s, now) && s.min > min) {
      min = s.min
      schedule = s
    }
  return { min: Math.min(min, rule.max), schedule }
}

export type RoleFigureMap = Partial<Record<ScaleMetric, number | null>>

export interface Decision {
  action: 'out' | 'in' | 'hold'
  /** The replica count to scale to (= current on hold). */
  to: number
  /** A readable reason, with the figure that caused it. */
  reason: string
  /** The figure that caused it (out / in by a metric). */
  metric: ScaleMetric | null
  value: number | null
  threshold: number | null
  /** The rule wanted more than its max now. */
  past_max: boolean
  state: AutoState
}

const MIN_MS = 60_000
const HIT_GAP_MS = 10 * MIN_MS
const HIT_KEEP_MS = 24 * 60 * MIN_MS

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

function since(iso: string | null, now: number): number {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY
}

/**
 * One evaluation of one role's rule. `current` = the replicas the Hub keeps for the role now.
 * Answers the action, the count, the reason with its figure, and the next state to store.
 */
export function decide(o: {
  rule: AutoRule
  role: StackRoleName
  state: AutoState
  current: number
  figures: RoleFigureMap
  now: number
}): Decision {
  const { rule, role, current, figures, now } = o
  const state: AutoState = {
    ...o.state,
    max_hits: o.state.max_hits.filter((t) => now - Date.parse(t) < HIT_KEEP_MS),
    last_eval_at: new Date(now).toISOString()
  }
  const hold = (reason: string, past_max = false): Decision => ({
    action: 'hold',
    to: current,
    reason,
    metric: null,
    value: null,
    threshold: null,
    past_max,
    state
  })
  // Realtime scales in one replica at a time (its sockets drain between steps).
  const step = role === 'realtime' ? 1 : rule.step
  const floor = floorNow(rule, role, now)

  // The floor first: below it (a schedule window began, the min was raised) → straight to it.
  if (current < floor.min) {
    state.above = 0
    state.below = 0
    state.last_change_at = new Date(now).toISOString()
    return {
      action: 'out',
      to: floor.min,
      reason: floor.schedule
        ? `The schedule (${floor.schedule.from}–${floor.schedule.to} ${floor.schedule.zone}) keeps at least ${floor.min}.`
        : `The rule keeps at least ${floor.min}.`,
      metric: null,
      value: null,
      threshold: null,
      past_max: false,
      state
    }
  }
  if (current > rule.max) {
    state.above = 0
    state.below = 0
    state.last_change_at = new Date(now).toISOString()
    return {
      action: 'in',
      to: rule.max,
      reason: `The rule allows at most ${rule.max}.`,
      metric: null,
      value: null,
      threshold: null,
      past_max: false,
      state
    }
  }

  const seen = rule.metrics.filter((m) => typeof figures[m.metric] === 'number')
  if (!seen.length) {
    state.above = 0
    state.below = 0
    return hold('No figures to judge by.')
  }
  const over = seen.find((m) => (figures[m.metric] as number) > m.out_above)
  const allUnder = seen.every((m) => (figures[m.metric] as number) < m.in_below)
  if (over) {
    state.above += 1
    state.below = 0
  } else if (allUnder) {
    state.below += 1
    state.above = 0
  } else {
    state.above = 0
    state.below = 0
  }
  const lastChange = since(state.last_change_at, now)

  if (over && state.above >= rule.sustain) {
    const value = figures[over.metric] as number
    const why = `${METRIC_WORDS[over.metric]} ${fmt(value)} > ${fmt(over.out_above)} for ${state.above} checks`
    if (current >= rule.max) {
      const last = state.max_hits[state.max_hits.length - 1]
      if (!last || now - Date.parse(last) >= HIT_GAP_MS)
        state.max_hits.push(new Date(now).toISOString())
      return hold(`${why}, but the rule's max (${rule.max}) is reached.`, true)
    }
    if (lastChange < rule.cooldown_out_min * MIN_MS || lastChange < rule.step_every_min * MIN_MS)
      return hold(`${why}; waiting for the cooldown.`)
    state.above = 0
    state.below = 0
    state.last_change_at = new Date(now).toISOString()
    return {
      action: 'out',
      to: Math.min(rule.max, current + step),
      reason: `${why}.`,
      metric: over.metric,
      value,
      threshold: over.out_above,
      past_max: false,
      state
    }
  }

  if (allUnder && state.below >= rule.sustain_in && current > floor.min) {
    if (lastChange < rule.cooldown_in_min * MIN_MS || lastChange < rule.step_every_min * MIN_MS)
      return hold('Every figure is low; waiting for the cooldown.')
    const lead = seen[0]
    const value = figures[lead.metric] as number
    state.above = 0
    state.below = 0
    state.last_change_at = new Date(now).toISOString()
    return {
      action: 'in',
      to: Math.max(floor.min, current - step),
      reason: `Every figure under its scale-in mark for ${rule.sustain_in} checks (${METRIC_WORDS[lead.metric]} ${fmt(value)} < ${fmt(lead.in_below)}).`,
      metric: lead.metric,
      value,
      threshold: lead.in_below,
      past_max: false,
      state
    }
  }
  return hold(over ? 'Above a mark, not yet for long enough.' : 'Within the marks.')
}

/** Times the rule wanted more than its max in the last 24 h (the readiness warning: ≥ 3). */
export function maxHits24h(state: AutoState, now: number): number {
  return state.max_hits.filter((t) => now - Date.parse(t) < HIT_KEEP_MS).length
}

export const MAX_HITS_WARN = 3
