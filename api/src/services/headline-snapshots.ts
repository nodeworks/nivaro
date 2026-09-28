import { db } from '../db/index.js'

/**
 * Headline snapshots (#851) — one row a day of a deployment's budget headline
 * figures, so a dashboard can say how far they moved and draw a sparkline.
 *
 * What to read is configuration, not code: `nivaro_settings.dashboard_headline`
 * names a custom query, the parameter that carries the year, and optionally a
 * zone parameter plus the collection whose rows list the zones. The nightly
 * `dashboard-headline-snapshot` cron runs the query once for the whole year
 * and once per zone, sums the configured result columns, and upserts one
 * `nivaro_dashboard_snapshots` row per (day, year, zone) — zone NULL = all.
 */

export interface HeadlineSettings {
  query: string
  year_param: string
  zone_param: string | null
  zone_collection: string | null
  zone_field: string | null
  fields: { pubd: string; spend: string; committed: string; remaining: string }
}

export interface HeadlineSnapshotRow {
  snapshot_date: string
  year: number
  zone: string | null
  pubd: number
  spend: number
  committed: number
  remaining: number
  projects: number
}

export interface HeadlinePlanEntry {
  zone: string | null
  params: Record<string, string>
}

export type HeadlineRunResult =
  | { skipped: 'not configured' }
  | { written: number; failed: Array<{ zone: string | null; error: string }> }

type RunQuery = (
  slug: string,
  params: Record<string, string>
) => Promise<Array<Record<string, unknown>>>
type Insert = (row: HeadlineSnapshotRow) => Promise<void>

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SYSTEM = /^(nivaro_|directus_)/i
const FIELD_KEYS = ['pubd', 'spend', 'committed', 'remaining'] as const

