import { db } from '../../db/index.js'
import { OPEN_CREATION_STATUSES } from './create/store.js'
import {
  attachDatabase,
  checkDatabaseIdentity,
  getDatabase,
  type HubDatabase
} from './db/databases.js'
import type { DbCheck } from './db/provision-common.js'
import { databaseRecordId } from './docker/stack-env.js'
import { getPlacement } from './drivers.js'
import { type ReadinessRead, readSharedReadiness } from './move/gather.js'
import { OPEN_MOVE_STATUSES } from './move/rows.js'
import { defaultPromoteLock, lockHolderRefusal, type PromoteLock } from './promote-lock.js'
import { openSecret } from './secrets.js'

/**
 * Nivaro Hub phase 6 (ruling P6-32, E2E BUG-1): attach a Hub database record to an environment
 * that already exists, or detach it. Creation and place-shared attach their own records; an app
 * the Hub did not create needs this before it can move onto a shared deployment (the move plan's
 * NO_DATABASE_RECORD).
 *
 * Attach, under the environment's lock (holder `database`):
 *   - no open move, no open creation, not on a shared placement (its tenant list names the record:
 *     change it with a move);
 *   - nothing attached yet (detach first), the record ready and attached nowhere else (IN_USE);
 *   - the app's own report (its hub link) names the database it runs on: the engine must match
 *     (ENGINE_MISMATCH); an app that cannot be asked → ENGINE_UNVERIFIED. When the Hub's own check
 *     of the record reads another server identity, the answer warns (never refuses: the Hub may
 *     reach the same server by another address); the move plan's DB_IDENTITY check, made from the
 *     target's side, is what blocks a wrong database;
 *   - the record's connection check passes (a failed check refuses DATABASE_UNREACHABLE and the
 *     answer carries the check).
 * Detach: same lock and refusals (no open move or creation, not shared); the record stays.
 *
 * Nothing here returns or logs a connection, a password or the hub token.
 */

const ENVS = 'nivaro_hub_environments'
const MOVES = 'nivaro_hub_moves'
const CREATIONS = 'nivaro_hub_creations'

export class EnvDatabaseError extends Error {
  code: string
  status: number
  check?: DbCheck
  constructor(code: string, message: string, status = 409, check?: DbCheck) {
    super(message)
    this.name = 'EnvDatabaseError'
    this.code = code
    this.status = status
    if (check) this.check = check
  }
}

export interface EnvDatabaseDeps {
  lock?: PromoteLock
  /** The app's shared readiness through its hub link (move/gather.ts readSharedReadiness). */
  readiness?: (env: { base_url: string }, hubToken: string) => Promise<ReadinessRead>
  /** The record's connection check with the identity it read (databases.ts). */
  check?: typeof checkDatabaseIdentity
}

interface EnvRow {
  id: number
  base_url: string
  db_ref: string | null
  placement_id: number | null
  hub_token: string | null
}

/** mysql2 and mariadb speak to the same servers: one family. */
const family = (engine: string) => (engine === 'mariadb' ? 'mysql2' : engine)

async function readEnv(envId: number): Promise<EnvRow> {
  const row = (await db(ENVS)
    .where({ id: envId })
    .first('id', 'base_url', 'db_ref', 'placement_id', 'hub_token')) as EnvRow | undefined
  if (!row) throw new EnvDatabaseError('NOT_FOUND', 'No such environment.', 404)
  return row
}

/** Runs `fn` holding the environment's lock (holder `database`); refuses as its holder would. */
async function withEnvLock<T>(envId: number, lock: PromoteLock, fn: () => Promise<T>): Promise<T> {
  const token = await lock.take(envId, 'database')
  if (!token) {
    const r = lockHolderRefusal((await lock.holder?.(envId)) ?? null, {
      code: 'ENVIRONMENT_BUSY',
      message: 'Another action holds this environment — try again shortly.'
    })
    throw new EnvDatabaseError(r.code, r.message)
  }
  try {
    return await fn()
  } finally {
    await lock.release(envId, token).catch(() => undefined)
  }
}

/** Refusals shared by attach and detach: an open move or creation, a shared placement. */
async function refuseBusy(env: EnvRow): Promise<void> {
  if (
    await db(MOVES)
      .where({ environment_id: env.id })
      .whereIn('status', OPEN_MOVE_STATUSES as string[])
      .first('id')
  )
    throw new EnvDatabaseError(
      'MOVE_OPEN',
      'A move of this environment is open: its database record cannot change until the move ends or is rolled back.'
    )
  if (
    await db(CREATIONS)
      .where({ environment_id: env.id })
      .whereIn('status', OPEN_CREATION_STATUSES as string[])
      .first('id')
  )
    throw new EnvDatabaseError(
      'CREATION_OPEN',
      'This environment is still being created: the creation attaches its own database.'
    )
  if (env.placement_id != null && (await getPlacement(env.placement_id))?.kind === 'shared')
    throw new EnvDatabaseError(
      'SHARED_PLACEMENT',
      'This environment runs on a shared deployment, which serves it from this record: move it to change its database.'
    )
}

