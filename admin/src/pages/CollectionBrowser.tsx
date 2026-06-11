import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  Download,
  Flag,
  FunctionSquare,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { BulkActionBar } from '@/components/bulk-action-bar'
import { ColumnPicker } from '@/components/column-picker'
import { DataTable } from '@/components/data-table'
import { FieldPicker } from '@/components/field-picker'
import { type ActiveFilter, FilterBar } from '@/components/filter-bar'
import { RelationLabel } from '@/components/relation-label'
import { SavedViews } from '@/components/saved-views'
import { TreePicker } from '@/components/tree-picker'
import { TreeView } from '@/components/tree-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  api,
  type CMSField,
  type CMSRelation,
  type CollectionPresetsData,
  type PipelineInstancesMap
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { findM2ORelation } from '@/lib/relations'
import { useSettings } from '@/lib/useSettings'
import { cn, formatRelative, titleCase } from '@/lib/utils'

interface TreeConfig {
  id: number
  collection: string
  parent_field: string
  label_field: string
  order_field: string | null
}

interface HierarchyLevel {
  collection: string
  label_field: string
  parent_fk: string | null
  junction_table?: string
  junction_child_fk?: string
  junction_parent_fk?: string
}

function isM2M(level: HierarchyLevel) {
  return !!(level.junction_table && level.junction_child_fk && level.junction_parent_fk)
}

interface FlatNode {
  id: string | number
  depth: number
  label: string
  parent_id?: string | number | null
  [key: string]: unknown
}

// ─── At-risk flagging + queue SLA types ───────────────────────────────────────

const AT_RISK_OPS = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'greater or equal' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'less or equal' },
  { value: 'contains', label: 'contains' },
  { value: 'null', label: 'is empty' },
  { value: 'nnull', label: 'is not empty' }
] as const

interface AtRiskCondition {
  field: string
  op: string
  value?: string
}

interface AtRiskRule {
  id: number
  collection: string
  name: string
  conditions: AtRiskCondition[]
  highlight_color: 'red' | 'amber'
  is_active: boolean
}

interface AtRiskHit {
  at_risk: boolean
  rule: string
  color: 'red' | 'amber'
}

interface SlaBatchEntry {
  state_key: string
  elapsed_hours: number
  duration_hours: number
  warning_threshold_pct: number
  status: 'ok' | 'warning' | 'breached'
  remaining_hours: number
}

function formatHrs(h: number): string {
  const abs = Math.abs(h)
  return abs >= 10 ? `${Math.round(abs)}h` : `${Math.round(abs * 10) / 10}h`
}

