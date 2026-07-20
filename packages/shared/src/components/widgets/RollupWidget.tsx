import { ChevronRight } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { formatValue, type ReviewListColumnFormat, STATUS_COLOR_HEX } from './ReviewListWidget'

// ─── Types ──────────────────────────────────────────────────────────────────
// Duplicated locally from api/src/services/rollup.ts (RollupConfig /
// RollupResult) per the plan's "no api import" rule — the shared package
// never depends on the api workspace.

export type RollupMeasureFormat = 'currency' | 'number'

export interface RollupLevel {
  field: string
  label?: string
}

export interface RollupMeasureFilter {
  field: string
  op: 'eq' | 'neq' | 'nnull'
  value?: unknown
}

export interface RollupMeasure {
  key: string
  label: string
  sum: string
  format?: RollupMeasureFormat
  filter?: RollupMeasureFilter[]
}

export interface RollupLeafColumnSpec {
  field: string
  label?: string
  format?: ReviewListColumnFormat
  color?: string
}

export interface RollupConfig {
  host_collection: string
  collection: string
  path: Array<{ kind: 'm2o' | 'm2m'; field: string }>
  static_filter?: Array<{ field: string; op: 'eq' | 'neq' | 'nnull'; value?: unknown }>
  levels: RollupLevel[]
  leaf_columns?: Array<string | RollupLeafColumnSpec>
  merge_leaf_by?: string[]
  measures: RollupMeasure[]
  show_totals?: boolean
}

export interface RollupRow {
  id: string | number
  levels: unknown[]
  level_labels: Array<string | null>
  values: Record<string, unknown>
  measures: Record<string, number>
}

export interface RollupResult {
  rows: RollupRow[]
  columns: {
    levels: Array<{ field: string; label: string }>
    leaf_columns: Array<{
      field: string
      label: string
      format: ReviewListColumnFormat | null
      color: string | null
    }>
    measures: Array<{ key: string; label: string; format: RollupMeasureFormat | null }>
  }
  truncated: boolean
}

// Bit/boolean columns arrive as true/1/'1'/'true' depending on driver and
// dialect — normalize for flag rendering (mirrors ReviewListWidget's isTruthyFlag).
function isTruthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

function FlagBadge({ label, color }: { label: string; color: string | null | undefined }) {
  const hex = color ? (STATUS_COLOR_HEX[color] ?? null) : null
  return (
    <span
      className='inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium'
      style={{
        backgroundColor: hex ? `${hex}22` : '#f1f5f9',
        color: hex ?? '#475569',
        border: `1px solid ${hex ? `${hex}44` : '#e2e8f0'}`
      }}
    >
      {label}
    </span>
  )
}

// ─── Tree building (pure, unit-tested) ─────────────────────────────────────
// Groups rows by levels[0] then levels[1] (client renders at most two band
// levels + leaf rows, per the design's client section — levels beyond that
// are out of scope). merge_leaf_by collapses leaves equal on every listed
// field (level fields compared by raw level value, leaf fields by
// values[field]) and sums their measures. A "total" measure (sum of all
// configured measures) is appended at every node, including the grand total.

export interface RollupTreeLeaf {
  ids: Array<string | number>
  values: Record<string, unknown>
  measures: Record<string, number>
}

export interface RollupTreeNode {
  key: string
  label: string
  measures: Record<string, number>
  /** Present when config.levels.length >= 2 (this is a level-1 node with level-2 children). */
  bands?: RollupTreeNode[]
  /** Present when this node holds leaf rows directly (level-2 nodes, or level-1 nodes when levels.length === 1). */
  leaves?: RollupTreeLeaf[]
}

export interface RollupTree {
  bands: RollupTreeNode[]
  grandTotal: Record<string, number>
}

function bandKey(raw: unknown): string {
  return String(raw ?? '')
}

function bandLabel(raw: unknown, label: string | null | undefined): string {
  if (label) return label
  if (raw == null || raw === '') return '—'
  return String(raw)
}

function emptyMeasures(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of keys) out[k] = 0
  return out
}

function addMeasures(
  target: Record<string, number>,
  source: Record<string, number>,
  keys: string[]
) {
  for (const k of keys) target[k] = (target[k] ?? 0) + (source[k] ?? 0)
}

function rowMeasuresWithTotal(row: RollupRow, measureKeys: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  let total = 0
  for (const k of measureKeys) {
    const v = row.measures[k] ?? 0
    out[k] = v
    total += v
  }
  out.total = total
  return out
}

function mergeFieldValue(row: RollupRow, field: string, levelFields: string[]): unknown {
  const levelIdx = levelFields.indexOf(field)
  if (levelIdx !== -1) return row.levels[levelIdx]
  return row.values[field]
}

