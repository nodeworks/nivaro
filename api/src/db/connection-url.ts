// DB_URL — one connection string for the database, the way managed services hand them out
// (Amazon RDS / Aurora, Google Cloud SQL, Azure Flexible Server / Azure SQL, Neon, Supabase,
// Crunchy Bridge). See docs/databases.md.
//
// A leaf module: no config, no db, no knex. config.ts calls applyDbUrl(process.env) after the
// secret files are read (so DB_URL_FILE works) and before the schema parses the environment.
//
// Precedence: an explicit DB_* variable beats the same part of the URL. When both are set and
// disagree the boot log says so (naming the variable, never a password).

/** What a URL scheme selects as DB_CLIENT. `mariadb` is mapped here; the MariaDB dialect itself
 *  is added on its own branch (p3/mariadb) — until it is merged config.ts refuses the value. */
const SCHEMES: Record<string, string> = {
  postgres: 'pg',
  postgresql: 'pg',
  pg: 'pg',
  mysql: 'mysql2',
  mysql2: 'mysql2',
  mariadb: 'mariadb',
  sqlserver: 'mssql',
  mssql: 'mssql'
}

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'
const SSL_MODES: readonly SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full']

export interface ParsedDbUrl {
  client: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  /** Normalised sslmode, when the URL named one (sslmode / ssl / ssl-mode / encrypt). */
  sslMode?: SslMode
  /** SQL Server only: trustServerCertificate as written. */
  trustServerCertificate?: boolean
  /** sslrootcert / ssl-ca: a PEM file path. */
  sslRootCert?: string
  /** Postgres startup options (libpq `options`), e.g. `-c search_path=app` or Neon's `endpoint=ep-x`. */
  options?: string
  /** The URL says a transaction pooler sits in front (`pgbouncer=true`, Prisma style). */
  pooler?: boolean
  /** Things the URL said that Nivaro does not act on — for the boot log. */
  notes: string[]
}

const truthy = (v: string) => /^(1|true|yes|on|required?)$/i.test(v.trim())
const falsy = (v: string) => /^(0|false|no|off|disabled?)$/i.test(v.trim())

/** libpq sslmode, MySQL ssl-mode and the ssl=true|false shorthand → one of SSL_MODES. */
export function normaliseSslMode(raw: string): { mode?: SslMode; note?: string } {
  const v = raw.trim().toLowerCase().replace(/_/g, '-')
  if ((SSL_MODES as readonly string[]).includes(v)) return { mode: v as SslMode }
  if (v === 'disabled') return { mode: 'disable' }
  if (v === 'required') return { mode: 'require' }
  if (v === 'verify-identity') return { mode: 'verify-full' }
  if (v === 'prefer' || v === 'preferred' || v === 'allow')
    return {
      mode: 'require',
      note: `sslmode=${raw} is treated as require (the drivers cannot fall back to a plain connection)`
    }
  if (truthy(v)) return { mode: 'require' }
  if (falsy(v)) return { mode: 'disable' }
  return { note: `unknown sslmode "${raw}" ignored` }
}

// Parameters that are fine to carry and need nothing from Nivaro (or are pool settings of other
// tools that a copied URL often contains). Anything else is named in the boot log as ignored.
const QUIET_PARAMS = new Set([
  'application_name',
  'connect_timeout',
  'target_session_attrs',
  'channel_binding',
  'connection_limit',
  'pool_timeout',
  'schema',
  'logintimeout',
  'connecttimeout',
  'connection timeout',
  'hostnameincertificate',
  'charset',
  'timezone',
  'applicationname',
  'application name',
  'multisubnetfailover'
])

function stripJdbc(raw: string): string {
  return raw.trim().replace(/^jdbc:/i, '')
}

const unbrace = (v: string) =>
  v
    .trim()
    .replace(/^\{(.*)\}$/s, '$1')
    .replace(/\}\}/g, '}')

