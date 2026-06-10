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
  X
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export function WidgetsPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const { data: feeds = [], isLoading } = useQuery<WidgetFeed[]>({
    queryKey: ['widget-feeds'],
    queryFn: () => api.get<{ data: WidgetFeed[] }>('/widget').then((r) => r.data.data)
  })

  const selected = feeds.find((f) => f.id === selectedId) ?? null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <header className='flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 py-3.5 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <LayoutPanelTop className='h-5 w-5 text-slate-400 dark:text-muted-foreground' />
          <div>
            <h1 className='text-[15px] font-semibold leading-tight'>Widgets</h1>
            <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
              Embeddable list feeds and forms for external sites
            </p>
          </div>
        </div>
        <Button
          size='sm'
          onClick={() => {
            setCreating(true)
            setSelectedId(null)
          }}
        >
          <Plus className='mr-1.5 h-3.5 w-3.5' />
          New Feed
        </Button>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left: feed list */}
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
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
    </div>
  )
}

export default WidgetsPage
