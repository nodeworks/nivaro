import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { APP_KEY_RE, keyFingerprint } from '../services/app-key-fingerprint.js'
import { hubPublicOrigin, hubUrlOrigin } from '../services/deployment-mode.js'
import { idParam } from '../services/hub/apps.js'
import { listImageVersions } from '../services/hub/docker/image-tags.js'
import {
  defaultPromoteLock,
  defaultSharedLock,
  lockHolderRefusal,
  PromotionError,
  sharedLockRefusal
} from '../services/hub/promote-lock.js'
import { hubImage } from '../services/hub/registry.js'
import { HUB_MASK, HubSecretError } from '../services/hub/secrets.js'
import {
  APP_KEY_UNKNOWN_MESSAGE,
  decideAppKey,
  entryUnreadable,
  type KeyEnv,
  readKeyEnv,
  sharedPlacementOf
} from '../services/hub/shared/app-key-check.js'
import {
  DeploymentLinkError,
  type DeploymentStatus,
  deploymentClient
} from '../services/hub/shared/deployment-client.js'
import { PlaceSharedError, placeOnShared } from '../services/hub/shared/place.js'
import { liveSightings, type Sighting } from '../services/hub/shared/sightings.js'
import { checkSharedSecretsInput } from '../services/hub/shared/stack-render.js'
import {
  createShared,
  deleteShared,
  getShared,
  listShared,
  openAppKey,
  rotateSharedToken,
  type SharedDeployment,
  SharedError,
  type SharedFields,
  setAppKey,
  tenantIdFor,
  updateShared,
  validateSharedInput
} from '../services/hub/shared/store.js'
import {
  poolMaxOf,
  type SharedTenantRow,
  tenantsBody,
  tenantsOf
} from '../services/hub/shared/tenants.js'
import { setSharedSecrets, sharedSecretsShown } from '../services/hub/shared/upgrade-run.js'

/**
 * Nivaro Hub phase 6 (Task 3): shared deployments and app keys, mounted under /api/hub by hub.ts
 * (HUB=on only). Every route is for a Hub administrator; every write is logged without secrets.
 *
 *   GET    /shared                         list, with `apps` (environments placed) and `live_replicas`
 *   GET    /shared/:id                     row, apps placed, live sightings, `env_block` (registered),
 *                                          `list_etag` (the tenants list's ETag now; Task 17)
 *   POST   /shared                         201 {row, token, env_block} — the token is shown ONCE
 *   PATCH  /shared/:id                     name, link_url, host_pattern, extensions, extension_pins,
 *                                          pool_budget, settings; key or mode → 400 IMMUTABLE;
 *                                          write-only `secrets: {REDIS_URL}` (docker only, P6-16):
 *                                          sealed, answered as set/not set, body never logged,
 *                                          the stack re-applied → {data, secrets, reapply,
 *                                          reapply_reason}
 *   POST   /shared/:id/token               a new token (shown once; the old one works 24 h)
 *   DELETE /shared/:id                     {outcome: deleted|retired}; 409 SHARED_IN_USE / SHARED_BUSY
 *   GET    /shared/:id/upgrade/versions    the Hub image's published versions (Task 17's upgrade
 *                                          picker; Task 5 upgrades to hubImage()); {versions, error}
 *   GET    /shared/:id/status              the deployment link's status, cached 30 s
 *                                          (nvr:hub:shared-status:<id>; ?fresh=1 skips it);
 *                                          a link failure answers {state:'unreachable', code}
 *   GET    /environments/:envId/app-key    {known, key: mask|null, fp, source} — never the key
 *   PUT    /environments/:envId/app-key    {key} → {fp, verified}; 400 BAD_KEY;
 *                                          409 APP_KEY_MISMATCH | APP_KEY_UNVERIFIED | APP_KEY_IMMUTABLE
 *                                          (services/hub/shared/app-key-check.ts, ruling P6-7)
 *   POST   /environments/:envId/place-shared  (Task 4) {shared_id, database_id, pool_max?,
 *                                          first_admin} → 202 {job_run_id}; a new environment
 *                                          only (409 USE_MOVE), services/hub/shared/place.ts
 *
 * Refusals are `{statusCode, error, message, code}` with a plain sentence. Answers never carry a
 * token after the one that made or rotated it, an app key, a database connection or the
 * deployment's own message text.
 */

