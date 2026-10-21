import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { config } from '../config.js'
import { OAUTH_CHAT_SCOPE } from '../lib/oauth.js'

/**
 * Remote MCP settings (env only):
 *   MCP_HTTP=off         no /api/mcp endpoint (the npm stdio server still works with an API key)
 *   MCP_OAUTH=off        no OAuth sign-in for remote clients (API keys still work on /api/mcp)
 *   MCP_PUBLIC_URL=…     the origin remote clients reach this API on (issuer + resource);
 *                        default: the API's own host (ADMIN_URL in a deployment, PUBLIC_URL in dev)
 */
const off = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'off'

export const mcpHttpEnabled = () => !off(process.env.MCP_HTTP)
export const mcpOAuthEnabled = () => mcpHttpEnabled() && !off(process.env.MCP_OAUTH)

const trim = (u: string | null | undefined) => (u ? u.replace(/\/+$/, '') : '')

/**
 * The origin that serves this API directly — where the consent page, the token
 * endpoint and /api/mcp live. Login returns here, so it must be an origin the
 * IdP already knows (it is the one admin sign-in uses).
 */
export function mcpPublicOrigin(): string {
  const explicit = trim(process.env.MCP_PUBLIC_URL)
  if (explicit) return new URL(explicit).origin
  const base = config.NODE_ENV === 'development' ? config.PUBLIC_URL : adminBaseUrl()
  return new URL(trim(base) || config.PUBLIC_URL).origin
}

export const mcpResourceUrl = () => `${mcpPublicOrigin()}/api/mcp`
export const protectedResourceMetadataUrl = () =>
  `${mcpPublicOrigin()}/.well-known/oauth-protected-resource`

// ─── OAuth token audience ──────────────────────────────────────────────────

/**
 * An OAuth access token (nvo_) is for the MCP endpoint, not the whole API: it
 * is accepted on POST /api/mcp and on the tool calls that endpoint makes back
 * into the API in-process. Those calls carry this header with a per-process
 * random value only routes/mcp.ts knows; `markMcpInnerRequest` (a global
 * onRequest hook) turns it into `req.mcpInner` and deletes the header before
 * anything else — the request log included — sees it.
 */
export const MCP_INNER_HEADER = 'x-nivaro-mcp-inner'
const innerSecret = randomBytes(32).toString('base64url')
export const mcpInnerHeaderValue = () => innerSecret

export async function markMcpInnerRequest(req: FastifyRequest): Promise<void> {
  const v = req.headers[MCP_INNER_HEADER]
  if (v === undefined) return
  delete req.headers[MCP_INNER_HEADER]
  if (typeof v !== 'string') return
  const a = Buffer.from(v)
  const b = Buffer.from(innerSecret)
  if (a.length === b.length && timingSafeEqual(a, b)) req.mcpInner = true
}

/**
 * Routes an OAuth-connected app may never write to, whatever its user may do:
 * anything that signs in, mints or reveals a credential (API keys, run-as and
 * masquerade tokens, static tokens), manages OAuth connections, or writes a
 * system table through the items API. A connected app cannot leave behind a
 * credential that outlives its own disconnection.
 */
const OAUTH_NO_WRITE =
  /^\/api\/(auth|api-keys|oauth|graphql)(\/|$)|^\/api\/users\/[^/]+\/token(\/|$)|^\/api\/items\/(nivaro_|directus_)/i

/**
 * The path as the router will see it: percent-decoded (to a fixed point),
 * repeated slashes collapsed, lower-cased — so `/api/items/%6Eivaro_users`,
 * `//api/Items/NIVARO_users` and the plain spelling are judged alike.
 */
export function normalizedPath(url: string): string {
  let p = url.split('?')[0]
  for (let i = 0; i < 3; i++) {
    let d: string
    try {
      d = decodeURIComponent(p)
    } catch {
      break
    }
    if (d === p) break
    p = d
  }
  return p.replace(/\/{2,}/g, '/').toLowerCase()
}

