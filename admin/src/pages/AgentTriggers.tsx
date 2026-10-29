import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  KeyRound,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  Webhook,
  X,
  Zap
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
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
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { UserCombobox } from '@/components/user-combobox'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Agent triggers (#3210) — MCP → Agent triggers. A record event wakes a remote agent or
 * routine: the record's context (read as the trigger's owner) is posted, signed, to an HTTPS
 * endpoint, retried, and logged; a wake-up that gives up waits here as a dead letter.
 */

type EventKey = 'create' | 'update' | 'transition'
interface Condition {
  field: string
  op: string
  value: string | number | null
}
interface Trigger {
  id: number
  name: string
  description: string | null
  enabled: boolean
  collection: string
  events: EventKey[]
  conditions: Condition[]
  to_states: string[]
  fields: string[] | null
  instructions: string | null
  url: string
  signing_secret: string | null
  headers: Record<string, string>
  max_attempts: number
  owner: string
  owner_name: string | null
  last_fired_at: string | null
  last_7_days?: { delivered: number; dead: number; retrying: number; skipped: number }
}
interface Delivery {
  id: number
  trigger_id: number
  delivery_id: string
  event: string
  collection: string
  item: string | null
  status: 'sending' | 'retrying' | 'delivered' | 'dead' | 'discarded' | 'skipped'
  attempts: number
  max_attempts: number
  next_attempt_at: string | null
  last_status_code: number | null
  last_error: string | null
  latency_ms: number | null
  created_at: string
  request_body?: string | null
  response_body?: string | null
}
interface Config {
  ready: boolean
  triggers: Trigger[]
  ops: string[]
  max_attempts_cap: number
}

const MASK = '••••••'
const EVENTS: Array<{ key: EventKey; label: string; hint: string }> = [
  { key: 'create', label: 'Created', hint: 'A new record is saved' },
  { key: 'update', label: 'Changed', hint: 'A record is edited' },
  { key: 'transition', label: 'Moved', hint: 'A record moves to another state' }
]
const OP_LABEL: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  in: 'is one of',
  null: 'is empty',
  nnull: 'is filled in'
}
const STATUS_TONE: Record<Delivery['status'], string> = {
  delivered: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  sending: 'bg-nvr-cyan/10 text-[#0e7490] dark:text-[#67e8f9]',
  retrying: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  dead: 'bg-red-500/10 text-red-700 dark:text-red-400',
  discarded: 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-muted-foreground',
  skipped: 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-muted-foreground'
}
const STATUS_LABEL: Record<Delivery['status'], string> = {
  delivered: 'Delivered',
  sending: 'Sending',
  retrying: 'Will retry',
  dead: 'Gave up',
  discarded: 'Discarded',
  skipped: 'Skipped'
}

const errMsg = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
  'Something went wrong'
const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

type Draft = Omit<Trigger, 'id' | 'owner_name' | 'last_fired_at' | 'last_7_days'> & {
  headerRows: Array<{ name: string; value: string }>
}

const draftOf = (t: Trigger | null, me: string): Draft => ({
  name: t?.name ?? '',
  description: t?.description ?? null,
  enabled: t?.enabled ?? true,
  collection: t?.collection ?? '',
  events: t?.events ?? ['create'],
  conditions: t?.conditions ?? [],
  to_states: t?.to_states ?? [],
  fields: t?.fields ?? null,
  instructions: t?.instructions ?? null,
  url: t?.url ?? 'https://',
  signing_secret: t?.signing_secret ?? null,
  headers: t?.headers ?? {},
  headerRows: Object.entries(t?.headers ?? {}).map(([name, value]) => ({ name, value })),
  max_attempts: t?.max_attempts ?? 5,
  owner: t?.owner ?? me
})

