import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { logActivity } from '../../activity.js'
import { getApp } from '../../io-holder.js'
import { type JobRunHandle, startJobRun } from '../../job-runs.js'
import { environmentFromRow, readApp } from '../apps.js'
import { connectionUrl } from '../db/connection.js'
import { attachDatabase, getDatabase, openDatabaseConnection } from '../db/databases.js'
import { HubDbError } from '../db/servers.js'
import { agentHealth as realAgentHealth } from '../docker/agent-client.js'
import { environmentNames } from '../docker/render-spec.js'
import { databaseRecordId } from '../docker/stack-env.js'
import { stackEditRefusal } from '../docker/stack-guards.js'
import {
  createPlacement,
  DEFAULT_POOL_MAX,
  type DockerDriverRow,
  getDriver,
  getPlacement,
  type HubPlacementRow,
  MAX_SHARED_POOL_MAX,
  MIN_SHARED_POOL_MAX,
  releasePlacement,
  type SharedPlacementRow,
  type SharedPlacementTarget,
  sharedPoolMax,
  updatePlacement
} from '../drivers.js'
import { hubTokenColumns } from '../link-token.js'
import { moveOpenRefusal } from '../move-open.js'
import { HEARTBEAT_FRESH_MS, withoutFreshHeartbeat } from '../promote-heal.js'
import {
  defaultPromoteLock,
  defaultSharedLock,
  LOCK_RENEW_MS,
  lockHolderRefusal,
  type PromoteLock,
  type SharedLock,
  sharedLockRefusal
} from '../promote-lock.js'
import { type HubEnvStatus, readEnvironmentStatus } from '../status.js'
import { APP_KEY_UNKNOWN_MESSAGE } from './app-key-check.js'
import { DeploymentLinkError, deploymentClient } from './deployment-client.js'
import { runsSharedHubSignin, SHARED_HUB_SIGNIN_SINCE } from './hub-signin-floor.js'
import { replicasHolding } from './sightings.js'
import { patternCovers } from './stack-render.js'
import { getShared, openAppKey, type SharedDeployment, setAppKey, tenantIdFor } from './store.js'
import { tenantsBody } from './tenants.js'

/**
 * Nivaro Hub phase 6 (Task 4): place a NEW environment on a shared deployment.
 *
 * Only an environment that has never served (preflight B6): status `active` or `provisioning`,
 * no Hub deploy that succeeded, no finished creation and none open, and either no placement or
 * one that never had a success deploy (a failed earlier placement here is retried the same way).
 * An environment that has served moves instead (USE_MOVE).
 *
 * What is checked before anything is written, every refusal a code and a plain sentence:
 * the deployment (NOT_FOUND, SHARED_RETIRED, SHARED_BUSY while it is upgraded or another action
 * holds it), the app (SIGNIN_VIA_HUB, EXTENSION_NOT_ALLOWED), the database record (NOT_FOUND,
 * DATABASE_NOT_READY, DATABASE_IN_USE), the pool (POOL_TOO_SMALL under 2, POOL_BUDGET when the
 * deployment's Σ pool_max would pass its budget). Preflight M5: a Hub database record is never
 * SQLite (HubDbEngine), so there is no SQLITE_NOT_SHARED here.
 *
 * Locks: the environment's lock (holder `creation`, ruling X-6b) for the whole run, renewed as a
 * creation leg renews it; the deployment's shared lock (holder `place`, R10) only while the
 * budget is checked and the placement written, so two placements never both pass the budget.
 *
 * Written under those locks (step 1 of the run): a `shared` placement (pool_max in target), the
 * environment's placement_id, db_ref (the database attached), version_pin = the deployment's pin
 * and status `provisioning`. A placement it replaces goes unless another environment names it.
 * The app's encryption key: kept when the Hub knows it (an entry, or Docker stack settings — then
 * copied into the entry, since a shared-placed environment reads its entry only), else 32 random
 * bytes as hex (a database never served has nothing sealed with another key).
 *
 * The run (job run row, kind deploy, `hub-place-<envId>`): 2. ask every replica to re-read its
 * list; 3. wait ≤ 2 min until every replica seen in the last 2 min holds the list that names
 * this app (none seen = keep waiting); 4. wait ≤ 10 min until the deployment says the app's
 * schema is `ok` (`failed` stops with the app's own error text); 5. its first administrator;
 * 6. environment `active`. A failed run leaves the environment `provisioning` on the placement:
 * placing it again retries.
 *
 * Never logged or answered: the app key, the database connection, the deployment token.
 */

const ENVS = 'nivaro_hub_environments'
const PLACEMENTS = 'nivaro_hub_placements'
const DEPLOYS = 'nivaro_hub_deploys'
const CREATIONS = 'nivaro_hub_creations'
const MOVES = 'nivaro_hub_moves'

/** Step 3: how long the replicas get to take the new list. */
export const REPLICAS_WAIT_MS = 2 * 60_000
/** Step 4: how long the app's migrations get. */
export const SCHEMA_WAIT_MS = 10 * 60_000
const REPLICAS_POLL_MS = 2_000
const SCHEMA_POLL_MS = 5_000
/** The list's ETag is built again at most this often while waiting for replicas (M-3). */
const ETAG_EVERY_MS = 10_000
/** A refresh kick again this often while replicas are behind. */
const REFRESH_AGAIN_MS = 30_000
const ADMIN_TRIES = 3
const ADMIN_RETRY_MS = 5_000
/** Link refusals worth asking again (the app is still settling in). */
const ADMIN_TRANSIENT = new Set([
  'LINK_UNREACHABLE',
  'APP_UNREACHABLE',
  'REGISTRY_NOT_READY',
  'UNKNOWN_APP',
  'FIRST_ADMIN_FAILED'
])

const OPEN_CREATION = ['queued', 'running', 'waiting']
const OPEN_MOVE = ['running', 'waiting', 'interrupted']
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/
const NAME_MAX = 255

export interface PlaceSharedInput {
  shared_id: number
  database_id: number
  pool_max?: number
  first_admin: { email: string; first_name?: string; last_name?: string }
}

