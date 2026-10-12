import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellPlus, Play, Search, Sparkles, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatDateTime } from '../../lib/utils'
import type { ApiRequestLogFilters } from './ApiRequestLog'

/**
 * "Ask the logs" (#1914, #1960). A question → the request list's own filter
 * object (POST /ops-logs/ask), shown as chips the admin can take away before
 * anything runs. Run reads the normal admin routes (GET /api-analytics/requests,
 * or GET /ops-logs/tail for the server log); "Save as alert" stores the same
 * filter as a log alert rule with a threshold and a cooldown. The model only
 * ever sees the question. Admin only; needs `<NivaroProvider>`.
 */

export interface LogFilter {
  target: 'requests' | 'log'
  hours?: number
  path?: string
  method?: string
  status?: string
  auth?: string
  inbound?: boolean
  errors?: boolean
  user?: string
  user_label?: string
  api_key?: number
  from?: string
  to?: string
  level?: 'info' | 'warn' | 'error'
  q?: string
  group?: 'caller' | 'path'
}

interface AskAnswer {
  question: string
  filter: LogFilter
  summary: string
  person_query: string | null
  people: Array<{ id: string; name: string; email: string | null }>
}

/** The chips a filter shows — the server's filterChips, twinned. */
export function logFilterChips(f: LogFilter): Array<{ key: keyof LogFilter; label: string }> {
  const out: Array<{ key: keyof LogFilter; label: string }> = []
  if (f.from || f.to)
    out.push({
      key: 'from',
      label: `${f.from ? formatDateTime(f.from) : '…'} → ${f.to ? formatDateTime(f.to) : 'now'}`
    })
  else if (f.hours) out.push({ key: 'hours', label: `last ${f.hours}h` })
  if (f.level) out.push({ key: 'level', label: `${f.level} and above` })
  if (f.q) out.push({ key: 'q', label: `contains "${f.q}"` })
  if (f.user) out.push({ key: 'user', label: f.user_label ?? 'one person' })
  if (f.api_key != null) out.push({ key: 'api_key', label: `API key #${f.api_key}` })
  if (f.method) out.push({ key: 'method', label: f.method })
  if (f.path) out.push({ key: 'path', label: `path ~ ${f.path}` })
  if (f.status) out.push({ key: 'status', label: `status ${f.status}` })
  if (f.errors) out.push({ key: 'errors', label: 'errors only' })
  if (f.inbound) out.push({ key: 'inbound', label: 'integrations only' })
  else if (f.auth) out.push({ key: 'auth', label: `auth ${f.auth.replace(/,/g, ' / ')}` })
  if (f.group) out.push({ key: 'group', label: f.group === 'caller' ? 'top callers' : 'top paths' })
  return out
}

/** Hours the request list must look back for this filter (from beats hours server-side). */
export function lookBackHours(f: LogFilter, now = Date.now()): number {
  if (f.from) return Math.min(720, Math.max(1, Math.ceil((now - Date.parse(f.from)) / 3_600_000)))
  return f.hours ?? 24
}

/** The filter as the shared request list's controlled filters. */
export function toRequestLogFilters(f: LogFilter): ApiRequestLogFilters {
  return {
    path: f.path,
    method: f.method,
    status: f.status,
    auth: f.inbound ? undefined : f.auth,
    user: f.user,
    api_key: f.api_key ?? null,
    inbound: f.inbound,
    errors: f.errors,
    from: f.from,
    to: f.to
  }
}

function requestParams(f: LogFilter): Record<string, unknown> {
  const p: Record<string, unknown> = { hours: lookBackHours(f), limit: 50 }
  for (const k of ['path', 'method', 'status', 'user', 'from', 'to', 'group'] as const)
    if (f[k]) p[k] = f[k]
  if (f.api_key != null) p.api_key = f.api_key
  if (f.inbound) p.inbound = 1
  else if (f.auth) p.auth = f.auth
  if (f.errors) p.errors = 1
  return p
}

