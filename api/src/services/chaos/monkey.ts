import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../../admin-base.js'
import { db } from '../../db/index.js'
import { instanceKey } from '../instance-key.js'
import {
  type FaultDefinition,
  type FaultTarget,
  getFault,
  type HypothesisRule,
  listFaults
} from './catalog.js'
import { startDrill } from './drill.js'
import { type ChaosError, chaosRefusal } from './gate.js'
import { armedFaults } from './registry.js'
import { type ChaosRun, getRun, listRuns } from './runs.js'
import { getChaosSettings, type MonkeyHours, type MonkeySettings } from './settings.js'

/**
 * Chaos Monkey (#2829): opt-in, on a non-production instance, during the configured weekday
 * hours. The `chaos-monkey` cron ticks every 15 minutes (only where crons tick, one leader per
 * cluster); each tick inside the hours rolls for a drill so that about `max_per_week` land at
 * random moments of the week. A drill is small and short: a share of traffic (or one replica),
 * at most `max_seconds`, the environment's caps on top. Pre-flight (#2848) still judges it —
 * deploy, maintenance window, open incident, another drill — and a refusal is recorded as a
 * `refused` monkey run. Admins and chaos operators are told in-app when one starts and ends.
 */

export const MONKEY_TICK_MINUTES = 15
export const MONKEY_DEFAULT_HYPOTHESIS: HypothesisRule[] = [
  { sampler: 'http.5xx_pct', op: '<', limit: 2, tolerance: 1 }
]

// ── Time (pure) ───────────────────────────────────────────────────────────────

interface ZonedParts {
  /** ISO weekday 1 (Monday) … 7 (Sunday). */
  weekday: number
  /** Minutes since local midnight. */
  minutes: number
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

export function zonedParts(at: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    weekday: WEEKDAYS[get('weekday')] ?? 1,
    minutes: Number(get('hour')) * 60 + Number(get('minute'))
  }
}

