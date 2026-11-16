/**
 * env-refresh — copy one environment's database over another, keeping what belongs to the target.
 * Run by the host runbook agent through an extension's wrapper (EFP: efp-ops/scripts/env-refresh.sh,
 * which also owns the maintenance page and the locks); never by hand on a laptop.
 *
 *   npx tsx src/scripts/env-refresh.ts --config extensions/<ext>/<module>.ts --direction production-to-staging [--dry] [--from <phase>]
 *   npx tsx src/scripts/env-refresh.ts --config … --rollback --target staging [--dry]
 *
 * Phases (each says `@@event` so the Runbooks console shows progress and estimates):
 *   preflight  directions + refusals, both online, the target's app knows every source migration,
 *              disk space — and the plan in plain words
 *   save       the keep set (registry.ts) → <ENV_REFRESH_DIR>/<target>-<stamp>.keep.json + -latest
 *   backup     COPY_ONLY backup of the TARGET (the "Roll back" file), then of the SOURCE
 *   restore    target OFFLINE → RESTORE WITH REPLACE (source's logical names, target's files) →
 *              MULTI_USER, SIMPLE recovery, orphaned users re-mapped to their logins
 *   migrate    the target's own newer migrations (exactly the ones its app had run before)
 *   keep       the keep set put back (natural keys)
 *   safety     ALWAYS once the restore happened, even after a failure (safety.ts)
 *   verify     the safety switches landed, business-table row counts vs the source, readiness
 *
 * A DRY run (the default the console demands first) prints the plan and writes nothing anywhere.
 * Exit codes: 0 done · 75 refused before anything was written · 1 failed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EnvKeepEntryInput, EnvRefreshDecl } from '@nivaro/extension-kit'
import knex, { type Knex } from 'knex'
import {
  EnvRefreshRefused,
  type ResolvedDirection,
  resolveDirection,
  validateRefreshDecl
} from '../services/env-refresh/directions.js'
import { buildPlanFromDatabases, DEFAULT_BACKUP_DIR } from '../services/env-refresh/inspect.js'
import {
  applyKeepSet,
  captureKeepSet,
  qcat,
  qtable,
  type SavedKeepSet,
  type SqlRunner,
  sqlError
} from '../services/env-refresh/keep-set.js'
import { planLines, REFRESH_PHASES, ROLLBACK_PHASES } from '../services/env-refresh/plan.js'
import {
  allKeeps,
  type EnvKeepEntry,
  keepsForTarget,
  validateKeepEntry
} from '../services/env-refresh/registry.js'
import { runSafetyPass } from '../services/env-refresh/safety.js'

export const EXIT_REFUSED = 75

// ─── arguments ──────────────────────────────────────────────────────────────

export interface Args {
  config: string
  direction: string | null
  rollbackTarget: string | null
  dry: boolean
  from: string | null
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  const opt = (n: string) => {
    const i = argv.indexOf(`--${n}`)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }
  const rollback = argv.includes('--rollback')
  const config = opt('config') ?? env.ENV_REFRESH_CONFIG ?? ''
  if (
    !/^extensions\/[A-Za-z0-9_-]+\/[A-Za-z0-9_/-]+\.(ts|js)$/.test(config) ||
    config.includes('..')
  )
    throw new EnvRefreshRefused('--config must name a module inside an extension folder')
  return {
    config,
    direction: rollback ? null : (opt('direction') ?? env.TARGET ?? null),
    rollbackTarget: rollback ? (opt('target') ?? env.TARGET ?? null) : null,
    dry: argv.includes('--dry') || argv.includes('--dry-run'),
    from: opt('from')
  }
}

export interface RefreshConfigModule {
  envRefresh: EnvRefreshDecl
  envKeeps?: EnvKeepEntryInput[]
}

/** The extension's refresh declaration + keep entries, validated like registration does. */
export function loadedConfig(
  mod: Partial<RefreshConfigModule>,
  extension: string
): { decl: EnvRefreshDecl; entries: EnvKeepEntry[] } {
  if (!mod.envRefresh) throw new EnvRefreshRefused('the config module exports no envRefresh')
  validateRefreshDecl(mod.envRefresh)
  const extra = (mod.envKeeps ?? []).map((e) => {
    validateKeepEntry(e)
    return { ...e, source: extension }
  })
  return { decl: mod.envRefresh, entries: allKeeps(extra) }
}

