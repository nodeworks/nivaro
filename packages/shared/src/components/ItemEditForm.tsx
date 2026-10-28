import type { ImportParseResponse, ImportTemplateSummary } from '@nivaro/sdk'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  Eye,
  FileDown,
  LifeBuoy,
  Loader2,
  Lock,
  MessageSquarePlus,
  PencilLine,
  PictureInPicture2,
  Save,
  Trash2,
  Wand2,
  Waypoints,
  Wrench,
  X
} from 'lucide-react'
import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
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
  useItemNavigation,
  useNivaroClient,
  useRecordSurface
} from '../context'
import { formatApiPayload } from '../lib/api-payload'
import { del, get, patch, post, put } from '../lib/commands'
import {
  deleteDraft,
  draftCreatedAs,
  draftHasContent,
  draftKey,
  draftMatchesPrefill,
  loadDraft,
  markDraftCreated,
  prefillSignature,
  type StoredDraft,
  saveDraft
} from '../lib/draft-store'
import { entryConfigOf } from '../lib/entry-config'
import { setFormulaConstants } from '../lib/expression'
import { setFiscalStartMonth } from '../lib/fiscal'
import {
  isEmptyValue,
  isFolded,
  planFieldGrid,
  type RowGroup,
  readGroupStructure,
  stickyGroupKey
} from '../lib/form-structure'
import {
  HEADER_BAND,
  HEADER_DOCK,
  HEADER_DOCK_CELL,
  HEADER_DOCK_INLINE,
  HEADER_LABEL,
  HEADER_ROW,
  HEADER_TILE,
  HEADER_TILES,
  HEADER_VALUE,
  HEADER_VALUE_HERO,
  HEADER_VALUE_LINE
} from '../lib/header-strip'
import { type LayoutGrantFlags, layoutGrantedTools } from '../lib/layout-grants'
import { formLocale, translateFieldRow, translateGroup } from '../lib/layout-i18n'
import { currentViewport } from '../lib/layout-resolve'
import { extSlotKey } from '../lib/layout-slots'
import { useLeaveLinkGuard } from '../lib/leave-guard'
import { useLiveRefetchInterval } from '../lib/live-queries'
import { useRecordReader } from '../lib/record-loader'
import {
  bindRecordOutbox,
  checkUnknownBase,
  claimRecordOutbox,
  discardRecordOutbox,
  enqueueRecordSave,
  isOfflineSaveError,
  midairCollisionOf,
  onRecordOutboxEvent,
  onRecordOutboxRetry,
  retryRecordOutbox,
  settleRecordOutbox
} from '../lib/record-outbox'
import { isRecordPopout, openRecordPopout } from '../lib/record-popout'
import { announceRecordTabs } from '../lib/record-tabs'
import { invalidateRecordTasks } from '../lib/record-tasks'
import { reportCodeError, userErrorMessage } from '../lib/safe-error'
import { htmlToText } from '../lib/sanitize-html'
import {
  normalizeSummaryModeRules,
  resolveSummaryMode,
  type SummaryModeRules,
  summaryRulesNeedRecord,
  summaryRulesNeedRole,
  summaryRulesNeedState
} from '../lib/summary-mode'
import { isReloadingForUpdate, useUnsavedWork } from '../lib/unsaved-work'
import { choiceLabel, cn, formatRelative, titleCase, toLocalDateString } from '../lib/utils'
import { applyValidationRule } from '../lib/validation-rules'
import { matchesVisibleWhen } from '../lib/visible-when'
import type { AvailableBulkAction } from './bulk/BulkActionButtons'
import { CopyAsButton } from './CopyAsButton'
import { useHuddleFollowSurface } from './chat/huddle/huddle-follow-bus'
import { FormWhatsNew } from './FormWhatsNew'
import { showFormVideosButton } from './help-videos/viewer/format'
import { HelpVideoButton } from './help-videos/viewer/HelpVideoButton'
import {
  type DocumentApplySelection,
  DocumentAutofillButton
} from './import/DocumentAutofillButton'
import { evaluateImportLineRules, RULE_SET_KEY } from './import/evaluateLineRules'
import { ImportColumnChips } from './import/ImportColumnChips'
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
import { type ChangeItem, ChangesTray } from './item-edit/ChangesTray'
import { CloneDialog } from './item-edit/CloneDialog'
import { columnLengthError } from './item-edit/column-length'
import { configUpdateReaction } from './item-edit/config-update'
import { DraftRecoveryBanner } from './item-edit/DraftRecoveryBanner'
import { ExtLayoutSlot } from './item-edit/ExtLayoutSlot'
import {
  type FieldAffordances,
  FieldAffordancesContext,
  type RemoteFieldChange
} from './item-edit/FieldAffordances'
import { FieldRow } from './item-edit/FieldRow'
import { FoldArea, RowGroupCell, rowMemberField } from './item-edit/form-structure-ui'
import {
  GroupSection,
  InlineDisplay,
  OwnersInline,
  OwnersInlineCompact,
  StripFieldValue
} from './item-edit/GroupSection'
import { HeaderTiles, useHeaderBand } from './item-edit/HeaderBand'
import { HeaderFreshness } from './item-edit/HeaderFreshness'
import { HeaderRollupExplainer } from './item-edit/HeaderRollupExplainer'
import { HeaderSummaryChip, type HeaderSummaryConfig } from './item-edit/HeaderSummaryChip'
import { HeaderMenu, HeaderToolGroup, HeaderTools } from './item-edit/HeaderTools'
import { HighlightedCode } from './item-edit/HighlightedCode'
import {
  applyDisplayTemplate,
  type CascadeRule,
  getCascadeFilters,
  isSentinelKey,
  parseJson,
  resolveColSpan,
  SENTINEL_FIELDS,
  SYSTEM_FIELDS,
  useContainerWidth
} from './item-edit/helpers'
import { evalClientFormula } from './item-edit/InlineTableField'
import { LayoutContentBlock, SectionIntro } from './item-edit/LayoutContentBlock'
import { deferredSections } from './item-edit/lazy-sections'
import { checkNumberEntry, NUMBER_FIELD_TYPES, ruleValueFor } from './item-edit/line-qty'
import {
  computeLiveRollup,
  isDerivedForRecord,
  matchesRollupFilter,
  parseRollupParentFilter,
  parseRollupSources
} from './item-edit/live-rollups'
import { HiddenByRulesNote, refineLockReasons, useLockWhy } from './item-edit/lock-why'
import { m2aWriteMeta, resolveM2MRelatedCollection } from './item-edit/M2MCombobox'
import { M2MStagingContext, type M2MStagingCtx } from './item-edit/M2MStagingContext'
import { editedRowIds, invalidateM2MFor } from './item-edit/m2m-invalidate'
import {
  LiveRowsContext,
  type LiveRowsCtx,
  O2MStagingContext,
  type O2MStagingCtx,
  StagedRelationsContext,
  type StagedRelationsCtx,
  type StagedRelOps
} from './item-edit/O2MStagingContext'
import { makePersonalDefaultChecks } from './item-edit/personal-default-checks'
import {
  confirmChangeFields,
  fieldCounterError,
  fieldIsRecommended,
  isDisplayFormulaRow,
  missingRecommended,
  placementBehaviourNeeds,
  placementFieldText,
  usePlacementTextContext
} from './item-edit/placement-behaviour'
import { QueueReturnChip } from './item-edit/QueueReturnChip'
import { QuickPicker } from './item-edit/QuickPicker'
import { RawEditSheet } from './item-edit/RawEditSheet'
import { RecordChatActions } from './item-edit/RecordChatActions'
import { PickerExclusionToggle, ScheduleChangeButton } from './item-edit/RecordGrantTools'
import {
  RecordHeaderActionButtons,
  RecordHeaderActionDialog,
  useRecordHeaderActions
} from './item-edit/RecordHeaderActions'
import {
  invalidateRecordInsights,
  invalidateRecordNotes,
  RecordInsightsButton
} from './item-edit/RecordInsights'
import { RecordAccessLostPanel, type RecordGone, RecordLiveSync } from './item-edit/RecordLiveSync'
import { RecordOutboxBanner, useRecordOutboxEntry } from './item-edit/RecordOutbox'
import { RecordRecapStrip } from './item-edit/RecordRecapStrip'
import { RecordSubscribeButton } from './item-edit/RecordSubscribeButton'
import { recordLookupsFor, rememberRecordLookups } from './item-edit/record-lookups'
import { useStableFieldAffordances } from './item-edit/render-stability'
import { refusedFieldOf } from './item-edit/save-refusal'
import { foldStagedLinks, foldStagedRows } from './item-edit/staged-links'
import { useFormUsageBeacon } from './item-edit/useFormUsageBeacon'
import {
  linksBeyond,
  type PersonalDefaultsApi,
  PersonalDefaultsContext,
  sameDefaultValue,
  usePersonalDefaults
} from './item-edit/usePersonalDefaults'
import { ValidationSummary, type ValidationSummaryItem } from './item-edit/ValidationSummary'
import { useViewAsRole, ViewAsRoleBar } from './item-edit/ViewAsRole'
import { RecordIntegrityBanner } from './panels/RecordIntegrityBanner'
import { SlaBreachBanner } from './panels/SlaBreachBanner'
import { RecordGraphSheet } from './RecordGraph'
import { type ReadViewLayout, RecordReadView } from './RecordReadView'
import { SuggestFormChange } from './support/SuggestFormChange'
import { SupportRequestDialog } from './support/SupportRequestDialog'

let formulaCtxHydrated = false

import { EntryStrip } from './item-edit/entry/EntryStrip'
import { useEntryKeyboard } from './item-edit/entry/useEntryKeyboard'
import { useEntryMode } from './item-edit/entry/useEntryMode'
import { type FindableField, FindInRecordButton } from './item-edit/FindInRecord'
import { RecordViewersChip } from './item-edit/RecordViewersChip'
import { StepsBar } from './item-edit/StepsBar'
import { M2OSummaryValue, SummaryPanel } from './item-edit/SummaryPanel'
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
import { DesignDropBody, DesignDropZone, designWrap } from './layout-editor/DesignNode'
import { DesignCanvas } from './layout-editor/design-canvas'
import {
  type DesignTarget,
  type LayoutDesignProp,
  revealGroupKey,
  useLayoutDesign
} from './layout-editor/design-context'
import { GridGuides } from './layout-editor/grid-guides'
import {
  DESIGN_SUMMARY_MIN_CANVAS,
  readDesignSummaryCollapsed,
  writeDesignSummaryCollapsed
} from './layout-editor/summary-pref'
import {
  AccessDeniedPanel,
  AddendumPanel,
  CommentPanel,
  CustomActionButtons,
  deniedToastAction,
  ExternalRequestsChip,
  ItemActionButtons,
  ItemLockBanner,
  isAccessRefusal,
  LockHolderButton,
  OwnersSlot,
  PipelinePanel,
  PipelineTransitionButtons,
  ReferencedByPanel,
  RelatedRecordsPanel,
  RevisionsPanel,
  TaskPanel,
  useItemLock,
  WhyDeniedButton,
  WorkflowPanel
} from './panels'
import { RecordEventPathSheet } from './panels/IntegrationActivitySection'
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
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Skeleton } from './ui/skeleton'
import { type InputBinding, WidgetSlot } from './WidgetSlot'

/** The Summary rail's fold strip on the layout editor canvas (design mode only). */
const DESIGN_RAIL_TOGGLE =
  'border-r flex w-6 shrink-0 items-start justify-center pt-3 bg-slate-100 text-slate-500 hover:bg-slate-200/70 hover:text-slate-700 transition-colors dark:bg-white/[0.04] dark:hover:bg-white/[0.08] dark:hover:text-slate-300'

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
  // The canvas's column guides (#2701) sit in the grid: it positions them there only.
  const design = useLayoutDesign()
  return (
    <div ref={ref} className={cn(design && 'relative', 'grid grid-cols-12 gap-4 items-start')}>
      <GridGuides />
      {children(containerWidth)}
    </div>
  )
}

// ─── Save progress dialog ──────────────────────────────────────────────────────

/** The "can't save yet" toast — one at a time however often Save is pressed. */
const VALIDATION_TOAST_ID = 'nvr-form-validation'

type SaveStepStatus = 'pending' | 'running' | 'done' | 'error'
interface SaveStepItem {
  id: string
  label: string
  status: SaveStepStatus
  detail?: string
  progress?: { done: number; total: number }
  error?: string
  /** The server refused on access (403) — the dialog offers "Why?" (#1867). */
  denied?: boolean
}

function SaveStepIcon({ status }: { status: SaveStepStatus }) {
  if (status === 'running')
    return <Loader2 className='h-4 w-4 animate-spin text-nvr-cyan shrink-0' />
  if (status === 'done') return <Check className='h-4 w-4 text-green-500 shrink-0' />
  if (status === 'error') return <AlertCircle className='h-4 w-4 text-red-500 shrink-0' />
  return (
    <div className='h-4 w-4 rounded-full border-2 border-slate-200 dark:border-slate-600 shrink-0' />
  )
}

