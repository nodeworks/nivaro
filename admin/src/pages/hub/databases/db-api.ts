import { describeError, type ErrorDescription, errorToastOptions } from '@nivaro/shared'
import { type DataTag, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { hubError } from '../hub-api'

/**
 * Nivaro Hub (phase 3) — the Databases tab: database servers, the databases recorded on them, the
 * DBA checklist and the connection form. Types, query keys, fetchers and the plain-words copy for
 * every check state and refusal code the /api/hub database routes answer. Every secret on a read
 * is the mask '••••••'; the Hub never shows a password and never reads an app's records.
 */

export type DbEngine = 'mssql' | 'pg' | 'mysql2' | 'mariadb'
export type ProvisionMode = 'automatic' | 'manual'
export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'
export type DatabaseStatus = 'requested' | 'creating' | 'ready' | 'failed' | 'dropping'
export type DbCheckState = 'unreachable' | 'too_old' | 'no_rights' | 'empty' | 'nivaro' | 'foreign'

export interface DbServer {
  id: number
  name: string
  engine: DbEngine
  host: string
  port: number | null
  provision_mode: ProvisionMode
  ssl_mode: SslMode | null
  trust_server_cert: boolean
  collation: string | null
  user_host: string | null
  notes: string | null
  /** '••••••' when a provisioning login is stored, else null. */
  admin_secret: string | null
}

export interface DbCheck {
  state: DbCheckState | 'error'
  ok: boolean
  version: string | null
  migrations: number | null
  last_migration: string | null
  /** Driver text (scrubbed of secrets); only ever shown behind "Details for support". */
  text: string
  at: string
  /** Set when the state is 'error': the refusal the Hub recorded. */
  code?: string
}

export interface DbEnvironmentRef {
  id: number
  app_id: number
  app_key: string
  env_key: string
}

export interface HubDatabaseRow {
  id: number
  server_id: number | null
  server_name: string | null
  engine: DbEngine
  host: string
  port: number | null
  database_name: string
  login_name: string | null
  status: DatabaseStatus
  adopted: boolean
  created_by_hub: boolean
  last_check: DbCheck | null
  checked_at: string | null
  /** Only ever the mask. */
  connection: string | null
  environment: DbEnvironmentRef | null
  /** The row's server TLS (never its login); null = no server. Absent from older APIs. */
  server_tls?: DbServerTls | null
}

/** A database server's TLS settings, as database rows and the creation view carry them. */
export interface DbServerTls {
  ssl_mode: SslMode | null
  trust_server_cert: boolean
}

export interface ChecklistItem {
  label: string
  value: string
  note?: string
}

export interface HubDatabaseFull extends HubDatabaseRow {
  /** What a DBA must create; only while a manual database is requested. */
  checklist: ChecklistItem[] | null
}

export interface ServerProbe {
  ok: boolean
  version: string | null
  can_create: boolean
  missing: string[]
  text: string
  /** A manual server with no login saved: nothing was tried. */
  manual?: boolean
}

export interface ConnectionInput {
  engine: DbEngine
  host: string
  port: number | null
  database: string
  user: string
  password: string
  ssl_mode: SslMode | null
  trust_server_cert: boolean
}

// ─── Query keys (own roots: 'hub-db-*'; one key = one shape) ─────────────────

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export const dbKeys: {
  servers: () => Tagged<readonly ['hub-db-servers'], DbServer[]>
  databases: () => Tagged<readonly ['hub-db-databases'], HubDatabaseRow[]>
  database: (id: number) => Tagged<readonly ['hub-db-database', number], HubDatabaseFull>
} = {
  servers: () => tag<DbServer[], readonly ['hub-db-servers']>(['hub-db-servers'] as const),
  databases: () =>
    tag<HubDatabaseRow[], readonly ['hub-db-databases']>(['hub-db-databases'] as const),
  database: (id) =>
    tag<HubDatabaseFull, readonly ['hub-db-database', number]>(['hub-db-database', id] as const)
}

export const fetchDbServers = () =>
  api.get<{ data: DbServer[] }>('/hub/db-servers').then((r) => r.data.data)
export const fetchDatabases = () =>
  api.get<{ data: HubDatabaseRow[] }>('/hub/databases').then((r) => r.data.data)
export const fetchDatabase = (id: number) =>
  api.get<{ data: HubDatabaseFull }>(`/hub/databases/${id}`).then((r) => r.data.data)

export function useDbServers(enabled = true) {
  return useQuery({ queryKey: dbKeys.servers(), queryFn: fetchDbServers, enabled })
}
export function useDatabases(enabled = true) {
  return useQuery({ queryKey: dbKeys.databases(), queryFn: fetchDatabases, enabled })
}
export function useDatabase(id: number | null) {
  return useQuery({
    queryKey: dbKeys.database(id ?? 0),
    queryFn: () => fetchDatabase(id as number),
    enabled: id != null
  })
}

// ─── Words ────────────────────────────────────────────────────────────────────

export const ENGINE_LABEL: Record<DbEngine, string> = {
  mssql: 'SQL Server',
  pg: 'PostgreSQL',
  mysql2: 'MySQL',
  mariadb: 'MariaDB'
}

export const ENGINE_PORT: Record<DbEngine, number> = {
  mssql: 1433,
  pg: 5432,
  mysql2: 3306,
  mariadb: 3306
}

export const SSL_LABEL: Record<SslMode, string> = {
  disable: 'No TLS',
  require: 'TLS, any certificate',
  'verify-ca': 'TLS, verify the CA',
  'verify-full': 'TLS, verify CA and host name'
}

export const MODE_LABEL: Record<ProvisionMode, string> = {
  automatic: 'Automatic',
  manual: 'Manual (a DBA)'
}

export const STATUS_LABEL: Record<DatabaseStatus, string> = {
  requested: 'Waiting for a DBA',
  creating: 'Being created',
  ready: 'Ready',
  failed: 'Failed',
  dropping: 'Being dropped'
}

/** Chip tone per database status (opaque light + dark pairs). */
export const DB_STATUS_TONE: Record<DatabaseStatus, string> = {
  requested:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
  creating:
    'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300',
  ready:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  failed:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300',
  dropping:
    'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300'
}

/** What every check state means, in words (the Hub's own, never the driver's). */
export const CHECK_COPY: Record<DbCheckState, { title: string; hint: string; good: boolean }> = {
  unreachable: {
    title: 'The Hub could not connect',
    hint: 'Check the host, port, login and password, and that the server accepts connections from the Hub.',
    good: false
  },
  too_old: {
    title: 'The database server is too old',
    hint: 'Nivaro needs a newer version of this engine. Use a newer server.',
    good: false
  },
  no_rights: {
    title: 'The login lacks rights',
    hint: 'The login must own this database and be able to create tables in it. Ask the DBA to grant that.',
    good: false
  },
  empty: {
    title: 'Empty and ready for a new app',
    hint: 'The database has nothing in it yet; the app will set it up on first start.',
    good: true
  },
  nivaro: {
    title: 'Already holds a Nivaro app',
    hint: 'This is an existing Nivaro database; an app can use it as it is.',
    good: true
  },
  foreign: {
    title: 'Holds something that is not Nivaro',
    hint: 'The database has tables of another program. Point at an empty database instead.',
    good: false
  }
}

const copy = (title: string, hint?: string) => (hint ? { title, hint } : { title })

/**
 * Every refusal the /api/hub database, server and connection routes answer, in plain words
 * (hubError in hub-api.ts covers the Hub's older codes; these win where both name a code).
 */
export const DB_CODE_COPY: Record<string, { title: string; hint?: string }> = {
  // Input
  BAD_NAME: copy('Give the server a name', 'Use up to 200 characters.'),
  BAD_ENGINE: copy('Pick the database engine', 'SQL Server, PostgreSQL, MySQL or MariaDB.'),
  BAD_HOST: copy(
    'The host is not valid',
    'Use a host name or an IP address, without http:// or a path.'
  ),
  BAD_PORT: copy('The port is not valid', 'Use a whole number from 1 to 65535, or leave it empty.'),
  BAD_MODE: copy(
    'Pick how databases are made',
    'Automatic (the Hub creates them) or manual (a DBA does).'
  ),
  BAD_SSL: copy('The TLS setting is not valid', 'Pick one of the listed TLS modes.'),
  BAD_COLLATION: copy(
    'The collation is not valid',
    'Use a collation name such as SQL_Latin1_General_CP1_CI_AS.'
  ),
  BAD_USER_HOST: copy(
    'The login host is not valid',
    'Use %, a host name, an address or a pattern.'
  ),
  BAD_NOTES: copy('The notes are too long', 'Keep them under 1000 characters.'),
  BAD_SECRET: copy('The login needs a user and a password', 'Type both, or clear the login.'),
  BAD_CONNECTION: copy(
    'The connection is not complete',
    'Fill in the host, database, login and password. Nothing was saved.'
  ),
  BAD_DROP: copy('Choose whether to drop the database', 'Nothing was changed. Try again.'),
  // Servers and logins
  ADMIN_REQUIRED: copy(
    'An automatic server needs a provisioning login',
    'Enter a user and password that may create databases and logins on the server.'
  ),
  LOGIN_HALF_MASKED: copy(
    'Type both the user and the password again',
    'One of them still holds the hidden saved value (the • dots). Retype both, or leave both as they are.'
  ),
  SECRET_REQUIRED: copy(
    'Enter the login again',
    'The engine, host, port or TLS setting changed, so the saved login is not sent there. Type the user and password again.'
  ),
  SERVER_IN_USE: copy(
    'A database still uses this server',
    'Detach or drop its databases first, then delete the server.'
  ),
  IN_USE: copy(
    'Something still uses this',
    'An environment or a database still names it. Detach it there first.'
  ),
  NAME_TAKEN: copy('Another server already has that name', 'Pick a different name.'),
  SERVER_MOVED: copy(
    'The server now points somewhere else',
    'Nothing was dropped. The database was made on the old address; fix the server first.'
  ),
  NOT_AUTOMATIC: copy(
    'The Hub cannot create this one itself',
    'Only a database the Hub makes on an automatic server can be provisioned.'
  ),
  NOT_MANUAL: copy(
    'The Hub manages this database itself',
    'Only a database requested from a DBA takes a connection.'
  ),
  ENGINE_MISMATCH: copy(
    'The engine does not match the server',
    'Pick a server of the same engine.'
  ),
  ENGINE_NOT_PROVISIONABLE: copy(
    'The Hub cannot create databases on this engine',
    'Make the database by hand and adopt it.'
  ),
  // Names
  DATABASE_NAME_INVALID: copy(
    'The database name is not allowed',
    'Use lower-case letters, digits and underscores (2 to 63), starting with a letter.'
  ),
  LOGIN_NAME_INVALID: copy(
    'The login name is not allowed',
    'Use letters, digits and underscores, starting with a letter.'
  ),
  UNSAFE_IDENTIFIER: copy(
    'That name is not allowed',
    'Use letters, digits and underscores, starting with a letter.'
  ),
  RESERVED_NAME: copy('That name is reserved by the server', 'Pick another name.'),
  LOGIN_EXISTS: copy(
    'A login with that name already exists',
    'The Hub does not take over logins it did not make. Pick another name.'
  ),
  DATABASE_EXISTS: copy(
    'A database with that name already exists',
    'The Hub does not take over databases it did not make. Adopt it, or pick another name.'
  ),
  NOT_OWNED: copy('The Hub did not make this', 'It will not change something another person made.'),
  DATABASE_RECORDED: copy('The Hub already has this database', 'Open it in the list instead.'),
  DATABASE_IN_USE: copy(
    'Another Hub record uses this database',
    'Each database can serve one environment. Pick a different one.'
  ),
  // State
  NOT_FOUND: copy('That no longer exists', 'It was removed. Reload the list.'),
  NOT_READY: copy('The database is not ready yet', 'Wait until it shows Ready, then try again.'),
  DATABASE_NOT_READY: copy(
    'The database is not ready yet',
    'Wait until it shows Ready, then try again.'
  ),
  NOT_WAITING: copy(
    'This database already has a working connection',
    'There is nothing left to enter.'
  ),
  NO_CONNECTION: copy(
    'No connection is saved yet',
    'Enter the connection in the Connection card, then Save and check.'
  ),
  DATABASE_DROPPING: copy('The database is being dropped', 'Wait for that to finish.'),
  PROVISION_RUNNING: copy(
    'The Hub is already working on this database',
    'Wait a minute, then reload.'
  ),
  LOCK_UNAVAILABLE: copy('The Hub is busy with this database', 'Try again in a moment.'),
  STATE_CHANGED: copy('It changed while you were looking', 'Reload and try again.'),
  CONNECTION_UNREADABLE: copy(
    'The saved connection cannot be read',
    'Enter the connection again. If it keeps happening, check ENCRYPTION_KEY on the Hub server.'
  ),
  HUB_SECRET_UNREADABLE: copy(
    'A saved login cannot be read',
    'Enter it again. If it keeps happening, check ENCRYPTION_KEY on the Hub server.'
  ),
  HUB_SECRET_NOT_SEALED: copy('A saved login cannot be read', 'Enter it again.'),
  HUB_NEEDS_ENCRYPTION_KEY: copy(
    'The Hub cannot store logins yet',
    'Set ENCRYPTION_KEY on the Hub server, restart it, then try again.'
  ),
  // Delete and drop
  CONFIRM_REQUIRED: copy(
    'Type the database name to confirm',
    'Nothing was changed. Type the name exactly as shown.'
  ),
  DROP_NOT_ALLOWED: copy(
    'The Hub may not drop this database',
    'It drops only a database it made itself on an automatic server. Detach it instead.'
  ),
  // What a check found, when a refusal carries it
  DATABASE_UNREACHABLE: copy(CHECK_COPY.unreachable.title, CHECK_COPY.unreachable.hint),
  DATABASE_TOO_OLD: copy(CHECK_COPY.too_old.title, CHECK_COPY.too_old.hint),
  DATABASE_NO_RIGHTS: copy(CHECK_COPY.no_rights.title, CHECK_COPY.no_rights.hint),
  DATABASE_NOT_NIVARO: copy(CHECK_COPY.foreign.title, CHECK_COPY.foreign.hint),
  DATABASE_NOT_EMPTY: copy(
    'The database is not empty',
    'It holds tables that are not Nivaro. Point at an empty database.'
  ),
  // Owners (ruling P3-24) and the Hub itself
  HOST_NOT_SERVER: copy(
    "Use this database's own server",
    'Only the host and port of the server this database lives on can be used here. Ask a Hub admin to change the server.'
  ),
  TOO_MANY_TRIES: copy(
    'Too many tries on this database',
    'Wait about ten minutes, then check again.'
  ),
  DB_ERROR: copy(
    'The database server did not accept that',
    'Check the host, login and rights, then try again.'
  ),
  HUB_ERROR: copy(
    'The Hub could not do that',
    'Try again. If it keeps happening, ask whoever runs the Hub.'
  )
}

/** What a stored check says, in words; a check the Hub recorded as a refusal reads its code. */
export function checkWords(c: DbCheck): { title: string; hint?: string; good: boolean } {
  if (c.state === 'error') {
    const byCode = c.code ? DB_CODE_COPY[c.code] : undefined
    return { ...(byCode ?? DB_CODE_COPY.DB_ERROR), good: false }
  }
  return CHECK_COPY[c.state] ?? { title: 'The check gave no clear answer', good: false }
}

/** The word for a probe's missing rights (the API names them in the engine's own terms). */
export function probeWords(p: ServerProbe): { title: string; hint?: string; good: boolean } {
  if (p.manual)
    return {
      title: 'Manual server: nothing to test',
      hint: 'A DBA makes its databases; there is no login to try.',
      good: true
    }
  if (!p.ok)
    return {
      title: 'The Hub could not connect',
      hint: 'Check the host, port, TLS setting and login.',
      good: false
    }
  if (!p.can_create)
    return {
      title: 'Connected, but the login cannot create databases',
      hint: p.missing.length
        ? 'It lacks the rights listed below.'
        : 'Grant it the rights to create databases and logins.',
      good: false
    }
  return {
    title: p.version ? `Ready — ${p.version}` : 'Ready',
    hint: 'The login can create databases and logins here.',
    good: true
  }
}

/** Hints for a person who is not a Hub admin: nothing about server settings they cannot reach. */
const OWNER_HINT: Record<string, string> = {
  CONNECTION_UNREADABLE:
    'Enter the connection again. If it keeps happening, ask whoever runs the Hub.',
  HUB_SECRET_UNREADABLE: 'Enter it again. If it keeps happening, ask whoever runs the Hub.',
  HUB_NEEDS_ENCRYPTION_KEY: 'Ask whoever runs the Hub to finish its setup.'
}

/** An error already put into words: what component state and mutation errors hold. */
export class DescribedError extends Error {
  description: ErrorDescription
  constructor(description: ErrorDescription) {
    super(description.title)
    this.name = 'DescribedError'
    this.description = description
  }
}

/** Refusals the person fixes on the page itself (the toast offers no Reload or Retry). */
const PAGE_FIXES = new Set(['NO_CONNECTION'])

/**
 * describeError with the database routes' refusals in plain words. `owner` = the caller is not a
 * Hub admin (hints name no server settings).
 */
export function dbError(
  err: unknown,
  fallback: string,
  opts: { owner?: boolean } = {}
): ErrorDescription {
  if (err instanceof DescribedError) return err.description
  const d = describeError(err, fallback)
  const copyFor = d.code ? DB_CODE_COPY[d.code] : undefined
  if (!copyFor) return hubError(err, fallback)
  const out: ErrorDescription = { ...d, title: copyFor.title }
  // Fixed by something on the page, not by reloading or retrying: no button (P3-29).
  if (d.code && PAGE_FIXES.has(d.code)) delete out.action
  const hint = (opts.owner && d.code ? OWNER_HINT[d.code] : undefined) ?? copyFor.hint
  if (hint) out.hint = hint
  else delete out.hint
  return out
}

/**
 * For a mutation's `.catch`: turns the raw request error into a DescribedError, so what the
 * mutation (and component state) keeps never holds the request, whose config carries the
 * password that was sent.
 */
export const describeFailure =
  (fallback: string, opts: { owner?: boolean } = {}) =>
  (err: unknown): never => {
    throw new DescribedError(dbError(err, fallback, opts))
  }

export function dbToast(err: unknown, fallback: string, opts: { owner?: boolean } = {}) {
  const d = dbError(err, fallback, opts)
  toast.error(d.title, errorToastOptions(d))
}
