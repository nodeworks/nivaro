import type { ExtensionRunbookDecl, QualityValue } from '@nivaro/extension-kit'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { extensionQualityRerun, extensionRunbooks } from '../extensions/loader.js'
import { csvCell } from '../lib/csv-cell.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { type DiffRow, type KnownMatch, parseKnownMatch } from '../services/quality/diff.js'
import { getRun, latestRunForTarget, loadDiff, rediffRun } from '../services/quality/store.js'
import { hostRunRefusal } from '../services/runbook-admission.js'
import { hostQueueAvailable, listHostRuns, QUEUE, queueHostRun } from '../services/runbook-queue.js'
import { type RunbookSummary, runbookArgv, validateTarget } from '../services/runbook-runs.js'

/**
 * /api/quality-checks — the staging quality checks console: runs, per-check
 * results and their mismatching rows, known differences (a mismatch marked
 * as expected reads amber), and re-running the checks through the host
 * runbook queue. Every read and write is the APP database; the database being
 * checked is never touched here — a re-diff works from the stored rows.
 */

const RUNS = 'nivaro_quality_runs'
const RESULTS = 'nivaro_quality_results'
const KNOWN = 'nivaro_quality_known'

const RUN_ID = /^[0-9a-f-]{36}$/i // SQL Server hands uuids back upper-case
const CHECK_ID = /^[a-z][a-z0-9_.-]{1,80}$/
const NOT_SET_UP = 'Not set up on this database (migration 404)'
const AREA_ORDER = [
  'owners',
  'states',
  'forecasts',
  'lines',
  'po',
  'people',
  'history',
  'counts',
  'budget'
]
const RUN_COLUMNS = [
  'id',
  'target',
  'status',
  'started_at',
  'captured_at',
  'verified_at',
  'verify_started_at',
  'totals',
  'runbook_run',
  'error'
]
const SUMMARY_COLUMNS = [
  'check_id',
  'area',
  'label',
  'description',
  'status',
  'compared',
  'matched',
  'amber_count',
  'red_count',
  'baseline_only',
  'current_only',
  'duration_ms',
  'error'
]

function parseJson<T>(text: unknown): T | null {
  if (typeof text !== 'string' || text === '') return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

const formatRun = (r: Record<string, unknown>) => ({ ...r, totals: parseJson(r.totals) })

const areaRank = (a: unknown) => {
  const i = AREA_ORDER.indexOf(String(a))
  return i < 0 ? AREA_ORDER.length : i
}

type Match = KnownMatch

let tablesKnown = false
let missedAt = 0

/**
 * Does this database have the quality tables (migration 404)? A hit is kept
 * for good; a miss is asked again after a minute.
 */
async function qualityTablesAvailable(): Promise<boolean> {
  if (tablesKnown) return true
  if (missedAt && Date.now() - missedAt < 60_000) return false
  try {
    tablesKnown = await db.schema.hasTable(RUNS)
  } catch {
    tablesKnown = false
  }
  if (!tablesKnown) missedAt = Date.now()
  return tablesKnown
}

/** Tests only: forget the probe. */
export function resetQualityTablesProbe(): void {
  tablesKnown = false
  missedAt = 0
}

type DeclaredRerun =
  | { ok: true; extension: string; decl: ExtensionRunbookDecl }
  | { ok: false; status: number; error: string }

/**
 * The runbook an extension declared (`quality_rerun`) to re-run its checks.
 * Only a host runbook that declares skip_dry_gate qualifies: this console
 * queues it without a dry run and without typed confirmation.
 */
function declaredRerun(): DeclaredRerun {
  const [first] = [...extensionQualityRerun].sort(([a], [b]) => a.localeCompare(b))
  if (!first) return { ok: false, status: 404, error: 'No quality re-run runbook is declared' }
  const [extension, key] = first
  const decl = (extensionRunbooks.get(extension) ?? []).find((d) => d.key === key)
  if (decl?.runs_on !== 'host' || decl.skip_dry_gate !== true)
    return {
      ok: false,
      status: 400,
      error: 'The declared re-run runbook must run on the host and declare skip_dry_gate'
    }
  return { ok: true, extension, decl }
}

function parseReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const reason = raw.trim()
  return reason.length >= 3 && reason.length <= 1000 ? reason : null
}

