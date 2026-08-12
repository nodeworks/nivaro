import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { ChangeReasonDialog, changeReasonChallenge, type ChangeReasonChallenge } from './ChangeReasonDialog'
import { AlertTriangle, ChevronRight, GripVertical, History, Loader2, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface RowRule {
  trigger_field?: string | null
  trigger_op?: string
  trigger_value?: string | null
  target_field: string
  target_type: 'set' | 'clear' | 'relation_field'
  target_value?: string | null
  only_if_empty?: boolean
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
import { useNivaroClient, useParentDraft, useDrilldown, useReimportHandler, fieldDrilldownConfig } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, formatRelative, titleCase } from '../../lib/utils'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle
} from '../ui/sheet'
import { useO2MStaging } from './O2MStagingContext'
import { useAddendumO2M, useAddendumView } from './AddendumFieldContext'
import { FieldRenderer, resolveOptionFilterTokens } from './FieldRenderer'
import { ImportFromFileButton } from '../import/ImportFromFileButton'
import { NestedRelationEditor } from './NestedRelationEditor'
import { RelationCombobox } from './RelationCombobox'
import { applyDisplayTemplate, EMPTY_NESTED_OPS, parseJson, SENTINEL_FIELDS } from './helpers'
import type { CMSField, CMSRelation, NestedOps } from './types'

// ── ERP error-blob mining (submission_errors) ────────────────────────────────
// Oracle/Fusion wrap a JSON fragment ("o:errorDetails": [{ detail: … }]) in an
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
  const decoded = raw.replace(/&(lt|gt|quot|amp|#39);/g, (_, e: string) => ERP_XML_ENTITIES[e] ?? '')
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
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
}

interface O2MRevisionEntry {
  item_id: string
  action: string
  timestamp: string
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  data: Record<string, unknown>
}

const NON_DISPLAY_TYPES = new Set(['alias', 'o2m', 'm2m', 'm2a', 'presentation', 'group', 'divider'])
// Built-in preset sentinel: shows every displayCols entry, no relation summary columns.
// Not a real ColumnPreset — never appears in columnPresets, only in activePreset/default_preset.
const ALL_PRESET_SENTINEL = '__all__'

export function evalClientFormula(formula: string, row: Record<string, unknown>): number | null {
  // Handles both `item.fieldname` and `{{fieldname}}` token syntax
  let expr = formula.replace(/item\.(\w+)/g, (_, field) => {
    const val = Number(row[field])
    return Number.isNaN(val) ? '0' : String(val)
  })
  expr = expr.replace(/\{\{(\w+)\}\}/g, (_, field) => {
    const val = Number(row[field])
    return Number.isNaN(val) ? '0' : String(val)
  })
  if (!/^[\d\s+\-*/.()]+$/.test(expr)) return null
  try {
    // biome-ignore lint/security/noGlobalEval: safe — expr sanitized to digits+operators only
    return eval(expr) as number
  } catch {
    return null
  }
}

type CascadeRule = { parent_field: string; child_field: string }
type CascadeResolution =
  | { type: 'none'; reason?: string }
  | { type: 'direct_fk'; filter_column: string }
  | { type: 'm2m_junction'; table: string; self_fk: string; filter_fk: string }

function getUniqueKey(row: Record<string, unknown>, fields: string[]): string {
  return fields.map(f => {
    const staged = row[`__m2m_${f}`]
    return String(staged !== undefined ? staged ?? '' : row[f] ?? '')
  }).join('\x00')
}

function DeletedRowsSection({
  deletedRows,
  displayCols,
  onOpenHistory,
}: {
  deletedRows: Array<{ id: string; data: Record<string, unknown> }>
  displayCols: CMSField[]
  onOpenHistory: (id: string, data: Record<string, unknown>) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className='border-t border-slate-100 mt-1'>
      <button
        type='button'
        onClick={() => setOpen(o => !o)}
        className='flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-slate-50'
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-slate-400 transition-transform', open && 'rotate-90')} />
        <span className='text-[10px] font-medium text-slate-400 uppercase tracking-wide'>Deleted rows</span>
        <span className='ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500'>{deletedRows.length}</span>
      </button>
      {open && deletedRows.map((dr) => {
        const firstCol = displayCols[0]
        const label = firstCol ? String(dr.data[firstCol.field] ?? dr.id) : dr.id
        return (
          <div key={dr.id} className='flex items-center gap-2 px-3 py-1 text-[11px] text-slate-400'>
            <span className='flex-1 truncate line-through'>{label}</span>
            <button type='button' title='Row history'
              onClick={() => onOpenHistory(dr.id, dr.data)}
              className='shrink-0 rounded p-0.5 text-slate-300 hover:text-[#00ceff]'>
              <History className='h-3 w-3' />
            </button>
          </div>
        )
      })}
    </div>
  )
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
  /** Option collection browsed in the drawer (e.g. workflow_line_items). */
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
  columns?: Array<string | { path?: string; label?: string; format?: string; formula?: string; width?: number }>
  /** Group option rows under collapsible headers by this (dotted) path —
   *  EFP grouped allocation lines by workflow. Groups start collapsed;
   *  groups containing an existing allocation start expanded. */
  group_by?: string
  /** Per-row allocation ceiling formula (same tokens as column formulas incl.
   *  {{__saved__}} = this row's saved amount): inputs clamp to it on commit
   *  and show invalid state while exceeding it. */
  value_max?: string
}

function walkPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (cur, seg) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined),
    obj
  )
}

function fmtDrawerVal(v: unknown, format?: string): string {
  if (format === 'presence') return v !== null && v !== undefined && String(v).trim() !== '' ? 'Yes' : 'No'
  if (v === null || v === undefined || v === '') return '—'
  if (format === 'currency' && Number.isFinite(Number(v)))
    return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  return String(v)
}

