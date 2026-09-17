import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'

/**
 * AI call analytics — the /api-analytics twin for model calls. Reads the
 * admin-only GET /ai/analytics (aggregates over nivaro_ai_calls: calls,
 * questions, tokens, spend, latency, by feature / model / user, a bucketed
 * series) and GET /ai/calls (the per-call log with capped request/response
 * bodies on expand). A "question" is one HTTP request; Ask AI runs several
 * calls per question, which is why both numbers show.
 */

interface Summary {
  hours: number
  calls: number
  requests: number
  errors: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cost_usd: number
  avg_latency: number
  p50: number
  p95: number
  tool_calls: number
  feedback?: { up: number; down: number }
  by_feature: Array<{
    feature: string
    calls: number
    requests: number
    errors: number
    cost_usd: number
    input_tokens: number
    output_tokens: number
    avg_latency: number
  }>
  by_model: Array<{
    model: string
    provider: string
    calls: number
    cost_usd: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    avg_latency: number
  }>
  by_user: Array<{
    user: string | null
    name: string
    calls: number
    requests: number
    cost_usd: number
  }>
  series: Array<{ bucket: string; calls: number; errors: number; cost_usd: number }>
}

export interface AiCallRow {
  id: number
  created_at: string
  request_id: string | null
  user: string | null
  user_name: string | null
  feature: string
  route: string | null
  provider: string
  model: string
  status: 'ok' | 'error'
  latency_ms: number
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cost_usd: number | null
  stop_reason: string | null
  tool_calls: number | null
  rounds: number | null
  error: string | null
}

const RANGES = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 }
]

const usd = (n: number | null | undefined, digits = 2) =>
  n == null ? '—' : `$${n.toFixed(n < 0.1 && n > 0 ? 4 : digits)}`
const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())
const tok = (n: number | null | undefined) =>
  n == null
    ? '—'
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 10_000
        ? `${(n / 1000).toFixed(1)}k`
        : n.toLocaleString()

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className='rounded-lg border border-border bg-card px-3 py-2.5' data-ai-tile={label}>
      <div className='text-[10.5px] uppercase tracking-wide text-muted-foreground'>{label}</div>
      <div className='mt-0.5 text-lg font-semibold tabular-nums'>{value}</div>
      {sub ? <div className='text-[11px] text-muted-foreground'>{sub}</div> : null}
    </div>
  )
}

function Bars({ series }: { series: Summary['series'] }) {
  const max = Math.max(1, ...series.map((s) => s.calls))
  if (series.length === 0)
    return (
      <p className='py-6 text-center text-[12px] text-muted-foreground'>
        No AI calls in this window.
      </p>
    )
  return (
    <div className='flex h-28 items-end gap-[3px] overflow-x-auto' data-ai-series>
      {series.map((s) => (
        <div
          key={s.bucket}
          className='group relative flex min-w-[6px] flex-1 flex-col justify-end'
          data-tip={`${s.bucket} · ${s.calls} calls · ${s.errors} errors · ${usd(s.cost_usd)}`}
        >
          <div
            className={cn('rounded-t-sm', s.errors > 0 ? 'bg-amber-500/80' : 'bg-nvr-cyan/70')}
            style={{ height: `${Math.max(2, (s.calls / max) * 100)}%` }}
          />
        </div>
      ))}
    </div>
  )
}

function Pretty({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <pre className='max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.04] p-2 font-mono text-[11px] leading-snug dark:bg-white/[0.06]'>
      {text}
    </pre>
  )
}

function CallDetail({ id }: { id: number }) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-ai-call', id],
    queryFn: () => client.request<{ data: Record<string, unknown> }>(get(`/ai/calls/${id}`))
  })
  if (isLoading) return <p className='text-[12px] text-muted-foreground'>Loading…</p>
  const row = data?.data
  if (!row) return null
  return (
    <div className='grid gap-3 lg:grid-cols-2' data-ai-call-detail>
      <div>
        <div className='mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
          Request
        </div>
        <Pretty value={row.request ?? '(not stored)'} />
      </div>
      <div>
        <div className='mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
          {row.status === 'error' ? 'Error' : 'Response'}
        </div>
        <Pretty value={row.status === 'error' ? row.error : (row.response ?? '(not stored)')} />
      </div>
    </div>
  )
}