/**
 * The latest finished run of every target that has a result for the check,
 * re-diffed — that check only; every check when the entry names none. true
 * only when at least one run was re-diffed and none stopped (a run being
 * verified picks the change up from its own known differences).
 */
async function rediffLatestFor(checkId: string | null): Promise<boolean> {
  const runs = [
    ...new Set(
      (await (checkId
        ? db(RESULTS).where({ check_id: checkId }).pluck('run')
        : db(RESULTS).pluck('run'))) as string[]
    )
  ]
  if (runs.length === 0) return false
  const targets = [...new Set((await db(RUNS).whereIn('id', runs).pluck('target')) as string[])]
  let any = false
  let all = true
  for (const target of targets) {
    const latest = await latestRunForTarget(db, target, 'done')
    if (!latest) continue
    const r = await rediffRun(db, latest.id, checkId ? { checkIds: [checkId] } : {})
    any = true
    if (!r.rediffed) all = false
  }
  return any && all
}

const show = (v: QualityValue | undefined) => (v === null || v === undefined ? '—' : String(v))

/** `field: value` pairs — the differing fields of a mismatch, every value otherwise. */
function sideText(values: Record<string, QualityValue> | null, fields: string[]): string {
  if (!values) return ''
  const names = fields.length ? fields : Object.keys(values)
  return names.map((f) => `${f}: ${show(values[f])}`).join('; ')
}

function csvLine(r: DiffRow): string {
  return [
    r.key,
    r.label ?? '',
    r.status,
    r.expected ? 'yes' : 'no',
    r.fields.join('; '),
    sideText(r.base, r.fields),
    sideText(r.cur, r.fields),
    r.reason ?? ''
  ]
    .map(csvCell)
    .join(',')
}

