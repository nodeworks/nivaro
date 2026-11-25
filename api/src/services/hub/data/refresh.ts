import { createHash } from 'node:crypto'
import { db } from '../../../db/index.js'
import {
  applyKeepSet,
  captureKeepSet,
  type SavedKeepSet,
  type SqlRunner
} from '../../env-refresh/keep-set.js'
import {
  allKeeps,
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
import {
  backupFileName,
  databaseFilesSql,
  deleteFileSql,
  dropLoginUserSql,
  fileListSqlFor,
  isServerFolder,
  joinServerPath,
  mapLoginSql,
  movesOverTarget,
  multiUserSql,
  restoreOverSql
} from './mssql-sql.js'
import { readPolicy } from './policy.js'
import { type RunCtx, type RunnerDeps, resumeDataRun, startDataRun } from './runner.js'
import { openRunFor, patchRun, readKeepSecret, readRun } from './runs.js'
import { DataError, type DataRun } from './types.js'

/**
 * Hub data care — environment refresh: copy one environment's database over a LOWER one of the
 * same app (production → staging, staging → development …), keeping the target's own settings.
 *
 * Refused, always: a target that is production (key prod / production / prd / live, or the
 * app's last environment), a target that is not lower in promotion order, another app's
 * environment, the same database, an engine other than SQL Server, a server without a stored
 * login, two different Nivaro versions (the restored copy must already match the target's
 * migrations — promote the target first), an open move or another data run on either.
 *
 * What the target keeps is the target APP's own refresh registry (core + its extensions, read
 * over its link, GET …/data/refresh-keeps) — the same entries the EFP host runbook keeps. The
 * Hub runs the core's own row filters only: an extension entry with a `where` is left out and
 * named on the plan (its SQL would run with the server's login). When the app does not answer,
 * the core's entries are used and the start must say `accept_core_keeps`.
 *
 * Run: maintenance on (target) → rollback point (COPY_ONLY backup of the target) → keep set
 * captured, sealed into the run row → COPY_ONLY backup of the source → RESTORE … WITH REPLACE
 * over the target → the target's login owns the copy again → keep set applied → safety pass
 * (test modes on, external APIs new from the source switched off …) → source copy deleted →
 * maintenance off → verify. The rollback point stays ROLLBACK_HOURS; until then "Roll back"
 * restores it (typed confirm again). The run holds the target's promote lock (holder `data`).
 */

export const ROLLBACK_HOURS = 24
const KEEP_MAX_BYTES = 8 * 1024 * 1024

export const REFRESH_STEPS = [
  { key: 'maintenance_on', label: 'Put the target app in maintenance' },
  { key: 'rollback_point', label: 'Back up the target (rollback point)' },
  { key: 'keep_capture', label: 'Save what the target keeps' },
  { key: 'backup_source', label: 'Back up the source (copy-only)' },
  { key: 'restore', label: 'Restore the copy over the target' },
  { key: 'login', label: 'Give the copy back to the target’s login' },
  { key: 'keep_apply', label: 'Put back what the target keeps' },
  { key: 'safety', label: 'Safety pass (test modes, new partners off)' },
  { key: 'tidy', label: 'Delete the source copy file' },
  { key: 'maintenance_off', label: 'Take the target out of maintenance' },
  { key: 'verify', label: 'Check the target answers' }
] as const

export const ROLLBACK_STEPS = [
  { key: 'maintenance_on', label: 'Put the target app in maintenance' },
  { key: 'restore', label: 'Restore the rollback point over the target' },
  { key: 'login', label: 'Give the database back to the target’s login' },
  { key: 'maintenance_off', label: 'Take the target out of maintenance' }
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

export interface RefreshPlan {
  source: {
    env_id: number
    env_key: string
    database: string | null
    server: string | null
    version: string | null
  }
  target: {
    env_id: number
    env_key: string
    database: string | null
    server: string | null
    version: string | null
  }
  app: { id: number; key: string; name: string }
  same_server: boolean
  transfer_path: string | null
  keeps_from: 'app' | 'core'
  kept: KeptLine[]
  left_out: Array<{ id: string; label: string; why: string }>
  overwritten: string
  checks: RefreshCheck[]
  blocked: boolean
  rollback_hours: number
  /** What a person types to start: the target database's name. */
  confirm: string | null
  plan_hash: string
}

export interface RefreshDeps extends RunnerDeps {
  opener?: ServerOpener
  channel?: (envId: number) => Promise<AppChannel>
  promoteLock?: PromoteLock
}

/** Pure: the refusals that depend only on the two environments. */
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
  if (target.production)
    out.push({
      id: 'production_target',
      state: 'fail',
      text: `${target.env.key} is production: a refresh never writes over production.`
    })
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
    s: [p.source.env_id, p.source.database, p.source.server, p.source.version],
    t: [p.target.env_id, p.target.database, p.target.server, p.target.version],
    path: p.transfer_path,
    from: p.keeps_from,
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
    if (open)
      checks.push({
        id: 'data_busy',
        state: 'fail',
        text: `A ${open.kind.replace('_', ' ')} (run ${open.id}) is still open on ${id === sourceId ? 'the source' : 'the target'}.`
      })
  }

  const chFor = deps.channel ?? appChannelFor
  const [sCh, tCh] = await Promise.all([chFor(sourceId), chFor(targetEnvId)])
  const [sVersion, tVersion] = await Promise.all([sCh.version(), tCh.version()])
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

  let keeps_from: 'app' | 'core' = 'app'
  let entries: EnvKeepEntry[]
  let left_out: RefreshPlan['left_out'] = []
  try {
    const a = (await tCh.call('GET', dataPath(tCh, 'refresh-keeps'))) as { keeps?: unknown } | null
    const t = trustedKeeps(a?.keeps)
    entries = t.keeps
    left_out = t.left_out
  } catch {
    keeps_from = 'core'
    entries = trustedKeeps(allKeeps().filter((e) => e.source === 'core')).keeps
    checks.push({
      id: 'core_keeps_only',
      state: 'warn',
      text: 'The target app did not list what it keeps: only the core’s entries are kept (an extension’s own settings would come from the source). Start with “accept core keeps” to go on.'
    })
  }

  let kept: KeptLine[] = entries.map((e) => ({
    id: e.id,
    label: e.label,
    table: e.table,
    kind: e.kind,
    rows: null,
    note: null
  }))
  if (tAccess && target.database) {
    try {
      const saved = await (deps.opener ?? withServerExec)(tAccess, (exec) =>
        captureKeepSet(runner(exec), {
          entries,
          direction: `${source.env.key}-to-${target.env.key}`,
          sourceDb: source.database?.database_name ?? '',
          targetDb: tAccess.database,
          sampleOver: 0
        })
      )
      kept = saved.entries.map((s) => ({
        id: s.id,
        label: s.label,
        table: s.table,
        kind: s.kind,
        rows: s.missing ? null : s.total,
        note: s.missing ?? null
      }))
    } catch (err) {
      checks.push({
        id: 'keep_read',
        state: 'fail',
        text: `The target’s keep set could not be read: ${errText(err).slice(0, 200)}`
      })
    }
  }

  const plan: Omit<RefreshPlan, 'plan_hash'> = {
    source: {
      env_id: sourceId,
      env_key: source.env.key,
      database: source.database?.database_name ?? null,
      server: sAccess?.server.name ?? null,
      version: sVersion
    },
    target: {
      env_id: targetEnvId,
      env_key: target.env.key,
      database: target.database?.database_name ?? null,
      server: tAccess?.server.name ?? null,
      version: tVersion
    },
    app: source.app,
    same_server: sameServer,
    transfer_path,
    keeps_from,
    kept,
    left_out,
    overwritten: target.database
      ? `The whole of ${target.database.database_name} is replaced by a copy of ${source.database?.database_name ?? 'the source'} taken when the run starts; every record, file row, user and setting comes from ${source.env.key}, except what is listed as kept.`
      : 'Nothing: the target has no database record.',
    checks,
    blocked: checks.some((c) => c.state === 'fail'),
    rollback_hours: ROLLBACK_HOURS,
    confirm: target.database?.database_name ?? null
  }
  return { ...plan, plan_hash: planHash(plan) }
}

