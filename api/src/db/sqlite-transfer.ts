// Moving a SQLite app's database file between homes (hub gap `sqlite`, 0.3.215). The file level
// only: the routes are services/hub-transfer/database.ts, the move step services/hub/move.
//
// Source (frozen by the move's strict maintenance first, proven by the caller):
//  - snapshotSqliteDatabase: take the file's write lock (waiting for a write in flight), run
//    `PRAGMA wal_checkpoint(TRUNCATE)` until nothing is left in the WAL, FREEZE the file (every
//    later write is refused with SQLITE_FROZEN, db/sqlite.ts SqliteWriteLock) and copy the main
//    file to a snapshot beside it. The copy is the whole database: nothing is in the WAL and
//    nothing can be written after. The freeze holds until the move thaws it (its maintenance is
//    lifted) or the process ends; the pool stays open for reads.
//  - sqliteDatabaseSum: the same checkpoint under the lock, then the file's sha256 — what the
//    move compares before release (the source must not have changed since the copy).
// Target:
//  - receiveSqliteFile: the streamed bytes go to `<file>.incoming`, counted and hashed; refused
//    past the size cap, on a short or long body, or a checksum that is not the source's.
//  - verifySqliteFile: opened READ-ONLY: `PRAGMA integrity_check` must answer `ok` and the
//    nivaro_migrations ledger must hold rows.
//  - installSqliteFile: rename over the database file (same folder, atomic) and remove its old
//    -wal / -shm; the caller has closed every connection first.
//  - A dedicated app cannot close its own database under itself: it stages the verified file
//    (stageSqliteFile) and restarts; at boot adoptStagedSqliteFile checks it again and installs it
//    before anything opens the database, and leaves `<file>.adopted.json` for the Hub to read.
import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { copyFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Knex } from 'knex'
import { sqliteWriteLockFor, sqliteWriteLockOfFile, thawSqliteWriteLock } from './sqlite.js'

const require = createRequire(import.meta.url)

/** The largest database file a move copies (reported in the refusal). */
export const SQLITE_COPY_MAX_BYTES = 8 * 1024 * 1024 * 1024

/** A refusal the move can tell apart; the message never holds a path. */
export class SqliteTransferError extends Error {
  readonly code:
    | 'SQLITE_CHECKPOINT_BUSY'
    | 'SQLITE_TOO_LARGE'
    | 'SQLITE_SHORT_COPY'
    | 'SQLITE_CHECKSUM_MISMATCH'
    | 'SQLITE_NOT_INTACT'
    | 'SQLITE_NO_LEDGER'
    | 'SQLITE_NOT_SQLITE'
  constructor(code: SqliteTransferError['code'], message: string) {
    super(message)
    this.name = 'SqliteTransferError'
    this.code = code
  }
}

interface RawConn {
  name?: string
  pragma(sql: string, opts?: { simple?: boolean }): unknown
}

/** Runs `fn` on one of the pool's raw connections, holding the file's write lock (forced). */
async function underWriteLock<T>(k: Knex, fn: (conn: RawConn) => Promise<T> | T): Promise<T> {
  const client = k.client as {
    acquireConnection(): Promise<RawConn> // lint-traps-ok: a type, not a call
    releaseConnection(c: RawConn): Promise<void>
  }
  const conn = await client.acquireConnection()
  const lock = sqliteWriteLockFor(conn)
  try {
    await lock.acquire(conn, undefined, { force: true })
  } catch (err) {
    await client.releaseConnection(conn)
    throw err
  }
  try {
    return await fn(conn)
  } finally {
    lock.release(conn)
    await client.releaseConnection(conn)
  }
}

/** Empty the WAL into the main file (TRUNCATE), a few tries while a reader holds an old view. */
async function checkpoint(conn: RawConn, tries = 20, waitMs = 250): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const r = conn.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }> | undefined
    if (!r?.[0]?.busy) return
    await new Promise((res) => setTimeout(res, waitMs))
  }
  throw new SqliteTransferError(
    'SQLITE_CHECKPOINT_BUSY',
    'The database could not be checkpointed: a reader kept an old view of it. Try again.'
  )
}

/** sha256 (hex) and size of a file, streamed. */
export async function fileSum(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256')
  let bytes = 0
  await pipeline(
    createReadStream(path),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        h.update(chunk)
        bytes += chunk.length
        cb()
      }
    })
  )
  return { sha256: h.digest('hex'), bytes }
}

