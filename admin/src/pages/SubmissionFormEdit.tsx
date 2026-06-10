import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Eye,
  FileInput,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { CollectionFieldPickerPanel, type PickedField } from '@/components/field-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, type Collection } from '@/lib/api'
import { formatDate, titleCase } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FormFieldConfig {
  label?: string
  placeholder?: string
  required?: boolean
  widget?: string
}

interface FormConfig {
  heading?: string
  description?: string
  submit_label?: string
  fields?: Record<string, FormFieldConfig>
}

interface SubmissionForm {
  id: string
  name: string
  collection: string
  fields: string[]
  form_config: FormConfig | null
  token: string
  expires_at: string | null
  rate_limit_per_hour: number
  is_active: boolean
  success_message: string | null
  created_at: string
  updated_at: string
  submission_count: number
}

interface Submission {
  id: string
  form: string
  data: Record<string, unknown>
  ip: string | null
  created_at: string
}

interface SubmissionsResponse {
  data: Submission[]
  total: number
  page: number
  limit: number
}

interface FieldEntry {
  path: string
  label: string
  fieldType: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fieldTypeLabel(type: string): string {
  const map: Record<string, string> = {
    string: 'text',
    text: 'text',
    integer: 'int',
    bigInteger: 'int',
    boolean: 'bool',
    decimal: 'dec',
    float: 'float',
    date: 'date',
    datetime: 'datetime',
    uuid: 'uuid',
    json: 'json'
  }
  return map[type] || type || ''
}

function fieldEntryFromPath(path: string): FieldEntry {
  return {
    path,
    label: path
      .split('.')
      .map((s) => titleCase(s))
      .join(' › '),
    fieldType: ''
  }
}

const WIDGET_OPTIONS: { value: string; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'tel', label: 'Phone' },
  { value: 'url', label: 'URL' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'datetime-local', label: 'Date & time' },
  { value: 'checkbox', label: 'Checkbox' }
]

function defaultWidget(path: string, fieldType: string): string {
  const l = path.toLowerCase()
  if (l.includes('email')) return 'email'
  if (l.includes('phone') || l.includes('tel') || l.includes('mobile')) return 'tel'
  if (l.includes('url') || l.includes('website') || l.includes('link')) return 'url'
  const map: Record<string, string> = {
    text: 'textarea',
    integer: 'number',
    bigInteger: 'number',
    decimal: 'number',
    float: 'number',
    boolean: 'checkbox',
    date: 'date',
    datetime: 'datetime-local'
  }
  return map[fieldType] || 'text'
}

function parseFieldsDisplay(fields: string[]): string {
  if (!fields || fields.length === 0) return '"field": "value"'
  return fields
    .slice(0, 3)
    .map((f) => `"${f}": "..."`)
    .join(',\n      ')
}

// ─── CopyButton ───────────────────────────────────────────────────────────────

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  function handleCopy() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <Button
      type='button'
      variant='outline'
      size='icon'
      className='h-8 w-8 shrink-0'
      onClick={handleCopy}
    >
      {copied ? (
        <Check className='h-3.5 w-3.5 text-emerald-500' />
      ) : (
        <Copy className='h-3.5 w-3.5' />
      )}
    </Button>
  )
}

// ─── CollectionCombobox ───────────────────────────────────────────────────────

