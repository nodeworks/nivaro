import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  History,
  Lock,
  MoreHorizontal,
  Plus,
  Split,
  Trash2,
  Undo2
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient, useParentDraft } from '../../context'
import { get, post } from '../../lib/commands'
import { evaluateNumeric } from '../../lib/expression'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  type CompareDetailRow,
  type CompareProposal,
  CompareProposalBanner,
  type CompareSeriesConfig,
  type CompareSeriesData,
  CompareStripChips,
  closedThroughLabel,
  compareColumnClosed,
  extraSeriesValue,
  GridStatChip,
  monthLabel,
  monthLabelLong,
  planLabel,
  resolveCompareEndpoint,
  unitWord,
  useCompareSeries
} from './CompareSeries'
import type { GridStatConfig, GridSumCapConfig } from './InlineTableField'
import { useLiveRows, useO2MStaging } from './O2MStagingContext'
import { RowHistorySheet, type RowRevisionEntry } from './RowHistorySheet'
import { RowWatchButton } from './RowWatchButton'
import type { CMSField } from './types'

/**
 * Plan grid (`options.row_split` on an inline-table field).
 *
 * A key × period planning grid — one block per key (a year), one column per
 * period (a month) — where a block is EITHER one top-line row or a set of
 * category rows that add up to it. The block reads as two labelled lines,
 * the plan and what really happened (the grid's `compare_series`), with the
 * line names printed once in a frozen left column and every figure in a
 * fixed-width, right-aligned cell that scrolls horizontally in full.
 *
 * Splitting a block into categories and merging it back go through an
 * endpoint the layout names (`split_endpoint`) — that writer owns the rules
 * (which categories exist, their ceilings, what a closed period allows). All
 * other edits stage with the record's own Save, like any pending-mode grid.
 *
 * Nothing moves on its own: a closed period whose plan disagrees with what
 * happened offers a reconcile with a preview, and the person picks where the
 * difference goes.
 */
export interface RowSplitConfig {
  /** Column identifying a block (a year). */
  key_field: string
  /** Optional collection listing the valid keys ("Add" offers the unused ones). */
  key_collection?: string
  /** NULL = the block's single top-line row; a value = one category row. */
  category_field: string
  category_collection?: string
  category_label_field?: string
  /** Category ids a block may split into, in display order. */
  categories?: Array<string | number>
  /** Period columns, in order. */
  value_fields: string[]
  /** Write-computed row total (summed client-side for live rollups). */
  total_field?: string
  total_label?: string
  unclassified_label?: string
  split_label?: string
  merge_label?: string
  /** `/ext/split/$parent.id` — GET = info, POST …/split and …/merge. */
  split_endpoint?: string
}

interface PlanRow {
  uid: string
  id: string | null
  pendingIndex: number | null
  key: string
  cat: string | null
  values: Record<string, unknown>
  edited: boolean
  isNew: boolean
}

interface Block {
  key: string
  mode: 'top' | 'split' | 'ghost'
  top: PlanRow | null
  cats: PlanRow[]
}

interface SplitInfo {
  categories: Array<{
    id: number | string
    label: string
    cap: number
    forecast: number
    left: number
  }>
  years?: Array<{ year: number; mode: 'top' | 'split' }>
  can_split: boolean
  shares: Record<string, number>
}

interface SplitPreview {
  original: Record<string, number>
  closed: string[]
  categories: Array<{
    id: number | string
    label: string
    cap: number
    share: number
    values: Record<string, number>
  }>
  blocked: string | null
}

const UNCLASSIFIED = 'unclassified'
const num = (v: unknown) => Number(v) || 0
const cents = (n: number) => Math.round(n * 100) / 100

/** Full figure: whole amounts drop the cents, anything else shows both. */
export function fmtFigure(n: number): string {
  const whole = Math.abs(n - Math.round(n)) < 0.005
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2
  })
}

export function parseFigure(text: string): number | null {
  const t = text.replace(/[$,\s]/g, '')
  if (t === '' || t === '-' || t === '—') return 0
  const neg = /^\(.*\)$/.test(t)
  const n = Number(neg ? t.slice(1, -1) : t)
  if (!Number.isFinite(n)) return null
  return cents(neg ? -n : n)
}

export type ReconcileMode = 'next' | 'even' | 'weighted' | 'none'

/**
 * What a reconcile writes. The closed column takes `actual`; the difference
 * goes to (or comes out of) open columns of the same row per `mode`. A column
 * never drops below zero — what could not be absorbed is reported. Pure.
 */
export function reconcilePatch(args: {
  row: Record<string, unknown>
  column: string
  actual: number
  openColumns: string[]
  mode: ReconcileMode
}): { patch: Record<string, number>; moved: number; unabsorbed: number; targets: string[] } {
  const { row, column, actual, openColumns, mode } = args
  const remainder = cents(num(row[column]) - actual)
  const patch: Record<string, number> = { [column]: cents(actual) }
  if (mode === 'none' || Math.abs(remainder) < 0.005 || openColumns.length === 0)
    return { patch, moved: 0, unabsorbed: mode === 'none' ? 0 : remainder, targets: [] }
  let targets: string[]
  let weights: number[]
  if (mode === 'next') {
    targets = [openColumns[0]]
    weights = [1]
  } else if (mode === 'weighted') {
    targets = openColumns.filter((c) => num(row[c]) > 0.005)
    weights = targets.map((c) => num(row[c]))
  } else {
    targets = openColumns
    weights = targets.map(() => 1)
  }
  if (targets.length === 0) return { patch, moved: 0, unabsorbed: remainder, targets: [] }
  const wSum = weights.reduce((a, b) => a + b, 0) || 1
  let left = remainder
  targets.forEach((c, i) => {
    const last = i === targets.length - 1
    const share = last ? left : cents((remainder * weights[i]) / wSum)
    const next = Math.max(0, cents(num(row[c]) + share))
    const applied = cents(next - num(row[c]))
    patch[c] = next
    left = cents(left - applied)
  })
  // A floor at zero can leave part of a negative remainder unplaced — try the
  // other targets once before giving up.
  if (Math.abs(left) >= 0.005 && left < 0) {
    for (const c of targets) {
      if (Math.abs(left) < 0.005) break
      const take = Math.min(patch[c], -left)
      patch[c] = cents(patch[c] - take)
      left = cents(left + take)
    }
  }
  return { patch, moved: cents(remainder - left), unabsorbed: left, targets }
}

const LABEL_W = 176
const CELL_W = 112
const TOTAL_W = 128

const stickyLabel =
  'sticky left-0 z-[2] bg-white dark:bg-[hsl(var(--card))] border-r border-slate-200 dark:border-border'
const stickyTotal =
  'sticky right-0 z-[2] bg-white dark:bg-[hsl(var(--card))] border-l border-slate-200 dark:border-border'
const closedTint = 'bg-slate-50 dark:bg-white/[0.035]'

