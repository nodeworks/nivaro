// api/src/services/sql-checks/apply.ts
/**
 * Proposing and applying the safe procedure fixes for SQL checks findings (#2563). The rewrite
 * itself is pure (propose.ts); this file reads the current definition, compiles the proposal in a
 * rolled-back transaction, deploys it through the one procedure deploy path
 * (services/procedure-deploy.ts), re-checks the object at once and puts the previous definition
 * back when the re-check is worse. Every apply / put-back / revert is a `proc_fix` row in
 * nivaro_sql_check_fixes whose detail keeps the previous definition, so it can be undone.
 *
 * Safety:
 *  - every text that is deployed names its target explicitly when the header does not (a renamed
 *    procedure keeps its old name in sys.sql_modules; a header without a schema lands in the
 *    login's default schema), so a deploy can never create or replace another object;
 *  - read, hash-compare and CREATE OR ALTER happen on ONE connection under an exclusive
 *    application lock per procedure (`sp_getapplock`, so it holds across replicas): nothing can
 *    change the procedure between the check and the deploy, and a put-back / revert only runs
 *    while the procedure is still exactly what this page deployed;
 *  - stored import bodies are only rewritten (conditionally on being unchanged), never deployed;
 *  - an app-managed procedure (a `nivaro_managed_procedures` row) has ONE writer, its config: the
 *    fix is proposed from the config body, checked statically (as a stored import body is), then
 *    saved as a new version and deployed from config (saveAndDeployManaged) — never a raw ALTER.
 *    A procedure an import definition owns keeps the live path below (its stored bodies follow).
 */
import type { FastifyRequest } from 'fastify'
import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { logManagedProcWrite } from '../managed-procedures/activity.js'
import { saveAndDeployManaged } from '../managed-procedures/deploy.js'
import { procBodyHash } from '../managed-procedures/normalize.js'
import { procedureOwner } from '../managed-procedures/owners.js'
import { getManagedProcedure, ManagedProcError } from '../managed-procedures/store.js'
import {
  deployOn,
  liveProcedureDefinition,
  ProcLockBusyError,
  sha256,
  snapshotImportDefinition,
  sqlErrorText,
  toCreateOrAlter,
  withProcLock
} from '../procedure-deploy.js'
import { withLongConnection } from '../run-long.js'
import { checkObject, type ObjectType, type SqlObject } from './checkers.js'
import {
  type DiffHunk,
  diffForEdits,
  type FindingForFix,
  type ProposalResult,
  procHeaderName,
  proposeFix,
  recheckVerdict,
  unifiedDiff,
  withExplicitName
} from './propose.js'
import { EVENTS, FINDINGS, FIXES, loadCatalog } from './run.js'
import { canonicalDefinition } from './tokenizer.js'

export class FixError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = 'SQL_CHECK_FIX') {
    super(message)
    this.status = status
    this.code = code
  }
}

export const SOURCE_ELSEWHERE_NOTE =
  'If your deployment keeps this procedure’s source elsewhere (a repository or deploy script), update it there too — otherwise the next deploy puts the old version back.'

interface FindingRecord {
  id: number
  check_key: string
  status: string
  object_type: ObjectType
  object_schema: string | null
  object_name: string
  object_ref: string | null
  line: number | null
  message: string
  detail: string | null
}

const parse = (v: unknown): Record<string, unknown> | null => {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v !== 'string') return null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

const objectLabel = (f: { object_schema: string | null; object_name: string }) =>
  `${f.object_schema ? `${f.object_schema}.` : ''}${f.object_name}`

async function loadFinding(id: number): Promise<FindingRecord> {
  const row = (await db(FINDINGS).where('id', id).first()) as FindingRecord | undefined
  if (!row) throw new FixError(404, 'Not found')
  return row
}

interface Current {
  sql: string
  kind: 'module' | 'import_definition' | 'managed_procedure'
  importKey?: string
  /** import_definition: the definition's procedure; managed_procedure: the config row's name. */
  procedure?: string | null
}

export const MANAGED_NOTE =
  'This procedure is app-managed: the fix is saved as a new version in config and deployed from there.'

/** The config owner of a dbo procedure finding when it is app-managed (not an import's). */
async function managedOwner(f: FindingRecord) {
  if ((f.object_schema ?? 'dbo').toLowerCase() !== 'dbo') return null
  const owner = await procedureOwner(f.object_name)
  return owner?.kind === 'managed' ? owner : null
}

