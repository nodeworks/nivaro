// Moving a SQLite app's database file between homes (hub gap `sqlite`, 0.3.215). The file level
// only: the routes are services/hub-transfer/database.ts, the move step services/hub/move.
//
// Source (frozen by the move's strict maintenance first, proven by the caller):
//  - snapshotSqliteDatabase: take the file's write lock (waiting for a write in flight), FREEZE the
//    file (every later write is refused with SQLITE_FROZEN, db/sqlite.ts SqliteWriteLock), then
//    `PRAGMA wal_checkpoint(TRUNCATE)` until nothing is left in the WAL (a long reader is waited
//    for: writes are already refused), and copy the main file to a snapshot beside it. The copy is
//    the whole database: nothing is in the WAL and nothing can be written after. One snapshot per
//    file at a time; refused without room for it (SQLITE_NO_SPACE). The freeze holds until the
//    move thaws it (its maintenance is lifted, or the app leaves this process) or the process ends;
//    the pool stays open for reads.
//  - sqliteDatabaseSum: the same freeze + checkpoint under the lock, then the file's sha256 — what
//    the move compares before release (a source that restarted is frozen again here).
// Target:
//  - receiveSqliteFile: the streamed bytes go to `<file>.incoming-<id>` (one name per pull),
//    counted and hashed; refused past the size cap, without room (SQLITE_NO_SPACE), on a short or
//    long body, or a checksum that is not the source's.
//  - verifySqliteFile: opened READ-ONLY in a WORKER THREAD (never on the event loop: a whole
//    shared deployment would stall), bounded in time: `PRAGMA integrity_check` must answer `ok`
//    and the nivaro_migrations ledger must hold rows.
//  - installSqliteFile: rename over the database file (same folder, atomic) and remove its old
//    -wal / -shm; the caller has closed every connection first.
//  - A dedicated app cannot close its own database under itself: it stages the checked file
//    (stageSqliteFile) and restarts; at boot (holding the file's lock) adoptStagedSqliteFile
//    re-hashes it in chunks — the bytes the worker checked — and installs it before anything
//    opens the database, and leaves `<file>.adopted.json` for the Hub to read.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { copyFile, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Worker } from 'node:worker_threads'
import type { Knex } from 'knex'
import { sqliteWriteLockFor, sqliteWriteLockOfFile, thawSqliteWriteLock } from './sqlite.js'

const require = createRequire(import.meta.url)

/** The largest database file a move copies (reported in the refusal). */
export const SQLITE_COPY_MAX_BYTES = 8 * 1024 * 1024 * 1024

/** Room kept free on the volume beyond a copy's own size. */
export const SQLITE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024

/** How long the checkpoint may wait for a long reader (writes are refused meanwhile). */
export const SQLITE_CHECKPOINT_WAIT_MS = 5 * 60_000

/** How long the read-only check of a copy may take in its worker. */
export const SQLITE_CHECK_TIMEOUT_MS = 30 * 60_000

/** Snapshot / incoming files older than this are a crash's leftovers (sweepSqliteLeftovers). */
const LEFTOVER_AGE_MS = 60 * 60_000

/** A refusal the move can tell apart; the message never holds a path. */
export class SqliteTransferError extends Error {
  readonly code:
    | 'SQLITE_CHECKPOINT_BUSY'
    | 'SQLITE_TOO_LARGE'
    | 'SQLITE_NO_SPACE'
    | 'SQLITE_SHORT_COPY'
    | 'SQLITE_CHECKSUM_MISMATCH'
    | 'SQLITE_NOT_INTACT'
    | 'SQLITE_NO_LEDGER'
    | 'SQLITE_NOT_SQLITE'
    | 'SQLITE_CHECK_TIMEOUT'
    | 'DATABASE_COPY_RUNNING'
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

/** Seams (tests). */
export const sqliteTransferDeps = {
  checkpointWaitMs: SQLITE_CHECKPOINT_WAIT_MS,
  checkpointPollMs: 250,
  checkTimeoutMs: SQLITE_CHECK_TIMEOUT_MS,
  /** Free bytes on the volume holding `dir`. */
  async freeBytes(dir: string): Promise<number> {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  }
}

/** Empty the WAL into the main file (TRUNCATE); waits for a long reader to let go. */
async function checkpoint(conn: RawConn): Promise<void> {
  const by = Date.now() + sqliteTransferDeps.checkpointWaitMs
  // No busy handler while it tries: SQLite's would block this event loop for busy_timeout on
  // every try; the waiting happens here, asynchronously, between tries.
  conn.pragma('busy_timeout = 0')
  try {
    for (;;) {
      let busy = true
      try {
        const r = conn.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }> | undefined
        busy = !!r?.[0]?.busy
      } catch (err) {
        if (!/SQLITE_BUSY|locked/i.test(String((err as { code?: unknown })?.code ?? err))) throw err
      }
      if (!busy) return
      if (Date.now() >= by)
        throw new SqliteTransferError(
          'SQLITE_CHECKPOINT_BUSY',
          'The database could not be checkpointed: a reader kept an old view of it for too long. Try again.'
        )
      await new Promise((res) => setTimeout(res, sqliteTransferDeps.checkpointPollMs))
    }
  } finally {
    conn.pragma('busy_timeout = 5000')
  }
}

