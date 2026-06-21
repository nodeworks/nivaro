import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronsUpDown,
  EyeOff,
  Loader2,
  Network,
  Play,
  Sparkles
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ApprovalPanel } from '@/components/approval-panel'
import { ErpStatusBadge } from '@/components/erp-status-badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
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
import { Textarea } from '@/components/ui/textarea'
import { type Addendum, api, type CMSField } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, titleCase } from '@/lib/utils'
import { ItemEditAuthContext, ItemEditForm, NavigationContext, NivaroProvider, WidgetSlot } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'

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

function AttributeSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant='outline' role='combobox' aria-expanded={open} className='w-full justify-between font-normal'>
          <span className={value ? '' : 'text-muted-foreground'}>{value || 'Select…'}</span>
          <ChevronsUpDown className='ml-1 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
        <Command>
          <CommandList>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem key={opt} value={opt} onSelect={() => { onChange(opt === value ? '' : opt); setOpen(false) }}>
                  <Check className={cn('mr-2 h-4 w-4', value === opt ? 'opacity-100' : 'opacity-0')} />
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

function AttributeField({ def, onSave, saving }: { def: AttributeDef; onSave: (value: unknown) => void; saving: boolean }) {
  const [draft, setDraft] = useState<string>(def.value ?? '')
  useEffect(() => { setDraft(def.value ?? '') }, [def.value])
  const dirty = (draft || '') !== (def.value || '')

  if (def.type === 'boolean') {
    const checked = draft === 'true'
    return (
      <div className='space-y-1.5'>
        <Label>{def.label}{def.required && <span className='text-red-500 ml-0.5'>*</span>}</Label>
        <div className='flex items-center gap-2'>
          <Switch checked={checked} onCheckedChange={(c) => { const next = c ? 'true' : 'false'; setDraft(next); onSave(c) }} />
          <span className='text-sm text-muted-foreground'>{checked ? 'Yes' : 'No'}</span>
        </div>
      </div>
    )
  }

  return (
    <div className='space-y-1.5'>
      <Label>{def.label}{def.required && <span className='text-red-500 ml-0.5'>*</span>}</Label>
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
        <Button size='sm' className='h-7 text-[12px]' disabled={saving} onClick={() => onSave(draft)}>
          {saving ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Save'}
        </Button>
      )}
    </div>
  )
}

// ─── AddendumPanel ────────────────────────────────────────────────────────────

