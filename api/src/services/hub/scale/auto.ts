import { db } from '../../../db/index.js'
import { deliverHubNotice, hubEventRecipients, type NotifyDeps } from '../notify-events.js'
import { readScaleFigures, type UsageReader } from './figures.js'
import { scalePauses } from './pause.js'
import { planScale, type RoleChangeInput } from './plan.js'
import { type AutoState, decide, MAX_HITS_WARN, METRIC_WORDS, maxHits24h } from './rules.js'
import { type RunDeps, resumeStaleRuns, startScale } from './run.js'
import { isScalable } from './shape.js'
import {
  autoFailures,
  insertRun,
  lastSkipped,
  readRoles,
  SCALE_ROLES,
  saveState,
  type TargetKind
} from './store.js'
import { readTarget, type ScaleTarget } from './target.js'

/**
 * Nivaro Hub autoscaling: the `hub-scale-tick` job (every minute, the cron leader, HUB=on only).
 *
 *   1. resumes scale runs whose process stopped (run.ts resumeStaleRuns);
 *   2. for every stack with an enabled rule on a role that is not pinned to manual: reads its
 *      figures live over its link, judges each rule (rules.ts decide), and when a role should
 *      change plans it like a person would (plan.ts) and starts it as a run (source `auto`, or
 *      `schedule` when a schedule window raised the floor) with the rule's sentence and figures.
 *
 * Paused (a move, upgrade, promotion, release freeze or incident, another run, a lock): no change
 * starts and the rule's counters do not move; a decision that could not run is logged as a
 * `skipped` row (at most one per stack and code every 30 minutes) with the same reason and
 * figures. A rule that wants more than its max is noted; three times in 24 hours is a readiness
 * warning (`hub-scale-max`) and one notice to the app's admins and owners a day.
 */

const SKIP_EVERY_MS = 30 * 60_000
const MAX_NOTICE_EVERY_MS = 24 * 60 * 60_000
const TARGETS_MAX = 200

export interface TickDeps extends RunDeps {
  readUsage?: UsageReader
  notify?: NotifyDeps
}

/** Tells the app's admins and owners once: autoscaling paused itself on this stack. */
async function noticePaused(t: ScaleTarget, text: string, deps: TickDeps): Promise<void> {
  const people = new Set<string>()
  for (const appId of t.app_ids) for (const p of await hubEventRecipients(appId)) people.add(p)
  await deliverHubNotice(
    [...people],
    {
      subject: `Autoscaling paused: ${t.label}`,
      message: `${text} Open the Scaling tab and press Resume rule once it is fixed.`,
      path: `/hub/scale?target=${t.kind}:${t.id}`,
      urgent: t.production,
      source: { kind: 'hub', label: 'scale-paused', id: `${t.kind}:${t.id}` },
      why: 'You are a Hub administrator or an owner of this app.'
    },
    deps.notify
  )
}

export interface TickResult {
  resumed: number
  evaluated: number
  started: number
  skipped: number
  /** Stacks judged this tick (errors fail the job only when every one of them failed). */
  targets: number
  errors: string[]
}

/** Every stack with at least one ENABLED rule on a role not pinned to manual. */
async function ruledTargets(): Promise<Array<{ kind: TargetKind; id: number }>> {
  if (!(await db.schema.hasTable(SCALE_ROLES))) return []
  const rows = (await db(SCALE_ROLES)
    .whereNotNull('auto')
    .select('target_kind', 'target_id', 'auto', 'pinned')) as Array<Record<string, unknown>>
  const out = new Map<string, { kind: TargetKind; id: number }>()
  for (const r of rows) {
    if (r.target_kind !== 'environment' && r.target_kind !== 'shared') continue
    if (r.pinned === true || r.pinned === 1 || r.pinned === '1') continue
    if (!/"enabled":\s*true/.test(String(r.auto ?? ''))) continue
    const k = `${r.target_kind}:${r.target_id}`
    if (!out.has(k)) out.set(k, { kind: r.target_kind as TargetKind, id: Number(r.target_id) })
    if (out.size >= TARGETS_MAX) break
  }
  return [...out.values()]
}

/** After a failed automatic run: wait 10, then 20 minutes; the third pauses the rule. */
export const BACKOFF_MIN = [10, 20]
export const PAUSE_AFTER_FAILURES = 3

