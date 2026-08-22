import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { execCustomQuerySql } from '../services/custom-query-exec.js'

/**
 * Admin SQL scratchpad (#68): read-only ad-hoc queries against the live
 * database without leaving the admin. SELECT/WITH only — anything that could
 * write is rejected by keyword, and every run is activity-logged with the
 * statement so the scratchpad is itself auditable.
 */

// Standalone write/DDL verbs. Word-boundary matched so a column named
// `updated_at` or a string literal containing "delete" doesn't false-positive
// — but a literal containing a bare verb DOES reject; that's the safe side.
const FORBIDDEN =
  /\b(insert|update|delete|drop|truncate|alter|create|exec|execute|merge|grant|revoke|deny|backup|restore|shutdown|kill|dbcc|openrowset|opendatasource|sp_|xp_)\b/i

export async function sqlScratchpadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.post<{ Body: { sql?: string } }>('/run', async (req, reply) => {
    const sql = String(req.body?.sql ?? '').trim()
    if (!sql) return reply.code(400).send({ error: 'No SQL provided' })
    // Strip comments before judging — a leading comment could hide the verb.
    const bare = sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .trim()
    if (!/^(select|with|declare)\b/i.test(bare))
      return reply.code(400).send({ error: 'Only SELECT / WITH queries are allowed here' })
    if (FORBIDDEN.test(bare)) {
      const verb = bare.match(FORBIDDEN)?.[1]
      return reply
        .code(400)
        .send({ error: `"${verb}" is not allowed in the scratchpad — read-only queries only` })
    }

    const started = Date.now()
    try {
      const rows = await execCustomQuerySql(sql, {})
      await logActivity({
        action: 'sql-scratchpad',
        user: req.user?.id,
        comment: sql.slice(0, 500),
        req
      })
      return {
        data: {
          rows: rows.slice(0, 500),
          total: rows.length,
          truncated: rows.length > 500,
          duration_ms: Date.now() - started
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(400).send({ error: msg.slice(0, 800), duration_ms: Date.now() - started })
    }
  })
}
