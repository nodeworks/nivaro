import { randomUUID } from 'node:crypto'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { hubReadTimeoutMs } from '../../hub-link/verify-limits.js'
import { deliverHubNotice, hubEventRecipients } from '../notify-events.js'
import { flagOf, productionMap } from '../owner-access.js'
import {
  type CheckFacts,
  type CheckResult,
  checksFromJson,
  judgeCheck,
  type OnFail,
  runOutcome,
  runSummary,
  type SmokeCheck,
  type SmokeSuiteInput
} from './checks.js'
import { runHttpCheck, type SafeFetchFn } from './http-check.js'
import { callVerify, type VerifyLinkDeps, type VerifyLinkResult, verifyTarget } from './link.js'

/**
 * Post-deploy smoke checks (Hub verification, idea 29). One saved suite per environment
 * (nivaro_hub_smoke_suites); a run (nivaro_hub_smoke_runs) is queued for every successful
 * promotion, rollback and Apply now of the environment, every finished move of it, and every
 * finished upgrade or rollback of the shared deployment it is placed on — `settle_seconds` after
 * it finished — and by hand (Run now). The `hub-verify` minute (one leader, cronTicksEnabled)
 * queues what is new and runs what is due; every state lives in the rows, so a stopped tick is
 * picked up by the next one.
 *
 * A failed run tells the app's people (Hub administrators + the app's owners, deliverHubNotice;
 * urgent on production). With `on_fail: rollback` a failed run after a PROMOTION is also a breach
 * for the environment's automatic rollback rule (releases/auto-rollback.ts asks
 * smokeVerdictForDeploy while its watch is open): the rule decides, claims and rolls back exactly
 * as for its own figures — this file never starts a rollback. An environment without an enabled
 * rule is only told; a rollback, an Apply now, a move or an upgrade is never rolled back for a
 * smoke failure.
 */

const SUITES = 'nivaro_hub_smoke_suites'
const RUNS = 'nivaro_hub_smoke_runs'
const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'
const MOVES = 'nivaro_hub_moves'
const SHARED_DEPLOYS = 'nivaro_hub_shared_deploys'
const PLACEMENTS = 'nivaro_hub_placements'

/** A finished deploy older than this is never smoke-tested after the fact. */
export const LOOKBACK_MS = 6 * 60 * 60_000
/** A `running` claim older than this was left by a stopped tick. */
export const RUN_STALE_MS = 10 * 60_000

export type RunTrigger =
  | 'promote'
  | 'rollback'
  | 'apply'
  | 'extension'
  | 'move'
  | 'upgrade'
  | 'manual'
/** `unverified`: checks failed only because they could not be judged — told, never rolled back. */
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'unverified'

export interface SmokeSuite extends SmokeSuiteInput {
  environment_id: number
  updated_by: string | null
  updated_at: string | null
}

export interface SmokeRun {
  id: number
  app_id: number
  environment_id: number
  source_key: string
  trigger: RunTrigger
  deploy_id: number | null
  version: string | null
  status: RunStatus
  on_fail: OnFail | null
  results: CheckResult[]
  passed: number | null
  failed: number | null
  reason: string | null
  due_at: string | null
  started_at: string | null
  finished_at: string | null
  created_by: string | null
  created_at: string | null
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString())
const num = (v: unknown) => (v == null ? null : Number(v))
const bool = (v: unknown) => v === true || v === 1 || v === '1'

function parse<T>(v: unknown, fallback: T): T {
  try {
    return v == null ? fallback : (JSON.parse(String(v)) as T)
  } catch {
    return fallback
  }
}

export function suiteFromRow(r: Record<string, unknown>): SmokeSuite {
  return {
    environment_id: Number(r.environment_id),
    enabled: bool(r.enabled),
    on_fail: r.on_fail === 'rollback' ? 'rollback' : 'notify',
    settle_seconds: Number(r.settle_seconds ?? 30),
    checks: checksFromJson(r.checks),
    updated_by: r.updated_by == null ? null : String(r.updated_by),
    updated_at: iso(r.updated_at)
  }
}