// ─── output ─────────────────────────────────────────────────────────────────

const say = (s: string) => {
  process.stdout.write(`${s}\n`)
}
const now = () => new Date().toISOString()
function event(step: string, status: 'start' | 'ok' | 'fail' | 'skip', secs?: number) {
  say(`@@event ${JSON.stringify({ step, status, at: now(), ...(secs != null ? { secs } : {}) })}`)
}

// ─── connection ─────────────────────────────────────────────────────────────

async function openServer(): Promise<{ knex: Knex; sql: SqlRunner }> {
  const { config } = await import('../config.js')
  const k = knex({
    client: 'mssql',
    connection: {
      server: config.DB_HOST,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: 'master',
      options: {
        encrypt: config.DB_ENCRYPT,
        trustServerCertificate: config.DB_TRUST_SERVER_CERT,
        requestTimeout: 0
      }
    } as Knex.Config['connection'],
    // ONE connection: IDENTITY_INSERT and USE are per session.
    pool: { min: 1, max: 1 }
  })
  const sql: SqlRunner = {
    async raw(q, b) {
      const r = await k.raw(q, (b ?? []) as any)
      return (Array.isArray(r) ? r : []) as Array<Record<string, unknown>>
    }
  }
  return { knex: k, sql }
}

// ─── files on the host ──────────────────────────────────────────────────────

export function keepDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENV_REFRESH_DIR || join(homedir(), '.nivaro-env-refresh')
}
const statePath = (db: string) => join(keepDir(), `${db}-state.json`)

interface RunState {
  stamp: string
  direction: string
  keep_file: string
  pre_backup_file: string
  restored_at?: string
}

function stampNow(): string {
  return now().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
}

export function backupFiles(backupDir: string, source: string, target: string) {
  const dir = backupDir.replace(/[\\/]+$/, '')
  return {
    pre: `${dir}\\${target}_pre_refresh.bak`,
    copy: `${dir}\\${source}_env_refresh_copyonly.bak`
  }
}

// ─── SQL helpers (server level) ─────────────────────────────────────────────

async function takeOffline(sql: SqlRunner, db: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.raw(
        `SET DEADLOCK_PRIORITY HIGH; ALTER DATABASE ${qcat(db)} SET OFFLINE WITH ROLLBACK IMMEDIATE;`
      )
      return
    } catch (e: any) {
      const retry = (e?.errors ?? []).some((x: any) => [1205, 5061, 5064].includes(x.number))
      if (!retry || attempt >= 30) throw e
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

/** Right after a RESTORE the target can refuse logins for a while (recovery, user re-mapping):
 *  2026-11-16 the dev refresh failed at "keep" on "Login failed for user ..." and ran about three
 *  minutes on the source's settings. Wait until the target answers a read, up to ~3 minutes. */
export function isTransientAfterRestore(e: unknown): boolean {
  const nums = ((e as any)?.errors ?? []).map((x: any) => x?.number)
  const code = String((e as any)?.code ?? '')
  const text = String((e as any)?.message ?? '')
  return (
    nums.some((n: number) => [4060, 18456, 922, 942, 952, 976].includes(n)) ||
    ['ELOGIN', 'ESOCKET', 'ECONNRESET', 'ECONNCLOSED', 'ETIMEOUT'].includes(code) ||
    /login failed|cannot open database|is being recovered|in transition|connection (is )?closed/i.test(
      text
    )
  )
}

async function waitForTarget(sql: SqlRunner, db: string, maxMs = 180_000): Promise<void> {
  const start = Date.now()
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.raw(`SELECT TOP 1 1 AS ok FROM ${qtable(db, 'nivaro_migrations')}`)
      if (attempt > 1)
        say(`  ${db} answers again after ${Math.round((Date.now() - start) / 1000)} s`)
      return
    } catch (e) {
      if (!isTransientAfterRestore(e) || Date.now() - start > maxMs) throw e
      if (attempt === 1) say(`  ${db} is not taking logins yet (${sqlError(e)}) — waiting`)
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * attempt)))
    }
  }
}