/** A refusal: `{statusCode, code, message}` (plain words, never a value). */
export class PlaceSharedError extends Error {
  code: string
  statusCode: number
  constructor(code: string, message: string, statusCode = 409) {
    super(message)
    this.name = 'PlaceSharedError'
    this.code = code
    this.statusCode = statusCode
  }
}

export interface PlaceSharedDeps {
  client?: typeof deploymentClient
  sleep?: (ms: number) => Promise<void>
  /** The clock the waits are measured with (tests pass a fake one their sleep moves). */
  now?: () => number
  lock?: PromoteLock
  sharedLock?: SharedLock
  startJobRun?: (label: string, envId: number, by: string | null) => Promise<JobRunHandle>
  /** How often the run renews its environment lock (tests shorten it). */
  renewMs?: number
  /** Final review I-3: the shared deployment's agent health (its edge); tests fake it. */
  agentHealth?: (driver: DockerDriverRow) => Promise<{ edge?: string | null }>
  /** Final review I-1: asks an environment's own hub link whether its app runs (tests fake it). */
  probeLink?: (env: { id: number; base_url: string; hub_token: string }) => Promise<HubEnvStatus>
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const refuse = (code: string, message: string, status = 409) =>
  new PlaceSharedError(code, message, status)

// ── input ──────────────────────────────────────────────────────────────────────────────────

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

function cleanName(v: unknown): string | null | false {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || v.trim().length > NAME_MAX) return false
  return v.trim() || null
}

/** The input as sent, checked; every problem a 400 with its field's code. */
export function checkPlaceInput(raw: unknown): PlaceSharedInput {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const sharedId = positiveInt(b.shared_id)
  if (sharedId === null) throw refuse('BAD_SHARED', 'shared_id must name a shared deployment.', 400)
  const databaseId = positiveInt(b.database_id)
  if (databaseId === null)
    throw refuse('BAD_DATABASE', 'database_id must name a database the Hub knows.', 400)
  let poolMax: number | undefined
  if (b.pool_max !== undefined && b.pool_max !== null) {
    const n = b.pool_max
    if (typeof n !== 'number' || !Number.isInteger(n) || n > MAX_SHARED_POOL_MAX)
      throw refuse(
        'BAD_POOL',
        `pool_max must be a whole number of connections, at most ${MAX_SHARED_POOL_MAX}.`,
        400
      )
    if (n < MIN_SHARED_POOL_MAX)
      throw refuse(
        'POOL_TOO_SMALL',
        `An app on a shared deployment needs at least ${MIN_SHARED_POOL_MAX} database connections.`,
        400
      )
    poolMax = n
  }
  const fa = (b.first_admin && typeof b.first_admin === 'object' ? b.first_admin : {}) as Record<
    string,
    unknown
  >
  const email = typeof fa.email === 'string' ? fa.email.trim() : ''
  if (!email || email.length > NAME_MAX || !EMAIL_RE.test(email))
    throw refuse('BAD_FIRST_ADMIN', 'first_admin.email must be an email address.', 400)
  const first = cleanName(fa.first_name)
  const last = cleanName(fa.last_name)
  if (first === false || last === false)
    throw refuse(
      'BAD_FIRST_ADMIN',
      'first_admin names must be text of at most 255 characters.',
      400
    )
  return {
    shared_id: sharedId,
    database_id: databaseId,
    ...(poolMax !== undefined ? { pool_max: poolMax } : {}),
    first_admin: {
      email,
      ...(first ? { first_name: first } : {}),
      ...(last ? { last_name: last } : {})
    }
  }
}

// ── the pool budget ────────────────────────────────────────────────────────────────────────

/**
 * Σ pool_max of the deployment's placements in use: named by an environment, or the target of an
 * open move into it. `exceptEnvId`'s own placement is left out (it is being replaced).
 */
export async function sharedPoolUsed(
  sharedId: number,
  exceptEnvId: number | null = null,
  k: Knex = db
): Promise<number> {
  const rows = (await k(PLACEMENTS)
    .where({ shared_deployment_id: sharedId })
    .select('id', 'target')) as Array<{ id: number; target: unknown }>
  if (!rows.length) return 0
  const ids = rows.map((r) => Number(r.id))
  // An archived environment is never served (the tenant list leaves it out): it takes no pool.
  const named = (await k(ENVS)
    .whereIn('placement_id', ids)
    .whereNot({ status: 'archived' })
    .select('id', 'placement_id')) as Array<{
    id: number
    placement_id: number
  }>
  const used = new Set(
    named.filter((e) => Number(e.id) !== exceptEnvId).map((e) => Number(e.placement_id))
  )
  const moves = (await k(MOVES)
    .whereIn('to_placement_id', ids)
    .whereIn('status', OPEN_MOVE)
    .select('environment_id', 'to_placement_id')) as Array<{
    environment_id: number
    to_placement_id: number
  }>
  for (const m of moves)
    if (Number(m.environment_id) !== exceptEnvId) used.add(Number(m.to_placement_id))
  let sum = 0
  for (const r of rows) {
    if (!used.has(Number(r.id))) continue
    let target: unknown = r.target
    try {
      target = typeof target === 'string' ? JSON.parse(target) : target
    } catch {
      target = {}
    }
    sum += sharedPoolMax(target as { pool_max?: number })
  }
  return sum
}

/**
 * PATCH of a shared placement (routes/hub.ts): only `target.pool_max` may change — another
 * deployment is a move (USE_MOVE). A placement an environment uses is judged against the
 * deployment's budget under its shared lock (POOL_BUDGET), so it never races a placement.
 */