function randomSecret(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function AgentTriggersPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [sel, setSel] = useState<number | 'new' | 'dead' | null>(() => {
    const id = Number(new URLSearchParams(window.location.search).get('trigger'))
    return Number.isInteger(id) && id > 0 ? id : null
  })
  const config = useQuery({
    queryKey: ['agent-triggers'],
    queryFn: async () => (await api.get('/agent-triggers')).data.data as Config
  })
  const collections = useQuery({
    queryKey: ['agent-triggers', 'collections'],
    queryFn: async () =>
      ((await api.get('/collections')).data.data as Array<{ collection: string }>).filter(
        (c) => !/^(nivaro|directus)_/i.test(c.collection)
      ),
    staleTime: 5 * 60_000
  })
  const triggers = config.data?.triggers ?? []
  const current = typeof sel === 'number' ? (triggers.find((t) => t.id === sel) ?? null) : null
  const deadTotal = triggers.reduce((n, t) => n + (t.last_7_days?.dead ?? 0), 0)

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar
        description='Wake a remote agent or routine when a record is created, changed or moves to a state. Each wake-up carries the record as its owner reads it, signed with the trigger’s secret, and is retried until the agent answers.'
        actions={
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
            disabled={!config.data?.ready}
            onClick={() => setSel('new')}
          >
            <Plus className='mr-1 h-3.5 w-3.5' /> New trigger
          </Button>
        }
      />
      {config.data && !config.data.ready && (
        <div className='shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-900 sm:px-6 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
          Agent triggers need database migration 510.
        </div>
      )}
      <div className='flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row'>
        <aside className='max-h-[40vh] shrink-0 overflow-y-auto border-b border-slate-200 bg-white md:max-h-none md:w-[272px] md:border-b-0 md:border-r dark:border-border dark:bg-card'>
          {config.isLoading ? (
            <div className='space-y-2 p-3'>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className='h-10 w-full' />
              ))}
            </div>
          ) : config.isError ? (
            <p className='p-4 text-[12px] text-red-600 dark:text-red-400'>{errMsg(config.error)}</p>
          ) : (
            <section className='pt-3'>
              <h2 className='flex items-center justify-between px-3 pb-1.5 text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
                Triggers
                <span className='tabular-nums'>{triggers.length}</span>
              </h2>
              <ul className='space-y-px px-1.5'>
                {sel === 'new' && (
                  <ListRow active title='New trigger' sub='Not saved yet' onClick={() => {}} />
                )}
                {triggers.length === 0 && sel !== 'new' && (
                  <li className='px-1.5 pb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
                    None yet. A trigger wakes an agent when a record changes.
                  </li>
                )}
                {triggers.map((t) => (
                  <ListRow
                    key={t.id}
                    active={sel === t.id}
                    title={t.name}
                    sub={`${t.collection} · ${t.events.map((e) => EVENTS.find((x) => x.key === e)?.label ?? e).join(', ')}`}
                    off={!t.enabled}
                    dead={t.last_7_days?.dead ?? 0}
                    onClick={() => setSel(t.id)}
                  />
                ))}
              </ul>
              <div className='mt-3 border-t border-slate-100 px-1.5 py-2 dark:border-border'>
                <ListRow
                  active={sel === 'dead'}
                  title='Dead letters'
                  sub='Wake-ups that gave up, every trigger'
                  dead={deadTotal}
                  onClick={() => setSel('dead')}
                />
              </div>
            </section>
          )}
        </aside>
        <div className='min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {sel === 'dead' ? (
            <div className='px-4 py-5 sm:px-6'>
              <h2 className='mb-1 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                Dead letters
              </h2>
              <p className='mb-4 max-w-[70ch] text-[12.5px] text-slate-600 dark:text-muted-foreground'>
                Wake-ups whose endpoint never answered with a success. Retry sends the same signed
                body once more (same delivery id, so the agent can drop a repeat); discard drops it.
              </p>
              <DeliveryLog status='dead' triggers={triggers} />
            </div>
          ) : sel === 'new' || current ? (
            <TriggerEditor
              key={sel === 'new' ? 'new' : String(current?.id)}
              trigger={current}
              me={String(user?.id ?? '')}
              ops={config.data?.ops ?? Object.keys(OP_LABEL)}
              cap={config.data?.max_attempts_cap ?? 10}
              collections={(collections.data ?? []).map((c) => c.collection)}
              onSaved={(t) => {
                void qc.invalidateQueries({ queryKey: ['agent-triggers'] })
                setSel(t.id)
              }}
              onDeleted={() => {
                void qc.invalidateQueries({ queryKey: ['agent-triggers'] })
                setSel(null)
              }}
              onCancel={() => setSel(null)}
            />
          ) : (
            <NothingSelected />
          )}
        </div>
      </div>
    </div>
  )
}