async function currentDefinition(f: FindingRecord): Promise<Current> {
  if (f.object_type === 'procedure') {
    const owner = await managedOwner(f)
    if (owner) {
      // Config is the procedure's one writer: the fix is made to the body config deploys.
      if (owner.dropped)
        throw new FixError(
          409,
          `${owner.name} is marked dropped in app config (Developer → Procedures) — the next deploy drops it, so it is not fixed here.`
        )
      const row = await getManagedProcedure(owner.name)
      if (!row?.body) throw new FixError(404, 'The app-managed procedure has no stored body.')
      return { sql: row.body, kind: 'managed_procedure', procedure: row.name }
    }
    const sql = await liveProcedureDefinition(f.object_schema, f.object_name)
    if (!sql) throw new FixError(404, 'The procedure no longer exists.')
    return { sql, kind: 'module' }
  }
  if (f.object_type === 'import_definition' && f.object_ref) {
    const row = (await db('nivaro_import_definitions')
      .where('id', f.object_ref)
      .first('key', 'procedure', 'procedure_body')) as
      | { key: string; procedure: string | null; procedure_body: string | null }
      | undefined
    if (!row?.procedure_body) throw new FixError(404, 'The import definition has no stored body.')
    return {
      sql: row.procedure_body,
      kind: 'import_definition',
      importKey: row.key,
      procedure: row.procedure
    }
  }
  throw new FixError(
    409,
    'Only procedures and import definitions’ stored procedures are fixed here.'
  )
}

const forFix = (f: FindingRecord): FindingForFix => ({
  check_key: f.check_key,
  object_type: f.object_type,
  line: f.line,
  detail: parse(f.detail)
})

/** An open "source may repeat a key" finding on the same MERGE (same object and line). */
async function hasSourceDupes(f: FindingRecord): Promise<boolean> {
  if (f.check_key !== 'merge-null-key') return false
  const row = await db(FINDINGS)
    .where({
      check_key: 'merge-source-dupes',
      object_type: f.object_type,
      object_name: f.object_name,
      line: f.line
    })
    .whereNot('status', 'resolved')
    .first('id')
  return !!row
}

/**
 * The text that is compiled / deployed for a procedure: its header names `[schema].[name]` of the
 * finding's object unless it already names exactly that (renamed procedures and schema-less
 * headers are rewritten; see the file header). Null when it has no procedure header.
 */
export function deployText(sql: string, schema: string | null, name: string): string | null {
  const h = procHeaderName(sql)
  if (!h) return null
  const same =
    h.name.toLowerCase() === name.toLowerCase() &&
    h.schema != null &&
    h.schema.toLowerCase() === (schema ?? 'dbo').toLowerCase()
  return same ? sql : withExplicitName(sql, schema, name)
}

export interface CompileResult {
  ok: boolean
  error?: string
  skipped?: boolean
}

/**
 * Compile `definition` (CREATE OR ALTER) inside a transaction on one pinned connection and roll
 * it back: proves the text is valid without leaving it in place. A short lock timeout keeps it
 * from waiting on a procedure that is running.
 */
export async function compileCheck(definition: string): Promise<CompileResult> {
  if (!isMssql(db)) return { ok: true, skipped: true }
  return withLongConnection(
    async (c) => {
      await c.run('SET LOCK_TIMEOUT 5000')
      try {
        await c.run('BEGIN TRANSACTION')
        try {
          await c.run(toCreateOrAlter(definition), 30_000)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: sqlErrorText(e, 'The proposed definition does not compile') }
        } finally {
          await c.run('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION').catch(() => c.discard())
        }
      } finally {
        await c.run('SET LOCK_TIMEOUT -1').catch(() => c.discard())
      }
    },
    { timeoutMs: 30_000 }
  )
}

const nq = (s: string) => `N'${s.replace(/'/g, "''")}'`
const bracket = (s: string) => `[${s.replace(/]/g, ']]')}]`

/**
 * Read → hash-compare → CREATE OR ALTER → read back, on one connection, holding an exclusive
 * application lock on the procedure for the whole sequence. Refuses (409) when the procedure is
 * no longer the text the caller saw (`expectHash`). Returns the definition SQL Server now holds.
 */
