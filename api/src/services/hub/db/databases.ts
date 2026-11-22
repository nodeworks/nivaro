// Hub databases (phase 3): one database per environment, made by the Hub on an automatic server,
// requested from a DBA on a manual one, or adopted as it already is.
//
// Secrets: the connection (sealed JSON) holds the app login's password and is only ever answered
// as the mask; openDatabaseConnection is for the creation runner and never leaves the API. Every
// error and stored check text passes scrubText with the passwords and logins in play, on top of
// the provisioners' own scrubbing.
//
// Ownership (ruling P3-12, fail closed): the provisioners write to a database or login only when
// told it is this record's own (`ownedDatabase` / `ownedLogin`). Those flags come ONLY from the
// markers `made.database` / `made.login`, stored inside the sealed connection right after
// ensureDatabase / ensureLogin answered 'created' — never from the row's status, created_by_hub
// or a matching name. Sealing them means a raw edit of the row cannot forge a marker. A failed
// creation therefore never gains drop rights over a login or database it did not make.
import type { Knex } from 'knex'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { HubSecretError, maskSecret, openSecret, sealSecret } from '../secrets.js'
import { connectionFromInput, type HubDbConnection, type HubDbEngine } from './connection.js'
import { generatePassword } from './names.js'
import { assertDbName, assertLoginName } from './provision-common.js'
import {
  type DbCheck,
  ProvisionError,
  provisionerFor,
  type Secrets,
  scrubText,
  withAppKnex,
  withServerKnex
} from './provisioner.js'
import { getServerRow, HubDbError, type HubDbServerRow, openAdminSecret } from './servers.js'

export { HubDbError } from './servers.js'

export type HubDatabaseStatus = 'requested' | 'creating' | 'ready' | 'failed'

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
  last_check: DbCheck | null
  checked_at: string | null
  /** Only ever the mask. */
  connection: string | null
  environment: { id: number; app_id: number; app_key: string; env_key: string } | null
}

/** The value nivaro_hub_environments.db_ref holds for a database row. */
export const dbRef = (id: number): string => `hub-db:${id}`

/** What the sealed `connection` column holds: the connection plus the ownership markers. */
interface StoredConnection extends HubDbConnection {
  made?: { database?: boolean; login?: boolean }
}

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
  last_check: DbCheck | null
  checked_at: string | null
}

const TABLE = 'nivaro_hub_databases'
const bool = (v: unknown) => v === true || Number(v) === 1
const now = () => new Date()

