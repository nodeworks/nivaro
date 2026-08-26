import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, FileDiff, Loader2, Paperclip, Upload } from 'lucide-react'
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { titleCase } from '../../lib/utils'
import { FilePreviewLightbox, type PreviewFile } from '../FilePreviewLightbox'
import { FieldRenderer } from '../item-edit/FieldRenderer'
import { computeLiveRollup, parseRollupSources } from '../item-edit/live-rollups'
import type { O2MStagingCtx } from '../item-edit/O2MStagingContext'
import { O2MStagingContext, useLiveRows } from '../item-edit/O2MStagingContext'
import type { CMSField, CMSRelation } from '../item-edit/types'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import { Textarea } from '../ui/textarea'

interface AddendumLayout {
  id: number
  name: string
  layout_type: string
  workflow_template_id: string | null
  single_active_addendum?: boolean | number
}

interface LayoutAssignment {
  field: string
  label_override: string | null
  is_visible: boolean | number
  sort: number
  overrides: Record<string, unknown> | string | null
}

interface Addendum {
  id: string
  title: string
  description: string | null
  status: string
  data: Record<string, unknown> | null
  workflow_template_id: string | null
  created_at: string
  cost_impact: number | null
  timeline_impact_days: number | null
  created_by: string | null
  approved_by: string | null
  approved_at: string | null
  previous_amount: number | null
  new_amount: number | null
  attachments: string[] | null
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** Minimal HTML sanitizer for stored rich-text: drops active elements,
 *  on* handlers and javascript: URLs. Rich text here is internal-authored,
 *  but the create form's plain textarea also feeds description — never
 *  render that raw. */
function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta')) {
    el.remove()
  }
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*javascript:/i.test(attr.value)
      )
        el.removeAttribute(attr.name)
    }
  }
  return doc.body.innerHTML
}

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function costImpactChip(v: number | null | undefined) {
  const n = Number(v)
  if (!v || Number.isNaN(n) || n === 0) return null
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums',
        n > 0
          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
          : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
      )}
    >
      {n > 0 ? '+' : '−'}
      {usd.format(Math.abs(n))}
    </span>
  )
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

const STATUS_STYLES: Record<string, { badge: string; dot: string }> = {
  draft: {
    badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
    dot: 'bg-slate-400'
  },
  review: {
    badge: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
    dot: 'bg-amber-400'
  },
  approved: {
    badge: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
    dot: 'bg-emerald-500'
  },
  rejected: {
    badge: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
    dot: 'bg-red-500'
  },
  reverted: {
    badge: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
    dot: 'bg-amber-500'
  }
}

/** Money-grade comparison: a live sum of floats never exactly equals a stored
 *  decimal, so compare at cent precision or every total shows a +$0.00 delta. */
const sameToCents = (a: unknown, b: unknown): boolean =>
  Math.round(Number(a) * 100) === Math.round(Number(b) * 100)

/** Decorates a rollup field with its live total so FieldRenderer can show the
 *  original, the new figure and the difference. Returns the field untouched
 *  when there is nothing to compare — no live rows, or an unmoved total. */
function withLiveDelta(
  meta: CMSField,
  current: unknown,
  liveRows: ReturnType<typeof useLiveRows>
): CMSField {
  if (!liveRows || meta.computed_type !== 'rollup' || !meta.computed_formula) return meta
  const live = computeLiveRollup(parseRollupSources(meta.computed_formula), liveRows.rows)
  if (live === null) return meta
  if (current !== null && current !== undefined && sameToCents(current, live)) return meta
  return {
    ...meta,
    options: {
      ...((meta.options as Record<string, unknown> | null) ?? {}),
      __live_delta: { original: current, live }
    }
  }
}

// ─── DeltaAmountField ─────────────────────────────────────────────────────────
// EFP PUB-addendum entry: the reviewer types the amount to increase/decrease
// BY (negative decreases); the proposed value stored is current + delta, and
// the strip previews Current → New total live.

function DeltaAmountField({
  current,
  value,
  onChange,
  currentLabel,
  newLabel
}: {
  current: number
  value: unknown
  onChange: (v: unknown) => void
  currentLabel?: string
  newLabel?: string
}) {
  const [text, setText] = useState(() => {
    const v = Number(value)
    if (!Number.isFinite(v) || Math.round(v * 100) === Math.round(current * 100)) return ''
    return String(Math.round((v - current) * 100) / 100)
  })
  const delta = text.trim() === '' ? 0 : Number(text)
  const validDelta = Number.isFinite(delta)
  const proposed = validDelta ? Math.round((current + delta) * 100) / 100 : current
  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center gap-0'>
        <span className='flex h-9 items-center rounded-l-md border border-r-0 border-slate-200 bg-slate-50 px-2.5 text-[13px] text-slate-500 dark:border-border dark:bg-muted'>
          $
        </span>
        <Input
          value={text}
          onChange={(e) => {
            const t = e.target.value
            setText(t)
            const d = t.trim() === '' ? 0 : Number(t)
            if (!Number.isFinite(d)) return
            onChange(Math.round((current + d) * 100) / 100)
          }}
          placeholder='Negative numbers to decrease'
          className='h-9 rounded-l-none text-[13px]'
        />
      </div>
      <p className='text-[12px]'>
        <span className='font-medium text-slate-600 dark:text-slate-300'>
          {currentLabel ?? 'Current REQ Amount'}:
        </span>{' '}
        <span className='tabular-nums text-slate-700 dark:text-slate-200'>{fmt(current)}</span>
        <span className='mx-2 text-slate-300'>·</span>
        <span className='font-medium text-slate-600 dark:text-slate-300'>
          {newLabel ?? 'New REQ Total'}:
        </span>{' '}
        <span
          className={
            'tabular-nums font-semibold ' +
            (proposed > current
              ? 'text-emerald-600 dark:text-emerald-400'
              : proposed < current
                ? 'text-red-600 dark:text-red-400'
                : 'text-slate-700 dark:text-slate-200')
          }
        >
          {fmt(proposed)}
        </span>
        {!validDelta && <span className='ml-2 text-[11px] text-red-500'>Enter a number</span>}
      </p>
    </div>
  )
}

// ─── ProposedChangesForm ───────────────────────────────────────────────────────
// Isolated so title/description keystrokes don't re-render FieldRenderers.