/** Split a JDBC property list on `;`, keeping `{…}`-braced values (which may hold `;`) whole. */
function splitJdbc(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let brace = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (brace) {
      if (ch === '}' && s[i + 1] === '}') {
        cur += '}}'
        i++
        continue
      }
      if (ch === '}') brace = false
      cur += ch
    } else if (ch === '{' && /=\s*$/.test(cur)) {
      // A braced value only when '{' opens the value (first non-space after '=').
      brace = true
      cur += ch
    } else if (ch === ';') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Parse a connection string. Throws an Error whose message never contains the password.
 *
 *   postgres://user:pass@host:5432/db?sslmode=verify-full&sslrootcert=/ca.pem
 *   mysql://user:pass@host:3306/db?ssl-mode=REQUIRED
 *   sqlserver://user:pass@host:1433/db?encrypt=true&trustServerCertificate=false
 *   sqlserver://host:1433;database=db;user=u;password=p;encrypt=true   (JDBC / Azure portal form)
 */
export function parseDbUrl(raw: string): ParsedDbUrl {
  const s = stripJdbc(raw)
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)
  if (!m)
    throw new Error('DB_URL must start with a scheme such as postgres://, mysql:// or sqlserver://')
  const scheme = m[1].toLowerCase()
  const client = SCHEMES[scheme]
  if (!client)
    throw new Error(
      `DB_URL scheme "${scheme}://" is not supported (use postgres://, postgresql://, mysql://, mariadb://, sqlserver:// or mssql://)`
    )
  const out: ParsedDbUrl = { client, notes: [] }
  const rest = s.slice(m[0].length)

  // SQL Server JDBC form: host[\instance][:port];key=value;key=value
  if (client === 'mssql' && /^[^/?]*;/.test(rest)) {
    const [hostPart, ...pairs] = splitJdbc(rest)
    parseHostPort(hostPart, out)
    const kv: Array<[string, string]> = []
    for (const p of pairs) {
      if (!p.trim()) continue
      const i = p.indexOf('=')
      if (i < 0) continue
      kv.push([p.slice(0, i).trim(), unbrace(p.slice(i + 1))])
    }
    applyParams(kv, out)
    return out
  }

  let u: URL
  try {
    // A non-special scheme: no default port is dropped (http would drop :80), no IDNA mangling.
    u = new URL(`nivaro-db://${rest}`)
  } catch {
    throw new Error(
      `DB_URL could not be parsed as ${scheme}:// URL (check special characters in the password are percent-encoded)`
    )
  }
  if (u.hostname) out.host = u.hostname.replace(/^\[(.*)\]$/, '$1')
  if (u.port) out.port = Number(u.port)
  if (u.username) out.user = decodeURIComponent(u.username)
  if (u.password) out.password = decodeURIComponent(u.password)
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (db) out.database = db
  if (out.host?.includes(','))
    throw new Error('DB_URL with several hosts is not supported — name one host')
  applyParams([...u.searchParams.entries()], out)
  return out
}

function parseHostPort(hostPart: string, out: ParsedDbUrl) {
  const hp = /^\[?([^\]]*?)\]?(?::(\d+))?$/.exec(hostPart.trim())
  if (hp?.[1]) out.host = hp[1]
  if (hp?.[2]) out.port = Number(hp[2])
}

function applyParams(kv: Array<[string, string]>, out: ParsedDbUrl) {
  for (const [rawKey, value] of kv) {
    const key = rawKey.trim().toLowerCase()
    switch (key) {
      case 'sslmode':
      case 'ssl-mode':
      case 'ssl_mode':
      case 'ssl': {
        const r = normaliseSslMode(value)
        if (r.mode) out.sslMode = r.mode
        if (r.note) out.notes.push(r.note)
        break
      }
      case 'encrypt': {
        // SQL Server: encrypt=strict (TDS 8) is still TLS; Nivaro's driver negotiates TLS 1.2.
        if (falsy(value)) out.sslMode = 'disable'
        else if (
          truthy(value) ||
          value.toLowerCase() === 'strict' ||
          value.toLowerCase() === 'mandatory'
        )
          out.sslMode = out.sslMode && out.sslMode !== 'disable' ? out.sslMode : 'verify-full'
        break
      }
      case 'trustservercertificate':
        out.trustServerCertificate = truthy(value)
        break
      case 'sslrootcert':
      case 'ssl-ca':
      case 'ssl_ca':
      case 'sslca':
        out.sslRootCert = value
        break
      case 'options':
        out.options = value
        break
      case 'pgbouncer':
        if (truthy(value)) out.pooler = true
        break
      case 'host':
        // libpq: ?host= overrides the authority (unix sockets, or a host the authority cannot hold)
        if (value) out.host = value
        break
      case 'port':
        if (/^\d+$/.test(value)) out.port = Number(value)
        break
      case 'database':
      case 'databasename':
      case 'dbname':
      case 'initial catalog':
        if (value) out.database = value
        break
      case 'user':
      case 'username':
      case 'user id':
      case 'uid':
        if (value) out.user = value
        break
      case 'password':
      case 'pwd':
        if (value) out.password = value
        break
      case 'sslcert':
      case 'sslkey':
      case 'ssl-cert':
      case 'ssl-key':
        out.notes.push(`${rawKey} (client certificates) is not supported and was ignored`)
        break
      default:
        if (!QUIET_PARAMS.has(key)) out.notes.push(`parameter "${rawKey}" ignored`)
    }
  }
  // SQL Server: a driver verifies the certificate unless told to trust it. DB_TRUST_SERVER_CERT
  // defaults to true for the old DB_* form; a URL that says encrypt=true means verify.
  if (out.client === 'mssql' && out.sslMode && out.sslMode !== 'disable') {
    if (out.trustServerCertificate === true) out.sslMode = 'require'
  }
}

