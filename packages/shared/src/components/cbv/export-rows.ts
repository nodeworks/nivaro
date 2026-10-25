/**
 * The list's "Export → CSV" reads: every matching row, page by page, and the
 * related values the table shows, resolved in chunks.
 *
 * It used to ask for 2,000 rows in one read (the server serves 1,000 at most),
 * resolve related columns for the first 500 ids only (rows 501+ exported blank
 * Zone / Project / Region), and write plain M2O columns as raw ids and user
 * UUIDs where the table shows labels.
 */

type Row = Record<string, unknown>

/** The most rows one /items list read returns (api services/items.ts). */
export const EXPORT_PAGE_ROWS = 1000
/** Stated ceiling of one CSV export — past it the file says so. */
export const EXPORT_MAX_ROWS = 50_000
/** GET /items/:collection/resolve-paths caps: ids and paths per call. */
export const RESOLVE_IDS_PER_CALL = 500
export const RESOLVE_PATHS_PER_CALL = 20

export interface ListPage {
  data?: Row[]
  /** GET /items: the limit actually served when the ask was over the cap. */
  applied_limit?: number
  meta?: { limit?: number }
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** A sort that pages stably: `id` breaks ties, never named twice (error 169). */
export function stableSort(sort: string | null | undefined): string {
  const parts = (sort ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!parts.some((p) => p.replace(/^-/, '') === 'id')) parts.push('id')
  return parts.join(',')
}

/**
 * Every row `fetchPage` serves, up to `max`. A page is the last one only when
 * it holds fewer rows than the server applied (`applied_limit` / `meta.limit`,
 * else the limit asked). `truncated` = rows remain past `max`.
 */
export async function readExportRows(
  fetchPage: (offset: number, limit: number) => Promise<ListPage>,
  max = EXPORT_MAX_ROWS
): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = []
  while (rows.length < max) {
    const asked = Math.min(EXPORT_PAGE_ROWS, max - rows.length)
    const page = await fetchPage(rows.length, asked)
    const data = page.data ?? []
    rows.push(...data)
    const served = Math.min(page.meta?.limit ?? page.applied_limit ?? asked, asked)
    if (data.length === 0 || data.length < served) return { rows, truncated: false }
  }
  // Exactly `max` rows read: one more row says whether anything was left out.
  const probe = await fetchPage(rows.length, 1)
  return { rows: rows.slice(0, max), truncated: (probe.data ?? []).length > 0 }
}

export type ResolvedRows = Record<string, Record<string, { value: string }>>

/** resolve-paths over every id and path, chunked to its caps; a failed chunk stays blank. */
export async function resolveAllPaths(
  ids: string[],
  paths: string[],
  fetchChunk: (ids: string[], paths: string[]) => Promise<ResolvedRows>,
  concurrency = 3
): Promise<ResolvedRows> {
  const out: ResolvedRows = {}
  if (ids.length === 0 || paths.length === 0) return out
  const jobs: Array<[string[], string[]]> = []
  for (const idChunk of chunk(ids, RESOLVE_IDS_PER_CALL))
    for (const pathChunk of chunk(paths, RESOLVE_PATHS_PER_CALL)) jobs.push([idChunk, pathChunk])
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const [idChunk, pathChunk] = jobs[next++]
      const rows = await fetchChunk(idChunk, pathChunk).catch(() => ({}) as ResolvedRows)
      for (const [id, byPath] of Object.entries(rows)) out[id] = { ...out[id], ...byPath }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
  return out
}

/** A plain M2O column's label as the table renders it: the target's display template. */
export interface M2OLabelSpec {
  column: string
  /** Target display template (`{{name}} ({{code}})`), or null. */
  template: string | null
  /** Label field when there is no template (labelFieldFor). */
  labelField: string
}

/** The resolve paths one M2O label needs (`vendor.name`, `vendor.code`). */
export function m2oLabelPaths(spec: M2OLabelSpec): string[] {
  const tokens = spec.template
    ? [...spec.template.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1])
    : [spec.labelField]
  return [...new Set(tokens)].map((t) => `${spec.column}.${t}`)
}

/** The label for one row from resolved paths; '' when the row has no value. */
export function m2oLabel(
  spec: M2OLabelSpec,
  resolved: Record<string, { value: string }> | undefined
): string {
  const at = (t: string) => resolved?.[`${spec.column}.${t}`]?.value ?? ''
  if (!spec.template) return at(spec.labelField)
  return spec.template.replace(/\{\{([\w.]+)\}\}/g, (_, t: string) => at(t))
}

/** "Ann Lee" from a user card, else the email, else the id. */
export function userLabel(
  card: { first_name?: string | null; last_name?: string | null; email?: string | null } | null,
  id: unknown
): string {
  if (!card) return id == null ? '' : String(id)
  return (
    [card.first_name, card.last_name].filter(Boolean).join(' ') || card.email || String(id ?? '')
  )
}

/** Today as YYYY-MM-DD on the viewer's calendar (toISOString is the UTC day). */
export function localYmd(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
