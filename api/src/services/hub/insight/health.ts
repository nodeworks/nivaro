import { db } from '../../../db/index.js'
import { samplesSince } from '../capacity/store.js'
import { lastDone } from '../data/runs.js'
import { buildFleet, type FleetRow } from '../fleet/fleet.js'
import { type InventoryItem, secretInventory } from '../ops/secrets.js'
import { appEnvironments, productionMap } from '../owner-access.js'
import {
  HEALTH_PARTS,
  type HealthPart,
  type InsightSettings,
  loadInsightSettings
} from './settings.js'

/**
 * Hub health score (enhancement 38): one 0–100 figure per environment, from figures other Hub
 * features already keep — it never probes, reads a link or recomputes them:
 *
 *   uptime     the fleet's 30-day uptime (hub-fleet-probe samples; 24 h when 30 d is unknown)
 *   errors     errors / requests over the last 24 h of capacity samples (hub capacity)
 *   drift      the fleet's open drift alerts for the environment
 *   issues     the open issue count the hub link last reported (fleet status)
 *   readiness  the readiness score the hub link last reported (fleet status)
 *   backups    age of the newest Hub database backup or recorded sighting (Backups & data);
 *              counted for production environments (THE production rule) and environments with
 *              a database backup policy — elsewhere "no backup" is not a fault
 *   secrets    the rotation state of the environment's secrets (Secrets): overdue / due soon
 *   incidents  open Hub incidents on the environment or the whole app (Incidents): the worst
 *              severity counts — sev1 0, sev2 40, sev3 70, none 100
 *
 * A part with no figure is left out and the weights of the others are scaled up (a new or
 * watch-only environment is not punished for what the Hub cannot see); no part at all = no score.
 * Weights (0–10) live in the insight settings. The daily job (hub-insight-health) stores the
 * score per environment per UTC day for the trend; reads compute the current one.
 */

export interface HealthInputs {
  /** Percent, 0–100. */
  uptime: number | null
  /** Fraction of requests that failed, 0–1. */
  error_rate: number | null
  drift_alerts: number | null
  open_issues: number | null
  /** 0–100. */
  readiness: number | null
  /** Hours since the newest backup; null = none known. */
  backup_age_h: number | null
  /** Whether a missing backup counts against the score (production, or a backup policy). */
  backup_expected: boolean
  secrets: { overdue: number; due_soon: number; scheduled: number } | null
  /** Open incidents on the environment or app-wide, by severity; null = unknown. */
  incidents: { sev1: number; sev2: number; sev3: number } | null
}

export interface PartScore {
  part: HealthPart
  /** 0–100, or null when the Hub has no figure for it. */
  score: number | null
  weight: number
  /** The figure the score came from, in words (`99.95 % over 30 days`). */
  figure: string | null
}

export type HealthBand = 'good' | 'fair' | 'poor'

export interface HealthScore {
  score: number | null
  band: HealthBand | null
  parts: PartScore[]
}

const clamp = (n: number) => Math.max(0, Math.min(100, n))
/** 100 at `good`, 0 at `bad`, linear between (works either direction). */
const linear = (v: number, good: number, bad: number) =>
  Math.round(clamp(((v - bad) / (good - bad)) * 100))

const pct = (n: number, d = 2) => `${Number(n.toFixed(d))} %`

