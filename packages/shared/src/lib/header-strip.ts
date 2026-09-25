/**
 * The record sub-header ("stat band") — one vocabulary for every cell in
 * it, whether the cell is a layout field, a widget figure, the owners
 * avatars or the Integrations dock, so the band reads as ONE instrument
 * panel rather than four components that happen to share a row.
 *
 * Shape (Rob 2026-09-24, "looks terrible on larger screens, so sprawled
 * out"): tiles no longer stretch to fill the window. Each grows from its
 * content up to a cap, so a wide screen shows a compact, evenly-weighted
 * cluster on the left and the status dock (owners, Integrations) pinned
 * right, with quiet space between — the way a well-set dashboard header
 * sits — instead of six labels marooned 300px apart. On a narrow window
 * whole tiles wrap; the hairlines (each tile draws its own top + left,
 * the band clips the outer ones) stay continuous either way.
 *
 * Type: DM Sans; labels are small caps-style (uppercase, tracked, muted),
 * values 13px semibold with tabular figures so money and ids align.
 */

/** The band itself — hairline above and below, the page gutter. */
export const HEADER_BAND =
  'shrink-0 border-y border-slate-200/90 bg-white dark:border-border dark:bg-card'

/** Row inside the band: the wrapping tile group on the left, the status
 *  dock as a full-height column on the right from `lg` up; below that the
 *  dock drops under the tiles as a bottom shelf (a 200px column beside
 *  four ragged rows of tiles was the one thing that failed "completely
 *  responsive"). Clips the outer hairlines. */
// The first tile's text sits on the form body's first field label (page
// gutter 24 + card padding 20 + card border 1 − tile padding 16 = 29), not
// on the title above — the band belongs to the record body it introduces
// (Rob 2026-09-24).
// `max-lg:` rather than `flex-col lg:flex-row`: a host app's own Tailwind
// build ships `.flex-col` after this package's stylesheet, and an equal-
// specificity base utility loaded later beats the media variant.
export const HEADER_ROW = 'flex items-stretch overflow-hidden pr-4 pl-[29px]'

/** The tiles — wrap as whole cells; the dock never joins the wrap. */
export const HEADER_TILES =
  'flex min-w-0 flex-1 flex-wrap content-start items-stretch overflow-hidden'

/**
 * DENSE format (Rob 2026-09-24: "if the line DOES break, format it in a
 * completely different way that saves space"). When the stacked tiles
 * would not fit their row, the band sets `data-header-dense` and every
 * cell turns into one 34px line — label · value side by side — wrapping
 * as chips: a break then costs ~64px, not 106, and three rows on a laptop
 * ~100px, not 156. Pure CSS off one attribute, so widget figures, the
 * owners avatars and the summary chip all follow without prop threading.
 * Tailwind arbitrary variant: `[[data-header-dense]_&]:x` = `x` when an
 * ancestor carries the attribute.
 */
export const HEADER_CELL_DENSE =
  '[[data-header-dense]_&]:min-h-[34px] [[data-header-dense]_&]:flex-row [[data-header-dense]_&]:items-center [[data-header-dense]_&]:gap-x-2 [[data-header-dense]_&]:pr-3 [[data-header-dense]_&]:pl-4 [[data-header-dense]_&]:pt-[7px] [[data-header-dense]_&]:pb-[7px] [[data-header-dense]_&]:max-w-none'

/**
 * LIST format: the "+N more" popover (HeaderOverflowChip) sets
 * `data-header-list`; a tile there becomes one 32px row, label left,
 * value right, no hairlines — "the rest of this record's properties".
 */
export const HEADER_CELL_LIST =
  '[[data-header-list]_&]:h-8 [[data-header-list]_&]:min-h-0 [[data-header-list]_&]:w-full [[data-header-list]_&]:max-w-none [[data-header-list]_&]:flex-row [[data-header-list]_&]:items-center [[data-header-list]_&]:justify-between [[data-header-list]_&]:gap-x-6 [[data-header-list]_&]:rounded-sm [[data-header-list]_&]:px-2 [[data-header-list]_&]:py-0 [[data-header-list]_&]:shadow-none'

/** One cell: exactly content-wide (never grows — the quiet space to the
 *  right of the cluster is the point), a floor for rhythm on short values,
 *  none for an empty one, a cap as the truncation guard. Draws its own
 *  left + BOTTOM hairline: the row under a wrapped first row is then drawn
 *  by that row's own tiles across the whole populated width, and the
 *  container clips the last row's line so the band border takes over. */
export const HEADER_TILE = `group relative flex min-h-[52px] min-w-[96px] max-w-[264px] flex-none flex-col justify-start gap-1 px-4 pt-[9px] pb-2 shadow-[-1px_1px_0_0_#e2e8f0] data-[empty=true]:min-w-0 data-[empty=true]:px-3 data-[empty=true]:opacity-60 dark:shadow-[-1px_1px_0_0_hsl(var(--border))] ${HEADER_CELL_DENSE} ${HEADER_CELL_LIST}`

