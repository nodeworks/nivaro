import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Play, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

interface ApiHealth {
  id: number
  name: string
  base_url: string | null
  auth_type: string | null
  totals: Record<string, number>
  last_success_at: string | null
  last_activity_at: string | null
  window_24h: Record<string, number>
  last_failure: { error: string | null; at: string; collection: string; item: string } | null
}

interface CronEntry {
  id: string
  expression: string
  extensionId?: string
  nextRun: string | null
}

interface Health {
  apis: ApiHealth[]
  crons: CronEntry[]
  dead_letters_24h: number
  flow_runs_24h: Record<string, number>
}

/**
 * An API's health verdict, honestly graded: green needs a success AFTER the
 * last failure; red means the latest word from the integration was a failure;
 * idle means it has never spoken.
 */
function verdict(a: ApiHealth): { label: string; cls: string } {
  const lastFail = a.last_failure?.at ?? null
  const lastOk = a.last_success_at
  if (!lastOk && !lastFail) return { label: 'idle', cls: 'text-slate-400' }
  if (lastOk && (!lastFail || lastOk > lastFail)) {
    return { label: 'healthy', cls: 'text-emerald-600 dark:text-emerald-400' }
  }
  return { label: 'failing', cls: 'text-red-600 dark:text-red-400' }
}