export async function guardedDeploy(
  target: { schema: string | null; name: string },
  expectHash: string,
  text: string
): Promise<string> {
  if (!isMssql(db)) throw new FixError(409, 'Fixes are applied on SQL Server only.')
  const qualified = `${bracket(target.schema ?? 'dbo')}.${bracket(target.name)}`
  const read = `SELECT m.definition FROM sys.sql_modules m WHERE m.object_id = OBJECT_ID(${nq(qualified)}, N'P')`
  return withLongConnection(
    async (c) => {
      try {
        return await withProcLock(c, target, async () => {
          const [cur] = await c.run<{ definition: string | null }>(read)
          if (!cur?.definition || sha256(cur.definition) !== expectHash)
            throw new FixError(
              409,
              'The procedure changed since it was read. Look at the proposed fix again.',
              'SQL_CHECK_FIX_STALE'
            )
          await deployOn(c, text)
          const [after] = await c.run<{ definition: string | null }>(read)
          return after?.definition ?? ''
        })
      } catch (e) {
        if (e instanceof ProcLockBusyError) throw new FixError(409, e.message)
        throw e
      }
    },
    { timeoutMs: 150_000 }
  )
}

export interface ProposalOut {
  finding_id: number
  proposable: boolean
  class: ProposalResult['class']
  manual_reason?: string
  risky: boolean
  reasons: string[]
  notes: string[]
  diff: DiffHunk[]
  unified: string
  current_hash: string
  new_definition_hash: string | null
  target: { type: ObjectType; label: string; kind: Current['kind'] }
  deploys: boolean
  note: string
}

async function build(f: FindingRecord): Promise<{
  out: ProposalOut
  current: Current
  proposal: ProposalResult
}> {
  const current = await currentDefinition(f)
  const proposal = proposeFix(current.sql, forFix(f), { sourceDupes: await hasSourceDupes(f) })
  const diff = proposal.proposable ? diffForEdits(current.sql, proposal.edits) : []
  return {
    current,
    proposal,
    out: {
      finding_id: f.id,
      proposable: proposal.proposable,
      class: proposal.class,
      manual_reason: proposal.manual_reason,
      risky: proposal.risky,
      reasons: proposal.reasons,
      notes: proposal.notes,
      diff,
      unified: diff.length ? unifiedDiff(diff, objectLabel(f)) : '',
      current_hash: sha256(current.sql),
      new_definition_hash: proposal.newDefinition ? sha256(proposal.newDefinition) : null,
      target: { type: f.object_type, label: objectLabel(f), kind: current.kind },
      deploys: current.kind !== 'import_definition',
      note:
        current.kind === 'module'
          ? SOURCE_ELSEWHERE_NOTE
          : current.kind === 'managed_procedure'
            ? MANAGED_NOTE
            : 'Only the stored body changes here; deploy it from the import definition when you are ready.'
    }
  }
}

/** The text compiled for a proposal: what would be deployed (or stored). */
function compileTextFor(f: FindingRecord, current: Current, newDefinition: string): string {
  if (current.kind === 'module') {
    const t = deployText(newDefinition, f.object_schema, f.object_name)
    if (!t) throw new FixError(409, 'The definition has no procedure header to deploy.')
    return t
  }
  return newDefinition
}

/** GET /findings/:id/proposal — diff and risks only; nothing touches the database's objects. */
export async function proposalFor(findingId: number): Promise<ProposalOut> {
  const f = await loadFinding(findingId)
  if (f.status === 'resolved') throw new FixError(409, 'This finding is already resolved.')
  return (await build(f)).out
}

/**
 * POST /findings/:id/proposal/compile — compile the proposal in a rolled-back transaction (takes
 * a schema lock on the procedure for up to 5 s, so it is a POST, never a GET).
 */
export async function compileProposal(
  findingId: number,
  newDefinitionHash: string
): Promise<CompileResult> {
  const f = await loadFinding(findingId)
  if (f.status !== 'open')
    throw new FixError(
      409,
      f.status === 'resolved'
        ? 'This finding is already resolved.'
        : 'This finding is marked as expected; reopen it first.'
    )
  const { current, proposal, out } = await build(f)
  if (!proposal.newDefinition) throw new FixError(409, 'No fix can be proposed for this finding.')
  if (out.new_definition_hash !== newDefinitionHash)
    throw new FixError(
      409,
      'The definition changed since the preview. Look at the proposed fix again.',
      'SQL_CHECK_FIX_STALE'
    )
  return compileCheck(compileTextFor(f, current, proposal.newDefinition))
}

const inFlight = new Set<string>()

