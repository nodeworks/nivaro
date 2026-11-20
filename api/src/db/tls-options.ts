// Database TLS: one setting (DB_SSL_MODE, or the older DB_ENCRYPT + DB_TRUST_SERVER_CERT pair)
// turned into what each driver takes. A leaf module (fs only) so the tests can build options
// without a database. See docs/databases.md.
//
//   disable      plain connection
//   require      TLS, certificate not checked (libpq "require")
//   verify-ca    TLS, certificate must chain to a trusted CA (DB_SSL_CA or the system store);
//                any host name
//   verify-full  verify-ca + the certificate must name the host connected to
//
// Without DB_SSL_MODE and without DB_SSL_CA the options are exactly what they were before
// (DB_ENCRYPT false → no TLS; true → TLS, checked unless DB_TRUST_SERVER_CERT) — except MySQL,
// where DB_ENCRYPT=true + DB_TRUST_SERVER_CERT=false now also checks the host name (mysql2 only
// does with verifyIdentity), so the old pair means the same on every engine.
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import type { SslMode } from './connection-url.js'

export interface TlsSettings {
  DB_SSL_MODE?: string
  DB_SSL_CA?: string
  DB_ENCRYPT?: boolean
  DB_TRUST_SERVER_CERT?: boolean
}

export interface ResolvedTls {
  mode: SslMode
  /** PEM text of the CA bundle, when DB_SSL_CA names one. */
  ca?: string
}

const MODES: readonly SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full']

/** DB_SSL_CA is a PEM file path, or the PEM text itself (what DB_SSL_CA_FILE puts there). */
export function readCa(
  value: string | undefined,
  read: (p: string) => string = readPem
): string | undefined {
  const v = value?.trim()
  if (!v) return undefined
  if (v.startsWith('-----BEGIN')) return v
  return read(v)
}

function readPem(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(
      `DB_SSL_CA: cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`
    )
  }
}

export function resolveTls(s: TlsSettings, read?: (p: string) => string): ResolvedTls {
  const ca = readCa(s.DB_SSL_CA, read)
  const raw = s.DB_SSL_MODE?.trim().toLowerCase()
  let mode: SslMode
  if (raw) {
    if (!(MODES as readonly string[]).includes(raw))
      throw new Error(`DB_SSL_MODE must be one of ${MODES.join(', ')} (got "${s.DB_SSL_MODE}")`)
    mode = raw as SslMode
  } else if (!s.DB_ENCRYPT) {
    // A CA alone turns TLS on (verify-ca): naming a CA and getting a plain connection is a trap.
    mode = ca ? 'verify-ca' : 'disable'
  } else mode = s.DB_TRUST_SERVER_CERT === false ? 'verify-full' : 'require'
  // libpq: sslmode=require with a root certificate verifies the chain.
  if (mode === 'require' && ca) mode = 'verify-ca'
  return { mode, ...(ca ? { ca } : {}) }
}

/** True when the settings are the legacy pair with no DB_SSL_MODE and no CA. */
function legacy(s: TlsSettings): boolean {
  return !s.DB_SSL_MODE?.trim() && !s.DB_SSL_CA?.trim()
}

/**
 * `ssl` for node-postgres and mysql2 connections. `host` is the address connected to: an IP
 * address there needs its own identity check on Postgres (node-postgres sends no server name
 * for an IP, and Node then checks the certificate against "localhost"). mysql2 skips the host
 * check for an IP address altogether — use the host name with verify-full on MySQL.
 */
export function sqlSslOption(
  client: string,
  s: TlsSettings,
  read?: (p: string) => string,
  host?: string
): false | Record<string, unknown> {
  if (legacy(s) && client !== 'mysql2' && client !== 'mariadb')
    // Unchanged from before DB_SSL_MODE existed.
    return s.DB_ENCRYPT ? { rejectUnauthorized: !s.DB_TRUST_SERVER_CERT } : false
  const { mode, ca } = resolveTls(s, read)
  const mysql = client === 'mysql2' || client === 'mariadb'
  switch (mode) {
    case 'disable':
      return false
    case 'require':
      return { rejectUnauthorized: false }
    case 'verify-ca':
      return mysql
        ? { rejectUnauthorized: true, ...(ca ? { ca } : {}), verifyIdentity: false }
        : { rejectUnauthorized: true, ...(ca ? { ca } : {}), checkServerIdentity: () => undefined }
    case 'verify-full':
      if (mysql) return { rejectUnauthorized: true, ...(ca ? { ca } : {}), verifyIdentity: true }
      return {
        rejectUnauthorized: true,
        ...(ca ? { ca } : {}),
        ...(host && isIP(host)
          ? {
              checkServerIdentity: (_: string, cert: PeerCertificate) =>
                checkServerIdentity(host, cert)
            }
          : {})
      }
  }
}

/** The TLS part of tedious `options` (SQL Server / Azure SQL). */
export function mssqlTlsOptions(
  s: TlsSettings,
  read?: (p: string) => string
): {
  encrypt: boolean
  trustServerCertificate: boolean
  cryptoCredentialsDetails?: { ca: string }
} {
  if (legacy(s))
    // Unchanged from before DB_SSL_MODE existed.
    return {
      encrypt: s.DB_ENCRYPT as boolean,
      trustServerCertificate: s.DB_TRUST_SERVER_CERT as boolean
    }
  const { mode, ca } = resolveTls(s, read)
  // tedious always checks the host name when it checks the certificate: verify-ca and
  // verify-full are the same on SQL Server.
  return {
    encrypt: mode !== 'disable',
    trustServerCertificate: mode === 'require' || mode === 'disable',
    ...(ca ? { cryptoCredentialsDetails: { ca } } : {})
  }
}

/** One line for logs and /api/health: the mode and whether a CA file is used. */
export function describeTls(client: string, s: TlsSettings): string {
  try {
    const { mode, ca } = resolveTls(s, () => 'x')
    return `${mode}${ca ? ' (DB_SSL_CA)' : ''}${client === 'mssql' && mode === 'verify-ca' ? ' (= verify-full on SQL Server)' : ''}`
  } catch {
    return 'invalid'
  }
}