function SaveProgressDialog({
  open,
  steps,
  onClose,
  record
}: {
  open: boolean
  steps: SaveStepItem[]
  onClose: () => void
  /** The saved record — set for an existing record, so a refusal can be explained. */
  record?: { collection: string; itemId: string } | null
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
            {!allSettled && <Loader2 className='h-4 w-4 animate-spin text-nvr-cyan' />}
            {allSettled && hasError && <AlertCircle className='h-4 w-4 text-red-500' />}
            {allSettled && !hasError && <Check className='h-4 w-4 text-green-500' />}
            {hasError
              ? doneCount === 0
                ? 'Nothing was saved'
                : 'Saved with errors'
              : allSettled
                ? 'All changes saved'
                : 'Saving changes…'}
          </DialogTitle>
          <div className='flex items-center gap-3 pt-1'>
            <div className='flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-muted overflow-hidden'>
              <div
                className='h-full rounded-full bg-nvr-cyan transition-all duration-500'
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
                    step.status === 'running' && 'border-nvr-cyan/30 bg-nvr-cyan/5',
                    step.status === 'done' &&
                      'border-green-100 bg-green-50/40 dark:border-green-500/25 dark:bg-green-500/10',
                    step.status === 'error' &&
                      'border-red-200 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10',
                    step.status === 'pending' &&
                      'border-slate-100 bg-slate-50/60 dark:border-border dark:bg-muted/30'
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
                            step.status === 'done' && 'text-slate-400 dark:text-slate-300',
                            step.status === 'error' && 'text-red-700 dark:text-red-300',
                            step.status === 'running' && 'text-slate-900 dark:text-foreground',
                            step.status === 'pending' && 'text-slate-500 dark:text-muted-foreground'
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
                          {step.denied && record && (
                            <>
                              {' '}
                              <WhyDeniedButton
                                collection={record.collection}
                                itemId={record.itemId}
                                action='update'
                              />
                            </>
                          )}
                        </p>
                      )}
                      {step.status === 'running' && rowPct !== null && (
                        <div className='mt-1.5 h-1 rounded-full bg-slate-200 overflow-hidden'>
                          <div
                            className='h-full rounded-full bg-nvr-cyan transition-all duration-200'
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

/** What is unsaved right now — the leave-page prompt, the changes tray and
 *  the host's own dirty indicator all read this one breakdown. */
export interface UnsavedSummary {
  fields: string[]
  rows: number
  edits: number
  deletes: number
  links: number
  unlinks: number
  total: number
  /** "2 fields, 3 lines, 1 link" — empty when clean. */
  text: string
}

export interface ItemEditFormProps {
  collection: string
  itemId?: string
  layoutSlug?: string
  /** Open with this addendum's view selected (the `?addendum=` deep link that
   *  My Work rows, digest lines and notifications carry). */
  initialAddendumViewId?: string | null
  /** Fires whenever the selected view changes: an addendum id, or null for the
   *  current record — hosts mirror it into the URL / tab chrome. */
  onAddendumViewChange?: (addendumId: string | null) => void
  onBack?: () => void
  onSaved?: (id: string) => void
  onDeleted?: () => void
  showHeader?: boolean
  /** Host-provided content rendered at the start of the header's action
   *  cluster (e.g. an "Open Project 360°" link) — keeps host actions inside
   *  the toolbar instead of floating above the form. */
  headerExtra?: ReactNode
  /** Render extension-registered item actions (Push to Fusion etc.) in the
   *  header toolbar. Off by default — the admin's ItemEdit page renders its
   *  own copy in the page header; headless hosts opt in. */
  showItemActions?: boolean
  /** Offer "Schedule a change…" and "Disable in pickers" in the More menu
   *  when this record's form grants them to everyone (allow_schedule /
   *  allow_disable_pickers) or the viewer is an admin. Off by default — the
   *  admin's ItemEdit page renders its own copies in the page header;
   *  headless hosts opt in. */
  showGrantedTools?: boolean
  /** Extra rows for the record's More menu, above Delete (e.g. a host's Edit layout).
   *  Rows that open something outside the menu set `data-nvr-menu-close`. */
  moreMenuItems?: ReactNode
  /** Which view the record shows (Summary or Edit) and the collection's Summary layout id
   *  (null = none; Summary then renders the edit layout read-only). Hosts use it so their
   *  Edit layout opens the layout the person is looking at. */
  onViewModeChange?: (view: { mode: 'summary' | 'edit'; summaryLayoutId: number | null }) => void
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
  /** Dirty flag plus a breakdown of what is unsaved (fields, staged lines, links) — hosts render their own leave-page prompt from it. */
  onDirtyChange?: (dirty: boolean, summary?: UnsavedSummary) => void
  /** false = skip the document.title side effect — a workspace-tab host keeps
   *  several forms mounted and only the ACTIVE one may own the browser tab. */
  documentTitle?: boolean
  /** false = mounted but not on screen (a background workspace tab): the form
   *  lets its edit lock go after a while and takes it back when shown. */
  active?: boolean
  /** Hands the host a stable save trigger (workspace "Save all"); called with
   *  null on unmount. The trigger runs the same handleSave the button does —
   *  validation and dialogs included. */
  registerSaveHandler?: (fn: (() => void) | null) => void
  onDuplicate?: (payload: {
    values: Record<string, unknown>
    links: Record<string, unknown[]>
    rows: Record<string, Array<Record<string, unknown>>>
    /** The form the source record opened in — the copy should open in it
     *  too, not the collection's default. */
    layout_slug?: string | null
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
  /** Hide the header's own Videos button, for a host whose top bar already carries it. */
  hideHelpVideoButton?: boolean
  extraBottomContent?: ReactNode
  onHeaderWidgets?: (widgets: HeaderWidgetInfo[]) => void
  /** Open the new-record form on a stored document proposal (`?autofill=<id>`
   *  from a list's "New from document…" or the ready notification). */
  autofillProposalId?: string | null
  /** The proposal was picked up — the host may drop `?autofill=` from the URL. */
  onAutofillConsumed?: () => void
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
  /** Layout editor canvas (spec §7.3): render this draft layout with the
   *  preview record's values, every placement selectable, nothing written. */
  design?: LayoutDesignProp
  /** The host has Edit layout open on this collection over this form, or closed it and its
   *  last save has not settled yet (useLayoutEditingQuiet). Config pushes naming this
   *  collection are then the admin's own saves: no "This form was changed" banner and no
   *  refetch per save — the host re-reads the layout queries once the editor's saves land. */
  layoutEditing?: boolean
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
      return toLocalDateString(value)
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

// ─── Unsaved-changes inspector ─────────────────────────────────────────────────
// The amber dirty dot answers "you have unsaved changes"; this popover answers
// "WHICH ones" — draft fields that differ from the loaded record (old → new),
// plus staged relation links and queued grid rows. Also the debugging tool for
// phantom-dirty reports: whatever appears here is what flipped the flag.

/** One side of a change, as people read it: a related record's label (never its
 *  id), a choice's text, Yes/No — the raw value only for plain fields. */
function ChangeValue({
  value,
  field,
  m2oTarget
}: {
  value: unknown
  field: CMSField | null
  m2oTarget: string | null
}) {
  if (value === null || value === undefined || value === '') return <>empty</>
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>
  if (m2oTarget && (typeof value === 'string' || typeof value === 'number'))
    return <M2OSummaryValue collection={m2oTarget} id={value} />
  const choices = parseJson<{ choices?: Array<{ text?: string; value?: unknown }> }>(
    field?.options
  )?.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const values = Array.isArray(value) ? value : [value]
    const texts = values.map((v) => {
      const c = choices.find((ch) => String(ch.value) === String(v))
      return c?.text ? choiceLabel(c.text) : String(v)
    })
    return <>{texts.join(', ')}</>
  }
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return <>{str.length > 60 ? `${str.slice(0, 60)}…` : str}</>
}

export function UnsavedInspector({
  open,
  onClose,
  collection,
  relations,
  fieldConfig,
  draft,
  initial,
  m2mLinks,
  m2mUnlinks,
  pendingRowCount,
  pendingDeleteCount
}: {
  open: boolean
  onClose: () => void
  collection: string
  relations: CMSRelation[]
  fieldConfig: CMSField[] | undefined
  draft: Record<string, unknown>
  initial: Record<string, unknown>
  m2mLinks: Map<string, unknown[]>
  m2mUnlinks: Map<string, Set<unknown>>
  pendingRowCount: number
  pendingDeleteCount: number
}) {
  if (!open) return null
  const m2oTarget = (field: string): string | null =>
    relations.find(
      (r) => r.many_collection === collection && r.many_field === field && !r.junction_field
    )?.one_collection ?? null
  const fieldLabel = (key: string, f?: CMSField | null) =>
    f?.label || titleCase(key.replace(/_/g, ' '))
  const byField = new Map((fieldConfig ?? []).map((f) => [f.field, f]))
  const rows: Array<{ key: string; label: string; from: unknown; to: unknown }> = []
  for (const f of fieldConfig ?? []) {
    if (valuesEqual(draft[f.field], initial[f.field])) continue
    if (draft[f.field] === undefined) continue
    rows.push({
      key: f.field,
      label: fieldLabel(f.field, f),
      from: initial[f.field],
      to: draft[f.field]
    })
  }
  // Draft keys the field config doesn't know (machine columns) still count.
  for (const k of Object.keys(draft)) {
    if (byField.has(k) || k.startsWith('__')) continue
    if (valuesEqual(draft[k], initial[k])) continue
    rows.push({ key: k, label: k, from: initial[k], to: draft[k] })
  }
  // Staged links are keyed by the alias field; the records they add live in the
  // collection on the junction's other leg.
  const linkTarget = (key: string): string | null => {
    const r = relations.find((rel) => rel.one_collection === collection && rel.one_field === key)
    if (!r) return null
    return (
      relations.find((c) => c.many_collection === r.many_collection && c.id !== r.id)
        ?.one_collection ?? null
    )
  }
  const linkGroups = [...m2mLinks.entries()]
    .filter(([, ids]) => ids.length > 0)
    .map(([key, ids]) => ({
      key,
      label: fieldLabel(key, byField.get(key)),
      ids,
      target: linkTarget(key)
    }))
  const unlinkGroups = [...m2mUnlinks.entries()]
    .filter(([, ids]) => ids.size > 0)
    .map(([key, ids]) => ({ key, label: fieldLabel(key, byField.get(key)), count: ids.size }))
  const linkCount = linkGroups.reduce((n, g) => n + g.ids.length, 0)
  const unlinkCount = unlinkGroups.reduce((n, g) => n + g.count, 0)
  const LINK_PREVIEW = 5
  return (
    <div
      className='absolute right-0 top-full z-[110] mt-1.5 w-[360px] rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-border dark:bg-card'
      data-unsaved-inspector
    >
      <div className='mb-1.5 flex items-center justify-between'>
        <p className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          Unsaved changes
        </p>
        <button
          type='button'
          onClick={onClose}
          className='text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
          aria-label='Close'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      {rows.length === 0 &&
      linkCount === 0 &&
      unlinkCount === 0 &&
      pendingRowCount === 0 &&
      pendingDeleteCount === 0 ? (
        <p className='text-[11.5px] text-slate-400'>
          Nothing differs from the saved record — this flag may be stale. Saving is a no-op;
          reloading clears it.
        </p>
      ) : (
        <div className='max-h-[300px] space-y-1.5 overflow-y-auto'>
          {rows.map((r) => {
            const f = byField.get(r.key) ?? null
            const target = m2oTarget(r.key)
            return (
              <div key={r.key} className='text-[11.5px]'>
                <span className='font-medium text-slate-700 dark:text-slate-200'>{r.label}</span>
                <p className='break-words text-slate-500 dark:text-slate-400'>
                  <span className='text-rose-500 line-through'>
                    <ChangeValue value={r.from} field={f} m2oTarget={target} />
                  </span>{' '}
                  <span className='text-emerald-600 dark:text-emerald-400'>
                    <ChangeValue value={r.to} field={f} m2oTarget={target} />
                  </span>
                </p>
              </div>
            )
          })}
          {linkGroups.map((g) => (
            <div key={`link:${g.key}`} className='text-[11.5px]'>
              <span className='font-medium text-slate-700 dark:text-slate-200'>{g.label}</span>
              <p className='break-words text-emerald-600 dark:text-emerald-400'>
                {g.target ? (
                  <>
                    +{' '}
                    {g.ids.slice(0, LINK_PREVIEW).map((id, i) => (
                      <span key={String(id)}>
                        {i > 0 && ', '}
                        <M2OSummaryValue collection={g.target as string} id={id} />
                      </span>
                    ))}
                    {g.ids.length > LINK_PREVIEW && (
                      <span className='text-slate-500 dark:text-slate-400'>
                        {' '}
                        and {g.ids.length - LINK_PREVIEW} more
                      </span>
                    )}
                  </>
                ) : (
                  `${g.ids.length} to add`
                )}
              </p>
            </div>
          ))}
          {unlinkGroups.map((g) => (
            <div key={`unlink:${g.key}`} className='text-[11.5px]'>
              <span className='font-medium text-slate-700 dark:text-slate-200'>{g.label}</span>
              <p className='text-rose-500'>{g.count} to remove</p>
            </div>
          ))}
          {pendingRowCount > 0 && (
            <p className='text-[11.5px] text-slate-500'>{pendingRowCount} grid row(s) queued</p>
          )}
          {pendingDeleteCount > 0 && (
            <p className='text-[11.5px] text-slate-500'>
              {pendingDeleteCount} grid row deletion(s) queued
            </p>
          )}
        </div>
      )}
    </div>
  )
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

/** Required-field errors the draft now satisfies drop out — a value can land
 *  without passing handleFieldChange (field rules, cross-record defaults, a
 *  restored draft). The same object comes back when nothing changed. */
export function dropSatisfiedRequired(
  errors: Record<string, string>,
  draft: Record<string, unknown>
): Record<string, string> {
  let next: Record<string, string> | null = null
  for (const [f, msg] of Object.entries(errors)) {
    if (msg !== 'This field is required') continue
    const v = draft[f]
    if (v === null || v === undefined || v === '') continue
    next ??= { ...errors }
    delete next[f]
  }
  return next ?? errors
}

/** Of the fields someone else's write changed, the ones that are still the
 *  person's own edit: touched AND different from the baseline the edit was
 *  made on. A touched field equal to that baseline (saved since, reverted,
 *  "Take theirs") holds no edit and follows the server. */
export function ownEditFields(
  changed: string[],
  touched: Set<string>,
  draft: Record<string, unknown>,
  baseline: Record<string, unknown>
): Set<string> {
  return new Set(changed.filter((k) => touched.has(k) && !valuesEqual(draft[k], baseline[k])))
}

/** A field the layout / field config marks "do not duplicate". */
export function isNoDuplicate(field: { options?: unknown }): boolean {
  const o = field.options
  const opts =
    typeof o === 'string'
      ? (() => {
          try {
            return JSON.parse(o) as Record<string, unknown>
          } catch {
            return null
          }
        })()
      : (o as Record<string, unknown> | null | undefined)
  return !!opts && typeof opts === 'object' && !!opts.no_duplicate
}

/** Audit / identity columns no copied child row carries. */
const DUPLICATE_CHILD_SKIP = new Set([
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
])

/** One child row (a line) as Duplicate stages it on the new record: no id,
 *  audit stamps, parent link, nested objects or empty values, and none of the
 *  columns the child's field config marks read-only or "do not duplicate"
 *  (a line's sales order number, its shipped quantity). Without the child
 *  config (unreadable) only the fixed skips apply. */
export function duplicateChildRow(
  row: Record<string, unknown>,
  parentField: string,
  childConfig: Array<{ field: string; readonly?: boolean | null; options?: unknown }> | null
): Record<string, unknown> {
  const blocked = new Set(
    (childConfig ?? []).filter((f) => f.readonly || isNoDuplicate(f)).map((f) => f.field)
  )
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (DUPLICATE_CHILD_SKIP.has(k) || k === parentField || blocked.has(k)) continue
    if (v === null || typeof v === 'object') continue
    out[k] = v
  }
  return out
}

/** Whether any field of the draft still differs from the record it was
 *  loaded from (`__` keys are form bookkeeping, never a change). */
export function draftDiffers(
  draft: Record<string, unknown>,
  baseline: Record<string, unknown>
): boolean {
  return Object.keys(draft).some((k) => !k.startsWith('__') && !valuesEqual(draft[k], baseline[k]))
}

/** Whether a remote write leaves the collision baseline where it is: it does
 *  while any field it changed is still the person's own, different edit, so
 *  the next save meets the server's mid-air check (409, "Someone else changed
 *  this record") instead of quietly writing over the newer value. */
export function keepCollisionBase(
  changed: string[],
  ownEdits: Set<string>,
  draft: Record<string, unknown>,
  incoming: Record<string, unknown>
): boolean {
  return changed.some((k) => ownEdits.has(k) && !valuesEqual(draft[k], incoming[k]))
}

/** Whether a field's validation rule is judged on this save — the server's
 *  rule: an EXISTING record is judged only on fields changed this session,
 *  plus a cross-field rule (gte_field / lte_field / required_if) whose
 *  partner field changed. A legacy value that breaks a rule added later, in a
 *  field nobody touched, must not make the record unsaveable. New records are
 *  judged on everything. */
export function ruleJudgedOnSave(
  rule: { type: string; field?: unknown },
  field: string,
  isNew: boolean,
  changed: (field: string) => boolean
): boolean {
  if (isNew || changed(field)) return true
  const partner = typeof rule.field === 'string' ? rule.field : ''
  return (
    !!partner &&
    (rule.type === 'gte_field' || rule.type === 'lte_field' || rule.type === 'required_if') &&
    changed(partner)
  )
}

/** The `code` of a server refusal, from either client error shape (the SDK
 *  puts the parsed body on `err.response`, axios under `err.response.data`). */
export function serverErrorCode(err: unknown): string | null {
  const r = (err as { response?: { code?: unknown; data?: { code?: unknown } } } | null)?.response
  const code = r?.code ?? r?.data?.code
  return typeof code === 'string' ? code : null
}

/** Who a live change on the open record is credited to in its notice: the
 *  writer's name, or "You, in another tab" when it was this person's own
 *  other tab (it used to read "Someone changed this"). Ids compare
 *  case-insensitively (SQL Server uuids come back upper-case). */
export function remoteChangeAuthor(
  touch: { user_id?: unknown; user_name?: string | null } | null | undefined,
  authUserId: string | null | undefined
): string | null {
  if (!touch?.user_id) return null
  const mine =
    !!authUserId && String(touch.user_id).toUpperCase() === String(authUserId).toUpperCase()
  return mine ? 'You, in another tab' : (touch.user_name ?? null)
}

/** The save-blocking error for a value its own picker no longer offers. */
export const UNAVAILABLE_OPTION_ERROR = 'Not an available option — pick another or clear it'

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

/** A create/update answer: `meta.readable` false = written, but the writer's
 *  own read-back hides it (api routes/items.ts outOfViewMeta). */
interface WriteAnswer {
  data?: { id?: string | number } | null
  meta?: {
    id?: string | number
    readable?: boolean
    reason?: string | null
    link_failures?: unknown[]
  }
}

/** An older server's create answer with no row and no id: created, id unknown. */
class CreatedOutOfViewError extends Error {
  constructor() {
    super('created out of view')
  }
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

/**
 * Plain prefill values that name an M2M/M2A alias field (`{internal_contact: ['<id>']}`,
 * one id, or `{id}` / `{item}` objects) as the staged links they mean. `__links` is
 * handled separately; O2M aliases (no junction) are left alone. Exported for tests.
 */
export function prefillAliasLinks(
  values: Record<string, unknown>,
  relations: CMSRelation[] | null | undefined,
  collection: string
): Array<{ field: string; stagingKey: string; ids: Array<string | number> }> {
  const out: Array<{ field: string; stagingKey: string; ids: Array<string | number> }> = []
  for (const [field, value] of Object.entries(values)) {
    if (field === '__links' || value == null || value === '') continue
    const isJunction = (relations ?? []).some(
      (r) => r.one_collection === collection && r.one_field === field && r.junction_field != null
    )
    if (!isJunction) continue
    const info = resolveM2MAlias(relations, collection, field)
    if (!info) continue
    const ids: Array<string | number> = []
    for (const v of Array.isArray(value) ? value : [value]) {
      const id =
        v && typeof v === 'object'
          ? ((v as Record<string, unknown>).id ??
            (v as Record<string, unknown>).item ??
            (v as Record<string, unknown>)[info.junctionField])
          : v
      if ((typeof id === 'string' && id) || typeof id === 'number') ids.push(id)
    }
    out.push({ field, stagingKey: info.stagingKey, ids })
  }
  return out
}

/**
 * Save as template: the record's M2M / M2A links (visible, editable aliases; never files) as
 * the `__links` prefill block, keyed by staging key. Null when there are none. Exported for
 * tests.
 */
export function templateLinks(
  fieldConfig: ReadonlyArray<{ field: string; hidden?: boolean | null }>,
  aliases: ReadonlyMap<string, M2MAliasInfo>,
  states: Record<string, M2MFieldState>,
  relations: CMSRelation[] | null | undefined
): Record<string, string[]> | null {
  const out: Record<string, string[]> = {}
  for (const [field, info] of aliases) {
    const fc = fieldConfig.find((f) => f.field === field) as
      | { hidden?: boolean | null; readonly?: boolean | null; layout_assigned?: boolean }
      | undefined
    if (!fc || fc.hidden || fc.readonly || fc.layout_assigned === false) continue
    const companion = (relations ?? []).find(
      (r) => r.many_collection === info.manyCollection && r.many_field === info.junctionField
    )
    if (resolveM2MRelatedCollection(companion) === 'nivaro_files') continue
    const st = states[field]
    if (!st?.known || st.ids.length === 0) continue
    out[info.stagingKey] = [...st.ids]
  }
  return Object.keys(out).length > 0 ? out : null
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

/**
 * Provenance chip for a record an integration or script created through the
 * API (token / API-key request): the chip names the caller kind, and opens
 * into the request that made it — method, path, who, when, the ORIGINAL
 * payload (admins) and a "Show the path" that opens the event path: every
 * write, transition, flow and partner push that request set off, which is
 * how the record's values got from that payload to what it holds now.
 */
export { formatApiPayload }

/** Colour classes per token kind — one set that reads on both the light
 *  slate-50 block and the dark navy block (every pair ≥ 4.5:1). */

function ApiProvenanceChip({
  collection,
  itemId,
  origin,
  userName,
  timestamp,
  api
}: {
  collection: string
  itemId: string
  origin: string
  userName: string | null
  timestamp: string
  api: {
    log_id: number
    method: string
    path: string
    auth: string
    api_key_name: string | null
    at: string
    chain_id: string | null
    body: unknown
    body_withheld?: boolean
  }
}) {
  const [pathOpen, setPathOpen] = useState(false)
  const payload = useMemo(() => formatApiPayload(api.body), [api.body])
  const caller = api.api_key_name
    ? `API key "${api.api_key_name}"`
    : userName
      ? `${userName}'s token`
      : 'a token'
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type='button'
            data-provenance-chip
            data-provenance-api={api.log_id}
            className='inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-px text-[9.5px] font-medium text-sky-800 hover:bg-sky-100 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300'
            data-tip={`Created through the API by ${caller} · ${new Date(timestamp).toLocaleString()} — click for the request`}
          >
            {origin}
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[560px] max-w-[94vw] p-3 text-[12px]'>
          <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
            Created through the API
          </p>
          <dl className='mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1'>
            <dt className='text-slate-400'>Request</dt>
            <dd className='break-all font-mono text-[11px] text-slate-700 dark:text-slate-200'>
              {api.method} {api.path}
            </dd>
            <dt className='text-slate-400'>Caller</dt>
            <dd className='text-slate-700 dark:text-slate-200'>{caller}</dd>
            <dt className='text-slate-400'>When</dt>
            <dd className='text-slate-700 dark:text-slate-200'>
              {new Date(api.at).toLocaleString()}
            </dd>
          </dl>
          <p className='mt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
            Original payload
          </p>
          {payload ? (
            <div className='mt-1 space-y-1.5'>
              {payload.sections.map((sec) => (
                <div key={sec.title}>
                  {payload.sections.length > 1 && (
                    <p className='mb-0.5 text-[10px] font-medium text-slate-400'>{sec.title}</p>
                  )}
                  <pre
                    data-provenance-payload={sec.kind}
                    className='max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-[10.5px] leading-snug text-slate-700 dark:border-border dark:bg-[#0f172a] dark:text-slate-200'
                  >
                    <HighlightedCode kind={sec.kind} text={sec.text} />
                  </pre>
                </div>
              ))}
              <div className='flex justify-end'>
                <button
                  type='button'
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(payload.sections.map((x) => x.text).join('\n\n'))
                      .then(() => toast.success('Payload copied'))
                  }}
                  className='text-[11px] text-slate-500 hover:underline'
                >
                  Copy payload
                </button>
              </div>
            </div>
          ) : (
            <p className='mt-1 text-[11.5px] text-slate-400'>
              {api.body_withheld
                ? 'Only administrators can see the request body.'
                : 'The request body was not recorded — bodies are kept for token and API-key writes since request logging was added.'}
            </p>
          )}
          <div className='mt-2 flex justify-end'>
            <button
              type='button'
              data-provenance-path
              onClick={() => setPathOpen(true)}
              className='rounded-md border border-slate-200 px-2 py-1 text-[11.5px] font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-muted'
            >
              Show the path it took
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {pathOpen && (
        <RecordEventPathSheet
          target={{
            source: 'core:inbound',
            id: String(api.log_id),
            record: { collection, item: itemId }
          }}
          event={{ label: `${api.method} ${api.path}` }}
          onClose={() => setPathOpen(false)}
        />
      )}
    </>
  )
}

/** Field labels and help text in the reader's language, where the form has them (#2665). */
function translateFields(rows: CMSField[]): CMSField[] {
  const locale = formLocale()
  return rows.map((r) => translateFieldRow(r, locale))
}

/**
 * The record form. With `design` (the layout editor's canvas) the whole form —
 * its own hooks included — runs inside DesignCanvas: a client that cannot
 * write, no realtime, inert inputs, selectable shells.
 */
/** The per-field contexts FieldRow reads, as one wrapper (keeps the form tree's depth). */
function FieldContexts({
  affordances,
  personalDefaults,
  children
}: {
  affordances: FieldAffordances | null
  personalDefaults: PersonalDefaultsApi
  children: ReactNode
}) {
  return (
    <FieldAffordancesContext.Provider value={affordances}>
      <PersonalDefaultsContext.Provider value={personalDefaults}>
        {children}
      </PersonalDefaultsContext.Provider>
    </FieldAffordancesContext.Provider>
  )
}

export function ItemEditForm(props: ItemEditFormProps) {
  if (!props.design) return <ItemEditFormView {...props} />
  return (
    <DesignCanvas design={props.design.context} onRefusedWrite={props.design.onRefusedWrite}>
      <ItemEditFormView {...props} />
    </DesignCanvas>
  )
}

function ItemEditFormView({
  collection,
  itemId: itemIdProp,
  layoutSlug: layoutSlugProp,
  initialAddendumViewId,
  onAddendumViewChange,
  onBack,
  onSaved,
  onDeleted,
  showHeader = true,
  headerExtra,
  focusField,
  showItemActions = false,
  showGrantedTools = false,
  moreMenuItems,
  onViewModeChange,
  onDirtyChange,
  documentTitle = true,
  active = true,
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
  hideHelpVideoButton = false,
  extraBottomContent,
  onHeaderWidgets,
  autofillProposalId,
  onAutofillConsumed,
  initialImportResult,
  initialValues,
  initialLinks,
  initialRows,
  design,
  layoutEditing = false
}: ItemEditFormProps) {
  const designOn = design != null
  const designCtx = design?.context ?? null
  const designMode = designCtx != null
  // Canvas "show hidden": hidden fields and rule-hidden tabs/steps stay on
  // the canvas, faint, so they can still be selected.
  const showHiddenDesign = !!designCtx?.showHidden
  // Design mode: DesignCanvas above hands down a client that cannot write.
  const client = useNivaroClient()
  const readRow = useRecordReader()
  const fetchCfg = useApiFetchConfig()
  const { isAdmin, userId: authUserId } = useContext(ItemEditAuthContext)
  // View as role (#8, admin): the previewed role's layout pins by slug when
  // it has one; hidden/readonly fields are applied further down.
  const viewAs = useViewAsRole(collection, isAdmin)
  const itemNav = useItemNavigation()
  const [viewAsOpen, setViewAsOpen] = useState(false)
  const layoutSlug = viewAs.preview?.layout?.slug ?? layoutSlugProp
  const qc = useQueryClient()
  const designRecordId = design?.record?.id != null ? String(design.record.id) : undefined
  const itemIdIn = itemIdProp ?? (designOn ? designRecordId : undefined)
  const itemId = itemIdIn ?? 'new'
  const isNew = !itemIdIn || itemIdIn === 'new'

  // ── Data fetching ──────────────────────────────────────────────────────────
  // A small screen gets a form's phone version (#2715) — read once per open,
  // so turning the device never swaps the form under someone's edits.
  const [viewport] = useState(currentViewport)
  const { data: fetchedLayoutData } = useQuery<ActiveLayoutData | null>({
    // Desktop keeps the key the host's own /active read shares (admin ItemEdit).
    queryKey: [
      'active-layout',
      collection,
      layoutSlug ?? null,
      itemId,
      ...(viewport ? [viewport] : [])
    ],
    queryFn: () =>
      client
        .request<{ data: ActiveLayoutData | null }>(
          get('/collection-layouts/active', {
            collection,
            ...(layoutSlug ? { slug: layoutSlug } : itemId !== 'new' ? { item: itemId } : {}),
            ...(viewport ? { viewport } : {})
          })
        )
        .then((r) => r.data)
        .catch(() => null),
    staleTime: 60_000,
    enabled: !designOn
  })
  const activeLayoutData = designOn ? design.layout : fetchedLayoutData

  const layoutId = activeLayoutData?.layout?.id ?? null

  // Sections that load when opened (#2713): what they alone need waits until
  // someone opens them; opened ones stay loaded for this record.
  const [openedLazy, setOpenedLazy] = useState<ReadonlySet<string>>(() => new Set())
  // biome-ignore lint/correctness/useExhaustiveDependencies: another record or form starts folded again
  useEffect(() => setOpenedLazy(new Set()), [collection, itemId, layoutId])
  const deferred = useMemo(
    () => deferredSections(activeLayoutData, openedLazy, { design: designOn }),
    [activeLayoutData, openedLazy, designOn]
  )
  const openLazySection = useCallback((key: string) => {
    setOpenedLazy((cur) => (cur.has(key) ? cur : new Set([...cur, key])))
  }, [])

  // Summary layout (layout_type 'summary'): the customisable read-only
  // presentation Summary mode renders. Null = the collection has none, and
  // the grouped layout above renders read-only instead (the pre-layout
  // behaviour). Fetched only for saved records — Summary mode never applies
  // to a new one.
  const { data: summaryLayoutData } = useQuery<ActiveLayoutData | null>({
    queryKey: ['summary-layout', collection],
    queryFn: () =>
      client
        .request<{ data: ActiveLayoutData | null }>(
          get(`/collection-layouts/summary/${collection}`)
        )
        .then((r) => r.data)
        .catch(() => null),
    staleTime: 60_000,
    enabled: !isNew && !designOn
  })

  // Design mode: the editor's DRAFT placements, formatted by the server
  // exactly as GET formats a saved layout (POST …/project only reads).
  const designAssignments = designOn ? design.layout.assignments : null
  const {
    data: projectedFieldConfig,
    isLoading: fieldsLoading,
    isFetched: fieldConfigFetched
  } = useQuery<CMSField[]>({
    queryKey: designAssignments
      ? ['layout-editor', 'field-config', collection, designAssignments]
      : ['field-config', collection, layoutId],
    queryFn: () =>
      designAssignments
        ? client
            .request<{ data: CMSField[] }>(
              post(`/field-config/${collection}/project`, { assignments: designAssignments })
            )
            .then((r) => r.data ?? [])
        : client
            .request<{ data: CMSField[] }>(
              get(
                `/field-config/${collection}`,
                layoutId ? { layout_id: String(layoutId) } : undefined
              )
            )
            .then((r) => r.data ?? []),
    staleTime: 60_000,
    // A draft edit re-asks; the canvas keeps the last answer meanwhile.
    placeholderData: designAssignments ? (prev: CMSField[] | undefined) => prev : undefined,
    // Layout text in the reader's language (#2665); the canvas edits the text as written.
    select: designAssignments ? undefined : translateFields,
    // Wait for the layout either way, not just when a slug pins one. Without
    // this the field config fetched immediately with layoutId = null — the
    // LAYOUT-LESS default field set — painted that, then refetched under a new
    // key once the layout arrived: a visible flash of the wrong form on the
    // way to the right one. `catch(() => null)` on the layout query means it
    // always settles, so this cannot hang; undefined is strictly "still
    // asking".
    enabled: activeLayoutData !== undefined
  })
  // Design mode on a new record: the value each field would start with shows
  // as its placeholder (#2633, the layout editor's default ghosts). Display only.
  const designGhost = designCtx?.ghost
  const fieldConfig = useMemo(() => {
    if (!designGhost || !isNew || !projectedFieldConfig) return projectedFieldConfig
    return projectedFieldConfig.map((f) => {
      const ghost = designGhost(f.field)
      return ghost ? { ...f, placeholder: ghost } : f
    })
  }, [designGhost, isNew, projectedFieldConfig])
  // #2703 / #2705: placement rules that read the viewer's role or the record's state.
  const behaviourNeeds = useMemo(() => placementBehaviourNeeds(fieldConfig ?? []), [fieldConfig])
  // The layout editor's canvas: its previewed role (state comes through `design`).
  const outerPlacementText = usePlacementTextContext()

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
    read_mode_toggle?: boolean
    summary_mode_rules?: SummaryModeRules | null
    browser_config?: { copy_as?: boolean } | null
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
            read_mode_toggle?: boolean
            summary_mode_rules?: SummaryModeRules | null
            browser_config?: { copy_as?: boolean } | null
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
  const [addendumViewId, setAddendumViewId] = useState<string>(initialAddendumViewId || 'original')
  const onAddendumViewChangeRef = useRef(onAddendumViewChange)
  onAddendumViewChangeRef.current = onAddendumViewChange
  useEffect(() => {
    onAddendumViewChangeRef.current?.(addendumViewId === 'original' ? null : addendumViewId)
  }, [addendumViewId])
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

  // Deleted by someone else (#1871): the form stays on screen, read-only, and
  // stops re-reading. Hidden by an access change (#1925): the form is
  // replaced by the access-lost panel and the record's cached data dropped.
  const [recordGone, setRecordGone] = useState<RecordGone | null>(null)
  // The last save's side notes (see saveMut): written-but-hidden, links lost.
  const saveNoticeRef = useRef<{
    hidden: { reason: string | null } | null
    linkProblems: string[]
  }>({ hidden: null, linkProblems: [] })
  // A create an older server answered with no row and no id: the record
  // exists, so the form is replaced by a plain note — never a second Save.
  const [createdOutOfView, setCreatedOutOfView] = useState<{ reason: string | null } | null>(null)
  // Another record on the same mount starts clean (RecordLiveSync, which
  // also resets it, is not mounted while the access-lost panel shows).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on identity only
  useEffect(() => {
    setRecordGone(null)
  }, [collection, itemId])
  const {
    data: fetchedItemData,
    isLoading: itemLoading,
    error: itemLoadError
  } = useQuery<Record<string, unknown>>({
    queryKey: ['item', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${itemId}`))
        .then((r) => r.data),
    enabled: !isNew && !recordGone && !designOn,
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
  // Design mode: the preview record stands in for the fetched one.
  const itemData = designOn ? (design.record ?? undefined) : fetchedItemData
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
  // The record is read-only for this person (someone else holds the edit
  // lock, the approval edit lock refuses them, the record is gone): edits
  // from any input are dropped, so nothing dirties the form, writes a draft
  // or lights "Save all". `undoingRef` lets Revert / Take theirs through —
  // they put back what the server has.
  const readOnlyRef = useRef(false)
  const undoingRef = useRef(false)
  // Fields the user actually edited this session (drives cascade auto-clear)
  const userTouchedRef = useRef<Set<string>>(new Set())
  // Stale-response guard for /field-rules/evaluate (see InlineTableField for
  // the grid twin): every user edit stamps its field with a fresh sequence
  // number, a rule request captures the sequence at send time, and its
  // response may only write scalar targets whose stamp is not newer than
  // that — a target the user re-picked while the request was in flight
  // keeps the user's value.
  const ruleSeqRef = useRef(0)
  const fieldEditSeqRef = useRef<Map<string, number>>(new Map())

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
  // The 'Can't save yet' summary shows after a failed save until dismissed or
  // the errors clear (it derives from validationErrors, so it never lingers).
  const [showValidationSummary, setShowValidationSummary] = useState(false)
  // Change-reason challenge: a 422 from the items service pauses the save
  // until the user supplies a justification, then retries with _change_reason
  const [crChallenge, setCrChallenge] = useState<ChangeReasonChallenge | null>(null)
  const [rawEditOpen, setRawEditOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const changeReasonRef = useRef<string | null>(null)
  // Mid-air collision: a 409 pauses the save into a per-field merge dialog
  // (their value vs yours); resolving retries against the newer revision.
  const [collision, setCollision] = useState<{
    conflicts: Array<{ field: string; current_value: unknown }>
    latest: number
    mine: Record<string, unknown>
  } | null>(null)
  const baseRevisionOverrideRef = useRef<number | null>(null)
  // Offline outbox (#1678): a Save that failed on the network waits in the
  // per-person outbox. While this form holds the entry (it pressed Save, or
  // the person opened Review) it replays through its own save — lines,
  // links and the merge dialog included; otherwise any tab replays it.
  const outboxEntry = useRecordOutboxEntry(collection, isNew ? null : itemId)
  const outboxReleaseRef = useRef<(() => void) | null>(null)
  // Queued fields this form took over (pressed Save / Review): a save that
  // lands settles them even when a merge kept "theirs" and sent nothing.
  const outboxFieldsRef = useRef<Set<string>>(new Set())
  const lastSavePayloadRef = useRef<Record<string, unknown>>({})
  const releaseOutboxClaim = useCallback(() => {
    outboxReleaseRef.current?.()
    outboxReleaseRef.current = null
    outboxFieldsRef.current = new Set()
  }, [])
  useEffect(() => {
    if (authUserId) bindRecordOutbox(client, authUserId, qc)
  }, [client, authUserId, qc])
  // Another record on this mount (or unmount): hand the entry back to the replayers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: release on identity only
  useEffect(() => releaseOutboxClaim, [collection, itemId])
  const [isDirty, setIsDirty] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  // Remote-change ghosts (#2): field → what it was before someone else's
  // write landed, until dismissed or the next save.
  const [remoteChanges, setRemoteChanges] = useState<Record<string, RemoteFieldChange>>({})
  const ownSaveAtRef = useRef(0)
  const lastTouchRef = useRef<{ user_id: string | null; user_name: string | null } | null>(null)
  // Summary mode (#3): the grouped layout as RecordReadView. Session-only —
  // nothing is persisted: every load starts in Edit unless the
  // collection's summary_mode_rules (role × state) say otherwise — see the
  // rule-resolution effect. The toggle then flips it for this mount only.
  const [readMode, setReadModeRaw] = useState<boolean>(false)
  const setReadMode = (v: boolean) => setReadModeRaw(v)
  // Tell the host which view is showing (and the Summary layout behind it) so its Edit
  // layout opens that layout, not always the edit form's.
  const onViewModeChangeRef = useRef(onViewModeChange)
  onViewModeChangeRef.current = onViewModeChange
  const summaryLayoutIdForHost =
    summaryLayoutData?.layout?.id != null ? Number(summaryLayoutData.layout.id) : null
  useEffect(() => {
    onViewModeChangeRef.current?.({
      mode: readMode && !isNew ? 'summary' : 'edit',
      summaryLayoutId: summaryLayoutIdForHost
    })
  }, [readMode, isNew, summaryLayoutIdForHost])
  const summaryRules = useMemo(
    () =>
      colMeta?.read_mode_toggle ? normalizeSummaryModeRules(colMeta.summary_mode_rules) : null,
    [colMeta?.read_mode_toggle, colMeta?.summary_mode_rules]
  )
  // State (not just a ref) so the body can HOLD until the opening mode is
  // known — otherwise the form paints Edit for a beat and snaps to Summary
  // ("flashes edit mode first"). Resolved by the effect further down.
  const [summaryResolvedKey, setSummaryResolvedKey] = useState<string | null>(null)
  const summaryRecordKey = `${collection}|${String(itemId)}`
  // True once the opening mode is known: new records and collections without
  // the toggle settle immediately; otherwise wait for colMeta (the rules) and
  // the resolution. The body renders a skeleton until then.
  const summaryModeSettled =
    designOn ||
    isNew ||
    (colMeta !== undefined && (!summaryRules || summaryResolvedKey === summaryRecordKey))
  // ── Unsaved-draft recovery (#1) ────────────────────────────────────────────
  // The dirty draft (scalar diffs + staged rows/edits/deletes + junction
  // staging) is persisted to IndexedDB per collection:record:user, ~800ms
  // after the last change, and removed on save / discard. On open, a stored
  // draft is OFFERED (banner) — never applied silently.
  const recoveryKey = draftKey(collection, itemId, authUserId)
  // Every new form shares one draft key: a Duplicate of record B must not be
  // offered the lines of an unfinished new record A. The prefill it opened
  // with signs its draft.
  const prefillSig = useMemo(
    () =>
      isNew && (initialValues || initialLinks || initialRows)
        ? prefillSignature({
            v: initialValues ?? null,
            l: initialLinks ?? null,
            r: initialRows ?? null
          })
        : null,
    [isNew, initialValues, initialLinks, initialRows]
  )
  const [recovery, setRecovery] = useState<
    | { state: 'checking' }
    // createdId: this draft was already created as that record (lib/draft-store
    // markDraftCreated) — '' when the create's answer carried no id.
    | { state: 'offer'; draft: StoredDraft; createdId: string | null }
    | { state: 'none' }
  >({ state: designOn ? 'none' : 'checking' })
  const recoveryRef = useRef(recovery)
  recoveryRef.current = recovery
  // A restored draft wins outright: no personal defaults are applied after it.
  const [draftRestored, setDraftRestored] = useState(false)
  // The key the last completed check was for. The auth user id can arrive a
  // render after mount (key anon → real): persistence must not run for a key
  // whose stored draft has not been looked at yet, or a clean form would
  // delete the draft it is about to be offered.
  const [recoveryCheckedKey, setRecoveryCheckedKey] = useState<string | null>(null)
  // Whether this person may hold a SERVER copy of the draft: one was found by
  // the recovery check or put since. A clean form only deletes the server copy
  // then — it used to send DELETE /drafts on every draft change of a clean open.
  const serverDraftRef = useRef(false)
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
  // Config hot-push (#268, #1740): a schema/layout/rule/pipeline edit re-resolves this form's
  // definition in place AND, when it names this collection, says so — "This form was changed,
  // reload to see the new version" (configUpdateReaction) — unless the host's own Edit layout
  // session made the change (layoutEditing). What the person typed is kept:
  // the draft store writes it ~1s after the last keystroke and offers it back after the reload.
  const [configUpdated, setConfigUpdated] = useState(false)
  useEffect(() => {
    const onConfig = (e: Event) => {
      const changed = (e as CustomEvent<{ collection?: string }>).detail?.collection
      const reaction = configUpdateReaction(changed, collection, designMode, layoutEditing)
      if (reaction === 'ignore') return
      void qc.invalidateQueries({ queryKey: ['field-config'] })
      void qc.invalidateQueries({ queryKey: ['active-layout'] })
      void qc.invalidateQueries({ queryKey: ['collection-meta'] })
      if (reaction === 'banner') setConfigUpdated(true)
    }
    window.addEventListener('nvr:config-update', onConfig)
    return () => window.removeEventListener('nvr:config-update', onConfig)
  }, [qc, collection, designMode, layoutEditing])
  // Condensing header (#321): long forms shrink the header to a mini-bar
  // (title + state + save) once the body scrolls past ~90px.
  const [headerCondensed, setHeaderCondensed] = useState(false)
  // Unsaved edits left sitting for a few minutes: the amber dot starts to
  // breathe (one soft ring every 6s) — a nudge, not an alarm.
  const [dirtyIdle, setDirtyIdle] = useState(false)
  useEffect(() => {
    if (!isDirty) {
      setDirtyIdle(false)
      return
    }
    const t = window.setTimeout(() => setDirtyIdle(true), 3 * 60_000)
    return () => window.clearTimeout(t)
  }, [isDirty])

  // Fields a rule / autofill / cross-record default wrote for the user get a
  // one-shot cyan glow (FieldRow keys its wrapper on the tick, so a repeat
  // write on the same field glows again). Purely presentational.
  const [autoFillTicks, setAutoFillTicks] = useState<Record<string, number>>({})
  // The same fields, kept for the recovery draft: on a NEW form a value a
  // rule derived from the person's pick is part of their work (a Billing
  // Location's Shipping Location + Org Code), not a layout default.
  const autoFilledFieldsRef = useRef<Set<string>>(new Set())
  // Personal defaults (item-edit/usePersonalDefaults.ts): fields a personal default filled, and
  // what rules / cross-record defaults / cascades derived from them — prefill, not the person's
  // work, so they never set isDirty. A person edit of the field takes it out.
  const pdQuietRef = useRef<Set<string>>(new Set())
  // Staged links that are only prefill (staging key → ids): not unsaved work, never hold a
  // pushed reload. Set once the hook below exists.
  const pdQuietLinksRef = useRef<(links: Map<string, unknown[]>) => Map<string, Set<string>>>(
    () => new Map()
  )
  // Links a field rule staged because a personal-default value triggered it (staging key → ids).
  const pdQuietRuleLinksRef = useRef<Map<string, Set<string>>>(new Map())
  // An explicit fill (document autofill) takes a field over from its personal default.
  const pdReleaseRef = useRef<(field: string) => void>(() => {})
  // The person's own edits reach the hook through this (handleFieldChange, M2M staging).
  const pdPersonChangeRef = useRef<(field: string) => void>(() => {})
  // > 0 while staging that is not the person's (rule results, layout defaults, prefill, imports).
  const notPersonStageRef = useRef(0)
  const markAutoFilled = useCallback((fields: string[]) => {
    if (fields.length === 0) return
    for (const f of fields) autoFilledFieldsRef.current.add(f)
    setAutoFillTicks((prev) => {
      const next = { ...prev }
      for (const f of fields) next[f] = (next[f] ?? 0) + 1
      return next
    })
  }, [])

  // Condensing hides the header field strip, which sits OUTSIDE the scroll
  // container — so the scroller grows by the strip's height and, when the body
  // barely overflows (a drill sheet on a 1080p screen), scrollTop clamps back
  // under the expand threshold, the strip returns, and every wheel tick
  // re-triggers the cycle (the "header tweaks out while scrolling" report).
  // Only condense when the body can still scroll past the expand threshold
  // AFTER the strip is gone; otherwise the header simply stays as it is.
  const headerStripRef = useRef<HTMLDivElement | null>(null)
  // Stacked / dense / folded stat band — components/item-edit/HeaderBand.tsx.
  const { headerDense, headerFolded, headerRows, headerTilesRef } = useHeaderBand()
  const condenseOnScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.target as HTMLDivElement
    const top = el.scrollTop
    setHeaderCondensed((prev) => {
      if (prev) return top > 40
      if (top <= 110) return false
      const freed = (headerStripRef.current?.offsetHeight ?? 0) + 16 // strip + header padding delta
      const maxScrollAfter = el.scrollHeight - (el.clientHeight + freed)
      return maxScrollAfter > 40 + 24
    })
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
    // Only a SAVE compares against it — a record nobody edits never needs the
    // read (a scan of the record's history on every open, on every tab).
    enabled: !isNew && !!itemId && isDirty,
    // The baseline only moves when the form adopts the server's values (its
    // own save, a remote change it took in) — those invalidate it. Refetching
    // on its own (stale + window focus) moved it past another tab's save while
    // this tab still held the older edit, and the save wrote over the newer
    // value with no collision prompt.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })

  // ── Save progress dialog ───────────────────────────────────────────────────
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveSteps, setSaveSteps] = useState<SaveStepItem[]>([])
  // The merge dialog replaces the progress dialog: a Radix modal left open
  // under it keeps body at pointer-events:none, so the chooser rendered on
  // top but no click reached it (only Escape got a mouse user out).
  useEffect(() => {
    if (collision) setSaveDialogOpen(false)
  }, [collision])
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
  const handleRemoveQueuedTask = useCallback((index: number) => {
    setPendingTasks((prev) => prev.filter((_, i) => i !== index))
  }, [])
  const handleQueueTask = useCallback((task: PendingTask) => {
    setPendingTasks((prev) => [...prev, task])
  }, [])

  // ── Pending O2M rows (new records) ─────────────────────────────────────────
  const [pendingO2MRows, setPendingO2MRows] = useState<Map<string, Record<string, unknown>[]>>(
    new Map()
  )
  // New rows that did NOT land in the last flush, per relation — the save's
  // post-flush cleanup keeps exactly these staged so a retry re-posts only
  // them. Reset at the start of every save.
  const remainingO2MRowsRef = useRef<Map<string, Record<string, unknown>[]>>(new Map())
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
  // The layout default_values this new form started with: a personal default outranks them.
  const layoutDefaultValuesRef = useRef<Record<string, unknown>>({})

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
            if (notPersonStageRef.current === 0) {
              // The person's own pick: no longer prefill, so what it derives is their work.
              pdQuietRef.current.delete(field)
              pdQuietRuleLinksRef.current.delete(k)
              pdPersonChangeRef.current(field)
            }
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
      unstageLink: (k, id) => {
        setM2mLinks((prev) => {
          const next = new Map(prev)
          next.set(
            k,
            (next.get(k) ?? []).filter((x) => String(x) !== String(id))
          )
          return next
        })
        if (crossFillInFlightRef.current === 0 && notPersonStageRef.current === 0) {
          const field = stagingKeyToFieldRef.current.get(k)
          if (field) {
            pdQuietRef.current.delete(field)
            pdQuietRuleLinksRef.current.delete(k)
            pdPersonChangeRef.current(field)
          }
        }
      },
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
            const ev = await evaluateImportLineRules(
              client,
              rel.many_collection,
              rowRules,
              parentCtx,
              result.lines.map((l) => l.values)
            )
            if (ev.failed) {
              issues.push({
                severity: 'warn',
                rule: 'import-apply',
                message:
                  'Some line autofill rules could not be evaluated — check the affected rows before saving.'
              })
            }
            result.lines.forEach((line, i) => {
              line.values = ev.rows[i]
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
          notPersonStageRef.current += 1
          try {
            for (const id of ids) m2mStagingCtx.stageLink(stagingKey, id)
          } finally {
            notPersonStageRef.current -= 1
          }
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

  // ── Fill from a document (AI proposal → the same staging as an import) ─────
  // Rich-text targets get the model's plain lines wrapped as paragraphs; every
  // child alias stages through applyImportResult so row rules, provenance and
  // the save flush treat these lines exactly like an import prefill.
  // The proposal this NEW record was filled from (outcome event at Create, #701).
  const autofillAppliedRef = useRef<{ id: string; fields: string[] } | null>(null)
  // Filled from a document: fields the layout marks autofill_check get a ring (#2691).
  const [fromAutofill, setFromAutofill] = useState(false)
  const applyDocumentProposal = useCallback(
    async (sel: DocumentApplySelection) => {
      autofillAppliedRef.current = {
        id: sel.proposal_id,
        fields: [...Object.keys(sel.values), ...Object.keys(sel.m2m ?? {})]
      }
      setFromAutofill(true)
      // The document's links REPLACE a personal default's for that field (and its pill goes).
      for (const f of Object.keys(sel.m2m ?? {})) pdReleaseRef.current(f)
      const values: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(sel.values)) {
        const cfg = (fieldConfig ?? []).find((f) => f.field === k)
        const iface = (cfg?.interface ?? '').toLowerCase()
        if (typeof v === 'string' && /rich|wysiwyg|editor/.test(iface) && !/^\s*</.test(v)) {
          const lines = v
            .split(/\n+/)
            .map((l) => l.trim())
            .filter(Boolean)
          const esc = (t: string) =>
            t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          const bullets = lines.filter((l) => /^[•\-*]\s+/.test(l))
          values[k] =
            bullets.length === lines.length && lines.length > 1
              ? `<ul>${lines.map((l) => `<li>${esc(l.replace(/^[•\-*]\s+/, ''))}</li>`).join('')}</ul>`
              : lines.map((l) => `<p>${esc(l)}</p>`).join('')
        } else values[k] = v
      }
      const stamp = `import:document:${sel.file_id ?? sel.document_name}`
      await applyImportResult({
        values,
        lines: [],
        issues: [],
        file_id: sel.file_id,
        line_target_field: null,
        nested_relation: null,
        m2m: sel.m2m,
        template_name: sel.document_name
      })
      for (const [alias, lines] of Object.entries(sel.lines_by_alias)) {
        if (!lines.length) continue
        await applyImportResult({
          values: {},
          lines: lines.map((l) => ({ values: { ...l.values, _change_reason: stamp } })),
          issues: [],
          file_id: sel.file_id,
          line_target_field: alias,
          nested_relation: null,
          m2m: {},
          template_name: sel.document_name
        })
      }
      for (const k of Object.keys(values)) userTouchedRef.current.add(k)
    },
    [applyImportResult, fieldConfig]
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
            message: userErrorMessage(err, 'Duplicate match key in the imported lines.')
          }
        ])
        return
      }

      // Evaluate the grid's row rules over the new lines NOW so the review can
      // say which columns the file will not control.
      if (diff.creates.length > 0 && rel?.many_collection) {
        const lineFieldRow = (fieldConfig ?? []).find((f) => f.field === result.line_target_field)
        const rawOpts = lineFieldRow?.options
        let opts: { row_rules?: unknown[]; parent_context_fields?: string[] } = {}
        try {
          opts =
            typeof rawOpts === 'string' ? JSON.parse(rawOpts) : ((rawOpts ?? {}) as typeof opts)
        } catch {
          opts = {}
        }
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
          const ev = await evaluateImportLineRules(
            client,
            rel.many_collection,
            rowRules,
            parentCtx,
            diff.creates
          )
          diff = { ...diff, creates: ev.rows, rulesEvaluated: true, ruleFields: ev.ruleFields }
          if (ev.failed) {
            result.issues.push({
              severity: 'warn',
              rule: 'reimport-apply',
              message:
                'Some line autofill rules could not be evaluated — check the affected rows before saving.'
            })
          }
        }
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
      itemId,
      fieldConfig
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
        // The review dialog evaluated the rules already (its chips depend on
        // it) — don't re-derive on apply.
        const alreadyEvaluated = creates.some((r) => RULE_SET_KEY in r) || diff.rulesEvaluated
        if (creates.length > 0 && !alreadyEvaluated) {
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
            const ev = await evaluateImportLineRules(
              client,
              lineCollection,
              rowRules,
              parentCtx,
              creates
            )
            if (ev.failed) {
              issues.push({
                severity: 'warn',
                rule: 'reimport-apply',
                message:
                  'Some line autofill rules could not be evaluated — check the affected rows before saving.'
              })
            }
            creates = ev.rows
          }
        }

        // Provenance: each imported line's create carries where it came
        // from ("import:<template>:<file id>") — the items service stores it
        // on the activity row, so history and the grid can say "from Bid
        // Import" with a link to the file.
        const importStamp = `import:${result.template_name || 'file'}:${result.file_id ?? ''}`
        for (const row of creates) {
          o2mStagingCtx.queueRow(lineCollection, lineField, { ...row, _change_reason: importStamp })
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
          notPersonStageRef.current += 1
          try {
            m2mStagingCtx.stageLink(stagingKey, result.file_id)
          } finally {
            notPersonStageRef.current -= 1
          }
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
          notPersonStageRef.current += 1
          try {
            for (const id of ids) {
              if (!existing.has(String(id))) m2mStagingCtx.stageLink(stagingKey, id)
            }
          } finally {
            notPersonStageRef.current -= 1
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
    // `__links` inside initialValues (the ?prefill= shape the quick-picker
    // dialog hands over) is the same contract as initialLinks.
    const { __links: prefillLinks, ...plainInitial } = (initialValues ?? {}) as Record<
      string,
      unknown
    > & { __links?: Record<string, unknown[]> }
    if (initialValues) {
      setDraft((d) => ({ ...plainInitial, ...d }))
      draftRef.current = { ...plainInitial, ...draftRef.current }
    }
    const mergedLinks: Record<string, unknown[]> | undefined =
      initialLinks || (prefillLinks && typeof prefillLinks === 'object')
        ? { ...(prefillLinks ?? {}), ...(initialLinks ?? {}) }
        : undefined
    if (mergedLinks) {
      // Staged like any user-made selection, so the fields render populated and
      // the normal save path writes the junction rows.
      setM2mLinks((prev) => {
        const next = new Map(prev)
        for (const [key, ids] of Object.entries(mergedLinks)) {
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
    if (!itemData) return
    const prev = initialDataRef.current
    const firstLoad = Object.keys(prev).length === 0
    const ownSave = Date.now() - ownSaveAtRef.current < 8000
    // Someone else's write landed while this form was open (RecordLiveSync
    // invalidated the record): note what moved so the fields can show a
    // "was X · who, just now" ghost (#2), and — when the user has unsaved
    // edits — merge only the fields they have NOT touched, keeping their
    // draft dirty instead of silently replacing it.
    if (!firstLoad && !ownSave) {
      const changed = Object.keys(itemData).filter(
        (k) => !k.startsWith('__') && !valuesEqual(prev[k], itemData[k])
      )
      // A touched field holds an edit only while its draft differs from the
      // baseline it was made on. Touched-then-saved, reverted or "Take
      // theirs" fields equal that baseline and follow the server — keeping
      // them made an idle tab show someone else's save as its own phantom
      // "2 changes" and resend the old values against an old revision.
      const ownEdits = ownEditFields(changed, userTouchedRef.current, draftRef.current, prev)
      const isOwnEdit = (k: string) => ownEdits.has(k)
      if (changed.length > 0) {
        const lt = lastTouchRef.current
        const by = remoteChangeAuthor(lt, authUserId)
        const at = new Date().toISOString()
        setRemoteChanges((cur) => {
          const next = { ...cur }
          for (const k of changed) {
            // A field the user ALSO edited is a conflict: their draft stays,
            // the remote value waits behind "Take theirs / Keep mine" (#6).
            const conflict = isOwnEdit(k) && !valuesEqual(draftRef.current[k], itemData[k])
            next[k] = conflict
              ? { was: prev[k], by, at, theirs: itemData[k], conflict: true }
              : { was: prev[k], by, at }
          }
          return next
        })
        // The collision baseline moves with the adopted values — but not past
        // a conflict: with the person's own edit of a field still standing
        // against the newer value, the save must meet the mid-air check.
        if (!keepCollisionBase(changed, ownEdits, draftRef.current, itemData))
          void qc.invalidateQueries({ queryKey: ['collision-base', collection, itemId] })
        for (const k of changed) if (!isOwnEdit(k)) userTouchedRef.current.delete(k)
        const editsLeft = [...userTouchedRef.current].some(
          (k) => !valuesEqual(draftRef.current[k], itemData[k])
        )
        if (editsLeft) {
          initialDataRef.current = itemData
          const merged = { ...draftRef.current }
          for (const k of changed) if (!userTouchedRef.current.has(k)) merged[k] = itemData[k]
          draftRef.current = merged
          setDraft(merged)
          return
        }
      }
    }
    initialDataRef.current = itemData
    draftRef.current = itemData
    setDraft(itemData)
    setIsDirty(false)
    // biome-ignore lint/correctness/useExhaustiveDependencies: authUserId only attributes the ghost
  }, [itemData])

  // ── What is unsaved (#15 dirty guard, #6 changes tray, #17 rail dots) ───
  const unsavedSummary = useMemo<UnsavedSummary>(() => {
    const base = initialDataRef.current
    const fields: string[] = []
    for (const k of Object.keys(draft)) {
      if (k.startsWith('__')) continue
      if (!userTouchedRef.current.has(k)) continue
      if (valuesEqual(draft[k], base[k])) continue
      fields.push(k)
    }
    const size = <T,>(m: Map<string, T>, f: (v: T) => number) =>
      [...m.values()].reduce((n, v) => n + f(v), 0)
    const rows = size(pendingO2MRows, (r) => r.length)
    const edits = size(pendingO2MEdits, (e) => e.size)
    const deletes = size(pendingO2MDeletes, (d) => d.size)
    // Links a personal default (or what it derived) staged are prefill, not unsaved work.
    const links = linksBeyond(m2mLinks, pdQuietLinksRef.current(m2mLinks))
    const unlinks = size(m2mUnlinks, (u) => u.size)
    const total = fields.length + rows + edits + deletes + links + unlinks
    const parts: string[] = []
    if (fields.length) parts.push(`${fields.length} field${fields.length === 1 ? '' : 's'}`)
    const lines = rows + edits + deletes
    if (lines) parts.push(`${lines} line${lines === 1 ? '' : 's'}`)
    if (links + unlinks) parts.push(`${links + unlinks} link${links + unlinks === 1 ? '' : 's'}`)
    return { fields, rows, edits, deletes, links, unlinks, total, text: parts.join(', ') }
    // biome-ignore lint/correctness/useExhaustiveDependencies: userTouchedRef / initialDataRef mutate with draft
  }, [draft, pendingO2MRows, pendingO2MEdits, pendingO2MDeletes, m2mLinks, m2mUnlinks])
  const hasUnsaved = isDirty || unsavedSummary.total > 0
  // A remote force reload waits while this is true (ForceReloadBanner, lib/unsaved-work.ts).
  // Set by the draft persist effect below: store this form's draft now (true = kept).
  const saveForReloadRef = useRef<() => Promise<boolean>>(async () => false)
  // …unless the work is kept: a pushed reload first stores this form's draft (browser + server)
  // and the reloaded page offers it back, so people on an open form still get the new build.
  useUnsavedWork(hasUnsaved, 'Unsaved record changes', () => saveForReloadRef.current())
  useEffect(() => {
    onDirtyChange?.(hasUnsaved, unsavedSummary)
    window.dispatchEvent(
      new CustomEvent('nvr:form-unsaved', {
        detail: { collection, item: isNew ? 'new' : String(itemId), ...unsavedSummary }
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callback identity is the host's concern
  }, [hasUnsaved, unsavedSummary])
  // Leave-page prompt covers staged lines and links, not only scalar dirt.
  useEffect(() => {
    if (!hasUnsaved) return
    const h = (e: BeforeUnloadEvent) => {
      // A pushed reload already stored this form's draft (ForceReloadBanner).
      if (isReloadingForUpdate()) return
      e.preventDefault()
      e.returnValue = unsavedSummary.text
        ? `You have unsaved changes: ${unsavedSummary.text}.`
        : 'You have unsaved changes.'
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [hasUnsaved, unsavedSummary.text])

  // Recovery check: once the record (or the blank new form) is ready, look
  // for a stored draft. A draft whose every value now equals the loaded
  // record is stale and silently dropped; otherwise the banner offers it.
  // Guarded by STATE, not a ref: StrictMode runs the effect twice on mount
  // (cleanup cancels the first load) and a ref stamped on the first run would
  // make the second bail out with the check never completing.
  // Keyed on the record being READY, not on the record object: a refetch
  // landing mid-check (live sync, a recheck) used to cancel the check and
  // send GET /drafts again. The comparison reads initialDataRef at the end,
  // so it still sees the newest copy.
  const recordReady = isNew || !!itemData
  // biome-ignore lint/correctness/useExhaustiveDependencies: readiness, not identity, re-runs the check
  useEffect(() => {
    // Design mode never looks for (or, with no check, persists) drafts.
    if (!recordReady || designOn) return
    if (recoveryCheckedKey === recoveryKey) return
    let cancelled = false
    // #24 — the server copy (another device) competes with the local one; the
    // newer wins. A server miss or error is just "no server draft".
    const serverKey = isNew ? 'new' : String(itemId)
    const serverDraft = authUserId
      ? client
          .request<{ data: { payload: StoredDraft; saved_at: string } }>(
            get(`/drafts/${collection}/${serverKey}`)
          )
          .then((r) =>
            r?.data?.payload && typeof r.data.payload === 'object' ? r.data.payload : null
          )
          .catch(() => null)
      : Promise.resolve(null)
    void Promise.all([loadDraft(recoveryKey), serverDraft]).then(([local, remote]) => {
      if (remote) serverDraftRef.current = true
      if (cancelled) return
      setRecoveryCheckedKey(recoveryKey)
      const stored =
        local && remote
          ? String(remote.saved_at) > String(local.saved_at)
            ? remote
            : local
          : (local ?? remote)
      if (
        !stored ||
        !draftHasContent(stored) ||
        (isNew && !draftMatchesPrefill(stored, prefillSig))
      ) {
        setRecovery({ state: 'none' })
        return
      }
      const base = initialDataRef.current
      const liveFields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(stored.fields ?? {}))
        if (!valuesEqual(v, base[k])) liveFields[k] = v
      const pruned = { ...stored, fields: liveFields }
      if (!draftHasContent(pruned)) {
        void deleteDraft(recoveryKey)
        setRecovery({ state: 'none' })
        return
      }
      const created = isNew ? draftCreatedAs(recoveryKey, stored.saved_at) : null
      setRecovery({ state: 'offer', draft: pruned, createdId: created ? created.id : null })
    })
    return () => {
      cancelled = true
    }
  }, [isNew, recordReady, recoveryKey, recoveryCheckedKey])

  // Persist: debounced after every change while dirty; cleared the moment
  // the form is clean. Held off while an offer is pending so the freshly
  // loaded (clean) form cannot delete the draft it is about to offer.
  // The write still waiting on the debounce: a page left within it (browser
  // Back, a sidebar link) runs it on unmount instead of dropping what was
  // typed — except while a create is in flight or once it succeeded, when
  // the draft is spent (a flush then would bring the created record back).
  const persistPendingRef = useRef<(() => void) | null>(null)
  const draftSpentRef = useRef(false)
  // New work after a create (the form kept open on a fresh record) is a draft again.
  const wasDirtyRef = useRef(isDirty)
  useEffect(() => {
    if (isDirty && !wasDirtyRef.current) draftSpentRef.current = false
    wasDirtyRef.current = isDirty
  }, [isDirty])
  useEffect(
    () => () => {
      const run = persistPendingRef.current
      persistPendingRef.current = null
      if (run && !draftSpentRef.current) run()
    },
    []
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: `draft` is the re-run trigger; the payload reads draftRef for the synchronous mirror
  useEffect(() => {
    persistPendingRef.current = null
    // A draft offer still open (or not yet checked): this form's edits are not stored, so a
    // pushed reload waits for the person.
    saveForReloadRef.current = async () => false
    if (recovery.state !== 'none' || recoveryCheckedKey !== recoveryKey) return
    // `forReload`: called by a pushed reload (saveForReloadRef) — it may only answer true when
    // nothing the person did is lost by reloading now.
    const run = async (forReload = false): Promise<boolean> => {
      persistPendingRef.current = null
      // A create in flight: reloading now could lose or repeat it — wait for it.
      if (draftSpentRef.current) return !forReload
      if (!isDirty) {
        // Staged lines or links with a clean flag would be dropped below: keep the hold.
        // Links only a personal default staged come back on reload: they hold nothing.
        const quietLinks = pdQuietLinksRef.current(m2mLinks)
        const staged =
          pendingO2MRows.size +
          pendingO2MEdits.size +
          pendingO2MDeletes.size +
          (quietLinks.size ? linksBeyond(m2mLinks, quietLinks) : m2mLinks.size) +
          m2mUnlinks.size
        if (forReload && staged > 0) return false
        void deleteDraft(recoveryKey)
        if (authUserId && serverDraftRef.current) {
          serverDraftRef.current = false
          void client
            .request(del(`/drafts/${collection}/${isNew ? 'new' : String(itemId)}`))
            .catch(() => {})
        }
        return true
      }
      const base = initialDataRef.current
      const fields: Record<string, unknown> = {}
      const baseVals: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(draftRef.current)) {
        if (k.startsWith('__') || valuesEqual(v, base[k])) continue
        // A new form's layout defaults / prefill are not the person's work —
        // only fields they touched, or that a rule filled from one of their
        // picks, count (an existing record diffs vs base).
        if (isNew && !userTouchedRef.current.has(k) && !autoFilledFieldsRef.current.has(k)) continue
        fields[k] = v
        baseVals[k] = base[k]
      }
      const obj = <T,>(m: Map<string, T>, conv: (v: T) => unknown) =>
        Object.fromEntries([...m.entries()].map(([k, v]) => [k, conv(v)]))
      const stored: StoredDraft = {
        key: recoveryKey,
        collection,
        item_id: isNew ? 'new' : String(itemId),
        user_id: authUserId || 'anon',
        saved_at: new Date().toISOString(),
        fields,
        base: baseVals,
        base_updated_at:
          (base.date_updated as string | undefined) ??
          (base.updated_at as string | undefined) ??
          null,
        pending_rows: obj(pendingO2MRows, (r) => r) as StoredDraft['pending_rows'],
        pending_edits: obj(pendingO2MEdits, (e) =>
          Object.fromEntries(e)
        ) as StoredDraft['pending_edits'],
        pending_deletes: obj(pendingO2MDeletes, (d) => [...d]) as StoredDraft['pending_deletes'],
        m2m_links: obj(m2mLinks, (l) => [...l]) as StoredDraft['m2m_links'],
        m2m_unlinks: obj(m2mUnlinks, (u) => [...u]) as StoredDraft['m2m_unlinks'],
        ...(isNew ? { prefill_sig: prefillSig } : {})
      }
      if (!draftHasContent(stored)) {
        void deleteDraft(recoveryKey)
        if (authUserId && serverDraftRef.current) {
          serverDraftRef.current = false
          void client
            .request(del(`/drafts/${collection}/${isNew ? 'new' : String(itemId)}`))
            .catch(() => {})
        }
        // Nothing the person did (a new form's defaults / prefill come back on reload).
        return true
      }
      const local = saveDraft(stored)
      // #24 — mirror to the server so the draft follows the person.
      if (authUserId) serverDraftRef.current = true
      const remote = authUserId
        ? client
            .request(
              put(`/drafts/${collection}/${isNew ? 'new' : String(itemId)}`, {
                payload: stored,
                saved_at: stored.saved_at
              })
            )
            .then(
              () => true,
              () => false
            )
        : Promise.resolve(false)
      // Kept when either copy landed: the reloaded form looks in the browser, then the server.
      if (await local) return true
      return remote
    }
    saveForReloadRef.current = () => run(true)
    persistPendingRef.current = () => void run()
    const t = setTimeout(() => void run(), 800)
    return () => clearTimeout(t)
  }, [
    recovery.state,
    recoveryCheckedKey,
    recoveryKey,
    isDirty,
    draft,
    pendingO2MRows,
    pendingO2MEdits,
    pendingO2MDeletes,
    m2mLinks,
    m2mUnlinks,
    isNew,
    itemId,
    collection,
    authUserId
  ])

  // Set once the rule / cross-default runners exist (they are declared below).
  const rederiveRef = useRef<(field: string, value: unknown) => void>(() => {})
  const restoreDraft = useCallback(() => {
    const r = recoveryRef.current
    if (r.state !== 'offer') return
    const d = r.draft
    const next = { ...draftRef.current, ...d.fields }
    draftRef.current = next
    setDraft(next)
    for (const k of Object.keys(d.fields)) {
      userTouchedRef.current.add(k)
      fieldEditSeqRef.current.set(k, ++ruleSeqRef.current)
    }
    if (Object.keys(d.pending_rows ?? {}).length)
      setPendingO2MRows(new Map(Object.entries(d.pending_rows)))
    if (Object.keys(d.pending_edits ?? {}).length)
      setPendingO2MEdits(
        new Map(Object.entries(d.pending_edits).map(([k, e]) => [k, new Map(Object.entries(e))]))
      )
    if (Object.keys(d.pending_deletes ?? {}).length)
      setPendingO2MDeletes(
        new Map(Object.entries(d.pending_deletes).map(([k, x]) => [k, new Set(x)]))
      )
    if (Object.keys(d.m2m_links ?? {}).length) setM2mLinks(new Map(Object.entries(d.m2m_links)))
    if (Object.keys(d.m2m_unlinks ?? {}).length)
      setM2mUnlinks(new Map(Object.entries(d.m2m_unlinks).map(([k, x]) => [k, new Set(x)])))
    setIsDirty(true)
    setDraftRestored(true)
    setRecovery({ state: 'none' })
    // Re-derive what the restored picks fill (field rules, cross-record
    // defaults) — a draft stored without those values (saved before they
    // landed, or by an older build) came back with Shipping Location / Org
    // Code empty and flagged Required. Fill-only-when-empty: every restored
    // value wins over a re-derived one.
    for (const [k, v] of Object.entries(d.fields)) {
      if (v === null || v === undefined || v === '') continue
      rederiveRef.current(k, v)
    }
  }, [])
  const discardDraft = useCallback(() => {
    void deleteDraft(recoveryKey)
    if (authUserId)
      void client
        .request(del(`/drafts/${collection}/${isNew ? 'new' : String(itemId)}`))
        .catch(() => {})
    setRecovery({ state: 'none' })
  }, [recoveryKey, authUserId, client, collection, isNew, itemId])

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
    layoutDefaultValuesRef.current = defaults
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
          notPersonStageRef.current += 1
          try {
            for (const id of value) m2mStagingCtx.stageLink(stagingKey, id)
          } finally {
            notPersonStageRef.current -= 1
          }
          continue
        }
      }
      scalar[key] = value
    }
    const next = applyLayoutDefaults(draftRef.current, scalar)
    draftRef.current = next
    setDraft(next)
  }, [isNew, activeLayoutData, relations, relationsFetched, collection, m2mStagingCtx])

  // A ?prefill= / record template that names an M2M or M2A alias as a plain value
  // (`internal_contact: ['<user id>']`, or one id) — the pickers and the save read staged
  // links, never a draft key, so the value was silently dropped. Stage it like `__links`.
  const appliedPrefillAliasesRef = useRef(false)
  useEffect(() => {
    if (!isNew || !initialValues || appliedPrefillAliasesRef.current || !relationsFetched) return
    appliedPrefillAliasesRef.current = true
    const staged = prefillAliasLinks(initialValues, relations, collection)
    if (staged.length === 0) return
    notPersonStageRef.current += 1
    try {
      for (const { stagingKey, ids } of staged)
        for (const id of ids) m2mStagingCtx.stageLink(stagingKey, id)
    } finally {
      notPersonStageRef.current -= 1
    }
    const drop = new Set(staged.map((x) => x.field))
    const strip = (d: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(d).filter(([k]) => !drop.has(k)))
    draftRef.current = strip(draftRef.current)
    setDraft((d) => strip(d))
  }, [isNew, initialValues, relations, relationsFetched, collection, m2mStagingCtx])

  // Relation-path fields ('purchase_order.workflow.workflow_id'): read-only
  // values reached through M2O hops, resolved server-side in one batched call
  // and merged into the draft for display. Excluded from saves via readonly.
  const relationPathFields = useMemo(
    () =>
      (fieldConfig ?? [])
        .filter(
          (f) =>
            f.interface === 'relation-path' &&
            f.field.includes('.') &&
            !deferred.fields.has(f.field)
        )
        .map((f) => f.field),
    [fieldConfig, deferred]
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

  // ── Quick picker (layout.quick_picker) ────────────────────────────────────
  // Writes for an M2M step go through the same staging the pickers use:
  // a desired id that has a committed junction row staged for unlink is
  // un-unlinked, a new id is staged as a link, a dropped id unlinks its
  // junction row (or unstages its pending link). Nothing else changes.
  const quickPickerSteps = useMemo(() => {
    const raw = activeLayoutData?.layout?.quick_picker
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []
  }, [activeLayoutData])
  // Opened from the header's "Quick pick" button only — never always-on
  // (less intrusive). Done / the button again hides it.
  const [quickPickOpen, setQuickPickOpen] = useState(false)
  const setQuickPickerM2M = useCallback(
    (field: string, ids: string[]) => {
      const info = resolveM2MAlias(relations, collection, field)
      if (!info) return
      const key = info.stagingKey
      const committed = (qc.getQueryData<Record<string, unknown>[]>([
        'm2m-items',
        info.manyCollection,
        info.manyField,
        itemId
      ]) ?? []) as Array<Record<string, unknown>>
      const unlinked = m2mStagingCtx.getStagedUnlinks(key)
      const stagedLinks = (m2mStagingCtx.getStagedLinks(key) ?? []).map(String)
      const want = new Set(ids.map(String))
      const rowByRelated = new Map(committed.map((r) => [String(r[info.junctionField]), r]))
      // Current effective set: committed minus unlinked, plus staged links.
      const effective = new Set<string>([
        ...committed.filter((r) => !unlinked.has(r.id)).map((r) => String(r[info.junctionField])),
        ...stagedLinks
      ])
      for (const id of want) {
        if (effective.has(id)) continue
        const row = rowByRelated.get(id)
        if (row && unlinked.has(row.id)) m2mStagingCtx.unstageUnlink(key, row.id)
        else m2mStagingCtx.stageLink(key, id)
      }
      for (const id of effective) {
        if (want.has(id)) continue
        const row = rowByRelated.get(id)
        if (row && !unlinked.has(row.id)) m2mStagingCtx.stageUnlink(key, row.id)
        else if (stagedLinks.includes(id)) m2mStagingCtx.unstageLink(key, id)
      }
      userTouchedRef.current.add(field)
      setIsDirty(true)
    },
    [relations, collection, itemId, qc, m2mStagingCtx]
  )

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
  const recordDerivedFill = useCallback(
    (source: string, parent: string, stagingKey: string, ids: string[]) => {
      if (ids.length === 0) return
      const list = derivedFillsRef.current.get(source) ?? []
      list.push({ parent, stagingKey, ids })
      derivedFillsRef.current.set(source, list)
      derivedOriginRef.current.set(parent, source)
    },
    []
  )

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
            // Skip resolution when the parent can't accept a fill anyway —
            // both fill branches below are fill-only-when-empty, so a set
            // parent makes the fetch pointless (and on circular pairs like
            // project ⇄ project_type it was 500ing on alias field selects).
            const parentField = rule.parent_field
            if (m2mAliasFieldsForRules.has(parentField)) {
              if ((m2mAliasFieldStatesRef.current[parentField]?.ids ?? []).length > 0) continue
            } else {
              const existingParent = draftRef.current[parentField]
              if (existingParent !== null && existingParent !== undefined && existingParent !== '')
                continue
            }
            const col = String(rule.filter_column)
            let values: string[] = []
            if (col.includes('.')) {
              // 'regions.regions_id' — first hop is an alias on the picked
              // record's collection, leaf a junction/child column.
              const [aliasName, leaf] = [
                col.slice(0, col.indexOf('.')),
                col.slice(col.indexOf('.') + 1)
              ]
              pickedRels ??= await client
                .request<{ data: CMSRelation[] }>(
                  get(`/data-model/relations/for/${pickedCollection}`)
                )
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
                .request<{ data: CMSRelation[] }>(
                  get(`/data-model/relations/for/${pickedCollection}`)
                )
                .then((r) => r.data ?? [])
                .catch(() => [])
              const bareAlias = pickedRels.find(
                (r) =>
                  r.one_collection === pickedCollection && r.one_field === col && r.junction_field
              )
              const o2mAlias = !bareAlias
                ? pickedRels.find(
                    (r) =>
                      r.one_collection === pickedCollection &&
                      r.one_field === col &&
                      !r.junction_field
                  )
                : null
              if (o2mAlias?.many_collection && o2mAlias.many_field) {
                // O2M alias: the values are the CHILD row ids (projects of a
                // project type). Only a single unambiguous child ever fills a
                // scalar parent, so a small page is plenty.
                const rows = await client
                  .request<{ data: Record<string, unknown>[] }>(
                    get(`/items/${o2mAlias.many_collection}`, {
                      filter: JSON.stringify({ [o2mAlias.many_field]: { _eq: pickedId } }),
                      limit: 50,
                      fields: 'id'
                    })
                  )
                  .then((r) => r.data ?? [])
                  .catch(() => [])
                values = rows.map((row) => String(row.id)).filter((v) => v !== 'null')
              } else if (bareAlias?.many_collection && bareAlias.many_field) {
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
                const row = await readRow(pickedCollection, String(pickedId), [col]).catch(
                  () => null
                )
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
              const maxVals = parseJson<{ max_values?: number | null }>(
                parentMeta?.options ?? null
              )?.max_values
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
              // Part of the person's work: the recovery draft keeps it (an
              // IR's Project Type, filled from its Project, came back empty).
              markAutoFilled([parent])
              // Derived from a personal default: prefill too, not the person's work.
              if (pdQuietRef.current.has(root)) pdQuietRef.current.add(parent)
              else setIsDirty(true)
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
    [
      fieldConfig,
      relations,
      collection,
      m2mAliasFieldsForRules,
      m2mStagingCtx,
      client,
      undoDerivedFills,
      recordDerivedFill,
      markAutoFilled
    ]
  )
  const upstreamCascadesRef = useRef(runUpstreamCascades)
  upstreamCascadesRef.current = runUpstreamCascades

  const runCrossDefaults = useCallback(
    (field: string, value: unknown, depth = 0, fillEmptyOnly = false) => {
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
        if (depth === 0 && !fillEmptyOnly) undoDerivedFills(field)
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
        // The shared row read (full row, projected) never names an alias in
        // fields=, so an alias SOURCE simply reads as absent and the relation
        // branches below resolve it; a dotted source still goes to the server.
        void readRow(cfg.source_collection, value as string | number, sourceFields)
          .catch(() => readRow(cfg.source_collection as string, value as string | number, ['id']))
          .then(async (res) => {
            const src = res
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
              const maxV = parseJson<{ max_values?: number | null }>(
                targetMeta?.options ?? null
              )?.max_values
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
              // refers to the source record itself (e.g. a location's
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
            // A re-derive (restored draft) never replaces a value already there.
            if (fillEmptyOnly)
              for (const [k, v] of Object.entries(patch)) {
                const cur = draftRef.current[k]
                const curEmpty = cur === null || cur === undefined || cur === ''
                if (!curEmpty || v === null || v === undefined || v === '') delete patch[k]
              }
            if (Object.keys(patch).length === 0) return
            draftRef.current = { ...draftRef.current, ...patch }
            setDraft((prev) => ({ ...prev, ...patch }))
            markAutoFilled(Object.keys(patch))
            // Derived from a personal default: prefill too, not the person's work.
            if (pdQuietRef.current.has(field))
              for (const k of Object.keys(patch)) pdQuietRef.current.add(k)
            else setIsDirty(true)
            // Chain: a target that is itself a watched FK cascades its own
            // defaults (billing location → shipping location → address copy)
            // AND its own upstream cascades (shipping → region → zone).
            // Depth-capped to break config cycles.
            for (const [target, v] of Object.entries(patch)) {
              if (target !== field && v != null && v !== '') {
                runCrossDefaults(target, v, depth + 1, fillEmptyOnly)
                upstreamCascadesRef.current?.(target, v, depth + 1)
              }
            }
          })
          .catch(() => {
            /* source record unreadable — leave targets untouched */
          })
      }
    },
    [
      fieldConfig,
      client,
      m2mAliasFieldsForRules,
      m2mStagingCtx,
      undoDerivedFills,
      recordDerivedFill
    ]
  )

  // Prefilled FKs behave like user picks: once the field config and
  // relations are loaded, run cross-record defaults + upstream cascades for
  // every seeded value — a deep link that seeds `unit` fills zone/region/
  // project the same way a manual pick would. Both fill paths are
  // fill-only-when-empty, so seeds that already carry parents are untouched.
  const seededCascadesRef = useRef(false)
  useEffect(() => {
    if (!isNew || seededCascadesRef.current) return
    if (!appliedInitialValuesRef.current) return
    if ((fieldConfig ?? []).length === 0 || relations.length === 0) return
    seededCascadesRef.current = true
    const { __links: _links, ...plain } = (initialValues ?? {}) as Record<string, unknown> & {
      __links?: Record<string, unknown[]>
    }
    for (const [field, value] of Object.entries(plain)) {
      if (value === null || value === undefined || value === '') continue
      runCrossDefaults(field, value)
      upstreamCascadesRef.current(field, value)
    }
  }, [isNew, fieldConfig, relations, initialValues, runCrossDefaults])
  crossDefaultsRef.current = runCrossDefaults

  const applyFieldRuleResults = useCallback(
    (
      results: Record<string, unknown> | null | undefined,
      sentSeq?: number,
      // The trigger still holds a personal default's value: what the rule fills is prefill too.
      quietTrigger = false
    ) => {
      const { scalar: rawScalar, alias } = partitionRuleResults(
        results,
        new Set(m2mAliasFieldsForRules.keys())
      )
      // Drop scalar targets the user edited after this request was sent.
      const scalar: Record<string, unknown> = {}
      for (const [field, value] of Object.entries(rawScalar)) {
        if (sentSeq !== undefined && (fieldEditSeqRef.current.get(field) ?? 0) > sentSeq) continue
        scalar[field] = value
        if (sentSeq !== undefined) fieldEditSeqRef.current.set(field, sentSeq)
      }
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
        if (quietTrigger && toStage.length > 0) {
          // The field becomes prefill only while it holds nothing the person staged: a cascade
          // from their own pick on it must still mark the form dirty.
          const held = (m2mAliasFieldStatesRef.current[field]?.ids ?? []).map(String)
          const quietHeld = pdQuietLinksRef
            .current(new Map([[info.stagingKey, held]]))
            .get(info.stagingKey)
          if (held.every((id) => quietHeld?.has(id))) pdQuietRef.current.add(field)
          const set = pdQuietRuleLinksRef.current.get(info.stagingKey) ?? new Set<string>()
          for (const id of toStage) set.add(String(id))
          pdQuietRuleLinksRef.current.set(info.stagingKey, set)
        }
        notPersonStageRef.current += 1
        try {
          for (const id of toStage) m2mStagingCtx.stageLink(info.stagingKey, id)
        } finally {
          notPersonStageRef.current -= 1
        }
      }
      if (Object.keys(scalar).length > 0) {
        const merged = mergeRuleResults(draftRef.current, scalar)
        draftRef.current = merged
        setDraft(merged)
        markAutoFilled(Object.keys(scalar))
        if (quietTrigger) for (const k of Object.keys(scalar)) pdQuietRef.current.add(k)
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
    (field: string, explicitValue?: unknown, opts?: { fillEmptyOnly?: boolean }) => {
      if (designOn) return
      const rules = rulesForTriggerField(fieldRules, field)
      if (rules.length === 0) return
      const existingTimer = fieldRuleTimersRef.current[field]
      if (existingTimer) clearTimeout(existingTimer)
      fieldRuleTimersRef.current[field] = setTimeout(() => {
        delete fieldRuleTimersRef.current[field]
        const sentSeq = ruleSeqRef.current
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
          .then((res) => {
            let results = res.data
            // Re-derive after a draft restore: only targets still empty.
            if (opts?.fillEmptyOnly && results) {
              results = { ...results }
              for (const k of Object.keys(results)) {
                if (m2mAliasFieldsForRules.has(k)) continue
                const cur = draftRef.current[k]
                if (cur !== null && cur !== undefined && cur !== '') delete results[k]
              }
            }
            applyFieldRuleResults(results, sentSeq, pdQuietRef.current.has(field))
          })
          .catch(() => {})
      }, 300)
    },
    [
      designOn,
      fieldRules,
      collection,
      client,
      getM2MEffectiveIds,
      applyFieldRuleResults,
      m2mAliasFieldsForRules
    ]
  )
  rederiveRef.current = (field, value) => {
    evaluateFieldRulesForChange(field, undefined, { fillEmptyOnly: true })
    runCrossDefaults(field, value, 0, true)
    // The parents a pick fills (Project → Project Type) — fill-only-when-empty
    // like the rest, so a restored value always wins.
    upstreamCascadesRef.current(field, value)
  }

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

  // After a manual lock release the next real edit re-acquires the lock.
  // Ref because useItemLock is declared below this callback.
  const relockOnEditRef = useRef<null | (() => void)>(null)
  const handleFieldChange = useCallback(
    (field: string, value: unknown) => {
      // Design mode: inputs are inert.
      if (designOn) return
      if (readOnlyRef.current && !undoingRef.current) return
      // No-op guard: editors can emit a change with an IDENTICAL value (rich
      // text normalizing on mount is the classic) — that must not dirty the
      // form, or a freshly loaded record claims unsaved changes with nothing
      // actually different (the phantom-dirty report).
      if (valuesEqual(draftRef.current[field], value)) return
      userTouchedRef.current.add(field)
      relockOnEditRef.current?.()
      fieldEditSeqRef.current.set(field, ++ruleSeqRef.current)
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
      // The person's own edit: no longer prefill; a changed parent re-picks untouched children.
      pdQuietRef.current.delete(field)
      pdPersonChangeRef.current(field)
      // Revert / Take theirs that puts the last change back leaves nothing to
      // save: the form is clean again (the tab dot, the leave-page prompt and
      // the stored draft all follow isDirty).
      setIsDirty(undoingRef.current ? draftDiffers(next, initialDataRef.current) : true)
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
    [designOn, fieldConfig, evaluateFieldRulesForChange, runCrossDefaults]
  )
  /** Puts a field back (Revert, Take theirs): allowed on a read-only form and
   *  leaves it clean when nothing else differs. */
  const undoTo = useCallback(
    (field: string, value: unknown) => {
      undoingRef.current = true
      try {
        handleFieldChange(field, value)
      } finally {
        undoingRef.current = false
      }
    },
    [handleFieldChange]
  )

  // ── Personal field defaults (spec 2026-10-28-personal-field-defaults-design) ──────────────
  // A placement opts its field in (overrides.personal_default); the hook reads the person's
  // defaults once, applies them once per new-form open (after explicit prefill, before rules /
  // cross-record defaults, which then fill only what is still empty), and provides the
  // PersonalDefaultsContext the field menu and FieldRow read on new and existing records.
  const pdAllowed = useMemo(() => {
    const out = new Set<string>()
    for (const f of fieldConfig ?? []) {
      if (f.readonly || f.hidden) continue
      if ((f._overrides as Record<string, unknown> | null | undefined)?.personal_default === true)
        out.add(f.field)
    }
    return out
  }, [fieldConfig])
  // M2M values the hook staged this tick, before the render that carries them.
  const pdAliasPendingRef = useRef<Map<string, string[]>>(new Map())
  useEffect(() => {
    pdAliasPendingRef.current.clear()
  })
  const pdReadValue = useCallback(
    (field: string): unknown =>
      m2mAliasFieldsForRules.has(field)
        ? (pdAliasPendingRef.current.get(field) ?? m2mAliasFieldStatesRef.current[field]?.ids ?? [])
        : undefined,
    [m2mAliasFieldsForRules]
  )
  const pdExplicit = useMemo(() => {
    const out = new Set<string>()
    const { __links, ...plainInitial } = (initialValues ?? {}) as Record<string, unknown> & {
      __links?: Record<string, unknown>
    }
    for (const k of Object.keys(plainInitial)) out.add(k)
    for (const k of Object.keys(__links ?? {})) out.add(k)
    for (const k of Object.keys(initialLinks ?? {})) out.add(k)
    for (const k of Object.keys(initialImportResult?.values ?? {})) out.add(k)
    for (const k of Object.keys(initialImportResult?.m2m ?? {})) out.add(k)
    return out
  }, [initialValues, initialLinks, initialImportResult])
  const pdIsExplicit = useCallback(
    (field: string) => {
      if (pdExplicit.has(field)) return true
      const info = m2mAliasFieldsForRules.get(field)
      if (info && pdExplicit.has(info.stagingKey)) return true
      return autofillAppliedRef.current?.fields.includes(field) ?? false
    },
    [pdExplicit, m2mAliasFieldsForRules]
  )
  const pdChecks = useMemo(
    () =>
      makePersonalDefaultChecks({
        client,
        collection,
        fields: fieldConfig ?? [],
        relations,
        readValue: (f) => pdReadValue(f) ?? draftRef.current[f]
      }),
    [client, collection, fieldConfig, relations, pdReadValue]
  )
  const pdSetFieldValue = useCallback(
    (field: string, value: unknown, previous?: unknown) => {
      if (isEmptyValue(value)) pdQuietRef.current.delete(field)
      else pdQuietRef.current.add(field)
      const info = m2mAliasFieldsForRules.get(field)
      if (!info) {
        draftRef.current = { ...draftRef.current, [field]: value }
        setDraft((prev) => ({ ...prev, [field]: value }))
        return
      }
      const list = (v: unknown) => (Array.isArray(v) ? v : isEmptyValue(v) ? [] : [v])
      const want = list(value)
      const wantIds = new Set(want.map(String))
      const drop = list(previous)
        .map(String)
        .filter((id) => !wantIds.has(id))
      const before = (
        pdAliasPendingRef.current.get(field) ??
        m2mAliasFieldStatesRef.current[field]?.ids ??
        []
      ).map(String)
      // A prefill, not a pick: no cross-default round and no person change from the staging.
      crossFillInFlightRef.current += 1
      try {
        for (const id of drop) m2mStagingCtx.unstageLink(info.stagingKey, id)
        for (const id of want)
          if (!before.includes(String(id))) m2mStagingCtx.stageLink(info.stagingKey, id)
      } finally {
        crossFillInFlightRef.current -= 1
      }
      pdAliasPendingRef.current.set(field, [
        ...new Set([...before.filter((id) => !drop.includes(id)), ...wantIds])
      ])
    },
    [m2mAliasFieldsForRules, m2mStagingCtx]
  )
  const personalDefaults = usePersonalDefaults({
    collection,
    isNew,
    layoutAllows: (f) => pdAllowed.has(f),
    draftRef,
    setFieldValue: pdSetFieldValue,
    markAutoFilled,
    revalidate: pdChecks.revalidate,
    disabled: designOn || draftRestored,
    enabled: !designOn && pdAllowed.size > 0,
    ready:
      isNew &&
      !designOn &&
      activeLayoutData !== undefined &&
      fieldConfigFetched &&
      relationsFetched &&
      recovery.state === 'none' &&
      recoveryCheckedKey === recoveryKey &&
      // The draft check ran for the real person (the auth id can arrive a render late; the
      // anonymous key's check never saw their server draft).
      !!authUserId,
    resetKey: `${collection}:${itemId}`,
    rulesFor: (f) =>
      getCascadeFilters(
        (fieldConfig ?? []).find((fc) => fc.field === f)?.dependency_config ?? null
      ),
    readValue: pdReadValue,
    canFill: (f) => !userTouchedRef.current.has(f) && !pdIsExplicit(f),
    replaceable: (f, cur) =>
      Object.hasOwn(layoutDefaultValuesRef.current, f) &&
      !pdIsExplicit(f) &&
      sameDefaultValue(cur, layoutDefaultValuesRef.current[f]),
    fieldLabel: (f) => {
      const fc = (fieldConfig ?? []).find((x) => x.field === f)
      return fc?.label || titleCase(f)
    },
    valueLabel: pdChecks.valueLabel,
    afterApply: (f, v) => {
      // What a pick of this value fills (field rules, cross-record defaults, upstream
      // cascades) — fill-only-when-empty, so a personal default is never replaced by them.
      if (!m2mAliasFieldsForRules.has(f)) {
        rederiveRef.current(f, v)
        return
      }
      // M2M: field rules follow the staging watcher; cross defaults + cascades per id.
      for (const id of Array.isArray(v) ? v : [v]) {
        runCrossDefaults(f, id, 0, true)
        upstreamCascadesRef.current(f, id)
      }
    }
  })
  pdPersonChangeRef.current = personalDefaults.onPersonChange
  pdReleaseRef.current = personalDefaults.release
  pdQuietLinksRef.current = (links) => {
    const out = new Map<string, Set<string>>()
    const add = (key: string, ids: unknown[]) => {
      const set = out.get(key) ?? new Set<string>()
      for (const id of ids) set.add(String(id))
      out.set(key, set)
    }
    for (const [f, v] of personalDefaults.appliedNow()) {
      const info = m2mAliasFieldsForRules.get(f)
      if (info && Array.isArray(v)) add(info.stagingKey, v)
    }
    for (const [source, entries] of derivedFillsRef.current)
      if (pdQuietRef.current.has(source)) for (const e of entries) add(e.stagingKey, e.ids)
    // Links a rule staged from a personal-default trigger (a person's pick on that field
    // takes its entry out first). Only ids still staged count.
    for (const [key, ids] of pdQuietRuleLinksRef.current) {
      const staged = new Set((links.get(key) ?? []).map(String))
      add(
        key,
        [...ids].filter((id) => staged.has(id))
      )
    }
    return out
  }
  // Another record on this form instance (a create that navigates in place): nothing quiet
  // carries over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the record identity is the trigger
  useEffect(() => {
    pdQuietRef.current.clear()
    pdQuietRuleLinksRef.current.clear()
  }, [collection, itemId, isNew])

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
  // The counts read the grid's own cache entry (InlineTableField / SummaryPanel:
  // same key, request and row shape) and select the length — a separate
  // 'o2m-count' key fetched the identical rows a second time on every open,
  // and nothing ever refreshed it after a line write.
  const o2mQueryResults = useQueries({
    queries: o2mRelations.map((r) => ({
      queryKey: ['o2m-rows', r.many_collection, r.many_field, itemId, ''],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${r.many_collection}`, {
              filter: JSON.stringify({ [r.many_field!]: { _eq: itemId } }),
              limit: 200
            })
          )
          .then((res) => res.data ?? []),
      select: (rows: Record<string, unknown>[]) => rows.length,
      // A grid only in a section that loads when opened waits for it (#2713).
      enabled: !!itemId && !isNew && !deferred.fields.has(r.one_field as string),
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

  // Values written OUTSIDE handleFieldChange (field rules, cross-record
  // defaults, cascades, imports, a restored draft) clear the required error
  // they satisfy — the 'Can't save yet' list follows the current values. A
  // rule-filled Shipping Location stayed listed as "Required" while the field
  // showed it (and Create then saved fine). Alias fields have no draft value
  // and are judged by the count effects above.
  useEffect(() => {
    setValidationErrors((prev) => dropSatisfiedRequired(prev, draft))
  }, [draft])

  const handleM2MCountChange = useCallback(
    (field: string, count: number) => {
      setFieldCounts((prev) => (prev[field] === count ? prev : { ...prev, [field]: count }))
      if (count > 0) touchedFields.current.add(field)
      setValidationErrors((prev) => {
        const fieldMeta = (fieldConfig ?? []).find((f) => f.field === field)
        if (!fieldMeta?.required) return prev
        const next = { ...prev }
        if (count === 0) {
          // Untouched + empty: don't INTRODUCE an error (no nagging before the
          // user has been near the field), but keep one a save attempt set —
          // clearing it here made the 'Can't save yet' summary under-count.
          if (touchedFields.current.has(field)) next[field] = 'This field is required'
        } else {
          delete next[field]
        }
        return next
      })
    },
    [fieldConfig]
  )

  // ── Approval edit lock ─────────────────────────────────────────────────────
  // A record in a locked step (summary_mode_rules.edit_lock) may be changed
  // only by its creator, that step's owners and admins. The pipeline instance
  // read answers for this viewer (`edit_lock`); everyone else gets the form
  // read-only with the server's reason. The server refuses the write anyway
  // (403 EDIT_LOCKED). Same key + reader as the lock-conditions query below.
  const editLockConfigured = useMemo(
    () => !!normalizeSummaryModeRules(colMeta?.summary_mode_rules).edit_lock,
    [colMeta?.summary_mode_rules]
  )
  const { data: editLockInstance } = useQuery<{
    edit_lock?: { locked?: boolean; allowed?: boolean; message?: string } | null
  } | null>({
    queryKey: ['pipeline-instance-lock', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/pipelines/instance/${collection}/${itemId}`))
        .then((r) => r.data as { edit_lock?: { locked?: boolean; allowed?: boolean } } | null)
        .catch(() => null),
    staleTime: 30_000,
    enabled: editLockConfigured && !isNew && !designOn
  })
  const editLock = editLockInstance?.edit_lock
  const editLockMessage =
    !designOn && !isNew && editLock?.locked === true && editLock.allowed === false
      ? editLock.message?.trim() ||
        'This record is in approval — you can view it but not change it.'
      : null

  // ── Item lock ──────────────────────────────────────────────────────────────
  // Summary mode neither takes nor honours the edit lock: the lock is
  // only acquired once the opening mode has settled on Edit, released when
  // the person flips to Summary, re-acquired on the way back. Opening a
  // record only learns who holds it; the lock itself is taken on the first
  // real edit (an approver re-opening what they sent back used to lock the
  // creator out of fixing it), and let go while the form is off screen.
  const lockEnabled =
    !designOn &&
    showLockBanner &&
    !isNew &&
    !!colMeta?.item_locking_enabled &&
    summaryModeSettled &&
    !readMode &&
    !editLockMessage
  // A background workspace tab (efp-new RecordSurfaceContext) counts as off screen.
  const surfaceActive = useRecordSurface().active
  const {
    lockHolder,
    acquired: lockAcquired,
    isReadOnly: lockReadOnly,
    takeOver,
    takingOver,
    requestLock,
    requesting,
    queue: lockQueue,
    myPosition: lockQueuePosition,
    joinQueue: joinLockQueue,
    leaveQueue: leaveLockQueue,
    joining: joiningLockQueue,
    myNote: lockNote,
    saveNote: saveLockNote,
    release: releaseLock,
    releasing: releasingLock,
    released: lockReleased,
    relock: relockLock,
    claim: claimLock
  } = useItemLock(collection, !isNew ? itemId : undefined, lockEnabled, {
    lazy: true,
    active: active && surfaceActive
  })
  const isReadOnly = lockReadOnly || !!recordGone || !!editLockMessage
  readOnlyRef.current = isReadOnly && !isNew
  // The step moved (this form's own transition, a live state change, another
  // tab): who may edit now is the server's call — re-read the edit-lock
  // verdict, so a record that just went into approval turns read-only (and
  // lets go of its edit lock) for the people it now refuses. Every path that
  // moves the step refreshes 'pipeline-instance'; only a changed state counts.
  useEffect(
    () =>
      qc.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'success') return
        const k = event.query.queryKey
        if (!Array.isArray(k) || k[0] !== 'pipeline-instance' || k[1] !== collection) return
        if (String(k[2]) !== String(itemId) || k.length > 3) return
        const next = (event.query.state.data as { instance?: { current_state?: string | null } })
          ?.instance?.current_state
        const cur = qc.getQueryData<{ instance?: { current_state?: string | null } | null }>([
          'pipeline-instance-lock',
          collection,
          itemId
        ])?.instance?.current_state
        if (next !== undefined && cur !== undefined && next !== cur)
          void qc.invalidateQueries({ queryKey: ['pipeline-instance-lock', collection, itemId] })
      }),
    [qc, collection, itemId]
  )
  relockOnEditRef.current =
    lockEnabled && !lockAcquired && !lockHolder
      ? () => void (lockReleased ? relockLock() : claimLock())
      : null
  // Grid rows, staged links and restored drafts never pass handleFieldChange:
  // unsaved work of any kind is edit intent too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lockEnabled re-fires the intent once the lock turns on
  useEffect(() => {
    if (hasUnsaved) relockOnEditRef.current?.()
  }, [hasUnsaved, lockEnabled])

  // ── Layout / groups ────────────────────────────────────────────────────────
  const assignments: SlotAssignment[] = activeLayoutData?.assignments ?? []

  // ── Lock condition data ────────────────────────────────────────────────────
  const hasLockConditions = assignments.some((a) => a.lock_conditions)

  const addendumEnabled = !!colMeta?.addendums_enabled && !isNew

  // Summary-mode rules decide the opening mode by role and/or state; the two
  // lookups below only run when something needs them (locks, addendums, or a
  // rule that mentions the dimension) — the old role-only default silently
  // never fired on collections with neither locks nor addendums.
  const summaryNeedsRole = !isNew && summaryRulesNeedRole(summaryRules)
  const summaryNeedsState = !isNew && summaryRulesNeedState(summaryRules)

  const fetchCurrentUserMe = () =>
    client.request<{ data: { role?: string | null } }>(get('/users/me')).then((r) => r.data ?? null)
  const roleLookupNeeded =
    hasLockConditions || addendumEnabled || summaryNeedsRole || behaviourNeeds.role
  const { data: currentUserData, isError: currentUserError } = useQuery<{
    role?: string | null
  } | null>({
    queryKey: ['current-user-me'],
    queryFn: fetchCurrentUserMe,
    staleTime: 5 * 60_000,
    enabled: roleLookupNeeded
  })
  // #2596: the exact rule behind a lock (and, for admins, what rules hide) —
  // fetched on the first hover of a locked field; admins with the form.
  const lockWhy = useLockWhy(collection, isNew ? null : itemId, {
    enabled: !designCtx,
    eager: isAdmin
  })

  // Layout editor "preview by state" (#2599): the chosen state stands in for
  // the record's own, so locks and summary rules evaluate for that step.
  const designStateKey = design?.stateKey ?? null
  const fetchPipelineInstanceLock = () =>
    client
      .request<{ data: unknown }>(get(`/pipelines/instance/${collection}/${itemId}`))
      .then(
        (r) =>
          r.data as {
            instance?: { current_state?: string | null } | null
            states?: Array<{ id: string; key: string; label?: string | null }>
          }
      )
      .catch(() => null)
  const stateLookupNeeded =
    hasLockConditions || addendumEnabled || summaryNeedsState || behaviourNeeds.state
  const { data: pipelineInstanceQueried, isError: pipelineInstanceError } = useQuery<{
    instance?: { current_state?: string | null } | null
    states?: Array<{ id: string; key: string; label?: string | null }>
  } | null>({
    queryKey: ['pipeline-instance-lock', collection, itemId],
    queryFn: fetchPipelineInstanceLock,
    staleTime: 30_000,
    enabled: stateLookupNeeded && !isNew && !designStateKey
  })
  // Record-page waterfall (#C5): both lookups above wait for the layout (and
  // the collection meta) to say they are needed. A collection whose last
  // opened record needed them gets them asked for at entry instead, beside
  // the layout read — same keys, so the queries above pick the answers up.
  const layoutKnown = activeLayoutData !== undefined
  useEffect(() => {
    if (!layoutKnown || designCtx) return
    rememberRecordLookups(collection, { role: roleLookupNeeded, state: stateLookupNeeded })
  }, [layoutKnown, designCtx, collection, roleLookupNeeded, stateLookupNeeded])
  // biome-ignore lint/correctness/useExhaustiveDependencies: entry only — once per record opened
  useEffect(() => {
    if (isNew || designCtx) return
    const want = recordLookupsFor(collection)
    if (!want) return
    if (want.state)
      void qc.prefetchQuery({
        queryKey: ['pipeline-instance-lock', collection, itemId],
        queryFn: fetchPipelineInstanceLock,
        staleTime: 30_000
      })
    if (want.role)
      void qc.prefetchQuery({
        queryKey: ['current-user-me'],
        queryFn: fetchCurrentUserMe,
        staleTime: 5 * 60_000
      })
  }, [collection, itemId])
  const pipelineInstanceData = useMemo(
    () =>
      designStateKey
        ? {
            instance: { current_state: '__design_state__' },
            states: [{ id: '__design_state__', key: designStateKey }]
          }
        : pipelineInstanceQueried,
    [designStateKey, pipelineInstanceQueried]
  )
  // #2703: what label rules and confirm-on-change read — the record's state and
  // the viewer's role (the previewed role under View as, the canvas's in the editor).
  const recordStateKey = useMemo(() => {
    const cur = pipelineInstanceData?.instance?.current_state ?? null
    return cur
      ? ((pipelineInstanceData?.states ?? []).find((st) => st.id === cur)?.key ?? null)
      : null
  }, [pipelineInstanceData])
  const placementTextCtx = useMemo(
    () => ({
      stateKey: recordStateKey,
      roleId: designOn
        ? (outerPlacementText?.roleId ?? null)
        : (viewAs.roleId ?? currentUserData?.role ?? null)
    }),
    [recordStateKey, designOn, outerPlacementText?.roleId, viewAs.roleId, currentUserData?.role]
  )

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
    /** Pipeline state when the addendum runs a workflow (server-attached). */
    workflow_state?: { key: string; label: string; color: string | null } | null
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
    const out: Array<{
      key: string
      collection: string
      rows: Record<string, unknown>[]
      addendum?: boolean
    }> = []
    // Addendum view: the addendum's PROPOSED child rows are the rollup's input
    // on every step, not only while the lines grid is mounted and publishing
    // them — otherwise the header read the stored (current) total everywhere
    // except the lines step. An entry that exists but is empty means the
    // addendum proposes no rows, so it contributes an empty set, not nothing.
    if (addendumViewId !== 'original') {
      const a = addendumData.find((x) => x.id === addendumViewId)
      for (const [alias, val] of Object.entries(a?.data ?? {})) {
        if (!Array.isArray(val)) continue
        const rel = (relations ?? []).find(
          (r) => r.one_collection === collection && r.one_field === alias && !r.junction_field
        )
        if (!rel?.many_collection || !rel.many_field) continue
        const key = `${rel.many_collection}.${rel.many_field}`
        if (!rollupFieldsByRelation.has(key)) continue
        out.push({
          key,
          collection: rel.many_collection,
          rows: val as Record<string, unknown>[],
          addendum: true
        })
      }
    }
    if (!isNew) return out
    for (const key of rollupFieldsByRelation.keys()) {
      if (liveRowsByRelation.has(key)) continue
      const rows = pendingO2MRows.get(key) ?? []
      if (rows.length === 0) continue
      out.push({ key, collection: key.split('.')[0], rows })
    }
    return out
  }, [
    isNew,
    rollupFieldsByRelation,
    liveRowsByRelation,
    pendingO2MRows,
    addendumViewId,
    addendumData,
    relations,
    collection
  ])
  const addendumRollupKeys = useMemo(
    () => new Set(stagedRollupRelations.filter((r) => r.addendum).map((r) => r.key)),
    [stagedRollupRelations]
  )

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

  // True while an addendum relation's child field config is still loading —
  // until then the live total cannot be computed, and showing the stored
  // (current-record) figure in its place read as the wrong number popping in.
  const addendumRollupLoading = stagedRollupRelations.some(
    (r, idx) => r.addendum && !stagedChildConfigs[idx]?.data
  )

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
    // The picker found the value valid again (re-picked, parent changed back):
    // the save-blocking error it caused goes with it.
    if (!stale)
      setValidationErrors((prev) => {
        if (prev[field] !== UNAVAILABLE_OPTION_ERROR) return prev
        const next = { ...prev }
        delete next[field]
        return next
      })
  }, [])
  // Whether a flagged value blocks the save: always on a new record; on an
  // existing one only when this session changed the value or one of its
  // cascade parents (a Region switched under the picked locations). A value
  // stored long ago that nobody touched keeps saving — an old record must
  // never get stuck on a field the person is not working on.
  const staleBlocksSave = (field: string): boolean => {
    if (isNew) return true
    if (!valuesEqual(draftRef.current[field], initialDataRef.current[field])) return true
    const fc = (fieldConfig ?? []).find((f) => f.field === field)
    return getCascadeFilters(fc?.dependency_config ?? null).some(
      (r) =>
        !!r.parent_field &&
        userTouchedRef.current.has(r.parent_field) &&
        !valuesEqual(draftRef.current[r.parent_field], initialDataRef.current[r.parent_field])
    )
  }

  const liveRollupValues = useMemo(() => {
    const out = new Map<string, number>()
    for (const f of fieldConfig ?? []) {
      if (f.computed_type !== 'rollup' || !f.computed_formula) continue
      // A parent the rollup does not apply to (a CAR's hand-entered
      // requisition amount) keeps its draft value — never the live sum.
      const parentFilter = parseRollupParentFilter(f.computed_formula)
      if (parentFilter && !matchesRollupFilter(draft, parentFilter)) continue
      const merged = new Map(liveRowsByRelation)
      // Addendum rows win over whatever a grid published — in addendum view
      // the grid publishes the same set, and when it is unmounted there is
      // nothing else to read.
      for (const [k, v] of stagedRowsByRelation)
        if (!merged.has(k) || addendumRollupKeys.has(k)) merged.set(k, v)
      const value = computeLiveRollup(parseRollupSources(f.computed_formula), merged)
      if (value !== null) out.set(f.field, value)
    }
    return out
  }, [fieldConfig, liveRowsByRelation, stagedRowsByRelation, addendumRollupKeys, draft])

  const effectiveDraft = useMemo(
    () => (addendumViewData ? { ...draft, ...addendumViewData } : draft),
    [draft, addendumViewData]
  )

  // While viewing an addendum, the pipeline panel operates on the ADDENDUM's
  // own workflow — switch back to Original and it acts on the record again.
  const viewingAddendum = addendumViewId !== 'original'
  const pipelineCollection = viewingAddendum ? 'nivaro_addendums' : collection
  const pipelineItem = viewingAddendum ? addendumViewId : itemId
  // Registry actions flagged for the header (Hold / Remove Hold), beside the
  // transitions; never on a new record. While an addendum is open they still act
  // on the record itself (Rob 2026-10-28: a record with an active addendum can be
  // put on hold), their guards read from the record, not the addendum's draft.
  const headerRegistryActions = useRecordHeaderActions(
    collection,
    isNew || designOn ? null : String(itemId),
    viewingAddendum ? null : draft
  )
  const [headerRegistryPick, setHeaderRegistryPick] = useState<AvailableBulkAction | null>(null)

  // A SETTLED addendum picked in the Viewing menu (approved / reverted /
  // imported): its lines come from the server snapshot — before → after —
  // since the live lines already are its "after" and data may be empty.
  const viewedAddendum = addendumData.find((a) => a.id === addendumViewId)
  const viewedSettled = !!viewedAddendum && ['approved', 'reverted'].includes(viewedAddendum.status)
  type AddendumLines = Record<
    string,
    {
      collection: string
      fk: string
      before: Record<string, unknown>[]
      after: Record<string, unknown>[]
    }
  >
  const { data: viewedAddendumLines } = useQuery<AddendumLines>({
    queryKey: ['addendum-lines', addendumViewId],
    queryFn: () =>
      client
        .request<{ data: AddendumLines }>(get(`/addendums/${addendumViewId}/lines`))
        .then((r) => r.data ?? {}),
    enabled: viewedSettled,
    staleTime: 60_000
  })

  const addendumO2MMap = useMemo<AddendumO2MMap>(() => {
    const map: AddendumO2MMap = {}
    if (viewedSettled && viewedAddendum && viewedAddendumLines) {
      for (const [alias, l] of Object.entries(viewedAddendumLines)) {
        map[alias] = [
          {
            addendumId: viewedAddendum.id,
            addendumTitle: viewedAddendum.title,
            addendumStatus: viewedAddendum.status,
            rows: l.after,
            baseRows: l.before
          }
        ]
      }
    }
    for (const a of addendumData) {
      if (['approved', 'rejected', 'reverted'].includes(a.status)) continue
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
  }, [addendumData, viewedSettled, viewedAddendum, viewedAddendumLines])

  // When a specific layout is requested by slug, only show fields explicitly
  // assigned to that layout — unassigned fields should not appear.
  const assignedFieldSet = useMemo<Set<string> | null>(() => {
    if (!layoutSlug || !activeLayoutData) return null
    return new Set(assignments.map((a) => a.field))
  }, [layoutSlug, activeLayoutData, assignments])

  // The plain fields a copied request selects: everything the form shows
  // that is a column, never an alias (a relation set is not a column).
  const copyAsFields = useMemo(
    () =>
      (fieldConfig ?? [])
        .filter(
          (f) =>
            !f.hidden &&
            !f.field.startsWith('__') &&
            !f.field.includes('.') &&
            !relations.some((r) => r.one_collection === collection && r.one_field === f.field)
        )
        .map((f) => f.field)
        .slice(0, 40),
    [fieldConfig, relations, collection]
  )
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
    const roleVisible = viewAs.active ? deduped.filter((f) => !viewAs.hidden.has(f.field)) : deduped
    if (!assignedFieldSet) return roleVisible
    return roleVisible.filter(
      (f) => assignedFieldSet.has(f.field) || SYSTEM_FIELDS.has(f.field) || isSentinelKey(f.field)
    )
  }, [fieldConfig, assignedFieldSet, layoutSlug, activeLayoutData, viewAs.active, viewAs.hidden])

  const groups = useMemo<FieldGroup[]>(() => {
    const all = activeLayoutData?.groups ?? []
    // Section names in the reader's language (#2665), never on the design canvas.
    const shown = designOn ? all : all.map((g) => translateGroup(g, formLocale()))
    return shown.sort((a, b) => a.sort - b.sort)
  }, [activeLayoutData, designOn])

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
    (g: { visible_when?: string | null }) => matchesVisibleWhen(g.visible_when, draft),
    [draft]
  )
  const tabGroups = useMemo(
    () =>
      groups.filter(
        (g) =>
          g.type === 'tab' &&
          !g.container_id &&
          (showHiddenDesign || stepVisible(g as { visible_when?: string | null }))
      ),
    [groups, stepVisible, showHiddenDesign]
  )
  // Tabs/steps kept only because the canvas shows hidden things.
  const designHiddenTabs = useMemo(
    () =>
      showHiddenDesign
        ? new Set(
            tabGroups
              .filter((g) => !stepVisible(g as { visible_when?: string | null }))
              .map((g) => g.key)
          )
        : undefined,
    [showHiddenDesign, tabGroups, stepVisible]
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
  // Entry ergonomics (#2702-#2728): the layout's entry config, and the beginner / expert
  // mode of an adaptive form (guided steps for a person's first records, tabs after).
  const entryCfg = useMemo(() => entryConfigOf(layoutMeta), [layoutMeta])
  const entryMode = useEntryMode({
    collection,
    layoutId: layoutMeta?.id ?? null,
    userId: authUserId,
    config: entryCfg,
    hasTabs: hasTabs || hasContainers,
    enabled: !designOn
  })
  const containerIsSteps = (c: { tab_mode?: string | null }) =>
    entryMode.mode && (c.tab_mode === 'steps' || c.tab_mode === 'tabs')
      ? entryMode.mode === 'beginner'
      : c.tab_mode === 'steps'
  const isStepsMode =
    hasTabs && (entryMode.mode ? entryMode.mode === 'beginner' : layoutMeta?.tab_mode === 'steps')
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
  // Design mode (layout editor): the rail eats canvas width, so its fold is
  // remembered per person. Normal record pages always start open.
  const [summaryCollapsed, setSummaryCollapsed] = useState(() =>
    designOn ? (readDesignSummaryCollapsed(authUserId) ?? false) : false
  )
  // Design mode, never chosen: fold the rail when the canvas is too narrow to
  // show the form beside it (a laptop with the editor's side panels open).
  const [railHost, setRailHost] = useState<HTMLDivElement | null>(null)
  const railAutoDecided = useRef(false)
  useEffect(() => {
    if (!designOn || !summaryEnabled || !railHost || railAutoDecided.current) return
    // Decided once, on the first real measurement (the body renders after the layout loads).
    const width = railHost.clientWidth
    if (!width) return
    railAutoDecided.current = true
    if (readDesignSummaryCollapsed(authUserId) !== null) return
    if (width - 256 < DESIGN_SUMMARY_MIN_CANVAS) setSummaryCollapsed(true)
  }, [designOn, summaryEnabled, railHost, authUserId])
  // Design mode: the canvas grows with the form and its scroller is an ancestor, so a long
  // summary rail used to stretch the whole row and leave blank canvas under the last section
  // ("scrolls past the bottom"). The rail instead sticks to the top of the canvas scroller,
  // capped at its visible height, and scrolls inside itself — as it does on the record page.
  const [railViewportH, setRailViewportH] = useState<number | null>(null)
  useEffect(() => {
    if (!designOn || !summaryEnabled || !railHost) {
      setRailViewportH(null)
      return
    }
    let scroller: HTMLElement | null = railHost.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement
    if (!scroller) return
    const target = scroller
    const measure = () => setRailViewportH(target.clientHeight || null)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(target)
    return () => ro.disconnect()
  }, [designOn, summaryEnabled, railHost])
  // Accordion mode: track the single open section group id (null = none open)
  const [openSectionId, setOpenSectionId] = useState<number | null>(null)
  const [swappedGroups, setSwappedGroups] = useState<Set<number>>(new Set())
  // #2698: tabs and steps whose "Show N more" was opened by hand.
  const [openFolds, setOpenFolds] = useState<Set<string>>(() => new Set())
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
    el.style.boxShadow =
      '0 0 0 2px rgb(var(--nvr-cyan-rgb, 0 206 255)), 0 0 0 5px rgb(var(--nvr-cyan-rgb, 0 206 255) / 0.25)'
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
  // Record tools a form can grant everyone (Form settings → Buttons & panels).
  const grantedTools = useMemo(() => {
    const g = layoutGrantedTools(activeLayoutData?.layout as LayoutGrantFlags | undefined, isAdmin)
    return showGrantedTools && !designOn ? g : { schedule: false, disablePickers: false }
  }, [activeLayoutData?.layout, isAdmin, showGrantedTools, designOn])
  const scheduleFields = useMemo(
    () =>
      allFields
        .filter((f) => !f.hidden && f.type !== 'alias')
        .map((f) => ({ field: f.field, label: f.label })),
    [allFields]
  )

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
      if (
        r.junction_field ||
        r.one_collection !== collection ||
        !r.many_collection ||
        !r.many_field
      )
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
  // Jump AND focus (#14): after the scroll/flash lands, put the caret in the
  // field's first focusable input so Enter/typing continues from there.
  const focusFieldInput = (key: string) => {
    const jumped = jumpToField(key)
    if (!jumped) return
    const tryFocus = (attempt: number) => {
      const el = document.querySelector<HTMLElement>(
        `[data-field="${key}"] input:not([type=hidden]), [data-field="${key}"] textarea, [data-field="${key}"] [role="combobox"], [data-field="${key}"] button`
      )
      if (el) {
        el.focus({ preventScroll: true })
        return
      }
      if (attempt < 10) setTimeout(() => tryFocus(attempt + 1), 150)
    }
    setTimeout(() => tryFocus(0), 200)
  }
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
        .filter((r) => r.many_collection === collection && !r.junction_field && r.many_field)
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
          readRow(target, String(id))
        ])
        const row = rowRes ?? {}
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
        lines.push(`${label}: ${toLocalDateString(str)}`)
        continue
      }
      lines.push(
        `${label}: ${str
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160)}`
      )
    }
    const heading =
      itemTitle && itemTitle !== (colMeta?.display_name ?? '')
        ? itemTitle
        : `${singularTitle} ${String(itemId ?? '')}`
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
  // `?row=<child collection>:<row id>` (a row-watch notification, an emailed
  // link): open the grid that holds the row and bring the line into view.
  const rowFocusDoneRef = useRef(false)
  const jumpToFieldRef = useRef<(key: string) => boolean>(() => false)
  jumpToFieldRef.current = jumpToField
  // Bring one child row into view and open it in its grid: switch to the
  // step the grid lives on, unfold a folded Summary section, then ask the
  // grid to open the row. Shared by `?row=` links and by in-form jumps
  // (window event 'nvr:record-focus' — a push-readiness issue, #616).
  const focusChildRowRef = useRef<
    (childCollection: string, rowId: string, eager?: boolean) => boolean
  >(() => false)
  focusChildRowRef.current = (childCollection: string, rowId: string, eager = false): boolean => {
    const rel = o2mRelations.find((r) => r.many_collection === childCollection)
    if (!rel?.one_field || !rel.many_field) return false
    const detail = { collection: childCollection, field: rel.many_field, rowId }
    // A record page paints over several seconds (mode, layout, grid rows) —
    // keep looking for the row until it exists, then act once.
    let tries = 0
    let jumped = false
    const find = () =>
      document.querySelector<HTMLElement>(`[data-o2m-row="${childCollection}:${rowId}"]`)
    const act = (rowEl: HTMLElement) => {
      // Summary mode keeps sections folded with their content mounted but
      // hidden — unfold the one that holds the row.
      if (rowEl.offsetParent === null)
        rowEl
          .closest('[data-read-section]')
          ?.querySelector<HTMLElement>('h3 button[aria-expanded="false"]')
          ?.click()
      window.setTimeout(
        () => window.dispatchEvent(new CustomEvent('nvr:grid-open-row', { detail })),
        250
      )
    }
    const now = find()
    if (now) {
      act(now)
      return true
    }
    if (eager) {
      jumped = true
      try {
        jumpToFieldRef.current(rel.one_field as string)
      } catch {
        /* not on a step */
      }
    }
    const tick = window.setInterval(() => {
      tries++
      const rowEl = find()
      if (!rowEl) {
        // The grid may sit on another step — ask for it once the form is up.
        // A link on page load waits for the form to paint (~2s); a jump the
        // person just asked for goes at once.
        if (!jumped && tries >= (eager ? 1 : 3)) {
          jumped = true
          try {
            jumpToFieldRef.current(rel.one_field as string)
          } catch {
            /* not on a step */
          }
        }
        if (tries > 40) window.clearInterval(tick)
        return
      }
      window.clearInterval(tick)
      act(rowEl)
    }, 600)
    return true
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs as the relation list settles
  useEffect(() => {
    if (rowFocusDoneRef.current || isNew || typeof window === 'undefined') return
    const raw = new URLSearchParams(window.location.search).get('row')
    if (!raw) return
    const cut = raw.indexOf(':')
    if (cut < 1) return
    // Not cleared on re-run: the relation list re-settles while the record
    // loads, so the one-shot guard only flips once a relation resolves.
    if (focusChildRowRef.current(raw.slice(0, cut), raw.slice(cut + 1)))
      rowFocusDoneRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o2mRelations, isNew])
  // #616 — "jump to the line / field" from anything outside the form's own
  // tree (the push-readiness chip, the Integrations dialog): window event
  // 'nvr:record-focus' {collection, item, field?, childCollection?, rowId?}.
  useEffect(() => {
    if (isNew || typeof window === 'undefined') return
    const onFocus = (e: Event) => {
      const d = (
        e as CustomEvent<{
          collection?: string
          item?: string
          field?: string
          childCollection?: string
          rowId?: string
        }>
      ).detail
      if (!d || d.collection !== collection || String(d.item ?? '') !== String(itemId)) return
      if (d.childCollection && d.rowId) {
        focusChildRowRef.current(d.childCollection, String(d.rowId), true)
        return
      }
      if (d.field) {
        try {
          jumpToFieldRef.current(d.field)
        } catch {
          /* field not on this layout */
        }
      }
    }
    window.addEventListener('nvr:record-focus', onFocus)
    return () => window.removeEventListener('nvr:record-focus', onFocus)
  }, [collection, itemId, isNew])
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
  // Sliding active-tab underline: measured off the active button so it
  // glides between tabs of different widths (and re-measures on resize).
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const [tabIndicator, setTabIndicator] = useState<{ left: number; width: number } | null>(null)
  useEffect(() => {
    const strip = tabStripRef.current
    if (!strip) return
    const measure = () => {
      const el = strip.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(activeTab)}"]`)
      if (!el) return setTabIndicator(null)
      setTabIndicator({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(strip)
    return () => ro?.disconnect()
  }, [activeTab])

  const setActiveTab = (k: string) => {
    setActiveTabRaw(k)
    setVisitedSteps((prev) => {
      if (prev.has(k)) return prev
      const next = new Set(prev)
      next.add(k)
      return next
    })
    // Design mode: switching tabs on the canvas leaves the record page's
    // remembered tab and the host's URL alone.
    if (designOn) {
      scrollBodyTop()
      return
    }
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
    scrollBodyTop()
  }
  // Follow me in a record-room huddle (#2855): this page names its tab, and a
  // follower's page switches tab when the presenter's does.
  useHuddleFollowSurface({
    collection,
    itemId: isNew || designOn || !documentTitle ? null : String(itemId),
    step: hasTabs ? activeTab : null,
    setStep: setActiveTab
  })
  // Form usage per layout (#2597/#2598): time per step, saves, abandoned new records.
  const formUsage = useFormUsageBeacon({
    enabled: !designOn,
    layoutId: layoutId != null ? Number(layoutId) : null,
    collection,
    itemId: isNew ? null : String(itemId),
    step: hasTabs ? activeTab : '__form__'
  })
  // Older engines and jsdom have no Element.scrollTo — a tab switch must
  // never throw over it.
  function scrollBodyTop() {
    const el = bodyRef.current
    if (typeof el?.scrollTo === 'function') el.scrollTo({ top: 0 })
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

  // Layout editor (#2620 #2621): Find, the outline and the inspector's
  // breadcrumb ask for a part of the form; the step or tab holding it opens
  // (sections open themselves, GroupSection). A group key, or null for the
  // Ungrouped zone.
  const revealInDesign = (key: string | null) => {
    if (key === null || key === '__ungrouped__') {
      if (isStepsMode && allSteps.some((st) => st.key === '__general__'))
        setActiveTab('__general__')
      return
    }
    const group = groups.find((g) => g.key === key)
    if (!group) return
    if (group.type === 'tab' && group.container_id != null) {
      const container = groups.find((g) => g.id === group.container_id)
      if (container) setContainerTab(container, key)
    } else if (group.type === 'tab' && allSteps.some((st) => st.key === key)) {
      if (activeTab !== key) setActiveTab(key)
    } else if (
      (group.type === 'section' || group.type === 'metadata') &&
      !isStepsMode &&
      allSteps.some((st) => st.key === '__general__') &&
      activeTab !== '__general__'
    ) {
      setActiveTab('__general__')
    }
  }
  const revealInDesignRef = useRef(revealInDesign)
  revealInDesignRef.current = revealInDesign
  const designReveal = designCtx?.reveal ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: one reveal per request (seq)
  useEffect(() => {
    if (designReveal) revealInDesignRef.current(revealGroupKey(designReveal.target))
  }, [designReveal?.seq])
  // Expand all (#2627): every step and tab laid out one under another.
  const designStackAll = designOn && !!designCtx?.fold?.open

  // Layout order: step by step (tabs first in their order, General's
  // sections where they sit), then the field's position inside its group;
  // anything the layout doesn't place falls back to registry order. The
  // 'Can't save yet' list and the jump after a failed save share it, so the
  // step that opens is the one holding issue 1.
  const fieldLayoutOrder = useMemo(() => {
    const order = new Map<string, number>()
    let pos = 0
    const stepKeys = hasTabs ? allSteps.map((st) => st.key) : []
    const groupKeys = [
      ...stepKeys.filter((k) => k !== '__general__'),
      ...Object.keys(groupedMap).filter((k) => !stepKeys.includes(k))
    ]
    for (const gk of groupKeys)
      for (const f of groupedMap[gk] ?? []) if (!order.has(f.field)) order.set(f.field, pos++)
    for (const f of allFields) if (!order.has(f.field)) order.set(f.field, pos++)
    return order
  }, [allFields, groupedMap, hasTabs, allSteps])
  const byLayoutOrder = (a: string, b: string) =>
    (fieldLayoutOrder.get(a) ?? 1e9) - (fieldLayoutOrder.get(b) ?? 1e9)

  // Rows for the 'Can't save yet' summary — form order, labelled, with the
  // step/tab/section the field lives on (steps layouts hide most fields).
  const validationSummaryItems = useMemo<ValidationSummaryItem[]>(() => {
    const keys = Object.keys(validationErrors)
    if (keys.length === 0) return []
    const locationFor = (field: string): string | null => {
      const groupKey = Object.entries(groupedMap).find(([, fs]) =>
        fs.some((f) => f.field === field)
      )?.[0]
      if (!groupKey) return hasTabs ? 'General' : null
      const group = groups.find((g) => g.key === groupKey)
      if (!group) return null
      if (group.type === 'tab') return group.label ?? null
      if (hasTabs && allSteps.some((st) => st.key === '__general__')) return 'General'
      return group.label ?? null
    }
    return keys
      .sort((a, b) => (fieldLayoutOrder.get(a) ?? 1e9) - (fieldLayoutOrder.get(b) ?? 1e9))
      .map((field) => {
        const meta = allFields.find((f) => f.field === field)
        const message = validationErrors[field]
        return {
          field,
          label: meta?.label || titleCase(field),
          message: message === 'This field is required' ? 'Required' : message,
          location: locationFor(field)
        }
      })
  }, [validationErrors, allFields, groupedMap, groups, hasTabs, allSteps, fieldLayoutOrder])

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
    for (const c of groups.filter((g) => g.type === 'container' && containerIsSteps(g))) {
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
  // Slot-level options ride the assignment's overrides JSON (same as __pdf__):
  // hide_actions_collapsed / hide_actions_expanded suppress the transition
  // buttons inside the slot when the header already shows them.
  const pipelineSlotOpts = useMemo<Record<string, unknown>>(() => {
    try {
      const ov = (pipelineSlot as unknown as { overrides?: unknown } | undefined)?.overrides
      const parsed = typeof ov === 'string' ? JSON.parse(ov) : ov
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }, [pipelineSlot])
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

  const handleGenerateAndAttach = async (opts?: {
    itemId?: string
    silent?: boolean
    /** Render the record AS AMENDED by this addendum (server overlays its
     *  proposed values + rows and recomputes rollups) — used right after an
     *  addendum is created, driven by the ADDENDUM layout's own PDF slot. */
    addendumId?: string
    attachField?: string
    sourceLayoutId?: number | null
    replaceGenerated?: boolean
    filenameTemplate?: string | null
  }) => {
    const targetItem = opts?.itemId ?? itemId
    const attachField = opts?.attachField ?? pdfAttachField
    // source_layout_id names a dedicated PDF (file-type) layout to render —
    // the document's design is rarely the edit form's design. Falls back to
    // the layout being edited.
    const renderLayoutId = opts?.sourceLayoutId ?? pdfSourceLayoutId ?? layoutId
    if (pdfAttaching || !attachField || !renderLayoutId || !targetItem) return
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
            attach_field: attachField,
            filename_template: opts?.filenameTemplate ?? pdfFilenameTemplate,
            replace_generated: opts?.replaceGenerated ?? pdfOverwrite,
            addendum_id: opts?.addendumId ?? undefined
          })
        }
      )
      if (!resp.ok) throw new Error(await resp.text())
      // An automatic regeneration is a side effect of saving, not its own
      // event — announcing it every time would be noise.
      if (!opts?.silent) toast.success('PDF generated and attached')
      // The file lands on this record (an addendum render may attach to the
      // addendum: refresh every list then).
      if (opts?.addendumId) qc.invalidateQueries({ queryKey: ['m2m-items'] })
      else invalidateM2MFor(qc, [targetItem])
      qc.invalidateQueries({ queryKey: ['items', collection, itemId] })
      if (opts?.addendumId) qc.invalidateQueries({ queryKey: ['addendums', collection, itemId] })
    } catch {
      // A failed regeneration must not read as a failed SAVE — the record is
      // already persisted at this point.
      if (opts?.silent) console.warn('[pdf] automatic regeneration failed')
      else toast.error('Failed to generate and attach PDF')
    } finally {
      setPdfAttaching(false)
    }
  }
  // A new addendum renders the AMENDED document when its own layout's PDF slot
  // says so (attach_to_field / source_layout_id / overwrite_generated) — the
  // record's PDF slot is not consulted: the record itself has not changed.
  const handleAddendumCreated = ({
    id,
    pdfSlot
  }: {
    id: string | null
    pdfSlot: Record<string, unknown> | null
  }) => {
    if (!id || !pdfSlot?.auto_generate_on_save) return
    const attachField = pdfSlot.attach_to_field as string | null | undefined
    if (!attachField) return
    void handleGenerateAndAttach({
      silent: true,
      addendumId: id,
      attachField,
      sourceLayoutId: (pdfSlot.source_layout_id as number | null | undefined) ?? null,
      replaceGenerated: pdfSlot.overwrite_generated !== false,
      filenameTemplate: (pdfSlot.filename_template as string | null | undefined) ?? null
    })
  }
  // Owners is a draggable field chip: when assigned to a group it renders inside
  // that group's card (footer slot); otherwise it renders as a standalone panel at
  // its own sort position alongside groups/ungrouped.
  const ownersGroupKey = ownersSlot?.group_key ?? null
  const ownersInGroup = !!(ownersGroupKey && groups.some((g) => g.key === ownersGroupKey))
  const renderOwnersPanel = () => (
    <OwnersSlot
      collection={pipelineCollection}
      item={pipelineItem}
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
  // "Edited 3d ago by <name>" — one activity row for the header chip.
  // #2450 — RecordLiveSync refreshes it on every write by someone else, so while the socket is
  // live the poll is only a 5-minute safety net.
  const lastTouchPoll = useLiveRefetchInterval(60_000, { enabled: !isNew })
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
    // The stale-record banner rides this read — one indexed row a minute without a live
    // socket, paused while the tab is hidden (react-query default).
    refetchInterval: lastTouchPoll
  })

  // Save-as-template dialog (#8) — styled, never a browser prompt.
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)
  // Request a change (#999) — a support ticket about this record.
  const [supportOpen, setSupportOpen] = useState(false)
  // Suggest a form change (#2609) — about the form, not this record's data.
  const [suggestOpen, setSuggestOpen] = useState(false)
  // The More (or folded tools) button the suggestion was picked from: its popover sits there.
  const [suggestAnchor, setSuggestAnchor] = useState<HTMLElement | null>(null)
  const [templateName, setTemplateName] = useState('')
  const [templateShared, setTemplateShared] = useState(false)
  const [templateSaving, setTemplateSaving] = useState(false)

  // Completeness meter (#59): filled ÷ visible-editable fields on this layout,
  // with required gaps called out. Display only — nothing blocks on it.
  // Judged against the CURRENTLY VIEWED layout's own assignments when one is
  // active — a field the open layout doesn't show must not count against the
  // percentage (2026-08-24).
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
      if (isDerivedForRecord(fc as { computed_type?: string | null }, draft)) return false
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
    // #2704: recommended fields are counted on their own, never as required.
    const recommended = fields.filter((f) => fieldIsRecommended(f))
    if (required.length === 0 && recommended.length === 0) return null
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
    const recommendedMissing = recommended.filter((f) => !isFilled(f))
    return {
      hasRequired: required.length > 0,
      pct: required.length ? Math.round((filled.length / required.length) * 100) : 100,
      filled: filled.length,
      total: required.length,
      requiredMissing: requiredMissing.map((f) => f.label ?? f.field),
      recommendedTotal: recommended.length,
      recommendedFilled: recommended.length - recommendedMissing.length,
      recommendedMissing: recommendedMissing.map((f) => f.label ?? f.field)
    }
  }, [
    fieldConfig,
    draft,
    m2mAliasFieldsForRules,
    m2mAliasFieldStates,
    activeLayoutData,
    o2mAliasFields,
    o2mEffectiveCounts
  ])

  // Provenance (#29): where the record came from — shown as a chip beside the
  // last-touched line.
  const { data: provenance } = useQuery({
    queryKey: ['provenance', collection, String(itemId)],
    queryFn: () =>
      client
        .request<{
          data: {
            origin: string
            timestamp: string
            user_name: string | null
            api?: {
              log_id: number
              method: string
              path: string
              auth: string
              api_key_name: string | null
              at: string
              chain_id: string | null
              body: unknown
              body_withheld?: boolean
            } | null
          } | null
        }>(get(`/provenance/${collection}/${encodeURIComponent(String(itemId))}`))
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
  lastTouchRef.current = lastTouch ?? null
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

  // Header summaries: inline-table fields carrying options.header_summary.
  const headerSummaries = useMemo(() => {
    const out: Array<{ field: string; config: HeaderSummaryConfig }> = []
    for (const f of fieldConfig ?? []) {
      const raw = (f as { options?: unknown }).options
      let opts: Record<string, unknown> | null = null
      try {
        opts =
          typeof raw === 'string'
            ? (JSON.parse(raw) as Record<string, unknown>)
            : ((raw as Record<string, unknown>) ?? null)
      } catch {
        opts = null
      }
      const hs = opts?.header_summary as HeaderSummaryConfig | undefined
      if (hs && typeof hs.formula === 'string' && typeof hs.label === 'string')
        out.push({ field: f.field, config: hs })
    }
    return out
  }, [fieldConfig])

  // Plain header fields (not rollups — those explain themselves): one
  // freshness read covers all of them.
  const headerTouchFields = useMemo(
    () =>
      (activeLayoutData?.assignments ?? [])
        .filter(
          (a) =>
            !a.field.startsWith('__') &&
            !a.field.includes('.') &&
            (a.group_key ?? null) === '__header__'
        )
        .map((a) => a.field),
    [activeLayoutData]
  )

  const headerFields = useMemo(() => {
    const fromLayout = (activeLayoutData?.assignments ?? [])
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
        let thresholds: Array<{ op: string; value: number; color: string }> | undefined
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
          // #5 — threshold rules: [{op: lt|lte|gt|gte|eq, value, color}] —
          // the first matching rule recolours the chip (Left to Forecast
          // reads red below zero, amber under 10%…).
          const thrRaw = parsed.find((b) => b.key === '__threshold__')?.binding_value
          if (thrRaw) {
            const t = JSON.parse(thrRaw)
            if (Array.isArray(t))
              thresholds = t.filter(
                (r) => r && typeof r === 'object' && typeof r.value === 'number' && r.color
              )
          }
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
          thresholds,
          cmsField: meta ?? null
        }
      })
    // Owners are ALWAYS in the header of a record with a workflow (Rob
    // 2026-10-26): a layout that shows the progress or owners slot but not an
    // owners header tile gets one, first. The tile is pinned (never folds).
    const hasWorkflow =
      showPipeline &&
      !isNew &&
      (activeLayoutData?.assignments ?? []).some(
        (a) =>
          (a.field === '__pipeline__' || a.field === '__owners__') &&
          !(a.is_visible === 0 || a.is_visible === false)
      )
    if (!hasWorkflow || fromLayout.some((f) => f.field === '__owners__')) return fromLayout
    const first = fromLayout.reduce((m, f) => Math.min(m, f.sort), 0)
    return [
      {
        field: '__owners__',
        label: 'Owners',
        sort: first - 1,
        displayFormat: 'text',
        color: undefined,
        weight: undefined,
        displayAs: undefined,
        linkTemplate: undefined,
        thresholds: undefined,
        cmsField: null
      },
      ...fromLayout
    ]
  }, [activeLayoutData, fieldConfig, showPipeline, isNew])

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
    const changedThisSession = (k: string) => !valuesEqual(draft[k], initialDataRef.current[k])
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
          if (n !== undefined && n === 0)
            errs[f.field] = `At least one ${f.label || titleCase(f.field)} item is required`
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
        ) as Array<{
          type: string
          value?: unknown
          field?: string
          message?: string
          soft?: boolean
        }>
        if (Array.isArray(rules)) {
          for (const rule of rules) {
            if (!rule || rule.soft) continue
            if (!ruleJudgedOnSave(rule, f.field, isNew, changedThisSession)) continue
            const err = applyValidationRule(
              rule,
              ruleValueFor(f.type, draft[f.field]),
              f.label ?? titleCase(f.field),
              draft
            )
            if (err) {
              errs[f.field] = err
              break
            }
          }
        }
      }
      // #2709: a placement's counter limit blocks the save once passed.
      if (!errs[f.field]) {
        const over = fieldCounterError(f, draft[f.field], f.label ?? titleCase(f.field))
        if (over) errs[f.field] = over
      }
      // Text past its column's limit: the server could only refuse the whole
      // save ("A value is too long for its field") without naming the field.
      if (!errs[f.field] && (isNew || changedThisSession(f.field))) {
        const over = columnLengthError(f, draft[f.field], f.label ?? titleCase(f.field))
        if (over) errs[f.field] = over
      }
      // A number the column cannot hold (1e308, a fraction in an integer
      // column, past the type's range) — FieldRenderer says so under the
      // input; this keeps it from being sent. A stored value nobody changed
      // never blocks.
      if (
        !errs[f.field] &&
        NUMBER_FIELD_TYPES.has(f.type) &&
        (isNew || !valuesEqual(draft[f.field], initialDataRef.current[f.field]))
      ) {
        const entry = checkNumberEntry(draft[f.field], {
          type: f.type,
          label: f.label || titleCase(f.field)
        })
        if (!entry.ok) errs[f.field] = entry.message
      }
      // A value its own picker flags "not an available option" (install /
      // shipping locations outside the Region picked after them) blocks like
      // a missing one — it used to save and come back as data-integrity
      // badges. The picker's verdict is the one the form already shows.
      if (!errs[f.field] && staleFields.has(f.field)) {
        const v = draft[f.field]
        if (v !== null && v !== undefined && v !== '' && staleBlocksSave(f.field))
          errs[f.field] = UNAVAILABLE_OPTION_ERROR
      }
    }
    if (Object.keys(errs).length > 0) {
      setValidationErrors(errs)
      setShowValidationSummary(true)
      // One problem: say exactly what it is. Several: the count — the summary
      // at the top of the form lists them and jumps to each. Layout order, so
      // the jump below lands on issue 1 of the summary, not a later step.
      const keys = Object.keys(errs).sort(byLayoutOrder)
      const n = keys.length
      if (n === 1) {
        const f = allFields.find((x) => x.field === keys[0])
        const label = f?.label || titleCase(keys[0])
        toast.error(
          errs[keys[0]] === 'This field is required' ? `${label} is required` : errs[keys[0]],
          { id: VALIDATION_TOAST_ID }
        )
      } else {
        // One toast id: pressing Create again replaces it, never stacks a copy.
        toast.error(`Can’t save yet — ${n} fields need attention`, { id: VALIDATION_TOAST_ID })
      }
      // Jump-to-error (#191): scroll + flash the first invalid field.
      const firstBad = keys[0]
      if (firstBad) setTimeout(() => focusFieldInput(firstBad), 150)
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
    const targets: Array<{
      collection: string
      changedFields: string[]
      rows?: Array<{ rowId: string; fields: string[] }>
    }> = []
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
      const rows: Array<{ rowId: string; fields: string[] }> = []
      for (const [rowId, ch] of edits.entries()) {
        // A staged edit that already carries its own reason (a carry-forward,
        // a reconcile, an applied proposal) needs no second justification.
        if (typeof ch._change_reason === 'string' && ch._change_reason.trim()) continue
        const fields = Object.keys(ch).filter((k) => !k.startsWith('__') && k !== '_change_reason')
        for (const k of fields) changed.add(k)
        if (fields.length) rows.push({ rowId: String(rowId), fields })
      }
      if (changed.size) targets.push({ collection: rc, changedFields: [...changed], rows })
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
                    context_fields?: string[]
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
            // Staged grid rows: name the row each change belongs to (the
            // config's context_fields — e.g. a budget row's Year) the way the server
            // does for a direct write, reading the rows off the grid's cache.
            // One row → context chips + "for Year 2027"; several rows → each
            // field carries its row: "May (2027), November (2026)".
            const ctxFields = (cfg.context_fields ?? []).filter(Boolean)
            if (ctxFields.length && t.rows?.length) {
              const cached = qc
                .getQueriesData<Array<Record<string, unknown>>>({
                  queryKey: ['o2m-rows', t.collection]
                })
                .flatMap(([, d]) => (Array.isArray(d) ? d : []))
              const ctxOf = (rowId: string) => {
                const row = cached.find((r) => String(r.id) === rowId)
                return row
                  ? ctxFields
                      .map((f) => ({ field: f, value: row[f] }))
                      .filter((c) => c.value != null && c.value !== '')
                  : []
              }
              const perRow = t.rows.map((r) => ({ ...r, ctx: ctxOf(r.rowId) }))
              const sigs = new Set(perRow.map((r) => JSON.stringify(r.ctx)))
              if (sigs.size === 1 && perRow[0].ctx.length) {
                return {
                  fields_changed: hit,
                  reasons: cfg.reasons ?? [],
                  allow_free_text: cfg.allow_free_text !== false,
                  context: perRow[0].ctx
                }
              }
              if (sigs.size > 1) {
                const fields_changed = perRow.flatMap((r) =>
                  r.fields
                    .filter((f) => cfg.fields!.includes(f))
                    .map((f) =>
                      r.ctx.length ? `${f} (${r.ctx.map((c) => String(c.value)).join(' ')})` : f
                    )
                )
                if (fields_changed.length)
                  return {
                    fields_changed,
                    reasons: cfg.reasons ?? [],
                    allow_free_text: cfg.allow_free_text !== false
                  }
              }
            }
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
  // Keyboard-first entry (#2707) and the layout's tab order (#2708).
  const entryRequired = useMemo(
    () =>
      new Set(
        allFields
          .filter(
            (f) =>
              f.required &&
              !f.hidden &&
              !f.readonly &&
              !SYSTEM_FIELDS.has(f.field) &&
              !isSentinelKey(f.field) &&
              (f as { layout_assigned?: boolean }).layout_assigned !== false
          )
          .map((f) => f.field)
      ),
    [allFields]
  )
  useEntryKeyboard({
    collection,
    config: entryCfg,
    enabled: !designOn && !readMode && !recordGone,
    ready: isNew || !!itemData,
    recordKey: `${collection}:${itemId ?? 'new'}`,
    required: entryRequired,
    draft: draft as Record<string, unknown>,
    save: () => handleSaveRef.current()
  })
  useEffect(() => {
    if (!registerSaveHandler) return
    registerSaveHandler(() => handleSaveRef.current())
    return () => registerSaveHandler(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref indirection keeps the handle stable
  }, [registerSaveHandler])
  // #2705: fields the layout marks "confirm and give a reason" that this save
  // changes on an existing record (in the record's current state). The reason
  // rides `_change_reason` like the collection-level requirement's.
  function layoutConfirmChallenge(): ChangeReasonChallenge | null {
    if (isNew || changeReasonRef.current) return null
    const changed = new Set(
      allFields
        .filter(
          (f) =>
            !SYSTEM_FIELDS.has(f.field) &&
            f.field in draft &&
            !valuesEqual(draft[f.field], initialDataRef.current[f.field])
        )
        .map((f) => f.field)
    )
    if (!changed.size) return null
    const hit = confirmChangeFields(allFields, changed, recordStateKey)
    return hit.length
      ? { fields_changed: hit, reasons: [], allow_free_text: true, confirm: true }
      : null
  }

  // #2704: recommended fields still empty — named on save, never blocking it.
  function nudgeRecommended() {
    const missing = missingRecommended(
      allFields,
      draft,
      (f) => visibleFields.size === 0 || visibleFields.has(f.field),
      (f) => placementFieldText(f, placementTextCtx).label || titleCase(f.field)
    )
    if (!missing.length) return
    toast.warning(
      missing.length === 1
        ? `${missing[0]} is recommended and still empty`
        : `${missing.length} recommended fields are still empty`,
      {
        description: `${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''} — saved anyway; fill ${missing.length === 1 ? 'it' : 'them'} in when you can.`
      }
    )
  }

  function handleSave() {
    if (recordGone) return
    // The header Save is disabled on a read-only record; the host's triggers
    // (workspace "Save all", the entry keyboard) are not — they land here.
    if (isReadOnly && !isNew) {
      toast.info(
        editLockMessage ??
          `${lockHolder?.locked_by_name ?? 'Someone else'} is editing this record — nothing was saved`
      )
      return
    }
    if (!validateAll()) return
    void (async () => {
      const collectionChallenge = await preflightChangeReason()
      const layoutChallenge = layoutConfirmChallenge()
      // One prompt: the collection's (its preset reasons) naming every field asked about.
      const challenge =
        collectionChallenge && layoutChallenge
          ? {
              ...collectionChallenge,
              fields_changed: [
                ...new Set([
                  ...collectionChallenge.fields_changed,
                  ...layoutChallenge.fields_changed
                ])
              ]
            }
          : (collectionChallenge ?? layoutChallenge)
      if (challenge) {
        setCrChallenge(challenge)
        return
      }
      nudgeRecommended()
      saveMut.mutate()
    })()
  }

  // ── Save / delete ──────────────────────────────────────────────────────────
  // A create's draft is spent from the moment it is sent: the unmount flush
  // must not write it back (Back pressed mid-save left it to be restored and
  // created a second time). Held again by the next edit after a success.
  const forgetSpentDraft = () => {
    draftSpentRef.current = true
    void deleteDraft(recoveryKey)
    if (authUserId) {
      serverDraftRef.current = false
      void client
        .request(del(`/drafts/${collection}/${isNew ? 'new' : String(itemId)}`))
        .catch(() => {})
    }
  }
  const saveMut = useMutation({
    mutationFn: async () => {
      if (isNew) draftSpentRef.current = true
      // Never raw JS error text on a save step: a code error reads as one plain
      // sentence and goes to the issue log (lib/safe-error.ts).
      function errMsg(err: unknown): string {
        reportCodeError(client, err)
        return userErrorMessage(err)
      }
      // What a save did that the steps alone do not say: the record landed but
      // its writer cannot see it (a User Scope hides it), or links it carried
      // did not land. Read by onSuccess for the closing message.
      saveNoticeRef.current = { hidden: null, linkProblems: [] }
      function noteWriteAnswer(r: WriteAnswer | null | undefined) {
        const meta = r?.meta
        if (!meta) return
        if (meta.readable === false) saveNoticeRef.current.hidden = { reason: meta.reason ?? null }
        if (Array.isArray(meta.link_failures))
          saveNoticeRef.current.linkProblems.push(...meta.link_failures.map(String))
      }
      // A change-reason 422 from any queued row PATCH pauses the save; the
      // dialog retries the whole mutation with the reason applied to every row.
      let flushChallenge: ChangeReasonChallenge | null = null

      // Staged M2M/M2A/file links ride in the record's own create/update body
      // (item-edit/staged-links.ts) — one write, so nothing after it can lose
      // them. Only keys the body cannot express stay for the follow-up step.
      const committedLinks = (key: string) => {
        const info = [...m2mAliasFieldsForRules.values()].find((i) => i.stagingKey === key)
        if (!info) return undefined
        return qc.getQueryData<Record<string, unknown>[]>([
          'm2m-items',
          info.manyCollection,
          info.manyField,
          itemId
        ])
      }
      const foldedLinkKeys = foldStagedLinks({
        collection,
        relations,
        links: m2mLinks,
        unlinks: m2mUnlinks,
        payload: {},
        isNew,
        committed: committedLinks
      })
      const followLinks = [...m2mLinks.entries()].filter(([k]) => !foldedLinkKeys.has(k))
      const followUnlinks = [...m2mUnlinks.entries()].filter(([k]) => !foldedLinkKeys.has(k))
      // Build step list from pending state
      const hasM2M =
        followLinks.some(([, ids]) => ids.length > 0) ||
        followUnlinks.some(([, ids]) => ids.size > 0)
      // A new record's staged child rows ride in its create body too (one
      // write: the server takes the record back out if a set fails). A set
      // that breaks its unique-by rule stays for the step, which names it.
      const rowBody: Record<string, unknown> = {}
      const foldedRowKeys = isNew
        ? foldStagedRows({
            collection,
            relations,
            rows: pendingO2MRows,
            payload: rowBody,
            skip: new Set(
              [...pendingO2MRows.entries()]
                .filter(([k, rows]) => {
                  const uniqueBy = o2mUniqueByMap.get(k)
                  if (!uniqueBy?.length) return false
                  const seen = new Set<string>()
                  return rows.some((r) => {
                    const uk = uniqueBy.map((f) => String(r[f] ?? '')).join('\x00')
                    if (seen.has(uk)) return true
                    seen.add(uk)
                    return false
                  })
                })
                .map(([k]) => k)
            )
          })
        : new Set<string>()
      const newO2MKeys = [...pendingO2MRows.entries()]
        .filter(([k, r]) => r.length > 0 && !foldedRowKeys.has(k))
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
      for (const [, ids] of followLinks) m2mAdds += ids.length
      for (const [, ids] of followUnlinks) m2mRemoves += ids.size
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
        }),
        ...(isNew && pendingTasks.length > 0
          ? [
              {
                id: 'tasks',
                label: 'Create tasks',
                status: 'pending' as SaveStepStatus,
                detail: `${pendingTasks.length} task${pendingTasks.length !== 1 ? 's' : ''}`,
                progress: { done: 0, total: pendingTasks.length }
              }
            ]
          : [])
      ]
      setSaveSteps(steps)
      remainingO2MRowsRef.current = new Map()
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
      // Layout default_values may name fields the layout does NOT show (the PUB
      // layout stamps workflow_type = CAR without a Type field). allFields is
      // the assigned set in slug mode, so those defaults were stamped on the
      // draft and then silently dropped here — the record saved with the
      // discriminator NULL and every CAR rule skipped it.
      if (isNew) {
        const defaults = activeLayoutData?.layout?.default_values as
          | Record<string, unknown>
          | null
          | undefined
        for (const key of Object.keys(defaults ?? {})) {
          if (key in payload || !(key in draftNow)) continue
          if (key.startsWith('__') || key.includes('.') || SYSTEM_FIELDS.has(key)) continue
          const v = draftNow[key]
          if (v === undefined || Array.isArray(v)) continue
          if (!(fieldConfig ?? []).some((f) => f.field === key)) continue
          payload[key] = v
        }
      }
      // Child rows folded above (create only), then every staged link the body
      // can carry (same keys as foldedLinkKeys).
      Object.assign(payload, rowBody)
      foldStagedLinks({
        collection,
        relations,
        links: m2mLinks,
        unlinks: m2mUnlinks,
        payload,
        isNew,
        committed: committedLinks
      })
      if (changeReasonRef.current) payload._change_reason = changeReasonRef.current
      if (!isNew) {
        const base = baseRevisionOverrideRef.current ?? baseRevisionData?.latest ?? null
        if (base != null) payload._base_revision = base
      }
      lastSavePayloadRef.current = payload
      let savedId: string
      try {
        if (isNew) {
          const r = await client.request<WriteAnswer>(post(`/items/${collection}`, payload))
          // The id comes from the answer even when the creator cannot read
          // the record back (data {id} + meta.readable false); an older server
          // answered data null — the record exists, but its id is unknown.
          const newId = r?.data?.id ?? r?.meta?.id
          noteWriteAnswer(r)
          if (newId == null) throw new CreatedOutOfViewError()
          savedId = String(newId)
        } else if (Object.keys(payload).some((k) => !k.startsWith('_'))) {
          const r = await client.request<WriteAnswer>(
            patch(`/items/${collection}/${itemId}`, payload)
          )
          noteWriteAnswer(r)
          savedId = itemId
        } else {
          // No field changes — skip the PATCH. `_change_reason` / `_base_revision`
          // alone are not a change: a reason collected for a LINE edit rode
          // along here and produced a no-op update on the record (activity row,
          // "was updated" watch email) while only a child row had moved.
          savedId = itemId
        }
        updateStep('main', { status: 'done' })
      } catch (err) {
        if (err instanceof CreatedOutOfViewError) {
          // Created — never offer the same Save again (that made a duplicate).
          updateStep('main', { status: 'done' })
          return ''
        }
        const challenge = changeReasonChallenge(err)
        if (challenge) {
          updateStep('main', { status: 'error', error: 'Waiting for a change reason' })
          setCrChallenge(challenge)
          throw err
        }
        // Either client error shape: the SDK puts the parsed body on
        // `err.response`, an axios-backed client under `err.response.data`.
        const coll = midairCollisionOf(err)
        if (coll) {
          updateStep('main', { status: 'error', error: 'Someone else changed this record' })
          const mine: Record<string, unknown> = {}
          for (const c of coll.conflicts) mine[c.field] = payload[c.field]
          setCollision({ conflicts: coll.conflicts, latest: coll.latest, mine })
          throw err
        }
        // No connection (#1678): keep the pressed Save in the outbox and send
        // it when the API answers again. Creates are never queued — a lost
        // answer may mean the record exists already.
        if (
          !isNew &&
          isOfflineSaveError(err) &&
          Object.keys(payload).some((k) => !k.startsWith('_'))
        ) {
          const before: Record<string, unknown> = {}
          for (const k of Object.keys(payload)) before[k] = initial[k] ?? null
          const entry = await enqueueRecordSave({
            collection,
            item: itemId,
            payload,
            before,
            baseRevision:
              typeof payload._base_revision === 'number' ? payload._base_revision : null,
            changeReason: changeReasonRef.current
          })
          if (entry) {
            const first = !outboxReleaseRef.current
            if (first) outboxReleaseRef.current = claimRecordOutbox(collection, itemId)
            for (const k of Object.keys(entry.payload)) outboxFieldsRef.current.add(k)
            updateStep('main', {
              status: 'error',
              error: 'No connection — will save when you are back online'
            })
            setSaveDialogOpen(false)
            if (first) toast.info('Will save when you are back online')
            throw err
          }
        }
        const msg = errMsg(err)
        updateStep('main', { status: 'error', error: msg, denied: isAccessRefusal(err) })
        // The refused field gets its error and the form moves to it — for a
        // child line ("workflow_lines[0]: Quantity can not be negative") that
        // is the lines grid, on whichever step holds it.
        const bad = refusedFieldOf(err, new Set(allFields.map((f) => f.field)))
        if (bad) {
          setValidationErrors({ [bad.field]: bad.message })
          setTimeout(() => jumpToField(bad.field), 150)
        }
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
          // Removals land BEFORE additions: replacing a link on a field that
          // holds one at most would otherwise ask for a second link while the
          // first still exists, and a server-side limit refuses that.
          const failed: string[] = []
          const note = (what: string) => (err: unknown) => {
            failed.push(`${what}: ${errMsg(err)}`)
          }
          const removals: Promise<unknown>[] = []
          for (const [key, ids] of followUnlinks) {
            if (!ids.size) continue
            const rel = findM2MRel(key)
            if (!rel) continue
            for (const jId of ids)
              removals.push(
                client
                  .request(del(`/items/${rel.many_collection}/${jId}`))
                  .catch(note('A link could not be removed'))
              )
          }
          await Promise.all(removals)
          const additions: Promise<unknown>[] = []
          for (const [key, ids] of followLinks) {
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
              additions.push(
                client
                  .request(
                    post(`/items/${rel.many_collection}`, {
                      [rel.many_field!]: savedId,
                      [rel.junction_field]: relId,
                      ...extra
                    })
                  )
                  .catch(note('A link could not be added'))
              )
          }
          await Promise.all(additions)
          if (failed.length > 0) {
            updateStep('m2m', { status: 'error', error: [...new Set(failed)].join(' · ') })
            saveNoticeRef.current.linkProblems.push(...new Set(failed))
          } else updateStep('m2m', { status: 'done' })
        } catch (err) {
          updateStep('m2m', { status: 'error', error: errMsg(err) })
          saveNoticeRef.current.linkProblems.push(errMsg(err))
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
      // Rows that did NOT land this pass, per relation — kept staged so a
      // retry re-posts only them (clearing everything would lose the unsaved
      // lines; keeping everything would duplicate the saved ones).
      remainingO2MRowsRef.current = new Map()
      const remainingO2MRows = remainingO2MRowsRef.current
      // ── Early edits ───────────────────────────────────────────────────────
      // A staged edit flagged `__flush_early` is the GIVING half of a move
      // between two rows (an amount carried from one row into another, or into
      // a row that does not exist yet). It lands before any new row and before
      // the other edits, so a cap over the rows' combined total never sees the
      // receiving half alone. A failure here is left for the normal pass below,
      // which retries it and reports it.
      const earlyDone = new Set<string>()
      for (const key of editO2MKeys) {
        const [rc] = key.split('.')
        for (const [rowId, changes] of pendingO2MEdits.get(key) ?? new Map()) {
          if (!changes.__flush_early) continue
          if (Object.keys(changes).some((k) => k.startsWith('__nested_ops_'))) continue
          const body = Object.fromEntries(
            Object.entries(changes as Record<string, unknown>).filter(([k]) => !k.startsWith('__'))
          )
          if (Object.keys(body).length === 0) continue
          if (changeReasonRef.current && !body._change_reason)
            body._change_reason = changeReasonRef.current
          const ok = await client
            .request(patch(`/items/${rc}/${rowId}`, body))
            .then(() => true)
            .catch(() => false)
          if (ok) earlyDone.add(`${key}:${rowId}`)
        }
      }

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
        // A human handle for a line in progress/failure messages: its order
        // number when the grid stamps one, else its position in the batch.
        const lineLabel = (data: Record<string, unknown>, idx: number) => {
          const n = data.line_number ?? data.sort ?? null
          const desc = ['item_description', 'description', 'name', 'title', 'label']
            .map((k) => data[k])
            .find((v) => typeof v === 'string' && v.trim() !== '') as string | undefined
          const head = `line ${n !== null && n !== undefined && n !== '' ? String(n) : idx + 1}`
          return desc ? `${head} · ${desc.length > 40 ? `${desc.slice(0, 40)}…` : desc}` : head
        }
        const failedLines: Array<{ label: string; error: string }> = []
        const remaining: Record<string, unknown>[] = []
        try {
          let nestedFailures = 0
          // SEQUENTIAL on purpose: the rows are POSTed in the order the user
          // built them, so their ids (and any order column the grid stamped)
          // ascend in that order — a parallel flush let the server's answer
          // order decide the line sequence.
          for (let rowIdx = 0; rowIdx < rowList.length; rowIdx++) {
            const data = rowList[rowIdx]
            updateStep(stepId, {
              detail: `Saving ${lineLabel(data, rowIdx)} (${rowIdx + 1} of ${rowList.length})`
            })
            // One failed line must not abort the rest: later lines still land
            // (in order), the failure is named, and only the failed line stays
            // staged for the retry.
            await (async () => {
              const o2mEntries = Object.entries(data).filter(([k]) => k.startsWith('__o2m_'))
              const cleanData = Object.fromEntries(
                Object.entries(data).filter(([k]) => !k.startsWith('__o2m_'))
              )
              let res: { data: { id: unknown } } | null = null
              try {
                res = await client.request<{ data: { id: unknown } }>(
                  post(`/items/${rc}`, {
                    ...cleanData,
                    [mf]: savedId,
                    // The record's change reason covers the lines it stages
                    // (a new child row on an existing record).
                    ...(changeReasonRef.current && !cleanData._change_reason
                      ? { _change_reason: changeReasonRef.current }
                      : {})
                  })
                )
              } catch (err) {
                const challenge = changeReasonChallenge(err)
                if (challenge) {
                  flushChallenge = challenge
                  failedLines.push({
                    label: lineLabel(data, rowIdx),
                    error: 'Waiting for a change reason'
                  })
                } else {
                  failedLines.push({ label: lineLabel(data, rowIdx), error: errMsg(err) })
                }
                remaining.push(data)
                return
              }
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
            })()
          }
          if (remaining.length > 0) remainingO2MRows.set(key, remaining)
          const problems: string[] = []
          if (failedLines.length > 0) {
            const landed = rowList.length - failedLines.length
            problems.push(
              `${failedLines.length} of ${rowList.length} line${rowList.length !== 1 ? 's' : ''} did not save` +
                (landed > 0 ? ` (${landed} saved)` : '') +
                ` — ${failedLines.map((f) => `${f.label}: ${f.error}`).join(' · ')}`
            )
          }
          if (nestedFailures > 0)
            problems.push(`${nestedFailures} nested row${nestedFailures !== 1 ? 's' : ''} failed`)
          if (problems.length > 0) saveNoticeRef.current.linkProblems.push(problems.join('. '))
          updateStep(
            stepId,
            problems.length > 0
              ? { status: 'error', detail: undefined, error: problems.join('. ') }
              : {
                  status: 'done',
                  detail: `${rowList.length} line${rowList.length !== 1 ? 's' : ''} saved`
                }
          )
        } catch (err) {
          // Only a failure OUTSIDE the per-line guard lands here (e.g. the
          // relation lookup) — nothing of this batch is known to have landed.
          remainingO2MRows.set(key, rowList)
          updateStep(stepId, { status: 'error', error: errMsg(err) })
          saveNoticeRef.current.linkProblems.push(errMsg(err))
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
              Object.entries(changes).filter(
                ([k]) => !k.startsWith('__nested_ops_') && k !== '__flush_early'
              )
            )
            let rowPatchFailed = false
            if (Object.keys(cleanChanges).length > 0 && !earlyDone.has(`${key}:${rowId}`)) {
              // The row's own reason (prefilled by the action that staged it)
              // beats the one collected for the save as a whole.
              if (changeReasonRef.current && !cleanChanges._change_reason)
                cleanChanges._change_reason = changeReasonRef.current
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
              // A matched drawer relation (#735) names its own collection and
              // its created rows carry their match seed — no FK to add.
              const many_collection = ops.collection ?? grandRel?.many_collection ?? null
              const many_field = ops.collection ? null : (grandRel?.many_field ?? null)
              if (!many_collection || (!ops.collection && !many_field)) {
                nestedFailures += ops.created.length + ops.updated.length + ops.deleted.length
                remainingChanges[opsKey] = ops
                continue
              }
              const failedCreated: Record<string, unknown>[] = []
              const failedUpdated: { id: string; changes: Record<string, unknown> }[] = []
              const failedDeleted: string[] = []
              await Promise.all(
                ops.created.map((draftRow) =>
                  client
                    .request(
                      post(
                        `/items/${many_collection}`,
                        many_field ? { ...draftRow, [many_field]: rowId } : draftRow
                      )
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
                  deleted: failedDeleted,
                  ...(ops.collection ? { collection: ops.collection } : {})
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
      // Every queued field rides along (#1004); a task that fails to create
      // is named on the save step and in a toast, never dropped silently.
      if (isNew && pendingTasks.length > 0) {
        updateStep('tasks', { status: 'running' })
        const failed: string[] = []
        for (const t of pendingTasks) {
          await client
            .request(
              post('/tasks', {
                collection,
                item: savedId,
                title: t.title,
                description: t.description || undefined,
                assignee: t.assignee || undefined,
                team_id: t.team_id ?? undefined,
                due_date: t.due_date || undefined,
                priority: t.priority || undefined
              })
            )
            .catch((err) => {
              failed.push(`“${t.title}”: ${errMsg(err)}`)
            })
          updateStep('tasks', (st) => ({
            progress: { done: (st.progress?.done ?? 0) + 1, total: pendingTasks.length }
          }))
        }
        if (failed.length) {
          const msg = `${failed.length} task${failed.length !== 1 ? 's' : ''} not created — ${failed.join('; ')}`
          updateStep('tasks', { status: 'error', error: msg })
          toast.error(msg)
        } else updateStep('tasks', { status: 'done' })
        invalidateRecordTasks(qc, collection, savedId)
      }

      return savedId
    },
    onSuccess: (id) => {
      // Runs even when the page was left mid-save (the hook's own callbacks
      // outlive the form): the draft — local AND server copy — goes now, and
      // a marker says what it became in case a copy survives anyway.
      if (isNew) {
        markDraftCreated(recoveryKey, id ? String(id) : '')
        forgetSpentDraft()
      }
      if (isNew && !id) {
        // Created, but an older server answered with no row and no id: the
        // record exists, so the form must not offer the same Save again.
        setIsDirty(false)
        setM2mLinks(new Map())
        setM2mUnlinks(new Map())
        setPendingO2MRows(new Map())
        setSaveDialogOpen(false)
        setCreatedOutOfView({ reason: saveNoticeRef.current.hidden?.reason ?? null })
        return
      }
      formUsage.markSaved()
      // Save ceremony (#318): the button morphs to a check and each field the
      // user actually touched gets a one-time glow sweep. Purely cosmetic —
      // read from userTouchedRef BEFORE the dirty state clears.
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 1600)
      ownSaveAtRef.current = Date.now()
      setRemoteChanges({})
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
          const res = (await client.request(get('/users', { limit: '500' }))) as {
            data?: Array<{ id: string; first_name?: string; last_name?: string }>
          }
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
      if (!isNew) {
        // The offline outbox: what this save carried (or the form had taken
        // over) is no longer pending.
        const settled = new Set(outboxFieldsRef.current)
        for (const k of Object.keys(lastSavePayloadRef.current))
          if (!k.startsWith('_')) settled.add(k)
        void settleRecordOutbox(collection, id, settled)
        releaseOutboxClaim()
        // A popped-out window (or another tab) showing this record refreshes:
        // the socket skips writes by the viewer themselves (#2131).
        announceRecordTabs(authUserId, 'saved', collection, id)
      }
      void qc.invalidateQueries({ queryKey: ['collision-base', collection] })
      setIsDirty(false)
      // The persisted recovery draft is spent — remove it now rather than on
      // the debounce, since a created record navigates away immediately.
      if (!isNew) void deleteDraft(recoveryKey)
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
      setPendingO2MRows(new Map(remainingO2MRowsRef.current))
      // Grandchild ops (a grid row's own relations) may have changed any row's
      // M2M list: refresh them all then; otherwise only this record's lists
      // and the rows this save edited refetch now (the rest are marked stale).
      const hadGrandchildOps = stagedRelsSigRef.current.size > 0
      // Staged grandchild ops just flushed — the widget registry must stop
      // reporting them (a grid unmounted on another tab can't re-report).
      stagedRelsSigRef.current.clear()
      setStagedRelsByGrid(new Map())
      qc.invalidateQueries({ queryKey: ['item', collection] })
      if (hadGrandchildOps) qc.invalidateQueries({ queryKey: ['m2m-items'] })
      else invalidateM2MFor(qc, [id, ...editedRowIds(pendingO2MEdits)])
      // Record Insights caches (audience, integrations, owner history, mail,
      // mentions) go stale the moment a save lands — refresh them so the
      // popover answers with current data.
      invalidateRecordInsights(qc, collection, String(id))
      // The header's "Edited … by …" names this save, not the one before it
      // (RecordLiveSync refreshes it only for other people's writes).
      void qc.invalidateQueries({ queryKey: ['last-touch', collection, String(id)] })
      // The Notes thread gains entries from the save itself (change reasons,
      // rule/hook writes, integration pushes) — some land seconds later.
      invalidateRecordNotes(qc, collection, String(id))
      // Refresh the attached document so it reflects what was just saved.
      // Fire-and-forget: the save is already committed and the record must not
      // appear to fail because a PDF could not be produced.
      if (pdfAutoGenerate && pdfAttachField) {
        // handleGenerateAndAttach refreshes the record's M2M lists itself.
        void handleGenerateAndAttach({ itemId: String(id), silent: true })
      }
      // The record was created from a document proposal: report which
      // proposed values were changed before Create (the corrections memory).
      if (isNew && autofillAppliedRef.current) {
        const a = autofillAppliedRef.current
        autofillAppliedRef.current = null
        const finals: Record<string, unknown> = {}
        for (const f of a.fields) finals[f] = draftRef.current[f]
        void client
          .request(
            post(`/ai/extract-record/${a.id}/outcome`, { record_id: String(id), values: finals })
          )
          .catch(() => {})
      }
      const notice = saveNoticeRef.current
      const noun = colMeta?.singular || titleCase(collection)
      // Auto-close dialog after brief success display
      setTimeout(() => {
        setSaveDialogOpen(false)
        const why = notice.hidden?.reason ? ` (${notice.hidden.reason})` : ''
        if (notice.hidden) {
          toast.warning(
            isNew
              ? `${noun} ${id} was created, but it’s outside what you can see${why}.`
              : `Saved, but this ${noun.toLowerCase()} is now outside what you can see${why}.`,
            { duration: 15_000 }
          )
        } else toast.success(isNew ? 'Record created' : 'Changes saved')
        if (notice.linkProblems.length > 0) {
          toast.error(
            `${isNew ? `${noun} ${id} was created` : 'Saved'}, but some parts did not save: ${[
              ...new Set(notice.linkProblems)
            ].join(' · ')}`,
            { duration: 20_000 }
          )
        }
        onSaved?.(id)
      }, 1200)
    },
    onError: (err) => {
      // Nothing was created: what is on the form is still the person's draft.
      if (isNew) draftSpentRef.current = false
      // The step moved under this form (or the rule changed): re-read who may
      // edit, so the form turns read-only with the server's reason.
      if (serverErrorCode(err) === 'EDIT_LOCKED')
        void qc.invalidateQueries({ queryKey: ['pipeline-instance-lock', collection, itemId] })
      // Dialog stays open showing error steps; user dismisses manually
    }
  })

  // In-app links (sidebar, breadcrumbs) asked first while there is unsaved
  // work — only reload used to warn. Browser Back cannot be held; the draft
  // flush on unmount keeps what was typed for the next open instead. Only the
  // record on screen asks (efp-new keeps background record tabs mounted).
  const formRootRef = useRef<HTMLDivElement | null>(null)
  const recordSurface = useRecordSurface()
  const [leaveAsk, setLeaveAsk] = useState<{ go: () => void } | null>(null)
  useLeaveLinkGuard(
    hasUnsaved && recordSurface.active && !designOn && !saveMut.isPending,
    (go) => setLeaveAsk({ go }),
    formRootRef
  )

  // ── Offline outbox (#1678) ────────────────────────────────────────────────
  // Back online with the entry held here: replay through the form's own save,
  // so a conflicting change opens the merge dialog below.
  // The save goes against the revision the queued change was made on — never
  // a base re-read after reconnecting, which would hide someone else's change.
  const outboxReplayRef = useRef<() => void>(() => {})
  outboxReplayRef.current = () => {
    if (!outboxReleaseRef.current || !isDirty || saveMut.isPending || collision || crChallenge)
      return
    const e = outboxEntry
    if (!e || e.base_revision != null) {
      if (e?.base_revision != null) baseRevisionOverrideRef.current = e.base_revision
      saveMut.mutate()
      return
    }
    // Made before the base was known: compare the fields themselves first.
    void checkUnknownBase(client, e)
      .then((check) => {
        if (check.conflicts.length > 0) {
          const mine: Record<string, unknown> = {}
          for (const c of check.conflicts) mine[c.field] = draftRef.current[c.field]
          setCollision({ conflicts: check.conflicts, latest: check.latest ?? 0, mine })
          return
        }
        if (check.latest != null) baseRevisionOverrideRef.current = check.latest
        saveMut.mutate()
      })
      .catch(() => {
        /* still unreachable — the outbox asks again */
      })
  }
  useEffect(() => onRecordOutboxRetry(() => outboxReplayRef.current()), [])
  // Replayed by the outbox while this form shows the record: the refresh
  // that follows is this person's own write, not "someone else changed it".
  useEffect(
    () =>
      onRecordOutboxEvent((e) => {
        if (
          e.type === 'replayed' &&
          e.entry.collection === collection &&
          e.entry.item === String(itemId)
        )
          ownSaveAtRef.current = Date.now()
      }),
    [collection, itemId]
  )
  /** Take the queued change into the form; a conflict opens the merge dialog. */
  const reviewOutbox = useCallback(() => {
    const e = outboxEntry
    if (!e) return
    if (!outboxReleaseRef.current) outboxReleaseRef.current = claimRecordOutbox(collection, itemId)
    for (const k of Object.keys(e.payload)) outboxFieldsRef.current.add(k)
    const next = { ...draftRef.current, ...e.payload }
    draftRef.current = next
    setDraft(next)
    for (const k of Object.keys(e.payload)) {
      userTouchedRef.current.add(k)
      fieldEditSeqRef.current.set(k, ++ruleSeqRef.current)
    }
    setIsDirty(true)
    if (e.change_reason) changeReasonRef.current = e.change_reason
    if (e.status === 'conflict' && e.conflicts?.length) {
      const mine: Record<string, unknown> = {}
      for (const c of e.conflicts) mine[c.field] = e.payload[c.field]
      setCollision({ conflicts: e.conflicts, latest: e.latest_revision ?? 0, mine })
    } else if (e.base_revision != null) baseRevisionOverrideRef.current = e.base_revision
  }, [outboxEntry, collection, itemId])
  // A conflict found while this record was closed opens the merge dialog the
  // first time the record is shown (once per conflict) — never mid-load,
  // or the first record read would replace the draft it fills.
  const outboxReviewedRef = useRef<string | null>(null)
  useEffect(() => {
    if (outboxEntry?.status !== 'conflict' || !itemData) return
    if (outboxReleaseRef.current || collision) return
    const mark = `${outboxEntry.id}@${outboxEntry.updated_at}`
    if (outboxReviewedRef.current === mark) return
    outboxReviewedRef.current = mark
    reviewOutbox()
  }, [outboxEntry, itemData, collision, reviewOutbox])
  // ── Pop out (#2131) ───────────────────────────────────────────────────────
  const inPopout = useMemo(() => isRecordPopout(), [])
  const popOutRecord = () => {
    const href = itemNav.urlFor({ collection, itemId: String(itemId), layoutSlug: layoutSlugProp })
    if (!openRecordPopout(href, collection, String(itemId)))
      toast.error('Your browser blocked the window — allow pop-ups for this site and try again')
  }
  const discardOutbox = useCallback(() => {
    void discardRecordOutbox(collection, itemId)
    releaseOutboxClaim()
  }, [collection, itemId, releaseOutboxClaim])

  // Every transition button on this form — the header buttons, the pipeline
  // panel in section/tab/steps mode and the __pipeline__ slot — runs this
  // first. One click means one action: validate, save what is on screen,
  // then transition. A transition that fails (a blocked partner push, a 422)
  // must never cost the person the values they had just entered: they are
  // on the record before the transition is attempted, and a reload shows them.
  const saveThenTransition = async (): Promise<boolean> => {
    if (!validateAll()) return false
    if (!isDirty) return true
    // #2705: a confirm-on-change field asks first; the move waits for that save.
    const confirmFirst = layoutConfirmChallenge()
    if (confirmFirst) {
      setCrChallenge(confirmFirst)
      return false
    }
    nudgeRecommended()
    try {
      await saveMut.mutateAsync()
      return true
    } catch {
      // The save reports its own failure; transitioning on top of unsaved
      // edits would apply the state change to values the record does not have.
      return false
    }
  }

  const deleteMut = useMutation({
    mutationFn: () => client.request(del(`/items/${collection}/${itemId}`)),
    onSuccess: () => {
      toast.success('Record deleted')
      qc.invalidateQueries({ queryKey: ['item', collection] })
      onDeleted?.()
    },
    onError: (err) =>
      toast.error(
        'Failed to delete',
        isAccessRefusal(err) && itemId
          ? {
              action: deniedToastAction(client, {
                collection,
                itemId: String(itemId),
                action: 'delete'
              })
            }
          : undefined
      )
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
  // Role preview (#8): fields the previewed role may read but not update.
  if (viewAs.active) for (const f of viewAs.readonly) lockedFields.add(f)
  // #25 — section-level locks: a group listing the viewer's role in
  // locked_for_roles renders every field it holds read-only (admins exempt;
  // the server drops those keys on update too).
  const sectionLocked = new Map<string, string>()
  {
    const myRole = currentUserData?.role ? String(currentUserData.role).toUpperCase() : null
    const isAdminRole = !!(currentUserData as { role_admin_access?: boolean } | null)
      ?.role_admin_access
    if (myRole && !isAdminRole) {
      for (const g of groups) {
        const raw = (g as { locked_for_roles?: string | null }).locked_for_roles
        if (!raw) continue
        try {
          const roles = JSON.parse(raw) as string[]
          if (!Array.isArray(roles) || !roles.some((r) => String(r).toUpperCase() === myRole))
            continue
        } catch {
          continue
        }
        for (const a of assignments) {
          if (a.group_key === g.key && !a.field.startsWith('__')) {
            lockedFields.add(a.field)
            sectionLocked.set(a.field, g.label || g.key)
          }
        }
      }
    }
  }

  // Why is this input read-only? (#7) — one sentence per locked/readonly
  // field, rendered on the lock glyph + the input's hover tip.
  const lockReasons: Record<string, string> = {}
  for (const [f, label] of sectionLocked)
    lockReasons[f] = `The "${label}" section is locked for your role`
  {
    const currentStateId = pipelineInstanceData?.instance?.current_state ?? null
    const currentState = currentStateId
      ? ((pipelineInstanceData?.states ?? []).find((s) => s.id === currentStateId) ?? null)
      : null
    // The step's own label ("Waiting on Level 1 Approval") — the title-cased
    // key named a state nobody sees anywhere else.
    const stateLabel = currentState
      ? currentState.label?.trim() || titleCase(currentState.key.replace(/_/g, ' '))
      : null
    for (const a of assignments) {
      if (!a.lock_conditions || !lockedFields.has(a.field)) continue
      try {
        const conds = JSON.parse(a.lock_conditions) as Array<{
          type: string
          state_keys?: string[]
          role_ids?: string[]
        }>
        if (conds.some((c) => c.type === 'pipeline_state' && c.state_keys?.length))
          lockReasons[a.field] = stateLabel
            ? `Locked while the record is in ${stateLabel}`
            : 'Locked by the record’s current state'
        else if (conds.some((c) => c.type === 'role')) lockReasons[a.field] = 'Locked for your role'
      } catch {
        /* malformed lock config — generic glyph */
      }
    }
    for (const f of fieldConfig ?? []) {
      const key = f.field
      if (lockReasons[key]) continue
      if (viewAs.active && viewAs.readonly.has(key)) {
        lockReasons[key] = `${viewAs.preview?.role.name ?? 'This role'} cannot edit this field`
        continue
      }
      if (editLockMessage) {
        lockReasons[key] = editLockMessage
        continue
      }
      if (isReadOnly) {
        lockReasons[key] =
          `${lockHolder?.locked_by_name ?? 'Someone else'} is editing this record — read-only until the lock is released`
        continue
      }
      if (viewingAddendum) {
        lockReasons[key] = 'Viewing an addendum — switch to the current record to edit'
        continue
      }
      if (!f.readonly) continue
      const ov = (f._overrides ?? null) as Record<string, unknown> | null
      if (f.computed_type === 'rollup')
        lockReasons[key] = 'Calculated from related rows — change the rows, not this total'
      else if (f.computed_type === 'write')
        lockReasons[key] = f.computed_formula
          ? `Calculated: ${f.computed_formula}`
          : 'Calculated on save from other fields'
      else if (f.interface === 'relation-path')
        lockReasons[key] = 'Value from a related record — edit it there'
      else if (ov?.readonly === true) lockReasons[key] = 'Read-only on this layout'
      else if (SYSTEM_FIELDS.has(key)) lockReasons[key] = 'Set by the system'
      else lockReasons[key] = 'Read-only field'
    }
  }
  const exactLockReasons = refineLockReasons(lockReasons, lockWhy.data)

  // Apply-to-lines (#5): a header/field assignment carrying
  // overrides.apply_to_lines {grid, target, label?} gets a button that copies
  // its value onto every row of that grid (the grid stages, rules re-derive).
  const applyToLines: Record<
    string,
    { label?: string; count?: number | null; onApply: (value: unknown) => void }
  > = {}
  for (const a of assignments) {
    const ov = (
      typeof a.overrides === 'string'
        ? parseJson<Record<string, unknown>>(a.overrides)
        : a.overrides
    ) as Record<string, unknown> | null
    const spec = ov?.apply_to_lines as
      | { grid?: string; target?: string; label?: string }
      | undefined
    if (!spec?.grid || !spec?.target) continue
    const grid = spec.grid
    const target = spec.target
    applyToLines[a.field] = {
      label: spec.label,
      count: grid in o2mEffectiveCounts ? o2mEffectiveCounts[grid] : null,
      onApply: (value) => {
        // The grid answers by stamping `handled` on the detail. When it is not
        // mounted (another step), jump to it and re-ask until it answers.
        const fire = () => {
          const detail = { collection, grid, target, value, handled: false }
          window.dispatchEvent(new CustomEvent('nvr:grid-apply-field', { detail }))
          return detail.handled
        }
        if (fire()) return
        jumpToField(grid)
        let tries = 0
        const tick = () => {
          if (fire() || ++tries >= 5) return
          window.setTimeout(tick, 350)
        }
        window.setTimeout(tick, 150)
      }
    }
  }
  // Rail diff dots (#17) + changes tray (#6) read the same breakdown.
  const labelOf = (k: string) =>
    (fieldConfig ?? []).find((f) => f.field === k)?.label || titleCase(k.replace(/_/g, ' '))
  // The collection a staged link points at, so the tray can print the linked
  // record's label instead of `#2026` — resolved through the junction's
  // companion leg like every other M2M reader.
  const m2mTargetOf = (k: string): string | null => {
    const field = stagingKeyToFieldRef.current.get(k) ?? k
    const rel = relations.find(
      (r) =>
        r.one_collection === collection &&
        (r.one_field === field || r.many_collection === field) &&
        r.junction_field != null
    )
    if (!rel) return null
    const other = relations.find(
      (r) =>
        r.many_collection === rel.many_collection &&
        r.many_field === rel.junction_field &&
        r.one_collection !== collection
    )
    return resolveM2MRelatedCollection(other)
  }
  const changedFieldMap: Record<string, { from: unknown; detail?: string }> = {}
  for (const k of unsavedSummary.fields) changedFieldMap[k] = { from: initialDataRef.current[k] }
  // M2M aliases never sit in the draft — their change is the staged link set.
  for (const [k, l] of m2mLinks)
    if (l.length) changedFieldMap[k] = { from: null, detail: `${l.length} linked` }
  for (const [k, u] of m2mUnlinks)
    if (u.size) {
      const prev = changedFieldMap[k]?.detail
      changedFieldMap[k] = {
        from: null,
        detail: prev ? `${prev}, ${u.size} unlinked` : `${u.size} unlinked`
      }
    }
  const changeItems: ChangeItem[] = []
  for (const k of unsavedSummary.fields)
    changeItems.push({
      key: `f:${k}`,
      kind: 'field',
      label: labelOf(k),
      collection,
      field: k,
      from: initialDataRef.current[k],
      to: draft[k],
      onRevert: () => undoTo(k, initialDataRef.current[k] ?? null),
      onJump: () => jumpToField(k)
    })
  const gridLabel = (rc: string) => titleCase(rc.replace(/_/g, ' '))
  for (const [key, rows] of pendingO2MRows) {
    const [rc, mf] = key.split('.')
    rows.forEach((r, idx) =>
      changeItems.push({
        key: `r:${key}:${idx}`,
        kind: 'row',
        label: gridLabel(rc),
        detail: `new line ${idx + 1}${r.line_number != null ? ` (#${String(r.line_number)})` : ''}`,
        onRevert: () => o2mStagingCtx.removeRow(rc, mf, idx)
      })
    )
  }
  for (const [key, edits] of pendingO2MEdits) {
    const [rc, mf] = key.split('.')
    // The grid's saved rows sit in the query cache — that is the "from" side
    // of every staged cell (#4). Either cache shape the grid has used.
    // The grid's key carries more segments (filter, layout) — prefix-match.
    const cachedEntry = qc
      .getQueriesData<unknown>({ queryKey: ['o2m-rows', rc, mf, String(itemId)] })
      .find(([, d]) => Array.isArray(d) && (d as unknown[]).length > 0)
    const savedRows = (cachedEntry?.[1] as Array<Record<string, unknown>> | undefined) ?? []
    for (const [rowId, ch] of edits) {
      const saved = savedRows.find((r) => String(r.id) === String(rowId))
      const cellKeys = Object.keys(ch).filter((c) => !c.startsWith('__'))
      const lineNo =
        saved?.line_number != null ? `line ${String(saved.line_number)}` : `row ${rowId}`
      changeItems.push({
        key: `e:${key}:${rowId}`,
        kind: 'edit',
        label: gridLabel(rc),
        collection: rc,
        detail: `${lineNo}: ${cellKeys.map((c) => titleCase(c.replace(/_/g, ' '))).join(', ')}`,
        onRevert: () => o2mStagingCtx.cancelPendingEdit(rc, mf, rowId),
        cells: cellKeys.map((c) => ({
          field: c,
          label: titleCase(c.replace(/_/g, ' ')),
          from: saved ? saved[c] : undefined,
          to: (ch as Record<string, unknown>)[c],
          onRevert: () =>
            setPendingO2MEdits((prev) => {
              const next = new Map(prev)
              const rowsMap = new Map(next.get(key))
              const patch = { ...(rowsMap.get(rowId) ?? {}) } as Record<string, unknown>
              delete patch[c]
              if (Object.keys(patch).filter((k) => !k.startsWith('__')).length === 0)
                rowsMap.delete(rowId)
              else rowsMap.set(rowId, patch)
              if (rowsMap.size === 0) next.delete(key)
              else next.set(key, rowsMap)
              return next
            })
        }))
      })
    }
  }
  for (const [key, dels] of pendingO2MDeletes) {
    const [rc, mf] = key.split('.')
    for (const rowId of dels)
      changeItems.push({
        key: `d:${key}:${rowId}`,
        kind: 'delete',
        label: gridLabel(rc),
        detail: `row ${rowId}`,
        onRevert: () => o2mStagingCtx.cancelPendingDelete(rc, mf, rowId)
      })
  }
  for (const [key, ids] of m2mLinks)
    for (const id of ids)
      changeItems.push({
        key: `l:${key}:${String(id)}`,
        kind: 'link',
        label: labelOf(key),
        detail: `+ #${String(id)}`,
        linkTarget: (() => {
          const c = m2mTargetOf(key)
          return c ? { collection: c, id } : undefined
        })(),
        onRevert: () => m2mStagingCtx.unstageLink(key, id)
      })
  for (const [key, ids] of m2mUnlinks)
    for (const id of ids)
      changeItems.push({
        key: `u:${key}:${String(id)}`,
        kind: 'unlink',
        label: labelOf(key),
        detail: `− junction #${String(id)}`,
        onRevert: () => m2mStagingCtx.unstageUnlink(key, id)
      })

  // Opening mode (#2): resolved ONCE per record from the collection's
  // summary_mode_rules against the viewer's role and the record's pipeline
  // state — after both lookups the rules need have answered, so a state rule
  // never judges an unloaded state as "no state". The toggle flips it for this
  // mount only (never stored).
  const summaryResolvedFor = useRef<string | null>(null)
  useEffect(() => {
    const key = summaryRecordKey
    if (summaryResolvedFor.current === key || isNew || !summaryRules || designOn) return
    if (summaryNeedsRole && currentUserData === undefined && !currentUserError) return
    if (summaryNeedsState && pipelineInstanceData === undefined && !pipelineInstanceError) return
    // A rule on the record's own values (#737) waits for the record.
    if (summaryRulesNeedRecord(summaryRules) && itemData === undefined && !itemLoadError) return
    const stateId = pipelineInstanceData?.instance?.current_state ?? null
    const stateKey = pipelineInstanceData?.states?.find((s) => s.id === stateId)?.key ?? null
    summaryResolvedFor.current = key
    const mode = resolveSummaryMode(summaryRules, {
      role: currentUserData?.role ? String(currentUserData.role) : null,
      stateKey,
      isNew,
      record: itemData ?? null
    })
    if (mode === 'summary') setReadModeRaw(true)
    setSummaryResolvedKey(key)
  }, [
    summaryRecordKey,
    designOn,
    isNew,
    summaryRules,
    summaryNeedsRole,
    summaryNeedsState,
    currentUserData,
    currentUserError,
    pipelineInstanceData,
    pipelineInstanceError,
    itemData,
    itemLoadError
  ])
  // Summary mode collapses the right-hand rail by default — the read
  // view is the summary; the rail would repeat it. Restore whatever the rail
  // was doing when the person switches back to Edit.
  const railBeforeSummary = useRef<boolean | null>(null)
  useEffect(() => {
    if (readMode) {
      if (railBeforeSummary.current === null) railBeforeSummary.current = summaryCollapsed
      setSummaryCollapsed(true)
    } else if (railBeforeSummary.current !== null) {
      setSummaryCollapsed(railBeforeSummary.current)
      railBeforeSummary.current = null
    }
    // summaryCollapsed deliberately not a dep — this reacts to the MODE flip only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readMode])
  // Rail dots revert (#9): the same handlers the changes popover uses.
  const revertByField: Record<string, () => void> = {}
  for (const it of changeItems) {
    if (it.kind === 'field') revertByField[it.key.slice(2)] = it.onRevert
    else if (it.kind === 'link' || it.kind === 'unlink') {
      const k = it.key.split(':')[1]
      const prev = revertByField[k]
      revertByField[k] = prev
        ? () => {
            prev()
            it.onRevert()
          }
        : it.onRevert
    }
  }
  const fieldAffordancesRaw = {
    remoteChanges,
    dismissRemoteChange: (field: string) =>
      setRemoteChanges((cur) => {
        if (!(field in cur)) return cur
        const next = { ...cur }
        delete next[field]
        return next
      }),
    takeRemoteChange: (field: string) => {
      const ch = remoteChanges[field]
      if (!ch?.conflict) return
      undoTo(field, ch.theirs ?? null)
      setRemoteChanges((cur) => {
        const next = { ...cur }
        delete next[field]
        return next
      })
      // The last conflict taken: the newer value is what the form holds now,
      // so the collision baseline may move up to it.
      if (!Object.entries(remoteChanges).some(([k, c]) => k !== field && c.conflict))
        void qc.invalidateQueries({ queryKey: ['collision-base', collection, itemId] })
    },
    lockReasons: exactLockReasons,
    onLockHover: lockWhy.want,
    applyToLines,
    openRelated: (c: string, id: string) => itemNav.open({ collection: c, itemId: id }),
    layoutId: layoutMeta?.id ?? null,
    // #2726: designers trying pickers on the canvas are not people searching.
    pickerMisses: !designOn,
    fromAutofill,
    glossaryHelp: entryCfg.glossary !== false,
    placementText: placementTextCtx
  }
  // The same context object while nothing a field reads changed — a fresh
  // object here re-rendered every (memoized) field row on every form render.
  const fieldAffordances = useStableFieldAffordances(fieldAffordancesRaw)
  // One object per draft / label / filter change: an inline literal re-rendered
  // every consumer (each field row and picker) on every form render.
  // dirtyFields is the live Set; its writes always come with a draft change.
  const parentDraftCtxValue = useMemo(
    () => ({
      draft: parentDraftWithAliases,
      collection,
      dirtyFields: userTouchedRef.current,
      fieldLabels: parentFieldLabels,
      fieldOptionFilters: parentFieldOptionFilters
    }),
    [parentDraftWithAliases, collection, parentFieldLabels, parentFieldOptionFilters]
  )

  // ── Design mode shells ─────────────────────────────────────────────────────
  // Every placement/group gets a selectable DesignNode in the layout editor's
  // canvas; without `design` each helper hands its node back untouched.
  const dwrap = (
    t: DesignTarget,
    node: ReactNode,
    opts?: { asChild?: boolean; pass?: boolean; inline?: boolean }
  ) => designWrap(designCtx, t, node, opts)
  const dwrapEl = (t: DesignTarget, el: ReactElement, opts?: { asChild?: boolean }) =>
    dwrap(t, el, opts) as ReactElement
  // A slot placed in two groups (legacy widget twins) is two targets: pass the
  // placement's group when it is known, else its first placement's.
  const slotTarget = (field: string, groupKey?: string | null): DesignTarget => ({
    kind: 'slot',
    field,
    group_key:
      groupKey !== undefined
        ? groupKey
        : (assignments.find((a) => a.field === field)?.group_key ?? null)
  })
  const designHidden = (f: CMSField, ruleVisible = true) =>
    showHiddenDesign && (f.hidden || !ruleVisible)
  const faint = (hidden: boolean, node: ReactNode) =>
    hidden ? (
      <div data-design-hidden='' className='opacity-40'>
        {node}
      </div>
    ) : (
      node
    )
  const fieldTarget = (f: CMSField): DesignTarget => ({
    // A display formula is a `__calc_<n>__` placement — the editor's slot kind (#2712).
    kind: isDisplayFormulaRow(f) ? 'slot' : 'field',
    field: f.field,
    group_key: f.group_key ?? null
  })
  // Section-mode rows: the row div becomes the shell of whatever it holds.
  // The ungrouped zone shells itself (renderUngrouped is also used by tabs).
  // #2699: the form's one sticky section stays at the top while the rest scrolls
  // (section mode, from tablet widths up; hosts with a fixed bar set --nvr-sticky-top).
  const sectionShell = (
    item: FieldGroup | string,
    key: string | number,
    stickyKey?: string | null
  ) => {
    const content = renderSectionItem(item)
    const sticky =
      !designOn && content != null && typeof item !== 'string' && item.key === stickyKey
    const el = (
      <div
        key={key}
        data-form-sticky={sticky ? '' : undefined}
        className={sticky ? 'md:sticky md:top-[var(--nvr-sticky-top,0px)] md:z-20' : undefined}
      >
        {content}
      </div>
    )
    if (content == null || item === '__ungrouped__') return el
    return dwrap(
      typeof item === 'string' ? slotTarget(item) : { kind: 'group', key: item.key },
      el,
      { asChild: true }
    )
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
          hideActionsCollapsed={!!pipelineSlotOpts.hide_actions_collapsed}
          hideActionsExpanded={!!pipelineSlotOpts.hide_actions_expanded}
          onBeforeTransition={saveThenTransition}
          asRole={viewAs.roleId}
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
          onRemoveQueuedTask={isNew ? handleRemoveQueuedTask : undefined}
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
          onCreated={handleAddendumCreated}
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
    const visible = showHiddenDesign
      ? allFields.filter(
          (f) =>
            !f.group_key &&
            !SYSTEM_FIELDS.has(f.field) &&
            !isSentinelKey(f.field) &&
            (layoutId === null || f.layout_assigned !== false)
        )
      : ungroupedFields.filter((f) => !f.hidden)
    if (visible.length === 0) return null
    return dwrap(
      { kind: 'group', key: '__ungrouped__' },
      <div
        key='__ungrouped__'
        className='nvr-section-enter rounded-xl border border-slate-200 bg-white px-5 py-5'
      >
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
              return dwrap(
                fieldTarget(f),
                <div key={f.field} style={{ gridColumn: `span ${resolveColSpan(f.options, cw)}` }}>
                  {faint(
                    designHidden(f),
                    <FieldRow
                      field={f}
                      draft={effectiveDraft}
                      onChange={handleFieldChange}
                      relations={relations}
                      collection={collection}
                      itemId={itemId}
                      error={validationErrors[f.field]}
                      autoFillTick={autoFillTicks[f.field]}
                      visible={true}
                      forceVisible={designHidden(f) || undefined}
                      locked={isReadOnly || addendumViewId !== 'original'}
                      layoutAiEnabled={layoutAiEnabled}
                      renderField={renderField}
                      onCountChange={handleM2MCountChange}
                    />
                  )}
                  {inlineEntries?.length && hasVal && inlineRelCollection && (
                    <InlineDisplay
                      relCollection={inlineRelCollection}
                      relId={rawVal as string | number}
                      entries={inlineEntries}
                      separator={inlineSeparator}
                    />
                  )}
                </div>,
                { asChild: true }
              )
            })
          }
        </GridContainer>
      </div>,
      { asChild: true }
    )
  }

  /** Expand all (layout editor): the name over each step or tab laid out in turn. */
  function stackedPaneLabel(key: string, label: string) {
    const selectable = key !== '__general__'
    return (
      <button
        type='button'
        data-design-pass=''
        data-design-stacked={key}
        disabled={!selectable}
        onClick={() => selectable && designCtx?.onSelect({ kind: 'group', key })}
        className='block px-1 text-left text-[12px] font-semibold text-slate-500 enabled:hover:text-slate-800 dark:text-muted-foreground dark:enabled:hover:text-foreground'
      >
        {label}
      </button>
    )
  }

  function renderContainer(c: FieldGroup, onlyKey?: string): ReactNode {
    const children = groups
      .filter((g) => g.type === 'tab' && g.container_id === c.id)
      .sort((a, b) => a.sort - b.sort)
    if (children.length === 0) return null
    // Expand all (layout editor): the holder once per tab, each showing its own.
    if (designStackAll && onlyKey === undefined)
      return (
        <div key={c.key} className='space-y-3'>
          {children.map((ch) => (
            <Fragment key={ch.key}>{renderContainer(c, ch.key)}</Fragment>
          ))}
        </div>
      )
    const isSteps = containerIsSteps(c)
    const activeKey = onlyKey ?? getContainerTab(c, children)
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
    const activeFields = (groupedMap[activeChild?.key ?? ''] ?? []).filter(
      (f) => showHiddenDesign || !f.hidden
    )
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
      <div key={c.key} className='nvr-section-enter rounded-xl border border-slate-200 bg-white'>
        {/* Expand all: the strip once (its tabs are the selectable, draggable
            ones), then each later tab under its name. */}
        {onlyKey !== undefined && onlyKey !== children[0]?.key ? (
          <div className='border-b border-slate-100 px-4 pt-3 pb-2'>
            {stackedPaneLabel(onlyKey, activeChild?.label ?? onlyKey)}
          </div>
        ) : isSteps ? (
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
            {children.map((g) =>
              dwrap(
                { kind: 'group', key: g.key },
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
                </button>,
                { asChild: true, pass: true }
              )
            )}
          </div>
        )}
        <div className='px-5 py-5'>
          {activeChild && <SectionIntro group={activeChild} className='mb-4' />}
          {designOn && activeChild && <DesignDropBody groupKey={activeChild.key} />}
          {(() => {
            const renderActiveField = (f: CMSField, cw: number): ReactNode => {
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
                              autoFillTick={autoFillTicks[af.field]}
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
              return dwrap(
                fieldTarget(f),
                <div key={f.field} style={{ gridColumn: `span ${resolveColSpan(f.options, cw)}` }}>
                  {faint(
                    designHidden(f, visibleFields.has(f.field) || !visibleFields.size),
                    <FieldRow
                      field={f}
                      draft={effectiveDraft}
                      onChange={handleFieldChange}
                      relations={relations}
                      collection={collection}
                      itemId={itemId}
                      error={validationErrors[f.field]}
                      autoFillTick={autoFillTicks[f.field]}
                      visible={visibleFields.has(f.field) || !visibleFields.size}
                      forceVisible={
                        designHidden(f, visibleFields.has(f.field) || !visibleFields.size) ||
                        undefined
                      }
                      locked={lockedFields.has(f.field) || addendumViewId !== 'original'}
                      layoutAiEnabled={layoutAiEnabled}
                      renderField={renderField}
                      onCountChange={handleM2MCountChange}
                      swapButton={swapToggleBtn}
                      swapContent={swapContentNode}
                    />
                  )}
                  {inlineEntries?.length && hasVal && inlineRelCollection && (
                    <InlineDisplay
                      relCollection={inlineRelCollection}
                      relId={rawVal as string | number}
                      entries={inlineEntries}
                      separator={inlineSeparator}
                    />
                  )}
                </div>,
                { asChild: true }
              )
            }
            const plan = structurePlan(activeChild, activeFields)
            return (
              <>
                <GridContainer>
                  {(cw) =>
                    plan.units.map((u) =>
                      u.kind === 'row'
                        ? renderRowCell(u.row, u.members, cw, activeChild?.key ?? null)
                        : renderActiveField(u.field, cw)
                    )
                  }
                </GridContainer>
                {renderFold(activeChild?.key ?? c.key, plan, () => (
                  <GridContainer>
                    {(cw) => plan.folded.map((f) => renderActiveField(f, cw))}
                  </GridContainer>
                ))}
              </>
            )
          })()}
          {designOn &&
            activeFields.length === 0 &&
            !pdfInContainer &&
            !widgetSlots.some((ws) => (ws.group_key ?? null) === activeChild.key) && (
              <DesignDropZone />
            )}
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
              return dwrap(
                slotTarget(ws.field, ws.group_key ?? null),
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
                </div>,
                { asChild: true }
              )
            })}
          {pdfInContainer &&
            dwrap(
              slotTarget('__pdf__'),
              <div className='mt-4 flex items-center gap-2'>
                <button
                  type='button'
                  onClick={() => void handleGenerateAndAttach()}
                  disabled={pdfAttaching || !pdfAttachField}
                  title={
                    !pdfAttachField ? 'Configure PDF field in Data Model → Layouts' : undefined
                  }
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
              </div>,
              { asChild: true }
            )}
          {containerIsSteps(c) &&
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
                        className='inline-flex items-center gap-1.5 rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-nvr-cyan-dark'
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
    if (
      groupFields.length === 0 &&
      !ownersHere &&
      !pdfHere &&
      widgetsHere.length === 0 &&
      !designOn
    )
      return null
    const accordionActive = accordionMode && g.type !== 'tab'
    return (
      <GroupSection
        key={g.key}
        group={g}
        fields={groupFields}
        ownersAssignment={ownersHere ? ownersSlot : undefined}
        ownersCollection={pipelineCollection}
        ownersItemId={pipelineItem}
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
        deferred={deferred.groups.has(g.key)}
        onFirstOpen={deferred.groups.has(g.key) ? openLazySection : undefined}
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
    const stickyKey = stickyGroupKey(
      sectionOrder.filter((x): x is FieldGroup => typeof x !== 'string' && !x.container_id)
    )
    return (
      <div className='nvr-stagger space-y-4'>
        {sectionOrder.map((item, i) => {
          const key = typeof item === 'string' ? item : (item as FieldGroup).key
          return sectionShell(item, key ?? i, stickyKey)
        })}
        {!pipelineSlot && showPipeline && (
          <PipelinePanel
            collection={pipelineCollection}
            item={pipelineItem}
            onBeforeTransition={saveThenTransition}
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
            onRemoveQueuedTask={isNew ? handleRemoveQueuedTask : undefined}
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
              onCreated={handleAddendumCreated}
              onApplied={() => {
                // An approved addendum rewrites the record, so the attached
                // document is now stale — regenerate it the same way a save does.
                if (pdfAutoGenerate && pdfAttachField) {
                  void handleGenerateAndAttach({ silent: true })
                }
              }}
            />
          )}
      </div>
    )
  }

  // ── Rows and the fold of a tab or step (#2697 #2698) ──────────────────────
  function structurePlan(g: FieldGroup | undefined, fields: CMSField[]) {
    return planFieldGrid(fields, {
      rows: g ? readGroupStructure(g.swap_config).rows : [],
      folded: (f) => !!g && isFolded(f._overrides),
      keep: (f) => !!f.required,
      filled: (f) => !isEmptyValue(effectiveDraft[f.field]) || !!validationErrors[f.field]
    })
  }

  function renderRowCell(row: RowGroup, members: CMSField[], cw: number, groupKey: string | null) {
    return (
      <RowGroupCell
        key={`row:${row.key}`}
        row={row}
        members={members}
        containerWidth={cw}
        errors={validationErrors}
        renderMember={(f) =>
          dwrap(
            { kind: 'field', field: f.field, group_key: groupKey },
            <div key={f.field}>
              {faint(
                designHidden(f, visibleFields.has(f.field) || !visibleFields.size),
                <FieldRow
                  field={rowMemberField(f)}
                  draft={effectiveDraft}
                  onChange={handleFieldChange}
                  relations={relations}
                  collection={collection}
                  itemId={itemId}
                  error={validationErrors[f.field]}
                  autoFillTick={autoFillTicks[f.field]}
                  visible={visibleFields.has(f.field) || !visibleFields.size}
                  forceVisible={
                    designHidden(f, visibleFields.has(f.field) || !visibleFields.size) || undefined
                  }
                  locked={lockedFields.has(f.field) || isReadOnly || addendumViewId !== 'original'}
                  layoutAiEnabled={layoutAiEnabled}
                  renderField={renderField}
                  onCountChange={handleM2MCountChange}
                />
              )}
            </div>,
            { asChild: true }
          )
        }
      />
    )
  }

  function renderFold(
    key: string,
    plan: { folded: CMSField[]; forcedOpen: boolean },
    grid: () => ReactNode
  ) {
    if (plan.folded.length === 0) return null
    return (
      <FoldArea
        count={plan.folded.length}
        open={openFolds.has(key)}
        forcedOpen={plan.forcedOpen}
        design={designOn}
        onToggle={() =>
          setOpenFolds((cur) => {
            const next = new Set(cur)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          })
        }
      >
        {grid()}
      </FoldArea>
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
    ).filter((f) => showHiddenDesign || !f.hidden)
    const ownersHere = ownersInGroup && ownersGroupKey === tabKey && showPipeline
    const pdfHere = pdfInGroup && pdfGroupKey === tabKey && !isNew
    const widgetsHereTab = widgetSlots.filter((ws) => (ws.group_key ?? null) === tabKey)
    type TabItem = { _k: string; sort: number } & (
      | { _t: 'field'; f: CMSField }
      | { _t: 'row'; row: RowGroup; members: CMSField[] }
      | { _t: 'owners'; slot: SlotAssignment }
      | { _t: 'pdf'; slot: SlotAssignment }
      | { _t: 'widget'; slot: SlotAssignment }
    )
    // "General" mixes fields of several sections: rows and the fold are a tab's own.
    const tabPlan = structurePlan(
      tabKey === '__general__' ? undefined : groups.find((g) => g.key === tabKey),
      fields
    )
    const tabItems: TabItem[] = tabPlan.units.map((u) =>
      u.kind === 'row'
        ? {
            _k: `row:${u.row.key}`,
            sort: u.members[0].sort ?? 0,
            _t: 'row' as const,
            row: u.row,
            members: u.members
          }
        : { _k: u.field.field, sort: u.field.sort ?? 0, _t: 'field' as const, f: u.field }
    )
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
      <div
        key={activeTab}
        className='nvr-tab-enter rounded-xl border border-slate-200 bg-white px-5 py-5'
      >
        {/* Design: the pane takes its tab's fields ("General" in tab mode mixes
            Ungrouped and sections, so it is not one drop target). */}
        {designOn && (tabKey !== '__general__' || inStepsMode) && (
          <DesignDropBody groupKey={tabKey === '__general__' ? '__ungrouped__' : tabKey} />
        )}
        {(() => {
          const renderTabItem = (item: TabItem, cw: number): ReactNode => {
            if (item._t === 'row')
              return renderRowCell(
                item.row,
                item.members,
                cw,
                tabKey === '__general__' ? null : tabKey
              )
            if (item._t === 'owners') {
              const span = item.slot.col_span ?? 12
              return dwrap(
                slotTarget('__owners__', item.slot.group_key ?? null),
                <div key='__owners__' style={{ gridColumn: `span ${span}` }}>
                  <OwnersInline
                    collection={collection}
                    itemId={itemId}
                    label={item.slot.label_override || 'Owners'}
                  />
                </div>,
                { asChild: true }
              )
            }
            if (item._t === 'pdf') {
              if (!layoutId) return null
              const span = item.slot.col_span ?? 12
              const label = item.slot.label_override?.trim() || 'Generate PDF'
              const notConfigured = !pdfAttachField
              return dwrap(
                slotTarget('__pdf__', item.slot.group_key ?? null),
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
                </div>,
                { asChild: true }
              )
            }
            if (item._t === 'widget') {
              if (!item.slot.widget_id) return null
              const span = item.slot.col_span ?? 12
              return dwrap(
                slotTarget(item.slot.field, item.slot.group_key ?? null),
                <div key={item.slot.field} style={{ gridColumn: `span ${span}` }}>
                  <WidgetSlot
                    widgetId={item.slot.widget_id}
                    inputBindings={(item.slot.input_bindings ?? []) as InputBinding[]}
                    itemDraft={draft}
                    label={item.slot.label_override ?? undefined}
                    defaultExpanded={item.slot.default_expanded ?? true}
                  />
                </div>,
                { asChild: true }
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
            return dwrap(
              fieldTarget(f),
              <div key={f.field} style={{ gridColumn: `span ${resolveColSpan(f.options, cw)}` }}>
                {faint(
                  designHidden(f),
                  <FieldRow
                    field={f}
                    draft={effectiveDraft}
                    onChange={handleFieldChange}
                    relations={relations}
                    collection={collection}
                    itemId={itemId}
                    error={validationErrors[f.field]}
                    autoFillTick={autoFillTicks[f.field]}
                    visible={true}
                    forceVisible={designHidden(f) || undefined}
                    locked={isReadOnly || addendumViewId !== 'original'}
                    layoutAiEnabled={layoutAiEnabled}
                    renderField={renderField}
                    onCountChange={handleM2MCountChange}
                  />
                )}
                {inlineEntries?.length && hasVal && inlineRelCollection && (
                  <InlineDisplay
                    relCollection={inlineRelCollection}
                    relId={rawVal as string | number}
                    entries={inlineEntries}
                    separator={inlineSeparator}
                  />
                )}
              </div>,
              { asChild: true }
            )
          }
          return (
            <>
              <GridContainer>
                {(cw) => tabItems.map((item) => renderTabItem(item, cw))}
              </GridContainer>
              {renderFold(tabKey, tabPlan, () => (
                <GridContainer>
                  {(cw) =>
                    tabPlan.folded.map((f) =>
                      renderTabItem({ _k: f.field, sort: f.sort ?? 0, _t: 'field', f }, cw)
                    )
                  }
                </GridContainer>
              ))}
            </>
          )
        })()}
        {/* "General" in tab mode mixes Ungrouped fields and sections: no single
            place to drop into, so no drop zone invitation either. */}
        {designOn && tabItems.length === 0 && (tabKey !== '__general__' || inStepsMode) && (
          <DesignDropZone />
        )}
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
        <div
          ref={tabStripRef}
          className='relative flex border-b border-slate-200 overflow-x-auto gap-1 px-1'
        >
          {tabStripItems.map((t) => {
            const hasErr = Object.keys(validationErrors).some((f) => {
              const fc = allFields.find((field) => field.field === f)
              return fc?.group_key === t.key || (!fc?.group_key && t.key === '__general__')
            })
            const tabButton = (
              <button
                key={t.key}
                type='button'
                data-tab-key={t.key}
                data-design-tab={designOn ? '' : undefined}
                data-design-hidden={designHiddenTabs?.has(t.key) ? '' : undefined}
                onClick={() => setActiveTab(t.key)}
                className={cn(
                  'whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 border-transparent transition-colors flex items-center gap-1.5',
                  activeTab === t.key
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                  designHiddenTabs?.has(t.key) && 'opacity-40'
                )}
              >
                {t.label}
                {hasErr && <span className='h-1.5 w-1.5 rounded-full bg-destructive' />}
              </button>
            )
            // "General" collects ungrouped + section fields — not a group.
            return t.key === '__general__'
              ? tabButton
              : dwrap({ kind: 'group', key: t.key }, tabButton, { asChild: true, pass: true })
          })}
          {tabIndicator && (
            <span
              aria-hidden
              className='nvr-tab-indicator pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-primary'
              style={{ left: tabIndicator.left, width: tabIndicator.width }}
            />
          )}
        </div>
        {designStackAll
          ? tabStripItems.map((t) => (
              <Fragment key={t.key}>
                {stackedPaneLabel(t.key, t.label)}
                {renderTabContent(t.key)}
              </Fragment>
            ))
          : renderTabContent(activeTab)}
        {sectionOrder
          .filter((item) => typeof item === 'string' && item !== '__ungrouped__')
          .map((item) => dwrap(slotTarget(item as string), renderSentinel(item as string)))}
        {!pipelineSlot && showPipeline && (
          <PipelinePanel
            collection={pipelineCollection}
            item={pipelineItem}
            onBeforeTransition={saveThenTransition}
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
            onRemoveQueuedTask={isNew ? handleRemoveQueuedTask : undefined}
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
              onCreated={handleAddendumCreated}
              onApplied={() => {
                // An approved addendum rewrites the record, so the attached
                // document is now stale — regenerate it the same way a save does.
                if (pdfAutoGenerate && pdfAttachField) {
                  void handleGenerateAndAttach({ silent: true })
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
                disabled={saveMut.isPending || isReadOnly || viewAs.active}
                className='inline-flex h-9 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-colors hover:bg-nvr-cyan-dark disabled:opacity-50'
              >
                <Save className='h-3.5 w-3.5' />
                {saveMut.isPending ? 'Saving…' : 'Save Progress'}
              </button>
            ) : (
              <button
                type='button'
                onClick={handleNext}
                className='inline-flex items-center gap-1.5 rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-nvr-cyan-dark'
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
                // transition (saveThenTransition — shared by every transition
                // button on the form).
                onBeforeTransition={saveThenTransition}
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
      <div className='nvr-stagger space-y-4 min-w-0 flex-1'>
        {preTabItems.map((item, i) => {
          const key = typeof item === 'string' ? item : (item as FieldGroup).key
          return sectionShell(item as FieldGroup | string, key ?? i)
        })}
        <StepsBar
          steps={allSteps}
          hiddenSteps={designHiddenTabs}
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
        {designStackAll
          ? allSteps.map((st) => (
              <Fragment key={st.key}>
                {stackedPaneLabel(st.key, st.label)}
                {renderTabContent(st.key, true)}
              </Fragment>
            ))
          : renderTabContent(activeTab, true)}
        {postTabItems.map((item, i) => {
          const key = typeof item === 'string' ? item : (item as FieldGroup).key
          return sectionShell(item as FieldGroup | string, key ?? i)
        })}
        {!pipelineSlot && showPipeline && (
          <PipelinePanel
            collection={pipelineCollection}
            item={pipelineItem}
            defaultExpanded={false}
            onBeforeTransition={saveThenTransition}
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
            onRemoveQueuedTask={isNew ? handleRemoveQueuedTask : undefined}
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
              onCreated={handleAddendumCreated}
              onApplied={() => {
                // An approved addendum rewrites the record, so the attached
                // document is now stale — regenerate it the same way a save does.
                if (pdfAutoGenerate && pdfAttachField) {
                  void handleGenerateAndAttach({ silent: true })
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
    if (isNew || !documentTitle || designOn) return
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
  }, [itemData, colMeta, collection, isNew, documentTitle, designOn])

  // ── Lost access while open (#1925, F7) ────────────────────────────────────
  // No fields, no cached values, no unsaved edits — RecordLiveSync dropped
  // the record's queries; only the reason and a way back remain.
  // ── Created, but outside what this person can see (id unknown) ────────────
  if (createdOutOfView) {
    const noun = colMeta?.singular || titleCase(collection)
    return (
      <div className={cn('nvr-fade-in flex flex-1 min-h-0 flex-col overflow-y-auto', className)}>
        <div
          className='m-6 max-w-xl rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200'
          data-created-out-of-view
        >
          <p className='font-semibold'>The {noun.toLowerCase()} was created.</p>
          <p className='mt-1'>
            It’s outside what you can see
            {createdOutOfView.reason ? ` (${createdOutOfView.reason})` : ''}, so it can’t open here.
            Don’t create it again — ask an administrator if you need access to it.
          </p>
          <button
            type='button'
            onClick={onBack ?? (() => window.history.back())}
            className='mt-3 inline-flex h-8 items-center rounded-md border border-amber-300 bg-white px-3 text-[13px] font-medium hover:bg-amber-100 dark:border-amber-700/60 dark:bg-transparent dark:hover:bg-amber-900/40'
          >
            Back
          </button>
        </div>
      </div>
    )
  }

  if (recordGone?.kind === 'access') {
    return (
      <div className={cn('nvr-fade-in flex flex-1 min-h-0 flex-col overflow-y-auto', className)}>
        <RecordAccessLostPanel onBack={onBack ?? (() => window.history.back())} />
      </div>
    )
  }

  // ── Access denied / not found ──────────────────────────────────────────────
  // A 403/404 on the record load used to leave a silently empty form —
  // explain WHY (role permission, RLS, or which User Scope excludes it).
  // A record that was showing and then stopped answering keeps its form
  // while RecordLiveSync works out why (deleted: form stays, saving off;
  // lost access: the panel above replaces it).
  if (itemLoadDenied && !itemData) {
    return (
      <div className={cn('nvr-fade-in flex flex-1 min-h-0 flex-col overflow-y-auto', className)}>
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
  // Design mode: each draft edit is a new field-config query whose isFetched
  // starts false while the previous answer stays on screen (placeholderData) —
  // only the very first answer may show the loader, or every edit would swap
  // the canvas for it and remount the form.
  const fieldConfigReady = designOn ? fieldConfig !== undefined : fieldConfigFetched
  const isLoading = !fieldConfigReady || (!isNew && itemLoading)
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
      value={
        isNew || isReadOnly ? null : (handleReimportParsed as import('../context').ReimportHandler)
      }
    >
      <RelationPathDataContext.Provider value={relationPathData}>
        <AddendumO2MContext.Provider value={addendumO2MMap}>
          <AddendumViewContext.Provider value={addendumViewId}>
            <AddendumFieldContext.Provider value={addendumFieldMap}>
              <ParentDraftContext.Provider value={parentDraftCtxValue}>
                <GridFlushContext.Provider value={isNew ? null : gridFlushCtx}>
                  <StaleFieldReportContext.Provider value={reportStaleField}>
                    <O2MStagingContext.Provider value={o2mStagingCtx}>
                      <LiveRowsContext.Provider value={liveRowsCtx}>
                        <StagedRelationsContext.Provider value={stagedRelsCtx}>
                          <M2MStagingContext.Provider value={m2mStagingCtx}>
                            <FieldContexts
                              affordances={fieldAffordances}
                              personalDefaults={personalDefaults.context}
                            >
                              {/* Instant tooltips for truncated header values. Self-deduplicating —
          only the first live instance listens, so a form rendered inside a
          collection browser doesn't double up. */}
                              <TipLayer />
                              <Dialog
                                open={!!leaveAsk}
                                onOpenChange={(open) => {
                                  if (!open) setLeaveAsk(null)
                                }}
                              >
                                <DialogContent className='max-w-md' data-nvr-leave-ask>
                                  <DialogHeader>
                                    <DialogTitle className='text-[15px]'>
                                      Leave without saving?
                                    </DialogTitle>
                                  </DialogHeader>
                                  <DialogBody>
                                    <p className='text-[13px] text-slate-600 dark:text-slate-300'>
                                      {unsavedSummary.text
                                        ? `You have unsaved changes: ${unsavedSummary.text}.`
                                        : 'You have unsaved changes.'}{' '}
                                      They stay on this device as a draft — open this{' '}
                                      {isNew ? 'form' : 'record'} again to restore them.
                                    </p>
                                  </DialogBody>
                                  <DialogFooter>
                                    <Button
                                      variant='outline'
                                      size='sm'
                                      onClick={() => {
                                        const go = leaveAsk?.go
                                        setLeaveAsk(null)
                                        go?.()
                                      }}
                                    >
                                      Leave
                                    </Button>
                                    <Button
                                      size='sm'
                                      className='bg-nvr-cyan text-white'
                                      autoFocus
                                      onClick={() => setLeaveAsk(null)}
                                    >
                                      Stay
                                    </Button>
                                  </DialogFooter>
                                </DialogContent>
                              </Dialog>
                              <SaveProgressDialog
                                open={saveDialogOpen}
                                steps={saveSteps}
                                onClose={() => setSaveDialogOpen(false)}
                                record={
                                  !isNew && itemId != null
                                    ? { collection, itemId: String(itemId) }
                                    : null
                                }
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
                                      <ImportColumnChips
                                        diff={reimportDialog.diff}
                                        fields={fieldConfig ?? []}
                                      />
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
                              <div
                                ref={formRootRef}
                                className={cn('flex flex-1 min-h-0 flex-col', className)}
                              >
                                {showHeader && (
                                  <header
                                    className={cn(
                                      'shrink-0 border-b border-slate-200 dark:border-border bg-white dark:bg-card px-8 flex items-center gap-x-3 gap-y-2 max-md:[&[data-nvr-header-row]]:flex-wrap max-md:[&[data-nvr-header-row]]:px-4 transition-[padding] duration-200',
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
                                        className='group/back shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-100'
                                      >
                                        <ArrowLeft
                                          aria-hidden
                                          className='h-4 w-4 transition-transform duration-150 group-hover/back:-translate-x-0.5'
                                        />
                                      </button>
                                    )}
                                    {/* min-width floor: without it flex crushes this block to
                                      zero width before the row ever overflows, so HeaderTools'
                                      scrollWidth check never fires and the toolbar squishes the
                                      title instead of collapsing (the 1700-2050px squish bug).
                                      The layout editor canvas is far narrower than the viewport
                                      the md: floor reads, so design mode keeps a smaller floor
                                      or the folded toolbar's Create/Save clips at the edge. */}
                                    <div
                                      className={
                                        designMode
                                          ? 'flex min-w-[200px] flex-col'
                                          : 'flex min-w-[180px] flex-col md:min-w-[260px]'
                                      }
                                    >
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
                                              aria-label='Copy title'
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
                                          className='mt-0.5 flex flex-wrap items-center gap-1 text-[10.5px] text-slate-400 dark:text-slate-500'
                                          data-tip={
                                            lastTouch
                                              ? new Date(lastTouch.timestamp).toLocaleString()
                                              : undefined
                                          }
                                          data-last-touch
                                        >
                                          {lastTouchText}
                                          {completeness?.hasRequired && (
                                            <span
                                              data-completeness-chip
                                              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9.5px] font-semibold tabular-nums transition-colors duration-300 ${
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
                                              <span key={completeness.pct} className='nvr-fade-in'>
                                                {completeness.pct}% complete
                                              </span>
                                            </span>
                                          )}
                                          {(completeness?.recommendedMissing.length ?? 0) > 0 && (
                                            <span
                                              data-recommended-chip
                                              className='inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[9.5px] font-semibold tabular-nums text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
                                              data-tip={`${completeness?.recommendedFilled} of ${completeness?.recommendedTotal} recommended fields filled · missing: ${completeness?.recommendedMissing.slice(0, 5).join(', ')}${(completeness?.recommendedMissing.length ?? 0) > 5 ? '…' : ''}`}
                                            >
                                              {completeness?.recommendedMissing.length} recommended
                                              to fill
                                            </span>
                                          )}
                                          {provenance && !provenance.api && (
                                            <span
                                              data-provenance-chip
                                              className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-1.5 py-px text-[9.5px] font-medium text-slate-500 dark:border-border dark:bg-muted dark:text-muted-foreground'
                                              data-tip={`${provenance.origin}${provenance.user_name ? ` · ${provenance.user_name}` : ''} · ${new Date(provenance.timestamp).toLocaleString()}`}
                                            >
                                              {provenance.origin}
                                            </span>
                                          )}
                                          {provenance?.api && (
                                            <ApiProvenanceChip
                                              collection={collection}
                                              itemId={String(itemId)}
                                              origin={provenance.origin}
                                              userName={provenance.user_name}
                                              timestamp={provenance.timestamp}
                                              api={provenance.api}
                                            />
                                          )}
                                          {/* Admin-only: the route 403s everyone else anyway. */}
                                          {isAdmin && !isNew && itemId && !designOn && (
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
                                              aria-label='Copy subtitle'
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
                                    <div className='ml-auto flex items-center gap-1.5 [&_button]:whitespace-nowrap'>
                                      {headerExtra}
                                      <HeaderTools>
                                        {isNew && (
                                          <ImportFromFileButton
                                            collection={collection}
                                            onParsed={applyImportResult}
                                          />
                                        )}
                                        {isNew && !isReadOnly && (
                                          <DocumentAutofillButton
                                            collection={collection}
                                            onApply={applyDocumentProposal}
                                            initialProposalId={autofillProposalId ?? null}
                                            onProposalConsumed={onAutofillConsumed}
                                          />
                                        )}
                                        {isNew && quickPickerSteps.length > 0 && !isReadOnly && (
                                          <Popover
                                            open={quickPickOpen}
                                            onOpenChange={setQuickPickOpen}
                                          >
                                            <PopoverTrigger asChild>
                                              <button
                                                type='button'
                                                title='Quick pick — walk the related fields in order'
                                                data-quick-pick-toggle
                                                className={cn(
                                                  'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium shadow-sm transition-colors',
                                                  quickPickOpen
                                                    ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                                                    : 'border-input bg-background hover:bg-accent hover:text-accent-foreground'
                                                )}
                                              >
                                                <Wand2 className='h-3.5 w-3.5' />
                                                Quick pick
                                              </button>
                                            </PopoverTrigger>
                                            {/* Slides through the layout's relation steps beside the
                                              button, bound to the live draft — every pick is a
                                              normal edit; Done just closes. */}
                                            <PopoverContent
                                              align='end'
                                              sideOffset={6}
                                              className='w-[440px] max-w-[calc(100vw-24px)] p-3'
                                              data-quick-picker-modal
                                            >
                                              <QuickPicker
                                                collection={collection}
                                                itemId={itemId}
                                                steps={quickPickerSteps}
                                                fieldConfig={fieldConfig ?? []}
                                                relations={relations}
                                                draft={draft}
                                                getM2M={getM2MEffectiveIds}
                                                onChange={handleFieldChange}
                                                onM2MChange={setQuickPickerM2M}
                                                fieldLabels={parentFieldLabels}
                                                fieldOptionFilters={parentFieldOptionFilters}
                                                onFinish={() => setQuickPickOpen(false)}
                                                finishLabel='Done'
                                                finishRequiresComplete={false}
                                              />
                                            </PopoverContent>
                                          </Popover>
                                        )}
                                        {/* Record tools: one compact icon group instead of a strip of
                                          equal-weight buttons. Each tool keeps its own popover /
                                          dialog; the group supplies border + dividers. */}
                                        {/* Summary ⇄ Edit — a labelled segmented control, not an
                                          icon pill: the active side is filled so the current mode
                                          reads at a glance ("make it obvious what mode I'm in"). */}
                                        {!isNew &&
                                        itemId &&
                                        colMeta?.read_mode_toggle &&
                                        summaryModeSettled ? (
                                          <div
                                            role='radiogroup'
                                            aria-label='Form mode'
                                            data-summary-mode-toggle
                                            data-mode={readMode ? 'summary' : 'edit'}
                                            className='inline-flex h-9 shrink-0 items-center overflow-hidden rounded-md border border-input bg-background p-0.5 text-[11.5px] font-medium shadow-sm'
                                          >
                                            <button
                                              type='button'
                                              role='radio'
                                              aria-checked={readMode}
                                              data-summary-mode-option='summary'
                                              title='Summary mode — a read-only view of this record'
                                              onClick={() => setReadMode(true)}
                                              className={cn(
                                                'inline-flex h-full items-center gap-1.5 rounded px-2.5 transition-colors',
                                                readMode
                                                  ? 'bg-nvr-cyan text-white shadow-sm'
                                                  : 'text-slate-600 hover:bg-muted dark:text-slate-300'
                                              )}
                                            >
                                              <BookOpen className='h-3.5 w-3.5' strokeWidth={2} />
                                              Summary
                                            </button>
                                            <button
                                              type='button'
                                              role='radio'
                                              aria-checked={!readMode}
                                              data-summary-mode-option='edit'
                                              title={
                                                editLockMessage
                                                  ? `Form view — read-only: ${editLockMessage}`
                                                  : 'Edit mode — change this record'
                                              }
                                              onClick={() => setReadMode(false)}
                                              className={cn(
                                                'inline-flex h-full items-center gap-1.5 rounded px-2.5 transition-colors',
                                                !readMode
                                                  ? 'bg-nvr-cyan text-white shadow-sm'
                                                  : 'text-slate-600 hover:bg-muted dark:text-slate-300'
                                              )}
                                            >
                                              {/* An approval-locked record is not offered "Edit":
                                                  the full form still opens, read-only. */}
                                              {editLockMessage ? (
                                                <>
                                                  <Lock className='h-3.5 w-3.5' strokeWidth={2} />
                                                  Form
                                                </>
                                              ) : (
                                                <>
                                                  <PencilLine
                                                    className='h-3.5 w-3.5'
                                                    strokeWidth={2}
                                                  />
                                                  Edit
                                                </>
                                              )}
                                            </button>
                                          </div>
                                        ) : null}
                                        {!isNew && itemId ? (
                                          <HeaderToolGroup>
                                            {lockEnabled &&
                                              !lockHolder &&
                                              (lockAcquired || lockReleased) && (
                                                <LockHolderButton
                                                  note={lockNote}
                                                  onSave={saveLockNote}
                                                  waiting={lockQueue}
                                                  onRelease={releaseLock}
                                                  releasing={releasingLock}
                                                  released={lockReleased && !lockAcquired}
                                                  onRelock={relockLock}
                                                />
                                              )}
                                            <FindInRecordButton
                                              compact
                                              fields={findableFields}
                                              onJump={jumpToField}
                                            />
                                            {showFormVideosButton(itemId, hideHelpVideoButton) && (
                                              <HelpVideoButton
                                                compact
                                                collection={collection}
                                                item={itemId}
                                              />
                                            )}
                                            <button
                                              type='button'
                                              title='Copy a plain-text summary of this record (fields + link) for chat or email'
                                              onClick={() => void copyRecordSummary()}
                                              disabled={copyingSummary}
                                              aria-label='Copy record summary'
                                              className='inline-flex h-8 w-8 items-center justify-center transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60'
                                            >
                                              {copyingSummary ? (
                                                <Loader2 className='h-4 w-4 animate-spin' />
                                              ) : (
                                                <Clipboard className='h-4 w-4' />
                                              )}
                                            </button>
                                            <button
                                              type='button'
                                              title='Relationships — see and explore every record linked to this one'
                                              onClick={() => setGraphOpen(true)}
                                              aria-label='Relationships'
                                              data-record-graph-open
                                              className='inline-flex h-8 w-8 items-center justify-center transition-colors hover:bg-accent hover:text-accent-foreground'
                                            >
                                              <Waypoints className='h-4 w-4' />
                                            </button>
                                            {!inPopout && (
                                              <button
                                                type='button'
                                                data-tip='Pop out — open this record in its own window (stays live and in step with this tab)'
                                                onClick={popOutRecord}
                                                aria-label='Pop out'
                                                data-record-popout
                                                className='inline-flex h-8 w-8 items-center justify-center transition-colors hover:bg-accent hover:text-accent-foreground'
                                              >
                                                <PictureInPicture2 className='h-4 w-4' />
                                              </button>
                                            )}
                                            {isAdmin &&
                                              colMeta?.browser_config?.copy_as !== false && (
                                                <CopyAsButton
                                                  compact
                                                  collection={collection}
                                                  itemId={String(itemId)}
                                                  fields={copyAsFields}
                                                />
                                              )}
                                            <RecordSubscribeButton
                                              compact
                                              collection={collection}
                                              itemId={String(itemId)}
                                            />
                                            <RecordInsightsButton
                                              compact
                                              collection={collection}
                                              itemId={String(itemId)}
                                            />
                                            <RecordChatActions
                                              compact
                                              collection={collection}
                                              itemDraft={draft}
                                            />
                                            {effectiveShowRevisions && (
                                              <RevisionsPanel
                                                compact
                                                collection={collection}
                                                item={itemId}
                                                onRollback={() =>
                                                  qc.invalidateQueries({
                                                    queryKey: ['item', collection, itemId]
                                                  })
                                                }
                                              />
                                            )}
                                          </HeaderToolGroup>
                                        ) : (
                                          <FindInRecordButton
                                            fields={findableFields}
                                            onJump={jumpToField}
                                          />
                                        )}
                                        {/* Secondary tools — one "More" menu; the rows are the same
                                          components (dialogs, sheets, confirms unchanged). */}
                                        {!isNew && itemId && (
                                          <HeaderMenu>
                                            <ImportFromFileButton
                                              collection={collection}
                                              templateFilter={(t) => t.reimport?.enabled === true}
                                              getLabel={(t) =>
                                                t.reimport?.button_label ?? t.button_label
                                              }
                                              onParsed={handleReimportParsed}
                                            />
                                            {fileLayouts.map((fl) => (
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
                                            {!!(
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
                                                    setTimeout(
                                                      () => URL.revokeObjectURL(url),
                                                      30_000
                                                    )
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
                                            {grantedTools.disablePickers && (
                                              <PickerExclusionToggle
                                                collection={collection}
                                                itemId={String(itemId)}
                                                layoutSlug={layoutSlug ?? null}
                                              />
                                            )}
                                            {grantedTools.schedule && (
                                              <ScheduleChangeButton
                                                collection={collection}
                                                itemId={String(itemId)}
                                                fields={scheduleFields}
                                                layoutSlug={layoutSlug ?? null}
                                              />
                                            )}
                                            <div data-nvr-menu-divider />
                                            {onDuplicate && (
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
                                                      isDerivedForRecord(
                                                        fc as { computed_type?: string | null },
                                                        draft
                                                      )
                                                    )
                                                      skip.add(fc.field)
                                                    const readonlyFc = Boolean(
                                                      (fc as { readonly?: boolean }).readonly
                                                    )
                                                    const noDupe = Boolean(
                                                      opts &&
                                                        typeof opts === 'object' &&
                                                        (opts as { no_duplicate?: unknown })
                                                          .no_duplicate
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
                                                  // Copy the record as it is NOW, not the copy this
                                                  // tab loaded: a junction edit (Zone, funding year)
                                                  // made elsewhere never reaches an open form, and the
                                                  // duplicate carried values the record no longer had.
                                                  // The person's own unsaved edits still win.
                                                  const fresh = await client
                                                    .request<{ data: Record<string, unknown> }>(
                                                      get(`/items/${collection}/${itemId}`)
                                                    )
                                                    .then((r) => r.data ?? null)
                                                    .catch(() => null)
                                                  const source: Record<string, unknown> = fresh
                                                    ? { ...fresh }
                                                    : { ...draft }
                                                  if (fresh)
                                                    for (const k of userTouchedRef.current)
                                                      if (
                                                        !valuesEqual(
                                                          draft[k],
                                                          initialDataRef.current[k]
                                                        )
                                                      )
                                                        source[k] = draft[k]
                                                  const freshLinks = await Promise.all(
                                                    [...m2mAliasFieldsForRules.values()].map(
                                                      (info) =>
                                                        qc
                                                          .fetchQuery({
                                                            queryKey: [
                                                              'm2m-items',
                                                              info.manyCollection,
                                                              info.manyField,
                                                              itemId
                                                            ],
                                                            queryFn: () =>
                                                              client
                                                                .request<{
                                                                  data: Record<string, unknown>[]
                                                                }>(
                                                                  get(
                                                                    `/items/${info.manyCollection}`,
                                                                    {
                                                                      filter: JSON.stringify({
                                                                        [info.manyField]: {
                                                                          _eq: itemId
                                                                        }
                                                                      }),
                                                                      limit: 200,
                                                                      fields: `id,${info.junctionField}`
                                                                    }
                                                                  )
                                                                )
                                                                .then((r) => r.data ?? []),
                                                            staleTime: 0
                                                          })
                                                          .then(
                                                            (rows) =>
                                                              [
                                                                info.stagingKey,
                                                                computeM2MEffectiveIds(
                                                                  rows,
                                                                  info.junctionField,
                                                                  m2mLinks.get(info.stagingKey),
                                                                  m2mUnlinks.get(info.stagingKey)
                                                                )
                                                              ] as const
                                                          )
                                                          .catch(() => null)
                                                    )
                                                  )
                                                  const freshIds = new Map(
                                                    freshLinks.filter(
                                                      (e): e is readonly [string, string[]] => !!e
                                                    )
                                                  )
                                                  const values: Record<string, unknown> = {}
                                                  for (const [k, v] of Object.entries(source)) {
                                                    if (
                                                      !copyable.has(k) ||
                                                      skip.has(k) ||
                                                      k.includes('.') ||
                                                      k.startsWith('__')
                                                    )
                                                      continue
                                                    if (v === undefined || v === null || v === '')
                                                      continue
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
                                                    const aliasFc = (fieldConfig ?? []).find(
                                                      (f) => f.field === aliasField
                                                    )
                                                    if (aliasFc && isNoDuplicate(aliasFc)) continue
                                                    const ids =
                                                      freshIds.get(info.stagingKey) ??
                                                      m2mAliasFieldStates[aliasField]?.ids ??
                                                      []
                                                    if (ids.length) links[info.stagingKey] = ids
                                                  }
                                                  // O2M child rows for the grids this layout shows (files
                                                  // and audit children are not grids, so they never copy).
                                                  const rows: Record<
                                                    string,
                                                    Array<Record<string, unknown>>
                                                  > = {}
                                                  for (const fc of fieldConfig ?? []) {
                                                    // A child set the record marks "do not
                                                    // duplicate" (integration logs, queue rows) or
                                                    // read-only never follows the copy.
                                                    if (
                                                      fc.hidden ||
                                                      fc.readonly ||
                                                      isNoDuplicate(fc)
                                                    )
                                                      continue
                                                    const rel = (relations ?? []).find(
                                                      (r) =>
                                                        r.one_collection === collection &&
                                                        !r.junction_field &&
                                                        (r.one_field === fc.field ||
                                                          r.many_collection === fc.field)
                                                    )
                                                    if (!rel?.many_collection || !rel.many_field)
                                                      continue
                                                    const key = `${rel.many_collection}.${rel.many_field}`
                                                    if (rows[key]) continue
                                                    try {
                                                      const [res, childConfig] = await Promise.all([
                                                        client.request(
                                                          get<{
                                                            data: Array<Record<string, unknown>>
                                                          }>(`/items/${rel.many_collection}`, {
                                                            limit: 200,
                                                            filter: JSON.stringify({
                                                              [rel.many_field]: { _eq: itemId }
                                                            })
                                                          })
                                                        ) as Promise<{
                                                          data: Array<Record<string, unknown>>
                                                        }>,
                                                        // The line's own field config: its
                                                        // read-only / "do not duplicate" columns
                                                        // (a sales order number, shipped qty)
                                                        // stay behind. Unreadable = copy as before.
                                                        qc
                                                          .fetchQuery({
                                                            queryKey: [
                                                              'field-config',
                                                              rel.many_collection,
                                                              null
                                                            ],
                                                            queryFn: () =>
                                                              client
                                                                .request<{ data: CMSField[] }>(
                                                                  get(
                                                                    `/field-config/${rel.many_collection}`
                                                                  )
                                                                )
                                                                .then((r) => r.data ?? []),
                                                            staleTime: 60_000
                                                          })
                                                          .catch(() => null)
                                                      ])
                                                      const childRows = (res.data ?? []).map((r0) =>
                                                        duplicateChildRow(
                                                          r0,
                                                          rel.many_field as string,
                                                          childConfig
                                                        )
                                                      )
                                                      if (childRows.length) rows[key] = childRows
                                                    } catch {
                                                      /* a grid that fails to read just doesn't copy */
                                                    }
                                                  }
                                                  onDuplicate({
                                                    values,
                                                    links,
                                                    rows,
                                                    layout_slug:
                                                      (
                                                        layoutMeta as
                                                          | { slug?: string | null }
                                                          | undefined
                                                      )?.slug ?? null
                                                  })
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
                                            <button
                                              type='button'
                                              data-tip='Ask the administrators to change something on this record'
                                              data-request-change
                                              data-nvr-menu-close
                                              onClick={() => setSupportOpen(true)}
                                              className='inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'
                                            >
                                              <LifeBuoy className='h-3.5 w-3.5' />
                                              Request a change
                                            </button>
                                            {!isAdmin && !isNew && itemId && (
                                              <button
                                                type='button'
                                                data-tip='Tell the administrators how this form could work better'
                                                data-suggest-form-change-open
                                                data-nvr-menu-close
                                                onClick={(e) => {
                                                  // The row's menu closes with this click: anchor to its button.
                                                  setSuggestAnchor(
                                                    document.querySelector<HTMLElement>(
                                                      '[data-nvr-header-tools-btn][aria-expanded="true"]'
                                                    ) ??
                                                      document.querySelector<HTMLElement>(
                                                        '[data-nvr-header-menu-btn][aria-expanded="true"]'
                                                      ) ??
                                                      e.currentTarget
                                                  )
                                                  setSuggestOpen(true)
                                                }}
                                                className='inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'
                                              >
                                                <MessageSquarePlus className='h-3.5 w-3.5' />
                                                Suggest a form change
                                              </button>
                                            )}
                                            {isAdmin && (
                                              <>
                                                <div data-nvr-menu-divider />
                                                <Button
                                                  type='button'
                                                  variant='outline'
                                                  size='sm'
                                                  data-nvr-menu-close
                                                  onClick={() => setRawEditOpen(true)}
                                                  title='Edit every field with conditional logic bypassed (admin)'
                                                  className='gap-1.5'
                                                >
                                                  <Wrench className='h-3.5 w-3.5' />
                                                  Raw edit
                                                </Button>
                                                {!isNew && (
                                                  <Button
                                                    type='button'
                                                    variant='outline'
                                                    size='sm'
                                                    onClick={() => setViewAsOpen(true)}
                                                    title='Render this form exactly as a chosen role sees it (nothing is saved as them)'
                                                    className='gap-1.5'
                                                    data-view-as-role-open
                                                  >
                                                    <Eye className='h-3.5 w-3.5' />
                                                    View as role…
                                                  </Button>
                                                )}
                                                {effectiveShowClone && (
                                                  // lint-traps-ok: self-triggered; HeaderTools ignores clicks inside dialogs it opened
                                                  <CloneDialog
                                                    collection={collection}
                                                    itemId={itemId}
                                                    fields={fieldConfig ?? []}
                                                    relations={relations}
                                                    currentValues={itemData ?? {}}
                                                    onSuccess={(newId) => onSaved?.(String(newId))}
                                                  />
                                                )}
                                              </>
                                            )}
                                            {moreMenuItems}
                                            {canDelete && <div data-nvr-menu-divider />}
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
                                                  aria-label='Delete this record'
                                                  data-tip='Delete this record (asks to confirm)'
                                                  onClick={() => setConfirmDelete(true)}
                                                >
                                                  <Trash2 className='h-3.5 w-3.5' />
                                                  Delete
                                                </Button>
                                              ))}
                                          </HeaderMenu>
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
                                                  if (e.key === 'Escape')
                                                    setTemplateDialogOpen(false)
                                                }}
                                              >
                                                <p className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
                                                  Save as template
                                                </p>
                                                <p className='mt-1 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
                                                  This record's plain field values become a reusable
                                                  pre-fill template — same exclusions as Duplicate
                                                  (no ids, audit stamps, computed fields, or line
                                                  items).
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
                                                    onChange={(e) =>
                                                      setTemplateShared(e.target.checked)
                                                    }
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
                                                    disabled={
                                                      !templateName.trim() || templateSaving
                                                    }
                                                    onClick={async () => {
                                                      // Same harvest rules as Duplicate: visible,
                                                      // editable, non-computed, non-auto-id scalars
                                                      // + M2O FKs only.
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
                                                      const values: Record<string, unknown> = {}
                                                      for (const fc of fieldConfig ?? []) {
                                                        const opts = fc.options as Record<
                                                          string,
                                                          unknown
                                                        > | null
                                                        if (AUDIT.has(fc.field)) continue
                                                        if (
                                                          opts &&
                                                          typeof opts === 'object' &&
                                                          (opts as { auto_id?: unknown }).auto_id
                                                        )
                                                          continue
                                                        if (
                                                          isDerivedForRecord(
                                                            fc as { computed_type?: string | null },
                                                            draft
                                                          )
                                                        )
                                                          continue
                                                        if (
                                                          fc.hidden ||
                                                          (fc as { readonly?: boolean }).readonly
                                                        )
                                                          continue
                                                        if (
                                                          (fc as { layout_assigned?: boolean })
                                                            .layout_assigned === false
                                                        )
                                                          continue
                                                        const v = draft[fc.field]
                                                        if (
                                                          v === undefined ||
                                                          v === null ||
                                                          v === ''
                                                        )
                                                          continue
                                                        if (typeof v === 'object') continue
                                                        values[fc.field] = v
                                                      }
                                                      // M2M / M2A links (a contact picker) ride
                                                      // as `__links` — the prefill contract —
                                                      // instead of being left out. Files stay
                                                      // with their record.
                                                      const links = templateLinks(
                                                        fieldConfig ?? [],
                                                        m2mAliasFieldsForRules,
                                                        m2mAliasFieldStates,
                                                        relations
                                                      )
                                                      if (links) values.__links = links
                                                      if (Object.keys(values).length === 0) {
                                                        toast.error(
                                                          'Nothing to save — no plain field values on this record'
                                                        )
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
                                                        toast.success(
                                                          `Template "${templateName.trim()}" saved`
                                                        )
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
                                      </HeaderTools>
                                      {/* Hold / Remove Hold (registry header actions) sit right
                                        beside More, ahead of the record and pipeline actions. */}
                                      {!isNew && (
                                        <RecordHeaderActionButtons
                                          actions={headerRegistryActions}
                                          onPick={setHeaderRegistryPick}
                                        />
                                      )}
                                      {/* Record actions stay inline beside Save, never in the
                                        folded ⋯ panel: on a narrower screen Push to Fusion was
                                        only reachable behind an unlabeled ⋯ and read as gone. */}
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
                                      {!!activeLayoutData?.layout?.changes_tray && !readMode && (
                                        <ChangesTray
                                          items={changeItems}
                                          saving={saveMut.isPending}
                                          onRevertAll={
                                            changeItems.length > 1
                                              ? () => {
                                                  for (const it of changeItems) it.onRevert()
                                                }
                                              : undefined
                                          }
                                        />
                                      )}
                                      {!isStepsMode && (
                                        <div className='relative'>
                                          {isDirty && !saveMut.isPending && (
                                            <button
                                              type='button'
                                              onClick={() => setInspectorOpen((v) => !v)}
                                              title='Unsaved changes — click to see what changed'
                                              className='absolute -right-1 -top-1 z-10 h-3 w-3 rounded-full'
                                              data-unsaved-dot
                                            >
                                              <span
                                                className={cn(
                                                  'nvr-pop absolute inset-0.5 rounded-full bg-amber-400 ring-2 ring-white dark:ring-card',
                                                  dirtyIdle && 'nvr-idle-breathe'
                                                )}
                                              />
                                            </button>
                                          )}
                                          <UnsavedInspector
                                            open={inspectorOpen && isDirty}
                                            onClose={() => setInspectorOpen(false)}
                                            collection={collection}
                                            relations={relations}
                                            fieldConfig={fieldConfig}
                                            draft={draft}
                                            initial={initialDataRef.current}
                                            m2mLinks={m2mLinks}
                                            m2mUnlinks={m2mUnlinks}
                                            pendingRowCount={[...pendingO2MRows.values()].reduce(
                                              (n, r) => n + r.length,
                                              0
                                            )}
                                            pendingDeleteCount={[
                                              ...pendingO2MDeletes.values()
                                            ].reduce((n, r) => n + r.size, 0)}
                                          />
                                          <Button
                                            type='button'
                                            size='sm'
                                            onClick={() => handleSave()}
                                            disabled={
                                              saveMut.isPending || isReadOnly || viewAs.active
                                            }
                                            className={cn(
                                              'gap-1.5 transition-colors duration-300',
                                              // Summary mode has nothing to save — the button would
                                              // only contradict the "read-only" strip.
                                              readMode && !isNew && 'hidden',
                                              justSaved &&
                                                'bg-emerald-500 hover:bg-emerald-500 text-white'
                                            )}
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
                                                      !a.workflow_state &&
                                                        (a.status === 'approved'
                                                          ? 'bg-emerald-400'
                                                          : a.status === 'rejected'
                                                            ? 'bg-red-400'
                                                            : 'bg-amber-400')
                                                    )}
                                                    style={
                                                      a.workflow_state?.color
                                                        ? {
                                                            backgroundColor: a.workflow_state.color
                                                          }
                                                        : a.workflow_state
                                                          ? { backgroundColor: '#f59e0b' }
                                                          : undefined
                                                    }
                                                  />
                                                  <span className='flex-1 truncate'>{a.title}</span>
                                                  <span
                                                    className={cn(
                                                      'text-[10px] text-slate-400',
                                                      !a.workflow_state && 'capitalize'
                                                    )}
                                                  >
                                                    {a.workflow_state?.label ?? a.status}
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
                                            onBeforeTransition={saveThenTransition}
                                          />
                                        )}
                                    </div>
                                  </header>
                                )}
                                {!isNew && itemId && (
                                  <RecordHeaderActionDialog
                                    action={headerRegistryPick}
                                    collection={collection}
                                    itemId={String(itemId)}
                                    onClose={() => setHeaderRegistryPick(null)}
                                  />
                                )}
                                {/* Dialogs live OUTSIDE HeaderTools: a collapsed header (⋯) unmounts its
                                children, so a change-reason / collision prompt raised from Save never
                                rendered once the tool strip had folded (reported 2026-09-14). */}
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
                                    return (
                                      (fc && placementFieldText(fc, placementTextCtx).label) ||
                                      titleCase(f)
                                    )
                                  }}
                                  onCancel={() => setCrChallenge(null)}
                                  onSubmit={(reason) => {
                                    changeReasonRef.current = reason
                                    setCrChallenge(null)
                                    nudgeRecommended()
                                    saveMut.mutate()
                                  }}
                                />
                                {!isNew && itemId && (
                                  <SupportRequestDialog
                                    open={supportOpen}
                                    onOpenChange={setSupportOpen}
                                    collection={collection}
                                    item={String(itemId)}
                                    recordLabel={itemTitle ? String(itemTitle) : null}
                                    onCreated={(t) =>
                                      toast.success(`Request #${t.id} sent to the administrators`)
                                    }
                                  />
                                )}
                                {!isAdmin && !isNew && itemId && (
                                  <SuggestFormChange
                                    open={suggestOpen}
                                    onOpenChange={setSuggestOpen}
                                    anchor={suggestAnchor}
                                    collection={collection}
                                    item={String(itemId)}
                                    layoutId={layoutMeta?.id != null ? Number(layoutMeta.id) : null}
                                    layoutName={
                                      typeof layoutMeta?.name === 'string' ? layoutMeta.name : null
                                    }
                                    fields={(fieldConfig ?? [])
                                      .filter(
                                        (f) =>
                                          !f.hidden &&
                                          (visibleFields.size === 0 || visibleFields.has(f.field))
                                      )
                                      .map((f) => ({
                                        field: f.field,
                                        label: f.label || titleCase(f.field.replace(/_/g, ' '))
                                      }))}
                                    onSent={(r) =>
                                      toast.success(
                                        `Suggestion #${r.id} sent — follow it under My requests`
                                      )
                                    }
                                  />
                                )}
                                {!isNew && itemId && (
                                  <RecordGraphSheet
                                    collection={collection}
                                    itemId={String(itemId)}
                                    open={graphOpen}
                                    onOpenChange={setGraphOpen}
                                  />
                                )}
                                {isAdmin && !isNew && itemId && (
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
                                )}

                                {(entryCfg.badge || (!designOn && entryMode.switchable)) && (
                                  <EntryStrip
                                    badge={entryCfg.badge}
                                    mode={!designOn && entryMode.switchable ? entryMode.mode : null}
                                    auto={entryMode.auto}
                                    onMode={entryMode.set}
                                  />
                                )}
                                {showHeader &&
                                  (headerWidgets.length > 0 || headerFields.length > 0) && (
                                    // Condensing HIDES rather than unmounts: a
                                    // remount refires every header widget/chip
                                    // fetch, which read as the sub-header
                                    // "reloading" on scroll-up.
                                    <div
                                      ref={headerStripRef}
                                      // A stat band (lib/header-strip.ts): tiles are content-sized
                                      // and grow only to a cap, so a wide window shows a compact
                                      // cluster on the left and the status dock pinned right — not
                                      // six labels stretched 300px apart. Narrow windows wrap whole
                                      // tiles; every tile draws its own top + left hairline and the
                                      // row clips the outer ones, so dividers stay continuous.
                                      className={`${HEADER_BAND} ${headerCondensed ? 'hidden' : 'block'}`}
                                      data-header-dense={headerDense ? '' : undefined}
                                    >
                                      <div className={HEADER_ROW}>
                                        <div className={HEADER_TILES} ref={headerTilesRef}>
                                          {(() => {
                                            const tiles = [
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
                                              })),
                                              ...headerSummaries.map((h) => ({
                                                type: 'summary' as const,
                                                sort: 9_000,
                                                key: `__summary__${h.field}`,
                                                data: h
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
                                                    navigator.clipboard
                                                      .writeText(text)
                                                      .catch(() => {})
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

                                                if (item.type === 'summary') {
                                                  const h = item.data
                                                  return (
                                                    <HeaderSummaryChip
                                                      key={item.key}
                                                      collection={collection}
                                                      itemId={itemId}
                                                      field={h.field}
                                                      config={h.config}
                                                      onOpen={(t) => {
                                                        jumpToField(h.field)
                                                        // The grid may only mount after the tab
                                                        // switch above — ask a few times.
                                                        const detail = {
                                                          collection: t.childCollection,
                                                          field: t.fkField,
                                                          rowId: t.rowId
                                                        }
                                                        for (const ms of [150, 500, 1100]) {
                                                          window.setTimeout(
                                                            () =>
                                                              window.dispatchEvent(
                                                                new CustomEvent(
                                                                  'nvr:grid-open-row',
                                                                  {
                                                                    detail
                                                                  }
                                                                )
                                                              ),
                                                            ms
                                                          )
                                                        }
                                                      }}
                                                    />
                                                  )
                                                }
                                                if (item.type === 'widget') {
                                                  const w = item.data
                                                  const isBtnGroup =
                                                    headerWidgetTypes[w.field] === 'button-group'
                                                  return dwrapEl(
                                                    { kind: 'header', field: w.field },
                                                    <div
                                                      key={w.field}
                                                      // A widget may hold several figures side by side (a budget pair), so
                                                      // the single-tile cap does not apply to it — each figure is
                                                      // content-sized inside (StripCell).
                                                      className={`${HEADER_TILE} !max-w-none !gap-0 !px-0 !py-0 !justify-stretch [[data-header-list]_&]:!h-auto [[data-header-list]_&]:!flex-col`}
                                                      // Its figures are money: fold them last.
                                                      data-header-money=''
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
                                                            aria-label='Copy value'
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
                                                    </div>,
                                                    { asChild: true }
                                                  )
                                                }
                                                const f = item.data
                                                if (f.field === '__owners__') {
                                                  return dwrapEl(
                                                    { kind: 'header', field: '__owners__' },
                                                    <div
                                                      key='__owners__'
                                                      // Empty roster reads dim. Pinned: who holds the
                                                      // record never folds behind "+N more" (Rob 2026-10-26).
                                                      className={`${HEADER_TILE} [&:has([data-roster-empty])]:opacity-60`}
                                                      data-header-pin=''
                                                    >
                                                      <span
                                                        className={HEADER_LABEL}
                                                        data-header-label
                                                      >
                                                        {f.label}
                                                      </span>
                                                      <div
                                                        className={HEADER_VALUE_LINE}
                                                        data-header-value
                                                      >
                                                        <OwnersInlineCompact
                                                          collection={pipelineCollection}
                                                          itemId={pipelineItem}
                                                        />
                                                      </div>
                                                      {copiedHeaderField === '__owners__' ? (
                                                        <Check className='absolute top-2 right-2 h-3 w-3 text-green-500' />
                                                      ) : (
                                                        <button
                                                          type='button'
                                                          aria-label='Copy owners'
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
                                                    </div>,
                                                    { asChild: true }
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
                                                // A rollup the addendum's proposed rows move counts too — the
                                                // addendum never stores the total itself.
                                                const changedByAddendum =
                                                  viewingAddendum &&
                                                  !aliasState &&
                                                  ((addendumViewData != null &&
                                                    f.field in addendumViewData &&
                                                    String(draft[f.field] ?? '') !==
                                                      String(addendumViewData[f.field] ?? '')) ||
                                                    (liveRollup !== undefined &&
                                                      Math.round(
                                                        Number(draft[f.field] ?? 0) * 100
                                                      ) !== Math.round(liveRollup * 100)))
                                                const thrColor = (() => {
                                                  const rules = (
                                                    f as {
                                                      thresholds?: Array<{
                                                        op: string
                                                        value: number
                                                        color: string
                                                      }>
                                                    }
                                                  ).thresholds
                                                  if (!rules?.length) return undefined
                                                  const n =
                                                    typeof raw === 'number'
                                                      ? raw
                                                      : typeof raw === 'string' && raw.trim() !== ''
                                                        ? Number(raw)
                                                        : Number.NaN
                                                  if (!Number.isFinite(n)) return undefined
                                                  const hit = rules.find((r) =>
                                                    r.op === 'lt'
                                                      ? n < r.value
                                                      : r.op === 'lte'
                                                        ? n <= r.value
                                                        : r.op === 'gt'
                                                          ? n > r.value
                                                          : r.op === 'gte'
                                                            ? n >= r.value
                                                            : r.op === 'eq'
                                                              ? n === r.value
                                                              : false
                                                  )
                                                  return hit?.color
                                                })()
                                                const fColor = thrColor ?? f.color
                                                const hColorClass = changedByAddendum
                                                  ? 'text-amber-600 dark:text-amber-400'
                                                  : fColor === 'cyan'
                                                    ? 'text-nvr-cyan'
                                                    : fColor === 'blue'
                                                      ? 'text-blue-600 dark:text-blue-400'
                                                      : fColor === 'green'
                                                        ? 'text-emerald-600 dark:text-emerald-400'
                                                        : fColor === 'amber'
                                                          ? 'text-amber-600 dark:text-amber-400'
                                                          : fColor === 'red'
                                                            ? 'text-red-600 dark:text-red-400'
                                                            : fColor === 'purple'
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
                                                // Money figures lead the band (one size up); anything
                                                // without a value steps back so the populated facts
                                                // carry the row.
                                                const fmtOpts = f.cmsField
                                                  ? (() => {
                                                      try {
                                                        const o = f.cmsField.options
                                                        return (
                                                          typeof o === 'string'
                                                            ? JSON.parse(o)
                                                            : (o ?? {})
                                                        ) as { format?: string }
                                                      } catch {
                                                        return {} as { format?: string }
                                                      }
                                                    })()
                                                  : ({} as { format?: string })
                                                const hero =
                                                  f.displayFormat === 'currency' ||
                                                  fmtOpts.format === 'currency' ||
                                                  f.cmsField?.computed_type === 'rollup'
                                                const textCls = `text-[13px] ${hero ? 'tracking-[-0.01em]' : ''} ${hColorClass} ${hWeightClass}`
                                                const isEmpty =
                                                  raw == null ||
                                                  raw === '' ||
                                                  (Array.isArray(raw) && raw.length === 0)
                                                const isPill = f.displayAs === 'pill'
                                                const isTag = f.displayAs === 'tag'
                                                return dwrapEl(
                                                  { kind: 'header', field: f.field },
                                                  <div
                                                    key={f.field}
                                                    data-header-field={f.field}
                                                    data-empty={isEmpty}
                                                    data-header-money={hero ? '' : undefined}
                                                    // self-stretch so the label sits the same distance from the
                                                    // top as a widget cell's. The row is items-center, and a
                                                    // widget stat cell already stretches to full height — a
                                                    // centred field chip is shorter, so its label landed a few
                                                    // pixels lower and the two read as misaligned.
                                                    className={HEADER_TILE}
                                                  >
                                                    <span
                                                      className={HEADER_LABEL}
                                                      data-header-label
                                                    >
                                                      {f.label}
                                                    </span>
                                                    <span
                                                      data-header-value
                                                      className={[
                                                        HEADER_VALUE_LINE,
                                                        isPill || isTag
                                                          ? 'max-w-[232px] truncate leading-tight'
                                                          : 'max-w-[232px] items-baseline truncate leading-tight',
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
                                                        if (
                                                          addendumRollupLoading &&
                                                          f.cmsField?.computed_type === 'rollup' &&
                                                          !aliasState
                                                        ) {
                                                          return (
                                                            <span
                                                              aria-label='Loading'
                                                              className='inline-block h-3.5 w-16 animate-pulse rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]'
                                                            />
                                                          )
                                                        }
                                                        const inner = f.cmsField ? (
                                                          <>
                                                            <StripFieldValue
                                                              field={f.cmsField}
                                                              val={raw}
                                                              relations={relations}
                                                              collection={collection}
                                                              displayFormat={f.displayFormat}
                                                              textClassName={textCls}
                                                            />
                                                            {/* A figure explains its arithmetic; a computed
                                                              STATUS ("coalesce(∅, shipped)") would only leak
                                                              its formula — the explainer rides numbers. */}
                                                            {(f.cmsField.computed_type ===
                                                              'rollup' ||
                                                              ((f.cmsField.computed_type ===
                                                                'read' ||
                                                                f.cmsField.computed_type ===
                                                                  'write') &&
                                                                hero)) &&
                                                              !isNew &&
                                                              !viewingAddendum && (
                                                                <HeaderRollupExplainer
                                                                  collection={collection}
                                                                  itemId={itemId}
                                                                  field={f.cmsField.field}
                                                                />
                                                              )}
                                                          </>
                                                        ) : (
                                                          <span
                                                            className={`${hero ? HEADER_VALUE_HERO : HEADER_VALUE} ${textCls}`}
                                                          >
                                                            {formatHeaderFieldValue(
                                                              raw,
                                                              f.displayFormat
                                                            )}
                                                          </span>
                                                        )
                                                        // Configured link template ({{value}} + any {{field}} from
                                                        // the draft) turns the header value into an external link
                                                        // — how e.g. an external system id deep-links to that system with
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
                                                              encodeURIComponent(
                                                                String(draft[k] ?? '')
                                                              )
                                                          )
                                                        if (!/^https?:\/\//i.test(href))
                                                          return inner
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
                                                    {/* Who last changed it, as an info icon beside the
                                                      copy button: a line under the value was cut off
                                                      in short tiles and sat inside the value's link. */}
                                                    {f.cmsField &&
                                                      !f.cmsField.computed_type &&
                                                      !isNew &&
                                                      !viewingAddendum && (
                                                        <HeaderFreshness
                                                          collection={collection}
                                                          itemId={itemId}
                                                          field={f.cmsField.field}
                                                          fields={headerTouchFields}
                                                          className='absolute top-2 right-6'
                                                        />
                                                      )}
                                                    {copiedHeaderField === f.field ? (
                                                      <Check className='absolute top-2 right-2 h-3 w-3 text-green-500' />
                                                    ) : (
                                                      <button
                                                        type='button'
                                                        aria-label='Copy value'
                                                        className='absolute top-2 right-2 flex h-3 w-3 cursor-pointer items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity'
                                                        onClick={(e) => {
                                                          const cell =
                                                            e.currentTarget.closest<HTMLElement>(
                                                              '.group'
                                                            )
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
                                                  </div>,
                                                  { asChild: true }
                                                )
                                              })
                                            const foldedCells = headerDense ? headerFolded : []
                                            return (
                                              <>
                                                <HeaderTiles
                                                  tiles={tiles}
                                                  folded={foldedCells}
                                                  rows={headerDense ? headerRows : null}
                                                />
                                                {!isNew && itemId && (
                                                  // Below lg the Integrations chip ends the last row
                                                  // (the column dock is lg-only) — never a third shelf.
                                                  // Ordered last: tiles packed first-fit carry
                                                  // their row as a flex order (HeaderTiles).
                                                  <div
                                                    className={HEADER_DOCK_INLINE}
                                                    data-header-tail
                                                    style={{ order: 99 }}
                                                  >
                                                    <ExternalRequestsChip
                                                      collection={collection}
                                                      itemId={String(itemId)}
                                                    />
                                                  </div>
                                                )}
                                              </>
                                            )
                                          })()}
                                        </div>
                                        {!isNew && itemId && (
                                          <div className={HEADER_DOCK} data-header-dock>
                                            <div className={HEADER_DOCK_CELL}>
                                              <ExternalRequestsChip
                                                collection={collection}
                                                itemId={String(itemId)}
                                              />
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                <div
                                  ref={designOn ? setRailHost : undefined}
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
                                    {!isNew && <QueueReturnChip />}
                                    {extraTopContent}
                                    {showValidationSummary && validationSummaryItems.length > 0 && (
                                      <ValidationSummary
                                        items={validationSummaryItems}
                                        onJump={focusFieldInput}
                                        onDismiss={() => setShowValidationSummary(false)}
                                      />
                                    )}
                                    {configUpdated && (
                                      <div
                                        data-form-config-changed
                                        role='status'
                                        className='mb-2 flex items-center gap-2 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/5 px-3 py-1.5 text-[12px] text-[#007a99] dark:text-nvr-cyan'
                                      >
                                        <span className='h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-nvr-cyan' />
                                        <span className='min-w-0 flex-1'>
                                          This form was changed. Reload to see the new version
                                          {isDirty ? ' — what you typed is kept.' : '.'}
                                        </span>
                                        <button
                                          type='button'
                                          onClick={() =>
                                            window.setTimeout(
                                              () => window.location.reload(),
                                              isDirty ? 1200 : 0
                                            )
                                          }
                                          className='h-6 shrink-0 rounded-md border border-nvr-cyan/40 bg-white px-2 text-[11.5px] font-medium hover:bg-nvr-cyan/10 dark:bg-transparent'
                                        >
                                          Reload
                                        </button>
                                      </div>
                                    )}

                                    {!designOn && layoutId != null && (
                                      <FormWhatsNew layoutId={layoutId} />
                                    )}
                                    {viewAsOpen && (
                                      <ViewAsRoleBar
                                        roles={viewAs.roles}
                                        roleId={viewAs.roleId}
                                        onChange={(id) => {
                                          viewAs.setRoleId(id)
                                          if (!id) setViewAsOpen(false)
                                        }}
                                        preview={viewAs.preview}
                                        loading={viewAs.loading}
                                      />
                                    )}
                                    {!isNew && outboxEntry && (
                                      <div className='nvr-expand-in'>
                                        <RecordOutboxBanner
                                          entry={outboxEntry}
                                          labelFor={(f) =>
                                            (fieldConfig ?? []).find((x) => x.field === f)?.label ??
                                            ''
                                          }
                                          onReview={reviewOutbox}
                                          onRetry={() => void retryRecordOutbox(collection, itemId)}
                                          onDiscard={discardOutbox}
                                        />
                                      </div>
                                    )}
                                    {/* Never offer to restore edits onto a record this person
                                        cannot change; the draft stays for when they can. */}
                                    {recovery.state === 'offer' && !(isReadOnly && !isNew) && (
                                      <div className='nvr-expand-in'>
                                        <DraftRecoveryBanner
                                          draft={recovery.draft}
                                          labelFor={(f) =>
                                            (fieldConfig ?? []).find((x) => x.field === f)?.label ??
                                            ''
                                          }
                                          current={initialDataRef.current}
                                          recordChanged={
                                            !!recovery.draft.base_updated_at &&
                                            !!(
                                              initialDataRef.current.date_updated ??
                                              initialDataRef.current.updated_at
                                            ) &&
                                            String(
                                              initialDataRef.current.date_updated ??
                                                initialDataRef.current.updated_at
                                            ) !== recovery.draft.base_updated_at
                                          }
                                          onRestore={restoreDraft}
                                          onDiscard={discardDraft}
                                          createdId={recovery.createdId}
                                          collection={collection}
                                          renderValue={(f, v) => (
                                            <ChangeValue
                                              value={v}
                                              field={
                                                (fieldConfig ?? []).find((x) => x.field === f) ??
                                                null
                                              }
                                              m2oTarget={
                                                relations.find(
                                                  (r) =>
                                                    r.many_collection === collection &&
                                                    r.many_field === f &&
                                                    !r.junction_field
                                                )?.one_collection ?? null
                                              }
                                            />
                                          )}
                                        />
                                      </div>
                                    )}
                                    {/* No wrapper div: the strip renders null until there is a
                                      recap, and an EMPTY sibling inside this space-y stack still
                                      costs a 16px gap above the next banner (the "more top
                                      padding than side padding"). */}
                                    {!isNew && itemId && !designOn && (
                                      <RecordRecapStrip
                                        collection={collection}
                                        itemId={String(itemId)}
                                      />
                                    )}
                                    {!isNew &&
                                      itemId &&
                                      // Design mode: the live check stores its result.
                                      !designOn &&
                                      !activeLayoutData?.layout?.hide_integrity_banner &&
                                      // Summary mode marks the affected fields instead —
                                      // the banner would only push the record down.
                                      !(readMode && summaryModeSettled) && (
                                        <RecordIntegrityBanner
                                          collection={collection}
                                          itemId={String(itemId)}
                                          onJumpToField={flashField}
                                        />
                                      )}
                                    {isAdmin && !designOn && !!lockWhy.data?.hidden?.length && (
                                      <HiddenByRulesNote
                                        why={lockWhy.data}
                                        fields={fieldConfig ?? []}
                                        stepVisible={stepVisible}
                                      />
                                    )}
                                    {!isNew &&
                                      itemId &&
                                      !activeLayoutData?.layout?.hide_sla_banner && (
                                        // No wrapper div — an EMPTY sibling in this space-y stack
                                        // still costs a 16px gap (the banner is null unless breached).
                                        <SlaBreachBanner
                                          collection={pipelineCollection}
                                          itemId={String(pipelineItem)}
                                        />
                                      )}
                                    {/* The partner-status lines live in the header's
                                      Integrations chip popup (ExternalRequestsChip) —
                                      no banner in the body (2026-09-24). */}
                                    {importIssues.length > 0 && (
                                      <ImportIssuesPanel
                                        issues={importIssues}
                                        onDismiss={() => setImportIssues([])}
                                      />
                                    )}
                                    {/* The banner is null without a holder — mount it only then, or its
                                      empty wrapper costs a 16px gap in this space-y stack. */}
                                    {editLockMessage && (
                                      <div
                                        className='nvr-expand-in flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
                                        data-edit-lock-banner
                                        role='status'
                                      >
                                        <Lock className='mt-0.5 h-4 w-4 shrink-0 text-amber-500' />
                                        <span>{editLockMessage}</span>
                                      </div>
                                    )}
                                    {showLockBanner && lockEnabled && lockHolder && (
                                      <div className='nvr-expand-in'>
                                        <ItemLockBanner
                                          lockHolder={lockHolder}
                                          onTakeOver={takeOver}
                                          takingOver={takingOver}
                                          isAdmin={isAdmin}
                                          onRequestLock={requestLock}
                                          requesting={requesting}
                                          queue={lockQueue}
                                          myPosition={lockQueuePosition}
                                          onJoinQueue={joinLockQueue}
                                          onLeaveQueue={leaveLockQueue}
                                          joining={joiningLockQueue}
                                        />
                                      </div>
                                    )}
                                    {!isNew && !designOn && (
                                      <RecordLiveSync
                                        collection={collection}
                                        itemId={String(itemId)}
                                        dirty={isDirty}
                                        loadDenied={itemLoadDenied}
                                        onGoneChange={setRecordGone}
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
                                    {!summaryModeSettled ? (
                                      <div
                                        data-summary-mode-pending
                                        aria-busy='true'
                                        className='space-y-4'
                                      >
                                        <Skeleton className='h-10 w-full' />
                                        <div className='grid gap-4 lg:grid-cols-2'>
                                          <Skeleton className='h-40 w-full' />
                                          <Skeleton className='h-40 w-full' />
                                        </div>
                                        <Skeleton className='h-56 w-full' />
                                      </div>
                                    ) : readMode && !isNew && activeLayoutData?.layout ? (
                                      <RecordReadView
                                        collection={collection}
                                        itemId={String(itemId)}
                                        // Section pencil → Edit mode, landing on the section's
                                        // first field.
                                        onEditSection={(_groupKey, firstField) => {
                                          setReadMode(false)
                                          if (firstField)
                                            window.setTimeout(() => jumpToField(firstField), 350)
                                        }}
                                        // The collection's Summary layout when it has one (Table
                                        // Editor → Layouts → type Summary), else the grouped layout
                                        // rendered read-only.
                                        layoutData={
                                          (summaryLayoutData ??
                                            activeLayoutData) as unknown as ReadViewLayout
                                        }
                                        flush
                                        // Notes + tasks stay live in Summary mode — the record's
                                        // FIELDS are read-only, the conversation about it is not —
                                        // and the pipeline slot (state track, owners, approval
                                        // chain) is what a reader wants first.
                                        renderSlot={(key) =>
                                          key === '__comments__' ||
                                          key === '__tasks__' ||
                                          key === '__pipeline__' ||
                                          key === '__addendums__'
                                            ? renderSentinel(key)
                                            : null
                                        }
                                        // The integrity banner is hidden in Summary mode; the
                                        // affected fields carry an amber mark instead.
                                        integrityMarks
                                        // Child grids are the REAL inline grid, read-only — PO
                                        // match dots, row lints, submission errors, presets and
                                        // the aggregate footer all come along ("linked lines
                                        // to orders, highlighted errors, integration errors — just can't
                                        // edit").
                                        renderGrid={(a) => {
                                          const f = (fieldConfig ?? []).find(
                                            (x) => x.field === a.field
                                          )
                                          if (!f) return null
                                          return (
                                            <FieldRow
                                              key={`summary-grid-${a.field}`}
                                              field={{ ...f, readonly: true }}
                                              draft={effectiveDraft}
                                              onChange={handleFieldChange}
                                              relations={relations}
                                              collection={collection}
                                              itemId={itemId}
                                              visible={true}
                                              locked={false}
                                              layoutAiEnabled={layoutAiEnabled}
                                              renderField={renderField}
                                              onCountChange={handleM2MCountChange}
                                            />
                                          )
                                        }}
                                        gridCounts={o2mEffectiveCounts}
                                      />
                                    ) : hasTabs ? (
                                      isStepsMode ? (
                                        renderStepsMode()
                                      ) : (
                                        renderTabMode()
                                      )
                                    ) : (
                                      renderSectionMode()
                                    )}
                                    {extraBottomContent}
                                  </div>
                                  {summaryEnabled && (
                                    <div
                                      className={cn(
                                        'flex shrink-0 border-l border-slate-200',
                                        designOn && railViewportH && 'sticky top-0 self-start'
                                      )}
                                      style={
                                        designOn && railViewportH
                                          ? { height: railViewportH }
                                          : undefined
                                      }
                                    >
                                      <button
                                        type='button'
                                        onClick={() => {
                                          const next = !summaryCollapsed
                                          setSummaryCollapsed(next)
                                          if (designOn)
                                            writeDesignSummaryCollapsed(authUserId, next)
                                        }}
                                        // Design mode swallows canvas clicks; this one passes.
                                        data-design-pass={designOn ? '' : undefined}
                                        data-summary-toggle={designOn ? '' : undefined}
                                        aria-expanded={designOn ? !summaryCollapsed : undefined}
                                        title={
                                          summaryCollapsed ? 'Expand summary' : 'Collapse summary'
                                        }
                                        className={
                                          designOn
                                            ? DESIGN_RAIL_TOGGLE
                                            : 'border-r flex w-6 shrink-0 items-start justify-center pt-3 bg-slate-100 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 transition-colors dark:bg-white/[0.04] dark:hover:bg-white/[0.08] dark:text-slate-500 dark:hover:text-slate-300'
                                        }
                                      >
                                        {designOn ? (
                                          // Rides with the canvas scroll; folded, it says what comes back.
                                          <span className='sticky top-3 flex flex-col items-center gap-2'>
                                            {summaryCollapsed ? (
                                              <ChevronLeft className='h-3.5 w-3.5' />
                                            ) : (
                                              <ChevronRight className='h-3.5 w-3.5' />
                                            )}
                                            {summaryCollapsed && (
                                              <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300 [writing-mode:vertical-rl]'>
                                                Summary
                                              </span>
                                            )}
                                          </span>
                                        ) : summaryCollapsed ? (
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
                                            onRevertChange={(f) => revertByField[f]?.()}
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
                                            stagedO2MRows={pendingO2MRows}
                                            stagedO2MDeletes={pendingO2MDeletes}
                                            errors={validationErrors}
                                            staleFields={staleFields}
                                            changedFields={changedFieldMap}
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
                                                    scrollBodyTop()
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
                            </FieldContexts>
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
  // Portal into the hosting dialog (a record drill sheet) when there is one —
  // a modal sheet's lock makes everything outside it unclickable.
  const [host, setHost] = useState<HTMLElement | null>(null)
  // Rich text reads as text here, never as raw <p> markup.
  const fmt = (v: unknown) => {
    if (v == null || v === '') return '—'
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 120)
    const str = String(v)
    const text = /<[a-z][^>]*>/i.test(str) ? htmlToText(str) : str
    return text.trim() ? text.slice(0, 200) : '—'
  }
  const anchor = (
    <span
      hidden
      ref={(el) => {
        if (el && !host)
          setHost((el.closest('[role="dialog"]') as HTMLElement | null) ?? document.body)
      }}
    />
  )
  if (!host) return anchor
  return createPortal(
    <div
      role='dialog'
      aria-modal='true'
      aria-labelledby='nvr-midair-title'
      className='pointer-events-auto fixed inset-0 z-[130] flex items-center justify-center'
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className='absolute inset-0 bg-black/40' onClick={onCancel} />
      <div className='relative w-[560px] max-w-[94vw] rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-border dark:bg-card'>
        <p
          id='nvr-midair-title'
          className='text-[14px] font-semibold text-slate-900 dark:text-foreground'
        >
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
              <div
                key={c.field}
                className='rounded-md border border-slate-200 p-2.5 dark:border-border'
              >
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
    host
  )
}
