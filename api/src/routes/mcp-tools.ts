import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { ExtensionToolError, extensionToolRoster } from '../services/extension-tools.js'
import {
  callInstanceTool,
  instanceToolCatalog,
  mcpCallerAccess,
  namedToolsReady,
  readNamedTools,
  validateNamedTools,
  writeNamedTools
} from '../services/mcp-tools.js'

/**
 * /api/mcp-tools — the instance's own MCP tools (#2465 extension tools,
 * #2464 named custom-query / flow tools).
 *
 *   GET  /mcp-tools              the tools the caller may use (hosted /api/mcp
 *                                lists them by name; the npm server's
 *                                list_instance_tools reads it)
 *   POST /mcp-tools/:name/call   run one AS the caller, body {input}
 *   GET  /mcp-tools/config       admin: named tools + extension tools + readiness
 *   PUT  /mcp-tools/config       admin: replace the named tools, body {tools}
 */

/** Built-in tool names a named tool may never take (loaded on first admin save). */
async function builtinNames(): Promise<Set<string>> {
  const m = await import('@nivaro/mcp')
  return new Set<string>([
    ...m.TOOL_NAMES,
    ...m.ADMIN_TOOL_NAMES,
    ...m.LAYOUT_TOOL_NAMES,
    ...m.INFRA_TOOL_NAMES
  ])
}

export async function mcpToolRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: authenticate }, async (req) => {
    const tools = await instanceToolCatalog(mcpCallerAccess(req))
    // #3205 — an MCP connection limited to some tools sees only those.
    const allowed = req.mcpScope?.tools
    return { data: allowed ? tools.filter((t) => allowed.includes(t.name)) : tools }
  })

  app.post<{ Params: { name: string }; Body: { input?: Record<string, unknown> } }>(
    '/:name/call',
    { preHandler: authenticate },
    async (req, reply) => {
      const input = req.body?.input
      if (input != null && (typeof input !== 'object' || Array.isArray(input)))
        return reply.code(400).send({ error: 'input must be an object' })
      try {
        return { data: await callInstanceTool(app, req, req.params.name, input ?? {}) }
      } catch (err) {
        if (err instanceof ExtensionToolError)
          return reply.code(err.statusCode).send({ error: err.message })
        const e = err as { statusCode?: number; message?: string }
        // Refusals from the items service (403/404) keep their status and message.
        if (e.statusCode && e.statusCode < 500)
          return reply.code(e.statusCode).send({ error: e.message ?? 'Refused' })
        req.log.warn({ err, tool: req.params.name }, 'instance tool failed')
        return reply.code(502).send({ error: 'That tool failed' })
      }
    }
  )

  app.get('/config', { preHandler: requireAdmin }, async () => {
    const [ready, tools, extension_tools, builtin] = await Promise.all([
      namedToolsReady(),
      readNamedTools(),
      extensionToolRoster('mcp'),
      builtinNames().catch(() => new Set<string>())
    ])
    return {
      data: {
        ready,
        tools,
        extension_tools: extension_tools.map(({ input_schema: _s, ...t }) => t),
        builtin_names: [...builtin].sort()
      }
    }
  })

  app.put<{ Body: { tools?: unknown } }>(
    '/config',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await namedToolsReady()))
        return reply
          .code(409)
          .send({ error: 'Named tools need database migration 473 — restart after it runs' })
      const reserved = await builtinNames()
      for (const t of await extensionToolRoster('mcp')) reserved.add(t.name)
      const v = validateNamedTools(req.body?.tools, reserved)
      if ('error' in v) return reply.code(400).send({ error: v.error })
      // Every reference must exist now — a tool pointing nowhere is a typo.
      const slugs = v.tools.filter((t) => t.kind === 'custom_query').map((t) => t.ref)
      const flowIds = v.tools.filter((t) => t.kind === 'flow').map((t) => t.ref)
      const [qs, fs] = await Promise.all([
        slugs.length ? db('nivaro_custom_queries').whereIn('slug', slugs).pluck('slug') : [],
        flowIds.length ? db('nivaro_flows').whereIn('id', flowIds).select('id') : []
      ])
      const haveQ = new Set((qs as unknown[]).map(String))
      const haveF = new Set((fs as Array<{ id: string }>).map((f) => String(f.id).toLowerCase()))
      for (const t of v.tools) {
        if (t.kind === 'custom_query' && !haveQ.has(t.ref))
          return reply.code(400).send({ error: `${t.name}: no saved query "${t.ref}"` })
        if (t.kind === 'flow' && !haveF.has(t.ref.toLowerCase()))
          return reply.code(400).send({ error: `${t.name}: that flow no longer exists` })
      }
      await writeNamedTools(v.tools)
      await logActivity({
        action: 'mcp-tools-config',
        user: req.user!.id,
        collection: 'nivaro_settings',
        comment:
          `${v.tools.length} named MCP tool(s): ${v.tools.map((t) => t.name).join(', ')}`.slice(
            0,
            500
          ),
        req
      })
      return { data: { tools: v.tools } }
    }
  )
}
