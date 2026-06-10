import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, FileText, Play, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
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
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

interface PdfTemplate {
  id: string
  name: string
  collection: string | null
  template: string
  created_by: string | null
  created_at: string
  updated_at: string | null
}

const DEFAULT_TEMPLATE = `<h1>{{ collection }} — {{ item.id }}</h1>
<p>Generated {{ generated_at }}</p>
<hr>
<h2>Details</h2>
<table>
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td>ID</td><td>{{ item.id }}</td></tr>
</table>`

// ─── Collection combobox (shadcn Popover + Command) ─────────────────────────

function CollectionCombobox({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || 'Any collection'}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value='__any__'
                onSelect={() => {
                  onChange('')
                  setOpen(false)
                }}
                className='text-[12px]'
              >
                <Check className={cn('mr-2 h-3 w-3', !value ? 'opacity-100' : 'opacity-0')} />
                Any collection
              </CommandItem>
              {options.map((col) => (
                <CommandItem
                  key={col}
                  value={col}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === col ? 'opacity-100' : 'opacity-0')}
                  />
                  {col}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Editor panel ────────────────────────────────────────────────────────────

function TemplateEditor({
  template,
  collections,
  onSaved,
  onDeleted
}: {
  template: PdfTemplate | null // null = create mode
  collections: string[]
  onSaved: (t: PdfTemplate) => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(template?.name ?? '')
  const [collection, setCollection] = useState(template?.collection ?? '')
  const [body, setBody] = useState(template?.template ?? DEFAULT_TEMPLATE)
  const [testItemId, setTestItemId] = useState('')
  const [testCollection, setTestCollection] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset form when switching templates
  useEffect(() => {
    setName(template?.name ?? '')
    setCollection(template?.collection ?? '')
    setBody(template?.template ?? DEFAULT_TEMPLATE)
    setTestItemId('')
    setTestCollection('')
    setConfirmingDelete(false)
  }, [template?.id])

  const save = useMutation({
    mutationFn: async () => {
      const payload = { name, collection: collection || null, template: body }
      if (template) {
        const r = await api.patch<{ data: PdfTemplate }>(`/pdf-templates/${template.id}`, payload)
        return r.data.data
      }
      const r = await api.post<{ data: PdfTemplate }>('/pdf-templates', payload)
      return r.data.data
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['pdf-templates'] })
      toast.success(template ? 'Template saved' : 'Template created')
      onSaved(saved)
    },
    onError: () => toast.error('Save failed')
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/pdf-templates/${template?.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pdf-templates'] })
      toast.success('Template deleted')
      onDeleted()
    },
    onError: () => toast.error('Delete failed')
  })

  const render = useMutation({
    mutationFn: async () => {
      const r = await api.post(
        `/pdf-templates/${template?.id}/render`,
        { collection: collection || testCollection, item_id: testItemId },
        { responseType: 'blob' }
      )
      return r.data as Blob
    },
    onSuccess: (blob) => {
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    onError: () => toast.error('Render failed — check the item id and template')
  })

  const isValid = name.trim() !== '' && body.trim() !== ''

  return (
    <div className='mx-auto w-full max-w-3xl space-y-5 p-8'>
      <div className='grid grid-cols-2 gap-4'>
        <div className='space-y-1.5'>
          <Label htmlFor='pdf-name'>Name</Label>
          <Input
            id='pdf-name'
            className='h-8 text-[13px]'
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='e.g. Order Confirmation'
          />
        </div>
        <div className='space-y-1.5'>
          <Label>Collection</Label>
          <CollectionCombobox value={collection} onChange={setCollection} options={collections} />
          <p className='text-[11px] text-muted-foreground'>
            Bind to a collection, or leave as &quot;Any&quot; for a generic template.
          </p>
        </div>
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='pdf-template'>Liquid Template</Label>
        <Textarea
          id='pdf-template'
          className='min-h-[360px] font-mono text-[12px] leading-relaxed'
          value={body}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
        />
        <p className='text-[11px] text-muted-foreground'>
          Liquid with item fields in context (also <code>item</code>, <code>collection</code>,{' '}
          <code>generated_at</code>). Supported tags: h1–h3, p, table/tr/td, hr, strong, br.
        </p>
      </div>

      {/* Test render */}
      {template && (
        <div className='space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-border dark:bg-muted/30'>
          <p className='text-[12px] font-medium text-slate-700 dark:text-slate-300'>Test render</p>
          <div className='flex items-end gap-2'>
            {!collection && (
              <div className='w-56 space-y-1'>
                <Label className='text-[11px]'>Collection</Label>
                <CollectionCombobox
                  value={testCollection}
                  onChange={setTestCollection}
                  options={collections}
                />
              </div>
            )}
            <div className='w-56 space-y-1'>
              <Label htmlFor='pdf-test-item' className='text-[11px]'>
                Item ID
              </Label>
              <Input
                id='pdf-test-item'
                className='h-8 font-mono text-[12px]'
                value={testItemId}
                onChange={(e) => setTestItemId(e.target.value)}
                placeholder='item id'
              />
            </div>
            <Button
              size='sm'
              variant='outline'
              disabled={!testItemId || (!collection && !testCollection) || render.isPending}
              onClick={() => render.mutate()}
            >
              <Play className='mr-1.5 h-3.5 w-3.5' />
              {render.isPending ? 'Rendering…' : 'Render'}
            </Button>
          </div>
          <p className='text-[11px] text-muted-foreground'>
            Renders the saved template against a real item and opens the PDF in a new tab.
          </p>
        </div>
      )}

      <div className='flex items-center justify-between border-t border-slate-200 pt-4 dark:border-border'>
        <div>
          {template &&
            (confirmingDelete ? (
              <div className='flex items-center gap-2'>
                <span className='text-[12px] text-slate-500'>Delete this template?</span>
                <Button
                  size='sm'
                  variant='destructive'
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                >
                  Delete
                </Button>
                <Button size='sm' variant='outline' onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size='sm'
                variant='ghost'
                className='text-red-500 hover:bg-red-50 hover:text-red-600'
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className='mr-1.5 h-3.5 w-3.5' />
                Delete
              </Button>
            ))}
        </div>
        <Button size='sm' disabled={!isValid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : template ? 'Save changes' : 'Create template'}
        </Button>
      </div>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function PdfTemplatesPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['pdf-templates'],
    queryFn: () => api.get<{ data: PdfTemplate[] }>('/pdf-templates').then((r) => r.data.data)
  })

  const { data: collections = [] } = useQuery({
    queryKey: ['collections'],
    queryFn: () =>
      api
        .get<{ data: { collection: string }[] }>('/collections')
        .then((r) => r.data.data.map((c) => c.collection))
  })

  const selected = creating ? null : (templates.find((t) => t.id === selectedId) ?? null)

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-background'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              PDF Templates
            </h1>
            <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
              {templates.length}
            </span>
          </div>
          <Button
            size='sm'
            onClick={() => {
              setCreating(true)
              setSelectedId(null)
            }}
          >
            <Plus className='mr-1.5 h-3.5 w-3.5' />
            New Template
          </Button>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left list */}
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-background'>
          {isLoading ? (
            <p className='px-4 py-6 text-[12px] text-slate-400'>Loading…</p>
          ) : templates.length === 0 && !creating ? (
            <div className='px-4 py-10 text-center'>
              <FileText className='mx-auto mb-2 h-6 w-6 text-slate-300' />
              <p className='text-[12px] text-slate-400'>No templates yet</p>
            </div>
          ) : (
            <ul className='divide-y divide-slate-100 dark:divide-border'>
              {templates.map((t) => {
                const active = !creating && t.id === selectedId
                return (
                  <li key={t.id}>
                    <button
                      type='button'
                      onClick={() => {
                        setCreating(false)
                        setSelectedId(t.id)
                      }}
                      className={cn(
                        'block w-full px-4 py-3 text-left transition-colors',
                        active
                          ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/[0.07]'
                          : 'hover:bg-slate-50 dark:hover:bg-muted/50'
                      )}
                    >
                      <p
                        className={cn(
                          'truncate text-[13px] font-medium',
                          active
                            ? 'text-nvr-navy dark:text-nvr-cyan'
                            : 'text-slate-700 dark:text-slate-300'
                        )}
                      >
                        {t.name}
                      </p>
                      <p className='mt-0.5 truncate font-mono text-[11px] text-slate-400 dark:text-muted-foreground'>
                        {t.collection ?? 'any collection'}
                        {' · '}
                        {formatRelative(t.updated_at ?? t.created_at)}
                      </p>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>

        {/* Right detail */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {creating || selected ? (
            <TemplateEditor
              key={creating ? '__new__' : (selected?.id ?? '')}
              template={selected}
              collections={collections}
              onSaved={(t) => {
                setCreating(false)
                setSelectedId(t.id)
              }}
              onDeleted={() => {
                setSelectedId(null)
                setCreating(false)
              }}
            />
          ) : (
            <div className='flex h-full flex-col items-center justify-center text-center'>
              <FileText className='mb-3 h-8 w-8 text-slate-300' />
              <p className='text-[13px] font-medium text-slate-500'>No template selected</p>
              <p className='mt-1 text-[12px] text-slate-400'>
                Select a template on the left or create a new one.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