async function logSkip(
  t: ScaleTarget,
  code: string,
  text: string,
  figures: Record<string, unknown>,
  now: number
): Promise<boolean> {
  const last = await lastSkipped(t.kind, t.id, code)
  if (last && now - last.getTime() < SKIP_EVERY_MS) return false
  await insertRun({
    target_kind: t.kind,
    target_id: t.id,
    stack: t.stack,
    source: 'auto',
    status: 'skipped',
    reason: text,
    figures,
    from: [],
    to: [],
    steps: [],
    plan_hash: null,
    started_by: null,
    error_code: code,
    at: new Date(now)
  })
  return true
}

async function noticeMax(
  t: ScaleTarget,
  role: string,
  state: AutoState,
  now: number,
  deps: TickDeps
): Promise<AutoState> {
  const hits = maxHits24h(state, now)
  if (hits < MAX_HITS_WARN) return state
  const last = state.max_noticed_at
  if (last && now - Date.parse(last) < MAX_NOTICE_EVERY_MS) return state
  const people = new Set<string>()
  for (const appId of t.app_ids) for (const p of await hubEventRecipients(appId)) people.add(p)
  await deliverHubNotice(
    [...people],
    {
      subject: `Scaling at its max: ${t.label}`,
      message: `The ${role} rule wanted more replicas than its max ${hits} times in 24 hours. Raise the max, or look at what grew.`,
      path: `/hub/scale?target=${t.kind}:${t.id}`,
      source: { kind: 'hub', label: 'scale-max', id: `${t.kind}:${t.id}` },
      why: 'You are a Hub administrator or an owner of this app.'
    },
    deps.notify
  )
  return { ...state, max_noticed_at: new Date(now).toISOString() }
}

/** One stack: judge every rule, start one change when one is due. */
export async function evaluateTarget(
  kind: TargetKind,
  id: number,
  deps: TickDeps = {}
): Promise<'started' | 'skipped' | 'held' | 'none'> {
  const now = (deps.now ?? Date.now)()
  const t = await readTarget(kind, id, deps.health)
  if (!t || t.unusable) return 'none'
  const all = (await readRoles(kind, id)).filter(
    (r) =>
      r.auto?.enabled && !r.pinned && isScalable(r.role) && t.roles.some((x) => x.role === r.role)
  )
  // A rule that paused itself waits for Resume rule.
  const roles = all.filter((r) => !r.state.paused_at)
  if (!roles.length) return 'none'

  // Backoff: failed automatic runs in a row (since the last Resume rule) wait 10, then 20
  // minutes; the third pauses every rule of the stack, with ONE notice.
  const since =
    roles
      .map((r) => r.state.resumed_at)
      .filter((x): x is string => !!x)
      .sort()
      .pop() ?? null
  const failed = await autoFailures(kind, id, since)
  if (failed.count >= PAUSE_AFTER_FAILURES) {
    const text = `Autoscaling stopped after ${failed.count} failed changes in a row (${failed.code ?? 'error'}).`
    for (const r of roles)
      await saveState(kind, id, r.role, {
        ...r.state,
        paused_at: new Date(now).toISOString(),
        paused_reason: text
      })
    await logSkip(t, 'RULE_PAUSED', text, {}, now)
    await noticePaused(t, text, deps)
    return 'skipped'
  }
  if (failed.count > 0 && failed.last_at) {
    const wait = BACKOFF_MIN[Math.min(failed.count, BACKOFF_MIN.length) - 1] * 60_000
    if (now - Date.parse(failed.last_at) < wait) return 'held'
  }

  const pauses = await scalePauses(t, 'auto', { ...deps, at: now })
  if (pauses.blockers.length) {
    // Paused: no figures read, no counter moves; only the at-max notice time is kept, so a
    // long pause never repeats it.
    for (const r of roles) {
      if (maxHits24h(r.state, now) < MAX_HITS_WARN) continue
      const next = await noticeMax(t, r.role, r.state, now, deps)
      if (next.max_noticed_at !== r.state.max_noticed_at)
        await saveState(kind, id, r.role, { ...r.state, max_noticed_at: next.max_noticed_at })
    }
    const b = pauses.blockers[0]
    return (await logSkip(t, b.code, `Autoscaling paused: ${b.text}`, {}, now)) ? 'skipped' : 'held'
  }
  const figures = await readScaleFigures(t, deps.readUsage)
  const changes: RoleChangeInput[] = []
  const reasons: string[] = []
  const figs: Record<string, unknown> = { at: figures.at, partial: figures.partial, roles: {} }
  /** Each role's next state; a role that wants a change keeps its old state until it starts. */
  const holds: Array<{ role: (typeof roles)[number]['role']; state: AutoState }> = []
  const moving: Array<{ role: (typeof roles)[number]['role']; state: AutoState }> = []
  let source: 'auto' | 'schedule' = 'auto'
  for (const r of roles) {
    const current = t.roles.find((x) => x.role === r.role)?.replicas ?? 0
    const d = decide({
      rule: r.auto as NonNullable<typeof r.auto>,
      role: r.role,
      state: r.state,
      current,
      figures: figures.byRole[r.role] ?? {},
      now
    })
    ;(figs.roles as Record<string, unknown>)[r.role] = figures.byRole[r.role] ?? {}
    let next = d.state
    if (d.past_max) next = await noticeMax(t, r.role, next, now, deps)
    if (d.action === 'hold') {
      holds.push({ role: r.role, state: next })
      continue
    }
    changes.push({ role: r.role, replicas: d.to })
    reasons.push(`${r.role} ${current} → ${d.to}: ${d.reason}`)
    if (!d.metric && /schedule/i.test(d.reason)) source = 'schedule'
    moving.push({ role: r.role, state: next })
  }
  for (const h of holds) await saveState(kind, id, h.role, h.state)
  if (!changes.length) return 'held'
  const reason = reasons.join(' · ').slice(0, 500)
  const plan = await planScale(t, changes, 'auto', { ...deps, at: now })
  if (plan.blockers.length) {
    const b = plan.blockers[0]
    await logSkip(
      t,
      b.code,
      `${b.text} — wanted: ${reason}`,
      { ...figs, connections: plan.connections },
      now
    )
    return 'skipped'
  }
  try {
    await startScale(
      kind,
      id,
      { roles: changes },
      { by: null, source, reason, figures: { ...figs, connections: plan.connections } },
      deps
    )
    // Started: each moving role's counters reset and its cooldown starts now.
    for (const m of moving) await saveState(kind, id, m.role, m.state)
    return 'started'
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    await logSkip(
      t,
      typeof code === 'string' ? code : 'START_FAILED',
      `${(err as Error)?.message ?? 'The change could not start.'} — wanted: ${reason}`,
      figs,
      now
    )
    return 'skipped'
  }
}

