import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { titleCase } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'

/**
 * The one subscription editor — create + edit for nivaro_notification_subscriptions,
 * shared by the profile's Notifications & alerts card and the My Subscriptions
 * page (admin hosts the same view). Every write goes through the user's own
 * /notification-subscriptions routes; both query keys that render
 * subscriptions are invalidated so the two surfaces never disagree.
 */

export const SUBSCRIPTION_EVENT_TYPES = [
  'all',
  'create',
  'update',
  'delete',
  'workflow_transition'
] as const
export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT_TYPES)[number]
export type DigestFrequency = 'instant' | 'daily' | 'weekly'

export const DELIVERY_OPTIONS: Array<{ value: DigestFrequency; label: string }> = [
  { value: 'instant', label: 'Instant' },
  { value: 'daily', label: 'Daily digest' },
  { value: 'weekly', label: 'Weekly digest' }
]

export interface SubscriptionRecord {
  id: number
  collection: string | null
  queue_id?: string | null
  event_type: string
  filter_field: string | null
  filter_value: string | null
  /** Parsed array, a JSON string (some list routes hand the raw column through), or null. */
  filters?: unknown
  label: string | null
  is_active: boolean | number
  digest_frequency: string | null
  notify_inapp?: boolean
  notify_email?: boolean
}

export interface SubscriptionFormState {
  label: string
  collection: string
  event_type: SubscriptionEventType
  filter_field: string
  filter_value: string
  filters_json: string
  is_active: boolean
  digest_frequency: DigestFrequency
  notify_inapp: boolean
  notify_email: boolean
}

export const DEFAULT_SUBSCRIPTION_FORM: SubscriptionFormState = {
  label: '',
  collection: '',
  event_type: 'all',
  filter_field: '',
  filter_value: '',
  filters_json: '',
  is_active: true,
  digest_frequency: 'instant',
  notify_inapp: true,
  notify_email: true
}

export function subscriptionToForm(sub: SubscriptionRecord): SubscriptionFormState {
  let filters_json = ''
  const raw = sub.filters
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(parsed) && parsed.length) filters_json = JSON.stringify(parsed, null, 2)
  } catch {
    filters_json = ''
  }
  const et = (SUBSCRIPTION_EVENT_TYPES as readonly string[]).includes(sub.event_type)
    ? (sub.event_type as SubscriptionEventType)
    : 'all'
  return {
    label: sub.label ?? '',
    collection: sub.collection ?? '',
    event_type: et,
    filter_field: sub.filter_field ?? '',
    filter_value: sub.filter_value ?? '',
    filters_json,
    is_active: sub.is_active !== false && sub.is_active !== 0,
    digest_frequency: (DELIVERY_OPTIONS.some((o) => o.value === sub.digest_frequency)
      ? sub.digest_frequency
      : 'instant') as DigestFrequency,
    notify_inapp: sub.notify_inapp !== false,
    notify_email: sub.notify_email !== false
  }
}

function parseFilters(json: string): unknown[] | undefined {
  try {
    const parsed = json.trim() ? JSON.parse(json) : undefined
    return Array.isArray(parsed) && parsed.length ? parsed : undefined
  } catch {
    return undefined
  }
}

function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { error?: string }; message?: string }
  return e?.response?.error ?? e?.message ?? fallback
}

/** Mutations for the user's own subscriptions. Invalidates BOTH readers —
 *  the flat list (My Subscriptions) and the profile's sources aggregate. */
export function useSubscriptionMutations() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
    void qc.invalidateQueries({ queryKey: ['me-notification-sources'] })
  }
  const create = useMutation({
    mutationFn: (form: SubscriptionFormState) =>
      client.request(
        post('/notification-subscriptions', {
          collection: form.collection.trim(),
          event_type: form.event_type,
          filter_field: form.filter_field.trim() || undefined,
          filter_value: form.filter_value.trim() || undefined,
          filters: parseFilters(form.filters_json),
          label: form.label.trim() || undefined,
          is_active: form.is_active,
          digest_frequency: form.digest_frequency,
          notify_inapp: form.notify_inapp,
          notify_email: form.notify_email
        })
      ),
    onSuccess: () => {
      invalidate()
      toast.success('Subscription created')
    },
    onError: (err) => toast.error(errorText(err, 'Failed to create subscription'))
  })
  const update = useMutation({
    mutationFn: ({ id, form }: { id: number; form: SubscriptionFormState }) =>
      client.request(
        patch(`/notification-subscriptions/${id}`, {
          label: form.label.trim() || null,
          filter_field: form.filter_field.trim() || null,
          filter_value: form.filter_value.trim() || null,
          filters: parseFilters(form.filters_json) ?? null,
          is_active: form.is_active,
          digest_frequency: form.digest_frequency,
          notify_inapp: form.notify_inapp,
          notify_email: form.notify_email
        })
      ),
    onSuccess: () => {
      invalidate()
      toast.success('Subscription updated')
    },
    onError: (err) => toast.error(errorText(err, 'Failed to update subscription'))
  })
  /** Partial field patch (active toggle, delivery, channels) — no toast, the
   *  control itself shows the new state. */
  const patchFields = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      client.request(patch(`/notification-subscriptions/${id}`, body)),
    onSuccess: invalidate,
    onError: (err) => toast.error(errorText(err, 'Failed to update subscription'))
  })
  const remove = useMutation({
    mutationFn: (id: number) => client.request(del(`/notification-subscriptions/${id}`)),
    onSuccess: () => {
      invalidate()
      toast.success('Subscription removed')
    },
    onError: (err) => toast.error(errorText(err, 'Failed to remove subscription'))
  })
  return { create, update, patchFields, remove }
}

