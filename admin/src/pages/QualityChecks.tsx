import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Download, ExternalLink, RotateCw } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import {
  isStaleVerifying,
  pickTarget,
  type QualityRun,
  type QualityStatus,
  RUN_ID_SHAPE,
  runTotals,
  STATUS_TEXT,
  StatusDot,
  TotalsLine,
  useQualityConfig
} from '@/components/quality-checks-card'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'

/**
 * /quality-checks — after every rebuild of a target, production figures
 * (captured right after the clone) are compared with the converted database.
 * This page reads those results: per-area check list, the rows that differ,
 * clusters of differences, and the known differences an admin marked as
 * expected (which read amber instead of red).
 */

type Value = string | number | boolean | null

interface ResultSummary {
  check_id: string
  area: string
  label: string
  description: string | null
  status: QualityStatus
  compared: number
  matched: number
  amber_count: number
  red_count: number
  baseline_only: number
  current_only: number
  duration_ms: number | null
  error: string | null
}
interface DiffRow {
  key: string
  label?: string
  status: 'mismatch' | 'baseline_only' | 'current_only'
  fields: string[]
  base: Record<string, Value> | null
  cur: Record<string, Value> | null
  cluster?: Record<string, string>
  reason: string | null
  expected: boolean
  known_id: number | null
  /** Link to the record in legacy production, when the check provides one. */
  legacy?: string
}
interface Cluster {
  cluster: Record<string, string>
  red: number
  amber: number
}
interface KnownMatch {
  key?: string
  key_exact?: string
  cluster?: Record<string, string>
  field?: string
}
interface Known {
  id: number
  check_id: string
  match: KnownMatch
  reason: string
  created_by: string | null
  created_at: string | null
  last_matched_run: string | null
  matched_count: number
  idle_runs: number
  stale: boolean
}
type ApiError = { response?: { data?: { error?: string } } }

const AREA_LABELS: Record<string, string> = {
  owners: 'Owners',
  states: 'States',
  forecasts: 'Forecasts',
  lines: 'Lines, allocations & rollups',
  po: 'Purchase orders & invoices',
  people: 'People',
  history: 'History, notes & files',
  counts: 'Counts & money',
  budget: 'Budget'
}
const RUN_STATUS_LABEL: Record<QualityRun['status'], string> = {
  capturing: 'capturing production',
  captured: 'captured, waiting for verify',
  verifying: 'verifying',
  done: 'done',
  error: 'failed'
}

const errText = (e: unknown, fallback: string) => (e as ApiError).response?.data?.error ?? fallback
/** A run's status as the page names it; a run stuck verifying says so. */
const runStatusLabel = (r: QualityRun) =>
  isStaleVerifying(r) ? 'stopped while verifying' : (RUN_STATUS_LABEL[r.status] ?? r.status)
const isLive = (r: QualityRun) =>
  r.status !== 'done' && r.status !== 'error' && !isStaleVerifying(r)
const fmt = (n: number) => n.toLocaleString('en-US')

/** Pure: milliseconds as `850ms`, `12s`, `3m 04s`, `6h 31m`. */
export function fmtMs(ms?: number | null): string {
  if (ms == null) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Pure: a known difference's condition as one line. */
export function matchSummary(m: KnownMatch): string {
  const parts: string[] = []
  if (m.key) parts.push(`key ${m.key}`)
  if (m.key_exact) parts.push(`key = ${m.key_exact}`)
  if (m.cluster)
    parts.push(
      Object.entries(m.cluster)
        .map(([k, v]) => `${k} = ${v}`)
        .join(' · ')
    )
  if (m.field) parts.push(`field ${m.field}`)
  return parts.join(' · ') || '—'
}

const clusterText = (c: Record<string, string>) => Object.values(c).join(' · ')
const sameCluster = (a: Record<string, string> | undefined, b: Record<string, string>) =>
  !!a && Object.entries(b).every(([k, v]) => a[k] === v)
const rowTone = (r: DiffRow): 'red' | 'amber' => (r.expected || r.known_id ? 'amber' : 'red')
const showValue = (v: Value | undefined) =>
  v === null || v === undefined || v === '' ? '—' : String(v)
const safeHttp = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : null)

