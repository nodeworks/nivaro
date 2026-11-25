import { db } from '../../../db/index.js'
import type { ReadinessRead } from '../move/gather.js'
import { readSharedReadiness } from '../move/gather.js'
import { openSecret } from '../secrets.js'
import { listShared, type SharedDeployment } from '../shared/store.js'
import { DAY_MS, shareOf, topShare } from './overview.js'
import { type CapacitySample, type CapacitySettings, readSettings, samplesSince } from './store.js'

/**
 * Nivaro Hub move advisor (idea 13): rules over the last 7 days of capacity samples that suggest
 *
 *  - fits_shared    a dedicated environment small and quiet enough for a shared deployment
 *                   (95th percentile of requests/min, memory and connections in use under the
 *                   thresholds, storage under its threshold) whose own shared-readiness report
 *                   names no blocker feature;
 *  - outgrew_shared an environment on a shared deployment whose share of the deployment's
 *                   requests, answering time or connections stayed over `outgrew.share` in at
 *                   least `outgrew.sustained` of the rounds (deployment serving two apps or more),
 *                   or whose requests/min 95th percentile passed `outgrew.max_rpm`.
 *
 * Every suggestion carries its reasons (each check with its figure and threshold) and a link to
 * the app's Move panel pre-filled with the target (a plan only: the person checks the plan and
 * starts the move there, or not). Nothing here starts, plans or changes anything.
 */

export type AdviceKind = 'fits_shared' | 'outgrew_shared'

export interface AdviceReason {
  code: string
  text: string
}

export interface Advice {
  env_id: number
  app_id: number | null
  app_key: string
  env_key: string
  kind: AdviceKind
  reasons: AdviceReason[]
  /** Where the move would go: a shared deployment, or a dedicated stack the person picks. */
  target: { kind: 'shared'; shared_id: number; key: string } | { kind: 'dedicated' }
  /** The admin path of the pre-filled move panel. */
  plan_path: string
}

export const ADVICE_DAYS = 7

/** The p-th percentile (0–1) of the numbers, nearest rank; null for none. */
export function percentile(xs: Array<number | null>, p: number): number | null {
  const real = xs.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
  if (!real.length) return null
  const i = Math.min(real.length - 1, Math.max(0, Math.ceil(p * real.length) - 1))
  return real[i]
}

const fmt = (n: number | null, unit = '') =>
  n === null ? 'unknown' : `${Math.round(n * 10) / 10}${unit}`
const pct = (n: number) => `${Math.round(n * 100)}%`

/** Rows that carry figures (an error row is a gap). */
const usable = (rows: CapacitySample[]) =>
  rows.filter((r) => r.requests_per_min !== null || r.db_in_use !== null)

/**
 * Whether a dedicated environment fits a shared deployment, with the reasons. null = no advice
 * (too few samples, a check over its threshold, or blockers that could not be read).
 */
export function fitsShared(
  rows: CapacitySample[],
  s: CapacitySettings,
  blockers: string[] | null
): AdviceReason[] | null {
  const ok = usable(rows)
  if (ok.length < s.min_samples) return null
  const rpm = percentile(
    ok.map((r) => r.requests_per_min),
    0.95
  )
  const mem = percentile(
    ok.map((r) => r.memory_mb),
    0.95
  )
  const dbUse = percentile(
    ok.map((r) => r.db_in_use),
    0.95
  )
  const storage = ok[ok.length - 1]?.storage_bytes ?? null
  const gb = storage === null ? null : storage / 1024 ** 3
  if (rpm === null || rpm > s.fits.max_rpm) return null
  if (mem !== null && mem > s.fits.max_memory_mb) return null
  if (dbUse !== null && dbUse > s.fits.max_db_in_use) return null
  if (gb !== null && gb > s.fits.max_storage_gb) return null
  if (blockers === null || blockers.length) return null
  return [
    {
      code: 'QUIET',
      text: `Requests: ${fmt(rpm, '/min')} at the 95th percentile over ${ADVICE_DAYS} days (at most ${s.fits.max_rpm}).`
    },
    {
      code: 'SMALL',
      text: `Memory: ${fmt(mem, ' MB')} at the 95th percentile (at most ${s.fits.max_memory_mb} MB); database connections in use: ${fmt(dbUse)} (at most ${s.fits.max_db_in_use}).`
    },
    {
      code: 'STORAGE',
      text: `Files: ${gb === null ? 'unknown' : `${Math.round(gb * 10) / 10} GB`} (at most ${s.fits.max_storage_gb} GB).`
    },
    {
      code: 'NO_BLOCKERS',
      text: 'Its shared-readiness report names no feature a shared deployment lacks.'
    }
  ]
}

