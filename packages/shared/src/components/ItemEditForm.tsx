import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronDown, Loader2, Save, Trash2 } from 'lucide-react'
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
import { ItemEditAuthContext, useNivaroClient } from '../context'
import { del, get, patch, post } from '../lib/commands'
import { cn, formatRelative, titleCase } from '../lib/utils'
import { FieldRow } from './item-edit/FieldRow'
import { GroupSection } from './item-edit/GroupSection'
import { resolveColSpan, SENTINEL_FIELDS, SYSTEM_FIELDS, useContainerWidth } from './item-edit/helpers'
import { M2MStagingContext, type M2MStagingCtx } from './item-edit/M2MStagingContext'
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
  StepDef
} from './item-edit/types'
import { CommentPanel, ItemLockBanner, PipelinePanel, PipelineTransitionButtons, RevisionsPanel, TaskPanel, useItemLock, WorkflowPanel } from './panels'
import type { PendingTask } from './panels/TaskPanel'
import { Button } from './ui/button'
import { Skeleton } from './ui/skeleton'

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
  showPipeline?: boolean
  showWorkflow?: boolean
  showComments?: boolean
  showTasks?: boolean
  showLockBanner?: boolean
  className?: string
  headerClassName?: string
  renderField?: (props: RenderFieldProps) => ReactNode
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
  showPipeline = true,
  showWorkflow = true,
  showComments = true,
  showTasks = true,
  showLockBanner = true,
  className,
  headerClassName,
  renderField
}: ItemEditFormProps) {
  const client = useNivaroClient()
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

  const { data: fieldConfig, isLoading: fieldsLoading } = useQuery<CMSField[]>({
    queryKey: ['field-config', collection, layoutId],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(get(`/field-config/${collection}`, layoutId ? { layout_id: String(layoutId) } : undefined))
        .then((r) => r.data ?? []),
    staleTime: 60_000,
    enabled: !layoutSlug || activeLayoutData !== undefined
  })

  const { data: relations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['relations', collection],
    queryFn: () =>
      client
        .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => r.data ?? []),
    staleTime: 60_000
  })

  const { data: colMeta } = useQuery<{ display_name?: string; item_locking_enabled?: boolean }>({
    queryKey: ['col-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { display_name?: string; item_locking_enabled?: boolean } }>(
          get(`/collections/${collection}`)
        )
        .then((r) => r.data),
    staleTime: 60_000
  })

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
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  const [isDirty, setIsDirty] = useState(false)
  const initialDataRef = useRef<Record<string, unknown>>({})
  const touchedFields = useRef<Set<string>>(new Set())

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
    })
  }), [pendingO2MRows])

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

  useEffect(() => {
    if (itemData) {
      initialDataRef.current = itemData
      setDraft(itemData)
      setIsDirty(false)
    }
  }, [itemData])

  const handleFieldChange = useCallback(
    (field: string, value: unknown) => {
      setDraft((prev) => {
        const next = { ...prev, [field]: value }
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
        return next
      })
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

  const handleM2MCountChange = useCallback(
    (field: string, count: number) => {
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
    return deduped.filter((f) => assignedFieldSet.has(f.field) || SYSTEM_FIELDS.has(f.field) || SENTINEL_FIELDS.has(f.field))
  }, [fieldConfig, assignedFieldSet, layoutSlug, activeLayoutData])

  const groups = useMemo<FieldGroup[]>(() => {
    return (activeLayoutData?.groups ?? []).sort((a, b) => a.sort - b.sort)
  }, [activeLayoutData])

  const groupedMap = useMemo<Record<string, CMSField[]>>(() => {
    // Build from raw fieldConfig (not deduped allFields) so multi-group fields appear in each group
    const raw = fieldConfig ? [...fieldConfig].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)) : []
    const map: Record<string, CMSField[]> = {}
    for (const f of raw) {
      if (!f.group_key || SENTINEL_FIELDS.has(f.field)) continue
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
          !f.group_key && !f.hidden && !SYSTEM_FIELDS.has(f.field) && !SENTINEL_FIELDS.has(f.field)
      ),
    [allFields]
  )

  const systemFields = useMemo(
    () => allFields.filter((f) => SYSTEM_FIELDS.has(f.field) || f.readonly),
    [allFields]
  )

  const tabGroups = useMemo(() => groups.filter((g) => g.type === 'tab'), [groups])
  const sectionGroups = useMemo(() => groups.filter((g) => g.type === 'section' || g.type === 'metadata'), [groups])
  const hasTabs = tabGroups.length > 0
  const layoutMeta = activeLayoutData?.layout
  const layoutAiEnabled = layoutMeta ? !!layoutMeta.ai_enabled : true
  const isStepsMode = hasTabs && layoutMeta?.tab_mode === 'steps'
  const validateBeforeNext = !!layoutMeta?.validate_before_next
  const summaryEnabled = !!layoutMeta?.summary_enabled

  const bodyRef = useRef<HTMLDivElement>(null)
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

  const sectionOrder = useMemo(() => {
    const isVisible = (a: SlotAssignment | undefined) =>
      !(a && (a.is_visible === 0 || a.is_visible === false))
    type Item = FieldGroup | '__ungrouped__' | '__pipeline__' | '__comments__' | '__tasks__'
    const entries: Array<{ item: Item; sort: number; tie: number }> = [
      ...sectionGroups.map((g) => ({ item: g as Item, sort: g.sort, tie: 0 })),
      {
        item: '__ungrouped__',
        sort: activeLayoutData?.ungrouped_sort ?? sectionGroups.length,
        tie: 1
      }
    ]
    if (showPipeline && pipelineSlot && isVisible(pipelineSlot))
      entries.push({ item: '__pipeline__', sort: pipelineSlot.sort, tie: 2 })
    if (showTasks && tasksSlot && isVisible(tasksSlot))
      entries.push({ item: '__tasks__', sort: tasksSlot.sort, tie: 3 })
    if (showComments && commentsSlot && isVisible(commentsSlot))
      entries.push({ item: '__comments__', sort: commentsSlot.sort, tie: 4 })
    return entries.sort((a, b) => a.sort - b.sort || a.tie - b.tie).map((e) => e.item)
  }, [
    sectionGroups,
    activeLayoutData,
    pipelineSlot,
    commentsSlot,
    tasksSlot,
    showPipeline,
    showComments,
    showTasks
  ])

  // ── Client-side validation ─────────────────────────────────────────────────
  function validateAll(): boolean {
    const errs: Record<string, string> = {}
    for (const f of allFields) {
      if (f.hidden || f.readonly || SYSTEM_FIELDS.has(f.field) || SENTINEL_FIELDS.has(f.field)) continue
      if (f.required) {
        const v = draft[f.field]
        if (v === null || v === undefined || v === '') errs[f.field] = 'This field is required'
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
      const payload: Record<string, unknown> = {}
      for (const f of allFields) {
        if (SYSTEM_FIELDS.has(f.field) || f.readonly) continue
        if (f.field in draft) payload[f.field] = draft[f.field]
      }
      let savedId: string
      if (isNew) {
        const r = await client.request<{ data: { id: string | number } }>(
          post(`/items/${collection}`, payload)
        )
        savedId = String(r.data.id)
      } else {
        await client.request(patch(`/items/${collection}/${itemId}`, payload))
        savedId = itemId
      }

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

      for (const [key, ids] of m2mUnlinks.entries()) {
        if (!ids.size) continue
        const rel = findM2MRel(key)
        if (!rel) continue
        await Promise.all(
          [...ids].map((jId) =>
            client.request(del(`/items/${rel.many_collection}/${jId}`)).catch(() => {})
          )
        )
      }

      for (const [key, ids] of m2mLinks.entries()) {
        if (!ids.length) continue
        const rel = findM2MRel(key)
        if (!rel) continue
        await Promise.all(
          ids.map((relId) =>
            client
              .request(
                post(`/items/${rel.many_collection}`, {
                  [rel.many_field!]: savedId,
                  [rel.junction_field]: relId
                })
              )
              .catch(() => {})
          )
        )
      }

      if (isNew && pendingComments.length > 0) {
        await Promise.all(
          pendingComments.map((text) =>
            client.request(post('/comments', { collection, item: savedId, text })).catch(() => {})
          )
        )
      }

      if (isNew && pendingO2MRows.size > 0) {
        const flushOps: Promise<unknown>[] = []
        for (const [key, rowList] of pendingO2MRows.entries()) {
          const [rc, mf] = key.split('.')
          for (const data of rowList) {
            flushOps.push(
              client.request(post(`/items/${rc}`, { ...data, [mf]: savedId })).catch(() => {})
            )
          }
        }
        await Promise.all(flushOps)
      }

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
      setIsDirty(false)
      setM2mLinks(new Map())
      setM2mUnlinks(new Map())
      setPendingComments([])
      setPendingTasks([])
      setPendingO2MRows(new Map())
      toast.success(isNew ? 'Record created' : 'Changes saved')
      qc.invalidateQueries({ queryKey: ['item', collection] })
      qc.invalidateQueries({ queryKey: ['m2m-items'] })
      onSaved?.(id)
    },
    onError: (err: unknown) => {
      const resp = (err as { response?: { data?: { error?: string; field?: string } } })?.response
      if (resp?.data?.field)
        setValidationErrors({ [resp.data.field]: resp.data.error ?? 'Invalid' })
      toast.error(resp?.data?.error ?? 'Failed to save')
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

  function renderSentinel(key: string) {
    if (key === '__pipeline__' && showPipeline) {
      return (
        <PipelinePanel
          key='__pipeline__'
          collection={collection}
          item={itemId}
          title={pipelineSlot?.label_override ?? undefined}
          defaultExpanded={pipelineSlot?.default_expanded ?? false}
          onBeforeTransition={validateAll}
        />
      )
    }
    if (key === '__comments__' && showComments) {
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
    if (key === '__tasks__' && showTasks) {
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
    return null
  }

  function renderUngrouped() {
    const visible = ungroupedFields.filter((f) => !f.hidden)
    if (visible.length === 0) return null
    return (
      <div key='__ungrouped__' className='rounded-xl border border-slate-200 bg-white px-5 py-5'>
        <GridContainer>
          {(cw) => visible.map((f) => (
            <div key={f.field} style={{ gridColumn: `span ${resolveColSpan(f.options, cw)}` }}>
              <FieldRow
                field={f}
                draft={draft}
                onChange={handleFieldChange}
                relations={relations}
                collection={collection}
                itemId={itemId}
                error={validationErrors[f.field]}
                visible={true}
                locked={isReadOnly}
                layoutAiEnabled={layoutAiEnabled}
                renderField={renderField}
                onCountChange={handleM2MCountChange}
              />
            </div>
          ))}
        </GridContainer>
      </div>
    )
  }

  function renderSectionItem(
    item: FieldGroup | '__ungrouped__' | '__pipeline__' | '__comments__' | '__tasks__'
  ) {
    if (item === '__ungrouped__') return renderUngrouped()
    if (item === '__pipeline__' || item === '__comments__' || item === '__tasks__')
      return renderSentinel(item)
    const g = item as FieldGroup
    if (g.type === 'metadata' && isNew) return null
    const groupFields = groupedMap[g.key] ?? []
    if (groupFields.length === 0) return null
    return (
      <GroupSection
        key={g.key}
        group={g}
        fields={groupFields}
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
          <PipelinePanel collection={collection} item={itemId} onBeforeTransition={validateAll} />
        )}
        {!tasksSlot && showTasks && <TaskPanel collection={collection} item={itemId} queuedTasks={isNew ? pendingTasks : undefined} onQueueTask={isNew ? handleQueueTask : undefined} />}
        {!commentsSlot && showComments && (
          <CommentPanel collection={collection} item={itemId} queuedComments={isNew ? pendingComments : undefined} onQueueComment={isNew ? handleQueueComment : undefined} />
        )}
        {showWorkflow && <WorkflowPanel collection={collection} item={itemId} />}
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
    return (
      <div className='rounded-xl border border-slate-200 bg-white px-5 py-5'>
        <GridContainer>
          {(cw) => fields.map((f) => (
            <div key={f.field} style={{ gridColumn: `span ${resolveColSpan(f.options, cw)}` }}>
              <FieldRow
                field={f}
                draft={draft}
                onChange={handleFieldChange}
                relations={relations}
                collection={collection}
                itemId={itemId}
                error={validationErrors[f.field]}
                visible={true}
                locked={isReadOnly}
                layoutAiEnabled={layoutAiEnabled}
                renderField={renderField}
                onCountChange={handleM2MCountChange}
              />
            </div>
          ))}
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
          .map((item) => renderSentinel(item as '__pipeline__' | '__comments__' | '__tasks__'))}
        {!pipelineSlot && showPipeline && (
          <PipelinePanel collection={collection} item={itemId} onBeforeTransition={validateAll} />
        )}
        {!tasksSlot && showTasks && <TaskPanel collection={collection} item={itemId} queuedTasks={isNew ? pendingTasks : undefined} onQueueTask={isNew ? handleQueueTask : undefined} />}
        {!commentsSlot && showComments && (
          <CommentPanel collection={collection} item={itemId} queuedComments={isNew ? pendingComments : undefined} onQueueComment={isNew ? handleQueueComment : undefined} />
        )}
        {showWorkflow && <WorkflowPanel collection={collection} item={itemId} />}
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
            {isLast ? (
              <button
                type='button'
                onClick={() => handleSave()}
                disabled={saveMut.isPending || isReadOnly}
                className='inline-flex h-9 items-center gap-1.5 rounded-md bg-[#00ceff] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0] disabled:opacity-50'
              >
                <Save className='h-3.5 w-3.5' />
                {saveMut.isPending ? 'Saving…' : 'Save'}
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
      return false
    })
    const postTabItems = sectionOrder.filter((item) => {
      if (item === '__ungrouped__') return false
      if (typeof item !== 'string') return (item as FieldGroup).sort >= minGroupSort
      if (item === '__pipeline__') return !(pipelineSlot && pipelineSlot.sort < minGroupSort)
      if (item === '__comments__') return !(commentsSlot && commentsSlot.sort < minGroupSort)
      if (item === '__tasks__') return !(tasksSlot && tasksSlot.sort < minGroupSort)
      return false
    })

    return (
      <div className='space-y-4 min-w-0 flex-1'>
        {preTabItems.map((item, i) => {
          const key = typeof item === 'string' ? item : (item as FieldGroup).key
          return <div key={key ?? i}>{renderSectionItem(item as FieldGroup | '__ungrouped__' | '__pipeline__' | '__comments__' | '__tasks__')}</div>
        })}
        <div className='rounded-xl border border-slate-200 bg-white px-5 py-3'>
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
        </div>
        {renderTabContent(activeTab, true)}
        {postTabItems.map((item, i) => {
          const key = typeof item === 'string' ? item : (item as FieldGroup).key
          return <div key={key ?? i}>{renderSectionItem(item as FieldGroup | '__ungrouped__' | '__pipeline__' | '__comments__' | '__tasks__')}</div>
        })}
        {!pipelineSlot && showPipeline && (
          <PipelinePanel collection={collection} item={itemId} defaultExpanded={false} onBeforeTransition={validateAll} />
        )}
        {!tasksSlot && showTasks && (
          <TaskPanel collection={collection} item={itemId} defaultExpanded={false} queuedTasks={isNew ? pendingTasks : undefined} onQueueTask={isNew ? handleQueueTask : undefined} />
        )}
        {!commentsSlot && showComments && (
          <CommentPanel collection={collection} item={itemId} defaultExpanded={false} queuedComments={isNew ? pendingComments : undefined} onQueueComment={isNew ? handleQueueComment : undefined} />
        )}
        {showWorkflow && <WorkflowPanel collection={collection} item={itemId} />}
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
  const canDelete = !isNew && isAdmin

  return (
    <O2MStagingContext.Provider value={o2mStagingCtx}>
    <M2MStagingContext.Provider value={m2mStagingCtx}>
      <div className={cn('flex flex-1 min-h-0 flex-col', className)}>
        {showHeader && (
          <header
            className={cn(
              'shrink-0 border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-3',
              headerClassName
            )}
          >
            {onBack && (
              <button
                type='button'
                onClick={onBack}
                className='text-muted-foreground hover:text-foreground transition-colors'
              >
                <ArrowLeft className='h-4 w-4' />
              </button>
            )}
            <h1 className='text-base font-semibold text-slate-800'>
              {isNew ? `New ${title}` : title}
            </h1>
            <div className='ml-auto flex items-center gap-2'>
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
              {showRevisions && !isNew && (
                <RevisionsPanel
                  collection={collection}
                  item={itemId}
                  onRollback={() =>
                    qc.invalidateQueries({ queryKey: ['item', collection, itemId] })
                  }
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
              {!isStepsMode && (
                <Button
                  type='button'
                  onClick={() => handleSave()}
                  disabled={saveMut.isPending || isReadOnly}
                  className='gap-1.5'
                >
                  {saveMut.isPending ? (
                    <Loader2 className='h-4 w-4 animate-spin' />
                  ) : (
                    <Save className='h-4 w-4' />
                  )}
                  {isNew ? 'Create' : 'Save'}
                </Button>
              )}
            </div>
          </header>
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
            {showLockBanner && (
              <ItemLockBanner
                lockHolder={lockHolder}
                onTakeOver={takeOver}
                takingOver={takingOver}
                isAdmin={isAdmin}
              />
            )}
            {hasTabs ? (isStepsMode ? renderStepsMode() : renderTabMode()) : renderSectionMode()}
          </div>
          {summaryEnabled && (
            <div className='w-64 shrink-0 overflow-y-auto border-l border-slate-200'>
              <SummaryPanel
                allSteps={allSteps}
                groupedMap={groupedMap}
                ungroupedFields={ungroupedFields}
                sectionGroups={sectionGroups}
                draft={draft}
                relations={relations}
                collection={collection}
                itemId={itemId}
                staging={m2mStagingCtx}
                errors={validationErrors}
                onFieldClick={(stepKey, fieldKey) => {
                  setActiveTab(stepKey)
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
          )}
        </div>
      </div>
    </M2MStagingContext.Provider>
    </O2MStagingContext.Provider>
  )
}
