import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import { db } from '../../db/index.js'
import { getApp } from '../io-holder.js'

/**
 * Nivaro Hub: what an app OWNER (nivaro_hub_app_owners) may do on their own app without being a
 * Hub admin. Reads (status, deploy history, run logs, stack status) were theirs already; the
 * writes below are theirs on NON-PRODUCTION environments only, unless a Hub admin turned on the
 * app's "owners may deploy production" switch (nivaro_hub_apps.owners_deploy_production).
 *
 * Production (fail closed: any ONE signal is enough, and an unknown signal never opens anything):
 *   1. the admin's per-environment flag `production` is true (nivaro_hub_environments.production);
 *   2. the key says so: prod / production / prd / live as a word of it (prod-eu, production2,
 *      prd_eu, eu.live — PRODUCTION_KEY_RE);
 *   3. the environment's own hub link last reported NIVARO_ENVIRONMENT=production (the cached
 *      status, `app_environment`; an app before 0.3.215 reports nothing);
 *   4. it comes AT OR AFTER the first environment with signal 1–3 in the chain (position, then
 *      id) — two regions and anything appended after production stay protected;
 *   5. it is the LAST non-archived environment of the chain;
 *   4 and 5 yield to an admin's explicit false (the only way to open such an environment);
 *   and an archived environment always counts as production (nothing deploys there anyway).
 * So an app with one environment has only production, archiving the last environment never
 * opens the one before it, and EFP's development → staging → production gives owners
 * development and staging.
 *
 * Every rule is enforced on the server: OWNER_GUARDED lists the routes (relative to /api/hub),
 * and ownerGuardOnRoute (registered once in routes/hub.ts) appends `ownerDeployGuard` to each
 * one's preHandlers, after its own sign-in check. Admins pass; a person who is neither admin nor
 * owner passes the guard too and gets the route's own 404. An owner on production gets 403
 * PRODUCTION_ADMIN_ONLY. owner-access.guard test pins that every non-admin Hub write is listed
 * here or in OWNER_UNGUARDED with a reason.
 */

export const PRODUCTION_KEY_RE = /(^|[-_.])(prod|production|prd|live)([-_.]|\d|$)/i

export interface EnvOrder {
  id: number
  key: string
  position: number
  /** nivaro_hub_environments.status; 'archived' leaves the chain. */
  status?: string | null
  /** The admin's flag: true = production, false = explicitly not (opens a last env), null = auto. */
  production?: boolean | null
  /** What the environment's hub link last reported as NIVARO_ENVIRONMENT (lower-case), if any. */
  reported?: string | null
}

const isArchived = (e: EnvOrder) => String(e.status ?? '').toLowerCase() === 'archived'

/** An explicit signal (flag true, a production word in the key, the app's own report). */
function saysProduction(e: EnvOrder): boolean {
  return (
    e.production === true ||
    PRODUCTION_KEY_RE.test(e.key) ||
    String(e.reported ?? '').toLowerCase() === 'production'
  )
}

/**
 * THE production rule (one helper: the owner gate, GET /apps/:id/access, the people lookup and
 * the phone summary all call it, so they cannot disagree). Per environment of one app:
 *   - archived → production (and it leaves the chain);
 *   - an explicit signal (flag true, key word, the app's own report) → production;
 *   - every environment AT OR AFTER the first one with an explicit signal, in chain order
 *     (position, then id) → production, so two regions (prod-eu, prod-us) and anything appended
 *     after production (a dr, a qa) are all protected — unless an admin set its flag to false;
 *   - the last non-archived environment → production, unless an admin set its flag to false.
 */
export function productionMap(all: EnvOrder[]): Map<number, boolean> {
  const out = new Map<number, boolean>()
  const chain = all
    .filter((e) => !isArchived(e))
    .sort((a, b) => a.position - b.position || a.id - b.id)
  for (const e of all) if (isArchived(e)) out.set(e.id, true)
  const first = chain.findIndex(saysProduction)
  chain.forEach((e, i) => {
    const onward = first >= 0 && i >= first
    out.set(
      e.id,
      saysProduction(e) || (e.production !== false && (onward || i === chain.length - 1))
    )
  })
  return out
}

