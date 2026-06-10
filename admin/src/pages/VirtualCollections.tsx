import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, Database, Eye, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface VirtualCollection {
  collection: string
  label: string
  virtual_sql: string
  workspace?: string | null
}

interface FormData {
  name: string
  label: string
  virtual_sql: string
}

const FORM_DEFAULTS: FormData = {
  name: '',
  label: '',
  virtual_sql: ''
}

// ─── SQL Validation feedback ──────────────────────────────────────────────────

type ValidationState =
  | { status: 'idle' }
  | { status: 'validating' }
  | { status: 'valid' }
  | { status: 'invalid'; error: string }

// ─── Preview table ────────────────────────────────────────────────────────────

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return <p className='text-[12px] text-muted-foreground py-2'>Query returned no rows.</p>
  }
  const cols = Object.keys(rows[0])
  return (
    <div className='overflow-x-auto rounded-lg border border-border mt-2'>
      <table className='min-w-full text-[12px]'>
        <thead>
          <tr className='bg-slate-50 dark:bg-muted/50'>
            {cols.map((c) => (
              <th
                key={c}
                className='px-3 py-2 text-left font-semibold text-muted-foreground border-b border-border whitespace-nowrap'
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 5).map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: preview rows
            <tr key={i} className='border-b border-border/50 last:border-0'>
              {cols.map((c) => (
                <td key={c} className='px-3 py-2 text-foreground font-mono whitespace-nowrap'>
                  {row[c] == null ? (
                    <span className='text-muted-foreground/50'>null</span>
                  ) : (
                    String(row[c])
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Form panel ───────────────────────────────────────────────────────────────

function VirtualCollectionForm({
  initial,
  isEdit,
  collectionKey,
  onSave,
  onCancel,
  onDelete,
  saving,
  deleting
}: {
  initial?: FormData
  isEdit: boolean
  collectionKey?: string
  onSave: (d: FormData) => void
  onCancel: () => void
  onDelete?: () => void
  saving: boolean
  deleting?: boolean
}) {
  const [form, setForm] = useState<FormData>(initial ?? FORM_DEFAULTS)
  const [validation, setValidation] = useState<ValidationState>({ status: 'idle' })
  const [preview, setPreview] = useState<Record<string, unknown>[] | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  function set<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
    // Reset validation when SQL changes
    if (key === 'virtual_sql') {
      setValidation({ status: 'idle' })
      setPreview(null)
    }
  }

  async function handleValidate() {
    if (!form.virtual_sql.trim()) return
    setValidation({ status: 'validating' })
    const target = isEdit ? collectionKey! : form.name
    if (!target) {
      setValidation({ status: 'invalid', error: 'Collection name required before validation.' })
      return
    }
    try {
      const res = await api.post<{ valid: boolean; error?: string }>(
        `/virtual-collections/${target}/validate-sql`,
        { virtual_sql: form.virtual_sql }
      )
      if (res.data.valid) {
        setValidation({ status: 'valid' })
      } else {
        setValidation({ status: 'invalid', error: res.data.error ?? 'SQL is invalid.' })
      }
    } catch {
      setValidation({ status: 'invalid', error: 'Validation request failed.' })
    }
  }

  async function handlePreview() {
    const target = isEdit ? collectionKey! : form.name
    if (!target) {
      toast.error('Collection name required before preview.')
      return
    }
    setPreviewing(true)
    try {
      const res = await api.post<{ data: Record<string, unknown>[] }>(
        `/virtual-collections/${target}/query`
      )
      setPreview(res.data.data)
    } catch {
      toast.error('Preview query failed.')
    } finally {
      setPreviewing(false)
    }
  }

  // Slug-ify the name field on blur
  function handleNameBlur() {
    set(
      'name',
      form.name
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/__+/g, '_')
        .replace(/^_|_$/g, '')
    )
  }

  const isValid =
    form.label.trim() !== '' &&
    form.virtual_sql.trim() !== '' &&
    (!isEdit ? form.name.trim() !== '' : true)

  return (
    <div className='flex flex-col h-full'>
      <div className='shrink-0 border-b border-border px-6 py-4'>
        <h2 className='text-[15px] font-semibold'>
          {isEdit ? 'Edit Virtual Collection' : 'New Virtual Collection'}
        </h2>
      </div>

      <div className='flex-1 overflow-y-auto px-6 py-5 space-y-4'>
        {!isEdit && (
          <div className='space-y-1.5'>
            <Label>Collection Name (slug)</Label>
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              onBlur={handleNameBlur}
              placeholder='e.g. active_users'
              className='font-mono'
            />
            <p className='text-[11px] text-muted-foreground'>
              Lowercase letters, numbers, and underscores only.
            </p>
          </div>
        )}

        <div className='space-y-1.5'>
          <Label>Display Label</Label>
          <Input
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder='e.g. Active Users'
          />
        </div>

        <div className='space-y-1.5'>
          <div className='flex items-center justify-between'>
            <Label>SQL Query</Label>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-6 text-[12px] gap-1'
              onClick={handleValidate}
              disabled={!form.virtual_sql.trim() || validation.status === 'validating'}
            >
              {validation.status === 'validating' ? 'Validating…' : 'Validate SQL'}
            </Button>
          </div>
          <Textarea
            value={form.virtual_sql}
            onChange={(e) => set('virtual_sql', e.target.value)}
            rows={10}
            className={cn(
              'font-mono text-[13px] leading-relaxed resize-y',
              validation.status === 'valid' && 'border-green-500 focus-visible:ring-green-500',
              validation.status === 'invalid' && 'border-destructive focus-visible:ring-destructive'
            )}
            placeholder={
              "SELECT\n  id,\n  name,\n  created_at\nFROM my_table\nWHERE status = 'active'"
            }
          />
          {/* Validation feedback */}
          {validation.status === 'valid' && (
            <p className='text-[12px] text-green-600 dark:text-green-400 flex items-center gap-1'>
              <Check className='h-3.5 w-3.5' />
              SQL is valid
            </p>
          )}
          {validation.status === 'invalid' && (
            <p className='text-[12px] text-destructive flex items-start gap-1'>
              <X className='h-3.5 w-3.5 mt-0.5 shrink-0' />
              {validation.error}
            </p>
          )}
        </div>

        {/* Preview */}
        <div className='space-y-2'>
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='gap-1.5 text-[13px]'
            onClick={handlePreview}
            disabled={previewing || !form.virtual_sql.trim()}
          >
            <Eye className='h-4 w-4' />
            {previewing ? 'Loading…' : 'Preview Results'}
          </Button>
          {preview !== null && <PreviewTable rows={preview} />}
        </div>
      </div>

      <div className='shrink-0 border-t border-border px-6 py-4 flex items-center justify-between'>
        {isEdit && onDelete ? (
          <div>
            {confirmDelete ? (
              <div className='flex items-center gap-2'>
                <span className='text-[12px] text-muted-foreground'>Delete this collection?</span>
                <Button
                  variant='destructive'
                  size='sm'
                  className='h-7 text-[12px]'
                  onClick={onDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Confirm'}
                </Button>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-7 w-7'
                  onClick={() => setConfirmDelete(false)}
                >
                  <X className='h-3.5 w-3.5' />
                </Button>
              </div>
            ) : (
              <Button
                variant='ghost'
                size='sm'
                className='text-destructive hover:text-destructive gap-1.5 text-[12px]'
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className='h-3.5 w-3.5' />
                Delete
              </Button>
            )}
          </div>
        ) : (
          <div />
        )}
        <div className='flex items-center gap-2'>
          <Button variant='outline' onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => onSave(form)} disabled={saving || !isValid}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VirtualCollectionsPage() {
  const qc = useQueryClient()
  const [panel, setPanel] = useState<
    { type: 'create' } | { type: 'edit'; vc: VirtualCollection } | null
  >(null)

  const { data: virtualCollections = [], isLoading } = useQuery<VirtualCollection[]>({
    queryKey: ['virtual-collections'],
    queryFn: () =>
      api.get<{ data: VirtualCollection[] }>('/virtual-collections').then((r) => r.data.data)
  })

  const createMut = useMutation({
    mutationFn: (body: FormData) => api.post('/virtual-collections', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['virtual-collections'] })
      setPanel(null)
      toast.success('Virtual collection created')
    },
    onError: () => toast.error('Failed to create virtual collection')
  })

  const updateMut = useMutation({
    mutationFn: ({ collection, body }: { collection: string; body: Partial<FormData> }) =>
      api.patch(`/virtual-collections/${collection}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['virtual-collections'] })
      setPanel(null)
      toast.success('Virtual collection updated')
    },
    onError: () => toast.error('Failed to update virtual collection')
  })

  const deleteMut = useMutation({
    mutationFn: (collection: string) => api.delete(`/virtual-collections/${collection}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['virtual-collections'] })
      setPanel(null)
      toast.success('Virtual collection deleted')
    },
    onError: () => toast.error('Failed to delete virtual collection')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <header className='shrink-0 border-b border-border px-6 py-4 flex items-center justify-between'>
        <div className='flex items-center gap-2.5'>
          <Database className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Virtual Collections</h1>
        </div>
        <Button size='sm' onClick={() => setPanel({ type: 'create' })}>
          <Plus className='h-4 w-4 mr-1.5' />
          New Virtual Collection
        </Button>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left panel */}
        <aside className='w-[272px] shrink-0 border-r border-border flex flex-col'>
          <div className='flex-1 overflow-y-auto'>
            {isLoading ? (
              <div className='space-y-2 p-3'>
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className='h-12 w-full rounded-lg' />
                ))}
              </div>
            ) : virtualCollections.length === 0 ? (
              <div className='flex flex-col items-center justify-center py-16 px-4 text-center'>
                <Database className='h-8 w-8 text-muted-foreground/40 mb-2' />
                <p className='text-[13px] text-muted-foreground'>No virtual collections.</p>
                <p className='text-[11px] text-muted-foreground mt-1'>
                  Create read-only views backed by custom SQL.
                </p>
              </div>
            ) : (
              virtualCollections.map((vc) => {
                const isSelected = panel?.type === 'edit' && panel.vc.collection === vc.collection
                return (
                  <button
                    key={vc.collection}
                    type='button'
                    onClick={() => setPanel({ type: 'edit', vc })}
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
                        {vc.label}
                      </p>
                      <p className='text-[11px] text-muted-foreground font-mono truncate mt-0.5'>
                        {vc.collection}
                      </p>
                    </div>
                    <Badge
                      variant='outline'
                      className='text-[10px] shrink-0 bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/20 dark:text-violet-400 dark:border-violet-800'
                    >
                      Virtual
                    </Badge>
                    <ChevronRight className='h-3.5 w-3.5 text-muted-foreground/50 shrink-0' />
                  </button>
                )
              })
            )}
          </div>
        </aside>

        {/* Right panel */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {panel === null ? (
            <div className='flex flex-col items-center justify-center h-full text-center px-8'>
              <Database className='h-12 w-12 text-muted-foreground/30 mb-3' />
              <p className='text-sm font-medium text-muted-foreground mb-1'>
                No virtual collection selected
              </p>
              <p className='text-[13px] text-muted-foreground/70 mb-4'>
                Create read-only views backed by custom SQL queries.
              </p>
              <Button size='sm' onClick={() => setPanel({ type: 'create' })}>
                <Plus className='h-4 w-4 mr-1.5' />
                New Virtual Collection
              </Button>
            </div>
          ) : panel.type === 'create' ? (
            <div className='h-full bg-background'>
              <VirtualCollectionForm
                isEdit={false}
                onSave={(form) => createMut.mutate(form)}
                onCancel={() => setPanel(null)}
                saving={createMut.isPending}
              />
            </div>
          ) : (
            <div className='h-full bg-background'>
              <VirtualCollectionForm
                initial={{
                  name: panel.vc.collection,
                  label: panel.vc.label,
                  virtual_sql: panel.vc.virtual_sql
                }}
                isEdit
                collectionKey={panel.vc.collection}
                onSave={(form) =>
                  updateMut.mutate({
                    collection: panel.vc.collection,
                    body: { label: form.label, virtual_sql: form.virtual_sql }
                  })
                }
                onCancel={() => setPanel(null)}
                onDelete={() => deleteMut.mutate(panel.vc.collection)}
                saving={updateMut.isPending}
                deleting={deleteMut.isPending}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
