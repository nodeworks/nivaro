import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { listRuns, trayEvent } from '../services/background-runs.js'
import type { JobProgressEvent } from '../services/live-progress.js'

/**
 * GET /api/my-jobs — the Jobs tray's starting point (#1724).
 *
 * What the CALLER started and is still running or finished in the last 30 minutes: job runs
 * (bulk, exports, PDFs, backfills …) and staged imports they queued. The socket then keeps
 * each entry current; this read is what a fresh page load or a second tab starts from.
 * Always scoped to the caller — an administrator sees their own work here, the Background
 * Jobs console is the place for everyone's.
 */

const WINDOW_MS = 30 * 60_000
const KINDS_HIDDEN = new Set(['chaos', 'monitor', 'tuning'])

function short(v: unknown, n = 300): string | null {
  return v == null || v === '' ? null : String(v).slice(0, n)
}

function parseProgress(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function myJobsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireAuth }, async (req) => {
    const me = req.user?.id
    if (!me) return { data: [] as JobProgressEvent[] }
    const since = new Date(Date.now() - WINDOW_MS)
    const out: Array<JobProgressEvent & { at: string }> = []

    const runs = (await db('nivaro_job_runs')
      .where('triggered_by', me)
      .where((qb) => qb.where('status', 'running').orWhere('started_at', '>=', since))
      .orderBy('id', 'desc')
      .limit(30)
      .select(
        'id',
        'kind',
        'job_id',
        'label',
        'status',
        'progress',
        'outcome',
        'error',
        'started_at',
        'finished_at'
      )
      .catch(() => [])) as Array<Record<string, unknown>>
    for (const r of runs) {
      if (KINDS_HIDDEN.has(String(r.kind))) continue
      const outcome = short(r.outcome)
      // An export/PDF outcome names its file ("name.xlsx → file <id>") — give the tray the chip.
      const fileId = outcome?.match(/→ file ([0-9a-fA-F-]{8,})\s*$/)?.[1] ?? null
      // A background Ask AI question (#2456) links to its conversation and can be cancelled.
      const research = r.kind === 'ai' && r.job_id === 'ask-research'
      const conversation = research ? parseProgress(r.progress)?.conversation_id : null
      out.push({
        key: `job:${r.id}`,
        kind: String(r.kind),
        label: short(r.label, 160) ?? short(r.job_id, 160),
        status: (r.status === 'error'
          ? 'error'
          : r.status === 'running'
            ? 'running'
            : 'completed') as 'error' | 'running' | 'completed',
        progress: parseProgress(r.progress),
        outcome,
        error: short(r.error),
        ...(fileId ? { file_id: fileId } : {}),
        ...(typeof conversation === 'string'
          ? { href: `/ask?conversation=${encodeURIComponent(conversation)}` }
          : {}),
        ...(research && r.status === 'running'
          ? { cancel_path: `/ai/research/${r.id}/cancel` }
          : {}),
        at: new Date(String(r.finished_at ?? r.started_at ?? Date.now())).toISOString()
      })
    }

    const imports = (await db('nivaro_import_queue')
      .where('created_by', me)
      .where((qb) => qb.whereIn('status', ['queued', 'running']).orWhere('updated_at', '>=', since))
      .orderBy('id', 'desc')
      .limit(20)
      .select('id', 'import_key', 'status', 'logs', 'updated_at', 'created_at')
      .catch(() => [])) as Array<Record<string, unknown>>
    let standing: Map<number, { position: number; eta_seconds: number | null }> | null = null
    if (imports.some((i) => i.status === 'queued')) {
      try {
        const { currentStanding } = await import('../services/staged-import-worker.js')
        standing = (await currentStanding()).standing
      } catch {
        standing = null
      }
    }
    for (const i of imports) {
      const status = String(i.status)
      const s = standing?.get(Number(i.id))
      out.push({
        key: `import:${i.id}`,
        kind: 'import',
        label: `${String(i.import_key)} import`,
        status:
          status === 'completed'
            ? 'completed'
            : status === 'error'
              ? 'error'
              : status === 'canceled'
                ? 'canceled'
                : status === 'running'
                  ? 'running'
                  : 'queued',
        ...(s ? { position: s.position, eta_seconds: s.eta_seconds } : {}),
        ...(status === 'error' ? { error: short(i.logs) } : {}),
        href: `/imports?run=${i.id}`,
        at: new Date(String(i.updated_at ?? i.created_at ?? Date.now())).toISOString()
      })
    }
    // #2759 — slow reads the caller sent to the background.
    for (const r of await listRuns(app.redis ?? null, me).catch(() => [])) {
      const at = r.finished_at ?? r.started_at
      if (r.status !== 'running' && Date.parse(at) < since.getTime()) continue
      out.push({ ...trayEvent(r), at: new Date(at).toISOString() })
    }
    return { data: out.sort((a, b) => b.at.localeCompare(a.at)) }
  })
}