/** EFP AllocateCost-style drawer: browse every eligible option row with
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
          ? { path: c, label: undefined as string | undefined, format: undefined as string | undefined, formula: undefined as string | undefined, width: undefined as number | undefined }
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
    queryKey: ['allocate-options', config.collection, JSON.stringify(resolvedFilter ?? null), fetchFields],
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
        Number(edit && config.value_field in edit ? edit[config.value_field] : savedRow[config.value_field]) || 0
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
        if (existing?.id != null) await client.request(del(`/items/${relatedCollection}/${existing.id}`))
      } else if (existing?.id != null) {
        if (Number(existing[config.value_field]) !== amount)
          await client.request(patch(`/items/${relatedCollection}/${existing.id}`, { [config.value_field]: amount }))
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
      invalidate()
    } catch { /* row save errors surface via grid refresh */ }
    finally { setSavingId(null) }
  }

  function evalFormulaNumeric(
    formula: string,
    option: Record<string, unknown>,
    extras: Record<string, number>
  ): number | null {
    const expr = formula.replace(/\{\{\s*([\w.]+|__\w+__)\s*\}\}/g, (_, ref: string) => {
      if (ref in extras) return String(extras[ref])
      const n = Number(walkPath(option, ref))
      return String(Number.isFinite(n) ? n : 0)
    })
    if (!/^[-+*/(). 0-9eE]+$/.test(expr)) return null
    try {
      const v = new Function(`"use strict"; return (${expr})`)() as unknown
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    } catch { return null }
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
              <div className='py-10 text-center'><Loader2 className='inline h-4 w-4 animate-spin text-slate-400' /></div>
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
                        <th key={i} className='whitespace-nowrap px-2.5 py-1.5 text-[11px] font-medium text-slate-500'>
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
                        orderedOptions = groupsInOrder.flatMap((g) => options.filter((o) => groupOf(o) === g))
                      }
                      const expanded =
                        expandedGroups ??
                        new Set(
                          options
                            .filter((o) => effectiveFor(String(o.id)).amount > 0)
                            .map(groupOf)
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
                          const allocatedIn = members.filter((o) => effectiveFor(String(o.id)).amount > 0).length
                          // Per-column numeric sums in the header row: currency
                          // path columns and formula columns sum across members;
                          // the input column sums live drafts/saved amounts.
                          const summable = columns.map((c) => !!c.formula || c.format === 'currency')
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
                            return total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
                          }
                          const inputSum = members.reduce((t, m) => t + rowExtras(String(m.id)).__input__, 0)
                          out.push(
                            <tr key={`__group_${g}`} className='border-b border-slate-200 bg-slate-100/80'>
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
                                  <span className='text-[11.5px] font-semibold text-slate-600'>{g}</span>
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
                                <td key={i} className='whitespace-nowrap px-2.5 py-1 text-[11px] font-semibold tabular-nums text-slate-600'>
                                  {summable[labelSpan + i] ? sumFor(labelSpan + i) : ''}
                                </td>
                              ))}
                              <td className='whitespace-nowrap px-2.5 py-1 text-[11px] font-semibold tabular-nums text-[#0891b2]'>
                                {inputSum > 0 ? inputSum.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : ''}
                              </td>
                            </tr>
                          )
                        }
                        if (config.group_by && !expanded.has(g)) continue
                        const eff = effectiveFor(optId)
                        const existing = eff.amount > 0 ? (eff.savedRow ?? {}) : undefined
                        const current =
                          drafts[optId] ?? (eff.amount > 0 ? String(eff.amount) : '')
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
                                className={cn('px-2.5 py-1.5 text-slate-700', c.width ? 'truncate' : 'whitespace-nowrap')}
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
                                    title={max !== null ? `Max ${max.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}` : undefined}
                                    onChange={(e) => setDrafts((d) => ({ ...d, [optId]: e.target.value }))}
                                    onBlur={() => { if (drafts[optId] !== undefined) commit(optId, drafts[optId], opt) }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && drafts[optId] !== undefined) commit(optId, drafts[optId], opt)
                                    }}
                                    placeholder='0'
                                    className={cn(
                                      'h-7 w-28 rounded border px-2 text-[12px] tabular-nums focus:outline-none focus:ring-1',
                                      exceeds
                                        ? 'border-red-400 bg-red-50 text-red-700 focus:ring-red-400'
                                        : 'border-slate-200 focus:ring-[#00ceff]'
                                    )}
                                  />
                                )
                              })()}
                              {savingId === optId && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
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
          { collection: config.candidates.collection, filters: config.candidates.filters, defaults: {} },
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
      if (short.length > 0) parts.push(`short on row${short.length === 1 ? '' : 's'} ${short.join(', ')}`)
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
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={running}
        onClick={() => void run()}
        className="h-6 px-2.5 rounded border border-[#00ceff] text-[#00ceff] hover:bg-[#00ceff]/10 transition-colors disabled:opacity-50"
      >
        {running ? 'Allocating…' : (config.label ?? 'Auto allocate')}
      </button>
      {summary && <span className="text-[11px] text-slate-500">{summary}</span>}
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
  rowFilter,
  rowDefaults,
  allocateDrawer,
  autoAllocate,
  uploadTemplate,
  submissionErrors,
  prefillParentId,
  parentFieldKey,
  readOnly = false
}: {
  relatedCollection: string
  manyField: string
  parentId: string
  /** Same table display, but no editing: hides the Add toolbar, + Add row,
   *  row delete/undo, and blocks cell edit entry. */
  readOnly?: boolean
  parentCollection?: string
  layoutId?: number | null
  showRowRevisions?: boolean
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
  /** Static filter narrowing which child rows this grid shows — flat {col: value}
   *  entries become _eq, object values pass through as filter operators. Lets two
   *  grids on the same relation show disjoint views (e.g. is_osp split). */
  rowFilter?: Record<string, unknown>
  /** Values seeded onto every NEW row created from this grid (e.g. {is_osp: true}). */
  rowDefaults?: Record<string, unknown>
  /** EFP-style allocate drawer: browse all eligible options, type amounts. */
  allocateDrawer?: AllocateDrawerConfig
  autoAllocate?: AutoAllocateConfig
  /** Import template NAME — renders that template's upload button in this
   *  grid's toolbar (existing records; wired to ItemEditForm's reimport flow). */
  uploadTemplate?: string
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
  const addendumO2MEntries = useAddendumO2M()[parentFieldKey ?? ''] ?? []
  const isNew = parentId === 'new'
  const parentDraftCtx = useParentDraft()
  const reimportHandler = useReimportHandler()

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
    if (!isNew || !prefillParentId || !staging) { setIsPrefilling(false); return }
    hasPrefilled.current = true
    client.request<{ data: Record<string, unknown>[] }>(
      get(`/items/${relatedCollection}`, {
        filter: JSON.stringify({ [manyField]: { _eq: prefillParentId } }),
        limit: 200
      })
    ).then((r) => {
      for (const row of r.data ?? []) staging.queueRow(relatedCollection, manyField, { __prefilled: true, ...row })
      setIsPrefilling(false)
    }).catch(() => setIsPrefilling(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // appended to mutation URLs so the API can log activity on the parent record
  const pCtx = parentCollection && !isNew
    ? `?parent_collection=${encodeURIComponent(parentCollection)}&parent_id=${encodeURIComponent(parentId)}`
    : ''

  // Row revision history sheet — holds the saved row whose history is open
  const [historyRow, setHistoryRow] = useState<Record<string, unknown> | null>(null)
  // Field-level restore sheet
  const [fieldRestoreOpen, setFieldRestoreOpen] = useState(false)
  const [fieldRestoring, setFieldRestoring] = useState(false)
  // Rows deleted this session not yet in server query (pending-mode race condition buffer)
  const [deletedRows, setDeletedRows] = useState<Array<Record<string, unknown>>>([])

  // Persistent deleted-row query — survives page reload
  const { data: serverDeletedRows = [], refetch: refetchDeleted } = useQuery<Array<{ item: string; data: Record<string, unknown>; timestamp: string; first_name?: string | null; last_name?: string | null }>>({
    queryKey: ['o2m-deleted-rows', relatedCollection, manyField, parentId],
    queryFn: () =>
      client
        .request<{ data: Array<{ item: string; data: Record<string, unknown>; timestamp: string; first_name?: string | null; last_name?: string | null }> }>(
          get('/revisions/deleted-o2m', { collection: relatedCollection, many_field: manyField, parent_id: parentId })
        )
        .then((r) => r.data ?? []),
    enabled: !!showRowRevisions && !isNew,
    staleTime: 30_000
  })

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

  const { data: fieldSnapshots = [], isLoading: fieldSnapshotsLoading } = useQuery<O2MRevisionEntry[]>({
    queryKey: ['o2m-field-snapshots', relatedCollection, manyField, parentId],
    queryFn: () =>
      client
        .request<{ data: O2MRevisionEntry[] }>(
          get('/revisions/o2m-snapshots', { collection: relatedCollection, many_field: manyField, parent_id: parentId })
        )
        .then((r) => r.data ?? []),
    enabled: fieldRestoreOpen && !isNew,
    staleTime: 15_000
  })

  // Group flat revision list into time-window batches (entries within 5s = one snapshot)
  const fieldSnapshotGroups = (() => {
    if (!fieldSnapshots.length) return []
    const groups: Array<{ timestamp: string; user: string; entries: O2MRevisionEntry[] }> = []
    let cur: (typeof groups)[0] | null = null
    for (const entry of fieldSnapshots) {
      const ts = new Date(entry.timestamp).getTime()
      if (!cur || ts - new Date(cur.timestamp).getTime() > 5_000) {
        const user = [entry.first_name, entry.last_name].filter(Boolean).join(' ') || entry.user_email || 'System'
        cur = { timestamp: entry.timestamp, user, entries: [entry] }
        groups.push(cur)
      } else {
        cur.entries.push(entry)
      }
    }
    return groups
  })()

  async function restoreFieldAt(timestamp: string) {
    setFieldRestoring(true)
    try {
      await client.request(
        post('/revisions/o2m-restore', { collection: relatedCollection, many_field: manyField, parent_id: parentId, target_timestamp: timestamp })
      )
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      qc.invalidateQueries({ queryKey: ['o2m-field-snapshots', relatedCollection, manyField, parentId] })
      setFieldRestoreOpen(false)
    } finally {
      setFieldRestoring(false)
    }
  }

  // { rowId, draft } — null = no row editing, 'new' = adding new row
  // Read-only mode also disables row reordering.
  if (readOnly) enableReorder = false
  // biome-ignore lint/style/noParameterAssign: intentional prop override
  const [editState, setEditState] = useState<{ rowId: string; draft: Record<string, unknown> } | null>(null)
  const editStateRef = useRef<{ rowId: string; draft: Record<string, unknown> } | null>(null)
  useEffect(() => { editStateRef.current = editState }, [editState])
  const [saving, setSaving] = useState(false)
  const [uniqueError, setUniqueError] = useState<string | null>(null)
  const [crChallenge, setCrChallenge] = useState<{ challenge: ChangeReasonChallenge; retry: (reason: string) => Promise<void> } | null>(null)
  const activeView = useAddendumView()
  // Column view preset selection — session-only. Always initializes to the
  // configured default view (then first preset); a clicked preset must NOT
  // stick across reloads.
  const [activePreset, setActivePreset] = useState<string | undefined>(() => {
    if (defaultPreset === ALL_PRESET_SENTINEL) return ALL_PRESET_SENTINEL
    if (defaultPreset && columnPresets?.some(p => p.name === defaultPreset)) return defaultPreset
    return columnPresets?.[0]?.name
  })
  function selectPreset(name: string) {
    setActivePreset(name)
  }
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
          get(`/field-config/${relatedCollection}`, effectiveLayoutId ? { layout_id: String(effectiveLayoutId) } : undefined)
        )
        .then((r) => r.data ?? []),
    staleTime: 60_000
  })

  // Relations for FieldRenderer M2O pickers
  const { data: childRelations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/collections/${relatedCollection}`))
        .then((r) => {
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
        .request<{ data: { row_order_field?: string | null } }>(get(`/collection-layouts/${effectiveLayoutId}`))
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

  const { data: rawRows = [], isLoading: rowsLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ['o2m-rows', relatedCollection, manyField, parentId, rowFilterClause ? JSON.stringify(rowFilterClause) : ''],
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

  // ── Cascade parent → child field filters ──────────────────────────────────
  const cascadeRules = parentCascades ?? []
  const cascadeResolutions = useQueries({
    queries: cascadeRules.map((rule) => ({
      queryKey: ['resolve-cascade', parentDraftCtx?.collection, rule.parent_field, relatedCollection, rule.child_field],
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
          _exists_junction: { table: resolution.table, self_fk: resolution.self_fk, filter_fk: resolution.filter_fk, value: parentValue }
        }
      }
    })
    return filters
  }, [cascadeRules, cascadeResolutions, parentDraftCtx])

  const isPendingMode = saveMode === 'pending'
  const pendingRows = staging ? staging.getPendingRows(relatedCollection, manyField) : []
  const pendingEdits = isPendingMode && staging ? staging.getPendingEdits(relatedCollection, manyField) : new Map<string, Record<string, unknown>>()
  const pendingDeletes = isPendingMode && staging ? staging.getPendingDeletes(relatedCollection, manyField) : new Set<string>()

  // Relation-path columns ('purchase_order.workflow.workflow_id'): read-only
  // values resolved server-side in one bulk call and merged into each row for
  // display. Never editable, never saved.
  const relationPathCols = useMemo(
    () => cols.filter((c) => c.interface === 'relation-path' && c.field.includes('.')).map((c) => c.field),
    [cols]
  )
  // Matched-aggregate columns ('match-agg-column'): aggregate rows of another
  // collection matched to each grid row by filters ($parent tokens fetch-scope
  // the query once; $row tokens group the fetched rows client-side — EFP
  // "Allocated qty per material by cifa" pattern). options:
  // { match: {collection, filters}, aggregate?: 'sum'|'count', value_field,
  //   formula?: '{{quantity}} - {{__agg__}}', format?: 'currency' }
  const matchAggCols = useMemo(
    () => cols.filter((c) => c.interface === 'match-agg-column'),
    [cols]
  )
  const matchAggConfigs = useMemo(
    () =>
      matchAggCols.map((c) => {
        const opts = c.options
          ? ((typeof c.options === 'string' ? (() => { try { return JSON.parse(c.options as string) } catch { return {} } })() : c.options) as Record<string, unknown>)
          : {}
        const match = (opts.match ?? {}) as { collection?: string; filters?: Record<string, unknown> }
        const parentClauses: Record<string, unknown> = {}
        const rowKeys: Array<[string, string]> = []
        let unresolved = false
        for (const [path, token] of Object.entries(match.filters ?? {})) {
          if (typeof token === 'string' && token.startsWith('$row.')) {
            rowKeys.push([path, token.slice('$row.'.length)])
            continue
          }
          const v = resolveMatchToken(token, {}, parentId, parentDraftCtx?.draft)
          if (v === null || v === undefined || v === '') { unresolved = true; continue }
          if (path.startsWith('_')) {
            parentClauses[path] = v
            continue
          }
          const clause = typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { _eq: v }
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
        'match-agg', cfg.collection, JSON.stringify(cfg.parentClauses),
        cfg.valueField, cfg.rowKeys.map(([p]) => p).join('|')
      ],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${cfg.collection}`, {
              filter: JSON.stringify(cfg.parentClauses),
              fields: ['id', ...(cfg.valueField ? [cfg.valueField] : []), ...cfg.rowKeys.map(([p]) => p)].join(','),
              limit: 1000
            })
          )
          .then((r) => r.data ?? []),
      enabled: !cfg.unresolved && !!cfg.collection && !isNew,
      staleTime: 30_000
    }))
  })
  const matchAggData = useMemo(() => {
    const map = new Map<string, { cfg: (typeof matchAggConfigs)[number]; rows: Record<string, unknown>[] }>()
    matchAggConfigs.forEach((cfg, i) => {
      map.set(cfg.field, { cfg, rows: (matchAggResults[i]?.data as Record<string, unknown>[] | undefined) ?? [] })
    })
    return map
  }, [matchAggConfigs, matchAggResults])

  // Formula columns ({{a.b.c}} refs) piggyback the same bulk resolve-paths call
  const formulaCols = useMemo(
    () => cols.filter((c) => c.interface === 'formula-column'),
    [cols]
  )
  const formulaPathRefs = useMemo(() => {
    const out = new Set<string>()
    for (const c of formulaCols) {
      const opts = c.options
        ? ((typeof c.options === 'string' ? (() => { try { return JSON.parse(c.options as string) } catch { return {} } })() : c.options) as Record<string, unknown>)
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
      rawRows.map((r) => String(r.id)).join(',')
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
            ids: rawRows.map((r) => String(r.id)).join(','),
            paths: resolvePathList.join(',')
          })
        )
        .then((r) => r.data ?? { rows: {}, targets: {} }),
    enabled: !isNew && resolvePathList.length > 0 && rawRows.length > 0,
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
  }, [rawRows, resolvedPathRows, rowOrderField, isPendingMode, pendingEdits, sortField, sortDir, sectionGroupBy])

  // Section grouping (sectionGroupBy): active once resolved values are in
  const sectionsActive = !!sectionGroupBy && !!resolvedPathRows
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const sectionOf = (r: Record<string, unknown>): string => {
    const v = String(r[sectionGroupBy ?? ''] ?? '').trim()
    return v || 'Uncategorized'
  }
  const toggleSection = (name: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const computedWriteCols = useMemo(
    () => cols.filter(c => c.computed_type === 'write' && typeof c.computed_formula === 'string' && c.computed_formula.trim()),
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

  function resolveM2MTarget(c: CMSField): { targetCollection: string; junctionCollection: string; junctionManyField: string; junctionOtherField: string } | null {
    const r = childRelations.find(
      rel => rel.one_collection === relatedCollection &&
        (rel.one_field === c.field || (rel.junction_field != null && rel.many_collection === c.field))
    )
    if (!r) return null
    const companion = childRelations.find(cr => cr.many_collection === r.many_collection && cr.id !== r.id)
    if (!companion?.one_collection || !r.many_collection || !r.many_field || !companion.many_field) return null
    return {
      targetCollection: companion.one_collection,
      junctionCollection: r.many_collection,
      junctionManyField: r.many_field,
      junctionOtherField: companion.many_field
    }
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
  const resolvedPreset = columnPresets && columnPresets.length >= 2 && activePreset !== ALL_PRESET_SENTINEL
    ? columnPresets.find(p => p.name === activePreset)
    : undefined
  // Membership filter in LAYOUT order — stored preset column order is ignored for
  // child columns; unknown/stale names in preset.columns are silently skipped.
  const presetChildFieldSet = resolvedPreset
    ? new Set(resolvedPreset.columns.filter(token => !token.includes('.')))
    : null
  const presetCols = presetChildFieldSet
    ? displayCols.filter(c => presetChildFieldSet.has(c.field))
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
      const inDrawer = drawerRelations?.some(dr => (typeof dr === 'string' ? dr : dr.field) === relationField)
      if (inDrawer) tokens.push({ relationField, memberField })
    }
    return tokens
  }, [resolvedPreset, drawerRelations])

  const summaryRelationFields = useMemo(
    () => [...new Set(activePresetDotTokens.map(t => t.relationField))],
    [activePresetDotTokens]
  )

  // Resolve each summary relation's grandchild collection/fk the same way
  // NestedRelationEditor does — reusing the already-fetched childRelations.
  const summaryGrandRels = useMemo(() => {
    const map = new Map<string, { grandCollection: string; fkField: string } | null>()
    for (const relationField of summaryRelationFields) {
      const rel = childRelations.find(r => r.one_collection === relatedCollection && r.one_field === relationField)
      map.set(relationField, rel?.many_collection && rel?.many_field
        ? { grandCollection: rel.many_collection, fkField: rel.many_field }
        : null)
    }
    return map
  }, [summaryRelationFields, childRelations, relatedCollection])

  const summaryGrandCollections = useMemo(
    () => [...new Set(
      [...summaryGrandRels.values()]
        .filter((v): v is { grandCollection: string; fkField: string } => !!v)
        .map(v => v.grandCollection)
    )],
    [summaryGrandRels]
  )

  // Grandchild field-config + relations, batched per distinct grandchild collection.
  // Same query key shape as NestedRelationEditor — shares its cache when a drawer is open.
  const summaryFieldConfigQueries = useQueries({
    queries: summaryGrandCollections.map(gc => ({
      queryKey: ['field-config', gc, null],
      queryFn: () => client.request<{ data: CMSField[] }>(get(`/field-config/${gc}`)).then(r => r.data ?? []),
      staleTime: 60_000
    }))
  })
  const summaryRelationsQueries = useQueries({
    queries: summaryGrandCollections.map(gc => ({
      queryKey: ['collection-meta', gc],
      queryFn: () => client.request<{ data: unknown }>(get(`/collections/${gc}`)).then(r => (r.data as { relations?: CMSRelation[] })?.relations ?? []),
      staleTime: 10 * 60_000
    }))
  })
  const summaryFieldsByCollection = useMemo(() => {
    const map = new Map<string, CMSField[]>()
    summaryGrandCollections.forEach((gc, i) => { map.set(gc, summaryFieldConfigQueries[i]?.data ?? []) })
    return map
  }, [summaryGrandCollections, summaryFieldConfigQueries])
  const summaryRelationsByCollection = useMemo(() => {
    const map = new Map<string, CMSRelation[]>()
    summaryGrandCollections.forEach((gc, i) => { map.set(gc, summaryRelationsQueries[i]?.data ?? []) })
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
        const rel = grelations.find(r => r.many_collection === grandInfo.grandCollection && r.many_field === t.memberField && !r.junction_field)
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
  const visibleRowIds = useMemo(() => rows.map(r => String(r.id)), [rows])
  const rowIdsHash = visibleRowIds.join(',')
  const summaryMembersQueries = useQueries({
    queries: summaryRelationFields.map(relationField => {
      const grandInfo = summaryGrandRels.get(relationField)
      return {
        queryKey: ['o2m-rows', relatedCollection, manyField, parentId, 'summary-members', relationField, rowIdsHash],
        queryFn: () => {
          if (!grandInfo) return Promise.resolve([] as Record<string, unknown>[])
          return client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${grandInfo.grandCollection}`, {
                filter: JSON.stringify({ [grandInfo.fkField]: { _in: visibleRowIds } }),
                limit: 1000
              })
            )
            .then(r => r.data ?? [])
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
    }
    for (const [k, ids] of result) result.set(k, [...new Set(ids)].sort())
    return result
  }, [summaryMembersByRelation, grandM2oRelMaps, pendingRows])

  const { data: summaryM2oDisplays = {} } = useQuery<Record<string, Record<string, string>>>({
    queryKey: ['summary-m2o-display', relatedCollection, ...Array.from(summaryM2oLookupIds.entries()).flat(2)],
    queryFn: async () => {
      const result: Record<string, Record<string, string>> = {}
      await Promise.all(
        [...summaryM2oLookupIds.entries()].map(async ([oneCollection, ids]) => {
          const [metaRes, itemsRes] = await Promise.all([
            client.request<{ data: { display_template?: string | null } }>(get(`/collections/${oneCollection}`)),
            client.request<{ data: Record<string, unknown>[] }>(
              get(`/items/${oneCollection}`, { filter: JSON.stringify({ id: { _in: ids } }), limit: ids.length })
            )
          ])
          result[oneCollection] = {}
          for (const item of itemsRes.data ?? []) {
            result[oneCollection][String(item.id)] = applyDisplayTemplate(metaRes.data?.display_template, item)
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
  const summaryCols = useMemo<CMSField[]>(() => activePresetDotTokens.map(({ relationField, memberField }) => {
    const grandInfo = summaryGrandRels.get(relationField)
    const grandFields = grandInfo ? summaryFieldsByCollection.get(grandInfo.grandCollection) ?? [] : []
    const grandField = grandFields.find(f => f.field === memberField)
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
  }), [activePresetDotTokens, summaryGrandRels, summaryFieldsByCollection])

  // Synthetic preset summary columns only (type 'presentation') — relation-path
  // layout columns also carry dotted fields but render through renderCell.
  function isSummaryCol(c: CMSField): boolean {
    return c.type === 'presentation' && c.field.includes('.')
  }

  // Joined ', ' display for a summary column against one row. Saved rows read the batched
  // members query; pending (unsaved) rows read their staged `__o2m_<relationField>` draft.
  function summaryCellValue(c: CMSField, sourceRow: Record<string, unknown>, isPendingRow: boolean): string {
    const dot = c.field.indexOf('.')
    if (dot < 0) return '—'
    const relationField = c.field.slice(0, dot)
    const memberField = c.field.slice(dot + 1)
    const staged = sourceRow[`__o2m_${relationField}`]
    const members = isPendingRow
      ? (Array.isArray(staged) ? staged as Record<string, unknown>[] : [])
      : (summaryMembersByRelation.get(relationField)?.get(String(sourceRow.id)) ?? [])
    if (members.length === 0) return '—'
    const rel = grandM2oRelMaps.get(relationField)?.get(memberField)
    const parts = members
      .map(m => {
        const v = m[memberField]
        if (v == null || v === '') return null
        if (rel?.one_collection) return summaryM2oDisplays[rel.one_collection]?.[String(v)] ?? String(v)
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
    const members = summaryMembersByRelation.get(relationField)?.get(String(sourceRow.id)) ?? []
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

  // Fields configured for the apply values form (group_key === '__apply_values__')
  const applyValuesCols = useMemo(() =>
    cols.filter(c => c.group_key === '__apply_values__' && !NON_DISPLAY_TYPES.has(c.type ?? '') && !SENTINEL_FIELDS.has(c.field)),
    [cols]
  )

  // Fields configured for the create-with-defaults form (group_key === '__create_with_defaults__')
  // Falls back to displayCols if none configured
  const defaultsCols = useMemo(
    () => cols.filter(c => c.group_key === '__create_with_defaults__' && !NON_DISPLAY_TYPES.has(c.type ?? '') && !SENTINEL_FIELDS.has(c.field)),
    [cols]
  )

  // Map field → M2O relation for display value lookup
  const m2oRelMap = useMemo(() => {
    const map = new Map<string, CMSRelation>()
    for (const c of displayCols) {
      const rel = childRelations.find(
        (r) => r.many_collection === relatedCollection && r.many_field === c.field && !r.junction_field
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

  // Collect unique FK ids per one_collection from all rows (incl. pending edits + addendum rows)
  const m2oLookupIds = useMemo(() => {
    const result = new Map<string, string[]>()
    const allRows = [...rows, ...pendingRows]
    const pendingEditRows = [...pendingEdits.values()]
    const addendumRows = addendumO2MEntries.flatMap(e => e.rows)
    for (const [field, rel] of m2oRelMap) {
      if (!rel.one_collection) continue
      const rowIds = allRows.map((r) => r[field]).filter((v) => v != null).map(String)
      const editIds = pendingEditRows.map((r) => r[field]).filter((v) => v != null).map(String)
      const addIds = addendumRows.map((r) => r[field]).filter((v) => v != null).map(String)
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
          map.set(rel.one_collection, { groupField: opts.group_field, optionField: opts.option_field })
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
  const { data: m2oDisplays = {}, isFetching: m2oFetching } = useQuery<Record<string, Record<string, string>>>({
    queryKey: m2oQueryKey,
    queryFn: async () => {
      const result: Record<string, Record<string, string>> = {}
      // Fetch all collection metas first so we know which fields to expand
      const colMetas = await Promise.all(
        [...m2oLookupIds.keys()].map((oneCollection) =>
          client
            .request<{ data: { display_template?: string | null } }>(get(`/collections/${oneCollection}`))
            .then((r) => ({ collection: oneCollection, meta: r.data }))
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
              result[oneCollection][String(item.id)] = [gLabel, oLabel].filter(Boolean).join(' — ') || String(item.id)
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

  function startEdit(row: Record<string, unknown>) {
    if (readOnly) return
    const id = String(row.id)
    if (editState?.rowId === id) return
    setEditState({ rowId: id, draft: applyComputedFields({ ...row }) })
  }

  function startPendingEdit(row: Record<string, unknown>, ri: number) {
    if (readOnly) return
    const rowId = `pending:${ri}`
    if (editState?.rowId === rowId) return
    setEditState({ rowId, draft: applyComputedFields({ ...row }) })
  }

  function startNew() {
    if (readOnly) return
    setEditState({ rowId: 'new', draft: { ...rowDefaultSeed } })
  }

  function cancelEdit() {
    setEditState(null)
    setUniqueError(null)
  }

  function setDraftField(k: string, v: unknown) {
    const cur = editStateRef.current
    const nextDraft = cur ? applyComputedFields({ ...cur.draft, [k]: v }) : applyComputedFields({ [k]: v })
    setEditState((s) => s ? { ...s, draft: nextDraft } : s)

    if (rowRules && rowRules.length > 0 && client) {
      const parentCtx: Record<string, unknown> = {}
      if (parentDraftCtx?.draft) {
        if (parentContextFields?.length) {
          for (const f of parentContextFields) parentCtx[f] = parentDraftCtx.draft[f] ?? null
        }
        // Auto-include any $parent.* fields referenced in rules, even if not in parentContextFields
        for (const rule of rowRules) {
          const tf = (rule as { trigger_field?: unknown }).trigger_field
          if (typeof tf === 'string' && tf.startsWith('$parent.')) {
            const key = tf.slice(8)
            if (!(key in parentCtx)) parentCtx[key] = parentDraftCtx.draft[key] ?? null
          }
        }
      }
      client.request<{ updates: Record<string, unknown> }>(
        post('/field-rules/evaluate', {
          collection: relatedCollection,
          data: nextDraft,
          changed_field: k,
          parent_context: parentCtx,
          row_rules: rowRules
        })
      ).then((res) => {
        if (res.updates && Object.keys(res.updates).length > 0) {
          setEditState((s) => {
            if (!s) return s
            return { ...s, draft: applyComputedFields({ ...s.draft, ...res.updates }) }
          })
        }
      }).catch(() => {})
    }
  }

  async function saveEdit() {
    if (!editState) return

    if (uniqueBy?.length) {
      const isPendingIdx = editState.rowId.startsWith('pending:')
      const pendingIdx = isPendingIdx ? parseInt(editState.rowId.split(':')[1], 10) : null
      const editingId = editState.rowId === 'new' || isPendingIdx ? null : editState.rowId
      const draftKey = getUniqueKey(editState.draft, uniqueBy)

      const conflict =
        rows.some((r) => {
          if (String(r.id) === editingId) return false
          if (pendingDeletes.has(String(r.id))) return false
          const merged = pendingEdits.has(String(r.id)) ? { ...r, ...pendingEdits.get(String(r.id)) } : r
          return getUniqueKey(merged, uniqueBy) === draftKey
        }) ||
        pendingRows.some((r, i) => i !== pendingIdx && getUniqueKey(r, uniqueBy) === draftKey)

      if (conflict) {
        setUniqueError(`A row with the same ${uniqueBy.join(' + ')} already exists.`)
        return
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
          setEditedPendingIds(prev => new Set([...prev, existingRow.id as string | number]))
        }
        setEditState(null)
        setSaving(false)
        return
      }
      if (editState.rowId === 'new') {
        if ((isNew || isPendingMode) && staging) {
          staging.queueRow(relatedCollection, manyField, { ...editState.draft })
          setEditState(null)
          return
        }
        // Strip __m2m_*/__o2m_* staging keys before POST — those are handled separately below
        const m2mEntries = Object.entries(editState.draft).filter(([k]) => k.startsWith('__m2m_'))
        const o2mEntries = Object.entries(editState.draft).filter(([k]) => k.startsWith('__o2m_'))
        const cleanDraft = Object.fromEntries(
          Object.entries(editState.draft).filter(([k]) => !k.startsWith('__m2m_') && !k.startsWith('__o2m_'))
        )
        const newRowRes = await client.request<{ data: { id: unknown } }>(post(`/items/${relatedCollection}${pCtx}`, { ...cleanDraft, [manyField]: parentId }))
        const newRowId = newRowRes?.data?.id
        if (newRowId != null && m2mEntries.length) {
          await Promise.all(m2mEntries.map(([key, relatedId]) => {
            if (relatedId == null) return Promise.resolve()
            const fieldName = key.slice('__m2m_'.length)
            const target = resolveM2MTarget({ field: fieldName, interface: 'select-multiple-m2m' } as CMSField)
            if (!target) return Promise.resolve()
            return client.request(post(`/items/${target.junctionCollection}`, { [target.junctionManyField]: newRowId, [target.junctionOtherField]: relatedId }))
          }))
        }
        if (newRowId != null && o2mEntries.length) {
          for (const [key, members] of o2mEntries) {
            const fieldName = key.slice('__o2m_'.length)
            const grandRel = childRelations.find(r => r.one_collection === relatedCollection && r.one_field === fieldName)
            if (!grandRel?.many_collection || !grandRel.many_field) continue
            const memberList = Array.isArray(members) ? members as Record<string, unknown>[] : []
            for (const member of memberList) {
              await client.request(post(`/items/${grandRel.many_collection}`, { ...member, [grandRel.many_field]: newRowId }))
            }
          }
        }
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      } else {
        // Filter to display columns — draft includes full API row (id, system fields, etc.).
        // Deliberately the FULL layout-gated set, not preset-effective: row rules may autofill
        // preset-hidden fields, and a mid-edit preset switch must not drop typed values.
        const writableKeys = new Set(displayCols.map(c => c.field).filter(k => !k.startsWith('__m2m_')))
        const rowPayload = Object.fromEntries(Object.entries(editState.draft).filter(([k]) => writableKeys.has(k)))
        if (isPendingMode && staging) {
          // __nested_ops_* keys ride along here (exempt from the writableKeys filter) so the
          // batch flush can apply them — the immediate PATCH branch below still strips them.
          const nestedOpsEntries = Object.entries(editState.draft).filter(([k]) => k.startsWith('__nested_ops_'))
          staging.queueEdit(relatedCollection, manyField, editState.rowId, { ...rowPayload, ...Object.fromEntries(nestedOpsEntries) })
          setEditState(null)
          return
        }
        try {
          await client.request(patch(`/items/${relatedCollection}/${editState.rowId}${pCtx}`, rowPayload))
        } catch (err) {
          const challenge = changeReasonChallenge(err)
          if (challenge) {
            const url = `/items/${relatedCollection}/${editState.rowId}${pCtx}`
            setCrChallenge({
              challenge,
              retry: async (reason: string) => {
                await client.request(patch(url, { ...rowPayload, _change_reason: reason }))
                qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
                setEditState(null)
              }
            })
            setSaving(false)
            return
          }
          throw err
        }
        qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      }
      setEditState(null)
    } catch {
      /* ignore */
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
  const [applyValues, setApplyValues] = useState<Record<string, unknown>>({})
  const [applying, setApplying] = useState(false)

  function setDefaultField(k: string, v: unknown) {
    setDefaultValues(prev => ({ ...prev, [k]: v }))
  }

  async function applyValuesToAllRows() {
    const hasValues = Object.keys(applyValues).some(k => applyValues[k] !== null && applyValues[k] !== undefined)
    if (!hasValues) return
    setApplying(true)
    try {
      if (rows.length) {
        if (isPendingMode && staging) {
          rows
            .filter(r => !pendingDeletes.has(String(r.id)))
            .forEach(row => staging.queueEdit(relatedCollection, manyField, String(row.id), applyValues))
        } else {
          await Promise.all(
            rows.map(row =>
              client.request(patch(`/items/${relatedCollection}/${row.id}${pCtx}`, applyValues))
            )
          )
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
    } catch { /* ignore */ }
    finally { setApplying(false) }
  }

  async function addBulkRows(useDefaults: boolean) {
    const n = Math.max(1, Math.min(100, bulkCount))
    const rowData = useDefaults ? { ...rowDefaultSeed, ...defaultValues } : { ...rowDefaultSeed }
    if ((isNew || isPendingMode) && staging) {
      for (let i = 0; i < n; i++) staging.queueRow(relatedCollection, manyField, { ...rowData })
      return
    }
    setBulkAdding(true)
    try {
      await Promise.all(
        Array.from({ length: n }, () =>
          client.request(post(`/items/${relatedCollection}${pCtx}`, { ...rowData, [manyField]: parentId }))
        )
      )
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    } catch { /* ignore */ }
    finally { setBulkAdding(false) }
  }

  function handleDragStart(ri: number) { setDragIdx(ri) }
  function handleDragOver(e: React.DragEvent, ri: number) { e.preventDefault(); setDropIdx(ri) }
  function handleDragEnd() { setDragIdx(null); setDropIdx(null) }

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
        staging.queueEdit(relatedCollection, manyField, String(row.id), { [rowOrderField!]: newOrder })
      )
      handleDragEnd()
      return
    }

    setReordering(true)
    try {
      await Promise.all(changed.map(({ row, newOrder }) =>
        client.request(patch(`/items/${relatedCollection}/${row.id}${pCtx}`, { [rowOrderField!]: newOrder }))
      ))
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
      if (editState?.rowId === String(id)) setEditState(null)
      // Capture now — hidden while still in pendingDeletes, visible after parent save flushes the delete
      if (showRowRevisions) setDeletedRows(prev => prev.some(r => r.id === id) ? prev : [...prev, row])
      return
    }
    try {
      await client.request(del(`/items/${relatedCollection}/${id}${pCtx}`))
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
      if (editState?.rowId === String(id)) setEditState(null)
      if (showRowRevisions) {
        setDeletedRows(prev => prev.some(r => r.id === id) ? prev : [...prev, row])
        void refetchDeleted()
      }
    } catch {
      /* ignore */
    }
  }

  function renderCell(col: CMSField, val: unknown, rowId?: string) {
    const colOpts = col.options
      ? ((typeof col.options === 'string' ? (() => { try { return JSON.parse(col.options as string) } catch { return {} } })() : col.options) as Record<string, unknown>)
      : {}

    // Formula column: arithmetic over {{col}} (row values) + {{dotted.path}}
    // (bulk-resolved path values) — display-only, computed at render.
    if (col.interface === 'formula-column') {
      const formula = typeof colOpts.column_formula === 'string' ? colOpts.column_formula : ''
      if (!formula || !rowId) return <span className='text-slate-300'>—</span>
      const row = rows.find((r) => String(r.id) === rowId) ?? {}
      const expr = formula.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, ref: string) => {
        const raw = ref.includes('.')
          ? resolvedPathData?.rows[rowId]?.[ref]?.value
          : (row as Record<string, unknown>)[ref]
        const n = Number(raw)
        return String(Number.isFinite(n) ? n : 0)
      })
      if (!/^[-+*/(). 0-9eE]+$/.test(expr)) return <span className='text-slate-300'>—</span>
      let result: number | null = null
      try {
        const v = new Function(`"use strict"; return (${expr})`)() as unknown
        if (typeof v === 'number' && Number.isFinite(v)) result = v
      } catch { /* unrenderable */ }
      if (result === null) return <span className='text-slate-300'>—</span>
      const formatted =
        colOpts.format === 'currency'
          ? result.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
          : result.toLocaleString('en-US', { maximumFractionDigits: 2 })
      return <span className='tabular-nums'>{formatted}</span>
    }

    // Matched-aggregate column
    if (col.interface === 'match-agg-column') {
      const entry = matchAggData.get(col.field)
      if (!entry || !rowId) return <span className='text-slate-300'>—</span>
      const gridRow = rows.find((r) => String(r.id) === rowId) ?? {}
      const walk = (obj: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>(
          (cur, seg) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined),
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
        const expr = entry.cfg.formula.replace(/\{\{\s*([\w.]+|__agg__)\s*\}\}/g, (_, ref: string) => {
          if (ref === '__agg__') return String(agg)
          const n = Number((gridRow as Record<string, unknown>)[ref])
          return String(Number.isFinite(n) ? n : 0)
        })
        if (!/^[-+*/(). 0-9eE]+$/.test(expr)) return <span className='text-slate-300'>—</span>
        try {
          const v = new Function(`"use strict"; return (${expr})`)() as unknown
          if (typeof v === 'number' && Number.isFinite(v)) agg = v
          else return <span className='text-slate-300'>—</span>
        } catch {
          return <span className='text-slate-300'>—</span>
        }
      }
      const formatted =
        entry.cfg.format === 'currency'
          ? agg.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
          : agg.toLocaleString('en-US', { maximumFractionDigits: 2 })
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
        style: 'currency',
        currency: (colOpts.currency as string) || 'USD'
      })
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
      if (!display && m2oFetching) return <Loader2 className='h-3 w-3 animate-spin text-slate-300' />
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
      return <span className={val ? 'text-emerald-600' : 'text-slate-400'}>{val ? 'Yes' : 'No'}</span>
    if (col.type === 'datetime' || col.type === 'date') {
      try { return <span className='block truncate'>{new Date(String(val)).toLocaleDateString()}</span> } catch { /* fall */ }
    }
    const NUMERIC_TYPES = ['integer', 'bigInteger', 'decimal', 'float', 'money', 'smallmoney', 'tinyint', 'smallint', 'bigint', 'int', 'numeric', 'real', 'double', 'number']
    if (NUMERIC_TYPES.includes(col.type ?? '')) {
      const num = Number(val)
      if (!Number.isNaN(num)) {
        try {
          const opts = col.options ? (typeof col.options === 'string' ? JSON.parse(col.options) : col.options) as Record<string, unknown> : {}
          const fmt = opts.format as string | undefined
          if (fmt === 'int') {
            return <span className='block truncate tabular-nums'>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(num)}</span>
          }
          if (fmt === 'decimal') {
            const prec = typeof opts.precision === 'number' ? opts.precision : 2
            return <span className='block truncate tabular-nums'>{new Intl.NumberFormat(undefined, { minimumFractionDigits: prec, maximumFractionDigits: prec }).format(num)}</span>
          }
          if (fmt === 'currency') {
            const curr = (opts.currency as string) || 'USD'
            return <span className='block truncate tabular-nums'>{new Intl.NumberFormat(undefined, { style: 'currency', currency: curr }).format(num)}</span>
          }
        } catch { /* fall through to default */ }
      }
    }
    return <span className='block truncate'>{String(val)}</span>
  }

  if (colsLoading || (!isNew && rowsLoading))
    return <div className='py-3 text-center text-[12px] text-slate-400'><Loader2 className='h-4 w-4 animate-spin inline' /></div>

  const isEditingNew = editState?.rowId === 'new'

  // Same arithmetic as the empty-state colSpan below — reused for the nested
  // relation editor's expandable section row so it spans the full grid width.
  const nestedColSpan =
    effectiveCols.length +
    ((isNew || isPendingMode) ? 2 : 1) +
    (rowOrderField || isNew || isPendingMode ? 1 : 0)

  const isAllPresetActive = activePreset === ALL_PRESET_SENTINEL
  // Stale stored names keep highlighting columnPresets[0] (unchanged prior behavior);
  // the All chip only highlights on the explicit sentinel, never as a fallback.
  const activePresetHighlightName = isAllPresetActive ? null : (resolvedPreset?.name ?? columnPresets?.[0]?.name)
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
      {columnPresets.map(p => (
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
    <div className='space-y-1.5'>
      <ChangeReasonDialog
        challenge={crChallenge?.challenge ?? null}
        onCancel={() => setCrChallenge(null)}
        onSubmit={(reason) => {
          const pending = crChallenge
          setCrChallenge(null)
          void pending?.retry(reason)
        }}
      />
      {!readOnly && <div className='flex items-center gap-2 text-[11px]'>
        <span className='text-slate-400'>Add</span>
        <input
          type='number'
          min={1}
          max={100}
          value={bulkCount}
          onChange={e => setBulkCount(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
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
        {allocateDrawer && (!isNew || staging) && (
          <AllocateDrawer
            config={allocateDrawer}
            relatedCollection={relatedCollection}
            manyField={manyField}
            parentId={parentId}
            rows={isNew ? [] : rows}
            rowDefaults={rowDefaultSeed}
            parentDraft={parentDraftCtx?.draft}
            invalidate={() => qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })}
            staging={staging}
            stagingActive={(isNew || isPendingMode) && !!staging}
            pendingRows={pendingRows}
            pendingEdits={pendingEdits}
            pendingDeletes={pendingDeletes}
          />
        )}
        {autoAllocate && !isNew && !readOnly && (() => {
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
        {uploadTemplate && !isNew && !readOnly && reimportHandler && parentCollection && (
          <ImportFromFileButton
            collection={parentCollection}
            templateFilter={(t) => t.name === uploadTemplate && t.reimport?.enabled === true}
            getLabel={(t) => t.reimport?.button_label ?? t.button_label}
            onParsed={(result, template) => reimportHandler(result, template)}
            compact
          />
        )}
        {defaultsCols.length > 0 && (
          <button
            type='button'
            onClick={() => setDefaultsOpen(v => !v)}
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
            onClick={() => setApplyOpen(v => !v)}
            className={cn(
              'h-6 px-2.5 rounded border transition-colors',
              applyOpen
                ? 'border-amber-400 bg-amber-50 text-amber-700'
                : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800'
            )}
          >
            apply values…
          </button>
        )}
        {bulkAdding && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
        {presetSwitcher}
        {showRowRevisions && allowRevisionRestore && !isNew && (
          <button
            type='button'
            title='Restore field from history'
            onClick={() => setFieldRestoreOpen(true)}
            className='ml-auto rounded p-1 text-slate-300 hover:text-[#00ceff]'
          >
            <History className='h-3.5 w-3.5' />
          </button>
        )}
      </div>}

      {applyOpen && applyValuesCols.length > 0 && (
        <div className='rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2'>
          <p className='text-[11px] font-medium text-amber-700'>Apply values to all {rows.length + pendingRows.length} rows</p>
          <div className='flex flex-wrap gap-2 items-end'>
            {applyValuesCols.map(c => (
              <div key={c.field} className='min-w-[160px]'>
                <p className='text-[10px] text-slate-500 mb-0.5'>{c.label ?? titleCase(c.field)}</p>
                <FieldRenderer
                  field={c}
                  value={applyValues[c.field] ?? null}
                  onChange={v => setApplyValues(prev => ({ ...prev, [c.field]: v }))}
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

    {isPrefilling && (
      <div className='rounded-lg border border-slate-200 p-3 space-y-1.5'>
        <div className='h-8 rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))] animate-pulse' />
        <div className='h-8 rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))] animate-pulse' />
        <div className='h-8 rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))] animate-pulse' />
      </div>
    )}
    {/* readOnly grids skip the !readOnly toolbar above, so the preset switcher gets its own strip */}
    {readOnly && presetSwitcher}
    <div className={isPrefilling ? 'hidden' : 'relative rounded-lg border border-slate-200 text-[12px]'}>
      {reordering && (
        <div className='absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-white/60 backdrop-blur-[1px]'>
          <div className='flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 shadow-sm text-[12px] text-slate-500'>
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
            Saving order…
          </div>
        </div>
      )}
      <table className='w-full table-fixed'>
        <thead className='bg-slate-50 border-b border-slate-200 [&>tr>th:first-child]:rounded-tl-lg [&>tr>th:last-child]:rounded-tr-lg'>
          <tr>
            {enableReorder && (rowOrderField || isNew || isPendingMode) && <th className='w-6' />}
            {showLineNumbers && <th className='w-8 px-2 py-2 text-left font-medium text-slate-400 text-[11px]'>#</th>}
            {(isNew || isPendingMode) && <th className='px-3 py-2 text-left font-medium text-slate-400 text-[11px] w-20'>Status</th>}
            {effectiveCols.map((c) => (
              <th key={c.field} className='px-3 py-2 text-left font-medium text-slate-500 text-[11px]'>
                {c.label ?? titleCase(c.field)}
              </th>
            ))}
            <th className='w-20' />
          </tr>
        </thead>
        <tbody>
          {/* Defaults row */}
          {defaultsOpen && (
            <tr className='border-b border-[#00ceff]/20 bg-[#00ceff]/5'>
              {enableReorder && (rowOrderField || isNew || isPendingMode) && <td className='w-6' />}
              {showLineNumbers && <td className='w-8' />}
              {(isNew || isPendingMode) && <td className='px-3 py-1 align-middle w-20'>
                <span className='text-[10px] font-medium text-[#009abe]'>Defaults</span>
              </td>}
              {defaultsCols.map(c => (
                <td key={c.field} className='px-2 py-1 align-top'>
                  <FieldRenderer
                    field={c}
                    value={defaultValues[c.field] ?? null}
                    onChange={v => setDefaultField(c.field, v)}
                    relations={childRelations}
                    collection={relatedCollection}
                    itemId='new'
                  />
                </td>
              ))}
              <td className='px-1 py-1 align-top'>
                <button
                  type='button'
                  disabled={bulkAdding}
                  onClick={() => addBulkRows(true)}
                  className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50 whitespace-nowrap'
                >
                  {bulkAdding ? '…' : `Add ${bulkCount}`}
                </button>
              </td>
            </tr>
          )}

          {/* Pending rows (new parent OR pending-save mode) */}
          {pendingRows.length > 0 && pendingRows.map((row, ri) => {
            const pendingRowId = `pending:${ri}`
            const isEditing = editState?.rowId === pendingRowId
            const isPDragging = dragIdx === ri
            const isPDropTarget = dropIdx === ri && dragIdx !== ri
            const isPrefilled = !!row.__prefilled
            return (
              <Fragment key={ri}>
              <tr
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
                  if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return
                  blurTimerRef.current = setTimeout(() => void saveEdit(), 150)
                }}
                onFocus={() => {
                  if (blurTimerRef.current) { clearTimeout(blurTimerRef.current); blurTimerRef.current = null }
                }}
                className={cn('border-b border-slate-100 transition-colors',
                  isPDragging ? 'opacity-40' : '',
                  isPDropTarget ? 'border-t-2 border-t-[#00ceff]' : '',
                  isEditing
                    ? 'bg-[#f0fbff] dark:bg-nvr-cyan/5 cursor-default'
                    : isPrefilled ? 'hover:bg-slate-50 cursor-pointer' : 'bg-amber-50/40 hover:bg-amber-50/70 cursor-pointer'
                )}>
                {enableReorder && (
                  <td className='w-6 px-1 align-middle' onClick={(e) => e.stopPropagation()}>
                    <GripVertical className='h-3 w-3 text-slate-300 cursor-grab' />
                  </td>
                )}
                {showLineNumbers && <td className='w-8 px-2 align-middle text-slate-400 text-[11px] select-none'>{ri + 1}</td>}
                <td className='px-3 py-1 align-middle w-16'>
                  {!isEditing && !isPrefilled && (
                    <span className='inline-flex text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5'>Pending</span>
                  )}
                  {!isEditing && isPrefilled && row.id != null && editedPendingIds.has(row.id as string | number) && (
                    <span className='inline-flex text-[10px] font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5'>Edited</span>
                  )}
                </td>
                {effectiveCols.map((c) => {
                  if (isSummaryCol(c)) {
                    return (
                      <td key={c.field} className='px-2 py-1 align-top'>
                        <div className='py-0.5 overflow-hidden text-slate-500'>{summaryCellValue(c, isEditing ? editState!.draft : row, true)}</div>
                      </td>
                    )
                  }
                  const isComputedWrite = c.computed_type === 'write' && !!c.computed_formula
                  const isMM = isM2MIface(c.interface)
                  const m2mKey = `__m2m_${c.field}`
                  const m2mTarget = isMM && isEditing ? resolveM2MTarget(c) : null
                  const displayVal = isComputedWrite
                    ? (evalClientFormula(c.computed_formula as string, isEditing ? editState!.draft : row) ?? row[c.field])
                    : (isEditing ? editState!.draft[c.field] : row[c.field])
                  return (
                    <td key={c.field} className='px-2 py-1 align-top'>
                      {isComputedWrite ? (
                        <div className='py-0.5 overflow-hidden text-slate-500 italic'>{renderCell(c, displayVal)}</div>
                      ) : isMM && isEditing && m2mTarget ? (
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
                      ) : isEditing ? (
                        <div onClick={(e) => e.stopPropagation()}>
                          <FieldRenderer
                            field={{ ...c, sort: c.sort ?? 0 } as Parameters<typeof FieldRenderer>[0]['field']}
                            value={editState!.draft[c.field] ?? null}
                            onChange={(v) => setDraftField(c.field, v)}
                            relations={childRelations}
                            collection={relatedCollection}
                            itemId='new'
                            cascadeFilter={fieldCascadeFilters[c.field]}
                          />
                        </div>
                      ) : (
                        <div className='py-0.5 overflow-hidden'>{renderCell(c, row[c.field], String(row.id))}</div>
                      )}
                    </td>
                  )
                })}
                <td className='px-1 py-1 align-middle'>
                  {isEditing ? (
                    <div className='flex items-stretch gap-1' onClick={(e) => e.stopPropagation()}>
                      <button type='button' disabled={saving} onClick={saveEdit}
                        className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'>
                        {saving ? '…' : 'Save'}
                      </button>
                      <button type='button' onClick={cancelEdit}
                        className='rounded px-1.5 h-9 text-slate-400 hover:text-slate-700 text-[11px]'>
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className='flex items-center justify-end gap-0.5'>
                      {showRowRevisions && isPrefilled && row.id != null && (
                        <button type='button' title='Row history'
                          onClick={(e) => { e.stopPropagation(); setHistoryRow(row) }}
                          className='rounded p-0.5 text-slate-300 hover:text-[#00ceff]'>
                          <History className='h-3 w-3' />
                        </button>
                      )}
                      <button type='button'
                        onClick={(e) => { e.stopPropagation(); staging?.removeRow(relatedCollection, manyField, ri) }}
                        className='rounded p-0.5 text-slate-400 hover:text-red-500'>
                        <X className='h-3 w-3' />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
              {isEditing && drawerRelations && drawerRelations.length > 0 && (
                <tr className='border-b border-slate-100 bg-[#f0fbff]/60 dark:bg-nvr-cyan/5'>
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
                              (editState!.draft[`__o2m_${relField}`] as Record<string, unknown>[] | undefined) ?? []
                            }
                            onStagedChange={(next) => setDraftField(`__o2m_${relField}`, next)}
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

          {/* Saved rows */}
          {!isNew && activeView === 'original' && rows.map((row, ri) => {
            const id = String(row.id)
            const section = sectionsActive ? sectionOf(row) : null
            const isSectionStart = section !== null && (ri === 0 || sectionOf(rows[ri - 1]) !== section)
            const sectionCollapsed = section !== null && collapsedSections.has(section)
            const sectionHeader = isSectionStart && section !== null ? (
              <tr className='border-b border-slate-200 bg-slate-100/80 dark:border-border dark:bg-muted'>
                <td colSpan={effectiveCols.length + 1 + ((isNew || isPendingMode) ? 1 : 0) + (showLineNumbers ? 1 : 0) + (enableReorder && (rowOrderField || isNew || isPendingMode) ? 1 : 0)} className='px-2 py-1'>
                  <button
                    type='button'
                    onClick={(e) => { e.stopPropagation(); toggleSection(section) }}
                    className='flex w-full items-center gap-1.5 text-left'
                  >
                    <ChevronRight className={cn('h-3 w-3 shrink-0 text-slate-400 transition-transform', !sectionCollapsed && 'rotate-90')} />
                    <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>{section}</span>
                    <span className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:border-border dark:bg-background dark:text-slate-400'>
                      {rows.reduce((n, r) => n + (sectionOf(r) === section ? 1 : 0), 0)}
                    </span>
                  </button>
                </td>
              </tr>
            ) : null
            if (sectionCollapsed) return <Fragment key={id}>{sectionHeader}</Fragment>
            const isEditing = editState?.rowId === id
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
                draggable={enableReorder && !!rowOrderField && !isEditing && !isPendingDelete}
                onDragStart={() => handleDragStart(ri)}
                onDragOver={(e) => handleDragOver(e, ri)}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                onClick={() => !isEditing && !isPendingDelete && startEdit(displayRow)}
                onBlur={(e) => {
                  if (!isEditing || saving || isPendingDelete) return
                  if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return
                  blurTimerRef.current = setTimeout(() => void saveEdit(), 150)
                }}
                onFocus={() => {
                  if (blurTimerRef.current) { clearTimeout(blurTimerRef.current); blurTimerRef.current = null }
                }}
                className={cn('border-b border-slate-100 transition-colors',
                  isDragging ? 'opacity-40' : '',
                  isDropTarget ? 'border-t-2 border-t-[#00ceff]' : '',
                  isPendingDelete ? 'opacity-50 bg-red-50/40 cursor-default line-through' : '',
                  !isPendingDelete && isEditing ? 'bg-[#f0fbff] dark:bg-nvr-cyan/5 cursor-default' : '',
                  !isPendingDelete && !isEditing
                    ? lineError
                      ? 'bg-red-50/70 hover:bg-red-50 cursor-pointer dark:bg-red-900/15'
                      : ri % 2 === 0
                        ? 'bg-white hover:bg-slate-50/80 cursor-pointer'
                        : 'bg-slate-50/50 hover:bg-slate-100/60 cursor-pointer'
                    : ''
                )}>
                {enableReorder && (rowOrderField || isPendingMode) && (
                  <td className='w-6 px-1 align-middle' onClick={(e) => e.stopPropagation()}>
                    {rowOrderField && <GripVertical className='h-3 w-3 text-slate-300 cursor-grab' />}
                  </td>
                )}
                {showLineNumbers && <td className='w-8 px-2 align-middle text-slate-400 text-[11px] select-none'>{ri + 1}</td>}
                {isPendingMode && (
                  <td className='px-3 py-1 align-middle w-20'>
                    {isPendingDelete
                      ? <span className='inline-flex text-[10px] font-medium text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5'>Delete</span>
                      : isPendingEdit
                        ? <span className='inline-flex text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5'>Edited</span>
                        : null
                    }
                  </td>
                )}
                {effectiveCols.map((c) => {
                  if (isSummaryCol(c)) {
                    return (
                      <td key={c.field} className='px-2 py-1 align-top'>
                        <div className='py-0.5 overflow-hidden text-slate-500'>{summaryCellContent(c, displayRow)}</div>
                      </td>
                    )
                  }
                  const isComputedWrite = c.computed_type === 'write' && !!c.computed_formula
                  const computedDisplayVal = isComputedWrite
                    ? (evalClientFormula(c.computed_formula as string, isEditing ? (editState?.draft ?? displayRow) : displayRow) ?? displayRow[c.field])
                    : null
                  return (
                    <td key={c.field} className='px-2 py-1 align-top'>
                      {isComputedWrite ? (
                        <div className='py-0.5 overflow-hidden text-slate-500 italic'>{renderCell(c, computedDisplayVal)}</div>
                      ) : (isEditing && !isPendingDelete) || isM2MIface(c.interface) ? (
                        <div onClick={(e) => e.stopPropagation()}>
                          <FieldRenderer
                            field={{ ...c, sort: c.sort ?? 0 } as Parameters<typeof FieldRenderer>[0]['field']}
                            value={editState?.draft[c.field] ?? null}
                            onChange={(v) => setDraftField(c.field, v)}
                            relations={childRelations}
                            collection={relatedCollection}
                            itemId={id}
                            cascadeFilter={fieldCascadeFilters[c.field]}
                            displayOnly={!isEditing || isPendingDelete}
                          />
                        </div>
                      ) : (
                        <div className='py-0.5 overflow-hidden'>{renderCell(c, displayRow[c.field], row.id != null ? String(row.id) : undefined)}</div>
                      )}
                    </td>
                  )
                })}
                <td className='px-1 py-1 align-middle'>
                  {isEditing && !isPendingDelete ? (
                    <div className='flex items-stretch gap-1' onClick={(e) => e.stopPropagation()}>
                      <button type='button' disabled={saving} onClick={saveEdit}
                        className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'>
                        {saving ? '…' : isPendingMode ? 'Queue' : 'Save'}
                      </button>
                      <button type='button' onClick={cancelEdit}
                        className='rounded px-1.5 h-9 text-slate-400 hover:text-slate-700 text-[11px]'>
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className='flex items-center justify-end gap-0.5'>
                      {isPendingDelete ? (
                        <button type='button' title='Undo delete'
                          onClick={(e) => { e.stopPropagation(); staging?.cancelPendingDelete(relatedCollection, manyField, id) }}
                          className='rounded px-1.5 py-0.5 text-[10px] text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400'>
                          Undo
                        </button>
                      ) : (
                        <>
                          {isPendingEdit && (
                            <button type='button' title='Undo edit'
                              onClick={(e) => { e.stopPropagation(); staging?.cancelPendingEdit(relatedCollection, manyField, id) }}
                              className='rounded p-0.5 text-amber-400 hover:text-amber-600 text-[10px]'>
                              ↩
                            </button>
                          )}
                          {showRowRevisions && (
                            <button type='button' title='Row history'
                              onClick={(e) => { e.stopPropagation(); setHistoryRow(row) }}
                              className='rounded p-0.5 text-slate-300 hover:text-[#00ceff]'>
                              <History className='h-3 w-3' />
                            </button>
                          )}
                          {!readOnly && (
                            <button type='button' onClick={(e) => deleteRow(row, e)}
                              className='rounded p-0.5 text-slate-300 hover:text-red-500'>
                              <X className='h-3 w-3' />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </td>
              </tr>
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
              {isEditing && !isPendingDelete && drawerRelations && drawerRelations.length > 0 && (
                <tr className='border-b border-slate-100 bg-[#f0fbff]/60 dark:bg-nvr-cyan/5'>
                  <td colSpan={nestedColSpan} className='px-3 py-2'>
                    <div className='space-y-2'>
                      {drawerRelations.map((dr) => {
                        const relField = typeof dr === 'string' ? dr : dr.field
                        const relHint = typeof dr === 'string' ? undefined : dr.hint
                        const relMatch = typeof dr === 'string' ? undefined : dr.match
                        const rowData = (editState?.draft ?? displayRow) as Record<string, unknown>
                        const matched = relMatch
                          ? buildMatchedDrawer(relMatch, rowData, parentId, parentDraftCtx?.draft)
                          : null
                        return (
                          <NestedRelationEditor
                            key={relField}
                            parentCollection={relatedCollection}
                            relationField={relField}
                            parentRowId={id}
                            parentDraft={editState?.draft ?? displayRow}
                            hint={relHint}
                            outerGridInvalidateKey={['o2m-rows', relatedCollection, manyField, parentId]}
                            {...(relMatch
                              ? {
                                  matchCollection: relMatch.collection,
                                  matchQuery: matched?.query ?? null,
                                  matchSeed: matched?.seed ?? {}
                                }
                              : isPendingMode ? {
                                  deferred: true,
                                  stagedOps: (editState?.draft[`__nested_ops_${relField}`] as NestedOps | undefined) ?? EMPTY_NESTED_OPS,
                                  onStagedOpsChange: (ops: NestedOps) => setDraftField(`__nested_ops_${relField}`, ops)
                                } : {})}
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

          {/* New row inline */}
          {isEditingNew && (
            <tr className='border-b border-slate-100 bg-[#f0fbff] dark:bg-nvr-cyan/5'>
              {(rowOrderField || isNew || isPendingMode) && <td className='w-6' />}
              {(isNew || isPendingMode) && <td className='px-3 py-1.5' />}
              {effectiveCols.map((c) => {
                if (isSummaryCol(c)) {
                  return (
                    <td key={c.field} className='px-2 py-1 align-top'>
                      <div className='py-0.5 overflow-hidden text-slate-500'>{summaryCellValue(c, editState!.draft, true)}</div>
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
                        {renderCell(c, evalClientFormula(c.computed_formula as string, editState!.draft) ?? null)}
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
                          field={{ ...c, sort: c.sort ?? 0 } as Parameters<typeof FieldRenderer>[0]['field']}
                          value={editState!.draft[c.field] ?? null}
                          onChange={(v) => setDraftField(c.field, v)}
                          relations={childRelations}
                          collection={relatedCollection}
                          itemId='new'
                          cascadeFilter={fieldCascadeFilters[c.field]}
                        />
                      </div>
                    )}
                  </td>
                )
              })}
              <td className='px-1 py-1 align-middle'>
                <div className='flex items-stretch gap-1'>
                  <button type='button' disabled={saving} onClick={saveEdit}
                    className='rounded px-2 h-9 bg-[#00ceff] text-white text-[11px] font-medium hover:brightness-110 disabled:opacity-50'>
                    {saving ? '…' : 'Add'}
                  </button>
                  <button type='button' onClick={cancelEdit}
                    className='rounded px-1.5 h-9 text-slate-400 hover:text-slate-700 text-[11px]'>
                    ✕
                  </button>
                </div>
              </td>
            </tr>
          )}

          {rows.length === 0 && pendingRows.length === 0 && !isEditingNew && (
            <tr>
              <td colSpan={effectiveCols.length + ((isNew || isPendingMode) ? 2 : 1) + (rowOrderField || isNew || isPendingMode ? 1 : 0)} className='px-3 py-14 text-center text-slate-400'>
                {isNew ? 'No pending rows' : 'No rows yet'}
              </td>
            </tr>
          )}

          {/* Addendum view rows */}
          {!isNew && activeView !== 'original' && (() => {
            const entry = addendumO2MEntries.find(e => e.addendumId === activeView)
            const colCount =
              (enableReorder && (rowOrderField || isPendingMode) ? 1 : 0) +
              (showLineNumbers ? 1 : 0) +
              (isPendingMode ? 1 : 0) +
              effectiveCols.length + 1
            if (!entry || entry.rows.length === 0) return (
              <tr>
                <td colSpan={colCount} className='px-3 py-8 text-center text-[11px] text-amber-500'>
                  No proposed rows in this addendum
                </td>
              </tr>
            )
            return entry.rows.map((row, ri) => {
              const origRow = rows.find(r => String(r.id) === String(row.id))
              const isNewRow = !origRow
              const changedFields = new Set(
                isNewRow ? displayCols.map(c => c.field) :
                displayCols.filter(c => String(row[c.field] ?? '') !== String(origRow![c.field] ?? '')).map(c => c.field)
              )
              const rowChanged = isNewRow || changedFields.size > 0
              return (
                <tr key={ri} className={rowChanged ? 'border-b border-amber-100 bg-amber-50/40' : 'border-b border-slate-100'}>
                  {enableReorder && (rowOrderField || isPendingMode) && <td className='w-6' />}
                  {showLineNumbers && <td className={`w-8 px-2 align-middle text-[11px] select-none ${rowChanged ? 'text-amber-400' : 'text-slate-400'}`}>{ri + 1}</td>}
                  {isPendingMode && <td className='w-20' />}
                  {effectiveCols.map((c) => (
                    <td key={c.field} className={`px-2 py-1.5 text-[11px] ${changedFields.has(c.field) ? 'bg-amber-50 text-amber-900' : 'text-slate-700'}`}>
                      {isSummaryCol(c) ? summaryCellContent(c, row) : renderCell(c, row[c.field], row.id != null ? String(row.id) : undefined)}
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
        </tbody>
        {activeView === 'original' && (() => {
          const aggCols = effectiveCols.filter(c => {
            const opts = c.options ? (typeof c.options === 'string' ? (() => { try { return JSON.parse(c.options as string) } catch { return {} } })() : c.options) as Record<string, unknown> : {}
            return !!opts.aggregate
          })
          if (aggCols.length === 0) return null
          const allRows = [
            ...(rows ?? []).filter(r => !pendingDeletes.has(String(r.id))).map(r => {
              const rid = String(r.id)
              const merged = pendingEdits.has(rid) ? { ...r, ...pendingEdits.get(rid) } : r
              return applyComputedFields(merged as Record<string, unknown>)
            }),
            ...pendingRows.map(r => applyComputedFields(r as Record<string, unknown>))
          ]
          return (
            <tfoot>
              <tr className='border-t border-slate-200 bg-slate-50 text-[11px] font-medium text-slate-600'>
                {/* Leading cells must mirror the header exactly: reorder, line #, status */}
                {enableReorder && (rowOrderField || isNew || isPendingMode) && <td />}
                {showLineNumbers && <td />}
                {(isNew || isPendingMode) && <td />}
                {effectiveCols.map(c => {
                  const opts = c.options ? (typeof c.options === 'string' ? (() => { try { return JSON.parse(c.options as string) } catch { return {} } })() : c.options) as Record<string, unknown> : {}
                  const agg = opts.aggregate as string | undefined
                  if (!agg) return <td key={c.field} className='px-3 py-1.5' />
                  const nums = allRows.map(r => Number(r[c.field])).filter(n => !Number.isNaN(n))
                  let result: number | null = null
                  if (agg === 'count') result = allRows.length
                  else if (nums.length > 0) {
                    if (agg === 'sum') result = nums.reduce((a, b) => a + b, 0)
                    else if (agg === 'avg') result = nums.reduce((a, b) => a + b, 0) / nums.length
                    else if (agg === 'min') result = Math.min(...nums)
                    else if (agg === 'max') result = Math.max(...nums)
                  }
                  const fmt = opts.format as string | undefined
                  let display = result === null ? '—' : (() => {
                    try {
                      if (fmt === 'currency') return new Intl.NumberFormat(undefined, { style: 'currency', currency: (opts.currency as string) || 'USD' }).format(result)
                      if (fmt === 'decimal') { const p = typeof opts.precision === 'number' ? opts.precision : 2; return new Intl.NumberFormat(undefined, { minimumFractionDigits: p, maximumFractionDigits: p }).format(result) }
                      if (fmt === 'int' || agg === 'count') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(result)
                      return agg === 'avg' ? result.toFixed(2) : String(result)
                    } catch { return String(result) }
                  })()
                  return (
                    <td key={c.field} className='px-3 py-1.5'>
                      <span className='text-slate-400 text-[10px] font-mono mr-1'>{agg.toUpperCase()}</span>
                      <span className='tabular-nums'>{display}</span>
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
        <div className='border-t border-red-100 bg-red-50 px-3 py-1.5 text-[11px] text-red-600'>
          {uniqueError}
        </div>
      )}
      {activeView === 'original' && !isEditingNew && !readOnly && (
        <div className='border-t border-slate-100 px-3 py-1.5'>
          <button type='button' onClick={startNew}
            className='text-[11px] font-medium text-[#00ceff] hover:underline'>
            + Add row
          </button>
        </div>
      )}

      {showRowRevisions && (() => {
        // Merge server results + local state; local fills the gap before server catches up
        const serverIds = new Set(serverDeletedRows.map(r => String(r.item)))
        const localOnly = deletedRows.filter(dr => !pendingDeletes.has(String(dr.id)) && !serverIds.has(String(dr.id)))
        const allDeleted: Array<{ id: string; data: Record<string, unknown> }> = [
          ...serverDeletedRows.map(r => ({ id: r.item, data: r.data })),
          ...localOnly.map(dr => ({ id: String(dr.id), data: dr }))
        ]
        if (allDeleted.length === 0) return null
        return (
          <DeletedRowsSection
            deletedRows={allDeleted}
            displayCols={displayCols}
            onOpenHistory={(id, data) => setHistoryRow({ id, ...data })}
          />
        )
      })()}
    </div>

    <Sheet open={fieldRestoreOpen} onOpenChange={setFieldRestoreOpen}>
      <SheetContent className='w-[420px] sm:max-w-[420px] overflow-y-auto'>
        <SheetHeader>
          <SheetTitle className='text-[14px]'>Field history</SheetTitle>
        </SheetHeader>
        <div className='mt-4 space-y-3'>
          {fieldSnapshotsLoading ? (
            <div className='py-6 text-center'><Loader2 className='h-4 w-4 animate-spin inline text-slate-400' /></div>
          ) : fieldSnapshotGroups.length === 0 ? (
            <p className='py-6 text-center text-[12px] text-slate-400'>No history for this field</p>
          ) : (
            fieldSnapshotGroups.map((group, i) => {
              const creates = group.entries.filter(e => e.action === 'create').length
              const updates = group.entries.filter(e => e.action === 'update').length
              const deletes = group.entries.filter(e => e.action === 'delete').length
              const parts: string[] = []
              if (creates) parts.push(`${creates} added`)
              if (updates) parts.push(`${updates} updated`)
              if (deletes) parts.push(`${deletes} removed`)
              return (
                <div key={i} className='rounded-lg border border-slate-200 p-3'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='text-[11px] font-medium text-slate-600'>{group.user}</span>
                    <span className='text-[10px] text-slate-400'>{formatRelative(group.timestamp)}</span>
                  </div>
                  {parts.length > 0 && (
                    <p className='mt-1 text-[10px] text-slate-500'>{parts.join(', ')}</p>
                  )}
                  <button
                    type='button'
                    disabled={fieldRestoring}
                    onClick={() => restoreFieldAt(group.timestamp)}
                    className='mt-2 rounded border border-[#00ceff]/40 px-2 py-0.5 text-[10px] font-medium text-[#00ceff] hover:bg-[#00ceff]/10 disabled:opacity-40'
                  >
                    {fieldRestoring ? 'Restoring…' : 'Restore to this state'}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </SheetContent>
    </Sheet>

    <Sheet open={!!historyRow} onOpenChange={(o) => !o && setHistoryRow(null)}>
      <SheetContent className='w-[420px] sm:max-w-[420px] overflow-y-auto'>
        <SheetHeader>
          <SheetTitle className='text-[14px]'>Row history</SheetTitle>
        </SheetHeader>
        <div className='mt-4 space-y-3'>
          {revLoading ? (
            <div className='py-6 text-center'><Loader2 className='h-4 w-4 animate-spin inline text-slate-400' /></div>
          ) : rowRevisions.length === 0 ? (
            <p className='py-6 text-center text-[12px] text-slate-400'>No history for this row</p>
          ) : (
            rowRevisions.map((rev) => {
              const who = [rev.first_name, rev.last_name].filter(Boolean).join(' ') || rev.user_email || 'System'
              const changes = rev.delta ?? rev.data ?? {}
              return (
                <div key={rev.id} className='rounded-lg border border-slate-200 p-3'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='text-[11px] font-medium text-slate-600'>{who}</span>
                    <span className='text-[10px] text-slate-400'>{rev.timestamp ? formatRelative(rev.timestamp) : ''}</span>
                  </div>
                  {rev.action && <span className='mt-0.5 inline-block text-[10px] font-medium uppercase tracking-wide text-slate-400'>{rev.action}</span>}
                  <div className='mt-2 space-y-1'>
                    {Object.entries(changes).map(([k, v]) => (
                      <div key={k} className='flex items-start gap-2 text-[11px]'>
                        <span className='shrink-0 font-medium text-slate-500'>{titleCase(k)}:</span>
                        <span className='break-words text-slate-700'>
                          {v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                  {allowRevisionRestore && rev.data && (
                    <button
                      type='button'
                      onClick={() => {
                        setEditState({ rowId: String(historyRow!.id), draft: { ...(rev.data as Record<string, unknown>) } })
                        setHistoryRow(null)
                      }}
                      className='mt-2 rounded border border-[#00ceff]/40 px-2 py-0.5 text-[10px] font-medium text-[#00ceff] hover:bg-[#00ceff]/10'
                    >
                      Restore to this version
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
    </div>
  )
}