function hhmm(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

/** Inside the monkey's hours (weekday listed and start ≤ local time < end). */
export function inMonkeyHours(hours: MonkeyHours, at: Date): boolean {
  const p = zonedParts(at, hours.tz)
  return (
    hours.days.includes(p.weekday) && p.minutes >= hhmm(hours.start) && p.minutes < hhmm(hours.end)
  )
}

/** Monday 00:00 of `at`'s week in `tz`, as an instant (approximate across a DST change: ±1 h). */
export function weekStart(at: Date, tz: string): Date {
  const p = zonedParts(at, tz)
  return new Date(
    at.getTime() - ((p.weekday - 1) * 1440 + p.minutes) * 60_000 - (at.getTime() % 60_000)
  )
}

/** Ticks left this week inside the hours, counting the current one. */
export function ticksLeftThisWeek(
  hours: MonkeyHours,
  at: Date,
  tickMinutes = MONKEY_TICK_MINUTES
): number {
  const p = zonedParts(at, hours.tz)
  const start = hhmm(hours.start)
  const end = hhmm(hours.end)
  const perDay = Math.max(0, Math.ceil((end - start) / tickMinutes))
  let n = 0
  for (const d of hours.days) {
    if (d < p.weekday) continue
    if (d > p.weekday) n += perDay
    else if (p.minutes < end) n += Math.ceil((end - Math.max(start, p.minutes)) / tickMinutes)
  }
  return n
}

// ── Eligibility (pure) ────────────────────────────────────────────────────────

export interface MonkeyVerdict {
  /** Roll this tick (true) or skip it (false, `why` says). */
  ok: boolean
  why: string
  /** Chance this tick fires a drill when ok. */
  chance: number
}

export function looksLikeProduction(key = instanceKey(), env = process.env): boolean {
  return (
    /^prod/i.test(key) ||
    /(^|[-_.])prod(uction)?($|[-_.])/i.test(key) ||
    env.NIVARO_TIER === 'production'
  )
}

export function monkeyVerdict(input: {
  settings: MonkeySettings
  now: Date
  /** Monkey runs started this week (refused ones excluded). */
  thisWeek: number
  gateRefusal: string | null
  production: boolean
  armed: number
}): MonkeyVerdict {
  const { settings: m, now } = input
  const no = (why: string): MonkeyVerdict => ({ ok: false, why, chance: 0 })
  if (!m.enabled) return no('Chaos Monkey is off')
  if (input.gateRefusal) return no(input.gateRefusal)
  if (input.production) return no('Never on a production instance')
  if (!m.faults.length) return no('No faults are approved for the monkey')
  if (!inMonkeyHours(m.hours, now)) return no('Outside the monkey hours')
  if (input.thisWeek >= m.max_per_week)
    return no(`Already ${input.thisWeek} this week (max ${m.max_per_week})`)
  if (input.armed > 0) return no('Another drill is armed')
  const left = ticksLeftThisWeek(m.hours, now)
  const chance = left > 0 ? Math.min(1, (m.max_per_week - input.thisWeek) / left) : 0
  return { ok: chance > 0, why: chance > 0 ? 'eligible' : 'No time left this week', chance }
}

// ── Picking a small, short drill ──────────────────────────────────────────────

export interface MonkeySpec {
  fault_key: string
  label: string
  target: FaultTarget
  params: Record<string, unknown>
  seconds: number
  hypothesis: HypothesisRule[]
  preset: string | null
}

interface PresetLike {
  key: string
  label?: string
  spec: { fault_key: string; params?: Record<string, unknown>; hypothesis?: HypothesisRule[] }
}

async function presetFor(key: string): Promise<PresetLike | null> {
  try {
    // The presets library (#2855) lands beside this file; until then only fault keys resolve.
    const mod = './presets.js'
    const presets = (await import(mod)) as { getPreset?: (k: string) => Promise<PresetLike | null> }
    return (await presets.getPreset?.(key)) ?? null
  } catch {
    return null
  }
}

/** The narrowest target a fault takes: a share, else one replica of several, else (low danger) all. */
export function smallTarget(
  def: FaultDefinition,
  m: MonkeySettings,
  nodes: string[]
): FaultTarget | null {
  if (def.targets.includes('share')) return { kind: 'share', share_pct: m.max_share_pct }
  if (def.targets.includes('node') && nodes.length > 1) return { kind: 'node', node: nodes[0] }
  if (def.targets.includes('all') && def.danger === 'low') return { kind: 'all' }
  return null
}

export async function pickMonkeySpec(
  m: MonkeySettings,
  rng: () => number,
  nodes: string[]
): Promise<MonkeySpec | null> {
  const options: MonkeySpec[] = []
  for (const key of m.faults) {
    const preset = getFault(key) ? null : await presetFor(key)
    const def = getFault(preset?.spec.fault_key ?? key)
    if (!def || def.console_href) continue
    const target = smallTarget(def, m, nodes)
    if (!target) continue
    const hyp = preset?.spec.hypothesis?.length
      ? preset.spec.hypothesis
      : def.hypothesis_defaults?.length
        ? def.hypothesis_defaults
        : MONKEY_DEFAULT_HYPOTHESIS
    options.push({
      fault_key: def.key,
      label: preset?.label ?? def.label,
      target,
      params: preset?.spec.params ?? {},
      seconds: Math.max(5, Math.min(m.max_seconds, def.max_seconds)),
      hypothesis: hyp,
      preset: preset?.key ?? null
    })
  }
  if (!options.length) return null
  return options[Math.min(options.length - 1, Math.floor(rng() * options.length))]
}

// ── The tick ──────────────────────────────────────────────────────────────────

export interface MonkeyTickResult {
  acted: boolean
  why: string
  run_id?: string
}

async function monkeyRunsThisWeek(now: Date, tz: string): Promise<number> {
  const since = weekStart(now, tz).getTime()
  const runs = await listRuns({ kind: 'monkey', limit: 200 }).catch(() => [] as ChaosRun[])
  return runs.filter(
    (r) => r.status !== 'refused' && r.started_at && Date.parse(r.started_at) >= since
  ).length
}

export async function tickMonkey(
  app: FastifyInstance | null,
  opts: { now?: Date; rng?: () => number; force?: boolean } = {}
): Promise<MonkeyTickResult> {
  const now = opts.now ?? new Date()
  const rng = opts.rng ?? Math.random
  const settings = (await getChaosSettings()).monkey
  const verdict = monkeyVerdict({
    settings,
    now,
    thisWeek: await monkeyRunsThisWeek(now, settings.hours.tz),
    gateRefusal: chaosRefusal(),
    production: looksLikeProduction(),
    armed: armedFaults().length
  })
  if (!verdict.ok) return { acted: false, why: verdict.why }
  if (!opts.force && rng() >= verdict.chance)
    return { acted: false, why: `Not this time (chance ${(verdict.chance * 100).toFixed(1)}%)` }

  const { chaosStatus } = await import('./drill.js')
  const spec = await pickMonkeySpec(settings, rng, (await chaosStatus()).nodes)
  if (!spec) return { acted: false, why: 'None of the approved faults can run small' }
  try {
    const { run } = await startDrill({
      fault_key: spec.fault_key,
      target: spec.target,
      params: spec.params,
      seconds: spec.seconds,
      hypothesis: spec.hypothesis,
      note: 'Chaos Monkey',
      kind: 'monkey',
      by: { id: null, name: 'Chaos Monkey' }
    })
    if (app) await announceMonkey(app, run, 'started')
    return { acted: true, why: `Started ${spec.label} for ${spec.seconds}s`, run_id: run.id }
  } catch (err) {
    // A pre-flight refusal is stored by startDrill as a `refused` monkey run.
    const e = err as ChaosError
    return { acted: false, why: `Refused: ${e?.message ?? String(err)}` }
  }
}

// ── Telling people ───────────────────────────────────────────────────────────

const RECIPIENT_CAP = 200

/** Active administrators plus members of the chaos operator roles. */
export async function monkeyAudience(): Promise<string[]> {
  const roles = (await getChaosSettings()).operator_roles
  try {
    const rows = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('u.status', 'active')
      .where((q) => {
        q.where('r.admin_access', true)
        if (roles.length) q.orWhereIn('u.role', roles)
      })
      .limit(RECIPIENT_CAP)
      .select('u.id')) as Array<{ id: string }>
    return [...new Set(rows.map((r) => String(r.id)))]
  } catch {
    return []
  }
}

