import { describeError, type ErrorDescription } from '@nivaro/shared'
import { api } from '@/lib/api'
import { type DbCheck, DescribedError, dbError, type HubDatabaseRow } from './db-api'

/**
 * Attach a Hub database record to an environment that already exists, or detach it (ruling
 * P6-32): PUT / DELETE /api/hub/environments/:envId/database. Hub admin only. An app the Hub did
 * not create needs this before it can move onto a shared deployment (NO_DATABASE_RECORD).
 */

/** Refusals of the attach / detach routes, in plain words (database codes fall back to db-api). */
export const ENV_DB_COPY: Record<string, { title: string; hint?: string }> = {
  BAD_DATABASE: { title: 'Pick a database first' },
  ALREADY_ATTACHED: {
    title: 'That environment already has a database record',
    hint: 'Detach its record first (open that database here), then attach this one.'
  },
  IN_USE: {
    title: 'Another environment uses this database',
    hint: 'A record is attached to one environment at a time.'
  },
  DATABASE_NOT_READY: { title: 'Only a ready database can be attached' },
  ENGINE_MISMATCH: {
    title: 'The app runs on another database engine',
    hint: 'Attach the record of the database the app really uses.'
  },
  ENGINE_UNVERIFIED: {
    title: 'The Hub could not ask the app which database it uses',
    hint: 'Make sure the environment is linked to the Hub and running, then try again.'
  },
  DATABASE_IDENTITY_DIFFERS: {
    title: 'The Hub reads another database than the app reports',
    hint: 'This environment runs on a Docker stack, and its next deploy would point the app at this record. If it is the same database under another address, attach it anyway; otherwise attach the record of the database the app really uses.'
  },
  DATABASE_UNREACHABLE: {
    title: 'The Hub could not use this database',
    hint: 'See the check below; fix the connection on this page, then try again.'
  },
  MOVE_OPEN: {
    title: 'A move of this environment is open',
    hint: 'Its database record changes only after the move ends or is rolled back.'
  },
  CREATION_OPEN: {
    title: 'This environment is still being created',
    hint: 'The creation attaches its own database.'
  },
  SHARED_PLACEMENT: {
    title: 'This environment runs on a shared deployment',
    hint: 'The deployment serves it from this record; move the environment to change it.'
  },
  ENVIRONMENT_BUSY: {
    title: 'Another action holds this environment',
    hint: 'Try again in a moment.'
  },
  DATABASE_BUSY: {
    title: 'This record is being changed right now',
    hint: 'Try again in a moment.'
  },
  PROMOTION_RUNNING: { title: 'A promotion of this environment is running' },
  MOVE_RUNNING: { title: 'A move of this environment is running' },
  CREATION_RUNNING: { title: 'A creation step is running on this environment' },
  STACK_BUSY: { title: "A stack action is running on this environment's stack" },
  APP_KEY_BUSY: { title: "This environment's encryption key is being saved" },
  SHARED_UPGRADE_RUNNING: { title: 'The shared deployment is being upgraded' },
  REFRESH_RUNNING: {
    title: "This environment's database is being refreshed or rolled back",
    hint: 'Wait for it to end, then try again.'
  },
  STATE_CHANGED: { title: 'The environment changed meanwhile', hint: 'Try again.' }
}

export function envDbError(err: unknown, fallback: string): ErrorDescription {
  if (err instanceof DescribedError) return err.description
  const d = describeError(err, fallback)
  const copy = d.code ? ENV_DB_COPY[d.code] : undefined
  if (!copy) return dbError(err, fallback)
  const out: ErrorDescription = { ...d, title: copy.title }
  if (copy.hint) out.hint = copy.hint
  else delete out.hint
  return out
}

/** A refusal put into words, with the connection check the Hub ran when it carried one. */
export class EnvDbFailure extends DescribedError {
  check: DbCheck | null
  constructor(description: ErrorDescription, check: DbCheck | null) {
    super(description)
    this.name = 'EnvDbFailure'
    this.check = check
  }
}

const failure =
  (fallback: string) =>
  (err: unknown): never => {
    const data = (err as { response?: { data?: { check?: unknown } } } | null)?.response?.data
    const check = data?.check && typeof data.check === 'object' ? (data.check as DbCheck) : null
    throw new EnvDbFailure(envDbError(err, fallback), check)
  }

export interface EnvDbAttached {
  database: HubDatabaseRow
  check: DbCheck | null
  changed: boolean
  warning: string | null
  /** Attached although the identity differed on a Docker stack (an administrator said so). */
  overridden?: boolean
}

/**
 * `override: true` only after DATABASE_IDENTITY_DIFFERS, when the administrator says it is the
 * same database under another address (the Hub logs it); a plain attach never sends it.
 */
export const attachEnvDatabase = (
  envId: number,
  databaseId: number,
  opts: { override?: boolean } = {}
) =>
  api
    .put<{ data: EnvDbAttached }>(`/hub/environments/${envId}/database`, {
      database_id: databaseId,
      ...(opts.override ? { override: true } : {})
    })
    .then((r) => r.data.data)
    .catch(failure('Could not attach the database'))

export const detachEnvDatabase = (envId: number) =>
  api
    .delete<{ data: { database_id: number | null; changed: boolean } }>(
      `/hub/environments/${envId}/database`
    )
    .then((r) => r.data.data)
    .catch(failure('Could not detach the database'))
