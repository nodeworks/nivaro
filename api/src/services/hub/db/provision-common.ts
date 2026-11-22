// Shared parts of the Hub's database provisioners (mssql.ts, pg.ts, mysql.ts): the types, the
// refusal error, the guards every name / password / setting passes before it reaches SQL, error
// scrubbing and the read-only check classification. Kept apart from provisioner.ts so the engine
// modules never import the registry that imports them.
//
// DDL cannot bind identifiers, so a database or login name reaches SQL only after
// assertDbName / assertLoginName (isDbIdentifier, not reserved, within the engine's length) and
// then quoted per engine. Passwords are bound where the engine allows it (SQL Server through
// QUOTENAME in dynamic SQL, MySQL/MariaDB as `?`), else escaped as a literal (Postgres), and only
// after assertPassword (the generatePassword alphabet). Every driver error leaves through
// scrubDbError with the password and the login in its list.
import type { Knex } from 'knex'
import { rawRows } from '../../../db/raw-rows.js'
import { DB_ERROR_MAX, type HubDbEngine, scrubDbErrorFull } from './connection.js'
import { isDbIdentifier, isReservedDbName, maxLoginLength } from './names.js'

export interface ServerProbe {
  ok: boolean
  version: string | null
  can_create: boolean
  missing: string[]
  text: string
  /** A manual server with no login saved: nothing was tried (there is nothing to test). */
  manual?: boolean
}

export type DbCheckState = 'unreachable' | 'too_old' | 'no_rights' | 'empty' | 'nivaro' | 'foreign'

export interface DbCheck {
  state: DbCheckState
  ok: boolean
  version: string | null
  migrations: number | null
  last_migration: string | null
  text: string
  at: string
}

// ─── Ownership proof (ruling P3-12: fail closed) ─────────────────────────────
//
// The provisioner never writes to a database or login it has not been told is this creation's
// own. The caller (the Hub databases service) proves it with these flags, and sets them ONLY from
// markers it wrote on the database row when an earlier call answered 'created' — e.g.
// `made_login` after ensureLogin → 'created', `made_database` after ensureDatabase → 'created'.
// Never from the row's status, `created_by_hub`, or the fact that a name matches: a database or
// login that already existed before this creation (another app's, a DBA's) must stay untouched.
//
// ensureLogin and ensureDatabase each make their object in ONE statement, so 'created' means
// this call made it. Everything else (password reset, RCSI, user + db_owner, OWNER TO, REVOKE,
// GRANT ALL) happens in ensureLogin's ALTER path or in ensureOwner, both behind the flags. Write
// the marker right after the 'created' answer: if the Hub dies between CREATE and that write, the
// retry is refused (LOGIN_EXISTS / DATABASE_EXISTS) and an admin must clean up by hand.

export interface EnsureLoginOptions {
  /** This creation made the login (`made_login` marker). Else an existing login is LOGIN_EXISTS. */
  ownedLogin?: boolean
}

export interface EnsureDatabaseOptions {
  collation: string | null
  owner: string
  /** This creation made the database (`made_database` marker). Else an existing one is DATABASE_EXISTS. */
  ownedDatabase?: boolean
}

export interface OwnedDatabaseOptions {
  /** This creation made the database (`made_database` marker). Required: else NOT_OWNED. */
  ownedDatabase?: boolean
}

export interface DropOptions {
  /** Drop the database only with this (`made_database` marker). */
  ownedDatabase?: boolean
  /** Drop the login only with this (`made_login` marker). */
  ownedLogin?: boolean
}

export interface Provisioner {
  engine: HubDbEngine
  /** Version floor + rights to create databases and logins. Read-only; never throws. */
  probe(admin: Knex): Promise<ServerProbe>
  databaseExists(admin: Knex, name: string): Promise<boolean>
  loginExists(admin: Knex, login: string): Promise<boolean>
  /** CREATE (one statement) → 'created'; existing + ownedLogin → new password, 'updated'. */
  ensureLogin(
    admin: Knex,
    login: string,
    password: string,
    opts?: EnsureLoginOptions
  ): Promise<'created' | 'updated'>
  /** CREATE (one statement) → 'created'; existing + ownedDatabase → 'existed', nothing written. */
  ensureDatabase(
    admin: Knex,
    name: string,
    opts: EnsureDatabaseOptions
  ): Promise<'created' | 'existed'>
  /** Hands the database to the login (and on SQL Server switches RCSI on). Needs ownedDatabase. */
  ensureOwner(admin: Knex, name: string, login: string, opts?: OwnedDatabaseOptions): Promise<void>
  /** Drops only what the flags say this creation made; no flags = nothing dropped. */
  drop(admin: Knex, name: string, login: string | null, opts?: DropOptions): Promise<void>
  /** Read-only classification as the app's own login (plan decision 5). Never throws. */
  checkApp(app: Knex): Promise<DbCheck>
}

export type ProvisionErrorCode =
  | 'ENGINE_NOT_PROVISIONABLE'
  | 'UNSAFE_IDENTIFIER'
  | 'RESERVED_NAME'
  | 'LOGIN_EXISTS'
  | 'DATABASE_EXISTS'
  | 'NOT_OWNED'
  | 'DB_ERROR'

