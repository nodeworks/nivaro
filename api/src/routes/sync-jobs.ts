import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { runSyncJob, type SyncJobRow, type SyncStats } from '../services/sync-engine.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

const DIRECTIONS = new Set(['pull', 'push'])
const CONFLICT_STRATEGIES = new Set(['newest-wins', 'source-wins', 'manual'])

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function toJsonStr(v: unknown): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function serialize(row: SyncJobRow) {
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    external_api: row.external_api,
    collection: row.collection,
    endpoint_path: row.endpoint_path,
    field_mapping: parseJson<Record<string, unknown>>(row.field_mapping),
    conflict_strategy: row.conflict_strategy,
    schedule: row.schedule,
    id_field: row.id_field,
    external_id_field: row.external_id_field,
    is_active: !!row.is_active,
    last_run_at: row.last_run_at,
    last_run_status: row.last_run_status,
    last_run_stats: parseJson<SyncStats>(row.last_run_stats),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

function validateBody(body: Record<string, unknown>, partial: boolean): string | null {
  if (!partial) {
    for (const f of ['name', 'direction', 'external_api', 'collection', 'endpoint_path']) {
      if (body[f] == null || body[f] === '') return `${f} is required`
    }
  }
  if (body.direction !== undefined && !DIRECTIONS.has(String(body.direction))) {
    return 'direction must be "pull" or "push"'
  }
  if (
    body.conflict_strategy !== undefined &&
    !CONFLICT_STRATEGIES.has(String(body.conflict_strategy))
  ) {
    return 'conflict_strategy must be newest-wins, source-wins or manual'
  }
  if (body.collection !== undefined && /^nivaro_/i.test(String(body.collection))) {
    return 'System collections (nivaro_*) cannot be synced'
  }
  return null
}

// ─── Cron wiring ────────────────────────────────────────────────────────────

const cronId = (jobId: number) => `sync-job-${jobId}`

function scheduleJob(app: FastifyInstance, job: Pick<SyncJobRow, 'id' | 'schedule' | 'is_active'>) {
  if (!app.cron) return
  app.cron.unschedule(cronId(job.id))
  if (!job.schedule || !job.is_active) return
  try {
    app.cron.schedule(cronId(job.id), job.schedule, async () => {
      try {
        await runSyncJob(job.id)
      } catch (err) {
        app.log.error({ err, syncJobId: job.id }, 'Scheduled sync job failed')
      }
    })
  } catch (err) {
    app.log.warn({ err, syncJobId: job.id }, 'Invalid cron expression for sync job')
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function syncJobsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // Register schedules for existing active jobs at startup.
  app.addHook('onReady', async () => {
    try {
      const jobs = (await db('nivaro_sync_jobs')
        .whereNotNull('schedule')
        .where({ is_active: true })) as SyncJobRow[]
      for (const job of jobs) scheduleJob(app, job)
      if (jobs.length) app.log.info(`Scheduled ${jobs.length} sync job(s)`)
    } catch (err) {
      app.log.warn({ err }, 'Could not register sync job schedules')
    }
  })

  // List
  app.get('/', async () => {
    const rows = (await db('nivaro_sync_jobs').orderBy('name', 'asc')) as SyncJobRow[]
    return { data: rows.map(serialize) }
  })

  // Single (includes parsed last_run_stats)
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db('nivaro_sync_jobs')
      .where({ id: Number(req.params.id) })
      .first()) as SyncJobRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: serialize(row) }
  })

  // Create
  app.post<{
    Body: {
      name: string
      direction: 'pull' | 'push'
      external_api: number
      collection: string
      endpoint_path: string
      field_mapping?: Record<string, unknown> | null
      conflict_strategy?: string
      schedule?: string | null
      id_field?: string | null
      external_id_field?: string | null
      is_active?: boolean
    }
  }>('/', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const err = validateBody(body, false)
    if (err) return reply.code(400).send({ error: err })

    const now = new Date()
    const [inserted] = await db('nivaro_sync_jobs')
      .insert({
        name: req.body.name,
        direction: req.body.direction,
        external_api: req.body.external_api,
        collection: req.body.collection,
        endpoint_path: req.body.endpoint_path,
        field_mapping: toJsonStr(req.body.field_mapping ?? null),
        conflict_strategy: req.body.conflict_strategy ?? 'newest-wins',
        schedule: req.body.schedule || null,
        id_field: req.body.id_field || null,
        external_id_field: req.body.external_id_field || null,
        is_active: req.body.is_active ?? true,
        created_by: req.user?.id ?? null,
        created_at: now,
        updated_at: now
      })
      .returning('*')

    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as SyncJobRow)
        : ((await db('nivaro_sync_jobs')
            .where({ id: inserted as number })
            .first()) as SyncJobRow)

    scheduleJob(app, row)

    await logActivity({
      action: 'create',
      collection: 'nivaro_sync_jobs',
      item: String(row.id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: serialize(row) })
  })

  // Update
  app.patch<{
    Params: { id: string }
    Body: Partial<{
      name: string
      direction: 'pull' | 'push'
      external_api: number
      collection: string
      endpoint_path: string
      field_mapping: Record<string, unknown> | null
      conflict_strategy: string
      schedule: string | null
      id_field: string | null
      external_id_field: string | null
      is_active: boolean
    }>
  }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_sync_jobs').where({ id }).first()) as SyncJobRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const b = req.body ?? {}
    const err = validateBody(b as Record<string, unknown>, true)
    if (err) return reply.code(400).send({ error: err })

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (b.name !== undefined) patch.name = b.name
    if (b.direction !== undefined) patch.direction = b.direction
    if (b.external_api !== undefined) patch.external_api = b.external_api
    if (b.collection !== undefined) patch.collection = b.collection
    if (b.endpoint_path !== undefined) patch.endpoint_path = b.endpoint_path
    if (b.field_mapping !== undefined) patch.field_mapping = toJsonStr(b.field_mapping)
    if (b.conflict_strategy !== undefined) patch.conflict_strategy = b.conflict_strategy
    if (b.schedule !== undefined) patch.schedule = b.schedule || null
    if (b.id_field !== undefined) patch.id_field = b.id_field || null
    if (b.external_id_field !== undefined) patch.external_id_field = b.external_id_field || null
    if (b.is_active !== undefined) patch.is_active = b.is_active

    await db('nivaro_sync_jobs').where({ id }).update(patch)
    const row = (await db('nivaro_sync_jobs').where({ id }).first()) as SyncJobRow

    scheduleJob(app, row)

    await logActivity({
      action: 'update',
      collection: 'nivaro_sync_jobs',
      item: String(id),
      user: req.user?.id,
      req
    })
    return { data: serialize(row) }
  })

  // Delete
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const deleted = await db('nivaro_sync_jobs').where({ id }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })

    if (app.cron) app.cron.unschedule(cronId(id))

    await logActivity({
      action: 'delete',
      collection: 'nivaro_sync_jobs',
      item: String(id),
      user: req.user?.id,
      req
    })
    return { data: { success: true } }
  })

  // Run now — fire-and-forget
  app.post<{ Params: { id: string } }>('/:id/run', async (req, reply) => {
    const id = Number(req.params.id)
    const row = (await db('nivaro_sync_jobs').where({ id }).first()) as SyncJobRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })

    runSyncJob(id).catch((err) => {
      app.log.error({ err, syncJobId: id }, 'Manual sync job run failed')
    })

    await logActivity({
      action: 'run',
      collection: 'nivaro_sync_jobs',
      item: String(id),
      user: req.user?.id,
      req
    })
    return reply.code(202).send({ data: { started: true } })
  })
}
