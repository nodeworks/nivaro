import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { QualityRow } from '@nivaro/extension-kit'
import type { Knex } from 'knex'
import { type DiffResult, type DiffRow, diffRows, type KnownDifference } from './diff.js'

/**
 * Storage for staging quality checks (migration 404). Every write here goes to
 * the APP database (EFP_Development), never the database being checked.
 * Row lists are stored gzip + base64 so a 250k-row baseline stays a single text
 * value; upserts are delete-then-insert inside one transaction.
 */

const RUNS = 'nivaro_quality_runs'
const ROWS = 'nivaro_quality_rows'
const RESULTS = 'nivaro_quality_results'
const KNOWN = 'nivaro_quality_known'

/** Mismatch rows kept on the results row; the diff side keeps them all. */
export const RESULT_ROW_LIMIT = 500

const clip = (s: string | null | undefined, n: number): string | null =>
  s == null ? null : s.length > n ? s.slice(0, n) : s

function encodeJson(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64')
}

function decodeJson<T>(text: string): T {
  return JSON.parse(gunzipSync(Buffer.from(text, 'base64')).toString('utf8')) as T
}

function parseJson<T>(text: unknown): T | null {
  if (typeof text !== 'string' || text === '') return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function encodeRows(rows: QualityRow[]): string {
  return encodeJson(rows)
}

export function decodeRows(text: string): QualityRow[] {
  return decodeJson<QualityRow[]>(text)
}

export async function createRun(
  app: Knex,
  target: string,
  runbookRun: string | null
): Promise<string> {
  const id = randomUUID()
  await app(RUNS).insert({
    id,
    target,
    runbook_run: runbookRun,
    status: 'capturing',
    started_at: new Date()
  })
  return id
}

export async function saveSide(
  app: Knex,
  run: string,
  checkId: string,
  side: 'baseline' | 'current' | 'diff',
  out: { rows?: QualityRow[]; durationMs: number; error?: string }
): Promise<void> {
  const failed = out.error !== undefined || !out.rows
  await upsertSide(app, run, checkId, side, {
    rows_gz: failed ? null : encodeRows(out.rows as QualityRow[]),
    row_count: failed ? 0 : (out.rows as QualityRow[]).length,
    duration_ms: Math.round(out.durationMs),
    error: failed ? clip(out.error ?? 'no rows returned', 2000) : null
  })
}

async function upsertSide(
  app: Knex,
  run: string,
  checkId: string,
  side: string,
  fields: {
    rows_gz: string | null
    row_count: number
    duration_ms: number | null
    error: string | null
  }
): Promise<void> {
  await app.transaction(async (trx) => {
    await trx(ROWS).where({ run, check_id: checkId, side }).del()
    await trx(ROWS).insert({ run, check_id: checkId, side, created_at: new Date(), ...fields })
  })
}

export async function loadSide(
  app: Knex,
  run: string,
  checkId: string,
  side: 'baseline' | 'current'
): Promise<{ rows: QualityRow[] | null; error: string | null }> {
  const row = (await app(ROWS).where({ run, check_id: checkId, side }).first('rows_gz', 'error')) as
    | { rows_gz: string | null; error: string | null }
    | undefined
  if (!row) return { rows: null, error: null }
  if (row.error) return { rows: null, error: row.error }
  if (!row.rows_gz) return { rows: null, error: null }
  return { rows: decodeRows(row.rows_gz), error: null }
}

export async function saveDiff(
  app: Knex,
  run: string,
  checkId: string,
  rows: DiffRow[]
): Promise<void> {
  await upsertSide(app, run, checkId, 'diff', {
    rows_gz: encodeJson(rows),
    row_count: rows.length,
    duration_ms: null,
    error: null
  })
}

export async function loadDiff(app: Knex, run: string, checkId: string): Promise<DiffRow[] | null> {
  const row = (await app(ROWS).where({ run, check_id: checkId, side: 'diff' }).first('rows_gz')) as
    | { rows_gz: string | null }
    | undefined
  if (!row?.rows_gz) return null
  return decodeJson<DiffRow[]>(row.rows_gz)
}

export async function latestRunForTarget(
  app: Knex,
  target: string
): Promise<{ id: string; status: string } | null> {
  const row = (await app(RUNS)
    .where({ target })
    .orderBy('started_at', 'desc')
    .first('id', 'status')) as { id: string; status: string } | undefined
  return row ? { id: row.id, status: row.status } : null
}

export async function loadKnown(app: Knex): Promise<KnownDifference[]> {
  const rows = (await app(KNOWN).select('id', 'check_id', 'match', 'reason')) as Array<{
    id: number
    check_id: string
    match: string
    reason: string
  }>
  const out: KnownDifference[] = []
  for (const r of rows) {
    const match = parseJson<KnownDifference['match']>(r.match)
    if (!match || typeof match !== 'object') continue
    out.push({ id: Number(r.id), check_id: r.check_id, match, reason: r.reason })
  }
  return out
}

export interface CheckMeta {
  id: string
  area: string
  label: string
  description: string
  tolerance?: { abs?: number; pct?: number }
}

export async function saveResult(
  app: Knex,
  run: string,
  meta: CheckMeta,
  r: { diff?: DiffResult; error?: string; durationMs: number }
): Promise<void> {
  const d = r.error === undefined ? r.diff : undefined
  const tolerance = meta.tolerance ? JSON.stringify(meta.tolerance) : null
  const row = {
    run,
    check_id: meta.id,
    area: clip(meta.area, 32) ?? '',
    label: clip(meta.label, 200) ?? meta.id,
    description: clip(meta.description, 1000),
    status: d ? d.status : 'error',
    tolerance: tolerance && tolerance.length <= 100 ? tolerance : null,
    compared: d?.compared ?? 0,
    matched: d?.matched ?? 0,
    amber_count: d?.amber ?? 0,
    red_count: d?.red ?? 0,
    baseline_only: d?.baseline_only ?? 0,
    current_only: d?.current_only ?? 0,
    duration_ms: Math.round(r.durationMs),
    error: d ? null : clip(r.error ?? 'no diff computed', 2000),
    clusters: d ? JSON.stringify(d.clusters) : null,
    rows: d ? JSON.stringify(d.rows.slice(0, RESULT_ROW_LIMIT)) : null,
    computed_at: new Date()
  }
  await app.transaction(async (trx) => {
    await trx(RESULTS).where({ run, check_id: meta.id }).del()
    await trx(RESULTS).insert(row)
  })
}

/**
 * Updates `nivaro_quality_known` after a verify stage. Only entries for the
 * checks that were diffed are touched: a hit resets `idle_runs`, a miss adds one.
 */
export async function recordKnownHits(
  app: Knex,
  run: string,
  checkIds: string[],
  hits: Map<number, number>
): Promise<void> {
  if (checkIds.length === 0) return
  const known = (await app(KNOWN).whereIn('check_id', checkIds).select('id')) as Array<{
    id: number
  }>
  for (const { id } of known) {
    const n = hits.get(Number(id)) ?? 0
    if (n > 0)
      await app(KNOWN)
        .where({ id })
        .update({
          matched_count: app.raw('matched_count + ?', [n]),
          last_matched_run: run,
          idle_runs: 0
        })
    else await app(KNOWN).where({ id }).increment('idle_runs', 1)
  }
}

/**
 * Re-diffs every check of a run from the stored sides — used after a known
 * difference is added or removed; never reads the checked database. A check
 * whose own `expected()` marked a row amber cannot be called again here, so its
 * stored reason stands in for it; the stored reason of an unexpected row stands
 * in for `explain()`.
 */
export async function rediffRun(app: Knex, run: string): Promise<void> {
  const results = (await app(RESULTS).where({ run }).select('*')) as Array<{
    check_id: string
    area: string
    label: string
    description: string | null
    status: string
    tolerance: string | null
    duration_ms: number | null
  }>
  const known = await loadKnown(app)
  for (const res of results) {
    const base = await loadSide(app, run, res.check_id, 'baseline')
    const cur = await loadSide(app, run, res.check_id, 'current')
    if (!base.rows || !cur.rows) continue
    const previous = (await loadDiff(app, run, res.check_id)) ?? []
    const builtIn = new Map<string, string>()
    const explained = new Map<string, string>()
    for (const p of previous) {
      if (p.reason === null) continue
      if (p.expected && p.known_id === null) builtIn.set(p.key, p.reason)
      else if (!p.expected) explained.set(p.key, p.reason)
    }
    const keyOf = (b: QualityRow | null, c: QualityRow | null) => (b ?? c)?.key ?? ''
    const tolerance = parseJson<{ abs?: number; pct?: number }>(res.tolerance) ?? undefined
    const diff = diffRows(
      {
        tolerance,
        expected: (b, c) => builtIn.get(keyOf(b, c)) ?? null,
        explain: (b, c) => explained.get(keyOf(b, c)) ?? null
      },
      base.rows,
      cur.rows,
      known.filter((k) => k.check_id === res.check_id)
    )
    await saveDiff(app, run, res.check_id, diff.rows)
    await saveResult(
      app,
      run,
      {
        id: res.check_id,
        area: res.area,
        label: res.label,
        description: res.description ?? '',
        ...(tolerance ? { tolerance } : {})
      },
      { diff, durationMs: res.duration_ms ?? 0 }
    )
  }
  const statuses = (await app(RESULTS).where({ run }).pluck('status')) as string[]
  await setRunStatus(app, run, { totals: totalsOf(statuses) })
}

export async function setRunStatus(
  app: Knex,
  run: string,
  patch: Partial<{
    status: string
    captured_at: Date
    verified_at: Date
    totals: object
    error: string
  }>
): Promise<void> {
  const update: Record<string, unknown> = {}
  if (patch.status !== undefined) update.status = patch.status
  if (patch.captured_at !== undefined) update.captured_at = patch.captured_at
  if (patch.verified_at !== undefined) update.verified_at = patch.verified_at
  if (patch.totals !== undefined) update.totals = JSON.stringify(patch.totals)
  if (patch.error !== undefined) update.error = clip(patch.error, 2000)
  if (Object.keys(update).length === 0) return
  await app(RUNS).where({ id: run }).update(update)
}

/** Keeps the newest `keep` runs of a target; returns how many were removed. */
export async function pruneRuns(app: Knex, target: string, keep = 14): Promise<number> {
  const ids = (await app(RUNS)
    .where({ target })
    .orderBy('started_at', 'desc')
    .offset(keep)
    .pluck('id')) as string[]
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    await app(ROWS).whereIn('run', chunk).del()
    await app(RESULTS).whereIn('run', chunk).del()
    await app(RUNS).whereIn('id', chunk).del()
  }
  return ids.length
}

export function totalsOf(statuses: string[]): {
  green: number
  amber: number
  red: number
  error: number
} {
  const t = { green: 0, amber: 0, red: 0, error: 0 }
  for (const s of statuses)
    if (s === 'green' || s === 'amber' || s === 'red' || s === 'error') t[s]++
  return t
}