export function oauthAudienceRefusal(req: FastifyRequest): string | null {
  const path = normalizedPath(req.url ?? '')
  if (path !== '/api/mcp' && !req.mcpInner)
    return 'This access token is for the MCP endpoint (/api/mcp) only'
  const m = req.method.toUpperCase()
  if (m !== 'GET' && m !== 'HEAD' && OAUTH_NO_WRITE.test(path))
    return 'A connected app cannot use this route'
  return null
}

// ─── Chat consent (#2492) ──────────────────────────────────────────────────

/**
 * The API-key scope entry that lets an AI assistant use chat through MCP:
 * `{ collection: '$chat', actions: ['read'] | ['read', 'create'] }`. Never
 * implied by `*` — a key made before chat tools existed does not gain them.
 */
export const CHAT_KEY_SCOPE = '$chat'

export type McpChatAccess = 'none' | 'read' | 'post'

type KeyScope = { collection: string; actions: string[] }

/** What a key's scope list allows in chat. */
export function keyChatAccess(scopes: KeyScope[] | null | undefined): McpChatAccess {
  const entry = (scopes ?? []).find((s) => s?.collection === CHAT_KEY_SCOPE)
  const actions = Array.isArray(entry?.actions) ? entry.actions : []
  if (actions.includes('*') || actions.includes('create')) return 'post'
  return actions.includes('read') ? 'read' : 'none'
}

/**
 * The chat tools a connection gets: an OAuth connection the person allowed chat
 * for may read and post; an API key gets what its `$chat` scope says; anything
 * else (static tokens, sessions, masquerade) gets none.
 */
export function mcpChatAccess(req: FastifyRequest): McpChatAccess {
  if (req.authMethod === 'oauth')
    return req.oauthScopes?.includes(OAUTH_CHAT_SCOPE) ? 'post' : 'none'
  if (req.authMethod === 'api_key' || req.authMethod === 'key_sim')
    return keyChatAccess(req.apiKeyScopes)
  return 'none'
}

/** Administrator tools: an administrator who is not on a collection-scoped key. */
export const mcpAdminTools = (req: FastifyRequest) => !!req.isAdmin && !req.user?.api_key_scopes

const CHAT_PATH = /^\/api\/chat(\/|$)/

/** An OAuth connection without the chat scope is refused on every chat route. */
export function oauthScopeRefusal(req: FastifyRequest, scopes: string[]): string | null {
  if (CHAT_PATH.test(normalizedPath(req.url ?? '')) && !scopes.includes(OAUTH_CHAT_SCOPE))
    return 'This connection was not allowed to use chat'
  return null
}

/** How long an app name shown on a chat message may be. */
export const APP_LABEL_MAX = 60

/** A registrant- or admin-chosen name made safe to show: no control characters, capped. */
function cleanAppName(raw: string | undefined, fallback: string): string {
  const s = [...String(raw ?? '')]
    .filter((c) => {
      const code = c.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return (s || fallback).slice(0, APP_LABEL_MAX)
}

/**
 * The app a chat message was posted through, from server-known facts only
 * (#2492): every post made with an OAuth access token carries the connected
 * app's registered name, every post made with an API key (or as one) the key's
 * name — whatever headers the caller sends. Sessions and static tokens are the
 * person themselves: null. `ref` names the credential so an administrator can
 * trace the message (the client id or key id rides the activity row); the name
 * itself is the registrant's choice and is only ever shown as app text.
 */
export function mcpAppLabel(req: FastifyRequest): { name: string; ref: string } | null {
  if (req.authMethod === 'oauth' && req.oauthClientId)
    return {
      name: cleanAppName(req.oauthClientName, 'Connected app'),
      ref: `oauth client ${req.oauthClientId}`
    }
  const keyId = req.apiKeyId ?? req.apiKeySimulatedId
  if ((req.authMethod === 'api_key' || req.authMethod === 'key_sim') && keyId != null)
    return { name: cleanAppName(req.apiKeyName, 'API key'), ref: `api key ${keyId}` }
  return null
}