export function runFromRow(r: Record<string, unknown>): SmokeRun {
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    source_key: String(r.source_key),
    trigger: String(r.trigger_kind) as RunTrigger,
    deploy_id: num(r.deploy_id),
    version: r.version == null ? null : String(r.version),
    status: String(r.status) as RunStatus,
    on_fail: r.on_fail === 'rollback' ? 'rollback' : r.on_fail === 'notify' ? 'notify' : null,
    results: parse<CheckResult[]>(r.results, []),
    passed: num(r.passed),
    failed: num(r.failed),
    reason: r.reason == null ? null : String(r.reason),
    due_at: iso(r.due_at),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    created_by: r.created_by == null ? null : String(r.created_by),
    created_at: iso(r.created_at)
  }
}

// ─── Suites ────────────────────────────────────────────────────────────────────

export async function readSuite(envId: number): Promise<SmokeSuite | null> {
  const r = (await db(SUITES).where({ environment_id: envId }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? suiteFromRow(r) : null
}

export async function listSuites(envIds: number[]): Promise<SmokeSuite[]> {
  if (!envIds.length) return []
  return (
    (await db(SUITES).whereIn('environment_id', envIds)) as Array<Record<string, unknown>>
  ).map(suiteFromRow)
}

export async function saveSuite(
  envId: number,
  s: SmokeSuiteInput,
  userId: string | null
): Promise<SmokeSuite> {
  const row = {
    enabled: s.enabled,
    on_fail: s.on_fail,
    settle_seconds: s.settle_seconds,
    checks: JSON.stringify(s.checks),
    updated_by: userId,
    updated_at: new Date()
  }
  const changed = await db(SUITES).where({ environment_id: envId }).update(row)
  if (!changed) {
    try {
      await db(SUITES).insert({ environment_id: envId, ...row })
    } catch {
      // Two first saves at once: the second becomes an update.
      await db(SUITES).where({ environment_id: envId }).update(row)
    }
  }
  return (await readSuite(envId)) as SmokeSuite
}

export async function deleteSuite(envId: number): Promise<boolean> {
  return (await db(SUITES).where({ environment_id: envId }).delete()) > 0
}

// ─── Runs ──────────────────────────────────────────────────────────────────────

export async function readRun(id: number): Promise<SmokeRun | null> {
  const r = (await db(RUNS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? runFromRow(r) : null
}

export async function listRuns(o: { envIds?: number[]; limit?: number }): Promise<SmokeRun[]> {
  const q = db(RUNS)
    .orderBy('id', 'desc')
    .limit(Math.min(o.limit ?? 50, 200))
  if (o.envIds) q.whereIn('environment_id', o.envIds.length ? o.envIds : [-1])
  return ((await q) as Array<Record<string, unknown>>).map(runFromRow)
}

/** The newest run per environment (one read; the Smoke checks tab). */
export async function lastRuns(envIds: number[]): Promise<Map<number, SmokeRun>> {
  const out = new Map<number, SmokeRun>()
  if (!envIds.length) return out
  const ids = db(RUNS).whereIn('environment_id', envIds).groupBy('environment_id').max('id as id')
  const rows = (await db(RUNS).whereIn('id', ids)) as Array<Record<string, unknown>>
  for (const r of rows) out.set(Number(r.environment_id), runFromRow(r))
  return out
}

interface QueueInput {
  appId: number
  envId: number
  sourceKey: string
  trigger: RunTrigger
  deployId?: number | null
  version?: string | null
  dueAt: Date
  createdBy?: string | null
  suite: SmokeSuite
}

/** Queues a run once per source (the unique source_key). Answers its id, or null when it was there. */
export async function queueRun(o: QueueInput): Promise<number | null> {
  if (await db(RUNS).where({ source_key: o.sourceKey }).first('id')) return null
  try {
    const id = await insertReturningId(db, RUNS, {
      app_id: o.appId,
      environment_id: o.envId,
      source_key: o.sourceKey.slice(0, 80),
      trigger_kind: o.trigger,
      deploy_id: o.deployId ?? null,
      version: o.version ?? null,
      status: 'queued',
      on_fail: o.suite.on_fail,
      checks: JSON.stringify(o.suite.checks),
      due_at: o.dueAt,
      created_by: o.createdBy ?? null,
      created_at: new Date()
    })
    if (id != null && Number.isFinite(Number(id))) return Number(id)
  } catch {
    return null // another tick queued it (unique source_key)
  }
  const back = (await db(RUNS).where({ source_key: o.sourceKey }).first('id')) as
    | { id: number }
    | undefined
  return back ? Number(back.id) : null
}

const isApply = (plan: unknown) => typeof plan === 'string' && /"apply"\s*:\s*true/.test(plan)

/**
 * Queues a run for every deploy, move and shared upgrade of an environment with an enabled suite
 * that finished since the suite was saved (at most LOOKBACK_MS ago) and has none yet.
 */
export async function queueNewRuns(now = Date.now()): Promise<number> {
  const suites = (
    (await db(SUITES).where({ enabled: true })) as Array<Record<string, unknown>>
  ).map(suiteFromRow)
  let queued = 0
  for (const suite of suites) {
    if (!suite.checks.length) continue
    const env = (await db(ENVS)
      .where({ id: suite.environment_id })
      .first('id', 'app_id', 'status', 'placement_id')) as Record<string, unknown> | undefined
    if (!env || env.status === 'archived') continue
    const envId = Number(env.id)
    const appId = Number(env.app_id)
    const savedAt = suite.updated_at ? Date.parse(suite.updated_at) : 0
    const since = new Date(Math.max(now - LOOKBACK_MS, savedAt))
    const due = (finished: unknown) =>
      new Date(new Date(finished as string | Date).getTime() + suite.settle_seconds * 1000)

    const deploys = (await db(DEPLOYS)
      .where({ environment_id: envId, status: 'success' })
      .whereIn('kind', ['promote', 'rollback', 'extension'])
      .where('finished_at', '>=', since)
      .select('id', 'kind', 'version', 'finished_at', 'plan')) as Array<Record<string, unknown>>
    for (const d of deploys) {
      const trigger: RunTrigger =
        d.kind === 'rollback'
          ? 'rollback'
          : d.kind === 'extension'
            ? 'extension'
            : isApply(d.plan)
              ? 'apply'
              : 'promote'
      if (
        await queueRun({
          appId,
          envId,
          sourceKey: `deploy:${d.id}`,
          trigger,
          deployId: Number(d.id),
          version: d.version == null ? null : String(d.version),
          dueAt: due(d.finished_at),
          suite
        })
      )
        queued++
    }

    const moves = (await db(MOVES)
      .where({ environment_id: envId, status: 'success' })
      .where('finished_at', '>=', since)
      .select('id', 'finished_at')) as Array<Record<string, unknown>>
    for (const m of moves)
      if (
        await queueRun({
          appId,
          envId,
          sourceKey: `move:${m.id}`,
          trigger: 'move',
          dueAt: due(m.finished_at),
          suite
        })
      )
        queued++

    if (env.placement_id != null) {
      const p = (await db(PLACEMENTS)
        .where({ id: env.placement_id })
        .first('kind', 'shared_deployment_id')) as
        | { kind: string; shared_deployment_id: number | null }
        | undefined
      if (p?.kind === 'shared' && p.shared_deployment_id != null) {
        const ups = (await db(SHARED_DEPLOYS)
          .where({ shared_deployment_id: p.shared_deployment_id, status: 'success' })
          .whereIn('kind', ['upgrade', 'rollback'])
          .where('finished_at', '>=', since)
          .select('id', 'version', 'finished_at')) as Array<Record<string, unknown>>
        for (const u of ups)
          if (
            await queueRun({
              appId,
              envId,
              sourceKey: `shared:${u.id}:env:${envId}`,
              trigger: 'upgrade',
              version: u.version == null ? null : String(u.version),
              dueAt: due(u.finished_at),
              suite
            })
          )
            queued++
      }
    }
  }
  return queued
}

/** Queues a run of the environment's suite now (Run now). */
export async function queueManualRun(envId: number, userId: string | null): Promise<number> {
  const suite = await readSuite(envId)
  if (!suite?.checks.length)
    throw Object.assign(new Error('This environment has no smoke checks yet.'), {
      status: 409,
      code: 'NO_SUITE'
    })
  const env = (await db(ENVS).where({ id: envId }).first('app_id')) as
    | { app_id: number }
    | undefined
  if (!env) throw Object.assign(new Error('Not found'), { status: 404, code: 'NOT_FOUND' })
  const id = await queueRun({
    appId: Number(env.app_id),
    envId,
    sourceKey: `manual:${randomUUID()}`,
    trigger: 'manual',
    dueAt: new Date(),
    createdBy: userId,
    suite
  })
  if (id == null) throw new Error('the run could not be queued')
  return id
}

// ─── Running ───────────────────────────────────────────────────────────────────

export interface RunDeps {
  now(): number
  httpFetch?: SafeFetchFn
  link?: VerifyLinkDeps
  notify?: (
    appId: number,
    n: { subject: string; message: string; urgent: boolean; path: string }
  ) => Promise<unknown>
  /** Whether the environment's automatic rollback rule watches this promotion now. */
  watched?: (deployId: number) => Promise<boolean>
}

export function defaultRunDeps(): RunDeps {
  return { now: () => Date.now() }
}

async function notifyPeople(
  appId: number,
  n: { subject: string; message: string; urgent: boolean; path: string }
): Promise<unknown> {
  return deliverHubNotice(await hubEventRecipients(appId), {
    subject: n.subject,
    message: n.message,
    path: n.path,
    urgent: n.urgent,
    source: { kind: 'hub', label: 'smoke_failed', id: appId },
    why: 'You are a Hub administrator or an owner of this app.'
  })
}

/** Whether an open rollback watch covers the promotion (opening due watches first). */
async function defaultWatched(deployId: number): Promise<boolean> {
  const { openWatches, WATCHES } = await import('../releases/auto-rollback.js')
  await openWatches().catch(() => 0)
  return !!(await db(WATCHES).where({ deploy_id: deployId, status: 'watching' }).first('id'))
}

function linkWords(r: VerifyLinkResult): string {
  switch (r.state) {
    case 'no_link':
      return 'the Hub has no link to this environment (no hub token)'
    case 'refused':
      return 'the app refused the Hub’s link token'
    case 'too_old':
      return 'the app has no smoke reads (it runs a version before 0.3.215)'
    case 'unreachable':
      return 'the app did not answer over its link'
    case 'bad_request':
      return 'the app refused the reads as asked'
    default:
      return r.code?.startsWith('SMOKE_')
        ? `the app refused its smoke service account (${r.code}): it is no longer the read-only account the app made`
        : 'the app could not run the reads'
  }
}

/** Runs one check list against one environment (no database writes). */
export async function runChecks(
  envId: number,
  checks: SmokeCheck[],
  deps: Pick<RunDeps, 'now' | 'httpFetch' | 'link'>
): Promise<CheckResult[]> {
  const target = await verifyTarget(envId)
  const facts = new Map<string, CheckFacts>()
  for (const c of checks.filter((x) => x.kind === 'http')) {
    facts.set(
      c.id,
      target
        ? await runHttpCheck(target.base_url, c, { fetch: deps.httpFetch, now: deps.now })
        : { status: null, ms: null, error: 'the environment is gone' }
    )
  }
  const reads = checks.filter((x) => x.kind !== 'http')
  if (reads.length) {
    const body = {
      reads: reads.map((c) =>
        c.kind === 'read'
          ? { kind: 'read', path: c.path }
          : { kind: 'query', slug: c.slug, params: c.params ?? {} }
      )
    }
    const res = target
      ? await callVerify(target, 'run', body, {
          ...deps.link,
          timeoutMs: deps.link?.timeoutMs ?? hubReadTimeoutMs(reads.length)
        })
      : ({ state: 'failed', body: null } as VerifyLinkResult)
    const list = (res.body as { results?: unknown } | null)?.results
    reads.forEach((c, i) => {
      const r = Array.isArray(list) ? (list[i] as Record<string, unknown> | undefined) : undefined
      if (res.state !== 'ok' || !r) {
        facts.set(c.id, { status: null, ms: null, error: linkWords(res) })
        return
      }
      const status = Number(r.status)
      facts.set(c.id, {
        status: Number.isFinite(status) && status > 0 ? status : null,
        ms: Number.isFinite(Number(r.ms)) ? Number(r.ms) : null,
        rows: r.rows == null || !Number.isFinite(Number(r.rows)) ? null : Number(r.rows),
        code: typeof r.code === 'string' ? r.code.slice(0, 64) : null,
        error: r.code === 'TIMEOUT' ? 'the app’s read did not finish in 15 s' : null
      })
    })
  }
  return checks.map((c) =>
    judgeCheck(c, facts.get(c.id) ?? { status: null, ms: null, error: 'not run' })
  )
}

async function envFacts(envId: number): Promise<{ key: string; production: boolean }> {
  const e = (await db(ENVS).where({ id: envId }).first('app_id', 'key')) as
    | { app_id: number; key: string }
    | undefined
  if (!e) return { key: `#${envId}`, production: false }
  const all = (await db(ENVS)
    .where({ app_id: e.app_id })
    .select('id', 'key', 'position', 'status', 'production')) as Array<Record<string, unknown>>
  const map = productionMap(
    all.map((r) => ({
      id: Number(r.id),
      key: String(r.key),
      position: Number(r.position ?? 0),
      status: r.status == null ? null : String(r.status),
      production: flagOf(r.production)
    }))
  )
  return { key: String(e.key), production: map.get(envId) ?? true }
}

const TRIGGER_WORDS: Record<RunTrigger, string> = {
  promote: 'the promotion',
  rollback: 'the rollback',
  apply: 'Apply now',
  extension: 'an extension deploy',
  move: 'the move',
  upgrade: 'the shared deployment’s upgrade',
  manual: 'a run by hand'
}

/** Claims one queued run (queued → running) and runs it. False when someone else had it. */
export async function executeRun(id: number, deps: RunDeps = defaultRunDeps()): Promise<boolean> {
  const now = deps.now()
  const claimed = await db(RUNS)
    .where({ id, status: 'queued' })
    .update({ status: 'running', claimed_at: new Date(now), started_at: new Date(now) })
  if (!claimed) return false
  const run = (await readRun(id)) as SmokeRun
  const checks = checksFromJson(
    ((await db(RUNS).where({ id }).first('checks')) as { checks?: unknown } | undefined)?.checks
  )
  let results: CheckResult[]
  try {
    results = await runChecks(run.environment_id, checks, deps)
  } catch {
    results = checks.map((c) =>
      judgeCheck(c, { status: null, ms: null, error: 'the Hub could not run it' })
    )
  }
  const failed = results.filter((r) => !r.ok).length
  const status: RunStatus = runOutcome(results)
  const reason = results.length ? runSummary(results) : 'The suite had no checks to run'
  await db(RUNS)
    .where({ id, status: 'running' })
    .update({
      status,
      results: JSON.stringify(results),
      passed: results.length - failed,
      failed,
      reason,
      finished_at: new Date(deps.now())
    })
  const { key, production } = await envFacts(run.environment_id)
  await logActivity({
    action: `hub-smoke-${status}`,
    user: run.created_by,
    collection: RUNS,
    item: String(id),
    comment: `${key} after ${TRIGGER_WORDS[run.trigger]}: ${reason}`.slice(0, 1000),
    origin: run.created_by ? undefined : 'machine'
  })
  if (status === 'unverified') {
    // Nothing about the deploy is known: the people are told, nothing is rolled back.
    await (deps.notify ?? notifyPeople)(run.app_id, {
      subject: `Smoke checks could not judge ${key}`,
      message:
        `${key} after ${TRIGGER_WORDS[run.trigger]}: the checks could not be judged (${reason}). Nothing was rolled back; check the environment and its link.`.slice(
          0,
          1000
        ),
      urgent: false,
      path: `/hub/smoke?env=${run.environment_id}&run=${id}`
    }).catch(() => undefined)
  }
  if (status === 'failed') {
    let tail = ''
    if (run.on_fail === 'rollback' && run.trigger === 'promote' && run.deploy_id != null) {
      const watched = await (deps.watched ?? defaultWatched)(run.deploy_id).catch(() => false)
      tail = watched
        ? ' Its automatic rollback rule rolls it back to the version it ran before.'
        : ' It is NOT rolled back: no automatic rollback rule watches this promotion now.'
    }
    const version = run.version ? ` (${run.version})` : ''
    await (deps.notify ?? notifyPeople)(run.app_id, {
      subject: `Smoke checks failed: ${key}`,
      message: `${key}${version} after ${TRIGGER_WORDS[run.trigger]}: ${reason}.${tail}`.slice(
        0,
        1000
      ),
      urgent: production || run.on_fail === 'rollback',
      path: `/hub/smoke?env=${run.environment_id}&run=${id}`
    }).catch(() => undefined)
  }
  return true
}

/** Settles runs a stopped tick left `running`: unverified (never a breach), and said so. */
export async function healStaleRuns(now: number): Promise<number> {
  return db(RUNS)
    .where({ status: 'running' })
    .where('claimed_at', '<', new Date(now - RUN_STALE_MS))
    .update({
      // Never a verdict on the deploy: the Hub stopped, not the app.
      status: 'unverified',
      reason: 'The Hub stopped during this run — run it again',
      finished_at: new Date(now)
    })
}

/** A tick stops starting runs after this long (the rest wait for the next minute). */
export const TICK_BUDGET_MS = 45_000

/** Runs the queued runs that are due (oldest first, at most `max`, within TICK_BUDGET_MS). */
export async function runDueRuns(deps: RunDeps = defaultRunDeps(), max = 20): Promise<number> {
  const started = deps.now()
  await healStaleRuns(started)
  const due = (await db(RUNS)
    .where({ status: 'queued' })
    .where('due_at', '<=', new Date(deps.now()))
    .orderBy('due_at', 'asc')
    .limit(max)
    .select('id')) as Array<{ id: number }>
  let n = 0
  for (const r of due) {
    if (deps.now() - started > TICK_BUDGET_MS) break
    if (await executeRun(Number(r.id), deps)) n++
  }
  return n
}

/**
 * For the automatic rollback rule (releases/auto-rollback.ts): a run after this promotion whose
 * suite said `rollback`, that FINISHED inside the rule's window (`untilIso`) and saw a check fail
 * on the app's own answer (status `failed`, never `unverified`), is a breach. Null = none.
 */
export async function smokeVerdictForDeploy(
  deployId: number,
  untilIso?: string | null
): Promise<{ breach: boolean; reason: string | null } | null> {
  const q = db(RUNS)
    .where({ deploy_id: deployId, trigger_kind: 'promote', on_fail: 'rollback', status: 'failed' })
    .whereNotNull('finished_at')
    .orderBy('id', 'desc')
  if (untilIso) q.where('finished_at', '<=', new Date(untilIso))
  const r = (await q.first('reason')) as { reason: string | null } | undefined
  return r ? { breach: true, reason: `smoke checks failed: ${r.reason ?? 'see the run'}` } : null
}