/** MOVE clauses: the backup's logical files onto the target's existing files, by type and order. */
export function moveClauses(
  backupFiles: Array<{ LogicalName: string; Type: string }>,
  targetFiles: Array<{ physical_name: string; type_desc: string }>
): string[] {
  const data = backupFiles.filter((f) => f.Type === 'D')
  const log = backupFiles.filter((f) => f.Type === 'L')
  const tData = targetFiles.filter((f) => f.type_desc === 'ROWS')
  const tLog = targetFiles.filter((f) => f.type_desc === 'LOG')
  if (data.length > tData.length || log.length > tLog.length)
    throw new Error(
      `file layout: the backup has ${data.length} data / ${log.length} log files, the target ${tData.length} / ${tLog.length} — add files to the target first`
    )
  const esc = (s: string) => s.replace(/'/g, "''")
  return [
    ...data.map((f, i) => `MOVE N'${esc(f.LogicalName)}' TO N'${esc(tData[i].physical_name)}'`),
    ...log.map((f, i) => `MOVE N'${esc(f.LogicalName)}' TO N'${esc(tLog[i].physical_name)}'`)
  ]
}

async function restoreOver(sql: SqlRunner, file: string, target: string) {
  const esc = file.replace(/'/g, "''")
  const list = (await sql.raw(`RESTORE FILELISTONLY FROM DISK = N'${esc}'`)) as any[]
  const files = (await sql.raw(
    `SELECT physical_name, type_desc FROM ${qcat(target)}.sys.database_files ORDER BY type_desc DESC, file_id`
  )) as any[]
  const moves = moveClauses(list, files)
  for (const m of moves) say(`  ${m}`)
  await takeOffline(sql, target)
  try {
    await sql.raw(
      `RESTORE DATABASE ${qcat(target)} FROM DISK = N'${esc}' WITH REPLACE, ${moves.join(', ')}, STATS = 10`
    )
  } catch (e) {
    say(`  restore failed — bringing ${target} back ONLINE as it was`)
    await sql.raw(`ALTER DATABASE ${qcat(target)} SET ONLINE`).catch((x) => say(`  ${sqlError(x)}`))
    throw e
  }
  await sql.raw(`ALTER DATABASE ${qcat(target)} SET MULTI_USER`)
  await sql.raw(`ALTER DATABASE ${qcat(target)} SET RECOVERY SIMPLE`)
  // Users whose SID has no login on this server (created on another server) get their login back.
  const orphans = await sql.raw(
    `SELECT dp.name AS name FROM ${qcat(target)}.sys.database_principals dp
      LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid
     WHERE dp.type = 'S' AND dp.principal_id > 4 AND sp.sid IS NULL
       AND EXISTS (SELECT 1 FROM sys.server_principals s2 WHERE s2.name = dp.name AND s2.type = 'S')`
  )
  for (const o of orphans) {
    const n = String(o.name).replace(/]/g, ']]')
    try {
      await sql.raw(`USE ${qcat(target)}; ALTER USER [${n}] WITH LOGIN = [${n}]; USE [master];`)
      say(`  re-mapped user ${o.name} to its login`)
    } catch (e) {
      say(`  ⚠ could not re-map user ${o.name}: ${sqlError(e)}`)
    }
  }
}

// ─── phases ─────────────────────────────────────────────────────────────────

class StepFailed extends Error {}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (e) {
    say(`### REFUSED: ${(e as Error).message}`)
    return EXIT_REFUSED
  }
  const apiDir = resolve(new URL('../..', import.meta.url).pathname)
  const extension = args.config.split('/')[1]
  let decl: EnvRefreshDecl
  let entries: EnvKeepEntry[]
  try {
    const mod = (await import(pathToFileURL(join(apiDir, args.config)).href)) as RefreshConfigModule
    ;({ decl, entries } = loadedConfig(mod, extension))
  } catch (e) {
    say(`### REFUSED: ${(e as Error).message}`)
    return EXIT_REFUSED
  }
  if (args.rollbackTarget != null) return rollback(args, decl)

  let dir: ResolvedDirection
  try {
    dir = resolveDirection(decl, args.direction)
  } catch (e) {
    say(`### REFUSED: ${(e as Error).message}`)
    return EXIT_REFUSED
  }
  const phases = REFRESH_PHASES.map((p) => p.key)
  const fromIdx = args.from ? phases.indexOf(args.from) : 0
  if (fromIdx < 0) {
    say(`### REFUSED: --from ${args.from} is not a phase (${phases.join(', ')})`)
    return EXIT_REFUSED
  }
  say(`@@steps ${JSON.stringify(phases)}`)
  const S = dir.source.database
  const T = dir.target.database
  const backupDir = decl.backup_dir ?? DEFAULT_BACKUP_DIR
  const files = backupFiles(backupDir, S, T)
  const targetEntries = keepsForTarget(entries, dir.target)
  const { knex: k, sql } = await openServer()
  let restored = false
  let failedAt: string | null = null
  let failure = ''
  let state: RunState | null = null
  const t0All = Date.now()
  const phase = async (key: string, fn: () => Promise<void>) => {
    if (phases.indexOf(key) < fromIdx) {
      event(key, 'skip')
      return
    }
    if (failedAt && key !== 'safety') {
      event(key, 'skip')
      return
    }
    const t0 = Date.now()
    event(key, 'start')
    say(`─── ${REFRESH_PHASES.find((p) => p.key === key)?.label} ───`)
    try {
      await fn()
      event(key, 'ok', Math.round((Date.now() - t0) / 1000))
    } catch (e) {
      event(key, 'fail', Math.round((Date.now() - t0) / 1000))
      const msg = e instanceof StepFailed ? e.message : sqlError(e)
      say(`✗ ${msg}`)
      if (!failedAt) {
        failedAt = key
        failure = msg
      }
    }
  }

  try {
    if (fromIdx > 0) {
      // Resuming: the saved state of the run that started it.
      if (!existsSync(statePath(T))) {
        say(`### REFUSED: no saved state for ${T} — a resume needs the run that started it`)
        return EXIT_REFUSED
      }
      state = JSON.parse(readFileSync(statePath(T), 'utf8')) as RunState
      if (state.direction !== dir.key) {
        say(`### REFUSED: the saved state is for ${state.direction}, not ${dir.key}`)
        return EXIT_REFUSED
      }
      restored = !!state.restored_at
    }

    // 1. preflight (always, even on resume: refusals never depend on where we start)
    let refusedEarly = false
    await phase('preflight', async () => {
      const { plan } = await buildPlanFromDatabases(sql, {
        decl,
        dir,
        entries,
        busy: null,
        filesFallback: dir.source.uploads_dir ?? null,
        sampleOver: 5000
      })
      for (const l of planLines(plan)) say(l)
      if (!plan.ready) {
        refusedEarly = true
        throw new StepFailed('preflight failed — nothing was changed')
      }
    })
    if (failedAt === 'preflight') {
      say(`### REFUSED: ${failure}`)
      return refusedEarly ? EXIT_REFUSED : 1
    }
    if (args.dry) {
      for (const p of phases.slice(1)) event(p, 'skip')
      say(`### DONE — dry run: ${dir.source.label} → ${dir.target.label} — nothing was written`)
      return 0
    }

    // 2. save the keep set
    await phase('save', async () => {
      mkdirSync(keepDir(), { recursive: true, mode: 0o700 })
      const saved = await captureKeepSet(sql, {
        entries: targetEntries,
        direction: dir.key,
        sourceDb: S,
        targetDb: T
      })
      const stamp = stampNow()
      const file = join(keepDir(), `${T}-${stamp}.keep.json`)
      writeFileSync(file, JSON.stringify(saved), { mode: 0o600 })
      writeFileSync(join(keepDir(), `${T}-latest.keep.json`), JSON.stringify(saved), {
        mode: 0o600
      })
      for (const e of saved.entries)
        say(`  ${e.missing ? '⚠' : '✓'} ${e.label}: ${e.missing ?? `${e.rows.length} row(s)`}`)
      runDelegates(targetEntries, 'save', T, apiDir)
      state = { stamp, direction: dir.key, keep_file: file, pre_backup_file: files.pre }
      writeFileSync(statePath(T), JSON.stringify(state), { mode: 0o600 })
      say(`  saved to ${file}`)
    })
    if (failedAt === 'save') {
      say(`### REFUSED: the keep set could not be saved — nothing was changed (${failure})`)
      return EXIT_REFUSED
    }

    // 3. backups: the target first (Roll back), then the source copy
    await phase('backup', async () => {
      try {
        await sql.raw(`EXEC master.sys.xp_create_subdir N'${backupDir.replace(/'/g, "''")}'`)
      } catch (e) {
        say(`  could not create ${backupDir} (${sqlError(e)}) — assuming it exists`)
      }
      say(`  backing up ${T} (COPY_ONLY) → ${files.pre}`)
      await sql.raw(
        `BACKUP DATABASE ${qcat(T)} TO DISK = N'${files.pre}' WITH COPY_ONLY, COMPRESSION, CHECKSUM, INIT, STATS = 10`
      )
      say(`  backing up ${S} (COPY_ONLY) → ${files.copy}`)
      await sql.raw(
        `BACKUP DATABASE ${qcat(S)} TO DISK = N'${files.copy}' WITH COPY_ONLY, COMPRESSION, CHECKSUM, INIT, STATS = 10`
      )
    })

    // 4. restore
    await phase('restore', async () => {
      const hdr = (await sql.raw(`RESTORE HEADERONLY FROM DISK = N'${files.copy}'`))[0] as any
      if (!hdr || String(hdr.DatabaseName).toLowerCase() !== S.toLowerCase())
        throw new StepFailed(`${files.copy} is not a backup of ${S}`)
      await restoreOver(sql, files.copy, T)
      await waitForTarget(sql, T)
      restored = true
      if (state) {
        state.restored_at = now()
        writeFileSync(statePath(T), JSON.stringify(state), { mode: 0o600 })
      }
    })

    const saved = (): SavedKeepSet => {
      const f = state?.keep_file
      if (!f || !existsSync(f)) throw new StepFailed('the saved keep set is missing')
      return JSON.parse(readFileSync(f, 'utf8')) as SavedKeepSet
    }

    // 5. the target's newer migrations
    await phase('migrate', async () => {
      const ks = saved()
      const now = (await sql.raw(`SELECT name FROM ${qtable(T, 'nivaro_migrations')}`)).map((r) =>
        String(r.name)
      )
      const expected = ks.target_ledger.filter((m) => !now.includes(m))
      if (!expected.length) {
        say('  the target is on the source’s migrations — nothing to run')
        return
      }
      say(`  the target's app had ${expected.length} newer migration(s): ${expected.join(', ')}`)
      const env = { ...process.env, DB_DATABASE: T, SKIP_BOOT_MIGRATIONS: '', CRON_TICKS: 'off' }
      const list = spawnSync('npx', ['tsx', 'src/db/migrate.ts', 'list'], {
        cwd: apiDir,
        env,
        encoding: 'utf8'
      })
      const pending = [...(list.stdout ?? '').matchAll(/pending: (\S+)/g)].map((m) => m[1])
      const same = pending.length === expected.length && expected.every((m) => pending.includes(m))
      if (!same)
        throw new StepFailed(
          `this checkout would run ${pending.length} migration(s), the target's app ran ${expected.length} — restart the target's app (its boot runs its own), then resume from "keep"`
        )
      const run = spawnSync('npx', ['tsx', 'src/db/migrate.ts'], {
        cwd: apiDir,
        env,
        encoding: 'utf8'
      })
      say((run.stdout ?? '').trim())
      if (run.status !== 0)
        throw new StepFailed(`migrations failed: ${(run.stderr ?? '').trim().slice(-400)}`)
    })

    // 6. put back what the target keeps
    await phase('keep', async () => {
      await waitForTarget(sql, T)
      const results = await applyKeepSet(sql, saved(), T)
      let bad = 0
      for (const r of results) {
        const extra = [
          r.inserted ? `${r.inserted} inserted` : '',
          r.skipped ? `${r.skipped} not put back` : '',
          r.dropped_columns.length ? `columns gone: ${r.dropped_columns.join(', ')}` : '',
          r.new_from_source.length
            ? `new from the source: ${r.new_from_source.slice(0, 8).join(', ')}`
            : ''
        ]
          .filter(Boolean)
          .join(' · ')
        say(
          `  ${r.errors.length ? '✗' : '✓'} ${r.id}: ${r.written} written${extra ? ` · ${extra}` : ''}`
        )
        for (const e of r.errors.slice(0, 3)) say(`      ${e}`)
        for (const n of r.notes.slice(0, 3)) say(`      note: ${n}`)
        if (r.errors.length) bad++
      }
      runDelegates(targetEntries, 'restore', T, apiDir)
      if (bad) throw new StepFailed(`${bad} kept item(s) could not be put back — see above`)
    })

    // 7. safety pass — ALWAYS once the target holds the source's copy
    if (restored) {
      const before = failedAt
      failedAt = null
      await phase('safety', async () => {
        let ks: SavedKeepSet | null = null
        try {
          ks = saved()
        } catch {
          say('  ⚠ no saved keep set — everything the source brought is treated as new')
        }
        const actions = await runSafetyPass(sql, {
          readDb: S,
          writeDb: T,
          instanceKey: dir.target.instance_key ?? null,
          saved: ks,
          dry: false
        })
        for (const a of actions)
          say(
            `  ${a.error ? '✗' : '✓'} ${a.label}: ${a.error ?? a.count}${a.names?.length ? ` (${a.names.slice(0, 8).join(', ')})` : ''}`
          )
        if (actions.some((a) => a.error))
          throw new StepFailed('the safety pass could not finish — see above')
      })
      if (before) failedAt = before
    } else {
      event('safety', 'skip')
    }

    // 8. verify
    await phase('verify', async () => {
      const problems: string[] = []
      const mailTest = (
        await sql
          .raw(`SELECT TOP 1 [mail_test_mode] AS m FROM ${qtable(T, 'nivaro_settings')}`)
          .catch(() => [])
      )[0]?.m
      if (!(mailTest === true || mailTest === 1)) problems.push('mail test mode is not on')
      const counts = async (db: string) =>
        new Map(
          (
            await sql.raw(
              `SELECT t.name AS t, SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count ELSE 0 END) AS n
                 FROM ${qcat(db)}.sys.tables t JOIN ${qcat(db)}.sys.dm_db_partition_stats p ON p.object_id = t.object_id
                WHERE t.name NOT LIKE 'nivaro[_]%' GROUP BY t.name`
            )
          ).map((r) => [String(r.t), Number(r.n)])
        )
      const [src, tgt] = [await counts(S), await counts(T)]
      const off = [...src].filter(([t, n]) => tgt.has(t) && tgt.get(t) !== n)
      say(
        `  business tables: ${src.size} in ${S}, ${off.length} with a different row count in ${T}`
      )
      for (const [t, n] of off.slice(0, 10))
        say(
          `    ${t}: ${n} → ${tgt.get(t)} (the source kept writing since its backup, or a migration changed it)`
        )
      const url = dir.target.app_url
      if (url) {
        const token = process.env.ENV_REFRESH_READINESS_TOKEN
        try {
          const res = await fetch(`${url.replace(/\/+$/, '')}/api/readiness?fresh=1`, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(120_000)
          })
          const body: any = await res.json().catch(() => null)
          const score = body?.data?.score ?? body?.score ?? null
          say(`  readiness: HTTP ${res.status}${score != null ? `, score ${score}` : ''}`)
          if (res.status === 401 || res.status === 403)
            say('    (set ENV_REFRESH_READINESS_TOKEN on the host to read it)')
          else if (!res.ok) problems.push(`readiness answered ${res.status}`)
        } catch (e) {
          say(`  ⚠ readiness not reachable: ${(e as Error).message}`)
        }
      }
      if (problems.length) throw new StepFailed(problems.join('; '))
    })
  } finally {
    await k.destroy().catch(() => {})
  }
  const mins = Math.round((Date.now() - t0All) / 60000)
  if (failedAt) {
    say(
      `### FAILED at ${failedAt}: ${failure}${restored ? ' — the safety pass ran; the maintenance page stays up' : ''}`
    )
    return 1
  }
  say(`### DONE — ${dir.target.label} refreshed from ${dir.source.label} in ${mins} min`)
  return 0
}

