import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import {
  definitionNameMatches,
  deployProcedure,
  dropProcedure,
  importBodyTargetsOwn,
  liveProcedureDefinition,
  liveProcedureDefinitions,
  sha256,
  sqlErrorText
} from '../procedure-deploy.js'
import { registerReadinessCheck } from '../readiness.js'
import { normalizeProcBody } from './normalize.js'
import { procedureOwner } from './owners.js'
import {
  getManagedProcedure,
  listManagedProcedures,
  ManagedProcError,
  type ManagedProcedure,
  NAME_RE,
  putBackManaged,
  saveManagedVersion,
  stampDeployed
} from './store.js'

/**
 * The deploy service for app-managed procedures — config to the CONNECTED database, both kinds:
 *   - managed: nivaro_managed_procedures.body (stamps deployed_hash / deployed_at / deployed_by);
 *   - import:  nivaro_import_definitions.procedure_body (stamps procedure_hash /
 *     procedure_deployed_at, exactly as POST /staged-imports/definitions/:id/deploy does).
 *
 * A deploy is decided by the LIVE definition: normalizeProcBody(config) === normalizeProcBody(live)
 * means unchanged, anything else is deployed. Never by the stamp — promote and restore copy
 * `deployed_*` from another database, and a copied stamp must not suppress a needed deploy. When
 * live already matches, a wrong stamp is corrected (an honest stamp) and nothing is deployed.
 *
 * Drops: only a managed row marked `dropped_at` drops its live proc. A live proc config never
 * knew is never dropped, and nothing import-owned is ever dropped. A managed row whose name an
 * import owns is skipped (the import wins). The header check runs on every deploy: a managed body
 * must define its own name (definitionNameMatches), an import body must CREATE OR ALTER its own
 * proc (importBodyTargetsOwn) — both read outside comments and literals.
 *
 * Every deploy and drop goes through procedure-deploy.ts (pinned connection, procedure lock,
 * 120 s). Production DDL replicates — this runs where a person or the chain step asks, never at
 * boot.
 */

export type DeployAction =
  | 'created'
  | 'altered'
  | 'unchanged'
  | 'dropped'
  | 'absent'
  | 'skipped'
  | 'failed'

export interface DeployResult {
  name: string
  kind: 'import' | 'managed'
  action: DeployAction
  reason?: string
  hash?: string | null
}

export type DriftStatus =
  | 'in-sync'
  | 'drifted'
  | 'not-deployed'
  | 'dropped'
  | 'dropped-but-live'
  | 'conflict'

export interface DriftEntry {
  name: string
  kind: 'import' | 'managed'
  key?: string
  id?: number
  status: DriftStatus
}

const IMPORTS_TABLE = 'nivaro_import_definitions'
const DBO = (name: string) => ({ schema: 'dbo', name })
const DEFAULT_BY = 'system'

interface ImportRow {
  id: number
  key: string
  procedure: string
  procedure_body: string | null
  procedure_hash: string | null
}

interface RunOpts {
  execute: boolean
  force: boolean
  by: string
}

const sameBody = (config: string, live: string) =>
  normalizeProcBody(config) === normalizeProcBody(live)

const errText = (e: unknown) => sqlErrorText(e)

/** Import definitions that own a procedure (the same rows the owner answer reads). */
async function importRows(): Promise<ImportRow[]> {
  if (!(await db.schema.hasTable(IMPORTS_TABLE))) return []
  const rows = (await db(IMPORTS_TABLE)
    .whereNotNull('procedure_body')
    .whereNotNull('procedure')
    .select('id', 'key', 'procedure', 'procedure_body', 'procedure_hash')
    .orderBy('key', 'asc')) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    key: String(r.key),
    procedure: String(r.procedure ?? ''),
    procedure_body: r.procedure_body == null ? null : String(r.procedure_body),
    procedure_hash: r.procedure_hash == null ? null : String(r.procedure_hash)
  }))
}