export class ProvisionError extends Error {
  code: ProvisionErrorCode
  constructor(code: ProvisionErrorCode, message: string) {
    super(message)
    this.name = 'ProvisionError'
    this.code = code
  }
}

// ─── Guards ──────────────────────────────────────────────────────────────────

const COLLATION = /^[A-Za-z][A-Za-z0-9_]{0,127}$/
const USER_HOST = /^(%|[A-Za-z0-9.%_:-]{1,60})$/
// generatePassword's alphabet: [A-Za-z0-9] plus the URL-unreserved -_.~ (no quote, backslash,
// percent or wildcard on any engine).
const PASSWORD = /^[A-Za-z0-9._~-]{16,128}$/

/** A SQL Server collation name as it may reach CREATE DATABASE … COLLATE. */
export function isCollation(v: unknown): v is string {
  return typeof v === 'string' && COLLATION.test(v)
}

/** A MySQL / MariaDB account host (`'login'@'<host>'`): `%`, a name, an address or a pattern. */
export function isUserHost(v: unknown): v is string {
  return typeof v === 'string' && USER_HOST.test(v)
}

export function assertDbName(engine: HubDbEngine, name: unknown): asserts name is string {
  if (!isDbIdentifier(name))
    throw new ProvisionError('UNSAFE_IDENTIFIER', 'The database name is not a safe identifier')
  if (isReservedDbName(engine, name))
    throw new ProvisionError('RESERVED_NAME', `The database name ${name} is reserved`)
}

export function assertLoginName(engine: HubDbEngine, login: unknown): asserts login is string {
  if (!isDbIdentifier(login))
    throw new ProvisionError('UNSAFE_IDENTIFIER', 'The login name is not a safe identifier')
  if (login.length > maxLoginLength(engine))
    throw new ProvisionError(
      'UNSAFE_IDENTIFIER',
      `The login name is longer than ${maxLoginLength(engine)} characters`
    )
  if (isReservedDbName(engine, login))
    throw new ProvisionError('RESERVED_NAME', `The login name ${login} is reserved`)
}

export function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || !PASSWORD.test(password))
    throw new ProvisionError('UNSAFE_IDENTIFIER', 'The password is not one the Hub generated')
}

export function assertCollation(v: unknown): asserts v is string {
  if (!isCollation(v))
    throw new ProvisionError('UNSAFE_IDENTIFIER', 'The collation is not a valid collation name')
}

export function refuseExistingDatabase(): never {
  throw new ProvisionError(
    'DATABASE_EXISTS',
    'A database with this name already exists on the server and was not made by this creation'
  )
}

export function assertOwnedDatabase(opts: OwnedDatabaseOptions | undefined): void {
  if (!opts?.ownedDatabase)
    throw new ProvisionError(
      'NOT_OWNED',
      'The Hub changes only a database this creation made itself'
    )
}

export function assertUserHost(v: unknown): asserts v is string {
  if (!isUserHost(v))
    throw new ProvisionError('UNSAFE_IDENTIFIER', 'The login host is not a valid host pattern')
}

// ─── Secrets attached to a knex, and scrubbed statements ─────────────────────

/**
 * What must never leave in error text. Passwords are masked wherever they appear (every
 * spelling, scrubDbError); logins are masked as whole tokens, so a short admin login such as
 * `sa` does not also blank the middle of "transaction".
 */
export interface Secrets {
  passwords?: Array<string | null | undefined>
  logins?: Array<string | null | undefined>
}

// withServerKnex / withAppKnex remember the credentials they connected with, so an error thrown
// by any statement on that knex is scrubbed of them too (a driver may name the login or repeat
// the connection string).
const KNEX_SECRETS = new WeakMap<object, Secrets>()

export function rememberSecrets(k: object, s: Secrets): void {
  KNEX_SECRETS.set(k, s)
}

const present = (list: Array<string | null | undefined> | undefined) =>
  (list ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0)

function maskLogins(text: string, logins: string[]): string {
  for (const login of logins.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(
      `(?<![A-Za-z0-9_])${login.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![A-Za-z0-9_])`,
      'gi'
    )
    text = text.replace(re, '••••')
  }
  return text
}

/**
 * truncate(maskLogins(scrub(text))): every spelling of every password is scrubbed over the FULL
 * text first (masking a login first could split a password that contains it, so the password
 * would no longer match); then logins as whole tokens; then the 300-character cut (masking after
 * the cut would leave a login that straddles character 300 half visible).
 */
export function scrubText(err: unknown, s: Secrets): string {
  const scrubbedText = scrubDbErrorFull(err, present(s.passwords))
  return maskLogins(scrubbedText, present(s.logins)).slice(0, DB_ERROR_MAX)
}

/**
 * knex words a failed statement as `<sql with bindings inlined> - <driver reason>`. The SQL part
 * is ours (and holds bound values such as a password); keep only the reason, so it survives the
 * 300-character cut. `sql` is the statement as we sent it: its text up to the first `?` must
 * open the message, and our statements never contain ' - '.
 */
