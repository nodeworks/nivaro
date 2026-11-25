import { isTimeZone, zonedParts } from '../releases/zoned.js'

/**
 * On-call rota arithmetic (Hub enhancement 33). Pure: rows in, who is on call out.
 *
 * A rota belongs to one app: people in order (Hub accounts), a weekly hand-over (weekday + time
 * on the calendar of `time_zone`, so 09:00 Monday in New York stays 09:00 across DST) and the day
 * it starts. The first person is on call from `starts_on` until the first hand-over after it;
 * every hand-over passes to the next person, round the list. An override (a person for a time
 * range) beats the rota while it runs; when two overlap, the newest wins.
 *
 * Escalation: `steps` in order (on_call → next → owners → admins by default; owners and admins
 * are always appended when missing, chainOf); a page goes to the first step at once and to the
 * next one every `escalate_minutes` while nobody acknowledges it.
 */

export const WEEK_MS = 7 * 86_400_000
export const MAX_PEOPLE = 20
export const MAX_STEPS = 6
export const STEP_KINDS = ['on_call', 'next', 'owners', 'admins'] as const
export type StepKind = (typeof STEP_KINDS)[number]
export const DEFAULT_STEPS: StepKind[] = ['on_call', 'next', 'owners', 'admins']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export interface Rota {
  id: number
  app_id: number
  enabled: boolean
  people: string[]
  time_zone: string
  /** 0 = Sunday … 6 = Saturday. */
  handover_weekday: number
  /** 'HH:MM' on the zone's clock. */
  handover_time: string
  starts_on: string
  escalate_minutes: number
  steps: StepKind[]
  updated_by: string | null
  updated_at: string | null
}

export interface Override {
  id: number
  app_id: number
  user_id: string
  starts_at: string
  ends_at: string
  note: string | null
  created_by: string | null
}

export interface Shift {
  user_id: string
  from: string
  to: string
  override?: boolean
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function jsonList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string' || !v) return []
  try {
    const a = JSON.parse(v) as unknown
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

const boolOf = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export function rotaFromRow(r: Record<string, unknown>): Rota {
  const steps = jsonList(r.steps).filter((s): s is StepKind =>
    (STEP_KINDS as readonly string[]).includes(String(s))
  )
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    enabled: boolOf(r.enabled),
    people: jsonList(r.people)
      .map(String)
      .filter((x) => UUID_RE.test(x)),
    time_zone: isTimeZone(r.time_zone) ? String(r.time_zone) : 'UTC',
    handover_weekday: Math.min(6, Math.max(0, Number(r.handover_weekday) || 0)),
    handover_time: TIME_RE.test(String(r.handover_time)) ? String(r.handover_time) : '09:00',
    starts_on: iso(r.starts_on) ?? new Date(0).toISOString(),
    escalate_minutes: Math.min(240, Math.max(1, Number(r.escalate_minutes) || 15)),
    steps: steps.length ? steps : [...DEFAULT_STEPS],
    updated_by: (r.updated_by as string | null) ?? null,
    updated_at: iso(r.updated_at)
  }
}

export function overrideFromRow(r: Record<string, unknown>): Override {
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    user_id: String(r.user_id),
    starts_at: iso(r.starts_at) ?? '',
    ends_at: iso(r.ends_at) ?? '',
    note: (r.note as string | null) ?? null,
    created_by: (r.created_by as string | null) ?? null
  }
}

/**
 * The escalation chain a page walks: the rota's own steps, then the app's owners and the Hub
 * administrators when the rota does not list them — every chain ends with someone who can act.
 */
export function chainOf(rota: Pick<Rota, 'steps'>): StepKind[] {
  const out = [...rota.steps]
  for (const s of ['owners', 'admins'] as const) if (!out.includes(s)) out.push(s)
  return out
}

/** The UTC instant of wall-clock (y, m 1–12, d, hh:mm) in `tz` (day may overflow the month). */
export function zonedTimeUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string
): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const offset = (ms: number) => {
    const p = zonedParts(ms, tz)
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms
  }
  let at = guess - offset(guess)
  at = guess - offset(at)
  return at
}

