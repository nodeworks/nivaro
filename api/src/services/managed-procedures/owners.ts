import { db } from '../../db/index.js'

/**
 * "Who owns this stored procedure?" — the one answer every procedure writer asks first.
 *
 * A procedure is app-managed when its body lives in configuration, with one writer (the app's
 * deploy, by hash):
 *   - an import definition with a stored body (`nivaro_import_definitions.procedure_body`) owns
 *     its `procedure`;
 *   - a row in `nivaro_managed_procedures` owns its `name` — a row marked `dropped_at` too, since
 *     the deploy step drops that proc and no other writer may bring it back.
 * When both claim a name the import wins (it was the owner first); managedImportCollisions()
 * lists those so they can be resolved. When two import definitions name one proc, the first by
 * key is `key` and `conflictingKeys` lists them all (the answer never depends on row order). Names compare lowercased (SQL Server's default
 * collation is case-insensitive). A missing table contributes nothing (an older database);
 * any other read error is thrown — a writer must not take "could not ask" for "nobody owns it".
 */

export const MANAGED_TABLE = 'nivaro_managed_procedures'
export const VERSIONS_TABLE = 'nivaro_managed_procedure_versions'
const IMPORTS_TABLE = 'nivaro_import_definitions'

export type ProcOwner =
  | {
      kind: 'import'
      key: string
      name: string
      /** Set only when two or more import definitions name this proc: every key, sorted. The
       *  deploy refuses such a proc until one definition lets go of it. */
      conflictingKeys?: string[]
    }
  | { kind: 'managed'; id: number; name: string; dropped: boolean }

/** A database name we may put in a three-part name (bracketed; no escaping needed). */
const DATABASE_RE = /^[A-Za-z0-9_]+$/

type ImportRow = { key: unknown; procedure: unknown }
type ManagedRow = { id: unknown; name: unknown; dropped_at: unknown }

async function readOwnerRows(
  database?: string
): Promise<{ imports: ImportRow[]; managed: ManagedRow[] }> {
  if (database === undefined) {
    const [hasImports, hasManaged] = await Promise.all([
      db.schema.hasTable(IMPORTS_TABLE),
      db.schema.hasTable(MANAGED_TABLE)
    ])
    const [imports, managed] = await Promise.all([
      hasImports
        ? (db(IMPORTS_TABLE)
            .whereNotNull('procedure_body')
            .whereNotNull('procedure')
            .select('key', 'procedure') as Promise<ImportRow[]>)
        : Promise.resolve([] as ImportRow[]),
      hasManaged
        ? (db(MANAGED_TABLE).select('id', 'name', 'dropped_at') as Promise<ManagedRow[]>)
        : Promise.resolve([] as ManagedRow[])
    ])
    return { imports, managed }
  }
  if (!DATABASE_RE.test(database)) {
    throw new Error(`Invalid database name "${database}" — letters, digits and _ only`)
  }
  const exists = async (table: string) => {
    const rows = (await db.raw('SELECT OBJECT_ID(?) AS oid', [
      `[${database}].dbo.${table}`
    ])) as Array<{ oid: number | null }>
    return rows?.[0]?.oid != null
  }
  const [hasImports, hasManaged] = await Promise.all([exists(IMPORTS_TABLE), exists(MANAGED_TABLE)])
  const [imports, managed] = await Promise.all([
    hasImports
      ? (db.raw(
          `SELECT [key], [procedure] FROM [${database}].dbo.${IMPORTS_TABLE}
           WHERE procedure_body IS NOT NULL AND [procedure] IS NOT NULL
           ORDER BY [key]`
        ) as unknown as Promise<ImportRow[]>)
      : Promise.resolve([] as ImportRow[]),
    hasManaged
      ? (db.raw(
          `SELECT id, name, dropped_at FROM [${database}].dbo.${MANAGED_TABLE}`
        ) as unknown as Promise<ManagedRow[]>)
      : Promise.resolve([] as ManagedRow[])
  ])
  return { imports, managed }
}

/**
 * Every app-managed procedure, keyed by lowercased name. `database` reads another database on
 * the same server (`[db].dbo.<table>`, each guarded by OBJECT_ID) — a DB → DB copy asks the
 * source; it must be a plain identifier or this throws.
 */
export async function appManagedProcedures(opts?: {
  database?: string
}): Promise<Map<string, ProcOwner>> {
  const { imports, managed } = await readOwnerRows(opts?.database)
  const out = new Map<string, ProcOwner>()
  for (const r of managed ?? []) {
    const name = String(r.name ?? '')
    if (!name) continue
    out.set(name.toLowerCase(), {
      kind: 'managed',
      id: Number(r.id),
      name,
      dropped: r.dropped_at != null
    })
  }
  // Imports last: they win a collision. Sorted by key so the first definition is always the same.
  const byKey = [...(imports ?? [])].sort((a, b) =>
    String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0
  )
  const seen = new Set<string>()
  for (const r of byKey) {
    const name = String(r.procedure ?? '')
    if (!name) continue
    const lower = name.toLowerCase()
    const prior = out.get(lower)
    if (seen.has(lower) && prior?.kind === 'import') {
      prior.conflictingKeys = [...(prior.conflictingKeys ?? [prior.key]), String(r.key)]
      continue
    }
    seen.add(lower)
    out.set(lower, { kind: 'import', key: String(r.key), name })
  }
  return out
}

/** The owner of one procedure (case-insensitive), or null when config does not own it. */
export async function procedureOwner(name: string): Promise<ProcOwner | null> {
  return (await appManagedProcedures()).get(name.toLowerCase()) ?? null
}

/** Lowercased names claimed by BOTH a managed row and an import body (the import wins). */
export async function managedImportCollisions(): Promise<string[]> {
  const { imports, managed } = await readOwnerRows()
  const managedNames = new Set(
    (managed ?? []).map((r) => String(r.name ?? '').toLowerCase()).filter(Boolean)
  )
  const hits = new Set<string>()
  for (const r of imports ?? []) {
    const n = String(r.procedure ?? '').toLowerCase()
    if (n && managedNames.has(n)) hits.add(n)
  }
  return [...hits].sort()
}