/** One managed row against what the database holds (`live` null = not there). */
async function deployManagedRow(
  row: ManagedProcedure,
  live: string | null,
  o: RunOpts
): Promise<DeployResult> {
  const base = { name: row.name, kind: 'managed' as const }
  try {
    if (row.dropped_at) {
      if (live == null) {
        // Not there, as config says — correct a stamp that claims otherwise.
        if (o.execute && row.deployed_hash != null) await stampDeployed(row.id, null, o.by)
        return { ...base, action: 'absent', hash: null }
      }
      if (o.execute) {
        await dropProcedure(DBO(row.name))
        await stampDeployed(row.id, null, o.by)
      }
      return { ...base, action: 'dropped', hash: null }
    }
    if (!NAME_RE.test(row.name) || !definitionNameMatches(row.body, row.name)) {
      return {
        ...base,
        action: 'failed',
        reason: `the stored body defines another procedure, not CREATE [OR ALTER] PROCEDURE ${row.name} (dbo)`
      }
    }
    if (live != null && !o.force && sameBody(row.body, live)) {
      if (o.execute && row.deployed_hash !== row.body_hash) {
        await stampDeployed(row.id, row.body_hash, o.by)
      }
      return { ...base, action: 'unchanged', hash: row.body_hash }
    }
    const action: DeployAction = live == null ? 'created' : 'altered'
    if (o.execute) {
      await deployProcedure(row.body, DBO(row.name))
      await stampDeployed(row.id, row.body_hash, o.by)
    }
    return { ...base, action, hash: row.body_hash }
  } catch (e) {
    return { ...base, action: 'failed', reason: errText(e) }
  }
}

/** One import definition's stored body against what the database holds. */
async function deployImportRow(
  row: ImportRow,
  live: string | null,
  o: RunOpts
): Promise<DeployResult> {
  const base = { name: row.procedure, kind: 'import' as const }
  const body = String(row.procedure_body ?? '').trim()
  if (!body) return { ...base, action: 'skipped', reason: `definition ${row.key} has no body` }
  if (!NAME_RE.test(row.procedure)) {
    return {
      ...base,
      action: 'skipped',
      reason: `definition ${row.key} has no valid procedure name`
    }
  }
  if (!importBodyTargetsOwn(body, row.procedure)) {
    return {
      ...base,
      action: 'skipped',
      reason: `definition ${row.key}: the body must start with CREATE OR ALTER PROCEDURE ${row.procedure}`
    }
  }
  const hash = sha256(body)
  try {
    if (live != null && !o.force && sameBody(body, live)) {
      if (o.execute && row.procedure_hash !== hash) {
        await db(IMPORTS_TABLE)
          .where('id', row.id)
          .update({ procedure_hash: hash, procedure_deployed_at: new Date() })
      }
      return { ...base, action: 'unchanged', hash }
    }
    const action: DeployAction = live == null ? 'created' : 'altered'
    if (o.execute) {
      await deployProcedure(body, DBO(row.procedure))
      await db(IMPORTS_TABLE)
        .where('id', row.id)
        .update({ procedure_hash: hash, procedure_deployed_at: new Date() })
    }
    return { ...base, action, hash }
  } catch (e) {
    return { ...base, action: 'failed', reason: errText(e) }
  }
}

/**
 * Deploy one managed procedure from config. `dryRun` reports the action and writes nothing;
 * `force` redeploys a proc whose live text already matches. 404 PROC_NOT_FOUND when config has
 * no row for the name; a name an import owns is `skipped`. A deploy error is `failed` with SQL
 * Server's message (nothing stamped).
 */
export async function deployManagedProcedure(
  name: string,
  opts: { force?: boolean; dryRun?: boolean; by?: string } = {}
): Promise<DeployResult> {
  const owner = await procedureOwner(name)
  if (owner?.kind === 'import') {
    return {
      name: owner.name,
      kind: 'managed',
      action: 'skipped',
      reason: `import definition ${owner.key} owns it`
    }
  }
  const row = await getManagedProcedure(name)
  if (!row) {
    throw new ManagedProcError(404, 'PROC_NOT_FOUND', `${name} is not an app-managed procedure`)
  }
  const live = NAME_RE.test(row.name) ? await liveProcedureDefinition('dbo', row.name) : null
  return deployManagedRow(row, live, {
    execute: !opts.dryRun,
    force: !!opts.force,
    by: opts.by ?? DEFAULT_BY
  })
}

/**
 * Save a body as the next version, then deploy it. When the deploy fails the save is undone
 * (putBackManaged) and this throws 400 DEPLOY_FAILED with SQL Server's message — config never
 * keeps a body the database refused. A save that changed nothing still deploys (live may differ).
 */
export async function saveAndDeployManaged(
  input: Parameters<typeof saveManagedVersion>[0] & { by: string }
): Promise<{ version: number; unchanged: boolean; deployed: DeployResult }> {
  const { by, ...save } = input
  const saved = await saveManagedVersion(save)
  // Deploy the row this save wrote, not a re-read (a later save is that writer's to deploy).
  const live = await liveProcedureDefinition('dbo', saved.procedure.name)
  const deployed = await deployManagedRow(saved.procedure, live, {
    execute: true,
    force: false,
    by
  })
  if (deployed.action === 'failed') {
    if (!saved.unchanged) {
      await putBackManaged(saved.previous, saved.procedure.id, saved.version)
    }
    throw new ManagedProcError(400, 'DEPLOY_FAILED', deployed.reason ?? 'Deploy failed')
  }
  return { version: saved.version, unchanged: saved.unchanged, deployed }
}

