import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Check, Copy, Radar, RefreshCw, ShieldOff, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Shared bits ────────────────────────────────────────────────────────────

type ErrResp = { response?: { data?: { error?: string } } }
const errText = (e: unknown, fallback: string) => (e as ErrResp)?.response?.data?.error ?? fallback

function statusTone(ok: boolean, status: number | null) {
  if (status == null) return 'text-red-600 dark:text-red-400'
  if (ok) return 'text-emerald-700 dark:text-emerald-400'
  if (status < 500) return 'text-amber-700 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

function fmtMs(v: number | null | undefined) {
  if (v == null) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s` : `${Math.round(v)} ms`
}

function fmtPct(v: number | null | undefined) {
  return v == null ? '—' : `${v}%`
}

function CopyButton({
  text,
  label = 'Copy',
  hook
}: {
  text: string
  label?: string
  hook?: string
}) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size='sm'
      variant='outline'
      className='h-7 gap-1.5 text-[12px]'
      {...(hook ? { [hook]: '' } : {})}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          })
          .catch(() => toast.error('Copy failed — select the text instead'))
      }}
    >
      {done ? <Check className='h-3.5 w-3.5' /> : <Copy className='h-3.5 w-3.5' />}
      {done ? 'Copied' : label}
    </Button>
  )
}

function Pre({ value }: { value: unknown }) {
  if (value == null || value === '') return <p className='text-[11.5px] text-slate-400'>—</p>
  let text: string
  if (typeof value === 'string') {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      text = value
    }
  } else text = JSON.stringify(value, null, 2)
  return (
    <pre className='max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-[11.5px] leading-relaxed text-slate-800 dark:border-border dark:bg-slate-900 dark:text-slate-200'>
      {text}
    </pre>
  )
}

// ─── #626 — Flight recorder ─────────────────────────────────────────────────

interface RecorderRow {
  source: 'call' | 'side'
  id: number
  kind: string
  created_at: string
  method: string
  path: string | null
  url: string | null
  status: number | null
  ok: boolean
  duration_ms: number
  error: string | null
  triggered_by: string | null
  endpoint_id: number | null
  has_body: boolean
}

const KIND_LABEL: Record<string, string> = {
  call: 'Call',
  mock: 'Mocked',
  token: 'Token',
  health: 'Health probe',
  token_probe: 'Token probe',
  test: 'Test',
  lookup: 'SDK call'
}

const KIND_TONE: Record<string, string> = {
  call: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  mock: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  token: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  health: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  token_probe: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  test: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  lookup: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
}

function RecorderDetail({ apiId, row }: { apiId: number; row: RecorderRow }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['external-api-recorder-detail', apiId, row.source, row.id],
    queryFn: () =>
      api
        .get<{ data: Record<string, unknown> }>(
          `/external-apis/${apiId}/recorder/${row.source}/${row.id}`
        )
        .then((r) => r.data.data)
  })
  if (isLoading)
    return <div className='h-24 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800' />
  if (isError || !data)
    return <p className='text-[12px] text-red-600 dark:text-red-400'>Couldn't load this call.</p>
  const curl = data.curl as string | null
  return (
    <div className='space-y-3' data-recorder-detail>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-600 dark:text-slate-300'>
          {String(data.url ?? '')}
        </span>
        {curl && <CopyButton text={curl} label='Copy as curl' hook='data-copy-curl' />}
      </div>
      {data.error ? (
        <p className='text-[12px] text-red-600 dark:text-red-400'>{String(data.error)}</p>
      ) : null}
      {data.bodies_expired ? (
        <p className='text-[11.5px] text-slate-400'>
          Headers and bodies are kept 24 hours; this call is older, so only its summary remains.
        </p>
      ) : (
        <div className='grid gap-3 lg:grid-cols-2'>
          <div className='space-y-1.5'>
            <p className='text-[11px] font-medium uppercase tracking-wide text-slate-400'>
              Request
            </p>
            <Pre value={data.request_headers} />
            <Pre value={data.request_body} />
          </div>
          <div className='space-y-1.5'>
            <p className='text-[11px] font-medium uppercase tracking-wide text-slate-400'>
              Response
            </p>
            <Pre value={data.response_headers} />
            <Pre value={data.response_body} />
          </div>
        </div>
      )}
      {curl && (
        <details>
          <summary className='cursor-pointer text-[11.5px] text-slate-500'>Show the curl</summary>
          <pre className='mt-1.5 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-[11.5px] dark:border-border dark:bg-slate-900 dark:text-slate-200'>
            {curl}
          </pre>
        </details>
      )}
    </div>
  )
}

export function FlightRecorderCard({ apiId }: { apiId: number }) {
  const [kind, setKind] = useState('')
  const [hours, setHours] = useState('24')
  const [failedOnly, setFailedOnly] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['external-api-recorder', apiId, kind, hours, failedOnly],
    queryFn: () =>
      api
        .get<{ data: RecorderRow[] }>(`/external-apis/${apiId}/recorder`, {
          params: { kind: kind || undefined, hours, failed: failedOnly ? '1' : undefined }
        })
        .then((r) => r.data.data)
  })
  const rows = data ?? []
  const failures = rows.filter((r) => !r.ok).length
  return (
    <Card className='mt-5 p-6' data-flight-recorder>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='max-w-[72ch]'>
          <Label>Flight recorder</Label>
          <p className='text-[12px] text-slate-400'>
            Every request this API made — partner calls, mocked answers, token fetches, health
            probes, test and SDK calls. Headers and bodies are kept 24 hours with secrets and this
            API's redaction rules masked; each call copies as a curl.
          </p>
        </div>
        <Button
          size='sm'
          variant='ghost'
          className='h-7 gap-1.5 text-[12px]'
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <SimpleSelect
          value={kind}
          onChange={setKind}
          ariaLabel='What to show'
          className='h-8 w-44 text-[12.5px]'
          triggerProps={{ 'data-recorder-kind-filter': '' }}
          options={[
            { value: '', label: 'Everything' },
            { value: 'call', label: 'Partner calls' },
            { value: 'mock', label: 'Mocked answers' },
            { value: 'token', label: 'Token fetches' },
            { value: 'health', label: 'Health probes' },
            { value: 'token_probe', label: 'Token probes' },
            { value: 'test', label: 'Test calls' },
            { value: 'lookup', label: 'SDK calls' }
          ]}
        />
        <SimpleSelect
          value={hours}
          onChange={setHours}
          ariaLabel='Window'
          className='h-8 w-32 text-[12.5px]'
          options={[
            { value: '1', label: 'Last hour' },
            { value: '6', label: 'Last 6 hours' },
            { value: '24', label: 'Last 24 hours' }
          ]}
        />
        <label className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
          <Switch checked={failedOnly} onCheckedChange={setFailedOnly} data-recorder-failed-only />
          Failures only
        </label>
        <span className='ml-auto text-[12px] tabular-nums text-slate-500'>
          {rows.length} request{rows.length === 1 ? '' : 's'}
          {failures > 0 && (
            <span className='text-red-600 dark:text-red-400'> · {failures} failed</span>
          )}
        </span>
      </div>
      <div className='mt-3 overflow-hidden rounded-md border border-slate-200 dark:border-border'>
        {isLoading ? (
          <div className='h-24 animate-pulse bg-slate-50 dark:bg-slate-900' />
        ) : rows.length === 0 ? (
          <p className='px-4 py-6 text-[12.5px] text-slate-500'>
            Nothing recorded in this window. Calls, token fetches and probes appear here as they
            happen.
          </p>
        ) : (
          <ul className='max-h-[520px] divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
            {rows.map((r) => {
              const key = `${r.source}:${r.id}`
              const expanded = open === key
              return (
                <li key={key} data-recorder-row={key} data-recorder-kind={r.kind}>
                  <button
                    type='button'
                    onClick={() => setOpen(expanded ? null : key)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-slate-800/60',
                      expanded && 'bg-slate-50 dark:bg-slate-800/60'
                    )}
                    aria-expanded={expanded}
                  >
                    <span
                      className='w-[64px] shrink-0 tabular-nums text-slate-500'
                      title={new Date(r.created_at).toLocaleString()}
                    >
                      {new Date(r.created_at).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                      })}
                    </span>
                    <span
                      className={cn(
                        'w-[86px] shrink-0 truncate rounded px-1.5 py-0.5 text-center text-[10.5px] font-medium',
                        KIND_TONE[r.kind] ?? KIND_TONE.call
                      )}
                    >
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </span>
                    <span className='w-12 shrink-0 font-mono text-[11px] text-slate-500'>
                      {r.method}
                    </span>
                    <span className='min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-700 dark:text-slate-200'>
                      {r.path ?? r.url ?? '/'}
                    </span>
                    <span
                      className={cn(
                        'w-12 shrink-0 text-right font-medium tabular-nums',
                        statusTone(r.ok, r.status)
                      )}
                      title={r.error ?? undefined}
                    >
                      {r.status ?? 'ERR'}
                    </span>
                    <span className='w-16 shrink-0 text-right tabular-nums text-slate-500'>
                      {fmtMs(r.duration_ms)}
                    </span>
                  </button>
                  {expanded && (
                    <div className='border-t border-slate-100 bg-white px-3 py-3 dark:border-border dark:bg-card'>
                      <RecorderDetail apiId={apiId} row={r} />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}

// ─── #605 — Redaction rules ─────────────────────────────────────────────────

const splitList = (t: string) =>
  t
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)

export function RedactionCard({
  apiId,
  redaction
}: {
  apiId: number
  redaction: { headers?: string[]; body_paths?: string[] } | null | undefined
}) {
  const qc = useQueryClient()
  const [headers, setHeaders] = useState((redaction?.headers ?? []).join('\n'))
  const [paths, setPaths] = useState((redaction?.body_paths ?? []).join('\n'))
  useEffect(() => {
    setHeaders((redaction?.headers ?? []).join('\n'))
    setPaths((redaction?.body_paths ?? []).join('\n'))
  }, [redaction])
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/external-apis/${apiId}`, {
        redaction: { headers: splitList(headers), body_paths: splitList(paths) }
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['external-api', String(apiId)] })
      qc.invalidateQueries({ queryKey: ['external-api-recorder'] })
      toast.success('Redaction rules saved')
    },
    onError: (e) => toast.error(errText(e, 'Failed to save redaction rules'))
  })
  return (
    <Card className='mt-5 p-6' data-redaction-card>
      <div className='flex items-start gap-2'>
        <ShieldOff className='mt-0.5 h-4 w-4 shrink-0 text-slate-400' />
        <div className='max-w-[72ch]'>
          <Label>Redaction</Label>
          <p className='text-[12px] text-slate-400'>
            Anything whose name looks like a credential is always masked. Name the rest here —
            headers or query parameters, and JSON body paths — and they are masked in the flight
            recorder, the call log, recorded mock answers and every Copy as curl.
          </p>
        </div>
      </div>
      <div className='mt-3 grid gap-3 lg:grid-cols-2'>
        <div className='space-y-1'>
          <Label className='text-[11px]'>Header / query names — one per line</Label>
          <Textarea
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            rows={4}
            placeholder={'x-partner-session\nx-customer-id'}
            className='font-mono text-[12px]'
            data-redaction-headers
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px]'>
            Body paths — one per line (<span className='font-mono'>a.b</span>,{' '}
            <span className='font-mono'>items[].card</span>,{' '}
            <span className='font-mono'>*.email</span>)
          </Label>
          <Textarea
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
            rows={4}
            placeholder={'customer.email\nitems[].card_number'}
            className='font-mono text-[12px]'
            data-redaction-paths
          />
        </div>
      </div>
      <div className='mt-3 flex justify-end'>
        <Button
          size='sm'
          onClick={() => save.mutate()}
          disabled={save.isPending}
          data-redaction-save
        >
          {save.isPending ? 'Saving…' : 'Save redaction rules'}
        </Button>
      </div>
    </Card>
  )
}

