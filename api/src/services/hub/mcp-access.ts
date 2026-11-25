import type { FastifyRequest } from 'fastify'
import { hubModeEnabled } from './mode.js'

/**
 * Whether a caller of the hosted MCP endpoint (or the MCP console) gets the Hub tools (Hub
 * enhancement 25, review M4). Never implied by a broad grant, so a connection made for something
 * else never starts reading the Hub:
 *  - only on a Hub (HUB=on);
 *  - an OAuth connection needs the `hub:read` scope (the scope family enh-api adds to the Hub's
 *    credential gate);
 *  - an API key needs a `$hub` scope entry with `read` (`{collection: '$hub', actions: ['read']}`;
 *    `*` does not imply it);
 *  - a person's own session (the MCP console) gets them — unless it is narrowed to collections
 *    (`api_key_scopes` set by a collection-scoped key or an MCP connection's scope) without `$hub`.
 * The Hub routes the tools call still decide what each caller sees (admin: every app; owner: own).
 */
export const HUB_OAUTH_SCOPE = 'hub:read'
export const HUB_KEY_SCOPE = '$hub'

type KeyScope = { collection?: unknown; actions?: unknown }

export function keyHubRead(scopes: KeyScope[] | null | undefined): boolean {
  const entry = (scopes ?? []).find((s) => s?.collection === HUB_KEY_SCOPE)
  const actions = Array.isArray(entry?.actions) ? (entry.actions as unknown[]) : []
  return actions.includes('read') || actions.includes('*')
}

export function mcpHubAccess(req: FastifyRequest): boolean {
  if (!hubModeEnabled()) return false
  if (req.authMethod === 'oauth') {
    if (!req.oauthScopes?.includes(HUB_OAUTH_SCOPE)) return false
  } else if (req.authMethod === 'api_key' || req.authMethod === 'key_sim') {
    if (!keyHubRead(req.apiKeyScopes as KeyScope[] | undefined)) return false
  }
  // Narrowed to collections (a scoped key, or an MCP connection's scope) without a Hub entry.
  const narrowed = req.user?.api_key_scopes as KeyScope[] | null | undefined
  if (narrowed && !keyHubRead(narrowed)) return false
  return true
}
