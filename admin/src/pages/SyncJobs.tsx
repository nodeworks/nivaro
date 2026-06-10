import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronsUpDown,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
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
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SyncStats {
  created: number
  updated: number
  skipped: number
  conflicts: number
  errors: string[]
}

export interface SyncJob {
  id: number
  name: string
  direction: 'pull' | 'push'
  external_api: number
  collection: string
  endpoint_path: string
  field_mapping: Record<string, unknown> | null
  conflict_strategy: 'newest-wins' | 'source-wins' | 'manual'
  schedule: string | null
  id_field: string | null
  external_id_field: string | null
  is_active: boolean
  last_run_at: string | null
  last_run_status: string | null
  last_run_stats: SyncStats | null
  created_at: string
  updated_at: string
}

interface ExternalApiOption {
  id: number
  name: string
}

interface MappingRow {
  external: string
  nivaro: string
}

interface JobForm {
  name: string
  direction: 'pull' | 'push'
  external_api: string
  collection: string
  endpoint_path: string
  mapping: MappingRow[]
  response_path: string
  updated_at_field: string
  conflict_strategy: 'newest-wins' | 'source-wins' | 'manual'
  schedule: string
  id_field: string
  external_id_field: string
  is_active: boolean
}

const EMPTY_FORM: JobForm = {
  name: '',
  direction: 'pull',
  external_api: '',
  collection: '',
  endpoint_path: '',
  mapping: [{ external: '', nivaro: '' }],
  response_path: '',
  updated_at_field: '',
  conflict_strategy: 'newest-wins',
  schedule: '',
  id_field: '',
  external_id_field: '',
  is_active: true
}

const RESERVED_KEYS = new Set(['response_path', 'updated_at_field', 'filter', 'fields'])

function jobToForm(job: SyncJob): JobForm {
  const fm = job.field_mapping ?? {}
  const nested = fm.fields as Record<string, string> | undefined
  let pairs: Record<string, string> = {}
  if (nested && typeof nested === 'object') {
    pairs = nested
  } else {
    for (const [k, v] of Object.entries(fm)) {
      if (!RESERVED_KEYS.has(k) && typeof v === 'string') pairs[k] = v
    }
  }
  const mapping = Object.entries(pairs).map(([external, nivaro]) => ({ external, nivaro }))
  return {
    name: job.name,
    direction: job.direction,
    external_api: String(job.external_api),
    collection: job.collection,
    endpoint_path: job.endpoint_path,
    mapping: mapping.length ? mapping : [{ external: '', nivaro: '' }],
    response_path: typeof fm.response_path === 'string' ? fm.response_path : '',
    updated_at_field: typeof fm.updated_at_field === 'string' ? fm.updated_at_field : '',
    conflict_strategy: job.conflict_strategy,
    schedule: job.schedule ?? '',
    id_field: job.id_field ?? '',
    external_id_field: job.external_id_field ?? '',
    is_active: job.is_active
  }
}

function formToPayload(f: JobForm) {
  const fields: Record<string, string> = {}
  for (const row of f.mapping) {
    if (row.external.trim() && row.nivaro.trim()) fields[row.external.trim()] = row.nivaro.trim()
  }
  const field_mapping: Record<string, unknown> = { fields }
  if (f.response_path.trim()) field_mapping.response_path = f.response_path.trim()
  if (f.updated_at_field.trim()) field_mapping.updated_at_field = f.updated_at_field.trim()
  return {
    name: f.name.trim(),
    direction: f.direction,
    external_api: Number(f.external_api),
    collection: f.collection,
    endpoint_path: f.endpoint_path.trim(),
    field_mapping,
    conflict_strategy: f.conflict_strategy,
    schedule: f.schedule.trim() || null,
    id_field: f.id_field.trim() || null,
    external_id_field: f.external_id_field.trim() || null,
    is_active: f.is_active
  }
}

// ─── Combobox ───────────────────────────────────────────────────────────────

function Combobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  mono
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
  mono?: boolean
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
          disabled={disabled}
          className={cn(
            'h-8 w-full justify-between px-2 text-[12px] font-normal',
            mono && 'font-mono'
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
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
                  keywords={[opt.label]}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className={cn('text-[12px]', mono && 'font-mono')}
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

// ─── Status dot ─────────────────────────────────────────────────────────────

function statusDotClass(status: string | null): string {
  switch (status) {
    case 'success':
      return 'bg-emerald-500'
    case 'partial':
      return 'bg-amber-500'
    case 'error':
      return 'bg-red-500'
    default:
      return 'bg-slate-300 dark:bg-slate-600'
  }
}

// ─── Last run stats panel ───────────────────────────────────────────────────

function StatsPanel({
  job,
  onRefresh,
  refreshing
}: {
  job: SyncJob
  onRefresh: () => void
  refreshing: boolean
}) {
  const stats = job.last_run_stats
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='mb-3 flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <span className={cn('h-2 w-2 rounded-full', statusDotClass(job.last_run_status))} />
          <span className='text-[13px] font-medium text-slate-700 dark:text-slate-300'>
            Last Run
          </span>
          {job.last_run_at && (
            <span className='text-[11px] text-slate-400'>
              {formatRelative(job.last_run_at)} · {job.last_run_status}
            </span>
          )}
        </div>
        <Button variant='ghost' size='sm' className='h-7 gap-1.5 px-2' onClick={onRefresh}>
          <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>
      {!job.last_run_at ? (
        <p className='text-[12px] text-slate-400'>Never run.</p>
      ) : (
        <>
          <div className='gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border grid grid-cols-4'>
            {(
              [
                ['Created', stats?.created ?? 0],
                ['Updated', stats?.updated ?? 0],
                ['Skipped', stats?.skipped ?? 0],
                ['Conflicts', stats?.conflicts ?? 0]
              ] as [string, number][]
            ).map(([label, value]) => (
              <div key={label} className='bg-white px-3 py-2 dark:bg-card'>
                <p className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                  {label}
                </p>
                <p className='text-[16px] font-semibold text-slate-800 dark:text-slate-200'>
                  {value}
                </p>
              </div>
            ))}
          </div>
          {stats?.errors && stats.errors.length > 0 && (
            <div className='mt-3 max-h-32 overflow-auto rounded-md border border-red-200 bg-red-50 p-2 dark:border-red-900 dark:bg-red-950/30'>
              {stats.errors.map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional error list
                <p key={i} className='font-mono text-[11px] text-red-600 dark:text-red-400'>
                  {e}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Job editor (right panel) ───────────────────────────────────────────────

function JobEditor({
  job,
  onSaved,
  onDeleted
}: {
  job: SyncJob | null // null = new
  onSaved: (id: number) => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<JobForm>(job ? jobToForm(job) : EMPTY_FORM)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when switching jobs
  useEffect(() => {
    setForm(job ? jobToForm(job) : EMPTY_FORM)
    setConfirmDelete(false)
  }, [job?.id])

  const set = <K extends keyof JobForm>(key: K, value: JobForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const { data: apis = [] } = useQuery<ExternalApiOption[]>({
    queryKey: ['external-apis'],
    queryFn: () =>
      api.get<{ data: ExternalApiOption[] }>('/external-apis').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: collectionsData = [] } = useQuery<{ collection: string }[]>({
    queryKey: ['collections'],
    queryFn: () =>
      api.get<{ data: { collection: string }[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', form.collection],
    queryFn: () =>
      api
        .get<{ data: { fields: { field: string; type: string; hidden?: boolean }[] } }>(
          `/collections/${form.collection}`
        )
        .then((r) => r.data.data),
    enabled: !!form.collection,
    staleTime: 30_000
  })

  const fieldOptions = (colMeta?.fields ?? [])
    .filter((f) => !f.hidden)
    .map((f) => ({ value: f.field, label: `${f.field} (${f.type})` }))

  const save = useMutation({
    mutationFn: () => {
      const payload = formToPayload(form)
      return job
        ? api.patch<{ data: SyncJob }>(`/sync-jobs/${job.id}`, payload).then((r) => r.data.data)
        : api.post<{ data: SyncJob }>('/sync-jobs', payload).then((r) => r.data.data)
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['sync-jobs'] })
      toast.success(job ? 'Sync job saved' : 'Sync job created')
      onSaved(saved.id)
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Failed to save')
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/sync-jobs/${job?.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sync-jobs'] })
      toast.success('Sync job deleted')
      onDeleted()
    },
    onError: () => toast.error('Failed to delete')
  })

  const runNow = useMutation({
    mutationFn: () => api.post(`/sync-jobs/${job?.id}/run`),
    onSuccess: () => {
      toast.success('Sync started')
      setTimeout(() => qc.invalidateQueries({ queryKey: ['sync-jobs'] }), 3000)
    },
    onError: () => toast.error('Failed to start sync')
  })

  const isValid =
    form.name.trim() !== '' &&
    form.external_api !== '' &&
    form.collection !== '' &&
    form.endpoint_path.trim() !== ''

  return (
    <div className='mx-auto w-full max-w-3xl space-y-5 p-6'>
      <div className='flex items-center justify-between'>
        <h2 className='text-[16px] font-semibold text-slate-900 dark:text-slate-100'>
          {job ? job.name : 'New Sync Job'}
        </h2>
        <div className='flex items-center gap-2'>
          {job && (
            <Button
              variant='outline'
              size='sm'
              className='gap-1.5'
              onClick={() => runNow.mutate()}
              disabled={runNow.isPending}
            >
              <Play className='h-3.5 w-3.5' />
              Run now
            </Button>
          )}
          <Button
            size='sm'
            className='gap-1.5'
            onClick={() => save.mutate()}
            disabled={!isValid || save.isPending}
          >
            <Save className='h-3.5 w-3.5' />
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {job && (
        <StatsPanel
          job={job}
          onRefresh={() => qc.invalidateQueries({ queryKey: ['sync-jobs'] })}
          refreshing={false}
        />
      )}

      <div className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Name *</Label>
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder='e.g. Pull customers from ERP'
              className='h-8 text-[13px]'
            />
          </div>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Direction</Label>
            <div className='flex h-8 overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              {(['pull', 'push'] as const).map((d) => (
                <button
                  key={d}
                  type='button'
                  onClick={() => set('direction', d)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 text-[12px] font-medium transition-colors',
                    form.direction === d
                      ? 'bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan'
                      : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-muted/50'
                  )}
                >
                  {d === 'pull' ? (
                    <ArrowDownToLine className='h-3.5 w-3.5' />
                  ) : (
                    <ArrowUpFromLine className='h-3.5 w-3.5' />
                  )}
                  {d === 'pull' ? 'Pull (external → CMS)' : 'Push (CMS → external)'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>External API *</Label>
            <Combobox
              value={form.external_api}
              onChange={(v) => set('external_api', v)}
              options={apis.map((a) => ({ value: String(a.id), label: a.name }))}
              placeholder='Select API…'
            />
          </div>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Endpoint Path *</Label>
            <Input
              value={form.endpoint_path}
              onChange={(e) => set('endpoint_path', e.target.value)}
              placeholder='/v1/customers'
              className='h-8 font-mono text-[12px]'
            />
          </div>
        </div>

        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Collection *</Label>
            <Combobox
              value={form.collection}
              onChange={(v) => set('collection', v)}
              options={collectionsData.map((c) => ({ value: c.collection, label: c.collection }))}
              placeholder='Select collection…'
              mono
            />
          </div>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Conflict Strategy</Label>
            <Combobox
              value={form.conflict_strategy}
              onChange={(v) =>
                set('conflict_strategy', (v || 'newest-wins') as JobForm['conflict_strategy'])
              }
              options={[
                { value: 'newest-wins', label: 'Newest wins (compare timestamps)' },
                { value: 'source-wins', label: 'Source wins (always overwrite)' },
                { value: 'manual', label: 'Manual (skip + count conflict)' }
              ]}
            />
          </div>
        </div>
      </div>

      {/* Field mapping */}
      <div className='space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div>
            <Label className='text-[12px]'>Field Mapping</Label>
            <p className='text-[11px] text-slate-400'>
              External field {form.direction === 'pull' ? '→' : '←'} Nivaro field
            </p>
          </div>
          <Button
            variant='outline'
            size='sm'
            className='h-7 gap-1.5'
            onClick={() => set('mapping', [...form.mapping, { external: '', nivaro: '' }])}
          >
            <Plus className='h-3 w-3' />
            Add
          </Button>
        </div>
        {form.mapping.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional list
          <div key={i} className='flex items-center gap-2'>
            <Input
              placeholder='external.field'
              value={row.external}
              onChange={(e) => {
                const next = [...form.mapping]
                next[i] = { ...row, external: e.target.value }
                set('mapping', next)
              }}
              className='h-8 flex-1 font-mono text-[12px]'
            />
            <span className='shrink-0 text-[12px] text-slate-400'>↔</span>
            <div className='flex-1'>
              <Combobox
                value={row.nivaro}
                onChange={(v) => {
                  const next = [...form.mapping]
                  next[i] = { ...row, nivaro: v }
                  set('mapping', next)
                }}
                options={fieldOptions}
                placeholder={form.collection ? 'Nivaro field…' : 'Select collection first'}
                disabled={!form.collection}
                mono
              />
            </div>
            <button
              type='button'
              onClick={() =>
                set(
                  'mapping',
                  form.mapping.filter((_, j) => j !== i)
                )
              }
              className='text-slate-400 hover:text-red-500'
              aria-label='Remove mapping'
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          </div>
        ))}

        <div className='grid grid-cols-2 gap-4 border-t border-slate-100 pt-3 dark:border-border'>
          {form.direction === 'pull' && (
            <div className='space-y-1.5'>
              <Label className='text-[12px]'>Response Path</Label>
              <Input
                value={form.response_path}
                onChange={(e) => set('response_path', e.target.value)}
                placeholder='data.items'
                className='h-8 font-mono text-[12px]'
              />
              <p className='text-[11px] text-slate-400'>
                Dotted path to the record array in the response. Leave empty if the response is an
                array.
              </p>
            </div>
          )}
          {form.conflict_strategy === 'newest-wins' && (
            <div className='space-y-1.5'>
              <Label className='text-[12px]'>Updated-At Field</Label>
              <Combobox
                value={form.updated_at_field}
                onChange={(v) => set('updated_at_field', v)}
                options={fieldOptions}
                placeholder={form.collection ? 'Timestamp field…' : 'Select collection first'}
                disabled={!form.collection}
                mono
              />
              <p className='text-[11px] text-slate-400'>
                Nivaro field compared to decide which side is newer.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Identity + schedule */}
      <div className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>External ID Field</Label>
            <Input
              value={form.external_id_field}
              onChange={(e) => set('external_id_field', e.target.value)}
              placeholder='id'
              className='h-8 font-mono text-[12px]'
            />
            <p className='text-[11px] text-slate-400'>
              Field in the external record holding its id.
            </p>
          </div>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Local ID Column</Label>
            <Combobox
              value={form.id_field}
              onChange={(v) => set('id_field', v)}
              options={fieldOptions}
              placeholder={
                form.collection ? 'Column storing external id…' : 'Select collection first'
              }
              disabled={!form.collection}
              mono
            />
            <p className='text-[11px] text-slate-400'>
              Nivaro column where the external id is stored for matching.
            </p>
          </div>
        </div>

        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Cron Schedule</Label>
            <Input
              value={form.schedule}
              onChange={(e) => set('schedule', e.target.value)}
              placeholder='0 */6 * * * (optional)'
              className='h-8 font-mono text-[12px]'
            />
            <p className='text-[11px] text-slate-400'>Leave empty for manual runs only.</p>
          </div>
          <div className='flex items-center justify-between rounded-md border border-slate-200 px-3 py-2.5 dark:border-border'>
            <div>
              <Label className='cursor-pointer text-[12px]'>Active</Label>
              <p className='text-[11px] text-slate-400'>Inactive jobs are never scheduled.</p>
            </div>
            <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} />
          </div>
        </div>
      </div>

      {job && (
        <div className='flex justify-end'>
          {confirmDelete ? (
            <div className='flex items-center gap-2'>
              <span className='text-[12px] text-slate-500'>Delete this sync job?</span>
              <Button
                variant='destructive'
                size='sm'
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {remove.isPending ? 'Deleting…' : 'Confirm delete'}
              </Button>
              <Button variant='ghost' size='sm' onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant='ghost'
              size='sm'
              className='gap-1.5 text-slate-400 hover:text-red-500'
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className='h-3.5 w-3.5' />
              Delete
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function SyncJobsPage() {
  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null)

  const { data: jobs = [], isLoading } = useQuery<SyncJob[]>({
    queryKey: ['sync-jobs'],
    queryFn: () => api.get<{ data: SyncJob[] }>('/sync-jobs').then((r) => r.data.data)
  })

  const selectedJob =
    typeof selectedId === 'number' ? (jobs.find((j) => j.id === selectedId) ?? null) : null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <RefreshCw className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-lg font-semibold text-slate-900 dark:text-slate-100'>Sync Jobs</h1>
            <p className='text-[12px] text-slate-400'>
              Bi-directional data sync between collections and external systems.
            </p>
          </div>
        </div>
        <Button size='sm' className='gap-1.5' onClick={() => setSelectedId('new')}>
          <Plus className='h-4 w-4' />
          New Sync Job
        </Button>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading ? (
            <div className='space-y-2 p-4'>
              {[1, 2, 3].map((i) => (
                <div key={i} className='h-12 animate-pulse rounded-lg bg-muted' />
              ))}
            </div>
          ) : jobs.length === 0 ? (
            <p className='p-4 text-[12px] text-slate-400'>No sync jobs yet.</p>
          ) : (
            <ul>
              {jobs.map((job) => (
                <li key={job.id}>
                  <button
                    type='button'
                    onClick={() => setSelectedId(job.id)}
                    className={cn(
                      'block w-full px-4 py-3 text-left transition-colors',
                      selectedId === job.id
                        ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/[0.07]'
                        : 'hover:bg-slate-50 dark:hover:bg-muted/50'
                    )}
                  >
                    <div className='mb-0.5 flex items-center gap-2'>
                      {job.direction === 'pull' ? (
                        <ArrowDownToLine className='h-3.5 w-3.5 shrink-0 text-blue-500' />
                      ) : (
                        <ArrowUpFromLine className='h-3.5 w-3.5 shrink-0 text-emerald-500' />
                      )}
                      <span
                        className={cn(
                          'flex-1 truncate text-[13px] font-medium',
                          selectedId === job.id
                            ? 'text-nvr-navy dark:text-nvr-cyan'
                            : 'text-slate-700 dark:text-slate-300'
                        )}
                      >
                        {job.name}
                      </span>
                      <span
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          statusDotClass(job.last_run_status)
                        )}
                        title={job.last_run_status ?? 'never run'}
                      />
                    </div>
                    <div className='flex items-center gap-1.5 pl-[22px]'>
                      <span className='truncate font-mono text-[11px] text-slate-400'>
                        {job.collection}
                      </span>
                      {job.is_active ? (
                        <Badge
                          variant='outline'
                          className='h-4 border-green-500/20 bg-green-500/10 px-1 text-[10px] text-green-700 dark:text-green-400'
                        >
                          Active
                        </Badge>
                      ) : (
                        <Badge
                          variant='outline'
                          className='h-4 px-1 text-[10px] text-muted-foreground'
                        >
                          Off
                        </Badge>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {selectedId === null ? (
            <div className='flex h-full flex-col items-center justify-center text-center'>
              <RefreshCw className='mb-3 h-10 w-10 text-slate-300 dark:text-slate-600' />
              <p className='text-sm font-medium text-slate-600 dark:text-slate-300'>
                No sync job selected
              </p>
              <p className='mt-1 text-xs text-slate-400'>
                Select a job on the left, or create a new one.
              </p>
            </div>
          ) : (
            <JobEditor
              key={selectedId}
              job={selectedJob}
              onSaved={(id) => setSelectedId(id)}
              onDeleted={() => setSelectedId(null)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
