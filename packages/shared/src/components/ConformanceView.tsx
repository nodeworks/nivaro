import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useItemNavigation, useNavigation, useNivaroClient } from '../context'
import { get, post, put } from '../lib/commands'
import { cn } from '../lib/utils'
import { PickList } from './imports/ServiceConfigBuilder'
import { TipLayer } from './TipLayer'

/**
 * Config conformance — which items would FAIL their own form today.
 *
 * Embeddable (admin hosts it at /data-integrity; any headless frontend can
 * mount it inside a NivaroProvider + NavigationContext). The server compiles
 * each collection's field config (required, validation rules, cascade
 * availability) into checks and sweeps real rows; this view picks a
 * collection, fires a run, polls it, and renders the findings with links
 * into the offending records.
 */

interface CheckableCollection {
  collection: string
  display_name: string | null
  required: number
  validation: number
  cascade: number
  skipped: number
}

interface Run {
  id: number
  collection: string
  status: 'running' | 'completed' | 'error'
  checked_records: number
  violation_count: number
  truncated: boolean
  error: string | null
  started_at: string | null
  finished_at: string | null
  triggered_by_name?: string | null
}

function relTime(iso: string | null): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.round(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(iso).toLocaleDateString()
}

function runDuration(r: Run): string {
  if (!r.started_at || !r.finished_at) return ''
  const s = Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

interface Finding {
  id: number
  item_id: string
  item_label: string | null
  field: string
  rule: string
  message: string | null
}

const RULE_META: Record<string, { label: string; cls: string }> = {
  required: {
    label: 'Required empty',
    cls: 'bg-red-500/10 text-red-700 dark:text-red-400'
  },
  validation: {
    label: 'Validation',
    cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
  },
  cascade: {
    label: 'Not an available option',
    cls: 'bg-purple-500/10 text-purple-700 dark:text-purple-400'
  },
  display: {
    label: 'Broken display label',
    cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
  }
}

export function ConformanceView({ className }: { className?: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const nav = useItemNavigation()
  const navCtx = useNavigation()
  const [collection, setCollection] = useState<string>('')
  const [activeRunId, setActiveRunId] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [sampleSize, setSampleSize] = useState('5000')

  const { data: collections = [], isLoading: loadingCollections } = useQuery<
    CheckableCollection[]
  >({
    queryKey: ['conformance-collections'],
    queryFn: () =>
      client
        .request<{ data: CheckableCollection[] }>(get('/config-conformance/collections'))
        .then((r) => r.data ?? []),
    staleTime: 5 * 60_000
  })

  const { data: runs = [], isFetched: runsFetched } = useQuery<Run[]>({
    queryKey: ['conformance-runs', collection],
    queryFn: () =>
      client
        .request<{ data: Run[] }>(
          get(`/config-conformance/runs${collection ? `?collection=${collection}` : ''}`)
        )
        .then((r) => r.data ?? []),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 3_000 : false)
  })

  // A just-started run isn't in the list until the next poll — fall back to
  // the newest known run instead of flashing the empty-state overview.
  const shownRun = (activeRunId != null ? runs.find((r) => r.id === activeRunId) : undefined) ?? runs[0]
  const selected = collections.find((c) => c.collection === collection)

  const startRun = async () => {
    if (!collection) return
    setStarting(true)
    setStartError(null)
    try {
      const res = await client.request<{ data: { id: number } }>(
        post(`/config-conformance/${collection}/run`, {
          limit: sampleSize === '0' ? 0 : Number(sampleSize) || 5000
        })
      )
      setActiveRunId(res.data.id)
      void qc.invalidateQueries({ queryKey: ['conformance-runs'] })
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start the run')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-4 p-6', className)} data-conformance>
      <TipLayer />
      <div className='flex flex-wrap items-end gap-3'>
        <div className='w-[300px]'>
          <p className='mb-1 text-[11.5px] font-medium text-slate-700 dark:text-foreground'>
            Collection
          </p>
          <PickList
            value={collection}
            onChange={(v) => {
              setCollection(v)
              setActiveRunId(null)
            }}
            options={collections.map((c) => ({
              value: c.collection,
              label: c.display_name || c.collection
            }))}
            placeholder={loadingCollections ? 'Loading…' : 'Choose a collection…'}
            className='h-8'
          />
        </div>
        {selected && (
          <p className='pb-1.5 text-[11.5px] text-slate-400'>
            {selected.required} required · {selected.validation} validation ·{' '}
            {selected.cascade} cascade check{selected.cascade === 1 ? '' : 's'}
            {selected.skipped > 0 && ` · ${selected.skipped} not evaluable`}
          </p>
        )}
        <div className='w-[170px]'>
          <p className='mb-1 text-[11.5px] font-medium text-slate-700 dark:text-foreground'>
            Sample size
          </p>
          <PickList
            value={sampleSize}
            onChange={setSampleSize}
            options={[
              { value: '1000', label: '1,000 newest' },
              { value: '5000', label: '5,000 newest' },
              { value: '10000', label: '10,000 newest' },
              { value: '25000', label: '25,000 newest' },
              { value: '50000', label: '50,000 newest' },
              { value: '0', label: 'All records' }
            ]}
            placeholder='5,000 newest'
            className='h-8'
          />
        </div>
        <button
          type='button'
          disabled={!collection || starting || runs.some((r) => r.status === 'running')}
          onClick={() => void startRun()}
          className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white disabled:opacity-50'
        >
          {starting ? 'Starting…' : 'Run checks'}
        </button>
        {collection && <ScheduleToggle collection={collection} />}
        {runs.filter((r) => r.status === 'completed').length >= 2 && (
          <TrendSpark runs={runs} />
        )}
        {startError && (
          <p className='pb-1.5 text-[12px] text-red-600 dark:text-red-400'>{startError}</p>
        )}
      </div>

      {runs.length > 0 && (
        <RunHistory runs={runs} activeId={shownRun?.id ?? null} onSelect={setActiveRunId} />
      )}

      {shownRun && (
        <RunDetail
          run={shownRun}
          onOpenItem={(id, focus) => {
            if (focus) {
              const url = nav.urlFor({ collection: shownRun.collection, itemId: id })
              navCtx.navigate(`${url}${url.includes('?') ? '&' : '?'}focus=${encodeURIComponent(focus)}`)
            } else {
              nav.open({ collection: shownRun.collection, itemId: id })
            }
          }}
        />
      )}

      {/* The intro renders only once the runs query has SETTLED empty —
          while a collection switch is fetching, nothing flashes. */}
      {!shownRun && !loadingCollections && runsFetched && (
        <div className='max-w-[560px] rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
          <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
            Which records would fail their own form?
          </p>
          <p className='mt-1.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
            Field rules accumulate while data drifts underneath them — imports, integrations, and
            parent-link changes leave records whose values a person could never save today
            (&ldquo;this value is not an available option&rdquo;). Pick a collection and run its
            checks: required fields, validation rules, and cascade availability, evaluated against
            the newest records.
          </p>
        </div>
      )}
    </div>
  )
}

