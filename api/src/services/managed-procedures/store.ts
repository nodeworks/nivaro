import { db } from '../../db/index.js'
import {
  definitionNameMatches,
  liveProcedureDefinition,
  toCreateOrAlter
} from '../procedure-deploy.js'
import { procBodyHash, sameDeployedBody } from './normalize.js'
import { MANAGED_TABLE, procedureOwner, VERSIONS_TABLE } from './owners.js'

/**
 * The config store for app-managed procedures: one row per procedure in
 * nivaro_managed_procedures (the current body) and one row per saved body in
 * nivaro_managed_procedure_versions (history; undo = deploy version N).
 *
 * Every write to a body goes through saveManagedVersion(), which asks the owner answer first:
 * an import-owned name is refused (its body lives on the import definition), and the body must
 * define exactly the named dbo procedure. Saving never deploys — the deploy service does that
 * and stamps `deployed_*` with stampDeployed(). A save whose deploy then fails is undone with
 * putBackManaged(previous, id, version).
 *
 * Names compare case-insensitively (SQL Server's default collation; the `name` column is unique).
 * A dropped row is still the owner: saving its name again REVIVES that row (clears dropped_at,
 * bumps the version), it never inserts a second one.
 */

export interface ManagedProcedure {
  id: number
  name: string
  body: string
  body_hash: string
  version: number
  deployed_hash: string | null
  deployed_at: Date | null
  deployed_by: string | null
  description: string | null
  owner: string | null
  updated_at: Date
  updated_by: string | null
  dropped_at: Date | null
}

export interface ManagedVersionSummary {
  version: number
  body_hash: string
  note: string
  created_at: Date
  created_by: string | null
}

export interface ManagedVersion extends ManagedVersionSummary {
  body: string
}

/** A refusal with the HTTP status and code a route answers with. */
export class ManagedProcError extends Error {
  status: number
  code: string
  extra?: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message)
    this.name = 'ManagedProcError'
    this.status = status
    this.code = code
    if (extra) this.extra = extra
  }
}

/** dbo procedure names only. */
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const NAME_MAX = 128
const NOTE_MAX = 500
const TEXT_MAX = 120
const DESCRIPTION_MAX = 500
const ADOPT_NOTE = 'Adopted from the live database'

function assertName(name: string): void {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.length > NAME_MAX) {
    throw new ManagedProcError(
      400,
      'PROC_NAME_INVALID',
      'Invalid procedure name — letters, digits and _ only, not starting with a digit'
    )
  }
}

async function assertNotImportOwned(name: string): Promise<void> {
  const owner = await procedureOwner(name)
  if (owner?.kind === 'import') {
    throw new ManagedProcError(
      409,
      'APP_MANAGED',
      `${owner.name} is managed by the import definition "${owner.key}" — edit it there`,
      { definition: owner.key }
    )
  }
}

const toDate = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(String(v))
const toStr = (v: unknown): string | null => (v == null ? null : String(v))

function toManaged(r: Record<string, unknown>): ManagedProcedure {
  return {
    id: Number(r.id),
    name: String(r.name),
    body: String(r.body ?? ''),
    body_hash: String(r.body_hash ?? ''),
    version: Number(r.version) || 1,
    deployed_hash: toStr(r.deployed_hash),
    deployed_at: toDate(r.deployed_at),
    deployed_by: toStr(r.deployed_by),
    description: toStr(r.description),
    owner: toStr(r.owner),
    updated_at: toDate(r.updated_at) ?? new Date(0),
    updated_by: toStr(r.updated_by),
    dropped_at: toDate(r.dropped_at)
  }
}

function toVersion(r: Record<string, unknown>): ManagedVersionSummary {
  return {
    version: Number(r.version),
    body_hash: String(r.body_hash ?? ''),
    note: String(r.note ?? ''),
    created_at: toDate(r.created_at) ?? new Date(0),
    created_by: toStr(r.created_by)
  }
}

/** SQL Server unique-key violations (2627 constraint, 2601 index), however tedious wraps them. */
function isUniqueViolation(e: unknown): boolean {
  const x = e as {
    number?: number
    originalError?: { number?: number; info?: { number?: number } }
  }
  const n = x?.number ?? x?.originalError?.info?.number ?? x?.originalError?.number
  return n === 2627 || n === 2601
}

