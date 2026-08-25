import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'

/**
 * /ops-console — Ops batch B: log tail (#156), log alert rules (#253), env
 * viewer (#157), swallowed-error counters (#296), incident timeline (#288),
 * clock skew (#294), heap snapshot (#301), rolling restart (#235/#314).
 * Per-replica panels say so.
 */

const LEVEL_NAME: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }

function Card({ title, sub, children, right }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <div>
          <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>{title}</h2>
          {sub && <p className='mt-0.5 text-[11px] text-slate-400'>{sub}</p>}
        </div>
        {right}
      </header>
      <div className='p-4'>{children}</div>
    </section>
  )
}

export function OpsConsolePage() {
  const qc = useQueryClient()
  const [logLevel, setLogLevel] = useState('')
  const [logQ, setLogQ] = useState('')
  const { data: tail } = useQuery({
    queryKey: ['ops-log-tail', logLevel, logQ],
    queryFn: () =>
      api
        .get<{ data: Array<{ ts: number; level: number; msg: string }> }>('/ops-logs/tail', {
          params: { level: logLevel || undefined, q: logQ || undefined, limit: 300 }
        })
        .then((r) => r.data.data),
    refetchInterval: 10_000
  })
  const { data: swallows } = useQuery({
    queryKey: ['ops-swallows'],
    queryFn: () =>
      api
        .get<{ data: Array<{ site: string; total: number; last_at: number; last_message: string | null }> }>('/ops-logs/swallows')
        .then((r) => r.data.data),
    staleTime: 30_000
  })
  const { data: env } = useQuery({
    queryKey: ['ops-env'],
    queryFn: () =>
      api
        .get<{ data: Array<{ key: string; value: string | null; set: boolean }> }>('/ops-logs/env')
        .then((r) => r.data.data),
    staleTime: 5 * 60_000
  })
  const { data: rules } = useQuery({
    queryKey: ['ops-log-rules'],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: number; name: string; pattern: string; is_active: boolean; last_matched_at: string | null }> }>('/ops-logs/rules')
        .then((r) => r.data.data)
  })
  const { data: clock } = useQuery({
    queryKey: ['ops-clock'],
    queryFn: () =>
      api
        .get<{ data: { db_skew_ms: number | null; dst_band_crons: Array<{ id: string; expression: string }> } }>('/ops-runtime/clock')
        .then((r) => r.data.data),
    staleTime: 60_000
  })
  const [incidentAt, setIncidentAt] = useState('')
  const { data: incidents, refetch: refetchIncidents } = useQuery({
    queryKey: ['ops-incidents', incidentAt],
    queryFn: () =>
      api
        .get<{ data: { events: Array<{ at: string; kind: string; label: string }> } }>('/ops-logs/incident-timeline', {
          params: incidentAt ? { around: new Date(incidentAt).toISOString() } : {}
        })
        .then((r) => r.data.data),
    enabled: false
  })

  const [ruleName, setRuleName] = useState('')
  const [rulePattern, setRulePattern] = useState('')
  const addRule = useMutation({
    mutationFn: () => api.post('/ops-logs/rules', { name: ruleName, pattern: rulePattern }),
    onSuccess: () => {
      setRuleName('')
      setRulePattern('')
      void qc.invalidateQueries({ queryKey: ['ops-log-rules'] })
      toast.success('Rule added')
    },
    onError: (e) =>
      toast.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Failed')
  })
  const heap = useMutation({
    mutationFn: () => api.post<{ data: { name: string } }>('/ops-runtime/heap-snapshot').then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success('Heap snapshot written — downloading')
      window.open(`/api/ops-runtime/heap-snapshot/${d.name}`, '_blank')
    },
    onError: () => toast.error('Snapshot failed')
  })
  const [restartReason, setRestartReason] = useState('')
  const restart = useMutation({
    mutationFn: (force: boolean) => api.post('/ops-runtime/restart', { reason: restartReason, force }),
    onSuccess: () => toast.success('Restarting — the API will be back in seconds'),
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Restart refused'
      )
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-card'>
        <h1 className='flex items-center gap-2 text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          <TerminalSquare className='h-4.5 w-4.5 text-nvr-cyan' /> Ops Console
        </h1>
        <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Log tail, alert rules, env knobs, silent-failure counters, incident timeline — plus the
          restart and heap-snapshot levers.
        </p>
      </div>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-8 dark:bg-background'>
        <div className='space-y-5'>
          <Card
            title='Log tail'
            sub='This replica, pino lines only (console.* goes to stdout). Auto-refreshes.'
            right={
              <div className='flex items-center gap-2'>
                {['', 'info', 'warn', 'error'].map((l) => (
                  <button
                    key={l || 'all'}
                    type='button'
                    onClick={() => setLogLevel(l)}
                    className={`rounded-md px-2 py-1 text-[11.5px] ${logLevel === l ? 'bg-slate-900 text-white dark:bg-nvr-cyan dark:text-[#172940]' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-accent'}`}
                  >
                    {l || 'all'}
                  </button>
                ))}
                <Input value={logQ} onChange={(e) => setLogQ(e.target.value)} placeholder='Search…' className='h-7 w-44 text-[12px]' />
              </div>
            }
          >
            <div className='max-h-[360px] overflow-y-auto rounded bg-[#0f172a] p-3 font-mono text-[11px] leading-relaxed text-slate-200'>
              {(tail ?? []).length === 0 && <p className='text-slate-400'>No matching lines in the ring.</p>}
              {(tail ?? []).map((l, i) => (
                <div key={i} className='flex gap-2'>
                  <span className='shrink-0 text-slate-500'>{new Date(l.ts).toLocaleTimeString()}</span>
                  <span className={`shrink-0 ${l.level >= 50 ? 'text-red-400' : l.level >= 40 ? 'text-amber-400' : 'text-sky-400'}`}>
                    {LEVEL_NAME[l.level] ?? l.level}
                  </span>
                  <span className='break-all'>{l.msg}</span>
                </div>
              ))}
            </div>
          </Card>

          <div className='grid gap-5 xl:grid-cols-2'>
            <Card title='Log alert rules' sub='Regex over incoming lines → deduped issue (#253)'>
              <div className='space-y-1.5'>
                {(rules ?? []).map((r) => (
                  <div key={r.id} className='flex items-center gap-2 text-[12px]'>
                    <span className='min-w-0 flex-1'>
                      <b>{r.name}</b>{' '}
                      <code className='font-mono text-[11px] text-slate-500'>/{r.pattern}/i</code>
                      {r.last_matched_at && (
                        <span className='ml-1.5 text-[11px] text-amber-600'>
                          last match {new Date(r.last_matched_at).toLocaleString()}
                        </span>
                      )}
                    </span>
                    <button
                      type='button'
                      className='shrink-0 text-[11px] text-slate-400 hover:text-red-500'
                      onClick={() =>
                        api.delete(`/ops-logs/rules/${r.id}`).then(() => void qc.invalidateQueries({ queryKey: ['ops-log-rules'] }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <form
                  className='flex items-center gap-2 pt-1'
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (ruleName.trim() && rulePattern.trim()) addRule.mutate()
                  }}
                >
                  <Input value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder='Name' className='h-7 w-32 text-[12px]' />
                  <Input value={rulePattern} onChange={(e) => setRulePattern(e.target.value)} placeholder='regex, e.g. ECONNRESET' className='h-7 flex-1 font-mono text-[12px]' />
                  <Button type='submit' size='sm' className='h-7 text-[11.5px]' disabled={addRule.isPending}>
                    Add
                  </Button>
                </form>
              </div>
            </Card>

            <Card title='Silent failures' sub='Deliberate .catch sites reporting how often they fire (#296). 50/hour raises an issue.'>
              {(swallows ?? []).length === 0 ? (
                <p className='text-[12px] text-slate-400'>No swallowed errors since this process started.</p>
              ) : (
                <div className='space-y-1.5'>
                  {(swallows ?? []).map((s) => (
                    <div key={s.site} className='text-[12px]'>
                      <code className='font-mono text-[11.5px]'>{s.site}</code>{' '}
                      <b className='tabular-nums'>{s.total}</b>
                      <span className='text-slate-400'> · last {new Date(s.last_at).toLocaleTimeString()}</span>
                      {s.last_message && <p className='truncate text-[11px] text-slate-400'>{s.last_message}</p>}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card
            title='Incident timeline'
            sub='Issues, failed jobs, and config edits around a moment (#288)'
            right={
              <div className='flex items-center gap-2'>
                <Input type='datetime-local' value={incidentAt} onChange={(e) => setIncidentAt(e.target.value)} className='h-7 text-[12px]' />
                <Button size='sm' className='h-7 text-[11.5px]' onClick={() => void refetchIncidents()}>
                  Build
                </Button>
              </div>
            }
          >
            {(incidents?.events ?? []).length === 0 ? (
              <p className='text-[12px] text-slate-400'>
                Pick a moment (default: now) and Build — the window is ±60 minutes.
              </p>
            ) : (
              <div className='space-y-1'>
                {(incidents?.events ?? []).map((e, i) => (
                  <div key={i} className='flex items-start gap-2.5 text-[12px]'>
                    <span className='w-40 shrink-0 tabular-nums text-slate-400'>{new Date(e.at).toLocaleString()}</span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${
                        e.kind.startsWith('issue') ? 'bg-red-500/10 text-red-600 dark:text-red-400' : e.kind.startsWith('job') ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
                      }`}
                    >
                      {e.kind}
                    </span>
                    <span className='min-w-0 flex-1'>{e.label}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className='grid gap-5 xl:grid-cols-2'>
            <Card title='Clock & DST' sub='DB clock vs app clock, and crons in the 01:00–03:59 band DST can eat or repeat (#294)'>
              <p className='text-[12.5px]'>
                DB skew:{' '}
                <b className={Math.abs(clock?.db_skew_ms ?? 0) > 5000 ? 'text-red-600' : ''}>
                  {clock?.db_skew_ms == null ? '—' : `${clock.db_skew_ms} ms`}
                </b>
              </p>
              <div className='mt-2 flex flex-wrap gap-1.5'>
                {(clock?.dst_band_crons ?? []).map((c) => (
                  <code key={c.id} className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600 dark:bg-muted dark:text-slate-300' title={c.expression}>
                    {c.id}
                  </code>
                ))}
              </div>
            </Card>

            <Card title='Restart & evidence' sub='Restart gates on mid-run imports/jobs (#235 · #314); the heap snapshot preserves memory evidence first (#301)'>
              <div className='space-y-2.5'>
                <Button size='sm' variant='outline' className='h-7 text-[11.5px]' disabled={heap.isPending} onClick={() => heap.mutate()}>
                  {heap.isPending ? 'Writing…' : 'Heap snapshot'}
                </Button>
                <div className='flex items-center gap-2'>
                  <Input value={restartReason} onChange={(e) => setRestartReason(e.target.value)} placeholder='Restart reason (required, audited)' className='h-7 flex-1 text-[12px]' />
                  <Button
                    size='sm'
                    variant='destructive'
                    className='h-7 text-[11.5px]'
                    disabled={!restartReason.trim() || restart.isPending}
                    onClick={() => restart.mutate(false)}
                  >
                    Restart API
                  </Button>
                </div>
                <p className='text-[11px] text-slate-400'>
                  Refused while imports or jobs are mid-run — a 409 names them; re-issue with force
                  only if you accept cutting them.
                </p>
              </div>
            </Card>
          </div>

          <Card
            title='Environment knobs'
            sub='Which env vars this process sees — secrets masked (#157)'
            right={
              <Button size='sm' variant='outline' className='h-7 text-[11.5px]' onClick={() => void qc.invalidateQueries({ queryKey: ['ops-env'] })}>
                <RefreshCw className='mr-1 h-3 w-3' /> Refresh
              </Button>
            }
          >
            <div className='grid gap-x-8 gap-y-1 sm:grid-cols-2 xl:grid-cols-3'>
              {(env ?? []).map((r) => (
                <div key={r.key} className='flex items-baseline gap-2 text-[11.5px]'>
                  <code className={`font-mono ${r.set ? 'text-slate-700 dark:text-slate-200' : 'text-slate-300 dark:text-slate-600'}`}>{r.key}</code>
                  <span className='min-w-0 flex-1 truncate text-slate-400' title={r.value ?? ''}>
                    {r.set ? r.value : 'unset'}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