export function AiAnalyticsView() {
  const client = useNivaroClient()
  const [hours, setHours] = useState(168)
  const [feature, setFeature] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [requestId, setRequestId] = useState<string>('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<number | null>(null)

  const summary = useQuery({
    queryKey: ['nvr-ai-analytics', hours],
    queryFn: () => client.request<{ data: Summary }>(get('/ai/analytics', { hours })),
    refetchInterval: 60_000
  })
  const calls = useQuery({
    queryKey: ['nvr-ai-calls', hours, feature, status, requestId, page],
    queryFn: () =>
      client.request<{ data: AiCallRow[]; total: number; limit: number }>(
        get('/ai/calls', {
          hours,
          ...(feature ? { feature } : {}),
          ...(status ? { status } : {}),
          ...(requestId ? { request_id: requestId } : {}),
          page,
          limit: 50
        })
      ),
    placeholderData: (prev) => prev
  })
  const s = summary.data?.data
  const rows = calls.data?.data ?? []
  const total = calls.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / 50))

  return (
    <div className='flex flex-col gap-4' data-ai-analytics>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='inline-flex rounded-md border border-border p-0.5'>
          {RANGES.map((r) => (
            <button
              key={r.hours}
              type='button'
              onClick={() => {
                setHours(r.hours)
                setPage(1)
              }}
              className={cn(
                'rounded px-2.5 py-1 text-[12px]',
                hours === r.hours
                  ? 'bg-nvr-cyan/15 font-medium'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          type='button'
          onClick={() => {
            void summary.refetch()
            void calls.refetch()
          }}
          className='inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-muted-foreground hover:bg-muted'
        >
          <RotateCw className='h-3.5 w-3.5' /> Refresh
        </button>
        <span className='text-[11.5px] text-muted-foreground'>
          Every model call through the AI provider, with tokens and list-price cost. Bodies are kept
          30 days.
        </span>
      </div>

      <div className='grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8'>
        <Tile label='Questions' value={num(s?.requests)} sub='requests to the API' />
        <Tile
          label='Model calls'
          value={num(s?.calls)}
          sub={s ? `${(s.calls / Math.max(1, s.requests)).toFixed(1)} per question` : undefined}
        />
        <Tile label='Spend' value={usd(s?.cost_usd)} sub='list price' />
        <Tile
          label='Errors'
          value={num(s?.errors)}
          sub={s && s.calls ? `${((s.errors / s.calls) * 100).toFixed(1)}%` : undefined}
        />
        <Tile
          label='Input tokens'
          value={tok(s?.input_tokens)}
          sub={s ? `${tok(s.cache_read_tokens)} from cache` : undefined}
        />
        <Tile label='Output tokens' value={tok(s?.output_tokens)} />
        <Tile
          label='Latency p50'
          value={s ? `${(s.p50 / 1000).toFixed(1)}s` : '—'}
          sub={s ? `avg ${(s.avg_latency / 1000).toFixed(1)}s` : undefined}
        />
        <Tile
          label='Latency p95'
          value={s ? `${(s.p95 / 1000).toFixed(1)}s` : '—'}
          sub={s ? `${num(s.tool_calls)} tool calls` : undefined}
        />
        <Tile
          label='Helpful'
          value={
            s?.feedback && s.feedback.up + s.feedback.down > 0
              ? `${Math.round((s.feedback.up / (s.feedback.up + s.feedback.down)) * 100)}%`
              : '—'
          }
          sub={s?.feedback ? `${num(s.feedback.up)} up · ${num(s.feedback.down)} down` : undefined}
        />
      </div>

      <div className='rounded-lg border border-border bg-card p-3'>
        <div className='mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
          Calls {hours <= 48 ? 'per hour' : 'per day'}
        </div>
        <Bars series={s?.series ?? []} />
      </div>

      <div className='grid gap-3 lg:grid-cols-3'>
        <BreakdownTable
          title='By feature'
          rows={(s?.by_feature ?? []).map((r) => ({
            key: r.feature,
            label: r.feature,
            cells: [
              num(r.requests),
              num(r.calls),
              usd(r.cost_usd),
              `${(r.avg_latency / 1000).toFixed(1)}s`,
              num(r.errors)
            ]
          }))}
          heads={['Questions', 'Calls', 'Spend', 'Avg', 'Err']}
          onPick={(k) => {
            setFeature(k === feature ? '' : k)
            setPage(1)
          }}
          active={feature}
        />
        <BreakdownTable
          title='By model'
          rows={(s?.by_model ?? []).map((r) => ({
            key: r.model,
            label: `${r.model} · ${r.provider}`,
            cells: [
              num(r.calls),
              usd(r.cost_usd),
              tok(r.input_tokens),
              tok(r.cache_read_tokens),
              tok(r.output_tokens)
            ]
          }))}
          heads={['Calls', 'Spend', 'In', 'Cached', 'Out']}
        />
        <BreakdownTable
          title='By person'
          rows={(s?.by_user ?? []).map((r) => ({
            key: r.user ?? 'system',
            label: r.name,
            cells: [num(r.requests), num(r.calls), usd(r.cost_usd)]
          }))}
          heads={['Questions', 'Calls', 'Spend']}
        />
      </div>

      <div className='rounded-lg border border-border bg-card' data-ai-call-log>
        <div className='flex flex-wrap items-center gap-2 border-b border-border px-3 py-2'>
          <span className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
            Call log
          </span>
          {feature ? (
            <button
              type='button'
              onClick={() => setFeature('')}
              className='rounded bg-nvr-cyan/15 px-1.5 py-0.5 text-[11px]'
            >
              feature: {feature} ×
            </button>
          ) : null}
          <div className='inline-flex rounded-md border border-border p-0.5 text-[11px]'>
            {[
              ['', 'All'],
              ['ok', 'OK'],
              ['error', 'Errors']
            ].map(([v, l]) => (
              <button
                key={v}
                type='button'
                onClick={() => {
                  setStatus(v)
                  setPage(1)
                }}
                className={cn(
                  'rounded px-2 py-0.5',
                  status === v ? 'bg-nvr-cyan/15 font-medium' : 'text-muted-foreground'
                )}
              >
                {l}
              </button>
            ))}
          </div>
          {requestId ? (
            <button
              type='button'
              onClick={() => setRequestId('')}
              className='rounded bg-nvr-cyan/15 px-1.5 py-0.5 text-[11px]'
            >
              question {requestId.slice(0, 8)} ×
            </button>
          ) : null}
          <span className='ml-auto text-[11px] text-muted-foreground'>
            {total.toLocaleString()} calls · page {page} of {pages}
          </span>
        </div>
        <div className='overflow-x-auto'>
          <table className='w-full text-left text-[12px]'>
            <thead className='text-[10.5px] uppercase tracking-wide text-muted-foreground'>
              <tr className='border-b border-border'>
                <th className='w-6 px-2 py-1.5' />
                <th className='px-2 py-1.5'>When</th>
                <th className='px-2 py-1.5'>Feature</th>
                <th className='px-2 py-1.5'>Person</th>
                <th className='px-2 py-1.5'>Model</th>
                <th className='px-2 py-1.5 text-right'>In</th>
                <th className='px-2 py-1.5 text-right'>Cached</th>
                <th className='px-2 py-1.5 text-right'>Out</th>
                <th className='px-2 py-1.5 text-right'>Cost</th>
                <th className='px-2 py-1.5 text-right'>Time</th>
                <th className='px-2 py-1.5'>Result</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-border tabular-nums'>
              {rows.map((r) => (
                <>
                  <tr
                    key={r.id}
                    data-ai-call={r.id}
                    className={cn(
                      'cursor-pointer hover:bg-muted/50',
                      open === r.id && 'bg-muted/40'
                    )}
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                  >
                    <td className='px-2 py-1.5 text-muted-foreground'>
                      {open === r.id ? (
                        <ChevronDown className='h-3.5 w-3.5' />
                      ) : (
                        <ChevronRight className='h-3.5 w-3.5' />
                      )}
                    </td>
                    <td
                      className='whitespace-nowrap px-2 py-1.5'
                      data-tip={formatDateTime(r.created_at)}
                    >
                      {formatRelative(r.created_at)}
                    </td>
                    <td className='px-2 py-1.5'>
                      <span className='rounded bg-muted px-1.5 py-0.5 text-[11px]'>
                        {r.feature}
                      </span>
                      {r.request_id ? (
                        <button
                          type='button'
                          className='ml-1 text-[10.5px] text-muted-foreground underline-offset-2 hover:underline'
                          data-tip='Show every call of this question'
                          onClick={(e) => {
                            e.stopPropagation()
                            setRequestId(r.request_id ?? '')
                            setPage(1)
                          }}
                        >
                          #{r.request_id.slice(0, 6)}
                        </button>
                      ) : null}
                    </td>
                    <td className='max-w-[160px] truncate px-2 py-1.5'>
                      {r.user_name ?? (r.user ? '…' : 'System')}
                    </td>
                    <td className='px-2 py-1.5 font-mono text-[11px]'>{r.model}</td>
                    <td className='px-2 py-1.5 text-right'>{tok(r.input_tokens)}</td>
                    <td className='px-2 py-1.5 text-right text-muted-foreground'>
                      {tok(r.cache_read_tokens)}
                    </td>
                    <td className='px-2 py-1.5 text-right'>{tok(r.output_tokens)}</td>
                    <td className='px-2 py-1.5 text-right'>{usd(r.cost_usd, 3)}</td>
                    <td className='px-2 py-1.5 text-right'>{(r.latency_ms / 1000).toFixed(1)}s</td>
                    <td className='px-2 py-1.5'>
                      {r.status === 'error' ? (
                        <span className='text-red-700 dark:text-red-400' data-tip={r.error ?? ''}>
                          error
                        </span>
                      ) : (
                        <span className='text-muted-foreground'>
                          {r.stop_reason ?? 'ok'}
                          {r.tool_calls ? ` · ${r.tool_calls} tool` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                  {open === r.id ? (
                    <tr key={`${r.id}-d`} className='bg-muted/20'>
                      <td colSpan={11} className='px-3 py-3'>
                        <CallDetail id={r.id} />
                      </td>
                    </tr>
                  ) : null}
                </>
              ))}
              {rows.length === 0 && !calls.isLoading ? (
                <tr>
                  <td colSpan={11} className='px-3 py-6 text-center text-muted-foreground'>
                    No calls match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className='flex items-center justify-end gap-2 border-t border-border px-3 py-2 text-[12px]'>
          <button
            type='button'
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className='rounded border border-border px-2 py-0.5 disabled:opacity-40'
          >
            Prev
          </button>
          <button
            type='button'
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
            className='rounded border border-border px-2 py-0.5 disabled:opacity-40'
          >
            Next
          </button>
        </div>
      </div>
    </div>
  )
}

function BreakdownTable({
  title,
  heads,
  rows,
  onPick,
  active
}: {
  title: string
  heads: string[]
  rows: Array<{ key: string; label: string; cells: string[] }>
  onPick?: (key: string) => void
  active?: string
}) {
  return (
    <div
      className='overflow-x-auto rounded-lg border border-border bg-card'
      data-ai-breakdown={title}
    >
      <table className='w-full text-left text-[12px]'>
        <thead className='text-[10.5px] uppercase tracking-wide text-muted-foreground'>
          <tr className='border-b border-border'>
            <th className='px-3 py-1.5'>{title}</th>
            {heads.map((h) => (
              <th key={h} className='px-2 py-1.5 text-right'>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className='divide-y divide-border tabular-nums'>
          {rows.map((r) => (
            <tr
              key={r.key}
              className={cn(
                onPick && 'cursor-pointer hover:bg-muted/50',
                active === r.key && 'bg-nvr-cyan/10'
              )}
              onClick={() => onPick?.(r.key)}
            >
              <td className='max-w-[220px] truncate px-3 py-1.5'>{r.label}</td>
              {r.cells.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed column order
                <td key={i} className='px-2 py-1.5 text-right'>
                  {c}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={heads.length + 1}
                className='px-3 py-4 text-center text-muted-foreground'
              >
                Nothing yet
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
