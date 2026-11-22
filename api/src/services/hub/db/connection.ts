// The Hub's model of a database connection: build the app's DB_URL, read one back from input,
// make a knex config for a short-lived provisioning connection, and scrub driver errors.
// Pure functions: no database, no config.
import type { Knex } from 'knex'
import { maskConnectionString, parseDbUrl, type SslMode } from '../../../db/connection-url.js'
import { knexClientFor } from '../../../db/mysql-flavor.js'
import { mssqlTlsOptions, sqlSslOption, type TlsSettings } from '../../../db/tls-options.js'

export type HubDbEngine = 'mssql' | 'pg' | 'mysql2' | 'mariadb'
export const PROVISION_ENGINES: readonly HubDbEngine[] = ['mssql', 'pg', 'mysql2', 'mariadb']
export const DEFAULT_PORTS: Record<HubDbEngine, number> = {
  mssql: 1433,
  pg: 5432,
  mysql2: 3306,
  mariadb: 3306
}

export interface HubDbConnection {
  engine: HubDbEngine
  host: string
  port: number | null
  database: string
  user: string
  password: string
  ssl_mode: SslMode | null
  trust_server_cert: boolean
}

const SSL_MODES: readonly SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full']
const SCHEME: Record<HubDbEngine, string> = {
  mssql: 'sqlserver',
  pg: 'postgres',
  mysql2: 'mysql',
  mariadb: 'mariadb'
}

/** The connection string the app reads as DB_URL. */
export function connectionUrl(c: HubDbConnection): string {
  const enc = encodeURIComponent
  const host = c.host.includes(':') && !c.host.startsWith('[') ? `[${c.host}]` : c.host
  let url = `${SCHEME[c.engine]}://${enc(c.user)}:${enc(c.password)}@${host}`
  if (c.port != null) url += `:${c.port}`
  url += `/${enc(c.database)}`
  const q: string[] = []
  if (c.engine === 'mssql') {
    if (c.ssl_mode === 'disable') q.push('encrypt=false')
    else if (c.ssl_mode) {
      q.push('encrypt=true')
      q.push(`trustServerCertificate=${c.trust_server_cert || c.ssl_mode === 'require'}`)
    }
  } else if (c.ssl_mode) q.push(`sslmode=${c.ssl_mode}`)
  return q.length ? `${url}?${q.join('&')}` : url
}

type FromInput =
  | { ok: true; conn: HubDbConnection }
  | { ok: false; code: 'BAD_CONNECTION'; message: string }

const bad = (message: string): FromInput => ({ ok: false, code: 'BAD_CONNECTION', message })

// Control characters (incl. NUL) never belong in a name, host, user or password.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const CONTROL = /[\u0000-\u001f\u007f]/

function text(
  v: unknown,
  label: string,
  max: number,
  opts: { spaces?: boolean } = {}
): string | null {
  if (typeof v !== 'string' || v.length === 0) return `${label} is required`
  if (v.length > max) return `${label} is too long`
  if (CONTROL.test(v)) return `${label} has characters that are not allowed`
  if (!opts.spaces && /\s/.test(v)) return `${label} must not contain spaces`
  return null
}

/**
 * Accepts `{ url }` (parsed by parseDbUrl) or the parts:
 * `{ engine, host, port?, database, user, password, ssl_mode?, trust_server_cert? }`.
 * Messages never repeat a password.
 */
export function connectionFromInput(v: unknown): FromInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('A connection is required')
  const o = v as Record<string, unknown>
  let engine: unknown = o.engine
  let host: unknown = o.host
  let port: unknown = o.port
  let database: unknown = o.database
  let user: unknown = o.user
  let password: unknown = o.password
  let ssl: unknown = o.ssl_mode
  let trust: unknown = o.trust_server_cert

  if (o.url !== undefined && o.url !== null && o.url !== '') {
    if (typeof o.url !== 'string' || o.url.length > 2000)
      return bad('The connection URL is not valid')
    let p: ReturnType<typeof parseDbUrl>
    try {
      p = parseDbUrl(o.url)
    } catch (err) {
      return bad(maskConnectionString((err as Error).message).slice(0, 300))
    }
    engine = p.client
    host = p.host
    port = p.port ?? null
    database = p.database
    user = p.user
    password = p.password
    ssl = p.sslMode ?? null
    trust = p.trustServerCertificate ?? p.sslMode === 'require'
  }

  if (typeof engine !== 'string' || !(PROVISION_ENGINES as readonly string[]).includes(engine))
    return bad('The database engine must be one of mssql, pg, mysql2 or mariadb')
  for (const [value, label, max, spaces] of [
    [host, 'The host', 255, false],
    [database, 'The database name', 128, true],
    [user, 'The user', 128, true],
    [password, 'The password', 256, true]
  ] as const) {
    const err = text(value, label, max, { spaces })
    if (err) return bad(err)
  }
  let portNum: number | null = null
  if (port !== undefined && port !== null && port !== '') {
    portNum = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : (port as number)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)
      return bad('The port must be between 1 and 65535')
  }
  let sslMode: SslMode | null = null
  if (ssl !== undefined && ssl !== null && ssl !== '') {
    if (typeof ssl !== 'string' || !(SSL_MODES as readonly string[]).includes(ssl))
      return bad(`ssl_mode must be one of ${SSL_MODES.join(', ')}`)
    sslMode = ssl as SslMode
  }
  if (trust !== undefined && trust !== null && typeof trust !== 'boolean')
    return bad('trust_server_cert must be true or false')
  return {
    ok: true,
    conn: {
      engine: engine as HubDbEngine,
      host: host as string,
      port: portNum,
      database: database as string,
      user: user as string,
      password: password as string,
      ssl_mode: sslMode,
      trust_server_cert: trust === true
    }
  }
}

