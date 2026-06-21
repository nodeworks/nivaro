import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  Code2,
  Copy,
  LayoutPanelTop,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
  Puzzle,
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Separator } from '@/components/ui/separator'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

interface WidgetFeed {
  id: number
  name: string
  token: string
  collection: string
  fields: string[]
  filters: Record<string, string> | null
  limit_count: number
  sort: string | null
  is_active: boolean
  created_by: string
  created_at: string
}

interface FeedFormData {
  name: string
  collection: string
  fields: string[]
  filters: { field: string; value: string }[]
  limit_count: number
  sort: string
  is_active: boolean
}

interface SubmissionForm {
  id: string
  name: string
  token: string
  is_active: boolean
}

const FORM_DEFAULTS: FeedFormData = {
  name: '',
  collection: '',
  fields: [],
  filters: [],
  limit_count: 20,
  sort: '',
  is_active: true
}

function feedToForm(feed: WidgetFeed): FeedFormData {
  return {
    name: feed.name,
    collection: feed.collection,
    fields: feed.fields ?? [],
    filters: Object.entries(feed.filters ?? {}).map(([field, value]) => ({
      field,
      value: String(value)
    })),
    limit_count: feed.limit_count ?? 20,
    sort: feed.sort ?? '',
    is_active: feed.is_active
  }
}

// ─── Combobox helper (shadcn Popover + Command — never native select) ─────────

function PickCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  widthClass = 'w-[260px]'
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
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
          disabled={disabled}
          className='h-8 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn(widthClass, 'p-0')} align='start'>
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
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
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

// ─── Snippet block with copy button ───────────────────────────────────────────

function SnippetBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center justify-between'>
        <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</Label>
        <Button
          size='sm'
          variant='ghost'
          className='h-6 px-2 text-[11px]'
          onClick={() => {
            navigator.clipboard.writeText(code)
            toast.success('Snippet copied')
          }}
        >
          <Copy className='mr-1 h-3 w-3' />
          Copy
        </Button>
      </div>
      <pre className='overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700 dark:border-border dark:bg-muted/30 dark:text-slate-300'>
        {code}
      </pre>
    </div>
  )
}

// ─── Feed editor form ─────────────────────────────────────────────────────────