interface Who {
  userId: string | null
  label: string
  req?: FastifyRequest
}

/** The deploy actor stamped on an app-managed procedure. */
const deployActor = (who: Who) => (who.userId ? `user:${who.userId}` : 'script:sql-checks')

/** The database refused the DDL: config was put back, live is unchanged. */
class ManagedDeployRefused extends Error {}

/**
 * Save `body` as the next version of an app-managed procedure and deploy it from config,
 * guarded on config still holding `baseHash` (the body this page read). Answers the version and,
 * when the DDL ran but recording it did not, `stampError` (config and live both hold the body).
 * A stale config is 409 SQL_CHECK_FIX_STALE (`staleMessage`); a deploy the database refused is
 * ManagedDeployRefused; any other config refusal is a FixError with its status and code.
 */
async function writeManaged(o: {
  name: string
  body: string
  note: string
  baseHash: string
  who: Who
  staleMessage: string
}): Promise<{ version: number; stampError?: string }> {
  try {
    const saved = await saveAndDeployManaged({
      name: o.name,
      body: o.body,
      note: o.note,
      baseHash: o.baseHash,
      userId: o.who.userId,
      by: deployActor(o.who)
    })
    return { version: saved.version }
  } catch (e) {
    if (!(e instanceof ManagedProcError)) throw e
    if (e.code === 'PROC_STALE') throw new FixError(409, o.staleMessage, 'SQL_CHECK_FIX_STALE')
    if (e.code === 'DEPLOY_FAILED') throw new ManagedDeployRefused(e.message)
    if (e.code === 'DEPLOY_STAMP_FAILED') {
      const v = Number(e.extra?.version)
      return { version: Number.isFinite(v) && v > 0 ? v : 0, stampError: e.message }
    }
    throw new FixError(e.status, e.message, e.code)
  }
}

async function recordFix(row: {
  check_key: string
  target: string
  detail: Record<string, unknown>
  who: Who
}): Promise<number> {
  const [r] = await db(FIXES)
    .insert({
      check_key: row.check_key,
      target_table: null,
      target_object: row.target.slice(0, 256),
      action: 'proc_fix',
      rows_affected: null,
      backup_table: null,
      detail: JSON.stringify(row.detail),
      run_by: row.who.label.slice(0, 200),
      created_at: new Date()
    })
    .returning('id')
  return Number(typeof r === 'object' && r ? (r as { id: unknown }).id : r)
}

interface SyncedBody {
  key: string
  previous_body: string
  previous_hash: string | null
  previous_deployed_at: string | null
  synced_hash: string
}

/** Import definitions whose stored body is the definition that was just replaced. */
async function syncImportBodies(
  procName: string,
  previous: string,
  applied: string,
  who: Who
): Promise<SyncedBody[]> {
  if (!(await db.schema.hasTable('nivaro_import_definitions'))) return []
  const rows = (await db('nivaro_import_definitions')
    .whereRaw('LOWER(??) = ?', ['procedure', procName.toLowerCase()])
    .whereNotNull('procedure_body')
    .select('id', 'key', 'procedure_body', 'procedure_hash', 'procedure_deployed_at')) as Array<{
    id: number
    key: string
    procedure_body: string
    procedure_hash: string | null
    procedure_deployed_at: Date | string | null
  }>
  const synced: SyncedBody[] = []
  const body = toCreateOrAlter(applied)
  for (const r of rows) {
    if (canonicalDefinition(r.procedure_body) !== canonicalDefinition(previous)) continue
    await snapshotImportDefinition(r.key, 'before SQL checks fix', who.userId)
    const n = await db('nivaro_import_definitions')
      .where('id', r.id)
      .where('procedure_body', r.procedure_body)
      .update({
        procedure_body: body,
        procedure_hash: sha256(body),
        procedure_deployed_at: new Date()
      })
    if (!n) continue // changed in the meantime: leave it
    synced.push({
      key: r.key,
      previous_body: r.procedure_body,
      previous_hash: r.procedure_hash,
      previous_deployed_at:
        r.procedure_deployed_at == null ? null : new Date(r.procedure_deployed_at).toISOString(),
      synced_hash: sha256(body)
    })
  }
  return synced
}

export interface ApplyOutcome {
  fix_id: number
  applied: boolean
  rolled_back: boolean
  reason?: string
  deployed: boolean
}

