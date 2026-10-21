import { type PlanImpact, planImpact } from './ai-plan-impact.js'
import type { PlanDoc, PlanStepDef } from './ai-plan-runner.js'

/**
 * Plan REVIEW figures for "Let AI do this" (#2863): how long the plan will
 * take to run, what each step touches, how risky it is and which steps can
 * never be rolled back. Pure — everything is read off the step previews
 * (built AS THE PERSON when the plan was proposed) plus, when available,
 * how long recent executed plans took per step kind.
 */

/** Steps whose effect leaves the system (a message, a chat post, a flow, a
 *  task someone is told about) — nothing on disk to revert. */
const IRREVERSIBLE: Record<string, string> = {
  send_message: 'notifications cannot be unsent',
  post_chat: 'a chat post cannot be unsent',
  run_flow: 'a flow may call other systems and send mail',
  create_task: 'the assignee is told about the task',
  create_dashboard: 'nothing is captured to revert'
}

/** Seconds per step, plus seconds per record it acts on — the stated defaults. */
const DEFAULT_SECONDS: Record<string, { base: number; per: number }> = {
  bulk_update: { base: 2, per: 0.35 },
  integrity_fix: { base: 2, per: 0.5 },
  create_record: { base: 3, per: 0 },
  create_task: { base: 2, per: 0 },
  create_dashboard: { base: 3, per: 0 },
  send_message: { base: 2, per: 1.2 },
  post_chat: { base: 2, per: 0 },
  run_flow: { base: 15, per: 0 }
}
const FALLBACK_SECONDS = { base: 5, per: 0.5 }
const MIN_SAMPLES = 3

export type RiskLevel = 'low' | 'medium' | 'high'

export interface StepTouches {
  step_id: string
  n: number
  kind: string
  collection: string | null
  records: number
  /** Field → the value the step writes (old → new when the preview carries it). */
  fields: Array<{ field: string; from?: unknown; to: unknown }>
  /** People notified (messages, chat posts, tasks). */
  people: number
  external: boolean
  email: boolean
  irreversible: string | null
}

export interface RecentDurations {
  /** step kind → seconds per record (median over recent done steps). */
  per_record: Record<string, number>
  samples: number
}

export interface PlanEstimate {
  run_seconds: number
  /** 'recent runs' when enough executed steps backed the figure. */
  run_basis: 'recent runs' | 'default'
  /** The model's guess of hands-on minutes saved — always labelled an estimate. */
  hands_on_minutes: number | null
}

export interface PlanRisk {
  level: RiskLevel
  reasons: string[]
  irreversible: Array<{ n: number; title: string; why: string }>
  records: number
  collections: number
}

