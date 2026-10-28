import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import {
  definitionNameMatches,
  deployProcedure,
  dropProcedure,
  importBodyTargetsOwn,
  liveProcedureDefinitions,
  sha256,
  sqlErrorText
} from '../procedure-deploy.js'
import { registerReadinessCheck } from '../readiness.js'
import { sameDeployedBody } from './normalize.js'
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
 * A deploy is decided by the LIVE definition: sameDeployedBody(config, live) — header folded,
 * whitespace collapsed, case KEPT (a case-only change in a literal is a change) — means
 * unchanged, anything else is deployed. Never by the stamp — promote and restore copy
 * `deployed_*` from another database, and a copied stamp must not suppress a needed deploy. When
 * live already matches, a wrong stamp is corrected (an honest stamp) and nothing is deployed.
 *
 * Each proc runs in two phases: the DDL, then the stamp. A failure says which (`phase`): a DDL
 * failure changed nothing live; a stamp failure means the database HAS the config body and only
 * the record of it is missing (saveAndDeployManaged keeps config then — it matches live).
 * A stamp is guarded on the row's version + body_hash: a save that moved the row on during the
 * deploy is that writer's to deploy and stamp.
 *
 * Two import definitions naming one proc: neither is deployed (each would ALTER it on every
 * run, and every ALTER replicates in production) until one lets go of it.
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
  /** On `failed`: `deploy` = the DDL (or a check before it) failed, nothing changed live;
   *  `stamp` = the DDL ran, recording it failed. */
  phase?: 'deploy' | 'stamp'
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
const NOT_MSSQL = 'Stored procedures need SQL Server.'

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

const errText = (e: unknown) => sqlErrorText(e)

/** `import definition a owns it` / `import definitions a, b own it`. */
function ownedByImports(keys: string[]): string {
  return keys.length === 1
    ? `import definition ${keys[0]} owns it`
    : `import definitions ${keys.join(', ')} own it`
}

/** `import definitions a, b both own it` (more than two: `all own it`). */
function importConflict(keys: string[]): string {
  return `import definitions ${keys.join(', ')} ${keys.length === 2 ? 'both' : 'all'} own it`
}