/** Refuse a copy of `bytes` into the folder of `file` without room for it (and a margin). */
export async function assertRoomFor(file: string, bytes: number): Promise<void> {
  const free = await sqliteTransferDeps.freeBytes(dirname(file))
  if (free < bytes + SQLITE_SPACE_MARGIN_BYTES)
    throw new SqliteTransferError(
      'SQLITE_NO_SPACE',
      `The volume has ${free} bytes free; a copy of ${bytes} bytes needs ${bytes + SQLITE_SPACE_MARGIN_BYTES} (its size and a margin).`
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

/** sha256 of a file read in 4 MiB chunks, synchronously (boot only; no 2 GiB read limit). */
function fileSumSync(path: string): { sha256: string; bytes: number } {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
  let bytes = 0
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      h.update(buf.subarray(0, n))
      bytes += n
    }
  } finally {
    closeSync(fd)
  }
  return { sha256: h.digest('hex'), bytes }
}

export interface SqliteSnapshot {
  /** The snapshot file (beside the database); the caller deletes it once sent. */
  path: string
  sha256: string
  bytes: number
}

/** Files a snapshot or a pull is being made of right now (one at a time per file). */
const busyFiles = new Set<string>()

/** Run `fn` as the only copy of `file` in this process (DATABASE_COPY_RUNNING otherwise). */
export async function oneCopyAtATime<T>(file: string, fn: () => Promise<T>): Promise<T> {
  if (busyFiles.has(file))
    throw new SqliteTransferError(
      'DATABASE_COPY_RUNNING',
      'A copy of this database is already being made here; wait for it to end.'
    )
  busyFiles.add(file)
  try {
    return await fn()
  } finally {
    busyFiles.delete(file)
  }
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
  return oneCopyAtATime(file, async () => {
    sweepSqliteLeftovers(file)
    const size = (await stat(file)).size
    if (size > SQLITE_COPY_MAX_BYTES) throw tooLarge(size)
    await assertRoomFor(file, size)
    const snap = `${file}.snapshot-${randomUUID()}`
    await underWriteLock(k, async (conn) => {
      // Frozen first: the checkpoint may then wait for a long reader with no write coming in.
      sqliteWriteLockFor(conn).freeze(reason)
      await checkpoint(conn)
      await copyFile(file, snap)
    })
    try {
      const sum = await fileSum(snap)
      if (sum.bytes > SQLITE_COPY_MAX_BYTES) throw tooLarge(sum.bytes)
      return { path: snap, ...sum }
    } catch (err) {
      await unlink(snap).catch(() => {})
      throw err
    }
  })
}

/**
 * The database's sha256 now and its size: frozen (again, for a source that restarted since the
 * copy) and checkpointed under the write lock first.
 */
