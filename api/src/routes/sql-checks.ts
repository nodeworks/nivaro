import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { CHECK_KEYS, SEVERITIES } from '../services/sql-checks/checkers.js'
import {
  EVENTS,
  FINDINGS,
  FIXES,
  isSqlChecksRunning,
  RUNS,
  runSqlChecks,
  runSummary,
  SqlChecksBusyError,
  sqlChecksInFlight
} from '../services/sql-checks/run.js'
import {
  bustSqlCheckSettings,
  nightlyEnabled,
  readSqlCheckSettings,
  readStoredSqlCheckSettings,
  sqlChecksEnvOverride,
  validateSqlCheckSettings
} from '../services/sql-checks/settings.js'
import { lintConfig } from '../services/sql-checks/sqlfluff.js'

/**
 * SQL checks (#2562) — admin only. Findings are produced by runs (nightly cron `sql-checks`, or
 * POST /run); people only accept / reopen them. Fixes are logged by Nivaro (a changed procedure
 * that resolved findings) and by outside fix scripts through POST /fixes.
 */

const STATUSES = ['open', 'resolved', 'accepted'] as const
const ACTIONS = ['cleanup', 'proc_fix', 'guard_index', 'other'] as const

const parseJson = (v: unknown) => {
  if (typeof v !== 'string') return v ?? null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function page(q: { page?: string; limit?: string }, max = 200) {
  const limit = Math.min(max, Math.max(1, Number(q.limit) || 50))
  const pageNo = Math.max(1, Number(q.page) || 1)
  return { limit, offset: (pageNo - 1) * limit, page: pageNo }
}

function findingOut(r: Record<string, unknown>) {
  return { ...r, detail: parseJson(r.detail) }
}

export async function sqlChecksRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/summary', async () => {
    const settings = await readSqlCheckSettings()
    const ready = await db.schema.hasTable(FINDINGS)
    if (!ready) return { data: { ready: false, settings } }
    const [bySev, byCheck, topObjects, lastRun, trend, fixes30] = await Promise.all([
      db(FINDINGS).select('status', 'severity').count({ n: '*' }).groupBy('status', 'severity'),
      db(FINDINGS)
        .where('status', 'open')
        .select('check_key')
        .count({ n: '*' })
        .groupBy('check_key'),
      db(FINDINGS)
        .where('status', 'open')
        .select('object_type', 'object_schema', 'object_name', 'object_ref')
        .count({ n: '*' })
        .groupBy('object_type', 'object_schema', 'object_name', 'object_ref')
        .orderBy('n', 'desc')
        .limit(10),
      db(RUNS).orderBy('id', 'desc').first(),
      db(RUNS)
        .whereIn('status', ['ok'])
        .orderBy('id', 'desc')
        .limit(30)
        .select(
          'id',
          'started_at',
          'critical_open',
          'warning_open',
          'info_open',
          'findings_new',
          'findings_resolved'
        ),
      db(FIXES)
        .where('created_at', '>', new Date(Date.now() - 30 * 86_400_000))
        .count({ n: '*' })
        .first()
    ])
    const counts: Record<string, Record<string, number>> = {}
    for (const r of bySev as Array<{ status: string; severity: string; n: number | string }>) {
      counts[r.status] ??= {}
      counts[r.status][r.severity] = Number(r.n)
    }
    const env = sqlChecksEnvOverride()
    return {
      data: {
        ready: true,
        settings,
        nightly: { enabled: nightlyEnabled(settings), forced_by_env: env },
        sqlfluff_configured: !!lintConfig(),
        counts,
        by_check: Object.fromEntries(
          (byCheck as Array<{ check_key: string; n: number | string }>).map((r) => [
            r.check_key,
            Number(r.n)
          ])
        ),
        top_objects: (topObjects as Array<Record<string, unknown>>).map((r) => ({
          ...r,
          n: Number(r.n)
        })),
        last_run: lastRun ? { ...lastRun, stats: parseJson(lastRun.stats) } : null,
        trend: (trend as Array<Record<string, unknown>>).reverse(),
        fixes_30d: Number((fixes30 as { n?: number | string } | undefined)?.n ?? 0),
        is_running: isSqlChecksRunning() || (await sqlChecksInFlight())
      }
    }
  })

  app.post('/run', async (req, reply) => {
    if (isSqlChecksRunning() || (await sqlChecksInFlight()))
      return reply
        .code(409)
        .send({ error: 'A SQL checks run is already in progress', code: 'SQL_CHECKS_RUNNING' })
    const userId = req.user?.id ?? null
    let started: (id: number) => void = () => {}
    const startedId = new Promise<number>((resolve) => {
      started = resolve
    })
    const run = runSqlChecks({ trigger: 'manual', userId, onStarted: (id) => started(id) })
    run
      .then((r) => app.log.info(`sql-checks (manual): ${runSummary(r)}`))
      .catch((err) => {
        if (!(err instanceof SqlChecksBusyError)) app.log.error({ err }, 'sql-checks run failed')
      })
    // answer once the run row exists (or the run refused / finished without one)
    const first = await Promise.race([
      startedId.then((id) => ({ id })),
      run.then((r) => ({ report: r })).catch((err) => ({ err }))
    ])
    if ('err' in first) {
      if (first.err instanceof SqlChecksBusyError)
        return reply.code(409).send({ error: first.err.message, code: 'SQL_CHECKS_RUNNING' })
      throw first.err
    }
    if ('report' in first && first.report.status === 'skipped')
      return reply.code(409).send({ error: first.report.skipped, code: 'SQL_CHECKS_UNSUPPORTED' })
    await logActivity({
      action: 'sql-checks-run',
      user: userId ?? undefined,
      collection: RUNS,
      item: 'id' in first ? String(first.id) : undefined,
      comment: 'SQL checks run started',
      req
    })
    return reply
      .code(202)
      .send({ data: { started: true, run_id: 'id' in first ? first.id : null } })
  })

  app.get<{ Querystring: { page?: string; limit?: string } }>('/runs', async (req) => {
    const p = page(req.query, 100)
    const [rows, total] = await Promise.all([
      db(RUNS).orderBy('id', 'desc').limit(p.limit).offset(p.offset),
      db(RUNS).count({ n: '*' }).first()
    ])
    return {
      data: (rows as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        stats: parseJson(r.stats)
      })),
      meta: {
        total: Number((total as { n?: number | string })?.n ?? 0),
        page: p.page,
        limit: p.limit
      }
    }
  })

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Bad id' })
    const row = await db(RUNS).where('id', id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const events = (await db(EVENTS)
      .where('run_id', id)
      .select('event')
      .count({ n: '*' })
      .groupBy('event')) as Array<{ event: string; n: number | string }>
    return {
      data: {
        ...row,
        stats: parseJson(row.stats),
        events: Object.fromEntries(events.map((e) => [e.event, Number(e.n)]))
      }
    }
  })

  app.get<{
    Querystring: {
      status?: string
      severity?: string
      check?: string
      object?: string
      q?: string
      page?: string
      limit?: string
    }
  }>('/findings', async (req, reply) => {
    const q = req.query
    const p = page(q)
    const status = (q.status ?? 'open').split(',').filter(Boolean)
    if (status.some((s) => s !== 'all' && !(STATUSES as readonly string[]).includes(s)))
      return reply.code(400).send({ error: 'status must be open, resolved, accepted or all' })
    const severity = (q.severity ?? '').split(',').filter(Boolean)
    if (severity.some((s) => !(SEVERITIES as readonly string[]).includes(s)))
      return reply.code(400).send({ error: 'severity must be critical, warning or info' })
    const check = (q.check ?? '').split(',').filter(Boolean)
    if (check.some((c) => !(CHECK_KEYS as readonly string[]).includes(c)))
      return reply.code(400).send({ error: 'unknown check' })
    const base = () => {
      const b = db(FINDINGS)
      if (!status.includes('all')) b.whereIn('status', status)
      if (severity.length) b.whereIn('severity', severity)
      if (check.length) b.whereIn('check_key', check)
      if (q.object?.trim()) b.where('object_name', q.object.trim())
      if (q.q?.trim()) {
        const like = `%${q.q.trim().replace(/[%_[]/g, '[$&]')}%`
        b.where((w) => w.where('message', 'like', like).orWhere('object_name', 'like', like))
      }
      return b
    }
    const [rows, total] = await Promise.all([
      base()
        .orderByRaw("CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END")
        .orderBy('object_name')
        .orderBy('line')
        .limit(p.limit)
        .offset(p.offset)
        .select(
          'id',
          'check_key',
          'severity',
          'status',
          'object_schema',
          'object_name',
          'object_type',
          'object_ref',
          'line',
          'message',
          'first_seen_at',
          'first_seen_run',
          'last_seen_run',
          'seen_count',
          'resolved_at'
        ),
      base().count({ n: '*' }).first()
    ])
    return {
      data: rows,
      meta: {
        total: Number((total as { n?: number | string })?.n ?? 0),
        page: p.page,
        limit: p.limit
      }
    }
  })

  app.get<{ Params: { id: string } }>('/findings/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Bad id' })
    const row = await db(FINDINGS).where('id', id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const events = await db(EVENTS)
      .where('finding_id', id)
      .orderBy('at', 'asc')
      .orderBy('id', 'asc')
    return { data: { ...findingOut(row), events } }
  })

  app.patch<{ Params: { id: string }; Body: { status?: string; note?: string } | null }>(
    '/findings/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Bad id' })
      const row = (await db(FINDINGS).where('id', id).first()) as
        | { status: string; message: string }
        | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const status = req.body?.status
      const note = String(req.body?.note ?? '')
        .trim()
        .slice(0, 500)
      const userId = req.user?.id ?? null
      if (status === 'accepted') {
        if (row.status === 'resolved')
          return reply.code(409).send({ error: 'A resolved finding cannot be marked as expected' })
        if (!note)
          return reply.code(400).send({ error: 'Say why this is expected (a note is required)' })
        await db(FINDINGS).where('id', id).update({
          status: 'accepted',
          accepted_by: userId,
          accepted_at: new Date(),
          accepted_note: note
        })
        await db(EVENTS).insert({
          finding_id: id,
          event: 'accepted',
          at: new Date(),
          by: userId,
          note
        })
      } else if (status === 'open') {
        if (row.status !== 'accepted')
          return reply
            .code(409)
            .send({ error: 'Only a finding marked as expected can be reopened' })
        await db(FINDINGS)
          .where('id', id)
          .update({ status: 'open', accepted_by: null, accepted_at: null, accepted_note: null })
        await db(EVENTS).insert({
          finding_id: id,
          event: 'unaccepted',
          at: new Date(),
          by: userId,
          note: note || null
        })
      } else return reply.code(400).send({ error: 'status must be accepted or open' })
      await logActivity({
        action: status === 'accepted' ? 'sql-check-accept' : 'sql-check-reopen',
        user: userId ?? undefined,
        collection: FINDINGS,
        item: String(id),
        comment: `${row.message}${note ? ` — ${note}` : ''}`.slice(0, 1000),
        req
      })
      const out = await db(FINDINGS).where('id', id).first()
      return { data: findingOut(out) }
    }
  )

  app.get<{ Querystring: { page?: string; limit?: string } }>('/fixes', async (req) => {
    const p = page(req.query, 100)
    const [rows, total] = await Promise.all([
      db(FIXES).orderBy('id', 'desc').limit(p.limit).offset(p.offset),
      db(FIXES).count({ n: '*' }).first()
    ])
    return {
      data: (rows as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        detail: parseJson(r.detail)
      })),
      meta: {
        total: Number((total as { n?: number | string })?.n ?? 0),
        page: p.page,
        limit: p.limit
      }
    }
  })

  /** For fix scripts that cannot write the table themselves. Admin (or an admin's API key). */
  app.post<{ Body: Record<string, unknown> | null }>('/fixes', async (req, reply) => {
    const b = req.body ?? {}
    const str = (k: string, max: number) => {
      const v = b[k]
      if (v == null || v === '') return null
      if (typeof v !== 'string') throw new Error(`${k} must be text`)
      return v.slice(0, max)
    }
    try {
      const action = String(b.action ?? '')
      if (!(ACTIONS as readonly string[]).includes(action))
        throw new Error('action must be cleanup, proc_fix, guard_index or other')
      const rows = b.rows_affected == null ? null : Number(b.rows_affected)
      if (rows != null && (!Number.isInteger(rows) || rows < 0))
        throw new Error('rows_affected must be a whole number')
      const checkKey = str('check_key', 40)
      if (checkKey && !(CHECK_KEYS as readonly string[]).includes(checkKey))
        throw new Error('unknown check_key')
      const detail = b.detail == null ? null : JSON.stringify(b.detail).slice(0, 100_000)
      const row = {
        check_key: checkKey,
        target_table: str('target_table', 256),
        target_object: str('target_object', 256),
        action,
        rows_affected: rows,
        backup_table: str('backup_table', 256),
        detail,
        run_by: (str('run_by', 150) ?? req.user?.email ?? 'api').slice(0, 200),
        created_at: new Date()
      }
      const [r] = await db(FIXES).insert(row).returning('id')
      const id = Number(typeof r === 'object' && r ? (r as { id: unknown }).id : r)
      await logActivity({
        action: 'sql-check-fix',
        user: req.user?.id,
        collection: FIXES,
        item: String(id),
        comment:
          `${action} ${row.target_table ?? row.target_object ?? ''} (${rows ?? '?'} rows)`.slice(
            0,
            500
          ),
        req
      })
      return reply.code(201).send({ data: { id, ...row } })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid fix' })
    }
  })

  app.get('/settings', async () => {
    const settings = await readSqlCheckSettings()
    return {
      data: {
        ...settings,
        nightly: { enabled: nightlyEnabled(settings), forced_by_env: sqlChecksEnvOverride() }
      }
    }
  })

  app.patch<{ Body: Record<string, unknown> | null }>('/settings', async (req, reply) => {
    const body = req.body ?? {}
    const problems: string[] = []
    for (const [k, v] of Object.entries(body)) {
      try {
        validateSqlCheckSettings({ [k]: v })
      } catch (err) {
        problems.push(err instanceof Error ? err.message : `${k} is invalid`)
      }
    }
    if (problems.length) return reply.code(400).send({ error: problems.join('; '), problems })
    const next = validateSqlCheckSettings({ ...(await readStoredSqlCheckSettings()), ...body })
    await db('nivaro_settings')
      .where('id', 1)
      .update({ sql_checks: JSON.stringify(next) })
    bustSqlCheckSettings()
    await logActivity({
      action: 'sql-checks-settings',
      user: req.user?.id,
      collection: 'nivaro_settings',
      item: '1',
      comment: `sql_checks: ${JSON.stringify(next)}`.slice(0, 500),
      req
    })
    return { data: next }
  })
}