/**
 * Whether an environment outgrew its shared deployment, with the reasons. `totals` = the
 * deployment's own rows; `appsPerRound` = apps sampled on it per round (sampled_at ms).
 */
export function outgrewShared(
  rows: CapacitySample[],
  totals: CapacitySample[],
  appsPerRound: Map<number, number>,
  s: CapacitySettings
): AdviceReason[] | null {
  const ok = usable(rows)
  if (ok.length < s.min_samples) return null
  const totalAt = new Map(totals.map((t) => [t.sampled_at.getTime(), t]))
  let rounds = 0
  let over = 0
  const tops: number[] = []
  for (const r of ok) {
    const at = r.sampled_at.getTime()
    const t = totalAt.get(at)
    if (!t || (appsPerRound.get(at) ?? 0) < 2) continue
    const top = topShare(shareOf(r, t))
    if (top === null) continue
    rounds++
    tops.push(top)
    if (top >= s.outgrew.share) over++
  }
  const reasons: AdviceReason[] = []
  if (rounds >= s.min_samples && over / rounds >= s.outgrew.sustained)
    reasons.push({
      code: 'SUSTAINED_SHARE',
      text: `Used ${pct(s.outgrew.share)} or more of its deployment (requests, answering time or connections) in ${pct(over / rounds)} of the last ${ADVICE_DAYS} days' samples (threshold ${pct(s.outgrew.sustained)}); median share ${pct(percentile(tops, 0.5) ?? 0)}.`
    })
  const rpm = percentile(
    ok.map((r) => r.requests_per_min),
    0.95
  )
  if (rpm !== null && rpm > s.outgrew.max_rpm)
    reasons.push({
      code: 'BUSY',
      text: `Requests: ${fmt(rpm, '/min')} at the 95th percentile (over ${s.outgrew.max_rpm}).`
    })
  return reasons.length ? reasons : null
}

/** The admin path of an app's Move panel, pre-filled (HubAppDetail reads `move` and `to`). */
export function planPath(appId: number | null, envId: number, to: string): string {
  return `/hub?${new URLSearchParams({
    ...(appId ? { app: String(appId) } : {}),
    move: String(envId),
    to
  }).toString()}`
}

/** The shared deployment a fitting app would go to: the active one with the most room (lowest
 *  latest connections in use against its budget, then fewest requests). */
export function pickTarget(
  shareds: Pick<SharedDeployment, 'id' | 'key' | 'status' | 'pool_budget'>[],
  latest: Map<number, CapacitySample>
): { id: number; key: string } | null {
  const candidates = shareds.filter((s) => s.status === 'active')
  if (!candidates.length) return null
  const room = (s: (typeof candidates)[number]) =>
    s.pool_budget - (latest.get(s.id)?.db_in_use ?? 0)
  const load = (s: (typeof candidates)[number]) => latest.get(s.id)?.requests_per_min ?? 0
  const best = [...candidates].sort((a, b) => room(b) - room(a) || load(a) - load(b))[0]
  return { id: best.id, key: best.key }
}

// ─── the loader ──────────────────────────────────────────────────────────────

const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'

/** Blocker codes of a dedicated environment's shared-readiness report, kept an hour (Hub only). */
const blockerCache = new Map<number, { at: number; codes: string[] | null }>()
const BLOCKER_TTL_MS = 60 * 60_000

export interface AdvisorDeps {
  readiness?: (env: { base_url: string }, token: string) => Promise<ReadinessRead>
  now?: () => Date
}

async function blockersOf(
  env: { id: number; base_url: string; hub_token: string | null },
  deps: AdvisorDeps,
  now: number
): Promise<string[] | null> {
  const hit = blockerCache.get(env.id)
  if (hit && now - hit.at < BLOCKER_TTL_MS) return hit.codes
  let codes: string[] | null = null
  try {
    const token = openSecret(env.hub_token)
    if (token) {
      const read = await (deps.readiness ?? readSharedReadiness)(env, token)
      codes = read.ok
        ? read.report.codes.filter((c) => c.level === 'blocker').map((c) => c.code)
        : null
    }
  } catch {
    codes = null
  }
  // Only an answer is kept: a failed read is asked again next time (never hides advice an hour).
  if (codes !== null) {
    if (blockerCache.size > 2000) blockerCache.clear()
    blockerCache.set(env.id, { at: now, codes })
  }
  return codes
}

/** Test seam. */
export function _resetAdvisorForTests(): void {
  blockerCache.clear()
}

