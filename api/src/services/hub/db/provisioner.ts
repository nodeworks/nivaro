// The Hub's database provisioners (plan decisions 1, 2 and 5): one per engine behind one
// interface, and the two short-lived connections they run on.
//
//   withServerKnex — the provisioning login on the server's maintenance database (master /
//                    postgres / none), for probe, existence reads, ensure* and drop.
//   withAppKnex    — the app's own login on its own database, for the read-only checkApp.
//
// Each opens its own knex (one connection, bounded waits — knexConfigFor), never the Hub's pool,
// and destroys it in `finally`. Both remember the credentials they connected with, so any error
// that leaves them is scrubbed of the password and the login (Review Focus 3).
import knexFactory, { type Knex } from 'knex'
import type { SslMode } from '../../../db/connection-url.js'
import { type HubDbConnection, type HubDbEngine, knexConfigFor } from './connection.js'
import { mssqlProvisioner } from './mssql.js'
import { mysqlProvisioner } from './mysql.js'
import { pgProvisioner } from './pg.js'
import {
  ProvisionError,
  type Provisioner,
  rememberSecrets,
  type Secrets,
  scrubbingProvisioner,
  scrubText
} from './provision-common.js'

const MSSQL = scrubbingProvisioner(mssqlProvisioner)
const PG = scrubbingProvisioner(pgProvisioner)

export {
  type DbCheck,
  type DbCheckState,
  type EnsureLoginOptions,
  isCollation,
  isUserHost,
  ProvisionError,
  type ProvisionErrorCode,
  type Provisioner,
  rememberSecrets,
  type Secrets,
  type ServerProbe,
  scrubText
} from './provision-common.js'

/**
 * The provisioner for an engine. `user_host` is the MySQL / MariaDB account host from the server
 * row (default `%`; validated, else UNSAFE_IDENTIFIER). SQLite and anything else: refused.
 */
export function provisionerFor(
  engine: HubDbEngine,
  opts: { user_host?: string | null } = {}
): Provisioner {
  switch (engine) {
    case 'mssql':
      return MSSQL
    case 'pg':
      return PG
    case 'mysql2':
    case 'mariadb':
      return scrubbingProvisioner(mysqlProvisioner(engine, opts.user_host ?? null))
    default:
      throw new ProvisionError(
        'ENGINE_NOT_PROVISIONABLE',
        'The Hub can create databases on SQL Server, Postgres, MySQL and MariaDB only'
      )
  }
}

/**
 * Rethrow without secrets. A ProvisionError keeps its code; an application error (one with a
 * numeric `status`, e.g. the Hub service's own refusals) keeps its class with the message
 * scrubbed; anything else (a driver error: mysql2 carries the statement in `sql`, pg the detail)
 * is replaced by a ProvisionError DB_ERROR carrying only scrubbed text.
 */
function safeError(err: unknown, secrets: Secrets): Error {
  if (err instanceof ProvisionError) return new ProvisionError(err.code, scrubText(err, secrets))
  if (err instanceof Error && typeof (err as { status?: unknown }).status === 'number') {
    err.message = scrubText(err, secrets)
    return err
  }
  return new ProvisionError('DB_ERROR', scrubText(err, secrets))
}

async function withKnex<T>(
  config: Knex.Config,
  secrets: Secrets,
  fn: (k: Knex) => Promise<T>
): Promise<T> {
  let k: Knex | null = null
  try {
    k = knexFactory(config)
    rememberSecrets(k, secrets)
    return await fn(k)
  } catch (err) {
    throw safeError(err, secrets)
  } finally {
    if (k) await k.destroy().catch(() => undefined)
  }
}

export function withServerKnex<T>(
  server: {
    engine: HubDbEngine
    host: string
    port: number | null
    ssl_mode: SslMode | null
    trust_server_cert: boolean
  },
  admin: { user: string; password: string },
  fn: (k: Knex) => Promise<T>
): Promise<T> {
  provisionerFor(server.engine) // ENGINE_NOT_PROVISIONABLE before any connection
  const config = knexConfigFor({
    engine: server.engine,
    host: server.host,
    port: server.port,
    ssl_mode: server.ssl_mode,
    trust_server_cert: server.trust_server_cert,
    user: admin.user,
    password: admin.password,
    database: null
  })
  return withKnex(config, { passwords: [admin.password], logins: [admin.user] }, fn)
}

export function withAppKnex<T>(conn: HubDbConnection, fn: (k: Knex) => Promise<T>): Promise<T> {
  provisionerFor(conn.engine)
  return withKnex(knexConfigFor(conn), { passwords: [conn.password], logins: [conn.user] }, fn)
}
