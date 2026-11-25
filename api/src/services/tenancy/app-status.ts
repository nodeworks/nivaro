import knex, { type Knex } from 'knex'
import { parseDbUrl } from '../../db/connection-url.js'
import { db } from '../../db/index.js'
import { mssqlUrlConnection } from '../../db/mssql-url-connection.js'
import { mysqlFlavorConfig } from '../../db/mysql-flavor.js'
import { MYSQL_SESSION_SQL, mysqlTypeCast } from '../../db/mysql-session.js'
import { rawRows } from '../../db/raw-rows.js'
import { getTenantId, mysqlTenantTls, withTenant } from '../../db/tenant-context.js'
import { NIVARO_VERSION } from '../../version.js'
import { keyFingerprint } from '../app-key-fingerprint.js'
import {
  DB_IDENTITY_DEFAULT_PORT,
  type DbIdentityEngine,
  dbIdentitySql,
  formatDbIdentity,
  oidcIdentity
} from '../db-identity.js'
import { scrubDbError } from '../hub/db/connection.js'
import { objectStorageCounts } from '../hub-transfer/object-counts.js'
import type { TenantRecord } from './types.js'

/**
 * Hub phase 6 — what a Hub shared deployment tells its Hub about each app it serves, over the
 * deployment link (routes/hub-deployment-link.ts). The response shapes are the Hub client's
 * `DeploymentStatus` / `DeploymentAppStatus` (services/hub/shared/deployment-client.ts, Task 3).
 *
 * Health figures and counts only: never a record, a connection string, a key (the app key is
 * reported as its fingerprint, services/app-key-fingerprint.ts) or a check's detail.
 */

export interface PreflightSummary {
  status: string
  failing: string[]
}

export interface DeploymentAppStatus {
  id: string
  version: string
  preflight: PreflightSummary
  readiness_score: number | null
  busy: { imports: number; exports: number; renders: number }
  /** objects (P6-31): rows per non-local provider; absent from older apps (= unknown). */
  files: { count: number; bytes: number; local: number; objects?: Record<string, number> }
  key_fp: string | null
  maintenance: boolean
}

export type AppSchemaState = 'pending' | 'running' | 'ok' | 'failed'

export interface DeploymentStatus {
  version: string
  instance: string
  registry: {
    count: number
    loaded_at: string | null
    etag: string | null
    stale: boolean
    dropped: { id: string; why: string }[]
  }
  apps: {
    id: string
    schema: { state: AppSchemaState; version: string | null; error: string | null }
  }[]
  extensions: string[]
  oidc: { issuer_host: string; tenant: string | null } | null
  process: Record<string, unknown>
  /** Whether this deployment runs flow script steps (FLOW_SCRIPTS_ON_SHARED, an operator opt-in).
   *  Absent on a deployment before 0.3.215: read as off. */
  flow_scripts?: boolean
}

/** How long one app's preflight run is reused, and how long a status call waits for each part
 *  (well inside the Hub client's 8 s). */
const PREFLIGHT_REUSE_MS = 15_000
let boundMs = 4_000

/** A preflight run older than this is treated as hung: the next poll starts a fresh one. */
let flightStaleMs = 30_000

const preflightCache = new Map<string, { at: number; value: PreflightSummary }>()
/** The run in flight per app (single-flight, as routes/hub-link.ts does for one app): a run slower
 *  than the bound is joined by every later poll, never repeated, until it counts as hung. */
const preflightFlights = new Map<string, { started: number; promise: Promise<PreflightSummary> }>()

export function _resetAppStatusForTests(opts: { boundMs?: number; staleMs?: number } = {}): void {
  preflightCache.clear()
  preflightFlights.clear()
  boundMs = opts.boundMs ?? 4_000
  flightStaleMs = opts.staleMs ?? 30_000
}

const TIMED_OUT = Symbol('timed-out')

function bounded<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function startPreflight(
  tenantId: string,
  run: () => Promise<PreflightSummary>
): Promise<PreflightSummary> {
  const flight = {
    started: Date.now(),
    promise: Promise.resolve()
      .then(run)
      .then((value) => {
        preflightCache.set(tenantId, { at: Date.now(), value })
        return value
      })
      .catch(() => ({ status: 'unknown', failing: [] as string[] }))
      .finally(() => {
        // a hung run let go earlier never clears a newer one
        if (preflightFlights.get(tenantId) === flight) preflightFlights.delete(tenantId)
      })
  }
  preflightFlights.set(tenantId, flight)
  return flight.promise
}