export async function patchSharedPlacement(
  existing: SharedPlacementRow,
  next: { shared_deployment_id: number; target: SharedPlacementTarget },
  deps: { sharedLock?: SharedLock } = {}
): Promise<HubPlacementRow> {
  if (next.shared_deployment_id !== existing.shared_deployment_id)
    throw refuse(
      'USE_MOVE',
      'A placement stays on its shared deployment. Move the environment to the other deployment instead.'
    )
  const sharedId = existing.shared_deployment_id
  const lock = deps.sharedLock ?? defaultSharedLock()
  const held = await lock.take(sharedId, 'place')
  if (!held) {
    const r = sharedLockRefusal(await lock.holder(sharedId))
    throw refuse(r.code, r.message)
  }
  try {
    const shared = await getShared(sharedId)
    if (shared?.status === 'retired')
      throw refuse(
        'SHARED_RETIRED',
        'This shared deployment is retired; its placements stay as they are.'
      )
    const users = (await db(ENVS).where({ placement_id: existing.id }).select('id')) as Array<{
      id: number
    }>
    const pool = sharedPoolMax(next.target)
    if (shared && users.length) {
      const used = await sharedPoolUsed(sharedId, Number(users[0].id))
      if (used + pool > shared.pool_budget)
        throw refuse(
          'POOL_BUDGET',
          `The shared deployment has ${Math.max(0, shared.pool_budget - used)} of its ${shared.pool_budget} database connections left; this app asks for ${pool}.`
        )
    }
    const updated = await updatePlacement(existing.id, {
      kind: 'shared',
      shared_deployment_id: sharedId,
      driver_id: null,
      target: next.target
    })
    if (!updated) throw refuse('NOT_FOUND', 'No such placement.', 404)
    return updated
  } finally {
    await lock.release(sharedId, held)
  }
}

// ── the checks ─────────────────────────────────────────────────────────────────────────────

/**
 * Has the environment ever served? Answers the refusal, or null when it never did. `creation`:
 * the caller IS the environment's creation (gap `create`, placeForCreation), so its own open
 * creation row is no refusal.
 */
async function servedRefusal(envId: number, creation = false): Promise<PlaceSharedError | null> {
  if (await db(DEPLOYS).where({ environment_id: envId, status: 'success' }).first('id'))
    return refuse(
      'USE_MOVE',
      'This environment has already served a version. Move it to the shared deployment instead.'
    )
  if (creation) return null
  const creations = (await db(CREATIONS)
    .where({ environment_id: envId })
    .select('status')) as Array<{ status: string }>
  if (creations.some((c) => c.status === 'done'))
    return refuse(
      'USE_MOVE',
      'This environment was created and deployed by the Hub. Move it to the shared deployment instead.'
    )
  if (creations.some((c) => OPEN_CREATION.includes(c.status)))
    return refuse(
      'CREATION_RUNNING',
      'A creation of this environment is still under way. Cancel it first.'
    )
  return null
}

function sharedStateRefusal(shared: SharedDeployment): PlaceSharedError | null {
  if (shared.status === 'retired')
    return refuse(
      'SHARED_RETIRED',
      'This shared deployment is retired; nothing can be placed on it.'
    )
  if (shared.status === 'upgrading')
    return refuse(
      'SHARED_BUSY',
      'The shared deployment is busy: an upgrade or rollback is running — wait for it to end.'
    )
  return null
}

const SHARED_DEPLOYS = 'nivaro_hub_shared_deploys'

/** The explicit names the newest successful run of the deployment routed (beside its pattern). */
export async function lastRoutedNames(sharedId: number): Promise<string[]> {
  const row = (await db(SHARED_DEPLOYS)
    .where({ shared_deployment_id: sharedId, status: 'success' })
    .orderBy('id', 'desc')
    .first('plan')) as { plan: string | null } | undefined
  try {
    const p = JSON.parse(String(row?.plan ?? '')) as { plan?: { hostnames?: unknown } }
    const names = p.plan?.hostnames
    return Array.isArray(names)
      ? names.filter((n): n is string => typeof n === 'string').map((n) => n.toLowerCase())
      : []
  } catch {
    return []
  }
}

/**
 * A Docker shared deployment the Hub runs: it must have been deployed (M-6 NOT_DEPLOYED — else
 * the run waits 2 minutes for replicas that never come), and every name of the environment must
 * already be routed by its stack (I-3 NAME_NOT_ROUTED): the traefik edge routes the host pattern
 * plus the explicit names its last run placed, and a place never re-applies the stack (that would
 * restart every app on it). The agent tells the edge; an agent that does not answer is never
 * read as "routed". A published-port edge routes no names.
 */
async function assertDockerReady(
  shared: SharedDeployment,
  envRow: Record<string, unknown>,
  deps: PlaceSharedDeps
): Promise<void> {
  if (shared.mode !== 'docker') return
  if (shared.status === 'new' || !shared.version_pin)
    throw refuse(
      'NOT_DEPLOYED',
      'This shared deployment has not been deployed yet: upgrade it to a version first, then place apps on it.'
    )
  const names = environmentNames(environmentFromRow(envRow))
  const routed = new Set(await lastRoutedNames(shared.id))
  const outside = names.filter((n) => !patternCovers(shared.host_pattern, n) && !routed.has(n))
  if (!outside.length) return
  let edge: string | null = null
  try {
    const driver = await getDriver(shared.driver_id)
    if (driver?.kind === 'docker')
      edge = (await (deps.agentHealth ?? realAgentHealth)(driver)).edge ?? 'traefik'
  } catch {
    edge = null
  }
  if (edge === 'publish') return
  throw refuse(
    'NAME_NOT_ROUTED',
    `The shared deployment's stack does not route ${outside.slice(0, 5).join(', ')}${
      edge === null ? ' (the Hub agent did not answer, so the Hub cannot tell how it routes)' : ''
    }. Use a name under ${shared.host_pattern ?? 'its host pattern'}, or set a host pattern that covers it, then place the environment again.`
  )
}