/** Inline 120×24 sparkline of red counts, oldest → newest. */
function RedSparkline({ runs }: { runs: QualityRun[] }) {
  const values = [...runs]
    .reverse()
    .filter((r) => r.status === 'done')
    .map((r) => Number(r.totals?.red ?? 0))
  if (values.length < 2) return null
  const w = 120
  const h = 24
  const max = Math.max(1, ...values)
  const step = w / (values.length - 1)
  const pts = values.map(
    (v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`
  )
  const last = pts[pts.length - 1].split(',')
  return (
    <span
      className='inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'
      data-tip={`Red checks over the last ${values.length} runs: ${values.join(', ')}`}
    >
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role='img'
        aria-label='Red checks trend'
        className='overflow-visible'
      >
        <title>Red checks trend</title>
        <polyline
          points={pts.join(' ')}
          fill='none'
          strokeWidth={1.5}
          className='stroke-rose-500 dark:stroke-rose-400'
        />
        <circle cx={last[0]} cy={last[1]} r={2} className='fill-rose-500 dark:fill-rose-400' />
      </svg>
      red trend
    </span>
  )
}

export default function QualityChecksPage() {
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const tab = params.get('tab') === 'known' ? 'known' : 'checks'

  const cfgQ = useQualityConfig()
  const cfg = cfgQ.data
  const targets = cfg?.targets ?? []
  const target = pickTarget(targets, params.get('target'))

  const runsQ = useQuery({
    queryKey: ['quality-runs', target],
    enabled: !!target,
    queryFn: () =>
      api
        .get<{ data: QualityRun[] }>('/quality-checks/runs', { params: { target } })
        .then((r) => r.data.data),
    refetchInterval: (x) => (x.state.data?.some(isLive) ? 10_000 : 60_000)
  })
  const runs = runsQ.data ?? []
  // Only a uuid from the address bar reaches a request path.
  const askedRun = params.get('run')
  const runId = (askedRun && RUN_ID_SHAPE.test(askedRun) ? askedRun : null) ?? runs[0]?.id ?? null
  const runPath = runId ? encodeURIComponent(runId) : ''

  const runQ = useQuery({
    queryKey: ['quality-run', runId],
    enabled: !!runId,
    queryFn: () =>
      api
        .get<{ data: { run: QualityRun; results: ResultSummary[] } }>(
          `/quality-checks/runs/${runPath}`
        )
        .then((r) => r.data.data)
  })
  const run = runQ.data?.run ?? runs.find((r) => r.id === runId) ?? null
  const results = runQ.data?.results ?? []
  const totals = runTotals(run, results)

  const runbooksQ = useQuery({
    queryKey: ['quality-rebuild-active'],
    queryFn: () =>
      api
        .get<{ runbooks?: Array<{ active: { target?: string | null } | null }> }>('/runbooks')
        .then((r) => r.data)
        .catch(() => ({ runbooks: [] })),
    staleTime: 15_000
  })
  // Only a queued or running job against THIS target holds off a re-run.
  const rebuildActive = !!runbooksQ.data?.runbooks?.some(
    (r) => r.active && (r.active.target ?? '').toLowerCase() === (target ?? '').toLowerCase()
  )

  const rerun = useMutation({
    mutationFn: () => api.post('/quality-checks/rerun', { target }),
    onSuccess: () => {
      toast.success('Re-run queued — the host agent picks it up within a minute')
      for (const key of ['runbooks', 'quality-rebuild-active', 'quality-runs'])
        void qc.invalidateQueries({ queryKey: [key] })
    },
    onError: (e) => toast.error(errText(e, 'Could not queue the re-run'))
  })

  // The open check belongs to the run it was opened from; switching runs closes it.
  const [opened, setOpened] = useState<{ run: string; check: string } | null>(null)
  const openCheck = opened && opened.run === runId ? opened.check : null
  const setOpenCheck = (check: string | null) =>
    setOpened(check && runId ? { run: runId, check } : null)

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }

  const duration =
    run?.verified_at && run.started_at
      ? Date.parse(run.verified_at) - Date.parse(run.started_at)
      : null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-start justify-between gap-4'>
          <div className='min-w-0'>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Quality checks
            </h1>
            <p className='mt-0.5 max-w-[72ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Production figures captured right after each clone{target ? ` of ${target}` : ''},
              compared with the converted database. Red means a difference nobody has explained yet;
              amber means it is expected.
            </p>
          </div>
          <Button
            size='sm'
            variant='outline'
            data-checks-rerun
            disabled={
              rerun.isPending || rebuildActive || runs.length === 0 || !cfg?.rerun || !target
            }
            title={
              !cfg?.rerun
                ? 'No extension declares a runbook that re-runs these checks'
                : rebuildActive
                  ? 'A rebuild is running — re-run after it finishes'
                  : undefined
            }
            onClick={() => rerun.mutate()}
          >
            <RotateCw className={cn('h-3.5 w-3.5', rerun.isPending && 'animate-spin')} /> Re-run
            checks
          </Button>
        </div>
        {runs.length > 0 && (
          <div className='mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]'>
            {targets.length > 1 && (
              <SimpleSelect
                value={target ?? ''}
                onChange={(v) => {
                  const next = new URLSearchParams(params)
                  next.set('target', v)
                  next.delete('run')
                  setParams(next, { replace: true })
                }}
                ariaLabel='Target'
                className='h-8 w-[200px] text-[12px]'
                triggerProps={{ 'data-quality-target': target ?? '' }}
                options={targets.map((t) => ({ value: t, label: t }))}
              />
            )}
            <SimpleSelect
              value={runId ?? ''}
              onChange={(v) => setParam('run', v)}
              ariaLabel='Run'
              className='h-8 w-[300px] text-[12px]'
              triggerProps={{ 'data-quality-run': runId ?? '' }}
              options={runs.map((r) => ({
                value: r.id,
                label: `${formatDateTime(r.started_at)} · ${runStatusLabel(r)}`
              }))}
            />
            <TotalsLine totals={totals} />
            {duration != null && duration > 0 && (
              <span className='text-slate-500 dark:text-muted-foreground'>
                took {fmtMs(duration)}
              </span>
            )}
            {run?.runbook_run && (
              <span className='text-slate-500 dark:text-muted-foreground'>
                from rebuild{' '}
                <code className='font-mono text-[11px]'>{run.runbook_run.slice(0, 8)}</code>
              </span>
            )}
            <RedSparkline runs={runs} />
          </div>
        )}
        {run && isStaleVerifying(run) && (
          <p
            data-quality-stale-run
            className='mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-400/10 dark:text-amber-200'
          >
            This run started verifying over two hours ago and never finished — its runner was
            stopped. Re-run the checks to finish it.
          </p>
        )}
        {run?.status === 'error' && run.error && (
          <p className='mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-400/10 dark:text-rose-200'>
            {run.error}
          </p>
        )}
        <div className='-mb-4 mt-3 flex gap-1' role='tablist'>
          {(['checks', 'known'] as const).map((t) => (
            <button
              key={t}
              type='button'
              role='tab'
              aria-selected={tab === t}
              data-quality-tab={t}
              onClick={() => setParam('tab', t === 'checks' ? null : t)}
              className={cn(
                'relative px-3 py-2 text-[12.5px] font-medium transition-colors',
                tab === t
                  ? 'text-slate-900 dark:text-foreground'
                  : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {t === 'checks' ? 'Checks' : 'Known differences'}
              {tab === t && (
                <span className='absolute inset-x-0 bottom-0 h-0.5 bg-nvr-cyan' aria-hidden />
              )}
            </button>
          ))}
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 px-6 py-5 dark:bg-background'>
        {cfgQ.isLoading || (!!target && runsQ.isLoading) ? (
          <p className='text-[12px] text-slate-400'>Loading…</p>
        ) : cfg && !cfg.available ? (
          <p
            data-quality-not-set-up
            className='text-[12.5px] text-slate-500 dark:text-muted-foreground'
          >
            Not set up on this database (migration 404).
          </p>
        ) : cfgQ.isError || runsQ.isError ? (
          <p className='text-[12.5px] text-rose-600 dark:text-rose-400'>
            {errText(cfgQ.error ?? runsQ.error, 'Could not load quality runs')}
          </p>
        ) : tab === 'known' ? (
          <KnownTab results={results} runs={runs} />
        ) : runs.length === 0 ? (
          <EmptyState target={target} />
        ) : (
          <ChecksTab
            key={runId ?? 'none'}
            results={results}
            loading={runQ.isLoading}
            run={run}
            onOpen={setOpenCheck}
          />
        )}
      </div>

      {runId && openCheck && (
        <CheckSheet
          runId={runId}
          checkId={openCheck}
          summary={results.find((r) => r.check_id === openCheck) ?? null}
          onClose={() => setOpenCheck(null)}
        />
      )}
    </div>
  )
}

function EmptyState({ target }: { target: string | null }) {
  return (
    <div className='rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-border dark:bg-card'>
      <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
        No quality run yet
      </p>
      <p className='mx-auto mt-1 max-w-[52ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Checks run inside a real rebuild{target ? ` of ${target}` : ''}: start it from the Runbooks
        card on Environments. A dry run does not clone, so it has nothing to compare.
      </p>
    </div>
  )
}

function ChecksTab({
  results,
  loading,
  run,
  onOpen
}: {
  results: ResultSummary[]
  loading: boolean
  run: QualityRun | null
  onOpen: (id: string) => void
}) {
  const areas = useMemo(() => {
    const map = new Map<string, ResultSummary[]>()
    for (const r of results) map.set(r.area, [...(map.get(r.area) ?? []), r])
    return [...map.entries()]
  }, [results])
  // Sections with red start open, the rest folded; the parent keys this per run.
  const [open, setOpen] = useState<Record<string, boolean>>({})

  if (loading) return <p className='text-[12px] text-slate-400'>Loading…</p>
  if (results.length === 0)
    return (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        {run && isStaleVerifying(run)
          ? 'This run stopped while verifying and has no check results.'
          : run && isLive(run)
            ? `This run is ${RUN_STATUS_LABEL[run.status]} — results appear once the converted database is checked.`
            : 'This run has no check results.'}
      </p>
    )

  return (
    <div className='space-y-3'>
      {areas.map(([area, rows]) => {
        const reds = rows.filter((r) => r.status === 'red').length
        const isOpen = open[area] ?? reds > 0
        const worst: QualityStatus = rows.some((r) => r.status === 'red')
          ? 'red'
          : rows.some((r) => r.status === 'error')
            ? 'error'
            : rows.some((r) => r.status === 'amber')
              ? 'amber'
              : 'green'
        return (
          <section
            key={area}
            data-quality-area={area}
            className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
          >
            <button
              type='button'
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => ({ ...o, [area]: !isOpen }))}
              className='flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-muted/40'
            >
              {isOpen ? (
                <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
              ) : (
                <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
              )}
              <StatusDot status={worst} />
              <span className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
                {AREA_LABELS[area] ?? area}
              </span>
              <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                {rows.length} {rows.length === 1 ? 'check' : 'checks'}
                {reds > 0 && (
                  <>
                    {' · '}
                    <span className={STATUS_TEXT.red}>{reds} red</span>
                  </>
                )}
              </span>
            </button>
            {isOpen && (
              <ul className='divide-y divide-slate-100 border-t border-slate-100 dark:divide-border dark:border-border'>
                {rows.map((r) => (
                  <CheckRow key={r.check_id} r={r} onOpen={() => onOpen(r.check_id)} />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

function CheckRow({ r, onOpen }: { r: ResultSummary; onOpen: () => void }) {
  return (
    <li>
      <button
        type='button'
        onClick={onOpen}
        data-quality-check={r.check_id}
        data-quality-status={r.status}
        className='grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-muted/40'
      >
        <StatusDot status={r.status} className='mt-1.5' />
        <span className='min-w-0'>
          <span className='block text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
            {r.label}
          </span>
          {r.status === 'error' ? (
            <span className='mt-0.5 block whitespace-pre-wrap break-words font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
              {r.error ?? 'The check failed without a message'}
            </span>
          ) : (
            <span className='mt-0.5 block text-[12px] text-slate-500 dark:text-muted-foreground'>
              {fmt(r.matched)} of {fmt(r.compared)} match
            </span>
          )}
        </span>
        <span className='flex items-center gap-3 whitespace-nowrap text-[12px] tabular-nums'>
          {r.red_count > 0 && <span className={STATUS_TEXT.red}>{fmt(r.red_count)} red</span>}
          {r.amber_count > 0 && (
            <span className={STATUS_TEXT.amber}>{fmt(r.amber_count)} amber</span>
          )}
          {r.status === 'error' && <span className={STATUS_TEXT.error}>error</span>}
          <span className='w-14 text-right text-slate-400 dark:text-muted-foreground'>
            {fmtMs(r.duration_ms)}
          </span>
        </span>
      </button>
    </li>
  )
}

/** Inline "why is this expected" form; saves a known difference and re-diffs the run. */
function MarkExpectedForm({
  runId,
  checkId,
  match,
  subject,
  onDone
}: {
  runId: string
  checkId: string
  match: KnownMatch
  subject: string
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { id: number; rediffed: boolean } }>('/quality-checks/known', {
          check_id: checkId,
          match,
          reason: reason.trim(),
          run: runId
        })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      if (d.rediffed) toast.success('Marked as expected — this run now reads it amber')
      else
        toast.info(
          'Saved. This run could not be re-checked right now — the entry applies from the next run.'
        )
      for (const key of ['quality-run', 'quality-check', 'quality-known', 'quality-runs'])
        void qc.invalidateQueries({ queryKey: [key] })
      onDone()
    },
    onError: (e) => toast.error(errText(e, 'Could not save the known difference'))
  })
  const ok = reason.trim().length >= 3
  return (
    <div
      data-quality-mark-form
      className='rounded-md border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-500/30 dark:bg-amber-400/10'
    >
      <p className='text-[12px] text-amber-900 dark:text-amber-200'>
        Mark <span className='font-medium'>{subject}</span> as expected. Say why, so the next person
        reading this knows.
      </p>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens on an explicit click
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder='e.g. Teams do not exist on staging, so these owners resolve to nobody'
        className='mt-2 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[12.5px] text-slate-900 placeholder:text-slate-400 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-foreground'
        data-quality-mark-reason
      />
      <div className='mt-2 flex justify-end gap-2'>
        <Button size='sm' variant='ghost' onClick={onDone}>
          Cancel
        </Button>
        <Button
          size='sm'
          disabled={!ok || save.isPending}
          onClick={() => save.mutate()}
          data-quality-mark-save
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function CheckSheet({
  runId,
  checkId,
  summary,
  onClose
}: {
  runId: string
  checkId: string
  summary: ResultSummary | null
  onClose: () => void
}) {
  const q = useQuery({
    queryKey: ['quality-check', runId, checkId],
    queryFn: () =>
      api
        .get<{
          data: {
            result: ResultSummary & { rows: DiffRow[]; clusters: Cluster[] }
            known: Known[]
          }
        }>(
          `/quality-checks/runs/${encodeURIComponent(runId)}/checks/${encodeURIComponent(checkId)}`
        )
        .then((r) => r.data.data)
  })
  const result = q.data?.result
  const rows = result?.rows ?? []
  const clusters = result?.clusters ?? []
  const [tone, setTone] = useState<'all' | 'red' | 'amber'>('all')
  const [cluster, setCluster] = useState<Record<string, string> | null>(null)
  const [marking, setMarking] = useState<string | null>(null) // `row:<key>` | `cluster:<i>`

  const counts = useMemo(() => {
    let red = 0
    let amber = 0
    for (const r of rows) rowTone(r) === 'red' ? red++ : amber++
    return { red, amber }
  }, [rows])
  const shown = rows.filter(
    (r) => (tone === 'all' || rowTone(r) === tone) && (!cluster || sameCluster(r.cluster, cluster))
  )
  const head = result ?? summary
  const status = head?.status ?? 'green'
  const truncated =
    head && head.red_count + head.amber_count > rows.length && rows.length > 0
      ? head.red_count + head.amber_count
      : null

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className='flex w-[960px] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]'
        data-quality-sheet={checkId}
      >
        <div className='shrink-0 border-b border-slate-200 px-6 py-4 pr-12 dark:border-border'>
          <SheetTitle className='flex items-center gap-2 text-[15px] text-slate-900 dark:text-foreground'>
            <StatusDot status={status} />
            {head?.label ?? checkId}
          </SheetTitle>
          <SheetDescription className='mt-1 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
            {head?.description || 'No description.'}
          </SheetDescription>
          {head && head.status !== 'error' && (
            <p className='mt-2 flex flex-wrap items-center gap-x-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
              <span>
                {fmt(head.matched)} of {fmt(head.compared)} match
              </span>
              {head.red_count > 0 && (
                <span className={STATUS_TEXT.red}>{fmt(head.red_count)} red</span>
              )}
              {head.amber_count > 0 && (
                <span className={STATUS_TEXT.amber}>{fmt(head.amber_count)} amber</span>
              )}
              {head.baseline_only > 0 && <span>{fmt(head.baseline_only)} only in production</span>}
              {head.current_only > 0 && <span>{fmt(head.current_only)} only in staging</span>}
              <a
                href={`/api/quality-checks/runs/${encodeURIComponent(runId)}/checks/${encodeURIComponent(checkId)}/csv`}
                data-quality-csv
                className='ml-auto inline-flex items-center gap-1 text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
              >
                <Download className='h-3.5 w-3.5' /> Download every mismatch (CSV)
              </a>
            </p>
          )}
        </div>

        <div className='flex-1 overflow-y-auto px-6 py-4'>
          {q.isLoading ? (
            <p className='text-[12px] text-slate-400'>Loading…</p>
          ) : q.isError ? (
            <p className='text-[12.5px] text-rose-600 dark:text-rose-400'>
              {errText(q.error, 'Could not load this check')}
            </p>
          ) : result?.status === 'error' ? (
            <pre className='whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[11.5px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-300'>
              {result.error ?? 'The check failed without a message'}
            </pre>
          ) : rows.length === 0 ? (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Every compared row matches.
            </p>
          ) : (
            <>
              {clusters.length > 0 && (
                <div className='mb-4'>
                  <h3 className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
                    Where the differences cluster
                  </h3>
                  <ul className='mt-1.5 space-y-1'>
                    {clusters.map((c, i) => {
                      const active = !!cluster && clusterText(cluster) === clusterText(c.cluster)
                      const id = `cluster:${i}`
                      return (
                        <li key={clusterText(c.cluster)}>
                          <div className='flex items-center gap-2'>
                            <button
                              type='button'
                              data-quality-cluster={clusterText(c.cluster)}
                              aria-pressed={active}
                              onClick={() => setCluster(active ? null : c.cluster)}
                              className={cn(
                                'flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[12px]',
                                active
                                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted/40'
                              )}
                            >
                              <span className='min-w-0 flex-1 truncate'>
                                {clusterText(c.cluster)}
                              </span>
                              {c.red > 0 && (
                                <span className={cn('tabular-nums', STATUS_TEXT.red)}>
                                  {fmt(c.red)} red
                                </span>
                              )}
                              {c.amber > 0 && (
                                <span className={cn('tabular-nums', STATUS_TEXT.amber)}>
                                  {fmt(c.amber)} amber
                                </span>
                              )}
                            </button>
                            {c.red > 0 && (
                              <Button
                                size='sm'
                                variant='ghost'
                                data-quality-mark='cluster'
                                onClick={() => setMarking(marking === id ? null : id)}
                              >
                                Mark as expected
                              </Button>
                            )}
                          </div>
                          {marking === id && (
                            <div className='mt-1.5'>
                              <MarkExpectedForm
                                runId={runId}
                                checkId={checkId}
                                match={{ cluster: c.cluster }}
                                subject={`every row in ${clusterText(c.cluster)}`}
                                onDone={() => setMarking(null)}
                              />
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className='mb-2 flex flex-wrap items-center gap-1.5'>
                {(
                  [
                    ['all', `All ${fmt(rows.length)}`],
                    ['red', `Red ${fmt(counts.red)}`],
                    ['amber', `Amber ${fmt(counts.amber)}`]
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type='button'
                    aria-pressed={tone === k}
                    data-quality-filter={k}
                    onClick={() => setTone(k)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium',
                      tone === k
                        ? 'border-[#1e293b] bg-[#1e293b] text-[#fff] dark:border-[#e2e8f0] dark:bg-[#e2e8f0] dark:text-[#0f172a]'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted/40'
                    )}
                  >
                    {label}
                  </button>
                ))}
                {cluster && (
                  <button
                    type='button'
                    onClick={() => setCluster(null)}
                    className='ml-1 text-[11.5px] text-slate-500 underline-offset-2 hover:underline dark:text-muted-foreground'
                  >
                    Clear cluster: {clusterText(cluster)}
                  </button>
                )}
                {truncated && (
                  <span className='ml-auto text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    Showing the first {fmt(rows.length)} of {fmt(truncated)} — the CSV has them all
                  </span>
                )}
              </div>

              <MismatchTable
                rows={shown}
                runId={runId}
                checkId={checkId}
                known={q.data?.known ?? []}
                marking={marking}
                setMarking={setMarking}
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SideValues({
  values,
  fields,
  missing
}: {
  values: Record<string, Value> | null
  fields: string[]
  missing: string
}) {
  if (!values)
    return <span className='italic text-slate-400 dark:text-muted-foreground'>{missing}</span>
  const names = fields.length ? fields : Object.keys(values)
  return (
    <dl className='space-y-0.5'>
      {names.map((f) => (
        <div key={f} className='flex gap-1.5'>
          <dt className='shrink-0 text-slate-400 dark:text-muted-foreground'>{f}</dt>
          <dd className='min-w-0 break-words font-mono text-[11.5px] text-slate-800 dark:text-slate-200'>
            {showValue(values[f])}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function MismatchTable({
  rows,
  runId,
  checkId,
  known,
  marking,
  setMarking
}: {
  rows: DiffRow[]
  runId: string
  checkId: string
  known: Known[]
  marking: string | null
  setMarking: (v: string | null) => void
}) {
  if (rows.length === 0)
    return (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        No rows match this filter.
      </p>
    )
  const knownById = new Map(known.map((k) => [k.id, k]))
  return (
    <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
      <table className='w-full text-[12px]'>
        <thead className='bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'>
          <tr>
            <th className='px-3 py-2 font-medium'>Record</th>
            <th className='px-3 py-2 font-medium'>Production</th>
            <th className='px-3 py-2 font-medium'>Staging</th>
            <th className='px-3 py-2 font-medium'>Why</th>
            <th className='px-3 py-2' />
          </tr>
        </thead>
        <tbody className='divide-y divide-slate-100 bg-white dark:divide-border dark:bg-card'>
          {rows.map((r) => {
            const t = rowTone(r)
            const id = `row:${r.key}`
            const legacy = safeHttp(r.legacy)
            const k = r.known_id ? knownById.get(r.known_id) : undefined
            return (
              <MismatchRow
                key={r.key}
                colSpan={5}
                form={
                  marking === id ? (
                    <MarkExpectedForm
                      runId={runId}
                      checkId={checkId}
                      match={{ key_exact: r.key }}
                      subject={r.label ?? r.key}
                      onDone={() => setMarking(null)}
                    />
                  ) : null
                }
              >
                <tr data-quality-row={r.key} data-quality-status={t} className='align-top'>
                  <td className='px-3 py-2'>
                    <div className='flex items-start gap-2'>
                      <StatusDot status={t} className='mt-1' />
                      <div className='min-w-0'>
                        <div className='font-medium text-slate-900 dark:text-foreground'>
                          {r.label ?? r.key}
                        </div>
                        {r.label && (
                          <div className='font-mono text-[11px] text-slate-400 dark:text-muted-foreground'>
                            {r.key}
                          </div>
                        )}
                        {legacy && (
                          <a
                            href={legacy}
                            target='_blank'
                            rel='noreferrer'
                            data-quality-legacy
                            className='mt-0.5 inline-flex items-center gap-1 text-[11px] text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
                          >
                            Open in legacy <ExternalLink className='h-3 w-3' />
                          </a>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className='px-3 py-2'>
                    <SideValues values={r.base} fields={r.fields} missing='Not in production' />
                  </td>
                  <td className='px-3 py-2'>
                    <SideValues values={r.cur} fields={r.fields} missing='Not in staging' />
                  </td>
                  <td className='max-w-[260px] px-3 py-2 text-slate-600 dark:text-slate-300'>
                    {r.reason ?? '—'}
                    {k && (
                      <div
                        className={cn('mt-0.5 text-[11px]', STATUS_TEXT.amber)}
                        data-quality-known-ref={k.id}
                      >
                        Known: {k.reason}
                      </div>
                    )}
                  </td>
                  <td className='px-3 py-2 text-right'>
                    {t === 'red' && (
                      <Button
                        size='sm'
                        variant='ghost'
                        className='whitespace-nowrap'
                        data-quality-mark='row'
                        onClick={() => setMarking(marking === id ? null : id)}
                      >
                        Mark as expected
                      </Button>
                    )}
                  </td>
                </tr>
              </MismatchRow>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MismatchRow({
  children,
  form,
  colSpan
}: {
  children: ReactNode
  form: ReactNode
  colSpan: number
}) {
  return (
    <>
      {children}
      {form && (
        <tr>
          <td colSpan={colSpan} className='px-3 pb-3'>
            {form}
          </td>
        </tr>
      )}
    </>
  )
}

function KnownTab({ results, runs }: { results: ResultSummary[]; runs: QualityRun[] }) {
  const q = useQuery({
    queryKey: ['quality-known'],
    queryFn: () => api.get<{ data: Known[] }>('/quality-checks/known').then((r) => r.data.data)
  })
  const known = q.data ?? []
  const creators = [...new Set(known.map((k) => k.created_by).filter((x): x is string => !!x))]
  const users = useQueries({
    queries: creators.map((id) => ({
      queryKey: ['user-name', id],
      staleTime: 600_000,
      queryFn: () =>
        api
          .get<{ data: { first_name?: string | null; last_name?: string | null; email?: string } }>(
            `/users/${id}`
          )
          .then((r) => r.data.data)
          .catch(() => null)
    }))
  })
  const nameOf = (id: string | null) => {
    if (!id) return 'Unknown'
    const u = users[creators.indexOf(id)]?.data
    const n = [u?.first_name, u?.last_name].filter(Boolean).join(' ')
    return n || u?.email || 'Unknown'
  }
  const labelOf = (checkId: string) => results.find((r) => r.check_id === checkId)?.label ?? checkId
  const runDate = (id: string | null) => {
    if (!id) return null
    const r = runs.find((x) => x.id.toLowerCase() === id.toLowerCase())
    return r ? formatDateTime(r.started_at) : 'an older run'
  }

  if (q.isLoading) return <p className='text-[12px] text-slate-400'>Loading…</p>
  if (q.isError)
    return (
      <p className='text-[12.5px] text-rose-600 dark:text-rose-400'>
        {errText(q.error, 'Could not load known differences')}
      </p>
    )
  if (known.length === 0)
    return (
      <div className='rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-border dark:bg-card'>
        <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
          No known differences
        </p>
        <p className='mx-auto mt-1 max-w-[56ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Open a red check and use Mark as expected on a row or a cluster. The reason you give is
          kept here and the matching rows read amber from then on.
        </p>
      </div>
    )
  return (
    <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <table className='w-full text-[12px]'>
        <thead className='bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'>
          <tr>
            <th className='px-3 py-2 font-medium'>Check</th>
            <th className='px-3 py-2 font-medium'>Applies to</th>
            <th className='px-3 py-2 font-medium'>Reason</th>
            <th className='px-3 py-2 font-medium'>Added</th>
            <th className='px-3 py-2 font-medium'>Coverage</th>
            <th className='px-3 py-2' />
          </tr>
        </thead>
        <tbody className='divide-y divide-slate-100 dark:divide-border'>
          {known.map((k) => (
            <KnownRow
              key={k.id}
              k={k}
              checkLabel={labelOf(k.check_id)}
              creator={nameOf(k.created_by)}
              lastRun={runDate(k.last_matched_run)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function KnownRow({
  k,
  checkLabel,
  creator,
  lastRun
}: {
  k: Known
  checkLabel: string
  creator: string
  lastRun: string | null
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState(k.reason)
  const [confirming, setConfirming] = useState(false)
  const done = (d: { rediffed: boolean }, what: string) => {
    if (d.rediffed) toast.success(`${what} — the latest run was re-checked`)
    else toast.info(`${what}. It applies from the next run.`)
    for (const key of ['quality-run', 'quality-check', 'quality-known', 'quality-runs'])
      void qc.invalidateQueries({ queryKey: [key] })
  }
  const save = useMutation({
    mutationFn: () =>
      api
        .patch<{ data: { id: number; rediffed: boolean } }>(`/quality-checks/known/${k.id}`, {
          reason: reason.trim()
        })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      setEditing(false)
      done(d, 'Reason saved')
    },
    onError: (e) => toast.error(errText(e, 'Could not save the reason'))
  })
  const remove = useMutation({
    mutationFn: () =>
      api
        .delete<{ data: { id: number; rediffed: boolean } }>(`/quality-checks/known/${k.id}`)
        .then((r) => r.data.data),
    onSuccess: (d) => done(d, 'Known difference removed'),
    onError: (e) => {
      setConfirming(false)
      toast.error(errText(e, 'Could not remove it'))
    }
  })
  return (
    <tr data-quality-known={k.id} className='align-top'>
      <td className='px-3 py-2'>
        <div className='font-medium text-slate-900 dark:text-foreground'>{checkLabel}</div>
        <div className='font-mono text-[11px] text-slate-400 dark:text-muted-foreground'>
          {k.check_id}
        </div>
      </td>
      <td className='max-w-[220px] break-words px-3 py-2 font-mono text-[11.5px] text-slate-700 dark:text-slate-300'>
        {matchSummary(k.match)}
      </td>
      <td className='min-w-[240px] px-3 py-2 text-slate-700 dark:text-slate-200'>
        {editing ? (
          <div>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              rows={2}
              data-quality-known-reason
              className='w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[12.5px] text-slate-900 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-foreground'
            />
            <div className='mt-1 flex gap-1.5'>
              <Button
                size='sm'
                disabled={reason.trim().length < 3 || save.isPending}
                onClick={() => save.mutate()}
              >
                Save
              </Button>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => {
                  setReason(k.reason)
                  setEditing(false)
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          k.reason
        )}
      </td>
      <td className='whitespace-nowrap px-3 py-2 text-slate-500 dark:text-muted-foreground'>
        <div>{creator}</div>
        <div className='text-[11px]'>{k.created_at ? formatRelative(k.created_at) : '—'}</div>
      </td>
      <td className='px-3 py-2 text-slate-500 dark:text-muted-foreground'>
        {k.stale && (
          <span
            data-quality-stale
            className='mb-1 inline-block rounded border border-amber-300 bg-amber-50 px-1.5 py-px text-[10.5px] font-medium uppercase tracking-wide text-amber-800 dark:border-amber-500/40 dark:bg-amber-400/10 dark:text-amber-200'
            data-tip={`Matched nothing for ${k.idle_runs} runs in a row — the difference may be gone`}
          >
            Stale
          </span>
        )}
        <div>
          {fmt(k.matched_count)} {k.matched_count === 1 ? 'row' : 'rows'} matched in all
        </div>
        <div className='text-[11px]'>{lastRun ? `last on ${lastRun}` : 'not matched yet'}</div>
      </td>
      <td className='whitespace-nowrap px-3 py-2 text-right'>
        {confirming ? (
          <span className='inline-flex items-center gap-1.5'>
            <span className='text-[11.5px] text-slate-600 dark:text-slate-300'>Remove?</span>
            <Button
              size='sm'
              variant='destructive'
              disabled={remove.isPending}
              data-quality-known-confirm
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
            <Button size='sm' variant='ghost' onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <span className='inline-flex gap-1'>
            {!editing && (
              <Button size='sm' variant='ghost' onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Button
              size='sm'
              variant='ghost'
              data-quality-known-delete
              onClick={() => setConfirming(true)}
            >
              Delete
            </Button>
          </span>
        )}
      </td>
    </tr>
  )
}
