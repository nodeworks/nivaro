/**
 * Pure helpers for the Heat tab (#1364): where a click cell sits on the
 * overlay, how intense it draws, and the scroll-depth "reached" curve.
 * Matches the server fold (api/src/services/session-replay-heat.ts):
 * positions are 2% buckets of the viewport (0–49), scroll depth is quarter
 * viewport heights (4 = the first screen only).
 */

export const BUCKETS = 50
export const DEPTH_STEPS_PER_SCREEN = 4

export interface HeatCellIn {
  x: number
  y: number
  count: number
}

export interface HeatDot {
  cx: number
  cy: number
  /** 0–1, relative to the busiest cell. */
  weight: number
  count: number
}

/** Cell centres in canvas pixels, weighted by the busiest cell (square root, so one hot spot does not blank the rest). */
export function heatDots(cells: HeatCellIn[], width: number, height: number): HeatDot[] {
  const max = cells.reduce((m, c) => Math.max(m, c.count), 0)
  if (max <= 0 || width <= 0 || height <= 0) return []
  return cells
    .filter((c) => c.count > 0)
    .map((c) => ({
      cx: ((c.x + 0.5) / BUCKETS) * width,
      cy: ((c.y + 0.5) / BUCKETS) * height,
      weight: Math.sqrt(c.count / max),
      count: c.count
    }))
}

/** The cell under a pointer at (px, py) on a canvas of the given size, or null. */
export function cellAt(
  cells: HeatCellIn[],
  px: number,
  py: number,
  width: number,
  height: number
): HeatCellIn | null {
  if (width <= 0 || height <= 0) return null
  const x = Math.floor((px / width) * BUCKETS)
  const y = Math.floor((py / height) * BUCKETS)
  return cells.find((c) => c.x === x && c.y === y) ?? null
}

/** "1 screen", "1.5 screens" for a depth bucket. */
export function depthLabel(bucket: number): string {
  const screens = bucket / DEPTH_STEPS_PER_SCREEN
  const n = Number.isInteger(screens) ? String(screens) : screens.toFixed(2).replace(/0$/, '')
  return `${n} screen${screens === 1 ? '' : 's'}`
}

/**
 * Share of visits that reached AT LEAST each depth, one row per screen
 * (1, 2, 3 … up to the deepest), which reads better than the raw spread.
 */
export function reachCurve(
  scroll: Array<{ depth: number; visits: number }>
): Array<{ screens: number; reached: number; share: number }> {
  const total = scroll.reduce((s, r) => s + r.visits, 0)
  if (total === 0) return []
  const deepest = scroll.reduce((m, r) => Math.max(m, r.depth), 0)
  const maxScreens = Math.max(1, Math.ceil(deepest / DEPTH_STEPS_PER_SCREEN))
  const out: Array<{ screens: number; reached: number; share: number }> = []
  for (let s = 1; s <= maxScreens; s++) {
    const reached = scroll
      .filter((r) => r.depth >= s * DEPTH_STEPS_PER_SCREEN)
      .reduce((n, r) => n + r.visits, 0)
    out.push({ screens: s, reached, share: reached / total })
  }
  return out
}

/** Last N UTC days as YYYY-MM-DD, inclusive of today. */
export function lastDays(n: number, now = Date.now()): { from: string; to: string } {
  const to = new Date(now).toISOString().slice(0, 10)
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (n - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10)
  return { from, to }
}

export const VIEWPORT_LABELS: Record<string, string> = {
  xs: 'Phone (<640)',
  sm: 'Small (<1024)',
  md: 'Laptop (<1440)',
  lg: 'Desktop (<1920)',
  xl: 'Wide (1920+)'
}