function FeedForm({
  feed,
  onSaved,
  onCancel
}: {
  feed: WidgetFeed | null // null = create
  onSaved: (feed: WidgetFeed) => void
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<FeedFormData>(feed ? feedToForm(feed) : FORM_DEFAULTS)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the selected feed changes
  useEffect(() => {
    setForm(feed ? feedToForm(feed) : FORM_DEFAULTS)
  }, [feed?.id])

  const { data: collections = [] } = useQuery({
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

  const allFields = (colMeta?.fields ?? []).filter((f) => !f.hidden)
  const fieldOptions = allFields.map((f) => ({ value: f.field, label: `${f.field} (${f.type})` }))
  const availableFieldOptions = fieldOptions.filter((o) => !form.fields.includes(o.value))

  function set<K extends keyof FeedFormData>(key: K, value: FeedFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const filters: Record<string, string> = {}
      for (const row of form.filters) {
        if (row.field.trim()) filters[row.field.trim()] = row.value
      }
      const body = {
        name: form.name.trim(),
        collection: form.collection,
        fields: form.fields,
        filters: Object.keys(filters).length > 0 ? filters : null,
        limit_count: form.limit_count,
        sort: form.sort.trim() || null,
        is_active: form.is_active
      }
      const res = feed
        ? await api.patch<{ data: WidgetFeed }>(`/widget/${feed.id}`, body)
        : await api.post<{ data: WidgetFeed }>('/widget', body)
      return res.data.data
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['widget-feeds'] })
      toast.success(feed ? 'Feed updated' : 'Feed created')
      onSaved(saved)
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Failed to save feed')
  })

  const isValid = form.name.trim() !== '' && form.collection !== '' && form.fields.length > 0

  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-4'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>Name</Label>
          <Input
            className='h-8 text-[13px]'
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder='e.g. Latest news'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Collection
          </Label>
          <PickCombobox
            value={form.collection}
            onChange={(v) => {
              set('collection', v)
              set('fields', [])
              set('filters', [])
              set('sort', '')
            }}
            options={collections
              .filter((c) => !c.collection.startsWith('nivaro_'))
              .map((c) => ({ value: c.collection, label: c.collection }))}
            placeholder='Select collection…'
          />
        </div>
      </div>

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>
          Exposed fields
        </Label>
        <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
          Only these columns are ever returned by the public feed.
        </p>
        <div className='flex flex-wrap items-center gap-1.5'>
          {form.fields.map((f) => (
            <Badge key={f} className='gap-1 font-mono text-[11px]'>
              {f}
              <button
                type='button'
                aria-label={`Remove ${f}`}
                onClick={() =>
                  set(
                    'fields',
                    form.fields.filter((x) => x !== f)
                  )
                }
                className='ml-0.5 rounded-sm opacity-60 hover:opacity-100'
              >
                <X className='h-3 w-3' />
              </button>
            </Badge>
          ))}
          <div className='w-[220px]'>
            <PickCombobox
              value=''
              onChange={(v) => {
                if (v && !form.fields.includes(v)) set('fields', [...form.fields, v])
              }}
              options={availableFieldOptions}
              placeholder={form.collection ? 'Add field…' : 'Select collection first'}
              disabled={!form.collection}
            />
          </div>
        </div>
      </div>

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>
          Equality filters
        </Label>
        <div className='space-y-2'>
          {form.filters.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: filter rows are positional with no stable id
            <div key={`filter-${i}`} className='flex items-center gap-2'>
              <div className='w-[220px]'>
                <PickCombobox
                  value={row.field}
                  onChange={(v) => {
                    const next = [...form.filters]
                    next[i] = { ...next[i], field: v }
                    set('filters', next)
                  }}
                  options={fieldOptions}
                  placeholder='Field…'
                  disabled={!form.collection}
                />
              </div>
              <Input
                className='h-8 flex-1 font-mono text-[12px]'
                value={row.value}
                onChange={(e) => {
                  const next = [...form.filters]
                  next[i] = { ...next[i], value: e.target.value }
                  set('filters', next)
                }}
                placeholder='Value'
              />
              <Button
                size='icon'
                variant='ghost'
                className='h-7 w-7 shrink-0'
                aria-label='Remove filter'
                onClick={() =>
                  set(
                    'filters',
                    form.filters.filter((_, idx) => idx !== i)
                  )
                }
              >
                <X className='h-3.5 w-3.5' />
              </Button>
            </div>
          ))}
          <Button
            size='sm'
            variant='outline'
            className='h-7 text-[12px]'
            disabled={!form.collection}
            onClick={() => set('filters', [...form.filters, { field: '', value: '' }])}
          >
            <Plus className='mr-1 h-3 w-3' />
            Add filter
          </Button>
        </div>
      </div>

      <div className='grid grid-cols-3 gap-4'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Limit (max 100)
          </Label>
          <Input
            className='h-8 text-[13px]'
            type='number'
            min={1}
            max={100}
            value={form.limit_count}
            onChange={(e) =>
              set('limit_count', Math.min(100, Math.max(1, Number(e.target.value) || 1)))
            }
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Sort field
          </Label>
          <PickCombobox
            value={form.sort.replace(/^-/, '')}
            onChange={(v) => set('sort', v ? (form.sort.startsWith('-') ? `-${v}` : v) : '')}
            options={fieldOptions}
            placeholder='No sort'
            disabled={!form.collection}
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>Direction</Label>
          <div className='flex h-8 items-center gap-2'>
            <Switch
              checked={form.sort.startsWith('-')}
              disabled={!form.sort}
              onCheckedChange={(desc) =>
                set('sort', desc ? `-${form.sort.replace(/^-/, '')}` : form.sort.replace(/^-/, ''))
              }
            />
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              {form.sort.startsWith('-') ? 'Descending' : 'Ascending'}
            </span>
          </div>
        </div>
      </div>

      <div className='flex items-center gap-2'>
        <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} />
        <span className='text-[13px]'>Active</span>
      </div>

      <div className='flex items-center gap-2 pt-1'>
        <Button size='sm' disabled={!isValid || saveMut.isPending} onClick={() => saveMut.mutate()}>
          <Save className='mr-1.5 h-3.5 w-3.5' />
          {saveMut.isPending ? 'Saving…' : feed ? 'Save changes' : 'Create feed'}
        </Button>
        {onCancel && (
          <Button size='sm' variant='ghost' onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Token card ───────────────────────────────────────────────────────────────

function TokenCard({ feed }: { feed: WidgetFeed }) {
  const qc = useQueryClient()
  const [confirmRotate, setConfirmRotate] = useState(false)

  const rotateMut = useMutation({
    mutationFn: () => api.post<{ data: WidgetFeed }>(`/widget/${feed.id}/rotate-token`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['widget-feeds'] })
      setConfirmRotate(false)
      toast.success('Token rotated — old embeds will stop working')
    },
    onError: () => toast.error('Failed to rotate token')
  })

  return (
    <div className='space-y-2'>
      <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>Feed token</Label>
      <div className='flex items-center gap-2'>
        <code className='flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-[12px] dark:border-border dark:bg-muted/30'>
          {feed.token}
        </code>
        <Button
          size='icon'
          variant='outline'
          className='h-8 w-8 shrink-0'
          aria-label='Copy token'
          onClick={() => {
            navigator.clipboard.writeText(feed.token)
            toast.success('Token copied')
          }}
        >
          <Copy className='h-3.5 w-3.5' />
        </Button>
        {confirmRotate ? (
          <div className='flex shrink-0 items-center gap-1'>
            <Button
              size='sm'
              variant='destructive'
              className='h-8 text-[12px]'
              disabled={rotateMut.isPending}
              onClick={() => rotateMut.mutate()}
            >
              {rotateMut.isPending ? 'Rotating…' : 'Confirm rotate'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-8 text-[12px]'
              onClick={() => setConfirmRotate(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size='sm'
            variant='outline'
            className='h-8 shrink-0 text-[12px]'
            onClick={() => setConfirmRotate(true)}
          >
            <RefreshCw className='mr-1.5 h-3 w-3' />
            Rotate
          </Button>
        )}
      </div>
      <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
        Rotating immediately invalidates the current token on every embedded page.
      </p>
    </div>
  )
}

// ─── Embed snippet card ───────────────────────────────────────────────────────

function EmbedSnippets({ feed }: { feed: WidgetFeed }) {
  const origin = window.location.origin
  const [formId, setFormId] = useState('')

  const { data: forms = [] } = useQuery<SubmissionForm[]>({
    queryKey: ['submission-forms-for-widgets'],
    queryFn: () =>
      api.get<{ data: SubmissionForm[] }>('/submission-forms').then((r) => r.data.data),
    staleTime: 30_000
  })

  const selectedForm = forms.find((f) => f.id === formId) ?? null

  const listSnippet = [
    `<script src="${origin}/api/widget/widget.js"`,
    `  data-nivaro-widget="list"`,
    `  data-token="${feed.token}"`,
    `  data-title-field="${feed.fields[0] ?? ''}"`,
    `  data-theme="light"></script>`
  ].join('\n')

  const formSnippet = selectedForm
    ? [
        `<script src="${origin}/api/widget/widget.js"`,
        `  data-nivaro-widget="form"`,
        `  data-token="${selectedForm.token}"`,
        `  data-theme="light"></script>`
      ].join('\n')
    : null

  return (
    <div className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex items-center gap-2'>
        <Code2 className='h-4 w-4 text-slate-400 dark:text-muted-foreground' />
        <h3 className='text-[13px] font-semibold'>Embed snippets</h3>
      </div>

      <SnippetBlock label='List widget (this feed)' code={listSnippet} />

      <div className='space-y-2'>
        <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>
          Form widget — pick a submission form
        </Label>
        <div className='w-[300px]'>
          <PickCombobox
            value={formId}
            onChange={setFormId}
            options={forms.map((f) => ({
              value: f.id,
              label: f.is_active ? f.name : `${f.name} (inactive)`
            }))}
            placeholder={forms.length ? 'Select submission form…' : 'No submission forms'}
            disabled={forms.length === 0}
            widthClass='w-[300px]'
          />
        </div>
        {formSnippet && (
          <SnippetBlock label={`Form widget (${selectedForm?.name})`} code={formSnippet} />
        )}
      </div>

      <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
        Optional attributes: <code>data-target</code> (CSS selector), <code>data-limit</code>,{' '}
        <code>data-link-template</code> (e.g. <code>https://site.com/news/{'{id}'}</code>),{' '}
        <code>data-theme="dark"</code>.
      </p>
    </div>
  )
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function FeedDetail({ feed, onDeleted }: { feed: WidgetFeed; onDeleted: () => void }) {
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/widget/${feed.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['widget-feeds'] })
      toast.success('Feed deleted')
      onDeleted()
    },
    onError: () => toast.error('Failed to delete feed')
  })

  return (
    <div className='mx-auto w-full max-w-3xl space-y-6 p-6'>
      <div className='flex items-start justify-between gap-4'>
        <div>
          <h2 className='text-[15px] font-semibold'>{feed.name}</h2>
          <p className='font-mono text-[12px] text-slate-400 dark:text-muted-foreground'>
            {feed.collection} · created {formatDate(feed.created_at)}
          </p>
        </div>
        {confirmDelete ? (
          <div className='flex shrink-0 items-center gap-1'>
            <Button
              size='sm'
              variant='destructive'
              className='h-8 text-[12px]'
              disabled={deleteMut.isPending}
              onClick={() => deleteMut.mutate()}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Confirm delete'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-8 text-[12px]'
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size='sm'
            variant='outline'
            className='h-8 shrink-0 text-[12px] text-destructive hover:text-destructive'
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className='mr-1.5 h-3 w-3' />
            Delete
          </Button>
        )}
      </div>

      <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <TokenCard feed={feed} />
      </div>

      <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <FeedForm feed={feed} onSaved={() => undefined} />
      </div>

      <EmbedSnippets feed={feed} />
    </div>
  )
}

// ─── Internal Widgets ─────────────────────────────────────────────────────────

interface InternalWidget {
  id: number
  name: string
  description: string | null
  icon: string | null
  widget_type: 'stat' | 'action-buttons' | 'custom-query' | 'external-api' | 'list'
  inputs: unknown[] | null
  config: unknown | null
  is_active: boolean
  created_at: string
}

const WIDGET_TYPE_OPTIONS = [
  { value: 'stat', label: 'Stat / KPI' },
  { value: 'list', label: 'List' },
  { value: 'custom-query', label: 'Custom Query' },
  { value: 'action-buttons', label: 'Action Buttons' },
  { value: 'external-api', label: 'External API' }
] as const

interface InternalWidgetFormData {
  name: string
  description: string
  icon: string
  widget_type: InternalWidget['widget_type']
  config: string
  is_active: boolean
}

const INTERNAL_WIDGET_DEFAULTS: InternalWidgetFormData = {
  name: '',
  description: '',
  icon: '',
  widget_type: 'stat',
  config: '{}',
  is_active: true
}

function widgetToForm(w: InternalWidget): InternalWidgetFormData {
  return {
    name: w.name,
    description: w.description ?? '',
    icon: w.icon ?? '',
    widget_type: w.widget_type,
    config: w.config != null ? JSON.stringify(w.config, null, 2) : '{}',
    is_active: w.is_active
  }
}

// ─── Widget Config Editor ─────────────────────────────────────────────────────

function tryParse(json: string): Record<string, unknown> {
  try { return (JSON.parse(json || '{}') as Record<string, unknown>) } catch { return {} }
}

// ── shared types
interface FilterRow { col: string; value: string }
interface ParamBinding { param: string; input_key: string; default_value?: string }

// ── stat
interface StatCfg {
  collection: string; field: string; aggregation: string; id_input: string
  filters: FilterRow[]; prefix: string; suffix: string; format: string
}
function rawToStat(r: Record<string, unknown>): StatCfg {
  const rf = typeof r.filters === 'object' && r.filters && !Array.isArray(r.filters)
    ? r.filters as Record<string, unknown> : {}
  const filters = Object.entries(rf).map(([col, cond]) => ({
    col, value: cond && typeof cond === 'object' && '_eq' in (cond as object)
      ? String((cond as Record<string, unknown>)._eq ?? '') : ''
  }))
  const d = (typeof r.display === 'object' && r.display ? r.display : {}) as Record<string, unknown>
  return {
    collection: String(r.collection ?? ''), field: String(r.field ?? ''),
    aggregation: String(r.aggregation ?? 'none'), id_input: String(r.id_input ?? ''),
    filters, prefix: String(d.prefix ?? ''), suffix: String(d.suffix ?? ''), format: String(d.format ?? '')
  }
}
function statToRaw(c: StatCfg): Record<string, unknown> {
  const f: Record<string, unknown> = {}
  for (const r of c.filters) if (r.col.trim()) f[r.col.trim()] = { _eq: r.value }
  const d: Record<string, unknown> = {}
  if (c.prefix) d.prefix = c.prefix
  if (c.suffix) d.suffix = c.suffix
  if (c.format) d.format = c.format
  const out: Record<string, unknown> = { collection: c.collection, field: c.field }
  if (c.aggregation && c.aggregation !== 'none') out.aggregation = c.aggregation
  if (c.id_input) out.id_input = c.id_input
  if (Object.keys(f).length) out.filters = f
  if (Object.keys(d).length) out.display = d
  return out
}

// ── list
interface ListCfg {
  collection: string; fields: string; filters: FilterRow[]
  limit: number; order_field: string; order_dir: string
}
function rawToList(r: Record<string, unknown>): ListCfg {
  const rf = typeof r.filters === 'object' && r.filters && !Array.isArray(r.filters)
    ? r.filters as Record<string, unknown> : {}
  const filters = Object.entries(rf).map(([col, cond]) => ({
    col, value: cond && typeof cond === 'object' && '_eq' in (cond as object)
      ? String((cond as Record<string, unknown>)._eq ?? '') : ''
  }))
  return {
    collection: String(r.collection ?? ''),
    fields: Array.isArray(r.fields) ? (r.fields as string[]).join(', ') : String(r.fields ?? ''),
    filters, limit: Number(r.limit ?? 50),
    order_field: String(r.order_field ?? ''), order_dir: String(r.order_dir ?? 'asc')
  }
}
function listToRaw(c: ListCfg): Record<string, unknown> {
  const f: Record<string, unknown> = {}
  for (const r of c.filters) if (r.col.trim()) f[r.col.trim()] = { _eq: r.value }
  const out: Record<string, unknown> = { collection: c.collection }
  const fields = c.fields.split(',').map((x) => x.trim()).filter(Boolean)
  if (fields.length) out.fields = fields
  if (Object.keys(f).length) out.filters = f
  if (c.limit) out.limit = c.limit
  if (c.order_field) { out.order_field = c.order_field; out.order_dir = c.order_dir || 'asc' }
  return out
}

// ── custom query
interface CQValueField { field: string; label: string; prefix: string; suffix: string; format: string }
interface CQCfg { query_id: string; param_bindings: ParamBinding[]; value_fields: CQValueField[] }
const BLANK_CQ_VF: CQValueField = { field: '', label: '', prefix: '', suffix: '', format: '' }
function rawToCQ(r: Record<string, unknown>): CQCfg {
  const pb = Array.isArray(r.param_bindings) ? r.param_bindings as Array<Record<string, unknown>> : []
  const vf = Array.isArray(r.value_fields) ? r.value_fields as Array<Record<string, unknown>> : []
  return {
    query_id: String(r.query_id ?? ''),
    param_bindings: pb.map((b) => ({
      param: String(b.param ?? ''), input_key: String(b.input_key ?? ''),
      ...(b.default_value != null && b.default_value !== '' ? { default_value: String(b.default_value) } : {})
    })),
    value_fields: vf.map((v) => ({
      field: String(v.field ?? ''), label: String(v.label ?? ''),
      prefix: String(v.prefix ?? ''), suffix: String(v.suffix ?? ''), format: String(v.format ?? '')
    }))
  }
}
function cqToRaw(c: CQCfg): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (c.query_id) out.query_id = c.query_id
  if (c.param_bindings.length) out.param_bindings = c.param_bindings
  const vf = c.value_fields.filter(v => v.field.trim())
  if (vf.length) out.value_fields = vf
  return out
}