const ProposedChangesForm = memo(function ProposedChangesForm({
  configuredFields,
  fieldMap,
  formData,
  onFieldChange,
  relations,
  collection,
  prefillParentId,
  parentData
}: {
  configuredFields: LayoutAssignment[]
  fieldMap: Record<string, CMSField>
  formData: Record<string, unknown>
  onFieldChange: (field: string, value: unknown) => void
  relations: CMSRelation[]
  collection: string
  prefillParentId: string
  parentData?: Record<string, unknown>
}) {
  // The addendum's own grid publishes its staged rows into the record form's
  // LiveRowsContext, so a rollup on the amendment can be totalled from the
  // lines being proposed — and shown as original → new, since the difference
  // is the whole point of the amendment.
  const liveRows = useLiveRows()

  if (configuredFields.length === 0) {
    return (
      <div className='rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center dark:border-border dark:bg-muted/30'>
        <p className='text-[12px] text-slate-400 dark:text-slate-500'>
          No fields configured for addendum. Set up the field list in Data Model → Layouts →
          Addendum Form.
        </p>
      </div>
    )
  }
  return (
    <div className='border-t border-slate-100 dark:border-border pt-3'>
      <p className='mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>
        Proposed changes
      </p>
      <div className='space-y-3'>
        {configuredFields.map((a) => {
          const meta = fieldMap[a.field]
          const label = a.label_override ?? titleCase(meta?.field ?? a.field)
          if (!meta) {
            return (
              <div key={a.field}>
                <Label className='mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400'>
                  {label}
                </Label>
                <Input
                  value={String(formData[a.field] ?? '')}
                  onChange={(e) => onFieldChange(a.field, e.target.value)}
                  className='h-8 text-[12px]'
                />
              </div>
            )
          }
          // Delta entry (overrides.options.entry_mode = 'delta'): type the
          // change, not the new total — EFP PUB addendum semantics.
          const aOv =
            typeof a.overrides === 'string'
              ? (() => {
                  try {
                    return JSON.parse(a.overrides) as Record<string, unknown>
                  } catch {
                    return {}
                  }
                })()
              : ((a.overrides ?? {}) as Record<string, unknown>)
          const aOvOpts = (aOv.options ?? {}) as Record<string, unknown>
          if (aOvOpts.entry_mode === 'delta') {
            const cur = Number(parentData?.[a.field] ?? 0)
            return (
              <div key={a.field}>
                <Label className='mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400'>
                  {label}
                </Label>
                <DeltaAmountField
                  current={Number.isFinite(cur) ? cur : 0}
                  value={formData[a.field]}
                  onChange={(v) => onFieldChange(a.field, v)}
                  currentLabel={
                    typeof aOvOpts.current_label === 'string' ? aOvOpts.current_label : undefined
                  }
                  newLabel={typeof aOvOpts.new_label === 'string' ? aOvOpts.new_label : undefined}
                />
              </div>
            )
          }
          return (
            <div key={a.field}>
              <Label className='mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400'>
                {label}
              </Label>
              <FieldRenderer
                field={withLiveDelta(meta, formData[a.field], liveRows)}
                value={formData[a.field]}
                onChange={(v) => onFieldChange(a.field, v)}
                relations={relations}
                collection={collection}
                itemId='new'
                prefillParentId={prefillParentId}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})

// ─── AddendumWorkflowPanel ────────────────────────────────────────────────────

interface WfTransition {
  id: string
  label: string
  color: string | null
  to_state: string
  group_label: string | null
}
interface WfState {
  id: string
  key: string
  label: string
  color: string | null
  is_terminal: boolean
}
interface WfInstance {
  id: string
  current_state: string
  current_state_obj: WfState | null
  completed_at: string | null
}

function AddendumWorkflowPanel({
  addendumId,
  onRefresh
}: {
  addendumId: string
  onRefresh: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)
  const [comment, setComment] = useState('')

  const instanceKey = ['pipeline-instance', 'nivaro_addendums', addendumId]

  const { data: pd, isLoading } = useQuery<{
    instance: WfInstance | null
    available_transitions: WfTransition[]
    states: WfState[]
  } | null>({
    queryKey: instanceKey,
    queryFn: () =>
      client
        .request<{
          data: {
            instance: WfInstance | null
            available_transitions: WfTransition[]
            states: WfState[]
          } | null
        }>(get(`/pipelines/instance/nivaro_addendums/${addendumId}`))
        .then((r) => r.data),
    staleTime: 10_000
  })

  const transitionMut = useMutation({
    mutationFn: ({ transitionId, note }: { transitionId: string; note?: string }) =>
      client.request(
        post(`/workflows/instance/${pd?.instance?.id}/transition`, {
          transition_id: transitionId,
          comment: note
        })
      ),
    onSuccess: () => {
      setPending(null)
      setComment('')
      qc.invalidateQueries({ queryKey: instanceKey })
      onRefresh()
      toast.success('Workflow advanced')
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Transition failed')
    }
  })

  if (isLoading) return <Skeleton className='h-8 w-full' />
  if (!pd?.instance)
    return <p className='text-[12px] text-slate-400 italic'>No workflow instance found.</p>

  const { instance, available_transitions: transitions, states = [] } = pd
  const state = instance.current_state_obj
  const pendingTx = transitions.find((t) => t.id === pending)
  const stateById = new Map(states.map((s) => [s.id, s]))

  // Group by tx.label (same as PipelinePanel) — transitions with same label collapse into one dropdown
  const groups = new Map<string, WfTransition[]>()
  for (const tx of transitions) {
    const existing = groups.get(tx.label) ?? []
    existing.push(tx)
    groups.set(tx.label, existing)
  }

  function txColorStyle(tx: WfTransition, isActive: boolean) {
    if (!tx.color) return undefined
    return isActive
      ? { backgroundColor: tx.color, borderColor: tx.color, color: '#fff' }
      : { borderColor: tx.color, color: tx.color }
  }

  return (
    <div className='space-y-3'>
      {state && (
        <div className='flex items-center gap-2'>
          <span className='text-[11px] text-slate-500'>Current state:</span>
          <span
            className='inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium'
            style={{
              backgroundColor: state.color ? `${state.color}22` : '#f1f5f9',
              color: state.color ?? '#475569',
              border: `1px solid ${state.color ? `${state.color}44` : '#e2e8f0'}`
            }}
          >
            {state.label}
          </span>
        </div>
      )}

      {transitions.length > 0 && !instance.completed_at && (
        <div className='flex flex-wrap gap-1.5'>
          {[...groups.entries()].map(([label, txs]) => {
            const representativeColor = txs[0].color
            const isActive = txs.some((tx) => tx.id === pending)
            if (txs.length === 1) {
              const tx = txs[0]
              return (
                <button
                  key={label}
                  type='button'
                  onClick={() => setPending(pending === tx.id ? null : tx.id)}
                  className={cn(
                    'inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium transition-colors border',
                    isActive
                      ? 'bg-nvr-cyan border-nvr-cyan text-white'
                      : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-700'
                  )}
                  style={txColorStyle(tx, isActive)}
                >
                  {label}
                </button>
              )
            }
            return (
              <DropdownMenu key={label}>
                <DropdownMenuTrigger asChild>
                  <button
                    type='button'
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium transition-colors border',
                      isActive
                        ? 'bg-nvr-cyan border-nvr-cyan text-white'
                        : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-700'
                    )}
                    style={
                      representativeColor && !isActive
                        ? { borderColor: representativeColor, color: representativeColor }
                        : undefined
                    }
                  >
                    {label}
                    <ChevronDown className='h-3 w-3' />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='start'>
                  {txs.map((tx) => {
                    const targetState = stateById.get(tx.to_state)
                    return (
                      <DropdownMenuItem key={tx.id} onSelect={() => setPending(tx.id)}>
                        {tx.color && (
                          <span
                            className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full'
                            style={{ backgroundColor: tx.color }}
                          />
                        )}
                        {targetState?.label ?? tx.to_state}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          })}
        </div>
      )}

      {pending && pendingTx && (
        <div className='rounded-md border border-slate-200 bg-slate-50 p-2.5 space-y-2'>
          <p className='text-[11px] text-slate-500'>
            Confirm: <strong>{pendingTx.label}</strong>
          </p>
          <input
            type='text'
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder='Add a comment (optional)'
            className='w-full rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
          />
          <div className='flex justify-end gap-2'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-6 text-[11px]'
              onClick={() => {
                setPending(null)
                setComment('')
              }}
            >
              Cancel
            </Button>
            <Button
              type='button'
              size='sm'
              className='h-6 text-[11px]'
              disabled={transitionMut.isPending}
              onClick={() =>
                transitionMut.mutate({ transitionId: pending, note: comment.trim() || undefined })
              }
            >
              Confirm
            </Button>
          </div>
        </div>
      )}

      {instance.completed_at && (
        <p className='text-[11px] text-slate-400 italic'>Workflow complete.</p>
      )}
    </div>
  )
}

// ─── AddendumCreateSheet ───────────────────────────────────────────────────────

function AddendumCreateSheet({
  collection,
  itemId,
  assignments,
  workflowTemplateId,
  resolvedLayoutId,
  fields,
  relations,
  parentData,
  onClose,
  onCreated
}: {
  collection: string
  itemId: string
  assignments: LayoutAssignment[]
  workflowTemplateId: string | null
  resolvedLayoutId: number | null
  fields: CMSField[]
  relations: CMSRelation[]
  parentData: Record<string, unknown>
  onClose: () => void
  onCreated: () => void
}) {
  const client = useNivaroClient()

  const configuredFields = assignments.filter(
    (a) => !String(a.field).startsWith('__') && (a.is_visible || a.is_visible === 1)
  )

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  // Supporting files: uploaded immediately (nivaro_files), ids ride the
  // create payload. An abandoned form leaves orphan files — same accepted
  // trade-off as the chat composer.
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string }>>([])
  const [uploadingCount, setUploadingCount] = useState(0)
  const attachInputRef = useRef<HTMLInputElement | null>(null)
  const uploadAttachment = async (files: File[]) => {
    if (files.length === 0) return
    setUploadingCount((n) => n + files.length)
    for (const f of files) {
      try {
        const result = await (
          client as unknown as { upload: (f: File) => Promise<{ id: string }> }
        ).upload(f)
        setAttachments((prev) => [...prev, { id: String(result.id), name: f.name }])
      } catch {
        toast.error(`Failed to upload ${f.name}`)
      } finally {
        setUploadingCount((n) => n - 1)
      }
    }
  }
  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    const pre: Record<string, unknown> = {}
    for (const a of configuredFields) {
      const ov =
        typeof a.overrides === 'string'
          ? (() => {
              try {
                return JSON.parse(a.overrides)
              } catch {
                return {}
              }
            })()
          : (a.overrides ?? {})
      const prefill = (ov as Record<string, unknown>)?.prefill_from_parent !== false
      pre[a.field] = prefill ? (parentData[a.field] ?? null) : null
    }
    return pre
  })

  const fieldMap = useMemo(() => {
    const m: Record<string, CMSField> = {}
    for (const f of fields) m[f.field] = f
    return m
  }, [fields])

  const handleFieldChange = useCallback((field: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }, [])

  // ── O2M staging context (prefill from parent) ─────────────────────────────
  const [pendingO2MRows, setPendingO2MRows] = useState<Map<string, Record<string, unknown>[]>>(
    new Map()
  )
  const [pendingO2MEdits, setPendingO2MEdits] = useState<
    Map<string, Map<string, Record<string, unknown>>>
  >(new Map())
  const [pendingO2MDeletes, setPendingO2MDeletes] = useState<Map<string, Set<string>>>(new Map())
  const pendingO2MRowsRef = useRef(pendingO2MRows)
  useEffect(() => {
    pendingO2MRowsRef.current = pendingO2MRows
  }, [pendingO2MRows])

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
          const inner = new Map(next.get(key) ?? [])
          inner.set(rowId, { ...(inner.get(rowId) ?? {}), ...changes })
          next.set(key, inner)
          return next
        }),
      queueDelete: (rc, mf, rowId) =>
        setPendingO2MDeletes((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          next.set(key, new Set([...(next.get(key) ?? []), rowId]))
          return next
        }),
      cancelPendingEdit: (rc, mf, rowId) =>
        setPendingO2MEdits((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const inner = new Map(next.get(key) ?? [])
          inner.delete(rowId)
          next.set(key, inner)
          return next
        }),
      cancelPendingDelete: (rc, mf, rowId) =>
        setPendingO2MDeletes((prev) => {
          const next = new Map(prev)
          const key = `${rc}.${mf}`
          const s = new Set(next.get(key) ?? [])
          s.delete(rowId)
          next.set(key, s)
          return next
        })
    }),
    [pendingO2MRows, pendingO2MEdits, pendingO2MDeletes]
  )

  const createMut = useMutation({
    mutationFn: () => {
      // Merge O2M staging rows into formData before submit
      const mergedData = { ...formData }
      for (const a of configuredFields) {
        const rel = relations.find(
          (r) =>
            r.one_collection === collection &&
            !r.junction_field &&
            (r.one_field === a.field || r.many_collection === a.field)
        )
        if (rel?.many_collection && rel.many_field) {
          const rows = (
            pendingO2MRowsRef.current.get(`${rel.many_collection}.${rel.many_field}`) ?? []
          ).map(({ __prefilled: _, ...rest }) => rest)
          if (rows.length > 0) mergedData[a.field] = rows
        }
      }
      return client.request(
        post('/addendums', {
          parent_collection: collection,
          parent_id: itemId,
          title: title.trim(),
          description: description.trim() || undefined,
          workflow_template_id: workflowTemplateId ?? undefined,
          addendum_layout_id: resolvedLayoutId,
          data: mergedData,
          fields_schema: configuredFields.map((a) => a.field),
          attachments: attachments.length > 0 ? attachments.map((a) => a.id) : undefined
        })
      )
    },
    onSuccess: () => {
      toast.success('Addendum created')
      onCreated()
      onClose()
    },
    onError: () => toast.error('Failed to create addendum')
  })

  return (
    <O2MStagingContext.Provider value={o2mStagingCtx}>
      <div className='flex h-full flex-col'>
        <SheetHeader className='shrink-0 border-b border-slate-200 px-5 py-4 dark:border-border'>
          <SheetTitle className='text-[14px] font-semibold text-slate-900 dark:text-slate-100'>
            New Addendum
          </SheetTitle>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-slate-400'>
            Propose changes to this record. Fields are pre-filled with current values — edit what's
            changing.
          </p>
        </SheetHeader>

        <div className='flex-1 overflow-y-auto px-5 py-4 space-y-4'>
          <div className='space-y-3'>
            <div>
              <Label className='mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400'>
                Title <span className='text-red-500'>*</span>
              </Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className='h-8 text-[12px]'
                placeholder='Brief description of this addendum'
                autoFocus
              />
            </div>
            <div>
              <Label className='mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400'>
                Notes
              </Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className='text-[12px]'
                placeholder='Why is this change needed?'
              />
            </div>
            <div>
              <Label className='mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400'>
                Attachments
              </Label>
              <input
                ref={attachInputRef}
                type='file'
                multiple
                className='hidden'
                onChange={(e) => {
                  void uploadAttachment(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />
              <div className='flex flex-wrap items-center gap-1.5'>
                {attachments.map((a) => (
                  <span
                    key={a.id}
                    className='inline-flex max-w-[240px] items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700 dark:border-border dark:bg-muted dark:text-slate-200'
                  >
                    <Paperclip className='h-3 w-3 shrink-0 text-slate-400' />
                    <span className='truncate'>{a.name}</span>
                    <button
                      type='button'
                      onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      className='shrink-0 text-slate-400 hover:text-red-500'
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button
                  type='button'
                  onClick={() => attachInputRef.current?.click()}
                  disabled={uploadingCount > 0}
                  className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800 disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:text-slate-100'
                >
                  {uploadingCount > 0 ? (
                    <Loader2 className='h-3 w-3 animate-spin' />
                  ) : (
                    <Upload className='h-3 w-3' />
                  )}
                  {uploadingCount > 0 ? 'Uploading…' : 'Upload'}
                </button>
              </div>
            </div>
          </div>

          <ProposedChangesForm
            parentData={parentData}
            configuredFields={configuredFields}
            fieldMap={fieldMap}
            formData={formData}
            onFieldChange={handleFieldChange}
            relations={relations}
            collection={collection}
            prefillParentId={itemId}
          />
        </div>

        <div className='shrink-0 flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-border'>
          <Button variant='outline' size='sm' className='h-8 text-[12px]' onClick={onClose}>
            Cancel
          </Button>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-[12px] font-medium text-white hover:bg-nvr-cyan/90'
            disabled={!title.trim() || createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            {createMut.isPending ? 'Creating…' : 'Create Addendum'}
          </Button>
        </div>
      </div>
    </O2MStagingContext.Provider>
  )
}

// ─── AddendumDetails ───────────────────────────────────────────────────────────
// Impact figures + audit trail for the expanded card. This is the ONLY body an
// imported legacy addendum has (data/fields_schema are null there), so it must
// carry the story on its own: net cost, timeline, full description, who/when.

function AddendumDetails({ addendum }: { addendum: Addendum }) {
  const client = useNivaroClient()
  const userIds = [addendum.created_by, addendum.approved_by].filter(Boolean) as string[]
  const { data: users = {} } = useQuery<Record<string, string>>({
    queryKey: ['addendum-users', ...userIds.sort()],
    queryFn: async () => {
      const rows = await client
        .request<{
          data: Array<{ id: string; first_name: string | null; last_name: string | null }>
        }>(
          get(`/items/nivaro_users`, {
            filter: JSON.stringify({ id: { _in: userIds } }),
            fields: 'id,first_name,last_name'
          })
        )
        .then((r) => r.data ?? [])
      return Object.fromEntries(
        rows.map((u) => [
          String(u.id).toUpperCase(),
          [u.first_name, u.last_name].filter(Boolean).join(' ')
        ])
      )
    },
    enabled: userIds.length > 0,
    staleTime: 300_000
  })
  const nameOf = (id: string | null) => (id ? users[String(id).toUpperCase()] || null : null)

  const fmtDate = (d: string | null) =>
    d
      ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : null

  const createdBy = nameOf(addendum.created_by)
  const approvedBy = nameOf(addendum.approved_by)

  const cells: Array<{ label: string; value: ReactNode }> = []
  if (addendum.timeline_impact_days != null && Number(addendum.timeline_impact_days) !== 0)
    cells.push({
      label: 'Timeline impact',
      value: `${addendum.timeline_impact_days > 0 ? '+' : ''}${addendum.timeline_impact_days} days`
    })
  if (addendum.created_at)
    cells.push({
      label: 'Created',
      value: [fmtDate(addendum.created_at), createdBy && `by ${createdBy}`]
        .filter(Boolean)
        .join(' ')
    })
  if (addendum.status === 'approved' && (addendum.approved_at || approvedBy))
    cells.push({
      label: 'Approved',
      value: [fmtDate(addendum.approved_at), approvedBy && `by ${approvedBy}`]
        .filter(Boolean)
        .join(' ')
    })

  if (cells.length === 0 && !addendum.description) return null
  return (
    <div className='px-4 py-3'>
      {cells.length > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          {cells.map((c) => (
            <div
              key={c.label}
              className='min-w-[130px] rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
            >
              <p className='text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>
                {c.label}
              </p>
              <p className='mt-0.5 text-[12.5px] text-slate-700 dark:text-slate-200'>{c.value}</p>
            </div>
          ))}
        </div>
      )}
      {addendum.description && (
        <div className='mt-2.5'>
          <p className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>
            Reason
          </p>
          {/^\s*</.test(addendum.description) ? (
            <div
              className='nvr-addendum-reason text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300 [&_a]:text-nvr-cyan [&_a]:underline [&_li]:ml-4 [&_ol]:list-decimal [&_p]:mb-1 [&_ul]:list-disc'
              // biome-ignore lint/security/noDangerouslySetInnerHtml: internal rich-text (Tiptap/converted legacy HTML), same trust level as the rich_text editor rendering it
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(addendum.description) }}
            />
          ) : (
            <p className='whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300'>
              {addendum.description}
            </p>
          )}
        </div>
      )}
      <AddendumAttachments ids={addendum.attachments} />
    </div>
  )
}

function AddendumAttachments({ ids }: { ids: string[] | null }) {
  const client = useNivaroClient()
  const [preview, setPreview] = useState<PreviewFile | null>(null)
  const fileIds = Array.isArray(ids) ? ids.filter(Boolean) : []
  const { data: metas = [] } = useQuery<
    Array<{
      id: string
      filename: string | null
      size: number | null
      type: string | null
      missing: boolean
    }>
  >({
    queryKey: ['addendum-files', ...fileIds],
    queryFn: () =>
      Promise.all(
        fileIds.map((id) =>
          client
            .request<{
              data: {
                id: string
                filename_download?: string
                filename?: string
                title?: string
                filesize?: number
                type?: string
                missing_at?: string | null
              }
            }>(get(`/files/${id}/meta`))
            .then((r) => ({
              id,
              filename: r.data?.filename_download ?? r.data?.filename ?? r.data?.title ?? null,
              size: r.data?.filesize ?? null,
              type: r.data?.type ?? null,
              missing: !!r.data?.missing_at
            }))
            .catch(() => ({ id, filename: null, size: null, type: null, missing: false }))
        )
      ),
    enabled: fileIds.length > 0,
    staleTime: 300_000
  })
  if (fileIds.length === 0) return null
  return (
    <div className='mt-2.5'>
      <p className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>
        Attachments
      </p>
      <div className='flex flex-wrap gap-1.5'>
        {preview && <FilePreviewLightbox file={preview} onClose={() => setPreview(null)} />}
        {metas.map((m) => (
          <button
            key={m.id}
            type='button'
            onClick={() =>
              setPreview({
                id: m.id,
                url: client.fileUrl(m.id),
                name: m.filename ?? `File ${m.id.slice(0, 8)}…`,
                type: m.type,
                size: m.size
              })
            }
            className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11.5px] text-slate-700 transition-colors hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:bg-muted/40 dark:text-slate-300 dark:hover:text-nvr-cyan'
          >
            {m.missing && (
              <span
                className='rounded bg-red-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'
                title='The stored file is missing from storage — preview/download will fail. Re-upload it.'
              >
                missing
              </span>
            )}
            <Paperclip className='h-3 w-3 shrink-0 text-slate-400' />
            <span className='max-w-[220px] truncate'>
              {m.filename ?? `File ${m.id.slice(0, 8)}…`}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── AddendumCard ──────────────────────────────────────────────────────────────

function AddendumCard({
  addendum,
  configuredFields,
  onRefresh,
  isActive,
  relations = [],
  parentCollection,
  parentId,
  fieldMap = {}
}: {
  addendum: Addendum
  configuredFields: LayoutAssignment[]
  onRefresh: () => void
  isActive?: boolean
  relations?: CMSRelation[]
  parentCollection?: string
  parentId?: string
  fieldMap?: Record<string, CMSField>
}) {
  const client = useNivaroClient()
  const [expanded, setExpanded] = useState(false)
  // A workflow-driven addendum isn't a 'draft' anyone must submit — its
  // review IS the pipeline. Say so instead of leaking the storage status.
  const displayStatus =
    addendum.workflow_template_id && ['draft', 'review'].includes(addendum.status)
      ? 'in approvals'
      : addendum.status
  const styles =
    displayStatus === 'in approvals'
      ? STATUS_STYLES.review
      : (STATUS_STYLES[addendum.status] ?? STATUS_STYLES.draft)

  const proposedData = addendum.data ?? {}

  // For each O2M field in the proposed data, find its relation and fetch original rows
  const o2mFields = configuredFields.filter((a) => Array.isArray(proposedData[a.field]))
  const o2mRelations = o2mFields
    .map((a) => {
      const rel = relations.find(
        (r) =>
          r.one_collection === parentCollection &&
          !r.junction_field &&
          (r.one_field === a.field || r.many_collection === a.field)
      )
      return { field: a.field, rel }
    })
    .filter((x) => x.rel?.many_collection && x.rel?.many_field)

  const o2mOriginalQueries = useQueries({
    queries: o2mRelations.map(({ rel }) => ({
      queryKey: ['o2m-rows', rel!.many_collection, rel!.many_field, parentId],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${rel!.many_collection}`, {
              filter: JSON.stringify({ [rel!.many_field!]: { _eq: parentId } }),
              limit: 200
            })
          )
          .then((r) => r.data ?? []),
      staleTime: 30_000,
      enabled: !!parentId
    }))
  })

  const originalO2MMap = Object.fromEntries(
    o2mOriginalQueries.map((q: { data?: Record<string, unknown>[] | null }, i: number) => [
      o2mRelations[i].field,
      q.data ?? null
    ])
  )

  const approveMut = useMutation({
    mutationFn: () => client.request(post(`/addendums/${addendum.id}/approve`)),
    onSuccess: () => {
      onRefresh()
      toast.success('Addendum approved — changes applied to record')
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to approve')
    }
  })

  const revertMut = useMutation({
    mutationFn: () => client.request(post(`/addendums/${addendum.id}/revert`)),
    onSuccess: () => {
      refreshEverything()
      toast.success('Addendum reverted — the record is back to its pre-approval values')
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to revert', { duration: 10000 })
    }
  })
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const qcCard = useQueryClient()
  // An addendum outcome (delete/revert/approve) changes more than the panel:
  // the Viewing switcher, item actions (a deleted closeout makes the button
  // applicable again), the approval chain, the record's own values and child
  // grids. Same breadth the create path refreshes.
  const refreshEverything = () => {
    onRefresh()
    void qcCard.invalidateQueries({ queryKey: ['addendums'] })
    void qcCard.invalidateQueries({ queryKey: ['item-actions'] })
    void qcCard.invalidateQueries({ queryKey: ['ext-item-actions'] })
    void qcCard.invalidateQueries({ queryKey: ['pipeline-all-owners'] })
    void qcCard.invalidateQueries({ queryKey: ['item'] })
    void qcCard.invalidateQueries({ queryKey: ['o2m-rows'] })
    void qcCard.invalidateQueries({ queryKey: ['pipeline-instance'] })
  }
  const deleteMut = useMutation({
    mutationFn: () => client.request(del(`/addendums/${addendum.id}`)),
    onSuccess: () => {
      refreshEverything()
      toast.success('Addendum deleted')
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to delete', { duration: 10000 })
    }
  })
  const { isAdmin } = useItemEditAuth()

  const rejectMut = useMutation({
    mutationFn: () => client.request(post(`/addendums/${addendum.id}/reject`)),
    onSuccess: () => {
      onRefresh()
      toast.success('Addendum rejected')
    },
    onError: () => toast.error('Failed to reject')
  })

  const submitMut = useMutation({
    mutationFn: () => client.request(post(`/addendums/${addendum.id}/submit`)),
    onSuccess: () => {
      onRefresh()
      toast.success('Submitted for review')
    },
    onError: () => toast.error('Failed to submit')
  })

  const changedFields = configuredFields.filter((a) => proposedData[a.field] !== undefined)

  // Current parent values for the changed SCALAR fields — lets the proposed
  // list render "current → proposed" with a +/- delta instead of a bare value.
  const scalarChanged = changedFields.filter((a) => {
    const v = proposedData[a.field]
    if (v != null && typeof v === 'object') return false
    // Alias fields (O2M/M2M) have no physical column — naming one in an
    // explicit readOne fields= is a 500, not an empty value. Covers both the
    // named-alias form (one_field) and the child-table-name form
    // (many_collection === field, one_field null — e.g. workflows_files).
    return !relations.some(
      (r) =>
        r.one_collection === parentCollection &&
        (r.one_field === a.field || r.many_collection === a.field)
    )
  })
  const { data: currentRecord } = useQuery<Record<string, unknown> | null>({
    queryKey: [
      'addendum-current',
      parentCollection,
      parentId,
      scalarChanged.map((a) => a.field).join(',')
    ],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(
          get(`/items/${parentCollection}/${parentId}`, {
            fields: ['id', ...scalarChanged.map((a) => a.field)].join(',')
          })
        )
        .then((r) => r.data ?? null)
        .catch(() => null),
    enabled: !!parentCollection && !!parentId && scalarChanged.length > 0,
    staleTime: 15_000
  })

  const isNumericField = (field: string, v: unknown) => {
    const t = fieldMap[field]?.type
    if (t && ['integer', 'bigInteger', 'decimal', 'float', 'number'].includes(t)) return true
    return v != null && v !== '' && !Array.isArray(v) && !Number.isNaN(Number(v))
  }
  const isCurrencyField = (field: string) => {
    const opts = fieldMap[field]?.options as Record<string, unknown> | null | undefined
    if (opts && typeof opts === 'object' && opts.format === 'currency') return true
    return /amount|cost|price|total|budget|spend/i.test(field)
  }
  const fmtNum = (field: string, v: unknown) =>
    isCurrencyField(field)
      ? usd.format(Number(v))
      : new Intl.NumberFormat('en-US').format(Number(v))

  // Collapsed-bar ± chip for data addendums (cost_impact only exists on
  // imports): first changed currency field's proposed − current.
  const barDelta = useMemo(() => {
    if (addendum.cost_impact != null && Number(addendum.cost_impact) !== 0) return null
    if (!currentRecord) return null
    for (const a of scalarChanged) {
      if (!isCurrencyField(a.field)) continue
      const proposed = Number(proposedData[a.field])
      const cur = Number(currentRecord[a.field])
      if (!Number.isNaN(proposed) && !Number.isNaN(cur) && proposed !== cur) return proposed - cur
    }
    return null
    // biome-ignore lint/correctness/useExhaustiveDependencies: helpers are stable per render
  }, [addendum.cost_impact, currentRecord, scalarChanged, proposedData])

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-white transition-shadow hover:shadow-sm dark:bg-card',
        isActive
          ? 'border-amber-300 dark:border-amber-500/40'
          : 'border-slate-200 dark:border-border'
      )}
    >
      <button
        type='button'
        className='flex w-full items-start gap-3 px-4 py-3 text-left'
        onClick={() => setExpanded((x) => !x)}
      >
        <span className={cn('mt-0.5 h-2 w-2 shrink-0 rounded-full', styles.dot)} />
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2 flex-wrap'>
            <span className='text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate'>
              {addendum.title}
            </span>
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                styles.badge
              )}
            >
              {displayStatus}
            </span>
            {changedFields.length > 0 && (
              <span className='text-[11px] text-slate-400 dark:text-slate-500'>
                {changedFields.length} field{changedFields.length !== 1 ? 's' : ''} changed
              </span>
            )}
            {costImpactChip(addendum.cost_impact) ?? costImpactChip(barDelta)}
          </div>
          {addendum.description && (
            <p className='mt-0.5 text-[12px] text-slate-500 dark:text-slate-400 line-clamp-1'>
              {stripTags(addendum.description)}
            </p>
          )}
        </div>
        <span
          className={cn(
            'shrink-0 text-[10px] text-slate-400 transition-transform',
            expanded && 'rotate-180'
          )}
        >
          ▾
        </span>
      </button>

      {expanded && (
        <div className='border-t border-slate-100 dark:border-border'>
          <AddendumDetails addendum={addendum} />
          {(changedFields.length > 0 ||
            addendum.previous_amount != null ||
            addendum.new_amount != null) && (
            <div className='px-4 py-3'>
              <p className='mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>
                Proposed changes
              </p>
              <div className='space-y-1.5'>
                {changedFields.length === 0 &&
                  (addendum.previous_amount != null || addendum.new_amount != null) &&
                  (() => {
                    const prev =
                      addendum.previous_amount != null ? Number(addendum.previous_amount) : null
                    const next = addendum.new_amount != null ? Number(addendum.new_amount) : null
                    const delta = prev != null && next != null ? next - prev : null
                    return (
                      <div className='flex items-baseline gap-2 text-[12px]'>
                        <span className='min-w-[80px] shrink-0 text-slate-500 dark:text-slate-400'>
                          Amount
                        </span>
                        <span className='font-mono text-[11px] text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-muted/50 rounded px-1.5 py-0.5'>
                          <span className='inline-flex flex-wrap items-baseline gap-1.5'>
                            {prev != null && prev !== next && (
                              <>
                                <span className='tabular-nums text-slate-400 line-through dark:text-slate-500'>
                                  {usd.format(prev)}
                                </span>
                                <span className='text-slate-400'>→</span>
                              </>
                            )}
                            <span className='tabular-nums font-semibold'>
                              {next != null ? usd.format(next) : '—'}
                            </span>
                            {delta != null && delta !== 0 && (
                              <span
                                className={cn(
                                  'rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums',
                                  delta > 0
                                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                                    : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
                                )}
                              >
                                {delta > 0 ? '+' : '−'}
                                {usd.format(Math.abs(delta))}
                              </span>
                            )}
                          </span>
                        </span>
                      </div>
                    )
                  })()}
                {changedFields.map((a) => {
                  const rawVal = proposedData[a.field]
                  let displayVal: ReactNode
                  if (rawVal == null) {
                    displayVal = '—'
                  } else if (Array.isArray(rawVal)) {
                    const origArr = originalO2MMap[a.field]
                    if (!origArr) displayVal = `${rawVal.length} rows`
                    else {
                      const changed = rawVal.filter((row: Record<string, unknown>) => {
                        const orig = origArr.find(
                          (o: Record<string, unknown>) => String(o.id) === String(row.id)
                        )
                        if (!orig) return true
                        return Object.keys(row).some(
                          (k) => k !== 'id' && String(row[k] ?? '') !== String(orig[k] ?? '')
                        )
                      }).length
                      displayVal =
                        changed === 0
                          ? 'no changes'
                          : `${changed} of ${rawVal.length} rows modified`
                    }
                  } else if (typeof rawVal === 'object') {
                    displayVal = JSON.stringify(rawVal).slice(0, 60)
                  } else if (isNumericField(a.field, rawVal)) {
                    const proposed = Number(rawVal)
                    const cur = currentRecord?.[a.field]
                    const curNum =
                      cur != null && cur !== '' && !Number.isNaN(Number(cur)) ? Number(cur) : null
                    const delta = curNum != null ? proposed - curNum : null
                    displayVal = (
                      <span className='inline-flex flex-wrap items-baseline gap-1.5'>
                        {curNum != null && curNum !== proposed && (
                          <>
                            <span className='tabular-nums text-slate-400 line-through dark:text-slate-500'>
                              {fmtNum(a.field, curNum)}
                            </span>
                            <span className='text-slate-400'>→</span>
                          </>
                        )}
                        <span className='tabular-nums font-semibold'>
                          {fmtNum(a.field, proposed)}
                        </span>
                        {delta != null && delta !== 0 && (
                          <span
                            className={cn(
                              'rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums',
                              delta > 0
                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                                : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
                            )}
                          >
                            {delta > 0 ? '+' : '−'}
                            {fmtNum(a.field, Math.abs(delta))}
                          </span>
                        )}
                      </span>
                    )
                  } else {
                    displayVal = String(rawVal)
                  }
                  return (
                    <div key={a.field} className='flex items-baseline gap-2 text-[12px]'>
                      <span className='min-w-[80px] shrink-0 text-slate-500 dark:text-slate-400'>
                        {a.label_override ?? fieldMap[a.field]?.label ?? titleCase(a.field)}
                      </span>
                      <span className='font-mono text-[11px] text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-muted/50 rounded px-1.5 py-0.5 break-all'>
                        {displayVal}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {addendum.workflow_template_id && (
            <div className='border-t border-slate-100 dark:border-border px-4 py-3'>
              <p className='mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>
                Workflow
              </p>
              <AddendumWorkflowPanel addendumId={addendum.id} onRefresh={onRefresh} />
              {isAdmin && (
                <div className='mt-2 flex items-center justify-end gap-2'>
                  {addendum.status === 'approved' ? (
                    confirmRevert ? (
                      <span className='flex items-center gap-1.5'>
                        <span className='text-[11px] text-amber-600 dark:text-amber-400'>
                          Roll every applied change back?
                        </span>
                        <Button
                          size='sm'
                          className='h-6 bg-amber-600 px-2 text-[11px] text-white hover:bg-amber-700'
                          disabled={revertMut.isPending}
                          onClick={() => {
                            revertMut.mutate()
                            setConfirmRevert(false)
                          }}
                        >
                          {revertMut.isPending ? 'Reverting…' : 'Revert'}
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-6 px-2 text-[11px]'
                          onClick={() => setConfirmRevert(false)}
                        >
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <button
                        type='button'
                        data-tip='Admin only — restores the record to its pre-approval values through the normal revision trail; the addendum stays as a reverted record of what happened'
                        onClick={() => setConfirmRevert(true)}
                        className='text-[11px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-amber-600'
                      >
                        Revert…
                      </button>
                    )
                  ) : confirmDelete ? (
                    <span className='flex items-center gap-1.5'>
                      <span className='text-[11px] text-red-600 dark:text-red-400'>
                        Delete this addendum and its approval workflow?
                      </span>
                      <Button
                        size='sm'
                        className='h-6 bg-red-600 px-2 text-[11px] text-white hover:bg-red-700'
                        disabled={deleteMut.isPending}
                        onClick={() => {
                          deleteMut.mutate()
                          setConfirmDelete(false)
                        }}
                      >
                        {deleteMut.isPending ? 'Deleting…' : 'Delete'}
                      </Button>
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-6 px-2 text-[11px]'
                        onClick={() => setConfirmDelete(false)}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <button
                      type='button'
                      data-tip='Admin only — removes the addendum and its approval workflow; nothing has applied to the record yet'
                      onClick={() => setConfirmDelete(true)}
                      className='text-[11px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-red-600'
                    >
                      Delete addendum…
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className='flex items-center justify-end gap-2 border-t border-slate-100 dark:border-border px-4 py-2.5'>
            {addendum.status === 'draft' && !addendum.workflow_template_id && (
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[11px]'
                onClick={() => submitMut.mutate()}
                disabled={submitMut.isPending}
              >
                {submitMut.isPending ? 'Submitting…' : 'Submit for Review'}
              </Button>
            )}
            {addendum.status === 'review' && !addendum.workflow_template_id && (
              <>
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 border-red-200 text-[11px] text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20'
                  onClick={() => rejectMut.mutate()}
                  disabled={rejectMut.isPending}
                >
                  Reject
                </Button>
                <Button
                  size='sm'
                  className='h-7 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700'
                  onClick={() => approveMut.mutate()}
                  disabled={approveMut.isPending}
                >
                  {approveMut.isPending ? 'Approving…' : 'Approve'}
                </Button>
              </>
            )}
            {!addendum.workflow_template_id &&
              (addendum.status === 'approved' || addendum.status === 'rejected') && (
                <span className='text-[11px] text-slate-400 dark:text-slate-500 italic'>
                  {addendum.status === 'approved'
                    ? 'Changes applied to record'
                    : 'No changes applied'}
                </span>
              )}
            {addendum.status === 'reverted' && (
              <span className='text-[11px] italic text-amber-600 dark:text-amber-400'>
                Reverted — the applied changes were rolled back
              </span>
            )}
            {isAdmin &&
              addendum.status === 'approved' &&
              (confirmRevert ? (
                <span className='ml-auto flex items-center gap-1.5'>
                  <span className='text-[11px] text-amber-600 dark:text-amber-400'>
                    Roll every applied change back?
                  </span>
                  <Button
                    size='sm'
                    className='h-7 bg-amber-600 text-[11px] text-white hover:bg-amber-700'
                    disabled={revertMut.isPending}
                    onClick={() => {
                      revertMut.mutate()
                      setConfirmRevert(false)
                    }}
                  >
                    {revertMut.isPending ? 'Reverting…' : 'Revert'}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-7 text-[11px]'
                    onClick={() => setConfirmRevert(false)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <button
                  type='button'
                  data-tip='Admin only — restores the record to its pre-approval values through the normal revision trail; the addendum stays as a reverted record of what happened'
                  onClick={() => setConfirmRevert(true)}
                  className='ml-auto text-[11px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-amber-600'
                >
                  Revert…
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── AddendumPanel (exported) ─────────────────────────────────────────────────

export function AddendumPanel({
  collection,
  item,
  addendumLayoutId,
  canCreate = true,
  onActiveCountChange,
  onApplied,
  defaultExpanded = true
}: {
  collection: string
  item: string
  addendumLayoutId?: number | null
  canCreate?: boolean
  onActiveCountChange?: (count: number) => void
  /** Fired after an addendum is approved/rejected/submitted — i.e. whenever the
   *  parent record may now read differently. ItemEditForm uses it to refresh a
   *  generated PDF so the attached document matches the amended record. */
  onApplied?: () => void
  defaultExpanded?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(!defaultExpanded)

  const {
    data: addendums = [],
    isLoading,
    refetch
  } = useQuery<Addendum[]>({
    queryKey: ['addendums', collection, item],
    queryFn: () =>
      client
        .request<{ data: Addendum[] }>(get(`/addendums/${collection}/${item}`))
        .then((r) => r.data ?? [])
  })

  // Resolve the addendum layout: use provided ID or fall back to first addendum-type layout
  const { data: addendumLayout, isLoading: isLoadingLayout } = useQuery<AddendumLayout | null>({
    queryKey: ['addendum-layout', collection, addendumLayoutId ?? 'default'],
    queryFn: async () => {
      const layouts = await client
        .request<{ data: AddendumLayout[] }>(
          get('/collection-layouts', { collection, layout_type: 'addendum' })
        )
        .then((r) => r.data ?? [])
      if (addendumLayoutId != null) {
        return layouts.find((l) => l.id === addendumLayoutId) ?? null
      }
      return layouts[0] ?? null
    },
    staleTime: 5 * 60 * 1000
  })

  const resolvedLayoutId = addendumLayoutId ?? addendumLayout?.id ?? null

  const { data: assignments = [] } = useQuery<LayoutAssignment[]>({
    queryKey: ['addendum-layout-assignments', resolvedLayoutId],
    queryFn: () =>
      resolvedLayoutId
        ? client
            .request<{ data: LayoutAssignment[] }>(
              get(`/collection-layouts/${resolvedLayoutId}/assignments`)
            )
            .then((r) => r.data ?? [])
        : Promise.resolve([]),
    enabled: !!resolvedLayoutId,
    staleTime: 5 * 60 * 1000
  })

  const { data: collectionFields = [] } = useQuery<CMSField[]>({
    queryKey: ['collection-fields', collection, resolvedLayoutId],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(
          get(
            `/field-config/${collection}`,
            resolvedLayoutId ? { layout_id: String(resolvedLayoutId) } : undefined
          )
        )
        .then((r) => r.data ?? []),
    enabled: resolvedLayoutId != null,
    staleTime: 5 * 60 * 1000
  })

  const { data: relations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['relations', collection],
    queryFn: () =>
      client
        .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => r.data ?? []),
    staleTime: 5 * 60 * 1000
  })

  const { data: parentItem, isLoading: isParentLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['item', collection, item],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${item}`))
        .then((r) => r.data ?? {}),
    enabled: sheetOpen,
    staleTime: 0
  })

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['addendums', collection, item] })
    refetch()
    onApplied?.()
  }

  const configuredFields = assignments.filter(
    (a) => !String(a.field).startsWith('__') && (a.is_visible || a.is_visible === 1)
  )
  const activeCount = addendums.filter((a) => !['approved', 'rejected', 'reverted'].includes(a.status)).length

  const onActiveCountChangeRef = useRef(onActiveCountChange)
  onActiveCountChangeRef.current = onActiveCountChange
  useEffect(() => {
    onActiveCountChangeRef.current?.(activeCount)
  }, [activeCount])

  // Hide the slot entirely unless there is something to show or do: existing
  // addendums, OR creation is allowed in the current state/role (canCreate is
  // computed by the host from addendum_allowed_states/roles). Held null while
  // loading so it can't flash in and then vanish.
  if (!canCreate && (isLoading || addendums.length === 0)) return null

  return (
    <>
      <div
        className={cn(
          'overflow-hidden rounded-xl border bg-white dark:bg-card',
          activeCount > 0
            ? 'border-amber-300 dark:border-amber-500/40'
            : 'border-slate-200 dark:border-border'
        )}
      >
        <div
          className={cn(
            'flex items-center justify-between px-4 py-3 cursor-pointer select-none',
            !collapsed &&
              (activeCount > 0
                ? 'border-b border-amber-200 dark:border-amber-500/30'
                : 'border-b border-slate-200 dark:border-border')
          )}
          onClick={() => setCollapsed((c) => !c)}
        >
          <div className='flex items-center gap-2'>
            <FileDiff className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500' />
            <h3 className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
              Addendums
            </h3>
            {activeCount > 0 && (
              <span className='inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'>
                <span className='h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse' />
                {activeCount} in review
              </span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            {canCreate && (!addendumLayout?.single_active_addendum || activeCount === 0) && (
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[12px]'
                onClick={(e) => {
                  e.stopPropagation()
                  setSheetOpen(true)
                }}
              >
                + New Addendum
              </Button>
            )}
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150',
                collapsed && '-rotate-90'
              )}
            />
          </div>
        </div>

        {!collapsed && !addendumLayout && !isLoadingLayout && (
          <div className='px-4 py-4 text-center'>
            <p className='text-[12px] text-slate-400'>No addendum form configured.</p>
            <p className='text-[11px] text-slate-300 dark:text-slate-600'>
              Create an "Addendum Form" layout in Data Model → Layouts to enable addendum creation.
            </p>
          </div>
        )}

        {!collapsed &&
          (addendumLayout || isLoadingLayout) &&
          (isLoading ? (
            <div className='p-4 space-y-2'>
              <Skeleton className='h-12 w-full' />
              <Skeleton className='h-12 w-full' />
            </div>
          ) : addendums.length === 0 ? (
            <div className='px-4 py-8 text-center'>
              <p className='text-[12px] text-slate-400 dark:text-slate-500'>
                No addendum attached to this record
              </p>
              <p className='mt-0.5 text-[11px] text-slate-300 dark:text-slate-600'>
                Addendums propose changes that go through a review process before being applied.
              </p>
            </div>
          ) : (
            <div className='p-3 space-y-2'>
              {addendums.map((a) => (
                <AddendumCard
                  key={a.id}
                  addendum={a}
                  configuredFields={configuredFields}
                  onRefresh={handleRefresh}
                  isActive={!['approved', 'rejected', 'reverted'].includes(a.status)}
                  relations={relations}
                  parentCollection={collection}
                  parentId={item}
                  fieldMap={Object.fromEntries(collectionFields.map((f) => [f.field, f]))}
                />
              ))}
            </div>
          ))}
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side='right' className='w-[80vw] sm:max-w-[80vw] p-0 flex flex-col'>
          {sheetOpen && isParentLoading ? (
            <div className='flex flex-col gap-3 p-6'>
              <Skeleton className='h-6 w-48' />
              <Skeleton className='h-9 w-full' />
              <Skeleton className='h-9 w-full' />
              <Skeleton className='h-9 w-full' />
              <Skeleton className='h-9 w-3/4' />
            </div>
          ) : sheetOpen && parentItem ? (
            <AddendumCreateSheet
              collection={collection}
              itemId={item}
              assignments={assignments}
              workflowTemplateId={addendumLayout?.workflow_template_id ?? null}
              resolvedLayoutId={resolvedLayoutId}
              fields={collectionFields}
              relations={relations}
              parentData={parentItem}
              onClose={() => setSheetOpen(false)}
              onCreated={handleRefresh}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
