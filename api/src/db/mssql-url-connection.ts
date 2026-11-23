import { parseDbUrl } from './connection-url.js'
import { mssqlTlsOptions } from './tls-options.js'

/**
 * A SQL Server connection URL that carries options (`mssql://u:p@host:1433/db?encrypt=false`),
 * as a knex connection object. Handed to knex as a string, the URL's options reach tedious as
 * text: `encrypt=false` became the string "false", which tedious refuses ("The "encrypt" property
 * must be set to "strict", or of type boolean."), so every app database recorded with TLS off
 * failed to open on a shared deployment (its pool and the Hub's db-check, 2026-11-23).
 *
 * Null for anything else — a URL without options, the ADO `Server=…;` form, another engine — so
 * those keep the string knex has always been given (cloud tenants unchanged). TLS follows the URL
 * only (never this process's DB_* settings): `encrypt=false` = disable, `trustServerCertificate`
 * = require, otherwise the certificate is verified (tedious' own default).
 */
export function mssqlUrlConnection(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !/^(mssql|sqlserver):\/\/[^?]*\?./i.test(raw)) return null
  let u: ReturnType<typeof parseDbUrl>
  try {
    u = parseDbUrl(raw)
  } catch {
    return null
  }
  if (u.client !== 'mssql' || !u.host) return null
  return {
    server: u.host,
    port: u.port ?? 1433,
    ...(u.database ? { database: u.database } : {}),
    ...(u.user !== undefined ? { user: u.user } : {}),
    ...(u.password !== undefined ? { password: u.password } : {}),
    options: mssqlTlsOptions({
      DB_SSL_MODE: u.sslMode ?? 'verify-full',
      ...(u.sslRootCert ? { DB_SSL_CA: u.sslRootCert } : {})
    })
  }
}