function CollectionCombobox({
  value,
  onChange,
  collections
}: {
  value: string
  onChange: (col: string) => void
  collections: Collection[]
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const filtered = collections.filter((c) => {
    const q = search.toLowerCase()
    return (
      c.collection.toLowerCase().includes(q) || (c.display_name ?? '').toLowerCase().includes(q)
    )
  })

  const selected = collections.find((c) => c.collection === value)
  const displayLabel = selected ? selected.display_name || selected.collection : value || null

  return (
    <div className='relative' ref={containerRef}>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-[13px] transition-colors hover:border-slate-300 focus:outline-none ${
          open ? 'border-nvr-cyan/60 ring-2 ring-nvr-cyan/20' : 'border-input'
        }`}
      >
        {displayLabel ? (
          <span className='flex min-w-0 flex-1 items-center gap-2'>
            <span className='truncate text-foreground'>{displayLabel}</span>
            {selected?.display_name && (
              <code className='shrink-0 font-mono text-[11px] text-muted-foreground'>
                {selected.collection}
              </code>
            )}
            {!selected && value && (
              <code className='shrink-0 font-mono text-[11px] text-muted-foreground'>{value}</code>
            )}
          </span>
        ) : (
          <span className='flex-1 text-left text-muted-foreground'>Select collection…</span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div className='absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-[0_4px_16px_rgba(0,0,0,0.10),0_1px_4px_rgba(0,0,0,0.06)]'>
          <div className='p-2'>
            <div className='relative mb-1.5'>
              <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground' />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder='Search collections…'
                className='h-8 w-full rounded-md border border-input bg-muted/30 pl-8 pr-3 text-[13px] placeholder:text-muted-foreground focus:border-nvr-cyan/50 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/30'
              />
            </div>
            <div className='max-h-60 overflow-y-auto'>
              {filtered.length === 0 ? (
                <div className='py-3 text-center text-[12px] text-muted-foreground'>
                  No collections found
                </div>
              ) : (
                filtered.map((c) => (
                  <button
                    key={c.collection}
                    type='button'
                    onClick={() => {
                      onChange(c.collection)
                      setOpen(false)
                      setSearch('')
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50 ${
                      c.collection === value ? 'bg-nvr-cyan/10' : ''
                    }`}
                  >
                    <span className='flex-1 truncate text-[13px] text-foreground'>
                      {c.display_name || c.collection}
                    </span>
                    {c.display_name && (
                      <code className='shrink-0 font-mono text-[11px] text-muted-foreground'>
                        {c.collection}
                      </code>
                    )}
                    {c.collection === value && (
                      <Check className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ExposedFields ────────────────────────────────────────────────────────────

function ExposedFields({
  collection,
  entries,
  onAdd,
  onRemove
}: {
  collection: string
  entries: FieldEntry[]
  onAdd: (picked: PickedField) => void
  onRemove: (path: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    function onDown(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  if (!collection) {
    return (
      <div className='flex items-center justify-center rounded-md border border-dashed border-border bg-muted/20 py-6'>
        <p className='text-[12px] text-muted-foreground'>
          Select a target collection to configure fields.
        </p>
      </div>
    )
  }

  return (
    <div className='space-y-2'>
      {entries.length > 0 && (
        <div className='overflow-hidden rounded-md border border-border'>
          {entries.map((entry, i) => (
            <div
              key={entry.path}
              className={`group flex items-center gap-3 bg-background px-3 py-2 transition-colors hover:bg-muted/30 ${
                i > 0 ? 'border-t border-border' : ''
              }`}
            >
              <code className='shrink-0 font-mono text-[12px] text-foreground'>{entry.path}</code>
              <span className='flex-1 truncate text-[12px] text-muted-foreground'>
                {entry.label !== entry.path ? entry.label : ''}
              </span>
              {entry.fieldType && (
                <span className='shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground'>
                  {fieldTypeLabel(entry.fieldType)}
                </span>
              )}
              <button
                type='button'
                onClick={() => onRemove(entry.path)}
                className='flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100'
                aria-label={`Remove ${entry.path}`}
              >
                <X className='h-3 w-3' />
              </button>
            </div>
          ))}
        </div>
      )}

      {entries.length === 0 && (
        <div className='flex items-center justify-center rounded-md border border-dashed border-border bg-muted/20 py-5'>
          <p className='text-[12px] text-muted-foreground'>
            No fields configured. Click Add field to begin.
          </p>
        </div>
      )}

      <div className='relative inline-block' ref={pickerRef}>
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='h-7 gap-1.5 text-xs'
          onClick={() => setPickerOpen((v) => !v)}
        >
          <Plus className='h-3.5 w-3.5' />
          Add field
        </Button>
        {pickerOpen && (
          <div className='absolute left-0 top-full z-50 mt-1'>
            <CollectionFieldPickerPanel
              collection={collection}
              onSelect={(picked) => {
                onAdd(picked)
                setPickerOpen(false)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SubmissionFormEditPage() {
  const { id } = useParams<{ id: string }>()
  const isNew = id === 'new'
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [name, setName] = useState('')
  const [collection, setCollection] = useState('')
  const [fieldEntries, setFieldEntries] = useState<FieldEntry[]>([])
  const [formConfig, setFormConfig] = useState<FormConfig>({})
  const [password, setPassword] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [rateLimit, setRateLimit] = useState(60)
  const [isActive, setIsActive] = useState(true)
  const [successMessage, setSuccessMessage] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)

  const [subsPage, setSubsPage] = useState(1)
  const SUBS_LIMIT = 10

  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.get<{ data: Collection[] }>('/collections').then((r) => r.data.data)
  })
  const collections = collectionsData ?? []

  const { data: form, isLoading: formLoading } = useQuery({
    queryKey: ['submission-form', id],
    queryFn: () =>
      api.get<{ data: SubmissionForm }>(`/submission-forms/${id}`).then((r) => r.data.data),
    enabled: !isNew
  })

  useEffect(() => {
    if (form && !initialized) {
      setName(form.name)
      setCollection(form.collection)
      setFieldEntries(Array.isArray(form.fields) ? form.fields.map(fieldEntryFromPath) : [])
      setFormConfig(form.form_config ?? {})
      setExpiresAt(form.expires_at ? form.expires_at.slice(0, 16) : '')
      setRateLimit(form.rate_limit_per_hour)
      setIsActive(form.is_active)
      setSuccessMessage(form.success_message ?? '')
      setInitialized(true)
    }
  }, [form, initialized])

  const { data: subsData } = useQuery({
    queryKey: ['submission-form-subs', id, subsPage],
    queryFn: () =>
      api
        .get<SubmissionsResponse>(`/submission-forms/${id}/submissions`, {
          params: { page: subsPage, limit: SUBS_LIMIT }
        })
        .then((r) => r.data),
    enabled: !isNew && !!id
  })

  const submissions = subsData?.data ?? []
  const subsTotal = subsData?.total ?? 0
  const subsTotalPages = Math.ceil(subsTotal / SUBS_LIMIT)

  function handleCollectionChange(col: string) {
    if (col !== collection) {
      setFieldEntries([])
      setFormConfig((prev) => ({ ...prev, fields: {} }))
    }
    setCollection(col)
  }

  function handleAddField(picked: PickedField) {
    const path = picked.path.join('.')
    if (fieldEntries.some((f) => f.path === path)) {
      toast.error('Field already added')
      return
    }
    setFieldEntries((prev) => [
      ...prev,
      { path, label: picked.pathLabels.join(' › '), fieldType: picked.fieldType }
    ])
    setFormConfig((prev) => ({
      ...prev,
      fields: {
        ...prev.fields,
        [path]: {
          label: picked.pathLabels.join(' › '),
          placeholder: '',
          required: false,
          widget: defaultWidget(path, picked.fieldType)
        }
      }
    }))
  }

  function handleRemoveField(path: string) {
    setFieldEntries((prev) => prev.filter((f) => f.path !== path))
    setFormConfig((prev) => {
      const fields = { ...(prev.fields ?? {}) }
      delete fields[path]
      return { ...prev, fields }
    })
  }

  function updateFieldConfig(path: string, patch: Partial<FormFieldConfig>) {
    setFormConfig((prev) => ({
      ...prev,
      fields: {
        ...prev.fields,
        [path]: { ...(prev.fields?.[path] ?? {}), ...patch }
      }
    }))
  }

  const createMut = useMutation({
    mutationFn: (body: {
      name: string
      collection: string
      fields: string[]
      form_config?: FormConfig | null
      password?: string
      expires_at?: string | null
      rate_limit_per_hour: number
      is_active: boolean
      success_message: string | null
    }) => api.post<{ data: SubmissionForm }>('/submission-forms', body).then((r) => r.data.data),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['submission-forms'] })
      toast.success('Form created')
      navigate(`/submission-forms/${created.id}`)
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to create form'
      toast.error(msg)
    }
  })

  const updateMut = useMutation({
    mutationFn: (body: {
      name?: string
      collection?: string
      fields?: string[]
      form_config?: FormConfig | null
      password?: string
      expires_at?: string | null
      rate_limit_per_hour?: number
      is_active?: boolean
      success_message?: string | null
    }) =>
      api.patch<{ data: SubmissionForm }>(`/submission-forms/${id}`, body).then((r) => r.data.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['submission-forms'] })
      qc.invalidateQueries({ queryKey: ['submission-form', id] })
      toast.success('Form saved')
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to save form'
      toast.error(msg)
    }
  })

  const deleteSubMut = useMutation({
    mutationFn: (subId: string) => api.delete(`/submission-forms/${id}/submissions/${subId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['submission-form-subs', id, subsPage] })
      qc.invalidateQueries({ queryKey: ['submission-form', id] })
      qc.invalidateQueries({ queryKey: ['submission-forms'] })
      toast.success('Submission deleted')
    },
    onError: () => toast.error('Failed to delete submission')
  })

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const fields = fieldEntries.map((f) => f.path)
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    if (!collection.trim()) {
      toast.error('Collection is required')
      return
    }
    if (fields.length === 0) {
      toast.error('At least one field is required')
      return
    }

    const payload = {
      name: name.trim(),
      collection: collection.trim(),
      fields,
      form_config: formConfig,
      password: password || undefined,
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      rate_limit_per_hour: rateLimit,
      is_active: isActive,
      success_message: successMessage.trim() || null
    }

    if (isNew) {
      createMut.mutate(payload)
    } else {
      updateMut.mutate(payload)
    }
  }

  const isSaving = createMut.isPending || updateMut.isPending
  const publicUrl = form?.token
    ? `${window.location.origin}/api/submission-forms/public/${form.token}`
    : null

  const formUrl = form?.token ? `${window.location.origin}/form/${form.token}` : null

  if (!isNew && formLoading) {
    return (
      <div className='flex flex-col h-full'>
        <div className='flex items-center justify-between border-b border-border px-6 py-4 shrink-0'>
          <div className='flex items-center gap-2.5'>
            <FileInput className='h-5 w-5 text-muted-foreground' />
            <div className='h-5 w-48 bg-muted animate-pulse rounded' />
          </div>
        </div>
        <div className='flex-1 p-6 space-y-4'>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className='h-16 bg-muted animate-pulse rounded-lg' />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='flex items-center justify-between border-b border-border px-6 py-4 shrink-0'>
        <div className='flex items-center gap-2.5'>
          <Button
            variant='ghost'
            size='icon'
            className='h-8 w-8'
            onClick={() => navigate('/submission-forms')}
          >
            <ArrowLeft className='h-4 w-4' />
          </Button>
          <FileInput className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>
            {isNew ? 'New Submission Form' : (form?.name ?? 'Edit Form')}
          </h1>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            onClick={() => navigate('/submission-forms')}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : isNew ? 'Create Form' : 'Save Changes'}
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className='flex-1 overflow-auto'>
        <div className='p-6 space-y-6'>
          {/* Two-column editor grid */}
          <div className='grid gap-6 grid-cols-1 xl:grid-cols-[1fr_360px] items-start'>
            {/* LEFT: Primary editing surfaces */}
            <div className='space-y-6 min-w-0'>
              {/* Form Settings */}
              <div className='rounded-lg border border-border bg-card p-6 space-y-5'>
                <h2 className='text-sm font-semibold text-foreground'>Form Settings</h2>

                <div className='space-y-1.5'>
                  <Label htmlFor='sf-name'>Name *</Label>
                  <Input
                    id='sf-name'
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder='Contact Form'
                    required
                  />
                </div>

                <div className='space-y-1.5'>
                  <Label>Target Collection *</Label>
                  <CollectionCombobox
                    value={collection}
                    onChange={handleCollectionChange}
                    collections={collections}
                  />
                  <p className='text-[11px] text-muted-foreground'>
                    The collection where submissions will be stored.
                  </p>
                </div>

                <div className='space-y-2'>
                  <div className='flex items-center justify-between'>
                    <Label>Exposed Fields *</Label>
                    {fieldEntries.length > 0 && (
                      <span className='text-[11px] text-muted-foreground'>
                        {fieldEntries.length} field{fieldEntries.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <ExposedFields
                    collection={collection}
                    entries={fieldEntries}
                    onAdd={handleAddField}
                    onRemove={handleRemoveField}
                  />
                  <p className='text-[11px] text-muted-foreground'>
                    Only these fields are accepted on submission. Supports direct fields and
                    relation traversals (M2O, O2M, M2M).
                  </p>
                </div>

                <div className='space-y-1.5'>
                  <Label htmlFor='sf-success'>Success Message</Label>
                  <Textarea
                    id='sf-success'
                    value={successMessage}
                    onChange={(e) => setSuccessMessage(e.target.value)}
                    placeholder='Thank you! Your submission has been received.'
                    rows={2}
                    className='resize-none'
                  />
                </div>
              </div>

              {/* Form Design */}
              {fieldEntries.length > 0 && (
                <div className='rounded-lg border border-border bg-card p-6 space-y-5'>
                  <h2 className='text-sm font-semibold text-foreground'>Form Design</h2>

                  <div className='space-y-4'>
                    <p className='text-[11px] font-medium text-muted-foreground'>Global</p>
                    <div className='grid gap-4 grid-cols-2'>
                      <div className='space-y-1.5'>
                        <Label htmlFor='fc-heading'>Heading</Label>
                        <Input
                          id='fc-heading'
                          value={formConfig.heading ?? ''}
                          onChange={(e) =>
                            setFormConfig((prev) => ({ ...prev, heading: e.target.value }))
                          }
                          placeholder={name || 'Form heading'}
                        />
                      </div>
                      <div className='space-y-1.5'>
                        <Label htmlFor='fc-submit-label'>Submit Button Label</Label>
                        <Input
                          id='fc-submit-label'
                          value={formConfig.submit_label ?? ''}
                          onChange={(e) =>
                            setFormConfig((prev) => ({ ...prev, submit_label: e.target.value }))
                          }
                          placeholder='Submit'
                        />
                      </div>
                    </div>
                    <div className='space-y-1.5'>
                      <Label htmlFor='fc-description'>Description</Label>
                      <Textarea
                        id='fc-description'
                        value={formConfig.description ?? ''}
                        onChange={(e) =>
                          setFormConfig((prev) => ({ ...prev, description: e.target.value }))
                        }
                        placeholder='Optional description shown below the heading.'
                        rows={2}
                        className='resize-none'
                      />
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <p className='text-[11px] font-medium text-muted-foreground'>Fields</p>
                    {fieldEntries.map((entry) => {
                      const cfg = formConfig.fields?.[entry.path] ?? {}
                      return (
                        <div
                          key={entry.path}
                          className='rounded-md border border-border p-4 space-y-3'
                        >
                          <div className='flex items-center gap-2'>
                            <code className='text-[12px] font-mono text-muted-foreground'>
                              {entry.path}
                            </code>
                            {entry.fieldType && (
                              <span className='rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground'>
                                {fieldTypeLabel(entry.fieldType)}
                              </span>
                            )}
                          </div>
                          <div className='grid gap-3 grid-cols-2'>
                            <div className='space-y-1.5'>
                              <Label className='text-[12px]'>Label</Label>
                              <Input
                                value={cfg.label ?? ''}
                                onChange={(e) =>
                                  updateFieldConfig(entry.path, { label: e.target.value })
                                }
                                placeholder={entry.label}
                                className='h-8 text-sm'
                              />
                            </div>
                            <div className='space-y-1.5'>
                              <Label className='text-[12px]'>Placeholder</Label>
                              <Input
                                value={cfg.placeholder ?? ''}
                                onChange={(e) =>
                                  updateFieldConfig(entry.path, { placeholder: e.target.value })
                                }
                                placeholder='Optional'
                                className='h-8 text-sm'
                              />
                            </div>
                            <div className='space-y-1.5'>
                              <Label className='text-[12px]'>Widget</Label>
                              <select
                                value={cfg.widget ?? defaultWidget(entry.path, entry.fieldType)}
                                onChange={(e) =>
                                  updateFieldConfig(entry.path, { widget: e.target.value })
                                }
                                className='h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:border-nvr-cyan/60 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/20'
                              >
                                {WIDGET_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className='flex items-center gap-2.5 pt-4'>
                              <button
                                type='button'
                                role='switch'
                                aria-checked={cfg.required ?? false}
                                onClick={() =>
                                  updateFieldConfig(entry.path, {
                                    required: !(cfg.required ?? false)
                                  })
                                }
                                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                                  (cfg.required ?? false) ? 'bg-nvr-cyan' : 'bg-muted-foreground/30'
                                }`}
                              >
                                <span
                                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                    (cfg.required ?? false) ? 'translate-x-4' : 'translate-x-0'
                                  }`}
                                />
                              </button>
                              <Label
                                className='text-[12px] cursor-pointer'
                                onClick={() =>
                                  updateFieldConfig(entry.path, {
                                    required: !(cfg.required ?? false)
                                  })
                                }
                              >
                                Required
                              </Label>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT: Meta, access, embed */}
            <div className='space-y-5'>
              {/* Active toggle — prominent at top of right rail */}
              <div className='flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3'>
                <div>
                  <p className='text-sm font-medium text-foreground'>Active</p>
                  <p className='text-[11px] text-muted-foreground'>
                    {isActive ? 'Accepting submissions' : 'Not accepting submissions'}
                  </p>
                </div>
                <button
                  type='button'
                  role='switch'
                  aria-checked={isActive}
                  onClick={() => setIsActive((v) => !v)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                    isActive ? 'bg-nvr-cyan' : 'bg-muted-foreground/30'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
                      isActive ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Access & Limits */}
              <div className='rounded-lg border border-border bg-card p-5 space-y-4'>
                <h2 className='text-sm font-semibold text-foreground'>Access &amp; Limits</h2>

                <div className='space-y-1.5'>
                  <Label htmlFor='sf-password'>Password Protection</Label>
                  <Input
                    id='sf-password'
                    type='password'
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={!isNew ? 'Leave blank to keep existing' : 'Optional'}
                    autoComplete='new-password'
                  />
                  {!isNew && (
                    <p className='text-[11px] text-muted-foreground'>
                      Stored as a secure hash; cannot be retrieved.
                    </p>
                  )}
                </div>

                <div className='space-y-1.5'>
                  <Label htmlFor='sf-expires'>Expires At</Label>
                  <Input
                    id='sf-expires'
                    type='datetime-local'
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                  />
                </div>

                <div className='space-y-1.5'>
                  <Label htmlFor='sf-rate'>Rate limit per IP / hour</Label>
                  <Input
                    id='sf-rate'
                    type='number'
                    min={1}
                    max={10000}
                    value={rateLimit}
                    onChange={(e) => setRateLimit(Number(e.target.value))}
                    className='max-w-[100px]'
                  />
                </div>
              </div>

              {/* Public Endpoint */}
              {!isNew && form && (
                <div className='rounded-lg border border-border bg-card p-5 space-y-4'>
                  <h2 className='text-sm font-semibold text-foreground'>Public Endpoint</h2>

                  <div className='space-y-1.5'>
                    <Label>Form Token</Label>
                    <div className='flex items-center gap-2'>
                      <code className='flex-1 truncate rounded-md border border-border bg-muted px-3 py-1.5 text-[11px] font-mono'>
                        {form.token}
                      </code>
                      <CopyButton value={form.token} />
                    </div>
                  </div>

                  {publicUrl && (
                    <div className='space-y-1.5'>
                      <Label>Submit URL</Label>
                      <div className='flex items-center gap-2'>
                        <code className='flex-1 truncate rounded-md border border-border bg-muted px-3 py-1.5 text-[11px] font-mono'>
                          {publicUrl}
                        </code>
                        <CopyButton value={publicUrl} />
                      </div>
                      <p className='text-[11px] text-muted-foreground'>
                        POST <code>{'{ "data": { ... } }'}</code> — no auth required.
                      </p>
                    </div>
                  )}

                  <div className='rounded-md border border-border bg-muted/50 p-3'>
                    <p className='mb-1.5 text-[11px] font-medium text-muted-foreground'>Example</p>
                    <pre className='overflow-x-auto whitespace-pre-wrap font-mono text-[10px] text-foreground leading-relaxed'>
                      {`curl -X POST "${publicUrl ?? '<url>'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "data": {\n      ${parseFieldsDisplay(form.fields)}\n    }\n  }'`}
                    </pre>
                  </div>
                </div>
              )}

              {/* Embed */}
              {!isNew && form && (
                <div className='rounded-lg border border-border bg-card p-5 space-y-4'>
                  <div className='flex items-center justify-between'>
                    <h2 className='text-sm font-semibold text-foreground'>Embed</h2>
                    {formUrl && (
                      <a
                        href={formUrl}
                        target='_blank'
                        rel='noopener noreferrer'
                        className='flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors'
                      >
                        <Eye className='h-3.5 w-3.5' />
                        Open
                      </a>
                    )}
                  </div>

                  {formUrl && (
                    <>
                      <div className='space-y-1.5'>
                        <div className='flex items-center justify-between'>
                          <Label>Preview</Label>
                          <Button
                            type='button'
                            variant='ghost'
                            size='sm'
                            className='h-6 gap-1 text-[11px] px-2'
                            onClick={() => setPreviewKey((k) => k + 1)}
                          >
                            <RefreshCw className='h-3 w-3' />
                            Refresh
                          </Button>
                        </div>
                        <div className='overflow-hidden rounded-md border border-border'>
                          <iframe
                            key={previewKey}
                            src={formUrl}
                            title='Form preview'
                            className='h-[360px] w-full border-none'
                            sandbox='allow-scripts allow-forms allow-same-origin'
                          />
                        </div>
                        <p className='text-[11px] text-muted-foreground'>
                          Save then refresh to see design changes.
                        </p>
                      </div>

                      <div className='space-y-1.5'>
                        <Label>Form URL</Label>
                        <div className='flex items-center gap-2'>
                          <code className='flex-1 truncate rounded-md border border-border bg-muted px-3 py-1.5 text-[11px] font-mono'>
                            {formUrl}
                          </code>
                          <CopyButton value={formUrl} />
                        </div>
                      </div>

                      <div className='space-y-1.5'>
                        <div className='flex items-center gap-1.5'>
                          <Code2 className='h-3.5 w-3.5 text-muted-foreground' />
                          <Label>Iframe Code</Label>
                        </div>
                        <div className='flex items-start gap-2'>
                          <pre className='flex-1 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-[10px] leading-relaxed text-foreground whitespace-pre-wrap break-all'>
                            {`<iframe\n  src="${formUrl}"\n  width="100%"\n  height="500"\n  frameborder="0"\n  style="border:none;border-radius:8px"\n></iframe>`}
                          </pre>
                          <CopyButton
                            value={`<iframe\n  src="${formUrl}"\n  width="100%"\n  height="500"\n  frameborder="0"\n  style="border:none;border-radius:8px"\n></iframe>`}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Full-width: Submissions table */}
          {!isNew && (
            <div className='overflow-hidden rounded-lg border border-border bg-card'>
              <div className='flex items-center justify-between border-b border-border px-6 py-4'>
                <h2 className='text-sm font-semibold'>
                  Submissions{' '}
                  {subsTotal > 0 && (
                    <Badge variant='outline' className='ml-1.5 text-xs'>
                      {subsTotal}
                    </Badge>
                  )}
                </h2>
              </div>

              {submissions.length === 0 ? (
                <div className='py-12 text-center'>
                  <p className='text-sm text-muted-foreground'>No submissions yet</p>
                </div>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow className='bg-muted/30'>
                        <TableHead>Submitted At</TableHead>
                        <TableHead>IP</TableHead>
                        <TableHead>Data Preview</TableHead>
                        <TableHead className='w-[60px]' />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {submissions.map((sub) => (
                        <TableRow key={sub.id} className='group'>
                          <TableCell className='whitespace-nowrap text-sm'>
                            {formatDate(sub.created_at)}
                          </TableCell>
                          <TableCell className='font-mono text-sm text-muted-foreground'>
                            {sub.ip ?? '—'}
                          </TableCell>
                          <TableCell className='text-xs text-muted-foreground'>
                            {Object.entries(sub.data)
                              .slice(0, 4)
                              .map(([k, v]) => `${k}: ${String(v)}`)
                              .join(' · ')}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant='ghost'
                              size='icon'
                              className='h-7 w-7 text-destructive hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100'
                              onClick={() => deleteSubMut.mutate(sub.id)}
                              disabled={deleteSubMut.isPending}
                            >
                              <Trash2 className='h-3.5 w-3.5' />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  {subsTotalPages > 1 && (
                    <div className='flex items-center justify-between border-t border-border px-6 py-3'>
                      <p className='text-xs text-muted-foreground'>
                        Page {subsPage} of {subsTotalPages} ({subsTotal} total)
                      </p>
                      <div className='flex items-center gap-1.5'>
                        <Button
                          variant='outline'
                          size='sm'
                          className='h-7 text-xs'
                          disabled={subsPage <= 1}
                          onClick={() => setSubsPage((p) => p - 1)}
                        >
                          Previous
                        </Button>
                        <Button
                          variant='outline'
                          size='sm'
                          className='h-7 text-xs'
                          disabled={subsPage >= subsTotalPages}
                          onClick={() => setSubsPage((p) => p + 1)}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
