#!/usr/bin/env node
/**
 * Boot recovery drills (#2839). `pnpm chaos:boot [--port 3233] [--wait-ms 8000] [--record <url>]`
 *
 * (a) A throwaway API with the DATABASE unreachable, then one with REDIS unreachable
 *     (closed local ports): it must back off (log lines) and exit 1 inside the
 *     BOOT_DEPS_WAIT_MS window.
 * (b) The stale migration lock (MIGRATION_LOCK_STALE_MS) is proven by the vitest
 *     api/src/db/migration-lock.test.ts (mocked knex — never the shared ledger). When
 *     CHAOS_SCRATCH_DB names a scratch database this script may use, it also leaves a
 *     real knex lock row there, boots, and expects the boot to free it. Not run unless set.
 *
 * Never points at a real database: DB_HOST is a closed port on 127.0.0.1.
 */
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { finish, getJson, parseArgs, printChecks, repoRoot, startApi, summarize, waitFor } from './lib.mjs'

const args = parseArgs()
const port = Number(args.port ?? 3233)
const waitMs = Number(args['wait-ms'] ?? 8000)
const started_at = new Date().toISOString()

function closedPort() {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

async function drill(name, env, expectName) {
  const { stop, lines, exited } = startApi({
    port,
    env: { BOOT_DEPS_WAIT_MS: String(waitMs), ...env }
  })
  const killTimer = setTimeout(() => stop('SIGTERM'), waitMs + 60_000)
  const res = await exited
  clearTimeout(killTimer)
  const waiting = lines.filter((l) => /Boot dependencies: waiting for/.test(l.line))
  const mine = waiting.filter((l) => l.line.includes(expectName))
  const gaveUp = lines.find((l) => /Boot dependencies unreachable after/.test(l.line))
  return [
    { name: `${name}: backs off with retry log lines`, ok: mine.length >= 2, detail: `${mine.length} retry lines for ${expectName}` },
    { name: `${name}: exits 1 for the orchestrator`, ok: res.code === 1, detail: `exit ${res.code ?? res.signal}` },
    {
      name: `${name}: gives up inside the window`,
      ok: !!gaveUp && res.at < waitMs + 30_000,
      detail: `${Math.round(res.at / 1000)} s (budget ${waitMs / 1000} s + boot)`
    }
  ]
}


/**
 * Real run on a scratch database (never the shared one): hold knex's lock row, boot WITH
 * migrations and MIGRATION_LOCK_STALE_MS=15000, expect "Freeing the stale lock" and a live
 * /api/version. DB_HOST/user/password come from .env; only the database name is swapped.
 */
async function scratchLockDrill() {
  const name = 'real stale lock freed on CHAOS_SCRATCH_DB'
  const scratch = process.env.CHAOS_SCRATCH_DB
  const { createRequire } = await import('node:module')
  const { config: dotenv } = createRequire(`${repoRoot}/api/package.json`)('dotenv')
  dotenv({ path: `${repoRoot}/.env` })
  if (scratch === process.env.DB_DATABASE || /^EFP_/i.test(scratch))
    return { name, ok: false, detail: `refusing ${scratch}: looks like a shared database` }
  const knex = createRequire(`${repoRoot}/api/package.json`)('knex')
  const db = knex({
    client: 'mssql',
    connection: {
      server: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: scratch,
      options: { encrypt: true, trustServerCertificate: true }
    }
  })
  try {
    await db.migrate.latest({ directory: `${repoRoot}/api/src/db/migrations` }).catch(() => {})
    await db.raw('UPDATE nivaro_migrations_lock SET is_locked = 1')
  } finally {
    await db.destroy()
  }
  const { stop, lines } = startApi({
    port,
    env: {
      DB_DATABASE: scratch,
      SKIP_BOOT_MIGRATIONS: '',
      MIGRATION_LOCK_STALE_MS: '15000',
      BOOT_DEPS_WAIT_MS: '30000'
    }
  })
  const up = await waitFor(async () => (await getJson(`http://127.0.0.1:${port}/api/version`)).status === 200, {
    timeoutMs: 180_000
  })
  stop('SIGTERM')
  const freed = lines.some((l) => /Freeing the stale lock/.test(l.line))
  return { name, ok: !!up && freed, detail: `freed=${freed} up=${!!up}` }
}

const checks = []
const dead = await closedPort()
checks.push(...(await drill('database down', { DB_HOST: '127.0.0.1', DB_PORT: String(dead) }, 'database')))
checks.push(...(await drill('redis down', { REDIS_URL: `redis://127.0.0.1:${await closedPort()}` }, 'redis')))

// (b) the lock logic, mocked — the unit test is the proof that runs everywhere.
const t = spawnSync('npx', ['vitest', 'run', 'src/db/migration-lock.test.ts'], {
  cwd: `${repoRoot}/api`,
  encoding: 'utf8'
})
checks.push({
  name: 'stale migration lock freed after MIGRATION_LOCK_STALE_MS (mocked knex)',
  ok: t.status === 0,
  detail: t.status === 0 ? 'migration-lock.test.ts passed' : 'migration-lock.test.ts failed'
})

if (process.env.CHAOS_SCRATCH_DB) checks.push(await scratchLockDrill())

printChecks(checks)
const verdict = summarize(checks)
console.log(`boot drills: ${verdict}`)
await finish(args, {
  script: 'boot-drills',
  fault_key: 'ci.boot',
  label: 'Boot and migration recovery drills',
  verdict,
  metrics: { wait_ms: waitMs, checks: checks.length, failed: checks.filter((c) => !c.ok).length },
  checks,
  started_at,
  ended_at: new Date().toISOString()
})
process.exit(verdict === 'held' ? 0 : 1)