function yyyymmdd(d: unknown): string {
  const t = d instanceof Date ? d : new Date(String(d ?? ''))
  const date = Number.isNaN(t.getTime()) ? new Date() : t
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

export async function qualityCheckRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/config', async () => {
    const r = declaredRerun()
    const rerun = r.ok ? { extension: r.extension, key: r.decl.key } : null
    if (!(await qualityTablesAvailable())) return { data: { rerun, targets: [] }, available: false }
    // Targets the runs name, newest first; one entry per name whatever its case.
    const names = (await db(RUNS)
      .orderBy('started_at', 'desc')
      .limit(500)
      .pluck('target')) as string[]
    const seen = new Set<string>()
    const targets: string[] = []
    for (const t of names) {
      const k = String(t).toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      targets.push(String(t))
    }
    return { data: { rerun, targets }, available: true }
  })

  app.get<{ Querystring: { target?: string } }>('/runs', async (req) => {
    if (!(await qualityTablesAvailable())) return { data: [], available: false }
    const q = db(RUNS).orderBy('started_at', 'desc').limit(30).select(RUN_COLUMNS)
    if (typeof req.query.target === 'string' && req.query.target)
      q.where({ target: req.query.target })
    const rows = (await q) as Record<string, unknown>[]
    return { data: rows.map(formatRun), available: true }
  })

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    if (!(await qualityTablesAvailable()))
      return reply.code(404).send({ error: NOT_SET_UP, available: false })
    if (!RUN_ID.test(req.params.id)) return reply.code(404).send({ error: 'No such run' })
    const run = (await db(RUNS)
      .where({ id: req.params.id })
      .first(...RUN_COLUMNS)) as Record<string, unknown> | undefined
    if (!run) return reply.code(404).send({ error: 'No such run' })
    const results = (await db(RESULTS)
      .where({ run: req.params.id })
      .select(SUMMARY_COLUMNS)) as Record<string, unknown>[]
    results.sort(
      (a, b) =>
        areaRank(a.area) - areaRank(b.area) || String(a.label).localeCompare(String(b.label))
    )
    return { data: { run: formatRun(run), results } }
  })

  app.get<{ Params: { id: string; checkId: string } }>(
    '/runs/:id/checks/:checkId',
    async (req, reply) => {
      if (!(await qualityTablesAvailable()))
        return reply.code(404).send({ error: NOT_SET_UP, available: false })
      const { id, checkId } = req.params
      if (!RUN_ID.test(id) || !CHECK_ID.test(checkId))
        return reply.code(404).send({ error: 'No such check' })
      const row = (await db(RESULTS).where({ run: id, check_id: checkId }).first()) as
        | Record<string, unknown>
        | undefined
      if (!row) return reply.code(404).send({ error: 'No such check' })
      const known = (await listKnown()).filter((k) => k.check_id === checkId)
      return {
        data: {
          result: {
            ...row,
            tolerance: parseJson(row.tolerance),
            rows: parseJson(row.rows) ?? [],
            clusters: parseJson(row.clusters) ?? []
          },
          known
        }
      }
    }
  )

  app.get<{ Params: { id: string; checkId: string } }>(
    '/runs/:id/checks/:checkId/csv',
    async (req, reply) => {
      if (!(await qualityTablesAvailable()))
        return reply.code(404).send({ error: NOT_SET_UP, available: false })
      const { id, checkId } = req.params
      if (!RUN_ID.test(id) || !CHECK_ID.test(checkId))
        return reply.code(404).send({ error: 'No such check' })
      const run = (await db(RUNS)
        .where({ id })
        .first('started_at', 'captured_at', 'verified_at')) as Record<string, unknown> | undefined
      const has = await db(RESULTS).where({ run: id, check_id: checkId }).first('id')
      if (!run || !has) return reply.code(404).send({ error: 'No such check' })
      const rows = (await loadDiff(db, id, checkId)) ?? []
      const body = [
        'key,label,status,expected,fields,production,staging,reason',
        ...rows.map(csvLine)
      ].join('\n')
      const day = yyyymmdd(run.verified_at ?? run.captured_at ?? run.started_at)
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="quality-${checkId}-${day}.csv"`)
        .send(`${body}\n`)
    }
  )

  async function listKnown() {
    const rows = (await db(KNOWN)
      .orderBy('created_at', 'desc')
      .select(
        'id',
        'check_id',
        'match',
        'reason',
        'created_by',
        'created_at',
        'last_matched_run',
        'matched_count',
        'idle_runs'
      )) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: Number(r.id),
      check_id: String(r.check_id),
      match: parseJson<Match>(r.match) ?? {},
      reason: String(r.reason ?? ''),
      created_by: r.created_by ?? null,
      created_at: r.created_at ?? null,
      last_matched_run: r.last_matched_run ?? null,
      matched_count: Number(r.matched_count ?? 0),
      idle_runs: Number(r.idle_runs ?? 0),
      stale: Number(r.idle_runs ?? 0) >= 3
    }))
  }

  app.get('/known', async () => {
    if (!(await qualityTablesAvailable())) return { data: [], available: false }
    return { data: await listKnown(), available: true }
  })

  app.post<{ Body: { check_id?: unknown; match?: unknown; reason?: unknown; run?: unknown } }>(
    '/known',
    async (req, reply) => {
      if (!(await qualityTablesAvailable()))
        return reply.code(409).send({ error: NOT_SET_UP, available: false })
      const body = req.body ?? {}
      if (typeof body.check_id !== 'string' || !CHECK_ID.test(body.check_id))
        return reply.code(400).send({ error: 'check_id is not a check id' })
      const m = parseKnownMatch(body.match)
      if (!m.ok) return reply.code(400).send({ error: m.error })
      const reason = parseReason(body.reason)
      if (!reason) return reply.code(400).send({ error: 'reason must be 3–1000 characters' })
      let run: string | null = null
      if (body.run != null) {
        if (typeof body.run !== 'string' || !RUN_ID.test(body.run) || !(await getRun(db, body.run)))
          return reply.code(400).send({ error: 'No such run' })
        run = body.run
      }
      const user = req.user!.id
      const inserted = (await db(KNOWN)
        .insert({
          check_id: body.check_id,
          match: JSON.stringify(m.match),
          reason,
          created_by: user,
          created_at: new Date(),
          matched_count: 0,
          idle_runs: 0
        })
        .returning('id')) as unknown[]
      const first = inserted[0]
      const id = Number(first && typeof first === 'object' ? (first as { id: unknown }).id : first)
      await logActivity({
        action: 'quality-known-create',
        user,
        collection: KNOWN,
        item: String(id),
        comment: reason,
        req
      })
      const rediffed = run
        ? (await rediffRun(db, run, { checkIds: [body.check_id] })).rediffed
        : false
      return { data: { id, rediffed } }
    }
  )

  app.patch<{ Params: { id: string }; Body: { reason?: unknown; match?: unknown } }>(
    '/known/:id',
    async (req, reply) => {
      if (!(await qualityTablesAvailable()))
        return reply.code(409).send({ error: NOT_SET_UP, available: false })
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id < 1) return reply.code(404).send({ error: 'Not found' })
      const existing = (await db(KNOWN).where({ id }).first('id', 'check_id')) as
        | { id: number; check_id: string }
        | undefined
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      const body = req.body ?? {}
      const patch: Record<string, unknown> = {}
      if (body.reason !== undefined) {
        const reason = parseReason(body.reason)
        if (!reason) return reply.code(400).send({ error: 'reason must be 3–1000 characters' })
        patch.reason = reason
      }
      if (body.match !== undefined) {
        const m = parseKnownMatch(body.match)
        if (!m.ok) return reply.code(400).send({ error: m.error })
        patch.match = JSON.stringify(m.match)
      }
      if (Object.keys(patch).length === 0)
        return reply.code(400).send({ error: 'Nothing to change: send reason or match' })
      await db(KNOWN).where({ id }).update(patch)
      await logActivity({
        action: 'quality-known-update',
        user: req.user!.id,
        collection: KNOWN,
        item: String(id),
        comment: typeof patch.reason === 'string' ? patch.reason : undefined,
        req
      })
      const rediffed = await rediffLatestFor(existing.check_id)
      return { data: { id, rediffed } }
    }
  )

  app.delete<{ Params: { id: string } }>('/known/:id', async (req, reply) => {
    if (!(await qualityTablesAvailable()))
      return reply.code(409).send({ error: NOT_SET_UP, available: false })
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id < 1) return reply.code(404).send({ error: 'Not found' })
    const existing = (await db(KNOWN).where({ id }).first('id', 'check_id', 'reason')) as
      | { id: number; check_id: string | null; reason: string }
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    await db(KNOWN).where({ id }).del()
    await logActivity({
      action: 'quality-known-delete',
      user: req.user!.id,
      collection: KNOWN,
      item: String(id),
      comment: existing.reason,
      req
    })
    const rediffed = await rediffLatestFor(existing.check_id)
    return { data: { id, rediffed } }
  })

  // Queues the one runbook an extension declared as its quality re-run; the
  // body names only the target.
  app.post<{ Body: { target?: unknown } }>('/rerun', async (req, reply) => {
    const body = req.body ?? {}
    const declared = declaredRerun()
    if (!declared.ok) return reply.code(declared.status).send({ error: declared.error })
    const { extension, decl } = declared
    const key = decl.key
    if (!(await hostQueueAvailable()))
      return reply
        .code(409)
        .send({ error: 'The runbook queue is not set up on this database (migration 403)' })
    const t = validateTarget(decl, body.target)
    if (!t.ok) return reply.code(400).send({ error: t.error })
    const target = t.target
    const active = (await db(QUEUE)
      .whereIn('status', ['queued', 'running'])
      .select('id', 'target')) as Array<{ id: string; target: string | null }>
    const busy = active.some((r) => (r.target ?? '').toLowerCase() === (target ?? '').toLowerCase())
    if (busy)
      return reply.code(409).send({
        error: 'A rebuild is running — re-run after it finishes',
        code: 'QUALITY_RERUN_BUSY'
      })
    // The same admission the host agent applies to the row it claims.
    const prior = (await listHostRuns(200)) as unknown as RunbookSummary[]
    const refusal = hostRunRefusal(
      decl,
      { extension, runbook: key, mode: 'go', target, from_step: null },
      prior
    )
    if (refusal) return reply.code(400).send({ error: refusal })
    const user = req.user!.id
    const argv = runbookArgv(decl, 'go')
    const run = await queueHostRun({
      extension,
      runbook: key,
      mode: 'go',
      target,
      args: [argv.file, ...argv.args],
      from: null,
      resumeOf: null,
      user
    })
    await logActivity({
      action: 'runbook-run-queue',
      user,
      collection: 'runbooks',
      item: run.id,
      comment: `${extension}:${key} go${target ? ` → ${target}` : ''} (quality re-run)`,
      req
    })
    return reply.code(201).send({ data: { run } })
  })
}
