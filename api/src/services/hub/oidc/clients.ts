import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from '../../../config.js'
import { db } from '../../../db/index.js'
import { parseJson } from '../../pipeline-engine.js'
import { openSecret, sealSecret } from '../secrets.js'

/**
 * Nivaro Hub phase 7 (plan Decision 7): one confidential OpenID client per app environment.
 *
 *  - client_id `hubc_<24 hex>`; secret `hubs_<43 base64url>` (32 random bytes), sealed at rest,
 *    returned in plain only by createClient / rotateClientSecret (shown once by the route).
 *  - Redirect and post-logout URIs are DERIVED from the environment's base_url and hostnames on
 *    every read, never stored or typed: `<origin>/api/auth/callback` and `<origin>/login`. https
 *    only; plain http only for a loopback host and only off production. Origin only: user info,
 *    path, query and fragment are dropped. Callers compare a presented URI by exact string match.
 *  - Hostnames are Hub-admin-only (phase 1), so an app owner can never point codes elsewhere.
 *
 * Hub-only (HUB=on, never cloud mode).
 */

const CLIENTS = 'nivaro_hub_oidc_clients'
const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'

const CLIENT_ID_RE = /^hubc_[0-9a-f]{24}$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
/** A bare host name with an optional port: no scheme, user info, path, query or fragment. */
const HOSTNAME_RE =
  /^(?=[^:]{1,253}(:|$))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/i

export type HubOidcClient = {
  id: number
  environment_id: number
  app_id: number
  app_signin_mode: 'direct' | 'hub'
  env_key: string
  env_status: string
  client_id: string
  active: boolean
  redirect_uris: string[]
  post_logout_uris: string[]
  secret_sealed: string
}

/** A refusal the admin routes answer with its status and code. Never carries a secret. */
export class HubClientError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HubClientError'
    this.status = status
    this.code = code
  }
}

type EnvAddresses = { base_url: string; hostnames: string[] | null }
type DeriveOpts = { allowHttpLoopback?: boolean }

/** The origin a sign-in may return to, or null when the scheme/host is not allowed. */
function allowedOrigin(raw: string, allowHttpLoopback: boolean): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol === 'https:') return u.origin
  if (u.protocol === 'http:' && allowHttpLoopback && LOOPBACK.has(u.hostname)) return u.origin
  return null
}

/** The environment's origins: base_url first, then each well-formed hostname (https), deduped. */
function environmentOrigins(env: EnvAddresses, opts?: DeriveOpts): string[] {
  const allowHttpLoopback = opts?.allowHttpLoopback ?? config.NODE_ENV !== 'production'
  const out: string[] = []
  const add = (o: string | null) => {
    if (o && !out.includes(o)) out.push(o)
  }
  add(allowedOrigin(String(env.base_url ?? ''), allowHttpLoopback))
  for (const h of env.hostnames ?? []) {
    if (typeof h !== 'string') continue
    const host = h.trim()
    if (!HOSTNAME_RE.test(host)) continue
    add(allowedOrigin(`https://${host}`, false))
  }
  return out
}

export function derivedRedirectUris(env: EnvAddresses, opts?: DeriveOpts): string[] {
  return environmentOrigins(env, opts).map((o) => `${o}/api/auth/callback`)
}

export function derivedPostLogoutUris(env: EnvAddresses, opts?: DeriveOpts): string[] {
  return environmentOrigins(env, opts).map((o) => `${o}/login`)
}

function hostnameList(raw: unknown): string[] {
  const v = typeof raw === 'string' ? parseJson(raw) : raw
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1'
}

function clientFromRow(r: Record<string, unknown>): HubOidcClient {
  const env = { base_url: String(r.base_url ?? ''), hostnames: hostnameList(r.hostnames) }
  return {
    id: Number(r.id),
    environment_id: Number(r.environment_id),
    app_id: Number(r.app_id),
    app_signin_mode: r.app_signin_mode === 'hub' ? 'hub' : 'direct',
    env_key: String(r.env_key),
    env_status: String(r.env_status ?? 'active'),
    client_id: String(r.client_id),
    active: truthy(r.active),
    redirect_uris: derivedRedirectUris(env),
    post_logout_uris: derivedPostLogoutUris(env),
    secret_sealed: String(r.client_secret)
  }
}

