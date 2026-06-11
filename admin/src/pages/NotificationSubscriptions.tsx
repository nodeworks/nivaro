import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, ChevronsUpDown, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const EVENT_TYPES = ['all', 'create', 'update', 'delete'] as const
type EventType = (typeof EVENT_TYPES)[number]

type DigestFrequency = 'instant' | 'daily' | 'weekly'

const DELIVERY_OPTIONS: { value: DigestFrequency; label: string }[] = [
  { value: 'instant', label: 'Instant' },
  { value: 'daily', label: 'Daily digest' },
  { value: 'weekly', label: 'Weekly digest' }
]

interface Subscription {
  id: number
  user: string
  collection: string
  event_type: EventType
  filter_field: string | null
  filter_value: string | null
  label: string | null
  is_active: boolean
  digest_frequency: DigestFrequency
  created_at: string
}

function DeliveryCombobox({
  value,
  onChange,
  disabled
}: {
  value: DigestFrequency
  onChange: (v: DigestFrequency) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = DELIVERY_OPTIONS.find((o) => o.value === value) ?? DELIVERY_OPTIONS[0]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className='h-7 w-[130px] justify-between px-2 text-[12px] font-normal'
        >
          <span className='truncate'>{selected.label}</span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[160px] p-0' align='start'>
        <Command>
          <CommandList>
            <CommandGroup>
              {DELIVERY_OPTIONS.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={() => {
                    if (opt.value !== value) onChange(opt.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
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

interface SubscriptionFormState {
  label: string
  collection: string
  event_type: EventType
  filter_field: string
  filter_value: string
  is_active: boolean
}

const DEFAULT_FORM: SubscriptionFormState = {
  label: '',
  collection: '',
  event_type: 'all',
  filter_field: '',
  filter_value: '',
  is_active: true
}

function eventTypeBadge(type: EventType) {
  switch (type) {
    case 'create':
      return (
        <Badge className='bg-green-500/10 text-green-700 dark:text-green-400 border-0 font-medium'>
          create
        </Badge>
      )
    case 'update':
      return (
        <Badge className='bg-blue-500/10 text-blue-700 dark:text-blue-400 border-0 font-medium'>
          update
        </Badge>
      )
    case 'delete':
      return (
        <Badge className='bg-red-500/10 text-red-700 dark:text-red-400 border-0 font-medium'>
          delete
        </Badge>
      )
    case 'all':
      return (
        <Badge className='bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan border-0 font-medium'>
          all
        </Badge>
      )
    default:
      return <Badge variant='secondary'>{type}</Badge>
  }
}

function SubscriptionForm({
  initial,
  onSave,
  onCancel,
  saving
}: {
  initial?: SubscriptionFormState
  onSave: (data: SubscriptionFormState) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<SubscriptionFormState>(initial ?? DEFAULT_FORM)

  function set(key: keyof SubscriptionFormState, value: string | boolean) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const isValid = form.collection.trim().length > 0

  return (
    <div className='space-y-4 px-6 pb-6'>
      <div className='space-y-1.5'>
        <Label htmlFor='sub-label'>Label (optional)</Label>
        <Input
          id='sub-label'
          value={form.label}
          onChange={(e) => set('label', e.target.value)}
          placeholder='e.g. My Work Orders created'
        />
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='sub-collection'>
          Collection <span className='text-destructive'>*</span>
        </Label>
        <Input
          id='sub-collection'
          value={form.collection}
          onChange={(e) => set('collection', e.target.value)}
          placeholder='e.g. work_orders'
        />
        <p className='text-[12px] text-muted-foreground'>
          The collection key to watch (exact match).
        </p>
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='sub-event-type'>Event Type</Label>
        <Select value={form.event_type} onValueChange={(v) => set('event_type', v as EventType)}>
          <SelectTrigger id='sub-event-type'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>All events</SelectItem>
            <SelectItem value='create'>Create</SelectItem>
            <SelectItem value='update'>Update</SelectItem>
            <SelectItem value='delete'>Delete</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='sub-filter-field'>Filter Field (optional)</Label>
        <Input
          id='sub-filter-field'
          value={form.filter_field}
          onChange={(e) => set('filter_field', e.target.value)}
          placeholder='e.g. status'
        />
        <p className='text-[12px] text-muted-foreground'>
          Only notify when this field matches the value below.
        </p>
      </div>

      {form.filter_field.trim().length > 0 && (
        <div className='space-y-1.5'>
          <Label htmlFor='sub-filter-value'>Filter Value</Label>
          <Input
            id='sub-filter-value'
            value={form.filter_value}
            onChange={(e) => set('filter_value', e.target.value)}
            placeholder='e.g. open'
          />
        </div>
      )}

      <div className='flex items-center gap-3'>
        <Switch
          id='sub-active'
          checked={form.is_active}
          onCheckedChange={(v) => set('is_active', v)}
        />
        <Label htmlFor='sub-active' className='cursor-pointer'>
          Active
        </Label>
      </div>

      <DialogFooter>
        <Button variant='outline' onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => onSave(form)} disabled={saving || !isValid}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </div>
  )
}

export function NotificationSubscriptionsPage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<Subscription[]>({
    queryKey: ['notification-subscriptions'],
    queryFn: () =>
      api.get<{ data: Subscription[] }>('/notification-subscriptions').then((r) => r.data.data)
  })
  const subscriptions = data ?? []

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Subscription | null>(null)
  const [deleting, setDeleting] = useState<Subscription | null>(null)

  const createMut = useMutation({
    mutationFn: (body: SubscriptionFormState) =>
      api.post('/notification-subscriptions', {
        collection: body.collection.trim(),
        event_type: body.event_type,
        filter_field: body.filter_field.trim() || undefined,
        filter_value: body.filter_value.trim() || undefined,
        label: body.label.trim() || undefined,
        is_active: body.is_active
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
      setCreating(false)
      toast.success('Subscription created')
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to create subscription'
      toast.error(msg)
    }
  })

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<SubscriptionFormState> }) =>
      api.patch(`/notification-subscriptions/${id}`, {
        label: body.label?.trim() || null,
        filter_field: body.filter_field?.trim() || null,
        filter_value: body.filter_value?.trim() || null,
        is_active: body.is_active
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
      setEditing(null)
      toast.success('Subscription updated')
    },
    onError: () => toast.error('Failed to update subscription')
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      api.patch(`/notification-subscriptions/${id}`, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
    },
    onError: () => toast.error('Failed to update subscription')
  })

  const deliveryMut = useMutation({
    mutationFn: ({ id, digest_frequency }: { id: number; digest_frequency: DigestFrequency }) =>
      api.patch(`/notification-subscriptions/${id}`, { digest_frequency }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
      toast.success('Delivery updated')
    },
    onError: () => toast.error('Failed to update delivery')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/notification-subscriptions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
      setDeleting(null)
      toast.success('Subscription deleted')
    },
    onError: () => toast.error('Failed to delete subscription')
  })

  function editingFormState(sub: Subscription): SubscriptionFormState {
    return {
      label: sub.label ?? '',
      collection: sub.collection,
      event_type: sub.event_type,
      filter_field: sub.filter_field ?? '',
      filter_value: sub.filter_value ?? '',
      is_active: sub.is_active
    }
  }

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='border-b border-border px-6 py-4 flex items-center justify-between shrink-0'>
        <div className='flex items-center gap-2.5'>
          <Bell className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>My Subscriptions</h1>
        </div>
        <Button size='sm' onClick={() => setCreating(true)}>
          <Plus className='h-4 w-4 mr-1.5' />
          Add Subscription
        </Button>
      </div>

      {/* Body */}
      <div className='flex-1 overflow-auto p-6'>
        {isLoading ? (
          <div className='space-y-3'>
            {[1, 2, 3].map((i) => (
              <div key={i} className='h-16 rounded-lg bg-muted animate-pulse' />
            ))}
          </div>
        ) : subscriptions.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <Bell className='h-10 w-10 text-muted-foreground mb-3' />
            <p className='text-sm font-medium text-foreground mb-1'>No subscriptions yet</p>
            <p className='text-sm text-muted-foreground max-w-xs'>
              Add one to start getting notified when events happen in a collection.
            </p>
            <Button className='mt-4' size='sm' onClick={() => setCreating(true)}>
              <Plus className='h-4 w-4 mr-1.5' />
              Add Subscription
            </Button>
          </div>
        ) : (
          <div className='rounded-lg border border-border overflow-hidden'>
            <table className='w-full text-sm'>
              <thead className='bg-muted/40 border-b border-border'>
                <tr>
                  <th className='text-left px-4 py-3 font-medium text-muted-foreground'>Label</th>
                  <th className='text-left px-4 py-3 font-medium text-muted-foreground'>
                    Collection
                  </th>
                  <th className='text-left px-4 py-3 font-medium text-muted-foreground'>Event</th>
                  <th className='text-left px-4 py-3 font-medium text-muted-foreground'>Filter</th>
                  <th className='text-left px-4 py-3 font-medium text-muted-foreground'>
                    Delivery
                  </th>
                  <th className='text-left px-4 py-3 font-medium text-muted-foreground'>Active</th>
                  <th className='text-right px-4 py-3 font-medium text-muted-foreground'>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className='divide-y divide-border'>
                {subscriptions.map((sub) => (
                  <tr key={sub.id} className='bg-card hover:bg-muted/20 transition-colors'>
                    <td className='px-4 py-3 font-medium'>
                      {sub.label ? (
                        <span>{sub.label}</span>
                      ) : (
                        <span className='text-muted-foreground italic'>Unlabeled</span>
                      )}
                    </td>
                    <td className='px-4 py-3'>
                      <code className='rounded bg-muted px-1.5 py-0.5 text-[12px] font-mono'>
                        {sub.collection}
                      </code>
                    </td>
                    <td className='px-4 py-3'>{eventTypeBadge(sub.event_type)}</td>
                    <td className='px-4 py-3 text-muted-foreground text-[12px]'>
                      {sub.filter_field ? (
                        <span className='font-mono'>
                          {sub.filter_field}
                          {sub.filter_value ? ` = ${sub.filter_value}` : ''}
                        </span>
                      ) : (
                        <span className='text-muted-foreground/50'>—</span>
                      )}
                    </td>
                    <td className='px-4 py-3'>
                      <DeliveryCombobox
                        value={sub.digest_frequency ?? 'instant'}
                        onChange={(v) => deliveryMut.mutate({ id: sub.id, digest_frequency: v })}
                        disabled={deliveryMut.isPending}
                      />
                    </td>
                    <td className='px-4 py-3'>
                      <Switch
                        checked={sub.is_active}
                        onCheckedChange={(v) => toggleMut.mutate({ id: sub.id, is_active: v })}
                        disabled={toggleMut.isPending}
                      />
                    </td>
                    <td className='px-4 py-3'>
                      <div className='flex items-center gap-1 justify-end'>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-8 w-8'
                          onClick={() => setEditing(sub)}
                        >
                          <Pencil className='h-3.5 w-3.5' />
                        </Button>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-8 w-8 text-destructive hover:text-destructive'
                          onClick={() => setDeleting(sub)}
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Subscription</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <SubscriptionForm
              onSave={(form) => createMut.mutate(form)}
              onCancel={() => setCreating(false)}
              saving={createMut.isPending}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Subscription</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {editing && (
              <SubscriptionForm
                initial={editingFormState(editing)}
                onSave={(form) => updateMut.mutate({ id: editing.id, body: form })}
                onCancel={() => setEditing(null)}
                saving={updateMut.isPending}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Subscription</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className='text-sm text-muted-foreground'>
              Are you sure you want to delete{' '}
              <span className='font-medium text-foreground'>
                {deleting?.label || `${deleting?.collection} (${deleting?.event_type})`}
              </span>
              ? This cannot be undone.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDeleting(null)}
              disabled={deleteMut.isPending}
            >
              Cancel
            </Button>
            <Button
              variant='destructive'
              onClick={() => deleting && deleteMut.mutate(deleting.id)}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
