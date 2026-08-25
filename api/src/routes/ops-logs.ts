import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { config } from '../config.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { bustLogRules, readLog } from '../services/log-ring.js'
import { swallowStats } from '../services/swallow-counter.js'

/**
 * Ops batch B — logs & errors: #156 log viewer (per-replica pino ring),
 * #253 log alert rules, #157 env config viewer (masked), #296 swallowed-error
 * counters, #288 incident timeline.
 */

const SECRET_ENV = /secret|token|pass|key|credential|signing/i

/** Mask by key name, and ALSO by value shape: connection-string URLs embed
 *  credentials under innocent key names (CLOUD_META_DB_URL, REDIS_URL). */
function maskEnvValue(key: string, value: string): string {
  if (SECRET_ENV.test(key)) return '••••••'
  if (/:\/\/[^/\s]*:[^/\s]*@/.test(value)) {
    return value.replace(/(:\/\/[^/\s:]*):[^@\s]*@/, '$1:••••••@').slice(0, 200)
  }
  return value.slice(0, 200)
}

export async function opsLogsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // #156 — tail the in-process log ring (per replica; pino lines only —
  // console.* from crons goes to stdout, not the ring).
  app.get<{ Querystring: { level?: string; q?: string; limit?: string } }>(
    '/tail',
    async (req, reply) => {
      const levelMap: Record<string, number> = { debug: 20, info: 30, warn: 40, error: 50 }
      return reply.send({
        data: readLog({
          level: levelMap[String(req.query.level ?? '')] ?? undefined,
          q: req.query.q || undefined,
          limit: Math.min(1000, Number(req.query.limit) || 300)
        })
      })
    }
  )

  // #296 — where errors are being deliberately swallowed, and how often.
  app.get('/swallows', async (_req, reply) => {
    return reply.send({ data: swallowStats() })
  })

  // #157 — which env knobs are set, with secret values masked. Names come
  // from the validated config object plus the documented raw-env knobs.
  app.get('/env', async (_req, reply) => {
    const rows: Array<{ key: string; value: string | null; set: boolean }> = []
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      const set = value !== undefined && value !== null && value !== ''
      rows.push({ key, set, value: !set ? null : maskEnvValue(key, String(value)) })
    }
    for (const key of [
      'NIVARO_INSTANCE',
      'NIVARO_SETTINGS_OVERRIDES',
      'NIVARO_EXPECTED_DB',
      'MAIL_TEST_MODE',
      'MAIL_TEST_RECIPIENT',
      'SMS_TEST_MODE',
      'EFP_OPS_TAKEOVER',
      'EFP_NUVOLO_USER',
      'REQUIRED_EXTENSIONS',
      'MIGRATION_SAFE_MODE',
      'RUNTIME_RSS_WARN_MB',
      'IMPORT_STATEMENT_TIMEOUT_MS'
    ]) {
      if (rows.some((r) => r.key === key)) continue
      const v = process.env[key]
      rows.push({
        key,
        set: v !== undefined && v !== '',
        value: v === undefined || v === '' ? null : maskEnvValue(key, v)
      })
    }
    rows.sort((a, b) => a.key.localeCompare(b.key))
    return reply.send({ data: rows })
  })

  // #253 — log alert rules CRUD.
  app.get('/rules', async (_req, reply) => {
    const rows = await db('nivaro_log_alert_rules').orderBy('id', 'desc').catch(() => [])
    return reply.send({ data: rows })
  })
  app.post<{ Body: { name?: string; pattern?: string; level?: string | null } }>(
    '/rules',
    async (req, reply) => {
      const name = String(req.body?.name ?? '').trim()
      const pattern = String(req.body?.pattern ?? '').trim()
      if (!name || !pattern) return reply.code(400).send({ error: 'name and pattern are required' })
      try {
        new RegExp(pattern)
      } catch {
        return reply.code(400).send({ error: 'pattern is not a valid regular expression' })
      }
      await db('nivaro_log_alert_rules').insert({
        name: name.slice(0, 200),
        pattern: pattern.slice(0, 500),
        level: req.body?.level || null,
        is_active: true,
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      bustLogRules()
      await logActivity({ action: 'log-alert-rule-create', user: req.user?.id, comment: name, req })
      const row = await db('nivaro_log_alert_rules').orderBy('id', 'desc').first()
      return reply.code(201).send({ data: row })
    }
  )
  app.patch<{ Params: { id: string }; Body: { is_active?: boolean } }>(
    '/rules/:id',
    async (req, reply) => {
      const n = await db('nivaro_log_alert_rules')
        .where({ id: Number(req.params.id) })
        .update({ is_active: req.body?.is_active === true })
      if (!n) return reply.code(404).send({ error: 'Rule not found' })
      bustLogRules()
      return reply.send({ data: { ok: true } })
    }
  )
  app.delete<{ Params: { id: string } }>('/rules/:id', async (req, reply) => {
    const n = await db('nivaro_log_alert_rules').where({ id: Number(req.params.id) }).del()
    if (!n) return reply.code(404).send({ error: 'Rule not found' })
    bustLogRules()
    return reply.code(204).send()
  })

  // #308 — repro generator: an issue whose #300 context capture ran exports a
  // ready-to-run curl script — shaped payload with typed placeholders, aimed
  // at dev, caller supplies the token.
  app.get<{ Params: { id: string } }>('/repro/:id', async (req, reply) => {
    const issue = (await db('nivaro_issues').where({ id: Number(req.params.id) }).first()) as
      | { title: string; details: string | null }
      | undefined
    if (!issue) return reply.code(404).send({ error: 'Issue not found' })
    const m = issue.details?.match(/Request context: (\{.*\})/)
    if (!m) {
      return reply.code(422).send({
        error:
          'No captured request context on this issue — context is sampled onto every 5th occurrence; wait for the next one.'
      })
    }
    let ctx: { url?: string; body_shape?: unknown } = {}
    try {
      ctx = JSON.parse(m[1])
    } catch {
      return reply.code(422).send({ error: 'Stored context is unreadable' })
    }
    const fill = (v: unknown): unknown => {
      if (v === null) return null
      if (Array.isArray(v)) return v.map(fill)
      if (typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, fill(val)])
        )
      }
      if (v === 'string') return '<string>'
      if (v === 'number') return 0
      if (v === 'boolean') return false
      return v
    }
    const method = issue.title.match(/\] (GET|POST|PUT|PATCH|DELETE) /)?.[1] ?? 'GET'
    // The stored URL came from the FAILING REQUEST — attacker-influenced.
    // Interpolated into a shell script an admin will run, so strip anything
    // shell-active; a mangled path beats an executed one.
    const url = String(ctx.url ?? '/api/').replace(/[^A-Za-z0-9/_.?&=%:-]/g, '')
    const body = ctx.body_shape != null ? JSON.stringify(fill(ctx.body_shape), null, 2) : null
    const script = [
      '#!/bin/bash',
      `# Repro for issue #${req.params.id}: ${issue.title.replace(/[\r\n]+/g, ' ')}`,
      '# Target dev; set TOKEN to an appropriate bearer token first.',
      'TOKEN=${TOKEN:?set TOKEN}',
      `curl -s -X ${method} "http://localhost:3055${url}" \\`,
      '  -H "Authorization: Bearer $TOKEN" \\',
      ...(body ? ['  -H "Content-Type: application/json" \\', `  -d '${body.replace(/'/g, "'\\''").replace(/\\(?!n)/g, '')}'`] : []),
      ''
    ].join('\n')
    reply.header('Content-Type', 'text/plain')
    return reply.send(script)
  })

  // #288 — incident timeline: everything that happened around a moment, from
  // sources we already record. `around` ISO datetime, `window` minutes.
  app.get<{ Querystring: { around?: string; window?: string } }>(
    '/incident-timeline',
    async (req, reply) => {
      const around = req.query.around ? new Date(req.query.around) : new Date()
      if (Number.isNaN(around.getTime())) {
        return reply.code(400).send({ error: 'around must be a valid datetime' })
      }
      const win = Math.min(360, Number(req.query.window) || 60) * 60_000
      const from = new Date(around.getTime() - win)
      const to = new Date(around.getTime() + win)
      const events: Array<{ at: string; kind: string; label: string }> = []

      const [issues, jobs, configWrites] = await Promise.all([
        db('nivaro_issues')
          .whereBetween('last_seen_at', [from, to])
          .orderBy('last_seen_at', 'desc')
          .limit(50)
          .select('title', 'severity', 'last_seen_at', 'occurrence_count')
          .catch(() => [] as Array<Record<string, unknown>>),
        db('nivaro_job_runs')
          .whereBetween('started_at', [from, to])
          .whereIn('status', ['error', 'interrupted'])
          .orderBy('started_at', 'desc')
          .limit(50)
          .select('job_id', 'status', 'started_at')
          .catch(() => [] as Array<Record<string, unknown>>),
        db('nivaro_activity')
          .whereBetween('timestamp', [from, to])
          .where('collection', 'like', 'nivaro\\_%')
          .whereNotIn('action', ['read', 'login'])
          .orderBy('timestamp', 'desc')
          .limit(80)
          .select('action', 'collection', 'item', 'timestamp', 'user')
          .catch(() => [] as Array<Record<string, unknown>>)
      ])
      for (const i of issues) {
        events.push({
          at: new Date(i.last_seen_at as Date).toISOString(),
          kind: `issue:${i.severity}`,
          label: `${i.title}${Number(i.occurrence_count) > 1 ? ` (×${i.occurrence_count})` : ''}`
        })
      }
      for (const j of jobs) {
        events.push({
          at: new Date(j.started_at as Date).toISOString(),
          kind: `job:${j.status}`,
          label: `Job ${j.job_id} ${j.status}`
        })
      }
      for (const a of configWrites) {
        events.push({
          at: new Date(a.timestamp as Date).toISOString(),
          kind: 'config',
          label: `${a.action} on ${a.collection}${a.item ? ` #${a.item}` : ''}`
        })
      }
      events.sort((a, b) => b.at.localeCompare(a.at))
      return reply.send({ data: { around: around.toISOString(), window_minutes: win / 60_000, events } })
    }
  )
}