const SHARED = 'nivaro_hub_shared_deployments'
const ENVS = 'nivaro_hub_environments'

/** How long a deployment's link status is reused. */
export const SHARED_STATUS_TTL_S = 30
export const sharedStatusKey = (id: number) => `nvr:hub:shared-status:${id}`

/** The fields a PATCH may change. Key and mode never change (IMMUTABLE). */
const PATCHABLE = [
  'name',
  'link_url',
  'host_pattern',
  'extensions',
  'extension_pins',
  'pool_budget',
  'settings'
] as const

/** Re-exported for callers of the routes module; the sentence lives with the app-key check. */
export { APP_KEY_UNKNOWN_MESSAGE }

// ─── token rotation on a Docker shared deployment (preflight R7) ───────────────────────────

/**
 * What a Docker shared deployment does after its token is rotated: the stack must be applied
 * again so the deployment runs with the new token (until then the previous one keeps working for
 * 24 h). Task 5 owns the shared stack apply and registers it here; until it does, a rotation on a
 * Docker deployment answers `reapply: 'unavailable'`.
 */
export type SharedReapply = (
  shared: SharedDeployment,
  by: string
) => Promise<{ started: boolean; reason?: string }>

let reapplyAfterRotation: SharedReapply | null = null

export function setSharedReapply(fn: SharedReapply | null): void {
  reapplyAfterRotation = fn
}

/**
 * Applies a Docker deployment's stack again through the registered hook (a token rotation, a new
 * REDIS_URL): `manual` for a registered deployment, `unavailable` with no hook, `started`, or
 * `failed` with a code (never an error's text).
 */
async function reapplyStack(
  row: SharedDeployment,
  by: string
): Promise<{
  reapply: 'manual' | 'started' | 'unavailable' | 'failed'
  reapply_reason: string | null
}> {
  if (row.mode !== 'docker') return { reapply: 'manual', reapply_reason: null }
  if (!reapplyAfterRotation) return { reapply: 'unavailable', reapply_reason: null }
  try {
    const r = await reapplyAfterRotation(row, by)
    return {
      reapply: r.started ? 'started' : 'failed',
      reapply_reason: r.started ? null : (r.reason ?? null)
    }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    return {
      reapply: 'failed',
      reapply_reason: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────────────────────

type Body = Record<string, unknown>

function refuse(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

/** One code for every write a retired deployment refuses (PATCH, token rotation). */
const retired = (reply: FastifyReply) =>
  refuse(
    reply,
    409,
    'SHARED_RETIRED',
    'This shared deployment is retired; it can no longer be changed.'
  )

const notFound = (reply: FastifyReply, what = 'shared deployment') =>
  refuse(reply, 404, 'NOT_FOUND', `No such ${what}.`)

function userId(req: FastifyRequest): string {
  return String(req.user?.id ?? '')
}

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

function isFresh(req: FastifyRequest): boolean {
  const v = (req.query as { fresh?: unknown } | undefined)?.fresh
  return v === '1' || v === 'true'
}

/** Store, lock and secret refusals as answers; anything else rethrows. */
async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (e) {
    if (e instanceof SharedError) return refuse(reply, e.statusCode, e.code, e.message)
    if (e instanceof PromotionError)
      return refuse(reply, e.status === 503 ? 503 : 409, e.code, e.message)
    if (e instanceof HubSecretError) return refuse(reply, 400, e.code, e.message)
    throw e
  }
}

interface HubRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
}

function redisOf(app: FastifyInstance): HubRedis | null {
  return (app as unknown as { redis?: HubRedis }).redis ?? null
}

const CACHE_BOUND_MS = 300
const TIMED_OUT = Symbol('timed-out')

/** `p`, or TIMED_OUT after 300 ms; a rejection is TIMED_OUT too (a cache never fails a read). */
async function bounded<T>(p: () => Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(p),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), CACHE_BOUND_MS)
      })
    ])
  } catch {
    return TIMED_OUT
  } finally {
    clearTimeout(timer)
  }
}

async function forgetStatus(app: FastifyInstance, id: number): Promise<void> {
  const redis = redisOf(app)
  if (redis) await bounded(() => Promise.resolve(redis.del(sharedStatusKey(id))))
}

/** Live sightings, or null when Redis cannot be read (never "nobody is serving"). */
async function sightingsOrNull(id: number): Promise<Sighting[] | null> {
  try {
    return await liveSightings(id)
  } catch {
    return null
  }
}

