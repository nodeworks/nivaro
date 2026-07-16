import type { ImportParseResponse } from '@nivaro/sdk'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, FileDown, Loader2, Save, Trash2 } from 'lucide-react'
import { CloneDialog } from './item-edit/CloneDialog'
import { ImportFromFileButton } from './import/ImportFromFileButton'
import { ImportIssuesPanel } from './import/ImportIssuesPanel'
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
import { GridFlushContext, type GridFlushContextValue, ItemEditAuthContext, ParentDraftContext, useApiFetchConfig, useNivaroClient, RelationPathDataContext } from '../context'
import { del, get, patch, post } from '../lib/commands'
import { cn, formatRelative, titleCase } from '../lib/utils'
import { FieldRow } from './item-edit/FieldRow'
import { GroupSection, InlineDisplay, OwnersInline, OwnersInlineCompact, StripFieldValue } from './item-edit/GroupSection'
import { applyDisplayTemplate, isSentinelKey, resolveColSpan, SENTINEL_FIELDS, SYSTEM_FIELDS, useContainerWidth } from './item-edit/helpers'
import { M2MStagingContext, type M2MStagingCtx } from './item-edit/M2MStagingContext'
import { AddendumFieldContext, AddendumO2MContext, AddendumViewContext, type AddendumFieldMap, type AddendumO2MMap } from './item-edit/AddendumFieldContext'
import { O2MStagingContext, type O2MStagingCtx } from './item-edit/O2MStagingContext'
import { StepsBar } from './item-edit/StepsBar'
import { SummaryPanel } from './item-edit/SummaryPanel'
import type {
  ActiveLayoutData,
  CMSField,
  CMSRelation,
  FieldGroup,
  RenderFieldProps,
  SlotAssignment,
  StepDef,
  SummaryAggConfig,
  SummaryEntry
} from './item-edit/types'
import { AddendumPanel, CommentPanel, ItemLockBanner, OwnersSlot, PipelinePanel, PipelineTransitionButtons, RevisionsPanel, TaskPanel, useItemLock, WorkflowPanel } from './panels'
import { WidgetSlot, type InputBinding } from './WidgetSlot'
import type { PendingTask } from './panels/TaskPanel'
import { Button } from './ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Skeleton } from './ui/skeleton'

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
  if (status === 'running') return <Loader2 className='h-4 w-4 animate-spin text-[#00ceff] shrink-0' />
  if (status === 'done') return <Check className='h-4 w-4 text-green-500 shrink-0' />
  if (status === 'error') return <AlertCircle className='h-4 w-4 text-red-500 shrink-0' />
  return <div className='h-4 w-4 rounded-full border-2 border-slate-200 shrink-0' />
}

