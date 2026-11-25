import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Knex } from 'knex'
import { config } from '../../config.js'
import { db } from '../../db/index.js'
import { claimSqliteFile, holdSqliteFile } from '../../db/sqlite.js'
import {
  prepareSqliteFolder,
  SQLITE_CREATED_MARKER,
  withSqliteFileReplaced,
  writeSqliteCreatedMarker
} from '../../db/sqlite-tenant.js'
import {
  adoptedSqliteFile,
  adoptRefusedSqliteFile,
  fileSum,
  installSqliteFile,
  oneCopyAtATime,
  receiveSqliteFile,
  SQLITE_COPY_MAX_BYTES,
  SQLITE_PULL_DEADLINE_MS,
  SqliteTransferError,
  type SqliteVerified,
  snapshotSqliteDatabase,
  sqliteDatabaseSum,
  stageSqliteFile,
  thawSqliteFile,
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
  | 'TARGET_NOT_FROZEN'
  | 'SQLITE_FILE_BUSY'
  | 'BAD_SOURCE'
  | 'BAD_TICKET'
  | 'SOURCE_REFUSED'
  | 'SOURCE_UNREACHABLE'
  | 'BAD_ANSWER'
  | 'TARGET_LEFT'
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
  restart(delayMs = 500): void {
    const t = setTimeout(() => process.kill(process.pid, 'SIGTERM'), delayMs)
    t.unref?.()
  },
  maxBytes: SQLITE_COPY_MAX_BYTES,
  /** The longest a target's whole pull may take (N3); the Hub waits longer. */
  pullDeadlineMs: SQLITE_PULL_DEADLINE_MS
}

/** Review 5 L5: the part of the pull's deadline kept for putting the copy in place. */
function installReserveMs(): number {
  return Math.min(3 * 60_000, Math.floor(databaseTransferDeps.pullDeadlineMs / 5))
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
  // M6: only a source still held by the move; the sum freezes the file again (a source that
  // restarted since the copy lost its in-memory freeze) and it stays frozen through retire.
  if (!(await sourceFrozen(tenant)))
    throw new DatabaseTransferError(
      'SOURCE_NOT_FROZEN',
      'This app is not in the move’s strict maintenance: its checksum is not answered.'
    )
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
  file: string,
  deadline: number,
  signal?: AbortSignal
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
    // N3: the download stops at the pull's own deadline (the body read errors and the incoming
    // copy is removed), well before the Hub stops waiting.
    // Review 5 M1: a cancelled job stops it at once too.
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - Date.now())), signal])
      : AbortSignal.timeout(Math.max(1, deadline - Date.now()))
  }
  /** Why a broken download broke (review 5 L4): cancelled, past the deadline, or the source. */
  const cutReason = (): DatabaseTransferError | null => {
    if (signal?.aborted) return cancelled()
    if (Date.now() >= deadline) return asTransfer(pastDeadline())
    return null
  }
  let res: Response
  try {
    res = plainHttpHost(u.hostname)
      ? await pullDeps.fetch(url, init)
      : await pullDeps.safeFetch(url, init)
  } catch {
    throw (
      cutReason() ??
      new DatabaseTransferError('SOURCE_UNREACHABLE', 'The source did not answer.', 502)
    )
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
    let got: Awaited<ReturnType<typeof receiveSqliteFile>>
    try {
      got = await receiveSqliteFile(
        res.body,
        file,
        { sha256: sha, bytes },
        databaseTransferDeps.maxBytes
      )
    } catch (err) {
      // L4: a download cut by the deadline (or a cancel) says so, not "broke off".
      throw cutReason() ?? err
    }
    let verified: SqliteVerified
    try {
      const left = deadline - Date.now()
      if (signal?.aborted) throw cancelled()
      if (left <= 0) throw pastDeadline()
      // H1 / N3: in a child process killed at the pull's deadline — never on this event loop.
      verified = await verifySqliteFile(got.incoming, left, signal)
      if (signal?.aborted) throw cancelled()
      if (Date.now() > deadline) throw pastDeadline()
    } catch (err) {
      await unlink(got.incoming).catch(() => {})
      throw err
    } finally {
      // The read-only open of a WAL database leaves its -wal / -shm beside the copy.
      for (const extra of ['-wal', '-shm']) await unlink(`${got.incoming}${extra}`).catch(() => {})
    }
    return { incoming: got.incoming, sha256: got.sha256, bytes: got.bytes, verified }
  } catch (err) {
    if (err instanceof SqliteTransferError) throw new DatabaseTransferError(err.code, err.message)
    throw err
  }
}