/** Thrown inside the save transaction when the guarded update matched no row. */
const LOST_RACE = new Error('managed procedure changed during save')

function staleError(current: ManagedProcedure | null): ManagedProcError {
  return new ManagedProcError(
    409,
    'PROC_STALE',
    'This procedure was changed since you opened it — reload to see the current version',
    { current: current ? { body_hash: current.body_hash, version: current.version } : null }
  )
}

/** The managed row for a name (case-insensitive), or null. Dropped rows included. */
export async function getManagedProcedure(name: string): Promise<ManagedProcedure | null> {
  const row = await db(MANAGED_TABLE).where('name', name).first()
  return row ? toManaged(row) : null
}

/** Every managed row, by name. Empty on a database without the table. */
export async function listManagedProcedures(): Promise<ManagedProcedure[]> {
  if (!(await db.schema.hasTable(MANAGED_TABLE))) return []
  const rows = (await db(MANAGED_TABLE).select('*').orderBy('name', 'asc')) as Array<
    Record<string, unknown>
  >
  return rows.map(toManaged)
}

/** The owner / description a save was given (absent keys are left alone), trimmed to size. */
function metadataPatch(input: {
  owner?: string | null
  description?: string | null
}): Partial<Pick<ManagedProcedure, 'owner' | 'description'>> {
  const patch: Partial<Pick<ManagedProcedure, 'owner' | 'description'>> = {}
  if (input.owner !== undefined) patch.owner = input.owner?.slice(0, TEXT_MAX) ?? null
  if (input.description !== undefined) {
    patch.description = input.description?.slice(0, DESCRIPTION_MAX) ?? null
  }
  return patch
}

/**
 * Update owner / description in place — no version, body untouched. Only the keys that differ
 * from `current` are written, guarded on the row still being at `current.version` (a save that
 * moved it on wins). Resolves the row as it now is.
 */
export async function updateManagedMetadata(
  current: ManagedProcedure,
  patch: Partial<Pick<ManagedProcedure, 'owner' | 'description'>>,
  userId: string | null
): Promise<ManagedProcedure> {
  const changed = Object.fromEntries(
    Object.entries(patch).filter(([k, v]) => current[k as 'owner' | 'description'] !== v)
  )
  if (Object.keys(changed).length === 0) return current
  const hit = await db(MANAGED_TABLE)
    .where({ id: current.id, version: current.version })
    .update({ ...changed, updated_at: new Date(), updated_by: userId })
  if (Number(hit) !== 1) return current
  return (await getManagedProcedure(current.name)) ?? current
}

/**
 * Save a body as the next version of `name` (creating the row as version 1).
 *
 * Refusals, in order: invalid name (400 PROC_NAME_INVALID); import-owned name (409 APP_MANAGED,
 * `extra.definition` = the import key); a body whose real header defines another procedure
 * (400 PROC_HEADER_MISMATCH); `baseHash` given and not the current `body_hash`, or `baseVersion`
 * given and not the current `version` (409 PROC_STALE, `extra.current`). `baseHash: null` /
 * `baseVersion: null` mean "I am creating it" — stale when a row exists. The version catches what
 * the hash cannot: a case-only edit saves a new version with the same body_hash.
 *
 * The stored body is the CREATE OR ALTER form. A body that normalizes to the current hash of a
 * live (not dropped) row, and differs from it at most in header spelling and whitespace (case
 * kept — a case-only edit is saved), is `unchanged`: no version is written; an `owner` or
 * `description` given and different is updated in place (no version bump). Otherwise the row
 * and its version row are written in one transaction, guarded on the row being what we read — a
 * writer that got in between makes this 409 PROC_STALE. `previous` is the row before the save (null
 * for a new one), for putBackManaged().
 */
