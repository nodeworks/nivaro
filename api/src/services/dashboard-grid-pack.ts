/**
 * Placing widgets on the dashboard grid (#2736): the 4-column grid the
 * dashboard builder draws (nivaro_dashboard_widgets col/row/width/height).
 * First fit, in the order given — each widget takes the highest, then
 * left-most, free spot of its size — so a drafted dashboard reads top to
 * bottom in the order it was described and never overlaps.
 */

export const DASHBOARD_GRID_COLUMNS = 4

export interface GridSize {
  width: number
  height: number
}

export interface GridPlacement extends GridSize {
  col: number
  row: number
}

/** The size a widget type takes when the draft does not say (KPIs 1x1, the rest 2x2). */
export function defaultWidgetSize(type: string, grouped = true): GridSize {
  if (type === 'count' || type === 'sum' || type === 'avg' || type === 'saved_view')
    return { width: 1, height: 1 }
  if (type === 'ai_query' && !grouped) return { width: 1, height: 1 }
  return { width: 2, height: 2 }
}

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

/** Pack `sizes` onto the grid; returns one placement per input, in order. */
export function packDashboardGrid(
  sizes: Array<Partial<GridSize>>,
  columns = DASHBOARD_GRID_COLUMNS
): GridPlacement[] {
  const taken = new Set<string>()
  const free = (col: number, row: number, w: number, h: number) => {
    if (col + w > columns) return false
    for (let r = row; r < row + h; r++)
      for (let c = col; c < col + w; c++) if (taken.has(`${c}:${r}`)) return false
    return true
  }
  const out: GridPlacement[] = []
  for (const s of sizes) {
    const width = clamp(s.width, 1, columns, 1)
    const height = clamp(s.height, 1, 4, 1)
    let placed: GridPlacement | null = null
    for (let row = 0; !placed; row++) {
      for (let col = 0; col + width <= columns; col++) {
        if (free(col, row, width, height)) {
          placed = { col, row, width, height }
          break
        }
      }
    }
    for (let r = placed.row; r < placed.row + height; r++)
      for (let c = placed.col; c < placed.col + width; c++) taken.add(`${c}:${r}`)
    out.push(placed)
  }
  return out
}
