/**
 * Which server and database a connection really reached, and which sign-in issuer a deployment
 * uses — the facts the Nivaro Hub compares before it moves an app or lists its database (ruling
 * R2, Decision 13). ONE copy, used by the Hub's database checks (services/hub/db/databases.ts),
 * a shared deployment's db-check (services/tenancy/app-status.ts) and a dedicated app's shared
 * readiness (services/hub-link/shared-readiness.ts). Leaf: no imports.
 */

export type DbIdentityEngine = 'mssql' | 'pg' | 'mysql2' | 'mariadb'

/** Read-only fixed statements (no input): an alias, an IP and a name for the same server all
 *  resolve to one identity. SQLite has none (a file, no server). */
export const DB_IDENTITY_SQL: Readonly<Record<DbIdentityEngine, string>> = {
  mssql: 'SELECT CAST(@@SERVERNAME AS nvarchar(256)) AS s, CAST(NULL AS int) AS p, DB_NAME() AS d',
  pg: "SELECT COALESCE(host(inet_server_addr()), '') AS s, inet_server_port() AS p, current_database() AS d",
  mysql2: 'SELECT @@hostname AS s, @@port AS p, DATABASE() AS d',
  mariadb: 'SELECT @@hostname AS s, @@port AS p, DATABASE() AS d'
}

/** The engine's usual port, for a server that does not report its own (SQL Server). */
export const DB_IDENTITY_DEFAULT_PORT: Readonly<Record<DbIdentityEngine, number>> = {
  mssql: 1433,
  pg: 5432,
  mysql2: 3306,
  mariadb: 3306
}

/** The statement for an engine name, or null (SQLite, an unknown client). */
export function dbIdentitySql(engine: string): string | null {
  return Object.hasOwn(DB_IDENTITY_SQL, engine) ? DB_IDENTITY_SQL[engine as DbIdentityEngine] : null
}

/**
 * `engine|server|port|database`, lower case, from the row DB_IDENTITY_SQL answered. A value the
 * server left empty comes from `fallback` (the configured host, port, database).
 */
export function formatDbIdentity(
  engine: string,
  row: { s?: unknown; p?: unknown; d?: unknown } | undefined,
  fallback: { server: string; port: number | null; database: string }
): string {
  const server = String(row?.s ?? '').trim() || fallback.server
  const port = row?.p != null && row.p !== '' ? Number(row.p) : fallback.port
  const database = String(row?.d ?? '').trim() || fallback.database
  return `${engine}|${server}|${port}|${database}`.toLowerCase()
}

/** The deployment's OIDC issuer as the Hub compares it (Decision 13): host, plus the Entra tenant
 *  segment (`login.microsoftonline.com/<tenant>/v2.0`); null when no issuer is set. */
export function oidcIdentity(
  issuer: string | null | undefined
): { issuer_host: string; tenant: string | null } | null {
  const raw = (issuer ?? '').trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    const first = u.pathname.split('/').filter(Boolean)[0] ?? ''
    const tenant = first && !/^v\d/i.test(first) ? first.toLowerCase() : null
    return { issuer_host: u.host.toLowerCase(), tenant }
  } catch {
    return null
  }
}
