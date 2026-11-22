// Hub database servers (phase 3): a server the Hub may create databases on (provision_mode
// `automatic`, with a sealed provisioning login) or one a DBA serves by hand (`manual`, login
// optional and only used to test reachability).
//
// The provisioning login (`admin_secret`, sealed JSON `{user, password}`) is only ever answered
// as the mask. It never reaches a log, an error or a response: every probe error arrives scrubbed
// from the provisioner and is scrubbed once more here with the login's own values.
import type { Knex } from 'knex'
import type { SslMode } from '../../../db/connection-url.js'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import type { Validation } from '../drivers.js'
import { HUB_MASK, HubSecretError, openSecret, sealSecret } from '../secrets.js'
import { connectionFromInput, type HubDbEngine, PROVISION_ENGINES } from './connection.js'
import {
  isCollation,
  isUserHost,
  provisionerFor,
  type ServerProbe,
  scrubText,
  withServerKnex
} from './provisioner.js'
import {
  hasMarkers,
  normPort,
  openStoredConnection,
  placeOf,
  samePlace
} from './stored-connection.js'

export type ProvisionMode = 'automatic' | 'manual'

declare const SEALED: unique symbol
/** A sealed provisioning login as stored. Branded, so a stored row can never pass as an answer. */
export type SealedAdminSecret = string & { readonly [SEALED]: true }

/** A server as stored: `admin_secret` still sealed. Never answered as it is (publicServer). */
export interface HubDbServerRow {
  id: number
  name: string
  engine: HubDbEngine
  host: string
  port: number | null
  provision_mode: ProvisionMode
  ssl_mode: SslMode | null
  trust_server_cert: boolean
  collation: string | null
  user_host: string | null
  notes: string | null
  admin_secret: SealedAdminSecret | null
}

/** A server as the API shows it: the provisioning login is only ever the mask. */
export interface HubDbServer extends Omit<HubDbServerRow, 'admin_secret'> {
  admin_secret: typeof HUB_MASK | null
}

export type ServerFields = Omit<HubDbServerRow, 'id'>

const SSL_MODES: readonly SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full']

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message }
}

const has = (o: Record<string, unknown>, k: string) => Object.hasOwn(o, k)

/** Optional short text: null when empty; undefined when not text or too long. */
function optText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t.length > max) return undefined
  return t || null
}

/** The host rule of the connection model (a name or an IP, never URL syntax). */
function cleanHost(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const r = connectionFromInput({
    engine: 'pg',
    host: v.trim(),
    database: 'x',
    user: 'x',
    password: 'x'
  })
  return r.ok ? r.conn.host : null
}

/**
 * The sealed provisioning login after an edit. `undefined` in the body = keep on update, clear on
 * create; the mask = keep; null / '' = clear; `{user, password}` = seal anew. A `'bad'` answer is
 * a value that is none of these.
 */
function nextAdminSecret(incoming: unknown, stored: string | null, updating: boolean) {
  if (incoming === undefined) return updating ? stored : null
  if (incoming === HUB_MASK) return stored
  if (incoming === null || incoming === '') return null
  if (typeof incoming !== 'object' || Array.isArray(incoming)) return 'bad' as const
  const o = incoming as Record<string, unknown>
  const user = o.user
  const password = o.password
  if (
    typeof user !== 'string' ||
    !user.trim() ||
    user.length > 128 ||
    typeof password !== 'string' ||
    !password ||
    password.length > 256
  )
    return 'bad' as const
  return sealSecret(JSON.stringify({ user: user.trim(), password }))
}