function hexKey(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Final review I-1: an environment with a hub token is asked through it whether its app runs.
 * Any answer (ok, degraded, even a refused token) = it runs → USE_MOVE. No answer is unknown,
 * and unknown never passes (SERVING_UNKNOWN): the token is cleared by an administrator once the
 * app is gone for good.
 */
async function assertLinkSilent(
  env: Record<string, unknown>,
  deps: PlaceSharedDeps
): Promise<void> {
  const target = {
    id: Number(env.id),
    base_url: String(env.base_url ?? ''),
    hub_token: String(env.hub_token)
  }
  let status: HubEnvStatus
  try {
    status = await (deps.probeLink ?? ((e) => readEnvironmentStatus(e, { fresh: true })))(target)
  } catch {
    status = {
      state: 'unreachable',
      version: null,
      preflight: null,
      checked_at: new Date().toISOString(),
      source: 'hub-link'
    }
  }
  const answered =
    status.state === 'ok' ||
    status.state === 'degraded' ||
    (status.state === 'link_refused' &&
      (status.error === 'HUB_LINK_REFUSED' || status.error === 'HUB_LINK_MISSING'))
  if (answered)
    throw refuse(
      'USE_MOVE',
      'This environment runs: its app answers at its address. Move it to the shared deployment instead.'
    )
  throw refuse(
    'SERVING_UNKNOWN',
    `This environment has a hub token, but its app did not answer (${status.error ?? status.state}), so the Hub cannot tell that it no longer runs. If it runs, move it instead; if it is gone for good, clear its hub token, then place it again.`
  )
}

/**
 * Final review I-1: with the app's key known, the database is still looked at. One that already
 * holds a Nivaro install is an app that has served → USE_MOVE; one that cannot be looked at is
 * unknown → SERVING_UNKNOWN (never a pass).
 */
async function assertDatabaseUnserved(
  databaseId: number,
  shared: SharedDeployment,
  deps: PlaceSharedDeps
): Promise<void> {
  const unknown = (why: string) =>
    refuse(
      'SERVING_UNKNOWN',
      `The Hub could not tell whether the database already serves an app (${why}). Place it again once the shared deployment can reach the database.`
    )
  let answer: Awaited<ReturnType<ReturnType<typeof deploymentClient>['dbCheck']>>
  try {
    const c = await openDatabaseConnection(databaseId)
    answer = await (deps.client ?? deploymentClient)(shared).dbCheck({
      client: c.engine,
      connection: connectionUrl(c)
    })
  } catch (err) {
    throw unknown(
      err instanceof DeploymentLinkError || err instanceof HubDbError ? err.code : 'UNREACHABLE'
    )
  }
  if (!answer.reachable) throw unknown('UNREACHABLE')
  if (answer.ledger_state === 'present' || (answer.ledger && answer.ledger.count > 0))
    throw refuse(
      'USE_MOVE',
      'The database already holds a Nivaro install: the app has served from it. Move the environment to the shared deployment instead.'
    )
  if (answer.ledger_state !== 'absent' && answer.ledger_state !== 'empty')
    throw unknown('NO_LEDGER_ANSWER')
}

/**
 * I-3: the database holds nothing a key could have sealed — the shared deployment looks at it
 * live (db-check): reachable, and it positively reports no nivaro_migrations table or no rows in
 * it (P6-11b). Anything else (an install, a read error, an answer that does not say, unreachable,
 * a link that does not answer) → 409 APP_KEY_UNKNOWN. The connection
 * goes only to the deployment link (which is sent it anyway once placed), never to a log.
 */
async function assertDatabaseEmpty(
  databaseId: number,
  shared: SharedDeployment,
  deps: PlaceSharedDeps,
  sharedRetry = false
): Promise<void> {
  const unknownKey = (why: string) =>
    refuse(
      'APP_KEY_UNKNOWN',
      `${APP_KEY_UNKNOWN_MESSAGE} ${why} Enter the key on the environment (PUT /api/hub/environments/:envId/app-key), then place it again.`
    )
  let answer: Awaited<ReturnType<ReturnType<typeof deploymentClient>['dbCheck']>>
  try {
    const c = await openDatabaseConnection(databaseId)
    answer = await (deps.client ?? deploymentClient)(shared).dbCheck({
      client: c.engine,
      connection: connectionUrl(c)
    })
  } catch (err) {
    const code =
      err instanceof DeploymentLinkError || err instanceof HubDbError ? err.code : 'UNREACHABLE'
    throw unknownKey(`The Hub could not look at the database to see that it is empty (${code}).`)
  }
  if (!answer.reachable)
    throw unknownKey('The shared deployment could not reach the database to see that it is empty.')
  // P6-11b: only a positive "no ledger table" or "an empty ledger" lets a key be made. A read
  // error, or an answer that does not say (an older deployment), is unknown.
  const state = answer.ledger_state
  if (state === 'present' || (answer.ledger && answer.ledger.count > 0)) {
    // Final review I-1: an install is an app that has served — it moves, a key entered later
    // would not change that. (A retry of a shared placement always has its key; kept as before.)
    if (!sharedRetry)
      throw refuse(
        'USE_MOVE',
        'The database already holds a Nivaro install: the app has served from it. Move the environment to the shared deployment instead.'
      )
    throw unknownKey(
      'The database already holds a Nivaro install, sealed with its own key: a new key would leave its values unreadable.'
    )
  }
  if (state !== 'absent' && state !== 'empty')
    throw unknownKey(
      'The shared deployment could not tell whether the database already holds a Nivaro install.'
    )
}

/**
 * Closes placement run rows (`shared` deploy rows with no shared deploy id) a dead process left
 * `running`: no fresh heartbeat, no run here, the environment's lock free (or held by the caller,
 * `ownLock`). They become `interrupted`; the environment stays `provisioning` on its placement
 * and placing it again resumes. Task 5's shared-deploy mirror rows are never touched. Answers the
 * rows closed. Runs once at Hub boot and before each placement of the environment.
 */
export async function recoverInterruptedPlacements(
  o: { envId?: number; ownLock?: boolean; lock?: PromoteLock; now?: number } = {}
): Promise<number> {
  const q = db(DEPLOYS).where({ kind: 'shared', status: 'running' }).whereNull('shared_deploy_id')
  if (o.envId !== undefined) q.where({ environment_id: o.envId })
  const rows = (await withoutFreshHeartbeat(q, o.now).select('id', 'environment_id')) as Array<{
    id: number
    environment_id: number
  }>
  const lock = o.lock ?? defaultPromoteLock()
  let n = 0
  for (const r of rows) {
    const envId = Number(r.environment_id)
    if (running.has(envId)) continue
    if (!o.ownLock && (await lock.held(envId)) !== false) continue
    n += Number(
      await db(DEPLOYS).where({ id: r.id, status: 'running' }).update({
        status: 'interrupted',
        error: 'INTERRUPTED: The Hub stopped during the placement; place the environment again.',
        finished_at: new Date()
      })
    )
  }
  return n
}

let bootRecovery = false

/** Once per process start (hub mode): placement runs a previous process left `running`. */
export function recoverPlacementsOnceAtBoot(logger?: {
  info?: (o: unknown, msg?: string) => void
  warn?: (o: unknown, msg?: string) => void
}): void {
  if (bootRecovery) return
  bootRecovery = true
  // After the heartbeat window, so a run another Hub process still renews is never taken.
  const timer = setTimeout(() => {
    void recoverInterruptedPlacements()
      .then((n) => {
        if (n) logger?.info?.({ interrupted: n }, 'hub: placements interrupted by a restart')
      })
      .catch((err) =>
        logger?.warn?.({ err: (err as Error | null)?.name }, 'hub: placement recovery failed')
      )
  }, HEARTBEAT_FRESH_MS + 30_000)
  timer.unref?.()
}

// ── start ──────────────────────────────────────────────────────────────────────────────────

interface Placed {
  envId: number
  envKey: string
  appKey: string
  tenantId: string
  shared: SharedDeployment
  input: PlaceSharedInput
  /** The run's `shared` deploy row (the environment's "served" record once it succeeds). */
  deployId: number
}

/** Runs this process started, by environment id (tests and shutdown wait on them). */
const running = new Map<number, Promise<unknown>>()

/** Resolves when the placement run this process started for the environment has ended. */
export async function awaitPlacement(envId: number): Promise<void> {
  await running.get(envId)
}

/**
 * Checks, writes step 1 and starts the run; answers its job run id. Every refusal throws a
 * PlaceSharedError (or a PromotionError LOCK_UNAVAILABLE when Redis cannot take a lock).
 */
export async function placeOnShared(
  envId: number,
  rawInput: PlaceSharedInput,
  by: string | null,
  deps: PlaceSharedDeps = {}
): Promise<{ job_run_id: number }> {
  const input = checkPlaceInput(rawInput)
  const lock = deps.lock ?? defaultPromoteLock()
  const env0 = await db(ENVS).where({ id: envId }).first('id')
  if (!env0) throw refuse('NOT_FOUND', 'No such environment.', 404)

  const token = await lock.take(envId, 'creation')
  if (!token) {
    const r = lockHolderRefusal((await lock.holder?.(envId)) ?? null, {
      code: 'ENVIRONMENT_BUSY',
      message: 'Another action holds this environment — try again shortly.'
    })
    throw refuse(r.code, r.message)
  }
  let handedOff = false
  /** Step 1 written (its run row exists): a start that breaks after it closes the row. */
  let written: number | null = null
  let started: JobRunHandle | null = null
  try {
    // A run row of this environment a dead process left `running` is closed first (we hold the
    // environment's lock, so no live run of it exists anywhere).
    await recoverInterruptedPlacements({ envId, ownLock: true })
    const placed = await checkAndWrite(envId, input, by, deps)
    written = placed.deployId
    const run = await (
      deps.startJobRun ??
      ((label, id, who) =>
        startJobRun('deploy', `hub-place-${id}`, { label, triggeredBy: who ?? null }))
    )(`Place ${placed.appKey}/${placed.envKey} on ${placed.shared.key}`, envId, by)
    started = run
    if (run.id != null)
      await db(DEPLOYS)
        .where({ id: placed.deployId })
        .update({ job_run_id: run.id })
        .catch(() => undefined)
    run.log(
      `1. placed on ${placed.shared.key} (pool ${input.pool_max ?? DEFAULT_POOL_MAX}, version ${placed.shared.version_pin ?? 'not yet known'})`
    )
    await logActivity({
      action: 'hub-place-shared',
      user: by,
      collection: ENVS,
      item: String(envId),
      comment: JSON.stringify({ shared: placed.shared.key, database: input.database_id })
    }).catch(() => null)
    const p = runInBackgroundPool(() => runPlacement(placed, run, lock, token, by, deps)).catch(
      (err) =>
        getApp()?.log?.error?.(
          { envId, err: (err as Error | null)?.name ?? 'Error' },
          'hub shared placement bookkeeping failed'
        )
    )
    handedOff = true
    running.set(envId, p)
    void p.finally(() => {
      if (running.get(envId) === p) running.delete(envId)
    })
    return { job_run_id: Number(run.id ?? 0) }
  } finally {
    if (!handedOff) {
      // Round 2 N-1: never a `running` row with no runner (the heal would only find it at the
      // next place or a restart). The environment stays `provisioning` on its placement, so
      // placing it again resumes.
      if (written !== null)
        await db(DEPLOYS)
          .where({ id: written, status: 'running' })
          .update({
            status: 'failed',
            error: PLACE_START_FAILED,
            finished_at: new Date(),
            heartbeat_at: null
          })
          .catch(() => undefined)
      if (started) await started.fail(new Error(PLACE_START_FAILED)).catch(() => undefined)
      await lock.release(envId, token)
    }
  }
}

const PLACE_START_FAILED =
  'START_FAILED: The placement run could not be started; place the environment again.'

/** Every check, then step 1 under the shared lock. Holds the environment's lock (the caller's). */
async function checkAndWrite(
  envId: number,
  input: PlaceSharedInput,
  by: string | null,
  deps: PlaceSharedDeps,
  opts: { creation?: boolean } = {}
): Promise<Placed> {
  const env = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown> | undefined
  if (!env) throw refuse('NOT_FOUND', 'No such environment.', 404)
  // Final review moves I-2 (P6-37): an open move of this environment (an interrupted one holds
  // no lock). A placement never re-renders the deployment, so a move into or out of the
  // deployment by another environment does not refuse it.
  const open = await moveOpenRefusal({ envIds: [envId] })
  if (open) throw refuse(open.code, open.message, open.status)
  const current = env.placement_id == null ? null : await getPlacement(Number(env.placement_id))
  // Ruling P6-11 (I-1): a placed, serving environment is never placed again (a second place
  // would take it offline and switch its database or deployment without a move).
  if (current?.kind === 'shared' && env.status === 'active')
    throw refuse(
      'ALREADY_PLACED',
      'This environment already runs on a shared deployment. Move it to change where it runs.'
    )
  if (!['active', 'provisioning'].includes(String(env.status)))
    throw refuse(
      'USE_MOVE',
      `This environment is ${String(env.status)}: only a new environment is placed. Move it instead.`
    )
  const served = await servedRefusal(envId, opts.creation === true)
  if (served) throw served

  const app = await readApp(Number(env.app_id))
  if (!app) throw refuse('NOT_FOUND', 'No such app.', 404)
  const shared0 = await getShared(input.shared_id)
  if (!shared0) throw refuse('NOT_FOUND', 'No such shared deployment.', 404)
  const stateRefusal = sharedStateRefusal(shared0)
  if (stateRefusal) throw stateRefusal
  await assertDockerReady(shared0, env, deps)
  // From SHARED_HUB_SIGNIN_SINCE a shared deployment signs each app in through the Hub with the
  // app's own client from the tenant list (no client yet: its people sign in directly until one
  // is made on the Sign-in tab — nobody signs in to a new environment before it is placed).
  if (app.signin_mode === 'hub' && !runsSharedHubSignin(shared0.version_pin))
    throw refuse(
      'SIGNIN_VIA_HUB',
      `This app signs in through the Hub, which a shared deployment offers from ${SHARED_HUB_SIGNIN_SINCE} (${shared0.key} runs ${shared0.version_pin ?? 'a version the Hub cannot read'}). Upgrade it, or switch the app to direct sign-in first.`
    )
  const missing = app.extensions.filter((x) => !shared0.extensions.includes(x))
  if (missing.length)
    throw refuse(
      'EXTENSION_NOT_ALLOWED',
      `The shared deployment does not load ${missing.slice(0, 10).join(', ')}, which this app uses.`
    )
  const database = await getDatabase(input.database_id)
  if (!database) throw refuse('NOT_FOUND', 'No such database.', 404)
  if (database.status !== 'ready')
    throw refuse(
      'DATABASE_NOT_READY',
      `The database is ${database.status}: only a ready database can be used.`
    )
  if (database.environment && database.environment.id !== envId)
    throw refuse('DATABASE_IN_USE', 'Another environment already uses this database.')

  // Ruling P6-11 (I-2): the same running-stack check as an env PATCH of placement_id — a stack
  // that came up (even if its deploy then failed) is never orphaned by a placement swap.
  const stack = await stackEditRefusal([envId], 'placement_id')
  if (stack) throw refuse(stack.code, stack.message, stack.status)

  // Final review I-1: "never served" is judged from what runs, not only from Hub records. An
  // adopted environment (phase 1) can serve on its own stack without one Hub deploy: placing it
  // would give its database a second writer. A retry of a shared placement that never succeeded
  // is the one placement kept (the earlier run already judged all of this).
  const sharedRetry = current?.kind === 'shared'
  if (current && !sharedRetry)
    throw refuse(
      'USE_MOVE',
      'This environment has a dedicated placement: it runs, or ran, there. Move it to the shared deployment instead. If it never ran there, clear its placement first.'
    )
  // Re-review FW1-I-1: only a retry that names the database its first run attached skips the
  // checks; a retry naming another database is judged as a first placement (it could be a live
  // app's record).
  const sameRetry = sharedRetry && databaseRecordId(env.db_ref) === input.database_id
  if (!sameRetry && env.hub_token) await assertLinkSilent(env, deps)

  // Ruling P6-11 (I-3): a key is generated only for a database known to be empty, looked at
  // live from the shared deployment (no nivaro_migrations table or rows). One that holds an
  // install, or cannot be looked at, needs the app's own key entered first. I-1: with a known
  // key, a database that already holds an install is an app that has served → USE_MOVE.
  const known = await openAppKey(envId)
  if (!known) await assertDatabaseEmpty(input.database_id, shared0, deps, sameRetry)
  else if (!sameRetry) await assertDatabaseUnserved(input.database_id, shared0, deps)

  const sharedLock = deps.sharedLock ?? defaultSharedLock()
  const held = await sharedLock.take(input.shared_id, 'place')
  if (!held) {
    const r = sharedLockRefusal(await sharedLock.holder(input.shared_id))
    throw refuse(r.code, r.message)
  }
  try {
    // Judged again under the lock: an upgrade or a retire may have started meanwhile.
    const shared = await getShared(input.shared_id)
    if (!shared) throw refuse('NOT_FOUND', 'No such shared deployment.', 404)
    const again = sharedStateRefusal(shared)
    if (again) throw again
    // Re-review FW1-M-3: an extension PATCH drops one only under this same lock — judged again
    // here so a drop between the checks and this write never strips this app's extension.
    const gone = app.extensions.filter((x) => !shared.extensions.includes(x))
    if (gone.length)
      throw refuse(
        'EXTENSION_NOT_ALLOWED',
        `The shared deployment does not load ${gone.slice(0, 10).join(', ')}, which this app uses.`
      )
    const pool = input.pool_max ?? DEFAULT_POOL_MAX
    const used = await sharedPoolUsed(shared.id, envId)
    if (used + pool > shared.pool_budget)
      throw refuse(
        'POOL_BUDGET',
        `The shared deployment has ${Math.max(0, shared.pool_budget - used)} of its ${shared.pool_budget} database connections left; this app asks for ${pool}.`
      )

    const entry = await db(ENVS).where({ id: envId }).first('encryption_key')
    const before = env.placement_id == null ? null : Number(env.placement_id)
    let deployId = 0
    await db.transaction(async (trx) => {
      // The app's key, in the same transaction (M-1): kept when known (and copied into the
      // entry), else a new one for the empty database. Never logged or answered.
      if (!known) await setAppKey(envId, hexKey(), trx)
      else if (!entry?.encryption_key) await setAppKey(envId, known, trx)
      const placement = await createPlacement(
        {
          kind: 'shared',
          shared_deployment_id: shared.id,
          driver_id: null,
          target: { pool_max: pool }
        },
        trx
      )
      try {
        await attachDatabase(input.database_id, envId, trx, { expect: ['ready'] })
      } catch (err) {
        if (err instanceof HubDbError)
          throw refuse(
            err.code === 'IN_USE' ? 'DATABASE_IN_USE' : err.code,
            err.message,
            err.status
          )
        throw err
      }
      await trx(ENVS).where({ id: envId }).update({
        placement_id: placement.id,
        version_pin: shared.version_pin,
        status: 'provisioning',
        updated_at: new Date()
      })
      if (before !== null && before !== placement.id) await releasePlacement(trx, before)
      // The run's record (I-1): `shared` kind, no shared deploy id, `success` once the app
      // serves — the "never served" check counts it from then on.
      deployId = Number(
        await insertReturningId(trx, DEPLOYS, {
          app_id: Number(env.app_id),
          environment_id: envId,
          kind: 'shared',
          version: shared.version_pin ?? '',
          from_version: null,
          status: 'running',
          step: 'place',
          plan: JSON.stringify({ place: { shared_id: shared.id, shared: shared.key, pool } }),
          started_by: by,
          started_at: new Date(),
          heartbeat_at: new Date()
        })
      )
    })
    return {
      deployId,
      envId,
      envKey: String(env.key),
      appKey: app.key,
      tenantId: tenantIdFor(app, { id: envId }),
      shared,
      input
    }
  } finally {
    await sharedLock.release(input.shared_id, held)
  }
}

// ── the run ────────────────────────────────────────────────────────────────────────────────

class StepFailure extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'StepFailure'
    this.code = code
  }
}

