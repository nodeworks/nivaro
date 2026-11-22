// Hub databases (phase 3): one database per environment, made by the Hub on an automatic server,
// requested from a DBA on a manual one, or adopted as it already is.
//
// Secrets: the connection (sealed JSON) holds the app login's password and is only ever answered
// as the mask; openDatabaseConnection is for the creation runner and never leaves the API. Every
// error and stored check text passes scrubText with the passwords and logins in play, on top of
// the provisioners' own scrubbing.
//
// Ownership (rulings P3-12, P3-18, fail closed): the provisioners write to a database or login
// only when told it is this record's own (`ownedDatabase` / `ownedLogin`). Those flags come ONLY
// from the markers `made.database` / `made.login`, stored inside the sealed connection right after
// ensureDatabase / ensureLogin answered 'created', together with `made.at` = the engine, host and
// port they were made on (stored-connection.ts). A marker counts only while the server still
// points at `made.at` (else SERVER_MOVED); a marker without `made.at` never counts. Never from the
// row's status, created_by_hub or a matching name. A failed creation therefore never gains drop
// rights over a login or database it did not make.
//
// One writer per row: provisioning and delete hold nvr:hub:db:<id> (db-lock.ts), and every status
// write is conditional on the status it expects, so a late failure never overwrites `ready`.
// Delete-with-drop fences the row (`dropping`) in a transaction BEFORE it drops anything;
// attachDatabase and openDatabaseConnection refuse a fenced row.

import type { Knex } from 'knex'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { HubSecretError, maskSecret } from '../secrets.js'
import type { HubDbCode } from './codes.js'
import { connectionFromInput, type HubDbConnection, type HubDbEngine } from './connection.js'
import { withDbLock } from './db-lock.js'
import { generatePassword } from './names.js'
import { assertDbName, assertLoginName, run } from './provision-common.js'
import {
  type DbCheck,
  type DbCheckState,
  ProvisionError,
  provisionerFor,
  type Secrets,
  scrubText,
  withAppKnex,
  withServerKnex
} from './provisioner.js'
import { getServerRow, HubDbError, type HubDbServerRow, openAdminSecret } from './servers.js'
import {
  type DbPlace,
  normPort,
  openStoredConnection,
  placeOf,
  plainConnection,
  type StoredConnection,
  samePlace,
  sealStoredConnection
} from './stored-connection.js'

export { HubDbError } from './servers.js'

/** `dropping` = fenced by a delete-with-drop: never attached, never opened. */
export type HubDatabaseStatus = 'requested' | 'creating' | 'ready' | 'failed' | 'dropping'

/** A stored check: a real DbCheck, or a failure the Hub recorded (`code`, state `error`). */
export type HubDbCheck = Omit<DbCheck, 'state'> & { state: DbCheckState | 'error'; code?: string }

export interface HubDatabase {
  id: number
  server_id: number | null
  server_name: string | null
  engine: HubDbEngine
  host: string
  port: number | null
  database_name: string
  login_name: string | null
  status: HubDatabaseStatus
  adopted: boolean
  created_by_hub: boolean
  last_check: HubDbCheck | null
  checked_at: string | null
  /** Only ever the mask. */
  connection: string | null
  environment: { id: number; app_id: number; app_key: string; env_key: string } | null
}

/** The value nivaro_hub_environments.db_ref holds for a database row. */
export const dbRef = (id: number): string => `hub-db:${id}`

interface DbRow {
  id: number
  server_id: number | null
  engine: HubDbEngine
  host: string
  port: number | null
  database_name: string
  login_name: string | null
  connection: string | null
  status: HubDatabaseStatus
  adopted: boolean
  created_by_hub: boolean
  last_check: HubDbCheck | null
  checked_at: string | null
}

const TABLE = 'nivaro_hub_databases'
const bool = (v: unknown) => v === true || Number(v) === 1
const now = () => new Date()