// ── external api
interface ExtApiCfg { api_id: string; endpoint_slug: string; param_bindings: ParamBinding[]; display_fields: string }
function rawToExtApi(r: Record<string, unknown>): ExtApiCfg {
  const pb = Array.isArray(r.param_bindings) ? r.param_bindings as Array<Record<string, unknown>> : []
  return {
    api_id: String(r.api_id ?? ''), endpoint_slug: String(r.endpoint_slug ?? ''),
    param_bindings: pb.map((b) => ({
      param: String(b.param ?? ''), input_key: String(b.input_key ?? ''),
      ...(b.default_value != null && b.default_value !== '' ? { default_value: String(b.default_value) } : {})
    })),
    display_fields: Array.isArray(r.display_fields)
      ? (r.display_fields as string[]).join(', ') : String(r.display_fields ?? '')
  }
}
function extApiToRaw(c: ExtApiCfg): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (c.api_id) out.api_id = Number(c.api_id) || c.api_id
  if (c.endpoint_slug) out.endpoint_slug = c.endpoint_slug
  if (c.param_bindings.length) out.param_bindings = c.param_bindings
  const df = c.display_fields.split(',').map((x) => x.trim()).filter(Boolean)
  if (df.length) out.display_fields = df
  return out
}

// ── action buttons
interface ActionBtn {
  label: string; style: string; action_type: string
  ac_url: string; ac_trigger: string; ac_payload: string
  ac_collection: string; ac_id_input: string; ac_field: string; ac_value: string
  ac_api_id: string; ac_endpoint: string
}
const BLANK_BTN: ActionBtn = {
  label: '', style: 'default', action_type: 'navigate',
  ac_url: '', ac_trigger: '', ac_payload: '{}',
  ac_collection: '', ac_id_input: '', ac_field: '', ac_value: '',
  ac_api_id: '', ac_endpoint: ''
}
interface BtnsCfg { buttons: ActionBtn[] }
function rawToBtns(r: Record<string, unknown>): BtnsCfg {
  const btns = Array.isArray(r.buttons) ? r.buttons as Array<Record<string, unknown>> : []
  return {
    buttons: btns.map((b) => {
      const at = String(b.action_type ?? 'navigate')
      const ac = (typeof b.action_config === 'object' && b.action_config ? b.action_config : {}) as Record<string, unknown>
      return {
        label: String(b.label ?? ''), style: String(b.style ?? 'default'), action_type: at,
        ac_url: at === 'navigate' ? String(ac.url ?? '') : '',
        ac_trigger: at === 'flow' ? String(ac.trigger_type ?? '') : '',
        ac_payload: at === 'flow'
          ? (typeof ac.payload === 'object' ? JSON.stringify(ac.payload, null, 2) : String(ac.payload ?? '{}'))
          : '{}',
        ac_collection: at === 'field-update' ? String(ac.collection ?? '') : '',
        ac_id_input: at === 'field-update' ? String(ac.id_input ?? '') : '',
        ac_field: at === 'field-update' ? String(Object.keys(ac).find((k) => k !== 'collection' && k !== 'id_input') ?? '') : '',
        ac_value: at === 'field-update' ? String(Object.entries(ac).find(([k]) => k !== 'collection' && k !== 'id_input')?.[1] ?? '') : '',
        ac_api_id: at === 'external-api' ? String(ac.api_id ?? '') : '',
        ac_endpoint: at === 'external-api' ? String(ac.endpoint_slug ?? '') : ''
      }
    })
  }
}
function btnsToRaw(c: BtnsCfg): Record<string, unknown> {
  return {
    buttons: c.buttons.map((b) => {
      const base: Record<string, unknown> = { label: b.label, style: b.style, action_type: b.action_type }
      if (b.action_type === 'navigate') {
        base.action_config = { url: b.ac_url }
      } else if (b.action_type === 'flow') {
        let payload: unknown = {}
        try { payload = JSON.parse(b.ac_payload || '{}') } catch {}
        base.action_config = { trigger_type: b.ac_trigger, payload }
      } else if (b.action_type === 'field-update') {
        const ac: Record<string, unknown> = { collection: b.ac_collection, id_input: b.ac_id_input }
        if (b.ac_field) ac[b.ac_field] = b.ac_value
        base.action_config = ac
      } else if (b.action_type === 'external-api') {
        base.action_config = { api_id: Number(b.ac_api_id) || b.ac_api_id, endpoint_slug: b.ac_endpoint }
      }
      return base
    })
  }
}

