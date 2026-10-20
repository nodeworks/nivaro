// api/src/services/sql-checks/apply.ts
/**
 * Proposing and applying the safe procedure fixes for SQL checks findings (#2563). The rewrite
 * itself is pure (propose.ts); this file reads the current definition, compiles the proposal in a
 * rolled-back transaction, deploys it through the one procedure deploy path
 * (services/procedure-deploy.ts), re-checks the object at once and puts the previous definition
 * back when the re-check is worse. Every apply / rollback / revert is a `proc_fix` row in
 * nivaro_sql_check_fixes whose detail keeps the previous definition, so it can be undone.
 *
 * Import definitions' stored bodies are only rewritten (with a version snapshot), never deployed
 * from here: their own Deploy button does that, after a person has looked.
 */
import type { FastifyRequest } from 'fastify'
import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import {
  deployProcedure,
  liveProcedureDefinition,
  sha256,
  snapshotImportDefinition,
  sqlErrorText,
  toCreateOrAlter
} from '../procedure-deploy.js'
import { withLongConnection } from '../run-long.js'
import { checkObject, type ObjectType, type SqlObject } from './checkers.js'
import {
  type DiffHunk,
  diffForEdits,
  type FindingForFix,
  type ProposalResult,
  proposeFix,
  recheckVerdict,
  unifiedDiff
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

const objectLabel = (f: Pick<FindingRecord, 'object_schema' | 'object_name'>) =>
  `${f.object_schema ? `${f.object_schema}.` : ''}${f.object_name}`

async function loadFinding(id: number): Promise<FindingRecord> {
  const row = (await db(FINDINGS).where('id', id).first()) as FindingRecord | undefined
  if (!row) throw new FixError(404, 'Not found')
  return row
}

interface Current {
  sql: string
  kind: 'module' | 'import_definition'
  importKey?: string
  procedure?: string | null
}

async function currentDefinition(f: FindingRecord): Promise<Current> {
  if (f.object_type === 'procedure') {
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

export interface ProposalOut {
  finding_id: number
  proposable: boolean
  class: ProposalResult['class']
  manual_reason?: string
  risky: boolean
  reasons: string[]
  diff: DiffHunk[]
  unified: string
  current_hash: string
  new_definition_hash: string | null
  compile: CompileResult | null
  target: { type: ObjectType; label: string; kind: Current['kind'] }
  deploys: boolean
  note: string
}

async function build(
  f: FindingRecord,
  withCompile: boolean
): Promise<{ out: ProposalOut; current: Current; proposal: ProposalResult }> {
  const current = await currentDefinition(f)
  const proposal = proposeFix(current.sql, forFix(f), { sourceDupes: await hasSourceDupes(f) })
  const diff = proposal.proposable ? diffForEdits(current.sql, proposal.edits) : []
  const compile =
    withCompile && proposal.newDefinition ? await compileCheck(proposal.newDefinition) : null
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
      diff,
      unified: diff.length ? unifiedDiff(diff, objectLabel(f)) : '',
      current_hash: sha256(current.sql),
      new_definition_hash: proposal.newDefinition ? sha256(proposal.newDefinition) : null,
      compile,
      target: { type: f.object_type, label: objectLabel(f), kind: current.kind },
      deploys: current.kind === 'module',
      note:
        current.kind === 'module'
          ? SOURCE_ELSEWHERE_NOTE
          : 'Only the stored body changes here; deploy it from the import definition when you are ready.'
    }
  }
}

/** GET /findings/:id/proposal */
export async function proposalFor(findingId: number): Promise<ProposalOut> {
  const f = await loadFinding(findingId)
  if (f.status === 'resolved') throw new FixError(409, 'This finding is already resolved.')
  return (await build(f, true)).out
}

const inFlight = new Set<string>()

interface Who {
  userId: string | null
  label: string
  req?: FastifyRequest
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

/** Import definitions whose stored body is the definition that was just replaced. */
async function syncImportBodies(
  procName: string,
  previous: string,
  applied: string,
  who: Who
): Promise<Array<{ key: string; previous_body: string }>> {
  if (!(await db.schema.hasTable('nivaro_import_definitions'))) return []
  const rows = (await db('nivaro_import_definitions')
    .whereRaw('LOWER(??) = ?', ['procedure', procName.toLowerCase()])
    .whereNotNull('procedure_body')
    .select('id', 'key', 'procedure_body')) as Array<{
    id: number
    key: string
    procedure_body: string
  }>
  const synced: Array<{ key: string; previous_body: string }> = []
  const body = toCreateOrAlter(applied)
  for (const r of rows) {
    if (canonicalDefinition(r.procedure_body) !== canonicalDefinition(previous)) continue
    await snapshotImportDefinition(r.key, 'before SQL checks fix', who.userId)
    await db('nivaro_import_definitions')
      .where('id', r.id)
      .update({
        procedure_body: body,
        procedure_hash: sha256(body),
        procedure_deployed_at: new Date()
      })
    synced.push({ key: r.key, previous_body: r.procedure_body })
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
    const { current, proposal, out } = await build(f, false)
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
    const compile = await compileCheck(proposal.newDefinition)
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
      await db('nivaro_import_definitions')
        .where('id', f.object_ref)
        .update({ procedure_body: proposal.newDefinition })
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

    // a procedure: deploy, re-check what SQL Server now holds, roll back when it got worse
    try {
      await deployProcedure(proposal.newDefinition)
    } catch (e) {
      const fixId = await recordFix({
        check_key: f.check_key,
        target,
        detail: { ...base, applied: false, rolled_back: false, error: (e as Error).message },
        who: opts.who
      })
      await audit('sql-check-proc-fix-failed', f, (e as Error).message, opts.who)
      throw Object.assign(new FixError(422, `Deploy failed: ${(e as Error).message}`), { fixId })
    }
    const applied = (await liveProcedureDefinition(f.object_schema, f.object_name)) ?? ''
    const after = checkObject(obj(applied), catalog)
    const verdict = applied
      ? recheckVerdict(before, after, f.check_key)
      : { ok: false, reason: 'the procedure could not be read back after the deploy' }
    if (!verdict.ok) {
      let rollbackError: string | undefined
      try {
        await deployProcedure(current.sql)
      } catch (e) {
        rollbackError = (e as Error).message
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
          recheck: { before: before.length, after: after.length }
        },
        who: opts.who
      })
      await db(EVENTS).insert({
        finding_id: f.id,
        event: 'fix_undone',
        at: new Date(),
        by: opts.who.userId,
        note: `Fix put back automatically: ${verdict.reason}`.slice(0, 500)
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
          `The fix made things worse (${verdict.reason}) and putting the previous definition back failed: ${rollbackError}. Restore it from the Fixes tab or the Procedures page.`
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

/** POST /fixes/:id/revert — put the previous definition back. */
export async function revertFix(fixId: number, who: Who): Promise<{ reverted: true }> {
  const row = (await db(FIXES).where('id', fixId).first()) as
    | { id: number; detail: string | null; target_object: string | null; check_key: string | null }
    | undefined
  if (!row) throw new FixError(404, 'Not found')
  const d = parse(row.detail) as {
    source?: string
    applied?: boolean
    reverted?: boolean
    kind?: Current['kind']
    finding_id?: number
    object?: { type: ObjectType; schema: string | null; name: string; ref: string | null }
    previous_definition?: string
    applied_definition_hash?: string
    import_previous_bodies?: Array<{ key: string; previous_body: string }>
  } | null
  if (d?.source !== 'sql-checks-page' || !d.applied || !d.object || !d.previous_definition)
    throw new FixError(409, 'Only a fix applied from this page can be reverted here.')
  if (d.reverted) throw new FixError(409, 'This fix was already reverted.')
  const key = `rev|${fixId}`
  if (inFlight.has(key)) throw new FixError(409, 'Already reverting.')
  inFlight.add(key)
  try {
    if (d.kind === 'module') {
      const live = await liveProcedureDefinition(d.object.schema, d.object.name)
      if (!live || sha256(live) !== d.applied_definition_hash)
        throw new FixError(
          409,
          'The procedure changed after this fix, so putting the old version back would undo someone else’s change. Compare it on the Procedures page instead.'
        )
      await deployProcedure(d.previous_definition)
      for (const s of d.import_previous_bodies ?? []) {
        await snapshotImportDefinition(s.key, 'before reverting a SQL checks fix', who.userId)
        await db('nivaro_import_definitions')
          .where('key', s.key)
          .update({ procedure_body: s.previous_body })
      }
    } else {
      const cur = (await db('nivaro_import_definitions')
        .where('id', d.object.ref)
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
        .where('id', d.object.ref)
        .update({ procedure_body: d.previous_definition })
    }
    await db(FIXES)
      .where('id', fixId)
      .update({
        detail: JSON.stringify({
          ...d,
          reverted: true,
          reverted_at: new Date().toISOString(),
          reverted_by: who.label
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
    return { reverted: true }
  } finally {
    inFlight.delete(key)
  }
}