// ─── maintenance on the target ─────────────────────────────────────────────────────────────

async function setMaintenance(
  ch: AppChannel,
  envId: number,
  on: boolean,
  runId: number
): Promise<string> {
  if (ch.kind === 'dedicated') {
    await ch.call('POST', 'maintenance', {
      on,
      ...(on ? { message: 'This environment is being refreshed from another one.' } : {})
    })
    return on ? 'The app shows its maintenance page.' : 'The maintenance page is off.'
  }
  // A shared app: its listed status (the deployment serves `maintenance`), as a move does.
  const run = await readRun(runId)
  const prior = (run?.result?.prior_status as string | undefined) ?? null
  if (on) {
    const env = (await db('nivaro_hub_environments').where({ id: envId }).first('status')) as
      | { status: string }
      | undefined
    await patchRun(runId, {
      result: { ...(run?.result ?? {}), prior_status: env?.status ?? 'active' }
    })
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update({ status: 'maintenance', updated_at: new Date() })
  } else {
    await db('nivaro_hub_environments')
      .where({ id: envId, status: 'maintenance' })
      .update({
        status: prior && prior !== 'maintenance' ? prior : 'active',
        updated_at: new Date()
      })
  }
  if (ch.shared)
    await deploymentClient(ch.shared)
      .refresh()
      .catch(() => undefined)
  return on
    ? 'Listed as maintenance on its shared deployment.'
    : 'Listed as before on its shared deployment.'
}