// ── shared sub-components

function FilterRows({ rows, onChange }: { rows: FilterRow[]; onChange: (r: FilterRow[]) => void }) {
  function upd(i: number, k: keyof FilterRow, v: string) {
    const n = [...rows]; n[i] = { ...n[i], [k]: v }; onChange(n)
  }
  return (
    <div className='space-y-1.5'>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable list
        <div key={i} className='flex items-center gap-1.5'>
          <Input className='h-7 flex-1 font-mono text-[12px]' placeholder='column' value={r.col} onChange={(e) => upd(i, 'col', e.target.value)} />
          <span className='shrink-0 text-[11px] text-muted-foreground'>=</span>
          <Input className='h-7 flex-1 font-mono text-[12px]' placeholder='value or {{input}}' value={r.value} onChange={(e) => upd(i, 'value', e.target.value)} />
          <Button size='sm' variant='ghost' className='h-7 w-7 p-0' onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X className='h-3 w-3' />
          </Button>
        </div>
      ))}
      <Button size='sm' variant='ghost' className='h-7 px-2 text-[12px]' onClick={() => onChange([...rows, { col: '', value: '' }])}>
        <Plus className='mr-1 h-3 w-3' />Add filter
      </Button>
    </div>
  )
}

function ParamBindings({ bindings, onChange }: { bindings: ParamBinding[]; onChange: (b: ParamBinding[]) => void }) {
  function upd(i: number, k: keyof ParamBinding, v: string) {
    const n = [...bindings]; n[i] = { ...n[i], [k]: v }; onChange(n)
  }
  return (
    <div className='space-y-1.5'>
      {bindings.length > 0 && (
        <div className='grid grid-cols-[1fr_1fr_1fr_28px] gap-1.5'>
          <span className='text-[10px] text-muted-foreground'>:param</span>
          <span className='text-[10px] text-muted-foreground'>input key</span>
          <span className='text-[10px] text-muted-foreground'>default (NULL if blank)</span>
          <span />
        </div>
      )}
      {bindings.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable list
        <div key={i} className='grid grid-cols-[1fr_1fr_1fr_28px] items-center gap-1.5'>
          <Input className='h-7 font-mono text-[12px]' placeholder=':param_name' value={b.param} onChange={(e) => upd(i, 'param', e.target.value)} />
          <Input className='h-7 font-mono text-[12px]' placeholder='input key' value={b.input_key} onChange={(e) => upd(i, 'input_key', e.target.value)} />
          <Input className='h-7 font-mono text-[12px]' placeholder='NULL' value={b.default_value ?? ''} onChange={(e) => upd(i, 'default_value', e.target.value)} />
          <Button size='sm' variant='ghost' className='h-7 w-7 p-0' onClick={() => onChange(bindings.filter((_, j) => j !== i))}>
            <X className='h-3 w-3' />
          </Button>
        </div>
      ))}
      <Button size='sm' variant='ghost' className='h-7 px-2 text-[12px]' onClick={() => onChange([...bindings, { param: '', input_key: '' }])}>
        <Plus className='mr-1 h-3 w-3' />Add binding
      </Button>
    </div>
  )
}

// ── per-type config forms

const AGG_OPTS = [
  { value: 'none', label: 'None (single record)' },
  { value: 'count', label: 'COUNT' },
  { value: 'sum', label: 'SUM' },
  { value: 'avg', label: 'AVG' },
  { value: 'min', label: 'MIN' },
  { value: 'max', label: 'MAX' }
]
const FORMAT_OPTS = [
  { value: '', label: 'Default' },
  { value: 'number', label: 'Number (1,234)' },
  { value: 'currency', label: 'Currency ($1,234)' },
  { value: 'percent', label: 'Percent (12%)' },
  { value: 'compact', label: 'Compact (1.2k)' }
]
const ORDER_OPTS = [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]
const BTN_STYLE_OPTS = [
  { value: 'default', label: 'Default' },
  { value: 'primary', label: 'Primary' },
  { value: 'destructive', label: 'Destructive' },
  { value: 'outline', label: 'Outline' },
  { value: 'ghost', label: 'Ghost' }
]
const ACTION_TYPE_OPTS = [
  { value: 'navigate', label: 'Navigate' },
  { value: 'flow', label: 'Trigger Flow' },
  { value: 'field-update', label: 'Update Field' },
  { value: 'external-api', label: 'Call External API' }
]

function useCollectionOptions() {
  const q = useQuery({
    queryKey: ['widget-cfg-cols'],
    queryFn: () => api.get<{ data: Array<{ name: string; label: string | null }> }>('/collections').then((r) => r.data.data)
  })
  return q.data?.map((c) => ({ value: c.name, label: c.label || c.name })) ?? []
}

function useFieldOptions(collection: string) {
  const q = useQuery({
    queryKey: ['widget-cfg-fields', collection],
    queryFn: () =>
      api.get<{ data: { fields: Array<{ field: string; label: string | null }> } }>(`/collections/${collection}`)
        .then((r) => r.data.data.fields),
    enabled: !!collection
  })
  return q.data?.map((f) => ({ value: f.field, label: f.label ? `${f.label} (${f.field})` : f.field })) ?? []
}

function StatConfigForm({ cfg, onChange }: { cfg: StatCfg; onChange: (c: StatCfg) => void }) {
  const colOpts = useCollectionOptions()
  const fieldOpts = useFieldOptions(cfg.collection)
  function set<K extends keyof StatCfg>(k: K, v: StatCfg[K]) { onChange({ ...cfg, [k]: v }) }
  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>Collection</Label>
          <PickCombobox value={cfg.collection} onChange={(v) => { set('collection', v); set('field', '') }} options={colOpts} placeholder='Select collection…' />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>Field</Label>
          <PickCombobox value={cfg.field} onChange={(v) => set('field', v)} options={fieldOpts} placeholder='Select field…' disabled={!cfg.collection} />
        </div>
      </div>
      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>Aggregation</Label>
          <PickCombobox value={cfg.aggregation} onChange={(v) => set('aggregation', v)} options={AGG_OPTS} />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>
            ID input key <span className='text-[10px] opacity-60'>(single record lookup)</span>
          </Label>
          <Input className='h-8 font-mono text-[12px]' value={cfg.id_input} onChange={(e) => set('id_input', e.target.value)} placeholder='e.g. project_id' />
        </div>
      </div>
      <div>
        <Label className='mb-2 block text-[11px] text-muted-foreground'>Static filters</Label>
        <FilterRows rows={cfg.filters} onChange={(v) => set('filters', v)} />
      </div>
      <Separator />
      <div>
        <Label className='mb-2 block text-[11px] text-muted-foreground'>Display</Label>
        <div className='grid grid-cols-3 gap-2'>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>Prefix</Label>
            <Input className='h-7 text-[12px]' value={cfg.prefix} onChange={(e) => set('prefix', e.target.value)} placeholder='$' />
          </div>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>Suffix</Label>
            <Input className='h-7 text-[12px]' value={cfg.suffix} onChange={(e) => set('suffix', e.target.value)} placeholder='%' />
          </div>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>Format</Label>
            <PickCombobox value={cfg.format} onChange={(v) => set('format', v)} options={FORMAT_OPTS} placeholder='Default' />
          </div>
        </div>
      </div>
    </div>
  )
}