export async function saveManagedVersion(input: {
  name: string
  body: string
  note: string
  userId: string | null
  baseHash?: string | null
  baseVersion?: number | null
  owner?: string | null
  description?: string | null
}): Promise<{
  procedure: ManagedProcedure
  version: number
  unchanged: boolean
  previous: ManagedProcedure | null
}> {
  const { name, note, userId } = input
  assertName(name)
  await assertNotImportOwned(name)
  const raw = String(input.body ?? '')
  if (!definitionNameMatches(raw, name)) {
    throw new ManagedProcError(
      400,
      'PROC_HEADER_MISMATCH',
      `The definition must be CREATE [OR ALTER] PROCEDURE for ${name} (dbo)`
    )
  }

  const current = await getManagedProcedure(name)
  if (input.baseHash !== undefined && (current?.body_hash ?? null) !== input.baseHash) {
    throw staleError(current)
  }
  if (input.baseVersion !== undefined && (current?.version ?? null) !== input.baseVersion) {
    throw staleError(current)
  }

  const body = toCreateOrAlter(raw)
  const bodyHash = procBodyHash(body)
  // Unchanged = same hash AND same deploy form: body_hash lowercases, so a case-only edit (a
  // literal 'Open' → 'OPEN') hashes the same yet is a real change the deploy must ship.
  if (
    current &&
    current.body_hash === bodyHash &&
    current.dropped_at == null &&
    sameDeployedBody(current.body, body)
  ) {
    const procedure = await updateManagedMetadata(current, metadataPatch(input), userId)
    return { procedure, version: current.version, unchanged: true, previous: current }
  }

  const now = new Date()
  const version = current ? current.version + 1 : 1
  const patch: Record<string, unknown> = {
    body,
    body_hash: bodyHash,
    version,
    updated_at: now,
    updated_by: userId,
    dropped_at: null,
    ...metadataPatch(input)
  }

  let id: number
  try {
    id = await db.transaction(async (trx) => {
      let rowId: number
      if (current) {
        const hit = await trx(MANAGED_TABLE)
          .where({ id: current.id, version: current.version, body_hash: current.body_hash })
          .update(patch)
        if (Number(hit) !== 1) throw LOST_RACE
        rowId = current.id
      } else {
        // Insert, then select the identity by the unique name (`.returning` yields an object here).
        await trx(MANAGED_TABLE).insert({ name, ...patch })
        const row = await trx(MANAGED_TABLE).where('name', name).first('id')
        rowId = Number(row?.id)
      }
      await trx(VERSIONS_TABLE).insert({
        procedure_id: rowId,
        version,
        body,
        body_hash: bodyHash,
        note: String(note ?? '').slice(0, NOTE_MAX),
        created_at: now,
        created_by: userId
      })
      return rowId
    })
  } catch (e) {
    // The row moved on under us, or another first save of this name won the unique key — read
    // the current row only now, after the rollback, never on a second connection mid-transaction.
    if (e === LOST_RACE || isUniqueViolation(e)) throw staleError(await getManagedProcedure(name))
    throw e
  }

  const saved = await db(MANAGED_TABLE).where('id', id).first()
  if (!saved) throw staleError(null)
  return { procedure: toManaged(saved), version, unchanged: false, previous: current }
}

/**
 * Store a live procedure's definition as a managed version (version 1 for a proc config did not
 * own), then stamp it deployed — live and config now match. 404 PROC_NOT_FOUND when the proc is
 * not in this database; 409 APP_MANAGED for an import-owned one. `by` is the deploy actor
 * (`user:<id>` / `script:<name>`).
 */
export async function adoptLiveProcedure(
  name: string,
  opts: {
    userId: string | null
    note?: string
    owner?: string | null
    by: string
    /** As saveManagedVersion: `null` = "config has no row" — 409 PROC_STALE when one exists
     *  (another writer adopted it first). */
    baseHash?: string | null
  }
): Promise<{ procedure: ManagedProcedure; version: number; unchanged: boolean }> {
  assertName(name)
  await assertNotImportOwned(name)
  const definition = await liveProcedureDefinition('dbo', name)
  if (definition == null) {
    throw new ManagedProcError(404, 'PROC_NOT_FOUND', `dbo.${name} is not in this database`)
  }
  const r = await saveManagedVersion({
    name,
    body: definition,
    note: opts.note ?? ADOPT_NOTE,
    userId: opts.userId,
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
    ...(opts.baseHash !== undefined ? { baseHash: opts.baseHash } : {})
  })
  await stampDeployed(r.procedure.id, r.procedure.body_hash, opts.by)
  const procedure = (await getManagedProcedure(r.procedure.name)) ?? r.procedure
  return { procedure, version: r.version, unchanged: r.unchanged }
}

/**
 * Mark a managed proc dropped: the deploy step drops the live proc. Body and versions are kept,
 * so the drop travels with config and a later save revives it. 404 when there is no row; a row
 * already dropped is returned as is.
 */
