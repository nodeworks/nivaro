import { db } from '../../../db/index.js'
import { USAGE_FLOOR_MIN } from '../../hub-link/insight-report.js'
import {
  type LinkReadDeps,
  type LinkReadResult,
  type OpsEnvTarget,
  opsTargets,
  readOps
} from '../ops/link-read.js'
import { type InsightSettings, loadInsightSettings } from './settings.js'

/**
 * Hub insight collect (cron hub-insight-collect, daily; or Collect now): reads every active
 * environment's usage counts and dependency hosts over the link the Hub already has to it
 * (services/hub/ops/link-read.ts — hub link, or the shared deployment's link) and keeps them in
 * nivaro_hub_usage_days / _usage_screens / _dependencies. The Hub never holds more than the app
 * sent, and it re-checks what arrives: a bucket under the privacy floor is dropped here too (an
 * old or misbehaving app cannot push one past the Hub), a screen must be a route pattern, a
 * dependency target a bare host.
 *
 * At most 4 environments at once, 10 s per read, nothing new started after 20 minutes.
 */

export const COLLECT_CONCURRENCY = 4
export const COLLECT_BUDGET_MS = 20 * 60_000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const HOST_RE = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/
const EXT_RE = /^[A-Za-z0-9@/._-]{1,100}$/
export const DEP_KINDS = [
  'partner_api',
  'webhook',
  'mail',
  'signin',
  'tracker',
  'extension'
] as const

const intOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** A figure the Hub may keep: null, 0, or at least the floor. */
const floorOk = (n: number | null, floor: number) => (n == null || n === 0 || n >= floor ? n : null)

export interface ParsedUsage {
  days: Array<{ day: string; people: number | null; views: number | null; under_floor: boolean }>
  screens: Array<{ route: string; people: number; views: number }>
  people_7d: number | null
  people_window: number | null
  accounts: number | null
  screens_hidden: number | null
  period_days: number
}

/** What the Hub keeps of an app's usage answer (null = not a usage answer). Pure. */
export function parseUsage(body: unknown, minFloor = USAGE_FLOOR_MIN): ParsedUsage | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.daily)) return null
  // The app's floor, never below the Hub's own.
  const floor = Math.max(minFloor, intOrNull(b.floor) ?? minFloor)
  const days: ParsedUsage['days'] = []
  for (const d of b.daily.slice(0, 400)) {
    const r = (d ?? {}) as Record<string, unknown>
    if (typeof r.day !== 'string' || !DAY_RE.test(r.day)) continue
    const people = intOrNull(r.people)
    const under = r.under_floor === true || (people != null && people > 0 && people < floor)
    days.push({
      day: r.day,
      people: under ? null : people,
      views: under ? null : intOrNull(r.views),
      under_floor: under
    })
  }
  const screens: ParsedUsage['screens'] = []
  let dropped = 0
  for (const s of Array.isArray(b.screens) ? b.screens.slice(0, 50) : []) {
    const r = (s ?? {}) as Record<string, unknown>
    const people = intOrNull(r.people)
    const route = typeof r.route === 'string' ? r.route.trim() : ''
    if (!route.startsWith('/') || route.length > 300 || /[?#\s]/.test(route) || people == null) {
      dropped++
      continue
    }
    if (people < floor) {
      dropped++
      continue
    }
    screens.push({ route, people, views: intOrNull(r.views) ?? 0 })
  }
  const hidden = intOrNull(b.screens_hidden)
  return {
    days,
    screens: screens.slice(0, 25),
    people_7d: floorOk(intOrNull(b.people_7d), floor),
    people_window: floorOk(intOrNull(b.people_window), floor),
    accounts: floorOk(intOrNull(b.accounts), floor),
    screens_hidden: hidden == null ? (dropped ? dropped : null) : hidden + dropped,
    period_days: Math.max(1, Math.min(90, intOrNull(b.days) ?? days.length ?? 1))
  }
}