function SaveProgressDialog({ open, steps, onClose }: { open: boolean; steps: SaveStepItem[]; onClose: () => void }) {
  const allSettled = steps.length > 0 && steps.every(s => s.status === 'done' || s.status === 'error')
  const hasError = steps.some(s => s.status === 'error')
  const doneCount = steps.filter(s => s.status === 'done').length
  const totalCount = steps.length
  const overallPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0

  return (
    <Dialog open={open}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()} className='max-w-md'>
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
            {steps.map(step => {
              const rowPct = step.progress && step.progress.total > 0
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
                    <div className='mt-0.5 shrink-0'><SaveStepIcon status={step.status} /></div>
                    <div className='flex-1 min-w-0'>
                      <div className='flex items-center justify-between gap-2'>
                        <span className={cn(
                          'text-[13px] font-medium leading-snug',
                          step.status === 'done' && 'text-slate-400',
                          step.status === 'error' && 'text-red-700',
                          step.status === 'running' && 'text-slate-900',
                          step.status === 'pending' && 'text-slate-500'
                        )}>
                          {step.label}
                        </span>
                        {step.progress && (
                          <span className='text-[11px] text-slate-400 shrink-0 tabular-nums font-mono'>
                            {step.progress.done}/{step.progress.total}
                          </span>
                        )}
                      </div>
                      {step.detail && !step.error && (
                        <p className='text-[11px] text-slate-400 mt-0.5 leading-snug'>{step.detail}</p>
                      )}
                      {step.error && (
                        <p className='text-[11px] text-red-500 mt-0.5 break-words leading-snug'>{step.error}</p>
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
        {allSettled && (
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
  if (format === 'currency') return isNaN(num) ? String(value) : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(num)
  if (format === 'integer') return isNaN(num) ? String(value) : new Intl.NumberFormat().format(Math.round(num))
  if (format === 'decimal') return isNaN(num) ? String(value) : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(num)
  if (format === 'percent') return isNaN(num) ? String(value) : new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(num / 100)
  if (format === 'date') { try { return new Date(String(value)).toLocaleDateString() } catch { return String(value) } }
  if (format === 'datetime') { try { return new Date(String(value)).toLocaleString() } catch { return String(value) } }
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

// ─── ItemEditForm ──────────────────────────────────────────────────────────────

export function ItemEditForm({
  collection,
  itemId: itemIdProp,
  layoutSlug,
  onBack,
  onSaved,
  onDeleted,
  showHeader = true,
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
  initialImportResult
}: ItemEditFormProps) {
  const client = useNivaroClient()
  const fetchCfg = useApiFetchConfig()
  const { isAdmin } = useContext(ItemEditAuthContext)
  const qc = useQueryClient()
  const itemId = itemIdProp ?? 'new'
  const isNew = !itemIdProp || itemIdProp === 'new'

  // ── Data fetching ──────────────────────────────────────────────────────────
  const { data: activeLayoutData } = useQuery<ActiveLayoutData | null>({
    queryKey: ['active-layout', collection, layoutSlug ?? null],
    queryFn: () =>
      client
        .request<{ data: ActiveLayoutData | null }>(
          get('/collection-layouts/active', { collection, ...(layoutSlug ? { slug: layoutSlug } : {}) })
        )
        .then((r) => r.data)
        .catch(() => null),
    staleTime: 60_000
  })

  const layoutId = activeLayoutData?.layout?.id ?? null

  const { data: fieldConfig, isLoading: fieldsLoading, isFetched: fieldConfigFetched } = useQuery<CMSField[]>({
    queryKey: ['field-config', collection, layoutId],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(get(`/field-config/${collection}`, layoutId ? { layout_id: String(layoutId) } : undefined))
        .then((r) => r.data ?? []),
    staleTime: 60_000,
    enabled: !layoutSlug || activeLayoutData !== undefined
  })

  const { data: relations = [], isFetched: relationsFetched } = useQuery<CMSRelation[]>({
    queryKey: ['relations', collection],
    queryFn: () =>
      client
        .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => r.data ?? []),
    staleTime: 60_000
  })

  const { data: colMeta } = useQuery<{ display_name?: string; singular?: string | null; display_template?: string | null; item_locking_enabled?: boolean; addendums_enabled?: boolean; addendum_allowed_roles?: string | null; addendum_allowed_states?: string | null }>({
    queryKey: ['col-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { display_name?: string; singular?: string | null; display_template?: string | null; item_locking_enabled?: boolean; addendums_enabled?: boolean; addendum_allowed_roles?: string | null; addendum_allowed_states?: string | null } }>(
          get(`/collections/${collection}`)
        )
        .then((r) => r.data),
    staleTime: 60_000
  })

  const { data: fileLayouts = [] } = useQuery<Array<{ id: number; name: string; pdf_button_label?: string | null }>>({
    queryKey: ['file-layouts', collection],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; name: string }> }>(
          get('/collection-layouts', { collection, type: 'file' })
        )
        .then((r) => r.data ?? []),
    enabled: !!collection && !isNew,
    staleTime: 60_000,
  })

  const [headerWidgetTypes, setHeaderWidgetTypes] = useState<Record<string, string>>({})

  const [pdfLoading, setPdfLoading] = useState<number | null>(null)
  const [showPdfDropdown, setShowPdfDropdown] = useState(false)
  const [pdfAttaching, setPdfAttaching] = useState(false)
  const [activeAddendumCount, setActiveAddendumCount] = useState(0)
  const [addendumViewId, setAddendumViewId] = useState<string>('original')
  const [addendumViewDropdownOpen, setAddendumViewDropdownOpen] = useState(false)

  const downloadPdf = useCallback(async (layoutId: number) => {
    if (!itemId || !collection) return
    setPdfLoading(layoutId)
    setShowPdfDropdown(false)
    try {
      const workspace = typeof window !== 'undefined' ? (localStorage.getItem('nivaro_workspace') ?? '') : ''
      const resp = await fetch(`${fetchCfg.apiBase}/collection-layouts/${layoutId}/generate-pdf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...fetchCfg.authHeaders,
          ...(workspace ? { 'x-workspace': workspace } : {}),
        },
        credentials: fetchCfg.credentials,
        body: JSON.stringify({ collection, item_id: itemId }),
      })
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
  }, [collection, itemId])

  useEffect(() => {
    if (!showPdfDropdown) return
    function handleOutside(e: MouseEvent) {
      const target = e.target as Element
      if (!target.closest('[data-pdf-dropdown]')) setShowPdfDropdown(false)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [showPdfDropdown])

  const { data: itemData, isLoading: itemLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['item', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${itemId}`))
        .then((r) => r.data),
    enabled: !isNew,
    staleTime: 30_000
  })

  // ── Draft state ────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  // Synchronous mirror of draft — the save payload reads from this so that
  // grid-flush callbacks firing onChange mid-save still land in the PATCH.
  const draftRef = useRef<Record<string, unknown>>({})

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
  const [isDirty, setIsDirty] = useState(false)

  // ── Save progress dialog ───────────────────────────────────────────────────
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveSteps, setSaveSteps] = useState<SaveStepItem[]>([])
  function updateStep(id: string, upd: Partial<SaveStepItem> | ((prev: SaveStepItem) => Partial<SaveStepItem>)) {
    setSaveSteps(prev => prev.map(s => {
      if (s.id !== id) return s
      const changes = typeof upd === 'function' ? upd(s) : upd
      return { ...s, ...changes }
    }))
  }
  function getO2MLabel(key: string): string {
    const [rc] = key.split('.')
    const rel = relations.find(r => r.many_collection === rc && r.one_collection === collection && !r.junction_field)
    if (rel?.one_field) {
      const f = allFields.find(af => af.field === rel.one_field)
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
  const [pendingO2MRows, setPendingO2MRows] = useState<Map<string, Record<string, unknown>[]>>(new Map())
  // Pending edits/deletes for existing rows (saveMode='pending')
  const [pendingO2MEdits, setPendingO2MEdits] = useState<Map<string, Map<string, Record<string, unknown>>>>(new Map())
  const [pendingO2MDeletes, setPendingO2MDeletes] = useState<Map<string, Set<string>>>(new Map())

  const o2mStagingCtx = useMemo<O2MStagingCtx>(() => ({
    getPendingRows: (rc, mf) => pendingO2MRows.get(`${rc}.${mf}`) ?? [],
    queueRow: (rc, mf, data) => setPendingO2MRows(prev => {
      const next = new Map(prev)
      const key = `${rc}.${mf}`
      next.set(key, [...(next.get(key) ?? []), data])
      return next
    }),
    removeRow: (rc, mf, idx) => setPendingO2MRows(prev => {
      const next = new Map(prev)
      const key = `${rc}.${mf}`
      const arr = [...(next.get(key) ?? [])]
      arr.splice(idx, 1)
      next.set(key, arr)
      return next
    }),
    updateRow: (rc, mf, idx, data) => setPendingO2MRows(prev => {
      const next = new Map(prev)
      const key = `${rc}.${mf}`
      const arr = [...(next.get(key) ?? [])]
      arr[idx] = { ...arr[idx], ...data }
      next.set(key, arr)
      return next
    }),
    reorderRows: (rc, mf, fromIdx, toIdx) => setPendingO2MRows(prev => {
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
    queueEdit: (rc, mf, rowId, changes) => setPendingO2MEdits(prev => {
      const next = new Map(prev)
      const key = `${rc}.${mf}`
      const edits = new Map(next.get(key) ?? [])
      edits.set(rowId, { ...(edits.get(rowId) ?? {}), ...changes })
      next.set(key, edits)
      return next
    }),
    queueDelete: (rc, mf, rowId) => {
      setPendingO2MDeletes(prev => {
        const next = new Map(prev)
        const key = `${rc}.${mf}`
        const dels = new Set(next.get(key) ?? [])
        dels.add(rowId)
        next.set(key, dels)
        return next
      })
      // Remove any pending edit for this row
      setPendingO2MEdits(prev => {
        const next = new Map(prev)
        const key = `${rc}.${mf}`
        const edits = new Map(next.get(key) ?? [])
        edits.delete(rowId)
        next.set(key, edits)
        return next
      })
    },
    cancelPendingEdit: (rc, mf, rowId) => setPendingO2MEdits(prev => {
      const next = new Map(prev)
      const key = `${rc}.${mf}`
      const edits = new Map(next.get(key) ?? [])
      edits.delete(rowId)
      next.set(key, edits)
      return next
    }),
    cancelPendingDelete: (rc, mf, rowId) => setPendingO2MDeletes(prev => {
      const next = new Map(prev)
      const key = `${rc}.${mf}`
      const dels = new Set(next.get(key) ?? [])
      dels.delete(rowId)
      next.set(key, dels)
      return next
    }),
  }), [pendingO2MRows, pendingO2MEdits, pendingO2MDeletes])

  // ── Import from file (new records) ─────────────────────────────────────────
  const [importIssues, setImportIssues] = useState<ImportParseResponse['issues']>([])
  const appliedInitialImportRef = useRef(false)

  // ── M2M staging ────────────────────────────────────────────────────────────
  const [m2mLinks, setM2mLinks] = useState<Map<string, unknown[]>>(new Map())
  const [m2mUnlinks, setM2mUnlinks] = useState<Map<string, Set<unknown>>>(new Map())

  const m2mStagingCtx = useMemo<M2MStagingCtx>(
    () => ({
      getStagedLinks: (k) => m2mLinks.get(k) ?? [],
      getStagedUnlinks: (k) => m2mUnlinks.get(k) ?? new Set(),
      stageLink: (k, id) =>
        setM2mLinks((prev) => {
          const next = new Map(prev)
          const arr = [...(next.get(k) ?? [])]
          if (!arr.map(String).includes(String(id))) arr.push(id)
          next.set(k, arr)
          return next
        }),
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

  const applyImportResult = useCallback(async (result: ImportParseResponse) => {
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
            ...(line.nested ? { [line.nested.field]: line.nested.rows } : {})
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
      const m2mRel = relations.find(
        (r) => r.one_collection === collection && r.one_field === field && r.junction_field != null
      )
      if (m2mRel) {
        for (const id of ids) m2mStagingCtx.stageLink(field, id)
      } else {
        issues.push({
          severity: 'error',
          rule: 'import-apply',
          message: `No M2M relation found for "${field}" — the imported selection was not applied.`
        })
      }
    }

    setImportIssues(issues)
  }, [collection, relations, o2mStagingCtx, m2mStagingCtx, fieldConfig, client])

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

  const handleFieldChange = useCallback(
    (field: string, value: unknown) => {
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
    },
    [fieldConfig]
  )

  const [fieldCounts, setFieldCounts] = useState<Record<string, number>>({})

  const o2mRelations = useMemo(
    () => relations.filter((r) => !r.junction_field && r.one_collection === collection && r.one_field && r.many_field && r.many_collection),
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
    takingOver
  } = useItemLock(collection, !isNew ? itemId : undefined, lockEnabled)

  // ── Layout / groups ────────────────────────────────────────────────────────
  const assignments: SlotAssignment[] = activeLayoutData?.assignments ?? []

  // ── Lock condition data ────────────────────────────────────────────────────
  const hasLockConditions = assignments.some((a) => a.lock_conditions)

  const addendumEnabled = !!colMeta?.addendums_enabled && !isNew

  const { data: currentUserData } = useQuery<{ role?: string | null } | null>({
    queryKey: ['current-user-me'],
    queryFn: () =>
      client.request<{ data: { role?: string | null } }>(get('/users/me')).then((r) => r.data ?? null),
    staleTime: 5 * 60_000,
    enabled: hasLockConditions || addendumEnabled
  })

  const { data: pipelineInstanceData } = useQuery<{ instance?: { current_state?: string | null } | null; states?: Array<{ id: string; key: string }> } | null>({
    queryKey: ['pipeline-instance-lock', collection, itemId],
    queryFn: () =>
      client.request<{ data: unknown }>(get(`/pipelines/instance/${collection}/${itemId}`))
        .then((r) => r.data as { instance?: { current_state?: string | null } | null; states?: Array<{ id: string; key: string }> })
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
      } catch { /* malformed JSON — allow */ }
    }
    // State check
    if (colMeta?.addendum_allowed_states) {
      try {
        const stateRules = JSON.parse(colMeta.addendum_allowed_states) as Array<{ pipeline_id: string; state_keys: string[] }>
        if (Array.isArray(stateRules) && stateRules.length > 0) {
          const currentStateId = pipelineInstanceData?.instance?.current_state ?? null
          const currentStateKey = pipelineInstanceData?.states?.find((s) => s.id === currentStateId)?.key ?? null
          const allowed = stateRules.some((rule) => rule.state_keys.length === 0 || (currentStateKey !== null && rule.state_keys.includes(currentStateKey)))
          if (!allowed) return false
        }
      } catch { /* malformed JSON — allow */ }
    }
    return true
  }, [addendumEnabled, colMeta?.addendum_allowed_roles, colMeta?.addendum_allowed_states, currentUserData?.role, pipelineInstanceData])

  type AddendumRecord = { id: string; title: string; status: string; fields_schema: string[] | null; data: Record<string, unknown> | null }

  const { data: addendumData = [] } = useQuery<AddendumRecord[]>({
    queryKey: ['addendums', collection, itemId],
    queryFn: () =>
      client.request<{ data: AddendumRecord[] }>(
        get(`/addendums/${collection}/${itemId}`)
      ).then((r) => r.data ?? []),
    enabled: addendumEnabled,
    staleTime: 30_000,
  })

  const addendumFieldMap = useMemo<AddendumFieldMap>(() => {
    const map: AddendumFieldMap = {}
    for (const a of addendumData) {
      if (['approved', 'rejected'].includes(a.status)) continue
      for (const key of (a.fields_schema ?? [])) {
        if (!map[key]) map[key] = []
        map[key].push({ id: a.id, title: a.title, status: a.status })
      }
    }
    return map
  }, [addendumData])

  const activeAddendums = useMemo(
    () => addendumData.filter(a => !['approved', 'rejected'].includes(a.status)),
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
    const a = addendumData.find(x => x.id === addendumViewId)
    if (!a?.data) return null
    return Object.fromEntries(Object.entries(a.data).filter(([, v]) => !Array.isArray(v)))
  }, [addendumViewId, addendumData])

  const effectiveDraft = useMemo(
    () => addendumViewData ? { ...draft, ...addendumViewData } : draft,
    [draft, addendumViewData]
  )

  const addendumO2MMap = useMemo<AddendumO2MMap>(() => {
    const map: AddendumO2MMap = {}
    for (const a of addendumData) {
      if (['approved', 'rejected'].includes(a.status)) continue
      for (const [key, val] of Object.entries(a.data ?? {})) {
        if (!Array.isArray(val) || val.length === 0) continue
        if (!map[key]) map[key] = []
        map[key].push({ addendumId: a.id, addendumTitle: a.title, addendumStatus: a.status, rows: val as Array<Record<string, unknown>> })
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
    return deduped.filter((f) => assignedFieldSet.has(f.field) || SYSTEM_FIELDS.has(f.field) || isSentinelKey(f.field))
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
          .request<{ data: Array<{ field: string; options: unknown }> }>(get(`/field-config/${r.many_collection}`))
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
      const fields: Array<{ field: string; options: unknown }> = (aggFieldConfigResults[i]?.data as Array<{ field: string; options: unknown }> | undefined) ?? []
      const fieldMeta = fields.find((f) => f.field === cfg.agg_field)
      if (!fieldMeta) return
      const opts = fieldMeta.options
        ? typeof fieldMeta.options === 'string' ? fieldMeta.options : JSON.stringify(fieldMeta.options)
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
      const baseRows: Record<string, unknown>[] = (aggQueryResults[i]?.data as Record<string, unknown>[] | undefined) ?? []
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
          .map((row) => edits.has(String(row.id)) ? { ...row, ...edits.get(String(row.id)) } : row),
        ...newRows
      ]
      if (cfg.agg === 'count') {
        map[r.one_field] = effectiveRows.length
        return
      }
      const nums = effectiveRows.map((row) => Number(row[cfg.agg_field])).filter((n) => !Number.isNaN(n))
      if (!nums.length) { map[r.one_field] = 0; return }
      if (cfg.agg === 'sum') map[r.one_field] = nums.reduce((a, b) => a + b, 0)
      else if (cfg.agg === 'avg') map[r.one_field] = nums.reduce((a, b) => a + b, 0) / nums.length
      else if (cfg.agg === 'min') map[r.one_field] = Math.min(...nums)
      else if (cfg.agg === 'max') map[r.one_field] = Math.max(...nums)
    })
    return map
  }, [aggRelations, aggQueryResults, summaryAggConfigs, pendingO2MRows, pendingO2MEdits, pendingO2MDeletes])

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
    for (const f of (fieldConfig ?? [])) {
      if (f.interface !== 'inline-table') continue
      let opts: Record<string, unknown> = {}
      try { opts = f.options ? (typeof f.options === 'string' ? JSON.parse(f.options) : f.options as Record<string, unknown>) : {} } catch { continue }
      const ub = Array.isArray(opts.unique_by) ? (opts.unique_by as string[]) : null
      if (!ub?.length) continue
      const rel = relations.find((r) => r.one_field === f.field && r.one_collection === collection && !r.junction_field)
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
          !f.group_key && !f.hidden && !SYSTEM_FIELDS.has(f.field) && !isSentinelKey(f.field) &&
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
  const tabGroups = useMemo(() => groups.filter((g) => g.type === 'tab' && !g.container_id), [groups])
  // All tabs regardless of container — used for SummaryPanel coverage
  const allTabGroups = useMemo(() => groups.filter((g) => g.type === 'tab').sort((a, b) => a.sort - b.sort), [groups])
  const sectionGroups = useMemo(() => groups.filter((g) => g.type === 'section' || g.type === 'metadata'), [groups])
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
  const effectiveShowRevisions = layoutMeta ? !layoutMeta.disable_revisions && showRevisions : showRevisions
  const effectiveShowComments = layoutMeta ? !layoutMeta.disable_comments && showComments : showComments
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
    if (!accordionMode) { prevAccordionModeRef.current = false; return }
    // Re-init whenever accordion turns on (mode changes or groups change)
    if (accordionMode && !prevAccordionModeRef.current) {
      prevAccordionModeRef.current = true
      const first = sectionGroups.find((g) => !g.is_collapsed) ?? sectionGroups[0]
      if (first) setOpenSectionId(first.id)
    }
  }, [accordionMode, sectionGroups])

  const bodyRef = useRef<HTMLDivElement>(null)
  // Per-container active tab: Map<containerId, tabKey>
  const [containerTabs, setContainerTabs] = useState<Map<number, string>>(() => new Map())
  const [containerVisited, setContainerVisited] = useState<Map<number, Set<string>>>(() => new Map())
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

  const completedSteps = useMemo(() => {
    const out = new Set<string>()
    for (const s of allSteps) {
      if (isNew && !visitedSteps.has(s.key)) continue
      const stepFields =
        s.key === '__general__'
          ? (isStepsMode
              ? ungroupedFields
              : [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])])
          : (groupedMap[s.key] ?? [])
      const allFilled = stepFields
        .filter((f) => f.required && !f.hidden)
        .every((f) => {
          const v = draft[f.field]
          return v !== null && v !== undefined && v !== ''
        })
      if (allFilled) out.add(s.key)
    }
    return out
  }, [allSteps, ungroupedFields, sectionGroups, groupedMap, draft, isNew, visitedSteps, isStepsMode])

  function handleNext() {
    if (validateBeforeNext) {
      const stepFields =
        activeTab === '__general__'
          ? (isStepsMode
              ? ungroupedFields
              : [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])])
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
  const widgetSlots = assignments.filter((a) => a.field.startsWith('__widget_') && a.field.endsWith('__') && a.widget_id != null)
  const ownersSlot = assignments.find((a) => a.field === '__owners__')
  const pdfSlot = assignments.find((a) => a.field === '__pdf__')
  const pdfSlotOverrides = pdfSlot
    ? (() => { try { return typeof pdfSlot.overrides === 'string' ? JSON.parse(pdfSlot.overrides) : (pdfSlot.overrides ?? {}) } catch { return {} } })()
    : null
  const pdfAttachField = pdfSlotOverrides?.attach_to_field as string | null ?? null
  const pdfFilenameTemplate = pdfSlotOverrides?.filename_template as string | null ?? null
  const pdfGroupKey = pdfSlot?.group_key ?? null
  const pdfInGroup = !!(pdfGroupKey && groups.some((g) => g.key === pdfGroupKey))
  const handleGenerateAndAttach = async () => {
    if (pdfAttaching || !pdfAttachField || !layoutId) return
    setPdfAttaching(true)
    try {
      const workspace = typeof window !== 'undefined' ? (localStorage.getItem('nivaro_workspace') ?? '') : ''
      const resp = await fetch(`${fetchCfg.apiBase}/collection-layouts/${layoutId}/generate-and-attach`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...fetchCfg.authHeaders,
          ...(workspace ? { 'x-workspace': workspace } : {}),
        },
        credentials: fetchCfg.credentials,
        body: JSON.stringify({ collection, item_id: itemId, attach_field: pdfAttachField, filename_template: pdfFilenameTemplate }),
      })
      if (!resp.ok) throw new Error(await resp.text())
      toast.success('PDF generated and attached')
      qc.invalidateQueries({ queryKey: ['m2m-items'] })
      qc.invalidateQueries({ queryKey: ['items', collection, itemId] })
    } catch {
      toast.error('Failed to generate and attach PDF')
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

  const headerWidgets = useMemo(() => (activeLayoutData?.assignments ?? [])
    .filter((a) => a.field.startsWith('__widget_') && a.field.endsWith('__') && a.widget_id != null && (a.group_key ?? null) === '__header__')
    .map((ws) => ({
      field: ws.field,
      widgetId: ws.widget_id!,
      label: ws.label_override ?? null,
      sort: ws.sort ?? 0,
      inputBindings: typeof ws.input_bindings === 'string'
        ? (JSON.parse(ws.input_bindings) as InputBinding[])
        : [] as InputBinding[],
    })), [activeLayoutData])

  const fieldInlineDisplay = useMemo(() => {
    const out: Record<string, { entries: Array<{ field: string; label: string | null; format: string | null }>; separator: string | null }> = {}
    for (const a of (activeLayoutData?.assignments ?? [])) {
      if (!a.field || a.field.startsWith('__')) continue
      try {
        const raw = (a as unknown as Record<string, unknown>).input_bindings
        const parsed: Array<{ key: string; binding_value: string }> = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const entry = parsed.find((b) => b.key === '__inline_display__')
        if (entry?.binding_value) {
          const data = JSON.parse(entry.binding_value)
          const isArray = Array.isArray(data)
          const entries = isArray ? data : (data.fields ?? [])
          const separator: string | null = isArray ? null : (data.separator ?? null)
          if (Array.isArray(entries) && entries.length) out[a.field] = { entries, separator }
        }
      } catch { /* noop */ }
    }
    return out
  }, [activeLayoutData])

  const subtitleConfig = useMemo(() => {
    const row = (activeLayoutData?.assignments ?? []).find((a) => a.field === '__subtitle__')
    if (!row) return null
    try {
      const raw = (row as unknown as Record<string, unknown>).input_bindings
      const parsed: Array<{ key: string; binding_value: string }> = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
      const entry = parsed.find((b) => b.key === '__subtitle_config__')
      if (!entry?.binding_value) return null
      const data = JSON.parse(entry.binding_value)
      if (!data.fields || !Array.isArray(data.fields) || !data.fields.length) return null
      return { fields: data.fields as Array<{ field: string; label: string | null; color?: string; weight?: string; display_as?: string }>, separator: (data.separator as string) ?? ' | ' }
    } catch { return null }
  }, [activeLayoutData])

  const subtitleFieldSet = useMemo<Set<string>>(
    () => new Set((subtitleConfig?.fields ?? []).map((sf) => sf.field)),
    [subtitleConfig]
  )

  const subtitleParts = useMemo(() => {
    if (!subtitleConfig || isNew) return []
    const src = (itemData as Record<string, unknown> | null) ?? draft
    return subtitleConfig.fields
      .map((sf) => {
        const val = src[sf.field]
        if (val === null || val === undefined || val === '') return null
        return { value: String(val), color: sf.color, weight: sf.weight, display_as: sf.display_as }
      })
      .filter(Boolean) as Array<{ value: string; color?: string; weight?: string; display_as?: string }>
  }, [subtitleConfig, isNew, itemData, draft])

  const headerFields = useMemo(() => (activeLayoutData?.assignments ?? [])
    .filter((a) => (a.field === '__owners__' || !a.field.startsWith('__')) && (a.group_key ?? null) === '__header__')
    .map((a) => {
      const meta = (fieldConfig ?? []).find((f) => f.field === a.field)
      let displayFormat = 'text'
      let color: string | undefined
      let weight: string | undefined
      let displayAs: string | undefined
      try {
        const raw = (a as unknown as Record<string, unknown>).input_bindings
        const parsed: Array<{ key: string; binding_value: string }> = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const fmt = parsed.find((b) => b.key === '__display_format__')
        if (fmt?.binding_value) displayFormat = fmt.binding_value
        color = parsed.find((b) => b.key === '__color__')?.binding_value || undefined
        weight = parsed.find((b) => b.key === '__weight__')?.binding_value || undefined
        displayAs = parsed.find((b) => b.key === '__display_as__')?.binding_value || undefined
      } catch { /* noop */ }
      return {
        field: a.field,
        label: a.label_override ?? titleCase(meta?.label ?? a.field),
        sort: a.sort ?? 0,
        displayFormat,
        color,
        weight,
        displayAs,
        cmsField: meta ?? null,
      }
    }), [activeLayoutData, fieldConfig])

  useEffect(() => {
    if (!onHeaderWidgets) return
    onHeaderWidgets(headerWidgets)
  }, [headerWidgets, onHeaderWidgets])

  const sectionOrder = useMemo(() => {
    const isVisible = (a: SlotAssignment | undefined) =>
      !(a && (a.is_visible === 0 || a.is_visible === false))
    type Item = FieldGroup | '__ungrouped__' | '__pipeline__' | '__comments__' | '__tasks__' | '__addendums__' | '__owners__' | '__pdf__' | string
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
          if (subtitleFieldSet.size > 0 && ungroupedFields.some((f) => subtitleFieldSet.has(f.field))) {
            const slotSorts = [
              showPipeline && pipelineSlot ? pipelineSlot.sort : null,
              effectiveShowTasks && tasksSlot ? tasksSlot.sort : null,
              effectiveShowComments && commentsSlot ? commentsSlot.sort : null,
              showPipeline && ownersSlot && !ownersInGroup ? ownersSlot.sort : null,
              pdfSlot && !isNew && !pdfInGroup ? pdfSlot.sort : null,
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
    if (showPipeline && ownersSlot && isVisible(ownersSlot) && !ownersInGroup && ownersGroupKey !== '__header__')
      entries.push({ item: '__owners__', sort: ownersSlot.sort, tie: 5 })
    if (pdfSlot && isVisible(pdfSlot) && !isNew && !pdfInGroup)
      entries.push({ item: '__pdf__', sort: pdfSlot.sort, tie: 6 })
    // Widget slots never render as standalone panels — they appear in groups (GroupSection)
    // or in the page header (__header__ group_key). Skip all of them here.
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
    ownersGroupKey
  ])

  // ── Client-side validation ─────────────────────────────────────────────────
  function validateAll(): boolean {
    const errs: Record<string, string> = {}
    for (const f of allFields) {
      if (f.hidden || f.readonly || SYSTEM_FIELDS.has(f.field) || isSentinelKey(f.field)) continue
      if (f.required) {
        if (f.field in fieldCounts) {
          if (fieldCounts[f.field] === 0) errs[f.field] = 'This field is required'
        } else {
          const v = draft[f.field]
          if (v === null || v === undefined || v === '') errs[f.field] = 'This field is required'
        }
      }
    }
    if (Object.keys(errs).length > 0) {
      setValidationErrors(errs)
      toast.error('Please fill in all required fields')
      return false
    }
    return true
  }

  function handleSave() {
    if (!validateAll()) return
    saveMut.mutate()
  }

  // ── Save / delete ──────────────────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: async () => {
      function errMsg(err: unknown): string {
        const resp = (err as { response?: { data?: { error?: string } } })?.response
        return resp?.data?.error ?? (err instanceof Error ? err.message : 'Failed')
      }

      // Build step list from pending state
      const hasM2M = [...m2mLinks.entries()].some(([, ids]) => ids.length > 0) ||
                     [...m2mUnlinks.entries()].some(([, ids]) => ids.size > 0)
      const newO2MKeys = [...pendingO2MRows.entries()].filter(([, r]) => r.length > 0).map(([k]) => k)
      const editO2MKeys = [...pendingO2MEdits.entries()].filter(([, e]) => e.size > 0).map(([k]) => k)
      const delO2MKeys = [...pendingO2MDeletes.entries()].filter(([, d]) => d.size > 0).map(([k]) => k)

      // Detail strings — count only fields that actually changed
      const changedCount = isNew
        ? allFields.filter(f => !SYSTEM_FIELDS.has(f.field) && !f.readonly && f.field in draft).length
        : allFields.filter(f => {
            if (SYSTEM_FIELDS.has(f.field) || f.readonly || !(f.field in draft)) return false
            return !valuesEqual(draft[f.field], initialDataRef.current[f.field])
          }).length
      const mainDetail = isNew
        ? `${changedCount} field${changedCount !== 1 ? 's' : ''} set`
        : changedCount === 0
          ? 'No field changes'
          : `${changedCount} field${changedCount !== 1 ? 's' : ''} changed`

      let m2mAdds = 0, m2mRemoves = 0
      for (const [, ids] of m2mLinks.entries()) m2mAdds += ids.length
      for (const [, ids] of m2mUnlinks.entries()) m2mRemoves += ids.size
      const m2mDetail = [
        m2mAdds > 0 ? `+${m2mAdds} linked` : '',
        m2mRemoves > 0 ? `-${m2mRemoves} unlinked` : ''
      ].filter(Boolean).join(' · ')

      const flushers = [...gridFlushersRef.current.entries()]
      const steps: SaveStepItem[] = [
        ...(flushers.length > 0 ? [{ id: 'flush', label: 'Save attachments', status: 'pending' as SaveStepStatus, detail: `${flushers.length} field${flushers.length !== 1 ? 's' : ''} with pending changes` }] : []),
        { id: 'main', label: isNew ? `Create ${colMeta?.singular || titleCase(collection)}` : `Save ${colMeta?.singular || titleCase(collection)}`, status: 'pending', detail: mainDetail },
        ...(hasM2M ? [{ id: 'm2m', label: 'Update relationships', status: 'pending' as SaveStepStatus, detail: m2mDetail }] : []),
        ...newO2MKeys.map(k => {
          const n = pendingO2MRows.get(k)?.length ?? 0
          return { id: `o2m:new:${k}`, label: `Add ${titleCase(k.split('.')[0])}`, status: 'pending' as SaveStepStatus, detail: `${n} new row${n !== 1 ? 's' : ''}`, progress: { done: 0, total: n } }
        }),
        ...editO2MKeys.map(k => {
          const n = pendingO2MEdits.get(k)?.size ?? 0
          return { id: `o2m:edit:${k}`, label: `Update ${titleCase(k.split('.')[0])}`, status: 'pending' as SaveStepStatus, detail: `${n} row${n !== 1 ? 's' : ''} edited`, progress: { done: 0, total: n } }
        }),
        ...delO2MKeys.map(k => {
          const n = pendingO2MDeletes.get(k)?.size ?? 0
          return { id: `o2m:del:${k}`, label: `Remove from ${titleCase(k.split('.')[0])}`, status: 'pending' as SaveStepStatus, detail: `${n} row${n !== 1 ? 's' : ''} deleted`, progress: { done: 0, total: n } }
        }),
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
      let savedId: string
      try {
        if (isNew) {
          const r = await client.request<{ data: { id: string | number } }>(post(`/items/${collection}`, payload))
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
        const msg = errMsg(err)
        updateStep('main', { status: 'error', error: msg })
        const resp = (err as { response?: { data?: { error?: string; field?: string } } })?.response
        if (resp?.data?.field) setValidationErrors({ [resp.data.field]: resp.data.error ?? 'Invalid' })
        throw err
      }

      // ── M2M ───────────────────────────────────────────────────────────────
      const findM2MRel = (stagingKey: string): (CMSRelation & { junction_field: string }) | null => {
        const byField = relations.find(r => r.one_field === stagingKey && r.one_collection === collection)
        if (byField) {
          const jf = byField.junction_field ?? relations.find(c => c.many_collection === byField.many_collection && c.id !== byField.id)?.many_field ?? null
          return jf ? { ...byField, junction_field: jf } : null
        }
        const parts = stagingKey.split('.')
        if (parts.length === 2) {
          const [mc, jf] = parts
          const r = relations.find(rel => rel.many_collection === mc)
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
            for (const jId of ids) m2mOps.push(client.request(del(`/items/${rel.many_collection}/${jId}`)).catch(() => {}))
          }
          for (const [key, ids] of m2mLinks.entries()) {
            if (!ids.length) continue
            const rel = findM2MRel(key)
            if (!rel) continue
            for (const relId of ids) m2mOps.push(client.request(post(`/items/${rel.many_collection}`, { [rel.many_field!]: savedId, [rel.junction_field]: relId })).catch(() => {}))
          }
          await Promise.all(m2mOps)
          updateStep('m2m', { status: 'done' })
        } catch (err) {
          updateStep('m2m', { status: 'error', error: errMsg(err) })
        }
      }

      // ── Comments (new only) ────────────────────────────────────────────────
      if (isNew && pendingComments.length > 0) {
        await Promise.all(pendingComments.map(text => client.request(post('/comments', { collection, item: savedId, text })).catch(() => {})))
      }

      // ── O2M new rows ───────────────────────────────────────────────────────
      for (const key of newO2MKeys) {
        const stepId = `o2m:new:${key}`
        const [rc, mf] = key.split('.')
        const rowList = pendingO2MRows.get(key) ?? []
        const uniqueBy = o2mUniqueByMap.get(key)
        if (uniqueBy?.length) {
          const getUK = (r: Record<string, unknown>) => uniqueBy.map(f => String(r[f] ?? '')).join('\x00')
          const seen = new Set<string>()
          const hasDup = rowList.some((r) => { const k = getUK(r); if (seen.has(k)) return true; seen.add(k); return false })
          if (hasDup) {
            updateStep(stepId, { status: 'error', error: `Duplicate ${uniqueBy.join(' + ')} values in new rows` })
            continue
          }
        }
        updateStep(stepId, { status: 'running', progress: { done: 0, total: rowList.length } })
        try {
          await Promise.all(rowList.map(async (data) => {
            await client.request(post(`/items/${rc}`, { ...data, [mf]: savedId }))
            updateStep(stepId, (s) => ({ progress: { done: (s.progress?.done ?? 0) + 1, total: rowList.length } }))
          }))
          updateStep(stepId, { status: 'done' })
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
        await Promise.all([...edits.entries()].map(async ([rowId, changes]) => {
          await client.request(patch(`/items/${rc}/${rowId}`, changes)).catch(err => { hasErr = true; updateStep(stepId, { status: 'error', error: errMsg(err) }) })
          updateStep(stepId, (s) => ({ progress: { done: (s.progress?.done ?? 0) + 1, total: edits.size } }))
        }))
        if (!hasErr) { updateStep(stepId, { status: 'done' }); nextEdits.delete(key) }
      }
      setPendingO2MEdits(nextEdits)

      // ── O2M deletes ───────────────────────────────────────────────────────
      const nextDels = new Map(pendingO2MDeletes)
      for (const key of delO2MKeys) {
        const stepId = `o2m:del:${key}`
        const [rc] = key.split('.')
        const dels = pendingO2MDeletes.get(key) ?? new Set()
        updateStep(stepId, { status: 'running', progress: { done: 0, total: dels.size } })
        let hasErr = false
        await Promise.all([...dels].map(async (rowId) => {
          await client.request(del(`/items/${rc}/${rowId}`)).catch(err => { hasErr = true; updateStep(stepId, { status: 'error', error: errMsg(err) }) })
          updateStep(stepId, (s) => ({ progress: { done: (s.progress?.done ?? 0) + 1, total: dels.size } }))
        }))
        if (!hasErr) { updateStep(stepId, { status: 'done' }); nextDels.delete(key) }
      }
      setPendingO2MDeletes(nextDels)

      // ── Tasks (new only) ──────────────────────────────────────────────────
      if (isNew && pendingTasks.length > 0) {
        await Promise.all(pendingTasks.map(t =>
          client.request(post('/tasks', { collection, item: savedId, title: t.title, assignee: t.assignee, due_date: t.due_date || undefined })).catch(() => {})
        ))
      }

      return savedId
    },
    onSuccess: (id) => {
      setIsDirty(false)
      setM2mLinks(new Map())
      setM2mUnlinks(new Map())
      setPendingComments([])
      setPendingTasks([])
      // Invalidate O2M row queries for every relation that had pending changes
      const o2mKeysToInvalidate = new Set([
        ...pendingO2MRows.keys(),
        ...pendingO2MEdits.keys(),
        ...pendingO2MDeletes.keys(),
      ])
      for (const key of o2mKeysToInvalidate) {
        const dotIdx = key.indexOf('.')
        const rc = key.slice(0, dotIdx)
        const mf = key.slice(dotIdx + 1)
        qc.invalidateQueries({ queryKey: ['o2m-rows', rc, mf, id] })
      }
      setPendingO2MRows(new Map())
      qc.invalidateQueries({ queryKey: ['item', collection] })
      qc.invalidateQueries({ queryKey: ['m2m-items'] })
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
  if (hasLockConditions) {
    const currentRole = currentUserData?.role ?? null
    const currentStateId = pipelineInstanceData?.instance?.current_state ?? null
    const currentStateKey = currentStateId
      ? (pipelineInstanceData?.states ?? []).find((s) => s.id === currentStateId)?.key ?? null
      : null
    for (const a of assignments) {
      if (!a.lock_conditions) continue
      let conds: Array<{ type: string; state_keys?: string[]; role_ids?: string[] }> = []
      try { conds = JSON.parse(a.lock_conditions) } catch { continue }
      const locked = conds.some((c) => {
        if (c.type === 'pipeline_state' && c.state_keys?.length) return c.state_keys.includes(currentStateKey ?? '')
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
          collection={collection}
          item={itemId}
          title={pipelineSlot?.label_override ?? undefined}
          defaultExpanded={pipelineSlot?.default_expanded ?? false}
          showApprovalChain={!!(pipelineSlot as unknown as Record<string, unknown>)?.show_approval_chain}
          onBeforeTransition={validateAll}
          addendumPending={activeAddendumCount > 0 && !!colMeta?.addendums_enabled}
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
    if (key === '__owners__' && showPipeline) {
      return <div key='__owners__'>{renderOwnersPanel()}</div>
    }
    if (key.startsWith('__widget_') && key.endsWith('__')) {
      const slot = widgetSlots.find((a) => a.field === key)
      if (!slot || !slot.widget_id) return null
      let bindings: InputBinding[] = []
      try { bindings = typeof slot.input_bindings === 'string' ? JSON.parse(slot.input_bindings) : [] } catch { /* noop */ }
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
    if (key === '__pdf__') {
      const layoutId = activeLayoutData?.layout?.id
      if (!layoutId) return null
      const label = pdfSlot?.label_override?.trim() || 'Generate PDF'
      const notConfigured = !pdfAttachField
      return (
        <div key='__pdf__' className='flex items-center gap-2 px-1'>
          <button
            type='button'
            onClick={handleGenerateAndAttach}
            disabled={pdfAttaching || notConfigured}
            title={notConfigured ? 'Configure PDF field in Data Model → Layouts' : undefined}
            className='inline-flex items-center gap-1.5 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/10 px-3 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-nvr-cyan'
          >
            <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' className='h-3.5 w-3.5'>
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
          {(cw) => visible.map((f) => {
            const inlineConfig = fieldInlineDisplay?.[f.field]
            const inlineEntries = inlineConfig?.entries
            const inlineSeparator = inlineConfig?.separator ?? null
            const rawVal = draft[f.field]
            const hasVal = rawVal !== null && rawVal !== undefined && rawVal !== ''
            const inlineRelCollection = (inlineEntries?.length && hasVal)
              ? (relations.find((r) => r.many_collection === collection && r.many_field === f.field && !r.junction_field)?.one_collection ?? null)
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
          })}
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
      try { return activeChild?.swap_config ? JSON.parse(activeChild.swap_config) as { enabled: boolean; primary_field: string; alternate_fields: ({ field: string; width: 1 | 2 } | string)[]; toggle_label?: string; back_label?: string } : null } catch { return null }
    })()
    const normActiveAlts = (activeSwapCfg?.alternate_fields ?? []).map(x => typeof x === 'string' ? { field: x, width: 2 as const } : x)
    const activeIsSwapped = activeSwapCfg?.enabled ? swappedGroups.has(activeChild?.id ?? -1) : false
    const activeFields = (groupedMap[activeChild?.key ?? ''] ?? []).filter((f) => !f.hidden)
    // PDF slot: check if assigned to the active child tab or to the container itself
    const pdfInContainer = !isNew && !!layoutId && !!pdfSlot && (
      pdfGroupKey === activeChild?.key || pdfGroupKey === c.key
    )

    const containerCompleted = new Set<string>()
    const containerErrors = new Set<string>()
    for (const ch of children) {
      if (isNew && !isContainerTabVisited(c, ch.key)) continue
      const chFields = groupedMap[ch.key] ?? []
      const hasError = chFields.some((f) => validationErrors[f.field])
      if (hasError) containerErrors.add(ch.key)
      const requiredFields = chFields.filter((f) => f.required && !f.hidden)
      const allFilled = requiredFields.length === 0 || requiredFields.every((f) => { const v = draft[f.field]; return v !== null && v !== undefined && v !== '' })
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
            {(cw) => activeFields.map((f) => {
              const inlineConfig = fieldInlineDisplay?.[f.field]
              const inlineEntries = inlineConfig?.entries
              const inlineSeparator = inlineConfig?.separator ?? null
              const rawVal = draft[f.field]
              const hasVal = rawVal !== null && rawVal !== undefined && rawVal !== ''
              const inlineRelCollection = (inlineEntries?.length && hasVal)
                ? (relations.find((r) => r.many_collection === collection && r.many_field === f.field && !r.junction_field)?.one_collection ?? null)
                : null
              const isPrimarySwapField = activeSwapCfg?.enabled && f.field === activeSwapCfg.primary_field
              const primaryHasVal = (() => { const v = draft[activeSwapCfg?.primary_field ?? '']; return v !== null && v !== undefined && v !== '' })()
              const altHasVal = normActiveAlts.some((a) => { const v = draft[a.field]; return v !== null && v !== undefined && v !== '' })
              const swapToggleBtn = isPrimarySwapField ? (
                <span className='inline-flex items-center gap-1.5'>
                  <button
                    type='button'
                    onClick={() => setSwappedGroups((prev) => { const next = new Set(prev); if (next.has(activeChild!.id)) next.delete(activeChild!.id); else next.add(activeChild!.id); return next })}
                    className='inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/10 transition-colors'
                  >
                    {activeIsSwapped ? (activeSwapCfg!.back_label ?? 'Back') : (activeSwapCfg!.toggle_label ?? 'Enter manually')}
                  </button>
                  <span className={['inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium', primaryHasVal ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'].join(' ')}>
                    <span className={['h-1.5 w-1.5 rounded-full', primaryHasVal ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'].join(' ')} />
                    Original
                  </span>
                  <span className={['inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium', altHasVal ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'].join(' ')}>
                    <span className={['h-1.5 w-1.5 rounded-full', altHasVal ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'].join(' ')} />
                    Manual
                  </span>
                </span>
              ) : undefined
              const swapContentNode = isPrimarySwapField && activeIsSwapped ? (
                <div className='mt-2 rounded-lg border border-slate-200 bg-slate-50 dark:border-border dark:bg-slate-900/40 p-3'>
                <div className='grid grid-cols-2 gap-3'>
                  {normActiveAlts.map((a) => {
                    const af = (fieldConfig ?? []).find(fc => fc.field === a.field)
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
                <div key={f.field} style={{ gridColumn: `span ${resolveColSpan(f.options, cw)}` }}>
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
                    <InlineDisplay relCollection={inlineRelCollection} relId={rawVal as string | number} entries={inlineEntries} separator={inlineSeparator} />
                  )}
                </div>
              )
            })}
          </GridContainer>
          {pdfInContainer && (
            <div className='mt-4 flex items-center gap-2'>
              <button
                type='button'
                onClick={handleGenerateAndAttach}
                disabled={pdfAttaching || !pdfAttachField}
                title={!pdfAttachField ? 'Configure PDF field in Data Model → Layouts' : undefined}
                className='inline-flex items-center gap-1.5 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/10 px-3 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-nvr-cyan'
              >
                <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' className='h-3.5 w-3.5'>
                  <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
                  <polyline points='14 2 14 8 20 8' />
                  <line x1='9' y1='13' x2='15' y2='13' />
                  <line x1='9' y1='17' x2='13' y2='17' />
                </svg>
                {pdfAttaching ? 'Generating…' : (pdfSlot?.label_override?.trim() || 'Generate PDF')}
              </button>
            </div>
          )}
          {c.tab_mode === 'steps' && children.length > 1 && (() => {
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
                  <span className='text-[11px] text-slate-400'>Step {idx + 1} of {children.length}</span>
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
    item: FieldGroup | '__ungrouped__' | '__pipeline__' | '__comments__' | '__tasks__' | '__owners__' | '__pdf__' | string
  ) {
    if (item === '__ungrouped__') return renderUngrouped()
    if (typeof item === 'string' && item !== '__ungrouped__') return renderSentinel(item)
    const g = item as FieldGroup
    if (g.type === 'container') return renderContainer(g)
    if (g.type === 'metadata' && isNew) return null
    const swapCfg = (() => {
      try { return g.swap_config ? JSON.parse(g.swap_config) as { enabled: boolean; primary_field: string; alternate_fields: ({ field: string; width: 1 | 2 } | string)[]; toggle_label?: string; back_label?: string } : null } catch { return null }
    })()
    const normAlts = (swapCfg?.alternate_fields ?? []).map(x => typeof x === 'string' ? { field: x, width: 2 as const } : x)
    const isSwapped = swapCfg?.enabled ? swappedGroups.has(g.id) : false
    const baseFields = groupedMap[g.key] ?? []
    const groupFields = baseFields
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
        onSwapToggle={swapCfg?.enabled ? () => setSwappedGroups((prev) => {
          const next = new Set(prev)
          if (next.has(g.id)) next.delete(g.id); else next.add(g.id)
          return next
        }) : undefined}
        alternateFields={swapCfg?.enabled ? (fieldConfig ?? []).filter((af) => normAlts.some(a => a.field === af.field)) : undefined}
        alternateWidths={swapCfg?.enabled ? Object.fromEntries(normAlts.map(a => [a.field, a.width])) : undefined}
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
          <PipelinePanel collection={collection} item={itemId} onBeforeTransition={validateAll} addendumPending={activeAddendumCount > 0 && !!colMeta?.addendums_enabled} />
        )}
        {!tasksSlot && effectiveShowTasks && <TaskPanel collection={collection} item={itemId} queuedTasks={isNew ? pendingTasks : undefined} onQueueTask={isNew ? handleQueueTask : undefined} />}
        {!commentsSlot && effectiveShowComments && (
          <CommentPanel collection={collection} item={itemId} queuedComments={isNew ? pendingComments : undefined} onQueueComment={isNew ? handleQueueComment : undefined} />
        )}
        {showWorkflow && <WorkflowPanel collection={collection} item={itemId} />}
        {!addendumSlot && activeLayoutData !== undefined && colMeta?.addendums_enabled && !isNew && (
          <AddendumPanel
            collection={collection}
            item={itemId}
            addendumLayoutId={activeLayoutData?.layout?.addendum_layout_id ?? null}
            canCreate={addendumCanCreate}
            onActiveCountChange={setActiveAddendumCount}
          />
        )}
      </div>
    )
  }

  // ── Tab mode ───────────────────────────────────────────────────────────────
  function renderTabContent(tabKey: string, inStepsMode = false) {
    const fields = (
      tabKey === '__general__'
        ? (inStepsMode
            ? ungroupedFields
            : [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])])
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
    const tabItems: TabItem[] = fields.map((f) => ({ _k: f.field, sort: f.sort ?? 0, _t: 'field' as const, f }))
    if (ownersHere && ownersSlot) {
      tabItems.push({ _k: '__owners__', sort: ownersSlot.sort, _t: 'owners' as const, slot: ownersSlot })
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
          {(cw) => tabItems.map((item) => {
            if (item._t === 'owners') {
              const span = item.slot.col_span ?? 12
              return (
                <div key='__owners__' style={{ gridColumn: `span ${span}` }}>
                  <OwnersInline collection={collection} itemId={itemId} label={item.slot.label_override || 'Owners'} />
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
                    onClick={handleGenerateAndAttach}
                    disabled={pdfAttaching || notConfigured}
                    title={notConfigured ? 'Configure PDF field in Data Model → Layouts' : undefined}
                    className='inline-flex items-center gap-1.5 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/10 px-3 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-nvr-cyan'
                  >
                    <svg xmlns='http://www.w3.org/2000/svg' className='h-3.5 w-3.5' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
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
            const inlineRelCollection = (inlineEntries?.length && hasVal)
              ? (relations.find((r) => r.many_collection === collection && r.many_field === f.field && !r.junction_field)?.one_collection ?? null)
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
          })}
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
          <PipelinePanel collection={collection} item={itemId} onBeforeTransition={validateAll} addendumPending={activeAddendumCount > 0 && !!colMeta?.addendums_enabled} />
        )}
        {!tasksSlot && effectiveShowTasks && <TaskPanel collection={collection} item={itemId} queuedTasks={isNew ? pendingTasks : undefined} onQueueTask={isNew ? handleQueueTask : undefined} />}
        {!commentsSlot && effectiveShowComments && (
          <CommentPanel collection={collection} item={itemId} queuedComments={isNew ? pendingComments : undefined} onQueueComment={isNew ? handleQueueComment : undefined} />
        )}
        {showWorkflow && <WorkflowPanel collection={collection} item={itemId} />}
        {!addendumSlot && activeLayoutData !== undefined && colMeta?.addendums_enabled && !isNew && (
          <AddendumPanel
            collection={collection}
            item={itemId}
            addendumLayoutId={activeLayoutData?.layout?.addendum_layout_id ?? null}
            canCreate={addendumCanCreate}
            onActiveCountChange={setActiveAddendumCount}
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
                collection={collection}
                item={itemId}
                onBeforeTransition={() => {
                  if (!validateAll()) return false
                  if (isDirty) {
                    toast.error('Save changes before transitioning')
                    return false
                  }
                  return true
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
          errorSteps={new Set(
            allSteps
              .filter((s) => (groupedMap[s.key] ?? []).some((f) => validationErrors[f.field]))
              .map((s) => s.key)
          )}
          onStepClick={setActiveTab}
        />
        {renderTabContent(activeTab, true)}
        {postTabItems.map((item, i) => {
          const key = typeof item === 'string' ? item : (item as FieldGroup).key
          return <div key={key ?? i}>{renderSectionItem(item as FieldGroup | string)}</div>
        })}
        {!pipelineSlot && showPipeline && (
          <PipelinePanel collection={collection} item={itemId} defaultExpanded={false} onBeforeTransition={validateAll} addendumPending={activeAddendumCount > 0 && !!colMeta?.addendums_enabled} />
        )}
        {!tasksSlot && effectiveShowTasks && (
          <TaskPanel collection={collection} item={itemId} defaultExpanded={false} queuedTasks={isNew ? pendingTasks : undefined} onQueueTask={isNew ? handleQueueTask : undefined} />
        )}
        {!commentsSlot && effectiveShowComments && (
          <CommentPanel collection={collection} item={itemId} defaultExpanded={false} queuedComments={isNew ? pendingComments : undefined} onQueueComment={isNew ? handleQueueComment : undefined} />
        )}
        {showWorkflow && <WorkflowPanel collection={collection} item={itemId} />}
        {!addendumSlot && activeLayoutData !== undefined && colMeta?.addendums_enabled && !isNew && (
          <AddendumPanel
            collection={collection}
            item={itemId}
            addendumLayoutId={activeLayoutData?.layout?.addendum_layout_id ?? null}
            canCreate={addendumCanCreate}
            onActiveCountChange={setActiveAddendumCount}
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

  // ── Loading state ──────────────────────────────────────────────────────────
  const isLoading = fieldsLoading || (!isNew && itemLoading)
  if (isLoading) {
    return (
      <div className={cn('flex flex-1 min-h-0 flex-col', className)}>
        {showHeader && (
          <div className='shrink-0 border-b px-6 py-4 flex items-center gap-3'>
            <Skeleton className='h-6 w-40' />
          </div>
        )}
        <div className='flex-1 overflow-y-auto p-6 space-y-4'>
          <Skeleton className='h-40 rounded-xl' />
          <Skeleton className='h-32 rounded-xl' />
        </div>
      </div>
    )
  }

  const title = colMeta?.display_name ?? titleCase(collection ?? '')
  const singularTitle = colMeta?.singular || title
  const itemTitle = !isNew && itemData && colMeta?.display_template
    ? applyDisplayTemplate(colMeta.display_template, itemData as Record<string, unknown>)
    : title
  const canDelete = !isNew && isAdmin && effectiveShowDelete

  return (
    <RelationPathDataContext.Provider value={relationPathData}>
    <AddendumO2MContext.Provider value={addendumO2MMap}>
    <AddendumViewContext.Provider value={addendumViewId}>
    <AddendumFieldContext.Provider value={addendumFieldMap}>
    <ParentDraftContext.Provider value={{ draft, collection }}>
    <GridFlushContext.Provider value={isNew ? null : gridFlushCtx}>
    <O2MStagingContext.Provider value={o2mStagingCtx}>
    <M2MStagingContext.Provider value={m2mStagingCtx}>
      <SaveProgressDialog
        open={saveDialogOpen}
        steps={saveSteps}
        onClose={() => setSaveDialogOpen(false)}
      />
      <div className={cn('flex flex-1 min-h-0 flex-col', className)}>
        {showHeader && (
          <header
            className={cn(
              'shrink-0 border-b border-slate-200 dark:border-border bg-white dark:bg-card px-8 py-3.5 flex items-center gap-3',
              headerClassName
            )}
          >
            {onBack && (
              <button
                type='button'
                onClick={onBack}
                className='shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-100'
              >
                <ArrowLeft className='h-4 w-4' />
              </button>
            )}
            <div className='flex min-w-0 flex-col'>
              <div className='group/title flex items-center gap-1.5'>
                <h1 className='truncate text-[17px] font-bold leading-tight text-slate-900 dark:text-slate-50'>
                  {isNew ? `New ${singularTitle}` : itemTitle}
                </h1>
                {!isNew && itemTitle && (
                  copiedHeaderField === '__title__'
                    ? <Check className='h-3 w-3 shrink-0 text-emerald-500' />
                    : (
                      <button
                        type='button'
                        className='cursor-pointer opacity-0 transition-opacity group-hover/title:opacity-100'
                        onClick={() => {
                          navigator.clipboard.writeText(itemTitle ?? '').catch(() => {})
                          setCopiedHeaderField('__title__')
                          setTimeout(() => setCopiedHeaderField((prev) => prev === '__title__' ? null : prev), 1500)
                        }}
                      >
                        <Copy className='h-3 w-3 text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400' />
                      </button>
                    )
                )}
              </div>
              {subtitleParts.length > 0 && (
                <div className='group/subtitle mt-0.5 flex flex-wrap items-center gap-1'>
                  {subtitleParts.map((p, i) => {
                    const weightClass = p.weight === 'bold' ? 'font-bold' : p.weight === 'semibold' ? 'font-semibold' : p.weight === 'medium' ? 'font-medium' : 'font-normal'
                    const colorClass = p.color === 'cyan' ? 'text-nvr-cyan' : p.color === 'blue' ? 'text-blue-600 dark:text-blue-400' : p.color === 'green' ? 'text-emerald-600 dark:text-emerald-400' : p.color === 'amber' ? 'text-amber-600 dark:text-amber-400' : p.color === 'red' ? 'text-red-600 dark:text-red-400' : p.color === 'purple' ? 'text-purple-600 dark:text-purple-400' : 'text-slate-500 dark:text-slate-400'
                    const isPill = p.display_as === 'pill'
                    const isTag = p.display_as === 'tag'
                    const sep = subtitleConfig?.separator ?? ' | '
                    return (
                      <span key={i} className='flex items-center gap-1'>
                        {i > 0 && !isPill && !isTag && <span className='text-[11px] text-slate-300 dark:text-slate-600'>{sep}</span>}
                        <span className={[
                          'text-[12px]',
                          weightClass,
                          colorClass,
                          isPill ? 'rounded-full px-2 py-0.5 bg-current/10 text-[11px]' : '',
                          isTag ? 'rounded px-1.5 py-0.5 border border-current/30 text-[11px]' : '',
                        ].filter(Boolean).join(' ')}>
                          {p.value}
                        </span>
                      </span>
                    )
                  })}
                  {copiedHeaderField === '__subtitle__'
                    ? <Check className='h-3 w-3 shrink-0 text-emerald-500' />
                    : (
                      <button
                        type='button'
                        className='cursor-pointer opacity-0 transition-opacity group-hover/subtitle:opacity-100'
                        onClick={() => {
                          const sep = subtitleConfig?.separator ?? ' | '
                          const text = subtitleParts.map((p) => p.value).join(sep)
                          navigator.clipboard.writeText(text).catch(() => {})
                          setCopiedHeaderField('__subtitle__')
                          setTimeout(() => setCopiedHeaderField((prev) => prev === '__subtitle__' ? null : prev), 1500)
                        }}
                      >
                        <Copy className='h-3 w-3 text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400' />
                      </button>
                    )
                  }
                </div>
              )}
            </div>
            <div className='ml-auto flex items-center gap-1.5'>
              {isNew && (
                <ImportFromFileButton collection={collection} onParsed={applyImportResult} />
              )}
              {(effectiveShowRevisions && !isNew) || (effectiveShowClone && !isNew && isAdmin) || canDelete ? (
                <>
                  {effectiveShowRevisions && !isNew && (
                    <RevisionsPanel
                      collection={collection}
                      item={itemId}
                      onRollback={() =>
                        qc.invalidateQueries({ queryKey: ['item', collection, itemId] })
                      }
                    />
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
                        <span className='text-sm text-muted-foreground'>Delete?</span>
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
                    ) : (
                      <Save className='h-3.5 w-3.5' />
                    )}
                    {isNew ? 'Create' : 'Save'}
                  </Button>
                </div>
              )}
              {!isNew && showPipeline && !isStepsMode && (
                <PipelineTransitionButtons
                  collection={collection}
                  item={itemId}
                  onBeforeTransition={() => {
                    if (!validateAll()) return false
                    if (isDirty) {
                      toast.error('Save changes before transitioning')
                      return false
                    }
                    return true
                  }}
                />
              )}
            </div>
          </header>
        )}

        {showHeader && (headerWidgets.length > 0 || headerFields.length > 0) && (
          <div className='flex shrink-0 overflow-x-auto border-slate-100 border-slate-200 dark:border-border bg-white dark:bg-card shadow-[0_2px_6px_-2px_rgba(0,0,0,0.06)] px-4'>
            {[
              ...headerWidgets.map((w) => ({ type: 'widget' as const, sort: w.sort, key: w.field, data: w })),
              ...headerFields.map((f) => ({ type: 'field' as const, sort: f.sort, key: f.field, data: f })),
            ]
              .sort((a, b) => a.sort - b.sort)
              .map((item) => {
                const copyCell = (el: HTMLElement | null, field: string) => {
                  if (!el) return
                  const clone = el.cloneNode(true) as HTMLElement
                  clone.querySelectorAll('[data-copy-skip], button').forEach((n) => n.remove())
                  const text = clone.textContent?.trim() ?? ''
                  if (text) {
                    navigator.clipboard.writeText(text).catch(() => {})
                    setCopiedHeaderField(field)
                    setTimeout(() => setCopiedHeaderField((prev) => prev === field ? null : prev), 1500)
                  }
                }

                if (item.type === 'widget') {
                  const w = item.data
                  const isBtnGroup = headerWidgetTypes[w.field] === 'button-group'
                  return (
                    <div key={w.field} className='group relative self-stretch border-r border-slate-200 dark:border-border'>
                      <WidgetSlot
                        widgetId={w.widgetId}
                        inputBindings={w.inputBindings}
                        itemDraft={draft}
                        itemCollection={collection}
                        label={w.label ?? undefined}
                        compact={true}
                        strip={true}
                        onWidgetType={(t) => setHeaderWidgetTypes(prev => ({ ...prev, [w.field]: t }))}
                      />
                      {!isBtnGroup && (copiedHeaderField === w.field
                        ? <Check className='absolute top-2 right-2 h-3 w-3 text-green-500' />
                        : (
                          <button
                            type='button'
                            className='absolute top-2 right-2 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity'
                            onClick={(e) => copyCell(e.currentTarget.closest<HTMLElement>('.group'), w.field)}
                          >
                            <Copy className='h-3 w-3 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400' />
                          </button>
                        )
                      )}
                    </div>
                  )
                }
                const f = item.data
                if (f.field === '__owners__') {
                  return (
                    <div key='__owners__' className='group relative flex flex-col justify-start border-r border-slate-200 dark:border-border px-4 py-2 min-w-0 transition-colors hover:bg-white/60 dark:hover:bg-white/[0.025]'>
                      <span className='flex h-4 items-end truncate text-[10px] font-medium leading-none text-slate-400 dark:text-slate-500'>{f.label}</span>
                      <div className='mt-1'>
                        <OwnersInlineCompact collection={collection} itemId={itemId} />
                      </div>
                      {copiedHeaderField === '__owners__'
                        ? <Check className='absolute top-2 right-2 h-3 w-3 text-green-500' />
                        : (
                          <button
                            type='button'
                            className='absolute top-2 right-2 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity'
                            onClick={(e) => copyCell(e.currentTarget.closest<HTMLElement>('.group'), '__owners__')}
                          >
                            <Copy className='h-3 w-3 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400' />
                          </button>
                        )
                      }
                    </div>
                  )
                }
                const raw = draft[f.field]
                const hColorClass = f.color === 'cyan' ? 'text-nvr-cyan' : f.color === 'blue' ? 'text-blue-600 dark:text-blue-400' : f.color === 'green' ? 'text-emerald-600 dark:text-emerald-400' : f.color === 'amber' ? 'text-amber-600 dark:text-amber-400' : f.color === 'red' ? 'text-red-600 dark:text-red-400' : f.color === 'purple' ? 'text-purple-600 dark:text-purple-400' : 'text-slate-900 dark:text-slate-100'
                const hWeightClass = f.weight === 'bold' ? 'font-bold' : f.weight === 'semibold' ? 'font-semibold' : f.weight === 'medium' ? 'font-medium' : 'font-semibold'
                const textCls = `${hColorClass} ${hWeightClass}`
                const isPill = f.displayAs === 'pill'
                const isTag = f.displayAs === 'tag'
                return (
                  <div
                    key={f.field}
                    className='group relative flex flex-col justify-start border-r border-slate-200 dark:border-border px-4 py-2 min-w-0 transition-colors hover:bg-white/60 dark:hover:bg-white/[0.025]'
                  >
                    <span className='flex h-4 items-end truncate text-[10px] font-medium leading-none text-slate-400 dark:text-slate-500'>{f.label}</span>
                    <span className={['mt-1 leading-none truncate max-w-[220px]', isPill ? `rounded-full px-2 py-0.5 text-[11px] inline-block ${hColorClass} bg-current/10` : isTag ? `rounded px-1.5 py-0.5 border border-current/30 text-[11px] inline-block ${hColorClass}` : ''].filter(Boolean).join(' ')}>
                      {f.cmsField
                        ? <StripFieldValue field={f.cmsField} val={raw} relations={relations} collection={collection} displayFormat={f.displayFormat} textClassName={textCls} />
                        : <span className={`text-[13px] ${textCls}`}>{formatHeaderFieldValue(raw, f.displayFormat)}</span>
                      }
                    </span>
                    {copiedHeaderField === f.field
                      ? <Check className='absolute top-2 right-2 h-3 w-3 text-green-500' />
                      : (
                        <button
                          type='button'
                          className='absolute top-2 right-2 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity'
                          onClick={(e) => {
                            const cell = e.currentTarget.closest<HTMLElement>('.group')
                            const valueSpan = cell?.querySelectorAll<HTMLElement>(':scope > span')[1]
                            let text = ''
                            if (valueSpan) {
                              const clone = valueSpan.cloneNode(true) as HTMLElement
                              clone.querySelectorAll('[data-copy-skip]').forEach(el => el.remove())
                              text = clone.textContent?.trim() ?? ''
                            }
                            if (text) {
                              navigator.clipboard.writeText(text).catch(() => {})
                              setCopiedHeaderField(f.field)
                              setTimeout(() => setCopiedHeaderField(prev => prev === f.field ? null : prev), 1500)
                            }
                          }}
                        >
                          <Copy className='h-3 w-3 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400' />
                        </button>
                      )
                    }
                  </div>
                )
              })}
          </div>
        )}

        <div
          className={cn(
            'flex-1 min-h-0',
            summaryEnabled ? 'flex overflow-hidden' : 'overflow-y-auto'
          )}
        >
          <div
            ref={bodyRef}
            className={cn(
              'p-6 space-y-4',
              summaryEnabled ? 'flex-1 overflow-y-auto' : ''
            )}
          >
            {extraTopContent}
            {importIssues.length > 0 && (
              <ImportIssuesPanel issues={importIssues} onDismiss={() => setImportIssues([])} />
            )}
            {showLockBanner && (
              <ItemLockBanner
                lockHolder={lockHolder}
                onTakeOver={takeOver}
                takingOver={takingOver}
                isAdmin={isAdmin}
              />
            )}
            {!isNew && addendumEnabled && activeAddendums.length > 0 && (
              <div className='relative mb-3 flex items-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5'>
                <span className='mr-2 shrink-0 text-[11px] text-slate-400'>Viewing:</span>
                <button
                  type='button'
                  onClick={() => setAddendumViewDropdownOpen(o => !o)}
                  className={cn(
                    'flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                    addendumViewId === 'original'
                      ? 'text-slate-600 hover:text-slate-900'
                      : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', addendumViewId === 'original' ? 'bg-slate-400' : 'bg-amber-400')} />
                  {addendumViewId === 'original'
                    ? 'Original'
                    : (activeAddendums.find(a => a.id === addendumViewId)?.title ?? 'Addendum')}
                  <ChevronDown className='h-3 w-3 opacity-60' />
                </button>
                {addendumViewDropdownOpen && (
                  <div className='absolute left-3 top-full z-20 mt-0.5 min-w-[220px] rounded-md border border-slate-200 bg-white shadow-lg py-0.5'>
                    <button
                      type='button'
                      onClick={() => { setAddendumViewId('original'); setAddendumViewDropdownOpen(false) }}
                      className={cn('flex w-full items-center px-3 py-1.5 text-[11px] text-left hover:bg-slate-50 transition-colors', addendumViewId === 'original' && 'font-semibold text-slate-900')}
                    >
                      Original
                    </button>
                    {activeAddendums.map(a => (
                      <button
                        key={a.id}
                        type='button'
                        onClick={() => { setAddendumViewId(a.id); setAddendumViewDropdownOpen(false) }}
                        className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-left hover:bg-amber-50 transition-colors', addendumViewId === a.id && 'font-semibold text-amber-900')}
                      >
                        <span className='h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0' />
                        <span className='flex-1'>{a.title}</span>
                        <span className='capitalize text-[10px] text-amber-400'>{a.status}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {hasTabs ? (isStepsMode ? renderStepsMode() : renderTabMode()) : renderSectionMode()}
            {extraBottomContent}
          </div>
          {summaryEnabled && (
            <div className='flex shrink-0 border-l border-slate-200'>
              <button
                type='button'
                onClick={() => setSummaryCollapsed(v => !v)}
                title={summaryCollapsed ? 'Expand summary' : 'Collapse summary'}
                className='border-r flex w-6 shrink-0 items-start justify-center pt-3 bg-slate-100 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 transition-colors dark:bg-white/[0.04] dark:hover:bg-white/[0.08] dark:text-slate-500 dark:hover:text-slate-300'
              >
                {summaryCollapsed
                  ? <ChevronLeft className='h-3.5 w-3.5' />
                  : <ChevronRight className='h-3.5 w-3.5' />}
              </button>
              <div
                className='overflow-hidden transition-all duration-200'
                style={{ width: summaryCollapsed ? 0 : 232 }}
              >
                <div className='w-[232px] overflow-y-auto h-full'>
                  <SummaryPanel
                    allSteps={allTabGroups.length > 0 ? allTabGroups.map((g) => ({ key: g.key, label: g.label })) : allSteps}
                    groupedMap={groupedMap}
                    ungroupedFields={ungroupedFields}
                    sectionGroups={sectionGroups.filter((g) => g.type !== 'metadata')}
                    draft={draft}
                    relations={relations}
                    collection={collection}
                    itemId={itemId}
                    staging={m2mStagingCtx}
                    errors={validationErrors}
                    onFieldClick={(stepKey, fieldKey) => {
                      if (hasContainers) {
                        const ownerContainer = containerGroups.find((c) =>
                          groups.some((g) => g.type === 'tab' && g.container_id === c.id && g.key === stepKey)
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
                      setTimeout(() => {
                        const el = document.querySelector(
                          `[data-field="${fieldKey}"]`
                        ) as HTMLElement | null
                        if (el) {
                          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          el.classList.add('ring-2', 'ring-nvr-cyan', 'ring-offset-2', 'rounded-md')
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
                          ;(
                            el.querySelector('input,textarea,select,button') as HTMLElement | null
                          )?.focus()
                        }
                      }, 80)
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </M2MStagingContext.Provider>
    </O2MStagingContext.Provider>
    </GridFlushContext.Provider>
    </ParentDraftContext.Provider>
    </AddendumFieldContext.Provider>
    </AddendumViewContext.Provider>
    </AddendumO2MContext.Provider>
    </RelationPathDataContext.Provider>
  )
}