function TreePickerSheet({
  collection,
  excludeId,
  onSelect,
  onClose
}: {
  collection: string
  excludeId: string | number | null
  onSelect: (id: string | number | null) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState<string | number | null>(null)
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side='right' className='w-[360px]'>
        <SheetHeader>
          <SheetTitle>Move to…</SheetTitle>
        </SheetHeader>
        <div className='mt-4 space-y-4'>
          <TreePicker
            collection={collection}
            value={selected}
            onChange={setSelected}
            excludeId={excludeId}
            placeholder='Select new parent (or none for root)'
          />
          <div className='flex gap-2'>
            <Button onClick={() => onSelect(selected)}>Move here</Button>
            <Button variant='outline' onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function CollectionBrowserPage() {
  const { collection } = useParams<{ collection: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([])
  const [sort, setSort] = useState('')
  const [page, setPage] = useState(1)
  const [isExporting, setIsExporting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [displayColumns, setDisplayColumns] = useState<string[]>([])
  const [viewMode, setViewMode] = useState<'table' | 'tree'>('table')
  const [movingNodeId, setMovingNodeId] = useState<string | number | null>(null)
  const presetsInitialized = useRef(false)
  const [hierarchyScopeParentId, setHierarchyScopeParentId] = useState<string | number | null>(null)
  // At-risk flagging
  const [atRiskOnly, setAtRiskOnly] = useState(false)
  const [manageRulesOpen, setManageRulesOpen] = useState(false)
  const { user } = useAuth()
  const isAdmin = !!user?.is_admin
  // AI query bar — overlay result mode (does not mutate filter state)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiPage, setAiPage] = useState(1)
  const [aiResult, setAiResult] = useState<{
    rows: Record<string, unknown>[]
    interpreted: string
    total: number
    filters: unknown[]
    sort: unknown
    limit: number
  } | null>(null)
  const { data: settings } = useSettings()
  const limit = settings?.collection_page_size ?? 25

  const conditions = activeFilters.map((f) => ({
    path: f.path,
    op: f.op.includes(':') ? f.op.split(':')[0] : f.op,
    value: f.op.includes(':') ? f.op.split(':')[1] : f.value || null
  }))

  const { data: hierarchyConfigs } = useQuery({
    queryKey: ['hierarchy-configs'],
    queryFn: () =>
      api
        .get<{ data: { id: number; levels: HierarchyLevel[] }[] }>('/hierarchy-configs')
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  // derive which hierarchy this collection belongs to (non-root)
  const hierarchyScope = useMemo(() => {
    if (!hierarchyConfigs || !collection) return null
    for (const hc of hierarchyConfigs) {
      const idx = hc.levels.findIndex((l) => l.collection === collection)
      if (idx > 0) {
        return { hierarchyId: hc.id, level: hc.levels[idx], parentLevel: hc.levels[idx - 1] }
      }
    }
    return null
  }, [hierarchyConfigs, collection])

  const { data: parentItems } = useQuery({
    queryKey: ['hierarchy-scope-parents', hierarchyScope?.parentLevel.collection],
    queryFn: () =>
      api
        .get<{ data: Record<string, unknown>[] }>(
          `/items/${hierarchyScope?.parentLevel.collection}`,
          { params: { limit: 200 } }
        )
        .then((r) => r.data.data),
    enabled: !!hierarchyScope,
    staleTime: 30_000
  })

  const { data: scopedChildIds } = useQuery({
    queryKey: [
      'hierarchy-scope-children',
      hierarchyScope?.hierarchyId,
      hierarchyScope?.level.collection,
      hierarchyScopeParentId
    ],
    queryFn: async () => {
      if (!hierarchyScope || !hierarchyScopeParentId) return null
      const res = await api.get<{ data: { id: string | number }[] }>(
        `/hierarchy/${hierarchyScope.hierarchyId}/node/${hierarchyScope.parentLevel.collection}/${hierarchyScopeParentId}/children`
      )
      return res.data.data.map((n) => String(n.id))
    },
    enabled: !!hierarchyScope && !!hierarchyScopeParentId && isM2M(hierarchyScope?.level)
  })

  const scopeConditions: { path: string; op: string; value: string | string[] | null }[] = []
  if (hierarchyScopeParentId && hierarchyScope) {
    if (isM2M(hierarchyScope.level)) {
      if (scopedChildIds) {
        scopeConditions.push({ path: 'id', op: 'in', value: scopedChildIds.join(',') })
      }
    } else if (hierarchyScope.level.parent_fk) {
      scopeConditions.push({
        path: hierarchyScope.level.parent_fk,
        op: 'eq',
        value: String(hierarchyScopeParentId)
      })
    }
  }
  const allConditions = [...conditions, ...scopeConditions]
  const conditionsParam = allConditions.length ? JSON.stringify(allConditions) : undefined

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })

  const { data: presetsData } = useQuery<CollectionPresetsData>({
    queryKey: ['presets', collection],
    queryFn: () =>
      api.get(`/presets?collection=${encodeURIComponent(collection!)}`).then((r) => r.data.data),
    enabled: !!collection
  })

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['items', collection, search, sort, page, conditionsParam],
    queryFn: () =>
      api
        .get(`/items/${collection}`, {
          params: {
            limit,
            page,
            search: search || undefined,
            sort: sort || undefined,
            conditions: conditionsParam
          }
        })
        .then((r) => r.data),
    enabled: !!collection,
    retry: false
  })

  const { data: pipelineData } = useQuery({
    queryKey: ['pipeline-instances', collection],
    queryFn: () =>
      api
        .get<{ data: PipelineInstancesMap | null }>(`/pipelines/instances/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection
  })

  const templateId = pipelineData?.binding?.template
  const { data: pipelineTemplate } = useQuery({
    queryKey: ['pipeline-template', templateId],
    queryFn: () =>
      api
        .get<{ data: { transitions: import('@/lib/api').PipelineTransition[] } }>(
          `/pipelines/${templateId}`
        )
        .then((r) => r.data.data),
    enabled: !!templateId
  })

  const { data: treeConfig } = useQuery({
    queryKey: ['tree-config', collection],
    queryFn: () =>
      api
        .get<{ data: TreeConfig | null }>(`/tree-configs/by-collection/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })

  const { data: treeNodes, isLoading: treeLoading } = useQuery({
    queryKey: ['tree-nodes', collection],
    queryFn: () =>
      api.get<{ data: FlatNode[] }>(`/tree/${collection}/nodes`).then((r) => r.data.data),
    enabled: viewMode === 'tree' && !!treeConfig,
    staleTime: 10_000
  })

  const moveNode = useMutation({
    mutationFn: ({ id, parentId }: { id: string | number; parentId: string | number | null }) =>
      api.patch(`/tree/${collection}/${id}/move`, { parent_id: parentId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tree-nodes', collection] })
      toast.success('Moved')
    },
    onError: () => toast.error('Move failed')
  })

  // Initialize displayColumns once when both colMeta and presetsData are available
  useEffect(() => {
    if (presetsInitialized.current) return
    if (!colMeta || presetsData === undefined) return

    const allKeys = ((colMeta.fields ?? []) as CMSField[])
      .filter((f) => !f.hidden)
      .map((f) => f.field)

    let cols: string[] | null = null

    if (presetsData.activePresetId) {
      const active = presetsData.presets.find((p) => p.id === presetsData.activePresetId)
      if (active) cols = active.columns.filter((k) => allKeys.includes(k))
    }

    if (!cols && presetsData.systemDefault) {
      cols = presetsData.systemDefault.columns.filter((k) => allKeys.includes(k))
    }

    setDisplayColumns(cols ?? allKeys.slice(0, 7))
    presetsInitialized.current = true
  }, [colMeta, presetsData])

  // Reset when collection changes
  useEffect(() => {
    presetsInitialized.current = false
    setDisplayColumns([])
    setSearch('')
    setActiveFilters([])
    setSort('')
    setPage(1)
    setSelectedIds([])
    setHierarchyScopeParentId(null)
    setAtRiskOnly(false)
    setManageRulesOpen(false)
    setAiOpen(false)
    setAiPrompt('')
    setAiResult(null)
    setAiPage(1)
  }, [])

  type AiQueryResponse = {
    data: Record<string, unknown>[]
    total: number
    filters: unknown[]
    sort: unknown
    limit: number
    interpreted: string
  }

  const aiQuery = useMutation({
    mutationFn: (prompt: string) =>
      api.post<AiQueryResponse>('/ai/query', { collection, prompt }).then((r) => r.data),
    onSuccess: (res) => {
      setAiPage(1)
      setAiResult({
        rows: res.data ?? [],
        interpreted: res.interpreted ?? '',
        total: res.total ?? res.data?.length ?? 0,
        filters: res.filters ?? [],
        sort: res.sort ?? null,
        limit: res.limit ?? 50
      })
      setSelectedIds([])
    },
    onError: (err: unknown) => {
      if (axios.isAxiosError(err) && err.response?.status === 503) {
        toast.message('AI is not configured', {
          description: 'Add an Anthropic API key in Settings to enable AI queries.'
        })
        return
      }
      const msg =
        axios.isAxiosError(err) && (err.response?.data as { error?: string })?.error
          ? (err.response?.data as { error: string }).error
          : 'AI query failed'
      toast.error(msg)
    }
  })

  // Re-fetch AI results when page changes (skips AI, reuses stored filters)
  const aiPageQuery = useQuery({
    queryKey: ['ai-page', collection, aiResult?.filters, aiResult?.sort, aiResult?.limit, aiPage],
    queryFn: () =>
      api
        .post<AiQueryResponse>('/ai/query', {
          collection,
          filters: aiResult?.filters,
          sort: aiResult?.sort,
          limit: aiResult?.limit,
          offset: (aiPage - 1) * (aiResult?.limit ?? 50)
        })
        .then((r) => r.data),
    enabled: !!aiResult && aiPage > 1,
    staleTime: 30_000
  })

  const aiRows = aiPage > 1 && aiPageQuery.data ? aiPageQuery.data.data : (aiResult?.rows ?? [])
  const aiTotal = aiResult?.total ?? 0
  const aiLimit = aiResult?.limit ?? 50

  const baseItems: Record<string, unknown>[] = data?.data ?? []
  // AI overlay mode: show the one-off AI result set without touching filter state
  const items: Record<string, unknown>[] = aiResult ? aiRows : baseItems
  const total: number = aiResult ? aiTotal : (data?.total ?? 0)

  // ─── At-risk flagging — active rules + evaluation of visible rows ───────────
  const idsKey = items
    .map((r) => String(r.id ?? ''))
    .filter(Boolean)
    .join(',')
  const visibleIds = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey])

  const { data: activeAtRiskRules } = useQuery({
    queryKey: ['at-risk-rules-active', collection],
    queryFn: () =>
      api
        .get<{ data: AtRiskRule[] }>('/at-risk/rules/active', { params: { collection } })
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 60_000,
    retry: false
  })
  const hasActiveAtRiskRules = (activeAtRiskRules?.length ?? 0) > 0

  const { data: atRiskMap } = useQuery({
    queryKey: ['at-risk-eval', collection, idsKey],
    queryFn: () =>
      api
        .post<{ data: Record<string, AtRiskHit> }>('/at-risk/evaluate', {
          collection,
          ids: visibleIds
        })
        .then((r) => r.data.data),
    enabled: !!collection && visibleIds.length > 0 && hasActiveAtRiskRules,
    staleTime: 30_000,
    retry: false
  })
  const flaggedCount = visibleIds.filter((id) => atRiskMap?.[id]).length
  const hasAtRiskFlags = !!atRiskMap && Object.keys(atRiskMap).length > 0

  // ─── Queue SLA timers — probe batch status for visible rows ─────────────────
  const { data: slaMap } = useQuery({
    queryKey: ['sla-status-batch', collection, idsKey],
    queryFn: () =>
      api
        .post<{ data: Record<string, SlaBatchEntry> }>('/sla/status/batch', {
          collection,
          ids: visibleIds
        })
        .then((r) => r.data.data),
    enabled: !!collection && visibleIds.length > 0,
    refetchInterval: 60_000,
    retry: false
  })
  const hasSlaData = !!slaMap && Object.keys(slaMap).length > 0
  const displayName = colMeta?.display_name ?? titleCase(collection ?? '')
  const allNonHiddenFields: CMSField[] =
    (colMeta?.fields as CMSField[] | undefined)?.filter((f) => !f.hidden) ?? []
  const relations: CMSRelation[] = colMeta?.relations ?? []

  const errorMessage =
    axios.isAxiosError(error) && error.response?.status === 403
      ? 'Access denied — your role does not have read permission for this collection.'
      : axios.isAxiosError(error) && error.response?.status === 404
        ? 'Collection not found in registry.'
        : `Error: ${
            axios.isAxiosError(error)
              ? ((error.response?.data as { error?: string })?.error ?? error.message)
              : String(error)
          }`

  const activeFieldObjs = displayColumns
    .map((key) => allNonHiddenFields.find((f) => f.field === key))
    .filter(Boolean) as CMSField[]

  const tableColumns =
    activeFieldObjs.length > 0
      ? activeFieldObjs.map((f) => ({
          key: f.field,
          header: f.computed_formula ? (
            <span className='inline-flex items-center gap-1'>
              {f.field === 'id' ? 'ID' : titleCase(f.field)}
              <span title={`Computed: ${f.computed_formula}`}>
                <FunctionSquare className='h-3 w-3 text-violet-400 shrink-0' />
              </span>
            </span>
          ) : f.field === 'id' ? (
            'ID'
          ) : (
            titleCase(f.field)
          ),
          sortable: true,
          render: (row: Record<string, unknown>) => (
            <CellValue
              value={row[f.field]}
              type={f.type}
              field={f.field}
              collection={collection}
              relations={relations}
            />
          )
        }))
      : [
          {
            key: 'id',
            header: 'ID',
            sortable: true,
            render: (row: Record<string, unknown>) => (
              <span className='font-mono text-[12px] text-slate-700'>{String(row.id ?? '—')}</span>
            )
          }
        ]

  const pipelineColumn = pipelineData
    ? {
        key: '__pipeline_state',
        header: 'Pipeline State',
        sortable: false,
        render: (row: Record<string, unknown>) => {
          const itemId = String(row.id ?? '')
          const state = pipelineData.instances[itemId]
          if (!state) return <span className='text-[12px] text-slate-300'>—</span>
          return (
            <span
              className='inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium text-white'
              style={{ backgroundColor: state.state_color ?? '#6b7280' }}
            >
              {state.state_label ?? state.state_key ?? '?'}
            </span>
          )
        }
      }
    : null

  // Leading flag column — only when at least one visible row is flagged
  const atRiskColumn = hasAtRiskFlags
    ? {
        key: '__at_risk',
        header: '',
        sortable: false,
        className: 'w-7 !px-1.5',
        headerClassName: 'w-7 !px-1.5',
        render: (row: Record<string, unknown>) => {
          const hit = atRiskMap?.[String(row.id ?? '')]
          if (!hit) return null
          return (
            <span title={`At risk: ${hit.rule}`} className='inline-flex'>
              <Flag
                className={cn(
                  'h-3.5 w-3.5',
                  hit.color === 'amber' ? 'text-amber-500' : 'text-red-500'
                )}
              />
            </span>
          )
        }
      }
    : null

  // Trailing SLA column — only when any visible row has SLA data
  const slaColumn = hasSlaData
    ? {
        key: '__sla',
        header: 'SLA',
        sortable: false,
        render: (row: Record<string, unknown>) => {
          const s = slaMap?.[String(row.id ?? '')]
          if (!s) return <span className='text-[12px] text-slate-300'>—</span>
          const label =
            s.status === 'breached'
              ? `overdue ${formatHrs(s.remaining_hours)}`
              : `${formatHrs(Math.max(0, s.remaining_hours))} left`
          return (
            <span
              title={`State: ${s.state_key} — ${formatHrs(s.elapsed_hours)} elapsed of ${formatHrs(s.duration_hours)} allowed`}
              className={cn(
                'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium',
                s.status === 'breached'
                  ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
                  : s.status === 'warning'
                    ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'
                    : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400'
              )}
            >
              {label}
            </span>
          )
        }
      }
    : null

  const effectiveColumns = [
    ...(atRiskColumn ? [atRiskColumn] : []),
    ...tableColumns,
    ...(pipelineColumn ? [pipelineColumn] : []),
    ...(slaColumn ? [slaColumn] : [])
  ]

  // Client-side "At risk" filter — narrows the loaded page to flagged rows
  const displayedItems =
    atRiskOnly && atRiskMap ? items.filter((r) => atRiskMap[String(r.id ?? '')]) : items

  // Export — POST /content-export/:collection accepts a simple equality filter map,
  // so only single-field "eq" filters can be passed through; others are skipped.
  const exportFilters = useMemo(() => {
    const map: Record<string, string> = {}
    let skipped = 0
    for (const f of activeFilters) {
      const op = f.op.includes(':') ? f.op.split(':')[0] : f.op
      const value = f.op.includes(':') ? f.op.split(':')[1] : f.value
      if (op === 'eq' && f.path.length === 1 && value) {
        map[f.path[0]] = value
      } else {
        skipped++
      }
    }
    return { map, applied: Object.keys(map).length, skipped }
  }, [activeFilters])

  const handleExport = async (format: 'csv' | 'json' | 'xlsx') => {
    if (!collection) return
    setIsExporting(true)
    try {
      const res = await api.post(
        `/content-export/${collection}`,
        {
          format,
          filters: exportFilters.applied > 0 ? exportFilters.map : undefined
        },
        { responseType: 'blob' }
      )
      // The server falls back to JSON for xlsx — match the extension to the payload
      const contentType = String((res.headers as Record<string, unknown>)['content-type'] ?? '')
      const ext = format === 'csv' && contentType.includes('csv') ? 'csv' : 'json'
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${collection}-export.${ext}`
      a.click()
      URL.revokeObjectURL(url)
      setExportOpen(false)
    } catch {
      toast.error('Export failed')
    } finally {
      setIsExporting(false)
    }
  }

  const handleImport = async (file: File) => {
    if (!collection) return
    setIsImporting(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await api.post(`/items/${collection}/import`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      const count =
        (res.data as { imported?: number; count?: number })?.imported ??
        (res.data as { count?: number })?.count ??
        0
      toast.success(`Imported ${count} row${count === 1 ? '' : 's'}`)
      queryClient.invalidateQueries({ queryKey: ['items', collection] })
    } catch {
      toast.error('Import failed')
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <>
      {/* Page header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-6 py-2.5'>
        <div className='flex items-center justify-between gap-3'>
          <div className='flex items-center gap-1.5'>
            <button
              type='button'
              onClick={() => navigate('/collections')}
              className='text-[13px] text-slate-400 transition-colors hover:text-slate-700'
            >
              Collections
            </button>
            <ChevronRight className='h-3 w-3 text-slate-300' />
            <span className='text-[13px] font-medium text-slate-900'>{displayName}</span>
            <code className='ml-0.5 font-mono text-[11px] text-slate-400'>({collection})</code>
          </div>
          <div className='flex items-center gap-2'>
            {treeConfig && (
              <div className='flex rounded-md border border-slate-200 dark:border-border overflow-hidden'>
                <button
                  type='button'
                  className={cn(
                    'px-2.5 py-1 text-[12px] transition-colors',
                    viewMode === 'table'
                      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                      : 'bg-white dark:bg-background text-slate-600 dark:text-slate-400 hover:bg-slate-50'
                  )}
                  onClick={() => setViewMode('table')}
                >
                  Table
                </button>
                <button
                  type='button'
                  className={cn(
                    'px-2.5 py-1 text-[12px] transition-colors border-l border-slate-200 dark:border-border',
                    viewMode === 'tree'
                      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                      : 'bg-white dark:bg-background text-slate-600 dark:text-slate-400 hover:bg-slate-50'
                  )}
                  onClick={() => setViewMode('tree')}
                >
                  Tree
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type='file'
              accept='.csv'
              className='hidden'
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleImport(file)
                e.target.value = ''
              }}
            />
            <Popover open={exportOpen} onOpenChange={setExportOpen}>
              <PopoverTrigger asChild>
                <Button variant='outline' size='sm' disabled={isExporting}>
                  <Download className='mr-1.5 h-3.5 w-3.5' />
                  {isExporting ? 'Exporting…' : 'Export'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className='w-64 p-3' align='end'>
                <p className='mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
                  Export {displayName}
                </p>
                <div className='space-y-1'>
                  {(
                    [
                      { format: 'csv', label: 'CSV', hint: 'Comma-separated values' },
                      { format: 'json', label: 'JSON', hint: 'Raw row objects' },
                      { format: 'xlsx', label: 'Excel', hint: 'Falls back to JSON if unavailable' }
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.format}
                      type='button'
                      disabled={isExporting}
                      onClick={() => handleExport(opt.format)}
                      className='flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12px] text-slate-700 transition-colors hover:bg-nvr-cyan/10 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-nvr-cyan/[0.08]'
                    >
                      <span className='font-medium'>{opt.label}</span>
                      <span className='text-[10px] text-slate-400'>{opt.hint}</span>
                    </button>
                  ))}
                </div>
                <div className='mt-2 border-t border-slate-100 pt-2 text-[10px] leading-relaxed text-slate-400 dark:border-border'>
                  {exportFilters.applied > 0
                    ? `Applies ${exportFilters.applied} equality filter${exportFilters.applied === 1 ? '' : 's'} from the current view.`
                    : 'Exports all rows in this collection.'}
                  {exportFilters.skipped > 0 && (
                    <span className='block text-amber-500'>
                      {exportFilters.skipped} non-equality filter
                      {exportFilters.skipped === 1 ? ' is' : 's are'} not supported by export and
                      will be ignored.
                    </span>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            <Button
              variant='outline'
              size='sm'
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
            >
              <Upload className='mr-1.5 h-3.5 w-3.5' />
              {isImporting ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      </div>

      {/* Content area — tree view or table */}
      {viewMode === 'tree' && treeConfig ? (
        <div className='flex-1 overflow-auto'>
          {movingNodeId && (
            <div className='px-4 py-2 bg-nvr-cyan/10 text-[12px] text-nvr-navy dark:text-nvr-cyan flex items-center gap-2'>
              <span>Select new parent for node</span>
              <button
                type='button'
                className='underline text-[11px]'
                onClick={() => setMovingNodeId(null)}
              >
                Cancel
              </button>
            </div>
          )}
          <TreeView
            nodes={treeNodes ?? []}
            loading={treeLoading}
            emptyText='No items in this collection'
            onSelect={(node) => navigate(`/collections/${collection}/${node.id}`)}
            onEdit={(node) => navigate(`/collections/${collection}/${node.id}`)}
            onAddChild={(node) =>
              navigate(
                `/collections/${collection}/new?parentField=${treeConfig.parent_field}&parentId=${node.id}`
              )
            }
            onMove={(node) => setMovingNodeId(node.id)}
            onDelete={(_node) => {
              /* find and trigger existing delete logic */
            }}
          />
          {movingNodeId && (
            <TreePickerSheet
              collection={collection!}
              excludeId={movingNodeId}
              onSelect={(newParentId) => {
                moveNode.mutate({ id: movingNodeId, parentId: newParentId })
                setMovingNodeId(null)
              }}
              onClose={() => setMovingNodeId(null)}
            />
          )}
        </div>
      ) : (
        <div className='p-4'>
          {hierarchyScope && (
            <div className='mb-3 flex items-center gap-2 text-[13px]'>
              <span className='text-slate-500 shrink-0'>
                Scope by {titleCase(hierarchyScope.parentLevel.collection)}:
              </span>
              <select
                value={hierarchyScopeParentId ?? ''}
                onChange={(e) => {
                  setHierarchyScopeParentId(e.target.value || null)
                  setPage(1)
                }}
                className='h-7 rounded border border-slate-200 bg-white px-2 text-[12px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'
              >
                <option value=''>All {titleCase(hierarchyScope.parentLevel.collection)}s</option>
                {(parentItems ?? []).map((item) => (
                  <option key={String(item.id)} value={String(item.id)}>
                    {String(item[hierarchyScope.parentLevel.label_field] ?? item.id)}
                  </option>
                ))}
              </select>
              {hierarchyScopeParentId && (
                <button
                  type='button'
                  onClick={() => {
                    setHierarchyScopeParentId(null)
                    setPage(1)
                  }}
                  className='text-[11px] text-slate-400 hover:text-slate-600'
                >
                  Clear
                </button>
              )}
            </div>
          )}
          {/* Filter toolbar — single row: saved views + filters + AI */}
          <div className='mb-3'>
            <div className='flex items-center gap-2'>
              <SavedViews
                collection={collection!}
                currentState={{ filters: activeFilters, sort, columns: displayColumns }}
                onApply={(state) => {
                  setActiveFilters(state.filters ?? [])
                  setSort(state.sort ?? '')
                  if (state.columns && state.columns.length > 0) {
                    const allKeys = allNonHiddenFields.map((f) => f.field)
                    const valid = state.columns.filter((k) => allKeys.includes(k))
                    if (valid.length > 0) setDisplayColumns(valid)
                  }
                  setAiResult(null)
                  setAiPage(1)
                  setPage(1)
                }}
              />
              <div className='min-w-0 flex-1'>
                <FilterBar
                  collection={collection!}
                  fields={allNonHiddenFields}
                  relations={relations}
                  value={activeFilters}
                  onChange={(filters) => {
                    setActiveFilters(filters)
                    setPage(1)
                  }}
                  searchValue={search}
                  onSearchChange={(v) => {
                    setSearch(v)
                    setPage(1)
                  }}
                />
              </div>
              {hasActiveAtRiskRules && (
                <button
                  type='button'
                  onClick={() => setAtRiskOnly((v) => !v)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                    atRiskOnly
                      ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-background dark:text-slate-300 dark:hover:bg-slate-900'
                  )}
                >
                  <Flag className='h-3 w-3' />
                  At risk ({flaggedCount}){atRiskOnly && <X className='h-3 w-3' />}
                </button>
              )}
              {isAdmin && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-7 shrink-0 px-2 text-[11px] text-slate-500 hover:text-nvr-navy dark:hover:text-nvr-cyan'
                  onClick={() => setManageRulesOpen((v) => !v)}
                >
                  <ShieldAlert className='mr-1 h-3 w-3' />
                  {manageRulesOpen ? 'Close rules' : 'Rules'}
                </Button>
              )}
              {aiOpen ? (
                <form
                  className='flex shrink-0 items-center gap-1.5'
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (!aiPrompt.trim() || aiQuery.isPending) return
                    aiQuery.mutate(aiPrompt.trim())
                  }}
                >
                  <Sparkles className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
                  <Input
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder='show overdue items…'
                    className='h-7 w-[220px] text-[12px] focus-visible:ring-nvr-cyan'
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setAiOpen(false)
                        setAiPrompt('')
                      }
                    }}
                  />
                  <Button
                    type='submit'
                    size='sm'
                    className='h-7 px-2.5 text-[12px]'
                    disabled={!aiPrompt.trim() || aiQuery.isPending}
                  >
                    {aiQuery.isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Ask'}
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    className='h-7 w-7 text-slate-400'
                    onClick={() => {
                      setAiOpen(false)
                      setAiPrompt('')
                    }}
                  >
                    <X className='h-3.5 w-3.5' />
                  </Button>
                </form>
              ) : (
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-7 shrink-0 px-2 text-[11px] text-slate-500 hover:text-nvr-navy dark:hover:text-nvr-cyan'
                  onClick={() => setAiOpen(true)}
                >
                  <Sparkles className='mr-1 h-3.5 w-3.5 text-nvr-cyan' />
                  Ask AI
                </Button>
              )}
            </div>
            {aiResult && (
              <div className='mt-1.5 flex items-center gap-2 rounded-md border border-nvr-cyan/30 bg-nvr-cyan/5 px-3 py-1.5'>
                <Sparkles className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
                <span className='flex-1 truncate text-[12px] text-slate-600 dark:text-slate-300'>
                  {aiResult.interpreted || 'AI results'}{' '}
                  <span className='text-slate-400'>
                    — {aiTotal} result{aiTotal === 1 ? '' : 's'}
                  </span>
                </span>
                <button
                  type='button'
                  onClick={() => {
                    setAiResult(null)
                    setAiPage(1)
                  }}
                  className='inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-nvr-cyan/10 px-2 text-[11px] font-medium text-nvr-navy transition-colors hover:bg-nvr-cyan/20 dark:text-nvr-cyan'
                >
                  <X className='h-3 w-3' />
                  Clear
                </button>
              </div>
            )}
            {isAdmin && manageRulesOpen && collection && (
              <div className='mt-2'>
                <AtRiskRulesPanel
                  collection={collection}
                  fields={allNonHiddenFields}
                  relations={relations}
                />
              </div>
            )}
          </div>
          <DataTable
            columns={effectiveColumns}
            rows={displayedItems}
            rowKey={(row, i) => String(row.id ?? i)}
            total={total}
            page={aiResult ? aiPage : page}
            limit={aiResult ? aiLimit : limit}
            isLoading={aiResult ? aiPageQuery.isFetching : isLoading}
            isError={isError}
            errorMessage={errorMessage}
            sort={sort}
            onSortChange={(s) => {
              setSort(s)
              setPage(1)
            }}
            onPageChange={aiResult ? setAiPage : setPage}
            onRowClick={(row) => navigate(`/collections/${collection}/${String(row.id)}`)}
            rowClassName={(row) => {
              const hit = atRiskMap?.[String(row.id ?? '')]
              if (!hit) return undefined
              return hit.color === 'amber'
                ? 'bg-amber-50 dark:bg-amber-950/20'
                : 'bg-red-50 dark:bg-red-950/20'
            }}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            toolbarRight={
              <div className='flex items-center gap-1'>
                {collection && allNonHiddenFields.length > 0 && (
                  <ColumnPicker
                    collection={collection}
                    allFields={allNonHiddenFields}
                    columns={displayColumns}
                    presetsData={presetsData}
                    onChange={setDisplayColumns}
                    onPresetActivated={setDisplayColumns}
                  />
                )}
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-slate-500'
                  onClick={() => refetch()}
                  disabled={isFetching}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            }
          />
        </div>
      )}

      {selectedIds.length > 0 && (
        <BulkActionBar
          collection={collection!}
          selectedIds={selectedIds}
          onClear={() => setSelectedIds([])}
          onSuccess={() => queryClient.invalidateQueries({ queryKey: ['items', collection] })}
          hasPipeline={!!pipelineData}
          availableTransitions={
            pipelineTemplate?.transitions?.map((t) => ({
              id: t.id,
              label: t.label,
              color: t.color
            })) ?? []
          }
        />
      )}
    </>
  )
}

function CellValue({
  value,
  type,
  field,
  collection,
  relations
}: {
  value: unknown
  type?: string
  field?: string
  collection?: string
  relations?: CMSRelation[]
}) {
  if (field && collection && relations) {
    const m2oRelation = findM2ORelation(relations, collection, field)
    if (m2oRelation) {
      return <RelationLabel relatedCollection={m2oRelation.one_collection!} id={value} />
    }
  }

  if (value === null || value === undefined) {
    return <span className='text-[12px] text-slate-300'>—</span>
  }
  if (type === 'boolean') {
    return (
      <Badge variant={value ? 'success' : 'secondary'} className='h-4 px-1.5 text-[10px]'>
        {value ? 'Yes' : 'No'}
      </Badge>
    )
  }
  if (type === 'timestamp' || type === 'datetime' || type === 'date') {
    return (
      <span className='font-mono text-[12px] text-slate-400'>{formatRelative(String(value))}</span>
    )
  }
  if (typeof value === 'string' && value.length > 60) {
    return (
      <span className='block max-w-[180px] truncate text-[12px] text-slate-700' title={value}>
        {value.slice(0, 60)}…
      </span>
    )
  }
  return <span className='font-mono text-[12px] text-slate-700'>{String(value)}</span>
}

// ─── At-risk rule management (admin, inline panel) ────────────────────────────

function RuleCombobox({
  value,
  onChange,
  options,
  placeholder,
  widthClass = 'w-[180px]'
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  widthClass?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className={cn('h-7 justify-between px-2 text-[12px] font-normal', widthClass)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[220px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={() => {
                    onChange(opt.value === value ? '' : opt.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

interface RuleDraft {
  id: number | null
  name: string
  conditions: AtRiskCondition[]
  color: 'red' | 'amber'
  active: boolean
}

const EMPTY_CONDITION: AtRiskCondition = { field: '', op: 'eq', value: '' }

function conditionSummary(c: AtRiskCondition): string {
  const op = AT_RISK_OPS.find((o) => o.value === c.op)?.label ?? c.op
  if (c.op === 'null' || c.op === 'nnull') return `${c.field} ${op}`
  return `${c.field} ${op} ${c.value ?? ''}`
}

function AtRiskRulesPanel({
  collection,
  fields,
  relations
}: {
  collection: string
  fields: CMSField[]
  relations: CMSRelation[]
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  const { data: rules, isLoading } = useQuery({
    queryKey: ['at-risk-rules-admin', collection],
    queryFn: () =>
      api
        .get<{ data: AtRiskRule[] }>('/at-risk/rules', { params: { collection } })
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['at-risk-rules-admin', collection] })
    queryClient.invalidateQueries({ queryKey: ['at-risk-rules-active', collection] })
    queryClient.invalidateQueries({ queryKey: ['at-risk-eval', collection] })
  }

  const save = useMutation({
    mutationFn: (d: RuleDraft) => {
      const payload = {
        collection,
        name: d.name.trim(),
        conditions: d.conditions.map((c) =>
          c.op === 'null' || c.op === 'nnull'
            ? { field: c.field, op: c.op }
            : { field: c.field, op: c.op, value: c.value }
        ),
        highlight_color: d.color,
        is_active: d.active
      }
      return d.id === null
        ? api.post('/at-risk/rules', payload)
        : api.patch(`/at-risk/rules/${d.id}`, payload)
    },
    onSuccess: () => {
      invalidateAll()
      setDraft(null)
      toast.success('Rule saved')
    },
    onError: (err: unknown) => {
      const msg =
        axios.isAxiosError(err) && (err.response?.data as { error?: string })?.error
          ? (err.response?.data as { error: string }).error
          : 'Failed to save rule'
      toast.error(msg)
    }
  })

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      api.patch(`/at-risk/rules/${id}`, { is_active: active }),
    onSuccess: invalidateAll,
    onError: () => toast.error('Failed to update rule')
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/at-risk/rules/${id}`),
    onSuccess: () => {
      invalidateAll()
      setConfirmDeleteId(null)
      toast.success('Rule deleted')
    },
    onError: () => toast.error('Failed to delete rule')
  })

  const opOptions = AT_RISK_OPS.map((o) => ({ value: o.value, label: o.label }))

  const draftValid =
    !!draft &&
    draft.name.trim() !== '' &&
    draft.conditions.length > 0 &&
    draft.conditions.every(
      (c) =>
        c.field !== '' &&
        c.op !== '' &&
        (c.op === 'null' || c.op === 'nnull' || (c.value ?? '').trim() !== '')
    )

  const updateCondition = (i: number, patch: Partial<AtRiskCondition>) => {
    setDraft((d) =>
      d ? { ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) } : d
    )
  }

  return (
    <div className='mt-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <div className='mb-2 flex items-center justify-between'>
        <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
          At-risk rules — {collection}
        </p>
        {!draft && (
          <Button
            variant='outline'
            size='sm'
            className='h-6 px-2 text-[11px]'
            onClick={() =>
              setDraft({
                id: null,
                name: '',
                conditions: [{ ...EMPTY_CONDITION }],
                color: 'red',
                active: true
              })
            }
          >
            <Plus className='mr-1 h-3 w-3' />
            Add rule
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className='py-2 text-[12px] text-slate-400'>Loading…</p>
      ) : (rules ?? []).length === 0 && !draft ? (
        <p className='py-2 text-[12px] text-slate-400'>No at-risk rules for this collection yet.</p>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border'>
          {(rules ?? []).map((rule) => (
            <li key={rule.id} className='flex items-center gap-2 py-1.5'>
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  rule.highlight_color === 'amber' ? 'bg-amber-500' : 'bg-red-500'
                )}
              />
              <span className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                {rule.name}
              </span>
              <span className='flex-1 truncate font-mono text-[11px] text-slate-400'>
                {rule.conditions.map(conditionSummary).join(' AND ')}
              </span>
              <Switch
                checked={rule.is_active}
                onCheckedChange={(checked) => toggle.mutate({ id: rule.id, active: checked })}
                className='scale-75'
                aria-label={`Toggle ${rule.name}`}
              />
              <Button
                variant='ghost'
                size='icon'
                className='h-6 w-6 text-slate-400 hover:text-slate-700'
                onClick={() =>
                  setDraft({
                    id: rule.id,
                    name: rule.name,
                    conditions:
                      rule.conditions.length > 0
                        ? rule.conditions.map((c) => ({
                            field: c.field,
                            op: c.op,
                            value: c.value === undefined ? '' : String(c.value)
                          }))
                        : [{ ...EMPTY_CONDITION }],
                    color: rule.highlight_color === 'amber' ? 'amber' : 'red',
                    active: rule.is_active
                  })
                }
              >
                <Pencil className='h-3 w-3' />
              </Button>
              {confirmDeleteId === rule.id ? (
                <span className='flex items-center gap-1'>
                  <Button
                    variant='destructive'
                    size='sm'
                    className='h-6 px-2 text-[11px]'
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(rule.id)}
                  >
                    Delete
                  </Button>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-6 px-2 text-[11px]'
                    onClick={() => setConfirmDeleteId(null)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-6 w-6 text-slate-400 hover:text-red-600'
                  onClick={() => setConfirmDeleteId(rule.id)}
                >
                  <Trash2 className='h-3 w-3' />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {draft && (
        <div className='mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-background'>
          <div className='flex items-center gap-2'>
            <Label className='w-12 shrink-0 text-[11px] text-slate-500'>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
              placeholder='e.g. Over budget'
              className='h-7 max-w-[280px] text-[12px]'
            />
          </div>

          <div className='space-y-1.5'>
            {draft.conditions.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: condition rows are positional
              <div key={i} className='flex flex-wrap items-center gap-1.5'>
                <FieldPicker
                  collection={collection}
                  fields={fields}
                  relations={relations}
                  value={c.field}
                  onChange={(picked) => updateCondition(i, { field: picked.path.join('.') })}
                  onClear={() => updateCondition(i, { field: '' })}
                  placeholder='Field…'
                />
                <RuleCombobox
                  value={c.op}
                  onChange={(v) => updateCondition(i, { op: v })}
                  options={opOptions}
                  placeholder='Operator…'
                  widthClass='w-[150px]'
                />
                {c.op !== 'null' && c.op !== 'nnull' && (
                  <Input
                    value={c.value ?? ''}
                    onChange={(e) => updateCondition(i, { value: e.target.value })}
                    placeholder='Value or {{field}} * 0.9'
                    className='h-7 w-[200px] font-mono text-[12px]'
                  />
                )}
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-6 w-6 text-slate-400 hover:text-red-600'
                  disabled={draft.conditions.length === 1}
                  onClick={() =>
                    setDraft((d) =>
                      d ? { ...d, conditions: d.conditions.filter((_, j) => j !== i) } : d
                    )
                  }
                >
                  <X className='h-3 w-3' />
                </Button>
              </div>
            ))}
            <Button
              variant='ghost'
              size='sm'
              className='h-6 px-2 text-[11px] text-slate-500'
              onClick={() =>
                setDraft((d) =>
                  d ? { ...d, conditions: [...d.conditions, { ...EMPTY_CONDITION }] } : d
                )
              }
            >
              <Plus className='mr-1 h-3 w-3' />
              Add condition
            </Button>
            <p className='text-[10px] leading-relaxed text-slate-400'>
              All conditions must match (AND). Values can reference other fields with{' '}
              <code className='font-mono'>{'{{field}}'}</code>, optionally scaled — e.g.{' '}
              <code className='font-mono'>{'{{budget}} * 0.9'}</code> or{' '}
              <code className='font-mono'>{'{{baseline}} + 10'}</code>.
            </p>
          </div>

          <div className='flex flex-wrap items-center gap-3'>
            <div className='flex items-center gap-1'>
              <Label className='text-[11px] text-slate-500'>Highlight</Label>
              {(['red', 'amber'] as const).map((color) => (
                <button
                  key={color}
                  type='button'
                  onClick={() => setDraft((d) => (d ? { ...d, color } : d))}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] capitalize transition-colors',
                    draft.color === color
                      ? color === 'amber'
                        ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400'
                        : 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400'
                      : 'border-slate-200 bg-white text-slate-500 dark:border-border dark:bg-background'
                  )}
                >
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      color === 'amber' ? 'bg-amber-500' : 'bg-red-500'
                    )}
                  />
                  {color}
                </button>
              ))}
            </div>
            <div className='flex items-center gap-1.5'>
              <Switch
                checked={draft.active}
                onCheckedChange={(checked) => setDraft((d) => (d ? { ...d, active: checked } : d))}
                className='scale-75'
                id='at-risk-rule-active'
              />
              <Label htmlFor='at-risk-rule-active' className='text-[11px] text-slate-500'>
                Active
              </Label>
            </div>
            <div className='flex-1' />
            <Button
              size='sm'
              className='h-7 px-3 text-[12px]'
              disabled={!draftValid || save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              {save.isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Save rule'}
            </Button>
            <Button
              variant='outline'
              size='sm'
              className='h-7 px-3 text-[12px]'
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
