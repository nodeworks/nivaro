import type { FastifyInstance } from 'fastify'
import { executeInfraTool, INFRA_TOOL_NAMES, InfraToolError } from '../services/infra-ai-tools.js'
import type { HealthStore } from '../services/infra-swarm/health.js'

/**
 * The compact infrastructure answers Ask AI uses (#2842), served as plain reads so a connected
 * MCP client gets exactly the same figures: GET /api/infrastructure/summary/:tool, where tool is
 * one of the infra_* names. Read-only; the parent plugin's requireAdmin hook covers it, and the
 * output never holds secret values (services/infra-ai-tools.ts).
 */
export async function infrastructureAiRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { tool: string }; Querystring: Record<string, string | undefined> }>(
    '/summary/:tool',
    async (req, reply) => {
      const tool = req.params.tool
      if (!INFRA_TOOL_NAMES.has(tool)) return reply.code(404).send({ error: 'Unknown tool' })
      try {
        const data = await executeInfraTool(
          tool,
          { ...req.query },
          {
            redis: app.redis as unknown as HealthStore
          }
        )
        return { data }
      } catch (err) {
        if (err instanceof InfraToolError) return reply.code(400).send({ error: err.message })
        throw err
      }
    }
  )
}
