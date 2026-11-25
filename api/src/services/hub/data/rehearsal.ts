import { db } from '../../../db/index.js'
import type { HubTenantWire } from '../../tenancy/hub-contract.js'
import { connectionUrl } from '../db/connection.js'
import { openDatabaseConnection } from '../db/databases.js'
import { resolveMoveAddresses } from '../move/addresses.js'
import { hubLinkClient } from '../move/link-client.js'
import { planFor } from '../move/run.js'
import { openSecret } from '../secrets.js'
import {
  type DeploymentClient,
  deploymentClient,
  type PullStatus
} from '../shared/deployment-client.js'
import { getShared, linkUrlOrigin, openAppKey, type SharedDeployment } from '../shared/store.js'
import { type AppChannel, appChannelFor, purgeRehearsalFiles } from './app-calls.js'
import { backupFolder, backupInto } from './backup.js'
import {
  envData,
  errText,
  type ServerAccess,
  type ServerOpener,
  serverAccessOf,
  withServerExec
} from './env-db.js'
import { assertGate, type DataGate } from './gate.js'
import { backupFileName, deleteFileSql, joinServerPath, scratchName } from './mssql-sql.js'
import { readPolicy } from './policy.js'
import { type RunnerDeps, startDataRun } from './runner.js'
import { patchRun, readRun, runFromRow } from './runs.js'
import { dropScratch, restoreScratch } from './scratch.js'
import { DataError } from './types.js'

/**
 * Hub data care — the move rehearsal: rehearse moving an environment onto a SHARED deployment
 * without touching the live app (never in maintenance, never retired, its name never moved):
 *
 *  1. plan       the move's own plan (move/run.ts planFor): blockers and warnings are reported,
 *                not obeyed — finding them is the point
 *  2. copy_db    a COPY_ONLY backup of the app's database restored as this run's scratch copy on
 *                the same server (its users map to the app's own login by SID, so the app's own
 *                connection reaches the copy)
 *  3. list       a temporary app `rh-<run>` on the target deployment (shared/tenants.ts lists
 *                it): status maintenance (every request but /api/version and app-info answers
 *                503), on a `.invalid` host name nothing routes to (a caller can still send that
 *                Host header — maintenance is what keeps it closed), the copy's connection, and
 *                the app's own key when the Hub knows it
 *  4. migrate    the deployment migrates the copy as it would migrate the moved app (its version)
 *  5. checks     the deployment's preflight and readiness score for that app
 *  6. files      the move's own file copy (ticket from the source, pull into `rh-<run>`), timed
 *  7. teardown   the temporary app's files are removed, it leaves the list, the copy is dropped
 *
 * Teardown also runs in the runner's cleanup, whatever happened. A rehearsal into a dedicated
 * stack is refused (ruling: the risk of a move is the shared deployment the app joins; a
 * temporary dedicated stack is a deploy, not a rehearsal).
 */

export const REHEARSAL_STEPS = [
  { key: 'plan', label: 'Plan the move' },
  { key: 'copy_db', label: 'Copy the database into a scratch database' },
  { key: 'list', label: 'Add a temporary app on the shared deployment' },
  { key: 'migrate', label: 'Let the deployment migrate the copy' },
  { key: 'checks', label: 'Run the app’s preflight and readiness there' },
  { key: 'files', label: 'Copy the files into the temporary app' },
  { key: 'teardown', label: 'Remove the temporary app and the copy' }
] as const

export const REHEARSAL_HOST_SUFFIX = 'rehearsal.invalid'
const MIGRATE_TIMEOUT_MS = 30 * 60_000
const CHECKS_TIMEOUT_MS = 3 * 60_000
const FILES_TIMEOUT_MS = 6 * 60 * 60_000

export const rehearsalTenantId = (runId: number) => `rh-${runId}`

export interface RehearsalDeps extends RunnerDeps {
  opener?: ServerOpener
  client?: (s: SharedDeployment) => DeploymentClient
  channel?: (envId: number) => Promise<AppChannel>
  planner?: typeof planFor
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  purge?: typeof purgeRehearsalFiles
  gate?: () => Promise<DataGate>
}

