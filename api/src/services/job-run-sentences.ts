/**
 * Job runs in sentences (#21): each nivaro_job_runs row read as "Nightly forecast: 4,210 rows in
 * 3m12s, 2 skipped (missing project)" from its progress / outcome / error — a per-job formatter
 * registry (core + `ctx.cron.describeRun` from extensions) with a generic fallback that reads the
 * usual progress keys.
 *
 * PURE: no database. The progress JSON contract this reads (all optional):
 *   done / processed / rows / written / resolved / recalculated / checked …  counts
 *   total                                                             the planned count
 *   failed / errors / missed / unresolved / skipped (number)         the rows that did not make it
 *   skipped: [{id, collection?, reason?}] (≤ 200, JOB_SKIP_CAP)       rows passed over, clickable
 *   skipped_total                                                     the real count when capped
 */

export interface JobRunFacts {
  id: number
  kind: string
  job_id: string
  label: string | null
  status: string
  duration_ms: number | null
  outcome: string | null
  error: string | null
  progress: Record<string, unknown> | null
}

export type JobRunFormatter = (run: JobRunFacts) => string | null

export interface JobRunSkip {
  id: string | number
  collection?: string | null
  reason?: string | null
}

/** The most rows a run's progress keeps in `skipped`. */
export const JOB_SKIP_CAP = 200

interface Entry {
  match: string | RegExp
  fn: JobRunFormatter
  source: string
}

/** Formatters are code, not tenant data — one list for the process. */
const formatters: Entry[] = []

/** Register a formatter for a job id (exact) or a pattern. The same id again replaces it. */
export function registerJobRunFormatter(
  match: string | RegExp,
  fn: JobRunFormatter,
  source = 'core'
): void {
  if (typeof fn !== 'function') return
  if (!(typeof match === 'string' ? match : match instanceof RegExp)) return
  const at = formatters.findIndex((e) => String(e.match) === String(match))
  const entry = { match, fn, source }
  if (at >= 0) formatters[at] = entry
  else formatters.push(entry)
}

export function clearJobRunFormatters(source?: string): void {
  for (let i = formatters.length - 1; i >= 0; i--) {
    if (source == null || formatters[i].source === source) formatters.splice(i, 1)
  }
}

// ─── Reading progress ────────────────────────────────────────────────────────