export interface SqliteSnapshot {
  /** The snapshot file (beside the database); the caller deletes it once sent. */
  path: string
  sha256: string
  bytes: number
}

/**
 * Freeze and snapshot the database at `file` (the pool `k` is open on it). The caller has proven
 * the app frozen (strict maintenance); this makes sure nothing is written after the copy.
 */
export async function snapshotSqliteDatabase(
  k: Knex,
  file: string,
  reason: string
): Promise<SqliteSnapshot> {
  const snap = `${file}.snapshot-${randomUUID()}`
  await underWriteLock(k, async (conn) => {
    await checkpoint(conn)
    sqliteWriteLockFor(conn).freeze(reason)
    await copyFile(file, snap)
  })
  const sum = await fileSum(snap)
  if (sum.bytes > SQLITE_COPY_MAX_BYTES) {
    await unlink(snap).catch(() => {})
    throw tooLarge(sum.bytes)
  }
  return { path: snap, ...sum }
}

/** The database's sha256 now (checkpointed under the write lock first), and its size. */
export async function sqliteDatabaseSum(
  k: Knex,
  file: string
): Promise<{ sha256: string; bytes: number }> {
  return underWriteLock(k, async (conn) => {
    await checkpoint(conn)
    return fileSum(file)
  })
}

/** Thaw a file a snapshot froze (the move's maintenance was lifted, or it rolled back). */
export function thawSqliteFile(file: string): void {
  thawSqliteWriteLock(file)
}

/** Is the file frozen for a move here? */
export function sqliteFileFrozen(file: string): boolean {
  return sqliteWriteLockOfFile(file).frozen !== null
}

function tooLarge(bytes: number): SqliteTransferError {
  return new SqliteTransferError(
    'SQLITE_TOO_LARGE',
    `The database is ${bytes} bytes; a move copies at most ${SQLITE_COPY_MAX_BYTES} bytes.`
  )
}

/**
 * Write the streamed body to `<file>.incoming`, counting and hashing it. `expected` is what the
 * source declared (Content-Length + X-Nivaro-Sha256). Answers the incoming path.
 */
export async function receiveSqliteFile(
  body: Readable | ReadableStream<Uint8Array>,
  file: string,
  expected: { sha256: string; bytes: number },
  max: number = SQLITE_COPY_MAX_BYTES
): Promise<{ incoming: string; sha256: string; bytes: number }> {
  if (expected.bytes > max) throw tooLarge(expected.bytes)
  const incoming = `${file}.incoming`
  const h = createHash('sha256')
  let bytes = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length
      if (bytes > expected.bytes || bytes > max) {
        cb(new SqliteTransferError('SQLITE_SHORT_COPY', 'The copy is longer than declared.'))
        return
      }
      h.update(chunk)
      cb(null, chunk)
    }
  })
  const src =
    body instanceof Readable
      ? body
      : Readable.fromWeb(body as import('node:stream/web').ReadableStream)
  try {
    await pipeline(src, counter, createWriteStream(incoming, { mode: 0o600 }))
  } catch (err) {
    await unlink(incoming).catch(() => {})
    throw err instanceof SqliteTransferError
      ? err
      : new SqliteTransferError('SQLITE_SHORT_COPY', 'The copy broke off before its end.')
  }
  const sha256 = h.digest('hex')
  if (bytes !== expected.bytes) {
    await unlink(incoming).catch(() => {})
    throw new SqliteTransferError(
      'SQLITE_SHORT_COPY',
      `The copy is ${bytes} bytes; the source sent ${expected.bytes}.`
    )
  }
  if (sha256 !== expected.sha256.toLowerCase()) {
    await unlink(incoming).catch(() => {})
    throw new SqliteTransferError(
      'SQLITE_CHECKSUM_MISMATCH',
      "The copy's checksum is not the source's: it changed on the way."
    )
  }
  return { incoming, sha256, bytes }
}

/** What the read-only check of a copy saw. */
export interface SqliteVerified {
  integrity: 'ok'
  migrations: number
  latest: string | null
}

/**
 * Open `file` READ-ONLY (never the app's pool, nothing written): `PRAGMA integrity_check` must
 * answer exactly `ok`, and nivaro_migrations must hold rows (an app's database, not an empty one).
 */