function buildLeaves(
  rows: RollupRow[],
  config: RollupConfig,
  measureKeys: string[],
  allMeasureKeys: string[]
): RollupTreeLeaf[] {
  const levelFields = config.levels.map((l) => l.field)
  const mergeBy = config.merge_leaf_by
  if (!mergeBy || mergeBy.length === 0) {
    return rows.map((row) => ({
      ids: [row.id],
      values: row.values,
      measures: rowMeasuresWithTotal(row, measureKeys)
    }))
  }
  const groups = new Map<string, RollupRow[]>()
  for (const row of rows) {
    const key = mergeBy.map((f) => String(mergeFieldValue(row, f, levelFields) ?? '')).join('|')
    const existing = groups.get(key)
    if (existing) existing.push(row)
    else groups.set(key, [row])
  }
  return Array.from(groups.values()).map((groupRows) => {
    const measures = emptyMeasures(allMeasureKeys)
    for (const row of groupRows) {
      addMeasures(measures, rowMeasuresWithTotal(row, measureKeys), allMeasureKeys)
    }
    return {
      ids: groupRows.map((r) => r.id),
      values: groupRows[0].values,
      measures
    }
  })
}

export function buildRollupTree(rows: RollupRow[], config: RollupConfig): RollupTree {
  const measureKeys = config.measures.map((m) => m.key)
  const allMeasureKeys = [...measureKeys, 'total']
  const grandTotal = emptyMeasures(allMeasureKeys)

  if (rows.length === 0) return { bands: [], grandTotal }

  const hasLevel2 = config.levels.length >= 2

  const level1Map = new Map<string, { label: string; rows: RollupRow[] }>()
  for (const row of rows) {
    const key = bandKey(row.levels[0])
    const label = bandLabel(row.levels[0], row.level_labels[0])
    const existing = level1Map.get(key)
    if (existing) existing.rows.push(row)
    else level1Map.set(key, { label, rows: [row] })
  }

  const bands: RollupTreeNode[] = Array.from(level1Map.entries())
    .map(([key, { label, rows: l1rows }]) => {
      const measures = emptyMeasures(allMeasureKeys)

      if (hasLevel2) {
        const level2Map = new Map<string, { label: string; rows: RollupRow[] }>()
        for (const row of l1rows) {
          const k2 = bandKey(row.levels[1])
          const l2 = bandLabel(row.levels[1], row.level_labels[1])
          const existing = level2Map.get(k2)
          if (existing) existing.rows.push(row)
          else level2Map.set(k2, { label: l2, rows: [row] })
        }
        const bands2: RollupTreeNode[] = Array.from(level2Map.entries())
          .map(([k2, { label: l2, rows: l2rows }]) => {
            const leaves = buildLeaves(l2rows, config, measureKeys, allMeasureKeys)
            const m2 = emptyMeasures(allMeasureKeys)
            for (const leaf of leaves) addMeasures(m2, leaf.measures, allMeasureKeys)
            return { key: k2, label: l2, measures: m2, leaves }
          })
          .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
        for (const b2 of bands2) addMeasures(measures, b2.measures, allMeasureKeys)
        return { key, label, measures, bands: bands2 } as RollupTreeNode
      }

      const leaves = buildLeaves(l1rows, config, measureKeys, allMeasureKeys)
      for (const leaf of leaves) addMeasures(measures, leaf.measures, allMeasureKeys)
      return { key, label, measures, leaves } as RollupTreeNode
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))

  for (const band of bands) addMeasures(grandTotal, band.measures, allMeasureKeys)

  return { bands, grandTotal }
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface RollupWidgetProps {
  data: RollupResult | null
  config: RollupConfig
  loading?: boolean
  error?: string | null
}

export function RollupWidget({ data, config, loading, error }: RollupWidgetProps) {
  const [collapsedL1, setCollapsedL1] = useState<Set<string>>(() => new Set())
  const [expandedL2, setExpandedL2] = useState<Set<string>>(() => new Set())

  const tree = useMemo(() => (data ? buildRollupTree(data.rows, config) : null), [data, config])

  if (loading) {
    return (
      <div className='space-y-2'>
        {[0, 1].map((i) => (
          <div key={i} className='animate-pulse h-12 rounded-md bg-slate-100 dark:bg-slate-800' />
        ))}
      </div>
    )
  }

  if (error) {
    return <p className='text-[12px] text-red-500'>{error}</p>
  }

  if (!data || data.rows.length === 0 || !tree) {
    return <p className='text-[12px] text-slate-400'>No rows</p>
  }

  const toggleL1 = (key: string) => {
    setCollapsedL1((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const toggleL2 = (key: string) => {
    setExpandedL2((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const leafCols = data.columns.leaf_columns
  const leafColSpan = Math.max(leafCols.length, 1)
  const totalFormat: RollupMeasureFormat = data.columns.measures.every(
    (m) => m.format === 'currency'
  )
    ? 'currency'
    : 'number'
  const measureCols: Array<{ key: string; label: string; format: RollupMeasureFormat | null }> = [
    ...data.columns.measures,
    { key: 'total', label: 'Total', format: totalFormat }
  ]

  function renderBandRow(
    node: RollupTreeNode,
    level: 1 | 2,
    isOpen: boolean,
    onToggle: () => void
  ) {
    return (
      <tr
        key={node.key}
        className={
          level === 1
            ? 'border-b border-slate-100 bg-slate-50/60 dark:border-border/50 dark:bg-white/[0.02]'
            : 'border-b border-slate-100 dark:border-border/50'
        }
      >
        <td colSpan={leafColSpan} className='px-2.5 py-1.5'>
          <button
            type='button'
            onClick={onToggle}
            className='flex items-center gap-1.5 text-left'
            style={{ paddingLeft: level === 1 ? 0 : 16 }}
          >
            <ChevronRight
              className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
            />
            <span
              className={
                level === 1
                  ? 'font-medium text-slate-700 dark:text-slate-200'
                  : 'text-slate-600 dark:text-slate-300'
              }
            >
              {node.label}
            </span>
          </button>
        </td>
        {measureCols.map((c) => (
          <td
            key={c.key}
            className={`px-2.5 py-1.5 text-right tabular-nums ${
              level === 1
                ? 'font-medium text-slate-700 dark:text-slate-200'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            {formatValue(node.measures[c.key], c.format ?? 'number')}
          </td>
        ))}
      </tr>
    )
  }

  function renderLeafRow(leaf: RollupTreeLeaf, indentPx: number) {
    return (
      <tr
        key={String(leaf.ids[0])}
        className='border-b border-slate-100 last:border-b-0 dark:border-border/50'
      >
        {leafCols.length > 0 ? (
          leafCols.map((c, i) => (
            <td
              key={c.field}
              className='px-2.5 py-1.5 text-slate-600 dark:text-slate-300'
              style={i === 0 ? { paddingLeft: indentPx } : undefined}
            >
              {c.format === 'flag' ? (
                isTruthyFlag(leaf.values[c.field]) ? (
                  <FlagBadge label={c.label} color={c.color ?? 'amber'} />
                ) : (
                  '—'
                )
              ) : (
                formatValue(leaf.values[c.field], c.format)
              )}
            </td>
          ))
        ) : (
          <td className='px-2.5 py-1.5 text-slate-400' style={{ paddingLeft: indentPx }}>
            —
          </td>
        )}
        {measureCols.map((c) => (
          <td
            key={c.key}
            className='px-2.5 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300'
          >
            {formatValue(leaf.measures[c.key], c.format ?? 'number')}
          </td>
        ))}
      </tr>
    )
  }

  return (
    <div className='space-y-2'>
      {data.truncated && (
        <p className='text-[11px] text-amber-600 dark:text-amber-400'>
          Showing first 2000 rows — some rows may be missing.
        </p>
      )}
      {config.show_totals && (
        <div className='flex items-stretch divide-x divide-slate-200 rounded-md border border-slate-200 bg-slate-50/60 dark:divide-border dark:border-border dark:bg-white/[0.02]'>
          {measureCols.map((c) => (
            <div key={c.key} className='flex flex-col justify-center px-3 py-2 min-w-0'>
              <span className='text-[10px] font-medium leading-none text-slate-400 dark:text-slate-500'>
                {c.label}
              </span>
              <span className='mt-1 text-[13px] font-semibold tabular-nums leading-none text-slate-900 dark:text-slate-100'>
                {formatValue(tree.grandTotal[c.key], c.format ?? 'number')}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
        <table className='w-full border-collapse text-[12px]'>
          <thead>
            <tr className='border-b border-slate-200 bg-slate-50/60 text-left text-[11px] font-medium text-slate-400 dark:border-border dark:bg-white/[0.02]'>
              {leafCols.length > 0 ? (
                leafCols.map((c) => (
                  <th key={c.field} className='px-2.5 py-1.5 font-medium'>
                    {c.label}
                  </th>
                ))
              ) : (
                <th className='px-2.5 py-1.5 font-medium'>Group</th>
              )}
              {measureCols.map((c) => (
                <th key={c.key} className='px-2.5 py-1.5 text-right font-medium'>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tree.bands.map((band) => {
              const isOpen1 = !collapsedL1.has(band.key)
              return (
                <Fragment key={band.key}>
                  {renderBandRow(band, 1, isOpen1, () => toggleL1(band.key))}
                  {isOpen1 &&
                    (band.bands
                      ? band.bands.map((b2) => {
                          const l2Key = `${band.key}|${b2.key}`
                          const isOpen2 = expandedL2.has(l2Key)
                          return (
                            <Fragment key={l2Key}>
                              {renderBandRow(b2, 2, isOpen2, () => toggleL2(l2Key))}
                              {isOpen2 && (b2.leaves ?? []).map((leaf) => renderLeafRow(leaf, 40))}
                            </Fragment>
                          )
                        })
                      : (band.leaves ?? []).map((leaf) => renderLeafRow(leaf, 24)))}
                </Fragment>
              )
            })}
            {config.show_totals && (
              <tr className='border-t-2 border-slate-200 bg-slate-50 dark:border-border dark:bg-white/[0.04]'>
                <td
                  colSpan={leafColSpan}
                  className='px-2.5 py-1.5 font-semibold text-slate-700 dark:text-slate-200'
                >
                  Total
                </td>
                {measureCols.map((c) => (
                  <td
                    key={c.key}
                    className='px-2.5 py-1.5 text-right font-semibold tabular-nums text-slate-700 dark:text-slate-200'
                  >
                    {formatValue(tree.grandTotal[c.key], c.format ?? 'number')}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
