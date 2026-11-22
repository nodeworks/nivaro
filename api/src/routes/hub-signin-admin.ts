import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { credentialMintRefusal, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam, isAppOwner, isSigninMode, readApp } from '../services/hub/apps.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import {
  clientForEnvironment,
  createClient,
  HubClientError,
  type HubOidcClient,
  rotateClientSecret,
  setClientActive
} from '../services/hub/oidc/clients.js'
import { hubIssuer, listSigningKeys, rotateSigningKey } from '../services/hub/oidc/keys.js'
import { HUB_MASK, HubSecretError } from '../services/hub/secrets.js'

/**
 * Nivaro Hub phase 7: sign-in settings, mounted at /api/hub/signin (hub mode only, never cloud).
 *
 *   GET   /settings                          issuer, the Hub's Entra client id; keys for admins
 *   POST  /keys/rotate                       Hub admins only
 *   PATCH /apps/:id/mode                     { signin_mode: 'direct' | 'hub' }
 *   GET   /environments/:envId/client        the client (secret masked), env lines, sign-ins
 *   POST  /environments/:envId/client        201, the plain secret ONCE
 *   POST  /environments/:envId/client/rotate the new plain secret ONCE
 *   PATCH /environments/:envId/client        { active }
 *
 * App and environment routes: a Hub admin, or an owner of that app (plan Decision 7: owners
 * manage their app's sign-in); anyone else gets 404, never 403. Every write is logged; no
 * activity row, log line or later read ever holds a client secret. Every write here is refused
 * to View-as / run-as-key (DELEGATED_NO_WRITE) and connected apps (OAUTH_NO_WRITE); minting or
 * rotating a secret or key also needs the person's own session or static token.
 */

const APPS = 'nivaro_hub_apps'
const ENVS = 'nivaro_hub_environments'
const CLIENTS = 'nivaro_hub_oidc_clients'
const SIGNINS = 'nivaro_hub_signins'
const DAY_MS = 86_400_000

type Body = Record<string, unknown>

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Not found')

function userId(req: FastifyRequest): string {
  return String(req.user?.id ?? '')
}

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

/** The answer carrying a plain secret is never stored by a browser or proxy. */
function noStore(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store')
  reply.header('Pragma', 'no-cache')
}

/** A client/secret refusal answers with its own status and code (never a secret). */
async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (e) {
    if (e instanceof HubClientError) return fail(reply, e.status, e.code, e.message)
    if (e instanceof HubSecretError) return fail(reply, 400, e.code, e.message)
    throw e
  }
}

/**
 * Minting or rotating a secret or key: only a person signed in as themselves (a session or their
 * own static token) — never a View-as, run-as-key, named API key or connected app (403).
 */
function mintRefused(req: FastifyRequest, reply: FastifyReply) {
  const refusal = credentialMintRefusal(req)
  return refusal ? fail(reply, 403, refusal.code, refusal.error) : null
}

/** The app `:id` names when the caller may manage its sign-in; else null (404). */
async function manageableApp(req: FastifyRequest): Promise<number | null> {
  const id = idParam((req.params as { id: string }).id)
  if (id === null || !(await readApp(id))) return null
  if (!req.isAdmin && !(await isAppOwner(id, userId(req)))) return null
  return id
}

/** The environment `:envId` names when the caller may manage its sign-in; else null (404). */
async function manageableEnvironment(
  req: FastifyRequest
): Promise<{ id: number; app_id: number; key: string } | null> {
  const id = idParam((req.params as { envId: string }).envId)
  if (id === null) return null
  const row = (await db(ENVS).where({ id }).first('id', 'app_id', 'key')) as
    | { id: number; app_id: number; key: string }
    | undefined
  if (!row) return null
  if (!req.isAdmin && !(await isAppOwner(Number(row.app_id), userId(req)))) return null
  return { id: Number(row.id), app_id: Number(row.app_id), key: String(row.key) }
}

function hubOrigin(): string {
  return new URL(config.PUBLIC_URL).origin
}

function idpAudience(): string | null {
  return config.OIDC_CLIENT_ID || null
}

/** What an app sets in its environment for Hub sign-in (the secret is added by the client UI). */
function envLines(clientId: string | null) {
  return { HUB_URL: hubOrigin(), HUB_CLIENT_ID: clientId, HUB_IDP_AUDIENCE: idpAudience() }
}

function isoOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

/** The client for a read: never the secret, only the mask. */
async function clientView(client: HubOidcClient) {
  const row = (await db(CLIENTS)
    .where({ id: client.id })
    .first('created_at', 'secret_rotated_at')) as Record<string, unknown> | undefined
  return {
    client_id: client.client_id,
    active: client.active,
    secret: HUB_MASK,
    redirect_uris: client.redirect_uris,
    post_logout_uris: client.post_logout_uris,
    created_at: isoOf(row?.created_at),
    secret_rotated_at: isoOf(row?.secret_rotated_at)
  }
}