function ListRow({
  title,
  sub,
  active,
  off,
  dead,
  onClick
}: {
  title: string
  sub: string
  active?: boolean
  off?: boolean
  dead?: number
  onClick: () => void
}) {
  return (
    <li className='list-none'>
      <button
        type='button'
        onClick={onClick}
        className={cn(
          'flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
          active ? 'bg-nvr-cyan/10' : 'hover:bg-muted'
        )}
      >
        <span className='flex w-full items-center gap-1.5'>
          <span className='truncate text-[12.5px] text-slate-900 dark:text-foreground'>
            {title}
          </span>
          {off && (
            <span className='shrink-0 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500 dark:bg-muted dark:text-muted-foreground'>
              Off
            </span>
          )}
          {!!dead && (
            <span
              className='ml-auto shrink-0 rounded bg-red-500/10 px-1 text-[10px] font-semibold tabular-nums text-red-700 dark:text-red-400'
              data-tip={`${dead} gave up in the last 7 days`}
            >
              {dead}
            </span>
          )}
        </span>
        <span className='w-full truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {sub}
        </span>
      </button>
    </li>
  )
}

function NothingSelected() {
  return (
    <div className='flex h-full flex-col items-start justify-center gap-2 px-6 py-16 sm:px-10'>
      <Zap className='h-6 w-6 text-slate-400' />
      <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
        Let records wake your agents
      </h2>
      <p className='max-w-[62ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
        A trigger watches one collection. When a record is created, changed or moves to a state (and
        matches its conditions), Nivaro posts the record’s ids and fields to your agent’s HTTPS
        endpoint — only the fields the trigger’s owner may read — signed with a secret, and retries
        until the agent answers. The agent can call back through MCP to read more or act.
      </p>
    </div>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className='grid gap-1.5 border-t border-slate-100 py-4 first:border-t-0 first:pt-0 md:grid-cols-[200px_1fr] md:gap-6 dark:border-border'>
      <div>
        <Label className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
          {label}
        </Label>
        {hint && (
          <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
        )}
      </div>
      <div className='min-w-0'>{children}</div>
    </div>
  )
}