export function validateServerInput(
  body: Record<string, unknown>,
  existing?: HubDbServerRow
): Validation<ServerFields> {
  const pick = <K extends keyof ServerFields>(k: K): unknown =>
    has(body, k) ? body[k] : existing?.[k]

  const name = pick('name')
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200)
    return fail('BAD_NAME', 'A database server needs a name (at most 200 characters).')

  const engine = pick('engine')
  if (engine === 'sqlite' || engine === 'better-sqlite3' || engine === 'sqlite3')
    return fail(
      'ENGINE_NOT_PROVISIONABLE',
      'SQLite is a file on the app’s own host: the Hub cannot create one.'
    )
  if (typeof engine !== 'string' || !(PROVISION_ENGINES as readonly string[]).includes(engine))
    return fail('BAD_ENGINE', 'The engine must be one of mssql, pg, mysql2 or mariadb.')

  const host = cleanHost(pick('host'))
  if (!host) return fail('BAD_HOST', 'The host must be a host name or an IP address.')

  const portRaw = pick('port')
  let port: number | null = null
  if (portRaw !== undefined && portRaw !== null && portRaw !== '') {
    const n = typeof portRaw === 'string' && /^\d+$/.test(portRaw) ? Number(portRaw) : portRaw
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535)
      return fail('BAD_PORT', 'The port must be a whole number from 1 to 65535.')
    port = n
  }

  const mode = pick('provision_mode') ?? 'manual'
  if (mode !== 'automatic' && mode !== 'manual')
    return fail('BAD_MODE', 'provision_mode must be automatic or manual.')

  const sslRaw = pick('ssl_mode')
  let ssl_mode: SslMode | null = null
  if (sslRaw !== undefined && sslRaw !== null && sslRaw !== '') {
    if (typeof sslRaw !== 'string' || !(SSL_MODES as readonly string[]).includes(sslRaw))
      return fail('BAD_SSL', `ssl_mode must be one of ${SSL_MODES.join(', ')}.`)
    ssl_mode = sslRaw as SslMode
  }
  const trustRaw = pick('trust_server_cert')
  if (trustRaw !== undefined && trustRaw !== null && typeof trustRaw !== 'boolean')
    return fail('BAD_SSL', 'trust_server_cert must be true or false.')
  const trust_server_cert = trustRaw === true

  const collationRaw = pick('collation')
  let collation: string | null = null
  if (collationRaw !== undefined && collationRaw !== null && collationRaw !== '') {
    if (!isCollation(collationRaw))
      return fail('BAD_COLLATION', 'The collation must be a collation name.')
    collation = collationRaw
  }
  const userHostRaw = pick('user_host')
  let user_host: string | null = null
  if (userHostRaw !== undefined && userHostRaw !== null && userHostRaw !== '') {
    if (!isUserHost(userHostRaw))
      return fail(
        'BAD_USER_HOST',
        'The login host must be %, a host name, an address or a pattern.'
      )
    user_host = userHostRaw
  }
  const notes = optText(pick('notes'), 1000)
  if (notes === undefined) return fail('BAD_NOTES', 'Notes must be text (at most 1000 characters).')

  const stored = existing?.admin_secret ?? null
  let admin_secret: SealedAdminSecret | null
  try {
    const next = nextAdminSecret(body.admin_secret, stored, !!existing)
    if (next === 'bad')
      return fail(
        mode === 'automatic' ? 'ADMIN_REQUIRED' : 'BAD_SECRET',
        'The provisioning login needs a user and a password.'
      )
    admin_secret = next as SealedAdminSecret | null
  } catch (err) {
    if (err instanceof HubSecretError) return fail(err.code, err.message)
    throw err
  }
  if (mode === 'automatic' && !admin_secret)
    return fail(
      'ADMIN_REQUIRED',
      'Automatic servers need a provisioning login (user and password) that may create databases and logins.'
    )

  // A stored login never follows the server somewhere else: changing where it connects (or how
  // safely) needs the login entered again.
  if (
    existing &&
    stored &&
    admin_secret === stored &&
    (engine !== existing.engine ||
      host.toLowerCase() !== existing.host.toLowerCase() ||
      normPort(engine as HubDbEngine, port) !== normPort(existing.engine, existing.port) ||
      ssl_mode !== existing.ssl_mode ||
      trust_server_cert !== existing.trust_server_cert)
  )
    return fail(
      'SECRET_REQUIRED',
      'Enter the provisioning login again when the engine, host, port or TLS settings change.'
    )

  return {
    ok: true,
    row: {
      name: name.trim(),
      engine: engine as HubDbEngine,
      host,
      port,
      provision_mode: mode,
      ssl_mode,
      trust_server_cert,
      collation,
      user_host,
      notes,
      admin_secret
    }
  }
}