async function signinsLast30Days(envId: number): Promise<number> {
  const since = new Date(Date.now() - 30 * DAY_MS)
  const row = (await db(SIGNINS)
    .where({ environment_id: envId })
    .where('last_seen', '>=', since)
    .count({ n: '*' })
    .first()) as { n: number | string } | undefined
  return Number(row?.n ?? 0)
}

export async function hubSigninAdminRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  app.get('/settings', { preHandler: requireAuth }, async (req) => {
    return {
      data: {
        issuer: hubIssuer(),
        idp_audience: idpAudience(),
        keys: req.isAdmin === true ? await listSigningKeys() : null
      }
    }
  })

  app.post('/keys/rotate', { preHandler: requireAdmin }, async (req, reply) => {
    const refused = mintRefused(req, reply)
    if (refused) return refused
    const { kid } = await rotateSigningKey(userId(req))
    await logActivity({
      action: 'hub-signin-key-rotate',
      user: userId(req),
      collection: 'nivaro_hub_oidc_keys',
      item: kid,
      comment: 'Signing key rotated',
      req
    })
    return { data: { kid } }
  })

  app.patch('/apps/:id/mode', { preHandler: requireAuth }, async (req, reply) => {
    const id = await manageableApp(req)
    if (id === null) return notFound(reply)
    const mode = body(req).signin_mode
    if (!isSigninMode(mode))
      return fail(reply, 400, 'BAD_SIGNIN_MODE', "signin_mode must be 'direct' or 'hub'")
    await db(APPS).where({ id }).update({ signin_mode: mode, updated_at: new Date() })
    await logActivity({
      action: 'hub-signin-mode',
      user: userId(req),
      collection: APPS,
      item: String(id),
      comment: `Sign-in mode: ${mode}`,
      req,
      changed_fields: ['signin_mode']
    })
    return { data: await readApp(id) }
  })

  app.get('/environments/:envId/client', { preHandler: requireAuth }, async (req, reply) => {
    const env = await manageableEnvironment(req)
    if (!env) return notFound(reply)
    const client = await clientForEnvironment(env.id)
    return {
      data: {
        client: client ? await clientView(client) : null,
        env_lines: envLines(client?.client_id ?? null),
        signins_30d: await signinsLast30Days(env.id)
      }
    }
  })

  app.post('/environments/:envId/client', { preHandler: requireAuth }, async (req, reply) => {
    const env = await manageableEnvironment(req)
    if (!env) return notFound(reply)
    const refused = mintRefused(req, reply)
    if (refused) return refused
    return guarded(reply, async () => {
      const made = await createClient(env.id, userId(req))
      const client = await clientForEnvironment(env.id)
      await logActivity({
        action: 'hub-signin-client-create',
        user: userId(req),
        collection: CLIENTS,
        item: client ? String(client.id) : undefined,
        comment: `Sign-in client ${made.client_id} created for environment ${env.key}`,
        req
      })
      noStore(reply)
      reply.code(201)
      return {
        data: {
          client_id: made.client_id,
          client_secret: made.client_secret,
          env_lines: envLines(made.client_id)
        }
      }
    })
  })

  app.post(
    '/environments/:envId/client/rotate',
    { preHandler: requireAuth },
    async (req, reply) => {
      const env = await manageableEnvironment(req)
      if (!env) return notFound(reply)
      const refused = mintRefused(req, reply)
      if (refused) return refused
      return guarded(reply, async () => {
        const { client_secret } = await rotateClientSecret(env.id, userId(req))
        const client = await clientForEnvironment(env.id)
        await logActivity({
          action: 'hub-signin-client-rotate',
          user: userId(req),
          collection: CLIENTS,
          item: client ? String(client.id) : undefined,
          comment: `Secret rotated for sign-in client ${client?.client_id ?? ''}`.trim(),
          req
        })
        noStore(reply)
        return { data: { client_secret } }
      })
    }
  )

  app.patch('/environments/:envId/client', { preHandler: requireAuth }, async (req, reply) => {
    const env = await manageableEnvironment(req)
    if (!env) return notFound(reply)
    const active = body(req).active
    if (typeof active !== 'boolean')
      return fail(reply, 400, 'BAD_ACTIVE', 'active must be true or false')
    return guarded(reply, async () => {
      await setClientActive(env.id, active)
      const client = await clientForEnvironment(env.id)
      await logActivity({
        action: 'hub-signin-client-toggle',
        user: userId(req),
        collection: CLIENTS,
        item: client ? String(client.id) : undefined,
        comment: `Sign-in client ${client?.client_id ?? ''} ${active ? 'turned on' : 'turned off'}`,
        req,
        changed_fields: ['active']
      })
      return { data: { client: client ? await clientView(client) : null } }
    })
  })
}
