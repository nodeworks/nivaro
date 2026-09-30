import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, ChevronsUpDown, Plus, RefreshCw, Trash2, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, type Collection } from '@/lib/api'
import { useGoBack } from '@/lib/nav'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type HeaderPair = { key: string; value: string }

type ConditionRow = { field: string; op: string; value: string }

const CONDITION_OPS: Array<{ value: string; label: string; needsValue: boolean }> = [
  { value: 'eq', label: 'is', needsValue: true },
  { value: 'neq', label: 'is not', needsValue: true },
  { value: 'in', label: 'is one of', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'gt', label: 'is greater than', needsValue: true },
  { value: 'gte', label: 'is at least', needsValue: true },
  { value: 'lt', label: 'is less than', needsValue: true },
  { value: 'lte', label: 'is at most', needsValue: true },
  { value: 'nnull', label: 'has a value', needsValue: false },
  { value: 'null', label: 'is empty', needsValue: false }
]

type MatchVerdict = {
  would_fire: boolean
  enabled: boolean
  collection_matches: boolean
  event_matches: boolean
  conditions_match: boolean
  rules: Array<{ field: string; op: string; value: unknown; actual: unknown; pass: boolean }>
}

type WebhookForm = {
  name: string
  collections: string[]
  events: string[]
  url: string
  method: string
  headers: HeaderPair[]
  secret: string
  enabled: boolean
  conditions: ConditionRow[]
}

type WebhookDelivery = {
  id: number
  event: string
  status_code: number | null
  request_body: string | null
  response_body: string | null
  latency_ms: number | null
  success: boolean
  attempt: number
  created_at: string
}

type Webhook = {
  id: string
  name: string
  collections: string[]
  events: string[]
  url: string
  method: string
  headers: Record<string, string> | null
  secret: string | null
  enabled: boolean
  conditions?: Array<{ field: string; op: string; value?: unknown }>
}

const ALL_EVENTS = ['create', 'update', 'delete'] as const

function headersToPairs(headers: Record<string, string> | null | undefined): HeaderPair[] {
  if (!headers) return []
  return Object.entries(headers).map(([key, value]) => ({ key, value }))
}

