import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import { db } from '../../db/index.js'

/**
 * Nivaro Hub: what an app OWNER (nivaro_hub_app_owners) may do on their own app without being a
 * Hub admin. Reads (status, deploy history, run logs, stack status) were theirs already; the
 * writes below are theirs on NON-PRODUCTION environments only, unless a Hub admin turned on the
 * app's "owners may deploy production" switch (nivaro_hub_apps.owners_deploy_production).
 *
 * Production (fail closed, no configuration needed): an environment whose key says so
 * (production / prod / prd / live), or the LAST environment of the app's promotion chain
 * (position, then id) — so an app with one environment has only production, and EFP's
 * development → staging → production gives owners development and staging.
 *
 * Every rule is enforced on the server: OWNER_GUARDED lists the routes (relative to /api/hub),
 * and ownerGuardOnRoute (registered once in routes/hub.ts) appends `ownerDeployGuard` to each
 * one's preHandlers, after its own sign-in check. Admins pass; a person who is neither admin nor
 * owner passes the guard too and gets the route's own 404. An owner on production gets 403
 * PRODUCTION_ADMIN_ONLY. owner-access.guard test pins that every non-admin Hub write is listed
 * here or in OWNER_UNGUARDED with a reason.
 */

export const PRODUCTION_KEY_RE = /^(production|prod|prd|live)$/i

export interface EnvOrder {
  id: number
  key: string
  position: number
}

/** Production per the header's rule. `all` = the app's environments (this one included). */
export function isProductionEnv(env: EnvOrder, all: EnvOrder[]): boolean {
  if (PRODUCTION_KEY_RE.test(env.key)) return true
  const list = all.some((e) => e.id === env.id) ? all : [...all, env]
  const last = [...list].sort((a, b) => b.position - a.position || b.id - a.id)[0]
  return !last || last.id === env.id
}

export interface OwnerRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Fastify route path relative to the /api/hub prefix. */
  url: string
  /** Where the environment comes from: the :envId param, or the promotion (:id) it belongs to. */
  env: 'envId' | 'promotion'
  what: string
}

export const OWNER_GUARDED: OwnerRoute[] = [
  { method: 'POST', url: '/environments/:envId/promote/plan', env: 'envId', what: 'plan' },
  { method: 'POST', url: '/environments/:envId/promote', env: 'envId', what: 'promote' },
  { method: 'POST', url: '/promotions/:id/cancel', env: 'promotion', what: 'cancel' },
  { method: 'POST', url: '/environments/:envId/stack/restart', env: 'envId', what: 'restart' },
  { method: 'POST', url: '/environments/:envId/stack/apply', env: 'envId', what: 'apply' },
  { method: 'GET', url: '/environments/:envId/stack/settings', env: 'envId', what: 'settings' }
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
  'PUT /databases/:id/connection':
    'an owner may record their own database’s connection (to its own server only, phase 3)',
  'POST /databases/:id/check': 'a connection check, to the database’s own server only',
  'POST /environments/:envId/creation/check': 're-checks a creation step (a read of its state)',
  'POST /environments/:envId/creation/installed':
    'the operator says the app is installed (a creation wait), nothing is deployed'
  // Sign-in settings (/api/hub/signin/*) are their own plugin and the owner's by the Hub design.
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
  const all = (await db('nivaro_hub_environments')
    .where({ app_id: appId })
    .select('id', 'key', 'position')) as Array<{ id: number; key: string; position: number }>
  const list = all.map((e) => ({
    id: Number(e.id),
    key: String(e.key),
    position: Number(e.position ?? 0)
  }))
  const me = list.find((e) => e.id === Number(envId))
  if (!me) return null
  return {
    envId: me.id,
    appId,
    production: isProductionEnv(me, list),
    ownersDeployProduction: await ownersDeployProduction(appId)
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

async function envIdFor(req: FastifyRequest, route: OwnerRoute): Promise<number | null> {
  const params = (req.params ?? {}) as Record<string, string | undefined>
  const raw = route.env === 'envId' ? params.envId : params.id
  if (!raw || !/^\d{1,15}$/.test(raw)) return null
  if (route.env === 'envId') return Number(raw)
  const row = (await db('nivaro_hub_deploys')
    .where({ id: Number(raw) })
    .first('environment_id')) as { environment_id: number | null } | undefined
  return row?.environment_id == null ? null : Number(row.environment_id)
}

function guardFor(route: OwnerRoute) {
  return async function ownerDeployGuard(req: FastifyRequest, reply: FastifyReply) {
    if (req.isAdmin === true) return
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

/** onRoute hook (routes/hub.ts): appends the guard to every OWNER_GUARDED route. */
export function ownerGuardOnRoute(opts: RouteOptions): void {
  const route = ownerRouteFor(opts.method, opts.url)
  if (!route) return
  const guard = guardFor(route)
  const pre = opts.preHandler
  opts.preHandler = pre ? [...(Array.isArray(pre) ? pre : [pre]), guard] : [guard]
}