export interface PlanReview {
  touches: StepTouches[]
  estimate: PlanEstimate
  risk: PlanRisk
  impact: PlanImpact
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function collectionOf(step: PlanStepDef): string | null {
  const p = step.preview ?? {}
  const c = p.collection ?? step.targets?.collection ?? step.payload?.collection
  return c ? String(c) : null
}

/** Field changes from a preview: `changes` is field → new value; `before` /
 *  `current` (field → old value) is used when a kind provides it. */
function fieldsOf(step: PlanStepDef): StepTouches['fields'] {
  const p = step.preview ?? {}
  const changes =
    p.changes && typeof p.changes === 'object' ? (p.changes as Record<string, unknown>) : null
  if (!changes) return []
  const before = (p.before ?? p.current) as Record<string, unknown> | undefined
  return Object.entries(changes)
    .slice(0, 12)
    .map(([field, to]) =>
      before && typeof before === 'object' && field in before
        ? { field, from: before[field], to }
        : { field, to }
    )
}

export function stepTouches(step: PlanStepDef): StepTouches {
  const p = step.preview ?? {}
  const count = num(p.count)
  const base: StepTouches = {
    step_id: step.id,
    n: step.n,
    kind: step.kind,
    collection: collectionOf(step),
    records: 0,
    fields: [],
    people: 0,
    external: false,
    email: false,
    irreversible: IRREVERSIBLE[step.kind] ?? null
  }
  switch (step.kind) {
    case 'bulk_update':
    case 'integrity_fix':
      base.records = step.targets?.ids?.length || count
      base.fields = fieldsOf(step)
      break
    case 'create_record':
      base.records = 1
      base.fields = fieldsOf(step)
      break
    case 'send_message':
      base.people = count || (p.recipients as unknown[] | undefined)?.length || 0
      base.email = true
      break
    case 'post_chat':
      base.people = count
      break
    case 'create_task':
      base.people = 1
      break
    case 'run_flow':
      base.external = true
      break
    default:
      // A kind registered later: count what it targets, treat as irreversible
      // unless it says otherwise — the safe reading for a reviewer.
      base.records = step.targets?.ids?.length || count
      if (!(step.kind in IRREVERSIBLE)) base.irreversible = 'this kind of step cannot be undone'
  }
  return base
}

/** Median seconds per record for every step kind in recent executed plans. */
export function recentDurations(docs: PlanDoc[]): RecentDurations {
  const byKind = new Map<string, number[]>()
  let samples = 0
  for (const doc of docs) {
    for (const step of doc.steps) {
      const st = doc.state.find((x) => x.id === step.id)
      if (st?.status !== 'done' || !st.started_at || !st.finished_at) continue
      const ms = new Date(st.finished_at).getTime() - new Date(st.started_at).getTime()
      if (!Number.isFinite(ms) || ms < 0) continue
      const per = ms / 1000 / Math.max(1, st.records_changed || 0)
      byKind.set(step.kind, [...(byKind.get(step.kind) ?? []), per])
      samples++
    }
  }
  const per_record: Record<string, number> = {}
  for (const [kind, list] of byKind) {
    if (list.length < MIN_SAMPLES) continue
    const sorted = [...list].sort((a, b) => a - b)
    per_record[kind] = sorted[Math.floor(sorted.length / 2)]
  }
  return { per_record, samples }
}

export function estimateRunTime(
  steps: PlanStepDef[],
  recent: RecentDurations | null,
  handsOnMinutes: number | null
): PlanEstimate {
  let seconds = 0
  let fromRecent = 0
  for (const step of steps) {
    const t = stepTouches(step)
    const units = Math.max(1, t.records || t.people || 1)
    const d = DEFAULT_SECONDS[step.kind] ?? FALLBACK_SECONDS
    const perRecent = recent?.per_record[step.kind]
    if (perRecent != null) {
      seconds += Math.max(d.base, perRecent * units)
      fromRecent++
    } else {
      seconds += d.base + d.per * units
    }
  }
  return {
    run_seconds: Math.ceil(seconds),
    run_basis: steps.length > 0 && fromRecent === steps.length ? 'recent runs' : 'default',
    hands_on_minutes:
      handsOnMinutes != null && Number.isFinite(handsOnMinutes) && handsOnMinutes > 0
        ? Math.min(Math.round(handsOnMinutes), 60 * 24)
        : null
  }
}

/** Low / medium / high from records changed, irreversible steps, deletes and
 *  cross-collection fan-out — each reason named for the reviewer. */
export function riskOf(steps: PlanStepDef[], impact = planImpact(steps)): PlanRisk {
  const touches = steps.map(stepTouches)
  const irreversible = touches
    .filter((t) => t.irreversible)
    .map((t) => {
      const step = steps.find((s) => s.id === t.step_id)!
      return { n: t.n, title: step.title, why: t.irreversible as string }
    })
  const deletes = steps.filter((s) => /delete|remove|purge/i.test(s.kind)).length
  const records = impact.records + impact.created
  const collections = impact.collections.length
  const reasons: string[] = []
  let level: RiskLevel = 'low'
  const bump = (to: RiskLevel, why: string) => {
    reasons.push(why)
    if (to === 'high' || (to === 'medium' && level === 'low')) level = to
  }
  if (deletes > 0) bump('high', `${deletes} step${deletes === 1 ? '' : 's'} delete records`)
  if (records > 50) bump('high', `changes ${records.toLocaleString('en-US')} records`)
  else if (records > 10) bump('medium', `changes ${records} records`)
  if (collections >= 3) bump('high', `writes to ${collections} collections`)
  else if (collections === 2) bump('medium', 'writes to 2 collections')
  if (irreversible.length > 0) {
    const people = touches.reduce((n, t) => n + t.people, 0)
    bump(
      people > 10 ? 'high' : 'medium',
      `${irreversible.length} step${irreversible.length === 1 ? '' : 's'} cannot be rolled back${people ? ` (${people} ${people === 1 ? 'person' : 'people'} told)` : ''}`
    )
  }
  return { level, reasons, irreversible, records, collections }
}

export function reviewPlan(
  steps: PlanStepDef[],
  recent: RecentDurations | null,
  handsOnMinutes: number | null
): PlanReview {
  const impact = planImpact(steps)
  return {
    touches: steps.map(stepTouches).sort((a, b) => a.n - b.n),
    estimate: estimateRunTime(steps, recent, handsOnMinutes),
    risk: riskOf(steps, impact),
    impact
  }
}
