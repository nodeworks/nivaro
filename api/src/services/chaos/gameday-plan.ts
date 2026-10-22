import { ChaosError } from './gate.js'

/**
 * Game-day plans (#2852) and scribe marks (#2853) — the pure parts, unit-tested. A game day is a
 * `nivaro_chaos_runs` row of kind `gameday` whose `meta.plan` holds this plan; its injected
 * faults are child runs (`gameday_id`), and its timeline (steps, notes, alerts, abort) is the
 * run events of the game-day row. services/chaos/gameday.ts does the I/O.
 */

export type InjectKind = 'fault' | 'announce' | 'checkpoint'

export interface InjectFault {
  fault_key: string
  target?: unknown
  params?: Record<string, unknown>
  seconds?: number
}

export interface GamedayInject {
  id: string
  /** Seconds after the game day starts. */
  at_s: number
  kind: InjectKind
  /** Shown in the console only (user text never rides a system chat line). */
  label: string
  fault?: InjectFault
  preset_id?: string | null
  /** Announce: posted to the channel as the lead, through the normal send path. */
  text?: string
}

export interface GamedayPlan {
  title: string
  /** ISO, UTC. The console edits it in Eastern time. */
  starts_at: string
  duration_min: number
  lead: string
  scribe: string | null
  responders: string[]
  /** #2854: responders do not see the drill banner until the lead reveals. */
  blind: boolean
  /** The scheduler starts the day at `starts_at` (otherwise the lead presses Start). */
  auto_start: boolean
  /** Create a private chat channel for the participants. */
  channel: boolean
  /** Minutes before the start when participants get a reminder. */
  reminders_min: number[]
  /** #2816: when the day ends or is cancelled, plan the same day next month. */
  repeat: 'none' | 'monthly'
  notes: string
  injects: GamedayInject[]
}

export const DURATION_MIN = 15
export const DURATION_MAX = 480
export const INJECTS_MAX = 40
export const RESPONDERS_MAX = 40
export const DEFAULT_REMINDERS = [1440, 15]
/** An inject more than this late is skipped as missed instead of fired. */
export const INJECT_GRACE_MS = 10 * 60_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FAULT_KEY = /^[a-z][a-z0-9_]{1,60}$/
const INJECT_ID = /^[a-z0-9-]{1,40}$/

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

const userId = (v: unknown): string | null =>
  typeof v === 'string' && UUID.test(v.trim()) ? v.trim().toLowerCase() : null

export interface ValidateOptions {
  /** Unknown fault keys are warnings (the catalog differs per instance), never errors. */
  faultExists?: (key: string) => boolean
  /** Refuse a start time in the past (creating or moving a planned day). */
  now?: number
}