/** Production per productionMap. `all` = the app's environments (this one included). */
export function isProductionEnv(env: EnvOrder, all: EnvOrder[]): boolean {
  const list = all.some((e) => e.id === env.id)
    ? all.map((e) => (e.id === env.id ? { ...e, ...env } : e))
    : [...all, env]
  return productionMap(list).get(env.id) ?? true
}

/** A stored flag as true / false / null (a NULL or unknown value is null = auto). */
export function flagOf(v: unknown): boolean | null {
  if (v === true || v === 1 || v === '1') return true
  if (v === false || v === 0 || v === '0') return false
  return null
}

export interface OwnerRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Fastify route path relative to the /api/hub prefix. */
  url: string
  /** Where the environment comes from: the :envId param, the promotion (:id) it belongs to, or
   *  'app' (:id = an app: a change that reaches every environment, production included). */
  env: 'envId' | 'promotion' | 'app' | 'database'
  what: string
}

export const OWNER_GUARDED: OwnerRoute[] = [
  { method: 'POST', url: '/environments/:envId/promote/plan', env: 'envId', what: 'plan' },
  { method: 'POST', url: '/environments/:envId/promote', env: 'envId', what: 'promote' },
  { method: 'POST', url: '/promotions/:id/cancel', env: 'promotion', what: 'cancel' },
  { method: 'POST', url: '/environments/:envId/stack/restart', env: 'envId', what: 'restart' },
  { method: 'POST', url: '/environments/:envId/stack/apply', env: 'envId', what: 'apply' },
  { method: 'GET', url: '/environments/:envId/stack/settings', env: 'envId', what: 'settings' },
  // A database record's connection (routes/hub-create.ts): an owner may set it for their own
  // app's non-production environments only; production's database is the administrators'.
  {
    method: 'PUT',
    url: '/databases/:id/connection',
    env: 'database',
    what: 'database connection'
  },
  // Sign-in (routes/hub-signin-admin.ts, mounted at /api/hub/signin): changing production's
  // sign-in mode or its OpenID client breaks production sign-in, so the production rule applies.
  { method: 'PATCH', url: '/signin/apps/:id/mode', env: 'app', what: 'sign-in mode' },
  {
    method: 'POST',
    url: '/signin/environments/:envId/client',
    env: 'envId',
    what: 'sign-in client'
  },
  {
    method: 'PATCH',
    url: '/signin/environments/:envId/client',
    env: 'envId',
    what: 'sign-in client'
  },
  {
    method: 'POST',
    url: '/signin/environments/:envId/client/rotate',
    env: 'envId',
    what: 'sign-in secret'
  }
]

/**
 * Hub routes a signed-in non-admin may reach that are NOT owner-guarded, with why (reads, or
 * writes the route itself limits). The guard test fails on a requireAuth write missing from both.
 */
export const OWNER_UNGUARDED: Record<string, string> = {
  'POST /environments/:envId/stack/check-name':
    'a name check (read of DNS + the app), owners only while the environment waits for its name',
  'POST /environments/:envId/stack/remove': 'admin-only inside the route',
  'PUT /environments/:envId/stack/settings': 'admin-only inside the route',
  'POST /databases/:id/check': 'a connection check, to the database’s own server only',
  'POST /environments/:envId/creation/check': 're-checks a creation step (a read of its state)',
  'POST /environments/:envId/creation/installed':
    'the operator says the app is installed (a creation wait), nothing is deployed',
  // Release operations (routes/hub-releases.ts): reads that carry a body, nothing deploys.
  'POST /apps/:id/trains/check': 'a read: what a train would do, its first plan and a freeze now',
  'POST /environments/:envId/release-notes':
    'a read: what a promotion or rollback of a version would change (GitLab read-only)',
  'POST /deploys/:id/release-notes':
    'works out and stores the release notes of a past run the caller may read; deploys nothing',
  // Change operations (routes/hub-changes.ts): a pre-deploy checklist is opened and ticked by
  // whoever its items allow; nothing deploys, and the start itself stays owner-guarded.
  'POST /environments/:envId/checklist-runs':
    'opens the pre-deploy checklist of a start the caller may read; deploys nothing',
  'POST /checklist-runs/:id/tick':
    'ticks one checklist item; the route lets only the people the item names (admin, owner, named) tick it',
  'POST /checklist-runs/:id/void': 'sets an open checklist aside (admins and the app’s owners)'
}

