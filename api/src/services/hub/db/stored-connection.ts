// What the sealed `connection` column of nivaro_hub_databases holds, shared by servers.ts and
// databases.ts: the connection, the ownership markers with the place they were made on, and the
// server identity a check read.
//
// Markers (rulings P3-12, P3-18): `made.database` / `made.login` are written only right after the
// provisioner answered 'created', together with `made.at` = the engine, host and port the object
// was made on. A marker counts only while the server still points at that same place; a marker
// without `made.at` never counts (fail closed).
import { HubSecretError, openSecret, sealSecret } from '../secrets.js'
import { DEFAULT_PORTS, type HubDbConnection, type HubDbEngine } from './connection.js'

export interface DbPlace {
  engine: HubDbEngine
  host: string
  port: number
}

export interface StoredConnection extends HubDbConnection {
  made?: { database?: boolean; login?: boolean; at?: DbPlace }
  /** `engine|server|port|database` as the database itself reported it (P3-19). */
  identity?: string | null
}

/** A port as the engine will use it: null means the engine's default. */
export function normPort(engine: HubDbEngine, port: number | null | undefined): number {
  return port ?? DEFAULT_PORTS[engine]
}

export function placeOf(o: {
  engine: HubDbEngine
  host: string
  port: number | null | undefined
}): DbPlace {
  return { engine: o.engine, host: o.host.trim().toLowerCase(), port: normPort(o.engine, o.port) }
}

export function samePlace(a: DbPlace, b: DbPlace): boolean {
  return a.engine === b.engine && a.host === b.host && Number(a.port) === Number(b.port)
}

export function hasMarkers(s: StoredConnection | null): boolean {
  return !!(s?.made?.database || s?.made?.login)
}

/** Opens a sealed connection; null when none is stored. Damaged → HubSecretError. */
export function openStoredConnection(sealed: string | null): StoredConnection | null {
  const plain = openSecret(sealed)
  if (!plain) return null
  let v: unknown
  try {
    v = JSON.parse(plain)
  } catch {
    v = null
  }
  const o = v as StoredConnection | null
  if (!o || typeof o.password !== 'string' || typeof o.user !== 'string')
    throw new HubSecretError('HUB_SECRET_UNREADABLE', 'The stored connection is damaged.')
  return o
}

export function sealStoredConnection(c: StoredConnection): string {
  return sealSecret(JSON.stringify(c))
}

export function plainConnection(c: StoredConnection): HubDbConnection {
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