function toRow(r: Record<string, unknown>): HubDbServerRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    engine: r.engine as HubDbEngine,
    host: String(r.host),
    port: r.port === null || r.port === undefined ? null : Number(r.port),
    provision_mode: r.provision_mode === 'automatic' ? 'automatic' : 'manual',
    ssl_mode: (r.ssl_mode as SslMode | null) ?? null,
    trust_server_cert: r.trust_server_cert === true || Number(r.trust_server_cert) === 1,
    collation: (r.collation as string | null) ?? null,
    user_host: (r.user_host as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    admin_secret: (r.admin_secret as SealedAdminSecret | null) ?? null
  }
}

export function publicServer(row: HubDbServerRow): HubDbServer {
  return { ...row, admin_secret: row.admin_secret ? HUB_MASK : null }
}

/** The sealed provisioning login, opened. Null when none is stored. */
export function openAdminSecret(row: HubDbServerRow): { user: string; password: string } | null {
  const plain = openSecret(row.admin_secret)
  if (!plain) return null
  let v: unknown
  try {
    v = JSON.parse(plain)
  } catch {
    v = null
  }
  const o = (v ?? {}) as Record<string, unknown>
  if (typeof o.user !== 'string' || typeof o.password !== 'string')
    throw new HubSecretError('HUB_SECRET_UNREADABLE', 'The stored provisioning login is damaged.')
  return { user: o.user, password: o.password }
}

const now = () => new Date()

export class HubDbError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'HubDbError'
    this.code = code
    this.status = status
  }
}

async function nameTaken(name: string, exceptId?: number): Promise<boolean> {
  const q = db('nivaro_hub_db_servers').whereRaw('LOWER(name) = ?', [name.toLowerCase()])
  if (exceptId !== undefined) q.whereNot({ id: exceptId })
  return !!(await q.first('id'))
}

export async function listServers(): Promise<HubDbServer[]> {
  const rows = (await db('nivaro_hub_db_servers').select('*').orderBy('id')) as Record<
    string,
    unknown
  >[]
  return rows.map((r) => publicServer(toRow(r)))
}

