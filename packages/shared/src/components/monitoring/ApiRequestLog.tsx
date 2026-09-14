import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ChevronDown, ChevronRight, KeyRound, RotateCw, Search, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { UserAvatar } from '../UserAvatar'

/**
 * Per-request API log — the list behind the /api-analytics aggregates, and
 * the surface an integration's calls are read from ("why did MWF's push at
 * 10:42 400?"). Reads GET /api-analytics/requests (admin). Filters compile to
 * query params so the server does the work; the table pages at 50.
 *
 * `InboundCallersView` sits above it on the Integrations page: one card per
 * non-session caller (static-token user or named API key) from
 * GET /api-analytics/callers, and picking a card scopes the list to it.
 * Needs `<NivaroProvider>`.
 */

export interface ApiLogRow {
  id: number
  method: string
  path: string
  status: number
  latency_ms: number
  user: string | null
  user_name: string | null
  user_email: string | null
  collection: string | null
  api_key_id: number | null
  api_key_name: string | null
  auth: 'session' | 'token' | 'api_key' | 'masquerade' | 'none' | null
  ip: string | null
  user_agent: string | null
  error: string | null
  created_at: string
}

export interface ApiCaller {
  key: string
  kind: 'api_key' | 'token'
  label: string
  email: string | null
  user: string | null
  api_key_id: number | null
  user_status: string | null
  key_expires_at: string | null
  calls: number
  errors: number
  avg_ms: number
  max_ms: number
  last_at: string
  last_error: {
    at: string
    status: number
    method: string
    path: string
    error: string | null
  } | null
  top_paths: Array<{ method: string; path: string; calls: number; errors: number }>
}

export interface ApiRequestLogFilters {
  path?: string
  method?: string
  status?: string
  auth?: string
  user?: string
  api_key?: number | null
  inbound?: boolean
  errors?: boolean
}

const AUTH_LABEL: Record<string, string> = {
  session: 'session',
  token: 'token',
  api_key: 'API key',
  masquerade: 'masquerade',
  none: 'anonymous'
}

const AUTH_CLS: Record<string, string> = {
  session: 'bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300',
  token: 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200',
  api_key: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200',
  masquerade: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  none: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200'
}

function statusCls(status: number): string {
  if (status >= 500) return 'text-red-700 dark:text-red-400'
  if (status >= 400) return 'text-amber-700 dark:text-amber-400'
  if (status >= 300) return 'text-slate-500'
  return 'text-emerald-700 dark:text-emerald-400'
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

/** Pretty-print a stored error body: JSON gets indented, anything else is shown as-is. */
function prettyError(raw: string | null): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function shortError(raw: string | null): string {
  if (!raw) return ''
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    const msg =
      j.error ??
      j.message ??
      (Array.isArray(j.errors) ? (j.errors[0] as { message?: string })?.message : null)
    if (typeof msg === 'string') return msg
    if (
      msg &&
      typeof msg === 'object' &&
      typeof (msg as { message?: string }).message === 'string'
    ) {
      return (msg as { message: string }).message
    }
  } catch {
    /* not json */
  }
  return raw.replace(/\s+/g, ' ').slice(0, 160)
}

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx']

