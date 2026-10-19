import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { config } from '../config.js'

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
  /^\/api\/(auth|api-keys|oauth|graphql)(\/|$|\?)|^\/api\/users\/[^/]+\/token(\/|$|\?)|^\/api\/items\/(nivaro_|directus_)/

export function oauthAudienceRefusal(req: FastifyRequest): string | null {
  const path = (req.url ?? '').split('?')[0]
  if (path !== '/api/mcp' && !req.mcpInner)
    return 'This access token is for the MCP endpoint (/api/mcp) only'
  const m = req.method.toUpperCase()
  if (m !== 'GET' && m !== 'HEAD' && OAUTH_NO_WRITE.test(path))
    return 'A connected app cannot use this route'
  return null
}