/** POST /findings/:id/apply */
export async function applyFix(opts: {
  findingId: number
  newDefinitionHash: string
  confirmRisky: boolean
  who: Who
}): Promise<ApplyOutcome> {
  const f = await loadFinding(opts.findingId)
  if (f.status === 'resolved') throw new FixError(409, 'This finding is already resolved.')
  const lockKey = `${f.object_type}|${objectLabel(f).toLowerCase()}`
  if (inFlight.has(lockKey))
    throw new FixError(409, 'A fix for this object is already being applied.')
  inFlight.add(lockKey)
  try {
    const { current, proposal, out } = await build(f)
    if (!proposal.proposable || !proposal.newDefinition)
      throw new FixError(409, proposal.manual_reason ?? 'No fix can be proposed for this finding.')
    if (out.new_definition_hash !== opts.newDefinitionHash)
      throw new FixError(
        409,
        'The definition changed since the preview. Look at the proposed fix again.',
        'SQL_CHECK_FIX_STALE'
      )
    if (proposal.risky && !opts.confirmRisky)
      throw new FixError(400, 'This fix needs the extra confirmation (see the warnings).')
    const text = compileTextFor(f, current, proposal.newDefinition)
    const compile = await compileCheck(text)
    if (!compile.ok)
      throw new FixError(422, `The proposed definition does not compile: ${compile.error}`)

    const catalog = await loadCatalog()
    const obj = (definition: string): SqlObject => ({
      schema: f.object_schema,
      name: f.object_name,
      type: f.object_type,
      ref: f.object_ref,
      definition
    })
    const before = checkObject(obj(current.sql), catalog)
    const base = {
      source: 'sql-checks-page',
      finding_id: f.id,
      class: proposal.class,
      object: {
        type: f.object_type,
        schema: f.object_schema,
        name: f.object_name,
        ref: f.object_ref
      },
      kind: current.kind,
      previous_definition: current.sql,
      previous_hash: sha256(current.sql),
      new_definition_hash: out.new_definition_hash,
      diff: out.diff,
      compile,
      risky: proposal.risky,
      risky_confirmed: proposal.risky ? opts.confirmRisky : undefined,
      reasons: proposal.reasons
    }
    const target = objectLabel(f)

    if (current.kind === 'import_definition') {
      const after = checkObject(obj(proposal.newDefinition), catalog)
      const verdict = recheckVerdict(before, after, f.check_key)
      if (!verdict.ok) {
        const fixId = await recordFix({
          check_key: f.check_key,
          target,
          detail: { ...base, applied: false, rolled_back: true, rollback_reason: verdict.reason },
          who: opts.who
        })
        return {
          fix_id: fixId,
          applied: false,
          rolled_back: true,
          reason: verdict.reason,
          deployed: false
        }
      }
      await snapshotImportDefinition(
        current.importKey ?? '',
        'before SQL checks fix',
        opts.who.userId
      )
      const n = await db('nivaro_import_definitions')
        .where('id', f.object_ref)
        .where('procedure_body', current.sql)
        .update({ procedure_body: proposal.newDefinition })
      if (!n)
        throw new FixError(
          409,
          'The stored body changed since it was read. Look at the proposed fix again.',
          'SQL_CHECK_FIX_STALE'
        )
      const fixId = await recordFix({
        check_key: f.check_key,
        target,
        detail: {
          ...base,
          applied: true,
          rolled_back: false,
          deployed: false,
          applied_definition_hash: sha256(proposal.newDefinition),
          recheck: { before: before.length, after: after.length }
        },
        who: opts.who
      })
      await markFixed(
        f,
        fixId,
        opts.who,
        'Stored body fixed from the SQL checks page (not deployed)'
      )
      await audit('sql-check-proc-fix', f, `stored body of ${current.importKey}`, opts.who)
      return { fix_id: fixId, applied: true, rolled_back: false, deployed: false }
    }

    if (current.kind === 'managed_procedure') {
      // Checked statically, as a stored import body is: the deploy is config's (one writer).
      const name = current.procedure ?? f.object_name
      const after = checkObject(obj(proposal.newDefinition), catalog)
      const verdict = recheckVerdict(before, after, f.check_key)
      if (!verdict.ok) {
        const fixId = await recordFix({
          check_key: f.check_key,
          target,
          detail: { ...base, applied: false, rolled_back: true, rollback_reason: verdict.reason },
          who: opts.who
        })
        return {
          fix_id: fixId,
          applied: false,
          rolled_back: true,
          reason: verdict.reason,
          deployed: false
        }
      }
      const note = `SQL checks fix (finding #${f.id})`
      let written: { version: number; stampError?: string }
      try {
        written = await writeManaged({
          name,
          body: proposal.newDefinition,
          note,
          baseHash: procBodyHash(current.sql),
          who: opts.who,
          staleMessage:
            'The app-managed procedure changed in config since it was read. Look at the proposed fix again.'
        })
      } catch (e) {
        if (!(e instanceof ManagedDeployRefused)) throw e
        const fixId = await recordFix({
          check_key: f.check_key,
          target,
          detail: { ...base, applied: false, rolled_back: false, error: e.message },
          who: opts.who
        })
        await audit('sql-check-proc-fix-failed', f, e.message, opts.who)
        throw new FixError(422, `Deploy failed: ${e.message} (fix #${fixId})`)
      }
      const fixId = await recordFix({
        check_key: f.check_key,
        target,
        detail: {
          ...base,
          applied: true,
          rolled_back: false,
          deployed: true,
          managed_procedure: name,
          managed_version: written.version,
          // body_hash form (what config compares a revert against)
          applied_definition_hash: procBodyHash(proposal.newDefinition),
          stamp_error: written.stampError,
          recheck: { before: before.length, after: after.length }
        },
        who: opts.who
      })
      await logManagedProcWrite({
        action: 'procedure-update',
        name,
        version: written.version || null,
        note: written.stampError ? `${note} (not stamped)` : note,
        userId: opts.who.userId,
        req: opts.who.req
      })
      await markFixed(f, fixId, opts.who, 'Fixed from the SQL checks page (saved to app config)')
      await audit(
        'sql-check-proc-fix',
        f,
        `${proposal.class} on ${target} (v${written.version})`,
        opts.who
      )
      return {
        fix_id: fixId,
        applied: true,
        rolled_back: false,
        deployed: true,
        ...(written.stampError
          ? { reason: `deployed, but recording the deploy failed: ${written.stampError}` }
          : {})
      }
    }

    // a procedure: deploy under the lock, re-check what SQL Server now holds, put back when worse
    const targetObj = { schema: f.object_schema, name: f.object_name }
    let applied: string
    try {
      applied = await guardedDeploy(targetObj, sha256(current.sql), text)
    } catch (e) {
      if (e instanceof FixError) throw e
      const fixId = await recordFix({
        check_key: f.check_key,
        target,
        detail: { ...base, applied: false, rolled_back: false, error: (e as Error).message },
        who: opts.who
      })
      await audit('sql-check-proc-fix-failed', f, (e as Error).message, opts.who)
      throw new FixError(422, `Deploy failed: ${(e as Error).message} (fix #${fixId})`)
    }
    const after = checkObject(obj(applied), catalog)
    const verdict = applied
      ? recheckVerdict(before, after, f.check_key)
      : { ok: false, reason: 'the procedure could not be read back after the deploy' }
    if (!verdict.ok) {
      let rollbackError: string | undefined
      const putBack = deployText(current.sql, f.object_schema, f.object_name)
      try {
        if (!putBack) throw new Error('the previous definition has no procedure header')
        await guardedDeploy(targetObj, sha256(applied), putBack)
      } catch (e) {
        rollbackError = e instanceof Error ? e.message : String(e)
      }
      const fixId = await recordFix({
        check_key: f.check_key,
        target,
        detail: {
          ...base,
          applied: false,
          rolled_back: !rollbackError,
          rollback_reason: verdict.reason,
          rollback_error: rollbackError,
          // what is in place when the put-back failed: Restore checks it is still this
          applied_definition_hash: rollbackError ? sha256(applied) : undefined,
          recheck: { before: before.length, after: after.length }
        },
        who: opts.who
      })
      await db(EVENTS).insert({
        finding_id: f.id,
        event: 'fix_undone',
        at: new Date(),
        by: opts.who.userId,
        note: (rollbackError
          ? `Fix made things worse (${verdict.reason}); putting the old version back failed`
          : `Fix put back automatically: ${verdict.reason}`
        ).slice(0, 500)
      })
      await audit(
        'sql-check-proc-fix-rollback',
        f,
        `${verdict.reason}${rollbackError ? ` — rollback failed: ${rollbackError}` : ''}`,
        opts.who
      )
      if (rollbackError)
        throw new FixError(
          500,
          `The fix made things worse (${verdict.reason}) and putting the previous version back failed: ${rollbackError}. Use “Restore previous version” on fix #${fixId} in the Fixes tab, or the Procedures page.`,
          'SQL_CHECK_FIX_ROLLBACK_FAILED'
        )
      return {
        fix_id: fixId,
        applied: false,
        rolled_back: true,
        reason: verdict.reason,
        deployed: true
      }
    }
    const synced = await syncImportBodies(f.object_name, current.sql, applied, opts.who)
    const fixId = await recordFix({
      check_key: f.check_key,
      target,
      detail: {
        ...base,
        applied: true,
        rolled_back: false,
        deployed: true,
        applied_definition_hash: sha256(applied),
        recheck: { before: before.length, after: after.length },
        import_definitions_synced: synced.map((s) => s.key),
        import_previous_bodies: synced
      },
      who: opts.who
    })
    await markFixed(f, fixId, opts.who, 'Fixed from the SQL checks page')
    await audit('sql-check-proc-fix', f, `${proposal.class} on ${target}`, opts.who)
    return { fix_id: fixId, applied: true, rolled_back: false, deployed: true }
  } finally {
    inFlight.delete(lockKey)
  }
}

