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
//  - verifySqliteFile: opened READ-ONLY in a CHILD PROCESS (never on the event loop: a whole
//    shared deployment would stall), killed at its time limit (N3: integrity_check is one native
//    call a worker thread cannot be stopped in): `PRAGMA integrity_check` must answer `ok` and the
//    nivaro_migrations ledger must hold rows.
//  - Room: a copy reserves its bytes on the volume while it is made (L4), so two copies of
//    different apps never both pass against the same free space.
//  - installSqliteFile: rename over the database file (same folder, atomic) and remove its old
//    -wal / -shm; the caller has closed every connection first.
//  - A dedicated app cannot close its own database under itself: it stages the checked file
//    (stageSqliteFile) and restarts; at boot (holding the file's lock) adoptStagedSqliteFile
//    re-hashes it in chunks — the bytes the check passed — and installs it before anything
//    opens the database, and leaves `<file>.adopted.json` for the Hub to read.

import { spawn } from 'node:child_process'
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
import type { Knex } from 'knex'
import { sqliteWriteLockFor, sqliteWriteLockOfFile, thawSqliteWriteLock } from './sqlite.js'

const require = createRequire(import.meta.url)

/** The largest database file a move copies (reported in the refusal). */
export const SQLITE_COPY_MAX_BYTES = 8 * 1024 * 1024 * 1024

/** Room kept free on the volume beyond a copy's own size. */
export const SQLITE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024

/** How long the checkpoint may wait for a long reader (writes are refused meanwhile). */
export const SQLITE_CHECKPOINT_WAIT_MS = 5 * 60_000

/**
 * How long a target's whole pull (download + check) may take (N3). Shorter than the Hub's own
 * wait for it (DATABASE_COPY_TIMEOUT_MS, 30 min): the target always gives up first, removes its
 * incoming copy and says why, so the Hub never leaves a copy that finishes after it stopped.
 */
export const SQLITE_PULL_DEADLINE_MS = 25 * 60_000

/** How long the read-only check of a copy may take in its child process (at most the pull's). */
export const SQLITE_CHECK_TIMEOUT_MS = SQLITE_PULL_DEADLINE_MS

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
    | 'SQLITE_CHECK_FAILED'
    | 'SQLITE_COPY_DEADLINE'
    | 'SQLITE_COPY_CANCELLED'
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
  /** The check's program (tests replace it with one that hangs or crashes). */
  checkScript: '' as string,
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

/** Bytes copies in flight in this process have reserved, per volume (device id) — L4. */
const reservedBytes = new Map<number, number>()

/**
 * Reserve room for a copy of `bytes` in the folder of `file`: refused (SQLITE_NO_SPACE) unless the
 * volume's free space, less what other copies in flight here reserved, holds it and a margin.
 * Answers the release (call it once the copy is on disk or gone).
 */
export async function reserveRoomFor(file: string, bytes: number): Promise<() => void> {
  const dir = dirname(file)
  let dev = 0
  try {
    dev = statSync(dir).dev
  } catch {
    // the folder is made by the caller; an unreadable one is judged on free space alone
  }
  const free = await sqliteTransferDeps.freeBytes(dir)
  // Read after the await: a copy that reserved meanwhile counts.
  const held = reservedBytes.get(dev) ?? 0
  if (free - held < bytes + SQLITE_SPACE_MARGIN_BYTES)
    throw new SqliteTransferError(
      'SQLITE_NO_SPACE',
      `The volume has ${free} bytes free${held ? ` (${held} of them held for other copies in progress)` : ''}; a copy of ${bytes} bytes needs ${bytes + SQLITE_SPACE_MARGIN_BYTES} (its size and a margin).`
    )
  reservedBytes.set(dev, held + bytes)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (reservedBytes.get(dev) ?? 0) - bytes
    if (left > 0) reservedBytes.set(dev, left)
    else reservedBytes.delete(dev)
  }
}

/** Refuse a copy of `bytes` into the folder of `file` without room for it (nothing reserved). */
export async function assertRoomFor(file: string, bytes: number): Promise<void> {
  ;(await reserveRoomFor(file, bytes))()
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
    const unreserve = await reserveRoomFor(file, size)
    const snap = `${file}.snapshot-${randomUUID()}`
    try {
      await underWriteLock(k, async (conn) => {
        // Frozen first: the checkpoint may then wait for a long reader with no write coming in.
        sqliteWriteLockFor(conn).freeze(reason)
        await checkpoint(conn)
        await copyFile(file, snap)
      })
    } finally {
      // The snapshot is on disk now (the volume's free space counts it) or gone.
      unreserve()
    }
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
  const unreserve = await reserveRoomFor(file, expected.bytes)
  try {
    return await receiveInto(body, file, expected, max)
  } finally {
    unreserve()
  }
}