/** Validate a plan from the console. Throws ChaosError(400, 'CHAOS_PLAN', {errors}). */
export function validatePlan(
  raw: unknown,
  opts: ValidateOptions = {}
): { plan: GamedayPlan; warnings: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: string[] = []
  const warnings: string[] = []

  const title = str(r.title, 120)
  if (!title) errors.push('A title is required')

  const start = new Date(String(r.starts_at ?? ''))
  if (Number.isNaN(start.getTime())) errors.push('starts_at must be a date and time')
  else if (opts.now != null && start.getTime() < opts.now - 5 * 60_000)
    errors.push('The start time is in the past')

  const duration = Math.round(Number(r.duration_min ?? 60))
  if (!Number.isFinite(duration) || duration < DURATION_MIN || duration > DURATION_MAX)
    errors.push(`The day lasts ${DURATION_MIN} to ${DURATION_MAX} minutes`)

  const lead = userId(r.lead)
  if (!lead) errors.push('Pick a lead')
  const scribe = r.scribe == null || r.scribe === '' ? null : userId(r.scribe)
  if (r.scribe && !scribe) errors.push('The scribe is not a person')
  const responders: string[] = []
  for (const v of Array.isArray(r.responders) ? r.responders : []) {
    const id = userId(v)
    if (!id) {
      errors.push('A responder is not a person')
      continue
    }
    if (!responders.includes(id) && id !== lead) responders.push(id)
  }
  if (responders.length > RESPONDERS_MAX) errors.push(`At most ${RESPONDERS_MAX} responders`)

  const reminders = (Array.isArray(r.reminders_min) ? r.reminders_min : DEFAULT_REMINDERS)
    .map((m) => Math.round(Number(m)))
    .filter((m) => Number.isFinite(m) && m >= 5 && m <= 10_080)
  const remindersMin = [...new Set(reminders)].sort((a, b) => b - a).slice(0, 3)

  const injects: GamedayInject[] = []
  const rawInjects = Array.isArray(r.injects) ? r.injects : []
  if (rawInjects.length > INJECTS_MAX) errors.push(`At most ${INJECTS_MAX} injects`)
  const ids = new Set<string>()
  rawInjects.slice(0, INJECTS_MAX).forEach((v, i) => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    const n = i + 1
    let id = str(o.id, 40).toLowerCase()
    if (!INJECT_ID.test(id) || ids.has(id)) id = `i${n}`
    while (ids.has(id)) id = `${id}-${n}`
    ids.add(id)
    const at = Math.round(Number(o.at_s))
    const kind = o.kind as InjectKind
    if (!['fault', 'announce', 'checkpoint'].includes(kind)) {
      errors.push(`Inject ${n}: kind must be fault, announce or checkpoint`)
      return
    }
    if (!Number.isFinite(at) || at < 0) errors.push(`Inject ${n}: the time must be +0:00 or later`)
    else if (Number.isFinite(duration) && at > duration * 60)
      errors.push(`Inject ${n}: +${fmtOffset(at)} is after the day ends`)
    const label = str(o.label, 120)
    const inj: GamedayInject = { id, at_s: Math.max(0, at || 0), kind, label }
    if (kind === 'fault') {
      const f = (o.fault && typeof o.fault === 'object' ? o.fault : {}) as Record<string, unknown>
      const preset = str(o.preset_id, 64) || null
      const key = str(f.fault_key, 61)
      if (!key && !preset) errors.push(`Inject ${n}: pick a fault or a preset`)
      else if (key && !FAULT_KEY.test(key)) errors.push(`Inject ${n}: ${key} is not a fault key`)
      else if (key && opts.faultExists && !opts.faultExists(key))
        warnings.push(`Inject ${n}: ${key} is not in this instance's catalog — it will be skipped`)
      const seconds = f.seconds == null ? undefined : Math.round(Number(f.seconds))
      if (seconds != null && (!Number.isFinite(seconds) || seconds < 5))
        errors.push(`Inject ${n}: the fault lasts at least 5 seconds`)
      inj.fault = {
        fault_key: key,
        ...(f.target != null ? { target: f.target } : {}),
        ...(f.params && typeof f.params === 'object'
          ? { params: f.params as Record<string, unknown> }
          : {}),
        ...(seconds != null ? { seconds } : {})
      }
      inj.preset_id = preset
      if (!label) inj.label = key || 'Preset'
    } else if (kind === 'announce') {
      const text = str(o.text, 500)
      if (!text) errors.push(`Inject ${n}: an announcement needs text`)
      inj.text = text
      if (!label) inj.label = 'Announcement'
    } else if (!label) inj.label = `Checkpoint ${n}`
    injects.push(inj)
  })
  injects.sort((a, b) => a.at_s - b.at_s)

  if (errors.length) throw new ChaosError(errors[0], 400, 'CHAOS_PLAN', { errors, warnings })
  return {
    plan: {
      title,
      starts_at: start.toISOString(),
      duration_min: duration,
      lead: lead as string,
      scribe,
      responders,
      blind: r.blind === true,
      auto_start: r.auto_start === true,
      channel: r.channel !== false,
      reminders_min: remindersMin,
      repeat: r.repeat === 'monthly' ? 'monthly' : 'none',
      notes: str(r.notes, 2000),
      injects
    },
    warnings
  }
}

