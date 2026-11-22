import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { APP_KEY_RE, keyFingerprint } from '../services/app-key-fingerprint.js'
import { hubPublicOrigin, hubUrlOrigin } from '../services/deployment-mode.js'
import { idParam } from '../services/hub/apps.js'
import { openStackSecrets, readStackSettings } from '../services/hub/docker/stack-settings.js'
import { PromotionError } from '../services/hub/promote-lock.js'
import { HUB_MASK, HubSecretError, openSecret } from '../services/hub/secrets.js'
import {
  DeploymentLinkError,
  type DeploymentStatus,
  deploymentClient,
  linkedKeyFingerprint
} from '../services/hub/shared/deployment-client.js'
import { liveSightings, type Sighting } from '../services/hub/shared/sightings.js'
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

/**
 * Nivaro Hub phase 6 (Task 3): shared deployments and app keys, mounted under /api/hub by hub.ts
 * (HUB=on only). Every route is for a Hub administrator; every write is logged without secrets.
 *
 *   GET    /shared                         list, with `apps` (environments placed) and `live_replicas`
 *   GET    /shared/:id                     row, apps placed, live sightings, `env_block` (registered)
 *   POST   /shared                         201 {row, token, env_block} — the token is shown ONCE
 *   PATCH  /shared/:id                     name, link_url, host_pattern, extensions, extension_pins,
 *                                          pool_budget, settings; key or mode → 400 IMMUTABLE
 *   POST   /shared/:id/token               a new token (shown once; the old one works 24 h)
 *   DELETE /shared/:id                     {outcome: deleted|retired}; 409 SHARED_IN_USE / SHARED_BUSY
 *   GET    /shared/:id/status              the deployment link's status, cached 30 s
 *                                          (nvr:hub:shared-status:<id>; ?fresh=1 skips it);
 *                                          a link failure answers {state:'unreachable', code}
 *   GET    /environments/:envId/app-key    {known, key: mask|null, fp, source} — never the key
 *   PUT    /environments/:envId/app-key    {key} → {fp, verified}; 400 BAD_KEY;
 *                                          409 APP_KEY_MISMATCH when the app runs with another key
 *
 * Refusals are `{statusCode, error, message, code}` with a plain sentence. Answers never carry a
 * token after the one that made or rotated it, an app key, a database connection or the
 * deployment's own message text.
 */

const SHARED = 'nivaro_hub_shared_deployments'
const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const PLACEMENTS = 'nivaro_hub_placements'

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

/** Sentence for an environment whose app key the Hub does not know (preflight R9). */
export const APP_KEY_UNKNOWN_MESSAGE =
  "The Hub does not know this app's encryption key. Enter it on the environment (the app's ENCRYPTION_KEY, 64 hex characters). Apps created through GitLab always need this: the Hub never kept their key."

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

// ─── helpers ───────────────────────────────────────────────────────────────────────────────

type Body = Record<string, unknown>

