import type { ImportParseResponse, ImportTemplateSummary } from '@nivaro/sdk'
import { RecordLiveSync } from './item-edit/RecordLiveSync'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clipboard,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileDown,
  Loader2,
  Save,
  Trash2,
  Wrench
} from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import {
  GridFlushContext,
  type GridFlushContextValue,
  ItemEditAuthContext,
  ParentDraftContext,
  ReimportHandlerContext,
  RelationPathDataContext,
  StaleFieldReportContext,
  useApiFetchConfig,
  useNivaroClient
} from '../context'
import { createPortal } from 'react-dom'
import { del, get, patch, post } from '../lib/commands'
import { cn, formatRelative, choiceLabel, titleCase } from '../lib/utils'
import { applyValidationRule } from '../lib/validation-rules'
import { ImportFromFileButton } from './import/ImportFromFileButton'
import { ImportIssuesPanel } from './import/ImportIssuesPanel'
import { diffReimportLines, type ReimportLineDiff } from './import/reimportDiff'
import {
  AddendumFieldContext,
  type AddendumFieldMap,
  AddendumO2MContext,
  type AddendumO2MMap,
  AddendumViewContext
} from './item-edit/AddendumFieldContext'
import { useAutoIdPreview } from './item-edit/AutoIdPreviewField'
import {
  type ChangeReasonChallenge,
  ChangeReasonDialog,
  changeReasonChallenge
} from './item-edit/ChangeReasonDialog'
import { CloneDialog } from './item-edit/CloneDialog'
import { HeaderTools } from './item-edit/HeaderTools'
import { FieldRow } from './item-edit/FieldRow'
import { LayoutContentBlock } from './item-edit/LayoutContentBlock'
import {
  GroupSection,
  InlineDisplay,
  OwnersInline,
  OwnersInlineCompact,
  StripFieldValue
} from './item-edit/GroupSection'
import {
  type CascadeRule,
  applyDisplayTemplate,
  isSentinelKey,
  parseJson,
  resolveColSpan,
  SENTINEL_FIELDS,
  SYSTEM_FIELDS,
  useContainerWidth
} from './item-edit/helpers'
import { evalClientFormula } from './item-edit/InlineTableField'
import { computeLiveRollup, parseRollupSources } from './item-edit/live-rollups'
import { m2aWriteMeta } from './item-edit/M2MCombobox'
import { M2MStagingContext, type M2MStagingCtx } from './item-edit/M2MStagingContext'
import {
  LiveRowsContext,
  type LiveRowsCtx,
  O2MStagingContext,
  type O2MStagingCtx,
  StagedRelationsContext,
  type StagedRelationsCtx,
  type StagedRelOps
} from './item-edit/O2MStagingContext'
import { RawEditSheet } from './item-edit/RawEditSheet'
import { RecordChatActions } from './item-edit/RecordChatActions'
import { RecordRecapStrip } from './item-edit/RecordRecapStrip'
import { RecordIntegrityBanner } from './panels/RecordIntegrityBanner'
import { SlaBreachBanner } from './panels/SlaBreachBanner'
import { RecordSubscribeButton } from './item-edit/RecordSubscribeButton'
import { RecordInsightsButton, invalidateRecordInsights } from './item-edit/RecordInsights'
import { setFiscalStartMonth } from '../lib/fiscal'
import { setFormulaConstants } from '../lib/expression'
import { extSlotKey } from '../lib/layout-slots'
import { ExtLayoutSlot } from './item-edit/ExtLayoutSlot'

let formulaCtxHydrated = false
import { FindInRecordButton, type FindableField } from './item-edit/FindInRecord'
import { RecordViewersChip } from './item-edit/RecordViewersChip'
import { StepsBar } from './item-edit/StepsBar'
import { SummaryPanel } from './item-edit/SummaryPanel'
import type {
  ActiveLayoutData,
  CMSField,
  CMSRelation,
  FieldGroup,
  NestedOps,
  RenderFieldProps,
  SlotAssignment,
  StepDef,
  SummaryAggConfig,
  SummaryEntry
} from './item-edit/types'
import {
  AccessDeniedPanel,
  AddendumPanel,
  CommentPanel,
  ExternalRequestsChip,
  ItemActionButtons,
  CustomActionButtons,
  ItemLockBanner,
  OwnersSlot,
  PipelinePanel,
  PipelineTransitionButtons,
  RelatedRecordsPanel,
  ReferencedByPanel,
  RevisionsPanel,
  TaskPanel,
  useItemLock,
  WorkflowPanel
} from './panels'
import type { PendingTask } from './panels/TaskPanel'
import { TipLayer } from './TipLayer'
import { Button } from './ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { Skeleton } from './ui/skeleton'
import { type InputBinding, WidgetSlot } from './WidgetSlot'

function parseSummaryFields(raw: string[] | string | null | undefined): SummaryEntry[] | undefined {
  if (!raw) return undefined
  if (Array.isArray(raw)) return raw as SummaryEntry[]
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SummaryEntry[]) : undefined
  } catch {
    return undefined
  }
}

function summaryEntryKey(e: SummaryEntry): string {
  return typeof e === 'string' ? e : e.field
}

// ─── Re-import helpers (pure) ───────────────────────────────────────────────
// Mirrors the match-key normalization in reimportDiff.ts — used here only to
// re-associate a MATCHED line (changed or unchanged) with its nested __o2m_
// payload, which diffReimportLines intentionally drops from its output.

function reimportMatchKey(row: Record<string, unknown>, matchBy: string[]): string {
  return matchBy
    .map((col) => {
      const trimmed = String(row[col] ?? '').trim()
      if (trimmed !== '') {
        const num = Number(trimmed)
        if (Number.isFinite(num)) return String(num)
      }
      return trimmed
    })
    .join('\x00')
}

function buildReimportFileRows(result: ImportParseResponse): Record<string, unknown>[] {
  return result.lines.map((line) => ({
    ...line.values,
    ...(line.nested
      ? {
          [result.nested_relation ? `__o2m_${line.nested.field}` : line.nested.field]:
            line.nested.rows
        }
      : {})
  }))
}

/** attach_file_field rides on the raw template row (formatTemplate spreads the
 *  full DB row) but isn't declared on the trimmed ImportTemplateSummary type. */
function reimportAttachField(template: ImportTemplateSummary): string | null {
  const raw = (template as unknown as { attach_file_field?: unknown }).attach_file_field
  return typeof raw === 'string' && raw ? raw : null
}

// ─── GridContainer — measures its own width for responsive col spans ──────────