// ─── #612 / #603 — Health probes, uptime, SLOs ─────────────────────────────

interface UptimeResp {
  hours: number
  uptime_pct: number | null
  probes: number
  buckets: Array<{ at: string; ok: number; failed: number; token_ok: number; token_failed: number }>
}

interface SloFig {
  calls: number
  failed: number
  error_rate: number | null
  p50_ms: number | null
  p95_ms: number | null
  availability: number | null
  availability_source: 'probes' | 'calls' | null
}

interface SloResp extends SloFig {
  days: number
  truncated: boolean
  trend: Array<SloFig & { day: string }>
}

function Figure({ label, value, hook }: { label: string; value: string; hook: string }) {
  return (
    <div className='min-w-0 bg-white px-3 py-2 dark:bg-card' data-slo-figure={hook}>
      <dt className='truncate text-[11px] text-slate-500'>{label}</dt>
      <dd className='mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900 dark:text-slate-100'>
        {value}
      </dd>
    </div>
  )
}

function TrendBars({
  values,
  labels,
  tone,
  format
}: {
  values: Array<number | null>
  labels: string[]
  tone: 'negative' | 'neutral'
  format: (v: number | null) => string
}) {
  const max = Math.max(1, ...values.map((v) => v ?? 0))
  return (
    <div className='flex h-10 items-end gap-px'>
      {values.map((v, i) => (
        <span
          key={labels[i]}
          className='flex h-full min-w-0 flex-1 flex-col justify-end'
          data-tip={`${labels[i]} · ${format(v)}`}
          title={`${labels[i]} · ${format(v)}`}
        >
          {v == null || v === 0 ? (
            <span className='h-px w-full bg-slate-200 dark:bg-slate-700' />
          ) : (
            <span
              className={cn(
                'w-full rounded-t-[1px]',
                tone === 'negative' ? 'bg-red-500/80 dark:bg-red-400/80' : 'bg-nvr-cyan/70'
              )}
              style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
            />
          )}
        </span>
      ))}
    </div>
  )
}