function refuse(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

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

/** An environment's status as the tenants list sends it (Task 2's mapping, ruling B1). */
function wireStatus(envStatus: string): 'active' | 'maintenance' | 'provisioning' | 'suspended' {
  if (envStatus === 'maintenance') return 'maintenance'
  if (envStatus === 'provisioning' || envStatus === 'waiting_for_name') return 'provisioning'
  if (envStatus === 'suspended') return 'suspended'
  return 'active'
}

function poolMaxOf(target: unknown): number | null {
  try {
    const t = typeof target === 'string' ? JSON.parse(target) : target
    const n = (t as { pool_max?: unknown } | null)?.pool_max
    return typeof n === 'number' && Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

export interface SharedAppRow {
  env_id: number
  env_key: string
  env_status: string
  app_id: number
  app_key: string
  app_name: string
  tenant_id: string
  status: ReturnType<typeof wireStatus>
  pool_max: number | null
  base_url: string
}

async function appsPlaced(sharedId: number): Promise<SharedAppRow[]> {
  const rows = (await db(`${ENVS} as e`)
    .join(`${PLACEMENTS} as p`, 'p.id', 'e.placement_id')
    .join(`${APPS} as a`, 'a.id', 'e.app_id')
    .where('p.shared_deployment_id', sharedId)
    .whereNot('e.status', 'archived')
    .orderBy([
      { column: 'a.key', order: 'asc' },
      { column: 'e.position', order: 'asc' },
      { column: 'e.id', order: 'asc' }
    ])
    .select(
      'e.id as env_id',
      'e.key as env_key',
      'e.status as env_status',
      'e.base_url as base_url',
      'a.id as app_id',
      'a.key as app_key',
      'a.name as app_name',
      'p.target as target'
    )) as Record<string, unknown>[]
  return rows.map((r) => ({
    env_id: Number(r.env_id),
    env_key: String(r.env_key),
    env_status: String(r.env_status ?? 'active'),
    app_id: Number(r.app_id),
    app_key: String(r.app_key),
    app_name: String(r.app_name),
    tenant_id: tenantIdFor({ key: String(r.app_key) }, { id: Number(r.env_id) }),
    status: wireStatus(String(r.env_status ?? 'active')),
    pool_max: poolMaxOf(r.target),
    base_url: String(r.base_url ?? '')
  }))
}

/** Environments placed per deployment id (archived ones left out). */
async function appCounts(): Promise<Map<number, number>> {
  const rows = (await db(`${ENVS} as e`)
    .join(`${PLACEMENTS} as p`, 'p.id', 'e.placement_id')
    .whereNotNull('p.shared_deployment_id')
    .whereNot('e.status', 'archived')
    .groupBy('p.shared_deployment_id')
    .select('p.shared_deployment_id as id')
    .count({ n: '*' })) as Array<{ id: unknown; n: unknown }>
  return new Map(rows.map((r) => [Number(r.id), Number(r.n)]))
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

// ─── app keys ──────────────────────────────────────────────────────────────────────────────

interface EnvKeyRow {
  id: number
  app_id: number
  base_url: string
  placement_id: number | null
  hub_token: string | null
  encryption_key: string | null
  encryption_key_fp: string | null
}

async function readEnv(envId: number): Promise<EnvKeyRow | null> {
  const row = (await db(ENVS)
    .where({ id: envId })
    .first(
      'id',
      'app_id',
      'base_url',
      'placement_id',
      'hub_token',
      'encryption_key',
      'encryption_key_fp'
    )) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: Number(row.id),
    app_id: Number(row.app_id),
    base_url: String(row.base_url ?? ''),
    placement_id: row.placement_id == null ? null : Number(row.placement_id),
    hub_token: (row.hub_token as string | null) ?? null,
    encryption_key: (row.encryption_key as string | null) ?? null,
    encryption_key_fp: (row.encryption_key_fp as string | null) ?? null
  }
}

async function stackKeyFp(envId: number): Promise<string | null> {
  try {
    const k = openStackSecrets(await readStackSettings(envId)).ENCRYPTION_KEY
    return k && APP_KEY_RE.test(k) ? keyFingerprint(k.toLowerCase()) : null
  } catch {
    return null
  }
}

type KeyEvidence =
  | { source: 'stack' | 'shared' | 'hub-link'; fp: string | null }
  | { source: null; code: string }

/**
 * Which key does the environment really run with? The Docker stack settings secret first (what
 * the Hub deploys it with), else the shared deployment it is placed on (the key in the Hub's list
 * for its tenant), else its hub link (`shared-readiness`, Task 9). `source: null` = cannot tell.
 */
async function runningKeyFp(env: EnvKeyRow): Promise<KeyEvidence> {
  const stack = await stackKeyFp(env.id)
  if (stack) return { source: 'stack', fp: stack }
  if (env.placement_id !== null) {
    const p = await db(PLACEMENTS).where({ id: env.placement_id }).first('shared_deployment_id')
    if (p?.shared_deployment_id != null) {
      const shared = await getShared(Number(p.shared_deployment_id))
      const app = await db(APPS).where({ id: env.app_id }).first('key')
      if (shared && app) {
        try {
          const st = await deploymentClient(shared).appStatus(
            tenantIdFor({ key: String(app.key) }, { id: env.id })
          )
          return { source: 'shared', fp: st.key_fp }
        } catch (err) {
          return {
            source: null,
            code: err instanceof DeploymentLinkError ? err.code : 'LINK_UNREACHABLE'
          }
        }
      }
    }
  }
  if (env.hub_token) {
    let token: string | null = null
    try {
      token = openSecret(env.hub_token)
    } catch {
      token = null
    }
    if (!token) return { source: null, code: 'HUB_SECRET_UNREADABLE' }
    const r = await linkedKeyFingerprint(env, token)
    return r.ok ? { source: 'hub-link', fp: r.fp } : { source: null, code: r.code }
  }
  return { source: null, code: 'NO_LINK' }
}

const MISMATCH_TEXT: Record<'stack' | 'shared' | 'hub-link', string> = {
  stack:
    "This environment's Docker stack settings hold a different encryption key. Values the app sealed would not open with this one.",
  shared:
    'The shared deployment serves this app with a different encryption key. Values the app sealed would not open with this one.',
  'hub-link':
    'The app reports a different encryption key over its hub link. Values it sealed would not open with this one.'
}

// ─── routes ────────────────────────────────────────────────────────────────────────────────

export function hubSharedRoutes(app: FastifyInstance): void {
  app.get('/shared', { preHandler: requireAdmin }, async () => {
    const [rows, counts] = await Promise.all([listShared(), appCounts()])
    const live = await Promise.all(rows.map((r) => sightingsOrNull(r.id)))
    return {
      data: rows.map((r, i) => ({
        ...r,
        apps: counts.get(r.id) ?? 0,
        live_replicas: live[i] === null ? null : (live[i] as Sighting[]).length
      }))
    }
  })

  app.get('/shared/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const row = id === null ? null : await getShared(id)
    if (id === null || !row) return notFound(reply)
    const [apps, sightings, prevUntil] = await Promise.all([
      appsPlaced(id),
      sightingsOrNull(id),
      previousTokenUntil(id)
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
        env_block: envBlock(row, null),
        warnings
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
        !(PATCHABLE as readonly string[]).includes(k)
    )
    if (other.length)
      return refuse(
        reply,
        400,
        'NOT_EDITABLE',
        `These fields cannot be changed here: ${other.slice(0, 10).join(', ')}.`
      )
    return guarded(reply, async () => {
      const checked = validateSharedInput(b, existing)
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
      await logActivity({
        action: 'hub-shared-update',
        user: userId(req),
        collection: SHARED,
        item: String(id),
        req,
        changed_fields: changed
      })
      if (changes.link_url !== undefined) await forgetStatus(app, id)
      return { data: updated }
    })
  })

  app.post('/shared/:id/token', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const row = id === null ? null : await getShared(id)
    if (id === null || !row) return notFound(reply)
    if (row.status === 'retired')
      return refuse(reply, 409, 'SHARED_RETIRED', 'This shared deployment is retired.')
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
      let reapply: 'manual' | 'started' | 'unavailable' | 'failed' = 'manual'
      let reapply_reason: string | null = null
      if (row.mode === 'docker') {
        if (!reapplyAfterRotation) reapply = 'unavailable'
        else {
          try {
            const r = await reapplyAfterRotation(row, userId(req))
            reapply = r.started ? 'started' : 'failed'
            reapply_reason = r.started ? null : (r.reason ?? null)
          } catch (err) {
            reapply = 'failed'
            // A code only, never the error's text.
            const code = (err as { code?: unknown } | null)?.code
            reapply_reason =
              typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null
          }
        }
      }
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
    const env = envId === null ? null : await readEnv(envId)
    if (envId === null || !env) return notFound(reply, 'environment')
    const key = await openAppKey(envId)
    if (!key)
      return {
        data: {
          known: false,
          key: null,
          fp: null,
          source: null,
          code: 'APP_KEY_UNKNOWN',
          message: APP_KEY_UNKNOWN_MESSAGE
        }
      }
    const fp = keyFingerprint(key)
    return {
      data: {
        known: true,
        key: HUB_MASK,
        fp,
        source: env.encryption_key && env.encryption_key_fp === fp ? 'entry' : 'stack'
      }
    }
  })

  app.put('/environments/:envId/app-key', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = idParam((req.params as { envId: string }).envId)
    const env = envId === null ? null : await readEnv(envId)
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
    const fp = keyFingerprint(key.toLowerCase())
    const running = await runningKeyFp(env)
    if (running.source !== null && running.fp !== null && running.fp !== fp)
      return refuse(reply, 409, 'APP_KEY_MISMATCH', MISMATCH_TEXT[running.source])
    return guarded(reply, async () => {
      const saved = await setAppKey(envId, key)
      await logActivity({
        action: 'hub-app-key',
        user: userId(req),
        collection: ENVS,
        item: String(envId),
        req
      })
      return {
        data: {
          fp: saved.fp,
          // Where the key was checked against what the app runs with; null = it could not be.
          verified: running.source !== null && running.fp !== null ? running.source : null,
          ...(running.source === null ? { unverified_code: running.code } : {})
        }
      }
    })
  })
}