export function verifySqliteFile(file: string): SqliteVerified {
  const Database = require('better-sqlite3') as new (
    f: string,
    o: { readonly: boolean; fileMustExist: boolean }
  ) => {
    pragma(sql: string, opts?: { simple?: boolean }): unknown
    prepare(sql: string): { get(): unknown; all(): unknown[] }
    close(): void
  }
  let conn: InstanceType<typeof Database>
  try {
    conn = new Database(file, { readonly: true, fileMustExist: true })
  } catch {
    throw new SqliteTransferError('SQLITE_NOT_SQLITE', 'The copy is not a SQLite database.')
  }
  try {
    let integrity: unknown
    try {
      integrity = conn.pragma('integrity_check', { simple: true })
    } catch {
      throw new SqliteTransferError('SQLITE_NOT_SQLITE', 'The copy is not a SQLite database.')
    }
    if (integrity !== 'ok')
      throw new SqliteTransferError(
        'SQLITE_NOT_INTACT',
        'The copy failed its integrity check (PRAGMA integrity_check).'
      )
    const table = conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nivaro_migrations'")
      .get()
    if (!table)
      throw new SqliteTransferError('SQLITE_NO_LEDGER', 'The copy holds no Nivaro install.')
    const row = conn
      .prepare('SELECT COUNT(*) AS n, MAX(name) AS latest FROM nivaro_migrations')
      .get() as { n: number; latest: string | null }
    if (!row?.n)
      throw new SqliteTransferError('SQLITE_NO_LEDGER', 'The copy holds no Nivaro install.')
    return { integrity: 'ok', migrations: Number(row.n), latest: row.latest ?? null }
  } finally {
    conn.close()
  }
}

/** Put a verified copy in place of the database file (no connection may be open on it). */
export async function installSqliteFile(incoming: string, file: string): Promise<void> {
  for (const extra of ['-wal', '-shm', '-journal']) await unlink(`${file}${extra}`).catch(() => {})
  await rename(incoming, file)
}

// ─── a dedicated app: staged, then installed at its next boot ───────────────────────────────

const stagedMarker = (file: string) => `${file}.incoming.json`
const adoptedMarker = (file: string) => `${file}.adopted.json`

export interface StagedSqlite {
  sha256: string
  bytes: number
  move_id: number | null
  at: string
}

/** Leave a verified `<file>.incoming` for the next boot to install (adoptStagedSqliteFile). */
export async function stageSqliteFile(file: string, info: Omit<StagedSqlite, 'at'>): Promise<void> {
  await writeFile(stagedMarker(file), JSON.stringify({ ...info, at: new Date().toISOString() }), {
    mode: 0o600
  })
}

/**
 * At boot, before anything opens the database: a staged copy whose marker is readable, whose
 * bytes still hash to it and that passes the read-only check replaces the file; the marker moves
 * to `<file>.adopted.json` (what the Hub reads back). Anything wrong: the staged files are
 * removed and the database is left as it is (the move's step then fails and is run again).
 * Synchronous: it runs while db/index.ts loads. Answers what happened.
 */
export function adoptStagedSqliteFile(file: string): 'none' | 'adopted' | 'refused' {
  const incoming = `${file}.incoming`
  const marker = stagedMarker(file)
  if (!existsSync(marker) || !existsSync(incoming)) return 'none'
  const drop = () => {
    for (const f of [incoming, marker])
      try {
        unlinkSync(f)
      } catch {}
  }
  try {
    const info = JSON.parse(readFileSync(marker, 'utf8')) as StagedSqlite
    const h = createHash('sha256').update(readFileSync(incoming)).digest('hex')
    if (h !== info.sha256 || statSync(incoming).size !== info.bytes) {
      drop()
      return 'refused'
    }
    verifySqliteFile(incoming)
    for (const extra of ['-wal', '-shm', '-journal'])
      try {
        unlinkSync(`${file}${extra}`)
      } catch {}
    renameSync(incoming, file)
    writeFileSync(adoptedMarker(file), JSON.stringify(info), { mode: 0o600 })
    try {
      unlinkSync(marker)
    } catch {}
    return 'adopted'
  } catch {
    drop()
    return 'refused'
  }
}

/** The copy this app adopted at its last boot (`<file>.adopted.json`), or null. */
export async function adoptedSqliteFile(file: string): Promise<StagedSqlite | null> {
  try {
    await stat(adoptedMarker(file))
    return JSON.parse(readFileSync(adoptedMarker(file), 'utf8')) as StagedSqlite
  } catch {
    return null
  }
}
