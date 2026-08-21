import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { evaluateMonitor, type MonitorRow } from '../services/ops-monitors.js'

/**
 * Ops monitors CRUD + on-demand checks. Admin-only: monitor configs name
 * internal collections/URLs, and failures carry operational detail.
 */

const TYPES = ['freshness', 'deploy_regression', 'synthetic'] as const

function parseJsonSafe<T>(raw: unknown): T | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return null
  }
}

export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const rows = (await db('nivaro_monitors').orderBy('id', 'asc')) as MonitorRow[]
    return {
      data: rows.map((r) => ({
        ...r,
        config: parseJsonSafe(r.config),
        state: undefined // evaluator memory, not API surface
      }))
    }
  })

  /** Recent evaluations for one monitor (latency trend for synthetics). */
  app.get<{ Params: { id: string } }>('/:id/runs', async (req, reply) => {
    const row = (await db('nivaro_monitors').where('id', req.params.id).first()) as MonitorRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const runs = await db('nivaro_job_runs')
      .where('kind', 'monitor')
      .where('job_id', `${row.type}:${row.name}`.slice(0, 200))
      .orderBy('id', 'desc')
      .limit(50)
      .select('id', 'status', 'started_at', 'duration_ms', 'outcome', 'error')
    return { data: runs }
  })

  app.post('/', async (req, reply) => {
    const b = req.body as { type?: string; name?: string; config?: unknown; is_active?: boolean }
    if (!TYPES.includes(b.type as (typeof TYPES)[number])) {
      return reply.code(400).send({ error: `type must be one of ${TYPES.join(', ')}` })
    }
    const name = String(b.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const [inserted] = await db('nivaro_monitors')
      .insert({
        type: b.type,
        name: name.slice(0, 200),
        config: b.config ? JSON.stringify(b.config) : null,
        is_active: b.is_active !== false,
        created_by: req.user?.id ?? null,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({ action: 'monitor-create', user: req.user?.id, item: String(id), comment: `${b.type}: ${name}`, req })
    return reply.code(201).send({ data: { id } })
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_monitors').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 200)
    if (b.config !== undefined) patch.config = b.config ? JSON.stringify(b.config) : null
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    // Config edits reset evaluator memory — a deploy-regression baseline
    // captured under the old thresholds must not judge the new ones.
    if (b.config !== undefined) patch.state = null
    await db('nivaro_monitors').where('id', row.id).update(patch)
    await logActivity({ action: 'monitor-update', user: req.user?.id, item: String(row.id), req })
    return { data: { id: row.id } }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_monitors').where('id', req.params.id).first('id', 'name')
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_monitors').where('id', row.id).del()
    await logActivity({ action: 'monitor-delete', user: req.user?.id, item: String(row.id), comment: String(row.name), req })
    return { data: { deleted: true } }
  })

  /** Evaluate now — the create-form's "test this" and the row's refresh. */
  app.post<{ Params: { id: string } }>('/:id/check', async (req, reply) => {
    const row = (await db('nivaro_monitors').where('id', req.params.id).first()) as MonitorRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const result = await evaluateMonitor(row, app)
    return { data: result }
  })
}
