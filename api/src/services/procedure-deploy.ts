// api/src/services/procedure-deploy.ts
/**
 * The one way Nivaro deploys a stored-procedure definition: the Procedures page
 * (routes/procedures.ts), an import definition's stored body (routes/staged-imports.ts) and a fix
 * applied from SQL checks (services/sql-checks/apply.ts) all go through here, so the name check,
 * the CREATE OR ALTER form and the error text never drift between them.
 */
import { createHash } from 'node:crypto'
import { db } from '../db/index.js'

/** The definition must be a single CREATE [OR ALTER] PROCEDURE for exactly the named proc —
 * deploying under one name while defining another is how list state and reality diverge. */
export function definitionNameMatches(definition: string, name: string): boolean {
  const m =
    /create\s+(?:or\s+alter\s+)?proc(?:edure)?\s+(?:\[?dbo\]?\s*\.\s*)?\[?([A-Za-z_][A-Za-z0-9_]*)\]?/i.exec(
      definition
    )
  return !!m && m[1].toLowerCase() === name.toLowerCase()
}

/** `CREATE PROCEDURE` / `CREATE OR ALTER PROC` → `CREATE OR ALTER PROCEDURE` (first one only). */
export const toCreateOrAlter = (definition: string) =>
  definition.replace(/create\s+(or\s+alter\s+)?proc(edure)?/i, 'CREATE OR ALTER PROCEDURE')

/** An import definition's stored body must create ITS OWN procedure. */
export function importBodyTargetsOwn(body: string, proc: string): boolean {
  return new RegExp(
    `create\\s+or\\s+alter\\s+proc(edure)?\\s+(\\[?dbo\\]?\\.)?\\[?${proc}\\]?\\b`,
    'i'
  ).test(body)
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

/** CREATE OR ALTER the procedure. Throws with SQL Server's own message on failure. */
export async function deployProcedure(definition: string): Promise<void> {
  try {
    await db.raw(toCreateOrAlter(definition))
  } catch (e) {
    throw new Error(sqlErrorText(e))
  }
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
