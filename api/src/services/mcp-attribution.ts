import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { selectInChunks } from './db-batch.js'
import { agentBadgeLabel, cleanBadge, mcpConnOf, readMcpSettings } from './mcp-calls.js'

/**
 * Which writes an agent made, and the badge records show for them (#3213, #3219).
 *
 * Every activity row a hosted-MCP tool call writes (req.mcpInner — the in-process call
 * routes/mcp.ts makes as the caller) carries the connection it arrived on (`mcp_conn`) and the
 * connected app's name at that moment (`via_app`, migration 512). The badge text is computed
 * when read, from the MCP settings ("via <app>" or one fixed label), so changing the setting
 * relabels history. Writes made by the person themselves, scripts with an API key outside MCP,
 * crons and imports carry nothing.
 *
 * The stamp comes from server-known facts only — the inner marker, the credential and its
 * registered name — never from a header the caller chose.
 */

export interface McpWriteStamp {
  mcp_conn: string
  via_app: string
}

type StampSource = Pick<
  FastifyRequest,
  'mcpInner' | 'authMethod' | 'oauthGrantId' | 'oauthClientId' | 'oauthClientName' | 'user'
> & {
  apiKeyId?: number | null
  apiKeySimulatedId?: number | null
  apiKeyName?: string
}

/**
 * The connected app's name, from the credential only — the same rule as mcpAppLabel
 * (services/mcp-config.ts, kept out of this module so the activity log never loads config):
 * the OAuth client's registered name, the API key's name, else "Assistant".
 */
function appNameOf(req: StampSource): string {
  if (req.authMethod === 'oauth' && req.oauthClientId)
    return cleanBadge(String(req.oauthClientName ?? '')) || 'Connected app'
  const keyId = req.apiKeyId ?? req.apiKeySimulatedId
  if ((req.authMethod === 'api_key' || req.authMethod === 'key_sim') && keyId != null)
    return cleanBadge(String(req.apiKeyName ?? '')) || 'API key'
  return 'Assistant'
}

/** The stamp of a write made through the hosted MCP endpoint, else null (pure). */
export function mcpWriteStampOf(req: StampSource | null | undefined): McpWriteStamp | null {
  if (!req?.mcpInner) return null
  const conn = mcpConnOf(req)
  if (!conn) return null
  return { mcp_conn: conn, via_app: appNameOf(req).slice(0, 80) }
}

/** True when nivaro_activity has the attribution columns (migration 512). */
export const hasAttributionColumns = () =>
  hasColumn('nivaro_activity', 'mcp_conn').catch(() => false)

/** The activity insert's attribution columns — nothing off MCP or behind migration 512. */
export async function attributionColumns(
  req: StampSource | null | undefined
): Promise<Record<string, string>> {
  const stamp = mcpWriteStampOf(req)
  if (!stamp) return {}
  if (!(await hasAttributionColumns())) return {}
  return { mcp_conn: stamp.mcp_conn, via_app: stamp.via_app }
}

/** Badge text per activity id, for the activity rows an agent wrote. */
export async function agentBadgesForActivity(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const uniq = [...new Set(ids.filter((i) => Number.isInteger(i) && i > 0))]
  if (!uniq.length || !(await hasAttributionColumns())) return out
  const rows = (await selectInChunks(uniq, 1000, (chunk) =>
    Promise.resolve(
      db('nivaro_activity').whereIn('id', chunk).whereNotNull('mcp_conn').select('id', 'via_app')
    )
  ).catch(() => [])) as Array<{ id: number; via_app: string | null }>
  if (!rows.length) return out
  const settings = await readMcpSettings()
  for (const r of rows) out.set(Number(r.id), agentBadgeLabel(r.via_app, settings))
  return out
}

/** Badge text per comment id (lower-cased), for comments an agent posted. */
export async function agentBadgesForComments(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = [...new Set(ids.map((i) => String(i)).filter(Boolean))]
  if (!uniq.length || !(await hasAttributionColumns())) return out
  const rows = (await selectInChunks(uniq, 1000, (chunk) =>
    Promise.resolve(
      db('nivaro_activity')
        .where({ collection: 'nivaro_comments', action: 'create' })
        .whereIn('item', chunk)
        .whereNotNull('mcp_conn')
        .select('item', 'via_app')
    )
  ).catch(() => [])) as Array<{ item: string; via_app: string | null }>
  if (!rows.length) return out
  const settings = await readMcpSettings()
  for (const r of rows) out.set(String(r.item).toLowerCase(), agentBadgeLabel(r.via_app, settings))
  return out
}
