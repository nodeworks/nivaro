import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { driftTables } from '../services/config-drift/core.js'
import { registerDriftReportSection } from '../services/config-drift/report-section.js'
import {
  buildCopyBundle,
  checkOverwrite,
  driftTrackingHere,
  getDriftReport,
  markItems,
  saveDriftSettings
} from '../services/config-drift/store.js'
import { CONFIG_TABLES, type ConfigSnapshot, redactSnapshot } from '../services/config-inventory.js'

/**
 * Config changed here, not from promotion (services/config-drift). Admin only.
 *
 *  GET  /config-drift                 the list (?fresh=1 skips the one-minute reuse)
 *  POST /config-drift/mark            {ids[], note?, reopen?} — Mark as intended / Reopen
 *  POST /config-drift/bundle          {ids?} — "Copy to dev": a config file dev uploads on
 *                                     Environments → Config diff and applies (never written
 *                                     cross-environment from here)
 *  PUT  /config-drift/settings        {refuse_overwrite?, baseline_snapshot_id?, track_here?}
 *  GET  /config-drift/guard?tables=   what a promotion over these tables would overwrite
 *  POST /config-drift/guard           {tables?, snapshot?} — the same, exact against the rows the
 *                                     promotion would write (a source export)
 *
 * The guard is the promote chain's contract (efp-ops promote-config): it calls it on the TARGET
 * before --execute, prints the lines, and stops when `refuse` is true unless the operator passed
 * --overwrite-prod-changes. After a promotion it stores the new baseline with
 * POST /config-diff/history {trigger: 'promote'}.
 */
const ID_RE = /^nivaro_[a-z0-9_]+:[^\s]{1,200}$/i
const TABLE_RE = /^nivaro_[a-z0-9_]+$/i

function parseIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 2000) return null
  if (!raw.every((v) => typeof v === 'string' && ID_RE.test(v))) return null
  return raw as string[]
}

function parseTables(raw: unknown): string[] | null {
  const list =
    typeof raw === 'string'
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : raw
  if (!Array.isArray(list) || list.length > 500) return null
  if (!list.every((t) => typeof t === 'string' && TABLE_RE.test(t))) return null
  return list as string[]
}

export async function configDriftRoutes(app: FastifyInstance) {
  // The daily report's "Production-only config changes" — only where this instance tracks them.
  if (await driftTrackingHere()) registerDriftReportSection(() => getDriftReport())

  app.get('/config-drift', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { fresh?: string }
    return { data: await getDriftReport({ fresh: q.fresh === '1' }) }
  })

  app.post('/config-drift/mark', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown; note?: unknown; reopen?: unknown }
    const ids = parseIds(body.ids)
    if (!ids?.length) return reply.code(400).send({ error: 'ids must list changes to mark' })
    if (body.note != null && typeof body.note !== 'string') {
      return reply.code(400).send({ error: 'note must be text' })
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : ''
    const reopen = body.reopen === true
    if (!reopen && !note) {
      return reply.code(400).send({ error: 'Say why this change is meant to stay (a short note)' })
    }
    const out = await markItems(ids, {
      note: note || null,
      userId: req.user?.id ?? null,
      reopen,
      req
    })
    return { data: out }
  })

  app.post('/config-drift/bundle', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown }
    const ids = body.ids == null ? null : parseIds(body.ids)
    if (body.ids != null && !ids) return reply.code(400).send({ error: 'ids must be a list' })
    const bundle = await buildCopyBundle(ids)
    const rows = Object.values(bundle.tables).reduce((n, t) => n + Object.keys(t).length, 0)
    await logActivity({
      action: 'config-snapshot-export',
      user: req.user?.id ?? null,
      comment: `Copy to dev: ${rows} row${rows === 1 ? '' : 's'} changed here, not from promotion`,
      req
    })
    return reply
      .header(
        'content-disposition',
        `attachment; filename="nivaro-changed-here-${bundle.instance.database}-${bundle.generated_at.slice(0, 10)}.json"`
      )
      .send({ data: bundle })
  })

  app.put('/config-drift/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const k of ['refuse_overwrite', 'track_here'] as const) {
      if (body[k] === undefined) continue
      if (typeof body[k] !== 'boolean')
        return reply.code(400).send({ error: `${k} must be true or false` })
      patch[k] = body[k]
    }
    if (body.baseline_snapshot_id !== undefined) {
      const v = body.baseline_snapshot_id
      if (v !== null && !(Number.isInteger(v) && (v as number) > 0)) {
        return reply.code(400).send({ error: 'baseline_snapshot_id must be a snapshot id or null' })
      }
      patch.baseline_snapshot_id = v
    }
    const next = await saveDriftSettings(patch)
    if (await driftTrackingHere()) registerDriftReportSection(() => getDriftReport())
    await logActivity({
      action: 'update',
      user: req.user?.id ?? null,
      collection: 'nivaro_settings_overrides',
      item: 'config_drift',
      comment: `Changed here, not from promotion: ${JSON.stringify(patch)}`,
      req
    })
    return { data: next }
  })

  app.get('/config-drift/guard', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { tables?: string }
    const tables = q.tables ? parseTables(q.tables) : null
    if (q.tables && !tables) return reply.code(400).send({ error: 'tables must be nivaro_* names' })
    return { data: await guard(tables, null) }
  })

  app.post(
    '/config-drift/guard',
    { preHandler: requireAdmin, bodyLimit: 128 * 1024 * 1024 },
    async (req, reply) => {
      const body = (req.body ?? {}) as { tables?: unknown; snapshot?: ConfigSnapshot }
      const tables = body.tables == null ? null : parseTables(body.tables)
      if (body.tables != null && !tables) {
        return reply.code(400).send({ error: 'tables must be nivaro_* names' })
      }
      const snap = body.snapshot
      if (snap != null && (typeof snap !== 'object' || snap.format !== 1 || !snap.tables)) {
        return reply.code(400).send({ error: 'snapshot must be a format-1 config snapshot' })
      }
      return { data: await guard(tables, snap ? redactSnapshot(snap) : null) }
    }
  )
}

/** A promotion copies whole tables (delete + insert), so it overwrites like a restore. */
async function guard(tables: string[] | null, source: ConfigSnapshot | null) {
  if (!(await driftTrackingHere())) {
    return { active: false, refuse: false, items: [], lines: [] }
  }
  const scope = tables ?? (source ? Object.keys(source.tables) : driftTables(CONFIG_TABLES))
  return checkOverwrite(source?.tables ?? null, { tables: scope, deletes: true })
}