function GridContainer({ children }: { children: (containerWidth: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const containerWidth = useContainerWidth(ref)
  return (
    <div ref={ref} className='grid grid-cols-12 gap-4 items-start'>
      {children(containerWidth)}
    </div>
  )
}

// ─── Save progress dialog ──────────────────────────────────────────────────────

type SaveStepStatus = 'pending' | 'running' | 'done' | 'error'
interface SaveStepItem {
  id: string
  label: string
  status: SaveStepStatus
  detail?: string
  progress?: { done: number; total: number }
  error?: string
}

function SaveStepIcon({ status }: { status: SaveStepStatus }) {
  if (status === 'running')
    return <Loader2 className='h-4 w-4 animate-spin text-[#00ceff] shrink-0' />
  if (status === 'done') return <Check className='h-4 w-4 text-green-500 shrink-0' />
  if (status === 'error') return <AlertCircle className='h-4 w-4 text-red-500 shrink-0' />
  return <div className='h-4 w-4 rounded-full border-2 border-slate-200 shrink-0' />
}

function SaveProgressDialog({
  open,
  steps,
  onClose
}: {
  open: boolean
  steps: SaveStepItem[]
  onClose: () => void
}) {
  const allSettled =
    steps.length > 0 && steps.every((s) => s.status === 'done' || s.status === 'error')
  const hasError = steps.some((s) => s.status === 'error')
  // A failed step aborts the rest, so the steps after it stay 'pending' and
  // never settle — which used to mean the dialog offered no way out at exactly
  // the moment it was reporting a failure. An error IS an end state.
  const canClose = allSettled || hasError
  const doneCount = steps.filter((s) => s.status === 'done').length
  const totalCount = steps.length
  const overallPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && canClose) onClose()
      }}
    >
      <DialogContent
        // Clicking away mid-save would hide work still in flight; once it can
        // be closed, every normal escape (outside click, Escape, the X) works.
        onInteractOutside={(e) => {
          if (!canClose) e.preventDefault()
        }}
        className='max-w-md'
      >
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-[15px]'>
            {!allSettled && <Loader2 className='h-4 w-4 animate-spin text-[#00ceff]' />}
            {allSettled && hasError && <AlertCircle className='h-4 w-4 text-red-500' />}
            {allSettled && !hasError && <Check className='h-4 w-4 text-green-500' />}
            {hasError ? 'Saved with errors' : allSettled ? 'All changes saved' : 'Saving changes…'}
          </DialogTitle>
          <div className='flex items-center gap-3 pt-1'>
            <div className='flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden'>
              <div
                className='h-full rounded-full bg-[#00ceff] transition-all duration-500'
                style={{ width: `${overallPct}%` }}
              />
            </div>
            <span className='text-[11px] text-slate-400 tabular-nums shrink-0'>
              {doneCount}/{totalCount}
            </span>
          </div>
        </DialogHeader>
        <DialogBody>
          <div className='space-y-2'>
            {steps.map((step) => {
              const rowPct =
                step.progress && step.progress.total > 0
                  ? Math.round((step.progress.done / step.progress.total) * 100)
                  : null
              return (
                <div
                  key={step.id}
                  className={cn(
                    'rounded-lg border px-3 py-2.5 transition-colors duration-200',
                    step.status === 'running' && 'border-[#00ceff]/30 bg-[#00ceff]/5',
                    step.status === 'done' && 'border-green-100 bg-green-50/40',
                    step.status === 'error' && 'border-red-200 bg-red-50',
                    step.status === 'pending' && 'border-slate-100 bg-slate-50/60'
                  )}
                >
                  <div className='flex items-start gap-2.5'>
                    <div className='mt-0.5 shrink-0'>
                      <SaveStepIcon status={step.status} />
                    </div>
                    <div className='flex-1 min-w-0'>
                      <div className='flex items-center justify-between gap-2'>
                        <span
                          className={cn(
                            'text-[13px] font-medium leading-snug',
                            step.status === 'done' && 'text-slate-400',
                            step.status === 'error' && 'text-red-700',
                            step.status === 'running' && 'text-slate-900',
                            step.status === 'pending' && 'text-slate-500'
                          )}
                        >
                          {step.label}
                        </span>
                        {hasError && step.status === 'pending' && (
                          <span className='shrink-0 text-[10px] text-slate-400'>not run</span>
                        )}
                        {step.progress && (
                          <span className='text-[11px] text-slate-400 shrink-0 tabular-nums font-mono'>
                            {step.progress.done}/{step.progress.total}
                          </span>
                        )}
                      </div>
                      {step.detail && !step.error && (
                        <p className='text-[11px] text-slate-400 mt-0.5 leading-snug'>
                          {step.detail}
                        </p>
                      )}
                      {step.error && (
                        <p className='text-[11px] text-red-500 mt-0.5 break-words leading-snug'>
                          {step.error}
                        </p>
                      )}
                      {step.status === 'running' && rowPct !== null && (
                        <div className='mt-1.5 h-1 rounded-full bg-slate-200 overflow-hidden'>
                          <div
                            className='h-full rounded-full bg-[#00ceff] transition-all duration-200'
                            style={{ width: `${rowPct}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </DialogBody>
        {canClose && (
          <DialogFooter>
            <button
              type='button'
              onClick={onClose}
              className='text-sm px-4 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors'
            >
              {hasError ? 'Close' : 'Done'}
            </button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── Public types ──────────────────────────────────────────────────────────────

export { M2MStagingContext, useM2MStaging } from './item-edit/M2MStagingContext'
export type { M2MStagingCtx, RenderFieldProps }

export interface ItemEditFormProps {
  collection: string
  itemId?: string
  layoutSlug?: string
  onBack?: () => void
  onSaved?: (id: string) => void
  onDeleted?: () => void
  showHeader?: boolean
  /** Render extension-registered item actions (Push to Fusion etc.) in the
   *  header toolbar. Off by default — the admin's ItemEdit page renders its
   *  own copy in the page header; headless hosts opt in. */
  showItemActions?: boolean
  /** Scroll to + flash a field on load (deep links: ?focus=<field>). */
  focusField?: string | null
  /**
   * When set, a Duplicate button renders on saved records. Receives the full
   * copy payload — scalar/M2O values, M2M link id arrays (keyed by staging
   * key, ready for initialLinks), and O2M child rows (keyed
   * `<child>.<fk>`, ready for initialRows). The host stores it (sessionStorage
   * — too big for a URL) and navigates to its new-record route.
   */
  /** Fires whenever the form's dirty state flips — lets a host (workspace
   *  tabs, close guards) track unsaved edits without reaching inside. */
  onDirtyChange?: (dirty: boolean) => void
  /** false = skip the document.title side effect — a workspace-tab host keeps
   *  several forms mounted and only the ACTIVE one may own the browser tab. */
  documentTitle?: boolean
  /** Hands the host a stable save trigger (workspace "Save all"); called with
   *  null on unmount. The trigger runs the same handleSave the button does —
   *  validation and dialogs included. */
  registerSaveHandler?: (fn: (() => void) | null) => void
  onDuplicate?: (payload: {
    values: Record<string, unknown>
    links: Record<string, unknown[]>
    rows: Record<string, Array<Record<string, unknown>>>
  }) => void
  showRevisions?: boolean
  showClone?: boolean
  showPipeline?: boolean
  showWorkflow?: boolean
  showComments?: boolean
  showTasks?: boolean
  showLockBanner?: boolean
  className?: string
  headerClassName?: string
  renderField?: (props: RenderFieldProps) => ReactNode
  extraTopContent?: ReactNode
  extraBottomContent?: ReactNode
  onHeaderWidgets?: (widgets: HeaderWidgetInfo[]) => void
  /** Consumed once, on mount, when `isNew` — prefills the draft + stages O2M
   *  lines from an already-parsed import result (e.g. handed off by a caller
   *  that ran the file picker before this form existed). */
  initialImportResult?: ImportParseResponse
  /** Consumed once, on mount, when `isNew` — seeds the draft with plain field
   *  values (deep-link prefill, "create from common values", AI hand-offs).
   *  User edits made before the seed applies win over seeded keys. */
  initialValues?: Record<string, unknown>
  /** Seed staged m2m links on a NEW record, keyed
   *  `<junction collection>.<junction field>` — the same staging key the save
   *  path resolves. initialValues cannot express these: m2m links are held
   *  outside the draft, so a caller deep-linking a prefilled record (generate
   *  a workflow from a PO, say) has no other way to hand them over. */
  initialLinks?: Record<string, unknown[]>
  /** Seed staged child rows on a NEW record, keyed
   *  `<child collection>.<foreign key field>`. Same reason as initialLinks:
   *  o2m rows are queued outside the draft, so a caller generating a record
   *  from another one (workflow lines from a purchase order's lines) cannot
   *  hand them over through initialValues. */
  initialRows?: Record<string, Array<Record<string, unknown>>>
}

export interface HeaderWidgetInfo {
  field: string
  widgetId: number
  label: string | null
  inputBindings: InputBinding[]
}

function formatHeaderFieldValue(value: unknown, format: string): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  const num = Number(value)
  if (format === 'currency')
    return isNaN(num)
      ? String(value)
      : new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2
        }).format(num)
  if (format === 'integer')
    return isNaN(num) ? String(value) : new Intl.NumberFormat().format(Math.round(num))
  if (format === 'decimal')
    return isNaN(num)
      ? String(value)
      : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(num)
  if (format === 'percent')
    return isNaN(num)
      ? String(value)
      : new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(
          num / 100
        )
  if (format === 'date') {
    try {
      return new Date(String(value)).toLocaleDateString()
    } catch {
      return String(value)
    }
  }
  if (format === 'datetime') {
    try {
      return new Date(String(value)).toLocaleString()
    } catch {
      return String(value)
    }
  }
  return String(value)
}

// ─── Field diff helper ─────────────────────────────────────────────────────────

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  // String/number coercion — server often returns "1" for numeric columns
  if (
    (typeof a === 'string' && typeof b === 'number') ||
    (typeof a === 'number' && typeof b === 'string')
  ) {
    return String(a) === String(b)
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

// ─── Layout default values ──────────────────────────────────────────────────────

// Fills only the keys a new-record draft doesn't already have a set value
// for (absent, null, or undefined) — 0/false/'' count as set and are left
// alone. Tolerates a null/undefined defaults object.
export function applyLayoutDefaults(
  draft: Record<string, unknown>,
  defaults: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!defaults) return draft
  const next = { ...draft }
  for (const [key, value] of Object.entries(defaults)) {
    if (next[key] === undefined || next[key] === null) next[key] = value
  }
  return next
}

// ─── Dynamic field rules (in-form cascading auto-fill) ──────────────────────────
// See docs/superpowers/specs/2026-07-20-dynamic-field-rules-design.md §3.

export interface FieldRule {
  id: number | string
  collection: string
  trigger_field: string
  target_field: string
  is_active: boolean | number
}

// Active rules that fire when `field` changes. `is_active` may come back as a
// bit column (0/1) rather than a boolean, so both are accepted.
export function rulesForTriggerField(
  rules: FieldRule[] | null | undefined,
  field: string
): FieldRule[] {
  if (!rules) return []
  return rules.filter(
    (r) => r.trigger_field === field && (r.is_active === true || r.is_active === 1)
  )
}

// Merges /field-rules/evaluate results into a draft. Returned values overwrite
// (the only-when-empty decision already happened server-side against the
// draft snapshot that was sent). Tolerates a null/empty results object.
export function mergeRuleResults(
  draft: Record<string, unknown>,
  results: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!results || Object.keys(results).length === 0) return draft
  return { ...draft, ...results }
}

// M2M alias fields (e.g. `divisions`) never live in the draft — they commit
// through M2MStagingContext instead — so field rules that trigger on or
// target one need to resolve the field name to its M2M relation. Mirrors
// FieldRow's m2mRelForField resolution: a relation row can carry
// junction_field directly, or need its companion relation (same junction
// table) to supply it.
export interface M2MAliasInfo {
  manyCollection: string
  manyField: string
  junctionField: string
  stagingKey: string
}

export function resolveM2MAlias(
  relations: CMSRelation[] | null | undefined,
  collection: string,
  field: string
): M2MAliasInfo | null {
  const rels = relations ?? []
  const r = rels.find((rel) => rel.one_collection === collection && rel.one_field === field)
  if (!r?.many_collection || !r.many_field) return null
  let junctionField = r.junction_field
  if (!junctionField) {
    const companion = rels.find((c) => c.many_collection === r.many_collection && c.id !== r.id)
    junctionField = companion?.many_field ?? null
  }
  if (!junctionField) return null
  return {
    manyCollection: r.many_collection,
    manyField: r.many_field,
    junctionField,
    stagingKey: r.one_field ?? `${r.many_collection}.${junctionField}`
  }
}

// Effective (post-staging) related-id set for an M2M alias field — committed
// junction rows minus staged unlinks, plus staged links. Matches
// M2MCombobox's allSelectedIds derivation exactly, so trigger values and
// only-when-empty target snapshots agree with what's rendered.
export function computeM2MEffectiveIds(
  junctionItems: Record<string, unknown>[] | null | undefined,
  junctionField: string,
  stagedLinks: unknown[] | null | undefined,
  stagedUnlinks: Set<unknown> | null | undefined
): string[] {
  const unlinks = stagedUnlinks ?? new Set()
  const committed = (junctionItems ?? [])
    .filter((ji) => !unlinks.has(ji.id))
    .map((ji) => String(ji[junctionField]))
  const staged = (stagedLinks ?? []).map(String)
  return [...new Set([...committed, ...staged])]
}

// Appends `id` to `existing` unless an id string-equal to it is already
// present. Returns `existing` unchanged (same reference) when it's a no-op,
// so a setState updater built on this can bail out without a wasted
// re-render. This is the actual dedup guarantee for staged M2M links —
// every stageLink call goes through it, so no caller (rule-staging or
// otherwise) can ever produce a duplicate entry for the same field.
export function appendUniqueM2MId(existing: unknown[], id: unknown): unknown[] {
  if (existing.some((x) => String(x) === String(id))) return existing
  return [...existing, id]
}

// Filters `returnedIds` down to the ones not already in `liveEffectiveIds`.
// Used at field-rule apply time so two overlapping /field-rules/evaluate
// responses (e.g. from two rapid trigger changes) each stage only what the
// OTHER hasn't already staged by the time they run — `liveEffectiveIds`
// should come from current state read at call time, not a value captured
// when the request was fired.
export function idsNeedingStaging(
  returnedIds: unknown[],
  liveEffectiveIds: string[] | null | undefined
): unknown[] {
  const current = new Set((liveEffectiveIds ?? []).map(String))
  return returnedIds.filter((id) => !current.has(String(id)))
}

// An M2M alias field's committed junction rows load asynchronously (the
// query is shared with M2MCombobox, but on an existing record it may not
// have settled yet by the time a rule fires). Reporting [] in that window
// would misrepresent "unknown" as "genuinely empty" — wrongly making
// only_when_empty targets look fillable, or wrongly making already-committed
// target ids look unselected (and so get re-staged as duplicates). New
// records never have committed rows to wait for (`queryEnabled` is false),
// so they're always "known" and behave exactly as before.
export interface M2MFieldState {
  known: boolean
  ids: string[]
}

export function resolveM2MFieldState(
  queryEnabled: boolean,
  querySettled: boolean,
  junctionItems: Record<string, unknown>[] | null | undefined,
  junctionField: string,
  stagedLinks: unknown[] | null | undefined,
  stagedUnlinks: Set<unknown> | null | undefined
): M2MFieldState {
  if (queryEnabled && !querySettled) return { known: false, ids: [] }
  return {
    known: true,
    ids: computeM2MEffectiveIds(junctionItems, junctionField, stagedLinks, stagedUnlinks)
  }
}

// Drops alias targets whose committed-selection state is still unknown from
// a partitioned result set — applying them (merge or stage) would either
// falsely fill an already-populated target or duplicate-stage an
// already-committed id. The rule gets another chance on the next trigger
// fire, by which point the query has almost always settled.
export function dropUnsettledAliasResults(
  alias: Record<string, unknown[]>,
  fieldStates: Record<string, M2MFieldState | undefined>
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const [field, ids] of Object.entries(alias)) {
    if (fieldStates[field]?.known) out[field] = ids
  }
  return out
}

// Splits /field-rules/evaluate results into scalar targets (merged into the
// draft, unchanged path) and M2M-alias targets (staged as links instead —
// alias fields don't exist in the draft). `aliasFields` is the set of target
// field names that resolveM2MAlias identified as M2M aliases.
export function partitionRuleResults(
  results: Record<string, unknown> | null | undefined,
  aliasFields: Set<string> | null | undefined
): { scalar: Record<string, unknown>; alias: Record<string, unknown[]> } {
  const scalar: Record<string, unknown> = {}
  const alias: Record<string, unknown[]> = {}
  if (!results) return { scalar, alias }
  const aliasSet = aliasFields ?? new Set<string>()
  for (const [field, value] of Object.entries(results)) {
    if (aliasSet.has(field)) {
      alias[field] = Array.isArray(value) ? value : value != null ? [value] : []
    } else {
      scalar[field] = value
    }
  }
  return { scalar, alias }
}

// ─── ItemEditForm ──────────────────────────────────────────────────────────────

export function ItemEditForm({
  collection,
  itemId: itemIdProp,
  layoutSlug,
  onBack,
  onSaved,
  onDeleted,
  showHeader = true,
  focusField,
  showItemActions = false,
  onDirtyChange,
  documentTitle = true,
  registerSaveHandler,
  onDuplicate,
  showRevisions = true,
  showClone = true,
  showPipeline = true,
  showWorkflow = true,
  showComments = true,
  showTasks = true,
  showLockBanner = true,
  className,
  headerClassName,
  renderField,
  extraTopContent,
  extraBottomContent,
  onHeaderWidgets,
  initialImportResult,
  initialValues,
  initialLinks,
  initialRows
}: ItemEditFormProps) {
  const client = useNivaroClient()
  const fetchCfg = useApiFetchConfig()
  const { isAdmin, userId: authUserId } = useContext(ItemEditAuthContext)
  const qc = useQueryClient()
  const itemId = itemIdProp ?? 'new'
  const isNew = !itemIdProp || itemIdProp === 'new'

  // ── Data fetching ──────────────────────────────────────────────────────────
  const { data: activeLayoutData } = useQuery<ActiveLayoutData | null>({
    queryKey: ['active-layout', collection, layoutSlug ?? null, itemId],
    queryFn: () =>
      client
        .request<{ data: ActiveLayoutData | null }>(
          get('/collection-layouts/active', {
            collection,
            ...(layoutSlug ? { slug: layoutSlug } : itemId !== 'new' ? { item: itemId } : {})
          })
        )
        .then((r) => r.data)
        .catch(() => null),
    staleTime: 60_000
  })

  const layoutId = activeLayoutData?.layout?.id ?? null

  const {
    data: fieldConfig,
    isLoading: fieldsLoading,
    isFetched: fieldConfigFetched
  } = useQuery<CMSField[]>({
    queryKey: ['field-config', collection, layoutId],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(
          get(`/field-config/${collection}`, layoutId ? { layout_id: String(layoutId) } : undefined)
        )
        .then((r) => r.data ?? []),
    staleTime: 60_000,
    // Wait for the layout either way, not just when a slug pins one. Without
    // this the field config fetched immediately with layoutId = null — the
    // LAYOUT-LESS default field set — painted that, then refetched under a new
    // key once the layout arrived: a visible flash of the wrong form on the
    // way to the right one. `catch(() => null)` on the layout query means it
    // always settles, so this cannot hang; undefined is strictly "still
    // asking".
    enabled: activeLayoutData !== undefined
  })

  const { data: relations = [], isFetched: relationsFetched } = useQuery<CMSRelation[]>({
    queryKey: ['relations', collection],
    queryFn: () =>
      client
        .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => r.data ?? []),
    staleTime: 60_000
  })

  // Dynamic field rules (cascading auto-fill) — fetched once per collection.
  // When empty, handleFieldChange's rulesForTriggerField lookup always
  // returns [], so no listeners/timers/requests are ever set up.
  const { data: fieldRules = [] } = useQuery<FieldRule[]>({
    queryKey: ['field-rules', collection],
    queryFn: () =>
      client
        .request<{ data: FieldRule[] }>(get('/field-rules', { collection }))
        .then((r) => r.data ?? []),
    enabled: !!collection,
    staleTime: 60_000
  })

  const { data: colMeta } = useQuery<{
    display_name?: string
    singular?: string | null
    display_template?: string | null
    item_locking_enabled?: boolean
    addendums_enabled?: boolean
    addendum_allowed_roles?: string | null
    addendum_allowed_states?: string | null
  }>({
    queryKey: ['col-meta', collection],
    queryFn: () =>
      client
        .request<{
          data: {
            display_name?: string
            singular?: string | null
            display_template?: string | null
            item_locking_enabled?: boolean
            addendums_enabled?: boolean
            addendum_allowed_roles?: string | null
            addendum_allowed_states?: string | null
          }
        }>(get(`/collections/${collection}`))
        .then((r) => r.data),
    staleTime: 60_000
  })

  const { data: fileLayouts = [] } = useQuery<
    Array<{ id: number; name: string; pdf_button_label?: string | null }>
  >({
    queryKey: ['file-layouts', collection],
    queryFn: () =>
      client
        .request<{
          data: Array<{
            id: number
            name: string
            layout_type?: string
            is_active?: boolean | number
            pdf_button_label?: string | null
          }>
        }>(get('/collection-layouts', { collection, type: 'file' }))
        // The list route ignores the type param — filter here or every layout
        // on the collection would grow a PDF button. Inactive file layouts get
        // no header button (that's how a PDF export is retired).
        .then((r) => (r.data ?? []).filter((l) => l.layout_type === 'file' && !!l.is_active)),
    enabled: !!collection && !isNew,
    staleTime: 60_000
  })

  const [headerWidgetTypes, setHeaderWidgetTypes] = useState<Record<string, string>>({})

  const [pdfLoading, setPdfLoading] = useState<number | null>(null)
  const [showPdfDropdown, setShowPdfDropdown] = useState(false)
  const [pdfAttaching, setPdfAttaching] = useState(false)
  const [activeAddendumCount, setActiveAddendumCount] = useState(0)
  const [addendumViewId, setAddendumViewId] = useState<string>('original')
  const [addendumViewDropdownOpen, setAddendumViewDropdownOpen] = useState(false)

  const downloadPdf = useCallback(
    async (layoutId: number) => {
      if (!itemId || !collection) return
      setPdfLoading(layoutId)
      setShowPdfDropdown(false)
      try {
        const workspace =
          typeof window !== 'undefined' ? (localStorage.getItem('nivaro_workspace') ?? '') : ''
        const resp = await fetch(
          `${fetchCfg.apiBase}/collection-layouts/${layoutId}/generate-pdf`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...fetchCfg.authHeaders,
              ...(workspace ? { 'x-workspace': workspace } : {})
            },
            credentials: fetchCfg.credentials,
            body: JSON.stringify({ collection, item_id: itemId })
          }
        )
        if (!resp.ok) throw new Error(await resp.text())
        const blob = await resp.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${collection}-${itemId}.pdf`
        a.click()
        URL.revokeObjectURL(url)
      } catch {
        toast.error('Failed to generate PDF')
      } finally {
        setPdfLoading(null)
      }
    },
    [collection, itemId]
  )

  useEffect(() => {
    if (!showPdfDropdown) return
    function handleOutside(e: MouseEvent) {
      const target = e.target as Element
      if (!target.closest('[data-pdf-dropdown]')) setShowPdfDropdown(false)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [showPdfDropdown])

  const {
    data: itemData,
    isLoading: itemLoading,
    error: itemLoadError
  } = useQuery<Record<string, unknown>>({
    queryKey: ['item', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${itemId}`))
        .then((r) => r.data),
    enabled: !isNew,
    staleTime: 30_000,
    // 403/404 are access verdicts, not transient — retrying just delays the
    // AccessDeniedPanel explanation.
    retry: (failureCount, err) => {
      const status =
        (err as { status?: number; response?: { status?: number } })?.status ??
        (err as { response?: { status?: number } })?.response?.status
      if (status === 403 || status === 404) return false
      return failureCount < 2
    }
  })
  const itemLoadDenied = (() => {
    if (isNew || !itemLoadError) return false
    const status =
      (itemLoadError as { status?: number; response?: { status?: number } })?.status ??
      (itemLoadError as { response?: { status?: number } })?.response?.status
    return status === 403 || status === 404
  })()

  // ── Draft state ────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  // Synchronous mirror of draft — the save payload reads from this so that
  // grid-flush callbacks firing onChange mid-save still land in the PATCH.
  const draftRef = useRef<Record<string, unknown>>({})
  // Fields the user actually edited this session (drives cascade auto-clear)
  const userTouchedRef = useRef<Set<string>>(new Set())

  // ── Grid flush registry ────────────────────────────────────────────────────
  // Field components (file pickers, inline grids) register async commit
  // callbacks here; saveMut awaits them all before building the main payload.
  // Provided only for existing items — new records keep the staging flow.
  const gridFlushersRef = useRef<Map<string, () => Promise<void>>>(new Map())
  const gridFlushCtx = useMemo<GridFlushContextValue>(
    () => ({
      register: (key, fn) => {
        gridFlushersRef.current.set(key, fn)
      },
      unregister: (key) => {
        gridFlushersRef.current.delete(key)
      }
    }),
    []
  )
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  // Change-reason challenge: a 422 from the items service pauses the save
  // until the user supplies a justification, then retries with _change_reason
  const [crChallenge, setCrChallenge] = useState<ChangeReasonChallenge | null>(null)
  const [rawEditOpen, setRawEditOpen] = useState(false)
  const changeReasonRef = useRef<string | null>(null)
  // Mid-air collision: a 409 pauses the save into a per-field merge dialog
  // (their value vs yours); resolving retries against the newer revision.
  const [collision, setCollision] = useState<{
    conflicts: Array<{ field: string; current_value: unknown }>
    latest: number
    mine: Record<string, unknown>
  } | null>(null)
  const baseRevisionOverrideRef = useRef<number | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  useEffect(() => {
    onDirtyChange?.(isDirty)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callback identity is the host's concern
  }, [isDirty])
  const [justSaved, setJustSaved] = useState(false)

  // Cross-field writes from structured interfaces (range/date-range end
  // fields, geocoded lat/lng — PolishFields.setSiblingField). Routed through
  // handleFieldChange so rules/visibility/dirty state apply.
  useEffect(() => {
    const onSet = (e: Event) => {
      const d = (e as CustomEvent).detail as { field?: string; value?: unknown }
      if (d?.field) handleFieldChange(d.field, d.value ?? null)
    }
    window.addEventListener('nvr:set-field', onSet)
    return () => window.removeEventListener('nvr:set-field', onSet)
  })
  // Config hot-push (#268): a schema/layout edit anywhere re-resolves this
  // form's definition in place and shows an "updated" chip — no stale form
  // until reload, no forced reload either (the draft is untouched).
  const [configUpdated, setConfigUpdated] = useState(false)
  useEffect(() => {
    const onConfig = () => {
      void qc.invalidateQueries({ queryKey: ['field-config'] })
      void qc.invalidateQueries({ queryKey: ['active-layout'] })
      void qc.invalidateQueries({ queryKey: ['collection-meta'] })
      setConfigUpdated(true)
      setTimeout(() => setConfigUpdated(false), 8000)
    }
    window.addEventListener('nvr:config-update', onConfig)
    return () => window.removeEventListener('nvr:config-update', onConfig)
  }, [qc])
  // Condensing header (#321): long forms shrink the header to a mini-bar
  // (title + state + save) once the body scrolls past ~90px.
  const [headerCondensed, setHeaderCondensed] = useState(false)
  const condenseOnScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const top = (e.target as HTMLDivElement).scrollTop
    setHeaderCondensed((prev) => (prev ? top > 40 : top > 110))
  }, [])

  // The revision this draft is BASED on — the collision check's baseline.
  const { data: baseRevisionData } = useQuery<{ latest: number | null }>({
    queryKey: ['collision-base', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: { latest: number | null } }>(
          get('/revisions', { collection, item: itemId, latest_only: '1' })
        )
        .then((r) => r.data)
        .catch(() => ({ latest: null })),
    enabled: !isNew && !!itemId,
    staleTime: 60_000
  })

  // ── Save progress dialog ───────────────────────────────────────────────────
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveSteps, setSaveSteps] = useState<SaveStepItem[]>([])
  function updateStep(
    id: string,
    upd: Partial<SaveStepItem> | ((prev: SaveStepItem) => Partial<SaveStepItem>)
  ) {
    setSaveSteps((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s
        const changes = typeof upd === 'function' ? upd(s) : upd
        return { ...s, ...changes }
      })
    )
  }
  function getO2MLabel(key: string): string {
    const [rc] = key.split('.')
    const rel = relations.find(
      (r) => r.many_collection === rc && r.one_collection === collection && !r.junction_field
    )
    if (rel?.one_field) {
      const f = allFields.find((af) => af.field === rel.one_field)
      return f?.label ?? titleCase(rel.one_field)
    }
    return titleCase(rc)
  }
  const initialDataRef = useRef<Record<string, unknown>>({})
  const touchedFields = useRef<Set<string>>(new Set())

  const [copiedHeaderField, setCopiedHeaderField] = useState<string | null>(null)

  // ── Pending comments (new records) ────────────────────────────────────────
  const [pendingComments, setPendingComments] = useState<string[]>([])
  const handleQueueComment = useCallback((text: string) => {
    setPendingComments((prev) => [...prev, text])
  }, [])

  // ── Pending tasks (new records) ────────────────────────────────────────────
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([])
  const handleQueueTask = useCallback((task: PendingTask) => {
    setPendingTasks((prev) => [...prev, task])
  }, [])

  // ── Pending O2M rows (new records) ─────────────────────────────────────────
  const [pendingO2MRows, setPendingO2MRows] = useState<Map<string, Record<string, unknown>[]>>(
    new Map()
  )
  // Pending edits/deletes for existing rows (saveMode='pending')
  const [pendingO2MEdits, setPendingO2MEdits] = useState<
    Map<string, Map<string, Record<string, unknown>>>
  >(new Map())
  const [pendingO2MDeletes, setPendingO2MDeletes] = useState<Map<string, Set<string>>>(new Map())

  const o2mStagingCtx = useMemo<O2MStagingCtx>(
    () => ({
      getPendingRows: (rc, mf) => pendingO2MRows.get(`${rc}.${mf}`) ?? [],
      queueRow: (rc, mf, data) =>
        setPendingO2MRows((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          next.set(key, [...(next.get(key) ?? []), data])
          return next
        }),
      removeRow: (rc, mf, idx) =>
        setPendingO2MRows((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const arr = [...(next.get(key) ?? [])]
          arr.splice(idx, 1)
          next.set(key, arr)
          return next
        }),
      updateRow: (rc, mf, idx, data) =>
        setPendingO2MRows((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const arr = [...(next.get(key) ?? [])]
          arr[idx] = { ...arr[idx], ...data }
          next.set(key, arr)
          return next
        }),
      reorderRows: (rc, mf, fromIdx, toIdx) =>
        setPendingO2MRows((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const arr = [...(next.get(key) ?? [])]
          const [moved] = arr.splice(fromIdx, 1)
          arr.splice(toIdx, 0, moved)
          next.set(key, arr)
          return next
        }),
      getPendingEdits: (rc, mf) => pendingO2MEdits.get(`${rc}.${mf}`) ?? new Map(),
      getPendingDeletes: (rc, mf) => pendingO2MDeletes.get(`${rc}.${mf}`) ?? new Set(),
      queueEdit: (rc, mf, rowId, changes) =>
        setPendingO2MEdits((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const edits = new Map(next.get(key) ?? [])
          edits.set(rowId, { ...(edits.get(rowId) ?? {}), ...changes })
          next.set(key, edits)
          return next
        }),
      queueDelete: (rc, mf, rowId) => {
        setPendingO2MDeletes((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const dels = new Set(next.get(key) ?? [])
          dels.add(rowId)
          next.set(key, dels)
          return next
        })
        // Remove any pending edit for this row
        setPendingO2MEdits((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const edits = new Map(next.get(key) ?? [])
          edits.delete(rowId)
          next.set(key, edits)
          return next
        })
      },
      cancelPendingEdit: (rc, mf, rowId) =>
        setPendingO2MEdits((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const edits = new Map(next.get(key) ?? [])
          edits.delete(rowId)
          next.set(key, edits)
          return next
        }),
      cancelPendingDelete: (rc, mf, rowId) =>
        setPendingO2MDeletes((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const dels = new Set(next.get(key) ?? [])
          dels.delete(rowId)
          next.set(key, dels)
          return next
        })
    }),
    [pendingO2MRows, pendingO2MEdits, pendingO2MDeletes]
  )

  // ── Import from file (new records) ─────────────────────────────────────────
  const [importIssues, setImportIssues] = useState<ImportParseResponse['issues']>([])
  const appliedInitialImportRef = useRef(false)
  const appliedLayoutDefaultsRef = useRef(false)

  // ── M2M staging ────────────────────────────────────────────────────────────
  const [m2mLinks, setM2mLinks] = useState<Map<string, unknown[]>>(new Map())
  const [m2mUnlinks, setM2mUnlinks] = useState<Map<string, Set<unknown>>>(new Map())

  // Upstream cross-record defaults for M2M PICKS: staging a link is the
  // alias world's handleFieldChange, so it fires the same evaluator (pick a
  // Region → its Zone fills). Assigned after runCrossDefaults is defined;
  // origin tracking stops a programmatic fill from re-firing itself.
  const crossDefaultsRef = useRef<((field: string, value: unknown, depth?: number) => void) | null>(
    null
  )
  const stagingKeyToFieldRef = useRef<Map<string, string>>(new Map())
  const crossFillInFlightRef = useRef(0)
  // Derived-fill ledger: which links each SOURCE pick auto-staged, so a new
  // pick on the same source REPLACES its old derivations instead of stacking
  // them, and so option filters can ignore self-derived parents.
  const derivedFillsRef = useRef<
    Map<string, Array<{ parent: string; stagingKey: string; ids: string[] }>>
  >(new Map())
  const derivedOriginRef = useRef<Map<string, string>>(new Map())
  const m2mStagingCtx = useMemo<M2MStagingCtx>(
    () => ({
      getStagedLinks: (k) => m2mLinks.get(k) ?? [],
      getStagedUnlinks: (k) => m2mUnlinks.get(k) ?? new Set(),
      getDerivedOrigin: (parentField) => derivedOriginRef.current.get(parentField) ?? null,
      stageLink: (k, id) => {
        setM2mLinks((prev) => {
          const existing = prev.get(k) ?? []
          const next = appendUniqueM2MId(existing, id)
          if (next === existing) return prev
          const nextMap = new Map(prev)
          nextMap.set(k, next)
          return nextMap
        })
        // Only USER picks cascade — links staged by a cross-default fill
        // (crossFillInFlightRef > 0) must not fire another round.
        if (crossFillInFlightRef.current === 0) {
          const field = stagingKeyToFieldRef.current.get(k)
          if (field) {
            crossDefaultsRef.current?.(field, id)
            upstreamCascadesRef.current?.(field, id)
          }
        }
      },
      stageUnlink: (k, jId) =>
        setM2mUnlinks((prev) => {
          const next = new Map(prev)
          const s = new Set(next.get(k))
          s.add(jId)
          next.set(k, s)
          return next
        }),
      unstageLink: (k, id) =>
        setM2mLinks((prev) => {
          const next = new Map(prev)
          next.set(
            k,
            (next.get(k) ?? []).filter((x) => String(x) !== String(id))
          )
          return next
        }),
      unstageUnlink: (k, jId) =>
        setM2mUnlinks((prev) => {
          const next = new Map(prev)
          const s = new Set(next.get(k))
          s.delete(jId)
          next.set(k, s)
          return next
        })
    }),
    [m2mLinks, m2mUnlinks]
  )

  const applyImportResult = useCallback(
    async (result: ImportParseResponse) => {
      draftRef.current = { ...draftRef.current, ...result.values }
      setDraft((prev) => ({ ...prev, ...result.values }))

      const issues = [...result.issues]
      if (result.lines.length > 0) {
        const rel = result.line_target_field
          ? relations.find(
              (r) => r.one_collection === collection && r.one_field === result.line_target_field
            )
          : null
        if (rel?.many_collection && rel.many_field) {
          const lineFieldRow = (fieldConfig ?? []).find((f) => f.field === result.line_target_field)
          const rawOpts = lineFieldRow?.options
          const opts = (
            typeof rawOpts === 'string'
              ? (() => {
                  try {
                    return JSON.parse(rawOpts)
                  } catch {
                    return {}
                  }
                })()
              : (rawOpts ?? {})
          ) as { row_rules?: unknown[]; parent_context_fields?: string[] }
          const rowRules = Array.isArray(opts.row_rules) ? opts.row_rules : []
          if (rowRules.length > 0) {
            const mergedDraft = { ...draftRef.current }
            const parentCtx: Record<string, unknown> = {}
            for (const f of opts.parent_context_fields ?? []) parentCtx[f] = mergedDraft[f] ?? null
            for (const rule of rowRules) {
              const tf = (rule as { trigger_field?: unknown }).trigger_field
              if (typeof tf === 'string' && tf.startsWith('$parent.')) {
                const key = tf.slice(8)
                if (!(key in parentCtx)) parentCtx[key] = mergedDraft[key] ?? null
              }
            }
            // Bounded concurrency (10 at a time) rather than firing every line's
            // evaluate at once — a large import could otherwise open hundreds of
            // simultaneous requests. Failed rows degrade to {} and are surfaced as one
            // aggregate warning so the user knows some autofill didn't run.
            const evaluated: Record<string, unknown>[] = []
            let anyEvalFailed = false
            const EVAL_CHUNK = 10
            for (let i = 0; i < result.lines.length; i += EVAL_CHUNK) {
              const chunk = result.lines.slice(i, i + EVAL_CHUNK)
              const chunkResults = await Promise.all(
                chunk.map((line) =>
                  client
                    .request<{ updates: Record<string, unknown> }>(
                      post('/field-rules/evaluate', {
                        collection: rel.many_collection,
                        data: line.values,
                        parent_context: parentCtx,
                        row_rules: rowRules
                      })
                    )
                    .then((res) => res.updates ?? {})
                    .catch(() => {
                      anyEvalFailed = true
                      return {}
                    })
                )
              )
              evaluated.push(...chunkResults)
            }
            if (anyEvalFailed) {
              issues.push({
                severity: 'warn',
                rule: 'import-apply',
                message:
                  'Some line autofill rules could not be evaluated — check the affected rows before saving.'
              })
            }
            result.lines.forEach((line, i) => {
              line.values = { ...line.values, ...evaluated[i] }
            })
          }
          for (const line of result.lines) {
            o2mStagingCtx.queueRow(rel.many_collection, rel.many_field, {
              ...line.values,
              ...(line.nested
                ? {
                    [result.nested_relation ? `__o2m_${line.nested.field}` : line.nested.field]:
                      line.nested.rows
                  }
                : {})
            })
          }
        } else {
          issues.push({
            severity: 'error',
            rule: 'import-apply',
            message: 'No matching relation found for the imported line items — they were not added.'
          })
        }
      }

      const m2mEntries = Object.entries(result.m2m ?? {})
      for (const [field, ids] of m2mEntries) {
        // Exact one_field match first, then the legacy junction-table-name alias
        // (a field named after the junction collection itself, e.g. 'workflows_files').
        const m2mRel =
          relations.find(
            (r) =>
              r.one_collection === collection && r.one_field === field && r.junction_field != null
          ) ??
          relations.find(
            (r) =>
              r.one_collection === collection &&
              r.many_collection === field &&
              r.junction_field != null
          )
        if (m2mRel) {
          // Stage under the same key the M2M editors use, so the links render in the
          // form and the save flush (findM2MRel) resolves them.
          const stagingKey =
            m2mRel.one_field ?? `${m2mRel.many_collection}.${m2mRel.junction_field}`
          for (const id of ids) m2mStagingCtx.stageLink(stagingKey, id)
        } else {
          issues.push({
            severity: 'error',
            rule: 'import-apply',
            message: `No M2M relation found for "${field}" — the imported selection was not applied.`
          })
        }
      }

      setImportIssues(issues)
    },
    [collection, relations, o2mStagingCtx, m2mStagingCtx, fieldConfig, client]
  )

  // ── Re-import (existing records) ────────────────────────────────────────────
  const [reimportDialog, setReimportDialog] = useState<{
    diff: ReimportLineDiff
    result: ImportParseResponse
    template: ImportTemplateSummary
    existingRows: Record<string, unknown>[]
  } | null>(null)
  const [reimportApplying, setReimportApplying] = useState(false)

  const handleReimportParsed = useCallback(
    async (result: ImportParseResponse, template: ImportTemplateSummary) => {
      const cfg = template.reimport
      if (!cfg) return

      const hasPendingWork =
        isDirty ||
        [...pendingO2MRows.values()].some((rows) => rows.length > 0) ||
        [...pendingO2MEdits.values()].some((edits) => edits.size > 0) ||
        [...pendingO2MDeletes.values()].some((dels) => dels.size > 0)
      if (hasPendingWork) {
        const proceed = window.confirm(
          'Unsaved changes will be combined with the re-import staging. Continue?'
        )
        if (!proceed) return
      }

      const rel = result.line_target_field
        ? relations.find(
            (r) => r.one_collection === collection && r.one_field === result.line_target_field
          )
        : null

      const fileRows = buildReimportFileRows(result)
      let existingRows: Record<string, unknown>[] = []

      if (result.lines.length > 0 && rel?.many_collection && rel.many_field) {
        const cols = new Set<string>(['id', ...cfg.match_by])
        for (const row of fileRows) {
          for (const key of Object.keys(row)) {
            if (!key.startsWith('__o2m_')) cols.add(key)
          }
        }
        try {
          existingRows = await client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${rel.many_collection}`, {
                filter: JSON.stringify({ [rel.many_field]: { _eq: itemId } }),
                fields: [...cols].join(','),
                limit: 2000
              })
            )
            .then((r) => r.data ?? [])
        } catch {
          setImportIssues([
            {
              severity: 'error',
              rule: 'reimport-apply',
              message: "Could not load the record's current lines — nothing was staged."
            }
          ])
          return
        }
      }

      let diff: ReimportLineDiff
      try {
        diff =
          result.lines.length > 0 && rel?.many_collection && rel.many_field
            ? diffReimportLines(fileRows, existingRows, {
                lines: cfg.lines,
                match_by: cfg.match_by
              })
            : { creates: [], updates: [], deletes: [], matchedUnchanged: 0 }
      } catch (err) {
        setImportIssues([
          {
            severity: 'error',
            rule: 'reimport-apply',
            message:
              err instanceof Error ? err.message : 'Duplicate match key in the imported lines.'
          }
        ])
        return
      }

      setImportIssues([])
      setReimportDialog({ diff, result, template, existingRows })
    },
    [
      isDirty,
      pendingO2MRows,
      pendingO2MEdits,
      pendingO2MDeletes,
      relations,
      collection,
      client,
      itemId
    ]
  )

  const applyReimportStaging = useCallback(
    async (
      diff: ReimportLineDiff,
      result: ImportParseResponse,
      template: ImportTemplateSummary,
      existingRows: Record<string, unknown>[]
    ) => {
      const cfg = template.reimport
      if (!cfg) return

      const attachField = reimportAttachField(template)
      const issues = [...result.issues]

      // 2. Header fields per policy.
      if (cfg.header_fields !== 'skip') {
        const merged: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(result.values)) {
          if (attachField && k === attachField) continue
          if (cfg.header_fields === 'overwrite') {
            merged[k] = v
          } else {
            const cur = draftRef.current[k]
            if (cur === null || cur === undefined || cur === '') merged[k] = v
          }
        }
        if (Object.keys(merged).length > 0) {
          draftRef.current = { ...draftRef.current, ...merged }
          setDraft((prev) => ({ ...prev, ...merged }))
        }
      }

      // 3-4. Line diff → staged O2M rows/edits/deletes, plus nested replace-per-line
      // for matched lines whose file row carries nested data.
      const rel = result.line_target_field
        ? relations.find(
            (r) => r.one_collection === collection && r.one_field === result.line_target_field
          )
        : null

      if (rel?.many_collection && rel.many_field) {
        const lineCollection = rel.many_collection
        const lineField = rel.many_field

        // Row-rule autofill on newly-created lines — mirrors the new-record import
        // path in applyImportResult above (same chunked-evaluate idiom) so re-import
        // creates get the same server-evaluated defaults instead of shipping raw file
        // values. Duplicated rather than shared: the two paths evaluate different
        // shapes — result.lines[].values vs. diff.creates, which also carries
        // __o2m_-prefixed nested payloads that must not be sent to the endpoint.
        let creates = diff.creates
        if (creates.length > 0) {
          const lineFieldRow = (fieldConfig ?? []).find((f) => f.field === result.line_target_field)
          const rawOpts = lineFieldRow?.options
          const opts = (
            typeof rawOpts === 'string'
              ? (() => {
                  try {
                    return JSON.parse(rawOpts)
                  } catch {
                    return {}
                  }
                })()
              : (rawOpts ?? {})
          ) as { row_rules?: unknown[]; parent_context_fields?: string[] }
          const rowRules = Array.isArray(opts.row_rules) ? opts.row_rules : []
          if (rowRules.length > 0) {
            const mergedDraft = { ...draftRef.current }
            const parentCtx: Record<string, unknown> = {}
            for (const f of opts.parent_context_fields ?? []) parentCtx[f] = mergedDraft[f] ?? null
            for (const rule of rowRules) {
              const tf = (rule as { trigger_field?: unknown }).trigger_field
              if (typeof tf === 'string' && tf.startsWith('$parent.')) {
                const key = tf.slice(8)
                if (!(key in parentCtx)) parentCtx[key] = mergedDraft[key] ?? null
              }
            }
            // Bounded concurrency (10 at a time) rather than firing every line's
            // evaluate at once — a large import could otherwise open hundreds of
            // simultaneous requests. Failed rows degrade to {} and are surfaced as one
            // aggregate warning so the user knows some autofill didn't run.
            const evaluated: Record<string, unknown>[] = []
            let anyEvalFailed = false
            const EVAL_CHUNK = 10
            for (let i = 0; i < creates.length; i += EVAL_CHUNK) {
              const chunk = creates.slice(i, i + EVAL_CHUNK)
              const chunkResults = await Promise.all(
                chunk.map((row) => {
                  const data = Object.fromEntries(
                    Object.entries(row).filter(([k]) => !k.startsWith('__o2m_'))
                  )
                  return client
                    .request<{ updates: Record<string, unknown> }>(
                      post('/field-rules/evaluate', {
                        collection: lineCollection,
                        data,
                        parent_context: parentCtx,
                        row_rules: rowRules
                      })
                    )
                    .then((res) => res.updates ?? {})
                    .catch(() => {
                      anyEvalFailed = true
                      return {}
                    })
                })
              )
              evaluated.push(...chunkResults)
            }
            if (anyEvalFailed) {
              issues.push({
                severity: 'warn',
                rule: 'reimport-apply',
                message:
                  'Some line autofill rules could not be evaluated — check the affected rows before saving.'
              })
            }
            creates = creates.map((row, i) => ({ ...row, ...evaluated[i] }))
          }
        }

        for (const row of creates) {
          o2mStagingCtx.queueRow(lineCollection, lineField, row)
        }
        for (const upd of diff.updates) {
          o2mStagingCtx.queueEdit(lineCollection, lineField, upd.id, upd.changes)
        }
        for (const id of diff.deletes) {
          o2mStagingCtx.queueDelete(lineCollection, lineField, id)
        }

        if (cfg.lines === 'upsert' || cfg.lines === 'upsert_delete') {
          const fileRows = buildReimportFileRows(result)
          const existingByKey = new Map<string, string>()
          for (const row of existingRows) {
            existingByKey.set(reimportMatchKey(row, cfg.match_by), String(row.id))
          }
          const matchedByField = new Map<
            string,
            { id: string; members: Record<string, unknown>[] }[]
          >()
          for (const row of fileRows) {
            const existingId = existingByKey.get(reimportMatchKey(row, cfg.match_by))
            if (!existingId) continue
            for (const [colKey, val] of Object.entries(row)) {
              if (!colKey.startsWith('__o2m_')) continue
              const field = colKey.slice('__o2m_'.length)
              const arr = matchedByField.get(field) ?? []
              arr.push({
                id: existingId,
                members: Array.isArray(val) ? (val as Record<string, unknown>[]) : []
              })
              matchedByField.set(field, arr)
            }
          }
          for (const [field, entries] of matchedByField) {
            const grandRel = relations.find(
              (r) => r.one_collection === lineCollection && r.one_field === field
            )
            if (!grandRel?.many_collection || !grandRel.many_field) {
              issues.push({
                severity: 'error',
                rule: 'reimport-apply',
                message: `No matching relation found for the nested "${field}" rows — they were not updated.`
              })
              continue
            }
            const grandCollection = grandRel.many_collection
            const grandField = grandRel.many_field
            const lineIds = entries.map((e) => e.id)
            let existingMembers: Record<string, unknown>[] = []
            try {
              existingMembers = await client
                .request<{ data: Record<string, unknown>[] }>(
                  get(`/items/${grandCollection}`, {
                    filter: JSON.stringify({ [grandField]: { _in: lineIds } }),
                    fields: `id,${grandField}`,
                    limit: 2000
                  })
                )
                .then((r) => r.data ?? [])
            } catch {
              issues.push({
                severity: 'error',
                rule: 'reimport-apply',
                message: `Could not load existing "${field}" rows — they were not updated.`
              })
              continue
            }
            const idsByParent = new Map<string, string[]>()
            for (const m of existingMembers) {
              const parentId = String(m[grandField])
              const arr = idsByParent.get(parentId) ?? []
              arr.push(String(m.id))
              idsByParent.set(parentId, arr)
            }
            for (const entry of entries) {
              o2mStagingCtx.queueEdit(lineCollection, lineField, entry.id, {
                [`__nested_ops_${field}`]: {
                  created: entry.members,
                  updated: [],
                  deleted: idsByParent.get(entry.id) ?? []
                }
              })
            }
          }
        }
      } else if (result.lines.length > 0) {
        issues.push({
          severity: 'error',
          rule: 'reimport-apply',
          message: 'No matching relation found for the imported line items — they were not added.'
        })
      }

      // 5. Attachment staging per policy, plus any other M2M alias fields (additive,
      // same idiom as the new-record import path).
      const findM2mAliasRel = (field: string) =>
        relations.find(
          (r) =>
            r.one_collection === collection && r.one_field === field && r.junction_field != null
        ) ??
        relations.find(
          (r) =>
            r.one_collection === collection &&
            r.many_collection === field &&
            r.junction_field != null
        )

      if (attachField && result.file_id) {
        const attachRel = findM2mAliasRel(attachField)
        if (attachRel) {
          const stagingKey =
            attachRel.one_field ?? `${attachRel.many_collection}.${attachRel.junction_field}`
          if (cfg.attachments === 'replace' && attachRel.many_collection && attachRel.many_field) {
            try {
              const junctionRows = await client
                .request<{ data: Record<string, unknown>[] }>(
                  get(`/items/${attachRel.many_collection}`, {
                    filter: JSON.stringify({ [attachRel.many_field]: { _eq: itemId } }),
                    fields: 'id',
                    limit: 2000
                  })
                )
                .then((r) => r.data ?? [])
              for (const jr of junctionRows) m2mStagingCtx.stageUnlink(stagingKey, jr.id)
            } catch {
              issues.push({
                severity: 'error',
                rule: 'reimport-apply',
                message:
                  'Could not load the existing attachment to replace it — the new file was linked alongside it.'
              })
            }
          }
          m2mStagingCtx.stageLink(stagingKey, result.file_id)
        } else {
          draftRef.current = { ...draftRef.current, [attachField]: result.file_id }
          setDraft((prev) => ({ ...prev, [attachField]: result.file_id }))
        }
      }

      for (const [field, ids] of Object.entries(result.m2m ?? {})) {
        if (attachField && field === attachField) continue
        const m2mRel = findM2mAliasRel(field)
        if (m2mRel) {
          const stagingKey =
            m2mRel.one_field ?? `${m2mRel.many_collection}.${m2mRel.junction_field}`
          // Existing record: only stage values not already linked, or the save
          // flush would insert duplicate junction rows (e.g. a second 2026
          // funding-year link on every re-import).
          let existing = new Set<string>()
          try {
            const junctionRows = await client
              .request<{ data: Record<string, unknown>[] }>(
                get(`/items/${m2mRel.many_collection}`, {
                  filter: JSON.stringify({ [String(m2mRel.many_field)]: { _eq: itemId } }),
                  fields: `id,${m2mRel.junction_field}`,
                  limit: 2000
                })
              )
              .then((r) => r.data ?? [])
            existing = new Set(
              junctionRows.map((jr) => String(jr[m2mRel.junction_field as string]))
            )
          } catch {
            // fetch failure: fall through and stage everything (worst case a
            // duplicate link, same as the pre-fix behavior)
          }
          for (const id of ids) {
            if (!existing.has(String(id))) m2mStagingCtx.stageLink(stagingKey, id)
          }
        } else {
          issues.push({
            severity: 'error',
            rule: 'reimport-apply',
            message: `No M2M relation found for "${field}" — the imported selection was not applied.`
          })
        }
      }

      // 6. Summary issue.
      issues.push({
        severity: 'warn',
        rule: 'reimport-apply',
        message: `Re-import: ${diff.updates.length} updates · ${diff.creates.length} new · ${diff.deletes.length} deletes · ${diff.matchedUnchanged} unchanged`
      })

      setImportIssues(issues)
    },
    [collection, relations, o2mStagingCtx, m2mStagingCtx, client, itemId, fieldConfig]
  )

  // One-shot plain-value prefill for new records (deep links, "create from
  // common values", AI hand-offs). Keys the user already edited win.
  const appliedInitialValuesRef = useRef(false)
  useEffect(() => {
    if (
      !isNew ||
      (!initialValues && !initialLinks && !initialRows) ||
      appliedInitialValuesRef.current
    )
      return
    appliedInitialValuesRef.current = true
    if (initialValues) {
      setDraft((d) => ({ ...initialValues, ...d }))
      draftRef.current = { ...initialValues, ...draftRef.current }
    }
    if (initialLinks) {
      // Staged like any user-made selection, so the fields render populated and
      // the normal save path writes the junction rows.
      setM2mLinks((prev) => {
        const next = new Map(prev)
        for (const [key, ids] of Object.entries(initialLinks)) {
          if (!next.has(key) && ids.length) next.set(key, [...ids])
        }
        return next
      })
    }
    if (initialRows) {
      // Queued like rows the user added by hand, so the grid renders them and
      // the normal save path writes them against the new record's id.
      setPendingO2MRows((prev) => {
        const next = new Map(prev)
        for (const [key, rows] of Object.entries(initialRows)) {
          if (!next.has(key) && rows.length) next.set(key, [...rows])
        }
        return next
      })
    }
    setIsDirty(true)
  }, [isNew, initialValues, initialLinks, initialRows])

  useEffect(() => {
    if (!isNew || !initialImportResult || appliedInitialImportRef.current) return
    const needsRelations =
      initialImportResult.lines.length > 0 || Object.keys(initialImportResult.m2m ?? {}).length > 0
    if (needsRelations && !relationsFetched) return
    // Line row-rules read fieldConfig (options.row_rules) — wait for that query too, or
    // an early apply would evaluate against an empty field config and skip the rules.
    if (initialImportResult.lines.length > 0 && !fieldConfigFetched) return
    appliedInitialImportRef.current = true
    void applyImportResult(initialImportResult)
  }, [isNew, initialImportResult, relationsFetched, fieldConfigFetched, applyImportResult])

  useEffect(() => {
    if (itemData) {
      initialDataRef.current = itemData
      draftRef.current = itemData
      setDraft(itemData)
      setIsDirty(false)
    }
  }, [itemData])

  // New records: stamp the resolved layout's default_values onto the draft,
  // once, filling only keys the draft doesn't already have a value for.
  // Array values whose key is an M2M alias stage junction links instead —
  // the pickers read staged links, never a draft array.
  useEffect(() => {
    if (!isNew || activeLayoutData === undefined || appliedLayoutDefaultsRef.current) return
    const defaults = activeLayoutData?.layout?.default_values
    if (!defaults) {
      appliedLayoutDefaultsRef.current = true
      return
    }
    // An alias default can't resolve until relations arrive — wait, don't burn
    // the once-only flag on a pass that would drop it.
    if (Object.values(defaults).some(Array.isArray) && !relationsFetched) return
    appliedLayoutDefaultsRef.current = true
    const scalar: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(defaults)) {
      if (Array.isArray(value)) {
        const m2mRel =
          relations.find(
            (r) =>
              r.one_collection === collection && r.one_field === key && r.junction_field != null
          ) ??
          relations.find(
            (r) =>
              r.one_collection === collection &&
              r.many_collection === key &&
              r.junction_field != null
          )
        if (m2mRel) {
          const stagingKey =
            m2mRel.one_field ?? `${m2mRel.many_collection}.${m2mRel.junction_field}`
          for (const id of value) m2mStagingCtx.stageLink(stagingKey, id)
          continue
        }
      }
      scalar[key] = value
    }
    const next = applyLayoutDefaults(draftRef.current, scalar)
    draftRef.current = next
    setDraft(next)
  }, [isNew, activeLayoutData, relations, relationsFetched, collection, m2mStagingCtx])

  // Relation-path fields ('purchase_order.workflow.workflow_id'): read-only
  // values reached through M2O hops, resolved server-side in one batched call
  // and merged into the draft for display. Excluded from saves via readonly.
  const relationPathFields = useMemo(
    () =>
      (fieldConfig ?? [])
        .filter((f) => f.interface === 'relation-path' && f.field.includes('.'))
        .map((f) => f.field),
    [fieldConfig]
  )
  const { data: resolvedPaths } = useQuery<
    Record<string, { value: string; ids: string[]; target_collection: string | null }>
  >({
    queryKey: ['resolve-paths', collection, itemId, relationPathFields.join(',')],
    queryFn: () =>
      client
        .request<{
          data: Record<string, { value: string; ids: string[]; target_collection: string | null }>
        }>(
          get(`/items/${collection}/${itemId}/resolve-paths`, {
            paths: relationPathFields.join(',')
          })
        )
        .then((r) => r.data ?? {}),
    enabled: !isNew && relationPathFields.length > 0,
    staleTime: 30_000
  })
  const relationPathData = useMemo(() => {
    if (!resolvedPaths) return null
    const out: Record<string, { ids: string[]; target_collection: string | null }> = {}
    for (const [path, pv] of Object.entries(resolvedPaths)) {
      out[path] = { ids: pv.ids, target_collection: pv.target_collection }
    }
    return out
  }, [resolvedPaths])
  useEffect(() => {
    if (!resolvedPaths) return
    const merged: Record<string, unknown> = {}
    for (const [path, pv] of Object.entries(resolvedPaths)) merged[path] = pv.value
    if (Object.keys(merged).length === 0) return
    initialDataRef.current = { ...initialDataRef.current, ...merged }
    draftRef.current = { ...draftRef.current, ...merged }
    setDraft((prev) => ({ ...prev, ...merged }))
  }, [resolvedPaths])

  // M2M alias fields referenced by any active rule (trigger or target side) —
  // resolved once so both the trigger-side staging watcher and the
  // target-side result dispatcher share the same relation lookups.
  const m2mAliasFieldsForRules = useMemo(() => {
    const activeRules = fieldRules.filter((r) => r.is_active === true || r.is_active === 1)
    const fields = new Set<string>()
    for (const r of activeRules) {
      fields.add(r.trigger_field)
      fields.add(r.target_field)
    }
    // Also track EVERY M2M alias on the collection — their effective id sets
    // feed ParentDraftContext so '$parent.<alias>' option-filter tokens (e.g.
    // funding_years) resolve, not just rule trigger/target fields.
    for (const r of relations) {
      if (r.junction_field && r.one_collection === collection && r.one_field) {
        fields.add(r.one_field)
      }
    }
    const map = new Map<string, M2MAliasInfo>()
    for (const f of fields) {
      const info = resolveM2MAlias(relations, collection, f)
      if (info) map.set(f, info)
    }
    return map
  }, [fieldRules, relations, collection])

  // Committed junction rows for those alias relations, fetched with the exact
  // same queryKey/queryFn M2MCombobox uses — react-query dedupes against
  // whatever the mounted combobox has already fetched rather than issuing a
  // second request.
  const m2mAliasRelationList = [...m2mAliasFieldsForRules.values()]
  const m2mAliasCommittedResults = useQueries({
    queries: m2mAliasRelationList.map((info) => ({
      queryKey: ['m2m-items', info.manyCollection, info.manyField, itemId],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${info.manyCollection}`, {
              filter: JSON.stringify({ [info.manyField]: { _eq: itemId } }),
              limit: 200,
              fields: `id,${info.junctionField}`
            })
          )
          .then((r) => r.data ?? []),
      enabled: !!itemId && !isNew,
      staleTime: 30_000
    }))
  })
  // Per alias field: whether its committed-selection state is known yet
  // (false only while an existing record's junction query is still in
  // flight) and, if known, the current effective id set.
  const m2mAliasFieldStates = useMemo(() => {
    const out: Record<string, M2MFieldState> = {}
    ;[...m2mAliasFieldsForRules.entries()].forEach(([field, info], i) => {
      const q = m2mAliasCommittedResults[i]
      out[field] = resolveM2MFieldState(
        !!itemId && !isNew,
        q?.isSuccess ?? false,
        q?.data,
        info.junctionField,
        m2mLinks.get(info.stagingKey),
        m2mUnlinks.get(info.stagingKey)
      )
    })
    return out
  }, [m2mAliasFieldsForRules, m2mAliasCommittedResults, m2mLinks, m2mUnlinks, itemId, isNew])

  // Kept in sync every render (not gated by a dependency list) so an async
  // callback whose closure was captured before this render — e.g. an
  // in-flight /field-rules/evaluate response fired by an earlier trigger
  // change — can still read the truly current effective-id set when it
  // eventually runs, rather than whatever was true when its own request was
  // sent. Two overlapping evaluate responses (two rapid trigger changes)
  // otherwise both see an empty "already staged" set and would try to stage
  // the same returned ids twice.
  const m2mAliasFieldStatesRef = useRef(m2mAliasFieldStates)
  m2mAliasFieldStatesRef.current = m2mAliasFieldStates
  stagingKeyToFieldRef.current = new Map(
    [...m2mAliasFieldsForRules.entries()].map(([f, info]) => [info.stagingKey, f])
  )

  // undefined = not an alias field (existing scalar/M2O behavior unaffected).
  // An alias field's ids default to [] while unknown — callers that need to
  // tell "unknown" apart from "genuinely empty" must check m2mAliasFieldStates
  // (or isM2MFieldKnown) directly rather than trusting an empty array here.
  const getM2MEffectiveIds = useCallback(
    (field: string): string[] | undefined => m2mAliasFieldStates[field]?.ids,
    [m2mAliasFieldStates]
  )
  const isM2MFieldKnown = useCallback(
    (field: string): boolean => m2mAliasFieldStates[field]?.known ?? true,
    [m2mAliasFieldStates]
  )

  // Draft exposed via ParentDraftContext: scalar draft + every M2M alias
  // field's effective id array (committed ± staged). Unsettled aliases are
  // omitted, so '$parent.<alias>' tokens prune their clause instead of
  // filtering on a stale empty set.
  // Layout-effective labels for every field — 'division' renders as 'Zone'
  // when the layout overrides it; child grids naming parent fields consume
  // this through ParentDraftContext.
  const parentFieldLabels = useMemo(() => {
    const out: Record<string, string> = {}
    for (const f of fieldConfig ?? []) if (f.label) out[f.field] = f.label
    return out
  }, [fieldConfig])

  // Effective option_filter per field (layout overrides already merged into
  // fieldConfig.options) — cascading children read these to inherit an unset
  // parent's own option curation. Raw (token-unresolved); consumers resolve.
  const parentFieldOptionFilters = useMemo(() => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const f of fieldConfig ?? []) {
      const opts = parseJson<{ option_filter?: Record<string, unknown> }>(f.options)
      if (opts?.option_filter && typeof opts.option_filter === 'object')
        out[f.field] = opts.option_filter
    }
    return out
  }, [fieldConfig])

  const parentDraftWithAliases = useMemo(() => {
    const merged: Record<string, unknown> = { ...draft }
    for (const [field, state] of Object.entries(m2mAliasFieldStates)) {
      if (state?.known && state.ids.length > 0) merged[field] = state.ids
    }
    return merged
  }, [draft, m2mAliasFieldStates])

  // Dispatches /field-rules/evaluate results: scalar targets merge into the
  // draft as before; M2M-alias targets (which don't exist in the draft) are
  // staged as links instead, skipping ids that are already effectively
  // selected so re-triggering a satisfied rule is a no-op. Alias targets
  // whose committed state hasn't settled yet are dropped entirely rather
  // than applied against a possibly-stale effective set — the rule gets
  // another chance on the next trigger fire.
  // Cross-record defaults evaluator — fired for USER edits (handleFieldChange)
  // and for FKs set by field rules (applyFieldRuleResults), so a rule-driven
  // cascade (e.g. unit pick → install_location) still autofills its targets.

  // Upstream cascades (`upstream: true` on a cascade rule): a pick on the
  // rule's own field resolves filter_column on the PICKED record and fills
  // parent_field from it — the cascade run in reverse. Shares the origin
  // guard with cross-record defaults so a programmatic fill can't re-fire.
  // Undo everything a previous pick on `source` derived: unstage its links
  // and clear origin markers, so a NEW pick replaces rather than stacks.
  const undoDerivedFills = useCallback(
    (source: string) => {
      const entries = derivedFillsRef.current.get(source)
      if (!entries) return
      crossFillInFlightRef.current += 1
      try {
        for (const e of entries) {
          for (const id of e.ids) m2mStagingCtx.unstageLink(e.stagingKey, id)
          if (derivedOriginRef.current.get(e.parent) === source)
            derivedOriginRef.current.delete(e.parent)
        }
      } finally {
        crossFillInFlightRef.current -= 1
      }
      derivedFillsRef.current.delete(source)
    },
    [m2mStagingCtx]
  )
  const recordDerivedFill = useCallback((source: string, parent: string, stagingKey: string, ids: string[]) => {
    if (ids.length === 0) return
    const list = derivedFillsRef.current.get(source) ?? []
    list.push({ parent, stagingKey, ids })
    derivedFillsRef.current.set(source, list)
    derivedOriginRef.current.set(parent, source)
  }, [])

  const runUpstreamCascades = useCallback(
    (field: string, pickedId: unknown, depth = 0, seen?: Set<string>, rootSource?: string) => {
      if (pickedId === null || pickedId === undefined || pickedId === '') return
      // Chains all the way up (shipping location → region → zone), capped and
      // cycle-guarded so a config loop can't ping-pong.
      if (depth > 3) return
      const root = rootSource ?? field
      // A fresh pick REPLACES the previous pick's derivations (changing the
      // region must swap the derived zone, not add a second one).
      if (depth === 0) undoDerivedFills(root)
      const chainSeen = seen ?? new Set<string>()
      const seenKey = `${field}:${String(pickedId)}`
      if (chainSeen.has(seenKey)) return
      chainSeen.add(seenKey)
      const fc = (fieldConfig ?? []).find((f) => f.field === field)
      if (!fc?.dependency_config) return
      let rules: CascadeRule[] = []
      try {
        const cfg = (
          typeof fc.dependency_config === 'string'
            ? JSON.parse(fc.dependency_config)
            : fc.dependency_config
        ) as { cascade_filters?: CascadeRule[] }
        rules = (cfg.cascade_filters ?? []).filter((r) => r.upstream && r.parent_field)
      } catch {
        return
      }
      if (rules.length === 0) return
      // The picked record's collection: M2O target, or the alias companion.
      const m2oRel = relations.find(
        (r) => r.many_collection === collection && r.many_field === field && !r.junction_field
      )
      let pickedCollection = m2oRel?.one_collection ?? null
      if (!pickedCollection) {
        const aliasInfo = m2mAliasFieldsForRules.get(field)
        if (aliasInfo) {
          const companion = relations.find(
            (r) =>
              r.many_collection === aliasInfo.manyCollection &&
              r.many_field === aliasInfo.junctionField
          )
          pickedCollection = (companion?.one_collection as string | null) ?? null
        }
      }
      if (!pickedCollection) return
      void (async () => {
        let pickedRels: CMSRelation[] | null = null
        for (const rule of rules) {
          try {
            const col = String(rule.filter_column)
            let values: string[] = []
            if (col.includes('.')) {
              // 'regions.regions_id' — first hop is an alias on the picked
              // record's collection, leaf a junction/child column.
              const [aliasName, leaf] = [col.slice(0, col.indexOf('.')), col.slice(col.indexOf('.') + 1)]
              pickedRels ??= await client
                .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${pickedCollection}`))
                .then((r) => r.data ?? [])
                .catch(() => [])
              const aliasRel = pickedRels.find(
                (r) => r.one_collection === pickedCollection && r.one_field === aliasName
              )
              if (!aliasRel?.many_collection || !aliasRel.many_field) continue
              const rows = await client
                .request<{ data: Record<string, unknown>[] }>(
                  get(`/items/${aliasRel.many_collection}`, {
                    filter: JSON.stringify({ [aliasRel.many_field]: { _eq: pickedId } }),
                    limit: 200,
                    fields: `id,${leaf.split('.')[0]}`
                  })
                )
                .then((r) => r.data ?? [])
                .catch(() => [])
              values = rows
                .map((row) => row[leaf.split('.')[0]])
                .filter((v) => v != null)
                .map((v) => String(v))
            } else {
              // A bare column may itself be an ALIAS on the picked collection
              // (filter_is_m2m rules store 'project_types', not a dotted
              // path) — resolve via its junction; the pairing-marker
              // junction_field IS the related-id column.
              pickedRels ??= await client
                .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${pickedCollection}`))
                .then((r) => r.data ?? [])
                .catch(() => [])
              const bareAlias = pickedRels.find(
                (r) => r.one_collection === pickedCollection && r.one_field === col && r.junction_field
              )
              if (bareAlias?.many_collection && bareAlias.many_field) {
                const rows = await client
                  .request<{ data: Record<string, unknown>[] }>(
                    get(`/items/${bareAlias.many_collection}`, {
                      filter: JSON.stringify({ [bareAlias.many_field]: { _eq: pickedId } }),
                      limit: 200,
                      fields: `id,${bareAlias.junction_field}`
                    })
                  )
                  .then((r) => r.data ?? [])
                  .catch(() => [])
                values = rows
                  .map((row) => row[bareAlias.junction_field as string])
                  .filter((v) => v != null)
                  .map((v) => String(v))
              } else {
                const row = await client
                  .request<{ data: Record<string, unknown> }>(
                    get(`/items/${pickedCollection}/${String(pickedId)}`, { fields: `id,${col}` })
                  )
                  .then((r) => r.data)
                  .catch(() => null)
                const v = row?.[col]
                if (v != null && v !== '') values = [String(v)]
              }
            }
            values = [...new Set(values)]
            if (values.length === 0) continue
            const parent = rule.parent_field
            if (m2mAliasFieldsForRules.has(parent)) {
              const info = m2mAliasFieldsForRules.get(parent)!
              const already = new Set(
                (m2mAliasFieldStatesRef.current[parent]?.ids ?? []).map((x) => String(x))
              )
              // Fill only EMPTY parents: a set parent already agreed with this
              // pick (the option filter guaranteed compatibility) — stacking
              // the picked record's OTHER links on top replaces the user's
              // explicit choice (the CDO → BSO bug). Ledgered derivations were
              // undone above, so a re-pick still re-derives.
              if (already.size > 0) continue
              const parentMeta = (fieldConfig ?? []).find((f) => f.field === parent)
              const maxVals = parseJson<{ max_values?: number | null }>(parentMeta?.options ?? null)
                ?.max_values
              // More values than the field allows = ambiguous, fill nothing
              // (a 5-region project cannot answer a single-region field).
              if (maxVals != null && values.length > maxVals) continue
              const stagedNow: string[] = []
              crossFillInFlightRef.current += 1
              try {
                for (const v of values) {
                  if (already.has(v)) continue
                  m2mStagingCtx.stageLink(info.stagingKey, v)
                  stagedNow.push(v)
                }
              } finally {
                crossFillInFlightRef.current -= 1
              }
              recordDerivedFill(root, parent, info.stagingKey, stagedNow)
              // Chain: the filled parent may have its own upstream rule
              // (region → zone). Explicit recursion, not the stageLink hook —
              // the origin guard stays intact for user-pick detection.
              for (const v of values)
                upstreamCascadesRef.current?.(parent, v, depth + 1, chainSeen, root)
            } else if (values.length === 1) {
              // Scalar parent: fill only when unambiguous AND empty — a value
              // the user set (or an earlier fill set) already agreed with
              // this pick via the option filter.
              const existing = draftRef.current[parent]
              if (existing !== null && existing !== undefined && existing !== '') continue
              const v = values[0]
              draftRef.current = { ...draftRef.current, [parent]: v }
              setDraft((prev) => ({ ...prev, [parent]: v }))
              setIsDirty(true)
              crossDefaultsRef.current?.(parent, v, 1)
              derivedOriginRef.current.set(parent, root)
              upstreamCascadesRef.current?.(parent, v, depth + 1, chainSeen, root)
            }
          } catch {
            /* one rule failing must not take the rest down */
          }
        }
      })()
    },
    [fieldConfig, relations, collection, m2mAliasFieldsForRules, m2mStagingCtx, client, undoDerivedFills, recordDerivedFill]
  )
  const upstreamCascadesRef = useRef(runUpstreamCascades)
  upstreamCascadesRef.current = runUpstreamCascades

  const runCrossDefaults = useCallback(
    (field: string, value: unknown, depth = 0) => {
      if (value === null || value === undefined || value === '') return
      if (depth > 2) return
      for (const fc of fieldConfig ?? []) {
        const rawCfg = fc.cross_record_defaults
        if (!rawCfg) continue
        type CrossCfg = {
          source_collection?: string
          source_fk_field?: string
          field_map?: Record<string, string>
        }
        let cfg: CrossCfg | null = null
        try {
          cfg = (typeof rawCfg === 'string' ? JSON.parse(rawCfg) : rawCfg) as CrossCfg
        } catch {
          continue
        }
        const fkField = cfg?.source_fk_field || fc.field
        if (fkField !== field || !cfg?.source_collection || !cfg.field_map) continue
        if (depth === 0) undoDerivedFills(field)
        const map = cfg.field_map
        // Alias-mapped source fields must stay OUT of the readOne fields= —
        // readOne 500s on explicit alias selections (documented gotcha);
        // the M2M branch resolves them via junction queries instead.
        const sourceFields = [
          ...new Set(
            Object.entries(map)
              .filter(([target]) => !m2mAliasFieldsForRules.has(target))
              .flatMap(([, v]) =>
                String(v)
                  .split('||')
                  .map((c) => c.trim())
              )
          )
        ].filter(Boolean)
        const hasM2MTargets = Object.keys(map).some((t) => m2mAliasFieldsForRules.has(t))
        if (sourceFields.length === 0 && !hasM2MTargets) continue
        void client
          .request<{ data: Record<string, unknown> }>(
            get(`/items/${cfg.source_collection}/${value}`, {
              fields: sourceFields.length > 0 ? sourceFields.join(',') : 'id'
            })
          )
          // A map naming an alias SOURCE puts an alias in fields=, which
          // readOne rejects — refetch id-only and let the relation branches
          // resolve everything.
          .catch(() =>
            client.request<{ data: Record<string, unknown> }>(
              get(`/items/${cfg.source_collection}/${value}`, { fields: 'id' })
            )
          )
          .then(async (res) => {
            const src = res.data
            if (!src) return
            const patch: Record<string, unknown> = {}
            // Upstream fill covers all four source/target shapes:
            //   scalar → scalar  copy (overwrite — picking is explicit)
            //   scalar → alias   stage the single id as a junction link
            //   alias  → alias   copy the picked record's own links
            //   alias  → scalar  fill ONLY when the source has exactly one
            //                    link (multiple would be a guess)
            // Alias fills are ADDITIVE — a default never unlinks an explicit
            // choice. Best-effort throughout so scalar defaults survive.
            const entryList = Object.entries(map)
            const maybeAliasSources = entryList.some(
              ([target, sourceField]) =>
                m2mAliasFieldsForRules.has(target) || !(String(sourceField).trim() in src)
            )
            let srcRels: CMSRelation[] = []
            if (maybeAliasSources) {
              try {
                srcRels = await client
                  .request<{ data: CMSRelation[] }>(
                    get(`/data-model/relations/for/${cfg.source_collection}`)
                  )
                  .then((r) => r.data ?? [])
              } catch {
                srcRels = []
              }
            }
            const srcAliasFor = (sourceField: string) =>
              srcRels.find(
                (r) =>
                  r.one_collection === cfg!.source_collection &&
                  r.one_field === sourceField &&
                  r.junction_field
              )
            const srcAliasIds = async (rel: CMSRelation): Promise<unknown[]> => {
              const rows = await client
                .request<{ data: Record<string, unknown>[] }>(
                  get(`/items/${rel.many_collection}`, {
                    filter: JSON.stringify({ [rel.many_field as string]: { _eq: value } }),
                    limit: 200,
                    fields: `id,${rel.junction_field}`
                  })
                )
                .then((r) => r.data ?? [])
              return rows.map((jr) => jr[rel.junction_field as string]).filter((x) => x != null)
            }
            const stageInto = (target: string, ids: unknown[]) => {
              const info = m2mAliasFieldsForRules.get(target)
              if (!info) return
              const already = new Set(
                (m2mAliasFieldStatesRef.current[target]?.ids ?? []).map((x) => String(x))
              )
              // Same fill-only-when-empty rule as upstream cascades — a set
              // parent already agreed with this pick.
              if (already.size > 0) return
              const targetMeta = (fieldConfig ?? []).find((f) => f.field === target)
              const maxV = parseJson<{ max_values?: number | null }>(targetMeta?.options ?? null)
                ?.max_values
              if (maxV != null && ids.length > maxV) return
              const stagedNow: string[] = []
              crossFillInFlightRef.current += 1
              try {
                for (const rid of ids) {
                  if (already.has(String(rid))) continue
                  m2mStagingCtx.stageLink(info.stagingKey, rid)
                  stagedNow.push(String(rid))
                }
              } finally {
                crossFillInFlightRef.current -= 1
              }
              recordDerivedFill(field, target, info.stagingKey, stagedNow)
            }
            for (const [target, sourceField] of entryList) {
              const sf = String(sourceField).split('||')[0].trim()
              const targetIsAlias = m2mAliasFieldsForRules.has(target)
              const srcAlias = srcAliasFor(sf)
              if (!targetIsAlias && !srcAlias) continue // plain scalar copy below
              try {
                if (targetIsAlias && srcAlias) {
                  stageInto(target, await srcAliasIds(srcAlias))
                } else if (targetIsAlias) {
                  const v = src[sf]
                  if (v != null && v !== '') stageInto(target, [v])
                } else if (srcAlias) {
                  const ids = await srcAliasIds(srcAlias)
                  if (ids.length === 1) patch[target] = ids[0]
                }
              } catch {
                /* one entry failing must not take down the rest */
              }
            }
            for (const [target, sourceField] of Object.entries(map)) {
              if (m2mAliasFieldsForRules.has(target)) continue
              if (srcAliasFor(String(sourceField).split('||')[0].trim())) continue
              // 'a||b' = first non-null of the listed source fields; 'id'
              // refers to the source record itself (EFP: a location's
              // designated shipping_location, else the location itself).
              const candidates = String(sourceField)
                .split('||')
                .map((c) => c.trim())
              let v: unknown = null
              for (const c of candidates) {
                v = src[c]
                if (v !== null && v !== undefined && v !== '') break
              }
              patch[target] = v ?? null
            }
            draftRef.current = { ...draftRef.current, ...patch }
            setDraft((prev) => ({ ...prev, ...patch }))
            setIsDirty(true)
            // Chain: a target that is itself a watched FK cascades its own
            // defaults (billing location → shipping location → address copy)
            // AND its own upstream cascades (shipping → region → zone).
            // Depth-capped to break config cycles.
            for (const [target, v] of Object.entries(patch)) {
              if (target !== field && v != null && v !== '') {
                runCrossDefaults(target, v, depth + 1)
                upstreamCascadesRef.current?.(target, v, depth + 1)
              }
            }
          })
          .catch(() => {
            /* source record unreadable — leave targets untouched */
          })
      }
    },
    [fieldConfig, client, m2mAliasFieldsForRules, m2mStagingCtx, undoDerivedFills, recordDerivedFill]
  )
  crossDefaultsRef.current = runCrossDefaults

  const applyFieldRuleResults = useCallback(
    (results: Record<string, unknown> | null | undefined) => {
      const { scalar, alias } = partitionRuleResults(
        results,
        new Set(m2mAliasFieldsForRules.keys())
      )
      // Unsettled-guard: checked against the state captured when this
      // response's evaluate cycle started — a target that wasn't known yet
      // simply gets another chance on the next trigger fire.
      const settledAlias = dropUnsettledAliasResults(alias, m2mAliasFieldStates)
      for (const [field, ids] of Object.entries(settledAlias)) {
        const info = m2mAliasFieldsForRules.get(field)
        if (!info) continue
        // Skip-check: read the LIVE ref, not this closure's captured
        // m2mAliasFieldStates — so a response applied after another
        // overlapping one (e.g. from two rapid trigger changes) sees
        // whatever that other response already staged, not what was true
        // when this request was fired.
        const toStage = idsNeedingStaging(ids, m2mAliasFieldStatesRef.current[field]?.ids)
        for (const id of toStage) m2mStagingCtx.stageLink(info.stagingKey, id)
      }
      if (Object.keys(scalar).length > 0) {
        const merged = mergeRuleResults(draftRef.current, scalar)
        draftRef.current = merged
        setDraft(merged)
        // Rule-set FKs cascade their own cross-record defaults.
        for (const [field, value] of Object.entries(scalar)) runCrossDefaults(field, value)
      }
    },
    [m2mAliasFieldsForRules, m2mAliasFieldStates, m2mStagingCtx, runCrossDefaults]
  )

  const fieldRuleTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(() => {
    const timers = fieldRuleTimersRef.current
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t)
    }
  }, [])

  // Debounced (300ms per trigger field) in-form evaluation of dynamic field
  // rules: POSTs /field-rules/evaluate and dispatches returned targets via
  // applyFieldRuleResults. No-ops entirely (no timer, no request) when the
  // collection has no active rules for the changed field. Only ever called
  // from user-driven edits — never on initial load/hydrate. `explicitValue`
  // lets M2M alias triggers (which have no draft entry) supply their current
  // effective id set; scalar callers omit it and the live draft value is read
  // fresh at fire time.
  const evaluateFieldRulesForChange = useCallback(
    (field: string, explicitValue?: unknown) => {
      const rules = rulesForTriggerField(fieldRules, field)
      if (rules.length === 0) return
      const existingTimer = fieldRuleTimersRef.current[field]
      if (existingTimer) clearTimeout(existingTimer)
      fieldRuleTimersRef.current[field] = setTimeout(() => {
        delete fieldRuleTimersRef.current[field]
        const triggerValue = explicitValue !== undefined ? explicitValue : draftRef.current[field]
        const targetDraft: Record<string, unknown> = {}
        for (const rule of rules) {
          const aliasIds = getM2MEffectiveIds(rule.target_field)
          targetDraft[rule.target_field] =
            aliasIds !== undefined ? aliasIds : draftRef.current[rule.target_field]
        }
        client
          .request<{ data: Record<string, unknown> }>(
            post('/field-rules/evaluate', {
              collection,
              trigger_field: field,
              trigger_value: triggerValue,
              draft: targetDraft
            })
          )
          .then((res) => applyFieldRuleResults(res.data))
          .catch(() => {})
      }, 300)
    },
    [fieldRules, collection, client, getM2MEffectiveIds, applyFieldRuleResults]
  )

  // M2M alias triggers never flow through handleFieldChange (they commit via
  // M2MStagingContext, not draft onChange), so watch the staging maps
  // directly for the alias fields that have active rules. m2mLinks/m2mUnlinks
  // only ever change via genuine stageLink/stageUnlink/unstageLink/
  // unstageUnlink calls (all user-driven), and untouched keys keep their
  // prior array/Set reference — so a reference change for a tracked key is
  // exactly a real staging edit, never mount noise or an unrelated field.
  const m2mStagingTrackerRef = useRef<
    Record<string, { links?: unknown[]; unlinks?: Set<unknown> }>
  >({})
  const m2mStagingMountedRef = useRef(false)
  const m2mTriggerAliasFields = useMemo(
    () =>
      [...m2mAliasFieldsForRules.entries()].filter(
        ([field]) => rulesForTriggerField(fieldRules, field).length > 0
      ),
    [m2mAliasFieldsForRules, fieldRules]
  )
  useEffect(() => {
    if (!m2mStagingMountedRef.current) {
      m2mStagingMountedRef.current = true
      for (const [field, info] of m2mTriggerAliasFields) {
        m2mStagingTrackerRef.current[field] = {
          links: m2mLinks.get(info.stagingKey),
          unlinks: m2mUnlinks.get(info.stagingKey)
        }
      }
      return
    }
    for (const [field, info] of m2mTriggerAliasFields) {
      const links = m2mLinks.get(info.stagingKey)
      const unlinks = m2mUnlinks.get(info.stagingKey)
      const prev = m2mStagingTrackerRef.current[field]
      if (prev && prev.links === links && prev.unlinks === unlinks) continue
      m2mStagingTrackerRef.current[field] = { links, unlinks }
      // A trigger whose own committed selection hasn't settled yet would
      // send an incomplete trigger_value — defer rather than fire; the next
      // staging change (almost always after the query has settled) re-runs
      // this same check.
      if (!isM2MFieldKnown(field)) continue
      evaluateFieldRulesForChange(field, getM2MEffectiveIds(field) ?? [])
    }
  }, [
    m2mLinks,
    m2mUnlinks,
    m2mTriggerAliasFields,
    getM2MEffectiveIds,
    isM2MFieldKnown,
    evaluateFieldRulesForChange
  ])

  const handleFieldChange = useCallback(
    (field: string, value: unknown) => {
      userTouchedRef.current.add(field)
      const next = { ...draftRef.current, [field]: value }
      for (const fc of fieldConfig ?? []) {
        if (!fc.dependency_config) continue
        try {
          const cfg = (
            typeof fc.dependency_config === 'string'
              ? JSON.parse(fc.dependency_config)
              : fc.dependency_config
          ) as {
            cascade_filters?: Array<{ parent_field: string; clear_on_parent_change?: boolean }>
          }
          for (const rule of cfg.cascade_filters ?? []) {
            if (rule.parent_field === field && rule.clear_on_parent_change) {
              next[fc.field] = null
            }
          }
        } catch {
          /* ignore malformed config */
        }
      }
      draftRef.current = next
      setDraft(next)
      setIsDirty(true)
      const isEmpty = value === null || value === undefined || value === ''
      if (!isEmpty) touchedFields.current.add(field)
      setValidationErrors((prev) => {
        const next = { ...prev }
        const fieldMeta = (fieldConfig ?? []).find((f) => f.field === field)
        if (fieldMeta?.required && isEmpty && touchedFields.current.has(field)) {
          next[field] = 'This field is required'
        } else {
          delete next[field]
        }
        return next
      })
      evaluateFieldRulesForChange(field)
      // Cross-record defaults: any field whose cross_record_defaults watches this
      // FK copies mapped source-record values into the draft when the FK is set.
      if (!isEmpty) runCrossDefaults(field, value)
      // Upstream cascades: a pick fills its own cascade parents in reverse.
      if (!isEmpty) upstreamCascadesRef.current(field, value)
    },
    [fieldConfig, evaluateFieldRulesForChange, runCrossDefaults]
  )

  const [fieldCounts, setFieldCounts] = useState<Record<string, number>>({})

  const o2mRelations = useMemo(
    () =>
      relations.filter(
        (r) =>
          !r.junction_field &&
          r.one_collection === collection &&
          r.one_field &&
          r.many_field &&
          r.many_collection
      ),
    [relations, collection]
  )
  const o2mQueryResults = useQueries({
    queries: o2mRelations.map((r) => ({
      queryKey: ['o2m-count', r.many_collection, r.many_field, itemId],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${r.many_collection}`, {
              filter: JSON.stringify({ [r.many_field!]: { _eq: itemId } }),
              limit: 200
            })
          )
          .then((res) => res.data?.length ?? 0),
      enabled: !!itemId && !isNew,
      staleTime: 30_000
    }))
  })
  const o2mCounts = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    o2mRelations.forEach((r, i) => {
      const count = o2mQueryResults[i]?.data
      if (r.one_field && count !== undefined) map[r.one_field] = count as number
    })
    return map
  }, [o2mRelations, o2mQueryResults])

  // Required O2M support: effective row count per O2M alias field — saved
  // rows minus staged deletes plus staged pending rows. "Required" on an O2M
  // means "at least one row, pending or existing". A field absent from the
  // map means its saved count hasn't settled yet — never block on that.
  const o2mAliasFields = useMemo(
    () => new Set(o2mRelations.map((r) => r.one_field as string)),
    [o2mRelations]
  )
  const o2mEffectiveCounts = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    for (const r of o2mRelations) {
      const field = r.one_field as string
      const key = `${r.many_collection}.${r.many_field}`
      const pending = pendingO2MRows.get(key)?.length ?? 0
      if (isNew) {
        out[field] = pending
        continue
      }
      const saved = o2mCounts[field]
      if (saved === undefined) continue
      const dels = pendingO2MDeletes.get(key)?.size ?? 0
      out[field] = Math.max(0, saved - dels) + pending
    }
    return out
  }, [o2mRelations, o2mCounts, pendingO2MRows, pendingO2MDeletes, isNew])

  // Adding a row to a required grid clears its error without waiting for the
  // next full validation pass (grids never call handleFieldChange).
  useEffect(() => {
    setValidationErrors((prev) => {
      let changed = false
      const next = { ...prev }
      for (const f of Object.keys(prev)) {
        if (o2mAliasFields.has(f) && (o2mEffectiveCounts[f] ?? 0) > 0) {
          delete next[f]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [o2mEffectiveCounts, o2mAliasFields])

  const handleM2MCountChange = useCallback(
    (field: string, count: number) => {
      setFieldCounts((prev) => (prev[field] === count ? prev : { ...prev, [field]: count }))
      if (count > 0) touchedFields.current.add(field)
      setValidationErrors((prev) => {
        const fieldMeta = (fieldConfig ?? []).find((f) => f.field === field)
        if (!fieldMeta?.required) return prev
        const next = { ...prev }
        if (count === 0 && touchedFields.current.has(field)) {
          next[field] = 'This field is required'
        } else {
          delete next[field]
        }
        return next
      })
    },
    [fieldConfig]
  )

  // ── Item lock ──────────────────────────────────────────────────────────────
  const lockEnabled = showLockBanner && !isNew && !!colMeta?.item_locking_enabled
  const {
    lockHolder,
    acquired: _acquired,
    isReadOnly,
    takeOver,
    takingOver,
    requestLock,
    requesting
  } = useItemLock(collection, !isNew ? itemId : undefined, lockEnabled)

  // ── Layout / groups ────────────────────────────────────────────────────────
  const assignments: SlotAssignment[] = activeLayoutData?.assignments ?? []

  // ── Lock condition data ────────────────────────────────────────────────────
  const hasLockConditions = assignments.some((a) => a.lock_conditions)

  const addendumEnabled = !!colMeta?.addendums_enabled && !isNew

  const { data: currentUserData } = useQuery<{ role?: string | null } | null>({
    queryKey: ['current-user-me'],
    queryFn: () =>
      client
        .request<{ data: { role?: string | null } }>(get('/users/me'))
        .then((r) => r.data ?? null),
    staleTime: 5 * 60_000,
    enabled: hasLockConditions || addendumEnabled
  })

  const { data: pipelineInstanceData } = useQuery<{
    instance?: { current_state?: string | null } | null
    states?: Array<{ id: string; key: string }>
  } | null>({
    queryKey: ['pipeline-instance-lock', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/pipelines/instance/${collection}/${itemId}`))
        .then(
          (r) =>
            r.data as {
              instance?: { current_state?: string | null } | null
              states?: Array<{ id: string; key: string }>
            }
        )
        .catch(() => null),
    staleTime: 30_000,
    enabled: (hasLockConditions || addendumEnabled) && !isNew
  })

  const addendumCanCreate = useMemo(() => {
    if (!addendumEnabled) return false
    // Role check
    if (colMeta?.addendum_allowed_roles) {
      try {
        const allowedRoles = JSON.parse(colMeta.addendum_allowed_roles) as string[]
        if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
          const userRole = currentUserData?.role ?? null
          if (!userRole || !allowedRoles.includes(userRole)) return false
        }
      } catch {
        /* malformed JSON — allow */
      }
    }
    // State check
    if (colMeta?.addendum_allowed_states) {
      try {
        const stateRules = JSON.parse(colMeta.addendum_allowed_states) as Array<{
          pipeline_id: string
          state_keys: string[]
        }>
        if (Array.isArray(stateRules) && stateRules.length > 0) {
          const currentStateId = pipelineInstanceData?.instance?.current_state ?? null
          const currentStateKey =
            pipelineInstanceData?.states?.find((s) => s.id === currentStateId)?.key ?? null
          const allowed = stateRules.some(
            (rule) =>
              rule.state_keys.length === 0 ||
              (currentStateKey !== null && rule.state_keys.includes(currentStateKey))
          )
          if (!allowed) return false
        }
      } catch {
        /* malformed JSON — allow */
      }
    }
    return true
  }, [
    addendumEnabled,
    colMeta?.addendum_allowed_roles,
    colMeta?.addendum_allowed_states,
    currentUserData?.role,
    pipelineInstanceData
  ])

  type AddendumRecord = {
    id: string
    title: string
    status: string
    fields_schema: string[] | null
    data: Record<string, unknown> | null
  }

  const { data: addendumData = [] } = useQuery<AddendumRecord[]>({
    queryKey: ['addendums', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: AddendumRecord[] }>(get(`/addendums/${collection}/${itemId}`))
        .then((r) => r.data ?? []),
    enabled: addendumEnabled,
    staleTime: 30_000
  })

  const addendumFieldMap = useMemo<AddendumFieldMap>(() => {
    const map: AddendumFieldMap = {}
    for (const a of addendumData) {
      if (['approved', 'rejected'].includes(a.status)) continue
      for (const key of a.fields_schema ?? []) {
        if (!map[key]) map[key] = []
        map[key].push({ id: a.id, title: a.title, status: a.status })
      }
    }
    return map
  }, [addendumData])

  const activeAddendums = useMemo(
    () => addendumData.filter((a) => !['approved', 'rejected'].includes(a.status)),
    [addendumData]
  )

  // Auto-select the most recent active addendum when the layout has addendum_default_view on
  const defaultViewApplied = useRef(false)
  useEffect(() => {
    if (defaultViewApplied.current) return
    if (!activeLayoutData || !activeAddendums.length) return
    if (!activeLayoutData.layout?.addendum_default_view) return
    defaultViewApplied.current = true
    setAddendumViewId(activeAddendums[0].id)
  }, [activeLayoutData, activeAddendums])

  const addendumViewData = useMemo<Record<string, unknown> | null>(() => {
    if (addendumViewId === 'original') return null
    const a = addendumData.find((x) => x.id === addendumViewId)
    if (!a?.data) return null
    return Object.fromEntries(Object.entries(a.data).filter(([, v]) => !Array.isArray(v)))
  }, [addendumViewId, addendumData])

  // Live rollups: a grid publishes the rows it is showing, and a header field
  // whose value is a rollup over those rows recomputes as they change — so a
  // total agrees with the lines under it before the save round-trip that makes
  // the server recalculate it. Display only; nothing is written from here.
  const [liveRowsByRelation, setLiveRowsByRelation] = useState<
    Map<string, Record<string, unknown>[]>
  >(new Map())
  // Which child fields any rollup actually reads, per relation — the signature
  // below is built from these alone, so an unrelated edit (a note, a date)
  // cannot churn the live total.
  const rollupFieldsByRelation = useMemo(() => {
    const out = new Map<string, string[]>()
    for (const f of fieldConfig ?? []) {
      if (f.computed_type !== 'rollup' || !f.computed_formula) continue
      for (const src of parseRollupSources(f.computed_formula)) {
        const key = `${src.related_collection}.${src.fk_field}`
        const wanted = new Set(out.get(key) ?? ['id'])
        if (src.value_field) wanted.add(src.value_field)
        for (const k of Object.keys(src.filter ?? {})) wanted.add(k)
        for (const m of (src.value_formula ?? '').matchAll(/\{\{([\w.]+)\}\}/g)) {
          wanted.add(String(m[1]).split('.')[0])
        }
        out.set(key, [...wanted])
      }
    }
    return out
  }, [fieldConfig])
  const rollupFieldsRef = useRef(rollupFieldsByRelation)
  rollupFieldsRef.current = rollupFieldsByRelation
  const liveRowsSigRef = useRef(new Map<string, string>())

  /**
   * Compare by CONTENT, not identity: a grid rebuilds its merged row array on
   * every render, so an identity check would re-set state forever (React's
   * "Maximum update depth exceeded"). Signing only the rollup-relevant fields
   * means an unchanged grid costs one string compare and sets no state at all,
   * which is what terminates the loop.
   */
  const reportLiveRows = useCallback<LiveRowsCtx['report']>((relatedCollection, fkField, rows) => {
    const key = `${relatedCollection}.${fkField}`
    if (rows === null) {
      if (!liveRowsSigRef.current.has(key)) return
      liveRowsSigRef.current.delete(key)
      setLiveRowsByRelation((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })
      return
    }
    const wanted = rollupFieldsRef.current.get(key)
    // No rollup reads this relation — publishing it would be pure churn.
    if (!wanted) return
    const sig = rows.map((r) => wanted.map((k) => String(r[k] ?? '')).join('\u0001')).join('\u0002')
    if (liveRowsSigRef.current.get(key) === sig) return
    liveRowsSigRef.current.set(key, sig)
    setLiveRowsByRelation((prev) => new Map(prev).set(key, rows))
  }, [])
  const liveRowsCtx = useMemo<LiveRowsCtx>(
    () => ({ rows: liveRowsByRelation, report: reportLiveRows }),
    [liveRowsByRelation, reportLiveRows]
  )

  // Staged grandchild ops (unit allocations under pending/queued lines),
  // published by grids so record-scoped widgets (Deployments rollup) can
  // reflect unsaved changes. Signature-guarded like reportLiveRows — grids
  // rebuild their ops object every render.
  const [stagedRelsByGrid, setStagedRelsByGrid] = useState<
    Map<string, Record<string, StagedRelOps>>
  >(new Map())
  const stagedRelsSigRef = useRef(new Map<string, string>())
  const reportStagedRels = useCallback<StagedRelationsCtx['report']>((gridKey, byCollection) => {
    if (byCollection === null) {
      if (!stagedRelsSigRef.current.has(gridKey)) return
      stagedRelsSigRef.current.delete(gridKey)
      setStagedRelsByGrid((prev) => {
        if (!prev.has(gridKey)) return prev
        const next = new Map(prev)
        next.delete(gridKey)
        return next
      })
      return
    }
    const sig = JSON.stringify(byCollection)
    if (stagedRelsSigRef.current.get(gridKey) === sig) return
    stagedRelsSigRef.current.set(gridKey, sig)
    setStagedRelsByGrid((prev) => new Map(prev).set(gridKey, byCollection))
  }, [])
  const stagedRelsCtx = useMemo<StagedRelationsCtx>(
    () => ({ report: reportStagedRels, byGrid: stagedRelsByGrid }),
    [reportStagedRels, stagedRelsByGrid]
  )

  // A grid only publishes rows while it is mounted, so on a tabbed form the
  // total would stay blank until the user visited the lines tab. On a NEW
  // record we do not need the grid at all: every child row is staged right
  // here. (A SAVED record needs no fallback — its stored value is the server's
  // own rollup and is already correct.)
  const stagedRollupRelations = useMemo(() => {
    if (!isNew)
      return [] as Array<{ key: string; collection: string; rows: Record<string, unknown>[] }>
    const out: Array<{ key: string; collection: string; rows: Record<string, unknown>[] }> = []
    for (const key of rollupFieldsByRelation.keys()) {
      if (liveRowsByRelation.has(key)) continue
      const rows = pendingO2MRows.get(key) ?? []
      if (rows.length === 0) continue
      out.push({ key, collection: key.split('.')[0], rows })
    }
    return out
  }, [isNew, rollupFieldsByRelation, liveRowsByRelation, pendingO2MRows])

  // Child field config, only for those relations — a staged row carries what
  // the user entered, not what the server derives from it (amount = price x
  // quantity), and summing the raw rows would report a total of zero.
  const stagedChildConfigs = useQueries({
    queries: stagedRollupRelations.map((r) => ({
      queryKey: ['field-config', r.collection, null],
      queryFn: () =>
        client
          .request<{ data: CMSField[] }>(get(`/field-config/${r.collection}`))
          .then((res) => res.data ?? []),
      staleTime: 60_000
    }))
  })

  const stagedRowsByRelation = useMemo(() => {
    const out = new Map<string, Record<string, unknown>[]>()
    stagedRollupRelations.forEach((rel, idx) => {
      const cfg = stagedChildConfigs[idx]?.data
      if (!cfg) return
      const writes = cfg.filter((f) => f.computed_type === 'write' && !!f.computed_formula)
      out.set(
        rel.key,
        rel.rows.map((row) => {
          const next = { ...row }
          for (const f of writes) {
            const v = evalClientFormula(String(f.computed_formula), next)
            if (v !== null) next[f.field] = v
          }
          return next
        })
      )
    })
    return out
  }, [stagedRollupRelations, stagedChildConfigs])

  // Fields whose stored value no longer appears in their own filtered option
  // set. This is NOT re-derived here: the picker already resolves the field's
  // effective filter (cascade parents, $parent tokens, picker filters) and
  // flags the value amber, so it reports what it found and the summary shows
  // the same verdict. Asking a similar-but-different question here — "does the
  // record still exist?" — answered "yes" for exactly the case the user cares
  // about, a record that exists but is no longer a valid choice.
  const [staleFields, setStaleFields] = useState<Set<string>>(() => new Set())
  const reportStaleField = useCallback((field: string, stale: boolean) => {
    setStaleFields((prev) => {
      if (prev.has(field) === stale) return prev
      const next = new Set(prev)
      if (stale) next.add(field)
      else next.delete(field)
      return next
    })
  }, [])

  const liveRollupValues = useMemo(() => {
    const out = new Map<string, number>()
    for (const f of fieldConfig ?? []) {
      if (f.computed_type !== 'rollup' || !f.computed_formula) continue
      const merged = new Map(liveRowsByRelation)
      for (const [k, v] of stagedRowsByRelation) if (!merged.has(k)) merged.set(k, v)
      const value = computeLiveRollup(parseRollupSources(f.computed_formula), merged)
      if (value !== null) out.set(f.field, value)
    }
    return out
  }, [fieldConfig, liveRowsByRelation, stagedRowsByRelation])

  const effectiveDraft = useMemo(
    () => (addendumViewData ? { ...draft, ...addendumViewData } : draft),
    [draft, addendumViewData]
  )

  // While viewing an addendum, the pipeline panel operates on the ADDENDUM's
  // own workflow — switch back to Original and it acts on the record again.
  const viewingAddendum = addendumViewId !== 'original'
  const pipelineCollection = viewingAddendum ? 'nivaro_addendums' : collection
  const pipelineItem = viewingAddendum ? addendumViewId : itemId

  const addendumO2MMap = useMemo<AddendumO2MMap>(() => {
    const map: AddendumO2MMap = {}
    for (const a of addendumData) {
      if (['approved', 'rejected'].includes(a.status)) continue
      for (const [key, val] of Object.entries(a.data ?? {})) {
        if (!Array.isArray(val) || val.length === 0) continue
        if (!map[key]) map[key] = []
        map[key].push({
          addendumId: a.id,
          addendumTitle: a.title,
          addendumStatus: a.status,
          rows: val as Array<Record<string, unknown>>
        })
      }
    }
    return map
  }, [addendumData])

  // When a specific layout is requested by slug, only show fields explicitly
  // assigned to that layout — unassigned fields should not appear.
  const assignedFieldSet = useMemo<Set<string> | null>(() => {
    if (!layoutSlug || !activeLayoutData) return null
    return new Set(assignments.map((a) => a.field))
  }, [layoutSlug, activeLayoutData, assignments])

  const allFields = useMemo<CMSField[]>(() => {
    if (!fieldConfig) return []
    // Slug requested but layout not yet resolved — suppress stale cache to avoid field flash
    if (layoutSlug && activeLayoutData === undefined) return []
    const sorted = [...fieldConfig].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    // Deduplicate by field name — multi-group fields appear once per group in fieldConfig;
    // allFields is used for validation/draft and must have one entry per field
    const seen = new Set<string>()
    const deduped = sorted.filter((f) => {
      if (seen.has(f.field)) return false
      seen.add(f.field)
      return true
    })
    if (!assignedFieldSet) return deduped
    return deduped.filter(
      (f) => assignedFieldSet.has(f.field) || SYSTEM_FIELDS.has(f.field) || isSentinelKey(f.field)
    )
  }, [fieldConfig, assignedFieldSet, layoutSlug, activeLayoutData])

  const groups = useMemo<FieldGroup[]>(() => {
    return (activeLayoutData?.groups ?? []).sort((a, b) => a.sort - b.sort)
  }, [activeLayoutData])

  // Aggregate configs extracted from all groups' summary_fields
  const summaryAggConfigs = useMemo<Record<string, SummaryAggConfig>>(() => {
    const map: Record<string, SummaryAggConfig> = {}
    for (const g of groups) {
      const entries = parseSummaryFields(g.summary_fields)
      if (!entries) continue
      for (const e of entries) {
        if (typeof e !== 'string' && e.field && 'agg' in e && e.agg && e.agg_field) map[e.field] = e
      }
    }
    return map
  }, [groups])
  const aggRelations = useMemo(
    () => o2mRelations.filter((r) => r.one_field && r.one_field in summaryAggConfigs),
    [o2mRelations, summaryAggConfigs]
  )
  // Fetch field configs for child collections so we can format agg values correctly
  // (e.g. currency, decimal) without requiring the user to re-save the agg config.
  const aggFieldConfigResults = useQueries({
    queries: aggRelations.map((r) => ({
      queryKey: ['field-config', r.many_collection],
      queryFn: () =>
        client
          .request<{ data: Array<{ field: string; options: unknown }> }>(
            get(`/field-config/${r.many_collection}`)
          )
          .then((res) => res.data ?? []),
      enabled: !!r.many_collection,
      staleTime: 120_000
    }))
  })

  // Enrich summaryAggConfigs with live field_options from child field configs
  const enrichedSummaryAggConfigs = useMemo<Record<string, SummaryAggConfig>>(() => {
    const enriched = { ...summaryAggConfigs }
    aggRelations.forEach((r, i) => {
      if (!r.one_field) return
      const cfg = summaryAggConfigs[r.one_field]
      if (!cfg || !cfg.agg_field) return
      const fields: Array<{ field: string; options: unknown }> =
        (aggFieldConfigResults[i]?.data as
          | Array<{ field: string; options: unknown }>
          | undefined) ?? []
      const fieldMeta = fields.find((f) => f.field === cfg.agg_field)
      if (!fieldMeta) return
      const opts = fieldMeta.options
        ? typeof fieldMeta.options === 'string'
          ? fieldMeta.options
          : JSON.stringify(fieldMeta.options)
        : null
      if (opts) enriched[r.one_field] = { ...cfg, field_options: opts }
    })
    return enriched
  }, [summaryAggConfigs, aggRelations, aggFieldConfigResults])

  const aggQueryResults = useQueries({
    queries: aggRelations.map((r) => {
      const cfg = summaryAggConfigs[r.one_field!]
      return {
        queryKey: ['o2m-rows', r.many_collection, r.many_field, itemId],
        queryFn: () =>
          client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${r.many_collection}`, {
                filter: JSON.stringify({ [r.many_field!]: { _eq: itemId } }),
                limit: 500
              })
            )
            .then((res) => res.data ?? []),
        enabled: !!itemId && !isNew,
        staleTime: 30_000
      }
    })
  })
  const o2mAggValues = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    aggRelations.forEach((r, i) => {
      if (!r.one_field || !r.many_collection || !r.many_field) return
      const baseRows: Record<string, unknown>[] =
        (aggQueryResults[i]?.data as Record<string, unknown>[] | undefined) ?? []
      const cfg = enrichedSummaryAggConfigs[r.one_field]
      if (!cfg) return
      const stagingKey = `${r.many_collection}.${r.many_field}`
      const edits = pendingO2MEdits.get(stagingKey) ?? new Map<string, Record<string, unknown>>()
      const deletes = pendingO2MDeletes.get(stagingKey) ?? new Set<string>()
      const newRows = pendingO2MRows.get(stagingKey) ?? []
      // Merge: base rows with edits applied, minus deletes, plus new rows
      const effectiveRows: Record<string, unknown>[] = [
        ...baseRows
          .filter((row) => !deletes.has(String(row.id)))
          .map((row) =>
            edits.has(String(row.id)) ? { ...row, ...edits.get(String(row.id)) } : row
          ),
        ...newRows
      ]
      if (cfg.agg === 'count') {
        map[r.one_field] = effectiveRows.length
        return
      }
      const nums = effectiveRows
        .map((row) => Number(row[cfg.agg_field]))
        .filter((n) => !Number.isNaN(n))
      if (!nums.length) {
        map[r.one_field] = 0
        return
      }
      if (cfg.agg === 'sum') map[r.one_field] = nums.reduce((a, b) => a + b, 0)
      else if (cfg.agg === 'avg') map[r.one_field] = nums.reduce((a, b) => a + b, 0) / nums.length
      else if (cfg.agg === 'min') map[r.one_field] = Math.min(...nums)
      else if (cfg.agg === 'max') map[r.one_field] = Math.max(...nums)
    })
    return map
  }, [
    aggRelations,
    aggQueryResults,
    summaryAggConfigs,
    pendingO2MRows,
    pendingO2MEdits,
    pendingO2MDeletes
  ])

  const o2mLoading = useMemo<Set<string>>(() => {
    const s = new Set<string>()
    o2mRelations.forEach((r, i) => {
      if (o2mQueryResults[i]?.isLoading && r.one_field) s.add(r.one_field)
    })
    aggRelations.forEach((r, i) => {
      if (aggQueryResults[i]?.isLoading && r.one_field) s.add(r.one_field)
    })
    return s
  }, [o2mRelations, o2mQueryResults, aggRelations, aggQueryResults])

  const o2mUniqueByMap = useMemo<Map<string, string[]>>(() => {
    const map = new Map<string, string[]>()
    for (const f of fieldConfig ?? []) {
      if (f.interface !== 'inline-table') continue
      let opts: Record<string, unknown> = {}
      try {
        opts = f.options
          ? typeof f.options === 'string'
            ? JSON.parse(f.options)
            : (f.options as Record<string, unknown>)
          : {}
      } catch {
        continue
      }
      const ub = Array.isArray(opts.unique_by) ? (opts.unique_by as string[]) : null
      if (!ub?.length) continue
      const rel = relations.find(
        (r) => r.one_field === f.field && r.one_collection === collection && !r.junction_field
      )
      if (!rel?.many_collection || !rel?.many_field) continue
      map.set(`${rel.many_collection}.${rel.many_field}`, ub)
    }
    return map
  }, [fieldConfig, relations, collection])

  const groupedMap = useMemo<Record<string, CMSField[]>>(() => {
    // Build from raw fieldConfig (not deduped allFields) so multi-group fields appear in each group
    const raw = fieldConfig ? [...fieldConfig].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)) : []
    const map: Record<string, CMSField[]> = {}
    for (const f of raw) {
      if (!f.group_key || isSentinelKey(f.field)) continue
      if (!map[f.group_key]) map[f.group_key] = []
      // Avoid duplicates within the same group (shouldn't happen with the new unique constraint)
      if (!map[f.group_key].find((e) => e.field === f.field)) map[f.group_key].push(f)
    }
    return map
  }, [fieldConfig])

  const ungroupedFields = useMemo(
    () =>
      allFields.filter(
        (f) =>
          !f.group_key &&
          !f.hidden &&
          !SYSTEM_FIELDS.has(f.field) &&
          !isSentinelKey(f.field) &&
          (layoutId === null || f.layout_assigned !== false)
      ),
    [allFields, layoutId]
  )

  const systemFields = useMemo(
    () => allFields.filter((f) => SYSTEM_FIELDS.has(f.field) || f.readonly),
    [allFields]
  )

  const containerGroups = useMemo(() => groups.filter((g) => g.type === 'container'), [groups])
  // Legacy orphan tabs (no container) — used for layout-level tabs/steps mode
  // Conditional wizard steps (#139): a group's visible_when rules
  // ([{field, op, value}], AND) hide the whole step until the record matches.
  const stepVisible = useCallback(
    (g: { visible_when?: string | null }) => {
      if (!g.visible_when) return true
      let rules: Array<{ field?: string; op?: string; value?: unknown }>
      try {
        rules = JSON.parse(g.visible_when)
      } catch {
        return true
      }
      if (!Array.isArray(rules) || rules.length === 0) return true
      return rules.every((r) => {
        if (!r?.field) return true
        const v = draft[r.field]
        const want = r.value
        switch (r.op ?? 'eq') {
          case 'eq':
            return String(v ?? '') === String(want ?? '')
          case 'neq':
            return String(v ?? '') !== String(want ?? '')
          case 'null':
            return v == null || v === ''
          case 'nnull':
            return v != null && v !== ''
          case 'in':
            return String(want ?? '')
              .split(',')
              .map((x) => x.trim())
              .includes(String(v ?? ''))
          default:
            return true
        }
      })
    },
    [draft]
  )
  const tabGroups = useMemo(
    () =>
      groups.filter(
        (g) =>
          g.type === 'tab' &&
          !g.container_id &&
          stepVisible(g as { visible_when?: string | null })
      ),
    [groups, stepVisible]
  )
  // All tabs regardless of container — used for SummaryPanel coverage
  const allTabGroups = useMemo(
    () => groups.filter((g) => g.type === 'tab').sort((a, b) => a.sort - b.sort),
    [groups]
  )
  const sectionGroups = useMemo(
    () => groups.filter((g) => g.type === 'section' || g.type === 'metadata'),
    [groups]
  )
  const hasContainers = containerGroups.length > 0
  // Legacy mode: tab groups with no container use the layout-level tab_mode
  const hasTabs = tabGroups.length > 0
  const layoutMeta = activeLayoutData?.layout
  const layoutAiEnabled = layoutMeta ? !!layoutMeta.ai_enabled : true
  const isStepsMode = hasTabs && layoutMeta?.tab_mode === 'steps'
  const validateBeforeNext = !!layoutMeta?.validate_before_next
  const summaryEnabled = !!layoutMeta?.summary_enabled
  const hideEmptySummary = !!layoutMeta?.summary_hide_empty
  // Layout-level disable flags override props when a layout is active
  const effectiveShowRevisions = layoutMeta
    ? !layoutMeta.disable_revisions && showRevisions
    : showRevisions
  const effectiveShowComments = layoutMeta
    ? !layoutMeta.disable_comments && showComments
    : showComments
  const effectiveShowTasks = layoutMeta ? !layoutMeta.disable_tasks && showTasks : showTasks
  const effectiveShowClone = layoutMeta ? !layoutMeta.disable_clone && showClone : showClone
  const effectiveShowDelete = layoutMeta ? !layoutMeta.disable_delete : true
  const accordionMode = !!layoutMeta?.accordion_mode
  const [summaryCollapsed, setSummaryCollapsed] = useState(false)
  // Accordion mode: track the single open section group id (null = none open)
  const [openSectionId, setOpenSectionId] = useState<number | null>(null)
  const [swappedGroups, setSwappedGroups] = useState<Set<number>>(new Set())
  const prevAccordionModeRef = useRef(false)
  useEffect(() => {
    if (!accordionMode) {
      prevAccordionModeRef.current = false
      return
    }
    // Re-init whenever accordion turns on (mode changes or groups change)
    if (accordionMode && !prevAccordionModeRef.current) {
      prevAccordionModeRef.current = true
      const first = sectionGroups.find((g) => !g.is_collapsed) ?? sectionGroups[0]
      if (first) setOpenSectionId(first.id)
    }
  }, [accordionMode, sectionGroups])

  const bodyRef = useRef<HTMLDivElement>(null)

  /** Shared scroll+flash used by the integrity banner and ?focus= deep links. */
  const flashField = (key: string) => {
    const el = document.querySelector<HTMLElement>(`[data-field="${key}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.style.transition = 'box-shadow 0.15s ease'
    el.style.boxShadow = '0 0 0 2px #00ceff, 0 0 0 5px rgba(0,206,255,0.25)'
    el.style.borderRadius = '12px'
    setTimeout(() => {
      el.style.boxShadow = 'none'
      setTimeout(() => {
        el.style.transition = ''
        el.style.borderRadius = ''
      }, 300)
    }, 1200)
  }
  // Find-in-record (#82): searchable field list from the deduped config +
  // current draft values; jump = the same flash, reporting a miss when the
  // field's DOM node isn't mounted (another tab/step).
  const findableFields = useMemo<FindableField[]>(() => {
    const m2oByField = new Map(
      relations
        .filter((r) => r.many_collection === collection && !r.junction_field && r.many_field)
        .map((r) => [r.many_field as string, r.one_collection as string])
    )
    // O2M aliases — the alias is named by one_field (normal) or by the child
    // table itself (legacy child-table-name form).
    const o2mByField = new Map<string, { target: string; fk: string }>()
    for (const r of relations) {
      if (r.junction_field || r.one_collection !== collection || !r.many_collection || !r.many_field)
        continue
      const aliasName = (r.one_field as string | null) ?? r.many_collection
      if (!o2mByField.has(aliasName))
        o2mByField.set(aliasName, { target: r.many_collection, fk: r.many_field })
    }
    return allFields
      .filter((f) => !f.hidden && !f.field.startsWith('__'))
      .map((f): FindableField => {
        // `||` not `??` — legacy alias fields carry an EMPTY-string label.
        const label = f.label || titleCase(f.field)
        // M2M alias — value = committed+staged junction ids, resolved to
        // labels lazily inside the search popover.
        const aliasInfo = m2mAliasFieldsForRules.get(f.field)
        if (aliasInfo) {
          const companion = relations.find(
            (r) =>
              r.many_collection === aliasInfo.manyCollection &&
              r.many_field === aliasInfo.junctionField
          )
          const st = m2mAliasFieldStates[f.field]
          return {
            field: f.field,
            label,
            group: null,
            value: '',
            relation: companion?.one_collection
              ? {
                  kind: 'm2m',
                  target: companion.one_collection as string,
                  ids: st?.known ? st.ids : []
                }
              : undefined
          }
        }
        const o2m = o2mByField.get(f.field)
        if (o2m && itemId && !isNew) {
          return {
            field: f.field,
            label,
            group: null,
            value: '',
            relation: { kind: 'o2m', target: o2m.target, fkField: o2m.fk, parentId: itemId }
          }
        }
        const v = draft[f.field]
        const m2oTarget = m2oByField.get(f.field)
        if (m2oTarget && v != null && v !== '' && typeof v !== 'object') {
          return {
            field: f.field,
            label,
            group: null,
            value: '',
            relation: { kind: 'm2o', target: m2oTarget, ids: [v as string | number] }
          }
        }
        let value = ''
        if (v != null && typeof v !== 'object') {
          if (typeof v === 'boolean' || f.type === 'boolean') {
            value = v === true || v === 1 || v === '1' || v === 'true' ? 'Yes' : 'No'
          } else {
            const choices = parseJson<{ choices?: Array<{ text: string; value: string }> }>(
              f.options
            )?.choices
            const choice = choices?.find((c) => String(c.value) === String(v))
            value = choice
              ? choiceLabel(choice.text)
              : String(v)
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 120)
          }
        }
        return { field: f.field, label, group: null, value }
      })
  }, [
    allFields,
    draft,
    relations,
    collection,
    m2mAliasFieldsForRules,
    m2mAliasFieldStates,
    itemId,
    isNew
  ])
  const jumpToField = (key: string): boolean => {
    const el = document.querySelector(`[data-field="${key}"]`)
    if (el) {
      flashField(key)
      return true
    }
    // Not mounted — the field lives on another tab/step. Switch to its tab
    // (top-level steps AND container steps), then flash once it paints.
    // Section-group fields on tabbed layouts live under the __general__ step.
    const groupKey = Object.entries(groupedMap).find(([, fs]) =>
      fs.some((f) => f.field === key)
    )?.[0]
    if (!groupKey) return false
    const group = groups.find((g) => g.key === groupKey)
    if (!group) return false
    let switched = false
    if (group.type === 'tab' && group.container_id != null) {
      const container = groups.find((g) => g.id === group.container_id)
      if (container) {
        setContainerTab(container, groupKey)
        switched = true
      }
    } else if (group.type === 'tab' && allSteps.some((s) => s.key === groupKey)) {
      setActiveTab(groupKey)
      switched = true
    } else if (
      (group.type === 'section' || group.type === 'metadata') &&
      hasTabs &&
      allSteps.some((s) => s.key === '__general__')
    ) {
      setActiveTab('__general__')
      switched = true
    }
    if (!switched) return false
    const tryFlash = (attempt: number) => {
      if (document.querySelector(`[data-field="${key}"]`)) {
        flashField(key)
        return
      }
      if (attempt < 12) setTimeout(() => tryFlash(attempt + 1), 150)
    }
    setTimeout(() => tryFlash(0), 150)
    return true
  }

  /** Copy summary (#83): FRIENDLY values only — M2O ids resolve to their
   *  display labels, select values to their choice text, booleans to Yes/No;
   *  bare internal ids never appear. */
  const [copyingSummary, setCopyingSummary] = useState(false)
  const copyRecordSummary = async () => {
    if (copyingSummary) return
    setCopyingSummary(true)
    try {
      await copyRecordSummaryInner()
    } finally {
      setCopyingSummary(false)
    }
  }
  const copyRecordSummaryInner = async () => {
    const m2oByField = new Map(
      relations
        .filter(
          (r) => r.many_collection === collection && !r.junction_field && r.many_field
        )
        .map((r) => [r.many_field as string, r.one_collection as string])
    )
    const labelCache = new Map<string, string>()
    const resolveM2O = async (target: string, id: unknown): Promise<string> => {
      const key = `${target}:${String(id)}`
      const hit = labelCache.get(key)
      if (hit) return hit
      try {
        const [metaRes, rowRes] = await Promise.all([
          client.request<{ data: { display_template?: string | null } }>(
            get(`/collections/${target}`)
          ),
          client.request<{ data: Record<string, unknown> }>(get(`/items/${target}/${String(id)}`))
        ])
        const row = rowRes.data
        const tmpl =
          metaRes.data?.display_template ??
          (target === 'nivaro_users' ? '{{first_name}} {{last_name}}' : null)
        const label =
          (tmpl ? applyDisplayTemplate(tmpl, row) : '') ||
          String(row?.name ?? row?.title ?? row?.label ?? row?.subject ?? '')
        const out = label.trim()
        if (out) labelCache.set(key, out)
        return out
      } catch {
        return ''
      }
    }
    const lines: string[] = []
    for (const f of allFields) {
      if (f.hidden || f.field.startsWith('__')) continue
      if (f.field === 'id') continue
      const label = f.label ?? titleCase(f.field)
      // M2M aliases never live in draft — their committed junction ids do.
      // Each id resolves to its display label, joined into one line.
      const aliasInfo = m2mAliasFieldsForRules.get(f.field)
      if (aliasInfo) {
        const st = m2mAliasFieldStates[f.field]
        if (st?.known && st.ids.length > 0) {
          const companion = relations.find(
            (r) =>
              r.many_collection === aliasInfo.manyCollection &&
              r.many_field === aliasInfo.junctionField
          )
          const target = companion?.one_collection as string | undefined
          if (target) {
            const labels = (
              await Promise.all(st.ids.slice(0, 15).map((id) => resolveM2O(target, id)))
            ).filter(Boolean)
            if (labels.length > 0) {
              lines.push(
                `${label}: ${labels.join(', ')}${st.ids.length > 15 ? ` +${st.ids.length - 15} more` : ''}`
              )
            }
          }
        }
        continue
      }
      const v = draft[f.field]
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
      const target = m2oByField.get(f.field)
      if (target) {
        const friendly = await resolveM2O(target, v)
        if (friendly) lines.push(`${label}: ${friendly}`)
        continue // no label = don't print the raw id at all
      }
      if (typeof v === 'object') continue // alias/JSON blobs aren't summary material
      if (typeof v === 'boolean' || f.type === 'boolean') {
        lines.push(`${label}: ${v === true || v === 1 || v === '1' || v === 'true' ? 'Yes' : 'No'}`)
        continue
      }
      // Machine-shaped values (uuids, *_id columns with no relation) stay out.
      if (/(^|_)(id|uuid)$/i.test(f.field)) continue
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)))
        continue
      // Select choices print their human text.
      const choices = parseJson<{ choices?: Array<{ text: string; value: string }> }>(
        f.options
      )?.choices
      const choice = choices?.find((c) => String(c.value) === String(v))
      if (choice) {
        lines.push(`${label}: ${choiceLabel(choice.text)}`)
        continue
      }
      // Dates read as dates; everything else as trimmed plain text.
      const str = String(v)
      if (/^\d{4}-\d{2}-\d{2}/.test(str) && !Number.isNaN(new Date(str).getTime())) {
        lines.push(`${label}: ${new Date(str).toLocaleDateString()}`)
        continue
      }
      lines.push(`${label}: ${str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`)
    }
    const heading = itemTitle && itemTitle !== (colMeta?.display_name ?? '') ? itemTitle : `${singularTitle} ${String(itemId ?? '')}`
    const text = `${heading}\n${window.location.href}\n\n${lines.join('\n')}`
    await navigator.clipboard.writeText(text).then(
      () => toast.success('Summary copied'),
      () => toast.error('Could not copy')
    )
  }

  const focusedOnceRef = useRef(false)
  useEffect(() => {
    if (!focusField || focusedOnceRef.current) return
    focusedOnceRef.current = true
    // The field may live on another tab/step and the form may still be
    // painting — give layout a beat.
    setTimeout(() => flashField(focusField), 600)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusField])
  // Per-container active tab: Map<containerId, tabKey>
  const [containerTabs, setContainerTabs] = useState<Map<number, string>>(() => new Map())
  const [containerVisited, setContainerVisited] = useState<Map<number, Set<string>>>(
    () => new Map()
  )
  const getContainerTab = (c: FieldGroup, children: FieldGroup[]) =>
    containerTabs.get(c.id) ?? children[0]?.key ?? ''
  const isContainerTabVisited = (c: FieldGroup, key: string) =>
    containerVisited.get(c.id)?.has(key) ?? false
  const setContainerTab = (c: FieldGroup, key: string) => {
    setContainerTabs((prev) => new Map(prev).set(c.id, key))
    setContainerVisited((prev) => {
      const existing = prev.get(c.id) ?? new Set<string>()
      if (existing.has(key)) return prev
      return new Map(prev).set(c.id, new Set([...existing, key]))
    })
  }

  const [activeTab, setActiveTabRaw] = useState<string>(() => {
    try {
      return localStorage.getItem(`nvr_tab_${collection}`) ?? tabGroups[0]?.key ?? '__general__'
    } catch {
      return '__general__'
    }
  })
  const [visitedSteps, setVisitedSteps] = useState<Set<string>>(() => {
    const initial = (() => {
      try {
        return localStorage.getItem(`nvr_tab_${collection}`) ?? tabGroups[0]?.key ?? '__general__'
      } catch {
        return tabGroups[0]?.key ?? '__general__'
      }
    })()
    return new Set([initial])
  })
  const setActiveTab = (k: string) => {
    setActiveTabRaw(k)
    setVisitedSteps((prev) => {
      if (prev.has(k)) return prev
      const next = new Set(prev)
      next.add(k)
      return next
    })
    try {
      localStorage.setItem(`nvr_tab_${collection}`, k)
    } catch {
      /* noop */
    }
    // Step deep links (#129): the active step rides the URL so "look at the
    // Deployments step" is a pasteable link.
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('step', k)
      window.history.replaceState(window.history.state, '', url)
    } catch {
      /* noop */
    }
    bodyRef.current?.scrollTo({ top: 0 })
  }



  const allSteps = useMemo<StepDef[]>(() => {
    if (!hasTabs) return []
    const steps: StepDef[] = []
    // In steps mode, sectionGroups float above/below steps as panels — only add __general__ for ungrouped fields.
    // In tab mode, sectionGroups belong inside the __general__ tab.
    if (isStepsMode ? ungroupedFields.length > 0 : sectionGroups.length > 0)
      steps.push({ key: '__general__', label: 'General' })
    for (const g of tabGroups) steps.push({ key: g.key, label: g.label })
    return steps
  }, [hasTabs, sectionGroups, tabGroups, isStepsMode, ungroupedFields])

  // Consume ?step= once on mount (#129) — beats the persisted tab.
  const stepParamConsumedRef = useRef(false)
  useEffect(() => {
    if (stepParamConsumedRef.current || !hasTabs) return
    try {
      const wanted = new URL(window.location.href).searchParams.get('step')
      if (wanted && allSteps.some((st) => st.key === wanted)) {
        stepParamConsumedRef.current = true
        setActiveTabRaw(wanted)
        setVisitedSteps((prev) => new Set([...prev, wanted]))
      }
    } catch {
      /* noop */
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot consume
  }, [hasTabs, allSteps])



  // Stale persisted tab key (layout/groups changed since last visit) would
  // leave steps/tabs rendering with no active entry — snap to the first one.
  useEffect(() => {
    if (!hasTabs || allSteps.length === 0) return
    if (!allSteps.some((s) => s.key === activeTab)) {
      setActiveTab(allSteps[0].key)
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: setActiveTab is a stable helper
  }, [hasTabs, allSteps, activeTab])

  // Start-skip: a steps-mode group may name fields (skip_if_filled) that, when
  // already populated on an EXISTING record, skip it as the INITIAL step — the
  // form opens on the first step still needing input (an IR with its Unit
  // chosen opens past Unit Selection). One-shot per mount; only advances when
  // the CURRENT step is one being skipped, so a user's later step never yanks.
  const startSkipApplied = useRef(false)
  useEffect(() => {
    if (startSkipApplied.current || isNew || !itemData || groups.length === 0) return
    const parseSkip = (v: unknown): string[] => {
      if (Array.isArray(v)) return v.map(String)
      if (typeof v === 'string' && v.trim()) {
        try {
          const p = JSON.parse(v)
          return Array.isArray(p) ? p.map(String) : []
        } catch {
          return []
        }
      }
      return []
    }
    const skipSatisfied = (g: FieldGroup | undefined) => {
      const fields = parseSkip(g?.skip_if_filled)
      if (fields.length === 0) return false
      return fields.every((f) => {
        const v = itemData[f]
        return v != null && v !== '' && v !== false
      })
    }
    startSkipApplied.current = true
    // Global steps mode
    if (isStepsMode && allSteps.length > 0) {
      if (skipSatisfied(tabGroups.find((x) => x.key === activeTab))) {
        const next = allSteps.find((st) => !skipSatisfied(tabGroups.find((x) => x.key === st.key)))
        if (next && next.key !== activeTab) setActiveTab(next.key)
      }
    }
    // Container steps (the attached-track wizard, e.g. IR layouts): seed each
    // steps container's tab past its skip-satisfied leading steps.
    for (const c of groups.filter((g) => g.type === 'container' && g.tab_mode === 'steps')) {
      const children = groups
        .filter((g) => g.type === 'tab' && g.container_id === c.id)
        .sort((a, b) => a.sort - b.sort)
      if (children.length === 0) continue
      const current = containerTabs.get(c.id) ?? children[0]?.key
      const currentGroup = children.find((g) => g.key === current)
      if (!skipSatisfied(currentGroup)) continue
      const next = children.find((g) => !skipSatisfied(g))
      if (next && next.key !== current)
        setContainerTabs((prev) => new Map(prev).set(c.id, next.key))
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot after data load
  }, [isNew, isStepsMode, itemData, allSteps, tabGroups, activeTab, groups, containerTabs])

  // Unsaved-step dots (#190): steps containing fields the user touched.
  const dirtySteps = useMemo(() => {
    const out = new Set<string>()
    if (!isDirty) return out
    for (const st of allSteps) {
      const fields = groupedMap[st.key] ?? []
      if (fields.some((f) => userTouchedRef.current.has(f.field))) out.add(st.key)
    }
    return out
    // biome-ignore lint/correctness/useExhaustiveDependencies: userTouchedRef mutates with draft
  }, [isDirty, allSteps, groupedMap, draft])

  const completedSteps = useMemo(() => {
    const out = new Set<string>()
    for (const s of allSteps) {
      if (isNew && !visitedSteps.has(s.key)) continue
      const stepFields =
        s.key === '__general__'
          ? isStepsMode
            ? ungroupedFields
            : [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])]
          : (groupedMap[s.key] ?? [])
      const allFilled = stepFields
        .filter((f) => f.required && !f.hidden)
        .every((f) => {
          // Required M2M aliases live in junction state, not the draft.
          if (m2mAliasFieldsForRules.has(f.field)) {
            const st = m2mAliasFieldStates[f.field]
            return !st || st.ids.length > 0
          }
          // Required O2M = at least one row; unsettled count never blocks.
          if (o2mAliasFields.has(f.field)) {
            const n = o2mEffectiveCounts[f.field]
            return n === undefined || n > 0
          }
          const v = draft[f.field]
          return v !== null && v !== undefined && v !== ''
        })
      if (allFilled) out.add(s.key)
    }
    return out
  }, [
    allSteps,
    ungroupedFields,
    sectionGroups,
    groupedMap,
    draft,
    isNew,
    visitedSteps,
    isStepsMode,
    m2mAliasFieldsForRules,
    m2mAliasFieldStates,
    o2mAliasFields,
    o2mEffectiveCounts
  ])

  function handleNext() {
    if (validateBeforeNext) {
      const stepFields =
        activeTab === '__general__'
          ? isStepsMode
            ? ungroupedFields
            : [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])]
          : (groupedMap[activeTab] ?? [])
      const errs: Record<string, string> = {}
      for (const f of stepFields) {
        if (f.required && !f.hidden) {
          const v = draft[f.field]
          if (v === null || v === undefined || v === '') errs[f.field] = 'This field is required'
        }
      }
      if (Object.keys(errs).length > 0) {
        setValidationErrors(errs)
        return
      }
    }
    const idx = allSteps.findIndex((s) => s.key === activeTab)
    if (idx < allSteps.length - 1) setActiveTab(allSteps[idx + 1].key)
  }

  // ── Sentinel slot positioning ──────────────────────────────────────────────
  const pipelineSlot = assignments.find((a) => a.field === '__pipeline__')
  const commentsSlot = assignments.find((a) => a.field === '__comments__')
  const tasksSlot = assignments.find((a) => a.field === '__tasks__')
  const addendumSlot = assignments.find((a) => a.field === '__addendums__')
  const referencedBySlot = assignments.find((a) => a.field === '__referenced_by__')
  const relatedRecordsSlot = assignments.find((a) => a.field === '__related_records__')
  const widgetSlots = assignments.filter(
    (a) => a.field.startsWith('__widget_') && a.field.endsWith('__') && a.widget_id != null
  )
  const ownersSlot = assignments.find((a) => a.field === '__owners__')
  const pdfSlot = assignments.find((a) => a.field === '__pdf__')
  const pdfSlotOverrides = pdfSlot
    ? (() => {
        try {
          return typeof pdfSlot.overrides === 'string'
            ? JSON.parse(pdfSlot.overrides)
            : (pdfSlot.overrides ?? {})
        } catch {
          return {}
        }
      })()
    : null
  const pdfAttachField = (pdfSlotOverrides?.attach_to_field as string | null) ?? null
  const pdfFilenameTemplate = (pdfSlotOverrides?.filename_template as string | null) ?? null
  const pdfGroupKey = pdfSlot?.group_key ?? null
  const pdfInGroup = !!(pdfGroupKey && groups.some((g) => g.key === pdfGroupKey))
  const pdfSourceLayoutId = (pdfSlotOverrides?.source_layout_id as number | null) ?? null
  const pdfAutoGenerate = !!pdfSlotOverrides?.auto_generate_on_save
  const pdfOverwrite = pdfSlotOverrides?.overwrite_generated !== false

  const handleGenerateAndAttach = async (opts?: { itemId?: string; silent?: boolean }) => {
    const targetItem = opts?.itemId ?? itemId
    // source_layout_id names a dedicated PDF (file-type) layout to render —
    // the document's design is rarely the edit form's design. Falls back to
    // the layout being edited.
    const renderLayoutId = pdfSourceLayoutId ?? layoutId
    if (pdfAttaching || !pdfAttachField || !renderLayoutId || !targetItem) return
    setPdfAttaching(true)
    try {
      const workspace =
        typeof window !== 'undefined' ? (localStorage.getItem('nivaro_workspace') ?? '') : ''
      const resp = await fetch(
        `${fetchCfg.apiBase}/collection-layouts/${renderLayoutId}/generate-and-attach`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...fetchCfg.authHeaders,
            ...(workspace ? { 'x-workspace': workspace } : {})
          },
          credentials: fetchCfg.credentials,
          body: JSON.stringify({
            collection,
            item_id: targetItem,
            attach_field: pdfAttachField,
            filename_template: pdfFilenameTemplate,
            replace_generated: pdfOverwrite
          })
        }
      )
      if (!resp.ok) throw new Error(await resp.text())
      // An automatic regeneration is a side effect of saving, not its own
      // event — announcing it every time would be noise.
      if (!opts?.silent) toast.success('PDF generated and attached')
      qc.invalidateQueries({ queryKey: ['m2m-items'] })
      qc.invalidateQueries({ queryKey: ['items', collection, itemId] })
    } catch {
      // A failed regeneration must not read as a failed SAVE — the record is
      // already persisted at this point.
      if (opts?.silent) console.warn('[pdf] automatic regeneration failed')
      else toast.error('Failed to generate and attach PDF')
    } finally {
      setPdfAttaching(false)
    }
  }
  // Owners is a draggable field chip: when assigned to a group it renders inside
  // that group's card (footer slot); otherwise it renders as a standalone panel at
  // its own sort position alongside groups/ungrouped.
  const ownersGroupKey = ownersSlot?.group_key ?? null
  const ownersInGroup = !!(ownersGroupKey && groups.some((g) => g.key === ownersGroupKey))
  const renderOwnersPanel = () => (
    <OwnersSlot
      collection={collection}
      item={itemId}
      title={ownersSlot?.label_override ?? undefined}
      defaultExpanded={ownersSlot?.default_expanded ?? false}
    />
  )

  const headerWidgets = useMemo(
    () =>
      (activeLayoutData?.assignments ?? [])
        .filter(
          (a) =>
            a.field.startsWith('__widget_') &&
            a.field.endsWith('__') &&
            a.widget_id != null &&
            (a.group_key ?? null) === '__header__'
        )
        .map((ws) => ({
          field: ws.field,
          widgetId: ws.widget_id!,
          label: ws.label_override ?? null,
          sort: ws.sort ?? 0,
          inputBindings:
            typeof ws.input_bindings === 'string'
              ? (JSON.parse(ws.input_bindings) as InputBinding[])
              : ([] as InputBinding[])
        })),
    [activeLayoutData]
  )

  const fieldInlineDisplay = useMemo(() => {
    const out: Record<
      string,
      {
        entries: Array<{ field: string; label: string | null; format: string | null }>
        separator: string | null
      }
    > = {}
    for (const a of activeLayoutData?.assignments ?? []) {
      if (!a.field || a.field.startsWith('__')) continue
      try {
        const raw = (a as unknown as Record<string, unknown>).input_bindings
        const parsed: Array<{ key: string; binding_value: string }> =
          typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
        const entry = parsed.find((b) => b.key === '__inline_display__')
        if (entry?.binding_value) {
          const data = JSON.parse(entry.binding_value)
          const isArray = Array.isArray(data)
          const entries = isArray ? data : (data.fields ?? [])
          const separator: string | null = isArray ? null : (data.separator ?? null)
          if (Array.isArray(entries) && entries.length) out[a.field] = { entries, separator }
        }
      } catch {
        /* noop */
      }
    }
    return out
  }, [activeLayoutData])

  const subtitleConfig = useMemo(() => {
    const row = (activeLayoutData?.assignments ?? []).find((a) => a.field === '__subtitle__')
    if (!row) return null
    try {
      const raw = (row as unknown as Record<string, unknown>).input_bindings
      const parsed: Array<{ key: string; binding_value: string }> =
        typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
      const entry = parsed.find((b) => b.key === '__subtitle_config__')
      if (!entry?.binding_value) return null
      const data = JSON.parse(entry.binding_value)
      if (!data.fields || !Array.isArray(data.fields) || !data.fields.length) return null
      return {
        fields: data.fields as Array<{
          field: string
          label: string | null
          color?: string
          weight?: string
          display_as?: string
        }>,
        separator: (data.separator as string) ?? ' | '
      }
    } catch {
      return null
    }
  }, [activeLayoutData])

  const subtitleFieldSet = useMemo<Set<string>>(
    () => new Set((subtitleConfig?.fields ?? []).map((sf) => sf.field)),
    [subtitleConfig]
  )

  // Subtitle fields with an auto_id pattern render their LIVE preview — on new
  // records (nothing stored yet) and on edits (prefix inputs may have changed).
  const autoIdSubtitleMeta = useMemo(() => {
    if (!subtitleConfig) return null
    for (const sf of subtitleConfig.fields) {
      const meta = (fieldConfig ?? []).find((f) => f.field === sf.field)
      if (
        meta &&
        parseJson<{ auto_id?: { pattern?: string } }>(meta.options ?? null)?.auto_id?.pattern
      ) {
        return meta
      }
    }
    return null
  }, [subtitleConfig, fieldConfig])

  // Called unconditionally (rules of hooks); no-ops when meta is null. Staging is
  // passed explicitly — this render sits above the M2MStagingContext provider.
  const autoIdSubtitlePreview = useAutoIdPreview({
    collection,
    field: autoIdSubtitleMeta,
    draft,
    itemId,
    staging: m2mStagingCtx
  })

  const subtitleParts = useMemo(() => {
    if (!subtitleConfig) return []
    const src = (itemData as Record<string, unknown> | null) ?? draft
    return subtitleConfig.fields
      .map((sf) => {
        const isAutoId = sf.field === autoIdSubtitleMeta?.field
        // Non-auto-id fields keep the original behavior: hidden on new records.
        if (isNew && !isAutoId) return null
        let val = src[sf.field]
        if (isAutoId && autoIdSubtitlePreview) val = autoIdSubtitlePreview
        if (val === null || val === undefined || val === '') return null
        return { value: String(val), color: sf.color, weight: sf.weight, display_as: sf.display_as }
      })
      .filter(Boolean) as Array<{
      value: string
      color?: string
      weight?: string
      display_as?: string
    }>
  }, [subtitleConfig, isNew, itemData, draft, autoIdSubtitleMeta, autoIdSubtitlePreview])

  // Full subtitle text for the hover tip + the copy button — the rendered row
  // is capped at 350px and ellipsised, so this is the only place the whole
  // value is available.
  // "Edited 3d ago by Beth" — one activity row for the header chip.
  const { data: lastTouch } = useQuery<{
    action: string
    timestamp: string
    user_id: string | null
    user_name: string | null
  } | null>({
    queryKey: ['last-touch', collection, String(itemId)],
    queryFn: () =>
      client
        .request<{
          data: {
            action: string
            timestamp: string
            user_id: string | null
            user_name: string | null
          } | null
        }>(get(`/last-touch/${collection}/${encodeURIComponent(String(itemId))}`))
        .then((r) => r.data ?? null)
        .catch(() => null),
    enabled: !isNew && !!itemId,
    staleTime: 60_000,
    // The stale-record banner rides this poll — one indexed row a minute,
    // paused while the tab is hidden (react-query default).
    refetchInterval: 60_000
  })

  // Save-as-template dialog (#8) — styled, never a browser prompt.
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [templateShared, setTemplateShared] = useState(false)
  const [templateSaving, setTemplateSaving] = useState(false)

  // Completeness meter (#59): filled ÷ visible-editable fields on this layout,
  // with required gaps called out. Display only — nothing blocks on it.
  // Judged against the CURRENTLY VIEWED layout's own assignments when one is
  // active — a field the open layout doesn't show must not count against the
  // percentage (Rob, 2026-08-24).
  const completeness = useMemo(() => {
    const layoutFieldSet =
      (activeLayoutData?.assignments?.length ?? 0) > 0
        ? new Set(
            (activeLayoutData?.assignments ?? [])
              .filter((a) => !(a.is_visible === 0 || a.is_visible === false))
              .map((a) => a.field)
          )
        : null
    const fields = (fieldConfig ?? []).filter((fc) => {
      if (fc.hidden || (fc as { readonly?: boolean }).readonly) return false
      if ((fc as { computed_type?: string | null }).computed_type) return false
      if ((fc as { layout_assigned?: boolean }).layout_assigned === false) return false
      if (layoutFieldSet && !layoutFieldSet.has(fc.field)) return false
      if (fc.field.startsWith('__') || fc.field.includes('.')) return false
      const opts = fc.options as Record<string, unknown> | null
      if (opts && typeof opts === 'object' && (opts as { auto_id?: unknown }).auto_id) return false
      return true
    })
    // Completeness = REQUIRED layout fields only — optional fields being
    // blank is normal, not incompleteness. No required fields → no pill.
    const required = fields.filter((f) => f.required)
    if (required.length === 0) return null
    const isFilled = (f: (typeof fields)[number]): boolean => {
      const alias = m2mAliasFieldsForRules.get(f.field)
      if (alias) return (m2mAliasFieldStates[f.field]?.ids ?? []).length > 0
      // Required O2M = at least one row; treat an unsettled count as filled.
      if (o2mAliasFields.has(f.field)) return (o2mEffectiveCounts[f.field] ?? 1) > 0
      const v = draft[f.field]
      return v !== undefined && v !== null && v !== '' && v !== false
    }
    const filled = required.filter(isFilled)
    const requiredMissing = required.filter((f) => !isFilled(f))
    return {
      pct: Math.round((filled.length / required.length) * 100),
      filled: filled.length,
      total: required.length,
      requiredMissing: requiredMissing.map((f) => f.label ?? f.field)
    }
  }, [fieldConfig, draft, m2mAliasFieldsForRules, m2mAliasFieldStates, activeLayoutData, o2mAliasFields, o2mEffectiveCounts])

  // Provenance (#29): where the record came from — shown as a chip beside the
  // last-touched line.
  const { data: provenance } = useQuery({
    queryKey: ['provenance', collection, String(itemId)],
    queryFn: () =>
      client
        .request<{ data: { origin: string; timestamp: string; user_name: string | null } | null }>(
          get(`/provenance/${collection}/${encodeURIComponent(String(itemId))}`)
        )
        .then((r) => r.data)
        .catch(() => null),
    enabled: !isNew && !!itemId,
    staleTime: 5 * 60_000
  })
  // Someone else saved while this record was open. Baseline = the last touch
  // this viewer has ACKNOWLEDGED (loaded with, saved themselves, or refreshed
  // past) — comparing touch-to-touch keeps clock skew out of the decision.
  const staleBaselineRef = useRef<string | null>(null)
  const [staleBy, setStaleBy] = useState<string | null>(null)
  useEffect(() => {
    if (isNew || !lastTouch) return
    if (staleBaselineRef.current === null) {
      staleBaselineRef.current = lastTouch.timestamp
      return
    }
    if (lastTouch.timestamp <= staleBaselineRef.current) return
    if (!lastTouch.user_id || lastTouch.user_id === authUserId) {
      // Our own save (or an unattributed system write) advances the baseline.
      staleBaselineRef.current = lastTouch.timestamp
      setStaleBy(null)
      return
    }
    setStaleBy(lastTouch.user_name ?? 'Someone else')
  }, [lastTouch, isNew, authUserId])
  const refreshStaleRecord = useCallback(() => {
    if (lastTouch) staleBaselineRef.current = lastTouch.timestamp
    setStaleBy(null)
    void qc.invalidateQueries({ queryKey: ['item', collection, itemId] })
    void qc.invalidateQueries({ queryKey: ['o2m-rows'] })
    void qc.invalidateQueries({ queryKey: ['pipeline', collection, String(itemId)] })
  }, [lastTouch, qc, collection, itemId])
  const lastTouchText = useMemo(() => {
    if (!lastTouch) return null
    const ms = Date.now() - new Date(lastTouch.timestamp).getTime()
    const mins = Math.floor(ms / 60_000)
    const rel =
      mins < 1
        ? 'just now'
        : mins < 60
          ? `${mins}m ago`
          : mins < 48 * 60
            ? `${Math.floor(mins / 60)}h ago`
            : `${Math.floor(mins / 1440)}d ago`
    const verb = lastTouch.action === 'create' ? 'Created' : 'Edited'
    return `${verb} ${rel}${lastTouch.user_name ? ` by ${lastTouch.user_name}` : ''}`
  }, [lastTouch])

  const subtitleFullText = useMemo(
    () => subtitleParts.map((p) => p.value).join(subtitleConfig?.separator ?? ' | '),
    [subtitleParts, subtitleConfig]
  )

  const headerFields = useMemo(
    () =>
      (activeLayoutData?.assignments ?? [])
        .filter(
          (a) =>
            (a.field === '__owners__' || !a.field.startsWith('__')) &&
            (a.group_key ?? null) === '__header__'
        )
        .map((a) => {
          const meta = (fieldConfig ?? []).find((f) => f.field === a.field)
          let displayFormat = 'text'
          let color: string | undefined
          let weight: string | undefined
          let displayAs: string | undefined
          let linkTemplate: string | undefined
          try {
            const raw = (a as unknown as Record<string, unknown>).input_bindings
            const parsed: Array<{ key: string; binding_value: string }> =
              typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
            const fmt = parsed.find((b) => b.key === '__display_format__')
            if (fmt?.binding_value) displayFormat = fmt.binding_value
            color = parsed.find((b) => b.key === '__color__')?.binding_value || undefined
            weight = parsed.find((b) => b.key === '__weight__')?.binding_value || undefined
            displayAs = parsed.find((b) => b.key === '__display_as__')?.binding_value || undefined
            linkTemplate =
              parsed.find((b) => b.key === '__link_template__')?.binding_value || undefined
          } catch {
            /* noop */
          }
          return {
            field: a.field,
            label: a.label_override ?? titleCase(meta?.label ?? a.field),
            sort: a.sort ?? 0,
            displayFormat,
            color,
            weight,
            displayAs,
            linkTemplate,
            cmsField: meta ?? null
          }
        }),
    [activeLayoutData, fieldConfig]
  )

  useEffect(() => {
    if (!onHeaderWidgets) return
    onHeaderWidgets(headerWidgets)
  }, [headerWidgets, onHeaderWidgets])

  const sectionOrder = useMemo(() => {
    const isVisible = (a: SlotAssignment | undefined) =>
      !(a && (a.is_visible === 0 || a.is_visible === false))
    type Item =
      | FieldGroup
      | '__ungrouped__'
      | '__pipeline__'
      | '__comments__'
      | '__tasks__'
      | '__addendums__'
      | '__referenced_by__'
      | '__related_records__'
      | '__owners__'
      | '__pdf__'
      | string
    const entries: Array<{ item: Item; sort: number; tie: number }> = [
      ...sectionGroups.map((g) => ({ item: g as Item, sort: g.sort, tie: 0 })),
      // Container groups sit alongside section groups in the order
      ...containerGroups.map((g) => ({ item: g as Item, sort: g.sort, tie: 0 })),
      {
        item: '__ungrouped__',
        sort: (() => {
          const saved = activeLayoutData?.ungrouped_sort ?? sectionGroups.length
          // Subtitle fields in the ungrouped zone must appear before panels (not buried below
          // Notes/Tasks). Cap the ungrouped sort to just before the earliest active slot.
          if (
            subtitleFieldSet.size > 0 &&
            ungroupedFields.some((f) => subtitleFieldSet.has(f.field))
          ) {
            const slotSorts = [
              showPipeline && pipelineSlot ? pipelineSlot.sort : null,
              effectiveShowTasks && tasksSlot ? tasksSlot.sort : null,
              effectiveShowComments && commentsSlot ? commentsSlot.sort : null,
              showPipeline && ownersSlot && !ownersInGroup ? ownersSlot.sort : null,
              pdfSlot && !isNew && !pdfInGroup ? pdfSlot.sort : null
            ].filter((s): s is number => s !== null)
            const minSlot = slotSorts.length > 0 ? Math.min(...slotSorts) : Infinity
            if (isFinite(minSlot) && saved >= minSlot) return minSlot - 0.5
          }
          return saved
        })(),
        tie: 1
      }
    ]
    if (showPipeline && pipelineSlot && isVisible(pipelineSlot))
      entries.push({ item: '__pipeline__', sort: pipelineSlot.sort, tie: 2 })
    if (effectiveShowTasks && tasksSlot && isVisible(tasksSlot))
      entries.push({ item: '__tasks__', sort: tasksSlot.sort, tie: 3 })
    if (effectiveShowComments && commentsSlot && isVisible(commentsSlot))
      entries.push({ item: '__comments__', sort: commentsSlot.sort, tie: 4 })
    if (colMeta?.addendums_enabled && !isNew && addendumSlot && isVisible(addendumSlot))
      entries.push({ item: '__addendums__', sort: addendumSlot.sort, tie: 7 })
    if (!isNew && referencedBySlot && isVisible(referencedBySlot))
      entries.push({ item: '__referenced_by__', sort: referencedBySlot.sort, tie: 8 })
    if (!isNew && relatedRecordsSlot && isVisible(relatedRecordsSlot))
      entries.push({ item: '__related_records__', sort: relatedRecordsSlot.sort, tie: 9 })
    if (
      showPipeline &&
      ownersSlot &&
      isVisible(ownersSlot) &&
      !ownersInGroup &&
      ownersGroupKey !== '__header__'
    )
      entries.push({ item: '__owners__', sort: ownersSlot.sort, tie: 5 })
    if (pdfSlot && isVisible(pdfSlot) && !isNew && !pdfInGroup)
      entries.push({ item: '__pdf__', sort: pdfSlot.sort, tie: 6 })
    // Widget slots never render as standalone panels — they appear in groups (GroupSection)
    // or in the page header (__header__ group_key). Skip all of them here.
    // Extension layout slots (#425): __ext_<key>__ assignments render as
    // standalone sections via the window-registered slot plugins.
    for (const a of assignments) {
      if (extSlotKey(a.field) && isVisible(a)) {
        entries.push({ item: a.field, sort: a.sort, tie: 8 })
      }
    }
    return entries.sort((a, b) => a.sort - b.sort || a.tie - b.tie).map((e) => e.item)
  }, [
    sectionGroups,
    containerGroups,
    activeLayoutData,
    pipelineSlot,
    commentsSlot,
    tasksSlot,
    addendumSlot,
    ownersSlot,
    ownersInGroup,
    showPipeline,
    effectiveShowComments,
    effectiveShowTasks,
    pdfSlot,
    pdfInGroup,
    isNew,
    subtitleFieldSet,
    colMeta?.addendums_enabled,
    ungroupedFields,
    ownersGroupKey,
    assignments
  ])

  // ── Client-side validation ─────────────────────────────────────────────────
  function validateAll(): boolean {
    const errs: Record<string, string> = {}
    for (const f of allFields) {
      if (f.hidden || f.readonly || SYSTEM_FIELDS.has(f.field) || isSentinelKey(f.field)) continue
      // A field the RESOLVED layout doesn't render can never be filled from
      // this form — a CAR's layout has no vendor or lines, so their required
      // flags must not block its save (same gate the completeness pill uses).
      if ((f as { layout_assigned?: boolean }).layout_assigned === false) continue
      if (f.required) {
        if (f.field in fieldCounts) {
          if (fieldCounts[f.field] === 0) errs[f.field] = 'This field is required'
        } else if (f.field in m2mAliasFieldStates) {
          // Alias (M2M/M2A) fields have no column in draft — judge by the
          // committed junction state. Unsettled (query in flight) never blocks:
          // a false "required" here froze transitions on steps layouts where the
          // field's combobox hadn't mounted to report a count.
          const st = m2mAliasFieldStates[f.field]
          if (st.known && st.ids.length === 0) errs[f.field] = 'This field is required'
        } else if (o2mAliasFields.has(f.field)) {
          // Required O2M = at least one row, pending or existing. An
          // unsettled count (query in flight) never blocks.
          const n = o2mEffectiveCounts[f.field]
          if (n !== undefined && n === 0) errs[f.field] = 'At least one row is required'
        } else if (
          relations.some((r) => r.one_collection === collection && r.one_field === f.field)
        ) {
          // Other alias shapes (unresolvable M2A) — no draft value exists
          // and no count was reported; skip rather than false-block.
        } else {
          const v = draft[f.field]
          if (v === null || v === undefined || v === '') errs[f.field] = 'This field is required'
        }
      }
      // Field-level validation_rules (min/max/regex/email/url/min_days_from_today…)
      if (!errs[f.field] && f.validation_rules) {
        const rules = (
          typeof f.validation_rules === 'string'
            ? (() => {
                try {
                  return JSON.parse(f.validation_rules)
                } catch {
                  return []
                }
              })()
            : f.validation_rules
        ) as Array<{ type: string; value?: unknown; message?: string; soft?: boolean }>
        if (Array.isArray(rules)) {
          for (const rule of rules) {
            if (!rule || rule.soft) continue
            const err = applyValidationRule(rule, draft[f.field], f.label ?? titleCase(f.field), draft)
            if (err) {
              errs[f.field] = err
              break
            }
          }
        }
      }
    }
    if (Object.keys(errs).length > 0) {
      setValidationErrors(errs)
      // Surface a rule message when the failure isn't a plain required miss.
      const ruleMsg = Object.values(errs).find((m) => m !== 'This field is required')
      toast.error(ruleMsg ?? 'Please fill in all required fields')
      // Jump-to-error (#191): scroll + flash the first invalid field.
      const firstBad = Object.keys(errs)[0]
      if (firstBad) setTimeout(() => flashField(firstBad), 150)
      return false
    }
    return true
  }

  // Client-side pre-flight: if this save WILL trip a change-reason requirement
  // (parent draft or queued O2M row edits touching flagged fields), prompt
  // BEFORE any write starts — otherwise the server 422 arrives mid-save with
  // other steps already committed. The server check remains the backstop.
  async function preflightChangeReason(): Promise<ChangeReasonChallenge | null> {
    if (changeReasonRef.current) return null
    const targets: Array<{ collection: string; changedFields: string[] }> = []
    if (!isNew) {
      const parentChanged = allFields
        .filter(
          (f) =>
            !SYSTEM_FIELDS.has(f.field) &&
            !f.readonly &&
            f.field in draft &&
            !valuesEqual(draft[f.field], initialDataRef.current[f.field])
        )
        .map((f) => f.field)
      if (parentChanged.length) targets.push({ collection, changedFields: parentChanged })
    }
    for (const [key, edits] of pendingO2MEdits.entries()) {
      if (edits.size === 0) continue
      const rc = key.split('.')[0]
      const changed = new Set<string>()
      for (const ch of edits.values())
        for (const k of Object.keys(ch)) if (!k.startsWith('__')) changed.add(k)
      if (changed.size) targets.push({ collection: rc, changedFields: [...changed] })
    }
    for (const t of targets) {
      try {
        const meta = await qc.fetchQuery({
          queryKey: ['collection-meta-cr', t.collection],
          queryFn: () =>
            client
              .request<{
                data: {
                  change_reason_config?: {
                    fields?: string[]
                    reasons?: string[]
                    allow_free_text?: boolean
                  } | null
                }
              }>(get(`/collections/${t.collection}`))
              .then((r) => r.data),
          staleTime: 60_000
        })
        const cfg = meta?.change_reason_config
        if (cfg?.fields?.length) {
          const hit = t.changedFields.filter((f) => cfg.fields!.includes(f))
          if (hit.length) {
            return {
              fields_changed: hit,
              reasons: cfg.reasons ?? [],
              allow_free_text: cfg.allow_free_text !== false
            }
          }
        }
      } catch {
        /* meta unavailable — fall through to the server backstop */
      }
    }
    return null
  }

  const handleSaveRef = useRef<() => void>(() => {})
  // Function declarations hoist — safe to capture here, fresh every render.
  handleSaveRef.current = () => handleSave()
  useEffect(() => {
    if (!registerSaveHandler) return
    registerSaveHandler(() => handleSaveRef.current())
    return () => registerSaveHandler(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref indirection keeps the handle stable
  }, [registerSaveHandler])
  function handleSave() {
    if (!validateAll()) return
    void (async () => {
      const challenge = await preflightChangeReason()
      if (challenge) {
        setCrChallenge(challenge)
        return
      }
      saveMut.mutate()
    })()
  }

  // ── Save / delete ──────────────────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: async () => {
      function errMsg(err: unknown): string {
        const resp = (err as { response?: { data?: { error?: string } } })?.response
        return resp?.data?.error ?? (err instanceof Error ? err.message : 'Failed')
      }
      // A change-reason 422 from any queued row PATCH pauses the save; the
      // dialog retries the whole mutation with the reason applied to every row.
      let flushChallenge: ChangeReasonChallenge | null = null

      // Build step list from pending state
      const hasM2M =
        [...m2mLinks.entries()].some(([, ids]) => ids.length > 0) ||
        [...m2mUnlinks.entries()].some(([, ids]) => ids.size > 0)
      const newO2MKeys = [...pendingO2MRows.entries()]
        .filter(([, r]) => r.length > 0)
        .map(([k]) => k)
      const editO2MKeys = [...pendingO2MEdits.entries()]
        .filter(([, e]) => e.size > 0)
        .map(([k]) => k)
      const delO2MKeys = [...pendingO2MDeletes.entries()]
        .filter(([, d]) => d.size > 0)
        .map(([k]) => k)

      // Detail strings — count only fields that actually changed
      const changedCount = isNew
        ? allFields.filter((f) => !SYSTEM_FIELDS.has(f.field) && !f.readonly && f.field in draft)
            .length
        : allFields.filter((f) => {
            if (SYSTEM_FIELDS.has(f.field) || f.readonly || !(f.field in draft)) return false
            return !valuesEqual(draft[f.field], initialDataRef.current[f.field])
          }).length
      const mainDetail = isNew
        ? `${changedCount} field${changedCount !== 1 ? 's' : ''} set`
        : changedCount === 0
          ? 'No field changes'
          : `${changedCount} field${changedCount !== 1 ? 's' : ''} changed`

      let m2mAdds = 0,
        m2mRemoves = 0
      for (const [, ids] of m2mLinks.entries()) m2mAdds += ids.length
      for (const [, ids] of m2mUnlinks.entries()) m2mRemoves += ids.size
      const m2mDetail = [
        m2mAdds > 0 ? `+${m2mAdds} linked` : '',
        m2mRemoves > 0 ? `-${m2mRemoves} unlinked` : ''
      ]
        .filter(Boolean)
        .join(' · ')

      const flushers = [...gridFlushersRef.current.entries()]
      const steps: SaveStepItem[] = [
        ...(flushers.length > 0
          ? [
              {
                id: 'flush',
                label: 'Save attachments',
                status: 'pending' as SaveStepStatus,
                detail: `${flushers.length} field${flushers.length !== 1 ? 's' : ''} with pending changes`
              }
            ]
          : []),
        {
          id: 'main',
          label: isNew
            ? `Create ${colMeta?.singular || titleCase(collection)}`
            : `Save ${colMeta?.singular || titleCase(collection)}`,
          status: 'pending',
          detail: mainDetail
        },
        ...(hasM2M
          ? [
              {
                id: 'm2m',
                label: 'Update relationships',
                status: 'pending' as SaveStepStatus,
                detail: m2mDetail
              }
            ]
          : []),
        ...newO2MKeys.map((k) => {
          const n = pendingO2MRows.get(k)?.length ?? 0
          return {
            id: `o2m:new:${k}`,
            label: `Add ${titleCase(k.split('.')[0])}`,
            status: 'pending' as SaveStepStatus,
            detail: `${n} new row${n !== 1 ? 's' : ''}`,
            progress: { done: 0, total: n }
          }
        }),
        ...editO2MKeys.map((k) => {
          const n = pendingO2MEdits.get(k)?.size ?? 0
          return {
            id: `o2m:edit:${k}`,
            label: `Update ${titleCase(k.split('.')[0])}`,
            status: 'pending' as SaveStepStatus,
            detail: `${n} row${n !== 1 ? 's' : ''} edited`,
            progress: { done: 0, total: n }
          }
        }),
        ...delO2MKeys.map((k) => {
          const n = pendingO2MDeletes.get(k)?.size ?? 0
          return {
            id: `o2m:del:${k}`,
            label: `Remove from ${titleCase(k.split('.')[0])}`,
            status: 'pending' as SaveStepStatus,
            detail: `${n} row${n !== 1 ? 's' : ''} deleted`,
            progress: { done: 0, total: n }
          }
        })
      ]
      setSaveSteps(steps)
      setSaveDialogOpen(true)

      // ── Grid flushers (file pickers etc.) — run BEFORE the payload build so
      // any onChange fired by a flush callback lands in draftRef and ships in
      // the main PATCH. Junction commits (pending-save M2M) also happen here.
      if (flushers.length > 0) {
        updateStep('flush', { status: 'running' })
        try {
          for (const [, fn] of flushers) await fn()
          updateStep('flush', { status: 'done' })
        } catch (err) {
          updateStep('flush', { status: 'error', error: errMsg(err) })
          throw err
        }
      }

      // ── Main form ──────────────────────────────────────────────────────────
      updateStep('main', { status: 'running' })
      const payload: Record<string, unknown> = {}
      const initial = initialDataRef.current
      const draftNow = draftRef.current
      for (const f of allFields) {
        if (SYSTEM_FIELDS.has(f.field) || f.readonly) continue
        if (!(f.field in draftNow)) continue
        const cur = draftNow[f.field]
        const orig = initial[f.field]
        // Always include all fields for new records; for edits, only include changed values
        if (isNew || !valuesEqual(cur, orig)) {
          payload[f.field] = cur
        }
      }
      if (changeReasonRef.current) payload._change_reason = changeReasonRef.current
      if (!isNew) {
        const base = baseRevisionOverrideRef.current ?? baseRevisionData?.latest ?? null
        if (base != null) payload._base_revision = base
      }
      let savedId: string
      try {
        if (isNew) {
          const r = await client.request<{ data: { id: string | number } }>(
            post(`/items/${collection}`, payload)
          )
          savedId = String(r.data.id)
        } else if (Object.keys(payload).length > 0) {
          await client.request(patch(`/items/${collection}/${itemId}`, payload))
          savedId = itemId
        } else {
          // No field changes — skip PATCH to avoid empty update error
          savedId = itemId
        }
        updateStep('main', { status: 'done' })
      } catch (err) {
        const challenge = changeReasonChallenge(err)
        if (challenge) {
          updateStep('main', { status: 'error', error: 'Waiting for a change reason' })
          setCrChallenge(challenge)
          throw err
        }
        const collResp = (
          err as {
            response?: {
              data?: {
                code?: string
                conflicts?: Array<{ field: string; current_value: unknown }>
                latest_revision?: number
              }
            }
          }
        )?.response?.data
        if (collResp?.code === 'MIDAIR_COLLISION' && Array.isArray(collResp.conflicts)) {
          updateStep('main', { status: 'error', error: 'Someone else changed this record' })
          const mine: Record<string, unknown> = {}
          for (const c of collResp.conflicts) mine[c.field] = payload[c.field]
          setCollision({
            conflicts: collResp.conflicts,
            latest: Number(collResp.latest_revision) || 0,
            mine
          })
          throw err
        }
        const msg = errMsg(err)
        updateStep('main', { status: 'error', error: msg })
        const resp = (err as { response?: { data?: { error?: string; field?: string } } })?.response
        if (resp?.data?.field)
          setValidationErrors({ [resp.data.field]: resp.data.error ?? 'Invalid' })
        throw err
      }

      // ── M2M ───────────────────────────────────────────────────────────────
      const findM2MRel = (
        stagingKey: string
      ): (CMSRelation & { junction_field: string }) | null => {
        const byField = relations.find(
          (r) => r.one_field === stagingKey && r.one_collection === collection
        )
        if (byField) {
          const jf =
            byField.junction_field ??
            relations.find(
              (c) => c.many_collection === byField.many_collection && c.id !== byField.id
            )?.many_field ??
            null
          return jf ? { ...byField, junction_field: jf } : null
        }
        const parts = stagingKey.split('.')
        if (parts.length === 2) {
          const [mc, jf] = parts
          const r = relations.find((rel) => rel.many_collection === mc)
          return r ? { ...r, junction_field: jf } : null
        }
        return null
      }

      if (hasM2M) {
        updateStep('m2m', { status: 'running' })
        try {
          const m2mOps: Promise<unknown>[] = []
          for (const [key, ids] of m2mUnlinks.entries()) {
            if (!ids.size) continue
            const rel = findM2MRel(key)
            if (!rel) continue
            for (const jId of ids)
              m2mOps.push(
                client.request(del(`/items/${rel.many_collection}/${jId}`)).catch(() => {})
              )
          }
          for (const [key, ids] of m2mLinks.entries()) {
            if (!ids.length) continue
            const rel = findM2MRel(key)
            if (!rel) continue
            // M2A junctions carry a collection-discriminator column — omit it
            // and the row is unreadable by anything that filters on it.
            const companion = relations.find(
              (c) =>
                c.many_collection === rel.many_collection &&
                c.many_field === rel.junction_field &&
                c.id !== rel.id
            )
            const m2a = m2aWriteMeta(companion)
            const extra = m2a ? { [m2a.field]: m2a.value } : {}
            for (const relId of ids)
              m2mOps.push(
                client
                  .request(
                    post(`/items/${rel.many_collection}`, {
                      [rel.many_field!]: savedId,
                      [rel.junction_field]: relId,
                      ...extra
                    })
                  )
                  .catch(() => {})
              )
          }
          await Promise.all(m2mOps)
          updateStep('m2m', { status: 'done' })
        } catch (err) {
          updateStep('m2m', { status: 'error', error: errMsg(err) })
        }
      }

      // ── Comments (new only) ────────────────────────────────────────────────
      if (isNew && pendingComments.length > 0) {
        await Promise.all(
          pendingComments.map((text) =>
            client.request(post('/comments', { collection, item: savedId, text })).catch(() => {})
          )
        )
      }

      // ── O2M new rows ───────────────────────────────────────────────────────
      for (const key of newO2MKeys) {
        const stepId = `o2m:new:${key}`
        const [rc, mf] = key.split('.')
        const rowList = pendingO2MRows.get(key) ?? []
        const uniqueBy = o2mUniqueByMap.get(key)
        if (uniqueBy?.length) {
          const getUK = (r: Record<string, unknown>) =>
            uniqueBy.map((f) => String(r[f] ?? '')).join('\x00')
          const seen = new Set<string>()
          const hasDup = rowList.some((r) => {
            const k = getUK(r)
            if (seen.has(k)) return true
            seen.add(k)
            return false
          })
          if (hasDup) {
            updateStep(stepId, {
              status: 'error',
              error: `Duplicate ${uniqueBy.join(' + ')} values in new rows`
            })
            continue
          }
        }
        updateStep(stepId, { status: 'running', progress: { done: 0, total: rowList.length } })
        try {
          let nestedFailures = 0
          await Promise.all(
            rowList.map(async (data) => {
              const o2mEntries = Object.entries(data).filter(([k]) => k.startsWith('__o2m_'))
              const cleanData = Object.fromEntries(
                Object.entries(data).filter(([k]) => !k.startsWith('__o2m_'))
              )
              const res = await client.request<{ data: { id: unknown } }>(
                post(`/items/${rc}`, { ...cleanData, [mf]: savedId })
              )
              const childId = res?.data?.id
              updateStep(stepId, (s) => ({
                progress: { done: (s.progress?.done ?? 0) + 1, total: rowList.length }
              }))
              for (const [o2mKey, members] of o2mEntries) {
                const field = o2mKey.slice('__o2m_'.length)
                const grandRel = relations.find(
                  (r) => r.one_collection === rc && r.one_field === field
                )
                const memberList = Array.isArray(members)
                  ? (members as Record<string, unknown>[])
                  : []
                // A missing child id would silently orphan members (undefined FK drops
                // from the JSON body) — count them as failures instead, like the
                // InlineTableField path's newRowId guard.
                if (childId == null || !grandRel?.many_collection || !grandRel.many_field) {
                  nestedFailures += memberList.length
                  continue
                }
                for (const member of memberList) {
                  try {
                    await client.request(
                      post(`/items/${grandRel.many_collection}`, {
                        ...member,
                        [grandRel.many_field]: childId
                      })
                    )
                  } catch {
                    nestedFailures++
                  }
                }
              }
            })
          )
          updateStep(
            stepId,
            nestedFailures > 0
              ? {
                  status: 'error',
                  error: `${nestedFailures} nested row${nestedFailures !== 1 ? 's' : ''} failed`
                }
              : { status: 'done' }
          )
        } catch (err) {
          updateStep(stepId, { status: 'error', error: errMsg(err) })
        }
      }

      // ── O2M edits ─────────────────────────────────────────────────────────
      const nextEdits = new Map(pendingO2MEdits)
      for (const key of editO2MKeys) {
        const stepId = `o2m:edit:${key}`
        const [rc] = key.split('.')
        const edits = pendingO2MEdits.get(key) ?? new Map()
        updateStep(stepId, { status: 'running', progress: { done: 0, total: edits.size } })
        let hasErr = false
        let nestedFailures = 0
        // Rows that still have unapplied work after this pass (main PATCH failed, or some
        // nested ops failed) — rebuilt per-row so a retry only re-attempts what actually
        // failed, instead of re-running every op (which would duplicate creates/deletes).
        const remainingRows = new Map<string, Record<string, unknown>>()
        await Promise.all(
          [...edits.entries()].map(async ([rowId, changes]) => {
            // __nested_ops_* keys stage a NestedRelationEditor's grandchild ops (F3) — strip
            // them from the PATCH payload and apply them against the resolved relation instead.
            const nestedOpsEntries = Object.entries(changes).filter(([k]) =>
              k.startsWith('__nested_ops_')
            )
            const cleanChanges = Object.fromEntries(
              Object.entries(changes).filter(([k]) => !k.startsWith('__nested_ops_'))
            )
            let rowPatchFailed = false
            if (Object.keys(cleanChanges).length > 0) {
              if (changeReasonRef.current) cleanChanges._change_reason = changeReasonRef.current
              await client.request(patch(`/items/${rc}/${rowId}`, cleanChanges)).catch((err) => {
                hasErr = true
                rowPatchFailed = true
                const challenge = changeReasonChallenge(err)
                if (challenge) {
                  flushChallenge = challenge
                  updateStep(stepId, { status: 'error', error: 'Waiting for a change reason' })
                } else {
                  updateStep(stepId, { status: 'error', error: errMsg(err) })
                }
              })
            }
            if (rowPatchFailed) {
              // Gate: the row's own edit didn't land — retain the queued edit UNCHANGED (nested
              // ops included) rather than attempting grandchild writes for a rejected parent edit.
              remainingRows.set(rowId, changes)
              updateStep(stepId, (s) => ({
                progress: { done: (s.progress?.done ?? 0) + 1, total: edits.size }
              }))
              return
            }
            const remainingChanges: Record<string, unknown> = {}
            for (const [opsKey, opsVal] of nestedOpsEntries) {
              const field = opsKey.slice('__nested_ops_'.length)
              const grandRel = relations.find(
                (r) => r.one_collection === rc && r.one_field === field
              )
              const ops = opsVal as NestedOps
              if (!grandRel?.many_collection || !grandRel.many_field) {
                nestedFailures += ops.created.length + ops.updated.length + ops.deleted.length
                remainingChanges[opsKey] = ops
                continue
              }
              const { many_collection, many_field } = grandRel
              const failedCreated: Record<string, unknown>[] = []
              const failedUpdated: { id: string; changes: Record<string, unknown> }[] = []
              const failedDeleted: string[] = []
              await Promise.all(
                ops.created.map((draftRow) =>
                  client
                    .request(
                      post(`/items/${many_collection}`, { ...draftRow, [many_field]: rowId })
                    )
                    .catch(() => {
                      nestedFailures++
                      failedCreated.push(draftRow)
                    })
                )
              )
              await Promise.all(
                ops.updated.map((u) =>
                  client
                    .request(patch(`/items/${many_collection}/${u.id}`, u.changes))
                    .catch(() => {
                      nestedFailures++
                      failedUpdated.push(u)
                    })
                )
              )
              // Deletes last, after creates/updates for this same flush have had a chance to land.
              await Promise.all(
                ops.deleted.map((id) =>
                  client.request(del(`/items/${many_collection}/${id}`)).catch(() => {
                    nestedFailures++
                    failedDeleted.push(id)
                  })
                )
              )
              // Prune: only the ops that actually failed ride along on a retry.
              if (failedCreated.length || failedUpdated.length || failedDeleted.length) {
                remainingChanges[opsKey] = {
                  created: failedCreated,
                  updated: failedUpdated,
                  deleted: failedDeleted
                }
              }
            }
            if (Object.keys(remainingChanges).length > 0) remainingRows.set(rowId, remainingChanges)
            updateStep(stepId, (s) => ({
              progress: { done: (s.progress?.done ?? 0) + 1, total: edits.size }
            }))
          })
        )
        if (remainingRows.size > 0) nextEdits.set(key, remainingRows)
        else nextEdits.delete(key)
        if (!hasErr && nestedFailures === 0) {
          updateStep(stepId, { status: 'done' })
        } else if (!hasErr) {
          updateStep(stepId, {
            status: 'error',
            error: `${nestedFailures} nested row${nestedFailures !== 1 ? 's' : ''} failed`
          })
        }
      }
      setPendingO2MEdits(nextEdits)
      if (flushChallenge) setCrChallenge(flushChallenge)

      // ── O2M deletes ───────────────────────────────────────────────────────
      const nextDels = new Map(pendingO2MDeletes)
      for (const key of delO2MKeys) {
        const stepId = `o2m:del:${key}`
        const [rc] = key.split('.')
        const dels = pendingO2MDeletes.get(key) ?? new Set()
        updateStep(stepId, { status: 'running', progress: { done: 0, total: dels.size } })
        let hasErr = false
        await Promise.all(
          [...dels].map(async (rowId) => {
            await client.request(del(`/items/${rc}/${rowId}`)).catch((err) => {
              hasErr = true
              updateStep(stepId, { status: 'error', error: errMsg(err) })
            })
            updateStep(stepId, (s) => ({
              progress: { done: (s.progress?.done ?? 0) + 1, total: dels.size }
            }))
          })
        )
        if (!hasErr) {
          updateStep(stepId, { status: 'done' })
          nextDels.delete(key)
        }
      }
      setPendingO2MDeletes(nextDels)

      // ── Tasks (new only) ──────────────────────────────────────────────────
      if (isNew && pendingTasks.length > 0) {
        await Promise.all(
          pendingTasks.map((t) =>
            client
              .request(
                post('/tasks', {
                  collection,
                  item: savedId,
                  title: t.title,
                  assignee: t.assignee,
                  due_date: t.due_date || undefined
                })
              )
              .catch(() => {})
          )
        )
      }

      return savedId
    },
    onSuccess: (id) => {
      // Save ceremony (#318): the button morphs to a check and each field the
      // user actually touched gets a one-time glow sweep. Purely cosmetic —
      // read from userTouchedRef BEFORE the dirty state clears.
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 1600)
      // Rich-text mentions (#188): "@First Last" typed into a rich-text body
      // the user just changed notifies that person (exact directory-name
      // match, case-insensitive; best-effort, never blocks the save).
      void (async () => {
        try {
          const richFields = (fieldConfig ?? []).filter(
            (f) =>
              userTouchedRef.current.has(f.field) &&
              ['wysiwyg', 'rich_text', 'input-rich-text-html', 'rich-text-html'].includes(
                String(f.interface ?? '')
              )
          )
          if (richFields.length === 0) return
          const names = new Set<string>()
          for (const f of richFields) {
            const html = String(draft[f.field] ?? '')
            const text = html.replace(/<[^>]+>/g, ' ')
            for (const m of text.matchAll(/@([A-Z][a-z]+ [A-Z][a-zA-Z'-]+)/g)) names.add(m[1])
          }
          if (names.size === 0) return
          const res = (await client.request(
            get('/users', { limit: '500' })
          )) as { data?: Array<{ id: string; first_name?: string; last_name?: string }> }
          for (const name of names) {
            const hit = (res.data ?? []).find(
              (u) =>
                `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim().toLowerCase() ===
                name.toLowerCase()
            )
            if (hit) {
              await client.request(
                post('/notifications', {
                  recipient: hit.id,
                  subject: `You were mentioned on ${collection}/${id}`,
                  message: `Mentioned in a note on this record.`,
                  collection,
                  item: String(id)
                })
              )
            }
          }
        } catch {
          /* mention delivery is best-effort */
        }
      })()
      try {
        for (const f of userTouchedRef.current) {
          const el = document.querySelector(`[data-field="${CSS.escape(f)}"]`)
          if (el) {
            el.classList.remove('nvr-saved-glow')
            void (el as HTMLElement).offsetWidth
            el.classList.add('nvr-saved-glow')
            setTimeout(() => el.classList.remove('nvr-saved-glow'), 1000)
          }
        }
      } catch {
        /* cosmetic only */
      }
      changeReasonRef.current = null
      baseRevisionOverrideRef.current = null
      void qc.invalidateQueries({ queryKey: ['collision-base', collection] })
      setIsDirty(false)
      setM2mLinks(new Map())
      setM2mUnlinks(new Map())
      setPendingComments([])
      setPendingTasks([])
      // Invalidate O2M row queries for every relation that had pending changes
      const o2mKeysToInvalidate = new Set([
        ...pendingO2MRows.keys(),
        ...pendingO2MEdits.keys(),
        ...pendingO2MDeletes.keys()
      ])
      for (const key of o2mKeysToInvalidate) {
        const dotIdx = key.indexOf('.')
        const rc = key.slice(0, dotIdx)
        const mf = key.slice(dotIdx + 1)
        qc.invalidateQueries({ queryKey: ['o2m-rows', rc, mf, id] })
      }
      setPendingO2MRows(new Map())
      // Staged grandchild ops just flushed — the widget registry must stop
      // reporting them (a grid unmounted on another tab can't re-report).
      stagedRelsSigRef.current.clear()
      setStagedRelsByGrid(new Map())
      qc.invalidateQueries({ queryKey: ['item', collection] })
      qc.invalidateQueries({ queryKey: ['m2m-items'] })
      // Record Insights caches (audience, integrations, owner history, mail,
      // mentions) go stale the moment a save lands — refresh them so the
      // popover answers with current data.
      invalidateRecordInsights(qc, collection, String(id))
      // Refresh the attached document so it reflects what was just saved.
      // Fire-and-forget: the save is already committed and the record must not
      // appear to fail because a PDF could not be produced.
      if (pdfAutoGenerate && pdfAttachField) {
        void handleGenerateAndAttach({ itemId: String(id), silent: true }).then(() => {
          qc.invalidateQueries({ queryKey: ['m2m-items'] })
        })
      }
      // Auto-close dialog after brief success display
      setTimeout(() => {
        setSaveDialogOpen(false)
        toast.success(isNew ? 'Record created' : 'Changes saved')
        onSaved?.(id)
      }, 1200)
    },
    onError: () => {
      // Dialog stays open showing error steps; user dismisses manually
    }
  })

  const deleteMut = useMutation({
    mutationFn: () => client.request(del(`/items/${collection}/${itemId}`)),
    onSuccess: () => {
      toast.success('Record deleted')
      qc.invalidateQueries({ queryKey: ['item', collection] })
      onDeleted?.()
    },
    onError: () => toast.error('Failed to delete')
  })

  const [confirmDelete, setConfirmDelete] = useState(false)

  // ── Render helpers ─────────────────────────────────────────────────────────
  const visibleFields = new Set<string>()
  const lockedFields = new Set<string>()
  // Someone else holds the edit lock: every field is locked, not just the ones
  // with lock conditions. Two render paths draw fields — one consulted
  // `isReadOnly` directly, the other only this set — so a grouped layout (which
  // is most of them) showed the "read-only until the lock is released" banner
  // over a form that was still fully editable. Locking at the source means any
  // future render path inherits it instead of having to remember.
  if (isReadOnly) {
    for (const f of fieldConfig ?? []) lockedFields.add(f.field)
  }
  if (hasLockConditions) {
    const currentRole = currentUserData?.role ?? null
    const currentStateId = pipelineInstanceData?.instance?.current_state ?? null
    const currentStateKey = currentStateId
      ? ((pipelineInstanceData?.states ?? []).find((s) => s.id === currentStateId)?.key ?? null)
      : null
    for (const a of assignments) {
      if (!a.lock_conditions) continue
      let conds: Array<{ type: string; state_keys?: string[]; role_ids?: string[] }> = []
      try {
        conds = JSON.parse(a.lock_conditions)
      } catch {
        continue
      }
      const locked = conds.some((c) => {
        if (c.type === 'pipeline_state' && c.state_keys?.length)
          return c.state_keys.includes(currentStateKey ?? '')
        if (c.type === 'role' && c.role_ids?.length) return c.role_ids.includes(currentRole ?? '')
        return false
      })
      if (locked) lockedFields.add(a.field)
    }
  }

  function renderSentinel(key: string) {
    if (key === '__pipeline__' && showPipeline) {
      return (
        <PipelinePanel
          key='__pipeline__'
          collection={pipelineCollection}
          item={pipelineItem}
          title={pipelineSlot?.label_override ?? undefined}
          defaultExpanded={pipelineSlot?.default_expanded ?? false}
          showApprovalChain={
            !!(pipelineSlot as unknown as Record<string, unknown>)?.show_approval_chain
          }
          onBeforeTransition={validateAll}
          addendumPending={
            !viewingAddendum && activeAddendumCount > 0 && !!colMeta?.addendums_enabled
          }
          addendumView={viewingAddendum}
        />
      )
    }
    if (key === '__comments__' && effectiveShowComments) {
      return (
        <CommentPanel
          key='__comments__'
          collection={collection}
          item={itemId}
          title={commentsSlot?.label_override ?? undefined}
          defaultExpanded={commentsSlot?.default_expanded ?? false}
          queuedComments={isNew ? pendingComments : undefined}
          onQueueComment={isNew ? handleQueueComment : undefined}
        />
      )
    }
    if (key === '__tasks__' && effectiveShowTasks) {
      return (
        <TaskPanel
          key='__tasks__'
          collection={collection}
          item={itemId}
          title={tasksSlot?.label_override ?? undefined}
          defaultExpanded={tasksSlot?.default_expanded ?? false}
          queuedTasks={isNew ? pendingTasks : undefined}
          onQueueTask={isNew ? handleQueueTask : undefined}
        />
      )
    }
    if (key === '__addendums__' && colMeta?.addendums_enabled && !isNew) {
      return (
        <AddendumPanel
          key='__addendums__'
          collection={collection}
          item={itemId}
          addendumLayoutId={activeLayoutData?.layout?.addendum_layout_id ?? null}
          canCreate={addendumCanCreate}
          onActiveCountChange={setActiveAddendumCount}
          defaultExpanded={addendumSlot ? !!addendumSlot.default_expanded : true}
        />
      )
    }
    if (key === '__referenced_by__' && !isNew && itemId) {
      return (
        <ReferencedByPanel
          key='__referenced_by__'
          collection={collection}
          itemId={String(itemId)}
          title={referencedBySlot?.label_override ?? undefined}
          defaultExpanded={referencedBySlot?.default_expanded ?? true}
        />
      )
    }
    if (key === '__related_records__' && !isNew && itemId) {
      return (
        <RelatedRecordsPanel
          key='__related_records__'
          collection={collection}
          itemId={String(itemId)}
          title={relatedRecordsSlot?.label_override ?? undefined}
          defaultExpanded={relatedRecordsSlot?.default_expanded ?? false}
        />
      )
    }
    if (key === '__owners__' && showPipeline) {
      return <div key='__owners__'>{renderOwnersPanel()}</div>
    }
    if (key.startsWith('__widget_') && key.endsWith('__')) {
      const slot = widgetSlots.find((a) => a.field === key)
      if (!slot || !slot.widget_id) return null
      let bindings: InputBinding[] = []
      try {
        bindings = typeof slot.input_bindings === 'string' ? JSON.parse(slot.input_bindings) : []
      } catch {
        /* noop */
      }
      return (
        <WidgetSlot
          key={key}
          widgetId={slot.widget_id}
          inputBindings={bindings}
          itemDraft={draft}
          itemCollection={collection}
          ready={isNew || (!itemLoading && Object.keys(draft).length > 0)}
          label={slot.label_override ?? undefined}
          defaultExpanded={slot.default_expanded ?? true}
        />
      )
    }
    {
      const extKey = extSlotKey(key)
      if (extKey) {
        return (
          <ExtLayoutSlot
            key={key}
            slotKey={extKey}
            collection={collection}
            itemId={isNew ? null : String(itemId)}
            draft={draft}
          />
        )
      }
    }
    if (key === '__pdf__') {
      const layoutId = activeLayoutData?.layout?.id
      if (!layoutId) return null
      const label = pdfSlot?.label_override?.trim() || 'Generate PDF'
      const notConfigured = !pdfAttachField
      return (
        <div key='__pdf__' className='flex items-center gap-2 px-1'>
          <button
            type='button'
            onClick={() => void handleGenerateAndAttach()}
            disabled={pdfAttaching || notConfigured}
            title={notConfigured ? 'Configure PDF field in Data Model → Layouts' : undefined}
            className='inline-flex items-center gap-1.5 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/10 px-3 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-nvr-cyan'
          >
            <svg
              xmlns='http://www.w3.org/2000/svg'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
              className='h-3.5 w-3.5'
            >
              <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
              <polyline points='14 2 14 8 20 8' />
              <line x1='9' y1='13' x2='15' y2='13' />
              <line x1='9' y1='17' x2='13' y2='17' />
            </svg>
            {pdfAttaching ? 'Generating…' : label}
          </button>
        </div>
      )
    }
    return null
  }

  function renderUngrouped() {
    const visible = ungroupedFields.filter((f) => !f.hidden)
    if (visible.length === 0) return null
    return (
      <div key='__ungrouped__' className='rounded-xl border border-slate-200 bg-white px-5 py-5'>
        <GridContainer>
          {(cw) =>
            visible.map((f) => {
              const inlineConfig = fieldInlineDisplay?.[f.field]
              const inlineEntries = inlineConfig?.entries
              const inlineSeparator = inlineConfig?.separator ?? null
              const rawVal = draft[f.field]
              const hasVal = rawVal !== null && rawVal !== undefined && rawVal !== ''
              const inlineRelCollection =
                inlineEntries?.length && hasVal
                  ? (relations.find(
                      (r) =>
                        r.many_collection === collection &&
                        r.many_field === f.field &&
                        !r.junction_field
                    )?.one_collection ?? null)
                  : null
              return (
                <div key={f.field} style={{ gridColumn: `span ${resolveColSpan(f.options, cw)}` }}>
                  <FieldRow
                    field={f}
                    draft={effectiveDraft}
                    onChange={handleFieldChange}
                    relations={relations}
                    collection={collection}
                    itemId={itemId}
                    error={validationErrors[f.field]}
                    visible={true}
                    locked={isReadOnly || addendumViewId !== 'original'}
                    layoutAiEnabled={layoutAiEnabled}
                    renderField={renderField}
                    onCountChange={handleM2MCountChange}
                  />
                  {inlineEntries?.length && hasVal && inlineRelCollection && (
                    <InlineDisplay
                      relCollection={inlineRelCollection}
                      relId={rawVal as string | number}
                      entries={inlineEntries}
                      separator={inlineSeparator}
                    />
                  )}
                </div>
              )
            })
          }
        </GridContainer>
      </div>
    )
  }

  function renderContainer(c: FieldGroup) {
    const children = groups
      .filter((g) => g.type === 'tab' && g.container_id === c.id)
      .sort((a, b) => a.sort - b.sort)
    if (children.length === 0) return null
    const isSteps = c.tab_mode === 'steps'
    const activeKey = getContainerTab(c, children)
    const activeChild = children.find((g) => g.key === activeKey) ?? children[0]
    const activeSwapCfg = (() => {
      try {
        return activeChild?.swap_config
          ? (JSON.parse(activeChild.swap_config) as {
              enabled: boolean
              primary_field: string
              alternate_fields: ({ field: string; width: 1 | 2 } | string)[]
              toggle_label?: string
              back_label?: string
            })
          : null
      } catch {
        return null
      }
    })()
    const normActiveAlts = (activeSwapCfg?.alternate_fields ?? []).map((x) =>
      typeof x === 'string' ? { field: x, width: 2 as const } : x
    )
    const activeIsSwapped = activeSwapCfg?.enabled
      ? swappedGroups.has(activeChild?.id ?? -1)
      : false
    const activeFields = (groupedMap[activeChild?.key ?? ''] ?? []).filter((f) => !f.hidden)
    // PDF slot: check if assigned to the active child tab or to the container itself
    const pdfInContainer =
      !isNew &&
      !!layoutId &&
      !!pdfSlot &&
      (pdfGroupKey === activeChild?.key || pdfGroupKey === c.key)

    const containerCompleted = new Set<string>()
    const containerErrors = new Set<string>()
    for (const ch of children) {
      if (isNew && !isContainerTabVisited(c, ch.key)) continue
      const chFields = groupedMap[ch.key] ?? []
      const hasError = chFields.some((f) => validationErrors[f.field])
      if (hasError) containerErrors.add(ch.key)
      const requiredFields = chFields.filter((f) => f.required && !f.hidden)
      const allFilled =
        requiredFields.length === 0 ||
        requiredFields.every((f) => {
          // Required M2M aliases have no draft column — judge them by the
          // committed junction state (same rule as validateAll; an unsettled
          // alias never blocks). Without this the step stayed grey forever.
          if (m2mAliasFieldsForRules.has(f.field)) {
            const st = m2mAliasFieldStates[f.field]
            return !st || st.ids.length > 0
          }
          // Required O2M = at least one row; unsettled count never blocks.
          if (o2mAliasFields.has(f.field)) {
            const n = o2mEffectiveCounts[f.field]
            return n === undefined || n > 0
          }
          const v = draft[f.field]
          return v !== null && v !== undefined && v !== ''
        })
      if (allFilled) containerCompleted.add(ch.key)
    }

    return (
      <div key={c.key} className='rounded-xl border border-slate-200 bg-white'>
        {isSteps ? (
          <StepsBar
            steps={children.map((g) => ({ key: g.key, label: g.label }))}
            active={activeKey}
            completed={containerCompleted}
            errorSteps={containerErrors}
            dirtySteps={
              new Set(
                children
                  .filter((g) =>
                    (groupedMap[g.key] ?? []).some((f) => userTouchedRef.current.has(f.field))
                  )
                  .map((g) => g.key)
              )
            }
            onStepClick={(k) => setContainerTab(c, k)}
            embedded
          />
        ) : (
          <div className='flex border-b border-slate-100'>
            {children.map((g) => (
              <button
                key={g.key}
                type='button'
                onClick={() => setContainerTab(c, g.key)}
                className={cn(
                  'px-5 py-3 text-sm font-medium transition-colors',
                  g.key === activeKey
                    ? 'border-b-2 border-nvr-cyan text-nvr-cyan'
                    : 'text-slate-500 hover:text-slate-700'
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}
        <div className='px-5 py-5'>
          <GridContainer>
            {(cw) =>
              activeFields.map((f) => {
                const inlineConfig = fieldInlineDisplay?.[f.field]
                const inlineEntries = inlineConfig?.entries
                const inlineSeparator = inlineConfig?.separator ?? null
                const rawVal = draft[f.field]
                const hasVal = rawVal !== null && rawVal !== undefined && rawVal !== ''
                const inlineRelCollection =
                  inlineEntries?.length && hasVal
                    ? (relations.find(
                        (r) =>
                          r.many_collection === collection &&
                          r.many_field === f.field &&
                          !r.junction_field
                      )?.one_collection ?? null)
                    : null
                const isPrimarySwapField =
                  activeSwapCfg?.enabled && f.field === activeSwapCfg.primary_field
                const primaryHasVal = (() => {
                  const v = draft[activeSwapCfg?.primary_field ?? '']
                  return v !== null && v !== undefined && v !== ''
                })()
                const altHasVal = normActiveAlts.some((a) => {
                  const v = draft[a.field]
                  return v !== null && v !== undefined && v !== ''
                })
                const swapToggleBtn = isPrimarySwapField ? (
                  <span className='inline-flex items-center gap-1.5'>
                    <button
                      type='button'
                      onClick={() =>
                        setSwappedGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(activeChild!.id)) next.delete(activeChild!.id)
                          else next.add(activeChild!.id)
                          return next
                        })
                      }
                      className='inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/10 transition-colors'
                    >
                      {activeIsSwapped
                        ? (activeSwapCfg!.back_label ?? 'Back')
                        : (activeSwapCfg!.toggle_label ?? 'Enter manually')}
                    </button>
                    <span
                      className={[
                        'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium',
                        primaryHasVal
                          ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
                          : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'h-1.5 w-1.5 rounded-full',
                          primaryHasVal ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
                        ].join(' ')}
                      />
                      Original
                    </span>
                    <span
                      className={[
                        'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium',
                        altHasVal
                          ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
                          : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'h-1.5 w-1.5 rounded-full',
                          altHasVal ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
                        ].join(' ')}
                      />
                      Manual
                    </span>
                  </span>
                ) : undefined
                const swapContentNode =
                  isPrimarySwapField && activeIsSwapped ? (
                    <div className='mt-2 rounded-lg border border-slate-200 bg-slate-50 dark:border-border dark:bg-slate-900/40 p-3'>
                      <div className='grid grid-cols-2 gap-3'>
                        {normActiveAlts.map((a) => {
                          const af = (fieldConfig ?? []).find((fc) => fc.field === a.field)
                          if (!af) return null
                          return (
                            <div key={af.field} style={{ gridColumn: `span ${a.width}` }}>
                              <FieldRow
                                field={af}
                                draft={effectiveDraft}
                                onChange={handleFieldChange}
                                relations={relations}
                                collection={collection}
                                itemId={itemId}
                                error={validationErrors[af.field]}
                                visible={true}
                                forceVisible={true}
                                locked={lockedFields.has(af.field) || addendumViewId !== 'original'}
                                layoutAiEnabled={layoutAiEnabled}
                                renderField={renderField}
                                onCountChange={handleM2MCountChange}
                              />
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : undefined
                return (
                  <div
                    key={f.field}
                    style={{ gridColumn: `span ${resolveColSpan(f.options, cw)}` }}
                  >
                    <FieldRow
                      field={f}
                      draft={effectiveDraft}
                      onChange={handleFieldChange}
                      relations={relations}
                      collection={collection}
                      itemId={itemId}
                      error={validationErrors[f.field]}
                      visible={visibleFields.has(f.field) || !visibleFields.size}
                      locked={lockedFields.has(f.field) || addendumViewId !== 'original'}
                      layoutAiEnabled={layoutAiEnabled}
                      renderField={renderField}
                      onCountChange={handleM2MCountChange}
                      swapButton={swapToggleBtn}
                      swapContent={swapContentNode}
                    />
                    {inlineEntries?.length && hasVal && inlineRelCollection && (
                      <InlineDisplay
                        relCollection={inlineRelCollection}
                        relId={rawVal as string | number}
                        entries={inlineEntries}
                        separator={inlineSeparator}
                      />
                    )}
                  </div>
                )
              })
            }
          </GridContainer>
          {widgetSlots
            .filter((ws) => (ws.group_key ?? null) === activeChild.key)
            .map((ws) => {
              // Container tab bodies bypass GroupSection, so widget slots in tab
              // groups render here. input_bindings arrives as a JSON string.
              let bindings: InputBinding[] = []
              try {
                bindings =
                  typeof ws.input_bindings === 'string'
                    ? JSON.parse(ws.input_bindings)
                    : ((ws.input_bindings ?? []) as unknown as InputBinding[])
              } catch {
                /* noop */
              }
              return (
                <div key={ws.field} className='mt-4'>
                  <WidgetSlot
                    widgetId={ws.widget_id as number}
                    inputBindings={bindings}
                    itemDraft={draft}
                    itemCollection={collection}
                    ready={isNew || (!itemLoading && Object.keys(draft).length > 0)}
                    label={ws.label_override ?? undefined}
                    defaultExpanded={ws.default_expanded ?? true}
                  />
                </div>
              )
            })}
          {pdfInContainer && (
            <div className='mt-4 flex items-center gap-2'>
              <button
                type='button'
                onClick={() => void handleGenerateAndAttach()}
                disabled={pdfAttaching || !pdfAttachField}
                title={!pdfAttachField ? 'Configure PDF field in Data Model → Layouts' : undefined}
                className='inline-flex items-center gap-1.5 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/10 px-3 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-nvr-cyan'
              >
                <svg
                  xmlns='http://www.w3.org/2000/svg'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  className='h-3.5 w-3.5'
                >
                  <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
                  <polyline points='14 2 14 8 20 8' />
                  <line x1='9' y1='13' x2='15' y2='13' />
                  <line x1='9' y1='17' x2='13' y2='17' />
                </svg>
                {pdfAttaching ? 'Generating…' : pdfSlot?.label_override?.trim() || 'Generate PDF'}
              </button>
            </div>
          )}
          {c.tab_mode === 'steps' &&
            children.length > 1 &&
            (() => {
              const idx = children.findIndex((ch) => ch.key === activeKey)
              const isFirst = idx === 0
              const isLast = idx === children.length - 1
              return (
                <div className='mt-6 border-t border-slate-200 pt-4'>
                  <div className='flex items-center justify-between gap-2'>
                    <button
                      type='button'
                      disabled={isFirst}
                      onClick={() => setContainerTab(c, children[idx - 1].key)}
                      className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40'
                    >
                      <ChevronDown className='h-3.5 w-3.5 rotate-90' />
                      Previous
                    </button>
                    <span className='text-[11px] text-slate-400'>
                      Step {idx + 1} of {children.length}
                    </span>
                    {isLast ? null : (
                      <button
                        type='button'
                        onClick={() => setContainerTab(c, children[idx + 1].key)}
                        className='inline-flex items-center gap-1.5 rounded-md bg-[#00ceff] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0]'
                      >
                        Next
                        <ChevronDown className='h-3.5 w-3.5 -rotate-90' />
                      </button>
                    )}
                  </div>
                </div>
              )
            })()}
        </div>
      </div>
    )
  }

  function renderSectionItem(
    item:
      | FieldGroup
      | '__ungrouped__'
      | '__pipeline__'
      | '__comments__'
      | '__tasks__'
      | '__owners__'
      | '__pdf__'
      | string
  ) {
    if (item === '__ungrouped__') return renderUngrouped()
    if (typeof item === 'string' && item !== '__ungrouped__') return renderSentinel(item)
    const g = item as FieldGroup
    if (g.type === 'container') return renderContainer(g)
    if (g.type === 'content') return <LayoutContentBlock key={g.key} group={g} />
    if (g.type === 'metadata' && isNew) return null
    const swapCfg = (() => {
      try {
        return g.swap_config
          ? (JSON.parse(g.swap_config) as {
              enabled: boolean
              primary_field: string
              alternate_fields: ({ field: string; width: 1 | 2 } | string)[]
              toggle_label?: string
              back_label?: string
            })
          : null
      } catch {
        return null
      }
    })()
    const normAlts = (swapCfg?.alternate_fields ?? []).map((x) =>
      typeof x === 'string' ? { field: x, width: 2 as const } : x
    )
    const isSwapped = swapCfg?.enabled ? swappedGroups.has(g.id) : false
    const baseFields = groupedMap[g.key] ?? []
    // A rollup whose live total has moved away from the stored one shows both
    // figures and the difference — on an addendum that difference IS the
    // amendment, and replacing the old number with the new one hides it.
    const groupFields = baseFields.map((f) => {
      const live = liveRollupValues.get(f.field)
      if (live === undefined) return f
      const original = draft[f.field]
      // Cent precision: a live sum of floats never exactly equals the stored
      // decimal, and an unmoved total must not advertise a +$0.00 change.
      if (
        original !== null &&
        original !== undefined &&
        Math.round(Number(original) * 100) === Math.round(Number(live) * 100)
      ) {
        return f
      }
      return {
        ...f,
        options: {
          ...((f.options as Record<string, unknown> | null) ?? {}),
          __live_delta: { original, live }
        }
      }
    })
    const ownersHere = ownersInGroup && ownersGroupKey === g.key && showPipeline
    const pdfHere = pdfInGroup && pdfGroupKey === g.key && !isNew
    const widgetsHere = widgetSlots.filter((ws) => (ws.group_key ?? null) === g.key)
    if (groupFields.length === 0 && !ownersHere && !pdfHere && widgetsHere.length === 0) return null
    const accordionActive = accordionMode && g.type !== 'tab'
    return (
      <GroupSection
        key={g.key}
        group={g}
        fields={groupFields}
        ownersAssignment={ownersHere ? ownersSlot : undefined}
        pdfAssignment={pdfHere ? pdfSlot : undefined}
        pdfAttachField={pdfHere ? pdfAttachField : undefined}
        pdfFilenameTemplate={pdfHere ? pdfFilenameTemplate : undefined}
        widgetAssignments={widgetsHere.length > 0 ? widgetsHere : undefined}
        layoutId={activeLayoutData?.layout?.id ?? null}
        draft={draft}
        onChange={handleFieldChange}
        relations={relations}
        collection={collection}
        itemId={itemId}
        errors={validationErrors}
        visibleFields={visibleFields}
        lockedFields={lockedFields}
        layoutAiEnabled={layoutAiEnabled}
        displayOnly={g.type === 'metadata'}
        renderField={renderField}
        onCountChange={handleM2MCountChange}
        isNew={isNew}
        fieldValues={groupFields.map((f) => draft[f.field])}
        isOpen={accordionActive ? openSectionId === g.id : undefined}
        onToggle={
          accordionActive
            ? () => setOpenSectionId((cur) => (cur === g.id ? null : g.id))
            : undefined
        }
        summaryFields={parseSummaryFields(g.summary_fields)}
        m2mCounts={fieldCounts}
        o2mCounts={o2mCounts}
        o2mAggValues={o2mAggValues}
        summaryAggConfigs={enrichedSummaryAggConfigs}
        o2mLoading={o2mLoading}
        hideEmptySummary={hideEmptySummary}
        fieldInlineDisplay={fieldInlineDisplay}
        swapConfig={swapCfg}
        swapped={isSwapped}
        onSwapToggle={
          swapCfg?.enabled
            ? () =>
                setSwappedGroups((prev) => {
                  const next = new Set(prev)
                  if (next.has(g.id)) next.delete(g.id)
                  else next.add(g.id)
                  return next
                })
            : undefined
        }
        alternateFields={
          swapCfg?.enabled
            ? (fieldConfig ?? []).filter((af) => normAlts.some((a) => a.field === af.field))
            : undefined
        }
        alternateWidths={
          swapCfg?.enabled ? Object.fromEntries(normAlts.map((a) => [a.field, a.width])) : undefined
        }
      />
    )
  }

  // ── Section mode ───────────────────────────────────────────────────────────
  function renderSectionMode() {
    return (
      <div className='space-y-4'>
        {sectionOrder.map((item, i) => {
          const key = typeof item === 'string' ? item : (item as FieldGroup).key
          return <div key={key ?? i}>{renderSectionItem(item)}</div>
        })}
        {!pipelineSlot && showPipeline && (
          <PipelinePanel
            collection={pipelineCollection}
            item={pipelineItem}
            onBeforeTransition={validateAll}
            addendumPending={
              !viewingAddendum && activeAddendumCount > 0 && !!colMeta?.addendums_enabled
            }
            addendumView={viewingAddendum}
          />
        )}
        {!tasksSlot && effectiveShowTasks && (
          <TaskPanel
            collection={collection}
            item={itemId}
            queuedTasks={isNew ? pendingTasks : undefined}
            onQueueTask={isNew ? handleQueueTask : undefined}
          />
        )}
        {!isNew && itemId && (
          <>
            {!relatedRecordsSlot && (
              <RelatedRecordsPanel collection={collection} itemId={String(itemId)} />
            )}
            {!referencedBySlot && (
              <ReferencedByPanel collection={collection} itemId={String(itemId)} />
            )}
          </>
        )}
        {!commentsSlot && effectiveShowComments && (
          <CommentPanel
            collection={collection}
            item={itemId}
            queuedComments={isNew ? pendingComments : undefined}
            onQueueComment={isNew ? handleQueueComment : undefined}
          />
        )}
        {showWorkflow && <WorkflowPanel collection={collection} item={itemId} />}
        {!addendumSlot &&
          activeLayoutData !== undefined &&
          colMeta?.addendums_enabled &&
          !isNew && (
            <AddendumPanel
              collection={collection}
              item={itemId}
              addendumLayoutId={activeLayoutData?.layout?.addendum_layout_id ?? null}
              canCreate={addendumCanCreate}
              onActiveCountChange={setActiveAddendumCount}
              onApplied={() => {
                // An approved addendum rewrites the record, so the attached
                // document is now stale — regenerate it the same way a save does.
                if (pdfAutoGenerate && pdfAttachField) {
                  void handleGenerateAndAttach({ silent: true }).then(() => {
                    qc.invalidateQueries({ queryKey: ['m2m-items'] })
                  })
                }
              }}
            />
          )}
      </div>
    )
  }

  // ── Tab mode ───────────────────────────────────────────────────────────────
  function renderTabContent(tabKey: string, inStepsMode = false) {
    const fields = (
      tabKey === '__general__'
        ? inStepsMode
          ? ungroupedFields
          : [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])]
        : (groupedMap[tabKey] ?? [])
    ).filter((f) => !f.hidden)
    const ownersHere = ownersInGroup && ownersGroupKey === tabKey && showPipeline
    const pdfHere = pdfInGroup && pdfGroupKey === tabKey && !isNew
    const widgetsHereTab = widgetSlots.filter((ws) => (ws.group_key ?? null) === tabKey)
    type TabItem = { _k: string; sort: number } & (
      | { _t: 'field'; f: CMSField }
      | { _t: 'owners'; slot: SlotAssignment }
      | { _t: 'pdf'; slot: SlotAssignment }
      | { _t: 'widget'; slot: SlotAssignment }
    )
    const tabItems: TabItem[] = fields.map((f) => ({
      _k: f.field,
      sort: f.sort ?? 0,
      _t: 'field' as const,
      f
    }))
    if (ownersHere && ownersSlot) {
      tabItems.push({
        _k: '__owners__',
        sort: ownersSlot.sort,
        _t: 'owners' as const,
        slot: ownersSlot
      })
    }
    if (pdfHere && pdfSlot) {
      tabItems.push({ _k: '__pdf__', sort: pdfSlot.sort, _t: 'pdf' as const, slot: pdfSlot })
    }
    for (const ws of widgetsHereTab) {
      tabItems.push({ _k: ws.field, sort: ws.sort, _t: 'widget' as const, slot: ws })
    }
    tabItems.sort((a, b) => a.sort - b.sort)
    return (
      <div className='rounded-xl border border-slate-200 bg-white px-5 py-5'>
        <GridContainer>
          {(cw) =>
            tabItems.map((item) => {
              if (item._t === 'owners') {
                const span = item.slot.col_span ?? 12
                return (
                  <div key='__owners__' style={{ gridColumn: `span ${span}` }}>
                    <OwnersInline
                      collection={collection}
                      itemId={itemId}
                      label={item.slot.label_override || 'Owners'}
                    />
                  </div>
                )
              }
              if (item._t === 'pdf') {
                if (!layoutId) return null
                const span = item.slot.col_span ?? 12
                const label = item.slot.label_override?.trim() || 'Generate PDF'
                const notConfigured = !pdfAttachField
                return (
                  <div key='__pdf__' style={{ gridColumn: `span ${span}` }}>
                    <button
                      type='button'
                      onClick={() => void handleGenerateAndAttach()}
                      disabled={pdfAttaching || notConfigured}
                      title={
                        notConfigured ? 'Configure PDF field in Data Model → Layouts' : undefined
                      }
                      className='inline-flex items-center gap-1.5 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/10 px-3 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-nvr-cyan'
                    >
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        className='h-3.5 w-3.5'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'
                      >
                        <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
                        <polyline points='14 2 14 8 20 8' />
                      </svg>
                      {pdfAttaching ? 'Generating…' : label}
                    </button>
                  </div>
                )
              }
              if (item._t === 'widget') {
                if (!item.slot.widget_id) return null
                const span = item.slot.col_span ?? 12
                return (
                  <div key={item.slot.field} style={{ gridColumn: `span ${span}` }}>
                    <WidgetSlot
                      widgetId={item.slot.widget_id}
                      inputBindings={(item.slot.input_bindings ?? []) as InputBinding[]}
                      itemDraft={draft}
                      label={item.slot.label_override ?? undefined}
                      defaultExpanded={item.slot.default_expanded ?? true}
                    />
                  </div>
                )
              }
              const f = item.f
              const inlineConfig = fieldInlineDisplay?.[f.field]
              const inlineEntries = inlineConfig?.entries
              const inlineSeparator = inlineConfig?.separator ?? null
              const rawVal = draft[f.field]
              const hasVal = rawVal !== null && rawVal !== undefined && rawVal !== ''
              const inlineRelCollection =
                inlineEntries?.length && hasVal
                  ? (relations.find(
                      (r) =>
                        r.many_collection === collection &&
                        r.many_field === f.field &&
                        !r.junction_field
                    )?.one_collection ?? null)
                  : null
              return (
                <div key={f.field} style={{ gridColumn: `span ${resolveColSpan(f.options, cw)}` }}>
                  <FieldRow
                    field={f}
                    draft={effectiveDraft}
                    onChange={handleFieldChange}
                    relations={relations}
                    collection={collection}
                    itemId={itemId}
                    error={validationErrors[f.field]}
                    visible={true}
                    locked={isReadOnly || addendumViewId !== 'original'}
                    layoutAiEnabled={layoutAiEnabled}
                    renderField={renderField}
                    onCountChange={handleM2MCountChange}
                  />
                  {inlineEntries?.length && hasVal && inlineRelCollection && (
                    <InlineDisplay
                      relCollection={inlineRelCollection}
                      relId={rawVal as string | number}
                      entries={inlineEntries}
                      separator={inlineSeparator}
                    />
                  )}
                </div>
              )
            })
          }
        </GridContainer>
      </div>
    )
  }

  function renderTabMode() {
    const tabStripItems = [
      ...(sectionGroups.length > 0 ? [{ key: '__general__', label: 'General' }] : []),
      ...tabGroups.map((g) => ({ key: g.key, label: g.label }))
    ]
    return (
      <div className='space-y-4'>
        {ungroupedFields.length > 0 && renderUngrouped()}
        <div className='flex border-b border-slate-200 overflow-x-auto gap-1 px-1'>
          {tabStripItems.map((t) => {
            const hasErr = Object.keys(validationErrors).some((f) => {
              const fc = allFields.find((field) => field.field === f)
              return fc?.group_key === t.key || (!fc?.group_key && t.key === '__general__')
            })
            return (
              <button
                key={t.key}
                type='button'
                onClick={() => setActiveTab(t.key)}
                className={cn(
                  'whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5',
                  activeTab === t.key
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
                {hasErr && <span className='h-1.5 w-1.5 rounded-full bg-destructive' />}
              </button>
            )
          })}
        </div>
        {renderTabContent(activeTab)}
        {sectionOrder
          .filter((item) => typeof item === 'string' && item !== '__ungrouped__')
          .map((item) => renderSentinel(item as string))}
        {!pipelineSlot && showPipeline && (
          <PipelinePanel
            collection={pipelineCollection}
            item={pipelineItem}
            onBeforeTransition={validateAll}
            addendumPending={
              !viewingAddendum && activeAddendumCount > 0 && !!colMeta?.addendums_enabled
            }
            addendumView={viewingAddendum}
          />
        )}
        {!tasksSlot && effectiveShowTasks && (
          <TaskPanel
            collection={collection}
            item={itemId}
            queuedTasks={isNew ? pendingTasks : undefined}
            onQueueTask={isNew ? handleQueueTask : undefined}
          />
        )}
        {!isNew && itemId && (
          <>
            {!relatedRecordsSlot && (
              <RelatedRecordsPanel collection={collection} itemId={String(itemId)} />
            )}
            {!referencedBySlot && (
              <ReferencedByPanel collection={collection} itemId={String(itemId)} />
            )}
          </>
        )}
        {!commentsSlot && effectiveShowComments && (
          <CommentPanel
            collection={collection}
            item={itemId}
            queuedComments={isNew ? pendingComments : undefined}
            onQueueComment={isNew ? handleQueueComment : undefined}
          />
        )}
        {showWorkflow && <WorkflowPanel collection={collection} item={itemId} />}
        {!addendumSlot &&
          activeLayoutData !== undefined &&
          colMeta?.addendums_enabled &&
          !isNew && (
            <AddendumPanel
              collection={collection}
              item={itemId}
              addendumLayoutId={activeLayoutData?.layout?.addendum_layout_id ?? null}
              canCreate={addendumCanCreate}
              onActiveCountChange={setActiveAddendumCount}
              onApplied={() => {
                // An approved addendum rewrites the record, so the attached
                // document is now stale — regenerate it the same way a save does.
                if (pdfAutoGenerate && pdfAttachField) {
                  void handleGenerateAndAttach({ silent: true }).then(() => {
                    qc.invalidateQueries({ queryKey: ['m2m-items'] })
                  })
                }
              }}
            />
          )}
      </div>
    )
  }

  // ── Steps mode ─────────────────────────────────────────────────────────────
  function renderStepsMode() {
    const activeIdx = allSteps.findIndex((s) => s.key === activeTab)
    const isLast = activeIdx === allSteps.length - 1
    const isFirst = activeIdx === 0

    const stepNav = (
      <div className='mt-6 border-t border-slate-200 pt-4'>
        <div className='flex items-center justify-between gap-2'>
          <button
            type='button'
            onClick={() => {
              const idx = allSteps.findIndex((s) => s.key === activeTab)
              if (idx > 0) setActiveTab(allSteps[idx - 1].key)
            }}
            disabled={isFirst}
            className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40'
          >
            <ChevronDown className='h-3.5 w-3.5 rotate-90' />
            Previous
          </button>
          <span className='text-[11px] text-slate-400'>
            Step {activeIdx + 1} of {allSteps.length}
          </span>
          <div className='flex items-center gap-2'>
            {isLast ? (
              <button
                type='button'
                onClick={() => handleSave()}
                disabled={saveMut.isPending || isReadOnly}
                className='inline-flex h-9 items-center gap-1.5 rounded-md bg-[#00ceff] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0] disabled:opacity-50'
              >
                <Save className='h-3.5 w-3.5' />
                {saveMut.isPending ? 'Saving…' : 'Save Progress'}
              </button>
            ) : (
              <button
                type='button'
                onClick={handleNext}
                className='inline-flex items-center gap-1.5 rounded-md bg-[#00ceff] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0]'
              >
                Next
                <ChevronDown className='h-3.5 w-3.5 -rotate-90' />
              </button>
            )}
            {isLast && !isNew && showPipeline && (
              <PipelineTransitionButtons
                wrap={false}
                key={`${pipelineCollection}:${pipelineItem}`}
                collection={pipelineCollection}
                item={pipelineItem}
                // One click means one action: save what is on screen, then
                // transition. Refusing and asking for a separate Save made the
                // button lie about what it does — the person had already told
                // us to move the record on.
                onBeforeTransition={async () => {
                  if (!validateAll()) return false
                  if (!isDirty) return true
                  try {
                    await saveMut.mutateAsync()
                    return true
                  } catch {
                    // The save reports its own failure; transitioning on top of
                    // unsaved edits would apply the state change to values the
                    // record does not have.
                    return false
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
    )

    // Base minGroupSort on tab groups only — section groups float independently as panels
    const minGroupSort = tabGroups.length > 0 ? Math.min(...tabGroups.map((g) => g.sort)) : Infinity
    const preTabItems = sectionOrder.filter((item) => {
      if (typeof item !== 'string') return (item as FieldGroup).sort < minGroupSort
      if (item === '__pipeline__') return !!(pipelineSlot && pipelineSlot.sort < minGroupSort)
      if (item === '__comments__') return !!(commentsSlot && commentsSlot.sort < minGroupSort)
      if (item === '__tasks__') return !!(tasksSlot && tasksSlot.sort < minGroupSort)
      if (item === '__addendums__') return !!(addendumSlot && addendumSlot.sort < minGroupSort)
      return false
    })
    const postTabItems = sectionOrder.filter((item) => {
      if (item === '__ungrouped__') return false
      if (typeof item !== 'string') return (item as FieldGroup).sort >= minGroupSort
      if (item === '__pipeline__') return !(pipelineSlot && pipelineSlot.sort < minGroupSort)
      if (item === '__comments__') return !(commentsSlot && commentsSlot.sort < minGroupSort)
      if (item === '__tasks__') return !(tasksSlot && tasksSlot.sort < minGroupSort)
      if (item === '__addendums__') return !(addendumSlot && addendumSlot.sort < minGroupSort)
      return false
    })

    return (
      <div className='space-y-4 min-w-0 flex-1'>
        {preTabItems.map((item, i) => {
          const key = typeof item === 'string' ? item : (item as FieldGroup).key
          return <div key={key ?? i}>{renderSectionItem(item as FieldGroup | string)}</div>
        })}
        <StepsBar
          steps={allSteps}
          active={activeTab}
          completed={completedSteps}
          dirtySteps={dirtySteps}
          errorSteps={
            new Set(
              allSteps
                .filter((s) => (groupedMap[s.key] ?? []).some((f) => validationErrors[f.field]))
                .map((s) => s.key)
            )
          }
          onStepClick={setActiveTab}
        />
        {renderTabContent(activeTab, true)}
        {postTabItems.map((item, i) => {
          const key = typeof item === 'string' ? item : (item as FieldGroup).key
          return <div key={key ?? i}>{renderSectionItem(item as FieldGroup | string)}</div>
        })}
        {!pipelineSlot && showPipeline && (
          <PipelinePanel
            collection={pipelineCollection}
            item={pipelineItem}
            defaultExpanded={false}
            onBeforeTransition={validateAll}
            addendumPending={
              !viewingAddendum && activeAddendumCount > 0 && !!colMeta?.addendums_enabled
            }
            addendumView={viewingAddendum}
          />
        )}
        {!tasksSlot && effectiveShowTasks && (
          <TaskPanel
            collection={collection}
            item={itemId}
            defaultExpanded={false}
            queuedTasks={isNew ? pendingTasks : undefined}
            onQueueTask={isNew ? handleQueueTask : undefined}
          />
        )}
        {!commentsSlot && effectiveShowComments && (
          <CommentPanel
            collection={collection}
            item={itemId}
            defaultExpanded={false}
            queuedComments={isNew ? pendingComments : undefined}
            onQueueComment={isNew ? handleQueueComment : undefined}
          />
        )}
        {showWorkflow && <WorkflowPanel collection={collection} item={itemId} />}
        {!addendumSlot &&
          activeLayoutData !== undefined &&
          colMeta?.addendums_enabled &&
          !isNew && (
            <AddendumPanel
              collection={collection}
              item={itemId}
              addendumLayoutId={activeLayoutData?.layout?.addendum_layout_id ?? null}
              canCreate={addendumCanCreate}
              onActiveCountChange={setActiveAddendumCount}
              onApplied={() => {
                // An approved addendum rewrites the record, so the attached
                // document is now stale — regenerate it the same way a save does.
                if (pdfAutoGenerate && pdfAttachField) {
                  void handleGenerateAndAttach({ silent: true }).then(() => {
                    qc.invalidateQueries({ queryKey: ['m2m-items'] })
                  })
                }
              }}
            />
          )}
        {stepNav}
      </div>
    )
  }

  // ── System fields ──────────────────────────────────────────────────────────
  function _renderSystemFields() {
    const sysToShow = systemFields.filter(
      (f) =>
        !f.hidden &&
        SYSTEM_FIELDS.has(f.field) &&
        draft[f.field] !== undefined &&
        draft[f.field] !== null
    )
    if (sysToShow.length === 0) return null
    return (
      <div className='rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-3'>
        <p className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
          System
        </p>
        <div className='grid grid-cols-2 gap-x-6 gap-y-2'>
          {sysToShow.map((f) => (
            <div key={f.field} className='text-sm'>
              <span className='text-muted-foreground'>{f.label ?? titleCase(f.field)}: </span>
              <span className='text-foreground'>
                {['date_created', 'date_updated'].includes(f.field)
                  ? formatRelative(String(draft[f.field]))
                  : String(draft[f.field])}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Formula constants + fiscal calendar (#244/#343): hydrate the shared
  // expression engine from instance settings once per session. HOOKS-ORDER
  // RULE: this (and the tab-title effect) must sit ABOVE every early return
  // below — a hook below a conditional return crashes React the moment the
  // condition flips ("Rendered fewer hooks than expected", hit live).
  useEffect(() => {
    if (formulaCtxHydrated) return
    formulaCtxHydrated = true
    client
      .request<{ data?: { formula_constants?: string | null; fiscal_year_start_month?: number } }>({
        _method: 'GET',
        _path: '/settings'
      })
      .then((r) => {
        const row = r?.data
        if (!row) return
        try {
          const parsed = row.formula_constants ? JSON.parse(row.formula_constants) : null
          if (parsed && typeof parsed === 'object') setFormulaConstants(parsed)
        } catch {
          // malformed constants JSON — engine runs without them
        }
        setFiscalStartMonth(row.fiscal_year_start_month)
      })
      .catch(() => {
        formulaCtxHydrated = false
      })
  }, [client])

  // Tab titles with context (#145): the browser tab names the record.
  // Title derivation is duplicated inline (the display consts are declared
  // after the early returns) — same hooks-order constraint.
  useEffect(() => {
    if (isNew || !documentTitle) return
    const t =
      itemData && colMeta?.display_template
        ? applyDisplayTemplate(colMeta.display_template, itemData as Record<string, unknown>)
        : (colMeta?.display_name ?? titleCase(collection ?? ''))
    if (!t) return
    const prev = document.title
    document.title = `${t} · ${document.title.split(' · ').pop() ?? 'Nivaro'}`
    return () => {
      document.title = prev
    }
  }, [itemData, colMeta, collection, isNew, documentTitle])

  // ── Access denied / not found ──────────────────────────────────────────────
  // A 403/404 on the record load used to leave a silently empty form —
  // explain WHY (role permission, RLS, or which User Scope excludes it).
  if (itemLoadDenied) {
    return (
      <div className={cn('flex flex-1 min-h-0 flex-col overflow-y-auto', className)}>
        <AccessDeniedPanel
          collection={collection}
          itemId={String(itemId)}
          // Prefer the host's back action: it knows the app's history and a
          // sane fallback route. Raw history.back() is the last resort, and on
          // a cold direct load (denied link pasted into a new tab) it would
          // leave the SPA entirely or no-op against an empty stack.
          onBack={onBack ?? (() => window.history.back())}
        />
      </div>
    )
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  // NOT fieldsLoading: the field-config query is DISABLED while the layout
  // resolves, and a disabled pending query reports isLoading false — so a
  // reload painted the empty form shell (comments/tasks slot chrome included)
  // for the layout round-trip, THEN swapped to the loader. isFetched is false
  // through both phases.
  const isLoading = !fieldConfigFetched || (!isNew && itemLoading)
  if (isLoading) {
    // A big, centered loading state — the sparse two-skeleton layout read as a
    // blank page for the first second on record open.
    return (
      <div className={cn('flex flex-1 min-h-0 flex-col', className)}>
        {showHeader && (
          <div className='shrink-0 border-b border-slate-200 px-6 py-4 flex items-center gap-3 dark:border-border'>
            <Skeleton className='h-6 w-40' />
          </div>
        )}
        <div className='flex flex-1 flex-col items-center justify-center gap-3 p-6'>
          <span className='relative flex h-10 w-10 items-center justify-center'>
            <span className='absolute inset-0 animate-spin rounded-full border-2 border-slate-200 border-t-nvr-cyan dark:border-border dark:border-t-nvr-cyan' />
          </span>
          <p className='text-[13px] font-medium text-slate-500 dark:text-muted-foreground'>
            Loading record…
          </p>
        </div>
      </div>
    )
  }

  const title = colMeta?.display_name ?? titleCase(collection ?? '')
  const singularTitle = colMeta?.singular || title
  const itemTitle =
    !isNew && itemData && colMeta?.display_template
      ? applyDisplayTemplate(colMeta.display_template, itemData as Record<string, unknown>)
      : title
  const canDelete = !isNew && isAdmin && effectiveShowDelete

  return (
    <ReimportHandlerContext.Provider
      value={isNew ? null : (handleReimportParsed as import('../context').ReimportHandler)}
    >
      <RelationPathDataContext.Provider value={relationPathData}>
        <AddendumO2MContext.Provider value={addendumO2MMap}>
          <AddendumViewContext.Provider value={addendumViewId}>
            <AddendumFieldContext.Provider value={addendumFieldMap}>
              <ParentDraftContext.Provider
                value={{
                  draft: parentDraftWithAliases,
                  collection,
                  dirtyFields: userTouchedRef.current,
                  fieldLabels: parentFieldLabels,
                  fieldOptionFilters: parentFieldOptionFilters
                }}
              >
                <GridFlushContext.Provider value={isNew ? null : gridFlushCtx}>
                  <StaleFieldReportContext.Provider value={reportStaleField}>
                    <O2MStagingContext.Provider value={o2mStagingCtx}>
                      <LiveRowsContext.Provider value={liveRowsCtx}>
                        <StagedRelationsContext.Provider value={stagedRelsCtx}>
                          <M2MStagingContext.Provider value={m2mStagingCtx}>
                            {/* Instant tooltips for truncated header values. Self-deduplicating —
          only the first live instance listens, so a form rendered inside a
          collection browser doesn't double up. */}
                            <TipLayer />
                            <SaveProgressDialog
                              open={saveDialogOpen}
                              steps={saveSteps}
                              onClose={() => setSaveDialogOpen(false)}
                            />
                            <Dialog
                              open={!!reimportDialog}
                              onOpenChange={(open) => {
                                if (!open && !reimportApplying) setReimportDialog(null)
                              }}
                            >
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>Update this record from file</DialogTitle>
                                </DialogHeader>
                                <DialogBody className='space-y-3'>
                                  {reimportDialog && (
                                    <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                                      {reimportDialog.diff.updates.length} will update ·{' '}
                                      {reimportDialog.diff.creates.length} new ·{' '}
                                      {reimportDialog.diff.deletes.length} will delete ·{' '}
                                      {reimportDialog.diff.matchedUnchanged} unchanged
                                    </p>
                                  )}
                                  {reimportDialog && (
                                    <ImportIssuesPanel issues={reimportDialog.result.issues} />
                                  )}
                                </DialogBody>
                                <DialogFooter>
                                  <Button
                                    variant='outline'
                                    onClick={() => setReimportDialog(null)}
                                    disabled={reimportApplying}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    onClick={async () => {
                                      if (!reimportDialog) return
                                      setReimportApplying(true)
                                      await applyReimportStaging(
                                        reimportDialog.diff,
                                        reimportDialog.result,
                                        reimportDialog.template,
                                        reimportDialog.existingRows
                                      )
                                      setReimportApplying(false)
                                      setReimportDialog(null)
                                    }}
                                    disabled={reimportApplying}
                                  >
                                    {reimportApplying ? (
                                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                                    ) : (
                                      'Apply to form'
                                    )}
                                  </Button>
                                </DialogFooter>
                              </DialogContent>
                            </Dialog>
                            <div className={cn('flex flex-1 min-h-0 flex-col', className)}>
                              {showHeader && (
                                <header
                                  className={cn(
                                    'shrink-0 border-b border-slate-200 dark:border-border bg-white dark:bg-card px-8 flex items-center gap-3 transition-[padding] duration-200',
                                    headerCondensed ? 'py-1.5' : 'py-3.5',
                                    headerClassName
                                  )}
                                  data-nvr-header-row
                                  data-nvr-condensed={headerCondensed || undefined}
                                >
                                  {onBack && (
                                    <button
                                      type='button'
                                      onClick={onBack}
                                      aria-label='Back'
                                      className='shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-100'
                                    >
                                      <ArrowLeft aria-hidden className='h-4 w-4' />
                                    </button>
                                  )}
                                  <div className='flex min-w-0 flex-col'>
                                    <div className='group/title flex items-center gap-1.5'>
                                      <h1 className='truncate text-[17px] font-bold leading-tight text-slate-900 dark:text-slate-50'>
                                        {isNew ? `New ${singularTitle}` : itemTitle}
                                      </h1>
                                      {!isNew &&
                                        itemTitle &&
                                        (copiedHeaderField === '__title__' ? (
                                          <Check className='h-3 w-3 shrink-0 text-emerald-500' />
                                        ) : (
                                          <button
                                            type='button'
                                            className='cursor-pointer opacity-0 transition-opacity group-hover/title:opacity-100'
                                            onClick={() => {
                                              navigator.clipboard
                                                .writeText(itemTitle ?? '')
                                                .catch(() => {})
                                              setCopiedHeaderField('__title__')
                                              setTimeout(
                                                () =>
                                                  setCopiedHeaderField((prev) =>
                                                    prev === '__title__' ? null : prev
                                                  ),
                                                1500
                                              )
                                            }}
                                          >
                                            <Copy className='h-3 w-3 text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400' />
                                          </button>
                                        ))}
                                    </div>
                                    {lastTouchText && (
                                      <p
                                        className='mt-0.5 flex items-center gap-1 text-[10.5px] text-slate-400 dark:text-slate-500'
                                        data-tip={
                                          lastTouch
                                            ? new Date(lastTouch.timestamp).toLocaleString()
                                            : undefined
                                        }
                                        data-last-touch
                                      >
                                        {lastTouchText}
                                        {completeness && (
                                          <span
                                            data-completeness-chip
                                            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9.5px] font-semibold tabular-nums ${
                                              completeness.requiredMissing.length > 0
                                                ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400'
                                                : completeness.pct >= 100
                                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
                                                  : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-border dark:bg-muted dark:text-muted-foreground'
                                            }`}
                                            data-tip={`${completeness.filled} of ${completeness.total} required fields filled${
                                              completeness.requiredMissing.length > 0
                                                ? ` · missing: ${completeness.requiredMissing.slice(0, 5).join(', ')}${completeness.requiredMissing.length > 5 ? '…' : ''}`
                                                : ''
                                            }`}
                                          >
                                            {completeness.pct}% complete
                                          </span>
                                        )}
                                        {provenance && (
                                          <span
                                            data-provenance-chip
                                            className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-1.5 py-px text-[9.5px] font-medium text-slate-500 dark:border-border dark:bg-muted dark:text-muted-foreground'
                                            data-tip={`${provenance.origin}${provenance.user_name ? ` · ${provenance.user_name}` : ''} · ${new Date(provenance.timestamp).toLocaleString()}`}
                                          >
                                            {provenance.origin}
                                          </span>
                                        )}
                                        {/* Admin-only: the route 403s everyone else anyway. */}
                                        {isAdmin && !isNew && itemId && (
                                          <RecordViewersChip
                                            collection={collection}
                                            itemId={String(itemId)}
                                          />
                                        )}
                                      </p>
                                    )}
                                    {subtitleParts.length > 0 && !headerCondensed && (
                                      <div className='group/subtitle mt-0.5 flex items-center gap-1'>
                                        {/* Capped to 350px on one line — a long subtitle used to wrap
                      and push the whole header taller. The full text rides in
                      data-tip, so hovering shows it instantly (TipLayer). */}
                                        <div
                                          data-tip={subtitleFullText}
                                          className='max-w-[350px] overflow-hidden text-ellipsis whitespace-nowrap'
                                        >
                                          {subtitleParts.map((p, i) => {
                                            const weightClass =
                                              p.weight === 'bold'
                                                ? 'font-bold'
                                                : p.weight === 'semibold'
                                                  ? 'font-semibold'
                                                  : p.weight === 'medium'
                                                    ? 'font-medium'
                                                    : 'font-normal'
                                            const colorClass =
                                              p.color === 'cyan'
                                                ? 'text-nvr-cyan'
                                                : p.color === 'blue'
                                                  ? 'text-blue-600 dark:text-blue-400'
                                                  : p.color === 'green'
                                                    ? 'text-emerald-600 dark:text-emerald-400'
                                                    : p.color === 'amber'
                                                      ? 'text-amber-600 dark:text-amber-400'
                                                      : p.color === 'red'
                                                        ? 'text-red-600 dark:text-red-400'
                                                        : p.color === 'purple'
                                                          ? 'text-purple-600 dark:text-purple-400'
                                                          : 'text-slate-500 dark:text-slate-400'
                                            const isPill = p.display_as === 'pill'
                                            const isTag = p.display_as === 'tag'
                                            const sep = subtitleConfig?.separator ?? ' | '
                                            return (
                                              <span
                                                key={i}
                                                className='inline-flex items-center gap-1 align-middle'
                                              >
                                                {i > 0 && !isPill && !isTag && (
                                                  <span className='text-[11px] text-slate-300 dark:text-slate-600'>
                                                    {sep}
                                                  </span>
                                                )}
                                                <span
                                                  className={[
                                                    'text-[12px]',
                                                    weightClass,
                                                    colorClass,
                                                    isPill
                                                      ? 'rounded-full px-2 py-0.5 bg-current/10 text-[11px]'
                                                      : '',
                                                    isTag
                                                      ? 'rounded px-1.5 py-0.5 border border-current/30 text-[11px]'
                                                      : ''
                                                  ]
                                                    .filter(Boolean)
                                                    .join(' ')}
                                                >
                                                  {p.value}
                                                </span>
                                              </span>
                                            )
                                          })}
                                        </div>
                                        {copiedHeaderField === '__subtitle__' ? (
                                          <Check className='h-3 w-3 shrink-0 text-emerald-500' />
                                        ) : (
                                          <button
                                            type='button'
                                            className='cursor-pointer opacity-0 transition-opacity group-hover/subtitle:opacity-100'
                                            onClick={() => {
                                              navigator.clipboard
                                                .writeText(subtitleFullText)
                                                .catch(() => {})
                                              setCopiedHeaderField('__subtitle__')
                                              setTimeout(
                                                () =>
                                                  setCopiedHeaderField((prev) =>
                                                    prev === '__subtitle__' ? null : prev
                                                  ),
                                                1500
                                              )
                                            }}
                                          >
                                            <Copy className='h-3 w-3 text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400' />
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  <div className='ml-auto flex items-center gap-1.5'>
                                    <HeaderTools>
                                    {isNew && (
                                      <ImportFromFileButton
                                        collection={collection}
                                        onParsed={applyImportResult}
                                      />
                                    )}
                                    {!isNew && (
                                      <ImportFromFileButton
                                        collection={collection}
                                        templateFilter={(t) => t.reimport?.enabled === true}
                                        getLabel={(t) => t.reimport?.button_label ?? t.button_label}
                                        onParsed={handleReimportParsed}
                                      />
                                    )}
                                    <FindInRecordButton fields={findableFields} onJump={jumpToField} />
                                    {!isNew && itemId && (
                                      <button
                                        type='button'
                                        title='Copy a plain-text summary of this record (fields + link) for chat or email'
                                        onClick={() => void copyRecordSummary()}
                                        disabled={copyingSummary}
                                        className='inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60'
                                      >
                                        {copyingSummary ? (
                                          <Loader2 className='h-3.5 w-3.5 animate-spin' />
                                        ) : (
                                          <Clipboard className='h-3.5 w-3.5' />
                                        )}
                                      </button>
                                    )}
                                    {!isNew && itemId && (
                                      <RecordSubscribeButton
                                        collection={collection}
                                        itemId={String(itemId)}
                                      />
                                    )}
                                    {!isNew && itemId && (
                                      <RecordInsightsButton
                                        collection={collection}
                                        itemId={String(itemId)}
                                      />
                                    )}
                                    {!isNew && itemId && (
                                      <RecordChatActions
                                        collection={collection}
                                        itemDraft={draft}
                                      />
                                    )}
                                    {!isNew && itemId && (
                                      <button
                                        type='button'
                                        title='Save this record as a reusable pre-fill template — plain field values only (same exclusions as Duplicate)'
                                        data-save-as-template
                                        onClick={() => {
                                          setTemplateName('')
                                          setTemplateShared(false)
                                          setTemplateDialogOpen(true)
                                        }}
                                        className='inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'
                                      >
                                        <svg
                                          width='13'
                                          height='13'
                                          viewBox='0 0 24 24'
                                          fill='none'
                                          stroke='currentColor'
                                          strokeWidth='2'
                                          strokeLinecap='round'
                                          strokeLinejoin='round'
                                          aria-hidden='true'
                                        >
                                          <path d='M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' />
                                          <polyline points='17 21 17 13 7 13 7 21' />
                                          <polyline points='7 3 7 8 15 8' />
                                        </svg>
                                        Save as template
                                      </button>
                                    )}
                                    {templateDialogOpen &&
                                      createPortal(
                                        <div className='fixed inset-0 z-[130] flex items-center justify-center'>
                                          {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
                                          <div
                                            className='absolute inset-0 bg-black/30'
                                            onClick={() => setTemplateDialogOpen(false)}
                                          />
                                          <div
                                            role='dialog'
                                            aria-label='Save as template'
                                            className='relative w-[380px] rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-border dark:bg-card'
                                            onKeyDown={(e) => {
                                              if (e.key === 'Escape') setTemplateDialogOpen(false)
                                            }}
                                          >
                                            <p className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
                                              Save as template
                                            </p>
                                            <p className='mt-1 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
                                              This record's plain field values become a reusable
                                              pre-fill template — same exclusions as Duplicate (no
                                              ids, audit stamps, computed fields, or line items).
                                            </p>
                                            <input
                                              // biome-ignore lint/a11y/noAutofocus: dialog's single input
                                              autoFocus
                                              value={templateName}
                                              onChange={(e) => setTemplateName(e.target.value)}
                                              onKeyDown={(e) => {
                                                if (e.key === 'Enter' && templateName.trim()) {
                                                  ;(
                                                    document.querySelector(
                                                      '[data-template-save-btn]'
                                                    ) as HTMLButtonElement | null
                                                  )?.click()
                                                }
                                              }}
                                              placeholder='Template name'
                                              className='mt-3 h-9 w-full rounded-md border border-slate-200 bg-background px-3 text-[13px] dark:border-border'
                                            />
                                            <label className='mt-2.5 flex cursor-pointer items-center gap-2 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
                                              <input
                                                type='checkbox'
                                                checked={templateShared}
                                                onChange={(e) => setTemplateShared(e.target.checked)}
                                                className='h-3.5 w-3.5'
                                              />
                                              Share with everyone (otherwise it's just yours)
                                            </label>
                                            <div className='mt-4 flex justify-end gap-2'>
                                              <button
                                                type='button'
                                                onClick={() => setTemplateDialogOpen(false)}
                                                className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
                                              >
                                                Cancel
                                              </button>
                                              <button
                                                type='button'
                                                data-template-save-btn
                                                disabled={!templateName.trim() || templateSaving}
                                                onClick={async () => {
                                                  // Same harvest rules as Duplicate: visible,
                                                  // editable, non-computed, non-auto-id scalars
                                                  // + M2O FKs only.
                                                  const AUDIT = new Set([
                                                    'id', 'user_created', 'date_created', 'user_updated',
                                                    'date_updated', 'created_at', 'updated_at', 'created',
                                                    'changed', 'creator', 'last_state_change'
                                                  ])
                                                  const values: Record<string, unknown> = {}
                                                  for (const fc of fieldConfig ?? []) {
                                                    const opts = fc.options as Record<string, unknown> | null
                                                    if (AUDIT.has(fc.field)) continue
                                                    if (opts && typeof opts === 'object' && (opts as { auto_id?: unknown }).auto_id) continue
                                                    if ((fc as { computed_type?: string | null }).computed_type) continue
                                                    if (fc.hidden || (fc as { readonly?: boolean }).readonly) continue
                                                    if ((fc as { layout_assigned?: boolean }).layout_assigned === false) continue
                                                    const v = draft[fc.field]
                                                    if (v === undefined || v === null || v === '') continue
                                                    if (typeof v === 'object') continue
                                                    values[fc.field] = v
                                                  }
                                                  if (Object.keys(values).length === 0) {
                                                    toast.error('Nothing to save — no plain field values on this record')
                                                    return
                                                  }
                                                  setTemplateSaving(true)
                                                  try {
                                                    await client.request(
                                                      post('/record-templates', {
                                                        collection,
                                                        name: templateName.trim(),
                                                        data: values,
                                                        is_shared: templateShared
                                                      })
                                                    )
                                                    toast.success(`Template "${templateName.trim()}" saved`)
                                                    setTemplateDialogOpen(false)
                                                  } catch {
                                                    toast.error('Failed to save template')
                                                  } finally {
                                                    setTemplateSaving(false)
                                                  }
                                                }}
                                                className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-semibold text-white disabled:opacity-50'
                                              >
                                                {templateSaving ? 'Saving…' : 'Save template'}
                                              </button>
                                            </div>
                                          </div>
                                        </div>,
                                        document.body
                                      )}
                                    {!isNew &&
                                      itemId &&
                                      !!(
                                        activeLayoutData?.layout as
                                          | { dossier_enabled?: boolean | number }
                                          | undefined
                                      )?.dossier_enabled && (
                                        <button
                                          type='button'
                                          data-tip='Download a PDF dossier — field values, workflow history, comments and tasks in one document'
                                          onClick={async () => {
                                            // #641 — server assembles the whole story; this just
                                            // streams the PDF down with the caller's own auth.
                                            try {
                                              const res = await fetch(
                                                `${fetchCfg.apiBase}/dossier/${collection}/${itemId}`,
                                                {
                                                  headers: fetchCfg.authHeaders,
                                                  credentials: fetchCfg.credentials
                                                }
                                              )
                                              if (!res.ok) throw new Error(String(res.status))
                                              const blob = await res.blob()
                                              const url = URL.createObjectURL(blob)
                                              const a = document.createElement('a')
                                              a.href = url
                                              a.download = `dossier-${collection}-${itemId}.pdf`
                                              a.click()
                                              setTimeout(() => URL.revokeObjectURL(url), 30_000)
                                            } catch {
                                              toast.error('Dossier export failed')
                                            }
                                          }}
                                          className='inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'
                                        >
                                          <FileDown className='h-3.5 w-3.5' />
                                          {(
                                            activeLayoutData?.layout as
                                              | { dossier_label?: string | null }
                                              | undefined
                                          )?.dossier_label || 'Dossier'}
                                        </button>
                                      )}
                                    {!isNew && itemId && onDuplicate && (
                                      <button
                                        type='button'
                                        title='Duplicate this record into a new prefilled form — fields, linked values, and line items come along (attachments do not)'
                                        onClick={async () => {
                                          // Copy what a person would re-create: plain scalars + M2O
                                          // FKs, the M2M link sets (Zone, funding years…), and the
                                          // O2M grids' child rows. Excluded: id, audit stamps,
                                          // auto-id fields (they regenerate), computed fields
                                          // (server re-derives), attachments.
                                          const AUDIT = new Set([
                                            'id',
                                            'user_created',
                                            'date_created',
                                            'user_updated',
                                            'date_updated',
                                            'created_at',
                                            'updated_at',
                                            'created',
                                            'changed',
                                            'creator',
                                            'last_state_change'
                                          ])
                                          // Only fields the form actually SHOWS copy — hidden columns
                                          // are integration/system state (external ids, status
                                          // mirrors) that must not follow the record.
                                          const copyable = new Set<string>()
                                          const skip = new Set<string>(AUDIT)
                                          for (const fc of fieldConfig ?? []) {
                                            const opts = fc.options as Record<
                                              string,
                                              unknown
                                            > | null
                                            if (
                                              opts &&
                                              typeof opts === 'object' &&
                                              (opts as { auto_id?: unknown }).auto_id
                                            )
                                              skip.add(fc.field)
                                            if (
                                              (fc as { computed_type?: string | null })
                                                .computed_type
                                            )
                                              skip.add(fc.field)
                                            const readonlyFc = Boolean(
                                              (fc as { readonly?: boolean }).readonly
                                            )
                                            const noDupe = Boolean(
                                              opts &&
                                                typeof opts === 'object' &&
                                                (opts as { no_duplicate?: unknown }).no_duplicate
                                            )
                                            if (
                                              !fc.hidden &&
                                              !readonlyFc &&
                                              !noDupe &&
                                              (fc as { layout_assigned?: boolean })
                                                .layout_assigned !== false
                                            ) {
                                              copyable.add(fc.field)
                                            }
                                          }
                                          const values: Record<string, unknown> = {}
                                          for (const [k, v] of Object.entries(draft)) {
                                            if (
                                              !copyable.has(k) ||
                                              skip.has(k) ||
                                              k.includes('.') ||
                                              k.startsWith('__')
                                            )
                                              continue
                                            if (v === undefined || v === null || v === '') continue
                                            if (typeof v === 'object') continue
                                            values[k] = v
                                          }
                                          // M2M links — every alias's committed id set, staged on the
                                          // new form exactly like hand-picked selections.
                                          const links: Record<string, unknown[]> = {}
                                          for (const [
                                            aliasField,
                                            info
                                          ] of m2mAliasFieldsForRules.entries()) {
                                            // Attachments never copy — file links belong to the original.
                                            if (
                                              aliasField === 'files' ||
                                              /_files$/i.test(info.manyCollection)
                                            )
                                              continue
                                            const ids = m2mAliasFieldStates[aliasField]?.ids ?? []
                                            if (ids.length) links[info.stagingKey] = ids
                                          }
                                          // O2M child rows for the grids this layout shows (files
                                          // and audit children are not grids, so they never copy).
                                          const rows: Record<
                                            string,
                                            Array<Record<string, unknown>>
                                          > = {}
                                          const CHILD_SKIP = [
                                            'id',
                                            'user_created',
                                            'date_created',
                                            'user_updated',
                                            'date_updated',
                                            'created_at',
                                            'updated_at',
                                            'created',
                                            'changed',
                                            'creator'
                                          ]
                                          for (const fc of fieldConfig ?? []) {
                                            if (fc.hidden) continue
                                            const rel = (relations ?? []).find(
                                              (r) =>
                                                r.one_collection === collection &&
                                                !r.junction_field &&
                                                (r.one_field === fc.field ||
                                                  r.many_collection === fc.field)
                                            )
                                            if (!rel?.many_collection || !rel.many_field) continue
                                            const key = `${rel.many_collection}.${rel.many_field}`
                                            if (rows[key]) continue
                                            try {
                                              const res = (await client.request(
                                                get<{ data: Array<Record<string, unknown>> }>(
                                                  `/items/${rel.many_collection}`,
                                                  {
                                                    limit: 200,
                                                    filter: JSON.stringify({
                                                      [rel.many_field]: { _eq: itemId }
                                                    })
                                                  }
                                                )
                                              )) as { data: Array<Record<string, unknown>> }
                                              const childRows = (res.data ?? []).map((r0) => {
                                                const c = { ...r0 }
                                                for (const k of CHILD_SKIP) delete c[k]
                                                delete c[rel.many_field as string]
                                                for (const k of Object.keys(c)) {
                                                  if (c[k] === null || typeof c[k] === 'object')
                                                    delete c[k]
                                                }
                                                return c
                                              })
                                              if (childRows.length) rows[key] = childRows
                                            } catch {
                                              /* a grid that fails to read just doesn't copy */
                                            }
                                          }
                                          onDuplicate({ values, links, rows })
                                        }}
                                        className='inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'
                                        data-duplicate-record
                                      >
                                        <svg
                                          width='13'
                                          height='13'
                                          viewBox='0 0 24 24'
                                          fill='none'
                                          stroke='currentColor'
                                          strokeWidth='2'
                                          strokeLinecap='round'
                                          strokeLinejoin='round'
                                          aria-hidden='true'
                                        >
                                          <rect x='9' y='9' width='13' height='13' rx='2' />
                                          <path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' />
                                        </svg>
                                        Duplicate
                                      </button>
                                    )}
                                    {showItemActions && !isNew && (
                                      <ItemActionButtons
                                        collection={collection}
                                        itemId={String(itemId)}
                                      />
                                    )}
                                    {/* Admin-defined no-code actions (#39) — always
                                        mounted; renders nothing when none exist. */}
                                    {!isNew && itemId && (
                                      <CustomActionButtons
                                        collection={collection}
                                        itemId={String(itemId)}
                                        draft={draft}
                                      />
                                    )}
                                    {!isNew &&
                                      itemId &&
                                      fileLayouts.map((fl) => (
                                        <Button
                                          key={fl.id}
                                          type='button'
                                          variant='outline'
                                          size='sm'
                                          disabled={pdfLoading === fl.id}
                                          onClick={() => void downloadPdf(fl.id)}
                                          className='gap-1.5'
                                        >
                                          {pdfLoading === fl.id ? (
                                            <Loader2 className='h-3.5 w-3.5 animate-spin' />
                                          ) : (
                                            <FileDown className='h-3.5 w-3.5' />
                                          )}
                                          {fl.pdf_button_label || 'Export PDF'}
                                        </Button>
                                      ))}
                                    {(effectiveShowRevisions && !isNew) ||
                                    (effectiveShowClone && !isNew && isAdmin) ||
                                    canDelete ? (
                                      <>
                                        {effectiveShowRevisions && !isNew && (
                                          <RevisionsPanel
                                            collection={collection}
                                            item={itemId}
                                            onRollback={() =>
                                              qc.invalidateQueries({
                                                queryKey: ['item', collection, itemId]
                                              })
                                            }
                                          />
                                        )}
                                        {collision && (
                                          <MidairCollisionDialog
                                            collision={collision}
                                            fieldLabel={(f) => {
                                              const fc = allFields.find((af) => af.field === f)
                                              return fc?.label || titleCase(f)
                                            }}
                                            onCancel={() => setCollision(null)}
                                            onResolve={(takeTheirs) => {
                                              // 'theirs' fields adopt the newer value in the
                                              // draft; the retry then writes only what the
                                              // person explicitly kept, against the new base.
                                              for (const c of collision.conflicts) {
                                                if (takeTheirs.has(c.field)) {
                                                  setDraft((prev) => ({
                                                    ...prev,
                                                    [c.field]: c.current_value
                                                  }))
                                                }
                                              }
                                              baseRevisionOverrideRef.current = collision.latest
                                              setCollision(null)
                                              setTimeout(() => saveMut.mutate(), 0)
                                            }}
                                          />
                                        )}
                                        <ChangeReasonDialog
                                          challenge={crChallenge}
                                          fieldLabel={(f) => {
                                            const fc = allFields.find((af) => af.field === f)
                                            return fc?.label || titleCase(f)
                                          }}
                                          onCancel={() => setCrChallenge(null)}
                                          onSubmit={(reason) => {
                                            changeReasonRef.current = reason
                                            setCrChallenge(null)
                                            saveMut.mutate()
                                          }}
                                        />
                                        {isAdmin && !isNew && itemId && (
                                          <>
                                            <Button
                                              type='button'
                                              variant='outline'
                                              size='sm'
                                              onClick={() => setRawEditOpen(true)}
                                              title='Edit every field with conditional logic bypassed (admin)'
                                              className='gap-1.5'
                                            >
                                              <Wrench className='h-3.5 w-3.5' />
                                              Raw edit
                                            </Button>
                                            <RawEditSheet
                                              collection={collection}
                                              itemId={String(itemId)}
                                              open={rawEditOpen}
                                              onClose={() => setRawEditOpen(false)}
                                              onSaved={() => {
                                                qc.invalidateQueries({
                                                  queryKey: ['item', collection, String(itemId)]
                                                })
                                              }}
                                            />
                                          </>
                                        )}
                                        {effectiveShowClone && !isNew && isAdmin && (
                                          <CloneDialog
                                            collection={collection}
                                            itemId={itemId}
                                            fields={fieldConfig ?? []}
                                            relations={relations}
                                            currentValues={itemData ?? {}}
                                            onSuccess={(newId) => onSaved?.(String(newId))}
                                          />
                                        )}
                                        {canDelete &&
                                          (confirmDelete ? (
                                            <>
                                              <span className='text-sm text-muted-foreground'>
                                                Delete?
                                              </span>
                                              <Button
                                                type='button'
                                                size='sm'
                                                variant='destructive'
                                                className='gap-1.5'
                                                onClick={() => deleteMut.mutate()}
                                                disabled={deleteMut.isPending}
                                              >
                                                {deleteMut.isPending ? (
                                                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                                                ) : (
                                                  'Yes, delete'
                                                )}
                                              </Button>
                                              <Button
                                                type='button'
                                                size='sm'
                                                variant='outline'
                                                onClick={() => setConfirmDelete(false)}
                                              >
                                                Cancel
                                              </Button>
                                            </>
                                          ) : (
                                            <Button
                                              type='button'
                                              size='sm'
                                              variant='outline'
                                              className='gap-1.5 text-destructive hover:text-destructive'
                                              onClick={() => setConfirmDelete(true)}
                                            >
                                              <Trash2 className='h-3.5 w-3.5' />
                                            </Button>
                                          ))}
                                        <div className='mx-1 h-5 w-px bg-slate-200 dark:bg-border' />
                                      </>
                                    ) : null}
                                    </HeaderTools>
                                    {!isStepsMode && (
                                      <div className='relative'>
                                        {isDirty && !saveMut.isPending && (
                                          <span className='absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-white dark:ring-card' />
                                        )}
                                        <Button
                                          type='button'
                                          size='sm'
                                          onClick={() => handleSave()}
                                          disabled={saveMut.isPending || isReadOnly}
                                          className='gap-1.5'
                                        >
                                          {saveMut.isPending ? (
                                            <Loader2 className='h-3.5 w-3.5 animate-spin' />
                                          ) : justSaved ? (
                                            <Check className='nvr-pop h-3.5 w-3.5' />
                                          ) : (
                                            <Save className='h-3.5 w-3.5' />
                                          )}
                                          {justSaved ? 'Saved' : isNew ? 'Create' : 'Save'}
                                        </Button>
                                      </div>
                                    )}
                                    {!isNew && addendumEnabled && addendumData.length > 0 && (
                                      <div className='relative'>
                                        <button
                                          type='button'
                                          onClick={() => setAddendumViewDropdownOpen((o) => !o)}
                                          className={cn(
                                            'flex h-9 items-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition-colors',
                                            viewingAddendum
                                              ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400'
                                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300'
                                          )}
                                          title='Choose which version the form and actions apply to'
                                        >
                                          <span
                                            className={cn(
                                              'h-1.5 w-1.5 shrink-0 rounded-full',
                                              viewingAddendum ? 'bg-amber-400' : 'bg-slate-400'
                                            )}
                                          />
                                          <span className='max-w-[160px] truncate'>
                                            {viewingAddendum
                                              ? (addendumData.find((a) => a.id === addendumViewId)
                                                  ?.title ?? 'Addendum')
                                              : 'Viewing: Current record'}
                                          </span>
                                          <ChevronDown className='h-3 w-3 opacity-60' />
                                        </button>
                                        {addendumViewDropdownOpen && (
                                          <div className='absolute right-0 top-full z-30 mt-1 max-h-[320px] min-w-[240px] overflow-y-auto rounded-md border border-slate-200 bg-white py-0.5 shadow-lg dark:border-border dark:bg-card'>
                                            <button
                                              type='button'
                                              onClick={() => {
                                                setAddendumViewId('original')
                                                setAddendumViewDropdownOpen(false)
                                              }}
                                              className={cn(
                                                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.04]',
                                                addendumViewId === 'original' &&
                                                  'font-semibold text-slate-900 dark:text-slate-100'
                                              )}
                                            >
                                              <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400' />
                                              Current record
                                            </button>
                                            {addendumData.map((a) => (
                                              <button
                                                key={a.id}
                                                type='button'
                                                onClick={() => {
                                                  setAddendumViewId(a.id)
                                                  setAddendumViewDropdownOpen(false)
                                                }}
                                                className={cn(
                                                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-amber-50 dark:hover:bg-amber-500/10',
                                                  addendumViewId === a.id &&
                                                    'font-semibold text-amber-900 dark:text-amber-300'
                                                )}
                                              >
                                                <span
                                                  className={cn(
                                                    'h-1.5 w-1.5 shrink-0 rounded-full',
                                                    a.status === 'approved'
                                                      ? 'bg-emerald-400'
                                                      : a.status === 'rejected'
                                                        ? 'bg-red-400'
                                                        : 'bg-amber-400'
                                                  )}
                                                />
                                                <span className='flex-1 truncate'>{a.title}</span>
                                                <span className='text-[10px] capitalize text-slate-400'>
                                                  {a.status}
                                                </span>
                                              </button>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    {!isNew &&
                                      showPipeline &&
                                      (!isStepsMode || viewingAddendum) && (
                                        <PipelineTransitionButtons
                                          wrap={false}
                                          key={`${pipelineCollection}:${pipelineItem}`}
                                          collection={pipelineCollection}
                                          item={pipelineItem}
                                          // Same as the header buttons: save first, then transition.
                                          onBeforeTransition={async () => {
                                            if (!validateAll()) return false
                                            if (!isDirty) return true
                                            try {
                                              await saveMut.mutateAsync()
                                              return true
                                            } catch {
                                              return false
                                            }
                                          }}
                                        />
                                      )}
                                  </div>
                                </header>
                              )}

                              {showHeader &&
                                (headerWidgets.length > 0 || headerFields.length > 0) && (
                                  // Condensing HIDES rather than unmounts: a
                                  // remount refires every header widget/chip
                                  // fetch, which read as the sub-header
                                  // "reloading" on scroll-up.
                                  <div
                                    className={`shrink-0 items-center overflow-x-auto border-slate-100 border-slate-200 dark:border-border bg-white dark:bg-card shadow-[0_2px_6px_-2px_rgba(0,0,0,0.06)] px-4 ${headerCondensed ? 'hidden' : 'flex'}`}
                                  >
                                    {[
                                      ...headerWidgets.map((w) => ({
                                        type: 'widget' as const,
                                        sort: w.sort,
                                        key: w.field,
                                        data: w
                                      })),
                                      ...headerFields.map((f) => ({
                                        type: 'field' as const,
                                        sort: f.sort,
                                        key: f.field,
                                        data: f
                                      }))
                                    ]
                                      .sort((a, b) => a.sort - b.sort)
                                      .map((item) => {
                                        const copyCell = (
                                          el: HTMLElement | null,
                                          field: string
                                        ) => {
                                          if (!el) return
                                          const clone = el.cloneNode(true) as HTMLElement
                                          clone
                                            .querySelectorAll('[data-copy-skip], button')
                                            .forEach((n) => n.remove())
                                          const text = clone.textContent?.trim() ?? ''
                                          if (text) {
                                            navigator.clipboard.writeText(text).catch(() => {})
                                            setCopiedHeaderField(field)
                                            setTimeout(
                                              () =>
                                                setCopiedHeaderField((prev) =>
                                                  prev === field ? null : prev
                                                ),
                                              1500
                                            )
                                          }
                                        }

                                        if (item.type === 'widget') {
                                          const w = item.data
                                          const isBtnGroup =
                                            headerWidgetTypes[w.field] === 'button-group'
                                          return (
                                            <div
                                              key={w.field}
                                              className='group relative self-stretch border-r border-slate-200 dark:border-border'
                                            >
                                              <WidgetSlot
                                                widgetId={w.widgetId}
                                                inputBindings={w.inputBindings}
                                                itemDraft={effectiveDraft}
                                                itemCollection={collection}
                                                label={w.label ?? undefined}
                                                compact={true}
                                                strip={true}
                                                onWidgetType={(t) =>
                                                  setHeaderWidgetTypes((prev) => ({
                                                    ...prev,
                                                    [w.field]: t
                                                  }))
                                                }
                                              />
                                              {!isBtnGroup &&
                                                (copiedHeaderField === w.field ? (
                                                  <Check className='absolute top-2 right-2 h-3 w-3 text-green-500' />
                                                ) : (
                                                  <button
                                                    type='button'
                                                    className='absolute top-2 right-2 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity'
                                                    onClick={(e) =>
                                                      copyCell(
                                                        e.currentTarget.closest<HTMLElement>(
                                                          '.group'
                                                        ),
                                                        w.field
                                                      )
                                                    }
                                                  >
                                                    <Copy className='h-3 w-3 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400' />
                                                  </button>
                                                ))}
                                            </div>
                                          )
                                        }
                                        const f = item.data
                                        if (f.field === '__owners__') {
                                          return (
                                            <div
                                              key='__owners__'
                                              className='group relative flex flex-col justify-start border-r border-slate-200 dark:border-border px-4 py-2 min-w-0 transition-colors hover:bg-white/60 dark:hover:bg-white/[0.025]'
                                            >
                                              <span className='flex h-4 items-end truncate text-[10px] font-medium leading-none text-slate-400 dark:text-slate-500'>
                                                {f.label}
                                              </span>
                                              <div className='mt-1'>
                                                <OwnersInlineCompact
                                                  collection={collection}
                                                  itemId={itemId}
                                                />
                                              </div>
                                              {copiedHeaderField === '__owners__' ? (
                                                <Check className='absolute top-2 right-2 h-3 w-3 text-green-500' />
                                              ) : (
                                                <button
                                                  type='button'
                                                  className='absolute top-2 right-2 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity'
                                                  onClick={(e) =>
                                                    copyCell(
                                                      e.currentTarget.closest<HTMLElement>(
                                                        '.group'
                                                      ),
                                                      '__owners__'
                                                    )
                                                  }
                                                >
                                                  <Copy className='h-3 w-3 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400' />
                                                </button>
                                              )}
                                            </div>
                                          )
                                        }
                                        // M2M alias fields have no draft column — their value is the
                                        // committed junction id set the form already tracks (same
                                        // source SummaryPanel uses). Without this every M2M header
                                        // field renders '—' regardless of how many links exist.
                                        const aliasState = m2mAliasFieldStates[f.field]
                                        // A rollup header reads the live total while its grid is on
                                        // screen; otherwise the stored value, which is what the server
                                        // will recalculate to anyway.
                                        const liveRollup = liveRollupValues.get(f.field)
                                        const raw = aliasState
                                          ? aliasState.ids
                                          : (liveRollup ?? effectiveDraft[f.field])
                                        // Addendum view: a header value the addendum CHANGES reads amber,
                                        // matching the proposed-change styling everywhere else.
                                        const changedByAddendum =
                                          viewingAddendum &&
                                          !aliasState &&
                                          addendumViewData != null &&
                                          f.field in addendumViewData &&
                                          String(draft[f.field] ?? '') !==
                                            String(addendumViewData[f.field] ?? '')
                                        const hColorClass = changedByAddendum
                                          ? 'text-amber-600 dark:text-amber-400'
                                          : f.color === 'cyan'
                                            ? 'text-nvr-cyan'
                                            : f.color === 'blue'
                                              ? 'text-blue-600 dark:text-blue-400'
                                              : f.color === 'green'
                                                ? 'text-emerald-600 dark:text-emerald-400'
                                                : f.color === 'amber'
                                                  ? 'text-amber-600 dark:text-amber-400'
                                                  : f.color === 'red'
                                                    ? 'text-red-600 dark:text-red-400'
                                                    : f.color === 'purple'
                                                      ? 'text-purple-600 dark:text-purple-400'
                                                      : 'text-slate-900 dark:text-slate-100'
                                        const hWeightClass =
                                          f.weight === 'bold'
                                            ? 'font-bold'
                                            : f.weight === 'semibold'
                                              ? 'font-semibold'
                                              : f.weight === 'medium'
                                                ? 'font-medium'
                                                : 'font-semibold'
                                        const textCls = `${hColorClass} ${hWeightClass}`
                                        const isPill = f.displayAs === 'pill'
                                        const isTag = f.displayAs === 'tag'
                                        return (
                                          <div
                                            key={f.field}
                                            data-header-field={f.field}
                                            // self-stretch so the label sits the same distance from the
                                            // top as a widget cell's. The row is items-center, and a
                                            // widget stat cell already stretches to full height — a
                                            // centred field chip is shorter, so its label landed a few
                                            // pixels lower and the two read as misaligned.
                                            className='group relative flex flex-col justify-start self-stretch border-r border-slate-200 dark:border-border px-4 py-2 min-w-0 transition-colors hover:bg-white/60 dark:hover:bg-white/[0.025]'
                                          >
                                            <span className='flex h-4 items-end truncate text-[10px] font-medium leading-none text-slate-400 dark:text-slate-500'>
                                              {f.label}
                                            </span>
                                            <span
                                              className={[
                                                'mt-1 leading-tight truncate max-w-[220px] pb-px',
                                                isPill
                                                  ? `rounded-full px-2 py-0.5 text-[11px] inline-block ${hColorClass} bg-current/10`
                                                  : isTag
                                                    ? `rounded px-1.5 py-0.5 border border-current/30 text-[11px] inline-block ${hColorClass}`
                                                    : ''
                                              ]
                                                .filter(Boolean)
                                                .join(' ')}
                                            >
                                              {(() => {
                                                const inner = f.cmsField ? (
                                                  <StripFieldValue
                                                    field={f.cmsField}
                                                    val={raw}
                                                    relations={relations}
                                                    collection={collection}
                                                    displayFormat={f.displayFormat}
                                                    textClassName={textCls}
                                                  />
                                                ) : (
                                                  <span className={`text-[13px] ${textCls}`}>
                                                    {formatHeaderFieldValue(raw, f.displayFormat)}
                                                  </span>
                                                )
                                                // Configured link template ({{value}} + any {{field}} from
                                                // the draft) turns the header value into an external link
                                                // — how e.g. an MWF ID deep-links to the MWF system with
                                                // zero hardcoding (Table Editor header chip ⚙ → Link URL).
                                                const linkTemplate = (
                                                  f as { linkTemplate?: string }
                                                ).linkTemplate
                                                if (
                                                  !linkTemplate ||
                                                  raw === null ||
                                                  raw === undefined ||
                                                  raw === '' ||
                                                  Array.isArray(raw)
                                                )
                                                  return inner
                                                const href = linkTemplate
                                                  .replace(
                                                    /\{\{\s*value\s*\}\}/g,
                                                    encodeURIComponent(String(raw))
                                                  )
                                                  .replace(
                                                    /\{\{\s*([\w.]+)\s*\}\}/g,
                                                    (_m, k: string) =>
                                                      encodeURIComponent(String(draft[k] ?? ''))
                                                  )
                                                if (!/^https?:\/\//i.test(href)) return inner
                                                return (
                                                  <a
                                                    href={href}
                                                    target='_blank'
                                                    rel='noopener noreferrer'
                                                    className='underline decoration-dotted underline-offset-2 hover:decoration-solid'
                                                    onClick={(e) => e.stopPropagation()}
                                                  >
                                                    {inner}
                                                  </a>
                                                )
                                              })()}
                                            </span>
                                            {copiedHeaderField === f.field ? (
                                              <Check className='absolute top-2 right-2 h-3 w-3 text-green-500' />
                                            ) : (
                                              <button
                                                type='button'
                                                className='absolute top-2 right-2 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity'
                                                onClick={(e) => {
                                                  const cell =
                                                    e.currentTarget.closest<HTMLElement>('.group')
                                                  const valueSpan =
                                                    cell?.querySelectorAll<HTMLElement>(
                                                      ':scope > span'
                                                    )[1]
                                                  let text = ''
                                                  if (valueSpan) {
                                                    const clone = valueSpan.cloneNode(
                                                      true
                                                    ) as HTMLElement
                                                    clone
                                                      .querySelectorAll('[data-copy-skip]')
                                                      .forEach((el) => el.remove())
                                                    text = clone.textContent?.trim() ?? ''
                                                  }
                                                  if (text) {
                                                    navigator.clipboard
                                                      .writeText(text)
                                                      .catch(() => {})
                                                    setCopiedHeaderField(f.field)
                                                    setTimeout(
                                                      () =>
                                                        setCopiedHeaderField((prev) =>
                                                          prev === f.field ? null : prev
                                                        ),
                                                      1500
                                                    )
                                                  }
                                                }}
                                              >
                                                <Copy className='h-3 w-3 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400' />
                                              </button>
                                            )}
                                          </div>
                                        )
                                      })}
                                    {!isNew && itemId && (
                                      <div className='ml-auto self-center py-2 pl-3'>
                                        <ExternalRequestsChip
                                          collection={collection}
                                          itemId={String(itemId)}
                                        />
                                      </div>
                                    )}
                                  </div>
                                )}

                              <div
                                className={cn(
                                  'flex-1 min-h-0',
                                  summaryEnabled ? 'flex overflow-hidden' : 'overflow-y-auto'
                                )}
                                onScroll={summaryEnabled ? undefined : condenseOnScroll}
                              >
                                <div
                                  ref={bodyRef}
                                  className={cn(
                                    'p-6 space-y-4',
                                    summaryEnabled ? 'flex-1 overflow-y-auto' : ''
                                  )}
                                  onScroll={summaryEnabled ? condenseOnScroll : undefined}
                                >
                                  {extraTopContent}
                                  {configUpdated && (
                                    <div className='mb-2 flex items-center gap-2 rounded-md border border-[#00ceff66] bg-[#00ceff0d] px-3 py-1.5 text-[12px] text-[#007a99] dark:text-nvr-cyan'>
                                      <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-[#00ceff]' />
                                      Form definition updated — fields refreshed in place. Your
                                      unsaved edits are untouched.
                                    </div>
                                  )}
                                  {!isNew && itemId && (
                                    <RecordRecapStrip
                                      collection={collection}
                                      itemId={String(itemId)}
                                    />
                                  )}
                                  {!isNew && itemId && !activeLayoutData?.layout?.hide_integrity_banner && (
                                    <RecordIntegrityBanner
                                      collection={collection}
                                      itemId={String(itemId)}
                                      onJumpToField={flashField}
                                    />
                                  )}
                                  {!isNew && itemId && !activeLayoutData?.layout?.hide_sla_banner && (
                                    <SlaBreachBanner
                                      collection={collection}
                                      itemId={String(itemId)}
                                    />
                                  )}
                                  {importIssues.length > 0 && (
                                    <ImportIssuesPanel
                                      issues={importIssues}
                                      onDismiss={() => setImportIssues([])}
                                    />
                                  )}
                                  {showLockBanner && (
                                    <ItemLockBanner
                                      lockHolder={lockHolder}
                                      onTakeOver={takeOver}
                                      takingOver={takingOver}
                                      isAdmin={isAdmin}
                                      onRequestLock={requestLock}
                                      requesting={requesting}
                                    />
                                  )}
                                  {!isNew && (
                                    <RecordLiveSync
                                      collection={collection}
                                      itemId={String(itemId)}
                                    />
                                  )}
                                  {staleBy && (
                                    <div
                                      className='flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/10'
                                      data-stale-record-banner
                                    >
                                      <AlertTriangle className='h-4 w-4 shrink-0 text-amber-500' />
                                      <p className='min-w-0 flex-1 text-[12px] text-amber-800 dark:text-amber-300'>
                                        <span className='font-semibold'>{staleBy}</span> changed
                                        this record while you had it open
                                        {userTouchedRef.current.size > 0
                                          ? ' — review their changes before saving, or your edits may overwrite theirs.'
                                          : ' — refresh to see the latest values.'}
                                      </p>
                                      <button
                                        type='button'
                                        onClick={refreshStaleRecord}
                                        className='shrink-0 rounded-md border border-amber-400 bg-white px-2.5 py-1 text-[11.5px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/50 dark:bg-transparent dark:text-amber-300 dark:hover:bg-amber-500/15'
                                      >
                                        {userTouchedRef.current.size > 0 ? 'Dismiss' : 'Refresh'}
                                      </button>
                                    </div>
                                  )}
                                  {hasTabs
                                    ? isStepsMode
                                      ? renderStepsMode()
                                      : renderTabMode()
                                    : renderSectionMode()}
                                  {extraBottomContent}
                                </div>
                                {summaryEnabled && (
                                  <div className='flex shrink-0 border-l border-slate-200'>
                                    <button
                                      type='button'
                                      onClick={() => setSummaryCollapsed((v) => !v)}
                                      title={
                                        summaryCollapsed ? 'Expand summary' : 'Collapse summary'
                                      }
                                      className='border-r flex w-6 shrink-0 items-start justify-center pt-3 bg-slate-100 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 transition-colors dark:bg-white/[0.04] dark:hover:bg-white/[0.08] dark:text-slate-500 dark:hover:text-slate-300'
                                    >
                                      {summaryCollapsed ? (
                                        <ChevronLeft className='h-3.5 w-3.5' />
                                      ) : (
                                        <ChevronRight className='h-3.5 w-3.5' />
                                      )}
                                    </button>
                                    <div
                                      className='overflow-hidden transition-all duration-200'
                                      style={{ width: summaryCollapsed ? 0 : 232 }}
                                    >
                                      <div className='w-[232px] overflow-y-auto h-full'>
                                        <SummaryPanel
                                          layoutFields={
                                            (activeLayoutData?.assignments?.length ?? 0) > 0
                                              ? new Set(
                                                  (activeLayoutData?.assignments ?? []).map(
                                                    (a) => a.field
                                                  )
                                                )
                                              : null
                                          }
                                          allSteps={
                                            allTabGroups.length > 0
                                              ? allTabGroups.map((g) => ({
                                                  key: g.key,
                                                  label: g.label
                                                }))
                                              : allSteps
                                          }
                                          groupedMap={groupedMap}
                                          ungroupedFields={ungroupedFields}
                                          sectionGroups={sectionGroups.filter(
                                            (g) => g.type !== 'metadata'
                                          )}
                                          draft={draft}
                                          relations={relations}
                                          collection={collection}
                                          itemId={itemId}
                                          staging={m2mStagingCtx}
                                          errors={validationErrors}
                                          staleFields={staleFields}
                                          // M2M alias values never live in the draft, so the panel
                                          // cannot judge them empty on its own — it would mark a
                                          // populated field "required". Hand it the state the form
                                          // already tracks, and say nothing while it is unsettled.
                                          aliasEmptiness={{
                                            // O2M aliases: effective row count (saved − staged
                                            // deletes + pending) — without this a populated grid
                                            // read as "required" in the summary. Unsettled = null.
                                            ...Object.fromEntries(
                                              [...o2mAliasFields].map((field) => [
                                                field,
                                                field in o2mEffectiveCounts
                                                  ? o2mEffectiveCounts[field] === 0
                                                  : null
                                              ])
                                            ),
                                            ...Object.fromEntries(
                                              Object.entries(m2mAliasFieldStates).map(
                                                ([field, st]) => [
                                                  field,
                                                  st.known ? st.ids.length === 0 : null
                                                ]
                                              )
                                            )
                                          }}
                                          onFieldClick={(stepKey, fieldKey) => {
                                            // An empty step key means the field belongs to no step
                                            // (the Related child collections) — there is no tab to
                                            // open, so go straight to where it is rendered.
                                            if (stepKey) {
                                              if (hasContainers) {
                                                const ownerContainer = containerGroups.find((c) =>
                                                  groups.some(
                                                    (g) =>
                                                      g.type === 'tab' &&
                                                      g.container_id === c.id &&
                                                      g.key === stepKey
                                                  )
                                                )
                                                if (ownerContainer) {
                                                  setContainerTab(ownerContainer, stepKey)
                                                  bodyRef.current?.scrollTo({ top: 0 })
                                                } else {
                                                  setActiveTab(stepKey)
                                                }
                                              } else {
                                                setActiveTab(stepKey)
                                              }
                                            }
                                            // Switching a tab mounts that panel, and an inline grid
                                            // does not exist in the DOM until it does — one 80ms
                                            // shot missed it and the click read as doing nothing.
                                            // Poll briefly instead, then give up quietly.
                                            let tries = 0
                                            const find = () => {
                                              const el = (document.querySelector(
                                                `[data-field="${fieldKey}"]`
                                              ) ??
                                                document.querySelector(
                                                  `[data-header-field="${fieldKey}"]`
                                                )) as HTMLElement | null
                                              if (!el) {
                                                if (tries++ < 12) setTimeout(find, 60)
                                                return
                                              }
                                              el.scrollIntoView({
                                                behavior: 'smooth',
                                                block: 'center'
                                              })
                                              el.classList.add(
                                                'ring-2',
                                                'ring-nvr-cyan',
                                                'ring-offset-2',
                                                'rounded-md'
                                              )
                                              setTimeout(
                                                () =>
                                                  el.classList.remove(
                                                    'ring-2',
                                                    'ring-nvr-cyan',
                                                    'ring-offset-2',
                                                    'rounded-md'
                                                  ),
                                                1500
                                              )
                                              // Only pull focus for a field you can actually type
                                              // in; focusing a grid's first button scrolls it back
                                              // out from under the highlight.
                                              const input = el.querySelector(
                                                'input,textarea,select'
                                              ) as HTMLElement | null
                                              input?.focus()
                                            }
                                            setTimeout(find, 60)
                                          }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </M2MStagingContext.Provider>
                        </StagedRelationsContext.Provider>
                      </LiveRowsContext.Provider>
                    </O2MStagingContext.Provider>
                  </StaleFieldReportContext.Provider>
                </GridFlushContext.Provider>
              </ParentDraftContext.Provider>
            </AddendumFieldContext.Provider>
          </AddendumViewContext.Provider>
        </AddendumO2MContext.Provider>
      </RelationPathDataContext.Provider>
    </ReimportHandlerContext.Provider>
  )
}

/**
 * Mid-air collision merge dialog: someone else saved the same fields since
 * this draft loaded. Per field, keep THEIRS (adopt the newer value) or MINE
 * (overwrite it) — the retry writes only what was explicitly kept, against
 * the newer revision baseline. Defaults to theirs: overwriting a colleague's
 * work should be the deliberate choice, not the path of least resistance.
 */
function MidairCollisionDialog({
  collision,
  fieldLabel,
  onCancel,
  onResolve
}: {
  collision: {
    conflicts: Array<{ field: string; current_value: unknown }>
    mine: Record<string, unknown>
  }
  fieldLabel: (field: string) => string
  onCancel: () => void
  onResolve: (takeTheirs: Set<string>) => void
}) {
  const [takeTheirs, setTakeTheirs] = useState<Set<string>>(
    () => new Set(collision.conflicts.map((c) => c.field))
  )
  const fmt = (v: unknown) =>
    v == null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 200)
  return createPortal(
    <div className='fixed inset-0 z-[130] flex items-center justify-center'>
      <div className='absolute inset-0 bg-black/40' onClick={onCancel} />
      <div className='relative w-[560px] max-w-[94vw] rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-border dark:bg-card'>
        <p className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
          Someone else changed this record
        </p>
        <p className='mt-1 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          These fields were saved by someone else while you were editing. Pick which value wins for
          each — everything else you changed saves normally.
        </p>
        <div className='mt-3 max-h-[320px] space-y-2 overflow-y-auto'>
          {collision.conflicts.map((c) => {
            const theirs = takeTheirs.has(c.field)
            return (
              <div key={c.field} className='rounded-md border border-slate-200 p-2.5 dark:border-border'>
                <p className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                  {fieldLabel(c.field)}
                </p>
                <div className='mt-1.5 grid grid-cols-2 gap-2'>
                  <button
                    type='button'
                    onClick={() => setTakeTheirs((prev) => new Set([...prev, c.field]))}
                    className={
                      theirs
                        ? 'rounded-md border-2 border-nvr-cyan/60 bg-nvr-cyan/5 px-2.5 py-1.5 text-left'
                        : 'rounded-md border border-slate-200 px-2.5 py-1.5 text-left hover:border-slate-300 dark:border-border'
                    }
                  >
                    <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                      Theirs (current)
                    </p>
                    <p className='mt-0.5 break-words text-[12px] text-slate-700 dark:text-foreground'>
                      {fmt(c.current_value)}
                    </p>
                  </button>
                  <button
                    type='button'
                    onClick={() =>
                      setTakeTheirs((prev) => {
                        const next = new Set(prev)
                        next.delete(c.field)
                        return next
                      })
                    }
                    className={
                      !theirs
                        ? 'rounded-md border-2 border-amber-400/70 bg-amber-50 px-2.5 py-1.5 text-left dark:bg-amber-400/10'
                        : 'rounded-md border border-slate-200 px-2.5 py-1.5 text-left hover:border-slate-300 dark:border-border'
                    }
                  >
                    <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                      Mine (overwrite)
                    </p>
                    <p className='mt-0.5 break-words text-[12px] text-slate-700 dark:text-foreground'>
                      {fmt(collision.mine[c.field])}
                    </p>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <div className='mt-4 flex items-center justify-end gap-2'>
          <button
            type='button'
            onClick={onCancel}
            className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-600 dark:border-border dark:text-muted-foreground'
          >
            Cancel save
          </button>
          <button
            type='button'
            onClick={() => onResolve(takeTheirs)}
            className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white'
          >
            Apply &amp; save
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