export function AskTheLogs({
  onOpenRequests,
  className
}: {
  /** Open the filter in the host's full request list (controlled filters + look-back hours). */
  onOpenRequests?: (filters: ApiRequestLogFilters, hours: number) => void
  className?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<AskAnswer | null>(null)
  const [filter, setFilter] = useState<LogFilter | null>(null)
  const [ran, setRan] = useState<LogFilter | null>(null)
  const [saving, setSaving] = useState(false)
  const [rule, setRule] = useState({ name: '', threshold: 10, window: 15, cooldown: 60 })
  const [error, setError] = useState<string | null>(null)

  const ask = useMutation({
    mutationFn: () =>
      client.request<{ data: AskAnswer }>(post('/ops-logs/ask', { question })).then((r) => r.data),
    onSuccess: (a) => {
      setAnswer(a)
      setFilter(a.filter)
      setRan(null)
      setSaving(false)
      setError(null)
      setRule((r) => ({ ...r, name: (a.summary || a.question).slice(0, 120) }))
    },
    onError: (e) =>
      setError(
        (e as { response?: { error?: string } })?.response?.error ??
          (e as Error)?.message ??
          'Could not read the question'
      )
  })

  const save = useMutation({
    mutationFn: () =>
      client.request(
        post('/ops-logs/rules', {
          name: rule.name,
          filters: filter,
          threshold: rule.threshold,
          window_minutes: rule.window,
          cooldown_minutes: rule.cooldown,
          origin: 'ask'
        })
      ),
    onSuccess: () => {
      setSaving(false)
      void qc.invalidateQueries({ queryKey: ['ops-log-rules'] })
    },
    onError: (e) =>
      setError(
        (e as { response?: { error?: string } })?.response?.error ?? 'The alert was not saved'
      )
  })

  const chips = useMemo(() => (filter ? logFilterChips(filter) : []), [filter])
  const drop = (key: keyof LogFilter) => {
    if (!filter) return
    const next = { ...filter }
    if (key === 'from') {
      delete next.from
      delete next.to
    } else if (key === 'user') {
      delete next.user
      delete next.user_label
    } else delete next[key]
    setFilter(next)
    setRan(null)
  }

  return (
    <section
      className={cn(
        'rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
      data-ask-the-logs
    >
      <form
        className='flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-border/60'
        onSubmit={(e) => {
          e.preventDefault()
          if (question.trim()) ask.mutate()
        }}
      >
        <Sparkles className='h-4 w-4 shrink-0 text-nvr-cyan' />
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder='Ask the logs… e.g. "errors for Beth yesterday afternoon", "who called /items/orders most today"'
          className='h-8 min-w-0 flex-1 bg-transparent text-[12.5px] text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-foreground'
          maxLength={400}
          data-ask-logs-input
        />
        <button
          type='submit'
          disabled={!question.trim() || ask.isPending}
          className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white disabled:opacity-50'
        >
          <Search className='h-3.5 w-3.5' /> {ask.isPending ? 'Reading…' : 'Ask'}
        </button>
      </form>

      {error && (
        <p className='px-3 py-2 text-[12px] text-red-600 dark:text-red-400' data-ask-logs-error>
          {error}
        </p>
      )}

      {answer && filter && (
        <div className='space-y-2 px-3 py-2.5'>
          {answer.summary && (
            <p className='text-[12px] text-slate-600 dark:text-slate-300'>{answer.summary}</p>
          )}
          <div className='flex flex-wrap items-center gap-1.5' data-ask-logs-chips>
            <span className='rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'>
              {filter.target === 'log' ? 'Server log (this server)' : 'API requests'}
            </span>
            {chips.map((c) => (
              <button
                key={c.key}
                type='button'
                onClick={() => drop(c.key)}
                className='inline-flex h-7 items-center gap-1 rounded-full bg-nvr-cyan/10 px-2.5 text-[11px] font-medium text-slate-700 hover:bg-nvr-cyan/20 dark:text-slate-200'
                data-ask-logs-chip={c.key}
              >
                {c.label} <X className='h-3 w-3' />
              </button>
            ))}
          </div>
          {answer.people.length > 0 && !filter.user && (
            <div className='flex flex-wrap items-center gap-1.5 text-[11.5px]' data-ask-logs-people>
              <span className='text-slate-500'>
                Which {answer.person_query ? `"${answer.person_query}"` : 'person'}?
              </span>
              {answer.people.map((p) => (
                <button
                  key={p.id}
                  type='button'
                  onClick={() => setFilter({ ...filter, user: p.id, user_label: p.name })}
                  className='rounded-full border border-slate-200 px-2 py-0.5 hover:bg-muted dark:border-border'
                >
                  {p.name}
                  {p.email ? <span className='text-slate-400'> · {p.email}</span> : null}
                </button>
              ))}
            </div>
          )}
          {answer.person_query && answer.people.length === 0 && !filter.user && (
            <p className='text-[11.5px] text-amber-700 dark:text-amber-300'>
              No account matches "{answer.person_query}" — the filter runs without a person.
            </p>
          )}
          <div className='flex flex-wrap items-center gap-2 pt-1'>
            <button
              type='button'
              onClick={() => setRan(filter)}
              className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white'
              data-ask-logs-run
            >
              <Play className='h-3.5 w-3.5' /> Run
            </button>
            {onOpenRequests && filter.target === 'requests' && !filter.group && (
              <button
                type='button'
                onClick={() => onOpenRequests(toRequestLogFilters(filter), lookBackHours(filter))}
                className='inline-flex h-7 items-center rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
              >
                Open in the request list
              </button>
            )}
            <button
              type='button'
              onClick={() => setSaving((v) => !v)}
              className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
              data-ask-logs-save
            >
              <BellPlus className='h-3.5 w-3.5' /> Save as alert
            </button>
            {save.isSuccess && !saving && (
              <span className='text-[11.5px] text-emerald-700 dark:text-emerald-300'>
                Alert saved — it shows under Log alert rules.
              </span>
            )}
          </div>
          {saving && (
            <form
              className='flex flex-wrap items-end gap-2 rounded-md border border-slate-200 p-2 text-[11.5px] dark:border-border'
              onSubmit={(e) => {
                e.preventDefault()
                if (rule.name.trim()) save.mutate()
              }}
              data-ask-logs-rule
            >
              <label className='flex min-w-[200px] flex-1 flex-col gap-0.5'>
                <span className='text-slate-500'>Name</span>
                <input
                  value={rule.name}
                  onChange={(e) => setRule({ ...rule, name: e.target.value })}
                  className='h-7 rounded border border-slate-200 bg-white px-2 dark:border-border dark:bg-background'
                />
              </label>
              {(
                [
                  ['threshold', 'Matches', 1, 100000],
                  ['window', 'In minutes', 1, 1440],
                  ['cooldown', 'Then quiet for (min)', 1, 10080]
                ] as const
              ).map(([k, label, min, max]) => (
                <label key={k} className='flex w-[110px] flex-col gap-0.5'>
                  <span className='text-slate-500'>{label}</span>
                  <input
                    type='number'
                    min={min}
                    max={max}
                    value={rule[k]}
                    onChange={(e) => setRule({ ...rule, [k]: Number(e.target.value) || min })}
                    className='h-7 rounded border border-slate-200 bg-white px-2 tabular-nums dark:border-border dark:bg-background'
                  />
                </label>
              ))}
              <button
                type='submit'
                disabled={save.isPending}
                className='h-7 rounded-md bg-nvr-cyan px-2.5 font-semibold text-white disabled:opacity-50'
              >
                Save alert
              </button>
            </form>
          )}
          {ran && <AskResults filter={ran} />}
        </div>
      )}
    </section>
  )
}

interface RunResult {
  lines: Array<{ ts: number; level: number; msg: string }>
  rows: Array<{
    id: number
    method: string
    path: string
    status: number
    latency_ms: number
    user_name: string | null
    api_key_name: string | null
    created_at: string
  }>
  groups: Array<{ key: string; label: string; calls: number; errors: number }>
  total: number
}

function AskResults({ filter }: { filter: LogFilter }) {
  const client = useNivaroClient()
  const isLog = filter.target === 'log'
  const { data, isLoading, isError } = useQuery<RunResult>({
    queryKey: ['ask-the-logs-run', filter],
    queryFn: () =>
      isLog
        ? client
            .request<{ data: Array<{ ts: number; level: number; msg: string }> }>(
              get('/ops-logs/tail', {
                level: filter.level,
                q: filter.q,
                since: filter.from ?? (filter.hours ? `now-${filter.hours}h` : undefined),
                until: filter.to,
                limit: 200
              })
            )
            .then((r) => ({ lines: r.data, rows: [], groups: [], total: r.data.length }))
        : client
            .request<{ data: RunResult['rows']; groups?: RunResult['groups']; total: number }>(
              get('/api-analytics/requests', requestParams(filter))
            )
            .then((r) => ({ lines: [], rows: r.data, groups: r.groups ?? [], total: r.total })),
    staleTime: 15_000
  })
  if (isLoading) return <div className='h-16 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
  if (isError || !data)
    return <p className='text-[12px] text-red-600 dark:text-red-400'>That search failed.</p>
  if (isLog)
    return (
      <div
        className='max-h-[320px] overflow-y-auto rounded bg-[#0f172a] p-2.5 font-mono text-[11px] leading-relaxed text-slate-200'
        data-ask-logs-lines
      >
        {data.lines.length === 0 && <p className='text-slate-400'>No matching lines.</p>}
        {data.lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no id; the list is replaced whole
          <div key={i} className='flex gap-2'>
            <span className='shrink-0 text-slate-500'>{new Date(l.ts).toLocaleTimeString()}</span>
            <span className='break-all'>{l.msg}</span>
          </div>
        ))}
      </div>
    )
  if (filter.group)
    return (
      <table className='w-full text-[12px] tabular-nums' data-ask-logs-groups>
        <thead>
          <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
            <th className='py-1 font-semibold'>
              {filter.group === 'caller' ? 'Caller' : 'Request'}
            </th>
            <th className='py-1 text-right font-semibold'>Calls</th>
            <th className='py-1 text-right font-semibold'>Errors</th>
          </tr>
        </thead>
        <tbody>
          {data.groups.length === 0 && (
            <tr>
              <td colSpan={3} className='py-3 text-center text-slate-400'>
                Nothing matched.
              </td>
            </tr>
          )}
          {data.groups.map((g) => (
            <tr key={g.key} className='border-t border-slate-100 dark:border-border/60'>
              <td className='max-w-0 truncate py-1 pr-2 font-mono text-[11.5px]'>{g.label}</td>
              <td className='py-1 text-right'>{g.calls.toLocaleString()}</td>
              <td
                className={cn('py-1 text-right', g.errors > 0 && 'text-red-600 dark:text-red-400')}
              >
                {g.errors.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  return (
    <div data-ask-logs-rows>
      <p className='mb-1 text-[11px] text-slate-400'>
        {data.total.toLocaleString()} request{data.total === 1 ? '' : 's'}
        {data.total > data.rows.length ? ` · newest ${data.rows.length}` : ''}
      </p>
      <table className='w-full text-[12px] tabular-nums'>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.id} className='border-t border-slate-100 dark:border-border/60'>
              <td className='whitespace-nowrap py-1 pr-2 text-slate-500'>
                {formatDateTime(r.created_at)}
              </td>
              <td className='max-w-[160px] truncate py-1 pr-2'>
                {r.api_key_name ?? r.user_name ?? '—'}
              </td>
              <td className='max-w-0 truncate py-1 pr-2 font-mono text-[11.5px]'>
                <span className='mr-1 text-slate-400'>{r.method}</span>
                {r.path}
              </td>
              <td
                className={cn(
                  'py-1 text-right font-medium',
                  r.status >= 400 && 'text-red-600 dark:text-red-400'
                )}
              >
                {r.status}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