/** The listed wire tenant of a rehearsal run (null when it cannot be listed). */
export async function rehearsalWire(
  artifact: Record<string, unknown>,
  runId: number
): Promise<HubTenantWire | null> {
  const dbId = Number(artifact.database_id)
  const envId = Number(artifact.env_id)
  const scratch = String(artifact.scratch ?? '')
  if (!Number.isSafeInteger(dbId) || !Number.isSafeInteger(envId) || !scratch) return null
  const conn = await openDatabaseConnection(dbId)
  const id = rehearsalTenantId(runId)
  const wire: HubTenantWire = {
    id,
    app_key: String(artifact.app_key ?? 'rehearsal').slice(0, 64),
    env_key: id,
    name: `Rehearsal ${runId}`,
    status: 'maintenance',
    hostnames: [`${id}.${REHEARSAL_HOST_SUFFIX}`],
    db: { client: conn.engine, connection: connectionUrl({ ...conn, database: scratch }) }
  }
  let key: string | null = null
  try {
    key = await openAppKey(envId)
  } catch {
    key = null
  }
  if (key) wire.encryption_key = key
  return wire
}

/** Every rehearsal app a shared deployment should list now (tenants.ts appends them). */
export async function rehearsalTenantWires(sharedId: number): Promise<HubTenantWire[]> {
  const rows = (await db('nivaro_hub_data_runs')
    .where({ kind: 'rehearsal', status: 'running' })
    .select('*')) as Record<string, unknown>[]
  const out: HubTenantWire[] = []
  for (const r of rows.map(runFromRow)) {
    const a = r.artifact
    if (a?.listed !== true || Number(a.shared_id) !== sharedId) continue
    try {
      const w = await rehearsalWire(a, r.id)
      if (w) out.push(w)
    } catch {
      // a database record that cannot be opened: the rehearsal's migrate step times out and says so
    }
  }
  return out
}

