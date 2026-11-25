import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import type { Knex } from 'knex'
import { config } from '../../config.js'
import { db } from '../../db/index.js'
import { withSqliteFileReplaced } from '../../db/sqlite-tenant.js'
import {
  adoptedSqliteFile,
  installSqliteFile,
  receiveSqliteFile,
  SQLITE_COPY_MAX_BYTES,
  SqliteTransferError,
  type SqliteVerified,
  snapshotSqliteDatabase,
  sqliteDatabaseSum,
  stageSqliteFile,
  verifySqliteFile
} from '../../db/sqlite-transfer.js'
import { closeTenantPool, getTenantDb } from '../../db/tenant-context.js'
import type { TenantRecord } from '../tenancy/types.js'
import { plainHttpHost, pullDeps, transferSource } from './pull.js'

/**
 * Hub gap sqlite (0.3.215): a SQLite app's database file through the move's transfer path.
 *
 * Source: `GET /api/hub-transfer/database` (routes/hub-transfer.ts, the same transfer ticket as
 * the file copy) — only while the app is proven frozen (a dedicated app: the Hub's strict
 * maintenance read fresh from Redis; a shared one: listed `maintenance`). It freezes the file
 * (db/sqlite-transfer.ts: checkpoint, then no write is taken), snapshots it and streams the
 * snapshot with Content-Length and X-Nivaro-Sha256. `sum` (hub link / deployment link) answers
 * the file's checksum now, for the check before release.
 *
 * Target: `pullDatabase` fetches it with the ticket (redirect refused; an https host name through
 * safeFetch, a loopback / private literal plainly, like the file copy), refuses a body past the
 * size cap or whose checksum is not the source's, and checks the copy READ-ONLY (integrity_check,
 * the migrations ledger). Then a shared app's pool is closed and the copy put in place (no pool
 * opens meanwhile); a dedicated app stages it and restarts, installing it at boot.
 */

export const TRANSFER_DATABASE_PATH = '/api/hub-transfer/database'
export const SHA_HEADER = 'x-nivaro-sha256'

export type DatabaseTransferCode =
  | 'NOT_SQLITE'
  | 'SOURCE_NOT_FROZEN'
  | 'BAD_SOURCE'
  | 'BAD_TICKET'
  | 'SOURCE_REFUSED'
  | 'SOURCE_UNREACHABLE'
  | 'BAD_ANSWER'
  | SqliteTransferError['code']

export class DatabaseTransferError extends Error {
  readonly code: DatabaseTransferCode
  readonly statusCode: number
  constructor(code: DatabaseTransferCode, message: string, statusCode = 409) {
    super(message)
    this.name = 'DatabaseTransferError'
    this.code = code
    this.statusCode = statusCode
  }
}

/** Where this app's SQLite database is: its knex and file, or null (not SQLite). */
export function sqliteDatabaseOf(tenant: TenantRecord | null): { k: Knex; file: string } | null {
  if (tenant) {
    if (tenant.dbClient !== 'sqlite') return null
    const k = getTenantDb()
    return k ? { k, file: tenant.dbConnection } : null
  }
  if (config.DB_CLIENT !== 'sqlite') return null
  return { k: db as unknown as Knex, file: config.DB_DATABASE }
}

/** Seams (tests). */
export const databaseTransferDeps = {
  /** A dedicated app: the Hub's strict maintenance is on (services/security.ts, read fresh). */
  async strictMaintenance(): Promise<boolean> {
    const { hubStrictMaintenanceOn } = await import('../security.js')
    return hubStrictMaintenanceOn()
  },
  /** A dedicated app restarts to install a staged copy (swarm starts it again). */
  restart(): void {
    const t = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
    t.unref?.()
  },
  maxBytes: SQLITE_COPY_MAX_BYTES
}

/** Is this app frozen by a move (the precondition of a snapshot)? */
export async function sourceFrozen(tenant: TenantRecord | null): Promise<boolean> {
  if (tenant) return tenant.status === 'maintenance'
  return databaseTransferDeps.strictMaintenance()
}