export function IntegrationHealthPage() {
  const qc = useQueryClient()
  const { data, isLoading, dataUpdatedAt } = useQuery<Health>({
    queryKey: ['integration-health'],
    queryFn: () => api.get<{ data: Health }>('/integration-health').then((r) => r.data.data),
    refetchInterval: 30_000
  })

  const runCron = useMutation({
    mutationFn: (id: string) => api.post(`/cron/${id}/run`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integration-health'] })
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-border'>
        <div className='flex items-center gap-2.5'>
          <Link2 className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-lg font-semibold'>Integrations</h1>
            <p className='text-[11px] text-muted-foreground'>
              Push outcomes, last failures, and scheduled jobs — one screen per external system.
            </p>
          </div>
        </div>
        {dataUpdatedAt > 0 && (
          <span className='text-[11px] text-muted-foreground'>
            Updated {new Date(dataUpdatedAt).toLocaleTimeString()} · refreshes every 30s
          </span>
        )}
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {isLoading || !data ? (
          <div className='grid grid-cols-2 gap-4 lg:grid-cols-3'>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className='h-40 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]'
              />
            ))}
          </div>
        ) : (
          <>
            <div className='mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3'>
              {data.apis.map((a) => {
                const v = verdict(a)
                const fail24 = a.window_24h.failed ?? 0
                const ok24 = (a.window_24h.accepted ?? 0) + (a.window_24h.pending ?? 0)
                return (
                  <div
                    key={a.id}
                    className={cn(
                      'rounded-lg border bg-white p-4 dark:bg-card',
                      v.label === 'failing'
                        ? 'border-red-300 dark:border-red-500/40'
                        : 'border-slate-200 dark:border-border'
                    )}
                  >
                    <div className='mb-2 flex items-center justify-between'>
                      <span className='text-[13px] font-medium'>{a.name}</span>
                      <span className={cn('text-[12px] font-semibold', v.cls)}>{v.label}</span>
                    </div>
                    <div className='space-y-1 text-[11.5px] text-muted-foreground'>
                      <p>
                        Last success:{' '}
                        <span className='text-foreground'>
                          {a.last_success_at ? formatRelative(a.last_success_at) : 'never'}
                        </span>
                      </p>
                      <p>
                        24h: <span className='text-foreground tabular-nums'>{ok24}</span> landed ·{' '}
                        <span
                          className={cn(
                            'tabular-nums',
                            fail24 > 0
                              ? 'font-medium text-red-600 dark:text-red-400'
                              : 'text-foreground'
                          )}
                        >
                          {fail24}
                        </span>{' '}
                        failed
                      </p>
                      <p>
                        All time:{' '}
                        {Object.entries(a.totals)
                          .map(([k, n]) => `${n} ${k}`)
                          .join(' · ') || '—'}
                      </p>
                    </div>
                    {a.last_failure && (
                      <div className='mt-2 rounded border border-red-200 bg-red-50/60 p-2 dark:border-red-500/30 dark:bg-red-500/5'>
                        <p className='line-clamp-2 text-[11px] text-red-700 dark:text-red-400'>
                          {a.last_failure.error ?? 'Unknown error'}
                        </p>
                        <p className='mt-1 text-[10.5px] text-muted-foreground'>
                          {formatRelative(a.last_failure.at)} ·{' '}
                          <Link
                            to={`/collections/${a.last_failure.collection}/${a.last_failure.item}`}
                            className='text-[#00a5cc] underline decoration-dotted'
                          >
                            {a.last_failure.collection}/{a.last_failure.item}
                          </Link>{' '}
                          ·{' '}
                          <Link
                            to='/erp-submissions'
                            className='text-[#00a5cc] underline decoration-dotted'
                          >
                            all submissions
                          </Link>
                        </p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className='mb-6 flex flex-wrap gap-3 text-[12px]'>
              <span className='rounded-full border border-slate-200 bg-white px-3 py-1 dark:border-border dark:bg-card'>
                Flow runs 24h:{' '}
                {Object.entries(data.flow_runs_24h)
                  .map(([k, n]) => `${n} ${k}`)
                  .join(' · ') || 'none'}
              </span>
              <Link
                to='/dead-letters'
                className='rounded-full border border-slate-200 bg-white px-3 py-1 hover:bg-muted dark:border-border dark:bg-card'
              >
                Dead letters 24h:{' '}
                <span
                  className={cn(
                    'tabular-nums',
                    data.dead_letters_24h > 0 && 'font-medium text-red-600 dark:text-red-400'
                  )}
                >
                  {data.dead_letters_24h}
                </span>
              </Link>
            </div>

            <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <div className='border-b border-slate-200 px-4 py-3 dark:border-border'>
                <h2 className='text-[13px] font-medium'>Scheduled jobs</h2>
                <p className='text-[11px] text-muted-foreground'>
                  Every registered cron — integration polls, sweeps, digests. Run-now re-fires one
                  without waiting for its tick.
                </p>
              </div>
              <table className='w-full text-[12px]'>
                <thead>
                  <tr className='border-b border-slate-200 text-left text-[10.5px] uppercase tracking-wide text-muted-foreground dark:border-border'>
                    <th className='px-4 py-2'>Job</th>
                    <th className='px-4 py-2'>Schedule</th>
                    <th className='px-4 py-2'>Next run</th>
                    <th className='px-4 py-2' />
                  </tr>
                </thead>
                <tbody>
                  {data.crons.map((c) => (
                    <tr
                      key={c.id}
                      className='border-b border-slate-100 last:border-0 dark:border-border/60'
                    >
                      <td className='px-4 py-1.5 font-mono text-[11.5px]'>
                        {c.id}
                        {c.extensionId && (
                          <span className='ml-1.5 rounded bg-nvr-cyan/10 px-1 py-0.5 text-[10px] text-slate-600 dark:text-slate-300'>
                            {c.extensionId}
                          </span>
                        )}
                      </td>
                      <td className='px-4 py-1.5 font-mono text-[11.5px] text-muted-foreground'>
                        {c.expression}
                      </td>
                      <td className='px-4 py-1.5 text-muted-foreground'>
                        {c.nextRun ? formatRelative(c.nextRun) : '—'}
                      </td>
                      <td className='px-4 py-1.5 text-right'>
                        <button
                          type='button'
                          disabled={runCron.isPending}
                          onClick={() => runCron.mutate(c.id)}
                          title='Run now'
                          className='inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50 dark:border-border'
                        >
                          {runCron.isPending && runCron.variables === c.id ? (
                            <RotateCw className='h-3 w-3 animate-spin' />
                          ) : (
                            <Play className='h-3 w-3' />
                          )}
                          Run
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <ContractsCard />
      </div>
    </div>
  )
}

/**
 * Inbound payload contracts — the declared shape each integration's writes
 * must match. Flag mode surfaces drift as issues; reject mode 422s the
 * sender. Enforcement lives in the items service.
 */
function ContractsCard() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [collection, setCollection] = useState('')
  const [mode, setMode] = useState<'flag' | 'reject'>('flag')
  const [configText, setConfigText] = useState(
    '{\n  "required": ["name"],\n  "types": {"name": "string"},\n  "forbid_unknown": false\n}'
  )

  const { data: contracts = [] } = useQuery<
    Array<{
      id: number
      name: string
      collection: string
      user_email: string | null
      mode: string
      is_active: boolean
      config: Record<string, unknown> | null
    }>
  >({
    queryKey: ['integration-contracts'],
    queryFn: () => api.get('/integration-contracts').then((r) => r.data.data)
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['integration-contracts'] })

  const create = useMutation({
    mutationFn: () => {
      let config: unknown
      try {
        config = JSON.parse(configText)
      } catch {
        throw new Error('Config is not valid JSON')
      }
      return api.post('/integration-contracts', { name, collection, mode, config })
    },
    onSuccess: () => {
      setShowForm(false)
      setName('')
      setCollection('')
      invalidate()
    },
    onError: (e: Error & { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? e.message)
  })
  const patchC = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/integration-contracts/${id}`, body),
    onSuccess: invalidate
  })
  const removeC = useMutation({
    mutationFn: (id: number) => api.delete(`/integration-contracts/${id}`),
    onSuccess: invalidate
  })

  return (
    <div className='mt-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex items-center justify-between'>
        <div>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Payload contracts
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-400'>
            The shape inbound integration writes must match. Drift is flagged as an issue — or
            rejected with a 422 the sender sees — before it corrupts rows.
          </p>
        </div>
        <button
          type='button'
          onClick={() => setShowForm((v) => !v)}
          className='h-7 rounded-md border border-slate-200 px-2.5 text-[12px] text-slate-600 hover:border-slate-300 dark:border-border dark:text-muted-foreground'
        >
          {showForm ? 'Close' : '＋ New contract'}
        </button>
      </div>
      {showForm && (
        <div className='mt-3 grid max-w-[720px] grid-cols-1 gap-2 sm:grid-cols-2'>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Contract name (e.g. MWF workflow feed)'
            className='h-8 rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
          />
          <input
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder='Collection (e.g. mwf_queue)'
            className='h-8 rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
          />
          <textarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={5}
            className='col-span-full rounded-md border border-slate-200 bg-background px-2.5 py-2 font-mono text-[11.5px] dark:border-border'
          />
          <div className='col-span-full flex items-center gap-3'>
            <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
              {(['flag', 'reject'] as const).map((m) => (
                <button
                  key={m}
                  type='button'
                  onClick={() => setMode(m)}
                  className={
                    mode === m
                      ? 'rounded bg-nvr-cyan/10 px-2 py-0.5 text-[11px] font-medium text-slate-800 dark:text-foreground'
                      : 'rounded px-2 py-0.5 text-[11px] font-medium text-slate-400'
                  }
                >
                  {m === 'flag' ? 'Flag drift' : 'Reject writes'}
                </button>
              ))}
            </span>
            <button
              type='button'
              disabled={!name.trim() || !collection.trim() || create.isPending}
              onClick={() => create.mutate()}
              className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white disabled:opacity-50'
            >
              Create
            </button>
          </div>
        </div>
      )}
      <div className='mt-3 space-y-1.5'>
        {contracts.length === 0 && !showForm && (
          <p className='text-[12px] text-slate-400'>
            No contracts yet — declare the expected fields/types for an integration-fed collection.
          </p>
        )}
        {contracts.map((c) => (
          <div
            key={c.id}
            className='flex items-center gap-3 rounded-md border border-slate-100 px-3 py-2 dark:border-border'
          >
            <div className='min-w-0 flex-1'>
              <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                {c.name}
                <span className='ml-2 font-mono text-[11px] text-slate-400'>{c.collection}</span>
                {c.user_email && (
                  <span className='ml-2 text-[11px] text-slate-400'>writer: {c.user_email}</span>
                )}
              </p>
              <p className='text-[11px] text-slate-400'>
                {(c.config?.required as string[] | undefined)?.length ?? 0} required ·{' '}
                {Object.keys((c.config?.types as Record<string, string>) ?? {}).length} typed
                {c.config?.forbid_unknown ? ' · unknown fields forbidden' : ''}
              </p>
            </div>
            <button
              type='button'
              onClick={() =>
                patchC.mutate({ id: c.id, body: { mode: c.mode === 'flag' ? 'reject' : 'flag' } })
              }
              className={
                c.mode === 'reject'
                  ? 'rounded-full border border-red-300 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:border-red-500/40 dark:text-red-400'
                  : 'rounded-full border border-amber-300 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/40 dark:text-amber-400'
              }
              title='Click to switch mode'
            >
              {c.mode === 'reject' ? 'Rejecting' : 'Flagging'}
            </button>
            <button
              type='button'
              onClick={() => patchC.mutate({ id: c.id, body: { is_active: !c.is_active } })}
              className={
                c.is_active
                  ? 'rounded-full border border-emerald-300 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400'
                  : 'rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-400 dark:border-border'
              }
            >
              {c.is_active ? 'Active' : 'Paused'}
            </button>
            <button
              type='button'
              onClick={() => {
                if (window.confirm(`Delete contract "${c.name}"?`)) removeC.mutate(c.id)
              }}
              className='text-[13px] text-slate-300 hover:text-red-500'
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
