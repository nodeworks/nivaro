import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { type EnvFigures, readEnvFiguresById } from './figures.js'
import { notifyAutoRollback } from './notify.js'
import {
  isTransientCode,
  type PlannedStart,
  refusalCode,
  refusalText,
  startPlannedPromotion
} from './start.js'

/**
 * Automatic rollback rules (Hub release operations). Per environment: for `window_minutes`
 * after a successful promotion, the Hub reads the app's figures over its hub link every minute
 * (the release-ops tick) and rolls back to the version it ran before when one crosses:
 *
 *  - 5xx rate    errors_5xx / requests since the deploy, in percent, once at least
 *                `min_requests` requests were answered (fewer = too few to judge)
 *  - crashes     front-end crash reports since the deploy ≥ `max_crashes`
 *  - readiness   the readiness score below `min_readiness` (a score not computed yet is not a
 *                breach: the scorecard refreshes after a deploy)
 *
 * The rollback goes through the existing rollback path (startPromotion kind rollback: the
 * recorded build, typed-key equivalent = the environment key, plan judged again) and is never
 * frozen. Owners are told either way: rolled back, or could not roll back (and why). One watch
 * row per promotion (nivaro_hub_rollback_watches): watching → (rolling →) passed | rolled_back |
 * failed | superseded (another deploy of the environment came first). `rolling` is the claim a
 * tick takes before it starts the rollback; one a crash left behind is settled after 5 minutes
 * from the deploy rows (healRolling). An environment without a hub link
 * cannot be judged: its watch ends `failed` (NO_FIGURES) when the window closes, once.
 */

export const RULES = 'nivaro_hub_rollback_rules'
export const WATCHES = 'nivaro_hub_rollback_watches'
const DEPLOYS = 'nivaro_hub_deploys'

export interface RollbackRule {
  environment_id: number
  /** When the rule was last saved: only promotions that finished after it are watched. */
  updated_at?: string | null
  enabled: boolean
  window_minutes: number
  max_error_pct: number | null
  min_requests: number
  max_crashes: number | null
  min_readiness: number | null
}

const n = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)

export function ruleFromRow(r: Record<string, unknown>): RollbackRule {
  return {
    environment_id: Number(r.environment_id),
    enabled: r.enabled === true || r.enabled === 1 || r.enabled === '1',
    window_minutes: n(r.window_minutes) ?? 30,
    max_error_pct: n(r.max_error_pct),
    min_requests: n(r.min_requests) ?? 50,
    max_crashes: n(r.max_crashes),
    min_readiness: n(r.min_readiness),
    updated_at: r.updated_at == null ? null : new Date(r.updated_at as string | Date).toISOString()
  }
}

/** Validates a PUT body (the environment comes from the path). */
export function validateRule(
  b: Record<string, unknown>
): Omit<RollbackRule, 'environment_id'> | { error: string } {
  const enabled = b.enabled !== false
  const win = Number(b.window_minutes ?? 30)
  if (!Number.isInteger(win) || win < 5 || win > 24 * 60)
    return { error: 'window_minutes is 5 to 1440' }
  const pct = b.max_error_pct == null || b.max_error_pct === '' ? null : Number(b.max_error_pct)
  if (pct != null && (!Number.isFinite(pct) || pct <= 0 || pct > 100))
    return { error: 'max_error_pct is more than 0 and at most 100' }
  const minReq = Number(b.min_requests ?? 50)
  if (!Number.isInteger(minReq) || minReq < 1 || minReq > 1_000_000)
    return { error: 'min_requests is 1 to 1000000' }
  const crashes = b.max_crashes == null || b.max_crashes === '' ? null : Number(b.max_crashes)
  // One crash signature keeps its last 50 occurrences (error-tracking), so a higher limit
  // could never be reached by a single bad crash.
  if (crashes != null && (!Number.isInteger(crashes) || crashes < 1 || crashes > 50))
    return { error: 'max_crashes is 1 to 50' }
  const ready = b.min_readiness == null || b.min_readiness === '' ? null : Number(b.min_readiness)
  if (ready != null && (!Number.isInteger(ready) || ready < 1 || ready > 100))
    return { error: 'min_readiness is 1 to 100' }
  if (pct == null && crashes == null && ready == null)
    return { error: 'set at least one threshold (5xx rate, crashes or readiness)' }
  return {
    enabled,
    window_minutes: win,
    max_error_pct: pct,
    min_requests: minReq,
    max_crashes: crashes,
    min_readiness: ready
  }
}