function asTransfer(err: SqliteTransferError): DatabaseTransferError {
  return new DatabaseTransferError(err.code, err.message)
}

function cancelled(): DatabaseTransferError {
  return new DatabaseTransferError(
    'SQLITE_COPY_CANCELLED',
    'The copy was cancelled (the Hub stopped waiting for it, or the app left this deployment); its incoming file was removed.'
  )
}

function pastDeadline(): SqliteTransferError {
  return new SqliteTransferError(
    'SQLITE_COPY_DEADLINE',
    `The copy did not end within ${Math.round(databaseTransferDeps.pullDeadlineMs / 60_000)} minutes here; its incoming file was removed.`
  )
}

/** When a pull started now must end. */
function pullDeadline(): number {
  return Date.now() + databaseTransferDeps.pullDeadlineMs
}

/**
 * A shared deployment's app (held in maintenance by the move — M2): the copy is checked in a
 * child process, then the app's pool is closed and — holding the file's lock (no other process
 * may own it) — the copy is put in place while no pool may open on the file; the file is thawed (this
 * home is never the frozen source) and the app's schema state and caches start again. One pull per
 * app at a time (M3, DATABASE_COPY_RUNNING).
 */
export async function pullDatabaseShared(
  t: TenantRecord,
  req: DatabasePullRequest,
  opts: {
    /** Review 5 M1: the job's abort (the Hub cancelled, or the app left this process). */
    signal?: AbortSignal
    /**
     * Review 5 M1: the app as the deployment lists it NOW (re-read right before the install), or
     * null when it is no longer listed. Absent: `t` itself (tests).
     */
    current?: () => Promise<TenantRecord | null>
  } = {}
): Promise<DatabasePulled> {
  if (t.dbClient !== 'sqlite')
    throw new DatabaseTransferError('NOT_SQLITE', "This app's database is not SQLite.")
  if (t.status !== 'maintenance')
    throw new DatabaseTransferError(
      'TARGET_NOT_FROZEN',
      'This app is not held in maintenance by a move: its database is never replaced.'
    )
  const file = t.dbConnection
  const deadline = pullDeadline()
  // L5: the download and check end early enough to leave the install its own time.
  const copyBy = deadline - installReserveMs()
  const { signal } = opts
  return oneCopyAtATime(file, async () => {
    prepareSqliteFolder(file)
    const got = await fetchVerified(req, file, copyBy, signal)
    const { awaitAppSchemaRun, appDatabaseReplaced } = await import('../tenancy/app-migrations.js')
    try {
      await withSqliteFileReplaced(file, async () => {
        // H1: never this app's pool before the install (a move's target has no file yet); its
        // schema run (if any) ends first, within the install's own deadline (L5).
        await beforeDeadline(awaitAppSchemaRun(t.id), deadline)
        // M1: still this app, still listed, still held in maintenance, the same record — and
        // nobody cancelled. Otherwise the copy is dropped, never put in place.
        if (signal?.aborted) throw cancelled()
        const now = opts.current ? await opts.current() : t
        if (signal?.aborted) throw cancelled()
        if (
          now?.status !== 'maintenance' ||
          now.dbConnection !== file ||
          (now.dbRecord ?? null) !== (t.dbRecord ?? null)
        )
          throw new DatabaseTransferError(
            'TARGET_LEFT',
            'This app is no longer listed here in maintenance for this move; its copy was dropped.'
          )
        if (Date.now() > deadline) throw asTransfer(pastDeadline())
        await closeTenantPool(file)
        // L7: no other live process may own this file while it is replaced.
        const taken = claimSqliteFile(file)
        if (taken)
          throw new DatabaseTransferError(
            'SQLITE_FILE_BUSY',
            'Another process holds this app database; it is not replaced.',
            503
          )
        const release = holdSqliteFile(file)
        try {
          await installSqliteFile(got.incoming, file)
          // L7: the file is this record's now (its marker names it).
          writeSqliteCreatedMarker(file, t.dbRecord ?? null)
        } finally {
          release()
        }
        thawSqliteFile(file)
      })
    } finally {
      await unlink(got.incoming).catch(() => {})
    }
    await appDatabaseReplaced(t)
    return { sha256: got.sha256, bytes: got.bytes, verified: got.verified }
  })
}

