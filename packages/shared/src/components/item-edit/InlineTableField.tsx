import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronRight,
  Clock,
  FileUp,
  GripHorizontal,
  GripVertical,
  History,
  ListChecks,
  Loader2,
  Lock,
  PanelBottomOpen,
  Rows3,
  SquarePen,
  X
} from 'lucide-react'
import type React from 'react'
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  type ChangeReasonChallenge,
  ChangeReasonDialog,
  changeReasonChallenge
} from './ChangeReasonDialog'

/** A per-row consistency check: when `when` matches, `expect` must too.
 *  Ops: eq | neq | in | null | nnull; values compared as strings (ids for M2O). */
export interface RowLint {
  label: string
  when: { field: string; op?: 'eq' | 'neq' | 'in' | 'null' | 'nnull'; value?: unknown }
  expect: { field: string; op?: 'eq' | 'neq' | 'in' | 'null' | 'nnull'; value?: unknown }
}

function lintCondition(row: Record<string, unknown>, c: RowLint['when']): boolean {
  const v = row[c.field]
  const empty = v === null || v === undefined || v === ''
  const op = c.op ?? 'eq'
  if (op === 'null') return empty
  if (op === 'nnull') return !empty
  if (empty) return false
  const sv =
    typeof v === 'object' && v ? String((v as Record<string, unknown>).id ?? '') : String(v)
  if (op === 'in') {
    const list = Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',')
    return list.map((x) => String(x).trim()).includes(sv)
  }
  const cv = String(c.value ?? '')
  return op === 'neq' ? sv !== cv : sv === cv
}

/** Labels of the lints a row fails. */
export function failingLints(
  row: Record<string, unknown>,
  lints: RowLint[] | null | undefined
): string[] {
  if (!lints?.length) return []
  const out: string[] = []
  for (const l of lints) {
    if (!l?.when?.field || !l?.expect?.field) continue
    if (!lintCondition(row, l.when)) continue
    if (lintCondition(row, l.expect)) continue
    out.push(l.label || `${l.when.field} vs ${l.expect.field}`)
  }
  return out
}

export interface RowRule {
  trigger_field?: string | null
  /** Additional trigger fields — any of them changing fires the rule. */
  trigger_fields?: string[] | null
  trigger_op?: string
  trigger_value?: string | null
  target_field: string
  target_type: 'set' | 'clear' | 'relation_field' | 'precedence' | 'pick' | 'lock'
  target_value?: string | null
  only_if_empty?: boolean
  seed_only?: boolean
  sort?: number
}
export interface ColumnPreset {
  name: string
  columns: string[]
}
export type MatchedDrawerConfig = {
  /** Rows selected by filter instead of an FK to the child row — values may be
   *  '$parent.id', '$parent.<field>', '$row.<field>', or literals; dotted keys
   *  become nested relation filters. Creates are seeded with `defaults`
   *  (same token resolution, plain columns only). */
  collection: string
  filters: Record<string, unknown>
  defaults?: Record<string, unknown>
}

export type DrawerRelationConfig =
  | string
  | { field: string; hint?: { sum_field: string; cap_field: string }; match?: MatchedDrawerConfig }

export type AutoAllocateConfig = {
  /** Button label; defaults to 'Auto allocate'. */
  label?: string
  /** drawer_relations entry (by field name) whose `match` supplies the
   *  existing-allocation query + create defaults for this grid's rows. */
  relation: string
  /** Grid row column holding the required quantity. */
  row_qty_field: string
  /** Quantity column on the allocation rows. */
  alloc_qty_field: string
  /** FK column on allocation rows pointing at a candidate record. */
  fk_field: string
  candidates: {
    collection: string
    /** Same '$parent.*' / '$row.*' token semantics as matched drawer filters. */
    filters: Record<string, unknown>
    /** Server sort, e.g. 'date' for FIFO. */
    sort?: string
    /** Gross capacity per candidate row, e.g. '0 - {{quantity}}'. */
    capacity_formula: string
    /** Candidates with net capacity below this are skipped (default 1). */
    min_capacity?: number
  }
}

import { toast } from 'sonner'
import {
  fieldDrilldownConfig,
  useDrilldown,
  useItemEditAuth,
  useNivaroClient,
  useParentDraft,
  useReimportHandler
} from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { evaluateBoolean, evaluateNumeric } from '../../lib/expression'
import { numericIntlOptions } from '../../lib/format-value'
import { useOptionalRealtime } from '../../lib/realtime'
import { cn, formatRelative, titleCase } from '../../lib/utils'
import { ImportFromFileButton } from '../import/ImportFromFileButton'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { useAddendumO2M, useAddendumView } from './AddendumFieldContext'
import {
  CompareCell,
  type CompareProposal,
  CompareProposalBanner,
  type CompareSeriesConfig,
  CompareStripChips,
  compareColumnClosed,
  compareColumnSum,
  compareRowFor,
  fmtMoney,
  GridStatChip,
  ReconcileAction,
  resolveCompareEndpoint,
  useCompareSeries
} from './CompareSeries'
import { FieldRenderer, resolveOptionFilterTokens } from './FieldRenderer'
import { GridBulkEditDialog } from './GridBulkEditDialog'
import {
  applyDisplayTemplate,
  EMPTY_NESTED_OPS,
  parseJson,
  SENTINEL_FIELDS,
  SYSTEM_FIELDS
} from './helpers'
import { NestedRelationEditor } from './NestedRelationEditor'
import {
  type LiveRowsCtx,
  type StagedRelOps,
  useLiveRows,
  useO2MStaging,
  useStagedRelations
} from './O2MStagingContext'
import { RelationCombobox } from './RelationCombobox'
import { RowCommentButton, useRowCommentCounts } from './RowComments'
import {
  parseImportStamp,
  type RestoreContext,
  RowHistorySheet,
  type RowRevisionEntry
} from './RowHistorySheet'
import {
  RowMatchDot,
  RowMatchPanel,
  type RowMatchPanelConfig,
  rowFromCandidate,
  useRowMatches
} from './RowMatchPanel'
import { RowWatchButton } from './RowWatchButton'
import type { CMSField, CMSRelation, NestedOps } from './types'

// ── ERP error-blob mining (submission_errors) ────────────────────────────────
// Oracle-style ERPs wrap a JSON fragment ("o:errorDetails": [{ detail: … }]) in an
// XML element whose content is HTML-entity-escaped — decode and pull every
// "detail" value; fall back to a tag-stripped copy of the message. Mirrors
// extractErpErrorDetails on the server.
const ERP_XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  amp: '&',
  '#39': "'"
}
/** Amber outline + triangle around a display value the cascade sweep flagged
 *  stale, with an INSTANT hover tooltip (pointer-events-none body portal —
 *  native `title` waits on the OS timer, inline text squishes in cells). */
function StaleValueFlag({ children }: { children: React.ReactNode }) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  return (
    <span
      className='inline-flex max-w-full items-center gap-1 rounded border border-amber-300 bg-amber-50/70 px-1.5 py-0.5 dark:border-amber-500/50 dark:bg-amber-500/10'
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const flipUp = window.innerHeight - r.bottom < 80
        setTip({ x: r.left, y: flipUp ? r.top - 54 : r.bottom + 4 })
      }}
      onMouseLeave={() => setTip(null)}
    >
      <AlertTriangle className='h-3 w-3 shrink-0 text-amber-500' />
      <span className='min-w-0 truncate'>{children}</span>
      {tip &&
        createPortal(
          <div
            style={{ position: 'fixed', left: tip.x, top: tip.y, zIndex: 130 }}
            className='pointer-events-none max-w-[300px] rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-800 shadow-md dark:border-amber-500/40 dark:bg-[#2a2113] dark:text-amber-300'
          >
            Not an available option for the current form values — edit the row to pick another
          </div>,
          document.body
        )}
    </span>
  )
}

function mineErpDetails(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const decoded = raw.replace(
    /&(lt|gt|quot|amp|#39);/g,
    (_, e: string) => ERP_XML_ENTITIES[e] ?? ''
  )
  const out: string[] = []
  const re = /"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null = re.exec(decoded)
  while (m) {
    try {
      out.push(JSON.parse(`"${m[1]}"`) as string)
    } catch {
      out.push(m[1])
    }
    m = re.exec(decoded)
  }
  if (out.length === 0) {
    const flat = decoded
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (flat) out.push(flat.slice(0, 400))
  }
  return out
}

interface RowRevision {
  id: number
  delta: Record<string, unknown> | null
  data: Record<string, unknown>
  timestamp?: string
  action?: string
  comment?: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
}

interface O2MRevisionEntry {
  item_id: string
  action: string
  timestamp: string
  comment?: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  revision_id: number
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
}

/** Per (row, field): who last changed it and when — the cell-history entry. */
type CellProvenance = Record<
  string,
  Record<string, { at: string; who: string; revision_id: number }>
>

const NON_DISPLAY_TYPES = new Set([
  'alias',
  'o2m',
  'm2m',
  'm2a',
  'presentation',
  'group',
  'divider'
])
// Built-in preset sentinel: shows every displayCols entry, no relation summary columns.
// Not a real ColumnPreset — never appears in columnPresets, only in activePreset/default_preset.
const ALL_PRESET_SENTINEL = '__all__'

/**
 * A one-click rewrite of every row in the grid, driven by an aggregate of a
 * related collection.
 *
 * A "Close Out Lines" action is one instance of this shape: for each request
 * line, sum `open_unbilled_amount` across the PO lines pointing at it and, where
 * the line covers that remainder, subtract it. Expressed as config rather than
 * host code so any collection can do the same:
 *
 *   {label:'Close Out Lines', relation:'po_line_items',
 *    aggregate:{field:'open_unbilled_amount', op:'sum'},
 *    guard:'{{amount}} >= {{__agg__}}',
 *    set:{amount:'{{amount}} - {{__agg__}}'}}
 *
 * `{{__agg__}}` is the aggregate for that row (same token match-agg-column
 * uses); every other `{{field}}` reads the row's current value. Rows failing
 * the guard are left exactly as they are.
 *
 * Writes go through the SAME paths a manual cell edit uses, so a staged grid
 * (new record, addendum, save_mode 'pending') stages the change and an
 * immediate grid PATCHes it — the action never invents its own persistence.
 */
export interface GridStatConfig {
  label: string
  /** Expression — `{{$parent.amount}} - {{$sum.total}}`. */
  value: string
  format?: 'currency' | 'number'
  /** 'danger' paints a negative result red (the "over" state). */
  negative?: 'danger'
}

/** Row-editor action: spread a remaining amount across a row's empty fields
 *  (a forecast year's open months). `remaining` is a grid-token expression —
 *  `{{$parent.amount}} - {{$sum.total}}` — evaluated with the row
 *  being edited included in the sums, so spreading once lands the balance on
 *  the target fields and a second click has nothing left. */
export interface GridSpreadConfig {
  fields: string[]
  remaining: string
  label?: string
  /** Fill only empty/zero targets (default true); false = overwrite all. */
  only_empty?: boolean
  format?: 'currency' | 'number'
  /** Shapes offered beside the button (default all: even, front-loaded,
   *  back-loaded, and "like the previous row" when one exists). */
  presets?: SpreadPreset[]
  /** Also offer a grid-level spread over every row's empty targets
   *  (default true). */
  across_rows?: boolean
}

export type SpreadPreset = 'even' | 'front' | 'back' | 'shape'

/** `amount` over `n` slots by shape, cent-rounded with the dust on the last
 *  slot. `shape` weights drive 'shape' (an all-zero shape falls back to even). */
export function spreadAmounts(
  amount: number,
  n: number,
  preset: SpreadPreset,
  shape?: number[]
): number[] {
  if (n <= 0) return []
  let w: number[]
  if (preset === 'front') w = Array.from({ length: n }, (_, i) => n - i)
  else if (preset === 'back') w = Array.from({ length: n }, (_, i) => i + 1)
  else if (preset === 'shape' && shape && shape.some((x) => x > 0))
    w = shape.slice(0, n).map((x) => Math.max(0, x))
  else w = Array.from({ length: n }, () => 1)
  while (w.length < n) w.push(0)
  const total = w.reduce((a, b) => a + b, 0) || 1
  const out: number[] = []
  let used = 0
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      out.push(Math.round((amount - used) * 100) / 100)
    } else {
      const v = Math.floor(((amount * w[i]) / total) * 100) / 100
      out.push(v)
      used += v
    }
  }
  return out
}

export interface GridSumCapConfig {
  /** Column summed over the grid (write-computed columns are derived per row). */
  field: string
  /** Expression for the ceiling — `{{$parent.amount}}`. */
  cap: string
  format?: 'currency' | 'number'
  label?: string
  message?: string
}

export interface RowBulkActionConfig {
  label: string
  /** O2M alias on the ROW's collection pointing at the rows to aggregate. */
  relation: string
  aggregate: { field: string; op?: 'sum' | 'count' | 'min' | 'max' }
  /** Optional per-row condition; rows that fail are skipped untouched. */
  guard?: string
  /** field → formula. */
  set: Record<string, string>
  confirm?: string
  variant?: 'default' | 'danger'
}

/** Rows a grid loads for one parent. Also the point past which a live rollup
 *  refuses to sum, since the set on screen is no longer the whole set. */
const O2M_ROW_LIMIT = 1000

function hashString(v: string): number {
  let h = 0
  for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) | 0
  return h
}

/**
 * Numeric client-side formula for a grid row.
 *
 * Delegates to the shared expression engine (lib/expression.ts) rather than
 * substituting values into the string and `eval`ing the result, which is what
 * this did before: a token whose value was not a bare number could change the
 * shape of the expression instead of just its inputs. `missing: 'zero'` keeps
 * the previous behaviour for every formula already configured — an unset
 * `allocated_total` still reads as 0, not as nothing.
 */
/** A short human handle for one grid row — the watch subscription's label
 *  ("line 3", "2026"); the server names the row properly when it notifies. */
function rowLabelOf(row: Record<string, unknown>): string | null {
  if (row.line_number != null && row.line_number !== '') return `line ${row.line_number}`
  for (const k of ['year', 'name', 'title', 'label', 'number']) {
    const v = row[k]
    if (v != null && v !== '' && typeof v !== 'object') return String(v).slice(0, 60)
  }
  return null
}

export function evalClientFormula(formula: string, row: Record<string, unknown>): number | null {
  return evaluateNumeric(formula, row)
}

/** A parent→child picker cascade. `on_unavailable` opts a rule into the
 *  swap: when the USER changes the parent this session and a row's current
 *  value is no longer offered under the new parent, the row is re-pointed to
 *  the target row that keeps the `keep` columns of the old value and takes
 *  the `replace` columns from the parent's defaults (same entry shape as
 *  pinned_options — `when` gates read parent fields only). The swap runs the
 *  grid's row rules with the child field as the changed field, so every
 *  downstream derivation (category type, ERP category, task…) follows. */
type CascadeSwapConfig = {
  keep?: string[]
  replace: Record<string, PinnedCfg[]>
  label?: string
}
type CascadeRule = { parent_field: string; child_field: string; on_unavailable?: CascadeSwapConfig }
type PinnedCfg = {
  when?: { field: string; op?: string; value?: string | string[] }
  parent_field: string
  parent_collection: string
  source_field: string
  tag?: string
}
type CascadeResolution =
  | { type: 'none'; reason?: string }
  | { type: 'direct_fk'; filter_column: string }
  | { type: 'm2m_junction'; table: string; self_fk: string; filter_fk: string }

function getUniqueKey(row: Record<string, unknown>, fields: string[]): string {
  return fields
    .map((f) => {
      const staged = row[`__m2m_${f}`]
      return String(staged !== undefined ? (staged ?? '') : (row[f] ?? ''))
    })
    .join('\x00')
}

function resolveMatchToken(
  token: unknown,
  rowData: Record<string, unknown>,
  parentId: string | null,
  parentDraft: Record<string, unknown> | undefined
): unknown {
  if (typeof token !== 'string') return token
  if (token === '$parent.id') return parentId
  if (token.startsWith('$parent.')) return parentDraft?.[token.slice('$parent.'.length)]
  if (token.startsWith('$row.')) return rowData[token.slice('$row.'.length)]
  return token
}

/** Build {filter, seed} for a matched drawer relation; null when any filter
 *  token is unresolved (editor renders its saved-row hint instead). */
function buildMatchedDrawer(
  match: MatchedDrawerConfig,
  rowData: Record<string, unknown>,
  parentId: string | null,
  parentDraft: Record<string, unknown> | undefined
): { query: Record<string, unknown>; seed: Record<string, unknown> } | null {
  const query: Record<string, unknown> = {}
  for (const [path, token] of Object.entries(match.filters ?? {})) {
    const v = resolveMatchToken(token, rowData, parentId, parentDraft)
    if (v === null || v === undefined || v === '') return null
    // Logical-operator keys (_or/_and) pass their resolved value through raw
    if (path.startsWith('_')) {
      query[path] = v
      continue
    }
    // Operator objects ({_neq: true}) pass through as the clause itself
    const clause =
      typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { _eq: v }
    if (path.includes('.')) {
      const segs = path.split('.')
      let nested: Record<string, unknown> = clause
      for (let i = segs.length - 1; i >= 1; i--) nested = { [segs[i]]: nested }
      query[segs[0]] = nested
    } else {
      query[path] = clause
    }
  }
  const seed: Record<string, unknown> = {}
  for (const [col, token] of Object.entries(match.defaults ?? {})) {
    const v = resolveMatchToken(token, rowData, parentId, parentDraft)
    if (v !== null && v !== undefined && v !== '') seed[col] = v
  }
  return { query, seed }
}

export type AllocateDrawerConfig = {
  /** Option collection browsed in the drawer (e.g. request_lines). */
  collection: string
  /** Grid FK column that receives the picked option's id. */
  target_field: string
  /** Grid column that receives the entered amount. */
  value_field: string
  title?: string
  value_label?: string
  /** Option filter — same '$parent.<field>' token semantics as option_filter. */
  filter?: Record<string, unknown>
  /** Display columns over the option rows: dotted paths resolve via nested
   *  field expansion; formula entries compute from the option row's values. */
  columns?: Array<
    string | { path?: string; label?: string; format?: string; formula?: string; width?: number }
  >
  /** Group option rows under collapsible headers by this (dotted) path —
   *  e.g. allocation lines grouped by their parent record. Groups start collapsed;
   *  groups containing an existing allocation start expanded. */
  group_by?: string
  /** Per-row allocation ceiling formula (same tokens as column formulas incl.
   *  {{__saved__}} = this row's saved amount): inputs clamp to it on commit
   *  and show invalid state while exceeding it. */
  value_max?: string
}

function walkPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (cur, seg) =>
        cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined,
      obj
    )
}

function fmtDrawerVal(v: unknown, format?: string, colOptions?: unknown): string {
  if (format === 'presence')
    return v !== null && v !== undefined && String(v).trim() !== '' ? 'Yes' : 'No'
  if (v === null || v === undefined || v === '') return '—'
  if (format === 'currency' && Number.isFinite(Number(v)))
    return Number(v).toLocaleString('en-US', numericIntlOptions(colOptions, 'currency'))
  return String(v)
}

/** Allocate-cost-style drawer: browse every eligible option row with
 *  context columns, type an amount per row → grid rows are created/updated/
 *  removed live. Generic over any O2M grid via options.allocate_drawer. */
function AllocateDrawer({
  config,
  relatedCollection,
  manyField,
  parentId,
  rows,
  rowDefaults,
  parentDraft,
  invalidate,
  onLocalWrite,
  staging,
  stagingActive,
  pendingRows,
  pendingEdits,
  pendingDeletes
}: {
  config: AllocateDrawerConfig
  relatedCollection: string
  manyField: string
  parentId: string
  rows: Record<string, unknown>[]
  rowDefaults: Record<string, unknown>
  parentDraft: Record<string, unknown> | undefined
  invalidate: () => void
  /** A live write landed for this grid row (null = a row was created). */
  onLocalWrite?: (rowId: string | null) => void
  /** When stagingActive, drawer edits queue into O2M staging and land with the
   *  outer form's Save — nothing writes immediately. */
  staging?: ReturnType<typeof useO2MStaging>
  stagingActive?: boolean
  pendingRows?: Record<string, unknown>[]
  pendingEdits?: Map<string, Record<string, unknown>>
  pendingDeletes?: Set<string>
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [expandedGroups, setExpandedGroups] = useState<Set<string> | null>(null)

  const columns = useMemo(
    () =>
      (config.columns ?? []).map((c) =>
        typeof c === 'string'
          ? {
              path: c,
              label: undefined as string | undefined,
              format: undefined as string | undefined,
              formula: undefined as string | undefined,
              width: undefined as number | undefined
            }
          : c
      ),
    [config.columns]
  )
  const resolvedFilter = useMemo(
    () => resolveOptionFilterTokens(config.filter, parentDraft, parentId),
    [config.filter, parentDraft, parentId]
  )
  const fetchFields = useMemo(() => {
    const set = new Set<string>(['id'])
    if (config.group_by) set.add(config.group_by)
    const addRef = (ref: string) => {
      // Live tokens ({{__input__}}/{{__saved__}}) are computed client-side,
      // never fetched as columns.
      if (!/^__\w+__$/.test(ref)) set.add(ref)
    }
    for (const c of columns) {
      if (c.path) addRef(c.path)
      for (const m of (c.formula ?? '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) addRef(m[1])
    }
    return [...set].join(',')
  }, [columns, config.group_by])

  const { data: options = [], isFetching } = useQuery<Record<string, unknown>[]>({
    queryKey: [
      'allocate-options',
      config.collection,
      JSON.stringify(resolvedFilter ?? null),
      fetchFields
    ],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${config.collection}`, {
            ...(resolvedFilter ? { filter: JSON.stringify(resolvedFilter) } : {}),
            fields: fetchFields,
            limit: 500
          })
        )
        .then((r) => r.data ?? []),
    enabled: open,
    staleTime: 0
  })

  const rowByOption = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>()
    for (const r of rows) {
      const t = r[config.target_field]
      if (t != null) map.set(String(t), r)
    }
    return map
  }, [rows, config.target_field])

  /** Effective allocation for an option, staging-aware: pending edits win over
   *  saved values, queued deletes read as no allocation, queued new rows count. */
  function effectiveFor(optId: string): {
    savedRow: Record<string, unknown> | undefined
    pendingIdx: number
    amount: number
    deleted: boolean
  } {
    const savedRow = rowByOption.get(optId)
    const savedId = savedRow?.id != null ? String(savedRow.id) : null
    const deleted = !!(savedId && pendingDeletes?.has(savedId))
    const pendingIdx = (pendingRows ?? []).findIndex(
      (r) => String(r[config.target_field]) === optId
    )
    let amount = 0
    if (pendingIdx >= 0) amount = Number((pendingRows ?? [])[pendingIdx][config.value_field]) || 0
    else if (savedRow && !deleted) {
      const edit = savedId ? pendingEdits?.get(savedId) : undefined
      amount =
        Number(
          edit && config.value_field in edit
            ? edit[config.value_field]
            : savedRow[config.value_field]
        ) || 0
    }
    return { savedRow, pendingIdx, amount, deleted }
  }

  async function commit(optionId: string, raw: string, option?: Record<string, unknown>) {
    let amount = raw.trim() === '' ? null : Number(raw)
    if (amount !== null && !Number.isFinite(amount)) return
    if (amount !== null && option) {
      const max = rowMax(option)
      if (max !== null && amount > max) {
        amount = Math.max(0, Math.round(max * 100) / 100)
        setDrafts((d) => ({ ...d, [optionId]: String(amount) }))
      }
    }

    // Staged mode: queue into O2M staging — lands with the outer form's Save
    if (stagingActive && staging) {
      const { savedRow, pendingIdx, deleted } = effectiveFor(optionId)
      const savedId = savedRow?.id != null ? String(savedRow.id) : null
      if (amount === null || amount === 0) {
        if (pendingIdx >= 0) staging.removeRow(relatedCollection, manyField, pendingIdx)
        else if (savedId && !deleted) {
          staging.cancelPendingEdit(relatedCollection, manyField, savedId)
          staging.queueDelete(relatedCollection, manyField, savedId)
        }
      } else if (pendingIdx >= 0) {
        staging.updateRow(relatedCollection, manyField, pendingIdx, {
          ...(pendingRows ?? [])[pendingIdx],
          [config.value_field]: amount
        })
      } else if (savedId) {
        if (deleted) staging.cancelPendingDelete(relatedCollection, manyField, savedId)
        staging.queueEdit(relatedCollection, manyField, savedId, { [config.value_field]: amount })
      } else {
        staging.queueRow(relatedCollection, manyField, {
          ...rowDefaults,
          [config.target_field]: optionId,
          [config.value_field]: amount
        })
      }
      return
    }

    const existing = rowByOption.get(optionId)
    setSavingId(optionId)
    try {
      if (amount === null || amount === 0) {
        if (existing?.id != null)
          await client.request(del(`/items/${relatedCollection}/${existing.id}`))
      } else if (existing?.id != null) {
        if (Number(existing[config.value_field]) !== amount)
          await client.request(
            patch(`/items/${relatedCollection}/${existing.id}`, { [config.value_field]: amount })
          )
      } else {
        await client.request(
          post(`/items/${relatedCollection}`, {
            ...rowDefaults,
            [config.target_field]: optionId,
            [config.value_field]: amount,
            [manyField]: parentId
          })
        )
      }
      onLocalWrite?.(existing?.id != null ? String(existing.id) : null)
      invalidate()
    } catch {
      /* row save errors surface via grid refresh */
    } finally {
      setSavingId(null)
    }
  }

  function evalFormulaNumeric(
    formula: string,
    option: Record<string, unknown>,
    extras: Record<string, number>
  ): number | null {
    // `extras` (__input__ / __saved__ / __agg__) are resolved ahead of the
    // option's own fields, which is what makes an Available-style column react
    // as the user types.
    return evaluateNumeric(formula, (ref) => (ref in extras ? extras[ref] : walkPath(option, ref)))
  }

  // {{__input__}} = the row's live input (draft, else saved); {{__saved__}} =
  // the row's saved amount — lets Available-style columns react as you type.
  function rowExtras(optId: string): Record<string, number> {
    const existing = rowByOption.get(optId)
    const saved = Number(existing?.[config.value_field] ?? 0) || 0
    const draftRaw = drafts[optId]
    const effective = stagingActive ? effectiveFor(optId).amount : saved
    const input = draftRaw !== undefined && draftRaw !== '' ? Number(draftRaw) || 0 : effective
    return { __input__: input, __saved__: saved }
  }

  function evalFormula(formula: string, option: Record<string, unknown>): string {
    const v = evalFormulaNumeric(formula, option, rowExtras(String(option.id)))
    return v === null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  }

  function rowMax(option: Record<string, unknown>): number | null {
    if (!config.value_max) return null
    // Ceiling excludes the live input itself — use saved-only extras
    const existing = rowByOption.get(String(option.id))
    const saved = Number(existing?.[config.value_field] ?? 0) || 0
    return evalFormulaNumeric(config.value_max, option, { __input__: saved, __saved__: saved })
  }

  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(true)}
        className='h-6 px-2.5 rounded border border-[#00ceff]/50 bg-[#00ceff]/5 text-[#0891b2] hover:border-[#00ceff] hover:bg-[#00ceff]/10 transition-colors'
      >
        Allocate…
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side='right' className='w-[92vw] sm:max-w-[1200px] overflow-y-auto p-0'>
          <SheetHeader className='border-b border-slate-200 px-5 py-3'>
            <SheetTitle className='text-[14px]'>{config.title ?? 'Allocate'}</SheetTitle>
          </SheetHeader>
          <div className='p-4'>
            <p className='mb-2 text-[11px] text-slate-400'>
              Enter an amount to allocate a line — clearing it removes the allocation.
            </p>
            {isFetching ? (
              <div className='py-10 text-center'>
                <Loader2 className='inline h-4 w-4 animate-spin text-slate-400' />
              </div>
            ) : options.length === 0 ? (
              <p className='py-10 text-center text-[12px] text-slate-400'>
                No eligible rows for the current record's filters.
              </p>
            ) : (
              <div className='overflow-x-auto rounded-lg border border-slate-200'>
                <table className='w-full text-left text-[12px]'>
                  <thead>
                    <tr className='border-b border-slate-200 bg-slate-50'>
                      {columns.map((c, i) => (
                        <th
                          key={i}
                          className='whitespace-nowrap px-2.5 py-1.5 text-[11px] font-medium text-slate-500'
                        >
                          {c.label ?? titleCase((c.path ?? '').split('.').pop() ?? '')}
                        </th>
                      ))}
                      <th className='whitespace-nowrap px-2.5 py-1.5 text-[11px] font-medium text-slate-500'>
                        {config.value_label ?? 'Allocate'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className='divide-y divide-slate-100'>
                    {(() => {
                      // Grouping: ordered unique group values; expanded set defaults
                      // to groups holding an existing allocation.
                      const groupOf = (o: Record<string, unknown>) =>
                        config.group_by ? String(walkPath(o, config.group_by) ?? '—') : ''
                      let orderedOptions = options
                      let groupsInOrder: string[] = []
                      if (config.group_by) {
                        groupsInOrder = [...new Set(options.map(groupOf))]
                        orderedOptions = groupsInOrder.flatMap((g) =>
                          options.filter((o) => groupOf(o) === g)
                        )
                      }
                      const expanded =
                        expandedGroups ??
                        new Set(
                          options.filter((o) => effectiveFor(String(o.id)).amount > 0).map(groupOf)
                        )
                      const toggle = (g: string) =>
                        setExpandedGroups((prev) => {
                          const next = new Set(prev ?? expanded)
                          if (next.has(g)) next.delete(g)
                          else next.add(g)
                          return next
                        })
                      const out: React.ReactNode[] = []
                      let lastGroup: string | null = null
                      for (const opt of orderedOptions) {
                        const optId = String(opt.id)
                        const g = groupOf(opt)
                        if (config.group_by && g !== lastGroup) {
                          lastGroup = g
                          const members = options.filter((o) => groupOf(o) === g)
                          const allocatedIn = members.filter(
                            (o) => effectiveFor(String(o.id)).amount > 0
                          ).length
                          // Per-column numeric sums in the header row: currency
                          // path columns and formula columns sum across members;
                          // the input column sums live drafts/saved amounts.
                          const summable = columns.map(
                            (c) => !!c.formula || c.format === 'currency'
                          )
                          const firstSum = summable.indexOf(true)
                          const labelSpan = firstSum === -1 ? columns.length : Math.max(1, firstSum)
                          const sumFor = (ci: number): string => {
                            const c = columns[ci]
                            let total = 0
                            for (const m of members) {
                              const v = c.formula
                                ? evalFormulaNumeric(c.formula, m, rowExtras(String(m.id)))
                                : Number(walkPath(m, c.path ?? ''))
                              if (v !== null && Number.isFinite(v)) total += v
                            }
                            return total.toLocaleString('en-US', {
                              style: 'currency',
                              currency: 'USD'
                            })
                          }
                          const inputSum = members.reduce(
                            (t, m) => t + rowExtras(String(m.id)).__input__,
                            0
                          )
                          out.push(
                            <tr
                              key={`__group_${g}`}
                              className='border-b border-slate-200 bg-slate-100/80'
                            >
                              <td colSpan={labelSpan} className='px-2 py-1'>
                                <button
                                  type='button'
                                  onClick={() => toggle(g)}
                                  className='flex w-full items-center gap-1.5 text-left'
                                >
                                  <ChevronRight
                                    className={cn(
                                      'h-3 w-3 shrink-0 text-slate-400 transition-transform',
                                      expanded.has(g) && 'rotate-90'
                                    )}
                                  />
                                  <span className='text-[11.5px] font-semibold text-slate-600'>
                                    {g}
                                  </span>
                                  <span className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500'>
                                    {members.length} line{members.length !== 1 ? 's' : ''}
                                  </span>
                                  {allocatedIn > 0 && (
                                    <span className='rounded-full bg-[#00ceff]/15 px-1.5 py-0.5 text-[10px] font-medium text-[#0891b2]'>
                                      {allocatedIn} allocated
                                    </span>
                                  )}
                                </button>
                              </td>
                              {columns.slice(labelSpan).map((c, i) => (
                                <td
                                  key={i}
                                  className='whitespace-nowrap px-2.5 py-1 text-[11px] font-semibold tabular-nums text-slate-600'
                                >
                                  {summable[labelSpan + i] ? sumFor(labelSpan + i) : ''}
                                </td>
                              ))}
                              <td className='whitespace-nowrap px-2.5 py-1 text-[11px] font-semibold tabular-nums text-[#0891b2]'>
                                {inputSum > 0
                                  ? inputSum.toLocaleString('en-US', {
                                      style: 'currency',
                                      currency: 'USD'
                                    })
                                  : ''}
                              </td>
                            </tr>
                          )
                        }
                        if (config.group_by && !expanded.has(g)) continue
                        const eff = effectiveFor(optId)
                        const existing = eff.amount > 0 ? (eff.savedRow ?? {}) : undefined
                        const current = drafts[optId] ?? (eff.amount > 0 ? String(eff.amount) : '')
                        out.push(
                          <tr key={optId} className={cn(existing && 'bg-[#00ceff]/5')}>
                            {columns.map((c, i) => {
                              const text = c.formula
                                ? evalFormula(c.formula, opt)
                                : fmtDrawerVal(walkPath(opt, c.path ?? ''), c.format)
                              return (
                                <td
                                  key={i}
                                  title={c.width ? text : undefined}
                                  style={c.width ? { maxWidth: c.width } : undefined}
                                  className={cn(
                                    'px-2.5 py-1.5 text-slate-700',
                                    c.width ? 'truncate' : 'whitespace-nowrap'
                                  )}
                                >
                                  {text}
                                </td>
                              )
                            })}
                            <td className='px-2.5 py-1'>
                              <div className='flex items-center gap-1.5'>
                                {(() => {
                                  const max = rowMax(opt)
                                  const exceeds =
                                    max !== null && current !== '' && Number(current) > max
                                  return (
                                    <input
                                      type='number'
                                      min={0}
                                      value={current}
                                      title={
                                        max !== null
                                          ? `Max ${max.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`
                                          : undefined
                                      }
                                      onChange={(e) =>
                                        setDrafts((d) => ({ ...d, [optId]: e.target.value }))
                                      }
                                      onBlur={() => {
                                        if (drafts[optId] !== undefined)
                                          commit(optId, drafts[optId], opt)
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' && drafts[optId] !== undefined)
                                          commit(optId, drafts[optId], opt)
                                      }}
                                      placeholder='0'
                                      className={cn(
                                        'h-7 w-28 rounded border px-2 text-[12px] tabular-nums focus:outline-none focus:ring-1',
                                        exceeds
                                          ? 'border-red-400 bg-red-50 text-red-700 focus:ring-red-400 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300'
                                          : 'border-slate-200 focus:ring-[#00ceff]'
                                      )}
                                    />
                                  )
                                })()}
                                {savingId === optId && (
                                  <Loader2 className='h-3 w-3 animate-spin text-slate-400' />
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      }
                      return out
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

/** Greedy FIFO auto-allocation: for each grid row still short of its required
 *  quantity, walk candidate records in sort order and create/increment
 *  allocation rows until the requirement is met or candidates run dry.
 *  Live writes only (same posture as matched drawer relations). */
/**
 * Toolbar button for a RowBulkActionConfig. Aggregates in ONE query for the
 * whole grid (never one per row), then applies each row's new values through
 * the caller-supplied writer so staging vs immediate stays the grid's call.
 */
function RowBulkActionButton({
  config,
  rows,
  relatedCollection,
  computedWriteFields,
  applyRow
}: {
  config: RowBulkActionConfig
  rows: Record<string, unknown>[]
  relatedCollection: string
  /** Child fields whose value is derived on every write; see run(). */
  computedWriteFields: Map<string, string>
  applyRow: (row: Record<string, unknown>, changes: Record<string, unknown>) => void | Promise<void>
}) {
  const client = useNivaroClient()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const run = async () => {
    setConfirming(false)
    // A write-computed field is recalculated from its formula on every render
    // and again server-side on save, so a value written here would be silently
    // discarded — the row would look untouched and the intended change would be
    // lost. Refuse, and name the inputs to drive instead.
    const derived = Object.keys(config.set).filter((f) => computedWriteFields.has(f))
    if (derived.length > 0) {
      const f = derived[0]
      toast.error(
        `${config.label}: "${f}" is calculated from ${computedWriteFields.get(f)} and cannot be set directly — target those fields instead`,
        { duration: 12000 }
      )
      return
    }
    setBusy(true)
    try {
      // Resolve the alias once: which collection holds the rows to aggregate,
      // and which column points back at this grid's rows.
      const meta = await client
        .request<{ data: { relations?: CMSRelation[] } }>(get(`/collections/${relatedCollection}`))
        .then((r) => r.data)
      const rel = (meta?.relations ?? []).find(
        (r) => r.one_collection === relatedCollection && r.one_field === config.relation
      )
      if (!rel?.many_collection || !rel?.many_field) {
        toast.error(
          `${config.label}: "${config.relation}" is not a relation on ${relatedCollection}`
        )
        return
      }

      const ids = rows.map((r) => r.id).filter((id) => id != null)
      if (ids.length === 0) {
        toast.message(`${config.label}: no saved rows to update`)
        return
      }
      const children = await client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${rel.many_collection}`, {
            filter: JSON.stringify({ [rel.many_field]: { _in: ids } }),
            fields: `id,${rel.many_field},${config.aggregate.field}`,
            limit: '2000'
          })
        )
        .then((r) => r.data ?? [])

      const op = config.aggregate.op ?? 'sum'
      const byParent = new Map<string, number[]>()
      for (const c of children) {
        const key = String(c[rel.many_field!] ?? '')
        const n = Number(c[config.aggregate.field])
        if (!key || Number.isNaN(n)) continue
        byParent.set(key, [...(byParent.get(key) ?? []), n])
      }
      const aggFor = (rowId: unknown) => {
        const vals = byParent.get(String(rowId)) ?? []
        if (op === 'count') return vals.length
        if (vals.length === 0) return 0
        if (op === 'min') return Math.min(...vals)
        if (op === 'max') return Math.max(...vals)
        return vals.reduce((a, b) => a + b, 0)
      }

      let changed = 0
      let skipped = 0
      for (const row of rows) {
        const ctx = { ...row, __agg__: aggFor(row.id) }
        // The guard is evaluated as a real comparison now. It used to be
        // split on an operator regex and each half evaluated separately,
        // because the old arithmetic-only evaluator could not compare — which
        // silently failed on any guard the regex did not match (an `&&`, a
        // parenthesised comparison, a `!=`) by treating it as no guard at all.
        if (config.guard && !evaluateBoolean(config.guard, ctx)) {
          skipped++
          continue
        }
        const changes: Record<string, unknown> = {}
        for (const [field, formula] of Object.entries(config.set)) {
          const val = evalClientFormula(formula, ctx)
          // Round to cents: 400 - 275.04 is 124.95999999999998 in binary
          // floating point, and that dust would be written to the record.
          // Non-finite means the formula divided by a zero or missing field —
          // writing Infinity/NaN would corrupt the row, so leave it alone.
          if (val != null && Number.isFinite(val)) changes[field] = Math.round(val * 100) / 100
        }
        if (Object.keys(changes).length === 0) {
          skipped++
          continue
        }
        await applyRow(row, changes)
        changed++
      }
      toast.success(
        `${config.label}: ${changed} row${changed === 1 ? '' : 's'} updated` +
          (skipped > 0 ? `, ${skipped} unchanged` : '')
      )
    } catch {
      toast.error(`${config.label} failed`)
    } finally {
      setBusy(false)
    }
  }

  if (confirming) {
    return (
      <span className='inline-flex items-center gap-1.5 text-[11px]'>
        <span className='text-slate-600 dark:text-slate-300'>
          {config.confirm ?? 'Apply to all rows?'}
        </span>
        <button
          type='button'
          onClick={() => void run()}
          className='rounded border border-red-200 px-1.5 py-0.5 font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/20'
        >
          Yes
        </button>
        <button
          type='button'
          onClick={() => setConfirming(false)}
          className='rounded border border-slate-200 px-1.5 py-0.5 text-slate-500 hover:bg-slate-50 dark:border-border'
        >
          Cancel
        </button>
      </span>
    )
  }

  return (
    <button
      type='button'
      disabled={busy}
      onClick={() => (config.confirm ? setConfirming(true) : void run())}
      className={cn(
        'rounded px-2 py-0.5 text-[11px] font-medium disabled:opacity-50',
        config.variant === 'danger'
          ? 'border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/20'
          : 'border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
      )}
    >
      {busy ? 'Working…' : config.label}
    </button>
  )
}

function AutoAllocateButton({
  config,
  matchCfg,
  rows,
  parentId,
  parentDraft,
  relatedCollection,
  manyField
}: {
  config: AutoAllocateConfig
  matchCfg: MatchedDrawerConfig
  rows: Record<string, unknown>[]
  parentId: string | null
  parentDraft: Record<string, unknown> | undefined
  relatedCollection: string
  manyField: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)

  const run = async () => {
    if (running) return
    setRunning(true)
    setSummary(null)
    const fk = config.fk_field
    const qtyF = config.alloc_qty_field
    const minCap = config.candidates.min_capacity ?? 1
    const formulaRefs = [
      ...config.candidates.capacity_formula.matchAll(/\{\{\s*(\w+)\s*\}\}/g)
    ].map((m) => m[1])
    // Allocations made THIS run also consume candidate capacity — two grid rows
    // drawing from the same candidate must not both take its full remainder.
    const runningByCandidate: Record<string, number> = {}
    let totalAllocated = 0
    let rowsTouched = 0
    const short: number[] = []
    try {
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri]
        const rowQty = Number(row[config.row_qty_field])
        if (!Number.isFinite(rowQty) || rowQty <= 0) continue
        const built = buildMatchedDrawer(matchCfg, row, parentId, parentDraft)
        if (!built) continue
        const existing = await client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${matchCfg.collection}`, {
              filter: JSON.stringify(built.query),
              fields: `id,${fk},${qtyF}`,
              limit: 500
            })
          )
          .then((r) => r.data ?? [])
        const already = existing.reduce((sum, e) => sum + (Number(e[qtyF]) || 0), 0)
        let left = rowQty - already
        if (left <= 0) continue
        const candQ = buildMatchedDrawer(
          {
            collection: config.candidates.collection,
            filters: config.candidates.filters,
            defaults: {}
          },
          row,
          parentId,
          parentDraft
        )
        if (!candQ) continue
        const cands = await client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${config.candidates.collection}`, {
              filter: JSON.stringify(candQ.query),
              fields: ['id', ...formulaRefs].join(','),
              ...(config.candidates.sort ? { sort: config.candidates.sort } : {}),
              limit: 500
            })
          )
          .then((r) => r.data ?? [])
        if (cands.length === 0) {
          short.push(ri + 1)
          continue
        }
        // Capacity already consumed by allocations across ALL parents.
        const candIds = cands.map((c) => String(c.id))
        const allocRows = await client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${matchCfg.collection}`, {
              filter: JSON.stringify({ [fk]: { _in: candIds } }),
              fields: `${fk},${qtyF}`,
              limit: 2000
            })
          )
          .then((r) => r.data ?? [])
        const allocByCand: Record<string, number> = {}
        for (const a of allocRows) {
          const k = String(a[fk])
          allocByCand[k] = (allocByCand[k] ?? 0) + (Number(a[qtyF]) || 0)
        }
        const before = left
        for (const c of cands) {
          if (left <= 0) break
          const cid = String(c.id)
          const gross = evalClientFormula(config.candidates.capacity_formula, c) ?? 0
          const capacity = gross - (allocByCand[cid] ?? 0) - (runningByCandidate[cid] ?? 0)
          if (capacity < minCap) continue
          const take = Math.min(left, capacity)
          const mine = existing.find((e) => String(e[fk]) === cid)
          if (mine) {
            await client.request(
              patch(`/items/${matchCfg.collection}/${mine.id}`, {
                [qtyF]: (Number(mine[qtyF]) || 0) + take
              })
            )
          } else {
            await client.request(
              post(`/items/${matchCfg.collection}`, { ...built.seed, [fk]: c.id, [qtyF]: take })
            )
          }
          runningByCandidate[cid] = (runningByCandidate[cid] ?? 0) + take
          left -= take
          totalAllocated += take
        }
        if (left < before) rowsTouched++
        if (left > 0) short.push(ri + 1)
      }
      const parts: string[] = []
      parts.push(
        totalAllocated > 0
          ? `Allocated ${totalAllocated.toLocaleString('en-US', { maximumFractionDigits: 2 })} across ${rowsTouched} row${rowsTouched === 1 ? '' : 's'}`
          : 'Nothing to allocate'
      )
      if (short.length > 0)
        parts.push(`short on row${short.length === 1 ? '' : 's'} ${short.join(', ')}`)
      setSummary(parts.join(' — '))
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      qc.invalidateQueries({ queryKey: ['match-agg'] })
    } catch (err) {
      setSummary(`Auto-allocate failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <span className='inline-flex items-center gap-2'>
      <button
        type='button'
        disabled={running}
        onClick={() => void run()}
        className='h-6 px-2.5 rounded border border-[#00ceff] text-[#00ceff] hover:bg-[#00ceff]/10 transition-colors disabled:opacity-50'
      >
        {running ? 'Allocating…' : (config.label ?? 'Auto allocate')}
      </button>
      {summary && <span className='text-[11px] text-slate-500'>{summary}</span>}
    </span>
  )
}

export function InlineTableField({
  relatedCollection,
  manyField,
  parentId,
  parentCollection,
  layoutId,
  showRowRevisions,
  rowComments,
  allowRevisionRestore = true,
  saveMode = 'immediate',
  showLineNumbers = false,
  enableReorder = true,
  parentCascades,
  rowRules,
  columnPresets,
  defaultPreset,
  drawerRelations,
  parentContextFields,
  uniqueBy,
  sortField,
  sortDir = 'asc',
  sectionGroupBy,
  freezeFirstColumn = false,
  rowFilter,
  rowDefaults,
  allocateDrawer,
  autoAllocate,
  rowBulkActions,
  uploadTemplate,
  rowMatchPanel,
  lineSla,
  rowLints,
  stats,
  compareSeries,
  sumCap,
  spreadRemaining,
  submissionErrors,
  prefillParentId,
  parentFieldKey,
  readOnly = false,
  emptyLabel,
  editorMode
}: {
  relatedCollection: string
  manyField: string
  parentId: string
  /** options.editor_mode — where a row's editor renders: 'drawer' (under the
   *  row, the default) or 'split' (docked below the table, arrow keys walk the
   *  rows). A per-user toolbar toggle (localStorage) wins over this. */
  editorMode?: 'drawer' | 'split'
  /** Same table display, but no editing: hides the Add toolbar, + Add row,
   *  row delete/undo, and blocks cell edit entry. */
  readOnly?: boolean
  /** Names the empty state ("No deployments yet") instead of a bare "No rows". */
  emptyLabel?: string
  parentCollection?: string
  layoutId?: number | null
  showRowRevisions?: boolean
  /** Layout-local `row_comments` option — per-row comment threads (#11). */
  rowComments?: boolean
  allowRevisionRestore?: boolean
  saveMode?: 'immediate' | 'pending'
  showLineNumbers?: boolean
  enableReorder?: boolean
  parentCascades?: CascadeRule[]
  rowRules?: RowRule[]
  columnPresets?: ColumnPreset[]
  /** Initial view before the user picks one: a preset name or '__all__'. */
  defaultPreset?: string
  drawerRelations?: DrawerRelationConfig[]
  parentContextFields?: string[]
  uniqueBy?: string[]
  sortField?: string
  sortDir?: 'asc' | 'desc'
  /** Dotted relation path on the child collection (e.g. 'item.category.name'):
   *  saved rows render grouped into collapsible sections by the resolved value. */
  sectionGroupBy?: string
  /** #459 — pin the leading cells + first data column while the grid h-scrolls. */
  freezeFirstColumn?: boolean
  /** Static filter narrowing which child rows this grid shows — flat {col: value}
   *  entries become _eq, object values pass through as filter operators. Lets two
   *  grids on the same relation show disjoint views (e.g. is_osp split). */
  rowFilter?: Record<string, unknown>
  /** Values seeded onto every NEW row created from this grid (e.g. {is_osp: true}). */
  rowDefaults?: Record<string, unknown>
  /** Allocate drawer: browse all eligible options, type amounts. */
  allocateDrawer?: AllocateDrawerConfig
  autoAllocate?: AutoAllocateConfig
  /** Toolbar buttons that rewrite EVERY row in one go from an aggregate of a
   *  related collection — the generic form of a "Close Out Lines" action (reduce
   *  each request line by the open unbilled amount across its PO lines). */
  rowBulkActions?: RowBulkActionConfig[]
  /** Import template NAME — renders that template's upload button in this
   *  grid's toolbar (existing records; wired to ItemEditForm's reimport flow). */
  uploadTemplate?: string
  /** "Which related record is this row matched to, and if not, why" — see
   *  RowMatchPanel (options.row_match_panel). Rendered in the row editor. */
  rowMatchPanel?: RowMatchPanelConfig
  /** options.line_sla — OFF unless enabled; the server reads the real config. */
  lineSla?: { enabled?: boolean; field?: string } | null
  /** options.row_lints — "when X, expect Y" checks judged per row on the client. */
  rowLints?: RowLint[] | null
  /** options.stats — a figure strip above the grid (both modes). Each value is
   *  an expression over `{{$parent.<field>}}` (the parent record's draft),
   *  `{{$sum.<column>}}` (that column summed over the rows on screen, staged
   *  edits and the row being typed into included) and `{{$count}}`. A
   *  negative result reads red when `negative` is 'danger'. */
  stats?: GridStatConfig[] | null
  /** options.compare_series — a second, read-only line of figures under the
   *  cells ("what actually happened" beside the plan) fetched from an endpoint
   *  the layout names; closed columns shade, a verdict chip leads the strip,
   *  each figure opens the rows behind it. See CompareSeries.tsx. */
  compareSeries?: CompareSeriesConfig | null
  /** options.sum_cap — refuse to save/stage a row when `field` summed over the
   *  grid (this row's draft included) would exceed `cap` (same tokens as
   *  stats). The client twin of the server's sum_cap validation rule. */
  sumCap?: GridSumCapConfig | null
  spreadRemaining?: GridSpreadConfig | null
  /** Flag rows a failed ERP push rejected (options.submission_errors) — the
   *  latest failed nivaro_erp_submissions row for the PARENT record is parsed
   *  for "LineNumber N: reason" entries and matching rows tint red with the
   *  reason beneath. `line_field` = the row column holding the pushed line
   *  number (default 'line_number'). Mirrors CatalogPickerField's
   *  submission_errors for catalog grids. */
  submissionErrors?: { line_field?: string }
  prefillParentId?: string
  parentFieldKey?: string
}) {
  const client = useNivaroClient()
  const drill = useDrilldown()
  const qc = useQueryClient()
  const staging = useO2MStaging()
  const liveRows = useLiveRows()
  const stagedRels = useStagedRelations()
  const addendumO2MEntries = useAddendumO2M()[parentFieldKey ?? ''] ?? []
  const isNew = parentId === 'new'
  const parentDraftCtx = useParentDraft()
  const reimportHandler = useReimportHandler()
  const realtime = useOptionalRealtime()

  // ── Editor placement (backlog #4): drawer under the row vs a docked split
  // panel below the table. The per-user choice (localStorage) beats the
  // option; the option beats the default. When the host didn't pass the
  // option through, the PARENT field's own config is consulted (field-level
  // options.editor_mode) — one cached field-config read, shared with the form.
  const editorPrefKey = `nvr_grid_editor_${relatedCollection}_${parentFieldKey ?? manyField}`
  const [editorPref, setEditorPref] = useState<'drawer' | 'split' | null>(() => {
    if (typeof localStorage === 'undefined') return null
    try {
      const v = localStorage.getItem(editorPrefKey)
      return v === 'split' || v === 'drawer' ? v : null
    } catch {
      return null
    }
  })
  const { data: parentFieldCfg } = useQuery<CMSField[]>({
    queryKey: ['field-config', parentCollection ?? '', null],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(get(`/field-config/${parentCollection}`))
        .then((r) => r.data ?? []),
    enabled: editorMode === undefined && !!parentCollection && !!parentFieldKey,
    staleTime: 5 * 60_000
  })
  const configuredEditorMode = useMemo<'drawer' | 'split'>(() => {
    if (editorMode) return editorMode
    const f = parentFieldCfg?.find((c) => c.field === parentFieldKey)
    const opts = f?.options
      ? typeof f.options === 'string'
        ? (() => {
            try {
              return JSON.parse(f.options as string) as Record<string, unknown>
            } catch {
              return {}
            }
          })()
        : (f.options as Record<string, unknown>)
      : {}
    return opts?.editor_mode === 'split' ? 'split' : 'drawer'
  }, [editorMode, parentFieldCfg, parentFieldKey])
  const splitMode = !readOnly && (editorPref ?? configuredEditorMode) === 'split'
  const setEditorPlacement = (mode: 'drawer' | 'split') => {
    setEditorPref(mode)
    try {
      localStorage.setItem(editorPrefKey, mode)
    } catch {
      /* private mode */
    }
  }
  const splitHeightKey = `nvr_grid_split_h_${relatedCollection}`
  const [splitHeight, setSplitHeight] = useState<number>(() => {
    if (typeof localStorage === 'undefined') return 320
    try {
      const n = Number(localStorage.getItem(splitHeightKey))
      return Number.isFinite(n) && n >= 160 ? Math.min(n, 900) : 320
    } catch {
      return 320
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(splitHeightKey, String(splitHeight))
    } catch {
      /* private mode */
    }
  }, [splitHeight, splitHeightKey])
  const splitDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  // Assigned below once the row helpers exist (they sit past the loading
  // early-return); the key listener reads the latest through the ref.
  const moveSelectionRef = useRef<(delta: 1 | -1) => Promise<void>>(async () => {})
  const applyFieldToAllRef = useRef<(target: string, value: unknown) => Promise<void>>(
    async () => {}
  )
  // An apply that arrives while the grid is still loading its rows (the host
  // jumped to this step and asked right away) waits here until they land.
  const pendingApplyRef = useRef<{ target: string; value: unknown } | null>(null)
  const gridReadyRef = useRef(false)
  // "Apply header field to all lines" (backlog #5): a host dispatches window
  // event `nvr:grid-apply-field` {collection: PARENT collection, grid: the
  // O2M field key on the parent (or the child collection name), target: child
  // column, value}. A grid answers only when the parent collection matches
  // (when it knows its parent) AND the grid key is its own field key
  // (parentFieldKey ?? manyField) or its child collection.
  useEffect(() => {
    if (readOnly || typeof window === 'undefined') return
    const onApply = (e: Event) => {
      const d = (
        e as CustomEvent<{
          collection?: string
          grid?: string
          target?: string
          value?: unknown
          handled?: boolean
        }>
      ).detail
      if (!d || typeof d.target !== 'string' || !d.target) return
      if (parentCollection && d.collection !== parentCollection) return
      const gridKey = parentFieldKey ?? manyField
      if (d.grid !== gridKey && d.grid !== relatedCollection) return
      d.handled = true
      if (!gridReadyRef.current) {
        pendingApplyRef.current = { target: d.target, value: d.value ?? null }
        return
      }
      void applyFieldToAllRef.current(d.target, d.value ?? null)
    }
    window.addEventListener('nvr:grid-apply-field', onApply)
    return () => window.removeEventListener('nvr:grid-apply-field', onApply)
  }, [readOnly, parentCollection, parentFieldKey, manyField, relatedCollection])
  // Split mode: ↑/↓ with focus inside the TABLE (never inside an input, a
  // picker or a dialog) walk the selection. Native listener on the wrapper so
  // the rows themselves stay plain table rows.
  useEffect(() => {
    const el = tableWrapRef.current
    if (!el || !splitMode) return
    const onKey = (e: KeyboardEvent) => {
      if (!editStateRef.current) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const t = e.target as HTMLElement | null
      if (!t) return
      const tag = t.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable) return
      if (t.closest('[role="listbox"],[role="combobox"],[data-nvr-combobox-panel],[role="dialog"]'))
        return
      e.preventDefault()
      void moveSelectionRef.current(e.key === 'ArrowDown' ? 1 : -1)
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [splitMode])

  // ── Row selection + bulk edit (backlog #11) ────────────────────────────────
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const toggleSelected = (key: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Per-line submission errors — shares the failure banner's query key/cache.
  const subErrLineField = submissionErrors ? (submissionErrors.line_field ?? 'line_number') : null
  const { data: subErrData } = useQuery<
    Array<{ status: string; last_error: string | null; response?: unknown }>
  >({
    queryKey: ['erp-submissions', parentCollection ?? '', String(parentId)],
    queryFn: () =>
      client
        .request<{
          data: Array<{ status: string; last_error: string | null; response?: unknown }>
        }>(get(`/erp-submissions/${parentCollection}/${encodeURIComponent(String(parentId))}`))
        .then((r) => r.data ?? []),
    enabled: !!submissionErrors && !!parentCollection && !isNew && !!parentId,
    staleTime: 15_000
  })
  const submissionErrorByLine = useMemo(() => {
    const map = new Map<string, string>()
    const latest = subErrData?.[0]
    if (!latest || latest.status !== 'failed') return map
    // PRIMARY source: the stored full response body — last_error is a capped
    // summary and truncates on many-line failures. Oracle repeats the whole
    // detail set in every line's message; the "LineNumber N:" prefix picks
    // each line's own entry.
    const body = latest.response as Record<string, unknown> | null
    const odr =
      body && typeof body === 'object' && Array.isArray(body.orderDetailResponse)
        ? (body.orderDetailResponse as Array<Record<string, unknown>>)
        : []
    for (const d of odr) {
      if (!Array.isArray(d?.orderLineDetails)) continue
      for (const l of d.orderLineDetails as Array<Record<string, unknown>>) {
        const status = typeof l?.lineStatus === 'string' ? l.lineStatus.trim().toUpperCase() : ''
        if (!['ERROR', 'FAILED'].includes(status)) continue
        const n = String(l?.lineNumber ?? '')
        if (!n || map.has(n)) continue
        const mined = mineErpDetails(l?.lineDetailedMessage)
        const own = mined.find((x) =>
          new RegExp(`^Line(?:Number)?\\s*${n}\\s*:`, 'i').test(x.trim())
        )
        const msg = own ?? mined[0]
        if (msg) map.set(n, msg.replace(/^Line(?:Number)?\s*\d+\s*:\s*/i, ''))
      }
    }
    if (map.size > 0 || !latest.last_error) return map
    // Fallback: parse the summary text ("LineNumber N: …" segments joined ' · ').
    for (const seg of latest.last_error.split(' · ')) {
      const m = seg.trim().match(/^Line(?:Number)?\s+(\d+)\s*:\s*(.*)$/i)
      if (m && !map.has(m[1])) map.set(m[1], m[2] || seg.trim())
    }
    return map
  }, [subErrData])

  // Prefill: when rendering inside addendum create form (isNew + prefillParentId),
  // seed staging with the parent record's existing rows once on mount.
  const hasPrefilled = useRef(false)
  const [isPrefilling, setIsPrefilling] = useState(isNew && !!prefillParentId)
  useEffect(() => {
    // hasPrefilled guard: already fetching/fetched — don't touch isPrefilling, let the in-flight fetch resolve it
    if (hasPrefilled.current) return
    if (!isNew || !prefillParentId || !staging) {
      setIsPrefilling(false)
      return
    }
    hasPrefilled.current = true
    client
      .request<{ data: Record<string, unknown>[] }>(
        get(`/items/${relatedCollection}`, {
          filter: JSON.stringify({ [manyField]: { _eq: prefillParentId } }),
          limit: O2M_ROW_LIMIT
        })
      )
      .then((r) => {
        for (const row of r.data ?? [])
          staging.queueRow(relatedCollection, manyField, { __prefilled: true, ...row })
        setIsPrefilling(false)
      })
      .catch(() => setIsPrefilling(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Copy lines from another record (#91): pick a sibling parent record, its
  // rows on THIS relation queue in as pending rows (land on parent save).
  // Audit stamps, ids and the FK are stripped; everything else copies.
  const [copyFromOpen, setCopyFromOpen] = useState(false)
  const COPY_STRIP = useMemo(
    () =>
      new Set([
        'id',
        manyField,
        'user_created',
        'user_updated',
        'date_created',
        'date_updated',
        'created',
        'changed',
        'creator'
      ]),
    [manyField]
  )
  const copyLinesFrom = async (sourceParentId: string) => {
    if (!staging) return
    try {
      const r = await client.request<{ data: Record<string, unknown>[] }>(
        get(`/items/${relatedCollection}`, {
          filter: JSON.stringify({ [manyField]: { _eq: sourceParentId } }),
          limit: O2M_ROW_LIMIT
        })
      )
      const rows = r.data ?? []
      for (const row of rows) {
        const clean: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(row)) {
          if (!COPY_STRIP.has(k) && v != null && typeof v !== 'object') clean[k] = v
        }
        staging.queueRow(relatedCollection, manyField, withNextOrder(clean))
      }
      toast.success(
        rows.length > 0
          ? `${rows.length} line(s) copied in — they save with this record`
          : 'That record has no lines on this table'
      )
      setCopyFromOpen(false)
    } catch {
      toast.error('Could not copy lines')
    }
  }

  // appended to mutation URLs so the API can log activity on the parent record
  const pCtx =
    parentCollection && !isNew
      ? `?parent_collection=${encodeURIComponent(parentCollection)}&parent_id=${encodeURIComponent(parentId)}`
      : ''

  // Row revision history sheet — holds the saved row whose history is open
  const [historyRow, setHistoryRow] = useState<Record<string, unknown> | null>(null)
  const [historyFocus, setHistoryFocus] = useState<number | null>(null)
  const [timelineOpen, setTimelineOpen] = useState(false)
  // Field-level restore sheet
  const [restoringAll, setRestoringAll] = useState(false)
  // Rows deleted this session not yet in server query (pending-mode race condition buffer)

  // Persistent deleted-row query — survives page reload
  const { data: rowRevisions = [], isLoading: revLoading } = useQuery<RowRevision[]>({
    queryKey: ['o2m-row-revisions', relatedCollection, historyRow?.id],
    queryFn: () =>
      client
        .request<{ data: RowRevision[] }>(
          get('/revisions', { collection: relatedCollection, item: String(historyRow?.id) })
        )
        .then((r) => r.data ?? []),
    enabled: !!historyRow?.id,
    staleTime: 15_000
  })

  const { data: timelineResp, isLoading: timelineLoading } = useQuery<{
    data: O2MRevisionEntry[]
    truncated?: boolean
  }>({
    queryKey: ['o2m-field-snapshots', relatedCollection, manyField, parentId],
    queryFn: () =>
      client.request<{ data: O2MRevisionEntry[]; truncated?: boolean }>(
        get('/revisions/o2m-snapshots', {
          collection: relatedCollection,
          many_field: manyField,
          parent_id: parentId
        })
      ),
    enabled: timelineOpen && !isNew,
    staleTime: 15_000
  })
  const timelineEntries = useMemo<RowRevisionEntry[]>(
    () =>
      (timelineResp?.data ?? []).map((e) => ({
        id: e.revision_id,
        delta: e.delta ?? null,
        data: e.data ?? {},
        timestamp: e.timestamp,
        action: e.action,
        comment: e.comment ?? null,
        first_name: e.first_name,
        last_name: e.last_name,
        user_email: e.user_email,
        item_id: String(e.item_id)
      })),
    [timelineResp]
  )

  async function restoreAllTo(timestamp: string) {
    setRestoringAll(true)
    try {
      await client.request(
        post('/revisions/o2m-restore', {
          collection: relatedCollection,
          many_field: manyField,
          parent_id: parentId,
          target_timestamp: timestamp
        })
      )
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      qc.invalidateQueries({
        queryKey: ['o2m-field-snapshots', relatedCollection, manyField, parentId]
      })
      setTimelineOpen(false)
    } catch {
      /* surfaced by the sheet staying open */
    } finally {
      setRestoringAll(false)
    }
  }

  // { rowId, draft } — null = no row editing, 'new' = adding new row
  // Read-only mode also disables row reordering.
  if (readOnly) enableReorder = false
  // biome-ignore lint/style/noParameterAssign: intentional prop override
  // locks = fields the layout's 'lock' row rules currently make read-only for
  // this row (server-evaluated, so they can follow M2O hops like
  // category → sub_category → entity). Refreshed on open and on every edit.
  type LockReason = {
    field: string | null
    related_field: string | null
    op: string
    value: string | null
    reason?: string | null
  }
  type GridEditState = {
    rowId: string
    draft: Record<string, unknown>
    locks?: string[]
    /** Per locked field: the trigger that locked it (server-evaluated). */
    lockReasons?: Record<string, LockReason>
    /** Lock rules exist but their first evaluation for this row hasn't
     *  answered yet — lock TARGETS render disabled until it does, so a field
     *  that is about to lock never accepts a keystroke it will then drop. */
    locksPending?: boolean
    /** What every rule target WOULD be if derived from scratch for the
     *  current draft (server `probe`). Drives the auto / overridden chips and
     *  reset-to-auto; refreshed with every evaluate response. */
    expected?: Record<string, unknown>
    /** Required columns the last save attempt found empty — highlighted until filled. */
    missing?: string[]
  }
  /** Fields a 'lock' rule can make read-only — the ones that wait on the
   *  first lock evaluation before accepting input. */
  const lockTargets = useMemo(
    () =>
      new Set(
        (rowRules ?? [])
          .filter((r) => (r as { target_type?: string }).target_type === 'lock')
          .map((r) => (r as { target_field: string }).target_field)
      ),
    [rowRules]
  )
  const [editState, setEditState] = useState<GridEditState | null>(null)
  const editStateRef = useRef<GridEditState | null>(null)
  // Row presence: tell the host which SAVED row this user is editing right
  // now (window event — the record-presence hook relays it into the record
  // room as a `row:<collection>:<id>` focus, and marks the same row for
  // co-viewers). Pending/new rows have no shared identity yet.
  // #69 — shared cursors: a cell wrapper is tagged `<collection>:<row>:<field>`
  // and its focus/blur rides window `nvr:cell-editing` for the presence host
  // to relay as a `cell:` field, which marks the same cell on co-editors'
  // screens (admin use-record-presence + globals.css).
  const cellKey = (rowId: string | undefined, field: string) =>
    rowId && rowId !== 'new' && !rowId.startsWith('pending:')
      ? `${relatedCollection}:${rowId}:${field}`
      : undefined
  const cellFocusRef = useRef<string | null>(null)
  const emitCell = (cell: string | null, state: 'start' | 'end') => {
    if (!cell || typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('nvr:cell-editing', { detail: { cell, state } }))
  }
  const onCellFocusCapture = (e: React.FocusEvent) => {
    const cell =
      (e.target as HTMLElement | null)
        ?.closest?.('[data-grid-cell]')
        ?.getAttribute('data-grid-cell') ?? null
    if (cell === cellFocusRef.current) return
    if (cellFocusRef.current) emitCell(cellFocusRef.current, 'end')
    cellFocusRef.current = cell
    if (cell) emitCell(cell, 'start')
  }
  const onCellBlurCapture = (e: React.FocusEvent) => {
    const next = (e.relatedTarget as HTMLElement | null)?.closest?.('[data-grid-cell]')
    if (next) return
    if (cellFocusRef.current) emitCell(cellFocusRef.current, 'end')
    cellFocusRef.current = null
  }
  useEffect(
    () => () => {
      if (cellFocusRef.current) emitCell(cellFocusRef.current, 'end')
    },
    []
  )
  const lastEditingRowRef = useRef<string | null>(null)
  useEffect(() => {
    const id = editState?.rowId
    const key =
      id && id !== 'new' && !id.startsWith('pending:') ? `${relatedCollection}:${id}` : null
    if (key === lastEditingRowRef.current) return
    if (typeof window === 'undefined') return
    if (lastEditingRowRef.current)
      window.dispatchEvent(
        new CustomEvent('nvr:row-editing', {
          detail: { row: lastEditingRowRef.current, state: 'end' }
        })
      )
    if (key)
      window.dispatchEvent(
        new CustomEvent('nvr:row-editing', { detail: { row: key, state: 'start' } })
      )
    lastEditingRowRef.current = key
  }, [editState?.rowId, relatedCollection])
  useEffect(
    () => () => {
      if (lastEditingRowRef.current && typeof window !== 'undefined')
        window.dispatchEvent(
          new CustomEvent('nvr:row-editing', {
            detail: { row: lastEditingRowRef.current, state: 'end' }
          })
        )
    },
    []
  )
  // Stale-response guard for /field-rules/evaluate. Every setDraftField bumps
  // the sequence and stamps the edited key; a response only writes a key whose
  // stamp is not NEWER than the request that produced it. Without this a slow
  // evaluate fired by an earlier trigger (category → task autofill, ~2.7s)
  // landed AFTER the user had already re-picked the target and overwrote it.
  const ruleEvalSeqRef = useRef(0)
  const draftKeySeqRef = useRef<{ rowId: string | null; seqs: Map<string, number> }>({
    rowId: null,
    seqs: new Map()
  })
  useEffect(() => {
    editStateRef.current = editState
  }, [editState])
  // Clicking anywhere outside the row editor commits it — same as Save.
  // Portaled layers (combobox panels, Radix poppers, dialogs, overlays) are
  // part of the interaction even though they live outside the table's DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-registers per editState change, so saveEdit's closure is always current
  useEffect(() => {
    if (!editState || readOnly) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      // A DETACHED target means React re-rendered between the click and this
      // listener (a cell swapping display→input on focus does exactly that) —
      // its closest() walks the orphaned subtree and can never find the
      // editor, so an in-editor click read as "outside" and closed the row.
      // Whatever re-rendered under the pointer was part of the interaction.
      if (!t.isConnected) {
        lastDownInsideRef.current = true
        return
      }
      if (
        t.closest('[data-o2m-editing]') ||
        t.closest('[data-radix-popper-content-wrapper]') ||
        t.closest('[data-nvr-combobox-panel]') ||
        t.closest('[role="dialog"]') ||
        t.closest('[data-omx-overlay]')
      ) {
        lastDownInsideRef.current = true
        return
      }
      lastDownInsideRef.current = false
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current)
        blurTimerRef.current = null
      }
      void saveEdit()
    }
    // CAPTURE phase, not bubble: an inner widget calling stopPropagation() on
    // mousedown (pickers, drag handles) swallows a bubble listener entirely —
    // lastDownInsideRef then held a stale `false` and the Windows blur timer
    // (null relatedTarget on non-focusable clicks) closed the row anyway.
    // Capture also runs before React's discrete-event state flush, so the
    // target is still attached when we classify it.
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [editState, readOnly])
  const [saving, setSaving] = useState(false)
  const [uniqueError, setUniqueError] = useState<string | null>(null)
  const [crChallenge, setCrChallenge] = useState<{
    challenge: ChangeReasonChallenge
    retry: (reason: string) => Promise<void>
  } | null>(null)
  const activeView = useAddendumView()
  // Column view preset selection — session-only. Always initializes to the
  // configured default view (then first preset); a clicked preset must NOT
  // stick across reloads.
  const [activePreset, setActivePreset] = useState<string | undefined>(() => {
    if (defaultPreset === ALL_PRESET_SENTINEL) return ALL_PRESET_SENTINEL
    if (defaultPreset && columnPresets?.some((p) => p.name === defaultPreset)) return defaultPreset
    return columnPresets?.[0]?.name
  })
  function selectPreset(name: string) {
    setActivePreset(name)
  }
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Whether the most recent pointer-down landed inside the editing
  // interaction (row, portaled picker panels, dialogs). The blur timer
  // consults this: on Windows, clicking a NON-FOCUSABLE part of the row blurs
  // the input with relatedTarget null, which read as leaving the editor.
  const lastDownInsideRef = useRef(false)
  const isEditorNode = (n: Node | null): boolean => {
    const el = n as HTMLElement | null
    if (!el || !(el instanceof HTMLElement)) return false
    if (!el.isConnected) return true
    return !!(
      el.closest('[data-o2m-editing]') ||
      el.closest('[data-radix-popper-content-wrapper]') ||
      el.closest('[data-nvr-combobox-panel]') ||
      el.closest('[role="dialog"]') ||
      el.closest('[data-omx-overlay]')
    )
  }

  // Auto-detect table-type layout for the related collection when no explicit layoutId is given.
  // This lets Apply Values / Create-with-Defaults zones work without manually linking a layout_id
  // to the O2M field options.
  const { data: autoTableLayout } = useQuery<{ id: number; layout_type: string } | null>({
    queryKey: ['auto-table-layout', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; layout_type: string }> }>(
          get(`/collection-layouts`, { collection: relatedCollection })
        )
        .then((r) => (r.data ?? []).find((l) => l.layout_type === 'table') ?? null),
    enabled: !layoutId,
    staleTime: 5 * 60_000
  })

  const effectiveLayoutId: number | null = layoutId ?? autoTableLayout?.id ?? null

  // Columns ordered by layout assignment when effectiveLayoutId is available
  const { data: cols = [], isLoading: colsLoading } = useQuery<CMSField[]>({
    queryKey: ['field-config', relatedCollection, effectiveLayoutId],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(
          get(
            `/field-config/${relatedCollection}`,
            effectiveLayoutId ? { layout_id: String(effectiveLayoutId) } : undefined
          )
        )
        .then((r) => r.data ?? []),
    staleTime: 60_000
  })

  // Relations for FieldRenderer M2O pickers
  const { data: childRelations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () =>
      client.request<{ data: unknown }>(get(`/collections/${relatedCollection}`)).then((r) => {
        const d = r.data as { relations?: CMSRelation[] }
        return d?.relations ?? []
      }),
    staleTime: 10 * 60_000
  })

  // Fetch layout metadata to get row_order_field
  const { data: layoutMeta } = useQuery<{ row_order_field?: string | null }>({
    queryKey: ['layout-meta', effectiveLayoutId],
    queryFn: () =>
      client
        .request<{ data: { row_order_field?: string | null } }>(
          get(`/collection-layouts/${effectiveLayoutId}`)
        )
        .then((r) => r.data ?? {}),
    enabled: !!effectiveLayoutId,
    staleTime: 5 * 60_000
  })

  const rowOrderField = layoutMeta?.row_order_field ?? null

  const rowFilterClause = useMemo(() => {
    if (!rowFilter || Object.keys(rowFilter).length === 0) return null
    const clauses: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rowFilter)) {
      clauses[k] = v !== null && typeof v === 'object' ? v : { _eq: v }
    }
    return clauses
  }, [rowFilter])

  const rowDefaultSeed = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(rowDefaults ?? {}).filter(
          ([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
        )
      ),
    [rowDefaults]
  )

  const {
    data: rawRows = [],
    isLoading: rowsLoading,
    dataUpdatedAt: rowsUpdatedAt
  } = useQuery<Record<string, unknown>[]>({
    queryKey: [
      'o2m-rows',
      relatedCollection,
      manyField,
      parentId,
      rowFilterClause ? JSON.stringify(rowFilterClause) : ''
    ],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, {
            filter: JSON.stringify(
              rowFilterClause
                ? { _and: [{ [manyField]: { _eq: parentId } }, rowFilterClause] }
                : { [manyField]: { _eq: parentId } }
            ),
            limit: 200
          })
        )
        .then((r) => r.data ?? []),
    enabled: !isNew,
    staleTime: 30_000
  })

  // Who last changed each cell — deltas only, one small map per grid. Keyed
  // on the rows query's freshness so a save refreshes it without every
  // write site having to remember to.
  const { data: provenanceResp } = useQuery<{
    data: CellProvenance
    created: Record<string, { at: string; who: string; comment: string }>
  }>({
    queryKey: ['o2m-cell-provenance', relatedCollection, manyField, parentId, rowsUpdatedAt],
    queryFn: () =>
      client
        .request<{
          data: CellProvenance
          created?: Record<string, { at: string; who: string; comment: string }>
        }>(
          get('/revisions/o2m-cell-provenance', {
            collection: relatedCollection,
            many_field: manyField,
            parent_id: parentId
          })
        )
        .then((r) => ({ data: r.data ?? {}, created: r.created ?? {} })),
    enabled: !!showRowRevisions && !isNew && rawRows.length > 0,
    staleTime: 60_000,
    placeholderData: (prev) => prev
  })
  // Line-level SLA (opt-in): which rows still lack the required field and
  // whether the record's clock is past the threshold. Config is read on the
  // server from the grid's own options — the client only asks.
  const lineSlaOn = !!lineSla?.enabled && typeof lineSla?.field === 'string'
  const { data: lineAging } = useQuery<{
    started_at: string | null
    days: number
    overdue: boolean
    missing_ids: string[]
    overdue_ids: string[]
    threshold_days: number
    label: string
  } | null>({
    queryKey: [
      'line-aging',
      parentCollection ?? '',
      parentFieldKey ?? manyField,
      parentId,
      rowsUpdatedAt
    ],
    queryFn: () =>
      client
        .request<{
          data: {
            started_at: string | null
            days: number
            overdue: boolean
            missing_ids: string[]
            overdue_ids: string[]
            threshold_days: number
            label: string
          } | null
        }>(
          get('/sla/line-aging', {
            collection: parentCollection ?? '',
            field: parentFieldKey ?? manyField,
            parent_id: parentId
          })
        )
        .then((r) => r.data ?? null),
    enabled: lineSlaOn && !isNew && !!parentCollection,
    staleTime: 60_000,
    placeholderData: (prev) => prev
  })
  const lineOverdue = useMemo(
    () => new Set(lineAging?.overdue ? lineAging.overdue_ids : []),
    [lineAging]
  )
  const lineOverdueTip = lineAging?.overdue
    ? `${lineAging.label} still missing · ${lineAging.days} ${lineAging.days === 1 ? 'day' : 'days'} on the clock (limit ${lineAging.threshold_days})`
    : undefined
  const cellProvenance: CellProvenance = provenanceResp?.data ?? {}
  const rowOrigins = provenanceResp?.created ?? {}
  /** "From Bid Import · Sep 8 by Robert" for a line an import created. */
  const importOriginTip = (id: string): string | null => {
    const o = rowOrigins[id]
    if (!o) return null
    const imp = parseImportStamp(o.comment)
    if (!imp) return null
    return `From ${imp.template} · ${formatRelative(o.at)} by ${o.who}`
  }

  // ── Cascade parent → child field filters ──────────────────────────────────
  const cascadeRules = parentCascades ?? []
  const cascadeResolutions = useQueries({
    queries: cascadeRules.map((rule) => ({
      queryKey: [
        'resolve-cascade',
        parentDraftCtx?.collection,
        rule.parent_field,
        relatedCollection,
        rule.child_field
      ],
      queryFn: () =>
        client
          .request<{ data: CascadeResolution }>(
            get('/data-model/resolve-cascade', {
              parent_collection: parentDraftCtx!.collection,
              parent_field: rule.parent_field,
              child_collection: relatedCollection,
              child_field: rule.child_field
            })
          )
          .then((r) => r.data),
      enabled: !!parentDraftCtx?.collection && !!rule.parent_field && !!rule.child_field,
      staleTime: 300_000
    }))
  })

  const fieldCascadeFilters = useMemo(() => {
    const filters: Record<string, Record<string, unknown>> = {}
    if (!parentDraftCtx || !cascadeRules.length) return filters
    cascadeRules.forEach((rule, i) => {
      const resolution = cascadeResolutions[i]?.data
      if (!resolution || resolution.type === 'none') return
      const parentValue = parentDraftCtx.draft[rule.parent_field]
      if (parentValue == null || parentValue === '') return
      if (resolution.type === 'direct_fk') {
        filters[rule.child_field] = { [resolution.filter_column]: { _eq: parentValue } }
      } else if (resolution.type === 'm2m_junction') {
        filters[rule.child_field] = {
          _exists_junction: {
            table: resolution.table,
            self_fk: resolution.self_fk,
            filter_fk: resolution.filter_fk,
            value: parentValue
          }
        }
      }
    })
    return filters
  }, [cascadeRules, cascadeResolutions, parentDraftCtx])

  const isPendingMode = saveMode === 'pending'
  const pendingRows = staging ? staging.getPendingRows(relatedCollection, manyField) : []

  const pendingEdits =
    isPendingMode && staging
      ? staging.getPendingEdits(relatedCollection, manyField)
      : new Map<string, Record<string, unknown>>()

  /** Live drawer snapshots, keyed `${rowKey}|${relationField}` — the full
   *  member list a row's nested editor last reported (staged overlay
   *  included). Feeds rollup/formula overlays and summary columns. */
  const [drawerLiveRows, setDrawerLiveRows] = useState<
    Record<string, Array<Record<string, unknown>>>
  >({})
  // A fresh rows fetch means stored rollups are current again (queued edits
  // flushed / drawer writes recalced) — retire the snapshots so external
  // changes can't be shadowed. Never mid-edit: the open panel's live sums
  // must survive a background refetch.
  useEffect(() => {
    if (!editStateRef.current) setDrawerLiveRows({})
  }, [rowsUpdatedAt])

  const pendingDeletes =
    isPendingMode && staging
      ? staging.getPendingDeletes(relatedCollection, manyField)
      : new Set<string>()

  // Relation-path columns ('purchase_order.workflow.workflow_id'): read-only
  // values resolved server-side in one bulk call and merged into each row for
  // display. Never editable, never saved.
  /** field -> formula, for every child field the server recomputes on write. */
  const computedWriteFields = useMemo(
    () =>
      new Map(
        cols
          .filter((c) => c.computed_type === 'write' && !!c.computed_formula)
          .map((c) => [c.field, String(c.computed_formula)])
      ),
    [cols]
  )
  const relationPathCols = useMemo(
    () =>
      cols
        .filter((c) => c.interface === 'relation-path' && c.field.includes('.'))
        .map((c) => c.field),
    [cols]
  )
  // Matched-aggregate columns ('match-agg-column'): aggregate rows of another
  // collection matched to each grid row by filters ($parent tokens fetch-scope
  // the query once; $row tokens group the fetched rows client-side — the
  // "allocated qty per material by item" pattern). options:
  // { match: {collection, filters}, aggregate?: 'sum'|'count', value_field,
  //   formula?: '{{quantity}} - {{__agg__}}', format?: 'currency' }
  const matchAggCols = useMemo(() => cols.filter((c) => c.interface === 'match-agg-column'), [cols])
  const matchAggConfigs = useMemo(
    () =>
      matchAggCols.map((c) => {
        const opts = c.options
          ? ((typeof c.options === 'string'
              ? (() => {
                  try {
                    return JSON.parse(c.options as string)
                  } catch {
                    return {}
                  }
                })()
              : c.options) as Record<string, unknown>)
          : {}
        const match = (opts.match ?? {}) as {
          collection?: string
          filters?: Record<string, unknown>
        }
        const parentClauses: Record<string, unknown> = {}
        const rowKeys: Array<[string, string]> = []
        let unresolved = false
        for (const [path, token] of Object.entries(match.filters ?? {})) {
          if (typeof token === 'string' && token.startsWith('$row.')) {
            rowKeys.push([path, token.slice('$row.'.length)])
            continue
          }
          const v = resolveMatchToken(token, {}, parentId, parentDraftCtx?.draft)
          if (v === null || v === undefined || v === '') {
            unresolved = true
            continue
          }
          if (path.startsWith('_')) {
            parentClauses[path] = v
            continue
          }
          const clause =
            typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { _eq: v }
          if (path.includes('.')) {
            const segs = path.split('.')
            let nested: Record<string, unknown> = clause
            for (let i = segs.length - 1; i >= 1; i--) nested = { [segs[i]]: nested }
            parentClauses[segs[0]] = nested
          } else {
            parentClauses[path] = clause
          }
        }
        return {
          field: c.field,
          collection: match.collection ?? '',
          parentClauses,
          rowKeys,
          unresolved,
          aggregate: (opts.aggregate as string) ?? 'sum',
          valueField: (opts.value_field as string) ?? '',
          formula: typeof opts.formula === 'string' ? opts.formula : null,
          format: (opts.format as string) ?? null
        }
      }),
    [matchAggCols, parentId, parentDraftCtx?.draft]
  )
  const matchAggResults = useQueries({
    queries: matchAggConfigs.map((cfg) => ({
      queryKey: [
        'match-agg',
        cfg.collection,
        JSON.stringify(cfg.parentClauses),
        cfg.valueField,
        cfg.rowKeys.map(([p]) => p).join('|')
      ],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${cfg.collection}`, {
              filter: JSON.stringify(cfg.parentClauses),
              fields: [
                'id',
                ...(cfg.valueField ? [cfg.valueField] : []),
                ...cfg.rowKeys.map(([p]) => p)
              ].join(','),
              limit: 1000
            })
          )
          .then((r) => r.data ?? []),
      enabled: !cfg.unresolved && !!cfg.collection && !isNew,
      staleTime: 30_000
    }))
  })
  const matchAggData = useMemo(() => {
    const map = new Map<
      string,
      { cfg: (typeof matchAggConfigs)[number]; rows: Record<string, unknown>[] }
    >()
    matchAggConfigs.forEach((cfg, i) => {
      map.set(cfg.field, {
        cfg,
        rows: (matchAggResults[i]?.data as Record<string, unknown>[] | undefined) ?? []
      })
    })
    return map
  }, [matchAggConfigs, matchAggResults])

  // Formula columns ({{a.b.c}} refs) piggyback the same bulk resolve-paths call
  const formulaCols = useMemo(() => cols.filter((c) => c.interface === 'formula-column'), [cols])
  const formulaPathRefs = useMemo(() => {
    const out = new Set<string>()
    for (const c of formulaCols) {
      const opts = c.options
        ? ((typeof c.options === 'string'
            ? (() => {
                try {
                  return JSON.parse(c.options as string)
                } catch {
                  return {}
                }
              })()
            : c.options) as Record<string, unknown>)
        : {}
      const formula = typeof opts.column_formula === 'string' ? opts.column_formula : ''
      for (const m of formula.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
        if (m[1].includes('.')) out.add(m[1])
      }
    }
    return [...out]
  }, [formulaCols])
  // Section grouping resolves its dotted path in the same bulk resolve-paths call
  const resolvePathList = useMemo(() => {
    const base = new Set(relationPathCols)
    for (const p of formulaPathRefs) base.add(p)
    if (sectionGroupBy?.includes('.')) base.add(sectionGroupBy)
    return [...base]
  }, [relationPathCols, formulaPathRefs, sectionGroupBy])
  // Every row on screen that EXISTS in the child table resolves its relation
  // paths: the saved rows, pending rows that carry a real id (an addendum's
  // prefilled proposals keep their source id — the create form is `isNew`
  // yet every line is a real, PO-linked record), and the active addendum
  // view's proposed rows. A brand-new parent's staged rows have no id and
  // resolve nothing, which is why the query keys on the id list rather than
  // on `isNew`.
  const pendingIdsKey = pendingRows
    .map((r) => String((r as Record<string, unknown>).id ?? ''))
    .join(',')
  const resolvePathIds = useMemo(() => {
    const ids = new Set<string>()
    const add = (v: unknown) => {
      const s = v == null ? '' : String(v)
      if (s && !s.startsWith('pending:') && s !== 'new') ids.add(s)
    }
    for (const r of rawRows) add(r.id)
    for (const r of pendingRows) add((r as Record<string, unknown>).id)
    if (activeView !== 'original') {
      const entry = addendumO2MEntries.find((e) => e.addendumId === activeView)
      for (const r of entry?.rows ?? []) add((r as Record<string, unknown>).id)
    }
    return [...ids]
    // biome-ignore lint/correctness/useExhaustiveDependencies: pendingRows is a fresh array per render — its id list is the identity that matters here
  }, [rawRows, pendingIdsKey, activeView, addendumO2MEntries])
  const { data: resolvedPathData } = useQuery<{
    rows: Record<string, Record<string, { value: string; ids: string[] }>>
    targets: Record<string, string | null>
  }>({
    queryKey: [
      'o2m-resolve-paths',
      relatedCollection,
      manyField,
      parentId,
      resolvePathList.join(','),
      resolvePathIds.join(',')
    ],
    queryFn: () =>
      client
        .request<{
          data: {
            rows: Record<string, Record<string, { value: string; ids: string[] }>>
            targets: Record<string, string | null>
          }
        }>(
          get(`/items/${relatedCollection}/resolve-paths`, {
            ids: resolvePathIds.join(','),
            paths: resolvePathList.join(',')
          })
        )
        .then((r) => r.data ?? { rows: {}, targets: {} }),
    enabled: resolvePathList.length > 0 && resolvePathIds.length > 0,
    staleTime: 30_000
  })
  const resolvedPathRows = useMemo(() => {
    if (!resolvedPathData) return undefined
    const flat: Record<string, Record<string, string>> = {}
    for (const [rowId, paths] of Object.entries(resolvedPathData.rows)) {
      flat[rowId] = {}
      for (const [path, pv] of Object.entries(paths)) flat[rowId][path] = pv.value
    }
    return flat
  }, [resolvedPathData])

  const rows = useMemo(() => {
    let sorted = resolvedPathRows
      ? rawRows.map((r) => ({ ...r, ...(resolvedPathRows[String(r.id)] ?? {}) }))
      : rawRows
    if (rowOrderField) {
      const getOrder = (r: Record<string, unknown>): number => {
        const pe = isPendingMode ? pendingEdits.get(String(r.id)) : undefined
        const val = pe?.[rowOrderField] ?? r[rowOrderField]
        return Number(val ?? -1)
      }
      sorted = [...sorted].sort((a, b) => getOrder(a) - getOrder(b))
    }
    if (sortField) {
      sorted = [...sorted].sort((a, b) => {
        const pe_a = isPendingMode ? pendingEdits.get(String(a.id)) : undefined
        const pe_b = isPendingMode ? pendingEdits.get(String(b.id)) : undefined
        const va = pe_a?.[sortField] ?? a[sortField]
        const vb = pe_b?.[sortField] ?? b[sortField]
        let cmp = 0
        if (va == null && vb == null) cmp = 0
        else if (va == null) cmp = 1
        else if (vb == null) cmp = -1
        else if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
        else cmp = String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' })
        return sortDir === 'desc' ? -cmp : cmp
      })
    }
    if (sectionGroupBy && resolvedPathRows) {
      // Stable group sort applied last: keeps inner ordering, clusters rows by
      // section label (alpha), empty values last
      const sec = (r: Record<string, unknown>) => String(r[sectionGroupBy] ?? '').trim()
      sorted = [...sorted].sort((a, b) => {
        const sa = sec(a)
        const sb = sec(b)
        if (sa === sb) return 0
        if (!sa) return 1
        if (!sb) return -1
        return sa.localeCompare(sb, undefined, { sensitivity: 'base' })
      })
    }
    return sorted
  }, [
    rawRows,
    resolvedPathRows,
    rowOrderField,
    isPendingMode,
    pendingEdits,
    sortField,
    sortDir,
    sectionGroupBy
  ])

  // Section grouping (sectionGroupBy): active once resolved values are in
  const sectionsActive = !!sectionGroupBy && !!resolvedPathRows
  // Collapse state is remembered per browser for this grid (collection +
  // field), so a long lines list opens the way it was left.
  const sectionMemoryKey = sectionGroupBy
    ? `nvr_grid_sections:${relatedCollection}:${parentFieldKey ?? manyField}`
    : null
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    if (!sectionMemoryKey || typeof localStorage === 'undefined') return new Set()
    try {
      const raw = localStorage.getItem(sectionMemoryKey)
      const arr = raw ? (JSON.parse(raw) as unknown) : null
      return new Set(Array.isArray(arr) ? arr.map(String) : [])
    } catch {
      return new Set()
    }
  })
  const sectionOf = (r: Record<string, unknown>): string => {
    const v = String(r[sectionGroupBy ?? ''] ?? '').trim()
    return v || 'Uncategorized'
  }
  const toggleSection = (name: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      if (sectionMemoryKey) {
        try {
          localStorage.setItem(sectionMemoryKey, JSON.stringify([...next]))
        } catch {
          /* private mode etc. — memory is a convenience */
        }
      }
      return next
    })
  /** Per-section aggregates for the columns that carry `options.aggregate`,
   *  same math as the footer, over the section's live rows. */
  const sectionSummary = (sectionRows: Record<string, unknown>[]) => {
    const out: Array<{ label: string; text: string }> = []
    for (const c of effectiveCols) {
      const opts = parseJson<Record<string, unknown>>(c.options) ?? {}
      const agg = opts.aggregate as string | undefined
      if (!agg || c.interface === 'formula-column' || c.interface === 'match-agg-column') continue
      const nums = sectionRows
        .map((r) => {
          const rid = String(r.id)
          const merged = pendingEdits.has(rid) ? { ...r, ...pendingEdits.get(rid) } : r
          return Number(applyComputedFields(merged as Record<string, unknown>)[c.field])
        })
        .filter((n) => !Number.isNaN(n))
      let result: number | null = null
      if (agg === 'count') result = sectionRows.length
      else if (nums.length > 0) {
        if (agg === 'sum') result = nums.reduce((a, b) => a + b, 0)
        else if (agg === 'avg') result = nums.reduce((a, b) => a + b, 0) / nums.length
        else if (agg === 'min') result = Math.min(...nums)
        else if (agg === 'max') result = Math.max(...nums)
      }
      if (result === null) continue
      const text =
        opts.format === 'currency'
          ? result.toLocaleString('en-US', {
              ...numericIntlOptions(opts, 'currency'),
              currency: (opts.currency as string) || 'USD'
            })
          : result.toLocaleString(
              'en-US',
              numericIntlOptions(opts, opts.format as string | undefined)
            )
      out.push({ label: c.label || titleCase(c.field), text })
    }
    return out
  }

  const computedWriteCols = useMemo(
    () =>
      cols.filter(
        (c) =>
          c.computed_type === 'write' &&
          typeof c.computed_formula === 'string' &&
          c.computed_formula.trim()
      ),
    [cols]
  )

  function applyComputedFields(draft: Record<string, unknown>): Record<string, unknown> {
    if (!computedWriteCols.length) return draft
    const next = { ...draft }
    for (const cf of computedWriteCols) {
      const result = evalClientFormula(cf.computed_formula as string, next)
      if (result !== null) next[cf.field] = result
    }
    return next
  }

  const SPECIAL_GROUP_KEYS = new Set(['__apply_values__', '__create_with_defaults__'])
  const isM2MIface = (iface: string | null | undefined) =>
    iface === 'select-multiple-m2m' || (iface ?? '').endsWith('-m2m')

  function resolveM2MTarget(c: CMSField): {
    targetCollection: string
    junctionCollection: string
    junctionManyField: string
    junctionOtherField: string
  } | null {
    const r = childRelations.find(
      (rel) =>
        rel.one_collection === relatedCollection &&
        (rel.one_field === c.field ||
          (rel.junction_field != null && rel.many_collection === c.field))
    )
    if (!r) return null
    const companion = childRelations.find(
      (cr) => cr.many_collection === r.many_collection && cr.id !== r.id
    )
    if (!companion?.one_collection || !r.many_collection || !r.many_field || !companion.many_field)
      return null
    return {
      targetCollection: companion.one_collection,
      junctionCollection: r.many_collection,
      junctionManyField: r.many_field,
      junctionOtherField: companion.many_field
    }
  }
  // Rows exactly as shown: saved rows minus staged deletes, with staged edits
  // merged, plus staged new rows — each through applyComputedFields so a
  // derived column (amount = price x quantity) reflects an in-flight edit.
  // Staged state is small (only what the user has touched), so stringifying it
  // per render is cheap — and it is what makes the memo below stable.
  const stagedSignature =
    JSON.stringify([...pendingEdits.entries()]) +
    '|' +
    [...pendingDeletes].sort().join(',') +
    '|' +
    JSON.stringify(pendingRows)

  // ── Row order for NEW rows ─────────────────────────────────────────────
  // A staged row that carries no order value (or one another row already
  // holds) gets the next free number, so the sequence the user built is the
  // sequence the layout's row_order_field sort renders after save. Without
  // this every new line landed as line_number 1 and the server's completion
  // order decided the list (three parallel POSTs came back shuffled).
  const withNextOrder = (
    rowData: Record<string, unknown>,
    extraTaken: number[] = []
  ): Record<string, unknown> => {
    if (!rowOrderField) return rowData
    const taken = new Set<number>(extraTaken)
    for (const r of rows) {
      const v = Number(
        (isPendingMode ? pendingEdits.get(String(r.id))?.[rowOrderField] : undefined) ??
          r[rowOrderField]
      )
      if (Number.isFinite(v)) taken.add(v)
    }
    for (const r of pendingRows) {
      const v = Number(r[rowOrderField])
      if (Number.isFinite(v)) taken.add(v)
    }
    const own = Number(rowData[rowOrderField])
    if (Number.isFinite(own) && own > 0 && !taken.has(own)) return rowData
    let next = 1
    for (const v of taken) if (v >= next) next = v + 1
    return { ...rowData, [rowOrderField]: next }
  }
  /** Stamp a whole batch so each row takes the next free number in turn. */
  const withNextOrders = (batch: Record<string, unknown>[]): Record<string, unknown>[] => {
    const assigned: number[] = []
    return batch.map((rd) => {
      const stamped = withNextOrder(rd, assigned)
      if (rowOrderField) assigned.push(Number(stamped[rowOrderField]))
      return stamped
    })
  }

  const effectiveRowsForRollup = useMemo(() => {
    const base = [
      ...(rows ?? [])
        .filter((r) => !pendingDeletes.has(String(r.id)))
        .map((r) => {
          const rid = String(r.id)
          const merged = pendingEdits.has(rid) ? { ...r, ...pendingEdits.get(rid) } : r
          return applyComputedFields(merged as Record<string, unknown>)
        }),
      ...pendingRows.map((r) => applyComputedFields(r as Record<string, unknown>))
    ]
    // Fold in the row being typed into RIGHT NOW, so a total tracks the number
    // under the cursor instead of waiting for the edit to be committed — which
    // is what "live" means to someone watching both figures at once.
    if (editState) {
      const draft = applyComputedFields({ ...editState.draft })
      const pendingIdx = editState.rowId.startsWith('pending:')
        ? Number(editState.rowId.slice('pending:'.length))
        : -1
      const at =
        pendingIdx >= 0
          ? base.length - pendingRows.length + pendingIdx
          : base.findIndex((r) => String(r.id) === editState.rowId)
      if (at >= 0 && at < base.length) base[at] = draft
    }
    return base
    // biome-ignore lint/correctness/useExhaustiveDependencies: staged state rides in via stagedSignature; the getters return fresh objects each render
  }, [rows, stagedSignature, editState])

  // Addendum view: the rows on screen are the addendum's PROPOSED set, so the
  // live total must sum those — publishing the record's current rows here made
  // a header rollup (Requisition Amount) read the same in every view. A field
  // the addendum does not touch keeps the current rows, matching what renders.
  const rowsForRollup = useMemo(() => {
    if (activeView === 'original') return effectiveRowsForRollup
    const entry = addendumO2MEntries.find((e) => e.addendumId === activeView)
    if (!entry) return effectiveRowsForRollup
    return entry.rows.map((r) => applyComputedFields({ ...r } as Record<string, unknown>))
    // biome-ignore lint/correctness/useExhaustiveDependencies: applyComputedFields is a stable closure over field config
  }, [activeView, addendumO2MEntries, effectiveRowsForRollup])

  // The grid fetches at most O2M_ROW_LIMIT rows. Past that it holds a PARTIAL
  // set, and a total summed from it would be confidently wrong — worse than the
  // stored figure it would replace. Withhold rows instead.
  const rowsTruncated = rawRows.length >= O2M_ROW_LIMIT

  // Token resolver for `options.stats` / `options.sum_cap` expressions:
  // `$parent.<field>` reads the parent record's draft, `$sum.<col>` sums the
  // rows on screen (staged edits + the row being typed into — the same set the
  // live rollups read), `$count` = their number.
  const parentDraftForStats = parentDraftCtx?.draft
  const resolveGridToken = useCallback(
    (path: string): unknown => {
      // An unset parent figure (a rollup with no rows yet) reads as 0, not
      // '—': "PO amount $0" is the honest strip for a workflow with no PO.
      if (path.startsWith('$parent.'))
        return parentDraftForStats?.[path.slice('$parent.'.length)] ?? 0
      if (path.startsWith('$sum.')) {
        const col = path.slice('$sum.'.length)
        return rowsForRollup.reduce((a, r) => a + (Number(r[col]) || 0), 0)
      }
      if (path === '$count') return rowsForRollup.length
      return parentDraftForStats?.[path]
    },
    [parentDraftForStats, rowsForRollup]
  )
  const gridStatValues = useMemo(() => {
    if (!stats?.length) return null
    return stats.map((st) => ({ ...st, result: evaluateNumeric(st.value, resolveGridToken) }))
  }, [stats, resolveGridToken])

  // Comparison series (options.compare_series): the endpoint's `$parent`
  // tokens read the parent draft, so a new record (no id yet) never asks.
  const compareEndpoint = useMemo(
    () =>
      compareSeries?.endpoint
        ? resolveCompareEndpoint(compareSeries.endpoint, parentDraftForStats)
        : null,
    [compareSeries?.endpoint, parentDraftForStats]
  )
  const compareQ = useCompareSeries({
    client,
    endpoint: compareEndpoint,
    enabled: !!compareSeries && !isNew
  })
  const compareData = compareSeries && !isNew ? (compareQ.data ?? null) : null
  const compareLoading = !!compareSeries && !isNew && !!compareEndpoint && compareQ.isLoading
  const compareError = !!compareSeries && !isNew && compareQ.isError
  const compareLabelFor = useCallback(
    (c: { field: string; label?: string | null }) => c.label || titleCase(c.field),
    []
  )
  const { isAdmin: viewerIsAdmin } = useItemEditAuth()
  /** A closed column the endpoint marks locked is read-only for non-admins —
   *  the writer refuses anything but the actual there (the reconcile actions
   *  set exactly that, so they keep working). */
  const closedLockedCell = useCallback(
    (field: string, draft: Record<string, unknown>) =>
      !!compareData?.closed_locked &&
      !viewerIsAdmin &&
      compareData.columns.includes(field) &&
      compareColumnClosed(compareData, draft[compareData.key_field], field),
    [compareData, viewerIsAdmin]
  )
  /** Stage (pending grid) or write (immediate grid) a patch to ONE row with a
   *  change reason — the reconcile / carry-forward / proposal paths. Pending
   *  rows are rewritten in place; the reason rides the row so the form's
   *  change-reason preflight does not ask again for it. */
  const stageAdjust = useCallback(
    async (rowId: string, patchValues: Record<string, unknown>, reason: string) => {
      if (rowId.startsWith('pending:')) {
        const idx = Number(rowId.slice('pending:'.length))
        const cur = pendingRows[idx]
        if (cur && staging)
          staging.updateRow(
            relatedCollection,
            manyField,
            idx,
            applyComputedFields({ ...cur, ...patchValues })
          )
        return
      }
      if (isPendingMode && staging) {
        staging.queueEdit(relatedCollection, manyField, rowId, {
          ...patchValues,
          _change_reason: reason
        })
        return
      }
      try {
        await client.request(
          patch(`/items/${relatedCollection}/${rowId}`, { ...patchValues, _change_reason: reason })
        )
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      } catch (err) {
        toast.error(`Could not save: ${(err as Error)?.message ?? 'unknown error'}`)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingRows, staging, isPendingMode, relatedCollection, manyField, client, qc, parentId]
  )
  // Endpoint proposals (options.compare_series → data.proposals): dismissed
  // per browser, per endpoint + proposal id.
  const dismissKey = compareEndpoint ? `nvr_compare_dismiss:${compareEndpoint}` : null
  const [dismissedProposals, setDismissedProposals] = useState<Set<string>>(() => {
    try {
      if (!dismissKey || typeof window === 'undefined') return new Set()
      return new Set(JSON.parse(window.localStorage.getItem(dismissKey) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const visibleProposals = useMemo(
    () => (compareData?.proposals ?? []).filter((p) => !dismissedProposals.has(p.id)),
    [compareData?.proposals, dismissedProposals]
  )
  /** Dismiss = remembered in this browser; an APPLIED proposal only hides for
   *  the session (a discarded save must bring it back on the next load). */
  const dismissProposal = useCallback(
    (p: CompareProposal, persist = true) => {
      setDismissedProposals((prev) => {
        const next = new Set(prev)
        next.add(p.id)
        try {
          if (persist && dismissKey && typeof window !== 'undefined')
            window.localStorage.setItem(dismissKey, JSON.stringify([...next]))
        } catch {
          /* private mode */
        }
        return next
      })
    },
    [dismissKey]
  )
  /** Apply a proposal: empty, open cells only; a key with no grid row becomes
   *  a staged new row. Filled cells and closed columns are never touched. */
  const applyProposal = useCallback(
    (p: CompareProposal) => {
      if (!compareData) return
      const key = compareData.key_field
      const reason = p.change_reason ?? p.label
      const isBlank = (v: unknown) => v == null || v === '' || Number(v) === 0
      let touched = 0
      const pendingEdits = staging?.getPendingEdits(relatedCollection, manyField) ?? new Map()
      for (const pr of p.rows) {
        const saved = rows.find((r) => String(r[key]) === String(pr.key))
        const pendingIdx = pendingRows.findIndex((r) => String(r[key]) === String(pr.key))
        const base = saved
          ? { ...saved, ...(pendingEdits.get(String(saved.id)) ?? {}) }
          : pendingIdx >= 0
            ? pendingRows[pendingIdx]
            : null
        const values: Record<string, number> = {}
        for (const [col, v] of Object.entries(pr.values)) {
          if (compareColumnClosed(compareData, pr.key, col)) continue
          if (base && !isBlank(base[col])) continue
          values[col] = v
        }
        if (Object.keys(values).length === 0) continue
        touched++
        if (saved) void stageAdjust(String(saved.id), values, reason)
        else if (pendingIdx >= 0) void stageAdjust(`pending:${pendingIdx}`, values, reason)
        else if (staging)
          staging.queueRow(
            relatedCollection,
            manyField,
            withNextOrder(applyComputedFields({ [key]: pr.key, ...values, _change_reason: reason }))
          )
      }
      toast.success(
        touched
          ? `${p.label}: staged on ${touched} ${touched === 1 ? 'row' : 'rows'} — save to keep it`
          : 'Nothing to apply — every suggested cell is already filled or closed'
      )
      dismissProposal(p, false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      compareData,
      rows,
      pendingRows,
      staging,
      relatedCollection,
      manyField,
      stageAdjust,
      dismissProposal
    ]
  )
  /** Grid-level spread: "Left to forecast" over every row's empty, open
   *  targets in row order (rows by the series key when one exists). */
  const spreadAcrossRows = useCallback(
    (preset: SpreadPreset) => {
      if (!spreadRemaining?.fields?.length) return
      const remaining = evaluateNumeric(spreadRemaining.remaining, resolveGridToken)
      const amount =
        remaining == null || !Number.isFinite(remaining) ? 0 : Math.round(remaining * 100) / 100
      if (amount <= 0) return
      const onlyEmpty = spreadRemaining.only_empty !== false
      const isBlank = (v: unknown) => v == null || v === '' || Number(v) === 0
      const pendingEdits = staging?.getPendingEdits(relatedCollection, manyField) ?? new Map()
      const pendingDeletes = staging?.getPendingDeletes(relatedCollection, manyField) ?? new Set()
      const key = compareData?.key_field
      const entries: Array<{ id: string; row: Record<string, unknown> }> = []
      for (const r of rows) {
        const id = String(r.id)
        if (pendingDeletes.has(id)) continue
        entries.push({ id, row: { ...r, ...(pendingEdits.get(id) ?? {}) } })
      }
      pendingRows.forEach((r, i) => entries.push({ id: `pending:${i}`, row: r }))
      if (key) entries.sort((a, b) => Number(a.row[key] ?? 0) - Number(b.row[key] ?? 0))
      const slots: Array<{ id: string; field: string }> = []
      const shape: number[] = []
      for (const e of entries) {
        for (const f of spreadRemaining.fields) {
          if (onlyEmpty && !isBlank(e.row[f])) continue
          if (compareData && compareColumnClosed(compareData, e.row[compareData.key_field], f))
            continue
          slots.push({ id: e.id, field: f })
          shape.push(0)
        }
      }
      if (slots.length === 0) {
        toast.message('Nothing to spread into — every target is filled or closed')
        return
      }
      const amounts = spreadAmounts(
        amount,
        slots.length,
        preset === 'shape' ? 'even' : preset,
        shape
      )
      const perRow = new Map<string, Record<string, number>>()
      slots.forEach((s, i) => {
        const cur = perRow.get(s.id) ?? {}
        cur[s.field] = amounts[i]
        perRow.set(s.id, cur)
      })
      for (const [id, values] of perRow)
        void stageAdjust(
          id,
          values,
          `${spreadRemaining.label ?? 'Spread remaining'} across ${perRow.size} rows`
        )
      toast.success(
        `Spread ${fmtMoney(amount)} over ${slots.length} cells on ${perRow.size} ${perRow.size === 1 ? 'row' : 'rows'}`
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      spreadRemaining,
      resolveGridToken,
      staging,
      relatedCollection,
      manyField,
      compareData,
      rows,
      pendingRows,
      stageAdjust
    ]
  )

  const reportLiveRows = liveRows?.report
  useEffect(() => {
    if (!reportLiveRows) return
    // No cleanup here on purpose. An effect's cleanup runs before EVERY re-run,
    // not just on unmount, so withdrawing the rows here made this alternate
    // set -> delete -> set and never settle ("Maximum update depth exceeded").
    // Withdrawal belongs to the unmount-only effect below.
    if (rowsTruncated || rowsLoading) {
      reportLiveRows(relatedCollection, manyField, null)
      return
    }
    reportLiveRows(relatedCollection, manyField, rowsForRollup)
  }, [reportLiveRows, relatedCollection, manyField, rowsForRollup, rowsTruncated, rowsLoading])

  // Unmount only (a tab closed, the field hidden): stop contributing, so a
  // rollup falls back to the stored value instead of a stale snapshot.
  const withdrawRef = useRef<() => void>(() => {})
  withdrawRef.current = () => reportLiveRows?.(relatedCollection, manyField, null)
  useEffect(() => () => withdrawRef.current(), [])

  // ── Floating picker defaults (options.pinned_options) ─────────────────────
  // [{when:{field,op,value}, parent_field, parent_collection, source_field,
  //   tag}] — when the ROW matches `when` (category_type eq 2 = a materials
  // line), the value the PARENT's linked record holds in `source_field`
  // (workflow.project → projects.default_materials_cifa) is pinned at the top
  // of that column's picker. The parent records are fetched once per grid
  // (shared with the cascade-swap `replace` entries below).
  const pinnedConfigByField = useMemo(() => {
    const out = new Map<string, PinnedCfg[]>()
    for (const c of cols) {
      let o: Record<string, unknown> | null = null
      if (c.options && typeof c.options === 'object') o = c.options as Record<string, unknown>
      else if (typeof c.options === 'string') {
        try {
          o = JSON.parse(c.options) as Record<string, unknown>
        } catch {
          o = null
        }
      }
      const list = Array.isArray(o?.pinned_options) ? (o.pinned_options as PinnedCfg[]) : []
      const valid = list.filter(
        (x) =>
          x &&
          typeof x.parent_field === 'string' &&
          typeof x.parent_collection === 'string' &&
          typeof x.source_field === 'string'
      )
      if (valid.length) out.set(c.field, valid)
    }
    return out
  }, [cols])
  const cascadeSwapCfgs = useMemo(() => {
    const out: PinnedCfg[] = []
    for (const rule of parentCascades ?? []) {
      const rep = rule.on_unavailable?.replace
      if (!rep || typeof rep !== 'object') continue
      for (const list of Object.values(rep))
        if (Array.isArray(list))
          out.push(
            ...list.filter(
              (x) =>
                x &&
                typeof x.parent_field === 'string' &&
                typeof x.parent_collection === 'string' &&
                typeof x.source_field === 'string'
            )
          )
    }
    return out
  }, [parentCascades])
  const pinnedParents = useMemo(() => {
    const want = new Map<string, { collection: string; id: string; fields: Set<string> }>()
    for (const list of [...pinnedConfigByField.values(), cascadeSwapCfgs]) {
      for (const cfg of list) {
        const pid = parentDraftCtx?.draft?.[cfg.parent_field]
        if (pid == null || pid === '' || typeof pid === 'object') continue
        const key = `${cfg.parent_collection}|${String(pid)}`
        if (!want.has(key))
          want.set(key, {
            collection: cfg.parent_collection,
            id: String(pid),
            fields: new Set(['id'])
          })
        want.get(key)?.fields.add(cfg.source_field)
      }
    }
    return [...want.entries()]
  }, [pinnedConfigByField, cascadeSwapCfgs, parentDraftCtx?.draft])
  const pinnedParentQueries = useQueries({
    queries: pinnedParents.map(([key, p]) => ({
      queryKey: ['pinned-parent', p.collection, p.id, [...p.fields].sort().join(',')],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown> }>(
            get(`/items/${p.collection}/${p.id}`, { fields: [...p.fields].join(',') })
          )
          .then((r) => [key, r.data] as const)
          .catch(() => [key, null] as const),
      staleTime: 60_000
    }))
  })
  const pinnedParentRows = useMemo(() => {
    const m = new Map<string, Record<string, unknown> | null>()
    for (const q of pinnedParentQueries) if (q.data) m.set(q.data[0], q.data[1])
    return m
  }, [pinnedParentQueries])
  /** First entry whose `when` matches (row fields off `draft`, `$parent.*`
   *  off the parent draft) AND whose parent record holds a value. */
  const resolveParentDefault = (list: PinnedCfg[], draft: Record<string, unknown>) => {
    for (const cfg of list) {
      if (cfg.when?.field) {
        const v = cfg.when.field.startsWith('$parent.')
          ? parentDraftCtx?.draft?.[cfg.when.field.slice(8)]
          : draft[cfg.when.field]
        const op = cfg.when.op ?? 'eq'
        const want = cfg.when.value
        const sv = v == null ? '' : String(v)
        const hit =
          op === 'nnull'
            ? sv !== ''
            : op === 'null'
              ? sv === ''
              : op === 'neq'
                ? sv !== String(want ?? '')
                : op === 'in'
                  ? (Array.isArray(want)
                      ? want.map(String)
                      : String(want ?? '')
                          .split(',')
                          .map((x) => x.trim())
                    ).includes(sv)
                  : sv === String(want ?? '')
        if (!hit) continue
      }
      const pid = parentDraftCtx?.draft?.[cfg.parent_field]
      if (pid == null || pid === '') continue
      const parent = pinnedParentRows.get(`${cfg.parent_collection}|${String(pid)}`)
      const id = parent?.[cfg.source_field]
      if (id == null || id === '') continue
      return { id, tag: cfg.tag ?? 'Default' }
    }
    return null
  }
  const pinnedOptionFor = (field: string, draft: Record<string, unknown>) => {
    const list = pinnedConfigByField.get(field)
    return list ? resolveParentDefault(list, draft) : null
  }

  const displayCols = cols.filter(
    (c) =>
      !c.hidden &&
      (!NON_DISPLAY_TYPES.has(c.type) || isM2MIface(c.interface)) &&
      c.field !== manyField &&
      c.field !== 'id' &&
      (!effectiveLayoutId || c.layout_assigned === true) &&
      !SENTINEL_FIELDS.has(c.field) &&
      !SPECIAL_GROUP_KEYS.has(c.group_key ?? '')
  )

  // Column view preset: which named subset of displayCols is currently shown.
  // Presets can only FILTER displayCols — they never reveal a column the layout hid.
  // ALL_PRESET_SENTINEL is a built-in view (not a real preset): resolvedPreset stays
  // undefined for it, same as the existing stale-name fallback — both end up showing
  // full displayCols below, but the switcher highlight distinguishes the two (see
  // presetSwitcher: stale names still highlight columnPresets[0], unchanged).
  const resolvedPreset =
    columnPresets && columnPresets.length >= 2 && activePreset !== ALL_PRESET_SENTINEL
      ? columnPresets.find((p) => p.name === activePreset)
      : undefined
  // Membership filter in LAYOUT order — stored preset column order is ignored for
  // child columns; unknown/stale names in preset.columns are silently skipped.
  // A dotted token is EITHER a relation-path / formula column the layout
  // carries as its own field ("po_lines.amount" — kept, filtered like any
  // child column) OR a drawer summary token ("allocations.unit" — rendered
  // synthetically below). Dropping every dotted token hid relation-path
  // columns from every named view; they only ever showed under "All".
  const drawerRelationFields = new Set(
    (drawerRelations ?? []).map((dr) => (typeof dr === 'string' ? dr : dr.field))
  )
  const presetChildFieldSet = resolvedPreset
    ? new Set(
        resolvedPreset.columns.filter((token) => {
          const dot = token.indexOf('.')
          if (dot < 0) return true
          return !drawerRelationFields.has(token.slice(0, dot))
        })
      )
    : null
  const presetCols = presetChildFieldSet
    ? displayCols.filter((c) => presetChildFieldSet.has(c.field))
    : []

  // Relation summary columns: dot tokens ("relationField.memberField") in the ACTIVE
  // preset only, resolved against drawerRelations. Preserve stored pick order.
  const activePresetDotTokens = useMemo(() => {
    if (!resolvedPreset) return [] as { relationField: string; memberField: string }[]
    const tokens: { relationField: string; memberField: string }[] = []
    for (const token of resolvedPreset.columns) {
      const dot = token.indexOf('.')
      if (dot < 0) continue
      const relationField = token.slice(0, dot)
      const memberField = token.slice(dot + 1)
      const inDrawer = drawerRelations?.some(
        (dr) => (typeof dr === 'string' ? dr : dr.field) === relationField
      )
      if (inDrawer) tokens.push({ relationField, memberField })
    }
    return tokens
  }, [resolvedPreset, drawerRelations])

  const summaryRelationFields = useMemo(
    () => [...new Set(activePresetDotTokens.map((t) => t.relationField))],
    [activePresetDotTokens]
  )

  // Resolve each summary relation's grandchild collection/fk the same way
  // NestedRelationEditor does — reusing the already-fetched childRelations.
  const summaryGrandRels = useMemo(() => {
    const map = new Map<string, { grandCollection: string; fkField: string } | null>()
    for (const relationField of summaryRelationFields) {
      const rel = childRelations.find(
        (r) => r.one_collection === relatedCollection && r.one_field === relationField
      )
      map.set(
        relationField,
        rel?.many_collection && rel?.many_field
          ? { grandCollection: rel.many_collection, fkField: rel.many_field }
          : null
      )
    }
    return map
  }, [summaryRelationFields, childRelations, relatedCollection])

  const summaryGrandCollections = useMemo(
    () => [
      ...new Set(
        [...summaryGrandRels.values()]
          .filter((v): v is { grandCollection: string; fkField: string } => !!v)
          .map((v) => v.grandCollection)
      )
    ],
    [summaryGrandRels]
  )

  // Grandchild field-config + relations, batched per distinct grandchild collection.
  // Same query key shape as NestedRelationEditor — shares its cache when a drawer is open.
  const summaryFieldConfigQueries = useQueries({
    queries: summaryGrandCollections.map((gc) => ({
      queryKey: ['field-config', gc, null],
      queryFn: () =>
        client.request<{ data: CMSField[] }>(get(`/field-config/${gc}`)).then((r) => r.data ?? []),
      staleTime: 60_000
    }))
  })
  const summaryRelationsQueries = useQueries({
    queries: summaryGrandCollections.map((gc) => ({
      queryKey: ['collection-meta', gc],
      queryFn: () =>
        client
          .request<{ data: unknown }>(get(`/collections/${gc}`))
          .then((r) => (r.data as { relations?: CMSRelation[] })?.relations ?? []),
      staleTime: 10 * 60_000
    }))
  })
  const summaryFieldsByCollection = useMemo(() => {
    const map = new Map<string, CMSField[]>()
    summaryGrandCollections.forEach((gc, i) => {
      map.set(gc, summaryFieldConfigQueries[i]?.data ?? [])
    })
    return map
  }, [summaryGrandCollections, summaryFieldConfigQueries])
  const summaryRelationsByCollection = useMemo(() => {
    const map = new Map<string, CMSRelation[]>()
    summaryGrandCollections.forEach((gc, i) => {
      map.set(gc, summaryRelationsQueries[i]?.data ?? [])
    })
    return map
  }, [summaryGrandCollections, summaryRelationsQueries])

  // Member field → grandchild M2O relation, per summary relation (for label resolution).
  const grandM2oRelMaps = useMemo(() => {
    const map = new Map<string, Map<string, CMSRelation>>()
    for (const relationField of summaryRelationFields) {
      const grandInfo = summaryGrandRels.get(relationField)
      if (!grandInfo) continue
      const grelations = summaryRelationsByCollection.get(grandInfo.grandCollection) ?? []
      const fieldMap = new Map<string, CMSRelation>()
      for (const t of activePresetDotTokens) {
        if (t.relationField !== relationField) continue
        const rel = grelations.find(
          (r) =>
            r.many_collection === grandInfo.grandCollection &&
            r.many_field === t.memberField &&
            !r.junction_field
        )
        if (rel?.one_collection) fieldMap.set(t.memberField, rel)
      }
      map.set(relationField, fieldMap)
    }
    return map
  }, [summaryRelationFields, summaryGrandRels, summaryRelationsByCollection, activePresetDotTokens])

  // ONE batched members query per distinct summary relation: grandchild rows whose fk
  // matches a visible SAVED row. Nested under the ['o2m-rows', ...] prefix so every
  // existing invalidation call site (incl. NestedRelationEditor's outerGridInvalidateKey)
  // refreshes it for free — staleness matches the grid's own o2m-rows refetch behavior.
  const visibleRowIds = useMemo(() => rows.map((r) => String(r.id)), [rows])
  // Grid virtualization (#205): grids past 150 rows render incrementally — a
  // sentinel row extends the window as it scrolls into view, so a 1,000-row
  // child set never mounts 1,000 rows of inputs at once. Editing/summing are
  // unaffected (they read `rows`, not the DOM).
  // Grid column freeze (#459, opt-in options.freeze_first_column): the grid
  // becomes horizontally scrollable (min-w-max instead of table-fixed) and
  // the leading utility cells + FIRST data column pin left via generated
  // nth-child CSS — one style block instead of touching every row renderer.
  // Pinned cells get an OPAQUE background (the documented pinned-bleed rule);
  // tinted rows lose their tint on pinned cells, a deliberate v1 trade.
  const frozenClass = useMemo(
    () =>
      `nvr-gf-${Math.abs(hashString(`${relatedCollection}:${parentFieldKey ?? manyField}`)) % 100000}`,
    [relatedCollection, parentFieldKey, manyField]
  )
  const frozenCss = useMemo(() => {
    if (!freezeFirstColumn) return null
    const widths: number[] = []
    if (enableReorder && (rowOrderField || isNew || isPendingMode)) widths.push(24)
    if (showLineNumbers) widths.push(32)
    if (isNew || isPendingMode) widths.push(80)
    widths.push(220) // first data column
    let left = 0
    const rules: string[] = []
    widths.forEach((w, i) => {
      rules.push(
        `.${frozenClass} tr > *:nth-child(${i + 1}){position:sticky;left:${left}px;z-index:2;min-width:${w}px;max-width:${i === widths.length - 1 ? 320 : w}px;background:hsl(var(--card, 0 0% 100%))}`
      )
      left += w
    })
    rules.push(`.${frozenClass} thead tr > *:nth-child(-n+${widths.length}){z-index:3}`)
    rules.push(
      `.${frozenClass} tr > *:nth-child(${widths.length}){box-shadow:2px 0 0 0 rgba(100,116,139,0.18)}`
    )
    return rules.join('\n')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    freezeFirstColumn,
    frozenClass,
    enableReorder,
    rowOrderField,
    isNew,
    isPendingMode,
    showLineNumbers
  ])

  const [renderCap, setRenderCap] = useState(150)
  const renderSentinelRef = useRef<HTMLTableRowElement | null>(null)
  useEffect(() => {
    const el = renderSentinelRef.current
    if (!el || rows.length <= renderCap) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setRenderCap((c) => c + 150)
      },
      { rootMargin: '400px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [rows.length, renderCap])
  const rowIdsHash = visibleRowIds.join(',')
  const rowCommentCounts = useRowCommentCounts(
    relatedCollection,
    visibleRowIds,
    !!rowComments && !isNew
  )
  const summaryMembersQueries = useQueries({
    queries: summaryRelationFields.map((relationField) => {
      const grandInfo = summaryGrandRels.get(relationField)
      return {
        queryKey: [
          'o2m-rows',
          relatedCollection,
          manyField,
          parentId,
          'summary-members',
          relationField,
          rowIdsHash
        ],
        queryFn: () => {
          if (!grandInfo) return Promise.resolve([] as Record<string, unknown>[])
          return client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${grandInfo.grandCollection}`, {
                filter: JSON.stringify({ [grandInfo.fkField]: { _in: visibleRowIds } }),
                limit: 1000
              })
            )
            .then((r) => r.data ?? [])
        },
        enabled: !!grandInfo && visibleRowIds.length > 0,
        staleTime: 30_000
      }
    })
  })
  const summaryMembersByRelation = useMemo(() => {
    const map = new Map<string, Map<string, Record<string, unknown>[]>>()
    summaryRelationFields.forEach((relationField, i) => {
      const grandInfo = summaryGrandRels.get(relationField)
      const byRow = new Map<string, Record<string, unknown>[]>()
      if (grandInfo) {
        for (const m of summaryMembersQueries[i]?.data ?? []) {
          const pid = String(m[grandInfo.fkField])
          if (!byRow.has(pid)) byRow.set(pid, [])
          byRow.get(pid)!.push(m)
        }
      }
      map.set(relationField, byRow)
    })
    return map
  }, [summaryRelationFields, summaryGrandRels, summaryMembersQueries])

  // Publish staged GRANDCHILD changes (unit allocations under pending/queued
  // lines) so record-scoped widgets (the Deployments rollup) reflect them
  // before the parent record saves. Created members under an UNSAVED line
  // carry the line's own values as literal dotted keys ('workflow_line.x') —
  // the server resolves those instead of an FK it doesn't have yet.
  const reportStagedRels = stagedRels?.report
  useEffect(() => {
    if (!reportStagedRels || !drawerRelations || drawerRelations.length === 0) return
    const gridKey = `${relatedCollection}.${manyField}`
    const primitiveEntries = (
      row: Record<string, unknown>,
      fk: string
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        if (k.startsWith('__') || k === 'id') continue
        if (v !== null && typeof v === 'object') continue
        out[`${fk}.${k}`] = v
      }
      return out
    }
    const byCollection: Record<string, StagedRelOps> = {}
    for (const dr of drawerRelations) {
      const relField = typeof dr === 'string' ? dr : dr.field
      const grandRel = childRelations.find(
        (r) => r.one_collection === relatedCollection && r.one_field === relField
      )
      if (!grandRel?.many_collection || !grandRel.many_field) continue
      const fk = grandRel.many_field
      const ops: StagedRelOps = { created: [], updated: [], deleted: [] }
      // New (pending) lines: their staged members + the line draft as context.
      for (const row of pendingRows) {
        const members = row[`__o2m_${relField}`]
        if (!Array.isArray(members)) continue
        const lineCtx = primitiveEntries(applyComputedFields(row as Record<string, unknown>), fk)
        for (const m of members as Record<string, unknown>[]) ops.created.push({ ...m, ...lineCtx })
      }
      // Queued edits on saved lines: nested ops ride the queued change set.
      for (const [rowId, changes] of pendingEdits) {
        const nested = changes[`__nested_ops_${relField}`] as NestedOps | undefined
        if (!nested) continue
        const baseRow = rows.find((r) => String(r.id) === rowId)
        const lineCtx = primitiveEntries(
          applyComputedFields({ ...(baseRow ?? {}), ...changes }),
          fk
        )
        for (const m of nested.created ?? []) ops.created.push({ ...m, [fk]: rowId, ...lineCtx })
        for (const u of nested.updated ?? []) ops.updated.push({ id: u.id, values: u.changes })
        for (const d of nested.deleted ?? []) ops.deleted.push(d)
      }
      // Queued line DELETES: drop their members (ids from the summary batch
      // when it's loaded — best effort, the flush makes it exact).
      if (pendingDeletes.size > 0) {
        const byRow = summaryMembersByRelation.get(relField)
        for (const rid of pendingDeletes) {
          for (const m of byRow?.get(String(rid)) ?? []) {
            if (m.id != null) ops.deleted.push(m.id as string | number)
          }
        }
      }
      if (ops.created.length || ops.updated.length || ops.deleted.length) {
        byCollection[grandRel.many_collection] = ops
      }
    }
    reportStagedRels(gridKey, Object.keys(byCollection).length > 0 ? byCollection : null)
    // biome-ignore lint/correctness/useExhaustiveDependencies: pendingRows/pendingEdits/pendingDeletes are fresh getters per render; the report is signature-guarded upstream
  })
  // No unmount withdrawal here (unlike live rows): the report mirrors QUEUED
  // staging, which survives the grid unmounting on a tab switch — the widget
  // must keep reflecting it. ItemEditForm clears the registry when staging
  // flushes or is discarded.

  // Batched M2O label resolution for summary member fields — same batched/shared-cache
  // approach as m2oDisplays below, scoped to grandchild collections + pending-row drafts.
  const summaryM2oLookupIds = useMemo(() => {
    const result = new Map<string, string[]>()
    const push = (oneCollection: string, id: unknown) => {
      if (id == null || id === '') return
      if (!result.has(oneCollection)) result.set(oneCollection, [])
      result.get(oneCollection)!.push(String(id))
    }
    for (const [relationField, byRow] of summaryMembersByRelation) {
      const fieldMap = grandM2oRelMaps.get(relationField)
      if (!fieldMap || fieldMap.size === 0) continue
      for (const members of byRow.values()) {
        for (const m of members) {
          for (const [memberField, rel] of fieldMap) {
            if (rel.one_collection) push(rel.one_collection, m[memberField])
          }
        }
      }
      for (const row of pendingRows) {
        const staged = row[`__o2m_${relationField}`]
        if (!Array.isArray(staged)) continue
        for (const m of staged as Record<string, unknown>[]) {
          for (const [memberField, rel] of fieldMap) {
            if (rel.one_collection) push(rel.one_collection, m[memberField])
          }
        }
      }
      // Staged member changes on SAVED rows (queued nested ops + live drawer
      // snapshots) may reference records the fetched members never did —
      // their labels must resolve too.
      for (const [, changes] of pendingEdits) {
        const ops = changes[`__nested_ops_${relationField}`] as NestedOps | undefined
        if (!ops) continue
        for (const m of [...(ops.created ?? []), ...(ops.updated ?? []).map((u) => u.changes)]) {
          for (const [memberField, rel] of fieldMap) {
            if (rel.one_collection)
              push(rel.one_collection, (m as Record<string, unknown>)[memberField])
          }
        }
      }
      for (const [key, snapRows] of Object.entries(drawerLiveRows)) {
        if (!key.endsWith(`|${relationField}`)) continue
        for (const m of snapRows) {
          for (const [memberField, rel] of fieldMap) {
            if (rel.one_collection) push(rel.one_collection, m[memberField])
          }
        }
      }
    }
    for (const [k, ids] of result) result.set(k, [...new Set(ids)].sort())
    return result
  }, [summaryMembersByRelation, grandM2oRelMaps, pendingRows, pendingEdits, drawerLiveRows])

  const { data: summaryM2oDisplays = {} } = useQuery<Record<string, Record<string, string>>>({
    queryKey: [
      'summary-m2o-display',
      relatedCollection,
      ...Array.from(summaryM2oLookupIds.entries()).flat(2)
    ],
    queryFn: async () => {
      const result: Record<string, Record<string, string>> = {}
      await Promise.all(
        [...summaryM2oLookupIds.entries()].map(async ([oneCollection, ids]) => {
          const [metaRes, itemsRes] = await Promise.all([
            client.request<{ data: { display_template?: string | null } }>(
              get(`/collections/${oneCollection}`)
            ),
            client.request<{ data: Record<string, unknown>[] }>(
              get(`/items/${oneCollection}`, {
                filter: JSON.stringify({ id: { _in: ids } }),
                limit: ids.length
              })
            )
          ])
          result[oneCollection] = {}
          for (const item of itemsRes.data ?? []) {
            result[oneCollection][String(item.id)] = applyDisplayTemplate(
              metaRes.data?.display_template,
              item
            )
          }
        })
      )
      return result
    },
    enabled: summaryM2oLookupIds.size > 0,
    staleTime: 60_000
  })

  // Synthetic read-only columns appended AFTER child columns. field = "relationField.memberField"
  // (the dot is the discriminator effectiveCols.map() sites use to detect a summary column —
  // real CMSField.field values are plain identifiers and never contain one).
  const summaryCols = useMemo<CMSField[]>(
    () =>
      activePresetDotTokens.map(({ relationField, memberField }) => {
        const grandInfo = summaryGrandRels.get(relationField)
        const grandFields = grandInfo
          ? (summaryFieldsByCollection.get(grandInfo.grandCollection) ?? [])
          : []
        const grandField = grandFields.find((f) => f.field === memberField)
        return {
          field: `${relationField}.${memberField}`,
          type: 'presentation',
          interface: null,
          label: grandField?.label ?? titleCase(memberField),
          required: false,
          hidden: false,
          readonly: true,
          sort: 0,
          group_key: null,
          options: null,
          computed_formula: null,
          computed_type: null,
          note: null,
          placeholder: null,
          repeater_schema: null,
          dependency_config: null
        }
      }),
    [activePresetDotTokens, summaryGrandRels, summaryFieldsByCollection]
  )

  // Synthetic preset summary columns only (type 'presentation') — relation-path
  // layout columns also carry dotted fields but render through renderCell.
  function isSummaryCol(c: CMSField): boolean {
    return c.type === 'presentation' && c.field.includes('.')
  }

  /** A row's CURRENT member list for a relation, staged-aware: pending rows
   *  read their `__o2m_` draft, saved rows prefer the live drawer snapshot,
   *  then the fetched members overlaid with any queued `__nested_ops_`
   *  (created/updated/deleted) — so the Deployment summary columns reflect
   *  unit/allocation changes before the parent saves. */
  function effectiveMembersFor(
    relationField: string,
    sourceRow: Record<string, unknown>,
    isPendingRow: boolean
  ): Record<string, unknown>[] {
    if (isPendingRow) {
      const staged = sourceRow[`__o2m_${relationField}`]
      return Array.isArray(staged) ? (staged as Record<string, unknown>[]) : []
    }
    const rid = String(sourceRow.id)
    const snap = drawerLiveRows[`${rid}|${relationField}`]
    if (snap) return snap
    const base = summaryMembersByRelation.get(relationField)?.get(rid) ?? []
    const ops = pendingEdits.get(rid)?.[`__nested_ops_${relationField}`] as NestedOps | undefined
    if (!ops) return base
    const deleted = new Set((ops.deleted ?? []).map(String))
    const updatedById = new Map((ops.updated ?? []).map((u) => [String(u.id), u.changes]))
    return [
      ...base
        .filter((m) => !deleted.has(String(m.id)))
        .map((m) =>
          updatedById.has(String(m.id)) ? { ...m, ...updatedById.get(String(m.id)) } : m
        ),
      ...(ops.created ?? [])
    ]
  }

  // Joined ', ' display for a summary column against one row. Saved rows read the batched
  // members query; pending (unsaved) rows read their staged `__o2m_<relationField>` draft.
  function summaryCellValue(
    c: CMSField,
    sourceRow: Record<string, unknown>,
    isPendingRow: boolean
  ): string {
    const dot = c.field.indexOf('.')
    if (dot < 0) return '—'
    const relationField = c.field.slice(0, dot)
    const memberField = c.field.slice(dot + 1)
    const members = effectiveMembersFor(relationField, sourceRow, isPendingRow)
    if (members.length === 0) return '—'
    const rel = grandM2oRelMaps.get(relationField)?.get(memberField)
    const parts = members
      .map((m) => {
        const v = m[memberField]
        if (v == null || v === '') return null
        if (rel?.one_collection)
          return summaryM2oDisplays[rel.one_collection]?.[String(v)] ?? String(v)
        return String(v)
      })
      .filter((v): v is string => !!v)
    return parts.length > 0 ? parts.join(', ') : '—'
  }

  /** Saved-row summary cell with drill-down: members whose field is a grandchild
   *  M2O render as links opening the target record's detail sheet (e.g. the
   *  Deployment view's Unit column → the unit form). Falls back to plain text
   *  when no drilldown host or the member isn't an M2O. */
  function summaryCellContent(c: CMSField, sourceRow: Record<string, unknown>): React.ReactNode {
    const dot = c.field.indexOf('.')
    if (dot < 0) return '—'
    const relationField = c.field.slice(0, dot)
    const memberField = c.field.slice(dot + 1)
    const members = effectiveMembersFor(relationField, sourceRow, false)
    if (members.length === 0) return '—'
    const rel = grandM2oRelMaps.get(relationField)?.get(memberField)
    if (!rel?.one_collection || !drill) return summaryCellValue(c, sourceRow, false)
    const target = rel.one_collection
    const items = members
      .map((m) => {
        const v = m[memberField]
        if (v == null || v === '') return null
        return { id: String(v), label: summaryM2oDisplays[target]?.[String(v)] ?? String(v) }
      })
      .filter((x): x is { id: string; label: string } => !!x)
    if (items.length === 0) return '—'
    return (
      <span className='inline-flex flex-wrap gap-x-1.5'>
        {items.map((it, i) => (
          <button
            key={`${it.id}:${i}`}
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              drill.open({ collection: target, itemId: it.id, title: it.label, width: '80%' })
            }}
            className='truncate text-left underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-[#172940] hover:decoration-[#00ceff] dark:hover:text-[#00ceff]'
          >
            {it.label}
          </button>
        ))}
      </span>
    )
  }

  // Empty-result guard: a preset whose stored columns have ALL gone stale (fields
  // unassigned from the layout, drawer relation removed) must not render a zero-column
  // grid — fall back to the full display set. A dot-token-only preset that RESOLVES
  // still shows just its summary columns.
  const effectiveCols =
    resolvedPreset && (presetCols.length > 0 || summaryCols.length > 0)
      ? [...presetCols, ...summaryCols]
      : displayCols

  // ── "Since you opened" (backlog #13) ──────────────────────────────────────
  // A baseline snapshot of the SAVED rows this grid first loaded (displayed
  // column values only). Every later rows fetch is diffed against it: rows
  // the baseline lacks were added, rows now missing were removed, rows whose
  // shown values moved were changed — unless THIS tab wrote them (its own
  // saves, deletes, bulk writes and staged-batch flushes are stamped for 10s
  // and absorbed into the baseline as they land). Staged edits live in
  // staging and never touch this: a refetch simply re-merges over them.
  const baselineRef = useRef<Map<string, Record<string, unknown>> | null>(null)
  const [baselineVersion, setBaselineVersion] = useState(0)
  const localWritesRef = useRef<Map<string, number>>(new Map())
  const localCreateAtRef = useRef(0)
  const LOCAL_WRITE_GRACE_MS = 10_000
  const stampLocalWrite = (id: string | number) =>
    localWritesRef.current.set(String(id), Date.now())
  const displayKeysSig = displayCols
    .map((c) => c.field)
    .filter((f) => !f.includes('.'))
    .join(',')
  const snapshotRow = useCallback(
    (r: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const k of displayKeysSig ? displayKeysSig.split(',') : []) {
        const v = r[k]
        out[k] = v === undefined || (v !== null && typeof v === 'object') ? null : v
      }
      return out
    },
    [displayKeysSig]
  )
  const snapshotsEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const k of Object.keys(b)) if (String(a[k] ?? '') !== String(b[k] ?? '')) return false
    return true
  }
  const wroteRecently = (id: string, now: number) => {
    const ts = localWritesRef.current.get(id)
    return !!ts && now - ts < LOCAL_WRITE_GRACE_MS
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per rows fetch (rowsUpdatedAt); the rest are read fresh from refs/closure
  useEffect(() => {
    if (isNew || rowsLoading || !displayKeysSig) return
    if (!baselineRef.current) {
      baselineRef.current = new Map(rawRows.map((r) => [String(r.id), snapshotRow(r)]))
      setBaselineVersion((v) => v + 1)
      return
    }
    // Absorb this tab's own writes into the baseline as they land.
    const base = baselineRef.current
    const now = Date.now()
    const idsNow = new Set<string>()
    let touched = false
    for (const r of rawRows) {
      const id = String(r.id)
      idsNow.add(id)
      if (wroteRecently(id, now)) {
        base.set(id, snapshotRow(r))
        touched = true
      } else if (!base.has(id) && now - localCreateAtRef.current < LOCAL_WRITE_GRACE_MS) {
        base.set(id, snapshotRow(r))
        touched = true
      }
    }
    for (const id of [...base.keys()]) {
      if (!idsNow.has(id) && wroteRecently(id, now)) {
        base.delete(id)
        touched = true
      }
    }
    if (touched) setBaselineVersion((v) => v + 1)
  }, [rowsUpdatedAt, isNew, rowsLoading, displayKeysSig])
  // biome-ignore lint/correctness/useExhaustiveDependencies: stagedSignature stands in for the staged maps it serialises; pendingEdits is read fresh
  const sinceOpened = useMemo(() => {
    const base = baselineRef.current
    if (!base || isNew) return null
    const now = Date.now()
    const added = new Set<string>()
    const changed = new Set<string>()
    const removed: string[] = []
    const idsNow = new Set<string>()
    for (const r of rawRows) {
      const id = String(r.id)
      idsNow.add(id)
      const b = base.get(id)
      if (!b) {
        added.add(id)
        continue
      }
      // The user's own staged change is not "remote"; neither is a write this
      // tab made moments ago and the fetch is only now reflecting.
      if (pendingEdits.has(id) || wroteRecently(id, now)) continue
      if (!snapshotsEqual(snapshotRow(r), b)) changed.add(id)
    }
    for (const id of base.keys()) if (!idsNow.has(id)) removed.push(id)
    if (added.size === 0 && changed.size === 0 && removed.length === 0) return null
    return { added, changed, removed, total: added.size + changed.size + removed.length }
  }, [rawRows, baselineVersion, stagedSignature, isNew, snapshotRow])
  const dismissSinceOpened = () => {
    baselineRef.current = new Map(rawRows.map((r) => [String(r.id), snapshotRow(r)]))
    setBaselineVersion((v) => v + 1)
  }
  // Who changed them, when the grid already knows (cell provenance is only
  // fetched for revision-enabled grids): the newest delta per changed row.
  // #16 — someone else changed the row THIS editor has open: fields whose
  // fresh value differs from the snapshot taken at open (own writes and the
  // fields the user already set to the same value excluded).
  const editBaseRef = useRef<{ rowId: string; snap: Record<string, unknown> } | null>(null)
  const [remoteDismissed, setRemoteDismissed] = useState<Record<string, unknown>>({})
  const remoteRowChanges = useMemo(() => {
    const base = editBaseRef.current
    const id = editState?.rowId
    if (!base || !id || base.rowId !== id || id === 'new' || id.startsWith('pending:')) return []
    const fresh = rawRows.find((r) => String(r.id) === id)
    if (!fresh || wroteRecently(id, Date.now())) return []
    const snap = snapshotRow(fresh)
    const out: Array<{ field: string; label: string; theirs: unknown; was: unknown }> = []
    for (const k of Object.keys(snap)) {
      if (String(snap[k] ?? '') === String(base.snap[k] ?? '')) continue
      if (String(remoteDismissed[k] ?? '\u0000') === String(snap[k] ?? '')) continue
      if (String(editState?.draft[k] ?? '') === String(snap[k] ?? '')) continue
      const col = cols.find((c) => c.field === k)
      // A write-computed column follows its inputs (amount = price × qty);
      // listing it would double the same change.
      if (col?.computed_type === 'write' && col.computed_formula) continue
      out.push({ field: k, label: col?.label || titleCase(k), theirs: snap[k], was: base.snap[k] })
    }
    return out
    // biome-ignore lint/correctness/useExhaustiveDependencies: editState.draft is read for the "already equal" check; rawRows is the trigger
  }, [rawRows, editState?.rowId, editState?.draft, remoteDismissed, snapshotRow, cols])
  const renderRemoteRowStrip = (rowId: string | undefined) => {
    if (!rowId || remoteRowChanges.length === 0 || editState?.rowId !== rowId) return null
    const fmt = (v: unknown) => (v == null || v === '' ? '∅' : String(v).slice(0, 40))
    const takeTheirs = (only?: string) => {
      const next: Record<string, unknown> = { ...remoteDismissed }
      // One batched draft write — setDraftField reads the draft from a ref,
      // so two calls in a row would build the second from the stale first.
      const patch: Record<string, unknown> = {}
      for (const c of remoteRowChanges) {
        if (only && c.field !== only) continue
        patch[c.field] = c.theirs
        next[c.field] = c.theirs
        if (editBaseRef.current) editBaseRef.current.snap[c.field] = c.theirs
      }
      setDraftFields(patch)
      setRemoteDismissed(next)
    }
    const keepMine = () => {
      const next: Record<string, unknown> = { ...remoteDismissed }
      for (const c of remoteRowChanges) {
        next[c.field] = c.theirs
        if (editBaseRef.current) editBaseRef.current.snap[c.field] = c.theirs
      }
      setRemoteDismissed(next)
    }
    return (
      <div
        data-row-remote-change=''
        role='status'
        className='mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-[11.5px] text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100'
      >
        <span className='min-w-0 flex-1'>
          Changed by others while you edit:{' '}
          {remoteRowChanges.map((c, i) => (
            <span key={c.field} data-row-remote-field={c.field}>
              {i > 0 && ' · '}
              <span className='font-medium'>{c.label}</span> {fmt(c.was)} → {fmt(c.theirs)}
              <button
                type='button'
                onClick={() => takeTheirs(c.field)}
                className='ml-1 rounded border border-sky-300 px-1 text-[10px] hover:bg-sky-100 dark:border-sky-500/40 dark:hover:bg-sky-500/15'
              >
                take
              </button>
            </span>
          ))}
        </span>
        <button
          type='button'
          onClick={() => takeTheirs()}
          data-row-remote-take
          className='rounded-md bg-sky-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-sky-700'
        >
          Take theirs
        </button>
        <button
          type='button'
          onClick={keepMine}
          data-row-remote-keep
          className='rounded-md border border-sky-300 px-2 py-0.5 text-[11px] font-medium hover:bg-sky-100 dark:border-sky-500/40 dark:hover:bg-sky-500/15'
        >
          Keep mine
        </button>
      </div>
    )
  }
  const sinceOpenedWho = useMemo(() => {
    if (!sinceOpened) return []
    const names = new Set<string>()
    for (const id of sinceOpened.changed) {
      const entries = Object.values(cellProvenance[id] ?? {})
      if (entries.length === 0) continue
      const newest = entries.reduce((a, b) => (String(b.at) > String(a.at) ? b : a))
      if (newest.who) names.add(newest.who)
    }
    return [...names]
  }, [sinceOpened, cellProvenance])
  // ── Row presence: soft locks + "who is editing which line" ───────────────
  // Presence hosts stamp `data-remote-editor="<name>"` (and .nvr-remote-editing)
  // on a saved row's [data-o2m-row] element while someone else has that row's
  // editor open. The DOM attribute is the contract (FieldAffordances'
  // usePresenceSoftLock reads the same thing per field): opening such a row
  // asks once — "edit anyway?" — and the since-opened strip lists the editors.
  const [rowSoftLock, setRowSoftLock] = useState<{ rowKey: string; editor: string } | null>(null)
  // (rowKey, editor) pairs the local user already said "Edit anyway" to; a
  // pair drops the moment that editor leaves the row, so a return re-asks.
  const softLockConfirmedRef = useRef<Set<string>>(new Set())
  const softLockPairKey = (rowKey: string, editor: string) => JSON.stringify([rowKey, editor])
  const [remoteRowEditors, setRemoteRowEditors] = useState<Map<string, string>>(() => new Map())
  const remoteRowEditorsSigRef = useRef('')
  const readRemoteRowEditorsRef = useRef<() => void>(() => {})
  /** The remote editor stamped on one saved row RIGHT NOW — a DOM read, never state. */
  const remoteEditorOfRow = (rowKey: string): string | null => {
    const wrap = tableWrapRef.current
    if (!wrap) return null
    const want = `${relatedCollection}:${rowKey}`
    for (const el of wrap.querySelectorAll<HTMLElement>('[data-o2m-row]')) {
      if (el.getAttribute('data-o2m-row') !== want) continue
      const who = el.getAttribute('data-remote-editor')
      return who?.trim() ? who : null
    }
    return null
  }
  // The wrapper only mounts past the loading early-return, so the observer
  // attaches once the grid's DOM exists (and re-attaches per collection).
  const gridDomReady = !colsLoading && (isNew || !rowsLoading)
  useEffect(() => {
    const wrap = tableWrapRef.current
    if (!wrap || !gridDomReady || typeof MutationObserver === 'undefined') return
    const prefix = `${relatedCollection}:`
    const read = () => {
      const next = new Map<string, string>()
      for (const el of wrap.querySelectorAll<HTMLElement>('[data-o2m-row][data-remote-editor]')) {
        const key = el.getAttribute('data-o2m-row') ?? ''
        const who = el.getAttribute('data-remote-editor')
        if (!key.startsWith(prefix) || !who?.trim()) continue
        const rowKey = key.slice(prefix.length)
        if (rowKey.startsWith('pending:')) continue
        next.set(rowKey, who)
      }
      const sig = [...next.entries()]
        .map(([k, v]) => `${k}\u0000${v}`)
        .sort()
        .join('\n')
      if (sig === remoteRowEditorsSigRef.current) return
      remoteRowEditorsSigRef.current = sig
      setRemoteRowEditors(next)
    }
    readRemoteRowEditorsRef.current = read
    read()
    // childList too: a row that mounts already stamped, or unmounts while
    // stamped, changes the answer without an attribute mutation.
    const mo = new MutationObserver(read)
    mo.observe(wrap, {
      attributes: true,
      attributeFilter: ['data-remote-editor'],
      subtree: true,
      childList: true
    })
    return () => {
      mo.disconnect()
      readRemoteRowEditorsRef.current = () => {}
    }
  }, [gridDomReady, relatedCollection])
  // A remote editor leaving a row ends the local "Edit anyway" for that pair
  // and closes a strip still waiting on it.
  useEffect(() => {
    const confirmed = softLockConfirmedRef.current
    for (const key of [...confirmed]) {
      const [rowKey, editor] = JSON.parse(key) as [string, string]
      if (remoteRowEditors.get(rowKey) !== editor) confirmed.delete(key)
    }
    if (rowSoftLock && remoteRowEditors.get(rowSoftLock.rowKey) !== rowSoftLock.editor)
      setRowSoftLock(null)
  }, [remoteRowEditors, rowSoftLock])
  // Escape = Leave it.
  useEffect(() => {
    if (!rowSoftLock || typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRowSoftLock(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rowSoftLock])
  // "Jane is editing line 3 · Sam is editing line 7" — saved rows only, in
  // display order; the line is the row's line_number, else its position.
  const remoteEditorLines = useMemo(() => {
    if (remoteRowEditors.size === 0) return []
    const out: string[] = []
    rows.forEach((r, i) => {
      const who = remoteRowEditors.get(String(r.id))
      if (!who) return
      const ln = r.line_number
      const hasLn = typeof ln === 'number' || (typeof ln === 'string' && ln.trim() !== '')
      out.push(`${who} is editing line ${hasLn ? String(ln) : String(i + 1)}`)
    })
    return out
  }, [remoteRowEditors, rows])
  // Any write to the child collection (by anyone) refreshes the rows, debounced.
  useEffect(() => {
    if (!realtime || isNew) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = realtime.subscribeCollections([relatedCollection], () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      }, 1500)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [realtime, relatedCollection, manyField, parentId, isNew, qc])
  // A staged batch that just FLUSHED (parent save) or was discarded shrinks
  // staging — stamp what it covered as this tab's own writes, so the rows
  // that come back changed are not reported as someone else's.
  const prevStagedRef = useRef<{
    edits: Set<string>
    deletes: Set<string>
    pending: number
  } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: stagedSignature serialises the three staged structures read here
  useEffect(() => {
    const cur = {
      edits: new Set(pendingEdits.keys()),
      deletes: new Set(pendingDeletes),
      pending: pendingRows.length
    }
    const prev = prevStagedRef.current
    prevStagedRef.current = cur
    if (!prev) return
    for (const id of prev.edits) if (!cur.edits.has(id)) stampLocalWrite(id)
    for (const id of prev.deletes) if (!cur.deletes.has(id)) stampLocalWrite(id)
    if (cur.pending < prev.pending) localCreateAtRef.current = Date.now()
  }, [stagedSignature])

  // Fields configured for the apply values form (group_key === '__apply_values__')
  const applyValuesCols = useMemo(
    () =>
      cols.filter(
        (c) =>
          c.group_key === '__apply_values__' &&
          !NON_DISPLAY_TYPES.has(c.type ?? '') &&
          !SENTINEL_FIELDS.has(c.field)
      ),
    [cols]
  )

  // Fields configured for the create-with-defaults form (group_key === '__create_with_defaults__')
  // Falls back to displayCols if none configured
  const defaultsCols = useMemo(
    () =>
      cols.filter(
        (c) =>
          c.group_key === '__create_with_defaults__' &&
          !NON_DISPLAY_TYPES.has(c.type ?? '') &&
          !SENTINEL_FIELDS.has(c.field)
      ),
    [cols]
  )

  // Map field → M2O relation for display value lookup
  const m2oRelMap = useMemo(() => {
    const map = new Map<string, CMSRelation>()
    for (const c of displayCols) {
      const rel = childRelations.find(
        (r) =>
          r.many_collection === relatedCollection && r.many_field === c.field && !r.junction_field
      )
      if (rel?.one_collection) map.set(c.field, rel)
    }
    return map
  }, [displayCols, childRelations, relatedCollection])

  // ── Stale-value sweep ───────────────────────────────────────────────────────
  // Parent cascades narrow each M2O column's valid options by the PARENT's
  // current values, but the amber "not an available option" flag only showed
  // once a row entered EDIT mode (the cell picker's own probe). Sweep every
  // row's value against the resolved cascade filter — ONE query per cascaded
  // column ({_and: [cascadeFilter, {id: {_in: distinct values}}]}) — so
  // out-of-range values highlight at a glance across the whole grid.
  const staleSweepInput = useMemo(() => {
    const entries: Array<{
      field: string
      target: string
      filter: Record<string, unknown>
      ids: string[]
    }> = []
    for (const [field, filter] of Object.entries(fieldCascadeFilters)) {
      const rel = m2oRelMap.get(field)
      if (!rel?.one_collection) continue
      const ids = [
        ...new Set(
          [...rows, ...pendingRows]
            .map((r) => r[field])
            .filter((v) => v != null && v !== '')
            .map(String)
        )
      ].sort()
      if (ids.length) entries.push({ field, target: rel.one_collection, filter, ids })
    }
    return entries
  }, [fieldCascadeFilters, m2oRelMap, rows, pendingRows])
  const staleSweepResults = useQueries({
    queries: staleSweepInput.map((e) => ({
      queryKey: [
        'cascade-stale-sweep',
        relatedCollection,
        e.field,
        JSON.stringify(e.filter),
        e.ids.join(',')
      ],
      queryFn: () =>
        client
          .request<{ data: Array<{ id: unknown }> }>(
            get(`/items/${e.target}`, {
              filter: JSON.stringify({ _and: [e.filter, { id: { _in: e.ids } }] }),
              fields: 'id',
              limit: e.ids.length
            })
          )
          .then((r) => new Set((r.data ?? []).map((x) => String(x.id)))),
      staleTime: 30_000
    }))
  })
  const staleCellValues = useMemo(() => {
    const map = new Map<string, Set<string>>()
    staleSweepInput.forEach((e, i) => {
      const available = staleSweepResults[i]?.data
      if (!available) return // still loading / errored — no flags
      const bad = e.ids.filter((id) => !available.has(id))
      if (bad.length) map.set(e.field, new Set(bad))
    })
    return map
  }, [staleSweepInput, staleSweepResults])

  // ── Cascade swap ───────────────────────────────────────────────────────────
  // A parent field the USER changed this session (dirtyFields — a record that
  // LOADED with a stale value only gets the amber flag) orphaned some rows'
  // values: re-point each to the target row that keeps the old value's `keep`
  // columns and takes `replace` from the parent's defaults, then run the row
  // rules as if the user had picked it. Each (field, value, filter) is
  // attempted once — a value with no matching option stays flagged.
  const swapDoneRef = useRef(new Set<string>())
  const swapBusyRef = useRef(false)
  useEffect(() => {
    if (readOnly || !client || swapBusyRef.current) return
    const dirty = parentDraftCtx?.dirtyFields
    if (!dirty || dirty.size === 0) return
    type Job = {
      rule: CascadeRule
      cfg: CascadeSwapConfig
      target: string
      filter: Record<string, unknown>
      filterKey: string
      ids: string[]
      replaceValues: Record<string, unknown>
    }
    const jobs: Job[] = []
    for (const rule of cascadeRules) {
      const cfg = rule.on_unavailable
      if (!cfg?.replace || !dirty.has(rule.parent_field)) continue
      const stale = staleCellValues.get(rule.child_field)
      const filter = fieldCascadeFilters[rule.child_field]
      const rel = m2oRelMap.get(rule.child_field)
      if (!stale?.size || !filter || !rel?.one_collection) continue
      const filterKey = JSON.stringify(filter)
      const ids = [...stale].filter(
        (id) => !swapDoneRef.current.has(`${rule.child_field}|${id}|${filterKey}`)
      )
      if (!ids.length) continue
      const replaceValues: Record<string, unknown> = {}
      let resolved = true
      for (const [col, list] of Object.entries(cfg.replace)) {
        const v = Array.isArray(list) ? resolveParentDefault(list, {}) : null
        if (!v) {
          resolved = false
          break
        }
        replaceValues[col] = v.id
      }
      // No default on this parent (or its record still loading): leave the
      // rows flagged and try again when the parent rows land. Once the parent
      // rows HAVE landed and still yield nothing, say so once — a parent whose
      // only default is gated on a condition the record fails looks exactly
      // like a broken swap otherwise (reported 2026-09-11).
      if (!resolved) {
        const parentsLanded = Object.values(cfg.replace)
          .flat()
          .every((c) => {
            const pid = parentDraftCtx?.draft?.[c.parent_field]
            return (
              pid == null ||
              pid === '' ||
              pinnedParentRows.has(`${c.parent_collection}|${String(pid)}`)
            )
          })
        const hintKey = `hint|${rule.child_field}|${filterKey}`
        if (parentsLanded && !swapDoneRef.current.has(hintKey)) {
          swapDoneRef.current.add(hintKey)
          const parentLabel =
            parentDraftCtx?.fieldLabels?.[rule.parent_field] ?? titleCase(rule.parent_field)
          toast.message(
            `${cfg.label ?? 'Value'} on ${ids.length} ${ids.length === 1 ? 'line is' : 'lines are'} not available for this ${parentLabel} — no default ${(cfg.label ?? 'value').toLowerCase()} is set on it (or its type), so nothing was switched`
          )
        }
        continue
      }
      jobs.push({ rule, cfg, target: rel.one_collection, filter, filterKey, ids, replaceValues })
    }
    if (!jobs.length) return
    swapBusyRef.current = true
    void (async () => {
      let swapped = 0
      let unresolved = 0
      let failed = 0
      for (const job of jobs) {
        for (const id of job.ids)
          swapDoneRef.current.add(`${job.rule.child_field}|${id}|${job.filterKey}`)
        const field = job.rule.child_field
        const keep = (job.cfg.keep ?? []).filter((k) => typeof k === 'string' && k)
        const current = await client
          .request<{ data: Array<Record<string, unknown>> }>(
            get(`/items/${job.target}`, {
              filter: JSON.stringify({ id: { _in: job.ids } }),
              fields: ['id', ...keep].join(','),
              limit: job.ids.length
            })
          )
          .then((r) => r.data ?? [])
          .catch(() => [] as Array<Record<string, unknown>>)
        const replacementByOld = new Map<string, unknown>()
        for (const old of current) {
          const clauses: Record<string, unknown>[] = [
            job.filter,
            ...Object.entries(job.replaceValues).map(([c, v]) => ({ [c]: { _eq: v } })),
            ...keep.map((k) =>
              old[k] == null || old[k] === '' ? { [k]: { _null: true } } : { [k]: { _eq: old[k] } }
            )
          ]
          const found = await client
            .request<{ data: Array<{ id: unknown }> }>(
              get(`/items/${job.target}`, {
                filter: JSON.stringify({ _and: clauses }),
                fields: 'id',
                limit: 1,
                sort: 'id'
              })
            )
            .then((r) => r.data?.[0]?.id ?? null)
            .catch(() => null)
          if (found == null) unresolved++
          else replacementByOld.set(String(old.id), found)
        }
        if (replacementByOld.size === 0) continue
        const parentCtx = buildParentCtx()
        const derive = async (base: Record<string, unknown>) => {
          const next: Record<string, unknown> = {
            ...base,
            [field]: replacementByOld.get(String(base[field]))
          }
          let changes: Record<string, unknown> = { [field]: next[field] }
          if (rowRules && rowRules.length > 0) {
            // Values the rules had derived for the OLD state (equal to the
            // from-scratch probe) are AUTO, not the user's — blank them so
            // only-if-empty rules (e.g. a type or item seed) re-derive for
            // the new value instead of keeping the old answer and reading as
            // "overridden" afterwards. A hand-picked value (≠ probe) stays.
            const probe = await client
              .request<{ expected?: Record<string, unknown> }>(
                post('/field-rules/evaluate', {
                  collection: relatedCollection,
                  data: base,
                  locks_only: true,
                  probe: true,
                  parent_context: parentCtx,
                  row_rules: rowRules
                })
              )
              .catch(() => null)
            const autoFields = autoTargetsFor(field, base, probe?.expected)
            for (const k of autoFields) next[k] = null
            const res = await client
              .request<{ updates?: Record<string, unknown> }>(
                post('/field-rules/evaluate', {
                  collection: relatedCollection,
                  data: next,
                  changed_field: field,
                  parent_context: parentCtx,
                  row_rules: rowRules
                })
              )
              .catch(() => null)
            if (res?.updates) changes = { ...changes, ...res.updates }
            // An auto field the rules no longer derive is empty now, the same
            // answer a from-scratch re-run gives — never the old value.
            for (const k of autoFields) if (!(k in changes)) changes[k] = null
          }
          return changes
        }
        const pendingHits = pendingRows
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => r[field] != null && replacementByOld.has(String(r[field])))
        for (const { r, i } of pendingHits) {
          const changes = await derive(r)
          staging?.updateRow(relatedCollection, manyField, i, { ...r, ...changes })
          swapped++
        }
        const savedHits = rows.filter((r) => {
          const id = String(r.id)
          if (pendingDeletes.has(id)) return false
          const v = pendingEdits.get(id)?.[field] ?? r[field]
          return v != null && replacementByOld.has(String(v))
        })
        for (const r of savedHits) {
          const id = String(r.id)
          const changes = await derive({ ...r, ...(pendingEdits.get(id) ?? {}) })
          if ((isPendingMode || isNew) && staging) {
            staging.queueEdit(relatedCollection, manyField, id, changes)
          } else {
            const ok = await client
              .request(patch(`/items/${relatedCollection}/${id}`, changes))
              .then(() => true)
              .catch(() => false)
            if (!ok) {
              failed++
              continue
            }
          }
          swapped++
          if (editStateRef.current?.rowId === id)
            setEditState((st) =>
              st && st.rowId === id
                ? { ...st, draft: applyComputedFields({ ...st.draft, ...changes }) }
                : st
            )
        }
        if (savedHits.length && !((isPendingMode || isNew) && staging))
          await qc.invalidateQueries({
            queryKey: ['o2m-rows', relatedCollection, manyField, parentId]
          })
      }
      const label = jobs[0]?.cfg.label ?? 'Value'
      const parentLabel =
        parentDraftCtx?.fieldLabels?.[jobs[0]?.rule.parent_field ?? ''] ??
        titleCase(jobs[0]?.rule.parent_field ?? 'parent')
      if (swapped)
        toast.message(
          `${label} switched to the default on ${swapped} ${swapped === 1 ? 'line' : 'lines'} — the previous one is not available for this ${parentLabel}${
            (isPendingMode || isNew) && staging ? ' (saved with the record)' : ''
          }`
        )
      if (unresolved || failed)
        toast.warning(
          `${unresolved + failed} ${unresolved + failed === 1 ? 'line' : 'lines'} could not be switched — no matching default option${failed ? ' / save failed' : ''}`
        )
    })().finally(() => {
      swapBusyRef.current = false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staleCellValues, fieldCascadeFilters, parentDraftCtx?.dirtyFields, pinnedParentRows])

  // Collect unique FK ids per one_collection from all rows (incl. pending edits + addendum rows)
  const m2oLookupIds = useMemo(() => {
    const result = new Map<string, string[]>()
    const allRows = [...rows, ...pendingRows]
    const pendingEditRows = [...pendingEdits.values()]
    const addendumRows = addendumO2MEntries.flatMap((e) => e.rows)
    for (const [field, rel] of m2oRelMap) {
      if (!rel.one_collection) continue
      const rowIds = allRows
        .map((r) => r[field])
        .filter((v) => v != null)
        .map(String)
      const editIds = pendingEditRows
        .map((r) => r[field])
        .filter((v) => v != null)
        .map(String)
      const addIds = addendumRows
        .map((r) => r[field])
        .filter((v) => v != null)
        .map(String)
      const ids = [...new Set([...rowIds, ...editIds, ...addIds])].sort()
      if (ids.length) result.set(rel.one_collection, ids)
    }
    return result
  }, [rows, pendingRows, pendingEdits, m2oRelMap, addendumO2MEntries])

  // For relation-grouped fields, track which collection needs group/option expansion
  const m2oGroupedConfig = useMemo(() => {
    const map = new Map<string, { groupField: string; optionField: string }>()
    for (const c of displayCols) {
      const rel = m2oRelMap.get(c.field)
      if (!rel?.one_collection) continue
      if (c.interface === 'relation-grouped') {
        const opts = parseJson<{ group_field?: string; option_field?: string }>(c.options)
        if (opts?.group_field && opts?.option_field) {
          map.set(rel.one_collection, {
            groupField: opts.group_field,
            optionField: opts.option_field
          })
        }
      }
    }
    return map
  }, [displayCols, m2oRelMap])

  const m2oQueryKey = useMemo(
    () => ['m2o-display', relatedCollection, ...Array.from(m2oLookupIds.entries()).flat(2)],
    [relatedCollection, m2oLookupIds]
  )

  // Batch-fetch display values: { oneCollection: { id: displayString } }
  const { data: m2oDisplays = {}, isFetching: m2oFetching } = useQuery<
    Record<string, Record<string, string>>
  >({
    queryKey: m2oQueryKey,
    queryFn: async () => {
      const result: Record<string, Record<string, string>> = {}
      // Fetch all collection metas first so we know which fields to expand
      // Collection meta is shared across every grid/picker on the page and
      // changes rarely — served from the query cache when warm, so the label
      // fetch is ONE round trip per collection instead of two.
      const colMetas = await Promise.all(
        [...m2oLookupIds.keys()].map((oneCollection) =>
          qc
            .fetchQuery({
              queryKey: ['collection-display-meta', oneCollection],
              queryFn: () =>
                client
                  .request<{ data: { display_template?: string | null } }>(
                    get(`/collections/${oneCollection}`)
                  )
                  .then((r) => r.data),
              staleTime: 10 * 60_000
            })
            .then((meta) => ({ collection: oneCollection, meta }))
        )
      )
      await Promise.all(
        colMetas.map(async ({ collection: oneCollection, meta: colMeta }) => {
          const ids = m2oLookupIds.get(oneCollection)!
          const grouped = m2oGroupedConfig.get(oneCollection)
          let fieldsParam: string | undefined
          if (grouped) {
            fieldsParam = `id,${grouped.groupField}.*,${grouped.optionField}.*`
          } else {
            const tmpl = colMeta?.display_template ?? undefined
            const tmplFields = tmpl ? [...tmpl.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]) : []
            // Explicit fields only needed when the template traverses a relation; must
            // include the template's PLAIN columns too or they render empty.
            fieldsParam = tmplFields.some((f) => f.includes('.'))
              ? ['id', ...tmplFields].join(',')
              : undefined
          }
          const data = await client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${oneCollection}`, {
                filter: JSON.stringify({ id: { _in: ids } }),
                limit: ids.length,
                ...(fieldsParam ? { fields: fieldsParam } : {})
              })
            )
            .then((r) => r.data ?? [])
          result[oneCollection] = {}
          for (const item of data) {
            if (grouped) {
              const gSub = item[grouped.groupField] as Record<string, unknown> | null
              const oSub = item[grouped.optionField] as Record<string, unknown> | null
              const gLabel = gSub ? applyDisplayTemplate(null, gSub) : null
              const oLabel = oSub ? applyDisplayTemplate(null, oSub) : null
              result[oneCollection][String(item.id)] =
                [gLabel, oLabel].filter(Boolean).join(' — ') || String(item.id)
            } else {
              const tmpl = colMeta?.display_template ?? undefined
              result[oneCollection][String(item.id)] = applyDisplayTemplate(tmpl, item)
            }
          }
        })
      )
      return result
    },
    enabled: m2oLookupIds.size > 0,
    staleTime: 60_000
  })

  // Row ↔ related-record matching (options.row_match_panel): resolved once
  // for every saved row so the grid can show a per-row dot and the editor the
  // full reason; no-op when the option is absent.
  const stagedRowsForMatch = useMemo(
    () =>
      rowMatchPanel?.unmatched_banner
        ? pendingRows.map((r) => applyComputedFields({ ...r }))
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowMatchPanel?.unmatched_banner, pendingRows]
  )
  const rowMatches = useRowMatches({
    config: rowMatchPanel,
    rows,
    stagedRows: stagedRowsForMatch,
    relatedCollection,
    childRelations,
    parentDraft: parentDraftCtx?.draft,
    m2oRelMap,
    m2oDisplays,
    client
  })

  async function rerunRules(dryRun: boolean) {
    if (!client || !rowRules?.length) return
    if (isNew && pendingRows.length === 0) return
    setRerunBusy(dryRun ? 'preview' : 'apply')
    // A staged grid (save_mode 'pending') never writes on its own: the
    // re-derived values are QUEUED as row edits and land with the record's
    // Save, so they show as "Edited" first and can still be cancelled.
    const stageIt = isPendingMode && !!staging
    // Unsaved rows (new record, staged additions) ride along under a client
    // key; the server plans them but never writes them — their patches are
    // staged here. Staged edits on saved rows overlay the DB values so the
    // plan judges what the grid shows.
    const pendingPayload = pendingRows.map((r, i) => ({ ...r, id: `pending:${i}` }))
    const savedOverrides: Record<string, Record<string, unknown>> = {}
    if (staging) {
      for (const [id, patch] of staging.getPendingEdits(relatedCollection, manyField)) {
        savedOverrides[String(id)] = patch
      }
    }
    try {
      const res = await client.request<{
        data: {
          rows: number
          fields: Record<string, number>
          changes: Array<{ id: string; patch: Record<string, unknown> }>
          applied: number
          failed: Array<{ id: string; error: string }>
          truncated?: boolean
        }
      }>(
        post('/field-rules/apply', {
          collection: relatedCollection,
          fk_field: manyField,
          ...(isNew ? {} : { parent_id: parentId }),
          parent_context: buildParentCtx(),
          row_rules: rowRules,
          mode: rerunMode,
          dry_run: dryRun || stageIt || pendingPayload.length > 0,
          all_changes: stageIt || pendingPayload.length > 0,
          rows: pendingPayload,
          saved_overrides: savedOverrides
        })
      )
      const d = res.data
      if (dryRun) {
        setRerunPreview({
          rows: d.rows,
          fields: d.fields,
          changes: d.changes,
          truncated: d.truncated
        })
        return
      }
      // Unsaved rows: write the patches back into staging in place.
      const pendingChanges = d.changes.filter((c) => String(c.id).startsWith('pending:'))
      const savedChanges = d.changes.filter((c) => !String(c.id).startsWith('pending:'))
      if (staging) {
        for (const c of pendingChanges) {
          const idx = Number(String(c.id).slice('pending:'.length))
          const cur = pendingRows[idx]
          if (!Number.isFinite(idx) || !cur) continue
          staging.updateRow(relatedCollection, manyField, idx, { ...cur, ...c.patch })
        }
      }
      if (stageIt || (isNew && staging)) {
        for (const c of savedChanges) {
          if (pendingDeletes.has(String(c.id))) continue
          staging!.queueEdit(relatedCollection, manyField, String(c.id), c.patch)
        }
        const n = pendingChanges.length + savedChanges.length
        toast.success(`Rules staged on ${n} ${n === 1 ? 'line' : 'lines'} — saved with the record`)
        setRerunPreview(null)
        setRerunOpen(false)
        return
      }
      if (pendingChanges.length > 0 && savedChanges.length === 0) {
        toast.success(
          `Rules applied to ${pendingChanges.length} pending ${pendingChanges.length === 1 ? 'line' : 'lines'}`
        )
        setRerunPreview(null)
        setRerunOpen(false)
        return
      }
      // Immediate-mode grids with BOTH saved and pending rows: the pending
      // ones were staged above; the saved ones still need the real run.
      if (pendingChanges.length > 0) {
        const res2 = await client.request<{
          data: { applied: number; failed: Array<{ id: string; error: string }> }
        }>(
          post('/field-rules/apply', {
            collection: relatedCollection,
            fk_field: manyField,
            parent_id: parentId,
            parent_context: buildParentCtx(),
            row_rules: rowRules,
            mode: rerunMode,
            dry_run: false,
            saved_overrides: savedOverrides
          })
        )
        d.applied = res2.data.applied + pendingChanges.length
        d.failed = res2.data.failed
      }
      for (const c of savedChanges) stampLocalWrite(String(c.id))
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      qc.invalidateQueries({
        queryKey: ['o2m-field-snapshots', relatedCollection, manyField, parentId]
      })
      if (d.failed.length) {
        toast.error(
          `Rules applied to ${d.applied} ${d.applied === 1 ? 'line' : 'lines'} — ${d.failed.length} failed: ${d.failed
            .slice(0, 3)
            .map((f) => `#${f.id} ${f.error}`)
            .join('; ')}`
        )
      } else {
        toast.success(`Rules applied to ${d.applied} ${d.applied === 1 ? 'line' : 'lines'}`)
      }
      setRerunPreview(null)
      setRerunOpen(false)
    } catch (err) {
      toast.error(`Re-run rules failed: ${(err as Error)?.message ?? 'unknown error'}`)
    } finally {
      setRerunBusy(null)
    }
  }

  function buildParentCtx(): Record<string, unknown> {
    const parentCtx: Record<string, unknown> = {}
    if (parentDraftCtx?.draft) {
      if (parentContextFields?.length) {
        for (const f of parentContextFields) parentCtx[f] = parentDraftCtx.draft[f] ?? null
      }
      for (const rule of rowRules ?? []) {
        const tf = (rule as { trigger_field?: unknown }).trigger_field
        if (typeof tf === 'string' && tf.startsWith('$parent.')) {
          const key = tf.slice(8)
          if (!(key in parentCtx)) parentCtx[key] = parentDraftCtx.draft[key] ?? null
        }
      }
    }
    return parentCtx
  }

  /** On row-editor open: ask the server which fields the layout's lock rules
   *  make read-only right now (lock rules only — no value changes) AND what
   *  every rule target would be if derived from scratch (`expected`, for the
   *  auto/overridden chips). One request, no writes to the draft. */
  function refreshRuleState(rowId: string, draft: Record<string, unknown>) {
    if (!client || !rowRules || rowRules.length === 0) return
    client
      .request<{
        locks?: string[]
        lock_reasons?: Record<string, LockReason>
        expected?: Record<string, unknown>
      }>(
        post('/field-rules/evaluate', {
          collection: relatedCollection,
          data: draft,
          locks_only: true,
          probe: true,
          parent_context: buildParentCtx(),
          row_rules: rowRules
        })
      )
      .then((res) => {
        setEditState((s) =>
          s && s.rowId === rowId
            ? {
                ...s,
                locks: res.locks ?? [],
                lockReasons: res.lock_reasons ?? s.lockReasons,
                locksPending: false,
                expected: res.expected ?? s.expected
              }
            : s
        )
      })
      .catch(() => {
        setEditState((s) => (s && s.rowId === rowId ? { ...s, locksPending: false } : s))
      })
  }

  function startEdit(row: Record<string, unknown>) {
    if (readOnly) return
    const id = String(row.id)
    if (editState?.rowId === id) return
    // Row soft lock: someone else has this line's editor open right now —
    // ask before opening ours, once per (row, editor) presence.
    readRemoteRowEditorsRef.current()
    const remoteEditor = remoteEditorOfRow(id)
    if (remoteEditor && !softLockConfirmedRef.current.has(softLockPairKey(id, remoteEditor))) {
      setRowSoftLock({ rowKey: id, editor: remoteEditor })
      return
    }
    if (rowSoftLock) setRowSoftLock(null)
    const draft = applyComputedFields({ ...row })
    // #16 — remember what the row held when its editor opened, so a write by
    // someone else while it is open shows up as a per-field ghost.
    editBaseRef.current = { rowId: id, snap: snapshotRow(row) }
    setEditState({ rowId: id, draft, locksPending: lockTargets.size > 0 })
    refreshRuleState(id, draft)
  }

  // A header chip (or anything else) can ask this grid to open one row:
  // window event 'nvr:grid-open-row' {collection, field, rowId}. The row
  // opens in its editor and scrolls into view; a rowId the grid doesn't
  // hold (filtered out, deleted) is ignored.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ collection?: string; field?: string; rowId?: string }>).detail
      if (!d || d.collection !== relatedCollection || d.field !== manyField || !d.rowId) return
      const row = rows.find((r) => String(r.id) === String(d.rowId))
      if (!row) return
      startEdit(row)
      window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-o2m-row="${relatedCollection}:${String(d.rowId)}"]`
        )
        if (!el) return
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.classList.add('nvr-row-flash')
        window.setTimeout(() => el.classList.remove('nvr-row-flash'), 2500)
      }, 120)
    }
    window.addEventListener('nvr:grid-open-row', onOpen)
    return () => window.removeEventListener('nvr:grid-open-row', onOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relatedCollection, manyField, rows])

  function startPendingEdit(row: Record<string, unknown>, ri: number) {
    if (readOnly) return
    const rowId = `pending:${ri}`
    if (editState?.rowId === rowId) return
    if (rowSoftLock) setRowSoftLock(null)
    const draft = applyComputedFields({ ...row })
    setEditState({ rowId, draft, locksPending: lockTargets.size > 0 })
    refreshRuleState(rowId, draft)
  }

  /** "Locked — Category is Labor": the trigger that locked a field on this
   *  row, with the trigger field labelled and an M2O value shown by label. */
  function lockReasonText(field: string): string {
    const r = editStateRef.current?.lockReasons?.[field]
    if (!r) return 'Set automatically for this row'
    if (r.reason) return `Locked — ${r.reason}`
    const col = r.field ? cols.find((c) => c.field === r.field) : undefined
    const triggerLabel = col?.label || (r.field ? titleCase(r.field) : 'a rule')
    // The lock fired for THIS row, so the row's own trigger value (shown by
    // label) explains it better than the rule's raw comparison value.
    const rowVal = r.field ? editStateRef.current?.draft[r.field] : undefined
    const rel = r.field ? m2oRelMap.get(r.field) : undefined
    const shown =
      rowVal == null || rowVal === ''
        ? null
        : rel?.one_collection
          ? (m2oDisplays[rel.one_collection]?.[String(rowVal)] ?? String(rowVal))
          : String(rowVal)
    if (shown) return `Locked — ${triggerLabel} is ${shown}`
    const opWord =
      r.op === 'neq'
        ? 'is not'
        : r.op === 'null'
          ? 'is empty'
          : r.op === 'nnull'
            ? 'is set'
            : r.op === 'in'
              ? 'is one of'
              : r.op === 'contains'
                ? 'contains'
                : 'is'
    return `Locked — ${triggerLabel} ${opWord}${r.op === 'null' || r.op === 'nnull' ? '' : ` ${r.value ?? ''}`}`
  }

  /** Provenance of a rule-target value in the open editor: 'auto' when it
   *  equals what the rules would derive, 'overridden' when the user (or an
   *  import) holds a different non-empty value, null when not a rule target
   *  or empty. */
  function ruleProvenance(field: string): 'auto' | 'overridden' | null {
    const exp = editState?.expected
    if (!exp || !(field in exp)) return null
    const cur = editState?.draft[field]
    const curEmpty = cur === null || cur === undefined || cur === ''
    if (curEmpty) return null
    const want = exp[field]
    const wantEmpty = want === null || want === undefined || want === ''
    // The rules would derive NOTHING here (e.g. the price rule only fires
    // for labor lines) — the user's value is just a value, not an override.
    if (wantEmpty) return null
    return String(cur) === String(want) ? 'auto' : 'overridden'
  }

  /** Re-derive ONE field from its rules (the target is treated as empty so
   *  only-if-empty rules fire) and write the answer — the undo for a manual
   *  override. Goes through the same sequence guard as live edits. */
  function resetToAuto(field: string) {
    const cur = editStateRef.current
    if (!cur || !client || !rowRules || rowRules.length === 0) return
    const rowId = cur.rowId
    if (draftKeySeqRef.current.rowId !== rowId) draftKeySeqRef.current = { rowId, seqs: new Map() }
    const seq = ++ruleEvalSeqRef.current
    draftKeySeqRef.current.seqs.set(field, seq)
    client
      .request<{
        updates: Record<string, unknown>
        locks?: string[]
        expected?: Record<string, unknown>
      }>(
        post('/field-rules/evaluate', {
          collection: relatedCollection,
          data: cur.draft,
          target_fields: [field],
          probe: true,
          parent_context: buildParentCtx(),
          row_rules: rowRules
        })
      )
      .then((res) =>
        applyEvalResponse(rowId, seq, { ...res, updates: { [field]: null, ...res.updates } })
      )
      .catch(() => {})
  }

  /** Merge an evaluate response into the open editor, honoring the stale-
   *  response guard: a key touched since `seq` (by the user, or by a newer
   *  response) keeps the later write. */
  /** Rule targets whose current value is AUTO — equal to what the rules derive
   *  from scratch (`expected`) — among the rules `changedKey` triggers. Blank
   *  these before a rule pass so only-if-empty rules re-derive them for the
   *  new trigger value; a hand-picked value (≠ expected) is never listed and
   *  keeps the 2026-09-08 protection. Rules the change doesn't trigger are
   *  left alone — a quantity edit must not blank an auto-derived type. */
  function autoTargetsFor(
    changedKey: string,
    draft: Record<string, unknown>,
    expected: Record<string, unknown> | undefined
  ): string[] {
    if (!expected || !rowRules?.length) return []
    const triggered = new Set<string>()
    for (const r of rowRules) {
      if (r.target_type === 'lock') continue
      const triggers = [r.trigger_field, ...(r.trigger_fields ?? [])].filter(
        (t): t is string => typeof t === 'string' && t.length > 0
      )
      if (triggers.includes(changedKey)) triggered.add(r.target_field)
    }
    return [...triggered].filter((f) => {
      if (f === changedKey || !(f in expected)) return false
      const cur = draft[f]
      const want = expected[f]
      if (cur == null || cur === '' || want == null || want === '') return false
      return String(cur) === String(want)
    })
  }

  function applyEvalResponse(
    rowId: string,
    seq: number,
    res: {
      updates?: Record<string, unknown>
      locks?: string[]
      lock_reasons?: Record<string, LockReason>
      expected?: Record<string, unknown>
    },
    autoFields: string[] = []
  ) {
    if (editStateRef.current?.rowId !== rowId || draftKeySeqRef.current.rowId !== rowId) return
    const seqs = draftKeySeqRef.current.seqs
    const fresh: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(res.updates ?? {})) {
      if ((seqs.get(key) ?? 0) > seq) continue
      fresh[key] = val
      seqs.set(key, seq)
    }
    // An auto field the rules no longer derive for the new state is empty
    // now — the same answer a from-scratch re-run gives, never the old value.
    for (const key of autoFields) {
      if (key in fresh || (seqs.get(key) ?? 0) > seq) continue
      fresh[key] = null
      seqs.set(key, seq)
    }
    const hasUpdates = Object.keys(fresh).length > 0
    setEditState((s) => {
      if (!s || s.rowId !== rowId) return s
      return {
        ...s,
        draft: hasUpdates ? applyComputedFields({ ...s.draft, ...fresh }) : s.draft,
        locks: res.locks ?? s.locks,
        lockReasons: res.lock_reasons ?? s.lockReasons,
        locksPending: false,
        expected: res.expected ?? s.expected
      }
    })
  }

  /** A history version lands in the row editor — never saved until the user
   *  saves the row. A deleted line comes back as a NEW row pre-filled with
   *  what it held (so staging / immediate mode both apply as usual). */
  function restoreFromHistory(snapshot: Record<string, unknown>, ctx: RestoreContext) {
    if (readOnly) return
    const draft: Record<string, unknown> = { ...snapshot }
    if (ctx.rowDeleted || !ctx.itemId) {
      delete draft.id
      for (const k of Object.keys(draft)) if (SYSTEM_FIELDS.has(k)) delete draft[k]
      delete draft[manyField]
      setEditState({
        rowId: 'new',
        draft: withNextOrder(draft),
        locksPending: lockTargets.size > 0
      })
      refreshRuleState('new', draft)
    } else {
      setEditState({ rowId: String(ctx.itemId), draft })
    }
    setHistoryRow(null)
    setHistoryFocus(null)
    setTimelineOpen(false)
  }

  function startNew() {
    if (readOnly) return
    setEditState({ rowId: 'new', draft: { ...rowDefaultSeed }, locksPending: lockTargets.size > 0 })
    refreshRuleState('new', { ...rowDefaultSeed })
  }

  function cancelEdit() {
    const canceled = editStateRef.current?.rowId
    setEditState(null)
    setUniqueError(null)
    // Cancel discards this row's staged drawer changes — its live snapshot
    // must die with them. Other rows' snapshots stay (they still describe
    // queued edits waiting on the parent save).
    setDrawerLiveRows((prev) => {
      const next: typeof prev = {}
      for (const [k, v] of Object.entries(prev)) {
        if (canceled && k.startsWith(`${canceled}|`)) continue
        if (k.startsWith('__new__|')) continue
        next[k] = v
      }
      return next
    })
  }

  /** Several fields at once (the spread action) — one state write, no rule
   *  pass; calling setDraftField in a loop would read a stale editStateRef
   *  and keep only the last key. */
  function setDraftFields(patch: Record<string, unknown>) {
    const cur = editStateRef.current
    const rowId = cur?.rowId ?? null
    if (draftKeySeqRef.current.rowId !== rowId) draftKeySeqRef.current = { rowId, seqs: new Map() }
    for (const k of Object.keys(patch)) draftKeySeqRef.current.seqs.set(k, ++ruleEvalSeqRef.current)
    const nextDraft = applyComputedFields({ ...(cur?.draft ?? {}), ...patch })
    setEditState((st) => (st ? { ...st, draft: nextDraft } : st))
  }
  function setDraftField(k: string, v: unknown) {
    const cur = editStateRef.current
    const rowId = cur?.rowId ?? null
    if (draftKeySeqRef.current.rowId !== rowId) draftKeySeqRef.current = { rowId, seqs: new Map() }
    const seq = ++ruleEvalSeqRef.current
    draftKeySeqRef.current.seqs.set(k, seq)
    const nextDraft = cur
      ? applyComputedFields({ ...cur.draft, [k]: v })
      : applyComputedFields({ [k]: v })
    const filled = v !== null && v !== undefined && v !== ''
    setEditState((s) =>
      s
        ? {
            ...s,
            draft: nextDraft,
            missing: filled && s.missing?.includes(k) ? s.missing.filter((f) => f !== k) : s.missing
          }
        : s
    )

    if (rowRules && rowRules.length > 0 && client) {
      const parentCtx = buildParentCtx()
      // Auto values follow their triggers (2026-09-11): a category change
      // re-derives an auto-filled dependent field; a hand-picked one stays.
      const autoFields = autoTargetsFor(k, cur?.draft ?? {}, cur?.expected)
      const evalData: Record<string, unknown> = { ...nextDraft }
      for (const f of autoFields) evalData[f] = null
      client
        .request<{
          updates: Record<string, unknown>
          locks?: string[]
          lock_reasons?: Record<string, LockReason>
          expected?: Record<string, unknown>
        }>(
          post('/field-rules/evaluate', {
            collection: relatedCollection,
            data: evalData,
            changed_field: k,
            probe: true,
            parent_context: parentCtx,
            row_rules: rowRules
          })
        )
        .then((res) => applyEvalResponse(rowId ?? '', seq, res, autoFields))
        .catch(() => {})
    }
  }

  /** Resolves true when the row COMMITTED (saved, staged, or closed as a
   *  no-op) and false when it stayed open — a required field missing, a
   *  unique conflict, a change-reason challenge, or a failed write. */
  async function saveEdit(): Promise<boolean> {
    if (!editState) return false
    // If the user opened ANOTHER row while this save was in flight (outside
    // click commits, then the click lands on the next row), finishing must
    // not close the editor they just opened.
    const savedRowId = editState.rowId
    const clearIfStillEditing = () => {
      if (editStateRef.current?.rowId === savedRowId) setEditState(null)
    }

    if (uniqueBy?.length) {
      const isPendingIdx = editState.rowId.startsWith('pending:')
      const pendingIdx = isPendingIdx ? parseInt(editState.rowId.split(':')[1], 10) : null
      const editingId = editState.rowId === 'new' || isPendingIdx ? null : editState.rowId
      const draftKey = getUniqueKey(editState.draft, uniqueBy)

      const conflict =
        rows.some((r) => {
          if (String(r.id) === editingId) return false
          if (pendingDeletes.has(String(r.id))) return false
          const merged = pendingEdits.has(String(r.id))
            ? { ...r, ...pendingEdits.get(String(r.id)) }
            : r
          return getUniqueKey(merged, uniqueBy) === draftKey
        }) || pendingRows.some((r, i) => i !== pendingIdx && getUniqueKey(r, uniqueBy) === draftKey)

      if (conflict) {
        setUniqueError(`A row with the same ${uniqueBy.join(' + ')} already exists.`)
        return false
      }
    }
    // Required columns (field-level or layout override) must hold a value
    // before the row can be saved or staged. Locked / read-only columns are
    // exempt — the user cannot type into them, a rule owns their value.
    const isEmptyValue = (v: unknown) => v === null || v === undefined || v === ''
    const missingRequired = displayCols.filter(
      (c) =>
        c.required &&
        !isPanelReadOnly(c) &&
        !editState.locks?.includes(c.field) &&
        isEmptyValue(editState.draft[c.field])
    )
    if (missingRequired.length > 0) {
      setUniqueError(
        `Required: ${missingRequired.map((c) => c.label || titleCase(c.field)).join(', ')}`
      )
      setEditState((s) => (s ? { ...s, missing: missingRequired.map((c) => c.field) } : s))
      return false
    }
    // Sum cap (options.sum_cap): the grid's total for `field` — with this
    // row's draft in place of its stored values — must stay within the cap.
    // rowsForRollup already folds the draft in for saved/pending rows; a row
    // being ADDED is not in it yet, so its own figure is added here.
    if (sumCap?.field && sumCap.cap) {
      const capValue = evaluateNumeric(sumCap.cap, resolveGridToken)
      if (capValue != null) {
        const col = sumCap.field
        const draftComputed = applyComputedFields({ ...editState.draft })
        const pendingIdx = editState.rowId.startsWith('pending:')
          ? Number(editState.rowId.slice('pending:'.length))
          : -1
        const isSaved = (rows ?? []).some((r) => String(r.id) === editState.rowId)
        // Every OTHER row as it stands (staged edits applied), plus this row's
        // stored figure = the total before this edit; plus its draft = after.
        const others =
          (rows ?? [])
            .filter((r) => !pendingDeletes.has(String(r.id)) && String(r.id) !== editState.rowId)
            .reduce((a, r) => {
              const rid = String(r.id)
              const merged = pendingEdits.has(rid) ? { ...r, ...pendingEdits.get(rid) } : r
              return a + (Number(applyComputedFields(merged as Record<string, unknown>)[col]) || 0)
            }, 0) +
          pendingRows.reduce(
            (a, r, i) =>
              i === pendingIdx
                ? a
                : a + (Number(applyComputedFields(r as Record<string, unknown>)[col]) || 0),
            0
          )
        const storedThis = isSaved
          ? (() => {
              const r = (rows ?? []).find((x) => String(x.id) === editState.rowId) as Record<
                string,
                unknown
              >
              const merged = pendingEdits.has(editState.rowId)
                ? { ...r, ...pendingEdits.get(editState.rowId) }
                : r
              return Number(applyComputedFields(merged)[col]) || 0
            })()
          : pendingIdx >= 0
            ? Number(
                applyComputedFields(pendingRows[pendingIdx] as Record<string, unknown>)[col]
              ) || 0
            : 0
        const before = others + storedThis
        const sum = others + (Number(draftComputed[col]) || 0)
        // Over the cap AND raising the total: refuse. An already-over grid
        // (legacy data) stays editable as long as the edit does not add to it.
        if (sum > capValue + 0.005 && sum > before + 0.005) {
          const fmt = (n: number) =>
            sumCap.format === 'currency'
              ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
              : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
          setUniqueError(
            `${sumCap.message ?? `${sumCap.label ?? 'Total'} cannot exceed ${fmt(capValue)}`} — this would make it ${fmt(sum)} (${fmt(sum - capValue)} over).`
          )
          return false
        }
      }
    }
    setUniqueError(null)
    setSaving(true)
    try {
      if (editState.rowId.startsWith('pending:')) {
        const ri = parseInt(editState.rowId.split(':')[1], 10)
        const existingRow = pendingRows[ri]
        staging?.updateRow(relatedCollection, manyField, ri, editState.draft)
        if (existingRow?.__prefilled && existingRow?.id != null) {
          setEditedPendingIds((prev) => new Set([...prev, existingRow.id as string | number]))
        }
        clearIfStillEditing()
        setSaving(false)
        return true
      }
      if (editState.rowId === 'new') {
        if ((isNew || isPendingMode) && staging) {
          staging.queueRow(relatedCollection, manyField, withNextOrder({ ...editState.draft }))
          clearIfStillEditing()
          return true
        }
        // Strip __m2m_*/__o2m_* staging keys before POST — those are handled separately below
        const m2mEntries = Object.entries(editState.draft).filter(([k]) => k.startsWith('__m2m_'))
        const o2mEntries = Object.entries(editState.draft).filter(([k]) => k.startsWith('__o2m_'))
        const cleanDraft = Object.fromEntries(
          Object.entries(editState.draft).filter(
            ([k]) => !k.startsWith('__m2m_') && !k.startsWith('__o2m_')
          )
        )
        const createBody = { ...withNextOrder(cleanDraft), [manyField]: parentId }
        let newRowRes: { data: { id: unknown } } | null = null
        try {
          newRowRes = await client.request<{ data: { id: unknown } }>(
            post(`/items/${relatedCollection}${pCtx}`, createBody)
          )
        } catch (err) {
          // A create can demand a change reason too (a new forecast year):
          // prompt, then retry the same create with the reason attached.
          const challenge = changeReasonChallenge(err)
          if (challenge) {
            setCrChallenge({
              challenge,
              retry: async (reason: string) => {
                const created = await client.request<{ data?: { id?: unknown } }>(
                  post(`/items/${relatedCollection}${pCtx}`, {
                    ...createBody,
                    _change_reason: reason
                  })
                )
                localCreateAtRef.current = Date.now()
                if (created?.data?.id != null) stampLocalWrite(String(created.data.id))
                qc.invalidateQueries({
                  queryKey: ['o2m-rows', relatedCollection, manyField, parentId]
                })
                clearIfStillEditing()
              }
            })
            setSaving(false)
            return false
          }
          throw err
        }
        const newRowId = newRowRes?.data?.id
        localCreateAtRef.current = Date.now()
        if (newRowId != null) stampLocalWrite(String(newRowId))
        if (newRowId != null && m2mEntries.length) {
          await Promise.all(
            m2mEntries.map(([key, relatedId]) => {
              if (relatedId == null) return Promise.resolve()
              const fieldName = key.slice('__m2m_'.length)
              const target = resolveM2MTarget({
                field: fieldName,
                interface: 'select-multiple-m2m'
              } as CMSField)
              if (!target) return Promise.resolve()
              return client.request(
                post(`/items/${target.junctionCollection}`, {
                  [target.junctionManyField]: newRowId,
                  [target.junctionOtherField]: relatedId
                })
              )
            })
          )
        }
        if (newRowId != null && o2mEntries.length) {
          for (const [key, members] of o2mEntries) {
            const fieldName = key.slice('__o2m_'.length)
            const grandRel = childRelations.find(
              (r) => r.one_collection === relatedCollection && r.one_field === fieldName
            )
            if (!grandRel?.many_collection || !grandRel.many_field) continue
            const memberList = Array.isArray(members) ? (members as Record<string, unknown>[]) : []
            for (const member of memberList) {
              await client.request(
                post(`/items/${grandRel.many_collection}`, {
                  ...member,
                  [grandRel.many_field]: newRowId
                })
              )
            }
          }
        }
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      } else {
        // Filter to display columns — draft includes full API row (id, system fields, etc.).
        // Deliberately the FULL layout-gated set, not preset-effective: row rules may autofill
        // preset-hidden fields, and a mid-edit preset switch must not drop typed values.
        // Rule TARGETS ride along even when the layout doesn't display them
        // (category_type is derived from the picked category but sits on no
        // column) — otherwise the autofill the editor just showed is silently
        // dropped at save and the record disagrees with the form.
        const ruleTargetKeys = (rowRules ?? [])
          .filter((r) => (r as { target_type?: string }).target_type !== 'lock')
          .map((r) => (r as { target_field: string }).target_field)
          .filter((k) => typeof k === 'string' && k.length > 0 && k !== 'id')
        const writableKeys = new Set([
          ...displayCols.map((c) => c.field).filter((k) => !k.startsWith('__m2m_')),
          ...ruleTargetKeys,
          // A reason an editor action prefilled (carry-forward) rides the row:
          // the server stores it on the activity row, never in a column.
          '_change_reason'
        ])
        const rowPayload = Object.fromEntries(
          Object.entries(editState.draft).filter(([k]) => writableKeys.has(k))
        )
        if (isPendingMode && staging) {
          // __nested_ops_* keys ride along here (exempt from the writableKeys filter) so the
          // batch flush can apply them — the immediate PATCH branch below still strips them.
          const nestedOpsEntries = Object.entries(editState.draft).filter(([k]) =>
            k.startsWith('__nested_ops_')
          )
          // Queue only values that actually CHANGED vs the saved row — the full
          // draft would make every column look edited (change-reason preflight
          // would then name all of them, and the flush PATCH would re-write
          // untouched columns).
          const baseRow = rows.find((r) => String(r.id) === editState.rowId)
          const queuedPayload = baseRow
            ? Object.fromEntries(
                Object.entries(rowPayload).filter(
                  ([k, v]) =>
                    String(v ?? '') !== String((baseRow as Record<string, unknown>)[k] ?? '')
                )
              )
            : rowPayload
          // Opening a row and clicking away is not an edit. An EMPTY queued
          // payload still registered the row as pending ("Edited" badge, a
          // flush PATCH with no fields) — close without queueing instead.
          if (Object.keys(queuedPayload).length === 0 && nestedOpsEntries.length === 0) {
            clearIfStillEditing()
            return true
          }
          staging.queueEdit(relatedCollection, manyField, editState.rowId, {
            ...queuedPayload,
            ...Object.fromEntries(nestedOpsEntries)
          })
          clearIfStillEditing()
          return true
        }
        try {
          await client.request(
            patch(`/items/${relatedCollection}/${editState.rowId}${pCtx}`, rowPayload)
          )
        } catch (err) {
          const challenge = changeReasonChallenge(err)
          if (challenge) {
            const url = `/items/${relatedCollection}/${editState.rowId}${pCtx}`
            setCrChallenge({
              challenge,
              retry: async (reason: string) => {
                await client.request(patch(url, { ...rowPayload, _change_reason: reason }))
                stampLocalWrite(savedRowId)
                qc.invalidateQueries({
                  queryKey: ['o2m-rows', relatedCollection, manyField, parentId]
                })
                clearIfStillEditing()
              }
            })
            setSaving(false)
            return false
          }
          throw err
        }
        stampLocalWrite(savedRowId)
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      }
      clearIfStillEditing()
      return true
    } catch {
      return false
    } finally {
      setSaving(false)
    }
  }

  const [editedPendingIds, setEditedPendingIds] = useState<Set<string | number>>(new Set())
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const [reordering, setReordering] = useState(false)
  const [bulkCount, setBulkCount] = useState(1)
  const [bulkAdding, setBulkAdding] = useState(false)
  const [defaultsOpen, setDefaultsOpen] = useState(false)
  const [defaultValues, setDefaultValues] = useState<Record<string, unknown>>({})
  const [applyOpen, setApplyOpen] = useState(false)
  // Bulk re-derive ("Re-run rules on all lines"): preview → apply.
  const [rerunOpen, setRerunOpen] = useState(false)
  const [rerunMode, setRerunMode] = useState<'empty-only' | 'all'>('empty-only')
  const [rerunBusy, setRerunBusy] = useState<'preview' | 'apply' | null>(null)
  const [rerunPreview, setRerunPreview] = useState<{
    rows: number
    fields: Record<string, number>
    changes: Array<{ id: string; patch: Record<string, unknown> }>
    truncated?: boolean
  } | null>(null)
  const [applyValues, setApplyValues] = useState<Record<string, unknown>>({})
  const [applying, setApplying] = useState(false)

  function setDefaultField(k: string, v: unknown) {
    setDefaultValues((prev) => ({ ...prev, [k]: v }))
  }

  async function applyValuesToAllRows() {
    const hasValues = Object.keys(applyValues).some(
      (k) => applyValues[k] !== null && applyValues[k] !== undefined
    )
    if (!hasValues) return
    setApplying(true)
    try {
      if (rows.length) {
        if (isPendingMode && staging) {
          rows
            .filter((r) => !pendingDeletes.has(String(r.id)))
            .forEach((row) =>
              staging.queueEdit(relatedCollection, manyField, String(row.id), applyValues)
            )
        } else {
          await Promise.all(
            rows.map((row) =>
              client.request(patch(`/items/${relatedCollection}/${row.id}${pCtx}`, applyValues))
            )
          )
          for (const row of rows) stampLocalWrite(String(row.id))
          qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
        }
      }
      if (pendingRows.length && staging) {
        pendingRows.forEach((row, i) =>
          staging.updateRow(relatedCollection, manyField, i, { ...row, ...applyValues })
        )
      }
      setApplyOpen(false)
      setApplyValues({})
    } catch {
      /* ignore */
    } finally {
      setApplying(false)
    }
  }

  // Line generators (#336): N rows with a date column advancing one month per
  // row — the "12 monthly lines" ask, without a bespoke dialog.
  async function addPatternedRows(dateField: string) {
    const n = Math.max(1, Math.min(24, bulkCount))
    const base = new Date()
    const rowsData = Array.from({ length: n }, (_, i) => {
      const d = new Date(base.getFullYear(), base.getMonth() + 1 + i, 1)
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
      return { ...rowDefaultSeed, ...defaultValues, [dateField]: iso }
    })
    if ((isNew || isPendingMode) && staging) {
      for (const rd of withNextOrders(rowsData)) staging.queueRow(relatedCollection, manyField, rd)
      return
    }
    setBulkAdding(true)
    try {
      // Sequential: ids then follow the pattern order, which is the only
      // order a layout without a row_order_field can render.
      for (const rd of withNextOrders(rowsData)) {
        await client.request(
          post(`/items/${relatedCollection}${pCtx}`, { ...rd, [manyField]: parentId })
        )
      }
      localCreateAtRef.current = Date.now()
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    } catch {
      /* ignore */
    } finally {
      setBulkAdding(false)
    }
  }

  /** One new row per unmatched candidate (PO line with no workflow line),
   *  built from the banner's field_map — staged in pending/new mode,
   *  written now otherwise. Same order stamping as any bulk add. */
  async function addUnmatchedCandidates() {
    const cfg = rowMatchPanel?.unmatched_banner
    if (!cfg || rowMatches.unmatchedCandidates.length === 0) return
    const rowsData = rowMatches.unmatchedCandidates.map((c) => ({
      ...rowDefaultSeed,
      ...rowFromCandidate(cfg, c as Record<string, unknown>)
    }))
    if ((isNew || isPendingMode) && staging) {
      for (const rd of withNextOrders(rowsData)) staging.queueRow(relatedCollection, manyField, rd)
      return
    }
    setBulkAdding(true)
    try {
      for (const rd of withNextOrders(rowsData)) {
        await client.request(
          post(`/items/${relatedCollection}${pCtx}`, { ...rd, [manyField]: parentId })
        )
      }
      localCreateAtRef.current = Date.now()
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    } catch (err) {
      toast.error(`Could not add rows: ${(err as Error)?.message ?? 'unknown error'}`)
    } finally {
      setBulkAdding(false)
    }
  }

  async function addBulkRows(useDefaults: boolean) {
    const n = Math.max(1, Math.min(100, bulkCount))
    const rowData = useDefaults ? { ...rowDefaultSeed, ...defaultValues } : { ...rowDefaultSeed }
    if ((isNew || isPendingMode) && staging) {
      const batch = withNextOrders(Array.from({ length: n }, () => ({ ...rowData })))
      for (const rd of batch) staging.queueRow(relatedCollection, manyField, rd)
      return
    }
    setBulkAdding(true)
    try {
      for (const rd of withNextOrders(Array.from({ length: n }, () => ({ ...rowData })))) {
        await client.request(
          post(`/items/${relatedCollection}${pCtx}`, { ...rd, [manyField]: parentId })
        )
      }
      localCreateAtRef.current = Date.now()
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    } catch {
      /* ignore */
    } finally {
      setBulkAdding(false)
    }
  }

  function handleDragStart(ri: number) {
    setDragIdx(ri)
  }
  function handleDragOver(e: React.DragEvent, ri: number) {
    e.preventDefault()
    setDropIdx(ri)
  }
  function handleDragEnd() {
    setDragIdx(null)
    setDropIdx(null)
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    if (dragIdx === null || dropIdx === null || dragIdx === dropIdx) {
      handleDragEnd()
      return
    }
    const reordered = [...rows]
    const [moved] = reordered.splice(dragIdx, 1)
    reordered.splice(dropIdx, 0, moved)
    const changed = reordered
      .map((row, i) => ({ row, newOrder: i }))
      .filter(({ row, newOrder }) => {
        const pe = isPendingMode ? pendingEdits.get(String(row.id)) : undefined
        const current = pe?.[rowOrderField!] ?? row[rowOrderField!]
        return Number(current ?? -1) !== newOrder
      })

    if (isPendingMode && staging) {
      changed.forEach(({ row, newOrder }) =>
        staging.queueEdit(relatedCollection, manyField, String(row.id), {
          [rowOrderField!]: newOrder
        })
      )
      handleDragEnd()
      return
    }

    setReordering(true)
    try {
      await Promise.all(
        changed.map(({ row, newOrder }) =>
          client.request(
            patch(`/items/${relatedCollection}/${row.id}${pCtx}`, { [rowOrderField!]: newOrder })
          )
        )
      )
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    } catch {
      /* reorder failed; rows stay unchanged */
    } finally {
      setReordering(false)
      handleDragEnd()
    }
  }

  async function deleteRow(row: Record<string, unknown>, e: React.MouseEvent) {
    e.stopPropagation()
    const id = row.id
    if (isPendingMode && staging) {
      staging.queueDelete(relatedCollection, manyField, String(id))
      if (editState?.rowId === String(id)) {
        setEditState(null)
      }
      return
    }
    try {
      await client.request(del(`/items/${relatedCollection}/${id}${pCtx}`))
      stampLocalWrite(String(id))
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      if (editState?.rowId === String(id)) {
        setEditState(null)
      }
      if (showRowRevisions)
        qc.invalidateQueries({
          queryKey: ['o2m-field-snapshots', relatedCollection, manyField, parentId]
        })
    } catch {
      /* ignore */
    }
  }

  function renderCell(
    col: CMSField,
    val: unknown,
    rowId?: string,
    rowData?: Record<string, unknown>
  ) {
    const colOpts = col.options
      ? ((typeof col.options === 'string'
          ? (() => {
              try {
                return JSON.parse(col.options as string)
              } catch {
                return {}
              }
            })()
          : col.options) as Record<string, unknown>)
      : {}

    // Formula column: arithmetic over {{col}} (row values) + {{dotted.path}}
    // (bulk-resolved path values) — display-only, computed at render. An
    // unsaved (pending) row isn't in `rows`, so its caller passes the row
    // object directly via rowData.
    if (col.interface === 'formula-column') {
      const formula = typeof colOpts.column_formula === 'string' ? colOpts.column_formula : ''
      if (!formula || (!rowId && !rowData)) return <span className='text-slate-300'>—</span>
      const row = rowData ?? rows.find((r) => String(r.id) === rowId) ?? {}
      // A dotted reference comes from the bulk resolve-paths response; a bare
      // one is a plain column on the row.
      // Addendum / staged rows carry decimals as STRINGS ("1107.4400"); the
      // formula engine refuses a non-number, so a numeric-looking string is
      // coerced here rather than rendering "—".
      const asNumeric = (v: unknown) =>
        typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v
      const result = evaluateNumeric(formula, (ref) =>
        asNumeric(
          ref.includes('.')
            ? rowId
              ? resolvedPathData?.rows[rowId]?.[ref]?.value
              : undefined
            : (row as Record<string, unknown>)[ref]
        )
      )
      if (result === null) return <span className='text-slate-300'>—</span>
      const formatted = result.toLocaleString(
        'en-US',
        numericIntlOptions(colOpts, colOpts.format as string | undefined)
      )
      // Formula tooltip (#204): the formula with each token replaced by its
      // current value, so the reader can check the math without hunting.
      const substituted = formula.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, ref: string) => {
        const v = ref.includes('.')
          ? rowId
            ? resolvedPathData?.rows[rowId]?.[ref]?.value
            : undefined
          : (row as Record<string, unknown>)[ref]
        return v == null || v === '' ? '0' : String(v)
      })
      return (
        <span className='tabular-nums' data-tip={`${formula} = ${substituted} = ${formatted}`}>
          {formatted}
        </span>
      )
    }

    // Matched-aggregate column
    if (col.interface === 'match-agg-column') {
      const entry = matchAggData.get(col.field)
      if (!entry || !rowId) return <span className='text-slate-300'>—</span>
      const gridRow = rows.find((r) => String(r.id) === rowId) ?? {}
      const walk = (obj: unknown, path: string): unknown =>
        path
          .split('.')
          .reduce<unknown>(
            (cur, seg) =>
              cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined,
            obj
          )
      const matched = entry.rows.filter((r) =>
        entry.cfg.rowKeys.every(([path, rowField]) => {
          const a = walk(r, path)
          const b = (gridRow as Record<string, unknown>)[rowField]
          if (a === null || a === undefined || b === null || b === undefined) return false
          return String(a) === String(b)
        })
      )
      let agg =
        entry.cfg.aggregate === 'count'
          ? matched.length
          : matched.reduce((sum, r) => sum + (Number(r[entry.cfg.valueField]) || 0), 0)
      if (entry.cfg.formula) {
        // `__agg__` is just another field to the expression engine, so the
        // formula no longer needs its own regex, its own sanitizer and its own
        // `new Function` — all of which substituted the aggregate's VALUE into
        // the source text before parsing it.
        const v = evaluateNumeric(entry.cfg.formula, {
          ...(gridRow as Record<string, unknown>),
          __agg__: agg
        })
        if (v === null) return <span className='text-slate-300'>—</span>
        agg = v
      }
      const formatted = agg.toLocaleString(
        'en-US',
        numericIntlOptions(colOpts, entry.cfg.format as string | undefined)
      )
      return <span className='tabular-nums'>{formatted}</span>
    }

    // Type-agnostic currency formatting (options.format: 'currency') — covers
    // relation-path columns whose resolved values arrive as strings, and any
    // other column regardless of declared type. Numeric-typed columns keep
    // their existing int/decimal/currency handling further down.
    if (
      colOpts.format === 'currency' &&
      val !== null &&
      val !== undefined &&
      val !== '' &&
      Number.isFinite(Number(val))
    ) {
      val = Number(val).toLocaleString('en-US', {
        ...numericIntlOptions(colOpts, 'currency'),
        currency: (colOpts.currency as string) || 'USD'
      })
    }
    // Same for options.format: 'number' — a relation-path column's resolved
    // value is a string ("135297.66") and would otherwise print raw, ignoring
    // the layout's precision.
    if (
      colOpts.format === 'number' &&
      col.interface === 'relation-path' &&
      val !== null &&
      val !== undefined &&
      val !== '' &&
      Number.isFinite(Number(val))
    ) {
      val = Number(val).toLocaleString('en-US', numericIntlOptions(colOpts, 'number'))
    }

    // Presence display: relation-path column configured display:'presence'
    // renders linked/none instead of the joined values (e.g. "PO Linked").
    if (col.interface === 'relation-path' && colOpts.display === 'presence') {
      const has = val !== null && val !== undefined && String(val).trim() !== ''
      return (
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium',
            has
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
          )}
        >
          {has ? 'Yes' : 'No'}
        </span>
      )
    }

    if (val === null || val === undefined) return <span className='text-slate-300'>—</span>
    // Relation-path cells configured for drill-down open the final entity.
    if (col.interface === 'relation-path' && drill && rowId) {
      const cfg = fieldDrilldownConfig(col)
      const rowMeta = resolvedPathData?.rows[rowId]?.[col.field]
      const target = resolvedPathData?.targets[col.field]
      if (cfg && rowMeta && target && rowMeta.ids.length > 0) {
        return (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              drill.open({
                collection: target,
                itemId: rowMeta.ids[0],
                layoutId: cfg.layout_id,
                width: cfg.width,
                title: String(val)
              })
            }}
            className='block max-w-full truncate text-left underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-[#172940] hover:decoration-[#00ceff] dark:hover:text-[#00ceff]'
          >
            {String(val)}
          </button>
        )
      }
    }
    const m2oRel = m2oRelMap.get(col.field)
    if (m2oRel?.one_collection) {
      const display = m2oDisplays[m2oRel.one_collection]?.[String(val)]
      if (!display && m2oFetching)
        return <Loader2 className='h-3 w-3 animate-spin text-slate-300' />
      const cfg = drill ? fieldDrilldownConfig(col) : null
      const isStaleVal = val != null && staleCellValues.get(col.field)?.has(String(val)) === true
      let inner: React.ReactNode
      if (cfg && drill) {
        inner = (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              drill.open({
                collection: m2oRel.one_collection as string,
                itemId: String(val),
                layoutId: cfg.layout_id,
                width: cfg.width,
                title: display ?? String(val)
              })
            }}
            className='block max-w-full truncate text-left underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-[#172940] hover:decoration-[#00ceff] dark:hover:text-[#00ceff]'
          >
            {display ?? String(val)}
          </button>
        )
      } else {
        inner = <span className='block truncate'>{display ?? String(val)}</span>
      }
      return isStaleVal ? <StaleValueFlag>{inner}</StaleValueFlag> : inner
    }
    if (col.type === 'boolean')
      return (
        <span className={val ? 'text-emerald-600' : 'text-slate-400'}>{val ? 'Yes' : 'No'}</span>
      )
    if (col.type === 'datetime' || col.type === 'date') {
      try {
        return <span className='block truncate'>{new Date(String(val)).toLocaleDateString()}</span>
      } catch {
        /* fall */
      }
    }
    const NUMERIC_TYPES = [
      'integer',
      'bigInteger',
      'decimal',
      'float',
      'money',
      'smallmoney',
      'tinyint',
      'smallint',
      'bigint',
      'int',
      'numeric',
      'real',
      'double',
      'number'
    ]
    if (NUMERIC_TYPES.includes(col.type ?? '')) {
      const num = Number(val)
      if (!Number.isNaN(num)) {
        try {
          const opts = col.options
            ? ((typeof col.options === 'string' ? JSON.parse(col.options) : col.options) as Record<
                string,
                unknown
              >)
            : {}
          const fmt = opts.format as string | undefined
          if (fmt === 'int') {
            return (
              <span className='block truncate tabular-nums'>
                {new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(num)}
              </span>
            )
          }
          if (fmt === 'decimal') {
            const prec = typeof opts.precision === 'number' ? opts.precision : 2
            return (
              <span className='block truncate tabular-nums'>
                {new Intl.NumberFormat(undefined, {
                  minimumFractionDigits: prec,
                  maximumFractionDigits: prec
                }).format(num)}
              </span>
            )
          }
          if (fmt === 'currency') {
            const curr = (opts.currency as string) || 'USD'
            return (
              <span className='block truncate tabular-nums'>
                {new Intl.NumberFormat(undefined, {
                  ...numericIntlOptions(colOpts, 'currency'),
                  currency: curr
                }).format(num)}
              </span>
            )
          }
        } catch {
          /* fall through to default */
        }
      }
    }
    return <span className='block truncate'>{String(val)}</span>
  }

  // Live rows per drawer relation — feeds the panel strip's rollup/formula
  // values so Allocated / Available react to allocation edits in real time.
  // MUST sit above the loading early-return, or the hook order shifts once
  // data arrives.

  if (colsLoading || (!isNew && rowsLoading))
    return (
      <div className='py-3 text-center text-[12px] text-slate-400'>
        <Loader2 className='h-4 w-4 animate-spin inline' />
      </div>
    )

  const isEditingNew = editState?.rowId === 'new'

  // Same arithmetic as the empty-state colSpan below — reused for the nested
  // relation editor's expandable section row so it spans the full grid width.
  // EXACT header column count — every full-width row (editor panel, nested
  // rows, empty states) must span precisely this many cells. Under
  // `table-fixed` an overshooting colSpan is NOT clamped: the browser invents
  // a phantom column with the leftover width and no header cell, which reads
  // as a darker strip on the right of the header (reported from a host's dark theme).
  // Selection column renders only on the record's own rows (never in the
  // addendum view, which draws its own cells) — and it counts here.
  const selectColOn = selectMode && activeView === 'original' && !readOnly
  const nestedColSpan =
    (selectColOn ? 1 : 0) +
    (enableReorder && (rowOrderField || isNew || isPendingMode) ? 1 : 0) +
    (showLineNumbers ? 1 : 0) +
    (isNew || isPendingMode ? 1 : 0) +
    effectiveCols.length +
    1
  // Which leading cell renders FIRST in a saved row — the "since you opened"
  // tick sits in it. Mirrors the header's cell order exactly.
  const firstLeadCell: 'select' | 'reorder' | 'num' | 'status' | 'data' = selectColOn
    ? 'select'
    : enableReorder && (rowOrderField || isPendingMode)
      ? 'reorder'
      : showLineNumbers
        ? 'num'
        : isPendingMode
          ? 'status'
          : 'data'
  const sinceTick = (id: string): ReactNode => {
    if (!sinceOpened) return null
    const tone = sinceOpened.added.has(id)
      ? 'bg-emerald-500'
      : sinceOpened.changed.has(id)
        ? 'bg-amber-500'
        : null
    if (!tone) return null
    return (
      <span
        aria-hidden='true'
        className={cn('pointer-events-none absolute inset-y-0 left-0 w-0.5', tone)}
      />
    )
  }

  /** The rows a person can SEE right now, in render order: saved rows within
   *  the render cap and not in a collapsed section (staged edits merged, staged
   *  deletes skipped), then the staged new rows. Drives arrow-key navigation,
   *  select-all and the bulk edit. */
  type RowTarget = {
    key: string
    kind: 'saved' | 'pending'
    row: Record<string, unknown>
    idx: number
  }
  const visibleRowTargets = (): RowTarget[] => {
    const out: RowTarget[] = []
    if (activeView !== 'original') return out
    if (!isNew) {
      rows.slice(0, renderCap).forEach((r, ri) => {
        const id = String(r.id)
        if (pendingDeletes.has(id)) return
        if (sectionsActive) {
          const sec = sectionOf(r)
          if (sec !== null && collapsedSections.has(sec)) return
        }
        out.push({
          key: id,
          kind: 'saved',
          row: pendingEdits.has(id) ? { ...r, ...pendingEdits.get(id) } : r,
          idx: ri
        })
      })
    }
    pendingRows.forEach((r, i) => {
      out.push({ key: `pending:${i}`, kind: 'pending', row: r, idx: i })
    })
    return out
  }
  const selectableKeys = selectColOn ? visibleRowTargets().map((t) => t.key) : []
  const allVisibleSelected =
    selectableKeys.length > 0 && selectableKeys.every((k) => selectedIds.has(k))
  const selectedTargets = selectColOn
    ? visibleRowTargets().filter((t) => selectedIds.has(t.key))
    : []

  /** Does the open editor hold anything the row doesn't? Computed columns are
   *  ignored (startEdit re-derives them); staged relation keys count when
   *  they carry something. */
  const editDraftDirty = (): boolean => {
    const cur = editStateRef.current
    if (!cur) return false
    if (cur.rowId === 'new') return true
    const base = visibleRowTargets().find((t) => t.key === cur.rowId)?.row ?? {}
    for (const [k, v] of Object.entries(cur.draft)) {
      if (k.startsWith('__')) {
        if (Array.isArray(v) ? v.length > 0 : v != null && typeof v === 'object')
          if (JSON.stringify(v) !== JSON.stringify(EMPTY_NESTED_OPS)) return true
        continue
      }
      if (computedWriteFields.has(k)) continue
      if (!displayCols.some((c) => c.field === k)) continue
      if (String(v ?? '') !== String(base[k] ?? '')) return true
    }
    return false
  }

  /** Split mode: ArrowUp/ArrowDown walk the rows. A dirty editor commits
   *  first (exactly like the outside-click commit); a row that refuses to
   *  close — missing required field, unique conflict — keeps the selection. */
  const moveSelection = async (delta: 1 | -1) => {
    const cur = editStateRef.current
    if (!cur || cur.rowId === 'new') return
    const targets = visibleRowTargets()
    const i = targets.findIndex((t) => t.key === cur.rowId)
    if (i < 0) return
    const j = i + delta
    if (j < 0 || j >= targets.length) return
    if (editDraftDirty()) {
      const ok = await saveEdit()
      if (!ok) return
    } else {
      cancelEdit()
    }
    const next = targets[j]
    if (next.kind === 'pending') startPendingEdit(next.row, next.idx)
    else startEdit(next.row)
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-o2m-row="${relatedCollection}:${next.key}"]`
      )
      if (!el) return
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    }, 0)
  }
  moveSelectionRef.current = moveSelection

  /** Bulk lines edit: the touched values land on every selected row, each
   *  row's rules re-run per touched field exactly as a live edit would
   *  (probe → changed_field passes, auto targets blanked, locks honoured), and
   *  the result goes out through the grid's OWN write path for its mode. */
  async function applyBulkEdit(touched: Record<string, unknown>) {
    await applyValuesToTargets(
      touched,
      visibleRowTargets().filter((t) => selectedIds.has(t.key)),
      { clearSelection: true, noun: 'row' }
    )
  }
  /** Every row the grid holds (saved minus staged deletes, then pending) —
   *  collapsed sections and rows past the render cap included. */
  const allRowTargets = (): RowTarget[] => {
    const out: RowTarget[] = []
    if (activeView !== 'original') return out
    if (!isNew) {
      rows.forEach((r, ri) => {
        const id = String(r.id)
        if (pendingDeletes.has(id)) return
        out.push({
          key: id,
          kind: 'saved',
          row: pendingEdits.has(id) ? { ...r, ...pendingEdits.get(id) } : r,
          idx: ri
        })
      })
    }
    pendingRows.forEach((r, i) => {
      out.push({ key: `pending:${i}`, kind: 'pending', row: r, idx: i })
    })
    return out
  }
  async function applyValuesToTargets(
    touched: Record<string, unknown>,
    targets: RowTarget[],
    opts: { clearSelection: boolean; noun: 'row' | 'line' }
  ) {
    const keys = Object.keys(touched)
    if (keys.length === 0 || targets.length === 0) return
    const ruleTargetKeys = (rowRules ?? [])
      .filter((r) => (r as { target_type?: string }).target_type !== 'lock')
      .map((r) => (r as { target_field: string }).target_field)
      .filter((k) => typeof k === 'string' && k.length > 0 && k !== 'id')
    const writableKeys = new Set([
      ...displayCols.map((c) => c.field).filter((k) => !k.includes('.') && !k.startsWith('__')),
      ...ruleTargetKeys
    ])
    const plan: Array<{ t: RowTarget; changes: Record<string, unknown> }> = []
    for (const t of targets) {
      let cur = applyComputedFields({ ...t.row, ...touched })
      let locks: string[] = []
      let expected: Record<string, unknown> | undefined
      if (rowRules?.length) {
        try {
          const probe = await client.request<{
            locks?: string[]
            expected?: Record<string, unknown>
          }>(
            post('/field-rules/evaluate', {
              collection: relatedCollection,
              data: t.row,
              locks_only: true,
              probe: true,
              parent_context: buildParentCtx(),
              row_rules: rowRules
            })
          )
          locks = probe.locks ?? []
          expected = probe.expected
        } catch {
          /* rules stay unknown for this row — the server still enforces locks */
        }
        for (const k of keys) {
          if (locks.includes(k)) continue
          const autoFields = autoTargetsFor(k, { ...t.row }, expected)
          const evalData: Record<string, unknown> = { ...cur }
          for (const f of autoFields) evalData[f] = null
          try {
            const res = await client.request<{
              updates?: Record<string, unknown>
              locks?: string[]
              expected?: Record<string, unknown>
            }>(
              post('/field-rules/evaluate', {
                collection: relatedCollection,
                data: evalData,
                changed_field: k,
                probe: true,
                parent_context: buildParentCtx(),
                row_rules: rowRules
              })
            )
            const fresh: Record<string, unknown> = {}
            for (const [uk, uv] of Object.entries(res.updates ?? {})) {
              if (uk in touched) continue
              fresh[uk] = uv
            }
            for (const f of autoFields) if (!(f in fresh) && !(f in touched)) fresh[f] = null
            cur = applyComputedFields({ ...cur, ...fresh })
            locks = res.locks ?? locks
            expected = res.expected ?? expected
          } catch {
            /* a rule pass that fails leaves the touched value as typed */
          }
        }
      }
      const changes: Record<string, unknown> = {}
      for (const k of keys) if (!locks.includes(k)) changes[k] = touched[k] ?? null
      for (const [k, v] of Object.entries(cur)) {
        if (k in changes || k === 'id' || k === manyField) continue
        if (computedWriteFields.has(k) || !writableKeys.has(k)) continue
        if (String(v ?? '') !== String(t.row[k] ?? '')) changes[k] = v
      }
      plan.push({ t, changes })
    }
    const finish = (applied: number, failed: string[]) => {
      if (opts.clearSelection) setSelectedIds(new Set())
      const noun = applied === 1 ? opts.noun : `${opts.noun}s`
      if (failed.length)
        toast.error(
          `Applied to ${applied} ${noun} — ${failed.length} failed: ${failed.slice(0, 3).join('; ')}`
        )
      else toast.success(`Applied to ${applied} ${noun}`)
    }
    if ((isNew || isPendingMode) && staging) {
      let applied = 0
      for (const { t, changes } of plan) {
        if (Object.keys(changes).length === 0) continue
        if (t.kind === 'pending')
          staging.updateRow(relatedCollection, manyField, t.idx, {
            ...(pendingRows[t.idx] ?? t.row),
            ...changes
          })
        else staging.queueEdit(relatedCollection, manyField, t.key, changes)
        applied++
      }
      finish(applied, [])
      return
    }
    // Immediate mode: one PATCH per saved row, in order. A change-reason
    // challenge pauses the run; the reason then rides every remaining write.
    let applied = 0
    const failed: string[] = []
    const writeFrom = async (start: number, reason?: string): Promise<void> => {
      for (let i = start; i < plan.length; i++) {
        const { t, changes } = plan[i]
        if (Object.keys(changes).length === 0) continue
        if (t.kind === 'pending') {
          staging?.updateRow(relatedCollection, manyField, t.idx, {
            ...(pendingRows[t.idx] ?? t.row),
            ...changes
          })
          applied++
          continue
        }
        try {
          await client.request(
            patch(
              `/items/${relatedCollection}/${t.key}${pCtx}`,
              reason ? { ...changes, _change_reason: reason } : changes
            )
          )
          stampLocalWrite(t.key)
          applied++
        } catch (err) {
          const challenge = reason ? null : changeReasonChallenge(err)
          if (challenge) {
            // writeFrom(i, reason) resumes here and finishes the run itself;
            // rows written before the challenge are already on the server.
            setCrChallenge({ challenge, retry: (r: string) => writeFrom(i, r) })
            qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
            return
          }
          failed.push(`#${t.key} ${(err as Error)?.message ?? 'failed'}`)
        }
      }
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      finish(applied, failed)
    }
    await writeFrom(0)
  }
  applyFieldToAllRef.current = (target, value) =>
    applyValuesToTargets({ [target]: value }, allRowTargets(), {
      clearSelection: false,
      noun: 'line'
    })
  gridReadyRef.current = true
  if (pendingApplyRef.current) {
    const p = pendingApplyRef.current
    pendingApplyRef.current = null
    // Past the loading early-return: rows are here. Run after this render
    // commits so the staging state updates land on a settled grid.
    window.setTimeout(() => void applyFieldToAllRef.current(p.target, p.value), 0)
  }

  /**
   * Wide grids are unreadable to edit in place: a dozen columns squeezed into
   * table cells leaves each input a few characters wide, with the header row as
   * the only clue to what you are typing into. When a row is being edited it is
   * lifted out of the table into a full-width panel — every field labelled, at
   * a workable size, in the row's own space.
   *
   * The SAME field components render in both modes, so validation, cascades,
   * pickers and blur-to-save behave identically; only the container changes.
   * Narrow grids keep the inline editor, where tabbing across a row is faster
   * than reading a form.
   */
  // Threshold, not configuration: the panel earns its place exactly when a row
  // stops fitting readably across the table, which is what column count tells
  // us. Narrow grids keep the inline editor.
  const rowEditorMode: 'panel' | 'inline' | 'split' = splitMode
    ? 'split'
    : effectiveCols.filter((c) => !isSummaryCol(c)).length >= 6
      ? 'panel'
      : 'inline'

  /** Short human handle for the row being edited, for the panel header — the
   *  first text-ish column that has a value, else the row id. */
  const rowIdentityLabel = (row: Record<string, unknown>): string => {
    for (const c of effectiveCols) {
      if (isSummaryCol(c)) continue
      const v = row[c.field]
      // A bare number is an FK id or a typed amount, not an identity —
      // showing it reads as a mystery ("Line 1 · 2").
      if (typeof v === 'string' && v.trim() !== '' && !/^-?\d+(\.\d+)?$/.test(v.trim()))
        return v.length > 60 ? `${v.slice(0, 60)}…` : v
    }
    return row.id != null ? `#${row.id}` : 'New line'
  }

  /** Derived or non-editable in the panel: shown as a value, ordered last. */
  /**
   * The row's nested relation editors (e.g. a line's unit allocations). Same
   * markup whether it sits in its own table row (inline mode) or inside the
   * elevated panel — a row's children belong with the row being edited, not
   * stranded in a strip below it.
   */
  /** Overlay the draft with LIVE values: client-side rollups summed from the
   *  drawer's current rows, so dependent formulas recompute per keystroke.
   *  `useLive: false` (collapsed rows) reads only the row's OWN staged
   *  `__o2m_<field>` members — drawerLiveRows belongs to whichever row's
   *  drawer is currently mounted and would leak across rows. */
  const liveOverlayDraft = (
    draft: Record<string, unknown>,
    opts?: { rowKey?: string }
  ): Record<string, unknown> => {
    const rowKey = opts?.rowKey ?? '__new__'
    const overlay = { ...draft }
    for (const c of effectiveCols) {
      if (c.computed_type !== 'rollup' || !c.computed_formula) continue
      let cfg: {
        sources?: Array<{ related_collection?: string; aggregate?: string; value_field?: string }>
      } | null = null
      try {
        const parsed = JSON.parse(String(c.computed_formula))
        cfg = parsed?.sources ? parsed : { sources: [parsed] }
      } catch {
        continue
      }
      let total: number | null = null
      for (const src of cfg?.sources ?? []) {
        // Heuristic match: the drawer field usually IS the related collection
        // name; a single-drawer grid matches by default.
        const relFields = (drawerRelations ?? []).map((d) => (typeof d === 'string' ? d : d.field))
        const relField =
          relFields.find((f) => f === src.related_collection) ??
          (relFields.length === 1 ? relFields[0] : undefined)
        const staged = relField
          ? (draft[`__o2m_${relField}`] as Array<Record<string, unknown>> | undefined)
          : undefined
        const liveRows = (relField ? drawerLiveRows[`${rowKey}|${relField}`] : undefined) ?? staged
        if (!liveRows) continue
        const agg = src.aggregate ?? 'sum'
        if (agg === 'count') total = (total ?? 0) + liveRows.length
        else {
          const vals = liveRows
            .map((r) => Number(r[src.value_field ?? ''] ?? 0))
            .filter(Number.isFinite)
          if (agg === 'sum') total = (total ?? 0) + vals.reduce((a, b) => a + b, 0)
          else if (agg === 'avg')
            total = (total ?? 0) + (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0)
          else if (agg === 'min') total = (total ?? 0) + (vals.length ? Math.min(...vals) : 0)
          else if (agg === 'max') total = (total ?? 0) + (vals.length ? Math.max(...vals) : 0)
        }
      }
      if (total != null) overlay[c.field] = total
    }
    // Computed-write fields feed dependent formulas at their LIVE value too
    // (amount = price × quantity must move before Available can).
    for (const c of effectiveCols) {
      if (c.computed_type === 'write' && c.computed_formula) {
        const v = evalClientFormula(c.computed_formula as string, overlay)
        if (v != null) overlay[c.field] = v
      }
    }
    return overlay
  }

  const renderDrawerRelations = (rowId: string | undefined, draft: Record<string, unknown>) => {
    if (!drawerRelations || drawerRelations.length === 0) return null
    return (
      <div className='mt-3 space-y-2 border-t border-slate-100 pt-3 dark:border-border'>
        {drawerRelations.map((dr) => {
          const relField = typeof dr === 'string' ? dr : dr.field
          const relHint = typeof dr === 'string' ? undefined : dr.hint
          const relMatch = typeof dr === 'string' ? undefined : dr.match
          const matched = relMatch
            ? buildMatchedDrawer(relMatch, draft, parentId, parentDraftCtx?.draft)
            : null
          return (
            <NestedRelationEditor
              key={relField}
              parentCollection={relatedCollection}
              relationField={relField}
              parentRowId={rowId ?? null}
              parentDraft={draft}
              hint={relHint}
              onRowsChange={(liveRows) =>
                setDrawerLiveRows((prev) => ({
                  ...prev,
                  [`${rowId ?? '__new__'}|${relField}`]: liveRows
                }))
              }
              outerGridInvalidateKey={['o2m-rows', relatedCollection, manyField, parentId]}
              {...(relMatch
                ? {
                    matchCollection: relMatch.collection,
                    matchQuery: matched?.query ?? null,
                    matchSeed: matched?.seed ?? {}
                  }
                : !rowId
                  ? {
                      // UNSAVED row: members stage under __o2m_<field> in the
                      // row draft — the null-parentRowId path the editor
                      // actually reads. deferred/stagedOps is the SAVED-row
                      // pending mechanism; passing it here made Add silently
                      // drop entries (save() fell into the stagedMembers
                      // branch with no callback wired).
                      stagedMembers:
                        (draft[`__o2m_${relField}`] as Record<string, unknown>[] | undefined) ?? [],
                      onStagedChange: (members: Record<string, unknown>[]) =>
                        setDraftField(`__o2m_${relField}`, members)
                    }
                  : isPendingMode
                    ? {
                        deferred: true,
                        stagedOps:
                          (draft[`__nested_ops_${relField}`] as NestedOps | undefined) ??
                          EMPTY_NESTED_OPS,
                        onStagedOpsChange: (ops: NestedOps) =>
                          setDraftField(`__nested_ops_${relField}`, ops)
                      }
                    : {})}
            />
          )
        })}
      </div>
    )
  }

  const isPanelReadOnly = (c: CMSField): boolean =>
    (c.computed_type === 'write' && !!c.computed_formula) ||
    c.interface === 'formula-column' ||
    c.interface === 'match-agg-column' ||
    c.interface === 'relation-path' ||
    !!c.readonly ||
    isSummaryCol(c)

  type RowEditorArgs = {
    identity: ReactNode
    draft: Record<string, unknown>
    rowId?: string
    saveLabel: string
    drawer?: ReactNode
    onDelete?: (e: React.MouseEvent) => void
    /** Docked (split) placement: the container owns the chrome. */
    bare?: boolean
  }
  const renderRowEditorBody = (args: RowEditorArgs) => (
    <div
      className={
        args.bare
          ? 'px-4 py-3'
          : 'my-1.5 rounded-lg border border-nvr-cyan/40 bg-white px-4 py-3 shadow-[0_6px_24px_-8px_rgba(15,23,42,0.35)] ring-1 ring-nvr-cyan/15 dark:border-nvr-cyan/30 dark:bg-card'
      }
      onClick={(e) => e.stopPropagation()}
    >
      <div className='mb-3 flex items-center justify-between gap-3 border-b border-slate-100 pb-2 dark:border-border'>
        <div className='min-w-0 truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
          {args.identity}
        </div>
        <div className='flex shrink-0 items-center gap-1.5'>
          {args.onDelete && (
            <button
              type='button'
              onClick={args.onDelete}
              className='rounded px-2 py-1 text-[11px] text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20'
            >
              Delete
            </button>
          )}
          <button
            type='button'
            onClick={cancelEdit}
            className='rounded px-2 py-1 text-[11px] text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-muted'
          >
            Cancel
          </button>
          <button
            type='button'
            disabled={saving}
            onClick={saveEdit}
            className='rounded bg-nvr-cyan px-3 py-1 text-[11px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-50'
          >
            {saving ? 'Saving…' : args.saveLabel}
          </button>
        </div>
      </div>
      {/* Derived values are what this row COMPUTES TO, not something to fill
            in — as inputs' neighbours they read like fields left blank. They
            get their own strip above the form, the way a record's header
            summarises it. */}
      {(() => {
        // The derived-values strip is PRESET-INDEPENDENT: a preset narrows
        // the table's columns, but the panel always summarises what the row
        // computes to (Line $, Allocated, Available) — hiding Allocated
        // from the "Line" view must not strip it from the editor.
        const stripCols = [
          ...displayCols.filter(isPanelReadOnly),
          ...effectiveCols.filter((c) => isSummaryCol(c))
        ]
        return (
          stripCols.length > 0 &&
          (() => {
            const overlay = liveOverlayDraft(args.draft, { rowKey: args.rowId ?? '__new__' })
            return (
              <div className='mb-3 flex flex-wrap items-stretch gap-x-6 gap-y-2 rounded-md bg-slate-50/80 px-3 py-2 dark:bg-muted/40'>
                {stripCols.map((c) => {
                  const label = c.label || titleCase(c.field)
                  const isComputedWrite = c.computed_type === 'write' && !!c.computed_formula
                  // options may arrive as a JSON string — parse like renderCell does
                  const colOpts = c.options
                    ? ((typeof c.options === 'string'
                        ? (() => {
                            try {
                              return JSON.parse(c.options as string)
                            } catch {
                              return {}
                            }
                          })()
                        : c.options) as Record<string, unknown>)
                    : {}
                  const colFormula =
                    typeof colOpts.column_formula === 'string' ? colOpts.column_formula : ''
                  const liveFormulaVal =
                    c.interface === 'formula-column' && colFormula
                      ? evaluateNumeric(colFormula, (ref) =>
                          ref.includes('.')
                            ? resolvedPathData?.rows[args.rowId ?? '']?.[ref]?.value
                            : overlay[ref]
                        )
                      : null
                  return (
                    <div key={c.field} className='flex min-w-0 flex-col justify-start'>
                      <span className='text-[10px] font-medium uppercase tracking-wide text-slate-400'>
                        {label}
                      </span>
                      <span className='mt-0.5 truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                        {isComputedWrite ? (
                          renderCell(c, overlay[c.field] ?? args.draft[c.field])
                        ) : liveFormulaVal != null ? (
                          <span className='tabular-nums'>
                            {liveFormulaVal.toLocaleString(
                              'en-US',
                              numericIntlOptions(colOpts, colOpts.format as string | undefined)
                            )}
                          </span>
                        ) : c.computed_type === 'rollup' ? (
                          renderCell(c, overlay[c.field] ?? args.draft[c.field], args.rowId)
                        ) : isSummaryCol(c) ? (
                          summaryCellValue(c, args.draft, true)
                        ) : (
                          renderCell(c, args.draft[c.field], args.rowId)
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })()
        )
      })()}
      {renderRemoteRowStrip(args.rowId)}
      <div
        className='grid items-start gap-x-4 gap-y-3'
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
      >
        {effectiveCols
          .filter((c) => !isPanelReadOnly(c))
          .map((c) => {
            const isComputedWrite = c.computed_type === 'write' && !!c.computed_formula
            // A raw column name (LINE_TYPE, SUPPLIER_ITEM) is the table's
            // shorthand; a labelled form should read like prose.
            const label = c.label || titleCase(c.field)
            // Interfaces that only ever DISPLAY a derived value: rendering an
            // input for them offers an edit that goes nowhere.
            const displayOnlyIface =
              c.interface === 'formula-column' ||
              c.interface === 'match-agg-column' ||
              c.interface === 'relation-path'
            if (isSummaryCol(c)) {
              return (
                <div key={c.field} className='flex min-w-0 flex-col gap-1'>
                  <span className='text-[10px] font-medium uppercase tracking-wide text-slate-400'>
                    {label}
                  </span>
                  <div className='text-[12px] text-slate-500'>
                    {summaryCellValue(c, args.draft, true)}
                  </div>
                </div>
              )
            }
            const isMissing = !!editState?.missing?.includes(c.field)
            return (
              <div
                key={c.field}
                data-grid-cell={cellKey(args.rowId, c.field)}
                className={cn(
                  'flex min-w-0 flex-col gap-1',
                  isMissing &&
                    'rounded-md [&_input]:border-red-400 [&_input]:ring-1 [&_input]:ring-red-300 [&_button]:border-red-400 [&_button]:ring-1 [&_button]:ring-red-300 dark:[&_input]:border-red-600 dark:[&_input]:ring-red-800 dark:[&_button]:border-red-600 dark:[&_button]:ring-red-800'
                )}
              >
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide',
                    isMissing ? 'text-red-600 dark:text-red-400' : 'text-slate-400'
                  )}
                >
                  {label}
                  {isMissing && (
                    <span className='ml-1 normal-case tracking-normal'>· required</span>
                  )}
                  {(() => {
                    const prov = ruleProvenance(c.field)
                    if (!prov) return null
                    return prov === 'auto' ? (
                      <span
                        className='rounded bg-sky-50 px-1 py-px text-[9px] font-medium normal-case tracking-normal text-sky-700 dark:bg-sky-400/10 dark:text-sky-300'
                        data-tip='Set automatically by a row rule'
                      >
                        auto
                      </span>
                    ) : (
                      <span className='flex items-center gap-1'>
                        <span
                          className='rounded bg-amber-50 px-1 py-px text-[9px] font-medium normal-case tracking-normal text-amber-700 dark:bg-amber-400/10 dark:text-amber-300'
                          data-tip='Differs from what the row rules would set'
                        >
                          overridden
                        </span>
                        {!readOnly && !editState?.locks?.includes(c.field) && (
                          <button
                            type='button'
                            onClick={() => resetToAuto(c.field)}
                            className='rounded px-1 text-[10px] normal-case tracking-normal text-nvr-cyan hover:underline'
                            data-tip='Reset to the rule-derived value'
                          >
                            ↺ reset
                          </button>
                        )}
                      </span>
                    )
                  })()}
                </span>
                {isComputedWrite ? (
                  <div className='text-[12px] italic text-slate-500'>
                    {renderCell(
                      c,
                      evalClientFormula(c.computed_formula as string, args.draft) ??
                        args.draft[c.field]
                    )}
                  </div>
                ) : displayOnlyIface ||
                  c.readonly ||
                  editState?.locks?.includes(c.field) ||
                  closedLockedCell(c.field, args.draft) ? (
                  <div
                    className='text-[12px] text-slate-500'
                    data-compare-locked={
                      closedLockedCell(c.field, args.draft) ? c.field : undefined
                    }
                    data-tip={
                      editState?.locks?.includes(c.field)
                        ? lockReasonText(c.field)
                        : closedLockedCell(c.field, args.draft)
                          ? compareData?.closed_locked_message ||
                            'This month is closed — only reconciling it to the actual is allowed'
                          : undefined
                    }
                  >
                    {renderCell(c, args.draft[c.field], args.rowId)}
                  </div>
                ) : editState?.locksPending && lockTargets.has(c.field) ? (
                  // A lock rule may apply to this field; its first evaluation
                  // hasn't answered yet. Hold input for that beat rather than
                  // accept a value the lock would then silently drop.
                  <div
                    className='h-9 animate-pulse rounded-md border border-dashed border-border bg-[hsl(var(--nvr-skeleton))] px-2 text-[11px] leading-9 text-slate-400'
                    data-tip='Checking whether this field is locked for this row…'
                  >
                    {renderCell(c, args.draft[c.field], args.rowId)}
                  </div>
                ) : (
                  <FieldRenderer
                    field={
                      { ...c, sort: c.sort ?? 0 } as Parameters<typeof FieldRenderer>[0]['field']
                    }
                    value={args.draft[c.field] ?? null}
                    onChange={(v) => setDraftField(c.field, v)}
                    relations={childRelations}
                    collection={relatedCollection}
                    itemId={args.rowId ?? 'new'}
                    cascadeFilter={fieldCascadeFilters[c.field]}
                    pinnedOption={pinnedOptionFor(c.field, args.draft)}
                  />
                )}
                {/* What actually landed for this cell, while the plan is being typed. */}
                {compareData &&
                  compareData.columns.includes(c.field) &&
                  (() => {
                    const cmpRow = compareRowFor(compareData, args.draft)
                    const actual = cmpRow?.values[c.field]
                    const closed = compareColumnClosed(
                      compareData,
                      args.draft[compareData.key_field],
                      c.field
                    )
                    return (
                      <div
                        data-compare-editor-hint={c.field}
                        className='mt-1 flex items-center gap-1 text-[11px] text-slate-500 dark:text-muted-foreground'
                      >
                        <span className='font-mono text-[9px] uppercase tracking-wide text-slate-400'>
                          {compareData.label}
                        </span>
                        <span className='tabular-nums font-medium text-slate-700 dark:text-slate-200'>
                          {actual == null ? '—' : fmtMoney(actual)}
                        </span>
                        {closed && (
                          <span
                            className='inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wide text-slate-400'
                            data-tip={
                              compareData.closed_locked && viewerIsAdmin
                                ? `${compareData.closed_rule ?? ''} A change here needs a reason.`.trim()
                                : compareData.closed_rule
                            }
                          >
                            <Lock className='h-2.5 w-2.5' aria-hidden='true' /> closed
                          </span>
                        )}
                        {closed && !readOnly && (
                          <ReconcileAction
                            data={compareData}
                            rowKey={args.draft[compareData.key_field]}
                            column={c.field}
                            columnLabel={compareLabelFor(c)}
                            plannedRow={args.draft}
                            actual={actual ?? 0}
                            variant='button'
                            onApply={(patchValues, reason) =>
                              setDraftFields({ ...patchValues, _change_reason: reason })
                            }
                          />
                        )}
                      </div>
                    )
                  })()}
              </div>
            )
          })}
      </div>
      {spreadRemaining && spreadRemaining.fields?.length > 0 && !readOnly && (
        <SpreadRemainingAction
          config={spreadRemaining}
          draft={args.draft}
          remaining={evaluateNumeric(spreadRemaining.remaining, resolveGridToken)}
          onApply={setDraftFields}
          closedFields={
            compareData
              ? new Set(
                  spreadRemaining.fields.filter((f) =>
                    compareColumnClosed(compareData, args.draft[compareData.key_field], f)
                  )
                )
              : undefined
          }
          shapeSource={(() => {
            // "Like <previous key>": the grid row whose series key is one
            // below this row's (the previous year), when it has any shape.
            if (!compareData) return null
            const k = Number(args.draft[compareData.key_field])
            if (!Number.isFinite(k)) return null
            const prev = rows.find((r) => Number(r[compareData.key_field]) === k - 1)
            if (!prev) return null
            const values: Record<string, number> = {}
            let any = false
            for (const f of spreadRemaining.fields) {
              const v = Number(prev[f]) || 0
              values[f] = v
              if (v > 0) any = true
            }
            return any ? { label: `Like ${k - 1}`, values } : null
          })()}
        />
      )}
      {rowMatchPanel &&
        args.rowId &&
        !args.rowId.startsWith('pending:') &&
        args.rowId !== 'new' && (
          <RowMatchPanel config={rowMatchPanel} result={rowMatches.byRow.get(args.rowId)} />
        )}
      {args.drawer}
    </div>
  )
  // Spans EVERY column — the leading grip/number/status cells are hidden
  // while the panel renders (the panel header already says "Line N · …"),
  // so nothing pushes the form to the right.
  const renderRowEditorPanel = (args: RowEditorArgs) => (
    <td colSpan={nestedColSpan} className='p-0'>
      {renderRowEditorBody(args)}
    </td>
  )
  // The row soft-lock prompt: rendered where the editor would have opened
  // (full-width row under the line, or the docked area in split mode).
  const renderRowSoftLockStrip = (
    lock: { rowKey: string; editor: string },
    placement: 'row' | 'docked'
  ) => {
    const initials = lock.editor
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
    const confirm = () => {
      softLockConfirmedRef.current.add(softLockPairKey(lock.rowKey, lock.editor))
      setRowSoftLock(null)
      const row = rows.find((r) => String(r.id) === lock.rowKey)
      if (!row) return
      startEdit(pendingEdits.has(lock.rowKey) ? { ...row, ...pendingEdits.get(lock.rowKey) } : row)
    }
    return (
      <div
        data-row-soft-lock=''
        role='status'
        className={cn(
          'flex flex-wrap items-center gap-2 border-amber-300 bg-amber-50 px-3 py-1.5 text-[11.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100',
          placement === 'docked' ? 'rounded-lg border' : 'border-b'
        )}
      >
        <span className='inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[9px] font-semibold text-amber-900 dark:bg-amber-500/40 dark:text-amber-50'>
          {initials || '?'}
        </span>
        <span className='min-w-0 flex-1'>{lock.editor} is editing this line — edit anyway?</span>
        <button
          type='button'
          onClick={confirm}
          className='rounded-md bg-amber-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-700'
        >
          Edit anyway
        </button>
        <button
          type='button'
          onClick={() => setRowSoftLock(null)}
          className='rounded-md border border-amber-300 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15'
        >
          Leave it
        </button>
      </div>
    )
  }

  const isAllPresetActive = activePreset === ALL_PRESET_SENTINEL
  // Stale stored names keep highlighting columnPresets[0] (unchanged prior behavior);
  // the All chip only highlights on the explicit sentinel, never as a fallback.
  const activePresetHighlightName = isAllPresetActive
    ? null
    : (resolvedPreset?.name ?? columnPresets?.[0]?.name)
  const presetSwitcher = columnPresets && columnPresets.length >= 2 && (
    <div className='flex items-center gap-1 text-[11px]'>
      <button
        type='button'
        onClick={() => selectPreset(ALL_PRESET_SENTINEL)}
        className={cn(
          'h-6 px-2.5 rounded border transition-colors',
          isAllPresetActive
            ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
            : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800'
        )}
      >
        All
      </button>
      {columnPresets.map((p) => (
        <button
          key={p.name}
          type='button'
          onClick={() => selectPreset(p.name)}
          className={cn(
            'h-6 px-2.5 rounded border transition-colors',
            activePresetHighlightName === p.name
              ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
              : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800'
          )}
        >
          {p.name}
        </button>
      ))}
    </div>
  )

  return (
    // Advertises which child collection this grid holds, so the summary can
    // jump to it by collection rather than by field name (the two differ for
    // relations that never got an alias field on the layout).
    <div
      className='space-y-1.5'
      data-o2m-collection={relatedCollection}
      onFocusCapture={onCellFocusCapture}
      onBlurCapture={onCellBlurCapture}
    >
      <ChangeReasonDialog
        challenge={crChallenge?.challenge ?? null}
        onCancel={() => setCrChallenge(null)}
        onSubmit={(reason) => {
          const pending = crChallenge
          setCrChallenge(null)
          void pending?.retry(reason)
        }}
      />
      {!readOnly && (
        <div className='flex items-center gap-2 text-[11px]'>
          <span className='text-slate-400'>Add</span>
          <input
            type='number'
            min={1}
            max={100}
            value={bulkCount}
            onChange={(e) =>
              setBulkCount(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))
            }
            className='w-14 h-6 rounded border border-slate-200 px-2 text-[11px] text-slate-700 text-center focus:outline-none focus:ring-1 focus:ring-[#00ceff]'
          />
          <button
            type='button'
            disabled={bulkAdding}
            onClick={() => addBulkRows(false)}
            className='h-6 px-2.5 rounded border border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800 disabled:opacity-40 transition-colors'
          >
            blank {bulkCount === 1 ? 'row' : 'rows'}
          </button>
          {/* Line generators (#336): patterned rows — monthly dates, {n} labels. */}
          {(() => {
            const dateCols = displayCols.filter(
              (c) => !c.field.includes('.') && (c.type === 'date' || c.type === 'datetime')
            )
            if (dateCols.length === 0) return null
            return (
              <button
                type='button'
                disabled={bulkAdding}
                onClick={() => addPatternedRows(dateCols[0].field)}
                data-tip={`Generate ${bulkCount} rows with ${dateCols[0].field} advancing one month per row (starting next month)`}
                className='h-6 px-2.5 rounded border border-dashed border-slate-300 text-slate-500 hover:border-nvr-cyan/60 hover:text-slate-700 disabled:opacity-40 transition-colors'
              >
                monthly {bulkCount === 1 ? 'row' : 'rows'}
              </button>
            )
          })()}
          {allocateDrawer && (!isNew || staging) && (
            <AllocateDrawer
              config={allocateDrawer}
              relatedCollection={relatedCollection}
              manyField={manyField}
              parentId={parentId}
              rows={isNew ? [] : rows}
              rowDefaults={rowDefaultSeed}
              parentDraft={parentDraftCtx?.draft}
              invalidate={() =>
                qc.invalidateQueries({
                  queryKey: ['o2m-rows', relatedCollection, manyField, parentId]
                })
              }
              onLocalWrite={(id) => {
                if (id) stampLocalWrite(id)
                else localCreateAtRef.current = Date.now()
              }}
              staging={staging}
              stagingActive={(isNew || isPendingMode) && !!staging}
              pendingRows={pendingRows}
              pendingEdits={pendingEdits}
              pendingDeletes={pendingDeletes}
            />
          )}
          {autoAllocate &&
            !isNew &&
            !readOnly &&
            (() => {
              const entry = (drawerRelations ?? []).find(
                (d): d is { field: string; match?: MatchedDrawerConfig } =>
                  typeof d === 'object' && d.field === autoAllocate.relation && !!d.match
              )
              if (!entry?.match) return null
              return (
                <AutoAllocateButton
                  config={autoAllocate}
                  matchCfg={entry.match}
                  rows={rows}
                  parentId={parentId}
                  parentDraft={parentDraftCtx?.draft}
                  relatedCollection={relatedCollection}
                  manyField={manyField}
                />
              )
            })()}
          {(rowBulkActions ?? []).map((action) => (
            <RowBulkActionButton
              key={action.label}
              config={action}
              // Staged rows count: an addendum's grid is entirely PREFILLED
              // pending rows (they keep their source id), and those are exactly
              // the rows the action is meant to rewrite.
              rows={[...rows, ...pendingRows.map((r, i) => ({ ...r, __pendingIndex: i }))]}
              relatedCollection={relatedCollection}
              computedWriteFields={computedWriteFields}
              applyRow={async (row, changes) => {
                const pendingIndex = (row as Record<string, unknown>).__pendingIndex
                if (typeof pendingIndex === 'number' && staging) {
                  staging.updateRow(relatedCollection, manyField, pendingIndex, changes)
                  return
                }
                const rowId = String(row.id)
                // Otherwise reuse the grid's own write paths: a pending-mode grid
                // queues the edit for the parent save, an immediate grid PATCHes.
                if (isPendingMode && staging) {
                  staging.queueEdit(relatedCollection, manyField, rowId, changes)
                  return
                }
                await client.request(patch(`/items/${relatedCollection}/${rowId}`, changes))
                stampLocalWrite(rowId)
                await qc.invalidateQueries({
                  queryKey: ['o2m-rows', relatedCollection, manyField, parentId]
                })
              }}
            />
          ))}
          {uploadTemplate && !isNew && !readOnly && reimportHandler && parentCollection && (
            <ImportFromFileButton
              collection={parentCollection}
              templateFilter={(t) => t.name === uploadTemplate && t.reimport?.enabled === true}
              getLabel={(t) => t.reimport?.button_label ?? t.button_label}
              onParsed={(result, template) => reimportHandler(result, template)}
              compact
            />
          )}
          {parentCollection && staging && !readOnly && (
            <span className='relative inline-flex'>
              <button
                type='button'
                onClick={() => setCopyFromOpen((v) => !v)}
                title='Copy this table’s lines from another record'
                className='h-6 rounded border border-slate-200 px-2.5 text-slate-600 transition-colors hover:border-slate-400 hover:text-slate-800 dark:border-border dark:text-slate-300'
              >
                Copy from…
              </button>
              {copyFromOpen && (
                <span className='absolute left-0 top-full z-[70] mt-1 w-[300px] rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-border dark:bg-card'>
                  <RelationCombobox
                    collection={parentCollection}
                    value={null}
                    onChange={(id) => {
                      if (id != null) void copyLinesFrom(String(id))
                    }}
                    placeholder='Pick the record to copy from…'
                  />
                </span>
              )}
            </span>
          )}
          {defaultsCols.length > 0 && (
            <button
              type='button'
              onClick={() => setDefaultsOpen((v) => !v)}
              className={cn(
                'h-6 px-2.5 rounded border transition-colors',
                defaultsOpen
                  ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
                  : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800'
              )}
            >
              with defaults…
            </button>
          )}
          {applyValuesCols.length > 0 && (
            <button
              type='button'
              onClick={() => setApplyOpen((v) => !v)}
              className={cn(
                'h-6 px-2.5 rounded border transition-colors',
                applyOpen
                  ? 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/30 dark:text-amber-300'
                  : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800'
              )}
            >
              apply values…
            </button>
          )}
          {spreadRemaining &&
            spreadRemaining.fields?.length > 0 &&
            spreadRemaining.across_rows !== false &&
            rows.length + pendingRows.length > 1 && (
              <SpreadAcrossRowsButton
                config={spreadRemaining}
                remaining={evaluateNumeric(spreadRemaining.remaining, resolveGridToken)}
                rowNoun={compareData ? titleCase(compareData.key_field).toLowerCase() : 'row'}
                onApply={spreadAcrossRows}
              />
            )}
          {!!rowRules?.length && rows.length + pendingRows.length > 0 && (
            <button
              type='button'
              onClick={() => {
                setRerunOpen((v) => !v)
                setRerunPreview(null)
              }}
              className={cn(
                'h-6 px-2.5 rounded border transition-colors',
                rerunOpen
                  ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
                  : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800'
              )}
              data-tip='Re-run this grid&apos;s auto-fill rules over every line, saved or not yet saved'
            >
              re-run rules…
            </button>
          )}
          {activeView === 'original' && rows.length + pendingRows.length > 0 && (
            <button
              type='button'
              aria-label={selectMode ? 'Hide row selection' : 'Select rows'}
              aria-pressed={selectMode}
              data-tip={
                selectMode
                  ? 'Hide the selection checkboxes'
                  : 'Tick rows to edit several lines at once'
              }
              onClick={() => {
                setSelectMode((v) => !v)
                setSelectedIds(new Set())
              }}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded border px-2 transition-colors',
                selectMode
                  ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
                  : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800 dark:border-border dark:text-slate-300'
              )}
            >
              <ListChecks className='h-3 w-3' aria-hidden='true' />
              {selectMode ? 'Selecting' : 'Select rows'}
            </button>
          )}
          {selectColOn && selectedIds.size > 0 && (
            <button
              type='button'
              onClick={() => setBulkEditOpen(true)}
              data-tip='Set the same values on every selected line'
              className='inline-flex h-6 items-center gap-1 rounded border border-amber-400 bg-amber-50 px-2 font-medium text-amber-700 transition-colors hover:border-amber-500 dark:border-amber-600 dark:bg-amber-950/30 dark:text-amber-300'
            >
              <SquarePen className='h-3 w-3' aria-hidden='true' />
              Edit {selectedIds.size} selected…
            </button>
          )}
          <button
            type='button'
            aria-label={splitMode ? 'Switch to inline editor' : 'Switch to split editor'}
            aria-pressed={splitMode}
            data-tip={
              splitMode
                ? 'Edit each line where it sits in the table'
                : 'Edit lines in a panel docked under the table — ↑/↓ walk the rows'
            }
            onClick={() => setEditorPlacement(splitMode ? 'drawer' : 'split')}
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded border transition-colors',
              splitMode
                ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
                : 'border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-800 dark:border-border dark:text-slate-300'
            )}
          >
            {splitMode ? (
              <Rows3 className='h-3 w-3' aria-hidden='true' />
            ) : (
              <PanelBottomOpen className='h-3 w-3' aria-hidden='true' />
            )}
          </button>
          {bulkAdding && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
          {presetSwitcher}
          {showRowRevisions && !isNew && (
            <button
              type='button'
              data-tip='Lines timeline — every line added, changed or removed on this record'
              onClick={() => setTimelineOpen(true)}
              className='ml-auto rounded p-1 text-slate-300 hover:text-[#00ceff]'
            >
              <History className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      )}

      {applyOpen && applyValuesCols.length > 0 && (
        <div className='rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2 dark:border-amber-500/30 dark:bg-amber-400/10'>
          <p className='text-[11px] font-medium text-amber-700 dark:text-amber-300'>
            Apply values to all {rows.length + pendingRows.length} rows
          </p>
          <div className='flex flex-wrap gap-2 items-end'>
            {applyValuesCols.map((c) => (
              <div key={c.field} className='min-w-[160px]'>
                <p className='text-[10px] text-slate-500 mb-0.5 dark:text-slate-400'>
                  {c.label ?? titleCase(c.field)}
                </p>
                <FieldRenderer
                  field={c}
                  value={applyValues[c.field] ?? null}
                  onChange={(v) => setApplyValues((prev) => ({ ...prev, [c.field]: v }))}
                  relations={childRelations}
                  collection={relatedCollection}
                  itemId='new'
                />
              </div>
            ))}
            <button
              type='button'
              disabled={applying || !(rows.length + pendingRows.length)}
              onClick={applyValuesToAllRows}
              className='h-9 rounded px-3 bg-amber-500 text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50 whitespace-nowrap'
            >
              {applying ? 'Applying…' : `Apply to all ${rows.length + pendingRows.length} rows`}
            </button>
          </div>
        </div>
      )}

      {rerunOpen && !!rowRules?.length && (
        <div className='rounded-lg border border-[#00ceff]/40 bg-[#00ceff]/5 p-3 space-y-2 dark:bg-nvr-cyan/5'>
          <p className='text-[11px] font-medium text-slate-700 dark:text-slate-200'>
            Re-run rules on {rows.length + pendingRows.length}{' '}
            {rows.length + pendingRows.length === 1 ? 'line' : 'lines'}
            {pendingRows.length > 0 && (
              <span className='font-normal text-slate-500'>
                {' '}
                ({rows.length} saved, {pendingRows.length} not yet saved)
              </span>
            )}
          </p>
          <p className='text-[11px] text-slate-500'>
            Rules edited after these lines were created never touched them. Preview first — nothing
            is written until you{' '}
            {isPendingMode && staging
              ? 'stage them: staged lines show as Edited and land with Save.'
              : 'apply, and every applied change lands in each line\u2019s history.'}
          </p>
          <div className='flex flex-wrap items-center gap-3 text-[11px]'>
            {(
              [
                [
                  'empty-only',
                  'Fill blanks only',
                  'Empty fields are written, plus any field a rule locks on that line (those belong to the rules).'
                ],
                [
                  'all',
                  'Re-derive everything',
                  'Rule targets are re-derived even where a value was typed by hand.'
                ]
              ] as const
            ).map(([m, label, tip]) => (
              <label
                key={m}
                className='inline-flex items-center gap-1.5 cursor-pointer'
                data-tip={tip}
              >
                <input
                  type='radio'
                  name={`rerun-mode-${manyField}`}
                  checked={rerunMode === m}
                  onChange={() => {
                    setRerunMode(m)
                    setRerunPreview(null)
                  }}
                  className='accent-[#00ceff]'
                />
                {label}
              </label>
            ))}
            <button
              type='button'
              disabled={rerunBusy !== null}
              onClick={() => void rerunRules(true)}
              className='h-7 rounded border border-slate-300 bg-white px-2.5 text-[11px] font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:bg-card dark:text-slate-200'
            >
              {rerunBusy === 'preview' ? 'Previewing…' : 'Preview'}
            </button>
            {rerunPreview && rerunPreview.changes.length > 0 && (
              <button
                type='button'
                disabled={rerunBusy !== null}
                onClick={() => void rerunRules(false)}
                className='h-7 rounded bg-[#00ceff] px-3 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-50'
              >
                {rerunBusy === 'apply'
                  ? isPendingMode && staging
                    ? 'Staging…'
                    : 'Applying…'
                  : `${isPendingMode && staging ? 'Stage for' : 'Apply to'} ${rerunPreview.changes.length} ${rerunPreview.changes.length === 1 ? 'line' : 'lines'}`}
              </button>
            )}
          </div>
          {rerunPreview && (
            <div className='text-[11px] text-slate-600 dark:text-slate-300'>
              {rerunPreview.changes.length === 0 ? (
                <span>Every line already matches its rules — nothing to change.</span>
              ) : (
                <ul className='flex flex-wrap gap-x-4 gap-y-1'>
                  {Object.entries(rerunPreview.fields).map(([f, count]) => {
                    const col = cols.find((c) => c.field === f)
                    return (
                      <li key={f}>
                        <span className='font-medium text-foreground'>
                          {col?.label || titleCase(f)}
                        </span>{' '}
                        on {count} {count === 1 ? 'line' : 'lines'}
                      </li>
                    )
                  })}
                  {rerunPreview.truncated && (
                    <li className='text-amber-700'>Preview shows the first 200 lines.</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {rowMatchPanel?.unmatched_banner &&
        !readOnly &&
        rowMatches.unmatchedCandidates.length > 0 &&
        (() => {
          const n = rowMatches.unmatchedCandidates.length
          const noun = rowMatchPanel.unmatched_banner?.label ?? 'related line'
          const plural = n === 1 ? noun : `${noun}s`
          const primary =
            rowMatchPanel.candidates?.primary ?? rowMatchPanel.candidates?.keys?.[0]?.row
          const primaryCandidate = rowMatchPanel.candidates?.keys?.find(
            (k) => k.row === primary
          )?.candidate
          const numbers = primaryCandidate
            ? rowMatches.unmatchedCandidates
                .map((c) => String((c as Record<string, unknown>)[primaryCandidate] ?? ''))
                .filter(Boolean)
                .slice(0, 8)
            : []
          return (
            <div className='flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'>
              <AlertTriangle className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
              <span>
                <span className='font-medium'>
                  {n} {plural} {n === 1 ? 'has' : 'have'} no matching row here
                </span>
                {numbers.length > 0 && (
                  <span className='text-amber-700/80 dark:text-amber-300/80'>
                    {' '}
                    · line{numbers.length === 1 ? '' : 's'} {numbers.join(', ')}
                    {n > numbers.length ? ` +${n - numbers.length}` : ''}
                  </span>
                )}
              </span>
              <button
                type='button'
                disabled={bulkAdding}
                onClick={() => void addUnmatchedCandidates()}
                className='ml-auto h-6 rounded border border-amber-300 bg-white px-2.5 text-[11px] font-medium text-amber-800 hover:border-amber-400 disabled:opacity-50 dark:border-amber-500/50 dark:bg-transparent dark:text-amber-200'
                data-tip={
                  isNew || isPendingMode
                    ? 'Stages one row per missing line — saved with the record'
                    : 'Adds one row per missing line now'
                }
              >
                {bulkAdding
                  ? 'Adding…'
                  : `Add ${n === 1 ? 'it' : `all ${n}`} as ${n === 1 ? 'a row' : 'rows'}`}
              </button>
            </div>
          )
        })()}

      {(sinceOpened || remoteEditorLines.length > 0) &&
        !isNew &&
        activeView === 'original' &&
        (() => {
          // The editors line rides in the same strip but never in the counts.
          const diff = sinceOpened
          const n = diff?.total ?? 0
          const parts: string[] = []
          if (diff?.added.size) parts.push(`${diff.added.size} added`)
          if (diff?.changed.size) parts.push(`${diff.changed.size} changed`)
          if (diff?.removed.length) parts.push(`${diff.removed.length} removed`)
          const removedLabels = (diff?.removed ?? [])
            .slice(0, 5)
            .map((id) => rowIdentityLabel(baselineRef.current?.get(id) ?? { id }))
          return (
            <div
              data-grid-since-opened=''
              className='flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
            >
              {diff && (
                <>
                  <span className='font-medium'>
                    {n} {n === 1 ? 'line' : 'lines'} changed by others since you opened
                  </span>
                  <span className='text-amber-700/80 dark:text-amber-300/80'>
                    {parts.join(' · ')}
                    {sinceOpenedWho.length > 0 && ` · changed by ${sinceOpenedWho.join(', ')}`}
                  </span>
                  {removedLabels.length > 0 && (
                    <span className='text-amber-700/80 dark:text-amber-300/80'>
                      removed: {removedLabels.join(', ')}
                      {diff.removed.length > removedLabels.length
                        ? ` +${diff.removed.length - removedLabels.length}`
                        : ''}
                    </span>
                  )}
                  <button
                    type='button'
                    onClick={dismissSinceOpened}
                    className='ml-auto h-6 rounded border border-amber-300 bg-white px-2.5 text-[11px] font-medium text-amber-800 hover:border-amber-400 dark:border-amber-500/50 dark:bg-transparent dark:text-amber-200'
                    data-tip='Take the current rows as the new baseline'
                  >
                    Dismiss
                  </button>
                </>
              )}
              {remoteEditorLines.length > 0 && (
                <span
                  data-remote-editors=''
                  className={
                    diff ? 'basis-full text-amber-700/80 dark:text-amber-300/80' : 'font-medium'
                  }
                >
                  {remoteEditorLines.join(' · ')}
                </span>
              )}
            </div>
          )
        })()}
      {isPrefilling && (
        <div className='rounded-lg border border-slate-200 p-3 space-y-1.5'>
          <div className='h-8 rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))] animate-pulse' />
          <div className='h-8 rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))] animate-pulse' />
          <div className='h-8 rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))] animate-pulse' />
        </div>
      )}
      {!readOnly && visibleProposals.length > 0 && (
        <CompareProposalBanner
          proposals={visibleProposals}
          onApply={applyProposal}
          onDismiss={(p) => dismissProposal(p, true)}
        />
      )}
      {((gridStatValues && gridStatValues.length > 0) ||
        (compareSeries && !isNew && (compareData || compareLoading || compareError))) && (
        <div data-o2m-stats className='mb-2 flex flex-wrap items-stretch gap-1.5'>
          {/* The verdict leads: what the reader came for, then the figures it rests on. */}
          <CompareStripChips data={compareData} loading={compareLoading} error={compareError} />
          {(gridStatValues ?? []).map((st) => (
            <GridStatChip
              key={st.label}
              label={st.label}
              value={st.result}
              format={st.format}
              negative={st.result != null && st.result < -0.005 && st.negative === 'danger'}
            />
          ))}
        </div>
      )}
      {/* readOnly grids skip the !readOnly toolbar above, so the preset switcher gets its own strip */}
      {readOnly && presetSwitcher}
      <div
        ref={tableWrapRef}
        className={
          isPrefilling
            ? 'hidden'
            : `relative rounded-lg border border-slate-200 text-[12px]${freezeFirstColumn ? ' overflow-x-auto' : ''}`
        }
      >
        {reordering && (
          <div className='absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-white/60 backdrop-blur-[1px] dark:bg-black/40'>
            <div className='flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 shadow-sm text-[12px] text-slate-500'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
              Saving order…
            </div>
          </div>
        )}
        {frozenCss && <style>{frozenCss}</style>}
        <table
          className={freezeFirstColumn ? `w-full min-w-max ${frozenClass}` : 'w-full table-fixed'}
        >
          <thead className='bg-slate-50 border-b border-slate-200 [&>tr>th:first-child]:rounded-tl-lg [&>tr>th:last-child]:rounded-tr-lg'>
            <tr>
              {selectColOn && (
                <th className='w-7 px-1.5 py-2 align-middle'>
                  <input
                    type='checkbox'
                    aria-label='Select all rows'
                    className='accent-[#00ceff]'
                    checked={allVisibleSelected}
                    onChange={(e) =>
                      setSelectedIds(e.target.checked ? new Set(selectableKeys) : new Set())
                    }
                  />
                </th>
              )}
              {enableReorder && (rowOrderField || isNew || isPendingMode) && <th className='w-6' />}
              {showLineNumbers && (
                <th className='w-8 px-2 py-2 text-left font-medium text-slate-400 text-[11px]'>
                  #
                </th>
              )}
              {(isNew || isPendingMode) && (
                <th className='px-3 py-2 text-left font-medium text-slate-400 text-[11px] w-20'>
                  Status
                </th>
              )}
              {effectiveCols.map((c) => (
                <th
                  key={c.field}
                  className='px-3 py-2 text-left font-medium text-slate-500 text-[11px]'
                >
                  {c.label ?? titleCase(c.field)}
                </th>
              ))}
              <th className='w-20' />
            </tr>
          </thead>
          <tbody>
            {/* Defaults row */}
            {defaultsOpen && (
              <tr className='border-b border-nvr-cyan/20 bg-nvr-cyan/5'>
                {selectColOn && <td className='w-7' />}
                {enableReorder && (rowOrderField || isNew || isPendingMode) && (
                  <td className='w-6' />
                )}
                {showLineNumbers && <td className='w-8' />}
                {(isNew || isPendingMode) && (
                  <td className='px-3 py-0.5 align-middle w-20'>
                    <span className='text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                      Defaults
                    </span>
                  </td>
                )}
                {defaultsCols.map((c) => (
                  <td
                    key={c.field}
                    className='px-2 py-0.5 align-middle text-[11px] [&_button]:h-7 [&_button]:min-h-0 [&_button]:text-[11px] [&_input]:h-7 [&_input]:text-[11px] [&_textarea]:min-h-[28px] [&_label]:hidden'
                  >
                    <FieldRenderer
                      field={c}
                      value={defaultValues[c.field] ?? null}
                      onChange={(v) => setDefaultField(c.field, v)}
                      relations={childRelations}
                      collection={relatedCollection}
                      itemId='new'
                    />
                  </td>
                ))}
                <td className='px-1 py-0.5 align-middle'>
                  <button
                    type='button'
                    disabled={bulkAdding}
                    onClick={() => addBulkRows(true)}
                    className='rounded px-2 h-7 bg-nvr-cyan text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50 whitespace-nowrap'
                  >
                    {bulkAdding ? '…' : `Add ${bulkCount}`}
                  </button>
                </td>
              </tr>
            )}

            {/* Saved rows */}
            {!isNew &&
              activeView === 'original' &&
              rows.slice(0, renderCap).map((row, ri) => {
                const id = String(row.id)
                const section = sectionsActive ? sectionOf(row) : null
                const isSectionStart =
                  section !== null && (ri === 0 || sectionOf(rows[ri - 1]) !== section)
                const sectionCollapsed = section !== null && collapsedSections.has(section)
                const sectionHeader =
                  isSectionStart && section !== null ? (
                    <tr className='border-b border-slate-200 bg-slate-100/80 dark:border-border dark:bg-muted'>
                      <td colSpan={nestedColSpan} className='px-2 py-1'>
                        <button
                          type='button'
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleSection(section)
                          }}
                          className='flex w-full items-center gap-1.5 text-left'
                        >
                          <ChevronRight
                            className={cn(
                              'h-3 w-3 shrink-0 text-slate-400 transition-transform',
                              !sectionCollapsed && 'rotate-90'
                            )}
                          />
                          <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                            {section}
                          </span>
                          <span className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:border-border dark:bg-background dark:text-slate-400'>
                            {rows.reduce((n, r) => n + (sectionOf(r) === section ? 1 : 0), 0)}
                          </span>
                          {(() => {
                            const sums = sectionSummary(
                              rows.filter(
                                (r) => sectionOf(r) === section && !pendingDeletes.has(String(r.id))
                              )
                            )
                            if (sums.length === 0) return null
                            return (
                              <span className='ml-auto flex flex-wrap items-baseline gap-x-3 pr-1 text-[10.5px] tabular-nums'>
                                {sums.map((sm) => (
                                  <span
                                    key={sm.label}
                                    className='text-slate-500 dark:text-slate-400'
                                  >
                                    {sm.label}{' '}
                                    <span className='font-semibold text-slate-700 dark:text-slate-200'>
                                      {sm.text}
                                    </span>
                                  </span>
                                ))}
                              </span>
                            )
                          })()}
                        </button>
                      </td>
                    </tr>
                  ) : null
                if (sectionCollapsed) return <Fragment key={id}>{sectionHeader}</Fragment>
                const isEditing = editState?.rowId === id
                // Split mode edits in the docked panel: the row only highlights.
                const inlineEdit = isEditing && !splitMode
                const isDragging = dragIdx === ri
                const isDropTarget = dropIdx === ri && dragIdx !== ri
                const isPendingEdit = pendingEdits.has(id)
                const isPendingDelete = pendingDeletes.has(id)
                // Merge pending edit changes into display values
                const displayRow = isPendingEdit ? { ...row, ...pendingEdits.get(id) } : row
                const lineError =
                  subErrLineField && !isPendingDelete
                    ? (submissionErrorByLine.get(String(displayRow[subErrLineField] ?? '')) ?? null)
                    : null
                return (
                  <Fragment key={id}>
                    {sectionHeader}
                    <tr
                      data-o2m-row={`${relatedCollection}:${id}`}
                      data-o2m-editing={isEditing ? '' : undefined}
                      tabIndex={splitMode ? -1 : undefined}
                      draggable={enableReorder && !!rowOrderField && !isEditing && !isPendingDelete}
                      onDragStart={() => handleDragStart(ri)}
                      onDragOver={(e) => handleDragOver(e, ri)}
                      onDrop={handleDrop}
                      onDragEnd={handleDragEnd}
                      onClick={() => !isEditing && !isPendingDelete && startEdit(displayRow)}
                      onBlur={(e) => {
                        if (!isEditing || saving || isPendingDelete) return
                        if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))
                          return
                        // Focus moving into a PORTALED editor layer (picker panel,
                        // dialog) is still the same interaction; and a null
                        // relatedTarget (clicking non-focusable row chrome — the
                        // Windows report) defers to the pointer handler, which
                        // already knows whether the press was inside.
                        if (isEditorNode(e.relatedTarget as Node | null)) return
                        blurTimerRef.current = setTimeout(() => {
                          if (lastDownInsideRef.current) return
                          if (isEditorNode(document.activeElement)) return
                          void saveEdit()
                        }, 150)
                      }}
                      onFocus={() => {
                        if (blurTimerRef.current) {
                          clearTimeout(blurTimerRef.current)
                          blurTimerRef.current = null
                        }
                      }}
                      className={cn(
                        'group/row border-b border-slate-100 transition-[color,background-color,opacity] duration-300',
                        isDragging ? 'opacity-40' : '',
                        isDropTarget ? 'border-t-2 border-t-[#00ceff]' : '',
                        isPendingDelete
                          ? 'opacity-50 bg-red-50/40 cursor-default line-through'
                          : '',
                        !isPendingDelete && isEditing
                          ? splitMode
                            ? 'bg-[#e6f8ff] outline-none dark:bg-nvr-cyan/15 cursor-default'
                            : 'bg-[#f0fbff] dark:bg-nvr-cyan/5 cursor-default'
                          : '',
                        !isPendingDelete && !isEditing
                          ? lineError
                            ? 'bg-red-50/70 hover:bg-red-50 cursor-pointer dark:bg-red-900/15'
                            : ri % 2 === 0
                              ? 'bg-white hover:bg-slate-50/80 dark:bg-card dark:hover:bg-muted cursor-pointer'
                              : 'bg-slate-50/50 hover:bg-slate-100/60 dark:bg-white/[0.03] dark:hover:bg-muted cursor-pointer'
                          : ''
                      )}
                    >
                      {!(isEditing && !isPendingDelete && rowEditorMode === 'panel') && (
                        <>
                          {selectColOn && (
                            <td
                              className='relative w-7 px-1.5 align-middle'
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              {sinceTick(id)}
                              <input
                                type='checkbox'
                                aria-label={`Select line ${ri + 1}`}
                                className='accent-[#00ceff]'
                                checked={selectedIds.has(id)}
                                disabled={isPendingDelete}
                                onChange={() => toggleSelected(id)}
                              />
                            </td>
                          )}
                          {enableReorder && (rowOrderField || isPendingMode) && (
                            <td
                              className='relative w-6 px-1 align-middle'
                              onClick={(e) => e.stopPropagation()}
                            >
                              {firstLeadCell === 'reorder' && sinceTick(id)}
                              {rowOrderField && (
                                <GripVertical className='h-3 w-3 text-slate-300 cursor-grab' />
                              )}
                            </td>
                          )}
                          {showLineNumbers && (
                            <td className='relative w-8 px-2 align-middle text-slate-400 text-[11px] select-none'>
                              {firstLeadCell === 'num' && sinceTick(id)}
                              <span className='inline-flex items-center gap-1'>
                                {ri + 1}
                                {rowMatchPanel && (
                                  <RowMatchDot
                                    result={rowMatches.byRow.get(id)}
                                    title={rowMatchPanel.title}
                                  />
                                )}
                                {importOriginTip(id) && (
                                  <FileUp
                                    className='h-2.5 w-2.5 text-slate-300 dark:text-slate-500'
                                    aria-label='Imported line'
                                    data-tip={importOriginTip(id) ?? undefined}
                                  />
                                )}
                                {lineOverdue.has(id) && (
                                  <Clock
                                    className='h-2.5 w-2.5 text-amber-500'
                                    aria-label='Line overdue'
                                    data-tip={lineOverdueTip}
                                  />
                                )}
                                {(() => {
                                  const fails = failingLints(displayRow, rowLints)
                                  return fails.length ? (
                                    <AlertTriangle
                                      className='h-2.5 w-2.5 text-amber-500'
                                      aria-label='Line needs attention'
                                      data-tip={fails.join(' · ')}
                                    />
                                  ) : null
                                })()}
                              </span>
                            </td>
                          )}
                          {isPendingMode && (
                            <td className='relative px-3 py-1 align-middle w-20'>
                              {firstLeadCell === 'status' && sinceTick(id)}
                              {!showLineNumbers && rowMatchPanel && (
                                <RowMatchDot
                                  result={rowMatches.byRow.get(id)}
                                  title={rowMatchPanel.title}
                                />
                              )}
                              {!showLineNumbers && importOriginTip(id) && (
                                <FileUp
                                  className='mr-1 inline h-2.5 w-2.5 text-slate-300 dark:text-slate-500'
                                  aria-label='Imported line'
                                  data-tip={importOriginTip(id) ?? undefined}
                                />
                              )}
                              {!showLineNumbers && lineOverdue.has(id) && (
                                <Clock
                                  className='mr-1 inline h-2.5 w-2.5 text-amber-500'
                                  aria-label='Line overdue'
                                  data-tip={lineOverdueTip}
                                />
                              )}
                              {!showLineNumbers &&
                                (() => {
                                  const fails = failingLints(displayRow, rowLints)
                                  return fails.length ? (
                                    <AlertTriangle
                                      className='mr-1 inline h-2.5 w-2.5 text-amber-500'
                                      aria-label='Line needs attention'
                                      data-tip={fails.join(' · ')}
                                    />
                                  ) : null
                                })()}
                              {isPendingDelete ? (
                                <span className='inline-flex text-[10px] font-medium text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300'>
                                  Delete
                                </span>
                              ) : isPendingEdit ? (
                                <span className='nvr-pop inline-flex text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 dark:text-amber-400 dark:bg-amber-500/10 dark:border-amber-500/40 rounded px-1.5 py-0.5'>
                                  Edited
                                </span>
                              ) : null}
                            </td>
                          )}
                        </>
                      )}
                      {isEditing && !isPendingDelete && rowEditorMode === 'panel'
                        ? renderRowEditorPanel({
                            identity: `${showLineNumbers ? `Line ${ri + 1} · ` : ''}${rowIdentityLabel(displayRow)}`,
                            draft: editState?.draft ?? displayRow,
                            rowId: id,
                            saveLabel: 'Save',
                            onDelete: (e) => deleteRow(row, e),
                            drawer: renderDrawerRelations(id, editState?.draft ?? displayRow)
                          })
                        : (() => {
                            // Staged drawer edits (pending mode) haven't reached the
                            // stored rollup yet — overlay this row's live drawer
                            // snapshot so Allocated / Available read true.
                            const rowOverlay = liveOverlayDraft(displayRow, { rowKey: id })
                            return effectiveCols.map((c, ci) => {
                              if (isSummaryCol(c)) {
                                return (
                                  <td key={c.field} className='px-2 py-1 align-top'>
                                    <div className='py-0.5 overflow-hidden text-slate-500'>
                                      {summaryCellContent(c, displayRow)}
                                    </div>
                                  </td>
                                )
                              }
                              const isComputedWrite =
                                c.computed_type === 'write' && !!c.computed_formula
                              const computedDisplayVal = isComputedWrite
                                ? (evalClientFormula(
                                    c.computed_formula as string,
                                    isEditing ? (editState?.draft ?? displayRow) : displayRow
                                  ) ?? displayRow[c.field])
                                : null
                              // Cell history: a value someone CHANGED after the
                              // line was created carries who/when on hover and
                              // a glyph that opens the row's history on that
                              // very version. Creation values stay quiet.
                              const prov =
                                showRowRevisions && !isEditing && !isPendingDelete
                                  ? cellProvenance[id]?.[c.field]
                                  : undefined
                              const provTip = prov
                                ? `${c.label || titleCase(c.field)} · changed ${formatRelative(prov.at)} by ${prov.who}`
                                : undefined
                              return (
                                <td
                                  key={c.field}
                                  className={cn(
                                    'px-2 py-1 align-top',
                                    (prov || (ci === 0 && firstLeadCell === 'data')) && 'relative',
                                    compareData &&
                                      compareColumnClosed(
                                        compareData,
                                        displayRow[compareData.key_field],
                                        c.field
                                      ) &&
                                      'bg-slate-50/80 dark:bg-white/[0.035]'
                                  )}
                                  data-compare-closed={
                                    compareData &&
                                    compareColumnClosed(
                                      compareData,
                                      displayRow[compareData.key_field],
                                      c.field
                                    )
                                      ? ''
                                      : undefined
                                  }
                                  data-tip={provTip}
                                >
                                  {ci === 0 && firstLeadCell === 'data' && sinceTick(id)}
                                  {prov && (
                                    <button
                                      type='button'
                                      aria-label={`History of ${c.label || titleCase(c.field)}`}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setHistoryFocus(prov.revision_id)
                                        setHistoryRow(row)
                                      }}
                                      className='absolute right-0.5 top-0.5 rounded p-px text-slate-300 opacity-0 transition-opacity duration-150 hover:text-[#00ceff] focus-visible:opacity-100 group-hover/row:opacity-100 dark:text-slate-500'
                                    >
                                      <History className='h-2.5 w-2.5' aria-hidden='true' />
                                    </button>
                                  )}
                                  {isComputedWrite ? (
                                    <div className='py-0.5 overflow-hidden text-slate-500 italic'>
                                      {renderCell(c, computedDisplayVal)}
                                    </div>
                                  ) : (inlineEdit && !isPendingDelete) ||
                                    isM2MIface(c.interface) ? (
                                    // A field a rule LOCKS on this row is read-only here too
                                    // (the server drops the write anyway) and says why on hover.
                                    <div
                                      onClick={(e) => e.stopPropagation()}
                                      data-tip={
                                        inlineEdit && editState?.locks?.includes(c.field)
                                          ? lockReasonText(c.field)
                                          : undefined
                                      }
                                      data-grid-cell={inlineEdit ? cellKey(id, c.field) : undefined}
                                    >
                                      <FieldRenderer
                                        field={
                                          { ...c, sort: c.sort ?? 0 } as Parameters<
                                            typeof FieldRenderer
                                          >[0]['field']
                                        }
                                        value={editState?.draft[c.field] ?? null}
                                        onChange={(v) => setDraftField(c.field, v)}
                                        relations={childRelations}
                                        collection={relatedCollection}
                                        itemId={id}
                                        cascadeFilter={fieldCascadeFilters[c.field]}
                                        pinnedOption={pinnedOptionFor(
                                          c.field,
                                          editState?.draft ?? {}
                                        )}
                                        displayOnly={
                                          !inlineEdit ||
                                          isPendingDelete ||
                                          (inlineEdit && !!editState?.locks?.includes(c.field))
                                        }
                                      />
                                    </div>
                                  ) : c.interface === 'formula-column' ? (
                                    <div className='py-0.5 overflow-hidden'>
                                      {renderCell(
                                        c,
                                        rowOverlay[c.field],
                                        row.id != null ? String(row.id) : undefined,
                                        rowOverlay
                                      )}
                                    </div>
                                  ) : c.computed_type === 'rollup' ? (
                                    <div className='py-0.5 overflow-hidden'>
                                      {renderCell(
                                        c,
                                        rowOverlay[c.field] ?? displayRow[c.field],
                                        row.id != null ? String(row.id) : undefined
                                      )}
                                    </div>
                                  ) : (
                                    <div className='py-0.5 overflow-hidden'>
                                      {renderCell(
                                        c,
                                        displayRow[c.field],
                                        row.id != null ? String(row.id) : undefined
                                      )}
                                    </div>
                                  )}
                                  {compareData && (
                                    <CompareCell
                                      data={compareData}
                                      row={compareRowFor(compareData, displayRow)}
                                      rowKey={displayRow[compareData.key_field]}
                                      column={c.field}
                                      planned={
                                        inlineEdit && !isPendingDelete
                                          ? editState?.draft[c.field]
                                          : displayRow[c.field]
                                      }
                                      columnLabel={compareLabelFor(c)}
                                      plannedRow={displayRow}
                                      onAdjust={
                                        !readOnly && !isPendingDelete && row.id != null
                                          ? (patchValues, reason) =>
                                              void stageAdjust(String(row.id), patchValues, reason)
                                          : undefined
                                      }
                                    />
                                  )}
                                </td>
                              )
                            })
                          })()}
                      {!(isEditing && !isPendingDelete && rowEditorMode === 'panel') && (
                        <td className='px-1 py-1 align-middle'>
                          {inlineEdit && !isPendingDelete ? (
                            <div
                              className='flex items-stretch gap-1'
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type='button'
                                disabled={saving}
                                onClick={saveEdit}
                                className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'
                              >
                                {saving ? '…' : 'Save'}
                              </button>
                              <button
                                type='button'
                                onClick={cancelEdit}
                                className='rounded px-1.5 h-9 text-slate-400 hover:text-slate-700 text-[11px]'
                              >
                                ✕
                              </button>
                            </div>
                          ) : (
                            <div className='flex items-center justify-end gap-0.5'>
                              {isPendingDelete ? (
                                <button
                                  type='button'
                                  title='Undo delete'
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    staging?.cancelPendingDelete(relatedCollection, manyField, id)
                                  }}
                                  className='rounded px-1.5 py-0.5 text-[10px] text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400'
                                >
                                  Undo
                                </button>
                              ) : (
                                <>
                                  {isPendingEdit && (
                                    <button
                                      type='button'
                                      title='Undo edit'
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        staging?.cancelPendingEdit(relatedCollection, manyField, id)
                                        // The queued edit carried this row's staged unit/allocation
                                        // ops — undoing it must revert those overlays too.
                                        setDrawerLiveRows((prev) => {
                                          const next: typeof prev = {}
                                          for (const [k, v] of Object.entries(prev))
                                            if (!k.startsWith(`${id}|`)) next[k] = v
                                          return next
                                        })
                                      }}
                                      className='rounded p-0.5 text-amber-400 hover:text-amber-600 text-[10px]'
                                    >
                                      ↩
                                    </button>
                                  )}
                                  {rowComments && id != null && (
                                    <RowCommentButton
                                      collection={relatedCollection}
                                      rowId={String(id)}
                                      count={rowCommentCounts[String(id)] ?? 0}
                                    />
                                  )}
                                  {showRowRevisions && (
                                    <button
                                      type='button'
                                      title='Row history'
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setHistoryRow(row)
                                      }}
                                      className='rounded p-0.5 text-slate-300 hover:text-[#00ceff]'
                                    >
                                      <History className='h-3 w-3' />
                                    </button>
                                  )}
                                  {id != null && !String(id).startsWith('pending') && (
                                    <RowWatchButton
                                      collection={relatedCollection}
                                      rowId={String(id)}
                                      rowLabel={rowLabelOf(row)}
                                    />
                                  )}
                                  {!readOnly && (
                                    <button
                                      type='button'
                                      onClick={(e) => deleteRow(row, e)}
                                      className='rounded p-0.5 text-slate-300 hover:text-red-500'
                                    >
                                      <X className='h-3 w-3' />
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                    {!splitMode && rowSoftLock?.rowKey === id && (
                      <tr data-row-soft-lock-row=''>
                        <td colSpan={nestedColSpan} className='p-0'>
                          {renderRowSoftLockStrip(rowSoftLock, 'row')}
                        </td>
                      </tr>
                    )}
                    {isEditing && rowEditorMode === 'inline' && remoteRowChanges.length > 0 && (
                      <tr data-row-remote-change-row=''>
                        <td colSpan={nestedColSpan} className='px-2 pt-2'>
                          {renderRemoteRowStrip(id)}
                        </td>
                      </tr>
                    )}
                    {lineError && (
                      <tr>
                        <td
                          colSpan={nestedColSpan}
                          className='border-b border-red-100 bg-red-50/60 px-3 py-1 text-[11px] leading-snug text-red-700 dark:border-red-900/30 dark:bg-red-900/10 dark:text-red-400'
                        >
                          ⚠ {lineError}
                        </td>
                      </tr>
                    )}
                    {isEditing &&
                      !isPendingDelete &&
                      rowEditorMode === 'inline' &&
                      drawerRelations &&
                      drawerRelations.length > 0 && (
                        <tr
                          data-o2m-editing
                          className='border-b border-slate-100 bg-[#f0fbff]/60 dark:bg-nvr-cyan/5'
                        >
                          <td colSpan={nestedColSpan} className='px-3 py-2'>
                            <div className='space-y-2'>
                              {drawerRelations.map((dr) => {
                                const relField = typeof dr === 'string' ? dr : dr.field
                                const relHint = typeof dr === 'string' ? undefined : dr.hint
                                const relMatch = typeof dr === 'string' ? undefined : dr.match
                                const rowData = (editState?.draft ?? displayRow) as Record<
                                  string,
                                  unknown
                                >
                                const matched = relMatch
                                  ? buildMatchedDrawer(
                                      relMatch,
                                      rowData,
                                      parentId,
                                      parentDraftCtx?.draft
                                    )
                                  : null
                                return (
                                  <NestedRelationEditor
                                    key={relField}
                                    parentCollection={relatedCollection}
                                    relationField={relField}
                                    parentRowId={id}
                                    parentDraft={editState?.draft ?? displayRow}
                                    hint={relHint}
                                    outerGridInvalidateKey={[
                                      'o2m-rows',
                                      relatedCollection,
                                      manyField,
                                      parentId
                                    ]}
                                    {...(relMatch
                                      ? {
                                          matchCollection: relMatch.collection,
                                          matchQuery: matched?.query ?? null,
                                          matchSeed: matched?.seed ?? {}
                                        }
                                      : isPendingMode
                                        ? {
                                            deferred: true,
                                            stagedOps:
                                              (editState?.draft[`__nested_ops_${relField}`] as
                                                | NestedOps
                                                | undefined) ?? EMPTY_NESTED_OPS,
                                            onStagedOpsChange: (ops: NestedOps) =>
                                              setDraftField(`__nested_ops_${relField}`, ops)
                                          }
                                        : {})}
                                  />
                                )
                              })}
                            </div>
                          </td>
                        </tr>
                      )}
                  </Fragment>
                )
              })}

            {/* New row being entered. Distinct from both the saved rows and the
              staged pending ones: this is the row currently being typed. */}
            {isEditingNew && splitMode && (
              <tr
                data-o2m-editing
                className='border-b border-slate-100 bg-[#e6f8ff] dark:bg-nvr-cyan/15'
              >
                <td
                  colSpan={nestedColSpan}
                  className='px-3 py-1.5 text-[11px] text-slate-500 dark:text-slate-400'
                >
                  {showLineNumbers ? `Line ${rows.length + pendingRows.length + 1} · ` : ''}
                  New line — fill it in below
                </td>
              </tr>
            )}
            {isEditingNew && !splitMode && (
              <tr
                data-o2m-editing
                className='border-b border-slate-100 bg-[#f0fbff] dark:bg-nvr-cyan/5'
              >
                {rowEditorMode !== 'panel' && (
                  <>
                    {selectColOn && <td className='w-7' />}
                    {(rowOrderField || isNew || isPendingMode) && <td className='w-6' />}
                    {/* This row had no number cell at all, so every column after it
                      sat one place left of its header. It also shows the number the
                      row is about to take, continuing past the saved and staged
                      rows, rather than nothing. */}
                    {showLineNumbers && (
                      <td className='w-8 px-2 align-middle text-slate-400 text-[11px] select-none'>
                        {rows.length + pendingRows.length + 1}
                      </td>
                    )}
                    {(isNew || isPendingMode) && <td className='px-3 py-1.5' />}
                  </>
                )}
                {rowEditorMode === 'panel'
                  ? renderRowEditorPanel({
                      identity: `${showLineNumbers ? `Line ${rows.length + pendingRows.length + 1} · ` : ''}New line`,
                      draft: editState!.draft,
                      rowId: undefined,
                      saveLabel: 'Save',
                      drawer: renderDrawerRelations(undefined, editState!.draft)
                    })
                  : effectiveCols.map((c) => {
                      if (isSummaryCol(c)) {
                        return (
                          <td key={c.field} className='px-2 py-1 align-top'>
                            <div className='py-0.5 overflow-hidden text-slate-500'>
                              {summaryCellValue(c, editState!.draft, true)}
                            </div>
                          </td>
                        )
                      }
                      const isComputedWrite = c.computed_type === 'write' && !!c.computed_formula
                      const isMM = isM2MIface(c.interface)
                      const m2mKey = `__m2m_${c.field}`
                      const m2mTarget = isMM ? resolveM2MTarget(c) : null
                      return (
                        <td key={c.field} className='px-2 py-1 align-top'>
                          {isComputedWrite ? (
                            <div className='py-0.5 overflow-hidden text-slate-500 italic'>
                              {renderCell(
                                c,
                                evalClientFormula(c.computed_formula as string, editState!.draft) ??
                                  null
                              )}
                            </div>
                          ) : isMM && m2mTarget ? (
                            <div onClick={(e) => e.stopPropagation()}>
                              <RelationCombobox
                                collection={m2mTarget.targetCollection}
                                value={editState!.draft[m2mKey] ?? null}
                                onChange={(v) => setDraftField(m2mKey, v)}
                                extraFilter={fieldCascadeFilters[c.field]}
                              />
                            </div>
                          ) : (
                            <div onClick={(e) => e.stopPropagation()}>
                              <FieldRenderer
                                field={
                                  { ...c, sort: c.sort ?? 0 } as Parameters<
                                    typeof FieldRenderer
                                  >[0]['field']
                                }
                                value={editState!.draft[c.field] ?? null}
                                onChange={(v) => setDraftField(c.field, v)}
                                relations={childRelations}
                                collection={relatedCollection}
                                itemId='new'
                                cascadeFilter={fieldCascadeFilters[c.field]}
                                pinnedOption={pinnedOptionFor(c.field, editState!.draft)}
                              />
                            </div>
                          )}
                        </td>
                      )
                    })}
                {rowEditorMode !== 'panel' && (
                  <td className='px-1 py-1 align-middle'>
                    <div className='flex items-stretch gap-1'>
                      <button
                        type='button'
                        disabled={saving}
                        onClick={saveEdit}
                        className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'
                      >
                        {saving ? '…' : 'Add'}
                      </button>
                      <button
                        type='button'
                        onClick={cancelEdit}
                        className='rounded px-1.5 h-9 text-slate-400 hover:text-slate-700 text-[11px]'
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            )}

            {rows.length === 0 && pendingRows.length === 0 && !isEditingNew && (
              <tr>
                <td colSpan={nestedColSpan} className='px-3 py-14 text-center text-slate-400'>
                  {emptyLabel
                    ? `No ${emptyLabel.toLowerCase()} yet`
                    : isNew
                      ? 'No pending rows'
                      : 'No rows yet'}
                </td>
              </tr>
            )}

            {/* Addendum view rows */}
            {!isNew &&
              activeView !== 'original' &&
              (() => {
                const entry = addendumO2MEntries.find((e) => e.addendumId === activeView)
                const colCount =
                  (enableReorder && (rowOrderField || isPendingMode) ? 1 : 0) +
                  (showLineNumbers ? 1 : 0) +
                  (isPendingMode ? 1 : 0) +
                  effectiveCols.length +
                  1
                // Field untouched by this addendum → show the record's CURRENT rows
                // read-only, so the form stays complete in addendum view. Only an
                // entry that exists but is EMPTY means "addendum proposes no rows".
                if (!entry) {
                  if (rows.length === 0)
                    return (
                      <tr>
                        <td
                          colSpan={colCount}
                          className='px-3 py-8 text-center text-[11px] text-slate-400'
                        >
                          {emptyLabel ? `No ${emptyLabel.toLowerCase()} yet` : 'No rows'}
                        </td>
                      </tr>
                    )
                  return rows.map((row, ri) => (
                    <tr key={ri} className='border-b border-slate-100'>
                      {enableReorder && (rowOrderField || isPendingMode) && <td className='w-6' />}
                      {showLineNumbers && (
                        <td className='w-8 px-2 align-middle text-[11px] text-slate-400 select-none'>
                          {ri + 1}
                        </td>
                      )}
                      {isPendingMode && <td className='w-20' />}
                      {effectiveCols.map((c) => (
                        <td key={c.field} className='px-2 py-1.5 text-[11px] text-slate-700'>
                          {isSummaryCol(c)
                            ? summaryCellContent(c, row)
                            : renderCell(
                                c,
                                row[c.field],
                                row.id != null ? String(row.id) : undefined
                              )}
                        </td>
                      ))}
                      <td className='w-20' />
                    </tr>
                  ))
                }
                if (entry.rows.length === 0)
                  return (
                    <tr>
                      <td
                        colSpan={colCount}
                        className='px-3 py-8 text-center text-[11px] text-amber-500'
                      >
                        No proposed rows in this addendum
                      </td>
                    </tr>
                  )
                return entry.rows.map((rawRow, ri) => {
                  // Derived columns must be recomputed on BOTH sides before the
                  // diff. An addendum that changes a quantity changes the line's
                  // money too, and a reviewer reading a stale stored total would
                  // approve a figure the save then recalculates to something else.
                  // Proposed rows are stored WITHOUT their relation-path
                  // columns (PO #, Qty Billed …) — those resolve by row id.
                  const row = applyComputedFields({
                    ...rawRow,
                    ...(rawRow.id != null ? (resolvedPathRows?.[String(rawRow.id)] ?? {}) : {})
                  } as Record<string, unknown>)
                  const rawOrig = rows.find((r) => String(r.id) === String(row.id))
                  const origRow = rawOrig
                    ? applyComputedFields({ ...rawOrig } as Record<string, unknown>)
                    : undefined
                  const isNewRow = !origRow
                  const changedFields = new Set(
                    isNewRow
                      ? displayCols.map((c) => c.field)
                      : displayCols
                          .filter(
                            (c) => String(row[c.field] ?? '') !== String(origRow![c.field] ?? '')
                          )
                          .map((c) => c.field)
                  )
                  const rowChanged = isNewRow || changedFields.size > 0
                  return (
                    <tr
                      key={ri}
                      className={
                        rowChanged
                          ? 'border-b border-amber-100 bg-amber-50/40 dark:border-amber-500/25 dark:bg-amber-400/10'
                          : 'border-b border-slate-100'
                      }
                    >
                      {enableReorder && (rowOrderField || isPendingMode) && <td className='w-6' />}
                      {showLineNumbers && (
                        <td
                          className={`w-8 px-2 align-middle text-[11px] select-none ${rowChanged ? 'text-amber-400' : 'text-slate-400'}`}
                        >
                          {ri + 1}
                        </td>
                      )}
                      {isPendingMode && <td className='w-20' />}
                      {effectiveCols.map((c) => (
                        <td
                          key={c.field}
                          className={`px-2 py-1.5 text-[11px] ${changedFields.has(c.field) ? 'bg-amber-50 text-amber-900 dark:bg-amber-400/15 dark:text-amber-300' : 'text-slate-700 dark:text-slate-300'}`}
                        >
                          {isSummaryCol(c)
                            ? summaryCellContent(c, row)
                            : renderCell(
                                c,
                                row[c.field],
                                row.id != null ? String(row.id) : undefined
                              )}
                        </td>
                      ))}
                      <td className='w-20 px-2 py-1.5 text-right'>
                        {rowChanged && (
                          <span className='text-[10px] font-medium uppercase tracking-wide text-amber-400'>
                            {isNewRow ? 'New' : 'Modified'}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })
              })()}
            {/* Pending rows render AFTER saved ones: a row added to an
              existing record belongs at the end of the list, not above
              lines that already exist. */}
            {/* Pending rows (new parent OR pending-save mode) */}
            {!isNew && activeView === 'original' && rows.length > renderCap && (
              <tr ref={renderSentinelRef}>
                <td colSpan={99} className='px-3 py-2 text-center text-[11px] text-slate-400'>
                  Showing {renderCap} of {rows.length} rows — scroll to load more
                </td>
              </tr>
            )}
            {/* Series rows with NO grid row: spend that landed under a key nobody
                planned for must never be invisible — it renders as a read-only
                ghost row the reader can turn into a real one. */}
            {compareData &&
              activeView === 'original' &&
              (() => {
                const seen = new Set<string>()
                for (const r of rows ?? []) seen.add(String(r[compareData.key_field] ?? ''))
                for (const r of pendingRows) seen.add(String(r[compareData.key_field] ?? ''))
                const ghosts = compareData.rows.filter((r) => !seen.has(String(r.key)))
                if (ghosts.length === 0) return null
                return ghosts.map((g) => (
                  <tr
                    key={`compare-ghost:${String(g.key)}`}
                    data-o2m-compare-ghost={String(g.key)}
                    className='border-b border-dashed border-slate-200 bg-slate-50/60 dark:border-border dark:bg-white/[0.025]'
                  >
                    {selectColOn && <td />}
                    {enableReorder && (rowOrderField || isNew || isPendingMode) && <td />}
                    {showLineNumbers && <td />}
                    {(isNew || isPendingMode) && (
                      <td className='px-3 py-1 align-top'>
                        <span className='text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
                          {compareData.label} only
                        </span>
                      </td>
                    )}
                    {effectiveCols.map((c) =>
                      c.field === compareData.key_field ? (
                        <td key={c.field} className='px-2 py-1 align-top'>
                          <div className='py-0.5 text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                            {String(g.key)}
                          </div>
                          <div
                            className='mt-0.5 text-[10.5px] text-slate-600 dark:text-slate-300'
                            data-tip={`${compareData.label} recorded for ${String(g.key)} with no ${
                              emptyLabel ? emptyLabel.toLowerCase() : 'row'
                            } to compare against — add a row for ${String(g.key)} to plan against it`}
                          >
                            No plan for this {titleCase(compareData.key_field).toLowerCase()}
                          </div>
                        </td>
                      ) : (
                        <td
                          key={c.field}
                          className={cn(
                            'px-2 py-1 align-top',
                            compareColumnClosed(compareData, g.key, c.field) &&
                              'bg-slate-100/70 dark:bg-white/[0.035]'
                          )}
                        >
                          {compareData.columns.includes(c.field) && (
                            <div className='py-0.5 text-[12px] text-slate-300 dark:text-slate-600'>
                              —
                            </div>
                          )}
                          <CompareCell
                            data={compareData}
                            row={g}
                            rowKey={g.key}
                            column={c.field}
                            planned={0}
                            columnLabel={compareLabelFor(c)}
                          />
                        </td>
                      )
                    )}
                    <td />
                  </tr>
                ))
              })()}
            {pendingRows.length > 0 &&
              pendingRows.map((row, ri) => {
                const pendingRowId = `pending:${ri}`
                const isEditing = editState?.rowId === pendingRowId
                const inlineEdit = isEditing && !splitMode
                const isPDragging = dragIdx === ri
                const isPDropTarget = dropIdx === ri && dragIdx !== ri
                const isPrefilled = !!row.__prefilled
                return (
                  <Fragment key={ri}>
                    <tr
                      // THE pending-row close bug: without this attribute the
                      // outside-click classifier can't recognize its own editor, so
                      // every click INSIDE an open pending-row form classified as
                      // outside and committed it shut. Saved rows always had it.
                      data-o2m-editing={isEditing ? '' : undefined}
                      data-o2m-row={`${relatedCollection}:${pendingRowId}`}
                      tabIndex={splitMode ? -1 : undefined}
                      draggable={enableReorder && !isEditing}
                      onDragStart={() => handleDragStart(ri)}
                      onDragOver={(e) => handleDragOver(e, ri)}
                      onDrop={(e) => {
                        e.preventDefault()
                        if (dragIdx !== null && dropIdx !== null && dragIdx !== dropIdx) {
                          staging?.reorderRows(relatedCollection, manyField, dragIdx, dropIdx)
                        }
                        handleDragEnd()
                      }}
                      onDragEnd={handleDragEnd}
                      onClick={() => !isEditing && startPendingEdit(row, ri)}
                      onBlur={(e) => {
                        if (!isEditing || saving) return
                        if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))
                          return
                        if (isEditorNode(e.relatedTarget as Node | null)) return
                        blurTimerRef.current = setTimeout(() => {
                          if (lastDownInsideRef.current) return
                          if (isEditorNode(document.activeElement)) return
                          void saveEdit()
                        }, 150)
                      }}
                      onFocus={() => {
                        if (blurTimerRef.current) {
                          clearTimeout(blurTimerRef.current)
                          blurTimerRef.current = null
                        }
                      }}
                      className={cn(
                        'nvr-rise-in border-b border-slate-100 transition-colors',
                        isPDragging ? 'opacity-40' : '',
                        isPDropTarget ? 'border-t-2 border-t-[#00ceff]' : '',
                        isEditing
                          ? splitMode
                            ? 'bg-[#e6f8ff] outline-none dark:bg-nvr-cyan/15 cursor-default'
                            : 'bg-[#f0fbff] dark:bg-nvr-cyan/5 cursor-default'
                          : isPrefilled
                            ? 'hover:bg-slate-50 dark:hover:bg-muted cursor-pointer'
                            : 'bg-amber-50/40 hover:bg-amber-50/70 dark:bg-amber-400/10 dark:hover:bg-amber-400/15 cursor-pointer'
                      )}
                    >
                      {!(isEditing && rowEditorMode === 'panel') && (
                        <>
                          {selectColOn && (
                            <td
                              className='w-7 px-1.5 align-middle'
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <input
                                type='checkbox'
                                aria-label={`Select line ${rows.length + ri + 1}`}
                                className='accent-[#00ceff]'
                                checked={selectedIds.has(pendingRowId)}
                                onChange={() => toggleSelected(pendingRowId)}
                              />
                            </td>
                          )}
                          {enableReorder && (
                            <td
                              className='w-6 px-1 align-middle'
                              onClick={(e) => e.stopPropagation()}
                            >
                              <GripVertical className='h-3 w-3 text-slate-300 cursor-grab' />
                            </td>
                          )}
                          {/* Continue the sequence rather than restarting: a new row
                        showed "1" beside the saved row already numbered 1. */}
                          {showLineNumbers && (
                            <td className='w-8 px-2 align-middle text-slate-400 text-[11px] select-none'>
                              <span className='inline-flex items-center gap-1'>
                                {rows.length + ri + 1}
                                {(() => {
                                  const fails = failingLints(
                                    isEditing ? (editState?.draft ?? row) : row,
                                    rowLints
                                  )
                                  return fails.length ? (
                                    <AlertTriangle
                                      className='h-2.5 w-2.5 text-amber-500'
                                      aria-label='Line needs attention'
                                      data-tip={fails.join(' · ')}
                                    />
                                  ) : null
                                })()}
                              </span>
                            </td>
                          )}
                          <td className='px-3 py-1 align-middle w-16'>
                            {!isEditing && !isPrefilled && (
                              <span className='nvr-pop inline-flex text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 dark:text-amber-400 dark:bg-amber-500/10 dark:border-amber-500/40 rounded px-1.5 py-0.5'>
                                Pending
                              </span>
                            )}
                            {!isEditing &&
                              isPrefilled &&
                              row.id != null &&
                              editedPendingIds.has(row.id as string | number) && (
                                <span className='inline-flex text-[10px] font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5'>
                                  Edited
                                </span>
                              )}
                          </td>
                        </>
                      )}
                      {isEditing && rowEditorMode === 'panel'
                        ? renderRowEditorPanel({
                            identity: `${showLineNumbers ? `Line ${rows.length + ri + 1} · ` : ''}${rowIdentityLabel(isEditing ? editState!.draft : row)}`,
                            draft: editState?.draft ?? row,
                            rowId: pendingRowId,
                            saveLabel: 'Save',
                            onDelete: (e) => {
                              e.stopPropagation()
                              staging?.removeRow(relatedCollection, manyField, ri)
                            },
                            // Grandchild rows for an unsaved row stage against the
                            // draft, so there is no row id to pass yet.
                            drawer: renderDrawerRelations(undefined, editState?.draft ?? row)
                          })
                        : (() => {
                            // Collapsed pending row: rollups/formulas have no stored
                            // value yet — derive them from the row's own staged data so
                            // Allocated / Available read true before the parent saves.
                            const rowOverlay = liveOverlayDraft(
                              isEditing ? editState!.draft : row,
                              { rowKey: pendingRowId }
                            )
                            return effectiveCols.map((c) => {
                              if (isSummaryCol(c)) {
                                return (
                                  <td key={c.field} className='px-2 py-1 align-top'>
                                    <div className='py-0.5 overflow-hidden text-slate-500'>
                                      {summaryCellValue(
                                        c,
                                        isEditing ? editState!.draft : row,
                                        true
                                      )}
                                    </div>
                                  </td>
                                )
                              }
                              const isComputedWrite =
                                c.computed_type === 'write' && !!c.computed_formula
                              const isMM = isM2MIface(c.interface)
                              const m2mKey = `__m2m_${c.field}`
                              const m2mTarget = isMM && inlineEdit ? resolveM2MTarget(c) : null
                              // A prefilled pending row (addendum proposals keep
                              // their source id) has its relation paths resolved
                              // like a saved row — read them from the resolve
                              // map, since the staged object never carries them.
                              const resolvedCell =
                                c.interface === 'relation-path' && row.id != null
                                  ? resolvedPathRows?.[String(row.id)]?.[c.field]
                                  : undefined
                              const displayVal = isComputedWrite
                                ? (evalClientFormula(
                                    c.computed_formula as string,
                                    isEditing ? editState!.draft : row
                                  ) ?? row[c.field])
                                : isEditing
                                  ? (editState!.draft[c.field] ?? resolvedCell)
                                  : (row[c.field] ?? resolvedCell)
                              // A staged import line: cells an auto-fill rule wrote
                              // (not the file) say so on hover.
                              const ruleSet = Array.isArray(row.__rule_set)
                                ? (row.__rule_set as string[]).includes(c.field)
                                : false
                              return (
                                <td
                                  key={c.field}
                                  className={cn(
                                    'px-2 py-1 align-top',
                                    ruleSet &&
                                      !isEditing &&
                                      '[&>div]:underline [&>div]:decoration-dotted [&>div]:decoration-amber-400 [&>div]:underline-offset-2'
                                  )}
                                  data-tip={
                                    ruleSet && !isEditing
                                      ? `${c.label || titleCase(c.field)} · set by an auto-fill rule, not the file`
                                      : undefined
                                  }
                                >
                                  {isComputedWrite ? (
                                    <div className='py-0.5 overflow-hidden text-slate-500 italic'>
                                      {renderCell(c, displayVal)}
                                    </div>
                                  ) : isMM && inlineEdit && m2mTarget ? (
                                    <div onClick={(e) => e.stopPropagation()}>
                                      <RelationCombobox
                                        collection={m2mTarget.targetCollection}
                                        value={editState!.draft[m2mKey] ?? null}
                                        onChange={(v) => setDraftField(m2mKey, v)}
                                        extraFilter={fieldCascadeFilters[c.field]}
                                      />
                                    </div>
                                  ) : isMM ? (
                                    <span className='text-slate-300 text-[11px]'>—</span>
                                  ) : inlineEdit ? (
                                    <div onClick={(e) => e.stopPropagation()}>
                                      <FieldRenderer
                                        field={
                                          { ...c, sort: c.sort ?? 0 } as Parameters<
                                            typeof FieldRenderer
                                          >[0]['field']
                                        }
                                        value={editState!.draft[c.field] ?? null}
                                        onChange={(v) => setDraftField(c.field, v)}
                                        relations={childRelations}
                                        collection={relatedCollection}
                                        itemId='new'
                                        cascadeFilter={fieldCascadeFilters[c.field]}
                                        pinnedOption={pinnedOptionFor(c.field, editState!.draft)}
                                      />
                                    </div>
                                  ) : c.interface === 'formula-column' ? (
                                    <div className='py-0.5 overflow-hidden'>
                                      {renderCell(c, rowOverlay[c.field], undefined, rowOverlay)}
                                    </div>
                                  ) : c.computed_type === 'rollup' ? (
                                    <div className='py-0.5 overflow-hidden'>
                                      {renderCell(
                                        c,
                                        rowOverlay[c.field] ?? row[c.field],
                                        String(row.id)
                                      )}
                                    </div>
                                  ) : (
                                    <div className='py-0.5 overflow-hidden'>
                                      {renderCell(c, displayVal, String(row.id))}
                                    </div>
                                  )}
                                  {compareData && (
                                    <CompareCell
                                      data={compareData}
                                      row={compareRowFor(
                                        compareData,
                                        isEditing ? editState!.draft : row
                                      )}
                                      rowKey={
                                        (isEditing ? editState!.draft : row)[compareData.key_field]
                                      }
                                      column={c.field}
                                      planned={isEditing ? editState!.draft[c.field] : row[c.field]}
                                      columnLabel={compareLabelFor(c)}
                                    />
                                  )}
                                </td>
                              )
                            })
                          })()}
                      {!(isEditing && rowEditorMode === 'panel') && (
                        <td className='px-1 py-1 align-middle'>
                          {inlineEdit ? (
                            <div
                              className='flex items-stretch gap-1'
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type='button'
                                disabled={saving}
                                onClick={saveEdit}
                                className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'
                              >
                                {saving ? '…' : 'Save'}
                              </button>
                              <button
                                type='button'
                                onClick={cancelEdit}
                                className='rounded px-1.5 h-9 text-slate-400 hover:text-slate-700 text-[11px]'
                              >
                                ✕
                              </button>
                            </div>
                          ) : (
                            <div className='flex items-center justify-end gap-0.5'>
                              {showRowRevisions && isPrefilled && row.id != null && (
                                <button
                                  type='button'
                                  title='Row history'
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setHistoryRow(row)
                                  }}
                                  className='rounded p-0.5 text-slate-300 hover:text-[#00ceff]'
                                >
                                  <History className='h-3 w-3' />
                                </button>
                              )}
                              <button
                                type='button'
                                onClick={(e) => {
                                  e.stopPropagation()
                                  staging?.removeRow(relatedCollection, manyField, ri)
                                }}
                                className='rounded p-0.5 text-slate-400 hover:text-red-500'
                              >
                                <X className='h-3 w-3' />
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                    {/* Panel mode renders the drawer INSIDE the panel — this strip is
                  the inline-mode placement only, or the editors double up. */}
                    {isEditing &&
                      rowEditorMode === 'inline' &&
                      drawerRelations &&
                      drawerRelations.length > 0 && (
                        <tr
                          data-o2m-editing
                          className='border-b border-slate-100 bg-[#f0fbff]/60 dark:bg-nvr-cyan/5'
                        >
                          <td colSpan={nestedColSpan} className='px-3 py-2'>
                            <div className='space-y-2'>
                              {drawerRelations.map((dr) => {
                                const relField = typeof dr === 'string' ? dr : dr.field
                                const relHint = typeof dr === 'string' ? undefined : dr.hint
                                return (
                                  <NestedRelationEditor
                                    key={relField}
                                    parentCollection={relatedCollection}
                                    relationField={relField}
                                    parentRowId={null}
                                    stagedMembers={
                                      (editState!.draft[`__o2m_${relField}`] as
                                        | Record<string, unknown>[]
                                        | undefined) ?? []
                                    }
                                    onStagedChange={(next) =>
                                      setDraftField(`__o2m_${relField}`, next)
                                    }
                                    parentDraft={editState!.draft}
                                    hint={relHint}
                                  />
                                )
                              })}
                            </div>
                          </td>
                        </tr>
                      )}
                  </Fragment>
                )
              })}
          </tbody>
          {activeView === 'original' &&
            (() => {
              const aggCols = effectiveCols.filter((c) => {
                const opts = c.options
                  ? ((typeof c.options === 'string'
                      ? (() => {
                          try {
                            return JSON.parse(c.options as string)
                          } catch {
                            return {}
                          }
                        })()
                      : c.options) as Record<string, unknown>)
                  : {}
                return !!opts.aggregate
              })
              if (aggCols.length === 0) return null
              const allRows = [
                ...(rows ?? [])
                  .filter((r) => !pendingDeletes.has(String(r.id)))
                  .map((r) => {
                    const rid = String(r.id)
                    const merged = pendingEdits.has(rid) ? { ...r, ...pendingEdits.get(rid) } : r
                    return liveOverlayDraft(
                      applyComputedFields(merged as Record<string, unknown>),
                      { rowKey: rid }
                    )
                  }),
                // Pending rows have no stored rollup values — derive them from
                // their staged members so Allocated sums true before save.
                ...pendingRows.map((r, i) =>
                  liveOverlayDraft(applyComputedFields(r as Record<string, unknown>), {
                    rowKey: `pending:${i}`
                  })
                )
              ]
              return (
                <tfoot>
                  <tr className='border-t border-slate-200 bg-slate-50 text-[11px] font-medium text-slate-600 dark:border-slate-700 dark:bg-white/[0.03] dark:text-slate-300'>
                    {/* Leading cells must mirror the header exactly: reorder, line #, status */}
                    {selectColOn && <td />}
                    {enableReorder && (rowOrderField || isNew || isPendingMode) && <td />}
                    {showLineNumbers && <td />}
                    {(isNew || isPendingMode) && <td />}
                    {effectiveCols.map((c) => {
                      const opts = c.options
                        ? ((typeof c.options === 'string'
                            ? (() => {
                                try {
                                  return JSON.parse(c.options as string)
                                } catch {
                                  return {}
                                }
                              })()
                            : c.options) as Record<string, unknown>)
                        : {}
                      const agg = opts.aggregate as string | undefined
                      const cmpSum = compareColumnSum(compareData, c.field)
                      // Footer lines WRAP inside their column (label, then the
                      // figure on its own line when the column is narrow) — a
                      // month grid has 15 columns, and "SUM $250,583.75" ran
                      // straight into the neighbouring cell.
                      const cmpLine =
                        cmpSum != null ? (
                          <div
                            data-compare-footer={c.field}
                            className='mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1 text-[11px] font-normal leading-4 text-slate-500 dark:text-slate-400'
                          >
                            <span className='font-mono text-[9px] uppercase tracking-wide text-slate-500 dark:text-slate-400'>
                              {compareData?.label}
                            </span>
                            <span className='tabular-nums'>{fmtMoney(cmpSum)}</span>
                          </div>
                        ) : null
                      if (!agg)
                        return (
                          <td key={c.field} className='px-2 py-1.5 align-top'>
                            {cmpLine}
                          </td>
                        )
                      // A formula column has no stored value — evaluate it per row
                      // (bare refs off the row, dotted refs off resolve-paths).
                      const colFormula =
                        c.interface === 'formula-column' && typeof opts.column_formula === 'string'
                          ? opts.column_formula
                          : null
                      const nums = allRows
                        .map((r) => {
                          if (colFormula) {
                            const v = evaluateNumeric(colFormula, (ref) =>
                              ref.includes('.')
                                ? resolvedPathData?.rows[String(r.id)]?.[ref]?.value
                                : r[ref]
                            )
                            return v == null ? NaN : v
                          }
                          return Number(r[c.field])
                        })
                        .filter((n) => !Number.isNaN(n))
                      let result: number | null = null
                      if (agg === 'count') result = allRows.length
                      else if (nums.length > 0) {
                        if (agg === 'sum') result = nums.reduce((a, b) => a + b, 0)
                        else if (agg === 'avg')
                          result = nums.reduce((a, b) => a + b, 0) / nums.length
                        else if (agg === 'min') result = Math.min(...nums)
                        else if (agg === 'max') result = Math.max(...nums)
                      }
                      const fmt = opts.format as string | undefined
                      const display =
                        result === null
                          ? '—'
                          : (() => {
                              try {
                                if (fmt === 'currency')
                                  return new Intl.NumberFormat(undefined, {
                                    ...numericIntlOptions(opts, 'currency'),
                                    currency: (opts.currency as string) || 'USD'
                                  }).format(result)
                                if (fmt === 'decimal') {
                                  const p = typeof opts.precision === 'number' ? opts.precision : 2
                                  return new Intl.NumberFormat(undefined, {
                                    minimumFractionDigits: p,
                                    maximumFractionDigits: p
                                  }).format(result)
                                }
                                if (fmt === 'int' || agg === 'count')
                                  return new Intl.NumberFormat(undefined, {
                                    maximumFractionDigits: 0
                                  }).format(result)
                                return agg === 'avg' ? result.toFixed(2) : String(result)
                              } catch {
                                return String(result)
                              }
                            })()
                      return (
                        <td key={c.field} className='px-2 py-1.5 align-top'>
                          <div className='flex min-w-0 flex-wrap items-baseline gap-x-1 leading-4'>
                            <span className='font-mono text-[10px] text-slate-500 dark:text-slate-400'>
                              {agg.toUpperCase()}
                            </span>
                            <span className='tabular-nums'>{display}</span>
                          </div>
                          {cmpLine}
                        </td>
                      )
                    })}
                    <td />
                  </tr>
                </tfoot>
              )
            })()}
        </table>

        {uniqueError && (
          <div className='border-t border-red-100 bg-red-50 px-3 py-1.5 text-[11px] text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300'>
            {uniqueError}
          </div>
        )}
        {activeView === 'original' && !isEditingNew && !readOnly && (
          <div className='border-t border-slate-100 px-3 py-1.5'>
            <button
              type='button'
              onClick={startNew}
              className='text-[11px] font-medium text-[#00ceff] hover:underline'
            >
              + Add row
            </button>
          </div>
        )}
      </div>

      {splitMode && rowSoftLock && activeView === 'original' && (
        <div data-grid-split-editor-lock=''>{renderRowSoftLockStrip(rowSoftLock, 'docked')}</div>
      )}
      {splitMode &&
        editState &&
        activeView === 'original' &&
        (() => {
          const rowId = editState.rowId
          const isPendingRow = rowId.startsWith('pending:')
          const pIdx = isPendingRow ? parseInt(rowId.split(':')[1], 10) : -1
          const savedIdx =
            !isPendingRow && rowId !== 'new' ? rows.findIndex((r) => String(r.id) === rowId) : -1
          const savedRow = savedIdx >= 0 ? rows[savedIdx] : undefined
          const lineNo =
            rowId === 'new'
              ? rows.length + pendingRows.length + 1
              : isPendingRow
                ? rows.length + pIdx + 1
                : savedIdx + 1
          const prefix = showLineNumbers ? `Line ${lineNo} · ` : ''
          const identity =
            rowId === 'new' ? `${prefix}New line` : `${prefix}${rowIdentityLabel(editState.draft)}`
          return (
            <div
              data-o2m-editing=''
              data-grid-split-editor=''
              className='flex flex-col rounded-lg border border-nvr-cyan/40 bg-white shadow-[0_6px_24px_-8px_rgba(15,23,42,0.35)] ring-1 ring-nvr-cyan/15 dark:border-nvr-cyan/30 dark:bg-card'
              style={{ height: splitHeight }}
            >
              {/* Drag handle: pull down for a taller editor; the height sticks per browser. */}
              <button
                type='button'
                aria-label='Resize editor panel'
                data-tip='Drag to resize · ↑/↓ nudge'
                className='flex h-3 w-full shrink-0 cursor-row-resize touch-none select-none items-center justify-center rounded-t-lg border-b border-nvr-cyan/20 text-slate-300 hover:bg-nvr-cyan/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nvr-cyan dark:text-slate-500'
                onPointerDown={(e) => {
                  splitDragRef.current = { startY: e.clientY, startH: splitHeight }
                  e.currentTarget.setPointerCapture(e.pointerId)
                }}
                onPointerMove={(e) => {
                  const d = splitDragRef.current
                  if (!d) return
                  setSplitHeight(Math.max(160, Math.min(900, d.startH + (e.clientY - d.startY))))
                }}
                onPointerUp={() => {
                  splitDragRef.current = null
                }}
                onPointerCancel={() => {
                  splitDragRef.current = null
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSplitHeight((h) =>
                      Math.max(160, Math.min(900, h + (e.key === 'ArrowDown' ? 24 : -24)))
                    )
                  }
                }}
              >
                <GripHorizontal className='h-3 w-3' aria-hidden='true' />
              </button>
              <div className='min-h-0 flex-1 overflow-y-auto'>
                {renderRowEditorBody({
                  identity,
                  draft: editState.draft,
                  rowId: rowId === 'new' ? undefined : rowId,
                  saveLabel: rowId === 'new' ? 'Add' : 'Save',
                  bare: true,
                  onDelete: savedRow
                    ? (e) => deleteRow(savedRow, e)
                    : isPendingRow
                      ? (e) => {
                          e.stopPropagation()
                          staging?.removeRow(relatedCollection, manyField, pIdx)
                        }
                      : undefined,
                  // Grandchild rows of an unsaved row stage against the draft.
                  drawer: renderDrawerRelations(savedRow ? rowId : undefined, editState.draft)
                })}
              </div>
            </div>
          )
        })()}

      <GridBulkEditDialog
        open={bulkEditOpen}
        onOpenChange={setBulkEditOpen}
        columns={displayCols.filter(
          (c) =>
            !isPanelReadOnly(c) &&
            !c.field.includes('.') &&
            !isM2MIface(c.interface) &&
            !SYSTEM_FIELDS.has(c.field)
        )}
        rows={selectedTargets.map((t) => t.row)}
        relations={childRelations}
        collection={relatedCollection}
        cascadeFilters={fieldCascadeFilters}
        onApply={applyBulkEdit}
      />

      <RowHistorySheet
        mode='timeline'
        open={timelineOpen}
        onOpenChange={setTimelineOpen}
        rowTitle={`${rows.length} ${rows.length === 1 ? 'line' : 'lines'} on this record`}
        revisions={timelineEntries}
        loading={timelineLoading}
        truncated={!!timelineResp?.truncated}
        fields={cols}
        displayCols={displayCols}
        parentField={manyField}
        m2oRelMap={m2oRelMap}
        relations={childRelations}
        collection={relatedCollection}
        m2oDisplays={m2oDisplays}
        client={client}
        allowRestore={!!allowRevisionRestore && !readOnly}
        rowLabel={(itemId, data) => {
          const n = rowOrderField ? data[rowOrderField] : data.line_number
          const title =
            n !== null && n !== undefined && n !== '' ? `Line ${String(n)}` : `Line #${itemId}`
          const textCol = displayCols.find(
            (c) =>
              c.field !== 'id' &&
              !m2oRelMap.get(c.field) &&
              /^(string|text)$/i.test(c.type ?? '') &&
              typeof data[c.field] === 'string' &&
              (data[c.field] as string).trim() !== ''
          )
          const sub = textCol ? String(data[textCol.field]) : null
          return { title, subtitle: sub && sub.length > 48 ? `${sub.slice(0, 48)}…` : sub }
        }}
        onRestore={(snapshot, ctx) => restoreFromHistory(snapshot, ctx)}
        onRestoreAllTo={restoreAllTo}
        restoringAll={restoringAll}
      />

      <RowHistorySheet
        open={!!historyRow}
        onOpenChange={(o) => {
          if (o) return
          setHistoryRow(null)
          setHistoryFocus(null)
        }}
        rowTitle={(() => {
          const n = rowOrderField ? historyRow?.[rowOrderField] : historyRow?.line_number
          return n !== null && n !== undefined && n !== '' ? `Line ${String(n)}` : 'This row'
        })()}
        rowSubtitle={(() => {
          if (!historyRow) return null
          const textCol = displayCols.find(
            (c) =>
              c.field !== 'id' &&
              !m2oRelMap.get(c.field) &&
              /^(string|text)$/i.test(c.type ?? '') &&
              typeof historyRow[c.field] === 'string' &&
              (historyRow[c.field] as string).trim() !== ''
          )
          return textCol ? String(historyRow[textCol.field]) : null
        })()}
        revisions={rowRevisions}
        loading={revLoading}
        fields={cols}
        displayCols={displayCols}
        parentField={manyField}
        m2oRelMap={m2oRelMap}
        relations={childRelations}
        collection={relatedCollection}
        m2oDisplays={m2oDisplays}
        client={client}
        allowRestore={!!allowRevisionRestore && !readOnly}
        focusRevisionId={historyFocus}
        onRestore={(snapshot, ctx) =>
          restoreFromHistory(snapshot, { ...ctx, itemId: ctx.itemId ?? String(historyRow!.id) })
        }
      />
    </div>
  )
}

/** "Spread left to forecast · $1,234.00" — puts the remaining amount evenly
 *  onto the row's empty target fields (cent-rounded, the last field takes the
 *  rounding dust). Disabled with the reason when there is nothing left or
 *  nowhere to put it. */
const PRESET_LABEL: Record<SpreadPreset, string> = {
  even: 'Evenly',
  front: 'Front-loaded',
  back: 'Back-loaded',
  shape: 'Like previous'
}

/** The shape chips shared by the row action and the grid-level spread. */
function SpreadPresetChips(props: {
  presets: SpreadPreset[]
  value: SpreadPreset
  onChange: (p: SpreadPreset) => void
  shapeLabel?: string | null
}) {
  if (props.presets.length < 2) return null
  return (
    <span className='inline-flex items-center gap-0.5' data-o2m-spread-presets>
      {props.presets.map((p) => (
        <button
          key={p}
          type='button'
          data-o2m-spread-preset={p}
          aria-pressed={props.value === p}
          onClick={() => props.onChange(p)}
          className={cn(
            'rounded-full border px-2 py-px text-[10.5px]',
            props.value === p
              ? 'border-nvr-cyan bg-nvr-cyan/10 font-semibold text-slate-800 dark:text-slate-100'
              : 'border-slate-200 text-slate-500 hover:bg-muted dark:border-border dark:text-slate-400'
          )}
        >
          {p === 'shape' ? (props.shapeLabel ?? PRESET_LABEL.shape) : PRESET_LABEL[p]}
        </button>
      ))}
    </span>
  )
}

function SpreadRemainingAction({
  config,
  draft,
  remaining,
  onApply,
  closedFields,
  shapeSource
}: {
  config: GridSpreadConfig
  draft: Record<string, unknown>
  remaining: number | null
  onApply: (patch: Record<string, unknown>) => void
  /** Targets the comparison series marks CLOSED — never spread into. */
  closedFields?: Set<string>
  /** "Like <previous row>": that row's values over the same fields. */
  shapeSource?: { label: string; values: Record<string, number> } | null
}) {
  const onlyEmpty = config.only_empty !== false
  const isBlank = (v: unknown) => v == null || v === '' || Number(v) === 0
  const closedSkipped = config.fields.filter(
    (f) => closedFields?.has(f) && (!onlyEmpty || isBlank(draft[f]))
  ).length
  const targets = config.fields.filter(
    (f) => !closedFields?.has(f) && (!onlyEmpty || isBlank(draft[f]))
  )
  const presets = useMemo<SpreadPreset[]>(() => {
    const base = config.presets ?? ['even', 'front', 'back', 'shape']
    return base.filter((p) => p !== 'shape' || !!shapeSource)
  }, [config.presets, shapeSource])
  const [preset, setPreset] = useState<SpreadPreset>('even')
  const effectivePreset = presets.includes(preset) ? preset : (presets[0] ?? 'even')
  const amount =
    remaining == null || !Number.isFinite(remaining) ? 0 : Math.round(remaining * 100) / 100
  const fmt = (n: number) =>
    config.format === 'number'
      ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
  const reason =
    amount <= 0
      ? amount < 0
        ? `${fmt(-amount)} over — nothing to spread`
        : 'Nothing left to spread'
      : targets.length === 0
        ? closedSkipped > 0
          ? 'Every open target field already holds a value'
          : 'Every target field already holds a value'
        : null
  const apply = () => {
    if (reason) return
    const shape = shapeSource ? targets.map((f) => shapeSource.values[f] ?? 0) : undefined
    const amounts = spreadAmounts(amount, targets.length, effectivePreset, shape)
    const patch: Record<string, unknown> = {}
    targets.forEach((f, i) => {
      patch[f] = amounts[i]
    })
    onApply(patch)
  }
  return (
    <div className='mt-2 flex flex-wrap items-center gap-2' data-o2m-spread>
      <button
        type='button'
        onClick={apply}
        disabled={!!reason}
        title={
          reason ??
          `${fmt(amount)} across ${targets.length} ${targets.length === 1 ? 'field' : 'fields'}`
        }
        className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[11.5px] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-border dark:bg-background dark:text-slate-200 dark:hover:bg-white/5'
      >
        {config.label ?? 'Spread remaining'}
        <span className='tabular-nums text-slate-500 dark:text-slate-400'>{fmt(amount)}</span>
      </button>
      {!reason && (
        <SpreadPresetChips
          presets={presets}
          value={effectivePreset}
          onChange={setPreset}
          shapeLabel={shapeSource?.label}
        />
      )}
      {!reason && (
        <span className='text-[11px] text-slate-400 dark:text-slate-500'>
          across {targets.length} empty {targets.length === 1 ? 'field' : 'fields'}
          {closedSkipped > 0 && (
            <span data-o2m-spread-skipped={closedSkipped}>
              {' '}
              · {closedSkipped} closed {closedSkipped === 1 ? 'month' : 'months'} skipped
            </span>
          )}
        </span>
      )}
      {reason && <span className='text-[11px] text-slate-400 dark:text-slate-500'>{reason}</span>}
    </div>
  )
}

/** Toolbar twin of the row action: the remaining amount over EVERY row's
 *  empty, open targets in one go (the parent's "spread across years"). */
function SpreadAcrossRowsButton(props: {
  config: GridSpreadConfig
  remaining: number | null
  rowNoun: string
  onApply: (preset: SpreadPreset) => void
}) {
  const [open, setOpen] = useState(false)
  const [preset, setPreset] = useState<SpreadPreset>('even')
  const amount =
    props.remaining == null || !Number.isFinite(props.remaining)
      ? 0
      : Math.round(props.remaining * 100) / 100
  const fmt = (n: number) =>
    props.config.format === 'number'
      ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
  if (amount <= 0) return null
  const presets: SpreadPreset[] = (props.config.presets ?? ['even', 'front', 'back']).filter(
    (p) => p !== 'shape'
  )
  return (
    <span className='relative inline-flex items-center' data-o2m-spread-rows>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'h-6 px-2.5 rounded border transition-colors',
          open
            ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
            : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800'
        )}
        data-tip={`Put the remaining ${fmt(amount)} onto every empty open month across all ${props.rowNoun}s at once`}
      >
        spread across {props.rowNoun}s…
      </button>
      {open && (
        <div
          className='absolute left-0 top-7 z-30 w-[300px] rounded-md border border-slate-200 bg-white p-2.5 text-[12px] shadow-md dark:border-border dark:bg-card'
          data-o2m-spread-rows-panel
        >
          <div className='text-slate-700 dark:text-slate-200'>
            Spread <b className='tabular-nums'>{fmt(amount)}</b> over every empty open month, oldest{' '}
            {props.rowNoun} first.
          </div>
          <div className='mt-2'>
            <SpreadPresetChips
              presets={presets}
              value={presets.includes(preset) ? preset : presets[0]}
              onChange={setPreset}
            />
          </div>
          <div className='mt-2.5 flex justify-end gap-1.5'>
            <button
              type='button'
              onClick={() => setOpen(false)}
              className='h-7 rounded-md px-2.5 text-[12px] text-slate-600 hover:bg-muted dark:text-slate-300'
            >
              Cancel
            </button>
            <button
              type='button'
              data-o2m-spread-rows-apply
              onClick={() => {
                props.onApply(presets.includes(preset) ? preset : presets[0])
                setOpen(false)
              }}
              className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white hover:opacity-90'
            >
              Stage the spread
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
