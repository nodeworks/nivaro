/** Grouped tree over flat report rows (display 'tree' on a query widget).
 *  Rows are grouped by `levels`, series fields sum at every level and `pct`
 *  is a weighted ratio num/den.
 *
 *  A missing figure is never a zero: a series sums only the rows that carry
 *  it (null when none do), and the ratio is weighted over the rows carrying
 *  BOTH operands only — a row without a numerator must not dilute the
 *  denominator. No such rows (or a non-positive denominator) = null. */

export interface ReportTreeConfig {
  levels: string[]
  badge?: string
  pct?: { num: string; den: string }
  drill?: { id_field: string }
}

export interface ReportTreeNode {
  key: string
  label: string
  depth: number
  /** null = no row in this group carries the field */
  sums: Record<string, number | null>
  /** null = no row carries both ratio operands */
  pct: number | null
  children: ReportTreeNode[]
  /** leaf only */
  badge?: string
  drillId?: string | number | null
}

/** A row's figure, or null when the row does not carry one. */
export function treeFigure(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function sumOf(rows: Array<Record<string, unknown>>, field: string): number | null {
  let total: number | null = null
  for (const r of rows) {
    const v = treeFigure(r[field])
    if (v != null) total = (total ?? 0) + v
  }
  return total
}

export function treeRatio(
  rows: Array<Record<string, unknown>>,
  pct: { num: string; den: string } | undefined
): number | null {
  if (!pct) return null
  let num = 0
  let den = 0
  let carrying = 0
  for (const r of rows) {
    const n = treeFigure(r[pct.num])
    const d = treeFigure(r[pct.den])
    if (n == null || d == null) continue
    num += n
    den += d
    carrying++
  }
  if (carrying === 0 || den <= 0) return null
  return Math.round((num / den) * 1000) / 10
}

export function buildReportTree(
  rows: Array<Record<string, unknown>>,
  cfg: ReportTreeConfig,
  seriesFields: string[]
): ReportTreeNode[] {
  const make = (
    slice: Array<Record<string, unknown>>,
    depth: number,
    prefix: string
  ): ReportTreeNode[] => {
    const field = cfg.levels[depth]
    const last = depth === cfg.levels.length - 1
    const groups = new Map<string, Array<Record<string, unknown>>>()
    for (const r of slice) {
      const k = String(r[field] ?? 'Unknown')
      const g = groups.get(k) ?? []
      g.push(r)
      groups.set(k, g)
    }
    const nodes = [...groups.entries()].map(([label, g]) => {
      const sums: Record<string, number | null> = {}
      for (const f of seriesFields) sums[f] = sumOf(g, f)
      const node: ReportTreeNode = {
        key: `${prefix}/${label}`,
        label,
        depth,
        sums,
        pct: treeRatio(g, cfg.pct),
        children: last ? [] : make(g, depth + 1, `${prefix}/${label}`)
      }
      if (last) {
        const row = g[0]
        if (cfg.badge) node.badge = String(row[cfg.badge] ?? '')
        if (cfg.drill) node.drillId = row[cfg.drill.id_field] as string | number | null
      }
      return node
    })
    // Ordering: top level alphabetical, deeper levels by first value desc
    // (groups without the figure last).
    if (depth === 0) nodes.sort((a, b) => a.label.localeCompare(b.label))
    else {
      const f = seriesFields[0]
      nodes.sort((a, b) => {
        const av = a.sums[f] ?? null
        const bv = b.sums[f] ?? null
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        return bv - av
      })
    }
    return nodes
  }
  return make(rows, 0, '')
}