async function markFixed(f: FindingRecord, fixId: number, who: Who, note: string) {
  const now = new Date()
  await db(FINDINGS).where('id', f.id).update({ status: 'resolved', resolved_at: now })
  await db(EVENTS).insert({
    finding_id: f.id,
    event: 'fixed',
    at: now,
    by: who.userId,
    note: `${note} (fix #${fixId})`.slice(0, 500)
  })
}

async function audit(action: string, f: FindingRecord, comment: string, who: Who) {
  await logActivity({
    action,
    user: who.userId ?? undefined,
    collection: FINDINGS,
    item: String(f.id),
    comment: `${objectLabel(f)}: ${comment}`.slice(0, 1000),
    req: who.req
  })
}

interface FixDetail {
  source?: string
  applied?: boolean
  rollback_error?: string
  reverted?: boolean
  kind?: Current['kind']
  finding_id?: number
  object?: { type: ObjectType; schema: string | null; name: string; ref: string | null }
  previous_definition?: string
  /** module: sha256 of the live text; managed_procedure: procBodyHash (config's body_hash). */
  applied_definition_hash?: string
  import_previous_bodies?: SyncedBody[]
  managed_procedure?: string
}

/** Whether a fixes row can be reverted from the page (pure). */
export function revertable(d: FixDetail | null): boolean {
  return (
    !!d &&
    d.source === 'sql-checks-page' &&
    !d.reverted &&
    !!d.object &&
    !!d.previous_definition &&
    !!d.applied_definition_hash &&
    (d.applied === true || !!d.rollback_error)
  )
}