export function ApiRequestLog({
  hours = 24,
  filters: outer,
  onFiltersChange,
  title = 'Requests',
  description,
  embedded = false,
  refetchMs = 30_000
}: {
  hours?: number
  /** Controlled filters (the Integrations page drives these from the caller cards). */
  filters?: ApiRequestLogFilters
  onFiltersChange?: (f: ApiRequestLogFilters) => void
  title?: string
  description?: string
  /** No card chrome — the host draws its own frame. */
  embedded?: boolean
  refetchMs?: number | false
}) {
  const client = useNivaroClient()
  const [local, setLocal] = useState<ApiRequestLogFilters>(outer ?? {})
  const filters = outer ?? local
  const setFilters = (next: ApiRequestLogFilters) => {
    setLocal(next)
    onFiltersChange?.(next)
    setPage(1)
  }
  const [page, setPage] = useState(1)
  const [pathDraft, setPathDraft] = useState(filters.path ?? '')
  const [open, setOpen] = useState<number | null>(null)

  // Debounce the path box — every keystroke would otherwise be a LIKE scan.
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce keyed on the draft only
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.path ?? '') !== pathDraft)
        setFilters({ ...filters, path: pathDraft || undefined })
    }, 350)
    return () => clearTimeout(t)
  }, [pathDraft])
  // biome-ignore lint/correctness/useExhaustiveDependencies: mirror a controlled path change into the box
  useEffect(() => {
    if (outer && (outer.path ?? '') !== pathDraft) setPathDraft(outer.path ?? '')
  }, [outer?.path])

  const params = useMemo(() => {
    const p: Record<string, unknown> = { hours, page, limit: 50 }
    if (filters.path) p.path = filters.path
    if (filters.method) p.method = filters.method
    if (filters.status) p.status = filters.status
    if (filters.user) p.user = filters.user
    if (filters.api_key != null) p.api_key = filters.api_key
    if (filters.inbound) p.inbound = 1
    else if (filters.auth) p.auth = filters.auth
    if (filters.errors) p.errors = 1
    return p
  }, [filters, hours, page])

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['api-request-log', params],
    queryFn: () =>
      client.request<{ data: ApiLogRow[]; total: number }>(get('/api-analytics/requests', params)),
    refetchInterval: refetchMs === false ? false : refetchMs,
    placeholderData: (prev) => prev
  })
  const rows = data?.data ?? []
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / 50))

  const activeChips: Array<{ key: keyof ApiRequestLogFilters; label: string }> = []
  if (filters.user) activeChips.push({ key: 'user', label: 'one caller' })
  if (filters.api_key != null)
    activeChips.push({ key: 'api_key', label: `API key #${filters.api_key}` })
  if (filters.inbound) activeChips.push({ key: 'inbound', label: 'integrations only' })
  if (filters.errors) activeChips.push({ key: 'errors', label: 'errors only' })

  const body = (
    <>
      <div className='flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-border/60'>
        <label className='relative min-w-[200px] flex-1'>
          <Search className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <input
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            placeholder='Path contains… e.g. /files, graphql, mwf_queue'
            className='h-8 w-full rounded-md border border-slate-200 bg-white pl-7 pr-2 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-foreground'
            data-api-log-path
          />
        </label>
        <Segment
          value={filters.method ?? ''}
          options={[['', 'Any method'], ...METHODS.map((m) => [m, m] as [string, string])]}
          onChange={(v) => setFilters({ ...filters, method: v || undefined })}
        />
        <Segment
          value={filters.status ?? ''}
          options={[['', 'Any status'], ...STATUS_CLASSES.map((s) => [s, s] as [string, string])]}
          onChange={(v) => setFilters({ ...filters, status: v || undefined })}
        />
        {!filters.inbound && (
          <Segment
            value={filters.auth ?? ''}
            options={[
              ['', 'Any auth'],
              ['session', 'Session'],
              ['token', 'Token'],
              ['api_key', 'API key'],
              ['masquerade', 'Masquerade'],
              ['none', 'Anonymous']
            ]}
            onChange={(v) => setFilters({ ...filters, auth: v || undefined })}
          />
        )}
        <button
          type='button'
          onClick={() => setFilters({ ...filters, errors: !filters.errors })}
          className={cn(
            'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium',
            filters.errors
              ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200'
              : 'border-slate-200 text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
          )}
        >
          <AlertCircle className='h-3.5 w-3.5' /> Errors
        </button>
        {activeChips.map((c) => (
          <button
            key={c.key}
            type='button'
            onClick={() => setFilters({ ...filters, [c.key]: undefined })}
            className='inline-flex h-7 items-center gap-1 rounded-full bg-nvr-cyan/10 px-2.5 text-[11px] font-medium text-slate-700 hover:bg-nvr-cyan/20 dark:text-slate-200'
          >
            {c.label} <X className='h-3 w-3' />
          </button>
        ))}
        <span className='ml-auto text-[11px] tabular-nums text-slate-400'>
          {total.toLocaleString()} request{total === 1 ? '' : 's'} · last {hours}h
        </span>
        <button
          type='button'
          onClick={() => void refetch()}
          aria-label='Refresh'
          className='rounded p-1 text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-200'
        >
          <RotateCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
        </button>
      </div>

      {isLoading ? (
        <div className='space-y-1.5 p-3'>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className='h-7 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className='px-4 py-8 text-center text-[12px] text-slate-400'>
          No requests match — widen the window or clear a filter.
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full text-[12px] tabular-nums' data-api-log-table>
            <thead>
              <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
                <th className='w-6 px-2 py-1.5' />
                <th className='px-2 py-1.5 font-semibold'>When</th>
                <th className='px-2 py-1.5 font-semibold'>Caller</th>
                <th className='px-2 py-1.5 font-semibold'>Request</th>
                <th className='px-2 py-1.5 text-right font-semibold'>Status</th>
                <th className='px-2 py-1.5 text-right font-semibold'>Time</th>
                <th className='px-2 py-1.5 font-semibold'>Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.id
                const callerLabel =
                  r.api_key_name ??
                  r.user_name ??
                  r.user_email ??
                  (r.user ? `#${r.user.slice(0, 8)}` : '—')
                return (
                  <RowGroup key={r.id}>
                    <tr
                      className={cn(
                        'cursor-pointer border-t border-slate-100 hover:bg-muted/60 dark:border-border',
                        r.status >= 400 && 'bg-red-50/40 dark:bg-red-500/5'
                      )}
                      onClick={() => setOpen(isOpen ? null : r.id)}
                      data-api-log-row={r.id}
                    >
                      <td className='px-2 py-1.5 text-slate-400'>
                        {isOpen ? (
                          <ChevronDown className='h-3.5 w-3.5' />
                        ) : (
                          <ChevronRight className='h-3.5 w-3.5' />
                        )}
                      </td>
                      <td
                        className='whitespace-nowrap px-2 py-1.5 text-slate-500'
                        data-tip={formatDateTime(r.created_at)}
                      >
                        {formatRelative(r.created_at)}
                      </td>
                      <td className='max-w-[220px] px-2 py-1.5'>
                        <div className='flex items-center gap-1.5'>
                          {r.auth === 'api_key' ? (
                            <span className='inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200'>
                              <KeyRound className='h-3 w-3' />
                            </span>
                          ) : r.user ? (
                            <UserAvatar
                              userId={r.user}
                              className='h-5 w-5 shrink-0 rounded-full'
                              fallback={
                                <span className='inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#00ceff33] text-[8.5px] font-semibold text-slate-700 dark:text-slate-100'>
                                  {initials(callerLabel)}
                                </span>
                              }
                            />
                          ) : null}
                          <span className='min-w-0 truncate text-slate-700 dark:text-foreground'>
                            {callerLabel}
                          </span>
                          <span
                            className={cn(
                              'shrink-0 rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide',
                              AUTH_CLS[r.auth ?? 'none']
                            )}
                          >
                            {AUTH_LABEL[r.auth ?? 'none']}
                          </span>
                        </div>
                      </td>
                      <td className='max-w-[360px] px-2 py-1.5'>
                        <span className='mr-1.5 inline-block w-12 font-mono text-[10.5px] font-semibold text-slate-500'>
                          {r.method}
                        </span>
                        <span
                          className='truncate font-mono text-[11px] text-slate-700 dark:text-foreground'
                          data-tip={r.path}
                        >
                          {r.path}
                        </span>
                      </td>
                      <td
                        className={cn('px-2 py-1.5 text-right font-semibold', statusCls(r.status))}
                      >
                        {r.status}
                      </td>
                      <td className='px-2 py-1.5 text-right text-slate-500'>{r.latency_ms}ms</td>
                      <td className='max-w-[280px] truncate px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300'>
                        {shortError(r.error)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className='border-t border-slate-100 bg-slate-50/60 dark:border-border dark:bg-background/40'>
                        <td />
                        <td colSpan={6} className='px-2 py-2'>
                          <dl className='grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2 lg:grid-cols-4'>
                            <Detail label='At' value={formatDateTime(r.created_at)} />
                            <Detail label='IP' value={r.ip ?? '—'} mono />
                            <Detail label='Caller' value={r.user_email ?? r.api_key_name ?? '—'} />
                            <Detail label='Collection' value={r.collection ?? '—'} mono />
                            <Detail label='User agent' value={r.user_agent ?? '—'} mono wide />
                          </dl>
                          {r.error && (
                            <pre className='mt-2 max-h-56 overflow-auto rounded-md border border-red-200 bg-white p-2 text-[11px] leading-snug text-red-800 dark:border-red-500/30 dark:bg-[#1a1416] dark:text-red-200'>
                              {prettyError(r.error)}
                            </pre>
                          )}
                        </td>
                      </tr>
                    )}
                  </RowGroup>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className='flex items-center justify-between border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500 dark:border-border/60'>
          <span>
            Page {page} of {pages}
          </span>
          <div className='flex gap-1'>
            <button
              type='button'
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className='rounded border border-slate-200 px-2 py-0.5 hover:bg-muted disabled:opacity-40 dark:border-border'
            >
              Newer
            </button>
            <button
              type='button'
              disabled={page >= pages}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              className='rounded border border-slate-200 px-2 py-0.5 hover:bg-muted disabled:opacity-40 dark:border-border'
            >
              Older
            </button>
          </div>
        </div>
      )}
    </>
  )

  if (embedded) return body
  return (
    <div
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-api-request-log
    >
      <header className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h3>
        {description && <p className='text-[11px] text-slate-400'>{description}</p>}
      </header>
      {body}
    </div>
  )
}