export interface ApplyDbUrlResult {
  /** Variables set from the URL. */
  applied: string[]
  /** Explicit variables that won over a different value in the URL. */
  conflicts: string[]
  /** Boot-log lines (never a password). */
  warnings: string[]
  errors: string[]
}

/**
 * Fill DB_* variables from DB_URL (and the migration URL's client check). Explicit variables
 * win. Mutates `env`.
 */
export function applyDbUrl(env: NodeJS.ProcessEnv = process.env): ApplyDbUrlResult {
  const res: ApplyDbUrlResult = { applied: [], conflicts: [], warnings: [], errors: [] }
  const raw = env.DB_URL?.trim()
  if (raw) {
    let p: ParsedDbUrl
    try {
      p = parseDbUrl(raw)
    } catch (err) {
      res.errors.push((err as Error).message)
      return res
    }
    const tlsExplicit =
      !!env.DB_SSL_MODE || env.DB_ENCRYPT !== undefined || env.DB_TRUST_SERVER_CERT !== undefined
    const fill = (name: string, value: string | undefined, secret = false) => {
      if (value === undefined || value === '') return
      const cur = env[name]
      if (cur === undefined || cur === '') {
        env[name] = value
        res.applied.push(name)
      } else if (cur !== value) {
        res.conflicts.push(name)
        res.warnings.push(
          secret
            ? `${name} is set and differs from the one in DB_URL — using ${name}`
            : `${name}=${cur} is set and differs from DB_URL (${value}) — using ${name}`
        )
      }
    }
    fill('DB_CLIENT', p.client)
    fill('DB_HOST', p.host)
    fill('DB_PORT', p.port !== undefined ? String(p.port) : undefined)
    fill('DB_USER', p.user)
    fill('DB_PASSWORD', p.password, true)
    fill('DB_DATABASE', p.database)
    fill('DB_SSL_CA', p.sslRootCert)
    fill('DB_OPTIONS', p.options)
    if (p.pooler) fill('DB_POOLER', 'transaction')
    if (p.sslMode) {
      if (tlsExplicit) {
        const mine = env.DB_SSL_MODE
        if (mine && mine !== p.sslMode)
          res.warnings.push(
            `DB_SSL_MODE=${mine} is set and differs from DB_URL (${p.sslMode}) — using DB_SSL_MODE`
          )
        else if (!mine)
          res.warnings.push(
            `DB_ENCRYPT / DB_TRUST_SERVER_CERT are set — the TLS setting in DB_URL (${p.sslMode}) is not used`
          )
      } else {
        env.DB_SSL_MODE = p.sslMode
        res.applied.push('DB_SSL_MODE')
      }
    }
    if (p.options && p.client !== 'pg')
      res.warnings.push('DB_URL options= is used by Postgres only')
    for (const n of p.notes) res.warnings.push(`DB_URL: ${n}`)
  }
  const mig = env.DB_MIGRATION_URL?.trim()
  if (mig) {
    try {
      const m = parseDbUrl(mig)
      const client = env.DB_CLIENT || 'mssql'
      if (m.client !== client)
        res.errors.push(
          `DB_MIGRATION_URL is a ${m.client} URL but DB_CLIENT is ${client} — it must point at the same database`
        )
    } catch (err) {
      res.errors.push(`DB_MIGRATION_URL: ${(err as Error).message}`)
    }
  }
  return res
}