/** The `engine|server|port|database` the app itself reports through its hub link. */
async function appIdentity(env: EnvRow, deps: EnvDatabaseDeps): Promise<string> {
  const unverified = (why: string) =>
    new EnvDatabaseError(
      'ENGINE_UNVERIFIED',
      `The Hub could not ask the app which database it runs on (${why}), so it cannot check the engine. Make sure the environment is linked to the Hub and running, then try again.`
    )
  if (!env.hub_token) throw unverified('it is not linked to the Hub')
  let token: string | null
  try {
    token = openSecret(env.hub_token)
  } catch {
    token = null
  }
  if (!token) throw unverified('its hub token cannot be opened')
  let read: ReadinessRead
  try {
    read = await (deps.readiness ?? readSharedReadiness)(env, token)
  } catch {
    throw unverified('its hub link did not answer')
  }
  if (!read.ok) throw unverified(`its hub link answered ${read.code}`)
  if (!read.report.db_identity) throw unverified('it did not report its database')
  return read.report.db_identity
}

export async function attachEnvDatabase(
  envId: number,
  databaseId: unknown,
  deps: EnvDatabaseDeps = {}
): Promise<{
  database: HubDatabase
  check: DbCheck | null
  changed: boolean
  warning: string | null
}> {
  const id = typeof databaseId === 'number' ? databaseId : Number.NaN
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new EnvDatabaseError('BAD_DATABASE', 'database_id is the id of a Hub database.', 400)
  await readEnv(envId)
  return withEnvLock(envId, deps.lock ?? defaultPromoteLock(), async () => {
    const env = await readEnv(envId)
    await refuseBusy(env)
    const current = databaseRecordId(env.db_ref)
    const record = await getDatabase(id)
    if (!record) throw new EnvDatabaseError('NOT_FOUND', 'No such database.', 404)
    if (current === id) return { database: record, check: null, changed: false, warning: null }
    if (env.db_ref)
      throw new EnvDatabaseError(
        'ALREADY_ATTACHED',
        'This environment already has a database record: detach it first.'
      )
    if (record.environment && record.environment.id !== envId)
      throw new EnvDatabaseError(
        'IN_USE',
        `This database is attached to ${record.environment.app_key}/${record.environment.env_key}.`
      )
    if (record.status !== 'ready')
      throw new EnvDatabaseError(
        'DATABASE_NOT_READY',
        `The database is ${record.status}: only a ready database can be attached.`
      )
    const app = await appIdentity(env, deps)
    const appEngine = app.split('|', 1)[0]
    if (family(appEngine) !== family(record.engine))
      throw new EnvDatabaseError(
        'ENGINE_MISMATCH',
        `The app runs on ${appEngine} and this record is ${record.engine}: attach the record of the database the app uses.`
      )
    const { check, identity } = await (deps.check ?? checkDatabaseIdentity)(id)
    if (!check.ok)
      throw new EnvDatabaseError(
        'DATABASE_UNREACHABLE',
        'The Hub could not use this database with its stored connection; see the check.',
        409,
        check
      )
    await attachDatabase(id, envId, undefined, { expect: ['ready'] })
    const warning =
      identity && identity !== app
        ? "The Hub reaches this record's database under another server name or address than the app reports. If it is the same database, nothing is wrong; a move's plan checks it again from the target's side."
        : null
    return { database: (await getDatabase(id)) ?? record, check, changed: true, warning }
  })
}

export async function detachEnvDatabase(
  envId: number,
  deps: Pick<EnvDatabaseDeps, 'lock'> = {}
): Promise<{ database_id: number | null; changed: boolean }> {
  await readEnv(envId)
  return withEnvLock(envId, deps.lock ?? defaultPromoteLock(), async () => {
    const env = await readEnv(envId)
    await refuseBusy(env)
    if (!env.db_ref) return { database_id: null, changed: false }
    const n = await db(ENVS)
      .where({ id: envId, db_ref: env.db_ref })
      .update({ db_ref: null, updated_at: new Date() })
    if (!Number(n))
      throw new EnvDatabaseError('STATE_CHANGED', 'The environment changed meanwhile — try again.')
    return { database_id: databaseRecordId(env.db_ref), changed: true }
  })
}