const CONNECT_MS = 10_000
const STATEMENT_MS = 120_000

/**
 * A knex config for one short-lived provisioning or check connection (one pool slot, bounded
 * waits). `database: null` connects to the server's maintenance database. The caller destroys
 * the knex in `finally`.
 */
export function knexConfigFor(
  c: Omit<HubDbConnection, 'database'> & { database: string | null }
): Knex.Config {
  const port = c.port ?? DEFAULT_PORTS[c.engine]
  const base = { ...knexClientFor(c.engine), acquireConnectionTimeout: CONNECT_MS }
  if (c.engine === 'mssql') {
    // tedious always checks the host name when it checks the certificate.
    const mode =
      c.ssl_mode && c.trust_server_cert && c.ssl_mode !== 'disable' ? 'require' : c.ssl_mode
    const tls: TlsSettings = mode
      ? { DB_SSL_MODE: mode }
      : { DB_ENCRYPT: true, DB_TRUST_SERVER_CERT: c.trust_server_cert }
    return {
      ...base,
      pool: { min: 0, max: 1 },
      connection: {
        server: c.host,
        port,
        ...(c.database ? { database: c.database } : {}),
        user: c.user,
        password: c.password,
        options: {
          ...mssqlTlsOptions(tls),
          requestTimeout: STATEMENT_MS,
          connectTimeout: CONNECT_MS,
          appName: 'nivaro-hub'
        }
      }
    } as Knex.Config
  }
  const tls: TlsSettings = c.ssl_mode ? { DB_SSL_MODE: c.ssl_mode } : { DB_ENCRYPT: false }
  const ssl = sqlSslOption(c.engine, tls, undefined, c.host)
  if (c.engine === 'pg')
    return {
      ...base,
      pool: { min: 0, max: 1 },
      connection: {
        host: c.host,
        port,
        user: c.user,
        password: c.password,
        database: c.database ?? 'postgres',
        ssl,
        statement_timeout: STATEMENT_MS,
        query_timeout: STATEMENT_MS,
        connectionTimeoutMillis: CONNECT_MS
      }
    } as Knex.Config
  // MySQL: max_execution_time (ms, SELECT only); MariaDB: max_statement_time (seconds, all).
  const limit =
    c.engine === 'mariadb'
      ? `SET SESSION max_statement_time = ${STATEMENT_MS / 1000}`
      : `SET SESSION max_execution_time = ${STATEMENT_MS}`
  return {
    ...base,
    pool: {
      min: 0,
      max: 1,
      afterCreate: (
        conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
        done: (err: Error | null, conn: unknown) => void
      ) => conn.query(limit, (err) => done(err, conn))
    },
    connection: {
      host: c.host,
      port,
      user: c.user,
      password: c.password,
      ...(c.database ? { database: c.database } : {}),
      ssl,
      connectTimeout: CONNECT_MS
    }
  } as Knex.Config
}

/**
 * Text safe to store and show: connection strings lose their user and password, every secret
 * (and its percent-encoded form) becomes '••••', at most 300 characters.
 */
export function scrubDbError(err: unknown, secrets: Array<string | null | undefined>): string {
  let s: string
  if (err instanceof Error) s = err.message
  else if (typeof err === 'string') s = err
  else {
    try {
      s = JSON.stringify(err) ?? String(err)
    } catch {
      s = String(err)
    }
  }
  s = s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, (m) =>
    maskConnectionString(m).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/i, '$1••••@')
  )
  s = maskConnectionString(s).replace(/\b(password|pwd)(\s*=\s*)[^;&\s]*/gi, '$1$2••••')
  const list = new Set<string>()
  for (const x of secrets) {
    if (!x) continue
    list.add(x)
    list.add(encodeURIComponent(x))
  }
  for (const x of [...list].sort((a, b) => b.length - a.length)) s = s.split(x).join('••••')
  return s.slice(0, 300)
}
