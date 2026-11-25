import { createHash } from 'node:crypto'
import { db } from '../../../db/index.js'
import {
  applyKeepSet,
  captureKeepSet,
  type SavedKeepSet,
  type SqlRunner
} from '../../env-refresh/keep-set.js'
import {
  CORE_KEEPS,
  type EnvKeepEntry,
  EnvKeepError,
  validateKeepEntry
} from '../../env-refresh/registry.js'
import { runSafetyPass } from '../../env-refresh/safety.js'
import { moveOpenMessage, openMoveFor } from '../move-open.js'
import {
  defaultPromoteLock,
  LOCK_RENEW_MS,
  lockHolderRefusal,
  type PromoteLock
} from '../promote-lock.js'
import { openSecret, sealSecret } from '../secrets.js'
import { deploymentClient } from '../shared/deployment-client.js'
import { type AppChannel, appChannelFor, dataPath } from './app-calls.js'
import { backupFolder, backupInto } from './backup.js'
import {
  appLoginOf,
  type EnvData,
  envData,
  errText,
  type ServerAccess,
  type ServerOpener,
  type SqlExec,
  serverAccessOf,
  withServerExec
} from './env-db.js'
import { assertGate, type DataGate, readGate } from './gate.js'
import {
  backupFileName,
  databaseFilesSql,
  deleteFileSql,
  dropLoginUserSql,
  fileListSqlFor,
  identitySql,
  isServerFolder,
  joinServerPath,
  mapLoginSql,
  movesOverTarget,
  onlineSql,
  restoreOverSql
} from './mssql-sql.js'
import { readPolicy } from './policy.js'
import { type RunCtx, type RunnerDeps, resumeDataRun, startDataRun } from './runner.js'
import { openRunFor, patchRun, readKeepSecret, readRun, runFromRow } from './runs.js'
import { DataError, type DataRun } from './types.js'

/**
 * Hub data care — environment refresh: copy one environment's database over a LOWER one of the
 * same app (production → staging, staging → development …), keeping the target's own settings.
 *
 * Off until an administrator turns refreshes on (gate.ts). The target must be OPTED IN
 * (`nivaro_hub_environments.refresh_target`, set by an administrator with a typed confirm), and is
 * refused — flag or not — when its key names production as a word, it is the app's last
 * environment, or its app reports NIVARO_ENVIRONMENT=production (or cannot say). Also refused:
 * another app, not lower in promotion order, the same database, not SQL Server, no server login,
 * two Nivaro versions, an open move or data run on either.
 *
 * The plan PINS the target database (record id, server id, name, and the server's own database_id
 * + create_date); a start, a resume and a rollback refuse (TARGET_CHANGED) when any differs. The
 * run holds the promote lock (holder `data`) of BOTH environments, so neither is promoted while
 * it runs.
 *
 * What the target keeps is the target APP's own refresh registry (core entries as the Hub defines
 * them; an extension entry's `where` and delegates are left out and named).
 *
 * Run: strict maintenance on the target (must hold; the prior state is recorded) → rollback point
 * (COPY_ONLY backup of the target) → keep set captured, sealed → COPY_ONLY backup of the source
 * (its version checked again) → stage `restoring` recorded → OFFLINE WITH ROLLBACK IMMEDIATE +
 * RESTORE … WITH REPLACE → the restored identity pinned → the target's login owns the copy →
 * keep set applied → safety pass → source copy deleted → maintenance back to its prior state →
 * verify. A failure before the restore lifts the maintenance again; from the restore on, the
 * run can be resumed or rolled back (the rollback point stays ROLLBACK_HOURS).
 */

export const ROLLBACK_HOURS = 24
const KEEP_MAX_BYTES = 8 * 1024 * 1024
/** Other replicas of a dedicated app re-read maintenance within 15 s (hub link /maintenance). */
const MAINTENANCE_SETTLE_MS = 16_000

export const REFRESH_STEPS = [
  { key: 'maintenance_on', label: 'Put the target app in strict maintenance' },
  { key: 'rollback_point', label: 'Back up the target (rollback point)' },
  { key: 'keep_capture', label: 'Save what the target keeps' },
  { key: 'backup_source', label: 'Back up the source (copy-only)' },
  { key: 'restore', label: 'Restore the copy over the target' },
  { key: 'login', label: 'Give the copy back to the target’s login' },
  { key: 'keep_apply', label: 'Put back what the target keeps' },
  { key: 'safety', label: 'Safety pass (test modes, new partners off)' },
  { key: 'tidy', label: 'Delete the source copy file' },
  { key: 'maintenance_off', label: 'Put the target’s maintenance back as it was' },
  { key: 'verify', label: 'Check the target answers' }
] as const

export const ROLLBACK_STEPS = [
  { key: 'maintenance_on', label: 'Put the target app in strict maintenance' },
  { key: 'restore', label: 'Restore the rollback point over the target' },
  { key: 'login', label: 'Give the database back to the target’s login' },
  { key: 'maintenance_off', label: 'Put the target’s maintenance back as it was' }
] as const

export interface RefreshCheck {
  id: string
  state: 'ok' | 'warn' | 'fail'
  text: string
}

export interface KeptLine {
  id: string
  label: string
  table: string
  kind: string
  rows: number | null
  note: string | null
}

export interface DbIdentity {
  database_id: number
  create_date: string
}

export interface PinnedSide {
  env_id: number
  env_key: string
  database: string | null
  database_record_id: number | null
  server: string | null
  server_id: number | null
  version: string | null
}

export interface RefreshPlan {
  source: PinnedSide
  target: PinnedSide & {
    identity: DbIdentity | null
    /** What the target app says it is (NIVARO_ENVIRONMENT); null = it did not say. */
    app_environment: string | null
  }
  app: { id: number; key: string; name: string }
  same_server: boolean
  transfer_path: string | null
  kept: KeptLine[]
  left_out: Array<{ id: string; label: string; why: string }>
  overwritten: string
  notes: string[]
  checks: RefreshCheck[]
  blocked: boolean
  rollback_hours: number
  /** What a person types to start: the pinned target database's name. */
  confirm: string | null
  plan_hash: string
}

export interface RefreshDeps extends RunnerDeps {
  opener?: ServerOpener
  channel?: (envId: number) => Promise<AppChannel>
  promoteLock?: PromoteLock
  gate?: () => Promise<DataGate>
  sleep?: (ms: number) => Promise<void>
}