export function parseProgress(raw: unknown): Record<string, unknown> | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  try {
    const v = JSON.parse(String(raw)) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The skipped rows a run recorded (validated, capped). */
export function skippedRows(progress: Record<string, unknown> | null): JobRunSkip[] {
  const list = progress?.skipped
  if (!Array.isArray(list)) return []
  const out: JobRunSkip[] = []
  for (const s of list.slice(0, JOB_SKIP_CAP)) {
    if (!s || typeof s !== 'object') continue
    const r = s as Record<string, unknown>
    if (typeof r.id !== 'string' && typeof r.id !== 'number') continue
    out.push({
      id: r.id,
      collection: typeof r.collection === 'string' ? r.collection : null,
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : null
    })
  }
  return out
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)
      ? Number(v)
      : null

const DONE_KEYS: Array<[string, string]> = [
  ['rows', 'rows'],
  ['written', 'rows written'],
  ['processed', 'processed'],
  ['done', 'done'],
  ['resolved', 'resolved'],
  ['recalculated', 'recalculated'],
  ['checked', 'checked'],
  ['proved', 'proved'],
  ['sources_done', 'sources']
]
const MISS_KEYS: Array<[string, string]> = [
  ['failed', 'failed'],
  ['errors', 'errors'],
  ['missed', 'unresolved'],
  ['unresolved', 'unresolved'],
  ['disabled', 'disabled'],
  ['missing', 'missing']
]

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** 192000 → "3m12s"; 4200 → "4.2s"; 850 → "850ms". */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(sec).padStart(2, '0')}s`
}

/** "nightly-forecast" / "ext:efp-ops:po-sync" → "Nightly forecast" / "Po sync". */
export function jobName(run: Pick<JobRunFacts, 'job_id' | 'label'>): string {
  const label = String(run.label ?? '').trim()
  if (label && label.length <= 60 && !/[→>]/.test(label)) return label
  const last =
    String(run.job_id ?? '')
      .split(':')
      .pop() ?? ''
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Job'
}

/** The most common reason among the skipped rows ("missing project"), with how many share it. */
export function topReason(skips: JobRunSkip[]): { reason: string; n: number } | null {
  const counts = new Map<string, number>()
  for (const s of skips) {
    const r = String(s.reason ?? '').trim()
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  let best: { reason: string; n: number } | null = null
  for (const [reason, n] of counts) if (!best || n > best.n) best = { reason, n }
  return best
}

/** The generic reading of any run — the fallback every job gets. */
export function genericSentence(run: JobRunFacts): string {
  const name = jobName(run)
  const p = run.progress ?? {}
  const took = formatDuration(run.duration_ms)
  if (run.status === 'running') {
    const done = DONE_KEYS.map(([k]) => num(p[k])).find((v) => v != null)
    const total = num(p.total)
    const phase = typeof p.phase === 'string' ? p.phase : null
    const pct = num(p.percent)
    const where =
      done != null && total != null
        ? `${formatCount(done)} of ${formatCount(total)}`
        : done != null
          ? `${formatCount(done)} so far`
          : pct != null
            ? `${Math.round(pct)}%`
            : null
    return `${name}: running${where ? `, ${where}` : ''}${phase ? ` (${phase.toLowerCase()})` : ''}`
  }
  if (run.status === 'error' || run.error) {
    const why = String(run.error ?? 'no reason recorded')
      .split('\n')[0]
      .slice(0, 200)
    return `${name} failed${took ? ` after ${took}` : ''}: ${why}`
  }
  const parts: string[] = []
  const skips = skippedRows(p)
  const doneEntry = DONE_KEYS.map(([k, w]) => [num(p[k]), w] as const).find(([v]) => v != null)
  const total = num(p.total)
  if (doneEntry) {
    const [v, word] = doneEntry
    const unit = word === 'done' || word === 'processed' ? 'rows' : word
    parts.push(
      total != null && total !== v
        ? `${formatCount(v as number)} of ${formatCount(total)} ${unit}`
        : `${formatCount(v as number)} ${unit}`
    )
  } else if (total != null) {
    parts.push(`${formatCount(total)} rows`)
  }
  let line = `${name}: ${parts.length ? parts.join(', ') : 'done'}${took ? ` in ${took}` : ''}`
  const tails: string[] = []
  const skippedN = num(p.skipped_total) ?? num(p.skipped) ?? (skips.length || null)
  if (skippedN) {
    const reason = topReason(skips)
    tails.push(`${formatCount(skippedN)} skipped${reason ? ` (${reason.reason})` : ''}`)
  }
  for (const [k, word] of MISS_KEYS) {
    const v = num(p[k])
    if (v) tails.push(`${formatCount(v)} ${word}`)
  }
  if (tails.length) line += `, ${tails.join(', ')}`
  // Nothing countable in the progress: the run's own outcome says it best.
  if (!doneEntry && total == null && !tails.length && run.outcome) {
    line = `${name}: ${run.outcome.split('\n')[0].slice(0, 200)}${took ? ` (${took})` : ''}`
  }
  return line
}

/** The sentence for one run: a registered formatter when one answers, else the generic one. */
export function jobRunSentence(run: JobRunFacts): string {
  for (const e of formatters) {
    const hit = typeof e.match === 'string' ? e.match === run.job_id : e.match.test(run.job_id)
    if (!hit) continue
    try {
      const s = e.fn(run)
      if (typeof s === 'string' && s.trim()) return s.trim().slice(0, 400)
    } catch {
      /* a broken formatter falls back to the generic reading */
    }
  }
  return genericSentence(run)
}

/** A nivaro_job_runs row → facts → sentence + the skipped rows it recorded. */
export function describeJobRunRow(row: Record<string, unknown>): {
  sentence: string
  skipped_count: number
  skipped_ids: boolean
} {
  const progress = parseProgress(row.progress)
  const facts: JobRunFacts = {
    id: Number(row.id),
    kind: String(row.kind ?? ''),
    job_id: String(row.job_id ?? ''),
    label: row.label == null ? null : String(row.label),
    status: String(row.status ?? ''),
    duration_ms: num(row.duration_ms),
    outcome: row.outcome == null ? null : String(row.outcome),
    error: row.error == null ? null : String(row.error).split('\n')[0].slice(0, 300),
    progress
  }
  const skips = skippedRows(progress)
  return {
    sentence: jobRunSentence(facts),
    skipped_count: num(progress?.skipped_total) ?? (skips.length || num(progress?.skipped) || 0),
    skipped_ids: skips.length > 0
  }
}

// ─── Recording skips (the job side) ─────────────────────────────────────────

/**
 * Collects the rows a job passes over for its progress JSON: the first JOB_SKIP_CAP kept with
 * id / collection / reason, the true total counted. `progress()` returns the fields to spread
 * into `run.progress({...})`.
 */
export function createSkipList(collection?: string | null) {
  const items: JobRunSkip[] = []
  let total = 0
  return {
    add(id: string | number, reason?: string | null, coll?: string | null): void {
      total++
      if (items.length >= JOB_SKIP_CAP) return
      items.push({
        id,
        collection: coll ?? collection ?? null,
        reason: reason ? String(reason).slice(0, 120) : null
      })
    },
    get total(): number {
      return total
    },
    progress(): { skipped: JobRunSkip[]; skipped_total: number } | Record<string, never> {
      return total > 0 ? { skipped: items.slice(), skipped_total: total } : {}
    }
  }
}

// ─── Core formatters (examples of the registry) ─────────────────────────────

registerJobRunFormatter('geocode-backfill', (run) => {
  if (run.status !== 'completed') return null
  const p = run.progress ?? {}
  const resolved = num(p.resolved)
  if (resolved == null) return null
  const skipped = num(p.skipped_total) ?? num(p.missed) ?? 0
  const took = formatDuration(run.duration_ms)
  const reason = topReason(skippedRows(p))
  return `Address lookup: ${formatCount(resolved)} placed on the map${took ? ` in ${took}` : ''}${
    skipped ? `, ${formatCount(skipped)} skipped (${reason?.reason ?? 'address not found'})` : ''
  }`
})

registerJobRunFormatter('find-replace', (run) => {
  if (run.status === 'running') return null
  const p = run.progress ?? {}
  const done = num(p.done)
  if (done == null) return null
  const failed = num(p.skipped_total) ?? num(p.failed) ?? 0
  const took = formatDuration(run.duration_ms)
  const reason = topReason(skippedRows(p))
  return `Find and replace: ${formatCount(done)} records changed${took ? ` in ${took}` : ''}${
    failed ? `, ${formatCount(failed)} not changed${reason ? ` (${reason.reason})` : ''}` : ''
  }`
})

/** Plain progress stays under this; a blob carrying a `skipped` list may use up to SKIP_JSON_MAX. */
const PROGRESS_JSON_MAX = 4000
const SKIP_JSON_MAX = 32_000

/**
 * The stored progress text. Always valid JSON: a blob over the cap with a `skipped` list keeps
 * as many skipped rows as fit (`skipped_total` keeps the real count); anything else over the cap
 * keeps its scalar fields only — a cut string would no longer parse.
 */
export function progressJson(blob: Record<string, unknown>): string {
  let s = JSON.stringify(blob) ?? '{}'
  if (s.length <= PROGRESS_JSON_MAX) return s
  if (Array.isArray(blob.skipped)) {
    const list = blob.skipped.slice(0, JOB_SKIP_CAP)
    const total = num(blob.skipped_total) ?? blob.skipped.length
    let keep = list.length
    while (keep >= 0) {
      s = JSON.stringify({ ...blob, skipped: list.slice(0, keep), skipped_total: total })
      if (s.length <= SKIP_JSON_MAX) return s
      keep = keep > 20 ? Math.floor(keep * 0.75) : keep - 1
    }
  }
  const scalars = Object.fromEntries(
    Object.entries(blob).filter(([, v]) => v == null || typeof v !== 'object')
  )
  s = JSON.stringify(scalars)
  return s.length <= PROGRESS_JSON_MAX ? s : '{}'
}