function parseCheck(v: unknown): HubDbCheck | null {
  if (typeof v !== 'string' || !v) return null
  try {
    const o = JSON.parse(v)
    return o && typeof o === 'object' && typeof o.state === 'string' ? (o as HubDbCheck) : null
  } catch {
    return null
  }
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

function toRow(r: Record<string, unknown>): DbRow {
  return {
    id: Number(r.id),
    server_id: r.server_id === null || r.server_id === undefined ? null : Number(r.server_id),
    engine: r.engine as HubDbEngine,
    host: String(r.host),
    port: r.port === null || r.port === undefined ? null : Number(r.port),
    database_name: String(r.database_name),
    login_name: (r.login_name as string | null) ?? null,
    connection: (r.connection as string | null) ?? null,
    status: r.status as HubDatabaseStatus,
    adopted: bool(r.adopted),
    created_by_hub: bool(r.created_by_hub),
    last_check: parseCheck(r.last_check),
    checked_at: isoOrNull(r.checked_at)
  }
}

async function getRow(id: number, k: Knex = db): Promise<DbRow | null> {
  if (!Number.isInteger(id)) return null
  const r = (await k(TABLE).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? toRow(r) : null
}

type EnvLink = NonNullable<HubDatabase['environment']>

/** Environments pointing at database rows, by row id. */
async function environmentsFor(k: Knex, ids?: number[]): Promise<Map<number, EnvLink>> {
  const q = k('nivaro_hub_environments as e')
    .leftJoin('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .select('e.id', 'e.app_id', 'e.key as env_key', 'a.key as app_key', 'e.db_ref')
    .orderBy('e.id')
  if (ids) q.whereIn('e.db_ref', ids.map(dbRef))
  else q.where('e.db_ref', 'like', 'hub-db:%')
  const out = new Map<number, EnvLink>()
  for (const r of (await q) as Array<Record<string, unknown>>) {
    const m = /^hub-db:(\d+)$/.exec(String(r.db_ref ?? ''))
    if (!m) continue
    const id = Number(m[1])
    if (out.has(id)) continue
    out.set(id, {
      id: Number(r.id),
      app_id: Number(r.app_id),
      app_key: String(r.app_key ?? ''),
      env_key: String(r.env_key)
    })
  }
  return out
}

function publicDatabase(row: DbRow, serverName: string | null, env: EnvLink | null): HubDatabase {
  return {
    id: row.id,
    server_id: row.server_id,
    server_name: serverName,
    engine: row.engine,
    host: row.host,
    port: row.port,
    database_name: row.database_name,
    login_name: row.login_name,
    status: row.status,
    adopted: row.adopted,
    created_by_hub: row.created_by_hub,
    last_check: row.last_check,
    checked_at: row.checked_at,
    connection: maskSecret(row.connection),
    environment: env
  }
}

export async function listDatabases(): Promise<HubDatabase[]> {
  const rows = ((await db(TABLE).select('*').orderBy('id')) as Record<string, unknown>[]).map(toRow)
  const servers = new Map<number, string>()
  for (const s of (await db('nivaro_hub_db_servers').select('id', 'name')) as Array<{
    id: number
    name: string
  }>)
    servers.set(Number(s.id), String(s.name))
  const envs = await environmentsFor(db)
  return rows.map((r) =>
    publicDatabase(
      r,
      r.server_id !== null ? (servers.get(r.server_id) ?? null) : null,
      envs.get(r.id) ?? null
    )
  )
}

async function answer(id: number, k: Knex = db): Promise<HubDatabase | null> {
  const row = await getRow(id, k)
  if (!row) return null
  const server =
    row.server_id !== null
      ? ((await k('nivaro_hub_db_servers').where({ id: row.server_id }).first('name')) as
          | { name: string }
          | undefined)
      : undefined
  const envs = await environmentsFor(k, [id])
  return publicDatabase(row, server ? String(server.name) : null, envs.get(id) ?? null)
}

export async function getDatabase(id: number): Promise<HubDatabase | null> {
  return answer(id)
}

async function mustAnswer(id: number, k: Knex = db): Promise<HubDatabase> {
  const a = await answer(id, k)
  if (!a) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  return a
}

// ─── Sealed connection ───────────────────────────────────────────────────────

function openStored(row: DbRow): StoredConnection | null {
  try {
    return openStoredConnection(row.connection)
  } catch (err) {
    if (err instanceof HubSecretError && err.code === 'HUB_SECRET_UNREADABLE')
      throw new HubDbError('CONNECTION_UNREADABLE', 'The stored connection cannot be read.', 500)
    throw err
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

const PROVISION_STATUS: Record<string, number> = {
  ENGINE_NOT_PROVISIONABLE: 400,
  UNSAFE_IDENTIFIER: 400,
  RESERVED_NAME: 400,
  LOGIN_EXISTS: 409,
  DATABASE_EXISTS: 409,
  NOT_OWNED: 409,
  DB_ERROR: 502
}

/** Any error as a HubDbError whose message is scrubbed of `secrets` (a fresh object). */
function toHubDbError(err: unknown, secrets: Secrets): HubDbError {
  const message = scrubText(err, secrets)
  if (err instanceof HubDbError) return new HubDbError(err.code, message, err.status)
  if (err instanceof ProvisionError)
    return new HubDbError(err.code, message, PROVISION_STATUS[err.code] ?? 502)
  if (err instanceof HubSecretError) return new HubDbError(err.code as HubDbCode, message, 500)
  return new HubDbError('DB_ERROR', message, 502)
}

function scrubCheck(c: DbCheck, secrets: Secrets): DbCheck {
  return { ...c, text: scrubText(c.text, secrets) }
}

/** A refusal code for a check a caller cannot accept. */
function checkRefusal(state: DbCheck['state']): HubDbCode {
  switch (state) {
    case 'unreachable':
      return 'DATABASE_UNREACHABLE'
    case 'too_old':
      return 'DATABASE_TOO_OLD'
    case 'no_rights':
      return 'DATABASE_NO_RIGHTS'
    case 'foreign':
      return 'DATABASE_NOT_NIVARO'
    default:
      return 'DATABASE_NOT_EMPTY'
  }
}

const OWNERSHIP_CODES = new Set(['DATABASE_EXISTS', 'LOGIN_EXISTS', 'NOT_OWNED'])

/**
 * A failure the Hub records as the row's last check (the table has no error column). It carries
 * the code; the state is `foreign` for a refusal over something not this record's own,
 * `unreachable` only for a connectivity refusal, else the neutral `error`. Text already scrubbed.
 */
function failureCheck(code: string, text: string, prefix = 'Provisioning failed'): HubDbCheck {
  return {
    state: OWNERSHIP_CODES.has(code)
      ? 'foreign'
      : code === 'DATABASE_UNREACHABLE'
        ? 'unreachable'
        : 'error',
    ok: false,
    version: null,
    migrations: null,
    last_migration: null,
    text: `${prefix}: ${text}`.slice(0, 300),
    at: now().toISOString(),
    code
  }
}

/** A conditional status write that found the row in another status. */
function stateChanged(): HubDbError {
  return new HubDbError(
    'STATE_CHANGED',
    'The database changed while this ran (another action finished first). Reload and try again.'
  )
}

// ─── Duplicates ──────────────────────────────────────────────────────────────

/** Rows recording this host + database (case-insensitive), except `exceptId`. */
async function recordedAt(
  host: string,
  database: string,
  exceptId: number | null,
  k: Knex = db
): Promise<DbRow[]> {
  const rows = (
    (await k(TABLE)
      .whereRaw('LOWER(database_name) = ?', [database.toLowerCase()])
      .select('*')) as Record<string, unknown>[]
  ).map(toRow)
  return rows.filter((r) => r.id !== exceptId && r.host.toLowerCase() === host.toLowerCase())
}

/** Another row whose sealed connection reports the same server identity (P3-19). */
async function identityTaken(
  identity: string | null,
  exceptId: number | null,
  k: Knex
): Promise<boolean> {
  if (!identity) return false
  const rows = (await k(TABLE).whereNotNull('connection').select('id', 'connection')) as Array<{
    id: number
    connection: string
  }>
  for (const r of rows) {
    if (Number(r.id) === exceptId) continue
    try {
      if (openStoredConnection(r.connection)?.identity === identity) return true
    } catch {
      // an unreadable row cannot be compared; its host + name are still checked
    }
  }
  return false
}

async function refuseDuplicate(
  conn: { host: string; database: string },
  identity: string | null,
  exceptId: number | null,
  k: Knex
): Promise<void> {
  if (
    (await recordedAt(conn.host, conn.database, exceptId, k)).length ||
    (await identityTaken(identity, exceptId, k))
  )
    throw new HubDbError(
      'DATABASE_IN_USE',
      'Another Hub record already uses this database on this server.'
    )
}

// Read-only: which server and database the connection really reached (an alias, an IP and a
// name for the same server all resolve to one identity). Fixed statements, no input.
const IDENTITY_SQL: Record<HubDbEngine, string> = {
  mssql: 'SELECT CAST(@@SERVERNAME AS nvarchar(256)) AS s, CAST(NULL AS int) AS p, DB_NAME() AS d',
  pg: "SELECT COALESCE(host(inet_server_addr()), '') AS s, inet_server_port() AS p, current_database() AS d",
  mysql2: 'SELECT @@hostname AS s, @@port AS p, DATABASE() AS d',
  mariadb: 'SELECT @@hostname AS s, @@port AS p, DATABASE() AS d'
}

/** `engine|server|port|database`, lower-cased; null when it cannot be read. */
async function readIdentity(conn: HubDbConnection, k: Knex): Promise<string | null> {
  try {
    const [r] = await run<{ s: unknown; p: unknown; d: unknown }>(k, IDENTITY_SQL[conn.engine])
    const server = String(r?.s ?? '').trim() || conn.host
    const port = r?.p != null && r.p !== '' ? Number(r.p) : normPort(conn.engine, conn.port)
    const database = String(r?.d ?? '').trim() || conn.database
    return `${conn.engine}|${server}|${port}|${database}`.toLowerCase()
  } catch {
    return null
  }
}

/** checkApp as the connection's own login, plus its server identity when it connected. */
async function runCheck(
  conn: HubDbConnection,
  extra: Secrets = {}
): Promise<{ check: DbCheck; identity: string | null }> {
  const secrets: Secrets = {
    passwords: [conn.password, ...(extra.passwords ?? [])],
    logins: [conn.user, ...(extra.logins ?? [])]
  }
  try {
    const p = provisionerFor(conn.engine)
    const out = await withAppKnex(conn, async (k) => {
      const check = await p.checkApp(k)
      const identity = check.state === 'unreachable' ? null : await readIdentity(conn, k)
      return { check, identity }
    })
    return { check: scrubCheck(out.check, secrets), identity: out.identity }
  } catch (err) {
    throw toHubDbError(err, secrets)
  }
}

// ─── Record ──────────────────────────────────────────────────────────────────

/**
 * Records the database an environment will use. Automatic server: status `creating`, the app
 * login's password generated and sealed NOW, so every retry reuses it. Manual server: status
 * `requested`, no connection until the DBA's is entered (setConnection). Nothing touches the
 * server here (so there is no identity yet: provisionDatabase checks it before `ready`). `trx`
 * lets the creation planner record inside its own transaction.
 */
export async function recordDatabase(o: {
  server: HubDbServerRow
  database_name: string
  login_name: string
  by: string | null
  trx?: Knex
}): Promise<HubDatabase> {
  const { server } = o
  try {
    assertDbName(server.engine, o.database_name)
  } catch {
    throw new HubDbError(
      'DATABASE_NAME_INVALID',
      'The database name must be lower-case letters, digits and _ (2–63, starting with a letter) and not a reserved name.',
      400
    )
  }
  try {
    assertLoginName(server.engine, o.login_name)
  } catch {
    throw new HubDbError(
      'LOGIN_NAME_INVALID',
      'The login name must be lower-case letters, digits and _ (starting with a letter), short enough for the engine and not a reserved name.',
      400
    )
  }

  const automatic = server.provision_mode === 'automatic'
  let connection: string | null = null
  if (automatic) {
    const stored: StoredConnection = {
      engine: server.engine,
      host: server.host,
      port: server.port,
      database: o.database_name,
      user: o.login_name,
      password: generatePassword(),
      ssl_mode: server.ssl_mode,
      trust_server_cert: server.trust_server_cert,
      made: {}
    }
    try {
      connection = sealStoredConnection(stored)
    } catch (err) {
      throw toHubDbError(err, { passwords: [stored.password] })
    }
  }

  const insert = async (k: Knex) => {
    if ((await recordedAt(server.host, o.database_name, null, k)).length)
      throw new HubDbError(
        'DATABASE_RECORDED',
        'The Hub already records a database with this name on this host.'
      )
    const id = await insertReturningId(k, TABLE, {
      server_id: server.id,
      engine: server.engine,
      host: server.host,
      port: server.port,
      database_name: o.database_name,
      login_name: o.login_name,
      connection,
      status: automatic ? 'creating' : 'requested',
      adopted: false,
      created_by_hub: automatic,
      created_by: o.by,
      created_at: now(),
      updated_at: now()
    })
    return mustAnswer(Number(id), k)
  }
  return o.trx ? insert(o.trx) : db.transaction(insert)
}

// ─── Provision ───────────────────────────────────────────────────────────────

/**
 * Makes an automatic row's database: ensureLogin → ensureDatabase → ensureOwner, then checkApp as
 * the new login must answer `empty` (and no other row may report the same server identity) →
 * status `ready`. Idempotent: a retry reuses the sealed password and the made_* markers; a `ready`
 * row is answered as it is. Holds the row's lock. Any failure → status `failed` (only from
 * `creating`) with the scrubbed reason as the last check, rethrown as a HubDbError.
 */
export async function provisionDatabase(
  id: number,
  log: (line: string) => void
): Promise<HubDatabase> {
  const first = await getRow(id)
  if (!first) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  if (first.status === 'ready') return mustAnswer(id)
  return withDbLock(id, () => provisionLocked(id, log))
}

/** A refusal whose failed status and check are already stored. */
class StoredFailure extends HubDbError {}

async function provisionLocked(id: number, log: (line: string) => void): Promise<HubDatabase> {
  const row = await getRow(id)
  if (!row) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  if (row.status === 'ready') return mustAnswer(id)
  if (row.status === 'dropping')
    throw new HubDbError('DATABASE_DROPPING', 'This database is being dropped.')
  if (!row.created_by_hub || row.adopted || row.status === 'requested')
    throw new HubDbError(
      'NOT_AUTOMATIC',
      'Only a database the Hub creates on an automatic server can be provisioned.'
    )
  const server = row.server_id !== null ? await getServerRow(row.server_id) : null
  if (server?.provision_mode !== 'automatic')
    throw new HubDbError(
      'NOT_AUTOMATIC',
      'The database server is gone or no longer automatic; provisioning is not possible.'
    )
  if (!row.login_name)
    throw new HubDbError('LOGIN_NAME_INVALID', 'The database row has no login name.', 400)

  let secrets: Secrets = {}
  let started = false
  try {
    let admin: { user: string; password: string } | null
    let stored: StoredConnection | null
    try {
      admin = openAdminSecret(server)
      stored = openStored(row)
    } catch (err) {
      throw toHubDbError(err, {})
    }
    if (!admin)
      throw new HubDbError(
        'ADMIN_REQUIRED',
        'The server has no provisioning login saved; enter it on the server first.'
      )
    if (!stored)
      throw new HubDbError('CONNECTION_UNREADABLE', 'The database row has no sealed login.', 500)
    secrets = { passwords: [admin.password, stored.password], logins: [admin.user] }

    // The server must still be where this row's login and markers live (P3-18).
    const here = placeOf(server)
    if (!samePlace(placeOf(stored), here) || (stored.made?.at && !samePlace(stored.made.at, here)))
      throw new HubDbError(
        'SERVER_MOVED',
        'The database server now points somewhere else than where this database was made. Nothing was changed; point the server back or detach this database.'
      )

    if (
      !(await db(TABLE)
        .where({ id })
        .whereIn('status', ['creating', 'failed'])
        .update({ status: 'creating', updated_at: now() }))
    )
      throw stateChanged()
    started = true
    return await runProvision(row, server, admin, stored, here, secrets, log)
  } catch (err) {
    const e = toHubDbError(err, secrets)
    if (started && !(err instanceof StoredFailure)) {
      // Only a row still `creating` (ours) becomes failed; never a `ready` or `dropping` one.
      // A failing write here never replaces the scrubbed error.
      try {
        await db(TABLE)
          .where({ id, status: 'creating' })
          .update({
            status: 'failed',
            last_check: JSON.stringify(failureCheck(e.code, e.message)),
            checked_at: now(),
            updated_at: now()
          })
      } catch {
        // keep `e`
      }
      log(`Database ${row.database_name} failed: ${e.message}`)
    }
    throw e
  }
}

async function runProvision(
  row: DbRow,
  server: HubDbServerRow,
  admin: { user: string; password: string },
  stored: StoredConnection,
  here: DbPlace,
  secrets: Secrets,
  log: (line: string) => void
): Promise<HubDatabase> {
  const id = row.id
  const name = row.database_name
  const login = row.login_name as string
  // Markers count only when they carry the place they were made on (fail closed).
  const atKnown = !!stored.made?.at
  const made = {
    database: atKnown && stored.made?.database === true,
    login: atKnown && stored.made?.login === true
  }
  const current: StoredConnection = { ...stored }
  const writeMarkers = async () => {
    current.made = { ...made, at: here }
    if (
      !(await db(TABLE)
        .where({ id, status: 'creating' })
        .update({ connection: sealStoredConnection(current), updated_at: now() }))
    )
      throw stateChanged()
  }

  log(`Creating database ${name} on ${server.name}`)
  const p = provisionerFor(server.engine, { user_host: server.user_host })

  await withServerKnex(server, admin, async (k) => {
    // A database of that name that this record did not make: refuse before any login is made.
    if (!made.database && (await p.databaseExists(k, name)))
      throw new ProvisionError(
        'DATABASE_EXISTS',
        'A database with this name already exists on the server and was not made by the Hub for this record'
      )

    // ORDER MATTERS. ensureLogin runs first because it refuses a login this record did not make
    // (LOGIN_EXISTS unless ownedLogin). ensureOwner later writes on the login's behalf (SQL Server
    // CREATE USER FOR LOGIN + db_owner, Postgres OWNER TO, MySQL GRANT ALL TO); those login-side
    // writes are only safe because the login is proven ours by then.
    const l = await p.ensureLogin(k, login, stored.password, { ownedLogin: made.login })
    if (l === 'created') {
      made.login = true
      await writeMarkers() // right after 'created': the retry may then reuse it
    }
    log(l === 'created' ? `Login ${login} created` : `Login ${login}: password set again`)

    const d = await p.ensureDatabase(k, name, {
      collation: server.collation,
      owner: login,
      ownedDatabase: made.database
    })
    if (d === 'created') {
      made.database = true
      await writeMarkers()
    }
    log(d === 'created' ? `Database ${name} created` : `Database ${name} already made`)

    await p.ensureOwner(k, name, login, { ownedDatabase: made.database })
    log(`Database ${name} handed to ${login}`)
  })

  const { check, identity } = await runCheck(plainConnection(stored), secrets)
  const failWith = async (record: HubDbCheck, code: HubDbCode, text: string) => {
    try {
      await db(TABLE)
        .where({ id, status: 'creating' })
        .update({
          status: 'failed',
          last_check: JSON.stringify(record),
          checked_at: now(),
          updated_at: now()
        })
    } catch {
      // keep the refusal
    }
    log(`Database ${name} check: ${text}`)
    return new StoredFailure(code, text)
  }
  if (check.state !== 'empty') {
    const code =
      check.state === 'nivaro' || check.state === 'foreign'
        ? 'DATABASE_NOT_EMPTY'
        : checkRefusal(check.state)
    throw await failWith({ ...check, code }, code, check.text)
  }

  const ready = await db.transaction(async (trx) => {
    if (await identityTaken(identity, id, trx)) return false
    current.identity = identity
    const n = await trx(TABLE)
      .where({ id, status: 'creating' })
      .update({
        status: 'ready',
        connection: sealStoredConnection(current),
        last_check: JSON.stringify(check),
        checked_at: now(),
        updated_at: now()
      })
    if (!n) throw stateChanged()
    return true
  })
  if (!ready) {
    const text = 'Another Hub record already uses this database on this server.'
    throw await failWith(failureCheck('DATABASE_IN_USE', text), 'DATABASE_IN_USE', text)
  }
  log(`Database ${name} is ready`)
  return mustAnswer(id)
}

// ─── Manual: the DBA's connection ────────────────────────────────────────────

function parseConnection(input: unknown): HubDbConnection {
  const parsed = connectionFromInput(input)
  if (!parsed.ok) throw new HubDbError('BAD_CONNECTION', parsed.message, 400)
  return parsed.conn
}

const isManual = (row: DbRow) => !row.created_by_hub && !row.adopted

/**
 * The connection a DBA made for a requested (or failed) manual row: checked, then — in one
 * transaction with the duplicate check — sealed, and `ready` only when the database is empty. Any
 * other check keeps the row's status and stores the check.
 */
export async function setConnection(
  id: number,
  input: unknown
): Promise<{ db: HubDatabase; check: DbCheck }> {
  const row = await getRow(id)
  if (!row) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  if (!isManual(row))
    throw new HubDbError(
      'NOT_MANUAL',
      'Only a database requested from a DBA takes a connection; the Hub manages this one itself.'
    )
  if (row.status !== 'requested' && row.status !== 'failed')
    throw new HubDbError('NOT_WAITING', 'This database already has a working connection.')
  const conn = parseConnection(input)
  if (conn.engine !== row.engine)
    throw new HubDbError(
      'ENGINE_MISMATCH',
      `The connection is for ${conn.engine}, the database was requested on ${row.engine}.`,
      400
    )
  await refuseDuplicate(conn, null, id, db)

  const { check, identity } = await runCheck(conn)
  let sealed: string
  try {
    sealed = sealStoredConnection({ ...conn, identity })
  } catch (err) {
    throw toHubDbError(err, { passwords: [conn.password] })
  }
  await db.transaction(async (trx) => {
    await refuseDuplicate(conn, identity, id, trx)
    const n = await trx(TABLE)
      .where({ id, status: row.status })
      .update({
        host: conn.host,
        port: conn.port,
        database_name: conn.database,
        login_name: conn.user,
        connection: sealed,
        status: check.state === 'empty' ? 'ready' : row.status,
        last_check: JSON.stringify(check),
        checked_at: now(),
        updated_at: now()
      })
    if (!n) throw stateChanged()
  })
  return { db: await mustAnswer(id), check }
}

/**
 * Check now: connects as the stored login and stores the result. A waiting manual row whose
 * database is now empty becomes `ready`; other rows keep their status. Every write is
 * conditional on the status read, so it never undoes a concurrent change.
 */
export async function checkDatabase(id: number): Promise<DbCheck> {
  const row = await getRow(id)
  if (!row) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  if (row.status === 'dropping')
    throw new HubDbError('DATABASE_DROPPING', 'This database is being dropped.')
  let opened: StoredConnection | null
  try {
    opened = openStored(row)
  } catch (err) {
    throw toHubDbError(err, {})
  }
  if (!opened)
    throw new HubDbError('NO_CONNECTION', 'No connection is saved for this database yet.')
  const stored = opened
  const { check, identity } = await runCheck(plainConnection(stored))
  const becomesReady =
    isManual(row) &&
    (row.status === 'requested' || row.status === 'failed') &&
    check.state === 'empty'
  await db.transaction(async (trx) => {
    const ready = becomesReady && !(await identityTaken(identity, id, trx))
    await trx(TABLE)
      .where({ id, status: row.status })
      .update({
        ...(ready
          ? { status: 'ready', connection: sealStoredConnection({ ...stored, identity }) }
          : {}),
        last_check: JSON.stringify(check),
        checked_at: now(),
        updated_at: now()
      })
  })
  return check
}

// ─── Adopt ───────────────────────────────────────────────────────────────────

/**
 * Records a database as it already is. Never provisions: checkApp only, and only an empty
 * database or an existing Nivaro install is accepted (`foreign` → DATABASE_NOT_NIVARO). The
 * duplicate checks (host + name, server identity) and the insert run in one transaction.
 */
export async function adoptDatabase(input: unknown, by: string | null): Promise<HubDatabase> {
  const conn = parseConnection(input)
  await refuseDuplicate(conn, null, null, db)
  const { check, identity } = await runCheck(conn)
  if (check.state !== 'empty' && check.state !== 'nivaro')
    throw new HubDbError(checkRefusal(check.state), check.text)

  const here = placeOf(conn)
  const servers = (await db('nivaro_hub_db_servers')
    .where({ engine: conn.engine })
    .select('id', 'engine', 'host', 'port')) as Array<{
    id: number
    engine: HubDbEngine
    host: string
    port: number | null
  }>
  const server = servers.find((s) => samePlace(placeOf(s), here))
  let sealed: string
  try {
    sealed = sealStoredConnection({ ...conn, identity })
  } catch (err) {
    throw toHubDbError(err, { passwords: [conn.password] })
  }
  return db.transaction(async (trx) => {
    await refuseDuplicate(conn, identity, null, trx)
    const id = await insertReturningId(trx, TABLE, {
      server_id: server ? Number(server.id) : null,
      engine: conn.engine,
      host: conn.host,
      port: conn.port,
      database_name: conn.database,
      login_name: conn.user,
      connection: sealed,
      status: 'ready',
      adopted: true,
      created_by_hub: false,
      last_check: JSON.stringify(check),
      checked_at: now(),
      created_by: by,
      created_at: now(),
      updated_at: now()
    })
    return mustAnswer(Number(id), trx)
  })
}

// ─── Attach ──────────────────────────────────────────────────────────────────

/**
 * Points an environment at a database row (sets its db_ref) — the only way the Hub attaches.
 * The row is judged again inside the transaction (never from an earlier read): the conditional
 * UPDATE on the database row takes its row lock and refuses a `dropping` (fenced) row — and,
 * with `expect`, any status not listed (DATABASE_NOT_READY) — so an attach and a
 * delete-with-drop's fence never both succeed. Pass the creation's `trx`; without one it runs
 * in its own transaction.
 */
export async function attachDatabase(
  id: number,
  envId: number,
  trx?: Knex,
  opts: { expect?: HubDatabaseStatus[] } = {}
): Promise<void> {
  const go = async (k: Knex) => {
    const q = k(TABLE).where({ id }).whereNot({ status: 'dropping' })
    if (opts.expect) q.whereIn('status', opts.expect)
    const n = await q.update({ updated_at: now() })
    if (!n) {
      const row = (await k(TABLE).where({ id }).first('status')) as { status: string } | undefined
      if (row?.status === 'dropping')
        throw new HubDbError('DATABASE_DROPPING', 'This database is being dropped.')
      if (row)
        throw new HubDbError(
          'DATABASE_NOT_READY',
          `The database is ${row.status}: only a ${opts.expect?.join(' or ')} database can be used.`
        )
      throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
    }
    if (
      await k('nivaro_hub_environments')
        .where({ db_ref: dbRef(id) })
        .whereNot({ id: envId })
        .first('id')
    )
      throw new HubDbError('IN_USE', 'Another environment already uses this database.')
    await k('nivaro_hub_environments')
      .where({ id: envId })
      .update({ db_ref: dbRef(id), updated_at: now() })
  }
  if (trx) await go(trx)
  else await db.transaction(go)
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function attached(id: number, k: Knex): Promise<boolean> {
  return !!(await k('nivaro_hub_environments')
    .where({ db_ref: dbRef(id) })
    .first('id'))
}

/**
 * Detach (default): the Hub record and its sealed connection go; the database stays. `drop: true`
 * also drops the database and the login on the server, only for a row the Hub made on a server
 * that is still automatic and still where the markers were made, with no environment attached,
 * and only what its markers say it made.
 *
 * Holds the row's lock (PROVISION_RUNNING while provisioning runs). A drop first fences the row
 * (`dropping`, conditional on the status read, attachment re-checked) in a transaction, and only
 * after that commit touches the server. A drop that fails leaves the row fenced (`dropping`, the
 * failure as its last check), so the leftovers stay on record as Hub-made; a later delete with
 * drop retries it.
 */
export async function deleteDatabase(
  id: number,
  o: { confirm: unknown; drop: boolean }
): Promise<{ dropped: boolean }> {
  const first = await getRow(id)
  if (!first) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  if (o.confirm !== first.database_name)
    throw new HubDbError('CONFIRM_REQUIRED', 'Type the database name to confirm.', 400)
  return withDbLock(id, () => (o.drop ? dropLocked(id) : detachLocked(id)))
}

async function detachLocked(id: number): Promise<{ dropped: boolean }> {
  await db.transaction(async (trx) => {
    const row = await getRow(id, trx)
    if (!row) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
    // Row lock first (conditional on what was read), then the attachment re-check.
    if (!(await trx(TABLE).where({ id, status: row.status }).update({ updated_at: now() })))
      throw stateChanged()
    if (await attached(id, trx))
      throw new HubDbError('IN_USE', 'An environment uses this database; detach it there first.')
    await trx(TABLE).where({ id }).del()
  })
  return { dropped: false }
}

async function dropLocked(id: number): Promise<{ dropped: boolean }> {
  const row = await getRow(id)
  if (!row) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  let stored: StoredConnection | null = null
  try {
    stored = openStored(row)
  } catch (err) {
    throw toHubDbError(err, {})
  }
  const made = stored?.made ?? {}
  const server = row.server_id !== null ? await getServerRow(row.server_id) : null
  if (
    !row.created_by_hub ||
    row.adopted ||
    server?.provision_mode !== 'automatic' ||
    !(made.database || made.login) ||
    !made.at
  )
    throw new HubDbError(
      'DROP_NOT_ALLOWED',
      'The Hub drops only a database or login it created itself on an automatic server. Detach instead.'
    )
  if (!samePlace(made.at, placeOf(server)))
    throw new HubDbError(
      'SERVER_MOVED',
      'The database server now points somewhere else than where this database was made. Nothing was dropped.'
    )
  let admin: { user: string; password: string } | null
  try {
    admin = openAdminSecret(server)
  } catch (err) {
    throw toHubDbError(err, {})
  }
  if (!admin)
    throw new HubDbError(
      'ADMIN_REQUIRED',
      'The server has no provisioning login saved; enter it on the server first.'
    )

  // Fence first: from here on nobody may attach or open it.
  await db.transaction(async (trx) => {
    if (
      !(await trx(TABLE)
        .where({ id, status: row.status })
        .update({ status: 'dropping', updated_at: now() }))
    )
      throw stateChanged()
    if (await attached(id, trx))
      throw new HubDbError('IN_USE', 'An environment uses this database; detach it there first.')
  })

  const secrets: Secrets = { passwords: [admin.password, stored?.password], logins: [admin.user] }
  try {
    const p = provisionerFor(server.engine, { user_host: server.user_host })
    await withServerKnex(server, admin, (k) =>
      p.drop(k, row.database_name, row.login_name, {
        ownedDatabase: made.database === true,
        ownedLogin: made.login === true
      })
    )
  } catch (err) {
    const e = toHubDbError(err, secrets)
    try {
      await db(TABLE)
        .where({ id, status: 'dropping' })
        .update({
          last_check: JSON.stringify(failureCheck(e.code, e.message, 'Drop failed')),
          checked_at: now(),
          updated_at: now()
        })
    } catch {
      // keep `e`
    }
    throw e
  }
  await db(TABLE).where({ id, status: 'dropping' }).del()
  return { dropped: true }
}

// ─── Runner only ─────────────────────────────────────────────────────────────

/** The ready database's connection, for the creation runner. Never answered over the API. */
export async function openDatabaseConnection(id: number): Promise<HubDbConnection> {
  const row = await getRow(id)
  if (!row) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  if (row.status !== 'ready') throw new HubDbError('NOT_READY', 'The database is not ready yet.')
  let stored: StoredConnection | null
  try {
    stored = openStored(row)
  } catch (err) {
    throw toHubDbError(err, {})
  }
  if (!stored) throw new HubDbError('NO_CONNECTION', 'No connection is saved for this database.')
  return plainConnection(stored)
}
