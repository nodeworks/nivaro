/**
 * The pure part of opening a query sheet: which tabs it has, which tab opens
 * first, and the optional header strip (a query of its own, rendered above
 * the tabs as stat tiles). `resolveConfig` is the caller's token resolver —
 * '$row.' / '$param.' / '$filters.' — applied to the header exactly as to a
 * tab, so the two cannot drift.
 */
export interface SheetHeaderInput {
  query_slug: string
  params?: Record<string, unknown>
  stats: unknown[]
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
        stats: def.header.stats
      }
    : null
  const wanted = Number.isInteger(def.initial_tab) ? (def.initial_tab as number) : 0
  const initialTab = wanted >= 0 && wanted < resolvedTabs.length ? wanted : 0
  return { resolvedTabs, header, initialTab }
}
