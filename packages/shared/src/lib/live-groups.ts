import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { GROUP_ANCHOR_PREFIX, ROW_HOLD_MAX_MS, useListAnchors } from './live-list-flow'
import { liveMotionAllowed } from './live-preference'

/**
 * Grouped lists stay steady and follow the data (realtime round 9, item 16).
 *
 * A grouped list (collection browser "Group: …", queue worklist grouping) draws each group
 * header with its count and the group's rows below it. When someone changes the grouping
 * field of a record, the counts change in place at once and the row glides from its old group
 * to its new one — unless the person's pointer or keyboard focus rests in the list at or below
 * where something would move. Then the arrangement waits (rt2's steady-rows rule, #12): rows
 * keep their place with fresh values, a row bound for another group shows where it goes, a row
 * that left fades, new rows and groups wait. The hold ends when the pointer leaves, focus moves
 * out, or after ROW_HOLD_MAX_MS; the rows then glide to where they belong (no glide in Calm, Off
 * or with reduced motion: they simply are there).
 *
 * `planGroupHold` is the pure decision; `useSteadyGroups` wires it to the pointer/focus anchors;
 * `useRowGlide` animates rows to their new places (FLIP: measure, invert, play).
 */

export interface GroupKeys {
  key: string
  /** Row keys drawn under the header (a collapsed group draws none). */
  rows: string[]
}

export interface GroupHoldPlan {
  held: boolean
  /** The arrangement to draw (group order and row keys). */
  groups: GroupKeys[]
  /** Kept on screen only until the hold ends: no longer in this list. */
  gone: string[]
  /** Row key → the group it moves to once the hold ends. */
  moving: Map<string, string>
}

const groupSeq = (groups: GroupKeys[]) =>
  groups.flatMap((g) => [`${GROUP_ANCHOR_PREFIX}${g.key}`, ...g.rows])

/**
 * Where to draw a grouped list whose new arrangement is `next` while the person's pointer /
 * focus rests on `anchors` (row keys, or `§<group key>` for a header; the lowest on screen
 * counts). When everything at or above the anchor is the same headers and rows in the same
 * order, the new arrangement is drawn at once (changes below the pointer move nothing under
 * it). Otherwise the arrangement on screen is kept: rows stay in their groups (`moving` says
 * where each one goes), rows no longer listed stay as `gone`, new rows and groups wait.
 */
export function planGroupHold(
  shown: GroupKeys[],
  next: GroupKeys[],
  anchors: Array<string | null | undefined>
): GroupHoldPlan {
  const free: GroupHoldPlan = { held: false, groups: next, gone: [], moving: new Map() }
  const before = groupSeq(shown)
  let ai = -1
  for (const a of anchors) if (a != null) ai = Math.max(ai, before.indexOf(a))
  if (ai < 0) return free
  const after = groupSeq(next)
  let same = after.length > ai
  for (let i = 0; same && i <= ai; i++) if (before[i] !== after[i]) same = false
  if (same) return free
  const groupOf = new Map<string, string>()
  for (const g of next) for (const r of g.rows) groupOf.set(r, g.key)
  const gone: string[] = []
  const moving = new Map<string, string>()
  for (const g of shown)
    for (const r of g.rows) {
      const to = groupOf.get(r)
      if (to == null) gone.push(r)
      else if (to !== g.key) moving.set(r, to)
    }
  return {
    held: true,
    groups: shown.map((g) => ({ key: g.key, rows: [...g.rows] })),
    gone,
    moving
  }
}

/** The hint on a row bound for another group while the list holds still. */
export function movingRowTitle(toLabel: string): string {
  return `Now in ${toLabel} — it moves there when you move the pointer away`
}

export interface SteadyGroup<G, T> {
  key: string
  /** The group's current entry (counts, sums); null when it no longer exists. */
  group: G | null
  rows: T[]
}

export interface SteadyGroups<G, T> {
  groups: Array<SteadyGroup<G, T>>
  isGone: (rowKey: string) => boolean
  /** The group key a held row moves to, or null. */
  movingTo: (rowKey: string) => string | null
  holding: boolean
}

/**
 * Draw grouped rows without moving anything under the person's pointer or keyboard focus.
 * `groups` = the new arrangement (each with the rows it DRAWS — none for a collapsed group);
 * rows and headers inside `rootRef` carry `data-row-key` / `data-group-key`. `resetKey` = the
 * person's own grouping/sort/filter/collapse state: a change there is drawn at once.
 */