// ── Pickers ──────────────────────────────────────────────────────────────────

interface CollectionMeta {
  collection: string
  display_name?: string | null
  hidden?: boolean | number
}

function CollectionPicker({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['nvr-collections-for-picker'],
    queryFn: () =>
      client.request<{ data: CollectionMeta[] }>(get('/collections')).then((r) => r.data),
    staleTime: 5 * 60_000
  })
  const options = (data ?? [])
    .filter((c) => !c.hidden && !c.collection.startsWith('nivaro_'))
    .sort((a, b) => a.collection.localeCompare(b.collection))
  const selected = options.find((c) => c.collection === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className='h-8 w-full justify-between px-2.5 text-[12.5px] font-normal'
        >
          <span className='truncate'>
            {selected
              ? `${selected.display_name || titleCase(selected.collection.replace(/_/g, ' '))}`
              : value || 'Choose a collection…'}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' className='text-[12.5px]' />
          <CommandList>
            <CommandEmpty>No collection matches.</CommandEmpty>
            <CommandGroup>
              {options.map((c) => (
                <CommandItem
                  key={c.collection}
                  value={`${c.collection} ${c.display_name ?? ''}`}
                  onSelect={() => {
                    onChange(c.collection)
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
                >
                  <Check
                    className={`mr-2 h-3 w-3 ${value === c.collection ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <span className='truncate'>
                    {c.display_name || titleCase(c.collection.replace(/_/g, ' '))}
                  </span>
                  <span className='ml-auto truncate pl-2 font-mono text-[10.5px] text-slate-400'>
                    {c.collection}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Workflow-state picker for workflow_transition subscriptions: the states
 *  of the pipeline bound to the collection, so nobody types a state key. */
function StatePicker({
  collection,
  value,
  onChange
}: {
  collection: string
  value: string
  onChange: (v: string) => void
}) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-collection-states', collection],
    queryFn: () =>
      client
        .request<{ data: Array<{ key: string; label: string; color?: string }> }>(
          get(`/queues/collection-states/${encodeURIComponent(collection)}`)
        )
        .then((r) => r.data),
    enabled: !!collection,
    staleTime: 5 * 60_000
  })
  const states = data ?? []
  if (!collection) {
    return <p className='text-[11.5px] text-slate-400'>Pick a collection first.</p>
  }
  if (states.length === 0) {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder='State key (this collection has no pipeline bound)'
        className='h-8 font-mono text-[12px]'
      />
    )
  }
  return (
    <SimpleSelect
      value={value}
      onChange={onChange}
      options={[
        { value: '', label: 'Any state (every transition)' },
        ...states.map((s) => ({ value: s.key, label: s.label }))
      ]}
    />
  )
}

// ── Form + dialog ─────────────────────────────────────────────────────────────

export function SubscriptionForm({
  initial,
  onSave,
  onCancel,
  saving,
  editing
}: {
  initial?: SubscriptionFormState
  onSave: (form: SubscriptionFormState) => void
  onCancel: () => void
  saving: boolean
  editing?: boolean
}) {
  const [form, setForm] = useState<SubscriptionFormState>(initial ?? DEFAULT_SUBSCRIPTION_FORM)
  const set = <K extends keyof SubscriptionFormState>(key: K, value: SubscriptionFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))
  const isTransition = form.event_type === 'workflow_transition'
  const isValid = form.collection.trim().length > 0

  return (
    <div className='space-y-4'>
      <div className='space-y-1.5'>
        <Label htmlFor='nvr-sub-collection'>
          Collection <span className='text-red-500'>*</span>
        </Label>
        {editing ? (
          <p className='font-mono text-[12.5px] text-slate-600 dark:text-slate-300'>
            {form.collection}
          </p>
        ) : (
          <CollectionPicker
            value={form.collection}
            onChange={(v) => {
              set('collection', v)
              if (isTransition) set('filter_value', '')
            }}
          />
        )}
      </div>

      <div className='space-y-1.5'>
        <Label>Notify me when</Label>
        <SimpleSelect
          value={form.event_type}
          onChange={(v) => {
            set('event_type', v as SubscriptionEventType)
            if (v === 'workflow_transition') set('filter_field', 'to_state')
            else if (form.filter_field === 'to_state') {
              set('filter_field', '')
              set('filter_value', '')
            }
          }}
          options={[
            { value: 'all', label: 'Anything changes (create, update, delete)' },
            { value: 'create', label: 'A record is created' },
            { value: 'update', label: 'A record is updated' },
            { value: 'delete', label: 'A record is deleted' },
            { value: 'workflow_transition', label: 'A record enters a workflow state' }
          ]}
        />
      </div>

      {isTransition ? (
        <div className='space-y-1.5'>
          <Label>Workflow state</Label>
          <StatePicker
            collection={form.collection}
            value={form.filter_value}
            onChange={(v) => {
              set('filter_field', 'to_state')
              set('filter_value', v)
            }}
          />
        </div>
      ) : (
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label htmlFor='nvr-sub-filter-field'>Only when field (optional)</Label>
            <Input
              id='nvr-sub-filter-field'
              value={form.filter_field}
              onChange={(e) => set('filter_field', e.target.value)}
              placeholder='e.g. status'
              className='h-8 font-mono text-[12px]'
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='nvr-sub-filter-value'>equals</Label>
            <Input
              id='nvr-sub-filter-value'
              value={form.filter_value}
              onChange={(e) => set('filter_value', e.target.value)}
              placeholder='e.g. open'
              disabled={!form.filter_field.trim()}
              className='h-8 font-mono text-[12px]'
            />
          </div>
        </div>
      )}

      {isTransition && (
        <div className='space-y-1.5'>
          <Label htmlFor='nvr-sub-filters'>Record filters (JSON, optional)</Label>
          <Textarea
            id='nvr-sub-filters'
            value={form.filters_json}
            onChange={(e) => set('filters_json', e.target.value)}
            rows={4}
            spellCheck={false}
            className='font-mono text-[11.5px]'
            placeholder={
              '[\n  { "field": "divisions", "op": "intersects", "value": [2] },\n  { "field": "project.project_type", "op": "in", "value": ["3"] }\n]'
            }
          />
          <p className='text-[11px] text-slate-500 dark:text-slate-400'>
            AND-evaluated against the record. Fields may be plain columns, dotted relation paths, or
            M2M alias fields. Ops: eq, in, intersects, null, nnull.
          </p>
        </div>
      )}

      <div className='space-y-1.5'>
        <Label htmlFor='nvr-sub-label'>Label (optional)</Label>
        <Input
          id='nvr-sub-label'
          value={form.label}
          onChange={(e) => set('label', e.target.value)}
          placeholder='How this shows in your list'
          className='h-8 text-[12.5px]'
        />
      </div>

      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label>Delivery</Label>
          <SimpleSelect
            value={form.digest_frequency}
            onChange={(v) => set('digest_frequency', v as DigestFrequency)}
            options={DELIVERY_OPTIONS}
          />
        </div>
        <div className='space-y-1.5'>
          <Label>Channels</Label>
          <div className='flex h-8 items-center gap-4 text-[12.5px]'>
            <span className='flex items-center gap-1.5'>
              <Switch
                id='nvr-sub-inapp'
                checked={form.notify_inapp}
                onCheckedChange={(v) => set('notify_inapp', v)}
                className='scale-90'
              />
              <Label htmlFor='nvr-sub-inapp' className='cursor-pointer font-normal'>
                In-app
              </Label>
            </span>
            <span className='flex items-center gap-1.5'>
              <Switch
                id='nvr-sub-email'
                checked={form.notify_email}
                onCheckedChange={(v) => set('notify_email', v)}
                className='scale-90'
              />
              <Label htmlFor='nvr-sub-email' className='cursor-pointer font-normal'>
                Email
              </Label>
            </span>
          </div>
        </div>
      </div>

      <span className='flex items-center gap-2 text-[12.5px]'>
        <Switch
          id='nvr-sub-active'
          checked={form.is_active}
          onCheckedChange={(v) => set('is_active', v)}
        />
        <Label htmlFor='nvr-sub-active' className='cursor-pointer font-normal'>
          Active
        </Label>
      </span>

      <DialogFooter>
        <Button type='button' variant='outline' onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type='button' onClick={() => onSave(form)} disabled={saving || !isValid}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Subscribe'}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** Create/edit dialog. `subscription` null = create; an object = edit it. */
export function SubscriptionDialog({
  open,
  onOpenChange,
  subscription,
  initial
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  subscription?: SubscriptionRecord | null
  /** Seed for a NEW subscription (e.g. a collection preselected by the caller). */
  initial?: Partial<SubscriptionFormState>
}) {
  const { create, update } = useSubscriptionMutations()
  const editing = !!subscription
  const saving = create.isPending || update.isPending
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-lg'>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit subscription' : 'New subscription'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change what you are told about and how it reaches you.'
              : 'Get told when something happens in a collection — instantly or folded into a digest.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {open && (
            <SubscriptionForm
              key={subscription?.id ?? 'new'}
              editing={editing}
              initial={
                subscription
                  ? subscriptionToForm(subscription)
                  : { ...DEFAULT_SUBSCRIPTION_FORM, ...(initial ?? {}) }
              }
              saving={saving}
              onCancel={() => onOpenChange(false)}
              onSave={(form) => {
                const done = { onSuccess: () => onOpenChange(false) }
                if (subscription) update.mutate({ id: subscription.id, form }, done)
                else create.mutate(form, done)
              }}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