function CollectionCombobox({
  value,
  options,
  onChange
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full max-w-[420px] justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !value && 'font-sans text-muted-foreground')}>
            {value || 'Pick a collection…'}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No collection
            </CommandEmpty>
            <CommandGroup>
              {options.map((c) => (
                <CommandItem
                  key={c}
                  value={c}
                  onSelect={() => {
                    onChange(c)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === c ? 'opacity-100' : 'opacity-0')}
                  />
                  {c}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TriggerEditor({
  trigger,
  me,
  ops,
  cap,
  collections,
  onSaved,
  onDeleted,
  onCancel
}: {
  trigger: Trigger | null
  me: string
  ops: string[]
  cap: number
  collections: string[]
  onSaved: (t: Trigger) => void
  onDeleted: () => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const initial = useMemo(() => draftOf(trigger, me), [trigger, me])
  const [d, setD] = useState<Draft>(initial)
  const [statesText, setStatesText] = useState(initial.to_states.join(', '))
  const [fieldsText, setFieldsText] = useState((initial.fields ?? []).join(', '))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [previewItem, setPreviewItem] = useState('')
  const [preview, setPreview] = useState<{ body: unknown; skipped: string | null } | null>(null)
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const isNew = !trigger

  const payload = () => ({
    name: d.name.trim(),
    description: d.description?.trim() || null,
    enabled: d.enabled,
    collection: d.collection,
    events: d.events,
    conditions: d.conditions.filter((c) => c.field.trim()),
    to_states: list(statesText),
    fields: list(fieldsText),
    instructions: d.instructions?.trim() || null,
    url: d.url.trim(),
    signing_secret: d.signing_secret,
    headers: Object.fromEntries(
      d.headerRows.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])
    ),
    max_attempts: d.max_attempts,
    owner: d.owner
  })

  const save = useMutation({
    mutationFn: async () =>
      isNew
        ? ((await api.post('/agent-triggers', payload())).data.data as Trigger)
        : ((await api.patch(`/agent-triggers/${trigger.id}`, payload())).data.data as Trigger),
    onSuccess: (t) => {
      toast.success(isNew ? 'Trigger created' : 'Saved')
      onSaved(t)
    },
    onError: (e) => toast.error(errMsg(e))
  })
  const remove = useMutation({
    mutationFn: async () => api.delete(`/agent-triggers/${trigger?.id}`),
    onSuccess: () => {
      toast.success('Trigger removed')
      onDeleted()
    },
    onError: (e) => toast.error(errMsg(e))
  })
  const test = useMutation({
    mutationFn: async () =>
      (await api.post(`/agent-triggers/${trigger?.id}/test`)).data.data as Delivery,
    onSuccess: (r) => {
      if (r?.status === 'delivered')
        toast.success(`The endpoint answered ${r.last_status_code} in ${r.latency_ms} ms`)
      else toast.error(`Test failed: ${r?.last_error ?? 'no answer'}`)
      void qc.invalidateQueries({ queryKey: ['agent-trigger-deliveries'] })
    },
    onError: (e) => toast.error(errMsg(e))
  })
  const runPreview = useMutation({
    mutationFn: async () =>
      (await api.post(`/agent-triggers/${trigger?.id}/preview`, { item: previewItem.trim() })).data
        .data as { body: unknown; skipped: string | null },
    onSuccess: setPreview,
    onError: (e) => toast.error(errMsg(e))
  })

  const urlOk = /^https:\/\/[^\s/]+/i.test(d.url.trim())
  const problem = !d.name.trim()
    ? 'Give the trigger a name.'
    : !d.collection
      ? 'Pick the collection it watches.'
      : d.events.length === 0
        ? 'Pick at least one event.'
        : !urlOk
          ? 'The endpoint must be an https:// address.'
          : d.signing_secret && d.signing_secret !== MASK && d.signing_secret.length < 16
            ? 'The signing secret needs at least 16 characters.'
            : null

  return (
    <div className='px-4 py-5 sm:px-6'>
      <div className='mb-4 flex flex-wrap items-center gap-3'>
        <h2 className='min-w-0 flex-1 truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          {isNew ? 'New trigger' : trigger.name}
        </h2>
        {!isNew && (
          <Button
            size='sm'
            variant='outline'
            className='h-7 text-[12px]'
            disabled={test.isPending}
            onClick={() => test.mutate()}
            data-tip='Posts a signed test ping (no record) to the endpoint'
          >
            <Send className='mr-1 h-3.5 w-3.5' /> {test.isPending ? 'Sending…' : 'Send a test'}
          </Button>
        )}
        {!isNew &&
          (confirmDelete ? (
            <span className='flex items-center gap-1.5 text-[12px]'>
              <span className='text-slate-600 dark:text-muted-foreground'>
                Remove it and its delivery log?
              </span>
              <Button
                size='sm'
                variant='destructive'
                className='h-7'
                onClick={() => remove.mutate()}
              >
                Remove
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className='h-7'
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </Button>
            </span>
          ) : (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 text-slate-500 hover:text-red-600'
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className='mr-1 h-3.5 w-3.5' /> Remove
            </Button>
          ))}
      </div>

      <div className='rounded-lg border border-slate-200 bg-white p-4 sm:p-5 dark:border-border dark:bg-card'>
        <Row label='Name'>
          <Input
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder='Review new purchase orders'
            className='h-8 max-w-[420px] text-[12.5px]'
          />
        </Row>
        <Row label='Watches' hint='System tables cannot be watched.'>
          <CollectionCombobox
            value={d.collection}
            options={collections}
            onChange={(collection) => set({ collection })}
          />
        </Row>
        <Row label='Wakes the agent when'>
          <div className='flex flex-wrap gap-1.5'>
            {EVENTS.map((ev) => {
              const on = d.events.includes(ev.key)
              return (
                <button
                  key={ev.key}
                  type='button'
                  aria-pressed={on}
                  data-tip={ev.hint}
                  onClick={() =>
                    set({
                      events: on ? d.events.filter((e) => e !== ev.key) : [...d.events, ev.key]
                    })
                  }
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors',
                    on
                      ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                      : 'border-slate-200 text-slate-500 hover:text-slate-900 dark:border-border dark:text-muted-foreground dark:hover:text-foreground'
                  )}
                >
                  {ev.label}
                </button>
              )
            })}
          </div>
          {d.events.includes('transition') && (
            <div className='mt-2'>
              <Input
                value={statesText}
                onChange={(e) => setStatesText(e.target.value)}
                placeholder='Any state — or state keys, comma-separated (review, approved)'
                className='h-8 max-w-[420px] text-[12.5px]'
                aria-label='States that wake the agent'
              />
            </div>
          )}
        </Row>
        <Row
          label='Only when'
          hint='Every condition must hold. Dotted names follow a relation (vendor.country).'
        >
          <Conditions
            value={d.conditions}
            ops={ops}
            onChange={(conditions) => set({ conditions })}
          />
        </Row>
        <Row
          label='Sends'
          hint='Leave empty for every field the owner may read. The record is always read as the owner.'
        >
          <Input
            value={fieldsText}
            onChange={(e) => setFieldsText(e.target.value)}
            placeholder='All the owner can read — or field names, comma-separated'
            className='h-8 max-w-[520px] font-mono text-[12px]'
          />
        </Row>
        <Row
          label='Owner'
          hint='The record is read as this person: their role, field access and user scopes decide what the agent receives.'
        >
          <UserCombobox
            value={d.owner}
            onChange={(v) => v && set({ owner: v })}
            searchServer
            hideNone
            className='h-8 w-full max-w-[420px] text-[12.5px]'
          />
        </Row>
        <Row label='Instructions' hint='Handed to the agent with every wake-up, as `instructions`.'>
          <Textarea
            value={d.instructions ?? ''}
            onChange={(e) => set({ instructions: e.target.value })}
            rows={3}
            placeholder='Check the vendor is approved and the total fits the budget; ask the requester if anything is missing.'
            className='max-w-[640px] text-[12.5px]'
          />
        </Row>
        <Row label='Endpoint' hint='HTTPS only. Redirects are never followed.'>
          <Input
            value={d.url}
            onChange={(e) => set({ url: e.target.value })}
            placeholder='https://agent.example.com/hooks/nivaro'
            className='h-8 max-w-[520px] font-mono text-[12px]'
            aria-invalid={!urlOk}
          />
        </Row>
        <Row
          label='Signing secret'
          hint={
            <>
              Signs <code className='font-mono'>X-Nivaro-Signature</code>: sha256 HMAC of{' '}
              <code className='font-mono'>&lt;X-Nivaro-Timestamp&gt;.&lt;body&gt;</code>.
            </>
          }
        >
          <div className='flex max-w-[520px] items-center gap-2'>
            <Input
              type='password'
              autoComplete='new-password'
              value={d.signing_secret ?? ''}
              onChange={(e) => set({ signing_secret: e.target.value || null })}
              placeholder='At least 16 characters'
              className='h-8 font-mono text-[12px]'
            />
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-8 shrink-0 text-[12px]'
              onClick={() => {
                const s = randomSecret()
                set({ signing_secret: s })
                void navigator.clipboard?.writeText(s).then(
                  () => toast.success('New secret copied — give it to the agent, then save'),
                  () => toast.message('New secret set — copy it before saving')
                )
              }}
            >
              <KeyRound className='mr-1 h-3.5 w-3.5' /> Generate
            </Button>
          </div>
        </Row>
        <Row
          label='Headers'
          hint='For an Authorization bearer the endpoint expects. Values are hidden once saved.'
        >
          <HeaderRows rows={d.headerRows} onChange={(headerRows) => set({ headerRows })} />
        </Row>
        <Row label='Attempts' hint='Retries back off: 30 s, 2 min, 10 min, 30 min, 2 h, 6 h.'>
          <SimpleSelect
            value={String(d.max_attempts)}
            onChange={(v) => set({ max_attempts: Number(v) })}
            ariaLabel='Attempts'
            className='h-8 w-[200px] text-[12.5px]'
            options={Array.from({ length: cap }, (_, i) => ({
              value: String(i + 1),
              label: i === 0 ? '1 (no retry)' : `${i + 1}`
            }))}
          />
        </Row>
        <Row label='On' hint='Off keeps it here without waking anyone.'>
          <Switch
            checked={d.enabled}
            onCheckedChange={(v) => set({ enabled: v })}
            aria-label='On'
          />
        </Row>
      </div>

      <div className='mt-4 flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!!problem || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : isNew ? 'Create trigger' : 'Save'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onCancel}>
          Cancel
        </Button>
        {problem && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>{problem}</span>
        )}
      </div>

      {!isNew && (
        <>
          <section className='mt-6 rounded-lg border border-slate-200 bg-white p-4 sm:p-5 dark:border-border dark:bg-card'>
            <h3 className='text-[13px] font-medium text-slate-900 dark:text-foreground'>
              What the agent would get
            </h3>
            <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              The body for one record, read as the owner. Nothing is sent.
            </p>
            <form
              className='mt-3 flex max-w-[420px] items-center gap-2'
              onSubmit={(e) => {
                e.preventDefault()
                if (previewItem.trim()) runPreview.mutate()
              }}
            >
              <Input
                value={previewItem}
                onChange={(e) => setPreviewItem(e.target.value)}
                placeholder={`A ${trigger.collection} record id`}
                className='h-8 font-mono text-[12px]'
              />
              <Button
                type='submit'
                size='sm'
                variant='outline'
                className='h-8 shrink-0 text-[12px]'
                disabled={!previewItem.trim() || runPreview.isPending}
              >
                Preview
              </Button>
            </form>
            {preview &&
              (preview.skipped ? (
                <p className='mt-3 text-[12px] text-amber-700 dark:text-amber-300'>
                  Would be skipped: {preview.skipped}.
                </p>
              ) : (
                <pre className='mt-3 max-h-[320px] overflow-auto rounded-md bg-[#0f172a] p-3 font-mono text-[11.5px] leading-relaxed text-slate-100'>
                  {JSON.stringify(preview.body, null, 2)}
                </pre>
              ))}
          </section>
          <section className='mt-6'>
            <h3 className='mb-2 text-[13px] font-medium text-slate-900 dark:text-foreground'>
              Recent wake-ups
            </h3>
            <DeliveryLog triggerId={trigger.id} triggers={[trigger]} />
          </section>
        </>
      )}
    </div>
  )
}

