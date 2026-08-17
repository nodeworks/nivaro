import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db, migrationSource } from '../db/index.js'
import { extensionRegistry } from '../extensions/loader.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Deploy preflight — "is this instance actually able to serve the build it
 * claims to be running, and did the deploy land in a consistent order?"
 *
 * This exists because of a repeated, specific outage: the deploy repo pushed
 * before the image carrying a new migration had published, so the container
 * started against a database whose `nivaro_migrations` ledger already named
 * migration files that were absent from the image. Knex refuses to run at all
 * in that state ("migration directory is corrupt: <file> missing"), the
 * process exits, and every route 404s — a total outage whose cause is invisible
 * from the outside because there is no server left to ask.
 *
 * A live container answering this route is by definition past that particular
 * cliff, so the value is twofold: CI calls it after `docker compose up -d` to
 * assert the deploy is coherent instead of assuming success, and the admin
 * Health page surfaces drift (pending migrations, a missing extension mount,
 * a version env that lies) before it becomes the next incident.
 *
 * Severity contract, so callers can branch on the status code alone:
 *   fail  → 503. Something is broken or will break on the next restart.
 *   warn  → 200. Works now, but the deploy is not in the state it should be.
 *   ok    → 200.
 */

export type Severity = 'ok' | 'warn' | 'fail'

export interface Check {
  id: string
  status: Severity
  /** One plain sentence. This is what an operator reads at 2am. */
  summary: string
  detail?: Record<string, unknown>
}

const RANK: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 }

function worst(checks: Check[]): Severity {
  return checks.reduce<Severity>((acc, c) => (RANK[c.status] > RANK[acc] ? c.status : acc), 'ok')
}

/**
 * Compare the migration files present in this build against the ledger rows in
 * the database. Both directions matter and they mean different things:
 *
 *   ledger row with no file  → the database is AHEAD of the image. This is the
 *     outage: the next restart of this container dies before listening.
 *   file with no ledger row  → the image is ahead of the database. Migrations
 *     run at boot, so on a healthy single instance this should be empty by the
 *     time anything can call this route; a non-empty list means the run was
 *     skipped or failed. Reported as warn rather than fail because
 *     MIGRATION_SAFE_MODE deliberately makes replicas wait on an advisory lock,
 *     and a replica answering mid-window is not itself broken.
 */
export function diffMigrations(files: string[], applied: string[]): Check {
  const fileSet = new Set(files)
  const appliedSet = new Set(applied)
  // Ledger names are stored with .ts extensions regardless of what actually
  // shipped (the custom migrationSource normalizes them), so both sides of this
  // comparison are already in the same namespace.
  const missingFiles = applied.filter((n) => !fileSet.has(n)).sort()
  const pending = files.filter((n) => !appliedSet.has(n)).sort()

  if (missingFiles.length) {
    return {
      id: 'migrations',
      status: 'fail',
      summary:
        `The database has ${missingFiles.length} migration(s) this build does not contain. ` +
        'This container will not survive a restart — deploy the image that carries them.',
      detail: { missing_files: missingFiles, pending, applied_count: applied.length }
    }
  }

  if (pending.length) {
    return {
      id: 'migrations',
      status: 'warn',
      summary:
        `${pending.length} migration(s) in this build have not been applied. ` +
        'They run at boot, so this usually means the run was skipped, failed, or is still waiting on the migration lock.',
      detail: { pending, applied_count: applied.length }
    }
  }

  return {
    id: 'migrations',
    status: 'ok',
    summary: `All ${applied.length} migrations applied; no files missing.`,
    detail: { applied_count: applied.length }
  }
}