/** The first hand-over strictly after `starts_on`. */
export function firstHandover(
  rota: Pick<Rota, 'time_zone' | 'handover_weekday' | 'handover_time' | 'starts_on'>
): number {
  const start = Date.parse(rota.starts_on)
  const tz = rota.time_zone
  const [hh, mm] = rota.handover_time.split(':').map(Number)
  const p = zonedParts(start, tz)
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  let add = (rota.handover_weekday - weekday + 7) % 7
  let at = zonedTimeUtc(p.year, p.month, p.day + add, hh, mm, tz)
  if (at <= start) {
    add += 7
    at = zonedTimeUtc(p.year, p.month, p.day + add, hh, mm, tz)
  }
  return at
}

/** The k-th hand-over (k = 0 is the first). Walks the zone's calendar, so DST never drifts it. */
export function handoverAt(rota: Rota, k: number): number {
  const first = firstHandover(rota)
  const tz = rota.time_zone
  const [hh, mm] = rota.handover_time.split(':').map(Number)
  const p = zonedParts(first, tz)
  return zonedTimeUtc(p.year, p.month, p.day + 7 * k, hh, mm, tz)
}

/** How many hand-overs happened at or before `now` (0 before the first). */
export function handoversBefore(rota: Rota, now: number): number {
  const first = firstHandover(rota)
  if (now < first) return 0
  let k = Math.floor((now - first) / WEEK_MS)
  // Correct for the hour a DST change moves a hand-over.
  while (k > 0 && handoverAt(rota, k) > now) k--
  while (handoverAt(rota, k + 1) <= now) k++
  return k + 1
}

/** The override that runs at `now` (the newest of overlapping ones), or null. */
export function activeOverride(overrides: Override[], now: number): Override | null {
  let hit: Override | null = null
  for (const o of overrides) {
    const s = Date.parse(o.starts_at)
    const e = Date.parse(o.ends_at)
    if (!(now >= s && now < e)) continue
    if (!hit || o.id > hit.id) hit = o
  }
  return hit
}

export interface OnCall {
  /** Who is on call now (null: rota off, nobody listed, or it has not started). */
  user_id: string | null
  /** The next person in the rota (the `next` escalation step); never the same person. */
  next_user_id: string | null
  /** From an override instead of the rota. */
  override: Override | null
  /** When this shift hands over (rota shifts only). */
  until: string | null
}

/** Who is on call for `rota` at `now`. */
export function onCallAt(rota: Rota | null, overrides: Override[], now: number): OnCall {
  const none: OnCall = { user_id: null, next_user_id: null, override: null, until: null }
  if (!rota?.enabled) return none
  const ov = activeOverride(overrides, now)
  const n = rota.people.length
  if (!n) return ov ? { ...none, user_id: ov.user_id, override: ov, until: ov.ends_at } : none
  if (now < Date.parse(rota.starts_on) && !ov) return none
  const k = handoversBefore(rota, now)
  const idx = k % n
  const rotaUser = rota.people[idx]
  const until = new Date(handoverAt(rota, k)).toISOString()
  if (ov) {
    // The rota person stays the next step behind an override (unless it is the same person).
    const next = rotaUser !== ov.user_id ? rotaUser : n > 1 ? rota.people[(idx + 1) % n] : null
    return { user_id: ov.user_id, next_user_id: next, override: ov, until: ov.ends_at }
  }
  const next = n > 1 ? rota.people[(idx + 1) % n] : null
  return {
    user_id: rotaUser,
    next_user_id: next && next !== rotaUser ? next : null,
    override: null,
    until
  }
}

/** The next `count` rota shifts from `now` (overrides marked where they cover a shift's start). */
export function upcomingShifts(
  rota: Rota | null,
  overrides: Override[],
  now: number,
  count = 8
): Shift[] {
  if (!rota?.people.length) return []
  const out: Shift[] = []
  const n = rota.people.length
  const start = Math.max(now, Date.parse(rota.starts_on))
  let k = handoversBefore(rota, start)
  let from = k === 0 ? Date.parse(rota.starts_on) : handoverAt(rota, k - 1)
  for (let i = 0; i < count; i++) {
    const to = handoverAt(rota, k)
    out.push({
      user_id: rota.people[k % n],
      from: new Date(i === 0 ? Math.max(from, start) : from).toISOString(),
      to: new Date(to).toISOString()
    })
    from = to
    k++
  }
  const upcomingOverrides = overrides
    .filter((o) => Date.parse(o.ends_at) > now)
    .map((o) => ({
      user_id: o.user_id,
      from: new Date(Math.max(Date.parse(o.starts_at), now)).toISOString(),
      to: o.ends_at,
      override: true
    }))
  return [...out, ...upcomingOverrides].sort((a, b) => a.from.localeCompare(b.from))
}

