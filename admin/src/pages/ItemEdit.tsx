import type { ImportParseResponse } from '@nivaro/sdk'
import { createNivaro } from '@nivaro/sdk'
import {
  DrilldownContext,
  type DrilldownTarget,
  ItemEditAuthContext,
  ItemEditForm,
  NavigationContext,
  NivaroProvider
} from '@nivaro/shared'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronsUpDown,
  EyeOff,
  History,
  Loader2,
  Network,
  Play,
  Sparkles,
  Waypoints
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ApprovalPanel } from '@/components/approval-panel'
import { RecordDrilldownSheet } from '@/components/record-drilldown-sheet'
import { RecordGraphSheet } from '@/components/record-graph-sheet'
import { ShareLinkPopover } from '@/components/share-link-popover'
import { TimelineSheet } from '@/components/timeline-sheet'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { api, type CMSField } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useRecordPresence } from '@/lib/use-record-presence'
import { cn, titleCase } from '@/lib/utils'

// ─── Local types ──────────────────────────────────────────────────────────────

interface TreeConfig {
  id: number
  collection: string
  parent_field: string
  label_field: string
  order_field: string | null
}

interface HierarchyConfig {
  id: number
  name: string
  levels: {
    collection: string
    label_field: string
    parent_fk: string | null
    junction_table?: string | null
    junction_child_fk?: string | null
    junction_parent_fk?: string | null
  }[]
}

interface HierarchyAncestor {
  id: number | string
  collection: string
  label: string
  level_index: number
}

interface AttributeDef {
  id: number
  collection: string
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'date' | 'select'
  options: string[] | null
  required: boolean
  value: string | null
}

// ─── AttributeSelect ──────────────────────────────────────────────────────────