export interface ParsedDependency {
  kind: (typeof DEP_KINDS)[number]
  target: string
  label: string | null
  detail: string | null
}

/** What the Hub keeps of an app's dependency answer: hosts and extension ids only. Pure. */
export function parseDependencies(body: unknown): ParsedDependency[] | null {
  if (!body || typeof body !== 'object') return null
  const list = (body as { dependencies?: unknown }).dependencies
  if (!Array.isArray(list)) return null
  const out: ParsedDependency[] = []
  const seen = new Set<string>()
  for (const raw of list.slice(0, 1000)) {
    const r = (raw ?? {}) as Record<string, unknown>
    const kind = r.kind as ParsedDependency['kind']
    if (!(DEP_KINDS as readonly string[]).includes(String(kind))) continue
    const target = typeof r.target === 'string' ? r.target.trim() : ''
    const ok = kind === 'extension' ? EXT_RE.test(target) : HOST_RE.test(target.toLowerCase())
    if (!ok) continue
    const t = kind === 'extension' ? target : target.toLowerCase()
    const label =
      typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 200) : null
    const count = intOrNull(r.count)
    const parts = [
      r.enabled === false ? 'off' : null,
      count != null && count > 1 ? `${count} configs` : null
    ].filter(Boolean)
    const key = `${kind}|${t}|${label ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, target: t, label, detail: parts.length ? parts.join(', ') : null })
  }
  return out
}

async function upsertState(envId: number, patch: Record<string, unknown>): Promise<void> {
  const hit = (await db('nivaro_hub_insight_state').where({ environment_id: envId }).first('id')) as
    | { id: number }
    | undefined
  if (hit) await db('nivaro_hub_insight_state').where({ id: hit.id }).update(patch)
  else await db('nivaro_hub_insight_state').insert({ environment_id: envId, ...patch })
}

export async function storeUsage(
  envId: number,
  appId: number,
  u: ParsedUsage,
  now: Date
): Promise<void> {
  for (const d of u.days) {
    const row = {
      environment_id: envId,
      app_id: appId,
      day: d.day,
      people: d.people,
      views: d.views,
      under_floor: d.under_floor,
      collected_at: now
    }
    const hit = (await db('nivaro_hub_usage_days')
      .where({ environment_id: envId, day: d.day })
      .first('id')) as { id: number } | undefined
    if (hit) await db('nivaro_hub_usage_days').where({ id: hit.id }).update(row)
    else await db('nivaro_hub_usage_days').insert(row)
  }
  await db('nivaro_hub_usage_screens').where({ environment_id: envId }).delete()
  if (u.screens.length)
    await db('nivaro_hub_usage_screens').insert(
      u.screens.map((s) => ({
        environment_id: envId,
        route: s.route,
        people: s.people,
        views: s.views,
        period_days: u.period_days,
        collected_at: now
      }))
    )
}

export async function storeDependencies(
  envId: number,
  deps: ParsedDependency[],
  now: Date
): Promise<void> {
  await db('nivaro_hub_dependencies').where({ environment_id: envId, source: 'app' }).delete()
  for (let i = 0; i < deps.length; i += 100)
    await db('nivaro_hub_dependencies').insert(
      deps.slice(i, i + 100).map((d) => ({
        environment_id: envId,
        kind: d.kind,
        target: d.target,
        label: d.label,
        detail: d.detail,
        source: 'app',
        seen_at: now
      }))
    )
}

export interface CollectDeps extends LinkReadDeps {
  read?: (
    env: OpsEnvTarget,
    what: 'usage' | 'dependencies',
    q: Record<string, string>
  ) => Promise<LinkReadResult>
  settings?: InsightSettings
  now?: () => Date
}

export interface CollectSummary {
  environments: number
  usage_ok: number
  deps_ok: number
  skipped: number
}

/** One environment: both reads, stored; never throws (a failure is a state word). */
export async function collectEnvironment(
  env: OpsEnvTarget & { app_id: number },
  deps: CollectDeps = {}
): Promise<{ usage: string; deps: string }> {
  const settings = deps.settings ?? (await loadInsightSettings())
  const now = deps.now ? deps.now() : new Date()
  const read = deps.read ?? ((e, w, q) => readOps(e, w, q, deps))
  let usageState = 'failed'
  let depsState = 'failed'
  try {
    const res = await read(env, 'usage', {
      days: String(settings.usage.days),
      floor: String(settings.usage.floor)
    })
    usageState = res.state
    if (res.state === 'ok') {
      const parsed = parseUsage(res.body, settings.usage.floor)
      if (!parsed) usageState = 'failed'
      else {
        await storeUsage(env.id, env.app_id, parsed, now)
        await upsertState(env.id, {
          usage_state: 'ok',
          usage_at: now,
          people_7d: parsed.people_7d,
          people_window: parsed.people_window,
          accounts: parsed.accounts,
          screens_hidden: parsed.screens_hidden
        })
      }
    }
  } catch {
    usageState = 'failed'
  }
  if (usageState !== 'ok') await upsertState(env.id, { usage_state: usageState, usage_at: now })
  try {
    const res = await read(env, 'dependencies', {})
    depsState = res.state
    if (res.state === 'ok') {
      const parsed = parseDependencies(res.body)
      if (!parsed) depsState = 'failed'
      else await storeDependencies(env.id, parsed, now)
    }
  } catch {
    depsState = 'failed'
  }
  await upsertState(env.id, { deps_state: depsState, deps_at: now })
  return { usage: usageState, deps: depsState }
}

/** Every active environment (or the ones named), at most COLLECT_CONCURRENCY at once. */
export async function runCollect(
  deps: CollectDeps & { envIds?: number[]; budgetMs?: number } = {}
): Promise<CollectSummary> {
  const started = Date.now()
  const budget = deps.budgetMs ?? COLLECT_BUDGET_MS
  const settings = deps.settings ?? (await loadInsightSettings())
  const q = db('nivaro_hub_environments').where({ status: 'active' }).select('id', 'app_id')
  if (deps.envIds?.length) q.whereIn('id', deps.envIds)
  const active = (await q) as Array<{ id: number; app_id: number }>
  const appOf = new Map(active.map((r) => [Number(r.id), Number(r.app_id)]))
  const targets = active.length ? await opsTargets([...appOf.keys()]) : []
  const summary: CollectSummary = { environments: 0, usage_ok: 0, deps_ok: 0, skipped: 0 }
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= targets.length) return
      if (Date.now() - started > budget) {
        summary.skipped++
        continue
      }
      const t = targets[i]
      const out = await collectEnvironment(
        { ...t, app_id: appOf.get(t.id) ?? 0 },
        { ...deps, settings }
      )
      summary.environments++
      if (out.usage === 'ok') summary.usage_ok++
      if (out.deps === 'ok') summary.deps_ok++
    }
  }
  await Promise.all(Array.from({ length: Math.min(COLLECT_CONCURRENCY, targets.length) }, worker))
  return summary
}

/** Daily prune: usage days older than 400 days; state/screens/dependencies of gone environments. */
export async function pruneInsight(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - 400 * 86_400_000).toISOString().slice(0, 10)
  await db('nivaro_hub_usage_days').where('day', '<', cutoff).delete()
  const live = new Set(
    ((await db('nivaro_hub_environments').select('id')) as Array<{ id: number }>).map((r) =>
      Number(r.id)
    )
  )
  for (const table of [
    'nivaro_hub_usage_screens',
    'nivaro_hub_dependencies',
    'nivaro_hub_insight_state',
    'nivaro_hub_usage_days',
    'nivaro_hub_health_scores'
  ]) {
    const ids = ((await db(table).distinct('environment_id')) as Array<{ environment_id: number }>)
      .map((r) => Number(r.environment_id))
      .filter((id) => !live.has(id))
    for (let i = 0; i < ids.length; i += 500)
      await db(table)
        .whereIn('environment_id', ids.slice(i, i + 500))
        .delete()
  }
}
