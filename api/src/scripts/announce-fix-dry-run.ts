/**
 * Announce fix — dry run (realtime). Run through `node scripts/announce-fix-dry-run.mjs`.
 *
 *   node scripts/announce-fix-dry-run.mjs [--diff] [--name <proc>] [--json] [--compile]
 *
 * READ-ONLY. Reads every stored procedure (sys.sql_modules), the app-managed and import-owned
 * bodies config keeps, and the catalog (registered collections, primary keys); runs the
 * "Writes a registered collection without announcing" check and prints, per procedure, what the
 * announce fix would change and how it would be applied:
 *
 *   managed   → saved as a new version in app config and deployed from there (SQL checks page)
 *   import    → the import definition's stored body (deployed from the import definition)
 *   propose   → not owned by config: shown on the SQL checks page, never applied from there
 *
 * Nothing is written anywhere — no deploy, no config row, no finding. --diff prints the unified
 * diff of each change; --name limits to one procedure; --json prints the whole list as JSON.
 * --compile compiles each proposed text under SET NOEXEC ON (renamed to a scratch name; SQL
 * Server parses and compiles it but creates nothing) and reports the ones that do not compile.
 */
import { db } from '../db/index.js'
import { appManagedProcedures, type ProcOwner } from '../services/managed-procedures/owners.js'
import { listManagedProcedures } from '../services/managed-procedures/store.js'
import { withLongConnection } from '../services/run-long.js'
import { proposeAnnounce } from '../services/sql-checks/announce-fix.js'
import { checkObject } from '../services/sql-checks/checkers.js'
import {
  applyEdits,
  diffForEdits,
  unifiedDiff,
  withExplicitName
} from '../services/sql-checks/propose.js'
import { loadCatalog } from '../services/sql-checks/run.js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const arg = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

interface Row {
  procedure: string
  path: 'managed' | 'import' | 'propose'
  owner?: string
  collections: string[]
  proposable: boolean
  manual_reason?: string
  plan: Array<{ collection: string; ids: boolean; whole: boolean }>
  notes: string[]
  diff?: string
  /** --compile: null = compiles; else the error. */
  compile_error?: string | null
}

/** Compile `sql` under NOEXEC: parsed and compiled, nothing created or run. */
async function compileNoExec(sql: string): Promise<string | null> {
  const text = withExplicitName(sql, 'dbo', 'nvr_announce_dryrun_noexec')
  if (!text) return 'no procedure header'
  return withLongConnection(
    async (c) => {
      await c.run('SET NOEXEC ON')
      try {
        await c.run(text, 30_000)
        return null
      } catch (e) {
        return e instanceof Error ? e.message.slice(0, 300) : String(e)
      } finally {
        await c.run('SET NOEXEC OFF').catch(() => c.discard())
      }
    },
    { timeoutMs: 30_000 }
  )
}

async function main(): Promise<number> {
  const only = arg('--name')?.toLowerCase()
  const [catalog, owners, managed, modules, imports] = await Promise.all([
    loadCatalog(),
    appManagedProcedures(),
    listManagedProcedures(),
    db.raw(`SELECT s.name AS sch, o.name AS name, m.definition AS def
              FROM sys.sql_modules m
              JOIN sys.objects o ON o.object_id = m.object_id
              JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE o.type IN ('P', 'PC') AND o.is_ms_shipped = 0 AND m.definition IS NOT NULL`) as Promise<
      Array<{ sch: string; name: string; def: string }>
    >,
    db.schema
      .hasColumn('nivaro_import_definitions', 'procedure_body')
      .then((ok) =>
        ok
          ? (db('nivaro_import_definitions')
              .whereNotNull('procedure_body')
              .select('key', 'procedure_body') as Promise<
              Array<{ key: string; procedure_body: string }>
            >)
          : []
      )
  ])
  const managedBody = new Map(managed.map((m) => [m.name.toLowerCase(), m.body ?? '']))
  const importBody = new Map(imports.map((i) => [i.key, i.procedure_body]))
  const rows: Row[] = []
  let writers = 0
  for (const m of modules) {
    const label = `${m.sch}.${m.name}`
    if (only && m.name.toLowerCase() !== only && label.toLowerCase() !== only) continue
    const owner: ProcOwner | null =
      m.sch.toLowerCase() === 'dbo' ? (owners.get(m.name.toLowerCase()) ?? null) : null
    let sql = m.def
    let path: Row['path'] = 'propose'
    if (owner?.kind === 'managed' && !owner.dropped && managedBody.get(owner.name.toLowerCase())) {
      sql = managedBody.get(owner.name.toLowerCase()) ?? sql
      path = 'managed'
    } else if (owner?.kind === 'import' && importBody.get(owner.key)) {
      sql = importBody.get(owner.key) ?? sql
      path = 'import'
    }
    const findings = checkObject(
      { schema: m.sch, name: m.name, type: 'procedure', definition: sql },
      catalog
    ).filter((f) => f.check_key === 'write-unannounced')
    if (/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)) writers++
    if (!findings.length) continue
    const p = proposeAnnounce(sql, catalog, { source: `procedure:${label}` })
    rows.push({
      procedure: label,
      path,
      owner: owner?.kind === 'import' ? `import:${owner.key}` : owner?.kind,
      collections: findings.map((f) => String((f.detail as { collection?: string }).collection)),
      proposable: p.ok,
      manual_reason: p.manual_reason,
      plan: p.plan.map((x) => ({ collection: x.collection, ids: x.ids, whole: x.whole })),
      notes: p.notes,
      diff: has('--diff') && p.ok ? unifiedDiff(diffForEdits(sql, p.edits), label) : undefined,
      compile_error:
        has('--compile') && p.ok ? await compileNoExec(applyEdits(sql, p.edits)) : undefined
    })
  }
  if (has('--json')) {
    console.log(JSON.stringify({ procedures: modules.length, writers, rows }, null, 2))
    return 0
  }
  const count = (k: Row['path']) => rows.filter((r) => r.path === k && r.proposable).length
  console.log(
    `Announce fix — dry run (nothing is written)\n` +
      `${modules.length} procedures, ${rows.length} write registered collections without announcing.\n` +
      `Would apply: ${count('managed')} app-managed (new config version + deploy), ` +
      `${count('import')} import-owned (stored body). Propose only: ${count('propose')}. ` +
      `Needs a person: ${rows.filter((r) => !r.proposable).length}.` +
      (has('--compile')
        ? ` Compile (NOEXEC): ${rows.filter((r) => r.compile_error === null).length} ok, ${rows.filter((r) => r.compile_error).length} failed.`
        : '') +
      '\n'
  )
  for (const r of rows) {
    const how = !r.proposable
      ? `MANUAL — ${r.manual_reason}`
      : r.path === 'managed'
        ? 'would save + deploy from app config'
        : r.path === 'import'
          ? `would rewrite the stored body of ${r.owner}`
          : 'propose only (not owned by config)'
    console.log(`• ${r.procedure} — ${how}`)
    if (r.compile_error) console.log(`    DOES NOT COMPILE: ${r.compile_error}`)
    for (const p of r.plan)
      console.log(
        `    ${p.collection}: ${p.ids ? 'ids' : ''}${p.ids && p.whole ? ' + ' : ''}${p.whole ? 'many-changed every run' : ''}`
      )
    if (r.diff) console.log(r.diff.replace(/^/gm, '    '))
  }
  return 0
}

let code = 0
try {
  code = await main()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  code = 1
} finally {
  await db.destroy()
}
process.exit(code)