export async function sqliteDatabaseSum(
  k: Knex,
  file: string,
  reason = 'move'
): Promise<{ sha256: string; bytes: number }> {
  return underWriteLock(k, async (conn) => {
    sqliteWriteLockFor(conn).freeze(reason)
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
 * Write the streamed body to `<file>.incoming-<id>`, counting and hashing it. `expected` is what
 * the source declared (Content-Length + X-Nivaro-Sha256). Answers the incoming path.
 */
export async function receiveSqliteFile(
  body: Readable | ReadableStream<Uint8Array>,
  file: string,
  expected: { sha256: string; bytes: number },
  max: number = SQLITE_COPY_MAX_BYTES
): Promise<{ incoming: string; sha256: string; bytes: number }> {
  if (expected.bytes > max) throw tooLarge(expected.bytes)
  await assertRoomFor(file, expected.bytes)
  const incoming = `${file}.incoming-${randomUUID()}`
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
  // The bytes on disk are what was hashed (a second writer would show here).
  const onDisk = await fileSum(incoming)
  if (onDisk.sha256 !== sha256) {
    await unlink(incoming).catch(() => {})
    throw new SqliteTransferError(
      'SQLITE_CHECKSUM_MISMATCH',
      'The copy on disk is not the bytes received; nothing was installed.'
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

// The check itself, run in a worker thread: its own read-only connection, never the app's pool.
const VERIFY_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const Database = require(workerData.driver)
;(() => {
let conn
try {
  conn = new Database(workerData.file, { readonly: true, fileMustExist: true })
} catch {
  parentPort.postMessage({ code: 'SQLITE_NOT_SQLITE' })
  return
}
try {
  let integrity
  try {
    integrity = conn.pragma('integrity_check', { simple: true })
  } catch {
    parentPort.postMessage({ code: 'SQLITE_NOT_SQLITE' })
    return
  }
  if (integrity !== 'ok') {
    parentPort.postMessage({ code: 'SQLITE_NOT_INTACT' })
    return
  }
  const table = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nivaro_migrations'")
    .get()
  if (!table) {
    parentPort.postMessage({ code: 'SQLITE_NO_LEDGER' })
    return
  }
  const row = conn.prepare('SELECT COUNT(*) AS n, MAX(name) AS latest FROM nivaro_migrations').get()
  if (!row || !row.n) {
    parentPort.postMessage({ code: 'SQLITE_NO_LEDGER' })
    return
  }
  parentPort.postMessage({ ok: true, migrations: Number(row.n), latest: row.latest ?? null })
} finally {
  conn.close()
}
})()
`

const VERIFY_TEXT: Record<string, string> = {
  SQLITE_NOT_SQLITE: 'The copy is not a SQLite database.',
  SQLITE_NOT_INTACT: 'The copy failed its integrity check (PRAGMA integrity_check).',
  SQLITE_NO_LEDGER: 'The copy holds no Nivaro install.'
}

/**
 * Open `file` READ-ONLY in a worker thread (nothing written, never the app's pool, never on the
 * event loop): `PRAGMA integrity_check` must answer exactly `ok`, and nivaro_migrations must hold
 * rows. Bounded by `timeoutMs` (SQLITE_CHECK_TIMEOUT; the worker is ended).
 */
export function verifySqliteFile(
  file: string,
  timeoutMs: number = sqliteTransferDeps.checkTimeoutMs
): Promise<SqliteVerified> {
  return new Promise<SqliteVerified>((resolve, reject) => {
    const w = new Worker(VERIFY_WORKER, {
      eval: true,
      workerData: { file, driver: require.resolve('better-sqlite3') }
    })
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
      void w.terminate().catch(() => {})
    }
    const timer = setTimeout(
      () =>
        done(() =>
          reject(
            new SqliteTransferError(
              'SQLITE_CHECK_TIMEOUT',
              `The integrity check of the copy did not end within ${Math.round(timeoutMs / 60_000)} minutes.`
            )
          )
        ),
      timeoutMs
    )
    timer.unref?.()
    w.once('message', (m: { ok?: boolean; code?: string; migrations?: number; latest?: string }) =>
      done(() => {
        if (m.ok)
          resolve({ integrity: 'ok', migrations: Number(m.migrations), latest: m.latest ?? null })
        else {
          const code = (m.code ?? 'SQLITE_NOT_SQLITE') as SqliteTransferError['code']
          reject(new SqliteTransferError(code, VERIFY_TEXT[code] ?? VERIFY_TEXT.SQLITE_NOT_SQLITE))
        }
      })
    )
    w.once('error', () =>
      done(() =>
        reject(new SqliteTransferError('SQLITE_NOT_SQLITE', VERIFY_TEXT.SQLITE_NOT_SQLITE))
      )
    )
    w.once('exit', () =>
      done(() =>
        reject(new SqliteTransferError('SQLITE_NOT_SQLITE', VERIFY_TEXT.SQLITE_NOT_SQLITE))
      )
    )
  })
}

/** Put a verified copy in place of the database file (no connection may be open on it). */
export async function installSqliteFile(incoming: string, file: string): Promise<void> {
  for (const extra of ['-wal', '-shm', '-journal']) await unlink(`${file}${extra}`).catch(() => {})
  await rename(incoming, file)
}

/**
 * A crash's leftovers beside `file`: snapshots and incoming copies older than an hour (a copy in
 * flight is younger and is left). Never the database, its WAL, its lock or a staged marker.
 */
export function sweepSqliteLeftovers(file: string, now = Date.now()): number {
  const dir = dirname(file)
  const base = basename(file)
  let n = 0
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.snapshot-`) && !name.startsWith(`${base}.incoming-`)) continue
    const full = join(dir, name)
    try {
      if (now - statSync(full).mtimeMs < LEFTOVER_AGE_MS) continue
      if (isStagedIncoming(file, full)) continue
      unlinkSync(full)
      n++
    } catch {}
  }
  return n
}

// ─── a dedicated app: staged, then installed at its next boot ───────────────────────────────

const stagedMarker = (file: string) => `${file}.incoming.json`
const adoptedMarker = (file: string) => `${file}.adopted.json`

export interface StagedSqlite {
  sha256: string
  bytes: number
  move_id: number | null
  at: string
  /** The checked incoming copy (`<file>.incoming-<id>`). */
  incoming?: string
}

function readStaged(file: string): StagedSqlite | null {
  try {
    return JSON.parse(readFileSync(stagedMarker(file), 'utf8')) as StagedSqlite
  } catch {
    return null
  }
}

function isStagedIncoming(file: string, path: string): boolean {
  return readStaged(file)?.incoming === path
}

/** Leave a checked `<file>.incoming-<id>` for the next boot to install (adoptStagedSqliteFile). */
export async function stageSqliteFile(
  file: string,
  info: Omit<StagedSqlite, 'at'> & { incoming: string }
): Promise<void> {
  // An older staged copy (an earlier pull of the same move) goes.
  const before = readStaged(file)
  if (before?.incoming && before.incoming !== info.incoming)
    await unlink(before.incoming).catch(() => {})
  const tmp = `${stagedMarker(file)}.${randomUUID()}`
  await writeFile(tmp, JSON.stringify({ ...info, at: new Date().toISOString() }), {
    mode: 0o600
  })
  await rename(tmp, stagedMarker(file))
}

/**
 * At boot, holding the file's lock, before anything opens the database: a staged copy whose marker
 * is readable and whose bytes (re-hashed in chunks — the very bytes the worker checked before
 * staging) still match it replaces the file; the marker moves to `<file>.adopted.json` (what the
 * Hub reads back). A boot that stopped between the rename and the marker (the database already
 * hashes to the marker) writes the adopted marker now. Anything wrong: the staged files are
 * removed and the database is left as it is (the move's step then fails and is run again).
 * Synchronous: it runs while db/index.ts loads. Answers what happened.
 */
export function adoptStagedSqliteFile(file: string): 'none' | 'adopted' | 'refused' {
  const marker = stagedMarker(file)
  if (!existsSync(marker)) return 'none'
  const info = readStaged(file)
  const incoming = info?.incoming ?? `${file}.incoming`
  const dropAll = () => {
    for (const f of [incoming, marker])
      try {
        unlinkSync(f)
      } catch {}
  }
  if (!info || typeof info.sha256 !== 'string') {
    dropAll()
    return 'refused'
  }
  const writeAdopted = () => {
    writeFileSync(adoptedMarker(file), JSON.stringify(info), { mode: 0o600 })
    try {
      unlinkSync(marker)
    } catch {}
  }
  try {
    if (!existsSync(incoming)) {
      // L3: killed between the rename and the marker — the copy may already be in place.
      if (existsSync(file) && fileSumSync(file).sha256 === info.sha256) {
        writeAdopted()
        return 'adopted'
      }
      dropAll()
      return 'refused'
    }
    const size = statSync(incoming).size
    if (size > SQLITE_COPY_MAX_BYTES || size !== info.bytes) {
      dropAll()
      return 'refused'
    }
    if (fileSumSync(incoming).sha256 !== info.sha256) {
      dropAll()
      return 'refused'
    }
    for (const extra of ['-wal', '-shm', '-journal'])
      try {
        unlinkSync(`${file}${extra}`)
      } catch {}
    renameSync(incoming, file)
    writeAdopted()
    return 'adopted'
  } catch {
    dropAll()
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