export interface OwnerRefusal {
  status: 403
  code: 'PRODUCTION_ADMIN_ONLY'
  error: string
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1'

export interface EnvPolicy {
  envId: number
  appId: number
  production: boolean
  ownersDeployProduction: boolean
}

/** The environment's production flag and its app's switch, or null (no such environment). */
export async function envPolicy(envId: number): Promise<EnvPolicy | null> {
  const env = (await db('nivaro_hub_environments').where({ id: envId }).first('id', 'app_id')) as
    | { id: number; app_id: number }
    | undefined
  if (!env) return null
  const appId = Number(env.app_id)
  const list = await appEnvironments(appId)
  const me = list.find((e) => e.id === Number(envId))
  if (!me) return null
  for (const e of list) e.reported = await reportedEnvironment(e.id)
  return {
    envId: me.id,
    appId,
    production: isProductionEnv(me, list),
    ownersDeployProduction: await ownersDeployProduction(appId)
  }
}

/** The app's environments as the production rule reads them (archived ones included). */
export async function appEnvironments(appId: number): Promise<EnvOrder[]> {
  const rows = (await db('nivaro_hub_environments')
    .where({ app_id: appId })
    .orderBy([
      { column: 'position', order: 'asc' },
      { column: 'id', order: 'asc' }
    ])
    .select('*')) as Array<Record<string, unknown>>
  return rows.map((e) => ({
    id: Number(e.id),
    key: String(e.key),
    position: Number(e.position ?? 0),
    status: e.status == null ? null : String(e.status),
    production: flagOf(e.production)
  }))
}

type StatusGet = { get(key: string): Promise<string | null> }

/**
 * What the environment's hub link last reported as NIVARO_ENVIRONMENT, from the cached status
 * (services/hub/status.ts `app_environment`), or null: no cache, nothing reported, Redis slow or
 * down (bounded 300 ms). Only ever ADDS production; null never opens anything.
 */
export async function reportedEnvironment(
  envId: number,
  redis: StatusGet | null = defaultRedis()
): Promise<string | null> {
  if (!redis) return null
  try {
    const { hubStatusKey } = await import('./status.js')
    let timer: NodeJS.Timeout | undefined
    const raw = await Promise.race([
      redis.get(hubStatusKey(envId)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 300)
      })
    ]).finally(() => clearTimeout(timer))
    if (!raw) return null
    const v = (JSON.parse(raw) as { app_environment?: unknown }).app_environment
    return typeof v === 'string' && v ? v.toLowerCase().slice(0, 32) : null
  } catch {
    return null
  }
}

function defaultRedis(): StatusGet | null {
  try {
    const app = getApp() as { redis?: StatusGet } | null
    return app?.redis && typeof app.redis.get === 'function' ? app.redis : null
  } catch {
    return null
  }
}

/** The app's switch; false when the column is missing (an older schema) or unreadable. */
export async function ownersDeployProduction(appId: number): Promise<boolean> {
  try {
    const row = (await db('nivaro_hub_apps')
      .where({ id: appId })
      .first('owners_deploy_production')) as { owners_deploy_production?: unknown } | undefined
    return truthy(row?.owners_deploy_production)
  } catch {
    return false
  }
}

async function isOwner(appId: number, userId: string): Promise<boolean> {
  if (!userId) return false
  const { isAppOwner } = await import('./apps.js')
  return isAppOwner(appId, userId)
}

/**
 * The refusal for an owner's deploy-class action on this environment, or null (admin, allowed,
 * not an owner — the route answers its own 404 — or no such environment).
 */
