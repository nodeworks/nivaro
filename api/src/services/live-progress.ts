import { getIo } from './io-holder.js'

/**
 * Progress for the person who started something (Jobs tray, bulk rows, import
 * queue). Everything here goes to ONE `user:<id>` room — never a shared room —
 * and carries ids, counts and short status text only. The client refetches
 * anything bigger through permission-checked routes.
 */

export function emitToUser(userId: string | null | undefined, event: string, payload: unknown) {
  if (!userId) return
  try {
    getIo()?.to(`user:${userId}`).emit(event, payload)
  } catch {
    /* decoration — progress must never break the work */
  }
}

/** One Jobs-tray entry changed. `key` is stable per job so the tray updates it in place. */
export interface JobProgressEvent {
  key: string
  kind: string
  label?: string | null
  status: 'queued' | 'running' | 'completed' | 'error' | 'canceled'
  /** Free-form counters (`done`, `total`, `phase`). */
  progress?: Record<string, unknown> | null
  outcome?: string | null
  error?: string | null
  /** Admin-relative path the tray links to (details page, the finished file). */
  href?: string | null
  /** A file the job produced — the tray shows a download chip. */
  file_id?: string | null
  /** Import queue: 1 = next up. */
  position?: number | null
  eta_seconds?: number | null
}

export function emitJobProgress(userId: string | null | undefined, ev: JobProgressEvent): void {
  emitToUser(userId, 'job:progress', ev)
}

// ── Bulk action progress on rows ───────────────────────────────────────────

const PROGRESS_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

export type BulkRowStatus = 'running' | 'done' | 'skipped' | 'failed'

export interface BulkRowSnapshot {
  ok: number
  failed: number
  skipped?: number
  /** Why the most recent failure happened (short; cleared per row by the caller). */
  reason?: string | null
}

/**
 * Per-row progress of one bulk run, keyed by an id the CLIENT made up
 * (`?progress=<id>`). Rows are batched (≤ 20 rows or 150 ms) so a 2,000-row
 * run is a few hundred small events, not 4,000. Without a valid id every call
 * is a no-op.
 *
 *   const rp = openBulkRowProgress(req.query.progress, userId, () => ({ ok, failed }))
 *   for (const id of ids) { rp.next(id); …work… }
 *   rp.end()
 */
export function openBulkRowProgress(
  rawId: unknown,
  userId: string | null | undefined,
  snapshot: () => BulkRowSnapshot
) {
  const progress = typeof rawId === 'string' && PROGRESS_ID_RE.test(rawId) ? rawId : null
  if (!progress || !userId) return { next: (_id: unknown) => {}, end: () => {} }
  let current: string | null = null
  let before: BulkRowSnapshot = { ok: 0, failed: 0, skipped: 0 }
  let buffer: Array<{ id: string; status: BulkRowStatus; reason?: string }> = []
  let lastFlush = 0
  const flush = (running?: string | null) => {
    if (buffer.length === 0 && !running) return
    emitToUser(userId, 'bulk:rows', { progress, rows: buffer, running: running ?? null })
    buffer = []
    lastFlush = Date.now()
  }
  const settle = () => {
    if (current == null) return
    const now = snapshot()
    let status: BulkRowStatus = 'done'
    if (now.failed > before.failed) status = 'failed'
    else if ((now.skipped ?? 0) > (before.skipped ?? 0)) status = 'skipped'
    const row: { id: string; status: BulkRowStatus; reason?: string } = { id: current, status }
    if (status === 'failed' && now.reason) row.reason = String(now.reason).slice(0, 160)
    buffer.push(row)
    current = null
  }
  return {
    next(id: unknown) {
      settle()
      current = String(id)
      before = { ...snapshot() }
      if (buffer.length >= 20 || Date.now() - lastFlush > 150) flush(current)
    },
    end() {
      settle()
      flush(null)
      emitToUser(userId, 'bulk:rows', { progress, rows: [], running: null, finished: true })
    }
  }
}
