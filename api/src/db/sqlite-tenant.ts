// SQLite apps on a Hub shared deployment (hub gap `sqlite`, 0.3.215).
//
// A Hub shared deployment serves SQL Server, Postgres, MySQL and MariaDB apps through their own
// database servers. A SQLite app's database is one FILE, and SQLite allows one writer process
// (db/sqlite.ts point 3), so:
//
//  - Only a one-process deployment serves one: the Hub places a SQLite app only on a Docker shared
//    deployment of size small (one `all` process), and a process that runs a role of a split
//    stack (NIVARO_ROLE) or Nivaro Cloud never opens one (sqliteTenantProblem). A second process
//    that would open the same file anyway (an overlapping rolling update) is refused by the
//    file's `<file>.lock` (claimSqliteFile) until the first lets go.
//  - The file lives in the deployment's uploads volume, in the app's own folder OUTSIDE the
//    stored-files key space: `/app/uploads/app-db/<tenant id>/<file>` (SQLITE_APPS_ROOT, pinned).
//    Under `apps/`
//    (services/storage/app-scope.ts) the raw file route, a storage listing or an orphan sweep could
//    reach it. The Hub names only the file (`app.sqlite`); this process builds the path from the
//    tenant id and refuses anything that would land outside that folder (sqliteTenantPath, and
//    again when the pool opens: assertSqliteTenantPath, symlinks included).
//  - Each app gets its own knex (better-sqlite3, the db/sqlite.ts patches): WAL, a few readers,
//    one writer at a time per FILE (sqliteWriteLockFor), migrations without knex's per-migration
//    transaction. Closing it (a move replacing the file) releases the file lock.
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import knex, { type Knex } from 'knex'
import { isNivaroCloud } from '../services/deployment-mode.js'
import {
  claimSqliteFile,
  forgetSqliteWriteLock,
  holdSqliteFile,
  SQLITE_KNEX_CLIENT,
  sqliteAfterCreate,
  sqliteCompat,
  sqliteDriverProblem,
  sqlitePoolMax
} from './sqlite.js'
import { sweepSqliteLeftovers } from './sqlite-transfer.js'

/**
 * The folder that holds every SQLite app's own folder: pinned to the uploads volume's mount
 * (`/app/uploads/app-db`, the same path a Hub Docker stack gets), independent of
 * STORAGE_LOCAL_ROOT or a files subfolder — a setting that moved it would have every SQLite app
 * reopen in an empty folder. NIVARO_SQLITE_APPS_DIR overrides it for tests and local development
 * only.
 */
export const SQLITE_APPS_ROOT = '/app/uploads/app-db'

/** The file name the Hub gives a SQLite app's database. */
export const SQLITE_APP_FILE = 'app.sqlite'

/** A file name the Hub may name: no folder, no dot first, a SQLite extension. */
export const SQLITE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(sqlite|sqlite3|db)$/

/** A tenant id as the Hub contract allows it (services/tenancy/hub-contract.ts). */
const TENANT_ID_RE = /^[a-z0-9-]{1,64}$/

/** The connections one SQLite app's pool keeps at most (readers; writes take turns). */
export const SQLITE_APP_POOL_MAX = 3

/** Refusals a caller can tell apart (never a path in the message). */
export class SqliteTenantError extends Error {
  readonly code: 'SQLITE_BAD_PATH' | 'SQLITE_FILE_BUSY' | 'SQLITE_NOT_HERE' | 'SQLITE_FILE_MISSING'
  constructor(code: SqliteTenantError['code'], message: string) {
    super(message)
    this.name = 'SqliteTenantError'
    this.code = code
  }
}

/**
 * Why this process may not serve a SQLite app, or null. Nivaro Cloud never does; a process of a
 * split stack (NIVARO_ROLE set: web, worker, importer, exporter, realtime) never does, since its
 * siblings would be second writers; and the optional driver must be there.
 */
export function sqliteTenantProblem(
  env: NodeJS.ProcessEnv = process.env,
  driver: () => string | null = sqliteDriverProblem
): string | null {
  if (isNivaroCloud(env)) return 'Nivaro Cloud does not serve SQLite apps'
  const role = (env.NIVARO_ROLE ?? '').trim()
  if (role)
    return `SQLite apps need a one-process shared deployment (size small); this process runs as NIVARO_ROLE=${role}`
  return driver() ? 'the SQLite driver (better-sqlite3) is not installed in this image' : null
}

/** Where every SQLite app's folder lives (SQLITE_APPS_ROOT), absolute. */
export function sqliteAppsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.NIVARO_SQLITE_APPS_DIR || SQLITE_APPS_ROOT)
}

/**
 * The marker a deployment leaves in an app's folder the one time it makes a NEW database file
 * there (ruling H2): a file that goes missing after that is never made again.
 */
export const SQLITE_CREATED_MARKER = '.created'

/**
 * The database file of tenant `tenantId` named `file`: `<root>/<tenantId>/<file>`. Throws
 * SQLITE_BAD_PATH for a tenant id or a file name that could leave that folder.
 */
export function sqliteTenantPath(
  tenantId: string,
  file: string,
  root: string = sqliteAppsRoot()
): string {
  if (!TENANT_ID_RE.test(tenantId))
    throw new SqliteTenantError('SQLITE_BAD_PATH', 'This app has no usable database folder.')
  if (!SQLITE_FILE_RE.test(file))
    throw new SqliteTenantError(
      'SQLITE_BAD_PATH',
      'The database file name must be a plain file name ending .sqlite, .sqlite3 or .db.'
    )
  const path = resolve(root, tenantId, file)
  assertSqliteTenantPath(path, root)
  return path
}