function Conditions({
  value,
  ops,
  onChange
}: {
  value: Condition[]
  ops: string[]
  onChange: (v: Condition[]) => void
}) {
  const setAt = (i: number, patch: Partial<Condition>) =>
    onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  return (
    <div className='flex max-w-[640px] flex-col gap-2'>
      {value.length === 0 && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>Every record.</p>
      )}
      {value.map((c, i) => (
        <div key={i} className='flex flex-wrap items-center gap-1.5'>
          <Input
            value={c.field}
            onChange={(e) => setAt(i, { field: e.target.value.trim() })}
            placeholder='field'
            className='h-8 w-[160px] font-mono text-[12px]'
            aria-label='Field'
          />
          <SimpleSelect
            value={c.op}
            onChange={(op) => setAt(i, { op })}
            ariaLabel='Comparison'
            className='h-8 w-[150px] text-[12px]'
            options={ops.map((o) => ({ value: o, label: OP_LABEL[o] ?? o }))}
          />
          {c.op !== 'null' && c.op !== 'nnull' && (
            <Input
              value={c.value == null ? '' : String(c.value)}
              onChange={(e) => setAt(i, { value: e.target.value })}
              placeholder={c.op === 'in' ? 'a, b, c' : 'value'}
              className='h-8 w-[160px] text-[12px]'
              aria-label='Value'
            />
          )}
          <button
            type='button'
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className='rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            aria-label='Remove condition'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      ))}
      <button
        type='button'
        onClick={() => onChange([...value, { field: '', op: 'eq', value: '' }])}
        className='flex w-fit items-center gap-1 text-[12px] text-slate-500 hover:text-nvr-cyan dark:text-muted-foreground'
      >
        <Plus className='h-3.5 w-3.5' /> Add a condition
      </button>
    </div>
  )
}

function HeaderRows({
  rows,
  onChange
}: {
  rows: Array<{ name: string; value: string }>
  onChange: (rows: Array<{ name: string; value: string }>) => void
}) {
  const setAt = (i: number, patch: Partial<{ name: string; value: string }>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className='flex max-w-[640px] flex-col gap-2'>
      {rows.map((r, i) => (
        <div key={i} className='flex flex-wrap items-center gap-1.5'>
          <Input
            value={r.name}
            onChange={(e) => setAt(i, { name: e.target.value.trim() })}
            placeholder='Authorization'
            className='h-8 w-[180px] font-mono text-[12px]'
            aria-label='Header name'
          />
          <Input
            type='password'
            autoComplete='off'
            value={r.value}
            onChange={(e) => setAt(i, { value: e.target.value })}
            placeholder='Bearer …'
            className='h-8 min-w-0 flex-1 font-mono text-[12px]'
            aria-label='Header value'
          />
          <button
            type='button'
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className='rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            aria-label='Remove header'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      ))}
      <button
        type='button'
        onClick={() => onChange([...rows, { name: '', value: '' }])}
        className='flex w-fit items-center gap-1 text-[12px] text-slate-500 hover:text-nvr-cyan dark:text-muted-foreground'
      >
        <Plus className='h-3.5 w-3.5' /> Add a header
      </button>
    </div>
  )
}

function DeliveryLog({
  triggerId,
  status,
  triggers
}: {
  triggerId?: number
  status?: string
  triggers: Trigger[]
}) {
  const qc = useQueryClient()
  const [openId, setOpenId] = useState<number | null>(null)
  const log = useQuery({
    queryKey: ['agent-trigger-deliveries', triggerId ?? null, status ?? null],
    queryFn: async () =>
      (
        await api.get('/agent-triggers/deliveries', {
          params: { trigger: triggerId, status, limit: 50 }
        })
      ).data.data as Delivery[],
    refetchInterval: 15_000
  })
  const act = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: 'retry' | 'discard' }) =>
      (await api.post(`/agent-triggers/deliveries/${id}/${action}`)).data.data,
    onSuccess: (r, v) => {
      if (v.action === 'retry') {
        const d = r as Delivery
        if (d?.status === 'delivered') toast.success('Delivered')
        else toast.error(`Still failing: ${d?.last_error ?? 'no answer'}`)
      } else toast.success('Discarded')
      void qc.invalidateQueries({ queryKey: ['agent-trigger-deliveries'] })
      void qc.invalidateQueries({ queryKey: ['agent-triggers'] })
    },
    onError: (e) => toast.error(errMsg(e))
  })
  const names = new Map(triggers.map((t) => [t.id, t.name]))
  const rows = log.data ?? []
  if (log.isLoading)
    return (
      <div className='space-y-2'>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className='h-9 w-full' />
        ))}
      </div>
    )
  if (rows.length === 0)
    return (
      <p className='rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:text-muted-foreground'>
        {status === 'dead' ? 'Nothing gave up. Every wake-up got through.' : 'No wake-ups yet.'}
      </p>
    )
  return (
    <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
      {rows.map((d) => (
        <li key={d.id} className='text-[12px]'>
          <div className='flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2'>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10.5px] font-semibold',
                STATUS_TONE[d.status]
              )}
            >
              {STATUS_LABEL[d.status] ?? d.status}
            </span>
            {!triggerId && (
              <span className='font-medium text-slate-800 dark:text-foreground'>
                {names.get(d.trigger_id) ?? `Trigger ${d.trigger_id}`}
              </span>
            )}
            <span className='text-slate-600 dark:text-muted-foreground'>
              {d.event === 'test' ? 'Test ping' : `${d.event} · ${d.collection}/${d.item ?? ''}`}
            </span>
            <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
              {d.attempts}/{d.max_attempts} tries
              {d.last_status_code != null && ` · HTTP ${d.last_status_code}`}
              {d.latency_ms != null && ` · ${d.latency_ms} ms`}
            </span>
            <span
              className='ml-auto text-slate-400'
              title={new Date(d.created_at).toLocaleString()}
            >
              {formatRelative(d.created_at)}
            </span>
            <span className='flex items-center gap-1'>
              {(d.status === 'dead' || d.status === 'retrying') && (
                <>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-6 px-2 text-[11px]'
                    disabled={act.isPending}
                    onClick={() => act.mutate({ id: d.id, action: 'retry' })}
                  >
                    <RotateCcw className='mr-1 h-3 w-3' /> Retry
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-6 px-2 text-[11px] text-slate-500'
                    disabled={act.isPending}
                    onClick={() => act.mutate({ id: d.id, action: 'discard' })}
                  >
                    Discard
                  </Button>
                </>
              )}
              <Button
                size='sm'
                variant='ghost'
                className='h-6 px-2 text-[11px] text-slate-500'
                aria-expanded={openId === d.id}
                onClick={() => setOpenId(openId === d.id ? null : d.id)}
              >
                {openId === d.id ? 'Hide' : 'Details'}
              </Button>
            </span>
          </div>
          {(d.last_error || d.next_attempt_at) && (
            <p className='px-3 pb-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {d.last_error}
              {d.status === 'retrying' && d.next_attempt_at && (
                <> · next try {new Date(d.next_attempt_at).toLocaleTimeString()}</>
              )}
            </p>
          )}
          {openId === d.id && <DeliveryDetail id={d.id} />}
        </li>
      ))}
    </ul>
  )
}