/** Import definitions that own a procedure (the same rows the owner answer reads), by key. */
async function importRows(): Promise<ImportRow[]> {
  if (!(await db.schema.hasTable(IMPORTS_TABLE))) return []
  const rows = (await db(IMPORTS_TABLE)
    .whereNotNull('procedure_body')
    .whereNotNull('procedure')
    .select('id', 'key', 'procedure', 'procedure_body', 'procedure_hash')
    .orderBy('key', 'asc')) as Array<Record<string, unknown>>
  return rows
    .map((r) => ({
      id: Number(r.id),
      key: String(r.key),
      procedure: String(r.procedure ?? ''),
      procedure_body: r.procedure_body == null ? null : String(r.procedure_body),
      procedure_hash: r.procedure_hash == null ? null : String(r.procedure_hash)
    }))
    .filter((r) => r.procedure)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** Import rows grouped by lowercased procedure name (first-seen order, keys sorted). */
function groupImports(rows: ImportRow[]): Map<string, ImportRow[]> {
  const out = new Map<string, ImportRow[]>()
  for (const r of rows) {
    const k = r.procedure.toLowerCase()
    const g = out.get(k)
    if (g) g.push(r)
    else out.set(k, [r])
  }
  return out
}

/** Config rows plus the live text of exactly the procs they name (one filtered read). */
async function readConfigAndLive(): Promise<{
  imports: Map<string, ImportRow[]>
  managed: ManagedProcedure[]
  live: Map<string, string>
}> {
  const [rows, managed] = await Promise.all([importRows(), listManagedProcedures()])
  const imports = groupImports(rows)
  const names = [...new Set([...rows.map((r) => r.procedure), ...managed.map((r) => r.name)])]
  const live = names.length ? await liveProcedureDefinitions(names) : new Map<string, string>()
  return { imports, managed, live }
}

/** One proc's live text: '' when it is live but unreadable (encrypted), null when not there. */
async function liveDefinition(name: string): Promise<string | null> {
  return (await liveProcedureDefinitions([name])).get(name.toLowerCase()) ?? null
}

/** One managed row against what the database holds (`live` null = not there). */
async function deployManagedRow(
  row: ManagedProcedure,
  live: string | null,
  o: RunOpts
): Promise<DeployResult> {
  const base = { name: row.name, kind: 'managed' as const }
  const guard = { version: row.version, body_hash: row.body_hash }
  const stamp = async (
    action: DeployAction,
    hash: string | null,
    what: string
  ): Promise<DeployResult> => {
    const done: DeployResult = { ...base, action, hash }
    if (!o.execute) return done
    try {
      const wrote = await stampDeployed(row.id, hash, o.by, guard)
      return wrote ? done : { ...done, reason: 'not stamped: the config row changed meanwhile' }
    } catch (e) {
      return {
        ...base,
        action: 'failed',
        phase: 'stamp',
        hash,
        reason: `${action}, but recording the ${what} failed: ${errText(e)}`
      }
    }
  }

  if (row.dropped_at) {
    if (live == null) {
      // Not there, as config says — correct a stamp that claims otherwise.
      if (row.deployed_hash == null) return { ...base, action: 'absent', hash: null }
      return stamp('absent', null, 'drop')
    }
    if (o.execute) {
      try {
        await dropProcedure(DBO(row.name))
      } catch (e) {
        return { ...base, action: 'failed', phase: 'deploy', reason: errText(e) }
      }
    }
    return stamp('dropped', null, 'drop')
  }
  if (!NAME_RE.test(row.name) || !definitionNameMatches(row.body, row.name)) {
    return {
      ...base,
      action: 'failed',
      phase: 'deploy',
      reason: `the stored body defines another procedure, not CREATE [OR ALTER] PROCEDURE ${row.name} (dbo)`
    }
  }
  if (live != null && !o.force && sameDeployedBody(row.body, live)) {
    if (row.deployed_hash === row.body_hash) {
      return { ...base, action: 'unchanged', hash: row.body_hash }
    }
    return stamp('unchanged', row.body_hash, 'deploy')
  }
  const action: DeployAction = live == null ? 'created' : 'altered'
  if (o.execute) {
    try {
      await deployProcedure(row.body, DBO(row.name))
    } catch (e) {
      return { ...base, action: 'failed', phase: 'deploy', reason: errText(e) }
    }
  }
  return stamp(action, row.body_hash, 'deploy')
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
  const stamp = async (action: DeployAction): Promise<DeployResult> => {
    if (!o.execute || (action === 'unchanged' && row.procedure_hash === hash)) {
      return { ...base, action, hash }
    }
    try {
      await db(IMPORTS_TABLE)
        .where('id', row.id)
        .update({ procedure_hash: hash, procedure_deployed_at: new Date() })
      return { ...base, action, hash }
    } catch (e) {
      return {
        ...base,
        action: 'failed',
        phase: 'stamp',
        hash,
        reason: `${action}, but recording the deploy failed: ${errText(e)}`
      }
    }
  }
  if (live != null && !o.force && sameDeployedBody(body, live)) return stamp('unchanged')
  const action: DeployAction = live == null ? 'created' : 'altered'
  if (o.execute) {
    try {
      await deployProcedure(body, DBO(row.procedure))
    } catch (e) {
      return { ...base, action: 'failed', phase: 'deploy', reason: errText(e) }
    }
  }
  return stamp(action)
}

/**
 * Deploy one managed procedure from config. `dryRun` reports the action and writes nothing;
 * `force` redeploys a proc whose live text already matches. 404 PROC_NOT_FOUND when config has
 * no row for the name; a name an import owns is `skipped` (a dropped row too — nothing
 * import-owned is ever dropped). A failure is `failed` with SQL Server's message and its phase.
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
      reason: ownedByImports(owner.conflictingKeys ?? [owner.key])
    }
  }
  const row = await getManagedProcedure(name)
  if (!row) {
    throw new ManagedProcError(404, 'PROC_NOT_FOUND', `${name} is not an app-managed procedure`)
  }
  const live = NAME_RE.test(row.name) ? await liveDefinition(row.name) : null
  return deployManagedRow(row, live, {
    execute: !opts.dryRun,
    force: !!opts.force,
    by: opts.by ?? DEFAULT_BY
  })
}

/**
 * Save a body as the next version, then deploy it. When the DDL fails the save is undone
 * (putBackManaged) and this throws 400 DEPLOY_FAILED with SQL Server's message — config never
 * keeps a body the database refused. When the DDL ran but recording it failed, config is KEPT
 * (it is what the database now holds; putting it back would let the next deploy-all revert live)
 * and this throws 500 DEPLOY_STAMP_FAILED (`extra.version`). A save that changed nothing still
 * deploys (live may differ).
 */
export async function saveAndDeployManaged(
  input: Parameters<typeof saveManagedVersion>[0] & { by: string }
): Promise<{ version: number; unchanged: boolean; deployed: DeployResult }> {
  const { by, ...save } = input
  const saved = await saveManagedVersion(save)
  // Deploy the row this save wrote, not a re-read (a later save is that writer's to deploy).
  const live = await liveDefinition(saved.procedure.name)
  const deployed = await deployManagedRow(saved.procedure, live, {
    execute: true,
    force: false,
    by
  })
  if (deployed.action === 'failed') {
    if (deployed.phase === 'stamp') {
      throw new ManagedProcError(
        500,
        'DEPLOY_STAMP_FAILED',
        deployed.reason ?? 'Deployed, but recording the deploy failed',
        { version: saved.version }
      )
    }
    if (!saved.unchanged) {
      await putBackManaged(saved.previous, saved.procedure.id, saved.version)
    }
    throw new ManagedProcError(400, 'DEPLOY_FAILED', deployed.reason ?? 'Deploy failed')
  }
  return { version: saved.version, unchanged: saved.unchanged, deployed }
}

/**
 * Deploy every app-managed procedure (import-owned and managed) into the connected database,
 * deciding each by its live definition (one read, limited to the names config holds).
 * `execute: false` writes nothing and reports the actions it would take. `only` limits the run to
 * those names (case-insensitive). One failure never stops the rest. `failed` counts failures;
 * `problems` counts failures plus skips (a body that fails its header check, an empty body, an
 * import conflict, a managed row an import owns) — a chain step exits non-zero on either. Off SQL
 * Server nothing runs and `unsupported` says why.
 */
export async function deployAllAppManaged(opts: {
  execute: boolean
  force?: boolean
  only?: string[]
  by: string
}): Promise<{ results: DeployResult[]; failed: number; problems: number; unsupported?: string }> {
  if (!isMssql(db)) return { results: [], failed: 0, problems: 0, unsupported: NOT_MSSQL }
  const o: RunOpts = { execute: opts.execute, force: !!opts.force, by: opts.by }
  const only = opts.only?.length ? new Set(opts.only.map((n) => n.toLowerCase())) : null
  const wanted = (name: string) => !only || only.has(name.toLowerCase())

  const { imports, managed, live } = await readConfigAndLive()
  const results: DeployResult[] = []
  for (const [lower, group] of imports) {
    if (!wanted(lower)) continue
    if (group.length > 1) {
      const reason = importConflict(group.map((r) => r.key))
      for (const r of group) {
        results.push({ name: r.procedure, kind: 'import', action: 'skipped', reason })
      }
      continue
    }
    results.push(await deployImportRow(group[0], live.get(lower) ?? null, o))
  }
  for (const r of managed) {
    if (!wanted(r.name)) continue
    const owners = imports.get(r.name.toLowerCase())
    if (owners) {
      results.push({
        name: r.name,
        kind: 'managed',
        action: 'skipped',
        reason: ownedByImports(owners.map((x) => x.key))
      })
      continue
    }
    results.push(await deployManagedRow(r, live.get(r.name.toLowerCase()) ?? null, o))
  }
  const failed = results.filter((r) => r.action === 'failed').length
  const problems = failed + results.filter((r) => r.action === 'skipped').length
  return { results, failed, problems }
}

/**
 * Config against the live database, per app-managed procedure: in-sync, drifted (live text
 * differs, case included), not-deployed (not live), dropped (dropped in config and gone),
 * dropped-but-live, conflict (a managed row whose name an import owns, or two import definitions
 * naming one proc). Procs config never knew are not listed. Empty off SQL Server.
 */
export async function managedDrift(): Promise<DriftEntry[]> {
  if (!isMssql(db)) return []
  const { imports, managed, live } = await readConfigAndLive()
  const out: DriftEntry[] = []
  for (const [lower, group] of imports) {
    const l = live.get(lower)
    for (const r of group) {
      const body = String(r.procedure_body ?? '').trim()
      out.push({
        name: r.procedure,
        kind: 'import',
        key: r.key,
        status:
          group.length > 1
            ? 'conflict'
            : l == null
              ? 'not-deployed'
              : sameDeployedBody(body, l)
                ? 'in-sync'
                : 'drifted'
      })
    }
  }
  for (const r of managed) {
    const l = live.get(r.name.toLowerCase())
    const status: DriftStatus = imports.has(r.name.toLowerCase())
      ? 'conflict'
      : r.dropped_at
        ? l == null
          ? 'dropped'
          : 'dropped-but-live'
        : l == null
          ? 'not-deployed'
          : sameDeployedBody(r.body, l)
            ? 'in-sync'
            : 'drifted'
    out.push({ name: r.name, kind: 'managed', id: r.id, status })
  }
  return out
}

const BLOCKERS_SHOWN = 10
const READINESS_TTL_MS = 30 * 60_000
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
      "Compares every app-managed stored procedure's config body (managed procedures and import definitions) with the live definition in this database (only the procedures config names are read). Warns when one differs, is missing, is dropped in config but still live, or is claimed twice (a managed row and an import, or two imports). Run the app-managed procedures deploy to bring the database in line.",
    ttlMs: READINESS_TTL_MS,
    run: async () => {
      if (!isMssql(db)) return { status: 'skip', detail: NOT_MSSQL }
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