/** Runs a delegate entry's save/restore command (e.g. keep-help-videos). Failure only warns. */
function runDelegates(
  entries: EnvKeepEntry[],
  which: 'save' | 'restore',
  target: string,
  apiDir: string
) {
  for (const e of entries) {
    if (e.kind !== 'delegate') continue
    const cmd = e.commands?.[which]
    if (!cmd?.length) continue
    const [bin, ...rest] = cmd.map((a) => a.split('{target}').join(target))
    if (!['npx', 'tsx', 'node', 'bash'].includes(bin)) {
      say(`  ⚠ ${e.id}: ${bin} is not an allowed command`)
      continue
    }
    say(`  ${e.label}: ${which}…`)
    const r = spawnSync(bin, rest, { cwd: apiDir, encoding: 'utf8', env: process.env })
    for (const l of `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-6))
      if (l) say(`    ${l}`)
    if (r.status !== 0)
      say(`  ⚠ ${e.label}: ${which} exited ${r.status} — ${e.handled_by ?? 'run it by hand'}`)
  }
}

// ─── rollback ───────────────────────────────────────────────────────────────

async function rollback(args: Args, decl: EnvRefreshDecl): Promise<number> {
  const phases = ROLLBACK_PHASES.map((p) => p.key)
  say(`@@steps ${JSON.stringify(phases)}`)
  const target = decl.environments.find((e) => e.key === args.rollbackTarget)
  if (!target || target.production) {
    say(`### REFUSED: ${args.rollbackTarget} is not an environment a refresh can roll back`)
    return EXIT_REFUSED
  }
  try {
    // Same absolute refusals as a refresh: the target database must be writable.
    const { assertWritableTarget } = await import('../services/env-refresh/directions.js')
    assertWritableTarget(target.database, decl)
  } catch (e) {
    say(`### REFUSED: ${(e as Error).message}`)
    return EXIT_REFUSED
  }
  const T = target.database
  const file = backupFiles(decl.backup_dir ?? DEFAULT_BACKUP_DIR, 'x', T).pre
  const hours = decl.rollback_hours ?? 24
  const { knex: k, sql } = await openServer()
  try {
    event('preflight', 'start')
    let finished: Date
    try {
      const hdr = (await sql.raw(`RESTORE HEADERONLY FROM DISK = N'${file}'`))[0] as any
      if (!hdr || String(hdr.DatabaseName).toLowerCase() !== T.toLowerCase())
        throw new Error(`${file} is not a backup of ${T}`)
      finished = new Date(hdr.BackupFinishDate)
    } catch (e) {
      event('preflight', 'fail')
      say(`### REFUSED: no pre-refresh backup of ${T} (${sqlError(e)})`)
      return EXIT_REFUSED
    }
    const age = (Date.now() - finished.getTime()) / 3_600_000
    say(`  ${file}: ${T} as it was at ${finished.toISOString()} (${age.toFixed(1)} h ago)`)
    if (age > hours) {
      event('preflight', 'fail')
      say(`### REFUSED: the pre-refresh backup is older than ${hours} h — it is no longer offered`)
      return EXIT_REFUSED
    }
    event('preflight', 'ok')
    if (args.dry) {
      event('restore', 'skip')
      event('verify', 'skip')
      say(
        `### DONE — dry run: would put ${T} back to ${finished.toISOString()} — nothing was written`
      )
      return 0
    }
    event('restore', 'start')
    const t0 = Date.now()
    try {
      await restoreOver(sql, file, T)
    } catch (e) {
      event('restore', 'fail', Math.round((Date.now() - t0) / 1000))
      say(`### FAILED at restore: ${sqlError(e)}`)
      return 1
    }
    event('restore', 'ok', Math.round((Date.now() - t0) / 1000))
    event('verify', 'start')
    const state = (await sql.raw('SELECT state_desc FROM sys.databases WHERE name = ?', [T]))[0]
      ?.state_desc
    if (state !== 'ONLINE') {
      event('verify', 'fail')
      say(`### FAILED at verify: ${T} is ${state}`)
      return 1
    }
    event('verify', 'ok')
    say(`### DONE — ${target.label} is back to ${finished.toISOString()}`)
    return 0
  } finally {
    await k.destroy().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().then(
    (code) => process.exit(code),
    (e) => {
      say(`### FAILED: ${sqlError(e)}`)
      process.exit(1)
    }
  )