/**
 * The snapshot a source sends: frozen first (refused unless the app is proven frozen). The caller
 * streams `path` and removes it.
 */
export async function databaseSnapshot(
  tenant: TenantRecord | null
): Promise<{ path: string; sha256: string; bytes: number }> {
  const src = sqliteDatabaseOf(tenant)
  if (!src) throw new DatabaseTransferError('NOT_SQLITE', "This app's database is not SQLite.")
  if (!(await sourceFrozen(tenant)))
    throw new DatabaseTransferError(
      'SOURCE_NOT_FROZEN',
      'This app is not in the move’s strict maintenance: its database is not handed over.'
    )
  return snapshotSqliteDatabase(src.k, src.file, 'move')
}

/** The source's database checksum now (the check before release). */
export async function databaseSum(
  tenant: TenantRecord | null
): Promise<{ sha256: string; bytes: number }> {
  const src = sqliteDatabaseOf(tenant)
  if (!src) throw new DatabaseTransferError('NOT_SQLITE', "This app's database is not SQLite.")
  return sqliteDatabaseSum(src.k, src.file)
}

/** A readable stream of a snapshot that removes the file once it is closed. */
export function snapshotStream(path: string): NodeJS.ReadableStream {
  const s = createReadStream(path)
  s.once('close', () => {
    void unlink(path).catch(() => {})
  })
  return s
}

export interface DatabasePullRequest {
  /** The source's FILE route (origin + /api/hub-transfer/files), as the file copy sends it. */
  source: string
  ticket: string
}

export interface DatabasePulled {
  sha256: string
  bytes: number
  verified: SqliteVerified
}

/** Fetch, receive and check a copy into `<file>.incoming`. */
async function fetchVerified(
  req: DatabasePullRequest,
  file: string
): Promise<DatabasePulled & { incoming: string }> {
  const files = transferSource(req.source)
  if (!files)
    throw new DatabaseTransferError(
      'BAD_SOURCE',
      'The source is not an address a copy may come from.',
      400
    )
  if (typeof req.ticket !== 'string' || req.ticket.length < 20 || req.ticket.length > 200)
    throw new DatabaseTransferError('BAD_TICKET', 'ticket must be a transfer ticket.', 400)
  const u = new URL(files)
  const url = `${u.origin}${TRANSFER_DATABASE_PATH}`
  const init = {
    method: 'GET',
    headers: { Authorization: `Transfer ${req.ticket}` },
    redirect: 'error' as const,
    signal: AbortSignal.timeout(30 * 60_000)
  }
  let res: Response
  try {
    res = plainHttpHost(u.hostname)
      ? await pullDeps.fetch(url, init)
      : await pullDeps.safeFetch(url, init)
  } catch {
    throw new DatabaseTransferError('SOURCE_UNREACHABLE', 'The source did not answer.', 502)
  }
  const drop = () => void res.body?.cancel().catch(() => {})
  if (res.status === 401 || res.status === 403) {
    drop()
    throw new DatabaseTransferError('SOURCE_REFUSED', 'The source refused the transfer ticket.')
  }
  if (res.status !== 200 || !res.body) {
    let code: string | null = null
    try {
      code = ((await res.json()) as { code?: string }).code ?? null
    } catch {
      drop()
    }
    if (code === 'SOURCE_NOT_FROZEN')
      throw new DatabaseTransferError(
        'SOURCE_NOT_FROZEN',
        'The source is not frozen: it refused to hand its database over.'
      )
    throw new DatabaseTransferError(
      'BAD_ANSWER',
      `The source did not send its database (${res.status}${code ? ` ${code}` : ''}).`,
      502
    )
  }
  const bytes = Number(res.headers.get('content-length'))
  const sha = res.headers.get(SHA_HEADER) ?? ''
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !/^[0-9a-f]{64}$/i.test(sha)) {
    drop()
    throw new DatabaseTransferError(
      'BAD_ANSWER',
      'The source answered without the size and checksum of its database.',
      502
    )
  }
  if (bytes > databaseTransferDeps.maxBytes) {
    drop()
    throw new DatabaseTransferError(
      'SQLITE_TOO_LARGE',
      `The database is ${bytes} bytes; a move copies at most ${databaseTransferDeps.maxBytes} bytes.`
    )
  }
  try {
    const got = await receiveSqliteFile(
      res.body,
      file,
      { sha256: sha, bytes },
      databaseTransferDeps.maxBytes
    )
    let verified: SqliteVerified
    try {
      verified = verifySqliteFile(got.incoming)
    } catch (err) {
      await unlink(got.incoming).catch(() => {})
      throw err
    }
    return { incoming: got.incoming, sha256: got.sha256, bytes: got.bytes, verified }
  } catch (err) {
    if (err instanceof SqliteTransferError) throw new DatabaseTransferError(err.code, err.message)
    throw err
  }
}