/** Pure: the refusals that depend only on the two environments' rows. */
export function refreshRefusals(source: EnvData, target: EnvData): RefreshCheck[] {
  const out: RefreshCheck[] = []
  if (source.app.id !== target.app.id)
    out.push({ id: 'other_app', state: 'fail', text: 'The source belongs to another app.' })
  if (source.env.id === target.env.id)
    out.push({
      id: 'same_env',
      state: 'fail',
      text: 'An environment cannot be refreshed from itself.'
    })
  out.push(...targetRefusals(target, undefined))
  if (target.env.position >= source.env.position)
    out.push({
      id: 'not_lower',
      state: 'fail',
      text: `${target.env.key} is not lower than ${source.env.key} in promotion order: refresh only copies down.`
    })
  if (
    source.database &&
    target.database &&
    source.database.server_id !== null &&
    source.database.server_id === target.database.server_id &&
    source.database.database_name.toLowerCase() === target.database.database_name.toLowerCase()
  )
    out.push({
      id: 'same_database',
      state: 'fail',
      text: 'Both environments use the same database.'
    })
  return out
}

/**
 * Pure: why the Hub may not write over this environment's database. `appEnvironment` undefined =
 * not asked (rows only); null = the app did not say (refused for a refresh, allowed for the
 * rollback of a refresh that was verified when it was planned).
 */
export function targetRefusals(
  target: EnvData,
  appEnvironment: string | null | undefined,
  o: { forRollback?: boolean } = {}
): RefreshCheck[] {
  const out: RefreshCheck[] = []
  for (const why of target.production_reasons)
    out.push({
      id: 'production_target',
      state: 'fail',
      text: `${target.env.key} counts as production (${why}): the Hub never writes over production.`
    })
  if (!target.env.refresh_target)
    out.push({
      id: 'not_opted_in',
      state: 'fail',
      text: `${target.env.key} is not opted in as a refresh target: an administrator turns that on for this environment first.`
    })
  if (appEnvironment === 'production')
    out.push({
      id: 'app_says_production',
      state: 'fail',
      text: `The ${target.env.key} app reports itself as production (NIVARO_ENVIRONMENT).`
    })
  if (appEnvironment === null && !o.forRollback)
    out.push({
      id: 'target_unverified',
      state: 'fail',
      text: `The ${target.env.key} app did not say which environment it is (its link did not answer): the Hub only writes over an app that says it is not production.`
    })
  return out
}

/**
 * The entries the Hub applies from what the app sent: valid ones only; core ids always use the
 * Hub's own core definitions; a `where` the Hub's core does not carry is left out (it would run
 * the app's SQL text with the server's login); delegates are left out (a host step runs them).
 */
export function trustedKeeps(sent: unknown): {
  keeps: EnvKeepEntry[]
  left_out: Array<{ id: string; label: string; why: string }>
} {
  const core = new Map(CORE_KEEPS.map((e) => [e.id, e]))
  const keeps: EnvKeepEntry[] = []
  const left_out: Array<{ id: string; label: string; why: string }> = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(sent) ? sent : []) {
    const e = raw as EnvKeepEntry
    const id = typeof e?.id === 'string' ? e.id.slice(0, 120) : '?'
    const label = typeof e?.label === 'string' ? e.label.slice(0, 200) : id
    if (seen.has(id)) continue
    seen.add(id)
    if (core.has(id)) {
      keeps.push(core.get(id) as EnvKeepEntry)
      continue
    }
    try {
      validateKeepEntry(e)
    } catch (err) {
      left_out.push({
        id,
        label,
        why: err instanceof EnvKeepError ? err.message : 'not a keep entry'
      })
      continue
    }
    if (e.kind === 'delegate') {
      left_out.push({
        id,
        label,
        why: `kept by a host step (${e.handled_by ?? 'delegate'}) the Hub does not run`
      })
      continue
    }
    if (e.where) {
      left_out.push({ id, label, why: 'a row filter the Hub does not run with the server’s login' })
      continue
    }
    keeps.push({ ...e, source: typeof e.source === 'string' ? e.source : 'extension' })
  }
  // A core entry the app did not send (an older registry) is still kept.
  for (const c of CORE_KEEPS)
    if (!seen.has(c.id) && c.kind !== 'delegate' && !c.only_when) keeps.push(c)
  return {
    keeps: keeps.filter((k) => k.kind !== 'delegate' && !k.only_when),
    left_out
  }
}