export function PlanGridField(props: {
  relatedCollection: string
  manyField: string
  parentId: string
  config: RowSplitConfig
  compareSeries?: CompareSeriesConfig | null
  stats?: GridStatConfig[] | null
  sumCap?: GridSumCapConfig | null
  /** Expression for what is still unplanned — feeds "Spread what is left". */
  remaining?: string | null
  readOnly?: boolean
  showHistory?: boolean
  emptyLabel?: string
}) {
  const {
    relatedCollection: rc,
    manyField: mf,
    parentId,
    config,
    compareSeries,
    stats,
    sumCap,
    remaining,
    readOnly = false,
    showHistory = true,
    emptyLabel
  } = props
  const client = useNivaroClient()
  const qc = useQueryClient()
  const staging = useO2MStaging()
  const liveRows = useLiveRows()
  const parentDraftCtx = useParentDraft()
  const parentDraft = parentDraftCtx?.draft
  const { isAdmin } = useItemEditAuth()
  const isNew = !parentId || parentId === 'new'
  const canEdit = !readOnly && !!staging
  const cols = config.value_fields
  const totalField = config.total_field ?? null

  // ── data ────────────────────────────────────────────────────────────────
  const { data: rawRows = [], isLoading: rowsLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ['o2m-rows', rc, mf, parentId, ''],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${rc}`, { filter: JSON.stringify({ [mf]: { _eq: parentId } }), limit: 200 })
        )
        .then((r) => r.data ?? []),
    enabled: !isNew,
    staleTime: 30_000
  })

  const compareEndpoint = useMemo(
    () =>
      compareSeries?.endpoint ? resolveCompareEndpoint(compareSeries.endpoint, parentDraft) : null,
    [compareSeries?.endpoint, parentDraft]
  )
  const compareQ = useCompareSeries({
    client,
    endpoint: compareEndpoint,
    enabled: !!compareSeries && !isNew
  })
  const compare: CompareSeriesData | null = compareSeries && !isNew ? (compareQ.data ?? null) : null

  const splitBase = useMemo(() => {
    if (!config.split_endpoint || isNew) return null
    return config.split_endpoint.replace(/\$parent\.([A-Za-z_][A-Za-z0-9_]*)/g, (_, f: string) =>
      f === 'id' ? String(parentId) : String(parentDraft?.[f] ?? '')
    )
  }, [config.split_endpoint, isNew, parentId, parentDraft])
  const infoKey = useMemo(() => ['plan-grid-split-info', splitBase], [splitBase])
  const { data: info = null } = useQuery<SplitInfo | null>({
    queryKey: infoKey,
    queryFn: () =>
      client
        .request<{ data: SplitInfo }>(get(splitBase as string))
        .then((r) => r.data ?? null)
        .catch(() => null),
    enabled: !!splitBase,
    staleTime: 30_000
  })

  const { data: catLabels = {} } = useQuery<Record<string, string>>({
    queryKey: ['plan-grid-categories', config.category_collection, config.category_label_field],
    queryFn: async () => {
      const lf = config.category_label_field ?? 'name'
      const r = await client.request<{ data: Array<Record<string, unknown>> }>(
        get(`/items/${config.category_collection}`, { fields: `id,${lf}`, limit: 100 })
      )
      return Object.fromEntries((r.data ?? []).map((x) => [String(x.id), String(x[lf] ?? x.id)]))
    },
    enabled: !!config.category_collection,
    staleTime: 10 * 60_000
  })
  const catLabel = useCallback(
    (cat: string) =>
      cat === UNCLASSIFIED
        ? (config.unclassified_label ?? 'Unclassified')
        : (catLabels[cat] ?? `#${cat}`),
    [catLabels, config.unclassified_label]
  )
  const catOrder = useMemo(() => (config.categories ?? []).map(String), [config.categories])

  // ── rows as shown: saved ± staged ───────────────────────────────────────
  const pendingRows = staging?.getPendingRows(rc, mf) ?? []
  const pendingEdits = staging?.getPendingEdits(rc, mf)
  const pendingDeletes = staging?.getPendingDeletes(rc, mf)

  const rows: PlanRow[] = useMemo(() => {
    const out: PlanRow[] = []
    const idOf = (v: unknown) =>
      v && typeof v === 'object' && 'id' in (v as object) ? (v as { id: unknown }).id : v
    for (const r of rawRows) {
      const id = String(r.id)
      if (pendingDeletes?.has(id)) continue
      const edit = pendingEdits?.get(id)
      const values = edit ? { ...r, ...edit } : r
      const cat = idOf(values[config.category_field])
      out.push({
        uid: `s:${id}`,
        id,
        pendingIndex: null,
        key: String(idOf(values[config.key_field]) ?? ''),
        cat: cat == null || cat === '' ? null : String(cat),
        values,
        edited: !!edit && Object.keys(edit).some((k) => !k.startsWith('_')),
        isNew: false
      })
    }
    pendingRows.forEach((r, i) => {
      const cat = idOf(r[config.category_field])
      out.push({
        uid: `p:${i}`,
        id: null,
        pendingIndex: i,
        key: String(idOf(r[config.key_field]) ?? ''),
        cat: cat == null || cat === '' ? null : String(cat),
        values: r,
        edited: false,
        isNew: true
      })
    })
    return out
  }, [rawRows, pendingRows, pendingEdits, pendingDeletes, config.key_field, config.category_field])

  const rowTotal = useCallback(
    (v: Record<string, unknown>) => cents(cols.reduce((a, c) => a + num(v[c]), 0)),
    [cols]
  )

  const blocks: Block[] = useMemo(() => {
    const byKey = new Map<string, Block>()
    for (const r of rows) {
      if (!r.key) continue
      let b = byKey.get(r.key)
      if (!b) {
        b = { key: r.key, mode: 'top', top: null, cats: [] }
        byKey.set(r.key, b)
      }
      if (r.cat == null) b.top = b.top ?? r
      else b.cats.push(r)
    }
    for (const b of byKey.values()) {
      if (b.cats.length) {
        b.mode = 'split'
        b.cats.sort((x, y) => {
          const ix = catOrder.indexOf(x.cat as string)
          const iy = catOrder.indexOf(y.cat as string)
          return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy)
        })
      }
    }
    // What happened in a key nobody planned is the thing a reviewer must see.
    for (const cr of compare?.rows ?? []) {
      const k = String(cr.key)
      if (byKey.has(k)) continue
      if (!cols.some((c) => Math.abs(num(cr.values[c])) >= 0.005)) continue
      byKey.set(k, { key: k, mode: 'ghost', top: null, cats: [] })
    }
    return [...byKey.values()].sort(
      (a, b) => Number(a.key) - Number(b.key) || a.key.localeCompare(b.key)
    )
  }, [rows, compare, cols, catOrder])

  // ── live rollups ────────────────────────────────────────────────────────
  const rowsForRollup = useMemo(
    () =>
      rows.map((r) => (totalField ? { ...r.values, [totalField]: rowTotal(r.values) } : r.values)),
    [rows, totalField, rowTotal]
  )
  const report = liveRows?.report
  useEffect(() => {
    if (!report) return
    if (rowsLoading) {
      report(rc, mf, null)
      return
    }
    report(rc, mf, rowsForRollup)
  }, [report, rc, mf, rowsForRollup, rowsLoading])
  const withdrawRef = useRef<() => void>(() => {})
  withdrawRef.current = () => report?.(rc, mf, null)
  useEffect(() => () => withdrawRef.current(), [])

  const resolveToken = useCallback(
    (path: string): unknown => {
      if (path.startsWith('$parent.')) return parentDraft?.[path.slice(8)] ?? 0
      if (path.startsWith('$sum.')) {
        const col = path.slice(5)
        return rowsForRollup.reduce((a, r) => a + num(r[col]), 0)
      }
      if (path === '$count') return rowsForRollup.length
      return parentDraft?.[path]
    },
    [parentDraft, rowsForRollup]
  )
  const statValues = useMemo(
    () => (stats ?? []).map((st) => ({ ...st, result: evaluateNumeric(st.value, resolveToken) })),
    [stats, resolveToken]
  )
  const gridTotal = useMemo(
    () => cents(rows.reduce((a, r) => a + rowTotal(r.values), 0)),
    [rows, rowTotal]
  )

  // Category figures from what is on screen, ceilings from the writer.
  const categoryFigures = useMemo(() => {
    if (!info) return []
    return info.categories
      .filter((c) => c.cap > 0.005 || rows.some((r) => r.cat === String(c.id)))
      .map((c) => {
        const planned = cents(
          rows.filter((r) => r.cat === String(c.id)).reduce((a, r) => a + rowTotal(r.values), 0)
        )
        return {
          id: String(c.id),
          label: c.label,
          cap: c.cap,
          planned,
          left: cents(c.cap - planned)
        }
      })
  }, [info, rows, rowTotal])

  // ── closed / locked ─────────────────────────────────────────────────────
  const isClosed = useCallback(
    (key: string, col: string) => compareColumnClosed(compare, key, col),
    [compare]
  )
  const isLocked = useCallback(
    (key: string, col: string) =>
      !canEdit || (isClosed(key, col) && !!compare?.closed_locked && !isAdmin),
    [canEdit, isClosed, compare?.closed_locked, isAdmin]
  )

  const actualFor = useCallback(
    (
      key: string,
      cat: string | null,
      col: string
    ): { value: number; details: CompareDetailRow[] } => {
      const cr = compare?.rows.find((r) => String(r.key) === key)
      if (!cr) return { value: 0, details: [] }
      if (cat == null) return { value: num(cr.values[col]), details: cr.details?.[col] ?? [] }
      const c = cr.by_category?.[cat]
      return { value: num(c?.values[col]), details: c?.details?.[col] ?? [] }
    },
    [compare]
  )

  // ── staging a change ────────────────────────────────────────────────────
  const [notice, setNotice] = useState<string | null>(null)
  const stage = useCallback(
    (row: PlanRow, patch: Record<string, number>, reason?: string): boolean => {
      if (!staging) return false
      const merged = { ...row.values, ...patch }
      const before = rowTotal(row.values)
      const after = rowTotal(merged)
      if (after > before + 0.005) {
        if (sumCap) {
          const cap = evaluateNumeric(sumCap.cap, resolveToken)
          const nextTotal = cents(gridTotal - before + after)
          if (cap != null && nextTotal > cap + 0.005) {
            setNotice(
              `${sumCap.message ?? `${sumCap.label ?? 'The total'} cannot exceed ${fmtFigure(cap)}`} — this would reach ${fmtFigure(nextTotal)}, ${fmtFigure(cents(nextTotal - cap))} over.`
            )
            return false
          }
        }
        if (row.cat != null) {
          const c = categoryFigures.find((x) => x.id === row.cat)
          if (c) {
            const nextCat = cents(c.planned - before + after)
            if (nextCat > c.cap + 0.005) {
              setNotice(
                `${c.label} would reach ${fmtFigure(nextCat)} — ${fmtFigure(cents(nextCat - c.cap))} over its ${fmtFigure(c.cap)}.`
              )
              return false
            }
          }
        }
      }
      setNotice(null)
      if (row.id)
        staging.queueEdit(rc, mf, row.id, reason ? { ...patch, _change_reason: reason } : patch)
      else if (row.pendingIndex != null)
        staging.updateRow(rc, mf, row.pendingIndex, {
          ...row.values,
          ...patch,
          ...(reason ? { _change_reason: reason } : {})
        })
      return true
    },
    [staging, rowTotal, sumCap, resolveToken, gridTotal, categoryFigures, rc, mf]
  )

  const addKey = useCallback(
    (key: string | number, seed?: Record<string, number>, reason?: string) => {
      if (!staging) return
      staging.queueRow(rc, mf, {
        [config.key_field]: key,
        ...Object.fromEntries(cols.map((c) => [c, seed?.[c] ?? 0])),
        ...(reason ? { _change_reason: reason } : {})
      })
    },
    [staging, rc, mf, config.key_field, cols]
  )

  const removeBlock = useCallback(
    (b: Block) => {
      if (!staging) return
      const all = [...(b.top ? [b.top] : []), ...b.cats]
      // Pending indexes shift as rows leave — highest first.
      for (const r of all
        .filter((x) => x.pendingIndex != null)
        .sort((x, y) => (y.pendingIndex ?? 0) - (x.pendingIndex ?? 0)))
        staging.removeRow(rc, mf, r.pendingIndex as number)
      for (const r of all) if (r.id) staging.queueDelete(rc, mf, r.id)
    },
    [staging, rc, mf]
  )

  const refreshAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['o2m-rows', rc, mf, parentId] })
    qc.invalidateQueries({ queryKey: infoKey })
    if (compareEndpoint) qc.invalidateQueries({ queryKey: ['o2m-compare', compareEndpoint] })
  }, [qc, rc, mf, parentId, infoKey, compareEndpoint])

  // ── keyboard: every editable cell is addressable ────────────────────────
  const rootRef = useRef<HTMLDivElement>(null)
  const editableUids = useMemo(() => {
    const out: string[] = []
    for (const b of blocks) {
      if (b.mode === 'top' && b.top) out.push(b.top.uid)
      if (b.mode === 'split') for (const r of b.cats) out.push(r.uid)
    }
    return out
  }, [blocks])
  const focusCell = useCallback((uid: string, col: string) => {
    const el = rootRef.current?.querySelector<HTMLInputElement>(`[data-pg-cell="${uid}:${col}"]`)
    if (el) {
      el.focus()
      el.select()
      return true
    }
    return false
  }, [])
  const move = useCallback(
    (uid: string, col: string, dRow: number, dCol: number) => {
      let ri = editableUids.indexOf(uid)
      let ci = cols.indexOf(col)
      for (let step = 0; step < 40; step++) {
        ri += dRow
        ci += dCol
        if (ri < 0 || ri >= editableUids.length || ci < 0 || ci >= cols.length) return
        if (focusCell(editableUids[ri], cols[ci])) return
      }
    },
    [editableUids, cols, focusCell]
  )

  const pasteInto = useCallback(
    (row: PlanRow, col: string, text: string) => {
      const lines = text
        .replace(/\r/g, '')
        .split('\n')
        .filter((l) => l.trim() !== '')
      const startRow = editableUids.indexOf(row.uid)
      const startCol = cols.indexOf(col)
      let landed = 0
      lines.forEach((line, li) => {
        const target = rows.find((r) => r.uid === editableUids[startRow + li])
        if (!target) return
        const patch: Record<string, number> = {}
        line.split('\t').forEach((cell, ci) => {
          const c = cols[startCol + ci]
          if (!c || isLocked(target.key, c)) return
          const v = parseFigure(cell)
          if (v == null || v < 0) return
          patch[c] = v
        })
        if (Object.keys(patch).length && stage(target, patch)) landed += Object.keys(patch).length
      })
      if (landed) toast.success(`Pasted ${landed} ${landed === 1 ? 'figure' : 'figures'}`)
    },
    [editableUids, cols, rows, isLocked, stage]
  )

  // ── jump-to-row (notifications, header chips) ───────────────────────────
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const flashedRef = useRef<string | null>(null)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (
        e as CustomEvent<{
          collection?: string
          field?: string
          rowId?: unknown
          handled?: boolean
        }>
      ).detail
      if (!d || d.collection !== rc || d.rowId == null) return
      const row = rows.find((r) => r.id === String(d.rowId))
      if (!row) return
      d.handled = true
      // The sender asks several times while the form settles — one flash.
      if (flashedRef.current === row.id) return
      flashedRef.current = row.id
      window.setTimeout(() => {
        flashedRef.current = null
      }, 8000)
      setCollapsed((prev) => {
        if (!prev.has(row.key)) return prev
        const next = new Set(prev)
        next.delete(row.key)
        return next
      })
      window.setTimeout(() => {
        const el = rootRef.current?.querySelector<HTMLElement>(`[data-o2m-row="${rc}:${row.id}"]`)
        if (!el) return
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.classList.remove('nvr-row-flash')
        void el.offsetWidth
        el.classList.add('nvr-row-flash')
      }, 60)
    }
    window.addEventListener('nvr:grid-open-row', onOpen)
    return () => window.removeEventListener('nvr:grid-open-row', onOpen)
  }, [rc, rows])

  // ── proposals ───────────────────────────────────────────────────────────
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      return new Set(
        JSON.parse(localStorage.getItem(`nvr_pg_dismissed:${rc}:${parentId}`) ?? '[]') as string[]
      )
    } catch {
      return new Set()
    }
  })
  const proposals = (compare?.proposals ?? []).filter((p) => !dismissed.has(p.id))
  const hideProposal = (p: CompareProposal, persist: boolean) => {
    setDismissed((prev) => {
      const next = new Set(prev).add(p.id)
      if (persist)
        try {
          localStorage.setItem(`nvr_pg_dismissed:${rc}:${parentId}`, JSON.stringify([...next]))
        } catch {
          /* storage unavailable */
        }
      return next
    })
  }
  const applyProposal = (p: CompareProposal) => {
    let cells = 0
    for (const pr of p.rows) {
      const key = String(pr.key)
      const b = blocks.find((x) => x.key === key)
      // A split key takes figures only on the line the proposal names.
      if ((b?.mode === 'split') !== (pr.category != null)) continue
      const open = Object.fromEntries(
        Object.entries(pr.values).filter(
          ([c, v]) => cols.includes(c) && !isClosed(key, c) && num(v) > 0
        )
      )
      const line =
        pr.category != null ? b?.cats.find((r) => String(r.cat) === String(pr.category)) : null
      if (pr.category != null) {
        if (!line) continue
        const patch = Object.fromEntries(
          Object.entries(open).filter(([c]) => num(line.values[c]) === 0)
        )
        if (Object.keys(patch).length && stage(line, patch, p.change_reason))
          cells += Object.keys(patch).length
      } else if (b?.top) {
        const patch = Object.fromEntries(
          Object.entries(open).filter(([c]) => num(b.top?.values[c]) === 0)
        )
        if (Object.keys(patch).length && stage(b.top, patch, p.change_reason))
          cells += Object.keys(patch).length
      } else if (Object.keys(open).length) {
        addKey(pr.key, open, p.change_reason)
        cells += Object.keys(open).length
      }
    }
    if (cells)
      toast.success(
        `${p.label}: ${cells} ${cells === 1 ? 'figure' : 'figures'} staged — Save to keep them`
      )
    else toast.message('Nothing to fill — those periods already hold a figure')
    hideProposal(p, false)
  }

  // ── history ─────────────────────────────────────────────────────────────
  const [historyRow, setHistoryRow] = useState<PlanRow | null>(null)
  const { data: revisions = [], isLoading: revLoading } = useQuery<RowRevisionEntry[]>({
    queryKey: ['o2m-row-revisions', rc, historyRow?.id],
    queryFn: () =>
      client
        .request<{ data: RowRevisionEntry[] }>(
          get('/revisions', { collection: rc, item: String(historyRow?.id) })
        )
        .then((r) => r.data ?? []),
    enabled: !!historyRow?.id,
    staleTime: 15_000
  })
  const { data: childFields = [] } = useQuery<CMSField[]>({
    queryKey: ['plan-grid-fields', rc],
    queryFn: () =>
      client.request<{ data: CMSField[] }>(get(`/field-config/${rc}`)).then((r) => r.data ?? []),
    enabled: !!historyRow,
    staleTime: 5 * 60_000
  })

  // ── header ──────────────────────────────────────────────────────────────
  const [showCategories, setShowCategories] = useState(false)
  const anySplit = blocks.some((b) => b.mode === 'split')
  const plan = planLabel(compare)
  const actualName = compare?.label ?? compareSeries?.label ?? 'Actual'
  const closedLabel = closedThroughLabel(compare?.closed_through)
  const closedYear = compare?.closed_through ? Number(compare.closed_through.split('-')[0]) : null
  const lastClosedCol = useMemo(() => {
    if (closedYear == null) return null
    const closedCols = cols.filter((c) => isClosed(String(closedYear), c))
    return closedCols[closedCols.length - 1] ?? null
  }, [closedYear, cols, isClosed])

  const usedKeys = useMemo(
    () => new Set(blocks.filter((b) => b.mode !== 'ghost').map((b) => b.key)),
    [blocks]
  )
  const remainingNow = remaining ? evaluateNumeric(remaining, resolveToken) : null

  const spreadLeft = (row: PlanRow) => {
    let amount = remainingNow ?? 0
    if (row.cat != null) {
      const c = categoryFigures.find((x) => x.id === row.cat)
      if (c) amount = Math.min(amount, c.left)
    }
    const targets = cols.filter((c) => !isClosed(row.key, c) && num(row.values[c]) === 0)
    if (amount < 0.005 || targets.length === 0) {
      toast.message(
        amount < 0.005 ? 'Nothing is left to spread' : 'No empty open periods on this line'
      )
      return
    }
    const each = Math.floor((amount / targets.length) * 100) / 100
    const patch: Record<string, number> = {}
    targets.forEach((c, i) => {
      patch[c] = i === targets.length - 1 ? cents(amount - each * (targets.length - 1)) : each
    })
    if (stage(row, patch))
      toast.success(`${fmtFigure(amount)} spread over ${targets.length} open periods`)
  }

  const colTotals = useMemo(() => {
    const planBy: Record<string, number> = {}
    const actualBy: Record<string, number> = {}
    for (const c of cols) {
      planBy[c] = cents(rows.reduce((a, r) => a + num(r.values[c]), 0))
      actualBy[c] = cents((compare?.rows ?? []).reduce((a, r) => a + num(r.values[c]), 0))
    }
    return { planBy, actualBy }
  }, [cols, rows, compare])

  const tableWidth = LABEL_W + cols.length * CELL_W + TOTAL_W

  if (!isNew && rowsLoading)
    return (
      <div className='space-y-1.5' data-plan-grid-loading>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className='h-8 animate-pulse rounded'
            style={{ background: 'hsl(var(--nvr-skeleton))' }}
          />
        ))}
      </div>
    )

  return (
    <div ref={rootRef} data-plan-grid={rc} className='min-w-0'>
      {compare && proposals.length > 0 && canEdit && (
        <CompareProposalBanner
          proposals={proposals}
          onApply={applyProposal}
          onDismiss={(p) => hideProposal(p, true)}
        />
      )}

      {/* figure strip */}
      {(statValues.length > 0 || compareSeries) && (
        <div className='mb-2 flex flex-wrap items-center gap-1.5' data-o2m-stats>
          <CompareStripChips
            data={compare}
            loading={!!compareSeries && !isNew && compareQ.isLoading}
            error={!!compareSeries && !isNew && compareQ.isError}
          />
          {statValues.map((st) => (
            <GridStatChip
              key={st.label}
              label={st.label}
              value={st.result}
              format={st.format}
              negative={st.negative === 'danger' && st.result != null && st.result < -0.005}
            />
          ))}
          {categoryFigures.length > 1 && anySplit && (
            <button
              type='button'
              data-plan-grid-categories-toggle
              aria-expanded={showCategories}
              onClick={() => setShowCategories((v) => !v)}
              className='inline-flex h-[28px] items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
            >
              {showCategories ? (
                <ChevronDown className='h-3.5 w-3.5' />
              ) : (
                <ChevronRight className='h-3.5 w-3.5' />
              )}
              By category
            </button>
          )}
        </div>
      )}
      {showCategories && anySplit && (
        <div className='mb-2 flex flex-wrap gap-1.5' data-plan-grid-categories>
          {categoryFigures.map((c) => (
            <GridStatChip
              key={c.id}
              dataKey={`category:${c.id}`}
              label={`${c.label} left of ${fmtFigure(c.cap)}`}
              value={c.left}
              format='currency'
              negative={c.left < -0.005}
            />
          ))}
        </div>
      )}

      <div
        className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'
        data-plan-grid-scroll
      >
        <table
          className='border-separate border-spacing-0 text-[12px] tabular-nums'
          // Fills the slot; the months share any spare room, and the minimum keeps
          // full figures readable (the wrapper scrolls below it).
          style={{ width: '100%', minWidth: tableWidth, tableLayout: 'fixed' }}
        >
          <colgroup>
            <col style={{ width: LABEL_W }} />
            {cols.map((c) => (
              <col key={c} style={{ width: CELL_W }} />
            ))}
            <col style={{ width: TOTAL_W }} />
          </colgroup>
          <thead>
            <tr>
              <th
                className={cn(
                  stickyLabel,
                  'z-[3] border-b px-3 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'
                )}
              >
                {titleOf(config.key_field)}
              </th>
              {cols.map((c) => {
                const closed = closedYear != null && isClosed(String(closedYear), c)
                return (
                  <th
                    key={c}
                    className={cn(
                      'border-b border-slate-200 px-2.5 py-1.5 text-right text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:border-border dark:text-slate-400',
                      closed && closedTint
                    )}
                  >
                    <span className='inline-flex items-center justify-end gap-1'>
                      {c === lastClosedCol && (
                        <span
                          data-plan-grid-lock
                          data-tip={`Closed through ${closedLabel ?? ''}${compare?.closed_rule ? ` — ${compare.closed_rule}` : ''}`}
                          className='inline-flex'
                        >
                          <Lock
                            className='h-3 w-3'
                            aria-label={`Closed through ${closedLabel ?? ''}`}
                          />
                        </span>
                      )}
                      {monthLabel(c)}
                    </span>
                  </th>
                )
              })}
              <th
                className={cn(
                  stickyTotal,
                  'z-[3] border-b px-3 py-1.5 text-right text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'
                )}
              >
                {config.total_label ?? 'Total'}
              </th>
            </tr>
          </thead>

          {blocks.length === 0 && (
            <tbody>
              <tr>
                <td
                  colSpan={cols.length + 2}
                  className='px-3 py-6 text-[12.5px] text-slate-500 dark:text-slate-400'
                >
                  {`No ${(emptyLabel ?? 'rows').toLowerCase()} yet.`}
                  {canEdit
                    ? ` Add a ${titleOf(config.key_field).toLowerCase()} to start planning.`
                    : ''}
                </td>
              </tr>
            </tbody>
          )}

          {blocks.map((b, bi) => {
            const open = !collapsed.has(b.key)
            const blockPlan = (c: string) =>
              b.mode === 'split'
                ? cents(b.cats.reduce((a, r) => a + num(r.values[c]), 0))
                : num(b.top?.values[c])
            const blockTotal = cents(cols.reduce((a, c) => a + blockPlan(c), 0))
            const unclassified = cols.some(
              (c) => Math.abs(actualFor(b.key, UNCLASSIFIED, c).value) >= 0.005
            )
            const extra = (compare?.series ?? []).filter((s) =>
              cols.some((c) => Math.abs(extraSeriesValue(s, b.key, c) ?? 0) >= 0.005)
            )
            // A key nothing has happened in yet needs one quiet line, not one per category.
            const hasActuals = cols.some((c) => Math.abs(actualFor(b.key, null, c).value) >= 0.005)
            const edited =
              (b.top?.edited || b.top?.isNew || b.cats.some((r) => r.edited || r.isNew)) ?? false
            return (
              <tbody
                key={b.key}
                data-plan-block={b.key}
                data-plan-mode={b.mode}
                className={cn(bi > 0 && 'pg-block')}
              >
                {/* key line: the top-line plan, or the derived total of a split */}
                <tr
                  data-o2m-row={b.top?.id ? `${rc}:${b.top.id}` : undefined}
                  className={cn(
                    bi > 0 && '[&>td]:border-t [&>td]:border-slate-200 dark:[&>td]:border-border'
                  )}
                >
                  <td className={cn(stickyLabel, 'px-2 py-1')}>
                    <div className='flex items-center gap-1'>
                      {b.mode === 'split' ? (
                        <button
                          type='button'
                          aria-expanded={open}
                          aria-label={`${open ? 'Collapse' : 'Expand'} ${b.key}`}
                          onClick={() =>
                            setCollapsed((prev) => {
                              const next = new Set(prev)
                              if (next.has(b.key)) next.delete(b.key)
                              else next.add(b.key)
                              return next
                            })
                          }
                          className='rounded p-0.5 text-slate-500 hover:bg-muted'
                        >
                          {open ? (
                            <ChevronDown className='h-3.5 w-3.5' />
                          ) : (
                            <ChevronRight className='h-3.5 w-3.5' />
                          )}
                        </button>
                      ) : (
                        <span className='w-[18px]' />
                      )}
                      <span className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
                        {b.key}
                      </span>
                      {edited && (
                        <span
                          data-plan-edited
                          data-tip='Unsaved — lands with Save'
                          className='h-1.5 w-1.5 rounded-full bg-amber-500'
                        />
                      )}
                      <span className='ml-auto text-[10.5px] font-medium text-slate-500 dark:text-slate-400'>
                        {b.mode === 'ghost' ? '' : plan}
                      </span>
                      {canEdit && b.mode !== 'ghost' && (
                        <BlockMenu
                          block={b}
                          config={config}
                          canSplit={!!splitBase && !!info?.can_split && !isNew}
                          splitUnavailable={
                            splitBase && info && !info.can_split && !isNew
                              ? (() => {
                                  const only = info.categories.filter((c) => c.cap > 0.005)
                                  return only.length === 1
                                    ? `Every line on this record is ${only[0].label} — there is nothing to split between.`
                                    : 'This record has no categorised lines yet — add lines first.'
                                })()
                              : null
                          }
                          splitBase={splitBase}
                          client={client}
                          cols={cols}
                          catLabel={catLabel}
                          showHistory={showHistory}
                          onHistory={setHistoryRow}
                          onSpread={remaining ? spreadLeft : null}
                          onRemove={() => removeBlock(b)}
                          onDone={refreshAll}
                          rc={rc}
                        />
                      )}
                    </div>
                  </td>
                  {b.mode === 'ghost' ? (
                    <td
                      colSpan={cols.length}
                      className='px-3 py-1 text-[12px] text-slate-500 dark:text-slate-400'
                    >
                      {`No ${plan.toLowerCase()} for ${b.key}`}
                      {canEdit && (
                        <button
                          type='button'
                          data-plan-add-ghost={b.key}
                          onClick={() =>
                            addKey(Number.isFinite(Number(b.key)) ? Number(b.key) : b.key)
                          }
                          className='ml-2 font-medium text-slate-800 underline underline-offset-2 dark:text-slate-100'
                        >
                          Add it
                        </button>
                      )}
                    </td>
                  ) : (
                    cols.map((c) => {
                      const closed = isClosed(b.key, c)
                      if (b.mode === 'split')
                        return (
                          <td
                            key={c}
                            className={cn(
                              'px-2.5 py-1 text-right font-semibold text-slate-900 dark:text-slate-100',
                              closed && closedTint
                            )}
                          >
                            <Figure n={blockPlan(c)} />
                          </td>
                        )
                      return (
                        <PlanCell
                          key={c}
                          row={b.top as PlanRow}
                          col={c}
                          closed={closed}
                          locked={isLocked(b.key, c)}
                          lockedTip={
                            closed
                              ? (compare?.closed_locked_message ?? 'This period is closed')
                              : undefined
                          }
                          onCommit={(v) => stage(b.top as PlanRow, { [c]: v })}
                          onMove={move}
                          onPaste={pasteInto}
                        />
                      )
                    })
                  )}
                  <td
                    className={cn(
                      stickyTotal,
                      'px-3 py-1 text-right font-semibold text-slate-900 dark:text-slate-100'
                    )}
                  >
                    {b.mode === 'ghost' ? '' : <Figure n={blockTotal} />}
                  </td>
                </tr>

                {/* what happened, for the whole key */}
                {compare && (
                  <ActualLine
                    label={actualName}
                    blockKey={b.key}
                    cat={null}
                    cols={cols}
                    compare={compare}
                    planOf={blockPlan}
                    actualFor={actualFor}
                    isClosed={isClosed}
                    row={b.mode === 'top' ? b.top : null}
                    canReconcile={canEdit && b.mode === 'top'}
                    onReconcile={stage}
                  />
                )}
                {b.mode !== 'split' &&
                  extra.map((s) => (
                    <tr key={s.key} data-compare-series={s.key}>
                      <td className={cn(stickyLabel, 'px-2 py-0.5')}>
                        <span
                          data-tip={s.hint ?? ''}
                          className='block pl-[22px] text-right text-[10.5px] font-medium text-slate-500 dark:text-slate-400'
                        >
                          {s.label}
                        </span>
                      </td>
                      {cols.map((c) => (
                        <td
                          key={c}
                          className={cn(
                            'px-2.5 py-0.5 text-right text-[11.5px] text-slate-500 dark:text-slate-400',
                            isClosed(b.key, c) && closedTint
                          )}
                        >
                          <Figure n={extraSeriesValue(s, b.key, c) ?? 0} muted />
                        </td>
                      ))}
                      <td
                        className={cn(
                          stickyTotal,
                          'px-3 py-0.5 text-right text-[11.5px] text-slate-500 dark:text-slate-400'
                        )}
                      >
                        <Figure
                          n={cents(
                            cols.reduce((a, c) => a + (extraSeriesValue(s, b.key, c) ?? 0), 0)
                          )}
                          muted
                        />
                      </td>
                    </tr>
                  ))}

                {/* the categories of a split key */}
                {b.mode === 'split' &&
                  open &&
                  b.cats.map((r) => (
                    <CategoryLines key={r.uid}>
                      <tr
                        data-o2m-row={r.id ? `${rc}:${r.id}` : undefined}
                        data-plan-category={r.cat ?? ''}
                      >
                        <td className={cn(stickyLabel, 'px-2 py-1')}>
                          <div className='flex items-center gap-1 pl-[22px]'>
                            <span className='truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
                              {catLabel(r.cat as string)}
                            </span>
                            {(r.edited || r.isNew) && (
                              <span className='h-1.5 w-1.5 rounded-full bg-amber-500' />
                            )}
                            <span className='ml-auto text-[10.5px] font-medium text-slate-500 dark:text-slate-400'>
                              {plan}
                            </span>
                          </div>
                        </td>
                        {cols.map((c) => (
                          <PlanCell
                            key={c}
                            row={r}
                            col={c}
                            closed={isClosed(b.key, c)}
                            locked={isLocked(b.key, c)}
                            lockedTip={
                              isClosed(b.key, c)
                                ? (compare?.closed_locked_message ?? 'This period is closed')
                                : undefined
                            }
                            onCommit={(v) => stage(r, { [c]: v })}
                            onMove={move}
                            onPaste={pasteInto}
                          />
                        ))}
                        <td
                          className={cn(
                            stickyTotal,
                            'px-3 py-1 text-right font-medium text-slate-800 dark:text-slate-100'
                          )}
                        >
                          <Figure n={rowTotal(r.values)} />
                        </td>
                      </tr>
                      {compare && hasActuals && (
                        <ActualLine
                          label={actualName}
                          blockKey={b.key}
                          cat={r.cat}
                          cols={cols}
                          compare={compare}
                          planOf={(c) => num(r.values[c])}
                          actualFor={actualFor}
                          isClosed={isClosed}
                          row={r}
                          canReconcile={canEdit}
                          onReconcile={stage}
                          indent
                        />
                      )}
                    </CategoryLines>
                  ))}
                {b.mode === 'split' && open && compare && unclassified && (
                  <ActualLine
                    label={`${catLabel(UNCLASSIFIED)} · ${actualName.toLowerCase()}`}
                    tip={`${actualName} the source could not place in a category — it counts in the ${b.key} total only.`}
                    blockKey={b.key}
                    cat={UNCLASSIFIED}
                    cols={cols}
                    compare={compare}
                    planOf={() => 0}
                    actualFor={actualFor}
                    isClosed={isClosed}
                    row={null}
                    canReconcile={false}
                    onReconcile={stage}
                    indent
                    plain
                  />
                )}
              </tbody>
            )
          })}

          {blocks.length > 1 && (
            <tfoot>
              <tr className='[&>td]:border-t [&>td]:border-slate-300 dark:[&>td]:border-border'>
                <td className={cn(stickyLabel, 'px-2 py-1.5')}>
                  <div className='flex items-center pl-[22px]'>
                    <span className='text-[12px] font-semibold text-slate-900 dark:text-slate-100'>
                      All
                    </span>
                    <span className='ml-auto text-[10.5px] font-medium text-slate-500 dark:text-slate-400'>
                      {plan}
                    </span>
                  </div>
                </td>
                {cols.map((c) => (
                  <td
                    key={c}
                    className='px-2.5 py-1.5 text-right font-semibold text-slate-900 dark:text-slate-100'
                  >
                    <Figure n={colTotals.planBy[c]} />
                  </td>
                ))}
                <td
                  className={cn(
                    stickyTotal,
                    'px-3 py-1.5 text-right font-semibold text-slate-900 dark:text-slate-100'
                  )}
                >
                  <Figure n={gridTotal} />
                </td>
              </tr>
              {compare && (
                <tr>
                  <td className={cn(stickyLabel, 'px-2 pb-1.5 pt-0')}>
                    <span className='block text-right text-[10.5px] font-medium text-slate-500 dark:text-slate-400'>
                      {actualName}
                    </span>
                  </td>
                  {cols.map((c) => (
                    <td
                      key={c}
                      className='px-2.5 pb-1.5 pt-0 text-right text-[11.5px] text-slate-600 dark:text-slate-300'
                    >
                      <Figure n={colTotals.actualBy[c]} muted />
                    </td>
                  ))}
                  <td
                    className={cn(
                      stickyTotal,
                      'px-3 pb-1.5 pt-0 text-right text-[11.5px] text-slate-600 dark:text-slate-300'
                    )}
                  >
                    <Figure n={cents(cols.reduce((a, c) => a + colTotals.actualBy[c], 0))} muted />
                  </td>
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>

      {notice && (
        <p
          role='alert'
          data-plan-grid-notice
          className='mt-1.5 text-[12px] font-medium text-red-700 dark:text-red-300'
        >
          {notice}
        </p>
      )}

      {canEdit && (
        <div className='mt-2 flex items-center gap-2'>
          <AddKeyButton
            config={config}
            client={client}
            used={usedKeys}
            onAdd={(k) => addKey(k)}
            label={`Add ${titleOf(config.key_field).toLowerCase()}`}
          />
          {compare?.closed_locked && !isAdmin && closedLabel && (
            <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
              {`Periods through ${closedLabel} are closed — open a highlighted ${actualName.toLowerCase()} figure to reconcile one.`}
            </span>
          )}
        </div>
      )}

      {historyRow && (
        <RowHistorySheet
          open
          onOpenChange={(o) => {
            if (!o) setHistoryRow(null)
          }}
          rowTitle={`${historyRow.key}${historyRow.cat ? ` · ${catLabel(historyRow.cat)}` : ''}`}
          revisions={revisions}
          loading={revLoading}
          fields={childFields}
          displayCols={childFields.filter(
            (f) => cols.includes(f.field) || f.field === config.category_field
          )}
          parentField={mf}
          m2oRelMap={new Map()}
          relations={[]}
          collection={rc}
          m2oDisplays={{}}
          client={client}
          allowRestore={false}
          onRestore={() => {}}
        />
      )}
    </div>
  )
}

function titleOf(field: string): string {
  return field.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** Fragment with a name — keeps the category's two lines together in JSX. */
function CategoryLines(props: { children: React.ReactNode }) {
  return <>{props.children}</>
}

function Figure(props: { n: number; muted?: boolean }) {
  if (Math.abs(props.n) < 0.005)
    return <span className='text-slate-400 dark:text-slate-500'>—</span>
  return <span>{fmtFigure(props.n)}</span>
}

// ── an editable plan cell ───────────────────────────────────────────────────
function PlanCell(props: {
  row: PlanRow
  col: string
  closed: boolean
  locked: boolean
  lockedTip?: string
  onCommit: (v: number) => boolean
  onMove: (uid: string, col: string, dRow: number, dCol: number) => void
  onPaste: (row: PlanRow, col: string, text: string) => void
}) {
  const { row, col, closed, locked, lockedTip, onCommit, onMove, onPaste } = props
  const value = num(row.values[col])
  const [text, setText] = useState<string | null>(null)
  const skipRef = useRef(false)
  if (locked)
    return (
      <td
        data-plan-locked={closed ? 'closed' : 'readonly'}
        data-tip={lockedTip}
        className={cn(
          'px-2.5 py-1 text-right text-slate-700 dark:text-slate-200',
          closed && closedTint
        )}
      >
        <Figure n={value} />
      </td>
    )
  const commit = () => {
    if (text == null) return
    const parsed = parseFigure(text)
    setText(null)
    if (skipRef.current) {
      skipRef.current = false
      return
    }
    if (parsed == null || parsed < 0) {
      toast.error('Enter an amount of zero or more')
      return
    }
    if (Math.abs(parsed - value) < 0.005) return
    onCommit(parsed)
  }
  return (
    <td className={cn('p-0', closed && closedTint)}>
      <input
        data-pg-cell={`${row.uid}:${col}`}
        aria-label={`${monthLabelLong(col)} ${row.key}`}
        inputMode='decimal'
        value={text ?? (value === 0 ? '' : fmtFigure(value))}
        placeholder='—'
        onFocus={(e) => {
          setText(value === 0 ? '' : String(value))
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text')
          if (!/[\t\n]/.test(t.trim())) return
          e.preventDefault()
          skipRef.current = true
          ;(e.target as HTMLInputElement).blur()
          onPaste(row, col, t)
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget
          const caretAtStart = el.selectionStart === 0 && el.selectionEnd === 0
          const caretAtEnd =
            el.selectionStart === el.value.length && el.selectionEnd === el.value.length
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault()
            commit()
            onMove(row.uid, col, 1, 0)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            commit()
            onMove(row.uid, col, -1, 0)
          } else if (e.key === 'ArrowLeft' && caretAtStart) {
            e.preventDefault()
            commit()
            onMove(row.uid, col, 0, -1)
          } else if (e.key === 'ArrowRight' && caretAtEnd) {
            e.preventDefault()
            commit()
            onMove(row.uid, col, 0, 1)
          } else if (e.key === 'Escape') {
            skipRef.current = true
            el.blur()
          }
        }}
        className='h-[30px] w-full bg-transparent px-2.5 text-right text-[12px] tabular-nums text-slate-900 outline-none placeholder:text-slate-400 hover:bg-muted/60 focus:bg-white focus:shadow-[inset_0_0_0_2px_rgb(var(--nvr-cyan-rgb))] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:bg-[hsl(var(--background))]'
      />
    </td>
  )
}

// ── the line of what happened ───────────────────────────────────────────────
function ActualLine(props: {
  label: string
  tip?: string
  blockKey: string
  cat: string | null
  cols: string[]
  compare: CompareSeriesData
  planOf: (col: string) => number
  actualFor: (
    key: string,
    cat: string | null,
    col: string
  ) => { value: number; details: CompareDetailRow[] }
  isClosed: (key: string, col: string) => boolean
  row: PlanRow | null
  canReconcile: boolean
  onReconcile: (row: PlanRow, patch: Record<string, number>, reason?: string) => boolean
  indent?: boolean
  /** No comparison against a plan (the unclassified line). */
  plain?: boolean
}) {
  const {
    label,
    tip,
    blockKey,
    cat,
    cols,
    compare,
    planOf,
    actualFor,
    isClosed,
    row,
    canReconcile,
    onReconcile,
    plain
  } = props
  const total = cents(cols.reduce((a, c) => a + actualFor(blockKey, cat, c).value, 0))
  return (
    <tr data-plan-actual={cat ?? 'all'}>
      <td className={cn(stickyLabel, 'px-2 pb-1 pt-0')}>
        <span
          data-tip={tip}
          className='block text-right text-[10.5px] font-medium text-slate-500 dark:text-slate-400'
        >
          {label}
        </span>
      </td>
      {cols.map((c) => {
        const closed = isClosed(blockKey, c)
        const a = actualFor(blockKey, cat, c)
        const planned = planOf(c)
        const off = !plain && closed && Math.abs(a.value - planned) >= 0.005
        const over = !plain && !closed && a.value > planned + 0.005
        return (
          <td
            key={c}
            data-compare-cell={c}
            className={cn('px-2.5 pb-1 pt-0 text-right text-[11.5px]', closed && closedTint)}
          >
            {Math.abs(a.value) < 0.005 && !off ? (
              <span className='text-slate-400 dark:text-slate-500'>—</span>
            ) : (
              <ActualPopover
                title={`${monthLabelLong(c)} ${blockKey}`}
                compare={compare}
                actualName={label}
                actual={a.value}
                planned={planned}
                closed={closed}
                plain={!!plain}
                details={a.details}
                tone={off ? 'warn' : over ? 'danger' : 'neutral'}
                reconcile={
                  off && canReconcile && row
                    ? {
                        row,
                        column: c,
                        openColumns: cols.filter((x) => !isClosed(blockKey, x)),
                        onApply: (patch, reason) => onReconcile(row, patch, reason)
                      }
                    : null
                }
              />
            )}
          </td>
        )
      })}
      <td
        className={cn(
          stickyTotal,
          'px-3 pb-1 pt-0 text-right text-[11.5px] text-slate-600 dark:text-slate-300'
        )}
      >
        <Figure n={total} muted />
      </td>
    </tr>
  )
}

const TONE: Record<string, string> = {
  warn: 'text-amber-700 dark:text-amber-300 font-medium',
  danger: 'text-red-700 dark:text-red-300 font-medium',
  neutral: 'text-slate-600 dark:text-slate-300'
}

function ActualPopover(props: {
  title: string
  compare: CompareSeriesData
  actualName: string
  actual: number
  planned: number
  closed: boolean
  plain: boolean
  details: CompareDetailRow[]
  tone: 'warn' | 'danger' | 'neutral'
  reconcile: {
    row: PlanRow
    column: string
    openColumns: string[]
    onApply: (patch: Record<string, number>, reason: string) => boolean
  } | null
}) {
  const { title, compare, actualName, actual, planned, closed, plain, details, tone, reconcile } =
    props
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ReconcileMode>('next')
  const [reason, setReason] = useState('')
  const plan = planLabel(compare)
  const diff = cents(planned - actual)
  const result = useMemo(
    () =>
      reconcile
        ? reconcilePatch({
            row: reconcile.row.values,
            column: reconcile.column,
            actual,
            openColumns: reconcile.openColumns,
            mode
          })
        : null,
    [reconcile, actual, mode]
  )
  const weightedPossible =
    !!reconcile && reconcile.openColumns.some((c) => num(reconcile.row.values[c]) > 0.005)
  const defaultReason = useMemo(() => {
    const base = `Reconciled ${title} to ${actualName.toLowerCase()} (${fmtFigure(actual)})`
    if (!result || Math.abs(result.moved) < 0.005) return base
    const where =
      result.targets.length === 1
        ? monthLabelLong(result.targets[0])
        : `${result.targets.length} open periods`
    return result.moved > 0
      ? `${base} — moved ${fmtFigure(result.moved)} to ${where}`
      : `${base} — took ${fmtFigure(-result.moved)} from ${where}`
  }, [title, actualName, actual, result])
  useEffect(() => {
    if (open) setReason(defaultReason)
  }, [open, defaultReason])
  const choices: Array<{ key: ReconcileMode; label: string; disabled?: boolean }> = reconcile
    ? [
        {
          key: 'next',
          label: reconcile.openColumns[0]
            ? `Next open period (${monthLabel(reconcile.openColumns[0])})`
            : 'Next open period',
          disabled: reconcile.openColumns.length === 0
        },
        {
          key: 'even',
          label: 'Evenly over every open period',
          disabled: reconcile.openColumns.length === 0
        },
        {
          key: 'weighted',
          label: `In proportion to the ${plan.toLowerCase()} already there`,
          disabled: !weightedPossible
        },
        { key: 'none', label: 'Nowhere — drop it from the plan' }
      ]
    : []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-compare-details
          data-tip=''
          data-plan-off={tone === 'warn' ? 'true' : undefined}
          className={cn(
            'rounded px-0.5 underline-offset-2 hover:underline focus-visible:underline',
            TONE[tone]
          )}
        >
          {fmtFigure(actual)}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' sideOffset={6} className='w-[360px] p-0 text-[12px]'>
        <div className='border-b border-slate-200 px-3 py-2 dark:border-border'>
          <p className='text-[12.5px] font-semibold text-slate-900 dark:text-slate-100'>{title}</p>
          <dl className='mt-1 grid grid-cols-3 gap-2 tabular-nums'>
            {!plain && (
              <div>
                <dt className='text-[10.5px] text-slate-500 dark:text-slate-400'>{plan}</dt>
                <dd className='font-medium text-slate-800 dark:text-slate-100'>
                  {fmtFigure(planned)}
                </dd>
              </div>
            )}
            <div>
              <dt className='text-[10.5px] text-slate-500 dark:text-slate-400'>{actualName}</dt>
              <dd className='font-medium text-slate-800 dark:text-slate-100'>
                {fmtFigure(actual)}
              </dd>
            </div>
            {!plain && (
              <div>
                <dt className='text-[10.5px] text-slate-500 dark:text-slate-400'>
                  {closed ? 'Difference' : 'Still to come'}
                </dt>
                <dd
                  className={cn(
                    'font-medium',
                    Math.abs(diff) < 0.005
                      ? 'text-slate-800 dark:text-slate-100'
                      : TONE[tone === 'neutral' ? 'neutral' : tone]
                  )}
                >
                  {fmtFigure(diff)}
                </dd>
              </div>
            )}
          </dl>
        </div>
        {details.length > 0 && (
          <ul className='max-h-[168px] overflow-y-auto px-3 py-1.5'>
            {details.map((d) => (
              <li key={String(d.id)} className='flex items-baseline gap-2 py-0.5'>
                <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200'>
                  {d.label}
                  {d.sub ? (
                    <span className='text-slate-500 dark:text-slate-400'>{` · ${d.sub}`}</span>
                  ) : null}
                </span>
                <span className='tabular-nums text-slate-800 dark:text-slate-100'>
                  {fmtFigure(d.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {details.length === 0 && (
          <p className='px-3 py-2 text-slate-500 dark:text-slate-400'>{`No ${unitWord(compare, 2)} behind this figure.`}</p>
        )}
        {reconcile && result && (
          <div
            className='border-t border-slate-200 px-3 py-2 dark:border-border'
            data-plan-reconcile
          >
            <p className='font-medium text-slate-900 dark:text-slate-100'>
              {`Set the ${plan.toLowerCase()} to ${fmtFigure(actual)} and put the ${fmtFigure(Math.abs(diff))} ${diff > 0 ? 'left over' : 'shortfall'}…`}
            </p>
            <div
              className='mt-1.5 space-y-1'
              role='radiogroup'
              aria-label='Where the difference goes'
            >
              {choices.map((ch) => (
                <label
                  key={ch.key}
                  className={cn(
                    'flex cursor-pointer items-center gap-2',
                    ch.disabled && 'cursor-not-allowed opacity-50'
                  )}
                >
                  <input
                    type='radio'
                    name='pg-reconcile'
                    data-plan-reconcile-mode={ch.key}
                    disabled={ch.disabled}
                    checked={mode === ch.key}
                    onChange={() => setMode(ch.key)}
                    className='accent-[rgb(var(--nvr-cyan-rgb))]'
                  />
                  <span className='text-slate-700 dark:text-slate-200'>{ch.label}</span>
                </label>
              ))}
            </div>
            {result.targets.length > 0 && (
              <p
                className='mt-1.5 text-[11.5px] tabular-nums text-slate-600 dark:text-slate-300'
                data-plan-reconcile-preview
              >
                {result.targets
                  .slice(0, 6)
                  .map(
                    (c) =>
                      `${monthLabel(c)} ${fmtFigure(num(reconcile.row.values[c]))} → ${fmtFigure(result.patch[c])}`
                  )
                  .join(' · ')}
                {result.targets.length > 6 ? ` · +${result.targets.length - 6} more` : ''}
              </p>
            )}
            {mode !== 'none' && Math.abs(result.unabsorbed) >= 0.005 && (
              <p className='mt-1 text-[11.5px] text-amber-700 dark:text-amber-300'>
                {`${fmtFigure(Math.abs(result.unabsorbed))} has nowhere to go — it leaves the ${plan.toLowerCase()}.`}
              </p>
            )}
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              aria-label='Reason'
              className='mt-2 w-full resize-none rounded-md border border-slate-200 bg-background px-2 py-1 text-[12px] text-slate-800 outline-none focus:border-slate-400 dark:border-border dark:text-slate-100'
            />
            <div className='mt-1.5 flex justify-end'>
              <button
                type='button'
                data-plan-reconcile-apply
                onClick={() => {
                  if (reconcile.onApply(result.patch, reason.trim() || defaultReason)) {
                    toast.success('Reconcile staged — Save to keep it')
                    setOpen(false)
                  }
                }}
                className='rounded-md bg-nvr-cyan px-3 py-1 text-[12px] font-medium text-white'
              >
                Stage it
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ── per-key actions ─────────────────────────────────────────────────────────
function BlockMenu(props: {
  block: Block
  config: RowSplitConfig
  canSplit: boolean
  /** Why splitting is not on offer (one category of lines, no lines). */
  splitUnavailable?: string | null
  splitBase: string | null
  client: ReturnType<typeof useNivaroClient>
  cols: string[]
  catLabel: (cat: string) => string
  showHistory: boolean
  onHistory: (row: PlanRow) => void
  onSpread: ((row: PlanRow) => void) | null
  onRemove: () => void
  onDone: () => void
  rc: string
}) {
  const {
    block: b,
    config,
    canSplit,
    splitUnavailable,
    splitBase,
    client,
    cols,
    catLabel,
    showHistory,
    onHistory,
    onSpread,
    onRemove,
    onDone,
    rc
  } = props
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'menu' | 'split' | 'merge' | 'remove'>('menu')
  useEffect(() => {
    if (open) setPane('menu')
  }, [open])
  const allRows = [...(b.top ? [b.top] : []), ...b.cats]
  const dirty = allRows.some((r) => r.edited || r.isNew)
  const item =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-plan-menu={b.key}
          aria-label={`Actions for ${b.key}`}
          className='rounded p-0.5 text-slate-500 hover:bg-muted hover:text-slate-800 dark:hover:text-slate-100'
        >
          <MoreHorizontal className='h-3.5 w-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        sideOffset={6}
        className={cn('p-1.5', pane === 'split' ? 'w-[440px]' : 'w-[300px]')}
      >
        {pane === 'menu' && (
          <div>
            {b.mode === 'top' && canSplit && (
              <button
                type='button'
                data-plan-split={b.key}
                disabled={dirty}
                onClick={() => setPane('split')}
                className={item}
              >
                <Split className='h-3.5 w-3.5' />
                {config.split_label ?? 'Plan by category'}
              </button>
            )}
            {b.mode === 'top' && !canSplit && splitUnavailable && (
              <div data-plan-split-unavailable className='px-2 py-1.5'>
                <p className='flex items-center gap-2 text-[12.5px] text-slate-400 dark:text-slate-500'>
                  <Split className='h-3.5 w-3.5' />
                  {config.split_label ?? 'Plan by category'}
                </p>
                <p className='mt-0.5 pl-[22px] text-[11px] text-slate-500 dark:text-slate-400'>
                  {splitUnavailable}
                </p>
              </div>
            )}
            {b.mode === 'split' && splitBase && (
              <button
                type='button'
                data-plan-merge={b.key}
                disabled={dirty}
                onClick={() => setPane('merge')}
                className={item}
              >
                <Undo2 className='h-3.5 w-3.5' />
                {config.merge_label ?? 'Merge back to one line'}
              </button>
            )}
            {dirty && (b.mode === 'split' || canSplit) && (
              <p className='px-2 pb-1 text-[11px] text-slate-500 dark:text-slate-400'>
                Save your changes to this block first.
              </p>
            )}
            {onSpread &&
              allRows.map((r) => (
                <button
                  key={r.uid}
                  type='button'
                  data-plan-spread={r.uid}
                  onClick={() => {
                    onSpread(r)
                    setOpen(false)
                  }}
                  className={item}
                >
                  <span className='w-3.5' />
                  {`Spread what is left${r.cat ? ` · ${catLabel(r.cat)}` : ''}`}
                </button>
              ))}
            {showHistory &&
              allRows
                .filter((r) => r.id)
                .map((r) => (
                  <div key={r.uid} className='flex items-center'>
                    <button
                      type='button'
                      onClick={() => {
                        onHistory(r)
                        setOpen(false)
                      }}
                      className={item}
                    >
                      <History className='h-3.5 w-3.5' />
                      {`History${r.cat ? ` · ${catLabel(r.cat)}` : ''}`}
                    </button>
                    <RowWatchButton
                      collection={rc}
                      rowId={r.id as string}
                      rowLabel={`${b.key}${r.cat ? ` ${catLabel(r.cat)}` : ''}`}
                    />
                  </div>
                ))}
            <button
              type='button'
              data-plan-remove={b.key}
              onClick={() => setPane('remove')}
              className={cn(item, 'text-red-700 dark:text-red-300')}
            >
              <Trash2 className='h-3.5 w-3.5' />
              {`Remove ${b.key}`}
            </button>
          </div>
        )}
        {pane === 'remove' && (
          <div className='p-1.5'>
            <p className='text-[12.5px] text-slate-700 dark:text-slate-200'>{`Remove the ${b.key} plan? It leaves with the next Save.`}</p>
            <div className='mt-2 flex justify-end gap-2'>
              <button
                type='button'
                onClick={() => setPane('menu')}
                className='rounded-md px-2.5 py-1 text-[12px] text-slate-600 hover:bg-muted dark:text-slate-300'
              >
                Keep it
              </button>
              <button
                type='button'
                data-plan-remove-confirm
                onClick={() => {
                  onRemove()
                  setOpen(false)
                }}
                className='rounded-md bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white'
              >
                Remove
              </button>
            </div>
          </div>
        )}
        {pane === 'split' && splitBase && b.top && (
          <SplitPane
            block={b}
            config={config}
            splitBase={splitBase}
            client={client}
            cols={cols}
            onCancel={() => setPane('menu')}
            onDone={() => {
              setOpen(false)
              onDone()
            }}
          />
        )}
        {pane === 'merge' && splitBase && (
          <MergePane
            block={b}
            config={config}
            splitBase={splitBase}
            client={client}
            onCancel={() => setPane('menu')}
            onDone={() => {
              setOpen(false)
              onDone()
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function errorText(err: unknown): string {
  const e = err as { response?: { error?: string; message?: string }; message?: string }
  return e?.response?.error ?? e?.response?.message ?? e?.message ?? 'Something went wrong'
}

function SplitPane(props: {
  block: Block
  config: RowSplitConfig
  splitBase: string
  client: ReturnType<typeof useNivaroClient>
  cols: string[]
  onCancel: () => void
  onDone: () => void
}) {
  const { block: b, config, splitBase, client, cols, onCancel, onDone } = props
  const keyValue = Number.isFinite(Number(b.key)) ? Number(b.key) : b.key
  const [shares, setShares] = useState<Record<string, number> | null>(null)
  const [preview, setPreview] = useState<SplitPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const sharesKey = JSON.stringify(shares)
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the shares' content, not identity
  useEffect(() => {
    let live = true
    const t = window.setTimeout(
      () => {
        client
          .request<{ data: SplitPreview }>(
            post(`${splitBase}/split`, {
              [config.key_field]: keyValue,
              preview: true,
              ...(shares ? { shares } : {})
            })
          )
          .then((r) => {
            if (!live) return
            setPreview(r.data)
            setError(null)
            if (!shares)
              setShares(
                Object.fromEntries(
                  r.data.categories.map((c) => [String(c.id), Math.round(c.share * 1000) / 10])
                )
              )
          })
          .catch((e) => live && setError(errorText(e)))
      },
      shares ? 250 : 0
    )
    return () => {
      live = false
      window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharesKey, splitBase])
  const names = preview?.categories.map((c) => c.label).join(' / ') ?? ''
  const defaultReason = `Split the ${b.key} plan into ${names}`
  const apply = async () => {
    setBusy(true)
    try {
      await client.request(
        post(`${splitBase}/split`, {
          [config.key_field]: keyValue,
          shares: shares ?? undefined,
          reason: reason.trim() || defaultReason
        })
      )
      toast.success(`${b.key} is now planned by ${names}`)
      onDone()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const total = (v: Record<string, number>) => cents(cols.reduce((a, c) => a + num(v[c]), 0))
  return (
    <div className='p-1.5' data-plan-split-pane>
      <p className='text-[12.5px] font-semibold text-slate-900 dark:text-slate-100'>{`${config.split_label ?? 'Plan by category'} · ${b.key}`}</p>
      <p className='mt-0.5 text-[11.5px] text-slate-600 dark:text-slate-300'>
        Every period is divided by these shares. Closed periods keep their totals; open ones can be
        changed in the grid afterwards.
      </p>
      {!preview && !error && (
        <div
          className='mt-2 h-16 animate-pulse rounded'
          style={{ background: 'hsl(var(--nvr-skeleton))' }}
        />
      )}
      {preview && (
        <table className='mt-2 w-full text-[12px] tabular-nums'>
          <thead>
            <tr className='text-left text-[10.5px] text-slate-500 dark:text-slate-400'>
              <th className='py-1 font-medium'>Category</th>
              <th className='py-1 text-right font-medium'>Share</th>
              <th className='py-1 text-right font-medium'>{`${b.key} plan`}</th>
              <th className='py-1 text-right font-medium'>Ceiling</th>
            </tr>
          </thead>
          <tbody>
            {preview.categories.map((c) => (
              <tr key={String(c.id)} className='border-t border-slate-100 dark:border-border'>
                <td className='py-1 text-slate-800 dark:text-slate-100'>{c.label}</td>
                <td className='py-1 text-right'>
                  <input
                    data-plan-share={String(c.id)}
                    aria-label={`${c.label} share`}
                    inputMode='decimal'
                    value={shares?.[String(c.id)] ?? ''}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (!Number.isFinite(n) || n < 0) return
                      setShares((prev) => ({ ...(prev ?? {}), [String(c.id)]: n }))
                    }}
                    className='h-6 w-16 rounded border border-slate-200 bg-background px-1.5 text-right text-[12px] outline-none focus:border-slate-400 dark:border-border'
                  />
                  <span className='ml-0.5 text-slate-500'>%</span>
                </td>
                <td className='py-1 text-right text-slate-800 dark:text-slate-100'>
                  {fmtFigure(total(c.values))}
                </td>
                <td className='py-1 text-right text-slate-500 dark:text-slate-400'>
                  {fmtFigure(c.cap)}
                </td>
              </tr>
            ))}
            <tr className='border-t border-slate-200 font-medium dark:border-border'>
              <td className='py-1 text-slate-800 dark:text-slate-100'>
                {config.total_label ?? 'Total'}
              </td>
              <td />
              <td className='py-1 text-right text-slate-800 dark:text-slate-100'>
                {fmtFigure(total(preview.original))}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
      {(error || preview?.blocked) && (
        <p
          role='alert'
          data-plan-split-blocked
          className='mt-1.5 text-[11.5px] font-medium text-red-700 dark:text-red-300'
        >
          {error ?? preview?.blocked}
        </p>
      )}
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={defaultReason}
        rows={2}
        aria-label='Reason'
        className='mt-2 w-full resize-none rounded-md border border-slate-200 bg-background px-2 py-1 text-[12px] text-slate-800 outline-none focus:border-slate-400 dark:border-border dark:text-slate-100'
      />
      <div className='mt-1.5 flex justify-end gap-2'>
        <button
          type='button'
          onClick={onCancel}
          className='rounded-md px-2.5 py-1 text-[12px] text-slate-600 hover:bg-muted dark:text-slate-300'
        >
          Back
        </button>
        <button
          type='button'
          data-plan-split-apply
          disabled={busy || !preview || !!preview.blocked}
          onClick={apply}
          className='rounded-md bg-nvr-cyan px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50'
        >
          {busy ? 'Splitting…' : 'Split it'}
        </button>
      </div>
    </div>
  )
}

function MergePane(props: {
  block: Block
  config: RowSplitConfig
  splitBase: string
  client: ReturnType<typeof useNivaroClient>
  onCancel: () => void
  onDone: () => void
}) {
  const { block: b, config, splitBase, client, onCancel, onDone } = props
  const keyValue = Number.isFinite(Number(b.key)) ? Number(b.key) : b.key
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const defaultReason = `Merged the ${b.key} plan back to one line`
  return (
    <div className='p-1.5' data-plan-merge-pane>
      <p className='text-[12.5px] font-semibold text-slate-900 dark:text-slate-100'>{`${config.merge_label ?? 'Merge back to one line'} · ${b.key}`}</p>
      <p className='mt-0.5 text-[11.5px] text-slate-600 dark:text-slate-300'>
        The category lines are added together, period by period. Their history stays on the record.
      </p>
      {error && (
        <p role='alert' className='mt-1.5 text-[11.5px] font-medium text-red-700 dark:text-red-300'>
          {error}
        </p>
      )}
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={defaultReason}
        rows={2}
        aria-label='Reason'
        className='mt-2 w-full resize-none rounded-md border border-slate-200 bg-background px-2 py-1 text-[12px] text-slate-800 outline-none focus:border-slate-400 dark:border-border dark:text-slate-100'
      />
      <div className='mt-1.5 flex justify-end gap-2'>
        <button
          type='button'
          onClick={onCancel}
          className='rounded-md px-2.5 py-1 text-[12px] text-slate-600 hover:bg-muted dark:text-slate-300'
        >
          Back
        </button>
        <button
          type='button'
          data-plan-merge-apply
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await client.request(
                post(`${splitBase}/merge`, {
                  [config.key_field]: keyValue,
                  reason: reason.trim() || defaultReason
                })
              )
              toast.success(`${b.key} is one line again`)
              onDone()
            } catch (e) {
              setError(errorText(e))
            } finally {
              setBusy(false)
            }
          }}
          className='rounded-md bg-nvr-cyan px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50'
        >
          {busy ? 'Merging…' : 'Merge it'}
        </button>
      </div>
    </div>
  )
}

function AddKeyButton(props: {
  config: RowSplitConfig
  client: ReturnType<typeof useNivaroClient>
  used: Set<string>
  onAdd: (key: string | number) => void
  label: string
}) {
  const { config, client, used, onAdd, label } = props
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const { data: options = [] } = useQuery<Array<string | number>>({
    queryKey: ['plan-grid-keys', config.key_collection],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string | number }> }>(
          get(`/items/${config.key_collection}`, { fields: 'id', sort: '-id', limit: 200 })
        )
        .then((r) => (r.data ?? []).map((x) => x.id)),
    enabled: open && !!config.key_collection,
    staleTime: 10 * 60_000
  })
  const free = options.filter((k) => !used.has(String(k)))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-plan-add
          className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[12px] font-medium text-slate-700 hover:bg-muted dark:border-border dark:text-slate-200'
        >
          <Plus className='h-3.5 w-3.5' />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' sideOffset={6} className='w-[200px] p-1.5'>
        {config.key_collection ? (
          <ul className='max-h-[220px] overflow-y-auto'>
            {free.length === 0 && (
              <li className='px-2 py-1.5 text-[12px] text-slate-500'>Every one is already here.</li>
            )}
            {free.map((k) => (
              <li key={String(k)}>
                <button
                  type='button'
                  data-plan-add-key={String(k)}
                  onClick={() => {
                    onAdd(k)
                    setOpen(false)
                  }}
                  className='w-full rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-slate-200'
                >
                  {String(k)}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const v = typed.trim()
              if (!v || used.has(v)) return
              onAdd(Number.isFinite(Number(v)) ? Number(v) : v)
              setTyped('')
              setOpen(false)
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label={label}
              className='h-7 w-full rounded border border-slate-200 bg-background px-2 text-[12.5px] outline-none focus:border-slate-400 dark:border-border'
            />
          </form>
        )}
      </PopoverContent>
    </Popover>
  )
}