function AttributeSelect({
  value,
  options,
  onChange
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='w-full justify-between font-normal'
        >
          <span className={value ? '' : 'text-muted-foreground'}>{value || 'Select…'}</span>
          <ChevronsUpDown className='ml-1 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
        <Command>
          <CommandList>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={() => {
                    onChange(opt === value ? '' : opt)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn('mr-2 h-4 w-4', value === opt ? 'opacity-100' : 'opacity-0')}
                  />
                  {opt}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── AttributeField ───────────────────────────────────────────────────────────

function AttributeField({
  def,
  onSave,
  saving
}: {
  def: AttributeDef
  onSave: (value: unknown) => void
  saving: boolean
}) {
  const [draft, setDraft] = useState<string>(def.value ?? '')
  useEffect(() => {
    setDraft(def.value ?? '')
  }, [def.value])
  const dirty = (draft || '') !== (def.value || '')

  if (def.type === 'boolean') {
    const checked = draft === 'true'
    return (
      <div className='space-y-1.5'>
        <Label>
          {def.label}
          {def.required && <span className='text-red-500 ml-0.5'>*</span>}
        </Label>
        <div className='flex items-center gap-2'>
          <Switch
            checked={checked}
            onCheckedChange={(c) => {
              const next = c ? 'true' : 'false'
              setDraft(next)
              onSave(c)
            }}
          />
          <span className='text-sm text-muted-foreground'>{checked ? 'Yes' : 'No'}</span>
        </div>
      </div>
    )
  }

  return (
    <div className='space-y-1.5'>
      <Label>
        {def.label}
        {def.required && <span className='text-red-500 ml-0.5'>*</span>}
      </Label>
      {def.type === 'select' && def.options ? (
        <AttributeSelect value={draft} options={def.options} onChange={setDraft} />
      ) : (
        <Input
          type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      {dirty && (
        <Button
          size='sm'
          className='h-7 text-[12px]'
          disabled={saving}
          onClick={() => onSave(draft)}
        >
          {saving ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Save'}
        </Button>
      )}
    </div>
  )
}

// ─── ScheduleChangeDialog ─────────────────────────────────────────────────────

function ScheduleChangeDialog({
  collection,
  itemId,
  fields,
  triggerClassName
}: {
  collection: string
  itemId: string
  fields: CMSField[]
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false)
  const [selectedField, setSelectedField] = useState('')
  const [newValue, setNewValue] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')

  const createMut = useMutation({
    mutationFn: () =>
      api.post('/scheduled-changes', {
        collection,
        item_id: itemId,
        change_type: 'field_update',
        changes: { [selectedField]: newValue },
        scheduled_at: scheduledAt
      }),
    onSuccess: () => {
      setOpen(false)
      setSelectedField('')
      setNewValue('')
      setScheduledAt('')
      toast.success('Change scheduled')
    },
    onError: () => toast.error('Failed to schedule change')
  })

  const visibleFields = fields.filter((f) => !f.hidden)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size='sm' variant='outline' className={triggerClassName}>
          <CalendarClock className='mr-1.5 h-3.5 w-3.5' />
          Schedule
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-80 p-4' align='end'>
        <p className='mb-3 text-[13px] font-medium'>Schedule a field change</p>
        <div className='space-y-3'>
          <div>
            <Label className='mb-1 block text-[11px]'>Field</Label>
            <Popover open={fieldPickerOpen} onOpenChange={setFieldPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant='outline'
                  role='combobox'
                  aria-expanded={fieldPickerOpen}
                  className='w-full justify-between text-[12px] font-normal h-8'
                >
                  <span>{selectedField || 'Select a field…'}</span>
                  <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
                </Button>
              </PopoverTrigger>
              <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
                  <CommandList>
                    <CommandGroup>
                      {visibleFields.map((f) => (
                        <CommandItem
                          key={f.field}
                          value={f.field}
                          onSelect={() => {
                            setSelectedField(f.field === selectedField ? '' : f.field)
                            setFieldPickerOpen(false)
                          }}
                          className='text-[12px]'
                        >
                          <Check
                            className={cn(
                              'mr-2 h-3.5 w-3.5',
                              selectedField === f.field ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          {f.field}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>New value</Label>
            <Input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              className='h-7 text-[12px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>Scheduled at</Label>
            <Input
              type='datetime-local'
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className='h-7 text-[12px]'
            />
          </div>
          <Button
            size='sm'
            className='w-full h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
            disabled={!selectedField || !newValue || !scheduledAt || createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            {createMut.isPending ? 'Scheduling…' : 'Schedule Change'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── ItemEditPage ─────────────────────────────────────────────────────────────

export function ItemEditPage() {
  const { collection, id } = useParams<{ collection: string; id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  // Optional ?layout=<slug> pins a specific grouped layout (e.g. a queue
  // configured to open items with a chosen layout). Absent → default active
  // layout resolution, exactly as before.
  const layoutSlug = searchParams.get('layout') || undefined
  const focusField = searchParams.get('focus') || undefined
  const location = useLocation()

  // Back returns to wherever the user came from (queue worklist, browser, etc).
  // location.key === 'default' means this was a fresh load / direct URL with no
  // in-app history to pop — then fall back to the collection listing.
  const goBack = () => {
    // idx > 0 = a real previous entry exists, even after a full reload
    // (location.key resets to 'default' on reload and misfires there).
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(`/collections/${collection}`)
  }
  const client = useMemo(() => createNivaro(window.location.origin), [])
  const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null)
  const drillCtx = useMemo(() => ({ open: (t: DrilldownTarget) => setDrilldown(t) }), [])
  const isNew = id === 'new'

  // Router-state handoff from CollectionBrowser/QueueWorklist "New from file" —
  // consumed once, then the state is cleared so back/refresh doesn't re-apply it.
  const importResultConsumedRef = useRef(false)
  const [importResult, setImportResult] = useState<ImportParseResponse | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: run-once handoff
  useEffect(() => {
    if (importResultConsumedRef.current) return
    const state = location.state as { importResult?: ImportParseResponse } | null
    if (!isNew || !state?.importResult) return
    importResultConsumedRef.current = true
    setImportResult(state.importResult)
    navigate(location.pathname + location.search, { replace: true, state: null })
  }, [location, isNew])

  const [summarizing, setSummarizing] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const presence = useRecordPresence(collection, !isNew && id ? id : undefined)
  const [summary, setSummary] = useState<string | null>(null)
  const [runningItemAction, setRunningItemAction] = useState<string | null>(null)

  // ── Admin-specific queries ────────────────────────────────────────────────
  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 10 * 60 * 1000
  })

  const { data: itemData } = useQuery({
    queryKey: ['item', collection, id],
    queryFn: () => api.get(`/items/${collection}/${id}`).then((r) => r.data.data),
    enabled: !!collection && !!id && !isNew
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

  const { data: ancestors } = useQuery({
    queryKey: ['tree-ancestors', collection, id],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string | number; label: string }> }>(
          `/tree/${collection}/${id}/ancestors`
        )
        .then((r) => r.data.data),
    enabled: !!id && !!treeConfig && !isNew,
    staleTime: 30_000
  })

  const { data: hierarchyConfigs } = useQuery({
    queryKey: ['hierarchy-configs'],
    queryFn: () =>
      api.get<{ data: HierarchyConfig[] }>('/hierarchy-configs').then((r) => r.data.data),
    staleTime: 60_000,
    enabled: !!id && !isNew
  })

  const relevantHierarchies = useMemo(
    () =>
      (hierarchyConfigs ?? []).filter(
        (hc) => hc.levels.findIndex((l) => l.collection === collection) > 0
      ),
    [hierarchyConfigs, collection]
  )

  const hierarchyAncestorResults = useQueries({
    queries: relevantHierarchies.map((hc) => ({
      queryKey: ['hierarchy-ancestors', hc.id, collection, id],
      queryFn: () =>
        api
          .get<{ data: HierarchyAncestor[] }>(
            `/hierarchy/${hc.id}/node/${collection}/${id}/ancestors`
          )
          .then((r) => r.data.data),
      enabled: !!id && !isNew && relevantHierarchies.length > 0,
      staleTime: 30_000
    }))
  })

  const { data: dpConfig } = useQuery({
    queryKey: ['draft-publish-config', collection],
    queryFn: () =>
      api
        .get<{ data: { draft_publish_enabled: boolean } }>(`/draft-publish/${collection}/config`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 60_000
  })

  const { data: exclusionData, refetch: refetchExclusion } = useQuery({
    queryKey: ['picker-exclusion', collection, id],
    queryFn: () =>
      api
        .get(`/picker-exclusions/status/${collection}/${id}`)
        .then((r) => r.data.data as { excluded: boolean }),
    enabled: !!collection && !!id && !isNew,
    staleTime: 60_000
  })
  const isExcluded = exclusionData?.excluded ?? false

  const toggleExclusion = useMutation({
    mutationFn: () =>
      isExcluded
        ? api.delete('/picker-exclusions', { data: { collection, item_id: id } })
        : api.post('/picker-exclusions', { collection, item_id: id }),
    onSuccess: () => {
      refetchExclusion()
      toast.success(isExcluded ? 'Record re-enabled in pickers' : 'Record excluded from pickers')
    },
    onError: () => toast.error('Failed to update picker status')
  })

  const { data: extItemActions = [] } = useQuery({
    queryKey: ['ext-item-actions', collection, id],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string; label: string; variant?: string }> }>(
          '/item-actions/registered',
          { params: { collection, item: id } }
        )
        .then((r) => r.data.data),
    enabled: !!collection && !!id && !isNew,
    staleTime: 60_000
  })

  const { data: activeLayoutData } = useQuery({
    queryKey: ['active-layout', collection, layoutSlug ?? null, id],
    queryFn: () =>
      api
        .get<{
          data: {
            layout: {
              ai_enabled?: boolean | number
              allow_schedule?: boolean | number
              allow_disable_pickers?: boolean | number
            }
          }
        }>('/collection-layouts/active', {
          params: {
            collection,
            ...(layoutSlug ? { slug: layoutSlug } : !isNew ? { item: id } : {})
          }
        })
        .then((r) => r.data.data)
        .catch(() => null),
    enabled: !!collection,
    staleTime: 0
  })

  const { data: attributeDefs } = useQuery({
    queryKey: ['attribute-values', collection, id],
    queryFn: () =>
      api.get<{ data: AttributeDef[] }>(`/attributes/${collection}/${id}`).then((r) => r.data.data),
    enabled: !!collection && !!id && !isNew
  })

  const saveAttributes = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.patch(`/attributes/${collection}/${id}`, values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attribute-values', collection, id] })
      toast.success('Attribute saved')
    },
    onError: () => toast.error('Failed to save attribute')
  })

  // ── Derived values ────────────────────────────────────────────────────────
  const layoutMeta = activeLayoutData?.layout
  const layoutAiEnabled = layoutMeta ? !!layoutMeta.ai_enabled : true
  const canSchedule = !!user?.is_admin || !!layoutMeta?.allow_schedule
  const canDisablePickers = !!user?.is_admin || !!layoutMeta?.allow_disable_pickers
  const displayName = colMeta?.display_name ?? titleCase(collection ?? '')
  const allFields: CMSField[] = colMeta?.fields ?? []
  const itemStatus = (itemData as Record<string, unknown> | undefined)?._status as
    | string
    | undefined

  // ── Pre-fill parent from URL params (new items via tree "Add child") ──────
  const parentFieldParam = searchParams.get('parentField')
  const parentIdParam = searchParams.get('parentId')
  // ?prefill=<base64 JSON> — deep links (efp-new precedent)
  const prefillValues = useMemo<Record<string, unknown> | null>(() => {
    const raw = searchParams.get('prefill')
    if (!raw) return null
    try {
      const parsed = JSON.parse(atob(raw)) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }, [searchParams])
  // ?dupe=<key> — Duplicate handoff via sessionStorage (the payload carries
  // M2M links + O2M child rows, far too big for a URL).
  const dupePayload = useMemo<{
    values: Record<string, unknown>
    links: Record<string, unknown[]>
    rows: Record<string, Array<Record<string, unknown>>>
  } | null>(() => {
    const key = searchParams.get('dupe')
    if (!key) return null
    try {
      const raw = sessionStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }, [searchParams])

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleSummarize = async () => {
    if (!collection || !id) return
    setSummarizing(true)
    try {
      const res = await api.post('/ai/summarize', { collection, item_id: id })
      setSummary(res.data.data.summary)
    } catch {
      toast.error('Failed to summarize — is ANTHROPIC_API_KEY configured?')
    } finally {
      setSummarizing(false)
    }
  }

  // ── Extra panels injected into ItemEditForm's scroll area ─────────────────
  const extraTopContent = (
    <>
      {/* ErpStatusBadge removed — ItemEditForm's ErpFailureBanner is the
          persistent submission-status surface now; the pill was redundant. */}
      {id && !isNew && <ApprovalPanel collection={collection!} item={id} />}
      {id && !isNew && relevantHierarchies.length > 0 && (
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm font-medium text-slate-500 flex items-center gap-1.5'>
              <Network className='h-3.5 w-3.5' />
              Hierarchy Membership
            </CardTitle>
          </CardHeader>
          <CardContent className='space-y-3'>
            {relevantHierarchies.map((hc, i) => {
              const hierarchyAncestors = hierarchyAncestorResults[i]?.data ?? []
              const levelIdx = hc.levels.findIndex((l) => l.collection === collection)
              const level = hc.levels[levelIdx]
              const isM2M = !!(
                level?.junction_table &&
                level?.junction_child_fk &&
                level?.junction_parent_fk
              )
              return (
                <div key={hc.id}>
                  <p className='text-[11px] font-medium text-slate-400 uppercase tracking-wide mb-1'>
                    {hc.name}
                  </p>
                  {hierarchyAncestors.length === 0 ? (
                    <p className='text-[12px] text-slate-400 italic'>No parent assigned</p>
                  ) : (
                    <nav className='flex items-center gap-1 flex-wrap text-[12px]'>
                      {hierarchyAncestors.map((anc, ai) => (
                        <span
                          key={`${anc.collection}-${anc.id}`}
                          className='flex items-center gap-1'
                        >
                          {ai > 0 && <span className='text-slate-300'>›</span>}
                          <Link
                            to={`/collections/${anc.collection}/${anc.id}`}
                            className='text-nvr-cyan hover:underline'
                          >
                            {anc.label}
                          </Link>
                        </span>
                      ))}
                      {isM2M && <span className='text-[10px] text-slate-400 ml-1'>(one path)</span>}
                    </nav>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
    </>
  )

  const extraBottomContent = (
    <>
      {id && !isNew && attributeDefs && attributeDefs.length > 0 && (
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm font-medium text-slate-500'>Custom Attributes</CardTitle>
          </CardHeader>
          <CardContent className='space-y-4'>
            {attributeDefs.map((def) => (
              <AttributeField
                key={def.key}
                def={def}
                saving={saveAttributes.isPending}
                onSave={(value) => saveAttributes.mutate({ [def.key]: value })}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </>
  )

  return (
    <NivaroProvider client={client}>
      <NavigationContext.Provider value={{ navigate }}>
        <ItemEditAuthContext.Provider
          value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
        >
          <DrilldownContext.Provider value={drillCtx}>
            {drilldown && (
              <RecordDrilldownSheet
                collection={drilldown.collection}
                itemId={drilldown.itemId}
                layoutId={drilldown.layoutId}
                width={drilldown.width}
                title={drilldown.title}
                onClose={() => setDrilldown(null)}
              />
            )}
            <div className='flex flex-1 min-h-0 flex-col'>
              {/* Admin sticky header */}
              <div className='sticky top-0 z-20 shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-background'>
                <div className='flex items-center gap-4'>
                  <Button variant='ghost' size='icon' onClick={goBack}>
                    <ArrowLeft className='h-4 w-4' />
                  </Button>
                  <div className='flex-1'>
                    <div className='flex items-center gap-2'>
                      <h1 className='text-[18px] font-semibold text-slate-900 dark:text-slate-100'>
                        {displayName}
                      </h1>
                      {id && (
                        <span className='font-mono text-[12px] bg-slate-100 text-slate-500 rounded px-2 py-0.5 dark:bg-muted dark:text-slate-400'>
                          #{id}
                        </span>
                      )}
                      <span className='text-[12px] text-slate-400 font-mono'>{collection}</span>
                    </div>
                    {ancestors && ancestors.length > 1 && (
                      <nav className='flex items-center gap-1 text-[12px] text-slate-400 mt-1 flex-wrap'>
                        {ancestors.slice(0, -1).map((ancestor, i) => (
                          <span key={ancestor.id} className='flex items-center gap-1'>
                            {i > 0 && <span className='text-slate-300'>›</span>}
                            <Link
                              to={`/collections/${collection}/${ancestor.id}`}
                              className='hover:text-slate-600 dark:hover:text-slate-300 transition-colors'
                            >
                              {ancestor.label}
                            </Link>
                          </span>
                        ))}
                        <span className='text-slate-300'>›</span>
                        <span className='text-slate-600 dark:text-slate-300'>
                          {ancestors[ancestors.length - 1]?.label}
                        </span>
                      </nav>
                    )}
                  </div>

                  {/* Draft/publish controls */}
                  {dpConfig?.draft_publish_enabled && id && !isNew && (
                    <div className='flex items-center gap-2'>
                      {itemStatus && (
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                            itemStatus === 'published'
                              ? 'bg-emerald-100 text-emerald-700'
                              : itemStatus === 'review'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-slate-100 text-slate-600'
                          )}
                        >
                          {itemStatus}
                        </span>
                      )}
                      {itemStatus !== 'review' && itemStatus !== 'published' && (
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-7 text-[12px]'
                          onClick={() =>
                            api
                              .post(`/draft-publish/${collection}/${id}/submit-review`)
                              .then(() => {
                                queryClient.invalidateQueries({
                                  queryKey: ['item', collection, id]
                                })
                                toast.success('Submitted for review')
                              })
                          }
                        >
                          Submit for review
                        </Button>
                      )}
                      {itemStatus !== 'published' && (
                        <Button
                          size='sm'
                          className='h-7 bg-emerald-600 text-[12px] text-white hover:bg-emerald-700'
                          onClick={() =>
                            api.post(`/draft-publish/${collection}/${id}/publish`).then(() => {
                              queryClient.invalidateQueries({ queryKey: ['item', collection, id] })
                              toast.success('Published')
                            })
                          }
                        >
                          Publish
                        </Button>
                      )}
                      {itemStatus === 'published' && (
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-7 text-[12px]'
                          onClick={() =>
                            api.post(`/draft-publish/${collection}/${id}/unpublish`).then(() => {
                              queryClient.invalidateQueries({ queryKey: ['item', collection, id] })
                              toast.success('Unpublished')
                            })
                          }
                        >
                          Unpublish
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Extension item actions */}
                  {extItemActions.map((action) => (
                    <Button
                      key={action.id}
                      size='sm'
                      variant={
                        (action.variant as 'default' | 'destructive' | 'outline') ?? 'outline'
                      }
                      disabled={runningItemAction !== null}
                      onClick={async () => {
                        setRunningItemAction(action.id)
                        try {
                          const res = await api.post<{ data: { message: string } }>(
                            `/item-actions/${action.id}/execute`,
                            { collection, itemId: id }
                          )
                          toast.success(res.data.data.message)
                        } catch (err) {
                          const detail = (
                            err as { response?: { data?: { error?: string } } }
                          )?.response?.data?.error
                          toast.error(detail ?? `${action.label} failed`, { duration: 12000 })
                        } finally {
                          setRunningItemAction(null)
                        }
                      }}
                    >
                      {runningItemAction === action.id ? (
                        <Loader2 className='h-4 w-4 mr-1.5 animate-spin' />
                      ) : (
                        <Play className='h-4 w-4 mr-1.5' />
                      )}
                      {action.label}
                    </Button>
                  ))}

                  {/* Header widgets render in ItemEditForm's own header strip — not here. */}

                  {/* Admin tool buttons */}
                  <div className='flex overflow-hidden rounded-md'>
                    {id && !isNew && canDisablePickers && (
                      <button
                        type='button'
                        onClick={() => toggleExclusion.mutate()}
                        disabled={toggleExclusion.isPending}
                        title={isExcluded ? 'Re-enable in pickers' : 'Disable in pickers'}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                          isExcluded
                            ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800'
                            : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:text-muted-foreground'
                        )}
                      >
                        <EyeOff className='h-3.5 w-3.5' />
                        {isExcluded ? 'Excluded from pickers' : 'Disable in pickers'}
                      </button>
                    )}
                    {id && !isNew && canSchedule && (
                      <ScheduleChangeDialog
                        collection={collection!}
                        itemId={id}
                        fields={allFields}
                        triggerClassName='rounded-none -ml-px first:ml-0'
                      />
                    )}
                    {id && !isNew && (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => setTimelineOpen(true)}
                        title='Timeline — full record history'
                        className='rounded-none -ml-px first:ml-0'
                      >
                        <History className='h-3.5 w-3.5' />
                      </Button>
                    )}
                    {id && !isNew && (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => setGraphOpen(true)}
                        title='Record graph — explore related records'
                        className='rounded-none -ml-px first:ml-0'
                      >
                        <Waypoints className='h-3.5 w-3.5' />
                      </Button>
                    )}
                    {id && !isNew && collection && (
                      <ShareLinkPopover
                        collection={collection}
                        item={id}
                        triggerClassName='rounded-none -ml-px first:ml-0'
                      />
                    )}
                    {presence.viewers.length > 0 && (
                      <div
                        className='ml-2 flex items-center'
                        title={presence.viewers.map((v) => v.name).join(', ')}
                      >
                        {presence.viewers.slice(0, 4).map((v, i) => (
                          <span
                            key={v.id}
                            className='-ml-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-nvr-navy text-[9px] font-bold text-nvr-cyan first:ml-0 dark:border-card'
                            style={{ zIndex: 10 - i }}
                          >
                            {v.name
                              .split(' ')
                              .map((p) => p[0])
                              .join('')
                              .slice(0, 2)
                              .toUpperCase()}
                          </span>
                        ))}
                        {presence.viewers.length > 4 && (
                          <span className='-ml-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-slate-200 text-[9px] font-semibold text-slate-600 dark:border-card'>
                            +{presence.viewers.length - 4}
                          </span>
                        )}
                        <span className='ml-2 hidden text-[11px] text-slate-400 lg:inline'>
                          viewing now
                        </span>
                      </div>
                    )}
                    {Object.keys(presence.editing).length > 0 && (
                      <div className='ml-2 flex flex-wrap items-center gap-1'>
                        {Object.entries(presence.editing)
                          .slice(0, 3)
                          .map(([field, v]) => (
                            <span
                              key={field}
                              className='inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'
                            >
                              <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400' />
                              {v.name} editing {field.replace(/_/g, ' ')}
                            </span>
                          ))}
                      </div>
                    )}
                    {user?.is_admin && layoutAiEnabled && id && !isNew && (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={handleSummarize}
                        disabled={summarizing}
                        className='rounded-none -ml-px first:ml-0'
                      >
                        {summarizing ? (
                          <Loader2 className='h-3.5 w-3.5 animate-spin' />
                        ) : (
                          <Sparkles className='h-3.5 w-3.5' />
                        )}
                      </Button>
                    )}
                  </div>
                </div>

                {/* AI summary result */}
                {summary && (
                  <div className='mt-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-[13px] text-slate-700 dark:border-border dark:bg-muted dark:text-slate-200'>
                    {summary}
                  </div>
                )}
              </div>

              {/* ItemEditForm — owns field rendering, save/delete/revisions, pipeline, comments, tasks */}
              <ItemEditForm
                collection={collection!}
                itemId={isNew ? undefined : id}
                layoutSlug={layoutSlug}
          focusField={focusField}
                showHeader={true}
                onBack={undefined}
                onSaved={(newId) => {
                  if (isNew)
                    // replace: the blank /new form must not stay in history —
                    // back from the created record returns to WHERE THE USER
                    // WAS before creating, not to an empty form.
                    navigate(
                      `/collections/${collection}/${newId}${layoutSlug ? `?layout=${layoutSlug}` : ''}`,
                      { replace: true }
                    )
                }}
                onDeleted={() => navigate(`/collections/${collection}`)}
                extraTopContent={extraTopContent}
                extraBottomContent={extraBottomContent}
                {...(isNew && (dupePayload || prefillValues || (parentFieldParam && parentIdParam))
                  ? {
                      initialValues: {
                        ...(dupePayload?.values ?? {}),
                        ...(prefillValues ?? {}),
                        ...(parentFieldParam && parentIdParam
                          ? { [parentFieldParam]: parentIdParam }
                          : {})
                      },
                      ...(dupePayload?.links && Object.keys(dupePayload.links).length
                        ? { initialLinks: dupePayload.links }
                        : {}),
                      ...(dupePayload?.rows && Object.keys(dupePayload.rows).length
                        ? { initialRows: dupePayload.rows }
                        : {})
                    }
                  : {})}
                onDuplicate={
                  isNew
                    ? undefined
                    : (payload) => {
                        const key = `nvr-dupe-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
                        try {
                          sessionStorage.setItem(key, JSON.stringify(payload))
                        } catch {
                          /* storage full — the new page just opens blank */
                        }
                        navigate(
                          `/collections/${collection}/new?dupe=${key}${layoutSlug ? `&layout=${layoutSlug}` : ''}`
                        )
                      }
                }
                {...(isNew && importResult ? { initialImportResult: importResult } : {})}
              />
            </div>
          </DrilldownContext.Provider>
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
      {id && !isNew && collection && (
        <RecordGraphSheet
          collection={collection}
          item={id}
          open={graphOpen}
          onOpenChange={setGraphOpen}
        />
      )}
      {id && !isNew && collection && (
        <TimelineSheet
          collection={collection}
          item={id}
          open={timelineOpen}
          onOpenChange={setTimelineOpen}
        />
      )}
    </NivaroProvider>
  )
}