/** Every suggestion the rules make now. */
export async function moveAdvice(deps: AdvisorDeps = {}): Promise<Advice[]> {
  const now = (deps.now ?? (() => new Date()))()
  const since = new Date(now.getTime() - ADVICE_DAYS * DAY_MS)
  const [samples, settings, shareds] = await Promise.all([
    samplesSince(since),
    readSettings(),
    listShared()
  ])
  const envIds = [
    ...new Set(samples.map((s) => s.environment_id).filter((x): x is number => x !== null))
  ]
  if (!envIds.length) return []
  const envRows = (await db(ENVS).whereIn('id', envIds)) as Record<string, unknown>[]
  const apps = new Map(
    (
      (await db(APPS)
        .whereIn('id', [...new Set(envRows.map((r) => Number(r.app_id)))])
        .select('id', 'key')) as Array<{ id: number; key: string }>
    ).map((a) => [Number(a.id), a])
  )

  const totals = new Map<number, CapacitySample[]>()
  const perEnv = new Map<number, CapacitySample[]>()
  const appsPerRound = new Map<string, number>()
  for (const s of samples) {
    if (s.scope === 'shared' && s.shared_deployment_id !== null) {
      const g = totals.get(s.shared_deployment_id) ?? []
      g.push(s)
      totals.set(s.shared_deployment_id, g)
    } else if (s.environment_id !== null) {
      const g = perEnv.get(s.environment_id) ?? []
      g.push(s)
      perEnv.set(s.environment_id, g)
      if (s.shared_deployment_id !== null) {
        const k = `${s.shared_deployment_id}|${s.sampled_at.getTime()}`
        appsPerRound.set(k, (appsPerRound.get(k) ?? 0) + 1)
      }
    }
  }
  const latestTotal = new Map<number, CapacitySample>()
  for (const [id, rows] of totals) latestTotal.set(id, rows[rows.length - 1])

  // The readiness reports of every dedicated candidate whose figures fit, read 4 at a time.
  const candidates = envRows.filter((r) => {
    if (String(r.status) === 'archived') return false
    const rows = perEnv.get(Number(r.id)) ?? []
    const last = rows[rows.length - 1]
    return (
      !!last &&
      last.shared_deployment_id === null &&
      !!fitsShared(
        rows.filter((x) => x.shared_deployment_id === null),
        settings,
        []
      )
    )
  })
  const blockers = new Map<number, string[] | null>()
  let nextCandidate = 0
  await Promise.all(
    Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (nextCandidate < candidates.length) {
        const r = candidates[nextCandidate++]
        blockers.set(
          Number(r.id),
          await blockersOf(
            {
              id: Number(r.id),
              base_url: String(r.base_url),
              hub_token: (r.hub_token as string | null) ?? null
            },
            deps,
            now.getTime()
          )
        )
      }
    })
  )

  const out: Advice[] = []
  for (const r of envRows) {
    const envId = Number(r.id)
    if (String(r.status) === 'archived') continue
    const rows = perEnv.get(envId) ?? []
    const last = rows[rows.length - 1]
    if (!last) continue
    const app = apps.get(Number(r.app_id))
    const base = {
      env_id: envId,
      app_id: app ? Number(app.id) : null,
      app_key: app?.key ?? '?',
      env_key: String(r.key)
    }
    if (last.shared_deployment_id === null) {
      const own = rows.filter((x) => x.shared_deployment_id === null)
      // The figures first: the readiness report is asked for only when they fit.
      if (!fitsShared(own, settings, [])) continue
      const target = pickTarget(shareds, latestTotal)
      if (!target) continue
      const reasons = fitsShared(own, settings, blockers.get(envId) ?? null)
      if (!reasons) continue
      out.push({
        ...base,
        kind: 'fits_shared',
        reasons,
        target: { kind: 'shared', shared_id: target.id, key: target.key },
        plan_path: planPath(base.app_id, envId, `shared:${target.id}`)
      })
    } else {
      const sid = last.shared_deployment_id
      const mine = rows.filter((x) => x.shared_deployment_id === sid)
      const rounds = new Map<number, number>()
      for (const t of totals.get(sid) ?? [])
        rounds.set(
          t.sampled_at.getTime(),
          appsPerRound.get(`${sid}|${t.sampled_at.getTime()}`) ?? 0
        )
      const reasons = outgrewShared(mine, totals.get(sid) ?? [], rounds, settings)
      if (!reasons) continue
      out.push({
        ...base,
        kind: 'outgrew_shared',
        reasons,
        target: { kind: 'dedicated' },
        plan_path: planPath(base.app_id, envId, 'dedicated')
      })
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.app_key.localeCompare(b.app_key))
}