/**
 * A dedicated app (in the move's strict maintenance — M2): it cannot close its own database under
 * itself. The checked copy is staged (`<file>.incoming-<id>` + its marker) and the app restarts
 * (the route does, once the Hub has read that the job ended);
 * its boot installs it (db/sqlite-transfer.ts adoptStagedSqliteFile) before anything opens the
 * database. One pull at a time (M3).
 */
export async function pullDatabaseDedicated(
  req: DatabasePullRequest,
  moveId: number | null,
  opts: { signal?: AbortSignal } = {}
): Promise<DatabasePulled & { restarting: true }> {
  if (config.DB_CLIENT !== 'sqlite')
    throw new DatabaseTransferError('NOT_SQLITE', "This app's database is not SQLite.")
  if (!(await databaseTransferDeps.strictMaintenance()))
    throw new DatabaseTransferError(
      'TARGET_NOT_FROZEN',
      'This app is not in the move’s strict maintenance: its database is never replaced.'
    )
  const file = config.DB_DATABASE
  const deadline = pullDeadline()
  return oneCopyAtATime(file, async () => {
    const got = await fetchVerified(req, file, deadline, opts.signal)
    if (opts.signal?.aborted) {
      await unlink(got.incoming).catch(() => {})
      throw cancelled()
    }
    await stageSqliteFile(file, {
      sha256: got.sha256,
      bytes: got.bytes,
      move_id: moveId,
      incoming: got.incoming
    })
    // The restart is the caller's (routes/hub-link.ts: once the Hub read the job's end).
    return {
      sha256: got.sha256,
      bytes: got.bytes,
      verified: got.verified,
      restarting: true as const
    }
  })
}

/** Resolves `p`, or throws SQLITE_COPY_DEADLINE once `deadline` passes first (L5). */
async function beforeDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      p,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(
          () => reject(asTransfer(pastDeadline())),
          Math.max(0, deadline - Date.now())
        )
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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

/** Review 5 L6: why the last boot refused a staged copy (the Hub fails at once with it), or null. */
export function databaseAdoptRefused(): { move_id: number | null; code: string } | null {
  if (config.DB_CLIENT !== 'sqlite') return null
  const r = adoptRefusedSqliteFile(config.DB_DATABASE)
  return r ? { move_id: r.move_id, code: r.code } : null
}

/**
 * Rollback before release on a shared target (the copy is thrown away): only for an app the list
 * holds in maintenance, and only a file that IS the move's copy (L7: `sha256` of what db_copy
 * installed) — a file that is anything else (an old home's own database) is never deleted.
 */
export async function discardDatabaseShared(
  t: TenantRecord,
  sha256: string | null
): Promise<{ discarded: boolean }> {
  if (t.dbClient !== 'sqlite') return { discarded: false }
  if (t.status !== 'maintenance')
    throw new DatabaseTransferError(
      'TARGET_NOT_FROZEN',
      'Only an app held in maintenance by a move has its copy discarded.'
    )
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return { discarded: false }
  return withSqliteFileReplaced(t.dbConnection, async () => {
    const { awaitAppSchemaRun } = await import('../tenancy/app-migrations.js')
    await awaitAppSchemaRun(t.id)
    await closeTenantPool(t.dbConnection)
    let now: string | null = null
    try {
      now = (await fileSum(t.dbConnection)).sha256
    } catch {
      now = null
    }
    if (now !== sha256) return { discarded: false }
    // L3: no other live process may own the file while it is removed.
    const taken = claimSqliteFile(t.dbConnection)
    if (taken)
      throw new DatabaseTransferError(
        'SQLITE_FILE_BUSY',
        'Another process holds this app database; its copy is not removed.',
        503
      )
    const release = holdSqliteFile(t.dbConnection)
    try {
      for (const extra of ['', '-wal', '-shm', '-journal'])
        await unlink(`${t.dbConnection}${extra}`).catch(() => {})
      // Review 5 L2: the marker the install wrote goes with the copy, so a later NEW placement
      // of the environment here is not refused for a file that is gone.
      await unlink(join(dirname(t.dbConnection), SQLITE_CREATED_MARKER)).catch(() => {})
    } finally {
      release()
    }
    return { discarded: true }
  })
}