async function checkMigrations(): Promise<Check> {
  let files: string[]
  try {
    files = (await migrationSource.getMigrations()).map((f) => migrationSource.getMigrationName(f))
  } catch (err) {
    return {
      id: 'migrations',
      status: 'fail',
      summary: 'Could not read the migrations directory from this build.',
      detail: { error: err instanceof Error ? err.message : String(err) }
    }
  }

  let applied: string[]
  try {
    const rows = await db('nivaro_migrations').select('name')
    applied = rows.map((r: { name: string }) => r.name)
  } catch (err) {
    return {
      id: 'migrations',
      status: 'fail',
      summary: 'Could not read the nivaro_migrations ledger.',
      detail: { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return diffMigrations(files, applied)
}

/**
 * Extensions are volume-mounted at deploy time and are NOT in the image (they
 * are gitignored and dockerignored by design), so a mount that silently fails
 * to attach produces an instance that boots perfectly and does none of that
 * extension's work — no crons, no hooks, no integrations. Nothing else notices.
 */
function checkExtensions(): Check {
  const required = (config.REQUIRED_EXTENSIONS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const entries = [...extensionRegistry.values()]
  const loaded = entries.filter((e) => e.status === 'loaded').map((e) => e.id)
  const errored = entries
    .filter((e) => e.status === 'error')
    .map((e) => ({ id: e.id, error: e.error }))

  const absent = required.filter((id) => !loaded.includes(id))

  if (absent.length) {
    return {
      id: 'extensions',
      status: 'fail',
      summary:
        `Required extension(s) not loaded: ${absent.join(', ')}. ` +
        'This instance is running without them — check the volume mount.',
      detail: { required, loaded, absent, errored }
    }
  }

  if (errored.length) {
    return {
      id: 'extensions',
      status: 'warn',
      summary: `${errored.length} extension(s) failed to load.`,
      detail: { required, loaded, errored }
    }
  }

  return {
    id: 'extensions',
    status: 'ok',
    summary: required.length
      ? `All ${required.length} required extension(s) loaded.`
      : `${loaded.length} extension(s) loaded; none declared as required.`,
    detail: { required, loaded }
  }
}

/**
 * NIVARO_VERSION is overloaded: every compose file uses it as the IMAGE TAG,
 * so it is routinely the literal `latest`. version.ts already refuses to report
 * a non-version-shaped value, but a deployment pinning `latest` cannot tell you
 * which build is live from its tag either — worth saying out loud, since the
 * documented remedy for the migration-ordering outage is to pin the tag.
 */
function checkVersion(): Check {
  const raw = process.env.NIVARO_VERSION?.trim()
  const pinned = !!raw && /^v?\d+\.\d+/.test(raw)

  if (raw && !pinned) {
    return {
      id: 'version',
      status: 'warn',
      summary:
        `NIVARO_VERSION is "${raw}", not a version — the image tag is unpinned. ` +
        'A release carrying migrations should pin it so the deploy cannot race the image build.',
      detail: { running: NIVARO_VERSION, env: raw, pinned: false }
    }
  }

  return {
    id: 'version',
    status: 'ok',
    summary: `Running ${NIVARO_VERSION}${pinned ? ' (tag pinned)' : ''}.`,
    detail: { running: NIVARO_VERSION, env: raw ?? null, pinned }
  }
}

async function checkConnectivity(app: FastifyInstance): Promise<Check[]> {
  const [dbOk, redisOk] = await Promise.all([
    db
      .raw('SELECT 1')
      .then(() => true)
      .catch(() => false),
    app.redis
      .ping()
      .then((r) => r === 'PONG')
      .catch(() => false)
  ])

  return [
    {
      id: 'database',
      status: dbOk ? 'ok' : 'fail',
      summary: dbOk ? 'Database reachable.' : 'Database unreachable.',
      detail: { database: config.DB_DATABASE, host: config.DB_HOST }
    },
    {
      id: 'redis',
      // Rate limiting and sessions both degrade rather than break without
      // Redis (rate limiting explicitly fails open), so this is not a hard fail.
      status: redisOk ? 'ok' : 'warn',
      summary: redisOk
        ? 'Redis reachable.'
        : 'Redis unreachable — sessions and rate limiting are degraded.',
      detail: { url: config.REDIS_URL }
    }
  ]
}

export async function preflightRoutes(app: FastifyInstance) {
  app.get('/preflight', { preHandler: requireAdmin }, async (_req, reply) => {
    const [migrations, connectivity] = await Promise.all([
      checkMigrations(),
      checkConnectivity(app)
    ])

    const checks: Check[] = [migrations, ...connectivity, checkExtensions(), checkVersion()]
    const status = worst(checks)

    return reply.code(status === 'fail' ? 503 : 200).send({
      data: {
        status,
        version: NIVARO_VERSION,
        environment: config.NODE_ENV,
        checks,
        ts: new Date().toISOString()
      }
    })
  })
}