function ListConfigForm({ cfg, onChange }: { cfg: ListCfg; onChange: (c: ListCfg) => void }) {
  const colOpts = useCollectionOptions()
  const fieldOpts = useFieldOptions(cfg.collection)
  function set<K extends keyof ListCfg>(k: K, v: ListCfg[K]) { onChange({ ...cfg, [k]: v }) }
  return (
    <div className='space-y-4'>
      <div className='space-y-1'>
        <Label className='text-[11px] text-muted-foreground'>Collection</Label>
        <PickCombobox value={cfg.collection} onChange={(v) => set('collection', v)} options={colOpts} placeholder='Select collection…' />
      </div>
      <div className='space-y-1'>
        <Label className='text-[11px] text-muted-foreground'>Fields <span className='text-[10px] opacity-60'>(comma-separated, leave blank for all)</span></Label>
        <Input className='h-8 font-mono text-[12px]' value={cfg.fields} onChange={(e) => set('fields', e.target.value)} placeholder='id, title, status' />
      </div>
      <div>
        <Label className='mb-2 block text-[11px] text-muted-foreground'>Static filters</Label>
        <FilterRows rows={cfg.filters} onChange={(v) => set('filters', v)} />
      </div>
      <div className='grid grid-cols-3 gap-3'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>Limit</Label>
          <Input className='h-8 text-[12px]' type='number' min={1} max={500} value={cfg.limit} onChange={(e) => set('limit', Number(e.target.value))} />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>Order by</Label>
          <PickCombobox value={cfg.order_field} onChange={(v) => set('order_field', v)} options={fieldOpts} placeholder='None' disabled={!cfg.collection} />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>Direction</Label>
          <PickCombobox value={cfg.order_dir} onChange={(v) => set('order_dir', v)} options={ORDER_OPTS} />
        </div>
      </div>
    </div>
  )
}

