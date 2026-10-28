// api/src/services/procedure-deploy.ts
/**
 * The one way Nivaro deploys a stored-procedure definition: the Procedures page
 * (routes/procedures.ts), an import definition's stored body (routes/staged-imports.ts) and a fix
 * applied from SQL checks (services/sql-checks/apply.ts) all go through here, so the name check,
 * the CREATE OR ALTER form and the error text never drift between them.
 */
import { createHash } from 'node:crypto'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { type LongConnection, withLongConnection } from './run-long.js'
import { procHeaderName } from './sql-checks/propose.js'
import { maskSql } from './sql-checks/tokenizer.js'

/** The definition must be a CREATE [OR ALTER] PROCEDURE for exactly the named dbo proc —
 * deploying under one name while defining another is how list state and reality diverge. The
 * header is read outside comments and string literals (a `/* create procedure x *\/` decoy above
 * the real header does not count). */
export function definitionNameMatches(definition: string, name: string): boolean {
  const h = procHeaderName(definition)
  return (
    !!h &&
    /^CREATE( OR ALTER)? PROC(EDURE)?$/.test(h.verb) &&
    h.name.toLowerCase() === name.toLowerCase() &&
    (h.schema == null || h.schema.toLowerCase() === 'dbo')
  )
}

/**
 * `CREATE PROCEDURE` / `CREATE PROC` → `CREATE OR ALTER PROCEDURE`: the first one OUTSIDE comments
 * and string literals, so a comment above the header is never rewritten. A header that already
 * says CREATE OR ALTER is left exactly as written (the stored text stays byte-identical).
 */
export function toCreateOrAlter(definition: string): string {
  const m = /\bcreate\s+(or\s+alter\s+)?proc(?:edure)?\b/i.exec(maskSql(definition))
  if (!m || m[1]) return definition
  return `${definition.slice(0, m.index)}CREATE OR ALTER PROCEDURE${definition.slice(m.index + m[0].length)}`
}

/** An import definition's stored body must CREATE OR ALTER ITS OWN (dbo) procedure; the header is
 * read outside comments and string literals. */
export function importBodyTargetsOwn(body: string, proc: string): boolean {
  const h = procHeaderName(body)
  return (
    !!h &&
    /^CREATE OR ALTER PROC(EDURE)?$/.test(h.verb) &&
    h.name.toLowerCase() === proc.toLowerCase() &&
    (h.schema == null || h.schema.toLowerCase() === 'dbo')
  )
}