async function runPlacement(
  placed: Placed,
  run: JobRunHandle,
  lock: PromoteLock,
  token: string,
  by: string | null,
  deps: PlaceSharedDeps,
  /**
   * Gap `create` (placeForCreation): `ownLock` = the caller holds the environment's lock and
   * releases it itself; `rethrow` = a failed run throws (PlaceSharedError) after its bookkeeping.
   */
  opts: { ownLock?: boolean; rethrow?: boolean } = {}
): Promise<void> {
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  const { envId, tenantId } = placed
  const client = (deps.client ?? deploymentClient)(placed.shared)
  let lockLost = false
  const renew = setInterval(() => {
    void lock
      .renew(envId, token)
      .then((ok) => {
        if (!ok) lockLost = true
      })
      .catch(() => undefined)
    // This run is alive: its row is never taken for an interrupted one (recoverInterruptedPlacements).
    void db(DEPLOYS)
      .where({ id: placed.deployId, status: 'running' })
      .update({ heartbeat_at: new Date() })
      .catch(() => undefined)
  }, deps.renewMs ?? LOCK_RENEW_MS)
  renew.unref?.()
  const stillOurs = () => {
    if (lockLost)
      throw new StepFailure('INTERRUPTED', 'The environment lock was lost; place it again.')
  }
  const label = `${placed.appKey}/${placed.envKey}`
  try {
    // 2. Every replica re-reads its list (best effort: they poll every 30 s anyway).
    await kick(client, run)

    // 3. Every replica seen in the last 2 min holds the list that names this app. The list's
    // ETag is built again only after a kick or every ETAG_EVERY_MS (M-3: building it opens every
    // app's connection and key).
    const replicasBy = now() + REPLICAS_WAIT_MS
    let lastKick = now()
    let etag: string | null = null
    let etagAt = 0
    for (;;) {
      stillOurs()
      let holding: string[] = []
      let behind: string[] = []
      try {
        if (etag === null || now() - etagAt >= ETAG_EVERY_MS) {
          const shared = (await getShared(placed.shared.id)) ?? placed.shared
          etag = (await tenantsBody(shared)).etag
          etagAt = now()
        }
        ;({ holding, behind } = await replicasHolding(placed.shared.id, etag))
      } catch {
        // Redis or the list could not be read: never "every replica holds it".
        etag = null
      }
      if (holding.length && !behind.length) {
        run.log(`3. every replica holds the new list (${holding.length})`)
        break
      }
      if (now() >= replicasBy)
        throw new StepFailure(
          'REPLICAS_BEHIND',
          holding.length || behind.length
            ? `${behind.length} replica(s) of the shared deployment did not take the new list within 2 minutes (${behind.slice(0, 5).join(', ')}).`
            : 'No replica of the shared deployment asked the Hub for its list within 2 minutes. Check that it runs.'
        )
      if (now() - lastKick >= REFRESH_AGAIN_MS) {
        await kick(client, run)
        lastKick = now()
        etag = null
      }
      await sleep(REPLICAS_POLL_MS)
    }

    // 4. The app's database is migrated on the deployment.
    const schemaBy = now() + SCHEMA_WAIT_MS
    let lastSeen = ''
    let servedVersion: string | null = null
    for (;;) {
      stillOurs()
      try {
        const st = await client.status()
        servedVersion = st.version || null
        const mine = st.apps.find((a) => a.id === tenantId)
        const state = mine?.schema.state ?? 'not listed'
        if (state !== lastSeen) {
          run.log(`4. schema: ${state}`)
          lastSeen = state
        }
        if (mine?.schema.state === 'ok') break
        if (mine?.schema.state === 'failed')
          throw new StepFailure(
            'SCHEMA_FAILED',
            (mine.schema.error ?? 'The app could not be migrated on the shared deployment.').slice(
              0,
              500
            )
          )
      } catch (err) {
        if (err instanceof StepFailure) throw err
        const code = err instanceof DeploymentLinkError ? err.code : 'LINK_UNREACHABLE'
        if (code !== lastSeen) {
          run.log(`4. the shared deployment did not answer (${code}); asking again`, 'warn')
          lastSeen = code
        }
      }
      if (now() >= schemaBy)
        throw new StepFailure(
          'SCHEMA_TIMEOUT',
          'The shared deployment did not finish migrating the app within 10 minutes.'
        )
      await sleep(SCHEMA_POLL_MS)
    }

    // 5. Its first administrator (an app that already has one is fine: a retry got this far).
    const fa = placed.input.first_admin
    for (let i = 1; ; i++) {
      stillOurs()
      try {
        const r = await client.firstAdmin(tenantId, fa)
        run.log(`5. first administrator ${r.created ? 'created' : 'set'}`)
        break
      } catch (err) {
        if (
          err instanceof DeploymentLinkError &&
          err.code === 'FIRST_ADMIN_REFUSED' &&
          err.reason === 'HAS_ADMIN'
        ) {
          run.log('5. the app already has an administrator')
          break
        }
        const code = err instanceof DeploymentLinkError ? err.code : 'LINK_UNREACHABLE'
        if (i >= ADMIN_TRIES || !ADMIN_TRANSIENT.has(code)) {
          const reason = err instanceof DeploymentLinkError && err.reason ? ` (${err.reason})` : ''
          throw new StepFailure(
            code,
            `The app did not take its first administrator${reason}: ${(err as Error).message}`
          )
        }
        await sleep(ADMIN_RETRY_MS)
      }
    }

    // 6. Serving: the environment and its run record move together (I-1).
    stillOurs()
    const version = servedVersion ?? placed.shared.version_pin ?? ''
    // The app's own hub token (sign-in reports and the app switcher, per app on shared): a served
    // environment without one gets one here (a later move keeps it). Sealed before the write; a
    // Hub that cannot seal leaves the app without a switcher, never fails the placement.
    let linkToken: ReturnType<typeof hubTokenColumns> | null = null
    try {
      linkToken = hubTokenColumns(randomBytes(32).toString('hex'))
    } catch {
      linkToken = null
    }
    await db.transaction(async (trx) => {
      if (linkToken)
        await trx(ENVS)
          .where({ id: envId })
          .where((q) => q.whereNull('hub_token').orWhere('hub_token', ''))
          .update(linkToken)
      await trx(ENVS)
        .where({ id: envId, status: 'provisioning' })
        .update({ status: 'active', updated_at: new Date() })
      await trx(ENVS)
        .where({ id: envId })
        .whereNull('version_pin')
        .update({ version_pin: version || null })
      await trx(DEPLOYS).where({ id: placed.deployId }).update({
        status: 'success',
        step: 'done',
        version,
        error: null,
        finished_at: new Date()
      })
    })
    await logActivity({
      action: 'hub-place-shared-done',
      user: by,
      collection: ENVS,
      item: String(envId),
      comment: `Placed ${label} on ${placed.shared.key}`
    }).catch(() => null)
    run.log('6. the environment is active')
    // The list now says `active`: ask the replicas to re-read it at once (best effort).
    await client.refresh().catch(() => undefined)
    await run.complete(`Place ${label} on ${placed.shared.key}: done`)
  } catch (err) {
    const code = err instanceof StepFailure ? err.code : 'STEP_FAILED'
    const text = err instanceof StepFailure ? err.message : 'The placement stopped unexpectedly.'
    run.log(`failed: ${code}: ${text}`, 'error')
    // The environment stays `provisioning` on its placement (it never served): placing it
    // again resumes. Its run record says why.
    await db(DEPLOYS)
      .where({ id: placed.deployId, status: 'running' })
      .update({
        status: code === 'INTERRUPTED' ? 'interrupted' : 'failed',
        error: `${code}: ${text}`.slice(0, 1000),
        finished_at: new Date()
      })
      .catch(() => undefined)
    await run.fail(new Error(`${code}: ${text}`))
    if (opts.rethrow) throw new PlaceSharedError(code, text)
  } finally {
    clearInterval(renew)
    if (!opts.ownLock) await lock.release(envId, token)
  }
}