export async function ownerDeployRefusal(
  req: Pick<FastifyRequest, 'isAdmin' | 'user'>,
  envId: number
): Promise<OwnerRefusal | null> {
  if (req.isAdmin === true) return null
  const policy = await envPolicy(envId)
  if (!policy) return null
  if (!(await isOwner(policy.appId, String(req.user?.id ?? '')))) return null
  if (!policy.production || policy.ownersDeployProduction) return null
  return {
    status: 403,
    code: 'PRODUCTION_ADMIN_ONLY',
    error:
      'Production is deployed by Hub administrators on this app. A Hub administrator can let owners deploy production.'
  }
}

/**
 * An owner's change that reaches the whole app (sign-in mode): refused while the app has a
 * production environment (it always has one once it has any) and its switch is off.
 */
export async function ownerAppRefusal(
  req: Pick<FastifyRequest, 'isAdmin' | 'user'>,
  appId: number
): Promise<OwnerRefusal | null> {
  if (req.isAdmin === true) return null
  if (!(await isOwner(appId, String(req.user?.id ?? '')))) return null
  if (await ownersDeployProduction(appId)) return null
  const envs = await appEnvironments(appId)
  const live = envs.filter((e) => String(e.status ?? '') !== 'archived')
  if (!live.length) return null
  return {
    status: 403,
    code: 'PRODUCTION_ADMIN_ONLY',
    error:
      'This changes production too, which Hub administrators deploy on this app. A Hub administrator can let owners deploy production.'
  }
}

async function envIdFor(req: FastifyRequest, route: OwnerRoute): Promise<number | null> {
  const params = (req.params ?? {}) as Record<string, string | undefined>
  const raw = route.env === 'envId' ? params.envId : params.id
  if (!raw || !/^\d{1,15}$/.test(raw)) return null
  if (route.env === 'envId') return Number(raw)
  if (route.env === 'database') {
    const { getDatabase } = await import('./db/databases.js')
    const d = await getDatabase(Number(raw))
    return d?.environment?.id == null ? null : Number(d.environment.id)
  }
  const row = (await db('nivaro_hub_deploys')
    .where({ id: Number(raw) })
    .first('environment_id')) as { environment_id: number | null } | undefined
  return row?.environment_id == null ? null : Number(row.environment_id)
}

function guardFor(route: OwnerRoute) {
  return async function ownerDeployGuard(req: FastifyRequest, reply: FastifyReply) {
    if (req.isAdmin === true) return
    if (route.env === 'app') {
      const raw = String((req.params as { id?: string } | undefined)?.id ?? '')
      if (!/^\d{1,15}$/.test(raw)) return
      const refused = await ownerAppRefusal(req, Number(raw))
      if (refused)
        return reply.code(refused.status).send({ error: refused.error, code: refused.code })
      return
    }
    const envId = await envIdFor(req, route)
    if (envId === null) return
    const refusal = await ownerDeployRefusal(req, envId)
    if (refusal)
      return reply.code(refusal.status).send({ error: refusal.error, code: refusal.code })
  }
}

/** The OWNER_GUARDED entry a route matches (method + path relative to the Hub prefix). */
export function ownerRouteFor(method: string | string[], url: string): OwnerRoute | null {
  const methods = Array.isArray(method) ? method : [method]
  return (
    OWNER_GUARDED.find(
      (r) => methods.includes(r.method) && (url === r.url || url.endsWith(`/hub${r.url}`))
    ) ?? null
  )
}

/** onRoute hook (routes/hub.ts, routes/hub-signin-admin.ts): appends the guard to every
 *  OWNER_GUARDED route. */
export function ownerGuardOnRoute(opts: RouteOptions): void {
  const route = ownerRouteFor(opts.method, opts.url)
  if (!route) return
  const guard = guardFor(route)
  const pre = opts.preHandler
  opts.preHandler = pre ? [...(Array.isArray(pre) ? pre : [pre]), guard] : [guard]
}