export interface Judgement {
  breach: boolean
  reason: string | null
}

/** Whether these figures cross the rule (pure). */
export function judgeFigures(rule: RollbackRule, f: EnvFigures): Judgement {
  const r = f.recent
  if (rule.max_error_pct != null && r && r.requests != null && r.errors_5xx != null) {
    if (r.requests >= rule.min_requests) {
      const pct = (r.errors_5xx / r.requests) * 100
      if (pct >= rule.max_error_pct)
        return {
          breach: true,
          reason: `5xx rate ${pct.toFixed(1)}% (${r.errors_5xx} of ${r.requests} requests in ${r.minutes} min) reached the limit of ${rule.max_error_pct}%`
        }
    }
  }
  if (rule.max_crashes != null && r && r.crashes != null && r.crashes >= rule.max_crashes)
    return {
      breach: true,
      reason: `${r.crashes} crash reports in ${r.minutes} min reached the limit of ${rule.max_crashes}`
    }
  if (
    rule.min_readiness != null &&
    f.readiness_score != null &&
    f.readiness_score < rule.min_readiness
  )
    return {
      breach: true,
      reason: `readiness score ${f.readiness_score} is below ${rule.min_readiness}`
    }
  return { breach: false, reason: null }
}

export async function readRule(envId: number): Promise<RollbackRule | null> {
  const r = (await db(RULES).where({ environment_id: envId }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? ruleFromRow(r) : null
}

export async function saveRule(
  envId: number,
  rule: Omit<RollbackRule, 'environment_id'>,
  userId: string | null
): Promise<RollbackRule> {
  const row = {
    enabled: rule.enabled,
    window_minutes: rule.window_minutes,
    max_error_pct: rule.max_error_pct,
    min_requests: rule.min_requests,
    max_crashes: rule.max_crashes,
    min_readiness: rule.min_readiness,
    updated_by: userId,
    updated_at: new Date()
  }
  const changed = await db(RULES).where({ environment_id: envId }).update(row)
  if (!changed) await db(RULES).insert({ environment_id: envId, ...row })
  return { environment_id: envId, ...rule }
}

export async function deleteRule(envId: number): Promise<boolean> {
  return (await db(RULES).where({ environment_id: envId }).delete()) > 0
}

export interface WatchRow {
  id: number
  deploy_id: number
  app_id: number
  environment_id: number
  version: string
  from_version: string | null
  status: 'watching' | 'rolling' | 'passed' | 'rolled_back' | 'failed' | 'superseded'
  rule: RollbackRule | null
  figures: EnvFigures | null
  reason: string | null
  deployed_at: string | null
  until_at: string | null
  last_check_at: string | null
  rollback_deploy_id: number | null
  finished_at: string | null
}

const isoOf = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString())
const json = <T>(v: unknown): T | null => {
  try {
    return v == null ? null : (JSON.parse(String(v)) as T)
  } catch {
    return null
  }
}

export function watchFromRow(r: Record<string, unknown>): WatchRow {
  return {
    id: Number(r.id),
    deploy_id: Number(r.deploy_id),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    version: String(r.version),
    from_version: r.from_version == null ? null : String(r.from_version),
    status: String(r.status) as WatchRow['status'],
    rule: json<RollbackRule>(r.rule_json),
    figures: json<EnvFigures>(r.figures),
    reason: r.reason == null ? null : String(r.reason),
    deployed_at: isoOf(r.deployed_at),
    until_at: isoOf(r.until_at),
    last_check_at: isoOf(r.last_check_at),
    rollback_deploy_id: r.rollback_deploy_id == null ? null : Number(r.rollback_deploy_id),
    finished_at: isoOf(r.finished_at)
  }
}

export async function listWatches(o: { envId?: number; appIds?: number[]; limit?: number }) {
  const q = db(WATCHES)
    .orderBy('id', 'desc')
    .limit(Math.min(o.limit ?? 50, 200))
  if (o.envId != null) q.where({ environment_id: o.envId })
  if (o.appIds) q.whereIn('app_id', o.appIds.length ? o.appIds : [-1])
  return ((await q) as Array<Record<string, unknown>>).map(watchFromRow)
}

export interface WatchDeps {
  now(): number
  figures(envId: number, minutes: number): Promise<EnvFigures>
  rollback(envId: number, o: PlannedStart): Promise<{ deployId: number }>
  notify(
    appId: number,
    note: { subject: string; message: string; urgent?: boolean }
  ): Promise<unknown>
  envKey(envId: number): Promise<string>
  /**
   * Hub verification: a failed post-deploy smoke run of this promotion whose suite asks for a
   * rollback (services/hub/verify/smoke.ts) is a breach like the figures'. Null = none (yet).
   */
  smoke?(deployId: number): Promise<Judgement | null>
}

export function defaultWatchDeps(): WatchDeps {
  return {
    now: () => Date.now(),
    figures: (envId, minutes) => readEnvFiguresById(envId, { recentMinutes: minutes }),
    rollback: (envId, o) => startPlannedPromotion(envId, o),
    notify: (appId, note) => notifyAutoRollback(appId, note),
    envKey: async (envId) => {
      const r = (await db('nivaro_hub_environments').where({ id: envId }).first('key')) as
        | { key: string }
        | undefined
      return r ? String(r.key) : `#${envId}`
    },
    smoke: async (deployId) => (await import('../verify/smoke.js')).smokeVerdictForDeploy(deployId)
  }
}

/** Opens a watch for each successful promotion inside an enabled rule's window (idempotent). */
export async function openWatches(
  deps: Pick<WatchDeps, 'now'> = defaultWatchDeps()
): Promise<number> {
  const rules = ((await db(RULES).where({ enabled: true })) as Array<Record<string, unknown>>).map(
    ruleFromRow
  )
  let opened = 0
  for (const rule of rules) {
    // A rule saved now never reaches back to promotions someone already checked.
    const savedAt = rule.updated_at ? Date.parse(rule.updated_at) : 0
    const since = new Date(Math.max(deps.now() - rule.window_minutes * 60_000, savedAt))
    const rows = (await db(`${DEPLOYS} as d`)
      .leftJoin(`${WATCHES} as w`, 'w.deploy_id', 'd.id')
      .where('d.environment_id', rule.environment_id)
      .where('d.kind', 'promote')
      .where('d.status', 'success')
      .where('d.finished_at', '>=', since)
      .whereNull('w.id')
      .select(
        'd.id',
        'd.app_id',
        'd.version',
        'd.from_version',
        'd.finished_at',
        'd.plan'
      )) as Array<Record<string, unknown>>
    for (const d of rows) {
      // Apply now redeploys the running version: nothing to roll back to.
      const apply = typeof d.plan === 'string' && /"apply"\s*:\s*true/.test(d.plan)
      if (apply || d.from_version == null || d.from_version === d.version) continue
      const at = new Date(d.finished_at as string | Date)
      try {
        await db(WATCHES).insert({
          deploy_id: Number(d.id),
          app_id: Number(d.app_id),
          environment_id: rule.environment_id,
          version: String(d.version),
          from_version: String(d.from_version),
          status: 'watching',
          rule_json: JSON.stringify(rule),
          deployed_at: at,
          until_at: new Date(at.getTime() + rule.window_minutes * 60_000),
          created_at: new Date()
        })
        opened++
      } catch {
        /* another tick opened it (unique deploy_id) */
      }
    }
  }
  return opened
}

/** Closes a watch while it is still watching (another tick may have closed it). */
async function closeWatch(id: number, patch: Record<string, unknown>): Promise<boolean> {
  const n = await db(WATCHES)
    .where({ id, status: 'watching' })
    .update({ ...patch, finished_at: new Date() })
  return n > 0
}

/** A `rolling` claim older than this was left by a tick that stopped: settled from the rows. */
export const ROLLING_STALE_MS = 5 * 60_000

/**
 * Settles claims a stopped tick left: rolled_back when a rollback run exists, else failed — and
 * says so like the normal path (activity + owners).
 */
export async function healRolling(
  now: number,
  deps: Pick<WatchDeps, 'notify' | 'envKey'> = defaultWatchDeps()
): Promise<number> {
  const stale = (
    (await db(WATCHES)
      .where({ status: 'rolling' })
      .where('last_check_at', '<', new Date(now - ROLLING_STALE_MS))) as Array<
      Record<string, unknown>
    >
  ).map(watchFromRow)
  let n = 0
  for (const w of stale) {
    const run = (await db(DEPLOYS)
      .where({ environment_id: w.environment_id, kind: 'rollback' })
      .where('id', '>', w.deploy_id)
      .orderBy('id', 'asc')
      .first('id')) as { id: number } | undefined
    const changed = await db(WATCHES)
      .where({ id: w.id, status: 'rolling' })
      .update(
        run
          ? {
              status: 'rolled_back',
              rollback_deploy_id: Number(run.id),
              finished_at: new Date(now)
            }
          : {
              status: 'failed',
              reason: 'The Hub stopped while starting the rollback — check the environment',
              finished_at: new Date(now)
            }
      )
    if (!changed) continue
    n += changed
    const key = await deps.envKey(w.environment_id).catch(() => `#${w.environment_id}`)
    if (run) {
      await logActivity({
        action: 'hub-auto-rollback',
        user: null,
        collection: DEPLOYS,
        item: String(run.id),
        comment: `${key}: ${w.version} → ${w.from_version} (settled after a restart)`.slice(
          0,
          1000
        ),
        origin: 'machine'
      })
      await deps.notify(w.app_id, {
        subject: `${key} rolled back to ${w.from_version}`,
        message: `The Hub rolled ${key} back from ${w.version} to ${w.from_version} on its own (its figures crossed the rollback rule).`,
        urgent: true
      })
    } else
      await deps.notify(w.app_id, {
        subject: `${key}: automatic rollback did not finish starting`,
        message: `${key} crossed its rollback rule after ${w.version}, but the Hub stopped while starting the rollback to ${w.from_version}. Check ${key} and roll back by hand if needed.`,
        urgent: true
      })
  }
  return n
}

/** One pass over the open watches. Answers how many rolled back. */
export async function judgeWatches(deps: WatchDeps = defaultWatchDeps()): Promise<number> {
  await healRolling(deps.now(), deps)
  const open = (
    (await db(WATCHES).where({ status: 'watching' }).orderBy('id', 'asc')) as Array<
      Record<string, unknown>
    >
  ).map(watchFromRow)
  let rolled = 0
  for (const w of open) {
    const now = deps.now()
    const rule = w.rule
    if (!rule) {
      await closeWatch(w.id, { status: 'failed', reason: 'The rule could not be read' })
      continue
    }
    // Another deploy of the environment came after this one: it is no longer what runs.
    const newer = await db(DEPLOYS)
      .where({ environment_id: w.environment_id })
      .where('id', '>', w.deploy_id)
      .first('id', 'kind')
    if (newer) {
      await closeWatch(w.id, {
        status: 'superseded',
        reason: `Deploy #${newer.id} (${newer.kind}) ran after it`
      })
      continue
    }
    const deployedAt = w.deployed_at ? Date.parse(w.deployed_at) : now
    const until = w.until_at ? Date.parse(w.until_at) : now
    const minutes = Math.max(1, Math.ceil((Math.min(now, until) - deployedAt) / 60_000))
    const figures = await deps.figures(w.environment_id, minutes)
    // The figures belong to whatever runs now: a version deployed outside the Hub (a CI chain)
    // is not this promotion — the watch ends without ever rolling that one back.
    if (figures.linked && figures.version && figures.version !== w.version) {
      const key = await deps.envKey(w.environment_id)
      if (
        await closeWatch(w.id, {
          status: 'superseded',
          figures: JSON.stringify(figures),
          last_check_at: new Date(now),
          reason: `${key} runs ${figures.version} now, not ${w.version}: not rolled back`
        })
      )
        await deps.notify(w.app_id, {
          subject: `${key}: rollback watch of ${w.version} ended`,
          message: `${key} runs ${figures.version} now (deployed outside this promotion), so the Hub stopped watching ${w.version} and will not roll it back on its own.`
        })
      continue
    }
    let verdict: Judgement = figures.linked
      ? judgeFigures(rule, figures)
      : { breach: false, reason: null }
    if (!verdict.breach && deps.smoke) {
      const smoke = await deps.smoke(w.deploy_id).catch(() => null)
      if (smoke?.breach) verdict = smoke
    }
    if (!verdict.breach) {
      if (now >= until) {
        const judged = figures.linked || w.figures?.linked === true
        await closeWatch(w.id, {
          status: judged ? 'passed' : 'failed',
          figures: JSON.stringify(figures),
          last_check_at: new Date(now),
          reason: judged
            ? null
            : `NO_FIGURES: the Hub could not read this environment's figures (${figures.error ?? 'no hub link'})`
        })
      } else {
        await db(WATCHES)
          .where({ id: w.id, status: 'watching' })
          .update({ figures: JSON.stringify(figures), last_check_at: new Date(now) })
      }
      continue
    }
    const key = await deps.envKey(w.environment_id)
    const from = w.from_version as string
    // Claim the watch before starting anything: a second tick never starts a second rollback.
    const claimed = await db(WATCHES)
      .where({ id: w.id, status: 'watching' })
      .update({ status: 'rolling', figures: JSON.stringify(figures), last_check_at: new Date(now) })
    if (!claimed) continue
    try {
      const out = await deps.rollback(w.environment_id, {
        kind: 'rollback',
        version: from,
        userId: null
      })
      await db(WATCHES).where({ id: w.id }).update({
        status: 'rolled_back',
        reason: verdict.reason,
        rollback_deploy_id: out.deployId,
        finished_at: new Date()
      })
      rolled++
      await logActivity({
        action: 'hub-auto-rollback',
        user: null,
        collection: DEPLOYS,
        item: String(out.deployId),
        comment: `${key}: ${w.version} → ${from} — ${verdict.reason}`.slice(0, 1000),
        origin: 'machine'
      })
      await deps.notify(w.app_id, {
        subject: `${key} rolled back to ${from}`,
        message: `The Hub rolled ${key} back from ${w.version} to ${from} on its own: ${verdict.reason}.`,
        urgent: true
      })
    } catch (err) {
      const code = refusalCode(err)
      // A lock held by a run that just started: try again next minute while the window lasts.
      if (isTransientCode(code) && now < until) {
        await db(WATCHES).where({ id: w.id, status: 'rolling' }).update({ status: 'watching' })
        continue
      }
      await db(WATCHES)
        .where({ id: w.id })
        .update({
          status: 'failed',
          reason:
            `${verdict.reason} — the rollback could not start: ${code}: ${refusalText(err)}`.slice(
              0,
              1000
            ),
          finished_at: new Date()
        })
      await deps.notify(w.app_id, {
        subject: `${key}: automatic rollback could not start`,
        message: `${key} crossed its rollback rule after ${w.version} (${verdict.reason}), but the rollback to ${from} could not start: ${refusalText(err)}. Roll it back by hand from the Hub.`,
        urgent: true
      })
    }
  }
  return rolled
}
