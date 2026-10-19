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