export function useSteadyGroups<G extends { key: string }, T>(
  groups: Array<G & { rows: T[] }>,
  keyOf: (row: T) => string,
  rootRef: React.RefObject<HTMLElement | null>,
  opts: { enabled?: boolean; resetKey?: string; maxHoldMs?: number } = {}
): SteadyGroups<G, T> {
  const enabled = opts.enabled !== false
  const shownRef = useRef<{
    groups: GroupKeys[]
    rowByKey: Map<string, T>
    groupByKey: Map<string, G>
    resetKey?: string
  }>({ groups: [], rowByKey: new Map(), groupByKey: new Map() })
  const holdingRef = useRef(false)
  const [, setTick] = useState(0)
  const anchors = useListAnchors(rootRef, enabled, () => {
    if (holdingRef.current) setTick((n) => n + 1)
  })

  const next: GroupKeys[] = groups.map((g) => ({ key: g.key, rows: g.rows.map(keyOf) }))
  const shown = shownRef.current
  const plan =
    enabled && shown.resetKey === opts.resetKey
      ? planGroupHold(shown.groups, next, anchors.current())
      : null
  const holding = !!plan?.held

  const maxHoldMs = opts.maxHoldMs ?? ROW_HOLD_MAX_MS
  useEffect(() => {
    holdingRef.current = holding
    if (!holding) return
    const t = setTimeout(() => {
      anchors.clear()
      setTick((n) => n + 1)
    }, maxHoldMs)
    return () => clearTimeout(t)
  }, [holding, maxHoldMs, anchors])

  const rowByKey = new Map<string, T>()
  const groupByKey = new Map<string, G>()
  for (const g of groups) {
    groupByKey.set(g.key, g)
    for (const r of g.rows) rowByKey.set(keyOf(r), r)
  }
  let out: Array<SteadyGroup<G, T>>
  let drawn: GroupKeys[]
  if (plan?.held) {
    drawn = plan.groups
    out = plan.groups.map((g) => ({
      key: g.key,
      group: groupByKey.get(g.key) ?? null,
      rows: g.rows
        .map((k) => rowByKey.get(k) ?? shown.rowByKey.get(k))
        .filter((r): r is T => r !== undefined)
    }))
  } else {
    drawn = next
    out = groups.map((g) => ({ key: g.key, group: g, rows: g.rows }))
  }
  // What is on screen now: the next render plans against it (rows that fade keep their data).
  useEffect(() => {
    const byKey = new Map(rowByKey)
    for (const g of drawn)
      for (const k of g.rows)
        if (!byKey.has(k) && shown.rowByKey.has(k)) byKey.set(k, shown.rowByKey.get(k) as T)
    shownRef.current = { groups: drawn, rowByKey: byKey, groupByKey, resetKey: opts.resetKey }
  })
  const gone = new Set(plan?.gone ?? [])
  const moving = plan?.moving ?? new Map<string, string>()
  return {
    groups: out,
    isGone: (k) => gone.has(k),
    movingTo: (k) => moving.get(k) ?? null,
    holding
  }
}

// ── Glide (FLIP) ──────────────────────────────────────────────────────────

/** How long a row takes to reach its new place. */
export const GLIDE_MS = 280
/** More rows than this moving at once: they simply appear in place (a big re-sort is no glide). */
export const GLIDE_MAX_ROWS = 60

/** Rows to animate: those whose top moved more than a pixel, while few enough move. */
export function glideMoves(
  before: Map<string, number>,
  after: Map<string, number>,
  max = GLIDE_MAX_ROWS
): Array<{ key: string; dy: number }> {
  const out: Array<{ key: string; dy: number }> = []
  for (const [key, top] of after) {
    const was = before.get(key)
    if (was == null) continue
    const dy = was - top
    if (Math.abs(dy) > 1) out.push({ key, dy })
  }
  return out.length > max ? [] : out
}

function measure(root: HTMLElement): Map<string, number> {
  const out = new Map<string, number>()
  const base = root.getBoundingClientRect().top
  for (const el of root.querySelectorAll<HTMLElement>('[data-row-key]')) {
    const k = el.getAttribute('data-row-key')
    if (k != null && !out.has(k)) out.set(k, el.getBoundingClientRect().top - base)
  }
  return out
}

/**
 * Glide rows to their new places when the arrangement (`signature`) changes from a live update.
 * A change of `resetKey` (the person's own sort/group/page) is drawn without a glide. Normal
 * live mode only, never with reduced motion (liveMotionAllowed).
 */
export function useRowGlide(
  rootRef: React.RefObject<HTMLElement | null>,
  signature: string,
  opts: { enabled?: boolean; resetKey?: string } = {}
): void {
  const lastRef = useRef<{ sig: string; reset?: string; tops: Map<string, number> } | null>(null)
  const enabled = opts.enabled !== false
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !enabled) {
      lastRef.current = null
      return
    }
    const last = lastRef.current
    if (last && last.sig === signature && last.reset === opts.resetKey) return
    const tops = measure(root)
    lastRef.current = { sig: signature, reset: opts.resetKey, tops }
    if (!last || last.reset !== opts.resetKey || !liveMotionAllowed()) return
    const moves = glideMoves(last.tops, tops)
    if (moves.length === 0) return
    const els: HTMLElement[] = []
    for (const { key, dy } of moves) {
      const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key
      const el = root.querySelector<HTMLElement>(`[data-row-key="${esc}"]`)
      if (!el) continue
      // A table row glides cell by cell: a transform on the <tr> leaves its pinned (sticky)
      // cells out of step with the scrolling ones, tearing the grid (rt2 review).
      const parts =
        el.tagName === 'TR' ? (Array.from(el.children) as HTMLElement[]) : [el as HTMLElement]
      for (const p of parts) {
        p.style.transition = 'none'
        p.style.transform = `translateY(${dy}px)`
        els.push(p)
      }
    }
    // One reflow for all, then play every row to its place together.
    void root.offsetHeight
    for (const el of els) {
      el.style.transition = `transform ${GLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
      el.style.transform = ''
    }
    setTimeout(() => {
      for (const el of els) {
        el.style.transition = ''
        el.style.transform = ''
      }
    }, GLIDE_MS + 40)
  })
}
