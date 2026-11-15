/**
 * Announce fix — APPLY on a development database (realtime item 1). Run from api/:
 *
 *   CRON_TICKS=off SKIP_BOOT_MIGRATIONS=1 npx tsx src/scripts/announce-fix-apply.ts \
 *     --database EFP_Development --log <file> [--name <proc>] [--limit N] [--execute]
 *
 * Without --execute it plans and compiles only (nothing written). With --execute, per flagged
 * procedure, through the same one-writer paths the SQL checks page uses:
 *
 *   app-managed → saveAndDeployManaged (a new config version; the previous one stays in
 *                 nivaro_managed_procedure_versions for revert)
 *   import-owned → the definition's stored body is rewritten (snapshot first; the old body is
 *                 also written to <log>.import-bodies.json) and deployed exactly as
 *                 POST /staged-imports/definitions/:id/deploy does
 *   anything else → skipped (propose only)
 *
 * Each step: compile in a rolled-back transaction → write + deploy → read the live definition
 * back and re-check it (no "write-unannounced", nothing new from the other checks). A procedure
 * whose config body differs from what is deployed is skipped (deploying would ship that drift
 * too). The run STOPS at the first unexpected failure; a re-check that fails puts the previous
 * version back first. Refuses any database but the one named by --database.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { db } from '../db/index.js'
import { logActivity } from '../services/activity.js'
import { logManagedProcWrite } from '../services/managed-procedures/activity.js'
import { saveAndDeployManaged } from '../services/managed-procedures/deploy.js'
import { procBodyHash, sameDeployedBody } from '../services/managed-procedures/normalize.js'
import { appManagedProcedures } from '../services/managed-procedures/owners.js'
import { listManagedProcedures } from '../services/managed-procedures/store.js'
import {
  deployProcedure,
  importBodyTargetsOwn,
  liveProcedureDefinitions,
  snapshotImportDefinition
} from '../services/procedure-deploy.js'
import { proposeAnnounce } from '../services/sql-checks/announce-fix.js'
import { compileCheck } from '../services/sql-checks/apply.js'
import { checkObject, type SqlObject } from '../services/sql-checks/checkers.js'
import { applyEdits, recheckVerdict } from '../services/sql-checks/propose.js'
import { loadCatalog } from '../services/sql-checks/run.js'
import { canonicalDefinition } from '../services/sql-checks/tokenizer.js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const arg = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const BY = 'script:announce-fix'
const execute = has('--execute')
const logFile = arg('--log')
const only = arg('--name')?.toLowerCase()
const limit = Number(arg('--limit') ?? 0) || Number.POSITIVE_INFINITY

const log = (line: string) => {
  process.stdout.write(`${line}\n`)
  if (logFile) appendFileSync(logFile, `${line}\n`)
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

class Stop extends Error {}

async function main(): Promise<number> {
  const want = arg('--database')
  if (!want) throw new Error('--database <name> is required (the database this may change)')
  const [{ name: dbName }] = (await db.raw('SELECT DB_NAME() AS name')) as Array<{ name: string }>
  if (dbName !== want) throw new Error(`Connected to ${dbName}, not ${want}: refusing`)

  const [catalog, owners, managed, imports, live] = await Promise.all([
    loadCatalog(),
    appManagedProcedures(),
    listManagedProcedures(),
    db('nivaro_import_definitions')
      .whereNotNull('procedure_body')
      .select('id', 'key', 'procedure', 'procedure_body') as Promise<
      Array<{ id: number; key: string; procedure: string | null; procedure_body: string }>
    >,
    liveProcedureDefinitions()
  ])
  const managedRow = new Map(managed.map((m) => [m.name.toLowerCase(), m]))
  const importRow = new Map(imports.map((i) => [i.key, i]))
  const unannounced = (o: SqlObject) =>
    checkObject(o, catalog).filter((f) => f.check_key === 'write-unannounced')
  const oldBodies: Array<{ key: string; id: number; procedure: string | null; body: string }> = []
  const counts = { applied: 0, failed: 0, skipped: 0, planned: 0 }

  log(
    `# announce fix ${execute ? 'APPLY' : 'PLAN'} on ${dbName} — ${new Date().toISOString()} (by ${BY})`
  )
  const names = [...live.keys()].sort()
  let done = 0
  for (const lower of names) {
    if (only && lower !== only) continue
    if (done >= limit) break
    const liveSql = live.get(lower) ?? ''
    const owner = owners.get(lower) ?? null
    const mod: SqlObject = {
      schema: 'dbo',
      name: lower,
      type: 'procedure',
      definition: liveSql
    }
    // the source config writes from
    let path: 'managed' | 'import' | 'propose' = 'propose'
    let body = liveSql
    let label = lower
    if (owner?.kind === 'managed' && !owner.dropped && managedRow.get(lower)?.body) {
      path = 'managed'
      body = managedRow.get(lower)?.body ?? ''
      label = owner.name
    } else if (owner?.kind === 'import' && importRow.get(owner.key)?.procedure_body) {
      path = 'import'
      body = importRow.get(owner.key)?.procedure_body ?? ''
      label = owner.name
    }
    const src: SqlObject = { ...mod, name: label, definition: body }
    if (!unannounced(src).length) continue
    done++
    const tag = `${label} [${path === 'import' ? `import:${(owner as { key: string }).key}` : path}]`
    if (path === 'propose') {
      counts.skipped++
      log(`SKIP  ${tag} — not owned by app config (propose only)`)
      continue
    }
    if (owner?.kind === 'import' && owner.conflictingKeys) {
      counts.skipped++
      log(
        `SKIP  ${tag} — named by several import definitions (${owner.conflictingKeys.join(', ')})`
      )
      continue
    }
    const drifted =
      path === 'managed'
        ? !sameDeployedBody(body, liveSql)
        : canonicalDefinition(body) !== canonicalDefinition(liveSql)
    if (drifted) {
      counts.skipped++
      log(`SKIP  ${tag} — the stored body differs from the deployed procedure (would ship drift)`)
      continue
    }
    const p = proposeAnnounce(body, catalog, { source: `procedure:${label}` })
    if (!p.ok) {
      counts.skipped++
      log(`SKIP  ${tag} — ${p.manual_reason}`)
      continue
    }
    const next = applyEdits(body, p.edits)
    const plan = p.plan
      .map(
        (x) =>
          `${x.collection}:${x.ids ? 'ids' : ''}${x.ids && x.whole ? '+' : ''}${x.whole ? 'many' : ''}`
      )
      .join(' ')
    if (path === 'import' && !importBodyTargetsOwn(next, label)) {
      counts.skipped++
      log(`SKIP  ${tag} — body does not CREATE OR ALTER its own procedure`)
      continue
    }
    const compile = await compileCheck(next)
    if (!compile.ok) {
      counts.failed++
      log(`FAIL  ${tag} — does not compile: ${compile.error}`)
      throw new Stop('compile failed')
    }
    if (!execute) {
      counts.planned++
      log(`PLAN  ${tag} — compiles; ${plan}`)
      continue
    }

    const before = checkObject(mod, catalog)
    let putBack: () => Promise<void>
    try {
      if (path === 'managed') {
        const row = managedRow.get(lower)
        const saved = await saveAndDeployManaged({
          name: label,
          body: next,
          note: 'Announce writes (realtime): SQL checks fix applied by script',
          baseHash: procBodyHash(body),
          userId: null,
          by: BY
        })
        await logManagedProcWrite({
          action: 'procedure-update',
          name: label,
          version: saved.version,
          note: 'Announce writes (realtime fix, script)',
          userId: null
        })
        log(`      ${label}: config v${row?.version ?? '?'} → v${saved.version}`)
        putBack = async () => {
          await saveAndDeployManaged({
            name: label,
            body,
            note: 'Put back after a failed announce re-check',
            baseHash: procBodyHash(next),
            userId: null,
            by: BY
          })
        }
      } else {
        const def = importRow.get((owner as { key: string }).key)
        if (!def) throw new Error('import definition vanished')
        oldBodies.push({ key: def.key, id: def.id, procedure: def.procedure, body })
        if (logFile)
          writeFileSync(`${logFile}.import-bodies.json`, JSON.stringify(oldBodies, null, 2))
        await snapshotImportDefinition(def.key, 'before announce fix (script)', null)
        const n = await db('nivaro_import_definitions')
          .where('id', def.id)
          .where('procedure_body', body)
          .update({ procedure_body: next })
        if (!n) throw new Error('the stored body changed while this ran')
        await deployProcedure(next, { schema: 'dbo', name: label })
        await db('nivaro_import_definitions')
          .where('id', def.id)
          .update({ procedure_hash: sha(next), procedure_deployed_at: new Date() })
        await logActivity({
          action: 'import-procedure-deploy',
          user: null,
          collection: 'nivaro_import_definitions',
          item: def.key,
          comment: `CREATE OR ALTER ${label} (announce writes, realtime fix, script)`
        })
        putBack = async () => {
          await db('nivaro_import_definitions')
            .where('id', def.id)
            .update({ procedure_body: body, procedure_hash: sha(body) })
          await deployProcedure(body, { schema: 'dbo', name: label })
        }
      }
    } catch (e) {
      counts.failed++
      log(`FAIL  ${tag} — write/deploy: ${e instanceof Error ? e.message : String(e)}`)
      throw new Stop('deploy failed')
    }

    // re-check what SQL Server now holds
    const after = (await liveProcedureDefinitions([label])).get(lower) ?? ''
    const afterFindings = checkObject({ ...mod, definition: after }, catalog)
    const verdict = after
      ? recheckVerdict(before, afterFindings, 'write-unannounced')
      : { ok: false, reason: 'the procedure could not be read back' }
    const still = afterFindings.filter((f) => f.check_key === 'write-unannounced').length
    if (!verdict.ok || still) {
      counts.failed++
      let pb = 'put back'
      try {
        await putBack()
      } catch (e) {
        pb = `PUT BACK FAILED: ${e instanceof Error ? e.message : String(e)}`
      }
      log(`FAIL  ${tag} — re-check: ${verdict.reason ?? `${still} still flagged`}; ${pb}`)
      throw new Stop('re-check failed')
    }
    counts.applied++
    log(`OK    ${tag} — ${plan}; re-check clean`)
  }
  log(
    `# done: applied ${counts.applied}, failed ${counts.failed}, skipped ${counts.skipped}${execute ? '' : `, planned ${counts.planned}`}`
  )
  return 0
}

let code = 0
try {
  code = await main()
} catch (err) {
  log(`# STOPPED: ${err instanceof Error ? err.message : String(err)}`)
  code = 1
} finally {
  await db.destroy()
}
process.exit(code)
