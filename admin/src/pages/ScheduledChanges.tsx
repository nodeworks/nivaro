import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Check, ChevronsUpDown, Play, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatDateTime } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduledChange {
  id: string
  collection: string
  item_id: string
  change_type: 'field_update' | 'workflow_transition' | 'publish' | 'unpublish'
  changes: Record<string, unknown>
  scheduled_at: string
  status: 'pending' | 'executed' | 'failed' | 'cancelled'
  executed_at: string | null
  created_at: string
  created_by_name?: string | null
}

interface Collection {
  collection: string
  display_name: string | null
}

interface CreateFormData {
  collection: string
  item_id: string
  change_type: string
  scheduled_at: string
  changes: string
}

const FORM_DEFAULTS: CreateFormData = {
  collection: '',
  item_id: '',
  change_type: '',
  scheduled_at: '',
  changes: '{\n  \n}'
}

const CHANGE_TYPES = [
  { value: 'field_update', label: 'Field Update' },
  { value: 'workflow_transition', label: 'Workflow Transition' },
  { value: 'publish', label: 'Publish' },
  { value: 'unpublish', label: 'Unpublish' }
]

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'executed', label: 'Executed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' }
]

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ScheduledChange['status'] }) {
  const config: Record<ScheduledChange['status'], { cls: string; label: string }> = {
    pending: {
      cls: 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan border-nvr-cyan/20',
      label: 'Pending'
    },
    executed: {
      cls: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800',
      label: 'Executed'
    },
    failed: {
      cls: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800',
      label: 'Failed'
    },
    cancelled: {
      cls: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-muted dark:text-muted-foreground dark:border-border',
      label: 'Cancelled'
    }
  }
  const { cls, label } = config[status] ?? config.pending
  return (
    <Badge variant='outline' className={cn('text-[11px]', cls)}>
      {label}
    </Badge>
  )
}

// ─── Combobox ─────────────────────────────────────────────────────────────────

