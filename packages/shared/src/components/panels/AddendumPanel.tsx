import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo, useRef, useEffect, useCallback, memo } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { titleCase } from '../../lib/utils'
import { FieldRenderer } from '../item-edit/FieldRenderer'
import { O2MStagingContext } from '../item-edit/O2MStagingContext'
import type { O2MStagingCtx } from '../item-edit/O2MStagingContext'
import type { CMSField, CMSRelation } from '../item-edit/types'
import { Button } from '../ui/button'
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
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

const STATUS_STYLES: Record<string, { badge: string; dot: string }> = {
  draft:    { badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400', dot: 'bg-slate-400' },
  review:   { badge: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400', dot: 'bg-amber-400' },
  approved: { badge: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400', dot: 'bg-emerald-500' },
  rejected: { badge: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400', dot: 'bg-red-500' },
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
}: {
  configuredFields: LayoutAssignment[]
  fieldMap: Record<string, CMSField>
  formData: Record<string, unknown>
  onFieldChange: (field: string, value: unknown) => void
  relations: CMSRelation[]
  collection: string
  prefillParentId: string
}) {
  if (configuredFields.length === 0) {
    return (
      <div className='rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center dark:border-border dark:bg-muted/30'>
        <p className='text-[12px] text-slate-400 dark:text-slate-500'>
          No fields configured for addenda. Set up the field list in Data Model → Layouts → Addendum Form.
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
                <Label className='mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400'>{label}</Label>
                <Input
                  value={String(formData[a.field] ?? '')}
                  onChange={(e) => onFieldChange(a.field, e.target.value)}
                  className='h-8 text-[12px]'
                />
              </div>
            )
          }
          return (
            <div key={a.field}>
              <Label className='mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400'>{label}</Label>
              <FieldRenderer
                field={meta}
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

interface WfTransition { id: string; label: string; color: string | null; to_state: string; group_label: string | null }
interface WfState { id: string; key: string; label: string; color: string | null; is_terminal: boolean }
interface WfInstance { id: string; current_state: string; current_state_obj: WfState | null; completed_at: string | null }

function AddendumWorkflowPanel({ addendumId, onRefresh }: { addendumId: string; onRefresh: () => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)
  const [comment, setComment] = useState('')

  const instanceKey = ['pipeline-instance', 'nivaro_addendums', addendumId]

  const { data: pd, isLoading } = useQuery<{ instance: WfInstance | null; available_transitions: WfTransition[] } | null>({
    queryKey: instanceKey,
    queryFn: () =>
      client
        .request<{ data: { instance: WfInstance | null; available_transitions: WfTransition[] } | null }>(
          get(`/pipelines/instance/nivaro_addendums/${addendumId}`)
        )
        .then((r) => r.data),
    staleTime: 10_000,
  })

  const transitionMut = useMutation({
    mutationFn: ({ transitionId, note }: { transitionId: string; note?: string }) =>
      client.request(post(`/workflows/instance/${pd?.instance?.id}/transition`, { transition_id: transitionId, comment: note })),
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
    },
  })

  if (isLoading) return <Skeleton className='h-8 w-full' />
  if (!pd?.instance) return <p className='text-[12px] text-slate-400 italic'>No workflow instance found.</p>

  const { instance, available_transitions: transitions } = pd
  const state = instance.current_state_obj
  const pendingTx = transitions.find((t) => t.id === pending)

  return (
    <div className='space-y-3'>
      {state && (
        <div className='flex items-center gap-2'>
          <span className='text-[11px] text-slate-500'>Current state:</span>
          <span
            className='inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium'
            style={{ backgroundColor: state.color ? `${state.color}22` : '#f1f5f9', color: state.color ?? '#475569', border: `1px solid ${state.color ? `${state.color}44` : '#e2e8f0'}` }}
          >
            {state.label}
          </span>
        </div>
      )}

      {transitions.length > 0 && !instance.completed_at && (
        <div className='flex flex-wrap gap-1.5'>
          {transitions.map((tx) => (
            <button
              key={tx.id}
              type='button'
              onClick={() => setPending(pending === tx.id ? null : tx.id)}
              className={cn(
                'inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium transition-colors',
                pending === tx.id
                  ? 'bg-nvr-cyan text-white'
                  : 'bg-white hover:bg-slate-50 border border-slate-200 text-slate-700'
              )}
              style={
                tx.color && pending !== tx.id
                  ? { borderColor: tx.color, color: tx.color }
                  : tx.color && pending === tx.id
                    ? { backgroundColor: tx.color, borderColor: tx.color }
                    : undefined
              }
            >
              {tx.label}
            </button>
          ))}
        </div>
      )}

      {pending && pendingTx && (
        <div className='rounded-md border border-slate-200 bg-slate-50 p-2.5 space-y-2'>
          <p className='text-[11px] text-slate-500'>Confirm: <strong>{pendingTx.label}</strong></p>
          <input
            type='text'
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder='Add a comment (optional)'
            className='w-full rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
          />
          <div className='flex justify-end gap-2'>
            <Button type='button' size='sm' variant='ghost' className='h-6 text-[11px]' onClick={() => { setPending(null); setComment('') }}>
              Cancel
            </Button>
            <Button
              type='button'
              size='sm'
              className='h-6 text-[11px]'
              disabled={transitionMut.isPending}
              onClick={() => transitionMut.mutate({ transitionId: pending, note: comment.trim() || undefined })}
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
  onCreated,
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
  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    const pre: Record<string, unknown> = {}
    for (const a of configuredFields) {
      const ov = typeof a.overrides === 'string' ? (() => { try { return JSON.parse(a.overrides) } catch { return {} } })() : (a.overrides ?? {})
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
  const [pendingO2MRows, setPendingO2MRows] = useState<Map<string, Record<string, unknown>[]>>(new Map())
  const [pendingO2MEdits, setPendingO2MEdits] = useState<Map<string, Map<string, Record<string, unknown>>>>(new Map())
  const [pendingO2MDeletes, setPendingO2MDeletes] = useState<Map<string, Set<string>>>(new Map())
  const pendingO2MRowsRef = useRef(pendingO2MRows)
  useEffect(() => { pendingO2MRowsRef.current = pendingO2MRows }, [pendingO2MRows])

  const o2mStagingCtx = useMemo<O2MStagingCtx>(() => ({
    getPendingRows: (rc, mf) => pendingO2MRows.get(`${rc}.${mf}`) ?? [],
    queueRow: (rc, mf, data) => setPendingO2MRows(prev => {
      const next = new Map(prev); const key = `${rc}.${mf}`
      next.set(key, [...(next.get(key) ?? []), data]); return next
    }),
    removeRow: (rc, mf, idx) => setPendingO2MRows(prev => {
      const next = new Map(prev); const key = `${rc}.${mf}`
      const arr = [...(next.get(key) ?? [])]; arr.splice(idx, 1); next.set(key, arr); return next
    }),
    updateRow: (rc, mf, idx, data) => setPendingO2MRows(prev => {
      const next = new Map(prev); const key = `${rc}.${mf}`
      const arr = [...(next.get(key) ?? [])]; arr[idx] = { ...arr[idx], ...data }; next.set(key, arr); return next
    }),
    reorderRows: (rc, mf, fromIdx, toIdx) => setPendingO2MRows(prev => {
      const next = new Map(prev); const key = `${rc}.${mf}`
      const arr = [...(next.get(key) ?? [])]; const [moved] = arr.splice(fromIdx, 1)
      arr.splice(toIdx, 0, moved); next.set(key, arr); return next
    }),
    getPendingEdits: (rc, mf) => pendingO2MEdits.get(`${rc}.${mf}`) ?? new Map(),
    getPendingDeletes: (rc, mf) => pendingO2MDeletes.get(`${rc}.${mf}`) ?? new Set(),
    queueEdit: (rc, mf, rowId, changes) => setPendingO2MEdits(prev => {
      const next = new Map(prev); const key = `${rc}.${mf}`
      const inner = new Map(next.get(key) ?? []); inner.set(rowId, { ...(inner.get(rowId) ?? {}), ...changes })
      next.set(key, inner); return next
    }),
    queueDelete: (rc, mf, rowId) => setPendingO2MDeletes(prev => {
      const next = new Map(prev); const key = `${rc}.${mf}`
      next.set(key, new Set([...(next.get(key) ?? []), rowId])); return next
    }),
    cancelPendingEdit: (rc, mf, rowId) => setPendingO2MEdits(prev => {
      const next = new Map(prev); const key = `${rc}.${mf}`
      const inner = new Map(next.get(key) ?? []); inner.delete(rowId); next.set(key, inner); return next
    }),
    cancelPendingDelete: (rc, mf, rowId) => setPendingO2MDeletes(prev => {
      const next = new Map(prev); const key = `${rc}.${mf}`
      const s = new Set(next.get(key) ?? []); s.delete(rowId); next.set(key, s); return next
    }),
  }), [pendingO2MRows, pendingO2MEdits, pendingO2MDeletes])

  const createMut = useMutation({
    mutationFn: () => {
      // Merge O2M staging rows into formData before submit
      const mergedData = { ...formData }
      for (const a of configuredFields) {
        const rel = relations.find(r => r.one_collection === collection && r.one_field === a.field)
        if (rel?.many_collection && rel.many_field) {
          const rows = (pendingO2MRowsRef.current.get(`${rel.many_collection}.${rel.many_field}`) ?? [])
            .map(({ __prefilled: _, ...rest }) => rest)
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
        })
      )
    },
    onSuccess: () => {
      toast.success('Addendum created')
      onCreated()
      onClose()
    },
    onError: () => toast.error('Failed to create addendum'),
  })

  return (
    <O2MStagingContext.Provider value={o2mStagingCtx}>
    <div className='flex h-full flex-col'>
      <SheetHeader className='shrink-0 border-b border-slate-200 px-5 py-4 dark:border-border'>
        <SheetTitle className='text-[14px] font-semibold text-slate-900 dark:text-slate-100'>
          New Addendum
        </SheetTitle>
        <p className='mt-0.5 text-[12px] text-slate-500 dark:text-slate-400'>
          Propose changes to this record. Fields are pre-filled with current values — edit what's changing.
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
              placeholder='Brief description of this amendment'
              autoFocus
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400'>Notes</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className='text-[12px]'
              placeholder='Why is this change needed?'
            />
          </div>
        </div>

        <ProposedChangesForm
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

// ─── AddendumCard ──────────────────────────────────────────────────────────────

function AddendumCard({
  addendum,
  configuredFields,
  onRefresh,
}: {
  addendum: Addendum
  configuredFields: LayoutAssignment[]
  onRefresh: () => void
}) {
  const client = useNivaroClient()
  const [expanded, setExpanded] = useState(false)
  const styles = STATUS_STYLES[addendum.status] ?? STATUS_STYLES.draft

  const approveMut = useMutation({
    mutationFn: () => client.request(post(`/addendums/${addendum.id}/approve`)),
    onSuccess: () => { onRefresh(); toast.success('Addendum approved — changes applied to record') },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to approve')
    },
  })

  const rejectMut = useMutation({
    mutationFn: () => client.request(post(`/addendums/${addendum.id}/reject`)),
    onSuccess: () => { onRefresh(); toast.success('Addendum rejected') },
    onError: () => toast.error('Failed to reject'),
  })

  const submitMut = useMutation({
    mutationFn: () => client.request(post(`/addendums/${addendum.id}/submit`)),
    onSuccess: () => { onRefresh(); toast.success('Submitted for review') },
    onError: () => toast.error('Failed to submit'),
  })

  const proposedData = addendum.data ?? {}
  const changedFields = configuredFields.filter((a) => proposedData[a.field] !== undefined)

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white transition-shadow hover:shadow-sm dark:border-border dark:bg-card'>
      <button
        type='button'
        className='flex w-full items-start gap-3 px-4 py-3 text-left'
        onClick={() => setExpanded((x) => !x)}
      >
        <span className={cn('mt-0.5 h-2 w-2 shrink-0 rounded-full', styles.dot)} />
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2 flex-wrap'>
            <span className='text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate'>{addendum.title}</span>
            <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium', styles.badge)}>
              {addendum.status}
            </span>
            {changedFields.length > 0 && (
              <span className='text-[11px] text-slate-400 dark:text-slate-500'>
                {changedFields.length} field{changedFields.length !== 1 ? 's' : ''} changed
              </span>
            )}
          </div>
          {addendum.description && (
            <p className='mt-0.5 text-[12px] text-slate-500 dark:text-slate-400 line-clamp-1'>{addendum.description}</p>
          )}
        </div>
        <span className={cn('shrink-0 text-[10px] text-slate-400 transition-transform', expanded && 'rotate-180')}>▾</span>
      </button>

      {expanded && (
        <div className='border-t border-slate-100 dark:border-border'>
          {changedFields.length > 0 && (
            <div className='px-4 py-3'>
              <p className='mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>Proposed changes</p>
              <div className='space-y-1.5'>
                {changedFields.map((a) => {
                  const rawVal = proposedData[a.field]
                  const displayVal =
                    rawVal == null
                      ? '—'
                      : typeof rawVal === 'object'
                        ? Array.isArray(rawVal)
                          ? `${rawVal.length} items`
                          : JSON.stringify(rawVal).slice(0, 60)
                        : String(rawVal)
                  return (
                    <div key={a.field} className='flex items-baseline gap-2 text-[12px]'>
                      <span className='min-w-[80px] shrink-0 text-slate-500 dark:text-slate-400'>
                        {a.label_override ?? a.field}
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
              <p className='mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>Workflow</p>
              <AddendumWorkflowPanel addendumId={addendum.id} onRefresh={onRefresh} />
            </div>
          )}

          <div className='flex items-center justify-end gap-2 border-t border-slate-100 dark:border-border px-4 py-2.5'>
            {addendum.status === 'draft' && (
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
            {(addendum.status === 'approved' || addendum.status === 'rejected') && (
              <span className='text-[11px] text-slate-400 dark:text-slate-500 italic'>
                {addendum.status === 'approved' ? 'Changes applied to record' : 'No changes applied'}
              </span>
            )}
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
}: {
  collection: string
  item: string
  addendumLayoutId?: number | null
  canCreate?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [sheetOpen, setSheetOpen] = useState(false)

  const { data: addendums = [], isLoading, refetch } = useQuery<Addendum[]>({
    queryKey: ['addendums', collection, item],
    queryFn: () =>
      client
        .request<{ data: Addendum[] }>(get(`/addendums/${collection}/${item}`))
        .then((r) => r.data ?? []),
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
    staleTime: 5 * 60 * 1000,
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
    staleTime: 5 * 60 * 1000,
  })

  const { data: collectionFields = [] } = useQuery<CMSField[]>({
    queryKey: ['collection-fields', collection, resolvedLayoutId],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(get(`/field-config/${collection}`, resolvedLayoutId ? { layout_id: String(resolvedLayoutId) } : undefined))
        .then((r) => r.data ?? []),
    enabled: resolvedLayoutId != null,
    staleTime: 5 * 60 * 1000,
  })

  const { data: relations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['relations', collection],
    queryFn: () =>
      client
        .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => r.data ?? []),
    staleTime: 5 * 60 * 1000,
  })

  const { data: parentItem, isLoading: isParentLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['item', collection, item],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${item}`))
        .then((r) => r.data ?? {}),
    enabled: sheetOpen,
    staleTime: 0,
  })

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['addendums', collection, item] })
    refetch()
  }

  const configuredFields = assignments.filter(
    (a) => !String(a.field).startsWith('__') && (a.is_visible || a.is_visible === 1)
  )
  const pendingCount = addendums.filter((a) => a.status === 'review').length

  return (
    <>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-border'>
          <div>
            <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>Addenda & Amendments</h3>
            {pendingCount > 0 && (
              <p className='text-[11px] text-slate-400 dark:text-slate-500'>
                {pendingCount} pending review
              </p>
            )}
          </div>
          {canCreate && (
            <Button
              size='sm'
              variant='outline'
              className='h-7 text-[12px]'
              onClick={() => setSheetOpen(true)}
            >
              + New Addendum
            </Button>
          )}
        </div>

        {!addendumLayout && !isLoadingLayout && (
          <div className='px-4 py-4 text-center'>
            <p className='text-[12px] text-slate-400'>No addendum form configured.</p>
            <p className='text-[11px] text-slate-300 dark:text-slate-600'>
              Create an "Addendum Form" layout in Data Model → Layouts to enable addendum creation.
            </p>
          </div>
        )}

        {(addendumLayout || isLoadingLayout) && (
          isLoading ? (
            <div className='p-4 space-y-2'>
              <Skeleton className='h-12 w-full' />
              <Skeleton className='h-12 w-full' />
            </div>
          ) : addendums.length === 0 ? (
            <div className='px-4 py-8 text-center'>
              <p className='text-[12px] text-slate-400 dark:text-slate-500'>No addenda attached to this record</p>
              <p className='mt-0.5 text-[11px] text-slate-300 dark:text-slate-600'>
                Addenda propose changes that go through a review process before being applied.
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
                />
              ))}
            </div>
          )
        )}
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
