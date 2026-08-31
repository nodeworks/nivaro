import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
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

function MiniTable({
  head,
  rows
}: {
  head: string[]
  rows: Array<Array<React.ReactNode>>
}) {
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
                <td key={j} className='py-1.5 pr-4 align-top text-[12px] text-slate-600 dark:text-slate-300'>
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

// ─── Estimated-plan viewer ──────────────────────────────────────────────────
// ShowPlanXML → readable operator tree: cost %, rows, objects, warnings and
// missing-index suggestions, with the raw XML behind a toggle.

interface PlanOp {
  depth: number
  physical: string
  logical: string
  object: string | null
  rows: number
  cost: number
  warnings: string[]
}

function parsePlan(xml: string): {
  statements: Array<{
    text: string
    estRows: number
    subtreeCost: number
    warnings: string[]
    missingIndexes: string[]
    ops: PlanOp[]
  }>
} | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    if (doc.querySelector('parsererror')) return null
    const statements: Array<{
      text: string
      estRows: number
      subtreeCost: number
      warnings: string[]
      missingIndexes: string[]
      ops: PlanOp[]
    }> = []
    for (const st of doc.querySelectorAll('StmtSimple, StmtCond, StmtCursor')) {
      const ops: PlanOp[] = []
      const walk = (el: Element, depth: number) => {
        for (const child of el.children) {
          if (child.tagName === 'RelOp') {
            const obj = child.querySelector(':scope > * > Object')
            const objName = obj
              ? [obj.getAttribute('Table'), obj.getAttribute('Index')]
                  .filter(Boolean)
                  .join(' · ')
                  .replace(/[[\]]/g, '')
              : null
            const warns = [...child.querySelectorAll(':scope > Warnings > *')].map(
              (w) => w.tagName + (w.getAttribute('ConvertIssue') ? `: ${w.getAttribute('ConvertIssue')}` : '')
            )
            ops.push({
              depth,
              physical: child.getAttribute('PhysicalOp') ?? '?',
              logical: child.getAttribute('LogicalOp') ?? '',
              object: objName,
              rows: Number(child.getAttribute('EstimateRows') ?? 0),
              cost: Number(child.getAttribute('EstimatedTotalSubtreeCost') ?? 0),
              warnings: warns
            })
            walk(child, depth + 1)
          } else {
            walk(child, depth)
          }
        }
      }
      const qp = st.querySelector('QueryPlan')
      if (qp) walk(qp, 0)
      const missing = [...st.querySelectorAll('MissingIndex')].map((mi) => {
        const table = (mi.getAttribute('Table') ?? '').replace(/[[\]]/g, '')
        const cols = (group: string) =>
          [...mi.querySelectorAll(`ColumnGroup[Usage="${group}"] Column`)]
            .map((c) => (c.getAttribute('Name') ?? '').replace(/[[\]]/g, ''))
            .join(', ')
        const eq = cols('EQUALITY')
        const ineq = cols('INEQUALITY')
        const incl = cols('INCLUDE')
        return `${table} (${[eq, ineq].filter(Boolean).join(', ')})${incl ? ` INCLUDE (${incl})` : ''}`
      })
      const stWarnings = [...st.querySelectorAll(':scope > QueryPlan > Warnings > *')].map(
        (w) => w.tagName + (w.getAttribute('ConvertIssue') ? ` (${w.getAttribute('ConvertIssue')})` : '')
      )
      statements.push({
        text: st.getAttribute('StatementText') ?? '',
        estRows: Number(st.getAttribute('StatementEstRows') ?? 0),
        subtreeCost: Number(st.getAttribute('StatementSubTreeCost') ?? 0),
        warnings: stWarnings,
        missingIndexes: missing,
        ops
      })
    }
    return statements.length ? { statements } : null
  } catch {
    return null
  }
}

