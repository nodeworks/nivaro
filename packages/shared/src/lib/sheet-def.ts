/**
 * The pure part of opening a query sheet: which tabs it has, which tab opens
 * first, and the optional header strip (a query of its own, rendered above
 * the tabs as stat tiles). `resolveConfig` is the caller's token resolver —
 * '$row.' / '$param.' / '$filters.' — applied to the header exactly as to a
 * tab, so the two cannot drift.
 */
/** A quiet "as of" line under the header tiles: `label` followed by the
 *  latest `field` value among the header rows (omitted when no row has one). */
export interface SheetHeaderAsOf {
  field: string
  label: string
}

export interface SheetHeaderInput {
  query_slug: string
  params?: Record<string, unknown>
  stats: unknown[]
  as_of?: SheetHeaderAsOf
  /** One quiet line under the tiles saying what they cover ("Project
   *  lifetime — every funding year"); `{{param}}` tokens read the header's
   *  resolved params. */
  note?: string
}

export interface SheetTabInput {
  label: string
  /** One quiet line above the tab's view; `{{param}}` tokens read the tab's
   *  resolved params ("Spend dated in {{funding_years}}"). */
  note?: string
  config?: Record<string, unknown>
  matrix?: { config: Record<string, unknown>; scope: Record<string, string> }
}

export interface SheetDefInput {
  config?: Record<string, unknown>
  tabs?: SheetTabInput[]
  header?: SheetHeaderInput
  initial_tab?: number
}

export interface ResolvedSheetHeader {
  config: Record<string, unknown>
  stats: unknown[]
  asOf?: SheetHeaderAsOf
  note?: string
}

export type ResolvedSheetTabInput =
  | { label: string; config: Record<string, unknown>; note?: string }
  | { label: string; matrix: { config: Record<string, unknown>; scope: Record<string, string> } }

/** `{{param}}` tokens from resolved params; a param that resolved to nothing
 *  reads as `fallback` (the query ran unfiltered on it). */
export function fillSheetNote(
  note: string,
  params: Record<string, unknown> | undefined,
  fallback = 'all'
): string {
  return note.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
    const v = params?.[k]
    if (v === null || v === undefined || v === '') return fallback
    return String(v).split(',').filter(Boolean).join(', ')
  })
}

export function resolveSheetDef(
  def: SheetDefInput,
  resolveConfig: (cfg: Record<string, unknown>) => Record<string, unknown>
): {
  resolvedTabs: ResolvedSheetTabInput[]
  header: ResolvedSheetHeader | null
  initialTab: number
} {
  const rawTabs = def.tabs ?? (def.config ? [{ label: 'View', config: def.config }] : [])
  const resolvedTabs: ResolvedSheetTabInput[] = rawTabs.map((t) => {
    if (t.matrix) return { label: t.label, matrix: t.matrix }
    const config = resolveConfig(t.config ?? {})
    const params = config.params as Record<string, unknown> | undefined
    return { label: t.label, config, ...(t.note ? { note: fillSheetNote(t.note, params) } : {}) }
  })
  let header: ResolvedSheetHeader | null = null
  if (def.header) {
    const config = resolveConfig({
      query_slug: def.header.query_slug,
      params: def.header.params ?? {}
    })
    const params = config.params as Record<string, unknown> | undefined
    header = {
      config,
      stats: def.header.stats,
      ...(def.header.as_of ? { asOf: def.header.as_of } : {}),
      ...(def.header.note ? { note: fillSheetNote(def.header.note, params) } : {})
    }
  }
  const wanted = Number.isInteger(def.initial_tab) ? (def.initial_tab as number) : 0
  const initialTab = wanted >= 0 && wanted < resolvedTabs.length ? wanted : 0
  return { resolvedTabs, header, initialTab }
}

/** The latest value of `field` among the rows (ISO date strings and Dates
 *  compare by time), or null when no row carries one. */
export function latestAsOf(
  rows: Array<Record<string, unknown>>,
  field: string
): string | Date | null {
  let best: { at: number; raw: string | Date } | null = null
  for (const r of rows) {
    const v = r[field]
    if (v == null || v === '') continue
    const raw = v instanceof Date ? v : String(v)
    const at = new Date(raw).getTime()
    if (Number.isNaN(at)) continue
    if (!best || at > best.at) best = { at, raw }
  }
  return best?.raw ?? null
}
