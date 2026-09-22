import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PlanViewer } from '@/components/plan-viewer'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/utils'

/**
 * /db-health — Ops batch A console: pool + runtime, instance roster, cache
 * console, degradation map, expensive SQL, unused indexes (droppable), long
 * transactions (killable), table heat, deadlocks, Redis, storage runway.
 * Every panel renders the server's honest `unavailable` reason when the DB
 * login lacks VIEW SERVER STATE.
 */

type Maybe<T> = { data?: T; unavailable?: string }

function useOps<T>(path: string) {
  return useQuery<Maybe<T>>({
    queryKey: ['ops', path],
    queryFn: () => api.get<Maybe<T>>(path).then((r) => r.data),
    staleTime: 30_000
  })
}

function Panel({
  title,
  sub,
  children,
  right
}: {
  title: string
  sub?: string
  children: React.ReactNode
  right?: React.ReactNode
}) {
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

function Unavailable({ reason }: { reason: string }) {
  return <p className='text-[12px] text-amber-600 dark:text-amber-400'>{reason}</p>
}

function MiniTable({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  if (rows.length === 0) return <p className='text-[12px] text-slate-400'>Nothing to report.</p>
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-left'>
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                className='pb-1.5 pr-4 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className='tabular-nums'>
          {rows.map((r, i) => (
            <tr key={i} className='border-t border-slate-100 dark:border-border/60'>
              {r.map((c, j) => (
                <td
                  key={j}
                  className='py-1.5 pr-4 align-top text-[12px] text-slate-600 dark:text-slate-300'
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const num = (v: unknown) => formatNumber(Number(v ?? 0))

/** #91 — memory by key prefix: a bounded SCAN + sampled MEMORY USAGE,
 *  extrapolated per prefix. Loaded on demand — it walks the keyspace. */
function RedisMemoryByPrefix() {
  const [armed, setArmed] = useState(false)
  const q = useQuery({
    queryKey: ['ops', '/ops-db/redis/memory'],
    queryFn: () =>
      api
        .get<{
          data?: {
            used_memory_human: string | null
            used_memory_peak_human: string | null
            mem_fragmentation_ratio: string | null
            scanned: number
            truncated: boolean
            prefixes: Array<{
              prefix: string
              keys: number
              sampled: number
              avg_bytes: number
              est_bytes: number
            }>
          }
          unavailable?: string
        }>('/ops-db/redis/memory')
        .then((r) => r.data),
    enabled: armed,
    staleTime: 60_000
  })
  const fmtBytes = (n: number) =>
    n >= 1_048_576
      ? `${(n / 1_048_576).toFixed(1)} MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${n} B`
  return (
    <div className='mt-3 border-t border-slate-100 pt-3 dark:border-border' data-redis-memory>
      {!armed ? (
        <button
          type='button'
          onClick={() => setArmed(true)}
          className='rounded-md border border-slate-200 px-2.5 py-1 text-[11.5px] text-slate-600 hover:border-slate-300 hover:text-slate-800 dark:border-border dark:text-muted-foreground'
        >
          Scan memory by key prefix
        </button>
      ) : q.data?.unavailable ? (
        <Unavailable reason={q.data.unavailable} />
      ) : q.data?.data ? (
        <div className='space-y-1.5 text-[12px]'>
          <p className='text-slate-500 dark:text-muted-foreground'>
            {q.data.data.scanned.toLocaleString()} keys scanned
            {q.data.data.truncated ? ' (capped — estimates cover the sample)' : ''} · peak{' '}
            {q.data.data.used_memory_peak_human ?? '—'} · fragmentation{' '}
            {q.data.data.mem_fragmentation_ratio ?? '—'}
          </p>
          <table className='w-full text-[11.5px] tabular-nums'>
            <thead>
              <tr className='text-left text-[10px] uppercase tracking-wide text-slate-400'>
                <th className='py-0.5 pr-2 font-semibold'>Prefix</th>
                <th className='py-0.5 pr-2 text-right font-semibold'>Keys</th>
                <th className='py-0.5 pr-2 text-right font-semibold'>Avg</th>
                <th className='py-0.5 text-right font-semibold'>Est. total</th>
              </tr>
            </thead>
            <tbody>
              {q.data.data.prefixes.map((p) => (
                <tr
                  key={p.prefix}
                  className='border-t border-slate-100 dark:border-border/60'
                  data-redis-prefix={p.prefix}
                >
                  <td className='py-0.5 pr-2 font-mono'>{p.prefix}</td>
                  <td className='py-0.5 pr-2 text-right'>{p.keys.toLocaleString()}</td>
                  <td className='py-0.5 pr-2 text-right text-slate-500'>
                    {p.sampled ? fmtBytes(p.avg_bytes) : '—'}
                  </td>
                  <td className='py-0.5 text-right font-medium'>
                    {p.sampled ? fmtBytes(p.est_bytes) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Skeleton className='h-10 w-full' />
      )}
    </div>
  )
}

export function DbHealthPage() {
  const qc = useQueryClient()
  const runtime = useOps<Record<string, unknown>>('/ops-runtime/runtime')
  const roster = useOps<Array<Record<string, unknown>>>('/ops-runtime/roster')
  const caches = useOps<Array<{ name: string; description: string }>>('/ops-runtime/caches')
  const degradation = useOps<
    Array<{ subsystem: string; status: string; impact_when_down: string }>
  >('/ops-runtime/degradation')
  const expensive = useOps<Array<Record<string, unknown>>>('/ops-db/expensive-sql')
  const unusedIdx = useOps<Array<Record<string, unknown>>>('/ops-db/unused-indexes')
  const longTran = useOps<Array<Record<string, unknown>>>('/ops-db/long-transactions')
  const backups = useOps<Array<Record<string, unknown>>>('/ops-db/backup-tables')
  const redundant = useOps<Array<Record<string, unknown>>>('/ops-db/redundant-indexes')
  const tableHeat = useOps<Array<Record<string, unknown>>>('/ops-db/table-heat')
  const deadlocks = useOps<Array<Record<string, unknown>>>('/ops-db/deadlocks')
  const redis = useOps<Record<string, unknown>>('/ops-db/redis')
  const poolDetail = useOps<{
    used: number
    max: number
    held: Array<{ held_ms: number; hint: string | null }>
    pressure?: {
      window_s: number
      acquires: number
      wait_p50_ms: number
      wait_p95_ms: number
      wait_max_ms: number
      saturated_pct: number
      peak_used: number
      peak_pending: number
      max: number
    }
  }>('/ops-db/pool')
  const velocity =
    useOps<Array<{ collection: string; action: string; day: string; n: number }>>(
      '/ops-db/velocity'
    )
  const heat =
    useOps<Array<{ hour: number; path: string; avg_ms: number; n: number }>>('/ops-db/latency-heat')
  const inngest = useOps<{ base: string; recent_events: unknown[] }>('/ops-db/inngest')
  const danglingFks = useOps<{
    checked_relations: number
    dangling_relations: number
    total_dangling_rows: number
    relations: Array<{
      many_collection: string
      many_field: string
      one_collection: string
      dangling: number
    }>
  }>('/ops-db/dangling-fks')
  const storage = useOps<{
    current: Maybe<Record<string, unknown>>
    snapshots: Array<Record<string, unknown>>
    runway: { mb_per_day: number; days_history: number } | null
  }>('/ops-db/storage')

  const bust = useMutation({
    mutationFn: (name: string) => api.post(`/ops-runtime/caches/${name}/bust`),
    onSuccess: (_r, name) =>
      toast.success(name === '__all__' ? 'All caches busted' : `Busted ${name}`),
    onError: () => toast.error('Bust failed')
  })
  const dropIdx = useMutation({
    mutationFn: (v: { table: string; index: string }) => api.post('/ops-db/unused-indexes/drop', v),
    onSuccess: () => {
      toast.success('Index dropped')
      void qc.invalidateQueries({ queryKey: ['ops', '/ops-db/unused-indexes'] })
      void qc.invalidateQueries({ queryKey: ['ops', '/ops-db/redundant-indexes'] })
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Drop failed'
      )
  })
  const dropBackup = useMutation({
    mutationFn: (table: string) => api.post('/ops-db/backup-tables/drop', { table }),
    onSuccess: (_r, table) => {
      toast.success(`Dropped ${table}`)
      void qc.invalidateQueries({ queryKey: ['ops', '/ops-db/backup-tables'] })
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Drop failed'
      )
  })
  const [planXml, setPlanXml] = useState<string | null>(null)
  const explain = useMutation({
    mutationFn: (sql: string) =>
      api
        .post<{ data: { plan: string | null } }>('/ops-db/explain', { sql })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      if (!d.plan) {
        toast.info('No plan returned for this statement')
        return
      }
      setPlanXml(d.plan)
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ??
          'Explain failed'
      )
  })
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null)
  const [fkFixing, setFkFixing] = useState<string | null>(null)
  const fkRepair = useMutation({
    mutationFn: (v: {
      many_collection: string
      many_field: string
      one_collection: string
      action: 'null_out' | 'trash_delete'
    }) =>
      api
        .post<{ data: { repaired: number } }>('/ops-db/dangling-fks/repair', v)
        .then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success(`Repaired ${d.repaired} row(s)`)
      setFkFixing(null)
      void qc.invalidateQueries({ queryKey: ['ops', '/ops-db/dangling-fks'] })
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Repair failed'
      )
  })
  const [killTarget, setKillTarget] = useState<number | null>(null)
  const [killReason, setKillReason] = useState('')
  const kill = useMutation({
    mutationFn: (v: { session_id: number; reason: string }) => api.post('/ops-db/kill', v),
    onSuccess: () => {
      toast.success('Session killed')
      setKillTarget(null)
      setKillReason('')
      void qc.invalidateQueries({ queryKey: ['ops', '/ops-db/long-transactions'] })
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Kill failed'
      )
  })

  const rt = runtime.data?.data as
    | {
        uptime_seconds: number
        rss_mb: number
        heap_used_mb: number
        event_loop_lag_ms: { current: number; max_1m: number }
        pool: { used: number; free: number; pending_acquires: number; max: number }
      }
    | undefined

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='flex items-center gap-2 text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              <Database className='h-4.5 w-4.5 text-nvr-cyan' /> DB & Runtime Health
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Live diagnostics from SQL Server DMVs, this process, and Redis. In-process panels are
              per replica.
            </p>
          </div>
          <Button
            size='sm'
            variant='outline'
            onClick={() => void qc.invalidateQueries({ queryKey: ['ops'] })}
          >
            <RefreshCw className='mr-1.5 h-3.5 w-3.5' /> Refresh
          </Button>
        </div>
      </div>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-8 dark:bg-background'>
        <div className='grid gap-5 xl:grid-cols-2'>
          <Panel title='This process' sub='Memory, event-loop lag, connection pool (#234 · #114)'>
            {rt ? (
              <div className='grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-3'>
                <div>
                  <span className='text-slate-400'>Uptime</span>
                  <br />
                  <b>
                    {Math.floor(rt.uptime_seconds / 3600)}h{' '}
                    {Math.floor((rt.uptime_seconds % 3600) / 60)}m
                  </b>
                </div>
                <div>
                  <span className='text-slate-400'>RSS</span>
                  <br />
                  <b>{rt.rss_mb} MB</b>
                </div>
                <div>
                  <span className='text-slate-400'>Heap used</span>
                  <br />
                  <b>{rt.heap_used_mb} MB</b>
                </div>
                <div>
                  <span className='text-slate-400'>Loop lag (1m max)</span>
                  <br />
                  <b className={rt.event_loop_lag_ms.max_1m > 300 ? 'text-red-600' : ''}>
                    {rt.event_loop_lag_ms.max_1m} ms
                  </b>
                </div>
                <div>
                  <span className='text-slate-400'>Pool</span>
                  <br />
                  <b className={rt.pool.pending_acquires > 0 ? 'text-amber-600' : ''}>
                    {rt.pool.used}/{rt.pool.max} used
                    {rt.pool.pending_acquires > 0 ? ` · ${rt.pool.pending_acquires} waiting` : ''}
                  </b>
                </div>
                {(() => {
                  const pr = poolDetail.data?.data?.pressure
                  if (!pr) return null
                  const hot = pr.wait_p95_ms >= 500 || pr.saturated_pct >= 25
                  return (
                    <>
                      <div data-pool-wait={pr.wait_p95_ms}>
                        <span className='text-slate-400'>Acquire wait (5 min)</span>
                        <br />
                        <b className={hot ? 'text-amber-600 dark:text-amber-400' : ''}>
                          p50 {pr.wait_p50_ms}ms · p95 {pr.wait_p95_ms}ms · max {pr.wait_max_ms}ms
                        </b>
                        <span className='block text-[11px] text-slate-400'>
                          over {num(pr.acquires)} checkouts
                        </span>
                      </div>
                      <div data-pool-saturated={pr.saturated_pct}>
                        <span className='text-slate-400'>Every connection busy</span>
                        <br />
                        <b
                          className={
                            pr.saturated_pct >= 25 ? 'text-amber-600 dark:text-amber-400' : ''
                          }
                        >
                          {pr.saturated_pct}% of the window
                        </b>
                        <span className='block text-[11px] text-slate-400'>
                          peak {pr.peak_used}/{pr.max} in use · {pr.peak_pending} waiting
                        </span>
                      </div>
                    </>
                  )
                })()}
              </div>
            ) : (
              <Skeleton className='h-10 w-full' />
            )}
          </Panel>

          <Panel title='Instance roster' sub='Every API process registered in Redis (#297)'>
            <MiniTable
              head={['Host', 'PID', 'Version', 'Started', 'RSS']}
              rows={(roster.data?.data ?? []).map((r) => [
                String(r.host ?? ''),
                String(r.pid ?? ''),
                String(r.version ?? ''),
                new Date(String(r.started_at)).toLocaleString(),
                `${r.memory_rss_mb} MB`
              ])}
            />
          </Panel>

          <Panel
            title='Cache console'
            sub='In-process caches on THIS replica (#236)'
            right={
              <button
                type='button'
                onClick={() => bust.mutate('__all__')}
                className='rounded-md border border-slate-200 px-2 py-1 text-[11.5px] hover:bg-muted dark:border-border'
              >
                Bust all
              </button>
            }
          >
            <div className='space-y-1.5'>
              {(caches.data?.data ?? []).map((c) => (
                <div key={c.name} className='flex items-center gap-2'>
                  <div className='min-w-0 flex-1'>
                    <code className='font-mono text-[11.5px] text-slate-700 dark:text-slate-200'>
                      {c.name}
                    </code>
                    <p className='truncate text-[11px] text-slate-400'>{c.description}</p>
                  </div>
                  <button
                    type='button'
                    onClick={() => bust.mutate(c.name)}
                    className='shrink-0 rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100 dark:hover:bg-accent'
                  >
                    Bust
                  </button>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title='Degradation map' sub='Subsystem down → named feature impact (#252)'>
            <div className='space-y-2'>
              {(degradation.data?.data ?? []).map((d) => (
                <div key={d.subsystem} className='flex items-start gap-2.5'>
                  <span
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                      d.status === 'ok'
                        ? 'bg-emerald-400'
                        : d.status === 'down'
                          ? 'bg-red-500'
                          : d.status === 'unconfigured'
                            ? 'bg-amber-400'
                            : 'bg-slate-300 dark:bg-slate-600'
                    }`}
                    title={d.status}
                  />
                  <div>
                    <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
                      {d.subsystem}
                    </p>
                    <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                      {d.impact_when_down}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className='mt-5 space-y-5'>
          <Panel
            title='Top expensive SQL'
            sub='Highest total CPU since the plan cache last cleared — includes legacy Directus load (#106)'
          >
            {expensive.data?.unavailable ? (
              <Unavailable reason={expensive.data.unavailable} />
            ) : (
              <MiniTable
                head={['Total CPU', 'Execs', 'Avg CPU', 'Avg elapsed', 'Statement']}
                rows={(expensive.data?.data ?? []).map((r) => [
                  `${num(r.total_cpu_ms)} ms`,
                  num(r.execution_count),
                  `${num(r.avg_cpu_ms)} ms`,
                  `${num(r.avg_elapsed_ms)} ms`,
                  <span key='s' className='flex items-center gap-2'>
                    <code
                      className='block max-w-[520px] truncate font-mono text-[11px]'
                      title={String(r.statement_text ?? '')}
                    >
                      {String(r.statement_text ?? '')}
                    </code>
                    {/^\s*(select|with)/i.test(String(r.statement_text ?? '')) && (
                      <button
                        type='button'
                        className='shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-muted dark:border-border'
                        onClick={() => explain.mutate(String(r.statement_text))}
                        title='Estimated execution plan (#307)'
                      >
                        Explain
                      </button>
                    )}
                  </span>
                ])}
              />
            )}
          </Panel>

          <Panel
            title='Unused indexes'
            sub='Zero reads, heavy writes — drop candidates. Dropping is audited and limited to plain nonclustered indexes (#105)'
          >
            {unusedIdx.data?.unavailable ? (
              <Unavailable reason={unusedIdx.data.unavailable} />
            ) : (
              <MiniTable
                head={['Table', 'Index', 'Reads', 'Writes', 'Size', '']}
                rows={(unusedIdx.data?.data ?? []).map((r) => {
                  const key = `${r.table_name}.${r.index_name}`
                  return [
                    String(r.table_name),
                    <code key='i' className='font-mono text-[11px]'>
                      {String(r.index_name)}
                    </code>,
                    num(r.reads),
                    num(r.writes),
                    `${num(r.size_mb)} MB`,
                    confirmDrop === key ? (
                      <span key='c' className='flex items-center gap-1.5'>
                        <button
                          type='button'
                          className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-50'
                          disabled={dropIdx.isPending}
                          onClick={() =>
                            dropIdx.mutate({
                              table: String(r.table_name),
                              index: String(r.index_name)
                            })
                          }
                        >
                          Drop it
                        </button>
                        <button
                          type='button'
                          className='text-[11px] text-slate-400'
                          onClick={() => setConfirmDrop(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        key='d'
                        type='button'
                        className='rounded border border-slate-200 px-2 py-0.5 text-[11px] hover:bg-muted dark:border-border'
                        onClick={() => setConfirmDrop(key)}
                      >
                        Drop…
                      </button>
                    )
                  ]
                })}
              />
            )}
          </Panel>

          <Panel
            title='Redundant indexes'
            sub='An index whose key list is a strict prefix of another index on the same table answers nothing the wider one cannot, and taxes every write. Filtered and unique coverers are excluded (#508)'
          >
            {redundant.data?.unavailable ? (
              <Unavailable reason={redundant.data.unavailable} />
            ) : (
              <MiniTable
                head={['Table', 'Index', 'Keys', 'Covered by', 'Writes', 'Reads', 'Size', '']}
                rows={(redundant.data?.data ?? []).map((r) => {
                  const key = `redundant:${r.table_name}.${r.index_name}`
                  return [
                    String(r.table_name),
                    <code key='i' className='font-mono text-[11px]'>
                      {String(r.index_name)}
                    </code>,
                    <code key='k' className='font-mono text-[11px]'>
                      ({String(r.keys)})
                    </code>,
                    <span key='c' className='text-[11px]'>
                      <code className='font-mono'>{String(r.covered_by)}</code>{' '}
                      <span className='text-slate-400'>({String(r.covered_keys)})</span>
                    </span>,
                    num(r.writes),
                    num(r.reads),
                    `${num(r.size_mb)} MB`,
                    confirmDrop === key ? (
                      <span key='d' className='flex items-center gap-1.5'>
                        <button
                          type='button'
                          className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-50'
                          disabled={dropIdx.isPending}
                          onClick={() =>
                            dropIdx.mutate({
                              table: String(r.table_name),
                              index: String(r.index_name)
                            })
                          }
                        >
                          Drop it
                        </button>
                        <button
                          type='button'
                          className='text-[11px] text-slate-400'
                          onClick={() => setConfirmDrop(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        key='d'
                        type='button'
                        className='rounded border border-slate-200 px-2 py-0.5 text-[11px] hover:bg-muted dark:border-border'
                        onClick={() => setConfirmDrop(key)}
                      >
                        Drop…
                      </button>
                    )
                  ]
                })}
              />
            )}
          </Panel>

          <Panel
            title='Backup tables'
            sub='Scratch copies left behind by one-off fixes (zz_…, …_backup, …_bak). Not registered as collections, referenced by no foreign key. Amber = older than the keep window'
            right={
              backups.data && 'total_mb' in backups.data ? (
                <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {num((backups.data as { total_mb?: number }).total_mb)} MB held
                </span>
              ) : undefined
            }
          >
            {backups.data?.unavailable ? (
              <Unavailable reason={backups.data.unavailable} />
            ) : (
              <MiniTable
                head={['Table', 'Rows', 'Size', 'Age', 'Last read', '']}
                rows={(backups.data?.data ?? []).map((r) => {
                  const key = `backup:${r.name}`
                  return [
                    <code
                      key='n'
                      data-backup-table={String(r.name)}
                      className='font-mono text-[11px]'
                    >
                      {String(r.name)}
                    </code>,
                    num(r.row_count),
                    `${num(r.size_mb)} MB`,
                    <span
                      key='a'
                      className={
                        r.stale ? 'font-medium text-amber-700 dark:text-amber-400' : undefined
                      }
                    >
                      {num(r.age_days)}d
                    </span>,
                    r.last_read
                      ? new Date(String(r.last_read)).toLocaleDateString()
                      : 'Not since restart',
                    confirmDrop === key ? (
                      <span key='c' className='flex items-center gap-1.5'>
                        <button
                          type='button'
                          className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-50'
                          disabled={dropBackup.isPending}
                          onClick={() => dropBackup.mutate(String(r.name))}
                        >
                          Drop it
                        </button>
                        <button
                          type='button'
                          className='text-[11px] text-slate-400'
                          onClick={() => setConfirmDrop(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        key='d'
                        type='button'
                        className='rounded border border-slate-200 px-2 py-0.5 text-[11px] hover:bg-muted dark:border-border'
                        onClick={() => setConfirmDrop(key)}
                      >
                        Drop…
                      </button>
                    )
                  ]
                })}
              />
            )}
          </Panel>

          <Panel
            title='Long transactions'
            sub='Sleeping sessions holding open transactions ≥ 5 min — the silent lock-holder trap (#289 · #290)'
          >
            {longTran.data?.unavailable ? (
              <Unavailable reason={longTran.data.unavailable} />
            ) : (
              <MiniTable
                head={['SPID', 'Login', 'Host', 'Program', 'Idle', 'Open trans', '']}
                rows={(longTran.data?.data ?? []).map((r) => {
                  const sid = Number(r.session_id)
                  return [
                    String(sid),
                    String(r.login_name ?? ''),
                    String(r.host_name ?? ''),
                    <span key='p' className='block max-w-[200px] truncate'>
                      {String(r.program_name ?? '')}
                    </span>,
                    `${r.idle_minutes}m`,
                    String(r.open_transaction_count),
                    killTarget === sid ? (
                      <span key='k' className='flex items-center gap-1.5'>
                        <Input
                          value={killReason}
                          onChange={(e) => setKillReason(e.target.value)}
                          placeholder='Reason (required)'
                          className='h-6 w-44 text-[11px]'
                        />
                        <button
                          type='button'
                          className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-50'
                          disabled={!killReason.trim() || kill.isPending}
                          onClick={() =>
                            kill.mutate({ session_id: sid, reason: killReason.trim() })
                          }
                        >
                          KILL
                        </button>
                        <button
                          type='button'
                          className='text-[11px] text-slate-400'
                          onClick={() => setKillTarget(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        key='k2'
                        type='button'
                        className='rounded border border-red-200 px-2 py-0.5 text-[11px] text-red-600 hover:bg-red-50 dark:border-red-500/30'
                        onClick={() => setKillTarget(sid)}
                      >
                        Kill…
                      </button>
                    )
                  ]
                })}
              />
            )}
          </Panel>

          <div className='grid gap-5 xl:grid-cols-2'>
            <Panel title='Table heat' sub='IO by table since last restart (#295)'>
              {tableHeat.data?.unavailable ? (
                <Unavailable reason={tableHeat.data.unavailable} />
              ) : (
                <MiniTable
                  head={['Table', 'Reads', 'Writes', 'Rows']}
                  rows={(tableHeat.data?.data ?? [])
                    .slice(0, 15)
                    .map((r) => [
                      String(r.table_name),
                      num(r.reads),
                      num(r.writes),
                      num(r.row_count)
                    ])}
                />
              )}
            </Panel>

            <Panel
              title='Redis'
              sub='Memory, keyspace, slowlog (#298) · memory by key prefix on demand (#91)'
            >
              {redis.data?.unavailable ? (
                <Unavailable reason={redis.data.unavailable} />
              ) : redis.data?.data ? (
                <div className='grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-3'>
                  {(
                    [
                      ['Memory', 'used_memory_human'],
                      ['Clients', 'connected_clients'],
                      ['Keys', 'total_keys'],
                      ['Hits', 'keyspace_hits'],
                      ['Misses', 'keyspace_misses'],
                      ['Evicted', 'evicted_keys']
                    ] as const
                  ).map(([label, key]) => (
                    <div key={key}>
                      <span className='text-slate-400'>{label}</span>
                      <br />
                      <b>{String((redis.data?.data as Record<string, unknown>)?.[key] ?? '—')}</b>
                    </div>
                  ))}
                </div>
              ) : (
                <Skeleton className='h-10 w-full' />
              )}
              <RedisMemoryByPrefix />
            </Panel>
          </div>

          <Panel
            title='Storage runway'
            sub='Daily size snapshots project growth; the biggest tables are named (#291 · #155)'
          >
            {(() => {
              const cur = storage.data?.data?.current
              const run = storage.data?.data?.runway
              const snaps = storage.data?.data?.snapshots ?? []
              const curData = (cur as Maybe<Record<string, unknown>>)?.data as
                | {
                    total_mb?: unknown
                    used_mb?: unknown
                    top_tables?: Array<Record<string, unknown>>
                  }
                | undefined
              return (
                <div className='space-y-3'>
                  <div className='flex flex-wrap gap-x-8 gap-y-2 text-[12.5px]'>
                    <div>
                      <span className='text-slate-400'>DB used</span>
                      <br />
                      <b>{num(curData?.used_mb)} MB</b> of {num(curData?.total_mb)} MB allocated
                    </div>
                    <div>
                      <span className='text-slate-400'>Growth</span>
                      <br />
                      <b>
                        {run
                          ? `${run.mb_per_day >= 0 ? '+' : ''}${num(run.mb_per_day)} MB/day over ${run.days_history} days`
                          : `Collecting daily snapshots (${snaps.length} so far — projection needs 7)`}
                      </b>
                    </div>
                  </div>
                  <MiniTable
                    head={['Table', 'Rows', 'Size']}
                    rows={(curData?.top_tables ?? [])
                      .slice(0, 10)
                      .map((t) => [String(t.table_name), num(t.row_count), `${num(t.mb)} MB`])}
                  />
                </div>
              )
            })()}
          </Panel>

          <div className='grid gap-5 xl:grid-cols-2'>
            <Panel
              title='Held connections'
              sub='Pool connections currently checked out, attributed to the request holding them (#304 · this replica)'
            >
              <MiniTable
                head={['Held for', 'Request']}
                rows={(
                  (poolDetail.data?.data?.held ?? []) as Array<{
                    held_ms: number
                    hint: string | null
                  }>
                ).map((h) => [
                  `${(h.held_ms / 1000).toFixed(1)}s`,
                  <code key='h' className='font-mono text-[11px]'>
                    {h.hint ?? '(background job / cron)'}
                  </code>
                ])}
              />
            </Panel>

            <Panel title='Inngest' sub='Self-hosted Inngest reachability + recent events (#311)'>
              {inngest.data?.unavailable ? (
                <Unavailable reason={inngest.data.unavailable} />
              ) : (
                <p className='text-[12.5px]'>
                  Reachable at{' '}
                  <code className='font-mono text-[11.5px]'>{inngest.data?.data?.base}</code> ·{' '}
                  {(inngest.data?.data?.recent_events ?? []).length} recent event(s)
                </p>
              )}
            </Panel>
          </div>

          <Panel
            title='Data velocity'
            sub='Rows created / changed per day per collection, last 14 days (#213)'
          >
            {(() => {
              const rows = velocity.data?.data ?? []
              const byCol = new Map<string, { created: number; updated: number }>()
              for (const r of rows) {
                const b = byCol.get(r.collection) ?? { created: 0, updated: 0 }
                if (r.action === 'create') b.created += Number(r.n)
                else b.updated += Number(r.n)
                byCol.set(r.collection, b)
              }
              const top = [...byCol.entries()]
                .sort((a, z) => z[1].created + z[1].updated - (a[1].created + a[1].updated))
                .slice(0, 15)
              return (
                <MiniTable
                  head={['Collection', 'Created (14d)', 'Updated (14d)', '/day']}
                  rows={top.map(([col, b]) => [
                    col,
                    num(b.created),
                    num(b.updated),
                    num(Math.round((b.created + b.updated) / 14))
                  ])}
                />
              )
            })()}
          </Panel>

          <Panel
            title='Latency by hour'
            sub='Hour-of-day × route average latency, 7 days — the "slow every morning at 9" detector (#306)'
          >
            {heat.data?.unavailable ? (
              <Unavailable reason={heat.data.unavailable} />
            ) : (
              <MiniTable
                head={['Hour (UTC)', 'Route', 'Avg', 'Requests']}
                rows={(heat.data?.data ?? []).slice(0, 20).map((r) => [
                  `${String(r.hour).padStart(2, '0')}:00`,
                  <code key='p' className='block max-w-[380px] truncate font-mono text-[11px]'>
                    {String(r.path)}
                  </code>,
                  `${Math.round(Number(r.avg_ms))} ms`,
                  num(r.n)
                ])}
              />
            )}
          </Panel>

          <Panel
            title='Dangling foreign keys'
            sub='Rows pointing at parents that no longer exist (#457). Null-out clears the pointer; trash-delete removes the rows THROUGH the items service (trash + guards apply). Repointing is a data decision — do that by hand.'
          >
            {danglingFks.data?.unavailable ? (
              <Unavailable reason={danglingFks.data.unavailable} />
            ) : (
              <MiniTable
                head={['Child table', 'Column', 'Missing parent in', 'Rows', '']}
                rows={(danglingFks.data?.data?.relations ?? []).map((r) => {
                  const key = `${r.many_collection}.${r.many_field}`
                  return [
                    r.many_collection,
                    <code key='c' className='font-mono text-[11px]'>
                      {r.many_field}
                    </code>,
                    r.one_collection,
                    num(r.dangling),
                    fkFixing === key ? (
                      <span key='fix' className='flex items-center gap-1.5'>
                        <button
                          type='button'
                          className='rounded border border-amber-300 px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/40 dark:text-amber-300'
                          disabled={fkRepair.isPending}
                          onClick={() =>
                            fkRepair.mutate({
                              many_collection: r.many_collection,
                              many_field: r.many_field,
                              one_collection: r.one_collection,
                              action: 'null_out'
                            })
                          }
                        >
                          Null out
                        </button>
                        <button
                          type='button'
                          className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-50'
                          disabled={fkRepair.isPending}
                          onClick={() =>
                            fkRepair.mutate({
                              many_collection: r.many_collection,
                              many_field: r.many_field,
                              one_collection: r.one_collection,
                              action: 'trash_delete'
                            })
                          }
                        >
                          Trash rows
                        </button>
                        <button
                          type='button'
                          className='text-[11px] text-slate-400'
                          onClick={() => setFkFixing(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        key='r'
                        type='button'
                        className='rounded border border-slate-200 px-2 py-0.5 text-[11px] hover:bg-muted dark:border-border'
                        onClick={() => setFkFixing(key)}
                      >
                        Repair…
                      </button>
                    )
                  ]
                })}
              />
            )}
          </Panel>

          <Panel
            title='Deadlocks'
            sub='Mined from the system_health session; the hourly sweep also raises an issue on fresh ones (#100)'
          >
            {deadlocks.data?.unavailable ? (
              <Unavailable reason={deadlocks.data.unavailable} />
            ) : (
              <MiniTable
                head={['When', 'Victim', 'Statements']}
                rows={(deadlocks.data?.data ?? []).map((r) => [
                  new Date(String(r.occurred_at)).toLocaleString(),
                  String(r.victim ?? '—'),
                  <div key='s' className='space-y-1'>
                    {(r.statements as string[]).map((st, i) => (
                      <code
                        key={i}
                        className='block max-w-[560px] truncate font-mono text-[11px]'
                        title={st}
                      >
                        {st}
                      </code>
                    ))}
                  </div>
                ])}
              />
            )}
          </Panel>
        </div>
      </div>

      <Dialog open={!!planXml} onOpenChange={(o) => !o && setPlanXml(null)}>
        <DialogContent className='max-h-[92vh] overflow-y-auto sm:max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Estimated plan</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className='px-6 pb-6'>{planXml && <PlanViewer xml={planXml} />}</div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  )
}