/**
 * Gap `create` (0.3.215): place-shared as a creation's `place` step. The creation leg already
 * holds the environment's lock (holder `creation`) and its job run, so every check and step 1 run
 * here under that lock, and the run (list, replicas, schema, first administrator, `active`) runs
 * inline: its lines go to the creation's log, and a refusal or a failed run throws
 * PlaceSharedError (the step fails; Retry places again, as placing an environment again does).
 * A placement that already ran to the end (the leg stopped before it recorded the step) answers
 * `already: true` and changes nothing.
 */
export async function placeForCreation(
  envId: number,
  rawInput: PlaceSharedInput,
  by: string | null,
  o: {
    lock: PromoteLock
    token: string
    log: (line: string, level?: 'info' | 'warn' | 'error') => void
    deps?: PlaceSharedDeps
  }
): Promise<{ already: boolean }> {
  const deps = o.deps ?? {}
  const input = checkPlaceInput(rawInput)
  const env = (await db(ENVS).where({ id: envId }).first('status', 'placement_id')) as
    | { status: string; placement_id: number | null }
    | undefined
  if (!env) throw refuse('NOT_FOUND', 'No such environment.', 404)
  if (env.status === 'active' && env.placement_id != null) {
    const p = await getPlacement(Number(env.placement_id))
    const served = await db(DEPLOYS)
      .where({ environment_id: envId, kind: 'shared', status: 'success' })
      .whereNull('shared_deploy_id')
      .first('id')
    if (p?.kind === 'shared' && p.shared_deployment_id === input.shared_id && served)
      return { already: true }
  }
  await recoverInterruptedPlacements({ envId, ownLock: true })
  const placed = await checkAndWrite(envId, input, by, deps, { creation: true })
  o.log(
    `1. placed on ${placed.shared.key} (pool ${input.pool_max ?? DEFAULT_POOL_MAX}, version ${placed.shared.version_pin ?? 'not yet known'})`
  )
  await logActivity({
    action: 'hub-place-shared',
    user: by,
    collection: ENVS,
    item: String(envId),
    comment: JSON.stringify({ shared: placed.shared.key, database: input.database_id })
  }).catch(() => null)
  const run: JobRunHandle = {
    id: null,
    progress() {},
    log: (line, level) => o.log(line, level === 'warn' || level === 'error' ? level : 'info'),
    complete: async () => undefined,
    fail: async () => undefined
  }
  await runPlacement(placed, run, o.lock, o.token, by, deps, { ownLock: true, rethrow: true })
  return { already: false }
}

async function kick(client: ReturnType<typeof deploymentClient>, run: JobRunHandle) {
  try {
    await client.refresh()
    run.log('2. asked the shared deployment to re-read its list')
  } catch (err) {
    const code = err instanceof DeploymentLinkError ? err.code : 'LINK_UNREACHABLE'
    run.log(`2. the refresh kick was not taken (${code}); replicas re-read within 30 s`, 'warn')
  }
}