export async function markManagedDropped(
  name: string,
  userId: string | null
): Promise<ManagedProcedure> {
  const current = await getManagedProcedure(name)
  if (!current) {
    throw new ManagedProcError(404, 'PROC_NOT_FOUND', `${name} is not an app-managed procedure`)
  }
  if (current.dropped_at) return current
  const now = new Date()
  await db(MANAGED_TABLE)
    .where('id', current.id)
    .update({ dropped_at: now, updated_at: now, updated_by: userId })
  return (await getManagedProcedure(name)) ?? { ...current, dropped_at: now }
}

/**
 * Undo markManagedDropped() whose drop did not run: put dropped_at / updated_* back as they were
 * in `previous` (the row read before the mark). Guarded on the row still being at that version
 * and marked dropped — a save since then is left alone. Resolves whether it wrote.
 */
export async function unmarkManagedDropped(previous: ManagedProcedure): Promise<boolean> {
  const hit = await db(MANAGED_TABLE)
    .where({ id: previous.id, version: previous.version })
    .whereNotNull('dropped_at')
    .update({
      dropped_at: previous.dropped_at,
      updated_at: previous.updated_at,
      updated_by: previous.updated_by
    })
  return Number(hit) === 1
}

/** A managed proc's saved versions, newest first (no bodies). Empty when it is not managed. */
export async function listManagedVersions(name: string): Promise<ManagedVersionSummary[]> {
  const p = await getManagedProcedure(name)
  if (!p) return []
  const rows = (await db(VERSIONS_TABLE)
    .where('procedure_id', p.id)
    .select('version', 'body_hash', 'note', 'created_at', 'created_by')
    .orderBy('version', 'desc')) as Array<Record<string, unknown>>
  return rows.map(toVersion)
}

/** One saved version with its body, or null. */
export async function getManagedVersion(
  name: string,
  version: number
): Promise<ManagedVersion | null> {
  const p = await getManagedProcedure(name)
  if (!p) return null
  const row = await db(VERSIONS_TABLE).where({ procedure_id: p.id, version }).first()
  if (!row) return null
  return { ...toVersion(row), body: String(row.body ?? '') }
}

/**
 * Record what this database just got from config (`hash` null after a drop). With `guard`, the
 * stamp is written only while the row is still at that version and body_hash — a save that moved
 * it on during the deploy is its own writer's to deploy and stamp. Resolves whether it wrote.
 */
export async function stampDeployed(
  id: number,
  hash: string | null,
  by: string,
  guard?: { version: number; body_hash: string }
): Promise<boolean> {
  const where: Record<string, unknown> = { id }
  if (guard) {
    where.version = guard.version
    where.body_hash = guard.body_hash
  }
  const hit = await db(MANAGED_TABLE)
    .where(where)
    .update({
      deployed_hash: hash,
      deployed_at: new Date(),
      deployed_by: String(by ?? '').slice(0, TEXT_MAX) || null
    })
  return Number(hit) > 0
}

/**
 * Undo one save (its deploy failed): restore the row as it was and delete the version row the
 * save wrote; a save that created the row deletes the row and its versions. Guarded on the row
 * still being at `savedVersion` — when a later save moved it on, nothing is touched.
 */
export async function putBackManaged(
  previous: ManagedProcedure | null,
  savedId: number,
  savedVersion: number
): Promise<void> {
  await db.transaction(async (trx) => {
    if (previous == null) {
      const row = await trx(MANAGED_TABLE).where({ id: savedId, version: savedVersion }).first('id')
      if (!row) return
      await trx(VERSIONS_TABLE).where('procedure_id', savedId).del()
      await trx(MANAGED_TABLE).where('id', savedId).del()
      return
    }
    const hit = await trx(MANAGED_TABLE).where({ id: savedId, version: savedVersion }).update({
      body: previous.body,
      body_hash: previous.body_hash,
      version: previous.version,
      deployed_hash: previous.deployed_hash,
      deployed_at: previous.deployed_at,
      deployed_by: previous.deployed_by,
      description: previous.description,
      owner: previous.owner,
      updated_at: previous.updated_at,
      updated_by: previous.updated_by,
      dropped_at: previous.dropped_at
    })
    if (Number(hit) !== 1) return
    await trx(VERSIONS_TABLE).where({ procedure_id: savedId, version: savedVersion }).del()
  })
}
