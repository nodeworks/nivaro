import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, type ExternalApiEndpoint } from '@/lib/api'

export interface ExternalApi {
  id: number
  name: string
  base_url: string
  description: string | null
  auth_type: 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2_cc'
  auth_config: Record<string, unknown> | null
  headers: Record<string, string> | null
  enabled: boolean
  integration_type: string | null
  integration_config: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

interface TestResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

const AUTH_LABELS: Record<ExternalApi['auth_type'], string> = {
  none: 'None',
  bearer: 'Bearer',
  api_key: 'API Key',
  basic: 'Basic',
  oauth2_cc: 'OAuth2 CC'
}

export function ExternalApisPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [testingId, setTestingId] = useState<number | null>(null)

  const { data, isLoading } = useQuery<ExternalApi[]>({
    queryKey: ['external-apis'],
    queryFn: () => api.get<{ data: ExternalApi[] }>('/external-apis').then((r) => r.data.data)
  })

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.patch(`/external-apis/${id}`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['external-apis'] }),
    onError: () => toast.error('Failed to update')
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/external-apis/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['external-apis'] })
      toast.success('API deleted')
    },
    onError: () => toast.error('Failed to delete')
  })

  const apis = data ?? []

  return (
    <div className='p-8'>
      <div className='mb-6 flex items-start justify-between'>
        <div>
          <h1 className='text-2xl font-bold text-slate-900'>External APIs</h1>
          <p className='mt-1 text-muted-foreground'>
            Configure outbound integrations with varying authentication methods.
          </p>
        </div>
        <Button onClick={() => navigate('/external-apis/new')} className='gap-1.5'>
          <Plus className='h-4 w-4' />
          Add API
        </Button>
      </div>

      {isLoading ? (
        <div className='space-y-3'>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className='h-12 rounded-lg' />
          ))}
        </div>
      ) : apis.length === 0 ? (
        <Card className='flex flex-col items-center justify-center py-20 text-center'>
          <Link2 className='mb-4 h-10 w-10 text-slate-300' />
          <p className='text-[15px] font-medium text-slate-600'>No external APIs yet</p>
          <p className='mt-1 text-[13px] text-slate-400'>
            Add an API to connect outbound integrations.
          </p>
          <Button onClick={() => navigate('/external-apis/new')} className='mt-5 gap-1.5' size='sm'>
            <Plus className='h-3.5 w-3.5' />
            Add API
          </Button>
        </Card>
      ) : (
        <Card className='overflow-hidden'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>Auth Type</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className='text-right'>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apis.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className='font-medium text-slate-900'>{a.name}</TableCell>
                  <TableCell className='font-mono text-[12px] text-slate-500 max-w-[280px] truncate'>
                    {a.base_url}
                  </TableCell>
                  <TableCell>
                    <Badge variant='secondary' className='text-[11px]'>
                      {AUTH_LABELS[a.auth_type]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={a.enabled}
                      onCheckedChange={(enabled) => toggleEnabled.mutate({ id: a.id, enabled })}
                    />
                  </TableCell>
                  <TableCell className='text-right'>
                    <div className='flex items-center justify-end gap-1'>
                      <Button
                        variant='ghost'
                        size='sm'
                        className='h-8 gap-1.5'
                        onClick={() => setTestingId(testingId === a.id ? null : a.id)}
                      >
                        <Play className='h-3.5 w-3.5' />
                        Test
                      </Button>
                      <Button
                        variant='ghost'
                        size='sm'
                        className='h-8 w-8 p-0'
                        onClick={() => navigate(`/external-apis/${a.id}`)}
                        aria-label='Edit'
                      >
                        <Pencil className='h-3.5 w-3.5' />
                      </Button>
                      <Button
                        variant='ghost'
                        size='sm'
                        className='h-8 w-8 p-0 text-slate-400 hover:text-red-500'
                        onClick={() => {
                          if (confirm(`Delete "${a.name}"?`)) remove.mutate(a.id)
                        }}
                        aria-label='Delete'
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {testingId !== null && (
        <TestPanel api={apis.find((a) => a.id === testingId)!} onClose={() => setTestingId(null)} />
      )}
    </div>
  )
}

type KVPair = { key: string; value: string }