/** A money / count figure: same 13px as everything else (Rob, 2026-09-25 —
 *  one size across the band, stacked or dense), set apart by weight,
 *  tabular figures and tighter tracking rather than size. */
export const HEADER_VALUE_HERO =
  'truncate text-[13px] font-semibold leading-tight tabular-nums tracking-[-0.01em] text-slate-900 dark:text-slate-100'

/** Small, tracked, muted — reads as a caption over the figure. */
export const HEADER_LABEL =
  'truncate text-[10px] font-semibold uppercase leading-none tracking-[0.07em] text-slate-400 dark:text-slate-500 [[data-header-dense]_&]:shrink-0 [[data-header-list]_&]:shrink-0'

/** The figure: 13px semibold, tabular numerals, one line. */
export const HEADER_VALUE =
  'truncate text-[13px] font-semibold leading-tight tabular-nums text-slate-900 dark:text-slate-100'

/** The status dock (Integrations chip): one hairline, no tint — a tinted
 *  well made the quiet space beside it read as a gap. Left hairline as a
 *  column (≥lg), top hairline as a shelf (the tile group clips the last
 *  row's own bottom line). */
// `[&[data-header-dock]]` / `[&[data-header-tail]]`: attribute-qualified so
// the rule outranks the host app's own `.flex` / `.hidden`, which load after
// this stylesheet (docs/claude/gotchas.md — Tailwind cascade).
export const HEADER_DOCK =
  'flex shrink-0 items-stretch self-stretch max-lg:[&[data-header-dock]]:hidden shadow-[-1px_0_0_0_#e2e8f0] dark:shadow-[-1px_0_0_0_hsl(var(--border))]'

/** Below lg the dock's chip sits at the right end of the tile group's last
 *  row instead (`data-header-tail`): the band never grows a third shelf. */
export const HEADER_DOCK_INLINE =
  'ml-auto hidden items-center self-center py-1 pr-0 pl-4 max-lg:[&[data-header-tail]]:flex'

/** A cell inside the dock (no cap — a chip is as wide as its partners). */
export const HEADER_DOCK_CELL = 'flex min-h-[40px] items-center gap-3 py-2 pr-4 pl-5'

/** A figure's provenance / sub-clause (Σ = 27,024 − 7,333.87; "across 7
 *  lines"): sits on the value's baseline, one step quieter. */
export const HEADER_SUB =
  'text-[11px] font-medium leading-none tabular-nums text-slate-400 dark:text-slate-500 [[data-header-dense]_&]:hidden'

/** The value line of every tile: a fixed 20px box the value sits at the
 *  BOTTOM of, so a 13px value, a 15px hero figure and a 20px avatar pill
 *  all share one baseline across the row while every label shares one
 *  top (labels: pt-[9px] + 10px + gap 4; values: this box; 9+10+4+20+8
 *  = 51 ≤ the 52px tile). */
export const HEADER_VALUE_LINE =
  'flex h-5 items-end gap-x-1.5 [[data-header-dense]_&]:h-auto [[data-header-dense]_&]:items-center [[data-header-list]_&]:h-auto [[data-header-list]_&]:items-baseline [[data-header-list]_&]:justify-end [[data-header-list]_&]:text-right'

/**
 * Would the stacked tiles fit one row? Each cell's stacked width (widest of
 * label and value plus the stacked gutters, 96px floor for a populated
 * cell) is measured while the band IS stacked and remembered per cell
 * index in `cache`; in dense mode those remembered widths decide, because
 * the dense cell (13px hero, Σ-only explainer) is narrower than the stacked
 * one and measuring it would flip the band straight back. A cell with no
 * remembered width (its text changed while dense) gets a deliberately
 * generous estimate, so the band stays dense until it clearly fits.
 * Called from a ResizeObserver; the caller flips `data-header-dense`. A
 * little hysteresis so a width on the boundary never flickers.
 */
export function headerNeedsDense(
  group: HTMLElement,
  currentlyDense: boolean,
  cache: Map<number, number>
): boolean {
  const cells = Array.from(group.children).filter(
    (k) => !k.hasAttribute('data-header-more') && !k.hasAttribute('data-header-tail')
  )
  if (cells.length === 0) return false
  const tail = group.querySelector<HTMLElement>(':scope > [data-header-tail]')
  let needed = 0
  cells.forEach((cell, i) => {
    let w: number
    if (!currentlyDense) {
      // The rendered stacked tile IS the truth (min widths, widget tiles
      // with several figures, avatars — all included).
      w = cell.getBoundingClientRect().width
      cache.set(i, w)
    } else {
      w = cache.get(i) ?? estimateStackedWidth(cell)
    }
    needed += w
  })
  const available = group.clientWidth - (tail?.getBoundingClientRect().width ?? 0)
  return currentlyDense ? needed > available - 24 : needed > available
}