/** Lead, scribe and responders, once each. */
export function participantsOf(
  plan: Pick<GamedayPlan, 'lead' | 'scribe' | 'responders'>
): string[] {
  const out: string[] = []
  for (const id of [plan.lead, plan.scribe, ...plan.responders])
    if (id && !out.includes(id.toLowerCase())) out.push(id.toLowerCase())
  return out
}

/** `+mm:ss` (hours roll into minutes: +75:00). */
export function fmtOffset(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Which injects to fire now: due (time reached, inside the grace window, not fired) and missed
 * (more than INJECT_GRACE_MS late — skipped, never fired late).
 */
export function dueInjects(
  plan: Pick<GamedayPlan, 'injects'>,
  startedAt: number,
  now: number,
  done: Set<string>
): { due: GamedayInject[]; missed: GamedayInject[] } {
  const due: GamedayInject[] = []
  const missed: GamedayInject[] = []
  for (const inj of plan.injects) {
    if (done.has(inj.id)) continue
    const at = startedAt + inj.at_s * 1000
    if (at > now) continue
    if (now - at > INJECT_GRACE_MS) missed.push(inj)
    else due.push(inj)
  }
  return { due, missed }
}

/** Reminder minutes whose moment has come (before the start, not yet sent). */
export function dueReminders(
  plan: Pick<GamedayPlan, 'starts_at' | 'reminders_min'>,
  now: number,
  sent: number[]
): number[] {
  const start = Date.parse(plan.starts_at)
  if (!Number.isFinite(start) || now >= start) return []
  return plan.reminders_min.filter((m) => !sent.includes(m) && now >= start - m * 60_000)
}

// ─── Scribe marks (#2853) ─────────────────────────────────────────────────────

export const NOTE_MARKS = ['noticed', 'found_cause', 'fixed', 'declared'] as const
export type NoteMark = (typeof NOTE_MARKS)[number]

export const MARK_LABEL: Record<NoteMark, string> = {
  noticed: 'Noticed',
  found_cause: 'Found cause',
  fixed: 'Fixed',
  declared: 'Declared incident'
}

export function parseMark(v: unknown): NoteMark | null {
  return NOTE_MARKS.includes(v as NoteMark) ? (v as NoteMark) : null
}

interface TimelineEvent {
  at: string
  kind: string
  data: Record<string, unknown>
}

export interface NotePoints {
  /** When the first fault went live (ISO), or null when none did. */
  first_fault_at: string | null
  /** Seconds from the first fault to the first noticed / declared mark. */
  ttd_s: number | null
  /** … to the first "found cause". */
  ttc_s: number | null
  /** … to the first "fixed". */
  ttf_s: number | null
  notes: number
}

/**
 * Time to detect / cause / fix from a timeline. A fault going live is an `armed` event (a plain
 * run) or a `step` event with `outcome: 'armed'` (a game day's inject); a mark is a `note` event
 * with `data.mark`. Marks before the first fault count for nothing.
 */
export function notePoints(events: TimelineEvent[]): NotePoints {
  const t = (e: TimelineEvent) => Date.parse(e.at)
  const sorted = [...events].filter((e) => Number.isFinite(t(e))).sort((a, b) => t(a) - t(b))
  const first = sorted.find(
    (e) => e.kind === 'armed' || (e.kind === 'step' && e.data?.outcome === 'armed')
  )
  const notes = sorted.filter((e) => e.kind === 'note').length
  if (!first) return { first_fault_at: null, ttd_s: null, ttc_s: null, ttf_s: null, notes }
  const t0 = t(first)
  const after = (marks: NoteMark[]) => {
    const hit = sorted.find(
      (e) => e.kind === 'note' && t(e) >= t0 && marks.includes(e.data?.mark as NoteMark)
    )
    return hit ? Math.round((t(hit) - t0) / 1000) : null
  }
  return {
    first_fault_at: new Date(t0).toISOString(),
    ttd_s: after(['noticed', 'declared']),
    ttc_s: after(['found_cause']),
    ttf_s: after(['fixed']),
    notes
  }
}

// ─── Monthly schedule (#2816) ─────────────────────────────────────────────────

const ET = 'America/New_York'

/** Eastern wall-clock parts of an instant. */
function etParts(ms: number): {
  y: number
  m: number
  d: number
  h: number
  min: number
  wd: number
} {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23'
  })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(p.weekday))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, wd }
}