function KVEditor({
  label,
  pairs,
  onChange
}: {
  label: string
  pairs: KVPair[]
  onChange: (pairs: KVPair[]) => void
}) {
  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between'>
        <span className='text-[12px] font-medium text-slate-600'>{label}</span>
        <button
          type='button'
          onClick={() => onChange([...pairs, { key: '', value: '' }])}
          className='text-[11px] text-nvr-cyan hover:underline'
        >
          + Add
        </button>
      </div>
      {pairs.length === 0 ? (
        <p className='text-[11px] text-slate-400'>None</p>
      ) : (
        pairs.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional list
          <div key={i} className='flex items-center gap-1.5'>
            <Input
              placeholder='Key'
              value={p.key}
              onChange={(e) => {
                const next = [...pairs]
                next[i] = { ...p, key: e.target.value }
                onChange(next)
              }}
              className='flex-1 font-mono text-[12px] h-7 px-2'
            />
            <Input
              placeholder='Value'
              value={p.value}
              onChange={(e) => {
                const next = [...pairs]
                next[i] = { ...p, value: e.target.value }
                onChange(next)
              }}
              className='flex-1 font-mono text-[12px] h-7 px-2'
            />
            <button
              type='button'
              onClick={() => onChange(pairs.filter((_, j) => j !== i))}
              className='text-slate-400 hover:text-red-500'
              aria-label='Remove'
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          </div>
        ))
      )}
    </div>
  )
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-emerald-600',
  POST: 'text-blue-600',
  PUT: 'text-amber-600',
  PATCH: 'text-orange-500',
  DELETE: 'text-red-500'
}