export function HealthSloCard({
  apiId,
  data
}: {
  apiId: number
  data: {
    auth_type?: string
    health_path?: string | null
    health_method?: string | null
    health_expect_status?: number | null
    health_last_ok?: boolean | null
    health_last_at?: string | null
    health_last_detail?: string | null
  }
}) {
  const qc = useQueryClient()
  const [path, setPath] = useState(data.health_path ?? '')
  const [method, setMethod] = useState(data.health_method ?? 'GET')
  const [expect, setExpect] = useState(
    data.health_expect_status != null ? String(data.health_expect_status) : ''
  )
  const [days, setDays] = useState('7')
  useEffect(() => {
    setPath(data.health_path ?? '')
    setMethod(data.health_method ?? 'GET')
    setExpect(data.health_expect_status != null ? String(data.health_expect_status) : '')
  }, [data.health_path, data.health_method, data.health_expect_status])

  const uptime = useQuery({
    queryKey: ['external-api-uptime', apiId],
    queryFn: () =>
      api
        .get<{ data: UptimeResp }>(`/external-apis/${apiId}/uptime`, { params: { hours: 24 } })
        .then((r) => r.data.data)
  })
  const slo = useQuery({
    queryKey: ['external-api-slo', apiId, days],
    queryFn: () =>
      api
        .get<{ data: SloResp }>(`/external-apis/${apiId}/slo`, { params: { days } })
        .then((r) => r.data.data)
  })
  const saveCfg = useMutation({
    mutationFn: () =>
      api.patch(`/external-apis/${apiId}`, {
        health_path: path.trim() || null,
        health_method: method,
        health_expect_status: expect.trim() ? Number(expect) : null
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['external-api', String(apiId)] })
      toast.success(path.trim() ? 'Health probe saved' : 'Health probe turned off')
    },
    onError: (e) => toast.error(errText(e, 'Failed to save health probe'))
  })
  const probe = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { ok: boolean; detail: string; skipped?: string } }>(
          `/external-apis/${apiId}/probe`
        )
        .then((r) => r.data.data),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['external-api', String(apiId)] })
      qc.invalidateQueries({ queryKey: ['external-api-uptime', apiId] })
      qc.invalidateQueries({ queryKey: ['external-api-recorder'] })
      if (r.skipped) toast.message(`Probe skipped — ${r.detail}`)
      else if (r.ok) toast.success(`Healthy — ${r.detail}`)
      else toast.error(`Probe failed — ${r.detail}`)
    },
    onError: (e) => toast.error(errText(e, 'Probe failed'))
  })

  const oauth = data.auth_type === 'oauth2_cc'
  const expectOk = !expect.trim() || /^\d{3}$/.test(expect.trim())
  const u = uptime.data
  const s = slo.data
  const trend = s?.trend ?? []
  return (
    <Card className='mt-5 p-6' data-api-health-card>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='flex items-start gap-2'>
          <Radar className='mt-0.5 h-4 w-4 shrink-0 text-slate-400' />
          <div className='max-w-[72ch]'>
            <Label>Health & SLOs</Label>
            <p className='text-[12px] text-slate-400'>
              A health path is probed every 5 minutes on deployed instances
              {oauth ? ', with the token endpoint probed separately first' : ''}. Probes never count
              as partner calls. Latency, error rate and availability come from the real calls
              (availability from probes when there are any); set alerts on them in the Alert Manager
              under "External API".
            </p>
          </div>
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-8 gap-1.5 text-[12px]'
          onClick={() => probe.mutate()}
          disabled={probe.isPending || (!data.health_path && !oauth)}
          data-health-probe-now
        >
          <Activity className='h-3.5 w-3.5' />
          {probe.isPending ? 'Probing…' : 'Probe now'}
        </Button>
      </div>

      <div className='mt-3 flex flex-wrap items-end gap-2'>
        <div className='w-24 space-y-1'>
          <Label className='text-[11px]'>Method</Label>
          <SimpleSelect
            value={method}
            onChange={setMethod}
            ariaLabel='Probe method'
            className='h-8 text-[12.5px]'
            options={[
              { value: 'GET', label: 'GET' },
              { value: 'HEAD', label: 'HEAD' }
            ]}
          />
        </div>
        <div className='min-w-[220px] flex-1 space-y-1'>
          <Label className='text-[11px]'>Health path (blank = no probe)</Label>
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder='/health'
            className='h-8 font-mono text-[12px]'
            data-health-path
          />
        </div>
        <div className='w-28 space-y-1'>
          <Label className='text-[11px]'>Expect status</Label>
          <Input
            value={expect}
            onChange={(e) => setExpect(e.target.value)}
            placeholder='200'
            className={cn('h-8 text-[12.5px]', !expectOk && 'border-red-400')}
            data-health-expect
          />
        </div>
        <Button
          size='sm'
          className='h-8'
          onClick={() => saveCfg.mutate()}
          disabled={saveCfg.isPending || !expectOk}
          data-health-save
        >
          {saveCfg.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {data.health_last_at && (
        <p
          className={cn(
            'mt-2 text-[12px]',
            data.health_last_ok
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400'
          )}
          data-health-last={data.health_last_ok ? 'ok' : 'failed'}
        >
          Last probe {new Date(data.health_last_at).toLocaleString()} —{' '}
          {data.health_last_ok ? 'healthy' : 'failed'}
          {data.health_last_detail ? ` · ${data.health_last_detail}` : ''}
        </p>
      )}

      <div className='mt-4 space-y-1.5' data-uptime-strip>
        <div className='flex items-center justify-between text-[11.5px] text-slate-500'>
          <span>Probe uptime, last 24 hours</span>
          <span className='font-medium tabular-nums text-slate-800 dark:text-slate-200'>
            {u && u.probes > 0 ? `${u.uptime_pct}% of ${u.probes} probes` : 'No probes yet'}
          </span>
        </div>
        <div className='flex h-3 items-stretch gap-px'>
          {(u?.buckets ?? []).map((b) => {
            const ok = b.ok + b.token_ok
            const failed = b.failed + b.token_failed
            const label = new Date(b.at).toLocaleString(undefined, {
              weekday: 'short',
              hour: 'numeric'
            })
            return (
              <span
                key={b.at}
                className={cn(
                  'min-w-0 flex-1 rounded-[1px]',
                  ok + failed === 0
                    ? 'bg-slate-200 dark:bg-slate-700'
                    : failed > 0
                      ? 'bg-red-500 dark:bg-red-400'
                      : 'bg-emerald-500/80 dark:bg-emerald-400/70'
                )}
                title={
                  ok + failed === 0
                    ? `${label} · no probes`
                    : `${label} · ${ok} ok · ${failed} failed`
                }
              />
            )
          })}
        </div>
      </div>

      <div className='mt-5 flex items-center justify-between gap-2'>
        <p className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>Service levels</p>
        <SimpleSelect
          value={days}
          onChange={setDays}
          ariaLabel='SLO window'
          className='h-7 w-32 text-[12px]'
          triggerProps={{ 'data-slo-window': '' }}
          options={[
            { value: '1', label: 'Last day' },
            { value: '7', label: 'Last 7 days' },
            { value: '30', label: 'Last 30 days' }
          ]}
        />
      </div>
      <dl className='mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-5 dark:border-border dark:bg-border'>
        <Figure label='Calls' value={s ? s.calls.toLocaleString() : '—'} hook='calls' />
        <Figure label='Typical (p50)' value={fmtMs(s?.p50_ms)} hook='p50' />
        <Figure label='Slow (p95)' value={fmtMs(s?.p95_ms)} hook='p95' />
        <Figure label='Error rate' value={fmtPct(s?.error_rate)} hook='error-rate' />
        <Figure
          label={`Availability${s?.availability_source ? ` (${s.availability_source})` : ''}`}
          value={fmtPct(s?.availability)}
          hook='availability'
        />
      </dl>
      {s?.truncated && (
        <p className='mt-1 text-[11px] text-amber-700 dark:text-amber-400'>
          More than 50,000 calls in the window — figures use the newest 50,000.
        </p>
      )}
      {trend.length > 1 && (
        <div className='mt-3 grid gap-4 sm:grid-cols-2' data-slo-trend>
          <div>
            <p className='mb-1 text-[11px] text-slate-500'>Error rate by day</p>
            <TrendBars
              values={trend.map((t) => t.error_rate)}
              labels={trend.map((t) => t.day)}
              tone='negative'
              format={fmtPct}
            />
          </div>
          <div>
            <p className='mb-1 text-[11px] text-slate-500'>p95 latency by day</p>
            <TrendBars
              values={trend.map((t) => t.p95_ms)}
              labels={trend.map((t) => t.day)}
              tone='neutral'
              format={fmtMs}
            />
          </div>
        </div>
      )}
    </Card>
  )
}