/** The instant an Eastern wall-clock time names (DST-aware). */
export function easternToUtc(y: number, m: number, d: number, h: number, min: number): number {
  let guess = Date.UTC(y, m - 1, d, h + 5, min)
  for (let i = 0; i < 3; i++) {
    const p = etParts(guess)
    const diff = Date.UTC(y, m - 1, d, h, min) - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
    if (diff === 0) break
    guess += diff
  }
  return guess
}

/**
 * The same slot next month: the same nth weekday at the same Eastern time ("second Tuesday,
 * 2 PM"); a fifth weekday that does not exist next month falls back to the last one.
 */
export function nextMonthlyStart(iso: string): string {
  const p = etParts(Date.parse(iso))
  const nth = Math.ceil(p.d / 7)
  const y = p.m === 12 ? p.y + 1 : p.y
  const m = p.m === 12 ? 1 : p.m + 1
  const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate()
  let day = 1 + ((p.wd - firstWd + 7) % 7) + (nth - 1) * 7
  while (day > daysIn) day -= 7
  return new Date(easternToUtc(y, m, day, p.h, p.min)).toISOString()
}

/** The plan of the monthly staging game day (#2816): kill a task, drop Redis, block the share, slow the database. */
export function stagingTemplate(startsAt: string, lead: string): Record<string, unknown> {
  return {
    title: 'Monthly staging game day',
    starts_at: startsAt,
    duration_min: 60,
    lead,
    scribe: null,
    responders: [],
    blind: false,
    auto_start: false,
    channel: true,
    repeat: 'monthly',
    reminders_min: DEFAULT_REMINDERS,
    notes:
      'Run on staging only. Each fault is time-boxed; Stop all ends everything. Stamp Noticed, Found cause and Fixed as they happen.',
    injects: [
      {
        id: 'baseline',
        at_s: 0,
        kind: 'checkpoint',
        label: 'Baseline: dashboards green, readiness passing'
      },
      {
        id: 'kill-task',
        at_s: 300,
        kind: 'fault',
        label: 'Kill a web task',
        fault: {
          fault_key: 'kill_web_task',
          params: { env: 'staging', service: 'api' },
          seconds: 300
        }
      },
      {
        id: 'redis',
        at_s: 900,
        kind: 'fault',
        label: 'Drop Redis',
        fault: { fault_key: 'redis_pause', seconds: 120 }
      },
      {
        id: 'share',
        at_s: 1500,
        kind: 'fault',
        label: 'Block the file share',
        fault: { fault_key: TEMPLATE_KEYS.share, params: { mode: 'read_only' }, seconds: 180 }
      },
      {
        id: 'db-slow',
        at_s: 2100,
        kind: 'fault',
        label: 'Slow the database',
        fault: { fault_key: TEMPLATE_KEYS.db_slow, params: { delay_ms: 500 }, seconds: 180 }
      },
      { id: 'recovered', at_s: 3000, kind: 'checkpoint', label: 'Everything recovered on its own?' }
    ]
  }
}

/**
 * Fault keys of the other chaos areas the template names (c-fdb storage + database faults).
 * Unknown keys are plan warnings and skipped injects, never errors.
 */
export const TEMPLATE_KEYS = { share: 'storage_faults', db_slow: 'db_latency' }
