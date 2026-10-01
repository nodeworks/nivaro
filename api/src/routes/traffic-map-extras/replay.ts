// api/src/routes/traffic-map-extras/replay.ts
import type { FastifyInstance } from 'fastify'
import { replayableQuery, replayRows } from '../../services/traffic-replay.js'

/**
 * #1159 — load replay preview (development only; 404 anywhere else). What `traffic:replay` would
 * send for one caller, and the command to run it. Nothing is replayed from here: the script runs
 * outside the API, against a throwaway target.
 */
const HOURS = new Set([1, 6, 24])

export async function replayRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { caller?: string; hours?: string } }>(
    '/replay/preview',
    async (req, reply) => {
      if (process.env.NODE_ENV !== 'development')
        return reply.code(404).send({ error: 'Not found' })
      const caller = String(req.query.caller ?? '')
      const hours = Number(req.query.hours ?? 1)
      if (!/^(k\d{1,9}|u[0-9A-Fa-f-]{36})$/.test(caller) || !HOURS.has(hours)) {
        return reply.code(400).send({
          error: 'caller (k<id> or u<uuid>) and hours 1, 6 or 24',
          code: 'REPLAY_PARAMS_INVALID'
        })
      }
      const rows = await replayRows(caller, hours, 2000)
      const routes = new Map<string, number>()
      for (const r of rows) routes.set(r.path, (routes.get(r.path) ?? 0) + 1)
      return {
        data: {
          caller,
          hours,
          gets: rows.length,
          capped: rows.length >= 2000,
          dropped_queries: rows.filter((r) => r.query && !replayableQuery(r.query)).length,
          top_paths: [...routes]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([path, n]) => ({ path, n })),
          command: `pnpm --filter @nivaro/api run traffic:replay -- --caller ${caller} --hours ${hours} --sample 200 --multiplier 1 --target http://localhost:<throwaway port> --token <token valid there>`
        }
      }
    }
  )
}