export function planHash(p: Omit<RefreshPlan, 'plan_hash'>): string {
  const stable = {
    s: [p.source.env_id, p.source.database_record_id, p.source.server_id, p.source.version],
    t: [
      p.target.env_id,
      p.target.database_record_id,
      p.target.server_id,
      p.target.database,
      p.target.identity?.database_id ?? null,
      p.target.identity?.create_date ?? null,
      p.target.version
    ],
    path: p.transfer_path,
    kept: p.kept.map((k) => k.id),
    checks: p.checks.filter((c) => c.state === 'fail').map((c) => c.id)
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

const runner = (exec: SqlExec): SqlRunner => ({ raw: (sql, b) => exec(sql, b) })

function accessOrCheck(d: EnvData, who: string, checks: RefreshCheck[]): ServerAccess | null {
  try {
    return serverAccessOf(d)
  } catch (err) {
    checks.push({
      id: `${who}_server`,
      state: 'fail',
      text: `${who === 'source' ? 'Source' : 'Target'}: ${(err as Error).message}`
    })
    return null
  }
}

export async function readIdentity(exec: SqlExec, database: string): Promise<DbIdentity | null> {
  const [r] = await exec(identitySql(database))
  if (!r || r.database_id == null) return null
  return { database_id: Number(r.database_id), create_date: String(r.create_date ?? '') }
}

const sameIdentity = (a: DbIdentity | null | undefined, b: DbIdentity | null | undefined) =>
  !!a && !!b && a.database_id === b.database_id && a.create_date === b.create_date

/** What the target app answers on refresh-keeps: its keep entries and what it says it is. */
async function targetAnswer(
  ch: AppChannel
): Promise<{ keeps: unknown; environment: string | null } | null> {
  try {
    const a = (await ch.call('GET', dataPath(ch, 'refresh-keeps'))) as {
      keeps?: unknown
      environment?: unknown
    } | null
    if (!a) return null
    return {
      keeps: a.keeps,
      environment: typeof a.environment === 'string' ? a.environment.slice(0, 32) : null
    }
  } catch {
    return null
  }
}

export async function planRefresh(
  targetEnvId: number,
  body: Record<string, unknown>,
  deps: RefreshDeps = {}
): Promise<RefreshPlan> {
  const sourceId = Number(body.source_env_id)
  if (!Number.isSafeInteger(sourceId) || sourceId < 1)
    throw new DataError('BAD_TARGET', 'source_env_id must name the environment to copy from.', 400)
  const [source, target] = await Promise.all([envData(sourceId), envData(targetEnvId)])
  const checks = refreshRefusals(source, target)
  const gate = await (deps.gate ?? readGate)()
  if (!gate.refresh_enabled)
    checks.push({
      id: 'feature_off',
      state: 'fail',
      text: 'Refreshes are switched off on this Hub (Backups & data → Switches).'
    })
  const sAccess = accessOrCheck(source, 'source', checks)
  const tAccess = accessOrCheck(target, 'target', checks)
  const sameServer = !!sAccess && !!tAccess && sAccess.server.id === tAccess.server.id
  const pathRaw = body.transfer_path
  let transfer_path: string | null = null
  if (pathRaw !== undefined && pathRaw !== null && pathRaw !== '') {
    if (!isServerFolder(pathRaw))
      throw new DataError(
        'BAD_PATH',
        'transfer_path must be a folder both servers can read (\\\\server\\share\\…).',
        400
      )
    transfer_path = pathRaw
  }
  if (sAccess && tAccess && !sameServer && !transfer_path)
    checks.push({
      id: 'transfer_path',
      state: 'fail',
      text: 'The two databases are on different servers: name a shared folder (UNC path) both servers can read.'
    })

  const move = await openMoveFor({ envIds: [sourceId, targetEnvId] })
  if (move) checks.push({ id: 'move_open', state: 'fail', text: moveOpenMessage(move) })
  for (const id of [sourceId, targetEnvId]) {
    const open = await openRunFor(id)
    if (open && open.id !== Number(body.resuming_run ?? 0))
      checks.push({
        id: 'data_busy',
        state: 'fail',
        text: `A ${open.kind.replace('_', ' ')} (run ${open.id}) is still open on ${id === sourceId ? 'the source' : 'the target'}.`
      })
  }

  const chFor = deps.channel ?? appChannelFor
  const [sCh, tCh] = await Promise.all([chFor(sourceId), chFor(targetEnvId)])
  const [sVersion, tVersion, answer] = await Promise.all([
    sCh.version(),
    tCh.version(),
    targetAnswer(tCh)
  ])
  if (!sVersion || !tVersion)
    checks.push({
      id: 'version_unknown',
      state: 'fail',
      text: `The ${!sVersion ? 'source' : 'target'} app did not say which Nivaro version it runs (its link did not answer).`
    })
  else if (sVersion !== tVersion)
    checks.push({
      id: 'version_mismatch',
      state: 'fail',
      text: `The source runs ${sVersion} and the target ${tVersion}: promote the target to ${sVersion} first, so the copy matches its migrations.`
    })
  const appEnvironment = answer ? answer.environment : null
  checks.push(
    ...targetRefusals(target, appEnvironment).filter(
      (c) => c.id === 'app_says_production' || c.id === 'target_unverified'
    )
  )
  const trusted = trustedKeeps(answer?.keeps)
  const entries = trusted.keeps

  let kept: KeptLine[] = entries.map((e) => ({
    id: e.id,
    label: e.label,
    table: e.table,
    kind: e.kind,
    rows: null,
    note: null
  }))
  let identity: DbIdentity | null = null
  if (tAccess && target.database) {
    try {
      const out = await (deps.opener ?? withServerExec)(tAccess, async (exec) => ({
        identity: await readIdentity(exec, tAccess.database),
        saved: await captureKeepSet(runner(exec), {
          entries,
          direction: `${source.env.key}-to-${target.env.key}`,
          sourceDb: source.database?.database_name ?? '',
          targetDb: tAccess.database,
          sampleOver: 0
        })
      }))
      identity = out.identity
      kept = out.saved.entries.map((s) => ({
        id: s.id,
        label: s.label,
        table: s.table,
        kind: s.kind,
        rows: s.missing ? null : s.total,
        note: s.missing ?? null
      }))
      if (!identity)
        checks.push({
          id: 'target_missing',
          state: 'fail',
          text: `${tAccess.database} does not exist on ${tAccess.server.name}.`
        })
    } catch (err) {
      checks.push({
        id: 'keep_read',
        state: 'fail',
        text: `The target database could not be read: ${errText(err).slice(0, 200)}`
      })
    }
  }

  const side = (d: EnvData, a: ServerAccess | null, version: string | null): PinnedSide => ({
    env_id: d.env.id,
    env_key: d.env.key,
    database: d.database?.database_name ?? null,
    database_record_id: d.database?.id ?? null,
    server: a?.server.name ?? null,
    server_id: a?.server.id ?? null,
    version
  })
  const plan: Omit<RefreshPlan, 'plan_hash'> = {
    source: side(source, sAccess, sVersion),
    target: { ...side(target, tAccess, tVersion), identity, app_environment: appEnvironment },
    app: source.app,
    same_server: sameServer,
    transfer_path,
    kept,
    left_out: trusted.left_out,
    overwritten: target.database
      ? `The whole of ${target.database.database_name} is replaced by a copy of ${source.database?.database_name ?? 'the source'} taken when the run starts; every record, file row, user and setting comes from ${source.env.key}, except what is listed as kept.`
      : 'Nothing: the target has no database record.',
    notes: [
      'The target app is held in strict maintenance for the whole run (nobody signs in, administrators included).',
      'The target app keeps its in-memory caches and sessions: restart it after the refresh.',
      'Backups the Hub writes are not encrypted: the backup folder must be one only database administrators can read.'
    ],
    checks,
    blocked: checks.some((c) => c.state === 'fail'),
    rollback_hours: ROLLBACK_HOURS,
    confirm: target.database?.database_name ?? null
  }
  return { ...plan, plan_hash: planHash(plan) }
}

// ─── maintenance on the target ─────────────────────────────────────────────────────────────

/**
 * Strict maintenance on (refuses when it does not hold) or back to the state recorded before
 * the run (`prior`: on a dedicated app whether maintenance was already on; on a shared app the
 * environment's listed status). The prior state is recorded once, never overwritten by a resume.
 */
async function setMaintenance(
  ch: AppChannel,
  envId: number,
  on: boolean,
  art: Record<string, unknown>,
  save: (extra: Record<string, unknown>) => Promise<void>,
  sleep: (ms: number) => Promise<void>
): Promise<string> {
  if (ch.kind === 'dedicated') {
    if (on) {
      if (art.prior_maintenance === undefined) {
        let prior: boolean | null = null
        try {
          const st = (await ch.call('GET', 'status')) as { maintenance?: unknown } | null
          prior = typeof st?.maintenance === 'boolean' ? st.maintenance : null
        } catch {
          prior = null
        }
        await save({ prior_maintenance: prior })
      }
      await ch.call('POST', 'maintenance', {
        on: true,
        message: 'This environment is being refreshed from another one.'
      })
      await sleep(MAINTENANCE_SETTLE_MS)
      return 'Strict maintenance on (every replica, administrators included).'
    }
    if (art.prior_maintenance === true) return 'Maintenance was on before the run: left on.'
    await ch.call('POST', 'maintenance', { on: false })
    return 'Maintenance is off again.'
  }
  if (on) {
    if (art.prior_status === undefined) {
      const env = (await db('nivaro_hub_environments').where({ id: envId }).first('status')) as
        | { status: string }
        | undefined
      await save({ prior_status: env?.status ?? 'active' })
    }
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update({ status: 'maintenance', updated_at: new Date() })
  } else {
    const prior = typeof art.prior_status === 'string' ? art.prior_status : 'active'
    await db('nivaro_hub_environments')
      .where({ id: envId, status: 'maintenance' })
      .update({ status: prior, updated_at: new Date() })
  }
  if (ch.shared) await deploymentClient(ch.shared).refresh()
  if (on) await sleep(MAINTENANCE_SETTLE_MS)
  return on
    ? 'Listed as maintenance on its shared deployment.'
    : 'Listed as it was before the run on its shared deployment.'
}

// ─── pins ──────────────────────────────────────────────────────────────────────────────────

/** The environment still points at the pinned database record, server and name. */
export function pinRefusal(plan: Pick<RefreshPlan, 'target'>, now: EnvData): string | null {
  const t = plan.target
  if (!now.database) return 'The target environment no longer has a database record.'
  if (now.database.id !== t.database_record_id)
    return 'The target environment points at another database record than the one this refresh was planned on.'
  if (now.database.server_id !== t.server_id)
    return 'The target database record now names another server.'
  if (now.database.database_name !== t.database)
    return `The target database record now names ${now.database.database_name}, not ${t.database}.`
  return null
}

/**
 * The live database must be the pinned one: before the restore started its identity must equal
 * the plan's; after it finished, the restored identity. While a restore was cut short the
 * identity is not comparable (the database may be RESTORING) and only the record pins hold.
 */
async function assertPinned(
  exec: SqlExec,
  plan: Pick<RefreshPlan, 'target'>,
  art: Record<string, unknown>,
  now: EnvData
): Promise<void> {
  const why = pinRefusal(plan, now)
  if (why) throw new DataError('TARGET_CHANGED', why)
  const database = String(plan.target.database)
  const restoring = !!art.restore_started_at && !art.restored_at
  if (restoring) return
  const want = (art.restored_identity as DbIdentity | undefined) ?? plan.target.identity
  const live = await readIdentity(exec, database)
  if (!sameIdentity(live, want))
    throw new DataError(
      'TARGET_CHANGED',
      `${database} on the server is not the database this refresh was planned on (its id or creation time changed).`
    )
}

// ─── run ───────────────────────────────────────────────────────────────────────────────────

interface RefreshTarget {
  plan: RefreshPlan
  source: EnvData
  target: EnvData
  sAccess: ServerAccess
  tAccess: ServerAccess
  entries: EnvKeepEntry[]
}

function refreshBody(t: RefreshTarget, deps: RefreshDeps) {
  const opener = deps.opener ?? withServerExec
  const chFor = deps.channel ?? appChannelFor
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  return async (ctx: RunCtx) => {
    const [ch, sCh] = await Promise.all([chFor(t.target.env.id), chFor(t.source.env.id)])
    const prior = (await readRun(ctx.id))?.artifact ?? {}
    const art: Record<string, unknown> = { ...prior }
    const save = async (extra: Record<string, unknown>) => {
      Object.assign(art, extra)
      await ctx.patch({ artifact: { ...art } })
    }
    const targetDb = String(t.plan.target.database)
    const sameServer = t.sAccess.server.id === t.tAccess.server.id
    await opener(t.tAccess, async (texec) => {
      await assertPinned(texec, t.plan, art, t.target)
      const withSource = <T>(fn: (sexec: SqlExec) => Promise<T>) =>
        sameServer ? fn(texec) : opener(t.sAccess, fn)
      const now = new Date()
      await ctx.step('maintenance_on', () =>
        setMaintenance(ch, t.target.env.id, true, art, save, sleep)
      )
      await ctx.step('rollback_point', async () => {
        const folder =
          t.plan.transfer_path ??
          (await backupFolder(texec, (await readPolicy(t.target.env.id)).db_path))
        const file = joinServerPath(
          folder,
          backupFileName({
            app: t.target.app.key,
            env: t.target.env.key,
            label: 'before_refresh',
            runId: ctx.id,
            at: now
          })
        )
        await save({ rollback_file: file, rollback_server_id: t.tAccess.server.id })
        await backupInto(texec, targetDb, file)
        await ctx.patch({ expiresAt: new Date(Date.now() + ROLLBACK_HOURS * 3600_000) })
        return `Rollback point ${file} (kept ${ROLLBACK_HOURS} h).`
      })
      await ctx.step('keep_capture', async () => {
        const saved = await captureKeepSet(runner(texec), {
          entries: t.entries,
          direction: `${t.source.env.key}-to-${t.target.env.key}`,
          sourceDb: t.sAccess.database,
          targetDb
        })
        const json = JSON.stringify(saved)
        if (Buffer.byteLength(json) > KEEP_MAX_BYTES)
          throw new DataError(
            'PLAN_BLOCKED',
            'What the target keeps is over 8 MB: the Hub does not hold that much; nothing was changed.'
          )
        await ctx.patch({ keepSecret: sealSecret(json) })
        const rows = saved.entries.reduce((n, e) => n + e.rows.length, 0)
        return `${saved.entries.length} entries, ${rows} rows saved (sealed).`
      })
      await ctx.step('backup_source', async () => {
        // The source may not have moved on since the plan (its promote lock is held now).
        const v = await sCh.version()
        if (v !== t.plan.source.version)
          throw new DataError(
            'VERSION_MISMATCH',
            `The source now runs ${v ?? 'an unknown version'}, not ${t.plan.source.version}: plan again.`
          )
        const file = await withSource(async (sexec) => {
          const folder =
            t.plan.transfer_path ??
            (await backupFolder(sexec, (await readPolicy(t.source.env.id)).db_path))
          const f = joinServerPath(
            folder,
            backupFileName({
              app: t.source.app.key,
              env: t.source.env.key,
              label: 'refresh_copy',
              runId: ctx.id,
              at: now
            })
          )
          await save({ source_file: f, source_server_id: t.sAccess.server.id })
          await backupInto(sexec, t.sAccess.database, f)
          return f
        })
        return `Source copy ${file}.`
      })
      await ctx.step('restore', async () => {
        const file = String(art.source_file)
        const files = await texec(fileListSqlFor(file))
        const own = await texec(databaseFilesSql(targetDb))
        const moves = movesOverTarget(
          files.map((f) => ({
            logical: String(f.LogicalName),
            physical: String(f.PhysicalName),
            type: String(f.Type ?? 'D')
          })),
          own.map((f) => ({
            logical: String(f.logical),
            physical: String(f.physical),
            type_id: Number(f.type_id)
          })),
          Date.now().toString(36)
        )
        // Recorded BEFORE the statement: a restore cut short still leaves a usable rollback.
        await save({ stage: 'restoring', restore_started_at: new Date().toISOString() })
        const t0 = Date.now()
        try {
          await texec(restoreOverSql(targetDb, file, moves))
        } catch (err) {
          await texec(onlineSql(targetDb)).catch(() => undefined)
          throw err
        }
        await save({
          stage: 'restored',
          restored_at: new Date().toISOString(),
          restore_ms: Date.now() - t0,
          restored_identity: await readIdentity(texec, targetDb)
        })
        return `${targetDb} replaced in ${Math.round((Date.now() - t0) / 1000)} s.`
      })
      await ctx.step('login', async () => {
        const login = await appLoginOf(t.tAccess.databaseId)
        await texec(mapLoginSql(targetDb, login))
        let sourceLogin: string | null = null
        try {
          sourceLogin = await appLoginOf(t.sAccess.databaseId)
        } catch {
          sourceLogin = null
        }
        if (sourceLogin && sourceLogin.toLowerCase() !== login.toLowerCase())
          await texec(dropLoginUserSql(targetDb, sourceLogin)).catch(() => undefined)
        return 'The target’s login owns the copy (db_owner); the source’s login has no user there.'
      })
      let saved: SavedKeepSet | null = null
      await ctx.step('keep_apply', async () => {
        const plain = openSecret(await readKeepSecret(ctx.id))
        if (!plain)
          throw new DataError(
            'NO_ROLLBACK',
            'The saved keep set is gone: roll back to the rollback point.'
          )
        saved = JSON.parse(plain) as SavedKeepSet
        const results = await applyKeepSet(runner(texec), saved, targetDb)
        const errors = results.flatMap((r) => r.errors)
        const current = (await readRun(ctx.id))?.result ?? {}
        await ctx.patch({
          result: {
            ...current,
            keep: results.map((r) => ({
              id: r.id,
              written: r.written,
              inserted: r.inserted,
              skipped: r.skipped,
              errors: r.errors.length
            }))
          }
        })
        return {
          note: `${results.reduce((n, r) => n + r.written, 0)} rows put back${errors.length ? `, ${errors.length} errors` : ''}.`,
          warn: errors.length > 0
        }
      })
      await ctx.step('safety', async () => {
        if (!saved) {
          const plain = openSecret(await readKeepSecret(ctx.id))
          saved = plain ? (JSON.parse(plain) as SavedKeepSet) : null
        }
        const actions = await runSafetyPass(runner(texec), {
          readDb: targetDb,
          writeDb: targetDb,
          instanceKey: null,
          saved,
          dry: false
        })
        const errs = actions.filter((a) => a.error).length
        return {
          note: actions
            .map((a) => `${a.label}: ${a.count}`)
            .join('; ')
            .slice(0, 400),
          warn: errs > 0
        }
      })
      await ctx.step('tidy', async () => {
        const file = String(art.source_file ?? '')
        if (!file) return { skipped: true }
        try {
          await withSource((sexec) => sexec(deleteFileSql(file)))
          await save({ source_file_deleted_at: new Date().toISOString() })
          return 'Source copy deleted.'
        } catch {
          return {
            warn: true,
            note: `${file} could not be deleted (the login needs sysadmin): a DBA can remove it.`
          }
        }
      })
    })
    await ctx.step('maintenance_off', async () => {
      try {
        return await setMaintenance(ch, t.target.env.id, false, art, save, sleep)
      } catch (err) {
        return {
          warn: true,
          note: `Maintenance could not be put back (${errText(err).slice(0, 120)}): lift it on the app.`
        }
      }
    })
    await ctx.step('verify', async () => {
      const v = await ch.version()
      if (!v) return { warn: true, note: 'The target did not answer its link yet.' }
      return {
        note: `The target answers (Nivaro ${v}). Restart it so it drops caches and sessions from before the refresh.`,
        warn: true
      }
    })
    return { artifact: { ...art } }
  }
}

/** A failed refresh that never reached its restore puts the target's maintenance back. */
function refreshCleanup(t: RefreshTarget, deps: RefreshDeps, release: () => Promise<void>) {
  return async (ctx: RunCtx, failed: boolean) => {
    try {
      if (!failed) return
      const run = await readRun(ctx.id)
      const art = run?.artifact ?? {}
      if (art.restore_started_at) return // the database may be mid-restore: resume or roll back
      const tookMaintenance = run?.steps.find((s) => s.key === 'maintenance_on')
      if (!tookMaintenance || tookMaintenance.state === 'pending') return
      const ch = await (deps.channel ?? appChannelFor)(t.target.env.id)
      await setMaintenance(
        ch,
        t.target.env.id,
        false,
        art,
        async () => {},
        async () => {}
      ).catch(() => undefined)
      ctx.log('hub data refresh: failed before its restore, maintenance put back')
    } finally {
      await release()
    }
  }
}

async function withEnvLocks<T>(
  lock: PromoteLock,
  envIds: number[],
  fn: (release: () => Promise<void>) => Promise<T>
): Promise<T> {
  const held: Array<[number, string]> = []
  try {
    for (const envId of [...new Set(envIds)]) {
      const token = await lock.take(envId, 'data')
      if (!token) {
        const holder = lock.holder ? await lock.holder(envId).catch(() => null) : null
        const r = lockHolderRefusal(
          holder,
          {
            code: 'ENV_BUSY',
            message: 'Something else is changing this environment — wait for it to end.'
          },
          'data'
        )
        throw new DataError('ENV_BUSY', r.message)
      }
      held.push([envId, token])
    }
  } catch (err) {
    for (const [e, tk] of held) await lock.release(e, tk)
    throw err
  }
  const timer = setInterval(() => {
    for (const [e, tk] of held) void lock.renew(e, tk).catch(() => undefined)
  }, LOCK_RENEW_MS)
  timer.unref?.()
  let released = false
  const release = async () => {
    if (released) return
    released = true
    clearInterval(timer)
    for (const [e, tk] of held) await lock.release(e, tk)
  }
  try {
    return await fn(release)
  } catch (err) {
    await release()
    throw err
  }
}

async function targetsFor(plan: RefreshPlan, entries: EnvKeepEntry[]): Promise<RefreshTarget> {
  const [source, target] = await Promise.all([
    envData(plan.source.env_id),
    envData(plan.target.env_id)
  ])
  const why = pinRefusal(plan, target)
  if (why) throw new DataError('TARGET_CHANGED', why)
  return {
    plan,
    source,
    target,
    sAccess: serverAccessOf(source),
    tAccess: serverAccessOf(target),
    entries
  }
}

async function keepEntries(targetEnvId: number, deps: RefreshDeps): Promise<EnvKeepEntry[]> {
  const ch = await (deps.channel ?? appChannelFor)(targetEnvId)
  const a = await targetAnswer(ch)
  if (!a)
    throw new DataError(
      'TARGET_UNVERIFIED',
      'The target app did not answer what it keeps: nothing was started.'
    )
  return trustedKeeps(a.keeps).keeps
}

export async function startRefresh(
  targetEnvId: number,
  body: Record<string, unknown>,
  by: string | null,
  deps: RefreshDeps = {}
): Promise<number> {
  await assertGate('refresh_enabled', deps.gate ? await deps.gate() : undefined)
  const plan = await planRefresh(targetEnvId, body, deps)
  if (body.plan_hash !== plan.plan_hash)
    throw new DataError(
      'PLAN_CHANGED',
      'The plan changed since it was shown: look at it again.',
      409,
      {
        plan
      }
    )
  if (plan.blocked)
    throw new DataError('PLAN_BLOCKED', 'The plan has refusals: nothing was started.', 409, {
      plan
    })
  if (typeof body.confirm !== 'string' || body.confirm.trim() !== plan.confirm)
    throw new DataError(
      'CONFIRM_MISMATCH',
      `Type the target database name (${plan.confirm}) to start.`,
      400
    )
  const t = await targetsFor(plan, await keepEntries(targetEnvId, deps))
  const lock = deps.promoteLock ?? defaultPromoteLock()
  return withEnvLocks(lock, [targetEnvId, plan.source.env_id], async (release) =>
    startDataRun({
      kind: 'refresh',
      environmentId: targetEnvId,
      sourceEnvironmentId: plan.source.env_id,
      envIds: [targetEnvId, plan.source.env_id],
      steps: REFRESH_STEPS,
      plan: { ...plan, entries: t.entries.map((e) => e.id) } as unknown as Record<string, unknown>,
      planHash: plan.plan_hash,
      by,
      deps,
      body: refreshBody(t, deps),
      cleanup: refreshCleanup(t, deps, release)
    })
  )
}

/** Why a refresh cannot be resumed (null = it can). */
export function resumeRefusal(run: DataRun): string | null {
  if (run.kind !== 'refresh') return 'Only a refresh resumes this way.'
  if (run.status !== 'interrupted' && run.status !== 'failed')
    return 'Only an interrupted or failed refresh can be resumed.'
  if (run.artifact?.rolled_back_at) return 'This refresh was rolled back.'
  if (run.artifact?.abandoned_at) return 'This refresh was abandoned.'
  return null
}

/**
 * Continues an interrupted or failed refresh from its first step not done, after checking again
 * everything a start checks: the switch, the target's production rules and opt-in, the order and
 * both versions (against the plan), and that the target is still the pinned database.
 */
export async function resumeRefresh(runId: number, deps: RefreshDeps = {}): Promise<void> {
  const run = await readRun(runId)
  if (!run) throw new DataError('NOT_FOUND', 'No such refresh.', 404)
  const why = resumeRefusal(run)
  if (why) throw new DataError('NOT_RESUMABLE', why)
  await assertGate('refresh_enabled', deps.gate ? await deps.gate() : undefined)
  const plan = run.plan as unknown as RefreshPlan & { entries?: string[] }
  const [source, target] = await Promise.all([
    envData(plan.source.env_id),
    envData(plan.target.env_id)
  ])
  const chFor = deps.channel ?? appChannelFor
  const [sCh, tCh] = await Promise.all([chFor(source.env.id), chFor(target.env.id)])
  const [sv, tv, answer] = await Promise.all([sCh.version(), tCh.version(), targetAnswer(tCh)])
  const restoring = !!run.artifact?.restore_started_at
  const checks = [
    ...refreshRefusals(source, target),
    // A target mid-restore may not answer: it was verified when it was planned.
    ...targetRefusals(target, answer?.environment ?? null, { forRollback: restoring }).filter(
      (c) => c.id === 'app_says_production' || c.id === 'target_unverified'
    )
  ].filter((c) => c.state === 'fail')
  if (sv !== plan.source.version)
    checks.push({
      id: 'version',
      state: 'fail',
      text: 'The source runs another version than planned.'
    })
  if (!restoring && tv !== plan.target.version)
    checks.push({
      id: 'version',
      state: 'fail',
      text: 'The target runs another version than planned.'
    })
  if (checks.length)
    throw new DataError('PLAN_BLOCKED', checks.map((c) => c.text).join(' '), 409, { checks })
  const ids = new Set(plan.entries ?? [])
  const known = new Map(CORE_KEEPS.map((e) => [e.id, e]))
  for (const e of trustedKeeps(answer?.keeps).keeps) known.set(e.id, e)
  const t = await targetsFor(
    plan,
    [...ids].map((id) => known.get(id)).filter((e): e is EnvKeepEntry => !!e)
  )
  const lock = deps.promoteLock ?? defaultPromoteLock()
  await withEnvLocks(lock, [run.environment_id, plan.source.env_id], async (release) =>
    resumeDataRun(runId, {
      envIds: [run.environment_id, plan.source.env_id],
      statuses: ['interrupted', 'failed'],
      deps,
      body: refreshBody(t, deps),
      cleanup: refreshCleanup(t, deps, release)
    })
  )
}

/** The newest refresh or refresh rollback of an environment. */
export async function newestRefreshRun(envId: number): Promise<DataRun | null> {
  const r = (await db('nivaro_hub_data_runs')
    .where({ environment_id: envId })
    .whereIn('kind', ['refresh', 'refresh_rollback'])
    .orderBy('id', 'desc')
    .first()) as Record<string, unknown> | undefined
  return r ? runFromRow(r) : null
}

/** Whether a refresh can still be rolled back, and why not. */
export function rollbackRefusal(
  run: DataRun,
  now = new Date(),
  newest: Pick<DataRun, 'id'> | null = null
): string | null {
  if (run.kind !== 'refresh') return 'Only a refresh can be rolled back.'
  if (run.status === 'running' || run.status === 'waiting') return 'The refresh is still running.'
  if (newest && newest.id !== run.id)
    return 'A newer refresh or rollback ran on this environment since: only the newest can be rolled back.'
  if (typeof run.artifact?.rollback_file !== 'string') return 'This refresh made no rollback point.'
  if (run.artifact?.rollback_deleted_at || run.artifact?.rolled_back_at)
    return run.artifact?.rolled_back_at
      ? 'This refresh was already rolled back.'
      : 'Its rollback point is gone.'
  if (!run.artifact?.restore_started_at && !run.artifact?.restored_at)
    return 'The target was never replaced: nothing to roll back.'
  if (!run.expires_at || Date.parse(run.expires_at) < now.getTime())
    return 'The rollback window has ended.'
  return null
}

function rollbackBody(
  refreshRun: DataRun,
  target: EnvData,
  tAccess: ServerAccess,
  deps: RefreshDeps
) {
  const opener = deps.opener ?? withServerExec
  const chFor = deps.channel ?? appChannelFor
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const plan = refreshRun.plan as unknown as RefreshPlan
  const file = String(refreshRun.artifact?.rollback_file)
  const database = String(plan.target.database)
  return async (ctx: RunCtx) => {
    const ch = await chFor(target.env.id)
    // The refresh's own prior maintenance state is what the rollback puts back.
    const art: Record<string, unknown> = {
      prior_maintenance: refreshRun.artifact?.prior_maintenance,
      prior_status: refreshRun.artifact?.prior_status,
      ...((await readRun(ctx.id))?.artifact ?? {})
    }
    const save = async (extra: Record<string, unknown>) => {
      Object.assign(art, extra)
      await ctx.patch({ artifact: { ...art } })
    }
    await ctx.step('maintenance_on', async () => {
      try {
        return await setMaintenance(ch, target.env.id, true, art, save, sleep)
      } catch (err) {
        // A target whose restore failed may not answer at all; the OFFLINE restore below still
        // puts every session out.
        return {
          warn: true,
          note: `The app did not take maintenance (${errText(err).slice(0, 120)}).`
        }
      }
    })
    await opener(tAccess, async (texec) => {
      await assertPinned(texec, plan, refreshRun.artifact ?? {}, target)
      await ctx.step('restore', async () => {
        const files = await texec(fileListSqlFor(file))
        const own = await texec(databaseFilesSql(database))
        const moves = movesOverTarget(
          files.map((f) => ({
            logical: String(f.LogicalName),
            physical: String(f.PhysicalName),
            type: String(f.Type ?? 'D')
          })),
          own.map((f) => ({
            logical: String(f.logical),
            physical: String(f.physical),
            type_id: Number(f.type_id)
          })),
          Date.now().toString(36)
        )
        try {
          await texec(restoreOverSql(database, file, moves))
        } catch (err) {
          await texec(onlineSql(database)).catch(() => undefined)
          throw err
        }
        await patchRun(refreshRun.id, {
          artifact: {
            ...refreshRun.artifact,
            rolled_back_at: new Date().toISOString(),
            rollback_run: ctx.id
          },
          keepSecret: null,
          ...(['interrupted', 'failed'].includes(refreshRun.status)
            ? { status: 'cancelled' as const, finished: true }
            : {})
        })
        return `${database} is back as it was before refresh ${refreshRun.id}.`
      })
      await ctx.step('login', async () => {
        await texec(mapLoginSql(database, await appLoginOf(tAccess.databaseId)))
        return 'The target’s login owns the database.'
      })
    })
    await ctx.step('maintenance_off', async () => {
      try {
        return await setMaintenance(ch, target.env.id, false, art, save, sleep)
      } catch (err) {
        return {
          warn: true,
          note: `Maintenance could not be put back (${errText(err).slice(0, 120)}).`
        }
      }
    })
    return {}
  }
}

async function rollbackContext(refreshRun: DataRun, deps: RefreshDeps) {
  await assertGate('refresh_enabled', deps.gate ? await deps.gate() : undefined)
  const plan = refreshRun.plan as unknown as RefreshPlan
  const target = await envData(refreshRun.environment_id)
  const refusals = targetRefusals(target, undefined).filter((c) => c.state === 'fail')
  const ch = await (deps.channel ?? appChannelFor)(target.env.id)
  const answer = await targetAnswer(ch)
  refusals.push(
    ...targetRefusals(target, answer?.environment ?? null, { forRollback: true }).filter(
      (c) => c.id === 'app_says_production'
    )
  )
  if (refusals.length)
    throw new DataError('PRODUCTION_TARGET', refusals.map((c) => c.text).join(' '))
  const why = pinRefusal(plan, target)
  if (why) throw new DataError('TARGET_CHANGED', why)
  return { plan, target, tAccess: serverAccessOf(target) }
}

export async function startRefreshRollback(
  refreshRunId: number,
  body: Record<string, unknown>,
  by: string | null,
  deps: RefreshDeps = {}
): Promise<number> {
  const run = await readRun(refreshRunId)
  if (!run) throw new DataError('NOT_FOUND', 'No such refresh.', 404)
  const why = rollbackRefusal(run, new Date(), await newestRefreshRun(run.environment_id))
  if (why)
    throw new DataError(
      why.includes('ended')
        ? 'ROLLBACK_EXPIRED'
        : why.includes('newer')
          ? 'NOT_NEWEST'
          : 'NO_ROLLBACK',
      why
    )
  const { plan, target, tAccess } = await rollbackContext(run, deps)
  if (typeof body.confirm !== 'string' || body.confirm.trim() !== plan.target.database)
    throw new DataError(
      'CONFIRM_MISMATCH',
      `Type the database the refresh replaced (${plan.target.database}) to roll back.`,
      400
    )
  const lock = deps.promoteLock ?? defaultPromoteLock()
  return withEnvLocks(lock, [run.environment_id], async (release) =>
    startDataRun({
      kind: 'refresh_rollback',
      environmentId: run.environment_id,
      sourceEnvironmentId: run.source_environment_id,
      envIds: [run.environment_id],
      steps: ROLLBACK_STEPS,
      plan: {
        refresh_run: refreshRunId,
        file: run.artifact?.rollback_file,
        database: plan.target.database
      },
      by,
      deps,
      cleanup: async () => release(),
      body: rollbackBody(run, target, tAccess, deps)
    })
  )
}

/** Continues an interrupted (or failed) rollback. */
export async function resumeRefreshRollback(runId: number, deps: RefreshDeps = {}): Promise<void> {
  const rb = await readRun(runId)
  if (rb?.kind !== 'refresh_rollback') throw new DataError('NOT_FOUND', 'No such rollback.', 404)
  if (rb.status !== 'interrupted' && rb.status !== 'failed')
    throw new DataError('NOT_RESUMABLE', 'Only an interrupted or failed rollback can be resumed.')
  const refreshRun = await readRun(Number(rb.plan?.refresh_run))
  if (!refreshRun)
    throw new DataError('NOT_FOUND', 'The refresh this rollback undoes is gone.', 404)
  if (refreshRun.artifact?.rollback_deleted_at)
    throw new DataError('NO_ROLLBACK', 'Its rollback point is gone.')
  const { target, tAccess } = await rollbackContext(refreshRun, deps)
  const lock = deps.promoteLock ?? defaultPromoteLock()
  await withEnvLocks(lock, [rb.environment_id], async (release) =>
    resumeDataRun(runId, {
      envIds: [rb.environment_id],
      statuses: ['interrupted', 'failed'],
      deps,
      cleanup: async () => release(),
      body: rollbackBody(refreshRun, target, tAccess, deps)
    })
  )
}

/**
 * A refresh whose rollback window ended: its rollback point file is deleted (best effort, on the
 * server it was written to) and its sealed keep set dropped. Called by the schedule tick.
 */
export async function expireRefresh(
  run: DataRun,
  deps: { opener?: ServerOpener } = {}
): Promise<void> {
  const file = typeof run.artifact?.rollback_file === 'string' ? run.artifact.rollback_file : null
  let note: string | null = null
  if (file && !run.artifact?.rollback_deleted_at) {
    try {
      const access = serverAccessOf(await envData(run.environment_id))
      const wrote = Number(run.artifact?.rollback_server_id)
      if (Number.isFinite(wrote) && wrote !== access.server.id)
        note = 'The environment moved to another server: a DBA removes the old rollback point file.'
      else await (deps.opener ?? withServerExec)(access, (exec) => exec(deleteFileSql(file)))
    } catch (err) {
      note = errText(err).slice(0, 200)
    }
  }
  await patchRun(run.id, {
    keepSecret: null,
    expiresAt: null,
    artifact: {
      ...(run.artifact ?? {}),
      rollback_deleted_at: new Date().toISOString(),
      ...(note ? { rollback_delete_error: note } : {})
    }
  })
}

/**
 * An administrator gives up on an interrupted run (or a failed refresh) instead of resuming it:
 * typed confirm — the database a refresh or rollback replaces, else the run id. The run ends
 * `cancelled`; a refresh's rollback point stays usable until its window ends. A refresh that
 * never reached its restore has its target's maintenance put back.
 */
export async function abandonRun(
  runId: number,
  confirm: unknown,
  deps: RefreshDeps = {}
): Promise<DataRun> {
  const run = await readRun(runId)
  if (!run) throw new DataError('NOT_FOUND', 'No such run.', 404)
  const ok = run.status === 'interrupted' || (run.kind === 'refresh' && run.status === 'failed')
  if (!ok)
    throw new DataError(
      'RUN_ENDED',
      'Only an interrupted run (or a failed refresh) can be abandoned.'
    )
  const want = abandonConfirm(run)
  if (typeof confirm !== 'string' || confirm.trim() !== want)
    throw new DataError('CONFIRM_MISMATCH', `Type ${want} to abandon this run.`, 400)
  const art = run.artifact ?? {}
  if (run.kind === 'refresh' && !art.restore_started_at) {
    const took = run.steps.find((s) => s.key === 'maintenance_on')
    if (took && took.state !== 'pending') {
      const ch = await (deps.channel ?? appChannelFor)(run.environment_id)
      await setMaintenance(
        ch,
        run.environment_id,
        false,
        art,
        async () => {},
        async () => {}
      ).catch(() => undefined)
    }
  }
  await patchRun(runId, {
    status: 'cancelled',
    finished: true,
    artifact: { ...art, abandoned_at: new Date().toISOString() },
    error: run.error ?? 'Abandoned by an administrator.'
  })
  return (await readRun(runId)) as DataRun
}

/** What a person types to abandon a run. */
export function abandonConfirm(run: Pick<DataRun, 'kind' | 'id' | 'plan'>): string {
  const p = (run.plan ?? {}) as { target?: { database?: unknown }; database?: unknown }
  if (run.kind === 'refresh') return String(p.target?.database ?? run.id)
  if (run.kind === 'refresh_rollback') return String(p.database ?? run.id)
  return String(run.id)
}