function DeliveryDetail({ id }: { id: number }) {
  const q = useQuery({
    queryKey: ['agent-trigger-delivery', id],
    queryFn: async () => (await api.get(`/agent-triggers/deliveries/${id}`)).data.data as Delivery
  })
  if (q.isLoading) return <Skeleton className='mx-3 mb-3 h-24' />
  const pretty = (s: string | null | undefined) => {
    if (!s) return '—'
    try {
      return JSON.stringify(JSON.parse(s), null, 2)
    } catch {
      return s
    }
  }
  return (
    <div className='grid gap-3 px-3 pb-3 lg:grid-cols-2'>
      <div className='min-w-0'>
        <p className='mb-1 flex items-center gap-1 text-[11px] font-medium text-slate-500'>
          <Webhook className='h-3 w-3' /> Sent · delivery {q.data?.delivery_id}
        </p>
        <pre className='max-h-[280px] overflow-auto rounded-md bg-[#0f172a] p-3 font-mono text-[11px] leading-relaxed text-slate-100'>
          {pretty(q.data?.request_body)}
        </pre>
      </div>
      <div className='min-w-0'>
        <p className='mb-1 text-[11px] font-medium text-slate-500'>The endpoint answered</p>
        <pre className='max-h-[280px] overflow-auto rounded-md bg-[#0f172a] p-3 font-mono text-[11px] leading-relaxed text-slate-100'>
          {pretty(q.data?.response_body)}
        </pre>
      </div>
    </div>
  )
}
