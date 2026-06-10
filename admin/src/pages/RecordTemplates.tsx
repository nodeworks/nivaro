import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, ChevronsUpDown, FileText, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecordTemplate {
  id: number
  collection: string
  name: string
  description: string | null
  data: Record<string, unknown>
  role_id: string | null
  is_shared: boolean
  created_by: string | null
  created_at: string
  role_name?: string | null
}

interface Collection {
  collection: string
  display_name: string | null
}

interface Role {
  id: string
  name: string
}

interface FormData {
  name: string
  description: string
  collection: string
  is_shared: boolean
  role_id: string
  data: string
}

const FORM_DEFAULTS: FormData = {
  name: '',
  description: '',
  collection: '',
  is_shared: false,
  role_id: '',
  data: '{\n  \n}'
}

// ─── Combobox ─────────────────────────────────────────────────────────────────

function FieldCombobox({
  value,
  onChange,
  options,
  placeholder,
  emptyText = 'No results.',
  disabled
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder: string
  emptyText?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const label = options.find((o) => o.value === value)?.label ?? value
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className='w-full justify-between font-normal'
        >
          <span className='truncate'>{value ? label : placeholder}</span>
          <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  onSelect={(v) => {
                    onChange(v === value ? '' : v)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn('mr-2 h-4 w-4', value === o.value ? 'opacity-100' : 'opacity-0')}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Form ─────────────────────────────────────────────────────────────────────

function TemplateForm({
  initial,
  collections,
  roles,
  onSave,
  onCancel,
  saving,
  title
}: {
  initial?: FormData
  collections: Collection[]
  roles: Role[]
  onSave: (d: FormData) => void
  onCancel: () => void
  saving: boolean
  title: string
}) {
  const [form, setForm] = useState<FormData>(initial ?? FORM_DEFAULTS)

  function set<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const collectionOptions = collections.map((c) => ({
    value: c.collection,
    label: c.display_name ?? c.collection
  }))

  const roleOptions = [
    { value: '__none__', label: 'None (all roles)' },
    ...roles.map((r) => ({ value: r.id, label: r.name }))
  ]

  let dataValid = true
  try {
    JSON.parse(form.data)
  } catch {
    dataValid = false
  }

  const isValid = form.name.trim() !== '' && form.collection !== '' && dataValid

  return (
    <div className='flex flex-col h-full'>
      <div className='shrink-0 border-b border-border px-6 py-4'>
        <h2 className='text-[15px] font-semibold'>{title}</h2>
      </div>
      <div className='flex-1 overflow-y-auto px-6 py-5 space-y-4'>
        <div className='space-y-1.5'>
          <Label>Name</Label>
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder='e.g. Default Article'
          />
        </div>

        <div className='space-y-1.5'>
          <Label>Collection</Label>
          <FieldCombobox
            value={form.collection}
            onChange={(v) => set('collection', v)}
            options={collectionOptions}
            placeholder='Select collection…'
          />
        </div>

        <div className='space-y-1.5'>
          <Label>Description (optional)</Label>
          <Textarea
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder='Briefly describe this template…'
            rows={2}
          />
        </div>

        <div className='space-y-1.5'>
          <Label>Restrict to Role (optional)</Label>
          <FieldCombobox
            value={form.role_id || '__none__'}
            onChange={(v) => set('role_id', v === '__none__' ? '' : v)}
            options={roleOptions}
            placeholder='All roles'
          />
          <p className='text-[11px] text-muted-foreground'>
            Leave empty to make available to all roles.
          </p>
        </div>

        <div className='flex items-center gap-2.5'>
          <Checkbox
            id='is_shared'
            checked={form.is_shared}
            onCheckedChange={(v) => set('is_shared', !!v)}
          />
          <Label htmlFor='is_shared' className='cursor-pointer font-normal'>
            Shared (visible to all users)
          </Label>
        </div>

        <div className='space-y-1.5'>
          <Label>Field Values (JSON)</Label>
          <Textarea
            value={form.data}
            onChange={(e) => set('data', e.target.value)}
            placeholder='{"field": "value"}'
            rows={8}
            className={cn(
              'font-mono text-[13px]',
              !dataValid &&
                form.data.trim() !== '' &&
                'border-destructive focus-visible:ring-destructive'
            )}
          />
          {!dataValid && form.data.trim() !== '' && (
            <p className='text-[11px] text-destructive'>Invalid JSON</p>
          )}
        </div>
      </div>
      <div className='shrink-0 border-t border-border px-6 py-4 flex items-center justify-end gap-2'>
        <Button variant='outline' onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => onSave(form)} disabled={saving || !isValid}>
          {saving ? 'Saving…' : 'Save Template'}
        </Button>
      </div>
    </div>
  )
}

// ─── Delete confirm ───────────────────────────────────────────────────────────

function DeleteConfirm({
  template,
  onConfirm,
  onCancel,
  deleting
}: {
  template: RecordTemplate
  onConfirm: () => void
  onCancel: () => void
  deleting: boolean
}) {
  return (
    <div className='flex flex-col h-full'>
      <div className='shrink-0 border-b border-border px-6 py-4'>
        <h2 className='text-[15px] font-semibold'>Delete Template</h2>
      </div>
      <div className='flex-1 px-6 py-5'>
        <p className='text-sm text-muted-foreground'>
          Are you sure you want to delete{' '}
          <span className='font-medium text-foreground'>{template.name}</span>? This cannot be
          undone.
        </p>
      </div>
      <div className='shrink-0 border-t border-border px-6 py-4 flex items-center justify-end gap-2'>
        <Button variant='outline' onClick={onCancel} disabled={deleting}>
          Cancel
        </Button>
        <Button variant='destructive' onClick={onConfirm} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecordTemplatesPage() {
  const qc = useQueryClient()
  const [selectedCollection, setSelectedCollection] = useState('')
  const [collectionOpen, setCollectionOpen] = useState(false)
  const [panel, setPanel] = useState<
    | { type: 'create' }
    | { type: 'edit'; template: RecordTemplate }
    | { type: 'delete'; template: RecordTemplate }
    | null
  >(null)

  const { data: collections = [] } = useQuery<Collection[]>({
    queryKey: ['collections-list'],
    queryFn: () => api.get<{ data: Collection[] }>('/collections').then((r) => r.data.data)
  })

  const { data: roles = [] } = useQuery<Role[]>({
    queryKey: ['roles-list'],
    queryFn: () => api.get<{ data: Role[] }>('/roles').then((r) => r.data.data)
  })

  const { data: templates = [], isLoading } = useQuery<RecordTemplate[]>({
    queryKey: ['record-templates', selectedCollection],
    queryFn: () =>
      api
        .get<{ data: RecordTemplate[] }>('/record-templates', {
          params: selectedCollection ? { collection: selectedCollection } : {}
        })
        .then((r) => r.data.data)
  })

  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/record-templates', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['record-templates'] })
      setPanel(null)
      toast.success('Template created')
    },
    onError: () => toast.error('Failed to create template')
  })

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/record-templates/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['record-templates'] })
      setPanel(null)
      toast.success('Template updated')
    },
    onError: () => toast.error('Failed to update template')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/record-templates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['record-templates'] })
      setPanel(null)
      toast.success('Template deleted')
    },
    onError: () => toast.error('Failed to delete template')
  })

  function formToPayload(form: FormData) {
    let parsedData: Record<string, unknown> = {}
    try {
      parsedData = JSON.parse(form.data)
    } catch {
      /* already validated */
    }
    return {
      name: form.name,
      description: form.description || null,
      collection: form.collection,
      is_shared: form.is_shared,
      role_id: form.role_id && form.role_id !== '__none__' ? form.role_id : null,
      data: parsedData
    }
  }

  function templateToForm(t: RecordTemplate): FormData {
    return {
      name: t.name,
      description: t.description ?? '',
      collection: t.collection,
      is_shared: t.is_shared,
      role_id: t.role_id != null ? String(t.role_id) : '',
      data: JSON.stringify(t.data, null, 2)
    }
  }

  const collectionOptions = [
    { value: '', label: 'All Collections' },
    ...collections.map((c) => ({
      value: c.collection,
      label: c.display_name ?? c.collection
    }))
  ]

  // Group templates by collection
  const grouped = templates.reduce<Record<string, RecordTemplate[]>>((acc, t) => {
    if (!acc[t.collection]) acc[t.collection] = []
    acc[t.collection].push(t)
    return acc
  }, {})

  const showPanel = panel !== null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <header className='shrink-0 border-b border-border px-6 py-4 flex items-center justify-between'>
        <div className='flex items-center gap-2.5'>
          <FileText className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Record Templates</h1>
        </div>
        <Button size='sm' onClick={() => setPanel({ type: 'create' })}>
          <Plus className='h-4 w-4 mr-1.5' />
          New Template
        </Button>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left panel */}
        <aside className='w-[272px] shrink-0 border-r border-border flex flex-col'>
          {/* Collection filter */}
          <div className='shrink-0 px-3 py-3 border-b border-border'>
            <Popover open={collectionOpen} onOpenChange={setCollectionOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant='outline'
                  role='combobox'
                  className='w-full justify-between font-normal text-[13px] h-8'
                >
                  <span className='truncate'>
                    {selectedCollection
                      ? (collections.find((c) => c.collection === selectedCollection)
                          ?.display_name ?? selectedCollection)
                      : 'All Collections'}
                  </span>
                  <ChevronsUpDown className='ml-2 h-3.5 w-3.5 shrink-0 opacity-50' />
                </Button>
              </PopoverTrigger>
              <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Filter collection…' />
                  <CommandList>
                    <CommandEmpty>No collections found.</CommandEmpty>
                    <CommandGroup>
                      {collectionOptions.map((o) => (
                        <CommandItem
                          key={o.value}
                          value={o.value || '__all__'}
                          onSelect={(v) => {
                            setSelectedCollection(v === '__all__' ? '' : v)
                            setCollectionOpen(false)
                          }}
                        >
                          <Check
                            className={cn(
                              'mr-2 h-4 w-4',
                              selectedCollection === o.value ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          {o.label}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {/* Template list */}
          <div className='flex-1 overflow-y-auto'>
            {isLoading ? (
              <div className='space-y-2 p-3'>
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className='h-12 w-full rounded-lg' />
                ))}
              </div>
            ) : templates.length === 0 ? (
              <div className='flex flex-col items-center justify-center py-16 px-4 text-center'>
                <FileText className='h-8 w-8 text-muted-foreground/40 mb-2' />
                <p className='text-[13px] text-muted-foreground'>No templates yet.</p>
                <p className='text-[11px] text-muted-foreground mt-1'>
                  Create one to pre-fill new items.
                </p>
              </div>
            ) : (
              Object.entries(grouped).map(([col, items]) => (
                <div key={col}>
                  <div className='px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-slate-50 dark:bg-muted/30 border-b border-border'>
                    {collections.find((c) => c.collection === col)?.display_name ?? col}
                  </div>
                  {items.map((t) => {
                    const isSelected =
                      (panel?.type === 'edit' || panel?.type === 'delete') &&
                      panel.template.id === t.id
                    return (
                      <button
                        key={t.id}
                        type='button'
                        onClick={() => setPanel({ type: 'edit', template: t })}
                        className={cn(
                          'w-full px-4 py-3 text-left flex items-center gap-2 transition-colors border-b border-border/50',
                          isSelected
                            ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/[0.07]'
                            : 'hover:bg-slate-50 dark:hover:bg-muted/50'
                        )}
                      >
                        <div className='flex-1 min-w-0'>
                          <p
                            className={cn(
                              'text-[13px] font-medium truncate',
                              isSelected
                                ? 'text-nvr-navy dark:text-nvr-cyan'
                                : 'text-slate-700 dark:text-slate-300'
                            )}
                          >
                            {t.name}
                          </p>
                          {t.description && (
                            <p className='text-[11px] text-muted-foreground truncate mt-0.5'>
                              {t.description}
                            </p>
                          )}
                        </div>
                        {t.is_shared && (
                          <Badge
                            variant='outline'
                            className='text-[10px] shrink-0 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan border-nvr-cyan/20'
                          >
                            Shared
                          </Badge>
                        )}
                        <ChevronRight className='h-3.5 w-3.5 text-muted-foreground/50 shrink-0' />
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Right panel */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {!showPanel ? (
            <div className='flex flex-col items-center justify-center h-full text-center px-8'>
              <FileText className='h-12 w-12 text-muted-foreground/30 mb-3' />
              <p className='text-sm font-medium text-muted-foreground mb-1'>No template selected</p>
              <p className='text-[13px] text-muted-foreground/70 mb-4'>
                Select a template from the list or create a new one.
              </p>
              <Button size='sm' onClick={() => setPanel({ type: 'create' })}>
                <Plus className='h-4 w-4 mr-1.5' />
                New Template
              </Button>
            </div>
          ) : panel.type === 'create' ? (
            <div className='h-full bg-background'>
              <TemplateForm
                collections={collections}
                roles={roles}
                onSave={(form) => createMut.mutate(formToPayload(form))}
                onCancel={() => setPanel(null)}
                saving={createMut.isPending}
                title='New Template'
              />
            </div>
          ) : panel.type === 'edit' ? (
            <div className='h-full bg-background flex flex-col'>
              <TemplateForm
                initial={templateToForm(panel.template)}
                collections={collections}
                roles={roles}
                onSave={(form) =>
                  updateMut.mutate({ id: panel.template.id, body: formToPayload(form) })
                }
                onCancel={() => setPanel(null)}
                saving={updateMut.isPending}
                title='Edit Template'
              />
              {/* Delete section at the bottom of the form panel header area */}
              <div className='shrink-0 border-t border-border px-6 py-3 bg-slate-50 dark:bg-muted/30 flex items-center justify-between'>
                <p className='text-[12px] text-muted-foreground'>Danger zone</p>
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-destructive hover:text-destructive gap-1.5 text-[12px]'
                  onClick={() => setPanel({ type: 'delete', template: panel.template })}
                >
                  <Trash2 className='h-3.5 w-3.5' />
                  Delete Template
                </Button>
              </div>
            </div>
          ) : panel.type === 'delete' ? (
            <div className='h-full bg-background'>
              <DeleteConfirm
                template={panel.template}
                onConfirm={() => deleteMut.mutate(panel.template.id)}
                onCancel={() => setPanel({ type: 'edit', template: panel.template })}
                deleting={deleteMut.isPending}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