// ─── env block (registered mode) ───────────────────────────────────────────────────────────

const TOKEN_PLACEHOLDER =
  '<shown once when it was made or rotated: rotate the token to get a new one>'

/**
 * What an operator sets on a registered shared deployment. The token is filled in only on the
 * answer that made or rotated it; every later read shows the placeholder.
 */
export function envBlock(shared: SharedDeployment, token: string | null): string | null {
  if (shared.mode !== 'registered') return null
  const hub =
    hubPublicOrigin() ?? "<this Hub's https address: set HUB_URL or PUBLIC_URL on the Hub>"
  // One template (the deployment-side names are data here, never a read of them).
  return `# Nivaro Hub shared deployment "${shared.key}": set these on every process of it.
# Also set REDIS_URL, SESSION_SECRET and ENCRYPTION_KEY as for any Nivaro install; no DB_*
# settings (each app brings its own database). The link address the Hub calls:
# ${shared.link_url}
HUB_SHARED_DEPLOYMENT=${shared.key}
HUB_URL=${hub}
HUB_DEPLOYMENT_TOKEN=${token ?? TOKEN_PLACEHOLDER}
HUB_SHARED_EXTENSIONS=${shared.extensions.join(',')}`
}

function blockWarnings(shared: SharedDeployment): { code: string; text: string }[] {
  if (shared.mode !== 'registered' || hubUrlOrigin()) return []
  return [
    {
      code: 'HUB_URL_UNSET',
      text: "HUB_URL is not set on this Hub, so the env block names the Hub's PUBLIC_URL. Set HUB_URL to the Hub's https address so shared deployments can always reach it."
    }
  ]
}

// ─── apps placed on a deployment ───────────────────────────────────────────────────────────

/**
 * One row per environment the deployment serves now: exactly Task 2's tenants list
 * (`tenantsOf`: its status map, mid-move environments, archived and unmapped statuses left out),
 * so the admin page never shows a different set from what the deployment is sent.
 */
export interface SharedAppRow {
  env_id: number
  env_key: string
  env_status: string
  app_id: number
  app_key: string
  app_name: string
  tenant_id: string
  status: SharedTenantRow['wireStatus']
  /** The environment's own placement is here (false: a move in or out is under way). */
  placed_here: boolean
  pool_max: number | null
  base_url: string
}

async function appsPlaced(shared: SharedDeployment): Promise<SharedAppRow[]> {
  return (await tenantsOf(shared)).map((r) => ({
    env_id: r.env.id,
    env_key: r.env.key,
    env_status: r.env.status,
    app_id: r.app.id,
    app_key: r.app.key,
    app_name: r.app.name,
    tenant_id: tenantIdFor(r.app, r.env),
    status: r.wireStatus,
    placed_here: r.placedHere,
    pool_max: poolMaxOf(r.placement),
    base_url: r.env.base_url
  }))
}

/**
 * The ETag of the tenants list the Hub serves this deployment now (Task 2's tag), so the admin
 * page can say which replica holds the latest list (a sighting's `etag` equal to it). A list that
 * cannot be built is null, never a tag no replica holds.
 */
async function listEtagOrNull(shared: SharedDeployment): Promise<string | null> {
  try {
    return (await tenantsBody(shared)).etag
  } catch {
    return null
  }
}

async function previousTokenUntil(id: number): Promise<string | null> {
  const row = await db(SHARED).where({ id }).first('prev_token_until')
  const v = row?.prev_token_until
  if (v === null || v === undefined || v === '') return null
  const d =
    v instanceof Date
      ? v
      : typeof v === 'number' || /^\d{12,}$/.test(String(v))
        ? new Date(Number(v))
        : new Date(String(v))
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return null
  return d.toISOString()
}

// ─── app-key lock ───────────────────────────────────────────────────────────────────────────

/**
 * Runs an app-key check and save holding the shared deployment's lock (an environment placed on
 * one) or the environment's own lock (dedicated), holder `app-key`: two saves never both pass
 * the check, and no move, placement or upgrade runs meanwhile. Busy → 409 naming the holder; a
 * Redis that cannot take it throws LOCK_UNAVAILABLE (guarded → 503).
 */