function clientQuery() {
  return db(`${CLIENTS} as c`)
    .join(`${ENVS} as e`, 'e.id', 'c.environment_id')
    .join(`${APPS} as a`, 'a.id', 'e.app_id')
    .select(
      'c.id as id',
      'c.environment_id as environment_id',
      'c.client_id as client_id',
      'c.client_secret as client_secret',
      'c.active as active',
      'e.app_id as app_id',
      'e.key as env_key',
      'e.status as env_status',
      'e.base_url as base_url',
      'e.hostnames as hostnames',
      'a.signin_mode as app_signin_mode'
    )
}

export async function findClient(clientId: string): Promise<HubOidcClient | null> {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) return null
  const row = await clientQuery().where('c.client_id', clientId).first()
  return row ? clientFromRow(row) : null
}

export async function clientForEnvironment(envId: number): Promise<HubOidcClient | null> {
  const row = await clientQuery().where('c.environment_id', envId).first()
  return row ? clientFromRow(row) : null
}

function newClientId(): string {
  return `hubc_${randomBytes(12).toString('hex')}`
}

function newClientSecret(): string {
  return `hubs_${randomBytes(32).toString('base64url')}`
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: unknown; number?: unknown; errno?: unknown; message?: unknown }
  const code = String(err?.code ?? '')
  return (
    code === '23505' || // postgres
    code === 'ER_DUP_ENTRY' || // mysql / mariadb
    code.startsWith('SQLITE_CONSTRAINT') ||
    err?.number === 2627 || // sql server unique constraint
    err?.number === 2601 || // sql server unique index
    /unique/i.test(String(err?.message ?? ''))
  )
}

const noClient = () =>
  new HubClientError(404, 'NO_CLIENT', 'This environment has no sign-in client')

/** Creates the environment's client; the plain secret is returned here and nowhere else. */
export async function createClient(
  envId: number,
  userId: string
): Promise<{ client_id: string; client_secret: string }> {
  if (!(await db(ENVS).where({ id: envId }).first('id')))
    throw new HubClientError(404, 'NOT_FOUND', 'Not found')
  const exists = () =>
    new HubClientError(409, 'CLIENT_EXISTS', 'This environment already has a sign-in client')
  if (await db(CLIENTS).where({ environment_id: envId }).first('id')) throw exists()
  const client_id = newClientId()
  const client_secret = newClientSecret()
  const at = new Date()
  try {
    await db(CLIENTS).insert({
      environment_id: envId,
      client_id,
      client_secret: sealSecret(client_secret),
      active: true,
      created_by: userId || null,
      created_at: at,
      updated_at: at
    })
  } catch (e) {
    // Two creates racing: the unique (environment_id) index lets one through.
    if (isUniqueViolation(e)) throw exists()
    throw e
  }
  return { client_id, client_secret }
}

/** A new secret for the environment's client; the old one stops working at once. */
export async function rotateClientSecret(
  envId: number,
  _userId: string
): Promise<{ client_secret: string }> {
  const client_secret = newClientSecret()
  const sealed = sealSecret(client_secret)
  const at = new Date()
  const n = await db(CLIENTS)
    .where({ environment_id: envId })
    .update({ client_secret: sealed, secret_rotated_at: at, updated_at: at })
  if (!n) throw noClient()
  return { client_secret }
}

export async function setClientActive(envId: number, active: boolean): Promise<void> {
  const n = await db(CLIENTS)
    .where({ environment_id: envId })
    .update({ active: active === true, updated_at: new Date() })
  if (!n) throw noClient()
}

function sha256(v: string): Buffer {
  return createHash('sha256').update(v, 'utf8').digest()
}

/** True when `presented` is the client's secret: timing-safe over SHA-256 of both. */
export function clientSecretMatches(client: HubOidcClient, presented: string): boolean {
  if (typeof presented !== 'string' || !presented) return false
  let plain: string | null
  try {
    plain = openSecret(client.secret_sealed)
  } catch {
    return false
  }
  if (!plain) return false
  return timingSafeEqual(sha256(plain), sha256(presented))
}

/** A client may sign people in: active, its app in `hub` mode, its environment live. */
export function clientUsable(client: HubOidcClient): boolean {
  return (
    client.active &&
    client.app_signin_mode === 'hub' &&
    client.env_status !== 'archived' &&
    client.env_status !== 'suspended'
  )
}