export async function startRehearsal(
  envId: number,
  body: Record<string, unknown>,
  by: string | null,
  deps: RehearsalDeps = {}
): Promise<number> {
  await assertGate('rehearsal_enabled', deps.gate ? await deps.gate() : undefined)
  const sharedId = Number(body.shared_id)
  if (!Number.isSafeInteger(sharedId) || sharedId < 1)
    throw new DataError(
      'NOT_SHARED_TARGET',
      'A rehearsal needs shared_id: the shared deployment to rehearse the move onto.',
      400
    )
  const shared = await getShared(sharedId)
  if (!shared || shared.status === 'retired')
    throw new DataError('NOT_SHARED_TARGET', 'No such shared deployment (or it is retired).', 404)
  const data = await envData(envId)
  const access: ServerAccess = serverAccessOf(data)
  const ch = await (deps.channel ?? appChannelFor)(envId)
  if (ch.kind === 'shared' && ch.shared?.id === sharedId)
    throw new DataError(
      'NOT_SHARED_TARGET',
      'The environment already runs on that shared deployment.',
      400
    )
  const opener = deps.opener ?? withServerExec
  const client = (deps.client ?? ((s: SharedDeployment) => deploymentClient(s)))(shared)
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const pollMs = deps.pollMs ?? 5_000
  const planner = deps.planner ?? planFor
  const to = { kind: 'shared' as const, shared_id: sharedId }
  let scratch = ''
  let listed = false
  const unlist = async (runId: number) => {
    if (!listed) return
    listed = false
    await (deps.purge ?? purgeRehearsalFiles)(shared, rehearsalTenantId(runId)).catch(
      () => undefined
    )
    const run = (await db('nivaro_hub_data_runs').where({ id: runId }).first('artifact')) as
      | { artifact: string | null }
      | undefined
    const a = run?.artifact ? (JSON.parse(run.artifact) as Record<string, unknown>) : {}
    await patchRun(runId, { artifact: { ...a, listed: false } })
    await client.refresh().catch(() => undefined)
  }
  return startDataRun({
    kind: 'rehearsal',
    environmentId: envId,
    envIds: [envId],
    steps: REHEARSAL_STEPS,
    plan: { shared_id: sharedId, shared_key: shared.key },
    by,
    deps,
    body: async (ctx) => {
      const tenant = rehearsalTenantId(ctx.id)
      const result: Record<string, unknown> = { shared: { id: shared.id, key: shared.key } }
      const keep = (extra: Record<string, unknown>) => {
        Object.assign(result, extra)
        return ctx.patch({ result: { ...result } })
      }
      await ctx.step('plan', async () => {
        try {
          const plan = await planner(envId, to)
          await keep({
            move_plan: {
              blockers: plan.blockers,
              warnings: plan.warnings,
              files: plan.files,
              version: plan.version,
              steps: plan.steps
            }
          })
          return {
            note: `${plan.blockers.length} blocker(s), ${plan.warnings.length} warning(s) for the real move.`,
            warn: plan.blockers.length > 0
          }
        } catch (err) {
          await keep({ move_plan: { error: errText(err) } })
          return {
            warn: true,
            note: `The move could not be planned: ${errText(err).slice(0, 200)}`
          }
        }
      })
      await ctx.step('copy_db', async () => {
        scratch = scratchName('r', ctx.id)
        return opener(access, async (exec) => {
          const folder = await backupFolder(exec, (await readPolicy(envId)).db_path)
          const file = joinServerPath(
            folder,
            backupFileName({
              app: data.app.key,
              env: data.env.key,
              label: 'rehearsal',
              runId: ctx.id,
              at: new Date()
            })
          )
          // Named in the row before they exist: a crashed rehearsal's copy and file are found.
          await ctx.patch({
            artifact: {
              listed: false,
              shared_id: sharedId,
              env_id: envId,
              database_id: access.databaseId,
              server_id: access.server.id,
              app_key: data.app.key,
              scratch,
              bak_file: file
            }
          })
          const t0 = Date.now()
          await backupInto(exec, access.database, file)
          const backupMs = Date.now() - t0
          let restoreMs = 0
          try {
            restoreMs = (await restoreScratch(exec, scratch, file, ctx.id)).ms
          } finally {
            await exec(deleteFileSql(file)).then(
              () => undefined,
              () => undefined
            )
          }
          await keep({ scratch, backup_ms: backupMs, restore_ms: restoreMs })
          return `Copied into ${scratch} (backup ${Math.round(backupMs / 1000)} s, restore ${Math.round(restoreMs / 1000)} s).`
        })
      })
      await ctx.step('list', async () => {
        const before = (await readRun(ctx.id))?.artifact ?? {}
        await ctx.patch({
          artifact: {
            ...before,
            listed: true,
            shared_id: sharedId,
            env_id: envId,
            database_id: access.databaseId,
            app_key: data.app.key,
            scratch
          }
        })
        listed = true
        await client.refresh()
        return `Listed as ${tenant} (maintenance, ${tenant}.${REHEARSAL_HOST_SUFFIX}).`
      })
      await ctx.step('migrate', async () => {
        const t0 = Date.now()
        for (;;) {
          await sleep(pollMs)
          let state: string | null = null
          let error: string | null = null
          try {
            const st = await client.status()
            const app = st.apps.find((a) => a.id === tenant)
            state = app?.schema.state ?? null
            error = app?.schema.error ?? null
            const dropped = st.registry.dropped.find((d) => d.id === tenant)
            if (dropped)
              throw new DataError(
                'APP_UNREACHABLE',
                `The deployment refused the temporary app: ${dropped.why}`
              )
          } catch (err) {
            if (err instanceof DataError) throw err
          }
          if (state === 'ok') {
            await keep({ migrate_ms: Date.now() - t0 })
            return `Migrated by the deployment in ${Math.round((Date.now() - t0) / 1000)} s.`
          }
          if (state === 'failed')
            throw new DataError(
              'APP_UNREACHABLE',
              `The deployment could not migrate the copy: ${error ?? 'no reason given'}`
            )
          if (Date.now() - t0 > MIGRATE_TIMEOUT_MS)
            throw new DataError(
              'APP_UNREACHABLE',
              'The deployment did not migrate the copy within 30 minutes.'
            )
        }
      })
      await ctx.step('checks', async () => {
        const t0 = Date.now()
        for (;;) {
          try {
            const s = await client.appStatus(tenant)
            if (
              !['unknown', 'timeout'].includes(s.preflight.status) ||
              Date.now() - t0 > CHECKS_TIMEOUT_MS
            ) {
              await keep({
                checks: {
                  version: s.version,
                  preflight: s.preflight,
                  readiness_score: s.readiness_score,
                  key_fp: s.key_fp,
                  files: s.files
                }
              })
              const failing = s.preflight.failing
              return {
                note: `Preflight ${s.preflight.status}${failing.length ? ` (failing: ${failing.join(', ')})` : ''}; readiness ${s.readiness_score ?? 'not yet scored'}.`,
                warn: s.preflight.status !== 'ok' && s.preflight.status !== 'pass'
              }
            }
          } catch (err) {
            if (Date.now() - t0 > CHECKS_TIMEOUT_MS) throw err
          }
          await sleep(pollMs)
        }
      })
      await ctx.step('files', async () => {
        const origin = linkUrlOrigin(shared.link_url)
        if (!origin)
          return { warn: true, note: 'The deployment has no link address the Hub may use.' }
        let source: string
        let ticket: string
        let revoke: () => Promise<unknown>
        if (ch.kind === 'shared' && ch.shared && ch.tenantId) {
          const from = (deps.client ?? ((s: SharedDeployment) => deploymentClient(s)))(ch.shared)
          const o = linkUrlOrigin(ch.shared.link_url)
          if (!o) return { warn: true, note: 'The source deployment has no link address.' }
          source = `${o}/api/hub-transfer/files`
          const tid = ch.tenantId
          ticket = (await from.fileTicket(tid)).ticket
          const t = ticket
          revoke = () => from.revokeTicket(tid, t)
        } else {
          const plan = await planner(envId, to).catch(() => null)
          const addr = await resolveMoveAddresses(envId, to, {
            routing: plan?.routing ?? 'automatic'
          }).catch((err) => {
            throw new DataError(
              'APP_UNREACHABLE',
              `The source’s file address: ${errText(err).slice(0, 200)}`
            )
          })
          source = `${addr.pull_source}/api/hub-transfer/files`
          const tokenRow = (await db('nivaro_hub_environments')
            .where({ id: envId })
            .first('hub_token')) as { hub_token: string | null } | undefined
          const link = hubLinkClient(
            addr.source_link_base ?? data.env.base_url,
            openSecret(tokenRow?.hub_token ?? null)
          )
          ticket = (await link.fileTicket()).ticket
          const t = ticket
          revoke = () => link.revokeTicket(t)
        }
        const t0 = Date.now()
        let last: PullStatus | null = null
        try {
          const { run_id } = await client.pullFiles(tenant, {
            source,
            ticket,
            mode: 'full',
            ...(ch.kind === 'dedicated' ? { objects: true } : {})
          })
          for (;;) {
            await sleep(pollMs)
            last = await client.pullStatus(tenant, run_id)
            if (last.state !== 'running') break
            if (Date.now() - t0 > FILES_TIMEOUT_MS)
              throw new DataError('APP_UNREACHABLE', 'The file copy took longer than 6 hours.')
          }
        } finally {
          await revoke().catch(() => undefined)
        }
        const st = last as PullStatus
        await keep({ files: { ms: Date.now() - t0, ...st } })
        if (st.state === 'failed')
          throw new DataError('APP_UNREACHABLE', st.error ?? 'The file copy failed.')
        return {
          note: `${st.copied + st.skipped} of ${st.total} files in ${Math.round((Date.now() - t0) / 1000)} s (${Math.round(st.bytes / 1048576)} MB)${st.failed ? `, ${st.failed} failed` : ''}.`,
          warn: st.failed > 0
        }
      })
      await ctx.step('teardown', async () => {
        await unlist(ctx.id)
        const r = await opener(access, (exec) => dropScratch(exec, scratch, ctx.id))
        return `Temporary app removed; ${scratch} ${r}.`
      })
      return { result }
    },
    cleanup: async (ctx) => {
      await unlist(ctx.id).catch(() => undefined)
      if (scratch)
        await opener(access, (exec) => dropScratch(exec, scratch, ctx.id)).catch(() => undefined)
    }
  })
}