function asObject(raw: unknown): Record<string, unknown> | null {
  let v = raw
  if (typeof v === 'string') {
    if (!v.trim()) return null
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function optIdent(v: unknown): string | null | false {
  if (v == null || v === '') return null
  return typeof v === 'string' && IDENT.test(v) ? v : false
}

/**
 * Reads the setting, or null when it is unset or unusable. `validateHeadlineSettings`
 * is the same parse that also says why a value is refused.
 */
export function parseHeadlineSettings(raw: unknown): HeadlineSettings | null {
  const r = validateHeadlineSettings(raw)
  return r.error ? null : r.value
}

export function validateHeadlineSettings(raw: unknown): {
  value: HeadlineSettings | null
  error?: string
} {
  const o = asObject(raw)
  if (!o || Object.keys(o).length === 0) {
    if (raw == null || raw === '' || (o && Object.keys(o).length === 0)) return { value: null }
    return { value: null, error: 'dashboard_headline must be a JSON object' }
  }
  if (o.query == null || o.query === '') return { value: null }
  if (typeof o.query !== 'string' || !SLUG.test(o.query)) {
    return { value: null, error: 'dashboard_headline.query must be a custom query slug' }
  }
  if (typeof o.year_param !== 'string' || !IDENT.test(o.year_param)) {
    return { value: null, error: 'dashboard_headline.year_param must be a parameter name' }
  }
  const zoneParam = optIdent(o.zone_param)
  const zoneCollection = optIdent(o.zone_collection)
  const zoneField = optIdent(o.zone_field)
  if (zoneParam === false || zoneCollection === false || zoneField === false) {
    return { value: null, error: 'dashboard_headline zone names must be plain identifiers' }
  }
  if (zoneCollection && SYSTEM.test(zoneCollection)) {
    return { value: null, error: 'dashboard_headline.zone_collection cannot be a system table' }
  }
  const zoneParts = [zoneParam, zoneCollection, zoneField].filter(Boolean).length
  if (zoneParts !== 0 && zoneParts !== 3) {
    return {
      value: null,
      error: 'dashboard_headline needs zone_param, zone_collection and zone_field together'
    }
  }
  const f = o.fields && typeof o.fields === 'object' ? (o.fields as Record<string, unknown>) : {}
  const fields = {} as HeadlineSettings['fields']
  for (const k of FIELD_KEYS) {
    const v = f[k]
    if (typeof v !== 'string' || !IDENT.test(v)) {
      return { value: null, error: `dashboard_headline.fields.${k} must be a result column name` }
    }
    fields[k] = v
  }
  return {
    value: {
      query: o.query,
      year_param: o.year_param,
      zone_param: zoneParam || null,
      zone_collection: zoneCollection || null,
      zone_field: zoneField || null,
      fields
    }
  }
}

function dayOf(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

const cents = (n: number) => Math.round(n * 100) / 100

/** Every query a tick would run: the whole year first, then one per zone. */
export function planHeadlineSnapshot(
  settings: HeadlineSettings | null,
  zones: string[],
  now: Date
): HeadlinePlanEntry[] {
  if (!settings) return []
  const base = { [settings.year_param]: String(now.getFullYear()) }
  const plan: HeadlinePlanEntry[] = [{ zone: null, params: base }]
  if (settings.zone_param) {
    for (const zone of zones) plan.push({ zone, params: { ...base, [settings.zone_param]: zone } })
  }
  return plan
}

/**
 * Pure: runs the plan through `runQuery`, sums each result into one row and
 * hands it to `insert` (an upsert on the DB side). A zone whose query fails is
 * reported and skipped; the others still land.
 */
export async function recordHeadlineSnapshot(
  rawSettings: unknown,
  runQuery: RunQuery,
  insert: Insert,
  zones: string[],
  now: Date
): Promise<HeadlineRunResult> {
  const settings = parseHeadlineSettings(rawSettings)
  if (!settings) return { skipped: 'not configured' }
  const snapshotDate = dayOf(now)
  const year = now.getFullYear()
  let written = 0
  const failed: Array<{ zone: string | null; error: string }> = []
  for (const entry of planHeadlineSnapshot(settings, zones, now)) {
    try {
      const rows = await runQuery(settings.query, entry.params)
      const sum = (col: string) => cents(rows.reduce((s, r) => s + num(r[col]), 0))
      await insert({
        snapshot_date: snapshotDate,
        year,
        zone: entry.zone,
        pubd: sum(settings.fields.pubd),
        spend: sum(settings.fields.spend),
        committed: sum(settings.fields.committed),
        remaining: sum(settings.fields.remaining),
        projects: rows.length
      })
      written++
    } catch (err) {
      failed.push({ zone: entry.zone, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { written, failed }
}

// ── DB side ──────────────────────────────────────────────────────────────────

export const HEADLINE_TABLE = 'nivaro_dashboard_snapshots'

export async function loadHeadlineSettings(): Promise<HeadlineSettings | null> {
  const row = (await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first('dashboard_headline')
    .catch(() => undefined)) as { dashboard_headline?: string | null } | undefined
  return parseHeadlineSettings(row?.dashboard_headline ?? null)
}

/** The zone values, from the configured collection — distinct, non-empty, sorted. */
export async function listHeadlineZones(settings: HeadlineSettings | null): Promise<string[]> {
  if (!settings?.zone_collection || !settings.zone_field) return []
  const col = settings.zone_field
  const rows = (await db(settings.zone_collection)
    .distinct(col)
    .whereNotNull(col)
    .limit(200)) as Array<Record<string, unknown>>
  return [...new Set(rows.map((r) => String(r[col] ?? '').trim()).filter(Boolean))]
    .map((z) => z.slice(0, 80))
    .sort((a, b) => a.localeCompare(b))
}

/** One row per (day, year, zone): a re-run the same day updates it. */
export async function upsertHeadlineSnapshot(row: HeadlineSnapshotRow): Promise<void> {
  const figures = {
    pubd: row.pubd,
    spend: row.spend,
    committed: row.committed,
    remaining: row.remaining,
    projects: row.projects
  }
  const match = (q: ReturnType<typeof db>) => {
    q.where({ snapshot_date: row.snapshot_date, year: row.year })
    if (row.zone == null) q.whereNull('zone')
    else q.where('zone', row.zone)
    return q
  }
  const updated = await match(db(HEADLINE_TABLE)).update(figures)
  const count = Array.isArray(updated) ? updated.length : Number(updated)
  if (count > 0) return
  await db(HEADLINE_TABLE).insert({
    snapshot_date: row.snapshot_date,
    year: row.year,
    zone: row.zone,
    ...figures,
    created_at: new Date()
  })
}

/** The cron tick. */
export async function runHeadlineSnapshot(
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
  now = new Date()
): Promise<HeadlineRunResult> {
  const settings = await loadHeadlineSettings()
  if (!settings) {
    log.info('dashboard-headline-snapshot: not configured')
    return { skipped: 'not configured' }
  }
  const zones = await listHeadlineZones(settings).catch((err) => {
    log.warn({ err }, 'dashboard-headline-snapshot: zone list failed')
    return [] as string[]
  })
  const { runCustomQueryBySlug } = await import('./custom-query-exec.js')
  const t0 = Date.now()
  const result = await recordHeadlineSnapshot(
    settings,
    (slug, params) => runCustomQueryBySlug(slug, params),
    upsertHeadlineSnapshot,
    zones,
    now
  )
  if ('written' in result) {
    const level = result.failed.length ? 'warn' : 'info'
    log[level](
      { written: result.written, failed: result.failed, ms: Date.now() - t0 },
      'dashboard-headline-snapshot done'
    )
  }
  return result
}

/** What a tick WOULD run, nothing written. */
export async function dryRunHeadlineSnapshot(now = new Date()) {
  const settings = await loadHeadlineSettings()
  if (!settings) return { skipped: 'not configured' }
  const zones = await listHeadlineZones(settings).catch(() => [] as string[])
  return {
    query: settings.query,
    snapshot_date: dayOf(now),
    would_run: planHeadlineSnapshot(settings, zones, now).map((p) => ({
      zone: p.zone ?? '(all)',
      params: p.params
    }))
  }
}

export interface HeadlineHistoryPoint {
  snapshot_date: string
  pubd: number
  spend: number
  committed: number
  remaining: number
  projects: number
}

function isoDay(v: unknown): string {
  if (v instanceof Date) {
    // `date` columns arrive as UTC midnight — read the UTC calendar day.
    return v.toISOString().slice(0, 10)
  }
  return String(v ?? '').slice(0, 10)
}

/** Oldest first, the last `days` days, for one year and one zone (null = all). */
export async function readHeadlineHistory(opts: {
  year: number
  zone: string | null
  days: number
  now?: Date
}): Promise<HeadlineHistoryPoint[]> {
  const now = opts.now ?? new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - opts.days)
  const q = db(HEADLINE_TABLE)
    .select('snapshot_date', 'pubd', 'spend', 'committed', 'remaining', 'projects')
    .where('year', opts.year)
    .where('snapshot_date', '>=', dayOf(from))
    .orderBy('snapshot_date', 'asc')
    .limit(400)
  if (opts.zone == null) q.whereNull('zone')
  else q.where('zone', opts.zone)
  const rows = (await q) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    snapshot_date: isoDay(r.snapshot_date),
    pubd: num(r.pubd),
    spend: num(r.spend),
    committed: num(r.committed),
    remaining: num(r.remaining),
    projects: num(r.projects)
  }))
}