// ─── #623 — Contract from real traffic ─────────────────────────────────────

interface InferResp {
  contract: Record<string, unknown> | null
  samples: number
  statuses?: number[]
  paths_seen?: number
  notes: string[]
  oldest?: string | null
  newest?: string | null
}

export function ContractFromTraffic({
  endpointId,
  onUse
}: {
  endpointId: number
  onUse: (contractJson: string) => void
}) {
  const [proposal, setProposal] = useState<InferResp | null>(null)
  const infer = useMutation({
    mutationFn: () =>
      api
        .post<{ data: InferResp }>(`/external-apis/endpoints/${endpointId}/contract/infer`)
        .then((r) => r.data.data),
    onSuccess: setProposal,
    onError: (e) => toast.error(errText(e, 'Could not read recent calls'))
  })
  return (
    <div className='space-y-2'>
      <Button
        type='button'
        size='sm'
        variant='outline'
        className='h-7 gap-1.5 text-[12px]'
        onClick={() => infer.mutate()}
        disabled={infer.isPending}
        data-contract-infer
      >
        <Sparkles className='h-3.5 w-3.5' />
        {infer.isPending ? 'Reading calls…' : 'Generate from the last 50 calls'}
      </Button>
      {proposal && (
        <div
          className='space-y-2 rounded-md border border-nvr-cyan/40 bg-white p-3 dark:bg-card'
          data-contract-proposal
        >
          {proposal.contract ? (
            <>
              <p className='text-[12px] text-slate-600 dark:text-slate-300'>
                Learned from {proposal.samples} successful answer
                {proposal.samples === 1 ? '' : 's'}
                {proposal.statuses?.length ? ` (status ${proposal.statuses.join(', ')})` : ''}
                {proposal.paths_seen != null ? ` — ${proposal.paths_seen} stable paths` : ''}.
              </p>
              {proposal.notes.map((n) => (
                <p key={n} className='text-[11.5px] text-amber-700 dark:text-amber-400'>
                  {n}
                </p>
              ))}
              <Pre value={proposal.contract} />
              <div className='flex justify-end gap-2'>
                <Button size='sm' variant='ghost' onClick={() => setProposal(null)}>
                  Dismiss
                </Button>
                <Button
                  size='sm'
                  onClick={() => {
                    onUse(JSON.stringify(proposal.contract, null, 2))
                    setProposal(null)
                    toast.success('Contract filled in — save the endpoint to keep it')
                  }}
                  data-contract-infer-use
                >
                  Use this contract
                </Button>
              </div>
            </>
          ) : (
            <>
              {proposal.notes.map((n) => (
                <p key={n} className='text-[12px] text-slate-500'>
                  {n}
                </p>
              ))}
              <div className='flex justify-end'>
                <Button size='sm' variant='ghost' onClick={() => setProposal(null)}>
                  Close
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
