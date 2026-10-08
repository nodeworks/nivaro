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
}

export interface SheetTabInput {
  label: string
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
}

export type ResolvedSheetTabInput =
  | { label: string; config: Record<string, unknown> }
  | { label: string; matrix: { config: Record<string, unknown>; scope: Record<string, string> } }

export function resolveSheetDef(
  def: SheetDefInput,
  resolveConfig: (cfg: Record<string, unknown>) => Record<string, unknown>
): {
  resolvedTabs: ResolvedSheetTabInput[]
  header: ResolvedSheetHeader | null
  initialTab: number
} {
  const rawTabs = def.tabs ?? (def.config ? [{ label: 'View', config: def.config }] : [])
  const resolvedTabs: ResolvedSheetTabInput[] = rawTabs.map((t) =>
    t.matrix
      ? { label: t.label, matrix: t.matrix }
      : { label: t.label, config: resolveConfig(t.config ?? {}) }
  )
  const header = def.header
    ? {
        config: resolveConfig({
          query_slug: def.header.query_slug,
          params: def.header.params ?? {}
        }),
        stats: def.header.stats,
        ...(def.header.as_of ? { asOf: def.header.as_of } : {})
      }
    : null
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