async function preflightFor(
  tenantId: string,
  run: (() => Promise<PreflightSummary>) | undefined
): Promise<PreflightSummary> {
  if (!run) return { status: 'unknown', failing: [] }
  const hit = preflightCache.get(tenantId)
  if (hit && Date.now() - hit.at < PREFLIGHT_REUSE_MS) return hit.value
  const flying = preflightFlights.get(tenantId)
  const promise =
    flying && Date.now() - flying.started < flightStaleMs
      ? flying.promise
      : startPreflight(tenantId, run)
  const v = await bounded(promise, boundMs)
  return v === TIMED_OUT ? { status: 'timeout', failing: [] } : v
}

async function readinessScore(): Promise<number | null> {
  try {
    const { readReadiness } = await import('../readiness.js')
    const report = await bounded(readReadiness(), boundMs)
    if (report === TIMED_OUT) return null
    return typeof report.score === 'number' ? report.score : null
  } catch {
    return null
  }
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** COUNT(*) of `q` on the current app's database; 0 when the table does not exist (an app
 *  behind that migration). A read error throws: a status that cannot see work must not say
 *  "idle". */
async function countIf(table: string, q: (k: Knex.QueryBuilder) => Knex.QueryBuilder) {
  if (!(await db.schema.hasTable(table))) return 0
  const row = (await q(db(table)).count({ n: '*' }).first()) as { n?: unknown } | undefined
  return num(row?.n)
}

async function busyCounts(): Promise<DeploymentAppStatus['busy']> {
  const [imports, exports, renders] = await Promise.all([
    countIf('nivaro_import_jobs', (q) => q.whereIn('status', ['pending', 'processing'])),
    // services/export-runs.ts EXPORT_JOB_PREFIX
    countIf('nivaro_job_runs', (q) =>
      q.where('status', 'running').where('job_id', 'like', 'bg-export:%')
    ),
    countIf('nivaro_help_video_versions', (q) =>
      q.whereIn('render_status', ['queued', 'rendering'])
    )
  ])
  return { imports, exports, renders }
}

async function fileCounts(): Promise<DeploymentAppStatus['files']> {
  if (!(await db.schema.hasTable('nivaro_files'))) return { count: 0, bytes: 0, local: 0 }
  const all = (await db('nivaro_files').count({ n: '*' }).sum({ b: 'filesize' }).first()) as
    | { n?: unknown; b?: unknown }
    | undefined
  // Objects on the env-driven provider (a null provider is a row from before the column).
  const local = (await db('nivaro_files')
    .where((q) => q.whereNull('storage_provider').orWhere('storage_provider', 'local'))
    .count({ n: '*' })
    .first()) as { n?: unknown } | undefined
  const objects = await objectStorageCounts()
  return {
    count: num(all?.n),
    bytes: num(all?.b),
    local: num(local?.n),
    ...(objects ? { objects } : {})
  }
}

/**
 * One app's status, read inside that app (its database, its readiness scorecard). `preflight`
 * runs the app's preflight checks (the route passes runPreflight); without it the preflight is
 * `unknown`. Throws when the app's database cannot be read (the route answers 503).
 */
export async function appStatusFor(
  t: TenantRecord,
  opts: { preflight?: () => Promise<PreflightSummary> } = {}
): Promise<DeploymentAppStatus> {
  return withTenant(
    t,
    async () => {
      const [preflight, readiness_score, busy, files] = await Promise.all([
        preflightFor(getTenantId() ?? t.id, opts.preflight),
        readinessScore(),
        busyCounts(),
        fileCounts()
      ])
      return {
        id: t.id,
        version: NIVARO_VERSION,
        preflight,
        readiness_score,
        busy,
        files,
        key_fp: t.encryptionKey ? keyFingerprint(t.encryptionKey) : null,
        maintenance: t.status === 'maintenance'
      }
    },
    t.origin
  )
}

/** The deployment's OIDC issuer as the Hub compares it (Decision 13): services/db-identity.ts. */
export { oidcIdentity }

// ─── Database check (the Hub asks before it lists an app's database here) ───────────────────

export const DB_CHECK_CLIENTS = new Set(['mssql', 'pg', 'mysql2', 'mariadb'])
const DB_CHECK_TIMEOUT_MS = 10_000

/**
 * What the check saw of nivaro_migrations (ruling P6-11b): no table, a table with no rows, rows
 * (an install), or a read that failed. `ledger: null` alone cannot tell "no table" from "could
 * not read it"; this can. null when the database was not reached.
 */
export type LedgerState = 'absent' | 'empty' | 'present' | 'error'

export interface DbCheckResult {
  reachable: boolean
  ledger: { count: number; latest: string | null } | null
  ledger_state: LedgerState | null
  /** `engine|server|port|database`, lower case (ruling R2); null when it cannot be read. */
  db_identity: string | null
  error: string | null
}