/** Nightly sweep toggle for the selected collection — the cron picks up
 *  active schedules; a regression since the previous run notifies whoever
 *  enabled it. Hidden for non-admins (the schedules routes are admin-only). */
function ScheduleToggle({ collection }: { collection: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: schedules, isError } = useQuery<Array<{ collection: string; is_active: boolean }>>({
    queryKey: ['conformance-schedules'],
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string; is_active: boolean }> }>(
          get('/config-conformance/schedules')
        )
        .then((r) => r.data ?? []),
    retry: false,
    staleTime: 60_000
  })
  if (isError || !schedules) return null
  const active = schedules.some((sc) => sc.collection === collection && sc.is_active)
  return (
    <label className='flex cursor-pointer items-center gap-1.5 pb-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
      <button
        type='button'
        role='switch'
        aria-checked={active}
        onClick={() =>
          void client
            .request(
              put(`/config-conformance/schedules/${collection}`, { is_active: !active })
            )
            .then(() => qc.invalidateQueries({ queryKey: ['conformance-schedules'] }))
        }
        className={cn(
          'relative h-4 w-7 rounded-full transition-colors',
          active ? 'bg-nvr-cyan' : 'bg-slate-300 dark:bg-border'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
            active ? 'translate-x-3.5' : 'translate-x-0.5'
          )}
        />
      </button>
      Nightly sweep
    </label>
  )
}

/** Issue count over the completed runs, oldest → newest — is the backlog
 *  shrinking? */
function TrendSpark({ runs }: { runs: Run[] }) {
  const pts = runs
    .filter((r) => r.status === 'completed')
    .slice(0, 12)
    .reverse()
  if (pts.length < 2) return null
  const max = Math.max(...pts.map((p) => p.violation_count), 1)
  const w = 90
  const h = 22
  const line = pts
    .map(
      (p, i) =>
        `${(i / (pts.length - 1)) * (w - 4) + 2},${h - 3 - (p.violation_count / max) * (h - 6)}`
    )
    .join(' ')
  const improving = pts[pts.length - 1].violation_count <= pts[0].violation_count
  return (
    <span
      className='flex items-end gap-1.5 pb-1'
      data-tip={`${pts[0].violation_count.toLocaleString()} → ${pts[pts.length - 1].violation_count.toLocaleString()} issues across the last ${pts.length} runs`}
    >
      <svg width={w} height={h} className='overflow-visible'>
        <polyline
          points={line}
          fill='none'
          strokeWidth='1.5'
          className={improving ? 'stroke-emerald-500' : 'stroke-amber-500'}
        />
      </svg>
    </span>
  )
}