function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function Detail({
  label,
  value,
  mono,
  wide
}: {
  label: string
  value: string
  mono?: boolean
  wide?: boolean
}) {
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2 lg:col-span-4')}>
      <dt className='text-[9.5px] font-semibold uppercase tracking-wide text-slate-400'>{label}</dt>
      <dd
        className={cn(
          'truncate text-slate-700 dark:text-foreground',
          mono && 'font-mono text-[10.5px]'
        )}
        data-tip={value}
      >
        {value}
      </dd>
    </div>
  )
}

function Segment({
  value,
  options,
  onChange
}: {
  value: string
  options: Array<[string, string]>
  onChange: (v: string) => void
}) {
  return (
    <div className='inline-flex h-8 overflow-hidden rounded-md border border-slate-200 dark:border-border'>
      {options.map(([v, label]) => (
        <button
          key={v || '_any'}
          type='button'
          onClick={() => onChange(v)}
          className={cn(
            'px-2 text-[11px] font-medium transition-colors',
            value === v
              ? 'bg-[#1e293b] text-white dark:bg-[#e2e8f0] dark:text-[#0f172a]'
              : 'text-slate-600 hover:bg-muted dark:text-slate-300'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * Inbound integrations — every caller that is not a person's browser session,
 * as cards, plus the request log scoped to the picked one. This is the
 * dedicated "external API logs" view: MWF's file pushes, LinX/Nuvolo GraphQL
 * writes, named API keys — who called, how often, what failed, and the exact
 * response body the caller got back.
 */
export function InboundCallersView({ hours: initialHours = 24 }: { hours?: number }) {
  const client = useNivaroClient()
  const [hours, setHours] = useState<number>(initialHours)
  const [picked, setPicked] = useState<ApiCaller | null>(null)
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['api-inbound-callers', hours],
    queryFn: () => client.request<{ data: ApiCaller[] }>(get('/api-analytics/callers', { hours })),
    refetchInterval: 30_000
  })
  const callers = data?.data ?? []

  const filters: ApiRequestLogFilters = picked
    ? picked.kind === 'api_key'
      ? { api_key: picked.api_key_id, inbound: true }
      : { user: picked.user ?? undefined, inbound: true }
    : { inbound: true }
  const [listFilters, setListFilters] = useState<ApiRequestLogFilters>(filters)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed the list only when the picked caller changes
  useEffect(() => {
    setListFilters(filters)
  }, [picked?.key])

  return (
    <section className='space-y-4' data-inbound-callers>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h2 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
            Inbound calls
          </h2>
          <p className='text-[11px] text-slate-400'>
            Every caller that is not a browser session — integrations on a static token or an API
            key. Pick one to read its requests; expand a row for the response the caller received.
          </p>
        </div>
        <div className='flex items-center gap-2 text-[11px] text-slate-400'>
          {dataUpdatedAt > 0 && <span>Updated {formatRelative(new Date(dataUpdatedAt))}</span>}
          <Segment
            value={String(hours)}
            options={[
              ['1', '1h'],
              ['24', '24h'],
              ['168', '7d'],
              ['336', '14d']
            ]}
            onChange={(v) => setHours(Number(v))}
          />
        </div>
      </div>

      {isLoading ? (
        <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className='h-28 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
          ))}
        </div>
      ) : callers.length === 0 ? (
        <p className='rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-[12px] text-slate-400 dark:border-border'>
          No token or API-key calls in the last {hours}h. Session traffic (people in the app) is
          listed under API analytics.
        </p>
      ) : (
        <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
          {callers.map((c) => {
            const active = picked?.key === c.key
            const errPct = c.calls > 0 ? Math.round((c.errors / c.calls) * 100) : 0
            return (
              <button
                key={c.key}
                type='button'
                onClick={() => setPicked(active ? null : c)}
                data-caller-card={c.key}
                className={cn(
                  'rounded-lg border bg-white p-3 text-left transition-colors dark:bg-card',
                  active
                    ? 'border-nvr-cyan ring-2 ring-nvr-cyan/30'
                    : c.errors > 0
                      ? 'border-amber-300 hover:border-amber-400 dark:border-amber-500/40'
                      : 'border-slate-200 hover:border-slate-300 dark:border-border'
                )}
              >
                <div className='flex items-center gap-2'>
                  {c.kind === 'api_key' ? (
                    <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200'>
                      <KeyRound className='h-3.5 w-3.5' />
                    </span>
                  ) : (
                    <UserAvatar
                      userId={c.user}
                      className='h-6 w-6 shrink-0 rounded-full'
                      fallback={
                        <span className='inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#00ceff33] text-[9px] font-semibold text-slate-700 dark:text-slate-100'>
                          {initials(c.label)}
                        </span>
                      }
                    />
                  )}
                  <div className='min-w-0'>
                    <p className='truncate text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
                      {c.label}
                    </p>
                    <p className='truncate text-[10.5px] text-slate-400'>
                      {c.kind === 'api_key' ? 'API key' : (c.email ?? 'static token')}
                      {c.user_status && c.user_status !== 'active' && ` · ${c.user_status}`}
                    </p>
                  </div>
                </div>
                <div className='mt-2 grid grid-cols-3 gap-1 text-[11px] tabular-nums'>
                  <div>
                    <p className='text-[9.5px] uppercase tracking-wide text-slate-400'>Calls</p>
                    <p className='font-semibold text-slate-800 dark:text-slate-100'>
                      {c.calls.toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className='text-[9.5px] uppercase tracking-wide text-slate-400'>Errors</p>
                    <p
                      className={cn(
                        'font-semibold',
                        c.errors > 0
                          ? 'text-red-700 dark:text-red-400'
                          : 'text-slate-800 dark:text-slate-100'
                      )}
                    >
                      {c.errors}{' '}
                      {c.errors > 0 && (
                        <span className='font-normal text-slate-400'>({errPct}%)</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className='text-[9.5px] uppercase tracking-wide text-slate-400'>Avg</p>
                    <p className='font-semibold text-slate-800 dark:text-slate-100'>{c.avg_ms}ms</p>
                  </div>
                </div>
                <p
                  className='mt-1.5 text-[10.5px] text-slate-400'
                  data-tip={formatDateTime(c.last_at)}
                >
                  Last call {formatRelative(c.last_at)}
                </p>
                {c.last_error && (
                  <p
                    className='mt-1 truncate text-[10.5px] text-red-700 dark:text-red-300'
                    data-tip={`${c.last_error.method} ${c.last_error.path} → ${c.last_error.status}\n${shortError(c.last_error.error)}`}
                  >
                    Last error {formatRelative(c.last_error.at)} · {c.last_error.status}{' '}
                    {shortError(c.last_error.error) || c.last_error.path}
                  </p>
                )}
                {c.top_paths.length > 0 && (
                  <ul className='mt-1.5 space-y-0.5 border-t border-slate-100 pt-1.5 dark:border-border/60'>
                    {c.top_paths.slice(0, 3).map((p) => (
                      <li
                        key={`${p.method} ${p.path}`}
                        className='flex items-center gap-1 text-[10.5px]'
                      >
                        <span className='w-9 shrink-0 font-mono text-slate-400'>{p.method}</span>
                        <span
                          className='min-w-0 flex-1 truncate font-mono text-slate-600 dark:text-slate-300'
                          data-tip={p.path}
                        >
                          {p.path}
                        </span>
                        <span className='shrink-0 tabular-nums text-slate-400'>
                          {p.calls}
                          {p.errors > 0 && (
                            <span className='text-red-600 dark:text-red-400'> · {p.errors}✕</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </button>
            )
          })}
        </div>
      )}

      <ApiRequestLog
        hours={hours}
        filters={listFilters}
        onFiltersChange={setListFilters}
        title={picked ? `Requests · ${picked.label}` : 'Requests · all integrations'}
        description='Newest first. Expand a row for IP, user agent and the full response body on failures.'
      />
    </section>
  )
}