function pairsToHeaders(pairs: HeaderPair[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs) {
    if (p.key.trim()) out[p.key.trim()] = p.value
  }
  return out
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function WebhookEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const goBack = useGoBack('/webhooks')
  const queryClient = useQueryClient()
  const isNew = id === 'new'

  const [form, setForm] = useState<WebhookForm>({
    name: '',
    collections: [],
    events: ['create'],
    url: '',
    method: 'POST',
    headers: [],
    secret: '',
    enabled: true,
    conditions: []
  })
  const [matchCollection, setMatchCollection] = useState('')
  const [matchItem, setMatchItem] = useState('')
  const [matchVerdict, setMatchVerdict] = useState<MatchVerdict | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [collectionSearch, setCollectionSearch] = useState('')
  const [collectionOpen, setCollectionOpen] = useState(false)

  const { data: collectionsData } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () => api.get('/collections?tables_only=true').then((r) => r.data.data as Collection[])
  })
  // Task events (#1008) are offered as their own source: a webhook left on
  // "All collections" never receives them — it has to name Tasks.
  const allCollections = [
    ...(collectionsData ?? []),
    ...((collectionsData ?? []).some((c) => c.collection === 'nivaro_tasks')
      ? []
      : [
          {
            collection: 'nivaro_tasks',
            display_name: 'Tasks (created, reassigned, completed)'
          } as Collection
        ])
  ]

  const { data, isLoading } = useQuery({
    queryKey: ['webhooks', id],
    queryFn: () => api.get(`/webhooks/${id}`).then((r) => r.data.data as Webhook),
    enabled: !isNew && !!id
  })

  useEffect(() => {
    if (data) {
      setForm({
        name: data.name ?? '',
        collections: data.collections ?? [],
        events: data.events ?? [],
        url: data.url ?? '',
        method: data.method ?? 'POST',
        headers: headersToPairs(data.headers),
        secret: data.secret ?? '',
        enabled: data.enabled ?? true,
        conditions: (data.conditions ?? []).map((c) => ({
          field: c.field,
          op: c.op,
          value: c.value == null ? '' : String(c.value)
        }))
      })
    }
  }, [data])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      isNew
        ? api.post('/webhooks', body).then((r) => r.data)
        : api.patch(`/webhooks/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] })
      toast.success(isNew ? 'Webhook created' : 'Webhook saved')
      navigate('/webhooks')
    },
    onError: () => toast.error('Failed to save webhook')
  })

  // #86 — a test can replay a stored delivery's payload, or any edited JSON.
  const [testPayload, setTestPayload] = useState('')
  const [payloadFrom, setPayloadFrom] = useState<number | null>(null)
  const parsedTestPayload = (() => {
    if (!testPayload.trim()) return { ok: true as const, value: undefined }
    try {
      return { ok: true as const, value: JSON.parse(testPayload) as unknown }
    } catch {
      return { ok: false as const, value: undefined }
    }
  })()
  const deliveries = useQuery({
    queryKey: ['webhook-deliveries', id],
    queryFn: () =>
      api
        .get<{ data: WebhookDelivery[]; total: number }>(`/webhooks/${id}/deliveries`, {
          params: { limit: 10 }
        })
        .then((r) => r.data),
    enabled: !isNew
  })
  const testWebhook = useMutation({
    mutationFn: () =>
      api
        .post(
          `/webhooks/${id}/test`,
          parsedTestPayload.value !== undefined ? { payload: parsedTestPayload.value } : {}
        )
        .then((r) => r.data),
    onSuccess: (res) => {
      setTestResult(JSON.stringify(res, null, 2))
      toast.success('Test request sent')
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: unknown; status?: number } }
      setTestResult(
        JSON.stringify(
          { status: e.response?.status ?? 'error', body: e.response?.data ?? String(err) },
          null,
          2
        )
      )
      toast.error('Test failed')
    }
  })

  function toggleEvent(event: string) {
    setForm((p) => ({
      ...p,
      events: p.events.includes(event) ? p.events.filter((e) => e !== event) : [...p.events, event]
    }))
  }

  function toggleCollection(name: string) {
    setForm((p) => ({
      ...p,
      collections: p.collections.includes(name)
        ? p.collections.filter((c) => c !== name)
        : [...p.collections, name]
    }))
  }

  const filteredCollections = allCollections.filter((col) => {
    const q = collectionSearch.trim().toLowerCase()
    if (!q) return true
    return (
      col.collection.toLowerCase().includes(q) || (col.display_name ?? '').toLowerCase().includes(q)
    )
  })

  function handleSave() {
    if (!form.name.trim() || !form.url.trim()) {
      toast.error('Name and URL are required')
      return
    }
    save.mutate({
      name: form.name,
      collections: form.collections,
      events: form.events,
      url: form.url,
      method: form.method,
      headers: pairsToHeaders(form.headers),
      secret: form.secret || null,
      enabled: form.enabled,
      conditions: cleanConditions(form.conditions)
    })
  }

  function cleanConditions(rows: ConditionRow[]) {
    return rows
      .filter((r) => r.field.trim())
      .map((r) => {
        const needsValue = CONDITION_OPS.find((o) => o.value === r.op)?.needsValue ?? true
        return { field: r.field.trim(), op: r.op, value: needsValue ? r.value : null }
      })
  }

  const matchRecord = useMutation({
    mutationFn: () =>
      api
        .post(`/webhooks/${id}/match`, {
          collection: matchCollection || form.collections[0],
          item: matchItem.trim(),
          conditions: cleanConditions(form.conditions),
          event: form.events[0] ?? 'update'
        })
        .then((r) => r.data.data as MatchVerdict),
    onSuccess: (v) => setMatchVerdict(v),
    onError: (err: unknown) => {
      setMatchVerdict(null)
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'The record could not be checked')
    }
  })

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <button
              type='button'
              onClick={goBack}
              className='flex items-center gap-1.5 rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700'
            >
              <ArrowLeft className='h-4 w-4' />
            </button>
            <span className='text-[13px] text-slate-400'>/</span>
            <span className='text-[13px] font-medium text-slate-500'>Webhooks</span>
            <span className='text-[13px] text-slate-400'>/</span>
            <span className='text-[13px] font-semibold text-slate-900'>
              {isNew ? 'New Webhook' : (data?.name ?? 'Webhook')}
            </span>
          </div>
          <Button size='sm' onClick={handleSave} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <div className='p-8'>
        {!isNew && isLoading ? (
          <div className='mx-auto max-w-2xl space-y-4'>
            <Skeleton className='h-40 w-full rounded-xl' />
            <Skeleton className='h-32 w-full rounded-xl' />
          </div>
        ) : (
          <div className='mx-auto max-w-2xl space-y-5'>
            {/* Settings */}
            <div className='rounded-xl border border-slate-200 bg-white p-6'>
              <h2 className='mb-4 text-[13px] font-semibold text-slate-900'>Webhook Settings</h2>
              <div className='space-y-4'>
                <div className='space-y-1.5'>
                  <Label htmlFor='wh-name'>
                    Name <span className='text-red-500'>*</span>
                  </Label>
                  <Input
                    id='wh-name'
                    value={form.name}
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder='e.g. Notify Slack on order'
                  />
                </div>

                <div className='space-y-1.5'>
                  <Label htmlFor='wh-collections'>Collections</Label>
                  <Popover open={collectionOpen} onOpenChange={setCollectionOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        id='wh-collections'
                        variant='outline'
                        role='combobox'
                        aria-expanded={collectionOpen}
                        className='h-auto min-h-10 w-full justify-between'
                      >
                        <div className='flex flex-wrap gap-1'>
                          {form.collections.length === 0 ? (
                            <span className='text-muted-foreground'>All collections</span>
                          ) : (
                            form.collections.map((c) => (
                              <Badge key={c} variant='secondary' className='text-xs'>
                                {allCollections.find((col) => col.collection === c)?.display_name ??
                                  c}
                              </Badge>
                            ))
                          )}
                        </div>
                        <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className='w-[400px] p-0' align='start'>
                      <div className='border-b border-slate-100 p-2'>
                        <Input
                          value={collectionSearch}
                          onChange={(e) => setCollectionSearch(e.target.value)}
                          placeholder='Search collections...'
                          className='h-9'
                        />
                      </div>
                      <div className='max-h-60 overflow-auto p-1'>
                        {filteredCollections.length === 0 ? (
                          <p className='px-3 py-6 text-center text-[12px] text-slate-400'>
                            No collections found.
                          </p>
                        ) : (
                          filteredCollections.map((col) => (
                            <button
                              key={col.collection}
                              type='button'
                              onClick={() => toggleCollection(col.collection)}
                              className='flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[13px] text-slate-700 transition-colors hover:bg-slate-100'
                            >
                              <Check
                                className={cn(
                                  'mr-2 h-4 w-4',
                                  form.collections.includes(col.collection)
                                    ? 'opacity-100'
                                    : 'opacity-0'
                                )}
                              />
                              {col.display_name ?? col.collection}
                            </button>
                          ))
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <p className='text-[11px] text-slate-400'>
                    Select none to fire for all collections.
                  </p>
                </div>

                <div className='space-y-1.5'>
                  <Label>Events</Label>
                  <div className='flex flex-wrap gap-2'>
                    {ALL_EVENTS.map((event) => (
                      <label
                        key={event}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[12px] font-medium capitalize transition-colors',
                          form.events.includes(event)
                            ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-cyan'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                        )}
                      >
                        <input
                          type='checkbox'
                          className='h-3.5 w-3.5 accent-nvr-cyan'
                          checked={form.events.includes(event)}
                          onChange={() => toggleEvent(event)}
                        />
                        {event}
                      </label>
                    ))}
                  </div>
                </div>

                <div className='grid grid-cols-[1fr_auto] gap-3'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='wh-url'>
                      URL <span className='text-red-500'>*</span>
                    </Label>
                    <Input
                      id='wh-url'
                      type='url'
                      value={form.url}
                      onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
                      placeholder='https://example.com/hook'
                      className='font-mono text-[13px]'
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='wh-method'>Method</Label>
                    <Select
                      value={form.method}
                      onValueChange={(v) => setForm((p) => ({ ...p, method: v }))}
                    >
                      <SelectTrigger id='wh-method' className='w-28'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='GET'>GET</SelectItem>
                        <SelectItem value='POST'>POST</SelectItem>
                        <SelectItem value='PUT'>PUT</SelectItem>
                        <SelectItem value='PATCH'>PATCH</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className='flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-4 py-3 dark:border-border dark:bg-[#1c2230]'>
                  <div>
                    <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                      Enabled
                    </p>
                    <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                      Webhook fires only when enabled.
                    </p>
                  </div>
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
                  />
                </div>
              </div>
            </div>

            {/* Conditions: fire only for records that match */}
            <div
              data-webhook-conditions
              className='rounded-xl border border-slate-200 bg-white p-6 dark:border-border dark:bg-card'
            >
              <h2 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
                Only for records where
              </h2>
              <p className='mb-4 mt-1 max-w-[68ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
                Leave this empty to send every record. With conditions, the webhook fires only when
                the record meets all of them. A field can be a column or a path through a relation,
                such as <span className='font-mono'>vendor.name</span>.
              </p>
              <div className='space-y-2'>
                {form.conditions.map((c, i) => {
                  const needsValue = CONDITION_OPS.find((o) => o.value === c.op)?.needsValue ?? true
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: condition rows have no stable id
                    <div key={i} data-webhook-condition={i} className='flex items-center gap-2'>
                      <Input
                        aria-label={`Condition ${i + 1} field`}
                        placeholder='field'
                        value={c.field}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            conditions: p.conditions.map((r, j) =>
                              j === i ? { ...r, field: e.target.value } : r
                            )
                          }))
                        }
                        className='w-56 font-mono text-[12px]'
                      />
                      <Select
                        value={c.op}
                        onValueChange={(v) =>
                          setForm((p) => ({
                            ...p,
                            conditions: p.conditions.map((r, j) => (j === i ? { ...r, op: v } : r))
                          }))
                        }
                      >
                        <SelectTrigger
                          aria-label={`Condition ${i + 1} operator`}
                          className='w-44 text-[12px]'
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONDITION_OPS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {needsValue ? (
                        <Input
                          aria-label={`Condition ${i + 1} value`}
                          placeholder={c.op === 'in' ? 'a, b, c' : 'value'}
                          value={c.value}
                          onChange={(e) =>
                            setForm((p) => ({
                              ...p,
                              conditions: p.conditions.map((r, j) =>
                                j === i ? { ...r, value: e.target.value } : r
                              )
                            }))
                          }
                          className='flex-1 text-[12px]'
                        />
                      ) : (
                        <div className='flex-1' />
                      )}
                      <Button
                        type='button'
                        variant='ghost'
                        size='sm'
                        aria-label={`Remove condition ${i + 1}`}
                        onClick={() =>
                          setForm((p) => ({
                            ...p,
                            conditions: p.conditions.filter((_, j) => j !== i)
                          }))
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  )
                })}
              </div>
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='mt-3'
                data-webhook-condition-add
                onClick={() =>
                  setForm((p) => ({
                    ...p,
                    conditions: [...p.conditions, { field: '', op: 'eq', value: '' }]
                  }))
                }
              >
                <Plus size={13} className='mr-1' />
                Add condition
              </Button>

              {!isNew && (
                <div className='mt-5 border-t border-slate-100 pt-4 dark:border-border'>
                  <p className='text-[12px] font-medium text-slate-800 dark:text-foreground'>
                    Would a record fire this webhook?
                  </p>
                  <p className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                    Checks a real record against the conditions above, saved or not. Nothing is
                    sent.
                  </p>
                  <div className='mt-2 flex flex-wrap items-center gap-2'>
                    {form.collections.length > 1 && (
                      <Select
                        value={matchCollection || form.collections[0]}
                        onValueChange={setMatchCollection}
                      >
                        <SelectTrigger aria-label='Collection' className='w-52 text-[12px]'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {form.collections.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Input
                      aria-label='Record id'
                      placeholder='record id'
                      value={matchItem}
                      onChange={(e) => setMatchItem(e.target.value)}
                      className='w-40 font-mono text-[12px]'
                      data-webhook-match-item
                    />
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      data-webhook-match
                      disabled={
                        !matchItem.trim() || form.collections.length === 0 || matchRecord.isPending
                      }
                      onClick={() => matchRecord.mutate()}
                    >
                      {matchRecord.isPending ? 'Checking…' : 'Check record'}
                    </Button>
                    {form.collections.length === 0 && (
                      <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                        Pick a collection above first.
                      </span>
                    )}
                  </div>
                  {matchVerdict && (
                    <div
                      data-webhook-match-result={matchVerdict.would_fire ? 'fires' : 'held'}
                      className={cn(
                        'mt-3 rounded-lg border px-3 py-2 text-[12px]',
                        matchVerdict.would_fire
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-[#12261c] dark:text-emerald-200'
                          : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-[#2a2113] dark:text-amber-200'
                      )}
                    >
                      <p className='font-medium'>
                        {matchVerdict.would_fire
                          ? 'This record would fire the webhook.'
                          : 'This record would not fire the webhook.'}
                      </p>
                      <ul className='mt-1 space-y-0.5'>
                        {!matchVerdict.enabled && <li>The webhook is switched off.</li>}
                        {!matchVerdict.collection_matches && (
                          <li>The webhook does not listen to this collection.</li>
                        )}
                        {!matchVerdict.event_matches && (
                          <li>The webhook does not listen to this event.</li>
                        )}
                        {matchVerdict.rules.map((r) => (
                          <li key={`${r.field}-${r.op}`} className='font-mono'>
                            {r.pass ? '✓' : '✕'} {r.field}{' '}
                            {CONDITION_OPS.find((o) => o.value === r.op)?.label ?? r.op}
                            {r.value != null && r.value !== '' ? ` ${String(r.value)}` : ''}
                            <span className='opacity-70'>
                              {' '}
                              · record has{' '}
                              {r.actual == null || r.actual === '' ? 'nothing' : String(r.actual)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Headers */}
            <div className='rounded-xl border border-slate-200 bg-white p-6'>
              <h2 className='mb-4 text-[13px] font-semibold text-slate-900'>Headers</h2>
              <div className='space-y-2'>
                {form.headers.length === 0 && (
                  <p className='text-[12px] text-slate-400'>No custom headers.</p>
                )}
                {form.headers.map((h, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: header rows have no stable id
                  <div key={i} className='flex items-center gap-2'>
                    <Input
                      value={h.key}
                      onChange={(e) =>
                        setForm((p) => {
                          const headers = [...p.headers]
                          headers[i] = { ...headers[i], key: e.target.value }
                          return { ...p, headers }
                        })
                      }
                      placeholder='Header'
                      className='font-mono text-[12px]'
                    />
                    <Input
                      value={h.value}
                      onChange={(e) =>
                        setForm((p) => {
                          const headers = [...p.headers]
                          headers[i] = { ...headers[i], value: e.target.value }
                          return { ...p, headers }
                        })
                      }
                      placeholder='Value'
                      className='font-mono text-[12px]'
                    />
                    <button
                      type='button'
                      className='rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500'
                      onClick={() =>
                        setForm((p) => ({ ...p, headers: p.headers.filter((_, j) => j !== i) }))
                      }
                      aria-label='Remove header'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type='button'
                onClick={() =>
                  setForm((p) => ({ ...p, headers: [...p.headers, { key: '', value: '' }] }))
                }
                className='mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-2 text-[12px] font-medium text-slate-500 transition-colors hover:border-nvr-cyan/50 hover:bg-slate-50 hover:text-nvr-cyan'
              >
                <Plus className='h-3.5 w-3.5' /> Add Header
              </button>
            </div>

            {/* Secret */}
            <div className='rounded-xl border border-slate-200 bg-white p-6'>
              <h2 className='mb-4 text-[13px] font-semibold text-slate-900'>Signing Secret</h2>
              <div className='flex items-center gap-2'>
                <Input
                  type='password'
                  value={form.secret}
                  onChange={(e) => setForm((p) => ({ ...p, secret: e.target.value }))}
                  placeholder='Optional HMAC secret'
                  className='font-mono text-[12px]'
                />
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => setForm((p) => ({ ...p, secret: crypto.randomUUID() }))}
                >
                  <RefreshCw className='mr-1.5 h-3.5 w-3.5' /> Regenerate
                </Button>
              </div>
            </div>

            {/* Test */}
            {!isNew && (
              <div className='rounded-xl border border-slate-200 bg-white p-6'>
                <div className='flex items-center justify-between'>
                  <div>
                    <h2 className='text-[13px] font-semibold text-slate-900'>Test Delivery</h2>
                    <p className='mt-0.5 text-[11px] text-slate-400'>
                      Send a sample payload to the configured URL.
                    </p>
                  </div>
                  <Button
                    onClick={() => testWebhook.mutate()}
                    disabled={testWebhook.isPending || !parsedTestPayload.ok}
                    className='gap-2'
                    data-webhook-test
                  >
                    <Zap className='h-3.5 w-3.5' />
                    {testWebhook.isPending
                      ? 'Sending…'
                      : testPayload.trim()
                        ? 'Send this payload'
                        : 'Test'}
                  </Button>
                </div>
                <div className='mt-3'>
                  <Label className='text-[11px] text-slate-500'>
                    Payload{' '}
                    {payloadFrom
                      ? `(from delivery #${payloadFrom} — edit freely)`
                      : '(blank = sample)'}
                  </Label>
                  <textarea
                    value={testPayload}
                    onChange={(e) => {
                      setTestPayload(e.target.value)
                      if (payloadFrom && !e.target.value.trim()) setPayloadFrom(null)
                    }}
                    rows={testPayload ? 8 : 2}
                    spellCheck={false}
                    data-webhook-test-payload
                    placeholder='{"event": "…", "data": {…}} — leave blank to send the built-in sample'
                    className={cn(
                      'mt-1 w-full rounded-md border bg-white px-2.5 py-2 font-mono text-[11.5px] dark:bg-background',
                      parsedTestPayload.ok
                        ? 'border-slate-200 dark:border-border'
                        : 'border-red-400'
                    )}
                  />
                  {!parsedTestPayload.ok && (
                    <p className='mt-1 text-[11px] text-red-600'>Not valid JSON.</p>
                  )}
                </div>
                {testResult && (
                  <pre className='mt-4 max-h-64 overflow-auto rounded-lg bg-[#0f172a] p-3 font-mono text-[11px] text-slate-100'>
                    {testResult}
                  </pre>
                )}
              </div>
            )}

            {/* Recent deliveries (#86): pick one to replay, as-is or edited */}
            {!isNew && (
              <div
                className='rounded-xl border border-slate-200 bg-white p-6'
                data-webhook-deliveries
              >
                <div className='flex items-center justify-between'>
                  <div>
                    <h2 className='text-[13px] font-semibold text-slate-900'>Recent deliveries</h2>
                    <p className='mt-0.5 text-[11px] text-slate-400'>
                      Replay a real payload through the test button, edited or not.
                      {deliveries.data ? ` ${deliveries.data.total} on record.` : ''}
                    </p>
                  </div>
                </div>
                {deliveries.isLoading ? (
                  <Skeleton className='mt-3 h-8 rounded' />
                ) : (deliveries.data?.data ?? []).length === 0 ? (
                  <p className='mt-3 text-[12px] text-slate-400'>No deliveries yet.</p>
                ) : (
                  <div className='mt-3 divide-y divide-slate-100'>
                    {(deliveries.data?.data ?? []).map((d) => (
                      <div
                        key={d.id}
                        className='flex flex-wrap items-center gap-2 py-1.5 text-[12px]'
                        data-webhook-delivery={d.id}
                      >
                        <span
                          className={cn(
                            'h-2 w-2 rounded-full',
                            d.success ? 'bg-emerald-500' : 'bg-red-500'
                          )}
                        />
                        <span className='font-mono text-slate-700'>#{d.id}</span>
                        <span className='text-slate-600'>{d.event}</span>
                        <span className='text-slate-400'>
                          {d.status_code ?? '—'} · {d.latency_ms ?? '—'}ms · attempt {d.attempt}
                        </span>
                        <span className='ml-auto text-[11px] text-slate-400'>
                          {new Date(d.created_at).toLocaleString()}
                        </span>
                        <button
                          type='button'
                          data-webhook-use-payload={d.id}
                          disabled={!d.request_body}
                          onClick={() => {
                            let body = d.request_body ?? ''
                            try {
                              body = JSON.stringify(JSON.parse(body), null, 2)
                            } catch {
                              /* raw */
                            }
                            setTestPayload(body)
                            setPayloadFrom(d.id)
                            setTestResult(null)
                          }}
                          className='rounded border border-slate-200 px-1.5 py-0.5 text-[10.5px] text-slate-600 hover:bg-slate-50 disabled:opacity-40'
                        >
                          Use as test payload
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