export async function getServerRow(id: number): Promise<HubDbServerRow | null> {
  if (!Number.isInteger(id)) return null
  const r = (await db('nivaro_hub_db_servers').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? toRow(r) : null
}

function columns(f: ServerFields) {
  return {
    name: f.name,
    engine: f.engine,
    host: f.host,
    port: f.port,
    provision_mode: f.provision_mode,
    admin_secret: f.admin_secret,
    ssl_mode: f.ssl_mode,
    trust_server_cert: f.trust_server_cert,
    collation: f.collation,
    user_host: f.user_host,
    notes: f.notes
  }
}

export async function createServer(f: ServerFields): Promise<HubDbServer> {
  if (await nameTaken(f.name))
    throw new HubDbError('NAME_TAKEN', 'A database server with this name already exists.')
  const id = await insertReturningId(db, 'nivaro_hub_db_servers', {
    ...columns(f),
    created_at: now(),
    updated_at: now()
  })
  return publicServer({ id: Number(id), ...f })
}

/**
 * A database row on this server that pins it where it is (ruling P3-18): one with ownership
 * markers (they name objects on the current host), or one not yet `ready` (its provisioning or
 * DBA connection is still in flight). A connection that cannot be opened counts as marked.
 */
async function pinnedRows(serverId: number, k: Knex): Promise<boolean> {
  const rows = (await k('nivaro_hub_databases')
    .where({ server_id: serverId })
    .select('status', 'connection')) as Array<{ status: string; connection: string | null }>
  for (const r of rows) {
    if (r.status !== 'ready') return true
    try {
      if (hasMarkers(openStoredConnection(r.connection))) return true
    } catch {
      return true
    }
  }
  return false
}

export async function updateServer(id: number, f: ServerFields): Promise<HubDbServer | null> {
  if (await nameTaken(f.name, id))
    throw new HubDbError('NAME_TAKEN', 'A database server with this name already exists.')
  const n = await db.transaction(async (trx) => {
    const before = (await trx('nivaro_hub_db_servers').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!before) return 0
    if (!samePlace(placeOf(toRow(before)), placeOf(f)) && (await pinnedRows(id, trx)))
      throw new HubDbError(
        'SERVER_IN_USE',
        'The Hub made or is making databases on this server: its engine, host and port cannot change. Add a new server instead.'
      )
    return trx('nivaro_hub_db_servers')
      .where({ id })
      .update({ ...columns(f), updated_at: now() })
  })
  if (!n) return null
  return publicServer({ id, ...f })
}

/** Deletes a server; IN_USE while a database row names it. */
export async function deleteServer(
  id: number
): Promise<{ ok: true } | { ok: false; code: 'IN_USE' | 'NOT_FOUND' }> {
  return db.transaction(async (trx) => {
    if (!(await trx('nivaro_hub_db_servers').where({ id }).first('id')))
      return { ok: false, code: 'NOT_FOUND' as const }
    if (await trx('nivaro_hub_databases').where({ server_id: id }).first('id'))
      return { ok: false, code: 'IN_USE' as const }
    await trx('nivaro_hub_db_servers').where({ id }).del()
    return { ok: true as const }
  })
}

const MANUAL_NO_LOGIN: ServerProbe = {
  ok: true,
  version: null,
  can_create: false,
  missing: [],
  text: 'manual'
}

/**
 * Test button. Automatic: the provisioner's probe as the provisioning login. Manual: with a stored
 * login, only whether the server answers (never `can_create`); without one, `manual`.
 */
export async function testServer(id: number): Promise<ServerProbe> {
  const row = await getServerRow(id)
  if (!row) throw new HubDbError('NOT_FOUND', 'Database server not found.', 404)
  let admin: { user: string; password: string } | null
  try {
    admin = openAdminSecret(row)
  } catch (err) {
    const text =
      err instanceof HubSecretError
        ? 'The saved provisioning login cannot be read (check ENCRYPTION_KEY).'
        : 'The saved provisioning login cannot be read.'
    return { ok: false, version: null, can_create: false, missing: [], text }
  }
  if (!admin) {
    if (row.provision_mode === 'manual') return { ...MANUAL_NO_LOGIN }
    return {
      ok: false,
      version: null,
      can_create: false,
      missing: [],
      text: 'No provisioning login is saved for this server.'
    }
  }
  const secrets = { passwords: [admin.password], logins: [admin.user] }
  let probe: ServerProbe
  try {
    const provisioner = provisionerFor(row.engine, { user_host: row.user_host })
    probe = await withServerKnex(row, admin, (k) => provisioner.probe(k))
  } catch (err) {
    return {
      ok: false,
      version: null,
      can_create: false,
      missing: [],
      text: scrubText(err, secrets)
    }
  }
  // Belt and braces: the probe text is the provisioner's, already scrubbed.
  const safe = { ...probe, text: scrubText(probe.text, secrets) }
  if (row.provision_mode === 'automatic') return safe
  const reachable = safe.version !== null
  return {
    ok: reachable,
    version: safe.version,
    can_create: false,
    missing: [],
    text: reachable
      ? `Reachable (${safe.version}). Manual server: a DBA creates the databases.`
      : safe.text
  }
}