async function withKeyLock(
  reply: FastifyReply,
  envId: number,
  run: (fresh: KeyEnv) => Promise<unknown>
): Promise<unknown> {
  // The lock is chosen from the placement read before it is taken; once held, the environment is
  // read again and judged as it is now (re-review N-3). A placement that changed in between (an
  // environment placed on a shared deployment meanwhile) is let go and the right lock taken —
  // once; a second change answers 409 PLACEMENT_CHANGED.
  for (let attempt = 0; attempt < 2; attempt++) {
    const env = await readKeyEnv(envId)
    if (!env) return notFound(reply, 'environment')
    const shared = await sharedPlacementOf(env)
    const held = shared
      ? await takeSharedKeyLock(reply, shared.id)
      : await takeEnvKeyLock(reply, env.id)
    if ('refused' in held) return held.refused
    try {
      const fresh = await readKeyEnv(envId)
      if (!fresh) return notFound(reply, 'environment')
      const now = await sharedPlacementOf(fresh)
      if ((now?.id ?? null) === (shared?.id ?? null)) return await run(fresh)
    } finally {
      await held.release()
    }
  }
  return refuse(
    reply,
    409,
    'PLACEMENT_CHANGED',
    "The environment's placement changed while its key was being saved — try again."
  )
}

type HeldLock = { release: () => Promise<void> } | { refused: unknown }

async function takeSharedKeyLock(reply: FastifyReply, sharedId: number): Promise<HeldLock> {
  const lock = defaultSharedLock()
  const token = await lock.take(sharedId, 'app-key')
  if (!token) {
    const r = sharedLockRefusal(await lock.holder(sharedId))
    return { refused: refuse(reply, 409, r.code, r.message) }
  }
  return { release: () => lock.release(sharedId, token) }
}

async function takeEnvKeyLock(reply: FastifyReply, envId: number): Promise<HeldLock> {
  const lock = defaultPromoteLock()
  const token = await lock.take(envId, 'app-key')
  if (!token) {
    const r = lockHolderRefusal((await lock.holder?.(envId)) ?? null, {
      code: 'ENVIRONMENT_BUSY',
      message: 'Another action holds this environment — try again shortly.'
    })
    return { refused: refuse(reply, 409, r.code, r.message) }
  }
  return { release: () => lock.release(envId, token) }
}

// ─── routes ────────────────────────────────────────────────────────────────────────────────