/** Run history as a dense, scannable table — collection, outcome, size, who
 *  and when — instead of an ever-growing pill strip. Collapsed to the recent
 *  few; the selected run row is tinted. */
function RunHistory({
  runs,
  activeId,
  onSelect
}: {
  runs: Run[]
  activeId: number | null
  onSelect: (id: number) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? runs : runs.slice(0, 5)
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <table className='w-full border-collapse text-[12px] tabular-nums'>
        <thead>
          <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border'>
            <th className='px-3 py-1.5 font-medium'>Run</th>
            <th className='px-2 py-1.5 font-medium'>Collection</th>
            <th className='px-2 py-1.5 font-medium'>Result</th>
            <th className='px-2 py-1.5 text-right font-medium'>Checked</th>
            <th className='px-2 py-1.5 text-right font-medium'>Duration</th>
            <th className='px-2 py-1.5 font-medium'>Started</th>
            <th className='px-3 py-1.5 font-medium'>By</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr
              key={r.id}
              onClick={() => onSelect(r.id)}
              className={cn(
                'cursor-pointer border-b border-slate-50 transition-colors last:border-0 dark:border-border/50',
                activeId === r.id
                  ? 'bg-nvr-cyan/[0.06] dark:bg-nvr-cyan/10'
                  : 'hover:bg-slate-50 dark:hover:bg-background/40'
              )}
            >
              <td className='px-3 py-1.5 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                #{r.id}
              </td>
              <td className='px-2 py-1.5 text-slate-700 dark:text-foreground'>{r.collection}</td>
              <td className='px-2 py-1.5'>
                {r.status === 'running' ? (
                  <span className='flex items-center gap-1.5 text-nvr-cyan-dark dark:text-nvr-cyan'>
                    <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-nvr-cyan' />
                    running
                  </span>
                ) : r.status === 'error' ? (
                  <span className='text-red-600 dark:text-red-400' data-tip={r.error ?? undefined}>
                    error
                  </span>
                ) : r.violation_count === 0 ? (
                  <span className='text-emerald-600 dark:text-emerald-400'>clean</span>
                ) : (
                  <span className='text-slate-700 dark:text-foreground'>
                    {r.violation_count.toLocaleString()} issue{r.violation_count === 1 ? '' : 's'}
                  </span>
                )}
              </td>
              <td className='px-2 py-1.5 text-right text-slate-500 dark:text-muted-foreground'>
                {r.checked_records.toLocaleString()}
              </td>
              <td className='px-2 py-1.5 text-right text-slate-500 dark:text-muted-foreground'>
                {runDuration(r)}
              </td>
              <td
                className='px-2 py-1.5 text-slate-500 dark:text-muted-foreground'
                data-tip={r.started_at ? new Date(r.started_at).toLocaleString() : undefined}
              >
                {relTime(r.started_at)}
              </td>
              <td className='px-3 py-1.5 text-slate-500 dark:text-muted-foreground'>
                {r.triggered_by_name ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.length > 5 && (
        <button
          type='button'
          onClick={() => setShowAll((v) => !v)}
          className='w-full border-t border-slate-100 py-1.5 text-[11px] text-slate-400 transition-colors hover:text-slate-600 dark:border-border dark:hover:text-muted-foreground'
        >
          {showAll ? 'Show fewer' : `Show all ${runs.length} runs`}
        </button>
      )}
    </div>
  )
}

interface FindingGroup {
  item_id: string
  item_label: string | null
  count: number
  findings: Finding[]
}