// ─── run ───────────────────────────────────────────────────────────────────────────────────

interface RefreshTarget {
  source: EnvData
  target: EnvData
  sAccess: ServerAccess
  tAccess: ServerAccess
  transferPath: string | null
  entries: EnvKeepEntry[]
}

function refreshBody(t: RefreshTarget, deps: RefreshDeps) {
  const opener = deps.opener ?? withServerExec
  const chFor = deps.channel ?? appChannelFor
  return async (ctx: RunCtx) => {
    const ch = await chFor(t.target.env.id)
    const prior = (await readRun(ctx.id))?.artifact ?? {}
    const art: Record<string, unknown> = { ...prior }
    const save = (extra: Record<string, unknown>) => {
      Object.assign(art, extra)
      return ctx.patch({ artifact: { ...art } })
    }
    const targetDb = t.tAccess.database
    const sameServer = t.sAccess.server.id === t.tAccess.server.id
    await opener(t.tAccess, async (texec) => {
      const withSource = <T>(fn: (sexec: SqlExec) => Promise<T>) =>
        sameServer ? fn(texec) : opener(t.sAccess, fn)
      const now = new Date()
      await ctx.step('maintenance_on', async () => {
        try {
          return await setMaintenance(ch, t.target.env.id, true, ctx.id)
        } catch (err) {
          return {
            warn: true,
            note: `The app did not take maintenance (${errText(err).slice(0, 120)}); the restore puts every session out anyway.`
          }
        }
      })
      await ctx.step('rollback_point', async () => {
        const folder =
          t.transferPath ?? (await backupFolder(texec, (await readPolicy(t.target.env.id)).db_path))
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
        await backupInto(texec, targetDb, file)
        await save({ rollback_file: file, rollback_server_id: t.tAccess.server.id })
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
        const file = await withSource(async (sexec) => {
          const folder =
            t.transferPath ??
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
          await backupInto(sexec, t.sAccess.database, f)
          return f
        })
        await save({ source_file: file })
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
        const t0 = Date.now()
        try {
          await texec(restoreOverSql(targetDb, file, moves))
        } catch (err) {
          await texec(multiUserSql(targetDb)).catch(() => undefined)
          throw err
        }
        await save({ restored_at: new Date().toISOString(), restore_ms: Date.now() - t0 })
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
        const sealed = await readKeepSecret(ctx.id)
        const plain = openSecret(sealed)
        if (!plain)
          throw new DataError(
            'NO_ROLLBACK',
            'The saved keep set is gone: roll back to the rollback point.'
          )
        saved = JSON.parse(plain) as SavedKeepSet
        const results = await applyKeepSet(runner(texec), saved, targetDb)
        const errors = results.flatMap((r) => r.errors)
        await ctx.patch({
          result: {
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
        return await setMaintenance(ch, t.target.env.id, false, ctx.id)
      } catch (err) {
        return {
          warn: true,
          note: `Maintenance could not be lifted (${errText(err).slice(0, 120)}): lift it on the app.`
        }
      }
    })
    await ctx.step('verify', async () => {
      const v = await ch.version()
      if (!v) return { warn: true, note: 'The target did not answer its link yet.' }
      return `The target answers (Nivaro ${v}).`
    })
    return { artifact: { ...art } }
  }
}

async function withEnvLock<T>(
  lock: PromoteLock,
  envId: number,
  fn: (release: () => Promise<void>) => Promise<T>
): Promise<T> {
  const token = await lock.take(envId, 'data')
  if (!token) {
    const holder = lock.holder ? await lock.holder(envId).catch(() => null) : null
    const r = lockHolderRefusal(
      holder,
      {
        code: 'ENV_BUSY',
        message: 'Something else is changing the target environment — wait for it to end.'
      },
      'data'
    )
    throw new DataError('ENV_BUSY', r.message)
  }
  const timer = setInterval(
    () => void lock.renew(envId, token).catch(() => undefined),
    LOCK_RENEW_MS
  )
  timer.unref?.()
  let released = false
  const release = async () => {
    if (released) return
    released = true
    clearInterval(timer)
    await lock.release(envId, token)
  }
  try {
    return await fn(release)
  } catch (err) {
    await release()
    throw err
  }
}

async function targetsFor(plan: RefreshPlan): Promise<RefreshTarget> {
  const [source, target] = await Promise.all([
    envData(plan.source.env_id),
    envData(plan.target.env_id)
  ])
  return {
    source,
    target,
    sAccess: serverAccessOf(source),
    tAccess: serverAccessOf(target),
    transferPath: plan.transfer_path,
    entries: []
  }
}

export async function startRefresh(
  targetEnvId: number,
  body: Record<string, unknown>,
  by: string | null,
  deps: RefreshDeps = {}
): Promise<number> {
  const plan = await planRefresh(targetEnvId, body, deps)
  if (body.plan_hash !== plan.plan_hash)
    throw new DataError(
      'PLAN_CHANGED',
      'The plan changed since it was shown: look at it again.',
      409,
      { plan }
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
  if (plan.keeps_from === 'core' && body.accept_core_keeps !== true)
    throw new DataError(
      'CORE_KEEPS_ONLY',
      'The target app did not list what it keeps: start with accept_core_keeps to keep only the core’s entries.',
      409,
      { plan }
    )
  const t = await targetsFor(plan)
  const chFor = deps.channel ?? appChannelFor
  if (plan.keeps_from === 'app') {
    const ch = await chFor(targetEnvId)
    const a = (await ch.call('GET', dataPath(ch, 'refresh-keeps'))) as { keeps?: unknown } | null
    t.entries = trustedKeeps(a?.keeps).keeps
  } else t.entries = trustedKeeps(allKeeps().filter((e) => e.source === 'core')).keeps
  const lock = deps.promoteLock ?? defaultPromoteLock()
  return withEnvLock(lock, targetEnvId, async (release) =>
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
      cleanup: async () => release()
    })
  )
}

/** Continues an interrupted refresh from its first step not done (the plan it started with). */
export async function resumeRefresh(runId: number, deps: RefreshDeps = {}): Promise<void> {
  const run = await readRun(runId)
  if (run?.kind !== 'refresh') throw new DataError('NOT_FOUND', 'No such refresh.', 404)
  const plan = run.plan as unknown as RefreshPlan & { entries?: string[] }
  const t = await targetsFor(plan)
  const ids = new Set(plan.entries ?? [])
  const known = new Map([...allKeeps(), ...CORE_KEEPS].map((e) => [e.id, e]))
  if (plan.keeps_from === 'app') {
    try {
      const ch = await (deps.channel ?? appChannelFor)(run.environment_id)
      for (const e of trustedKeeps(
        ((await ch.call('GET', dataPath(ch, 'refresh-keeps'))) as { keeps?: unknown } | null)?.keeps
      ).keeps)
        known.set(e.id, e)
    } catch {
      // the keep set is already sealed in the row once captured; entries only matter before
    }
  }
  t.entries = [...ids].map((id) => known.get(id)).filter((e): e is EnvKeepEntry => !!e)
  const lock = deps.promoteLock ?? defaultPromoteLock()
  await withEnvLock(lock, run.environment_id, async (release) =>
    resumeDataRun(runId, {
      envIds: [run.environment_id, plan.source.env_id],
      deps,
      body: refreshBody(t, deps),
      cleanup: async () => release()
    })
  )
}

/** Whether a refresh can still be rolled back, and why not. */
export function rollbackRefusal(run: DataRun, now = new Date()): string | null {
  if (run.kind !== 'refresh') return 'Only a refresh can be rolled back.'
  if (run.status === 'running' || run.status === 'waiting') return 'The refresh is still running.'
  if (typeof run.artifact?.rollback_file !== 'string') return 'This refresh made no rollback point.'
  if (run.artifact?.rollback_deleted_at || run.artifact?.rolled_back_at)
    return run.artifact?.rolled_back_at
      ? 'This refresh was already rolled back.'
      : 'Its rollback point is gone.'
  if (!run.artifact?.restored_at) return 'The target was never replaced: nothing to roll back.'
  if (!run.expires_at || Date.parse(run.expires_at) < now.getTime())
    return 'The rollback window has ended.'
  return null
}

export async function startRefreshRollback(
  refreshRunId: number,
  body: Record<string, unknown>,
  by: string | null,
  deps: RefreshDeps = {}
): Promise<number> {
  const run = await readRun(refreshRunId)
  if (!run) throw new DataError('NOT_FOUND', 'No such refresh.', 404)
  const why = rollbackRefusal(run)
  if (why) throw new DataError(why.includes('ended') ? 'ROLLBACK_EXPIRED' : 'NO_ROLLBACK', why)
  const target = await envData(run.environment_id)
  if (target.production)
    throw new DataError(
      'PRODUCTION_TARGET',
      'The target is production now: the Hub never restores over production.'
    )
  const tAccess = serverAccessOf(target)
  if (typeof body.confirm !== 'string' || body.confirm.trim() !== tAccess.database)
    throw new DataError(
      'CONFIRM_MISMATCH',
      `Type the target database name (${tAccess.database}) to roll back.`,
      400
    )
  const file = String(run.artifact?.rollback_file)
  const opener = deps.opener ?? withServerExec
  const chFor = deps.channel ?? appChannelFor
  const lock = deps.promoteLock ?? defaultPromoteLock()
  return withEnvLock(lock, run.environment_id, async (release) =>
    startDataRun({
      kind: 'refresh_rollback',
      environmentId: run.environment_id,
      sourceEnvironmentId: run.source_environment_id,
      envIds: [run.environment_id],
      steps: ROLLBACK_STEPS,
      plan: { refresh_run: refreshRunId, file },
      by,
      deps,
      cleanup: async () => release(),
      body: async (ctx) => {
        const ch = await chFor(run.environment_id)
        await ctx.step('maintenance_on', async () => {
          try {
            return await setMaintenance(ch, run.environment_id, true, ctx.id)
          } catch (err) {
            return {
              warn: true,
              note: `The app did not take maintenance (${errText(err).slice(0, 120)}).`
            }
          }
        })
        await opener(tAccess, async (texec) => {
          await ctx.step('restore', async () => {
            const files = await texec(fileListSqlFor(file))
            const own = await texec(databaseFilesSql(tAccess.database))
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
              await texec(restoreOverSql(tAccess.database, file, moves))
            } catch (err) {
              await texec(multiUserSql(tAccess.database)).catch(() => undefined)
              throw err
            }
            await patchRun(refreshRunId, {
              artifact: {
                ...run.artifact,
                rolled_back_at: new Date().toISOString(),
                rollback_run: ctx.id
              }
            })
            return `${tAccess.database} is back as it was before refresh ${refreshRunId}.`
          })
          await ctx.step('login', async () => {
            await texec(mapLoginSql(tAccess.database, await appLoginOf(tAccess.databaseId)))
            return 'The target’s login owns the database.'
          })
        })
        await ctx.step('maintenance_off', async () => {
          try {
            return await setMaintenance(ch, run.environment_id, false, ctx.id)
          } catch (err) {
            return {
              warn: true,
              note: `Maintenance could not be lifted (${errText(err).slice(0, 120)}).`
            }
          }
        })
        return {}
      }
    })
  )
}

/**
 * A refresh whose rollback window ended: its rollback point file is deleted (best effort) and
 * its sealed keep set dropped. Called by the schedule tick.
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
      await (deps.opener ?? withServerExec)(access, (exec) => exec(deleteFileSql(file)))
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