/** config.ts: apply DB_URL to process.env; exit on a URL that cannot be used. */
export function applyDbUrlToProcess(): void {
  const r = applyDbUrl(process.env)
  for (const w of r.warnings) console.warn(`[config] ${w}`)
  if (r.applied.length) console.log(`[config] from DB_URL: ${r.applied.join(', ')}`)
  if (r.errors.length) {
    console.error('Invalid environment configuration:')
    for (const e of r.errors) console.error(`  ${e}`)
    process.exit(1)
  }
}

/**
 * Hosts whose names say a transaction pooler sits in front: Neon's `-pooler` endpoints,
 * Supabase's Supavisor (pooler.supabase.com; port 6543 = transaction mode), Amazon RDS Proxy
 * (`.proxy-` endpoints) and PgBouncer's default port 6432. DB_POOLER=transaction|session|none
 * overrides the guess.
 */
export function guessPooler(
  host: string | undefined,
  port: number | undefined,
  setting?: string
): 'transaction' | 'session' | 'none' {
  const s = setting?.trim().toLowerCase()
  if (s === 'transaction' || s === 'session' || s === 'none') return s
  const h = (host ?? '').toLowerCase()
  if (/-pooler\./.test(h)) return 'transaction'
  if (/pooler\.supabase\.com$/.test(h)) return port === 5432 ? 'session' : 'transaction'
  if (/\.proxy-[a-z0-9]+\..*rds\.amazonaws\.com$/.test(h)) return 'transaction'
  if (port === 6432 || port === 6543) return 'transaction'
  return 'none'
}

const MASK = '••••••'

/** Env names whose value is a connection string (masked by parsing, whatever the value looks like). */
export function isConnectionStringKey(key: string): boolean {
  return /^(DB_URL|DB_MIGRATION_URL|REDIS_URL|DATABASE_URL)$|_(DB|DATABASE|REDIS)_URL$/i.test(key)
}

/**
 * A connection string with every password replaced. Fails CLOSED: anything that could be a
 * password is masked, even when that also hides part of the host or query.
 *
 *  1. JDBC / ODBC `key=value;` lists: password / pwd values, `{…}` braced values (with `}}`
 *     escapes) only when the brace opens the value.
 *  2. URL userinfo, by text (never trusting a URL parser): after `scheme://`, from the first ':'
 *     to the LAST '@' — first within the authority (up to the first '/'), then over the whole
 *     rest, so a password holding '/', '@', '?' or '#' is still covered.
 *  3. `password=` / `pwd=` query parameters up to the next '&'.
 *  4. Backstop: `password=` / `pwd=` after start, ';', '?' or '&' up to the next ';' or the end.
 */
export function maskConnectionString(raw: string): string {
  let s = raw
  if (/(^|;)\s*(password|pwd)\s*=/i.test(s)) {
    s = splitJdbc(s)
      .map((part) => {
        const i = part.indexOf('=')
        if (i < 0) return part
        const k = part.slice(0, i).trim().toLowerCase()
        return k === 'password' || k === 'pwd' ? `${part.slice(0, i)}=${MASK}` : part
      })
      .join(';')
  }
  const m = /^(?:[a-z][a-z0-9+.-]*:)?[a-z][a-z0-9+.-]*:\/\//i.exec(s)
  if (m) {
    const head = m[0]
    let rest = s.slice(head.length)
    const maskSpan = (span: string): string => {
      const at = span.lastIndexOf('@')
      const colon = span.indexOf(':')
      return at > 0 && colon >= 0 && colon < at
        ? `${span.slice(0, colon + 1)}${MASK}${span.slice(at)}`
        : span
    }
    const slash = rest.indexOf('/')
    rest = slash < 0 ? maskSpan(rest) : maskSpan(rest.slice(0, slash)) + rest.slice(slash)
    rest = maskSpan(rest)
    s = head + rest
  }
  s = s.replace(/([?&](?:password|pwd)=)[^&]*/gi, `$1${MASK}`)
  return s.replace(/((?:^|[;?&])\s*(?:password|pwd)\s*=)[^;]*/gi, `$1${MASK}`)
}