function TestPanel({ api: cfg, onClose }: { api: ExternalApi; onClose: () => void }) {
  const [selectedEpId, setSelectedEpId] = useState<number | null>(null)
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('')
  const [body, setBody] = useState('')
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [queryParams, setQueryParams] = useState<KVPair[]>([])
  const [reqHeaders, setReqHeaders] = useState<KVPair[]>([])
  const [showOptions, setShowOptions] = useState(false)
  const [showResHeaders, setShowResHeaders] = useState(false)
  const [result, setResult] = useState<TestResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: endpoints } = useQuery<ExternalApiEndpoint[]>({
    queryKey: ['external-api-endpoints', cfg.id],
    queryFn: () =>
      api
        .get<{ data: ExternalApiEndpoint[] }>(`/external-apis/${cfg.id}/endpoints`)
        .then((r) => r.data.data)
  })

  function applyEndpoint(ep: ExternalApiEndpoint) {
    setSelectedEpId(ep.id)
    setMethod(ep.method)
    setPath(ep.path)
    setBody(ep.default_body != null ? JSON.stringify(ep.default_body, null, 2) : '')
    setQueryParams(Object.entries(ep.default_query ?? {}).map(([key, value]) => ({ key, value })))
    setReqHeaders(Object.entries(ep.default_headers ?? {}).map(([key, value]) => ({ key, value })))
    setResult(null)
    setError(null)
    setBodyError(null)
    if (
      Object.keys(ep.default_query ?? {}).length ||
      Object.keys(ep.default_headers ?? {}).length
    ) {
      setShowOptions(true)
    }
  }

  function resetCustom() {
    setSelectedEpId(null)
  }

  const showBody = BODY_METHODS.has(method)

  const run = useMutation({
    mutationFn: () => {
      setBodyError(null)

      let parsedBody: unknown
      if (showBody && body.trim()) {
        try {
          parsedBody = JSON.parse(body)
        } catch {
          setBodyError('Invalid JSON — sending as raw string')
          parsedBody = body
        }
      }

      const queryObj: Record<string, string> = {}
      for (const p of queryParams) {
        if (p.key.trim()) queryObj[p.key.trim()] = p.value
      }
      const headersObj: Record<string, string> = {}
      for (const h of reqHeaders) {
        if (h.key.trim()) headersObj[h.key.trim()] = h.value
      }

      return api
        .post<{ data: TestResponse; error?: string }>(`/external-apis/${cfg.id}/test`, {
          method,
          path,
          ...(parsedBody !== undefined && { body: parsedBody }),
          ...(Object.keys(queryObj).length && { query: queryObj }),
          ...(Object.keys(headersObj).length && { headers: headersObj })
        })
        .then((r) => r.data)
    },
    onSuccess: (res) => {
      setResult(res.data)
      setError(res.error ?? null)
    },
    onError: () => {
      setResult(null)
      setError('Request failed')
    }
  })

  function formatBody() {
    try {
      setBody(JSON.stringify(JSON.parse(body), null, 2))
      setBodyError(null)
    } catch {
      setBodyError('Invalid JSON — cannot format')
    }
  }

  const optionCount =
    queryParams.filter((p) => p.key).length + reqHeaders.filter((h) => h.key).length

  return (
    <Card className='mt-6 p-5 space-y-4'>
      <div className='flex items-center justify-between'>
        <h2 className='text-[14px] font-semibold text-slate-900'>Test: {cfg.name}</h2>
        <Button variant='ghost' size='sm' onClick={onClose}>
          Close
        </Button>
      </div>

      {/* Endpoint picker */}
      {endpoints && endpoints.length > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          <button
            type='button'
            onClick={resetCustom}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              selectedEpId === null
                ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
            }`}
          >
            Custom
          </button>
          {endpoints.map((ep) => (
            <button
              key={ep.id}
              type='button'
              onClick={() => applyEndpoint(ep)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                selectedEpId === ep.id
                  ? 'bg-nvr-cyan/15 text-nvr-cyan ring-1 ring-nvr-cyan/40'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
              }`}
            >
              <span
                className={`font-mono font-bold ${METHOD_COLORS[ep.method] ?? 'text-slate-500'}`}
              >
                {ep.method}
              </span>
              <span>{ep.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Method + Path + Send */}
      <div className='flex items-center gap-2'>
        <div className='w-28 shrink-0'>
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Input
          placeholder='/path/to/endpoint'
          value={path}
          onChange={(e) => setPath(e.target.value)}
          className='flex-1 font-mono text-[13px]'
        />
        <Button onClick={() => run.mutate()} disabled={run.isPending} className='gap-1.5 shrink-0'>
          <Play className='h-3.5 w-3.5' />
          {run.isPending ? 'Running…' : 'Send'}
        </Button>
      </div>

      {/* Body — POST / PUT / PATCH only */}
      {showBody && (
        <div className='space-y-1.5'>
          <div className='flex items-center justify-between'>
            <span className='text-[12px] font-medium text-slate-600'>Request Body (JSON)</span>
            {body.trim() && (
              <button
                type='button'
                onClick={formatBody}
                className='text-[11px] text-nvr-cyan hover:underline'
              >
                Format
              </button>
            )}
          </div>
          <Textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              setBodyError(null)
            }}
            placeholder={'{\n  "key": "value"\n}'}
            rows={6}
            className='font-mono text-[12px] resize-y'
          />
          {bodyError && <p className='text-[11px] text-amber-600'>{bodyError}</p>}
        </div>
      )}

      {/* Collapsible options */}
      <div>
        <button
          type='button'
          onClick={() => setShowOptions((v) => !v)}
          className='flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-slate-900'
        >
          <span>{showOptions ? '▾' : '▸'}</span>
          <span>Query params &amp; headers</span>
          {optionCount > 0 && (
            <span className='rounded-full bg-nvr-cyan/20 px-1.5 py-0.5 text-[10px] font-semibold text-nvr-cyan'>
              {optionCount}
            </span>
          )}
        </button>
        {showOptions && (
          <div className='mt-3 space-y-4 rounded-md border border-slate-200 p-3'>
            <KVEditor label='Query Params' pairs={queryParams} onChange={setQueryParams} />
            <KVEditor label='Request Headers' pairs={reqHeaders} onChange={setReqHeaders} />
          </div>
        )}
      </div>

      {error && <p className='rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-600'>{error}</p>}

      {result && (
        <div className='space-y-2'>
          <div className='flex items-center gap-2'>
            <Badge
              variant={result.status >= 200 && result.status < 300 ? 'default' : 'destructive'}
              className='text-[11px]'
            >
              {result.status || 'ERR'}
            </Badge>
            {Object.keys(result.headers).length > 0 && (
              <button
                type='button'
                onClick={() => setShowResHeaders((v) => !v)}
                className='text-[11px] text-slate-500 hover:text-slate-900'
              >
                {showResHeaders ? 'Hide' : 'Show'} headers ({Object.keys(result.headers).length})
              </button>
            )}
          </div>
          {showResHeaders && (
            <div className='rounded-md border border-slate-200 bg-slate-50 p-3 space-y-0.5'>
              {Object.entries(result.headers).map(([k, v]) => (
                <div key={k} className='flex gap-2 font-mono text-[11px]'>
                  <span className='shrink-0 text-slate-500'>{k}:</span>
                  <span className='break-all text-slate-800'>{v}</span>
                </div>
              ))}
            </div>
          )}
          <pre className='max-h-80 overflow-auto rounded-md bg-slate-900 p-4 text-[12px] leading-relaxed text-slate-100'>
            {typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2)}
          </pre>
        </div>
      )}
    </Card>
  )
}
