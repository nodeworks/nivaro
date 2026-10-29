import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { extensionToolRoster } from '../services/extension-tools.js'
import {
  dismiss,
  dismissalsReady,
  toolSuggestions,
  undismiss
} from '../services/mcp-suggestions.js'
import { builtinToolCatalog } from '../services/mcp-tool-catalog.js'
import { readNamedTools } from '../services/mcp-tools.js'

/**
 * Composite tool suggestions (#3206), beside the named-tool routes under /api/mcp-tools
 * (routes/mcp-tools.ts), administrators only:
 *
 *   GET    /suggestions              repeated multi-call patterns from 14 days of MCP calls,
 *                                    each with an editor prefill (?all=1 keeps dismissed ones)
 *   POST   /suggestions/dismiss      {key} — stop suggesting one pattern
 *   DELETE /suggestions/dismiss/:key — suggest it again
 */

const KEY_RE = /^[a-z][a-z0-9_]{0,63}(>[a-z][a-z0-9_]{0,63}){1,5}$/

export async function mcpSuggestionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { all?: string } }>(
    '/suggestions',
    { preHandler: requireAdmin },
    async (req) => {
      const [catalog, named, ext] = await Promise.all([
        builtinToolCatalog().catch(() => []),
        readNamedTools().catch(() => []),
        extensionToolRoster('mcp').catch(() => [])
      ])
      const readOnly = new Set<string>([
        ...catalog.filter((t) => t.read_only).map((t) => t.name),
        ...named.filter((t) => t.read_only).map((t) => t.name),
        ...ext.filter((t) => t.read_only).map((t) => t.name)
      ])
      const taken = new Set<string>([
        ...catalog.map((t) => t.name),
        ...named.map((t) => t.name),
        ...ext.map((t) => t.name)
      ])
      const out = await toolSuggestions({ all: req.query.all === '1', readOnly, taken })
      return { data: { ...out, window_days: 14, dismiss_ready: await dismissalsReady() } }
    }
  )

  app.post<{ Body: { key?: string } }>(
    '/suggestions/dismiss',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const key = String(req.body?.key ?? '')
      if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'key is not a pattern' })
      if (!(await dismissalsReady()))
        return reply.code(409).send({ error: 'Dismissing needs database migration 509' })
      await dismiss(key, String(req.user!.id))
      await logActivity({
        action: 'mcp-tool-suggestion',
        user: req.user!.id,
        comment: `dismissed ${key}`,
        req
      })
      return { data: { dismissed: true } }
    }
  )

  app.delete<{ Params: { key: string } }>(
    '/suggestions/dismiss/:key',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { key } = req.params
      if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'key is not a pattern' })
      if (!(await dismissalsReady())) return reply.code(404).send({ error: 'Not dismissed' })
      if (!(await undismiss(key))) return reply.code(404).send({ error: 'Not dismissed' })
      return { data: { dismissed: false } }
    }
  )
}