/** knex/mssql AggregateErrors carry an empty .message — the SQL Server messages live in .errors. */
export function sqlErrorText(e: unknown, fallback = 'Deploy failed'): string {
  const errs = (e as { errors?: Array<{ message?: string }> })?.errors ?? [e as Error]
  return (
    errs
      .map((x) => x?.message)
      .filter(Boolean)
      .join(' | ') || fallback
  )
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const DEPLOY_TIMEOUT_MS = 120_000
/** How long a deploy waits for a lock on the procedure (one that is running) before giving up. */
const DEPLOY_LOCK_TIMEOUT_MS = 10_000

/**
 * CREATE OR ALTER on a connection the caller already holds (no `?` binding parsing: the text goes
 * to SQL Server as one batch). Throws with SQL Server's own message.
 */
export async function deployOn(conn: LongConnection, definition: string): Promise<void> {
  try {
    await conn.run(`SET LOCK_TIMEOUT ${DEPLOY_LOCK_TIMEOUT_MS}`)
    try {
      await conn.run(toCreateOrAlter(definition), DEPLOY_TIMEOUT_MS)
    } finally {
      await conn.run('SET LOCK_TIMEOUT -1').catch(() => conn.discard())
    }
  } catch (e) {
    throw new Error(sqlErrorText(e))
  }
}

export class ProcLockBusyError extends Error {}

const nq = (s: string) => `N'${s.replace(/'/g, "''")}'`

/** The application-lock resource for one procedure (shared by every deploy path). */
export const procLockResource = (schema: string | null, name: string) =>
  `sqlcheck:${(schema ?? 'dbo').toLowerCase()}.${name.toLowerCase()}`.slice(0, 255)

/**
 * Run `fn` holding an exclusive, session-owned application lock on the procedure, on `conn`
 * (sp_getapplock holds across replicas: two servers never change one procedure at once). Throws
 * ProcLockBusyError when the lock is not granted within 15 s. No lock on other dialects.
 */
export async function withProcLock<T>(
  conn: LongConnection,
  target: { schema: string | null; name: string },
  fn: () => Promise<T>
): Promise<T> {
  if (!isMssql(db)) return fn()
  const resource = nq(procLockResource(target.schema, target.name))
  const [lock] = await conn.run<{ r: number }>(
    `DECLARE @r int; EXEC @r = sp_getapplock @Resource = ${resource}, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 15000; SELECT @r AS r`
  )
  if (!(Number(lock?.r) >= 0))
    throw new ProcLockBusyError(
      'Another change to this procedure is in progress. Try again shortly.'
    )
  try {
    return await fn()
  } finally {
    await conn
      .run(`EXEC sp_releaseapplock @Resource = ${resource}, @LockOwner = 'Session'`)
      .catch(() => conn.discard())
  }
}

/**
 * CREATE OR ALTER the procedure on its own pinned connection, holding the procedure's
 * application lock. Throws with SQL Server's message.
 */
export async function deployProcedure(
  definition: string,
  target: { schema: string | null; name: string }
): Promise<void> {
  await withLongConnection((c) => withProcLock(c, target, () => deployOn(c, definition)), {
    timeoutMs: DEPLOY_TIMEOUT_MS
  })
}

/** dbo procedure names only (the drop puts the name in brackets, never binds it). */
const PROC_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * DROP PROCEDURE IF EXISTS on its own pinned connection, holding the procedure's application
 * lock — the same path as a deploy. dbo only; the name is re-checked here because it goes into
 * the statement text. Throws with SQL Server's message.
 */
export async function dropProcedure(target: {
  schema: string | null
  name: string
}): Promise<void> {
  const schema = target.schema ?? 'dbo'
  if (schema.toLowerCase() !== 'dbo' || !PROC_NAME_RE.test(target.name)) {
    throw new Error(`Refusing to drop ${schema}.${target.name}: dbo procedure names only`)
  }
  await withLongConnection(
    (c) =>
      withProcLock(c, target, async () => {
        try {
          await c.run(`SET LOCK_TIMEOUT ${DEPLOY_LOCK_TIMEOUT_MS}`)
          try {
            await c.run(`DROP PROCEDURE IF EXISTS [dbo].[${target.name}]`, DEPLOY_TIMEOUT_MS)
          } finally {
            await c.run('SET LOCK_TIMEOUT -1').catch(() => c.discard())
          }
        } catch (e) {
          throw new Error(sqlErrorText(e, 'Drop failed'))
        }
      }),
    { timeoutMs: DEPLOY_TIMEOUT_MS }
  )
}

/** Names per IN (…) read — well under SQL Server's ~2100 bound-parameter cap. */
const LIVE_READ_CHUNK = 500

/**
 * User dbo procedures' text as SQL Server keeps it, keyed by lowercased name — one read for a
 * whole deploy run or drift report. `names` limits the read to those procedures (in chunks);
 * omitted, every user dbo procedure. A proc whose text is not readable (WITH ENCRYPTION: its
 * sys.sql_modules definition is NULL) maps to '' — it is live (a drop must see it) and never
 * matches a config body. Unlike liveProcedureDefinition(), which answers null for it.
 */
export async function liveProcedureDefinitions(names?: string[]): Promise<Map<string, string>> {
  const base = `SELECT p.name, m.definition FROM sys.procedures p
       JOIN sys.schemas s ON s.schema_id = p.schema_id
       LEFT JOIN sys.sql_modules m ON m.object_id = p.object_id
      WHERE p.is_ms_shipped = 0 AND s.name = 'dbo'`
  const reads: Array<Promise<unknown>> = []
  if (names === undefined) reads.push(db.raw(base))
  else {
    const wanted = [...new Set(names.filter((n) => PROC_NAME_RE.test(n)))]
    for (let i = 0; i < wanted.length; i += LIVE_READ_CHUNK) {
      const chunk = wanted.slice(i, i + LIVE_READ_CHUNK)
      reads.push(db.raw(`${base} AND p.name IN (${chunk.map(() => '?').join(', ')})`, chunk))
    }
  }
  const out = new Map<string, string>()
  for (const rows of (await Promise.all(reads)) as Array<
    Array<{ name: string; definition: string | null }>
  >) {
    for (const r of rows ?? []) {
      if (r?.name) out.set(String(r.name).toLowerCase(), r.definition ?? '')
    }
  }
  return out
}

/** The procedure's text as SQL Server keeps it, or null. */
export async function liveProcedureDefinition(
  schema: string | null,
  name: string
): Promise<string | null> {
  const rows = (await db.raw(
    `SELECT m.definition FROM sys.sql_modules m
       JOIN sys.procedures p ON p.object_id = m.object_id
       JOIN sys.schemas s ON s.schema_id = p.schema_id
      WHERE p.name = ? AND s.name = ? AND p.is_ms_shipped = 0`,
    [name, schema ?? 'dbo']
  )) as Array<{ definition: string | null }>
  return rows[0]?.definition ?? null
}

/** Snapshot an import definition (proc body + schema + validation together) so a bad edit is one
 *  click from undone. Content-deduped, pruned to 30. Never throws. */
export async function snapshotImportDefinition(
  key: string,
  note: string,
  userId: string | null
): Promise<void> {
  try {
    const row = await db('nivaro_import_definitions').where({ key }).first()
    if (!row) return
    const snapshot = JSON.stringify(row)
    const latest = await db('nivaro_import_definition_versions')
      .where('definition', row.id)
      .orderBy('version', 'desc')
      .first()
    if (latest && latest.snapshot === snapshot) return
    await db('nivaro_import_definition_versions').insert({
      definition: row.id,
      version: (Number(latest?.version) || 0) + 1,
      snapshot,
      note: note.slice(0, 255),
      created_by: userId,
      created_at: new Date()
    })
    const versions = await db('nivaro_import_definition_versions')
      .where('definition', row.id)
      .orderBy('version', 'desc')
      .select('id')
    if (versions.length > 30) {
      await db('nivaro_import_definition_versions')
        .whereIn(
          'id',
          versions.slice(30).map((v) => v.id)
        )
        .del()
    }
  } catch {
    // Version capture must never block the edit it protects.
  }
}
