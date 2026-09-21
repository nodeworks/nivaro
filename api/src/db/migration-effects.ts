import type { Knex } from 'knex'

/**
 * What a migration actually did.
 *
 * The ledger (nivaro_migrations) records that a file RAN. Every migration here
 * is hasTable / hasColumn / IF NOT EXISTS guarded, so "ran" covers two very
 * different events: the fresh-database case where it built things, and the
 * case where someone had already created the object by hand and it did nothing.
 * The ledger cannot tell them apart.
 *
 * Each `up` is wrapped: the schema is listed before and after, and the
 * difference is stored beside the ledger in nivaro_migration_effects. A
 * data-only migration (a backfill) changes no schema and reads the same as a
 * no-op here — the row says "no schema change", never "did nothing".
 *
 * Recording is best-effort. A failure to list or store must never fail a
 * migration, so every step swallows its own errors.
 */

export const EFFECTS_TABLE = 'nivaro_migration_effects'

export interface MigrationEffects {
  added: string[]
  removed: string[]
}

function dialectOf(knex: Knex): string {
  // biome-ignore lint/suspicious/noExplicitAny: knex client config is untyped
  return String((knex as any).client?.config?.client ?? '')
}

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) {
    // mysql2 answers [rows, fields]; mssql answers rows.
    return (Array.isArray(res[0]) ? res[0] : res) as Array<Record<string, unknown>>
  }
  return ((res as { rows?: unknown[] })?.rows ?? []) as Array<Record<string, unknown>>
}

/** Every schema object as one comparable line. */
export async function listSchema(knex: Knex): Promise<Set<string>> {
  const out = new Set<string>()
  const dialect = dialectOf(knex)
  if (dialect === 'mssql') {
    const res = await knex.raw(`
      SELECT 'table ' + t.name AS line FROM sys.tables t
      UNION ALL
      SELECT 'column ' + t.name + '.' + c.name + ' ' + ty.name
             + CASE WHEN c.is_nullable = 1 THEN ' null' ELSE ' not null' END
        FROM sys.columns c
        JOIN sys.tables t ON t.object_id = c.object_id
        JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      UNION ALL
      SELECT 'index ' + t.name + '.' + i.name
        FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id
       WHERE i.name IS NOT NULL
      UNION ALL
      SELECT 'foreign key ' + t.name + '.' + f.name
        FROM sys.foreign_keys f JOIN sys.tables t ON t.object_id = f.parent_object_id
      UNION ALL
      SELECT 'procedure ' + p.name FROM sys.procedures p
    `)
    for (const r of rowsOf(res)) out.add(String(r.line))
    return out
  }
  const schemaClause =
    dialect === 'pg' || dialect === 'postgres' || dialect === 'postgresql'
      ? "table_schema NOT IN ('pg_catalog', 'information_schema')"
      : 'table_schema = DATABASE()'
  const res = await knex.raw(
    `SELECT table_name AS t, column_name AS c, data_type AS d, is_nullable AS n
       FROM information_schema.columns WHERE ${schemaClause}`
  )
  for (const r of rowsOf(res)) {
    const t = String(r.t ?? r.T ?? '')
    out.add(`table ${t}`)
    out.add(
      `column ${t}.${String(r.c ?? r.C)} ${String(r.d ?? r.D)}${String(r.n ?? r.N) === 'YES' ? ' null' : ' not null'}`
    )
  }
  return out
}

export function diffSchema(before: Set<string>, after: Set<string>): MigrationEffects {
  const added: string[] = []
  const removed: string[] = []
  for (const l of after) if (!before.has(l)) added.push(l)
  for (const l of before) if (!after.has(l)) removed.push(l)
  // The effects table is this module's own bookkeeping, not the migration's work.
  const own = (l: string) => l.includes(EFFECTS_TABLE)
  return {
    added: added.filter((l) => !own(l)).sort(),
    removed: removed.filter((l) => !own(l)).sort()
  }
}

export function summarizeEffects(e: MigrationEffects): string {
  if (!e.added.length && !e.removed.length) {
    return 'No schema change — the objects already existed, or the migration only touched data'
  }
  const count = (lines: string[], kind: string) =>
    lines.filter((l) => l.startsWith(`${kind} `)).length
  const parts: string[] = []
  for (const [kind, label] of [
    ['table', 'table'],
    ['column', 'column'],
    ['index', 'index'],
    ['foreign key', 'foreign key'],
    ['procedure', 'procedure']
  ] as const) {
    const a = count(e.added, kind)
    const r = count(e.removed, kind)
    if (a) parts.push(`+${a} ${label}${a === 1 ? '' : label === 'index' ? 'es' : 's'}`)
    if (r) parts.push(`−${r} ${label}${r === 1 ? '' : label === 'index' ? 'es' : 's'}`)
  }
  return parts.join(' · ')
}

async function ensureTable(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(EFFECTS_TABLE)) return
  await knex.schema.createTable(EFFECTS_TABLE, (t) => {
    t.increments('id')
    t.string('name', 255).notNullable().index()
    t.string('direction', 10).notNullable()
    t.dateTime('ran_at').notNullable()
    t.integer('duration_ms')
    t.boolean('schema_changed').notNullable()
    t.string('summary', 500)
    t.text('effects')
  })
}

const CAP = 400

/** Wrap one direction of a migration so its schema effect is recorded. */
export function recordEffects(
  name: string,
  direction: 'up' | 'down',
  run: (knex: Knex) => Promise<unknown>
): (knex: Knex) => Promise<unknown> {
  return async (knex: Knex) => {
    const before = await listSchema(knex).catch(() => null)
    const started = Date.now()
    const result = await run(knex)
    const ms = Date.now() - started
    try {
      const after = before ? await listSchema(knex) : null
      const effects = before && after ? diffSchema(before, after) : null
      await ensureTable(knex)
      await knex(EFFECTS_TABLE).insert({
        name,
        direction,
        ran_at: new Date(),
        duration_ms: ms,
        schema_changed: effects ? effects.added.length + effects.removed.length > 0 : false,
        summary: effects
          ? summarizeEffects(effects)
          : 'Schema could not be listed — effect unknown',
        effects: effects
          ? JSON.stringify({
              added: effects.added.slice(0, CAP),
              removed: effects.removed.slice(0, CAP),
              truncated: effects.added.length > CAP || effects.removed.length > CAP
            })
          : null
      })
    } catch {
      // Bookkeeping only — the migration itself succeeded.
    }
    return result
  }
}