/** Generous stacked-width guess for a tile only ever seen dense. */
function estimateStackedWidth(cell: Element): number {
  const labels = cell.querySelectorAll<HTMLElement>('[data-header-label]')
  if (labels.length === 0) return cell.getBoundingClientRect().width
  let w = 0
  for (const label of labels) {
    const value = label.parentElement?.querySelector<HTMLElement>(':scope > [data-header-value]')
    const empty = label.closest('[data-empty="true"]') != null
    const content = Math.max(label.scrollWidth, (value?.scrollWidth ?? 0) * 1.16 + 40)
    w += Math.max(content + (empty ? 24 : 32), empty ? 0 : 96)
  }
  return w
}

/** The band never runs past this many rows of dense chips. */
export const HEADER_MAX_ROWS = 2

function estimateDenseWidth(cell: Element): number {
  const label = cell.querySelector<HTMLElement>('[data-header-label]')
  const value = cell.querySelector<HTMLElement>('[data-header-value]')
  if (!label) return cell.getBoundingClientRect().width
  return label.scrollWidth + (value?.scrollWidth ?? 0) + 8 + 28
}

export type FoldedCell = { index: number; label: string; empty: boolean }

/** A cell with no value: flagged `data-empty`, or showing only the dash. */
export function headerCellIsEmpty(cell: Element): boolean {
  if (cell.matches('[data-empty="true"]') || cell.querySelector('[data-empty="true"]')) return true
  const values = cell.querySelectorAll<HTMLElement>('[data-header-value]')
  return values.length > 0 && Array.from(values).every((v) => v.textContent?.trim() === '—')
}

/**
 * Which cells the dense band must fold behind a "+N more" chip
 * (`data-header-more`, HeaderOverflowChip) to stay within HEADER_MAX_ROWS —
 * empty cells ("—") first, right to left, then populated text, then money
 * (`data-header-money`) only if still needed: data never hides behind a
 * dash, and a figure never hides behind a word. [] when everything fits.
 * Indices are cell positions among the group's children minus the chip and
 * the inline dock (`data-header-tail`, counted at the end of the row);
 * folded cells stay in the DOM in place as out-of-flow children
 * (`data-header-folded`) so the index is stable and the text can still be
 * sized. Before the band has flipped to dense the widths are estimated
 * from that text; the next observer pass measures them.
 */
export function headerFoldedCells(
  group: HTMLElement,
  denseNow: boolean,
  // Dense width per cell index, remembered from when that cell was shown.
  // Folding a cell must not change the numbers the fold was decided on —
  // measuring the folded copy (out of flow, collapsed) did, and the band
  // flickered between two and three rows.
  cache: Map<number, number>
): FoldedCell[] {
  const kids = Array.from(group.children)
  const chip = kids.find((k) => k.hasAttribute('data-header-more'))
  const tail = kids.find((k) => k.hasAttribute('data-header-tail'))
  const cells = kids.filter((k) => k !== chip && k !== tail)
  if (cells.length === 0) return []
  const widths = cells.map((c, i) => {
    if (denseNow && !c.hasAttribute('data-header-folded')) {
      const w = c.getBoundingClientRect().width
      if (w > 0) cache.set(i, w)
    }
    return cache.get(i) ?? estimateDenseWidth(c)
  })
  const available = group.clientWidth
  const chipWidth = chip ? chip.getBoundingClientRect().width : 96
  const tailWidth = tail?.getBoundingClientRect().width ?? 0
  const rowsFor = (folded: Set<number>) => {
    let rows = 1
    let x = 0
    const place = (w: number) => {
      if (x > 0 && x + w > available + 0.5) {
        rows++
        x = 0
      }
      x += w
    }
    for (let i = 0; i < widths.length; i++) if (!folded.has(i)) place(widths[i])
    if (folded.size > 0) place(chipWidth)
    if (tailWidth > 0) place(tailWidth)
    return rows
  }
  const folded = new Set<number>()
  if (rowsFor(folded) <= HEADER_MAX_ROWS) return []
  const empty = cells.map(headerCellIsEmpty)
  const money = cells.map(
    (c) => c.hasAttribute('data-header-money') || c.querySelector('[data-header-money]') != null
  )
  const idx = (keep: (i: number) => boolean) =>
    cells
      .map((_, i) => i)
      .filter(keep)
      .reverse()
  const order = [
    ...idx((i) => empty[i]),
    ...idx((i) => !empty[i] && !money[i]),
    ...idx((i) => !empty[i] && money[i])
  ]
  for (const i of order) {
    folded.add(i)
    if (rowsFor(folded) <= HEADER_MAX_ROWS) break
  }
  return [...folded]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      empty: empty[index],
      label: cells[index].querySelector('[data-header-label]')?.textContent?.trim() ?? ''
    }))
}