function FieldCombobox({
  value,
  onChange,
  options,
  placeholder,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const label = options.find((o) => o.value === value)?.label
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className={cn('justify-between font-normal', className)}
        >
          <span className='truncate'>{value && label ? label : placeholder}</span>
          <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value || '__empty__'}
                  value={o.value || '__empty__'}
                  onSelect={(v) => {
                    onChange(v === '__empty__' ? '' : v)
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

// ─── Create Sheet Form ────────────────────────────────────────────────────────

function CreateForm({
  collections,
  onSave,
  saving
}: {
  collections: Collection[]
  onSave: (d: CreateFormData) => void
  saving: boolean
}) {
  const [form, setForm] = useState<CreateFormData>(FORM_DEFAULTS)

  function set<K extends keyof CreateFormData>(key: K, value: CreateFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  let changesValid = true
  try {
    JSON.parse(form.changes)
  } catch {
    changesValid = false
  }

  const isValid =
    form.collection !== '' &&
    form.item_id.trim() !== '' &&
    form.change_type !== '' &&
    form.scheduled_at !== '' &&
    changesValid

  const collectionOptions = collections.map((c) => ({
    value: c.collection,
    label: c.display_name ?? c.collection
  }))

  return (
    <div className='space-y-4 mt-4'>
      <div className='space-y-1.5'>
        <Label>Collection</Label>
        <FieldCombobox
          value={form.collection}
          onChange={(v) => set('collection', v)}
          options={collectionOptions}
          placeholder='Select collection…'
          className='w-full'
        />
      </div>

      <div className='space-y-1.5'>
        <Label>Item ID</Label>
        <Input
          value={form.item_id}
          onChange={(e) => set('item_id', e.target.value)}
          placeholder='e.g. 42 or uuid…'
        />
      </div>

      <div className='space-y-1.5'>
        <Label>Change Type</Label>
        <FieldCombobox
          value={form.change_type}
          onChange={(v) => set('change_type', v)}
          options={CHANGE_TYPES}
          placeholder='Select type…'
          className='w-full'
        />
      </div>

      <div className='space-y-1.5'>
        <Label>Scheduled At</Label>
        <Input
          type='datetime-local'
          value={form.scheduled_at}
          onChange={(e) => set('scheduled_at', e.target.value)}
        />
      </div>

      <div className='space-y-1.5'>
        <Label>Changes (JSON)</Label>
        <Textarea
          value={form.changes}
          onChange={(e) => set('changes', e.target.value)}
          rows={6}
          className={cn(
            'font-mono text-[13px]',
            !changesValid &&
              form.changes.trim() !== '' &&
              'border-destructive focus-visible:ring-destructive'
          )}
          placeholder='{"field": "value"}'
        />
        {!changesValid && form.changes.trim() !== '' && (
          <p className='text-[11px] text-destructive'>Invalid JSON</p>
        )}
      </div>

      <Button className='w-full' onClick={() => onSave(form)} disabled={saving || !isValid}>
        {saving ? 'Scheduling…' : 'Schedule Change'}
      </Button>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ScheduledChangesPage() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('')
  const [collectionFilter, setCollectionFilter] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const { data: collections = [] } = useQuery<Collection[]>({
    queryKey: ['collections-list'],
    queryFn: () => api.get<{ data: Collection[] }>('/collections').then((r) => r.data.data)
  })

  const { data: changes = [], isLoading } = useQuery<ScheduledChange[]>({
    queryKey: ['scheduled-changes', statusFilter, collectionFilter],
    queryFn: () => {
      const params: Record<string, string> = {}
      if (statusFilter) params.status = statusFilter
      if (collectionFilter) params.collection = collectionFilter
      return api
        .get<{ data: ScheduledChange[] }>('/scheduled-changes', { params })
        .then((r) => r.data.data)
    }
  })

  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/scheduled-changes', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scheduled-changes'] })
      setSheetOpen(false)
      toast.success('Change scheduled')
    },
    onError: () => toast.error('Failed to schedule change')
  })

  const executeMut = useMutation({
    mutationFn: (id: string) => api.post(`/scheduled-changes/${id}/execute`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scheduled-changes'] })
      toast.success('Change executed')
    },
    onError: () => toast.error('Failed to execute change')
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/scheduled-changes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scheduled-changes'] })
      setDeletingId(null)
      toast.success('Change deleted')
    },
    onError: () => toast.error('Failed to delete change')
  })

  const collectionFilterOptions = [
    { value: '', label: 'All Collections' },
    ...collections.map((c) => ({
      value: c.collection,
      label: c.display_name ?? c.collection
    }))
  ]

  function handleCreate(form: CreateFormData) {
    let parsedChanges: Record<string, unknown> = {}
    try {
      parsedChanges = JSON.parse(form.changes)
    } catch {
      /* already validated */
    }
    createMut.mutate({
      collection: form.collection,
      item_id: form.item_id,
      change_type: form.change_type,
      scheduled_at: new Date(form.scheduled_at).toISOString(),
      changes: parsedChanges
    })
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <header className='shrink-0 border-b border-border px-6 py-4 flex items-center justify-between gap-4'>
        <div className='flex items-center gap-2.5'>
          <CalendarClock className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Scheduled Changes</h1>
        </div>
        <div className='flex items-center gap-2'>
          {/* Status filter */}
          <FieldCombobox
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_OPTIONS}
            placeholder='All Statuses'
            className='w-[160px] h-8 text-[13px]'
          />
          {/* Collection filter */}
          <FieldCombobox
            value={collectionFilter}
            onChange={setCollectionFilter}
            options={collectionFilterOptions}
            placeholder='All Collections'
            className='w-[180px] h-8 text-[13px]'
          />
          <Button size='sm' onClick={() => setSheetOpen(true)}>
            <Plus className='h-4 w-4 mr-1.5' />
            Schedule Change
          </Button>
        </div>
      </header>

      {/* Table */}
      <div className='flex-1 overflow-auto p-6'>
        {isLoading ? (
          <div className='space-y-2'>
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className='h-12 w-full rounded-lg' />
            ))}
          </div>
        ) : changes.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <CalendarClock className='h-10 w-10 text-muted-foreground/40 mb-3' />
            <p className='text-sm font-medium text-muted-foreground mb-1'>No scheduled changes</p>
            <p className='text-[13px] text-muted-foreground/70 mb-4'>
              Schedule field updates, workflow transitions, or publish actions.
            </p>
            <Button size='sm' onClick={() => setSheetOpen(true)}>
              <Plus className='h-4 w-4 mr-1.5' />
              Schedule Change
            </Button>
          </div>
        ) : (
          <div className='rounded-lg border border-border overflow-hidden'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Collection</TableHead>
                  <TableHead>Item ID</TableHead>
                  <TableHead>Change Type</TableHead>
                  <TableHead>Scheduled At</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created By</TableHead>
                  <TableHead className='w-[120px]' />
                </TableRow>
              </TableHeader>
              <TableBody>
                {changes.map((change) => (
                  <TableRow key={change.id}>
                    <TableCell className='font-medium text-[13px]'>
                      {collections.find((c) => c.collection === change.collection)?.display_name ??
                        change.collection}
                    </TableCell>
                    <TableCell>
                      <code className='text-xs bg-muted px-1.5 py-0.5 rounded'>
                        {change.item_id}
                      </code>
                    </TableCell>
                    <TableCell className='text-[13px] capitalize text-muted-foreground'>
                      {CHANGE_TYPES.find((t) => t.value === change.change_type)?.label ??
                        change.change_type}
                    </TableCell>
                    <TableCell className='text-[13px] text-muted-foreground whitespace-nowrap'>
                      {formatDateTime(change.scheduled_at)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={change.status} />
                    </TableCell>
                    <TableCell className='text-[13px] text-muted-foreground'>
                      {change.created_by_name ?? '—'}
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center gap-1 justify-end'>
                        {change.status === 'pending' && (
                          <Button
                            variant='ghost'
                            size='sm'
                            className='h-7 text-[12px] gap-1'
                            onClick={() => executeMut.mutate(change.id)}
                            disabled={executeMut.isPending}
                          >
                            <Play className='h-3 w-3' />
                            Execute
                          </Button>
                        )}
                        {deletingId === change.id ? (
                          <div className='flex items-center gap-1'>
                            <Button
                              variant='destructive'
                              size='sm'
                              className='h-7 text-[12px]'
                              onClick={() => deleteMut.mutate(change.id)}
                              disabled={deleteMut.isPending}
                            >
                              {deleteMut.isPending ? '…' : 'Confirm'}
                            </Button>
                            <Button
                              variant='ghost'
                              size='icon'
                              className='h-7 w-7'
                              onClick={() => setDeletingId(null)}
                            >
                              <X className='h-3.5 w-3.5' />
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant='ghost'
                            size='icon'
                            className='h-7 w-7 text-destructive hover:text-destructive'
                            onClick={() => setDeletingId(change.id)}
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Create sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className='w-[420px] sm:max-w-[420px] overflow-y-auto'>
          <SheetHeader>
            <SheetTitle>Schedule a Change</SheetTitle>
          </SheetHeader>
          <CreateForm
            collections={collections}
            onSave={handleCreate}
            saving={createMut.isPending}
          />
        </SheetContent>
      </Sheet>
    </div>
  )
}
