// Creation rows (phase 3, Task 9): one row per environment in nivaro_hub_creations, plus the small
// coordination pieces the runner needs besides the environment's promote lock — the app's
// repository lock (nvr:hub:create-repo:<appId>), the creation-start lock (nvr:hub:create-start)
// and the cancel flag (nvr:hub:create-cancel:<creationId>). Same lock pattern as phase 2 (SET NX
// PX, compare-and-pexpire / compare-and-delete), with an in-process fallback without Redis.
//
// Nothing secret is ever written here: `steps` holds step notes, `made` the ids and names of what
// the creation made (GitLab project, driver, placement, component, database row) plus the public
// half of the app's deploy key; `error` is scrubbed by the runner before it gets here.
import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { appPromoteRedis, type PromoteRedis } from '../promote-lock.js'
import { type CreationStepKey, type CreationStepState, STEP_ORDER } from './types.js'

export const CREATIONS = 'nivaro_hub_creations'

/** What a waiting creation waits for: a DBA's database, a hand-made name, the operator's key. */
export type CreationWait = 'database' | 'name' | 'operator'

export type CreationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

/** A leg is open (counts as running for deletes and the name check) in these. */
export const OPEN_CREATION_STATUSES: readonly CreationStatus[] = ['queued', 'running', 'waiting']

/** What a creation made or settled at its start. Ids and names only — never a secret. */
export interface CreationMade {
  database_id?: number
  /** GitLab project (the app's deploy repository; shared by every environment of the app). */
  project_id?: number
  project_path?: string
  driver_id?: number
  /** This environment's own. */
  placement_id?: number
  component_id?: number
  /** Public half of the app's deploy key; `pushed` once DEPLOY_SSH_KEY holds its private half. */
  deploy_key?: { public_key: string; keyid: string; pushed: boolean }
  /** Settled at the start (startCreation), so a retry uses what was planned. */
  planned?: {
    hub_url: string
    digest: string
    slim_digest: string | null
    hostname: string
    base_url: string
    source_branch: string
    /** Unguessable (base64url of 18 random bytes): the fork's mark. Never answered. */
    nonce: string
  }
  /**
   * The operator said the app's deploy key and key.conf are installed on the swarm manager
   * (app-level: one key per app). Cleared (null) when a deploy is refused with
   * NIVARO_HUB_KEY_NOT_INSTALLED.
   */
  operator_ack?: { at: string; by: string | null } | null
  /** CI variable key → outcome (created / updated / kept). */
  variables?: Record<string, string>
}

/** The keys of `made` shared by every environment of an app (written to all its rows). */
export const APP_MADE_KEYS = [
  'project_id',
  'project_path',
  'driver_id',
  'deploy_key',
  'operator_ack'
] as const

export interface CreationRow {
  id: number
  app_id: number
  environment_id: number
  status: CreationStatus
  step: CreationStepKey | null
  waiting_for: CreationWait | null
  steps: CreationStepState[]
  made: CreationMade
  error: string | null
  version: string
  first_admin: { email: string; first_name?: string; last_name?: string }
  job_run_id: number | null
  started_by: string | null
  created_at: string | null
  updated_at: string | null
  finished_at: string | null
  /** Renewed by the live leg with its lock (ruling P3-31); null when no leg vouches for it. */
  heartbeat_at: string | null
}

function parseObj<T>(raw: unknown, fallback: T): T {
  if (raw && typeof raw === 'object') return raw as T
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  // SQLite may hand a datetime back as epoch milliseconds.
  const d =
    v instanceof Date
      ? v
      : typeof v === 'number' || /^\d{12,}$/.test(String(v))
        ? new Date(Number(v))
        : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

/** Every step pending, in STEP_ORDER. */
export function freshSteps(): CreationStepState[] {
  return STEP_ORDER.map((key) => ({ key, status: 'pending', at: null, note: null }))
}

/** The stored step list, completed / reordered to STEP_ORDER (an unknown entry is dropped). */
function normaliseSteps(raw: unknown): CreationStepState[] {
  const list = parseObj<unknown[]>(raw, [])
  const byKey = new Map<string, CreationStepState>()
  if (Array.isArray(list))
    for (const s of list)
      if (s && typeof s === 'object' && typeof (s as CreationStepState).key === 'string')
        byKey.set((s as CreationStepState).key, s as CreationStepState)
  return STEP_ORDER.map((key) => byKey.get(key) ?? { key, status: 'pending', at: null, note: null })
}

export function creationFromRow(r: Record<string, unknown>): CreationRow {
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    status: String(r.status) as CreationStatus,
    step: (r.step as CreationStepKey | null) ?? null,
    waiting_for: (r.waiting_for as CreationWait | null) ?? null,
    steps: normaliseSteps(r.steps),
    made: parseObj<CreationMade>(r.made, {}),
    error: (r.error as string | null) ?? null,
    version: String(r.version ?? ''),
    first_admin: parseObj(r.first_admin, { email: '' }),
    job_run_id: r.job_run_id == null ? null : Number(r.job_run_id),
    started_by: (r.started_by as string | null) ?? null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    finished_at: iso(r.finished_at),
    heartbeat_at: iso(r.heartbeat_at)
  }
}