/**
 * Deploy every app-managed procedure (import-owned and managed) into the connected database,
 * deciding each by its live definition (read once). `execute: false` writes nothing and reports
 * the actions it would take. `only` limits the run to those names (case-insensitive). One failure
 * never stops the rest; `failed` counts them.
 */
export async function deployAllAppManaged(opts: {
  execute: boolean
  force?: boolean
  only?: string[]
  by: string
}): Promise<{ results: DeployResult[]; failed: number }> {
  const o: RunOpts = { execute: opts.execute, force: !!opts.force, by: opts.by }
  const only = opts.only?.length ? new Set(opts.only.map((n) => n.toLowerCase())) : null
  const wanted = (name: string) => !only || only.has(name.toLowerCase())

  const [live, imports, managed] = await Promise.all([
    liveProcedureDefinitions(),
    importRows(),
    listManagedProcedures()
  ])
  const importOwner = new Map<string, string>()
  for (const r of imports) if (r.procedure) importOwner.set(r.procedure.toLowerCase(), r.key)

  const results: DeployResult[] = []
  for (const r of imports) {
    if (!r.procedure || !wanted(r.procedure)) continue
    results.push(await deployImportRow(r, live.get(r.procedure.toLowerCase()) ?? null, o))
  }
  for (const r of managed) {
    if (!wanted(r.name)) continue
    const key = importOwner.get(r.name.toLowerCase())
    if (key !== undefined) {
      results.push({
        name: r.name,
        kind: 'managed',
        action: 'skipped',
        reason: `import definition ${key} owns it`
      })
      continue
    }
    results.push(await deployManagedRow(r, live.get(r.name.toLowerCase()) ?? null, o))
  }
  return { results, failed: results.filter((r) => r.action === 'failed').length }
}

/**
 * Config against the live database, per app-managed procedure: in-sync, drifted (live text
 * differs), not-deployed (not live), dropped (dropped in config and gone), dropped-but-live,
 * conflict (a managed row whose name an import owns). Procs config never knew are not listed.
 */
export async function managedDrift(): Promise<DriftEntry[]> {
  const [live, imports, managed] = await Promise.all([
    liveProcedureDefinitions(),
    importRows(),
    listManagedProcedures()
  ])
  const out: DriftEntry[] = []
  const importNames = new Set<string>()
  for (const r of imports) {
    if (!r.procedure) continue
    importNames.add(r.procedure.toLowerCase())
    const l = live.get(r.procedure.toLowerCase())
    const body = String(r.procedure_body ?? '').trim()
    out.push({
      name: r.procedure,
      kind: 'import',
      key: r.key,
      status: l == null ? 'not-deployed' : sameBody(body, l) ? 'in-sync' : 'drifted'
    })
  }
  for (const r of managed) {
    const l = live.get(r.name.toLowerCase())
    const status: DriftStatus = importNames.has(r.name.toLowerCase())
      ? 'conflict'
      : r.dropped_at
        ? l == null
          ? 'dropped'
          : 'dropped-but-live'
        : l == null
          ? 'not-deployed'
          : sameBody(r.body, l)
            ? 'in-sync'
            : 'drifted'
    out.push({ name: r.name, kind: 'managed', id: r.id, status })
  }
  return out
}

const BLOCKERS_SHOWN = 10
let readinessRegistered = false

/** The `managed-proc-drift` readiness check (registered once per process). */
export function registerManagedProcReadiness(): void {
  if (readinessRegistered) return
  readinessRegistered = true
  registerReadinessCheck({
    id: 'managed-proc-drift',
    label: 'App-managed procedures match their config',
    group: 'Data',
    description:
      "Compares every app-managed stored procedure's config body (managed procedures and import definitions) with the live definition in this database. Warns when one differs, is missing, is dropped in config but still live, or is claimed by both a managed row and an import. Run the app-managed procedures deploy to bring the database in line.",
    run: async () => {
      if (!isMssql(db)) return { status: 'skip', detail: 'Stored procedures need SQL Server.' }
      const drift = await managedDrift()
      if (drift.length === 0) return { status: 'skip', detail: 'No app-managed procedures.' }
      const off = drift.filter((d) => d.status !== 'in-sync' && d.status !== 'dropped')
      if (off.length === 0) {
        return { status: 'pass', detail: `${drift.length} procedures match their config` }
      }
      return {
        status: 'warn',
        detail: `${off.length} of ${drift.length} procedures do not match their config`,
        blockers: off.slice(0, BLOCKERS_SHOWN).map((d) => `${d.name}: ${d.status}`)
      }
    }
  })
}