/**
 * POST /fixes/:id/revert — put the previous definition back: an applied fix, or one whose
 * automatic put-back failed. Refused when the object is no longer what the fix left in place.
 */
export async function revertFix(
  fixId: number,
  who: Who
): Promise<{ reverted: true; skipped_import_bodies: string[] }> {
  const row = (await db(FIXES).where('id', fixId).first()) as
    | { id: number; detail: string | null; target_object: string | null }
    | undefined
  if (!row) throw new FixError(404, 'Not found')
  const d = parse(row.detail) as FixDetail | null
  if (!d || !revertable(d)) {
    if (d?.reverted) throw new FixError(409, 'This fix was already reverted.')
    throw new FixError(409, 'Only a fix applied from this page can be reverted here.')
  }
  const obj = d.object as NonNullable<FixDetail['object']>
  const previous = d.previous_definition as string
  const key = `rev|${fixId}`
  if (inFlight.has(key)) throw new FixError(409, 'Already reverting.')
  inFlight.add(key)
  const skipped: string[] = []
  let managedVersion: number | null = null
  try {
    if (d.kind === 'managed_procedure') {
      // Config is the writer: the previous body becomes the next version, deployed from config.
      const name = d.managed_procedure ?? obj.name
      // A dropped row keeps its body_hash, so the base guard alone would pass — and the save
      // would revive (and redeploy, and promote) a procedure someone dropped on purpose.
      const owner = await procedureOwner(name)
      if (owner?.kind === 'managed' && owner.dropped)
        throw new FixError(
          409,
          `${owner.name} is marked dropped in app config — restore it on the Procedures page (Developer → Procedures) if you want it back.`,
          'MANAGED_PROCEDURE'
        )
      const note = `Reverted SQL checks fix #${fixId}`
      let written: { version: number; stampError?: string }
      try {
        written = await writeManaged({
          name,
          body: previous,
          note,
          baseHash: d.applied_definition_hash as string,
          who,
          staleMessage:
            'The procedure changed in app config after this fix, so putting the old version back would undo someone else’s change. Compare it on the Procedures page instead.'
        })
      } catch (e) {
        if (e instanceof ManagedDeployRefused)
          throw new FixError(422, `Deploy failed: ${e.message}`)
        throw e
      }
      managedVersion = written.version || null
      await logManagedProcWrite({
        action: 'procedure-update',
        name,
        version: managedVersion,
        note: written.stampError ? `${note} (not stamped)` : note,
        userId: who.userId,
        req: who.req
      })
    } else if (d.kind === 'module') {
      // A procedure adopted into app config since the fix has one writer now: config.
      const owner =
        (obj.schema ?? 'dbo').toLowerCase() === 'dbo' ? await procedureOwner(obj.name) : null
      if (owner?.kind === 'managed')
        throw new FixError(
          409,
          `${owner.name} is app-managed now — restore the version you want on the Procedures page (Developer → Procedures).`,
          'MANAGED_PROCEDURE'
        )
      const text = deployText(previous, obj.schema, obj.name)
      if (!text) throw new FixError(409, 'The previous definition has no procedure header.')
      try {
        await guardedDeploy(
          { schema: obj.schema, name: obj.name },
          d.applied_definition_hash as string,
          text
        )
      } catch (e) {
        if (e instanceof FixError && e.code === 'SQL_CHECK_FIX_STALE')
          throw new FixError(
            409,
            'The procedure changed after this fix, so putting the old version back would undo someone else’s change. Compare it on the Procedures page instead.'
          )
        throw e
      }
      for (const s of d.import_previous_bodies ?? []) {
        const cur = (await db('nivaro_import_definitions')
          .where('key', s.key)
          .first('procedure_body')) as { procedure_body: string | null } | undefined
        if (!cur?.procedure_body || sha256(cur.procedure_body) !== s.synced_hash) {
          skipped.push(s.key) // edited since the fix: theirs stays
          continue
        }
        await snapshotImportDefinition(s.key, 'before reverting a SQL checks fix', who.userId)
        await db('nivaro_import_definitions')
          .where('key', s.key)
          .where('procedure_body', cur.procedure_body)
          .update({
            procedure_body: s.previous_body,
            procedure_hash: s.previous_hash,
            procedure_deployed_at: s.previous_deployed_at ? new Date(s.previous_deployed_at) : null
          })
      }
    } else {
      const cur = (await db('nivaro_import_definitions')
        .where('id', obj.ref)
        .first('key', 'procedure_body')) as
        | { key: string; procedure_body: string | null }
        | undefined
      if (!cur?.procedure_body || sha256(cur.procedure_body) !== d.applied_definition_hash)
        throw new FixError(
          409,
          'The stored body changed after this fix, so putting the old one back would undo someone else’s change.'
        )
      await snapshotImportDefinition(cur.key, 'before reverting a SQL checks fix', who.userId)
      await db('nivaro_import_definitions')
        .where('id', obj.ref)
        .where('procedure_body', cur.procedure_body)
        .update({ procedure_body: previous })
    }
    await db(FIXES)
      .where('id', fixId)
      .update({
        detail: JSON.stringify({
          ...d,
          reverted: true,
          reverted_at: new Date().toISOString(),
          reverted_by: who.label,
          revert_skipped_import_bodies: skipped.length ? skipped : undefined,
          reverted_managed_version: managedVersion ?? undefined
        })
      })
    if (d.finding_id) {
      const now = new Date()
      await db(FINDINGS).where('id', d.finding_id).update({ status: 'open', resolved_at: null })
      await db(EVENTS).insert({
        finding_id: d.finding_id,
        event: 'reverted',
        at: now,
        by: who.userId,
        note: `Fix #${fixId} reverted`
      })
    }
    await logActivity({
      action: 'sql-check-proc-fix-revert',
      user: who.userId ?? undefined,
      collection: FIXES,
      item: String(fixId),
      comment: `${row.target_object ?? ''}: previous definition restored`.slice(0, 1000),
      req: who.req
    })
    return { reverted: true, skipped_import_bodies: skipped }
  } finally {
    inFlight.delete(key)
  }
}