export function driverReason(err: unknown, sql: string): unknown {
  if (!(err instanceof Error) || !err.message) return err
  const head = sql.split('?')[0]
  if (!err.message.startsWith(head)) return err
  const cut = err.message.indexOf(' - ', head.length)
  return cut < 0 ? err : err.message.slice(cut + 3)
}

/** Driver text made safe: this call's secrets plus the knex's own. */
export function scrubbed(k: object, err: unknown, extra: Secrets = {}): string {
  const own = KNEX_SECRETS.get(k) ?? {}
  return scrubText(err, {
    passwords: [...present(extra.passwords), ...present(own.passwords)],
    logins: [...present(extra.logins), ...present(own.logins)]
  })
}

/** One statement; any failure leaves as ProvisionError DB_ERROR with scrubbed text. */
export async function run<T = Record<string, unknown>>(
  k: Knex,
  sql: string,
  bindings: readonly unknown[] = [],
  secrets: Secrets = {},
  opts: { timeoutMs?: number } = {}
): Promise<T[]> {
  try {
    let q = k.raw(sql, bindings as Knex.RawBinding[])
    // MySQL / MariaDB only: knex kills the statement on a separate raw connection. Never on SQL
    // Server (tedious has its own requestTimeout; knex's cancel there is unsupported).
    if (opts.timeoutMs) q = q.timeout(opts.timeoutMs, { cancel: true })
    const res = await q
    return rawRows<T>(res)
  } catch (err) {
    throw new ProvisionError('DB_ERROR', scrubbed(k, driverReason(err, sql), secrets))
  }
}

/**
 * Every method's errors scrubbed of that call's own password, login and owner — whichever
 * statement failed, and whatever the engine module listed for it. Guard refusals
 * (UNSAFE_IDENTIFIER, RESERVED_NAME, LOGIN_EXISTS, DATABASE_EXISTS, NOT_OWNED) carry no
 * driver text and pass unchanged.
 */
export function scrubbingProvisioner(p: Provisioner): Provisioner {
  const guard = async <T>(s: Secrets, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ProvisionError && err.code !== 'DB_ERROR') throw err
      throw new ProvisionError('DB_ERROR', scrubText(err, s))
    }
  }
  return {
    engine: p.engine,
    probe: (admin) => p.probe(admin),
    checkApp: (app) => p.checkApp(app),
    databaseExists: (admin, name) => guard({}, () => p.databaseExists(admin, name)),
    loginExists: (admin, login) => guard({ logins: [login] }, () => p.loginExists(admin, login)),
    ensureLogin: (admin, login, password, opts) =>
      guard({ passwords: [password], logins: [login] }, () =>
        p.ensureLogin(admin, login, password, opts)
      ),
    ensureDatabase: (admin, name, opts) =>
      guard({ logins: [opts?.owner] }, () => p.ensureDatabase(admin, name, opts)),
    ensureOwner: (admin, name, login, opts) =>
      guard({ logins: [login] }, () => p.ensureOwner(admin, name, login, opts)),
    drop: (admin, name, login, opts) =>
      guard({ logins: [login] }, () => p.drop(admin, name, login, opts))
  }
}

// ─── Versions ────────────────────────────────────────────────────────────────

export function versionParts(v: string | null | undefined): [number, number, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0]
}

export function versionBelow(v: string, floor: readonly [number, number, number]): boolean {
  const p = versionParts(v)
  for (let i = 0; i < 3; i++) {
    if (p[i] !== floor[i]) return p[i] < floor[i]
  }
  return false
}

// ─── Checks ──────────────────────────────────────────────────────────────────

export const nowIso = () => new Date().toISOString()

export function check(
  state: DbCheckState,
  text: string,
  extra: Partial<Pick<DbCheck, 'version' | 'migrations' | 'last_migration'>> = {}
): DbCheck {
  return {
    state,
    ok: state === 'empty' || state === 'nivaro',
    version: extra.version ?? null,
    migrations: extra.migrations ?? null,
    last_migration: extra.last_migration ?? null,
    text,
    at: nowIso()
  }
}

/** Classification once the login is known to connect, be current and hold its rights. */
export function contentCheck(
  version: string,
  tables: number,
  ledger: { count: number; last: string | null } | null
): DbCheck {
  if (ledger)
    return check(
      'nivaro',
      `Connected. The database holds a Nivaro install (${ledger.count} migrations${ledger.last ? `, last ${ledger.last}` : ''}).`,
      { version, migrations: ledger.count, last_migration: ledger.last }
    )
  if (tables === 0) return check('empty', 'Connected. The database is empty.', { version })
  return check(
    'foreign',
    `Connected, but the database holds ${tables} table${tables === 1 ? '' : 's'} and no Nivaro install.`,
    { version }
  )
}

export function unreachableCheck(k: object, err: unknown): DbCheck {
  return check('unreachable', `Could not connect: ${scrubbed(k, err)}`)
}

export const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}

export const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't'