/** One part's score and the words for its figure. Pure. */
export function partScore(
  part: HealthPart,
  i: HealthInputs
): { score: number | null; figure: string | null } {
  switch (part) {
    case 'uptime':
      return i.uptime == null
        ? { score: null, figure: null }
        : { score: linear(i.uptime, 99.9, 95), figure: `${pct(i.uptime)} up` }
    case 'errors':
      return i.error_rate == null
        ? { score: null, figure: null }
        : {
            score: linear(i.error_rate, 0.001, 0.05),
            figure: `${pct(i.error_rate * 100)} of requests failed`
          }
    case 'drift': {
      if (i.drift_alerts == null) return { score: null, figure: null }
      const n = i.drift_alerts
      return {
        score: n === 0 ? 100 : n === 1 ? 60 : n === 2 ? 30 : 0,
        figure: n === 0 ? 'No drift alerts' : `${n} open drift alert${n === 1 ? '' : 's'}`
      }
    }
    case 'issues': {
      if (i.open_issues == null) return { score: null, figure: null }
      const n = i.open_issues
      return {
        score: clamp(100 - 5 * n),
        figure: n === 0 ? 'No open issues' : `${n} open issue${n === 1 ? '' : 's'}`
      }
    }
    case 'readiness':
      return i.readiness == null
        ? { score: null, figure: null }
        : { score: Math.round(clamp(i.readiness)), figure: `Readiness ${Math.round(i.readiness)}` }
    case 'backups': {
      if (i.backup_age_h == null)
        return i.backup_expected
          ? { score: 0, figure: 'No backup recorded' }
          : { score: null, figure: null }
      const h = i.backup_age_h
      const words = h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`
      return { score: linear(h, 26, 168), figure: `Last backup ${words} ago` }
    }
    case 'secrets': {
      const s = i.secrets
      if (!s || (s.scheduled === 0 && s.overdue === 0 && s.due_soon === 0))
        return { score: null, figure: null }
      if (s.overdue > 0)
        return { score: 0, figure: `${s.overdue} secret${s.overdue === 1 ? '' : 's'} overdue` }
      if (s.due_soon > 0)
        return { score: 60, figure: `${s.due_soon} secret${s.due_soon === 1 ? '' : 's'} due soon` }
      return { score: 100, figure: 'Secrets rotated on time' }
    }
    case 'incidents': {
      const c = i.incidents
      if (!c) return { score: null, figure: null }
      const n = c.sev1 + c.sev2 + c.sev3
      if (n === 0) return { score: 100, figure: 'No open incidents' }
      const worst = c.sev1 ? 'sev1' : c.sev2 ? 'sev2' : 'sev3'
      return {
        score: c.sev1 ? 0 : c.sev2 ? 40 : 70,
        figure: `${n} open incident${n === 1 ? '' : 's'} (worst ${worst})`
      }
    }
  }
}

export function bandOf(score: number | null): HealthBand | null {
  if (score == null) return null
  return score >= 90 ? 'good' : score >= 70 ? 'fair' : 'poor'
}

/** The weighted score over the parts the Hub has a figure for. Pure. */
export function healthScore(
  inputs: HealthInputs,
  weights: Record<HealthPart, number>
): HealthScore {
  const parts: PartScore[] = HEALTH_PARTS.map((part) => ({
    part,
    weight: weights[part] ?? 0,
    ...partScore(part, inputs)
  }))
  let sum = 0
  let w = 0
  for (const p of parts) {
    if (p.score == null || p.weight <= 0) continue
    sum += p.score * p.weight
    w += p.weight
  }
  const score = w > 0 ? Math.round(sum / w) : null
  return { score, band: bandOf(score), parts }
}

// ─── Gathering the inputs (Hub tables only) ─────────────────────────────────────────────────

export interface EnvHealth extends HealthScore {
  app_id: number
  app_key: string
  app_name: string
  environment_id: number
  env_key: string
  production: boolean
  /** Daily stored scores, oldest first (≤ 30 days). */
  trend: Array<{ day: string; score: number | null }>
}

const DAY_MS = 86_400_000

const dateOf = (v: unknown): Date | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d : null
}

/** Errors / requests per environment over the samples (environment scope only). Pure. */
export function errorRates(
  samples: Array<{
    environment_id: number | null
    requests_per_min: number | null
    errors_per_min: number | null
  }>
): Map<number, number> {
  const acc = new Map<number, { req: number; err: number }>()
  for (const s of samples) {
    if (s.environment_id == null || s.requests_per_min == null) continue
    const a = acc.get(s.environment_id) ?? { req: 0, err: 0 }
    a.req += s.requests_per_min
    a.err += s.errors_per_min ?? 0
    acc.set(s.environment_id, a)
  }
  const out = new Map<number, number>()
  for (const [id, a] of acc) if (a.req > 0) out.set(id, Math.min(1, a.err / a.req))
  return out
}

/** Overdue / due-soon / scheduled counts of each environment's secrets. Pure. */
export function secretCounts(items: InventoryItem[]): Map<number, HealthInputs['secrets']> {
  const out = new Map<number, { overdue: number; due_soon: number; scheduled: number }>()
  for (const it of items) {
    if (it.env_id == null) continue
    const c = out.get(it.env_id) ?? { overdue: 0, due_soon: 0, scheduled: 0 }
    if (it.due === 'overdue') c.overdue++
    else if (it.due === 'due_soon') c.due_soon++
    else if (it.due === 'ok') c.scheduled++
    out.set(it.env_id, c)
  }
  return out
}

/** Open incidents per environment: an app-wide one counts on every environment of the app. */
export function incidentCounts(
  open: Array<{ app_id: number; environment_id: number | null; severity: string }>,
  envs: Array<{ app_id: number; environment_id: number }>
): Map<number, NonNullable<HealthInputs['incidents']>> {
  const out = new Map<number, { sev1: number; sev2: number; sev3: number }>()
  for (const e of envs) out.set(e.environment_id, { sev1: 0, sev2: 0, sev3: 0 })
  for (const i of open) {
    const sev = i.severity === 'sev1' ? 'sev1' : i.severity === 'sev2' ? 'sev2' : 'sev3'
    for (const e of envs) {
      if (e.app_id !== i.app_id) continue
      if (i.environment_id != null && i.environment_id !== e.environment_id) continue
      const c = out.get(e.environment_id)
      if (c) c[sev]++
    }
  }
  return out
}

export interface HealthDeps {
  fleet?: (who: { userId: string; isAdmin: boolean }) => Promise<{ rows: FleetRow[] }>
  secrets?: () => Promise<InventoryItem[]>
  incidents?: () => Promise<
    Array<{ app_id: number; environment_id: number | null; severity: string }>
  >
  settings?: InsightSettings
  now?: Date
}

/** Inputs for each fleet row the viewer may see (same scoping as the fleet page). */
export async function gatherHealthInputs(
  who: { userId: string; isAdmin: boolean },
  deps: HealthDeps = {}
): Promise<Array<{ row: FleetRow; inputs: HealthInputs; production: boolean }>> {
  const now = deps.now ?? new Date()
  const fleet = await (deps.fleet ?? ((w) => buildFleet(w, { now })))(who)
  const rows = fleet.rows.filter((r) => r.env_status !== 'archived')
  if (!rows.length) return []
  const envIds = rows.map((r) => r.environment_id)

  const errors = errorRates(await samplesSince(new Date(now.getTime() - DAY_MS), { envIds }))
  let secrets = new Map<number, HealthInputs['secrets']>()
  try {
    secrets = secretCounts(await (deps.secrets ?? (() => secretInventory(now)))())
  } catch {
    // The inventory reads Hub tables only; if it fails the part is simply unknown.
  }

  const policies = new Set<number>()
  try {
    const rows2 = (await db('nivaro_hub_backup_policies')
      .whereIn('environment_id', envIds)
      .where('db_enabled', true)
      .select('environment_id')) as Array<{ environment_id: number }>
    for (const r of rows2) policies.add(Number(r.environment_id))
  } catch {
    // No backup policies table (an old Hub): only production expects a backup.
  }

  let incidents: Map<number, NonNullable<HealthInputs['incidents']>> | null = null
  try {
    const open = await (deps.incidents ?? defaultOpenIncidents)()
    incidents = incidentCounts(open, rows)
  } catch {
    // No incident tables (an old Hub): the part is unknown and left out.
    incidents = null
  }

  const production = new Map<number, boolean>()
  for (const appId of [...new Set(rows.map((r) => r.app_id))]) {
    const map = productionMap(await appEnvironments(appId))
    for (const [id, p] of map) production.set(id, p)
  }

  const out: Array<{ row: FleetRow; inputs: HealthInputs; production: boolean }> = []
  for (const row of rows) {
    const id = row.environment_id
    let backupAt: Date | null = null
    try {
      const hub = await lastDone(id, 'db_backup')
      const seen = await lastDone(id, 'backup_seen')
      const candidates = [
        dateOf(hub?.artifact?.finished_at ?? hub?.finished_at),
        dateOf(seen?.result?.at ?? seen?.finished_at)
      ].filter((d): d is Date => !!d)
      backupAt = candidates.sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    } catch {
      backupAt = null
    }
    const isProd = production.get(id) ?? true
    out.push({
      row,
      production: isProd,
      inputs: {
        uptime: row.uptime_30d ?? row.uptime_24h,
        error_rate: errors.get(id) ?? null,
        drift_alerts: row.alerts.length,
        open_issues: row.open_issues,
        readiness: row.readiness_score,
        backup_age_h: backupAt
          ? Math.max(0, (now.getTime() - backupAt.getTime()) / 3_600_000)
          : null,
        backup_expected: isProd || policies.has(id),
        secrets: secrets.get(id) ?? null,
        incidents: incidents ? (incidents.get(id) ?? null) : null
      }
    })
  }
  return out
}

async function defaultOpenIncidents() {
  const { openIncidents } = await import('../incident/store.js')
  return (await openIncidents()).map((i) => ({
    app_id: Number(i.app_id),
    environment_id: i.environment_id == null ? null : Number(i.environment_id),
    severity: String(i.severity)
  }))
}

/** The stored daily scores of these environments since `days` ago, oldest first. */
export async function scoreTrend(
  envIds: number[],
  days: number,
  now = new Date()
): Promise<Map<number, Array<{ day: string; score: number | null }>>> {
  const out = new Map<number, Array<{ day: string; score: number | null }>>()
  if (!envIds.length) return out
  const since = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10)
  for (let i = 0; i < envIds.length; i += 500) {
    const rows = (await db('nivaro_hub_health_scores')
      .whereIn('environment_id', envIds.slice(i, i + 500))
      .where('day', '>=', since)
      .orderBy('day', 'asc')
      .select('environment_id', 'day', 'score')) as Array<Record<string, unknown>>
    for (const r of rows) {
      const id = Number(r.environment_id)
      const list = out.get(id) ?? []
      list.push({ day: String(r.day), score: r.score == null ? null : Number(r.score) })
      out.set(id, list)
    }
  }
  return out
}

/** The current health of every environment the viewer may see, with its 30-day trend. */
export async function currentHealth(
  who: { userId: string; isAdmin: boolean },
  deps: HealthDeps = {}
): Promise<EnvHealth[]> {
  const settings = deps.settings ?? (await loadInsightSettings())
  const gathered = await gatherHealthInputs(who, deps)
  const trend = await scoreTrend(
    gathered.map((g) => g.row.environment_id),
    30,
    deps.now
  )
  return gathered.map(({ row, inputs, production }) => ({
    app_id: row.app_id,
    app_key: row.app_key,
    app_name: row.app_name,
    environment_id: row.environment_id,
    env_key: row.env_key,
    production,
    ...healthScore(inputs, settings.weights),
    trend: trend.get(row.environment_id) ?? []
  }))
}

/**
 * The daily job: stores every environment's current score under today's UTC day (the last run of
 * the day wins) and drops stored days older than 400 days. Admin view = every environment.
 */
export async function storeDailyScores(deps: HealthDeps = {}): Promise<number> {
  const now = deps.now ?? new Date()
  const all = await currentHealth({ userId: '', isAdmin: true }, { ...deps, now })
  const day = now.toISOString().slice(0, 10)
  for (const h of all) {
    const row = {
      environment_id: h.environment_id,
      app_id: h.app_id,
      day,
      score: h.score,
      parts: JSON.stringify(
        h.parts.map((p) => ({ part: p.part, score: p.score, weight: p.weight }))
      ),
      computed_at: now
    }
    const hit = (await db('nivaro_hub_health_scores')
      .where({ environment_id: h.environment_id, day })
      .first('id')) as { id: number } | undefined
    if (hit) await db('nivaro_hub_health_scores').where({ id: hit.id }).update(row)
    else await db('nivaro_hub_health_scores').insert(row)
  }
  const cutoff = new Date(now.getTime() - 400 * DAY_MS).toISOString().slice(0, 10)
  await db('nivaro_hub_health_scores').where('day', '<', cutoff).delete()
  return all.length
}
