import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  buildEvidence,
  EVIDENCE_MAX_ROWS,
  EvidenceTooLargeError
} from '../services/activity-trail/evidence.js'
import { TrailBusyError } from '../services/activity-trail/lock.js'
import { registerTrailReadiness } from '../services/activity-trail/readiness.js'
import { summariseCheckpoint, trailStatus } from '../services/activity-trail/status.js'
import { SEALS, trailReady } from '../services/activity-trail/store.js'
import {
  acknowledgeCheckpoint,
  type CheckpointRow,
  runTrailVerify
} from '../services/activity-trail/verify.js'
import { logRetentionInventory } from '../services/log-retention.js'
import { withReadGate } from '../services/read-gate.js'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * Tamper-evident activity trail (#16) + log retention inventory (#17). All administrator-only.
 *
 *   GET  /api/activity/evidence?from=&to=          zip: entries.csv + manifest.json + summary.html
 *   GET  /api/activity-trail/status                 intact through / first broken entry / backlog
 *   GET  /api/activity-trail/checkpoints            newest verification runs
 *   POST /api/activity-trail/verify {full?}         202 — runs in the background (heavy work)
 *   POST /api/activity-trail/checkpoints/:id/acknowledge {note}   accept a break (re-anchor)
 *   GET  /api/log-retention                         every log, its window, size, next purge
 *
 * Registered once at the /api root (paths spelled out) so /activity/evidence sits beside the
 * activity routes without editing them.
 */
/** Tenants with a manual check running in this process (cloud: one process, many tenants). */
const verifyRunning = new Set<string>()

function parseDate(v: unknown, endOfDay: boolean): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function activityTrailRoutes(app: FastifyInstance): Promise<void> {
  registerTrailReadiness()

  app.get('/activity/evidence', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string }
    const from = parseDate(q.from, false)
    const to = parseDate(q.to, true)
    if (!from || !to)
      return reply.code(400).send({
        error: 'from and to are required (YYYY-MM-DD or an ISO time)',
        code: 'BAD_WINDOW'
      })
    if (to.getTime() < from.getTime())
      return reply.code(400).send({ error: 'to is before from', code: 'BAD_WINDOW' })
    const u = req.user as { id?: string; first_name?: string; last_name?: string; email?: string }
    const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() || u?.email || null
    try {
      // A chain walk + up to 100k rows: an expensive read, so it holds a read-gate slot.
      const out = await withReadGate(
        u?.id,
        () =>
          buildEvidence({
            from,
            to,
            generatedBy: { id: u?.id ?? null, name },
            instance: process.env.PUBLIC_URL ?? null
          }),
        { label: 'activity-evidence' }
      )
      await logActivity({
        action: 'activity-evidence-export',
        user: u?.id,
        collection: 'nivaro_activity',
        comment: `Evidence ${from.toISOString()} – ${to.toISOString()}: ${
          (out.manifest.verification as { status: string }).status
        }, manifest sha256 ${out.manifestSha256}`,
        req
      })
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${out.filename}"`)
        .header('x-evidence-manifest-sha256', out.manifestSha256)
        .header('cache-control', 'no-store')
        .send(out.zip)
    } catch (err) {
      if (err instanceof EvidenceTooLargeError)
        return reply.code(413).send({
          error: err.message,
          code: 'EVIDENCE_TOO_LARGE',
          rows: err.rows,
          max: EVIDENCE_MAX_ROWS
        })
      if (err instanceof TrailBusyError)
        return reply.code(503).send({ error: err.message, code: 'TRAIL_BUSY' })
      throw err
    }
  })

  app.get('/activity-trail/status', { preHandler: requireAdmin }, async () => ({
    data: { ...(await trailStatus()), verify_running: verifyRunning.has(currentTenantKey()) }
  }))

  app.get('/activity-trail/checkpoints', { preHandler: requireAdmin }, async () => {
    if (!(await trailReady())) return { data: [] }
    const rows = (await db(SEALS).orderBy('id', 'desc').limit(60)) as CheckpointRow[]
    return { data: rows.map(summariseCheckpoint) }
  })

  app.post('/activity-trail/verify', { preHandler: requireAdmin }, async (req, reply) => {
    if (!(await trailReady()))
      return reply.code(409).send({ error: 'Migration 518 has not run here', code: 'NOT_MIGRATED' })
    const tenant = currentTenantKey()
    if (verifyRunning.has(tenant))
      return reply.code(409).send({ error: 'A check is already running', code: 'VERIFY_RUNNING' })
    const b = (req.body ?? {}) as { full?: boolean }
    const userId = req.user?.id ?? null
    verifyRunning.add(tenant)
    void runInBackgroundPool(async () => {
      try {
        const r = await runTrailVerify({ kind: b.full ? 'full' : 'manual', userId })
        await logActivity({
          action: 'activity-trail-verify',
          user: userId ?? undefined,
          collection: 'nivaro_activity',
          comment: r.skipped
            ? `Skipped (${r.skipped})`
            : `${b.full ? 'Full check' : 'Check'}: ${r.ok ? 'intact' : 'broken'} — ${r.rows} entries${
                r.partial ? ' (stopped on its time budget)' : ''
              }`
        })
      } catch (err) {
        req.log.warn({ err }, '[activity-trail] verify failed')
      } finally {
        verifyRunning.delete(tenant)
      }
    })
    return reply.code(202).send({ data: { started: true, full: !!b.full } })
  })

  app.post<{ Params: { id: string } }>(
    '/activity-trail/checkpoints/:id/acknowledge',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const note = String((req.body as { note?: string } | undefined)?.note ?? '').trim()
      if (!note)
        return reply.code(400).send({
          error: 'Say what you found — acknowledgements are audited',
          code: 'NOTE_REQUIRED'
        })
      const id = Number(req.params.id)
      if (!Number.isSafeInteger(id)) return reply.code(404).send({ error: 'Not found' })
      const row = await acknowledgeCheckpoint(id, req.user?.id ?? null, note)
      if (!row)
        return reply
          .code(404)
          .send({ error: 'No unacknowledged failed check with that id', code: 'NOT_FOUND' })
      await logActivity({
        action: 'activity-trail-acknowledge',
        user: req.user?.id,
        collection: 'nivaro_activity_seals',
        item: String(id),
        comment: note.slice(0, 300),
        req
      })
      return { data: summariseCheckpoint(row) }
    }
  )

  app.get('/log-retention', { preHandler: requireAdmin }, async () => ({
    data: await logRetentionInventory()
  }))
}