export async function scaleTick(deps: TickDeps = {}): Promise<TickResult> {
  const out: TickResult = {
    resumed: 0,
    evaluated: 0,
    started: 0,
    skipped: 0,
    targets: 0,
    errors: []
  }
  try {
    out.resumed = await resumeStaleRuns(deps)
  } catch (err) {
    out.errors.push(`resume: ${(err as Error)?.message ?? 'error'}`)
  }
  const tickDeps: TickDeps = { ...deps, loadCache: deps.loadCache ?? new Map() }
  const targets = await ruledTargets()
  out.targets = targets.length
  for (const t of targets) {
    try {
      const r = await evaluateTarget(t.kind, t.id, tickDeps)
      if (r !== 'none') out.evaluated++
      if (r === 'started') out.started++
      if (r === 'skipped') out.skipped++
    } catch (err) {
      out.errors.push(`${t.kind}:${t.id}: ${(err as Error)?.message ?? 'error'}`.slice(0, 200))
    }
  }
  return out
}

/** For the readiness check and the scaling view: roles whose rule hit its max ≥ 3 times in 24 h. */
export async function maxedRoles(
  now = Date.now()
): Promise<Array<{ kind: TargetKind; id: number; role: string; hits: number }>> {
  if (!(await db.schema.hasTable(SCALE_ROLES))) return []
  const rows = (await db(SCALE_ROLES)
    .whereNotNull('auto')
    .select('target_kind', 'target_id')) as Array<{
    target_kind: string
    target_id: number
  }>
  const seen = new Set<string>()
  const out: Array<{ kind: TargetKind; id: number; role: string; hits: number }> = []
  for (const r of rows) {
    const k = `${r.target_kind}:${r.target_id}`
    if (seen.has(k) || (r.target_kind !== 'environment' && r.target_kind !== 'shared')) continue
    seen.add(k)
    for (const role of await readRoles(r.target_kind as TargetKind, Number(r.target_id))) {
      if (!role.auto?.enabled) continue
      const hits = maxHits24h(role.state, now)
      if (hits >= MAX_HITS_WARN)
        out.push({
          kind: r.target_kind as TargetKind,
          id: Number(r.target_id),
          role: role.role,
          hits
        })
    }
  }
  return out
}

export { METRIC_WORDS }