function parseCheck(v: unknown): DbCheck | null {
  if (typeof v !== 'string' || !v) return null
  try {
    const o = JSON.parse(v)
    return o && typeof o === 'object' && typeof o.state === 'string' ? (o as DbCheck) : null
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
  const plain = openSecret(row.connection)
  if (!plain) return null
  let v: unknown
  try {
    v = JSON.parse(plain)
  } catch {
    v = null
  }
  const o = v as StoredConnection | null
  if (!o || typeof o.password !== 'string' || typeof o.user !== 'string')
    throw new HubDbError('CONNECTION_UNREADABLE', 'The stored connection is damaged.', 500)
  return o
}

function sealStored(c: StoredConnection): string {
  return sealSecret(JSON.stringify(c))
}

function plainConnection(c: StoredConnection): HubDbConnection {
  return {
    engine: c.engine,
    host: c.host,
    port: c.port ?? null,
    database: c.database,
    user: c.user,
    password: c.password,
    ssl_mode: c.ssl_mode ?? null,
    trust_server_cert: c.trust_server_cert === true
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
  if (err instanceof HubSecretError) return new HubDbError(err.code, message, 500)
  return new HubDbError('DB_ERROR', message, 502)
}

function scrubCheck(c: DbCheck, secrets: Secrets): DbCheck {
  return { ...c, text: scrubText(c.text, secrets) }
}

/** A refusal code for a check a caller cannot accept. */
function checkRefusal(state: DbCheck['state']): string {
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

/**
 * A failed provisioning step, stored as the row's last check (the table has no error column).
 * A refusal over something that is not this record's own reads `foreign`; anything else
 * `unreachable`. Text is already scrubbed.
 */
function failureCheck(code: string, text: string): DbCheck {
  const foreign = code === 'DATABASE_EXISTS' || code === 'LOGIN_EXISTS' || code === 'NOT_OWNED'
  return {
    state: foreign ? 'foreign' : 'unreachable',
    ok: false,
    version: null,
    migrations: null,
    last_migration: null,
    text: `Provisioning failed: ${text}`.slice(0, 300),
    at: now().toISOString()
  }
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

// ─── Record ──────────────────────────────────────────────────────────────────

/**
 * Records the database an environment will use. Automatic server: status `creating`, the app
 * login's password generated and sealed NOW, so every retry reuses it. Manual server: status
 * `requested`, no connection until the DBA's is entered (setConnection). Nothing touches the
 * server here. `trx` lets the creation planner record inside its own transaction.
 */
export async function recordDatabase(o: {
  server: HubDbServerRow
  database_name: string
  login_name: string
  by: string | null
  trx?: Knex
}): Promise<HubDatabase> {
  const k = o.trx ?? db
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
  if ((await recordedAt(server.host, o.database_name, null, k)).length)
    throw new HubDbError(
      'DATABASE_RECORDED',
      'The Hub already records a database with this name on this host.'
    )

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
      connection = sealStored(stored)
    } catch (err) {
      throw toHubDbError(err, { passwords: [stored.password] })
    }
  }
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

// ─── Provision ───────────────────────────────────────────────────────────────

const provisioning = new Set<number>()

/**
 * Makes an automatic row's database: ensureLogin → ensureDatabase → ensureOwner, then checkApp as
 * the new login must answer `empty` → status `ready`. Idempotent: a retry reuses the sealed
 * password and the made_* markers; a `ready` row is answered as it is. Any failure → status
 * `failed` with the scrubbed reason as the last check, rethrown as a HubDbError.
 */
export async function provisionDatabase(
  id: number,
  log: (line: string) => void
): Promise<HubDatabase> {
  const row = await getRow(id)
  if (!row) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  if (row.status === 'ready') return mustAnswer(id)
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
  if (provisioning.has(id))
    throw new HubDbError('PROVISION_RUNNING', 'This database is being created right now.')

  provisioning.add(id)
  let secrets: Secrets = {}
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
    secrets = {
      passwords: [admin.password, stored.password],
      logins: [admin.user]
    }
    return await runProvision(row, server, admin, stored, secrets, log)
  } catch (err) {
    const e = toHubDbError(err, secrets)
    if (!(err instanceof StoredFailure)) {
      await db(TABLE)
        .where({ id })
        .update({
          status: 'failed',
          last_check: JSON.stringify(failureCheck(e.code, e.message)),
          checked_at: now(),
          updated_at: now()
        })
      log(`Database ${row.database_name} failed: ${e.message}`)
    }
    throw e
  } finally {
    provisioning.delete(id)
  }
}

/** A refusal whose failed status and check are already stored. */
class StoredFailure extends HubDbError {}

async function runProvision(
  row: DbRow,
  server: HubDbServerRow,
  admin: { user: string; password: string },
  stored: StoredConnection,
  secrets: Secrets,
  log: (line: string) => void
): Promise<HubDatabase> {
  const id = row.id
  const name = row.database_name
  const login = row.login_name as string
  const made = { ...(stored.made ?? {}) }
  const writeMarkers = async () => {
    await db(TABLE)
      .where({ id })
      .update({ connection: sealStored({ ...stored, made }), updated_at: now() })
  }

  await db(TABLE).where({ id }).update({ status: 'creating', updated_at: now() })
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
    const l = await p.ensureLogin(k, login, stored.password, { ownedLogin: made.login === true })
    if (l === 'created') {
      made.login = true
      await writeMarkers() // right after 'created': the retry may then reuse it
    }
    log(l === 'created' ? `Login ${login} created` : `Login ${login}: password set again`)

    const d = await p.ensureDatabase(k, name, {
      collation: server.collation,
      owner: login,
      ownedDatabase: made.database === true
    })
    if (d === 'created') {
      made.database = true
      await writeMarkers()
    }
    log(d === 'created' ? `Database ${name} created` : `Database ${name} already made`)

    await p.ensureOwner(k, name, login, { ownedDatabase: made.database === true })
    log(`Database ${name} handed to ${login}`)
  })

  const check = scrubCheck(
    await withAppKnex(plainConnection(stored), (k) => p.checkApp(k)),
    secrets
  )
  if (check.state !== 'empty') {
    await db(TABLE)
      .where({ id })
      .update({
        status: 'failed',
        last_check: JSON.stringify(check),
        checked_at: now(),
        updated_at: now()
      })
    log(`Database ${name} check: ${check.text}`)
    throw new StoredFailure(
      check.state === 'nivaro' || check.state === 'foreign'
        ? 'DATABASE_NOT_EMPTY'
        : checkRefusal(check.state),
      check.text
    )
  }
  await db(TABLE)
    .where({ id })
    .update({
      status: 'ready',
      last_check: JSON.stringify(check),
      checked_at: now(),
      updated_at: now()
    })
  log(`Database ${name} is ready`)
  return mustAnswer(id)
}

// ─── Manual: the DBA's connection ────────────────────────────────────────────

function parseConnection(input: unknown): HubDbConnection {
  const parsed = connectionFromInput(input)
  if (!parsed.ok) throw new HubDbError('BAD_CONNECTION', parsed.message, 400)
  return parsed.conn
}

async function runCheck(conn: HubDbConnection): Promise<DbCheck> {
  const secrets = { passwords: [conn.password], logins: [conn.user] }
  try {
    const p = provisionerFor(conn.engine)
    return scrubCheck(await withAppKnex(conn, (k) => p.checkApp(k)), secrets)
  } catch (err) {
    throw toHubDbError(err, secrets)
  }
}