function AddendumPanel({ collection, itemId }: { collection: string; itemId: string }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newCost, setNewCost] = useState('')
  const [newDays, setNewDays] = useState('')

  const { data: addendums = [] } = useQuery({
    queryKey: ['addendums', collection, itemId],
    queryFn: () => api.get<{ data: Addendum[] }>(`/addendums/${collection}/${itemId}`).then((r) => r.data.data)
  })

  const createMut = useMutation({
    mutationFn: (body: { title: string; description?: string; cost_impact?: number; timeline_impact_days?: number }) =>
      api.post('/addendums', { parent_collection: collection, parent_id: itemId, ...body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['addendums', collection, itemId] })
      setAdding(false); setNewTitle(''); setNewDesc(''); setNewCost(''); setNewDays('')
      toast.success('Addendum created')
    },
    onError: () => toast.error('Failed to create addendum')
  })

  const approveMut = useMutation({
    mutationFn: (aId: string) => api.post(`/addendums/${aId}/approve`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['addendums', collection, itemId] }); toast.success('Addendum approved') }
  })

  const STATUS_COLORS: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-600',
    review: 'bg-amber-100 text-amber-700',
    approved: 'bg-emerald-100 text-emerald-700',
    rejected: 'bg-red-100 text-red-600'
  }

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
      <div className='flex items-center justify-between px-4 py-3 border-b border-slate-200'>
        <h3 className='text-[13px] font-medium text-slate-700'>Addenda & Amendments</h3>
        <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={() => setAdding(true)}>
          + New Addendum
        </Button>
      </div>
      {addendums.length === 0 && !adding ? (
        <div className='px-4 py-6 text-center text-[12px] text-slate-400'>No addenda attached to this record</div>
      ) : (
        <div className='divide-y divide-slate-100'>
          {addendums.map((a) => (
            <div key={a.id} className='flex items-start gap-3 px-4 py-3'>
              <div className='flex-1 min-w-0'>
                <div className='flex items-center gap-2'>
                  <span className='text-[13px] font-medium text-slate-800'>{a.title}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', STATUS_COLORS[a.status] ?? STATUS_COLORS.draft)}>{a.status}</span>
                </div>
                {a.description && <p className='mt-0.5 text-[12px] text-slate-500 line-clamp-2'>{a.description}</p>}
                <div className='mt-1 flex items-center gap-3 text-[11px] text-slate-400'>
                  {a.cost_impact != null && <span>Cost: {a.cost_impact >= 0 ? '+' : ''}{a.cost_impact}</span>}
                  {a.timeline_impact_days != null && <span>Timeline: {a.timeline_impact_days >= 0 ? '+' : ''}{a.timeline_impact_days}d</span>}
                </div>
              </div>
              {a.status === 'review' && (
                <Button size='sm' className='h-7 shrink-0 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700' onClick={() => approveMut.mutate(a.id)} disabled={approveMut.isPending}>
                  Approve
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {adding && (
        <div className='border-t border-slate-200 bg-slate-50 p-4 space-y-3'>
          <p className='text-[12px] font-medium text-slate-600'>New Addendum</p>
          <div className='grid grid-cols-2 gap-3'>
            <div className='col-span-2'><Label className='mb-1 block text-[11px]'>Title</Label><Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} className='h-7 text-[12px]' placeholder='Amendment title' /></div>
            <div className='col-span-2'><Label className='mb-1 block text-[11px]'>Description</Label><Textarea value={newDesc} onChange={(e) => setNewDesc(e.target.value)} rows={2} className='text-[12px]' placeholder='Describe the amendment…' /></div>
            <div><Label className='mb-1 block text-[11px]'>Cost Impact</Label><Input type='number' value={newCost} onChange={(e) => setNewCost(e.target.value)} className='h-7 text-[12px]' placeholder='0.00' /></div>
            <div><Label className='mb-1 block text-[11px]'>Timeline (days)</Label><Input type='number' value={newDays} onChange={(e) => setNewDays(e.target.value)} className='h-7 text-[12px]' placeholder='0' /></div>
          </div>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' size='sm' className='h-7 text-[12px]' onClick={() => setAdding(false)}>Cancel</Button>
            <Button type='button' size='sm' className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark' disabled={!newTitle.trim() || createMut.isPending}
              onClick={() => createMut.mutate({ title: newTitle.trim(), description: newDesc || undefined, cost_impact: newCost ? parseFloat(newCost) : undefined, timeline_impact_days: newDays ? parseInt(newDays, 10) : undefined })}>
              {createMut.isPending ? 'Creating…' : 'Create Addendum'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ScheduleChangeDialog ─────────────────────────────────────────────────────

function ScheduleChangeDialog({ collection, itemId, fields, triggerClassName }: {
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
    mutationFn: () => api.post('/scheduled-changes', { collection, item_id: itemId, change_type: 'field_update', changes: { [selectedField]: newValue }, scheduled_at: scheduledAt }),
    onSuccess: () => { setOpen(false); setSelectedField(''); setNewValue(''); setScheduledAt(''); toast.success('Change scheduled') },
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
                <Button variant='outline' role='combobox' aria-expanded={fieldPickerOpen} className='w-full justify-between text-[12px] font-normal h-8'>
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
                        <CommandItem key={f.field} value={f.field} onSelect={() => { setSelectedField(f.field === selectedField ? '' : f.field); setFieldPickerOpen(false) }} className='text-[12px]'>
                          <Check className={cn('mr-2 h-3.5 w-3.5', selectedField === f.field ? 'opacity-100' : 'opacity-0')} />
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
            <Input value={newValue} onChange={(e) => setNewValue(e.target.value)} className='h-7 text-[12px]' />
          </div>
          <div>
            <Label className='mb-1 block text-[11px]'>Scheduled at</Label>
            <Input type='datetime-local' value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className='h-7 text-[12px]' />
          </div>
          <Button size='sm' className='w-full h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark' disabled={!selectedField || !newValue || !scheduledAt || createMut.isPending} onClick={() => createMut.mutate()}>
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

  const client = useMemo(() => createNivaro(window.location.origin), [])
  const isNew = id === 'new'

  const [summarizing, setSummarizing] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [runningItemAction, setRunningItemAction] = useState<string | null>(null)

  const { data: headerLayoutData } = useQuery({
    queryKey: ['header-widgets', collection],
    queryFn: () => api.get<{ data: { layout: Record<string, unknown> | null; assignments: Array<{ field: string; group_key: string | null; widget_id: number | null; label_override: string | null; input_bindings: string | null }> } | null }>(`/collection-layouts/active?collection=${collection}`).then((r) => r.data.data ?? null).catch(() => null),
    enabled: !!collection,
    staleTime: 30_000
  })

  const headerWidgets = useMemo(() => {
    if (!headerLayoutData?.assignments) return []
    return headerLayoutData.assignments.filter(
      (a) => a.field.startsWith('__widget_') && a.field.endsWith('__') && a.widget_id != null && a.group_key === '__header__'
    ).map((a) => ({
      field: a.field,
      widgetId: a.widget_id!,
      label: a.label_override ?? null,
      inputBindings: typeof a.input_bindings === 'string' ? JSON.parse(a.input_bindings) : []
    }))
  }, [headerLayoutData])

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
    queryFn: () => api.get<{ data: TreeConfig | null }>(`/tree-configs/by-collection/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })

  const { data: ancestors } = useQuery({
    queryKey: ['tree-ancestors', collection, id],
    queryFn: () => api.get<{ data: Array<{ id: string | number; label: string }> }>(`/tree/${collection}/${id}/ancestors`).then((r) => r.data.data),
    enabled: !!id && !!treeConfig && !isNew,
    staleTime: 30_000
  })

  const { data: hierarchyConfigs } = useQuery({
    queryKey: ['hierarchy-configs'],
    queryFn: () => api.get<{ data: HierarchyConfig[] }>('/hierarchy-configs').then((r) => r.data.data),
    staleTime: 60_000,
    enabled: !!id && !isNew
  })

  const relevantHierarchies = useMemo(
    () => (hierarchyConfigs ?? []).filter((hc) => hc.levels.findIndex((l) => l.collection === collection) > 0),
    [hierarchyConfigs, collection]
  )

  const hierarchyAncestorResults = useQueries({
    queries: relevantHierarchies.map((hc) => ({
      queryKey: ['hierarchy-ancestors', hc.id, collection, id],
      queryFn: () => api.get<{ data: HierarchyAncestor[] }>(`/hierarchy/${hc.id}/node/${collection}/${id}/ancestors`).then((r) => r.data.data),
      enabled: !!id && !isNew && relevantHierarchies.length > 0,
      staleTime: 30_000
    }))
  })

  const { data: dpConfig } = useQuery({
    queryKey: ['draft-publish-config', collection],
    queryFn: () => api.get<{ data: { draft_publish_enabled: boolean } }>(`/draft-publish/${collection}/config`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 60_000
  })

  const { data: exclusionData, refetch: refetchExclusion } = useQuery({
    queryKey: ['picker-exclusion', collection, id],
    queryFn: () => api.get(`/picker-exclusions/status/${collection}/${id}`).then((r) => (r.data.data as { excluded: boolean })),
    enabled: !!collection && !!id && !isNew,
    staleTime: 60_000
  })
  const isExcluded = exclusionData?.excluded ?? false

  const toggleExclusion = useMutation({
    mutationFn: () => isExcluded
      ? api.delete('/picker-exclusions', { data: { collection, item_id: id } })
      : api.post('/picker-exclusions', { collection, item_id: id }),
    onSuccess: () => { refetchExclusion(); toast.success(isExcluded ? 'Record re-enabled in pickers' : 'Record excluded from pickers') },
    onError: () => toast.error('Failed to update picker status')
  })

  const { data: extItemActions = [] } = useQuery({
    queryKey: ['ext-item-actions', collection],
    queryFn: () => api.get<{ data: Array<{ id: string; label: string; variant?: string }> }>('/item-actions/registered', { params: { collection } }).then((r) => r.data.data),
    enabled: !!collection && !!id && !isNew,
    staleTime: 60_000
  })

  const { data: activeLayoutData } = useQuery({
    queryKey: ['active-layout', collection],
    queryFn: () => api.get<{ data: { layout: { ai_enabled?: boolean | number; allow_schedule?: boolean | number; allow_disable_pickers?: boolean | number } } }>('/collection-layouts/active', { params: { collection } }).then((r) => r.data.data).catch(() => null),
    enabled: !!collection,
    staleTime: 0
  })

  const { data: attributeDefs } = useQuery({
    queryKey: ['attribute-values', collection, id],
    queryFn: () => api.get<{ data: AttributeDef[] }>(`/attributes/${collection}/${id}`).then((r) => r.data.data),
    enabled: !!collection && !!id && !isNew
  })

  const saveAttributes = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.patch(`/attributes/${collection}/${id}`, values),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['attribute-values', collection, id] }); toast.success('Attribute saved') },
    onError: () => toast.error('Failed to save attribute')
  })

  // ── Derived values ────────────────────────────────────────────────────────
  const layoutMeta = activeLayoutData?.layout
  const layoutAiEnabled = layoutMeta ? !!layoutMeta.ai_enabled : true
  const canSchedule = !!user?.is_admin || !!layoutMeta?.allow_schedule
  const canDisablePickers = !!user?.is_admin || !!layoutMeta?.allow_disable_pickers
  const displayName = colMeta?.display_name ?? titleCase(collection ?? '')
  const allFields: CMSField[] = colMeta?.fields ?? []
  const itemStatus = (itemData as Record<string, unknown> | undefined)?._status as string | undefined

  // ── Pre-fill parent from URL params (new items via tree "Add child") ──────
  const parentFieldParam = searchParams.get('parentField')
  const parentIdParam = searchParams.get('parentId')

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
      {id && !isNew && <ErpStatusBadge collection={collection!} item={id} />}
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
              const isM2M = !!(level?.junction_table && level?.junction_child_fk && level?.junction_parent_fk)
              return (
                <div key={hc.id}>
                  <p className='text-[11px] font-medium text-slate-400 uppercase tracking-wide mb-1'>{hc.name}</p>
                  {hierarchyAncestors.length === 0 ? (
                    <p className='text-[12px] text-slate-400 italic'>No parent assigned</p>
                  ) : (
                    <nav className='flex items-center gap-1 flex-wrap text-[12px]'>
                      {hierarchyAncestors.map((anc, ai) => (
                        <span key={`${anc.collection}-${anc.id}`} className='flex items-center gap-1'>
                          {ai > 0 && <span className='text-slate-300'>›</span>}
                          <Link to={`/collections/${anc.collection}/${anc.id}`} className='text-nvr-cyan hover:underline'>{anc.label}</Link>
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
              <AttributeField key={def.key} def={def} saving={saveAttributes.isPending} onSave={(value) => saveAttributes.mutate({ [def.key]: value })} />
            ))}
          </CardContent>
        </Card>
      )}
      {id && !isNew && colMeta?.addendums_enabled && (
        <AddendumPanel collection={collection!} itemId={id} />
      )}
    </>
  )

  return (
    <NivaroProvider client={client}>
    <NavigationContext.Provider value={{ navigate }}>
    <ItemEditAuthContext.Provider value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}>
      <div className='flex flex-1 min-h-0 flex-col'>

        {/* Admin sticky header */}
        <div className='sticky top-0 z-20 shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-background'>
          <div className='flex items-center gap-4'>
            <Button variant='ghost' size='icon' onClick={() => navigate(`/collections/${collection}`)}>
              <ArrowLeft className='h-4 w-4' />
            </Button>
            <div className='flex-1'>
              <div className='flex items-center gap-2'>
                <h1 className='text-[18px] font-semibold text-slate-900 dark:text-slate-100'>{displayName}</h1>
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
                      <Link to={`/collections/${collection}/${ancestor.id}`} className='hover:text-slate-600 dark:hover:text-slate-300 transition-colors'>
                        {ancestor.label}
                      </Link>
                    </span>
                  ))}
                  <span className='text-slate-300'>›</span>
                  <span className='text-slate-600 dark:text-slate-300'>{ancestors[ancestors.length - 1]?.label}</span>
                </nav>
              )}
            </div>

            {/* Draft/publish controls */}
            {dpConfig?.draft_publish_enabled && id && !isNew && (
              <div className='flex items-center gap-2'>
                {itemStatus && (
                  <span className={cn(
                    'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                    itemStatus === 'published' ? 'bg-emerald-100 text-emerald-700' : itemStatus === 'review' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'
                  )}>
                    {itemStatus}
                  </span>
                )}
                {itemStatus !== 'review' && itemStatus !== 'published' && (
                  <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={() => api.post(`/draft-publish/${collection}/${id}/submit-review`).then(() => { queryClient.invalidateQueries({ queryKey: ['item', collection, id] }); toast.success('Submitted for review') })}>
                    Submit for review
                  </Button>
                )}
                {itemStatus !== 'published' && (
                  <Button size='sm' className='h-7 bg-emerald-600 text-[12px] text-white hover:bg-emerald-700' onClick={() => api.post(`/draft-publish/${collection}/${id}/publish`).then(() => { queryClient.invalidateQueries({ queryKey: ['item', collection, id] }); toast.success('Published') })}>
                    Publish
                  </Button>
                )}
                {itemStatus === 'published' && (
                  <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={() => api.post(`/draft-publish/${collection}/${id}/unpublish`).then(() => { queryClient.invalidateQueries({ queryKey: ['item', collection, id] }); toast.success('Unpublished') })}>
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
                variant={(action.variant as 'default' | 'destructive' | 'outline') ?? 'outline'}
                disabled={runningItemAction !== null}
                onClick={async () => {
                  setRunningItemAction(action.id)
                  try {
                    const res = await api.post<{ data: { message: string } }>(`/item-actions/${action.id}/execute`, { collection, itemId: id })
                    toast.success(res.data.data.message)
                  } catch { toast.error(`${action.label} failed`) } finally { setRunningItemAction(null) }
                }}
              >
                {runningItemAction === action.id ? <Loader2 className='h-4 w-4 mr-1.5 animate-spin' /> : <Play className='h-4 w-4 mr-1.5' />}
                {action.label}
              </Button>
            ))}

            {/* Header widgets — compact inline renders from layout __header__ zone */}
            {headerWidgets.length > 0 && headerWidgets.map((w) => (
              <WidgetSlot
                key={w.field}
                widgetId={w.widgetId}
                inputBindings={w.inputBindings}
                itemCollection={collection}
                label={w.label ?? undefined}
                compact={true}
                apiBase='/api'
              />
            ))}

            {/* Admin tool buttons */}
            <div className='flex overflow-hidden rounded-md'>
              {id && !isNew && canDisablePickers && (
                <button
                  type='button'
                  onClick={() => toggleExclusion.mutate()}
                  disabled={toggleExclusion.isPending}
                  title={isExcluded ? 'Re-enable in pickers' : 'Disable in pickers'}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-[12px] font-medium transition-colors border-r-0',
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
                  triggerClassName='rounded-none border-r-0'
                />
              )}
              {user?.is_admin && layoutAiEnabled && id && !isNew && (
                <Button variant='outline' size='sm' onClick={handleSummarize} disabled={summarizing} className='rounded-none border-r-0'>
                  {summarizing ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <Sparkles className='h-3.5 w-3.5' />}
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
          showHeader={true}
          onBack={undefined}
          onSaved={(newId) => {
            if (isNew) navigate(`/collections/${collection}/${newId}`)
          }}
          onDeleted={() => navigate(`/collections/${collection}`)}
          extraTopContent={extraTopContent}
          extraBottomContent={extraBottomContent}
          {...(parentFieldParam && parentIdParam && isNew
            ? { initialValues: { [parentFieldParam]: parentIdParam } }
            : {})}
        />
      </div>
    </ItemEditAuthContext.Provider>
    </NavigationContext.Provider>
    </NivaroProvider>
  )
}
