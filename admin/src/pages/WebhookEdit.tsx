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
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type HeaderPair = { key: string; value: string }

type WebhookForm = {
  name: string
  collections: string[]
  events: string[]
  url: string
  method: string
  headers: HeaderPair[]
  secret: string
  enabled: boolean
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
    enabled: true
  })
  const [testResult, setTestResult] = useState<string | null>(null)
  const [collectionSearch, setCollectionSearch] = useState('')
  const [collectionOpen, setCollectionOpen] = useState(false)

  const { data: collectionsData } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () => api.get('/collections?tables_only=true').then((r) => r.data.data as Collection[])
  })
  const allCollections = collectionsData ?? []

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
        enabled: data.enabled ?? true
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

  const testWebhook = useMutation({
    mutationFn: () => api.post(`/webhooks/${id}/test`).then((r) => r.data),
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
      enabled: form.enabled
    })
  }

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <button
              type='button'
              onClick={() => navigate('/webhooks')}
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

                <div className='flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-4 py-3'>
                  <div>
                    <p className='text-[13px] font-medium text-slate-800'>Enabled</p>
                    <p className='text-[11px] text-slate-400'>Webhook fires only when enabled.</p>
                  </div>
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
                  />
                </div>
              </div>
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
                    disabled={testWebhook.isPending}
                    className='gap-2'
                  >
                    <Zap className='h-3.5 w-3.5' />
                    {testWebhook.isPending ? 'Sending…' : 'Test'}
                  </Button>
                </div>
                {testResult && (
                  <pre className='mt-4 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100'>
                    {testResult}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