/**
 * `path` is exactly `<root>/<tenant id>/<file>` (both parts as sqliteTenantPath allows them).
 * Checked again on every pool open, so a path that reached the pool any other way is refused.
 */
export function assertSqliteTenantPath(path: string, root: string = sqliteAppsRoot()): void {
  const base = resolve(root)
  const full = resolve(path)
  const bad = () =>
    new SqliteTenantError('SQLITE_BAD_PATH', 'The database file is outside its app folder.')
  if (full !== path || !full.startsWith(base + sep)) throw bad()
  const parts = full.slice(base.length + 1).split(sep)
  if (parts.length !== 2 || !TENANT_ID_RE.test(parts[0]) || !SQLITE_FILE_RE.test(parts[1]))
    throw bad()
}

/**
 * Make the app's folder, and refuse a folder or file that is a link to somewhere else (the folder
 * must really be `<root>/<tenant id>` once links are followed, the file must not be a link).
 */
export function prepareSqliteFolder(path: string, root: string = sqliteAppsRoot()): void {
  prepareFolder(path, root)
}

function prepareFolder(path: string, root: string): void {
  const base = resolve(root)
  const folder = resolve(path, '..')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const realBase = realpathSync(base)
  const realFolder = realpathSync(folder)
  if (realFolder !== join(realBase, folder.slice(base.length + 1)))
    throw new SqliteTenantError('SQLITE_BAD_PATH', 'The app database folder is a link elsewhere.')
  let link = false
  try {
    link = lstatSync(path).isSymbolicLink()
  } catch {
    // no file yet: SQLite makes it
  }
  if (link)
    throw new SqliteTenantError('SQLITE_BAD_PATH', 'The app database file is a link elsewhere.')
}

/** Release functions of the files this process holds, by path (closeSqliteTenantFile). */
const heldFiles = new Map<string, () => void>()

/** Files a move is replacing now: no pool opens on them meanwhile (withSqliteFileReplaced). */
const replacing = new Set<string>()

/**
 * Run `fn` (close the app's pool, put the copy in place) while no pool may open on `path`: a
 * request or job that asks for the app's database meanwhile gets SQLITE_FILE_BUSY.
 */
export async function withSqliteFileReplaced<T>(path: string, fn: () => Promise<T>): Promise<T> {
  if (replacing.has(path))
    throw new SqliteTenantError('SQLITE_FILE_BUSY', 'This database is already being replaced.')
  replacing.add(path)
  try {
    return await fn()
  } finally {
    replacing.delete(path)
  }
}

/**
 * Open one SQLite app's knex on `path` (already checked by sqliteTenantPath). Takes the file's
 * lock first: another process holding it answers SQLITE_FILE_BUSY (the app tries again; a
 * rolling update's old process lets go when it stops).
 */
export function openSqliteTenantKnex(
  path: string,
  poolMax: number = SQLITE_APP_POOL_MAX,
  root: string = sqliteAppsRoot(),
  opts: { create?: boolean } = {}
): Knex {
  const problem = sqliteTenantProblem()
  if (problem) throw new SqliteTenantError('SQLITE_NOT_HERE', `${problem}.`)
  assertSqliteTenantPath(path, root)
  if (replacing.has(path))
    throw new SqliteTenantError(
      'SQLITE_FILE_BUSY',
      "This app's database is being replaced by a move; trying again shortly."
    )
  prepareFolder(path, root)
  // Ruling H2: a missing file is never silently made into a fresh, writable install. Only a
  // database the Hub placed as NEW (`create`) is made, once, with a marker in its folder; a file
  // missing after that (another node, a volume not mounted, a folder cleaned) is refused.
  const marker = join(resolve(path, '..'), SQLITE_CREATED_MARKER)
  const makeNew = !existsSync(path)
  if (makeNew && (!opts.create || existsSync(marker)))
    throw new SqliteTenantError(
      'SQLITE_FILE_MISSING',
      "This app's database file is missing on this deployment; it is not made again. Restore the file (or move the app here again) before it serves."
    )
  if (!heldFiles.has(path)) {
    const taken = claimSqliteFile(path)
    if (taken)
      throw new SqliteTenantError(
        'SQLITE_FILE_BUSY',
        'Another process still holds this app database (an update in progress); trying again shortly.'
      )
    heldFiles.set(path, holdSqliteFile(path))
  }
  sweepSqliteLeftovers(path)
  if (makeNew) {
    // The file itself is made by the first connection; the marker says it was, once.
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() }), { mode: 0o600 })
  }
  sqliteCompat()
  return knex({
    client: SQLITE_KNEX_CLIENT,
    useNullAsDefault: true,
    connection: { filename: path },
    pool: {
      min: 0,
      max: sqlitePoolMax(Math.min(poolMax, SQLITE_APP_POOL_MAX)),
      afterCreate: sqliteAfterCreate
    },
    // Table rebuilds need foreign keys off, which SQLite ignores inside a transaction (db/sqlite.ts
    // point 5): this app's migrations run without knex's per-migration transaction.
    migrations: { disableTransactions: true }
  })
}

/** Let go of an app's database file: its lock file and write lock (the knex is destroyed first). */
export function releaseSqliteTenantFile(path: string): void {
  heldFiles.get(path)?.()
  heldFiles.delete(path)
  forgetSqliteWriteLock(path)
}

/** Is this process holding the app database at `path`? */
export function holdsSqliteTenantFile(path: string): boolean {
  return heldFiles.has(path)
}