async function receiveInto(
  body: Readable | ReadableStream<Uint8Array>,
  file: string,
  expected: { sha256: string; bytes: number },
  max: number
): Promise<{ incoming: string; sha256: string; bytes: number }> {
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

// The check itself, run in a child process: its own read-only connection, never the app's pool.
// argv: [file, driver]. Prints one JSON line.
const VERIFY_CHILD = `
const Database = require(process.argv[2])
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
;(() => {
let conn
try {
  conn = new Database(process.argv[1], { readonly: true, fileMustExist: true })
} catch {
  say({ code: 'SQLITE_NOT_SQLITE' })
  return
}
try {
  let integrity
  try {
    integrity = conn.pragma('integrity_check', { simple: true })
  } catch {
    say({ code: 'SQLITE_NOT_SQLITE' })
    return
  }
  if (integrity !== 'ok') {
    say({ code: 'SQLITE_NOT_INTACT' })
    return
  }
  const table = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nivaro_migrations'")
    .get()
  if (!table) {
    say({ code: 'SQLITE_NO_LEDGER' })
    return
  }
  const row = conn.prepare('SELECT COUNT(*) AS n, MAX(name) AS latest FROM nivaro_migrations').get()
  if (!row || !row.n) {
    say({ code: 'SQLITE_NO_LEDGER' })
    return
  }
  say({ ok: true, migrations: Number(row.n), latest: row.latest ?? null })
} finally {
  conn.close()
}
})()
`

const VERIFY_TEXT: Record<string, string> = {
  SQLITE_NOT_SQLITE: 'The copy is not a SQLite database.',
  SQLITE_NOT_INTACT: 'The copy failed its integrity check (PRAGMA integrity_check).',
  SQLITE_NO_LEDGER: 'The copy holds no Nivaro install.',
  SQLITE_CHECK_FAILED: 'The check of the copy stopped before it answered.'
}

/** Check processes running now (killed when this process ends, so none outlives it). */
const checkers = new Set<import('node:child_process').ChildProcess>()
let checkerExitHook = false

/**
 * Open `file` READ-ONLY in a child process (nothing written, never the app's pool, never on the
 * event loop): `PRAGMA integrity_check` must answer exactly `ok`, and nivaro_migrations must hold
 * rows. At `timeoutMs` the child is KILLED (SQLITE_CHECK_TIMEOUT) — the work stops, not just the
 * wait; a child that dies or answers nothing is SQLITE_CHECK_FAILED.
 */
export function verifySqliteFile(
  file: string,
  timeoutMs: number = sqliteTransferDeps.checkTimeoutMs,
  signal?: AbortSignal
): Promise<SqliteVerified> {
  return new Promise<SqliteVerified>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SqliteTransferError('SQLITE_COPY_CANCELLED', 'The copy was cancelled.'))
      return
    }
    let child: import('node:child_process').ChildProcess
    try {
      child = spawn(
        process.execPath,
        [
          '-e',
          sqliteTransferDeps.checkScript || VERIFY_CHILD,
          file,
          require.resolve('better-sqlite3')
        ],
        // No inherited NODE_OPTIONS (loaders, inspectors): a plain node running one script.
        { stdio: ['ignore', 'pipe', 'ignore'], env: {} }
      )
    } catch {
      reject(new SqliteTransferError('SQLITE_CHECK_FAILED', VERIFY_TEXT.SQLITE_CHECK_FAILED))
      return
    }
    checkers.add(child)
    if (!checkerExitHook) {
      checkerExitHook = true
      process.once('exit', () => {
        for (const c of checkers) c.kill('SIGKILL')
      })
    }
    let out = ''
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      checkers.delete(child)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      fn()
    }
    const timer = setTimeout(
      () =>
        done(() =>
          reject(
            new SqliteTransferError(
              'SQLITE_CHECK_TIMEOUT',
              `The integrity check of the copy did not end within ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes; it was stopped.`
            )
          )
        ),
      timeoutMs
    )
    timer.unref?.()
    // Review 5 M1: a cancelled copy kills its check at once.
    signal?.addEventListener(
      'abort',
      () =>
        done(() =>
          reject(new SqliteTransferError('SQLITE_COPY_CANCELLED', 'The copy was cancelled.'))
        ),
      { once: true }
    )
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (out.length < 4096) out += d
    })
    child.once('error', () =>
      done(() =>
        reject(new SqliteTransferError('SQLITE_CHECK_FAILED', VERIFY_TEXT.SQLITE_CHECK_FAILED))
      )
    )
    child.once('close', () =>
      done(() => {
        let m: { ok?: boolean; code?: string; migrations?: number; latest?: string | null } | null =
          null
        try {
          m = JSON.parse(out.trim().split('\n')[0] ?? '')
        } catch {
          m = null
        }
        if (m?.ok) {
          resolve({ integrity: 'ok', migrations: Number(m.migrations), latest: m.latest ?? null })
          return
        }
        const code = (
          m?.code && VERIFY_TEXT[m.code] ? m.code : 'SQLITE_CHECK_FAILED'
        ) as SqliteTransferError['code']
        reject(new SqliteTransferError(code, VERIFY_TEXT[code]))
      })
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
const refusedMarker = (file: string) => `${file}.adopt-refused.json`

/** Why a boot refused a staged copy (review 5 L6): the Hub fails the move with it at once. */
export type SqliteAdoptRefusal =
  | 'SQLITE_STAGED_BAD_MARKER'
  | 'SQLITE_STAGED_MISSING'
  | 'SQLITE_STAGED_CHANGED'
  | 'SQLITE_STAGED_FAILED'

export interface SqliteAdoptRefused {
  move_id: number | null
  code: SqliteAdoptRefusal
  at: string
}

/** What the last boot refused (`<file>.adopt-refused.json`), or null. */
export function adoptRefusedSqliteFile(file: string): SqliteAdoptRefused | null {
  try {
    const r = JSON.parse(readFileSync(refusedMarker(file), 'utf8')) as SqliteAdoptRefused
    return r && typeof r.code === 'string' ? r : null
  } catch {
    return null
  }
}

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

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** L5: a staged copy's path is `<file>.incoming-<uuid>` in the database's own folder, nothing else. */
export function stagedIncomingOk(file: string, incoming: unknown): incoming is string {
  if (typeof incoming !== 'string') return false
  if (dirname(incoming) !== dirname(file)) return false
  const base = basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${base}\\.incoming-${UUID_RE}$`).test(basename(incoming))
}

/** Leave a checked `<file>.incoming-<id>` for the next boot to install (adoptStagedSqliteFile). */
export async function stageSqliteFile(
  file: string,
  info: Omit<StagedSqlite, 'at'> & { incoming: string }
): Promise<void> {
  if (!stagedIncomingOk(file, info.incoming))
    throw new SqliteTransferError(
      'SQLITE_NOT_SQLITE',
      'The staged copy is not where copies are made.'
    )
  // An older staged copy (an earlier pull of the same move) goes.
  const before = readStaged(file)
  if (
    before?.incoming &&
    before.incoming !== info.incoming &&
    stagedIncomingOk(file, before.incoming)
  )
    await unlink(before.incoming).catch(() => {})
  // A refusal of an earlier staged copy no longer applies.
  await unlink(refusedMarker(file)).catch(() => {})
  const tmp = `${stagedMarker(file)}.${randomUUID()}`
  await writeFile(tmp, JSON.stringify({ ...info, at: new Date().toISOString() }), {
    mode: 0o600
  })
  await rename(tmp, stagedMarker(file))
}

/**
 * At boot, holding the file's lock, before anything opens the database: a staged copy whose marker
 * is readable and whose bytes (re-hashed in chunks — the very bytes the check passed before
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
  // L5: a marker naming any other path is refused; only the marker itself is removed then.
  const incoming = info && stagedIncomingOk(file, info.incoming) ? info.incoming : null
  const dropAll = () => {
    for (const f of incoming ? [incoming, marker] : [marker])
      try {
        unlinkSync(f)
      } catch {}
  }
  // L6: say why, for the Hub to read through the hub link (`GET /files/database/adopted`).
  const refuse = (code: SqliteAdoptRefusal): 'refused' => {
    dropAll()
    try {
      const r: SqliteAdoptRefused = {
        move_id: typeof info?.move_id === 'number' ? info.move_id : null,
        code,
        at: new Date().toISOString()
      }
      writeFileSync(refusedMarker(file), JSON.stringify(r), { mode: 0o600 })
    } catch {}
    return 'refused'
  }
  if (!info || typeof info.sha256 !== 'string' || !incoming)
    return refuse('SQLITE_STAGED_BAD_MARKER')
  const writeAdopted = () => {
    writeFileSync(adoptedMarker(file), JSON.stringify(info), { mode: 0o600 })
    for (const f of [marker, refusedMarker(file)])
      try {
        unlinkSync(f)
      } catch {}
  }
  try {
    if (!existsSync(incoming)) {
      // L3: killed between the rename and the marker — the copy may already be in place.
      if (existsSync(file) && fileSumSync(file).sha256 === info.sha256) {
        writeAdopted()
        return 'adopted'
      }
      return refuse('SQLITE_STAGED_MISSING')
    }
    const size = statSync(incoming).size
    if (size > SQLITE_COPY_MAX_BYTES || size !== info.bytes) return refuse('SQLITE_STAGED_CHANGED')
    if (fileSumSync(incoming).sha256 !== info.sha256) return refuse('SQLITE_STAGED_CHANGED')
    for (const extra of ['-wal', '-shm', '-journal'])
      try {
        unlinkSync(`${file}${extra}`)
      } catch {}
    renameSync(incoming, file)
    writeAdopted()
    return 'adopted'
  } catch {
    return refuse('SQLITE_STAGED_FAILED')
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