export async function announceMonkey(
  app: FastifyInstance,
  run: ChaosRun,
  phase: 'started' | 'ended'
): Promise<number> {
  const { notifyUser } = await import('../notification-channels.js')
  const subject =
    phase === 'started'
      ? `Chaos Monkey started: ${run.label}`
      : `Chaos Monkey ended: ${run.label} — ${run.verdict ?? run.status}`
  const message =
    phase === 'started'
      ? `A small drill is running until ${run.ends_at ? new Date(run.ends_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) : 'its window ends'} ET. Stop it from the chaos console.`
      : run.verdict === 'held'
        ? 'What should stay true held.'
        : run.verdict === 'broke'
          ? 'What should stay true broke. Open the run for details.'
          : `It ended ${run.status}.`
  let told = 0
  for (const userId of await monkeyAudience()) {
    try {
      const r = await notifyUser(app, userId, {
        subject,
        message,
        category: 'chaos',
        target: {
          kind: 'external',
          url: `${adminBaseUrl() ?? ''}/chaos?tab=runs&run=${encodeURIComponent(run.id)}`,
          action: 'open'
        },
        source: { kind: 'chaos-monkey', label: 'Chaos Monkey', id: run.id }
      })
      if (!r?.decision?.dropped) told++
    } catch {
      /* the rest still deserve a try */
    }
  }
  return told
}

/** Wait (briefly) for a run to close, then announce a monkey run's end. */
export async function announceMonkeyEnd(
  app: FastifyInstance,
  runId: string,
  waitMs = 15_000
): Promise<boolean> {
  const until = Date.now() + waitMs
  for (;;) {
    const run = await getRun(runId).catch(() => null)
    if (!run || run.kind !== 'monkey') return false
    if (!['running', 'preflight', 'planned'].includes(run.status)) {
      await announceMonkey(app, run, 'ended')
      return true
    }
    if (Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** The faults the settings form offers (everything but console-only drills). */
export function monkeyCandidates(): Array<{ key: string; label: string; danger: string }> {
  return listFaults()
    .filter((f) => !f.console_href)
    .map((f) => ({ key: f.key, label: f.label, danger: f.danger ?? 'low' }))
}

/** The `chaos-monkey` cron (#2829): every 15 minutes, only where crons tick, one leader. */
export function registerChaosMonkeyCron(app: FastifyInstance): void {
  app.cron.schedule(
    'chaos-monkey',
    `*/${MONKEY_TICK_MINUTES} * * * *`,
    async () => {
      const r = await tickMonkey(app)
      if (r.acted) app.log.info(`chaos-monkey: ${r.why}`)
    },
    {
      quiet: true,
      idempotent: 'unsafe',
      // What this tick would decide, with nothing armed.
      dryRun: async () => {
        const m = (await getChaosSettings()).monkey
        return monkeyVerdict({
          settings: m,
          now: new Date(),
          thisWeek: await monkeyRunsThisWeek(new Date(), m.hours.tz),
          gateRefusal: chaosRefusal(),
          production: looksLikeProduction(),
          armed: armedFaults().length
        })
      }
    }
  )
}