function PlanViewer({ xml }: { xml: string }) {
  const [showRaw, setShowRaw] = useState(false)
  const parsed = parsePlan(xml)
  if (!parsed || showRaw) {
    return (
      <div className='space-y-2'>
        {parsed && (
          <button
            type='button'
            onClick={() => setShowRaw(false)}
            className='text-[11.5px] text-nvr-cyan underline decoration-dotted underline-offset-2'
          >
            ← Back to the readable plan
          </button>
        )}
        <pre className='max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[10.5px] leading-relaxed dark:border-border dark:bg-muted/30'>
          {xml}
        </pre>
      </div>
    )
  }
  return (
    <div className='space-y-4'>
      {parsed.statements.map((st, si) => {
        const total = st.subtreeCost || Math.max(...st.ops.map((o) => o.cost), 0.000001)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional statements
          <div key={si} className='space-y-2'>
            <div className='rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/30'>
              <pre className='max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-slate-600 dark:text-slate-300'>
                {st.text.trim()}
              </pre>
              <p className='mt-1 text-[11px] text-slate-400'>
                Estimated cost {st.subtreeCost.toFixed(4)} · ~{formatNumber(Math.round(st.estRows))}{' '}
                row(s)
              </p>
            </div>
            {st.warnings.length > 0 && (
              <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'>
                ⚠ {st.warnings.join(' · ')}
              </div>
            )}
            {st.missingIndexes.length > 0 && (
              <div className='rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[11.5px] text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300'>
                Missing index suggestion{st.missingIndexes.length > 1 ? 's' : ''}:{' '}
                {st.missingIndexes.join(' · ')}
              </div>
            )}
            <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
              <table className='w-full text-[11.5px]' style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr className='border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400 dark:border-border'>
                    <th className='px-3 py-1.5 font-semibold'>Operator</th>
                    <th className='px-3 py-1.5 font-semibold'>Object</th>
                    <th className='px-3 py-1.5 text-right font-semibold'>Est. rows</th>
                    <th className='px-3 py-1.5 text-right font-semibold'>Cost</th>
                    <th className='w-[120px] px-3 py-1.5 font-semibold'>% of total</th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-slate-100 dark:divide-border'>
                  {st.ops.map((op, oi) => {
                    const pct = Math.min(100, (op.cost / total) * 100)
                    const scan = /scan/i.test(op.physical) && !/index seek/i.test(op.physical)
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: positional tree rows
                      <tr key={oi}>
                        <td className='px-3 py-1.5'>
                          <span style={{ paddingLeft: op.depth * 14 }} className='inline-flex items-center gap-1.5'>
                            {op.depth > 0 && <span className='text-slate-300 dark:text-slate-600'>└</span>}
                            <span className={scan ? 'font-medium text-amber-700 dark:text-amber-400' : 'font-medium'}>
                              {op.physical}
                            </span>
                            {op.logical && op.logical !== op.physical && (
                              <span className='text-slate-400'>({op.logical})</span>
                            )}
                            {op.warnings.length > 0 && (
                              <span className='text-amber-500' title={op.warnings.join(', ')}>
                                ⚠
                              </span>
                            )}
                          </span>
                        </td>
                        <td className='max-w-[260px] truncate px-3 py-1.5 font-mono text-[10.5px] text-slate-500 dark:text-slate-400' title={op.object ?? ''}>
                          {op.object ?? ''}
                        </td>
                        <td className='px-3 py-1.5 text-right'>{formatNumber(Math.round(op.rows))}</td>
                        <td className='px-3 py-1.5 text-right'>{op.cost.toFixed(4)}</td>
                        <td className='px-3 py-1.5'>
                          <div className='flex items-center gap-1.5'>
                            <div className='h-1.5 w-full max-w-[70px] overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
                              <div
                                className={pct > 50 ? 'h-full bg-red-400' : pct > 20 ? 'h-full bg-amber-400' : 'h-full bg-nvr-cyan'}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className='w-9 text-right text-[10.5px] text-slate-400'>{pct.toFixed(0)}%</span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
      <button
        type='button'
        onClick={() => setShowRaw(true)}
        className='text-[11.5px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600 dark:hover:text-slate-200'
      >
        View raw ShowPlan XML
      </button>
    </div>
  )
}

export function DbHealthPage() {
  const qc = useQueryClient()
  const runtime = useOps<Record<string, unknown>>('/ops-runtime/runtime')
  const roster = useOps<Array<Record<string, unknown>>>('/ops-runtime/roster')
  const caches = useOps<Array<{ name: string; description: string }>>('/ops-runtime/caches')
  const degradation = useOps<Array<{ subsystem: string; status: string; impact_when_down: string }>>(
    '/ops-runtime/degradation'
  )
  const expensive = useOps<Array<Record<string, unknown>>>('/ops-db/expensive-sql')
  const unusedIdx = useOps<Array<Record<string, unknown>>>('/ops-db/unused-indexes')
  const longTran = useOps<Array<Record<string, unknown>>>('/ops-db/long-transactions')
  const tableHeat = useOps<Array<Record<string, unknown>>>('/ops-db/table-heat')
  const deadlocks = useOps<Array<Record<string, unknown>>>('/ops-db/deadlocks')
  const redis = useOps<Record<string, unknown>>('/ops-db/redis')
  const poolDetail = useOps<{ used: number; max: number; held: Array<{ held_ms: number; hint: string | null }> }>('/ops-db/pool')
  const velocity = useOps<Array<{ collection: string; action: string; day: string; n: number }>>('/ops-db/velocity')
  const heat = useOps<Array<{ hour: number; path: string; avg_ms: number; n: number }>>('/ops-db/latency-heat')
  const inngest = useOps<{ base: string; recent_events: unknown[] }>('/ops-db/inngest')
  const danglingFks = useOps<{
    checked_relations: number
    dangling_relations: number
    total_dangling_rows: number
    relations: Array<{ many_collection: string; many_field: string; one_collection: string; dangling: number }>
  }>('/ops-db/dangling-fks')
  const storage = useOps<{
    current: Maybe<Record<string, unknown>>
    snapshots: Array<Record<string, unknown>>
    runway: { mb_per_day: number; days_history: number } | null
  }>('/ops-db/storage')

  const bust = useMutation({
    mutationFn: (name: string) => api.post(`/ops-runtime/caches/${name}/bust`),
    onSuccess: (_r, name) => toast.success(name === '__all__' ? 'All caches busted' : `Busted ${name}`),
    onError: () => toast.error('Bust failed')
  })
  const dropIdx = useMutation({
    mutationFn: (v: { table: string; index: string }) => api.post('/ops-db/unused-indexes/drop', v),
    onSuccess: () => {
      toast.success('Index dropped')
      void qc.invalidateQueries({ queryKey: ['ops', '/ops-db/unused-indexes'] })
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Drop failed'
      )
  })
  const [planXml, setPlanXml] = useState<string | null>(null)
  const explain = useMutation({
    mutationFn: (sql: string) =>
      api.post<{ data: { plan: string | null } }>('/ops-db/explain', { sql }).then((r) => r.data.data),
    onSuccess: (d) => {
      if (!d.plan) {
        toast.info('No plan returned for this statement')
        return
      }
      setPlanXml(d.plan)
    },
    onError: (e) =>
      toast.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Explain failed')
  })
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null)
  const [fkFixing, setFkFixing] = useState<string | null>(null)
  const fkRepair = useMutation({
    mutationFn: (v: { many_collection: string; many_field: string; one_collection: string; action: 'null_out' | 'trash_delete' }) =>
      api.post<{ data: { repaired: number } }>('/ops-db/dangling-fks/repair', v).then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success(`Repaired ${d.repaired} row(s)`)
      setFkFixing(null)
      void qc.invalidateQueries({ queryKey: ['ops', '/ops-db/dangling-fks'] })
    },
    onError: (e) =>
      toast.error((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Repair failed')
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
                <div><span className='text-slate-400'>Uptime</span><br /><b>{Math.floor(rt.uptime_seconds / 3600)}h {Math.floor((rt.uptime_seconds % 3600) / 60)}m</b></div>
                <div><span className='text-slate-400'>RSS</span><br /><b>{rt.rss_mb} MB</b></div>
                <div><span className='text-slate-400'>Heap used</span><br /><b>{rt.heap_used_mb} MB</b></div>
                <div><span className='text-slate-400'>Loop lag (1m max)</span><br /><b className={rt.event_loop_lag_ms.max_1m > 300 ? 'text-red-600' : ''}>{rt.event_loop_lag_ms.max_1m} ms</b></div>
                <div><span className='text-slate-400'>Pool</span><br /><b className={rt.pool.pending_acquires > 0 ? 'text-amber-600' : ''}>{rt.pool.used}/{rt.pool.max} used{rt.pool.pending_acquires > 0 ? ` · ${rt.pool.pending_acquires} waiting` : ''}</b></div>
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
                    <code className='font-mono text-[11.5px] text-slate-700 dark:text-slate-200'>{c.name}</code>
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
                    <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>{d.subsystem}</p>
                    <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{d.impact_when_down}</p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className='mt-5 space-y-5'>
          <Panel title='Top expensive SQL' sub='Highest total CPU since the plan cache last cleared — includes legacy Directus load (#106)'>
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
                    <code className='block max-w-[520px] truncate font-mono text-[11px]' title={String(r.statement_text ?? '')}>
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

          <Panel title='Unused indexes' sub='Zero reads, heavy writes — drop candidates. Dropping is audited and limited to plain nonclustered indexes (#105)'>
            {unusedIdx.data?.unavailable ? (
              <Unavailable reason={unusedIdx.data.unavailable} />
            ) : (
              <MiniTable
                head={['Table', 'Index', 'Reads', 'Writes', 'Size', '']}
                rows={(unusedIdx.data?.data ?? []).map((r) => {
                  const key = `${r.table_name}.${r.index_name}`
                  return [
                    String(r.table_name),
                    <code key='i' className='font-mono text-[11px]'>{String(r.index_name)}</code>,
                    num(r.reads),
                    num(r.writes),
                    `${num(r.size_mb)} MB`,
                    confirmDrop === key ? (
                      <span key='c' className='flex items-center gap-1.5'>
                        <button
                          type='button'
                          className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-50'
                          disabled={dropIdx.isPending}
                          onClick={() => dropIdx.mutate({ table: String(r.table_name), index: String(r.index_name) })}
                        >
                          Drop it
                        </button>
                        <button type='button' className='text-[11px] text-slate-400' onClick={() => setConfirmDrop(null)}>
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

          <Panel title='Long transactions' sub='Sleeping sessions holding open transactions ≥ 5 min — the silent lock-holder trap (#289 · #290)'>
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
                    <span key='p' className='block max-w-[200px] truncate'>{String(r.program_name ?? '')}</span>,
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
                          onClick={() => kill.mutate({ session_id: sid, reason: killReason.trim() })}
                        >
                          KILL
                        </button>
                        <button type='button' className='text-[11px] text-slate-400' onClick={() => setKillTarget(null)}>
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
                  rows={(tableHeat.data?.data ?? []).slice(0, 15).map((r) => [
                    String(r.table_name),
                    num(r.reads),
                    num(r.writes),
                    num(r.row_count)
                  ])}
                />
              )}
            </Panel>

            <Panel title='Redis' sub='Memory, keyspace, slowlog (#298)'>
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
            </Panel>
          </div>

          <Panel title='Storage runway' sub='Daily size snapshots project growth; the biggest tables are named (#291 · #155)'>
            {(() => {
              const cur = storage.data?.data?.current
              const run = storage.data?.data?.runway
              const snaps = storage.data?.data?.snapshots ?? []
              const curData = (cur as Maybe<Record<string, unknown>>)?.data as
                | { total_mb?: unknown; used_mb?: unknown; top_tables?: Array<Record<string, unknown>> }
                | undefined
              return (
                <div className='space-y-3'>
                  <div className='flex flex-wrap gap-x-8 gap-y-2 text-[12.5px]'>
                    <div><span className='text-slate-400'>DB used</span><br /><b>{num(curData?.used_mb)} MB</b> of {num(curData?.total_mb)} MB allocated</div>
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
                    rows={(curData?.top_tables ?? []).slice(0, 10).map((t) => [
                      String(t.table_name),
                      num(t.row_count),
                      `${num(t.mb)} MB`
                    ])}
                  />
                </div>
              )
            })()}
          </Panel>

          <div className='grid gap-5 xl:grid-cols-2'>
            <Panel title='Held connections' sub='Pool connections currently checked out, attributed to the request holding them (#304 · this replica)'>
              <MiniTable
                head={['Held for', 'Request']}
                rows={((poolDetail.data?.data?.held ?? []) as Array<{ held_ms: number; hint: string | null }>).map((h) => [
                  `${(h.held_ms / 1000).toFixed(1)}s`,
                  <code key='h' className='font-mono text-[11px]'>{h.hint ?? '(background job / cron)'}</code>
                ])}
              />
            </Panel>

            <Panel title='Inngest' sub='Self-hosted Inngest reachability + recent events (#311)'>
              {inngest.data?.unavailable ? (
                <Unavailable reason={inngest.data.unavailable} />
              ) : (
                <p className='text-[12.5px]'>
                  Reachable at <code className='font-mono text-[11.5px]'>{inngest.data?.data?.base}</code> ·{' '}
                  {(inngest.data?.data?.recent_events ?? []).length} recent event(s)
                </p>
              )}
            </Panel>
          </div>

          <Panel title='Data velocity' sub='Rows created / changed per day per collection, last 14 days (#213)'>
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

          <Panel title='Latency by hour' sub='Hour-of-day × route average latency, 7 days — the "slow every morning at 9" detector (#306)'>
            {heat.data?.unavailable ? (
              <Unavailable reason={heat.data.unavailable} />
            ) : (
              <MiniTable
                head={['Hour (UTC)', 'Route', 'Avg', 'Requests']}
                rows={(heat.data?.data ?? []).slice(0, 20).map((r) => [
                  `${String(r.hour).padStart(2, '0')}:00`,
                  <code key='p' className='block max-w-[380px] truncate font-mono text-[11px]'>{String(r.path)}</code>,
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
                    <code key='c' className='font-mono text-[11px]'>{r.many_field}</code>,
                    r.one_collection,
                    num(r.dangling),
                    fkFixing === key ? (
                      <span key='fix' className='flex items-center gap-1.5'>
                        <button
                          type='button'
                          className='rounded border border-amber-300 px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/40 dark:text-amber-300'
                          disabled={fkRepair.isPending}
                          onClick={() => fkRepair.mutate({ many_collection: r.many_collection, many_field: r.many_field, one_collection: r.one_collection, action: 'null_out' })}
                        >
                          Null out
                        </button>
                        <button
                          type='button'
                          className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-50'
                          disabled={fkRepair.isPending}
                          onClick={() => fkRepair.mutate({ many_collection: r.many_collection, many_field: r.many_field, one_collection: r.one_collection, action: 'trash_delete' })}
                        >
                          Trash rows
                        </button>
                        <button type='button' className='text-[11px] text-slate-400' onClick={() => setFkFixing(null)}>
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

          <Panel title='Deadlocks' sub='Mined from the system_health session; the hourly sweep also raises an issue on fresh ones (#100)'>
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
                      <code key={i} className='block max-w-[560px] truncate font-mono text-[11px]' title={st}>
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