/** A short-lived knex for one connection: one connection, never cached (unlike tenant pools). */
function oneShotKnex(client: string, connection: string): Knex {
  const mariadb = client === 'mariadb'
  const k = mariadb ? 'mysql2' : client
  const pool = { min: 0, max: 1 }
  if (/mysql/i.test(k))
    return knex({
      client: k,
      ...mysqlFlavorConfig(mariadb),
      connection: {
        ...mysqlTenantTls(connection),
        timezone: 'Z',
        typeCast: mysqlTypeCast
      } as never,
      acquireConnectionTimeout: DB_CHECK_TIMEOUT_MS,
      pool: {
        ...pool,
        afterCreate: (
          conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
          done: (err: Error | null, c: unknown) => void
        ) => conn.query(MYSQL_SESSION_SQL, (err) => done(err, conn))
      }
    })
  // A SQL Server URL with options as an object (db/mssql-url-connection.ts): as a string,
  // encrypt=false reached tedious as the text "false" and every such check failed.
  const conn = (/mssql/i.test(k) ? mssqlUrlConnection(connection) : null) ?? connection
  return knex({ client: k, connection: conn, acquireConnectionTimeout: DB_CHECK_TIMEOUT_MS, pool })
}

/** The ledger and what was seen of it; a read that throws is `error`, never absent or empty. */
export async function readLedger(
  k: Knex
): Promise<{ ledger: DbCheckResult['ledger']; state: LedgerState }> {
  try {
    if (!(await k.schema.hasTable('nivaro_migrations'))) return { ledger: null, state: 'absent' }
    const c = (await k('nivaro_migrations').count({ n: '*' }).first()) as
      | { n?: unknown }
      | undefined
    const last = (await k('nivaro_migrations').orderBy('id', 'desc').first('name')) as
      | { name?: unknown }
      | undefined
    const count = num(c?.n)
    return {
      ledger: { count, latest: typeof last?.name === 'string' ? last.name : null },
      state: count > 0 ? 'present' : 'empty'
    }
  } catch {
    return { ledger: null, state: 'error' }
  }
}

async function readIdentity(k: Knex, client: string, connection: string): Promise<string | null> {
  let fallback: { host?: string; port?: number; database?: string } = {}
  try {
    fallback = parseDbUrl(connection)
  } catch {
    // identity from the server only
  }
  // Which server and database the connection really reached: services/db-identity.ts.
  const sql = dbIdentitySql(client)
  if (!sql) return null
  try {
    const [r] = rawRows<{ s: unknown; p: unknown; d: unknown }>(await k.raw(sql))
    return formatDbIdentity(client, r, {
      server: fallback.host || '',
      port: fallback.port ?? DB_IDENTITY_DEFAULT_PORT[client as DbIdentityEngine] ?? null,
      database: fallback.database || ''
    })
  } catch {
    return null
  }
}

/**
 * Can this deployment reach `connection`, and what is there? One connection, 10 s, destroyed
 * after. The error text is scrubbed (scrubDbError with the connection as a secret): it never
 * holds the connection string or its password.
 */
export async function checkDatabase(client: string, connection: string): Promise<DbCheckResult> {
  let k: Knex | null = null
  const work = (async (): Promise<DbCheckResult> => {
    k = oneShotKnex(client, connection)
    await k.raw('SELECT 1')
    const [db_identity, ledger] = await Promise.all([
      readIdentity(k, client, connection),
      readLedger(k)
    ])
    return {
      reachable: true,
      ledger: ledger.ledger,
      ledger_state: ledger.state,
      db_identity,
      error: null
    }
  })()
  try {
    const out = await bounded(work, DB_CHECK_TIMEOUT_MS + 1_000)
    if (out === TIMED_OUT)
      return {
        reachable: false,
        ledger: null,
        ledger_state: null,
        db_identity: null,
        error: `The database did not answer within ${DB_CHECK_TIMEOUT_MS / 1000} s.`
      }
    return out
  } catch (err) {
    return {
      reachable: false,
      ledger: null,
      ledger_state: null,
      db_identity: null,
      error: scrubDbError(err, [connection, safePassword(connection)])
    }
  } finally {
    work.catch(() => {})
    const opened = k as Knex | null
    if (opened) void opened.destroy().catch(() => {})
  }
}

/** The connection's password, for the scrub: URL form, else an ADO-style `Password=` / `Pwd=`
 *  pair (review minor 5); null when there is none. */
function safePassword(connection: string): string | null {
  try {
    const p = parseDbUrl(connection).password
    if (p) return p
  } catch {
    // not a URL: try the key=value form
  }
  const m = /(?:^|;)\s*(?:password|pwd)\s*=\s*(\{[^}]*\}|[^;]*)/i.exec(connection)
  const v = m?.[1]?.trim().replace(/^\{(.*)\}$/, '$1')
  return v ? v : null
}