export function hubSharedRoutes(app: FastifyInstance): void {
  app.get('/shared', { preHandler: requireAdmin }, async () => {
    const rows = await listShared()
    const [counts, live] = await Promise.all([
      Promise.all(rows.map(async (r) => (await tenantsOf(r)).length)),
      Promise.all(rows.map((r) => sightingsOrNull(r.id)))
    ])
    return {
      data: rows.map((r, i) => ({
        ...r,
        apps: counts[i],
        live_replicas: live[i] === null ? null : (live[i] as Sighting[]).length
      }))
    }
  })

  app.get('/shared/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const row = id === null ? null : await getShared(id)
    if (id === null || !row) return notFound(reply)
    const [apps, sightings, prevUntil, listEtag, secrets] = await Promise.all([
      appsPlaced(row),
      sightingsOrNull(id),
      previousTokenUntil(id),
      listEtagOrNull(row),
      sharedSecretsShown(id)
    ])
    const warnings = blockWarnings(row)
    if (sightings === null)
      warnings.push({
        code: 'SIGHTINGS_UNAVAILABLE',
        text: 'The Hub could not read which processes of this deployment it has seen (Redis did not answer).'
      })
    return {
      data: {
        row,
        apps,
        sightings,
        previous_token_valid_until: prevUntil,
        list_etag: listEtag,
        env_block: envBlock(row, null),
        warnings,
        // Write-only secrets (ruling P6-16): set (masked) or null, never the value.
        secrets
      }
    }
  })

  app.post('/shared', { preHandler: requireAdmin }, async (req, reply) => {
    return guarded(reply, async () => {
      const checked = validateSharedInput(body(req))
      if (!checked.ok) return refuse(reply, 400, checked.code, checked.message)
      const { row, token } = await createShared(checked.row, userId(req) || null)
      await logActivity({
        action: 'hub-shared-create',
        user: userId(req),
        collection: SHARED,
        item: String(row.id),
        req
      })
      return reply.code(201).send({ data: { row, token, env_block: envBlock(row, token) } })
    })
  })

  app.patch('/shared/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const existing = id === null ? null : await getShared(id)
    if (id === null || !existing) return notFound(reply)
    if (existing.status === 'retired') return retired(reply)
    const b = body(req)
    for (const k of ['key', 'mode'] as const)
      if (Object.hasOwn(b, k) && b[k] !== undefined && b[k] !== existing[k])
        return refuse(
          reply,
          400,
          'IMMUTABLE',
          `A shared deployment keeps its ${k}; add a new one instead.`
        )
    const other = Object.keys(b).filter(
      (k) =>
        b[k] !== undefined &&
        k !== 'key' &&
        k !== 'mode' &&
        k !== 'secrets' &&
        !(PATCHABLE as readonly string[]).includes(k)
    )
    if (other.length)
      return refuse(
        reply,
        400,
        'NOT_EDITABLE',
        `These fields cannot be changed here: ${other.slice(0, 10).join(', ')}.`
      )
    // Write-only secrets (ruling P6-16): a Docker deployment's external REDIS_URL.
    let secrets: Record<string, string | null> | null = null
    if (b.secrets !== undefined) {
      if (existing.mode !== 'docker')
        return refuse(
          reply,
          400,
          'NOT_EDITABLE',
          'Only a Docker shared deployment keeps secrets here; whoever runs a registered one sets them there.'
        )
      const sc = checkSharedSecretsInput(b.secrets)
      if (!sc.ok) return refuse(reply, 400, 'BAD_SECRETS', sc.message)
      secrets = sc.secrets
    }
    const { secrets: _secrets, ...fields } = b
    return guarded(reply, async () => {
      const checked = validateSharedInput(fields, existing)
      if (!checked.ok) return refuse(reply, 400, checked.code, checked.message)
      const changes: Partial<SharedFields> = {}
      const changed: string[] = []
      for (const k of PATCHABLE) {
        if (b[k] === undefined) continue
        ;(changes as Record<string, unknown>)[k] = checked.row[k]
        changed.push(k)
      }
      const updated = await updateShared(id, changes)
      if (!updated) return notFound(reply)
      if (secrets) {
        await setSharedSecrets(id, secrets)
        for (const k of Object.keys(secrets)) changed.push(`secrets.${k}`)
      }
      await logActivity({
        action: 'hub-shared-update',
        user: userId(req),
        collection: SHARED,
        item: String(id),
        req,
        changed_fields: changed
      })
      if (changes.link_url !== undefined) await forgetStatus(app, id)
      if (!secrets) return { data: updated }
      // The stack reads REDIS_URL only when applied again: the same hook a token rotation uses.
      const { reapply, reapply_reason } = await reapplyStack(updated, userId(req))
      return { data: updated, secrets: await sharedSecretsShown(id), reapply, reapply_reason }
    })
  })

  app.post('/shared/:id/token', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const row = id === null ? null : await getShared(id)
    if (id === null || !row) return notFound(reply)
    if (row.status === 'retired') return retired(reply)
    return guarded(reply, async () => {
      const { token } = await rotateSharedToken(id)
      await logActivity({
        action: 'hub-shared-token',
        user: userId(req),
        collection: SHARED,
        item: String(id),
        req
      })
      await forgetStatus(app, id)
      // R7: a Docker deployment gets the new token only when its stack is applied again.
      const { reapply, reapply_reason } = await reapplyStack(row, userId(req))
      return {
        data: {
          token,
          previous_token_valid_until: await previousTokenUntil(id),
          reapply,
          reapply_reason,
          env_block: envBlock(row, token)
        }
      }
    })
  })

  app.delete('/shared/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    return guarded(reply, async () => {
      const { outcome } = await deleteShared(id)
      await logActivity({
        action: 'hub-shared-delete',
        user: userId(req),
        collection: SHARED,
        item: String(id),
        req,
        comment: outcome
      })
      await forgetStatus(app, id)
      return { data: { id, outcome } }
    })
  })

  // Task 17: the versions the upgrade picker offers (the plan still judges one: VERSION_UNKNOWN).
  // A registry that cannot be read is `error: true`, never its text.
  app.get('/shared/:id/upgrade/versions', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const row = id === null ? null : await getShared(id)
    if (id === null || !row) return notFound(reply)
    const r = await listImageVersions(hubImage())
    return { data: { versions: r.versions, error: !!r.error } }
  })

  app.get('/shared/:id/status', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const row = id === null ? null : await getShared(id)
    if (id === null || !row) return notFound(reply)
    const redis = redisOf(app)
    const key = sharedStatusKey(id)
    if (redis && !isFresh(req)) {
      const raw = await bounded(() => redis.get(key))
      if (raw !== TIMED_OUT && raw) {
        try {
          return { data: JSON.parse(raw) }
        } catch {
          // a broken cache entry: read again
        }
      }
    }
    const checked_at = new Date().toISOString()
    let answer:
      | ({ state: 'ok'; checked_at: string } & DeploymentStatus)
      | { state: 'unreachable'; code: string; message: string; checked_at: string }
    try {
      answer = { state: 'ok', checked_at, ...(await deploymentClient(row).status()) }
    } catch (err) {
      const e =
        err instanceof DeploymentLinkError ? err : new DeploymentLinkError('LINK_UNREACHABLE')
      answer = { state: 'unreachable', code: e.code, message: e.message, checked_at }
    }
    if (redis)
      void bounded(() =>
        Promise.resolve(redis.set(key, JSON.stringify(answer), 'EX', SHARED_STATUS_TTL_S))
      )
    return { data: answer }
  })

  app.get('/environments/:envId/app-key', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = idParam((req.params as { envId: string }).envId)
    const env = envId === null ? null : await readKeyEnv(envId)
    if (envId === null || !env) return notFound(reply, 'environment')
    const key = await openAppKey(envId)
    // An entry that no longer opens (wrong Hub key, damaged) is named, never hidden behind a
    // stack key or "unknown".
    const unreadable = entryUnreadable(env) ? { entry_unreadable: true } : {}
    if (!key)
      return {
        data: {
          known: false,
          key: null,
          fp: null,
          source: null,
          code: 'APP_KEY_UNKNOWN',
          message: APP_KEY_UNKNOWN_MESSAGE,
          ...unreadable
        }
      }
    const fp = keyFingerprint(key)
    const fromEntry = !!env.encryption_key && !unreadable.entry_unreadable
    return {
      data: {
        known: true,
        key: HUB_MASK,
        fp,
        source: fromEntry ? 'entry' : 'stack',
        ...unreadable
      }
    }
  })

  app.put('/environments/:envId/app-key', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = idParam((req.params as { envId: string }).envId)
    const env = envId === null ? null : await readKeyEnv(envId)
    if (envId === null || !env) return notFound(reply, 'environment')
    const raw = body(req).key
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (!APP_KEY_RE.test(key))
      return refuse(
        reply,
        400,
        'BAD_KEY',
        "The app's encryption key is 64 hex characters (its ENCRYPTION_KEY)."
      )
    return guarded(reply, async () =>
      withKeyLock(reply, envId, async (fresh) => {
        const d = await decideAppKey(fresh, key)
        if (d.action === 'unchanged') return { data: { fp: d.fp, changed: false } }
        if (d.action === 'refuse')
          return reply.code(409).send({
            statusCode: 409,
            error: d.message,
            message: d.message,
            code: d.code,
            ...(d.reason ? { reason: d.reason } : {})
          })
        const saved = await setAppKey(envId, key)
        await logActivity({
          action: 'hub-app-key',
          user: userId(req),
          collection: ENVS,
          item: String(envId),
          req,
          // The fingerprint and how it was checked: never the key.
          comment: `fp=${saved.fp} verified=${d.verified ?? `none:${d.unverified_code ?? 'UNKNOWN'}`}`
        })
        return {
          data: {
            fp: saved.fp,
            changed: true,
            // Where the key was checked against what the app runs with; null = it could not be.
            verified: d.verified,
            ...(d.unverified_code ? { unverified_code: d.unverified_code } : {})
          }
        }
      })
    )
  })

  // Task 4: place a new environment on a shared deployment. The checks and the placement write
  // answer at once (every refusal a code); the run goes on in the background as a job run.
  app.post(
    '/environments/:envId/place-shared',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const envId = idParam((req.params as { envId: string }).envId)
      if (envId === null) return notFound(reply, 'environment')
      return guarded(reply, async () => {
        try {
          const out = await placeOnShared(
            envId,
            body(req) as unknown as Parameters<typeof placeOnShared>[1],
            userId(req) || null
          )
          await forgetStatus(app, Number(body(req).shared_id))
          return reply.code(202).send({ data: out })
        } catch (err) {
          if (err instanceof PlaceSharedError)
            return refuse(reply, err.statusCode, err.code, err.message)
          throw err
        }
      })
    }
  )
}