function RunDetail({
  run,
  onOpenItem
}: {
  run: Run
  onOpenItem: (id: string, focus?: string) => void
}) {
  const client = useNivaroClient()
  const [page, setPage] = useState(1)
  const [rule, setRule] = useState('')
  const [field, setField] = useState('')
  const [grouped, setGrouped] = useState(false)

  const { data } = useQuery<{
    findings: Array<Finding | FindingGroup>
    total: number
    by_rule: Array<{ rule: string; c: number }>
    by_field: Array<{ field: string; c: number }>
  }>({
    queryKey: ['conformance-run', run.id, page, rule, field, grouped],
    queryFn: () =>
      client
        .request<{
          data: {
            findings: Array<Finding | FindingGroup>
            total: number
            by_rule: Array<{ rule: string; c: number }>
            by_field: Array<{ field: string; c: number }>
          }
        }>(
          get(
            `/config-conformance/runs/${run.id}?page=${page}&limit=50${rule ? `&rule=${rule}` : ''}${field ? `&field=${field}` : ''}${grouped ? '&group=record' : ''}`
          )
        )
        .then((r) => r.data),
    refetchInterval: run.status === 'running' ? 3_000 : false
  })

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 50))
  const chips = useMemo(
    () => ({
      rules: data?.by_rule ?? [],
      fields: (data?.by_field ?? []).slice(0, 12)
    }),
    [data]
  )

  return (
    <div className='flex min-h-0 flex-1 flex-col rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-border'>
        <span className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          Run #{run.id}
        </span>
        {run.status === 'running' && (
          <span className='flex items-center gap-1.5 text-[11.5px] text-nvr-cyan-dark dark:text-nvr-cyan'>
            <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-nvr-cyan' />
            running — {run.checked_records.toLocaleString()} checked so far
          </span>
        )}
        {run.status === 'completed' && (
          <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {run.checked_records.toLocaleString()} record{run.checked_records === 1 ? '' : 's'}{' '}
            checked · {run.violation_count.toLocaleString()} issue
            {run.violation_count === 1 ? '' : 's'}
            {run.truncated && ' · sample truncated — newest records first'}
          </span>
        )}
        {run.status === 'error' && (
          <span className='text-[11.5px] text-red-600 dark:text-red-400'>{run.error}</span>
        )}
        <span className='flex-1' />
        <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
          {([
            { value: false, label: 'All issues' },
            { value: true, label: 'By record' }
          ] as const).map((opt) => (
            <button
              key={opt.label}
              type='button'
              onClick={() => {
                setGrouped(opt.value)
                setPage(1)
              }}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                grouped === opt.value
                  ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-muted-foreground'
              )}
            >
              {opt.label}
            </button>
          ))}
        </span>
        {chips.rules.map((r) => (
          <button
            key={r.rule}
            type='button'
            onClick={() => {
              setRule((v) => (v === r.rule ? '' : r.rule))
              setPage(1)
            }}
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium transition-opacity',
              RULE_META[r.rule]?.cls ?? 'bg-slate-500/10 text-slate-600',
              rule && rule !== r.rule && 'opacity-40'
            )}
          >
            {RULE_META[r.rule]?.label ?? r.rule} {Number(r.c).toLocaleString()}
          </button>
        ))}
      </div>

      {chips.fields.length > 1 && (
        <div className='flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2 dark:border-border'>
          {chips.fields.map((f) => (
            <button
              key={f.field}
              type='button'
              onClick={() => {
                setField((v) => (v === f.field ? '' : f.field))
                setPage(1)
              }}
              className={cn(
                'rounded border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors',
                field === f.field
                  ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                  : 'border-slate-200 text-slate-500 dark:border-border dark:text-muted-foreground'
              )}
            >
              {f.field} · {Number(f.c).toLocaleString()}
            </button>
          ))}
        </div>
      )}

      {rule && field && ['cascade', 'validation', 'display'].includes(rule) && (
        <RemediateBar run={run} rule={rule} field={field} total={data?.total ?? 0} />
      )}

      <div className='min-h-0 flex-1 overflow-y-auto'>
        {/* Only a SETTLED empty answer earns the green all-clear — while the
            findings are loading (fresh run, run switch) nothing shows. */}
        {data !== undefined && (data?.findings ?? []).length === 0 && run.status === 'completed' && (
          <p className='px-4 py-6 text-[12.5px] text-emerald-600 dark:text-emerald-400'>
            {rule || field
              ? 'No findings match the filters.'
              : 'Every checked record satisfies its field configuration.'}
          </p>
        )}
        {grouped ? (
          <div>
            {((data?.findings ?? []) as FindingGroup[]).map((g) => (
              <div
                key={g.item_id}
                className='border-b border-slate-100 px-4 py-2 dark:border-border/60'
              >
                <div className='flex items-center gap-2.5'>
                  <button
                    type='button'
                    onClick={() => onOpenItem(g.item_id)}
                    className='text-[12.5px] font-medium text-nvr-cyan underline decoration-dotted underline-offset-2'
                  >
                    {g.item_label || `#${g.item_id}`}
                  </button>
                  <span className='rounded-full bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600 dark:bg-background dark:text-muted-foreground'>
                    {g.count} issue{g.count === 1 ? '' : 's'}
                  </span>
                </div>
                <div className='mt-1 space-y-0.5'>
                  {g.findings.map((f) => (
                    <div key={f.id} className='flex items-baseline gap-2 text-[12px]'>
                      <button
                        type='button'
                        onClick={() => onOpenItem(g.item_id, f.field)}
                        data-tip='Open the record at this field'
                        className='w-[150px] shrink-0 text-left font-mono text-[11px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-nvr-cyan dark:text-muted-foreground'
                      >
                        {f.field}
                      </button>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                          RULE_META[f.rule]?.cls ?? 'bg-slate-500/10 text-slate-600'
                        )}
                      >
                        {RULE_META[f.rule]?.label ?? f.rule}
                      </span>
                      <span className='min-w-0 text-slate-600 dark:text-muted-foreground'>
                        {f.message}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
        <table className='w-full border-collapse text-[12px] tabular-nums'>
          <tbody>
            {((data?.findings ?? []) as Finding[]).map((f) => (
              <tr
                key={f.id}
                className='border-b border-slate-50 transition-colors hover:bg-slate-50 dark:border-border/50 dark:hover:bg-background/40'
              >
                <td className='w-[190px] px-4 py-1.5'>
                  <button
                    type='button'
                    onClick={() => onOpenItem(f.item_id)}
                    className='text-left text-nvr-cyan underline decoration-dotted underline-offset-2'
                  >
                    {f.item_label || `#${f.item_id}`}
                  </button>
                </td>
                <td className='w-[160px] px-2 py-1.5'>
                  <button
                    type='button'
                    onClick={() => onOpenItem(f.item_id, f.field)}
                    data-tip='Open the record at this field'
                    className='font-mono text-[11px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-nvr-cyan dark:text-muted-foreground'
                  >
                    {f.field}
                  </button>
                </td>
                <td className='w-[150px] px-2 py-1.5'>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                      RULE_META[f.rule]?.cls ?? 'bg-slate-500/10 text-slate-600'
                    )}
                  >
                    {RULE_META[f.rule]?.label ?? f.rule}
                  </span>
                </td>
                <td className='px-2 py-1.5 text-slate-600 dark:text-muted-foreground'>
                  {f.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>

      {pages > 1 && (
        <div className='flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[11.5px] text-slate-500 dark:border-border dark:text-muted-foreground'>
          <button
            type='button'
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className='disabled:opacity-40'
          >
            ← Previous
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button
            type='button'
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            className='disabled:opacity-40'
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

/** Bulk remediation for a filtered finding set: clears the offending field on
 *  every affected record THROUGH the items service (RBAC, hooks, revisions —
 *  each clear is an audited write). Two-step confirm; irreversible only in
 *  the sense that the old values move into revision history. */
function RemediateBar({
  run,
  rule,
  field,
  total
}: {
  run: Run
  rule: string
  field: string
  total: number
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  if (total === 0 && !result) return null
  return (
    <div className='flex flex-wrap items-center gap-2.5 border-b border-slate-100 bg-slate-50/60 px-4 py-2 dark:border-border dark:bg-background/40'>
      <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Bulk fix: clear <span className='font-mono'>{field}</span> on the affected records — each
        write is revisioned and attributed to you.
      </span>
      {result ? (
        <span className='text-[11.5px] font-medium text-emerald-600 dark:text-emerald-400'>
          {result}
        </span>
      ) : confirming ? (
        <span className='flex items-center gap-2'>
          <button
            type='button'
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void client
                .request<{ data: { cleared: number; failed: number } }>(
                  post(`/config-conformance/runs/${run.id}/remediate`, {
                    action: 'clear',
                    field,
                    rule
                  })
                )
                .then((r) => {
                  setResult(
                    `Cleared on ${r.data.cleared} record(s)${r.data.failed ? ` — ${r.data.failed} failed` : ''}. Re-run the checks to confirm.`
                  )
                  void qc.invalidateQueries({ queryKey: ['conformance-run', run.id] })
                })
                .catch((err: Error) => setResult(err.message))
                .finally(() => setBusy(false))
            }}
            className='h-6 rounded-md bg-red-600 px-2.5 text-[11.5px] font-medium text-white disabled:opacity-50'
          >
            {busy ? 'Clearing…' : `Yes, clear ${total.toLocaleString()} value(s)`}
          </button>
          <button
            type='button'
            onClick={() => setConfirming(false)}
            className='text-[11.5px] text-slate-400 hover:text-slate-600'
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type='button'
          onClick={() => setConfirming(true)}
          className='h-6 rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-600 hover:border-red-300 hover:text-red-600 dark:border-border dark:text-muted-foreground'
        >
          Clear values…
        </button>
      )}
    </div>
  )
}