function CQConfigForm({ cfg, onChange }: { cfg: CQCfg; onChange: (c: CQCfg) => void }) {
  const queriesQ = useQuery({
    queryKey: ['widget-cfg-cqs'],
    queryFn: () => api.get<{ data: Array<{ id: number; name: string }> }>('/custom-queries').then((r) => r.data.data)
  })
  const opts = queriesQ.data?.map((q) => ({ value: String(q.id), label: q.name })) ?? []
  return (
    <div className='space-y-4'>
      <div className='space-y-1'>
        <Label className='text-[11px] text-muted-foreground'>Custom query</Label>
        <PickCombobox value={cfg.query_id} onChange={(v) => onChange({ ...cfg, query_id: v })} options={opts} placeholder='Select query…' />
      </div>
      <div>
        <Label className='mb-2 block text-[11px] text-muted-foreground'>
          Parameter bindings <span className='text-[10px] opacity-60'>(:param ← input key)</span>
        </Label>
        <ParamBindings bindings={cfg.param_bindings} onChange={(v) => onChange({ ...cfg, param_bindings: v })} />
      </div>
      <Separator />
      <div>
        <div className='mb-2 flex items-center justify-between'>
          <Label className='text-[11px] text-muted-foreground'>
            Value fields <span className='text-[10px] opacity-60'>(leave empty to show raw list)</span>
          </Label>
          <Button size='sm' variant='outline' className='h-6 gap-1 px-2 text-[11px]'
            onClick={() => onChange({ ...cfg, value_fields: [...cfg.value_fields, { ...BLANK_CQ_VF }] })}>
            <Plus className='h-3 w-3' />Add
          </Button>
        </div>
        {cfg.value_fields.length === 0 && (
          <p className='text-[11px] text-slate-400'>No value fields — widget renders as list table.</p>
        )}
        <div className='space-y-2'>
          {cfg.value_fields.map((vf, i) => {
            const upd = (patch: Partial<CQValueField>) => {
              const next = cfg.value_fields.map((v, j) => j === i ? { ...v, ...patch } : v)
              onChange({ ...cfg, value_fields: next })
            }
            const remove = () => onChange({ ...cfg, value_fields: cfg.value_fields.filter((_, j) => j !== i) })
            return (
              <div key={i} className='rounded border border-slate-200 bg-slate-50/50 p-2 space-y-1.5'>
                <div className='flex items-center gap-1.5'>
                  <Input className='h-7 flex-1 font-mono text-[11px]' value={vf.field} onChange={e => upd({ field: e.target.value })} placeholder='column name' />
                  <Input className='h-7 flex-1 text-[11px]' value={vf.label} onChange={e => upd({ label: e.target.value })} placeholder='label' />
                  <button type='button' onClick={remove} className='text-slate-300 hover:text-red-400'>✕</button>
                </div>
                <div className='grid grid-cols-3 gap-1.5'>
                  <Input className='h-6 text-[11px]' value={vf.prefix} onChange={e => upd({ prefix: e.target.value })} placeholder='prefix ($)' />
                  <Input className='h-6 text-[11px]' value={vf.suffix} onChange={e => upd({ suffix: e.target.value })} placeholder='suffix (%)' />
                  <PickCombobox value={vf.format} onChange={v => upd({ format: v })} options={FORMAT_OPTS} placeholder='Format' />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ExtApiConfigForm({ cfg, onChange }: { cfg: ExtApiCfg; onChange: (c: ExtApiCfg) => void }) {
  const apisQ = useQuery({
    queryKey: ['widget-cfg-apis'],
    queryFn: () => api.get<{ data: Array<{ id: number; name: string }> }>('/external-apis').then((r) => r.data.data)
  })
  const endpointsQ = useQuery({
    queryKey: ['widget-cfg-ep', cfg.api_id],
    queryFn: () =>
      api.get<{ data: Array<{ slug: string; name: string | null; path: string; method: string }> }>(`/external-apis/${cfg.api_id}/endpoints`)
        .then((r) => r.data.data),
    enabled: !!cfg.api_id
  })
  const apiOpts = apisQ.data?.map((a) => ({ value: String(a.id), label: a.name })) ?? []
  const epOpts = endpointsQ.data?.map((e) => ({ value: e.slug, label: `${e.method} ${e.path} (${e.slug})` })) ?? []
  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>External API</Label>
          <PickCombobox value={cfg.api_id} onChange={(v) => onChange({ ...cfg, api_id: v, endpoint_slug: '' })} options={apiOpts} placeholder='Select API…' />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>Endpoint</Label>
          <PickCombobox value={cfg.endpoint_slug} onChange={(v) => onChange({ ...cfg, endpoint_slug: v })} options={epOpts} placeholder='Select endpoint…' disabled={!cfg.api_id} />
        </div>
      </div>
      <div>
        <Label className='mb-2 block text-[11px] text-muted-foreground'>
          Parameter bindings <span className='text-[10px] opacity-60'>(URL param ← input key)</span>
        </Label>
        <ParamBindings bindings={cfg.param_bindings} onChange={(v) => onChange({ ...cfg, param_bindings: v })} />
      </div>
      <div className='space-y-1'>
        <Label className='text-[11px] text-muted-foreground'>
          Display fields <span className='text-[10px] opacity-60'>(comma-separated response keys to show)</span>
        </Label>
        <Input className='h-8 font-mono text-[12px]' value={cfg.display_fields} onChange={(e) => onChange({ ...cfg, display_fields: e.target.value })} placeholder='status, amount, name' />
      </div>
    </div>
  )
}

function ActionButtonsConfigForm({ cfg, onChange }: { cfg: BtnsCfg; onChange: (c: BtnsCfg) => void }) {
  const [openIdx, setOpenIdx] = useState<number | null>(cfg.buttons.length === 0 ? null : 0)
  const colOpts = useCollectionOptions()

  function updateBtn(i: number, patch: Partial<ActionBtn>) {
    const next = cfg.buttons.map((b, j) => j === i ? { ...b, ...patch } : b)
    onChange({ buttons: next })
  }
  function addBtn() {
    const next = [...cfg.buttons, { ...BLANK_BTN }]
    onChange({ buttons: next })
    setOpenIdx(next.length - 1)
  }
  function removeBtn(i: number) {
    const next = cfg.buttons.filter((_, j) => j !== i)
    onChange({ buttons: next })
    setOpenIdx(next.length > 0 ? Math.min(i, next.length - 1) : null)
  }

  return (
    <div className='space-y-2'>
      {cfg.buttons.map((btn, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable list
        <div key={i} className='rounded-md border border-slate-200 dark:border-border'>
          <button
            type='button'
            className='flex w-full items-center justify-between px-3 py-2 text-[12px] hover:bg-slate-50 dark:hover:bg-muted/20'
            onClick={() => setOpenIdx(openIdx === i ? null : i)}
          >
            <span className='font-medium'>{btn.label || `Button ${i + 1}`}</span>
            <div className='flex items-center gap-2'>
              <Badge variant='outline' className='h-5 px-1.5 font-mono text-[10px]'>{btn.action_type}</Badge>
              {openIdx === i ? <ChevronDown className='h-3.5 w-3.5 text-muted-foreground' /> : <ChevronRight className='h-3.5 w-3.5 text-muted-foreground' />}
            </div>
          </button>
          {openIdx === i && (
            <div className='space-y-3 border-t border-slate-200 p-3 dark:border-border'>
              <div className='grid grid-cols-2 gap-3'>
                <div className='space-y-1'>
                  <Label className='text-[11px] text-muted-foreground'>Label</Label>
                  <Input className='h-7 text-[12px]' value={btn.label} onChange={(e) => updateBtn(i, { label: e.target.value })} placeholder='Click me' />
                </div>
                <div className='space-y-1'>
                  <Label className='text-[11px] text-muted-foreground'>Style</Label>
                  <PickCombobox value={btn.style} onChange={(v) => updateBtn(i, { style: v })} options={BTN_STYLE_OPTS} widthClass='w-[200px]' />
                </div>
              </div>
              <div className='space-y-1'>
                <Label className='text-[11px] text-muted-foreground'>Action type</Label>
                <PickCombobox value={btn.action_type} onChange={(v) => updateBtn(i, { action_type: v })} options={ACTION_TYPE_OPTS} widthClass='w-[240px]' />
              </div>
              {btn.action_type === 'navigate' && (
                <div className='space-y-1'>
                  <Label className='text-[11px] text-muted-foreground'>URL <span className='text-[10px] opacity-60'>{'(relative path, {{input_key}} allowed)'}</span></Label>
                  <Input className='h-7 font-mono text-[12px]' value={btn.ac_url} onChange={(e) => updateBtn(i, { ac_url: e.target.value })} placeholder='/collections/projects/{{project_id}}' />
                </div>
              )}
              {btn.action_type === 'flow' && (
                <div className='space-y-3'>
                  <div className='space-y-1'>
                    <Label className='text-[11px] text-muted-foreground'>Trigger type</Label>
                    <Input className='h-7 font-mono text-[12px]' value={btn.ac_trigger} onChange={(e) => updateBtn(i, { ac_trigger: e.target.value })} placeholder='my-custom-trigger' />
                  </div>
                  <div className='space-y-1'>
                    <Label className='text-[11px] text-muted-foreground'>Extra payload (JSON)</Label>
                    <Textarea className='font-mono text-[12px]' rows={3} value={btn.ac_payload} onChange={(e) => updateBtn(i, { ac_payload: e.target.value })} spellCheck={false} />
                  </div>
                </div>
              )}
              {btn.action_type === 'field-update' && (
                <div className='space-y-3'>
                  <div className='grid grid-cols-2 gap-2'>
                    <div className='space-y-1'>
                      <Label className='text-[11px] text-muted-foreground'>Collection</Label>
                      <PickCombobox value={btn.ac_collection} onChange={(v) => updateBtn(i, { ac_collection: v })} options={colOpts} placeholder='Select…' />
                    </div>
                    <div className='space-y-1'>
                      <Label className='text-[11px] text-muted-foreground'>ID input key</Label>
                      <Input className='h-7 font-mono text-[12px]' value={btn.ac_id_input} onChange={(e) => updateBtn(i, { ac_id_input: e.target.value })} placeholder='item_id' />
                    </div>
                  </div>
                  <div className='grid grid-cols-2 gap-2'>
                    <div className='space-y-1'>
                      <Label className='text-[11px] text-muted-foreground'>Field name</Label>
                      <Input className='h-7 font-mono text-[12px]' value={btn.ac_field} onChange={(e) => updateBtn(i, { ac_field: e.target.value })} placeholder='status' />
                    </div>
                    <div className='space-y-1'>
                      <Label className='text-[11px] text-muted-foreground'>Value</Label>
                      <Input className='h-7 font-mono text-[12px]' value={btn.ac_value} onChange={(e) => updateBtn(i, { ac_value: e.target.value })} placeholder='approved' />
                    </div>
                  </div>
                </div>
              )}
              {btn.action_type === 'external-api' && (
                <div className='space-y-1'>
                  <Label className='text-[11px] text-muted-foreground'>API ID + endpoint slug</Label>
                  <div className='flex gap-2'>
                    <Input className='h-7 w-24 font-mono text-[12px]' value={btn.ac_api_id} onChange={(e) => updateBtn(i, { ac_api_id: e.target.value })} placeholder='API ID' />
                    <Input className='h-7 flex-1 font-mono text-[12px]' value={btn.ac_endpoint} onChange={(e) => updateBtn(i, { ac_endpoint: e.target.value })} placeholder='endpoint-slug' />
                  </div>
                </div>
              )}
              <div className='flex justify-end'>
                <Button size='sm' variant='ghost' className='h-7 px-2 text-[11px] text-destructive hover:text-destructive' onClick={() => removeBtn(i)}>
                  <Trash2 className='mr-1 h-3 w-3' />Remove
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
      <Button size='sm' variant='outline' className='h-8 w-full text-[12px]' onClick={addBtn}>
        <Plus className='mr-1.5 h-3.5 w-3.5' />Add button
      </Button>
    </div>
  )
}

function WidgetConfigEditor({
  type,
  config,
  onChange
}: {
  type: InternalWidget['widget_type']
  config: string
  onChange: (json: string) => void
}) {
  const [rawMode, setRawMode] = useState(false)
  const [rawText, setRawText] = useState(config)
  const [parseError, setParseError] = useState<string | null>(null)

  const parsed = tryParse(config)
  const [statCfg, setStatCfg] = useState<StatCfg>(() => rawToStat(parsed))
  const [listCfg, setListCfg] = useState<ListCfg>(() => rawToList(parsed))
  const [cqCfg, setCqCfg] = useState<CQCfg>(() => rawToCQ(parsed))
  const [extApiCfg, setExtApiCfg] = useState<ExtApiCfg>(() => rawToExtApi(parsed))
  const [btnsCfg, setBtnsCfg] = useState<BtnsCfg>(() => rawToBtns(parsed))
  const [compactStyle, setCompactStyle] = useState<string>(() => String(parsed.compact_style ?? 'default'))

  function currentJson(overrideStyle?: string): string {
    try {
      let raw: Record<string, unknown> = {}
      if (type === 'stat') raw = statToRaw(statCfg)
      else if (type === 'list') raw = listToRaw(listCfg)
      else if (type === 'custom-query') raw = cqToRaw(cqCfg)
      else if (type === 'external-api') raw = extApiToRaw(extApiCfg)
      else if (type === 'action-buttons') raw = btnsToRaw(btnsCfg)
      const style = overrideStyle ?? compactStyle
      if (style && style !== 'default') raw.compact_style = style
      return JSON.stringify(raw, null, 2)
    } catch { return '{}' }
  }

  function switchToRaw() {
    setRawText(currentJson())
    setParseError(null)
    setRawMode(true)
  }

  function switchToForm() {
    try {
      const raw = tryParse(rawText)
      setStatCfg(rawToStat(raw))
      setListCfg(rawToList(raw))
      setCqCfg(rawToCQ(raw))
      setExtApiCfg(rawToExtApi(raw))
      setBtnsCfg(rawToBtns(raw))
      setCompactStyle(String(raw.compact_style ?? 'default'))
      onChange(rawText)
      setParseError(null)
      setRawMode(false)
    } catch {
      setParseError('Invalid JSON — fix before switching to form view')
    }
  }

  function onStyleChange(style: string) {
    setCompactStyle(style)
    onChange(currentJson(style))
  }

  function onStatChange(c: StatCfg) { setStatCfg(c); onChange(JSON.stringify({ ...statToRaw(c), ...(compactStyle !== 'default' ? { compact_style: compactStyle } : {}) }, null, 2)) }
  function onListChange(c: ListCfg) { setListCfg(c); onChange(JSON.stringify({ ...listToRaw(c), ...(compactStyle !== 'default' ? { compact_style: compactStyle } : {}) }, null, 2)) }
  function onCQChange(c: CQCfg) { setCqCfg(c); onChange(JSON.stringify({ ...cqToRaw(c), ...(compactStyle !== 'default' ? { compact_style: compactStyle } : {}) }, null, 2)) }
  function onExtApiChange(c: ExtApiCfg) { setExtApiCfg(c); onChange(JSON.stringify({ ...extApiToRaw(c), ...(compactStyle !== 'default' ? { compact_style: compactStyle } : {}) }, null, 2)) }
  function onBtnsChange(c: BtnsCfg) { setBtnsCfg(c); onChange(JSON.stringify({ ...btnsToRaw(c), ...(compactStyle !== 'default' ? { compact_style: compactStyle } : {}) }, null, 2)) }

  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between'>
        <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>Config</Label>
        <Button
          size='sm'
          variant='ghost'
          className='h-6 gap-1 px-2 text-[11px] text-muted-foreground'
          onClick={rawMode ? switchToForm : switchToRaw}
        >
          <Code2 className='h-3 w-3' />
          {rawMode ? 'Form view' : 'Raw JSON'}
        </Button>
      </div>

      {rawMode ? (
        <div className='space-y-1.5'>
          <Textarea
            className='font-mono text-[12px]'
            rows={10}
            value={rawText}
            onChange={(e) => { setRawText(e.target.value); onChange(e.target.value) }}
            spellCheck={false}
          />
          {parseError && <p className='text-[11px] text-destructive'>{parseError}</p>}
        </div>
      ) : (
        <div className='space-y-3'>
          {(type === 'stat' || type === 'custom-query') && (
            <div className='space-y-1.5'>
              <Label className='text-[11px] text-muted-foreground'>Header display style</Label>
              <div className='flex gap-2'>
                {[
                  { value: 'default', label: 'Default', preview: 'plain value in header bar' },
                  { value: 'pill-light', label: 'Inline chip', preview: 'compact chip, light header' },
                  { value: 'pill-dark', label: 'Inline chip (dark)', preview: 'compact chip, dark context' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type='button'
                    title={opt.preview}
                    onClick={() => onStyleChange(opt.value)}
                    className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                      compactStyle === opt.value
                        ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {opt.value === 'pill-light' && (
                      <span className='inline-flex flex-col justify-center rounded border border-slate-200 bg-white px-1.5 py-0.5 leading-none'>
                        <span className='text-[7px] font-medium uppercase tracking-wider text-slate-400 leading-none'>LABEL</span>
                        <span className='text-[9px] font-semibold text-slate-900 leading-none'>123</span>
                      </span>
                    )}
                    {opt.value === 'pill-dark' && (
                      <span className='inline-flex flex-col justify-center rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 leading-none'>
                        <span className='text-[7px] font-medium uppercase tracking-wider text-slate-500 leading-none'>LABEL</span>
                        <span className='text-[9px] font-semibold text-slate-100 leading-none'>123</span>
                      </span>
                    )}
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className='rounded-md border border-slate-200 bg-slate-50/50 p-4 dark:border-border dark:bg-muted/10'>
            {type === 'stat' && <StatConfigForm cfg={statCfg} onChange={onStatChange} />}
            {type === 'list' && <ListConfigForm cfg={listCfg} onChange={onListChange} />}
            {type === 'custom-query' && <CQConfigForm cfg={cqCfg} onChange={onCQChange} />}
            {type === 'external-api' && <ExtApiConfigForm cfg={extApiCfg} onChange={onExtApiChange} />}
            {type === 'action-buttons' && <ActionButtonsConfigForm cfg={btnsCfg} onChange={onBtnsChange} />}
          </div>
        </div>
      )}
    </div>
  )
}

function InternalWidgetForm({
  widget,
  onSaved,
  onCancel
}: {
  widget: InternalWidget | null
  onSaved: (w: InternalWidget) => void
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<InternalWidgetFormData>(
    widget ? widgetToForm(widget) : INTERNAL_WIDGET_DEFAULTS
  )
  const [configError, setConfigError] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on widget change
  useEffect(() => {
    setForm(widget ? widgetToForm(widget) : INTERNAL_WIDGET_DEFAULTS)
    setConfigError(null)
  }, [widget?.id])

  function set<K extends keyof InternalWidgetFormData>(key: K, value: InternalWidgetFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      let config: unknown = {}
      try {
        config = JSON.parse(form.config || '{}')
        setConfigError(null)
      } catch {
        setConfigError('Invalid JSON in config')
        throw new Error('Invalid JSON in config')
      }
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        icon: form.icon.trim() || null,
        widget_type: form.widget_type,
        config,
        is_active: form.is_active
      }
      const res = widget
        ? await api.patch<{ data: InternalWidget }>(`/widgets-internal/${widget.id}`, body)
        : await api.post<{ data: InternalWidget }>('/widgets-internal', body)
      return res.data.data
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['internal-widgets'] })
      toast.success(widget ? 'Widget updated' : 'Widget created')
      onSaved(saved)
    },
    onError: (err: Error) => {
      if (err.message !== 'Invalid JSON in config') {
        toast.error('Failed to save widget')
      }
    }
  })

  const isValid = form.name.trim() !== '' && form.widget_type !== ('' as InternalWidget['widget_type'])

  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-4'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>Name</Label>
          <Input
            className='h-8 text-[13px]'
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder='e.g. Open tickets count'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>Type</Label>
          <PickCombobox
            value={form.widget_type}
            onChange={(v) => set('widget_type', v as InternalWidget['widget_type'])}
            options={WIDGET_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            placeholder='Select type…'
          />
        </div>
      </div>

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500 dark:text-muted-foreground'>Description</Label>
        <Input
          className='h-8 text-[13px]'
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder='Optional description'
        />
      </div>

      <WidgetConfigEditor
        key={`${widget?.id ?? 'new'}-${form.widget_type}`}
        type={form.widget_type}
        config={form.config}
        onChange={(json) => set('config', json)}
      />
      {configError && (
        <p className='text-[11px] text-destructive'>{configError}</p>
      )}

      <div className='flex items-center gap-2'>
        <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} />
        <span className='text-[13px]'>Active</span>
      </div>

      <div className='flex items-center gap-2 pt-1'>
        <Button size='sm' disabled={!isValid || saveMut.isPending} onClick={() => saveMut.mutate()}>
          <Save className='mr-1.5 h-3.5 w-3.5' />
          {saveMut.isPending ? 'Saving…' : widget ? 'Save changes' : 'Create widget'}
        </Button>
        {onCancel && (
          <Button size='sm' variant='ghost' onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

function InternalWidgetDetail({
  widget,
  onDeleted
}: {
  widget: InternalWidget
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/widgets-internal/${widget.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['internal-widgets'] })
      toast.success('Widget deleted')
      onDeleted()
    },
    onError: () => toast.error('Failed to delete widget')
  })

  return (
    <div className='mx-auto w-full max-w-3xl space-y-6 p-6'>
      <div className='flex items-start justify-between gap-4'>
        <div>
          <h2 className='text-[15px] font-semibold'>{widget.name}</h2>
          <p className='font-mono text-[12px] text-slate-400 dark:text-muted-foreground'>
            {widget.widget_type} · created {formatDate(widget.created_at)}
          </p>
        </div>
        {confirmDelete ? (
          <div className='flex shrink-0 items-center gap-1'>
            <Button
              size='sm'
              variant='destructive'
              className='h-8 text-[12px]'
              disabled={deleteMut.isPending}
              onClick={() => deleteMut.mutate()}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Confirm delete'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-8 text-[12px]'
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size='sm'
            variant='outline'
            className='h-8 shrink-0 text-[12px] text-destructive hover:text-destructive'
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className='mr-1.5 h-3 w-3' />
            Delete
          </Button>
        )}
      </div>

      <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <InternalWidgetForm widget={widget} onSaved={() => undefined} />
      </div>
    </div>
  )
}

function InternalWidgetsTab() {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const { data: widgets = [], isLoading } = useQuery<InternalWidget[]>({
    queryKey: ['internal-widgets'],
    queryFn: () =>
      api.get<{ data: InternalWidget[] }>('/widgets-internal').then((r) => r.data.data)
  })

  const selected = widgets.find((w) => w.id === selectedId) ?? null

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      {/* Left: widget list */}
      <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='border-b border-slate-100 p-3 dark:border-border'>
          <Button
            size='sm'
            className='w-full'
            onClick={() => {
              setCreating(true)
              setSelectedId(null)
            }}
          >
            <Plus className='mr-1.5 h-3.5 w-3.5' />
            New Widget
          </Button>
        </div>
        {isLoading ? (
          <div className='space-y-2 p-4'>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-12 w-full' />
            ))}
          </div>
        ) : widgets.length === 0 ? (
          <p className='p-4 text-[12px] text-slate-400 dark:text-muted-foreground'>
            No internal widgets yet.
          </p>
        ) : (
          <ul className='divide-y divide-slate-100 dark:divide-border'>
            {widgets.map((w) => {
              const isSelected = w.id === selectedId && !creating
              return (
                <li key={w.id}>
                  <button
                    type='button'
                    onClick={() => {
                      setSelectedId(w.id)
                      setCreating(false)
                    }}
                    className={cn(
                      'block w-full px-4 py-3 text-left transition-colors',
                      isSelected
                        ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/[0.07]'
                        : 'hover:bg-slate-50 dark:hover:bg-muted/50'
                    )}
                  >
                    <div className='mb-0.5 flex items-center gap-2'>
                      <span
                        className={cn(
                          'flex-1 truncate text-[13px] font-medium',
                          isSelected
                            ? 'text-nvr-navy dark:text-nvr-cyan'
                            : 'text-slate-700 dark:text-slate-300'
                        )}
                      >
                        {w.name}
                      </span>
                      {w.is_active ? (
                        <Badge className='shrink-0 text-[10px]'>Active</Badge>
                      ) : (
                        <Badge
                          variant='outline'
                          className='shrink-0 text-[10px] text-muted-foreground'
                        >
                          Inactive
                        </Badge>
                      )}
                    </div>
                    <p className='truncate font-mono text-[11px] text-slate-400 dark:text-muted-foreground'>
                      {w.widget_type}
                    </p>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </aside>

      {/* Right: detail */}
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        {creating ? (
          <div className='mx-auto w-full max-w-3xl space-y-4 p-6'>
            <h2 className='text-[15px] font-semibold'>New internal widget</h2>
            <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
              <InternalWidgetForm
                widget={null}
                onSaved={(saved) => {
                  setCreating(false)
                  setSelectedId(saved.id)
                }}
                onCancel={() => setCreating(false)}
              />
            </div>
          </div>
        ) : selected ? (
          <InternalWidgetDetail widget={selected} onDeleted={() => setSelectedId(null)} />
        ) : (
          <div className='flex h-full flex-col items-center justify-center py-24 text-center'>
            <Puzzle className='mb-3 h-10 w-10 text-slate-300 dark:text-muted-foreground' />
            <p className='mb-1 text-sm font-medium'>No widget selected</p>
            <p className='mb-4 text-xs text-slate-400 dark:text-muted-foreground'>
              Select a widget on the left or create a new one.
            </p>
            <Button size='sm' onClick={() => setCreating(true)}>
              <Plus className='mr-1.5 h-3.5 w-3.5' />
              New Widget
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Embed Feeds Tab (existing content, extracted) ────────────────────────────

function EmbedFeedsTab() {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const { data: feeds = [], isLoading } = useQuery<WidgetFeed[]>({
    queryKey: ['widget-feeds'],
    queryFn: () => api.get<{ data: WidgetFeed[] }>('/widget').then((r) => r.data.data)
  })

  const selected = feeds.find((f) => f.id === selectedId) ?? null

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      {/* Left: feed list */}
      <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='border-b border-slate-100 p-3 dark:border-border'>
          <Button
            size='sm'
            className='w-full'
            onClick={() => {
              setCreating(true)
              setSelectedId(null)
            }}
          >
            <Plus className='mr-1.5 h-3.5 w-3.5' />
            New Feed
          </Button>
        </div>
        {isLoading ? (
          <div className='space-y-2 p-4'>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-12 w-full' />
            ))}
          </div>
        ) : feeds.length === 0 ? (
          <p className='p-4 text-[12px] text-slate-400 dark:text-muted-foreground'>
            No widget feeds yet.
          </p>
        ) : (
          <ul className='divide-y divide-slate-100 dark:divide-border'>
            {feeds.map((feed) => {
              const isSelected = feed.id === selectedId && !creating
              return (
                <li key={feed.id}>
                  <button
                    type='button'
                    onClick={() => {
                      setSelectedId(feed.id)
                      setCreating(false)
                    }}
                    className={cn(
                      'block w-full px-4 py-3 text-left transition-colors',
                      isSelected
                        ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/[0.07]'
                        : 'hover:bg-slate-50 dark:hover:bg-muted/50'
                    )}
                  >
                    <div className='mb-0.5 flex items-center gap-2'>
                      <span
                        className={cn(
                          'flex-1 truncate text-[13px] font-medium',
                          isSelected
                            ? 'text-nvr-navy dark:text-nvr-cyan'
                            : 'text-slate-700 dark:text-slate-300'
                        )}
                      >
                        {feed.name}
                      </span>
                      {feed.is_active ? (
                        <Badge className='shrink-0 text-[10px]'>Active</Badge>
                      ) : (
                        <Badge
                          variant='outline'
                          className='shrink-0 text-[10px] text-muted-foreground'
                        >
                          Inactive
                        </Badge>
                      )}
                    </div>
                    <p className='truncate font-mono text-[11px] text-slate-400 dark:text-muted-foreground'>
                      {feed.collection}
                    </p>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </aside>

      {/* Right: detail */}
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        {creating ? (
          <div className='mx-auto w-full max-w-3xl space-y-4 p-6'>
            <h2 className='text-[15px] font-semibold'>New widget feed</h2>
            <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
              <FeedForm
                feed={null}
                onSaved={(saved) => {
                  setCreating(false)
                  setSelectedId(saved.id)
                }}
                onCancel={() => setCreating(false)}
              />
            </div>
          </div>
        ) : selected ? (
          <FeedDetail feed={selected} onDeleted={() => setSelectedId(null)} />
        ) : (
          <div className='flex h-full flex-col items-center justify-center py-24 text-center'>
            <LayoutPanelTop className='mb-3 h-10 w-10 text-slate-300 dark:text-muted-foreground' />
            <p className='mb-1 text-sm font-medium'>No feed selected</p>
            <p className='mb-4 text-xs text-slate-400 dark:text-muted-foreground'>
              Select a feed on the left or create a new one to get its embed snippet.
            </p>
            <Button size='sm' onClick={() => setCreating(true)}>
              <Plus className='mr-1.5 h-3.5 w-3.5' />
              New Feed
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type WidgetsTab = 'internal' | 'embed-feeds'

export function WidgetsPage() {
  const [activeTab, setActiveTab] = useState<WidgetsTab>('internal')

  const tabs: { id: WidgetsTab; label: string; icon: typeof Puzzle }[] = [
    { id: 'internal', label: 'Internal Widgets', icon: Puzzle },
    { id: 'embed-feeds', label: 'Embed Feeds', icon: LayoutPanelTop }
  ]

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <header className='shrink-0 border-b border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between px-6 py-3.5'>
          <div className='flex items-center gap-2.5'>
            <LayoutPanelTop className='h-5 w-5 text-slate-400 dark:text-muted-foreground' />
            <div>
              <h1 className='text-[15px] font-semibold leading-tight'>Widgets</h1>
              <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                Internal data widgets and embeddable feed snippets
              </p>
            </div>
          </div>
        </div>
        {/* Tab bar */}
        <div className='flex gap-0 border-t border-slate-100 dark:border-border'>
          {tabs.map((tab) => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type='button'
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-[13px] font-medium transition-colors',
                  isActive
                    ? 'border-nvr-cyan text-nvr-navy dark:text-nvr-cyan'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-muted-foreground dark:hover:text-slate-300'
                )}
              >
                <Icon className='h-3.5 w-3.5' />
                {tab.label}
              </button>
            )
          })}
        </div>
      </header>

      {activeTab === 'internal' ? <InternalWidgetsTab /> : <EmbedFeedsTab />}
    </div>
  )
}

export default WidgetsPage
