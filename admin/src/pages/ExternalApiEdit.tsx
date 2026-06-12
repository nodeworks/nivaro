import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Download,
  FileJson,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Workflow
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PluginSlot } from '@/extensions/slots'
import { api, type ExternalApiCallLog, type ExternalApiEndpoint } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { ExternalApi } from './ExternalApis'

type AuthType = ExternalApi['auth_type']

const AUTH_OPTIONS: { value: AuthType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'api_key', label: 'API Key' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'oauth2_cc', label: 'OAuth2 Client Credentials' }
]

interface FormState {
  name: string
  base_url: string
  description: string
  auth_type: AuthType
  auth_config: Record<string, string>
  headers: { key: string; value: string }[]
  enabled: boolean
  integration_type: string
}

const EMPTY: FormState = {
  name: '',
  base_url: '',
  description: '',
  auth_type: 'none',
  auth_config: {},
  headers: [],
  enabled: true,
  integration_type: ''
}

export function ExternalApiEditPage() {
  const { id } = useParams<{ id: string }>()
  const isNew = id === 'new'
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState>(EMPTY)

  const { data, isLoading } = useQuery<ExternalApi>({
    queryKey: ['external-api', id],
    queryFn: () => api.get<{ data: ExternalApi }>(`/external-apis/${id}`).then((r) => r.data.data),
    enabled: !isNew
  })

  useEffect(() => {
    if (data) {
      setForm({
        name: data.name,
        base_url: data.base_url,
        description: data.description ?? '',
        auth_type: data.auth_type,
        auth_config: (data.auth_config ?? {}) as Record<string, string>,
        headers: Object.entries(data.headers ?? {}).map(([key, value]) => ({
          key,
          value: String(value)
        })),
        enabled: data.enabled,
        integration_type: data.integration_type ?? ''
      })
    }
  }, [data])

  const save = useMutation({
    mutationFn: () => {
      const headersObj: Record<string, string> = {}
      for (const h of form.headers) {
        if (h.key.trim()) headersObj[h.key.trim()] = h.value
      }
      const payload = {
        name: form.name,
        base_url: form.base_url,
        description: form.description || null,
        auth_type: form.auth_type,
        auth_config: form.auth_type === 'none' ? null : form.auth_config,
        headers: Object.keys(headersObj).length ? headersObj : null,
        enabled: form.enabled,
        integration_type: form.integration_type || null
      }
      return isNew
        ? api.post<{ data: ExternalApi }>('/external-apis', payload).then((r) => r.data.data)
        : api.patch<{ data: ExternalApi }>(`/external-apis/${id}`, payload).then((r) => r.data.data)
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['external-apis'] })
      queryClient.invalidateQueries({ queryKey: ['external-api', String(saved.id)] })
      toast.success(isNew ? 'API created' : 'API saved')
      navigate('/external-apis')
    },
    onError: () => toast.error('Failed to save')
  })

  function setAuthField(field: string, value: string) {
    setForm((f) => ({ ...f, auth_config: { ...f.auth_config, [field]: value } }))
  }

  function addHeader() {
    setForm((f) => ({ ...f, headers: [...f.headers, { key: '', value: '' }] }))
  }
  function updateHeader(idx: number, field: 'key' | 'value', value: string) {
    setForm((f) => ({
      ...f,
      headers: f.headers.map((h, i) => (i === idx ? { ...h, [field]: value } : h))
    }))
  }
  function removeHeader(idx: number) {
    setForm((f) => ({ ...f, headers: f.headers.filter((_, i) => i !== idx) }))
  }

  if (!isNew && isLoading) {
    return <div className='p-8 text-muted-foreground'>Loading…</div>
  }

  const canSave = form.name.trim() && form.base_url.trim()

  return (
    <div className='p-8 max-w-3xl'>
      <button
        type='button'
        onClick={() => navigate('/external-apis')}
        className='mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-900'
      >
        <ArrowLeft className='h-4 w-4' />
        Back to External APIs
      </button>

      <div className='mb-6 flex items-center justify-between'>
        <h1 className='text-2xl font-bold text-slate-900'>
          {isNew ? 'New External API' : form.name || 'Edit External API'}
        </h1>
        <Button
          onClick={() => save.mutate()}
          disabled={!canSave || save.isPending}
          className='gap-1.5'
        >
          <Save className='h-4 w-4' />
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <Card className='p-6 space-y-5'>
        <div className='space-y-1.5'>
          <Label>Name *</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder='e.g. Oracle EBS'
          />
        </div>

        <div className='space-y-1.5'>
          <Label>Base URL *</Label>
          <Input
            value={form.base_url}
            onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
            placeholder='https://api.example.com/v1'
            className='font-mono text-[13px]'
          />
        </div>

        <div className='space-y-1.5'>
          <Label>Description</Label>
          <Textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            rows={2}
          />
        </div>

        <div className='flex items-center justify-between rounded-md border border-slate-200 px-3 py-2.5'>
          <div>
            <Label className='cursor-pointer'>Enabled</Label>
            <p className='text-[12px] text-slate-400'>Allow this API to be used.</p>
          </div>
          <Switch
            checked={form.enabled}
            onCheckedChange={(enabled) => setForm((f) => ({ ...f, enabled }))}
          />
        </div>
      </Card>

      <Card className='mt-5 p-6 space-y-5'>
        <div className='space-y-1.5'>
          <Label>Authentication</Label>
          <Select
            value={form.auth_type}
            onValueChange={(v) =>
              setForm((f) => ({ ...f, auth_type: v as AuthType, auth_config: {} }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTH_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <AuthConfigFields
          authType={form.auth_type}
          config={form.auth_config}
          setField={setAuthField}
        />
      </Card>

      <Card className='mt-5 p-6'>
        <div className='mb-3 flex items-center justify-between'>
          <div>
            <Label>Extra Headers</Label>
            <p className='text-[12px] text-slate-400'>Static headers sent on every request.</p>
          </div>
          <Button variant='outline' size='sm' onClick={addHeader} className='gap-1.5'>
            <Plus className='h-3.5 w-3.5' />
            Add
          </Button>
        </div>
        {form.headers.length === 0 ? (
          <p className='text-[13px] text-slate-400'>No extra headers.</p>
        ) : (
          <div className='space-y-2'>
            {form.headers.map((h, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: header rows are positional
              <div key={idx} className='flex items-center gap-2'>
                <Input
                  placeholder='Header'
                  value={h.key}
                  onChange={(e) => updateHeader(idx, 'key', e.target.value)}
                  className='flex-1 font-mono text-[13px]'
                />
                <Input
                  placeholder='Value'
                  value={h.value}
                  onChange={(e) => updateHeader(idx, 'value', e.target.value)}
                  className='flex-1 font-mono text-[13px]'
                />
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-9 w-9 p-0 text-slate-400 hover:text-red-500'
                  onClick={() => removeHeader(idx)}
                  aria-label='Remove header'
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className='mt-5 p-6 space-y-3'>
        <div className='space-y-1.5'>
          <Label>Integration Type</Label>
          <Input
            value={form.integration_type}
            onChange={(e) => setForm((f) => ({ ...f, integration_type: e.target.value }))}
            placeholder='e.g. sat-ng'
          />
          <p className='text-[12px] text-slate-400'>Tag this API for use by an extension plugin.</p>
        </div>
      </Card>

      {!isNew && data && <EndpointsCard apiId={data.id} />}
      {!isNew && data && <ConnectorCard apiId={data.id} apiName={data.name} />}
      {!isNew && data && <ApiCallLogsCard apiId={data.id} />}
      {!isNew && data && (
        <PluginSlot
          name='external-api-detail'
          ctx={{
            api: {
              ...data,
              integration_type: data.integration_type ?? null,
              integration_config: data.integration_config ?? null
            }
          }}
        />
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <div className='space-y-1.5'>
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

function AuthConfigFields({
  authType,
  config,
  setField
}: {
  authType: AuthType
  config: Record<string, string>
  setField: (field: string, value: string) => void
}) {
  if (authType === 'none') {
    return <p className='text-[13px] text-slate-400'>No authentication configured.</p>
  }

  if (authType === 'bearer') {
    return (
      <Field
        label='Token'
        type='password'
        value={config.token ?? ''}
        onChange={(v) => setField('token', v)}
      />
    )
  }

  if (authType === 'api_key') {
    return (
      <div className='space-y-4'>
        <Field
          label='Key Name'
          value={config.key ?? ''}
          onChange={(v) => setField('key', v)}
          placeholder='My API Key'
        />
        <Field
          label='Key Value'
          type='password'
          value={config.value ?? ''}
          onChange={(v) => setField('value', v)}
        />
        <div className='space-y-1.5'>
          <Label>Send In</Label>
          <Select value={config.in ?? 'header'} onValueChange={(v) => setField('in', v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='header'>Header</SelectItem>
              <SelectItem value='query'>Query Param</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Field
          label='Param Name'
          value={config.param_name ?? ''}
          onChange={(v) => setField('param_name', v)}
          placeholder='X-API-Key'
        />
      </div>
    )
  }

  if (authType === 'basic') {
    return (
      <div className='space-y-4'>
        <Field
          label='Username'
          value={config.username ?? ''}
          onChange={(v) => setField('username', v)}
        />
        <Field
          label='Password'
          type='password'
          value={config.password ?? ''}
          onChange={(v) => setField('password', v)}
        />
      </div>
    )
  }

  // oauth2_cc
  return (
    <div className='space-y-4'>
      <Field
        label='Client ID'
        value={config.client_id ?? ''}
        onChange={(v) => setField('client_id', v)}
      />
      <Field
        label='Client Secret'
        type='password'
        value={config.client_secret ?? ''}
        onChange={(v) => setField('client_secret', v)}
      />
      <Field
        label='Token URL'
        value={config.token_url ?? ''}
        onChange={(v) => setField('token_url', v)}
        placeholder='https://login.example.com/oauth2/token'
      />
      <Field
        label='Scope'
        value={config.scope ?? ''}
        onChange={(v) => setField('scope', v)}
        placeholder='optional'
      />
    </div>
  )
}

// ─── Endpoints card ───────────────────────────────────────────────────────────

type KVPair = { key: string; value: string }

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

interface EndpointForm {
  name: string
  slug: string
  method: string
  path: string
  description: string
  default_body: string
  default_query: KVPair[]
  default_headers: KVPair[]
}

const EMPTY_EP: EndpointForm = {
  name: '',
  slug: '',
  method: 'GET',
  path: '',
  description: '',
  default_body: '',
  default_query: [],
  default_headers: []
}

function epToForm(ep: ExternalApiEndpoint): EndpointForm {
  return {
    name: ep.name,
    slug: ep.slug ?? '',
    method: ep.method,
    path: ep.path,
    description: ep.description ?? '',
    default_body: ep.default_body != null ? JSON.stringify(ep.default_body, null, 2) : '',
    default_query: Object.entries(ep.default_query ?? {}).map(([key, value]) => ({ key, value })),
    default_headers: Object.entries(ep.default_headers ?? {}).map(([key, value]) => ({
      key,
      value
    }))
  }
}

function formToPayload(f: EndpointForm) {
  let parsedBody: unknown = null
  if (BODY_METHODS.has(f.method) && f.default_body.trim()) {
    try {
      parsedBody = JSON.parse(f.default_body)
    } catch {
      parsedBody = f.default_body
    }
  }
  const queryObj: Record<string, string> = {}
  for (const p of f.default_query) if (p.key.trim()) queryObj[p.key.trim()] = p.value
  const headersObj: Record<string, string> = {}
  for (const h of f.default_headers) if (h.key.trim()) headersObj[h.key.trim()] = h.value
  return {
    name: f.name,
    slug: f.slug.trim(),
    method: f.method,
    path: f.path,
    description: f.description || null,
    default_body: parsedBody,
    default_query: Object.keys(queryObj).length ? queryObj : null,
    default_headers: Object.keys(headersObj).length ? headersObj : null
  }
}

function InlineKVEditor({
  label,
  pairs,
  onChange
}: {
  label: string
  pairs: KVPair[]
  onChange: (p: KVPair[]) => void
}) {
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center justify-between'>
        <span className='text-[11px] font-medium text-slate-500'>{label}</span>
        <button
          type='button'
          onClick={() => onChange([...pairs, { key: '', value: '' }])}
          className='text-[11px] text-nvr-cyan hover:underline'
        >
          + Add
        </button>
      </div>
      {pairs.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional list
        <div key={i} className='flex items-center gap-1.5'>
          <Input
            placeholder='Key'
            value={p.key}
            onChange={(e) => {
              const n = [...pairs]
              n[i] = { ...p, key: e.target.value }
              onChange(n)
            }}
            className='flex-1 font-mono text-[12px] h-7 px-2'
          />
          <Input
            placeholder='Value'
            value={p.value}
            onChange={(e) => {
              const n = [...pairs]
              n[i] = { ...p, value: e.target.value }
              onChange(n)
            }}
            className='flex-1 font-mono text-[12px] h-7 px-2'
          />
          <button
            type='button'
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            className='text-slate-400 hover:text-red-500'
            aria-label='Remove'
          >
            <Trash2 className='h-3 w-3' />
          </button>
        </div>
      ))}
    </div>
  )
}

function EndpointEditor({
  form,
  onChange,
  onSave,
  onCancel,
  isSaving
}: {
  form: EndpointForm
  onChange: (f: EndpointForm) => void
  onSave: () => void
  onCancel: () => void
  isSaving: boolean
}) {
  const showBody = BODY_METHODS.has(form.method)
  const set = (patch: Partial<EndpointForm>) => onChange({ ...form, ...patch })

  return (
    <div className='space-y-3 rounded-lg border border-nvr-cyan/30 bg-slate-50/60 p-4 dark:bg-slate-900/60'>
      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1'>
          <Label className='text-[11px]'>Name *</Label>
          <Input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder='e.g. Get Invoice'
            className='h-8 text-[13px]'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px]'>Slug *</Label>
          <Input
            value={form.slug}
            onChange={(e) =>
              set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })
            }
            placeholder='e.g. get-invoice'
            className='h-8 font-mono text-[12px]'
          />
        </div>
      </div>
      <div className='space-y-1'>
        <Label className='text-[11px]'>Description</Label>
        <Input
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder='Optional'
          className='h-8 text-[13px]'
        />
      </div>
      <div className='flex gap-2'>
        <div className='w-28 shrink-0 space-y-1'>
          <Label className='text-[11px]'>Method</Label>
          <Select value={form.method} onValueChange={(v) => set({ method: v })}>
            <SelectTrigger className='h-8 text-[13px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HTTP_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className='flex-1 space-y-1'>
          <Label className='text-[11px]'>Path</Label>
          <Input
            value={form.path}
            onChange={(e) => set({ path: e.target.value })}
            placeholder='/invoices/{id}'
            className='h-8 font-mono text-[12px]'
          />
        </div>
      </div>
      {showBody && (
        <div className='space-y-1'>
          <div className='flex items-center justify-between'>
            <Label className='text-[11px]'>Default Body (JSON)</Label>
            {form.default_body.trim() && (
              <button
                type='button'
                onClick={() => {
                  try {
                    set({ default_body: JSON.stringify(JSON.parse(form.default_body), null, 2) })
                  } catch {
                    /* ignore */
                  }
                }}
                className='text-[11px] text-nvr-cyan hover:underline'
              >
                Format
              </button>
            )}
          </div>
          <Textarea
            value={form.default_body}
            onChange={(e) => set({ default_body: e.target.value })}
            placeholder={'{\n  "key": "value"\n}'}
            rows={4}
            className='font-mono text-[12px] resize-y'
          />
        </div>
      )}
      <InlineKVEditor
        label='Default Query Params'
        pairs={form.default_query}
        onChange={(p) => set({ default_query: p })}
      />
      <InlineKVEditor
        label='Default Headers'
        pairs={form.default_headers}
        onChange={(p) => set({ default_headers: p })}
      />
      <div className='flex justify-end gap-2 pt-1'>
        <Button variant='ghost' size='sm' onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size='sm'
          onClick={onSave}
          disabled={isSaving || !form.name.trim() || !form.slug.trim()}
        >
          {isSaving ? 'Saving…' : 'Save Endpoint'}
        </Button>
      </div>
    </div>
  )
}

// ─── Call logs card ───────────────────────────────────────────────────────────

const METHOD_BADGE: Record<string, string> = {
  GET: 'text-emerald-600 dark:text-emerald-400',
  POST: 'text-blue-600 dark:text-blue-400',
  PUT: 'text-amber-600 dark:text-amber-400',
  PATCH: 'text-orange-500 dark:text-orange-400',
  DELETE: 'text-red-500 dark:text-red-400',
  HEAD: 'text-slate-500'
}

function statusColor(s: number | null) {
  if (!s) return 'text-slate-400'
  if (s < 300) return 'text-emerald-600 dark:text-emerald-400'
  if (s < 400) return 'text-amber-500'
  return 'text-red-500 dark:text-red-400'
}

function LogDetailRow({ log }: { log: ExternalApiCallLog }) {
  const [open, setOpen] = useState(false)

  function fmtJson(v: unknown): string {
    if (v == null) return '—'
    if (typeof v === 'string') return v
    return JSON.stringify(v, null, 2)
  }

  return (
    <>
      <tr
        className='border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer'
        onClick={() => setOpen((o) => !o)}
      >
        <td className='py-2 pl-3 pr-2 w-5'>
          {open ? (
            <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
          ) : (
            <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
          )}
        </td>
        <td
          className={`py-2 pr-3 font-mono text-[11px] font-semibold w-14 ${METHOD_BADGE[log.method] ?? 'text-slate-500'}`}
        >
          {log.method}
        </td>
        <td
          className={`py-2 pr-3 font-mono text-[11px] font-semibold w-12 ${statusColor(log.response_status)}`}
        >
          {log.response_status ?? (log.error ? 'ERR' : '—')}
        </td>
        <td className='py-2 pr-3 font-mono text-[11px] text-slate-600 dark:text-slate-400 max-w-[260px] truncate'>
          {log.url}
        </td>
        <td className='py-2 pr-3 text-[11px] text-slate-500 w-20'>{log.triggered_by}</td>
        <td className='py-2 pr-3 text-[11px] text-slate-500 w-16 text-right'>
          {log.duration_ms != null ? `${log.duration_ms}ms` : '—'}
        </td>
        <td className='py-2 pr-3 text-[11px] text-slate-400 w-36 text-right whitespace-nowrap'>
          {new Date(log.created_at).toLocaleString()}
        </td>
      </tr>
      {open && (
        <tr className='border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40'>
          <td colSpan={7} className='px-4 pb-3 pt-2'>
            {log.error && (
              <div className='mb-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-[12px] text-red-700 dark:text-red-400 font-mono'>
                Error: {log.error}
              </div>
            )}
            <div className='grid grid-cols-2 gap-3'>
              <div>
                <p className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                  Request Headers
                </p>
                <pre className='rounded bg-slate-100 dark:bg-slate-800 p-2 text-[11px] font-mono overflow-auto max-h-36 whitespace-pre-wrap'>
                  {fmtJson(log.request_headers)}
                </pre>
              </div>
              <div>
                <p className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                  Response Headers
                </p>
                <pre className='rounded bg-slate-100 dark:bg-slate-800 p-2 text-[11px] font-mono overflow-auto max-h-36 whitespace-pre-wrap'>
                  {fmtJson(log.response_headers)}
                </pre>
              </div>
              {log.request_body && (
                <div>
                  <p className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                    Request Body
                  </p>
                  <pre className='rounded bg-slate-100 dark:bg-slate-800 p-2 text-[11px] font-mono overflow-auto max-h-48 whitespace-pre-wrap'>
                    {log.request_body}
                  </pre>
                </div>
              )}
              {log.response_body != null && (
                <div>
                  <p className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                    Response Body
                  </p>
                  <pre className='rounded bg-slate-100 dark:bg-slate-800 p-2 text-[11px] font-mono overflow-auto max-h-48 whitespace-pre-wrap'>
                    {log.response_body}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function ApiCallLogsCard({ apiId }: { apiId: number }) {
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['external-api-logs', apiId] })

  const { data, isLoading, isFetching } = useQuery<{ data: ExternalApiCallLog[]; total: number }>({
    queryKey: ['external-api-logs', apiId],
    queryFn: () =>
      api
        .get<{ data: ExternalApiCallLog[]; total: number }>(
          `/external-apis/${apiId}/logs?limit=100`
        )
        .then((r) => r.data),
    refetchInterval: 30_000
  })

  const clearAll = useMutation({
    mutationFn: () => api.delete(`/external-apis/${apiId}/logs`),
    onSuccess: () => {
      invalidate()
      toast.success('Logs cleared')
    },
    onError: () => toast.error('Failed to clear logs')
  })

  const logs = data?.data ?? []
  const total = data?.total ?? 0

  return (
    <Card className='mt-5 p-6'>
      <div className='mb-4 flex items-center justify-between'>
        <div>
          <Label>Call Logs</Label>
          <p className='text-[12px] text-slate-400'>
            Recent outbound calls — request, response, timing.
            {total > 100 && ` Showing latest 100 of ${total.toLocaleString()}.`}
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => invalidate()}
            disabled={isFetching}
            className='gap-1.5'
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {logs.length > 0 && (
            <Button
              variant='outline'
              size='sm'
              className='gap-1.5 text-red-500 hover:text-red-600 border-red-200 hover:border-red-300'
              onClick={() => {
                if (confirm('Clear all call logs for this API?')) clearAll.mutate()
              }}
              disabled={clearAll.isPending}
            >
              <Trash2 className='h-3.5 w-3.5' />
              Clear
            </Button>
          )}
        </div>
      </div>

      {isLoading && <p className='text-[13px] text-slate-400'>Loading…</p>}

      {!isLoading && logs.length === 0 && (
        <p className='text-[13px] text-slate-400'>No calls logged yet.</p>
      )}

      {logs.length > 0 && (
        <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700'>
          <table className='w-full text-left'>
            <thead>
              <tr className='border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50'>
                <th className='py-2 pl-3 w-5' />
                <th className='py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-slate-500 w-14'>
                  Method
                </th>
                <th className='py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-slate-500 w-12'>
                  Status
                </th>
                <th className='py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-slate-500'>
                  URL
                </th>
                <th className='py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-slate-500 w-20'>
                  Source
                </th>
                <th className='py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-slate-500 w-16 text-right'>
                  Duration
                </th>
                <th className='py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-slate-500 w-36 text-right'>
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <LogDetailRow key={log.id} log={log} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

interface SchemaRecord {
  id: number
  title: string | null
  spec_version: string | null
  endpoint_count: number
  imported_at: string
}

function EndpointsCard({ apiId }: { apiId: number }) {
  const queryClient = useQueryClient()
  const [expandedId, setExpandedId] = useState<number | 'new' | null>(null)
  const [editForms, setEditForms] = useState<Record<number | 'new', EndpointForm>>(
    {} as Record<number | 'new', EndpointForm>
  )
  const [specOpen, setSpecOpen] = useState(false)
  const [specText, setSpecText] = useState('')

  const { data, isLoading } = useQuery<ExternalApiEndpoint[]>({
    queryKey: ['external-api-endpoints', apiId],
    queryFn: () =>
      api
        .get<{ data: ExternalApiEndpoint[] }>(`/external-apis/${apiId}/endpoints`)
        .then((r) => r.data.data)
  })

  const { data: schemas } = useQuery<SchemaRecord[]>({
    queryKey: ['external-api-schemas', apiId],
    queryFn: () =>
      api
        .get<{ data: SchemaRecord[] }>(`/external-apis/${apiId}/schemas`)
        .then((r) => r.data.data),
    staleTime: 30_000
  })

  const importSpec = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { imported: number; skipped: number; schema_id: number } }>(
          `/external-apis/${apiId}/import-spec`,
          { spec: specText }
        )
        .then((r) => r.data.data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['external-api-endpoints', apiId] })
      queryClient.invalidateQueries({ queryKey: ['external-api-schemas', apiId] })
      toast.success(`Imported ${result.imported} endpoints, skipped ${result.skipped}`)
      setSpecText('')
      setSpecOpen(false)
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Import failed')
  })

  const endpoints = data ?? []

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['external-api-endpoints', apiId] })

  const create = useMutation({
    mutationFn: (payload: ReturnType<typeof formToPayload>) =>
      api.post(`/external-apis/${apiId}/endpoints`, payload),
    onSuccess: () => {
      invalidate()
      setExpandedId(null)
      toast.success('Endpoint added')
    },
    onError: () => toast.error('Failed to add endpoint')
  })

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ReturnType<typeof formToPayload> }) =>
      api.patch(`/external-apis/endpoints/${id}`, payload),
    onSuccess: () => {
      invalidate()
      setExpandedId(null)
      toast.success('Endpoint saved')
    },
    onError: () => toast.error('Failed to save endpoint')
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/external-apis/endpoints/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Endpoint deleted')
    },
    onError: () => toast.error('Failed to delete endpoint')
  })

  function openNew() {
    setEditForms((f) => ({ ...f, new: EMPTY_EP }))
    setExpandedId('new')
  }

  function openEdit(ep: ExternalApiEndpoint) {
    setEditForms((f) => ({ ...f, [ep.id]: epToForm(ep) }))
    setExpandedId(ep.id)
  }

  const METHOD_COLORS: Record<string, string> = {
    GET: 'text-emerald-600 dark:text-emerald-400',
    POST: 'text-blue-600 dark:text-blue-400',
    PUT: 'text-amber-600 dark:text-amber-400',
    PATCH: 'text-orange-500 dark:text-orange-400',
    DELETE: 'text-red-500 dark:text-red-400',
    HEAD: 'text-slate-500'
  }

  return (
    <Card className='mt-5 p-6'>
      <div className='mb-4 flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <div>
            <Label>Endpoints</Label>
            <p className='text-[12px] text-slate-400'>
              Pre-defined requests with default method, path, body, and params.
            </p>
          </div>
          {schemas && schemas.length > 0 && (
            <span className='rounded-full bg-nvr-cyan/10 px-2 py-0.5 text-[11px] font-medium text-nvr-cyan dark:bg-nvr-cyan/15'>
              {schemas.length} spec{schemas.length !== 1 ? 's' : ''} imported
            </span>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setSpecOpen((o) => !o)}
            className='gap-1.5'
          >
            <FileJson className='h-3.5 w-3.5' />
            Import Spec
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={openNew}
            disabled={expandedId === 'new'}
            className='gap-1.5'
          >
            <Plus className='h-3.5 w-3.5' />
            Add Endpoint
          </Button>
        </div>
      </div>

      {specOpen && (
        <div className='mb-4 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/40'>
          <div className='mb-2 flex items-center gap-2'>
            <FileJson className='h-3.5 w-3.5 text-slate-400' />
            <span className='text-[12px] font-medium text-slate-600 dark:text-slate-400'>
              Import from OpenAPI / Swagger spec
            </span>
            <span className='ml-auto text-[11px] text-slate-400'>
              JSON or YAML
            </span>
          </div>
          <Textarea
            value={specText}
            onChange={(e) => setSpecText(e.target.value)}
            placeholder='Paste OpenAPI 3.0 or Swagger 2.0 spec here (JSON or YAML)…'
            rows={6}
            className='mb-3 font-mono text-[12px] resize-y'
          />
          <div className='flex justify-end gap-2'>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => {
                setSpecOpen(false)
                setSpecText('')
              }}
            >
              Cancel
            </Button>
            <Button
              size='sm'
              onClick={() => importSpec.mutate()}
              disabled={importSpec.isPending || !specText.trim()}
              className='gap-1.5'
            >
              <FileJson className='h-3.5 w-3.5' />
              {importSpec.isPending ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      )}

      {isLoading && <p className='text-[13px] text-slate-400'>Loading…</p>}

      <div className='space-y-2'>
        {endpoints.map((ep) => (
          <div key={ep.id} className='rounded-lg border border-slate-200 dark:border-slate-700'>
            {expandedId === ep.id ? (
              <div className='p-3'>
                <EndpointEditor
                  form={editForms[ep.id] ?? epToForm(ep)}
                  onChange={(f) => setEditForms((prev) => ({ ...prev, [ep.id]: f }))}
                  onSave={() =>
                    update.mutate({
                      id: ep.id,
                      payload: formToPayload(editForms[ep.id] ?? epToForm(ep))
                    })
                  }
                  onCancel={() => setExpandedId(null)}
                  isSaving={update.isPending}
                />
              </div>
            ) : (
              <div className='flex items-center gap-3 px-3 py-2.5'>
                <span
                  className={`w-14 shrink-0 font-mono text-[11px] font-semibold ${METHOD_COLORS[ep.method] ?? 'text-slate-500'}`}
                >
                  {ep.method}
                </span>
                <span className='flex-1 font-mono text-[12px] text-slate-700 dark:text-slate-300 truncate'>
                  {ep.path || '/'}
                </span>
                <span className='truncate text-[12px] text-slate-500 max-w-[180px]'>{ep.name}</span>
                <div className='flex items-center gap-1 shrink-0'>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-7 w-7 p-0'
                    onClick={() => openEdit(ep)}
                    aria-label='Edit'
                  >
                    <ChevronDown className='h-3.5 w-3.5' />
                  </Button>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-7 w-7 p-0 text-slate-400 hover:text-red-500'
                    onClick={() => {
                      if (confirm(`Delete "${ep.name}"?`)) remove.mutate(ep.id)
                    }}
                    aria-label='Delete'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}

        {endpoints.length === 0 && !isLoading && expandedId !== 'new' && (
          <p className='text-[13px] text-slate-400'>No endpoints defined.</p>
        )}

        {expandedId === 'new' && (
          <EndpointEditor
            form={editForms.new ?? EMPTY_EP}
            onChange={(f) => setEditForms((prev) => ({ ...prev, new: f }))}
            onSave={() => create.mutate(formToPayload(editForms.new ?? EMPTY_EP))}
            onCancel={() => setExpandedId(null)}
            isSaving={create.isPending}
          />
        )}
      </div>
    </Card>
  )
}

// ─── No-Code Connector ────────────────────────────────────────────────────────

function ConnectorCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className='h-8 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
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

interface SampledField {
  path: string
  sampleType: string
  selected: boolean
  target: string
}

/** Find the record array in a sample response and the dotted path to reach it. */
function findRecordArray(body: unknown): { responsePath: string; record: unknown } | null {
  if (Array.isArray(body)) {
    return body.length ? { responsePath: '', record: body[0] } : null
  }
  if (body && typeof body === 'object') {
    // breadth-first over the first two levels
    const queue: { obj: Record<string, unknown>; prefix: string; depth: number }[] = [
      { obj: body as Record<string, unknown>, prefix: '', depth: 0 }
    ]
    while (queue.length) {
      const { obj, prefix, depth } = queue.shift()!
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k
        if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
          return { responsePath: path, record: v[0] }
        }
        if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) {
          queue.push({ obj: v as Record<string, unknown>, prefix: path, depth: depth + 1 })
        }
      }
    }
    // Object response with no array — treat the object itself as a single record
    return { responsePath: '', record: body }
  }
  return null
}

/** Flatten a record into dotted leaf paths (max depth 3). */
function flattenRecord(
  record: unknown,
  prefix = '',
  depth = 0
): { path: string; sampleType: string }[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return []
  const out: { path: string; sampleType: string }[] = []
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) {
      out.push(...flattenRecord(v, path, depth + 1))
    } else {
      out.push({ path, sampleType: Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v })
    }
  }
  return out
}

function ConnectorCard({ apiId, apiName }: { apiId: number; apiName: string }) {
  const navigate = useNavigate()
  const [path, setPath] = useState('')
  const [responsePath, setResponsePath] = useState('')
  const [fields, setFields] = useState<SampledField[]>([])
  const [targetCollection, setTargetCollection] = useState('')
  const [fetchErr, setFetchErr] = useState<string | null>(null)

  const { data: collectionsData = [] } = useQuery<{ collection: string }[]>({
    queryKey: ['collections'],
    queryFn: () =>
      api.get<{ data: { collection: string }[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', targetCollection],
    queryFn: () =>
      api
        .get<{ data: { fields: { field: string; type: string; hidden?: boolean }[] } }>(
          `/collections/${targetCollection}`
        )
        .then((r) => r.data.data),
    enabled: !!targetCollection,
    staleTime: 30_000
  })

  const collectionFields = (colMeta?.fields ?? []).filter((f) => !f.hidden)
  const fieldOptions = collectionFields.map((f) => ({
    value: f.field,
    label: `${f.field} (${f.type})`
  }))

  // Auto-suggest targets when the collection changes: match last path segment to a field name.
  useEffect(() => {
    if (!collectionFields.length) return
    setFields((prev) =>
      prev.map((f) => {
        if (f.target) return f
        const leaf = f.path.split('.').pop() ?? f.path
        const match = collectionFields.find((cf) => cf.field.toLowerCase() === leaf.toLowerCase())
        return match ? { ...f, target: match.field } : f
      })
    )
  }, [collectionFields.length, collectionFields.find])

  const fetchSample = useMutation({
    mutationFn: () =>
      api
        .post<{ data: TestResponseShape; error?: string }>(`/external-apis/${apiId}/test`, {
          method: 'GET',
          path
        })
        .then((r) => r.data),
    onSuccess: (res) => {
      if (res.error) {
        setFetchErr(res.error)
        setFields([])
        return
      }
      if (res.data.status < 200 || res.data.status >= 300) {
        setFetchErr(`Request returned HTTP ${res.data.status}`)
        setFields([])
        return
      }
      const found = findRecordArray(res.data.body)
      if (!found) {
        setFetchErr('Could not find a record (or record array) in the response.')
        setFields([])
        return
      }
      setFetchErr(null)
      setResponsePath(found.responsePath)
      setFields(
        flattenRecord(found.record).map((f) => ({
          ...f,
          selected: true,
          target: ''
        }))
      )
    },
    onError: () => setFetchErr('Request failed')
  })

  const createSyncJob = useMutation({
    mutationFn: () => {
      const mapping: Record<string, string> = {}
      for (const f of fields) {
        if (f.selected && f.target) mapping[f.path] = f.target
      }
      const field_mapping: Record<string, unknown> = { fields: mapping }
      if (responsePath) field_mapping.response_path = responsePath
      return api.post('/sync-jobs', {
        name: `${apiName} → ${targetCollection}`,
        direction: 'pull',
        external_api: apiId,
        collection: targetCollection,
        endpoint_path: path,
        field_mapping,
        conflict_strategy: 'newest-wins',
        is_active: false
      })
    },
    onSuccess: () => {
      toast.success('Sync job created — review and activate it')
      navigate('/sync-jobs')
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Failed to create sync job')
  })

  const mappedCount = fields.filter((f) => f.selected && f.target).length
  const canCreate = !!targetCollection && !!path.trim() && mappedCount > 0

  return (
    <Card className='mt-5 p-6 space-y-4'>
      <div className='flex items-center justify-between'>
        <div>
          <Label className='flex items-center gap-1.5'>
            <Workflow className='h-3.5 w-3.5' />
            No-Code Connector
          </Label>
          <p className='text-[12px] text-slate-400'>
            Fetch a sample response, map its fields to a collection, and generate a pull sync job.
          </p>
        </div>
      </div>

      <div className='flex items-center gap-2'>
        <Input
          placeholder='/v1/customers'
          value={path}
          onChange={(e) => setPath(e.target.value)}
          className='flex-1 font-mono text-[13px]'
        />
        <Button
          variant='outline'
          onClick={() => fetchSample.mutate()}
          disabled={fetchSample.isPending || !path.trim()}
          className='gap-1.5 shrink-0'
        >
          <Download className='h-3.5 w-3.5' />
          {fetchSample.isPending ? 'Fetching…' : 'Fetch sample'}
        </Button>
      </div>

      {fetchErr && (
        <p className='rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-600 dark:bg-red-900/20 dark:text-red-400'>
          {fetchErr}
        </p>
      )}

      {fields.length > 0 && (
        <>
          {responsePath && (
            <p className='text-[12px] text-slate-500'>
              Records found at{' '}
              <code className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] dark:bg-slate-800'>
                {responsePath}
              </code>
            </p>
          )}

          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Target Collection</Label>
            <div className='max-w-xs'>
              <ConnectorCombobox
                value={targetCollection}
                onChange={setTargetCollection}
                options={collectionsData
                  .filter((c) => !c.collection.startsWith('nivaro_'))
                  .map((c) => ({ value: c.collection, label: c.collection }))}
                placeholder='Select collection…'
              />
            </div>
          </div>

          <div className='rounded-lg border border-slate-200 dark:border-slate-700'>
            <div className='grid grid-cols-[28px_1fr_1fr] items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50'>
              <span />
              <span className='text-[10px] font-semibold uppercase tracking-wide text-slate-500'>
                Response field
              </span>
              <span className='text-[10px] font-semibold uppercase tracking-wide text-slate-500'>
                Maps to
              </span>
            </div>
            <div className='max-h-72 overflow-y-auto'>
              {fields.map((f, i) => (
                <div
                  key={f.path}
                  className='grid grid-cols-[28px_1fr_1fr] items-center gap-2 border-b border-slate-100 px-3 py-1.5 last:border-b-0 dark:border-slate-800'
                >
                  <Checkbox
                    checked={f.selected}
                    onCheckedChange={(checked) => {
                      const next = [...fields]
                      next[i] = { ...f, selected: checked === true }
                      setFields(next)
                    }}
                    aria-label={`Include ${f.path}`}
                  />
                  <span className='truncate font-mono text-[12px] text-slate-700 dark:text-slate-300'>
                    {f.path} <span className='text-[10px] text-slate-400'>({f.sampleType})</span>
                  </span>
                  <ConnectorCombobox
                    value={f.target}
                    onChange={(v) => {
                      const next = [...fields]
                      next[i] = { ...f, target: v }
                      setFields(next)
                    }}
                    options={fieldOptions}
                    placeholder={targetCollection ? 'Select field…' : 'Pick collection first'}
                    disabled={!f.selected || !targetCollection}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className='flex items-center justify-between'>
            <p className='text-[12px] text-slate-400'>
              {mappedCount} of {fields.length} fields mapped
            </p>
            <Button
              onClick={() => createSyncJob.mutate()}
              disabled={!canCreate || createSyncJob.isPending}
              className='gap-1.5'
            >
              <Workflow className='h-3.5 w-3.5' />
              {createSyncJob.isPending ? 'Creating…' : 'Create sync job'}
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

interface TestResponseShape {
  status: number
  headers: Record<string, string>
  body: unknown
}