const isManual = (row: DbRow) => !row.created_by_hub && !row.adopted

/**
 * The connection a DBA made for a requested (or failed) manual row: sealed, checked, and `ready`
 * only when the database is empty. Any other check keeps the row's status and stores the check.
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
  if ((await recordedAt(conn.host, conn.database, id)).length)
    throw new HubDbError(
      'DATABASE_IN_USE',
      'Another Hub record already uses this database on this host.'
    )

  const check = await runCheck(conn)
  let sealed: string
  try {
    sealed = sealStored(conn)
  } catch (err) {
    throw toHubDbError(err, { passwords: [conn.password] })
  }
  await db(TABLE)
    .where({ id })
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
  return { db: await mustAnswer(id), check }
}

/**
 * Check now: connects as the stored login and stores the result. A waiting manual row whose
 * database is now empty becomes `ready`; other rows keep their status.
 */
export async function checkDatabase(id: number): Promise<DbCheck> {
  const row = await getRow(id)
  if (!row) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  let stored: StoredConnection | null
  try {
    stored = openStored(row)
  } catch (err) {
    throw toHubDbError(err, {})
  }
  if (!stored)
    throw new HubDbError('NO_CONNECTION', 'No connection is saved for this database yet.')
  const check = await runCheck(plainConnection(stored))
  const ready =
    isManual(row) &&
    (row.status === 'requested' || row.status === 'failed') &&
    check.state === 'empty'
  await db(TABLE)
    .where({ id })
    .update({
      ...(ready ? { status: 'ready' } : {}),
      last_check: JSON.stringify(check),
      checked_at: now(),
      updated_at: now()
    })
  return check
}

// ─── Adopt ───────────────────────────────────────────────────────────────────

/**
 * Records a database as it already is. Never provisions: checkApp only, and only an empty
 * database or an existing Nivaro install is accepted (`foreign` → DATABASE_NOT_NIVARO).
 */
export async function adoptDatabase(input: unknown, by: string | null): Promise<HubDatabase> {
  const conn = parseConnection(input)
  if ((await recordedAt(conn.host, conn.database, null)).length)
    throw new HubDbError(
      'DATABASE_IN_USE',
      'Another Hub record already uses this database on this host.'
    )
  const check = await runCheck(conn)
  if (check.state !== 'empty' && check.state !== 'nivaro')
    throw new HubDbError(checkRefusal(check.state), check.text)

  const servers = (await db('nivaro_hub_db_servers')
    .where({ engine: conn.engine })
    .select('id', 'host', 'port')) as Array<{ id: number; host: string; port: number | null }>
  const server = servers.find(
    (s) =>
      String(s.host).toLowerCase() === conn.host.toLowerCase() && (s.port ?? null) === conn.port
  )
  let sealed: string
  try {
    sealed = sealStored(conn)
  } catch (err) {
    throw toHubDbError(err, { passwords: [conn.password] })
  }
  const id = await insertReturningId(db, TABLE, {
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
  return mustAnswer(Number(id))
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function attached(id: number, k: Knex = db): Promise<boolean> {
  return !!(await k('nivaro_hub_environments')
    .where({ db_ref: dbRef(id) })
    .first('id'))
}

/**
 * Detach (default): the Hub record and its sealed connection go; the database stays. `drop: true`
 * also drops the database and the login on the server, only for a row the Hub made on a server
 * that is still automatic, with no environment attached, and only what its markers say it made.
 */
export async function deleteDatabase(
  id: number,
  o: { confirm: unknown; drop: boolean }
): Promise<{ dropped: boolean }> {
  const row = await getRow(id)
  if (!row) throw new HubDbError('NOT_FOUND', 'Database not found.', 404)
  if (o.confirm !== row.database_name)
    throw new HubDbError('CONFIRM_REQUIRED', 'Type the database name to confirm.', 400)
  if (await attached(id))
    throw new HubDbError('IN_USE', 'An environment uses this database; detach it there first.')

  if (o.drop) {
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
      !server ||
      server.provision_mode !== 'automatic' ||
      !(made.database || made.login)
    )
      throw new HubDbError(
        'DROP_NOT_ALLOWED',
        'The Hub drops only a database or login it created itself on an automatic server. Detach instead.'
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
    const secrets = {
      passwords: [admin.password, stored?.password],
      logins: [admin.user]
    }
    try {
      const p = provisionerFor(server.engine, { user_host: server.user_host })
      await withServerKnex(server, admin, (k) =>
        p.drop(k, row.database_name, row.login_name, {
          ownedDatabase: made.database === true,
          ownedLogin: made.login === true
        })
      )
    } catch (err) {
      throw toHubDbError(err, secrets)
    }
  }

  await db.transaction(async (trx) => {
    if (await attached(id, trx))
      throw new HubDbError('IN_USE', 'An environment uses this database; detach it there first.')
    await trx(TABLE).where({ id }).del()
  })
  return { dropped: o.drop === true }
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