export interface RotaInput {
  enabled: boolean
  people: string[]
  time_zone: string
  handover_weekday: number
  handover_time: string
  starts_on: Date
  escalate_minutes: number
  steps: StepKind[]
}

/** Validates a rota body (people must be Hub accounts — the route checks they exist). */
export function validateRota(b: Record<string, unknown>): RotaInput | { error: string } {
  const people = Array.isArray(b.people) ? b.people.map((x) => String(x).trim()) : null
  if (!people) return { error: 'people is a list of Hub account ids' }
  if (!people.length) return { error: 'a rota names at least one person' }
  if (people.length > MAX_PEOPLE) return { error: `at most ${MAX_PEOPLE} people` }
  if (people.some((p) => !UUID_RE.test(p))) return { error: 'people are Hub account ids' }
  const lower = people.map((p) => p.toLowerCase())
  if (new Set(lower).size !== lower.length) return { error: 'a person is listed twice' }
  const tz = b.time_zone == null || b.time_zone === '' ? 'UTC' : b.time_zone
  if (!isTimeZone(tz))
    return { error: 'time_zone must be an IANA time zone (e.g. America/New_York)' }
  const weekday = Number(b.handover_weekday ?? 1)
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
    return { error: 'handover_weekday is 0 (Sunday) to 6 (Saturday)' }
  const time = typeof b.handover_time === 'string' ? b.handover_time : '09:00'
  if (!TIME_RE.test(time)) return { error: 'handover_time is HH:MM (24-hour)' }
  const startsRaw = typeof b.starts_on === 'string' ? new Date(b.starts_on) : new Date()
  if (Number.isNaN(startsRaw.getTime())) return { error: 'starts_on is an ISO time' }
  const minutes = Number(b.escalate_minutes ?? 15)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240)
    return { error: 'escalate_minutes is 1 to 240' }
  const stepsRaw = Array.isArray(b.steps) ? b.steps.map(String) : [...DEFAULT_STEPS]
  if (!stepsRaw.length || stepsRaw.length > MAX_STEPS)
    return { error: `steps lists 1 to ${MAX_STEPS} escalation steps` }
  if (stepsRaw.some((s) => !(STEP_KINDS as readonly string[]).includes(s)))
    return { error: `a step is one of ${STEP_KINDS.join(', ')}` }
  if (stepsRaw[0] !== 'on_call') return { error: 'the first step is on_call' }
  if (new Set(stepsRaw).size !== stepsRaw.length) return { error: 'a step is listed twice' }
  return {
    enabled: b.enabled !== false,
    people,
    time_zone: tz,
    handover_weekday: weekday,
    handover_time: time,
    starts_on: startsRaw,
    escalate_minutes: minutes,
    steps: stepsRaw as StepKind[]
  }
}

export interface OverrideInput {
  user_id: string
  starts_at: Date
  ends_at: Date
  note: string | null
}

export function validateOverride(b: Record<string, unknown>): OverrideInput | { error: string } {
  const user = typeof b.user_id === 'string' ? b.user_id.trim() : ''
  if (!UUID_RE.test(user)) return { error: 'user_id is a Hub account id' }
  const s = typeof b.starts_at === 'string' ? new Date(b.starts_at) : null
  const e = typeof b.ends_at === 'string' ? new Date(b.ends_at) : null
  if (!s || Number.isNaN(s.getTime()) || !e || Number.isNaN(e.getTime()))
    return { error: 'starts_at and ends_at are ISO times' }
  if (e.getTime() <= s.getTime()) return { error: 'ends_at must be after starts_at' }
  if (e.getTime() - s.getTime() > 31 * 86_400_000)
    return { error: 'an override lasts at most 31 days' }
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : ''
  return { user_id: user, starts_at: s, ends_at: e, note: note || null }
}