export async function readCreationRow(envId: number, k: Knex = db): Promise<CreationRow | null> {
  if (!Number.isInteger(envId)) return null
  const r = (await k(CREATIONS).where({ environment_id: envId }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? creationFromRow(r) : null
}

export async function creationsOfApp(appId: number, k: Knex = db): Promise<CreationRow[]> {
  const rows = (await k(CREATIONS).where({ app_id: appId }).orderBy('id')) as Array<
    Record<string, unknown>
  >
  return rows.map(creationFromRow)
}

export async function insertCreation(
  k: Knex,
  o: {
    app_id: number
    environment_id: number
    version: string
    first_admin: CreationRow['first_admin']
    made: CreationMade
    started_by: string | null
  }
): Promise<number> {
  return Number(
    await insertReturningId(k, CREATIONS, {
      app_id: o.app_id,
      environment_id: o.environment_id,
      status: 'queued',
      step: null,
      waiting_for: null,
      steps: JSON.stringify(freshSteps()),
      made: JSON.stringify(o.made),
      error: null,
      version: o.version,
      first_admin: JSON.stringify(o.first_admin),
      started_by: o.started_by,
      created_at: new Date(),
      updated_at: new Date()
    })
  )
}

export interface CreationPatch {
  status?: CreationStatus
  step?: CreationStepKey | null
  waiting_for?: CreationWait | null
  steps?: CreationStepState[]
  made?: CreationMade
  error?: string | null
  job_run_id?: number | null
  finished_at?: Date | null
  heartbeat_at?: Date | null
}

/**
 * Writes `patch` to creation `id`; with `onlyIf` only while the row is in one of those statuses.
 * Answers the rows changed (0 = the row moved on, or is gone).
 */
export async function patchCreation(
  id: number,
  patch: CreationPatch,
  onlyIf?: readonly CreationStatus[],
  k: Knex = db
): Promise<number> {
  const out: Record<string, unknown> = { updated_at: new Date() }
  for (const [key, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[key] = key === 'steps' || key === 'made' ? JSON.stringify(v) : v
  }
  const q = k(CREATIONS).where({ id })
  if (onlyIf) q.whereIn('status', onlyIf as CreationStatus[])
  return Number(await q.update(out))
}

/** The app-level part of `made`, from every creation of the app (first value wins). */
export async function appMade(appId: number, k: Knex = db): Promise<CreationMade> {
  const out: CreationMade = {}
  for (const c of await creationsOfApp(appId, k))
    for (const key of APP_MADE_KEYS)
      if (out[key] === undefined && c.made[key] !== undefined)
        (out as Record<string, unknown>)[key] = c.made[key]
  return out
}

/** `made` without the app-level keys. */
function ownPart(made: CreationMade): CreationMade {
  const out: CreationMade = { ...made }
  for (const key of APP_MADE_KEYS) delete (out as Record<string, unknown>)[key]
  return out
}

/** The app-level keys of `made` only. */
function appPart(made: CreationMade): Partial<CreationMade> {
  const out: Record<string, unknown> = {}
  for (const key of APP_MADE_KEYS)
    if (made[key] !== undefined) out[key] = (made as Record<string, unknown>)[key]
  return out as Partial<CreationMade>
}

const readMade = async (k: Knex, id: number): Promise<CreationMade> =>
  parseObj<CreationMade>(
    ((await k(CREATIONS).where({ id }).first('made')) as { made?: unknown } | undefined)?.made,
    {}
  )

/**
 * Writes app-level `made` keys to every creation of the app (each environment shows them), in
 * ONE transaction that first row-locks every creation of the app (a no-op UPDATE), then changes
 * only those keys in each row: a leg's own keys (placement, component, variables …) written
 * meanwhile are never lost.
 */
export async function saveAppMade(appId: number, patch: Partial<CreationMade>): Promise<void> {
  const app = appPart(patch as CreationMade)
  if (!Object.keys(app).length) return
  await db.transaction(async (trx) => {
    await trx(CREATIONS).where({ app_id: appId }).update({ updated_at: new Date() })
    const ids = (await trx(CREATIONS).where({ app_id: appId }).select('id')) as Array<{
      id: number
    }>
    for (const { id } of ids) {
      const made = { ...(await readMade(trx, Number(id))), ...app }
      await trx(CREATIONS)
        .where({ id })
        .update({ made: JSON.stringify(made) })
    }
  })
}

/**
 * Writes a leg's own `made` keys to its row: in one transaction that row-locks the row first,
 * the app-level keys stay what the row holds (only saveAppMade writes those). Answers the row's
 * `made` as written (own keys + the current app-level ones).
 */
export async function writeOwnMade(id: number, made: CreationMade): Promise<CreationMade> {
  return db.transaction(async (trx) => {
    await trx(CREATIONS).where({ id }).update({ updated_at: new Date() })
    const out = { ...ownPart(made), ...appPart(await readMade(trx, id)) }
    await trx(CREATIONS)
      .where({ id })
      .update({ made: JSON.stringify(out) })
    return out
  })
}

// ── coordination ─────────────────────────────────────────────────────────────

export const CREATE_LOCK_TTL_MS = 5 * 60_000
export const CREATE_LOCK_RENEW_MS = 60_000
export const CREATE_CANCEL_TTL_MS = 2 * 60 * 60_000

export const hubCreateRepoLockKey = (appId: number | string) => `nvr:hub:create-repo:${appId}`
export const HUB_CREATE_START_LOCK_KEY = 'nvr:hub:create-start'
export const hubCreateCancelKey = (creationId: number | string) =>
  `nvr:hub:create-cancel:${creationId}`

/** A named lock: SET NX PX, renewed by its holder, compare-and-delete on release. */
export interface KeyedLock {
  take(key: string): Promise<string | null>
  renew(key: string, token: string): Promise<boolean>
  release(key: string, token: string): Promise<void>
}

const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export class CreationLockError extends Error {
  code = 'LOCK_UNAVAILABLE'
  status = 503
  constructor() {
    super('The Hub cannot reach Redis to make sure only one creation step runs — try again shortly')
    this.name = 'CreationLockError'
  }
}

export function redisKeyedLock(redis: PromoteRedis, ttlMs = CREATE_LOCK_TTL_MS): KeyedLock {
  return {
    async take(key) {
      const token = randomUUID()
      try {
        return (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK' ? token : null
      } catch {
        throw new CreationLockError()
      }
    },
    async renew(key, token) {
      try {
        return Number(await redis.eval(RENEW_SCRIPT, 1, key, token, ttlMs)) === 1
      } catch {
        return true
      }
    },
    async release(key, token) {
      await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, key, token)).catch(() => undefined)
    }
  }
}

/** No Redis: the same lock in this process only. */
export function memoryKeyedLock(ttlMs = CREATE_LOCK_TTL_MS): KeyedLock {
  const held = new Map<string, { token: string; until: number }>()
  return {
    async take(key) {
      const h = held.get(key)
      if (h && h.until > Date.now()) return null
      const token = randomUUID()
      held.set(key, { token, until: Date.now() + ttlMs })
      return token
    },
    async renew(key, token) {
      const h = held.get(key)
      if (h?.token !== token) return false
      h.until = Date.now() + ttlMs
      return true
    },
    async release(key, token) {
      if (held.get(key)?.token === token) held.delete(key)
    }
  }
}

const sharedMemoryLock = memoryKeyedLock()

export function defaultKeyedLock(): KeyedLock {
  const redis = appPromoteRedis()
  return redis ? redisKeyedLock(redis) : sharedMemoryLock
}

/** Cancel requests, readable by whichever process runs the leg. */
export interface CreationFlags {
  requestCancel(creationId: number): Promise<void>
  cancelRequested(creationId: number): Promise<boolean>
  clearCancel(creationId: number): Promise<void>
}

export function redisCreationFlags(redis: PromoteRedis): CreationFlags {
  return {
    async requestCancel(id) {
      await Promise.resolve(
        redis.set(hubCreateCancelKey(id), '1', 'PX', CREATE_CANCEL_TTL_MS)
      ).catch(() => undefined)
    },
    async cancelRequested(id) {
      try {
        return (await redis.get(hubCreateCancelKey(id))) != null
      } catch {
        return false
      }
    },
    async clearCancel(id) {
      await Promise.resolve(redis.del(hubCreateCancelKey(id))).catch(() => undefined)
    }
  }
}

const memCancels = new Set<number>()
export const memoryCreationFlags: CreationFlags = {
  async requestCancel(id) {
    memCancels.add(id)
  },
  async cancelRequested(id) {
    return memCancels.has(id)
  },
  async clearCancel(id) {
    memCancels.delete(id)
  }
}

export function defaultCreationFlags(): CreationFlags {
  const redis = appPromoteRedis()
  return redis ? redisCreationFlags(redis) : memoryCreationFlags
}