/**
 * A shared deployment's app: the copy is checked, then the app's pool is closed and the copy put
 * in place while no pool may open on the file; the app's schema state and caches start again.
 */
export async function pullDatabaseShared(
  t: TenantRecord,
  req: DatabasePullRequest
): Promise<DatabasePulled> {
  if (t.dbClient !== 'sqlite')
    throw new DatabaseTransferError('NOT_SQLITE', "This app's database is not SQLite.")
  const got = await fetchVerified(req, t.dbConnection)
  const { awaitAppSchemaRun, appDatabaseReplaced } = await import('../tenancy/app-migrations.js')
  await withSqliteFileReplaced(t.dbConnection, async () => {
    await awaitAppSchemaRun(t.id)
    await closeTenantPool(t.dbConnection)
    await installSqliteFile(got.incoming, t.dbConnection)
  })
  await appDatabaseReplaced(t)
  return { sha256: got.sha256, bytes: got.bytes, verified: got.verified }
}

/**
 * A dedicated app: it cannot close its own database under itself. The checked copy is staged
 * (`<file>.incoming` + its marker) and the app restarts; its boot installs it
 * (db/sqlite-transfer.ts adoptStagedSqliteFile) before anything opens the database.
 */
export async function pullDatabaseDedicated(
  req: DatabasePullRequest,
  moveId: number | null
): Promise<DatabasePulled & { restarting: true }> {
  if (config.DB_CLIENT !== 'sqlite')
    throw new DatabaseTransferError('NOT_SQLITE', "This app's database is not SQLite.")
  const got = await fetchVerified(req, config.DB_DATABASE)
  await stageSqliteFile(config.DB_DATABASE, {
    sha256: got.sha256,
    bytes: got.bytes,
    move_id: moveId
  })
  databaseTransferDeps.restart()
  return { sha256: got.sha256, bytes: got.bytes, verified: got.verified, restarting: true }
}

/** What a dedicated app adopted at its last boot (the Hub reads it back after the restart). */
export async function databaseAdopted(): Promise<{
  sha256: string
  move_id: number | null
} | null> {
  if (config.DB_CLIENT !== 'sqlite') return null
  const a = await adoptedSqliteFile(config.DB_DATABASE)
  return a ? { sha256: a.sha256, move_id: a.move_id } : null
}

/**
 * Rollback before release on a shared target (the copy is thrown away): the app's pool is
 * closed and its file removed. Only for an app the list holds in maintenance.
 */
export async function discardDatabaseShared(t: TenantRecord): Promise<void> {
  if (t.dbClient !== 'sqlite') return
  if (t.status !== 'maintenance')
    throw new DatabaseTransferError(
      'SOURCE_NOT_FROZEN',
      'Only an app held in maintenance by a move has its copy discarded.'
    )
  await withSqliteFileReplaced(t.dbConnection, async () => {
    const { awaitAppSchemaRun } = await import('../tenancy/app-migrations.js')
    await awaitAppSchemaRun(t.id)
    await closeTenantPool(t.dbConnection)
    for (const extra of ['', '-wal', '-shm', '-journal', '.incoming'])
      await unlink(`${t.dbConnection}${extra}`).catch(() => {})
  })
}
